// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import mxAlert from '../../../../../../mixins/mxAlert.js';
import Localization from '../../../../../../shared/localization.js';
import Spinner from '../../../../../../shared/spinner.js';
import ApiHelper from '../../../../../../shared/apiHelper.js';
import BaseAnalysisTab from '../base/baseAnalysisTab.js';

const {
  Messages: {
    PublishTab: TITLE,
  },
} = Localization;

const BUILTIN_TEMPLATES = [
  { value: 'vod_landscape', label: 'Landscape 16:9 (built-in)' },
  { value: 'vod_portrait', label: 'Portrait 9:16 (built-in)' },
];

const FONT_SCRIPTS = [
  { value: 'HANT', label: 'Traditional Chinese (HANT)' },
  { value: 'HANS', label: 'Simplified Chinese (HANS)' },
  { value: 'JPAN', label: 'Japanese (JPAN)' },
  { value: 'KORE', label: 'Korean (KORE)' },
  { value: 'AUTO', label: 'Auto-detect' },
];

const LOGO_SIZES = ['48', '64', '96', '128', '192'];

const POLL_MS = 5000;
const MAX_POLLS = 720; // up to 1 hour

export default class PublishTab extends mxAlert(BaseAnalysisTab) {
  constructor(previewComponent) {
    super(TITLE, previewComponent);
    Spinner.useSpinner();
    this.$state = {
      settings: null,
      logos: {},
      polling: false,
    };
  }

  async createContent() {
    const container = $('<div/>')
      .addClass('col-11 my-4 max-h36r');

    container.append(this.createIntro());
    container.append(this.createTemplateSection());
    container.append(this.createLogoSection());
    container.append(this.createControls());
    container.append(this.createStatusSection());
    container.append(this.createOutputSection());

    container.ready(() => this.loadSettings());

    return container;
  }

  createIntro() {
    const wrap = $('<div/>').addClass('mb-3');
    wrap.append($('<p/>').addClass('lead mb-1').html('Publish'));
    wrap.append($('<p/>').addClass('lead-xs text-muted mb-0').html(
      'Produces an HLS adaptive bitrate stream and a 1080p MP4 with the latest subtitle SRT burned in. '
      + 'Logo overlay is optional. Run this after reviewing the transcript and (optionally) editing the SRT.'
    ));
    return wrap;
  }

  createTemplateSection() {
    const section = $('<div/>').addClass('form-group px-0 mt-3 mb-3');
    section.append($('<p/>').addClass('lead-s mb-2').html('1. Output template'));

    const row = $('<div/>').addClass('d-flex flex-wrap align-items-center');
    const templateSelect = $('<select/>').addClass('custom-select custom-select-sm w-auto mr-2 mb-1').attr('data-role', 'template');
    BUILTIN_TEMPLATES.forEach((t) => {
      templateSelect.append($('<option/>').attr('value', t.value).text(t.label));
    });
    row.append(templateSelect);

    const downloadBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('data-role', 'tmpl-download').html('Download');
    const uploadBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('data-role', 'tmpl-upload').html('Upload override');
    const newBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('data-role', 'tmpl-new').html('Upload as new');
    const deleteBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-danger mr-2 mb-1')
      .attr('data-role', 'tmpl-delete').html('Delete custom');
    const refreshBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-link mb-1')
      .attr('data-role', 'tmpl-refresh').html('Refresh list');
    row.append(downloadBtn).append(uploadBtn).append(newBtn).append(deleteBtn).append(refreshBtn);

    const hiddenFile = $('<input/>').attr('type', 'file').attr('accept', 'application/json,.json')
      .css('display', 'none').attr('data-role', 'tmpl-file');
    row.append(hiddenFile);

    const status = $('<span/>').addClass('lead-xs text-muted ml-2 mb-1').attr('data-role', 'tmpl-status');
    row.append(status);

    section.append(row);

    downloadBtn.on('click', () => this.downloadTemplate());
    uploadBtn.on('click', () => {
      hiddenFile.data('mode', 'override');
      hiddenFile.trigger('click');
    });
    newBtn.on('click', () => {
      const name = window.prompt('Enter a name for the new template (letters, digits, _ or -, max 64 chars):', '');
      if (!name) return;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        this.setTemplateStatus('Invalid name. Use A-Z, a-z, 0-9, _, - (max 64 chars).', 'err');
        return;
      }
      hiddenFile.data('mode', 'new');
      hiddenFile.data('newName', name);
      hiddenFile.trigger('click');
    });
    deleteBtn.on('click', () => this.deleteSelectedTemplate());
    refreshBtn.on('click', () => this.refreshTemplateList());
    hiddenFile.on('change', () => {
      const file = hiddenFile[0].files[0];
      const mode = hiddenFile.data('mode');
      const newName = hiddenFile.data('newName');
      hiddenFile.val('');
      this.uploadTemplateFile(file, mode, newName).catch((e) => {
        console.error(e);
        this.setTemplateStatus(`Upload failed: ${e.message}`, 'err');
      });
    });

    const fontLabel = $('<label/>').addClass('lead-xs mb-1 mt-3 d-block').html('Subtitle font script');
    section.append(fontLabel);

    const fontSelect = $('<select/>').addClass('custom-select custom-select-sm w-auto').attr('data-role', 'fontScript');
    FONT_SCRIPTS.forEach((f) => {
      fontSelect.append($('<option/>').attr('value', f.value).text(f.label));
    });
    section.append(fontSelect);

    return section;
  }

  setTemplateStatus(text, kind) {
    const el = this.$root().find('[data-role="tmpl-status"]');
    el.removeClass('text-muted text-success text-danger');
    if (kind === 'ok') el.addClass('text-success');
    else if (kind === 'err') el.addClass('text-danger');
    else el.addClass('text-muted');
    el.html(text || '');
  }

  async refreshTemplateList(preferredValue) {
    try {
      this.setTemplateStatus('Loading templates...');
      const res = await ApiHelper.listPublishTemplates();
      const templates = (res && res.templates) || [];
      const root = this.$root();
      const select = root.find('[data-role="template"]');
      const current = preferredValue || select.val() || 'vod_landscape';
      select.empty();
      templates
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((t) => {
          const tags = [];
          if (t.builtin && t.custom) tags.push('built-in, overridden');
          else if (t.builtin) tags.push('built-in');
          else if (t.custom) tags.push('custom');
          const label = `${t.name}${tags.length ? ` (${tags.join(', ')})` : ''}`;
          select.append($('<option/>').attr('value', t.name).text(label));
        });
      // Restore selection if still present
      if (templates.find((t) => t.name === current)) {
        select.val(current);
      }
      this.setTemplateStatus(`${templates.length} template(s) available.`, 'ok');
    } catch (e) {
      console.error(e);
      this.setTemplateStatus(`Error loading templates: ${e.message}`, 'err');
    }
  }

  async downloadTemplate() {
    const name = this.$root().find('[data-role="template"]').val();
    if (!name) return;
    try {
      this.setTemplateStatus(`Downloading ${name}...`);
      const res = await ApiHelper.getPublishTemplate(name);
      const content = (res && res.content) || res;
      const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.setTemplateStatus(`Downloaded ${name}.json`, 'ok');
    } catch (e) {
      console.error(e);
      this.setTemplateStatus(`Download failed: ${e.message}`, 'err');
    }
  }

  async uploadTemplateFile(file, mode, newName) {
    if (!file) return;
    const root = this.$root();
    const targetName = mode === 'new'
      ? newName
      : root.find('[data-role="template"]').val();
    if (!targetName) {
      this.setTemplateStatus('No target template selected.', 'err');
      return;
    }
    this.setTemplateStatus(`Reading ${file.name}...`);
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.setTemplateStatus(`Invalid JSON: ${e.message}`, 'err');
      return;
    }
    if (!parsed || !Array.isArray(parsed.OutputGroups) || parsed.OutputGroups.length === 0) {
      this.setTemplateStatus('Template must have an OutputGroups array.', 'err');
      return;
    }
    this.setTemplateStatus(`Uploading ${targetName}...`);
    await ApiHelper.savePublishTemplate(targetName, parsed);
    this.setTemplateStatus(`Saved ${targetName}.`, 'ok');
    await this.refreshTemplateList(targetName);
  }

  async deleteSelectedTemplate() {
    const root = this.$root();
    const name = root.find('[data-role="template"]').val();
    if (!name) return;
    if (!window.confirm(`Delete custom version of "${name}"? Built-in templates revert to the packaged default.`)) {
      return;
    }
    try {
      this.setTemplateStatus(`Deleting ${name}...`);
      const res = await ApiHelper.deletePublishTemplate(name);
      if (res && res.deleted) {
        this.setTemplateStatus(`Deleted ${name}.`, 'ok');
      } else {
        this.setTemplateStatus(`No custom override for ${name}.`, 'ok');
      }
      await this.refreshTemplateList(BUILTIN_TEMPLATES.find((b) => b.value === name) ? name : 'vod_landscape');
    } catch (e) {
      console.error(e);
      this.setTemplateStatus(`Delete failed: ${e.message}`, 'err');
    }
  }

  createLogoSection() {
    const section = $('<div/>').addClass('form-group px-0 mt-3 mb-3');
    section.append($('<p/>').addClass('lead-s mb-1').html('2. Logo overlay (optional)'));
    section.append($('<p/>').addClass('lead-xs text-muted mb-2').html(
      'Upload PNG/JPG logos at one or more sizes. The renderer picks the largest logo that fits each output rendition.'
    ));

    const grid = $('<div/>').addClass('d-flex flex-wrap');
    LOGO_SIZES.forEach((size) => {
      const cell = $('<div/>')
        .addClass('mr-3 mb-2 border rounded p-2')
        .css({ width: '12rem' })
        .attr('data-logo-size', size);

      cell.append($('<div/>').addClass('lead-xs mb-1').html(`<strong>${size}px</strong> tall`));

      const preview = $('<div/>')
        .addClass('mb-1 d-flex align-items-center justify-content-center')
        .css({ height: '3rem', background: '#f8f9fa' })
        .attr('data-role', 'preview');
      preview.append($('<span/>').addClass('text-muted lead-xxs').html('(no logo)'));
      cell.append(preview);

      const fileInput = $('<input/>')
        .attr('type', 'file')
        .attr('accept', 'image/png,image/jpeg')
        .addClass('lead-xxs w-100')
        .attr('data-role', 'file');
      cell.append(fileInput);

      const status = $('<div/>')
        .addClass('lead-xxs text-muted mt-1')
        .attr('data-role', 'status');
      cell.append(status);

      const clearBtn = $('<button/>')
        .attr('type', 'button')
        .addClass('btn btn-link btn-sm lead-xxs p-0 mt-1')
        .css('display', 'none')
        .attr('data-role', 'clear')
        .html('Remove');
      cell.append(clearBtn);

      fileInput.on('change', () => this.uploadLogo(size, fileInput[0].files[0], cell));
      clearBtn.on('click', () => this.clearLogo(size, cell));

      grid.append(cell);
    });
    section.append(grid);

    return section;
  }

  createControls() {
    const wrap = $('<div/>').addClass('form-group px-0 mt-3 mb-3 d-flex flex-wrap align-items-center');

    const saveBtn = $('<button/>')
      .attr('type', 'button')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .attr('data-role', 'save')
      .html('Save Settings');
    wrap.append(saveBtn);

    const publishBtn = $('<button/>')
      .attr('type', 'button')
      .addClass('btn btn-sm btn-primary mr-2 mb-1')
      .attr('data-role', 'publish')
      .html('Publish');
    wrap.append(publishBtn);

    const refreshBtn = $('<button/>')
      .attr('type', 'button')
      .addClass('btn btn-sm btn-outline-secondary mr-2 mb-1')
      .attr('data-role', 'refresh')
      .html('Refresh Status');
    wrap.append(refreshBtn);

    const status = $('<span/>')
      .addClass('lead-xs text-muted ml-2 mb-1')
      .attr('data-role', 'controls-status');
    wrap.append(status);

    saveBtn.on('click', () => this.saveSettings());
    publishBtn.on('click', () => this.startPublish());
    refreshBtn.on('click', () => this.refreshStatus());

    return wrap;
  }

  createStatusSection() {
    const section = $('<div/>')
      .addClass('form-group px-0 mt-3 mb-3 border rounded p-3')
      .attr('data-role', 'status-section');
    section.append($('<p/>').addClass('lead-s mb-2').html('Job status'));
    section.append($('<div/>').addClass('lead-xs').attr('data-role', 'status-body').html('Idle.'));
    return section;
  }

  createOutputSection() {
    const section = $('<div/>')
      .addClass('form-group px-0 mt-3 mb-3 border rounded p-3')
      .attr('data-role', 'outputs-section')
      .css('display', 'none');
    section.append($('<p/>').addClass('lead-s mb-2').html('Outputs'));
    section.append($('<div/>').attr('data-role', 'outputs-body'));
    section.append($('<hr/>').addClass('my-3').attr('data-role', 'history-divider').css('display', 'none'));
    section.append($('<p/>').addClass('lead-s mb-2').attr('data-role', 'history-title').css('display', 'none').html('Previous outputs'));
    section.append($('<div/>').attr('data-role', 'history-body'));
    return section;
  }

  // ---------- helpers ----------

  $root() {
    return this.tabContent.find('.col-11');
  }

  setControlsStatus(text, kind) {
    const el = this.$root().find('[data-role="controls-status"]');
    el.removeClass('text-muted text-success text-danger');
    if (kind === 'ok') el.addClass('text-success');
    else if (kind === 'err') el.addClass('text-danger');
    else el.addClass('text-muted');
    el.html(text || '');
  }

  setStatusBody(html) {
    this.$root().find('[data-role="status-body"]').html(html);
  }

  // ---------- settings ----------

  async loadSettings() {
    const uuid = this.media.uuid;
    try {
      this.setControlsStatus('Loading settings...');
      // Refresh template list first so the dropdown shows custom templates before applying saved selection
      await this.refreshTemplateList().catch(() => {});
      const res = await ApiHelper.getPublishSettings(uuid);
      this.applySettings(res || {});
      this.setControlsStatus(res && res.isDefault ? 'Defaults loaded.' : 'Settings loaded.', 'ok');
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Error loading settings: ${e.message}`, 'err');
    }
    this.refreshStatus().catch(() => {});
  }

  applySettings(s) {
    const root = this.$root();
    root.find('[data-role="template"]').val(s.template || 'vod_landscape');
    root.find('[data-role="fontScript"]').val(s.fontScript || 'HANT');

    this.$state.logos = (s.logos && typeof s.logos === 'object') ? { ...s.logos } : {};
    LOGO_SIZES.forEach((size) => {
      const cell = root.find(`[data-logo-size="${size}"]`);
      this.renderLogoCell(size, cell);
    });
  }

  collectSettings() {
    const root = this.$root();
    return {
      template: root.find('[data-role="template"]').val(),
      fontScript: root.find('[data-role="fontScript"]').val(),
      logos: this.$state.logos || {},
    };
  }

  async saveSettings() {
    const uuid = this.media.uuid;
    try {
      this.setControlsStatus('Saving...');
      const settings = this.collectSettings();
      await ApiHelper.savePublishSettings(uuid, settings);
      this.setControlsStatus('Settings saved.', 'ok');
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Save failed: ${e.message}`, 'err');
    }
  }

  // ---------- logo upload ----------

  renderLogoCell(size, cell) {
    const preview = cell.find('[data-role="preview"]');
    const clearBtn = cell.find('[data-role="clear"]');
    const status = cell.find('[data-role="status"]');
    const uri = (this.$state.logos || {})[size];

    preview.empty();
    if (uri) {
      preview.append($('<span/>').addClass('lead-xxs text-success').html('✔ uploaded'));
      clearBtn.css('display', '');
      status.html(uri);
    } else {
      preview.append($('<span/>').addClass('text-muted lead-xxs').html('(no logo)'));
      clearBtn.css('display', 'none');
      status.html('');
    }
  }

  async uploadLogo(size, file, cell) {
    if (!file) return;
    const uuid = this.media.uuid;
    const status = cell.find('[data-role="status"]');
    const fileInput = cell.find('[data-role="file"]');
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const validExt = ['png', 'jpg', 'jpeg'].includes(ext) ? ext : 'png';

    try {
      fileInput.prop('disabled', true);
      status.removeClass('text-danger text-success').addClass('text-muted').html('Requesting upload URL...');
      const presign = await ApiHelper.getPublishLogoUploadUrl(uuid, size, validExt);
      if (!presign || !presign.url) throw new Error('no presign URL returned');

      status.html('Uploading...');
      const putRes = await fetch(presign.url, {
        method: 'PUT',
        headers: { 'Content-Type': presign.contentType || file.type || 'image/png' },
        body: file,
      });
      if (!putRes.ok) throw new Error(`HTTP ${putRes.status}`);

      this.$state.logos[size] = presign.s3uri;
      this.renderLogoCell(size, cell);
      status.removeClass('text-muted text-danger').addClass('text-success').html('Uploaded. Remember to Save Settings.');
    } catch (e) {
      console.error(e);
      status.removeClass('text-muted text-success').addClass('text-danger').html(`Error: ${e.message}`);
    } finally {
      fileInput.prop('disabled', false);
      fileInput.val('');
    }
  }

  clearLogo(size, cell) {
    if (!this.$state.logos) return;
    delete this.$state.logos[size];
    this.renderLogoCell(size, cell);
    cell.find('[data-role="status"]').removeClass('text-success text-danger').addClass('text-muted')
      .html('Removed. Remember to Save Settings.');
  }

  // ---------- publish ----------

  async startPublish() {
    const uuid = this.media.uuid;
    try {
      this.setControlsStatus('Saving and starting publish...');
      const settings = this.collectSettings();
      await ApiHelper.savePublishSettings(uuid, settings);
      const job = await ApiHelper.startPublish(uuid, settings);
      this.setControlsStatus(`Submitted: ${job.jobId || job.outputId}`, 'ok');
      this.renderStatus(job);
      this.startPolling();
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Publish failed: ${e.message}`, 'err');
    }
  }

  async refreshStatus() {
    const uuid = this.media.uuid;
    try {
      const status = await ApiHelper.getPublishStatus(uuid);
      this.renderStatus(status);
      if (status && ['SUBMITTED', 'PROGRESSING'].includes(status.status)) {
        this.startPolling();
      }
    } catch (e) {
      console.error(e);
      this.setStatusBody(`<span class="text-danger">Error: ${e.message}</span>`);
    }
  }

  renderStatus(status) {
    if (!status || status.status === 'idle') {
      this.setStatusBody('Idle. No publish job has been started yet for this asset.');
      this.renderOutputs(null);
      return;
    }
    const rows = [];
    const fmt = (k, v) => `<div><strong>${k}</strong>: <code>${v}</code></div>`;
    if (status.status) rows.push(fmt('Status', status.status));
    if (status.jobId) rows.push(fmt('Job ID', status.jobId));
    if (status.template) rows.push(fmt('Template', status.template));
    if (typeof status.jobPercentComplete === 'number') {
      rows.push(fmt('Progress', `${status.jobPercentComplete}%`));
    }
    if (status.currentPhase) rows.push(fmt('Phase', status.currentPhase));
    if (status.errorCode) rows.push(fmt('Error code', status.errorCode));
    if (status.errorMessage) rows.push(fmt('Error', status.errorMessage));
    if (status.submittedAt) rows.push(fmt('Submitted', new Date(status.submittedAt).toISOString()));
    if (status.finishedAt) rows.push(fmt('Finished', new Date(status.finishedAt).toISOString()));
    this.setStatusBody(rows.join('\n'));

    const isComplete = status.status === 'COMPLETE';
    this.renderOutputs(isComplete ? (status.outputs || {}) : null, status.history || []);
  }

  renderOutputs(outputs, history) {
    const section = this.$root().find('[data-role="outputs-section"]');
    const body = this.$root().find('[data-role="outputs-body"]');
    body.empty();
    const hasCurrent = outputs && (outputs.hlsMaster || outputs.mp4);
    const hasHistory = Array.isArray(history) && history.length > 0;
    if (!hasCurrent && !hasHistory) {
      section.css('display', 'none');
      this.renderHistory([]);
      return;
    }
    section.css('display', '');
    if (hasCurrent) {
      body.append(this.buildOutputRow(outputs));
    }
    this.renderHistory(history || []);
  }

  buildOutputRow(outputs, opts) {
    const opts2 = opts || {};
    const wrap = $('<div/>').addClass('mb-3');
    if (opts2.heading) {
      wrap.append($('<div/>').addClass('lead-xs text-muted mb-1').html(opts2.heading));
    }
    if (outputs.hlsMaster) {
      const row = $('<div/>').addClass('mb-2');
      row.append($('<strong/>').html('HLS master: '));
      row.append($('<a/>').attr('href', outputs.hlsMaster).attr('target', '_blank').text('Open'));
      row.append($('<div/>').addClass('lead-xxs text-muted text-break').html(
        `<a href="${outputs.hlsMaster}" target="_blank">${outputs.hlsMaster}</a>`
      ));
      wrap.append(row);
    }
    if (outputs.mp4) {
      const row = $('<div/>').addClass('mb-2');
      row.append($('<strong/>').html('MP4 (1080p): '));
      const filename = (outputs.mp4Key || '').split('/').pop() || 'video.mp4';
      row.append($('<a/>').attr('href', outputs.mp4).attr('download', filename).text('Download'));
      row.append($('<div/>').addClass('lead-xxs text-muted text-break').html(
        `<a href="${outputs.mp4}" target="_blank">${outputs.mp4}</a>`
      ));
      wrap.append(row);
    }
    return wrap;
  }

  renderHistory(history) {
    const divider = this.$root().find('[data-role="history-divider"]');
    const title = this.$root().find('[data-role="history-title"]');
    const body = this.$root().find('[data-role="history-body"]');
    body.empty();
    const items = (history || []).filter((h) => h && h.outputs && (h.outputs.hlsMaster || h.outputs.mp4));
    if (items.length === 0) {
      divider.css('display', 'none');
      title.css('display', 'none');
      return;
    }
    divider.css('display', '');
    title.css('display', '');
    items.forEach((h) => {
      const ts = h.finishedAt ? new Date(h.finishedAt).toLocaleString()
        : h.submittedAt ? new Date(h.submittedAt).toLocaleString()
        : '';
      const heading = `<strong>${h.template || ''}</strong> · ${ts || h.outputId || ''}`;
      body.append(this.buildOutputRow(h.outputs, { heading }));
    });
  }

  startPolling() {
    if (this.$state.polling) return;
    this.$state.polling = true;
    let polls = 0;
    const tick = async () => {
      if (!this.$state.polling) return;
      polls += 1;
      if (polls > MAX_POLLS) {
        this.$state.polling = false;
        return;
      }
      try {
        const status = await ApiHelper.getPublishStatus(this.media.uuid);
        this.renderStatus(status);
        if (!status || ['COMPLETE', 'ERROR', 'CANCELED', 'idle'].includes(status.status)) {
          this.$state.polling = false;
          return;
        }
      } catch (e) {
        console.error(e);
      }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  }

  async hide() {
    this.$state.polling = false;
    return super.hide();
  }
}
