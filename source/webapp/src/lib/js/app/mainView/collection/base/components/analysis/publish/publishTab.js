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

const ORIENTATIONS = [
  { value: 'landscape', label: 'Landscape (16:9, 1920×1080)' },
  { value: 'portrait', label: 'Portrait (9:16, 1080×1920)' },
];

const BUILTIN_TEMPLATES = [
  { value: 'mp4_landscape', label: 'Landscape MP4 (built-in)' },
  { value: 'mp4_portrait', label: 'Portrait MP4 (built-in)' },
];

const POLL_MS = 5000;
const MAX_POLLS = 720;

export default class PublishTab extends mxAlert(BaseAnalysisTab) {
  constructor(previewComponent) {
    super(TITLE, previewComponent);
    Spinner.useSpinner();
    this.$state = { polling: false };
  }

  async createContent() {
    const container = $('<div/>').addClass('col-11 my-4 max-h36r');
    container.append(this.createIntro());
    container.append(this.createOrientationSection());
    container.append(this.createTemplateSection());
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
      'Generates landscape and/or portrait 1080p MP4s from the source video. '
      + 'Subtitle burn-in and logo overlay are out of scope here — download the SRT '
      + 'from the Transcribe tab and the MP4 below, then hand both off to your editor.'
    ));
    return wrap;
  }

  createOrientationSection() {
    const section = $('<div/>').addClass('form-group px-0 mt-3 mb-3');
    section.append($('<p/>').addClass('lead-s mb-2').html('Orientations'));

    const row = $('<div/>').addClass('d-flex flex-wrap');
    ORIENTATIONS.forEach((o) => {
      const cell = $('<div/>').addClass('custom-control custom-checkbox mr-4 mb-1');
      const id = `publish-orient-${o.value}`;
      cell.append($('<input/>')
        .attr('type', 'checkbox')
        .attr('id', id)
        .attr('data-role', 'orientation')
        .attr('data-value', o.value)
        .addClass('custom-control-input')
        .prop('checked', true));
      cell.append($('<label/>')
        .addClass('custom-control-label')
        .attr('for', id)
        .text(o.label));
      row.append(cell);
    });
    section.append(row);
    return section;
  }

  createTemplateSection() {
    const section = $('<div/>').addClass('form-group px-0 mt-3 mb-3');
    section.append($('<p/>').addClass('lead-s mb-1').html('Job template'));
    section.append($('<p/>').addClass('lead-xs text-muted mb-2').html(
      'Each orientation uses its own MediaConvert job template. Pick one to '
      + 'download and tweak the JSON, then upload it back as an override (same '
      + 'name) or under a new name. The two built-in templates are picked '
      + 'automatically by orientation when you generate a bundle.'
    ));

    const row = $('<div/>').addClass('d-flex flex-wrap align-items-center');
    const select = $('<select/>')
      .addClass('custom-select custom-select-sm w-auto mr-2 mb-1')
      .attr('data-role', 'template');
    BUILTIN_TEMPLATES.forEach((t) => {
      select.append($('<option/>').attr('value', t.value).text(t.label));
    });
    row.append(select);

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

    const hiddenFile = $('<input/>').attr('type', 'file')
      .attr('accept', 'application/json,.json')
      .css('display', 'none')
      .attr('data-role', 'tmpl-file');
    row.append(hiddenFile);

    const status = $('<span/>')
      .addClass('lead-xs text-muted ml-2 mb-1')
      .attr('data-role', 'tmpl-status');
    row.append(status);
    section.append(row);

    downloadBtn.on('click', () => this.downloadTemplate());
    uploadBtn.on('click', () => {
      hiddenFile.data('mode', 'override');
      hiddenFile.trigger('click');
    });
    newBtn.on('click', () => {
      // Pick the file first; derive the name on change. window.prompt() before
      // .click() breaks the user-gesture chain so Chrome refuses to open the
      // file picker.
      hiddenFile.data('mode', 'new');
      hiddenFile.trigger('click');
    });
    deleteBtn.on('click', () => this.deleteSelectedTemplate());
    refreshBtn.on('click', () => this.refreshTemplateList());
    hiddenFile.on('change', () => {
      const file = hiddenFile[0].files[0];
      const mode = hiddenFile.data('mode');
      hiddenFile.val('');
      let newName;
      if (mode === 'new' && file) {
        newName = (file.name || '')
          .replace(/\.json$/i, '')
          .replace(/[^A-Za-z0-9_-]/g, '_')
          .slice(0, 64);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(newName)) {
          this.setTemplateStatus('Filename must yield A-Z, a-z, 0-9, _, - (max 64 chars).', 'err');
          return;
        }
      }
      this.uploadTemplateFile(file, mode, newName).catch((e) => {
        console.error(e);
        this.setTemplateStatus(`Upload failed: ${e.message}`, 'err');
      });
    });

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
      const select = this.$root().find('[data-role="template"]');
      const current = preferredValue || select.val() || 'mp4_landscape';
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
    const targetName = mode === 'new'
      ? newName
      : this.$root().find('[data-role="template"]').val();
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
    const name = this.$root().find('[data-role="template"]').val();
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
      const fallback = BUILTIN_TEMPLATES.find((b) => b.value === name) ? name : 'mp4_landscape';
      await this.refreshTemplateList(fallback);
    } catch (e) {
      console.error(e);
      this.setTemplateStatus(`Delete failed: ${e.message}`, 'err');
    }
  }

  createControls() {
    const wrap = $('<div/>').addClass('form-group px-0 mt-3 mb-3 d-flex flex-wrap align-items-center');

    const saveBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .attr('data-role', 'save')
      .html('Save Settings');
    const publishBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-primary mr-2 mb-1')
      .attr('data-role', 'publish')
      .html('Generate Bundle');
    const refreshBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-secondary mr-2 mb-1')
      .attr('data-role', 'refresh')
      .html('Refresh Status');
    const status = $('<span/>').addClass('lead-xs text-muted ml-2 mb-1')
      .attr('data-role', 'controls-status');

    wrap.append(saveBtn).append(publishBtn).append(refreshBtn).append(status);

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

  async loadSettings() {
    const uuid = this.media.uuid;
    try {
      this.setControlsStatus('Loading settings...');
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
    const enabled = Array.isArray(s.orientations) && s.orientations.length > 0
      ? s.orientations
      : ORIENTATIONS.map((o) => o.value);
    root.find('[data-role="orientation"]').each(function () {
      const v = $(this).attr('data-value');
      $(this).prop('checked', enabled.includes(v));
    });
  }

  collectSettings() {
    const root = this.$root();
    const orientations = [];
    root.find('[data-role="orientation"]').each(function () {
      if ($(this).prop('checked')) orientations.push($(this).attr('data-value'));
    });
    return { orientations };
  }

  async saveSettings() {
    const uuid = this.media.uuid;
    try {
      const settings = this.collectSettings();
      if (!settings.orientations.length) {
        this.setControlsStatus('Pick at least one orientation.', 'err');
        return;
      }
      this.setControlsStatus('Saving...');
      await ApiHelper.savePublishSettings(uuid, settings);
      this.setControlsStatus('Settings saved.', 'ok');
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Save failed: ${e.message}`, 'err');
    }
  }

  async startPublish() {
    const uuid = this.media.uuid;
    try {
      const settings = this.collectSettings();
      if (!settings.orientations.length) {
        this.setControlsStatus('Pick at least one orientation.', 'err');
        return;
      }
      this.setControlsStatus('Saving and submitting jobs...');
      await ApiHelper.savePublishSettings(uuid, settings);
      const job = await ApiHelper.startPublish(uuid, settings);
      this.setControlsStatus(`Submitted ${settings.orientations.length} job(s) · output ${job.outputId}`, 'ok');
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
      this.renderOutputs(null, (status && status.history) || []);
      return;
    }
    const escape = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmt = (k, v) => `<div><strong>${k}</strong>: <code>${escape(v)}</code></div>`;
    const rows = [];
    rows.push(fmt('Status', status.status || 'unknown'));
    if (status.outputId) rows.push(fmt('Output ID', status.outputId));
    if (status.sourceUri) rows.push(fmt('Source video', status.sourceUri));
    if (status.submittedAt) rows.push(fmt('Submitted', new Date(status.submittedAt).toISOString()));

    // Per-orientation job rows.
    const jobs = status.jobs || {};
    const orients = Object.keys(jobs);
    if (orients.length > 0) {
      rows.push('<div class="mt-2"><strong>Jobs</strong></div>');
      orients.forEach((orient) => {
        const j = jobs[orient] || {};
        const parts = [];
        parts.push(`<strong>${escape(orient)}</strong>`);
        parts.push(escape(j.status || 'unknown'));
        if (typeof j.jobPercentComplete === 'number') parts.push(`${j.jobPercentComplete}%`);
        if (j.currentPhase) parts.push(escape(j.currentPhase));
        if (j.errorCode) parts.push(`<span class="text-danger">err ${escape(j.errorCode)}</span>`);
        if (j.errorMessage) parts.push(`<span class="text-danger">${escape(j.errorMessage)}</span>`);
        if (j.jobId) parts.push(`<code class="lead-xxs">${escape(j.jobId)}</code>`);
        rows.push(`<div class="ml-2">${parts.join(' · ')}</div>`);
      });
    } else if (status.jobId) {
      // Legacy single-job status doc.
      rows.push(fmt('Job ID', status.jobId));
      if (typeof status.jobPercentComplete === 'number') {
        rows.push(fmt('Progress', `${status.jobPercentComplete}%`));
      }
      if (status.currentPhase) rows.push(fmt('Phase', status.currentPhase));
      if (status.errorCode) rows.push(fmt('Error code', status.errorCode));
      if (status.errorMessage) rows.push(fmt('Error', status.errorMessage));
    }

    this.setStatusBody(rows.join('\n'));

    const isComplete = status.status === 'COMPLETE';
    this.renderOutputs(isComplete ? (status.outputs || {}) : null, status.history || [], status);
  }

  renderOutputs(outputs, history, currentStatus) {
    const section = this.$root().find('[data-role="outputs-section"]');
    const body = this.$root().find('[data-role="outputs-body"]');
    body.empty();
    const hasCurrent = outputs && Object.keys(outputs).some((k) => outputs[k] && outputs[k].url);
    const hasLegacyCurrent = outputs && (outputs.hlsMaster || outputs.mp4);
    const hasHistory = Array.isArray(history) && history.length > 0;
    if (!hasCurrent && !hasLegacyCurrent && !hasHistory) {
      section.css('display', 'none');
      this.renderHistory([]);
      return;
    }
    section.css('display', '');
    if (hasCurrent || hasLegacyCurrent) {
      body.append(this.buildOutputRow(outputs, {
        outputId: currentStatus && currentStatus.outputId,
      }));
    }
    this.renderHistory(history || []);
  }

  buildOutputRow(outputs, opts) {
    const opts2 = opts || {};
    const wrap = $('<div/>').addClass('mb-3');

    const headingRow = $('<div/>').addClass('d-flex align-items-center mb-1');
    if (opts2.heading) {
      headingRow.append($('<div/>').addClass('lead-xs text-muted mr-auto').html(opts2.heading));
    } else {
      headingRow.append($('<div/>').addClass('mr-auto'));
    }
    if (opts2.outputId) {
      const delBtn = $('<button/>').attr('type', 'button')
        .addClass('btn btn-sm btn-outline-danger').html('Delete files');
      delBtn.on('click', () => {
        if (!window.confirm('Delete the rendered MP4(s) for this output?\n\nThis permanently removes the files from S3.')) return;
        delBtn.prop('disabled', true);
        this.deletePublishOutput(opts2.outputId).catch((e) => {
          console.error(e);
          delBtn.prop('disabled', false);
        });
      });
      headingRow.append(delBtn);
    }
    wrap.append(headingRow);

    // Per-orientation MP4 rows.
    ORIENTATIONS.forEach((o) => {
      const entry = outputs && outputs[o.value];
      if (!entry || !entry.url) return;
      const row = $('<div/>').addClass('mb-2');
      row.append($('<strong/>').html(`${o.label}: `));
      const filename = (entry.key || '').split('/').pop() || `${o.value}.mp4`;
      row.append($('<a/>').attr('href', entry.url).attr('download', filename).text('Download MP4'));
      if (typeof entry.size === 'number') {
        const mb = (entry.size / (1024 * 1024)).toFixed(1);
        row.append($('<span/>').addClass('lead-xxs text-muted ml-2').text(`${mb} MB`));
      }
      row.append($('<div/>').addClass('lead-xxs text-muted text-break').html(
        `<a href="${entry.url}" target="_blank">${entry.url}</a>`
      ));
      wrap.append(row);
    });

    // Legacy outputs (HLS master + single MP4) — keeps history rows from old
    // jobs viewable until the user deletes them.
    if (outputs && outputs.hlsMaster) {
      const row = $('<div/>').addClass('mb-2');
      row.append($('<strong/>').html('HLS master (legacy): '));
      row.append($('<a/>').attr('href', outputs.hlsMaster).attr('target', '_blank').text('Open'));
      wrap.append(row);
    }
    if (outputs && outputs.mp4 && !outputs.landscape && !outputs.portrait) {
      const row = $('<div/>').addClass('mb-2');
      row.append($('<strong/>').html('MP4 (legacy): '));
      const filename = (outputs.mp4Key || '').split('/').pop() || 'video.mp4';
      row.append($('<a/>').attr('href', outputs.mp4).attr('download', filename).text('Download'));
      wrap.append(row);
    }
    return wrap;
  }

  renderHistory(history) {
    const divider = this.$root().find('[data-role="history-divider"]');
    const title = this.$root().find('[data-role="history-title"]');
    const body = this.$root().find('[data-role="history-body"]');
    body.empty();
    const items = (history || []).filter((h) => h && h.outputs
      && (Object.keys(h.outputs).some((k) => h.outputs[k] && h.outputs[k].url)
        || h.outputs.hlsMaster || h.outputs.mp4));
    if (items.length === 0) {
      divider.css('display', 'none');
      title.css('display', 'none');
      return;
    }
    divider.css('display', '');
    title.css('display', '');
    items.forEach((h) => {
      const ts = h.finishedAt ? new Date(h.finishedAt).toLocaleString()
        : h.submittedAt ? new Date(h.submittedAt).toLocaleString() : '';
      const orients = Array.isArray(h.orientations) ? h.orientations.join(', ')
        : (h.template || '');
      const heading = `<strong>${orients}</strong> · ${ts || h.outputId || ''}`;
      body.append(this.buildOutputRow(h.outputs, { heading, outputId: h.outputId }));
    });
  }

  async deletePublishOutput(outputId) {
    const uuid = this.media.uuid;
    try {
      this.setControlsStatus(`Deleting ${outputId}...`);
      const res = await ApiHelper.deletePublishOutput(uuid, outputId);
      const n = (res && res.deleted) || 0;
      this.setControlsStatus(`Deleted ${n} file(s) for ${outputId}.`, 'ok');
      await this.refreshStatus();
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Delete failed: ${e.message}`, 'err');
    }
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
