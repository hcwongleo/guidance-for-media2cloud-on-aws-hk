// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Localization from '../../../../../../shared/localization.js';
import BaseMedia from '../../../../../../shared/media/baseMedia.js';

const _Sortable = (typeof window !== 'undefined') ? window.Sortable : undefined;

const {
  Messages: {
    HighlightEditorSourceTrack: MSG_SRC,
    HighlightEditorAutoTrack: MSG_AUTO,
    HighlightEditorEditTrack: MSG_EDIT,
    HighlightEditorInspector: MSG_INSPECTOR,
    HighlightEditorEmptyEdit: MSG_EMPTY,
    HighlightEditorAddCustom: MSG_ADD_CUSTOM,
    HighlightEditorIn: MSG_IN,
    HighlightEditorOut: MSG_OUT,
    HighlightEditorDrop: MSG_DROP,
    HighlightEditorRestore: MSG_RESTORE,
    HighlightEditorRemove: MSG_REMOVE,
    HighlightEditorMoveUp: MSG_UP,
    HighlightEditorMoveDown: MSG_DOWN,
  },
} = Localization;

const KIND_HIGHLIGHT = 'highlight';
const KIND_CUSTOM = 'custom';

function _fmt(sec) {
  return BaseMedia.readableDuration(Math.max(0, Number(sec) || 0) * 1000);
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
  }

  destroy() {
    if (this.$sortable) {
      try { this.$sortable.destroy(); } catch (e) { /* noop */ }
      this.$sortable = null;
    }
    this.$tracks.empty();
    this.$inspector.empty();
  }

  render() {
    this.$tracks.empty();
    this.$tracks.append(this._buildSourceTrack());
    this.$tracks.append(this._buildAutoTrack());
    this.$tracks.append(this._buildEditTrack());
    this._renderInspector();
  }

  // ---------- Source ribbon ----------
  _buildSourceTrack() {
    const block = $('<div/>').addClass('mb-3');
    block.append($('<p/>').addClass('lead-xs mb-1 text-muted').text(MSG_SRC));
    const ribbon = $('<div/>')
      .addClass('w-100 bg-secondary rounded')
      .css({ height: '8px' });
    block.append(ribbon);
    return block;
  }

  // ---------- Auto-highlights ribbon ----------
  _buildAutoTrack() {
    const block = $('<div/>').addClass('mb-3');
    block.append($('<p/>').addClass('lead-xs mb-1 text-muted').text(MSG_AUTO));

    const ribbon = $('<div/>')
      .addClass('w-100 position-relative bg-light rounded')
      .css({ height: '20px' });
    block.append(ribbon);

    const total = this.$totalSec;
    const segs = this.$highlightSet.segments || [];
    const editSegs = this.$state.editProject.segments;

    segs.forEach((seg, i) => {
      const start = Number(seg.startSec) || 0;
      const end = Number(seg.endSec) || 0;
      const inEdit = editSegs.some((es) =>
        es.kind === KIND_HIGHLIGHT && es.sourceSegmentIndex === i);

      const left = `${(start / total) * 100}%`;
      const width = `${Math.max(0.5, ((end - start) / total) * 100)}%`;

      const chip = $('<div/>')
        .addClass('position-absolute rounded')
        .attr('data-toggle', 'tooltip')
        .attr('title', `${seg.title || `#${i + 1}`} — ${_fmt(start)}–${_fmt(end)}`)
        .css({
          left,
          width,
          top: '2px',
          bottom: '2px',
          cursor: 'pointer',
          background: inEdit ? '#28a745' : 'transparent',
          border: inEdit ? '1px solid #1e7e34' : '1px dashed #6c757d',
          opacity: inEdit ? 0.85 : 0.5,
        });

      chip.on('click', () => {
        if (this.$player) {
          try { this.$player.currentTime = start; } catch (e) { /* noop */ }
        }
        if (!inEdit) {
          this._restoreFromAuto(i);
        } else {
          // select the corresponding edit segment
          const idx = editSegs.findIndex((es) =>
            es.kind === KIND_HIGHLIGHT && es.sourceSegmentIndex === i);
          if (idx >= 0) {
            this.$state.selectedEditIndex = idx;
            this._renderInspector();
          }
        }
      });

      ribbon.append(chip);
    });

    return block;
  }

  // ---------- Edit ribbon (sortable) ----------
  _buildEditTrack() {
    const block = $('<div/>').addClass('mb-3');
    block.append($('<p/>').addClass('lead-xs mb-1 text-muted').text(MSG_EDIT));

    const editSegs = this.$state.editProject.segments;
    if (editSegs.length === 0) {
      block.append($('<p/>')
        .addClass('lead-xs text-muted font-italic')
        .text(MSG_EMPTY));
      this._wireSortable(null);
      return block;
    }

    const ribbon = $('<div/>')
      .addClass('w-100 d-flex flex-wrap')
      .attr('data-role', 'edit-ribbon')
      .css({ minHeight: '36px', gap: '4px' });
    block.append(ribbon);

    const totalEditSec = editSegs.reduce((acc, s) =>
      acc + Math.max(0, (Number(s.endSec) || 0) - (Number(s.startSec) || 0)), 0) || 1;

    editSegs.forEach((seg, idx) => {
      const dur = Math.max(0, (Number(seg.endSec) || 0) - (Number(seg.startSec) || 0));
      const widthPct = Math.max(6, (dur / totalEditSec) * 100);
      const isSelected = idx === this.$state.selectedEditIndex;
      const isCustom = seg.kind === KIND_CUSTOM;

      const chip = $('<div/>')
        .addClass('edit-segment d-flex align-items-center justify-content-center text-truncate rounded px-2')
        .attr('data-edit-index', idx)
        .attr('title', `${seg.title || (isCustom ? 'Custom' : `#${idx + 1}`)} — ${_fmt(dur)}`)
        .css({
          flexBasis: `${widthPct}%`,
          height: '28px',
          cursor: 'grab',
          color: '#fff',
          background: isSelected
            ? '#0d6efd'
            : (isCustom ? '#fd7e14' : '#28a745'),
          border: isSelected ? '2px solid #0a58ca' : '1px solid rgba(0,0,0,0.15)',
          fontSize: '11px',
        })
        .text(seg.title || (isCustom ? 'Custom' : `#${idx + 1}`));

      chip.on('click', (evt) => {
        evt.stopPropagation();
        this.$state.selectedEditIndex = idx;
        if (this.$player) {
          try { this.$player.currentTime = Number(seg.startSec) || 0; } catch (e) { /* noop */ }
        }
        this.render();
      });

      ribbon.append(chip);
    });

    this._wireSortable(ribbon[0]);
    return block;
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
      title.on('blur', () => {
        seg.title = title.val();
      });
      wrap.append($('<label/>').addClass('lead-xs mb-1').text('Title'));
      wrap.append(title);

      if (seg.reason) {
        wrap.append($('<p/>')
          .addClass('lead-xs text-muted mb-2')
          .text(seg.reason));
      }

      const timeRow = $('<div/>').addClass('mb-2');
      timeRow.append($('<span/>').addClass('lead-xs mr-2')
        .text(`${_fmt(seg.startSec)} → ${_fmt(seg.endSec)} (${_fmt(seg.endSec - seg.startSec)})`));
      wrap.append(timeRow);

      const inOutRow = $('<div/>').addClass('btn-group btn-group-sm mb-2');
      const inBtn = $('<button/>').addClass('btn btn-outline-secondary')
        .attr('type', 'button').text(MSG_IN);
      const outBtn = $('<button/>').addClass('btn btn-outline-secondary')
        .attr('type', 'button').text(MSG_OUT);
      inBtn.on('click', () => {
        if (!this.$player) return;
        const t = Math.max(0, Math.floor((this.$player.currentTime || 0) * 100) / 100);
        if (t < seg.endSec) {
          seg.startSec = t;
          this._renderInspector();
          this.render();
        }
      });
      outBtn.on('click', () => {
        if (!this.$player) return;
        const t = Math.max(0, Math.floor((this.$player.currentTime || 0) * 100) / 100);
        if (t > seg.startSec) {
          seg.endSec = t;
          this._renderInspector();
          this.render();
        }
      });
      inOutRow.append(inBtn).append(outBtn);
      wrap.append(inOutRow);

      const moveRow = $('<div/>').addClass('btn-group btn-group-sm mb-2 ml-2');
      const upBtn = $('<button/>').addClass('btn btn-outline-secondary')
        .attr('type', 'button').text(MSG_UP)
        .prop('disabled', idx <= 0);
      const downBtn = $('<button/>').addClass('btn btn-outline-secondary')
        .attr('type', 'button').text(MSG_DOWN)
        .prop('disabled', idx >= segs.length - 1);
      upBtn.on('click', () => {
        if (idx <= 0) return;
        [segs[idx - 1], segs[idx]] = [segs[idx], segs[idx - 1]];
        this.$state.selectedEditIndex = idx - 1;
        this.render();
      });
      downBtn.on('click', () => {
        if (idx >= segs.length - 1) return;
        [segs[idx + 1], segs[idx]] = [segs[idx], segs[idx + 1]];
        this.$state.selectedEditIndex = idx + 1;
        this.render();
      });
      moveRow.append(upBtn).append(downBtn);
      wrap.append(moveRow);

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
