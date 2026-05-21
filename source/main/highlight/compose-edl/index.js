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
// Shared MediaConvert template store; the api Lambda's /mc-templates endpoint
// writes here, and outputOp reads from the same prefix.
const TEMPLATES_PREFIX = '_mc_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SUPPORTED_TEMPLATES = ['mp4_landscape', 'mp4_portrait'];
const DEFAULT_TEMPLATE = 'mp4_landscape';
const AUDIO_SOURCE_NAME = 'Audio Selector 1';
const CAPTION_SOURCE_NAME = 'Captions Selector 1';
const SUBTITLE_PREFIX = 'transcode/subtitle';
// Empty string is the documented sentinel for "no logo at this size"; stripping
// the InsertableImage in that case prevents MediaConvert from refusing the job.
const LOGO_SIZES = ['48', '64', '96', '128', '192'];

const PUBLISH_CLOUDFRONT_DOMAIN = process.env.ENV_PUBLISH_CLOUDFRONT_DOMAIN || '';

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

function buildHighlightInputs(sourceUri, segments) {
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

function buildSingleInput(sourceUri, inputClipping, captionSelectors) {
  const input = {
    FileInput: sourceUri,
    TimecodeSource: 'ZEROBASED',
    VideoSelector: {
      AlphaBehavior: 'DISCARD',
      ColorSpace: 'FOLLOW',
      Rotate: 'DEGREE_0',
    },
    AudioSelectors: {
      [AUDIO_SOURCE_NAME]: {
        Offset: 0,
        DefaultSelection: 'DEFAULT',
        ProgramSelection: 1,
      },
    },
    FilterEnable: 'AUTO',
    PsiControl: 'USE_PSI',
    FilterStrength: 0,
    DeblockFilter: 'DISABLED',
    DenoiseFilter: 'DISABLED',
  };
  if (inputClipping
    && inputClipping.StartTimecode
    && inputClipping.EndTimecode) {
    input.InputClippings = [{
      StartTimecode: inputClipping.StartTimecode,
      EndTimecode: inputClipping.EndTimecode,
    }];
  }
  if (captionSelectors && Object.keys(captionSelectors).length > 0) {
    input.CaptionSelectors = captionSelectors;
  }
  return [input];
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

// Use the originally ingested file when available so MediaConvert isn't asked
// to upscale a downscaled aiml inference proxy. Fall back to a "prod" mp4
// proxy if the original is gone; never the aiml proxy.
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

async function resolveSrtKey(proxyBucket, uuid) {
  const editedKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}_edited.srt`;
  const plainKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}.srt`;
  let exists = await CommonUtils.headObject(proxyBucket, editedKey).catch(() => undefined);
  if (exists) return editedKey;
  exists = await CommonUtils.headObject(proxyBucket, plainKey).catch(() => undefined);
  if (exists) return plainKey;
  return undefined;
}

// Snapshot the chosen SRT into the output folder so the MediaConvert job is
// self-contained — later Reset / Save / AI Edit cannot yank the file out from
// under an in-flight job (was the cause of MediaConvert error 1040).
async function snapshotSrt(proxyBucket, uuid, outputBaseKey) {
  const srcKey = await resolveSrtKey(proxyBucket, uuid);
  if (!srcKey) return undefined;
  const destKey = `${outputBaseKey}/captions.srt`;
  await CommonUtils.copyObject(
    `${proxyBucket}/${srcKey}`,
    proxyBucket,
    destKey
  );
  return {
    uri: `s3://${proxyBucket}/${destKey}`,
    sourceKey: srcKey,
    snapshotKey: destKey,
    origin: srcKey.endsWith('_edited.srt') ? 'edited' : 'original',
  };
}

// SMART_CROP + ImageInserter requires HTTP(S) URLs — s3:// silently fails
// with warning 250000. We front the bucket via the publish CloudFront
// distribution and convert s3://<ProxyBucket>/<key> → https://<cf>/<key>.
function toCloudFrontUrl(uri, proxyBucket) {
  if (!PUBLISH_CLOUDFRONT_DOMAIN
    || typeof uri !== 'string'
    || !uri.startsWith('s3://')) {
    return uri;
  }
  const rest = uri.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return uri;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (bucket !== proxyBucket) return uri;
  return `https://${PUBLISH_CLOUDFRONT_DOMAIN}/${key}`;
}

function applyTemplate(template, opts) {
  const {
    hlsDestination,
    mp4Destination,
    fontScript,
    captionSourceName,
    hasSubtitles,
    logos,
    proxyBucket,
  } = opts;

  const groups = JSON.parse(JSON.stringify(template.OutputGroups || []));
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new M2CException('template must have non-empty OutputGroups');
  }

  groups.forEach((og) => {
    const settings = og.OutputGroupSettings || {};
    if (settings.Type === 'HLS_GROUP_SETTINGS' && settings.HlsGroupSettings) {
      settings.HlsGroupSettings.Destination = hlsDestination;
    } else if (settings.Type === 'FILE_GROUP_SETTINGS' && settings.FileGroupSettings) {
      settings.FileGroupSettings.Destination = mp4Destination;
    }

    (og.Outputs || []).forEach((o) => {
      (o.AudioDescriptions || []).forEach((a) => {
        if (a.AudioSourceName === '##AUDIO_SOURCE##') {
          a.AudioSourceName = AUDIO_SOURCE_NAME;
        }
      });

      if (hasSubtitles) {
        (o.CaptionDescriptions || []).forEach((c) => {
          if (c.CaptionSelectorName === '##CAPTION_SOURCE##') {
            c.CaptionSelectorName = captionSourceName;
          }
          const burn = (c.DestinationSettings || {}).BurninDestinationSettings;
          if (burn && burn.FontScript === '##FONT_SCRIPT##') {
            burn.FontScript = fontScript;
          }
        });
      } else {
        delete o.CaptionDescriptions;
      }

      const inserter = ((o.VideoDescription || {}).VideoPreprocessors || {}).ImageInserter;
      if (inserter && Array.isArray(inserter.InsertableImages)) {
        const resolved = [];
        inserter.InsertableImages.forEach((img) => {
          const m = (img.ImageInserterInput || '').match(/^##LOGO_(\d+)##$/);
          if (!m) {
            resolved.push(img);
            return;
          }
          const size = m[1];
          if (logos && logos[size]) {
            resolved.push({
              ...img,
              ImageInserterInput: toCloudFrontUrl(logos[size], proxyBucket),
            });
          }
        });
        if (resolved.length > 0) {
          inserter.InsertableImages = resolved;
        } else {
          delete o.VideoDescription.VideoPreprocessors.ImageInserter;
          if (Object.keys(o.VideoDescription.VideoPreprocessors).length === 0) {
            delete o.VideoDescription.VideoPreprocessors;
          }
        }
      }
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

function deriveMode(editProject) {
  if (editProject.mode && ['full', 'trim', 'highlights'].includes(editProject.mode)) {
    return editProject.mode;
  }
  if (Array.isArray(editProject.segments) && editProject.segments.some(
    (s) => Number(s.endSec) > Number(s.startSec)
  )) {
    return 'highlights';
  }
  if (editProject.inputClipping
    && editProject.inputClipping.StartTimecode
    && editProject.inputClipping.EndTimecode) {
    return 'trim';
  }
  return 'full';
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
  const ingestRow = await loadIngestRow(ingestTable, editProject.uuid);
  const sourceUri = resolveSourceUri(ingestRow, proxyBucket);

  const renderId = event.renderId || CRYPTO.randomUUID();
  const startedAt = new Date().toISOString();
  const outputBaseKey = `${editProject.uuid}/output/${renderId}`;
  const destinationPrefix = `s3://${proxyBucket}/${outputBaseKey}/`;
  const hlsDestination = `${destinationPrefix}hls/`;
  const mp4Destination = `${destinationPrefix}mp4/`;

  const templateName = event.template
    || editProject.template
    || DEFAULT_TEMPLATE;
  if (!TEMPLATE_NAME_RE.test(templateName)) {
    throw new M2CException(`invalid template name: ${templateName}`);
  }
  const template = await loadTemplate(proxyBucket, templateName);

  const mode = deriveMode(editProject);
  const burnSubtitles = !!(editProject.burnSubtitles || editProject.burnCaptions);
  const fontScript = editProject.fontScript || 'HANT';
  const logos = editProject.logos || {};

  let captionSnapshot;
  let captionSelectors;
  if (burnSubtitles) {
    captionSnapshot = await snapshotSrt(proxyBucket, editProject.uuid, outputBaseKey);
    if (captionSnapshot) {
      captionSelectors = {
        [CAPTION_SOURCE_NAME]: {
          SourceSettings: {
            SourceType: 'SRT',
            FileSourceSettings: {
              SourceFile: captionSnapshot.uri,
            },
          },
        },
      };
    }
  }
  const hasSubtitles = !!captionSnapshot;

  let inputs;
  if (mode === 'highlights') {
    const segments = (editProject.segments || []).filter(
      (s) => Number(s.endSec) > Number(s.startSec)
    );
    if (segments.length === 0) {
      throw new M2CException('highlights mode requires at least one segment');
    }
    inputs = buildHighlightInputs(sourceUri, segments);
    // Highlights mode is N inputs each with their own InputClippings; SRT
    // burn-in across re-stitched segments is not currently supported because
    // captions would need re-timing per clip. Strip captions in this mode.
    if (hasSubtitles) {
      console.warn('highlights mode does not support caption burn-in; ignoring');
    }
    inputs.forEach((i) => { delete i.CaptionSelectors; });
  } else if (mode === 'trim') {
    inputs = buildSingleInput(sourceUri, editProject.inputClipping, captionSelectors);
  } else {
    inputs = buildSingleInput(sourceUri, undefined, captionSelectors);
  }

  const outputGroups = applyTemplate(template, {
    hlsDestination,
    mp4Destination,
    fontScript,
    captionSourceName: CAPTION_SOURCE_NAME,
    hasSubtitles: mode === 'highlights' ? false : hasSubtitles,
    logos,
    proxyBucket,
  });

  const mediaConvertParams = {
    Role: roleArn,
    UserMetadata: {
      solutionUuid: solutionUuid || '',
      m2cUuid: editProject.uuid,
      m2cEditProjectId: editProjectId,
      m2cRenderId: renderId,
      m2cTemplate: templateName,
      m2cMode: mode,
    },
    StatusUpdateInterval: 'SECONDS_12',
    AccelerationSettings: { Mode: 'DISABLED' },
    BillingTagsSource: 'JOB',
    Settings: {
      AdAvailOffset: 0,
      FollowSource: 1,
      Inputs: inputs,
      OutputGroups: outputGroups,
    },
  };

  await persistRenderRow(rendersTable, renderId, {
    editProjectId,
    uuid: editProject.uuid,
    status: 'composing',
    publishToLibrary: !!editProject.publishToLibrary,
    aspectRatio: editProject.aspectRatio || '16:9',
    mode,
    burnSubtitles: hasSubtitles && mode !== 'highlights',
    fontScript,
    template: templateName,
    segmentCount: mode === 'highlights' ? inputs.length : 0,
    sourceUri,
    destinationPrefix,
    captionSnapshotKey: (captionSnapshot && captionSnapshot.snapshotKey) || undefined,
    startedAt,
    updatedAt: startedAt,
  });

  return {
    renderId,
    editProjectId,
    uuid: editProject.uuid,
    publishToLibrary: !!editProject.publishToLibrary,
    aspectRatio: editProject.aspectRatio || '16:9',
    burnCaptions: hasSubtitles && mode !== 'highlights',
    template: templateName,
    mode,
    destinationPrefix,
    mediaConvertParams,
  };
};

module.exports.SUPPORTED_TEMPLATES = SUPPORTED_TEMPLATES;
module.exports.DEFAULT_TEMPLATE = DEFAULT_TEMPLATE;
module.exports.LOGO_SIZES = LOGO_SIZES;
