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
const TEMPLATES_PREFIX = '_mc_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TEMPLATE = 'mp4_landscape';
const AUDIO_SOURCE_NAME = 'Audio Selector 1';
const CAPTION_SOURCE_NAME = 'Captions Selector 1';
const SUBTITLE_PREFIX = 'transcode/subtitle';

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

function buildHighlightInputs(sourceUri, segments, perClipCaptionSelectors) {
  return segments.map((seg, idx) => {
    const input = {
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
    };
    const sel = perClipCaptionSelectors && perClipCaptionSelectors[idx];
    if (sel && Object.keys(sel).length > 0) {
      input.CaptionSelectors = sel;
    }
    return input;
  });
}

function buildSingleInput(sourceUri, captionSelectors) {
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

function srtTimestampToSeconds(ts) {
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(ts.trim());
  if (!m) return NaN;
  return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + (Number(m[4]) / 1000);
}

function secondsToSrtTimestamp(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function parseSrt(srtText) {
  const blocks = srtText.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    if (lines.length < 2) continue;
    const tsLine = lines[1];
    const m = /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/.exec(tsLine);
    if (!m) continue;
    const start = srtTimestampToSeconds(m[1]);
    const end = srtTimestampToSeconds(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    cues.push({ start, end, text: lines.slice(2).join('\n') });
  }
  return cues;
}

function frameAlignedSec(sec, fps = FPS) {
  return Math.round(Math.max(0, sec) * fps) / fps;
}

const ONE_FRAME_SEC = 1 / FPS;
// MediaConvert drops cues whose start equals the InputClipping start (the
// window check is exclusive on the lower edge). Nudge any cue that starts
// at-or-before the window start one frame inside.
const CUE_LEAD_SEC = ONE_FRAME_SEC * 1.5;

// MediaConvert's BurninDestinationSettings.Width is a positioning bounding
// box, not a word-wrap directive — long lines still overflow. Pre-wrap in
// JS using width units (CJK = 2, Latin = 1) so the rendered text fits.
const WRAP_MAX_LINES = 2;
const WRAP_DEFAULT = 22;
const WRAP_PER_TEMPLATE = {
  mp4_portrait: 16,
  mp4_landscape: 28,
};

function charWidthUnits(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
  ) return 2;
  return 1;
}

// Kinsoku: punctuation that must not appear at the *start* of a line.
// If the next-line first char would be one of these, pull it onto the
// previous line (over budget by one char is fine — looks better than an
// orphan comma).
const NO_LINE_START = new Set([
  ',', '.', '!', '?', ':', ';', ')', ']', '}', '"', "'", '”', '’',
  '，', '。', '、', '！', '？', '：', '；', '）', '］', '｝', '」', '』', '〉', '》', '〕', '〗', '〙', '〛',
  '…', '‥', '·', '・', '°', '％', '％', '‰',
]);

function wrapCueText(text, maxUnits, maxLines = WRAP_MAX_LINES) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const chars = Array.from(flat);
  const lines = [];
  let i = 0;
  while (i < chars.length && lines.length < maxLines) {
    let used = 0;
    let j = i;
    while (j < chars.length) {
      const w = charWidthUnits(chars[j]);
      if (used + w > maxUnits) break;
      used += w;
      j += 1;
    }
    if (j === i) j = i + 1; // always advance at least one char
    // Pull trailing kinsoku punctuation onto this line so it doesn't
    // start the next one. Allow a small overflow.
    while (j < chars.length && NO_LINE_START.has(chars[j])) j += 1;
    lines.push(chars.slice(i, j).join(''));
    i = j;
  }
  return lines.join('\n');
}

// MediaConvert keeps SRT timestamps on the source timeline and filters cues
// by the InputClipping window. Cues whose start falls *before* the window
// silently drop. The window edges must match what InputClipping actually
// uses — secondsToTimecode rounds to the nearest frame, so clamp to the
// same frame-aligned values, not the raw seg.startSec/endSec.
function sliceSrtToWindow(cues, startSec, endSec, wrapUnits) {
  const winStart = frameAlignedSec(startSec);
  const winEnd = frameAlignedSec(endSec);
  const minStart = winStart + CUE_LEAD_SEC;
  const out = [];
  let counter = 1;
  for (const cue of cues) {
    if (cue.end <= winStart || cue.start >= winEnd) continue;
    const start = Math.max(cue.start, minStart);
    const end = Math.max(start + 0.05, Math.min(cue.end, winEnd));
    out.push(
      `${counter}`,
      `${secondsToSrtTimestamp(start)} --> ${secondsToSrtTimestamp(end)}`,
      wrapCueText(cue.text, wrapUnits),
      ''
    );
    counter += 1;
  }
  return out.join('\n');
}

// MediaConvert rejects the job if an output references a CaptionSelector
// the input doesn't have. For windows with no overlapping cue, emit a
// 1-frame placeholder timed *inside* the clip window so the selector binds.
function placeholderSrt(startSec) {
  const a = secondsToSrtTimestamp(startSec);
  const b = secondsToSrtTimestamp(startSec + 0.04);
  return `1\n${a} --> ${b}\n \n`;
}

async function buildPerClipCaptionSelectors(proxyBucket, outputBaseKey, snapshotKey, segments, templateName) {
  const wrapUnits = WRAP_PER_TEMPLATE[templateName] || WRAP_DEFAULT;
  const buf = await CommonUtils.download(proxyBucket, snapshotKey);
  const cues = parseSrt(buf.toString('utf8'));
  const selectors = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const startSec = Number(seg.startSec);
    const endSec = Number(seg.endSec);
    const sliced = sliceSrtToWindow(cues, startSec, endSec, wrapUnits);
    const body = sliced.trim() ? sliced : placeholderSrt(frameAlignedSec(startSec));
    const clipKey = `${outputBaseKey}/captions-${i}.srt`;
    await CommonUtils.upload({
      Bucket: proxyBucket,
      Key: clipKey,
      Body: body,
      ContentType: 'application/x-subrip',
    });
    selectors.push({
      [CAPTION_SOURCE_NAME]: {
        SourceSettings: {
          SourceType: 'SRT',
          FileSourceSettings: {
            SourceFile: `s3://${proxyBucket}/${clipKey}`,
          },
        },
      },
    });
  }
  return selectors;
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
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .forEach(([k, v], i) => {
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
  if (editProject.mode === 'highlights' || editProject.mode === 'full') {
    return editProject.mode;
  }
  if (Array.isArray(editProject.segments) && editProject.segments.some(
    (s) => Number(s.endSec) > Number(s.startSec)
  )) {
    return 'highlights';
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
  const burnSubtitles = !!editProject.burnSubtitles;
  const fontScript = editProject.fontScript || 'HANT';
  const logos = editProject.logos || {};

  let captionSnapshot;
  let sharedCaptionSelectors;
  if (burnSubtitles) {
    captionSnapshot = await snapshotSrt(proxyBucket, editProject.uuid, outputBaseKey);
    if (captionSnapshot) {
      sharedCaptionSelectors = {
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
    let perClipSelectors;
    if (hasSubtitles) {
      perClipSelectors = await buildPerClipCaptionSelectors(
        proxyBucket,
        outputBaseKey,
        captionSnapshot.snapshotKey,
        segments,
        templateName
      );
    }
    inputs = buildHighlightInputs(sourceUri, segments, perClipSelectors);
  } else {
    inputs = buildSingleInput(sourceUri, sharedCaptionSelectors);
  }

  const outputGroups = applyTemplate(template, {
    hlsDestination,
    mp4Destination,
    fontScript,
    captionSourceName: CAPTION_SOURCE_NAME,
    hasSubtitles,
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
    burnSubtitles: hasSubtitles,
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
    burnSubtitles: hasSubtitles,
    template: templateName,
    mode,
    destinationPrefix,
    mediaConvertParams,
  };
};
