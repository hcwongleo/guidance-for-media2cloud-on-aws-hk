// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  ApiOps,
  CommonUtils,
  M2CException,
} = require('core-lib');
const AnalysisOp = require('./operations/analysisOp');
const AssetOp = require('./operations/assetOp');
const IotOp = require('./operations/iotOp');
const SearchOp = require('./operations/searchOp');
const StepOp = require('./operations/stepOp');
const RekognitionOp = require('./operations/rekognitionOp');
const TranscribeOp = require('./operations/transcribeOp');
const ComprehendOp = require('./operations/comprehendOp');
const StatsOp = require('./operations/statsOp');
const UsersOp = require('./operations/usersOp');
const SettingsOp = require('./operations/settingsOp');
const GenAIOp = require('./operations/genaiOp');
const ModelsOp = require('./operations/modelsOp');
const FaceIndexerOp = require('./operations/faceIndexerOp');
const SubtitleOp = require('./operations/subtitleOp');
const OutputOp = require('./operations/outputOp');
const HighlightOp = require('./operations/highlightOp');
const HighlightSettingsOp = require('./operations/highlightSettingsOp');
const EditsOp = require('./operations/editsOp');
const RendersOp = require('./operations/rendersOp');
const McTemplatesOp = require('./operations/mcTemplatesOp');
const SubtitlePromptsOp = require('./operations/subtitlePromptsOp');

const OP_REKOGNITION = 'rekognition';
const OP_TRANSCRIBE = 'transcribe';
const OP_COMPREHEND = 'comprehend';
const OP_SETTINGS = ApiOps.AIOptionsSettings.split('/')[0];
const OP_GENAI = 'genai';
const OP_MODELS = 'models';
const OP_SUBTITLE = 'subtitle';
const OP_OUTPUT = 'output';

class ApiRequest {
  constructor(event, context) {
    this.$event = event;
    this.$context = context;

    const {
      invokedFunctionArn,
    } = context;
    this.$accountId = invokedFunctionArn.split(':')[4];

    const identity = ((event.requestContext || {}).identity || {}).cognitoIdentityId
      || (event.queryStringParameters || {}).requester;

    this.$cognitoIdentityId = (identity)
      ? decodeURIComponent(identity)
      : undefined;

    if (this.$cognitoIdentityId
      && !CommonUtils.validateCognitoIdentityId(this.$cognitoIdentityId)) {
      throw new M2CException('invalid user id');
    }

    try {
      this.$body = JSON.parse(this.$event.body);
    } catch (e) {
      this.$body = this.$event.body;
    }
  }

  get event() {
    return this.$event;
  }

  get context() {
    return this.$context;
  }

  get accountId() {
    return this.$accountId;
  }

  get cognitoIdentityId() {
    return this.$cognitoIdentityId;
  }

  get method() {
    return this.event.httpMethod;
  }

  get path() {
    return this.event.path;
  }

  get headers() {
    return this.event.headers;
  }

  get queryString() {
    return this.event.queryStringParameters;
  }

  get pathParameters() {
    return this.event.pathParameters;
  }

  get body() {
    return this.$body;
  }

  getProcessor() {
    const op = this.pathParameters.operation;
    if (op === ApiOps.AttachPolicy) {
      return new IotOp(this);
    }
    if (op === ApiOps.Assets) {
      return new AssetOp(this);
    }
    if (op === ApiOps.Analysis) {
      return new AnalysisOp(this);
    }
    if (op === ApiOps.Search) {
      return new SearchOp(this);
    }
    if (op === ApiOps.Execution) {
      return new StepOp(this);
    }
    if (op === OP_REKOGNITION) {
      return new RekognitionOp(this);
    }
    if (op === OP_TRANSCRIBE) {
      return new TranscribeOp(this);
    }
    if (op === OP_COMPREHEND) {
      return new ComprehendOp(this);
    }
    if (op === ApiOps.Stats) {
      return new StatsOp(this);
    }
    if (op === ApiOps.Users) {
      return new UsersOp(this);
    }
    if (op === OP_SETTINGS) {
      return new SettingsOp(this);
    }
    if (op === OP_GENAI) {
      return new GenAIOp(this);
    }
    if (op === OP_MODELS) {
      return new ModelsOp(this);
    }
    if (op === OP_SUBTITLE) {
      return new SubtitleOp(this);
    }
    if (op === OP_OUTPUT) {
      return new OutputOp(this);
    }
    if (op === ApiOps.FaceIndexer) {
      return new FaceIndexerOp(this);
    }
    if (op === ApiOps.Highlights) {
      return new HighlightOp(this);
    }
    if (op === ApiOps.HighlightSettings) {
      return new HighlightSettingsOp(this);
    }
    if (op === ApiOps.Edits) {
      return new EditsOp(this);
    }
    if (op === ApiOps.Renders) {
      return new RendersOp(this);
    }
    if (op === 'mc-templates' || op === ApiOps.McTemplates) {
      return new McTemplatesOp(this);
    }
    if (op === 'subtitle-prompts' || op === ApiOps.SubtitlePrompts) {
      return new SubtitlePromptsOp(this);
    }
    throw new M2CException(`operation '${(this.pathParameters || {}).operation}' not supported`);
  }
}

module.exports = ApiRequest;
