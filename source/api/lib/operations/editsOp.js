// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const CRYPTO = require('node:crypto');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  CommonUtils,
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
    DynamoDB: {
      EditProjects: {
        Table: EditProjectsTable,
        PartitionKey: EditProjectsPartitionKey,
        GSI: {
          Uuid: {
            Name: EditProjectsUuidGsiName,
            Key: EditProjectsUuidGsiKey,
          },
        },
      },
    },
  },
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');
const BaseOp = require('./baseOp');

const VALID_KINDS = ['highlight', 'custom'];
const VALID_MODES = ['full', 'highlights'];
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOGO_SIZES = ['48', '64', '96', '128', '192'];

function sanitizeLogos(logos) {
  if (!logos || typeof logos !== 'object') return {};
  const out = {};
  for (const size of LOGO_SIZES) {
    const v = logos[size];
    if (typeof v === 'string' && v.length > 0) out[size] = v;
  }
  return out;
}

function ddbDocClient() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb);
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
    const out = {
      kind,
      startSec,
      endSec,
    };
    if (seg.title) out.title = String(seg.title);
    if (seg.reason) out.reason = String(seg.reason);
    if (seg.quote) out.quote = String(seg.quote);
    if (seg.text) out.text = String(seg.text);
    if (seg.startTimecode) out.startTimecode = String(seg.startTimecode);
    if (seg.endTimecode) out.endTimecode = String(seg.endTimecode);
    if (seg.anchorRatio !== undefined) out.anchorRatio = Number(seg.anchorRatio);
    if (seg.highlightSetId) out.highlightSetId = String(seg.highlightSetId);
    if (seg.sourceSegmentIndex !== undefined) {
      out.sourceSegmentIndex = Number(seg.sourceSegmentIndex);
    }
    return out;
  });
}

class EditsOp extends BaseOp {
  async onPOST() {
    const body = this.request.body || {};
    const captured = (this.request.pathParameters || {}).uuid;
    const editProjectId = (captured && captured.split('/').filter(Boolean)[0])
      || body.editProjectId
      || CRYPTO.randomUUID();

    const assetUuid = body.uuid;
    if (!assetUuid || !CommonUtils.validateUuid(assetUuid)) {
      throw new M2CException('body.uuid (asset uuid) is required and must be a valid uuid');
    }

    const owner = body.owner
      || this.request.cognitoIdentityId
      || 'anonymous';
    const now = new Date().toISOString();
    const doc = ddbDocClient();

    // Fetch existing row so partial saves merge instead of overwriting other
    // fields. OutputTab and HighlightEditorModal both write to the same row
    // (when mode=highlights, editProjectId === highlightSetId): the modal
    // saves segments only, OutputTab saves render add-ons only — without a
    // merge they clobber each other.
    const existing = await doc.send(new GetCommand({
      TableName: EditProjectsTable,
      Key: { [EditProjectsPartitionKey]: editProjectId },
    })).then((r) => (r && r.Item) || undefined).catch(() => undefined);

    const item = {
      ...(existing || {}),
      [EditProjectsPartitionKey]: editProjectId,
      uuid: assetUuid,
      owner: (existing && existing.owner) || owner,
      updatedAt: now,
    };
    if (!existing) {
      item.name = body.name ? String(body.name) : '';
      item.segments = sanitizeSegments(body.segments || []);
      item.publishToLibrary = !!body.publishToLibrary;
      item.aspectRatio = body.aspectRatio ? String(body.aspectRatio) : '16:9';
      item.createdAt = body.createdAt ? String(body.createdAt) : now;
    } else {
      if (body.name !== undefined) item.name = String(body.name);
      if (body.segments !== undefined) item.segments = sanitizeSegments(body.segments);
      if (body.publishToLibrary !== undefined) item.publishToLibrary = !!body.publishToLibrary;
      if (body.aspectRatio !== undefined) item.aspectRatio = String(body.aspectRatio);
    }

    // Output-tab fields read by compose-edl.
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
    if (body.fontScript !== undefined) {
      item.fontScript = String(body.fontScript);
    }
    if (body.burnSubtitles !== undefined) {
      item.burnSubtitles = !!body.burnSubtitles;
    }
    if (body.logos !== undefined) {
      item.logos = sanitizeLogos(body.logos);
    }

    await doc.send(new PutCommand({
      TableName: EditProjectsTable,
      Item: item,
    }));

    return super.onPOST(item);
  }

  async onGET() {
    const captured = (this.request.pathParameters || {}).uuid;
    const editProjectId = captured && captured.split('/').filter(Boolean)[0];
    const queryUuid = (this.request.queryString || {}).uuid;

    const doc = ddbDocClient();

    // List by asset uuid via GSI
    if (!editProjectId && queryUuid) {
      if (!CommonUtils.validateUuid(queryUuid)) {
        throw new M2CException('invalid uuid');
      }
      const res = await doc.send(new QueryCommand({
        TableName: EditProjectsTable,
        IndexName: EditProjectsUuidGsiName,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: {
          '#k': EditProjectsUuidGsiKey,
        },
        ExpressionAttributeValues: {
          ':v': queryUuid,
        },
      }));
      return super.onGET({
        uuid: queryUuid,
        editProjects: res.Items || [],
      });
    }

    if (!editProjectId) {
      throw new M2CException('missing editProjectId');
    }

    const res = await doc.send(new GetCommand({
      TableName: EditProjectsTable,
      Key: {
        [EditProjectsPartitionKey]: editProjectId,
      },
    }));
    if (!res.Item) {
      throw new M2CException('edit project not found');
    }
    return super.onGET(res.Item);
  }

  async onDELETE() {
    throw new M2CException('EditsOp.onDELETE not impl');
  }
}

module.exports = EditsOp;
