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

const DEFAULT_VLM_MODEL = 'us.twelvelabs.pegasus-1-2-v1:0';
const MIN_HIGHLIGHT_SEC = 5;
const MAX_HIGHLIGHT_SEC = 60;

// MediaConvert split jobs: stream-copy is fast (couple of minutes) but
// its progress is reported sparsely. Poll every 10s up to ~12min so we
// stay inside the lambda's 15-min budget.
const MC_POLL_INTERVAL_MS = 10 * 1000;
const MC_POLL_MAX_TRIES = 72;

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

// Stream-copy split: input.InputClippings carves [start, end), single MP4
// output passes both video + audio through (-c copy) so the cut is fast and
// preserves the original codec Pegasus already accepts.
function buildSplitJobSpec({ roleArn, srcBucket, srcKey, dstBucket, dstPrefix, startSec, endSec, accountId }) {
  const startTimecode = secondsToTimecode(startSec);
  const endTimecode = secondsToTimecode(endSec);
  return {
    Role: roleArn,
    UserMetadata: {
      m2c_purpose: 'pegasus-chunk',
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
          StartTimecode: startTimecode,
          EndTimecode: endTimecode,
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
  // MediaConvert clipping accepts HH:MM:SS:FF; FF=00 is fine for stream-copy
  // since the actual cut snaps to the nearest IDR frame anyway.
  const total = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return [hh, mm, ss, 0].map((n) => String(n).padStart(2, '0')).join(':');
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
      throw new M2CException(`split job failed: ${reason}`);
    }
    await sleep(MC_POLL_INTERVAL_MS);
  }
  throw new M2CException(`split job did not complete within ${(MC_POLL_INTERVAL_MS * MC_POLL_MAX_TRIES) / 1000}s`);
}

function buildVideoPrompt(maxSegments, customPrompt, totalDurationSec, transcriptText) {
  const hasTranscript = transcriptText && transcriptText.length > 0;
  const lines = [
    'You are a video editor selecting the most engaging moments from a video for short-form highlights.',
    `You are given a ${Math.round(totalDurationSec)}-second video${hasTranscript ? ', along with the spoken transcript' : ''}.`,
    `Pick up to ${maxSegments} non-overlapping highlight segments based on ${hasTranscript ? 'what you see and what is said' : 'what you see in the video'}.`,
    'STRICT RULES — failures here are unusable:',
    '- Each segment MUST be at least 5000 milliseconds and at most 60000 milliseconds long (endMs - startMs).',
    '- Do NOT emit 1-second clips. Do NOT emit clips that span most of the video.',
    '- Segments must NOT touch or overlap: each segment\'s startMs must be strictly greater than the previous segment\'s endMs.',
    '- Center each segment on the moment of interest; if the moment is brief, pad with surrounding context to reach at least 5 seconds.',
    'Report timestamps in milliseconds from the start of THIS video clip (not the original).',
  ];
  if (customPrompt && customPrompt.length > 0) {
    lines.push('Additional guidance from the user:');
    lines.push(customPrompt);
  }
  lines.push('Respond ONLY with valid JSON in this shape:');
  lines.push('{"highlights":[{"title":"<short>","reason":"<why it matters>","startMs":<int>,"endMs":<int>}]}');
  if (hasTranscript) {
    lines.push('');
    lines.push('Transcript:');
    lines.push(transcriptText);
  }
  return lines.join('\n');
}

function secondsToTimecodeFps(seconds, fps = 25) {
  const totalFrames = Math.round(seconds * fps);
  const ff = totalFrames % fps;
  let s = Math.floor(totalFrames / fps);
  const hh = Math.floor(s / 3600);
  s -= hh * 3600;
  const mm = Math.floor(s / 60);
  const ss = s - mm * 60;
  return [hh, mm, ss, ff].map((n) => String(n).padStart(2, '0')).join(':');
}

function parseSegments(rawText, chunkDurationSec, chunkStartOffsetSec) {
  let text = rawText.trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    throw new M2CException('VLM response did not contain JSON');
  }
  const json = JSON.parse(text.slice(first, last + 1));
  if (!Array.isArray(json.highlights)) {
    throw new M2CException('VLM response missing highlights[]');
  }

  const out = [];
  for (let i = 0; i < json.highlights.length; i += 1) {
    const h = json.highlights[i];
    const startMs = Number(h.startMs);
    const endMs = Number(h.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      console.log(`=== chunk segment #${i + 1} bad timestamps: start=${h.startMs} end=${h.endMs}`);
      continue;
    }
    let startSec = Math.max(0, startMs / 1000);
    let endSec = Math.min(chunkDurationSec, endMs / 1000);
    let duration = endSec - startSec;
    if (duration < MIN_HIGHLIGHT_SEC) {
      const mid = (startSec + endSec) / 2;
      startSec = Math.max(0, mid - MIN_HIGHLIGHT_SEC / 2);
      endSec = Math.min(chunkDurationSec, startSec + MIN_HIGHLIGHT_SEC);
      if (endSec - startSec < MIN_HIGHLIGHT_SEC) {
        startSec = Math.max(0, endSec - MIN_HIGHLIGHT_SEC);
      }
      duration = endSec - startSec;
    }
    if (duration > MAX_HIGHLIGHT_SEC) {
      endSec = startSec + MAX_HIGHLIGHT_SEC;
      duration = MAX_HIGHLIGHT_SEC;
    }
    if (duration < 1) {
      console.log(`=== chunk segment #${i + 1} too short after clamp (${duration}s)`);
      continue;
    }
    // Re-base onto the original-video timeline.
    const absStart = startSec + chunkStartOffsetSec;
    const absEnd = endSec + chunkStartOffsetSec;
    out.push({
      kind: 'highlight',
      title: h.title || `Highlight ${i + 1}`,
      reason: h.reason || '',
      startSec: absStart,
      endSec: absEnd,
      startTimecode: secondsToTimecodeFps(absStart),
      endTimecode: secondsToTimecodeFps(absEnd),
      text: '',
    });
  }
  return out;
}

async function callPegasus({ modelId, region, s3Uri, bucketOwner, prompt }) {
  const client = xraysdkHelper(new BedrockRuntimeClient({
    region,
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
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
    durationSec: chunkDurationSec,
    sourceProxyBucket,
    sourceProxyKey,
    accountId,
    modelId,
    prompt: customPrompt,
    maxSegments = 10,
  } = event;

  if (!uuid || !highlightSetId || sourceProxyKey === undefined || index === undefined) {
    throw new M2CException('uuid, highlightSetId, index, sourceProxyKey required');
  }
  if (!accountId) {
    throw new M2CException('accountId required for Pegasus mediaSource.bucketOwner');
  }

  // 1. MediaConvert split: cut [startSec, endSec) into a chunk MP4 in proxy bucket.
  const chunkPrefix = `${uuid}/_pegasus-chunks/${highlightSetId}/`;
  const chunkBaseName = `chunk-${String(index).padStart(3, '0')}`;
  const dstPrefix = `${chunkPrefix}${chunkBaseName}`;
  const jobSpec = buildSplitJobSpec({
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
  console.log(`=== submitting MC split job for chunk ${index} [${startSec}s-${endSec}s]`);
  const created = await mc.send(new CreateJobCommand(jobSpec));
  const jobId = ((created || {}).Job || {}).Id;
  if (!jobId) {
    throw new M2CException('MediaConvert CreateJob returned no job id');
  }
  console.log(`=== MC split job ${jobId} submitted; polling`);
  await waitForMediaConvert(mc, jobId);
  // MC writes the file as `<dstPrefix>.mp4` because the output has no NameModifier.
  const chunkKey = `${dstPrefix}.mp4`;
  console.log(`=== chunk ${index} ready: s3://${proxyBucket}/${chunkKey}`);

  // 2. Pegasus on the chunk. Use chunk-relative duration in the prompt and
  // add the chunk start offset to every returned segment.
  const resolvedModelId = modelId || DEFAULT_VLM_MODEL;
  const promptText = buildVideoPrompt(maxSegments, customPrompt, chunkDurationSec, '');
  const raw = await callPegasus({
    modelId: resolvedModelId,
    region,
    s3Uri: `s3://${proxyBucket}/${chunkKey}`,
    bucketOwner: String(accountId),
    prompt: promptText,
  });
  console.log(`=== chunk ${index} Pegasus raw (${raw.length}ch): ${raw}`);

  const segments = parseSegments(raw, chunkDurationSec, startSec);
  console.log(`=== chunk ${index} parsed ${segments.length} segments`);

  return {
    index,
    chunkKey,
    startSec,
    endSec,
    segments,
  };
};
