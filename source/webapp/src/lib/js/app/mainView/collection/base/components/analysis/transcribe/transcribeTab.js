// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import SolutionManifest from '/solution-manifest.js';
import mxAlert from '../../../../../../mixins/mxAlert.js';
import Localization from '../../../../../../shared/localization.js';
import VideoPreview from '../../../../../../shared/media/preview/videoPreview.js';
import Spinner from '../../../../../../shared/spinner.js';
import ApiHelper from '../../../../../../shared/apiHelper.js';
import BaseAnalysisTab from '../base/baseAnalysisTab.js';

const DEFAULT_AI_PROMPT = '將以下字幕轉換為書面語繁體中文。要求：1. 保留所有時間碼，不可改動 2. 保留 SRT 編號格式 3. 將口語廣東話轉換為正式書面語繁體中文 4. 保留專有名詞 5. 只輸出有效的 SRT 格式，不要額外說明';

const {
  FoundationModels = [],
} = SolutionManifest;

const {
  name: MODEL_NAME = '',
  value: MODEL_ID = '',
} = FoundationModels[0] || {};

const MODEL_PRICING = (MODEL_ID.indexOf('sonnet') > 0)
  ? {
    InputTokens: 0.00300,
    OutputTokens: 0.01500,
  }
  : {
    InputTokens: 0.00025,
    OutputTokens: 0.00125,
  };

const {
  Messages: {
    TranscribeTab: TITLE,
    SubtitleSwitch: MSG_SUBTITLE_SWITCH,
    ShowTranscript: MSG_SHOW_TRANSCRIPT,
    NoData: MSG_NO_DATA,
  },
} = Localization;
const {
  Constants: {
    Subtitle,
  },
  Events: {
    Track: {
      Loaded: TRACK_LOADED_EVENT,
    },
  },
} = VideoPreview;

export default class TranscribeTab extends mxAlert(BaseAnalysisTab) {
  constructor(previewComponent) {
    super(TITLE, previewComponent);
    Spinner.useSpinner();
  }

  async createContent() {
    const container = $('<div/>')
      .addClass('col-11 my-4 max-h36r');

    // subtitle switch
    const subtitleSwitch = this.createSubtitleSwitch();
    container.append(subtitleSwitch);

    // SRT export + AI editing
    const subtitleTools = this.createSubtitleTools();
    container.append(subtitleTools);

    // Transcript
    const transcriptView = this.createTranscriptView();
    container.append(transcriptView);

    // Conversation changes
    const conversationView = this.createConversationView();
    container.append(conversationView);

    return container;
  }

  createSubtitleSwitch() {
    const formGroup = $('<div/>')
      .addClass('form-group px-0 mt-2 mb-2');

    const inputGroup = $('<div/>')
      .addClass('input-group');
    formGroup.append(inputGroup);

    const label = $('<label/>')
      .addClass('xs-switch');
    inputGroup.append(label);

    const on = this.previewComponent.trackIsEnabled(Subtitle);
    const input = $('<input/>')
      .attr('type', 'checkbox')
      .attr('data-category', 'transcribe')
      .attr('data-type', 'subtitle')
      .attr('checked', on);
    label.append(input);

    const xslider = $('<span/>')
      .addClass('xs-slider round');
    label.append(xslider);

    const subtitleDesc = $('<span/>')
      .addClass('lead ml-2')
      .html(MSG_SUBTITLE_SWITCH);
    inputGroup.append(subtitleDesc);

    // event handling
    input.on('click', async (event) => {
      const checked = input.prop('checked');
      await this.previewComponent.trackToggle(Subtitle, checked);
    });

    return formGroup;
  }

  createSubtitleTools() {
    const container = $('<div/>')
      .addClass('form-group px-0 mt-2 mb-3 col-12');

    const heading = $('<p/>')
      .addClass('lead-s mb-2')
      .html('Subtitles (SRT)');
    container.append(heading);

    // toolbar: Load / Download / Save
    const toolbar = $('<div/>')
      .addClass('d-flex align-items-center mb-2 flex-wrap');

    const loadBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .attr('type', 'button')
      .html('Load Subtitles');

    const downloadBtn = $('<button/>')
      .addClass('btn btn-sm btn-primary mr-2 mb-1')
      .attr('type', 'button')
      .html('Download SRT');

    const saveBtn = $('<button/>')
      .addClass('btn btn-sm btn-success mr-2 mb-1')
      .attr('type', 'button')
      .prop('disabled', true)
      .html('Save Edits');

    const aiToggleBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .attr('type', 'button')
      .html('AI Edit ▾');

    const applyAllBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-success mr-2 mb-1')
      .attr('type', 'button')
      .css('display', 'none')
      .html('Apply All AI →');

    const resetBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-danger mr-2 mb-1')
      .attr('type', 'button')
      .html('Reset to Original');

    const importBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-secondary mr-2 mb-1')
      .attr('type', 'button')
      .html('Import SRT');

    const importInput = $('<input/>')
      .attr('type', 'file')
      .attr('accept', '.srt,text/plain')
      .css('display', 'none');

    const status = $('<span/>')
      .addClass('lead-xs text-muted ml-2 mb-1');

    toolbar.append(loadBtn, downloadBtn, saveBtn, aiToggleBtn, applyAllBtn, importBtn, importInput, resetBtn, status);
    container.append(toolbar);

    // collapsible AI edit form
    const editForm = $('<div/>')
      .addClass('border rounded p-3 mb-2')
      .css('display', 'none');
    container.append(editForm);

    const modelLabel = $('<label/>')
      .addClass('lead-xs mb-1')
      .html('Model');
    editForm.append(modelLabel);

    const modelSelect = $('<select/>')
      .addClass('custom-select custom-select-sm mb-2');
    editForm.append(modelSelect);

    const promptLabel = $('<label/>')
      .addClass('lead-xs mb-1 mt-2')
      .html('Prompt');
    editForm.append(promptLabel);

    const promptInput = $('<textarea/>')
      .addClass('form-control form-control-sm')
      .attr('rows', 4)
      .val(DEFAULT_AI_PROMPT);
    editForm.append(promptInput);

    const runBtn = $('<button/>')
      .addClass('btn btn-sm btn-success mt-2')
      .attr('type', 'button')
      .html('Run AI Edit');
    editForm.append(runBtn);

    // editor container (two-column table)
    const editorWrap = $('<div/>')
      .addClass('border rounded')
      .css({
        'max-height': '32rem',
        overflow: 'auto',
      });
    container.append(editorWrap);

    const editorTable = $('<table/>')
      .addClass('table table-sm table-borderless mb-0 lead-xs');
    editorWrap.append(editorTable);

    const thead = $('<thead/>')
      .addClass('thead-light')
      .css({ position: 'sticky', top: 0, 'z-index': 1 });
    const trh = $('<tr/>');
    const thAi = $('<th/>').addClass('align-middle ai-col').css('display', 'none').html('AI Suggestion');
    trh.append(
      $('<th/>').css('width', '4rem').addClass('align-middle').html('#'),
      $('<th/>').css('width', '14rem').addClass('align-middle').html('Time'),
      $('<th/>').addClass('align-middle').html('Subtitle'),
      thAi
    );
    thead.append(trh);
    editorTable.append(thead);

    const tbody = $('<tbody/>');
    editorTable.append(tbody);

    const placeholder = $('<p/>')
      .addClass('lead-xs text-muted px-3 py-3 mb-0')
      .html('Click "Load Subtitles" to view and edit cues here.');
    editorWrap.append(placeholder);

    const state = { cues: [], dirty: false, hasAi: false };

    const formatTimecode = (seconds) => {
      const totalMs = Math.round(seconds * 1000);
      const ms = totalMs % 1000;
      const totalSec = Math.floor(totalMs / 1000);
      const s = totalSec % 60;
      const totalMin = Math.floor(totalSec / 60);
      const m = totalMin % 60;
      const h = Math.floor(totalMin / 60);
      const pad = (n, w = 2) => String(n).padStart(w, '0');
      return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
    };

    const parseTimecode = (text) => {
      const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
      if (!m) return null;
      return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    };

    const markDirty = () => {
      state.dirty = true;
      saveBtn.prop('disabled', false);
      status.removeClass('text-success text-danger').addClass('text-muted').html('Unsaved changes');
    };

    const makeTimeInput = (idx, field, val) => {
      const input = $('<input/>')
        .attr('type', 'text')
        .addClass('form-control form-control-sm lead-xxs')
        .css({ 'font-family': 'monospace', padding: '0.1rem 0.25rem', height: 'auto' })
        .val(formatTimecode(val));
      input.on('input', () => {
        const parsed = parseTimecode(input.val());
        if (parsed === null) {
          input.addClass('is-invalid');
          return;
        }
        input.removeClass('is-invalid');
        state.cues[idx][field] = parsed;
        markDirty();
      });
      return input;
    };

    const renderCues = () => {
      tbody.empty();
      const cues = state.cues;
      if (!cues || cues.length === 0) {
        placeholder.show().html('No subtitle cues found.');
        saveBtn.prop('disabled', true);
        thAi.css('display', state.hasAi ? '' : 'none');
        applyAllBtn.css('display', state.hasAi ? '' : 'none');
        return;
      }
      placeholder.hide();
      thAi.css('display', state.hasAi ? '' : 'none');
      applyAllBtn.css('display', state.hasAi ? '' : 'none');

      cues.forEach((cue, idx) => {
        const tr = $('<tr/>');
        tr.append($('<td/>').addClass('align-top text-muted').html(String(idx + 1)));

        const timeCell = $('<td/>').addClass('align-top');
        const startInput = makeTimeInput(idx, 'start', cue.start);
        const endInput = makeTimeInput(idx, 'end', cue.end);
        timeCell.append(startInput, $('<div/>').css('height', '2px'), endInput);
        tr.append(timeCell);

        const textArea = $('<textarea/>')
          .addClass('form-control form-control-sm')
          .attr('rows', Math.max(1, (cue.text || '').split('\n').length))
          .val(cue.text || '');
        textArea.on('input', () => {
          state.cues[idx].text = textArea.val();
          markDirty();
        });
        tr.append($('<td/>').addClass('align-top').append(textArea));

        if (state.hasAi) {
          const aiCell = $('<td/>').addClass('align-top ai-col');
          const aiText = cue.aiText || '';
          if (aiText) {
            const aiArea = $('<textarea/>')
              .addClass('form-control form-control-sm')
              .css('background-color', '#f0fff4')
              .attr('rows', Math.max(1, aiText.split('\n').length))
              .val(aiText);
            aiArea.on('input', () => {
              state.cues[idx].aiText = aiArea.val();
            });
            const applyBtn = $('<button/>')
              .addClass('btn btn-xs btn-outline-success mt-1')
              .attr('type', 'button')
              .html('← Apply')
              .on('click', () => {
                state.cues[idx].text = aiArea.val();
                textArea.val(aiArea.val());
                textArea.attr('rows', Math.max(1, aiArea.val().split('\n').length));
                markDirty();
              });
            aiCell.append(aiArea, applyBtn);
          } else {
            aiCell.append($('<span/>').addClass('text-muted lead-xxs').html('—'));
          }
          tr.append(aiCell);
        }

        tbody.append(tr);
      });
      saveBtn.prop('disabled', !state.dirty);
    };

    const setCues = (cues, { dirty = false, keepAi = false } = {}) => {
      state.cues = (cues || []).map((c, i) => {
        const out = { start: c.start, end: c.end, text: c.text || '' };
        if (keepAi && state.cues[i] && state.cues[i].aiText) {
          out.aiText = state.cues[i].aiText;
        }
        return out;
      });
      state.dirty = dirty;
      if (!keepAi) state.hasAi = false;
      renderCues();
    };

    const applyAiCues = (aiCues) => {
      const len = Math.min(state.cues.length, aiCues.length);
      for (let i = 0; i < len; i += 1) {
        state.cues[i].aiText = aiCues[i].text || '';
      }
      state.hasAi = true;
      renderCues();
    };

    const loadCues = async () => {
      const uuid = this.media.uuid;
      try {
        loadBtn.prop('disabled', true);
        status.removeClass('text-danger text-success').addClass('text-muted').html('Loading...');
        const res = await ApiHelper.getSrt(uuid);
        if (res && Array.isArray(res.cues)) {
          setCues(res.cues);
          if (this.previewComponent && this.previewComponent.setSubtitleVttKey) {
            await this.previewComponent.setSubtitleVttKey(res.vttKey);
          }
          status.html(`Loaded ${res.cues.length} cues`);
        } else {
          status.html('No subtitles available');
        }
      } catch (e) {
        console.error(e);
        status.removeClass('text-muted text-success').addClass('text-danger').html(`Error: ${e.message}`);
      } finally {
        loadBtn.prop('disabled', false);
      }
    };

    loadBtn.on('click', loadCues);

    applyAllBtn.on('click', () => {
      let applied = 0;
      state.cues.forEach((c) => {
        if (c.aiText && c.aiText !== c.text) {
          c.text = c.aiText;
          applied += 1;
        }
      });
      if (applied > 0) {
        markDirty();
        renderCues();
        status.removeClass('text-muted text-danger').addClass('text-success').html(`Applied ${applied} AI suggestions — review and Save`);
      } else {
        status.removeClass('text-success text-danger').addClass('text-muted').html('No AI changes to apply');
      }
    });

    downloadBtn.on('click', async () => {
      const uuid = this.media.uuid;
      try {
        downloadBtn.prop('disabled', true);
        status.removeClass('text-danger text-success').addClass('text-muted').html('Preparing SRT...');
        const res = await ApiHelper.getSrt(uuid);
        if (res && res.url) {
          const isEdited = (res.srtKey || '').endsWith('_edited.srt');
          window.open(res.url, '_blank');
          status.html(isEdited ? 'SRT ready (edited version)' : 'SRT ready');
          if (Array.isArray(res.cues) && state.cues.length === 0) {
            setCues(res.cues);
          }
        } else {
          status.removeClass('text-muted text-success').addClass('text-danger').html('Failed');
        }
      } catch (e) {
        console.error(e);
        status.removeClass('text-muted text-success').addClass('text-danger').html(`Error: ${e.message}`);
      } finally {
        downloadBtn.prop('disabled', false);
      }
    });

    saveBtn.on('click', async () => {
      const uuid = this.media.uuid;
      try {
        saveBtn.prop('disabled', true);
        status.removeClass('text-danger text-success').addClass('text-muted').html('Saving...');
        const payload = {
          cues: state.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
        };
        const res = await ApiHelper.saveSrt(uuid, payload);
        if (res && res.url) {
          if (this.previewComponent && this.previewComponent.setSubtitleVttKey && res.vttKey) {
            await this.previewComponent.setSubtitleVttKey(res.vttKey);
          }
          status.removeClass('text-muted text-danger').addClass('text-success').html(`Saved (${(res.cues || []).length} cues) — player updated`);
          state.dirty = false;
        } else {
          status.removeClass('text-muted text-success').addClass('text-danger').html('Save failed');
          saveBtn.prop('disabled', false);
        }
      } catch (e) {
        console.error(e);
        status.removeClass('text-muted text-success').addClass('text-danger').html(`Error: ${e.message}`);
        saveBtn.prop('disabled', false);
      }
    });

    importBtn.on('click', () => importInput.trigger('click'));

    importInput.on('change', async () => {
      const inputEl = importInput[0];
      const file = inputEl && inputEl.files && inputEl.files[0];
      if (!file) {
        return;
      }
      const uuid = this.media.uuid;
      try {
        importBtn.prop('disabled', true);
        status.removeClass('text-danger text-success').addClass('text-muted').html(`Importing ${file.name}...`);
        const text = await file.text();
        if (!text || !/-->/.test(text)) {
          throw new Error('File does not look like an SRT (no timecode arrows found)');
        }
        const res = await ApiHelper.saveSrt(uuid, { content: text });
        if (res && Array.isArray(res.cues)) {
          setCues(res.cues);
          if (this.previewComponent && this.previewComponent.setSubtitleVttKey && res.vttKey) {
            await this.previewComponent.setSubtitleVttKey(res.vttKey);
          }
          state.dirty = false;
          state.hasAi = false;
          applyAllBtn.css('display', 'none');
          status.removeClass('text-muted text-danger').addClass('text-success').html(`Imported ${res.cues.length} cues from ${file.name}`);
        } else {
          status.removeClass('text-muted text-success').addClass('text-danger').html('Import failed');
        }
      } catch (e) {
        console.error(e);
        status.removeClass('text-muted text-success').addClass('text-danger').html(`Error: ${e.message}`);
      } finally {
        importBtn.prop('disabled', false);
        // Reset so re-selecting the same file re-fires change.
        inputEl.value = '';
      }
    });

    resetBtn.on('click', async () => {
      const uuid = this.media.uuid;
      // eslint-disable-next-line no-alert
      const confirmed = window.confirm('Reset subtitles to the original Transcribe output? Saved edits and AI suggestions will be discarded.');
      if (!confirmed) {
        return;
      }
      try {
        resetBtn.prop('disabled', true);
        status.removeClass('text-danger text-success').addClass('text-muted').html('Resetting...');
        const res = await ApiHelper.resetSrt(uuid);
        if (res && Array.isArray(res.cues)) {
          setCues(res.cues);
          if (this.previewComponent && this.previewComponent.setSubtitleVttKey) {
            // Pass undefined to fall back to the original transcribe.vtt.
            await this.previewComponent.setSubtitleVttKey(undefined);
          }
          status.removeClass('text-muted text-danger').addClass('text-success').html(`Reset to original (${res.cues.length} cues)`);
          state.dirty = false;
          state.hasAi = false;
          applyAllBtn.css('display', 'none');
        } else {
          status.removeClass('text-muted text-success').addClass('text-danger').html('Reset failed');
        }
      } catch (e) {
        console.error(e);
        status.removeClass('text-muted text-success').addClass('text-danger').html(`Error: ${e.message}`);
      } finally {
        resetBtn.prop('disabled', false);
      }
    });

    aiToggleBtn.on('click', async () => {
      const isHidden = editForm.css('display') === 'none';
      editForm.css('display', isHidden ? 'block' : 'none');
      aiToggleBtn.html(isHidden ? 'AI Edit ▴' : 'AI Edit ▾');

      if (isHidden && modelSelect.children().length === 0) {
        try {
          const models = await ApiHelper.getModels();
          const providers = (models || {}).providers || {};
          Object.keys(providers).forEach((provider) => {
            const group = $('<optgroup/>').attr('label', provider);
            providers[provider].forEach((m) => {
              const opt = $('<option/>').attr('value', m.id).text(m.name);
              group.append(opt);
            });
            modelSelect.append(group);
          });
        } catch (e) {
          console.error(e);
        }
      }
    });

    const pollAiEditStatus = async (uuid) => {
      const POLL_INTERVAL_MS = 5000;
      const MAX_POLLS = 120; // 10 minutes
      for (let i = 0; i < MAX_POLLS; i += 1) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        let res;
        try {
          res = await ApiHelper.getAiEditStatus(uuid);
        } catch (e) {
          // network blip — keep polling
          continue;
        }
        if (!res) continue;
        if (res.status === 'completed') return res;
        if (res.status === 'failed') throw new Error(res.error || 'AI edit failed');
        if (res.progress) {
          const { chunk, total, cuesProcessed, cueCount } = res.progress;
          status.removeClass('text-danger text-success').addClass('text-muted')
            .html(`Editing chunk ${chunk}/${total} (${cuesProcessed}/${cueCount} cues)...`);
        }
      }
      throw new Error('AI edit timed out');
    };

    runBtn.on('click', async () => {
      const uuid = this.media.uuid;
      const model = modelSelect.val();
      const prompt = promptInput.val();
      if (!model) {
        status.removeClass('text-muted text-success').addClass('text-danger').html('Please select a model');
        return;
      }
      try {
        runBtn.prop('disabled', true);
        status.removeClass('text-danger text-success').addClass('text-muted').html('Starting AI edit...');
        Spinner.loading();

        await ApiHelper.aiEditSubtitle(uuid, { model, prompt });
        status.html('AI edit running in background...');

        const res = await pollAiEditStatus(uuid);
        if (res && Array.isArray(res.cues)) {
          if (state.cues.length === 0) {
            setCues(res.cues);
          }
          applyAiCues(res.cues);
          status.removeClass('text-muted text-danger').addClass('text-success').html(`AI suggestions ready (${res.cues.length} cues) — review and Apply`);
        } else {
          status.removeClass('text-muted text-success').addClass('text-danger').html('Failed');
        }
      } catch (e) {
        console.error(e);
        status.removeClass('text-muted text-success').addClass('text-danger').html(`Error: ${e.message}`);
      } finally {
        runBtn.prop('disabled', false);
        Spinner.loading(false);
      }
    });

    return container;
  }

  createTranscriptView() {
    const details = $('<details/>');

    const summary = $('<summary/>')
      .addClass('my-4');
    details.append(summary);

    let languageCode = this.previewComponent.media.getTranscribeResults();
    languageCode = (languageCode || {}).languageCode;

    let title = MSG_SHOW_TRANSCRIPT
      .replace('{{LANGUAGECODE}}', languageCode);

    title = $('<span/>')
      .addClass('lead ml-2')
      .html(title);
    summary.append(title);

    const view = this.previewComponent.getSubtitleView();
    details.append(view);

    // event handling
    view.on(TRACK_LOADED_EVENT, (event, track) => {
      /*
      if (this.previewComponent.trackIsSub(track)) {
        input.prop('checked', true);
      }
      */
    });

    return details;
  }

  createConversationView() {
    const details = $('<details/>');

    const summary = $('<summary/>')
      .addClass('my-4');
    details.append(summary);

    let languageCode = this.previewComponent.media.getTranscribeResults();
    languageCode = (languageCode || {}).languageCode;

    let title = 'Conversation analysis <code>(powered by Amazon Bedrock)</code>';
    title = $('<span/>')
      .addClass('lead ml-2')
      .html(title);
    summary.append(title);

    details.ready(async () => {
      try {
        Spinner.loading();

        const results = this.previewComponent.media.getTranscribeResults();
        let {
          conversations,
        } = results || {};

        if (!conversations) {
          throw new Error(MSG_NO_DATA);
        }

        conversations = await this.download(conversations);
        if (conversations) {
          conversations = await conversations.Body.transformToString()
            .then((res) =>
              JSON.parse(res));

          const {
            usage: {
              inputTokens,
              outputTokens,
            },
            chapters,
          } = conversations;

          // build the list
          const table = this.buildConversationTable(chapters);
          details.append(table);

          // usage
          const estimatedCost = ((
            (inputTokens * MODEL_PRICING.InputTokens) +
            (outputTokens * MODEL_PRICING.OutputTokens)
          ) / 1000).toFixed(4);

          const p = $('<p/>')
            .append(`(Total of <code>${inputTokens}</code> input tokens and <code>${outputTokens}</code> output tokens using ${MODEL_NAME}. Estimated code is <code>$${estimatedCost}</code>.)`);
          details.append(p);

          // const pre = $('<pre/>')
          //   .append(JSON.stringify(conversations, null, 2));
          // details.append(pre);
        }
      } catch (e) {
        console.error(e);
        const noData = $('<p/>')
          .addClass('lead-s text-muted')
          .append(e.message);

        details.append(noData);
      } finally {
        Spinner.loading(false);
      }
    });

    return details;
  }

  buildConversationTable(conversations) {
    const table = $('<table/>')
      .addClass('table lead-xs');

    const thead = $('<thead/>');
    table.append(thead);

    let tr = $('<tr/>');
    thead.append(tr);

    const headers = ['#', 'Start', 'End', 'Topic']
      .map((text) => {
        const th = $('<th/>')
          .addClass('align-middle text-left b-300')
          .attr('scope', 'col')
          .append(text);
        return th;
      });
    tr.append(headers);

    const tbody = $('<tbody/>');
    table.append(tbody);

    // add row
    for (let i = 0; i < conversations.length; i += 1) {
      const conversation = conversations[i];
      const {
        start,
        end,
        reason,
      } = conversation;

      tr = $('<tr/>');
      tbody.append(tr);

      let td = $('<td/>')
        .append(String(i + 1));
      tr.append(td);

      td = $('<td/>')
        .append(_toHHMMSS(start));
      tr.append(td);

      td = $('<td/>')
        .append(_toHHMMSS(end));
      tr.append(td);

      td = $('<td/>')
        .append(reason);
      tr.append(td);
    }

    return table;
  }
}

function _toHHMMSS(timestamp, hhmmssOnly = false) {
  if (typeof timestamp === 'string') {
    return timestamp;
  }

  return TranscribeTab.readableDuration(timestamp, hhmmssOnly);
}
