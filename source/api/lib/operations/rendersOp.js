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

function ddbDocClient() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb);
}

class RendersOp extends BaseOp {
  async onPOST() {
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
    const burnCaptions = !!body.burnCaptions;
    const submittedAt = new Date().toISOString();

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
        burnCaptions,
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
      burnCaptions,
      owner,
    };

    const sfnClient = xraysdkHelper(new SFNClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const response = await sfnClient.send(new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(sfnInput),
    }));

    return super.onPOST({
      renderId,
      editProjectId,
      executionArn: response.executionArn,
      startDate: response.startDate,
      status: 'queued',
    });
  }

  async onGET() {
    const captured = (this.request.pathParameters || {}).uuid;
    const renderId = captured && captured.split('/').filter(Boolean)[0];
    const queryEditProjectId = (this.request.queryString || {}).editProjectId;

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
      return super.onGET({
        editProjectId: queryEditProjectId,
        renders: res.Items || [],
      });
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
    return super.onGET(res.Item);
  }

  async onDELETE() {
    const captured = (this.request.pathParameters || {}).uuid;
    const renderId = captured && captured.split('/').filter(Boolean)[0];
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
      const prefix = `renders/${item.uuid}/${renderId}/`;
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

    return super.onDELETE({
      renderId,
      deleted: true,
      objectsDeleted,
    });
  }
}

module.exports = RendersOp;
