# Implementation Plan: Dynamic Bedrock Model Registry + Editable Prompts

**Spec:** `docs/superpowers/specs/2026-05-19-bedrock-model-registry-design.md`
**Branch:** `short-form-video`
**Sub-project:** B

---

## Task 1: Create `BedrockModel` class in core-lib layer

**File:** `source/layers/core-lib/lib/genai/bedrockModel.js` (new)

This shared class replaces `source/api/lib/operations/genai/claude.js` for the API lambda and also replaces the inline `_invokeEndpoint` functions in the 3 analysis lambdas.

```js
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const {
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
  },
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('..');

const REGION = process.env.ENV_BEDROCK_REGION;
const MODEL_ID = process.env.ENV_BEDROCK_MODEL_ID;

class BedrockModel {
  constructor(opts = {}) {
    this.$region = opts.region || REGION;
    this.$fallbackModelId = opts.fallbackModelId || MODEL_ID;
  }

  get region() {
    return this.$region;
  }

  get fallbackModelId() {
    return this.$fallbackModelId;
  }

  static canSupport() {
    return (REGION !== undefined && REGION.length > 0);
  }

  async inference(task, inputParams = {}) {
    const {
      system,
      messages,
      inferenceConfig,
    } = _buildConverseInput(task, inputParams);

    const modelId = inputParams.modelId || this.fallbackModelId;

    const client = xraysdkHelper(new BedrockRuntimeClient({
      region: this.region,
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new ConverseCommand({
      modelId,
      system: system
        ? [{ text: system }]
        : undefined,
      messages,
      inferenceConfig,
    });

    const response = await client.send(command)
      .catch((e) => {
        if (e.code === 'ENOTFOUND') {
          e.name = 'ServiceUnavailableException';
          console.log(`=== Bedrock not supported in ${this.region} (${e.code})`);
        } else if (e.name === 'ResourceNotFoundException') {
          console.log(`=== Make sure to request access to the model, ${modelId} in ${this.region} (${e.code})`);
        } else if (e.name === 'AccessDeniedException') {
          console.log(`=== Make sure to request access to the model, ${modelId} in ${this.region} (${e.code})`);
        }
        throw e;
      });

    const outputText = (response.output.message.content[0] || {}).text || '';
    const text = _parseOutputContent(outputText);

    return {
      content: [{ text }],
      modelId,
      stopReason: response.stopReason,
      usage: response.usage,
      prompt: inputParams.prompt,
    };
  }
}

module.exports = BedrockModel;

function _buildConverseInput(task, inputParams) {
  const {
    temperature,
    max_length: maxLength,
  } = inputParams;

  const inferenceConfig = {
    maxTokens: 4096 * 4,
    temperature: 0.2,
  };

  if (temperature) {
    const t = Number(temperature);
    if (t > 0 && t < 1.0) {
      inferenceConfig.temperature = t;
    }
  }
  if (maxLength) {
    const ml = Number(maxLength);
    if (ml > 0 && ml < 4096) {
      inferenceConfig.maxTokens = ml;
    }
  }

  const TASKS = {
    genre: 'genre',
    sentiment: 'sentiment',
    summarize: 'summarize',
    taxonomy: 'taxonomy',
    theme: 'theme',
    tvratings: 'tvratings',
    custom: 'custom',
  };

  switch (task) {
    case TASKS.genre:
      return _createGenreInput(inputParams, inferenceConfig);
    case TASKS.sentiment:
      return _createSentimentInput(inputParams, inferenceConfig);
    case TASKS.summarize:
      return _createSummarizeInput(inputParams, inferenceConfig);
    case TASKS.taxonomy:
      return _createTaxonomyInput(inputParams, inferenceConfig);
    case TASKS.theme:
      return _createThemeInput(inputParams, inferenceConfig);
    case TASKS.tvratings:
      return _createTVRatingsInput(inputParams, inferenceConfig);
    case TASKS.custom:
      return _createCustomInput(inputParams, inferenceConfig);
    default:
      throw new M2CException('invalid prompt parameter');
  }
}

function _textInput(options) {
  if (!options.text_inputs) {
    throw new M2CException('text_inputs not specified');
  }
  return options.text_inputs;
}

function _createCategoryInput(taskName, categoryList, outputJson, inputParams, inferenceConfig) {
  const tag = taskName.replace(/\s/g, '_').toLowerCase();
  const list = [
    `<${tag}>`,
    ...categoryList,
    'None of the above',
    `</${tag}>`,
  ];

  const system = `You are a media operation engineer responsible for reviewing transcripts and assigning appropriate ${taskName} to dialogues. Your task is to identify the top 3 relevant ${taskName} for a given dialogue and provide a confidence score from 0 to 100. Respond with only a JSON object. No markdown, no commentary.`;

  const transcript = _textInput(inputParams);

  const messages = [
    {
      role: 'user',
      content: [{ text: `Here is a list of the ${taskName} in <${tag}> tag to consider:\n${list.join('\n')}\n.` }],
    },
    {
      role: 'assistant',
      content: [{ text: `Got the list of the ${taskName}. Can you provide the transcript?` }],
    },
    {
      role: 'user',
      content: [{ text: `Transcript in <transcript> tag:\n<transcript>${transcript}\n</transcript>` }],
    },
    {
      role: 'assistant',
      content: [{ text: 'Got the transcript. What output format?' }],
    },
    {
      role: 'user',
      content: [{ text: `Return JSON format. An example of the output:\n${JSON.stringify(outputJson)}\n. Only answer from the provided list.` }],
    },
  ];

  return { system, messages, inferenceConfig };
}

function _createSingleCategoryInput(taskName, categoryList, outputJson, inputParams, inferenceConfig) {
  const result = _createCategoryInput(taskName, categoryList, outputJson, inputParams, inferenceConfig);
  result.system = result.system.replace('top 3', 'most');
  return result;
}

function _createGenreInput(inputParams, inferenceConfig) {
  const LIST_OF_GENRES = [
    'Comedy', 'Action', 'Horror', 'Thriller', 'Western film', 'Drama',
    'Adventure', 'Historical Fiction', 'Fantasy', 'Romance', 'Fiction',
    'Narrative', 'Science fiction', 'Mystery', 'Satire', 'Speculative fiction',
    'Action fiction', 'Adventure fiction', 'Isekai', 'Humor', 'Hybrid genre',
    'Melodrama', 'Mystery', 'Historical drama', 'Crime fiction',
    'Romantic comedy', 'Dark comedy', 'History', 'Fantasy', 'Slapstick',
    'Magical Realism', 'Comedy horror', 'Coming-of-age story',
    'Psychological thriller', 'Psychological horror', 'High fantasy',
    'Fairy tale', 'Suspense', 'Farce', 'Psychology', 'Supernatural',
    'Detective fiction', 'Conspiracy fiction', 'Biography', 'Wuxia',
    'Legal drama', 'Religious', 'Non-determined',
  ];
  const example = { genres: [{ text: 'Comedy', score: 98 }, { text: 'Romance', score: 80 }] };
  return _createCategoryInput('Genres', LIST_OF_GENRES, example, inputParams, inferenceConfig);
}

function _createSentimentInput(inputParams, inferenceConfig) {
  const LIST_OF_SENTIMENTS = ['Neural', 'Positive', 'Negative'];
  const example = { sentiment: { text: 'Positive', score: 98 } };
  return _createSingleCategoryInput('Sentiment', LIST_OF_SENTIMENTS, example, inputParams, inferenceConfig);
}

function _createTaxonomyInput(inputParams, inferenceConfig) {
  const {
    IABTaxonomy,
  } = require('..');
  const taxonomies = IABTaxonomy.map((x) => x.Name);
  const example = { taxonomies: [{ text: 'Station Wagon', score: 98 }, { text: 'Board Games and Puzzles', score: 80 }] };
  return _createCategoryInput('IAB Taxonomies', taxonomies, example, inputParams, inferenceConfig);
}

function _createThemeInput(inputParams, inferenceConfig) {
  const LIST_OF_THEMES = [
    'Love', 'Good versus evil', 'Justice', 'Coming-of-age story', 'Death',
    'Humanity vs technology', 'Man vs nature', 'Reason vs faith', 'Revenge',
    'Sacrifice', 'Family', 'Society', 'War', 'Action', 'Comedy', 'Drama',
    'Innocence', 'Overcoming adversity', 'Perseverance', 'Philosophical',
    'Power', 'Survival', 'Virtue', 'Non-determined',
  ];
  const example = { themes: [{ text: 'Good versus evil', score: 98 }, { text: 'War', score: 80 }] };
  return _createCategoryInput('Themes', LIST_OF_THEMES, example, inputParams, inferenceConfig);
}

function _createTVRatingsInput(inputParams, inferenceConfig) {
  const LIST_OF_RATINGS = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
  const example = { ratings: { text: 'PG-13', score: 98 } };
  return _createSingleCategoryInput('Motion Picture Ratings', LIST_OF_RATINGS, example, inputParams, inferenceConfig);
}

function _createSummarizeInput(inputParams, inferenceConfig) {
  const system = 'You are a media operation engineer responsible for reviewing transcripts and summarize the dialogues into one or two paragraphs and provide a confidence score from 0 to 100. Respond with only a JSON object. No markdown, no commentary.';
  const transcript = _textInput(inputParams);
  const example = { summary: { text: 'The transcript describes ...', score: 98 } };

  const messages = [
    {
      role: 'user',
      content: [{ text: `Transcript in <transcript> tag:\n<transcript>${transcript}\n</transcript>` }],
    },
    {
      role: 'assistant',
      content: [{ text: 'I\'ve received the transcript. What output format would you like?' }],
    },
    {
      role: 'user',
      content: [{ text: `Return JSON format. An example of the output:\n${JSON.stringify(example)}` }],
    },
  ];

  return { system, messages, inferenceConfig };
}

function _createCustomInput(inputParams, inferenceConfig) {
  const system = 'You are a media operation engineer responsible for reviewing transcripts and answer the following question and provide a confidence score from 0 to 100. Respond with only a JSON object. No markdown, no commentary.';
  const transcript = _textInput(inputParams);
  const example = { custom: { text: 'Answer goes here', score: 98 } };

  const messages = [
    {
      role: 'user',
      content: [{ text: `Transcript in <transcript> tag:\n<transcript>${transcript}\n</transcript>\n${inputParams.prompt}` }],
    },
    {
      role: 'assistant',
      content: [{ text: 'I\'ve received the transcript. What output format would you like?' }],
    },
    {
      role: 'user',
      content: [{ text: `Return JSON format. An example of the output:\n${JSON.stringify(example)}` }],
    },
  ];

  return { system, messages, inferenceConfig };
}

function _parseOutputContent(text) {
  if (!text) {
    return text;
  }

  let jsonstring = text;

  let data;
  try {
    data = JSON.parse(jsonstring);
    return JSON.stringify(data);
  } catch (e) {
    // do nothing
  }

  let idx = jsonstring.indexOf('{');
  if (idx < 0) {
    return text;
  }
  jsonstring = jsonstring.slice(idx);

  idx = jsonstring.lastIndexOf('}');
  if (idx < 0) {
    return text;
  }
  jsonstring = jsonstring.slice(0, idx + 1);

  try {
    data = JSON.parse(jsonstring);
  } catch (e) {
    // do nothing
  }

  return JSON.stringify(data);
}
```

**Also export from core-lib.** Add to `source/layers/core-lib/index.js`:

```js
const BedrockModel = require('./lib/genai/bedrockModel');
```

And add `BedrockModel` to the `module.exports` object.

**Verification:** `cd source/layers/core-lib && node -e "const B = require('.'); console.log(typeof B.BedrockModel)"` should print `function`.

---

## Task 2: Create `GET /models` endpoint

**File:** `source/api/lib/operations/listModels.js` (new)

```js
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  BedrockClient,
  ListFoundationModelsCommand,
} = require('@aws-sdk/client-bedrock');
const {
  M2CException,
} = require('core-lib');

const REGION = process.env.ENV_BEDROCK_REGION;
const PROVIDER_WHITELIST = [
  'Amazon',
  'DeepSeek',
  'MiniMax',
  'Moonshot AI',
  'Qwen',
  'Z.AI',
];

let _cache = null;
let _cacheExpiresAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function listModels(capability = 'text') {
  if (!REGION) {
    throw new M2CException('Bedrock region not configured');
  }

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

  _cache = all.filter((m) =>
    PROVIDER_WHITELIST.includes(m.providerName) &&
    (m.modelLifecycle || {}).status === 'ACTIVE' &&
    (m.inferenceTypesSupported || []).includes('ON_DEMAND'));

  _cacheExpiresAt = Date.now() + CACHE_TTL;

  return _filter(_cache, capability);
}

function _filter(models, capability) {
  if (capability === 'vision') {
    return _group(models.filter((m) =>
      (m.inputModalities || []).includes('IMAGE')));
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
  return { providers: out };
}

module.exports = { listModels };
```

**Wire into the API router.** In `source/api/lib/apiRequest.js`:

1. Add `const { listModels } = require('./operations/listModels');` at the top.
2. Add a constant: `const OP_MODELS = 'models';`
3. In `getProcessor()`, add before the final `throw`:

```js
if (op === OP_MODELS) {
  return null; // handled directly below
}
```

4. In the class, add a method or modify the dispatch logic. Since the existing pattern uses operation classes with `onGET`/`onPOST`, the simplest approach is to handle it in the main handler. Check `source/api/index.js`:

**File:** `source/api/index.js` — check how requests are dispatched.

Actually, looking at the existing pattern, `getProcessor()` returns an Op instance and the handler calls `onGET()`/`onPOST()` on it. The simplest way to add a new GET-only operation is to create a minimal Op class:

**File:** `source/api/lib/operations/modelsOp.js` (new)

```js
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const BaseOp = require('./baseOp');
const { listModels } = require('./listModels');

class ModelsOp extends BaseOp {
  async onGET() {
    const capability = (this.request.queryString || {}).capability || 'text';
    const result = await listModels(capability);
    return super.onGET(result);
  }
}

module.exports = ModelsOp;
```

Then in `source/api/lib/apiRequest.js`:
- Add import: `const ModelsOp = require('./operations/modelsOp');`
- Add constant: `const OP_MODELS = 'models';`
- Add dispatch case before the `throw`:
  ```js
  if (op === OP_MODELS) {
    return new ModelsOp(this);
  }
  ```

**Also add to `core-lib/lib/apiOps.js`:**
```js
Models: 'models',
```

**Verification:** Deploy API lambda; `curl -H "Authorization: ..." https://<api>/models` should return `{"providers":{"Amazon":[...],...}}`.

---

## Task 3: Modify `genaiOp.js` to use `BedrockModel`

**File:** `source/api/lib/operations/genaiOp.js`

Replace:
```js
const Claude = require('./genai/claude');
```
With:
```js
const { BedrockModel } = require('core-lib');
```

Replace the model validation block (lines 43-51):
```js
let model;

if (Claude.canSupport(params.model)) {
  model = new Claude();
}

if (!model) {
  throw new M2CException('invalid model name');
}
```
With:
```js
if (!BedrockModel.canSupport()) {
  throw new M2CException('Bedrock region not configured');
}

const model = new BedrockModel();
```

The `params.model` value from the frontend is passed through to `inputParams.modelId` inside the `inference()` call. We need to pass it:

Replace:
```js
const response = await model.inference(op, params);
```
With:
```js
const response = await model.inference(op, {
  ...params,
  modelId: params.model,
});
```

**Delete:** `source/api/lib/operations/genai/claude.js` and `source/api/lib/operations/genai/baseModel.js`. Keep `source/api/lib/operations/genai/defs.js` (still used by core-lib for the task constants — actually no, the constants are moved into `bedrockModel.js`). Actually `defs.js` is imported by `claude.js` only. Since the task names are now derived from `apiOps.js` via the URL path (e.g. `genai/genre` → `genre`), `defs.js` is no longer needed either. Delete it.

**Verification:** Run the GenAI tab's summarize prompt against a transcript. Confirm response is valid JSON.

---

## Task 4: Modify 3 backend analysis call sites

All three files follow the same pattern: they build Claude-format params (`anthropic_version`, `stop_sequences`, `{` prefill), call `InvokeModelCommand`, then parse the Anthropic-format response (`content[0].text`, `usage.input_tokens`). Replace with `BedrockModel` from core-lib.

### 4a. `source/main/analysis/audio/states/collect-transcribe-results/index.js`

**Remove** imports:
```js
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');
```

**Add** import:
```js
const { BedrockModel } = require('core-lib');
```

**Remove** constants: `MODEL_VERSION`, `MODEL_PRICING`, `MODEL_PARAMS`, `ASSISTANT` (the `{` prefill and `OutputFormat`).

**Replace** `_prepareModelParams(vtt)` + `_invokeEndpoint(modelId, modelParams)` + `_parseResponse(response)` with a single function:

```js
async function _analyseChapter(vtt) {
  const model = new BedrockModel();

  const example = {
    chapters: [
      { start: '00:00:10.000', end: '00:00:32.000', reason: 'It appears the chapter talks about...' },
    ],
  };

  const system = 'You are a media operation assistant that can analyze movie transcripts in WebVTT format and suggest chapter points based on the topic changes in the conversations. It is important to read the entire transcripts. Respond with only a JSON object. No markdown, no commentary.';

  const messages = [
    { role: 'user', content: [{ text: `Here is the transcripts in <transcript> tag:\n<transcript>${vtt}\n</transcript>\n` }] },
    { role: 'assistant', content: [{ text: 'OK. I got the transcript. What output format?' }] },
    { role: 'user', content: [{ text: `Return JSON format. An example of the output:\n${JSON.stringify(example)}\n` }] },
  ];

  const client = new (require('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient)({
    region: model.region,
  });

  const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  const response = await client.send(new ConverseCommand({
    modelId: model.fallbackModelId,
    system: [{ text: system }],
    messages,
    inferenceConfig: { maxTokens: 4096 * 4, temperature: 0.2 },
  }));

  const outputText = (response.output.message.content[0] || {}).text || '';
  const parsed = _parseChapterJson(outputText);

  return {
    usage: response.usage,
    chapters: parsed,
  };
}
```

Wait — looking at the existing code more carefully, the function `_analyseConversation` iterates chunks and accumulates results. The cleanest migration is to keep the structure but replace `_invokeEndpoint` and `_parseResponse` internals.

**Simpler approach:** Replace `_prepareModelParams`, `_invokeEndpoint`, and `_parseResponse` with a single helper that uses `ConverseCommand` directly (since this lambda doesn't use the GenAI task dispatch — it has its own prompt):

```js
async function _invokeChapterModel(modelId, vtt) {
  const {
    BedrockRuntimeClient,
    ConverseCommand,
  } = require('@aws-sdk/client-bedrock-runtime');

  const example = {
    chapters: [
      { start: '00:00:10.000', end: '00:00:32.000', reason: 'It appears the chapter talks about...' },
    ],
  };

  const system = SYSTEM;
  const messages = [
    { role: 'user', content: [{ text: `Here is the transcripts in <transcript> tag:\n<transcript>${vtt}\n</transcript>\n` }] },
    { role: 'assistant', content: [{ text: 'OK. I got the transcript. What output format?' }] },
    { role: 'user', content: [{ text: `Return JSON format. An example of the output:\n${JSON.stringify(example)}\n` }] },
  ];

  const client = new BedrockRuntimeClient({ region: MODEL_REGION });
  const response = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: system }],
    messages,
    inferenceConfig: { maxTokens: 4096 * 4, temperature: 0.2 },
  })).catch((e) => {
    if (e.name === 'ModelErrorException') {
      const err = new Error(`Model inference quota reached. Retry again. (${e.name})`);
      err.name = 'ModelErrorException';
      throw err;
    }
    throw e;
  });

  const outputText = (response.output.message.content[0] || {}).text || '';
  let chapters = [];
  try {
    let json = outputText;
    const idx = json.indexOf('{');
    if (idx >= 0) json = json.slice(idx);
    const endIdx = json.lastIndexOf('}');
    if (endIdx >= 0) json = json.slice(0, endIdx + 1);
    const parsed = JSON.parse(json);
    chapters = parsed.chapters || [];
  } catch (e) {
    // do nothing
  }

  return {
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
    chapters,
  };
}
```

Update `_analyseConversation` to call `_invokeChapterModel(modelId, sliced)` instead of `_invokeEndpoint(modelId, modelParams)` → `_parseResponse(res)`.

**Remove:** `_prepareModelParams`, `_invokeEndpoint`, `_parseResponse`, `MODEL_VERSION`, `MODEL_PARAMS`, `ASSISTANT`, `MODEL_PRICING` constants.  
**Keep:** `MODEL_REGION`, `MODEL_ID`, `SYSTEM` (reword to add "Respond with only a JSON object. No markdown, no commentary.").  
**Remove** the `MODEL_PRICING` / `estimatedCost` calculation (it assumed Anthropic pricing which no longer applies; remove the cost log line or replace with a simple token-count log).

### 4b. `source/main/analysis/post-process/states/create-scene-taxonomy/index.js`

Same pattern. This file has `_invokeEndpoint` (identical to 4a's) and builds vision-style messages with images. Replace:

**Remove** top-level imports of `BedrockRuntimeClient`, `InvokeModelCommand`.  
**Add** `const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');` and keep `BedrockRuntimeClient` for the client.

Replace `_invokeEndpoint` function body to use `ConverseCommand`:

```js
async function _invokeEndpoint(modelId, system, messages) {
  const client = new BedrockRuntimeClient({ region: MODEL_REGION });
  const response = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: system }],
    messages,
    inferenceConfig: { maxTokens: 4096 * 4, temperature: 0.1 },
  })).catch((e) => {
    let exception;
    if (e.code === 'ENOTFOUND') {
      exception = new Error(`Bedrock not supported in the region (${e.code})`);
      exception.name = 'ServiceUnavailableException';
    } else if (e.name === MODEL_ERROR_EXCEPTION) {
      exception = new Error(`Model inference quota reached. Retry again. (${e.name})`);
      exception.name = MODEL_ERROR_EXCEPTION;
    } else if (e.name === 'ResourceNotFoundException') {
      exception = new Error(`Make sure to request access to the model in the region (${e.name})`);
      exception.name = 'ResourceNotFoundException';
    } else if (e.name === 'AccessDeniedException') {
      exception = new Error(`Not allow to access to the model in the region (${e.name})`);
      exception.name = 'AccessDeniedException';
    } else {
      exception = new Error(e.message);
      exception.name = e.name || e.code || 'UnknownException';
    }
    console.log(`[ERR]: ConverseCommand: ${exception.name} - ${exception.message}`);
    throw exception;
  });

  return response;
}
```

**Refactor callers** (`_callBedrockModel` or equivalent) to:
- Build Converse-shaped messages: each user message's `content` becomes `[{ text: '...' }]` or `[{ image: { format: 'jpeg', source: { bytes: buffer } } }, { text: '...' }]` for vision.
- Remove `anthropic_version`, `stop_sequences`, `{` prefill from messages.
- Add "Respond with only a JSON object. No markdown, no commentary." to the system prompt.
- Parse response from `response.output.message.content[0].text` and `response.usage.inputTokens`/`outputTokens` (Converse uses camelCase, not `input_tokens`).

**Remove:** `MODEL_VERSION`, `MODEL_PARAMS`, the `ASSISTANT.Prefill` message, `MODEL_PRICING`.

### 4c. `source/main/analysis/image/states/start-image-analysis/index.js`

Same pattern as 4b — this is the vision (multimodal) call site. The key difference is that images are sent as base64 buffers.

Replace `_invokeEndpoint` the same way as 4b. Refactor the message-building to use Converse image format:

```js
// For vision — Converse format:
{
  role: 'user',
  content: [
    { image: { format: 'jpeg', source: { bytes: imageBuffer } } },
    { text: 'Describe this photo...' },
  ],
}
```

Instead of the current Anthropic format:
```js
// Current Claude format (to be removed):
{
  role: 'user',
  content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64String } },
    { type: 'text', text: '...' },
  ],
}
```

**Note on `ENV_BEDROCK_VISION_MODEL_ID`:** This new env var (Task 5) provides the vision model fallback. If not set, fall back to `ENV_BEDROCK_MODEL_ID`.

---

## Task 5: IAM + CFN parameter changes

### 5a. `deployment/media2cloud-webapp-stack.yaml` — `FoundationModelPolicy` (line 305)

Replace the policy statement block:

```yaml
    FoundationModelPolicy:
        Condition: bBedrockSecondaryRegionAccess
        Type: AWS::IAM::Policy
        Metadata:
            cfn_nag:
                rules_to_suppress:
                    -
                        id: W12
                        reason: wildcard character required for bedrock:ListFoundationModels, https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html
        Properties:
            Roles:
                - !Ref ApiRole
            PolicyName: FoundationModelInvokeEndpoint
            PolicyDocument:
                Version: "2012-10-17"
                Statement:
                    # Bedrock List Models
                    -
                        Effect: Allow
                        Action: bedrock:ListFoundationModels
                        Resource: "*"
                    # Bedrock Converse + InvokeModel for all whitelisted providers
                    -
                        Effect: Allow
                        Action:
                            - bedrock:InvokeModel
                            - bedrock:Converse
                        Resource:
                            # Anthropic Claude family (defense-in-depth)
                            - arn:aws:bedrock:*::foundation-model/anthropic.claude-*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.anthropic.claude-*
                            # Amazon Nova
                            - arn:aws:bedrock:*::foundation-model/amazon.*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.amazon.*
                            # DeepSeek
                            - arn:aws:bedrock:*::foundation-model/deepseek.*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.deepseek.*
                            # MiniMax
                            - arn:aws:bedrock:*::foundation-model/minimax.*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.minimax.*
                            # Moonshot AI
                            - arn:aws:bedrock:*::foundation-model/moonshotai.*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.moonshotai.*
                            - arn:aws:bedrock:*::foundation-model/moonshot.*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.moonshot.*
                            # Qwen
                            - arn:aws:bedrock:*::foundation-model/qwen.*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.qwen.*
                            # Z.AI
                            - arn:aws:bedrock:*::foundation-model/zai.*
                            - !Sub arn:aws:bedrock:*:${AWS::AccountId}:inference-profile/*.zai.*
```

### 5b. `deployment/media2cloud-backend-stack.yaml` — `BedrockAnthropicClaudePolicy` (line 8043)

Same expansion. Rename the policy to `BedrockMultiProviderPolicy` and update resource ARNs identically to 5a.

### 5c. New CFN parameter: `BedrockVisionModelId`

In `deployment/media2cloud-backend-stack.yaml` Parameters section (after line 288):
```yaml
    BedrockVisionModelId:
        Type: String
        Description: BedrockVisionModelId
        Default: amazon.nova-pro-v1:0
```

Plumb to the image analysis lambda's environment (around line 6975):
```yaml
                    ENV_BEDROCK_VISION_MODEL_ID: !Ref BedrockVisionModelId
```

### 5d. Update default of `BedrockModelId`

In `deployment/media2cloud.yaml`, the `Mappings` section (line 64-72): change `AnthropicClaude` mappings to use Amazon Nova as defaults, or better — change the `BedrockModel` parameter default (line 156) from `Anthropic Claude Haiku 4.5` to the new default. Since the existing structure uses a `!FindInMap` conditional, the simplest change is:

- Change `BedrockModel` parameter `Default` to `Amazon Nova Lite`
- Add a mapping entry for Amazon Nova under the `Mappings` section
- Update `bAnthropicClaudeSonnet` condition and the `!If` blocks that reference it

Alternatively (simpler): change `BedrockModelId` and `BedrockModelVersion` to be passed directly (not via FindInMap), with default `amazon.nova-lite-v1:0` and `bedrock-2023-05-31`.

---

## Task 6: Frontend changes

### 6a. `source/webapp/src/lib/js/app/mainView/collection/base/components/analysis/genai/genaiTab.js`

**Change 1:** Flip `ENABLE_TEXT_INPUT` (line 66):
```js
const ENABLE_TEXT_INPUT = true;
```

**Change 2:** Replace static `FoundationModels` model dropdown in `createModelSelection()` (line 450) with a dynamic fetch:

```js
createModelSelection() {
  const label = $('<span/>')
    .addClass('lead-s my-4')
    .html(MSG_MODEL_NAME);

  const select = $('<select/>')
    .addClass('custom-select custom-select-sm')
    .addClass('col-9 mx-2 p-1');

  let option = $('<option/>')
    .attr('value', 'undefined')
    .append(MSG_SELECT_MODEL);
  select.append(option);

  // load models dynamically
  this.loadModels(select);

  select.on('change', () => {
    const val = select.val();
    if (val === 'undefined') {
      this.modelName = undefined;
      return;
    }
    this.modelName = val;
    // persist last selection
    const store = GetSettingStore();
    store.putItem('genai.lastModel', val);
  });

  return [label, select];
}

async loadModels(select) {
  try {
    const response = await ApiHelper.getModels();
    const { providers = {} } = response;
    Object.keys(providers).sort().forEach((provider) => {
      const optgroup = $('<optgroup/>').attr('label', provider);
      providers[provider].forEach((m) => {
        const opt = $('<option/>')
          .attr('value', m.id)
          .append(m.name);
        optgroup.append(opt);
      });
      select.append(optgroup);
    });
    // restore last selection
    const store = GetSettingStore();
    const lastModel = await store.getItem('genai.lastModel');
    if (lastModel) {
      select.val(lastModel);
      this.modelName = lastModel;
    }
  } catch (e) {
    console.error('Failed to load models:', e);
  }
}
```

**Change 3:** Add "Save as..." and "My templates" to prompt template section. After the existing `createPromptTemplate()`, add save/load logic using IndexedDB:

```js
createSavePromptButton() {
  const btn = $('<button/>')
    .addClass('btn btn-sm btn-outline-secondary ml-2')
    .html('Save as...');

  btn.on('click', async () => {
    const promptInput = this.tabContent.find(`input#prompt-${this.id}`);
    const text = promptInput.val();
    if (!text) return;

    const name = prompt('Save prompt as:');
    if (!name) return;

    const store = GetSettingStore();
    const templates = (await store.getItem('genai.prompts')) || {};
    templates[name] = {
      text,
      task: this.promptTemplate || 'custom',
    };
    await store.putItem('genai.prompts', templates);
    this.refreshUserTemplates();
  });

  return btn;
}

async refreshUserTemplates() {
  const store = GetSettingStore();
  const templates = (await store.getItem('genai.prompts')) || {};
  const container = this.tabContent.find('.user-templates-group');
  container.empty();

  Object.keys(templates).forEach((name) => {
    const row = $('<div/>').addClass('d-flex align-items-center mb-1');
    const link = $('<a/>')
      .addClass('mr-2')
      .attr('href', '#')
      .html(name)
      .on('click', (e) => {
        e.preventDefault();
        const promptInput = this.tabContent.find(`input#prompt-${this.id}`);
        promptInput.val(templates[name].text);
        this.promptTemplate = templates[name].task;
      });
    const del = $('<button/>')
      .addClass('btn btn-sm btn-link text-danger p-0')
      .html('&times;')
      .on('click', async () => {
        delete templates[name];
        await store.putItem('genai.prompts', templates);
        this.refreshUserTemplates();
      });
    row.append(link, del);
    container.append(row);
  });
}
```

**Change 4:** Add `import { GetSettingStore } from '../../../../../../shared/localCache/settingStore.js';` at the top.

**Change 5:** Remove `FoundationModels` from the `SolutionManifest` destructure (line 15). It's no longer used.

### 6b. `source/webapp/src/lib/js/app/shared/apiHelper.js`

Add a new static method:

```js
static async getModels(capability) {
  const qs = capability ? `?capability=${capability}` : '';
  return _authHttpRequest.send(
    'GET',
    `${ENDPOINTS.Models}${qs}`,
    undefined,
    undefined
  );
}
```

Add to `ENDPOINTS`:
```js
Models: `${ApiEndpoint}/models`,
```

### 6c. `source/webapp/src/lib/js/app/mixins/mxAnalysisSettings.js`

Replace the `FoundationModels` static dropdown in the settings model picker (around line 665's `show()`) with the same dynamic fetch pattern used in 6a. Use `ApiHelper.getModels('vision')` for image-analysis settings and `ApiHelper.getModels()` for general settings.

---

## Task 7: Update `solutionManifest.js`

**File:** `source/custom-resources/lib/web/solutionManifest.js`

**Remove** the `FoundationModels` parsing block (lines 179-195):
```js
// parse FoundationModels
const foundationModels = [];
try {
  FoundationModels
    .split(';')
    .filter((x) => x)
    .forEach((x) => {
      const [name, value] = x.split('=');
      foundationModels.push({
        name,
        value,
      });
    });
} catch (e) {
  // do nothing
}
manifest.FoundationModels = foundationModels;
```

**Replace with:**
```js
manifest.FoundationModels = [];
```

This preserves backward compatibility (the array exists but is empty; the webapp no longer reads it for rendering).

**Add** to manifest:
```js
manifest.BedrockModelId = this.data.BedrockModelId || '';
manifest.BedrockVisionModelId = this.data.BedrockVisionModelId || '';
```

---

## Execution order

1. **Task 1** (core-lib `BedrockModel`) — no dependencies
2. **Task 2** (listModels endpoint) — depends on Task 1 only for `core-lib` import
3. **Task 3** (genaiOp migration) — depends on Task 1
4. **Task 4a, 4b, 4c** (analysis lambdas) — depend on Task 1 being in the layer; can be done in parallel
5. **Task 5** (IAM/CFN) — independent of code, but needed before deployment
6. **Task 6** (frontend) — depends on Task 2 (API exists)
7. **Task 7** (solutionManifest) — independent

**Suggested commit sequence:**
1. Tasks 1 + 2 + 3 (backend API migration)
2. Tasks 4a + 4b + 4c (analysis pipeline migration)
3. Task 5 (IAM expansion)
4. Tasks 6 + 7 (frontend + manifest)

---

## Verification checklist

- [ ] `node -e "require('./source/layers/core-lib').BedrockModel"` loads without error
- [ ] `GET /models` returns grouped providers (no Anthropic)
- [ ] GenAI tab → Summarize works with `amazon.nova-lite-v1:0`
- [ ] GenAI tab → Custom prompt works
- [ ] Save/load user template in IndexedDB persists across reload
- [ ] Settings tab model dropdowns populate dynamically
- [ ] Image analysis with vision model (`amazon.nova-pro-v1:0`)
- [ ] Chapter generation on audio transcript
- [ ] Scene taxonomy on video
- [ ] IAM: no `AccessDeniedException` for any whitelisted provider
- [ ] `solution-manifest.js` no longer contains static model list
