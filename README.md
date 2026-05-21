# Guidance for Media2Cloud on AWS

## Table of Contents

- [Compatibility Notes](#compatibility-notes)
- [What's New in V4](#whats-new-in-v4)
- [Hong Kong Fork — Features and Customizations](#hong-kong-fork--features-and-customizations)
- [Introduction](#introduction)
- [Installation](#installation)
- [Building and Customizing the Solution](#building-and-customizing-the-solution)
- [Updating an Existing Stack](#updating-an-existing-stack)
- [Cost Estimation](#cost-estimation)
- [Deep dive into Media2Cloud V4](#deep-dive-into-media2cloud-v4)
- [V4 Demo Video Gallery](#v4-demo-video-gallery)
- [LICENSE](#license)
- [Collection of Operational Metrics](#collection-of-operational-metrics)

__

## Compatibility Notes

If you are running Media2Cloud Version 3, **do not** update your existing stack. Version 4 is **not** compatible with Version 3 in a few areas:

- The format of the generated metadata JSON files is different.
- The indices of the Amazon OpenSearch cluster have been optimized and condensed into a single index, `content`, instead of multiple indices such as `celeb` and `label`.

We are working on a migration path to ensure you can move your Version 3 data files into the Version 4 environment.

If you are looking for Version 3, please switch to [v3/maintenance](https://github.com/aws-solutions-library-samples/guidance-for-media2cloud-on-aws/tree/v3/maintenance) branch.

__

## What's new in V4?

- **Dynamic frame analysis**: V3 introduced frame-based analysis that allows you to specify frames per second to run the AWS AI/ML services. In V4, the Dynamic frame analysis uses two algorithms (Perceptual Hash and Laplacian Variant) to intelligently select frames to analyze.

- **Auto Face Indexer**: This feature automatically indexes `unrecognized faces` during the analysis workflow. After faces are identified, we use the `late binding` technique that allows you to tag the unrecognized faces after the video files have been analyzed. The tagged names are then automatically propagated to all the video files without the need to re-run the analysis workflow.

- **Scene detection**: Using a combination of AWS Generative AI and AI/ML services, including Amazon Bedrock Text & Vision (Anthropic Claude Haiku 4.5 / Sonnet) model, Amazon Rekognition Segment API, Amazon Transcribe API, and an open-source machine learning model (to generate image embeddings of the frames) and an ephemeral vector store, V4 provides contextual scene change events along with detailed information such as scene description, IAB Content Taxonomies, GARM Taxonomies, scene sentiments, and brands and logos at the scene level.

- **Ad break detection**: Leveraging the scene change events derived from the Scene detection, V4 automatically derives and suggests relevant timestamps that are suitable for ad insertions.

- **Image contextual description**: V4 uses the Amazon Bedrock model to analyze the uploaded image and provides image description, one-line ALT-TEXT, image file name suggestion, and the top five relevant tags for publishers to enhance SEO.

- **Generative AI plugins**: V4 web user inference enables you to try out Amazon Bedrock models.

See quick demo in [V4 Demo Video Gallery](#v4-demo-video-gallery)

__

## Hong Kong Fork — Features and Customizations

This fork of `guidance-for-media2cloud-on-aws` adds five sub-projects on top of the upstream V4 baseline plus Hong Kong–specific localization and build-system tweaks. Each sub-project is independently shippable and gated behind the same Cognito login as the rest of the app.

### Sub-Project A — Tab-stacking bug fix (analysis tabs)
Switching between analysis tabs (Transcribe, Scenes, Ad Break, etc.) while a previous tab was still loading caused tabs to "stack" on top of each other. Replaced with a one-line sibling-active gate that drops late-arriving content if the user has already moved on.
- Spec: `docs/superpowers/specs/2026-05-18-tab-stacking-bug-fix-design.md`

### Sub-Project B — Dynamic Bedrock model registry + editable prompts
Hard-coded Claude/Nova model IDs and system prompts are replaced with a runtime registry (`source/layers/core-lib/lib/genai/bedrockModel.js` + `source/api/lib/operations/modelsOp.js`).
- New `GET /models` endpoint lists available Bedrock models per region.
- Per-feature system prompts (transcribe summary, scene description, ad-break taxonomy, highlight reasons, subtitle AI-edit) are editable from the Settings UI and persisted in DynamoDB.
- `maxTokens` is clamped per model so Nova Lite no longer fails at the output ceiling.

### Sub-Project C — Subtitle/transcribe AI editing + SRT export
A side-by-side "AI editor" on the Transcribe tab that lets a producer rewrite, translate, or tighten captions with Bedrock and export the edited transcript as an SRT.
- New tab UI: `source/webapp/src/lib/js/app/.../analysis/transcribe/transcribeTab.js`
- New API: `source/api/lib/operations/subtitleOp.js` (async background AI-edit job, polled by the webapp)
- New helper: `source/layers/core-lib/lib/srtHelper.js`
- Features: bilingual side-by-side editing, async LLM rewrite, SRT download.

### Sub-Project D — Publish-to-VOD pipeline (landscape + portrait)
Lets the user pick a finished asset, choose 16:9 or 9:16, and submit a MediaConvert job that emits HLS + MP4 proxies into the Proxy bucket. The Publish tab shows job progress, finished outputs, signed download links, and a **Delete files** button that wipes the S3 prefix.
- API: `source/api/lib/operations/publishOp.js` + JSON job templates in `source/api/lib/operations/publish/tmpl/`
- UI: `source/webapp/src/lib/js/app/.../analysis/publish/publishTab.js`
- Two presets: `vod_landscape.json` (16:9) and `vod_portrait.json` (9:16, uses MediaConvert SMART_CROP).

### Sub-Project E — Highlight clipping + video editor (short-form video)
Auto-detects highlight moments in a long-form video and lets the user assemble a short-form cut with a timeline editor.

**Backend (`source/main/highlight/`)**
- `detect-highlights/` — transcript-LLM strategy: feeds the transcript through a Bedrock model and returns ranked segments with reasons. Memory: 512 MB, timeout: 15 min.
- `compose-edl/` — converts the user-edited segment list into a MediaConvert clip-and-stitch job spec (HLS 1080p/720p/480p + MP4 proxy), 25 fps, CBR.
- `start-render/` — submits the MediaConvert job.
- `render-status/` — polls progress, persists `percent` + signed output URLs on the Renders row.
- `publish-to-library/` — optionally re-ingests the rendered MP4 as a new asset so it shows up in the main library.
- A dedicated state machine `HighlightDetection` runs detect-highlights once per click; `RenderPublish` orchestrates the four render-stage Lambdas.

**API (`source/api/lib/operations/`)**
- `highlightOp.js` — `POST/GET/DELETE /highlight/{uuid}` and `/highlight/{uuid}/{highlightSetId}`. The `GET` list endpoint server-side merges saved edits from `EditProjects` so the UI shows the user's current segments, not the original auto-detected ones.
- `highlightSettingsOp.js` — editable per-asset detection config (model, prompt, max segments).
- `editsOp.js` — CRUD on `EditProjects` (segments, publish-to-library flag, aspect ratio, burn-captions flag).
- `rendersOp.js` — submit / list / get / delete renders. `DELETE` paginates the S3 prefix and removes every output object before deleting the DDB row.

**Storage (4 new DynamoDB tables, in `media2cloud-highlight-stack.yaml`)**
- `HighlightSets` — auto-detected segment proposals (immutable per detection run)
- `EditProjects` — user edits to segments (with `gsi-uuid`)
- `Renders` — MediaConvert job tracking (with `gsi-editprojectid`)
- `HighlightSettings` — per-asset detection config

**Frontend (`source/webapp/src/lib/js/app/.../analysis/highlight/`)**
- `highlightTab.js` — list/edit/delete highlight sets, render history.
- `highlightEditorModal.js` + `editorTracks.js` — drag-to-trim segment timeline with frame-accurate scrubbing.

### Hong Kong–specific localization

**Chinese, Hong Kong (zh-HK)** added end-to-end:
- **Language code** registered in the dropdown (`source/webapp/src/lib/js/app/shared/languageCodes.js`, after `zh-TW`):
  ```javascript
  {
    name: 'Chinese, Hong Kong',
    value: 'zh-HK',
  },
  ```
- **Transcribe** forced to `zh-HK` for Cantonese audio.
- **Bedrock system prompts** for summarize / custom / image / scene-taxonomy / highlight-reasons rewritten to emit zh-HK output.

### Build-system tweaks (Hong Kong fork)

- **Pre-built Lambda layer packages** — `deployment/build-s3-dist.sh` now downloads the official AWS-built ExifTool (`image-process-lib-v4.0.9.zip`) and PDF (`pdf-lib-v4.0.9.zip`) layers from `s3://awsi-megs-guidances-us-east-1/media2cloud/v4.0.9/` instead of running the local Docker build for each. This drops ~10–15 min off every build, fixes the `canvas.node` native-module errors that occasionally hit document processing, and falls back to Docker only if the download fails. Modified functions: `build_image_process_layer`, `build_pdf_layer`.
- **Webapp deploy via Rollup-at-deploy + SRI** — surgical updates skip the full CloudFormation cycle and deploy a webapp change in ~3 minutes (`deployment/build-s3-dist.sh` enhancements). Useful for iterating on the highlight editor and publish tab without re-running CFN.

__

## Introduction

The AWS Media2Cloud solution is designed to demonstrate a serverless ingest and analysis framework that can quickly set up a baseline ingest and analysis workflow for placing video, image, audio, and document assets and associated metadata under the management control of an AWS customer. The solution will set up the core building blocks that are common in an ingest and analysis strategy:

- Establish a storage policy that manages master materials as well as proxies generated by the ingest process.
- Provide a unique identifier (UUID) for each master video asset.
- Calculate and provide an MD5 checksum.
- Perform a technical metadata extract against the master asset.
- Build standardized proxies for use in a media asset management solution.
- Run the proxies through audio, video, and image analysis.
- Provide a serverless dashboard that allows a developer to set up and monitor the ingest and analysis process.


### Architecture overview

![Architecture](./deployment/tutorials/images/architecture.png)

The architecture diagram depicts a media processing and analysis pipeline on Guidance for Media2Cloud on AWS. It leverages various AWS services to ingest, process, analyze, and store different types of media files such as video, audio, images, and documents.

The architecture can be divided into the following key components:

1. **Ingestion Services**: This includes services like AWS Elemental MediaConvert, Mediainfo, PDF.JS, and ExifTool for ingesting different types of media files into the pipeline.

2. **AWS Step Functions Workflows**: The core of the architecture is built around AWS Step Functions workflows, which orchestrate the media processing and analysis tasks. There are separate workflows for ingesting media files, processing them using AWS AI/ML services, and performing analysis tasks.

3. **AWS Lambda Functions**: These serverless functions are used for various tasks such as media ingest, video analysis, audio analysis, image analysis, and document analysis.

4. **AWS AI/ML Services**: The architecture integrates with several AWS AI/ML services like Amazon Bedrock, Amazon Rekognition, Amazon Transcribe, and Amazon Comprehend for performing intelligent media analysis tasks.

5. **Data Storage Services**: The processed media files and analysis results are stored in Amazon S3 buckets. Other storage services like Amazon DynamoDB, Amazon OpenSearch Service, and Amazon Neptune are used for storing metadata and enabling search capabilities.

6. **Integration Services**: The architecture supports integration with external systems through Amazon API Gateway, Amazon Cognito (for user authentication), Amazon CloudWatch (for monitoring), and Amazon EventBridge (for event-driven architectures).

Here is a list of AWS services used in Media2Cloud.

- Orchestration layer
  - AWS Step Functions
  - AWS Lambda
- Generative AI and AI/ML layer
  - Amazon Bedrock
  - Amazon Rekognition
  - Amazon Transcribe
  - Amazon Comprehend
  - Amazon Textract
- Storage and datastore layer
  - Amazon Simple Storage Service (S3)
  - Amazon DynamoDB
  - Amazon OpenSearch Service
  - Amazon Neptune
- Frontend authentication and authorization layer
  - Amazon Cognito
  - Amazon API Gateway
  - Amazon CloudFront
- Notification services
  - AWS IoT Core
  - Amazon Simple Notification layer
- Event layer
  - Amazon EventBridge
  - Amazon CloudWatch
- Media layer
  - AWS Elemental MediaConvert

__

## Installation

### Prerequisite

Select `YES` in `Allow access to Amazon Bedrock service in other regions` input field enables [Amazon Bedrock Global cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/global-cross-region-inference.html) when Media2Cloud uses Anthropic Claude family models. Select `NO` implies disabling the use of Amazon Bedrock models.


### Create Media2Cloud V4 stack with AWS CloudFormation

#### _Using AWS Console_
Log on to AWS CloudFormation console to create a new stack and follow the steps in the following video.

![AWS CloudFormation](./deployment/tutorials/images/aws-cloudformation-create-stack.gif)

#### _Using AWS CLI_

```sh

aws cloudformation create-stack \
  --stack-name media2cloudv4 \
  --template-url https://{S3URL}/media2cloud.template \
  --parameters \
    "ParameterKey=VersionCompatibilityStatement,ParameterValue=\"Yes, I understand and proceed\"" \
    "ParameterKey=Email,ParameterValue=\"YOUR@EMAIL.COM\"" \
    "ParameterKey=DefaultAIOptions,ParameterValue=\"Recommended V4 features (v4.default)\"" \
    "ParameterKey=PriceClass,ParameterValue=\"Use Only U.S., Canada and Europe (PriceClass_100)\"" \
    "ParameterKey=StartOnObjectCreation,ParameterValue=\"NO\"" \
    "ParameterKey=UserDefinedIngestBucket,ParameterValue=\"\"" \
    "ParameterKey=OpenSearchCluster,ParameterValue=\"Development and Testing (t3.medium=0,m5.large=1,gp2=10,az=1)\"" \
    "ParameterKey=EnableKnowledgeGraph,ParameterValue=\"NO\"" \
    "ParameterKey=CidrBlock,ParameterValue=\"172.31.0.0/16\"" \
    "ParameterKey=BedrockSecondaryRegionAccess,ParameterValue=\"YES\"" \
    "ParameterKey=BedrockModel,ParameterValue=\"Anthropic Claude Haiku 4.5\"" \
  --tags \
    "Key=SolutionName,Value=Media2Cloud" \
    "Key=SolutionID,Value=SO0050" \
  --capabilities \
    "CAPABILITY_IAM" \
    "CAPABILITY_NAMED_IAM" \
    "CAPABILITY_AUTO_EXPAND"

```

#### _One-click Pre-built template_

|Region|1-click Quick Deploy|Template URL|
|:--|:--|:--|
|US East (N. Virginia)|<a href="https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/quickcreate?templateURL=https://awsi-megs-guidances-us-east-1.s3.amazonaws.com/media2cloud/latest/media2cloud.template&stackName=media2cloudv4" target="_blank">Launch stack</a>|https://awsi-megs-guidances-us-east-1.s3.amazonaws.com/media2cloud/latest/media2cloud.template|
|US West (Oregon)|<a href="https://console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks/quickcreate?templateURL=https://awsi-megs-guidances-us-west-2.s3.us-west-2.amazonaws.com/media2cloud/latest/media2cloud.template&stackName=media2cloudv4" target="_blank">Launch stack</a>|https://awsi-megs-guidances-us-west-2.s3.us-west-2.amazonaws.com/media2cloud/latest/media2cloud.template|
|Europe (Ireland)|<a href="https://console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?templateURL=https://awsi-megs-guidances-eu-west-1.s3.eu-west-1.amazonaws.com/media2cloud/latest/media2cloud.template&stackName=media2cloudv4" target="_blank">Launch stack</a>|https://awsi-megs-guidances-eu-west-1.s3.eu-west-1.amazonaws.com/media2cloud/latest/media2cloud.template|
|Asia Pacific (Sydney)|<a href="https://console.aws.amazon.com/cloudformation/home?region=ap-southeast-2#/stacks/quickcreate?templateURL=https://awsi-megs-guidances-ap-southeast-2.s3.ap-southeast-2.amazonaws.com/media2cloud/latest/media2cloud.template&stackName=media2cloudv4" target="_blank">Launch stack</a>|https://awsi-megs-guidances-ap-southeast-2.s3.ap-southeast-2.amazonaws.com/media2cloud/latest/media2cloud.template|

The stack creation takes about 30 minutes to complete. Upon completion, you should receive an email invitation to the Media2Cloud web portal.


#### _Input Parameters_

| ParameterKey | ParameterValue | Description |
|:-- |:-- |:--|
|VersionCompatibilityStatement|Yes, I understand and proceed| (Mandatory) Make sure to read the version compatibility statement before you proceed|
| Email | YOUR@EMAIL.COM | (Mandatory) Fill in your email address. The email address is used to sign up to Amazon Cognito UserPool and to receive an invitation email to the Media2Cloud web portal |
|DefaultAIOptions | Recommended V4 features (v4.default) | Choose the default AI/ML settings. The settings can also be modified via the Media2Cloud web portal under the Settings page |
|PriceClass|Use Only U.S., Canada and Europe (PriceClass_100)|Choose the most appropriate Amazon CloudFront price class for your region |
|StartOnObjectCreation|YES|Enable auto-ingestion when a new object is uploaded to the Amazon S3 bucket (IngestBucket)|
|UserDefinedIngestBucket|LEAVE IT BLANK|Optionally you can connect your existing ingest bucket to the Media2Cloud|
|OpenSearchCluster|Development and Testing (t3.medium=0,m5.large=1,gp2=10,az=1)|For testing and evaluation purpose, recommed to use a single instance. For stagging and production environment, consider to use the Production configuration.|
|EnableKnowledgeGraph|NO|Select **YES** if you would like to enable Amazon Neptune graph database which allows you to visualize how your contents are connected in some ways.|
|CidrBlock|172.31.0.0/16|Applicable only if you enable Amazon Neptune graph|
|BedrockSecondaryRegionAccess|YES|`YES` allows Bedrock to use global cross-region inference. `NO` disables Generative AI models|
|BedrockModel|Anthropic Claude Haiku 4.5|Choose between `Anthropic Claude Haiku 4.5` or `Anthropic Claude Sonnet 4.6`. Both models are Text & Vision capable.|

__

## Building Media2Cloud V4 on your environment

#### _Prerequisites_
Make sure you have the following tools installed on your environment:
- [NodeJS 20.x](https://nodejs.org/en/download/current/)
- [AWS Command Line Interface (CLI)](https://aws.amazon.com/cli/)
- [jq](https://stedolan.github.io/jq/)
- [Docker](https://docs.docker.com/get-docker/)

#### _Step 1: Create an Amazon S3 bucket_

When you build the Media2Cloud V4 on your environment, you create artifacts such as the CloudFormation templates and the code packages in zip format. You need a S3 bucket to store the artefact such that you can launch the stack by pointing to your own version of CloudFormation templates.

Skip this step if you already have a S3 bucket that you plan to use.

```sh

aws s3api create-bucket --bucket yourname-artefact-bucket --region us-east-1

```

#### _Step 2: Clone GitHub repo_

```sh

git clone https://github.com/aws-solutions-library-samples/guidance-for-media2cloud-on-aws

```

#### _Step 3: Run the build script_

```sh

# change to the deployment directory
cd guidance-for-media2cloud-on-aws/deployment

bash build-s3-dist.sh \
  --bucket yourname-artefact-bucket \
  --version v4.1234 \
  --single-region > build.log 2>&1 &

# tail the build.log
tail -f build.log

```

\* _Tip 1: Always assign an unique version with `--version` flag to ensure Cloudformation Update stack operation works properly. If the version is not updated, the Update stack operation may skip updating some resources. Alternatively, you can update [.version](source/layers/core-lib/lib/.version) under source/layers/core-lib/lib/._

\* _Tip 2: Always include `--single-region` flag when you are building the stack for a single region use._

#### _Step 4: Deploy the build artefacts to your S3 bucket_

```sh

bash deploy-s3-dist.sh \
  --bucket yourname-artefact-bucket \
  --version v4.1234 \
  --single-region

```

Once the artefacts are uploaded to yourname-artefact-bucket, you can use the HTTPS URL of the `media2cloud.template` to create the stack on CloudFormation.

__

## Updating an Existing Stack

To update your deployed Media2Cloud stack with new features or bug fixes:

### Step 1: Build New Version

```sh
cd deployment

# Increment version number (e.g., v4.0.10 → v4.0.11)
bash build-s3-dist.sh \
  --bucket YOUR-BUCKET-NAME \
  --version v4.0.11 \
  --single-region
```

### Step 2: Deploy to S3

```sh
bash deploy-s3-dist.sh \
  --bucket YOUR-BUCKET-NAME \
  --version v4.0.11 \
  --single-region
```

### Step 3: Update CloudFormation Stack

**Option A - AWS Console (Recommended):**
1. Go to [CloudFormation Console](https://console.aws.amazon.com/cloudformation/)
2. Select your stack → Click **Update**
3. Choose **Replace current template**
4. Enter the new template URL from deploy output
5. Keep all existing parameters (do not change)
6. Submit and wait for `UPDATE_COMPLETE` (10-20 minutes)

**Option B - AWS CLI:**
```sh
aws cloudformation update-stack \
  --stack-name media2cloudv4 \
  --template-url https://YOUR-BUCKET.s3.amazonaws.com/media2cloud/v4.0.11/media2cloud.template \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --parameters \
    ParameterKey=Email,UsePreviousValue=true \
    ParameterKey=DefaultAIOptions,UsePreviousValue=true \
    ParameterKey=PriceClass,UsePreviousValue=true \
    ParameterKey=StartOnObjectCreation,UsePreviousValue=true \
    ParameterKey=OpenSearchCluster,UsePreviousValue=true \
    ParameterKey=BedrockSecondaryRegionAccess,UsePreviousValue=true \
    ParameterKey=BedrockModel,UsePreviousValue=true
```

**Important:** Stack updates modify Lambda code and infrastructure, but **preserve all your data** (S3 files, DynamoDB tables, OpenSearch indices, user accounts).

__

## Cost Estimation

> **Disclaimer.** All numbers below are **rough order-of-magnitude estimates** based on public AWS list pricing in `us-west-2` as of 2026-05-21. Real costs vary by Region, contract discount (EDP / private pricing), traffic profile, OpenSearch sizing, and whether Bedrock cross-region inference is enabled. Prices change without notice — always confirm with the [AWS Pricing Calculator](https://calculator.aws) before quoting a customer. Costs are quoted in **USD**. Bedrock token volumes are estimates derived from average transcript length per minute of speech (~150 words/min ≈ 200 tokens/min in Chinese).

Three cost categories to keep separate in your head:

| Category | Trigger | Billing cadence |
|---|---|---|
| **A. Always-on infrastructure** | The CFN stack exists | Monthly, whether or not anyone uses it |
| **B. One-shot, per action** | User uploads a video, clicks Detect highlights, clicks Render, clicks Publish | Once, when the action runs |
| **C. Recurring storage** | An asset (master / proxy / render / publish output) is in S3 | Monthly per GB, until Deleted |

Section §5 stitches A + B + C together for a representative customer demo.

### 1. (Category A) Always-on infrastructure — per month

What you pay just for the stack to exist, **before any video is ingested**. Most cost concentrates in OpenSearch and (if enabled) Neptune.

| Component | Configuration | ~Monthly cost |
|---|---|---|
| Amazon OpenSearch (Dev/Test) | 1× `m5.large.search`, 10 GB gp2, 1 AZ | ~ **$110** |
| Amazon OpenSearch (Production) | 3× `m5.large.search`, 100 GB gp2, 2 AZ + 3 dedicated masters | ~ **$650** |
| Amazon DynamoDB | On-demand, 9 small tables (Ingest, Analysis, Faces, AdBreak, HighlightSets, EditProjects, Renders, HighlightSettings, etc.) — only billed on use | ~ **$1–5** at idle |
| Amazon CloudFront + S3 (web app) | 1 distribution + ~30 MB static assets | ~ **$1** |
| Amazon API Gateway | Idle | ~ **$0** (per-request) |
| AWS Lambda | Idle | ~ **$0** (per-invocation) |
| AWS IoT Core | 1 thing, low MQTT volume | ~ **$0–1** |
| Amazon Cognito User Pool | < 50 MAU | **$0** (free tier) |
| Amazon Neptune (only if `EnableKnowledgeGraph=YES`) | 1× `db.t3.medium` | ~ **$60** |
| **Subtotal — idle stack (no Neptune, Dev OpenSearch)** | | **~ $115/mo** |
| **Subtotal — idle stack (no Neptune, Prod OpenSearch)** | | **~ $655/mo** |

> Biggest single line item is OpenSearch. For demos/POCs use the Dev/Test cluster size; switch to Production sizing only when you start ingesting your real catalogue.

### 2. (Category B) One-shot per video — Ingest + Analysis

Variable cost for **one upload + analyze run**. Charged once when the user uploads. The pipeline scales linearly with **video duration**, not file size, because almost every downstream service is billed per-minute.

Assumptions: H.264 1080p source, single audio track, English/Chinese transcript, default V4 AI options (Rekognition Video labels + Celebrities + Faces + Segments, Transcribe, dynamic frame analysis with average ~1 frame every 3 sec, scene description on every detected scene).

| Service | What it does | Unit price (us-west-2) | 5 min | 30 min | 60 min |
|---|---|---|---|---|---|
| AWS Elemental MediaConvert (proxy + frames) | Builds the MP4 proxy, HLS, audio proxy, frame thumbs | ~$0.0075/min (Pro tier) | **$0.04** | **$0.23** | **$0.45** |
| Amazon Transcribe | Speech-to-text | $0.024/min | **$0.12** | **$0.72** | **$1.44** |
| Amazon Rekognition Video — Labels | DetectLabels on segments | $0.10/min | **$0.50** | **$3.00** | **$6.00** |
| Amazon Rekognition Video — Celebrities | RecognizeCelebrities | $0.10/min | **$0.50** | **$3.00** | **$6.00** |
| Amazon Rekognition Video — Faces | DetectFaces + IndexFaces | $0.10/min + $0.001/face indexed | **$0.50** | **$3.00** | **$6.00** |
| Amazon Rekognition Video — Segments | Shot/segment detection | $0.05/min | **$0.25** | **$1.50** | **$3.00** |
| Amazon Rekognition Image (dynamic frame analysis) | Per selected keyframe | $0.001/image | ~$0.10 (~100 frames) | ~$0.60 (~600 frames) | ~$1.20 (~1200 frames) |
| Amazon Bedrock — Claude Haiku 4.5 (scene description, IAB/GARM, sentiment) | Vision + Text per scene | $0.25/MTok in, $1.25/MTok out | ~$0.05 | ~$0.30–$0.60 | ~$0.60–$1.20 |
| Amazon Bedrock — embeddings (Titan v2) | One vector per keyframe | $0.00002/1K tok | < $0.01 | < $0.05 | < $0.10 |
| Amazon DynamoDB writes | On-demand WCUs | $1.25/M writes | < $0.01 | < $0.01 | < $0.01 |
| AWS Lambda + Step Functions | Orchestration | per-invocation | ~$0.05 | ~$0.20 | ~$0.40 |
| **Total per analyze run (one-shot)** | | | **~ $2.10** | **~ $12.50** | **~ $25.30** |

> The Bedrock vision line scales with the number of keyframes × ~1.5K image tokens each — the range above brackets denser vs. sparser scene cuts. Storage for the proxy / frames / JSON is **not** in this table; it lives in §4 because it's monthly.

**Sensitivities**
- **Disabling Celebrities or Faces** drops ~$0.10/min each — flip them off in `DefaultAIOptions` if not needed.
- **Switching Bedrock model from Haiku 4.5 → Sonnet 4.6** raises the Bedrock line ~5×.
- **Sub-Project E "auto highlight detection"** does **not** run during the analyze pipeline — it's a separate one-click action billed under §3a.

### 3. (Category B) One-shot per action — Highlight detection + Render + Publish

**Additional** costs on top of §2, only billed when the user actually clicks **Detect highlights**, **Render**, or **Publish**.

#### 3a. Highlight detection (one click → one Bedrock call)

The detect-highlights Lambda picks one of two strategies based on speech density (≥0.6 words/sec → transcript-llm, < 0.6 → multimodal). The user can override.

**transcript-llm path** — sends the full transcript text only. Cost is dominated by transcript length.

Default model is **Amazon Nova Pro** (us-west-2 list: $0.80 / MTok input, $3.20 / MTok output).

| Source duration | ~Tokens in / out | Nova Pro (default) | Claude Haiku 4.5 | Claude Sonnet 4.6 |
|---|---|---|---|---|
| 5 min | ~1.5K in / 1K out | **~ $0.005** | ~ $0.002 | ~ $0.02 |
| 30 min | ~9K in / 2K out | **~ $0.014** | ~ $0.005 | ~ $0.05 |
| 60 min | ~18K in / 3K out | **~ $0.024** | ~ $0.008 | ~ $0.08 |
| 2 h | ~36K in / 4K out | **~ $0.042** | ~ $0.014 | ~ $0.13 |

**multimodal path** — sends the proxy MP4 to Bedrock as a video block (plus the transcript when available). Bedrock bills the video as input tokens proportional to **duration × resolution**. The aiml proxy is pinned at 540p to keep this manageable.

| Source duration | Default model (Nova Lite multimodal) | Nova Pro multimodal | Claude Sonnet 4.6 multimodal |
|---|---|---|---|
| 5 min | **~ $0.05** | ~ $0.40 | ~ $1.50 |
| 30 min | **~ $0.30** | ~ $2.40 | ~ $9.00 |
| 60 min | **~ $0.60** | ~ $4.80 | ~ $18.00 |

> Multimodal is **20–60× more expensive** than transcript-llm on the same video. Prefer it only when the transcript is sparse or absent (silent demos, b-roll, action footage). Auto-pick already does this for you.

Lambda + DDB cost is < $0.01 per detection on either path. Switch models from the highlight Settings UI (Sub-Project B's runtime model registry).

#### 3b. Render (compose-edl → MediaConvert clip-and-stitch)

The user picks N segments totaling D minutes; MediaConvert renders HLS (1080p/720p/480p) + an MP4 proxy.

| Output duration (sum of segments) | MediaConvert (Pro tier, 4 outputs ≈ 4× minutes) | **One-shot cost** |
|---|---|---|
| 1 min | ~$0.030 | **~ $0.03** |
| 3 min | ~$0.090 | **~ $0.09** |
| 5 min | ~$0.150 | **~ $0.15** |
| 10 min | ~$0.300 | **~ $0.30** |

> The Pro tier kicks in because of HD H.264 + 3 outputs ≥ 30 fps. Use the **Basic** tier (~$0.0075/min) by dropping the 1080p rung if cost matters more than quality. (Render output bytes are stored in S3 — see §4.)

#### 3c. Publish-to-VOD (16:9 or 9:16 portrait)

Same MediaConvert math as 3b, but billed against the **published** asset duration. For the 9:16 portrait preset, MediaConvert SMART_CROP additionally invokes **AWS Elemental Inference**, billed per output minute on top of the Pro tier line.

**Elemental Inference list pricing (us-west-2)** — bundled discount when features stack in the same job:
- 1 feature (e.g. SMART_CROP only) → **$0.15/min** ($9.00/hour)
- 2 features (e.g. SMART_CROP + ImageInserter) → **$0.23/min** ($13.80/hour)

| Aspect | Per-minute cost |
|---|---|
| 16:9 landscape | ~$0.030/min (Pro tier, 4 outputs) |
| 9:16 portrait (SMART_CROP, 1 inference feature) | ~$0.030/min Pro + **$0.15/min inference** ≈ **$0.18/min** |

A 60-second short published in portrait ≈ **$0.18** + storage (§4).

### 4. (Category C) Recurring storage — per month, per asset

Every asset persists in S3 until you delete it (the Publish tab's **Delete files** button removes Render + Publish output prefixes on demand). All four prefixes below are **S3 Standard at $0.023/GB-mo**.

| Bucket / prefix | What's in it | Typical size for one 60-min 1080p source |
|---|---|---|
| Ingest bucket | Original master upload | ~ 3 GB |
| Proxy bucket — `proxies/{uuid}/` | MediaConvert proxy + frames + JSON metadata | ~ 1.5 GB |
| Proxy bucket — `renders/{uuid}/{renderId}/` | One highlight render output | ~ 0.25 GB per render |
| Proxy bucket — `outputs/{uuid}/{outputId}/` | One publish output | ~ 0.05 GB per 60-sec portrait short |

| Asset profile | Total GB | **Storage cost / month** |
|---|---|---|
| 30-min source, no renders/publishes | ~ 2.3 GB | **~ $0.05/mo** |
| 60-min source, no renders/publishes | ~ 4.5 GB | **~ $0.10/mo** |
| 60-min source + 1 render + 1 publish | ~ 4.8 GB | **~ $0.11/mo** |

> Move analyzed-but-cold assets to S3 Glacier Instant Retrieval (~$0.004/GB-mo) for ~80% savings. The ingest master is usually the largest line — consider lifecycle to Glacier after the proxy is built.

### 5. End-to-end example (one customer demo)

Single 30-minute Cantonese source, on the **Dev/Test stack**, doing: full analyze + 1 highlight detection (transcript-llm) + 1 render of a 90-second short + 1 publish in 9:16 portrait.

**Month 1 — first time the customer uses the stack:**

| Category | Step | Cost |
|---|---|---|
| A | Always-on infra (1 month) | $115.00 |
| B | Analyze run (30 min source, default AI options) | $12.50 |
| B | Highlight detection (Nova Pro, transcript-llm) | $0.01 |
| B | Render 90 s short | $0.05 |
| B | Publish 90 s portrait (SMART_CROP, 1 inference feature) | $0.27 |
| C | Storage for master + proxy + render + publish (1 month) | $0.10 |
| | **Total** | **~ $128** |

**Month 2 onwards — same customer keeps that one asset around but does nothing new:**

| Category | Step | Cost |
|---|---|---|
| A | Always-on infra | $115.00 |
| C | Storage for the asset | $0.10 |
| | **Total** | **~ $115/mo** |

**Each *additional* 30-min video processed the same way (one-shot, Category B only):**

| Step | Cost |
|---|---|
| Analyze run | $12.50 |
| Highlight detection (Nova Pro, transcript-llm) | $0.01 |
| Render 90 s short | $0.05 |
| Publish 90 s portrait | $0.27 |
| **Marginal one-shot per video** | **~ $12.83** |

Each new asset then adds **~$0.10/mo** to the storage tail until it's deleted. Switching that highlight detection from transcript-llm to **multimodal Nova Pro** would push the per-video one-shot to ~$15.20 instead of $12.83.

**Cost-saving levers**
1. Run on **Dev/Test OpenSearch** for POCs (–$540/mo vs Production sizing — biggest single lever).
2. Disable Rekognition Video Celebrities + Faces if you don't need them (–$0.20/min ≈ –$6/30-min video).
3. Use **Claude Haiku 4.5** for scene description on non-hero content (–~80% on the Bedrock vision line).
4. Let highlight detection auto-pick its strategy — only force multimodal when speech is sparse (it's 20–60× the cost).
5. Move analyzed-but-cold assets to **S3 Glacier Instant Retrieval** (–80% on storage tail).
6. Use the publish tab's **Delete files** button after a render is exported elsewhere — render outputs are easily 250 MB+ each.

__

## Deep dive into Media2Cloud V4

#### _Resource naming convention_

The resources created by the Media2Cloud CloudFormation stack follow a naming convention that follows the pattern [SolutionID]-[PartialStackID]-[WorkflowName]. The SolutionID for Media2Cloud is `so0050`, the PartialStackID is a unique ID generated by CloudFormation upon stack creation, and the WorkflowName can be `ingest`, `analysis`, or other workflow names. For example, the Ingestion Main state machine would be named `so0050-000000000000-ingest-main`, and a lambda function in the Analysis Main state machine would be named `so0050-000000000000-analysis-main`.


#### _Backend workflow_

The core part of the Media2Cloud V4 is the backend ingestion and analysis workflows. To learn more, click on the topics.

- [Main state machine](./source/main/README.md)
  - [Ingestion Main state machine](./source/main/ingest/main/README.md)
    - [Video Ingestion state machine](./source/main/ingest/video/README.md)
    - [Audio Ingestion state machine](./source/main/ingest/audio/README.md)
    - [Image Ingestion state machine](./source/main/ingest/image/README.md)
    - [Document Ingestion state machine](./source/main/ingest/document/README.md)
  - [Analysis Main state machine](./source/main/analysis/main/README.md)
    - [Video Analysis state machine](./source/main/analysis/video/README.md)
    - [Audio Analysis state machine](./source/main/analysis/audio/README.md)
    - [Image Analysis state machine](./source/main/analysis/image/README.md)
    - [Document Analysis state machine](./source/main/analysis/document/README.md)
- [Opensource ML models and vector store](./docker/README.md)
  - [CLIP (zeroshot image classification model)](./docker/zero-shot-classifier-on-aws/README.md)
  - [OWL-ViT (zero-shot object detection model)](./docker/zero-shot-object-on-aws/README.md)
  - [Faiss (ephemeral vector store)](./docker/faiss-on-aws/README.md)


#### _Frontend workflow_

- [Web application](./source/webapp/README.md)
- [API Endpoint](./source/api/README.md)

__

## V4 Demo Video Gallery

#### _Scene and Ad break detection_

Demonstrating the differences between scene and shot, the conversation topic analysis, the contextual information at the scene level including scene description, IAB Content Taxonomy, GARM Taxonomy, Sentiment, and Brands and logos.

![Scene and Ad break detection](./deployment/tutorials/images/v4-scene-detection.gif)

#### _Dynamic Frame Analysis_

Demonstrating how the Dynamic Frame Analysis feature can significantly reduce the numbers of API calls to Amazon Rekognition services while still extracting the valuable metadata from the media file.

![Dynamic Frame Analysis](./deployment/tutorials/images/v4-dynamic-frame-analysis.gif)

#### _Auto Face Indexer_

Demonstrating how the Auto Face Indexer uses the late binding technique to allow you to "tag" the unrecognized faces without re-analyzing the meda files.

![Auto Face Indexer](./deployment/tutorials/images/v4-auto-face-indexer.gif)


__

## LICENSE

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License").
You may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

__

## Collection of operational metrics

This solution collects anonymous operational metrics to help AWS improve the quality of features of the solution. For more information, including how to disable this capability, please see the [implementation guide](https://aws-solutions-library-samples.github.io/media-entertainment/media2cloud-on-aws.html#anonymized-data-collection).
