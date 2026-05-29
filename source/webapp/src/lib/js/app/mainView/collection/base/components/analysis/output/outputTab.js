// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import mxAlert from '../../../../../../mixins/mxAlert.js';
import Localization from '../../../../../../shared/localization.js';
import Spinner from '../../../../../../shared/spinner.js';
import ApiHelper from '../../../../../../shared/apiHelper.js';
import {
  GetS3Utils,
} from '../../../../../../shared/s3utils.js';
import {
  RegisterIotMessageEvent,
  UnregisterIotMessageEvent,
} from '../../../../../../shared/iotSubscriber.js';
import BaseAnalysisTab from '../base/baseAnalysisTab.js';
import HighlightEditorModal from '../highlight/highlightEditorModal.js';

const {
  Messages: {
    OutputTab: TITLE,
  },
} = Localization;

const VIDEO_TYPE = 'video';
const DEFAULT_TEMPLATE = 'mp4_landscape';
const BUILTIN_TEMPLATES = [
  { value: 'mp4_landscape', label: 'Landscape MP4 (built-in)' },
  { value: 'mp4_portrait', label: 'Portrait MP4 (built-in)' },
];
const LOGO_SIZES = ['48', '64', '96', '128', '192'];
const ALLOWED_LOGO_EXT = ['png', 'jpg', 'jpeg'];
const STRATEGIES = [
  { value: 'multimodal', label: 'Multimodal VLM (sees video + audio)' },
  { value: 'transcript-llm', label: 'Transcript LLM (text-only)' },
];
// multimodal sends the video to a video-capable Bedrock model (Pegasus);
// transcript-llm uses any TEXT model.
const STRATEGY_CAPABILITY = {
  'transcript-llm': 'text',
  multimodal: 'video',
};
const MODES = [
  {
    value: 'full',
    label: 'Full video',
    desc: 'Re-encode the full source video with the chosen template.',
  },
  {
    value: 'highlights',
    label: 'Highlight cuts',
    desc: 'Stitch together highlight segments. Pick a highlight set and edit segments below.',
  },
];

export default class OutputTab extends mxAlert(BaseAnalysisTab) {
  constructor(previewComponent) {
    super(TITLE, previewComponent);
    Spinner.useSpinner();
    this.$state = {
      mode: 'full',
      template: DEFAULT_TEMPLATE,
      burnSubtitles: false,
      logos: {},
      editProjectId: null,
      activeRenderId: null,
      detect: {
        strategy: 'multimodal',
        modelId: '',
        prompt: '',
        maxSegments: 30,
        minConfidence: 0.7,
      },
    };
    this.$iotReceiverName = `output-tab-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  static canSupport(previewComponent) {
    if (previewComponent && previewComponent.media) {
      return previewComponent.media.type === VIDEO_TYPE;
    }
    return true;
  }

  async createContent() {
    const container = $('<div/>').addClass('col-11 my-4');
    container.append(this.createIntro());
    container.append(this.createModeSection());
    container.append(this.createTemplateSection());
    container.append(this.createHighlightSection());
    container.append(this.createAddonsSection());
    container.append(this.createControls());
    container.append(this.createStatusSection());
    container.append(this.createHistorySection());

    RegisterIotMessageEvent(this.$iotReceiverName, async (msg) => this._onIotMessage(msg));

    container.ready(() => this.bootstrap());
    return container;
  }

  async hide() {
    UnregisterIotMessageEvent(this.$iotReceiverName);
    return super.hide();
  }

  $root() {
    return this.tabContent.find('.col-11');
  }

  createIntro() {
    const wrap = $('<div/>').addClass('mb-3');
    wrap.append($('<p/>').addClass('lead mb-1').html('Output'));
    wrap.append($('<p/>').addClass('lead-xs text-muted mb-0').html(
      'Render and publish this video. By default the full source is re-encoded '
      + 'with the chosen MediaConvert template (HLS + MP4). Switch to '
      + '<em>Highlight cuts</em> to stitch segments from a highlight set. '
      + 'Burn-in subtitles and per-resolution logo overlays are optional add-ons.'
    ));
    return wrap;
  }

  createModeSection() {
    const section = $('<div/>').addClass('form-group px-0 mt-3 mb-3');
    section.append($('<p/>').addClass('lead-s mb-1').html('Source range'));
    const radios = $('<div/>');
    section.append(radios);

    MODES.forEach((m) => {
      const id = `output-mode-${m.value}`;
      const wrap = $('<div/>').addClass('custom-control custom-radio mb-1');
      const input = $('<input/>')
        .addClass('custom-control-input')
        .attr('type', 'radio')
        .attr('id', id)
        .attr('name', 'output-mode')
        .attr('value', m.value);
      if (m.value === this.$state.mode) input.attr('checked', 'checked');
      const label = $('<label/>').addClass('custom-control-label').attr('for', id);
      label.append($('<strong/>').text(m.label));
      label.append($('<span/>').addClass('lead-xs text-muted ml-2').text(m.desc));
      wrap.append(input).append(label);
      radios.append(wrap);
      input.on('change', () => {
        if (input.is(':checked')) this.setMode(m.value);
      });
    });

    return section;
  }

  setMode(mode) {
    this.$state.mode = mode;
    this.$root().find('[data-role="highlight-section"]').css('display', mode === 'highlights' ? '' : 'none');
  }

  createTemplateSection() {
    const section = $('<div/>').addClass('form-group px-0 mt-3 mb-3');
    section.append($('<p/>').addClass('lead-s mb-1').html('MediaConvert template'));
    section.append($('<p/>').addClass('lead-xs text-muted mb-2').html(
      'Defines orientation, scaling and codec settings. Built-in <code>mp4_landscape</code> '
      + 'and <code>mp4_portrait</code> ship HLS + MP4 outputs at QVBR-9. Custom templates '
      + 'are managed under Settings &rarr; MediaConvert templates.'
    ));

    const row = $('<div/>').addClass('d-flex flex-wrap align-items-center');
    const select = $('<select/>')
      .addClass('custom-select custom-select-sm w-auto mr-2 mb-1')
      .attr('data-role', 'template');
    BUILTIN_TEMPLATES.forEach((t) => {
      select.append($('<option/>').attr('value', t.value).text(t.label));
    });
    select.val(DEFAULT_TEMPLATE);
    row.append(select);

    const refreshBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-link mb-1')
      .attr('data-role', 'tmpl-refresh').html('Refresh list');
    row.append(refreshBtn);

    const status = $('<span/>').addClass('lead-xs text-muted ml-2 mb-1')
      .attr('data-role', 'tmpl-status');
    row.append(status);
    section.append(row);

    refreshBtn.on('click', () => this.refreshTemplateList());
    select.on('change', () => { this.$state.template = select.val(); });

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
    const select = this.$root().find('[data-role="template"]');
    try {
      this.setTemplateStatus('Loading templates...');
      const res = await ApiHelper.listMcTemplates();
      const templates = (res && res.templates) || [];
      const current = preferredValue || this.$state.template || select.val() || DEFAULT_TEMPLATE;
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
        this.$state.template = current;
      } else if (select.children().length > 0) {
        this.$state.template = select.val();
      }
      this.setTemplateStatus(`${templates.length} template(s) available.`, 'ok');
    } catch (e) {
      console.error(e);
      this.setTemplateStatus(`Error loading templates: ${e.message}`, 'err');
    }
  }

  createHighlightSection() {
    const section = $('<div/>')
      .addClass('form-group px-0 mt-3 mb-3 border rounded p-3')
      .attr('data-role', 'highlight-section')
      .css('display', 'none');
    section.append($('<p/>').addClass('lead-s mb-2').html('Highlight cuts'));
    section.append($('<p/>').addClass('lead-xs text-muted mb-2').html(
      'Pick an existing highlight set or run detection. Use <em>Open editor</em> '
      + 'to trim, reorder, or add custom segments — the editor renders directly '
      + 'with all the settings on this page.'
    ));

    const row = $('<div/>').addClass('d-flex flex-wrap align-items-center mb-2');
    const select = $('<select/>')
      .addClass('custom-select custom-select-sm w-auto mr-2 mb-1')
      .attr('data-role', 'highlight-set-select');
    select.append($('<option/>').attr('value', '').text('Loading…'));
    row.append(select);

    const editBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-primary mr-2 mb-1')
      .attr('data-role', 'open-editor')
      .html('Open editor');
    editBtn.on('click', () => this.openEditorForSelectedHighlightSet());
    row.append(editBtn);

    const refreshBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-link mr-2 mb-1')
      .attr('data-role', 'highlights-refresh').html('Refresh list');
    refreshBtn.on('click', () => this.refreshHighlightSets());
    row.append(refreshBtn);

    const deleteBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-danger mb-1')
      .attr('data-role', 'highlights-delete')
      .attr('title', 'Delete the selected highlight set')
      .html('✖ Delete');
    deleteBtn.on('click', () => this.deleteSelectedHighlightSet());
    row.append(deleteBtn);

    section.append(row);

    const status = $('<div/>').addClass('lead-xs text-muted')
      .attr('data-role', 'highlights-status');
    section.append(status);

    // In-flight banner: filled in by refreshHighlightSets when a row is
    // PROCESSING. Empty (display:none) otherwise.
    const banner = $('<div/>')
      .attr('data-role', 'highlights-inflight')
      .addClass('mt-2 p-2 rounded border bg-light lead-xs')
      .css('display', 'none');
    section.append(banner);

    section.append(this.createDetectForm());

    return section;
  }

  createDetectForm() {
    const wrap = $('<div/>')
      .addClass('mt-3 pt-3 border-top')
      .attr('data-role', 'detect-form');

    wrap.append($('<p/>').addClass('lead-s mb-1').html('Run detection'));
    wrap.append($('<p/>').addClass('lead-xs text-muted mb-2').html(
      'Pick a strategy and Bedrock model, optionally tune the prompt. '
      + 'Min confidence (0–1) is the primary quality filter — only segments scoring at or above it survive. '
      + 'Max segments is a runaway ceiling. '
      + 'Results land as a new highlight set in the dropdown above.'
    ));

    const grid = $('<div/>').addClass('d-flex flex-wrap');
    wrap.append(grid);

    const strategyGroup = this.makeFormGroup('Strategy');
    const strategySelect = $('<select/>').addClass('custom-select custom-select-sm')
      .attr('data-role', 'detect-strategy');
    STRATEGIES.forEach((s) => {
      strategySelect.append($('<option/>').attr('value', s.value).text(s.label));
    });
    strategySelect.val(this.$state.detect.strategy);
    strategySelect.on('change', () => {
      this.$state.detect.strategy = strategySelect.val();
      this.reloadDetectModelOptions();
    });
    strategyGroup.append(strategySelect);
    grid.append(strategyGroup);

    const modelGroup = this.makeFormGroup('Model');
    const modelSelect = $('<select/>').addClass('custom-select custom-select-sm')
      .attr('data-role', 'detect-model');
    modelSelect.append($('<option/>').attr('value', '').text('(default)'));
    modelSelect.on('change', () => {
      this.$state.detect.modelId = modelSelect.val();
    });
    modelGroup.append(modelSelect);
    grid.append(modelGroup);

    const confGroup = this.makeFormGroup('Min confidence');
    const confInput = $('<input/>').addClass('form-control form-control-sm')
      .attr('type', 'number').attr('min', '0').attr('max', '1').attr('step', '0.05')
      .attr('data-role', 'detect-min-confidence')
      .val(this.$state.detect.minConfidence);
    confInput.on('input', () => {
      const v = Number(confInput.val());
      const safe = Number.isFinite(v) ? v : 0.7;
      this.$state.detect.minConfidence = Math.max(0, Math.min(1, safe));
    });
    confGroup.append(confInput);
    grid.append(confGroup);

    const maxGroup = this.makeFormGroup('Max segments (ceiling)');
    const maxInput = $('<input/>').addClass('form-control form-control-sm')
      .attr('type', 'number').attr('min', '1').attr('max', '100')
      .attr('data-role', 'detect-max')
      .val(this.$state.detect.maxSegments);
    maxInput.on('input', () => {
      const v = Number(maxInput.val()) || 30;
      this.$state.detect.maxSegments = Math.max(1, Math.min(100, v));
    });
    maxGroup.append(maxInput);
    grid.append(maxGroup);

    const promptGroup = $('<div/>').addClass('w-100 px-0 mt-2 mb-2');
    promptGroup.append($('<label/>').addClass('lead-xs text-muted mb-1')
      .text('Custom prompt (optional)'));
    const promptInput = $('<textarea/>').addClass('form-control form-control-sm')
      .attr('rows', '2').attr('data-role', 'detect-prompt')
      .attr('placeholder', 'Override the default highlight prompt — e.g. "find dramatic moments in this lecture"')
      .val(this.$state.detect.prompt);
    promptInput.on('input', () => {
      this.$state.detect.prompt = promptInput.val();
    });
    promptGroup.append(promptInput);
    wrap.append(promptGroup);

    const submitRow = $('<div/>').addClass('d-flex align-items-center mt-2');
    const submitBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-primary mr-2')
      .attr('data-role', 'detect-submit')
      .html('Detect highlights');
    submitBtn.on('click', () => this.runHighlightDetection());
    submitRow.append(submitBtn);
    wrap.append(submitRow);

    return wrap;
  }

  makeFormGroup(label) {
    const group = $('<div/>').addClass('form-group mr-3 mb-2');
    group.append($('<label/>').addClass('lead-xs text-muted mb-1 d-block').text(label));
    return group;
  }

  async reloadDetectModelOptions() {
    const select = this.$root().find('[data-role="detect-model"]');
    if (select.length === 0) return;
    const capability = STRATEGY_CAPABILITY[this.$state.detect.strategy] || 'text';
    const previous = this.$state.detect.modelId;
    select.empty();
    select.append($('<option/>').attr('value', '').text('(default)'));
    try {
      const res = await ApiHelper.getModels(capability);
      const providers = (res && res.providers) || {};
      Object.keys(providers).sort().forEach((provider) => {
        const optgroup = $('<optgroup/>').attr('label', provider);
        (providers[provider] || []).forEach((m) => {
          optgroup.append($('<option/>').attr('value', m.id).text(m.name));
        });
        if (optgroup.children().length > 0) select.append(optgroup);
      });
    } catch (e) {
      console.error('getModels failed:', e);
    }
    if (previous && select.find(`option[value="${previous}"]`).length > 0) {
      select.val(previous);
    } else {
      this.$state.detect.modelId = '';
      select.val('');
    }
  }

  async refreshHighlightSets(preferredId) {
    const select = this.$root().find('[data-role="highlight-set-select"]');
    const status = this.$root().find('[data-role="highlights-status"]');
    try {
      const res = await ApiHelper.listHighlightSets(this.media.uuid);
      const sets = (res && res.highlightSets) || [];
      sets.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      select.empty();
      if (sets.length === 0) {
        select.append($('<option/>').attr('value', '').text('(no sets — run detection)'));
        status.text('No highlight sets yet.');
        this.renderHighlightInflight(null);
        this.applyHighlightSetSelectability();
        return;
      }
      sets.forEach((s) => {
        const ts = s.createdAt ? new Date(s.createdAt).toLocaleString() : s.highlightSetId.slice(0, 8);
        const cnt = (s.segments || []).length || s.segmentCount || 0;
        const st = s.status || 'COMPLETED';
        let label;
        if (st === 'PROCESSING') {
          label = `⚙ ${ts} · ${s.strategy || '-'} · running`;
        } else if (st === 'FAILED') {
          const err = (s.error || 'failed').slice(0, 60);
          label = `✗ ${ts} · ${s.strategy || '-'} · ${err}`;
        } else {
          label = `${ts} · ${s.strategy || '-'} · ${cnt} seg`;
        }
        select.append($('<option/>')
          .attr('value', s.highlightSetId)
          .attr('data-status', st)
          .text(label));
      });
      // Prefer the most recent COMPLETED set so the editor/render flow
      // keeps targeting usable rows; fall back to whichever row exists.
      const completed = sets.filter((s) => (s.status || 'COMPLETED') === 'COMPLETED');
      const target = preferredId
        || (this.$state.mode === 'highlights' && this.$state.editProjectId
          && sets.find((s) => s.highlightSetId === this.$state.editProjectId)
          && this.$state.editProjectId)
        || (completed[0] && completed[0].highlightSetId)
        || sets[0].highlightSetId;
      select.val(target);
      const completedCount = completed.length;
      const processingCount = sets.filter((s) => s.status === 'PROCESSING').length;
      const failedCount = sets.filter((s) => s.status === 'FAILED').length;
      const parts = [`${completedCount} ready`];
      if (processingCount > 0) parts.push(`${processingCount} running`);
      if (failedCount > 0) parts.push(`${failedCount} failed`);
      status.text(parts.join(' · '));
      const inflight = sets.find((s) => s.status === 'PROCESSING');
      this.renderHighlightInflight(inflight || null);
      this.applyHighlightSetSelectability();
      select.off('change.inflight').on('change.inflight', () => this.applyHighlightSetSelectability());
    } catch (e) {
      console.error(e);
      status.text(`Error loading highlight sets: ${e.message}`);
    }
  }

  renderHighlightInflight(row) {
    const banner = this.$root().find('[data-role="highlights-inflight"]');
    if (!row) {
      banner.empty().css('display', 'none');
      return;
    }
    const e = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ts = row.createdAt ? new Date(row.createdAt).toLocaleString() : '';
    const phase = row.phase ? ` · phase ${e(row.phase)}` : '';
    const pct = (typeof row.percent === 'number') ? ` · ${row.percent}%` : '';
    banner.html(
      `<strong>⚙ Detecting highlights…</strong> ${e(row.strategy || '-')}`
      + `${pct} · started ${e(ts)}${phase}<br>`
      + '<span class="text-muted">Status will update automatically. '
      + 'You can leave this page — the run continues server-side.</span>'
    ).css('display', '');
  }

  applyHighlightSetSelectability() {
    const select = this.$root().find('[data-role="highlight-set-select"]');
    const editBtn = this.$root().find('[data-role="open-editor"]');
    const opt = select.find(`option[value="${select.val()}"]`);
    const st = opt.attr('data-status') || 'COMPLETED';
    const usable = st === 'COMPLETED' || st === '' || st == null;
    editBtn.prop('disabled', !usable);
    editBtn.attr('title', usable ? '' : `Cannot edit — set is ${st}`);
  }

  async deleteSelectedHighlightSet() {
    const select = this.$root().find('[data-role="highlight-set-select"]');
    const status = this.$root().find('[data-role="highlights-status"]');
    const highlightSetId = select.val();
    if (!highlightSetId) {
      status.text('No highlight set selected.');
      return;
    }
    const label = select.find(`option[value="${highlightSetId}"]`).text() || highlightSetId;
    if (!window.confirm(`Delete highlight set:\n\n${label}\n\nThis cannot be undone.`)) return;
    try {
      status.text('Deleting…');
      await ApiHelper.deleteHighlightSet(this.media.uuid, highlightSetId);
      // If the user had this set selected as their active edit project, clear
      // it so the next render doesn't try to read a deleted row.
      if (this.$state.editProjectId === highlightSetId) {
        this.$state.editProjectId = null;
      }
      await this.refreshHighlightSets();
    } catch (e) {
      console.error(e);
      status.text(`Failed to delete: ${e.message}`);
    }
  }

  async runHighlightDetection() {
    const status = this.$root().find('[data-role="highlights-status"]');
    const submitBtn = this.$root().find('[data-role="detect-submit"]');
    const conf = Number(this.$state.detect.minConfidence);
    const body = {
      strategy: this.$state.detect.strategy,
      maxSegments: Number(this.$state.detect.maxSegments) || 30,
      minConfidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.7,
    };
    if (this.$state.detect.modelId) body.modelId = this.$state.detect.modelId;
    const trimmed = (this.$state.detect.prompt || '').trim();
    if (trimmed.length > 0) body.prompt = trimmed;
    try {
      submitBtn.attr('disabled', 'disabled');
      status.text('Submitting detection…');
      await ApiHelper.startHighlightDetection(this.media.uuid, body);
      status.text('Detection submitted.');
      // Pull the PROCESSING row immediately so the in-flight banner and
      // dropdown reflect the new run without waiting for the first IoT
      // event to land.
      this.refreshHighlightSets().catch(() => {});
    } catch (e) {
      console.error(e);
      status.text(`Failed to start detection: ${e.message}`);
    } finally {
      submitBtn.removeAttr('disabled');
    }
  }

  async openEditorForSelectedHighlightSet() {
    const select = this.$root().find('[data-role="highlight-set-select"]');
    const highlightSetId = select.val();
    if (!highlightSetId) {
      this.setControlsStatus('Pick or detect a highlight set first.', 'err');
      return;
    }
    try {
      const res = await ApiHelper.listHighlightSets(this.media.uuid);
      const sets = (res && res.highlightSets) || [];
      const found = sets.find((s) => s.highlightSetId === highlightSetId);
      if (!found) throw new Error(`highlight set ${highlightSetId} not found`);
      const onSaved = (editProject) => {
        this.$state.editProjectId = editProject && editProject.editProjectId;
      };
      const modal = new HighlightEditorModal(this.previewComponent, found, { onSaved });
      await modal.open();
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Failed to open editor: ${e.message}`, 'err');
    }
  }

  createAddonsSection() {
    const section = $('<div/>').addClass('form-group px-0 mt-3 mb-3 border rounded p-3');
    section.append($('<p/>').addClass('lead-s mb-2').html('Optional add-ons'));

    // Burn-in subtitles
    const subWrap = $('<div/>').addClass('custom-control custom-checkbox mb-3');
    const subId = `output-burn-subs-${Math.floor(Math.random() * 1e6)}`;
    const subInput = $('<input/>')
      .addClass('custom-control-input')
      .attr('type', 'checkbox')
      .attr('id', subId)
      .attr('data-role', 'burn-subtitles');
    const subLabel = $('<label/>').addClass('custom-control-label').attr('for', subId);
    subLabel.append($('<strong/>').text('Burn-in subtitles'));
    subLabel.append($('<span/>').addClass('lead-xs text-muted ml-2').text(
      'Uses the latest AI-edited SRT from the Transcribe tab.'
    ));
    subWrap.append(subInput).append(subLabel);
    section.append(subWrap);
    subInput.on('change', () => {
      this.$state.burnSubtitles = subInput.is(':checked');
    });

    // Logo overlays
    section.append($('<p/>').addClass('lead-s mt-3 mb-1').html('Logo overlays'));
    section.append($('<p/>').addClass('lead-xs text-muted mb-2').html(
      'Upload one PNG/JPG per output resolution. The render picks the closest size '
      + 'for each output. PNG with transparency is recommended.'
    ));

    const grid = $('<div/>').addClass('row no-gutters');
    LOGO_SIZES.forEach((size) => {
      grid.append(this.createLogoCell(size));
    });
    section.append(grid);

    return section;
  }

  createLogoCell(size) {
    const col = $('<div/>').addClass('col-12 col-md-6 col-lg-4 px-0 pr-3 mb-2');
    const wrap = $('<div/>').addClass('d-flex flex-wrap align-items-center');
    wrap.append($('<span/>').addClass('lead-xs mr-2').css('width', '6em').text(`${size}px tall`));

    const fileId = `output-logo-${size}-${Math.floor(Math.random() * 1e6)}`;
    const fileInput = $('<input/>').attr('type', 'file').attr('id', fileId).attr('accept', 'image/png,image/jpeg').css('display', 'none');
    const pickBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .text('Upload')
      .attr('data-role', `logo-pick-${size}`);
    pickBtn.on('click', () => fileInput.trigger('click'));
    const delBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-danger mr-2 mb-1')
      .text('Remove')
      .attr('data-role', `logo-del-${size}`)
      .css('display', 'none');
    delBtn.on('click', () => this.deleteLogo(size));
    const status = $('<span/>').addClass('lead-xs text-muted mb-1')
      .attr('data-role', `logo-status-${size}`);

    fileInput.on('change', async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      await this.uploadLogo(size, file);
      ev.target.value = '';
    });

    wrap.append(fileInput).append(pickBtn).append(delBtn).append(status);
    col.append(wrap);
    return col;
  }

  async uploadLogo(size, file) {
    const status = this.$root().find(`[data-role="logo-status-${size}"]`);
    const lower = (file.name || '').toLowerCase();
    let ext = lower.split('.').pop();
    if (ext === 'jpg') ext = 'jpg';
    if (!ALLOWED_LOGO_EXT.includes(ext)) {
      status.text('Unsupported file type — use PNG or JPG.').removeClass('text-success').addClass('text-danger');
      return;
    }
    try {
      status.text('Requesting upload URL…').removeClass('text-danger text-success').addClass('text-muted');
      const presign = await ApiHelper.presignLogoUpload(this.media.uuid, { size, ext });
      status.text('Uploading…');
      const put = await fetch(presign.url, {
        method: 'PUT',
        headers: { 'Content-Type': presign.contentType },
        body: file,
      });
      if (!put.ok) {
        throw new Error(`upload failed (${put.status})`);
      }
      this.$state.logos = { ...(this.$state.logos || {}), [size]: presign.s3uri };
      this.$root().find(`[data-role="logo-del-${size}"]`).css('display', '');
      status.text(`Uploaded · ${file.name}`).removeClass('text-muted text-danger').addClass('text-success');
    } catch (e) {
      console.error(e);
      status.text(`Upload failed: ${e.message}`).removeClass('text-muted text-success').addClass('text-danger');
    }
  }

  async deleteLogo(size) {
    const status = this.$root().find(`[data-role="logo-status-${size}"]`);
    try {
      status.text('Deleting…').removeClass('text-success text-danger').addClass('text-muted');
      await ApiHelper.deleteLogo(this.media.uuid, size);
      const next = { ...(this.$state.logos || {}) };
      delete next[size];
      this.$state.logos = next;
      this.$root().find(`[data-role="logo-del-${size}"]`).css('display', 'none');
      status.text('Removed.');
    } catch (e) {
      console.error(e);
      status.text(`Delete failed: ${e.message}`).removeClass('text-muted text-success').addClass('text-danger');
    }
  }

  createControls() {
    const wrap = $('<div/>').addClass('form-group px-0 mt-3 mb-3 d-flex flex-wrap align-items-center');
    const saveBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .attr('data-role', 'save')
      .html('Save settings');
    const renderBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-primary mr-2 mb-1')
      .attr('data-role', 'render')
      .html('Render &amp; publish');
    const refreshBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-secondary mr-2 mb-1')
      .attr('data-role', 'refresh')
      .html('Refresh history');
    const status = $('<span/>').addClass('lead-xs text-muted ml-2 mb-1')
      .attr('data-role', 'controls-status');
    wrap.append(saveBtn).append(renderBtn).append(refreshBtn).append(status);

    saveBtn.on('click', () => this.saveSettings());
    renderBtn.on('click', () => this.startRender());
    refreshBtn.on('click', () => this.refreshHistory());
    return wrap;
  }

  setControlsStatus(text, kind) {
    const el = this.$root().find('[data-role="controls-status"]');
    el.removeClass('text-muted text-success text-danger');
    if (kind === 'ok') el.addClass('text-success');
    else if (kind === 'err') el.addClass('text-danger');
    else el.addClass('text-muted');
    el.html(text || '');
  }

  createStatusSection() {
    const section = $('<div/>')
      .addClass('form-group px-0 mt-3 mb-3 border rounded p-3')
      .attr('data-role', 'status-section');
    section.append($('<p/>').addClass('lead-s mb-2').html('Current job'));
    section.append($('<div/>').addClass('lead-xs').attr('data-role', 'status-body').html('Idle.'));
    return section;
  }

  setStatusBody(html) {
    this.$root().find('[data-role="status-body"]').html(html);
  }

  createHistorySection() {
    const section = $('<div/>')
      .addClass('form-group px-0 mt-3 mb-3 border rounded p-3')
      .attr('data-role', 'history-section');
    section.append($('<p/>').addClass('lead-s mb-2').html('Recent renders'));
    section.append($('<div/>').addClass('lead-xs').attr('data-role', 'history-body').text('No renders yet.'));
    return section;
  }

  async bootstrap() {
    // Load templates first so the picker doesn't show only built-ins.
    await this.refreshTemplateList().catch(() => {});

    // Try to find an existing edit project for this asset; if none, leave
    // editProjectId null and create one on save/render.
    try {
      const res = await ApiHelper.listEditProjects(this.media.uuid);
      const projects = ((res && res.editProjects) || []).slice()
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const existing = projects[0];
      if (existing) {
        this.applyEditProject(existing);
      }
    } catch (e) {
      console.error('listEditProjects failed:', e);
    }

    // Pre-load highlight set list so the dropdown isn't empty when user flips
    // to highlights mode.
    this.refreshHighlightSets().catch(() => {});
    this.reloadDetectModelOptions().catch(() => {});

    // Pull render history scoped to the asset uuid — works whether or not
    // an edit project has been created yet.
    this.refreshHistory().catch(() => {});
  }

  applyEditProject(ep) {
    this.$state.editProjectId = ep.editProjectId || null;
    if (ep.mode && MODES.find((m) => m.value === ep.mode)) {
      this.$state.mode = ep.mode;
      this.$root().find(`input[name="output-mode"][value="${ep.mode}"]`)
        .prop('checked', true).trigger('change');
    }
    if (typeof ep.template === 'string' && ep.template.length > 0) {
      this.$state.template = ep.template;
      const select = this.$root().find('[data-role="template"]');
      if (select.find(`option[value="${ep.template}"]`).length > 0) {
        select.val(ep.template);
      }
    }
    if (typeof ep.burnSubtitles === 'boolean') {
      this.$state.burnSubtitles = ep.burnSubtitles;
      this.$root().find('[data-role="burn-subtitles"]').prop('checked', ep.burnSubtitles);
    }
    if (ep.logos && typeof ep.logos === 'object') {
      this.$state.logos = { ...ep.logos };
      LOGO_SIZES.forEach((size) => {
        if (ep.logos[size]) {
          this.$root().find(`[data-role="logo-del-${size}"]`).css('display', '');
          this.$root().find(`[data-role="logo-status-${size}"]`)
            .text('Uploaded earlier.').removeClass('text-muted text-danger')
            .addClass('text-success');
        }
      });
    }
  }

  buildPayload() {
    // Segments are managed by HighlightEditorModal and live on the same
    // edit-project row (editProjectId === highlightSetId). The api merges
    // by editProjectId, so omitting segments here preserves whatever the
    // modal saved. Compose-edl ignores segments in full mode, so we never
    // need to overwrite them from this tab.
    const payload = {
      uuid: this.media.uuid,
      mode: this.$state.mode,
      template: this.$state.template || DEFAULT_TEMPLATE,
      burnSubtitles: !!this.$state.burnSubtitles,
      logos: this.$state.logos || {},
    };
    if (this.$state.editProjectId) {
      payload.editProjectId = this.$state.editProjectId;
    }
    return payload;
  }

  async saveSettings() {
    try {
      this.setControlsStatus('Saving…');
      const payload = this.buildPayload();
      const saved = await this.persistEditProject(payload);
      this.$state.editProjectId = saved.editProjectId || this.$state.editProjectId;
      this.setControlsStatus('Settings saved.', 'ok');
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Save failed: ${e.message}`, 'err');
    }
  }

  async persistEditProject(payload) {
    if (this.$state.editProjectId) {
      return ApiHelper.saveEditProject(this.$state.editProjectId, payload);
    }
    return ApiHelper.createEditProject(payload);
  }

  async startRender() {
    try {
      const payload = this.buildPayload();

      if (this.$state.mode === 'highlights') {
        const select = this.$root().find('[data-role="highlight-set-select"]');
        const highlightSetId = select.val();
        if (!highlightSetId) {
          this.setControlsStatus('Pick a highlight set or run detection.', 'err');
          return;
        }
        // Highlight cuts use the highlight set id as the edit project id.
        // The HighlightEditorModal seeds segments there; if the user hasn't
        // opened it, the row exists from saveEditProject below using whatever
        // segments are currently on /edits/{highlightSetId}.
        payload.editProjectId = highlightSetId;
        this.$state.editProjectId = highlightSetId;
      }

      this.setControlsStatus('Saving and submitting render…');
      const saved = await this.persistEditProject(payload);
      this.$state.editProjectId = saved.editProjectId || this.$state.editProjectId;

      const renderArgs = { editProjectId: this.$state.editProjectId };
      if (payload.template) renderArgs.template = payload.template;

      const res = await ApiHelper.startRender(renderArgs);
      this.$state.activeRenderId = (res && res.renderId) || null;
      this.setControlsStatus(`Submitted render ${this.$state.activeRenderId || ''}.`, 'ok');
      this.refreshHistory().catch(() => {});
    } catch (e) {
      console.error(e);
      this.setControlsStatus(`Render failed: ${e.message}`, 'err');
    }
  }

  async refreshHistory() {
    // Scope by asset uuid so history is consistent across modes — each mode
    // creates a separate edit project (full = generated id, highlights =
    // highlight-set id), so an editProjectId-scoped listing would hide the
    // other mode's renders.
    if (!this.media || !this.media.uuid) {
      this.$root().find('[data-role="history-body"]').text('No renders yet.');
      return;
    }
    try {
      const res = await ApiHelper.listRenders({ uuid: this.media.uuid });
      const rows = ((res && res.renders) || []).slice().sort((a, b) =>
        String(b.updatedAt || b.submittedAt || '').localeCompare(
          String(a.updatedAt || a.submittedAt || '')));
      this.renderHistory(rows);

      // Surface the most recent in-flight render up in the status section.
      const inflight = rows.find((r) =>
        r && r.status && r.status !== 'completed' && r.status !== 'error');
      if (inflight) {
        this.$state.activeRenderId = inflight.renderId;
        this.setStatusBody(this.statusHtml(inflight));
      } else if (rows[0]) {
        this.setStatusBody(this.statusHtml(rows[0]));
      } else {
        this.setStatusBody('Idle.');
      }
    } catch (e) {
      console.error(e);
      this.$root().find('[data-role="history-body"]')
        .html(`<span class="text-danger">Error: ${e.message}</span>`);
    }
  }

  statusHtml(row) {
    if (!row) return 'Idle.';
    const e = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts = [];
    const status = row.status || 'unknown';
    parts.push(`<strong>Status</strong>: <code>${e(status)}</code>`);
    // Only show percent while in flight — MediaConvert can return 0 on
    // COMPLETE, and "completed · 0%" reads as a stalled job.
    if (typeof row.percent === 'number'
      && status !== 'completed'
      && status !== 'error') {
      parts.push(`${row.percent}%`);
    }
    if (row.template) parts.push(`template <code>${e(row.template)}</code>`);
    if (row.renderId) parts.push(`<code class="lead-xxs">${e(row.renderId)}</code>`);
    if (row.errorMessage) parts.push(`<span class="text-danger">${e(row.errorMessage)}</span>`);
    return parts.join(' · ');
  }

  renderHistory(rows) {
    const body = this.$root().find('[data-role="history-body"]');
    body.empty();
    if (!rows || rows.length === 0) {
      body.text('No renders yet.');
      return;
    }
    rows.forEach((row) => body.append(this.buildHistoryRow(row)));
  }

  buildHistoryRow(row) {
    const wrap = $('<div/>').addClass('d-flex align-items-center py-1 border-bottom')
      .attr('data-render-id', row.renderId);
    const ts = (row.updatedAt || row.submittedAt) ? new Date(row.updatedAt || row.submittedAt).toLocaleString() : '';
    const idShort = (row.renderId || '').slice(0, 8);
    const status = row.status || 'unknown';
    const showPct = typeof row.percent === 'number'
      && row.percent > 0
      && status !== 'completed'
      && status !== 'error';
    const meta = $('<span/>').addClass('mr-auto text-truncate').css('minWidth', 0)
      .text(`${idShort} · ${ts} · ${status}${showPct ? ` (${row.percent}%)` : ''}`);
    wrap.append(meta);

    const actions = $('<span/>').addClass('ml-2');
    if (status === 'completed') {
      const playBtn = $('<a/>').attr('target', '_blank').attr('rel', 'noopener noreferrer')
        .addClass('btn btn-sm btn-outline-primary mr-1 disabled')
        .css({ pointerEvents: 'none' }).text('▶ Play');
      const dlBtn = $('<a/>').addClass('btn btn-sm btn-outline-secondary mr-1 disabled')
        .css({ pointerEvents: 'none' }).text('⬇ Download');
      actions.append(playBtn).append(dlBtn);
      this.signRenderUrls(row).then((urls) => {
        if (!urls) return;
        playBtn.attr('href', urls.playUrl).removeClass('disabled').css({ pointerEvents: '' });
        dlBtn.attr('href', urls.downloadUrl).removeClass('disabled').css({ pointerEvents: '' });
      }).catch((e) => {
        console.error('failed to sign render output:', e);
        meta.append($('<span/>').addClass('text-danger ml-2').text(' (output unavailable)'));
      });
    } else if (status === 'error') {
      meta.addClass('text-danger');
    }

    const delBtn = $('<button/>').attr('type', 'button')
      .addClass('btn btn-sm btn-outline-danger').text('Delete');
    delBtn.on('click', async () => {
      delBtn.prop('disabled', true);
      try {
        await ApiHelper.deleteRender(row.renderId);
        wrap.remove();
        if (this.$state.activeRenderId === row.renderId) {
          this.$state.activeRenderId = null;
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

  async signRenderUrls(row) {
    const prefix = ((row || {}).outputs || {}).mp4;
    if (!prefix) return null;
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(prefix);
    if (!m) return null;
    const bucket = m[1];
    const key = m[2];

    const s3 = GetS3Utils();
    const items = await s3.listObjects(bucket, key);
    const mp4 = (items || []).find((it) =>
      it && typeof it.Key === 'string' && it.Key.toLowerCase().endsWith('.mp4'));
    if (!mp4) return null;
    const filename = mp4.Key.split('/').pop() || 'render.mp4';
    const [playUrl, downloadUrl] = await Promise.all([
      s3.signUrl(bucket, mp4.Key),
      s3.signUrl(bucket, mp4.Key, {
        responseContentDisposition: `attachment; filename="${filename}"`,
      }),
    ]);
    return { playUrl, downloadUrl };
  }

  async _onIotMessage(msg) {
    if (!msg) return;
    if (msg.type === 'render') {
      if (this.$state.activeRenderId && msg.renderId !== this.$state.activeRenderId) return;
      this.refreshHistory().catch(() => {});
    } else if (msg.type === 'detect-highlight'
      && this.media && msg.uuid === this.media.uuid) {
      // Re-pull on every detect-highlight event for this asset so the
      // dropdown labels and in-flight banner stay in sync with the run
      // (started → processing → completed/error).
      this.refreshHighlightSets().catch(() => {});
    }
  }
}
