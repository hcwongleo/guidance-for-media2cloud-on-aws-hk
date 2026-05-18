// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const WebVttHelper = require('./webVttHelper');

class SrtHelper {
  static toTimestamp(seconds) {
    const totalMs = Math.round(seconds * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    const m = totalMin % 60;
    const h = Math.floor(totalMin / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  static fromCues(cues = []) {
    return cues
      .map((cue, idx) => {
        const start = SrtHelper.toTimestamp(cue.start);
        const end = SrtHelper.toTimestamp(cue.end);
        const text = (cue.text || '').replace(/<[^>]*>/g, '').trim();
        return `${idx + 1}\n${start} --> ${end}\n${text}\n`;
      })
      .join('\n');
  }

  static fromVttString(vttString, options = {}) {
    const parsed = WebVttHelper.parse(vttString, options);
    return SrtHelper.fromCues(parsed.cues || []);
  }

  static parseSrt(srtString) {
    if (!srtString) {
      return [];
    }
    const blocks = srtString
      .replace(/\r\n/g, '\n')
      .split(/\n\n+/)
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    return blocks
      .map((block) => {
        const lines = block.split('\n');
        if (lines.length < 2) return undefined;
        let timeLineIdx = 0;
        if (/^\d+$/.test(lines[0].trim())) {
          timeLineIdx = 1;
        }
        const timeLine = lines[timeLineIdx];
        const m = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
        if (!m) return undefined;
        const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
        const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
        const text = lines.slice(timeLineIdx + 1).join('\n').trim();
        return { start, end, text };
      })
      .filter((c) => c !== undefined);
  }
}

module.exports = SrtHelper;
