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

    // row 1: download SRT button
    const downloadRow = $('<div/>')
      .addClass('d-flex align-items-center mb-2');

    const downloadBtn = $('<button/>')
      .addClass('btn btn-sm btn-primary mr-2')
      .attr('type', 'button')
      .html('Download SRT');

    const downloadStatus = $('<span/>')
      .addClass('lead-xs text-muted ml-2');

    downloadRow.append(downloadBtn, downloadStatus);
    container.append(downloadRow);

    downloadBtn.on('click', async () => {
      const uuid = this.media.uuid;
      try {
        downloadBtn.prop('disabled', true);
        downloadStatus.html('Generating...');
        const res = await ApiHelper.generateSrt(uuid);
        if (res && res.url) {
          window.open(res.url, '_blank');
          downloadStatus.html('SRT ready');
        } else {
          downloadStatus.html('Failed');
        }
      } catch (e) {
        console.error(e);
        downloadStatus.html(`Error: ${e.message}`);
      } finally {
        downloadBtn.prop('disabled', false);
      }
    });

    // row 2: AI edit toggle + form
    const editToggleRow = $('<div/>')
      .addClass('d-flex align-items-center mb-2');

    const editToggleBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-primary')
      .attr('type', 'button')
      .html('AI Edit Subtitles ▾');
    editToggleRow.append(editToggleBtn);
    container.append(editToggleRow);

    // collapsible AI edit form
    const editForm = $('<div/>')
      .addClass('border rounded p-3 mb-2')
      .css('display', 'none');
    container.append(editForm);

    // model selector
    const modelLabel = $('<label/>')
      .addClass('lead-xs mb-1')
      .html('Model');
    editForm.append(modelLabel);

    const modelSelect = $('<select/>')
      .addClass('custom-select custom-select-sm mb-2');
    editForm.append(modelSelect);

    // prompt textarea
    const promptLabel = $('<label/>')
      .addClass('lead-xs mb-1 mt-2')
      .html('Prompt');
    editForm.append(promptLabel);

    const promptInput = $('<textarea/>')
      .addClass('form-control form-control-sm')
      .attr('rows', 4)
      .val(DEFAULT_AI_PROMPT);
    editForm.append(promptInput);

    // action row
    const actionRow = $('<div/>')
      .addClass('d-flex align-items-center mt-2');

    const runBtn = $('<button/>')
      .addClass('btn btn-sm btn-success mr-2')
      .attr('type', 'button')
      .html('Run AI Edit');

    const editStatus = $('<span/>')
      .addClass('lead-xs text-muted ml-2');

    actionRow.append(runBtn, editStatus);
    editForm.append(actionRow);

    editToggleBtn.on('click', async () => {
      const isHidden = editForm.css('display') === 'none';
      editForm.css('display', isHidden ? 'block' : 'none');
      editToggleBtn.html(isHidden ? 'AI Edit Subtitles ▴' : 'AI Edit Subtitles ▾');

      // populate model list on first open
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

          // load saved prompt
          const uuid = this.media.uuid;
          const saved = await ApiHelper.getSubtitlePrompt(uuid).catch(() => undefined);
          if (saved && saved.prompt) {
            promptInput.val(saved.prompt);
          }
        } catch (e) {
          console.error(e);
        }
      }
    });

    runBtn.on('click', async () => {
      const uuid = this.media.uuid;
      const model = modelSelect.val();
      const prompt = promptInput.val();
      if (!model) {
        editStatus.html('Please select a model');
        return;
      }
      try {
        runBtn.prop('disabled', true);
        editStatus.html('Editing... this may take a minute');
        Spinner.loading();

        // save the prompt for future use
        await ApiHelper.saveSubtitlePrompt(uuid, prompt).catch(() => undefined);

        const res = await ApiHelper.aiEditSubtitle(uuid, { model, prompt });
        if (res && res.url) {
          window.open(res.url, '_blank');
          editStatus.html(`Done (${res.cueCount} cues)`);
        } else {
          editStatus.html('Failed');
        }
      } catch (e) {
        console.error(e);
        editStatus.html(`Error: ${e.message}`);
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
