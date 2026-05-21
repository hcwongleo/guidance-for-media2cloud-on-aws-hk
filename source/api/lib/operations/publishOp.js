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
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
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
// Shared MediaConvert template store (also used by compose-edl). Mirrors
// the prefix referenced by the /mc-templates API endpoint.
const TEMPLATES_PREFIX = '_mc_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Dedicated CloudFront distribution serving ProxyBucket /*/publish/* (set by webapp-stack)
const PUBLISH_CLOUDFRONT_DOMAIN = process.env.ENV_PUBLISH_CLOUDFRONT_DOMAIN || '';

// Bundle-handoff: produce a single MP4 from a chosen template. No subtitle
// burn-in, no logo overlay. Downstream editors get the MP4 plus the SRT
// (downloaded separately from the transcribe tab) and own all overlay work.
// Each publish runs exactly one MediaConvert job using the selected template;
// the template alone defines orientation, scaling and codec settings.

const DEFAULT_SETTINGS = {
  template: 'mp4_landscape',
  inputClipping: null,
};

class PublishOp extends BaseOp {
  async onGET() {
    const { uuid, subOp } = this._parsePath();
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
    const { uuid, subOp } = this._parsePath();
    if (subOp === '' || subOp === 'start') {
      return super.onPOST(await this._startPublish(uuid));
    }
    if (subOp === 'settings') {
      return super.onPOST(await this._saveSettings(uuid));
    }
    throw new M2CException(`unsupported publish POST op: ${subOp}`);
  }

  async onDELETE() {
    const { uuid, subOp } = this._parsePath();
    if (subOp && subOp.startsWith('outputs/')) {
      const outputId = subOp.slice('outputs/'.length);
      return super.onDELETE(await this._deletePublishOutput(uuid, outputId));
    }
    throw new M2CException('unsupported publish DELETE');
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
    if (typeof body.template === 'string' && body.template.length > 0) {
      if (!TEMPLATE_NAME_RE.test(body.template)) {
        throw new M2CException(`invalid template name: ${body.template}`);
      }
      merged.template = body.template;
    }
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

  async _deletePublishOutput(uuid, outputId) {
    if (!outputId || !/^[A-Za-z0-9_-]{1,64}$/.test(outputId)) {
      throw new M2CException(`invalid outputId: ${outputId}`);
    }

    const status = await _readStatus(uuid);

    // Bulk delete every object under {uuid}/publish/{outputId}/. For HLS-era
    // outputs this is hundreds of segments — DeleteObjectsCommand keeps it
    // under the API Gateway 29s integration timeout.
    const prefix = `${uuid}/${PUBLISH_PREFIX}/${outputId}/`;
    const s3 = new S3Client({});
    let deleted = 0;
    let token;
    do {
      const page = await CommonUtils.listObjects(ProxyBucket, prefix, {
        ContinuationToken: token,
      });
      const contents = (page && page.Contents) || [];
      const objects = contents
        .filter((o) => o && o.Key)
        .map((o) => ({ Key: o.Key }));
      if (objects.length > 0) {
        const res = await s3.send(new DeleteObjectsCommand({
          Bucket: ProxyBucket,
          Delete: { Objects: objects, Quiet: true },
        }));
        deleted += objects.length - ((res && res.Errors) || []).length;
        if (res && Array.isArray(res.Errors)) {
          for (const err of res.Errors) {
            console.error(`DeleteObjects ${err.Key}: ${err.Code} ${err.Message}`);
          }
        }
      }
      token = (page && page.IsTruncated) ? page.NextContinuationToken : undefined;
    } while (token);

    // Remove from current/history.
    if (status) {
      let mutated = false;
      if (status.outputId === outputId) {
        delete status.outputId;
        delete status.output;
        delete status.job;
        delete status.template;
        delete status.errorCode;
        delete status.errorMessage;
        delete status.finishedAt;
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

  async _startPublish(uuid) {
    if (!MediaConvertHost) {
      throw new M2CException('ENV_MEDIACONVERT_HOST not configured');
    }
    if (!DataAccessRole) {
      throw new M2CException('ENV_DATA_ACCESS_ROLE not configured');
    }

    const body = this.request.body || {};
    const stored = await this._getSettings(uuid);
    const settings = { ...stored, ...body };

    const tmplName = settings.template || DEFAULT_SETTINGS.template;
    if (!TEMPLATE_NAME_RE.test(tmplName)) {
      throw new M2CException(`invalid template name: ${tmplName}`);
    }
    const tmpl = await this._loadTemplate(tmplName);

    const sourceUri = await this._resolveSourceUri(uuid);

    const dest = settings.destination || {};
    const outputId = dest.outputId || `vod-${Date.now()}`;
    const mp4Destination = `s3://${ProxyBucket}/${uuid}/${PUBLISH_PREFIX}/${outputId}/`;

    const audioSourceName = 'Audio Selector 1';
    const outputGroups = JSON.parse(JSON.stringify(tmpl.OutputGroups));
    outputGroups.forEach((og) => {
      if (og.OutputGroupSettings.Type === 'FILE_GROUP_SETTINGS') {
        og.OutputGroupSettings.FileGroupSettings.Destination = mp4Destination;
      }
      (og.Outputs || []).forEach((o) => {
        (o.AudioDescriptions || []).forEach((a) => {
          if (a.AudioSourceName === '##AUDIO_SOURCE##') a.AudioSourceName = audioSourceName;
        });
      });
    });

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
        m2cTemplate: tmplName,
      },
      BillingTagsSource: 'JOB',
    };

    const client = new MediaConvertClient({ endpoint: MediaConvertHost });
    const response = await client.send(new CreateJobCommand(jobParams));
    const job = response.Job || {};
    const jobInfo = {
      jobId: job.Id,
      status: job.Status || 'SUBMITTED',
      mp4Destination,
      submittedAt: Date.now(),
    };

    const previous = await _readStatus(uuid);
    const history = Array.isArray(previous && previous.history) ? previous.history.slice() : [];
    if (previous && previous.outputId && previous.outputId !== outputId) {
      const { history: _ignored, ...prevSnapshot } = previous;
      history.unshift(prevSnapshot);
    }
    if (history.length > 20) history.length = 20;

    const status = {
      uuid,
      outputId,
      template: tmplName,
      job: jobInfo,
      status: jobInfo.status,
      submittedAt: Date.now(),
      sourceUri,
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
    if (!data.job || !data.job.jobId) {
      // Status docs from before the single-job redesign aren't supported —
      // surface them as idle so the UI doesn't render stale fields.
      return { uuid, status: 'idle' };
    }

    const updated = { ...data, job: { ...data.job } };
    if (!['COMPLETE', 'ERROR', 'CANCELED'].includes(updated.job.status)) {
      const client = new MediaConvertClient({ endpoint: MediaConvertHost });
      try {
        const response = await client.send(new GetJobCommand({ Id: updated.job.jobId }));
        const job = response.Job || {};
        updated.job = {
          ...updated.job,
          status: job.Status || updated.job.status,
          jobPercentComplete: job.JobPercentComplete,
          currentPhase: job.CurrentPhase,
          errorCode: job.ErrorCode,
          errorMessage: job.ErrorMessage,
          finishedAt: ['COMPLETE', 'ERROR', 'CANCELED'].includes(job.Status) ? Date.now() : undefined,
        };
      } catch (e) {
        updated.job = { ...updated.job, error: e.message };
      }
    }

    updated.status = updated.job.status || 'idle';
    if (updated.status === 'COMPLETE') {
      updated.output = await _findOutputUrl(updated);
    }

    await _writeStatus(uuid, updated);
    return updated;
  }

  async _getOutputs(uuid) {
    const status = await this._getStatus(uuid);
    return {
      uuid,
      status: status.status,
      output: status.output || await _findOutputUrl(status),
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

  async _loadTemplate(name) {
    if (!TEMPLATE_NAME_RE.test(name)) {
      throw new M2CException(`invalid template name: ${name}`);
    }
    // Shared override prefix (managed by /mc-templates) wins over packaged.
    const s3Key = `${TEMPLATES_PREFIX}/${name}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, s3Key).catch(() => undefined);
    if (exists) {
      const buf = await CommonUtils.download(ProxyBucket, s3Key);
      return JSON.parse(buf.toString('utf8'));
    }
    const file = PATH.join(__dirname, 'publish', 'tmpl', `${name}.json`);
    if (!FS.existsSync(file)) {
      throw new M2CException(`template not found: ${name}`);
    }
    return JSON.parse(FS.readFileSync(file, 'utf8'));
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
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `https://${PUBLISH_CLOUDFRONT_DOMAIN}/${encoded}`;
}

async function _findOutputUrl(status) {
  if (!status || !status.job || !status.job.mp4Destination) return undefined;
  const prefix = status.job.mp4Destination.replace(`s3://${ProxyBucket}/`, '');
  try {
    const response = await CommonUtils.listObjects(ProxyBucket, prefix);
    const contents = (response && response.Contents) || [];
    const mp4Key = contents.find((o) => (o.Key || '').endsWith('.mp4'));
    if (!mp4Key) return undefined;
    return {
      key: mp4Key.Key,
      url: _cloudfrontUrl(mp4Key.Key),
      size: mp4Key.Size,
    };
  } catch (e) {
    return undefined;
  }
}

module.exports = PublishOp;
