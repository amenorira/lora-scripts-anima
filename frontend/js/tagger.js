/* Tagger desktop workspace. State is kept in Alpine; large media stays in browser/server caches. */
window.taggerMixin = {
  taggerModels: [],
  taggerHardware: {},
  taggerPromptPresets: [],
  taggerDefaultPromptPreset: 'enhanced',
  taggerRuntime: null,
  taggerRuntimeBusy: false,
  taggerSelectedModel: '',
  taggerSourceMode: 'folder',
  taggerSourcePath: '',
  taggerSource: null,
  taggerScanning: false,
  taggerStarting: false,
  taggerRunning: false,
  taggerInstalling: false,
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
  taggerAdvancedOpen: false,
  taggerThresholdsOpen: false,
  taggerPreviewActual: false,
  taggerPreviewLight: false,
  taggerDragOver: false,
  taggerSettings: {
    preset: 'balanced',
    conflict: 'ignore',
    threshold: 0.35,
    characterThreshold: 0.6,
    maxTags: 80,
    prompt: '',
    promptBasePreset: 'enhanced',
    lowVram: false,
    recursive: true,
    replaceUnderscore: true,
    escapeTag: true,
    addRatingTag: false,
    addModelTag: false,
    removeDuplicated: false,
    categoryThresholds: {},
    categoryEnabled: {},
    additionalTags: '',
    excludeTags: '',
  },
  _taggerRealtimeTopic: null,
  _taggerPendingStart: false,
  _taggerLastItemsFetch: 0,
  _taggerPreviewObjectUrl: null,
  _taggerLoadedResultKey: '',

  TAGGER_CAMIE_CATEGORIES: ['general', 'character', 'copyright', 'artist', 'meta', 'year', 'rating'],
  TAGGER_CL_CATEGORIES: ['general', 'character', 'copyright', 'artist', 'meta', 'quality', 'rating'],
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
      const response = await fetch('/anima-ui/tagger-workspace.html?v=20260728-tagger12');
      if (!response.ok) throw new Error('Workspace template unavailable');
      host.innerHTML = await response.text();
      host.dataset.mounted = '1';
      if (window.Alpine) Alpine.initTree(host);
    } catch (error) {
      host.textContent = error.message;
    }
  },

  stopTaggerWorkspace() {
    this.realtimeUnsubscribe('hardware');
    this._setTaggerRealtimeTask(null);
    this._releaseTaggerPreview();
  },

  _loadTaggerSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('anima-tagger-settings') || '{}');
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
      this.taggerPromptPresets = body.data.prompt_presets || [];
      this.taggerDefaultPromptPreset = body.data.default_prompt_preset || 'enhanced';
      const legacyModels = {
        'qwen3-vl-4b-q4': 'qwen3.5-4b-ud-q4',
        'qwen3-vl-8b-q4': 'qwen3.5-9b-ud-q4',
      };
      const savedModel = legacyModels[localStorage.getItem('anima-tagger-model')] || localStorage.getItem('anima-tagger-model') || '';
      if (!this.taggerSelectedModel && this.taggerModels.some(model => model.id === savedModel)) {
        this.taggerSelectedModel = savedModel;
      }
      if (!this.taggerModels.some(model => model.id === this.taggerSelectedModel)) {
        this.taggerSelectedModel = this.taggerModels[0] ? this.taggerModels[0].id : '';
      }
      this.handleTaggerModelChange(false);
      if (this.taggerIsLlm()) void this.refreshTaggerRuntime(true);
    } catch (error) {
      this.toast(this.t('tagger.modelLoadFailed', 'Unable to load Tagger models') + ': ' + error.message, 'error');
    }
  },

  taggerModel() {
    return this.taggerModels.find(model => model.id === this.taggerSelectedModel) || null;
  },

  taggerModelSelectConfig() {
    const separator = this.t('tagger.factSeparator', '; ');
    const groups = [
      ['tagger', this.t('tagger.dedicatedModels', 'Dedicated Taggers')],
      ['vision_llm', this.t('tagger.visionLlmModels', 'Vision LLM')],
    ];
    return {
      groups: groups.map(([family, label]) => ({
        label,
        options: this.taggerModels.filter(model => model.family === family).map(model => {
          const facts = model.engine === 'llama' ? [
            this.t('tagger.modelVramFact').replace('{vram}', String(model.min_vram_gb || 0)),
            this.t('tagger.modelDownloadFact').replace('{size}', this.formatTaggerBytes(model.download_bytes)),
          ] : [];
          return {
            v: model.id,
            l: model.name,
            d: [this.taggerModelPurpose(model.id), ...facts].filter(Boolean).join(separator),
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
    if (this.taggerIsLlm()) {
      const key = { danbooru: 'promptDanbooruDesc', enhanced: 'promptEnhancedDesc', custom: 'promptCustomDesc' }[preset];
      return key ? this.t(`tagger.${key}`) : '';
    }
    if (preset === 'custom') return this.t('tagger.presetCustomDesc');
    if (this.taggerUsesCategoryThresholds()) return this.t(`tagger.preset${suffix}Desc`);
    return this.t(`tagger.presetOnnx${suffix}Desc`);
  },

  taggerVramSummary() {
    const model = this.taggerModel();
    if (!model) return '';
    return this.t('tagger.vramSummary')
      .replace('{vram}', String(model.min_vram_gb || 0))
      .replace('{size}', this.formatTaggerBytes(model.download_bytes));
  },

  taggerModelPurpose(modelId) {
    const key = {
      'camie-tagger-v2': 'modelPurposeCamie',
      'wd-eva02-large-tagger-v3': 'modelPurposeEva',
      'wd-vit-large-tagger-v3': 'modelPurposeVit',
      'cl_tagger_1_02': 'modelPurposeCl',
      'qwen3.5-4b-ud-q4': 'modelPurposeQwen35_4b',
      'qwen3.5-9b-ud-q4': 'modelPurposeQwen35_9b',
    }[modelId];
    return key ? this.t(`tagger.${key}`) : '';
  },

  taggerIsLlm() {
    const model = this.taggerModel();
    return !!model && model.engine === 'llama';
  },

  taggerUsesCategoryThresholds() {
    return ['camie-tagger-v2', 'cl_tagger_1_02'].includes(this.taggerSelectedModel);
  },

  taggerCategoryKeys() {
    if (this.taggerSelectedModel === 'camie-tagger-v2') return this.TAGGER_CAMIE_CATEGORIES;
    if (this.taggerSelectedModel === 'cl_tagger_1_02') return this.TAGGER_CL_CATEGORIES;
    return [];
  },

  taggerCategoryLabel(key) {
    const suffix = key.charAt(0).toUpperCase() + key.slice(1);
    return this.t('tagger.cat' + suffix, key);
  },

  taggerCategoryOptions() {
    return this.taggerCategoryKeys().map(key => ({
      key,
      label: this.taggerCategoryLabel(key),
      threshold: Number(this.taggerSettings.categoryThresholds[key] ?? (key === 'character' ? 0.6 : 0.35)),
      enabled: this.taggerSettings.categoryEnabled[key] !== false,
    }));
  },

  handleTaggerModelChange(resetPreset = true) {
    localStorage.setItem('anima-tagger-model', this.taggerSelectedModel || '');
    const allowed = this.taggerPresetOptions().map(option => option[0]);
    let preset = this.taggerSettings.preset;
    if (resetPreset || !allowed.includes(preset)) {
      preset = this.taggerIsLlm() ? this.taggerDefaultPromptPreset : (this.taggerUsesCategoryThresholds() ? 'macro' : 'balanced');
    }
    this.applyTaggerPreset(preset);
    this.taggerCategoryState = {};
    this.taggerResultCategories = {};
    this._taggerLoadedResultKey = '';
    if (this.taggerIsLlm()) void this.refreshTaggerRuntime(true);
  },

  taggerVramLimited() {
    const model = this.taggerModel();
    if (!model || model.engine !== 'llama') return false;
    const total = Number(this.gpuInfo?.vram_total_mb || this.taggerHardware.vram_total_mb || 0);
    const used = Number(this.gpuInfo?.vram_used_mb || 0);
    return total > 0 && (total - used) / 1024 < Number(model.min_vram_gb || 0);
  },

  taggerCanStart() {
    return !!(this.taggerSource && this.taggerSource.total && this.taggerSelectedModel && !this.taggerRunning && !this.taggerStarting && !this.taggerInstalling && !this.trainingActive);
  },

  taggerStartLabel() {
    if (this.taggerInstalling) return this.t('tagger.installing', 'Downloading');
    if (this.taggerStarting) return this.t('common.starting', 'Starting');
    const model = this.taggerModel();
    if (model && model.engine === 'llama' && !model.installed) return this.t('tagger.downloadAndStart', 'Download and start');
    return this.t('tagger.start', 'Start');
  },

  applyTaggerPreset(preset) {
    this.taggerSettings.preset = preset;
    if (this.taggerIsLlm()) {
      if (preset !== 'custom') {
        const prompt = this.taggerPromptPresets.find(item => item.id === preset)?.prompt || '';
        if (prompt) this.taggerSettings.prompt = prompt;
        this.taggerSettings.promptBasePreset = preset;
      } else if (!String(this.taggerSettings.prompt || '').trim()) {
        const base = this.taggerSettings.promptBasePreset || this.taggerDefaultPromptPreset;
        this.taggerSettings.prompt = this.taggerPromptPresets.find(item => item.id === base)?.prompt || '';
      }
      this.saveTaggerSettings();
      return;
    }
    if (preset === 'custom') {
      if (this.taggerUsesCategoryThresholds()) this.taggerThresholdsOpen = true;
      this.saveTaggerSettings();
      return;
    }
    if (this.taggerUsesCategoryThresholds()) {
      if (preset === 'custom') this.taggerThresholdsOpen = true;
      const presets = this.taggerSelectedModel === 'camie-tagger-v2' ? this.TAGGER_CAMIE_PRESETS : this.TAGGER_CL_PRESETS;
      if (preset !== 'custom' && presets[preset]) {
        this.taggerSettings.categoryThresholds = Object.assign({}, this.taggerSettings.categoryThresholds, presets[preset]);
        const enabled = Object.assign({}, this.taggerSettings.categoryEnabled);
        this.taggerCategoryKeys().forEach(key => { if (enabled[key] == null) enabled[key] = true; });
        this.taggerSettings.categoryEnabled = enabled;
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
          category.visible = this.taggerSettings.categoryEnabled[key] !== false;
        } else {
          category.threshold = Number(key === 'character' ? this.taggerSettings.characterThreshold : this.taggerSettings.threshold);
        }
      });
      this.recalculateAllTaggerCategories(true);
    }
  },

  taggerPresetOptions() {
    if (this.taggerIsLlm()) return [
      ['danbooru', this.t('tagger.promptDanbooru', 'Danbooru-style Tags')],
      ['enhanced', this.t('tagger.promptEnhanced', 'Enhanced Tags')],
      ['custom', this.t('tagger.presetCustom', 'Custom')],
    ];
    if (this.taggerUsesCategoryThresholds()) return [['macro', this.t('tagger.presetMacro', 'Macro')], ['micro', this.t('tagger.presetMicro', 'Micro')], ['custom', this.t('tagger.presetCustom', 'Custom')]];
    return [['recall', this.t('tagger.presetRecall', 'Recall')], ['balanced', this.t('tagger.presetBalanced', 'Balanced')], ['precise', this.t('tagger.presetPrecise', 'Precise')], ['custom', this.t('tagger.presetCustom', 'Custom')]];
  },

  setTaggerCustomPreset() {
    this.taggerSettings.preset = 'custom';
    this.saveTaggerSettings();
  },

  markTaggerPromptCustom() {
    if (!this.taggerIsLlm()) return;
    if (this.taggerSettings.preset !== 'custom') {
      this.taggerSettings.promptBasePreset = this.taggerSettings.preset || this.taggerDefaultPromptPreset;
      this.taggerSettings.preset = 'custom';
    }
  },

  restoreTaggerPrompt() {
    const preset = this.taggerSettings.preset === 'custom'
      ? (this.taggerSettings.promptBasePreset || this.taggerDefaultPromptPreset)
      : this.taggerSettings.preset;
    this.applyTaggerPreset(preset || this.taggerDefaultPromptPreset);
  },

  async refreshTaggerRuntime(silent = false) {
    if (!this.taggerIsLlm()) {
      this.taggerRuntime = null;
      return;
    }
    if (!silent) this.taggerRuntimeBusy = true;
    try {
      const response = await fetch('/api/tagger/runtime');
      const body = await response.json();
      if (body.status === 'success') this.taggerRuntime = body.data || null;
      else if (!silent) throw new Error(body.message || 'Runtime status unavailable');
    } catch (error) {
      if (!silent) this.toast(error.message, 'error');
    } finally {
      if (!silent) this.taggerRuntimeBusy = false;
    }
  },

  taggerRuntimeMatchesSettings() {
    return !!(
      this.taggerRuntime?.running
      && this.taggerRuntime.loaded_model === this.taggerSelectedModel
      && !!this.taggerRuntime.low_vram === !!this.taggerSettings.lowVram
    );
  },

  taggerRuntimeStateLabel() {
    if (this.taggerRuntimeBusy) return this.t('tagger.runtimeChanging');
    if (!this.taggerRuntime?.installed) return this.t('tagger.runtimeNotInstalled');
    if (!this.taggerRuntime.running) return this.t('tagger.runtimeStopped');
    if (!this.taggerRuntimeMatchesSettings()) return this.t('tagger.runtimeConfigChanged');
    return this.t('tagger.runtimeReady');
  },

  taggerRuntimeDetail() {
    if (!this.taggerRuntime?.running) return this.t('tagger.runtimeAutoStartDesc');
    const model = this.taggerModels.find(item => item.id === this.taggerRuntime.loaded_model);
    const remaining = Number(this.taggerRuntime.idle_remaining_seconds || 0);
    const minutes = Math.max(1, Math.ceil(remaining / 60));
    return this.t('tagger.runtimeLoadedDetail')
      .replace('{model}', model?.name || this.taggerRuntime.loaded_model || '')
      .replace('{minutes}', String(minutes));
  },

  async preloadTaggerRuntime() {
    if (!this.taggerIsLlm() || !this.taggerModel()?.installed || this.taggerRuntimeBusy || this.taggerRunning) return;
    this.taggerRuntimeBusy = true;
    try {
      const response = await fetch('/api/tagger/runtime/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: this.taggerSelectedModel, low_vram: !!this.taggerSettings.lowVram }),
      });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Unable to preload model');
      this.taggerRuntime = body.data || null;
    } catch (error) { this.toast(error.message, 'error'); }
    finally {
      await this.refreshTaggerRuntime(true);
      this.taggerRuntimeBusy = false;
    }
  },

  async releaseTaggerRuntime() {
    if (!this.taggerRuntime?.running || this.taggerRuntimeBusy || this.taggerRunning) return;
    this.taggerRuntimeBusy = true;
    try {
      const response = await fetch('/api/tagger/runtime/stop', { method: 'POST' });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Unable to release model');
      this.taggerRuntime = body.data || null;
    } catch (error) { this.toast(error.message, 'error'); }
    finally { this.taggerRuntimeBusy = false; }
  },

  updateTaggerCategorySetting(key) {
    this.taggerSettings.preset = 'custom';
    this.taggerSettings.categoryThresholds = Object.assign({}, this.taggerSettings.categoryThresholds, {
      [key]: Math.max(0, Math.min(1, Number(this.taggerSettings.categoryThresholds[key]) || 0)),
    });
    this.saveTaggerSettings();
  },

  adjustTaggerCategoryThreshold(key, delta) {
    const current = Number(this.taggerSettings.categoryThresholds[key]) || 0;
    this.taggerSettings.categoryThresholds = Object.assign({}, this.taggerSettings.categoryThresholds, {
      [key]: Number(Math.max(0, Math.min(1, current + delta)).toFixed(3)),
    });
    this.updateTaggerCategorySetting(key);
  },

  toggleTaggerCategorySetting(key) {
    this.taggerSettings.categoryEnabled = Object.assign({}, this.taggerSettings.categoryEnabled, {
      [key]: this.taggerSettings.categoryEnabled[key] !== false,
    });
    this.saveTaggerSettings();
  },

  taggerEffectiveCategoryThresholds() {
    if (!this.taggerUsesCategoryThresholds()) return {};
    return Object.fromEntries(this.taggerCategoryKeys().map(key => [
      key,
      this.taggerSettings.categoryEnabled[key] === false ? 1.01 : Number(this.taggerSettings.categoryThresholds[key] ?? 0.35),
    ]));
  },

  async selectTaggerSourceMode(mode) {
    if (this.taggerRunning) return;
    this.taggerTaskId = null;
    this.taggerTask = null;
    localStorage.removeItem('anima-tagger-task-id');
    this.taggerSourceMode = mode;
    this.taggerSourcePath = '';
    this.taggerSource = null;
    this.taggerItems = [];
    this.taggerItemsTotal = 0;
    this.taggerResultText = '';
    this.taggerThresholdsOpen = false;
    this._releaseTaggerPreview();
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
    } catch (_) { this.toast(this.t('common.localPickerNA', 'Local picker unavailable')); }
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

  async handleTaggerPaste(event) {
    if (this.currentRoute !== 'tagger' || this.taggerSourceMode !== 'single') return;
    const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
    const image = items.find(item => item.type && item.type.startsWith('image/'));
    if (image) await this.uploadTaggerFile(image.getAsFile());
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
    this.taggerSourcePath = source.path || this.taggerSourcePath;
    this.taggerItems = (source.items || []).map(item => Object.assign({ status: 'pending' }, item));
    this.taggerItemsTotal = Number(source.total || this.taggerItems.length);
    this.taggerSelectedIndex = 0;
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    this._taggerLoadedResultKey = '';
    this.saveTaggerSettings();
  },

  taggerPreviewUrl(index) {
    if (this.taggerSourceMode === 'single' && this._taggerPreviewObjectUrl && index === 0) return this._taggerPreviewObjectUrl;
    return this.taggerSource ? `/api/tagger/source/${this.taggerSource.source_token}/${index}` : '';
  },

  taggerThumbUrl(index) {
    return this.taggerSource ? `/api/tagger/thumbnails/${this.taggerSource.source_token}/${index}` : '';
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
    const state = {};
    if (this.taggerSourceMode === 'single' && !this.taggerIsLlm()) {
      Object.entries(this.taggerResultCategories).forEach(([key, category]) => {
        const rawTags = Array.isArray(category) ? category : (category.tags || []);
        if (!rawTags.length) return;
        const defaultThreshold = key === 'character' ? this.taggerSettings.characterThreshold : this.taggerSettings.threshold;
        state[key] = {
          label: category.label || this.taggerCategoryLabel(key),
          tags: rawTags,
          threshold: Number(this.taggerSettings.categoryThresholds[key] ?? defaultThreshold ?? 0.5),
          visible: this.taggerSettings.categoryEnabled[key] !== false,
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

  taggerCategoryEntries() {
    return Object.entries(this.taggerCategoryState).map(([key, category]) => ({ key, ...category }));
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
    if (this.taggerUsesCategoryThresholds()) {
      this.taggerSettings.preset = 'custom';
      this.taggerSettings.categoryEnabled = Object.assign({}, this.taggerSettings.categoryEnabled, {
        [key]: !!category.visible,
      });
      this.saveTaggerSettings();
    }
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
    if (this.taggerUsesCategoryThresholds()) {
      this.taggerSettings.preset = 'custom';
      this.taggerSettings.categoryEnabled = Object.fromEntries(this.taggerCategoryKeys().map(key => [key, visible]));
      this.saveTaggerSettings();
    }
    this.recalculateAllTaggerCategories(true);
  },

  setAllTaggerCategoriesCollapsed(collapsed) {
    Object.values(this.taggerCategoryState).forEach(category => { category.collapsed = collapsed; });
  },

  formatTaggerOutputName(name) {
    let value = String(name || '');
    if (this.taggerSettings.replaceUnderscore) value = value.replace(/_/g, ' ');
    if (this.taggerSettings.escapeTag) value = value.replace(/([\\()])/g, '\\$1');
    return value;
  },

  taggerVisibleCategoryTags() {
    const excluded = new Set(String(this.taggerSettings.excludeTags || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
    const values = [];
    const seen = new Set();
    Object.entries(this.taggerCategoryState).forEach(([key, category]) => {
      if (!category.visible || (key === 'rating' && !this.taggerSettings.addRatingTag) || (key === 'model' && !this.taggerSettings.addModelTag)) return;
      category.visibleTags.forEach(tag => {
        const raw = String(tag[0] || '').trim();
        const normalized = raw.toLowerCase();
        if (!raw || excluded.has(normalized) || (this.taggerSettings.removeDuplicated && seen.has(normalized))) return;
        seen.add(normalized);
        values.push(this.formatTaggerOutputName(raw));
      });
    });
    const additional = String(this.taggerSettings.additionalTags || '').split(',').map(value => value.trim()).filter(Boolean);
    additional.reverse().forEach(raw => {
      const normalized = raw.toLowerCase();
      if (excluded.has(normalized) || (this.taggerSettings.removeDuplicated && seen.has(normalized))) return;
      seen.add(normalized);
      values.unshift(this.formatTaggerOutputName(raw));
    });
    return values;
  },

  refreshTaggerResultFromCategories() {
    if (this.taggerSourceMode !== 'single' || !Object.keys(this.taggerCategoryState).length) return;
    this.taggerResultText = this.taggerVisibleCategoryTags().join(', ');
  },

  taggerVisibleCategoryCount() {
    return Object.values(this.taggerCategoryState).reduce((total, category) => total + (category.visibleTags || []).length, 0);
  },

  async copyTaggerCategory(key) {
    const category = this.taggerCategoryState[key];
    if (!category) return;
    const text = category.visibleTags.map(tag => this.formatTaggerOutputName(tag[0])).join(', ');
    if (!text) return;
    try { await navigator.clipboard.writeText(text); this.toast(this.t('tagger.copied', 'Copied')); }
    catch (_) { this.toast(this.t('common.failed', 'Failed'), 'error'); }
  },

  async startTagger() {
    if (!this.taggerCanStart()) return;
    const model = this.taggerModel();
    if (model && model.engine === 'llama' && !model.installed) {
      this._taggerPendingStart = true;
      await this.installTaggerModel();
      return;
    }
    this.taggerStarting = true;
    this.saveTaggerSettings();
    try {
      const payload = {
        source_token: this.taggerSource.source_token,
        model_id: this.taggerSelectedModel,
        conflict: this.taggerSettings.conflict,
        write_captions: this.taggerSource.kind !== 'upload',
        options: {
          threshold: Number(this.taggerSettings.threshold),
          character_threshold: Number(this.taggerSettings.characterThreshold),
          category_thresholds: this.taggerEffectiveCategoryThresholds(),
          max_tags: Number(this.taggerSettings.maxTags),
          preset: this.taggerSettings.preset,
          prompt: String(this.taggerSettings.prompt || ''),
          low_vram: this.taggerSettings.lowVram,
          replace_underscore: this.taggerSettings.replaceUnderscore,
          escape_tag: this.taggerSettings.escapeTag,
          add_rating_tag: this.taggerSettings.addRatingTag,
          add_model_tag: this.taggerSettings.addModelTag,
          remove_duplicated: this.taggerSettings.removeDuplicated,
          additional_tags: this.taggerSettings.additionalTags,
          exclude_tags: this.taggerSettings.excludeTags,
        },
      };
      const response = await fetch('/api/tagger/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Unable to start');
      this.attachTaggerTask(body.data.task_id);
    } catch (error) { this.toast(error.message, 'error'); }
    finally { this.taggerStarting = false; }
  },

  async installTaggerModel() {
    this.taggerInstalling = true;
    try {
      const response = await fetch(`/api/tagger/models/${encodeURIComponent(this.taggerSelectedModel)}/install`, { method: 'POST' });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Unable to install model');
      this._setTaggerRealtimeTask(body.data.task_id);
    } catch (error) {
      this.taggerInstalling = false;
      this._taggerPendingStart = false;
      this.toast(error.message, 'error');
    }
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
    if (envelope.kind === 'tagger-install') {
      this.taggerTask = envelope.data || {};
      if (['FINISHED', 'FAILED', 'TERMINATED'].includes(envelope.status)) this.finishTaggerInstall(envelope.status, envelope.data || {});
      return;
    }
    this.applyTaggerTaskSnapshot(envelope.data || {}, envelope.status || '');
  },

  applyRealtimeTaggerSnapshot(snapshot) {
    if (!this.taggerTaskId || !snapshot || !snapshot.tasks) return;
    const task = (snapshot.tasks.tracked || []).find(item => item.task_id === this.taggerTaskId);
    if (task) this.applyTaggerTaskSnapshot(task.data || {}, task.status || '');
  },

  resetRealtimeTaggerState() {
    const active = !!(this.taggerRunning || this.taggerInstalling);
    this._setTaggerRealtimeTask(null);
    this.taggerRunning = false;
    this.taggerInstalling = false;
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
      if (data.status === 'done') this.toast(this.t('tagger.completed', 'Tagging completed'));
      if (this.taggerIsLlm()) void this.refreshTaggerRuntime(true);
    }
  },

  async finishTaggerInstall(status, data) {
    this.taggerInstalling = false;
    this._setTaggerRealtimeTask(null);
    if (status !== 'FINISHED') {
      this._taggerPendingStart = false;
      this.toast(data.error_detail || this.t('common.failed', 'Failed'), 'error');
      return;
    }
    await this.loadTaggerModels();
    if (this._taggerPendingStart) {
      this._taggerPendingStart = false;
      await this.startTagger();
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

  async loadMoreTaggerItems(event) {
    const element = event.currentTarget;
    if (!this.taggerSource || !element || element.scrollLeft + element.clientWidth < element.scrollWidth - 240) return;
    const total = Number(this.taggerItemsTotal || this.taggerTask?.total || this.taggerSource.total || 0);
    if (this.taggerItems.length >= total) return;
    try {
      const lastIndex = this.taggerItems.reduce((highest, item) => Math.max(highest, Number(item.index)), -1);
      const offset = this.taggerFailedOnly ? this.taggerItems.length : lastIndex + 1;
      const url = this.taggerTaskId
        ? `/api/tagger/tasks/${encodeURIComponent(this.taggerTaskId)}/items?offset=${offset}&limit=120&failed_only=${this.taggerFailedOnly}`
        : `/api/tagger/source/${encodeURIComponent(this.taggerSource.source_token)}/items?offset=${offset}&limit=120`;
      const response = await fetch(url);
      const body = await response.json();
      if (body.status === 'success') {
        this.taggerItemsTotal = Number(body.data.total || this.taggerItemsTotal);
        this._mergeTaggerItems(body.data.items || [], false);
      }
    } catch (_) {}
  },

  async toggleTaggerFailedOnly() {
    this.taggerFailedOnly = !this.taggerFailedOnly;
    await this.refreshTaggerItems(true);
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
    try { await navigator.clipboard.writeText(this.taggerResultText); this.toast(this.t('tagger.copied', 'Copied')); }
    catch (_) { this.toast(this.t('common.failed', 'Failed'), 'error'); }
  },

  async saveTaggerResult() {
    if (!this.taggerSource || !this.taggerResultText.trim()) return;
    try {
      const response = await fetch('/api/tagger/captions/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_token: this.taggerSource.source_token, index: this.taggerSelectedIndex, text: this.taggerResultText }),
      });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || 'Save failed');
      this.taggerResultText = body.data.text;
      this.toast(this.t('common.saved', 'Saved'));
    } catch (error) { this.toast(error.message, 'error'); }
  },

  openTaggerDatasetInEditor() {
    if (this.taggerSource && this.taggerSource.kind === 'folder') this.tagEditorDir = this.taggerSource.path || this.taggerSourcePath;
    this.navigate('tagEditor');
  },

  taggerProgressPercent() {
    if (!this.taggerTask || !this.taggerTask.total) return 0;
    const completed = this.taggerInstalling ? this.taggerTask.downloaded : this.taggerTask.current;
    return Math.min(100, Math.round(Number(completed || 0) * 100 / Number(this.taggerTask.total)));
  },

  taggerTaskProgressText() {
    if (!this.taggerTask) return '';
    if (this.taggerInstalling) {
      const downloaded = this.formatTaggerBytes(this.taggerTask.downloaded || 0);
      const total = this.taggerTask.total ? this.formatTaggerBytes(this.taggerTask.total) : '--';
      const file = this.taggerTask.file_total
        ? ` · ${this.taggerTask.file_index || 1}/${this.taggerTask.file_total}`
        : '';
      return `${downloaded} / ${total}${file}`;
    }
    return `${this.taggerTask.current || 0} / ${this.taggerTask.total || this.taggerSource?.total || 0}`;
  },

  formatTaggerEta(seconds) {
    if (seconds == null) return '--';
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    return minutes ? `${minutes}m ${Math.round(value % 60)}s` : `${Math.round(value)}s`;
  },

  formatTaggerBytes(bytes) {
    const gb = Number(bytes || 0) / 1073741824;
    return gb >= 1 ? gb.toFixed(1) + ' GB' : Math.round(Number(bytes || 0) / 1048576) + ' MB';
  },

  formatTaggerDownloadSpeed(speed) {
    return Number(speed || 0) > 0 ? Number(speed).toFixed(1) + ' MB/s' : '--';
  },

  taggerPhaseLabel() {
    const phase = this.taggerTask?.phase || (this.taggerRuntimeBusy ? 'loading_model' : (this.taggerScanning ? 'scanning' : 'ready'));
    return this.t('tagger.phase.' + phase, phase.replace(/_/g, ' '));
  },

  taggerLogLines() {
    const taskLogs = Array.isArray(this.taggerTask?.logs) ? this.taggerTask.logs : [];
    const runtimeLogs = this.taggerIsLlm() && Array.isArray(this.taggerRuntime?.logs) ? this.taggerRuntime.logs : [];
    return Array.from(new Set([...taskLogs, ...runtimeLogs]));
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
