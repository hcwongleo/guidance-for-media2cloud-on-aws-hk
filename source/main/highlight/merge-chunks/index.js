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

function mergeAndCap(allSegments, maxSegments) {
  const sorted = [...allSegments].sort((a, b) => a.startSec - b.startSec);
  const merged = [];
  for (const seg of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && seg.startSec < prev.endSec) {
      prev.endSec = Math.max(prev.endSec, seg.endSec);
      prev.text = `${prev.text || ''} ${seg.text || ''}`.trim();
      // Keep the higher-confidence label when collapsing overlaps.
      if ((seg.score || 0) > (prev.score || 0)) {
        prev.score = seg.score;
      }
    } else {
      merged.push({ ...seg });
    }
  }
  // Per-chunk budgets in plan-chunks make the cap a defensive backstop, not
  // the primary filter. When it does fire, drop low-confidence picks first
  // (not the back half of the timeline) and re-sort by time for display.
  if (merged.length <= maxSegments) {
    return merged;
  }
  return [...merged]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, maxSegments)
    .sort((a, b) => a.startSec - b.startSec);
}

async function deleteChunks(bucket, prefix) {
  const s3 = s3Client();
  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
    .catch((e) => {
      console.log(`=== list chunks failed (non-fatal): ${e.message}`);
      return undefined;
    });
  const objects = ((list || {}).Contents || []).map((o) => ({ Key: o.Key }));
  if (objects.length === 0) {
    return;
  }
  // Batch delete in chunks of 1000 (S3 hard limit).
  for (let i = 0; i < objects.length; i += 1000) {
    const slice = objects.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: slice, Quiet: true },
    })).catch((e) => {
      console.log(`=== delete chunks batch failed (non-fatal): ${e.message}`);
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
    highlightSetId,
    strategy,
    modelId,
    prompt,
    owner,
    durationSec,
    proxyKey,
    maxSegments = 10,
    startedAt,
    chunkResults = [],
    // SFN Catch routes failures here with a wrapped { error: { Error, Cause } }.
    error: errorEnvelope,
  } = event;

  if (!uuid || !highlightSetId) {
    throw new M2CException('uuid and highlightSetId required');
  }

  const finishedAt = new Date().toISOString();

  // Failure path. Single source of truth for FAILED row + IoT publish so
  // both the single-call Catch and the Map-state Catch land here.
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
        strategy,
        modelId: modelId || null,
        prompt: prompt || null,
        segments: [],
        status: 'FAILED',
        error: errMsg,
        createdAt: startedAt || finishedAt,
        finishedAt,
        createdBy: owner || 'unknown',
        durationSec: durationSec || 0,
      },
    }));
    // Best-effort cleanup if we already produced chunks.
    await deleteChunks(proxyBucket, `${uuid}/_pegasus-chunks/${highlightSetId}/`);
    await publishStatus({
      uuid,
      highlightSetId,
      strategy,
      status: 'error',
      error: errMsg,
    });
    return {
      uuid,
      highlightSetId,
      strategy,
      status: 'FAILED',
      error: errMsg,
    };
  }

  const allSegments = [];
  for (const cr of chunkResults) {
    if (cr && Array.isArray(cr.segments)) {
      allSegments.push(...cr.segments);
    }
  }
  const merged = mergeAndCap(allSegments, maxSegments);
  console.log(`=== merged ${allSegments.length} segments from ${chunkResults.length} chunks → ${merged.length} after cap`);

  await ddbDoc().send(new PutCommand({
    TableName: tableName,
    Item: {
      uuid,
      highlightSetId,
      strategy,
      modelId: modelId || null,
      prompt: prompt || null,
      segments: merged,
      status: 'COMPLETED',
      createdAt: startedAt || finishedAt,
      finishedAt,
      createdBy: owner || 'unknown',
      durationSec: durationSec || 0,
      chunkCount: chunkResults.length,
      cost: { inputTokens: 0, outputTokens: 0 },
      proxyKey,
    },
  }));

  // Best-effort cleanup of the per-run chunk MP4s.
  await deleteChunks(proxyBucket, `${uuid}/_pegasus-chunks/${highlightSetId}/`);

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
    modelId: modelId || null,
    segmentCount: merged.length,
    segments: merged,
    status: 'COMPLETED',
  };
};

function tryParseCause(cause) {
  // SFN wraps Lambda errors so Cause is a JSON string with { errorMessage }.
  try {
    const parsed = JSON.parse(cause);
    return parsed.errorMessage || cause;
  } catch (e) {
    return cause;
  }
}
