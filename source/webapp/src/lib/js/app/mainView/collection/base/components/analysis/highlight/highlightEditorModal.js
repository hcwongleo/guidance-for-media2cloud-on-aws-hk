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
import EditorTracks from './editorTracks.js';

class AlertHelper extends mxAlert(class {}) {}
const _alertAgent = new AlertHelper();

const {
  Messages: {
    HighlightEditorTitle: MSG_TITLE,
    HighlightEditorPublishLabel: MSG_PUBLISH,
    HighlightEditorAspectRatio: MSG_ASPECT,
    HighlightEditorBurnCaptions: MSG_BURN,
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

const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3'];

function _id(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export default class HighlightEditorModal {
  constructor(previewComponent, highlightSet) {
    this.$previewComponent = previewComponent;
    this.$highlightSet = highlightSet;
    this.$state = null;
    this.$tracks = null;
    this.$modal = null;
    this.$ids = {
      modal: _id('he-modal'),
      publish: _id('he-publish'),
      burn: _id('he-burn'),
      aspect: _id('he-aspect'),
      render: _id('he-render'),
      progress: _id('he-progress'),
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
      publishToLibrary: false,
      aspectRatio: '16:9',
      burnCaptions: false,
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
            </div>
            <div class="modal-footer flex-wrap">
              <div class="form-check mr-3">
                <input type="checkbox" class="form-check-input" id="${ids.publish}">
                <label class="form-check-label lead-xs" for="${ids.publish}">${MSG_PUBLISH}</label>
              </div>
              <div class="form-check mr-3">
                <input type="checkbox" class="form-check-input" id="${ids.burn}">
                <label class="form-check-label lead-xs" for="${ids.burn}">${MSG_BURN}</label>
              </div>
              <div class="form-inline mr-auto">
                <label class="lead-xs mb-0 mr-2" for="${ids.aspect}">${MSG_ASPECT}</label>
                <select id="${ids.aspect}" class="custom-select custom-select-sm"></select>
              </div>
              <span class="lead-xs text-muted mr-2" id="${ids.progress}"></span>
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

    const publishCheckbox = modal.find(`#${ids.publish}`);
    publishCheckbox.prop('checked', !!ep.publishToLibrary);
    publishCheckbox.on('change', () => {
      ep.publishToLibrary = publishCheckbox.is(':checked');
    });

    const burnCheckbox = modal.find(`#${ids.burn}`);
    burnCheckbox.prop('checked', !!ep.burnCaptions);
    burnCheckbox.on('change', () => {
      ep.burnCaptions = burnCheckbox.is(':checked');
    });

    const aspectSelect = modal.find(`#${ids.aspect}`);
    ASPECT_RATIOS.forEach((r) => {
      const opt = $('<option/>').attr('value', r).text(r);
      if (r === ep.aspectRatio) opt.attr('selected', 'selected');
      aspectSelect.append(opt);
    });
    aspectSelect.on('change', () => {
      ep.aspectRatio = aspectSelect.val();
    });

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
      publishToLibrary: !!ep.publishToLibrary,
      aspectRatio: ep.aspectRatio || '16:9',
      burnCaptions: !!ep.burnCaptions,
    };

    Spinner.loading(true);
    try {
      const saved = await ApiHelper.saveEditProject(ep.editProjectId, payload);
      this.$state.editProject = { ...ep, ...saved };
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
        publishToLibrary: !!ep.publishToLibrary,
        aspectRatio: ep.aspectRatio || '16:9',
        burnCaptions: !!ep.burnCaptions,
      });
      this.$activeRenderId = (res && res.renderId) || null;
      this._setProgressLabel('queued', 0);
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

    if (msg.status === 'completed' || msg.status === 'error') {
      const renderBtn = this.$modal && this.$modal.find(`#${this.$ids.render}`);
      if (renderBtn) renderBtn.prop('disabled', false);
      this.$activeRenderId = null;
    }
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
