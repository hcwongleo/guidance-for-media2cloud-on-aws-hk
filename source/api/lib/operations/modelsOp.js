// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  BedrockClient,
  ListFoundationModelsCommand,
} = require('@aws-sdk/client-bedrock');
const {
  M2CException,
} = require('core-lib');
const BaseOp = require('./baseOp');

const REGION = process.env.ENV_BEDROCK_REGION;
const PROVIDER_WHITELIST = [
  'Amazon',
  'DeepSeek',
  'MiniMax',
  'Moonshot AI',
  'Qwen',
  'Z.AI',
];
const MODEL_ID_DENYLIST = /sonic|rerank|embed/i;

let _cache = null;
let _cacheExpiresAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

class ModelsOp extends BaseOp {
  async onGET() {
    if (!REGION) {
      throw new M2CException('Bedrock region not configured');
    }

    const capability = (this.request.queryString || {}).capability || 'text';
    const result = await _listModels(capability);
    return super.onGET(result);
  }
}

module.exports = ModelsOp;

async function _listModels(capability) {
  if (_cache && Date.now() < _cacheExpiresAt) {
    return _filter(_cache, capability);
  }

  const client = new BedrockClient({ region: REGION });
  const all = [];
  let nextToken;

  do {
    const r = await client.send(new ListFoundationModelsCommand({
      byOutputModality: 'TEXT',
    }));
    all.push(...(r.modelSummaries || []));
    nextToken = r.nextToken;
  } while (nextToken);

  _cache = all
    .filter((m) =>
      PROVIDER_WHITELIST.includes(m.providerName) &&
      (m.modelLifecycle || {}).status === 'ACTIVE' &&
      !MODEL_ID_DENYLIST.test(m.modelId) &&
      ((m.inferenceTypesSupported || []).includes('ON_DEMAND') ||
       (m.inferenceTypesSupported || []).includes('INFERENCE_PROFILE')))
    .map((m) => {
      const types = m.inferenceTypesSupported || [];
      // For INFERENCE_PROFILE-only models, use cross-region inference profile id
      if (!types.includes('ON_DEMAND') && types.includes('INFERENCE_PROFILE')) {
        return { ...m, modelId: `us.${m.modelId}` };
      }
      return m;
    });

  _cacheExpiresAt = Date.now() + CACHE_TTL;

  return _filter(_cache, capability);
}

function _filter(models, capability) {
  if (capability === 'vision') {
    return _group(models.filter((m) =>
      (m.inputModalities || []).includes('IMAGE')));
  }
  if (capability === 'video') {
    return _group(models.filter((m) =>
      (m.inputModalities || []).includes('VIDEO')));
  }
  if (capability === 'text') {
    // Multimodal models like Nova still accept text-only prompts, so include
    // anything with TEXT input — vision/video capability doesn't disqualify.
    return _group(models.filter((m) =>
      (m.inputModalities || []).includes('TEXT')));
  }
  return _group(models);
}

function _group(models) {
  const out = {};
  for (const m of models) {
    out[m.providerName] = out[m.providerName] || [];
    out[m.providerName].push({
      id: m.modelId,
      name: m.modelName,
      modalities: m.inputModalities,
    });
  }
  // ListFoundationModels has no published-date field, so within each provider
  // we sort by modelName alphanumerically. Providers themselves are sorted A-Z
  // by the picker UI when it renders optgroups.
  const cmp = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
  }).compare;
  for (const provider of Object.keys(out)) {
    out[provider].sort((a, b) => cmp(String(a.name), String(b.name)));
  }
  return { providers: out };
}
