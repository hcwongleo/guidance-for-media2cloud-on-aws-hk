# detect-highlights

Detects highlight segments in an already-ingested video using Amazon Bedrock.

## Strategy

- **transcript-llm** (v1) — sends the full Transcribe transcript to a text LLM
  (default: `amazon.nova-2-lite-v1:0`), asks for up to N highlight quotes, then
  anchors each quoted span back to word-level Transcribe items via an
  LCS-based sliding-window similarity match (port of the Python
  `difflib.SequenceMatcher` approach used in
  `aws-samples/gen-ai-video-short-form-generator`). Threshold: 0.70.

- **multimodal** — samples frames (from frame-segmentation output) and sends
  them as image content blocks to a vision-capable Bedrock model, alongside
  the spoken transcript when one is available. Anchors highlights by frame
  index → timestamp.

- **auto** — picks `transcript-llm` when speech density ≥ 0.6 words/sec,
  else `multimodal`.

## Event shape

```json
{
  "uuid":          "<m2c asset uuid>",
  "transcriptKey": "videos/<uuid>/raw/.../transcribe.json",
  "strategy":      "auto" | "transcript-llm" | "multimodal",
  "modelId":       null | "amazon.nova-2-lite-v1:0" | "qwen.qwen3-235b-a22b-2507-v1:0" | "deepseek.v3-2-v1:0",
  "prompt":        null | "<custom prompt prefix>",
  "maxSegments":   10,
  "durationSec":   753,
  "owner":         "<cognito sub>"
}
```

`transcriptKey` is the S3 key (under `ENV_PROXY_BUCKET`) of an AWS Transcribe
JSON output file. The `start_time` / `end_time` fields on `results.items[]`
are the source of truth for segment boundaries.

## Output

A `HighlightSets` DDB row keyed by `(uuid, highlightSetId)` and the same row
returned to the state machine.

## Required env

- `ENV_BEDROCK_REGION` — Bedrock region (us-west-2 in this stack).
- `ENV_PROXY_BUCKET` — bucket holding the transcript file.
- `ENV_HIGHLIGHT_SETS_TABLE` — DDB table from `media2cloud-highlight-stack`.
