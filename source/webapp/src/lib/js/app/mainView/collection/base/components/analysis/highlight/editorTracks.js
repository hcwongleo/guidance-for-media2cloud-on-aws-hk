// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Localization from '../../../../../../shared/localization.js';
import BaseMedia from '../../../../../../shared/media/baseMedia.js';

const _Sortable = (typeof window !== 'undefined') ? window.Sortable : undefined;

const {
  Messages: {
    HighlightEditorEditTrack: MSG_EDIT,
    HighlightEditorInspector: MSG_INSPECTOR,
    HighlightEditorEmptyEdit: MSG_EMPTY,
    HighlightEditorAddCustom: MSG_ADD_CUSTOM,
    HighlightEditorIn: MSG_IN,
    HighlightEditorOut: MSG_OUT,
    HighlightEditorDrop: MSG_DROP,
    HighlightEditorRemove: MSG_REMOVE,
  },
} = Localization;

const KIND_HIGHLIGHT = 'highlight';
const KIND_CUSTOM = 'custom';

function _fmt(sec) {
  return BaseMedia.readableDuration(Math.max(0, Number(sec) || 0) * 1000);
}

// Editable timecode helpers: round-trip to "MM:SS.mm" or "H:MM:SS.mm".
function _fmtTimeEdit(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s - h * 3600) / 60);
  const rem = s - h * 3600 - m * 60;
  const remStr = rem.toFixed(2).padStart(5, '0');
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${remStr}`;
  }
  return `${String(m).padStart(2, '0')}:${remStr}`;
}

function _parseTime(str) {
  if (str == null) return null;
  const trimmed = String(str).trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  let total = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) return null;
    total = total * 60 + n;
  }
  return total;
}

function _totalSourceSec(highlightSet) {
  const segs = highlightSet.segments || [];
  let max = 0;
  segs.forEach((s) => {
    const e = Number(s.endSec) || 0;
    if (e > max) max = e;
  });
  return Math.max(max, 1);
}

export default class EditorTracks {
  constructor({
    tracksContainer,
    inspectorContainer,
    player,
    highlightSet,
    state,
  }) {
    this.$tracks = tracksContainer;
    this.$inspector = inspectorContainer;
    this.$player = player;
    this.$highlightSet = highlightSet;
    this.$state = state;
    this.$sortable = null;
    this.$totalSec = _totalSourceSec(highlightSet);
    // Active preview: auto-pause when the player crosses endSec.
    this.$previewEndSec = null;
    // Chained compilation playback: when set, advance to next segment instead of pausing.
    this.$compilationQueue = null;
    this.$compilationIndex = 0;
    this.$playhead = null;
    this.$onTimeUpdate = () => {
      if (!this.$player) return;
      if (this.$previewEndSec != null
        && this.$player.currentTime >= this.$previewEndSec) {
        this._onSegmentBoundaryReached();
      }
      this._updatePlayhead();
    };
    // Re-render once the video reports its real duration so chip widths
    // (scaled to total video length) match the playhead position.
    this.$onLoadedMetadata = () => {
      const dur = this.$player && this.$player.duration;
      if (Number.isFinite(dur) && dur > this.$totalSec) {
        this.$totalSec = dur;
        this.render();
      }
    };
    if (this.$player) {
      this.$player.addEventListener('timeupdate', this.$onTimeUpdate);
      this.$player.addEventListener('loadedmetadata', this.$onLoadedMetadata);
      // If metadata is already available (cached), trigger immediately.
      if (Number.isFinite(this.$player.duration) && this.$player.duration > 0) {
        this.$onLoadedMetadata();
      }
    }
  }

  destroy() {
    if (this.$sortable) {
      try { this.$sortable.destroy(); } catch (e) { /* noop */ }
      this.$sortable = null;
    }
    if (this.$player && this.$onTimeUpdate) {
      this.$player.removeEventListener('timeupdate', this.$onTimeUpdate);
    }
    if (this.$player && this.$onLoadedMetadata) {
      this.$player.removeEventListener('loadedmetadata', this.$onLoadedMetadata);
    }
    this.$previewEndSec = null;
    this.$compilationQueue = null;
    this.$playhead = null;
    this.$tracks.empty();
    this.$inspector.empty();
  }

  // Seek, then call play() only once the browser has both finished the seek
  // AND buffered enough data to play forward (readyState >= HAVE_FUTURE_DATA).
  // Without the readyState check, calling play() right after `seeked` on a
  // sparse-GOP MP4 can cause a visible stall while the decoder catches up.
  _seekThenPlay(startSec) {
    const player = this.$player;
    if (!player) return;
    const start = Math.max(0, Number(startSec) || 0);
    let launched = false;
    const launch = () => {
      if (launched) return;
      launched = true;
      cleanup();
      const p = player.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => { /* autoplay blocked */ });
      }
    };
    const onSeeked = () => {
      if (player.readyState >= 3) launch();
    };
    const onCanPlay = () => {
      // canplay implies readyState >= HAVE_FUTURE_DATA at the current position.
      launch();
    };
    const cleanup = () => {
      player.removeEventListener('seeked', onSeeked);
      player.removeEventListener('canplay', onCanPlay);
    };

    // Already at target with enough buffer — just play.
    if (Math.abs((player.currentTime || 0) - start) < 0.05
      && player.readyState >= 3) {
      const p = player.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
      return;
    }

    player.addEventListener('seeked', onSeeked);
    player.addEventListener('canplay', onCanPlay);
    try {
      player.currentTime = start;
    } catch (e) {
      cleanup();
    }
  }

  _previewSegment(startSec, endSec) {
    if (!this.$player) return;
    const start = Math.max(0, Number(startSec) || 0);
    const end = Number(endSec) || 0;
    if (end <= start) return;
    // Single-segment preview cancels any active compilation.
    this.$compilationQueue = null;
    this.$previewEndSec = end;
    this._seekThenPlay(start);
  }

  _previewCompilation() {
    if (!this.$player) return;
    const segs = (this.$state.editProject.segments || [])
      .filter((s) => Number(s.endSec) > Number(s.startSec));
    if (segs.length === 0) return;
    this.$compilationQueue = segs.slice();
    this.$compilationIndex = 0;
    this._playCompilationSegment(0);
  }

  _playCompilationSegment(idx) {
    const queue = this.$compilationQueue;
    if (!queue || idx >= queue.length) {
      this.$compilationQueue = null;
      this.$previewEndSec = null;
      return;
    }
    const seg = queue[idx];
    this.$compilationIndex = idx;
    this.$previewEndSec = Number(seg.endSec) || 0;
    this._seekThenPlay(Number(seg.startSec) || 0);
  }

  _onSegmentBoundaryReached() {
    if (this.$compilationQueue) {
      const next = this.$compilationIndex + 1;
      if (next < this.$compilationQueue.length) {
        this._playCompilationSegment(next);
        return;
      }
      this.$compilationQueue = null;
    }
    this.$player.pause();
    this.$previewEndSec = null;
  }

  _seekTo(sec) {
    if (!this.$player) return;
    try {
      this.$player.currentTime = Math.max(0, Number(sec) || 0);
      this.$previewEndSec = null;
      this.$compilationQueue = null;
    } catch (e) { /* noop */ }
  }

  render() {
    this.$tracks.empty();
    this.$tracks.append(this._buildEditTrack());
    this._renderInspector();
  }

  _updatePlayhead() {
    if (!this.$playhead || !this.$player) return;
    const editSegs = this.$state.editProject.segments;
    if (!editSegs || editSegs.length === 0) {
      this.$playhead.css('display', 'none');
      return;
    }
    const cur = this.$player.currentTime || 0;

    // Resolve which edit clip is active. Compilation playback drives index
    // explicitly; otherwise fall back to source-time containment.
    let activeIdx = -1;
    if (this.$compilationQueue) {
      activeIdx = this.$compilationIndex;
    } else {
      for (let i = 0; i < editSegs.length; i += 1) {
        const s = Number(editSegs[i].startSec) || 0;
        const e = Number(editSegs[i].endSec) || 0;
        if (cur >= s && cur < e) { activeIdx = i; break; }
      }
    }

    if (activeIdx < 0) {
      this.$playhead.css('display', 'none');
      return;
    }

    const seg = editSegs[activeIdx];
    const segStart = Number(seg.startSec) || 0;
    const segEnd = Number(seg.endSec) || 0;
    const segDur = Math.max(0.001, segEnd - segStart);
    const offset = Math.max(0, Math.min(1, (cur - segStart) / segDur));

    // Anchor to the active chip's actual DOM rect inside the ribbon. Chips have
    // margins + min-width clamps, so a pure time-fraction over the ribbon width
    // drifts away from the visible edge — snapping to the chip rect keeps the
    // red bar aligned to where the user clicked.
    const ribbonEl = this.$playhead.parent()[0];
    const chipEl = ribbonEl
      && ribbonEl.querySelector(`[data-edit-index="${activeIdx}"]`);
    if (!ribbonEl || !chipEl) {
      this.$playhead.css('display', 'none');
      return;
    }
    const ribbonRect = ribbonEl.getBoundingClientRect();
    const chipRect = chipEl.getBoundingClientRect();
    if (ribbonRect.width <= 0) {
      this.$playhead.css('display', 'none');
      return;
    }
    const xWithinRibbon = (chipRect.left - ribbonRect.left)
      + offset * chipRect.width;
    const pct = (xWithinRibbon / ribbonRect.width) * 100;
    this.$playhead.css({ display: '', left: `${pct}%` });
  }

  // ---------- Edit ribbon: two-row (source map + playback sequence) ----------
  _buildEditTrack() {
    const block = $('<div/>').addClass('mb-3');

    const header = $('<div/>').addClass('d-flex align-items-center mb-1');
    header.append($('<p/>').addClass('lead-xs text-muted mb-0 mr-2').text(MSG_EDIT));

    const editSegs = this.$state.editProject.segments;
    const totalDur = editSegs.reduce((acc, s) =>
      acc + Math.max(0, (Number(s.endSec) || 0) - (Number(s.startSec) || 0)), 0);

    if (editSegs.length > 0) {
      const playAllBtn = $('<button/>')
        .addClass('btn btn-sm btn-success py-0 mr-2')
        .css({ fontSize: '11px', lineHeight: '18px' })
        .attr('type', 'button')
        .attr('title', 'Play all edit segments back-to-back')
        .html(`▶ Play compilation (${_fmt(totalDur)})`);
      playAllBtn.on('click', () => this._previewCompilation());
      header.append(playAllBtn);
    }
    block.append(header);

    if (editSegs.length === 0) {
      block.append($('<p/>')
        .addClass('lead-xs text-muted font-italic')
        .text(MSG_EMPTY));
      this._wireSortable(null);
      return block;
    }

    // Row 1: source-positioned ribbon (where each edit clip lives in the original).
    block.append(this._buildSourceRow(editSegs));

    // Row 2: playback-sequence ribbon (left-to-right in playback order).
    const sequenceRibbon = this._buildSequenceRow(editSegs);
    block.append(sequenceRibbon);

    this._wireSortable(sequenceRibbon.find('[data-role="edit-ribbon"]')[0]);
    return block;
  }

  _buildSourceRow(editSegs) {
    const wrap = $('<div/>').addClass('mb-2');
    wrap.append($('<p/>')
      .addClass('lead-xs mb-1 text-muted')
      .text('Source positions'));

    const dur = (this.$player && Number.isFinite(this.$player.duration)
      && this.$player.duration > 0)
      ? this.$player.duration
      : this.$totalSec;

    const ribbon = $('<div/>')
      .addClass('w-100 position-relative bg-light rounded')
      .css({ height: '24px', cursor: 'pointer' });

    editSegs.forEach((seg, idx) => {
      const start = Number(seg.startSec) || 0;
      const end = Number(seg.endSec) || 0;
      if (end <= start) return;

      const isSelected = idx === this.$state.selectedEditIndex;
      const isCustom = seg.kind === KIND_CUSTOM;

      const left = `${(start / dur) * 100}%`;
      const width = `${Math.max(0.5, ((end - start) / dur) * 100)}%`;

      const chip = $('<div/>')
        .addClass('position-absolute rounded d-flex align-items-center justify-content-center text-truncate')
        .attr('data-source-index', idx)
        .attr('title', `#${idx + 1} ${seg.title || (isCustom ? 'Custom' : '')} — ${_fmt(start)}→${_fmt(end)}`)
        .css({
          left,
          width,
          top: '2px',
          bottom: '2px',
          cursor: 'pointer',
          color: '#fff',
          fontSize: '10px',
          background: isSelected ? '#0d6efd' : '#28a745',
          border: isSelected ? '2px solid #0a58ca' : '1px solid rgba(0,0,0,0.2)',
          opacity: isSelected ? 1 : 0.85,
        })
        .text(`#${idx + 1}`);

      chip.on('click', (evt) => {
        evt.stopPropagation();
        this.$state.selectedEditIndex = idx;
        this.render();
        this._previewSegment(start, end);
      });

      ribbon.append(chip);
    });

    ribbon.on('click', (evt) => {
      const el = ribbon[0];
      const rect = el.getBoundingClientRect();
      const x = (evt.clientX != null ? evt.clientX
        : (evt.originalEvent && evt.originalEvent.touches
          ? evt.originalEvent.touches[0].clientX : 0)) - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      this._seekTo(ratio * dur);
    });

    wrap.append(ribbon);
    return wrap;
  }

  _buildSequenceRow(editSegs) {
    const wrap = $('<div/>').addClass('mb-1');
    wrap.append($('<p/>')
      .addClass('lead-xs mb-1 text-muted')
      .text('Playback sequence'));

    const ribbon = $('<div/>')
      .addClass('w-100 position-relative bg-light rounded d-flex flex-nowrap')
      .attr('data-role', 'edit-ribbon')
      .css({ height: '32px' });

    const totalEditSec = editSegs.reduce((acc, s) =>
      acc + Math.max(0, (Number(s.endSec) || 0) - (Number(s.startSec) || 0)), 0) || 1;

    editSegs.forEach((seg, idx) => {
      const segDur = Math.max(0, (Number(seg.endSec) || 0) - (Number(seg.startSec) || 0));
      const widthPct = Math.max(0.5, (segDur / totalEditSec) * 100);

      const isSelected = idx === this.$state.selectedEditIndex;
      const isCustom = seg.kind === KIND_CUSTOM;
      const label = `#${idx + 1} ${seg.title || (isCustom ? 'Custom' : '')}`.trim();

      const chip = $('<div/>')
        .addClass('edit-segment d-flex align-items-center justify-content-center text-truncate rounded px-1')
        .attr('data-edit-index', idx)
        .attr('title', `${label} — ${_fmt(segDur)} (source ${_fmt(seg.startSec)}→${_fmt(seg.endSec)})`)
        .css({
          flex: `0 0 calc(${widthPct}% - 2px)`,
          height: '28px',
          margin: '2px 1px',
          cursor: 'grab',
          color: '#fff',
          background: isSelected ? '#0d6efd' : '#28a745',
          border: isSelected ? '2px solid #0a58ca' : '1px solid rgba(0,0,0,0.15)',
          fontSize: '11px',
          minWidth: 0,
        })
        .text(label);

      chip.on('click', (evt) => {
        evt.stopPropagation();
        this.$state.selectedEditIndex = idx;
        this.render();
        this._previewSegment(seg.startSec, seg.endSec);
      });

      ribbon.append(chip);
    });

    const playhead = $('<div/>')
      .addClass('position-absolute')
      .css({
        top: '-2px',
        bottom: '-2px',
        left: '0%',
        width: '2px',
        background: '#dc3545',
        pointerEvents: 'none',
        zIndex: 10,
      });
    ribbon.append(playhead);
    this.$playhead = playhead;

    wrap.append(ribbon);
    setTimeout(() => this._updatePlayhead(), 0);
    return wrap;
  }

  _refreshChipLabels() {
    const editSegs = this.$state.editProject.segments;
    if (!editSegs) return;
    editSegs.forEach((seg, idx) => {
      const isCustom = seg.kind === KIND_CUSTOM;
      const label = `#${idx + 1} ${seg.title || (isCustom ? 'Custom' : '')}`.trim();
      const segDur = Math.max(0, (Number(seg.endSec) || 0) - (Number(seg.startSec) || 0));
      const seqChip = this.$tracks.find(`[data-edit-index="${idx}"]`);
      if (seqChip.length) {
        seqChip.text(label);
        seqChip.attr('title',
          `${label} — ${_fmt(segDur)} (source ${_fmt(seg.startSec)}→${_fmt(seg.endSec)})`);
      }
      const srcChip = this.$tracks.find(`[data-source-index="${idx}"]`);
      if (srcChip.length) {
        srcChip.attr('title',
          `#${idx + 1} ${seg.title || (isCustom ? 'Custom' : '')} — ${_fmt(seg.startSec)}→${_fmt(seg.endSec)}`);
      }
    });
  }

  _wireSortable(ribbonEl) {
    if (this.$sortable) {
      try { this.$sortable.destroy(); } catch (e) { /* noop */ }
      this.$sortable = null;
    }
    if (!ribbonEl || !_Sortable) return;
    this.$sortable = _Sortable.create(ribbonEl, {
      animation: 150,
      draggable: '.edit-segment',
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const segs = this.$state.editProject.segments;
        const [moved] = segs.splice(evt.oldIndex, 1);
        segs.splice(evt.newIndex, 0, moved);
        if (this.$state.selectedEditIndex === evt.oldIndex) {
          this.$state.selectedEditIndex = evt.newIndex;
        }
        this.render();
      },
    });
  }

  // ---------- Inspector ----------
  _renderInspector() {
    this.$inspector.empty();
    const wrap = $('<div/>').addClass('p-2 bg-light rounded');
    wrap.append($('<p/>').addClass('lead-s mb-2').text(MSG_INSPECTOR));

    const idx = this.$state.selectedEditIndex;
    const segs = this.$state.editProject.segments;
    const seg = (idx >= 0 && idx < segs.length) ? segs[idx] : null;

    if (!seg) {
      wrap.append($('<p/>')
        .addClass('lead-xs text-muted font-italic')
        .text(MSG_EMPTY));
    } else {
      const title = $('<input/>')
        .addClass('form-control form-control-sm mb-2 lead-xs')
        .attr('type', 'text')
        .attr('placeholder', 'Title')
        .val(seg.title || '');
      title.on('input', () => {
        seg.title = title.val();
        this._refreshChipLabels();
      });
      wrap.append($('<label/>').addClass('lead-xs mb-1').text('Title'));
      wrap.append(title);

      const reason = $('<textarea/>')
        .addClass('form-control form-control-sm mb-2 lead-xs')
        .attr('rows', 2)
        .attr('placeholder', 'Reason / notes')
        .val(seg.reason || '');
      reason.on('blur', () => {
        seg.reason = reason.val();
      });
      wrap.append($('<label/>').addClass('lead-xs mb-1').text('Reason'));
      wrap.append(reason);

      wrap.append($('<div/>').addClass('lead-xs text-muted mb-2')
        .text(`Duration: ${_fmt(seg.endSec - seg.startSec)}`));

      wrap.append(this._buildTimeEditor('In', seg, 'startSec'));
      wrap.append(this._buildTimeEditor('Out', seg, 'endSec'));

      const removeBtn = $('<button/>')
        .addClass('btn btn-outline-danger btn-sm d-block mt-2')
        .attr('type', 'button')
        .text(seg.kind === KIND_HIGHLIGHT ? MSG_DROP : MSG_REMOVE);
      removeBtn.on('click', () => {
        segs.splice(idx, 1);
        this.$state.selectedEditIndex = Math.min(idx, segs.length - 1);
        this.render();
      });
      wrap.append(removeBtn);
    }

    const divider = $('<hr/>');
    wrap.append(divider);

    const addBtn = $('<button/>')
      .addClass('btn btn-outline-primary btn-sm d-block')
      .attr('type', 'button')
      .text(MSG_ADD_CUSTOM);
    addBtn.on('click', () => {
      this._addCustomFromPlayhead();
    });
    wrap.append(addBtn);

    this.$inspector.append(wrap);
  }

  _buildTimeEditor(label, seg, field) {
    const isStart = field === 'startSec';
    const block = $('<div/>').addClass('mb-2 p-2 border rounded');

    block.append($('<div/>').addClass('lead-xs font-weight-bold mb-1').text(label));

    const inputRow = $('<div/>').addClass('d-flex align-items-center mb-1');

    const input = $('<input/>')
      .addClass('form-control form-control-sm lead-xs mr-1')
      .css({ width: '95px', fontVariantNumeric: 'tabular-nums' })
      .attr('type', 'text')
      .attr('inputmode', 'decimal')
      .attr('placeholder', 'MM:SS.mm')
      .val(_fmtTimeEdit(seg[field]));

    const commit = () => {
      const parsed = _parseTime(input.val());
      if (parsed == null) {
        input.val(_fmtTimeEdit(seg[field]));
        return;
      }
      this._updateSegmentTime(seg, field, parsed);
      this.render();
    };
    input.on('blur', commit);
    input.on('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        commit();
        input.blur();
      }
    });
    inputRow.append(input);

    const goBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-secondary mr-1')
      .attr('type', 'button')
      .html('⇥');
    goBtn.on('click', () => this._seekTo(seg[field]));
    inputRow.append(goBtn);

    const setBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-primary')
      .attr('type', 'button')
      .text(isStart ? MSG_IN : MSG_OUT);
    setBtn.on('click', () => {
      if (!this.$player) return;
      const t = Math.max(0, Math.floor((this.$player.currentTime || 0) * 100) / 100);
      this._updateSegmentTime(seg, field, t);
      this._renderInspector();
      this.render();
    });
    inputRow.append(setBtn);

    block.append(inputRow);

    const nudges = [-1, -0.1, 0.1, 1];
    const nudgeRow = $('<div/>').addClass('btn-group btn-group-sm');
    nudges.forEach((delta) => {
      const sign = delta > 0 ? '+' : '−';
      const mag = Math.abs(delta);
      const btn = $('<button/>')
        .addClass('btn btn-outline-secondary')
        .css({ minWidth: '52px', fontVariantNumeric: 'tabular-nums' })
        .attr('type', 'button')
        .text(`${sign}${mag}s`);
      btn.on('click', () => {
        const next = (seg[field] || 0) + delta;
        this._updateSegmentTime(seg, field, next);
        this._renderInspector();
        this.render();
        this._seekTo(seg[field]);
      });
      nudgeRow.append(btn);
    });
    block.append(nudgeRow);

    return block;
  }

  _updateSegmentTime(seg, field, value) {
    const dur = (this.$player && Number.isFinite(this.$player.duration))
      ? this.$player.duration
      : this.$totalSec;
    let v = Math.max(0, Number(value) || 0);
    if (Number.isFinite(dur) && dur > 0) {
      v = Math.min(v, dur);
    }
    if (field === 'startSec') {
      const maxStart = Math.max(0, (seg.endSec || 0) - 0.05);
      seg.startSec = Math.min(v, maxStart);
    } else {
      const minEnd = (seg.startSec || 0) + 0.05;
      seg.endSec = Math.max(v, minEnd);
    }
    seg.startSec = Math.round(seg.startSec * 100) / 100;
    seg.endSec = Math.round(seg.endSec * 100) / 100;
  }

  _restoreFromAuto(sourceIdx) {
    const src = (this.$highlightSet.segments || [])[sourceIdx];
    if (!src) return;
    const segs = this.$state.editProject.segments;
    segs.push({
      kind: KIND_HIGHLIGHT,
      sourceSegmentIndex: sourceIdx,
      startSec: Number(src.startSec) || 0,
      endSec: Number(src.endSec) || 0,
      title: src.title || '',
      reason: src.reason || '',
      highlightSetId: this.$highlightSet.highlightSetId,
    });
    this.$state.selectedEditIndex = segs.length - 1;
    this.render();
  }

  _addCustomFromPlayhead() {
    if (!this.$player) return;
    const cur = Math.max(0, Math.floor((this.$player.currentTime || 0) * 100) / 100);
    const dur = this.$player.duration || this.$totalSec;
    const startSec = cur;
    const endSec = Math.min(cur + 5, dur);
    if (endSec <= startSec) return;
    const segs = this.$state.editProject.segments;
    segs.push({
      kind: KIND_CUSTOM,
      startSec,
      endSec,
      title: 'Custom',
      reason: '',
    });
    this.$state.selectedEditIndex = segs.length - 1;
    this.render();
  }
}
