// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');
const CRYPTO = require('node:crypto');

const {
  CommonUtils,
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
  },
  IotStatus,
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');

const IOT_TYPE = 'detect-highlight';

const REQUIRED_ENVS = [
  'ENV_BEDROCK_REGION',
  'ENV_PROXY_BUCKET',
  'ENV_HIGHLIGHT_SETS_TABLE',
];

const DEFAULT_TRANSCRIPT_MODEL = 'us.amazon.nova-2-lite-v1:0';
const DEFAULT_VLM_MODEL = 'us.amazon.nova-2-lite-v1:0';
const DEFAULT_MAX_SEGMENTS = 10;
const DEFAULT_AUTOPICK_THRESHOLD = 0.6; // words/sec
const ANCHOR_SIM_THRESHOLD = 0.70;      // matches Python reference
const MIN_HIGHLIGHT_SEC = 5;
const MAX_HIGHLIGHT_SEC = 60;
const FPS = 25;
const VIDEO_FORMAT_BY_EXT = {
  mp4: 'mp4',
  mov: 'mov',
  mkv: 'mkv',
  webm: 'webm',
  flv: 'flv',
  mpeg: 'mpeg',
  mpg: 'mpeg',
  wmv: 'wmv',
  '3gp': 'three_gp',
};

// Bedrock rejects on-demand for some Nova models — auto-prefix the inference profile.
function ensureInferenceProfile(modelId) {
  if (!modelId) return modelId;
  if (modelId.startsWith('us.') || modelId.startsWith('eu.') || modelId.startsWith('apac.')) {
    return modelId;
  }
  if (/^amazon\.nova/.test(modelId) || /^anthropic\.claude/.test(modelId)) {
    return `us.${modelId}`;
  }
  return modelId;
}

function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return 0;
  }
  let prev = new Array(m + 1).fill(0);
  let curr = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(curr[j - 1], prev[j]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[m];
}

// Approximates difflib.SequenceMatcher.ratio() on word-tokens.
function stringSimilarity(s1, s2) {
  const w1 = s1.toLowerCase().split(/\s+/).filter(Boolean);
  const w2 = s2.toLowerCase().split(/\s+/).filter(Boolean);
  if (w1.length === 0 && w2.length === 0) {
    return 1;
  }
  if (w1.length === 0 || w2.length === 0) {
    return 0;
  }
  const lcs = lcsLength(w1, w2);
  return (2.0 * lcs) / (w1.length + w2.length);
}

function secondsToTimecode(seconds, fps = FPS) {
  const totalFrames = Math.round(seconds * fps);
  const ff = totalFrames % fps;
  let s = Math.floor(totalFrames / fps);
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  return [hh, mm, ss, ff]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function flattenItems(items) {
  // Transcribe items[] → { word, startTime, endTime } (skip punctuation w/o times).
  return (items || [])
    .filter((it) => it.start_time !== undefined && it.end_time !== undefined)
    .map((it) => ({
      word: (it.alternatives && it.alternatives[0] && it.alternatives[0].content) || '',
      start: Number(it.start_time),
      end: Number(it.end_time),
    }))
    .filter((it) => it.word.length > 0);
}

function speechDensity(words, durationSec) {
  if (!durationSec || durationSec <= 0 || words.length === 0) {
    return 0;
  }
  return words.length / durationSec;
}

function findTimeframe(targetText, words) {
  // Sliding window over the word stream; pick the window with the highest
  // similarity to the target. Window size is the target's word count.
  const targetWords = targetText.toLowerCase().split(/\s+/).filter(Boolean);
  if (targetWords.length === 0 || words.length === 0) {
    return null;
  }
  const win = targetWords.length;
  let best = { ratio: 0, startIdx: -1, endIdx: -1 };

  // Try the natural size and a small set of size variations to handle
  // "[...]"-elided spans where the LLM compressed multiple sentences.
  const sizes = [win, Math.max(1, Math.floor(win * 0.7)), Math.ceil(win * 1.4)];
  const seen = new Set();

  for (const size of sizes) {
    if (size < 1 || seen.has(size)) {
      continue;
    }
    seen.add(size);

    for (let i = 0; i + size <= words.length; i += 1) {
      const chunk = words.slice(i, i + size).map((w) => w.word).join(' ');
      const ratio = stringSimilarity(targetText, chunk);
      if (ratio > best.ratio) {
        best = { ratio, startIdx: i, endIdx: i + size - 1 };
      }
    }
  }

  if (best.ratio < ANCHOR_SIM_THRESHOLD || best.startIdx < 0) {
    return null;
  }
  return {
    ratio: best.ratio,
    startSec: words[best.startIdx].start,
    endSec: words[best.endIdx].end,
  };
}

function mergeOverlapping(segments) {
  if (segments.length === 0) {
    return segments;
  }
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    // Strict overlap only — touching segments stay separate so models that
    // emit adjacent ranges don't get collapsed into one giant clip.
    if (cur.startSec < prev.endSec) {
      prev.endSec = Math.max(prev.endSec, cur.endSec);
      prev.text = `${prev.text} ${cur.text}`.trim();
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function buildPrompt(transcriptText, maxSegments, customPrompt) {
  const lines = [
    'You are a video editor identifying the most engaging moments in a video for short-form highlights.',
    `Pick up to ${maxSegments} highlight segments from the transcript below.`,
    'Each segment should be self-contained, between 5 and 60 seconds of speech.',
    'Quote the exact transcript words that bound the segment. If you skip words inside, replace them with [...].',
  ];
  if (customPrompt && customPrompt.length > 0) {
    lines.push('Additional guidance from the user:');
    lines.push(customPrompt);
  }
  lines.push('Respond ONLY with valid JSON in this shape:');
  lines.push('{"highlights":[{"title":"<short>","reason":"<why it matters>","quote":"<verbatim transcript span with optional [...]>"}]}');
  lines.push('');
  lines.push('Transcript:');
  lines.push(transcriptText);
  return lines.join('\n');
}

function parseHighlightsResponse(rawText) {
  let text = rawText.trim();
  // Strip common code-fence wrappers.
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // Lop off any chatter before the first '{' or after the last '}'.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new M2CException('Bedrock response did not contain JSON');
  }
  const json = JSON.parse(text.slice(first, last + 1));
  if (!Array.isArray(json.highlights)) {
    throw new M2CException('Bedrock response missing highlights[]');
  }
  return json.highlights;
}

async function callBedrock(modelId, prompt, region) {
  return callBedrockConverse(modelId, region, [{ text: prompt }]);
}

async function callBedrockConverse(modelId, region, contentBlocks) {
  const client = xraysdkHelper(new BedrockRuntimeClient({
    region,
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));

  const command = new ConverseCommand({
    modelId,
    messages: [{
      role: 'user',
      content: contentBlocks,
    }],
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0.2,
    },
  });

  const response = await client.send(command)
    .catch((e) => {
      if (e.name === 'ResourceNotFoundException' || e.name === 'AccessDeniedException') {
        console.log(`=== Make sure to request access to ${modelId} in ${region} (${e.name})`);
      }
      throw e;
    });

  const blocks = (response.output && response.output.message && response.output.message.content) || [];
  const text = blocks.map((b) => b.text || '').join('\n').trim();
  if (text.length === 0) {
    throw new M2CException('Bedrock returned empty content');
  }
  return {
    text,
    usage: response.usage || {},
  };
}

async function readTranscript(bucket, key) {
  const body = await CommonUtils.download(bucket, key);
  return JSON.parse(body);
}

function extractWords(transcriptJson) {
  // Standard Transcribe output shape: { results: { items: [...] }, ... }
  const items = (transcriptJson.results && transcriptJson.results.items) || transcriptJson.items;
  return flattenItems(items || []);
}

function joinTranscriptText(words) {
  return words.map((w) => w.word).join(' ');
}

function autoPickStrategy(density) {
  return density >= DEFAULT_AUTOPICK_THRESHOLD ? 'transcript-llm' : 'multimodal';
}

function videoFormatFromKey(key) {
  const m = /\.([a-z0-9]+)$/i.exec(key || '');
  if (!m) {
    return null;
  }
  return VIDEO_FORMAT_BY_EXT[m[1].toLowerCase()] || null;
}

function buildVideoPrompt(maxSegments, customPrompt, totalDurationSec, transcriptText) {
  const hasTranscript = transcriptText && transcriptText.length > 0;
  const lines = [
    'You are a video editor selecting the most engaging moments from a video for short-form highlights.',
    `You are given the full ${Math.round(totalDurationSec)}-second video${hasTranscript ? ', along with the spoken transcript' : ''}.`,
    `Pick up to ${maxSegments} non-overlapping highlight segments based on ${hasTranscript ? 'what you see and what is said' : 'what you see in the video'}.`,
    'STRICT RULES — failures here are unusable:',
    '- Each segment MUST be at least 5000 milliseconds and at most 60000 milliseconds long (endMs - startMs).',
    '- Do NOT emit 1-second clips. Do NOT emit clips that span most of the video.',
    '- Segments must NOT touch or overlap: each segment\'s startMs must be strictly greater than the previous segment\'s endMs.',
    '- Center each segment on the moment of interest; if the moment is brief, pad with surrounding context to reach at least 5 seconds.',
    'Report timestamps in milliseconds from the start of the video.',
  ];
  if (customPrompt && customPrompt.length > 0) {
    lines.push('Additional guidance from the user:');
    lines.push(customPrompt);
  }
  lines.push('Respond ONLY with valid JSON in this shape:');
  lines.push('{"highlights":[{"title":"<short>","reason":"<why it matters>","startMs":<int>,"endMs":<int>}]}');
  if (hasTranscript) {
    lines.push('');
    lines.push('Transcript:');
    lines.push(transcriptText);
  }
  return lines.join('\n');
}

function parseVideoHighlightsResponse(rawText, totalDurationSec) {
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new M2CException('VLM response did not contain JSON');
  }
  const json = JSON.parse(text.slice(first, last + 1));
  if (!Array.isArray(json.highlights)) {
    throw new M2CException('VLM response missing highlights[]');
  }

  const segments = [];
  const cap = totalDurationSec > 0 ? totalDurationSec : Number.POSITIVE_INFINITY;
  for (let i = 0; i < json.highlights.length; i += 1) {
    const h = json.highlights[i];
    const startMs = Number(h.startMs);
    const endMs = Number(h.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      console.log(`=== VLM segment #${i + 1} bad timestamps: start=${h.startMs} end=${h.endMs}`);
      continue;
    }
    let startSec = Math.max(0, startMs / 1000);
    let endSec = Math.min(cap, endMs / 1000);
    let duration = endSec - startSec;
    // Models often ignore the 5-60s constraint. Clamp short clips by
    // padding around the midpoint, and trim long clips from the end.
    if (duration < MIN_HIGHLIGHT_SEC) {
      const mid = (startSec + endSec) / 2;
      startSec = Math.max(0, mid - MIN_HIGHLIGHT_SEC / 2);
      endSec = Math.min(cap, startSec + MIN_HIGHLIGHT_SEC);
      // If we hit the end of the video, pull start back so duration is preserved.
      if (endSec - startSec < MIN_HIGHLIGHT_SEC) {
        startSec = Math.max(0, endSec - MIN_HIGHLIGHT_SEC);
      }
      duration = endSec - startSec;
    }
    if (duration > MAX_HIGHLIGHT_SEC) {
      endSec = startSec + MAX_HIGHLIGHT_SEC;
      duration = MAX_HIGHLIGHT_SEC;
    }
    if (duration < 1) {
      console.log(`=== VLM segment #${i + 1} too short after clamp (${duration}s)`);
      continue;
    }
    segments.push({
      kind: 'highlight',
      title: h.title || `Highlight ${i + 1}`,
      reason: h.reason || '',
      startSec,
      endSec,
      startTimecode: secondsToTimecode(startSec),
      endTimecode: secondsToTimecode(endSec),
      text: '',
    });
  }
  return segments;
}

async function runMultimodalStrategy({ uuid, proxyBucket, proxyKey, accountId, maxSegments, modelId, customPrompt, durationSec, region, transcriptText }) {
  const format = videoFormatFromKey(proxyKey);
  if (!format) {
    throw new M2CException(`unsupported video format for proxy ${proxyKey}`);
  }

  console.log(`=== multimodal: video s3://${proxyBucket}/${proxyKey} (${format}), transcript=${transcriptText ? `${transcriptText.length}ch` : 'none'} for ${uuid}`);

  const promptText = buildVideoPrompt(maxSegments, customPrompt, durationSec, transcriptText);
  const s3Location = { uri: `s3://${proxyBucket}/${proxyKey}` };
  if (accountId) {
    s3Location.bucketOwner = String(accountId);
  }

  const contentBlocks = [
    { video: { format, source: { s3Location } } },
    { text: promptText },
  ];

  const { text: rawResponse, usage } = await callBedrockConverse(modelId, region, contentBlocks);
  console.log(`=== multimodal raw response (${rawResponse.length}ch): ${rawResponse}`);
  const segments = parseVideoHighlightsResponse(rawResponse, durationSec);
  console.log(`=== multimodal parsed segments: ${segments.length}`);

  return { segments, usage };
}

async function publishStatus(extra) {
  // Fire-and-forget — failures only log, never break the run.
  try {
    return await IotStatus.publish({
      type: IOT_TYPE,
      ...extra,
    });
  } catch (e) {
    console.log(`=== publishStatus failed: ${e.message}`);
    return undefined;
  }
}

async function persistHighlightSet(table, row) {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  const doc = DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });
  await doc.send(new PutCommand({ TableName: table, Item: row }));
}

exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const region = process.env.ENV_BEDROCK_REGION;
  const proxyBucket = process.env.ENV_PROXY_BUCKET;
  const tableName = process.env.ENV_HIGHLIGHT_SETS_TABLE;

  const {
    uuid,
    transcriptKey,
    proxyKey,
    accountId,
    strategy: requestedStrategy = 'auto',
    modelId: requestedModelId,
    prompt: customPrompt,
    maxSegments = DEFAULT_MAX_SEGMENTS,
    owner = 'unknown',
    durationSec,
  } = event;

  if (!uuid) {
    throw new M2CException('uuid is required');
  }

  let strategy = requestedStrategy;
  // Allocate the highlight-set id up front so the PROCESSING row, IoT
  // events, and final COMPLETED/FAILED row all share the same key. The
  // webapp uses this id to render an in-flight banner that survives a
  // page refresh.
  const highlightSetId = CRYPTO.randomUUID();
  const startedAt = new Date().toISOString();

  try {
    await publishStatus({
      uuid,
      highlightSetId,
      strategy,
      status: 'started',
      percent: 0,
    });

    await persistHighlightSet(tableName, {
      uuid,
      highlightSetId,
      strategy,
      modelId: requestedModelId || null,
      prompt: customPrompt || null,
      segments: [],
      status: 'PROCESSING',
      createdAt: startedAt,
      createdBy: owner,
      durationSec: durationSec || 0,
    });

    // Transcript is required for transcript-llm; multimodal uses it when available.
    let words = [];
    let totalDuration = durationSec || 0;
    let density = 0;

    if (transcriptKey) {
      const transcriptJson = await readTranscript(proxyBucket, transcriptKey);
      words = extractWords(transcriptJson);
      if (words.length > 0) {
        const lastWordEnd = words[words.length - 1].end;
        totalDuration = totalDuration || lastWordEnd;
        density = speechDensity(words, totalDuration);
      }
    }

    if (strategy === 'auto') {
      strategy = autoPickStrategy(density);
    }

    await publishStatus({
      uuid,
      highlightSetId,
      strategy,
      status: 'processing',
      percent: 30,
      phase: 'data-loaded',
    });

    let merged;
    let modelId;
    let usage = {};
    let extra = {};

    if (strategy === 'transcript-llm') {
      if (words.length === 0) {
        throw new M2CException('transcript-llm requires a transcript; none found for this asset');
      }
      modelId = ensureInferenceProfile(requestedModelId || DEFAULT_TRANSCRIPT_MODEL);
      const transcriptText = joinTranscriptText(words);
      const prompt = buildPrompt(transcriptText, maxSegments, customPrompt);
      const out = await callBedrock(modelId, prompt, region);
      usage = out.usage;
      await publishStatus({
        uuid,
        highlightSetId,
        strategy,
        status: 'processing',
        percent: 70,
        phase: 'model-completed',
      });
      const rawHighlights = parseHighlightsResponse(out.text);
      const segments = [];
      for (let i = 0; i < rawHighlights.length; i += 1) {
        const h = rawHighlights[i];
        const quote = (h.quote || '').replace(/\[\.\.\.\]/g, ' ').trim();
        if (quote.length === 0) {
          continue;
        }
        const tf = findTimeframe(quote, words);
        if (!tf) {
          console.log(`=== anchor failed for #${i + 1}: "${(h.title || '').slice(0, 60)}"`);
          continue;
        }
        segments.push({
          kind: 'highlight',
          title: h.title || `Highlight ${i + 1}`,
          reason: h.reason || '',
          quote: h.quote || '',
          startSec: tf.startSec,
          endSec: tf.endSec,
          startTimecode: secondsToTimecode(tf.startSec),
          endTimecode: secondsToTimecode(tf.endSec),
          anchorRatio: Number(tf.ratio.toFixed(3)),
          text: quote,
        });
      }
      merged = mergeOverlapping(segments);
    } else if (strategy === 'multimodal') {
      if (!proxyKey) {
        throw new M2CException('multimodal requires a proxyKey; ensure ingest produced a video proxy');
      }
      modelId = ensureInferenceProfile(requestedModelId || DEFAULT_VLM_MODEL);
      const transcriptText = words.length > 0 ? joinTranscriptText(words) : '';
      const out = await runMultimodalStrategy({
        uuid,
        proxyBucket,
        proxyKey,
        accountId,
        maxSegments,
        modelId,
        customPrompt,
        durationSec: totalDuration,
        region,
        transcriptText,
      });
      usage = out.usage;
      await publishStatus({
        uuid,
        highlightSetId,
        strategy,
        status: 'processing',
        percent: 70,
        phase: 'model-completed',
      });
      merged = mergeOverlapping(out.segments);
      extra = { proxyKey };
    } else {
      throw new M2CException(`unsupported strategy: ${strategy}`);
    }

    await publishStatus({
      uuid,
      highlightSetId,
      strategy,
      status: 'processing',
      percent: 90,
      phase: 'anchored',
      segmentCount: merged.length,
    });

    const row = {
      uuid,
      highlightSetId,
      strategy,
      modelId,
      prompt: customPrompt || null,
      segments: merged,
      status: 'COMPLETED',
      createdAt: startedAt,
      finishedAt: new Date().toISOString(),
      createdBy: owner,
      speechDensity: Number(density.toFixed(3)),
      durationSec: totalDuration,
      cost: {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
      },
      ...extra,
    };

    await persistHighlightSet(tableName, row);

    await publishStatus({
      uuid,
      highlightSetId,
      strategy,
      status: 'completed',
      percent: 100,
      segmentCount: merged.length,
    });

    return {
      uuid,
      highlightSetId,
      strategy,
      modelId,
      segmentCount: merged.length,
      segments: merged,
      status: 'COMPLETED',
    };
  } catch (e) {
    const errorMessage = e.message || String(e);
    // Stamp the row as FAILED so the webapp can list it after a refresh.
    // Best-effort — if persistence itself blew up we still rethrow the
    // original error to surface in Step Functions.
    try {
      await persistHighlightSet(tableName, {
        uuid,
        highlightSetId,
        strategy,
        modelId: requestedModelId || null,
        prompt: customPrompt || null,
        segments: [],
        status: 'FAILED',
        error: errorMessage,
        createdAt: startedAt,
        finishedAt: new Date().toISOString(),
        createdBy: owner,
        durationSec: durationSec || 0,
      });
    } catch (persistErr) {
      console.log(`=== persist FAILED row failed: ${persistErr.message}`);
    }
    await publishStatus({
      uuid,
      highlightSetId,
      strategy,
      status: 'error',
      error: errorMessage,
    });
    throw e;
  }
};
