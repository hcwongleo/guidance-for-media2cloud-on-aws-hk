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

const LOGO_PREFIX = 'output/logo';
const LOGO_SIZES = ['48', '64', '96', '128', '192'];
const ALLOWED_EXT = ['png', 'jpg', 'jpeg'];

class OutputOp extends BaseOp {
  async onGET() {
    throw new M2CException('output GET not supported; use /edits or /renders');
  }

  async onPOST() {
    const { uuid, subOp } = this._parsePath();
    if (subOp === 'logo') {
      return super.onPOST(await this._presignLogoUpload(uuid));
    }
    throw new M2CException(`unsupported output POST op: ${subOp}`);
  }

  async onDELETE() {
    const { uuid, subOp } = this._parsePath();
    if (subOp.startsWith('logo/')) {
      const size = subOp.slice('logo/'.length);
      return super.onDELETE(await this._deleteLogo(uuid, size));
    }
    throw new M2CException('unsupported output DELETE');
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

  async _presignLogoUpload(uuid) {
    const body = this.request.body || {};
    const size = String(body.size || '');
    const ext = String(body.ext || 'png').toLowerCase();
    if (!LOGO_SIZES.includes(size)) {
      throw new M2CException(`size must be one of: ${LOGO_SIZES.join(', ')}`);
    }
    if (!ALLOWED_EXT.includes(ext)) {
      throw new M2CException(`ext must be one of: ${ALLOWED_EXT.join(', ')}`);
    }
    const key = `${uuid}/${LOGO_PREFIX}/logo_${size}.${ext}`;
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
      uuid,
      size,
      ext,
      key,
      url,
      contentType,
      s3uri: `s3://${ProxyBucket}/${key}`,
    };
  }

  async _deleteLogo(uuid, size) {
    if (!LOGO_SIZES.includes(size)) {
      throw new M2CException(`size must be one of: ${LOGO_SIZES.join(', ')}`);
    }
    let deleted = 0;
    for (const ext of ALLOWED_EXT) {
      const key = `${uuid}/${LOGO_PREFIX}/logo_${size}.${ext}`;
      const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
      if (!exists) continue;
      try {
        await CommonUtils.deleteObject(ProxyBucket, key);
        deleted += 1;
      } catch (e) {
        console.error(`deleteObject ${key} failed:`, e.message);
      }
    }
    return { uuid, size, deleted };
  }
}

module.exports = OutputOp;
