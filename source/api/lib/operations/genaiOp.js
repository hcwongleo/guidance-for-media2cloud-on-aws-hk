// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const Tokenizer = require('wink-tokenizer')();
const {
  ApiOps: {
    Tokenize,
  },
  M2CException,
  BedrockModel,
} = require('core-lib');
const BaseOp = require('./baseOp');

const SUBOP_TOKENIZE = Tokenize.split('/')[1];

class GenAIOp extends BaseOp {
  async onPOST() {
    const op = this.request.pathParameters.uuid;

    // special case: tokenizing the text
    if (op === SUBOP_TOKENIZE) {
      const tokens = await this.onTokenize();
      return super.onPOST(tokens);
    }

    const params = this.request.body || {};

    if (params.model === undefined
    || params.model.length === 0) {
      throw new M2CException('model name is missing');
    }

    if (params.prompt === undefined
    || params.prompt.length === 0) {
      throw new M2CException('prompt is missing');
    }

    if (params.text_inputs === undefined
    || params.text_inputs.length === 0) {
      throw new M2CException('text input is missing');
    }

    if (!BedrockModel.canSupport()) {
      throw new M2CException('Bedrock region not configured');
    }

    const model = new BedrockModel();
    const response = await model.inference(op, {
      ...params,
      modelId: params.model,
    });

    return super.onPOST(response);
  }

  async onTokenize() {
    const {
      text,
    } = this.request.body || {};

    if (!text) {
      throw new M2CException('invalid text');
    }

    return Tokenizer.tokenize(text);
  }
}

module.exports = GenAIOp;
