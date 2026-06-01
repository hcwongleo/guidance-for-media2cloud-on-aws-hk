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
    modal.find('.modal-title')
      .text(`${MSG_TITLE} — ${ep.name}${promptTail}`)
      .attr('title', promptStr || '(default prompt)');

    const player = modal.find('video[data-role="player"]')[0];
    if (player && this.state.proxyUrl) {
      player.src = this.state.proxyUrl;
    }

    modal.find('button[data-role="save"]').on('click', () => this._onSave());
    modal.on('hidden.bs.modal', () => this._onHidden());

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

  _onHidden() {
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
