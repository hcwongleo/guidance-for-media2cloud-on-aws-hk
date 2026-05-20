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

function ddbDocClient() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb);
}

class HighlightOp extends BaseOp {
  async onPOST() {
    const uuid = (this.request.pathParameters || {}).uuid;
    if (!uuid || !CommonUtils.validateUuid(uuid)) {
      throw new M2CException('invalid uuid');
    }

    const body = this.request.body || {};
    const strategy = body.strategy || 'auto';
    const modelId = body.modelId || null;
    const prompt = body.prompt || null;
    const maxSegments = Number(body.maxSegments) || 10;
    const owner = body.owner || this.request.cognitoIdentityId || 'anonymous';

    // Resolve transcriptKey + durationSec from existing M2C state.
    const ingestDb = new DB({
      Table: IngestTable,
      PartitionKey: IngestPartitionKey,
    });
    const ingestRow = await ingestDb.fetch(uuid, undefined, ['duration'])
      .catch(() => ({}));

    const analysisDb = new DB({
      Table: AnalysisTable,
      PartitionKey: AnalysisPartitionKey,
      SortKey: AnalysisSortKey,
    });
    const audioRow = await analysisDb.fetch(uuid, ANALYSIS_TYPE_AUDIO)
      .catch(() => undefined);

    const transcriptKey = body.transcriptKey
      || (audioRow && audioRow.transcribe && audioRow.transcribe.output);
    if (!transcriptKey) {
      throw new M2CException('no transcript available for this asset');
    }

    const durationSec = (ingestRow && ingestRow.duration)
      ? Math.round(ingestRow.duration / 1000)
      : 0;

    const sfnInput = {
      uuid,
      transcriptKey,
      strategy,
      modelId,
      prompt,
      maxSegments,
      durationSec,
      owner,
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

  async onGET() {
    // pathParameters.uuid is the API GW {uuid+} greedy capture.
    // It can be either "<uuid>" (list) or "<uuid>/<highlightSetId>" (single).
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

    // List all highlight sets for this uuid.
    const res = await doc.send(new QueryCommand({
      TableName: HighlightSetsTable,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: {
        '#pk': HighlightSetsPartitionKey,
      },
      ExpressionAttributeValues: {
        ':pk': uuid,
      },
    }));

    return super.onGET({
      uuid,
      highlightSets: res.Items || [],
    });
  }

  async onDELETE() {
    throw new M2CException('HighlightOp.onDELETE not impl');
  }
}

module.exports = HighlightOp;
