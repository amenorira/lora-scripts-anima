/* Tagger desktop workspace. State is kept in Alpine; large media stays in browser/server caches. */
window.taggerMixin = {
  taggerModels: [],
  taggerHardware: {},
  taggerSelectedModel: '',
  taggerSourceMode: 'folder',
  taggerSourcePath: '',
  taggerSource: null,
  taggerScanning: false,
  taggerStarting: false,
  taggerRunning: false,
  taggerTaskId: null,
  taggerTask: null,
  taggerItems: [],
  taggerItemsTotal: 0,
  taggerSelectedIndex: 0,
  taggerResultText: '',
  taggerResultCategories: {},
  taggerCategoryState: {},
  taggerCategoryGlobalThreshold: 0.5,
  taggerFilmstripCollapsed: false,
  taggerFailedOnly: false,
  taggerLogsOpen: false,
  taggerPreviewScale: 1,
  taggerPreviewX: 0,
  taggerPreviewY: 0,
  taggerPreviewPanning: false,
  taggerPreviewPointerId: null,
  taggerPreviewPanStartX: 0,
  taggerPreviewPanStartY: 0,
  taggerDragOver: false,
  taggerSingleLeftWidth: 55,
  taggerSingleResizing: false,
  taggerSingleResultHeight: 190,
  taggerResultResizing: false,
  _taggerResultResizeStartY: 0,
  _taggerResultResizeStartHeight: 190,
  taggerSettings: {
    preset: 'balanced',
    conflict: 'ignore',
    threshold: 0.35,
    characterThreshold: 0.6,
    recursive: true,
    replaceUnderscore: true,
    escapeTag: true,
    addRatingTag: false,
    addModelTag: false,
    removeDuplicated: false,
    categoryThresholds: {},
    categoryEnabledByModel: {},
    characterEnabledByModel: {},
    additionalTags: '',
    excludeTags: '',
  },
  _taggerRealtimeTopic: null,
  _taggerLastItemsFetch: 0,
  _taggerPreviewObjectUrl: null,
  _taggerLoadedResultKey: '',
  _taggerModeStates: { folder: null, single: null },

  TAGGER_CAMIE_PRESETS: {
    macro: { general: 0.492, character: 0.492, copyright: 0.492, artist: 0.492, meta: 0.492, year: 0.492, rating: 0.492 },
    micro: { general: 0.614, character: 0.614, copyright: 0.614, artist: 0.614, meta: 0.614, year: 0.614, rating: 0.614 },
  },
  TAGGER_CL_PRESETS: {
    macro: { general: 0.35, character: 0.6, copyright: 0.35, artist: 0.35, meta: 0.35, quality: 0.35, rating: 0.35 },
    micro: { general: 0.45, character: 0.7, copyright: 0.45, artist: 0.45, meta: 0.45, quality: 0.45, rating: 0.45 },
  },

  async buildTaggerForm() {
    await this._mountTaggerWorkspace();
    this._loadTaggerSettings();
    this.realtimeSubscribe('hardware');
    this.renderTaggerResourceBar();
    await this.loadTaggerModels();
    const stored = localStorage.getItem('anima-tagger-task-id');
    let taskId = '';
    try {
      const response = await fetch('/api/tagger/tasks/active');
      const body = await response.json();
      taskId = body.status === 'success' && body.data ? body.data.task_id || '' : '';
    } catch (_) {}
    taskId = taskId || stored || '';
    if (taskId) await this.restoreTaggerTask(taskId);
  },

  renderTaggerResourceBar() {
    if (typeof this._renderResourceBar !== 'function') return;
    const translate = (key, fallback) => this.t('monitor.' + key, fallback) || fallback || key;
    this._renderResourceBar('taggerResbar', this.gpuInfo, this.sysInfo, translate, this.locale);
  },

  async _mountTaggerWorkspace() {
    const host = document.getElementById('taggerWorkspaceHost');
    if (!host || host.dataset.mounted === '1') return;
    try {
      const response = await fetch('/anima-ui/tagger-workspace.html?v=20260815-tagger27');
      if (!response.ok) throw new Error('Workspace template unavailable');
      host.innerHTML = await response.text();
      host.dataset.mounted = '1';
      if (window.Alpine) Alpine.initTree(host);
      requestAnimationFrame(() => this._syncTaggerTabIndicator());
    } catch (error) {
      host.textContent = error.message;
    }
  },

  stopTaggerWorkspace() {
    this.realtimeUnsubscribe('hardware');
    this._setTaggerRealtimeTask(null);
    this.stopTaggerSingleResize();
    this.stopTaggerResultResize();
    this._releaseTaggerPreview();
    Object.values(this._taggerModeStates).forEach(state => {
      if (!state?.previewObjectUrl) return;
      URL.revokeObjectURL(state.previewObjectUrl);
      state.previewObjectUrl = null;
    });
  },

  _loadTaggerSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('anima-tagger-settings') || '{}');
      delete saved.categoryEnabled;
      this.taggerSettings = Object.assign({}, this.taggerSettings, saved);
    } catch (_) {}
  },

  saveTaggerSettings() {
    localStorage.setItem('anima-tagger-settings', JSON.stringify(this.taggerSettings));
  },

  async loadTaggerModels() {
    try {
      const response = await fetch('/api/tagger/models');
      const body = await response.json();
      if (body.status !== 'success' || !body.data) throw new Error(body.message || 'Model registry unavailable');
      this.taggerModels = body.data.models || [];
      this.taggerHardware = body.data.hardware || {};
      const savedModel = localStorage.getItem('anima-tagger-model') || '';
      if (!this.taggerSelectedModel && this.taggerModels.some(model => model.id === savedModel)) {
        this.taggerSelectedModel = savedModel;
      }
      if (!this.taggerModels.some(model => model.id === this.taggerSelectedModel)) {
        this.taggerSelectedModel = this.taggerModels[0] ? this.taggerModels[0].id : '';
      }
      this.handleTaggerModelChange(false);
    } catch (error) {
      this.toast(this.t('tagger.modelLoadFailed') + ': ' + error.message, 'error');
    }
  },

  taggerModel() {
    return this.taggerModels.find(model => model.id === this.taggerSelectedModel) || null;
  },

  taggerModelSelectConfig() {
    const separator = this.t('tagger.factSeparator');
    const groups = [['tagger', this.t('tagger.dedicatedModels')]];
    return {
      groups: groups.map(([family, label]) => ({
        label,
        options: this.taggerModels.filter(model => model.family === family).map(model => {
          return {
            v: model.id,
            l: model.name,
            d: [this.taggerModelPurpose(model.id)].filter(Boolean).join(separator),
          };
        }),
      })).filter(group => group.options.length),
    };
  },

  taggerPresetSelectConfig() {
    return { options: this.taggerPresetOptions().map(option => ({
      v: option[0],
      l: option[1],
      d: this.taggerPresetDescription(option[0]),
    })) };
  },

  taggerConflictSelectConfig() {
    return { options: [
      { v: 'ignore', l: this.t('tagger.conflictIgnore') },
      { v: 'copy', l: this.t('tagger.conflictCopy') },
      { v: 'prepend', l: this.t('tagger.conflictMerge') },
    ] };
  },

  taggerPresetDescription(preset) {
    const suffix = preset.charAt(0).toUpperCase() + preset.slice(1);
    if (preset === 'custom') return this.t('tagger.presetCustomDesc');
    if (this.taggerUsesCategoryThresholds()) return this.t(`tagger.preset${suffix}Desc`);
    return this.t(`tagger.presetOnnx${suffix}Desc`);
  },


  taggerModelPurpose(modelId) {
    const key = {
      'camie-tagger-v2': 'modelPurposeCamie',
      'wd-eva02-large-tagger-v3': 'modelPurposeEva',
      'wd-vit-large-tagger-v3': 'modelPurposeVit',
      'cl_tagger_1_02': 'modelPurposeCl',
    }[modelId];
    return key ? this.t(`tagger.${key}`) : '';
  },


  taggerUsesCategoryThresholds() {
    return this.taggerCategoryKeys().length > 0;
  },

  taggerCategoryKeys() {
    const categories = this.taggerModel()?.threshold_categories;
    return Array.isArray(categories) ? categories : [];
  },

  taggerSupportsStandaloneRatingToggle() {
    return !this.taggerUsesCategoryThresholds();
  },

  taggerSupportsModelTag() {
    return this.taggerModel()?.supports_model_tag === true;
  },

  taggerSupportsCharacterToggle() {
    return this.taggerModel()?.supports_character_toggle === true;
  },

  taggerCharacterEnabled() {
    return this.taggerSettings.characterEnabledByModel?.[this.taggerSelectedModel] !== false;
  },

  setTaggerCharacterEnabled(enabled) {
    this.taggerSettings.characterEnabledByModel = Object.assign(
      {},
      this.taggerSettings.characterEnabledByModel,
      { [this.taggerSelectedModel]: !!enabled },
    );
    this.saveTaggerSettings();
    const character = this.taggerCategoryState.character;
    if (character) {
      character.visible = !!enabled;
      this.recalculateTaggerCategory('character');
    }
  },

  taggerCategoryEnabled(key) {
    return this.taggerSettings.categoryEnabledByModel?.[this.taggerSelectedModel]?.[key] !== false;
  },

  setTaggerCategoryEnabled(key, enabled) {
    const modelSettings = Object.assign(
      {},
      this.taggerSettings.categoryEnabledByModel?.[this.taggerSelectedModel],
      { [key]: !!enabled },
    );
    this.taggerSettings.categoryEnabledByModel = Object.assign(
      {},
      this.taggerSettings.categoryEnabledByModel,
      { [this.taggerSelectedModel]: modelSettings },
    );
    this.saveTaggerSettings();
    const category = this.taggerCategoryState[key];
    if (category) {
      category.visible = !!enabled;
      this.recalculateTaggerCategory(key);
    }
  },

  taggerCategoryLabel(key) {
    const suffix = key.charAt(0).toUpperCase() + key.slice(1);
    return this.t('tagger.cat' + suffix, key);
  },

  handleTaggerModelChange(resetPreset = true) {
    localStorage.setItem('anima-tagger-model', this.taggerSelectedModel || '');
    if (resetPreset) {
      this._clearTaggerResultState(true);
      Object.values(this._taggerModeStates).forEach(state => this._clearStoredTaggerResult(state));
    }
    const allowed = this.taggerPresetOptions().map(option => option[0]);
    let preset = this.taggerSettings.preset;
    if (resetPreset || !allowed.includes(preset)) {
      preset = this.taggerUsesCategoryThresholds() ? 'macro' : 'balanced';
    }
    this.applyTaggerPreset(preset);
  },

  changeTaggerModel(modelId) {
    if (this.taggerRunning || this.taggerStarting || modelId === this.taggerSelectedModel) return;
    this.taggerSelectedModel = modelId;
    this.handleTaggerModelChange(true);
  },

  taggerCanStart() {
    return !!(this.taggerSource && this.taggerSource.total && this.taggerSelectedModel
      && !this.taggerRunning && !this.taggerStarting && !this.trainingActive);
  },

  taggerStartLabel() {
    if (this.taggerStarting) return this.t('common.starting');
    return this.t('tagger.start');
  },

  applyTaggerPreset(preset) {
    this.taggerSettings.preset = preset;
    if (preset === 'custom') {
      this.saveTaggerSettings();
      return;
    }
    if (this.taggerUsesCategoryThresholds()) {
      const presets = this.taggerSelectedModel === 'camie-tagger-v2' ? this.TAGGER_CAMIE_PRESETS : this.TAGGER_CL_PRESETS;
      if (preset !== 'custom' && presets[preset]) {
        this.taggerSettings.categoryThresholds = Object.assign({}, this.taggerSettings.categoryThresholds, presets[preset]);
      }
    } else {
      const values = {
        recall: [0.25, 0.50], balanced: [0.35, 0.60], precise: [0.50, 0.72],
      }[preset] || [0.35, 0.60];
      this.taggerSettings.threshold = values[0];
      this.taggerSettings.characterThreshold = values[1];
    }
    this.saveTaggerSettings();
    if (Object.keys(this.taggerCategoryState).length) {
      Object.entries(this.taggerCategoryState).forEach(([key, category]) => {
        if (this.taggerUsesCategoryThresholds()) {
          category.threshold = Number(this.taggerSettings.categoryThresholds[key] ?? category.threshold);
        } else {
          category.threshold = Number(key === 'character' ? this.taggerSettings.characterThreshold : this.taggerSettings.threshold);
        }
      });
      this.recalculateAllTaggerCategories(true);
    }
  },

  taggerPresetOptions() {
    if (this.taggerUsesCategoryThresholds()) return [['macro', this.t('tagger.presetMacro')], ['micro', this.t('tagger.presetMicro')], ['custom', this.t('tagger.presetCustom')]];
    return [['recall', this.t('tagger.presetRecall')], ['balanced', this.t('tagger.presetBalanced')], ['precise', this.t('tagger.presetPrecise')], ['custom', this.t('tagger.presetCustom')]];
  },

  setTaggerCustomPreset() {
    this.taggerSettings.preset = 'custom';
    this.saveTaggerSettings();
    if (!Object.keys(this.taggerCategoryState).length || this.taggerUsesCategoryThresholds()) return;
    Object.entries(this.taggerCategoryState).forEach(([key, category]) => {
      category.threshold = Number(key === 'character'
        ? this.taggerSettings.characterThreshold
        : this.taggerSettings.threshold);
    });
    this.recalculateAllTaggerCategories(true);
  },


  updateTaggerCategorySetting(key) {
    this.taggerSettings.preset = 'custom';
    this.taggerSettings.categoryThresholds = Object.assign({}, this.taggerSettings.categoryThresholds, {
      [key]: Math.max(0, Math.min(1, Number(this.taggerSettings.categoryThresholds[key]) || 0)),
    });
    this.saveTaggerSettings();
    const category = this.taggerCategoryState[key];
    if (category) {
      category.threshold = this.taggerSettings.categoryThresholds[key];
      this.recalculateTaggerCategory(key);
    }
  },

  adjustTaggerCategoryThreshold(key, delta) {
    const current = Number(this.taggerSettings.categoryThresholds[key]) || 0;
    this.taggerSettings.categoryThresholds = Object.assign({}, this.taggerSettings.categoryThresholds, {
      [key]: Number(Math.max(0, Math.min(1, current + delta)).toFixed(3)),
    });
    this.updateTaggerCategorySetting(key);
  },

  taggerEffectiveCategoryThresholds() {
    if (!this.taggerUsesCategoryThresholds()) return {};
    return Object.fromEntries(this.taggerCategoryKeys().map(key => [
      key,
      Number(this.taggerSettings.categoryThresholds[key] ?? 0.35),
    ]));
  },

  taggerEffectiveCategoryEnabled() {
    if (this.taggerSupportsCharacterToggle()) return { character: this.taggerCharacterEnabled() };
    return Object.fromEntries(this.taggerCategoryKeys().map(key => [key, this.taggerCategoryEnabled(key)]));
  },

  async selectTaggerSourceMode(mode) {
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning
      || !['folder', 'single'].includes(mode) || mode === this.taggerSourceMode) return;
    this.stopTaggerSingleResize();
    this.stopTaggerResultResize();
    this._taggerModeStates[this.taggerSourceMode] = this._captureTaggerModeState();
    this.taggerSourceMode = mode;
    const stored = this._taggerModeStates[mode];
    this._taggerModeStates[mode] = null;
    this._restoreTaggerModeState(stored);
    this.resetTaggerPreview();
    requestAnimationFrame(() => this._syncTaggerTabIndicator());
  },

  // 模式 tab 滑动指示条：与监控台 tab 共用 .monitor-tab-indicator 样式
  _syncTaggerTabIndicator() {
    const bar = document.querySelector('.tagger-mode-tabs');
    if (!bar) return;
    const indicator = bar.querySelector('.monitor-tab-indicator');
    const active = bar.querySelector('button.active');
    if (!indicator || !active || !active.offsetWidth) return;
    if (!bar.classList.contains('indicator-ready')) {
      bar.classList.add('no-anim');
      indicator.style.width = active.offsetWidth + 'px';
      indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      void indicator.offsetWidth; // 强制 reflow，首次定位不播放动画
      bar.classList.remove('no-anim');
      bar.classList.add('indicator-ready');
      return;
    }
    indicator.style.width = active.offsetWidth + 'px';
    indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  },

  _captureTaggerModeState() {
    return {
      sourcePath: this.taggerSourcePath,
      source: this.taggerSource,
      taskId: this.taggerTaskId,
      task: this.taggerTask,
      items: this.taggerItems,
      itemsTotal: this.taggerItemsTotal,
      selectedIndex: this.taggerSelectedIndex,
      resultText: this.taggerResultText,
      resultCategories: this.taggerResultCategories,
      categoryState: this.taggerCategoryState,
      loadedResultKey: this._taggerLoadedResultKey,
      previewObjectUrl: this._taggerPreviewObjectUrl,
      failedOnly: this.taggerFailedOnly,
      logsOpen: this.taggerLogsOpen,
    };
  },

  _restoreTaggerModeState(state) {
    this.taggerSourcePath = state?.sourcePath || '';
    this.taggerSource = state?.source || null;
    this.taggerTaskId = state?.taskId || null;
    this.taggerTask = state?.task || null;
    this.taggerItems = state?.items || [];
    this.taggerItemsTotal = Number(state?.itemsTotal || 0);
    this.taggerSelectedIndex = Number(state?.selectedIndex || 0);
    this.taggerResultText = state?.resultText || '';
    this.taggerResultCategories = state?.resultCategories || {};
    this.taggerCategoryState = state?.categoryState || {};
    this._taggerLoadedResultKey = state?.loadedResultKey || '';
    this._taggerPreviewObjectUrl = state?.previewObjectUrl || null;
    this.taggerFailedOnly = !!state?.failedOnly;
    this.taggerLogsOpen = !!state?.logsOpen;
    if (this.taggerTaskId) localStorage.setItem('anima-tagger-task-id', this.taggerTaskId);
    else localStorage.removeItem('anima-tagger-task-id');
  },

  clearTaggerSource() {
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning) return;
    this.stopTaggerSingleResize();
    this.stopTaggerResultResize();
    this._taggerModeStates[this.taggerSourceMode] = null;
    this._releaseTaggerPreview();
    this._restoreTaggerModeState(null);
    this.resetTaggerPreview();
  },

  _clearStoredTaggerResult(state) {
    if (!state) return;
    state.taskId = null;
    state.task = null;
    state.resultText = '';
    state.resultCategories = {};
    state.categoryState = {};
    state.loadedResultKey = '';
    state.items = (state.items || []).map(item => {
      const next = Object.assign({}, item, { status: 'pending' });
      delete next.result;
      delete next.tag_count;
      delete next.error;
      return next;
    });
  },

  _clearTaggerResultState(clearTask = false) {
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    this._taggerLoadedResultKey = '';
    if (!clearTask) return;
    this._setTaggerRealtimeTask(null);
    this.taggerTaskId = null;
    this.taggerTask = null;
    this.taggerItems = this.taggerItems.map(item => {
      const next = Object.assign({}, item, { status: 'pending' });
      delete next.result;
      delete next.tag_count;
      delete next.error;
      return next;
    });
    localStorage.removeItem('anima-tagger-task-id');
  },

  async pickTaggerSource() {
    try {
      const picker = this.taggerSourceMode === 'single' ? 'image-file' : 'folder';
      const response = await fetch('/api/pick_file?picker_type=' + picker);
      const body = await response.json();
      if (body.status === 'success' && body.data && body.data.path) {
        this.taggerSourcePath = body.data.path;
        await this.scanTaggerSource();
      }
    } catch (_) { this.toast(this.t('common.localPickerNA')); }
  },

  scheduleTaggerSourceScan() {
    if (this._taggerSourceScanTimer) clearTimeout(this._taggerSourceScanTimer);
    this._taggerSourceScanTimer = null;
    this._taggerSourceScanVersion = Number(this._taggerSourceScanVersion || 0) + 1;

    const path = this.taggerSourcePath.trim();
    const scannedPath = String(this.taggerSource?.path || '').trim();
    if (this.taggerSource && path !== scannedPath) {
      this.taggerSource = null;
      this.taggerItems = [];
      this.taggerItemsTotal = 0;
      this.taggerSelectedIndex = 0;
      this.taggerResultText = '';
      this.taggerResultCategories = {};
      this.taggerCategoryState = {};
      this._taggerLoadedResultKey = '';
    }
    if (!path || this.taggerRunning) return;

    this._taggerSourceScanTimer = setTimeout(() => {
      this._taggerSourceScanTimer = null;
      void this.scanTaggerSource({ quiet: true });
    }, 500);
  },

  async handleTaggerFileInput(event) {
    const file = event.target.files && event.target.files[0];
    if (file) await this.uploadTaggerFile(file);
    event.target.value = '';
  },

  async handleTaggerDrop(event) {
    this.taggerDragOver = false;
    if (this.taggerSourceMode !== 'single') return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) await this.uploadTaggerFile(file);
  },

  async uploadTaggerFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    this.taggerScanning = true;
    this._releaseTaggerPreview();
    this._taggerPreviewObjectUrl = URL.createObjectURL(file);
    this.taggerSourcePath = file.name;
    try {
      const data = new FormData();
      data.append('file', file, file.name);
      const response = await fetch('/api/tagger/uploads', { method: 'POST', body: data });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Upload failed');
      body.data.display_name = file.name || this.t('tagger.singleImage');
      this.setTaggerSource(body.data);
    } catch (error) {
      this.toast(error.message, 'error');
    } finally { this.taggerScanning = false; }
  },

  async scanTaggerSource(options = {}) {
    if (this._taggerSourceScanTimer) clearTimeout(this._taggerSourceScanTimer);
    this._taggerSourceScanTimer = null;
    const path = this.taggerSourcePath.trim();
    if (!path) return;
    const scanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    this._taggerSourceScanVersion = scanVersion;
    this.taggerScanning = true;
    try {
      const response = await fetch('/api/tagger/source/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, recursive: this.taggerSettings.recursive }),
      });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Scan failed');
      if (scanVersion !== this._taggerSourceScanVersion || path !== this.taggerSourcePath.trim()) return;
      this.setTaggerSource(body.data);
    } catch (error) {
      if (scanVersion === this._taggerSourceScanVersion && !options.quiet) this.toast(error.message, 'error');
    } finally {
      if (scanVersion === this._taggerSourceScanVersion) this.taggerScanning = false;
    }
  },

  setTaggerSource(source) {
    if (!this.taggerRunning) {
      this.taggerTaskId = null;
      this.taggerTask = null;
      localStorage.removeItem('anima-tagger-task-id');
    }
    this.taggerSource = source;
    this.taggerSourcePath = source.display_name || source.path || this.taggerSourcePath;
    this.taggerItems = (source.items || []).map(item => Object.assign({ status: 'pending' }, item));
    this.taggerItemsTotal = Number(source.total || this.taggerItems.length);
    this.taggerSelectedIndex = 0;
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    this._taggerLoadedResultKey = '';
    this.resetTaggerPreview();
    this.saveTaggerSettings();
  },

  taggerPreviewUrl(index) {
    if (this.taggerSourceMode === 'single' && this._taggerPreviewObjectUrl && index === 0) return this._taggerPreviewObjectUrl;
    if (!this.taggerSource) return '';
    const params = new URLSearchParams({
      scope: 'tagger', source_token: this.taggerSource.source_token,
      index: String(index), variant: 'original'
    });
    return `/api/image-preview?${params.toString()}`;
  },

  taggerPreviewTransform() {
    return `transform: translate3d(${this.taggerPreviewX}px, ${this.taggerPreviewY}px, 0) scale(${this.taggerPreviewScale})`;
  },

  resetTaggerPreview() {
    this.taggerPreviewScale = 1;
    this.taggerPreviewX = 0;
    this.taggerPreviewY = 0;
    this.taggerPreviewPanning = false;
    this.taggerPreviewPointerId = null;
  },

  zoomTaggerPreview(event) {
    if (!this.taggerSource) return;
    const current = Number(this.taggerPreviewScale) || 1;
    const factor = event.deltaY < 0 ? 1.15 : (1 / 1.15);
    const next = Math.min(8, Math.max(1, Number((current * factor).toFixed(3))));
    if (next === current) return;
    if (next === 1) {
      this.resetTaggerPreview();
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const cursorX = event.clientX - (rect.left + rect.width / 2);
    const cursorY = event.clientY - (rect.top + rect.height / 2);
    const ratio = next / current;
    this.taggerPreviewX = cursorX - ratio * (cursorX - this.taggerPreviewX);
    this.taggerPreviewY = cursorY - ratio * (cursorY - this.taggerPreviewY);
    this.taggerPreviewScale = next;
  },

  startTaggerPreviewPan(event) {
    if (event.button !== 0 || this.taggerPreviewScale <= 1) return;
    this.taggerPreviewPanning = true;
    this.taggerPreviewPointerId = event.pointerId;
    this.taggerPreviewPanStartX = event.clientX - this.taggerPreviewX;
    this.taggerPreviewPanStartY = event.clientY - this.taggerPreviewY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  },

  moveTaggerPreviewPan(event) {
    if (!this.taggerPreviewPanning || event.pointerId !== this.taggerPreviewPointerId) return;
    this.taggerPreviewX = event.clientX - this.taggerPreviewPanStartX;
    this.taggerPreviewY = event.clientY - this.taggerPreviewPanStartY;
  },

  stopTaggerPreviewPan(event) {
    if (!this.taggerPreviewPanning || (event && event.pointerId !== this.taggerPreviewPointerId)) return;
    event?.currentTarget?.releasePointerCapture?.(this.taggerPreviewPointerId);
    this.taggerPreviewPanning = false;
    this.taggerPreviewPointerId = null;
  },

  startTaggerSingleResize(event) {
    if (event && event.button !== 0) return;
    this.taggerSingleResizing = true;
    document.body.classList.add('tagger-single-resizing');
  },

  resizeTaggerSingleLayout(event) {
    if (!this.taggerSingleResizing) return;
    const layout = document.querySelector('.tagger-single-layout');
    if (!layout) return;
    const rect = layout.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const percent = ((event.clientX - rect.left) / width) * 100;
    this.taggerSingleLeftWidth = Math.min(70, Math.max(30, Math.round(percent * 10) / 10));
  },

  stopTaggerSingleResize() {
    this.taggerSingleResizing = false;
    document.body.classList.remove('tagger-single-resizing');
  },

  taggerResultResizeMax() {
    const main = document.querySelector('.tagger-single-main');
    const tags = document.querySelector('.tagger-result-tags');
    if (!main || !tags) return 190;
    const divider = document.querySelector('.tagger-result-divider');
    const actions = document.querySelector('.tagger-single-result .tagger-result-actions');
    const reserved = Number(divider?.offsetHeight || 0) + Number(actions?.offsetHeight || 0);
    return Math.max(94, Math.floor(main.getBoundingClientRect().bottom - tags.getBoundingClientRect().top - reserved));
  },

  adjustTaggerResultHeight(delta) {
    const next = Number(this.taggerSingleResultHeight || 190) + Number(delta || 0);
    this.taggerSingleResultHeight = Math.min(this.taggerResultResizeMax(), Math.max(94, next));
  },

  startTaggerResultResize(event) {
    if (event && event.button !== 0) return;
    const tags = document.querySelector('.tagger-result-tags');
    if (!tags) return;
    this.taggerSingleResultHeight = Math.min(this.taggerResultResizeMax(), Math.max(94, tags.getBoundingClientRect().height));
    this._taggerResultResizeStartY = event.clientY;
    this._taggerResultResizeStartHeight = this.taggerSingleResultHeight;
    this.taggerResultResizing = true;
    document.body.classList.add('tagger-result-resizing');
  },

  resizeTaggerResult(event) {
    if (!this.taggerResultResizing) return;
    const delta = event.clientY - this._taggerResultResizeStartY;
    const next = this._taggerResultResizeStartHeight + delta;
    this.taggerSingleResultHeight = Math.min(this.taggerResultResizeMax(), Math.max(94, Math.round(next)));
  },

  stopTaggerResultResize() {
    this.taggerResultResizing = false;
    document.body.classList.remove('tagger-result-resizing');
  },

  selectTaggerItem(item) {
    this.taggerSelectedIndex = Number(item.index || 0);
    const result = item.result || (this.taggerTask && this.taggerTask.current_result && this.taggerTask.current_result.index === this.taggerSelectedIndex ? this.taggerTask.current_result : null);
    this.setTaggerResult(result, true);
  },

  setTaggerResult(result, force = false) {
    if (!result) {
      this.taggerResultText = '';
      this.taggerResultCategories = {};
      this.taggerCategoryState = {};
      this._taggerLoadedResultKey = '';
      return;
    }
    const resultKey = `${this.taggerTaskId || 'source'}:${Number(result.index || 0)}:${result.path || result.name || ''}`;
    if (!force && resultKey === this._taggerLoadedResultKey) return;
    this._taggerLoadedResultKey = resultKey;
    this.taggerResultText = result.text || '';
    this.taggerResultCategories = result.categories || {};
    const labels = result.labels || {};
    const state = {};
    if (this.taggerSourceMode === 'single') {
      Object.entries(this.taggerResultCategories).forEach(([key, category]) => {
        const rawTags = Array.isArray(category) ? category : (category.tags || []);
        if (!rawTags.length) return;
        const defaultThreshold = key === 'character' ? this.taggerSettings.characterThreshold : this.taggerSettings.threshold;
        state[key] = {
          label: category.label || labels[key] || this.taggerCategoryLabel(key),
          tags: rawTags,
          threshold: Number(this.taggerSettings.categoryThresholds[key] ?? defaultThreshold ?? 0.5),
          visible: this.taggerUsesCategoryThresholds()
            ? this.taggerCategoryEnabled(key)
            : key !== 'character' || !this.taggerSupportsCharacterToggle() || this.taggerCharacterEnabled(),
          collapsed: key !== 'general',
          visibleTags: [],
          total: Number(category.total || rawTags.length),
          truncated: !!category.truncated,
        };
      });
    }
    this.taggerCategoryState = state;
    if (Object.keys(state).length) {
      this.taggerCategoryGlobalThreshold = Number(state.general?.threshold ?? this.taggerSettings.threshold ?? 0.5);
      this.recalculateAllTaggerCategories(true);
    }
  },

  recalculateTaggerCategory(key, updateResult = true) {
    const category = this.taggerCategoryState[key];
    if (!category) return;
    const threshold = Math.max(0, Math.min(1, Number(category.threshold) || 0));
    category.threshold = threshold;
    category.visibleTags = category.visible
      ? category.tags.filter(tag => Number(tag[1]) >= threshold).slice(0, 200)
      : [];
    if (updateResult) this.refreshTaggerResultFromCategories();
  },

  updateTaggerResultCategory(key) {
    const category = this.taggerCategoryState[key];
    if (!category) return;
    category.threshold = Math.max(0, Math.min(1, Number(category.threshold) || 0));
    if (this.taggerUsesCategoryThresholds()) {
      this.taggerSettings.preset = 'custom';
      this.taggerSettings.categoryThresholds = Object.assign({}, this.taggerSettings.categoryThresholds, {
        [key]: category.threshold,
      });
    }
    this.saveTaggerSettings();
    this.recalculateTaggerCategory(key);
  },

  toggleTaggerResultCategory(key) {
    const category = this.taggerCategoryState[key];
    if (!category) return;
    this.recalculateTaggerCategory(key);
  },

  recalculateAllTaggerCategories(updateResult = true) {
    Object.keys(this.taggerCategoryState).forEach(key => this.recalculateTaggerCategory(key, false));
    if (updateResult) this.refreshTaggerResultFromCategories();
  },

  applyTaggerGlobalThreshold() {
    const threshold = Math.max(0, Math.min(1, Number(this.taggerCategoryGlobalThreshold) || 0));
    this.taggerCategoryGlobalThreshold = threshold;
    Object.values(this.taggerCategoryState).forEach(category => { category.threshold = threshold; });
    if (this.taggerUsesCategoryThresholds()) {
      this.taggerSettings.preset = 'custom';
      this.taggerSettings.categoryThresholds = Object.fromEntries(this.taggerCategoryKeys().map(key => [key, threshold]));
    } else {
      this.taggerSettings.threshold = threshold;
      this.taggerSettings.characterThreshold = threshold;
    }
    this.saveTaggerSettings();
    this.recalculateAllTaggerCategories(true);
  },

  setAllTaggerCategoriesVisible(visible) {
    Object.values(this.taggerCategoryState).forEach(category => { category.visible = visible; });
    this.recalculateAllTaggerCategories(true);
  },

  formatTaggerOutputName(name) {
    let value = String(name || '');
    if (this.taggerSettings.replaceUnderscore) value = value.replace(/_/g, ' ');
    if (this.taggerSettings.escapeTag) value = value.replace(/([\\()])/g, '\\$1');
    return value;
  },

  taggerDisplayName(name) {
    const value = String(name || '');
    return this.taggerSettings.replaceUnderscore ? value.replace(/_/g, ' ') : value;
  },

  taggerResultTags() {
    return String(this.taggerResultText || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
  },

  taggerVisibleCategoryTags() {
    const values = [];
    const seen = new Set();
    Object.entries(this.taggerCategoryState).forEach(([key, category]) => {
      if (!category.visible) return;
      category.visibleTags.forEach(tag => {
        const raw = String(tag[0] || '').trim();
        const normalized = raw.toLowerCase();
        if (!raw || (this.taggerSettings.removeDuplicated && seen.has(normalized))) return;
        seen.add(normalized);
        values.push(this.formatTaggerOutputName(raw));
      });
    });
    return values;
  },

  refreshTaggerResultFromCategories() {
    if (this.taggerSourceMode !== 'single' || !Object.keys(this.taggerCategoryState).length) return;
    this.taggerResultText = this.taggerVisibleCategoryTags().join(', ');
  },

  taggerVisibleCategoryCount() {
    return this.taggerResultTags().length;
  },

  updateTaggerOutputSettings() {
    this.saveTaggerSettings();
    if (Object.keys(this.taggerCategoryState).length) this.refreshTaggerResultFromCategories();
  },

  async copyTaggerCategory(key) {
    const category = this.taggerCategoryState[key];
    if (!category) return;
    const text = category.visibleTags.map(tag => this.formatTaggerOutputName(tag[0])).join(', ');
    if (!text) return;
    try { await navigator.clipboard.writeText(text); this.toast(this.t('tagger.copied')); }
    catch (_) { this.toast(this.t('common.failed'), 'error'); }
  },

  async startTagger() {
    if (!this.taggerCanStart()) return;

    this._clearTaggerResultState(true);
    this.taggerStarting = true;
    this.saveTaggerSettings();
    try {
      const categoryKeys = this.taggerCategoryKeys();
      const categoryEnabled = this.taggerEffectiveCategoryEnabled();
      const categoryOptionEnabled = key => categoryKeys.includes(key) && categoryEnabled[key] !== false;
      const payload = {
        source_token: this.taggerSource.source_token,
        model_id: this.taggerSelectedModel,
        conflict: this.taggerSettings.conflict,
        write_captions: this.taggerSourceMode === 'folder',
        options: {
          threshold: Number(this.taggerSettings.threshold),
          character_threshold: Number(this.taggerSettings.characterThreshold),
          category_thresholds: this.taggerEffectiveCategoryThresholds(),
          category_enabled: this.taggerEffectiveCategoryEnabled(),
          replace_underscore: this.taggerSettings.replaceUnderscore,
          escape_tag: this.taggerSettings.escapeTag,
          add_rating_tag: categoryKeys.includes('rating')
            ? categoryOptionEnabled('rating')
            : this.taggerSourceMode === 'folder' && this.taggerSettings.addRatingTag,
          add_model_tag: this.taggerSourceMode === 'folder'
            && this.taggerSupportsModelTag()
            && this.taggerSettings.addModelTag,
          remove_duplicated: this.taggerSettings.removeDuplicated,
          additional_tags: this.taggerSourceMode === 'folder' ? this.taggerSettings.additionalTags : '',
          exclude_tags: this.taggerSourceMode === 'folder' ? this.taggerSettings.excludeTags : '',
        },
      };
      const response = await fetch('/api/tagger/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Unable to start');
      this.attachTaggerTask(body.data.task_id);
    } catch (error) { this.toast(error.message, 'error'); }
    finally { this.taggerStarting = false; }
  },

  attachTaggerTask(taskId) {
    this.taggerTaskId = taskId;
    this.taggerRunning = true;
    localStorage.setItem('anima-tagger-task-id', taskId);
    this._setTaggerRealtimeTask(taskId);
  },

  async restoreTaggerTask(taskId) {
    try {
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/status`);
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Task unavailable');
      this.taggerTaskId = taskId;
      this.applyTaggerTaskSnapshot(body.data, '');
      if (this.taggerRunning) this._setTaggerRealtimeTask(taskId);
      await this.refreshTaggerItems(true);
    } catch (_) { localStorage.removeItem('anima-tagger-task-id'); }
  },

  _setTaggerRealtimeTask(taskId) {
    const next = taskId ? 'task:' + taskId : null;
    if (next === this._taggerRealtimeTopic) return;
    if (this._taggerRealtimeTopic) this.realtimeUnsubscribe(this._taggerRealtimeTopic);
    this._taggerRealtimeTopic = next;
    if (next) this.realtimeSubscribe(next);
  },

  handleRealtimeTaggerEvent(event) {
    if (!event) return;
    if (event.type === 'hardware.sample' && event.payload) return;
    if (!this._taggerRealtimeTopic || event.topic !== this._taggerRealtimeTopic) return;
    if (!['task.status', 'task.progress', 'task.result'].includes(event.type)) return;
    const envelope = event.payload || {};
    this.applyTaggerTaskSnapshot(envelope.data || {}, envelope.status || '');
  },

  applyRealtimeTaggerSnapshot(snapshot) {
    if (!this.taggerTaskId || !snapshot || !snapshot.tasks) return;
    const task = (snapshot.tasks.tracked || []).find(item => item.task_id === this.taggerTaskId);
    if (task) this.applyTaggerTaskSnapshot(task.data || {}, task.status || '');
  },

  resetRealtimeTaggerState() {
    const active = !!this.taggerRunning;
    this._setTaggerRealtimeTask(null);
    this.taggerRunning = false;
    return active;
  },

  applyTaggerTaskSnapshot(data, normalizedStatus) {
    this.taggerTask = data;
    if (data.source_token && (!this.taggerSource || this.taggerSource.source_token !== data.source_token)) {
      this.taggerSource = { source_token: data.source_token, kind: data.source_kind, total: data.total, path: data.source_root || '' };
    }
    if (data.source_root) {
      this.taggerSource.path = data.source_root;
      this.taggerSourcePath = data.source_root;
    }
    const terminal = ['FINISHED', 'FAILED', 'TERMINATED'].includes(normalizedStatus) || ['done', 'error', 'cancelled'].includes(data.status);
    this.taggerRunning = !terminal;
    if (data.current_result && data.current_result.index === this.taggerSelectedIndex) {
      this.setTaggerResult(data.current_result, false);
    }
    const now = Date.now();
    if (now - this._taggerLastItemsFetch > 800) {
      this._taggerLastItemsFetch = now;
      void this.refreshTaggerItems(false);
    }
    if (terminal) {
      this._setTaggerRealtimeTask(null);
      if (data.status === 'done') this.toast(this.t('tagger.completed'));
    }
  },

  async refreshTaggerItems(reset) {
    if (!this.taggerTaskId) return;
    try {
      const offset = reset || this.taggerFailedOnly ? 0 : Math.max(0, Number(this.taggerTask?.current || 0) - 80);
      const limit = this.taggerFailedOnly ? 500 : 160;
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(this.taggerTaskId)}/items?offset=${offset}&limit=${limit}&failed_only=${this.taggerFailedOnly}`);
      const body = await response.json();
      if (body.status !== 'success') return;
      this.taggerItemsTotal = Number(body.data.total || 0);
      this._mergeTaggerItems(body.data.items || [], reset || this.taggerFailedOnly);
      if (reset && this.taggerItems.length) this.selectTaggerItem(this.taggerItems[0]);
    } catch (_) {}
  },

  _mergeTaggerItems(items, replace) {
    if (replace) {
      this.taggerItems = items;
      return;
    }
    const merged = new Map(this.taggerItems.map(item => [item.index, item]));
    items.forEach(item => merged.set(item.index, item));
    this.taggerItems = Array.from(merged.values()).sort((left, right) => left.index - right.index);
  },

  async cancelTagger() {
    if (!this.taggerTaskId) return;
    try { await fetch(`/api/tagger/tasks/${encodeURIComponent(this.taggerTaskId)}/cancel`, { method: 'POST' }); }
    catch (_) {}
  },

  async retryFailedTagger() {
    if (!this.taggerTaskId || !this.taggerTask || !this.taggerTask.failed) return;
    try {
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(this.taggerTaskId)}/retry`, { method: 'POST' });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Retry failed');
      this.attachTaggerTask(body.data.task_id);
    } catch (error) { this.toast(error.message, 'error'); }
  },

  async copyTaggerResult() {
    if (!this.taggerResultText) return;
    try { await navigator.clipboard.writeText(this.taggerResultText); this.toast(this.t('tagger.copied')); }
    catch (_) { this.toast(this.t('common.failed'), 'error'); }
  },

  openTaggerDatasetInEditor() {
    if (this.taggerSource && this.taggerSource.kind === 'folder') this.tagEditorDir = this.taggerSource.path || this.taggerSourcePath;
    this.navigate('tagEditor');
  },

  taggerProgressPercent() {
    if (!this.taggerTask || !this.taggerTask.total) return 0;
    return Math.min(100, Math.round(Number(this.taggerTask.current || 0) * 100 / Number(this.taggerTask.total)));
  },

  taggerTaskProgressText() {
    if (!this.taggerTask) return '';
    return `${this.taggerTask.current || 0} / ${this.taggerTask.total || this.taggerSource?.total || 0}`;
  },

  formatTaggerEta(seconds) {
    if (seconds == null) return '--';
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    return minutes ? `${minutes}m ${Math.round(value % 60)}s` : `${Math.round(value)}s`;
  },

  taggerPhaseLabel() {
    const phase = this.taggerTask?.phase || (this.taggerScanning ? 'scanning' : 'ready');
    return this.t('tagger.phase.' + phase, phase.replace(/_/g, ' '));
  },

  taggerLogLines() {
    return Array.isArray(this.taggerTask?.logs) ? this.taggerTask.logs : [];
  },

  taggerLogCount() {
    return this.taggerLogLines().length;
  },

  taggerHasLogs() {
    return this.taggerLogCount() > 0;
  },

  taggerVisibleLogs() {
    const logs = this.taggerLogLines();
    return logs.slice(this.taggerLogsOpen ? -160 : -32);
  },

  taggerLogTime(line) {
    return String(line || '').match(/^\[([^\]]+)\]\s*/)?.[1] || '--:--:--';
  },

  taggerLogMessage(line) {
    return String(line || '').replace(/^\[[^\]]+\]\s*/, '');
  },

  taggerLogTone(line) {
    const value = String(line || '').toLowerCase();
    if (/failed|error|unsupported|out of memory|exception/.test(value)) return 'error';
    if (/skipped|cancelled|stopped/.test(value)) return 'warning';
    if (/completed|model ready|\(success\)|written/.test(value)) return 'success';
    if (/task started|loading model|download|preparing/.test(value)) return 'phase';
    return '';
  },

  _releaseTaggerPreview() {
    if (this._taggerPreviewObjectUrl) URL.revokeObjectURL(this._taggerPreviewObjectUrl);
    this._taggerPreviewObjectUrl = null;
  },
};
