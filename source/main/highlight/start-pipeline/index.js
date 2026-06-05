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

const IOT_TYPE = 'detect-highlight';

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

// Allocate a highlightSetId, persist a PROCESSING row + IoT 'started' event,
// and emit the run context for the linear pipeline:
//   detect-shots (OpenCV) → Map(describe-shot, Pegasus) → rank-shots (LLM rank + DDB write)
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
    modelId,
    rankModelId,
    prompt,
    maxSegments = 10,
    minConfidence = 0.5,
    owner = 'unknown',
    durationSec = 0,
  } = event;

  if (!uuid) {
    throw new M2CException('uuid is required');
  }
  if (!modelId) {
    throw new M2CException('modelId is required (video model used to describe each shot)');
  }
  if (!rankModelId) {
    throw new M2CException('rankModelId is required (text model used to rank shots against the prompt)');
  }
  if (!proxyKey) {
    throw new M2CException('proxyKey is required (video proxy MP4)');
  }

  const highlightSetId = CRYPTO.randomUUID();
  const startedAt = new Date().toISOString();

  await persistProcessingRow(tableName, {
    uuid,
    highlightSetId,
    modelId,
    rankModelId,
    prompt: prompt || null,
    segments: [],
    status: 'PROCESSING',
    createdAt: startedAt,
    createdBy: owner,
    durationSec,
  });

  await publishStarted({
    uuid,
    highlightSetId,
    status: 'started',
    percent: 0,
  });

  return {
    uuid,
    highlightSetId,
    modelId,
    rankModelId,
    prompt: prompt || null,
    maxSegments,
    minConfidence,
    owner,
    durationSec,
    transcriptKey: transcriptKey || null,
    proxyKey,
    accountId,
    proxyBucket,
    startedAt,
  };
};
