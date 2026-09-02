import {
  SITE_THEME_CONTROLS,
  SITE_THEME_GROUPS,
  SITE_THEME_PRESETS,
  applySiteTheme,
  changedSiteThemeControls,
  clearSiteThemeDraft,
  defaultSiteTheme,
  readSiteThemeDraft,
  siteThemePreset,
  themeCssText,
  validateSiteTheme,
  writeSiteThemeDraft
} from './game/siteTheme.js';

const root = document.querySelector('#tab-theme');

if (root) {
  const ui = Object.freeze({
    status: root.querySelector('#theme-studio-status'),
    changeCount: root.querySelector('#theme-studio-change-count'),
    undo: root.querySelector('#theme-undo'),
    redo: root.querySelector('#theme-redo'),
    saveDraft: root.querySelector('#theme-save-draft'),
    exportTheme: root.querySelector('#theme-export'),
    importTrigger: root.querySelector('#theme-import-trigger'),
    importFile: root.querySelector('#theme-import-file'),
    copyCss: root.querySelector('#theme-copy-css'),
    openPreview: root.querySelector('#theme-open-preview'),
    search: root.querySelector('#theme-search'),
    groupNav: root.querySelector('#theme-group-nav'),
    controls: root.querySelector('#theme-controls'),
    previewName: root.querySelector('#theme-preview-name'),
    previewFrame: root.querySelector('#theme-preview-frame'),
    previewRoot: root.querySelector('#theme-preview-root'),
    preset: root.querySelector('#theme-preset-select'),
    presetDescription: root.querySelector('#theme-preset-description'),
    applyPreset: root.querySelector('#theme-apply-preset'),
    liveVersion: root.querySelector('#theme-live-version'),
    liveName: root.querySelector('#theme-live-name'),
    liveUpdated: root.querySelector('#theme-live-updated'),
    themeName: root.querySelector('#theme-name'),
    publishReason: root.querySelector('#theme-publish-reason'),
    publish: root.querySelector('#theme-publish'),
    resetPublished: root.querySelector('#theme-reset-published'),
    resetDefault: root.querySelector('#theme-reset-default'),
    refreshLive: root.querySelector('#theme-refresh-live'),
    palette: root.querySelector('#theme-palette-strip')
  });

  const studio = {
    loaded: false,
    loading: false,
    bound: false,
    publishedState: null,
    draft: defaultSiteTheme(),
    history: [],
    future: [],
    activeGroup: SITE_THEME_GROUPS[0].id,
    search: '',
    pendingChange: null,
    autosaveTimer: null
  };

  window.mattMineThemeStudio = {
    load: (force = false) => loadThemeStudio(force),
    openControl
  };

  async function loadThemeStudio(force = false) {
    if (studio.loading) return;
    if (studio.loaded && !force) {
      renderAll();
      return;
    }
    studio.loading = true;
    bindOnce();
    setStatus('LOADING LIVE THEME', 'loading');
    try {
      const payload = await adminApi()('/api/admin/site-theme');
      const publishedState = payload.siteTheme;
      const published = validateSiteTheme(publishedState.published);
      const recovered = !force ? readSiteThemeDraft() : null;
      studio.publishedState = { ...publishedState, published };
      studio.draft = recovered?.theme || cloneTheme(published);
      studio.history = [];
      studio.future = [];
      studio.loaded = true;
      renderAll();
      setStatus(recovered && themesDiffer(recovered.theme, published) ? 'BROWSER DRAFT RECOVERED' : 'SYNCED WITH LIVE', recovered && themesDiffer(recovered.theme, published) ? 'dirty' : 'saved');
    } catch (error) {
      setStatus(error.message || 'THEME LOAD FAILED', 'error');
    } finally {
      studio.loading = false;
    }
  }

  function bindOnce() {
    if (studio.bound) return;
    studio.bound = true;
    renderPresetOptions();
    renderGroupNav();

    ui.groupNav.addEventListener('click', (event) => {
      const button = event.target.closest('[data-theme-group]');
      if (!button) return;
      studio.activeGroup = button.dataset.themeGroup;
      studio.search = '';
      ui.search.value = '';
      renderGroupNav();
      renderControls();
    });

    ui.search.addEventListener('input', () => {
      studio.search = ui.search.value.trim().toLowerCase();
      renderGroupNav();
      renderControls();
    });

    ui.controls.addEventListener('focusin', beginControlChange);
    ui.controls.addEventListener('pointerdown', beginControlChange);
    ui.controls.addEventListener('input', previewControlChange);
    ui.controls.addEventListener('change', commitControlChange);

    ui.themeName.addEventListener('focus', beginNameChange);
    ui.themeName.addEventListener('input', () => {
      studio.draft.name = ui.themeName.value.slice(0, 64);
      renderDerived();
    });
    ui.themeName.addEventListener('change', commitNameChange);

    ui.undo.addEventListener('click', undo);
    ui.redo.addEventListener('click', redo);
    ui.saveDraft.addEventListener('click', saveBrowserDraft);
    ui.exportTheme.addEventListener('click', exportTheme);
    ui.importTrigger.addEventListener('click', () => ui.importFile.click());
    ui.importFile.addEventListener('change', importTheme);
    ui.copyCss.addEventListener('click', copyCssVariables);
    ui.openPreview.addEventListener('click', openFullPreview);
    ui.applyPreset.addEventListener('click', applyPreset);
    ui.preset.addEventListener('change', renderPresetDescription);
    ui.publish.addEventListener('click', publishTheme);
    ui.resetPublished.addEventListener('click', resetToPublished);
    ui.resetDefault.addEventListener('click', resetToDefault);
    ui.refreshLive.addEventListener('click', refreshFromServer);

    root.querySelectorAll('[data-theme-device]').forEach((button) => button.addEventListener('click', () => {
      const device = button.dataset.themeDevice;
      ui.previewFrame.dataset.device = device;
      root.querySelectorAll('[data-theme-device]').forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-pressed', String(active));
      });
    }));
  }

  function renderAll() {
    renderGroupNav();
    renderControls();
    renderLiveState();
    renderDerived();
  }

  function renderGroupNav() {
    const fragment = document.createDocumentFragment();
    SITE_THEME_GROUPS.forEach((group) => {
      const count = SITE_THEME_CONTROLS.filter((control) => control.group === group.id).length;
      const active = !studio.search && studio.activeGroup === group.id;
      const button = createElement('button', { type: 'button', className: active ? 'active' : '', dataset: { themeGroup: group.id } });
      button.append(createElement('span', { text: group.label }), createElement('b', { text: count }));
      fragment.append(button);
    });
    ui.groupNav.replaceChildren(fragment);
  }

  function renderControls() {
    const query = studio.search;
    const controls = query
      ? SITE_THEME_CONTROLS.filter((control) => {
          const group = SITE_THEME_GROUPS.find((candidate) => candidate.id === control.group);
          return `${control.label} ${control.description} ${control.id} ${group?.label || ''}`.toLowerCase().includes(query);
        })
      : SITE_THEME_CONTROLS.filter((control) => control.group === studio.activeGroup);
    if (!controls.length) {
      ui.controls.replaceChildren(createElement('div', { className: 'theme-empty-controls', text: `No theme controls match “${studio.search}”.` }));
      return;
    }
    const group = query
      ? { label: `Search results · ${controls.length}`, description: 'Controls from every part of the design system.' }
      : SITE_THEME_GROUPS.find((candidate) => candidate.id === studio.activeGroup);
    const heading = createElement('div', { className: 'theme-control-group-heading' });
    heading.append(createElement('h3', { text: group.label }), createElement('p', { text: group.description }));
    const list = createElement('div', { className: 'theme-control-list' });
    list.append(...controls.map(renderControl));
    ui.controls.replaceChildren(heading, list);
  }

  function renderControl(control) {
    const value = studio.draft.tokens[control.id];
    const container = createElement(control.type === 'boolean' ? 'div' : 'label', {
      className: `theme-control${control.type === 'boolean' ? ' theme-toggle-row' : ''}`,
      dataset: { controlCard: control.id }
    });
    const heading = createElement('div', { className: 'theme-control-copy' });
    heading.append(
      createElement('strong', { text: control.label }),
      createElement('code', { text: control.id }),
      createElement('small', { text: control.description })
    );
    container.append(heading);
    if (control.type === 'color') {
      const row = createElement('span', { className: 'theme-color-row' });
      const picker = themeInput(control, 'color', value);
      const text = themeInput(control, 'text', value);
      text.maxLength = 7;
      text.spellcheck = false;
      text.dataset.themeInput = 'color-text';
      text.setAttribute('aria-label', `${control.label} hex value`);
      row.append(picker, text);
      container.append(row);
      return container;
    }
    if (control.type === 'range') {
      const row = createElement('span', { className: 'theme-range-row' });
      const slider = themeInput(control, 'range', value);
      const number = themeInput(control, 'number', value);
      for (const input of [slider, number]) {
        input.min = control.min;
        input.max = control.max;
        input.step = control.step;
      }
      number.setAttribute('aria-label', `${control.label} value${control.unit ? ` in ${control.unit}` : ''}`);
      row.append(slider, number);
      container.append(row);
      return container;
    }
    if (control.type === 'select') {
      const select = createElement('select', { dataset: { themeControl: control.id, themeInput: 'select' } });
      select.append(...control.options.map((option) => {
        const element = createElement('option', { text: option.label });
        element.value = option.value;
        element.selected = option.value === value;
        return element;
      }));
      container.append(select);
      return container;
    }
    const switchLabel = createElement('label', { className: 'theme-switch' });
    switchLabel.setAttribute('aria-label', control.label);
    const checkbox = themeInput(control, 'checkbox', '');
    checkbox.dataset.themeInput = 'boolean';
    checkbox.checked = value;
    switchLabel.append(checkbox, createElement('span'));
    container.append(switchLabel);
    return container;
  }

  function renderDerived() {
    if (!studio.loaded) return;
    const theme = normalizedDraft();
    applySiteTheme(theme, ui.previewRoot);
    ui.previewName.textContent = theme.name || 'Untitled theme';
    if (document.activeElement !== ui.themeName) ui.themeName.value = theme.name;
    const changes = changedSiteThemeControls(theme, studio.publishedState.published);
    const nameChanged = theme.name !== studio.publishedState.published.name;
    const total = changes.length + (nameChanged ? 1 : 0);
    ui.changeCount.textContent = `${total} ${total === 1 ? 'CHANGE' : 'CHANGES'}`;
    ui.changeCount.style.color = total ? 'var(--gold)' : '';
    ui.undo.disabled = studio.history.length === 0;
    ui.redo.disabled = studio.future.length === 0;
    ui.publish.disabled = total === 0;
    ui.resetPublished.disabled = total === 0;
    renderPalette(theme);
    if (total) {
      setStatus('DRAFT AUTOSAVING', 'dirty');
      scheduleAutosave();
    } else {
      clearTimeout(studio.autosaveTimer);
      setStatus('SYNCED WITH LIVE', 'saved');
    }
  }

  function renderLiveState() {
    const state = studio.publishedState;
    if (!state) return;
    ui.liveVersion.textContent = `V${state.version}`;
    ui.liveName.textContent = state.published.name;
    ui.liveUpdated.textContent = state.updatedAt ? formatDate(state.updatedAt) : 'Original default';
  }

  function renderPalette(theme) {
    const ids = ['pageBackground', 'surface', 'surfaceRaised', 'textPrimary', 'brandGold', 'brandCyan', 'positive', 'danger'];
    ui.palette.replaceChildren(...ids.map((id) => {
      const swatch = createElement('span');
      swatch.style.background = theme.tokens[id];
      swatch.title = `${id}: ${theme.tokens[id]}`;
      return swatch;
    }));
  }

  function renderPresetOptions() {
    ui.preset.replaceChildren(...SITE_THEME_PRESETS.map((preset) => {
      const option = createElement('option', { text: preset.name });
      option.value = preset.id;
      return option;
    }));
    renderPresetDescription();
  }

  function renderPresetDescription() {
    const preset = SITE_THEME_PRESETS.find((candidate) => candidate.id === ui.preset.value) || SITE_THEME_PRESETS[0];
    ui.presetDescription.textContent = preset.description;
  }

  function openControl(id) {
    const control = SITE_THEME_CONTROLS.find((candidate) => candidate.id === id);
    if (!control) {
      if (id === 'publish') ui.publishReason.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else if (id === 'presets') ui.preset.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else if (id === 'preview') ui.openPreview.focus();
      return;
    }
    studio.activeGroup = control.group;
    studio.search = control.label.toLowerCase();
    ui.search.value = control.label;
    renderGroupNav();
    renderControls();
    requestAnimationFrame(() => {
      const card = ui.controls.querySelector(`[data-control-card="${CSS.escape(control.id)}"]`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card?.querySelector('input, select')?.focus({ preventScroll: true });
    });
  }

  function beginControlChange(event) {
    const element = event.target.closest('[data-theme-control]');
    if (!element) return;
    const id = element.dataset.themeControl;
    if (studio.pendingChange?.id === id) return;
    studio.pendingChange = { id, before: cloneTheme(studio.draft) };
  }

  function previewControlChange(event) {
    const element = event.target.closest('[data-theme-control]');
    if (!element) return;
    if (!studio.pendingChange) studio.pendingChange = { id: element.dataset.themeControl, before: cloneTheme(studio.draft) };
    if (!applyControlElement(element)) return;
    syncControlInputs(element.dataset.themeControl, element);
    renderDerived();
  }

  function commitControlChange(event) {
    const element = event.target.closest('[data-theme-control]');
    if (!element) return;
    const pending = studio.pendingChange || { id: element.dataset.themeControl, before: cloneTheme(studio.draft) };
    if (!applyControlElement(element)) {
      syncControlInputs(element.dataset.themeControl);
      studio.pendingChange = null;
      return;
    }
    syncControlInputs(element.dataset.themeControl, element);
    if (themesDiffer(pending.before, studio.draft)) pushHistory(pending.before);
    studio.pendingChange = null;
    renderDerived();
  }

  function applyControlElement(element) {
    const id = element.dataset.themeControl;
    const control = SITE_THEME_CONTROLS.find((candidate) => candidate.id === id);
    if (!control) return false;
    let value;
    if (control.type === 'boolean') value = element.checked;
    else if (control.type === 'range') value = Number(element.value);
    else value = element.value;
    if (control.type === 'color' && !/^#[a-fA-F0-9]{6}$/.test(value)) return false;
    if (control.type === 'range' && (!Number.isFinite(value) || value < control.min || value > control.max)) return false;
    studio.draft.tokens[id] = control.type === 'color' ? value.toLowerCase() : value;
    return true;
  }

  function syncControlInputs(id, source = null) {
    const value = studio.draft.tokens[id];
    ui.controls.querySelectorAll(`[data-theme-control="${CSS.escape(id)}"]`).forEach((element) => {
      if (element === source) return;
      if (element.type === 'checkbox') element.checked = Boolean(value);
      else element.value = value;
    });
  }

  function beginNameChange() {
    if (studio.pendingChange?.id === 'themeName') return;
    studio.pendingChange = { id: 'themeName', before: cloneTheme(studio.draft) };
  }

  function commitNameChange() {
    studio.draft.name = ui.themeName.value.trim().slice(0, 64) || 'Untitled MATT Mine Theme';
    const before = studio.pendingChange?.before;
    if (before && themesDiffer(before, studio.draft)) pushHistory(before);
    studio.pendingChange = null;
    ui.themeName.value = studio.draft.name;
    renderDerived();
  }

  function pushHistory(theme) {
    studio.history.push(cloneTheme(theme));
    studio.history = studio.history.slice(-100);
    studio.future = [];
  }

  function replaceDraft(next, { remember = true, status = 'DRAFT UPDATED' } = {}) {
    const validated = validateSiteTheme(next);
    if (!themesDiffer(validated, studio.draft)) return;
    if (remember) pushHistory(studio.draft);
    studio.draft = validated;
    studio.pendingChange = null;
    renderControls();
    renderDerived();
    setStatus(status, 'dirty');
  }

  function undo() {
    const previous = studio.history.pop();
    if (!previous) return;
    studio.future.push(cloneTheme(studio.draft));
    studio.draft = previous;
    studio.pendingChange = null;
    renderControls();
    renderDerived();
  }

  function redo() {
    const next = studio.future.pop();
    if (!next) return;
    studio.history.push(cloneTheme(studio.draft));
    studio.draft = next;
    studio.pendingChange = null;
    renderControls();
    renderDerived();
  }

  function scheduleAutosave() {
    clearTimeout(studio.autosaveTimer);
    studio.autosaveTimer = setTimeout(() => {
      try {
        writeSiteThemeDraft(normalizedDraft());
        if (themesDiffer(studio.draft, studio.publishedState.published)) setStatus('BROWSER DRAFT SAVED', 'dirty');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    }, 350);
  }

  function saveBrowserDraft() {
    try {
      writeSiteThemeDraft(normalizedDraft());
      setStatus('BROWSER DRAFT SAVED', themesDiffer(studio.draft, studio.publishedState.published) ? 'dirty' : 'saved');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  function applyPreset() {
    const theme = siteThemePreset(ui.preset.value);
    replaceDraft(theme, { status: 'PRESET APPLIED' });
  }

  function resetToPublished() {
    replaceDraft(studio.publishedState.published, { status: 'DRAFT REVERTED TO LIVE' });
  }

  function resetToDefault() {
    replaceDraft(defaultSiteTheme(), { status: 'ORIGINAL THEME LOADED' });
  }

  async function refreshFromServer() {
    if (themesDiffer(studio.draft, studio.publishedState.published) && !window.confirm('Refresh from the server and replace this browser draft?')) return;
    clearSiteThemeDraft();
    studio.loaded = false;
    await loadThemeStudio(true);
  }

  function exportTheme() {
    const theme = normalizedDraft();
    const payload = {
      format: 'matt-mine-theme',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      theme
    };
    downloadFile(`${slug(theme.name)}.matt-theme.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
    setStatus('THEME EXPORTED', themesDiffer(theme, studio.publishedState.published) ? 'dirty' : 'saved');
  }

  async function importTheme() {
    const file = ui.importFile.files?.[0];
    ui.importFile.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const theme = validateSiteTheme(parsed.theme || parsed);
      replaceDraft(theme, { status: 'THEME IMPORTED' });
    } catch (error) {
      setStatus(`IMPORT FAILED · ${error.message}`, 'error');
    }
  }

  async function copyCssVariables() {
    try {
      await navigator.clipboard.writeText(themeCssText(normalizedDraft()));
      setStatus('CSS VARIABLES COPIED', themesDiffer(studio.draft, studio.publishedState.published) ? 'dirty' : 'saved');
    } catch {
      setStatus('CLIPBOARD ACCESS FAILED', 'error');
    }
  }

  function openFullPreview() {
    try {
      writeSiteThemeDraft(normalizedDraft());
      const preview = window.open('/?theme-preview=1', '_blank', 'noopener');
      if (!preview) setStatus('ALLOW POPUPS TO OPEN PREVIEW', 'error');
      else setStatus('FULL-SITE PREVIEW OPENED', themesDiffer(studio.draft, studio.publishedState.published) ? 'dirty' : 'saved');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function publishTheme() {
    const theme = normalizedDraft();
    const reason = ui.publishReason.value.trim();
    if (reason.length < 5) {
      ui.publishReason.focus();
      setStatus('ADD A PUBLISH REASON', 'error');
      return;
    }
    if (!themesDiffer(theme, studio.publishedState.published)) return;
    const changeCount = changedSiteThemeControls(theme, studio.publishedState.published).length;
    if (!window.confirm(`Publish “${theme.name}” with ${changeCount} changed design controls to every player?`)) return;
    ui.publish.disabled = true;
    setStatus('WAITING FOR RONIN SIGNATURE', 'loading');
    try {
      writeSiteThemeDraft(theme);
      const payload = await adminApi()('/api/admin/site-theme', { method: 'PUT', body: { theme, reason } });
      studio.publishedState = { ...payload.siteTheme, published: validateSiteTheme(payload.siteTheme.published) };
      studio.draft = cloneTheme(studio.publishedState.published);
      studio.history = [];
      studio.future = [];
      ui.publishReason.value = '';
      clearSiteThemeDraft();
      renderAll();
      setStatus(`PUBLISHED LIVE · V${studio.publishedState.version}`, 'saved');
    } catch (error) {
      setStatus(error.message || 'PUBLISH FAILED', 'error');
      ui.publish.disabled = false;
    }
  }

  function normalizedDraft() {
    return validateSiteTheme({ ...studio.draft, name: studio.draft.name.trim() || 'Untitled MATT Mine Theme' });
  }

  function adminApi() {
    const fetcher = window.mattMineAdminSession?.fetch;
    if (!fetcher) throw new Error('Unlock the Command Center with an authorized Ronin wallet.');
    return fetcher;
  }

  function setStatus(message, state) {
    ui.status.textContent = String(message || '').toUpperCase().slice(0, 72);
    ui.status.dataset.state = state;
  }
}

function themesDiffer(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function cloneTheme(theme) {
  return structuredClone(theme);
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function slug(value) {
  return String(value || 'matt-mine-theme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'matt-mine-theme';
}

function createElement(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  if (options.type) element.type = options.type;
  for (const [key, value] of Object.entries(options.dataset || {})) element.dataset[key] = value;
  return element;
}

function themeInput(control, type, value) {
  const input = createElement('input', {
    type,
    dataset: { themeControl: control.id, themeInput: type }
  });
  if (type !== 'checkbox') input.value = value;
  return input;
}

function downloadFile(fileName, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
