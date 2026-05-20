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

    const segments = sanitizeSegments(body.segments || []);
    const owner = body.owner
      || this.request.cognitoIdentityId
      || 'anonymous';

    const item = {
      [EditProjectsPartitionKey]: editProjectId,
      uuid: assetUuid,
      owner,
      name: body.name ? String(body.name) : '',
      segments,
      publishToLibrary: !!body.publishToLibrary,
      aspectRatio: body.aspectRatio ? String(body.aspectRatio) : '16:9',
      burnCaptions: !!body.burnCaptions,
      updatedAt: new Date().toISOString(),
    };
    if (body.createdAt) {
      item.createdAt = String(body.createdAt);
    } else {
      item.createdAt = item.updatedAt;
    }

    const doc = ddbDocClient();
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
