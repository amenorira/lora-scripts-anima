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
  taggerTaskId: null,
  _taggerTasks: {},
  get taggerTask() { return this.taggerTaskById(this.taggerTaskId); },
  get taggerRunning() { return this.taggerTaskActive(this.taggerTaskId); },
  taggerItems: [],
  taggerItemsTotal: 0,
  taggerSelectedIndex: 0,
  taggerResultText: '',
  taggerResultCategories: {},
  taggerCategoryState: {},
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
  taggerSettings: {
    preset: 'balanced',
    conflict: 'ignore',
    threshold: 0.35,
    characterThreshold: 0.6,
    recursive: true,
    replaceUnderscore: true,
    escapeTag: false,
    addRatingTag: false,
    addModelTag: false,
    unloadModel: false,
    precision: 'auto',
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
  _taggerRouteInitialized: false,
  _taggerFormVersion: 0,
  _taggerMountPromise: null,
  _taggerModeStates: { folder: null, single: null, 'api-folder': null, 'api-single': null },

  async buildTaggerForm() {
    const route = this.currentRoute;
    const version = ++this._taggerFormVersion;
    const isCurrent = () => this.currentRoute === route && version === this._taggerFormVersion;
    await this._mountTaggerWorkspace();
    if (!isCurrent()) return;
    this.tagDictionaryInit();
    this._loadTaggerSettings();
    this.loadCaptionOptions();
    const ai = this.currentRoute === 'ai-captioning';
    const allowed = ai ? ['api-folder', 'api-single'] : ['folder', 'single'];
    if (ai) this.captionTab = localStorage.getItem('anima-ai-tab') || 'batch';
    const savedMode = ai ? (this.captionTab === 'single' ? 'api-single' : 'api-folder') : localStorage.getItem('anima-tagger-mode');
    if (!allowed.includes(this.taggerSourceMode) || (!this._taggerRouteInitialized && allowed.includes(savedMode) && savedMode !== this.taggerSourceMode)) {
      this._taggerModeStates[this.taggerSourceMode] = this._captureTaggerModeState();
      this.taggerSourceMode = allowed.includes(savedMode) ? savedMode : allowed[0];
      this._restoreTaggerModeState(this._taggerModeStates[this.taggerSourceMode]);
      this._taggerModeStates[this.taggerSourceMode] = null;
    }
    this._taggerRouteInitialized = true;
    this.realtimeSubscribe('hardware');
    this.renderTaggerResourceBar();
    if (!ai) await this.loadTaggerModels();
    if (ai) await this.loadCaptionTemplate();
    if (!isCurrent()) return;
    const stored = localStorage.getItem(ai ? 'anima-ai-tagger-task-id' : this._taggerTaskStorageKey());
    let taskId = '';
    try {
      const response = await fetch('/api/tagger/tasks/active');
      const body = await response.json();
      taskId = body.status === 'success' && body.data ? body.data.task_id || '' : '';
    } catch (_) {}
    if (!isCurrent()) return;
    taskId = taskId || stored || '';
    if (taskId) {
      const restored = await this.restoreTaggerTask(taskId);
      if (!isCurrent()) return;
      if (!restored && stored && stored !== taskId) await this.restoreTaggerTask(stored);
    }
    if (!isCurrent()) return;
    if (ai && this.taggerSourceMode === 'api-folder' && !this.taggerSourcePath) {
      this.taggerSourcePath = localStorage.getItem('anima-ai-source-path') || '';
      if (this.taggerSourcePath) await this.scanTaggerSource({quiet: true});
    }
    if (!isCurrent()) return;
    if (ai) await this.initCaptionWorkspace?.(isCurrent);
    if (!isCurrent()) return;
    this.syncTaggerDictionary();
  },

  renderTaggerResourceBar() {
    if (typeof this._renderResourceBar !== 'function') return;
    const translate = (key, fallback) => this.t('monitor.' + key, fallback) || fallback || key;
    this._renderResourceBar('taggerResbar', this.gpuInfo, this.sysInfo, translate, this.locale);
  },

  async _mountTaggerWorkspace() {
    const host = document.getElementById('taggerWorkspaceHost');
    if (!host || host.dataset.mounted === '1') return;
    if (this._taggerMountPromise) return this._taggerMountPromise;
    // Both routes share this host; navigation must join its pending mount.
    this._taggerMountPromise = (async () => {
      try {
        const response = await fetch('/anima-ui/tagger-workspace.html?v=20261021-caption-workspaces6');
        if (!response.ok) throw new Error('Workspace template unavailable');
        host.innerHTML = await response.text();
        const captionTemplate = await fetch('/anima-ui/caption-workspace.html?v=20261021-caption-design3');
        if (!captionTemplate.ok) throw new Error('Caption workspace unavailable');
        host.querySelector('#captionWorkspaceMount').outerHTML = await captionTemplate.text();
        host.dataset.mounted = '1';
        if (window.Alpine) Alpine.initTree(host);
      } catch (error) {
        host.textContent = error.message;
      }
    })();
    try {
      await this._taggerMountPromise;
    } finally {
      this._taggerMountPromise = null;
    }
  },

  stopTaggerWorkspace() {
    ++this._taggerFormVersion;
    this.stopCaptionWorkspace?.();
    this.tagDictionaryCleanup();
    this.realtimeUnsubscribe('hardware');
    this.stopTaggerSingleResize();
    // Source states retain their upload URLs until replaced or cleared.
    clearTimeout(this._taggerSourceScanTimer);
    this._taggerSourceScanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    this.taggerScanning = false;
  },

  _loadTaggerSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('anima-tagger-settings') || '{}');
      delete saved.categoryEnabled;
      this.taggerSettings = Object.assign({}, this.taggerSettings, saved);
      if (!['auto', 'bf16', 'fp32'].includes(this.taggerSettings.precision)) this.taggerSettings.precision = 'auto';
    } catch (_) {}
  },

  saveTaggerSettings() {
    localStorage.setItem('anima-tagger-settings', JSON.stringify(this.taggerSettings));
  },

  taggerModeIsApi() {
    return String(this.taggerSourceMode).startsWith('api-');
  },

  _taggerTaskStorageKey(mode = this.taggerSourceMode) {
    if (mode === 'api-single') return null;
    return mode === 'api-folder' ? 'anima-ai-tagger-task-id' : 'anima-tagger-task-id';
  },

  taggerTaskById(id) { return id ? this._taggerTasks[id] || null : null; },
  taggerTaskActive(id) { return ['created','running','cancelling'].includes(this.taggerTaskById(id)?.status); },
  taggerHasActiveTask() { return Object.keys(this._taggerTasks).some(id => this.taggerTaskActive(id)); },

  _pruneTaggerTasks() {
    const retained = new Set([this.taggerTaskId, ...Object.values(this._taggerModeStates).map(state => state?.taskId)]);
    for (const id of Object.keys(this._taggerTasks)) if (!retained.has(id)) delete this._taggerTasks[id];
  },

  _clearTaggerTask(mode = this.taggerSourceMode) {
    const state = mode === this.taggerSourceMode ? null : this._taggerModeStates[mode];
    const id = mode === this.taggerSourceMode ? this.taggerTaskId : state?.taskId;
    if (mode === this.taggerSourceMode) this.taggerTaskId = null;
    else if (state) state.taskId = null;
    const key = this._taggerTaskStorageKey(mode);
    if (key && id && localStorage.getItem(key) === id) localStorage.removeItem(key);
    if (this._taggerRealtimeTopic === 'task:' + id) this._setTaggerRealtimeTask(null);
    this._pruneTaggerTasks();
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
        this.taggerSelectedModel = this.taggerModels.find(model => model.id === body.data.default_model_id)?.id
          || this.taggerModels[0]?.id || '';
      }
      this.handleTaggerModelChange(false);
    } catch (error) {
      this.toast(this.t('tagger.modelLoadFailed') + ': ' + error.message, 'error');
    }
  },

  taggerModel() {
    return this.taggerModels.find(model => model.id === this.taggerSelectedModel) || null;
  },

  taggerRuntimeLabel() {
    return { onnx: 'ONNX Runtime', pytorch: 'PyTorch' }[this.taggerModel()?.engine] || '';
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

  taggerPrecisionSelectConfig() {
    return { options: ['auto', 'bf16', 'fp32'].map(value => ({
      v: value, l: this.t(`tagger.precision_${value}`),
      d: this.t(`tagger.precision_${value}Desc`),
    })) };
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
      'pixai-tagger-v1.0': 'modelPurposePixai',
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
    const stored = this.taggerSettings.categoryEnabledByModel?.[this.taggerSelectedModel]?.[key];
    return key === 'model' ? stored === true : stored !== false;
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

  taggerCategoryLabel(key, fallback = key) {
    const suffix = key.charAt(0).toUpperCase() + key.slice(1);
    return this.t('tagger.cat' + suffix, fallback);
  },

  // Configuration and results share category rows, without fabricating inference data.
  taggerSingleCategories() {
    const keys = this.taggerUsesCategoryThresholds() ? [...this.taggerCategoryKeys()] : ['general', 'character'];
    if (this.taggerSupportsModelTag() && !keys.includes('model')) keys.push('model');
    return [...new Set([...keys, ...Object.keys(this.taggerCategoryState)])].map(key => ({
      key, label: this.taggerCategoryLabel(key), result: this.taggerCategoryState[key],
    }));
  },

  taggerSingleCategoryEnabled(key) {
    if (this.taggerUsesCategoryThresholds()) return this.taggerCategoryEnabled(key);
    if (key === 'character') return this.taggerCharacterEnabled();
    return this.taggerCategoryState[key]?.visible !== false;
  },

  setTaggerSingleCategoryEnabled(key, enabled) {
    if (this.taggerUsesCategoryThresholds()) this.setTaggerCategoryEnabled(key, enabled);
    else if (key === 'character') this.setTaggerCharacterEnabled(enabled);
    else if (this.taggerCategoryState[key]) {
      this.taggerCategoryState[key].visible = enabled;
      this.recalculateTaggerCategory(key);
    }
  },

  taggerSingleCategoryThreshold(key) {
    return this.taggerUsesCategoryThresholds() ? this.taggerSettings.categoryThresholds[key] ?? 0.35
      : key === 'character' ? this.taggerSettings.characterThreshold : this.taggerSettings.threshold;
  },

  setTaggerSingleCategoryThreshold(key, value) {
    const threshold = Number(Math.max(0, Math.min(1, Number(value) || 0)).toFixed(3));
    if (this.taggerUsesCategoryThresholds()) {
      this.taggerSettings.categoryThresholds[key] = threshold;
      this.updateTaggerCategorySetting(key);
    } else {
      this.taggerSettings[key === 'character' ? 'characterThreshold' : 'threshold'] = threshold;
      this.setTaggerCustomPreset();
    }
  },

  handleTaggerModelChange(resetPreset = true) {
    localStorage.setItem('anima-tagger-model', this.taggerSelectedModel || '');
    if (resetPreset) {
      this._clearTaggerResultState(true);
      ['folder','single'].forEach(mode => this._clearStoredTaggerResult(this._taggerModeStates[mode]));
      localStorage.removeItem('anima-tagger-task-id');
      this._pruneTaggerTasks();
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
      && !this.taggerHasActiveTask() && !this.taggerStarting && !this.captionPreviewBusy && !this.trainingActive && !this.regularizationActive);
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
      const presets = this.taggerModel()?.threshold_presets || {};
      if (preset !== 'custom' && presets[preset]) {
        this.taggerSettings.categoryThresholds = Object.assign({}, presets[preset]);
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

  async selectTaggerSourceMode(mode, {allowActive = false} = {}) {
    if ((!allowActive && this.taggerRunning) || this.taggerStarting || this.taggerScanning
      || !['folder', 'single', 'api-folder', 'api-single'].includes(mode) || mode === this.taggerSourceMode) return;
    this._taggerSourceScanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    clearTimeout(this._taggerSourceScanTimer);
    this.stopTaggerSingleResize();
    this._taggerModeStates[this.taggerSourceMode] = this._captureTaggerModeState();
    this.taggerSourceMode = mode;
    if (this.currentRoute !== 'ai-captioning') localStorage.setItem('anima-tagger-mode', mode);
    const stored = this._taggerModeStates[mode];
    this._taggerModeStates[mode] = null;
    this._restoreTaggerModeState(stored);
    this.resetTaggerPreview();
    // 布局重建触发入场动画（m-tab-enter），期间隐藏页面滚动条 thumb 避免位移撑大滚动区导致闪现
    const scroller = document.querySelector('.main-content');
    if (scroller) {
      scroller.classList.add('scroll-entering');
      clearTimeout(this._scrollEnteringTimer);
      this._scrollEnteringTimer = setTimeout(() => scroller.classList.remove('scroll-entering'), 520);
    }
  },

  // 模式 tab 滑动指示条：与监控台 tab 共用 .monitor-tab-indicator 样式
  _syncTaggerTabIndicator(selector = '.tagger-mode-tabs') {
    const bar = document.querySelector(selector);
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
    this.taggerItems = state?.items || [];
    this.taggerItemsTotal = Number(state?.itemsTotal || 0);
    this.taggerSelectedIndex = Number(state?.selectedIndex || 0);
    this.taggerResultText = state?.resultText || '';
    this.taggerResultCategories = state?.resultCategories || {};
    this.taggerCategoryState = state?.categoryState || {};
    this._taggerLoadedResultKey = state?.loadedResultKey || '';
    this._taggerPreviewObjectUrl = state?.previewObjectUrl || null;
    this.syncTaggerDictionary();
    this.taggerFailedOnly = !!state?.failedOnly;
    this.taggerLogsOpen = !!state?.logsOpen;
  },

  clearTaggerSource() {
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    this.stopTaggerSingleResize();
    this._clearTaggerTask();
    this._taggerModeStates[this.taggerSourceMode] = null;
    this._releaseTaggerPreview();
    this._restoreTaggerModeState(null);
    this.resetTaggerPreview();
    this.captionSourceChanged?.(this.taggerSourceMode);
  },

  _clearStoredTaggerResult(state) {
    if (!state) return;
    state.taskId = null;
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
    this.tagDictionaryCloseHover?.();
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    this._taggerLoadedResultKey = '';
    if (!clearTask) return;
    this._clearTaggerTask();
    this.taggerItems = this.taggerItems.map(item => {
      const next = Object.assign({}, item, { status: 'pending' });
      delete next.result;
      delete next.tag_count;
      delete next.error;
      return next;
    });
  },

  async pickTaggerSource() {
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    try {
      const picker = this.taggerSourceMode.endsWith('single') ? 'image-file' : 'folder';
      const response = await fetch('/api/pick_file?picker_type=' + picker);
      const body = await response.json();
      if (body.status === 'success' && body.data && body.data.path) {
        this.taggerSourcePath = body.data.path;
        await this.scanTaggerSource();
      }
    } catch (_) { this.toast(this.t('common.localPickerNA')); }
  },

  scheduleTaggerSourceScan() {
    if (this.taggerRunning || this.taggerStarting || this.captionPreviewBusy) return;
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
      if (this.taggerSourceMode === 'api-folder') {
        this._clearTaggerResultState(true);
        this.captionSourceChanged?.(this.taggerSourceMode);
      }
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

  async handleTaggerPaste(event) {
    if (event.defaultPrevented || !['tagger', 'ai-captioning'].includes(this.currentRoute) || !this.taggerSourceMode.endsWith('single')) return;
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    const target = event.target;
    if (target?.isContentEditable || target?.closest?.('input, textarea, select')) return;

    const clipboard = event.clipboardData;
    let file = Array.from(clipboard?.files || []).find(file => file.type.startsWith('image/'));
    if (!file) {
      for (const item of Array.from(clipboard?.items || [])) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        file = item.getAsFile();
        if (file) break;
      }
    }
    if (!file) return;
    event.preventDefault();
    await this.uploadTaggerFile(file);
  },

  async handleTaggerDrop(event) {
    this.taggerDragOver = false;
    if (!this.taggerSourceMode.endsWith('single')) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) await this.uploadTaggerFile(file);
  },

  async uploadTaggerFile(file) {
    if (!file || !file.type.startsWith('image/') || this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    const mode = this.taggerSourceMode, route = this.currentRoute;
    const version = this._taggerSourceScanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    this.taggerScanning = true;
    const previewUrl = URL.createObjectURL(file);
    let installed = false;
    try {
      const data = new FormData();
      data.append('file', file, file.name);
      const response = await fetch('/api/tagger/uploads', { method: 'POST', body: data });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Upload failed');
      if (version !== this._taggerSourceScanVersion || mode !== this.taggerSourceMode || route !== this.currentRoute) return;
      body.data.display_name = file.name || this.t('tagger.singleImage');
      this._releaseTaggerPreview();
      this._taggerPreviewObjectUrl = previewUrl;
      installed = true;
      this.setTaggerSource(body.data);
    } catch (error) {
      if (version === this._taggerSourceScanVersion && route === this.currentRoute) this.toast(error.message, 'error');
    } finally {
      if (!installed) URL.revokeObjectURL(previewUrl);
      if (version === this._taggerSourceScanVersion) this.taggerScanning = false;
    }
  },

  async scanTaggerSource(options = {}) {
    if (this._taggerSourceScanTimer) clearTimeout(this._taggerSourceScanTimer);
    this._taggerSourceScanTimer = null;
    const path = this.taggerSourcePath.trim();
    if (!path) return;
    const mode = this.taggerSourceMode;
    const route = this.currentRoute;
    const scanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    this._taggerSourceScanVersion = scanVersion;
    this.taggerScanning = true;
    try {
      const recursive = this.taggerModeIsApi() ? this.captionOptions.recursive !== false : this.taggerSettings.recursive;
      const response = await fetch('/api/tagger/source/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, recursive, caption_extension: this.taggerModeIsApi() ? this.captionOptions.caption_extension : '.txt', caption_options: this.taggerModeIsApi() ? this.captionOptions : undefined }),
      });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Scan failed');
      if (mode.endsWith('single') && !['file','upload'].includes(body.data.kind)) throw new Error(this.t('caption.singleFileRequired'));
      if (mode === 'api-folder' && body.data.kind !== 'folder') throw new Error(this.t('caption.selectDirectory'));
      if (scanVersion !== this._taggerSourceScanVersion || path !== this.taggerSourcePath.trim() || mode !== this.taggerSourceMode || route !== this.currentRoute) return;
      this.setTaggerSource(body.data);
    } catch (error) {
      if (scanVersion === this._taggerSourceScanVersion && !options.quiet) this.toast(error.message, 'error');
    } finally {
      if (scanVersion === this._taggerSourceScanVersion) this.taggerScanning = false;
    }
  },

  setTaggerSource(source) {
    if (!this.taggerRunning) {
      this._clearTaggerTask();
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
    this.captionSourceChanged?.(this.taggerSourceMode);
  },

  taggerPreviewUrl(index) {
    if (this.taggerSourceMode.endsWith('single') && this._taggerPreviewObjectUrl && index === 0) return this._taggerPreviewObjectUrl;
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
        const defaultThreshold = key === 'character' ? this.taggerSettings.characterThreshold : this.taggerSettings.threshold;
        state[key] = {
          label: this.taggerCategoryLabel(key, category.label || labels[key] || key),
          tags: rawTags,
          threshold: Number((this.taggerUsesCategoryThresholds() ? this.taggerSettings.categoryThresholds[key] : defaultThreshold) ?? 0.5),
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
    // 固定分类顺序：特征在前、模型等辅助分类在后，避免后端原始顺序把噪声分类顶到最前
    const ordered = {};
    ['general', 'character', 'copyright', 'style', 'artist', 'meta', 'quality', 'rating'].forEach(key => {
      if (state[key]) ordered[key] = state[key];
    });
    Object.keys(state).forEach(key => {
      if (!ordered[key]) ordered[key] = state[key];
    });
    this.taggerCategoryState = ordered;
    if (Object.keys(state).length) {
      this.recalculateAllTaggerCategories(true);
    }
  },

  recalculateTaggerCategory(key, updateResult = true) {
    const category = this.taggerCategoryState[key];
    if (!category) return;
    const threshold = Math.max(0, Math.min(1, Number(category.threshold) || 0));
    category.threshold = threshold;
    category.visibleTags = category.tags.filter(tag => Number(tag[1]) >= threshold);
    if (updateResult) this.refreshTaggerResultFromCategories();
  },

  recalculateAllTaggerCategories(updateResult = true) {
    Object.keys(this.taggerCategoryState).forEach(key => this.recalculateTaggerCategory(key, false));
    if (updateResult) this.refreshTaggerResultFromCategories();
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
    this.syncTaggerDictionary();
  },

  setTaggerCategoriesCollapsed(collapsed, container) {
    const changed = new Set();
    Object.entries(this.taggerCategoryState).forEach(([key, category]) => {
      const next = collapsed || !category.visibleTags.length;
      if (category.collapsed === next) return;
      category.collapsed = next;
      changed.add(key);
    });
    container?.querySelectorAll('.tagger-category-section').forEach(section => {
      const key = section.dataset.category;
      if (changed.has(key)) {
        this._animateCollapse(section.querySelector('.tagger-category-body'), this.taggerCategoryState[key].collapsed);
      }
    });
    this.syncTaggerDictionary();
  },

  taggerCategoryPreview(category) {
    return category.visibleTags.slice(0, 200);
  },

  syncTaggerDictionary() {
    if (typeof this.tagDictionaryLookupTags !== 'function') return;
    const tags = Object.values(this.taggerCategoryState)
        .filter(category => !category.collapsed)
        .flatMap(category => this.taggerCategoryPreview(category).map(tag => tag[0]));
    this.tagDictionaryLookupTags(tags);
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
          precision: this.taggerSettings.precision,
          threshold: Number(this.taggerSettings.threshold),
          character_threshold: Number(this.taggerSettings.characterThreshold),
          category_thresholds: this.taggerEffectiveCategoryThresholds(),
          category_enabled: this.taggerEffectiveCategoryEnabled(),
          replace_underscore: this.taggerSettings.replaceUnderscore,
          escape_tag: this.taggerSettings.escapeTag,
          add_rating_tag: categoryKeys.includes('rating')
            ? categoryOptionEnabled('rating')
            : this.taggerSourceMode === 'folder' && this.taggerSettings.addRatingTag,
          add_model_tag: this.taggerSupportsModelTag() && (
            this.taggerSourceMode === 'folder'
              ? this.taggerSettings.addModelTag
              : this.taggerCategoryEnabled('model')
          ),
          unload_model_after: this.taggerSettings.unloadModel === true,
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

  attachTaggerTask(taskId, mode = this.taggerSourceMode) {
    if (mode === this.taggerSourceMode) this.taggerTaskId = taskId;
    else (this._taggerModeStates[mode] ||= {}).taskId = taskId;
    this._taggerTasks[taskId] = {status:'created',engine:mode.startsWith('api-') ? 'api' : this.taggerModel()?.engine,
      _mode:mode};
    localStorage.setItem(this._taggerTaskStorageKey(mode), taskId);
    this._pruneTaggerTasks();
    this._setTaggerRealtimeTask(taskId);
  },

  async restoreTaggerTask(taskId) {
    const route = this.currentRoute;
    try {
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/status`);
      const body = await response.json();
      if (this.currentRoute !== route) return false;
      if (body.status !== 'success') {
        const key = route === 'ai-captioning' ? 'anima-ai-tagger-task-id' : 'anima-tagger-task-id';
        if (localStorage.getItem(key) === taskId) localStorage.removeItem(key);
        return false;
      }
      if ((body.data.engine === 'api') !== (this.currentRoute === 'ai-captioning')) return false;
      this.applyTaggerTaskSnapshot(body.data, '', taskId);
      const mode = this.taggerTaskById(taskId)._mode;
      localStorage.setItem(this._taggerTaskStorageKey(mode), taskId);
      if (body.data.engine === 'api' && this.taggerTaskActive(taskId)) {
        if (body.data.caption_options) {
          const {dry_run, ...settings} = body.data.caption_options;
          this.captionOptions = Object.assign({}, this.captionOptions, settings);
        }
      }
      if (this.taggerTaskActive(taskId)) this._setTaggerRealtimeTask(taskId);
      if (body.data.engine !== 'api' && mode === this.taggerSourceMode) await this.refreshTaggerItems(true);
      return true;
    } catch (_) { return false; }
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
    this.applyTaggerTaskSnapshot(envelope.data || {}, envelope.status || '', envelope.task_id || event.topic.slice(5));
  },

  applyRealtimeTaggerSnapshot(snapshot) {
    const ids = new Set([this.taggerTaskId, ...Object.values(this._taggerModeStates).map(state => state?.taskId)]);
    for (const task of snapshot?.tasks?.tracked || []) {
      if (ids.has(task.task_id)) this.applyTaggerTaskSnapshot(task.data || {}, task.status || '', task.task_id);
    }
  },

  resetRealtimeTaggerState() {
    const active = this.taggerHasActiveTask();
    this._setTaggerRealtimeTask(null);
    this._taggerTasks = {};
    this.taggerTaskId = null;
    this.taggerSource = null;
    this.taggerItems = [];
    this.taggerItemsTotal = 0;
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    for (const state of Object.values(this._taggerModeStates)) {
      if (!state) continue;
      this._clearStoredTaggerResult(state);
      state.source = null;
      state.items = [];
      state.itemsTotal = 0;
    }
    localStorage.removeItem('anima-ai-tagger-task-id');
    localStorage.removeItem('anima-tagger-task-id');
    this.captionExternalTaggerBusy = false;
    this.captionSourceChanged?.('api-folder');
    return active;
  },

  applyTaggerTaskSnapshot(data, normalizedStatus, taskId = this.taggerTaskId) {
    if (!taskId) return;
    const previous = this.taggerTaskById(taskId);
    // The registry's initial CREATED frame contains no snapshot. It cannot
    // replace a snapshot already restored by HTTP or a reconnect bootstrap.
    if (!Object.keys(data).length && previous?.status && previous.status !== 'created') return;
    const status = data.status || {CREATED:'created',RUNNING:'running',FINISHED:'done',FAILED:'error',TERMINATED:'cancelled'}[normalizedStatus] || previous?.status;
    data = {...previous,...data,status};
    const mode = data.engine === 'api' ? 'api-folder' : data.source_kind ? (data.source_kind === 'folder' ? 'folder' : 'single') : previous?._mode || this.taggerSourceMode;
    data._mode = mode;
    this._taggerTasks[taskId] = data;
    const current = mode === this.taggerSourceMode;
    const state = current ? null : (this._taggerModeStates[mode] ||= {});
    if (current) this.taggerTaskId = taskId;
    else state.taskId = taskId;
    let source = current ? this.taggerSource : state.source;
    const sourceToken = data.engine === 'api' ? data.overview_source_token || data.source_token : data.source_token;
    if (sourceToken && (!source || source.source_token !== sourceToken)) {
      source = {source_token:sourceToken,kind:data.source_kind,total:data.total,path:data.source_root || ''};
    }
    if (source && data.source_root) source.path = data.source_root;
    if (current) {
      this.taggerSource = source || null;
      if (data.source_root) this.taggerSourcePath = data.source_root;
    } else {
      state.source = source;
      if (data.source_root) state.sourcePath = data.source_root;
    }
    const terminal = ['done','error','cancelled'].includes(status);
    if (current && data.engine !== 'api' && data.current_result && data.current_result.index === this.taggerSelectedIndex) {
      this.setTaggerResult(data.current_result, false);
    }
    const now = Date.now();
    // Completion must fetch results even when a recent progress event was throttled.
    // Large candidate lists are deliberately omitted from realtime frames.
    if (current && data.engine !== 'api' && (terminal || now - this._taggerLastItemsFetch > 800)) {
      this._taggerLastItemsFetch = now;
      void this.refreshTaggerItems(false);
    }
    if (terminal) {
      if (this._taggerRealtimeTopic === 'task:' + taskId) this._setTaggerRealtimeTask(null);
      if (status === 'done' && previous?.status !== status) this.toast(this.t('tagger.completed'));
    }
    if (data.engine === 'api') this.captionTaskUpdated?.(data, previous, terminal);
    this._pruneTaggerTasks();
  },

  async refreshTaggerItems(reset) {
    if (!this.taggerTaskId) return;
    const taskId = this.taggerTaskId;
    const sourceMode = this.taggerSourceMode;
    const request = this._taggerItemsRequest = (this._taggerItemsRequest || 0) + 1;
    try {
      const offset = reset || this.taggerFailedOnly ? 0 : Math.max(0, Number(this.taggerTask?.current || 0) - 80);
      const limit = this.taggerFailedOnly ? 500 : 160;
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/items?offset=${offset}&limit=${limit}&failed_only=${this.taggerFailedOnly}`);
      const body = await response.json();
      if (taskId !== this.taggerTaskId || sourceMode !== this.taggerSourceMode || request !== this._taggerItemsRequest) return;
      if (body.status !== 'success') return;
      this.taggerItemsTotal = Number(body.data.total || 0);
      this._mergeTaggerItems(body.data.items || [], reset || this.taggerFailedOnly);
      if (reset && this.taggerItems.length) this.selectTaggerItem(this.taggerItems[0]);
      else {
        const selected = this.taggerItems.find(item => item.index === this.taggerSelectedIndex);
        if (selected?.result) this.setTaggerResult(selected.result);
      }
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
    const taskId = this.taggerTaskId, mode = this.taggerSourceMode;
    try {
      const response = await fetch(`/api/tagger/tasks/${encodeURIComponent(taskId)}/retry`, { method: 'POST' });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Retry failed');
      this.attachTaggerTask(body.data.task_id, mode);
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

  taggerVisibleLogs() {
    const logs = Array.isArray(this.taggerTask?.logs) ? this.taggerTask.logs : [];
    return logs.slice(this.taggerLogsOpen ? 0 : -32).map(line => typeof line === 'string' ? {
      time: line.match(/^\[([^\]]+)\]\s*/)?.[1] || '--:--:--', level: 'info',
      message: line.replace(/^\[[^\]]+\]\s*/, ''),
    } : line);
  },

  taggerLogMessage(line) {
    if (this.taggerTask?.engine === 'api' && ['done','cancelled'].includes(line.event)) {
      return this.t('caption.taskSummary').replace(/\{(\w+)\}/g,(_,key) => line[key] ?? '');
    }
    return line.message ?? this.t('tagger.log.' + line.event, line.event)
      .replace(/\{(\w+)\}/g, (_, key) => line[key] ?? '');
  },

  _releaseTaggerPreview() {
    if (this._taggerPreviewObjectUrl) URL.revokeObjectURL(this._taggerPreviewObjectUrl);
    this._taggerPreviewObjectUrl = null;
  },
};
