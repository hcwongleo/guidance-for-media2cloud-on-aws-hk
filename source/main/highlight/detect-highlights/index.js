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
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');

const REQUIRED_ENVS = [
  'ENV_BEDROCK_REGION',
  'ENV_PROXY_BUCKET',
  'ENV_HIGHLIGHT_SETS_TABLE',
];

const DEFAULT_TRANSCRIPT_MODEL = 'amazon.nova-2-lite-v1:0';
const DEFAULT_MAX_SEGMENTS = 10;
const DEFAULT_AUTOPICK_THRESHOLD = 0.6; // words/sec
const ANCHOR_SIM_THRESHOLD = 0.70;      // matches Python reference
const FPS = 25;

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
    if (cur.startSec <= prev.endSec) {
      prev.endSec = Math.max(prev.endSec, cur.endSec);
      prev.text = `${prev.text} ${cur.text}`.trim();
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function buildPrompt(transcriptText, maxSegments, customPrompt) {
  if (customPrompt && customPrompt.length > 0) {
    return `${customPrompt}\n\nTranscript:\n${transcriptText}`;
  }
  return [
    'You are a video editor identifying the most engaging moments in a video for short-form highlights.',
    `Pick up to ${maxSegments} highlight segments from the transcript below.`,
    'Each segment should be self-contained, between 5 and 60 seconds of speech.',
    'Quote the exact transcript words that bound the segment. If you skip words inside, replace them with [...].',
    'Respond ONLY with valid JSON in this shape:',
    '{"highlights":[{"title":"<short>","reason":"<why it matters>","quote":"<verbatim transcript span with optional [...]>"}]}',
    '',
    'Transcript:',
    transcriptText,
  ].join('\n');
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
  const client = xraysdkHelper(new BedrockRuntimeClient({
    region,
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));

  const command = new ConverseCommand({
    modelId,
    messages: [{
      role: 'user',
      content: [{ text: prompt }],
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
  return density >= DEFAULT_AUTOPICK_THRESHOLD ? 'transcript-llm' : 'pure-vlm';
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
  if (!transcriptKey) {
    throw new M2CException('transcriptKey is required');
  }

  const transcriptJson = await readTranscript(proxyBucket, transcriptKey);
  const words = extractWords(transcriptJson);
  if (words.length === 0) {
    throw new M2CException(`no transcript words found at s3://${proxyBucket}/${transcriptKey}`);
  }
  const lastWordEnd = words[words.length - 1].end;
  const totalDuration = durationSec || lastWordEnd;
  const density = speechDensity(words, totalDuration);

  let strategy = requestedStrategy;
  if (strategy === 'auto') {
    strategy = autoPickStrategy(density);
  }

  if (strategy === 'pure-vlm') {
    // Pure-VLM frame extraction + multipart Bedrock call ships in a follow-up commit.
    throw new M2CException('pure-vlm strategy is not yet implemented; use transcript-llm');
  }
  if (strategy !== 'transcript-llm') {
    throw new M2CException(`unsupported strategy: ${strategy}`);
  }

  const modelId = requestedModelId || DEFAULT_TRANSCRIPT_MODEL;
  const transcriptText = joinTranscriptText(words);
  const prompt = buildPrompt(transcriptText, maxSegments, customPrompt);

  const startedAt = new Date().toISOString();
  const { text: rawResponse, usage } = await callBedrock(modelId, prompt, region);
  const rawHighlights = parseHighlightsResponse(rawResponse);

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

  const merged = mergeOverlapping(segments);
  const highlightSetId = CRYPTO.randomUUID();

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
  };

  await persistHighlightSet(tableName, row);

  return {
    uuid,
    highlightSetId,
    strategy,
    modelId,
    segmentCount: merged.length,
    segments: merged,
    status: 'COMPLETED',
  };
};
