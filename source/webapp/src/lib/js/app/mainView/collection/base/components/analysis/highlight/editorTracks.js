// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Localization from '../../../../../../shared/localization.js';
import BaseMedia from '../../../../../../shared/media/baseMedia.js';

const _interact = (typeof window !== 'undefined') ? window.interact : undefined;

// Snap tolerance in pixels — within this many px of a snap target we lock to it.
const SNAP_PX = 5;
// Hard floor on segment duration in seconds.
const MIN_SEG_SEC = 1.0;
// Width of the left/right grab strips on a chip, in px.
const TRIM_HANDLE_PX = 6;

const {
  Messages: {
    HighlightEditorInspector: MSG_INSPECTOR,
    HighlightEditorEmptyEdit: MSG_EMPTY,
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
    this.$totalSec = _totalSourceSec(highlightSet);
    // Editing mode: 'source' (work on the original video, drag chips to
    // move/trim) or 'reel' (preview the assembled reel, drag chips to
    // reorder). Each has its own timeline and own playhead semantics.
    this.$mode = 'source';
    // Active preview: auto-pause when the player crosses endSec.
    this.$previewEndSec = null;
    // Chained compilation playback: when set, advance to next segment instead of pausing.
    this.$compilationQueue = null;
    this.$compilationIndex = 0;
    this.$onTimeUpdate = () => {
      if (!this.$player) return;
      if (this.$previewEndSec != null
        && this.$player.currentTime >= this.$previewEndSec) {
        this._onSegmentBoundaryReached();
      }
      this._updateSourcePlayhead();
      this._updateReelPlayhead();
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
    if (this.$interact && _interact) {
      this.$interact.forEach((el) => {
        try { _interact(el).unset(); } catch (e) { /* noop */ }
      });
      this.$interact = [];
    }
    if (this.$player && this.$onTimeUpdate) {
      this.$player.removeEventListener('timeupdate', this.$onTimeUpdate);
    }
    if (this.$player && this.$onLoadedMetadata) {
      this.$player.removeEventListener('loadedmetadata', this.$onLoadedMetadata);
    }
    this.$previewEndSec = null;
    this.$compilationQueue = null;
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
    // Start as soon as the seek has landed (HAVE_CURRENT_DATA = readyState 2)
    // — the browser has the target frame. Waiting for HAVE_FUTURE_DATA
    // (readyState 3) means waiting for the browser to be confident it can
    // play forward smoothly, which adds many seconds on slow networks.
    // Playback may stutter for a moment but the user sees motion right
    // away. The browser's native buffering spinner covers any stutter.
    const onSeeked = () => {
      if (player.readyState >= 2) launch();
    };
    const onCanPlay = () => launch();
    const cleanup = () => {
      player.removeEventListener('seeked', onSeeked);
      player.removeEventListener('canplay', onCanPlay);
    };

    // Already at target with frame data — just play.
    if (Math.abs((player.currentTime || 0) - start) < 0.05
      && player.readyState >= 2) {
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
      // Move the playhead to the requested position immediately — the
      // native <video> element's buffering spinner covers the wait until
      // the frame catches up.
      this._updateSourcePlayhead();
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
      // Move the playhead to the requested position immediately so the user
      // sees the click landed even if the browser is still fetching bytes
      // for that timestamp. The native <video> element's own buffering
      // spinner covers the gap until the frame catches up; the timeupdate
      // event will overwrite this with the real currentTime once the seek
      // settles.
      this._updateSourcePlayhead();
    } catch (e) { /* noop */ }
  }

  render() {
    this.$tracks.empty();
    this.$tracks.append(this._buildEditTrack());
    this._renderInspector();
    // Source-ribbon interact.js bindings need the ribbon DOM to exist before
    // they can attach. _buildSourceRow set up this callback.
    if (this._pendingInteractWire) {
      const wire = this._pendingInteractWire;
      this._pendingInteractWire = null;
      wire();
    }
  }

  // Two-mode editor: 'source' (drag chips on the source timeline to move
  // and trim) or 'reel' (drag chips on the reel timeline to reorder).
  // The mode toggle is the primary control; spacebar / native play act on
  // whichever mode is active.
  _buildEditTrack() {
    const block = $('<div/>').addClass('mb-3');
    const editSegs = this.$state.editProject.segments;

    block.append(this._buildTransportRow(editSegs));

    if (editSegs.length === 0) {
      block.append($('<p/>')
        .addClass('lead-xs text-muted font-italic')
        .text(MSG_EMPTY));
      return block;
    }

    if (this.$mode === 'reel') {
      block.append(this._buildReelRow(editSegs));
    } else {
      block.append(this._buildSourceRow(editSegs));
    }
    return block;
  }

  _buildTransportRow(editSegs) {
    const row = $('<div/>').addClass('d-flex flex-wrap align-items-center mb-2');

    // Mode toggle: Source ↔ Reel. Bootstrap btn-group looks like one
    // segmented control with the active half filled.
    const group = $('<div/>')
      .addClass('btn-group btn-group-sm mr-3 mb-1')
      .attr('role', 'group')
      .attr('aria-label', 'Editor mode');
    const sourceBtn = $('<button/>')
      .attr('type', 'button')
      .addClass(this.$mode === 'source'
        ? 'btn btn-secondary' : 'btn btn-outline-secondary')
      .attr('title', 'Edit segments on the source video timeline')
      .text('Source');
    const reelBtn = $('<button/>')
      .attr('type', 'button')
      .addClass(this.$mode === 'reel'
        ? 'btn btn-secondary' : 'btn btn-outline-secondary')
      .attr('title', 'Preview and reorder the assembled reel')
      .prop('disabled', editSegs.length === 0)
      .text(`Reel${editSegs.length > 0 ? ` · ${_fmt(this._reelTotalSec(editSegs))}` : ''}`);
    sourceBtn.on('click', () => this._setMode('source'));
    reelBtn.on('click', () => this._setMode('reel'));
    group.append(sourceBtn).append(reelBtn);
    row.append(group);

    // Add @ playhead — only meaningful in source mode (where the playhead
    // is a real source-video position).
    const addBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .attr('type', 'button')
      .attr('title', this.$mode === 'source'
        ? 'Add a custom segment starting at the current playhead'
        : 'Switch to Source mode to add a segment')
      .prop('disabled', this.$mode !== 'source')
      .html('+ Add segment here');
    addBtn.on('click', () => this._addCustomFromPlayhead());
    row.append(addBtn);

    return row;
  }

  _reelTotalSec(editSegs) {
    return editSegs.reduce((acc, s) =>
      acc + Math.max(0, (Number(s.endSec) || 0) - (Number(s.startSec) || 0)), 0);
  }

  // Switch modes. Side effects: pause playback so the user is never left
  // mid-play in the now-inactive mode; reset compilation queue when leaving
  // reel mode; arm the compilation queue so spacebar/native play in reel
  // mode auto-advances through segments instead of playing the source.
  _setMode(next) {
    if (next === this.$mode) return;
    this.$mode = next;
    if (this.$player && !this.$player.paused) this.$player.pause();
    if (next === 'source') {
      this.$compilationQueue = null;
      this.$previewEndSec = null;
    } else {
      const segs = this.$state.editProject.segments || [];
      if (segs.length > 0) {
        // Park the player at segment #1 start so play picks up from there.
        this.$compilationQueue = segs.slice();
        this.$compilationIndex = 0;
        this.$previewEndSec = Number(segs[0].endSec) || 0;
        try {
          this.$player.currentTime = Number(segs[0].startSec) || 0;
        } catch (e) { /* noop */ }
      }
    }
    this.render();
  }

  _buildSourceRow(editSegs) {
    const wrap = $('<div/>').addClass('mb-3');
    wrap.append($('<p/>')
      .addClass('lead-s mb-1')
      .text('Source video'));

    const dur = (this.$player && Number.isFinite(this.$player.duration)
      && this.$player.duration > 0)
      ? this.$player.duration
      : this.$totalSec;

    // Time ruler: ticks every minute up to the source duration. Major
    // ticks every 60s with timecode labels; minor ticks every 15s.
    wrap.append(this._buildTimeRuler(dur));

    const ribbon = $('<div/>')
      .addClass('w-100 position-relative bg-light rounded')
      .attr('data-role', 'source-ribbon')
      .css({ height: '70px', cursor: 'pointer' });

    editSegs.forEach((seg, idx) => {
      const start = Number(seg.startSec) || 0;
      const end = Number(seg.endSec) || 0;
      if (end <= start) return;

      const isSelected = idx === this.$state.selectedEditIndex;
      const isCustom = seg.kind === KIND_CUSTOM;

      const left = `${(start / dur) * 100}%`;
      const width = `${Math.max(0.5, ((end - start) / dur) * 100)}%`;

      // Empty title only happens for custom segments — fall back to
      // "Custom" so the chip body isn't blank.
      const segTitle = (seg.title || (isCustom ? 'Custom' : '')).trim() || 'Custom';
      const chip = $('<div/>')
        .addClass('position-absolute rounded source-chip')
        .attr('data-source-index', idx)
        .attr('title', `${segTitle} — ${_fmt(start)}→${_fmt(end)}`)
        .css({
          left,
          width,
          top: '4px',
          bottom: '4px',
          color: '#fff',
          background: isSelected ? '#0d6efd' : '#28a745',
          border: isSelected ? '2px solid #0a58ca' : '1px solid rgba(0,0,0,0.2)',
          opacity: isSelected ? 1 : 0.9,
          touchAction: 'none',
          userSelect: 'none',
          overflow: 'hidden',
        });

      // Body — drag here to MOVE the segment. Two-line label inside:
      // title on top, "in→out · duration" below. The text-truncate keeps
      // long titles from breaking the chip width on narrow segments.
      const body = $('<div/>')
        .addClass('source-chip-body d-flex flex-column justify-content-center px-1')
        .css({
          position: 'absolute',
          left: `${TRIM_HANDLE_PX}px`,
          right: `${TRIM_HANDLE_PX}px`,
          top: '0',
          bottom: '0',
          cursor: 'grab',
          fontSize: '11px',
          lineHeight: '1.2',
          minWidth: 0,
        });
      body.append($('<div/>')
        .addClass('text-truncate font-weight-bold')
        .text(segTitle));
      body.append($('<div/>')
        .addClass('text-truncate')
        .css({ fontSize: '9px', opacity: 0.85 })
        .text(`${_fmt(start)} → ${_fmt(end)} · ${_fmt(end - start)}`));

      // Two thin grab strips at the edges — drag here to TRIM.
      const handleL = $('<div/>')
        .addClass('source-chip-handle source-chip-handle-l')
        .css({
          position: 'absolute',
          left: '0',
          top: '0',
          bottom: '0',
          width: `${TRIM_HANDLE_PX}px`,
          cursor: 'ew-resize',
          background: 'rgba(0,0,0,0.35)',
        });
      const handleR = $('<div/>')
        .addClass('source-chip-handle source-chip-handle-r')
        .css({
          position: 'absolute',
          right: '0',
          top: '0',
          bottom: '0',
          width: `${TRIM_HANDLE_PX}px`,
          cursor: 'ew-resize',
          background: 'rgba(0,0,0,0.35)',
        });

      chip.append(handleL).append(body).append(handleR);

      // Bind the click on the whole chip (not just the body) so narrow
      // chips — where the two trim handles cover most of the surface —
      // remain selectable. The interact.js drag handlers on body/handles
      // set chip.dataset.dragJustEnded so we can ignore the synthetic
      // click that follows a real drag.
      chip.on('click', (evt) => {
        if (chip[0].dataset.dragJustEnded === '1') {
          chip[0].dataset.dragJustEnded = '0';
          return;
        }
        evt.stopPropagation();
        this.$state.selectedEditIndex = idx;
        this.render();
        this._previewSegment(seg.startSec, seg.endSec);
      });

      ribbon.append(chip);
    });

    ribbon.on('click', (evt) => {
      // Background click only — segment drags/clicks are handled on the chip.
      if ($(evt.target).closest('.source-chip').length) return;
      const el = ribbon[0];
      const rect = el.getBoundingClientRect();
      const x = (evt.clientX != null ? evt.clientX : 0) - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      this._seekTo(ratio * dur);
    });

    // Vertical playhead — spans the source timeline, tracks the player's
    // currentTime. The outer 12px-wide bar is a grab target; the inner
    // 2px line is the visible cue. Drag the outer bar to scrub the source.
    const sourcePlayhead = $('<div/>')
      .attr('data-role', 'source-playhead')
      .css({
        position: 'absolute',
        top: '-4px',
        bottom: '-4px',
        left: '0%',
        width: '12px',
        marginLeft: '-6px',
        cursor: 'ew-resize',
        zIndex: 10,
        touchAction: 'none',
      });
    sourcePlayhead.append($('<div/>').css({
      position: 'absolute',
      top: '0',
      bottom: '0',
      left: '5px',
      width: '2px',
      background: '#dc3545',
      pointerEvents: 'none',
    }));
    ribbon.append(sourcePlayhead);
    this.$sourcePlayhead = sourcePlayhead;
    this.$sourceDur = dur;

    wrap.append(ribbon);
    // Wire interact.js after the chips are attached to the DOM by render().
    this._pendingInteractWire = () => {
      this._wireSourceInteract(ribbon[0], dur);
      this._wirePlayheadDrag(ribbon[0], sourcePlayhead[0], dur);
    };
    setTimeout(() => this._updateSourcePlayhead(), 0);
    return wrap;
  }

  // Drag the playhead bar to scrub the source video. Same pattern as the
  // chip drag: convert pixel delta to seconds via the ribbon's actual
  // width, set <video>.currentTime, and update the bar's CSS left so the
  // user sees the seek even while paused.
  _wirePlayheadDrag(ribbonEl, headEl, dur) {
    if (!_interact || !ribbonEl || !headEl) return;
    this.$interact = this.$interact || [];
    this.$interact.push(headEl);
    const pxPerSec = () => ribbonEl.getBoundingClientRect().width / Math.max(1, dur);
    _interact(headEl).draggable({
      listeners: {
        start: () => {
          this.$wasPlaying = this.$player && !this.$player.paused;
          if (this.$player && this.$wasPlaying) this.$player.pause();
          // While scrubbing manually, cancel any preview/compilation auto-pause.
          this.$previewEndSec = null;
          this.$compilationQueue = null;
        },
        move: (event) => {
          if (!this.$player) return;
          const next = (this.$player.currentTime || 0) + event.dx / pxPerSec();
          this.$player.currentTime = Math.max(0, Math.min(dur, next));
          this._updateSourcePlayhead();
        },
        end: () => {
          if (this.$player && this.$wasPlaying) this.$player.play().catch(() => {});
          this.$wasPlaying = false;
        },
      },
    });
  }

  // Time ruler over the source timeline. Major ticks every minute (with
  // timecode label); minor ticks every 15 s. Width scales with the player's
  // duration so ticks always align with the ribbon below.
  _buildTimeRuler(dur) {
    const ruler = $('<div/>')
      .addClass('w-100 position-relative')
      .css({ height: '14px', borderBottom: '1px solid #dee2e6' });
    if (!Number.isFinite(dur) || dur <= 0) return ruler;
    const majorEvery = 60;
    const minorEvery = 15;
    for (let t = 0; t <= dur; t += minorEvery) {
      const isMajor = (t % majorEvery) === 0;
      const tick = $('<div/>')
        .css({
          position: 'absolute',
          left: `${(t / dur) * 100}%`,
          top: isMajor ? '4px' : '8px',
          bottom: '0',
          width: '1px',
          background: isMajor ? '#6c757d' : '#adb5bd',
        });
      ruler.append(tick);
      if (isMajor) {
        const label = $('<div/>')
          .css({
            position: 'absolute',
            left: `${(t / dur) * 100}%`,
            top: '-1px',
            fontSize: '9px',
            color: '#6c757d',
            transform: 'translateX(-50%)',
            lineHeight: '1',
            paddingTop: '1px',
          })
          .text(_fmt(t));
        ruler.append(label);
      }
    }
    return ruler;
  }

  _updateSourcePlayhead() {
    if (!this.$sourcePlayhead || !this.$player) return;
    const dur = this.$sourceDur || (this.$player && this.$player.duration) || this.$totalSec;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const cur = this.$player.currentTime || 0;
    const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
    this.$sourcePlayhead.css('left', `${pct}%`);
  }

  // ---------- Reel timeline ----------
  // Each chip's width is its segment's duration. Chips are laid out in
  // segments[] order, which IS the playback order. Drag a chip body to
  // a new horizontal position → swap reel positions. Edge-drag is
  // intentionally not supported here (use Source mode to trim).
  _buildReelRow(editSegs) {
    const wrap = $('<div/>').addClass('mb-3');
    wrap.append($('<p/>')
      .addClass('lead-s mb-1')
      .text('Reel preview'));

    const totalSec = Math.max(1, this._reelTotalSec(editSegs));
    this.$reelTotalSec = totalSec;

    const ribbon = $('<div/>')
      .addClass('w-100 position-relative bg-light rounded')
      .attr('data-role', 'reel-ribbon')
      .css({ height: '70px', cursor: 'pointer' });

    let runningSec = 0;
    editSegs.forEach((seg, idx) => {
      const segDur = Math.max(0.001, (Number(seg.endSec) || 0) - (Number(seg.startSec) || 0));
      const leftPct = (runningSec / totalSec) * 100;
      const widthPct = Math.max(0.5, (segDur / totalSec) * 100);
      const isSelected = idx === this.$state.selectedEditIndex;
      const isCustom = seg.kind === KIND_CUSTOM;
      const titleStr = (seg.title || (isCustom ? 'Custom' : '')).trim() || 'Custom';

      const chip = $('<div/>')
        .addClass('position-absolute rounded reel-chip')
        .attr('data-reel-index', idx)
        .attr('title', `${titleStr} — ${_fmt(segDur)} (source ${_fmt(seg.startSec)}→${_fmt(seg.endSec)})`)
        .css({
          left: `${leftPct}%`,
          width: `calc(${widthPct}% - 2px)`,
          marginLeft: '1px',
          top: '4px',
          bottom: '4px',
          color: '#fff',
          background: isSelected ? '#0d6efd' : '#28a745',
          border: isSelected ? '2px solid #0a58ca' : '1px solid rgba(0,0,0,0.2)',
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
          overflow: 'hidden',
          padding: '2px 4px',
          fontSize: '11px',
          lineHeight: '1.2',
        });
      chip.append($('<div/>')
        .addClass('text-truncate font-weight-bold')
        .text(titleStr));
      chip.append($('<div/>')
        .addClass('text-truncate')
        .css({ fontSize: '9px', opacity: 0.85 })
        .text(_fmt(segDur)));

      chip.on('click', (evt) => {
        // Suppress click if the chip was just dragged — interact.js's drag
        // gesture still produces a synthetic click on release. The drag-end
        // handler sets dataset.dragJustEnded to '1' for one tick.
        if (chip[0].dataset.dragJustEnded === '1') {
          chip[0].dataset.dragJustEnded = '0';
          return;
        }
        evt.stopPropagation();
        this.$state.selectedEditIndex = idx;
        this._seekReelToSegment(idx);
        this.render();
      });

      ribbon.append(chip);
      runningSec += segDur;
    });

    // Reel playhead — vertical line inside the ribbon. Driven by
    // `currentTime` mapped through compilation state into a reel offset.
    const reelPlayhead = $('<div/>')
      .attr('data-role', 'reel-playhead')
      .css({
        position: 'absolute',
        top: '-4px',
        bottom: '-4px',
        left: '0%',
        width: '12px',
        marginLeft: '-6px',
        cursor: 'ew-resize',
        zIndex: 10,
        touchAction: 'none',
      });
    reelPlayhead.append($('<div/>').css({
      position: 'absolute',
      top: '0',
      bottom: '0',
      left: '5px',
      width: '2px',
      background: '#dc3545',
      pointerEvents: 'none',
    }));
    ribbon.append(reelPlayhead);
    this.$reelPlayhead = reelPlayhead;

    // Click empty ribbon = scrub the reel to that point.
    ribbon.on('click', (evt) => {
      if ($(evt.target).closest('.reel-chip').length) return;
      const rect = ribbon[0].getBoundingClientRect();
      const x = (evt.clientX != null ? evt.clientX : 0) - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      this._seekReelToOffset(ratio * totalSec);
    });

    wrap.append(ribbon);
    this._pendingInteractWire = () => this._wireReelInteract(ribbon[0], editSegs);
    setTimeout(() => this._updateReelPlayhead(), 0);
    return wrap;
  }

  // Map currentTime + compilationIndex → reel offset, then to ribbon X%.
  _updateReelPlayhead() {
    if (!this.$reelPlayhead || !this.$player) return;
    const segs = this.$state.editProject.segments || [];
    if (segs.length === 0) return;
    const totalSec = this.$reelTotalSec || this._reelTotalSec(segs);
    if (totalSec <= 0) return;

    let activeIdx = (typeof this.$compilationIndex === 'number' && this.$compilationQueue)
      ? this.$compilationIndex
      : -1;
    if (activeIdx < 0) {
      activeIdx = this.$state.selectedEditIndex >= 0
        ? this.$state.selectedEditIndex
        : 0;
    }
    activeIdx = Math.max(0, Math.min(segs.length - 1, activeIdx));
    const seg = segs[activeIdx];
    const segStart = Number(seg.startSec) || 0;
    const segEnd = Number(seg.endSec) || 0;
    const cur = this.$player.currentTime || 0;
    const offsetWithin = (this.$compilationQueue && cur >= segStart && cur < segEnd)
      ? (cur - segStart)
      : 0;

    let runningSec = 0;
    for (let i = 0; i < activeIdx; i += 1) {
      runningSec += Math.max(0, (Number(segs[i].endSec) || 0) - (Number(segs[i].startSec) || 0));
    }
    const reelPos = runningSec + offsetWithin;
    const pct = Math.max(0, Math.min(100, (reelPos / totalSec) * 100));
    this.$reelPlayhead.css('left', `${pct}%`);
  }

  // Seek the player to a position N seconds into the reel.
  _seekReelToOffset(reelOffsetSec) {
    const segs = this.$state.editProject.segments || [];
    if (segs.length === 0) return;
    let acc = 0;
    for (let i = 0; i < segs.length; i += 1) {
      const segDur = Math.max(0, (Number(segs[i].endSec) || 0) - (Number(segs[i].startSec) || 0));
      // Strict `<` so a click exactly at the boundary between segs[i-1]
      // and segs[i] lands on segs[i], not the segment that ended there.
      if (reelOffsetSec < acc + segDur || i === segs.length - 1) {
        this._jumpToSegment(i, Math.max(0, reelOffsetSec - acc));
        return;
      }
      acc += segDur;
    }
  }

  _seekReelToSegment(idx) {
    const segs = this.$state.editProject.segments || [];
    if (idx < 0 || idx >= segs.length) return;
    // Direct jump — don't route through offset math, the boundary case
    // there is fragile.
    this._jumpToSegment(idx, 0);
  }

  // Set up compilation playback to play segs[idx] starting `within` seconds
  // into it, and seek the player accordingly.
  _jumpToSegment(idx, within) {
    const segs = this.$state.editProject.segments || [];
    if (idx < 0 || idx >= segs.length) return;
    const seg = segs[idx];
    this.$compilationQueue = segs.slice();
    this.$compilationIndex = idx;
    this.$previewEndSec = Number(seg.endSec) || 0;
    const target = (Number(seg.startSec) || 0) + Math.max(0, within || 0);
    try {
      this.$player.currentTime = target;
      this._updateReelPlayhead();
      this._updateSourcePlayhead();
    } catch (e) { /* noop */ }
  }

  _wireReelInteract(ribbonEl, editSegs) {
    if (!_interact || !ribbonEl) return;
    if (this.$interact && this.$interact.length) {
      this.$interact.forEach((el) => {
        try { _interact(el).unset(); } catch (e) { /* noop */ }
      });
    }
    this.$interact = [];

    const chips = ribbonEl.querySelectorAll('.reel-chip');
    chips.forEach((chipEl) => {
      this.$interact.push(chipEl);
      _interact(chipEl).draggable({
        listeners: {
          start: () => {
            chipEl.style.cursor = 'grabbing';
            chipEl.style.zIndex = '20';
            chipEl.style.opacity = '0.85';
            chipEl.dataset.translateX = '0';
            chipEl.dataset.dragMoved = '0';
          },
          move: (event) => {
            const dx = (parseFloat(chipEl.dataset.translateX) || 0) + event.dx;
            chipEl.dataset.translateX = String(dx);
            chipEl.dataset.dragMoved = '1';
            chipEl.style.transform = `translateX(${dx}px)`;
          },
          end: () => {
            const moved = chipEl.dataset.dragMoved === '1';
            // Capture geometry while the transform is still applied so we
            // know where the user actually dragged the chip *to*. Resetting
            // the transform before measuring would read the chip's home
            // position and reorder would never trigger.
            const dragRect = chipEl.getBoundingClientRect();
            const dragCenter = dragRect.left + dragRect.width / 2;

            chipEl.style.cursor = 'grab';
            chipEl.style.zIndex = '';
            chipEl.style.opacity = '';
            chipEl.style.transform = '';
            chipEl.dataset.translateX = '0';

            if (!moved) return;
            // Tell the click handler to ignore the synthetic click that
            // comes immediately after this drag-end.
            chipEl.dataset.dragJustEnded = '1';
            setTimeout(() => { chipEl.dataset.dragJustEnded = '0'; }, 50);

            const fromIdx = Number(chipEl.dataset.reelIndex);
            const others = Array.from(ribbonEl.querySelectorAll('.reel-chip'))
              .filter((el) => el !== chipEl)
              .map((el) => ({
                idx: Number(el.dataset.reelIndex),
                center: el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2,
              }));
            // How many other chips' centers did the dragged chip pass?
            // The new index is the count of "others" whose center is
            // strictly to the left of dragCenter.
            const passedLeft = others.filter((o) => o.center < dragCenter).length;
            const toIdx = passedLeft;
            if (toIdx === fromIdx) return;

            const segs = this.$state.editProject.segments;
            const [movedSeg] = segs.splice(fromIdx, 1);
            segs.splice(toIdx, 0, movedSeg);
            if (this.$state.selectedEditIndex === fromIdx) {
              this.$state.selectedEditIndex = toIdx;
            } else if (fromIdx < this.$state.selectedEditIndex && toIdx >= this.$state.selectedEditIndex) {
              this.$state.selectedEditIndex -= 1;
            } else if (fromIdx > this.$state.selectedEditIndex && toIdx <= this.$state.selectedEditIndex) {
              this.$state.selectedEditIndex += 1;
            }
            this.render();
          },
        },
      });
    });

    // Playhead drag = scrub the reel.
    const head = this.$reelPlayhead && this.$reelPlayhead[0];
    if (head) {
      this.$interact.push(head);
      const totalSec = this.$reelTotalSec || 1;
      const pxPerSec = () => ribbonEl.getBoundingClientRect().width / Math.max(1, totalSec);
      _interact(head).draggable({
        listeners: {
          start: () => {
            this.$wasPlaying = this.$player && !this.$player.paused;
            if (this.$player && this.$wasPlaying) this.$player.pause();
          },
          move: (event) => {
            const rect = ribbonEl.getBoundingClientRect();
            const headRect = head.getBoundingClientRect();
            const xWithin = (headRect.left + headRect.width / 2 - rect.left) + event.dx;
            const ratio = Math.max(0, Math.min(1, xWithin / rect.width));
            this._seekReelToOffset(ratio * totalSec);
          },
          end: () => {
            if (this.$player && this.$wasPlaying) this.$player.play().catch(() => {});
            this.$wasPlaying = false;
          },
        },
      });
    }
  }

  // Bind interact.js drag (body) and resizable (edges) on each source chip.
  // We update seg.startSec/endSec live during the gesture and only call
  // render() on `end` — keeps the drag smooth without re-creating the DOM
  // every frame. The inspector's timecode inputs are kept in sync via the
  // inline updater so the user sees the values change as they drag.
  _wireSourceInteract(ribbonEl, dur) {
    if (!_interact || !ribbonEl) return;

    // Tear down any prior bindings — render() rebuilds the ribbon.
    if (this.$interact && this.$interact.length) {
      this.$interact.forEach((el) => {
        try { _interact(el).unset(); } catch (e) { /* noop */ }
      });
    }
    this.$interact = [];

    const chips = ribbonEl.querySelectorAll('.source-chip');
    chips.forEach((chipEl) => {
      this.$interact.push(chipEl);
      const idxOf = () => Number(chipEl.dataset.sourceIndex);
      const segOf = () => this.$state.editProject.segments[idxOf()];
      const ribbonRect = () => ribbonEl.getBoundingClientRect();
      const pxPerSec = () => ribbonRect().width / Math.max(1, dur);

      // Build the listener for one drag mode. dStartFn / dEndFn say which
      // of startSec / endSec the gesture changes (per pixel of dx).
      const buildListeners = (dStartMul, dEndMul) => ({
        start: () => {
          chipEl.style.zIndex = '5';
          chipEl.dataset.dragMoved = '0';
        },
        move: (event) => {
          const seg = segOf();
          if (!seg) return;
          chipEl.dataset.dragMoved = '1';
          const deltaSec = event.dx / pxPerSec();
          this._applyDragDelta(seg, deltaSec * dStartMul, deltaSec * dEndMul, dur);
          this._updateChipGeometry(chipEl, seg, dur);
          this._updateInspectorInputs(seg);
        },
        end: () => {
          chipEl.style.zIndex = '';
          this._clampSegment(segOf(), dur);
          // Suppress the synthetic click that follows a real drag, so the
          // chip's click handler doesn't trigger select-and-preview after
          // the user just moved/trimmed the chip.
          if (chipEl.dataset.dragMoved === '1') {
            chipEl.dataset.dragJustEnded = '1';
            setTimeout(() => { chipEl.dataset.dragJustEnded = '0'; }, 50);
          }
          this.render();
        },
      });

      // Drag the body — translate startSec & endSec together.
      const bodyEl = chipEl.querySelector('.source-chip-body');
      _interact(bodyEl).draggable({ listeners: buildListeners(1, 1) });

      // Drag the edges — resize start or end independently.
      const handleL = chipEl.querySelector('.source-chip-handle-l');
      const handleR = chipEl.querySelector('.source-chip-handle-r');
      _interact(handleL).draggable({ listeners: buildListeners(1, 0) });
      _interact(handleR).draggable({ listeners: buildListeners(0, 1) });
    });
  }

  // Apply a delta in seconds to seg.startSec and/or seg.endSec, snapping
  // to the playhead and neighbor edges. Hard floor on duration (MIN_SEG_SEC).
  _applyDragDelta(seg, dStart, dEnd, dur) {
    let nextStart = (Number(seg.startSec) || 0) + dStart;
    let nextEnd = (Number(seg.endSec) || 0) + dEnd;

    // Clamp into [0, dur].
    nextStart = Math.max(0, Math.min(dur, nextStart));
    nextEnd = Math.max(0, Math.min(dur, nextEnd));

    // Hard floor: keep at least MIN_SEG_SEC apart.
    if (nextEnd - nextStart < MIN_SEG_SEC) {
      if (dStart !== 0 && dEnd === 0) nextStart = nextEnd - MIN_SEG_SEC;
      else if (dEnd !== 0 && dStart === 0) nextEnd = nextStart + MIN_SEG_SEC;
      else nextEnd = nextStart + MIN_SEG_SEC;
    }

    // Snap each moving edge to the nearest snap target.
    const snaps = this._snapTargets(seg);
    if (dStart !== 0) nextStart = this._snap(nextStart, snaps, dur);
    if (dEnd !== 0) nextEnd = this._snap(nextEnd, snaps, dur);

    // Re-enforce the floor after snapping.
    if (nextEnd - nextStart < MIN_SEG_SEC) {
      if (dStart !== 0) nextStart = nextEnd - MIN_SEG_SEC;
      else nextEnd = nextStart + MIN_SEG_SEC;
    }

    seg.startSec = nextStart;
    seg.endSec = nextEnd;
  }

  // Snap targets: current playhead + every other segment's start/end.
  _snapTargets(self) {
    const out = [];
    if (this.$player && Number.isFinite(this.$player.currentTime)) {
      out.push(this.$player.currentTime);
    }
    const segs = this.$state.editProject.segments || [];
    segs.forEach((s) => {
      if (s === self) return;
      out.push(Number(s.startSec) || 0);
      out.push(Number(s.endSec) || 0);
    });
    return out;
  }

  _snap(valSec, targets, dur) {
    if (!targets || targets.length === 0) return valSec;
    // Tolerance in seconds: SNAP_PX projected through current ribbon scale.
    const ribbonEl = this.$tracks.find('[data-role="source-ribbon"]')[0];
    if (!ribbonEl) return valSec;
    const tolSec = SNAP_PX / (ribbonEl.getBoundingClientRect().width / Math.max(1, dur));
    let bestVal = valSec;
    let bestDelta = tolSec;
    for (const t of targets) {
      const d = Math.abs(t - valSec);
      if (d < bestDelta) { bestDelta = d; bestVal = t; }
    }
    return bestVal;
  }

  _updateChipGeometry(chipEl, seg, dur) {
    const start = Number(seg.startSec) || 0;
    const end = Number(seg.endSec) || 0;
    chipEl.style.left = `${(start / dur) * 100}%`;
    chipEl.style.width = `${Math.max(0.5, ((end - start) / dur) * 100)}%`;
  }

  _clampSegment(seg, dur) {
    if (!seg) return;
    seg.startSec = Math.max(0, Math.min(dur, Number(seg.startSec) || 0));
    seg.endSec = Math.max(0, Math.min(dur, Number(seg.endSec) || 0));
    if (seg.endSec - seg.startSec < MIN_SEG_SEC) {
      seg.endSec = Math.min(dur, seg.startSec + MIN_SEG_SEC);
      if (seg.endSec - seg.startSec < MIN_SEG_SEC) {
        seg.startSec = Math.max(0, seg.endSec - MIN_SEG_SEC);
      }
    }
  }

  _updateInspectorInputs(seg) {
    if (!seg) return;
    const idx = this.$state.editProject.segments.indexOf(seg);
    if (idx < 0) return;
    const inSec = $(this.$inspector).find(`[data-role="inspector-in"][data-idx="${idx}"]`);
    const outSec = $(this.$inspector).find(`[data-role="inspector-out"][data-idx="${idx}"]`);
    if (inSec.length) inSec.val(_fmtTimeEdit(seg.startSec));
    if (outSec.length) outSec.val(_fmtTimeEdit(seg.endSec));
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
        .text('Click a segment on the timeline to edit it.'));
      this.$inspector.append(wrap);
      return;
    }

    // Header line: "Reel position #N of M" + AI rank badge + reorder/drop.
    const headerRow = $('<div/>').addClass('d-flex align-items-center mb-2');
    headerRow.append($('<span/>')
      .addClass('lead-xs font-weight-bold mr-2')
      .text(`Reel #${idx + 1} of ${segs.length}`));
    if (Number.isFinite(seg.rank)) {
      headerRow.append($('<span/>')
        .addClass('badge badge-info mr-2')
        .css({ fontSize: '10px', fontWeight: 'normal' })
        .attr('title', 'Rank by AI relevance to your prompt — 1 is the strongest match. Stays the same when you reorder for the reel.')
        .text(`AI rank #${seg.rank}`));
    }

    // Reorder lives on the Reel timeline (drag chips left/right). No
    // ▲/▼ buttons here — keeps the inspector focused on per-segment
    // metadata + in/out.

    const removeBtn = $('<button/>')
      .addClass('btn btn-outline-danger btn-sm py-0 px-2 ml-auto')
      .attr('type', 'button')
      .text(seg.kind === KIND_HIGHLIGHT ? MSG_DROP : MSG_REMOVE);
    removeBtn.on('click', () => {
      segs.splice(idx, 1);
      this.$state.selectedEditIndex = Math.min(idx, segs.length - 1);
      this.render();
    });
    headerRow.append(removeBtn);
    wrap.append(headerRow);

    const title = $('<input/>')
      .addClass('form-control form-control-sm mb-2 lead-xs')
      .attr('type', 'text')
      .attr('placeholder', 'Title')
      .val(seg.title || '');
    title.on('input', () => {
      seg.title = title.val();
      // Update the affected timeline chip's tooltip + body line in place;
      // a full render() would steal focus from this input mid-typing.
      const isCustom = seg.kind === KIND_CUSTOM;
      const titleStr = (seg.title || (isCustom ? 'Custom' : '')).trim() || 'Custom';
      const srcChip = this.$tracks.find(`[data-source-index="${idx}"]`);
      if (srcChip.length) {
        srcChip.attr('title',
          `${titleStr} — ${_fmt(seg.startSec)}→${_fmt(seg.endSec)}`);
        srcChip.find('.source-chip-body > div:first-child').text(titleStr);
      }
      const reelChip = this.$tracks.find(`[data-reel-index="${idx}"]`);
      if (reelChip.length) {
        const segDur = Math.max(0, (Number(seg.endSec) || 0) - (Number(seg.startSec) || 0));
        reelChip.attr('title',
          `${titleStr} — ${_fmt(segDur)} (source ${_fmt(seg.startSec)}→${_fmt(seg.endSec)})`);
        reelChip.find('div:first-child').text(titleStr);
      }
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

    wrap.append(this._buildTimeEditor('In', seg, 'startSec', idx));
    wrap.append(this._buildTimeEditor('Out', seg, 'endSec', idx));

    this.$inspector.append(wrap);
  }

  _buildTimeEditor(label, seg, field, idx) {
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
      .attr('data-role', isStart ? 'inspector-in' : 'inspector-out')
      .attr('data-idx', String(idx))
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
