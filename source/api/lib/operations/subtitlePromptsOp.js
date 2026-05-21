// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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

const PROMPTS_PREFIX = '_settings/subtitle-prompts';
const PROMPT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_NAME = 'default';
const DEFAULT_PROMPT = '將以下字幕轉換為書面語繁體中文。要求：1. 保留所有時間碼，不可改動 2. 保留 SRT 編號格式 3. 將口語廣東話轉換為正式書面語繁體中文 4. 保留專有名詞 5. 只輸出有效的 SRT 格式，不要額外說明';

class SubtitlePromptsOp extends BaseOp {
  async onGET() {
    const name = this._promptName();
    if (!name) {
      return super.onGET(await this._listPrompts());
    }
    return super.onGET(await this._getPrompt(name));
  }

  async onPOST() {
    const name = this._promptName();
    if (!name) {
      throw new M2CException('prompt name required');
    }
    return super.onPOST(await this._savePrompt(name));
  }

  async onDELETE() {
    const name = this._promptName();
    if (!name) {
      throw new M2CException('prompt name required');
    }
    return super.onDELETE(await this._deletePrompt(name));
  }

  _promptName() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    return raw.split('/').filter((x) => x.length > 0)[0] || '';
  }

  async _listPrompts() {
    await this._seedDefaultIfMissing();
    const response = await CommonUtils.listObjects(ProxyBucket, `${PROMPTS_PREFIX}/`)
      .catch(() => undefined);
    const contents = (response && response.Contents) || [];
    const re = new RegExp(`^${PROMPTS_PREFIX}/([A-Za-z0-9_-]{1,64})\\.json$`);
    const items = [];
    for (const o of contents) {
      const m = (o.Key || '').match(re);
      if (!m) continue;
      const name = m[1];
      const prompt = await this._loadPromptText(name);
      items.push({ name, prompt, lastModified: o.LastModified });
    }
    items.sort((a, b) => {
      if (a.name === DEFAULT_NAME) return -1;
      if (b.name === DEFAULT_NAME) return 1;
      return a.name.localeCompare(b.name);
    });
    return { prompts: items };
  }

  async _seedDefaultIfMissing() {
    const key = `${PROMPTS_PREFIX}/${DEFAULT_NAME}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (exists) return;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify({ name: DEFAULT_NAME, prompt: DEFAULT_PROMPT }), 'utf8')
    );
  }

  async _loadPromptText(name) {
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    const buf = await CommonUtils.download(ProxyBucket, key);
    const data = JSON.parse(buf.toString('utf8'));
    return data.prompt || '';
  }

  async _getPrompt(name) {
    if (!PROMPT_NAME_RE.test(name)) {
      throw new M2CException(`invalid prompt name: ${name}`);
    }
    if (name === DEFAULT_NAME) {
      await this._seedDefaultIfMissing();
    }
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    const head = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!head) {
      throw new M2CException(`prompt not found: ${name}`);
    }
    const prompt = await this._loadPromptText(name);
    return { name, prompt, lastModified: head.LastModified };
  }

  async _savePrompt(name) {
    if (!PROMPT_NAME_RE.test(name)) {
      throw new M2CException(`invalid prompt name: ${name}`);
    }
    const body = this.request.body || {};
    const prompt = body.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new M2CException('prompt body must be a non-empty string');
    }
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify({ name, prompt }), 'utf8')
    );
    return { name, prompt };
  }

  async _deletePrompt(name) {
    if (!PROMPT_NAME_RE.test(name)) {
      throw new M2CException(`invalid prompt name: ${name}`);
    }
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      return { name, deleted: false };
    }
    await CommonUtils.deleteObject(ProxyBucket, key);
    return { name, deleted: true };
  }
}

module.exports = SubtitlePromptsOp;
