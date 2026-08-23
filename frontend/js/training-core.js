/* ================================================================
   training-core.js — State, Form building, File pickers
   Mixin merged into animaApp Alpine component
   ================================================================ */

// 绿色"已填"指示条字段清单：仅这些字段在"非空且非 schema 原始默认值"时显示绿色左边条，
// 表示关键路径字段已就绪填写。优先级高于橙色 field-changed。
// 用 field.default（schema 原始默认）而非 formDefaults 做基准，不被配置导入重置影响。
window.FILLED_INDICATOR_KEYS = new Set([
  'pretrained_model_name_or_path', 'dit', 'vae', 'qwen3', 'text_encoder', 'train_data_dir', 'dataset_cache_dir',
  'output_name', 'output_dir',
]);

// 预填默认值淡色字段清单：仅这些 text 字段在"值==schema 原始默认值"时 input 字色淡化为 placeholder 视觉。
// 三个 Anima 底模字段默认指向环境管理页可下载的文件（非空），纳入此清单以提示"仍为默认值"。
window.DEFAULT_DIM_KEYS = new Set([
  'pretrained_model_name_or_path', 'dit', 'vae', 'qwen3', 'text_encoder',
  'train_data_dir', 'output_name', 'output_dir',
]);

window.trainingCoreMixin = {
  // ── State ──────────────────────────────────────────────
  form: {},
  formDefaults: {},
  formHistory: [],
  formHistoryIdx: -1,
  formErrors: {},
  _profileFormDrafts: {},
  _profileFieldSources: {},
  _fieldSources: {},
  _activeTrainType: '',

  // 分组折叠状态，响应式驱动 UI
  _sectionCollapsed: {},
  _trainTypePanelCache: null,
  _trainFieldsRevision: 0,
  _profileWatcherSetupHandle: null,
  _profileWatcherSetupUsesIdle: false,

  // 分组导航指示器（#1）：当前可见分组列表 + 滚动高亮的当前分组
  sectionNavList: [],
  activeSection: '',
  sectionRailHover: false,
  _sectionScrollHandler: null,
  _sectionMouseHandler: null,
  _sidebarResizeObserver: null,
  _sidebarResizeHandler: null,

  _formSaveTimer: null,
  _localeChangeHandler: null,
  _trainFormMountedRoute: '',
  _trainFormLocale: '',
  _conditionalMotionQueue: null,
  _conditionalMotionTimer: null,
  _conditionalMotionEpoch: 0,
  _trainTypeSwitchFrame: null,
  _trainTypeSwitchCommitFrame: null,
  _pendingTrainType: '',
  showFilePickerModalFlag: false,
  _pickerKey: '',
  _pickerFiles: [],
  _pickerFilter: '',
  timestepPreviewOpen: false,
  timestepPreviewData: null,
  timestepPreviewScope: 'base',
  subsetTimestepOffsetDrafts: {},

  // Training state
  trainingBlocked: false,
  activeTaskId: null,

  stepEstimate: null,
  stepEstimateLoading: false,
  stepEstimateError: null,
  _stepEstimateTimer: null,
  _stepEstimateRequestSeq: 0,
  _stepEstimateSignature: '',

  outputPathInfo: null,
  outputPathInfoLoading: false,
  outputPathInfoError: '',
  _outputPathInfoTimer: null,
  _outputPathInfoRequestSeq: 0,
  _outputPathInfoSignature: '',

  trainTypes: [
    { v: 'anima-lora', l: 'Anima LoRA', dk: 'opt.model_train_type_anima-lora' },
    { v: 'sdxl-lora', l: 'SDXL LoRA', dk: 'opt.model_train_type_sdxl-lora' },
    { v: 'krea2-lora', l: 'Krea 2 LoRA (musubi-tuner)', dk: 'opt.model_train_type_krea2-lora' },
  ],
  currentTrainTypeDesc: '',
  currentTrainTypeLabel: 'Anima LoRA',

  _clearProfileFieldWatchers() {
    this._cancelProfileFieldWatcherSetup();
    ['_autoValueWatchers', '_showIfWatchers', '_readonlyWatchers'].forEach(key => {
      (this[key] || []).forEach(stop => { if (typeof stop === 'function') stop(); });
      this[key] = [];
    });
  },

  _cancelProfileFieldWatcherSetup() {
    if (this._profileWatcherSetupHandle === null) return;
    if (this._profileWatcherSetupUsesIdle && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(this._profileWatcherSetupHandle);
    } else {
      clearTimeout(this._profileWatcherSetupHandle);
    }
    this._profileWatcherSetupHandle = null;
    this._profileWatcherSetupUsesIdle = false;
  },

  _scheduleProfileFieldWatchers(trainType) {
    this._cancelProfileFieldWatcherSetup();
    const setup = () => {
      this._profileWatcherSetupHandle = null;
      this._profileWatcherSetupUsesIdle = false;
      if ((this.form.model_train_type || this._activeTrainType) !== trainType) return;
      this.setupAutoValueWatchers();
      this.setupShowIfWatchers();
      this.setupReadonlyWatchers();
    };
    if (typeof requestIdleCallback === 'function') {
      this._profileWatcherSetupUsesIdle = true;
      this._profileWatcherSetupHandle = requestIdleCallback(setup, { timeout: 120 });
    } else {
      this._profileWatcherSetupHandle = setTimeout(setup, 0);
    }
  },

  _trainTypePanelIsReady(trainType) {
    if (!(this._trainTypePanelCache instanceof Map)) return false;
    const panel = this._trainTypePanelCache.get(trainType);
    return !!panel
      && panel.getAttribute('data-panel-ready') === '1'
      && panel.dataset.panelLocale === String(this.locale || '')
      && panel.dataset.fieldsRevision === String(this._trainFieldsRevision || 0);
  },

  _commitTrainTypeSwitch(target) {
    if (target && target !== this.form.model_train_type) {
      this._switchInProgress = true;
      try { this.switchTrainType(target); } finally { this._switchInProgress = false; }
    }
  },

  _scheduleTrainTypeSwitch(value) {
    // 三套表单在进入页面时已完成初始化。缓存命中时直接换面板，不再人为等待
    // 两个 animation frame；昂贵的字段 watcher 在换屏后空闲阶段恢复。
    if (this._trainTypePanelIsReady(value)) {
      this._cancelScheduledTrainTypeSwitch();
      this._commitTrainTypeSwitch(value);
      return;
    }

    this._pendingTrainType = value;
    const formElement = document.getElementById('trainForm');
    if (formElement) {
      formElement.classList.add('train-type-switching');
      formElement.setAttribute('aria-busy', 'true');
    }
    if (this._trainTypeSwitchFrame !== null || this._trainTypeSwitchCommitFrame !== null) return;

    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : callback => setTimeout(callback, 0);
    // 两帧分离：第一帧先让下拉关闭和旧表单淡出完成绘制；第二帧才执行
    // 较重的 DOM/Alpine 重建，避免点击事件本身长时间无响应。
    this._trainTypeSwitchFrame = raf(() => {
      this._trainTypeSwitchFrame = null;
      this._trainTypeSwitchCommitFrame = raf(() => {
        this._trainTypeSwitchCommitFrame = null;
        const target = this._pendingTrainType;
        this._pendingTrainType = '';
        this._commitTrainTypeSwitch(target);
        raf(() => {
          const currentForm = document.getElementById('trainForm');
          if (currentForm) {
            currentForm.classList.remove('train-type-switching');
            currentForm.removeAttribute('aria-busy');
          }
        });
      });
    });
  },

  _cancelScheduledTrainTypeSwitch() {
    const cancel = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : clearTimeout;
    if (this._trainTypeSwitchFrame !== null) cancel(this._trainTypeSwitchFrame);
    if (this._trainTypeSwitchCommitFrame !== null) cancel(this._trainTypeSwitchCommitFrame);
    this._trainTypeSwitchFrame = null;
    this._trainTypeSwitchCommitFrame = null;
    this._pendingTrainType = '';
    const formElement = document.getElementById('trainForm');
    if (formElement) {
      formElement.classList.remove('train-type-switching');
      formElement.removeAttribute('aria-busy');
    }
  },

  switchTrainType(v) {
    // Update display labels and descriptions
    const tt = this.trainTypes.find(t => t.v === v);
    this.currentTrainTypeDesc = tt ? window.t(tt.dk, tt.l) : '';
    this.currentTrainTypeLabel = tt ? tt.l : '';

    // 旧类型的字段 watcher 若留到 form 整体替换之后再释放，会先针对新对象
    // 执行一轮旧规则（显隐扫描、只读刷新、自动值联动），造成重复渲染。
    this._clearProfileFieldWatchers();

    // 每个训练类型拥有独立草稿。切出时保存当前类型，第一次切入新类型时从
    // 该类型的 registry 默认值创建；切回来时仅恢复它自己的字段，避免同名
    // 参数（优化器、学习率、保存设置等）跨训练核心相互污染。
    const previousType = this._activeTrainType;
    if (previousType && previousType !== v) {
      this._captureProfileDraft(previousType, { ...this.form, model_train_type: previousType });
      this._captureProfileFieldSources(previousType);
    }
    const newDefaults = this._buildFormDefaults(v);
    const nextDraft = this._profileFormDrafts[v] || null;
    this.form = this._profileFormFromDraft(v, newDefaults, nextDraft);
    this._activateProfileFieldSources(v, newDefaults, nextDraft, !!nextDraft);
    if (v === 'krea2-lora') this._applyKrea2ModelDefaults(this.form, newDefaults);
    this._normalizeProfileSelectValues(v, newDefaults);
    this.formDefaults = { ...newDefaults };
    this._activeTrainType = v;

    // A runtime profile owns its network module. Krea's module is musubi
    // specific and must never inherit an sd-scripts or LyCORIS selection.
    const targetMod = v === 'anima-lora'
      ? 'networks.lora_anima'
      : (v === 'krea2-lora' ? 'networks.lora_krea2' : 'networks.lora');
    if (this.form.network_module !== targetMod) this.form.network_module = targetMod;
    this._syncKrea2CacheDir();
    this._captureProfileDraft(v, this.form, newDefaults);
    this._persistProfileDrafts();
    this._persistProfileFieldSources();
    this.formHistory = [{ ...this.form }];
    this.formHistoryIdx = 0;

    // Re-render form with new train type
    this.renderTrainingForm(v, null);
    this._scheduleProfileFieldWatchers(v);
    this.updateToml();
    // 防御：renderTrainingForm 用 innerHTML 重建了 animaSelect 组件，Alpine 异步初始化。
    // 在下一个 tick 再次确保 network_module 与训练类型一致，防止组件初始化时读到旧值
    // 导致下拉显示 networks.lora（anima 下该选项已被 group 过滤，会显示原始值而非标签）。
    this.$nextTick(() => {
      if (this.form.network_module !== targetMod) {
        this.form.network_module = targetMod;
        this.updateToml();
      }
    });
  },

  // 构建指定训练类型的字段默认值字典（与 buildTrainForm 共用逻辑）。
  _buildFormDefaults(trainType) {
    const defaults = {};
    const allSections = window.getVisibleSections(trainType);
    allSections.forEach(s => { s.fields.forEach(f => {
      const hasExplicitDefault = f.default !== undefined && f.default !== null && f.default !== '';
      if (hasExplicitDefault) {
        defaults[f.key] = f.default && typeof f.default === 'object'
          ? (Array.isArray(f.default) ? [...f.default] : { ...f.default })
          : f.default;
      } else if (!f.hidden) {
        if (f.type === 'toggle') defaults[f.key] = false;
        else if (f.type === 'number' || f.type === 'stepper') defaults[f.key] = '';
        else if (f.type === 'select' && f.options && f.options.length) defaults[f.key] = f.options[0].v;
        else defaults[f.key] = '';
      }
    }); });
    defaults.model_train_type = trainType;
    // Adjust network_module default based on train type
    if (trainType === 'anima-lora') defaults.network_module = 'networks.lora_anima';
    else if (trainType === 'krea2-lora') defaults.network_module = 'networks.lora_krea2';
    return defaults;
  },

  _profileDraftStorageKey(route = this.currentRoute) {
    return route && route.startsWith('train-') ? `anima-form-profiles-${route}` : '';
  },

  _profileFieldSourceStorageKey(route = this.currentRoute) {
    return route && route.startsWith('train-')
      ? `anima-form-profile-sources-v1-${route}`
      : '';
  },

  _loadProfileDrafts(route = this.currentRoute) {
    const storageKey = this._profileDraftStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return {};
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const validTypes = new Set(this.trainTypes.map(item => item.v));
      return Object.fromEntries(
        Object.entries(parsed).filter(([key, value]) =>
          validTypes.has(key) && value && typeof value === 'object' && !Array.isArray(value))
      );
    } catch (e) {
      return {};
    }
  },

  _loadProfileFieldSources(route = this.currentRoute) {
    const storageKey = this._profileFieldSourceStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return {};
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (!parsed || parsed.version !== 1 || !parsed.profiles ||
          typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
        return {};
      }
      const validTypes = new Set(this.trainTypes.map(item => item.v));
      const validSources = new Set(['default', 'auto', 'user', 'import', 'saved']);
      return Object.fromEntries(
        Object.entries(parsed.profiles).filter(([trainType, sources]) =>
          validTypes.has(trainType) && sources && typeof sources === 'object' && !Array.isArray(sources)
        ).map(([trainType, sources]) => [
          trainType,
          Object.fromEntries(Object.entries(sources).map(([key, source]) => [
            key,
            source === 'preset' ? 'import' : source,
          ]).filter(([, source]) => validSources.has(source))),
        ])
      );
    } catch (e) {
      return {};
    }
  },

  _setIfDefaultTargets(trainType) {
    const targets = new Set();
    window.getVisibleSections(trainType).forEach(section => {
      (section.fields || []).forEach(field => {
        (field.autoValue || []).forEach(rule => {
          if (rule.setIfDefault === true) targets.add(rule.setTarget || field.key);
        });
      });
    });
    return targets;
  },

  _activateProfileFieldSources(
    trainType,
    defaults = this._buildFormDefaults(trainType),
    draft = null,
    hasLegacyDraft = false
  ) {
    const persisted = this._profileFieldSources[trainType];
    const hasPersisted = persisted && typeof persisted === 'object' && !Array.isArray(persisted);
    const sources = {};
    Object.keys(defaults).forEach(key => { sources[key] = 'default'; });

    if (hasPersisted) {
      Object.keys(defaults).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(persisted, key)) sources[key] = persisted[key];
      });
    }

    if (hasLegacyDraft) {
      this._setIfDefaultTargets(trainType).forEach(key => {
        const missingMetadata = !hasPersisted || !Object.prototype.hasOwnProperty.call(persisted, key);
        if (missingMetadata && draft && Object.prototype.hasOwnProperty.call(draft, key)) {
          sources[key] = 'saved';
        }
      });
    }

    this._fieldSources = sources;
    this._profileFieldSources[trainType] = sources;
    return sources;
  },

  _replaceProfileFieldSources(trainType, defaults, explicitKeys = [], explicitSource = 'user') {
    const sources = {};
    Object.keys(defaults).forEach(key => { sources[key] = 'default'; });
    explicitKeys.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(defaults, key) || key === 'model_train_type') {
        sources[key] = explicitSource;
      }
    });
    this._fieldSources = sources;
    this._profileFieldSources[trainType] = sources;
    return sources;
  },

  _captureProfileFieldSources(trainType) {
    if (!trainType || !this._fieldSources || typeof this._fieldSources !== 'object') return null;
    const sources = { ...this._fieldSources };
    this._profileFieldSources[trainType] = sources;
    return sources;
  },

  _setFieldSource(key, source, trainType = this.form.model_train_type || this._activeTrainType) {
    if (!key || !trainType) return;
    if (!this._fieldSources || typeof this._fieldSources !== 'object') this._fieldSources = {};
    if (!this._profileFieldSources || typeof this._profileFieldSources !== 'object') {
      this._profileFieldSources = {};
    }
    this._fieldSources[key] = source;
    this._profileFieldSources[trainType] = this._fieldSources;
  },

  _profileFormFromDraft(trainType, defaults = this._buildFormDefaults(trainType), source = null) {
    const draft = source || this._profileFormDrafts[trainType] || {};
    const clean = { ...defaults };
    Object.keys(defaults).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(draft, key)) clean[key] = draft[key];
    });
    clean.model_train_type = trainType;
    return clean;
  },

  _captureProfileDraft(trainType, source = this.form, defaults = this._buildFormDefaults(trainType)) {
    if (!trainType) return null;
    const draft = this._profileFormFromDraft(trainType, defaults, source);
    this._profileFormDrafts[trainType] = draft;
    if (trainType === (this._activeTrainType || this.form.model_train_type)) {
      this._captureProfileFieldSources(trainType);
    }
    return draft;
  },

  _persistProfileDrafts(route = this.currentRoute) {
    const storageKey = this._profileDraftStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(this._profileFormDrafts));
    } catch (e) {}
  },

  _persistProfileFieldSources(route = this.currentRoute) {
    const storageKey = this._profileFieldSourceStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        version: 1,
        profiles: this._profileFieldSources,
      }));
    } catch (e) {}
  },

  _applyKrea2ModelDefaults(target = this.form, defaults = this._buildFormDefaults('krea2-lora')) {
    ['dit', 'vae', 'text_encoder'].forEach(key => {
      if (target[key] === undefined || target[key] === null || String(target[key]).trim() === '') {
        target[key] = defaults[key];
      }
    });
  },

  _normalizeProfileSelectValues(trainType, defaults = this._buildFormDefaults(trainType), target = this.form) {
    window.getVisibleSections(trainType).forEach(section => {
      section.fields.forEach(field => {
        if (field.type !== 'select' || !Array.isArray(field.options) || !field.options.length) return;
        const validValues = field.options.map(option => option.v);
        if (!validValues.includes(target[field.key])) {
          target[field.key] = defaults[field.key] ?? validValues[0];
        }
      });
    });
  },

  _deriveKrea2CacheDir(trainDataDir) {
    const raw = String(trainDataDir ?? '').trim();
    if (!raw) return '';
    const lastBackslash = raw.lastIndexOf('\\');
    const lastSlash = raw.lastIndexOf('/');
    const separator = lastBackslash > lastSlash ? '\\' : '/';
    const base = raw.replace(/[\\/]+$/, '');
    if (!base) return separator + '.krea2-cache';
    return `${base}${separator}.krea2-cache`;
  },

  _syncKrea2CacheDir() {
    if (!this.form || this.form.model_train_type !== 'krea2-lora') return false;
    const cacheDir = this._deriveKrea2CacheDir(this.form.train_data_dir);
    const changed = this.form.dataset_cache_dir !== cacheDir;
    if (changed) this.form.dataset_cache_dir = cacheDir;
    if (this.formDefaults && this.formDefaults.dataset_cache_dir !== cacheDir) {
      this.formDefaults.dataset_cache_dir = cacheDir;
    }
    return changed;
  },

  suspendTrainForm(route) {
    if (!route || !route.startsWith('train-')) return;

    this._cancelScheduledTrainTypeSwitch();
    clearTimeout(this._formSaveTimer);
    this._formSaveTimer = null;
    this._captureProfileDraft(this._activeTrainType || this.form.model_train_type, this.form);
    this._persistProfileDrafts(route);
    this._persistProfileFieldSources(route);
    try {
      localStorage.setItem('anima-form-' + route, JSON.stringify(this.form));
    } catch (e) {}

    clearTimeout(this._stepEstimateTimer);
    this._stepEstimateTimer = null;
    this._stepEstimateRequestSeq += 1;
    this._stepEstimateSignature = '';
    this.stepEstimateLoading = false;
    clearTimeout(this._outputPathInfoTimer);
    this._outputPathInfoTimer = null;
    this._outputPathInfoRequestSeq += 1;
    this._outputPathInfoSignature = '';
    this.outputPathInfoLoading = false;
    this.stopSectionScroll();
  },

  _disposeTrainForm() {
    this._cancelScheduledTrainTypeSwitch();
    this._cancelProfileFieldWatcherSetup();
    clearTimeout(this._formSaveTimer);
    this._formSaveTimer = null;
    if (this._trainFormMountedRoute) {
      this._captureProfileDraft(this._activeTrainType || this.form.model_train_type, this.form);
      this._persistProfileDrafts(this._trainFormMountedRoute);
      this._persistProfileFieldSources(this._trainFormMountedRoute);
      try {
        localStorage.setItem('anima-form-' + this._trainFormMountedRoute, JSON.stringify(this.form));
      } catch (e) {}
    }

    const dispose = (key) => {
      if (typeof this[key] === 'function') this[key]();
      this[key] = null;
    };
    dispose('_formWatcher');
    dispose('_trainTypeWatcher');
    ['_autoValueWatchers', '_showIfWatchers', '_readonlyWatchers'].forEach(key => {
      (this[key] || []).forEach(stop => { if (typeof stop === 'function') stop(); });
      this[key] = [];
    });
    if (this._localeChangeHandler) {
      window.removeEventListener('locale-changed', this._localeChangeHandler);
      this._localeChangeHandler = null;
    }
    if (this._trainingFieldsLoadedHandler) {
      window.removeEventListener('training-fields-loaded', this._trainingFieldsLoadedHandler);
      this._trainingFieldsLoadedHandler = null;
    }
    clearTimeout(this._stepEstimateTimer);
    this._stepEstimateTimer = null;
    this._stepEstimateRequestSeq += 1;
    this._stepEstimateSignature = '';
    this.stepEstimateLoading = false;
    clearTimeout(this._outputPathInfoTimer);
    this._outputPathInfoTimer = null;
    this._outputPathInfoRequestSeq += 1;
    this._outputPathInfoSignature = '';
    this.outputPathInfoLoading = false;
    clearTimeout(this._conditionalMotionTimer);
    this._conditionalMotionTimer = null;
    this._conditionalMotionQueue = null;
    this._conditionalMotionEpoch += 1;
    this.stopSectionScroll();

    this._destroyTrainTypePanelCache();
    const container = document.getElementById('trainFormContent');
    if (container) container.replaceChildren();
    this.sectionNavList = [];
    this.activeSection = '';
    this._trainFormMountedRoute = '';
    this._trainFormLocale = '';
  },

  _resumeTrainForm(route) {
    const container = document.getElementById('trainFormContent');
    if (!container || !container.childElementCount) return false;
    if (this._trainFormMountedRoute !== route || this._trainFormLocale !== this.locale) return false;

    const activeType = this.form && this.form.model_train_type;
    if (activeType) this._normalizeProfileSelectValues(activeType);

    this.buildSectionNav();
    this.refreshTrainingRealtimeState();
    this.scheduleStepEstimate();
    this.scheduleOutputPathInfo();
    this.$nextTick(() => this.updateToml());

    return true;
  },

  // ── Training Form ──────────────────────────────────────
  buildTrainForm() {
    const r = this.currentRoute;
    if (this._resumeTrainForm(r)) return;
    if (this._trainFormMountedRoute) this._disposeTrainForm();

    const cfg = ROUTE_CONFIG[r] || {};
    const routeTrainType = cfg.trainType || 'anima-lora';

    const savedKey = 'anima-form-' + r;
    let saved = null;
    try { const raw = localStorage.getItem(savedKey); if (raw) saved = JSON.parse(raw); } catch (e) {}
    this._profileFormDrafts = this._loadProfileDrafts(r);
    this._profileFieldSources = this._loadProfileFieldSources(r);

    // Use saved train type if valid, otherwise fall back to route default
    const validTrainTypes = this.trainTypes.map(t => t.v);
    let trainType = routeTrainType;
    if (saved && saved.model_train_type && validTrainTypes.includes(saved.model_train_type)) {
      trainType = saved.model_train_type;
    } else if (saved && saved.model_train_type === 'sd-lora') {
      // Migrate old value
      saved.model_train_type = routeTrainType;
    }

    const defaults = this._buildFormDefaults(trainType);
    const savedProfileDraft = this._profileFormDrafts[trainType] || {};
    const mergedSavedDraft = { ...savedProfileDraft, ...(saved || {}) };
    this.form = this._profileFormFromDraft(
      trainType,
      defaults,
      mergedSavedDraft
    );
    const hasSavedDraft = Object.keys(savedProfileDraft).length > 0 || !!saved;
    this._activateProfileFieldSources(trainType, defaults, mergedSavedDraft, hasSavedDraft);
    this._activeTrainType = trainType;
    // Ensure model_train_type is valid (saved may have been from another route)
    if (!validTrainTypes.includes(this.form.model_train_type)) {
      this.form.model_train_type = trainType;
    }
    this._normalizeProfileSelectValues(this.form.model_train_type, defaults);
    // Fix incompatible network_module after merge
    if (this.form.model_train_type === 'krea2-lora') {
      this.form.network_module = 'networks.lora_krea2';
      this._applyKrea2ModelDefaults(this.form, defaults);
    } else if (this.form.model_train_type === 'anima-lora' && this.form.network_module === 'networks.lora') {
      this.form.network_module = 'networks.lora_anima';
    } else if (this.form.model_train_type !== 'anima-lora' && this.form.network_module === 'networks.lora_anima') {
      this.form.network_module = 'networks.lora';
    }
    this.formDefaults = { ...defaults };
    this._syncKrea2CacheDir();
    this._captureProfileDraft(this.form.model_train_type, this.form, defaults);
    this._persistProfileDrafts(r);
    this._persistProfileFieldSources(r);
    this.formHistory = [{ ...this.form }];
    this.formHistoryIdx = 0;

    const tt = this.trainTypes.find(t => t.v === this.form.model_train_type);
    this.currentTrainTypeDesc = tt ? window.t(tt.dk, tt.l) : '';
    this.currentTrainTypeLabel = tt ? tt.l : '';

    // 分组导航只依赖训练类型（_allSections → getVisibleSections），
    // 先于重量级表单渲染构建，让快速导航随页面进入动画立即可见；
    // 渲染完成后 renderTrainingForm 会再次调用以同步折叠态。
    this.buildSectionNav();

    this.renderTrainingForm(trainType, null);
    this._warmTrainTypePanels(trainType);
    this._trainFormMountedRoute = r;
    this._trainFormLocale = this.locale;
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._autoValueWatchers) { this._autoValueWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    if (this._showIfWatchers) { this._showIfWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    if (this._readonlyWatchers) { this._readonlyWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this.setupAutoValueWatchers();
    this.setupShowIfWatchers();
    this.setupReadonlyWatchers();
    this._captureProfileDraft(this.form.model_train_type, this.form, defaults);
    this._persistProfileDrafts(r);
    this._persistProfileFieldSources(r);
    const self = this;

    if (self._formWatcher) {
      self._formWatcher();
      self._formWatcher = null;
    }
    self._formWatcher = self.$watch('form', () => {
      self.scheduleStepEstimate();
      self.scheduleOutputPathInfo();
      clearTimeout(self._formSaveTimer);
      self._formSaveTimer = setTimeout(() => {
        self._captureProfileDraft(self._activeTrainType || self.form.model_train_type, self.form);
        self._persistProfileDrafts(r);
        self._persistProfileFieldSources(r);
        try { localStorage.setItem(savedKey, JSON.stringify(self.form)); } catch (e) {}
      }, 1000);
    });

    if (self._trainTypeWatcher) {
      self._trainTypeWatcher();
      self._trainTypeWatcher = null;
    }
    self._trainTypeWatcher = self.$watch('form.model_train_type', (newVal, oldVal) => {
      if (newVal !== oldVal && !self._switchInProgress) {
        self._switchInProgress = true;
        try { self.switchTrainType(newVal); } finally { self._switchInProgress = false; }
      }
    });

    if (self._localeChangeHandler) {
      window.removeEventListener('locale-changed', self._localeChangeHandler);
    }
    self._localeChangeHandler = () => {
      const tt2 = self.trainTypes.find(t => t.v === self.form.model_train_type);
      self.currentTrainTypeDesc = tt2 ? window.t(tt2.dk, tt2.l) : '';
      const activeType = self.form.model_train_type || 'anima-lora';
      self._destroyTrainTypePanelCache();
      self.renderTrainingForm(activeType, null, true);
      self._warmTrainTypePanels(activeType);
      self._trainFormLocale = self.locale;
    };
    window.addEventListener('locale-changed', self._localeChangeHandler);

    // The form may mount before /api/fields returns. Rehydrate missing
    // profile-scoped fields (notably Krea 2) once the authoritative registry
    // arrives instead of leaving the user with the static fallback schema.
    if (self._trainingFieldsLoadedHandler) {
      window.removeEventListener('training-fields-loaded', self._trainingFieldsLoadedHandler);
    }
    self._trainingFieldsLoadedHandler = () => {
      if (!self._trainFormMountedRoute) return;
      self._trainFieldsRevision += 1;
      const activeType = self.form.model_train_type || 'anima-lora';
      const freshDefaults = self._buildFormDefaults(activeType);
      Object.keys(freshDefaults).forEach(key => {
        if (self.form[key] === undefined) {
          self.form[key] = freshDefaults[key];
          self._setFieldSource(key, 'default', activeType);
        }
      });
      self._normalizeProfileSelectValues(activeType, freshDefaults);
      if (activeType === 'krea2-lora') self._applyKrea2ModelDefaults(self.form, freshDefaults);
      self.formDefaults = { ...freshDefaults };
      self._syncKrea2CacheDir();
      self._destroyTrainTypePanelCache();
      self.renderTrainingForm(activeType, null, true);
      self._warmTrainTypePanels(activeType);
      self.setupAutoValueWatchers();
      self.setupShowIfWatchers();
      self.setupReadonlyWatchers();
      self.updateToml();
    };
    window.addEventListener('training-fields-loaded', self._trainingFieldsLoadedHandler);

    // Synchronize the form once from the shared realtime snapshot.
    this.refreshTrainingRealtimeState();
    this.scheduleOutputPathInfo();

    // 非阻塞静默刷新环境状态（faStatus/xfStatus/tritonStatus），
    // 供 renderField 联动提示调用；不 await，不阻塞表单首屏。
    this.faRefresh(true).catch(() => {});
    this.xfRefresh(true).catch(() => {});
    if (typeof this.tritonRefresh === 'function') this.tritonRefresh(true).catch(() => {});

    this.scheduleStepEstimate();
  },

  _stepEstimatePayload() {
    const keys = [
      'model_train_type', 'train_data_dir', 'reg_data_dir', 'dataset_cache_dir', 'resolution', 'enable_bucket',
      'bucket_no_upscale', 'min_bucket_reso', 'max_bucket_reso', 'bucket_reso_steps',
      'krea_num_repeats', 'train_batch_size', 'gradient_accumulation_steps',
      'krea_training_duration_mode', 'max_train_epochs', 'max_train_steps', 'gpu_ids',
    ];
    const payload = {};
    keys.forEach(key => {
      const value = this.form[key];
      if (value !== undefined && value !== null && value !== '') payload[key] = value;
    });
    return payload;
  },

  scheduleStepEstimate() {
    const payload = this._stepEstimatePayload();
    const signature = JSON.stringify(payload);
    if (signature === this._stepEstimateSignature) return;

    this._stepEstimateSignature = signature;
    clearTimeout(this._stepEstimateTimer);
    this._stepEstimateTimer = null;
    const requestSeq = ++this._stepEstimateRequestSeq;

    if (!String(payload.train_data_dir || '').trim()) {
      this.stepEstimate = null;
      this.stepEstimateLoading = false;
      this._setStepEstimateError(
        'stepEstimate.selectDataset',
        'Select a dataset directory to calculate steps'
      );
      return;
    }

    this.stepEstimateLoading = true;
    this.stepEstimateError = null;
    this._stepEstimateTimer = setTimeout(() => {
      this._stepEstimateTimer = null;
      this._requestStepEstimate(requestSeq, payload);
    }, 500);
  },

  async refreshStepEstimate(force) {
    const payload = this._stepEstimatePayload();
    this._stepEstimateSignature = JSON.stringify(payload);
    clearTimeout(this._stepEstimateTimer);
    this._stepEstimateTimer = null;
    const requestSeq = ++this._stepEstimateRequestSeq;

    if (!String(payload.train_data_dir || '').trim()) {
      this.stepEstimate = null;
      this.stepEstimateLoading = false;
      this._setStepEstimateError(
        'stepEstimate.selectDataset',
        'Select a dataset directory to calculate steps'
      );
      return null;
    }

    this.stepEstimateLoading = true;
    this.stepEstimateError = null;
    return this._requestStepEstimate(requestSeq, payload);
  },

  async _requestStepEstimate(requestSeq, payload) {
    try {
      const response = await fetch('/api/training/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (requestSeq !== this._stepEstimateRequestSeq) return null;
      if (!response.ok || result.status !== 'success' || !result.data) {
        this.stepEstimate = null;
        this._setStepEstimateErrorFromResult(result);
        return null;
      }
      this.stepEstimate = result.data;
      this.stepEstimateError = null;
      this._reconcileSubsetTimestepOffsets();
      this._refreshSubsetTimestepEditor();
      return result.data;
    } catch (error) {
      if (requestSeq !== this._stepEstimateRequestSeq) return null;
      this.stepEstimate = null;
      this._setStepEstimateError(
        'stepEstimate.errors.requestFailed',
        'Request failed: {message}',
        { message: error.message }
      );
      return null;
    } finally {
      if (requestSeq === this._stepEstimateRequestSeq) this.stepEstimateLoading = false;
    }
  },

  _stepEstimateText(key, fallback, values) {
    void this.locale;
    let text = this.t(key, fallback);
    Object.entries(values || {}).forEach(([name, value]) => {
      text = text.replaceAll(`{${name}}`, String(value));
    });
    return text;
  },

  _setStepEstimateError(key, fallback, params, localizeLegacy) {
    this.stepEstimateError = {
      key: key || '',
      fallback: fallback || this.t('stepEstimate.failed'),
      params: params && typeof params === 'object' ? params : {},
      localizeLegacy: !!localizeLegacy,
    };
  },

  _localizeLegacyStepEstimateMessage(message) {
    void this.locale;
    const text = String(message || '');
    const separator = ' / ';
    const separatorIndex = text.indexOf(separator);
    if (separatorIndex < 0) return text;
    return this.locale === 'zh-CN'
      ? text.slice(separatorIndex + separator.length)
      : text.slice(0, separatorIndex);
  },

  _setStepEstimateErrorFromResult(result) {
    const errorData = result && result.data && typeof result.data === 'object' ? result.data : {};
    const code = typeof errorData.errorCode === 'string' ? errorData.errorCode : '';
    const params = errorData.errorParams && typeof errorData.errorParams === 'object'
      ? errorData.errorParams
      : {};
    this._setStepEstimateError(
      code ? `stepEstimate.errors.${code}` : '',
      result && result.message
        ? result.message
        : this.t('stepEstimate.failed'),
      params,
      !code
    );
  },

  stepEstimateErrorText() {
    const error = this.stepEstimateError;
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (!error.key) {
      const fallback = error.fallback || this.t('stepEstimate.failed');
      return error.localizeLegacy ? this._localizeLegacyStepEstimateMessage(fallback) : fallback;
    }
    return this._stepEstimateText(error.key, error.fallback, error.params);
  },

  _outputPathPayload() {
    return {
      path: String(this.form.output_dir || './output').trim() || './output',
      outputName: String(this.form.output_name || 'my_lora').trim() || 'my_lora',
      resume: !!String(this.form.resume || '').trim(),
    };
  },

  scheduleOutputPathInfo() {
    const payload = this._outputPathPayload();
    const signature = JSON.stringify(payload);
    if (signature === this._outputPathInfoSignature) return;
    this._outputPathInfoSignature = signature;
    clearTimeout(this._outputPathInfoTimer);
    this._outputPathInfoTimer = null;
    const requestSeq = ++this._outputPathInfoRequestSeq;
    this.outputPathInfo = null;
    this.outputPathInfoLoading = true;
    this.outputPathInfoError = '';
    this._outputPathInfoTimer = setTimeout(() => {
      this._outputPathInfoTimer = null;
      this._requestOutputPathInfo(requestSeq, payload);
    }, 350);
  },

  async refreshOutputPathInfo(force) {
    const payload = this._outputPathPayload();
    const signature = JSON.stringify(payload);
    if (!force && signature === this._outputPathInfoSignature && this.outputPathInfo && !this.outputPathInfoLoading) {
      return this.outputPathInfo;
    }
    this._outputPathInfoSignature = signature;
    clearTimeout(this._outputPathInfoTimer);
    this._outputPathInfoTimer = null;
    const requestSeq = ++this._outputPathInfoRequestSeq;
    this.outputPathInfo = null;
    this.outputPathInfoLoading = true;
    this.outputPathInfoError = '';
    return this._requestOutputPathInfo(requestSeq, payload);
  },

  async _requestOutputPathInfo(requestSeq, payload) {
    const params = new URLSearchParams({
      path: payload.path,
      output_name: payload.outputName,
      resume: payload.resume ? 'true' : 'false',
    });
    try {
      const response = await fetch('/api/training/output-path-info?' + params.toString());
      const result = await response.json();
      if (requestSeq !== this._outputPathInfoRequestSeq) return null;
      if (!response.ok || result.status !== 'success' || !result.data) {
        this.outputPathInfo = null;
        this.outputPathInfoError = (result.data && result.data.errorCode) || 'invalidOutputPath';
        return null;
      }
      this.outputPathInfo = result.data;
      this.outputPathInfoError = '';
      return result.data;
    } catch (error) {
      if (requestSeq !== this._outputPathInfoRequestSeq) return null;
      this.outputPathInfo = null;
      this.outputPathInfoError = 'requestFailed';
      return null;
    } finally {
      if (requestSeq === this._outputPathInfoRequestSeq) this.outputPathInfoLoading = false;
    }
  },

  outputPathStatusClass() {
    const info = this.outputPathInfo;
    if (this.outputPathInfoError || (info && (!info.available || !info.writable || info.path_is_directory === false))) {
      return 'is-error';
    }
    return 'is-custom';
  },

  outputPathHintVisible() {
    const info = this.outputPathInfo;
    if (this.outputPathInfoError) return true;
    if (!info) return false;
    if (!info.available || !info.writable || info.path_is_directory === false) return true;
    return !info.is_default;
  },

  outputPathSummaryText() {
    const info = this.outputPathInfo;
    if (this.outputPathInfoError === 'invalidOutputPath') {
      return this.t('training.outputPathInvalid');
    }
    if (this.outputPathInfoError) {
      return this.t('training.outputPathCheckFailed');
    }
    if (!info) return '';
    if (info.path_exists && info.path_is_directory === false) {
      return this.t('training.outputPathNotDirectory');
    }
    if (!info.available) {
      return this.t('training.outputPathUnavailable');
    }
    if (!info.writable) {
      return this.t('training.outputPathNotWritable');
    }
    if (info.is_default) return '';
    return this.t(
      'training.outputPathCustomSummary');
  },

  outputPathBlockingText() {
    return this.outputPathSummaryText() || this.t('training.outputPathCheckFailed');
  },

  stepEstimateTitle() {
    if (!this.stepEstimate) return '';
    return this._stepEstimateText('stepEstimate.total', undefined, {
      steps: this.stepEstimate.total_steps,
    });
  },

  _formatSubsetTerms(subset) {
    const dist = subset.repeat_dist && subset.repeat_dist.length ? subset.repeat_dist : [[subset.repeats, subset.image_count]];
    return dist.map(([repeats, count]) => this._stepEstimateText(
      'stepEstimate.imageTerm', undefined,
      { images: count, repeats }
    )).join(' + ');
  },

  stepEstimateImageFormula() {
    if (!this.stepEstimate) return '';
    const train = (this.stepEstimate.subsets || []).filter(subset => !subset.is_reg);
    const trainImages = train.reduce((sum, subset) => sum + subset.image_count, 0);
    const trainSamples = train.reduce((sum, subset) => sum + subset.sample_count, 0);
    const trainTerms = train.map(subset => this._formatSubsetTerms(subset)).join(' + ');
    return this._stepEstimateText(
      'stepEstimate.imageFormula', undefined,
      { trainImages, trainTerms, trainSamples }
    );
  },

  stepEstimateRegFormula() {
    if (!this.stepEstimate) return '';
    const reg = (this.stepEstimate.subsets || []).filter(subset => subset.is_reg);
    if (!reg.length) return '';
    const regImages = reg.reduce((sum, subset) => sum + subset.image_count, 0);
    const regSamples = reg.reduce((sum, subset) => sum + subset.sample_count, 0);
    const unused = reg.reduce((sum, subset) => sum + (subset.unused_images || 0), 0);
    const regTerms = reg.map(subset => this._formatSubsetTerms(subset)).join(' + ');
    const unusedNote = unused > 0
      ? this._stepEstimateText('stepEstimate.regUnusedNote', undefined, { unused })
      : '';
    return this._stepEstimateText(
      'stepEstimate.regFormula', undefined,
      { regImages, regTerms, regSamples, unusedNote }
    );
  },

  stepEstimateBatchFormula() {
    const estimate = this.stepEstimate;
    if (!estimate) return '';
    if (estimate.enable_bucket) {
      return this._stepEstimateText(
        'stepEstimate.bucketFormula', undefined,
        {
          samples: estimate.repeated_samples,
          buckets: estimate.bucket_count,
          batch: estimate.batch_size,
          batches: estimate.batches_per_epoch,
        }
      );
    }
    return this._stepEstimateText(
      'stepEstimate.batchFormula', undefined,
      {
        samples: estimate.repeated_samples,
        batch: estimate.batch_size,
        batches: estimate.batches_per_epoch,
      }
    );
  },

  stepEstimateEpochFormula() {
    const estimate = this.stepEstimate;
    if (!estimate) return '';
    const key = estimate.gpu_processes > 1 ? 'stepEstimate.epochFormulaMultiGpu' : 'stepEstimate.epochFormula';
    const fallback = estimate.gpu_processes > 1
      ? 'Batch {batch} × accumulation {accumulation} × {gpus} GPUs = effective Batch {effectiveBatch}; per epoch: ⌈{batches} batches ÷ {gpus} GPUs ÷ accumulation {accumulation}⌉ = {steps} steps'
      : 'Batch {batch} × accumulation {accumulation} = effective Batch {effectiveBatch}; per epoch: ⌈{batches} batches ÷ accumulation {accumulation}⌉ = {steps} steps';
    return this._stepEstimateText(key, fallback, {
      batch: estimate.batch_size,
      batches: estimate.batches_per_epoch,
      gpus: estimate.gpu_processes,
      accumulation: estimate.gradient_accumulation_steps,
      effectiveBatch: estimate.batch_size * estimate.gradient_accumulation_steps * estimate.gpu_processes,
      steps: estimate.steps_per_epoch,
    });
  },

  stepEstimateTotalFormula() {
    const estimate = this.stepEstimate;
    if (!estimate) return '';
    return this._stepEstimateText(
      'stepEstimate.totalFormula', undefined,
      { steps: estimate.steps_per_epoch, epochs: estimate.epochs, total: estimate.total_steps }
    );
  },

  renderStepEstimatePanel() {
    return `<div class="step-estimate-panel" :class="{ 'is-loading': stepEstimateLoading, 'is-error': !!stepEstimateError }">
      <div class="step-estimate-head">
        <div class="step-estimate-heading">
          <span class="step-estimate-label" x-text="t('stepEstimate.label')"></span>
          <strong class="step-estimate-total" x-show="stepEstimate" x-text="stepEstimateTitle()"></strong>
          <span class="step-estimate-status" x-show="!stepEstimate && stepEstimateLoading" x-text="t('stepEstimate.calculating')"></span>
          <span class="step-estimate-status step-estimate-status-error" x-show="!stepEstimate && !stepEstimateLoading" x-text="stepEstimateErrorText()"></span>
        </div>
        <button type="button" class="step-estimate-refresh" @click="refreshStepEstimate(true)" :disabled="stepEstimateLoading" :title="t('stepEstimate.recalculate')" :aria-label="t('stepEstimate.recalculate')">
          <svg :class="{ spinning: stepEstimateLoading }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg>
        </button>
      </div>
      <div class="step-estimate-formula" x-show="stepEstimate">
        <div class="step-estimate-line"><span class="step-estimate-number">1</span><span x-text="stepEstimateImageFormula()"></span></div>
        <div class="step-estimate-line" x-show="stepEstimateRegFormula()"><span class="step-estimate-number">2</span><span x-text="stepEstimateRegFormula()"></span></div>
        <div class="step-estimate-line"><span class="step-estimate-number">3</span><span x-text="stepEstimateBatchFormula()"></span></div>
        <div class="step-estimate-line"><span class="step-estimate-number">4</span><span x-text="stepEstimateEpochFormula()"></span></div>
        <div class="step-estimate-line step-estimate-line-total"><span class="step-estimate-number">5</span><span x-text="stepEstimateTotalFormula()"></span></div>
        <div class="step-estimate-note" x-text="t('stepEstimate.sdScriptsNote')"></div>
      </div>
    </div>`;
  },

  _mutateTrainingPanels(callback) {
    const alpine = window.Alpine;
    if (alpine && typeof alpine.mutateDom === 'function') {
      alpine.mutateDom(callback);
    } else {
      callback();
    }
  },

  _destroyTrainTypePanelCache() {
    if (!(this._trainTypePanelCache instanceof Map)) {
      this._trainTypePanelCache = null;
      return;
    }
    const alpine = window.Alpine;
    this._mutateTrainingPanels(() => {
      this._trainTypePanelCache.forEach(panel => {
        if (alpine && typeof alpine.destroyTree === 'function') {
          Array.from(panel.children).forEach(child => alpine.destroyTree(child));
        }
        panel.remove();
      });
    });
    this._trainTypePanelCache.clear();
    this._trainTypePanelCache = null;
  },

  _activateTrainTypePanel(root, trainType) {
    if (!(this._trainTypePanelCache instanceof Map)) this._trainTypePanelCache = new Map();

    // 兼容热更新前已直接渲染在根容器中的旧结构。
    const legacyChildren = Array.from(root.children).filter(
      child => !child.classList.contains('train-type-panel')
    );
    if (legacyChildren.length > 0) {
      this._replaceTrainingFormHtml(root, '');
      this._trainTypePanelCache.clear();
    }

    const activePanel = root.querySelector(':scope > .train-type-panel');

    let panel = this._trainTypePanelCache.get(trainType);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'train-type-panel';
      panel.dataset.trainType = trainType;
      this._trainTypePanelCache.set(trainType, panel);
    }
    this._mutateTrainingPanels(() => {
      if (activePanel && activePanel !== panel) activePanel.remove();
      if (panel.parentElement !== root) root.appendChild(panel);
    });
    return panel;
  },

  _warmTrainTypePanels(activeType) {
    const root = document.getElementById('trainFormContent');
    if (!root) return;
    const originalForm = this.form;
    const originalDefaults = this.formDefaults;
    const originalActiveType = this._activeTrainType;

    this.trainTypes.forEach(({ v: trainType }) => {
      if (trainType === activeType || this._trainTypePanelIsReady(trainType)) return;
      const defaults = this._buildFormDefaults(trainType);
      const warmForm = this._profileFormFromDraft(trainType, defaults);
      if (trainType === 'krea2-lora') {
        this._applyKrea2ModelDefaults(warmForm, defaults);
        const cacheDir = this._deriveKrea2CacheDir(warmForm.train_data_dir);
        warmForm.dataset_cache_dir = cacheDir;
        defaults.dataset_cache_dir = cacheDir;
      }
      this._normalizeProfileSelectValues(trainType, defaults, warmForm);
      warmForm.network_module = trainType === 'anima-lora'
        ? 'networks.lora_anima'
        : (trainType === 'krea2-lora' ? 'networks.lora_krea2' : 'networks.lora');
      this.form = warmForm;
      this.formDefaults = { ...defaults };
      this._activeTrainType = trainType;
      this.renderTrainingForm(trainType, null, true);
    });

    this.form = originalForm;
    this.formDefaults = originalDefaults;
    this._activeTrainType = originalActiveType;
    this.renderTrainingForm(activeType, null);
  },

  renderTrainingForm(trainType, targetId, force = false) {
    const root = document.getElementById(targetId || 'trainFormContent');
    if (!root) return;
    const activeType = trainType || this.form.model_train_type || 'anima-lora';
    const container = targetId ? root : this._activateTrainTypePanel(root, activeType);

    if (!targetId && !force && this._trainTypePanelIsReady(activeType)) {
      this._nestLevelCache = null;
      this.buildSectionNav();
      this._syncAllConditionalFields();
      return;
    }
    const sections = window.getVisibleSections(activeType);
    // 失效嵌套层级缓存（字段集随训练类型变化）
    this._nestLevelCache = null;
    this._initCollapseState(sections);
    let html = '';
      sections.forEach(section => {
      const visibleFields = section.fields.filter(f => !f.hidden);
      const allFields = this._orderFieldsByDependencies(visibleFields);
      // 拆分：常规字段（无 subGroup）与 kohya 子组字段
      const regularFields = allFields.filter(f => !f.subGroup);
      const subGroupFields = allFields.filter(f => f.subGroup);
      // 子组字段按 subGroup 值分组
      const subGroups = new Map();
      subGroupFields.forEach(f => {
        const sg = f.subGroup;
        if (!subGroups.has(sg)) subGroups.set(sg, []);
        subGroups.get(sg).push(f);
      });

      html += `<div class="card" data-section="${section.key}" :class="{ 'card-collapsed': _sectionCollapsed['${section.key}'] }">`;
      html += `<div class="card-header" @click="toggleSection('${section.key}')">`;
      html += `<svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
      html += `<span>${this.t(section.titleKey) || section.titleKey}</span>`;
      html += `</div>`;
      html += `<div class="card-body">`;
      if (section.key === 'training' && !targetId) html += this.renderStepEstimatePanel();

      // 按 FIELDS 顺序渲染常规字段和条件子组。
      const doneSubGroups = new Set();
      allFields.forEach(f => {
        if (f.subGroup) {
          if (!doneSubGroups.has(f.subGroup)) {
            doneSubGroups.add(f.subGroup);
            const sg = subGroups.get(f.subGroup) || [];
            // 子组公共显隐条件：取该子组字段的 showIf/showIfAny 中 network_module 的 eq 值。
            // kohya 子组所有字段 showIf 均含 network_module eq lycoris.kohya，整个子区块跟随它显隐。
            const conditionalField = sg.find(field => field.showIf || field.showIfAny);
            const sgShowIf = conditionalField && (conditionalField.showIf || conditionalField.showIfAny);
            let sgCondMet = true;
            let sgShowIfAttrs = '';
            if (sgShowIf) {
              // 提取 network_module eq 作为容器显隐条件（单条件或数组第一个含 network_module 的条件）
              const conds = Array.isArray(sgShowIf) ? sgShowIf : [sgShowIf];
              const nmCond = conds.find(c => c.key === 'network_module');
              if (nmCond) {
                sgCondMet = this._evalShowIfCond(nmCond);
                sgShowIfAttrs = ` data-show-if-key="network_module" data-show-if-eq="${this.escapeAttr(String(nmCond.eq))}"`;
              }
            }
            const sgBlockHidden = sgCondMet ? '' : ' field-hidden';
            const sgTitleKey = (f.subGroup === 'kohya') ? 'common.lycorisSubgroupTitle' : '';
            const sgTitle = sgTitleKey ? this.t(sgTitleKey) : f.subGroup;
            html += `<div class="subgroup-block${sgBlockHidden}"${sgShowIfAttrs}>`;
            html += `<div class="subgroup-header"><span class="subgroup-dot"></span><span>${this.esc(sgTitle)}</span></div>`;
            html += `<div class="subgroup-body">`;
            sg.forEach(field => { html += this.renderField(field); });
            html += `</div></div>`;
          }
        } else {
          html += this.renderField(f);
          if (f.key === 'mode_scale') html += this.renderSubsetTimestepOffsets();
        }
      });

      html += `</div></div>`;
    });
    this._replaceTrainingFormHtml(container, html);
    if (!targetId) {
      container.setAttribute('data-panel-ready', '1');
      container.dataset.panelLocale = String(this.locale || '');
      container.dataset.fieldsRevision = String(this._trainFieldsRevision || 0);
    }
    // 构建右侧分组导航指示器（#1）并绑定滚动高亮
    this.buildSectionNav();
    // 整张表单刚重建时一次性同步全部条件字段。旧实现按每个条件 key
    // 重复扫描 DOM、重算计数和生成 TOML，训练类型切换时会产生明显卡顿。
    this._syncAllConditionalFields();
  },

  _replaceTrainingFormHtml(container, html) {
    const alpine = window.Alpine;
    if (!alpine || typeof alpine.mutateDom !== 'function'
        || typeof alpine.destroyTree !== 'function' || typeof alpine.initTree !== 'function') {
      container.innerHTML = html;
      return;
    }

    // 直接 innerHTML 会让旧表单的 Alpine effects、全局事件和节点引用滞留，
    // 连续切换时 detached DOM 快速累积。先逐棵销毁，再在暂停 MutationObserver
    // 的受控更新中插入并手动初始化新树。
    alpine.mutateDom(() => {
      Array.from(container.children).forEach(child => alpine.destroyTree(child));
      container.innerHTML = html;
      Array.from(container.children).forEach(child => alpine.initTree(child));
    });
  },

  _orderFieldsByDependencies(fields) {
    const keys = new Set(fields.map(field => field.key));
    const fieldsByKey = new Map(fields.map(field => [field.key, field]));
    const children = new Map();
    const roots = [];

    fields.forEach(field => {
      const parent = this._fieldLayoutParentKey(field, keys);
      const parentField = fieldsByKey.get(parent);
      if (!parent || parent === field.key || parentField?.keepChildrenPosition) {
        roots.push(field);
        return;
      }
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(field);
    });

    const ordered = [];
    const visited = new Set();
    const append = field => {
      if (visited.has(field.key)) return;
      visited.add(field.key);
      ordered.push(field);
      (children.get(field.key) || []).forEach(append);
    };
    roots.forEach(append);
    fields.forEach(append);
    return ordered;
  },

  _fieldLayoutParentKey(field, availableKeys = null) {
    if (!field || field.nested === false) return null;
    const accepted = key => key && (!availableKeys || availableKeys.has(key));
    if (accepted(field.layoutParent)) return field.layoutParent;
    if (field.showIf && !Array.isArray(field.showIf)) {
      return accepted(field.showIf.key) ? field.showIf.key : null;
    }
    if (Array.isArray(field.showIf)) {
      for (let index = field.showIf.length - 1; index >= 0; index -= 1) {
        const key = field.showIf[index] && field.showIf[index].key;
        if (accepted(key)) return key;
      }
    }
    if (Array.isArray(field.showIfAny)) {
      for (const group of field.showIfAny) {
        if (!Array.isArray(group)) continue;
        for (let index = group.length - 1; index >= 0; index -= 1) {
          const key = group[index] && group[index].key;
          if (accepted(key)) return key;
        }
      }
    }
    return null;
  },

  // ── Section collapse state ──
  _initCollapseState(sections) {
    if (!this._sectionCollapsed) this._sectionCollapsed = {};
    sections.forEach(s => {
      if (this._sectionCollapsed[s.key] === undefined) {
        this._sectionCollapsed[s.key] = localStorage.getItem('anima-section-collapsed-' + s.key) === '1';
      }
    });
  },

  toggleSection(key) {
    const willCollapse = !this._sectionCollapsed[key];
    this._sectionCollapsed[key] = willCollapse;
    localStorage.setItem('anima-section-collapsed-' + key, willCollapse ? '1' : '0');
    // 同步导航指示器的折叠状态
    this.sectionNavList = this.sectionNavList.map(s => s.key === key ? { ...s, collapsed: willCollapse } : s);
    // 动画：测量 card-body 真实高度 → 锁定 → 过渡到 0/原高
    const card = document.querySelector(`#trainFormContent .card[data-section="${this.escapeAttr(key)}"]`);
    const body = card && card.querySelector('.card-body');
    if (body) this._animateCollapse(body, willCollapse);
  },

  // ── 统一的高度折叠动画（#3）──
  // 测量目标 scrollHeight → 起始高度 → 过渡到目标 → 清理 inline 样式。
  // 与 showConditionalFields 同一手法，避免 max-height:0!important/none 无法动画的问题。
  _animateCollapse(body, collapsing) {
    // 清理可能残留的过渡状态
    body.style.transition = 'none';
    body.style.maxHeight = '';
    body.style.opacity = '';
    const h = body.scrollHeight;
    if (collapsing) {
      // 收起：从当前高度 → 0
      body.style.overflow = 'hidden';
      body.style.maxHeight = h + 'px';
      body.style.opacity = '1';
      void body.offsetHeight; // 强制 reflow
      body.style.transition = '';
      requestAnimationFrame(() => {
        body.style.maxHeight = '0px';
        body.style.opacity = '0';
      });
      const cleanup = () => {
        body.style.maxHeight = '';
        body.style.opacity = '';
        body.style.transition = '';
        body.style.overflow = '';
        body.removeEventListener('transitionend', onEnd);
      };
      const onEnd = (e) => { if (e.propertyName === 'max-height') cleanup(); };
      body.addEventListener('transitionend', onEnd);
      setTimeout(cleanup, 500);
    } else {
      // 展开：从 0 → 目标高度
      body.style.overflow = 'hidden';
      body.style.maxHeight = '0px';
      body.style.opacity = '0';
      void body.offsetHeight;
      body.style.transition = '';
      requestAnimationFrame(() => {
        body.style.maxHeight = h + 'px';
        body.style.opacity = '1';
      });
      const cleanup = () => {
        body.style.maxHeight = '';
        body.style.opacity = '';
        body.style.transition = '';
        body.style.overflow = '';
        body.removeEventListener('transitionend', onEnd);
      };
      const onEnd = (e) => { if (e.propertyName === 'max-height') cleanup(); };
      body.addEventListener('transitionend', onEnd);
      setTimeout(cleanup, 500);
    }
  },

  // ── 分组导航指示器（#1）──
  // 构建可见分组列表（含颜色 + 标题），供右侧面板点击跳转与当前分组高亮。
  buildSectionNav() {
    const sections = this._allSections();
    const SECTION_COLORS = {
      model: 'var(--section-model)', network: 'var(--section-network)',
      training: 'var(--section-training)', optimizer: 'var(--section-optimizer)',
      regularization: 'var(--section-regularization)', performance: 'var(--section-performance)',
      save: 'var(--section-save)', caption: 'var(--section-caption)',
      preview: 'var(--section-preview)', misc: 'var(--section-caption)',
    };
    this.sectionNavList = sections.map(s => ({
      key: s.key,
      title: this.t(s.titleKey) || s.titleKey,
      color: SECTION_COLORS[s.key] || 'var(--section-caption)',
      collapsed: !!this._sectionCollapsed[s.key],
    }));
    // 默认激活第一个分组
    if (this.sectionNavList.length && !this.activeSection) {
      this.activeSection = this.sectionNavList[0].key;
    }
    this._bindSectionScroll();
    this._bindSectionMouse();
    this._bindSidebarResize();
  },

  // 绑定主内容区滚动监听，更新当前可见分组（节流）
  _bindSectionScroll() {
    if (this._sectionScrollHandler) return; // 已绑定
    const self = this;
    let ticking = false;
    this._sectionScrollHandler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        self._updateActiveSection();
        ticking = false;
      });
    };
    const scroller = document.querySelector('.main-content');
    if (scroller) scroller.addEventListener('scroll', this._sectionScrollHandler, { passive: true });
    // 初次定位
    this._updateActiveSection();
  },

  // 鼠标进入分组时更新对应圆点，不读取整页卡片布局。
  _bindSectionMouse() {
    if (this._sectionMouseHandler) return;
    this._sectionMouseHandler = (e) => {
      const card = e.target.closest && e.target.closest('#trainFormContent .card[data-section]');
      if (!card) return;
      const section = card.getAttribute('data-section');
      if (section && section !== this.activeSection) this.activeSection = section;
    };
    const scroller = document.querySelector('.main-content');
    if (scroller) scroller.addEventListener('pointerover', this._sectionMouseHandler, { passive: true });
  },

  // 离开训练页时解绑滚动/鼠标/侧栏监听，避免泄漏
  stopSectionScroll() {
    if (this._sectionScrollHandler) {
      const scroller = document.querySelector('.main-content');
      if (scroller) scroller.removeEventListener('scroll', this._sectionScrollHandler);
      this._sectionScrollHandler = null;
    }
    if (this._sectionMouseHandler) {
      const scroller = document.querySelector('.main-content');
      if (scroller) scroller.removeEventListener('pointerover', this._sectionMouseHandler);
      this._sectionMouseHandler = null;
    }
    if (this._sidebarResizeObserver) {
      this._sidebarResizeObserver.disconnect();
      this._sidebarResizeObserver = null;
    }
    if (this._sidebarResizeHandler) {
      window.removeEventListener('resize', this._sidebarResizeHandler);
      this._sidebarResizeHandler = null;
    }
  },

  // 监听侧栏宽度变化（手动收起/展开、响应式、初始），实时更新 rail 的 left，
  // 使指示器始终贴在 main-content 左边缘。不依赖 --sidebar-w（手动收起不改该变量）。
  _bindSidebarResize() {
    if (this._sidebarResizeObserver) return;
    const self = this;
    const update = () => self._updateRailLeft();
    // ResizeObserver 监听 .sidebar 宽度
    const sidebar = document.querySelector('.sidebar');
    if (sidebar && typeof ResizeObserver !== 'undefined') {
      this._sidebarResizeObserver = new ResizeObserver(update);
      this._sidebarResizeObserver.observe(sidebar);
    }
    // 窗口尺寸变化（响应式断点）兜底
    window.addEventListener('resize', update);
    this._sidebarResizeHandler = update;
    // 初次定位
    this._updateRailLeft();
  },

  _updateRailLeft() {
    const sidebar = document.querySelector('.sidebar');
    const rail = document.querySelector('.section-rail');
    if (!sidebar || !rail) return;
    const w = sidebar.getBoundingClientRect().width;
    rail.style.left = Math.round(w + 10) + 'px';
  },

  _updateActiveSection() {
    const scroller = document.querySelector('.main-content');
    if (!scroller) return;
    const offset = 80; // 顶部偏移阈值：分组标题进入此线以下即视为"当前"
    const cards = document.querySelectorAll('#trainFormContent .card[data-section]');
    let current = '';
    cards.forEach(card => {
      const rect = card.getBoundingClientRect();
      // 标题顶部越过偏移线 → 该分组为当前；取最后一个满足条件的
      if (rect.top - scroller.getBoundingClientRect().top <= offset) {
        current = card.getAttribute('data-section');
      }
    });
    if (!current && cards.length) current = cards[0].getAttribute('data-section');
    // 仅更新轨道圆点高亮（activeSection），不再给表单卡片加激活态样式
    if (current && current !== this.activeSection) this.activeSection = current;
  },

  // 点击导航项 → 平滑滚动到对应分组顶部
  scrollToSection(key) {
    const card = document.querySelector(`#trainFormContent .card[data-section="${this.escapeAttr(key)}"]`);
    const scroller = document.querySelector('.main-content');
    if (!card || !scroller) return;
    // 若分组已收起，先展开（否则跳过去看不到内容）
    if (this._sectionCollapsed[key]) this.toggleSection(key);
    const target = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    this.activeSection = key;
  },

  _allSections() {
    return window.getVisibleSections(this.form.model_train_type || 'anima-lora');
  },

  _allShowIfKeys() {
    const keys = new Set();
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.showIf) {
        if (Array.isArray(f.showIf)) {
          f.showIf.forEach(c => keys.add(c.key));
        } else {
          keys.add(f.showIf.key);
        }
      }
      if (f.showIfAny) {
        // OR-of-ANDs: list[list[dict]] — 收集每个内层 AND 组里的所有 key
        f.showIfAny.forEach(group => group.forEach(c => keys.add(c.key)));
      }
    }));
    return [...keys];
  },

  // Evaluate a single show_if condition dict (used by both single and multi-condition)
  _evalShowIfCond(c) {
    const pv = this.form[c.key];
    if (c.eq !== undefined) {
      if (String(pv) === String(c.eq)) return true;
      if (c.or && Array.isArray(c.or)) return c.or.some(function(v) { return String(pv) === String(v); });
      return false;
    }
    if (c.neq !== undefined) {
      return String(pv) !== String(c.neq) && pv !== null && pv !== undefined && pv !== '';
    }
    return true;
  },

  _numberConstraints(field) {
    if (!field) return {};
    const group = window.TRAIN_GROUP_MAP[this.form.model_train_type || 'anima-lora'] || 'all';
    return { ...field, ...((field.constraintsByGroup || {})[group] || {}) };
  },

  _optimizerAutoValueMap(field, trainType = this.form.model_train_type || 'anima-lora') {
    const map = {};
    const rules = field && Array.isArray(field.autoValue) ? field.autoValue : [];
    rules.forEach(rule => {
      let optimizer = null;
      if (rule.watch && typeof rule.watch === 'object' && !Array.isArray(rule.watch)) {
        const watch = rule.watch;
        if (watch.model_train_type && String(watch.model_train_type) !== String(trainType)) return;
        const extraKeys = Object.keys(watch).filter(key => key !== 'optimizer_type' && key !== 'model_train_type');
        if (extraKeys.length > 0 || !watch.optimizer_type) return;
        optimizer = watch.optimizer_type;
      } else if (rule.watch === 'optimizer_type') {
        optimizer = rule.when;
      }
      if (optimizer === null || optimizer === undefined || rule.set === null || rule.set === undefined) return;
      if (!Object.prototype.hasOwnProperty.call(map, optimizer)) map[optimizer] = rule.set;
    });
    return map;
  },

  _fieldDefinition(fieldKey, trainType = this.form.model_train_type || 'anima-lora') {
    const sections = window.getVisibleSections
      ? window.getVisibleSections(trainType)
      : (window.TRAIN_SECTIONS || []);
    for (const section of sections) {
      const field = (section.fields || []).find(item => item.key === fieldKey);
      if (field) return field;
    }
    return null;
  },

  _resolveFieldHintKey(field, values, trainType) {
    if (!field) return '';
    const hintBy = field.hintKeyBy;
    if (hintBy && hintBy.key && hintBy.values) {
      const selected = values ? values[hintBy.key] : undefined;
      const dynamicKey = hintBy.values[String(selected)];
      if (dynamicKey) return dynamicKey;
    }
    if (!field.hintKey) return '';
    const suffix = trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : '');
    if (suffix) {
      const specificKey = field.hintKey + suffix;
      const specific = this.t(specificKey);
      if (specific && specific !== specificKey) return specificKey;
    }
    return field.hintKey;
  },

  _resolveFieldHintText(field, values, trainType) {
    const key = this._resolveFieldHintKey(field, values, trainType);
    return key ? this.t(key) : '';
  },

  fieldHintText(fieldKey) {
    const trainType = this.form.model_train_type || 'anima-lora';
    return this._resolveFieldHintText(
      this._fieldDefinition(fieldKey, trainType),
      this.form,
      trainType
    );
  },


  renderField(field) {
    const val = this.form[field.key];
    const trainType = this.form.model_train_type || 'anima-lora';
    const trainTypeSuffix = trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : '');

    // Try train-type-specific desc key first, then fall back to default
    // Only use if the i18n key actually exists (to avoid showing "field.qwen3_anima" etc.)
    const descKeyWithSuffix = field.descKey + trainTypeSuffix;
    const specificLabel = this.t(descKeyWithSuffix);
    const hasSpecificLabel = specificLabel && specificLabel !== descKeyWithSuffix;
    const label = hasSpecificLabel ? specificLabel : (this.t(field.descKey) || field.descKey || field.key);
    const hint = this._resolveFieldHintText(field, this.form, trainType);
    const docLink = field.docSlug
      ? `<button type="button" class="field-doc-link" @click.stop="openParameterDoc('${this.escapeAttr(field.docSlug)}','${this.escapeAttr(field.docAnchor || '')}')" title="${this.escapeAttr(this.t('docs.openGuide'))}" aria-label="${this.escapeAttr(this.t('docs.openGuide'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg><span>${this.esc(this.t('docs.openGuide'))}</span></button>`
      : '';
    const currentGroup = window.TRAIN_GROUP_MAP[this.form.model_train_type || 'anima-lora'] || 'all';
    let isRequired = field.required;
    if (!isRequired && field.requiredGroups && Array.isArray(field.requiredGroups)) {
      isRequired = field.requiredGroups.includes(currentGroup);
    }
    const requiredMark = isRequired ? '<span class="field-required" aria-hidden="true">*</span>' : '';
    const dataKey = field.key;
    const isToggle = field.type === 'toggle';
    const isStaticReadonly = field.readonly === true;
    const staticReadonlyAttrs = isStaticReadonly ? ' readonly aria-readonly="true"' : '';
    // Text/textarea/path fields get their input on a separate row (full-width)
    const isFullWidth = field.type === 'textarea' || (field.role && field.role.startsWith('file-'));

    // ── Generate input HTML ──
    let inputHtml = '';
    if (isToggle) {
      inputHtml = `<label class="toggle"><input type="checkbox" :checked="form.${dataKey}" @change="setField('${dataKey}', $event.target.checked)"><span class="toggle-track"><span class="toggle-thumb"></span></span></label>`;
    } else if (field.type === 'select') {
      const fc = {};
      const self = this;
      const currentTrainType = this.form.model_train_type || 'anima-lora';
      const currentGroup = window.TRAIN_GROUP_MAP[currentTrainType] || 'all';

      const resolveOption = (o) => {
        const cloned = { v: o.v, l: o.l };
        if (o.dKey) { cloned.d = self.t(o.dKey); }
        else if (o.d) { cloned.d = o.d; }
        return cloned;
      };

      // Filter options by group compatibility
      const filterByGroup = (opts) => {
        return (opts || []).filter(o => {
          if (!o.group || o.group === 'all') return true;
          if (Array.isArray(o.group)) return o.group.includes(currentGroup);
          return o.group === currentGroup;
        }).map(o => resolveOption(o));
      };

      if (field.groups && field.groups.length) {
        fc.groups = field.groups.map(g => ({
          label: g.labelKey ? (self.t(g.labelKey) || g.label) : (g.label || ''),
          options: filterByGroup(g.options)
        })).filter(g => g.options.length > 0);
      } else if (field.options && field.options.length) {
        fc.options = filterByGroup(field.options);
      } else {
        fc.options = [];
      }
      const triggerHtml = `<button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="toggle($event)"><span class="anima-select-trigger-text" x-text="selectedLabel"></span><svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg></button>`;
      const menuHtml = `<template x-if="open"><div class="anima-select-menu" :class="{ 'anima-select-menu-described': hasDescriptions, 'anima-select-menu-positioned': positioned }" x-init="$nextTick(() => positionMenu())"><div class="anima-select-menu-scroll"><template x-for="(group, gIdx) in displayGroups" :key="gIdx"><div class="anima-select-group"><div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div><template x-for="opt in group.options" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)"><span class="anima-select-option-content"><span class="anima-select-option-label" x-text="opt.l" :title="opt.l"></span><span class="anima-select-option-desc" x-show="opt.d" x-text="opt.d"></span></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div></template></div></template><div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div></div></div></template>`;
      inputHtml = `<div class="anima-select" x-data="animaSelect('${this.escJson(fc)}', '${this.escapeAttr(val ?? '')}')" @click.outside="closeOnOutside()" @anima-select-change="setField('${dataKey}', $event.detail.value)"><input type="hidden" x-ref="modelInput" :value="form.${dataKey}">${triggerHtml}${menuHtml}</div>`;
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" rows="3"${staticReadonlyAttrs}></textarea>`;
      if (dataKey === "positive_prompts") {
        inputHtml += this._positivePromptCountHint(dataKey);
      }
    } else if (field.type === 'stepper' || field.type === 'number') {
      const constraints = this._numberConstraints(field);
      const sStep = constraints.step || 1;
      const numberAttrs = `${constraints.min !== undefined ? ` min="${this.escapeAttr(constraints.min)}"` : ''}${constraints.max !== undefined ? ` max="${this.escapeAttr(constraints.max)}"` : ''} step="${this.escapeAttr(sStep)}"`;
      inputHtml = `<div class="stepper"><button type="button" @click="stepField('${dataKey}', -${sStep})">−</button><input type="number" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"${numberAttrs}${staticReadonlyAttrs}><button type="button" @click="stepField('${dataKey}', ${sStep})">+</button></div>`;
    } else {
      // Text input: dynamic placeholder for optimizer merged fields (reactive via Alpine)
      // Values sourced from window.OPTIMIZER_DEFAULTS (single source of truth in constants.js)
      const _OPT_PH = window.OPTIMIZER_DEFAULTS || {};
      const _phMap = _OPT_PH[dataKey];
      if (_phMap) {
        // Dynamic placeholder that updates when optimizer_type changes
        const _phExpr = JSON.stringify(_phMap).replace(/"/g, '&quot;');
        const _animaPhMap = dataKey === 'learning_rate'
          ? this._optimizerAutoValueMap(field, 'anima-lora')
          : null;
        const _animaPhExpr = _animaPhMap
          ? JSON.stringify(_animaPhMap).replace(/"/g, '&quot;')
          : '';
        const _phSource = dataKey === 'learning_rate'
          ? `(form.model_train_type === 'anima-lora' ? (${_animaPhExpr || '{}'}) : (${_phExpr}))`
          : `(${_phExpr})`;
        inputHtml = `<input type="text" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" :placeholder="${_phSource}[form.optimizer_type] || ''"${staticReadonlyAttrs}>`;
      } else if (field.omitDefault && field.default !== undefined && field.default !== '' && field.default !== null) {
        // omitDefault 字段：值==默认值时不传，输入框用淡色 placeholder 提示默认值
        const _phVal = String(field.default).replace(/"/g, '&quot;');
        inputHtml = `<input type="text" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" placeholder="${_phVal}"${staticReadonlyAttrs}>`;
      } else {
        // DEFAULT_DIM_KEYS 字段：值==schema 原始默认值时加 is-default class，CSS 淡色模拟 placeholder 视觉
        // （假留空——值仍保留，不触发必填校验失败、不影响训练流程；改值后 class 移除恢复正常字色）
        // :class 属性用双引号包裹，内部字符串字面量必须用单引号，内部单引号转义为 \x27。
        const _dimCls = (window.DEFAULT_DIM_KEYS && window.DEFAULT_DIM_KEYS.has(dataKey) && field.default !== undefined && field.default !== '' && field.default !== null)
          ? ` :class="{ 'is-default': String(form.${dataKey}) === String('${String(field.default).replace(/'/g, '\\x27')}') }"`
          : '';
        inputHtml = `<input type="text" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"${_dimCls}${staticReadonlyAttrs}>`;
      }
    }

    // ── Embed file picker buttons inside input ──
    let controlHtml = '';
    if (field.role && field.role.startsWith('file-') && !isStaticReadonly) {
      // 本地系统选择器在无图形环境的服务器上不可用：整颗按钮不渲染，只留内置浏览器
      const localBtnHtml = this.localPickerAvailable
        ? `<button type="button" class="btn-icon" @click="localFilePicker('${dataKey}','${field.role}')" :title="t('common.localPicker')" :aria-label="t('common.browseLocal')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>`
        : '';
      controlHtml = `<div class="field-input-wrap">${inputHtml}<div class="field-input-actions">${localBtnHtml}<button type="button" class="btn-icon" @click="builtinFilePicker('${dataKey}','${field.role}')" :title="t('common.builtinBrowser')" :aria-label="t('common.searchBuiltin')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button></div></div>`;
    } else {
      controlHtml = inputHtml;
    }

    // ── Reset button + popup menu (in secondary layer) ──
    const _resetSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
    const _undoSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
    const _dotsSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
    const _menuPopupHtml = `<div class="field-menu-popup"><button type="button" @click="undoField('${dataKey}');_menuOpen=false">${_undoSvg}<span>${this.t('common.undoField')}</span></button><button type="button" @click="resetField('${dataKey}');_menuOpen=false">${_resetSvg}<span>${this.t('common.resetField')}</span></button></div>`;

    // ── Conditional display ──
    let condClass = '';
    let condAttrs = '';
    if (field.showIf) {
      const sf = field.showIf;
      if (Array.isArray(sf)) {
        // Multi-condition AND: store JSON for evaluation
        condAttrs = ` data-show-if-all='${this.esc(JSON.stringify(sf))}'`;
        const condMet = sf.every(c => this._evalShowIfCond(c));
        condClass = condMet ? ' field-conditional' : ' field-conditional field-hidden';
      } else {
        // Single condition (existing logic)
        const parentVal = this.form[sf.key];
        let condMet = false;
        condAttrs = ` data-show-if-key="${this.escapeAttr(sf.key)}"`;
        if (sf.eq !== undefined) {
          condMet = String(parentVal) === String(sf.eq);
          condAttrs += ` data-show-if-eq="${this.escapeAttr(sf.eq)}"`;
          if (sf.or && Array.isArray(sf.or)) {
            condMet = condMet || sf.or.some(function(v) { return String(parentVal) === String(v); });
            condAttrs += ` data-show-if-or="${this.escapeAttr(sf.or.join(','))}"`;
          }
        } else if (sf.neq !== undefined) {
          condMet = String(parentVal) !== String(sf.neq) && parentVal !== null && parentVal !== undefined && parentVal !== '';
          condAttrs += ` data-show-if-neq="${this.escapeAttr(sf.neq)}"`;
        }
        condClass = condMet ? ' field-conditional' : ' field-conditional field-hidden';
      }
    } else if (field.showIfAny) {
      // OR-of-ANDs: list[list[dict]] — 任一内层 AND 组全成立即显示
      condAttrs = ` data-show-if-any='${this.esc(JSON.stringify(field.showIfAny))}'`;
      const condMet = field.showIfAny.some(group => group.every(c => this._evalShowIfCond(c)));
      condClass = condMet ? ' field-conditional' : ' field-conditional field-hidden';
    }

    // ── Readonly If ──
    let readonlyAttrs = '';
    let readonlyWarnHtml = '';
    if (field.readonlyIf) {
      const rf = field.readonlyIf;
      const parentVal = this.form[rf.key];
      let readonlyMet = false;
      readonlyAttrs = ` data-readonly-if-key="${this.escapeAttr(rf.key)}"`;
      if (rf.eq !== undefined) {
        readonlyMet = String(parentVal) === String(rf.eq);
        readonlyAttrs += ` data-readonly-if-eq="${this.escapeAttr(rf.eq)}"`;
        if (rf.or && Array.isArray(rf.or)) {
          readonlyMet = readonlyMet || rf.or.some(v => String(parentVal) === String(v));
          readonlyAttrs += ` data-readonly-if-or="${this.escapeAttr(rf.or.join(','))}"`;
        }
      } else if (rf.neq !== undefined) {
        readonlyMet = String(parentVal) !== String(rf.neq) && parentVal !== null && parentVal !== undefined && String(parentVal) !== '';
        readonlyAttrs += ` data-readonly-if-neq="${this.escapeAttr(rf.neq)}"`;
      }
      if (readonlyMet) {
        readonlyAttrs += ` data-readonly-if-active="1"`;
        const reasonText = rf.reasonKey ? this.t(rf.reasonKey) : '';
        if (reasonText) {
          readonlyWarnHtml = `<div class="field-readonly-warn">${reasonText}</div>`;
        }
      }
      if (rf.reasonKey) {
        readonlyAttrs += ` data-readonly-if-reason="${this.escapeAttr(rf.reasonKey)}"`;
      }
    }

    // ── Readonly If Any ──
    // OR clauses; nested arrays represent AND groups.
    if (!field.readonlyIf && field.readonlyIfAny && Array.isArray(field.readonlyIfAny)) {
      const met = this._readonlyIfAnyMet(field.readonlyIfAny);
      readonlyAttrs = ` data-readonly-if-any='${this.esc(JSON.stringify(field.readonlyIfAny))}'`;
      if (field.readonlyReasonKey) {
        readonlyAttrs += ` data-readonly-if-reason="${this.escapeAttr(field.readonlyReasonKey)}"`;
      }
      if (met) {
        readonlyAttrs += ` data-readonly-if-active="1"`;
        const reasonText = field.readonlyReasonKey ? this.t(field.readonlyReasonKey) : '';
        if (reasonText) {
          readonlyWarnHtml = `<div class="field-readonly-warn">${reasonText}</div>`;
        }
      }
    }

    // ── Nested detection (explicit layout parent or conditional parent) ──
    // 计算嵌套层级：一个字段的层级 = 其布局父字段的层级 + 1，父级若无则为 0。
    // 这样"开关→选项→子选项"的树形层级通过递增缩进 + 加深左边框一眼可读。
    const isNested = Boolean(this._fieldLayoutParentKey(field));
    const nestLevel = isNested ? this._nestLevel(field) : 0;
    const nestedClass = isNested ? ' field-nested' : '';
    const nestLevelAttr = ` data-nest-level="${nestLevel}"`;

    // ── Build body row ──
    let controlSection = '';
    let fullWidthRow = '';
    if (isFullWidth) {
      // Textarea / path: info on top, input full-width below (outside field-row)
      controlSection = `<div class="field-info"><div class="field-key">${this.esc(dataKey)}${requiredMark}</div><div class="field-desc">${label}${docLink}</div></div>`;
      fullWidthRow = `<div class="field-input-row">${controlHtml}</div>`;
    } else {
      // Standard: info left, control right — single flex row
      controlSection = `<div class="field-info"><div class="field-key">${this.esc(dataKey)}${requiredMark}</div><div class="field-desc">${label}${docLink}</div></div><div class="field-control">${controlHtml}</div>`;
    }

    // ── Assemble ──
    // 绿色"已填"指示条：仅 FILLED_INDICATOR_KEYS 字段，判定非空且非 schema 原始默认值。
    // schema default 在渲染期已知，序列化为字面量拼进 Alpine 表达式（运行期无需访问 field 对象）。
    // 注意：:class 整个属性用双引号包裹，Alpine 表达式内的字符串字面量必须用单引号（双引号会截断 HTML 属性）。
    // default 值用单引号包裹，内部单引号转义为 \x27 避免破坏表达式。
    const _filledKey = `'${dataKey.replace(/'/g, '\\x27')}'`;
    const _filledDefaultLit = field.default !== undefined
      ? `'${String(field.default).replace(/'/g, '\\x27')}'`
      : 'undefined';
    const _filledExpr = `window.FILLED_INDICATOR_KEYS.has(${_filledKey}) && form.${dataKey} !== '' && form.${dataKey} !== null && form.${dataKey} !== undefined && String(form.${dataKey}) !== String(${_filledDefaultLit})`;
    const fieldMenuHtml = isStaticReadonly ? '' : `<div class="field-menu-wrap">
          <button type="button" class="btn-menu" :aria-label="t('common.fieldActions')" tabindex="-1">${_dotsSvg}</button>
          ${_menuPopupHtml}
        </div>`;
    const staticReadonlyClass = isStaticReadonly ? ' field-readonly' : '';
    return `<div class="field${condClass}${nestedClass}${staticReadonlyClass}" :class="{ 'field-changed': String(form.${dataKey}) !== String(formDefaults.${dataKey}), 'field-filled': ${_filledExpr} }" data-field-row="${this.escapeAttr(dataKey)}"${condAttrs}${readonlyAttrs}${nestLevelAttr}>
      <div class="field-row">
        ${controlSection}
        ${fieldMenuHtml}
      </div>
      ${fullWidthRow}
      ${field.hintKeyBy
        ? `<div class="field-hint" x-text="fieldHintText('${this.escapeAttr(dataKey)}')"></div>`
        : (hint ? `<div class="field-hint">${hint}</div>` : '')}
      ${(this.formErrors && this.formErrors[dataKey]) ? `<div class="field-error">${this.formErrors[dataKey]}</div>` : ''}
      ${this._getEnvHint(dataKey)}
      ${this._getOutputPathHint(dataKey)}
      ${readonlyWarnHtml}
    </div>`;
  },

  // ── 环境联动提示：检查当前字段值依赖的后端是否已安装（Alpine 响应式）──
  // x-show 与 faStatus/xfStatus/tritonStatus 及 form 值联动，环境数据异步到达后自动显示。
  _getEnvHint(dataKey) {
    switch (dataKey) {
      case 'timestep_sampling':
        return `<div class="timestep-preview-entry">
          <button type="button" class="btn btn-ghost btn-sm" @click="openTimestepPreview()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
            <span x-text="t('timestepPreview.open')">View timestep distribution</span>
          </button>
          <span class="field-hint" x-text="t('timestepPreview.entryHint')"></span>
        </div>`;
      case 'attn_mode':
        return `<div x-show="faStatus && !faStatus.installed && form.attn_mode==='flash'" class="field-hint field-hint-warn">${this.t('environment.envHintFlashNotInstalled')}</div>`
             + `<div x-show="xfStatus && !xfStatus.installed && form.attn_mode==='xformers'" class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'xformers':
        return `<div x-show="xfStatus && !xfStatus.installed && form.xformers" class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'compile':
        return `<div x-show="tritonStatus && !tritonStatus.installed && form.compile" class="field-hint field-hint-warn">${this.t('environment.envHintTritonNotInstalled')}</div>`;
    }
    return '';
  },

  _timestepPreviewNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },

  _timestepPreviewResolution(value) {
    const raw = String(value || (this.form && this.form.resolution) || '1024,1024');
    const values = raw.split(/[xX,]/).map(v => Number(v.trim())).filter(v => Number.isFinite(v) && v > 0);
    if (values.length === 1) return [values[0], values[0]];
    if (values.length >= 2) return [values[0], values[1]];
    return [1024, 1024];
  },

  timestepOffsetSupported() {
    return ['sigmoid', 'shift', 'flux_shift'].includes(String(this.form.timestep_sampling || ''));
  },

  timestepOffsetSubsets() {
    return ((this.stepEstimate && this.stepEstimate.subsets) || []).filter(subset => !subset.is_reg);
  },

  subsetTimestepOffsetValue(name) {
    const offsets = this.form.subset_timestep_offsets;
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return '';
    return Object.prototype.hasOwnProperty.call(offsets, name) ? offsets[name] : '';
  },

  subsetTimestepOffsetInputValue(name) {
    if (Object.prototype.hasOwnProperty.call(this.subsetTimestepOffsetDrafts || {}, name)) {
      return this.subsetTimestepOffsetDrafts[name];
    }
    const value = this.subsetTimestepOffsetValue(name);
    return value === '' ? '' : String(value);
  },

  setSubsetTimestepOffsetDraft(name, rawValue) {
    const raw = String(rawValue ?? '');
    this.subsetTimestepOffsetDrafts = { ...(this.subsetTimestepOffsetDrafts || {}), [name]: raw };
    // Keep intermediate keyboard states such as "-", "." and "0." visible.
    if (/^[-+]?\d*\.?\d+$/.test(raw)) this.setSubsetTimestepOffset(name, raw);
  },

  commitSubsetTimestepOffsetDraft(name) {
    const drafts = this.subsetTimestepOffsetDrafts || {};
    if (!Object.prototype.hasOwnProperty.call(drafts, name)) return;
    const raw = String(drafts[name] ?? '').trim();
    if (raw === '' || /^[-+]?\d*\.?\d+$/.test(raw)) {
      this.setSubsetTimestepOffset(name, raw);
    }
    const nextDrafts = { ...drafts };
    delete nextDrafts[name];
    this.subsetTimestepOffsetDrafts = nextDrafts;
  },

  _reconcileSubsetTimestepOffsets() {
    if (!this.form || this.form.model_train_type !== 'anima-lora') return;
    const validNames = new Set(this.timestepOffsetSubsets().map(subset => subset.name));
    const current = this.form.subset_timestep_offsets;
    const clean = {};
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      Object.entries(current).forEach(([name, value]) => {
        const offset = Number(value);
        if (validNames.has(name) && Number.isFinite(offset) && offset !== 0) clean[name] = offset;
      });
    }
    if (JSON.stringify(clean) !== JSON.stringify(current || {})) this.form.subset_timestep_offsets = clean;
  },

  setSubsetTimestepOffset(name, rawValue) {
    const previous = this.form.subset_timestep_offsets || {};
    const next = { ...(this.form.subset_timestep_offsets || {}) };
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      delete next[name];
    } else {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value === 0) delete next[name];
      else next[name] = value;
    }
    this.form.subset_timestep_offsets = next;
    this._setFieldSource('subset_timestep_offsets', 'user');
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.pushHistory({ ...this.form, subset_timestep_offsets: { ...next } });
      if (typeof this.queueTomlPreviewChange === 'function') this.queueTomlPreviewChange('subset_timestep_offsets');
      if (typeof this.updateToml === 'function') this.updateToml();
    }
    if (this.timestepPreviewOpen) this.refreshTimestepPreview();
  },

  stepSubsetTimestepOffset(name, delta) {
    const current = Number(this.subsetTimestepOffsetValue(name) || 0);
    const nextDrafts = { ...(this.subsetTimestepOffsetDrafts || {}) };
    delete nextDrafts[name];
    this.subsetTimestepOffsetDrafts = nextDrafts;
    this.setSubsetTimestepOffset(name, Math.round((current + delta) * 100) / 100);
  },

  _subsetTimestepOffsetFromSnapshot(snapshot, name) {
    const offsets = snapshot && snapshot.subset_timestep_offsets;
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return '';
    return Object.prototype.hasOwnProperty.call(offsets, name) ? offsets[name] : '';
  },

  undoSubsetTimestepOffset(name) {
    const drafts = { ...(this.subsetTimestepOffsetDrafts || {}) };
    delete drafts[name];
    this.subsetTimestepOffsetDrafts = drafts;
    const current = this.subsetTimestepOffsetValue(name);
    for (let i = this.formHistoryIdx - 1; i >= 0; i -= 1) {
      const previous = this._subsetTimestepOffsetFromSnapshot(this.formHistory[i], name);
      if (String(previous) !== String(current)) {
        const next = { ...(this.form.subset_timestep_offsets || {}) };
        if (previous === '' || previous === null || previous === undefined || Number(previous) === 0) delete next[name];
        else next[name] = Number(previous);
        this.form.subset_timestep_offsets = next;
        this.formHistoryIdx = i;
        this._setFieldSource('subset_timestep_offsets', 'user');
        this._persistProfileFieldSources();
        if (typeof this.updateToml === 'function') this.updateToml();
        return;
      }
    }
    this.resetSubsetTimestepOffset(name);
  },

  resetSubsetTimestepOffset(name) {
    const drafts = { ...(this.subsetTimestepOffsetDrafts || {}) };
    delete drafts[name];
    this.subsetTimestepOffsetDrafts = drafts;
    this.setSubsetTimestepOffset(name, '');
    this._setFieldSource('subset_timestep_offsets', 'default');
    this._persistProfileFieldSources();
  },

  renderSubsetTimestepOffsets() {
    const supported = this.timestepOffsetSupported();
    const subsets = this.timestepOffsetSubsets();
    const disabled = ' :disabled="!timestepOffsetSupported()"';
    const rows = subsets.map(subset => {
      const name = String(subset.name || '');
      const nameExpr = this.escapeAttr(JSON.stringify(name));
      const sampleText = this.t('timestepOffset.sampleFormat')
        .replace('{images}', String(subset.image_count || 0))
        .replace('{repeats}', String(subset.repeats || 0));
      return `<div class="subset-timestep-row">
        <span class="subset-timestep-name" title="${this.escapeAttr(name)}">${this.esc(name)}</span>
        <span class="subset-timestep-meta">${this.esc(sampleText)}</span>
        <div class="stepper subset-timestep-stepper">
          <button type="button" @click="stepSubsetTimestepOffset(${nameExpr}, -0.05)"${disabled}>−</button>
          <input type="text" inputmode="decimal" autocomplete="off" placeholder="0" :value="subsetTimestepOffsetInputValue(${nameExpr})" @input="setSubsetTimestepOffsetDraft(${nameExpr}, $event.target.value)" @blur="commitSubsetTimestepOffsetDraft(${nameExpr})"${disabled}>
          <button type="button" @click="stepSubsetTimestepOffset(${nameExpr}, 0.05)"${disabled}>+</button>
        </div>
        <button type="button" class="btn-icon" @click="openTimestepPreview(${nameExpr})"${disabled} title="${this.escapeAttr(this.t('timestepOffset.previewSubset'))}" aria-label="${this.escapeAttr(this.t('timestepOffset.previewSubset'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
        </button>
        <div class="field-menu-wrap subset-timestep-menu">
          <button type="button" class="btn-menu" :aria-label="t('common.fieldActions')" title="${this.escapeAttr(this.t('common.fieldActions'))}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          <div class="field-menu-popup">
            <button type="button" @click="undoSubsetTimestepOffset(${nameExpr})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span>${this.esc(this.t('common.undoField'))}</span></button>
            <button type="button" @click="resetSubsetTimestepOffset(${nameExpr})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>${this.esc(this.t('common.resetField'))}</span></button>
          </div>
        </div>
      </div>`;
    }).join('');
    const body = rows || `<div class="subset-timestep-empty field-hint">${this.esc(this.t('timestepOffset.empty'))}</div>`;
    const previewDisabled = subsets.length ? '' : ' disabled';
    return `<div class="subset-timestep-editor${supported ? '' : ' is-disabled'}" :class="{ 'is-disabled': !timestepOffsetSupported() }">
      <div class="subset-timestep-header">
        <div>
          <div class="subset-timestep-title">
            <span>${this.esc(this.t('timestepOffset.title'))}</span>
            <button type="button" class="field-doc-link" @click.stop="openParameterDoc('timesteps','subset-offsets')" title="${this.escapeAttr(this.t('docs.openGuide'))}" aria-label="${this.escapeAttr(this.t('docs.openGuide'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              <span>${this.esc(this.t('docs.openGuide'))}</span>
            </button>
          </div>
          <div class="field-hint">${this.esc(this.t('timestepOffset.hint'))}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="openTimestepPreview('overall')"${previewDisabled}${disabled}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
          <span>${this.esc(this.t('timestepOffset.preview'))}</span>
        </button>
      </div>
      ${rows ? `<div class="subset-timestep-list"><div class="subset-timestep-row subset-timestep-row--head"><span>${this.esc(this.t('timestepOffset.subset'))}</span><span>${this.esc(this.t('timestepOffset.samples'))}</span><span>${this.esc(this.t('timestepOffset.offset'))}</span><span></span></div>${body}</div>` : body}
      <div class="field-hint subset-timestep-footnote">${this.esc(this.t('timestepOffset.rangeWarning'))}</div>
    </div>`;
  },

  _refreshSubsetTimestepEditor() {
    const current = document.querySelector('.subset-timestep-editor');
    if (!current || !current.parentNode) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = this.renderSubsetTimestepOffsets();
    const next = wrapper.firstElementChild;
    if (!next) return;
    const alpine = window.Alpine;
    if (alpine && typeof alpine.mutateDom === 'function' && typeof alpine.destroyTree === 'function' && typeof alpine.initTree === 'function') {
      alpine.mutateDom(() => {
        alpine.destroyTree(current);
        current.replaceWith(next);
        alpine.initTree(next);
      });
    } else {
      current.replaceWith(next);
    }
  },

  timestepPreviewOptions() {
    const options = [{ value: 'base', label: this.t('timestepPreview.baseDistribution') }];
    const subsets = this.timestepOffsetSubsets();
    if (subsets.length) options.push({ value: 'overall', label: this.t('timestepPreview.overallDistribution') });
    subsets.forEach(subset => {
      const raw = this.subsetTimestepOffsetValue(subset.name);
      const suffix = raw === '' ? '0' : `${Number(raw) > 0 ? '+' : ''}${raw}`;
      options.push({ value: subset.name, label: `${subset.name} (${suffix})` });
    });
    return options;
  },

  setTimestepPreviewScope(scope) {
    this.timestepPreviewScope = scope;
    this.refreshTimestepPreview();
  },

  _buildTimestepPreview(values, requestedScope) {
    const source = values || this.form || {};
    const scope = requestedScope || this.timestepPreviewScope || 'base';
    const sampling = String(source.timestep_sampling || 'sigmoid');
    const weighting = String(source.weighting_scheme || 'uniform');
    const isKrea2 = String(source.model_train_type || '') === 'krea2-lora';
    const sigmoidScale = this._timestepPreviewNumber(source.sigmoid_scale, 1.0);
    const flowShift = Math.max(0.0001, this._timestepPreviewNumber(source.discrete_flow_shift, 1.0));
    const logitMean = this._timestepPreviewNumber(source.logit_mean, 0.0);
    const logitStd = Math.max(0, this._timestepPreviewNumber(source.logit_std, 1.0));
    const modeScale = this._timestepPreviewNumber(source.mode_scale, 1.29);
    const [width, height] = this._timestepPreviewResolution(source.resolution);
    const binCount = 32;
    const sampleCount = 32768;
    const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-60, Math.min(60, value))));
    const fixedShift = value => (value * flowShift) / (1 + (flowShift - 1) * value);

    // Anima and Krea 2 both use VAE f8 latents with 2x2 DiT patch packing.
    const latentH = Math.floor(height / 8);
    const latentW = Math.floor(width / 8);
    const tokenCount = Math.floor(latentH / 2) * Math.floor(latentW / 2);
    const resolutionShift = maxTokens => {
      const mu = 0.5 + ((1.15 - 0.5) / (maxTokens - 256)) * (tokenCount - 256);
      const shift = Math.exp(mu);
      return value => (value * shift) / (1 + (shift - 1) * value);
    };
    const fluxShift = resolutionShift(4096);
    const krea2Shift = resolutionShift(6400);

    const sampleCounts = offset => {
      const counts = Array(binCount).fill(0);
      let state = 0x6d2b79f5;
      let spareNormal = null;
      const random = () => {
        state |= 0;
        state = state + 0x6d2b79f5 | 0;
        let value = Math.imul(state ^ state >>> 15, 1 | state);
        value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
      };
      const normal = () => {
        if (spareNormal !== null) {
          const value = spareNormal;
          spareNormal = null;
          return value;
        }
        const u = Math.max(random(), 1e-12);
        const v = random();
        const radius = Math.sqrt(-2 * Math.log(u));
        const angle = 2 * Math.PI * v;
        spareNormal = radius * Math.sin(angle);
        return radius * Math.cos(angle);
      };
      const appliedOffset = ['sigmoid', 'shift', 'flux_shift'].includes(sampling) ? offset : 0;
      for (let index = 0; index < sampleCount; index += 1) {
        let sigma;
        if (sampling === 'uniform') {
          sigma = random();
        } else if (sampling === 'shift') {
          sigma = fixedShift(sigmoid(sigmoidScale * (normal() + appliedOffset)));
        } else if (sampling === 'flux_shift') {
          sigma = fluxShift(sigmoid(sigmoidScale * (normal() + appliedOffset)));
        } else if (sampling === 'krea2_shift') {
          sigma = krea2Shift(sigmoid(sigmoidScale * normal()));
        } else if (sampling === 'sigma') {
          let density;
          if (weighting === 'logit_normal') density = sigmoid(logitMean + logitStd * normal());
          else if (weighting === 'mode') {
            const u = random();
            density = 1 - u - modeScale * (Math.cos(Math.PI * u / 2) ** 2 - 1 + u);
          } else density = random();
          sigma = fixedShift(1 - Math.max(0, Math.min(1, density)));
        } else if (sampling === 'logsnr') {
          sigma = sigmoid(-(logitMean + logitStd * normal()) / 2);
        } else {
          sigma = sigmoid(sigmoidScale * (normal() + appliedOffset));
        }
        sigma = Math.max(0, Math.min(0.999999, sigma));
        counts[Math.min(binCount - 1, Math.floor(sigma * binCount))] += 1;
      }
      return counts;
    };

    const baselineCounts = sampleCounts(0);
    let counts = [...baselineCounts];
    let scopeLabel = this.t('timestepPreview.baseDistribution');
    let offset = 0;
    const subsets = this.timestepOffsetSubsets();
    if (scope === 'overall' && subsets.length) {
      const totalSamples = subsets.reduce((sum, subset) => sum + Number(subset.sample_count || 0), 0) || subsets.length;
      counts = Array(binCount).fill(0);
      subsets.forEach(subset => {
        const weight = totalSamples === subsets.length ? 1 / subsets.length : Number(subset.sample_count || 0) / totalSamples;
        const subsetCounts = sampleCounts(Number(this.subsetTimestepOffsetValue(subset.name) || 0));
        subsetCounts.forEach((count, index) => { counts[index] += count * weight; });
      });
      scopeLabel = this.t('timestepPreview.overallDistribution');
    } else {
      const selectedSubset = subsets.find(subset => subset.name === scope);
      if (selectedSubset) {
        offset = Number(this.subsetTimestepOffsetValue(selectedSubset.name) || 0);
        counts = sampleCounts(offset);
        scopeLabel = selectedSubset.name;
      }
    }

    const maxCount = Math.max(...counts, ...baselineCounts, 1);
    const weights = counts.map((_, index) => {
      const sigma = Math.max((index + 0.5) / binCount, 1e-6);
      if (weighting === 'sigma_sqrt') return sigma ** -2;
      if (weighting === 'cosmap') return 2 / (Math.PI * (1 - 2 * sigma + 2 * sigma * sigma));
      return 1;
    });
    const logWeights = weights.map(value => Math.log1p(value));
    const maxLogWeight = Math.max(...logWeights, 1);
    const bins = counts.map((count, index) => ({
      index,
      count,
      percent: count * 100 / sampleCount,
      height: Math.max(1.5, count * 100 / maxCount),
      baselinePercent: baselineCounts[index] * 100 / sampleCount,
      baselineHeight: Math.max(1.5, baselineCounts[index] * 100 / maxCount),
      weight: weights[index],
      weightY: 100 - logWeights[index] * 92 / maxLogWeight,
    }));
    const weightPoints = bins.map((bin, index) => `${(index * 100 / (binCount - 1)).toFixed(2)},${bin.weightY.toFixed(2)}`).join(' ');
    const third = Math.floor(binCount / 3);
    const sumRange = (sourceCounts, start, end) => sourceCounts.slice(start, end).reduce((total, value) => total + value, 0) * 100 / sampleCount;
    const median = sourceCounts => {
      const midpoint = sourceCounts.reduce((sum, value) => sum + value, 0) / 2;
      let cumulative = 0;
      for (let index = 0; index < sourceCounts.length; index += 1) {
        cumulative += sourceCounts[index];
        if (cumulative >= midpoint) return Math.round((index + 0.5) * 1000 / binCount);
      }
      return 1000;
    };
    const notes = [];
    if (!['shift', 'sigma'].includes(sampling) && !isKrea2 && Math.abs(flowShift - 1) > 1e-9) {
      notes.push(this.t('timestepPreview.shiftIgnored'));
    }
    if (sampling === 'flux_shift') notes.push(this.t('timestepPreview.fluxShiftNote'));
    if (sampling === 'krea2_shift') notes.push(this.t('timestepPreview.krea2ShiftNote'));
    if (['logit_normal', 'mode'].includes(weighting) && sampling !== 'sigma') {
      notes.push(this.t('timestepPreview.densityIgnored'));
    }
    if (!['sigma_sqrt', 'cosmap'].includes(weighting)) {
      notes.push(this.t('timestepPreview.uniformWeightNote'));
    }

    return {
      sampling,
      weighting,
      scope,
      scopeLabel,
      offset,
      effectiveOffset: sigmoidScale * offset,
      resolution: `${width} × ${height}`,
      sampleCount,
      bins,
      weightPoints,
      median: median(counts),
      baselineMedian: median(baselineCounts),
      lowPercent: sumRange(counts, 0, third),
      midPercent: sumRange(counts, third, binCount - third),
      highPercent: sumRange(counts, binCount - third, binCount),
      baselineLowPercent: sumRange(baselineCounts, 0, third),
      baselineMidPercent: sumRange(baselineCounts, third, binCount - third),
      baselineHighPercent: sumRange(baselineCounts, binCount - third, binCount),
      compare: scope !== 'base',
      notes,
    };
  },

  openTimestepPreview(scope) {
    const available = new Set(this.timestepPreviewOptions().map(option => option.value));
    this.timestepPreviewScope = available.has(scope) ? scope : (available.has(this.timestepPreviewScope) ? this.timestepPreviewScope : 'base');
    this.timestepPreviewData = this._buildTimestepPreview(null, this.timestepPreviewScope);
    this.timestepPreviewOpen = true;
  },

  refreshTimestepPreview() {
    this.timestepPreviewData = this._buildTimestepPreview(null, this.timestepPreviewScope);
  },

  _getOutputPathHint(dataKey) {
    if (dataKey !== 'output_dir') return '';
    return `<div class="output-path-hint" x-show="outputPathHintVisible()" :class="outputPathStatusClass()" role="status" aria-live="polite" x-cloak>
      <div class="output-path-hint-summary"><span class="output-path-hint-dot" aria-hidden="true"></span><span x-text="outputPathSummaryText()"></span></div>
    </div>`;
  },

  // positive prompts line count hint: real-time sample count below textarea
  _positivePromptCountHint(dataKey) {
    var h = [];
    h.push('<div class="field-hint field-hint-warn" x-show="(form.');
    h.push(dataKey);
    h.push(" || '').split('\\n').filter(function(l){return l.trim()}).length >= 2\"");
    h.push(" x-text=\"t('field.samplePromptsCountHint').replaceAll('{n}', (form.");
    h.push(dataKey);
    h.push(" || '').split('\\n').filter(function(l){return l.trim()}).length)\"></div>");
    return h.join('');
  },

  // 完整渲染后的快速初始化路径：每个条件节点只解析和求值一次，不播放动画，
  // 不生成 TOML（调用方会在表单初始化完成后统一生成）。
  _syncAllConditionalFields() {
    const container = document.getElementById('trainFormContent');
    if (!container) return;

    container.querySelectorAll('[data-show-if-all],[data-show-if-any],[data-show-if-key]').forEach(row => {
      let match = true;
      try {
        const allAttr = row.getAttribute('data-show-if-all');
        const anyAttr = row.getAttribute('data-show-if-any');
        if (allAttr !== null) {
          const conditions = JSON.parse(allAttr);
          match = conditions.every(c => this._evalShowIfCond(c));
        } else if (anyAttr !== null) {
          const groups = JSON.parse(anyAttr);
          match = groups.some(group => group.every(c => this._evalShowIfCond(c)));
        } else {
          const parentKey = row.getAttribute('data-show-if-key');
          const expectedVal = this.form[parentKey];
          const eqVal = row.getAttribute('data-show-if-eq');
          const neqVal = row.getAttribute('data-show-if-neq');
          const orVals = (row.getAttribute('data-show-if-or') || '').split(',').filter(Boolean);
          if (eqVal !== null) {
            match = String(expectedVal) === eqVal || orVals.includes(String(expectedVal));
          } else if (neqVal !== null) {
            match = String(expectedVal) !== neqVal
              && expectedVal !== null && expectedVal !== undefined && expectedVal !== '';
          }
        }
      } catch (e) {
        // 保留渲染阶段已经计算出的状态，避免坏条件导致字段被错误隐藏。
        match = !row.classList.contains('field-hidden');
      }
      row._conditionalTargetVisible = match;
      this._setConditionalState(row, match);
    });

  },

  showConditionalFields(parentKey) {
    const container = document.getElementById('trainFormContent');
    if (!container) { this.updateToml(); return; }
    const expectedVal = this.form[parentKey];
    const toAnimate = [];
    // Handle multi-condition show_if (data-show-if-all)
    container.querySelectorAll(`[data-show-if-all]`).forEach(row => {
      try {
        const conditions = JSON.parse(row.getAttribute('data-show-if-all'));
        // Only re-evaluate if this parentKey is relevant to these conditions
        if (!conditions.some(c => c.key === parentKey)) return;
        const match = conditions.every(c => this._evalShowIfCond(c));
        this._toggleFieldRow(row, match, toAnimate);
      } catch (e) { /* ignore parse errors */ }
    });

    // Handle OR-of-ANDs show_if (data-show-if-any)
    container.querySelectorAll(`[data-show-if-any]`).forEach(row => {
      try {
        const groups = JSON.parse(row.getAttribute('data-show-if-any'));
        // Only re-evaluate if this parentKey appears in any AND group
        if (!groups.some(group => group.some(c => c.key === parentKey))) return;
        const match = groups.some(group => group.every(c => this._evalShowIfCond(c)));
        this._toggleFieldRow(row, match, toAnimate);
      } catch (e) { /* ignore parse errors */ }
    });

    // Handle single-condition show_if (data-show-if-key) — existing logic
    container.querySelectorAll(`[data-show-if-key="${parentKey}"]`).forEach(row => {
      const eqVal = row.getAttribute('data-show-if-eq');
      const neqVal = row.getAttribute('data-show-if-neq');
      const orVals = (row.getAttribute('data-show-if-or') || '').split(',').filter(Boolean);
      let match = false;
      if (eqVal !== null) {
        match = String(expectedVal) === eqVal;
        if (!match && orVals.length > 0) {
          match = orVals.indexOf(String(expectedVal)) !== -1;
        }
      } else if (neqVal !== null) {
        match = String(expectedVal) !== neqVal && String(expectedVal) !== 'null' && String(expectedVal) !== 'undefined' && String(expectedVal) !== '';
      }

      this._toggleFieldRow(row, match, toAnimate);
    });

    if (toAnimate.length === 0) { this.updateToml(); return; }
    this._queueConditionalMotion(toAnimate);
    this.updateToml();
  },

  // 只记录最终目标；同一轮 Alpine watcher 产生的多项变化会合并为一次布局切换。
  _toggleFieldRow(row, match, toAnimate) {
    const targetVisible = row._conditionalTargetVisible;
    const currentlyVisible = !row.classList.contains('field-hidden') && !row.classList.contains('field-motion-exit');
    if (targetVisible === match) return;
    if (targetVisible === undefined && currentlyVisible === match) return;
    row._conditionalTargetVisible = match;
    toAnimate.push({ row, match });
  },

  _queueConditionalMotion(items) {
    if (!(this._conditionalMotionQueue instanceof Map)) this._conditionalMotionQueue = new Map();
    items.forEach(item => this._conditionalMotionQueue.set(item.row, item.match));
    if (this._conditionalMotionTimer) return;

    const epoch = this._conditionalMotionEpoch;
    this._conditionalMotionTimer = setTimeout(() => {
      this._conditionalMotionTimer = null;
      if (epoch !== this._conditionalMotionEpoch) return;
      const queue = this._conditionalMotionQueue;
      this._conditionalMotionQueue = null;
      if (!queue) return;
      const changes = [];
      queue.forEach((match, row) => {
        if (row && row.isConnected) changes.push({ row, match });
      });
      this._runConditionalMotion(changes, epoch);
    }, 0);
  },

  _runConditionalMotion(changes, epoch) {
    if (!changes.length || epoch !== this._conditionalMotionEpoch) return;
    const container = document.getElementById('trainFormContent');
    if (!container) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canAnimate = !reduceMotion && typeof Element !== 'undefined'
      && Element.prototype && typeof Element.prototype.animate === 'function';
    if (!canAnimate) {
      changes.forEach(item => this._setConditionalState(item.row, item.match));
      return;
    }

    const changedRows = new Set(changes.map(item => item.row));
    const primary = [];
    const deferredByPrimary = new Map();

    changes.forEach(item => {
      const row = item.row;
      const exitingAncestor = row.parentElement && row.parentElement.closest('.field-motion-exit');
      if (exitingAncestor && !changedRows.has(exitingAncestor)) {
        this._deferConditionalChange(exitingAncestor, row, item.match);
        return;
      }

      const hiddenAncestor = row.parentElement
        && row.parentElement.closest('.field-hidden, .card-collapsed');
      if (hiddenAncestor && !changedRows.has(hiddenAncestor)) {
        this._setConditionalState(row, item.match);
        return;
      }

      let owner = null;
      let parent = row.parentElement;
      while (parent && parent !== container) {
        if (changedRows.has(parent)) owner = parent;
        parent = parent.parentElement;
      }
      if (owner) {
        if (!deferredByPrimary.has(owner)) deferredByPrimary.set(owner, []);
        deferredByPrimary.get(owner).push(item);
      } else {
        primary.push(item);
      }
    });

    deferredByPrimary.forEach((items, owner) => {
      items.forEach(item => this._deferConditionalChange(owner, item.row, item.match));
    });
    if (!primary.length) return;

    const layoutParents = new Set();
    primary.forEach(item => {
      if (item.row.parentElement) layoutParents.add(item.row.parentElement);
      const card = item.row.closest('.card');
      if (card && card.parentElement) layoutParents.add(card.parentElement);
      this._cancelConditionalVisibilityAnimation(item.row);
    });

    const before = this._captureConditionalLayout(layoutParents, true);
    const entering = new Set();
    const exiting = new Set();

    primary.forEach(item => {
      const row = item.row;
      if (item.match) {
        this._restoreConditionalExit(row);
        row.classList.remove('field-hidden');
        row.setAttribute('aria-hidden', 'false');
        this._applyConditionalDeferredChanges(row);
        entering.add(row);
        return;
      }

      if (row.classList.contains('field-hidden')) {
        this._setConditionalState(row, false);
        this._applyConditionalDeferredChanges(row);
        return;
      }
      const rect = before.get(row) || row.getBoundingClientRect();
      this._prepareConditionalExit(row, rect);
      exiting.add(row);
    });

    const after = this._captureConditionalLayout(layoutParents, false);
    this._playConditionalFlip(before, after, entering);
    this._animateConditionalEntries(entering);
    this._animateConditionalExits(exiting, epoch);
  },

  _captureConditionalLayout(parents, cancelExisting) {
    const layout = new Map();
    parents.forEach(parent => {
      if (!parent || !parent.isConnected) return;
      Array.from(parent.children).forEach(element => {
        if (cancelExisting && element._conditionalLayoutAnimation) {
          clearTimeout(element._conditionalLayoutTimer);
          element._conditionalLayoutTimer = null;
          element._conditionalLayoutAnimation.cancel();
          element._conditionalLayoutAnimation = null;
          element.classList.remove('field-motion-moving');
        }
        if (element.classList.contains('field-hidden') || element.classList.contains('field-motion-exit')) return;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        layout.set(element, {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
        });
      });
    });
    return layout;
  },

  _playConditionalFlip(before, after, entering) {
    const scroller = document.getElementById('mainContent');
    const viewport = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    let animationCount = 0;
    after.forEach((nextRect, element) => {
      const prevRect = before.get(element);
      if (!prevRect || entering.has(element) || animationCount >= 36) return;
      const dx = prevRect.left - nextRect.left;
      const dy = prevRect.top - nextRect.top;
      if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75) return;
      const inView = nextRect.bottom >= viewport.top - 140 && nextRect.top <= viewport.bottom + 140;
      const wasInView = prevRect.bottom >= viewport.top - 140 && prevRect.top <= viewport.bottom + 140;
      if (!inView && !wasInView) return;
      if (getComputedStyle(element).transform !== 'none') return;

      if (element._conditionalLayoutAnimation) element._conditionalLayoutAnimation.cancel();
      element.classList.add('field-motion-moving');
      const animation = element.animate([
        { transform: `translate3d(${dx}px, ${dy}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ], {
        duration: 190,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      element._conditionalLayoutAnimation = animation;
      animationCount += 1;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(element._conditionalLayoutTimer);
        element._conditionalLayoutTimer = null;
        if (element._conditionalLayoutAnimation === animation) {
          element._conditionalLayoutAnimation = null;
          animation.cancel();
          element.classList.remove('field-motion-moving');
        }
      };
      element._conditionalLayoutTimer = setTimeout(finish, 260);
      animation.finished.then(finish).catch(() => {});
    });
  },

  _animateConditionalEntries(rows) {
    rows.forEach(row => {
      if (!row.isConnected || row._conditionalTargetVisible !== true) return;
      row.classList.add('field-motion-entering');
      const animation = row.animate([
        { opacity: 0, transform: 'translate3d(0, -6px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ], {
        duration: 180,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      row._conditionalVisibilityAnimation = animation;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(row._conditionalVisibilityTimer);
        row._conditionalVisibilityTimer = null;
        if (row._conditionalVisibilityAnimation === animation) {
          row._conditionalVisibilityAnimation = null;
          animation.cancel();
          row.classList.remove('field-motion-entering');
        }
      };
      row._conditionalVisibilityTimer = setTimeout(finish, 240);
      animation.finished.then(finish).catch(() => {});
    });
  },

  _animateConditionalExits(rows, epoch) {
    rows.forEach(row => {
      if (!row.isConnected || row._conditionalTargetVisible !== false) return;
      const animation = row.animate([
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        { opacity: 0, transform: 'translate3d(0, -4px, 0)' },
      ], {
        duration: 125,
        easing: 'cubic-bezier(0.4, 0, 1, 1)',
        fill: 'forwards',
      });
      row._conditionalVisibilityAnimation = animation;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(row._conditionalVisibilityTimer);
        row._conditionalVisibilityTimer = null;
        if (row._conditionalVisibilityAnimation !== animation) return;
        row._conditionalVisibilityAnimation = null;
        if (epoch !== this._conditionalMotionEpoch || !row.isConnected) {
          animation.cancel();
          this._restoreConditionalExit(row);
          return;
        }
        if (row._conditionalTargetVisible === false) {
          row.classList.add('field-hidden');
          row.setAttribute('aria-hidden', 'true');
          animation.cancel();
          this._applyConditionalDeferredChanges(row);
          this._restoreConditionalExit(row);
        } else {
          animation.cancel();
          this._restoreConditionalExit(row);
          row.classList.remove('field-hidden');
          row.setAttribute('aria-hidden', 'false');
          this._applyConditionalDeferredChanges(row);
        }
      };
      row._conditionalVisibilityTimer = setTimeout(finish, 190);
      animation.finished.then(finish).catch(() => {});
    });
  },

  _prepareConditionalExit(row, rect) {
    this._restoreConditionalExit(row);
    const properties = [
      'position', 'top', 'left', 'width', 'height', 'minHeight', 'maxHeight',
      'margin', 'overflow', 'opacity', 'transform', 'transformOrigin', 'transition',
      'visibility', 'pointerEvents', 'zIndex', 'boxSizing', 'backgroundColor',
      'contain', 'willChange',
    ];
    const inline = {};
    properties.forEach(property => { inline[property] = row.style[property]; });
    row._conditionalExitInline = inline;
    row.classList.remove('field-hidden', 'field-motion-entering');
    row.classList.add('field-motion-exit');
    row.setAttribute('aria-hidden', 'true');
    row.style.position = 'fixed';
    row.style.top = `${rect.top}px`;
    row.style.left = `${rect.left}px`;
    row.style.width = `${Math.max(0, rect.right - rect.left)}px`;
    row.style.height = `${Math.max(0, rect.bottom - rect.top)}px`;
    row.style.minHeight = '0';
    row.style.maxHeight = `${Math.max(0, rect.bottom - rect.top)}px`;
    row.style.margin = '0';
    row.style.overflow = 'hidden';
    row.style.opacity = '1';
    row.style.transform = 'translate3d(0, 0, 0)';
    row.style.transformOrigin = 'top left';
    row.style.transition = 'none';
    row.style.visibility = 'visible';
    row.style.pointerEvents = 'none';
    row.style.zIndex = '60';
    row.style.boxSizing = 'border-box';
    row.style.backgroundColor = 'var(--bg-surface)';
    row.style.contain = 'paint';
    row.style.willChange = 'transform, opacity';
  },

  _restoreConditionalExit(row) {
    const inline = row._conditionalExitInline;
    if (inline) {
      Object.keys(inline).forEach(property => { row.style[property] = inline[property]; });
      delete row._conditionalExitInline;
    }
    row.classList.remove('field-motion-exit');
  },

  _cancelConditionalVisibilityAnimation(row) {
    clearTimeout(row._conditionalVisibilityTimer);
    row._conditionalVisibilityTimer = null;
    if (row._conditionalVisibilityAnimation) {
      row._conditionalVisibilityAnimation.cancel();
      row._conditionalVisibilityAnimation = null;
    }
    row.classList.remove('field-motion-entering');
  },

  _setConditionalState(row, visible) {
    if (!row || !row.isConnected) return;
    this._cancelConditionalVisibilityAnimation(row);
    if (visible) {
      this._restoreConditionalExit(row);
      row.classList.remove('field-hidden');
      row.setAttribute('aria-hidden', 'false');
    } else {
      row.classList.add('field-hidden');
      row.setAttribute('aria-hidden', 'true');
      this._restoreConditionalExit(row);
    }
    row.classList.remove('field-motion-entering');
  },

  _deferConditionalChange(owner, row, match) {
    if (!(owner._conditionalDeferredChanges instanceof Map)) owner._conditionalDeferredChanges = new Map();
    owner._conditionalDeferredChanges.set(row, match);
  },

  _applyConditionalDeferredChanges(owner) {
    const deferred = owner._conditionalDeferredChanges;
    if (!(deferred instanceof Map)) return;
    delete owner._conditionalDeferredChanges;
    deferred.forEach((match, row) => {
      const target = typeof row._conditionalTargetVisible === 'boolean'
        ? row._conditionalTargetVisible
        : match;
      this._setConditionalState(row, target);
    });
  },

  // ── Auto Value: auto-set field value when watcher field changes ──
  _autoValueRules: null,

  /** Check whether a single autoValue rule matches the current form state. */
  _matchAutoValueRule(rule) {
    if (rule.watch && typeof rule.watch === 'object' && !Array.isArray(rule.watch)) {
      // Multi-condition: all watched fields must match their expected values
      return Object.entries(rule.watch).every(([k, v]) => String(this.form[k]) === String(v));
    }
    // Single condition
    return String(this.form[rule.watch]) === String(rule.when);
  },

  /** Preserve explicit values for recommendation-only autoValue rules. */
  _autoValueRuleCanSet(rule) {
    if (!rule.setIfDefault) return true;
    const source = this._fieldSources && this._fieldSources[rule.target];
    return source === 'default' || source === 'auto';
  },

  _autoValueTargetCanReset(target) {
    const guarded = this._autoValueRules.find(rule => rule.target === target && rule.setIfDefault);
    return !guarded || this._autoValueRuleCanSet(guarded);
  },

  /** Apply autoValue rules once based on current form state (no watcher side-effects). */
  _applyInitialAutoValues() {
    if (!this._autoValueRules || this._autoValueRules.length === 0) return;
    const targets = new Set(this._autoValueRules.map(rule => rule.target));
    targets.forEach(target => {
      const matched = this._autoValueRules.find(
        rule => rule.target === target && this._matchAutoValueRule(rule)
      );
      if (matched && matched.set !== null && matched.set !== undefined) {
        if (this._autoValueRuleCanSet(matched)) {
          this.form[matched.target] = matched.set;
          this._setFieldSource(matched.target, 'auto');
          this.formDefaults[matched.target] = matched.set;
        }
      }
    });
  },

  setupAutoValueWatchers() {
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._autoValueWatchers) { this._autoValueWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this._autoValueWatchers = [];
    // Collect all autoValue rules from all visible fields
    const rules = [];
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.autoValue && Array.isArray(f.autoValue)) {
        f.autoValue.forEach(r => rules.push({
          target: r.setTarget || f.key,
          defaultVal: f.default,
          watch: r.watch,
          when: r.when,
          set: r.set,
          setIfDefault: r.setIfDefault === true,
        }));
      }
    }));
    this._autoValueRules = rules;
    if (rules.length === 0) return;

    const self = this;
    // Collect all unique watched field keys
    const allWatchedKeys = new Set();
    rules.forEach(r => {
      if (r.watch && typeof r.watch === 'object' && !Array.isArray(r.watch)) {
        Object.keys(r.watch).forEach(k => allWatchedKeys.add(k));
      } else {
        allWatchedKeys.add(r.watch);
      }
    });

    // Register a watcher for each unique watched key
    allWatchedKeys.forEach(watchKey => {
      self._autoValueWatchers.push(self.$watch('form.' + watchKey, function() {
        // Find all target fields affected by this watchKey
        const affectedTargets = new Set();
        rules.forEach(r => {
          if (r.watch && typeof r.watch === 'object' && !Array.isArray(r.watch)) {
            if (watchKey in r.watch) affectedTargets.add(r.target);
          } else if (r.watch === watchKey) {
            affectedTargets.add(r.target);
          }
        });

        affectedTargets.forEach(target => {
          // Find the first matching rule for this target
          const matched = self._autoValueRules.find(x => x.target === target && self._matchAutoValueRule(x));
          if (matched) {
            if (matched.set !== null && matched.set !== undefined) {
              if (self._autoValueRuleCanSet(matched)) {
                self.form[matched.target] = matched.set;
                self._setFieldSource(matched.target, 'auto');
                self.formDefaults[matched.target] = matched.set;
              }
            }
          } else if (self._autoValueTargetCanReset(target)) {
            // No rule matches → restore default (also update formDefaults)
            const field = self.findFieldDef(target);
            const defVal = field ? field.default : (self.formDefaults[target]);
            if (field) self.form[target] = defVal;
            self.formDefaults[target] = defVal;
            self._setFieldSource(target, 'default');
          }
        });

        // Re-evaluate conditional visibility for all affected targets
        affectedTargets.forEach(target => {
          if (self._allShowIfKeys().indexOf(target) !== -1) {
            self.showConditionalFields(target);
          }
        });

        // Update readonly states after auto_value changes
        self.updateReadonlyStates();
      }));
    });

    // Apply initial auto_value state
    this._applyInitialAutoValues();
  },

  // ── Show If Watchers: listen for parent field changes to show/hide children ──
  setupShowIfWatchers() {
    const self = this;
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._showIfWatchers) { this._showIfWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this._showIfWatchers = [];
    this._allShowIfKeys().forEach(k => {
      // Use a named function for clarity; Alpine re-evaluates on change
      self._showIfWatchers.push(self.$watch('form.' + k, () => self.showConditionalFields(k)));
    });
  },

  // ── Readonly If: disable fields based on conditions ──
  _allReadonlyIfKeys() {
    const keys = new Set();
    const collect = clause => {
      if (Array.isArray(clause)) {
        clause.forEach(collect);
      } else if (clause && clause.key) {
        keys.add(clause.key);
      }
    };
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.readonlyIf) keys.add(f.readonlyIf.key);
      if (f.readonlyIfAny && Array.isArray(f.readonlyIfAny)) {
        f.readonlyIfAny.forEach(collect);
      }
    }));
    return [...keys];
  },

  setupReadonlyWatchers() {
    const self = this;
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._readonlyWatchers) { this._readonlyWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this._readonlyWatchers = [];
    this._allReadonlyIfKeys().forEach(k => {
      self._readonlyWatchers.push(self.$watch('form.' + k, () => self.updateReadonlyStates()));
    });
    // Also watch model_train_type for multi-condition auto_value
    self._readonlyWatchers.push(self.$watch('form.model_train_type', () => self.updateReadonlyStates()));
    // Initial apply
    self.updateReadonlyStates();
  },

  updateReadonlyStates() {
    const self = this;
    // 公用 apply 函数：根据 met 决定启用/解除 readonly 态（含告警文本注入）。
    // 由 [data-readonly-if-key]（单 key eq/neq）与 [data-readonly-if-any]（多 key，任一成立即锁定）复用。
    const apply = (row, met, reasonKey) => {
      // Always apply full state (idempotent) to handle re-renders correctly
      if (met) {
        row.setAttribute('data-readonly-if-active', '1');
        row.classList.add('field-readonly');
        row.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = true; });
        row.querySelectorAll('.stepper button').forEach(el => { el.disabled = true; });
        row.querySelectorAll('.field-actions .btn-icon').forEach(el => { el.disabled = true; el.style.pointerEvents = 'none'; });
        row.querySelectorAll('.anima-select').forEach(sel => { sel.style.pointerEvents = 'none'; sel.style.opacity = '0.55'; });
        // Ensure warning text exists (deduplicate: remove any stale ones first)
        const text = reasonKey ? self.t(reasonKey) : '';
        // Remove ALL existing warnings in this row to avoid duplication
        row.querySelectorAll('.field-readonly-warn').forEach(el => el.remove());
        if (text) {
          const warnEl = document.createElement('div');
          warnEl.className = 'field-readonly-warn';
          warnEl.textContent = text;
          // Insert after .field-row, or at end of row
          const anchor = row.querySelector('.field-row') || row;
          anchor.parentNode === row ? row.appendChild(warnEl) : anchor.parentNode.insertBefore(warnEl, anchor.nextSibling);
        }
      } else {
        row.removeAttribute('data-readonly-if-active');
        row.classList.remove('field-readonly');
        row.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = false; });
        row.querySelectorAll('.stepper button').forEach(el => { el.disabled = false; });
        row.querySelectorAll('.field-actions .btn-icon').forEach(el => { el.disabled = false; el.style.pointerEvents = ''; });
        row.querySelectorAll('.anima-select').forEach(sel => { sel.style.pointerEvents = ''; sel.style.opacity = ''; });
        const warnEl = row.querySelector('.field-readonly-warn');
        if (warnEl) warnEl.remove();
      }
    };

    // 单 key readonly_if：eq/neq/or
    document.querySelectorAll('[data-readonly-if-key]').forEach(row => {
      const key = row.getAttribute('data-readonly-if-key');
      const eqVal = row.getAttribute('data-readonly-if-eq');
      const orVals = (row.getAttribute('data-readonly-if-or') || '').split(',').filter(Boolean);
      const neqVal = row.getAttribute('data-readonly-if-neq');
      const parentVal = self.form[key];

      let met = false;
      if (eqVal !== null) {
        met = String(parentVal) === eqVal;
        if (!met && orVals.length > 0) met = orVals.indexOf(String(parentVal)) !== -1;
      } else if (neqVal !== null) {
        met = String(parentVal) !== neqVal && String(parentVal) !== 'null' && String(parentVal) !== 'undefined' && String(parentVal) !== '';
      }
      apply(row, met, row.getAttribute('data-readonly-if-reason'));
    });

    // readonlyIfAny is OR across clauses; nested arrays are AND groups.
    document.querySelectorAll('[data-readonly-if-any]').forEach(row => {
      let conds = [];
      try { conds = JSON.parse(row.getAttribute('data-readonly-if-any') || '[]'); } catch (e) { /* 防御损坏 */ }
      const met = self._readonlyIfAnyMet(conds);
      apply(row, met, row.getAttribute('data-readonly-if-reason'));
    });
  },

  _readonlyIfAnyMet(clauses) {
    return Array.isArray(clauses) && clauses.some(clause => (
      Array.isArray(clause)
        ? clause.every(condition => this._evalShowIfCond(condition))
        : this._evalShowIfCond(clause)
    ));
  },

  // esc() 定义在 utils.js（跨模块共享，monitor/environment 渲染层同样依赖）。
  // Canonical HTML escape for '-delimited attributes (also escapes single quotes).
  escapeAttr(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  // JS string escape for embedding values into @click="func('...')" etc.
  escapeJsString(s) { if (s == null) return ''; return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029'); },
  escJson(obj) { try { return btoa(new TextEncoder().encode(JSON.stringify(obj)).reduce((s,b)=>s+String.fromCharCode(b),'')); } catch (e) { console.error('escJson failed:', e); return btoa('{"options":[]}'); } },

  /** Coerce a string value that looks like a number into an actual number for TOML/API.
   *  Returns the coerced value, or the original value if not coercible. */
  _coerceNum(v) {
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
      // 注意：科学计数法（如 "1e-4"）也走 Number() 转为数值。
      // 之前刻意保留为字符串会导致 TOML 写成 learning_rate="1e-4"，
      // 而 sd-scripts 经 --config_file 读 TOML 时不重跑 argparse 的 type=float，
      // 字符串 LR 直达优化器在 step() 时触发 TypeError。
      return Number(v.trim());
    }
    return v;
  },

  _automagicFusedConflicts() {
    const conflicts = [];
    const gpuIds = this.form.gpu_ids;
    const accumulation = this.form.gradient_accumulation_steps ?? 1;
    const maxGradNorm = this.form.max_grad_norm ?? 1;
    const mixedPrecision = String(this.form.mixed_precision || 'bf16').toLowerCase();

    if (Number(accumulation) !== 1) {
      conflicts.push({ parameter: 'gradient_accumulation_steps', value: accumulation, required: 1 });
    }
    if (Number(maxGradNorm) !== 0) {
      conflicts.push({ parameter: 'max_grad_norm', value: maxGradNorm, required: 0 });
    }
    if (mixedPrecision === 'fp16') {
      conflicts.push({ parameter: 'mixed_precision', value: mixedPrecision, unsupported: true });
    }
    if (Array.isArray(gpuIds) && gpuIds.length > 1) {
      conflicts.push({ parameter: 'gpu_ids', value: gpuIds.join(','), singleGpu: true });
    }
    return conflicts;
  },

  _automagicFusedHasConflict(conflicts) {
    return (conflicts || this._automagicFusedConflicts()).length > 0;
  },

  _automagicFusedConflictText(conflicts) {
    return conflicts.map(conflict => {
      let key = 'field.automagic_fusedConflictValue';
      if (conflict.unsupported) key = 'field.automagic_fusedConflictUnsupported';
      else if (conflict.singleGpu) key = 'field.automagic_fusedConflictSingleGpu';
      return this.t(key)
        .replace('{parameter}', conflict.parameter)
        .replace('{value}', String(conflict.value))
        .replace('{required}', String(conflict.required ?? ''));
    }).join(this.t('field.automagic_fusedConflictSeparator'));
  },

  _enforceEmosensUiConstraints(changedKey, previousConstraints = null) {
    const optimizerType = 'vendor.emo_optimizer.emosens.EmoSens';
    if (this.form.optimizer_type !== optimizerType) return;

    const adjustments = [];
    // Alpine auto-value watchers can run as soon as optimizer_type changes. Keep
    // the pre-change values so the user still sees why a value was corrected.
    const accumulation = previousConstraints?.gradient_accumulation_steps
      ?? this.form.gradient_accumulation_steps ?? 1;
    if (Number(accumulation) !== 1) {
      adjustments.push({ parameter: 'gradient_accumulation_steps', value: accumulation, required: 1 });
      this.form.gradient_accumulation_steps = 1;
    }

    const mixedPrecision = String(
      previousConstraints?.mixed_precision ?? this.form.mixed_precision ?? 'bf16'
    ).toLowerCase();
    if (mixedPrecision === 'fp16') {
      adjustments.push({ parameter: 'mixed_precision', value: mixedPrecision, required: 'bf16' });
      this.form.mixed_precision = 'bf16';
    }

    if (adjustments.length > 0) {
      const details = adjustments.map(item => this.t('field.emosensAdjustedValue')
        .replace('{parameter}', item.parameter)
        .replace('{value}', String(item.value))
        .replace('{required}', String(item.required)))
        .join(this.t('field.emosensConstraintSeparator'));
      this.toast(this.t('field.emosensAutoAdjusted').replace('{details}', details), 'warning');
    }

    const gpuIds = this.form.gpu_ids;
    if ((changedKey === 'optimizer_type' || changedKey === 'gpu_ids') &&
        Array.isArray(gpuIds) && gpuIds.length > 1) {
      this.toast(
        this.t('field.emosensMultiGpuConflict').replace('{value}', gpuIds.join(',')),
        'warning'
      );
    }
  },

  setField(key, value) {
    if (key === 'dataset_cache_dir' && this.form.model_train_type === 'krea2-lora') {
      value = this._deriveKrea2CacheDir(this.form.train_data_dir);
    }
    const oldVal = this.form[key];
    if (oldVal === value) {
      this._setFieldSource(key, 'user');
      this._persistProfileFieldSources();
      return;
    }
    if (key === 'model_train_type' && !this._switchInProgress) {
      this._scheduleTrainTypeSwitch(value);
      return;
    }
    if (typeof this.formDefaults[key] === 'number' && value !== '' && value !== null) {
      const numVal = Number(value);
      if (!isNaN(numVal)) value = numVal;
    }

    // Enforce min/max bounds on number fields (skip empty/unset — means "disabled")
    const field = this.findFieldDef(key);
    if (field && field.type === 'number') {
      const constraints = this._numberConstraints(field);
      if (value === '' || value === null || value === undefined) {
        // preserve empty/unset — signals sd-scripts "not used"
      } else {
        const numVal = Number(value);
        if (!isNaN(numVal)) {
          if (constraints.min !== undefined && numVal < constraints.min) value = constraints.min;
          if (constraints.max !== undefined && numVal > constraints.max) value = constraints.max;
        }
      }
    }

    if ((key === 'cache_text_encoder_outputs' || key === 'cache_text_encoder_outputs_to_disk') && value === true) {
      const hasShuffleConflict = this.form.shuffle_caption === true;
      const hasTagDropoutConflict = Number(this.form.caption_tag_dropout_rate || 0) > 0;
      const hasSdxlDropoutConflict = this.form.model_train_type === 'sdxl-lora' && Number(this.form.caption_dropout_rate || 0) > 0;
      if (hasShuffleConflict || hasTagDropoutConflict || hasSdxlDropoutConflict) {
        this.toast(this.t('field.cache_text_encoder_outputsLocked'), 'warning');
        this.form[key] = false;
        return;
      }
    }

    const emosensPreviousConstraints = key === 'optimizer_type' &&
      value === 'vendor.emo_optimizer.emosens.EmoSens'
      ? {
        gradient_accumulation_steps: this.form.gradient_accumulation_steps,
        mixed_precision: this.form.mixed_precision,
      }
      : null;

    this.form[key] = value;
    this._setFieldSource(key, 'user');
    if (key === 'timestep_sampling') {
      this._refreshSubsetTimestepEditor();
    }
    if (this.timestepPreviewOpen && [
      'timestep_sampling', 'sigmoid_scale', 'discrete_flow_shift', 'weighting_scheme',
      'logit_mean', 'logit_std', 'mode_scale', 'resolution'
    ].includes(key)) {
      this.refreshTimestepPreview();
    }
    if (key === 'cache_latents_to_disk' && oldVal !== true && value === true) {
      this.form.cache_latents = true;
      this._setFieldSource('cache_latents', 'auto');
    }
    if (typeof this.queueTomlPreviewChange === 'function') this.queueTomlPreviewChange(key);
    if (key === 'train_data_dir') this._syncKrea2CacheDir();
    if (key === 'optimizer_type' || key === 'gradient_accumulation_steps' ||
        key === 'mixed_precision' || key === 'gpu_ids') {
      this._enforceEmosensUiConstraints(key, emosensPreviousConstraints);
    }
    const fusedInputs = ['automagic_fused', 'gradient_accumulation_steps', 'max_grad_norm', 'mixed_precision', 'gpu_ids'];
    const fusedConflicts = fusedInputs.includes(key) && this.form.automagic_fused
      ? this._automagicFusedConflicts()
      : [];
    if (this._automagicFusedHasConflict(fusedConflicts)) {
      this.form.automagic_fused = false;
      const details = this._automagicFusedConflictText(fusedConflicts);
      const message = this.t('field.automagic_fusedAutoDisabled').replace('{details}', details);
      this.toast(message, 'warning');
    }
    if (key === 'output_dir' || key === 'output_name' || key === 'resume') {
      this.scheduleOutputPathInfo();
    }
    this.pushHistory({ ...this.form });
    if (this._allShowIfKeys().indexOf(key) !== -1) this.showConditionalFields(key);

    // 学习率 ↔ 训练开关联动（与 adapter.py 同步）：
    // sd-scripts 取值链：unet_lr/text_encoder_lr 非空 → 覆盖 learning_rate；为空 → 回退 learning_rate。
    // 故把"被开关排除的部分"对应的分量学习率清空，让 learning_rate 成为唯一生效的总学习率，
    // 也避免把不参与训练的分量的残留值写进 TOML（误导用户以为生效）。
    //   unet_only=true     → 清空 text_encoder_lr（不训练文本编码器）
    //   text_encoder_only=true → 清空 unet_lr（不训练 U-Net）
    //   两者都 false（训练两者）→ 分量各保留，learning_rate 仅作未填分量的回退值
    const _setLRField = (k, v) => {
      // 仅在值变化时改，避免触发无意义的响应式更新与递归 watcher
      if (this.form[k] !== v) {
        this.form[k] = v;
        this._setFieldSource(k, 'auto');
        // 同步 formDefaults，使复位/对比逻辑一致（与 autoValue 处理同款）
        this.formDefaults[k] = v;
      }
    };
    if (key === 'network_train_unet_only' && value === true) {
      this.form['network_train_text_encoder_only'] = false;
      _setLRField('text_encoder_lr', '');
    }
    if (key === 'network_train_text_encoder_only' && value === true) {
      this.form['network_train_unet_only'] = false;
      _setLRField('unet_lr', '');
    }
    // When enabling cache_text_encoder_outputs, force network_train_unet_only = true
    if (key === 'cache_text_encoder_outputs' && value === true) {
      this.form['network_train_unet_only'] = true;
      this.form['network_train_text_encoder_only'] = false;
      _setLRField('text_encoder_lr', '');
    }
    if (key === 'cache_text_encoder_outputs' && value === false) {
      this.form['cache_text_encoder_outputs_to_disk'] = false;
    }
    if (key === 'cache_text_encoder_outputs_to_disk' && value === true) {
      this.form['cache_text_encoder_outputs'] = true;
      this.form['network_train_unet_only'] = true;
      this.form['network_train_text_encoder_only'] = false;
      _setLRField('text_encoder_lr', '');
    }
    // Caption 互斥项开启 → 自动关掉 cache_text_encoder_outputs（连 to_disk 一起关，
    // 否则后端兜底会因 to_disk=true 强制 cache=true 与 shuffle 冲突）。
    // sd-scripts is_text_encoder_output_cacheable() 在 shuffle_caption 或 caption_tag_dropout_rate>0 时返回 false。
    if (key === 'shuffle_caption' && value === true && this.form['cache_text_encoder_outputs']) {
      this.form['cache_text_encoder_outputs'] = false;
      this.form['cache_text_encoder_outputs_to_disk'] = false;
    }
    if (key === 'caption_tag_dropout_rate' && Number(value) > 0 && this.form['cache_text_encoder_outputs']) {
      this.form['cache_text_encoder_outputs'] = false;
      this.form['cache_text_encoder_outputs_to_disk'] = false;
    }
    if (key === 'caption_dropout_rate' && this.form.model_train_type === 'sdxl-lora' && Number(value) > 0 && this.form['cache_text_encoder_outputs']) {
      this.form['cache_text_encoder_outputs'] = false;
      this.form['cache_text_encoder_outputs_to_disk'] = false;
    }

    // Clear error for this field on change and re-render to update UI
    if (this.formErrors && this.formErrors[key]) {
      this.formErrors[key] = null;
      this.renderTrainingForm(this.form.model_train_type || 'anima-lora', null, true);
      return;
    }
    this.updateTomlDebounced();
  },

  stepField(key, delta) {
    const current = Number(this.form[key]) || 0;
    const field = this.findFieldDef(key);
    const constraints = this._numberConstraints(field);
    const step = constraints.step || 1;
    let newVal = current + delta;
    if (constraints.min !== undefined && newVal < constraints.min) newVal = constraints.min;
    if (constraints.max !== undefined && newVal > constraints.max) newVal = constraints.max;
    // Fix floating-point drift (e.g. 0.1 + 0.2 = 0.30000000000000004)
    const decimals = (String(step).split('.')[1] || '').length;
    newVal = Number(newVal.toFixed(decimals));
    this.setField(key, newVal);
  },

  findFieldDef(key) {
    const sections = this._allSections();
    for (const s of sections) {
      const f = s.fields.find(x => x.key === key);
      if (f) return f;
    }
    return null;
  },

  // ── Nest level: depth of explicit/conditional layout ancestry ──
  // 一个字段的层级 = 其布局父字段层级 + 1；无则为 0。
  // 用于递增缩进与左边框深浅，让"开关→选项→子选项"层级一眼可读。
  _nestLevelCache: null,
  _nestLevel(field) {
    if (!this._fieldLayoutParentKey(field)) return 0;
    // 构建一次 key→field 映射，避免重复遍历（render 时调用频繁）
    if (!this._nestLevelCache) {
      const map = {};
      this._allSections().forEach(s => s.fields.forEach(f => { map[f.key] = f; }));
      this._nestLevelCache = map;
    }
    let level = 0;
    let cur = field;
    const guard = new Set();
    while (cur && this._fieldLayoutParentKey(cur) && !guard.has(cur.key)) {
      guard.add(cur.key);
      level += 1;
      const parentKey = this._fieldLayoutParentKey(cur);
      cur = parentKey ? this._nestLevelCache[parentKey] : undefined;
    }
    return level;
  },

  undoField(key) {
    if (this.formHistoryIdx <= 0) return;
    // Walk back through history to find the most recent entry where this key differs
    for (let i = this.formHistoryIdx - 1; i >= 0; i--) {
      const entry = this.formHistory[i];
      if (key in entry && entry[key] !== this.form[key]) {
        this.form[key] = entry[key];
        this._setFieldSource(key, 'user');
        this._persistProfileFieldSources();
        this.formHistoryIdx = i;
        this.updateToml();
        return;
      }
    }
    // No different value found → restore to default
    const def = this._currentEffectiveFieldDefault(key);
    this.form[key] = def !== undefined ? def : '';
    this._setFieldSource(key, 'user');
    this._persistProfileFieldSources();
    this.updateToml();
  },

  _currentProfileFieldDefault(key) {
    const trainType = this.form.model_train_type || this._activeTrainType || 'anima-lora';
    const defaults = this._buildFormDefaults(trainType);
    return Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : '';
  },

  _currentEffectiveFieldDefault(key) {
    const profileDefault = this._currentProfileFieldDefault(key);
    const rules = Array.isArray(this._autoValueRules) ? this._autoValueRules : [];
    const matched = rules.find(rule =>
      rule.target === key && this._matchAutoValueRule(rule)
    );
    return matched && matched.set !== null && matched.set !== undefined
      ? matched.set
      : profileDefault;
  },

  resetField(key) {
    // formDefaults may reflect imported values. "Reset to default"
    // must use the active dependency-aware default. Optimizer fields commonly
    // replace the static registry default through autoValue rules.
    const def = this._currentEffectiveFieldDefault(key);
    const matched = (Array.isArray(this._autoValueRules) ? this._autoValueRules : []).find(rule =>
      rule.target === key && this._matchAutoValueRule(rule)
    );
    const value = def !== undefined ? def : '';
    const unchanged = this.form[key] === value;
    this.setField(key, value);
    this.formDefaults[key] = value;
    if (matched && matched.set !== null && matched.set !== undefined) {
      this._setFieldSource(key, 'auto');
    } else {
      this._setFieldSource(key, 'default');
    }
    this._persistProfileFieldSources();
    if (unchanged) {
      if (typeof this.queueTomlPreviewChange === 'function') this.queueTomlPreviewChange(key);
      if (typeof this.updateToml === 'function') this.updateToml();
    }
  },

  resetAllParams() {
    // 始终从当前训练类型的 registry 字段定义重新构建，不复用可能已被
    // 导入配置或参数联动修改过的 formDefaults。
    const currentTrainType = this.form.model_train_type;
    const profileDefaults = this._buildFormDefaults(currentTrainType);
    this.formDefaults = { ...profileDefaults };
    this.form = { ...profileDefaults, model_train_type: currentTrainType };
    this._replaceProfileFieldSources(currentTrainType, profileDefaults);
    if (currentTrainType === 'krea2-lora') {
      this._applyKrea2ModelDefaults(this.form, profileDefaults);
    }
    this._normalizeProfileSelectValues(currentTrainType, profileDefaults);

    // Adjust network_module based on train type
    const targetNetworkModule = currentTrainType === 'anima-lora'
      ? 'networks.lora_anima'
      : (currentTrainType === 'krea2-lora' ? 'networks.lora_krea2' : 'networks.lora');
    this.form.network_module = targetNetworkModule;
    this._applyInitialAutoValues();
    this._activeTrainType = currentTrainType;
    this._syncKrea2CacheDir();
    this._captureProfileDraft(currentTrainType, this.form, profileDefaults);
    this._persistProfileDrafts();
    this._persistProfileFieldSources();

    this.formHistory = [{ ...this.form }];
    this.formHistoryIdx = 0;
    this.updateToml();
    this.rebuildForm();

    // Ensure network_module is correct after rebuild
    this.$nextTick(() => {
      this.form.network_module = targetNetworkModule;
      this._captureProfileDraft(currentTrainType, this.form, profileDefaults);
      this._persistProfileDrafts();
      this._persistProfileFieldSources();
      this.updateToml();
    });

    this.toast(this.t('common.allReset'));
  },

  pushHistory(state) {
    this.formHistory = this.formHistory.slice(0, this.formHistoryIdx + 1);
    this.formHistory.push(state);
    if (this.formHistory.length > 50) this.formHistory.shift();
    this.formHistoryIdx = this.formHistory.length - 1;
  },

  rebuildForm() {
    const r = this.currentRoute;
    if (!r || !r.startsWith('train-')) return;
    const activeType = this.form.model_train_type || 'anima-lora';
    const profileDefaults = this._buildFormDefaults(activeType);
    this._normalizeProfileSelectValues(activeType, profileDefaults);
    this._normalizeProfileSelectValues(activeType, profileDefaults, this.formDefaults);
    // Re-apply autoValue rules so select fields, locked fields etc. stay consistent
    // after config import or full reset.
    this._applyInitialAutoValues();
    const cachePathChanged = this._syncKrea2CacheDir();
    this.renderTrainingForm(activeType);
    this.updateReadonlyStates();
    if (cachePathChanged) this.updateToml();
  },

  // ── Validation ────────────────────────────────────────
  validateForm() {
    const errors = {};
    // Check all required fields
    const currentGroup = window.TRAIN_GROUP_MAP[this.form.model_train_type || 'anima-lora'] || 'all';
    const sections = this._allSections();
    for (const section of sections) {
      for (const field of section.fields) {
        const isFieldRequired = field.required ||
          (field.requiredGroups && Array.isArray(field.requiredGroups) && field.requiredGroups.includes(currentGroup));
        if (!isFieldRequired) continue;
        const val = this.form[field.key];
        if (val === undefined || val === null || val === '') {
          errors[field.key] = this.t('common.fieldRequired');
        }
      }
    }
    // Cross-field: min_bucket_reso <= max_bucket_reso
    if (this.form.enable_bucket) {
      const minR = Number(this.form.min_bucket_reso);
      const maxR = Number(this.form.max_bucket_reso);
      if (!isNaN(minR) && !isNaN(maxR) && minR > maxR) {
        errors.min_bucket_reso = this.t('common.minBucketResoError');
      }
    }
    // Cross-field: min_timestep < max_timestep (Anima)
    // 注意：min_timestep/max_timestep 默认都是空串（registry 无显式默认 / default=""）。
    // Number('') === 0 而非 NaN，必须先排除空串/非数字字符串，否则两个空值会被当作 0>=0 误判为错误。
    const minTsRaw = this.form.min_timestep;
    const maxTsRaw = this.form.max_timestep;
    if (minTsRaw !== '' && minTsRaw !== null && minTsRaw !== undefined &&
        maxTsRaw !== '' && maxTsRaw !== null && maxTsRaw !== undefined) {
      const minT = Number(minTsRaw);
      const maxT = Number(maxTsRaw);
      if (!isNaN(minT) && !isNaN(maxT) && minT >= maxT) {
        errors.min_timestep = this.t('common.minTimestepError');
      }
    }

    // Anima mode: vae and qwen3 are required
    if (String(this.form.model_train_type) === 'anima-lora') {
      if (!this.form.vae || String(this.form.vae).trim() === '') {
        errors['vae'] = window.t('common.vaeRequired');
      }
      if (!this.form.qwen3 || String(this.form.qwen3).trim() === '') {
        errors['qwen3'] = window.t('common.qwen3Required');
      }
    }

    this.formErrors = errors;
    const hasErrors = Object.keys(errors).length > 0;
    if (hasErrors) {
      this.renderTrainingForm(this.form.model_train_type || 'anima-lora', null, true);
    }
    return !hasErrors;
  },

  // ── File Pickers ───────────────────────────────────────
  async localFilePicker(key, role) {
    let type = 'folder';
    if (role==='file-model'||role==='file-model-saved') type='model-file';
    try {
      const r = await fetch('/api/pick_file?picker_type='+type);
      const d = await r.json();
      if (d.status==='success'&&d.data&&d.data.path) {
        this.setField(key, d.data.path);
      } else {
        // 非 success：后端用 message 区分"unavailable"(tkinter 不可用) 与 "cancelled"(用户取消)。
        // 给出反馈，避免点击后毫无响应被误认为"不生效"。
        const msg = String(d.message || '');
        if (msg.indexOf('unavailable') !== -1) {
          this.toast(this.t('common.localPickerNA'), 'error');
        } else {
          this.toast(this.t('common.localPickerCancelled'));
        }
      }
    } catch(e) { this.toast(this.t('common.localPickerNA'), 'error'); }
  },

  async builtinFilePicker(key, role) {
    let pickType = 'model-file';
    if (role==='file-folder') pickType='train-dir';
    if (role==='file-model') pickType='model-file';
    if (role==='file-model-saved') pickType='model-saved-file';
    try {
      const r = await fetch('/api/get_files?pick_type='+pickType);
      const d = await r.json();
      const files = (d.status==='success'&&d.data) ? (d.data.files||d.data) : [];
      this.showFilePickerModal(key, Array.isArray(files)?files:[], pickType);
    } catch(e) { this.toast(this.t('common.fileBrowserFailed')); }
  },

  // 与后端 get_files 的扫描根目录保持一致，用于弹窗上下文显示与子目录分组
  PICKER_ROOTS: { 'model-file': './models', 'model-saved-file': './output', 'train-dir': './train' },

  showFilePickerModal(key, files, pickType) {
    this._pickerKey = key;
    this._pickerFiles = files || [];
    this._pickerFilter = '';
    this._pickerKind = pickType || '';
    this._pickerRoot = this.PICKER_ROOTS[pickType] || '';
    this._pickerCurrent = this._normalizePickerPath(this.form[key]);
    this.showFilePickerModalFlag = true;
    // 键盘高亮初始落在当前值所在行，并滚动到它
    const cur = this._pickerCurrent;
    this._pickerIndex = cur ? this.filteredPickerFiles.findIndex(f => this._normalizePickerPath(f.path) === cur) : -1;
    this.$nextTick(() => {
      const inp = document.getElementById('pickerFilterInput');
      if (inp) inp.focus();
      const active = document.querySelector('.picker-row.is-current');
      if (active) active.scrollIntoView({ block: 'center' });
    });
  },

  _normalizePickerPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  },

  pickerIsCurrent(f) {
    return !!this._pickerCurrent && this._normalizePickerPath(f.path) === this._pickerCurrent;
  },

  get filteredPickerFiles() {
    const filter = (this._pickerFilter || '').toLowerCase();
    if (!filter) return this._pickerFiles || [];
    return (this._pickerFiles || []).filter(f => f.name.toLowerCase().includes(filter));
  },

  // 按扫描根目录下的子目录分组；全部直接在根目录时只有一组（不显示分组头）
  get pickerGroups() {
    const byDir = new Map();
    for (const f of this.filteredPickerFiles) {
      const dir = this._pickerRelDir(f.path);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    const dirs = [...byDir.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    return dirs.map(d => ({ dir: d, files: byDir.get(d) }));
  },

  _pickerRelDir(path) {
    let p = String(path || '');
    const root = String(this._pickerRoot || '');
    if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1);
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '' : p.slice(0, idx);
  },

  // 注意：这些方法依赖 this.t()，不能写成 getter——测试会用 Object.assign 展开
  // mixin，getter 会在展开时被立即调用（此时 this 上还没有 t），直接抛错。
  pickerTitle() {
    return this.t('common.pickerSelect', 'Select') + ' ' + this._pickerFieldLabel(this._pickerKey);
  },

  // 与 renderField 的标签解析同规则：优先训练类型专属 descKey
  _pickerFieldLabel(key) {
    const trainType = this.form.model_train_type || 'anima-lora';
    const field = this._fieldDefinition(key, trainType);
    if (!field || !field.descKey) return key || '';
    const suffix = trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : '');
    const specific = this.t(field.descKey + suffix);
    if (specific && specific !== field.descKey + suffix) return specific;
    return this.t(field.descKey) || key || '';
  },

  pickerContextText() {
    const n = this.filteredPickerFiles.length;
    const unit = this._pickerKind === 'train-dir'
      ? this.t('common.pickerFolderUnit', 'folders')
      : this.t('common.pickerFileUnit', 'files');
    return (this._pickerRoot || '') + ' · ' + n + ' ' + unit;
  },

  // 底部计数：仅在筛选时显示“命中/总数”，未筛选时头部已有目录与总数，不重复展示
  pickerCountText() {
    const total = (this._pickerFiles || []).length;
    const n = this.filteredPickerFiles.length;
    if (!this._pickerFilter || n === total) return '';
    const unit = this._pickerKind === 'train-dir'
      ? this.t('common.pickerFolderUnit', 'folders')
      : this.t('common.pickerFileUnit', 'files');
    return n + ' / ' + total + ' ' + unit;
  },

  pickerEmptyText() {
    return this.t('common.pickerEmpty', 'No files found') + (this._pickerRoot ? ' · ' + this._pickerRoot : '');
  },

  pickerSizeText(f) {
    const b = Number(f && f.size_bytes);
    if (!b || !isFinite(b) || b <= 0) return '';
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1) return (Math.round(gb * 10) / 10) + ' GB';
    const mb = b / (1024 * 1024);
    if (mb >= 1) return (Math.round(mb * 10) / 10) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  },

  // 行内第二行详情：数据集给图片/打标进度，所有条目末尾补修改时间
  pickerDetailText(f) {
    const parts = [];
    if (this._pickerKind === 'train-dir' && typeof f.images === 'number') {
      let s = f.images + ' ' + this.t('common.pickerImagesUnit', 'images');
      if (f.images > 0) s += ' · ' + (f.captioned || 0) + ' ' + this.t('common.pickerCaptionedUnit', 'captioned');
      parts.push(s);
    }
    if (f.mtime) {
      const d = this._pickerFormatDate(f.mtime);
      if (d) parts.push(this.t('common.pickerModified', 'Modified') + ' ' + d);
    }
    return parts.join(' · ');
  },

  _pickerFormatDate(ts) {
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  pickerMove(delta, e) {
    if (!this.showFilePickerModalFlag) return;
    const n = this.filteredPickerFiles.length;
    if (!n) return;
    if (e) e.preventDefault();
    let i = (typeof this._pickerIndex === 'number' ? this._pickerIndex : -1) + delta;
    if (i < 0) i = n - 1;
    if (i >= n) i = 0;
    this._pickerIndex = i;
    this.$nextTick(() => {
      const el = document.querySelector('.picker-row.is-kb-active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  },

  pickerConfirm(e) {
    if (!this.showFilePickerModalFlag) return;
    // 焦点在取消/关闭按钮上时，让按钮自身的点击行为生效
    if (e && e.target && e.target.tagName === 'BUTTON') return;
    if (e) e.preventDefault();
    const files = this.filteredPickerFiles;
    if (!files.length) return;
    let i = this._pickerIndex;
    if (typeof i !== 'number' || i < 0 || i >= files.length) i = 0;
    this.pickFileFromModal(files[i]);
  },

  pickFileFromModal(file) {
    if (!file) return;
    this.setField(this._pickerKey, file.path || file.name || '');
    this.showFilePickerModalFlag = false;
  },

  // ── Training status from the shared realtime snapshot ─────
  refreshTrainingRealtimeState() {
    if (this.realtimeSnapshot && typeof this.applyRealtimeTrainingSnapshot === 'function') {
      this.applyRealtimeTrainingSnapshot(this.realtimeSnapshot);
      return;
    }
    this.trainingBlocked = !!this.trainingActive;
    if (!this.trainingBlocked) this.activeTaskId = null;
  }
};
