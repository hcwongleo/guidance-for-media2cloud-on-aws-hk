// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const FS = require('node:fs');
const PATH = require('node:path');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
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
  'ENV_PROXY_BUCKET',
  'ENV_INGEST_TABLE',
  'ENV_EDIT_PROJECTS_TABLE',
  'ENV_RENDERS_TABLE',
  'ENV_DATA_ACCESS_ROLE',
];

const FPS = 25;
const TEMPLATES_PREFIX = '_render_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SUPPORTED_TEMPLATES = ['mp4_landscape', 'mp4_portrait'];
const DEFAULT_TEMPLATE = 'mp4_landscape';
const AUDIO_SOURCE_NAME = 'Audio Selector 1';

function ddb() {
  const client = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function secondsToTimecode(seconds, fps = FPS) {
  const total = Math.max(0, Number(seconds) || 0);
  const totalFrames = Math.round(total * fps);
  const f = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return [h, m, s, f]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function buildInputs(sourceUri, segments) {
  return segments.map((seg) => ({
    FileInput: sourceUri,
    InputClippings: [
      {
        StartTimecode: secondsToTimecode(seg.startSec),
        EndTimecode: secondsToTimecode(seg.endSec),
      },
    ],
    TimecodeSource: 'ZEROBASED',
    VideoSelector: {
      ColorSpace: 'FOLLOW',
      Rotate: 'AUTO',
    },
    AudioSelectors: {
      [AUDIO_SOURCE_NAME]: {
        DefaultSelection: 'DEFAULT',
        Offset: 0,
      },
    },
    FilterEnable: 'AUTO',
    PsiControl: 'USE_PSI',
    DeblockFilter: 'DISABLED',
    DenoiseFilter: 'DISABLED',
  }));
}

async function loadEditProject(table, editProjectId) {
  const doc = ddb();
  const res = await doc.send(new GetCommand({
    TableName: table,
    Key: { editProjectId },
  }));
  if (!res || !res.Item) {
    throw new M2CException(`EditProject not found: ${editProjectId}`);
  }
  return res.Item;
}

async function loadIngestRow(table, uuid) {
  const doc = ddb();
  const res = await doc.send(new GetCommand({
    TableName: table,
    Key: { uuid },
  }));
  if (!res || !res.Item) {
    throw new M2CException(`Ingest record not found: ${uuid}`);
  }
  return res.Item;
}

// Mirrors publishOp._resolveSourceUri: prefer the originally ingested file so
// MediaConvert isn't asked to upscale a downscaled aiml proxy. Fall back to a
// "prod" mp4 proxy if no original is on the row; never the aiml inference proxy.
function resolveSourceUri(ingestRow, proxyBucket) {
  if (ingestRow && ingestRow.bucket && ingestRow.key) {
    return `s3://${ingestRow.bucket}/${ingestRow.key}`;
  }
  const proxies = (ingestRow || {}).proxies || [];
  const videoProxies = proxies.filter((p) =>
    p && p.type === 'video' && (p.key || '').toLowerCase().endsWith('.mp4'));
  const prod = videoProxies.find((p) => p.outputType === 'prod');
  if (prod && prod.key) {
    return `s3://${proxyBucket}/${prod.key}`;
  }
  throw new M2CException('cannot resolve source video for render');
}

async function loadTemplate(proxyBucket, name) {
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new M2CException(`invalid template name: ${name}`);
  }
  // S3 override (uploaded via API) wins over the packaged built-in.
  const s3Key = `${TEMPLATES_PREFIX}/${name}.json`;
  const exists = await CommonUtils.headObject(proxyBucket, s3Key).catch(() => undefined);
  if (exists) {
    const buf = await CommonUtils.download(proxyBucket, s3Key);
    return JSON.parse(buf.toString('utf8'));
  }
  const file = PATH.join(__dirname, 'tmpl', `${name}.json`);
  if (!FS.existsSync(file)) {
    throw new M2CException(`template not found: ${name}`);
  }
  return JSON.parse(FS.readFileSync(file, 'utf8'));
}

function applyTemplate(template, mp4Destination) {
  // Deep clone before mutating; the loaded template may be a packaged JSON
  // we don't want to keep mutating across warm invocations.
  const groups = JSON.parse(JSON.stringify(template.OutputGroups || []));
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new M2CException('template must have non-empty OutputGroups');
  }
  groups.forEach((og) => {
    const settings = og.OutputGroupSettings || {};
    if (settings.Type === 'FILE_GROUP_SETTINGS' && settings.FileGroupSettings) {
      settings.FileGroupSettings.Destination = mp4Destination;
    }
    (og.Outputs || []).forEach((o) => {
      (o.AudioDescriptions || []).forEach((a) => {
        if (a.AudioSourceName === '##AUDIO_SOURCE##') {
          a.AudioSourceName = AUDIO_SOURCE_NAME;
        }
      });
    });
  });
  return groups;
}

async function persistRenderRow(table, renderId, attrs) {
  const doc = ddb();
  const names = {};
  const values = {};
  const sets = [];
  Object.entries(attrs).forEach(([k, v], i) => {
    const nk = `#k${i}`;
    const vk = `:v${i}`;
    names[nk] = k;
    values[vk] = v;
    sets.push(`${nk} = ${vk}`);
  });
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: { renderId },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const proxyBucket = process.env.ENV_PROXY_BUCKET;
  const ingestTable = process.env.ENV_INGEST_TABLE;
  const editTable = process.env.ENV_EDIT_PROJECTS_TABLE;
  const rendersTable = process.env.ENV_RENDERS_TABLE;
  const roleArn = process.env.ENV_DATA_ACCESS_ROLE;
  const solutionUuid = process.env.ENV_SOLUTION_UUID;

  const editProjectId = event.editProjectId;
  if (!editProjectId) {
    throw new M2CException('editProjectId is required');
  }

  const editProject = await loadEditProject(editTable, editProjectId);
  const segments = (editProject.segments || []).filter(
    (s) => Number(s.endSec) > Number(s.startSec)
  );
  if (segments.length === 0) {
    throw new M2CException('edit project has no usable segments');
  }

  const ingestRow = await loadIngestRow(ingestTable, editProject.uuid);
  const sourceUri = resolveSourceUri(ingestRow, proxyBucket);

  // Use the renderId minted by the API at POST time (it pre-created the row
  // with status='queued' so the webapp could poll). Falling back to a fresh
  // uuid would orphan that row and produce duplicate render entries.
  const renderId = event.renderId || CRYPTO.randomUUID();
  const startedAt = new Date().toISOString();
  const destinationPrefix = `s3://${proxyBucket}/renders/${editProject.uuid}/${renderId}/`;
  const mp4Destination = `${destinationPrefix}mp4/`;

  // Template precedence: SFN event > editProject row > default. Persisted on the
  // editProject row so re-renders pick up the same orientation by default.
  const templateName = event.template
    || editProject.template
    || DEFAULT_TEMPLATE;
  if (!TEMPLATE_NAME_RE.test(templateName)) {
    throw new M2CException(`invalid template name: ${templateName}`);
  }
  const template = await loadTemplate(proxyBucket, templateName);

  const outputGroups = applyTemplate(template, mp4Destination);

  const mediaConvertParams = {
    Role: roleArn,
    UserMetadata: {
      solutionUuid: solutionUuid || '',
      m2cUuid: editProject.uuid,
      m2cEditProjectId: editProjectId,
      m2cRenderId: renderId,
      m2cTemplate: templateName,
    },
    StatusUpdateInterval: 'SECONDS_12',
    AccelerationSettings: { Mode: 'DISABLED' },
    BillingTagsSource: 'JOB',
    Settings: {
      AdAvailOffset: 0,
      Inputs: buildInputs(sourceUri, segments),
      OutputGroups: outputGroups,
    },
  };

  await persistRenderRow(rendersTable, renderId, {
    editProjectId,
    uuid: editProject.uuid,
    status: 'composing',
    publishToLibrary: !!editProject.publishToLibrary,
    aspectRatio: editProject.aspectRatio || '16:9',
    burnCaptions: !!editProject.burnCaptions,
    segmentCount: segments.length,
    template: templateName,
    sourceUri,
    destinationPrefix,
    startedAt,
    updatedAt: startedAt,
  });

  return {
    renderId,
    editProjectId,
    uuid: editProject.uuid,
    publishToLibrary: !!editProject.publishToLibrary,
    aspectRatio: editProject.aspectRatio || '16:9',
    burnCaptions: !!editProject.burnCaptions,
    template: templateName,
    destinationPrefix,
    mediaConvertParams,
  };
};
