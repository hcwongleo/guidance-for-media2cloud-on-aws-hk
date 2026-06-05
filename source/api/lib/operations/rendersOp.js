// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const CRYPTO = require('node:crypto');
const {
  SFNClient,
  StartExecutionCommand,
} = require('@aws-sdk/client-sfn');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
    DynamoDB: {
      Renders: {
        Table: RendersTable,
        PartitionKey: RendersPartitionKey,
        GSI: {
          EditProjectId: {
            Name: RendersEditProjectGsiName,
            Key: RendersEditProjectGsiKey,
          },
          Uuid: {
            Name: RendersUuidGsiName,
            Key: RendersUuidGsiKey,
          },
        },
      },
    },
    StateMachines: {
      RenderPublish,
    },
    Proxy: {
      Bucket: ProxyBucket,
    },
  },
  CommonUtils,
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');
const BaseOp = require('./baseOp');

const REGION = process.env.AWS_REGION;

const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function ddbDocClient() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb);
}

class RendersOp extends BaseOp {
  async onPOST() {
    return super.onPOST(await this._startRender());
  }

  async onGET() {
    const renderId = this._renderId();
    return super.onGET(await this._getRender(renderId));
  }

  async onDELETE() {
    const renderId = this._renderId();
    return super.onDELETE(await this._deleteRender(renderId));
  }

  _renderId() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    return raw.split('/').filter((x) => x.length > 0)[0] || '';
  }

  async _startRender() {
    const body = this.request.body || {};
    const uuid = body.uuid;
    if (!uuid || !CommonUtils.validateUuid(uuid)) {
      throw new M2CException('body.uuid (asset uuid) is required and must be a valid uuid');
    }

    // mode = 'full' | 'highlights'. Highlights mode requires an editProjectId
    // (= highlightSetId) so compose-edl can fetch the segment list off the
    // HighlightSets row. Full mode encodes the whole source and doesn't need
    // any highlight set selected.
    const mode = body.mode === 'highlights' ? 'highlights' : 'full';
    const editProjectId = body.editProjectId;
    if (mode === 'highlights' && !editProjectId) {
      throw new M2CException('body.editProjectId is required for mode=highlights');
    }

    const renderId = body.renderId || CRYPTO.randomUUID();
    const owner = body.owner
      || this.request.cognitoIdentityId
      || 'anonymous';
    const publishToLibrary = !!body.publishToLibrary;
    const aspectRatio = body.aspectRatio ? String(body.aspectRatio) : '16:9';
    const burnSubtitles = !!body.burnSubtitles;
    const fontScript = typeof body.fontScript === 'string' && body.fontScript.length > 0
      ? body.fontScript
      : 'HANT';
    const logos = (body.logos && typeof body.logos === 'object') ? body.logos : {};

    // Per-render positional knobs. All optional — compose-edl falls back
    // to the template's existing values when undefined.
    //
    // logoLayout: shared corner/size/inset for whichever logo size the
    //   render picks (one logo per output stream, sized to match resolution).
    // subtitleLayout: font height + bottom inset + max wrap lines, all
    //   expressed as % of the output frame so portrait + landscape scale
    //   the same way.
    const clamp = (v, lo, hi, dflt) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dflt;
      return Math.max(lo, Math.min(hi, n));
    };
    const inputLogoLayout = (body.logoLayout && typeof body.logoLayout === 'object') ? body.logoLayout : {};
    const logoLayout = {
      xPct: clamp(inputLogoLayout.xPct, 0, 100, 80),
      yPct: clamp(inputLogoLayout.yPct, 0, 100, 5),
      opacity: clamp(inputLogoLayout.opacity, 0, 100, 100),
    };
    const inputSubtitleLayout = (body.subtitleLayout && typeof body.subtitleLayout === 'object') ? body.subtitleLayout : {};
    const subtitleLayout = {
      heightPct: clamp(inputSubtitleLayout.heightPct, 1.5, 8, 3.5),
      bottomPct: clamp(inputSubtitleLayout.bottomPct, 2, 40, 8),
      sideMarginPct: clamp(inputSubtitleLayout.sideMarginPct, 0, 20, 5),
      maxLines: Math.round(clamp(inputSubtitleLayout.maxLines, 1, 3, 2)),
    };

    const submittedAt = new Date().toISOString();

    let template;
    if (typeof body.template === 'string' && body.template.length > 0) {
      if (!TEMPLATE_NAME_RE.test(body.template)) {
        throw new M2CException(`invalid template name: ${body.template}`);
      }
      template = body.template;
    }

    // Pre-create the Renders row so the webapp can poll/subscribe immediately
    // and so the row carries its own settings (template/aspectRatio/etc.) for
    // later replay or audit. As of v4.0.33, render add-ons live HERE on the
    // Renders row — exporting the same set as 16:9 + 9:16 produces two rows
    // with their own configs instead of clobbering each other on the set.
    const doc = ddbDocClient();
    await doc.send(new PutCommand({
      TableName: RendersTable,
      Item: {
        [RendersPartitionKey]: renderId,
        ...(editProjectId ? { editProjectId } : {}),
        uuid,
        mode,
        owner,
        publishToLibrary,
        aspectRatio,
        burnSubtitles,
        fontScript,
        logos,
        logoLayout,
        subtitleLayout,
        ...(template ? { template } : {}),
        status: 'queued',
        percent: 0,
        submittedAt,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      },
    }));

    const stateMachineArn = [
      'arn:aws:states',
      REGION,
      this.request.accountId,
      'stateMachine',
      RenderPublish,
    ].join(':');

    const sfnInput = {
      renderId,
      ...(editProjectId ? { editProjectId } : {}),
      uuid,
      mode,
      publishToLibrary,
      aspectRatio,
      burnSubtitles,
      fontScript,
      logos,
      logoLayout,
      subtitleLayout,
      owner,
      ...(template ? { template } : {}),
    };

    const sfnClient = xraysdkHelper(new SFNClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const response = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(sfnInput),
    }));

    return {
      renderId,
      ...(editProjectId ? { editProjectId } : {}),
      uuid,
      mode,
      executionArn: response.executionArn,
      startDate: response.startDate,
      status: 'queued',
      ...(template ? { template } : {}),
    };
  }

  async _getRender(renderId) {
    const qs = this.request.queryString || {};
    const queryEditProjectId = qs.editProjectId;
    const queryUuid = qs.uuid;
    const doc = ddbDocClient();

    if (!renderId && queryEditProjectId) {
      const res = await doc.send(new QueryCommand({
        TableName: RendersTable,
        IndexName: RendersEditProjectGsiName,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: {
          '#k': RendersEditProjectGsiKey,
        },
        ExpressionAttributeValues: {
          ':v': queryEditProjectId,
        },
      }));
      return {
        editProjectId: queryEditProjectId,
        renders: res.Items || [],
      };
    }

    // List renders for an asset — single direct query against the
    // gsi-uuid index. Pre-v4.0.34 this fanned out over HighlightSets
    // (one query per set) which silently dropped full-mode renders
    // since they have no editProjectId.
    if (!renderId && queryUuid) {
      if (!CommonUtils.validateUuid(queryUuid)) {
        throw new M2CException('invalid uuid');
      }
      const res = await doc.send(new QueryCommand({
        TableName: RendersTable,
        IndexName: RendersUuidGsiName,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: { '#k': RendersUuidGsiKey },
        ExpressionAttributeValues: { ':v': queryUuid },
      }));
      const renders = (res && res.Items) || [];
      return {
        uuid: queryUuid,
        renders,
      };
    }

    if (!renderId) {
      throw new M2CException('missing renderId or editProjectId');
    }

    const res = await doc.send(new GetCommand({
      TableName: RendersTable,
      Key: {
        [RendersPartitionKey]: renderId,
      },
    }));
    if (!res.Item) {
      throw new M2CException('render not found');
    }
    return res.Item;
  }

  async _deleteRender(renderId) {
    if (!renderId) {
      throw new M2CException('missing renderId');
    }
    const doc = ddbDocClient();

    // Look up the row first so we know which S3 prefix to clean up.
    const existing = await doc.send(new GetCommand({
      TableName: RendersTable,
      Key: {
        [RendersPartitionKey]: renderId,
      },
    }));
    const item = (existing && existing.Item) || undefined;

    let objectsDeleted = 0;
    if (item && item.uuid) {
      const prefix = `${item.uuid}/output/${renderId}/`;
      let token;
      do {
        const page = await CommonUtils.listObjects(ProxyBucket, prefix, {
          ContinuationToken: token,
        });
        const contents = (page && page.Contents) || [];
        for (const obj of contents) {
          if (!obj || !obj.Key) continue;
          try {
            await CommonUtils.deleteObject(ProxyBucket, obj.Key);
            objectsDeleted += 1;
          } catch (e) {
            console.error(`deleteObject ${obj.Key} failed:`, e.message);
          }
        }
        token = (page && page.IsTruncated) ? page.NextContinuationToken : undefined;
      } while (token);
    }

    await doc.send(new DeleteCommand({
      TableName: RendersTable,
      Key: {
        [RendersPartitionKey]: renderId,
      },
    }));

    return {
      renderId,
      deleted: true,
      objectsDeleted,
    };
  }

}

module.exports = RendersOp;
