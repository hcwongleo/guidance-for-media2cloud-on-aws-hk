// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const PATH = require('path');
const {
  CommonUtils,
  DB,
  Environment: {
    DynamoDB: {
      AIML: {
        Table: AnalysisTable,
        PartitionKey: AnalysisPartitionKey,
        SortKey: AnalysisSortKey,
      },
    },
    Proxy: {
      Bucket: ProxyBucket,
    },
  },
  M2CException,
  SrtHelper,
  WebVttHelper,
  BedrockModel,
} = require('core-lib');
const BaseOp = require('./baseOp');

const SUBTITLE_PREFIX = 'transcode/subtitle';
const DEFAULT_PROMPT = '將以下字幕轉換為書面語繁體中文。要求：1. 保留所有時間碼，不可改動 2. 保留 SRT 編號格式 3. 將口語廣東話轉換為正式書面語繁體中文 4. 保留專有名詞 5. 只輸出有效的 SRT 格式，不要額外說明';
const CHUNK_CUE_SIZE = 80;

class SubtitleOp extends BaseOp {
  async onGET() {
    const { uuid, subOp } = this._parsePath();
    if (subOp === 'srt' || subOp === '') {
      return super.onGET(await this._getSrt(uuid));
    }
    if (subOp === 'prompt') {
      return super.onGET(await this._getPrompt(uuid));
    }
    throw new M2CException(`unsupported subtitle GET op: ${subOp}`);
  }

  async onPOST() {
    const { uuid, subOp } = this._parsePath();
    if (subOp === 'srt' || subOp === '') {
      return super.onPOST(await this._generateSrt(uuid));
    }
    if (subOp === 'ai-edit') {
      return super.onPOST(await this._aiEditSubtitle(uuid));
    }
    if (subOp === 'prompt') {
      return super.onPOST(await this._savePrompt(uuid));
    }
    throw new M2CException(`unsupported subtitle POST op: ${subOp}`);
  }

  _parsePath() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    const parts = raw.split('/').filter((x) => x.length > 0);
    const uuid = parts[0];
    const subOp = parts.slice(1).join('/');
    if (!uuid || !CommonUtils.validateUuid(uuid)) {
      throw new M2CException('invalid uuid');
    }
    return { uuid, subOp };
  }

  async _loadVttPath(uuid) {
    const db = new DB({
      Table: AnalysisTable,
      PartitionKey: AnalysisPartitionKey,
      SortKey: AnalysisSortKey,
    });
    const audio = await db.fetch(uuid, 'audio').catch(() => undefined);
    if (!audio || !audio.transcribe || !audio.transcribe.vtt) {
      throw new M2CException('VTT not found - run transcription first');
    }
    return audio.transcribe.vtt;
  }

  async _generateSrt(uuid) {
    const vttKey = await this._loadVttPath(uuid);
    const vttContent = await CommonUtils.download(ProxyBucket, vttKey);
    const srtContent = SrtHelper.fromVttString(vttContent.toString('utf8'), {
      autoCorrect: true,
      stripLeadingDashes: true,
    });

    const srtKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}.srt`;
    await CommonUtils.uploadFile(ProxyBucket, PATH.dirname(srtKey), PATH.basename(srtKey), Buffer.from(srtContent, 'utf8'));

    const url = await CommonUtils.getSignedUrl({
      Bucket: ProxyBucket,
      Key: srtKey,
    });

    return { uuid, srtKey, url, content: srtContent };
  }

  async _getSrt(uuid) {
    const editedKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}_edited.srt`;
    const plainKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}.srt`;

    let key = editedKey;
    let exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      key = plainKey;
      exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    }
    if (!exists) {
      return await this._generateSrt(uuid);
    }

    const content = (await CommonUtils.download(ProxyBucket, key)).toString('utf8');
    const url = await CommonUtils.getSignedUrl({ Bucket: ProxyBucket, Key: key });
    return { uuid, srtKey: key, url, content };
  }

  async _savePrompt(uuid) {
    const body = this.request.body || {};
    const { prompt } = body;
    if (!prompt) {
      throw new M2CException('prompt is required');
    }
    const key = `${uuid}/${SUBTITLE_PREFIX}/prompt.json`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify({ prompt, updatedAt: Date.now() }), 'utf8')
    );
    return { uuid, prompt };
  }

  async _getPrompt(uuid) {
    const key = `${uuid}/${SUBTITLE_PREFIX}/prompt.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      return { uuid, prompt: DEFAULT_PROMPT, isDefault: true };
    }
    const data = JSON.parse((await CommonUtils.download(ProxyBucket, key)).toString('utf8'));
    return { uuid, prompt: data.prompt, isDefault: false };
  }

  async _aiEditSubtitle(uuid) {
    if (!BedrockModel.canSupport()) {
      throw new M2CException('Bedrock region not configured');
    }

    const body = this.request.body || {};
    const userPrompt = body.prompt || DEFAULT_PROMPT;
    const modelId = body.model;
    if (!modelId) {
      throw new M2CException('model is required');
    }

    const vttKey = await this._loadVttPath(uuid);
    const vttContent = (await CommonUtils.download(ProxyBucket, vttKey)).toString('utf8');
    const parsed = WebVttHelper.parse(vttContent, { autoCorrect: true, stripLeadingDashes: true });
    const cues = parsed.cues || [];
    if (cues.length === 0) {
      throw new M2CException('no cues in VTT');
    }

    const editedCues = await this._processCuesInChunks(cues, userPrompt, modelId);
    const editedSrt = SrtHelper.fromCues(editedCues);

    const editedKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}_edited.srt`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(editedKey),
      PATH.basename(editedKey),
      Buffer.from(editedSrt, 'utf8')
    );

    const url = await CommonUtils.getSignedUrl({ Bucket: ProxyBucket, Key: editedKey });
    return {
      uuid,
      srtKey: editedKey,
      url,
      content: editedSrt,
      cueCount: editedCues.length,
    };
  }

  async _processCuesInChunks(cues, userPrompt, modelId) {
    const model = new BedrockModel();
    const results = [];

    for (let i = 0; i < cues.length; i += CHUNK_CUE_SIZE) {
      const chunk = cues.slice(i, i + CHUNK_CUE_SIZE);
      const chunkSrt = SrtHelper.fromCues(chunk.map((c, idx) => ({
        ...c,
        start: c.start,
        end: c.end,
      })));

      const response = await model.inference('custom', {
        modelId,
        prompt: userPrompt,
        text_inputs: chunkSrt,
      });

      const editedText = ((response.content || [])[0] || {}).text || '';
      const editedSrt = _extractSrtFromResponse(editedText);
      const editedCues = SrtHelper.parseSrt(editedSrt);

      // Map edited text back to original timecodes (preserve them strictly)
      for (let j = 0; j < chunk.length; j += 1) {
        const orig = chunk[j];
        const edited = editedCues[j];
        results.push({
          start: orig.start,
          end: orig.end,
          text: edited ? edited.text : orig.text,
        });
      }
    }
    return results;
  }
}

function _extractSrtFromResponse(text) {
  if (!text) return '';
  // Strip code fences if present
  let out = text.replace(/^```(?:srt|text)?\s*\n/i, '').replace(/\n```\s*$/i, '');
  // Find first numbered cue
  const match = out.match(/^\s*(\d+\s*\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->)/m);
  if (match) {
    out = out.slice(out.indexOf(match[1]));
  }
  return out.trim();
}

module.exports = SubtitleOp;
