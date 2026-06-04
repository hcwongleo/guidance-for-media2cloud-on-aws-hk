// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  MediaConvertClient,
  CreateJobCommand,
  GetJobCommand,
} = require('@aws-sdk/client-mediaconvert');
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const {
  S3Client,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const {
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
  'ENV_BEDROCK_REGION',
  'ENV_PROXY_BUCKET',
  'ENV_MEDIACONVERT_HOST',
  'ENV_MEDIACONVERT_ROLE_ARN',
];

const FPS = 25;

// MediaConvert stream-copy of a single shot is usually < 1 minute. Poll
// every 5s, up to ~10 min — well within the 15 min lambda budget.
const MC_POLL_INTERVAL_MS = 5 * 1000;
const MC_POLL_MAX_TRIES = 120;

function mediaConvertClient(host) {
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

function bedrockClient(region) {
  return xraysdkHelper(new BedrockRuntimeClient({
    region,
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
}

// Stream-copy single-shot clip: input.InputClippings carves [start, end),
// single MP4 output passes both video + audio through (-c copy).
function buildClipJobSpec({ roleArn, srcBucket, srcKey, dstBucket, dstPrefix, startSec, endSec, accountId }) {
  return {
    Role: roleArn,
    UserMetadata: {
      m2c_purpose: 'pegasus-shot',
    },
    Settings: {
      TimecodeConfig: { Source: 'ZEROBASED' },
      Inputs: [{
        FileInput: `s3://${srcBucket}/${srcKey}`,
        ...(accountId ? { ExpectedBucketOwner: String(accountId) } : {}),
        AudioSelectors: {
          'Audio Selector 1': {
            DefaultSelection: 'DEFAULT',
            SelectorType: 'TRACK',
            Tracks: [1],
          },
        },
        VideoSelector: {},
        InputClippings: [{
          StartTimecode: secondsToTimecode(startSec),
          EndTimecode: secondsToTimecode(endSec),
        }],
        TimecodeSource: 'ZEROBASED',
      }],
      OutputGroups: [{
        Name: 'File Group',
        OutputGroupSettings: {
          Type: 'FILE_GROUP_SETTINGS',
          FileGroupSettings: {
            Destination: `s3://${dstBucket}/${dstPrefix}`,
          },
        },
        Outputs: [{
          ContainerSettings: { Container: 'MP4' },
          VideoDescription: {
            CodecSettings: { Codec: 'PASSTHROUGH' },
          },
          AudioDescriptions: [{
            AudioSourceName: 'Audio Selector 1',
            CodecSettings: {
              Codec: 'AAC',
              AacSettings: {
                Bitrate: 96000,
                CodingMode: 'CODING_MODE_2_0',
                SampleRate: 48000,
              },
            },
          }],
        }],
      }],
    },
  };
}

function secondsToTimecode(seconds) {
  // MediaConvert clipping accepts HH:MM:SS:FF; the front of the cut snaps
  // to the nearest IDR keyframe at-or-before StartTimecode (drift up to one
  // GOP, typically 2-5s). We do not depend on the produced clip's exact
  // start: the shot's authoritative timestamps come from detect-shots and
  // are passed through to the segment we return.
  const total = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return [hh, mm, ss, 0].map((n) => String(n).padStart(2, '0')).join(':');
}

function secondsToTimecodeFps(seconds, fps = FPS) {
  const totalFrames = Math.round(seconds * fps);
  const ff = totalFrames % fps;
  let s = Math.floor(totalFrames / fps);
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  return [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMediaConvert(mc, jobId) {
  for (let i = 0; i < MC_POLL_MAX_TRIES; i += 1) {
    const res = await mc.send(new GetJobCommand({ Id: jobId }));
    const job = (res || {}).Job || {};
    const status = job.Status;
    if (status === 'COMPLETE') {
      return job;
    }
    if (status === 'ERROR' || status === 'CANCELED') {
      const reason = job.ErrorMessage || `MediaConvert ${status}`;
      throw new M2CException(`shot clip job failed: ${reason}`);
    }
    await sleep(MC_POLL_INTERVAL_MS);
  }
  throw new M2CException('shot clip did not complete in time');
}

// Bedrock fetches the S3 video synchronously and rejects with "Provided
// S3Location not found" if the object is not yet visible. MC's
// CompleteMultipartUpload + propagation can lag a few hundred ms behind
// the GetJob COMPLETE we polled.
async function waitForS3Object(bucket, key) {
  const s3 = xraysdkHelper(new S3Client({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  const delays = [0, 500, 1000, 2000, 4000];
  let lastErr;
  for (const wait of delays) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new M2CException(`shot MP4 not visible after retries: s3://${bucket}/${key} (${(lastErr && lastErr.name) || 'unknown'})`);
}

// Pegasus describes the shot — it does NOT score relevance to the user's
// task. Relevance ranking happens later in rank-shots, where a text LLM
// sees all shots together along with their transcript slices and judges
// each against the user prompt.
function buildShotPrompt(shotDurationSec) {
  const lines = [];
  lines.push(`You are watching a ${Math.round(shotDurationSec)}-second video clip.`);
  lines.push('Describe it factually in 1-2 sentences: what is happening visually, who is present, what is being said if anything.');
  lines.push('Use neutral, observational language. Do NOT invent events, names, or numbers you cannot directly see or hear.');
  lines.push('Respond ONLY with valid JSON in this exact shape:');
  lines.push('{"title":"<short label, 3-8 words>","description":"<1-2 factual sentences>"}');
  return lines.join('\n');
}

async function callPegasus({ region, modelId, s3Uri, bucketOwner, prompt }) {
  const client = bedrockClient(region);
  const body = {
    inputPrompt: prompt,
    mediaSource: { s3Location: { uri: s3Uri, bucketOwner } },
  };
  const response = await client.send(new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }));
  const text = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(text);
  const message = (parsed.message || '').trim();
  if (message.length === 0) {
    throw new M2CException('Pegasus returned empty message');
  }
  return message;
}

function parseShotResponse(rawText) {
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new M2CException('Pegasus shot response did not contain JSON');
  }
  const json = JSON.parse(text.slice(first, last + 1));
  return {
    title: (json.title || '').trim(),
    description: (json.description || '').trim(),
  };
}

// Per-shot describe: clip the source proxy to [startSec, endSec], invoke
// Pegasus on the resulting MP4, return a segment with the shot's
// authoritative timestamps and the model's title/description. Relevance
// to the user prompt is judged later in rank-shots (LLM rank pass).
exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const region = process.env.ENV_BEDROCK_REGION;
  const proxyBucket = process.env.ENV_PROXY_BUCKET;
  const mcHost = process.env.ENV_MEDIACONVERT_HOST;
  const mcRoleArn = process.env.ENV_MEDIACONVERT_ROLE_ARN;

  const {
    uuid,
    highlightSetId,
    index,
    startSec,
    endSec,
    sourceProxyBucket,
    sourceProxyKey,
    accountId,
    modelId,
  } = event;

  if (!uuid || !highlightSetId || sourceProxyKey === undefined || index === undefined) {
    throw new M2CException('uuid, highlightSetId, index, sourceProxyKey are required');
  }
  if (!accountId) {
    throw new M2CException('accountId is required for Pegasus mediaSource.bucketOwner');
  }
  if (!modelId) {
    throw new M2CException('modelId is required (no default model)');
  }
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new M2CException(`invalid shot bounds: [${startSec}, ${endSec}]`);
  }

  const shotDurationSec = endSec - startSec;

  // 1. MediaConvert stream-copy: clip [startSec, endSec] into a shot MP4.
  const dstPrefix = `${uuid}/_pegasus-shots/${highlightSetId}/shot-${String(index).padStart(3, '0')}`;
  const jobSpec = buildClipJobSpec({
    roleArn: mcRoleArn,
    srcBucket: sourceProxyBucket || proxyBucket,
    srcKey: sourceProxyKey,
    dstBucket: proxyBucket,
    dstPrefix,
    startSec,
    endSec,
    accountId,
  });

  const mc = mediaConvertClient(mcHost);
  console.log(`=== submitting MC clip for shot ${index} [${startSec}s-${endSec}s]`);
  const created = await mc.send(new CreateJobCommand(jobSpec));
  const jobId = ((created || {}).Job || {}).Id;
  if (!jobId) {
    throw new M2CException('MediaConvert CreateJob returned no job id');
  }
  await waitForMediaConvert(mc, jobId);
  const shotKey = `${dstPrefix}.mp4`;
  console.log(`=== shot ${index} ready: s3://${proxyBucket}/${shotKey}`);

  // 2. Pegasus describes the shot. Race-fix: HEAD-probe the new MP4
  // before the Bedrock call.
  await waitForS3Object(proxyBucket, shotKey);

  const promptText = buildShotPrompt(shotDurationSec);
  const raw = await callPegasus({
    region,
    modelId,
    s3Uri: `s3://${proxyBucket}/${shotKey}`,
    bucketOwner: String(accountId),
    prompt: promptText,
  });
  console.log(`=== shot ${index} raw (${raw.length}ch): ${raw}`);

  const parsed = parseShotResponse(raw);

  return {
    index,
    shotKey,
    shot: {
      index,
      title: parsed.title || `Shot ${index}`,
      description: parsed.description,
      startSec,
      endSec,
      startTimecode: secondsToTimecodeFps(startSec),
      endTimecode: secondsToTimecodeFps(endSec),
    },
  };
};
