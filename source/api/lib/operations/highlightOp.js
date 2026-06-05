// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  SFNClient,
  StartExecutionCommand,
} = require('@aws-sdk/client-sfn');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  CommonUtils,
  DB,
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
    DynamoDB: {
      Ingest: {
        Table: IngestTable,
        PartitionKey: IngestPartitionKey,
      },
      AIML: {
        Table: AnalysisTable,
        PartitionKey: AnalysisPartitionKey,
        SortKey: AnalysisSortKey,
      },
      HighlightSets: {
        Table: HighlightSetsTable,
        PartitionKey: HighlightSetsPartitionKey,
        SortKey: HighlightSetsSortKey,
      },
    },
    StateMachines: {
      HighlightDetection,
    },
  },
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');
const BaseOp = require('./baseOp');

const REGION = process.env.AWS_REGION;
const ANALYSIS_TYPE_AUDIO = 'audio';

// Render add-on field whitelist — these live alongside `segments` on each
// HighlightSets row. The OutputTab "save settings" / "Export" path writes
// them; compose-edl reads them at render time.
const VALID_KINDS = ['highlight', 'custom'];
const VALID_MODES = ['full', 'highlights'];
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOGO_SIZES = ['48', '64', '96', '128', '192'];

function ddbDocClient() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb);
}

function sanitizeLogos(logos) {
  if (!logos || typeof logos !== 'object') return {};
  const out = {};
  for (const size of LOGO_SIZES) {
    const v = logos[size];
    if (typeof v === 'string' && v.length > 0) out[size] = v;
  }
  return out;
}

function sanitizeSegments(segments) {
  if (!Array.isArray(segments)) {
    throw new M2CException('segments must be an array');
  }
  return segments.map((seg, idx) => {
    if (!seg || typeof seg !== 'object') {
      throw new M2CException(`segment[${idx}] is invalid`);
    }
    const kind = seg.kind || 'custom';
    if (!VALID_KINDS.includes(kind)) {
      throw new M2CException(`segment[${idx}].kind must be one of ${VALID_KINDS.join(', ')}`);
    }
    const startSec = Number(seg.startSec);
    const endSec = Number(seg.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
      throw new M2CException(`segment[${idx}] must have valid startSec < endSec`);
    }
    const out = { kind, startSec, endSec };
    if (seg.title) out.title = String(seg.title);
    if (seg.reason) out.reason = String(seg.reason);
    if (seg.description) out.description = String(seg.description);
    if (seg.quote) out.quote = String(seg.quote);
    if (seg.text) out.text = String(seg.text);
    if (seg.startTimecode) out.startTimecode = String(seg.startTimecode);
    if (seg.endTimecode) out.endTimecode = String(seg.endTimecode);
    if (seg.anchorRatio !== undefined) out.anchorRatio = Number(seg.anchorRatio);
    if (Number.isFinite(seg.rank)) out.rank = Number(seg.rank);
    if (Number.isFinite(seg.score)) out.score = Number(seg.score);
    return out;
  });
}

class HighlightOp extends BaseOp {
  // POST /highlights/{uuid} — kick off a highlight detection job.
  async onPOST() {
    const uuid = (this.request.pathParameters || {}).uuid;
    if (!uuid || !CommonUtils.validateUuid(uuid)) {
      throw new M2CException('invalid uuid');
    }

    const body = this.request.body || {};
    const modelId = body.modelId || null;
    const rankModelId = body.rankModelId || null;
    if (!modelId) {
      throw new M2CException('modelId is required (video model used to describe each shot)');
    }
    if (!rankModelId) {
      throw new M2CException('rankModelId is required (text model used to rank shots against the prompt)');
    }
    const prompt = body.prompt || null;
    const maxSegments = Number(body.maxSegments) || 30;
    const rawConfidence = Number(body.minConfidence);
    const minConfidence = Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(1, rawConfidence))
      : 0.5;
    const owner = body.owner || this.request.cognitoIdentityId || 'anonymous';

    const ingestDb = new DB({
      Table: IngestTable,
      PartitionKey: IngestPartitionKey,
    });
    const ingestRow = await ingestDb.fetch(uuid, undefined, ['duration', 'proxies', 'destination'])
      .catch(() => ({}));

    const analysisDb = new DB({
      Table: AnalysisTable,
      PartitionKey: AnalysisPartitionKey,
      SortKey: AnalysisSortKey,
    });
    const audioRow = await analysisDb.fetch(uuid, ANALYSIS_TYPE_AUDIO).catch(() => undefined);

    const transcriptKey = body.transcriptKey
      || (audioRow && audioRow.transcribe && audioRow.transcribe.output);

    const proxies = (ingestRow && ingestRow.proxies) || [];
    const videoProxy = proxies.find((p) => p.mime === 'video/mp4' && p.outputType === 'aiml')
      || proxies.find((p) => p.mime === 'video/mp4');
    const proxyKey = body.proxyKey || (videoProxy && videoProxy.key);

    if (!proxyKey) {
      throw new M2CException('a video/mp4 proxy is required; ensure ingest produced one');
    }

    const ingestDurationSec = (ingestRow && ingestRow.duration)
      ? Math.round(ingestRow.duration / 1000)
      : 0;

    const sfnInput = {
      uuid,
      transcriptKey,
      proxyKey,
      modelId,
      rankModelId,
      prompt,
      maxSegments,
      minConfidence,
      durationSec: ingestDurationSec,
      owner,
      accountId: this.request.accountId,
    };

    const stateMachineArn = [
      'arn:aws:states',
      REGION,
      this.request.accountId,
      'stateMachine',
      HighlightDetection,
    ].join(':');

    const sfnClient = xraysdkHelper(new SFNClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(sfnInput),
    });

    const response = await sfnClient.send(command);
    return super.onPOST({
      executionArn: response.executionArn,
      startDate: response.startDate,
      uuid,
    });
  }

  // GET /highlights/{uuid}            → list all highlight sets for this asset
  // GET /highlights/{uuid}/{setId}    → get one highlight set
  async onGET() {
    const captured = (this.request.pathParameters || {}).uuid;
    if (!captured) {
      throw new M2CException('missing uuid');
    }

    const parts = captured.split('/').filter(Boolean);
    const uuid = parts[0];
    const highlightSetId = parts[1];

    if (!CommonUtils.validateUuid(uuid)) {
      throw new M2CException('invalid uuid');
    }

    const doc = ddbDocClient();

    if (highlightSetId) {
      const res = await doc.send(new GetCommand({
        TableName: HighlightSetsTable,
        Key: {
          [HighlightSetsPartitionKey]: uuid,
          [HighlightSetsSortKey]: highlightSetId,
        },
      }));
      if (!res.Item) {
        throw new M2CException('highlight set not found');
      }
      return super.onGET(res.Item);
    }

    const res = await doc.send(new QueryCommand({
      TableName: HighlightSetsTable,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': HighlightSetsPartitionKey },
      ExpressionAttributeValues: { ':pk': uuid },
    }));
    return super.onGET({
      uuid,
      highlightSets: res.Items || [],
    });
  }

  // PUT /highlights/{uuid}/{setId} — update editable fields on a highlight
  // set: segments (after the editor modal trims/reorders), and the render
  // add-ons compose-edl reads at render time (mode/template/burnSubtitles/
  // logos/aspectRatio/publishToLibrary/fontScript/name).
  //
  // EditProjects had its own table for this; rolled into HighlightSets so
  // there's one row per detection-and-its-edits. Server-side merge: only
  // writes fields the body actually sets; everything else is preserved.
  async onPUT() {
    const captured = (this.request.pathParameters || {}).uuid;
    if (!captured) throw new M2CException('missing uuid');
    const parts = captured.split('/').filter(Boolean);
    const uuid = parts[0];
    const highlightSetId = parts[1];
    if (!CommonUtils.validateUuid(uuid)) {
      throw new M2CException('invalid uuid');
    }
    if (!highlightSetId) {
      throw new M2CException('highlightSetId is required');
    }

    const doc = ddbDocClient();
    const existing = await doc.send(new GetCommand({
      TableName: HighlightSetsTable,
      Key: {
        [HighlightSetsPartitionKey]: uuid,
        [HighlightSetsSortKey]: highlightSetId,
      },
    })).then((r) => (r && r.Item) || undefined);
    if (!existing) {
      throw new M2CException('highlight set not found');
    }

    const body = this.request.body || {};
    const item = { ...existing, updatedAt: new Date().toISOString() };

    if (body.segments !== undefined) {
      item.segments = sanitizeSegments(body.segments);
    }
    if (body.name !== undefined) item.name = String(body.name);
    if (body.mode !== undefined) {
      const mode = String(body.mode);
      if (!VALID_MODES.includes(mode)) {
        throw new M2CException(`mode must be one of ${VALID_MODES.join(', ')}`);
      }
      item.mode = mode;
    }
    if (body.template !== undefined) {
      const tmpl = String(body.template);
      if (tmpl && !TEMPLATE_NAME_RE.test(tmpl)) {
        throw new M2CException(`invalid template name: ${tmpl}`);
      }
      if (tmpl) item.template = tmpl;
    }
    if (body.fontScript !== undefined) item.fontScript = String(body.fontScript);
    if (body.burnSubtitles !== undefined) item.burnSubtitles = !!body.burnSubtitles;
    if (body.logos !== undefined) item.logos = sanitizeLogos(body.logos);
    if (body.aspectRatio !== undefined) item.aspectRatio = String(body.aspectRatio);
    if (body.publishToLibrary !== undefined) item.publishToLibrary = !!body.publishToLibrary;

    await doc.send(new PutCommand({
      TableName: HighlightSetsTable,
      Item: item,
    }));
    return super.onPUT(item);
  }

  async onDELETE() {
    const captured = (this.request.pathParameters || {}).uuid;
    if (!captured) {
      throw new M2CException('missing uuid');
    }

    const parts = captured.split('/').filter(Boolean);
    const uuid = parts[0];
    const highlightSetId = parts[1];

    if (!CommonUtils.validateUuid(uuid)) {
      throw new M2CException('invalid uuid');
    }
    if (!highlightSetId) {
      throw new M2CException('highlightSetId is required to delete a highlight set');
    }

    const doc = ddbDocClient();
    await doc.send(new DeleteCommand({
      TableName: HighlightSetsTable,
      Key: {
        [HighlightSetsPartitionKey]: uuid,
        [HighlightSetsSortKey]: highlightSetId,
      },
    }));

    return super.onDELETE({
      uuid,
      highlightSetId,
      deleted: true,
    });
  }
}

module.exports = HighlightOp;
