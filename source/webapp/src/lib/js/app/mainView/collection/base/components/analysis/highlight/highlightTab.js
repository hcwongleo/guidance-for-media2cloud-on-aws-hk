// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import SolutionManifest from '/solution-manifest.js';
import Localization from '../../../../../../shared/localization.js';
import ApiHelper from '../../../../../../shared/apiHelper.js';
import Spinner from '../../../../../../shared/spinner.js';
import BaseMedia from '../../../../../../shared/media/baseMedia.js';
import BaseAnalysisTab from '../base/baseAnalysisTab.js';
import mxAlert from '../../../../../../mixins/mxAlert.js';
import HighlightEditorModal from './highlightEditorModal.js';

class AlertHelper extends mxAlert(class {}) {}
const _alertAgent = new AlertHelper();

const {
  FoundationModels = [],
} = SolutionManifest;

const {
  Messages: {
    HighlightTab: TITLE,
    HighlightTabDesc: MSG_DESC,
    HighlightSetsTitle: MSG_SETS_TITLE,
    HighlightSetsEmpty: MSG_SETS_EMPTY,
    HighlightDetectTitle: MSG_DETECT_TITLE,
    HighlightStrategy: MSG_STRATEGY,
    HighlightStrategyAuto: MSG_STRATEGY_AUTO,
    HighlightStrategyTranscript: MSG_STRATEGY_TRANSCRIPT,
    HighlightModel: MSG_MODEL,
    HighlightDefaultModel: MSG_DEFAULT_MODEL,
    HighlightCustomPrompt: MSG_PROMPT,
    HighlightMaxSegments: MSG_MAX_SEGMENTS,
  },
  Tooltips: {
    DetectHighlights: TP_DETECT,
    HighlightStrategy: TP_STRATEGY,
    HighlightModelTooltip: TP_MODEL,
    HighlightCustomPromptTooltip: TP_PROMPT,
    HighlightMaxSegmentsTooltip: TP_MAX_SEGMENTS,
    ViewHighlightSet: TP_VIEW,
    OpenHighlightEditor: TP_OPEN_EDITOR,
  },
  Buttons: {
    DetectHighlights: BTN_DETECT,
    ViewHighlightSet: BTN_VIEW,
    OpenHighlightEditor: BTN_OPEN_EDITOR,
  },
  Alerts: {
    Oops: OOPS,
    HighlightDetectionStarted: ALERT_STARTED,
    HighlightDetectionFailed: ALERT_FAILED,
    NoHighlightTranscript: ALERT_NO_TRANSCRIPT,
  },
} = Localization;

const STRATEGIES = [
  { value: 'auto', label: MSG_STRATEGY_AUTO },
  { value: 'transcript-llm', label: MSG_STRATEGY_TRANSCRIPT },
];

const VIDEO_TYPE = 'video';

export default class HighlightTab extends BaseAnalysisTab {
  constructor(previewComponent) {
    super(TITLE, previewComponent);

    this.$formState = {
      strategy: 'auto',
      modelId: '',
      prompt: '',
      maxSegments: 10,
    };

    Spinner.useSpinner();
  }

  static canSupport(previewComponent) {
    if (previewComponent && previewComponent.media) {
      return previewComponent.media.type === VIDEO_TYPE;
    }
    return true;
  }

  get formState() {
    return this.$formState;
  }

  async createContent() {
    const container = $('<div/>')
      .addClass('col-11 my-4');

    const desc = $('<p/>')
      .addClass('lead-s')
      .html(MSG_DESC);
    container.append(desc);

    // Sets list section
    const setsSection = $('<div/>')
      .addClass('col-12 px-0 mt-3 mb-4')
      .attr('data-role', 'highlight-sets-section');
    container.append(setsSection);

    const setsTitle = $('<p/>')
      .addClass('lead my-2')
      .append(MSG_SETS_TITLE);
    setsSection.append(setsTitle);

    const setsBody = $('<div/>')
      .addClass('col-12 px-0')
      .attr('data-role', 'highlight-sets-body');
    setsSection.append(setsBody);

    // Detect form section
    const formSection = this.createDetectForm(setsBody);
    container.append(formSection);

    // initial load
    container.ready(async () => {
      await this.refreshHighlightSets(setsBody);
    });

    return container;
  }

  async refreshHighlightSets(setsBody) {
    setsBody.empty();

    const uuid = this.media.uuid;
    let res;
    try {
      this.loading(true);
      res = await ApiHelper.listHighlightSets(uuid);
    } catch (e) {
      console.error(e);
      setsBody.append($('<p/>')
        .addClass('lead-xs text-muted')
        .text(MSG_SETS_EMPTY));
      return;
    } finally {
      this.loading(false);
    }

    const items = ((res || {}).highlightSets) || [];
    if (items.length === 0) {
      setsBody.append($('<p/>')
        .addClass('lead-xs text-muted')
        .html(MSG_SETS_EMPTY));
      return;
    }

    const table = $('<table/>')
      .addClass('table table-sm lead-xs');
    setsBody.append(table);

    const thead = $('<thead/>');
    table.append(thead);
    const headerRow = $('<tr/>');
    thead.append(headerRow);
    ['Created', 'Strategy', 'Model', 'Segments', 'Status', '']
      .forEach((h) => {
        headerRow.append($('<th/>').addClass('lead-xs').text(h));
      });

    const tbody = $('<tbody/>');
    table.append(tbody);

    items.sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    items.forEach((it) => {
      const row = $('<tr/>');
      tbody.append(row);

      row.append($('<td/>').text(_iso(it.createdAt)));
      row.append($('<td/>').text(it.strategy || '-'));
      row.append($('<td/>').text(_short(it.modelId || it.model || '-')));
      row.append($('<td/>').text(((it.segments || []).length) || it.segmentCount || 0));
      row.append($('<td/>').text(it.status || 'completed'));

      const viewCell = $('<td/>');
      row.append(viewCell);

      const viewBtn = $('<button/>')
        .addClass('btn btn-sm btn-outline-primary mr-1')
        .attr('type', 'button')
        .attr('data-toggle', 'tooltip')
        .attr('data-placement', 'bottom')
        .attr('title', TP_VIEW)
        .text(BTN_VIEW)
        .tooltip({ trigger: 'hover' });
      viewCell.append(viewBtn);

      const editBtn = $('<button/>')
        .addClass('btn btn-sm btn-primary')
        .attr('type', 'button')
        .attr('data-toggle', 'tooltip')
        .attr('data-placement', 'bottom')
        .attr('title', TP_OPEN_EDITOR)
        .text(BTN_OPEN_EDITOR)
        .tooltip({ trigger: 'hover' });
      viewCell.append(editBtn);

      editBtn.on('click', async () => {
        editBtn.tooltip('hide');
        try {
          const modal = new HighlightEditorModal(this.previewComponent, it);
          await modal.open();
        } catch (e) {
          console.error(e);
          await _alertAgent.showMessage(this.tabContent, 'danger', OOPS,
            (e && e.message) || 'Failed to open editor', 5000);
        }
      });

      const detailRow = $('<tr/>')
        .addClass('d-none');
      tbody.append(detailRow);
      const detailCell = $('<td/>')
        .attr('colspan', 6)
        .addClass('bg-light');
      detailRow.append(detailCell);

      viewBtn.on('click', () => {
        const visible = !detailRow.hasClass('d-none');
        if (visible) {
          detailRow.addClass('d-none');
          return;
        }
        detailRow.removeClass('d-none');
        if (detailCell.children().length === 0) {
          detailCell.append(this.renderSetDetail(it));
        }
      });
    });
  }

  renderSetDetail(highlightSet) {
    const wrapper = $('<div/>').addClass('p-2');

    if (highlightSet.prompt) {
      wrapper.append($('<p/>')
        .addClass('lead-xs text-muted m-0')
        .text(`Prompt: ${_short(highlightSet.prompt, 200)}`));
    }

    const segments = highlightSet.segments || [];
    if (segments.length === 0) {
      wrapper.append($('<p/>')
        .addClass('lead-xs text-muted m-0')
        .text('No segments returned.'));
      return wrapper;
    }

    const segTable = $('<table/>')
      .addClass('table table-sm lead-xs mb-0');
    wrapper.append(segTable);

    const thead = $('<thead/>');
    segTable.append(thead);
    const hr = $('<tr/>');
    thead.append(hr);
    ['#', 'Start', 'End', 'Duration', 'Title', 'Reason']
      .forEach((h) => {
        hr.append($('<th/>').text(h));
      });

    const tbody = $('<tbody/>');
    segTable.append(tbody);

    segments.forEach((seg, idx) => {
      const startMs = (seg.startMs !== undefined) ? seg.startMs : (seg.startSec || 0) * 1000;
      const endMs = (seg.endMs !== undefined) ? seg.endMs : (seg.endSec || 0) * 1000;
      const tr = $('<tr/>');
      tr.append($('<td/>').text(idx + 1));
      tr.append($('<td/>').text(BaseMedia.readableDuration(startMs)));
      tr.append($('<td/>').text(BaseMedia.readableDuration(endMs)));
      tr.append($('<td/>').text(`${((endMs - startMs) / 1000).toFixed(1)}s`));
      tr.append($('<td/>').text(seg.title || '-'));
      tr.append($('<td/>').text(_short(seg.reason || seg.summary || '-', 160)));
      tbody.append(tr);
    });

    return wrapper;
  }

  createDetectForm(setsBody) {
    const section = $('<div/>')
      .addClass('col-12 px-0 mt-3 mb-4 bg-light p-3');

    const title = $('<p/>')
      .addClass('lead my-2')
      .append(MSG_DETECT_TITLE);
    section.append(title);

    const form = $('<form/>')
      .addClass('form-inline');
    section.append(form);

    // strategy
    form.append(this.createSelectGroup(MSG_STRATEGY, TP_STRATEGY,
      STRATEGIES.map((s) => ({ value: s.value, label: s.label })),
      this.formState.strategy,
      (val) => { this.formState.strategy = val; }));

    // model
    const modelOptions = [{ value: '', label: MSG_DEFAULT_MODEL }]
      .concat(FoundationModels.map((m) => ({ value: m.value, label: m.name })));
    form.append(this.createSelectGroup(MSG_MODEL, TP_MODEL,
      modelOptions, this.formState.modelId,
      (val) => { this.formState.modelId = val; }));

    // prompt
    form.append(this.createTextGroup(MSG_PROMPT, TP_PROMPT,
      this.formState.prompt,
      (val) => { this.formState.prompt = val; }));

    // max segments
    form.append(this.createNumberGroup(MSG_MAX_SEGMENTS, TP_MAX_SEGMENTS,
      this.formState.maxSegments, 1, 50,
      (val) => { this.formState.maxSegments = val; }));

    // submit
    const btnGroup = $('<div/>')
      .addClass('form-group col-12 px-0 mt-3 mb-2');
    form.append(btnGroup);

    const submitBtn = $('<button/>')
      .addClass('btn btn-primary')
      .attr('type', 'submit')
      .attr('data-toggle', 'tooltip')
      .attr('data-placement', 'bottom')
      .attr('title', TP_DETECT)
      .text(BTN_DETECT)
      .tooltip({ trigger: 'hover' });
    btnGroup.append(submitBtn);

    form.submit(async (event) => {
      event.preventDefault();
      submitBtn.attr('disabled', 'disabled');
      submitBtn.tooltip('hide');
      try {
        await this.onSubmit();
        await _alertAgent.showMessage(this.tabContent, 'success', '', ALERT_STARTED, 4000);
        // refresh after a short delay so the new run shows up if it's fast
        setTimeout(() => {
          this.refreshHighlightSets(setsBody);
        }, 1500);
      } catch (e) {
        console.error(e);
        this.shake(form);

        if (e && e.message && /transcript/i.test(e.message)) {
          await _alertAgent.showMessage(this.tabContent, 'danger', OOPS, ALERT_NO_TRANSCRIPT, 6000);
        } else {
          const msg = (ALERT_FAILED || '').replace('{{ERROR}}', (e && e.message) || '');
          await _alertAgent.showMessage(this.tabContent, 'danger', OOPS, msg, 6000);
        }
      } finally {
        submitBtn.removeAttr('disabled');
      }
    });

    return section;
  }

  async onSubmit() {
    const uuid = this.media.uuid;
    const body = {
      strategy: this.formState.strategy,
      maxSegments: Number(this.formState.maxSegments) || 10,
    };
    if (this.formState.modelId) {
      body.modelId = this.formState.modelId;
    }
    if (this.formState.prompt && this.formState.prompt.trim().length > 0) {
      body.prompt = this.formState.prompt.trim();
    }

    Spinner.loading(true);
    try {
      await ApiHelper.startHighlightDetection(uuid, body);
    } finally {
      Spinner.loading(false);
    }
  }

  createSelectGroup(label, tooltip, options, currentValue, onChange) {
    const group = $('<div/>')
      .addClass('form-group col-6 px-0 mt-2 mb-2');

    const lbl = $('<label/>')
      .addClass('lead-s col-3 px-0')
      .attr('data-toggle', 'tooltip')
      .attr('data-placement', 'bottom')
      .attr('title', tooltip)
      .text(label)
      .tooltip({ trigger: 'hover' });
    group.append(lbl);

    const select = $('<select/>')
      .addClass('custom-select custom-select-sm col-8');
    group.append(select);

    options.forEach((opt) => {
      const o = $('<option/>')
        .attr('value', opt.value)
        .text(opt.label);
      if (String(opt.value) === String(currentValue)) {
        o.attr('selected', 'selected');
      }
      select.append(o);
    });

    select.on('change', () => {
      onChange(select.val());
    });

    return group;
  }

  createTextGroup(label, tooltip, currentValue, onChange) {
    const group = $('<div/>')
      .addClass('form-group col-12 px-0 mt-2 mb-2');

    const lbl = $('<label/>')
      .addClass('lead-s col-3 px-0')
      .attr('data-toggle', 'tooltip')
      .attr('data-placement', 'bottom')
      .attr('title', tooltip)
      .text(label)
      .tooltip({ trigger: 'hover' });
    group.append(lbl);

    const input = $('<input/>')
      .addClass('form-control form-control-sm col-8 lead-xs')
      .attr('type', 'text')
      .attr('placeholder', '(optional)')
      .val(currentValue || '');
    group.append(input);

    input.on('blur', () => {
      onChange(input.val());
    });

    return group;
  }

  createNumberGroup(label, tooltip, currentValue, min, max, onChange) {
    const group = $('<div/>')
      .addClass('form-group col-6 px-0 mt-2 mb-2');

    const lbl = $('<label/>')
      .addClass('lead-s col-3 px-0')
      .attr('data-toggle', 'tooltip')
      .attr('data-placement', 'bottom')
      .attr('title', tooltip)
      .text(label)
      .tooltip({ trigger: 'hover' });
    group.append(lbl);

    const input = $('<input/>')
      .addClass('form-control form-control-sm col-3 text-right lead-xs')
      .attr('type', 'number')
      .attr('min', min)
      .attr('max', max)
      .val(currentValue);
    group.append(input);

    input.on('change blur', () => {
      let v = Number(input.val());
      if (Number.isNaN(v)) v = currentValue;
      v = Math.min(Math.max(v, min), max);
      input.val(v);
      onChange(v);
    });

    return group;
  }

  shake(element, delay = 200) {
    _alertAgent.shake(element, delay);
  }
}

function _iso(s) {
  if (!s) return '-';
  try {
    return new Date(s).toLocaleString();
  } catch (e) {
    return s;
  }
}

function _short(s, max = 60) {
  if (!s) return '-';
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
