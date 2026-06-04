// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

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

const REQUIRED_ENVS = [
  'ENV_PROXY_BUCKET',
  'ENV_HIGHLIGHT_SETS_TABLE',
  'ENV_BEDROCK_REGION',
];

const IOT_TYPE = 'detect-highlight';

function s3Client() {
  return xraysdkHelper(new S3Client({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
}

function ddbDoc() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function bedrockClient(region) {
  return xraysdkHelper(new BedrockRuntimeClient({
    region,
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
}

async function readTranscriptWords(bucket, key) {
  if (!key) return [];
  try {
    const body = await CommonUtils.download(bucket, key);
    const json = JSON.parse(body);
    const items = (json.results && json.results.items) || json.items || [];
    return items
      .filter((it) => it.start_time !== undefined && it.end_time !== undefined)
      .map((it) => ({
        word: (it.alternatives && it.alternatives[0] && it.alternatives[0].content) || '',
        start: Number(it.start_time),
        end: Number(it.end_time),
      }))
      .filter((it) => it.word.length > 0);
  } catch (e) {
    console.log(`=== transcript read failed (non-fatal, treating as silent): ${e.message}`);
    return [];
  }
}

function wordsInWindow(words, startSec, endSec) {
  if (words.length === 0) return '';
  return words
    .filter((w) => w.end > startSec && w.start < endSec)
    .map((w) => w.word)
    .join(' ')
    .trim();
}

// Score each shot independently against the user task. Shot count and
// downstream maxSegments are NOT in the prompt — coupling them would make
// the same shot score differently depending on unrelated knobs.
function buildRankPrompt(userTask, shotsWithTranscript) {
  const task = (userTask || '').trim()
    || 'Find the most engaging or significant moments worth highlighting.';
  const lines = [];
  lines.push(`The user wants highlights matching this task: "${task}"`);
  lines.push('');
  lines.push(`Below are ${shotsWithTranscript.length} shots from the video, each with a visual description and the words spoken during it.`);
  lines.push('Score each shot 0.0-1.0 by how strongly it matches the user task.');
  lines.push('Be honest: if a shot does not match the task, score it low. Many shots may legitimately score 0.');
  lines.push('Score each shot purely on its own merits — do not adjust scores up or down based on how many shots there are.');
  lines.push('');
  lines.push('SHOTS:');
  for (const s of shotsWithTranscript) {
    const dialogue = s.spoken ? `Spoken words: "${s.spoken}"` : 'Spoken words: (silent)';
    lines.push(`---`);
    lines.push(`[${s.index}] ${s.startTimecode}-${s.endTimecode} (${(s.endSec - s.startSec).toFixed(1)}s)`);
    lines.push(`Visual: ${s.title}. ${s.description}`);
    lines.push(dialogue);
  }
  lines.push('---');
  lines.push('');
  lines.push('Respond ONLY with valid JSON in this exact shape:');
  lines.push('{"rankings":[{"index":<int>,"score":<0.0-1.0>,"reason":"<one short sentence on why>"}]}');
  lines.push('Include every shot index above. Do not invent or omit indices.');
  return lines.join('\n');
}

async function callRanker({ region, modelId, prompt }) {
  const client = bedrockClient(region);
  const command = new ConverseCommand({
    modelId,
    messages: [{
      role: 'user',
      content: [{ text: prompt }],
    }],
    inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
  });
  const response = await client.send(command);
  const blocks = (response.output && response.output.message && response.output.message.content) || [];
  const text = blocks.map((b) => b.text || '').join('\n').trim();
  if (text.length === 0) {
    throw new M2CException('rank LLM returned empty content');
  }
  return text;
}

function parseRankings(rawText, expectedIndices) {
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new M2CException('rank LLM response did not contain JSON');
  }
  const json = JSON.parse(text.slice(first, last + 1));
  if (!Array.isArray(json.rankings)) {
    throw new M2CException('rank LLM response missing rankings[]');
  }
  const byIndex = new Map();
  for (const r of json.rankings) {
    const idx = Number(r.index);
    if (!Number.isFinite(idx)) continue;
    const rawScore = Number(r.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore)) : 0;
    byIndex.set(idx, { score, reason: (r.reason || '').trim() });
  }
  // Default any missing index to 0 — better than crashing on partial output.
  const out = new Map();
  for (const idx of expectedIndices) {
    out.set(idx, byIndex.get(idx) || { score: 0, reason: '' });
  }
  return out;
}

async function deleteShotPrefix(bucket, prefix) {
  const s3 = s3Client();
  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
    .catch((e) => {
      console.log(`=== list shots failed (non-fatal): ${e.message}`);
      return undefined;
    });
  const objects = ((list || {}).Contents || []).map((o) => ({ Key: o.Key }));
  if (objects.length === 0) return;
  for (let i = 0; i < objects.length; i += 1000) {
    const slice = objects.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: slice, Quiet: true },
    })).catch((e) => {
      console.log(`=== delete shots batch failed (non-fatal): ${e.message}`);
    });
  }
}

async function publishStatus(payload) {
  try {
    await IotStatus.publish({ type: IOT_TYPE, ...payload });
  } catch (e) {
    console.log(`=== iot publish failed (non-fatal): ${e.message}`);
  }
}

function tryParseCause(cause) {
  try {
    const parsed = JSON.parse(cause);
    return parsed.errorMessage || cause;
  } catch (e) {
    return cause;
  }
}

// Final state of the highlight pipeline:
//   1. Collect Pegasus shot descriptions from the Map state.
//   2. Read the transcript JSON (if any) and slice spoken words per shot.
//   3. Ask the rank LLM to score each shot against the user prompt with
//      transcript context.
//   4. Take top maxSegments by score (no minConfidence — different rank
//      models calibrate differently, so an absolute threshold isn't
//      portable; users get the count they asked for instead).
//   5. Persist COMPLETED row + clean up shot MP4s + IoT 'completed' event.
//
// Failure path: SFN Catch routes here with `error` populated; we write a
// FAILED row and clean up.
exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const proxyBucket = process.env.ENV_PROXY_BUCKET;
  const tableName = process.env.ENV_HIGHLIGHT_SETS_TABLE;
  const region = process.env.ENV_BEDROCK_REGION;

  const {
    uuid,
    highlightSetId,
    modelId,
    rankModelId,
    prompt: userPrompt,
    owner,
    durationSec,
    proxyKey,
    transcriptKey,
    maxSegments = 10,
    startedAt,
    shotResults,
    error: errorEnvelope,
  } = event;

  if (!uuid || !highlightSetId) {
    throw new M2CException('uuid and highlightSetId required');
  }

  const finishedAt = new Date().toISOString();
  const shotPrefix = `${uuid}/_pegasus-shots/${highlightSetId}/`;

  if (errorEnvelope) {
    const errMsg = (errorEnvelope.Cause && tryParseCause(errorEnvelope.Cause))
      || errorEnvelope.Error
      || 'unknown error';
    console.log(`=== FAILED path: ${errMsg}`);
    await ddbDoc().send(new PutCommand({
      TableName: tableName,
      Item: {
        uuid,
        highlightSetId,
        modelId: modelId || null,
        rankModelId: rankModelId || null,
        prompt: userPrompt || null,
        segments: [],
        status: 'FAILED',
        error: errMsg,
        createdAt: startedAt || finishedAt,
        finishedAt,
        createdBy: owner || 'unknown',
        durationSec: durationSec || 0,
      },
    }));
    await deleteShotPrefix(proxyBucket, shotPrefix);
    await publishStatus({
      uuid,
      highlightSetId,
      status: 'error',
      error: errMsg,
    });
    return {
      uuid,
      highlightSetId,
      status: 'FAILED',
      error: errMsg,
    };
  }

  // Map state results: [{index, shotKey, shot}] — shot may be missing if
  // the per-shot Catch fired (Pegasus rejected the clip etc.).
  const shotsRaw = (Array.isArray(shotResults) ? shotResults : [])
    .map((r) => (r && r.shot) ? r.shot : null)
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);

  if (shotsRaw.length === 0) {
    throw new M2CException('no shots survived the describe step');
  }

  // Attach per-shot transcript slice. Empty when the asset has no
  // transcript or the shot covers a silent stretch.
  const words = await readTranscriptWords(proxyBucket, transcriptKey);
  const shotsWithTranscript = shotsRaw.map((s) => ({
    ...s,
    spoken: wordsInWindow(words, s.startSec, s.endSec),
  }));
  console.log(`=== loaded ${words.length} transcript words; ${shotsWithTranscript.filter((s) => s.spoken).length}/${shotsWithTranscript.length} shots have dialogue`);

  // Rank by user-task relevance.
  const rankPrompt = buildRankPrompt(userPrompt, shotsWithTranscript);
  const rawRanking = await callRanker({ region, modelId: rankModelId, prompt: rankPrompt });
  console.log(`=== rank raw (${rawRanking.length}ch): ${rawRanking}`);

  const expectedIndices = shotsWithTranscript.map((s) => s.index);
  const scoresByIndex = parseRankings(rawRanking, expectedIndices);

  // Build initial segment list with rank scores (ordered by chronology).
  const scored = shotsWithTranscript.map((s) => {
    const r = scoresByIndex.get(s.index) || { score: 0, reason: '' };
    return {
      kind: 'highlight',
      title: s.title,
      reason: r.reason,
      description: s.description,
      score: r.score,
      startSec: s.startSec,
      endSec: s.endSec,
      startTimecode: s.startTimecode,
      endTimecode: s.endTimecode,
      text: s.spoken || '',
    };
  });

  // Take top maxSegments by score and stamp a rank field (1 = best). Title
  // stays clean — the editor renders "#<reelIdx> · <title>" client-side
  // using the reel position; rank lives as its own field so the UI can
  // surface "Rank #N by AI" without colliding with reel order.
  const cap = Number(maxSegments) || 10;
  const segments = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((s, i) => ({ ...s, rank: i + 1 }))
    .sort((a, b) => a.startSec - b.startSec);

  console.log(`=== ranked ${scored.length} → ${segments.length} kept (maxSegments=${cap})`);

  await ddbDoc().send(new PutCommand({
    TableName: tableName,
    Item: {
      uuid,
      highlightSetId,
      modelId: modelId || null,
      rankModelId: rankModelId || null,
      prompt: userPrompt || null,
      segments,
      status: 'COMPLETED',
      createdAt: startedAt || finishedAt,
      finishedAt,
      createdBy: owner || 'unknown',
      durationSec: durationSec || 0,
      proxyKey,
    },
  }));

  await deleteShotPrefix(proxyBucket, shotPrefix);

  await publishStatus({
    uuid,
    highlightSetId,
    status: 'completed',
    percent: 100,
    segmentCount: segments.length,
  });

  return {
    uuid,
    highlightSetId,
    modelId: modelId || null,
    rankModelId: rankModelId || null,
    segmentCount: segments.length,
    segments,
    status: 'COMPLETED',
  };
};
