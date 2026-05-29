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
// TwelveLabs Pegasus on Bedrock rejects videos longer than ~60 minutes
// ("Unprocessable video, please check the video codec or duration").
// Pre-flight here so the user gets a synchronous, actionable error
// instead of a silent SFN failure ~17s into the run.
const PEGASUS_MAX_DURATION_SEC = 55 * 60;

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
    const strategy = body.strategy || 'multimodal';
    if (strategy !== 'multimodal' && strategy !== 'transcript-llm') {
      throw new M2CException(`unsupported strategy: ${strategy}`);
    }
    const modelId = body.modelId || null;
    const prompt = body.prompt || null;
    const maxSegments = Number(body.maxSegments) || 10;
    const owner = body.owner || this.request.cognitoIdentityId || 'anonymous';

    // Resolve transcriptKey + proxy MP4 + durationSec from existing M2C state.
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

    // Pick the AIML video/mp4 proxy (preferred) or any video/mp4 proxy.
    const proxies = (ingestRow && ingestRow.proxies) || [];
    const videoProxy = proxies.find((p) => p.mime === 'video/mp4' && p.outputType === 'aiml')
      || proxies.find((p) => p.mime === 'video/mp4');
    const proxyKey = body.proxyKey || (videoProxy && videoProxy.key);

    if (strategy === 'multimodal' && !proxyKey) {
      throw new M2CException('multimodal requires a video proxy; ensure ingest produced a video/mp4 proxy');
    }
    if (strategy === 'transcript-llm' && !transcriptKey) {
      throw new M2CException('transcript-llm requires a transcript; none found for this asset');
    }

    const ingestDurationSec = (ingestRow && ingestRow.duration)
      ? Math.round(ingestRow.duration / 1000)
      : 0;

    // Pegasus duration cap. Reject up front instead of after 17s of SFN burn.
    if (strategy === 'multimodal'
        && ingestDurationSec > 0
        && ingestDurationSec > PEGASUS_MAX_DURATION_SEC) {
      const min = Math.round(ingestDurationSec / 60);
      const cap = Math.round(PEGASUS_MAX_DURATION_SEC / 60);
      throw new M2CException(
        `video is ${min} min; multimodal (Pegasus) supports up to ${cap} min. `
        + 'Use strategy=transcript-llm.'
      );
    }

    const sfnInput = {
      uuid,
      transcriptKey,
      proxyKey,
      strategy,
      modelId,
      prompt,
      maxSegments,
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
    const sets = res.Items || [];

    // Overlay saved edits: when the user opens the editor and saves, we
    // persist the modified segments to EditProjects keyed by editProjectId
    // (= highlightSetId). Merge those back so the table shows the user's
    // current segments rather than the original auto-detected ones.
    const editsRes = await doc.send(new QueryCommand({
      TableName: EditProjectsTable,
      IndexName: EditProjectsUuidGsiName,
      KeyConditionExpression: '#k = :v',
      ExpressionAttributeNames: {
        '#k': EditProjectsUuidGsiKey,
      },
      ExpressionAttributeValues: {
        ':v': uuid,
      },
    })).catch((e) => {
      console.error('listEditProjects(merge) failed:', e);
      return undefined;
    });
    const editById = {};
    ((editsRes && editsRes.Items) || []).forEach((ep) => {
      if (ep && ep.editProjectId) editById[ep.editProjectId] = ep;
    });

    const merged = sets.map((it) => {
      const ep = editById[it.highlightSetId];
      if (!ep || !Array.isArray(ep.segments)) return it;
      return { ...it, segments: ep.segments };
    });

    return super.onGET({
      uuid,
      highlightSets: merged,
    });
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
