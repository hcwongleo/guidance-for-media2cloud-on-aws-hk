# Dynamic Bedrock Model Registry + Editable Prompts — Design

**Date:** 2026-05-19
**Branch:** `short-form-video`
**Sub-project:** B (of 6 in the new-product roadmap)
**Status:** Design — awaiting user review

## Problem

The webapp currently hardcodes Anthropic Claude Haiku as the only Bedrock model, set via the CFN parameter `BedrockModelId`. The current AWS account does not have access to Anthropic Claude. The IAM policy whitelists only `anthropic.claude-*` model ARNs. The GenAI tab's prompt selector lists 7 built-in templates that the user cannot edit (`ENABLE_TEXT_INPUT = false` in `genaiTab.js:66`).

The user wants:

- **B1.** Dynamic model selection across providers Amazon, DeepSeek, MiniMax, Moonshot AI, Qwen, Z.AI. New models added to Bedrock should appear in the picker without a redeploy.
- **B2.** Editable prompt templates — load a built-in template, edit, save under a new name, re-use later.

## Approach (chosen): Bedrock Converse API + IndexedDB-backed prompt templates

Replace `InvokeModelCommand` with `ConverseCommand` everywhere Bedrock is called. Converse is Bedrock's unified messages interface — same request/response shape across Claude, Amazon Nova, DeepSeek, Qwen, MiniMax, Moonshot, Z.AI, etc. Bedrock handles per-provider format translation internally.

Key consequences:

- One generic `BedrockModel` class replaces the Claude-specific `claude.js`. All 4 Bedrock call sites use it.
- A new `GET /models` endpoint hits `ListFoundationModels` server-side, applies a provider whitelist, returns a grouped list. Frontend fetches it on first GenAI/Settings tab open.
- IAM allow list expands to cover the 6 new providers (Anthropic stays for defense-in-depth — see "Claude treatment" below).
- Prompt templates: existing `ENABLE_TEXT_INPUT` flag flipped to `true`; user-saved templates persisted in IndexedDB via the existing `settingStore`.

### Approaches considered and rejected

- **Per-provider adapter classes (one file per provider).** Reimplements what Converse already does; ~6 new files, growing maintenance.
- **Hybrid (Converse + InvokeModel fallback).** Premature complexity — every requested provider supports Converse today.
- **Deploy-time bake of the model list.** Requires CFN redeploy when new models appear on Bedrock — explicitly rejected by the user's requirement that new models appear "dynamically."
- **DynamoDB-backed shared prompts.** Adds a table, two endpoints, and IAM. User confirmed single-machine-per-operator workflow is fine; IndexedDB persists across logout.

### Claude treatment (option 2 from brainstorming)

UI hides Claude from the picker. IAM keeps Claude on the allow list (defense-in-depth — re-enabling Claude later is a UI toggle, not an IAM redeploy). The current account has no Claude model access enabled at the Bedrock level, so an accidental Claude invocation would fail at the model layer regardless.

## Scope

### In scope

- Backend Converse migration for all 4 Bedrock call sites:
  - `source/api/lib/operations/genai/claude.js` → replaced by `bedrockModel.js`
  - `source/main/analysis/audio/states/collect-transcribe-results/index.js` (chapter generation)
  - `source/main/analysis/post-process/states/create-scene-taxonomy/index.js` (scene taxonomy)
  - `source/main/analysis/image/states/start-image-analysis/index.js` (image analysis, multimodal)
- New backend endpoint `GET /models` with optional `?capability=text|vision`.
- IAM expansion in `deployment/media2cloud-backend-stack.yaml` for the 6 new providers + `bedrock:Converse` action.
- Frontend: model dropdown overhaul in GenAI tab and Settings tab; editable prompts with named-save in IndexedDB.
- `solution-manifest.js` no longer bakes `FoundationModels`; only carries the fallback default model id.
- Update env-var defaults: `BedrockModelId` → `amazon.nova-lite-v1:0`; new `BedrockVisionModelId` → `amazon.nova-pro-v1:0`.

### Out of scope

- DynamoDB-backed shared prompts (deferred to a future sub-project if multi-operator demand emerges).
- Streaming / `ConverseStream` (current code is one-shot; switch later if UX demands typing-style output).
- Per-model parameter tuning beyond `temperature` and `max_tokens` (these stay).
- Replacing the analysis-pipeline's *prompt content* (the chapter, taxonomy, scene-description prompts stay text-as-coded). Only the *model* used is changed; prompts in those backend ops remain hardcoded.
- Tool use / function calling — current Bedrock calls don't use them.

## Implementation

### Backend

#### New: `source/layers/core-lib/lib/genai/bedrockModel.js`

Single class wrapping Converse:

```js
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

class BedrockModel {
  constructor(opts = {}) {
    this.region = opts.region || process.env.ENV_BEDROCK_REGION || process.env.AWS_REGION;
    this.fallbackModelId = opts.fallbackModelId || process.env.ENV_BEDROCK_MODEL_ID;
    this.client = new BedrockRuntimeClient({ region: this.region });
  }

  async inference(task, inputParams = {}) {
    const { system, messages, inferenceConfig } = _buildConverseInput(task, inputParams);
    const modelId = inputParams.modelId || this.fallbackModelId;
    const response = await this.client.send(new ConverseCommand({
      modelId,
      system: system ? [{ text: system }] : undefined,
      messages,
      inferenceConfig,
    }));
    const text = _parseOutputContent(response.output.message.content[0].text);
    return {
      content: [{ text }],
      modelId,
      stopReason: response.stopReason,
      usage: response.usage,
    };
  }
}

module.exports = BedrockModel;
```

`_buildConverseInput(task, inputParams)` is a renamed/refactored version of the existing `_createModelInput` in `claude.js`, producing Converse-shaped output instead of Anthropic-shaped:

- `system` → string (Converse wraps to `[{ text }]` automatically; we use the simple string form for clarity).
- `messages` → array of `{ role: 'user'|'assistant', content: [{ text: '...' }] }`. The existing role/content pattern translates 1:1; we just wrap each `content` string into `[{ text: ... }]`.
- The `'{'` pre-fill assistant message is removed; instead the system prompt for each task gets an explicit instruction: *"Respond with only a JSON object. No markdown, no commentary."* `_parseOutputContent` (the existing JSON-fence stripper) handles minor variations.
- For vision tasks (image analysis), `messages[0].content` is `[{ image: { format, source: { bytes } } }, { text: '...' }]`.

`_parseOutputContent` moves from `claude.js` to `bedrockModel.js` unchanged.

The 7 task builders (`_createGenrePrompt`, `_createSummarizePrompt`, `_createSentimentPrompt`, `_createTaxonomyPrompt`, `_createThemePrompt`, `_createTVRatingsPrompt`, `_createCustomPrompt`) move from `claude.js` into `bedrockModel.js`, refactored to emit Converse-shaped messages. All 7 are kept; the user can still pick "Genre", "Sentiment", etc. from the GenAI tab.

#### Deleted: `source/api/lib/operations/genai/claude.js`

#### Modified: `source/api/lib/operations/genai/genaiOp.js`

The model validator at lines 43-51 currently does `Claude.canSupport(modelName)` (must contain `anthropic.claude`). Loosen to: accept any modelId returned by the `/models` endpoint's whitelist. Concretely, fetch the cached whitelist on the first request and validate against it.

#### Modified: 3 backend operations

`collect-transcribe-results/index.js`, `create-scene-taxonomy/index.js`, `start-image-analysis/index.js` — each currently constructs a Claude-format request body and calls `BedrockRuntimeClient.send(InvokeModelCommand)` directly. Replace with `new BedrockModel({ fallbackModelId: ... }).inference(task, params)`.

For image analysis specifically: the modelId comes from the job's analysis settings (which already carries a model selection). If unset, falls back to `process.env.ENV_BEDROCK_VISION_MODEL_ID` (new env var, CFN parameter `BedrockVisionModelId`, default `amazon.nova-pro-v1:0`).

#### New: `GET /models` endpoint

Path: `/models`. Method: GET. Query: `?capability=text|vision` (default `text`).

Lambda implementation in `source/api/lib/operations/listModels.js`:

```js
const PROVIDER_WHITELIST = ['Amazon', 'DeepSeek', 'MiniMax', 'Moonshot AI', 'Qwen', 'Z.AI'];
let _cache = null;
let _cacheExpiresAt = 0;

async function listModels(capability = 'text') {
  if (_cache && Date.now() < _cacheExpiresAt) return _filter(_cache, capability);
  const client = new BedrockClient({ region: process.env.ENV_BEDROCK_REGION || process.env.AWS_REGION });
  const all = [];
  let nextToken;
  do {
    const r = await client.send(new ListFoundationModelsCommand({ nextToken, byOutputModality: 'TEXT' }));
    all.push(...r.modelSummaries);
    nextToken = r.nextToken;
  } while (nextToken);
  _cache = all.filter(m =>
    PROVIDER_WHITELIST.includes(m.providerName) &&
    m.modelLifecycle?.status === 'ACTIVE' &&
    (m.inferenceTypesSupported || []).includes('ON_DEMAND'));
  _cacheExpiresAt = Date.now() + 5 * 60 * 1000;
  return _filter(_cache, capability);
}

function _filter(models, capability) {
  if (capability === 'vision') {
    return _group(models.filter(m => (m.inputModalities || []).includes('IMAGE')));
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
```

Wired into the existing API Gateway via `source/api/lib/api/...` (follows the existing GET-route registration pattern).

#### CFN: `deployment/media2cloud-backend-stack.yaml`

- IAM policy for `bedrock:InvokeModel` and (new) `bedrock:Converse` — add 6 provider ARN patterns (foundation-model + inference-profile) alongside the existing Anthropic patterns. Specifically:
  - `arn:aws:bedrock:*::foundation-model/{amazon,deepseek,minimax,moonshotai,moonshot,qwen,zai}.*`
  - `arn:aws:bedrock:*:${AccountId}:inference-profile/*.{amazon,deepseek,minimax,moonshotai,moonshot,qwen,zai}.*`
- New CFN parameter `BedrockVisionModelId` (default `amazon.nova-pro-v1:0`); plumbed to the `start-image-analysis` lambda's environment as `ENV_BEDROCK_VISION_MODEL_ID`.
- Update default of existing `BedrockModelId` parameter from `global.anthropic.claude-haiku-4-5-20251001-v1:0` to `amazon.nova-lite-v1:0`.

### Frontend

#### `source/webapp/src/lib/js/app/mainView/collection/base/components/analysis/genai/genaiTab.js`

- Set `ENABLE_TEXT_INPUT = true` (line 66).
- Replace the static model dropdown (currently parsed from `solution-manifest.js`'s `FoundationModels`) with a 2-level grouped dropdown built from `GET /models?capability=text`. Provider headers, model items underneath. Selection persists in IndexedDB via `settingStore.putItem('genai.lastModel', modelId)`.
- For each of the 7 built-in prompts (Summarize, Genre, …): when the user selects one, the prompt text is loaded into a `<textarea>` (which is now visible because `ENABLE_TEXT_INPUT = true`). User can edit before clicking "Send".
- Add a "Save as…" button next to the textarea. Clicking it prompts for a name; the prompt + last selected task type are stored under `genai.prompts.{name}` in IndexedDB.
- Add a "My templates" group to the prompt dropdown, listing user-saved entries. Click → load into textarea (same as built-ins). Add a "Delete" affordance on each saved template.

#### `source/webapp/src/lib/js/app/mixins/mxAnalysisSettings.js`

- Replace the FoundationModels static dropdown with the same `/models` fetch. Cache the result on the mixin instance so multiple fields share one fetch.
- Image-analysis sub-section uses `?capability=vision`. (Currently the Settings tab doesn't separate vision-capable from text-only — this is an improvement.)
- Settings persist via the existing settings flow; only the rendering of the dropdown changes.

#### `source/custom-resources/lib/web/solutionManifest.js`

- Stop emitting `FoundationModels` into the manifest (the static deploy-time list is no longer needed).
- Keep emitting `BedrockModelId` (default fallback) and `BedrockVisionModelId` (new) so the webapp has reasonable defaults before `/models` resolves.

### Webapp deploy

Webapp changes ship via the rebuild + SRI-patch + CloudFront-invalidate flow documented in the project memory `webapp-deploy-path.md`. Backend changes (lambdas, IAM) require a full `build-s3-dist.sh` + `deploy-s3-dist.sh` + CFN stack update.

## Verification

### Backend / lambda

1. **Unit-style smoke test for `bedrockModel.js`** — call each task builder against `amazon.nova-lite-v1:0` with a fixture transcript; assert response is a parseable JSON with the expected keys (e.g. `genres`, `summary`). Run from a local node env with AWS creds (the dev account's Bedrock access).
2. **Unit-style test for `/models`** — invoke the lambda locally; assert response groups all 6 providers; assert `?capability=vision` returns only providers/models with `IMAGE` in modalities.

### IAM

3. After CFN update: from the M2C admin console, run a summarize on a sample transcript with each of the 6 providers' default models. Assert no `AccessDeniedException`.

### Frontend

4. **GenAI tab:** open a video analysis result. Confirm the model dropdown lists all 6 providers grouped, no Anthropic. Pick a non-default model, run summarize, observe response. Edit the loaded prompt text and re-run; confirm response reflects the edit.
5. **Save & re-use:** save a custom prompt as "HK 書面語 SRT cleanup" (wired up in sub-project D), reload the page, confirm it appears under "My templates" and loads correctly.
6. **Settings tab:** open settings as admin; confirm model dropdowns populate from `/models`. Image-analysis section shows only vision-capable models.
7. **Pipeline:** kick off a new ingest of a sample video; confirm the chapter-generation, scene-taxonomy, and image-analysis stages run successfully against the new default models.

### Failure modes

8. Pick a model the account doesn't have access to (if any) and run summarize. Expected: backend returns a friendly error ("model access not granted"); UI shows it; no stack trace.
9. With `/models` cache cold and the lambda's first invocation hitting throttling, confirm graceful fallback to the fallback default model id.

## Risks

- **Provider response variation.** Some providers may not honor "respond with JSON only" as cleanly as Claude. The existing `_parseOutputContent` handles fence-stripped output and `{...}` boundary detection — should cover most cases. Monitor during verification step 4.
- **Vision-model availability.** If the user's preferred vision model is rate-limited or removed, image analysis breaks for affected jobs. Fallback chain: job-specific modelId → `BedrockVisionModelId` env var → hardcoded `amazon.nova-pro-v1:0`.
- **`bedrock:Converse` action — IAM coverage.** Some older Bedrock features still require `bedrock:InvokeModel` (e.g. for non-Converse-capable models). We allow both actions on the same resource set so we don't paint ourselves into a corner.
- **CFN parameter rename.** Updating `BedrockModelId`'s *default* doesn't change existing stack instances on update — they keep their previously-set value. Operators must explicitly change it during the stack update if they want the new default.
- **`solution-manifest.js` shape change.** Removing `FoundationModels` from the manifest could break custom forks or external consumers reading that field. We keep `BedrockModelId` for backwards compatibility.

## Out of scope / follow-ups

- DynamoDB-backed shared prompt library across users.
- `ConverseStream` for typing-style summarization output.
- Per-task default-model overrides (e.g. "always use Amazon Nova Pro for taxonomy"). Currently one default applies to all GenAI tasks.
- Migrating prompt strings themselves to be configurable per-deploy (currently hardcoded in `bedrockModel.js`).
