// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const FS = require('fs');
const PATH = require('path');
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

const TEMPLATES_PREFIX = '_render_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Mirrors compose-edl's packaged tmpl/ list. Keep in sync.
const SUPPORTED_TEMPLATES = ['mp4_landscape', 'mp4_portrait'];
// Packaged render templates live alongside compose-edl's tmpl/. The api
// Lambda doesn't ship them, so listing prefers S3 overrides + falls back to
// the SUPPORTED_TEMPLATES allowlist (compose-edl loads the packaged JSON).
const PACKAGED_TEMPLATE_DIR = PATH.join(__dirname, 'render', 'tmpl');

function ddbDocClient() {
  const ddb = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(ddb);
}

class RendersOp extends BaseOp {
  async onPOST() {
    const route = this._parsePath();
    if (route.kind === 'templates') {
      if (!route.templateName) {
        throw new M2CException('template name required');
      }
      return super.onPOST(await this._saveTemplate(route.templateName));
    }
    return super.onPOST(await this._startRender());
  }

  async onGET() {
    const route = this._parsePath();
    if (route.kind === 'templates') {
      if (!route.templateName) {
        return super.onGET(await this._listTemplates());
      }
      return super.onGET(await this._getTemplate(route.templateName));
    }
    return super.onGET(await this._getRender(route.renderId));
  }

  async onDELETE() {
    const route = this._parsePath();
    if (route.kind === 'templates') {
      if (!route.templateName) {
        throw new M2CException('template name required');
      }
      return super.onDELETE(await this._deleteTemplate(route.templateName));
    }
    return super.onDELETE(await this._deleteRender(route.renderId));
  }

  _parsePath() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    const parts = raw.split('/').filter((x) => x.length > 0);
    if (parts[0] === 'templates') {
      return { kind: 'templates', templateName: parts[1] || '' };
    }
    return { kind: 'render', renderId: parts[0] || '' };
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
    const burnCaptions = !!body.burnCaptions;
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
        burnCaptions,
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
      burnCaptions,
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
      return {
        editProjectId: queryEditProjectId,
        renders: res.Items || [],
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

    return {
      renderId,
      deleted: true,
      objectsDeleted,
    };
  }

  // ---------- template management ----------

  async _listTemplates() {
    const items = new Map();
    SUPPORTED_TEMPLATES.forEach((n) =>
      items.set(n, { name: n, builtin: true, custom: false }));

    let response;
    try {
      response = await CommonUtils.listObjects(ProxyBucket, `${TEMPLATES_PREFIX}/`);
    } catch (e) {
      response = undefined;
    }
    const contents = (response && response.Contents) || [];
    contents.forEach((o) => {
      const m = (o.Key || '').match(new RegExp(`^${TEMPLATES_PREFIX}/([A-Za-z0-9_-]{1,64})\\.json$`));
      if (!m) return;
      const name = m[1];
      const prev = items.get(name);
      items.set(name, {
        name,
        builtin: !!(prev && prev.builtin),
        custom: true,
        size: o.Size,
        lastModified: o.LastModified,
      });
    });
    return { templates: Array.from(items.values()) };
  }

  async _getTemplate(name) {
    if (!TEMPLATE_NAME_RE.test(name)) {
      throw new M2CException(`invalid template name: ${name}`);
    }
    const tmpl = await this._loadTemplate(name);
    const isCustom = await CommonUtils.headObject(
      ProxyBucket,
      `${TEMPLATES_PREFIX}/${name}.json`
    ).catch(() => undefined);
    return {
      name,
      builtin: SUPPORTED_TEMPLATES.includes(name),
      custom: !!isCustom,
      content: tmpl,
    };
  }

  async _loadTemplate(name) {
    if (!TEMPLATE_NAME_RE.test(name)) {
      throw new M2CException(`invalid template name: ${name}`);
    }
    // S3 override wins over the packaged built-in (compose-edl follows the
    // same precedence at job-submit time).
    const s3Key = `${TEMPLATES_PREFIX}/${name}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, s3Key).catch(() => undefined);
    if (exists) {
      const buf = await CommonUtils.download(ProxyBucket, s3Key);
      return JSON.parse(buf.toString('utf8'));
    }
    const file = PATH.join(PACKAGED_TEMPLATE_DIR, `${name}.json`);
    if (FS.existsSync(file)) {
      return JSON.parse(FS.readFileSync(file, 'utf8'));
    }
    if (SUPPORTED_TEMPLATES.includes(name)) {
      // Built-in template: api Lambda doesn't ship the packaged JSON
      // (compose-edl does). Return a placeholder content so GET /templates/:name
      // still succeeds with builtin=true and surfaces in the picker.
      return {
        Description: `Built-in render template "${name}". Body is shipped with the compose-edl Lambda.`,
        OutputGroups: [],
      };
    }
    throw new M2CException(`template not found: ${name}`);
  }

  async _saveTemplate(name) {
    if (!TEMPLATE_NAME_RE.test(name)) {
      throw new M2CException(`invalid template name: ${name}`);
    }
    const body = this.request.body || {};
    const content = body.content || body;
    if (!content || typeof content !== 'object') {
      throw new M2CException('template body must be a JSON object');
    }
    if (!Array.isArray(content.OutputGroups) || content.OutputGroups.length === 0) {
      throw new M2CException('template must have OutputGroups array');
    }
    const key = `${TEMPLATES_PREFIX}/${name}.json`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify(content), 'utf8')
    );
    return { name, custom: true, builtin: SUPPORTED_TEMPLATES.includes(name) };
  }

  async _deleteTemplate(name) {
    if (!TEMPLATE_NAME_RE.test(name)) {
      throw new M2CException(`invalid template name: ${name}`);
    }
    const key = `${TEMPLATES_PREFIX}/${name}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      return { name, deleted: false };
    }
    await CommonUtils.deleteObject(ProxyBucket, key);
    return { name, deleted: true };
  }
}

module.exports = RendersOp;
