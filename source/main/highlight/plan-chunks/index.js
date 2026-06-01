// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');
const CRYPTO = require('node:crypto');

const {
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
];

// Pegasus's frame-sampling budget is fixed per call, so longer inputs
// translate to coarser internal time resolution. Empirically a 25-min
// chunk produced 60s+ start-time drift on basketball plays. 5-min chunks
// give the model ~5x finer temporal granularity per sampled frame.
const CHUNK_TARGET_SEC = 5 * 60;
// Force chunking for anything longer than the target chunk size so
// medium-length videos don't fall back to a single coarse call.
const SINGLE_CALL_MAX_SEC = CHUNK_TARGET_SEC;

const IOT_TYPE = 'detect-highlight';

function planChunks(durationSec) {
  const chunks = [];
  let start = 0;
  let idx = 0;
  while (start < durationSec) {
    const end = Math.min(durationSec, start + CHUNK_TARGET_SEC);
    chunks.push({
      index: idx,
      startSec: start,
      endSec: end,
      durationSec: end - start,
    });
    start = end;
    idx += 1;
  }
  return chunks;
}

async function persistProcessingRow(table, row) {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  const doc = DynamoDBDocumentClient.from(ddb, {
    marshallOptions: { removeUndefinedValues: true },
  });
  await doc.send(new PutCommand({ TableName: table, Item: row }));
}

async function publishStarted(payload) {
  try {
    await IotStatus.publish({ type: IOT_TYPE, ...payload });
  } catch (e) {
    console.log(`=== iot publish failed (non-fatal): ${e.message}`);
  }
}

exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const proxyBucket = process.env.ENV_PROXY_BUCKET;
  const tableName = process.env.ENV_HIGHLIGHT_SETS_TABLE;

  const {
    uuid,
    transcriptKey,
    proxyKey,
    accountId,
    strategy = 'multimodal',
    modelId,
    prompt,
    maxSegments = 10,
    minConfidence = 0.7,
    owner = 'unknown',
    durationSec = 0,
  } = event;

  if (!uuid) {
    throw new M2CException('uuid is required');
  }
  if (strategy !== 'multimodal' && strategy !== 'transcript-llm') {
    throw new M2CException(`unsupported strategy: ${strategy}`);
  }

  const highlightSetId = CRYPTO.randomUUID();
  const startedAt = new Date().toISOString();

  // Single-call path: anything within Pegasus' single-shot limit, plus
  // every transcript-llm run. Multi-chunk only when multimodal AND >55 min.
  const splitNeeded = strategy === 'multimodal' && durationSec > SINGLE_CALL_MAX_SEC;
  const chunks = splitNeeded ? planChunks(durationSec) : [];

  await persistProcessingRow(tableName, {
    uuid,
    highlightSetId,
    strategy,
    modelId: modelId || null,
    prompt: prompt || null,
    segments: [],
    status: 'PROCESSING',
    createdAt: startedAt,
    createdBy: owner,
    durationSec,
    ...(splitNeeded ? { chunkCount: chunks.length } : {}),
  });

  await publishStarted({
    uuid,
    highlightSetId,
    strategy,
    status: 'started',
    percent: 0,
    ...(splitNeeded ? { chunkCount: chunks.length } : {}),
  });

  // Divide the user's segment cap across chunks so each chunk worker only
  // emits its share. Without this, a 110-min video chunked into two 50-min
  // halves would each return ~maxSegments and merge-chunks would have to
  // throw most away.
  const chunkMaxSegments = chunks.length > 0
    ? Math.max(1, Math.ceil(maxSegments / chunks.length))
    : maxSegments;

  // Emit chunk records pre-baked with everything the per-chunk Lambdas need
  // so neither Map iteration has to refetch state.
  const chunkInputs = chunks.map((c) => ({
    ...c,
    uuid,
    highlightSetId,
    sourceProxyBucket: proxyBucket,
    sourceProxyKey: proxyKey,
    accountId,
    modelId: modelId || null,
    prompt: prompt || null,
    maxSegments,
    chunkMaxSegments,
    minConfidence,
    transcriptKey: transcriptKey || null,
  }));

  return {
    uuid,
    highlightSetId,
    strategy,
    modelId: modelId || null,
    prompt: prompt || null,
    maxSegments,
    minConfidence,
    owner,
    durationSec,
    transcriptKey: transcriptKey || null,
    proxyKey,
    accountId,
    splitNeeded,
    startedAt,
    chunks: chunkInputs,
    chunkCount: chunkInputs.length,
  };
};
