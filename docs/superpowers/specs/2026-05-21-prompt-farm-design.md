# Prompt Farm — shared library for Transcribe AI-edit prompts

**Status:** Design approved 2026-05-21
**Scope:** Backend API + Settings UI + Transcribe UI
**Branch:** `short-form-video`

## Problem

Today the AI-edit prompt for the Transcribe tab is a free-form textarea with per-asset persistence at `{uuid}/transcode/subtitle/prompt.json`. Users can't reuse prompts across assets, can't share with teammates, and have no library of known-good prompts (e.g., the Cantonese → written-Chinese SRT prompt that ships as the hardcoded default).

## Goal

A globally-shared, admin-managed library of named prompts. Settings page CRUDs the library; Transcribe tab picks from it; per-asset persistence is dropped.

## Non-goals

- Per-owner / per-team scoping. Global only.
- Prompt versioning, audit log, "set as default" flag.
- Migrating existing per-asset prompt files. (Fresh UAT deploy; orphans are harmless.)
- Saving Transcribe-tab edits back to the library.

## Architecture

Three thin pieces, each mirroring an existing pattern:

1. **Backend** — new `subtitlePromptsOp.js` next to `mcTemplatesOp.js`. Behind new route `/subtitle-prompts`. Storage: one JSON per prompt under `_settings/subtitle-prompts/<name>.json` in the ProxyBucket. CRUD only.

2. **Settings UI** — new `createSubtitlePromptsForm()` in `settingsTab.js`, placed directly below `createMcTemplatesForm()`. Same list-on-left, edit-on-right shape.

3. **Transcribe tab** — replace the free-form prompt textarea with: dropdown (populated from `GET /subtitle-prompts`) + editable textarea pre-filled from the picked entry. Textarea remains editable as a one-shot override; edits do not save back. Legacy per-asset `prompt` endpoints removed.

## API

New API ops constant in `source/layers/core-lib/lib/apiOps.js`:
```js
SubtitlePrompts: 'subtitle-prompts'
```

Endpoints (auth-gated like the rest of the API):

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/subtitle-prompts` | List `[{ name, prompt, lastModified }]`. If `default.json` is absent, seed it before listing. |
| `GET` | `/subtitle-prompts/{name}` | Return `{ name, prompt, lastModified }`. 404 if missing. |
| `POST` | `/subtitle-prompts/{name}` | Body `{ prompt }`. Upsert — overwrites if exists. Validates `name`. |
| `DELETE` | `/subtitle-prompts/{name}` | 204 on success. `default` is deletable; re-seeded on next list. |

Name validation (server-side): `^[a-zA-Z0-9_-]{1,64}$`. Rejects `..`, `/`, and leading `_` to keep S3 keys safe and avoid collision with the `_settings/` admin prefix.

Body of `POST /subtitle/{uuid}/ai-edit` is unchanged (`{ prompt, model }`). The library is purely a source the UI pulls from.

**Removed routes** (legacy per-asset prompt):
- `GET /subtitle/{uuid}/prompt`
- `POST /subtitle/{uuid}/prompt`

The S3 file `{uuid}/transcode/subtitle/prompt.json` is no longer read or written.

## ApiHelper additions / replacements

In `source/webapp/src/lib/js/app/shared/apiHelper.js`:

```js
listSubtitlePrompts()                  // GET  /subtitle-prompts
getSubtitlePrompt(name)                // GET  /subtitle-prompts/{name}   — replaces existing per-uuid version
saveSubtitlePrompt(name, prompt)       // POST /subtitle-prompts/{name}   — replaces existing per-uuid version
deleteSubtitlePrompt(name)             // DELETE /subtitle-prompts/{name}
```

The existing `getSubtitlePrompt(uuid)` / `saveSubtitlePrompt(uuid, prompt)` are replaced — same names, new signatures. Transcribe tab is the only caller.

`ENDPOINTS.SubtitlePrompts` is added to `apiHelper.js` using the new `ApiOps.SubtitlePrompts` constant.

## Storage

S3 layout (ProxyBucket — same bucket used for `mcTemplates`):

```
_settings/subtitle-prompts/
  default.json
  <name>.json
  ...
```

File contents (minimal, one prompt per file):

```json
{
  "name": "default",
  "prompt": "<the prompt text>"
}
```

`lastModified` returned by the API is read from the S3 object's `LastModified`, not stored in the file — same approach as `mcTemplatesOp`.

## Seeding

`DEFAULT_PROMPT` is inlined inside `subtitlePromptsOp.js` (no shared module). `subtitleOp.js` no longer references it after the per-asset endpoints are removed.

`_listPrompts()` flow:
1. `s3.listObjectsV2({ Prefix: '_settings/subtitle-prompts/' })`.
2. If `default.json` is absent, `putObject` `default.json` with `{ name: 'default', prompt: DEFAULT_PROMPT }`.
3. Re-list and return.

Deletion of `default` is allowed; the next list re-seeds it. This is the "reset to factory" path; no separate reset button.

## UI — Settings page

New `createSubtitlePromptsForm()` in `settingsTab.js`, placed directly below `createMcTemplatesForm()`. Structurally identical:

- **Left column**: list of prompt names from `ApiHelper.listSubtitlePrompts()`. Click a row → loads its content into the right column.
- **Right column**:
  - Name input — disabled when editing existing (name is the S3 key, immutable).
  - Prompt textarea (multi-line, ~12 rows).
  - **Save** → `saveSubtitlePrompt(name, prompt)` then refresh list.
  - **Delete** → confirm modal → `deleteSubtitlePrompt(name)` then refresh list. Disabled when no row selected.
  - **New** → clears name + textarea, enables name input, switches Save into create mode.

No rename. To rename: New → save under new name → delete old. (Same UX as `mcTemplates`.)

## UI — Transcribe tab

Replace the prompt block in `transcribeTab.js` (around line 231):

```
[ AI-edit prompt ▾ ]
┌──────────────────────────────────────────┐
│ <textarea, pre-filled from picked entry> │
│                                          │
└──────────────────────────────────────────┘
                                  [ AI-edit ]
```

Behavior:
- On tab show: call `listSubtitlePrompts()`, populate dropdown, auto-select `default` (or first entry if absent).
- Selecting an entry replaces the textarea content with that entry's `prompt`. **No dirty-state confirm** — picker switch always replaces. (Cut for simplicity.)
- Textarea stays editable. Edits are local; navigating away or re-picking discards them.
- "AI-edit" sends whatever text is currently in the textarea — `POST /subtitle/{uuid}/ai-edit` body shape `{ prompt, model }` is unchanged.
- A small "Edit prompts in Settings →" link sits beneath the dropdown for convenience; reuses existing tab-switch helper in `mainView`.

## i18n

Add zh-HK + en strings in `source/webapp/src/lib/js/app/shared/localization.js` for:
- "AI-edit prompt"
- "Save prompt"
- "Delete prompt"
- "New prompt"
- "Edit prompts in Settings"
- "Prompt name"
- "Prompt name must be alphanumeric (max 64 chars)"

## Trade-offs

- **Dropping per-asset prompt persistence** — a user who tweaks the prompt and reloads the page loses the tweak. Acceptable given the simpler model and the user's "fresh UAT, no legacy" stance. If this becomes painful, a session-scoped in-memory cache (no API change) is the cheap fix.
- **No dirty-state warning on picker switch** — keeps state simple. If we ever hear complaints, add it later.

## Out of scope (explicitly cut)

- Shared `defaultSubtitlePrompt.js` module — over-refactor. The constant lives only in `subtitlePromptsOp.js`.
- "Set as default" affordance — `default` is just the seeded entry name.
- Versioning / audit log.
- DDB-backed storage.
- Per-owner / per-team libraries.

## Implementation order

1. Backend op + route + ApiOps constant.
2. ApiHelper additions; replace per-uuid prompt methods.
3. Settings UI form.
4. Transcribe UI swap.
5. Remove legacy `GET/POST /subtitle/{uuid}/prompt` routes.
6. i18n strings.
7. Webapp deploy via the surgical path (rollup + SRI patch + S3 cp + CloudFront invalidate).
