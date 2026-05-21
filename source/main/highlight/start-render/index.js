// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  MediaConvertClient,
  CreateJobCommand,
} = require('@aws-sdk/client-mediaconvert');
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
  'ENV_MEDIACONVERT_HOST',
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

function mediaConvert(host) {
  let endpoint = host;
  if (endpoint && endpoint.indexOf('https://') < 0) {
    endpoint = `https://${endpoint}`;
  }
  return xraysdkHelper(new MediaConvertClient({
    customUserAgent: CustomUserAgent,
    endpoint,
    retryStrategy: retryStrategyHelper(),
  }));
}

async function publishStatus(editProjectId, payload) {
  // Publish on the shared global status topic so the existing webapp
  // subscriber receives it. `type: 'render'` is the discriminator.
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

exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const rendersTable = process.env.ENV_RENDERS_TABLE;
  const mcHost = process.env.ENV_MEDIACONVERT_HOST;

  const {
    renderId,
    editProjectId,
    uuid,
    mediaConvertParams,
    publishToLibrary,
    aspectRatio,
    burnSubtitles,
    destinationPrefix,
  } = event;

  if (!renderId || !editProjectId || !mediaConvertParams) {
    throw new M2CException('renderId, editProjectId, and mediaConvertParams required');
  }

  const mc = mediaConvert(mcHost);
  const submittedAt = new Date().toISOString();

  let mediaConvertJobId;
  try {
    const res = await mc.send(new CreateJobCommand(mediaConvertParams));
    mediaConvertJobId = ((res || {}).Job || {}).Id;
    if (!mediaConvertJobId) {
      throw new M2CException('CreateJob returned no job id');
    }
  } catch (e) {
    console.error('CreateJob failed:', e && e.message);
    const doc = ddb();
    await doc.send(new UpdateCommand({
      TableName: rendersTable,
      Key: { renderId },
      UpdateExpression: 'SET #s = :s, errorMessage = :e, finishedAt = :t',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'error',
        ':e': (e && e.message) || 'CreateJob failed',
        ':t': submittedAt,
      },
    }));
    await publishStatus(editProjectId, {
      status: 'error',
      percent: 0,
      mediaConvertJobId: null,
      renderId,
      errorMessage: (e && e.message) || 'CreateJob failed',
    });
    throw e;
  }

  const doc = ddb();
  await doc.send(new UpdateCommand({
    TableName: rendersTable,
    Key: { renderId },
    UpdateExpression: 'SET #s = :s, mediaConvertJobId = :j, submittedAt = :t',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s': 'submitted',
      ':j': mediaConvertJobId,
      ':t': submittedAt,
    },
  }));

  await publishStatus(editProjectId, {
    status: 'submitted',
    percent: 0,
    mediaConvertJobId,
    renderId,
  });

  return {
    renderId,
    editProjectId,
    uuid,
    mediaConvertJobId,
    publishToLibrary: !!publishToLibrary,
    aspectRatio,
    burnSubtitles: !!burnSubtitles,
    destinationPrefix,
  };
};
