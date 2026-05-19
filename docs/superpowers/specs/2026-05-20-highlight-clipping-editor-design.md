# Highlight Clipping + Video Editor — Design Spec

- **Status:** Draft v1 (locked design, not yet implemented)
- **Date:** 2026-05-20
- **Stack:** Media2Cloud on AWS (Hong Kong), us-west-2
- **Scope:** v1 — single source per project, on-demand only

---

## 0. Goal

Add a **highlight clipping + video editor** feature to the existing Media2Cloud webapp so users can:

1. Auto-detect highlight segments in an already-ingested video (via Bedrock LLM/VLM).
2. Trim, reorder, and stitch those highlights (plus optional custom segments from full footage) in a browser timeline editor.
3. Render the result to MP4 + HLS via MediaConvert.
4. Optionally re-ingest the rendered output as a first-class library asset.

Inspiration: `aws-samples/gen-ai-video-short-form-generator` (React/Amplify reference). This design **does not port** that stack — it integrates natively into M2C's vanilla JS + CDK + Step Functions architecture.

---

## 1. Highlight detection (locked)

### Two pluggable strategies + auto-pick

| Strategy | Auto-pick when | Default model | Alternative models |
|---|---|---|---|
| **Transcript-LLM** | Speech density ≥ 0.6 words/sec from existing Transcribe output | Nova 2 Lite | Qwen3 235B A22B 2507, DeepSeek V3.2 |
| **Pure VLM** | Speech density < 0.6 OR no transcript | Nova 2 Lite | Nova Pro, Pegasus |

User can override the auto-pick and the model via `HighlightSettings`. Auto-pick uses the existing Transcribe output — zero extra cost to decide.

### Why VLM+MME was dropped

The article's third strategy (VLM + Nova Multimodal Embeddings) was considered and **cut** for v1. Its primary wins (cross-video retrieval, template matching from a library of past highlights) are not in scope for single-source projects. Its remaining benefit (cheap re-prompts on long videos via cached embeddings) does not justify the engineering surface (FFmpeg Lambda layer, MME cache, extra Bedrock model dependency, extra branch in the state machine).

`HighlightSettings.strategy` is forward-compatible — add `"vlm-mme"` later as a v2 hook if cross-source retrieval becomes a requirement.

### Long-video handling

For Pure VLM on videos >5 min: 30s parallel slicing via Step Functions Map state. Frame-accurate. Same accuracy benefit as the article's slicing approach, no embeddings needed.

### Trigger model

**On-demand only.** A highlight set is created when the user clicks "Generate highlights" in the editor. No auto-runs on ingest.

### Timestamp anchoring (the stolen trick)

LLM/VLM outputs reference transcript spans with `[...]` elision markers. The `anchor-and-snap` Lambda uses Python `difflib.SequenceMatcher` sliding-window word-tokenization (lifted from `gen-ai-video-short-form-generator/extract-timeframe/lambda_function.py`) to anchor those spans against word-level Transcribe items, eliminating timestamp hallucination.

### State machine: `highlight-detection`

```
prepare-input → [auto-pick branch]
                ├─ transcript-llm → anchor-and-snap → compose-edl → done
                └─ pure-vlm        → anchor-and-snap → compose-edl → done
```

---

## 2. Editor UX (locked)

### Layout

Three stacked tracks under the player:

1. **Source** (read-only) — full footage timeline.
2. **Auto-highlights** (read-only) — green = kept, blue = selected, dashed grey = dropped, orange = user-added custom.
3. **Edit** — drag to reorder, trim handles via the right-hand In/Out panel.

### Key decisions

- **Single video track**, trim + stitch + reorder.
- **Drop, don't delete** — dropped auto-highlights remain visible (greyed) so undo is one click.
- **Custom segments** can be added from the playhead without an LLM round-trip.
- **Trim** uses In/Out timecode buttons in the inspector panel (no pixel-precise dragging required).
- **"Regenerate highlights"** re-runs the detection pipeline with current settings; the user's edit track is preserved.
- **Render & Publish** kicks off the §3 state machine.

### Library stack

| Layer | Library | Size | License |
|---|---|---|---|
| Video player | **Video.js** (already in M2C) | reused | Apache-2.0 |
| Drag-to-reorder | **SortableJS** | 25 KB | MIT |
| Trim handles | **interact.js** | 80 KB | MIT |
| Timeline ribbon | Built from scratch (CSS divs) | ~5 KB | — |
| Waveform (optional, deferred) | Wavesurfer.js | 90 KB | BSD-3 |

No framework. Vanilla JS only — fits M2C's Rollup-at-deploy + SRI flow. Two new third-party bundles in `source/webapp/third_party/` (`sortablejs-bundle/`, `interactjs-bundle/`) following the same pattern as the existing `aws-sdk-js-v3-bundle/`.

### Deferred (toggles, not in v1)

- 9:16 / 3:4 aspect ratio (would need MediaConvert SMART_CROP + `elemental-inference:*` IAM)
- Burned-in captions (per-segment VTT from existing Transcribe)
- Multi-track audio replace / B-roll overlay (v2)

---

## 3. Render & Publish pipeline (locked)

### State machine: `render-publish`

```
compose-edl  →  start-mediaconvert  →  wait-for-mediaconvert  →  branch
                                                                  ├─ derivative-only        → notify-iot → done
                                                                  └─ publish-to-library     → trigger-ingest → notify-iot → done
```

One Step Function. The publish branch is a `Choice` state on `EditProject.publishToLibrary`.

### MediaConvert job shape

One job, two output groups:

```
Inputs: [
  { FileInput: s3://.../proxy.mp4, InputClippings: [{ StartTimecode, EndTimecode }] },
  ...                                          // one per segment, in user's edit order
]
OutputGroups: [
  { Type: FILE_GROUP_SETTINGS, Outputs: [ MP4 H.264 + AAC ] },
  { Type: HLS_GROUP_SETTINGS,  Outputs: [ 1080p, 720p, 480p ] }
]
```

- Frame-accurate clipping is built-in to MediaConvert.
- Concat is implicit across multiple `Inputs[]`.
- No FFmpeg.

### "Goes through ingest?" — clarification

| Step | Goes through M2C ingest pipeline? |
|---|---|
| Detecting highlights | ❌ No. Reads existing proxy + transcript. Saves timecodes only. |
| Rendering edited MP4/HLS | ❌ No. MediaConvert job direct from `render-publish` SF. |
| Saving edited MP4 as a searchable library asset | ✅ Yes — only if user opts in via "Publish to library". Triggered by copying the MP4 into the existing ingest watch-folder; existing `s3event` Lambda fires `main/ingest/main` unchanged. |

### IoT status

Topic: `edit/{editProjectId}/render`
Payload: `{ status, percent, mediaConvertJobId }`
Reuses `core-lib/iotStatus.js` and the webapp's existing IoT WebSocket plumbing.

### Lambdas

| Lambda | Purpose | Reuses |
|---|---|---|
| **`compose-edl`** *(new)* | Read `EditProjects.segments[]` → emit MediaConvert input-clipping JSON | `core-lib/edlComposer.js` |
| **`render-status`** *(new)* | Poll MediaConvert, update `Renders` DDB row, push IoT status | `core-lib/iotStatus.js`, `backlog/status-updater` patterns |
| `start-mediaconvert` | Reused as-is from `main/ingest/video/states/start-transcode/index.js` | existing |

---

## 4. Data model (locked)

### DynamoDB tables (4 new)

#### `HighlightSets`
```
PK: uuid                 SK: highlightSetId (ULID)
attrs: strategy, modelId, prompt, segments[], status, createdAt, createdBy, cost
```

#### `EditProjects`
```
PK: editProjectId (ULID)             GSI: uuid
attrs: uuid, name, segments[], publishToLibrary, aspectRatio, burnCaptions, updatedAt, owner
segments[].kind: "highlight" | "custom"
```

#### `Renders`
```
PK: renderId (ULID)                  GSI: editProjectId
attrs: editProjectId, uuid, mediaConvertJobId, status, outputs{mp4,hls}, publishedAsUuid, startedAt, finishedAt, errorMessage
```

#### `HighlightSettings`
```
PK: ownerOrTenantId
attrs: defaultStrategy, defaultTranscriptModel, defaultVlmModel, customPrompt, autoPickSpeechThreshold (default 0.6)
```

### S3 prefixes (no new buckets)

```
s3://{ProxyBucket}/
  videos/{uuid}/...                              ← existing M2C ingest output (untouched)
  edits/{editProjectId}/                         ← NEW
    manifest.json
    output.mp4
    hls/master.m3u8 + variants
  highlights/{uuid}/{highlightSetId}.json        ← NEW (audit mirror of DDB segments[])
```

Existing M2C lifecycle, encryption, and KMS rules apply automatically.

### Explicitly NOT added

- No new bucket.
- No GSI on `HighlightSets` — `Query` on PK is enough.
- No `tenantId` separation — relies on existing M2C cognito group/owner pattern.
- No `Versions` field on `EditProjects` — last-write-wins, like the rest of M2C.

---

## 5. API endpoints (locked)

All under existing M2C API Gateway + Cognito authorizer. New handler module per resource group, mounted alongside `genai/`, `analysis/`, etc.

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | `POST` | `/api/v1/highlights/{uuid}` | Kick off `highlight-detection` SF |
| 2 | `GET`  | `/api/v1/highlights/{uuid}` | List highlight sets |
| 3 | `GET`  | `/api/v1/highlights/{uuid}/{highlightSetId}` | Full segments + metadata |
| 4 | `PUT`  | `/api/v1/edits/{editProjectId}` | Create/update edit project |
| 5 | `GET`  | `/api/v1/edits/{editProjectId}` | Load editor state |
| 6 | `POST` | `/api/v1/edits/{editProjectId}/render` | Kick off `render-publish` SF |
| 7 | `GET\|PUT` | `/api/v1/highlight-settings` | Read/write user defaults |

### Endpoint #1 payload

```json
{
  "strategy":    "auto",         // or "transcript-llm" | "pure-vlm"
  "modelId":     null,           // null = use HighlightSettings default
  "prompt":      null,           // null = use built-in default prompt
  "maxSegments": 10
}
```

All four fields optional. Empty body = "use my saved defaults".

### Endpoint #6 payload

```json
{ "publishToLibrary": false }   // optional, defaults to EditProjects.publishToLibrary
```

`segments[]` already on `EditProjects` — no need to resend.

### No render-status polling endpoint

Webapp subscribes to the `edit/{editProjectId}/render` IoT topic. On `COMPLETED`, it calls endpoint #5 to fetch final URLs.

### Auth

Same Cognito authorizer + `assertOwner(uuid, cognitoSub)` helper used by the existing `/api/v1/assets/...` endpoints. No new authorizer.

### Explicitly NOT added

- No `DELETE` endpoints (lifecycle rules + DDB TTL handle cleanup).
- No webhook / EventBridge fan-out.
- No `/highlights` cross-video search (single-source v1).
- No batch endpoint.

---

## 6. Deployment / IAM / Bedrock (locked)

### CloudFormation nested stack

The project deploys via plain **CloudFormation YAML** at `deployment/*.yaml` (no CDK, no SAM). Build pipeline: `deployment/build-s3-dist.sh` copies `*.yaml` to `regional-s3-assets/`, packages Lambda code, and substitutes `%%PLACEHOLDERS%%`.

One new nested stack — same pattern as `media2cloud-shoppable-stack.yaml`:

```
deployment/
  media2cloud.yaml                       ← root: add Highlight to Mappings/Solution/Stack and mount HighlightStack
  media2cloud-highlight-stack.yaml       ← NEW nested stack: 4 DDB tables, Lambdas, SFs
```

No new buckets, no new VPC, no new KMS keys, no new Cognito groups, no new CloudFront distribution.

> Lambda source lives under `source/main/highlight/` (matching the `source/main/{ingest,analysis,...}` convention). The build script bundles it into a versioned zip and the nested stack references it by `%%PKG_HIGHLIGHT%%` placeholder.

### IAM additions (scoped, no `*` resources)

| Role | New permissions |
|---|---|
| `detect-highlights` | `bedrock:InvokeModel` on the 5 model ARNs in us-west-2 only · `s3:GetObject` on `videos/*` · `dynamodb:PutItem` on `HighlightSets` |
| `compose-edl`       | `dynamodb:GetItem` on `EditProjects`, `HighlightSets` |
| `render-status`     | `mediaconvert:GetJob` · `dynamodb:UpdateItem` on `Renders` · `iot:Publish` on `edit/*/render` · `s3:CopyObject` (when `publishToLibrary=true`, target = ingest watch-folder prefix) |
| MediaConvert service role | **No change for v1.** SMART_CROP / ImageInserter additions deferred with the §2 toggles. |

### Bedrock model access (us-west-2) — operator checklist

| Model | Bedrock model ID (pinned at build time) |
|---|---|
| Amazon Nova 2 Lite | `amazon.nova-2-lite-v1:0` |
| Amazon Nova Pro | `amazon.nova-pro-v1:0` |
| Twelve Labs Pegasus | `twelvelabs.pegasus-1-2-v1:0` |
| Qwen3 235B A22B 2507 | `qwen.qwen3-235b-a22b-2507-v1:0` |
| DeepSeek V3.2 | `deepseek.v3-2-v1:0` |

Exact IDs validated against `ListFoundationModels` at build time and stored in `cdk.context.json`. Operator enables access once in the us-west-2 Bedrock console before first run. If a model isn't enabled, `detect-highlights` returns a clear `BedrockAccessDenied` error with a deep link to the model-access page.

### Webapp deploy

Frontend additions follow the **existing surgical update path** (Rollup-at-deploy + SRI, ~3 min, skips CFN):

- New JS modules under `source/webapp/src/lib/js/app/mainView/collection/base/components/highlights/` and `.../editor/`.
- Two new third-party bundles in `source/webapp/third_party/`: `sortablejs-bundle/`, `interactjs-bundle/`.

### Deploy bucket

`media2cloud-artefact-385085470441` (us-west-2) — existing.

### Cost ceiling (rough, per-video)

| Item | Cost |
|---|---|
| Highlight detection (Nova 2 Lite, transcript-LLM, 30 min video) | ~$0.005 |
| Highlight detection (Pure VLM, Nova 2 Lite, 30 min video, 30s slices) | ~$0.08 |
| MediaConvert render (2 min output, MP4 + 3-rung HLS) | ~$0.04 |
| **Total per render with auto-pick** | **<$0.10** |

On-demand only — zero idle cost.

---

## 7. Reuse map (existing M2C pieces leveraged)

| Component | Reused for | Path |
|---|---|---|
| `core-lib/edlComposer.js` | `compose-edl` Lambda | `source/layers/core-lib/lib/edlComposer.js` |
| `core-lib/iotStatus.js` | render status push | `source/layers/core-lib/lib/iotStatus.js` |
| `genai/baseModel.js` | Bedrock client adapter pattern | `source/api/lib/operations/genai/baseModel.js` |
| `start-transcode/index.js` | MediaConvert job submission | `source/main/ingest/video/states/start-transcode/index.js` |
| `s3event` Lambda | Auto-trigger on Publish-to-library copy | `source/main/automation/s3event/` |
| `main/ingest/main` SF | Re-ingest path for published edits | existing |
| `backlog/status-updater` | Polling pattern for MediaConvert job state | `source/backlog/status-updater/` |
| Cognito authorizer | All 7 new endpoints | existing API Gateway config |

---

## 8. Open items / future work

| Item | Why deferred |
|---|---|
| 9:16 / 3:4 aspect ratio + SMART_CROP | v1 toggles cut for scope. Memory note: requires `elemental-inference:*` IAM. |
| Burned-in captions | v1 toggle cut for scope. |
| VLM + MME (third strategy) | Earns its keep only with cross-source retrieval, which is v2. |
| Multi-track audio replace / B-roll | v2. |
| Per-segment thumbnails for editor scrubbing | Could come from existing frame-capture; not blocking. |
| Cross-video highlight search | Out of v1 scope (single-source-per-project locked). |

---

## 9. Implementation sequencing (suggested)

1. **DDB tables + IAM** (CDK only, no Lambda code) — verify via console.
2. **`detect-highlights` + `anchor-and-snap` Lambdas** + `highlight-detection` SF — testable end-to-end with curl.
3. **API endpoints 1, 2, 3, 7** — highlight detection wired up to the API.
4. **Webapp highlight panel** (no editor yet) — list + regenerate works.
5. **`EditProjects` CRUD** (endpoints 4, 5).
6. **Editor timeline UI** (SortableJS + interact.js + Video.js).
7. **`compose-edl` + `render-status` Lambdas** + `render-publish` SF.
8. **MediaConvert job template** (test in console first, then bake into CDK).
9. **Endpoint 6 + IoT status push** — Render & Publish end-to-end.
10. **Publish-to-library branch** (last, since it depends on the rest).

Each step is independently deployable via the existing surgical update path.
