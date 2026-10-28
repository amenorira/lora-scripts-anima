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
    if (!window.resourceBar) return;
    const translate = (key, fallback) => this.t('monitor.' + key, fallback) || fallback || key;
    window.resourceBar.render('taggerResbar', {
      gpu: this.gpuInfo, sys: this.sysInfo, t: translate, locale: this.locale,
      selectedGpuIndex: this.selectedGpuIndex,
      onSelect: index => { this.selectedGpuIndex = index; this.renderTaggerResourceBar(); },
    });
  },

  async _mountTaggerWorkspace() {
    const host = document.getElementById('taggerWorkspaceHost');
    if (!host || host.dataset.mounted === '1') return;
    if (this._taggerMountPromise) return this._taggerMountPromise;
    // Both routes share this host; navigation must join its pending mount.
    this._taggerMountPromise = (async () => {
      try {
        const response = await fetch('/anima-ui/tagger-workspace.html');
        if (!response.ok) throw new Error('Workspace template unavailable');
        host.innerHTML = await response.text();
        const captionTemplate = await fetch('/anima-ui/caption-workspace.html');
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


  async copyTaggerResult() {
    if (!this.taggerResultText) return;
    try { await navigator.clipboard.writeText(this.taggerResultText); this.toast(this.t('tagger.copied')); }
    catch (_) { this.toast(this.t('common.failed'), 'error'); }
  },

  openTaggerDatasetInEditor() {
    if (this.taggerSource && this.taggerSource.kind === 'folder') this.tagEditorDir = this.taggerSource.path || this.taggerSourcePath;
    this.navigate('tagEditor');
  },


};

window.composeAppMixins(window.taggerMixin, { taggerSourcesMixin: window.taggerSourcesMixin });

window.composeAppMixins(window.taggerMixin, { taggerTasksMixin: window.taggerTasksMixin });
