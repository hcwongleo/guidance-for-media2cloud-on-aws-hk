// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  MediaConvertClient,
  GetJobCommand,
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

// Map MediaConvert phase/status → our internal status.
const TERMINAL_OK = new Set(['COMPLETE']);
const TERMINAL_ERR = new Set(['ERROR', 'CANCELED']);

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

function deriveOutputs(job, destinationPrefix) {
  // MediaConvert reports output paths via Settings.OutputGroups[].Outputs[].
  // We surface the destinations the job was configured with — the actual
  // file names follow the NameModifier convention (`*_proxy.mp4`, `*_1080p.m3u8`).
  const groups = ((job.Settings || {}).OutputGroups || []);
  const outputs = {};
  groups.forEach((og) => {
    const settings = og.OutputGroupSettings || {};
    if (settings.Type === 'FILE_GROUP_SETTINGS' && settings.FileGroupSettings) {
      outputs.mp4 = settings.FileGroupSettings.Destination;
    } else if (settings.Type === 'HLS_GROUP_SETTINGS' && settings.HlsGroupSettings) {
      outputs.hls = settings.HlsGroupSettings.Destination;
    }
  });
  if (!outputs.mp4 && destinationPrefix) {
    outputs.mp4 = `${destinationPrefix}mp4/`;
  }
  if (!outputs.hls && destinationPrefix) {
    outputs.hls = `${destinationPrefix}hls/`;
  }
  return outputs;
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
    mediaConvertJobId,
    destinationPrefix,
  } = event;

  if (!renderId || !mediaConvertJobId) {
    throw new M2CException('renderId and mediaConvertJobId required');
  }

  const mc = mediaConvert(mcHost);
  const res = await mc.send(new GetJobCommand({ Id: mediaConvertJobId }));
  const job = (res || {}).Job || {};

  const phase = job.Status || 'UNKNOWN';
  const percent = Number(job.JobPercentComplete || 0);
  const errorMessage = job.ErrorMessage;

  let status = 'progressing';
  let isDone = false;
  if (TERMINAL_OK.has(phase)) {
    status = 'completed';
    isDone = true;
  } else if (TERMINAL_ERR.has(phase)) {
    status = 'error';
    isDone = true;
  }

  const outputs = isDone && status === 'completed'
    ? deriveOutputs(job, destinationPrefix)
    : undefined;

  const finishedAt = isDone ? new Date().toISOString() : undefined;

  const update = {
    TableName: rendersTable,
    Key: { renderId },
    UpdateExpression: 'SET #s = :s, percent = :p',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s': status,
      ':p': percent,
    },
  };
  if (errorMessage) {
    update.UpdateExpression += ', errorMessage = :e';
    update.ExpressionAttributeValues[':e'] = errorMessage;
  }
  if (outputs) {
    update.UpdateExpression += ', outputs = :o';
    update.ExpressionAttributeValues[':o'] = outputs;
  }
  if (finishedAt) {
    update.UpdateExpression += ', finishedAt = :t';
    update.ExpressionAttributeValues[':t'] = finishedAt;
  }
  await ddb().send(new UpdateCommand(update));

  await publishStatus(editProjectId, {
    status,
    percent,
    mediaConvertJobId,
    renderId,
    ...(errorMessage ? { errorMessage } : {}),
    ...(outputs ? { outputs } : {}),
  });

  return {
    ...event,
    status,
    percent,
    isDone,
    outputs,
    errorMessage,
  };
};
