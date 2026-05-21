// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const PATH = require('path');
const {
  LambdaClient,
  InvokeCommand,
} = require('@aws-sdk/client-lambda');
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');
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

const BEDROCK_REGION = process.env.ENV_BEDROCK_REGION;
const SUBTITLE_SYSTEM_PROMPT = 'You are a professional subtitle editor. Follow the user\'s instructions exactly. The user will provide an SRT chunk (sequence number, timecode, then subtitle text). Return ONLY a valid SRT chunk back, with the same number of cues, in the same order, and with the same sequence numbers and timecodes. Do not add code fences, commentary, or explanation.';

const STATUS_FILE = 'aiedit_status.json';

const EDITED_SUFFIX = '_edited.srt';
const BaseOp = require('./baseOp');

const SUBTITLE_PREFIX = 'transcode/subtitle';
const DEFAULT_PROMPT = '將以下字幕轉換為書面語繁體中文。要求：1. 保留所有時間碼，不可改動 2. 保留 SRT 編號格式 3. 將口語廣東話轉換為正式書面語繁體中文 4. 保留專有名詞 5. 只輸出有效的 SRT 格式，不要額外說明';
const CHUNK_CUE_SIZE = 80;
const CHUNK_CONCURRENCY = 6;

class SubtitleOp extends BaseOp {
  async onGET() {
    const { uuid, subOp } = this._parsePath();
    if (subOp === 'srt' || subOp === '') {
      return super.onGET(await this._getSrt(uuid));
    }
    if (subOp === 'prompt') {
      return super.onGET(await this._getPrompt(uuid));
    }
    if (subOp === 'ai-edit-status') {
      return super.onGET(await this._getAiEditStatus(uuid));
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
    if (subOp === 'save-srt') {
      return super.onPOST(await this._saveSrt(uuid));
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

    const cues = SrtHelper.parseSrt(srtContent);
    return { uuid, srtKey, url, content: srtContent, cues };
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
    const cues = SrtHelper.parseSrt(content);
    return { uuid, srtKey: key, url, content, cues };
  }

  async _saveSrt(uuid) {
    const body = this.request.body || {};
    const { cues, content } = body;
    let srt;
    if (typeof content === 'string' && content.trim().length > 0) {
      srt = content;
    } else if (Array.isArray(cues) && cues.length > 0) {
      srt = SrtHelper.fromCues(cues.map((c) => ({
        start: Number(c.start),
        end: Number(c.end),
        text: String(c.text || ''),
      })));
    } else {
      throw new M2CException('cues or content is required');
    }

    const editedKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}${EDITED_SUFFIX}`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(editedKey),
      PATH.basename(editedKey),
      Buffer.from(srt, 'utf8')
    );
    const url = await CommonUtils.getSignedUrl({ Bucket: ProxyBucket, Key: editedKey });
    const parsedCues = SrtHelper.parseSrt(srt);
    return { uuid, srtKey: editedKey, url, content: srt, cues: parsedCues };
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

    const startedAt = Date.now();
    await SubtitleOp._writeStatus(uuid, {
      status: 'processing',
      startedAt,
      modelId,
    });

    const fnName = process.env.AWS_LAMBDA_FUNCTION_NAME;
    const client = new LambdaClient({});
    await client.send(new InvokeCommand({
      FunctionName: fnName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({
        _asyncJob: {
          type: 'aiEditSubtitle',
          uuid,
          modelId,
          prompt: userPrompt,
          startedAt,
        },
      })),
    }));

    return {
      uuid,
      status: 'processing',
      startedAt,
      modelId,
    };
  }

  async _getAiEditStatus(uuid) {
    const key = `${uuid}/${SUBTITLE_PREFIX}/${STATUS_FILE}`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      return { uuid, status: 'idle' };
    }
    const data = JSON.parse((await CommonUtils.download(ProxyBucket, key)).toString('utf8'));
    return { uuid, ...data };
  }

  static async _writeStatus(uuid, status) {
    const key = `${uuid}/${SUBTITLE_PREFIX}/${STATUS_FILE}`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify(status), 'utf8')
    );
  }

  static async runAiEditAsync(job) {
    const { uuid, modelId, prompt: userPrompt, startedAt } = job;
    try {
      const db = new DB({
        Table: AnalysisTable,
        PartitionKey: AnalysisPartitionKey,
        SortKey: AnalysisSortKey,
      });
      const audio = await db.fetch(uuid, 'audio').catch(() => undefined);
      if (!audio || !audio.transcribe || !audio.transcribe.vtt) {
        throw new Error('VTT not found - run transcription first');
      }
      const vttKey = audio.transcribe.vtt;
      const vttContent = (await CommonUtils.download(ProxyBucket, vttKey)).toString('utf8');
      const parsed = WebVttHelper.parse(vttContent, { autoCorrect: true, stripLeadingDashes: true });
      const cues = parsed.cues || [];
      if (cues.length === 0) {
        throw new Error('no cues in VTT');
      }

      const editedCues = await SubtitleOp._processCuesInChunksStatic(uuid, cues, userPrompt, modelId, startedAt);
      const editedSrt = SrtHelper.fromCues(editedCues);

      const editedKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}_edited.srt`;
      await CommonUtils.uploadFile(
        ProxyBucket,
        PATH.dirname(editedKey),
        PATH.basename(editedKey),
        Buffer.from(editedSrt, 'utf8')
      );

      const url = await CommonUtils.getSignedUrl({ Bucket: ProxyBucket, Key: editedKey });

      await SubtitleOp._writeStatus(uuid, {
        status: 'completed',
        startedAt,
        completedAt: Date.now(),
        modelId,
        srtKey: editedKey,
        url,
        content: editedSrt,
        cues: editedCues,
        cueCount: editedCues.length,
      });
      return { ok: true };
    } catch (e) {
      console.error('runAiEditAsync error:', e);
      await SubtitleOp._writeStatus(uuid, {
        status: 'failed',
        startedAt,
        failedAt: Date.now(),
        error: e.message || String(e),
      }).catch(() => undefined);
      return { ok: false, error: e.message };
    }
  }

  static async _processCuesInChunksStatic(uuid, cues, userPrompt, modelId, startedAt) {
    const client = new BedrockRuntimeClient({ region: BEDROCK_REGION });
    const total = Math.ceil(cues.length / CHUNK_CUE_SIZE);

    const chunks = [];
    for (let i = 0; i < cues.length; i += CHUNK_CUE_SIZE) {
      chunks.push(cues.slice(i, i + CHUNK_CUE_SIZE));
    }

    const editChunk = async (chunk, chunkIdx) => {
      const chunkSrt = SrtHelper.fromCues(chunk.map((c) => ({
        start: c.start,
        end: c.end,
        text: c.text,
      })));

      const userMessage = `${userPrompt}\n\nSRT chunk to edit:\n${chunkSrt}`;
      const command = new ConverseCommand({
        modelId,
        system: [{ text: SUBTITLE_SYSTEM_PROMPT }],
        messages: [
          { role: 'user', content: [{ text: userMessage }] },
        ],
        inferenceConfig: { temperature: 0.2, maxTokens: 8192 },
      });

      const response = await client.send(command);
      const editedText = ((response.output.message.content || [])[0] || {}).text || '';
      const editedSrt = _extractSrtFromResponse(editedText);
      const editedCues = SrtHelper.parseSrt(editedSrt);

      console.log(`[ai-edit chunk ${chunkIdx + 1}/${total}] req=${chunk.length} got=${editedCues.length} preview=${(editedCues[0] || {}).text || '(empty)'}`);

      return chunk.map((orig, j) => {
        const edited = editedCues[j];
        return {
          start: orig.start,
          end: orig.end,
          text: edited && edited.text ? edited.text : orig.text,
        };
      });
    };

    const results = new Array(cues.length);
    let nextChunkIdx = 0;
    let chunksDone = 0;

    const worker = async () => {
      while (true) {
        const chunkIdx = nextChunkIdx;
        if (chunkIdx >= chunks.length) {
          return;
        }
        nextChunkIdx += 1;
        const chunk = chunks[chunkIdx];
        const editedChunk = await editChunk(chunk, chunkIdx);
        const offset = chunkIdx * CHUNK_CUE_SIZE;
        for (let j = 0; j < editedChunk.length; j += 1) {
          results[offset + j] = editedChunk[j];
        }
        chunksDone += 1;
        const cuesProcessed = chunksDone * CHUNK_CUE_SIZE > cues.length
          ? cues.length
          : chunksDone * CHUNK_CUE_SIZE;
        await SubtitleOp._writeStatus(uuid, {
          status: 'processing',
          startedAt,
          modelId,
          progress: { chunk: chunksDone, total, cuesProcessed, cueCount: cues.length },
        }).catch(() => undefined);
      }
    };

    const concurrency = Math.min(CHUNK_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

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
