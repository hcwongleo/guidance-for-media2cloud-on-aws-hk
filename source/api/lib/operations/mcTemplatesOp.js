// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const FS = require('fs');
const PATH = require('path');
const {
  CommonUtils,
  Environment: {
    Proxy: {
      Bucket: ProxyBucket,
    },
  },
  M2CException,
} = require('core-lib');
const BaseOp = require('./baseOp');

// Shared MediaConvert template store for both Publish (single-input encode)
// and Highlight Render (clip-and-stitch). Both Lambdas read from this same
// S3 prefix and ship identical packaged JSONs as fallback.
const TEMPLATES_PREFIX = '_mc_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SUPPORTED_TEMPLATES = ['mp4_landscape', 'mp4_portrait'];

// Packaged JSONs ship under output/tmpl. compose-edl Lambda carries the same
// JSONs so renders work even when the api Lambda hasn't been redeployed.
const PACKAGED_TEMPLATE_DIR = PATH.join(__dirname, 'output', 'tmpl');

class McTemplatesOp extends BaseOp {
  async onGET() {
    const name = this._templateName();
    if (!name) {
      return super.onGET(await this._listTemplates());
    }
    return super.onGET(await this._getTemplate(name));
  }

  async onPOST() {
    const name = this._templateName();
    if (!name) {
      throw new M2CException('template name required');
    }
    return super.onPOST(await this._saveTemplate(name));
  }

  async onDELETE() {
    const name = this._templateName();
    if (!name) {
      throw new M2CException('template name required');
    }
    return super.onDELETE(await this._deleteTemplate(name));
  }

  _templateName() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    return raw.split('/').filter((x) => x.length > 0)[0] || '';
  }

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
    const re = new RegExp(`^${TEMPLATES_PREFIX}/([A-Za-z0-9_-]{1,64})\\.json$`);
    contents.forEach((o) => {
      const m = (o.Key || '').match(re);
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
      // compose-edl carries the canonical packaged JSON; api Lambda may not
      // ship it. Return a placeholder so GET still succeeds.
      return {
        Description: `Built-in MediaConvert template "${name}". Body is shipped with the encode Lambda.`,
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

module.exports = McTemplatesOp;
