// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const FS = require('node:fs');
const PATH = require('node:path');
const {
  DynamoDBClient,
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const CRYPTO = require('node:crypto');

const {
  CommonUtils,
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
} = require('core-lib');

const REQUIRED_ENVS = [
  'ENV_PROXY_BUCKET',
  'ENV_INGEST_TABLE',
  'ENV_HIGHLIGHT_SETS_TABLE',
  'ENV_RENDERS_TABLE',
  'ENV_DATA_ACCESS_ROLE',
];

const FPS = 25;
const TEMPLATES_PREFIX = '_mc_templates';
const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TEMPLATE = 'mp4_landscape';
const AUDIO_SOURCE_NAME = 'Audio Selector 1';
const CAPTION_SOURCE_NAME = 'Captions Selector 1';
const SUBTITLE_PREFIX = 'transcode/subtitle';

const PUBLISH_CLOUDFRONT_DOMAIN = process.env.ENV_PUBLISH_CLOUDFRONT_DOMAIN || '';

function ddb() {
  const client = xraysdkHelper(new DynamoDBClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function secondsToTimecode(seconds, fps = FPS) {
  const total = Math.max(0, Number(seconds) || 0);
  const totalFrames = Math.round(total * fps);
  const f = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return [h, m, s, f]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function buildHighlightInputs(sourceUri, segments, perClipCaptionSelectors) {
  return segments.map((seg, idx) => {
    const input = {
      FileInput: sourceUri,
      InputClippings: [
        {
          StartTimecode: secondsToTimecode(seg.startSec),
          EndTimecode: secondsToTimecode(seg.endSec),
        },
      ],
      TimecodeSource: 'ZEROBASED',
      VideoSelector: {
        ColorSpace: 'FOLLOW',
        Rotate: 'AUTO',
      },
      AudioSelectors: {
        [AUDIO_SOURCE_NAME]: {
          DefaultSelection: 'DEFAULT',
          Offset: 0,
        },
      },
      FilterEnable: 'AUTO',
      PsiControl: 'USE_PSI',
      DeblockFilter: 'DISABLED',
      DenoiseFilter: 'DISABLED',
    };
    const sel = perClipCaptionSelectors && perClipCaptionSelectors[idx];
    if (sel && Object.keys(sel).length > 0) {
      input.CaptionSelectors = sel;
    }
    return input;
  });
}

function buildSingleInput(sourceUri, captionSelectors) {
  const input = {
    FileInput: sourceUri,
    TimecodeSource: 'ZEROBASED',
    VideoSelector: {
      AlphaBehavior: 'DISCARD',
      ColorSpace: 'FOLLOW',
      Rotate: 'DEGREE_0',
    },
    AudioSelectors: {
      [AUDIO_SOURCE_NAME]: {
        Offset: 0,
        DefaultSelection: 'DEFAULT',
        ProgramSelection: 1,
      },
    },
    FilterEnable: 'AUTO',
    PsiControl: 'USE_PSI',
    FilterStrength: 0,
    DeblockFilter: 'DISABLED',
    DenoiseFilter: 'DISABLED',
  };
  if (captionSelectors && Object.keys(captionSelectors).length > 0) {
    input.CaptionSelectors = captionSelectors;
  }
  return [input];
}

// Load the highlight set row that holds the segment list + render
// add-ons (mode, template, burnSubtitles, logos, etc.). The
// EditProjects table that previously stored this state is gone as of
// v4.0.32 — segments + render add-ons are written back to the same
// HighlightSets row by the editor modal and OutputTab.
async function loadHighlightSet(table, uuid, highlightSetId) {
  const doc = ddb();
  const res = await doc.send(new GetCommand({
    TableName: table,
    Key: { uuid, highlightSetId },
  }));
  if (!res || !res.Item) {
    throw new M2CException(`Highlight set not found: ${uuid}/${highlightSetId}`);
  }
  return res.Item;
}

async function loadIngestRow(table, uuid) {
  const doc = ddb();
  const res = await doc.send(new GetCommand({
    TableName: table,
    Key: { uuid },
  }));
  if (!res || !res.Item) {
    throw new M2CException(`Ingest record not found: ${uuid}`);
  }
  return res.Item;
}

// Use the originally ingested file when available so MediaConvert isn't asked
// to upscale a downscaled aiml inference proxy. Fall back to a "prod" mp4
// proxy if the original is gone; never the aiml proxy.
function resolveSourceUri(ingestRow, proxyBucket) {
  if (ingestRow && ingestRow.bucket && ingestRow.key) {
    return `s3://${ingestRow.bucket}/${ingestRow.key}`;
  }
  const proxies = (ingestRow || {}).proxies || [];
  const videoProxies = proxies.filter((p) =>
    p && p.type === 'video' && (p.key || '').toLowerCase().endsWith('.mp4'));
  const prod = videoProxies.find((p) => p.outputType === 'prod');
  if (prod && prod.key) {
    return `s3://${proxyBucket}/${prod.key}`;
  }
  throw new M2CException('cannot resolve source video for render');
}

async function loadTemplate(proxyBucket, name) {
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new M2CException(`invalid template name: ${name}`);
  }
  const s3Key = `${TEMPLATES_PREFIX}/${name}.json`;
  const exists = await CommonUtils.headObject(proxyBucket, s3Key).catch(() => undefined);
  if (exists) {
    const buf = await CommonUtils.download(proxyBucket, s3Key);
    return JSON.parse(buf.toString('utf8'));
  }
  const file = PATH.join(__dirname, 'tmpl', `${name}.json`);
  if (!FS.existsSync(file)) {
    throw new M2CException(`template not found: ${name}`);
  }
  return JSON.parse(FS.readFileSync(file, 'utf8'));
}

async function resolveSrtKey(proxyBucket, uuid) {
  const editedKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}_edited.srt`;
  const plainKey = `${uuid}/${SUBTITLE_PREFIX}/${uuid}.srt`;
  let exists = await CommonUtils.headObject(proxyBucket, editedKey).catch(() => undefined);
  if (exists) return editedKey;
  exists = await CommonUtils.headObject(proxyBucket, plainKey).catch(() => undefined);
  if (exists) return plainKey;
  return undefined;
}

// Snapshot the chosen SRT into the output folder so the MediaConvert job is
// self-contained — later Reset / Save / AI Edit cannot yank the file out from
// under an in-flight job (was the cause of MediaConvert error 1040).
async function snapshotSrt(proxyBucket, uuid, outputBaseKey) {
  const srcKey = await resolveSrtKey(proxyBucket, uuid);
  if (!srcKey) return undefined;
  const destKey = `${outputBaseKey}/captions.srt`;
  await CommonUtils.copyObject(
    `${proxyBucket}/${srcKey}`,
    proxyBucket,
    destKey
  );
  return {
    uri: `s3://${proxyBucket}/${destKey}`,
    sourceKey: srcKey,
    snapshotKey: destKey,
    origin: srcKey.endsWith('_edited.srt') ? 'edited' : 'original',
  };
}

function srtTimestampToSeconds(ts) {
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(ts.trim());
  if (!m) return NaN;
  return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + (Number(m[4]) / 1000);
}

function secondsToSrtTimestamp(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function parseSrt(srtText) {
  const blocks = srtText.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    if (lines.length < 2) continue;
    const tsLine = lines[1];
    const m = /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/.exec(tsLine);
    if (!m) continue;
    const start = srtTimestampToSeconds(m[1]);
    const end = srtTimestampToSeconds(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    cues.push({ start, end, text: lines.slice(2).join('\n') });
  }
  return cues;
}

function frameAlignedSec(sec, fps = FPS) {
  return Math.round(Math.max(0, sec) * fps) / fps;
}

const ONE_FRAME_SEC = 1 / FPS;
// MediaConvert drops cues whose start equals the InputClipping start (the
// window check is exclusive on the lower edge). Nudge any cue that starts
// at-or-before the window start one frame inside.
const CUE_LEAD_SEC = ONE_FRAME_SEC * 1.5;

// MediaConvert's BurninDestinationSettings.Width is a positioning bounding
// box, not a word-wrap directive — long lines still overflow. Pre-wrap in
// JS using width units (CJK = 2, Latin = 1) so the rendered text fits.
//
// Wrap budget is no longer a hardcoded per-template number — it's derived
// from the user's subtitleLayout knobs at render time inside
// composeSubtitleAssets() so portrait + landscape both fit naturally.
const WRAP_MAX_LINES_DEFAULT = 2;

function charWidthUnits(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
  ) return 2;
  return 1;
}

// Kinsoku: punctuation that must not appear at the *start* of a line.
// If the next-line first char would be one of these, pull it onto the
// previous line (over budget by one char is fine — looks better than an
// orphan comma).
const NO_LINE_START = new Set([
  ',', '.', '!', '?', ':', ';', ')', ']', '}', '"', "'", '”', '’',
  '，', '。', '、', '！', '？', '：', '；', '）', '］', '｝', '」', '』', '〉', '》', '〕', '〗', '〙', '〛',
  '…', '‥', '·', '・', '°', '％', '％', '‰',
]);

function textWidthUnits(text) {
  let total = 0;
  for (const ch of Array.from(text)) total += charWidthUnits(ch);
  return total;
}

// Wrap a single cue's text. Returns {lines, overflow}: overflow=true means
// the text didn't fit in maxLines × maxUnits and the trailing characters
// were dropped from `lines` — caller decides what to do (split / shrink).
//
// Word-boundary handling: when the budget runs out mid-word in a Latin
// (or any space-separated) script, back up to the most recent space so
// we don't cut words. CJK has no inter-char spaces and uses kinsoku
// rules instead, so we only back up if the *next* char would have been
// space-separable from what we already kept.
function wrapCueText(text, maxUnits, maxLines = WRAP_MAX_LINES_DEFAULT) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return { lines: '', overflow: false };
  const chars = Array.from(flat);
  const lines = [];
  let i = 0;
  while (i < chars.length && lines.length < maxLines) {
    let used = 0;
    let j = i;
    while (j < chars.length) {
      const w = charWidthUnits(chars[j]);
      if (used + w > maxUnits) break;
      used += w;
      j += 1;
    }
    if (j === i) j = i + 1; // always advance at least one char

    // If we ran out of budget mid-word (next char isn't a space and is
    // a Latin/narrow char), back up to the last space within this line.
    // Keeps "AWS innovations" from becoming "AWS innovati\nons".
    if (j < chars.length && j > i) {
      const nextIsCJK = charWidthUnits(chars[j]) === 2;
      const lastIsLatin = charWidthUnits(chars[j - 1]) === 1;
      if (!nextIsCJK && lastIsLatin && chars[j] !== ' ') {
        let k = j - 1;
        while (k > i && chars[k] !== ' ') k -= 1;
        if (k > i) {
          j = k; // break at the space
        }
        // If no space found in the whole line, fall through and let MC
        // truncate (rare — really long URL or hashtag).
      }
    }

    // Pull trailing kinsoku punctuation onto this line so it doesn't
    // start the next one. Allow a small overflow.
    while (j < chars.length && NO_LINE_START.has(chars[j])) j += 1;
    // Trim leading space on the wrapped line.
    let segStart = i;
    if (chars[segStart] === ' ') segStart += 1;
    lines.push(chars.slice(segStart, j).join('').replace(/\s+$/, ''));
    // Skip a single separating space at the wrap point so the next line
    // doesn't start with one.
    i = j;
    if (chars[i] === ' ') i += 1;
  }
  return {
    lines: lines.join('\n'),
    overflow: i < chars.length,
  };
}

// Split a cue's text at sentence/comma boundaries into N pieces, each
// fitting within maxLines × maxUnits if possible. Returns an array of
// {text, durationFraction} where durationFractions sum to 1 and are
// proportional to character count. The caller maps fractions onto the
// cue's start/end window.
//
// Boundary scan order: ". ! ? " > "; " > ", " > " " (space). Whichever
// boundary type gets us a valid split first wins.
const SENTENCE_BOUNDARIES = [
  /([.!?。！？]+["'”’)\]}〕〗〙〛]?\s+)/, // sentence-end punctuation
  /([;；]+\s*)/,                         // semicolons
  /([,，、]+\s*)/,                       // commas
  /(\s+)/,                                // any whitespace as last resort
];

function splitCueText(rawText, maxUnits, maxLines) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return [{ text: '', fraction: 1 }];

  // Already fits → no split needed.
  const single = wrapCueText(text, maxUnits, maxLines);
  if (!single.overflow) return [{ text, fraction: 1 }];

  // Try each boundary type in order until we find a split where every
  // fragment fits.
  for (const re of SENTENCE_BOUNDARIES) {
    const reGlobal = new RegExp(re.source, 'g');
    const parts = [];
    let last = 0;
    let m;
    while ((m = reGlobal.exec(text)) !== null) {
      const end = m.index + m[0].length;
      parts.push(text.slice(last, end).trim());
      last = end;
    }
    if (last < text.length) parts.push(text.slice(last).trim());
    const candidate = parts.filter((p) => p.length > 0);
    if (candidate.length < 2) continue;

    // Greedily merge adjacent fragments to maximize how full each cue
    // is without overflowing — fewer cues = less subtitle churn.
    const merged = [];
    let current = '';
    for (const piece of candidate) {
      const tentative = current ? `${current} ${piece}` : piece;
      const fit = wrapCueText(tentative, maxUnits, maxLines);
      if (fit.overflow && current) {
        merged.push(current);
        current = piece;
      } else {
        current = tentative;
      }
    }
    if (current) merged.push(current);

    // Did every fragment fit? If any piece is still overflowing, this
    // boundary type isn't fine-grained enough — try the next one.
    const allFit = merged.every((p) => !wrapCueText(p, maxUnits, maxLines).overflow);
    if (allFit && merged.length > 1) {
      const totalChars = merged.reduce((s, p) => s + p.length, 0);
      return merged.map((p) => ({
        text: p,
        fraction: totalChars > 0 ? p.length / totalChars : 1 / merged.length,
      }));
    }
  }

  // No boundary split made everything fit — return the whole thing as
  // one piece and let the outer pass shrink the wrap budget instead.
  return [{ text, fraction: 1, stillOverflows: true }];
}

// MediaConvert keeps SRT timestamps on the source timeline and filters cues
// by the InputClipping window. Cues whose start falls *before* the window
// silently drop. The window edges must match what InputClipping actually
// uses — secondsToTimecode rounds to the nearest frame, so clamp to the
// same frame-aligned values, not the raw seg.startSec/endSec.
//
// Returns {srt, overflowCount, splitCount}: caller can detect "this pass
// of wrap budget couldn't fit all the text, retry with a smaller font".
function sliceSrtToWindow(cues, startSec, endSec, wrapUnits, maxLines) {
  const winStart = frameAlignedSec(startSec);
  const winEnd = frameAlignedSec(endSec);
  const minStart = winStart + CUE_LEAD_SEC;
  const lines = [];
  let counter = 1;
  let overflowCount = 0;
  let splitCount = 0;

  for (const cue of cues) {
    if (cue.end <= winStart || cue.start >= winEnd) continue;
    const cueStart = Math.max(cue.start, minStart);
    const cueEnd = Math.max(cueStart + 0.05, Math.min(cue.end, winEnd));
    const cueDur = Math.max(0.05, cueEnd - cueStart);

    const pieces = splitCueText(cue.text, wrapUnits, maxLines);
    if (pieces.length > 1) splitCount += pieces.length - 1;

    let cursor = cueStart;
    for (let p = 0; p < pieces.length; p += 1) {
      const piece = pieces[p];
      const isLast = p === pieces.length - 1;
      const pieceEnd = isLast
        ? cueEnd
        : Math.max(cursor + 0.05, Math.min(cueEnd, cursor + (cueDur * piece.fraction)));
      if (piece.stillOverflows) overflowCount += 1;
      const wrapped = wrapCueText(piece.text, wrapUnits, maxLines);
      lines.push(
        `${counter}`,
        `${secondsToSrtTimestamp(cursor)} --> ${secondsToSrtTimestamp(pieceEnd)}`,
        wrapped.lines,
        ''
      );
      counter += 1;
      cursor = pieceEnd;
    }
  }
  return {
    srt: lines.join('\n'),
    overflowCount,
    splitCount,
  };
}

// MediaConvert rejects the job if an output references a CaptionSelector
// the input doesn't have. For windows with no overlapping cue, emit a
// 1-frame placeholder timed *inside* the clip window so the selector binds.
function placeholderSrt(startSec) {
  const a = secondsToSrtTimestamp(startSec);
  const b = secondsToSrtTimestamp(startSec + 0.04);
  return `1\n${a} --> ${b}\n \n`;
}

// Two-pass subtitle compose for highlight (clip) renders.
//
// Pass 1: split overflowing cues at sentence/comma boundaries using the
//   user-requested wrap budget.
// Pass 2..N: if any cue still doesn't fit (no clean punctuation boundary),
//   shrink the wrap budget by 15% and re-do. Up to 3 shrinks. Each shrink
//   means MediaConvert needs a smaller FontSize so the text physically
//   fits in the same on-screen box; we return the final shrink ratio so
//   compose-edl can multiply FontSize by it before pushing to MC.
async function buildPerClipCaptionSelectors(proxyBucket, outputBaseKey, snapshotKey, segments, opts) {
  const { wrapUnits: initialWrap, maxLines } = opts;
  const buf = await CommonUtils.download(proxyBucket, snapshotKey);
  const cues = parseSrt(buf.toString('utf8'));

  const SHRINK_FACTOR = 0.85;
  const MAX_SHRINKS = 3;

  let wrapUnits = initialWrap;
  let shrinks = 0;
  let perSegmentSrt;
  let totalOverflow;
  let totalSplits = 0;

  while (shrinks <= MAX_SHRINKS) {
    perSegmentSrt = [];
    totalOverflow = 0;
    totalSplits = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const sliced = sliceSrtToWindow(cues, Number(seg.startSec), Number(seg.endSec), wrapUnits, maxLines);
      perSegmentSrt.push(sliced.srt);
      totalOverflow += sliced.overflowCount;
      totalSplits += sliced.splitCount;
    }
    if (totalOverflow === 0) break;
    shrinks += 1;
    if (shrinks > MAX_SHRINKS) break;
    wrapUnits = wrapUnits * SHRINK_FACTOR;
  }

  // Even at the smallest budget we may have residual overflowing cues —
  // ship them anyway (MediaConvert truncates display, not file). Logged
  // so the caller sees it.
  if (totalOverflow > 0) {
    console.warn(`subtitle: ${totalOverflow} cues still overflow after ${shrinks} shrink passes`);
  }

  const selectors = [];
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const body = perSegmentSrt[i] && perSegmentSrt[i].trim()
      ? perSegmentSrt[i]
      : placeholderSrt(frameAlignedSec(Number(seg.startSec)));
    const clipKey = `${outputBaseKey}/captions-${i}.srt`;
    await CommonUtils.upload({
      Bucket: proxyBucket,
      Key: clipKey,
      Body: body,
      ContentType: 'application/x-subrip',
    });
    selectors.push({
      [CAPTION_SOURCE_NAME]: {
        SourceSettings: {
          SourceType: 'SRT',
          FileSourceSettings: {
            SourceFile: `s3://${proxyBucket}/${clipKey}`,
          },
        },
      },
    });
  }

  return {
    selectors,
    fontShrinkRatio: Math.pow(SHRINK_FACTOR, shrinks),
    splitCount: totalSplits,
    residualOverflow: totalOverflow,
  };
}

// Full-mode counterpart: pre-wrap the snapshot SRT in place using the
// same shrink-on-overflow loop, then upload the rewrapped version. The
// MC job points at the rewrapped snapshot, not the original.
async function rewrapSnapshotSrt(proxyBucket, snapshotKey, opts) {
  const { wrapUnits: initialWrap, maxLines } = opts;
  const buf = await CommonUtils.download(proxyBucket, snapshotKey);
  const cues = parseSrt(buf.toString('utf8'));

  const SHRINK_FACTOR = 0.85;
  const MAX_SHRINKS = 3;

  let wrapUnits = initialWrap;
  let shrinks = 0;
  let lines;
  let overflow;
  let splits;

  while (shrinks <= MAX_SHRINKS) {
    lines = [];
    overflow = 0;
    splits = 0;
    let counter = 1;
    for (const cue of cues) {
      const dur = Math.max(0.05, cue.end - cue.start);
      const pieces = splitCueText(cue.text, wrapUnits, maxLines);
      if (pieces.length > 1) splits += pieces.length - 1;
      let cursor = cue.start;
      for (let p = 0; p < pieces.length; p += 1) {
        const piece = pieces[p];
        const isLast = p === pieces.length - 1;
        const end = isLast ? cue.end : Math.max(cursor + 0.05, cursor + dur * piece.fraction);
        if (piece.stillOverflows) overflow += 1;
        const wrapped = wrapCueText(piece.text, wrapUnits, maxLines);
        lines.push(
          `${counter}`,
          `${secondsToSrtTimestamp(cursor)} --> ${secondsToSrtTimestamp(end)}`,
          wrapped.lines,
          ''
        );
        counter += 1;
        cursor = end;
      }
    }
    if (overflow === 0) break;
    shrinks += 1;
    if (shrinks > MAX_SHRINKS) break;
    wrapUnits = wrapUnits * SHRINK_FACTOR;
  }

  const rewrapped = lines.join('\n');
  // Overwrite the snapshot in-place — MC reads via the same key.
  await CommonUtils.upload({
    Bucket: proxyBucket,
    Key: snapshotKey,
    Body: rewrapped,
    ContentType: 'application/x-subrip',
  });

  if (overflow > 0) {
    console.warn(`subtitle: ${overflow} cues still overflow after ${shrinks} shrink passes`);
  }

  return {
    fontShrinkRatio: Math.pow(SHRINK_FACTOR, shrinks),
    splitCount: splits,
    residualOverflow: overflow,
  };
}

// SMART_CROP + ImageInserter requires HTTP(S) URLs — s3:// silently fails
// with warning 250000. We front the bucket via the publish CloudFront
// distribution and convert s3://<ProxyBucket>/<key> → https://<cf>/<key>.
function toCloudFrontUrl(uri, proxyBucket) {
  if (!PUBLISH_CLOUDFRONT_DOMAIN
    || typeof uri !== 'string'
    || !uri.startsWith('s3://')) {
    return uri;
  }
  const rest = uri.slice('s3://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return uri;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (bucket !== proxyBucket) return uri;
  return `https://${PUBLISH_CLOUDFRONT_DOMAIN}/${key}`;
}

// Compute logo position for a single output stream.
//
// Logo is rendered at its native pixel size — we DON'T set Width on
// MediaConvert's InsertableImage, so MC uses the source PNG/JPG's own
// dimensions. Caller supplies xPct/yPct (% of frame width/height for
// the logo's top-left); we convert to pixel coords for THIS output's
// frame size. Same logo will appear at the same proportional position
// across 1080p / 720p / 480p outputs.
function computeLogoPlacement(frameW, frameH, layout) {
  if (!layout) return null;
  const xPct = Number.isFinite(layout.xPct) ? layout.xPct : 0;
  const yPct = Number.isFinite(layout.yPct) ? layout.yPct : 0;
  return {
    ImageX: Math.max(0, Math.round((frameW * xPct) / 100)),
    ImageY: Math.max(0, Math.round((frameH * yPct) / 100)),
    Layer: 0,
    Opacity: Math.round(Number.isFinite(layout.opacity) ? layout.opacity : 100),
  };
}

// Compute subtitle burn-in position + sizing for a single output stream.
// All values are in pixels relative to the output frame.
//
// MC's BurninDestinationSettings:
// - FontSize: in points; treat as pixel-equivalent for our purposes.
// - YPosition: top-left of the caption box, distance from top of frame.
// - XPosition + Width: bounding box for line breaks (we already pre-
//   wrapped, but MC still uses Width to center the text and to clip
//   any line that runs too long).
function computeSubtitleBurnin(frameW, frameH, layout, fontShrinkRatio) {
  const heightPct = Number.isFinite(layout.heightPct) ? layout.heightPct : 3.5;
  const bottomPct = Number.isFinite(layout.bottomPct) ? layout.bottomPct : 8;
  const sideMarginPct = Number.isFinite(layout.sideMarginPct) ? layout.sideMarginPct : 5;
  const fontSize = Math.max(8, Math.round((frameH * heightPct / 100) * (fontShrinkRatio || 1)));
  const bottomPx = Math.max(0, Math.round((frameH * bottomPct) / 100));
  // Reserve maxLines × 1.25 line-height for the caption box. Subtract
  // from frame height to get the top of the box (YPosition).
  const lines = Math.max(1, Math.round(Number.isFinite(layout.maxLines) ? layout.maxLines : 2));
  const boxHeight = Math.round(fontSize * 1.25 * lines);
  const yPosition = Math.max(0, frameH - bottomPx - boxHeight);
  // Caption box width derived from the side-margin knob — sideMarginPct
  // is per-side, so the box is (100 - 2 × sideMarginPct)% wide and
  // centered between the two margins.
  const sideMarginPx = Math.max(0, Math.round((frameW * sideMarginPct) / 100));
  const widthPx = Math.max(1, frameW - 2 * sideMarginPx);
  const xPosition = sideMarginPx;
  return {
    FontSize: fontSize,
    YPosition: yPosition,
    XPosition: xPosition,
    Width: widthPx,
  };
}

function applyTemplate(template, opts) {
  const {
    hlsDestination,
    mp4Destination,
    fontScript,
    captionSourceName,
    hasSubtitles,
    logos,
    logoLayout,
    subtitleLayout,
    fontShrinkRatio,
    proxyBucket,
  } = opts;

  const groups = JSON.parse(JSON.stringify(template.OutputGroups || []));
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new M2CException('template must have non-empty OutputGroups');
  }

  // Pick which logo size to use overall — biggest available, since we
  // re-scale per output stream anyway. Falls back to undefined if no
  // logos uploaded; logo block then gets stripped per output.
  const availableSizes = Object.keys(logos || {})
    .filter((k) => logos[k])
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  const chosenLogoSize = availableSizes.length > 0 ? String(availableSizes[0]) : null;
  const chosenLogoUri = chosenLogoSize ? logos[chosenLogoSize] : null;

  groups.forEach((og) => {
    const settings = og.OutputGroupSettings || {};
    if (settings.Type === 'HLS_GROUP_SETTINGS' && settings.HlsGroupSettings) {
      settings.HlsGroupSettings.Destination = hlsDestination;
    } else if (settings.Type === 'FILE_GROUP_SETTINGS' && settings.FileGroupSettings) {
      settings.FileGroupSettings.Destination = mp4Destination;
    }

    (og.Outputs || []).forEach((o) => {
      (o.AudioDescriptions || []).forEach((a) => {
        if (a.AudioSourceName === '##AUDIO_SOURCE##') {
          a.AudioSourceName = AUDIO_SOURCE_NAME;
        }
      });

      const vd = o.VideoDescription || {};
      const frameW = Number(vd.Width) || 0;
      const frameH = Number(vd.Height) || 0;

      if (hasSubtitles) {
        (o.CaptionDescriptions || []).forEach((c) => {
          if (c.CaptionSelectorName === '##CAPTION_SOURCE##') {
            c.CaptionSelectorName = captionSourceName;
          }
          const burn = (c.DestinationSettings || {}).BurninDestinationSettings;
          if (!burn) return;
          if (burn.FontScript === '##FONT_SCRIPT##') {
            burn.FontScript = fontScript;
          }
          if (subtitleLayout && frameW > 0 && frameH > 0) {
            const sub = computeSubtitleBurnin(frameW, frameH, subtitleLayout, fontShrinkRatio);
            burn.FontSize = sub.FontSize;
            burn.YPosition = sub.YPosition;
            burn.XPosition = sub.XPosition;
            burn.Width = sub.Width;
          }
        });
      } else {
        delete o.CaptionDescriptions;
      }

      // Logo: if user supplied a logoLayout, replace whatever the template
      // had with a single freshly-computed InsertableImage. If layout is
      // missing (older clients), keep template positions but still
      // resolve the URL via the chosen-size fallback.
      const inserter = (vd.VideoPreprocessors || {}).ImageInserter;
      if (inserter && Array.isArray(inserter.InsertableImages)) {
        if (chosenLogoUri && logoLayout && frameW > 0 && frameH > 0) {
          const placement = computeLogoPlacement(frameW, frameH, logoLayout);
          if (placement) {
            inserter.InsertableImages = [{
              ...placement,
              ImageInserterInput: toCloudFrontUrl(chosenLogoUri, proxyBucket),
            }];
          } else {
            delete vd.VideoPreprocessors.ImageInserter;
          }
        } else {
          // Legacy path: rewrite ##LOGO_NN## tokens with the matching
          // uploaded URI; drop any token without a matching upload.
          const resolved = [];
          inserter.InsertableImages.forEach((img) => {
            const m = (img.ImageInserterInput || '').match(/^##LOGO_(\d+)##$/);
            if (!m) { resolved.push(img); return; }
            const size = m[1];
            if (logos && logos[size]) {
              resolved.push({
                ...img,
                ImageInserterInput: toCloudFrontUrl(logos[size], proxyBucket),
              });
            }
          });
          if (resolved.length > 0) {
            inserter.InsertableImages = resolved;
          } else {
            delete vd.VideoPreprocessors.ImageInserter;
          }
        }
        if (vd.VideoPreprocessors && Object.keys(vd.VideoPreprocessors).length === 0) {
          delete vd.VideoPreprocessors;
        }
      }
    });
  });

  return groups;
}

async function persistRenderRow(table, renderId, attrs) {
  const doc = ddb();
  const names = {};
  const values = {};
  const sets = [];
  Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .forEach(([k, v], i) => {
      const nk = `#k${i}`;
      const vk = `:v${i}`;
      names[nk] = k;
      values[vk] = v;
      sets.push(`${nk} = ${vk}`);
    });
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: { renderId },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  const missing = REQUIRED_ENVS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new M2CException(`missing env: ${missing.join(', ')}`);
  }

  const proxyBucket = process.env.ENV_PROXY_BUCKET;
  const ingestTable = process.env.ENV_INGEST_TABLE;
  const highlightSetsTable = process.env.ENV_HIGHLIGHT_SETS_TABLE;
  const rendersTable = process.env.ENV_RENDERS_TABLE;
  const roleArn = process.env.ENV_DATA_ACCESS_ROLE;
  const solutionUuid = process.env.ENV_SOLUTION_UUID;

  const uuid = event.uuid;
  if (!uuid) {
    throw new M2CException('uuid is required');
  }

  // mode = 'full' | 'highlights'. v4.0.33+: render add-ons (template,
  // burnSubtitles, fontScript, logos) come straight from the SFN event
  // (rendersOp wrote them onto the Renders row). The HighlightSets row
  // is consulted ONLY in highlights mode, and ONLY to fetch its segment
  // list — its row-level template/burnSubtitles/etc. are no longer
  // read, because settings are per-render now.
  const mode = event.mode === 'highlights' || event.mode === 'full'
    ? event.mode
    : (event.editProjectId ? 'highlights' : 'full');

  const editProjectId = event.editProjectId;
  if (mode === 'highlights' && !editProjectId) {
    throw new M2CException('editProjectId is required for mode=highlights');
  }

  let segments;
  if (mode === 'highlights') {
    const setRow = await loadHighlightSet(highlightSetsTable, uuid, editProjectId);
    segments = (setRow.segments || []).filter(
      (s) => Number(s.endSec) > Number(s.startSec)
    );
    if (segments.length === 0) {
      throw new M2CException('highlights mode requires at least one segment on the highlight set');
    }
  }

  const ingestRow = await loadIngestRow(ingestTable, uuid);
  const sourceUri = resolveSourceUri(ingestRow, proxyBucket);

  const renderId = event.renderId || CRYPTO.randomUUID();
  const startedAt = new Date().toISOString();
  const outputBaseKey = `${uuid}/output/${renderId}`;
  const destinationPrefix = `s3://${proxyBucket}/${outputBaseKey}/`;
  const hlsDestination = `${destinationPrefix}hls/`;
  const mp4Destination = `${destinationPrefix}mp4/`;

  const templateName = event.template || DEFAULT_TEMPLATE;
  if (!TEMPLATE_NAME_RE.test(templateName)) {
    throw new M2CException(`invalid template name: ${templateName}`);
  }
  const template = await loadTemplate(proxyBucket, templateName);

  const burnSubtitles = !!event.burnSubtitles;
  const fontScript = event.fontScript || 'HANT';
  const logos = (event.logos && typeof event.logos === 'object') ? event.logos : {};
  const logoLayout = (event.logoLayout && typeof event.logoLayout === 'object')
    ? event.logoLayout
    : { xPct: 80, yPct: 5, opacity: 100 };
  const subtitleLayout = (event.subtitleLayout && typeof event.subtitleLayout === 'object')
    ? event.subtitleLayout
    : { heightPct: 3.5, bottomPct: 8, sideMarginPct: 5, maxLines: 2 };

  // Reference frame for sizing the wrap budget. Pick the largest output
  // resolution in the template so wrap pre-fits the demanding case; MC
  // re-renders smaller resolutions with proportional FontSize, so the
  // pre-wrap holds for them too.
  const referenceFrame = (() => {
    let maxArea = 0;
    let chosen = { w: 1920, h: 1080 };
    (template.OutputGroups || []).forEach((og) => (og.Outputs || []).forEach((o) => {
      const w = Number((o.VideoDescription || {}).Width) || 0;
      const h = Number((o.VideoDescription || {}).Height) || 0;
      if (w * h > maxArea) { maxArea = w * h; chosen = { w, h }; }
    }));
    return chosen;
  })();

  // Translate user-set heightPct + sideMarginPct into a wrap-unit
  // budget. A "unit" is the width of a Latin char at the chosen font
  // size; CJK = 2 units. Per-char advance is roughly 0.62 × FontSize
  // (was 0.55, but proportional fonts like Arial render slightly wider
  // than that — bumped to leave a safer margin so MC doesn't truncate
  // a wrapped line that *should* have fit). The available pixel width
  // is the frame width minus the user-chosen side margins.
  const refFontSize = Math.max(8, Math.round(referenceFrame.h * subtitleLayout.heightPct / 100));
  const sideMarginRef = Number.isFinite(subtitleLayout.sideMarginPct) ? subtitleLayout.sideMarginPct : 5;
  const usableWidth = Math.max(1, referenceFrame.w * (1 - 2 * sideMarginRef / 100));
  const initialWrapUnits = Math.max(8, Math.floor(usableWidth / (refFontSize * 0.62)));

  let captionSnapshot;
  let sharedCaptionSelectors;
  if (burnSubtitles) {
    captionSnapshot = await snapshotSrt(proxyBucket, uuid, outputBaseKey);
    if (captionSnapshot) {
      sharedCaptionSelectors = {
        [CAPTION_SOURCE_NAME]: {
          SourceSettings: {
            SourceType: 'SRT',
            FileSourceSettings: {
              SourceFile: captionSnapshot.uri,
            },
          },
        },
      };
    }
  }
  const hasSubtitles = !!captionSnapshot;

  let fontShrinkRatio = 1;
  let inputs;
  if (mode === 'highlights') {
    let perClipSelectors;
    if (hasSubtitles) {
      const result = await buildPerClipCaptionSelectors(
        proxyBucket,
        outputBaseKey,
        captionSnapshot.snapshotKey,
        segments,
        { wrapUnits: initialWrapUnits, maxLines: subtitleLayout.maxLines }
      );
      perClipSelectors = result.selectors;
      fontShrinkRatio = result.fontShrinkRatio;
      console.log(`subtitle: split=${result.splitCount} shrinkRatio=${fontShrinkRatio.toFixed(3)} residualOverflow=${result.residualOverflow}`);
    }
    inputs = buildHighlightInputs(sourceUri, segments, perClipSelectors);
  } else {
    if (hasSubtitles) {
      const result = await rewrapSnapshotSrt(
        proxyBucket,
        captionSnapshot.snapshotKey,
        { wrapUnits: initialWrapUnits, maxLines: subtitleLayout.maxLines }
      );
      fontShrinkRatio = result.fontShrinkRatio;
      console.log(`subtitle: split=${result.splitCount} shrinkRatio=${fontShrinkRatio.toFixed(3)} residualOverflow=${result.residualOverflow}`);
    }
    inputs = buildSingleInput(sourceUri, sharedCaptionSelectors);
  }

  const outputGroups = applyTemplate(template, {
    hlsDestination,
    mp4Destination,
    fontScript,
    captionSourceName: CAPTION_SOURCE_NAME,
    hasSubtitles,
    logos,
    logoLayout,
    subtitleLayout,
    fontShrinkRatio,
    proxyBucket,
  });

  const publishToLibrary = !!event.publishToLibrary;
  const aspectRatio = event.aspectRatio || '16:9';

  const mediaConvertParams = {
    Role: roleArn,
    UserMetadata: {
      solutionUuid: solutionUuid || '',
      m2cUuid: uuid,
      ...(editProjectId ? { m2cEditProjectId: editProjectId } : {}),
      m2cRenderId: renderId,
      m2cTemplate: templateName,
      m2cMode: mode,
    },
    StatusUpdateInterval: 'SECONDS_12',
    AccelerationSettings: { Mode: 'DISABLED' },
    BillingTagsSource: 'JOB',
    Settings: {
      AdAvailOffset: 0,
      FollowSource: 1,
      Inputs: inputs,
      OutputGroups: outputGroups,
    },
  };

  await persistRenderRow(rendersTable, renderId, {
    ...(editProjectId ? { editProjectId } : {}),
    uuid,
    status: 'composing',
    publishToLibrary,
    aspectRatio,
    mode,
    burnSubtitles: hasSubtitles,
    fontScript,
    template: templateName,
    logoLayout,
    subtitleLayout: hasSubtitles ? {
      ...subtitleLayout,
      effectiveFontShrinkRatio: fontShrinkRatio,
    } : subtitleLayout,
    segmentCount: mode === 'highlights' ? inputs.length : 0,
    sourceUri,
    destinationPrefix,
    captionSnapshotKey: (captionSnapshot && captionSnapshot.snapshotKey) || undefined,
    startedAt,
    updatedAt: startedAt,
  });

  return {
    renderId,
    ...(editProjectId ? { editProjectId } : {}),
    uuid,
    publishToLibrary,
    aspectRatio,
    burnSubtitles: hasSubtitles,
    template: templateName,
    mode,
    destinationPrefix,
    mediaConvertParams,
  };
};
