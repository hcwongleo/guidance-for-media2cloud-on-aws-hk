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
        },
      },
      EditProjects: {
        Table: EditProjectsTable,
        GSI: {
          Uuid: {
            Name: EditProjectsUuidGsiName,
            Key: EditProjectsUuidGsiKey,
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
    const editProjectId = body.editProjectId;
    if (!editProjectId) {
      throw new M2CException('body.editProjectId is required');
    }

    const renderId = body.renderId || CRYPTO.randomUUID();
    const owner = body.owner
      || this.request.cognitoIdentityId
      || 'anonymous';
    const publishToLibrary = !!body.publishToLibrary;
    const aspectRatio = body.aspectRatio ? String(body.aspectRatio) : '16:9';
    const submittedAt = new Date().toISOString();

    let template;
    if (typeof body.template === 'string' && body.template.length > 0) {
      if (!TEMPLATE_NAME_RE.test(body.template)) {
        throw new M2CException(`invalid template name: ${body.template}`);
      }
      template = body.template;
    }

    // Pre-create the Renders row so the webapp can poll/subscribe immediately.
    // compose-edl will UpdateItem this same row to attach the MediaConvert job spec.
    const doc = ddbDocClient();
    await doc.send(new PutCommand({
      TableName: RendersTable,
      Item: {
        [RendersPartitionKey]: renderId,
        editProjectId,
        owner,
        publishToLibrary,
        aspectRatio,
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
      editProjectId,
      publishToLibrary,
      aspectRatio,
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
      editProjectId,
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

    // List all renders for an asset by fanning out across its edit projects.
    // OutputTab + HighlightEditorModal create separate edit projects per
    // highlight set, so listing by editProjectId would hide history from
    // other modes; aggregate by asset uuid instead.
    if (!renderId && queryUuid) {
      if (!CommonUtils.validateUuid(queryUuid)) {
        throw new M2CException('invalid uuid');
      }
      const eps = await doc.send(new QueryCommand({
        TableName: EditProjectsTable,
        IndexName: EditProjectsUuidGsiName,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: { '#k': EditProjectsUuidGsiKey },
        ExpressionAttributeValues: { ':v': queryUuid },
      }));
      const editProjectIds = ((eps && eps.Items) || [])
        .map((it) => it && it.editProjectId)
        .filter((id) => typeof id === 'string' && id.length > 0);
      const buckets = await Promise.all(editProjectIds.map((id) => doc.send(new QueryCommand({
        TableName: RendersTable,
        IndexName: RendersEditProjectGsiName,
        KeyConditionExpression: '#k = :v',
        ExpressionAttributeNames: { '#k': RendersEditProjectGsiKey },
        ExpressionAttributeValues: { ':v': id },
      })).then((r) => (r && r.Items) || []).catch(() => [])));
      const renders = [].concat(...buckets);
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
