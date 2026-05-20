// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const Environment = require('../environment');
const xraysdkHelper = require('../xraysdkHelper');
const retryStrategyHelper = require('../retryStrategyHelper');
const Errors = require('../error');

const {
  Solution: {
    Metrics: {
      CustomUserAgent,
    },
  },
} = Environment;

const {
  M2CException,
} = Errors;

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
    maxTokens: 4096,
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

  switch (task) {
    case 'genre':
      return _createGenreInput(inputParams, inferenceConfig);
    case 'sentiment':
      return _createSentimentInput(inputParams, inferenceConfig);
    case 'summarize':
      return _createSummarizeInput(inputParams, inferenceConfig);
    case 'taxonomy':
      return _createTaxonomyInput(inputParams, inferenceConfig);
    case 'theme':
      return _createThemeInput(inputParams, inferenceConfig);
    case 'tvratings':
      return _createTVRatingsInput(inputParams, inferenceConfig);
    case 'custom':
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
    'Melodrama', 'Historical drama', 'Crime fiction',
    'Romantic comedy', 'Dark comedy', 'History', 'Slapstick',
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
  const IABTaxonomy = require('../iabTaxonomyV3');
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
  const system = 'You are a media operation engineer responsible for reviewing transcripts and summarize the dialogues into one or two paragraphs and provide a confidence score from 0 to 100. Respond with only a JSON object. No markdown, no commentary.\n\n**輸出語言要求（強制）：JSON 中 "summary.text" 欄位必須以「書面語繁體中文」撰寫，禁止使用英文或其他語言。專有名詞（人名、地名、品牌）可保留原文。**';
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
  const system = 'You are a media operation engineer responsible for reviewing transcripts and answer the following question and provide a confidence score from 0 to 100. Respond with only a JSON object. No markdown, no commentary.\n\n**輸出語言要求（強制）：JSON 中 "custom.text" 欄位必須以「書面語繁體中文」撰寫，禁止使用英文或其他語言。專有名詞（人名、地名、品牌）可保留原文。**';
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
