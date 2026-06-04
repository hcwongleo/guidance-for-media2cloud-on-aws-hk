# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""
detect-shots Lambda: download proxy MP4, run OpenCV scene detection,
return frame-grounded shot boundaries [(startSec, endSec)] for downstream
per-shot Pegasus describe.

Adaptive policy:
  1. Try PySceneDetect ContentDetector with the requested threshold.
  2. If shot density is below MIN_SHOTS_PER_MINUTE (e.g. talking-head),
     fall back to fixed-duration clips of FALLBACK_CLIP_SEC.
  3. Merge any shot < MIN_SHOT_SEC into its neighbor.
  4. Split any shot > MAX_SHOT_SEC into FALLBACK_CLIP_SEC pieces — Pegasus
     timestamp precision degrades on long inputs and per-second pricing
     is identical either way.
"""

import json
import os
import boto3
from scenedetect import detect, ContentDetector

s3 = boto3.client("s3")

LOCAL_TMP = "/tmp"

DEFAULT_THRESHOLD = 27.0
FALLBACK_CLIP_SEC = 30.0
MIN_SHOTS_PER_MINUTE = 1.0
# Pegasus on Bedrock rejects clips shorter than ~4s with HTTP 400
# "Unprocessable video". 5s gives a one-second safety margin and is the
# minimum useful highlight length anyway.
MIN_SHOT_SEC = 5.0
MAX_SHOT_SEC = 60.0


def lambda_handler(event, context):
    print("event:", json.dumps(event))

    proxy_bucket = event.get("proxyBucket") or os.environ.get("ENV_PROXY_BUCKET")
    proxy_key = event.get("proxyKey")
    duration_sec = float(event.get("durationSec") or 0)
    threshold = float(event.get("sceneThreshold") or DEFAULT_THRESHOLD)

    if not proxy_bucket or not proxy_key:
        raise ValueError("proxyBucket and proxyKey are required")

    local_path = os.path.join(LOCAL_TMP, os.path.basename(proxy_key))
    print(f"=== downloading s3://{proxy_bucket}/{proxy_key} → {local_path}")
    s3.download_file(proxy_bucket, proxy_key, local_path)

    shots, mode = _detect_shots(local_path, duration_sec, threshold)
    shots = _normalize(shots, duration_sec)
    shots = _merge_short(shots, MIN_SHOT_SEC)
    shots = _split_long(shots, MAX_SHOT_SEC)
    shots = [
        {"index": i, "startSec": s["startSec"], "endSec": s["endSec"], "durationSec": s["endSec"] - s["startSec"]}
        for i, s in enumerate(shots)
    ]
    print(f"=== detected {len(shots)} shots via {mode}")

    try:
        os.remove(local_path)
    except OSError:
        pass

    return {
        "shotCount": len(shots),
        "shots": shots,
        "mode": mode,
    }


def _detect_shots(local_path, duration_sec, threshold):
    """Try OpenCV scene detection; fall back to fixed-duration if too sparse."""
    scene_list = detect(local_path, ContentDetector(threshold=threshold))
    shots = [
        {"startSec": s.get_seconds(), "endSec": e.get_seconds()}
        for (s, e) in scene_list
    ]

    # Talking-head fallback: if scenedetect produces fewer shots than
    # MIN_SHOTS_PER_MINUTE on average, the content has no hard cuts and
    # fixed-duration is the right unit.
    if duration_sec > 0:
        density = len(shots) / max(1.0, duration_sec / 60.0)
        if density < MIN_SHOTS_PER_MINUTE:
            return _fixed_length(duration_sec, FALLBACK_CLIP_SEC), "fixed-duration"

    if not shots:
        return _fixed_length(duration_sec, FALLBACK_CLIP_SEC), "fixed-duration"

    return shots, "scenedetect"


def _fixed_length(duration_sec, clip_sec):
    if duration_sec <= 0:
        return []
    shots = []
    start = 0.0
    while start < duration_sec:
        end = min(duration_sec, start + clip_sec)
        shots.append({"startSec": start, "endSec": end})
        start = end
    return shots


def _normalize(shots, duration_sec):
    """Clamp end times to video duration and drop zero-length shots."""
    out = []
    for s in shots:
        start = max(0.0, float(s["startSec"]))
        end = float(s["endSec"])
        if duration_sec > 0:
            end = min(end, duration_sec)
        if end > start:
            out.append({"startSec": start, "endSec": end})
    return out


def _merge_short(shots, min_sec):
    """Roll any shot shorter than min_sec into its right neighbor; if it has
    no right neighbor, into its left neighbor instead."""
    if not shots:
        return shots
    out = list(shots)
    i = 0
    while i < len(out):
        duration = out[i]["endSec"] - out[i]["startSec"]
        if duration < min_sec and len(out) > 1:
            if i + 1 < len(out):
                out[i + 1]["startSec"] = out[i]["startSec"]
                out.pop(i)
                continue
            if i - 1 >= 0:
                out[i - 1]["endSec"] = out[i]["endSec"]
                out.pop(i)
                continue
        i += 1
    return out


def _split_long(shots, max_sec):
    """Split any shot longer than max_sec into max_sec-sized pieces."""
    out = []
    for s in shots:
        start = s["startSec"]
        end = s["endSec"]
        while end - start > max_sec:
            out.append({"startSec": start, "endSec": start + max_sec})
            start += max_sec
        out.append({"startSec": start, "endSec": end})
    return out
