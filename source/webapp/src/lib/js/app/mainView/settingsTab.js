// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Localization from '../shared/localization.js';
import {
  GetLocalStoreDB,
} from '../shared/localCache/index.js';
import mxAnalysisSettings from '../mixins/mxAnalysisSettings.js';
import BaseTab from '../shared/baseTab.js';
import ApiHelper from '../shared/apiHelper.js';

const {
  Messages: {
    SettingsTab: TITLE,
    DatastoreFeature: MSG_DATASTORE_FEATURE,
    DatastoreFeatureDesc: MSG_DATASTORE_FEATURE_DESC,
  },
  Buttons: {
    CleanupDatastore: BTN_CLEANUP_DATASTORE,
  },
} = Localization;

const MSG_MC_TEMPLATES = 'MediaConvert templates';
const MSG_MC_TEMPLATES_DESC = 'Manage the MediaConvert job templates shared by '
  + 'Publish and Render. Built-in <code>mp4_landscape</code> and '
  + '<code>mp4_portrait</code> ship with the solution; uploading a template '
  + 'with the same name overrides the built-in. Use Download to grab the '
  + 'JSON, edit, and Upload override (same name) or Upload as new (custom '
  + 'name). Custom templates appear in the Publish + Render pickers.';

const MSG_SUBTITLE_PROMPTS = 'Subtitle AI-edit prompts';
const MSG_SUBTITLE_PROMPTS_DESC = 'Manage the shared library of named prompts used '
  + 'by the Transcribe tab&rsquo;s AI Edit feature. The <code>default</code> entry '
  + 'is auto-seeded if the library is empty (delete it to reset to the factory '
  + 'prompt). Names must be A-Z, a-z, 0-9, _, - (max 64 chars).';

const MSG_LOGOS = 'Logo overlay library';
const MSG_LOGOS_DESC = 'Workspace-shared logo files used by the Video Edit '
  + 'tab&rsquo;s logo overlay. Upload PNG (transparent recommended) or JPG; '
  + 'each upload becomes a named entry visible to all users. The Video Edit '
  + 'tab presents the library as a dropdown — pick a logo at Export time and '
  + 'set its X / Y position there. Names must be A-Z, a-z, 0-9, _, - (max 64 chars).';
const ALLOWED_LOGO_EXT = ['png', 'jpg', 'jpeg'];

const HASHTAG = TITLE.replaceAll(' ', '');

export default class SettingsTab extends mxAnalysisSettings(BaseTab) {
  constructor() {
    super(TITLE, {
      hashtag: HASHTAG,
    });
  }

  get parentContainer() {
    return this.tabContent;
  }

  createSkeleton() {
    const container = super.createSkeleton();

    const datastoreForm = this.createDatastoreForm();
    const mcTemplatesForm = this.createMcTemplatesForm();
    const logosForm = this.createLogosForm();
    const subtitlePromptsForm = this.createSubtitlePromptsForm();

    const first = container.children()
      .first();

    first.after($('<div/>')
      .addClass('col-9 p-0 mx-auto mt-4')
      .append(datastoreForm)
      .append(mcTemplatesForm)
      .append(logosForm)
      .append(subtitlePromptsForm));

    // event handling
    container.ready(async () => {
      try {
        this.loading();

        this.createObserver(container);
      } catch (e) {
        console.error(e);
      } finally {
        this.loading(false);
      }
    });

    return container;
  }

  createDatastoreForm() {
    const container = $('<div/>')
      .addClass('ai-group')
      .addClass('overflow-auto my-auto align-content-start');

    const itemContainer = $('<div/>')
      .addClass('mt-4');
    container.append(itemContainer);

    const title = $('<span/>')
      .addClass('d-block p-2 bg-light text-black lead')
      .html(MSG_DATASTORE_FEATURE);
    itemContainer.append(title);

    const desc = $('<p/>')
      .addClass('lead-s mt-4')
      .html(MSG_DATASTORE_FEATURE_DESC);
    itemContainer.append(desc);

    const form = $('<form/>')
      .addClass('col-9 px-0 form-inline mt-4')
      .attr('role', 'form');
    itemContainer.append(form);

    const btnCleanup = $('<button/>')
      .addClass('btn btn-sm btn-outline-danger')
      .attr('type', 'button')
      .attr('data-toggle', 'button')
      .attr('aria-pressed', 'false')
      .attr('autocomplete', 'off')
      .append(BTN_CLEANUP_DATASTORE);
    form.append(btnCleanup);

    // event handlings
    form.submit((event) => {
      event.preventDefault();
    });

    btnCleanup.on('click', async (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();

        this.loading(true);

        const db = GetLocalStoreDB();
        await db.clearAllStores();

        return false;
      } catch (e) {
        console.error(e);
        return false;
      } finally {
        this.loading(false);
      }
    });

    return container;
  }

  createMcTemplatesForm() {
    const container = $('<div/>')
      .addClass('ai-group')
      .addClass('overflow-auto my-auto align-content-start');

    const itemContainer = $('<div/>')
      .addClass('mt-4');
    container.append(itemContainer);

    const title = $('<span/>')
      .addClass('d-block p-2 bg-light text-black lead')
      .html(MSG_MC_TEMPLATES);
    itemContainer.append(title);

    const desc = $('<p/>')
      .addClass('lead-s mt-4')
      .html(MSG_MC_TEMPLATES_DESC);
    itemContainer.append(desc);

    const form = $('<form/>')
      .addClass('col-12 px-0 form-inline mt-4 d-flex flex-wrap align-items-center')
      .attr('role', 'form');
    itemContainer.append(form);

    const select = $('<select/>')
      .addClass('custom-select custom-select-sm w-auto mr-2 mb-1')
      .attr('data-role', 'mc-template');
    form.append(select);

    const downloadBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('type', 'button')
      .attr('data-role', 'mc-download')
      .html('Download');
    const uploadBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('type', 'button')
      .attr('data-role', 'mc-upload')
      .html('Upload override');
    const newBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('type', 'button')
      .attr('data-role', 'mc-new')
      .html('Upload as new');
    const deleteBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-danger mr-2 mb-1')
      .attr('type', 'button')
      .attr('data-role', 'mc-delete')
      .html('Delete custom');
    const refreshBtn = $('<button/>')
      .addClass('btn btn-sm btn-link mb-1')
      .attr('type', 'button')
      .attr('data-role', 'mc-refresh')
      .html('Refresh list');
    form.append(downloadBtn).append(uploadBtn).append(newBtn).append(deleteBtn).append(refreshBtn);

    const hiddenFile = $('<input/>')
      .attr('type', 'file')
      .attr('accept', 'application/json,.json')
      .css('display', 'none')
      .attr('data-role', 'mc-file');
    form.append(hiddenFile);

    const status = $('<span/>')
      .addClass('lead-xs text-muted ml-2 mb-1 w-100')
      .attr('data-role', 'mc-status');
    form.append(status);

    const setStatus = (text, kind) => {
      status.removeClass('text-muted text-success text-danger');
      if (kind === 'ok') status.addClass('text-success');
      else if (kind === 'err') status.addClass('text-danger');
      else status.addClass('text-muted');
      status.html(text || '');
    };

    const refresh = async (preferredValue) => {
      try {
        setStatus('Loading templates...');
        const res = await ApiHelper.listMcTemplates();
        const templates = (res && res.templates) || [];
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
        setStatus(`${templates.length} template(s) available.`, 'ok');
      } catch (e) {
        console.error(e);
        setStatus(`Error loading templates: ${e.message}`, 'err');
      }
    };

    const download = async () => {
      const name = select.val();
      if (!name) return;
      try {
        setStatus(`Downloading ${name}...`);
        const res = await ApiHelper.getMcTemplate(name);
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
        setStatus(`Downloaded ${name}.json`, 'ok');
      } catch (e) {
        console.error(e);
        setStatus(`Download failed: ${e.message}`, 'err');
      }
    };

    const upload = async (file, mode, newName) => {
      if (!file) return;
      const targetName = mode === 'new' ? newName : select.val();
      if (!targetName) {
        setStatus('No target template selected.', 'err');
        return;
      }
      setStatus(`Reading ${file.name}...`);
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        setStatus(`Invalid JSON: ${e.message}`, 'err');
        return;
      }
      if (!parsed || !Array.isArray(parsed.OutputGroups) || parsed.OutputGroups.length === 0) {
        setStatus('Template must have an OutputGroups array.', 'err');
        return;
      }
      setStatus(`Uploading ${targetName}...`);
      await ApiHelper.saveMcTemplate(targetName, parsed);
      setStatus(`Saved ${targetName}.`, 'ok');
      await refresh(targetName);
    };

    const remove = async () => {
      const name = select.val();
      if (!name) return;
      if (!window.confirm(`Delete custom version of "${name}"? Built-in templates revert to the packaged default.`)) {
        return;
      }
      try {
        setStatus(`Deleting ${name}...`);
        const res = await ApiHelper.deleteMcTemplate(name);
        if (res && res.deleted) {
          setStatus(`Deleted ${name}.`, 'ok');
        } else {
          setStatus(`No custom override for ${name}.`, 'ok');
        }
        await refresh(name);
      } catch (e) {
        console.error(e);
        setStatus(`Delete failed: ${e.message}`, 'err');
      }
    };

    form.submit((event) => {
      event.preventDefault();
    });

    downloadBtn.on('click', () => download());
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
    deleteBtn.on('click', () => remove());
    refreshBtn.on('click', () => refresh());
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
          setStatus('Filename must yield A-Z, a-z, 0-9, _, - (max 64 chars).', 'err');
          return;
        }
      }
      upload(file, mode, newName).catch((e) => {
        console.error(e);
        setStatus(`Upload failed: ${e.message}`, 'err');
      });
    });

    container.ready(() => {
      refresh().catch(() => {});
    });

    return container;
  }

  createLogosForm() {
    const container = $('<div/>')
      .addClass('ai-group')
      .addClass('overflow-auto my-auto align-content-start');

    const itemContainer = $('<div/>')
      .addClass('mt-4');
    container.append(itemContainer);

    const title = $('<span/>')
      .addClass('d-block p-2 bg-light text-black lead')
      .html(MSG_LOGOS);
    itemContainer.append(title);

    const desc = $('<p/>')
      .addClass('lead-s mt-4')
      .html(MSG_LOGOS_DESC);
    itemContainer.append(desc);

    // Upload control row.
    const uploadRow = $('<div/>')
      .addClass('form-inline d-flex flex-wrap align-items-center mb-3');
    itemContainer.append(uploadRow);

    const uploadBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-primary mr-2 mb-1')
      .attr('type', 'button')
      .html('Upload logo');
    const refreshBtn = $('<button/>')
      .addClass('btn btn-sm btn-link mb-1')
      .attr('type', 'button')
      .html('Refresh list');
    const hiddenFile = $('<input/>')
      .attr('type', 'file')
      .attr('accept', 'image/png,image/jpeg')
      .css('display', 'none');
    uploadRow.append(uploadBtn).append(refreshBtn).append(hiddenFile);

    const status = $('<span/>')
      .addClass('lead-xs text-muted ml-2 mb-1 w-100')
      .attr('data-role', 'logos-status');
    uploadRow.append(status);

    // Grid of existing logos.
    const grid = $('<div/>')
      .addClass('row no-gutters')
      .attr('data-role', 'logos-grid');
    itemContainer.append(grid);

    const setStatus = (text, kind) => {
      status.removeClass('text-muted text-success text-danger');
      if (kind === 'ok') status.addClass('text-success');
      else if (kind === 'err') status.addClass('text-danger');
      else status.addClass('text-muted');
      status.html(text || '');
    };

    const cloudfrontUrlForS3Uri = (s3uri) => {
      // Logos live on the proxy bucket; the same CloudFront distribution
      // that serves /shared assets fronts the proxy bucket. Render the
      // S3 URI as an HTTPS URL we can drop into <img>. We don't have a
      // generic /proxy/ path, but the *.cloudfront.net page itself is
      // served via the SAME CloudFront, so a same-origin signed URL on
      // the proxy bucket is the safe fallback. For the Settings preview
      // we use a presigned GET; otherwise the browser can't read PNG
      // bytes from a private bucket.
      // -- v4.0.40 short path: just show the file name and size; full
      // preview thumbnails would need a separate presign endpoint or
      // bucket-policy change. Keep it simple for the demo.
      return null;
    };

    const renderGrid = (logos) => {
      grid.empty();
      if (!logos.length) {
        grid.append($('<p/>').addClass('lead-xs text-muted').text('No logos uploaded yet.'));
        return;
      }
      logos.forEach((logo) => {
        const cell = $('<div/>')
          .addClass('col-12 col-md-6 col-lg-4 px-0 pr-3 mb-2 d-flex align-items-center');

        const previewUrl = cloudfrontUrlForS3Uri(logo.s3uri);
        const swatch = $('<span/>')
          .addClass('mr-2')
          .css({
            display: 'inline-block',
            width: '32px',
            height: '32px',
            background: '#e9ecef',
            border: '1px solid #ced4da',
            borderRadius: '2px',
            'text-align': 'center',
            'line-height': '32px',
            'font-size': '12px',
            color: '#6c757d',
            'flex-shrink': 0,
          });
        if (previewUrl) {
          swatch.html(`<img src="${previewUrl}" alt="" style="max-width:32px;max-height:32px;object-fit:contain;display:block;margin:auto;">`);
        } else {
          swatch.text((logo.ext || '?').toUpperCase());
        }

        const meta = $('<div/>').addClass('flex-grow-1');
        meta.append($('<span/>').addClass('lead-xs').text(logo.name));
        const detail = $('<span/>').addClass('lead-xs text-muted ml-1');
        const kb = logo.size ? `${Math.round(logo.size / 102.4) / 10} KB` : '';
        detail.text(`(${[logo.ext, kb].filter(Boolean).join(', ')})`);
        meta.append(detail);

        const delBtn = $('<button/>')
          .addClass('btn btn-sm btn-outline-danger ml-2')
          .attr('type', 'button')
          .html('✖')
          .attr('title', `Delete ${logo.name}`);
        delBtn.on('click', () => removeLogo(logo.name));

        cell.append(swatch).append(meta).append(delBtn);
        grid.append(cell);
      });
    };

    const refresh = async () => {
      try {
        setStatus('Loading logos…');
        const res = await ApiHelper.listLogos();
        const logos = (res && res.logos) || [];
        renderGrid(logos);
        setStatus(`${logos.length} logo(s) in library.`, 'ok');
      } catch (e) {
        console.error(e);
        setStatus(`Error loading logos: ${e.message}`, 'err');
      }
    };

    const upload = async (file) => {
      if (!file) return;
      const lower = (file.name || '').toLowerCase();
      let ext = lower.split('.').pop();
      if (ext === 'jpeg') ext = 'jpg';
      if (!ALLOWED_LOGO_EXT.includes(ext)) {
        setStatus('Unsupported file type — use PNG or JPG.', 'err');
        return;
      }
      // Default name = filename minus extension, sanitised.
      let proposed = (file.name || '').replace(/\.[^.]+$/, '');
      proposed = proposed.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(proposed)) {
        proposed = `logo_${Math.floor(Date.now() / 1000)}`;
      }
      const name = window.prompt(
        'Logo name (A-Z, a-z, 0-9, _, -, max 64 chars). Existing names will be replaced.',
        proposed
      );
      if (!name) return;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        setStatus('Invalid name — A-Z, a-z, 0-9, _, - (max 64 chars).', 'err');
        return;
      }
      try {
        setStatus(`Requesting upload URL for ${name}…`);
        const presign = await ApiHelper.presignSharedLogoUpload(name, { ext });
        setStatus(`Uploading ${file.name} as ${name}…`);
        const put = await fetch(presign.url, {
          method: 'PUT',
          headers: { 'Content-Type': presign.contentType },
          body: file,
        });
        if (!put.ok) throw new Error(`upload failed (${put.status})`);
        setStatus(`Uploaded ${name}.`, 'ok');
        await refresh();
      } catch (e) {
        console.error(e);
        setStatus(`Upload failed: ${e.message}`, 'err');
      }
    };

    const removeLogo = async (name) => {
      if (!window.confirm(`Delete logo "${name}"? Renders submitted before this delete will still complete using the cached S3 object only if MediaConvert already pulled it.`)) return;
      try {
        setStatus(`Deleting ${name}…`);
        const res = await ApiHelper.deleteSharedLogo(name);
        setStatus(`Deleted ${name} (${(res && res.deleted) || 0} file(s)).`, 'ok');
        await refresh();
      } catch (e) {
        console.error(e);
        setStatus(`Delete failed: ${e.message}`, 'err');
      }
    };

    uploadBtn.on('click', () => hiddenFile.trigger('click'));
    refreshBtn.on('click', () => refresh());
    hiddenFile.on('change', () => {
      const file = hiddenFile[0].files[0];
      hiddenFile.val('');
      upload(file).catch((e) => {
        console.error(e);
        setStatus(`Upload failed: ${e.message}`, 'err');
      });
    });

    container.ready(() => {
      refresh().catch(() => {});
    });

    return container;
  }

  createSubtitlePromptsForm() {
    const container = $('<div/>')
      .addClass('ai-group')
      .addClass('overflow-auto my-auto align-content-start');

    const itemContainer = $('<div/>')
      .addClass('mt-4');
    container.append(itemContainer);

    const title = $('<span/>')
      .addClass('d-block p-2 bg-light text-black lead')
      .html(MSG_SUBTITLE_PROMPTS);
    itemContainer.append(title);

    const desc = $('<p/>')
      .addClass('lead-s mt-4')
      .html(MSG_SUBTITLE_PROMPTS_DESC);
    itemContainer.append(desc);

    const form = $('<form/>')
      .addClass('col-12 px-0 mt-4')
      .attr('role', 'form');
    itemContainer.append(form);

    const topRow = $('<div/>')
      .addClass('form-inline d-flex flex-wrap align-items-center mb-2');
    form.append(topRow);

    const select = $('<select/>')
      .addClass('custom-select custom-select-sm w-auto mr-2 mb-1');
    topRow.append(select);

    const newBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-secondary mr-1 mb-1')
      .attr('type', 'button')
      .html('New prompt');
    const deleteBtn = $('<button/>')
      .addClass('btn btn-sm btn-outline-danger mr-2 mb-1')
      .attr('type', 'button')
      .html('Delete');
    const refreshBtn = $('<button/>')
      .addClass('btn btn-sm btn-link mb-1')
      .attr('type', 'button')
      .html('Refresh list');
    topRow.append(newBtn).append(deleteBtn).append(refreshBtn);

    const nameLabel = $('<label/>')
      .addClass('lead-xs mb-1')
      .html('Name');
    const nameInput = $('<input/>')
      .attr('type', 'text')
      .addClass('form-control form-control-sm mb-2')
      .attr('placeholder', 'A-Z, a-z, 0-9, _, - (max 64)')
      .prop('disabled', true);
    const promptLabel = $('<label/>')
      .addClass('lead-xs mb-1')
      .html('Prompt');
    const promptInput = $('<textarea/>')
      .addClass('form-control form-control-sm mb-2')
      .attr('rows', 12);
    const saveBtn = $('<button/>')
      .addClass('btn btn-sm btn-success')
      .attr('type', 'button')
      .html('Save prompt');
    form.append(nameLabel, nameInput, promptLabel, promptInput, saveBtn);

    const status = $('<span/>')
      .addClass('lead-xs text-muted ml-2 mb-1 d-block');
    form.append(status);

    const setStatus = (text, kind) => {
      status.removeClass('text-muted text-success text-danger');
      if (kind === 'ok') status.addClass('text-success');
      else if (kind === 'err') status.addClass('text-danger');
      else status.addClass('text-muted');
      status.html(text || '');
    };

    let editingName = '';

    const setEditing = (name, prompt) => {
      editingName = name || '';
      nameInput.val(editingName);
      nameInput.prop('disabled', !!editingName);
      promptInput.val(prompt || '');
      deleteBtn.prop('disabled', !editingName);
    };

    const refresh = async (preferredName) => {
      try {
        setStatus('Loading prompts...');
        const res = await ApiHelper.listSubtitlePrompts();
        const prompts = (res && res.prompts) || [];
        select.empty();
        prompts.forEach((p) => {
          select.append($('<option/>').attr('value', p.name).text(p.name));
        });
        const target = preferredName && prompts.find((p) => p.name === preferredName)
          ? preferredName
          : (prompts[0] && prompts[0].name) || '';
        if (target) {
          select.val(target);
          const picked = prompts.find((p) => p.name === target);
          setEditing(picked.name, picked.prompt);
        } else {
          setEditing('', '');
        }
        setStatus(`${prompts.length} prompt(s) available.`, 'ok');
      } catch (e) {
        console.error(e);
        setStatus(`Error loading prompts: ${e.message}`, 'err');
      }
    };

    const onSelect = async () => {
      const name = select.val();
      if (!name) {
        setEditing('', '');
        return;
      }
      try {
        const res = await ApiHelper.getSubtitlePrompt(name);
        setEditing(res.name, res.prompt);
        setStatus(`Loaded ${name}.`, 'ok');
      } catch (e) {
        console.error(e);
        setStatus(`Load failed: ${e.message}`, 'err');
      }
    };

    const onSave = async () => {
      const name = nameInput.val().trim();
      const prompt = promptInput.val();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        setStatus('Name must be A-Z, a-z, 0-9, _, - (max 64 chars).', 'err');
        return;
      }
      if (!prompt || !prompt.trim()) {
        setStatus('Prompt cannot be empty.', 'err');
        return;
      }
      try {
        setStatus(`Saving ${name}...`);
        await ApiHelper.saveSubtitlePrompt(name, prompt);
        setStatus(`Saved ${name}.`, 'ok');
        await refresh(name);
      } catch (e) {
        console.error(e);
        setStatus(`Save failed: ${e.message}`, 'err');
      }
    };

    const onDelete = async () => {
      const name = editingName;
      if (!name) return;
      if (!window.confirm(`Delete prompt "${name}"? (Deleting "default" re-seeds it on next reload.)`)) {
        return;
      }
      try {
        setStatus(`Deleting ${name}...`);
        const res = await ApiHelper.deleteSubtitlePrompt(name);
        if (res && res.deleted) {
          setStatus(`Deleted ${name}.`, 'ok');
        } else {
          setStatus(`No entry named ${name}.`, 'ok');
        }
        await refresh();
      } catch (e) {
        console.error(e);
        setStatus(`Delete failed: ${e.message}`, 'err');
      }
    };

    const onNew = () => {
      select.val('');
      setEditing('', '');
      nameInput.prop('disabled', false);
      nameInput.trigger('focus');
      setStatus('Enter a name and prompt, then click Save.');
    };

    form.submit((event) => { event.preventDefault(); });
    select.on('change', onSelect);
    saveBtn.on('click', onSave);
    deleteBtn.on('click', onDelete);
    newBtn.on('click', onNew);
    refreshBtn.on('click', () => refresh());

    container.ready(() => {
      refresh().catch(() => {});
    });

    return container;
  }

  createObserver(element) {
    const options = {
      root: null,
      rootMargin: '0px',
      threshold: [0.1],
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(async (entry) => {
        if (entry.intersectionRatio <= options.threshold[0]) {
          console.log(
            'SettingsTab.onPageInvisible',
            'entry.intersectionRatio',
            entry.intersectionRatio
          );
          await this.saveAIOptions();
        }
      });
    }, options);

    observer.observe(element[0]);

    return observer;
  }
}
