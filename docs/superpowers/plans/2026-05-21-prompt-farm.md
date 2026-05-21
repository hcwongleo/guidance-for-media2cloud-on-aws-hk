# Prompt Farm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a globally-shared, S3-backed library of named AI-edit prompts for the Transcribe tab, manageable from Settings.

**Architecture:** New `SubtitlePromptsOp` mirrors `McTemplatesOp` (one JSON per prompt under `_settings/subtitle-prompts/<name>.json` in ProxyBucket). New API route `/subtitle-prompts` registered in `apiRequest.js`. Settings page gains a `createSubtitlePromptsForm()` form below `createMcTemplatesForm()`. Transcribe tab swaps its inline-only prompt textarea for a dropdown-driven picker that pre-fills the textarea (still editable as one-shot). Legacy per-asset `GET/POST /subtitle/{uuid}/prompt` is removed.

**Tech Stack:** Node.js (api Lambda), vanilla ES6 + jQuery + Bootstrap 4 (webapp), S3 (storage), CloudFront (webapp delivery).

**Spec:** `docs/superpowers/specs/2026-05-21-prompt-farm-design.md`

---

## File map

**Backend (Lambda):**
- Create: `source/api/lib/operations/subtitlePromptsOp.js`
- Modify: `source/api/lib/apiRequest.js` (register route)
- Modify: `source/api/lib/operations/subtitleOp.js` (remove `_savePrompt`, `_getPrompt`, `'prompt'` GET/POST branches, `DEFAULT_PROMPT` const)
- Modify: `source/layers/core-lib/lib/apiOps.js` (add `SubtitlePrompts` constant, update `Subtitle` doc-block)

**Webapp:**
- Modify: `source/webapp/src/lib/js/app/shared/apiHelper.js` (add `ENDPOINTS.SubtitlePrompts`, replace 4 prompt methods)
- Modify: `source/webapp/src/lib/js/app/mainView/settingsTab.js` (add `createSubtitlePromptsForm()`, append in `createSkeleton()`)
- Modify: `source/webapp/src/lib/js/app/mainView/collection/base/components/analysis/transcribe/transcribeTab.js` (replace prompt textarea block with picker+textarea; load library on AI-Edit toggle)

**Deploy:**
- api Lambda: redeploy via `update-function-code` after CFN package
- webapp: surgical path (rollup → SRI patch → S3 cp → CloudFront invalidate)

---

## Task 1: Create `SubtitlePromptsOp` backend

**Files:**
- Create: `source/api/lib/operations/subtitlePromptsOp.js`

- [ ] **Step 1: Create `subtitlePromptsOp.js` mirroring `mcTemplatesOp.js`**

```js
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const PATH = require('path');
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

const PROMPTS_PREFIX = '_settings/subtitle-prompts';
const PROMPT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_NAME = 'default';
const DEFAULT_PROMPT = '將以下字幕轉換為書面語繁體中文。要求：1. 保留所有時間碼，不可改動 2. 保留 SRT 編號格式 3. 將口語廣東話轉換為正式書面語繁體中文 4. 保留專有名詞 5. 只輸出有效的 SRT 格式，不要額外說明';

class SubtitlePromptsOp extends BaseOp {
  async onGET() {
    const name = this._promptName();
    if (!name) {
      return super.onGET(await this._listPrompts());
    }
    return super.onGET(await this._getPrompt(name));
  }

  async onPOST() {
    const name = this._promptName();
    if (!name) {
      throw new M2CException('prompt name required');
    }
    return super.onPOST(await this._savePrompt(name));
  }

  async onDELETE() {
    const name = this._promptName();
    if (!name) {
      throw new M2CException('prompt name required');
    }
    return super.onDELETE(await this._deletePrompt(name));
  }

  _promptName() {
    const raw = (this.request.pathParameters || {}).uuid || '';
    return raw.split('/').filter((x) => x.length > 0)[0] || '';
  }

  async _listPrompts() {
    await this._seedDefaultIfMissing();
    const response = await CommonUtils.listObjects(ProxyBucket, `${PROMPTS_PREFIX}/`)
      .catch(() => undefined);
    const contents = (response && response.Contents) || [];
    const re = new RegExp(`^${PROMPTS_PREFIX}/([A-Za-z0-9_-]{1,64})\\.json$`);
    const items = [];
    for (const o of contents) {
      const m = (o.Key || '').match(re);
      if (!m) continue;
      const name = m[1];
      const prompt = await this._loadPromptText(name);
      items.push({ name, prompt, lastModified: o.LastModified });
    }
    items.sort((a, b) => {
      if (a.name === DEFAULT_NAME) return -1;
      if (b.name === DEFAULT_NAME) return 1;
      return a.name.localeCompare(b.name);
    });
    return { prompts: items };
  }

  async _seedDefaultIfMissing() {
    const key = `${PROMPTS_PREFIX}/${DEFAULT_NAME}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (exists) return;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify({ name: DEFAULT_NAME, prompt: DEFAULT_PROMPT }), 'utf8')
    );
  }

  async _loadPromptText(name) {
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    const buf = await CommonUtils.download(ProxyBucket, key);
    const data = JSON.parse(buf.toString('utf8'));
    return data.prompt || '';
  }

  async _getPrompt(name) {
    if (!PROMPT_NAME_RE.test(name)) {
      throw new M2CException(`invalid prompt name: ${name}`);
    }
    if (name === DEFAULT_NAME) {
      await this._seedDefaultIfMissing();
    }
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    const head = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!head) {
      throw new M2CException(`prompt not found: ${name}`);
    }
    const prompt = await this._loadPromptText(name);
    return { name, prompt, lastModified: head.LastModified };
  }

  async _savePrompt(name) {
    if (!PROMPT_NAME_RE.test(name)) {
      throw new M2CException(`invalid prompt name: ${name}`);
    }
    const body = this.request.body || {};
    const prompt = body.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new M2CException('prompt body must be a non-empty string');
    }
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    await CommonUtils.uploadFile(
      ProxyBucket,
      PATH.dirname(key),
      PATH.basename(key),
      Buffer.from(JSON.stringify({ name, prompt }), 'utf8')
    );
    return { name, prompt };
  }

  async _deletePrompt(name) {
    if (!PROMPT_NAME_RE.test(name)) {
      throw new M2CException(`invalid prompt name: ${name}`);
    }
    const key = `${PROMPTS_PREFIX}/${name}.json`;
    const exists = await CommonUtils.headObject(ProxyBucket, key).catch(() => undefined);
    if (!exists) {
      return { name, deleted: false };
    }
    await CommonUtils.deleteObject(ProxyBucket, key);
    return { name, deleted: true };
  }
}

module.exports = SubtitlePromptsOp;
```

- [ ] **Step 2: Smoke-test the file parses**

Run: `node -e "require('./source/api/lib/operations/subtitlePromptsOp.js'); console.log('ok');"`
Expected: `ok` (will fail if a syntax error or missing local require).

> Note: this test only checks parse + local resolution. The op imports `core-lib`, which is only resolvable inside the api Lambda; the parse check still validates JS syntax up to the point of the require. If the run errors out on `core-lib`, that's fine — the test passes if the error is a `MODULE_NOT_FOUND` for `core-lib` and not a `SyntaxError`.

Acceptable error: `Cannot find module 'core-lib'`.
Failure: any `SyntaxError`.

- [ ] **Step 3: Commit**

```bash
git add source/api/lib/operations/subtitlePromptsOp.js
git commit -m "Add SubtitlePromptsOp for shared AI-edit prompt library"
```

---

## Task 2: Add `SubtitlePrompts` ApiOps constant

**Files:**
- Modify: `source/layers/core-lib/lib/apiOps.js`

- [ ] **Step 1: Add the new constant + update Subtitle doc-block**

In `source/layers/core-lib/lib/apiOps.js`, find the `Subtitle: 'subtitle',` block (around line 142-147) and update its doc to drop the legacy `/prompt` route. Then append a new `SubtitlePrompts` block before the closing brace.

Replace:
```js
  /**
   * @description Subtitle export and AI editing
   * /subtitle/{uuid}/srt
   * /subtitle/{uuid}/ai-edit
   * method: GET, POST
   */
  Subtitle: 'subtitle',
```

(no change needed if doc already matches — leave as-is.)

Insert before the final `};` (after the `McTemplates` block):
```js
  /**
   * @description shared library of named AI-edit prompts (Transcribe tab)
   * /subtitle-prompts                          GET:    list prompts
   * /subtitle-prompts/{name}                   GET:    fetch one prompt
   * /subtitle-prompts/{name}                   POST:   upsert prompt body
   * /subtitle-prompts/{name}                   DELETE: drop a prompt
   */
  SubtitlePrompts: 'subtitle-prompts',
```

- [ ] **Step 2: Verify no syntax error**

Run: `node -e "console.log(require('./source/layers/core-lib/lib/apiOps').SubtitlePrompts)"`
Expected: `subtitle-prompts`

- [ ] **Step 3: Commit**

```bash
git add source/layers/core-lib/lib/apiOps.js
git commit -m "Add SubtitlePrompts ApiOps constant"
```

---

## Task 3: Wire the route in `apiRequest.js`

**Files:**
- Modify: `source/api/lib/apiRequest.js`

- [ ] **Step 1: Verify current dispatch shape**

Run: `grep -n "mc-templates\|McTemplatesOp\|OP_SUBTITLE\|SubtitleOp" source/api/lib/apiRequest.js`

Confirm `McTemplatesOp` is required + dispatched and `SubtitleOp` is required + dispatched. If layout differs from what's described below, use the same surrounding context to place the new wiring.

- [ ] **Step 2: Add the require**

In `source/api/lib/apiRequest.js`, find the `const McTemplatesOp = require('./operations/mcTemplatesOp');` line and add immediately after it:
```js
const SubtitlePromptsOp = require('./operations/subtitlePromptsOp');
```

- [ ] **Step 3: Add the dispatch branch**

Find the dispatch line:
```js
if (op === 'mc-templates' || op === ApiOps.McTemplates) {
  return new McTemplatesOp(this);
}
```

Add immediately after it:
```js
if (op === 'subtitle-prompts' || op === ApiOps.SubtitlePrompts) {
  return new SubtitlePromptsOp(this);
}
```

- [ ] **Step 4: Verify file still parses**

Run: `node --check source/api/lib/apiRequest.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add source/api/lib/apiRequest.js
git commit -m "Wire /subtitle-prompts route to SubtitlePromptsOp"
```

---

## Task 4: Remove legacy per-asset prompt endpoints from `subtitleOp.js`

**Files:**
- Modify: `source/api/lib/operations/subtitleOp.js`

- [ ] **Step 1: Remove the `'prompt'` GET branch**

In `subtitleOp.js`, in `onGET()`, remove:
```js
    if (subOp === 'prompt') {
      return super.onGET(await this._getPrompt(uuid));
    }
```

- [ ] **Step 2: Remove the `'prompt'` POST branch**

In `onPOST()`, remove:
```js
    if (subOp === 'prompt') {
      return super.onPOST(await this._savePrompt(uuid));
    }
```

- [ ] **Step 3: Remove `_savePrompt` and `_getPrompt` methods**

Remove the entire `_savePrompt(uuid)` and `_getPrompt(uuid)` method bodies (around lines 232-256).

- [ ] **Step 4: Keep `DEFAULT_PROMPT` — it's still the fallback in `_aiEditSubtitle`**

Confirm `_aiEditSubtitle` still uses `body.prompt || DEFAULT_PROMPT`. If yes, leave the constant. If after removal there are no other references, also drop the const.

Run: `grep -n DEFAULT_PROMPT source/api/lib/operations/subtitleOp.js`
Expected: at least one match in `_aiEditSubtitle`.

- [ ] **Step 5: Verify file still parses**

Run: `node --check source/api/lib/operations/subtitleOp.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add source/api/lib/operations/subtitleOp.js
git commit -m "Remove per-asset prompt endpoints from SubtitleOp"
```

---

## Task 5: ApiHelper — add endpoint + replace prompt methods

**Files:**
- Modify: `source/webapp/src/lib/js/app/shared/apiHelper.js`

- [ ] **Step 1: Add `SubtitlePrompts` to `ENDPOINTS`**

In `source/webapp/src/lib/js/app/shared/apiHelper.js`, in the `ENDPOINTS` block (lines 14-49), add a new entry next to the other manually-keyed endpoints:
```js
  SubtitlePrompts: `${ApiEndpoint}/subtitle-prompts`,
```

(Hardcoded path matches the `Subtitle` and `McTemplates` precedent — `SolutionManifest.ApiOps` is build-time-injected and doesn't yet contain the new constant.)

- [ ] **Step 2: Replace `getSubtitlePrompt` and `saveSubtitlePrompt` signatures**

Find the current methods (around lines 542-555):
```js
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
```

Replace with the four library methods:
```js
  // Shared AI-edit prompt library (Transcribe tab + Settings)
  static async listSubtitlePrompts() {
    return _authHttpRequest.send(
      'GET',
      ENDPOINTS.SubtitlePrompts
    );
  }

  static async getSubtitlePrompt(name) {
    return _authHttpRequest.send(
      'GET',
      `${ENDPOINTS.SubtitlePrompts}/${encodeURIComponent(name)}`
    );
  }

  static async saveSubtitlePrompt(name, prompt) {
    return _authHttpRequest.send(
      'POST',
      `${ENDPOINTS.SubtitlePrompts}/${encodeURIComponent(name)}`,
      undefined,
      { prompt }
    );
  }

  static async deleteSubtitlePrompt(name) {
    return _authHttpRequest.send(
      'DELETE',
      `${ENDPOINTS.SubtitlePrompts}/${encodeURIComponent(name)}`
    );
  }
```

- [ ] **Step 3: Verify `ApiHelper.getSubtitlePrompt` and `saveSubtitlePrompt` are not called from any other webapp file with the old `(uuid, ...)` signature**

Run: `grep -rn "ApiHelper.getSubtitlePrompt\|ApiHelper.saveSubtitlePrompt" source/webapp/src/`
Expected: zero hits (the design notes the methods exist but are dead code in the current Transcribe tab — they will be re-introduced as callers in Task 7).

If there are unexpected hits, those callers must be updated to pass `name` instead of `uuid` — log the file paths and address before continuing.

- [ ] **Step 4: Commit**

```bash
git add source/webapp/src/lib/js/app/shared/apiHelper.js
git commit -m "ApiHelper: add prompt library endpoints, replace per-uuid methods"
```

---

## Task 6: Settings page — `createSubtitlePromptsForm()`

**Files:**
- Modify: `source/webapp/src/lib/js/app/mainView/settingsTab.js`

- [ ] **Step 1: Add the section header constants**

In `settingsTab.js` near the top, after the `MSG_MC_TEMPLATES` / `MSG_MC_TEMPLATES_DESC` constants (around line 23-29), add:
```js
const MSG_SUBTITLE_PROMPTS = 'Subtitle AI-edit prompts';
const MSG_SUBTITLE_PROMPTS_DESC = 'Manage the shared library of named prompts used by '
  + 'the Transcribe tab&rsquo;s AI Edit feature. The <code>default</code> entry is '
  + 'auto-seeded if the library is empty (delete it to reset to the factory '
  + 'prompt). Names must be A-Z, a-z, 0-9, _, - (max 64 chars).';
```

- [ ] **Step 2: Append the form to `createSkeleton()`**

In `createSkeleton()` (around lines 47-56), add a new local + append it:

Before:
```js
    const datastoreForm = this.createDatastoreForm();
    const mcTemplatesForm = this.createMcTemplatesForm();

    const first = container.children()
      .first();

    first.after($('<div/>')
      .addClass('col-9 p-0 mx-auto mt-4')
      .append(datastoreForm)
      .append(mcTemplatesForm));
```

After:
```js
    const datastoreForm = this.createDatastoreForm();
    const mcTemplatesForm = this.createMcTemplatesForm();
    const subtitlePromptsForm = this.createSubtitlePromptsForm();

    const first = container.children()
      .first();

    first.after($('<div/>')
      .addClass('col-9 p-0 mx-auto mt-4')
      .append(datastoreForm)
      .append(mcTemplatesForm)
      .append(subtitlePromptsForm));
```

- [ ] **Step 3: Add the `createSubtitlePromptsForm()` method**

Add the method to the `SettingsTab` class, immediately after `createMcTemplatesForm()` (just before `createObserver(element)`):
```js
  createSubtitlePromptsForm() {
    const container = $('<div/>')
      .addClass('ai-group')
      .addClass('overflow-auto my-auto align-content-start');

    const itemContainer = $('<div/>')
      .addClass('mt-4');
    container.append(itemContainer);

    const title = $('<span/>')
      .addClass('d-block p-2 bg-light text-black lead')
      .html(MSG_SUBTITLE_PROMPTS);
    itemContainer.append(title);

    const desc = $('<p/>')
      .addClass('lead-s mt-4')
      .html(MSG_SUBTITLE_PROMPTS_DESC);
    itemContainer.append(desc);

    const form = $('<form/>')
      .addClass('col-12 px-0 mt-4')
      .attr('role', 'form');
    itemContainer.append(form);

    // top row: select + new + delete + refresh
    const topRow = $('<div/>')
      .addClass('form-inline d-flex flex-wrap align-items-center mb-2');
    form.append(topRow);

    const select = $('<select/>')
      .addClass('custom-select custom-select-sm w-auto mr-2 mb-1')
      .attr('data-role', 'sp-select');
    topRow.append(select);

    const newBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('type', 'button')
      .html('New prompt');
    const deleteBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-danger mr-2 mb-1')
      .attr('type', 'button')
      .html('Delete');
    const refreshBtn = $('<button/>')
      .addClass('btn btn-sm btn-link mb-1')
      .attr('type', 'button')
      .html('Refresh list');
    topRow.append(newBtn).append(deleteBtn).append(refreshBtn);

    // editor: name + textarea + save
    const nameLabel = $('<label/>')
      .addClass('lead-xs mb-1')
      .html('Name');
    const nameInput = $('<input/>')
      .attr('type', 'text')
      .addClass('form-control form-control-sm mb-2')
      .attr('placeholder', 'A-Z, a-z, 0-9, _, - (max 64)')
      .prop('disabled', true);
    const promptLabel = $('<label/>')
      .addClass('lead-xs mb-1')
      .html('Prompt');
    const promptInput = $('<textarea/>')
      .addClass('form-control form-control-sm mb-2')
      .attr('rows', 12);
    const saveBtn = $('<button/>')
      .addClass('btn btn-sm btn-success')
      .attr('type', 'button')
      .html('Save prompt');
    form.append(nameLabel, nameInput, promptLabel, promptInput, saveBtn);

    const status = $('<span/>')
      .addClass('lead-xs text-muted ml-2 mb-1 d-block')
      .attr('data-role', 'sp-status');
    form.append(status);

    const setStatus = (text, kind) => {
      status.removeClass('text-muted text-success text-danger');
      if (kind === 'ok') status.addClass('text-success');
      else if (kind === 'err') status.addClass('text-danger');
      else status.addClass('text-muted');
      status.html(text || '');
    };

    let editingName = '';

    const setEditing = (name, prompt) => {
      editingName = name || '';
      nameInput.val(editingName);
      nameInput.prop('disabled', !!editingName); // existing entries: name is immutable
      promptInput.val(prompt || '');
      deleteBtn.prop('disabled', !editingName);
    };

    const refresh = async (preferredName) => {
      try {
        setStatus('Loading prompts...');
        const res = await ApiHelper.listSubtitlePrompts();
        const prompts = (res && res.prompts) || [];
        select.empty();
        prompts.forEach((p) => {
          select.append($('<option/>').attr('value', p.name).text(p.name));
        });
        const target = preferredName && prompts.find((p) => p.name === preferredName)
          ? preferredName
          : (prompts[0] && prompts[0].name) || '';
        if (target) {
          select.val(target);
          const picked = prompts.find((p) => p.name === target);
          setEditing(picked.name, picked.prompt);
        } else {
          setEditing('', '');
        }
        setStatus(`${prompts.length} prompt(s) available.`, 'ok');
      } catch (e) {
        console.error(e);
        setStatus(`Error loading prompts: ${e.message}`, 'err');
      }
    };

    const onSelect = async () => {
      const name = select.val();
      if (!name) {
        setEditing('', '');
        return;
      }
      try {
        const res = await ApiHelper.getSubtitlePrompt(name);
        setEditing(res.name, res.prompt);
        setStatus(`Loaded ${name}.`, 'ok');
      } catch (e) {
        console.error(e);
        setStatus(`Load failed: ${e.message}`, 'err');
      }
    };

    const onSave = async () => {
      const name = nameInput.val().trim();
      const prompt = promptInput.val();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        setStatus('Name must be A-Z, a-z, 0-9, _, - (max 64 chars).', 'err');
        return;
      }
      if (!prompt || !prompt.trim()) {
        setStatus('Prompt cannot be empty.', 'err');
        return;
      }
      try {
        setStatus(`Saving ${name}...`);
        await ApiHelper.saveSubtitlePrompt(name, prompt);
        setStatus(`Saved ${name}.`, 'ok');
        await refresh(name);
      } catch (e) {
        console.error(e);
        setStatus(`Save failed: ${e.message}`, 'err');
      }
    };

    const onDelete = async () => {
      const name = editingName;
      if (!name) return;
      if (!window.confirm(`Delete prompt "${name}"? (Deleting "default" re-seeds it on next reload.)`)) {
        return;
      }
      try {
        setStatus(`Deleting ${name}...`);
        const res = await ApiHelper.deleteSubtitlePrompt(name);
        if (res && res.deleted) {
          setStatus(`Deleted ${name}.`, 'ok');
        } else {
          setStatus(`No entry named ${name}.`, 'ok');
        }
        await refresh();
      } catch (e) {
        console.error(e);
        setStatus(`Delete failed: ${e.message}`, 'err');
      }
    };

    const onNew = () => {
      select.val('');
      setEditing('', '');
      nameInput.prop('disabled', false);
      nameInput.trigger('focus');
      setStatus('Enter a name and prompt, then click Save.', 'muted');
    };

    form.submit((event) => { event.preventDefault(); });
    select.on('change', onSelect);
    saveBtn.on('click', onSave);
    deleteBtn.on('click', onDelete);
    newBtn.on('click', onNew);
    refreshBtn.on('click', () => refresh());

    container.ready(() => {
      refresh().catch(() => {});
    });

    return container;
  }
```

- [ ] **Step 4: Commit**

```bash
git add source/webapp/src/lib/js/app/mainView/settingsTab.js
git commit -m "Settings: add subtitle-prompts library form"
```

---

## Task 7: Transcribe tab — picker + editable textarea

**Files:**
- Modify: `source/webapp/src/lib/js/app/mainView/collection/base/components/analysis/transcribe/transcribeTab.js`

- [ ] **Step 1: Replace the prompt label + textarea block with picker + editable textarea**

In `transcribeTab.js`, find the block at lines 229-238:
```js
    const promptLabel = $('<label/>')
      .addClass('lead-xs mb-1 mt-2')
      .html('Prompt');
    editForm.append(promptLabel);

    const promptInput = $('<textarea/>')
      .addClass('form-control form-control-sm')
      .attr('rows', 4)
      .val(DEFAULT_AI_PROMPT);
    editForm.append(promptInput);
```

Replace with:
```js
    const promptLabel = $('<label/>')
      .addClass('lead-xs mb-1 mt-2')
      .html('Prompt');
    editForm.append(promptLabel);

    const promptSelect = $('<select/>')
      .addClass('custom-select custom-select-sm mb-2');
    editForm.append(promptSelect);

    const promptInput = $('<textarea/>')
      .addClass('form-control form-control-sm')
      .attr('rows', 6)
      .val(DEFAULT_AI_PROMPT);
    editForm.append(promptInput);

    const promptHint = $('<div/>')
      .addClass('lead-xxs text-muted mt-1')
      .html('Edits here are one-shot. Manage the library under Settings &rarr; Subtitle AI-edit prompts.');
    editForm.append(promptHint);
```

- [ ] **Step 2: Load the library when the AI-Edit form opens**

Find the existing `aiToggleBtn.on('click', ...)` handler at line 637. The handler already lazy-loads models when the form first opens. Extend it to lazy-load the prompt library too.

Replace the existing handler:
```js
    aiToggleBtn.on('click', async () => {
      const isHidden = editForm.css('display') === 'none';
      editForm.css('display', isHidden ? 'block' : 'none');
      aiToggleBtn.html(isHidden ? 'AI Edit ▴' : 'AI Edit ▾');

      if (isHidden && modelSelect.children().length === 0) {
        try {
          const models = await ApiHelper.getModels();
          const providers = (models || {}).providers || {};
          Object.keys(providers).sort().forEach((provider) => {
            const group = $('<optgroup/>').attr('label', provider);
            providers[provider].forEach((m) => {
              const opt = $('<option/>').attr('value', m.id).text(m.name);
              group.append(opt);
            });
            modelSelect.append(group);
          });
        } catch (e) {
          console.error(e);
        }
      }
    });
```

With:
```js
    aiToggleBtn.on('click', async () => {
      const isHidden = editForm.css('display') === 'none';
      editForm.css('display', isHidden ? 'block' : 'none');
      aiToggleBtn.html(isHidden ? 'AI Edit ▴' : 'AI Edit ▾');

      if (isHidden && modelSelect.children().length === 0) {
        try {
          const models = await ApiHelper.getModels();
          const providers = (models || {}).providers || {};
          Object.keys(providers).sort().forEach((provider) => {
            const group = $('<optgroup/>').attr('label', provider);
            providers[provider].forEach((m) => {
              const opt = $('<option/>').attr('value', m.id).text(m.name);
              group.append(opt);
            });
            modelSelect.append(group);
          });
        } catch (e) {
          console.error(e);
        }
      }

      if (isHidden && promptSelect.children().length === 0) {
        try {
          const res = await ApiHelper.listSubtitlePrompts();
          const prompts = (res && res.prompts) || [];
          prompts.forEach((p) => {
            promptSelect.append($('<option/>').attr('value', p.name).text(p.name));
          });
          const initial = prompts.find((p) => p.name === 'default') || prompts[0];
          if (initial) {
            promptSelect.val(initial.name);
            promptInput.val(initial.prompt);
          }
        } catch (e) {
          console.error(e);
        }
      }
    });
```

- [ ] **Step 3: Wire the picker `change` to overwrite the textarea**

Add this block right after the `aiToggleBtn.on('click', ...)` handler:
```js
    promptSelect.on('change', async () => {
      const name = promptSelect.val();
      if (!name) return;
      try {
        const res = await ApiHelper.getSubtitlePrompt(name);
        promptInput.val((res && res.prompt) || '');
      } catch (e) {
        console.error(e);
      }
    });
```

- [ ] **Step 4: Verify `runBtn` still sends the textarea content**

`runBtn.on('click', ...)` at line 684 already reads `promptInput.val()` and passes it to `ApiHelper.aiEditSubtitle(uuid, { model, prompt })`. No change needed.

Run: `grep -n "promptInput.val\|aiEditSubtitle" source/webapp/src/lib/js/app/mainView/collection/base/components/analysis/transcribe/transcribeTab.js`
Expected: at least one match for each.

- [ ] **Step 5: Commit**

```bash
git add source/webapp/src/lib/js/app/mainView/collection/base/components/analysis/transcribe/transcribeTab.js
git commit -m "Transcribe: pick AI-edit prompt from shared library, allow inline override"
```

---

## Task 8: Build webapp bundle

**Files:** none modified — build artifacts only.

- [ ] **Step 1: Run the webapp copy step**

```bash
( cd source/webapp && npm install --omit=dev && npm run build )
```
Expected: `source/webapp/dist/src/lib/js/app/...` populated. No new lockfile changes (skip them if they appear).

- [ ] **Step 2: Bundle to `app.min.js` via Rollup**

```bash
( cd source/build && npm install --omit=dev )
node source/build/post-build.js rollup \
  --input "$(pwd)/source/webapp/dist/src/lib/js/app.js" \
  --output "$(pwd)/source/webapp/dist/app.min.js"
```
Expected: `app.min.js` written. Stderr may include Rollup warnings; only failure if exit code is non-zero.

- [ ] **Step 3: Compute new SRI hash for `app.min.js`**

```bash
NEW_HASH=$(openssl dgst -sha384 -binary source/webapp/dist/app.min.js | openssl base64 -A)
echo "sha384-${NEW_HASH}"
```
Expected: a `sha384-...` line.

Hold this value — needed in Task 9.

- [ ] **Step 4: (No commit — build artifacts are in `dist/`, gitignored)**

If a `git status` shows tracked files dirty, stop and investigate before continuing.

---

## Task 9: Surgical webapp deploy

**Files:** none modified locally — only S3 + CloudFront updates.

- [ ] **Step 1: Identify the live web bucket and CloudFront distribution**

```bash
aws cloudformation describe-stacks --stack-name media2cloudv4 --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='WebBucket'].OutputValue" --output text
aws cloudformation describe-stacks --stack-name media2cloudv4 --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId' || OutputKey=='WebDistribution'].OutputValue" --output text
```
Expected: bucket name (e.g. `so0050-0a4ce372964b-385085470441-us-west-2-web`) and a distribution ID (e.g. `E28RWJ8UCA0ZDH`). If outputs differ from what's in memory, use the live values.

If those `OutputKey`s aren't present, fall back:
```bash
aws s3api list-buckets --query "Buckets[?contains(Name, 'us-west-2-web')].Name" --output text
aws cloudfront list-distributions --query "DistributionList.Items[?Origins.Items[0].DomainName=='<bucket>.s3.us-west-2.amazonaws.com'].Id" --output text
```

Capture as `WEB_BUCKET=...` and `CF_DIST=...` env vars.

- [ ] **Step 2: Upload `app.min.js`**

```bash
aws s3 cp source/webapp/dist/app.min.js "s3://${WEB_BUCKET}/app.min.js" \
  --content-type application/javascript --cache-control "max-age=300" --region us-west-2
```
Expected: `upload: ... to s3://...` line.

- [ ] **Step 3: Patch `index.html` SRI integrity attribute for `app.min.js`**

```bash
aws s3 cp "s3://${WEB_BUCKET}/index.html" /tmp/index.html --region us-west-2
```

Edit `/tmp/index.html` — locate the script tag like:
```html
<script src="./app.min.js" integrity="sha384-OLDHASH" crossorigin="anonymous"></script>
```
Replace `sha384-OLDHASH` with `sha384-${NEW_HASH}` from Task 8 Step 3. **Touch ONLY the `app.min.js` integrity** — leave every other `<script>`/`<link>` untouched.

```bash
aws s3 cp /tmp/index.html "s3://${WEB_BUCKET}/index.html" \
  --content-type "text/html; charset=utf-8" --cache-control "no-cache" --region us-west-2
```

- [ ] **Step 4: CloudFront invalidate**

```bash
aws cloudfront create-invalidation --distribution-id "${CF_DIST}" \
  --paths "/app.min.js" "/index.html"
```
Expected: invalidation `Status: InProgress`.

- [ ] **Step 5: Smoke-test in browser**

Open the CloudFront URL (e.g. `https://d2gvv13en08cct.cloudfront.net`), force-reload, log in, then:

1. Open Settings — confirm "Subtitle AI-edit prompts" form appears with the `default` entry pre-loaded.
2. Click "New prompt", enter `test_prompt`, paste any prompt body, click "Save prompt". List should refresh and `test_prompt` should appear.
3. Open any video → Transcribe tab → click `AI Edit ▾`. Confirm the new dropdown shows `default` and `test_prompt`. Switching the picker should swap the textarea.
4. Pick `default`, click "Run AI Edit", confirm the existing AI-edit pipeline runs unchanged.
5. Back in Settings, delete `test_prompt`. Confirm it disappears from the Settings list and from the Transcribe picker (after closing+reopening AI Edit).

If the SRI hash mismatch fires in DevTools console (look for "Failed to find a valid digest"), repeat Step 3 — most likely the integrity wasn't updated.

- [ ] **Step 6: No commit needed** — deploy is fully out-of-band of the repo.

---

## Task 10: Deploy api Lambda code

**Files:** none modified — only redeploy.

- [ ] **Step 1: Package the api Lambda**

The api Lambda is built by `deployment/build-s3-dist.sh` or by the per-package `npm run build` if there's one in `source/api`. Run the project's existing build for `source/api`:

```bash
( cd source/api && npm install --omit=dev && npm run build )
```

If `source/api/dist/` is not produced by `npm run build`, fall back to packaging the directory directly:
```bash
( cd source/api && zip -rq /tmp/api-lambda.zip lib node_modules package.json )
```

- [ ] **Step 2: Identify the api Lambda function name**

```bash
aws lambda list-functions --region us-west-2 \
  --query "Functions[?contains(FunctionName, 'api') && contains(FunctionName, 'media2cloud')].FunctionName" --output text
```
Pick the matching name (typically a single result). Capture as `API_FN=...`.

- [ ] **Step 3: Update the function code**

If `dist/` was produced as a zip:
```bash
aws lambda update-function-code --function-name "${API_FN}" \
  --zip-file "fileb://source/api/dist/api.zip" --region us-west-2
```

If using the fallback `/tmp/api-lambda.zip`:
```bash
aws lambda update-function-code --function-name "${API_FN}" \
  --zip-file "fileb:///tmp/api-lambda.zip" --region us-west-2
```

Expected: JSON output with the new `LastModified` and `CodeSha256`.

- [ ] **Step 4: Smoke-test the new endpoints**

```bash
# Substitute a real bearer token from the live app's auth header, or hit through the UI.
# Using the UI is easier — Settings page already calls listSubtitlePrompts on load.
```

In the browser DevTools Network tab, confirm:
- `GET /subtitle-prompts` returns `{ prompts: [...] }` with at least `default`.
- `POST /subtitle-prompts/test_prompt` with `{ prompt: "..." }` returns 200.
- `DELETE /subtitle-prompts/test_prompt` returns 200.

- [ ] **Step 5: No commit needed** — deploy is out-of-band.

---

## Self-review notes

- **Spec coverage:** Tasks 1-3 cover the API surface. Task 4 covers legacy removal. Task 5 covers ApiHelper. Task 6 covers the Settings UI. Task 7 covers the Transcribe UI. Task 8-10 cover deploy. Spec section "Trade-offs" is documented in design doc; no code change needed. Spec "i18n" was reduced to inline strings — see investigation note at end of Task 6.
- **i18n caveat:** the explore pass showed `localization.js` is en-only (no zh-HK keys) and existing Settings forms use inline strings. The plan therefore uses inline strings to match the existing pattern. If zh-HK strings are needed later, they can be lifted into `localization.js` in a follow-up.
- **No `git push`** anywhere — this plan stops at local commits and direct-to-AWS deploy. The user's preferred deploy flow is direct-to-the-dev-account from the worktree.
