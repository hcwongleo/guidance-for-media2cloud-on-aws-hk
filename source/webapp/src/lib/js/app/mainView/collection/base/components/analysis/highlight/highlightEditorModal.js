// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Localization from '../../../../../../shared/localization.js';
import ApiHelper from '../../../../../../shared/apiHelper.js';
import Spinner from '../../../../../../shared/spinner.js';
import mxAlert from '../../../../../../mixins/mxAlert.js';
import EditorTracks from './editorTracks.js';

class AlertHelper extends mxAlert(class {}) {}
const _alertAgent = new AlertHelper();

const {
  Messages: {
    HighlightEditorTitle: MSG_TITLE,
  },
  Buttons: {
    SaveHighlightEdit: BTN_SAVE,
    CloseHighlightEditor: BTN_CLOSE,
  },
  Alerts: {
    Oops: OOPS,
    HighlightEditSaved: ALERT_SAVED,
    HighlightEditSaveFailed: ALERT_SAVE_FAILED,
    HighlightEditLoadFailed: ALERT_LOAD_FAILED,
    HighlightEditEmptyEdit: ALERT_EMPTY_EDIT,
  },
} = Localization;

function _id(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export default class HighlightEditorModal {
  constructor(previewComponent, highlightSet, options = {}) {
    this.$previewComponent = previewComponent;
    this.$highlightSet = highlightSet;
    this.$onSaved = typeof options.onSaved === 'function' ? options.onSaved : null;
    this.$state = null;
    this.$tracks = null;
    this.$modal = null;
    this.$ids = {
      modal: _id('he-modal'),
    };
  }

  get media() {
    return this.previewComponent.media;
  }

  get previewComponent() {
    return this.$previewComponent;
  }

  get highlightSet() {
    return this.$highlightSet;
  }

  get state() {
    return this.$state;
  }

  async open() {
    Spinner.loading(true);
    let editProject;
    let proxyUrl;
    try {
      proxyUrl = await this.media.getProxyVideo();
      editProject = await this._loadOrSeedEditProject();
    } catch (e) {
      console.error(e);
      Spinner.loading(false);
      const msg = (ALERT_LOAD_FAILED || '').replace('{{ERROR}}', (e && e.message) || '');
      throw new Error(msg);
    } finally {
      Spinner.loading(false);
    }

    this.$state = {
      editProject,
      proxyUrl,
      selectedEditIndex: editProject.segments.length > 0 ? 0 : -1,
    };

    this._buildDom();
    this.$modal.modal('show');
    if (this.$onSaved) {
      try {
        this.$onSaved(this.$state.editProject);
      } catch (cbErr) {
        console.error('onSaved callback failed:', cbErr);
      }
    }
  }

  async _loadOrSeedEditProject() {
    const editProjectId = this.highlightSet.highlightSetId;
    const uuid = this.media.uuid;

    let existing;
    try {
      existing = await ApiHelper.getEditProject(editProjectId);
    } catch (e) {
      existing = undefined;
    }

    if (existing && existing.editProjectId) {
      return existing;
    }

    // Older highlight sets (pre-v4.0.27) baked the rank into the title as
    // "#1 · Title". Strip that prefix so the editor's reel-order numbering
    // doesn't collide with the leftover rank prefix.
    const stripRankPrefix = (s) => (s || '').replace(/^#\d+\s*·\s*/, '').trim();
    const seedSegments = (this.highlightSet.segments || []).map((seg, i) => ({
      kind: 'highlight',
      sourceSegmentIndex: i,
      startSec: Number(seg.startSec) || 0,
      endSec: Number(seg.endSec) || 0,
      title: stripRankPrefix(seg.title),
      reason: seg.reason || '',
      rank: Number.isFinite(seg.rank) ? seg.rank : (i + 1),
      highlightSetId: editProjectId,
    }));

    return {
      editProjectId,
      uuid,
      name: this.highlightSet.name || `Edit ${editProjectId.slice(0, 8)}`,
      segments: seedSegments,
    };
  }

  _buildDom() {
    const ids = this.$ids;
    const ep = this.state.editProject;

    const modal = $(`
      <div class="modal fade" id="${ids.modal}" tabindex="-1" role="dialog"
           aria-hidden="true" data-backdrop="static">
        <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable" role="document">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"></h5>
              <button type="button" class="close" data-dismiss="modal" aria-label="Close">
                <span aria-hidden="true">&times;</span>
              </button>
            </div>
            <div class="modal-body">
              <div class="row">
                <div class="col-12 col-lg-8 px-2">
                  <style>
                    /*
                     * Hide the native <video controls> scrub bar — our
                     * source timeline below is the one true scrub surface.
                     * Volume/fullscreen/playback-rate stay intact.
                     * Webkit selectors cover Chromium browsers (Chrome,
                     * Edge, Brave, Arc, etc.), where most of our users live.
                     */
                    video[data-role="player"]::-webkit-media-controls-timeline,
                    video[data-role="player"]::-webkit-media-controls-current-time-display,
                    video[data-role="player"]::-webkit-media-controls-time-remaining-display {
                      display: none !important;
                    }
                    /* Seek spinner — overlays the video while the browser
                     * is mid-fetch on a seek. seeking → show, seeked → hide.
                     * Also hide when the buffer ahead is comfortable. */
                    .seek-spinner {
                      position: absolute;
                      top: 50%;
                      left: 50%;
                      transform: translate(-50%, -50%);
                      background: rgba(0,0,0,0.6);
                      color: #fff;
                      padding: 6px 12px;
                      border-radius: 4px;
                      font-size: 12px;
                      pointer-events: none;
                      z-index: 5;
                      display: none;
                    }
                  </style>
                  <div class="position-relative">
                    <video data-role="player" controls preload="auto"
                           class="w-100 bg-dark"
                           style="max-height:50vh;"></video>
                    <div data-role="seek-spinner" class="seek-spinner">
                      <span class="spinner-border spinner-border-sm align-middle mr-2"></span>
                      <span class="align-middle">Buffering…</span>
                    </div>
                  </div>
                  <div data-role="tracks" class="mt-3"></div>
                </div>
                <div class="col-12 col-lg-4 px-2">
                  <div data-role="inspector"></div>
                </div>
              </div>
              <p class="lead-xs text-muted mt-3 mb-0">
                Render and publish from the Output tab once you're happy with the segments.
              </p>
            </div>
            <div class="modal-footer flex-wrap">
              <button type="button" class="btn btn-secondary btn-sm"
                      data-dismiss="modal">${BTN_CLOSE}</button>
              <button type="button" class="btn btn-primary btn-sm" data-role="save">${BTN_SAVE}</button>
            </div>
          </div>
        </div>
      </div>
    `);

    const promptStr = (typeof this.highlightSet.prompt === 'string' ? this.highlightSet.prompt : '').trim();
    const promptTail = promptStr.length > 0
      ? ` · "${promptStr.length > 60 ? `${promptStr.slice(0, 60)}…` : promptStr}"`
      : '';
    // Model IDs are surfaced here (not in the dropdown label) so users can
    // see which video describer + ranker produced this set without making
    // the picker labels too long. Full IDs land in the tooltip.
    const modelTail = this._modelTail();
    const tooltipParts = [promptStr || '(default prompt)'];
    if (this.highlightSet.modelId) tooltipParts.push(`Video: ${this.highlightSet.modelId}`);
    if (this.highlightSet.rankModelId) tooltipParts.push(`Rank: ${this.highlightSet.rankModelId}`);
    modal.find('.modal-title')
      .text(`${MSG_TITLE} — ${ep.name}${modelTail}${promptTail}`)
      .attr('title', tooltipParts.join(' | '));

    const player = modal.find('video[data-role="player"]')[0];
    if (player && this.state.proxyUrl) {
      player.src = this.state.proxyUrl;
    }

    // Buffering overlay: the browser fires `seeking` when a seek begins,
    // `seeked` when it lands, and `waiting` whenever playback stalls for
    // buffer. We show the spinner on seeking/waiting, hide on seeked/playing.
    // 100ms grace prevents the spinner from flickering on near-instant seeks
    // within the cached range.
    const spinnerEl = modal.find('[data-role="seek-spinner"]');
    if (player && spinnerEl.length) {
      let showTimer = null;
      const showSoon = () => {
        if (showTimer) return;
        showTimer = setTimeout(() => { spinnerEl.css('display', 'block'); showTimer = null; }, 100);
      };
      const hideNow = () => {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        spinnerEl.css('display', 'none');
      };
      player.addEventListener('seeking', showSoon);
      player.addEventListener('waiting', showSoon);
      player.addEventListener('seeked', hideNow);
      player.addEventListener('playing', hideNow);
      player.addEventListener('canplay', hideNow);
      this.$spinnerCleanup = () => {
        player.removeEventListener('seeking', showSoon);
        player.removeEventListener('waiting', showSoon);
        player.removeEventListener('seeked', hideNow);
        player.removeEventListener('playing', hideNow);
        player.removeEventListener('canplay', hideNow);
        if (showTimer) clearTimeout(showTimer);
      };
    }

    modal.find('button[data-role="save"]').on('click', () => this._onSave());
    modal.on('hidden.bs.modal', () => this._onHidden());

    // Editor-style keyboard shortcuts: Space play/pause, ←/→ frame nudge,
    // Shift+←/→ ±1s. Bound document-wide while the modal is open and torn
    // down on hidden. Ignore when typing in inputs/textareas.
    this.$onKeyDown = (e) => this._onKeyDown(e);
    document.addEventListener('keydown', this.$onKeyDown);

    $('body').append(modal);
    this.$modal = modal;

    this.$tracks = new EditorTracks({
      tracksContainer: modal.find('div[data-role="tracks"]'),
      inspectorContainer: modal.find('div[data-role="inspector"]'),
      player,
      highlightSet: this.highlightSet,
      state: this.state,
    });
    this.$tracks.render();
  }

  _onKeyDown(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target && e.target.isContentEditable) return;
    const player = this.$modal && this.$modal.find('video[data-role="player"]')[0];
    if (!player) return;
    const FRAME_SEC = 1 / 25;
    const STEP = e.shiftKey ? 1.0 : FRAME_SEC;
    if (e.code === 'Space') {
      e.preventDefault();
      if (player.paused) player.play().catch(() => {});
      else player.pause();
      return;
    }
    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      player.currentTime = Math.max(0, (player.currentTime || 0) - STEP);
      return;
    }
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      const dur = Number.isFinite(player.duration) ? player.duration : Infinity;
      player.currentTime = Math.min(dur, (player.currentTime || 0) + STEP);
    }
  }

  // Compact "video › rank" suffix for the modal title. Keeps just the
  // last dot-separated segment of each model id, which is the human-
  // readable name (e.g. pegasus-1-2-v1:0, claude-haiku-4-5).
  _modelTail() {
    const tag = (id) => (id || '').split('.').pop() || '';
    const v = tag(this.highlightSet.modelId);
    const r = tag(this.highlightSet.rankModelId);
    if (!v && !r) return '';
    if (v && r) return ` · ${v} › ${r}`;
    return ` · ${v || r}`;
  }

  async _onSave() {
    const ep = this.state.editProject;
    if (!ep.segments || ep.segments.length === 0) {
      await _alertAgent.showMessage(this.$modal, 'warning', OOPS, ALERT_EMPTY_EDIT, 4000);
      return;
    }

    const payload = {
      uuid: ep.uuid,
      name: ep.name,
      segments: ep.segments.map((seg) => ({
        kind: seg.kind,
        startSec: Number(seg.startSec),
        endSec: Number(seg.endSec),
        title: seg.title || '',
        reason: seg.reason || '',
        ...(Number.isFinite(seg.rank) ? { rank: seg.rank } : {}),
        ...(seg.sourceSegmentIndex !== undefined
          ? { sourceSegmentIndex: seg.sourceSegmentIndex }
          : {}),
        ...(seg.highlightSetId
          ? { highlightSetId: seg.highlightSetId }
          : {}),
      })),
    };

    Spinner.loading(true);
    try {
      const saved = await ApiHelper.saveEditProject(ep.editProjectId, payload);
      this.$state.editProject = { ...ep, ...saved };
      if (this.$onSaved) {
        try {
          this.$onSaved(this.$state.editProject);
        } catch (cbErr) {
          console.error('onSaved callback failed:', cbErr);
        }
      }
      await _alertAgent.showMessage(this.$modal, 'success', '', ALERT_SAVED, 3000);
    } catch (e) {
      console.error(e);
      const msg = (ALERT_SAVE_FAILED || '').replace('{{ERROR}}', (e && e.message) || '');
      await _alertAgent.showMessage(this.$modal, 'danger', OOPS, msg, 6000);
    } finally {
      Spinner.loading(false);
    }
  }

  _onHidden() {
    if (this.$onKeyDown) {
      document.removeEventListener('keydown', this.$onKeyDown);
      this.$onKeyDown = null;
    }
    if (this.$spinnerCleanup) {
      this.$spinnerCleanup();
      this.$spinnerCleanup = null;
    }
    if (this.$tracks) {
      this.$tracks.destroy();
      this.$tracks = null;
    }
    if (this.$modal) {
      this.$modal.remove();
      this.$modal = null;
    }
  }
}
