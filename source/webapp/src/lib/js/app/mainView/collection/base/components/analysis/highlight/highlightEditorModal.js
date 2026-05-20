// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Localization from '../../../../../../shared/localization.js';
import ApiHelper from '../../../../../../shared/apiHelper.js';
import Spinner from '../../../../../../shared/spinner.js';
import mxAlert from '../../../../../../mixins/mxAlert.js';
import {
  RegisterIotMessageEvent,
  UnregisterIotMessageEvent,
} from '../../../../../../shared/iotSubscriber.js';
import {
  GetS3Utils,
} from '../../../../../../shared/s3utils.js';
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
    RenderAndPublish: BTN_RENDER,
  },
  Alerts: {
    Oops: OOPS,
    HighlightEditSaved: ALERT_SAVED,
    HighlightEditSaveFailed: ALERT_SAVE_FAILED,
    HighlightEditLoadFailed: ALERT_LOAD_FAILED,
    HighlightEditEmptyEdit: ALERT_EMPTY_EDIT,
    HighlightRenderQueued: ALERT_RENDER_QUEUED,
    HighlightRenderFailed: ALERT_RENDER_FAILED,
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
      render: _id('he-render'),
      progress: _id('he-progress'),
      history: _id('he-history'),
    };
    this.$iotReceiverName = `highlight-editor-${this.$ids.modal}`;
    this.$activeRenderId = null;
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
    this._refreshRenderHistory().catch((e) => console.error(e));
  }

  async _refreshRenderHistory() {
    const editProjectId = this.state.editProject.editProjectId;
    let rows = [];
    try {
      const res = await ApiHelper.listRenders(editProjectId);
      rows = (res && res.renders) || [];
    } catch (e) {
      console.error('listRenders failed:', e);
    }
    rows = rows.slice().sort((a, b) => {
      const ta = (a && (a.updatedAt || a.submittedAt)) || '';
      const tb = (b && (b.updatedAt || b.submittedAt)) || '';
      return tb.localeCompare(ta);
    });
    this._renderHistoryList(rows);

    // Resume tracking if any in-flight render is still active.
    const inflight = rows.find((r) =>
      r && r.status && r.status !== 'completed' && r.status !== 'error');
    if (inflight && inflight.renderId) {
      this.$activeRenderId = inflight.renderId;
      this._setProgressLabel(inflight.status, inflight.percent || 0);
      const renderBtn = this.$modal && this.$modal.find(`#${this.$ids.render}`);
      if (renderBtn) renderBtn.prop('disabled', true);
    }
  }

  _renderHistoryList(rows) {
    if (!this.$modal) return;
    const slot = this.$modal.find(`#${this.$ids.history}`);
    slot.empty();
    if (!rows || rows.length === 0) {
      slot.append($('<p/>')
        .addClass('text-muted font-italic mb-0')
        .text('No renders yet.'));
      return;
    }

    rows.forEach((row) => {
      slot.append(this._buildHistoryRow(row));
    });
  }

  _buildHistoryRow(row) {
    const wrap = $('<div/>')
      .addClass('d-flex align-items-center py-1 border-bottom')
      .attr('data-render-id', row.renderId);

    const status = row.status || 'unknown';
    const submitted = row.submittedAt || row.updatedAt || '';
    const ts = submitted ? new Date(submitted).toLocaleString() : '';
    const idShort = (row.renderId || '').slice(0, 8);

    const meta = $('<span/>')
      .addClass('mr-auto text-truncate')
      .css({ minWidth: 0 })
      .text(`${idShort} · ${ts} · ${status}${row.percent ? ` (${row.percent}%)` : ''}`);
    wrap.append(meta);

    const actions = $('<span/>').addClass('ml-2');

    if (status === 'completed') {
      const playBtn = $('<a/>')
        .attr('target', '_blank')
        .attr('rel', 'noopener noreferrer')
        .addClass('btn btn-sm btn-outline-primary mr-1 disabled')
        .css({ pointerEvents: 'none' })
        .text('▶ Play');
      const dlBtn = $('<a/>')
        .addClass('btn btn-sm btn-outline-secondary mr-1 disabled')
        .css({ pointerEvents: 'none' })
        .text('⬇ Download');
      actions.append(playBtn).append(dlBtn);

      // Resolve URLs async, enable buttons when ready.
      this._signRenderUrls(row).then((urls) => {
        if (!urls) return;
        playBtn.attr('href', urls.playUrl)
          .removeClass('disabled')
          .css({ pointerEvents: '' });
        dlBtn.attr('href', urls.downloadUrl)
          .removeClass('disabled')
          .css({ pointerEvents: '' });
      }).catch((e) => {
        console.error('failed to sign render output:', e);
        meta.append($('<span/>')
          .addClass('text-danger ml-2')
          .text(' (output unavailable)'));
      });
    } else if (status === 'error') {
      meta.addClass('text-danger');
    }

    const delBtn = $('<button/>')
      .attr('type', 'button')
      .addClass('btn btn-sm btn-outline-danger')
      .text('Delete');
    delBtn.on('click', async () => {
      delBtn.prop('disabled', true);
      try {
        await ApiHelper.deleteRender(row.renderId);
        wrap.remove();
        if (this.$activeRenderId === row.renderId) {
          this.$activeRenderId = null;
          this._setProgressLabel('', 0);
          const renderBtn = this.$modal && this.$modal.find(`#${this.$ids.render}`);
          if (renderBtn) renderBtn.prop('disabled', false);
        }
        const slot = this.$modal.find(`#${this.$ids.history}`);
        if (slot.children().length === 0) {
          slot.append($('<p/>')
            .addClass('text-muted font-italic mb-0')
            .text('No renders yet.'));
        }
      } catch (e) {
        console.error('deleteRender failed:', e);
        delBtn.prop('disabled', false);
      }
    });
    actions.append(delBtn);

    wrap.append(actions);
    return wrap;
  }

  async _signRenderUrls(row) {
    const prefix = ((row || {}).outputs || {}).mp4;
    if (!prefix) return null;
    return this._signRenderedMp4(prefix);
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

    const seedSegments = (this.highlightSet.segments || []).map((seg, i) => ({
      kind: 'highlight',
      sourceSegmentIndex: i,
      startSec: Number(seg.startSec) || 0,
      endSec: Number(seg.endSec) || 0,
      title: seg.title || '',
      reason: seg.reason || '',
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
                  <video data-role="player" controls preload="metadata"
                         class="w-100 bg-dark"
                         style="max-height:50vh;"></video>
                  <div data-role="tracks" class="mt-3"></div>
                </div>
                <div class="col-12 col-lg-4 px-2">
                  <div data-role="inspector"></div>
                </div>
              </div>
              <div class="row mt-3">
                <div class="col-12 px-2">
                  <p class="lead-xs text-muted mb-1">Renders</p>
                  <div id="${ids.history}" class="lead-xs"></div>
                </div>
              </div>
            </div>
            <div class="modal-footer flex-wrap">
              <span class="lead-xs text-muted mr-auto" id="${ids.progress}"></span>
              <button type="button" class="btn btn-secondary btn-sm"
                      data-dismiss="modal">${BTN_CLOSE}</button>
              <button type="button" class="btn btn-primary btn-sm" data-role="save">${BTN_SAVE}</button>
              <button type="button" class="btn btn-success btn-sm" data-role="render" id="${ids.render}">${BTN_RENDER}</button>
            </div>
          </div>
        </div>
      </div>
    `);

    modal.find('.modal-title').text(`${MSG_TITLE} — ${ep.name}`);

    const player = modal.find('video[data-role="player"]')[0];
    if (player && this.state.proxyUrl) {
      player.src = this.state.proxyUrl;
    }

    modal.find('button[data-role="save"]').on('click', () => this._onSave());
    modal.find('button[data-role="render"]').on('click', () => this._onRender());
    modal.on('hidden.bs.modal', () => this._onHidden());

    RegisterIotMessageEvent(this.$iotReceiverName, async (msg) => this._onIotMessage(msg));

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

  async _onRender() {
    const ep = this.state.editProject;
    if (!ep.segments || ep.segments.length === 0) {
      await _alertAgent.showMessage(this.$modal, 'warning', OOPS, ALERT_EMPTY_EDIT, 4000);
      return;
    }

    // Persist current state before kicking off the render so compose-edl
    // sees the latest segments/flags from DDB.
    await this._onSave();

    const renderBtn = this.$modal.find(`#${this.$ids.render}`);
    renderBtn.prop('disabled', true);

    Spinner.loading(true);
    try {
      const res = await ApiHelper.startRender({
        editProjectId: ep.editProjectId,
      });
      this.$activeRenderId = (res && res.renderId) || null;
      this._setProgressLabel('queued', 0);
      this._refreshRenderHistory().catch((e) => console.error(e));
      await _alertAgent.showMessage(this.$modal, 'success', '', ALERT_RENDER_QUEUED, 5000);
    } catch (e) {
      console.error(e);
      const msg = (ALERT_RENDER_FAILED || '').replace('{{ERROR}}', (e && e.message) || '');
      await _alertAgent.showMessage(this.$modal, 'danger', OOPS, msg, 6000);
      renderBtn.prop('disabled', false);
    } finally {
      Spinner.loading(false);
    }
  }

  _setProgressLabel(status, percent) {
    if (!this.$modal) return;
    const label = this.$modal.find(`#${this.$ids.progress}`);
    const pct = Number(percent || 0);
    if (status === 'completed') {
      label.text('Render completed.');
    } else if (status === 'error') {
      label.text('Render failed.');
    } else if (status === 'queued' || status === 'submitted') {
      label.text('Submitting render…');
    } else {
      label.text(`Rendering… ${pct}%`);
    }
  }

  async _onIotMessage(msg) {
    if (!msg || msg.type !== 'render') return;
    if (!this.$activeRenderId) return;
    if (msg.renderId && msg.renderId !== this.$activeRenderId) return;

    this._setProgressLabel(msg.status, msg.percent);
    this._patchHistoryRowStatus(this.$activeRenderId, msg.status, msg.percent);

    if (msg.status === 'completed' || msg.status === 'error') {
      const renderBtn = this.$modal && this.$modal.find(`#${this.$ids.render}`);
      if (renderBtn) renderBtn.prop('disabled', false);
      this.$activeRenderId = null;
      this._refreshRenderHistory().catch((e) => console.error(e));
    }
  }

  _patchHistoryRowStatus(renderId, status, percent) {
    if (!this.$modal || !renderId) return;
    const row = this.$modal.find(`[data-render-id="${renderId}"]`);
    if (!row.length) return;
    const meta = row.children().first();
    const idShort = renderId.slice(0, 8);
    const ts = meta.text().split(' · ')[1] || '';
    const pct = Number(percent || 0);
    const tail = pct ? ` (${pct}%)` : '';
    meta.text(`${idShort} · ${ts} · ${status}${tail}`);
  }

  async _signRenderedMp4(s3Prefix) {
    // s3Prefix is "s3://{bucket}/renders/{uuid}/{renderId}/mp4/"
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3Prefix);
    if (!m) throw new Error(`unexpected output URI: ${s3Prefix}`);
    const bucket = m[1];
    const prefix = m[2];

    const s3 = GetS3Utils();
    const items = await s3.listObjects(bucket, prefix);
    const mp4 = (items || []).find((it) =>
      it && typeof it.Key === 'string' && it.Key.toLowerCase().endsWith('.mp4'));
    if (!mp4) throw new Error('no .mp4 found under render output');
    const filename = mp4.Key.split('/').pop() || 'render.mp4';
    const [playUrl, downloadUrl] = await Promise.all([
      s3.signUrl(bucket, mp4.Key),
      s3.signUrl(bucket, mp4.Key, {
        responseContentDisposition: `attachment; filename="${filename}"`,
      }),
    ]);
    return { playUrl, downloadUrl };
  }

  _onHidden() {
    UnregisterIotMessageEvent(this.$iotReceiverName);
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
