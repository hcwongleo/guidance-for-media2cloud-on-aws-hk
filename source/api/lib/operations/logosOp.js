// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  S3Client,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  getSignedUrl: presignerGetSignedUrl,
} = require('@aws-sdk/s3-request-presigner');
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

// Workspace-shared logo library (added in v4.0.40). Any user can list,
// upload, or delete; chosen logo gets passed inline on Export by S3 URI.
//
// Storage layout: s3://<ProxyBucket>/_shared/logos/<name>.<ext>
// `name` matches the same /^[A-Za-z0-9_-]{1,64}$/ pattern we use
// elsewhere; ext is png|jpg|jpeg.
const LOGOS_PREFIX = '_shared/logos';
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_EXT = ['png', 'jpg', 'jpeg'];

class LogosOp extends BaseOp {
  async onGET() {
    const name = this._logoName();
    if (!name) {
      return super.onGET(await this._listLogos());
    }
    throw new M2CException('GET on a single logo not supported; use the s3uri from list');
  }

  async onPOST() {
    const name = this._logoName();
    if (!name) {
      throw new M2CException('logo name required (POST /logos/{name})');
    }
    return super.onPOST(await this._presignUpload(name));
  }

  async onDELETE() {
    const name = this._logoName();
    if (!name) {
      throw new M2CException('logo name required (DELETE /logos/{name})');
    }
    return super.onDELETE(await this._deleteLogo(name));
  }

  _logoName() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    return raw.split('/').filter((x) => x.length > 0)[0] || '';
  }

  async _listLogos() {
    const items = [];
    let token;
    do {
      const page = await CommonUtils.listObjects(ProxyBucket, `${LOGOS_PREFIX}/`, {
        ContinuationToken: token,
      }).catch(() => undefined);
      const contents = (page && page.Contents) || [];
      const re = new RegExp(`^${LOGOS_PREFIX}/([A-Za-z0-9_-]{1,64})\\.(png|jpe?g)$`, 'i');
      contents.forEach((o) => {
        const m = (o.Key || '').match(re);
        if (!m) return;
        items.push({
          name: m[1],
          ext: m[2].toLowerCase(),
          key: o.Key,
          s3uri: `s3://${ProxyBucket}/${o.Key}`,
          size: o.Size,
          updatedAt: o.LastModified,
        });
      });
      token = (page && page.IsTruncated) ? page.NextContinuationToken : undefined;
    } while (token);
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { logos: items };
  }

  async _presignUpload(name) {
    if (!NAME_RE.test(name)) {
      throw new M2CException('logo name must be A-Z, a-z, 0-9, _, - (max 64 chars)');
    }
    const body = this.request.body || {};
    const ext = String(body.ext || 'png').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      throw new M2CException(`ext must be one of: ${ALLOWED_EXT.join(', ')}`);
    }

    // If the same name already exists with a different ext, remove the
    // old object so we don't end up with two files for one logical
    // name (only one shows up in the picker, but the leftover wastes
    // bytes and confuses listing).
    for (const e of ALLOWED_EXT) {
      if (e === ext) continue;
      const oldKey = `${LOGOS_PREFIX}/${name}.${e}`;
      const exists = await CommonUtils.headObject(ProxyBucket, oldKey).catch(() => undefined);
      if (exists) {
        try { await CommonUtils.deleteObject(ProxyBucket, oldKey); } catch (e2) {
          console.warn(`stale logo cleanup ${oldKey}:`, e2 && e2.message);
        }
      }
    }

    const key = `${LOGOS_PREFIX}/${name}.${ext}`;
    const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const url = await presignerGetSignedUrl(
      new S3Client({}),
      new PutObjectCommand({
        Bucket: ProxyBucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 900 }
    );
    return {
      name,
      ext,
      key,
      url,
      contentType,
      s3uri: `s3://${ProxyBucket}/${key}`,
    };
  }

  async _deleteLogo(name) {
    if (!NAME_RE.test(name)) {
      throw new M2CException('logo name must be A-Z, a-z, 0-9, _, - (max 64 chars)');
    }
    let deleted = 0;
    for (const ext of ALLOWED_EXT) {
      const key = `${LOGOS_PREFIX}/${name}.${ext}`;
      const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
      if (!exists) continue;
      try {
        await CommonUtils.deleteObject(ProxyBucket, key);
        deleted += 1;
      } catch (e) {
        console.error(`deleteObject ${key} failed:`, e.message);
      }
    }
    return { name, deleted };
  }
}

module.exports = LogosOp;
