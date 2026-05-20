// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const FS = require('fs');
const PATH = require('path');
const {
  MediaConvertClient,
  CreateJobCommand,
  GetJobCommand,
} = require('@aws-sdk/client-mediaconvert');
const {
  S3Client,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  getSignedUrl: presignerGetSignedUrl,
} = require('@aws-sdk/s3-request-presigner');
const {
  CommonUtils,
  DB,
  Environment: {
    DynamoDB: {
      Ingest: {
        Table: IngestTable,
        PartitionKey: IngestPartitionKey,
      },
    },
    Proxy: {
      Bucket: ProxyBucket,
    },
    MediaConvert: {
      Host: MediaConvertHost,
    },
    DataAccess: {
      RoleArn: DataAccessRole,
    },
    Solution: {
      Metrics: {
        Uuid: SolutionUuid,
      },
    },
  },
  M2CException,
} = require('core-lib');

const BaseOp = require('./baseOp');

const PUBLISH_PREFIX = 'publish';
const SETTINGS_FILE = 'settings.json';
const STATUS_FILE = 'job_status.json';
const SUBTITLE_PREFIX = 'transcode/subtitle';
const LOGO_PREFIX = 'publish/logo';
const TEMPLATES_PREFIX = '_publish_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Dedicated CloudFront distribution serving ProxyBucket /*/publish/* (set by webapp-stack)
const PUBLISH_CLOUDFRONT_DOMAIN = process.env.ENV_PUBLISH_CLOUDFRONT_DOMAIN || '';

const TEMPLATE_LANDSCAPE = 'vod_landscape';
const TEMPLATE_PORTRAIT = 'vod_portrait';
const SUPPORTED_TEMPLATES = [TEMPLATE_LANDSCAPE, TEMPLATE_PORTRAIT];

// Logo size buckets keyed by output height (px)
const LOGO_SIZES = ['48', '64', '96', '128', '192'];

const DEFAULT_SETTINGS = {
  template: TEMPLATE_LANDSCAPE,
  fontScript: 'HANT',
  logos: {},
  inputClipping: null,
};

class PublishOp extends BaseOp {
  async onGET() {
    const route = this._parsePath();
    if (route.kind === 'templates') {
      if (!route.templateName) {
        return super.onGET(await this._listTemplates());
      }
      return super.onGET(await this._getTemplate(route.templateName));
    }
    const { uuid, subOp } = route;
    if (subOp === '' || subOp === 'status') {
      return super.onGET(await this._getStatus(uuid));
    }
    if (subOp === 'settings') {
      return super.onGET(await this._getSettings(uuid));
    }
    if (subOp === 'outputs') {
      return super.onGET(await this._getOutputs(uuid));
    }
    throw new M2CException(`unsupported publish GET op: ${subOp}`);
  }

  async onPOST() {
    const route = this._parsePath();
    if (route.kind === 'templates') {
      if (!route.templateName) {
        throw new M2CException('template name required');
      }
      return super.onPOST(await this._saveTemplate(route.templateName));
    }
    const { uuid, subOp } = route;
    if (subOp === '' || subOp === 'start') {
      return super.onPOST(await this._startPublish(uuid));
    }
    if (subOp === 'settings') {
      return super.onPOST(await this._saveSettings(uuid));
    }
    if (subOp === 'logo') {
      return super.onPOST(await this._presignLogoUpload(uuid));
    }
    throw new M2CException(`unsupported publish POST op: ${subOp}`);
  }

  async onDELETE() {
    const route = this._parsePath();
    if (route.kind === 'templates') {
      if (!route.templateName) {
        throw new M2CException('template name required');
      }
      return super.onDELETE(await this._deleteTemplate(route.templateName));
    }
    if (route.subOp && route.subOp.startsWith('outputs/')) {
      const outputId = route.subOp.slice('outputs/'.length);
      return super.onDELETE(await this._deletePublishOutput(route.uuid, outputId));
    }
    throw new M2CException('unsupported publish DELETE');
  }

  async _deletePublishOutput(uuid, outputId) {
    if (!outputId || !/^[A-Za-z0-9_-]{1,64}$/.test(outputId)) {
      throw new M2CException(`invalid outputId: ${outputId}`);
    }

    const status = await _readStatus(uuid);

    // Delete every object under {uuid}/publish/{outputId}/ — handles HLS
    // master/variants/segments and the MP4 group together.
    const prefix = `${uuid}/${PUBLISH_PREFIX}/${outputId}/`;
    let deleted = 0;
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
          deleted += 1;
        } catch (e) {
          console.error(`deleteObject ${obj.Key} failed:`, e.message);
        }
      }
      token = (page && page.IsTruncated) ? page.NextContinuationToken : undefined;
    } while (token);

    // Update status doc: drop entry from current/history.
    if (status) {
      let mutated = false;
      if (status.outputId === outputId) {
        delete status.outputId;
        delete status.outputs;
        delete status.hlsDestination;
        delete status.mp4Destination;
        delete status.jobId;
        delete status.jobPercentComplete;
        delete status.currentPhase;
        delete status.errorCode;
        delete status.errorMessage;
        delete status.finishedAt;
        delete status.template;
        status.status = 'idle';
        mutated = true;
      }
      if (Array.isArray(status.history)) {
        const before = status.history.length;
        status.history = status.history.filter((h) => h && h.outputId !== outputId);
        if (status.history.length !== before) mutated = true;
      }
      if (mutated) {
        await _writeStatus(uuid, status);
      }
    }

    return { uuid, outputId, deleted };
  }

  // Convert s3://<ProxyBucket>/<key> → https://<publish-cloudfront-domain>/<key>
  // (no-op for non-s3 URIs and when CloudFront domain is not configured)
  _toCloudFrontUrl(uri) {
    if (!PUBLISH_CLOUDFRONT_DOMAIN || typeof uri !== 'string' || !uri.startsWith('s3://')) {
      return uri;
    }
    const rest = uri.slice('s3://'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return uri;
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    if (bucket !== ProxyBucket) return uri;
    return `https://${PUBLISH_CLOUDFRONT_DOMAIN}/${key}`;
  }

  _parsePath() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    const parts = raw.split('/').filter((x) => x.length > 0);
    if (parts[0] === 'templates') {
      const templateName = parts[1] || '';
      if (templateName && !TEMPLATE_NAME_RE.test(templateName)) {
        throw new M2CException('invalid template name (allowed: A-Z, a-z, 0-9, _, -; up to 64 chars)');
      }
      return { kind: 'templates', templateName };
    }
    const uuid = parts[0];
    const subOp = parts.slice(1).join('/');
    if (!uuid || !CommonUtils.validateUuid(uuid)) {
      throw new M2CException('invalid uuid');
    }
    return { kind: 'asset', uuid, subOp };
  }

  async _getSettings(uuid) {
    const key = `${uuid}/${PUBLISH_PREFIX}/${SETTINGS_FILE}`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      return { uuid, ...DEFAULT_SETTINGS, isDefault: true };
    }
    const data = JSON.parse((await CommonUtils.download(ProxyBucket, key)).toString('utf8'));
    return { uuid, ...DEFAULT_SETTINGS, ...data, isDefault: false };
  }

  async _saveSettings(uuid) {
    const body = this.request.body || {};
    const merged = { ...DEFAULT_SETTINGS };
    if (body.template) {
      if (!TEMPLATE_NAME_RE.test(body.template)) {
        throw new M2CException(`invalid template name: ${body.template}`);
      }
      merged.template = body.template;
    }
    if (body.fontScript) merged.fontScript = body.fontScript;
    if (body.logos && typeof body.logos === 'object') merged.logos = body.logos;
    if (body.inputClipping !== undefined) merged.inputClipping = body.inputClipping;
    merged.updatedAt = Date.now();

    const key = `${uuid}/${PUBLISH_PREFIX}/${SETTINGS_FILE}`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify(merged), 'utf8')
    );
    return { uuid, ...merged };
  }

  async _presignLogoUpload(uuid) {
    const body = this.request.body || {};
    const size = String(body.size || '');
    const ext = String(body.ext || 'png').toLowerCase();
    if (!LOGO_SIZES.includes(size)) {
      throw new M2CException(`size must be one of: ${LOGO_SIZES.join(', ')}`);
    }
    if (!['png', 'jpg', 'jpeg'].includes(ext)) {
      throw new M2CException('ext must be png, jpg, or jpeg');
    }
    const key = `${uuid}/${LOGO_PREFIX}/logo_${size}.${ext}`;
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const s3Client = new S3Client({});
    const url = await presignerGetSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: ProxyBucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 900 }
    );
    return {
      uuid,
      size,
      key,
      url,
      contentType,
      s3uri: `s3://${ProxyBucket}/${key}`,
    };
  }

  async _startPublish(uuid) {
    if (!MediaConvertHost) {
      throw new M2CException('ENV_MEDIACONVERT_HOST not configured');
    }
    if (!DataAccessRole) {
      throw new M2CException('ENV_DATA_ACCESS_ROLE not configured');
    }

    const body = this.request.body || {};

    // Resolve effective settings: stored settings overlaid by request body
    const stored = await this._getSettings(uuid);
    const settings = {
      ...stored,
      ...body,
    };

    const templateName = settings.template || TEMPLATE_LANDSCAPE;
    if (!TEMPLATE_NAME_RE.test(templateName)) {
      throw new M2CException(`invalid template name: ${templateName}`);
    }

    const sourceUri = await this._resolveSourceUri(uuid);
    const srtUri = await this._resolveSrtUri(uuid);

    const dest = settings.destination || {};
    const outputId = dest.outputId || `vod-${Date.now()}`;
    const outputBase = `${uuid}/${PUBLISH_PREFIX}/${outputId}`;
    const hlsDestination = `s3://${ProxyBucket}/${outputBase}/hls/`;
    const mp4Destination = `s3://${ProxyBucket}/${outputBase}/mp4/`;

    const tmpl = await this._loadTemplate(templateName);
    const outputGroups = JSON.parse(JSON.stringify(tmpl.OutputGroups));

    const audioSourceName = 'Audio Selector 1';
    const captionSourceName = 'Captions Selector 1';
    const fontScript = settings.fontScript || 'HANT';
    const logos = settings.logos || {};

    outputGroups.forEach((og) => {
      if (og.OutputGroupSettings.Type === 'HLS_GROUP_SETTINGS') {
        og.OutputGroupSettings.HlsGroupSettings.Destination = hlsDestination;
      } else if (og.OutputGroupSettings.Type === 'FILE_GROUP_SETTINGS') {
        og.OutputGroupSettings.FileGroupSettings.Destination = mp4Destination;
      }
      (og.Outputs || []).forEach((o) => {
        (o.AudioDescriptions || []).forEach((a) => {
          if (a.AudioSourceName === '##AUDIO_SOURCE##') a.AudioSourceName = audioSourceName;
        });
        (o.CaptionDescriptions || []).forEach((c) => {
          if (c.CaptionSelectorName === '##CAPTION_SOURCE##') c.CaptionSelectorName = captionSourceName;
          const burn = (c.DestinationSettings || {}).BurninDestinationSettings;
          if (burn && burn.FontScript === '##FONT_SCRIPT##') burn.FontScript = fontScript;
        });
        // Substitute ##LOGO_NN## placeholders or strip ImageInserter when no logo configured.
        // Templates bake position/layer per rendition; we only resolve the URI from settings.logos[size].
        // MediaConvert SMART_CROP+ImageInserter requires HTTP(S) URLs, not s3:// URIs (verified
        // against working reference job): with s3:// the overlay silently fails (warning 250000)
        // and no logo is rendered. We convert s3://<ProxyBucket>/<key> → https://<cf-domain>/<key>
        // using the publish CloudFront distribution that already fronts /*/publish/* on the bucket.
        const inserter = ((o.VideoDescription || {}).VideoPreprocessors || {}).ImageInserter;
        if (inserter && Array.isArray(inserter.InsertableImages)) {
          const resolved = [];
          inserter.InsertableImages.forEach((img) => {
            const m = (img.ImageInserterInput || '').match(/^##LOGO_(\d+)##$/);
            if (!m) {
              resolved.push(img);
              return;
            }
            const size = m[1];
            if (logos[size]) {
              resolved.push({ ...img, ImageInserterInput: this._toCloudFrontUrl(logos[size]) });
            }
            // else: drop this image — no logo configured at this size
          });
          if (resolved.length > 0) {
            inserter.InsertableImages = resolved;
          } else {
            delete o.VideoDescription.VideoPreprocessors.ImageInserter;
            if (Object.keys(o.VideoDescription.VideoPreprocessors).length === 0) {
              delete o.VideoDescription.VideoPreprocessors;
            }
          }
        }
      });
    });

    // Build CaptionSelector if SRT is available
    const captionSelectors = {};
    if (srtUri) {
      captionSelectors[captionSourceName] = {
        SourceSettings: {
          SourceType: 'SRT',
          FileSourceSettings: {
            SourceFile: srtUri,
          },
        },
      };
    } else {
      // No SRT: strip caption descriptions from all outputs to avoid validation errors
      outputGroups.forEach((og) => {
        (og.Outputs || []).forEach((o) => {
          delete o.CaptionDescriptions;
        });
      });
    }

    const input = {
      AudioSelectors: {
        [audioSourceName]: {
          Offset: 0,
          DefaultSelection: 'DEFAULT',
          ProgramSelection: 1,
        },
      },
      VideoSelector: { AlphaBehavior: 'DISCARD', ColorSpace: 'FOLLOW', Rotate: 'DEGREE_0' },
      FilterEnable: 'AUTO',
      PsiControl: 'USE_PSI',
      FilterStrength: 0,
      DeblockFilter: 'DISABLED',
      DenoiseFilter: 'DISABLED',
      TimecodeSource: 'ZEROBASED',
      FileInput: sourceUri,
    };
    if (Object.keys(captionSelectors).length > 0) {
      input.CaptionSelectors = captionSelectors;
    }
    if (settings.inputClipping
      && settings.inputClipping.StartTimecode
      && settings.inputClipping.EndTimecode) {
      input.InputClippings = [{
        StartTimecode: settings.inputClipping.StartTimecode,
        EndTimecode: settings.inputClipping.EndTimecode,
      }];
    }

    const jobParams = {
      Role: DataAccessRole,
      Settings: {
        OutputGroups: outputGroups,
        AdAvailOffset: 0,
        FollowSource: 1,
        Inputs: [input],
      },
      StatusUpdateInterval: 'SECONDS_60',
      AccelerationSettings: { Mode: 'DISABLED' },
      UserMetadata: {
        solutionUuid: SolutionUuid || '',
        m2cUuid: uuid,
        m2cOutputId: outputId,
        m2cTemplate: templateName,
      },
      BillingTagsSource: 'JOB',
    };

    const client = new MediaConvertClient({ endpoint: MediaConvertHost });
    const response = await client.send(new CreateJobCommand(jobParams));
    const job = response.Job || {};

    // Carry prior job into history so the UI can show all past outputs.
    // Newest-first; cap at 20 entries to bound the status doc size.
    const previous = await _readStatus(uuid);
    const history = Array.isArray(previous && previous.history) ? previous.history.slice() : [];
    if (previous && previous.jobId && previous.jobId !== job.Id) {
      const { history: _ignored, ...prevSnapshot } = previous;
      history.unshift(prevSnapshot);
    }
    if (history.length > 20) history.length = 20;

    const status = {
      uuid,
      outputId,
      template: templateName,
      jobId: job.Id,
      status: job.Status || 'SUBMITTED',
      submittedAt: Date.now(),
      hlsDestination,
      mp4Destination,
      history,
    };

    await _writeStatus(uuid, status);
    return status;
  }

  async _getStatus(uuid) {
    const key = `${uuid}/${PUBLISH_PREFIX}/${STATUS_FILE}`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      return { uuid, status: 'idle' };
    }
    const data = JSON.parse((await CommonUtils.download(ProxyBucket, key)).toString('utf8'));
    if (!data.jobId) {
      return { uuid, ...data };
    }

    const client = new MediaConvertClient({ endpoint: MediaConvertHost });
    let job;
    try {
      const response = await client.send(new GetJobCommand({ Id: data.jobId }));
      job = response.Job || {};
    } catch (e) {
      return { uuid, ...data, error: e.message };
    }

    const updated = {
      ...data,
      status: job.Status || data.status,
      jobPercentComplete: job.JobPercentComplete,
      currentPhase: job.CurrentPhase,
      errorCode: job.ErrorCode,
      errorMessage: job.ErrorMessage,
      finishedAt: ['COMPLETE', 'ERROR', 'CANCELED'].includes(job.Status) ? Date.now() : undefined,
    };

    if (job.Status === 'COMPLETE') {
      updated.outputs = await _listOutputUrls(updated);
    }

    await _writeStatus(uuid, updated);
    return updated;
  }

  async _getOutputs(uuid) {
    const status = await this._getStatus(uuid);
    return {
      uuid,
      status: status.status,
      outputs: status.outputs || await _listOutputUrls(status),
    };
  }

  async _resolveSourceUri(uuid) {
    // Use the originally ingested file as the publish source. The "aiml" proxy is
    // explicitly downscaled (e.g. 960x540) for inference and produces soft 1080p
    // output when MediaConvert is forced to upscale; the original carries full
    // resolution. The MediaConvert ServiceDataAccessRole already has GetObject on
    // the ingest bucket. Fall back to a "prod" proxy if an original is unavailable;
    // never fall back to "aiml" — the resolution loss outweighs convenience.
    const ingestDb = new DB({
      Table: IngestTable,
      PartitionKey: IngestPartitionKey,
    });
    const ingest = await ingestDb.fetch(uuid).catch(() => undefined);

    if (ingest && ingest.bucket && ingest.key) {
      return `s3://${ingest.bucket}/${ingest.key}`;
    }

    const proxies = (ingest || {}).proxies || [];
    const videoProxies = proxies.filter((p) =>
      p.type === 'video' && (p.key || '').toLowerCase().endsWith('.mp4'));
    const prod = videoProxies.find((p) => p.outputType === 'prod');
    if (prod && prod.key) {
      return `s3://${ProxyBucket}/${prod.key}`;
    }

    throw new M2CException('cannot resolve source video for publish');
  }

  async _resolveSrtUri(uuid) {
    const editedKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}_edited.srt`;
    const plainKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}.srt`;
    let exists = await CommonUtils.headObject(ProxyBucket, editedKey).catch(() => undefined);
    if (exists) {
      return `s3://${ProxyBucket}/${editedKey}`;
    }
    exists = await CommonUtils.headObject(ProxyBucket, plainKey).catch(() => undefined);
    if (exists) {
      return `s3://${ProxyBucket}/${plainKey}`;
    }
    return undefined;
  }

  // ---------- template management ----------

  async _loadTemplate(name) {
    if (!TEMPLATE_NAME_RE.test(name)) {
      throw new M2CException(`invalid template name: ${name}`);
    }
    // S3 override / custom template takes precedence
    const s3Key = `${TEMPLATES_PREFIX}/${name}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, s3Key).catch(() => undefined);
    if (exists) {
      const buf = await CommonUtils.download(ProxyBucket, s3Key);
      return JSON.parse(buf.toString('utf8'));
    }
    // Fall back to packaged built-in
    const file = PATH.join(__dirname, 'publish', 'tmpl', `${name}.json`);
    if (!FS.existsSync(file)) {
      throw new M2CException(`template not found: ${name}`);
    }
    return JSON.parse(FS.readFileSync(file, 'utf8'));
  }

  async _listTemplates() {
    const items = new Map();
    SUPPORTED_TEMPLATES.forEach((n) => items.set(n, { name: n, builtin: true, custom: false }));

    let response;
    try {
      response = await CommonUtils.listObjects(ProxyBucket, `${TEMPLATES_PREFIX}/`);
    } catch (e) {
      response = undefined;
    }
    const contents = (response && response.Contents) || [];
    contents.forEach((o) => {
      const m = (o.Key || '').match(/^_publish_templates\/([A-Za-z0-9_-]{1,64})\.json$/);
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

  async _saveTemplate(name) {
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
      // For built-ins this means "no override to delete" — that's fine, no-op.
      // For custom names, also no-op (idempotent).
      return { name, deleted: false };
    }
    await CommonUtils.deleteObject(ProxyBucket, key);
    return { name, deleted: true };
  }
}

async function _writeStatus(uuid, data) {
  const key = `${uuid}/${PUBLISH_PREFIX}/${STATUS_FILE}`;
  await CommonUtils.uploadFile(
    ProxyBucket,
    PATH.dirname(key),
    PATH.basename(key),
    Buffer.from(JSON.stringify(data), 'utf8')
  );
}

async function _readStatus(uuid) {
  const key = `${uuid}/${PUBLISH_PREFIX}/${STATUS_FILE}`;
  const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
  if (!exists) return undefined;
  try {
    const buf = await CommonUtils.download(ProxyBucket, key);
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return undefined;
  }
}

function _cloudfrontUrl(key) {
  if (!PUBLISH_CLOUDFRONT_DOMAIN || !key) return undefined;
  // CloudFront expects each path segment URL-encoded but with '/' preserved.
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `https://${PUBLISH_CLOUDFRONT_DOMAIN}/${encoded}`;
}

async function _listOutputUrls(status) {
  const result = { hlsMaster: undefined, mp4: undefined };
  if (!status || !status.hlsDestination) return result;

  const hlsPrefix = status.hlsDestination.replace(`s3://${ProxyBucket}/`, '');
  const mp4Prefix = status.mp4Destination.replace(`s3://${ProxyBucket}/`, '');

  try {
    const hlsResponse = await CommonUtils.listObjects(ProxyBucket, hlsPrefix);
    const hlsContents = (hlsResponse && hlsResponse.Contents) || [];
    const masterKey = hlsContents.find((o) => o.Key.endsWith('.m3u8') && !o.Key.match(/_\d+p\.m3u8$/));
    if (masterKey) {
      result.hlsMasterKey = masterKey.Key;
      result.hlsMaster = _cloudfrontUrl(masterKey.Key);
    }
  } catch (e) {
    // ignore
  }

  try {
    const mp4Response = await CommonUtils.listObjects(ProxyBucket, mp4Prefix);
    const mp4Contents = (mp4Response && mp4Response.Contents) || [];
    const mp4Key = mp4Contents.find((o) => o.Key.endsWith('.mp4'));
    if (mp4Key) {
      result.mp4Key = mp4Key.Key;
      result.mp4 = _cloudfrontUrl(mp4Key.Key);
    }
  } catch (e) {
    // ignore
  }

  return result;
}

module.exports = PublishOp;
