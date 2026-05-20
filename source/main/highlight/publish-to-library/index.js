// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const PATH = require('path');
const CRYPTO = require('node:crypto');
const {
  S3Client,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const {
  SFNClient,
  StartExecutionCommand,
} = require('@aws-sdk/client-sfn');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  UpdateCommand,
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
  'ENV_RENDERS_TABLE',
  'ENV_PROXY_BUCKET',
  'ENV_RESOURCE_PREFIX',
  'ENV_IOT_HOST',
  'ENV_IOT_TOPIC',
];

function ddb() {
  const client = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function s3() {
  return xraysdkHelper(new S3Client({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
}

function sfn() {
  return xraysdkHelper(new SFNClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
}

function parseS3Uri(uri) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri || '');
  if (!m) return undefined;
  return { bucket: m[1], prefix: m[2] };
}

function newUuid() {
  return CRYPTO.randomUUID();
}

function makeSafePrefix(uuid, key) {
  let safeKey = (!(/^[a-zA-Z0-9_.!*'()/-]{1,1024}$/.test(key)))
    ? key.replace(/[^a-zA-Z0-9_.!*'()/-]/g, '_')
    : key;
  if (safeKey[0] === '/') {
    safeKey = safeKey.slice(1);
  }
  const parsed = PATH.parse(safeKey);
  return PATH.join(uuid, parsed.dir, '/');
}

async function findRenderedMp4(bucket, prefix) {
  const client = s3();
  const res = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));
  const contents = (res || {}).Contents || [];
  // Prefer the *_proxy.mp4 NameModifier file written by compose-edl.
  const mp4 = contents.find((o) => /_proxy\.mp4$/i.test(o.Key))
    || contents.find((o) => /\.mp4$/i.test(o.Key));
  if (!mp4 || !mp4.Key) {
    throw new M2CException(`no rendered MP4 under s3://${bucket}/${prefix}`);
  }
  return mp4.Key;
}

async function publishStatus(editProjectId, payload) {
  const message = {
    type: 'render',
    editProjectId,
    ...payload,
  };
  try {
    await IotStatus.publish(message);
  } catch (e) {
    console.log(`IoT publish failed (non-fatal): ${e && e.message}`);
  }
}

exports.handler = async (event, context) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const accountId = context.invokedFunctionArn.split(':')[4];
  if (!accountId) {
    throw new M2CException('accountId not found in invokedFunctionArn');
  }

  const rendersTable = process.env.ENV_RENDERS_TABLE;
  const proxyBucket = process.env.ENV_PROXY_BUCKET;
  const resourcePrefix = process.env.ENV_RESOURCE_PREFIX;

  const {
    renderId,
    editProjectId,
    outputs,
    destinationPrefix,
  } = event;

  if (!renderId) {
    throw new M2CException('renderId is required');
  }

  // Resolve the rendered MP4 location. Prefer outputs.mp4 from render-status;
  // fall back to destinationPrefix from compose-edl.
  let mp4Prefix;
  if (outputs && outputs.mp4) {
    mp4Prefix = parseS3Uri(outputs.mp4);
  }
  if (!mp4Prefix && destinationPrefix) {
    mp4Prefix = parseS3Uri(`${destinationPrefix}mp4/`);
  }
  if (!mp4Prefix) {
    throw new M2CException('cannot resolve MP4 destination prefix');
  }

  const mp4Key = await findRenderedMp4(mp4Prefix.bucket, mp4Prefix.prefix);

  const publishedUuid = newUuid();
  const stateMachineArn = [
    'arn:aws:states',
    process.env.AWS_REGION,
    accountId,
    'stateMachine',
    `${resourcePrefix}-main`,
  ].join(':');

  const params = {
    input: {
      uuid: publishedUuid,
      bucket: mp4Prefix.bucket,
      key: mp4Key,
      destination: {
        bucket: proxyBucket,
        prefix: makeSafePrefix(publishedUuid, mp4Key),
      },
    },
  };

  const command = new StartExecutionCommand({
    input: JSON.stringify(params),
    stateMachineArn,
  });

  const exec = await sfn().send(command);
  const executionArn = (exec || {}).executionArn;

  await ddb().send(new UpdateCommand({
    TableName: rendersTable,
    Key: { renderId },
    UpdateExpression: 'SET publishedUuid = :u, publishedExecutionArn = :a, publishedAt = :t',
    ExpressionAttributeValues: {
      ':u': publishedUuid,
      ':a': executionArn,
      ':t': new Date().toISOString(),
    },
  }));

  await publishStatus(editProjectId, {
    status: 'published',
    percent: 100,
    renderId,
    publishedUuid,
  });

  return {
    ...event,
    publishedUuid,
    publishedExecutionArn: executionArn,
  };
};
