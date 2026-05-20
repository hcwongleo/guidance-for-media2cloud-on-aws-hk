// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
    DynamoDB: {
      HighlightSettings: {
        Table: HighlightSettingsTable,
        PartitionKey: HighlightSettingsPartitionKey,
      },
    },
  },
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');
const BaseOp = require('./baseOp');

function ddbDocClient() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb);
}

function resolveOwnerId(request) {
  const queryOwner = (request.queryString || {}).ownerId;
  if (queryOwner) {
    return decodeURIComponent(queryOwner);
  }
  return request.cognitoIdentityId || 'anonymous';
}

class HighlightSettingsOp extends BaseOp {
  async onGET() {
    const ownerId = resolveOwnerId(this.request);

    const doc = ddbDocClient();
    const res = await doc.send(new GetCommand({
      TableName: HighlightSettingsTable,
      Key: {
        [HighlightSettingsPartitionKey]: ownerId,
      },
    }));

    return super.onGET(res.Item || { ownerId });
  }

  async onPOST() {
    const body = this.request.body || {};
    const ownerId = body.ownerId
      || this.request.cognitoIdentityId
      || 'anonymous';

    const item = {
      ...body,
      [HighlightSettingsPartitionKey]: ownerId,
      updatedAt: new Date().toISOString(),
    };

    const doc = ddbDocClient();
    await doc.send(new PutCommand({
      TableName: HighlightSettingsTable,
      Item: item,
    }));

    return super.onPOST(item);
  }

  async onDELETE() {
    throw new M2CException('HighlightSettingsOp.onDELETE not impl');
  }
}

module.exports = HighlightSettingsOp;
