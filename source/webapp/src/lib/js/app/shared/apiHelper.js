// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import SolutionManifest from '/solution-manifest.js';
import AuthHttpRequest from './authHttpRequest.js';

const {
  ApiEndpoint,
  ApiOps,
  KnowledgeGraph,
  Shoppable,
} = SolutionManifest;

const ENDPOINTS = {
  Asset: `${ApiEndpoint}/${ApiOps.Assets}`,
  Analysis: `${ApiEndpoint}/${ApiOps.Analysis}`,
  Search: `${ApiEndpoint}/${ApiOps.Search}`,
  Execution: `${ApiEndpoint}/${ApiOps.Execution}`,
  AttachIot: `${ApiEndpoint}/${ApiOps.AttachPolicy}`,
  FaceCollections: `${ApiEndpoint}/${ApiOps.FaceCollections}`,
  FaceCollection: `${ApiEndpoint}/${ApiOps.FaceCollection}`,
  Faces: `${ApiEndpoint}/${ApiOps.Faces}`,
  Face: `${ApiEndpoint}/${ApiOps.Face}`,
  CustomLabelModels: `${ApiEndpoint}/${ApiOps.CustomLabelModels}`,
  CustomVocabularies: `${ApiEndpoint}/${ApiOps.CustomVocabularies}`,
  CustomLanguageModels: `${ApiEndpoint}/${ApiOps.CustomLanguageModels}`,
  CustomEntityRecognizers: `${ApiEndpoint}/${ApiOps.CustomEntityRecognizers}`,
  Stats: `${ApiEndpoint}/${ApiOps.Stats}`,
  Users: `${ApiEndpoint}/${ApiOps.Users}`,
  AIOptionsSettings: `${ApiEndpoint}/${ApiOps.AIOptionsSettings}`,
  FaceIndexer: `${ApiEndpoint}/${ApiOps.FaceIndexer}`,
  Tokenize: `${ApiEndpoint}/${ApiOps.Tokenize}`,
  Summarize: `${ApiEndpoint}/${ApiOps.Summarize}`,
  Genre: `${ApiEndpoint}/${ApiOps.Genre}`,
  Sentiment: `${ApiEndpoint}/${ApiOps.Sentiment}`,
  TVRatings: `${ApiEndpoint}/${ApiOps.TVRatings}`,
  Theme: `${ApiEndpoint}/${ApiOps.Theme}`,
  Taxonomy: `${ApiEndpoint}/${ApiOps.Taxonomy}`,
  Custom: `${ApiEndpoint}/${ApiOps.Custom}`,
  Models: `${ApiEndpoint}/models`,
  Subtitle: `${ApiEndpoint}/subtitle`,
  Publish: `${ApiEndpoint}/publish`,
  Workflow: `${ApiEndpoint}/${ApiOps.Execution}`,
  Highlights: `${ApiEndpoint}/${ApiOps.Highlights}`,
  HighlightSettings: `${ApiEndpoint}/${ApiOps.HighlightSettings}`,
  Edits: `${ApiEndpoint}/${ApiOps.Edits}`,
  Renders: `${ApiEndpoint}/${ApiOps.Renders}`,
};

let GRAPH_ENDPOINT;
let GRAPH_APIKEY;
if (KnowledgeGraph && KnowledgeGraph.Endpoint && KnowledgeGraph.ApiKey) {
  GRAPH_ENDPOINT = `${KnowledgeGraph.Endpoint}/graph`;
  GRAPH_APIKEY = KnowledgeGraph.ApiKey;
}

let SHOPPABLE_ENDPOINT;
let SHOPPABLE_APIKEY;
if (Shoppable && Shoppable.Endpoint && Shoppable.ApiKey) {
  SHOPPABLE_ENDPOINT = `${Shoppable.Endpoint}/shoppable`;
  SHOPPABLE_APIKEY = Shoppable.ApiKey;
}

const _authHttpRequest = new AuthHttpRequest();

export default class ApiHelper {
  /* record related methods */
  static async scanRecords(query) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Asset,
      query
    );
  }

  static async getRecord(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Asset}/${uuid}`
    );
  }

  static async purgeRecord(uuid) {
    return _authHttpRequest.send(
      'DELETE',
      `${ENDPOINTS.Asset}/${uuid}`
    );
  }

  /* aiml results */
  static async getAnalysisResults(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Analysis}/${uuid}`
    );
  }

  /* iot */
  static async attachIot() {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.AttachIot
    );
  }

  /* search method */
  static async search(query) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Search,
      query
    );
  }

  static async searchInDocument(docId, query) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Search}/${docId}`,
      query
    );
  }

  /* workflow related methods */
  static async startIngestWorkflow(body, query) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.Asset,
      query,
      body
    );
  }

  static async startAnalysisWorkflow(uuid, body, query) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Analysis}/${uuid}`,
      query,
      body
    );
  }

  static async startWorkflow(body, query) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.Asset,
      query,
      body
    );
  }

  static async getRekognitionFaceCollections() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.FaceCollections
    );
  }

  static async getRekognitionCustomLabelModels() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.CustomLabelModels
    );
  }

  static async getTranscribeCustomVocabulary() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.CustomVocabularies
    );
  }

  static async getTranscribeCustomLanguageModels() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.CustomLanguageModels
    );
  }

  static async getComprehendCustomEntityRecognizers() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.CustomEntityRecognizers
    );
  }

  /* stats */
  static async getStats(query) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Stats,
      query
    );
  }

  /* face collection */
  static async getFaceCollections() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.FaceCollections
    );
  }

  static async createFaceCollection(collectionId) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.FaceCollection,
      undefined,
      {
        collectionId,
      }
    );
  }

  static async deleteFaceCollection(collectionId) {
    return _authHttpRequest.send(
      'DELETE',
      ENDPOINTS.FaceCollection,
      {
        collectionId,
      }
    );
  }

  static async getFacesInCollection(collectionId, options) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.FaceIndexer,
      {
        ...options,
        collectionId,
      }
    );
  }

  static async deleteFaceFromCollection(collectionId, faceId) {
    return _authHttpRequest.send(
      'DELETE',
      ENDPOINTS.FaceIndexer,
      {
        collectionId,
        faceId,
      }
    );
  }

  /* user management */
  static async getUsers() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Users
    );
  }

  static async addUsers(users) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.Users,
      undefined,
      users
    );
  }

  static async deleteUser(user) {
    return _authHttpRequest.send(
      'DELETE',
      ENDPOINTS.Users,
      {
        user,
      }
    );
  }

  /* manage aiOptions settings */
  static async getGlobalAIOptions() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.AIOptionsSettings
    );
  }

  static async setGlobalAIOptions(aiOptions) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.AIOptionsSettings,
      undefined,
      aiOptions
    );
  }

  static async deleteGlobalAIOptions() {
    return _authHttpRequest.send(
      'DELETE',
      ENDPOINTS.AIOptionsSettings
    );
  }

  static async graph(query) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': GRAPH_APIKEY,
    };

    let tries = 4;
    while (tries--) {
      try {
        const response = await _authHttpRequest.send(
          'GET',
          GRAPH_ENDPOINT,
          query,
          '',
          headers
        );
        return response;
      } catch (e) {
        console.log(`== ApiHelper.graph: #${tries}`);
        console.error(e);
      }
    }

    return undefined;
  }

  // FaceIndexer
  static async batchGetFaces(faceIds) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.FaceIndexer,
      {
        faceIds: faceIds.join(','),
      }
    );
  }

  static async updateFaceTaggings(faceTags, optionalUuid) {
    const query = {};

    if (optionalUuid) {
      query.uuid = optionalUuid;
    }

    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.FaceIndexer}/update`,
      query,
      faceTags
    );
  }

  static async indexFaceV2(payload) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.FaceIndexer}/index`,
      undefined,
      payload
    );
  }

  static async importFaceCollection(payload) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.FaceIndexer}/import`,
      undefined,
      payload
    );
  }

  // GenAI use cases
  static async tokenize(options) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.Tokenize,
      undefined,
      options
    );
  }

  static async genaiPrompt(endpoint, options) {
    return _authHttpRequest.send(
      'POST',
      endpoint,
      undefined,
      options
    );
  }

  static async promptSummarize(options) {
    return ApiHelper.genaiPrompt(
      ENDPOINTS.Summarize,
      options
    );
  }

  static async promptGenre(options) {
    return ApiHelper.genaiPrompt(
      ENDPOINTS.Genre,
      options
    );
  }

  static async promptSentiment(options) {
    return ApiHelper.genaiPrompt(
      ENDPOINTS.Sentiment,
      options
    );
  }

  static async promptTVRatings(options) {
    return ApiHelper.genaiPrompt(
      ENDPOINTS.TVRatings,
      options
    );
  }

  static async promptTheme(options) {
    return ApiHelper.genaiPrompt(
      ENDPOINTS.Theme,
      options
    );
  }

  static async promptTaxonomy(options) {
    return ApiHelper.genaiPrompt(
      ENDPOINTS.Taxonomy,
      options
    );
  }

  static async promptCustom(options) {
    return ApiHelper.genaiPrompt(
      ENDPOINTS.Custom,
      options
    );
  }

  static async getModels(capability) {
    // AuthHttpRequest.send strips any ?query baked into the endpoint URL —
    // it parses with `new URL()` and only keeps url.pathname. Pass query as
    // the third arg so it makes it onto the wire.
    const query = capability ? { capability } : {};
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Models,
      query
    );
  }

  // shoppable backend api
  static async getProductDetails(query) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': SHOPPABLE_APIKEY,
    };

    const _query = {
      op: 'GetProductDetails',
      ...query,
    };

    return _authHttpRequest.send(
      'GET',
      SHOPPABLE_ENDPOINT,
      _query,
      '',
      headers
    );
  }

  static async previewOrders(query, body) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': SHOPPABLE_APIKEY,
    };

    const _query = {
      op: 'PreviewOrders',
      ...query,
    };

    return _authHttpRequest.send(
      'POST',
      SHOPPABLE_ENDPOINT,
      _query,
      body,
      headers
    );
  }

  static async confirmOrders(query, body) {
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': SHOPPABLE_APIKEY,
    };

    const _query = {
      op: 'ConfirmOrders',
      ...query,
    };

    return _authHttpRequest.send(
      'POST',
      SHOPPABLE_ENDPOINT,
      _query,
      body,
      headers
    );
  }

  static async getWorkflowStatus(executionArn) {
    const query = { executionArn };
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Workflow,
      query
    );
  }

  // Subtitle (Sub-Project C)
  static async generateSrt(uuid) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Subtitle}/${uuid}/srt`
    );
  }

  static async getSrt(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Subtitle}/${uuid}/srt`
    );
  }

  static async aiEditSubtitle(uuid, options) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Subtitle}/${uuid}/ai-edit`,
      undefined,
      options
    );
  }

  static async getSubtitlePrompt(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Subtitle}/${uuid}/prompt`
    );
  }

  static async saveSubtitlePrompt(uuid, prompt) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Subtitle}/${uuid}/prompt`,
      undefined,
      { prompt }
    );
  }

  static async saveSrt(uuid, payload) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Subtitle}/${uuid}/save-srt`,
      undefined,
      payload
    );
  }

  static async resetSrt(uuid) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Subtitle}/${uuid}/reset`
    );
  }

  static async getAiEditStatus(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Subtitle}/${uuid}/ai-edit-status`
    );
  }

  // Publish (Sub-Project D)
  static async getPublishStatus(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Publish}/${uuid}/status`
    );
  }

  static async getPublishSettings(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Publish}/${uuid}/settings`
    );
  }

  static async savePublishSettings(uuid, settings) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Publish}/${uuid}/settings`,
      undefined,
      settings
    );
  }

  static async startPublish(uuid, settings) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Publish}/${uuid}/start`,
      undefined,
      settings || {}
    );
  }

  static async getPublishOutputs(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Publish}/${uuid}/outputs`
    );
  }

  static async deletePublishOutput(uuid, outputId) {
    return _authHttpRequest.send(
      'DELETE',
      `${ENDPOINTS.Publish}/${uuid}/outputs/${encodeURIComponent(outputId)}`
    );
  }

  static async listPublishTemplates() {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Publish}/templates`
    );
  }

  static async getPublishTemplate(name) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Publish}/templates/${encodeURIComponent(name)}`
    );
  }

  static async savePublishTemplate(name, content) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Publish}/templates/${encodeURIComponent(name)}`,
      undefined,
      { content }
    );
  }

  static async deletePublishTemplate(name) {
    return _authHttpRequest.send(
      'DELETE',
      `${ENDPOINTS.Publish}/templates/${encodeURIComponent(name)}`
    );
  }

  // Highlight detection
  static async startHighlightDetection(uuid, body) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Highlights}/${uuid}`,
      undefined,
      body || {}
    );
  }

  static async listHighlightSets(uuid) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Highlights}/${uuid}`
    );
  }

  static async getHighlightSet(uuid, highlightSetId) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Highlights}/${uuid}/${highlightSetId}`
    );
  }

  static async deleteHighlightSet(uuid, highlightSetId) {
    return _authHttpRequest.send(
      'DELETE',
      `${ENDPOINTS.Highlights}/${uuid}/${highlightSetId}`
    );
  }

  // Highlight settings (per-owner defaults)
  static async getHighlightSettings(query) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.HighlightSettings,
      query
    );
  }

  static async setHighlightSettings(payload) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.HighlightSettings,
      undefined,
      payload || {}
    );
  }

  // Edit projects
  static async createEditProject(payload) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.Edits,
      undefined,
      payload || {}
    );
  }

  static async saveEditProject(editProjectId, payload) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Edits}/${editProjectId}`,
      undefined,
      payload || {}
    );
  }

  static async getEditProject(editProjectId) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Edits}/${editProjectId}`
    );
  }

  static async listEditProjects(uuid) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Edits,
      { uuid }
    );
  }

  // Renders
  static async startRender(payload) {
    return _authHttpRequest.send(
      'POST',
      ENDPOINTS.Renders,
      undefined,
      payload || {}
    );
  }

  static async getRender(renderId) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Renders}/${renderId}`
    );
  }

  static async listRenders(editProjectId) {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.Renders,
      { editProjectId }
    );
  }

  static async deleteRender(renderId) {
    return _authHttpRequest.send(
      'DELETE',
      `${ENDPOINTS.Renders}/${renderId}`
    );
  }

  // Render templates (mirrors publish templates)
  static async listRenderTemplates() {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Renders}/templates`
    );
  }

  static async getRenderTemplate(name) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.Renders}/templates/${encodeURIComponent(name)}`
    );
  }

  static async saveRenderTemplate(name, content) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.Renders}/templates/${encodeURIComponent(name)}`,
      undefined,
      { content }
    );
  }

  static async deleteRenderTemplate(name) {
    return _authHttpRequest.send(
      'DELETE',
      `${ENDPOINTS.Renders}/templates/${encodeURIComponent(name)}`
    );
  }
}
