// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
const HLS_RESOLUTIONS = [
  { name: '1080p', height: 1080, bitrate: 5000000 },
  { name: '720p', height: 720, bitrate: 3000000 },
  { name: '480p', height: 480, bitrate: 1500000 },
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

function buildInputs(proxyUri, segments) {
  return segments.map((seg) => ({
    FileInput: proxyUri,
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
      'Audio Selector 1': {
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

function buildVideoDescription(height, bitrate) {
  return {
    ScalingBehavior: 'DEFAULT',
    Height: height,
    TimecodeInsertion: 'DISABLED',
    AntiAlias: 'ENABLED',
    Sharpness: 50,
    CodecSettings: {
      Codec: 'H_264',
      H264Settings: {
        InterlaceMode: 'PROGRESSIVE',
        ParNumerator: 1,
        NumberReferenceFrames: 3,
        Syntax: 'DEFAULT',
        Softness: 0,
        GopClosedCadence: 1,
        GopSize: 90,
        Slices: 1,
        GopBReference: 'DISABLED',
        SlowPal: 'DISABLED',
        SpatialAdaptiveQuantization: 'ENABLED',
        TemporalAdaptiveQuantization: 'ENABLED',
        FlickerAdaptiveQuantization: 'DISABLED',
        EntropyEncoding: 'CABAC',
        Bitrate: bitrate,
        FramerateControl: 'INITIALIZE_FROM_SOURCE',
        RateControlMode: 'CBR',
        CodecProfile: 'MAIN',
        Telecine: 'NONE',
        MinIInterval: 0,
        AdaptiveQuantization: 'HIGH',
        CodecLevel: 'AUTO',
        FieldEncoding: 'PAFF',
        SceneChangeDetect: 'ENABLED',
        QualityTuningLevel: 'SINGLE_PASS',
        FramerateConversionAlgorithm: 'DUPLICATE_DROP',
        UnregisteredSeiTimecode: 'DISABLED',
        GopSizeUnits: 'FRAMES',
        ParControl: 'INITIALIZE_FROM_SOURCE',
        NumberBFramesBetweenReferenceFrames: 2,
        RepeatPps: 'DISABLED',
      },
    },
    AfdSignaling: 'NONE',
    DropFrameTimecode: 'ENABLED',
    RespondToAfd: 'NONE',
    ColorMetadata: 'INSERT',
  };
}

function buildAudioDescription(bitrate = 96000) {
  return {
    AudioTypeControl: 'FOLLOW_INPUT',
    AudioSourceName: 'Audio Selector 1',
    CodecSettings: {
      Codec: 'AAC',
      AacSettings: {
        AudioDescriptionBroadcasterMix: 'NORMAL',
        Bitrate: bitrate,
        RateControlMode: 'CBR',
        CodecProfile: 'LC',
        CodingMode: 'CODING_MODE_2_0',
        RawFormat: 'NONE',
        SampleRate: 48000,
        Specification: 'MPEG4',
      },
    },
    LanguageCodeControl: 'FOLLOW_INPUT',
  };
}

function buildMp4Group(destination) {
  return {
    CustomName: 'mp4',
    Name: 'File Group',
    OutputGroupSettings: {
      Type: 'FILE_GROUP_SETTINGS',
      FileGroupSettings: {
        Destination: destination,
      },
    },
    Outputs: [
      {
        ContainerSettings: {
          Container: 'MP4',
          Mp4Settings: {
            CslgAtom: 'INCLUDE',
            FreeSpaceBox: 'EXCLUDE',
            MoovPlacement: 'PROGRESSIVE_DOWNLOAD',
          },
        },
        VideoDescription: buildVideoDescription(720, 3000000),
        AudioDescriptions: [buildAudioDescription(96000)],
        NameModifier: '_proxy',
      },
    ],
  };
}

function buildHlsGroup(destination) {
  return {
    CustomName: 'hls',
    Name: 'Apple HLS',
    OutputGroupSettings: {
      Type: 'HLS_GROUP_SETTINGS',
      HlsGroupSettings: {
        ManifestDurationFormat: 'INTEGER',
        SegmentLength: 6,
        TimedMetadataId3Period: 10,
        CaptionLanguageSetting: 'OMIT',
        Destination: destination,
        TimedMetadataId3Frame: 'PRIV',
        CodecSpecification: 'RFC_4281',
        OutputSelection: 'MANIFESTS_AND_SEGMENTS',
        ProgramDateTimePeriod: 600,
        MinSegmentLength: 0,
        MinFinalSegmentLength: 0,
        DirectoryStructure: 'SINGLE_DIRECTORY',
        ProgramDateTime: 'EXCLUDE',
        SegmentControl: 'SEGMENTED_FILES',
        ManifestCompression: 'NONE',
        ClientCache: 'ENABLED',
        StreamInfResolution: 'INCLUDE',
      },
    },
    Outputs: HLS_RESOLUTIONS.map((res) => ({
      ContainerSettings: {
        Container: 'M3U8',
        M3u8Settings: {
          AudioFramesPerPes: 4,
          PcrControl: 'PCR_EVERY_PES_PACKET',
          PmtPid: 480,
          PrivateMetadataPid: 503,
          ProgramNumber: 1,
          PatInterval: 0,
          PmtInterval: 0,
          Scte35Source: 'NONE',
          NielsenId3: 'NONE',
          TimedMetadata: 'NONE',
          VideoPid: 481,
          AudioPids: [482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492],
        },
      },
      VideoDescription: buildVideoDescription(res.height, res.bitrate),
      AudioDescriptions: [buildAudioDescription(96000)],
      NameModifier: `_${res.name}`,
    })),
  };
}

function buildJobTemplate({
  proxyUri,
  segments,
  destinationPrefix,
  roleArn,
  solutionUuid,
}) {
  return {
    Role: roleArn,
    UserMetadata: {
      solutionUuid,
    },
    StatusUpdateInterval: 'SECONDS_12',
    AccelerationSettings: {
      Mode: 'DISABLED',
    },
    BillingTagsSource: 'JOB',
    Settings: {
      AdAvailOffset: 0,
      Inputs: buildInputs(proxyUri, segments),
      OutputGroups: [
        buildMp4Group(`${destinationPrefix}mp4/`),
        buildHlsGroup(`${destinationPrefix}hls/`),
      ],
    },
  };
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

function findVideoProxy(ingestRow) {
  const proxies = ingestRow.proxies || [];
  const proxy = proxies.find((p) => p.type === 'video');
  if (!proxy || !proxy.key) {
    throw new M2CException('no video proxy on ingest row');
  }
  return proxy.key;
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
  const proxyKey = findVideoProxy(ingestRow);
  const proxyUri = `s3://${proxyBucket}/${proxyKey}`;

  // Use the renderId minted by the API at POST time (it pre-created the row
  // with status='queued' so the webapp could poll). Falling back to a fresh
  // uuid would orphan that row and produce duplicate render entries.
  const renderId = event.renderId || CRYPTO.randomUUID();
  const startedAt = new Date().toISOString();
  const destinationPrefix = `s3://${proxyBucket}/renders/${editProject.uuid}/${renderId}/`;

  const mediaConvertParams = buildJobTemplate({
    proxyUri,
    segments,
    destinationPrefix,
    roleArn,
    solutionUuid,
  });

  await persistRenderRow(rendersTable, renderId, {
    editProjectId,
    uuid: editProject.uuid,
    status: 'composing',
    publishToLibrary: !!editProject.publishToLibrary,
    aspectRatio: editProject.aspectRatio || '16:9',
    burnCaptions: !!editProject.burnCaptions,
    segmentCount: segments.length,
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
    destinationPrefix,
    mediaConvertParams,
  };
};
