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
  _activeTrainType: '',

  _trainTypePanel: null,
  _trainFieldsRevision: 0,
  _profileWatcherSetupHandle: null,
  _profileWatcherSetupUsesIdle: false,

  _formSaveTimer: null,
  _localeChangeHandler: null,
  _trainFormMountedRoute: '',
  _trainFormLocale: '',
  _trainTypeSwitchFrame: null,
  _trainTypeSwitchCommitFrame: null,
  _pendingTrainType: '',
  lrPreviewOpen: false,
  lrPreviewData: null,
  lycorisModalOpen: false,
  datasetRepeatDrafts: {},
  datasetRepeatApplying: false,
  datasetRepeatLastApplied: null,

  // Training state
  trainingBlocked: false,
  activeTaskId: null,

  trainTypes: [
    { v: 'anima-lora', l: 'Anima LoRA', dk: 'opt.model_train_type_anima-lora' },
    { v: 'moss-image-lora', l: 'MOSS-Image LoRA', dk: 'opt.model_train_type_moss-image-lora' },
    { v: 'sdxl-lora', l: 'SDXL LoRA', dk: 'opt.model_train_type_sdxl-lora' },
    { v: 'krea2-lora', l: 'Krea 2 LoRA', dk: 'opt.model_train_type_krea2-lora' },
  ],
  currentTrainTypeDesc: '',
  currentTrainTypeLabel: 'Anima LoRA',

  _clearProfileFieldWatchers() {
    this._cancelProfileFieldWatcherSetup();
    this._disposeKreaDitFormatWatcher();
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
      this.setupKreaDitFormatWatcher();
    };
    if (typeof requestIdleCallback === 'function') {
      this._profileWatcherSetupUsesIdle = true;
      this._profileWatcherSetupHandle = requestIdleCallback(setup, { timeout: 120 });
    } else {
      this._profileWatcherSetupHandle = setTimeout(setup, 0);
    }
  },

  _trainTypePanelIsReady(trainType) {
    const panel = this._trainTypePanel;
    return !!panel
      && panel.dataset.trainType === trainType
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
    // Reuse the mounted profile only; other profiles keep data drafts, not effects.
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
    if (v !== this._activeTrainType) {
      this._destroyTrainTypePanel();
      clearTimeout(this._stepEstimateTimer);
      this._stepEstimateTimer = null;
      this._stepEstimateRequestSeq += 1;
      this._stepEstimateSignature = '';
      this.stepEstimate = null;
      this.stepEstimateError = null;
      this.stepEstimateLoading = false;
    }

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

    // Keep the validated MOSS algorithm from its own draft. Krea's module
    // is musubi-specific and must never inherit an sd-scripts selection.
    const targetMod = ['moss-image-lora', 'krea2-lora'].includes(v) ? this.form.network_module : this._defaultNetworkModule(v);
    if (this.form.network_module !== targetMod) this.form.network_module = targetMod;
    this._syncKrea2CacheDir();
    this._captureProfileDraft(v, this.form, newDefaults);
    this._persistProfileDrafts();
    this._persistProfileFieldSources();
    this.formHistory = [{ ...this.form }];
    this.formHistoryIdx = 0;

    // Re-render form with new train type
    this._refreshTrainingOptionErrors();
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

  suspendTrainForm(route) {
    this._cancelKreaDitFormatCheck();
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
    this._disposeKreaDitFormatWatcher();
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

    this._destroyTrainTypePanel();
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
    this.scheduleKreaDitFormatCheck();

    return true;
  },

  // ── Training Form ──────────────────────────────────────
  buildTrainForm() {
    const r = this.currentRoute;
    if (this._resumeTrainForm(r)) { this.regApplyPendingTrainingPath?.(); return; }
    if (this._trainFormMountedRoute) this._disposeTrainForm();

    const cfg = ROUTE_CONFIG[r] || {};
    const routeTrainType = cfg.trainType || 'anima-lora';

    const savedKey = 'anima-form-' + r;
    let saved = null;
    try { const raw = localStorage.getItem(savedKey); if (raw) saved = JSON.parse(raw); } catch (e) {}
    this._profileFormDrafts = this._loadProfileDrafts(r);
    this._profileFieldSources = this._loadProfileFieldSources(r);
    this._optimizerDrafts = {};
    this._optimizerRestore = null;

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
      this._applyKrea2ModelDefaults(this.form, defaults);
    } else if (this.form.model_train_type === 'anima-lora' && this.form.network_module === 'networks.lora') {
      this.form.network_module = 'networks.lora_anima';
    } else if (this.form.model_train_type === 'sdxl-lora' && ['networks.lora_anima', 'networks.lora_generic'].includes(this.form.network_module)) {
      this.form.network_module = 'networks.lora';
    }
    this.formDefaults = { ...defaults };
    this.regApplyPendingTrainingPath?.();
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
    this._trainFormMountedRoute = r;
    this._trainFormLocale = this.locale;
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._autoValueWatchers) { this._autoValueWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    if (this._showIfWatchers) { this._showIfWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    if (this._readonlyWatchers) { this._readonlyWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this.setupAutoValueWatchers();
    this.setupShowIfWatchers();
    this.setupReadonlyWatchers();
    this.setupKreaDitFormatWatcher();
    this._captureProfileDraft(this.form.model_train_type, this.form, defaults);
    this._persistProfileDrafts(r);
    this._persistProfileFieldSources(r);
    const self = this;

    if (self._formWatcher) {
      self._formWatcher();
      self._formWatcher = null;
    }
    self._formWatcher = self.$watch('form', () => {
      self.scheduleShapeEstimate();
      self.scheduleStepEstimate();
      self.scheduleOutputPathInfo();
      clearTimeout(self._formSaveTimer);
      self._formSaveTimer = setTimeout(() => {
        self._formSaveTimer = null;
        self._captureProfileDraft(self._activeTrainType || self.form.model_train_type, self.form);
        self._persistProfileDrafts(r);
        self._persistProfileFieldSources(r);
        try { localStorage.setItem(savedKey, JSON.stringify(self.form)); } catch (e) {}
      }, 1000);
    });
    self.scheduleShapeEstimate();

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
      self._refreshTrainingOptionErrors();
      self._destroyTrainTypePanel();
      self.renderTrainingForm(activeType, null, true);
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
      self._destroyTrainTypePanel();
      self.renderTrainingForm(activeType, null, true);
      self.setupAutoValueWatchers();
      self.setupShowIfWatchers();
      self.setupReadonlyWatchers();
      self.setupKreaDitFormatWatcher();
      self.updateToml();
    };
    window.addEventListener('training-fields-loaded', self._trainingFieldsLoadedHandler);

    // Synchronize the form once from the shared realtime snapshot.
    this.refreshTrainingRealtimeState();
    this.scheduleOutputPathInfo();

    // 非阻塞静默刷新可管理扩展的环境状态，
    // 供 renderField 联动提示调用；不 await，不阻塞表单首屏。
    this.xfRefresh(true).catch(() => {});
    if (typeof this.faRefresh === 'function') this.faRefresh(true).catch(() => {});
    if (typeof this.tritonRefresh === 'function') this.tritonRefresh(true).catch(() => {});

    this.scheduleStepEstimate();
  },

  _mutateTrainingPanels(callback) {
    const alpine = window.Alpine;
    if (alpine && typeof alpine.mutateDom === 'function') {
      alpine.mutateDom(callback);
    } else {
      callback();
    }
  },

  _destroyTrainTypePanel() {
    const panel = this._trainTypePanel;
    if (!panel) return;
    const alpine = window.Alpine;
    this._mutateTrainingPanels(() => {
      if (alpine && typeof alpine.destroyTree === 'function') alpine.destroyTree(panel);
      panel.remove();
    });
    this._trainTypePanel = null;
  },

  _activateTrainTypePanel(root, trainType) {
    let panel = this._trainTypePanel;
    if (panel && panel.dataset.trainType !== trainType) {
      this._destroyTrainTypePanel();
      panel = null;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'train-type-panel';
      panel.dataset.trainType = trainType;
      this._trainTypePanel = panel;
    }
    this._mutateTrainingPanels(() => {
      if (panel.parentElement !== root) root.appendChild(panel);
    });
    return panel;
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

      html += `<div class="card" data-section="${section.key}" :class="{ 'card-collapsed': _sectionCollapsed['${section.key}'] }">`;
      html += `<div class="card-header" @click="toggleSection('${section.key}')">`;
      html += `<svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
      html += `<span>${this.t(section.titleKey) || section.titleKey}</span>`;
      html += `</div>`;
      html += `<div class="card-body" :inert="_sectionCollapsed['${section.key}']" :aria-hidden="_sectionCollapsed['${section.key}'] ? 'true' : null">`;
      if (section.key === 'training' && !targetId) html += this.renderStepEstimatePanel();

      // 按 FIELDS 顺序渲染字段：条件子项由 show_if 挂到触发字段下做层级缩进，不引入分组盒子。
      allFields.forEach(f => {
        html += this.renderField(f);
        if (f.key === 'network_module') {
          html += `<div class="lycoris-config-entry" x-show="form.network_module === 'lycoris.kohya'" x-cloak>`
            + `<button type="button" class="lycoris-config-button" @click="openLycorisConfig()">`
            + `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg><span>${this.esc(this.t('field.configureLycoris', 'Configure LyCORIS'))}</span></button>`
            + `<span class="lycoris-config-summary" x-text="lycorisSummary()"></span></div>`;
        }
        if (f.key === 'mode_scale') html += this.renderSubsetTimestepOffsets();
        // 子集重复次数挂在数据集目录字段下：repeat 就是目录名的数字前缀。
        if (f.key === 'train_data_dir') html += this.renderDatasetSubsets();
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
    this.renderLycorisPanel();
  },

  renderLycorisPanel() {
    const root = document.getElementById('lycorisConfigContent');
    if (!root) return;
    const trainType = this.form.model_train_type || 'anima-lora';
    const sections = window.getVisibleSections(trainType) || [];
    const fields = sections.flatMap(section => (section.fields || []))
      .filter(field => !field.hidden && field.lycorisGroup);
    const groups = [
      ['basic', 'field.lycorisGroupBasic'],
      ['regularization', 'field.lycorisGroupRegularization'],
      ['algorithm', 'field.lycorisGroupAlgorithm'],
      ['advanced', 'field.lycorisGroupAdvanced'],
    ];
    let html = '<div class="lycoris-panel-fields">';
    groups.forEach(([group, titleKey]) => {
      const grouped = fields.filter(field => field.lycorisGroup === group)
        .sort((a, b) => (a.lycorisOrder || 0) - (b.lycorisOrder || 0));
      if (!grouped.length) return;
      html += `<section class="lycoris-field-group"><div class="lycoris-field-group-title">${this.esc(this.t(titleKey))}</div>`;
      const groupedKeys = new Set(grouped.map(gf => gf.key));
      grouped.forEach(field => {
        // 同组内可见的布局父字段（如 dora_wd → wd_on_output）保留子项层级缩进；
        // 布局父不在本组渲染的字段（如依赖 lycoris_algo 的跨组参数）保持平级。
        const layoutParent = this._fieldLayoutParentKey(field, groupedKeys) || null;
        const panelField = {
          ...field,
          layoutParent,
          lycorisPanel: true,
          hintKey: field.hintKeyPanel || field.hintKey,
        };
        if (!layoutParent) panelField.nested = false;
        html += this.renderField(panelField);
      });
      html += '</section>';
    });
    html += '</div>';
    this._replaceTrainingFormHtml(root, html);
    this._syncAllConditionalFields();
  },

  openLycorisConfig() {
    if (this.form.network_module !== 'lycoris.kohya') return;
    this._openManagedModal('lycorisModalOpen', () => {
      this.renderLycorisPanel();
    });
  },

  closeLycorisConfig() {
    this._closeManagedModal('lycorisModalOpen');
  },

  lycorisSummary() {
    if (this.form.network_module !== 'lycoris.kohya') return '';
    const algo = this.form.lycoris_algo || 'lora';
    const preset = this.form.model_train_type === 'krea2-lora'
      ? this.t(`opt.krea_target_${this.form.krea_target_mode || 'all'}`)
      : (this.form.lycoris_preset || 'full');
    const rank = this.form.network_dim ?? '—';
    const alpha = this.form.network_alpha ?? '—';
    // dora_wd 切换算法后可能残留 true，但实际仅 lora/loha/lokr 消费（adapter 会 pop），摘要需同门控
    const dora = this.form.dora_wd === true && ['lora', 'loha', 'lokr'].includes(String(algo)) ? ' · DoRA' : '';
    const algoLabel = this._lycorisAlgoLabel(algo);
    return `${algoLabel} · ${preset} · Rank ${rank} · Alpha ${alpha}${dora}`;
  },

  // Algo select options carry a per-value i18n key (opt.lycoris_algo_*); the
  // raw value ("lora") is a TOML literal and would confuse users who only see
  // localized labels ("LoCon") in the dropdown.
  _lycorisAlgoLabel(value) {
    const defs = (window.getVisibleSections(this.form.model_train_type || 'anima-lora') || [])
      .flatMap(section => section.fields || []);
    const field = defs.find(item => item.key === 'lycoris_algo');
    const option = (field?.options || []).find(item => item.v === value);
    return option ? this.t(option.dk, option.l || value) : (value || '');
  },

  // 选项标签解析入口：表单预览、监控参数摘要共用。
  // 值可能来自历史 TOML（大小写与下拉选项不完全一致），故精确匹配失败后按小写兜底。
  _fieldOptionLabel(fieldKey, value, fallback = '') {
    const field = this._fieldDefinition(fieldKey, this.form.model_train_type || 'anima-lora');
    if (!field) return String(value ?? fallback ?? '');
    const options = [];
    if (Array.isArray(field.options)) options.push(...field.options);
    if (Array.isArray(field.groups)) {
      field.groups.forEach(group => {
        if (Array.isArray(group.options)) options.push(...group.options);
      });
    }
    const text = String(value ?? fallback ?? '');
    const option = options.find(item => String(item.v) === String(value))
      || options.find(item => String(item.v).toLowerCase() === text.toLowerCase());
    if (!option) return text;
    return this.t(option.dk, option.l || text);
  },

  _openManagedModal(stateKey, afterOpen) {
    this[stateKey] = true;
    this.$nextTick(() => {
      if (typeof afterOpen === 'function') afterOpen();
    });
  },

  _closeManagedModal(stateKey) {
    this[stateKey] = false;
  },

  // LyCORIS 面板字段在主表单渲染时追加"非 lycoris.kohya"条件：原生
  // networks.lora/loha/lokr 下这些字段留在主表单按各自 show_if 显示，
  // lycoris.kohya 下收进 LyCORIS 弹窗（弹窗内字段带 lycorisPanel 标记，不受此追加影响）。
  _lycorisMainFormConditions(field) {
    if (!field.lycorisGroup || field.lycorisPanel) return null;
    const mainOnly = { key: 'network_module', neq: 'lycoris.kohya' };
    const showIf = Array.isArray(field.showIf)
      ? field.showIf.concat(mainOnly)
      : (field.showIf ? [field.showIf, mainOnly] : (field.showIfAny ? undefined : [mainOnly]));
    const showIfAny = field.showIfAny
      ? field.showIfAny.map(group => group.concat(mainOnly))
      : field.showIfAny;
    return { showIf, showIfAny };
  },

  // LyCORIS preset files are root-level TOML documents (the kohya adapter
  // passes the selected preset name/path separately from network_args). Keep
  // this preview faithful to that schema while making the generated CLI
  // arguments explicit, so users can see both layers without changing merge
  // behavior.
  lycorisConfigPreview() {
    if (this.form.network_module !== 'lycoris.kohya') return '';
    const f = this.form;
    const algo = String(f.lycoris_algo || 'lora').toLowerCase();
    const lines = [`algo = "${algo}"`];
    if (f.model_train_type === 'krea2-lora') {
      lines.push(`krea_target_mode = ${JSON.stringify(f.krea_target_mode || 'all')}`);
      const fields = (window.getVisibleSections('krea2-lora') || []).flatMap(s => s.fields || []);
      for (const field of fields) {
        if (!this._fieldShowIfMet(field) || ['lycoris_algo', 'network_args_custom'].includes(field.key)) continue;
        if (!field.lycorisGroup && !['rank_dropout', 'module_dropout', 'krea_target_include', 'krea_target_exclude'].includes(field.key)) continue;
        const value = f[field.key];
        if (value === undefined || value === null || value === '') continue;
        lines.push(`${field.networkArg || field.key} = ${JSON.stringify(value)}`);
      }
      return lines.join('\n');
    }
    const preset = String(f.lycoris_preset || 'full');
    if (preset !== 'full') lines.push(`preset = "${preset}"`);
    if (f.lycoris_preset === 'attn-mlp' && f.lycoris_anima_sd_default === true) {
      // TOML 单引号字面量字符串不处理转义，反斜杠才会按原样进入正则模式；
      // 双引号基本字符串里的 \. 是非法 TOML 转义，加载预设文件会直接报错。
      lines.push(f.lycoris_anima_train_adaln === true
        ? "exclude_name = ['^x_embedder\\.', '^t_embedder\\.', '^final_layer\\.']"
        : "exclude_name = ['^x_embedder\\.', '^t_embedder\\.', '^final_layer\\.', '^blocks\\.[0-9]+\\.adaln_modulation_.*']");
    }
    const fields = [
      ['conv_dim', f.conv_dim], ['conv_alpha', f.conv_alpha],
      ['factor', f.lokr_factor], ['dropout', f.dropout],
      ['rank_dropout', f.rank_dropout], ['module_dropout', f.module_dropout],
    ];
    fields.forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) return;
      if (key === 'factor' && algo !== 'lokr') return;
      const field = (window.getVisibleSections(this.form.model_train_type || 'anima-lora') || [])
        .flatMap(section => section.fields || []).find(item => item.key === key);
      if (field?.default !== undefined && String(value) === String(field.default)) return;
      lines.push(`${key} = ${value}`);
    });
    const bools = [
      ['enable_conv', f.conv_dim !== '' && f.conv_dim !== null && f.conv_dim !== undefined],
      ['use_tucker', f.use_tucker], ['use_scalar', f.use_scalar],
      ['decompose_both', f.decompose_both], ['full_matrix', f.full_matrix],
      ['train_norm', f.train_norm], ['weight_decompose', f.dora_wd],
      ['wd_on_output', f.wd_on_output],
      ['bypass_mode', f.bypass_mode], ['rs_lora', f.rs_lora],
      ['unbalanced_factorization', f.unbalanced_factorization],
      ['train_llm_adapter', f.train_llm_adapter],
    ];
    const DORA_OK_ALGOS = ['lora', 'loha', 'lokr'];
    bools.forEach(([key, value]) => {
      if (key === 'wd_on_output') {
        // wd_on_output 默认即 true：仅当用户显式关闭（false）且 DoRA 生效时才写出，
        // 避免默认值恒显噪音（与 adapter.py 对 dora_wd/wd_on_output 的过滤一致）。
        if (value !== false || !f.dora_wd || !DORA_OK_ALGOS.includes(algo)) return;
        lines.push('wd_on_output = false');
        return;
      }
      if (!value) return;
      if (key === 'weight_decompose' && !DORA_OK_ALGOS.includes(algo)) return;
      if (['use_tucker', 'use_scalar', 'rs_lora'].includes(key) && !['lora', 'loha', 'lokr'].includes(algo)) return;
      if (['decompose_both', 'full_matrix', 'unbalanced_factorization'].includes(key) && algo !== 'lokr') return;
      lines.push(`${key} = true`);
    });
    return lines.join('\n');
  },

  lycorisConfigPreviewHtml() {
    const raw = this.lycorisConfigPreview();
    if (!raw) return '';
    return typeof this._highlightToml === 'function'
      ? this._highlightToml(raw.split('\n'))
      : this.esc(raw);
  },

  lycorisConfigNotes() {
    const f = this.form;
    const notes = [];
    if (f.lycoris_algo === 'lokr' && f.full_matrix) notes.push(this.t('field.lycorisNoteFullMatrixFactor'));
    if (f.train_llm_adapter) notes.push(this.t('field.lycorisNoteTrainLlmAdapter'));
    // Full Matrix 的自动触发条件取决于每一层经过 factor 分解后的尺寸，
    // 前端没有完整模型结构时不能用固定 rank（例如 16）做静态判定。
    if (f.lycoris_algo === 'lokr' && Number(f.network_dim || 0) > 0) notes.push(this.t(
      f.model_train_type === 'krea2-lora' ? 'field.krea_lokr_rankHint' : 'field.lycorisNoteDimFullMatrix'));
    return notes.join('\n');
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

  _allSections() {
    return window.getVisibleSections(this.form.model_train_type || 'anima-lora');
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

  _resolveFieldBaseHintKey(field, trainType) {
    if (!field || !field.hintKey) return '';
    const suffix = trainType === 'moss-image-lora' ? '_moss' : (trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : ''));
    if (suffix) {
      const specificKey = field.hintKey + suffix;
      const specific = this.t(specificKey);
      if (specific && specific !== specificKey) return specificKey;
    }
    return field.hintKey;
  },

  _resolveFieldHintOverrideKey(field, values) {
    if (!field) return '';
    if (field.key === 'learning_rate' && values?.optimizer_type === 'AdaFactor') {
      const prefix = values.model_train_type === 'krea2-lora' ? 'krea_' : '';
      return values[`${prefix}adafactor_relative_step`] !== false || values[`${prefix}adafactor_warmup_init`] === true
        ? 'field.learning_rateHint_adafactor_relative'
        : 'field.learning_rateHint_adafactor_manual';
    }
    if (field.key === 'network_alpha' && this._hasFullLokrFactors(values)) {
      return 'field.network_alphaHint_lokr_full';
    }
    const hintBy = field.hintKeyBy;
    if (!hintBy || !hintBy.key || !hintBy.values) return '';
    if (hintBy.key === 'lycoris_algo' && values?.network_module !== 'lycoris.kohya') return '';
    const selected = values ? values[hintBy.key] : undefined;
    return hintBy.values[String(selected)] || '';
  },

  _hasFullLokrFactors(values) {
    if (!values || values.network_module !== 'lycoris.kohya' || values.lycoris_algo !== 'lokr') {
      return false;
    }
    const groups = Array.isArray(this.shapeEstimate?.groups) ? this.shapeEstimate.groups : [];
    const lokrGroups = groups.filter(group => group && group.algo === 'lokr');
    return lokrGroups.length > 0 && lokrGroups.every(group => {
      const shapes = group.shapes || {};
      return group.w2Full === true && !Object.prototype.hasOwnProperty.call(shapes, 'lokr_w1_a');
    });
  },

  _resolveFieldHintKey(field, values, trainType) {
    return this._resolveFieldHintOverrideKey(field, values)
      || this._resolveFieldBaseHintKey(field, trainType);
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

  kreaSampleModeText() {
    if (this.form.model_train_type !== 'krea2-lora' || !this.form.enable_krea_samples) return '';
    const errors = this._kreaOptionErrors();
    if (errors.turbo_dit || errors.turbo_lora || errors.convrot_int8) {
      return this.t('krea2.sampleModeConflict');
    }
    const precision = this.form.convrot_int8 ? 'ConvRot INT8' : this.form.fp8_base ? 'FP8' : 'BF16';
    const key = String(this.form.turbo_dit || '').trim() ? 'sampleModeTurboDit'
      : String(this.form.turbo_lora || '').trim() ? 'sampleModeTurboLora' : 'sampleModeRaw';
    return this.t('krea2.' + key).replace('{precision}', precision);
  },


  renderField(field) {
    const val = this.form[field.key];
    const trainType = this.form.model_train_type || 'anima-lora';
    const trainTypeSuffix = trainType === 'moss-image-lora' ? '_moss' : (trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : ''));

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
    const accessibleKey = field.argKey || dataKey;
    const fieldAriaLabel = this.escapeAttr(`${accessibleKey}，${label}`);
    const stepDownLabel = this.escapeAttr(`${accessibleKey} ${label} 减少`);
    const stepUpLabel = this.escapeAttr(`${accessibleKey} ${label} 增加`);
    const isToggle = field.type === 'toggle';
    const isStaticReadonly = field.readonly === true;
    const staticReadonlyAttrs = isStaticReadonly ? ' readonly aria-readonly="true"' : '';
    // Text/textarea/path fields get their input on a separate row (full-width)
    const isFullWidth = field.type === 'textarea' || (field.role && field.role.startsWith('file-'));

    // ── Generate input HTML ──
    let inputHtml = '';
    if (isToggle) {
      inputHtml = `<label class="toggle"><input type="checkbox" aria-label="${fieldAriaLabel}" :checked="form.${dataKey}" @change="setField('${dataKey}', $event.target.checked)"><span class="toggle-track"><span class="toggle-thumb"></span></span></label>`;
    } else if (field.type === 'select') {
      const fc = {};
      const selectAlign = field.selectAlign === 'left' ? 'left' : 'right';
      const self = this;
      const currentTrainType = this.form.model_train_type || 'anima-lora';
      const currentGroup = window.TRAIN_GROUP_MAP[currentTrainType] || 'all';

      const resolveOption = (o) => {
        const cloned = { v: o.v, l: o.labelKey ? self.t(o.labelKey, o.l) : o.l };
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
      const triggerHtml = `<button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="toggle($event)" aria-label="${fieldAriaLabel}" aria-haspopup="listbox" :aria-expanded="open ? 'true' : 'false'"><span class="anima-select-trigger-text" x-text="selectedLabel"></span><svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
      const menuHtml = `<template x-if="open"><div class="anima-select-menu" :class="{ 'anima-select-menu-described': hasDescriptions, 'anima-select-menu-positioned': positioned }"><div class="anima-select-menu-scroll"><template x-for="(group, gIdx) in displayGroups" :key="gIdx"><div class="anima-select-group"><div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div><template x-for="opt in group.options" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)"><span class="anima-select-option-content"><span class="anima-select-option-label" x-text="opt.l" :title="opt.l"></span><span class="anima-select-option-desc" x-show="opt.d" x-text="opt.d"></span></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div></template></div></template><div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div></div></div></template>`;
      inputHtml = `<div class="anima-select" x-data="animaSelect('${this.escJson(fc)}', '${this.escapeAttr(val ?? '')}', {align:'${selectAlign}'})" @click.outside="close()" @anima-select-change="setField('${dataKey}', $event.detail.value)"><input type="hidden" aria-hidden="true" tabindex="-1" x-ref="modelInput" :value="form.${dataKey}">${triggerHtml}${menuHtml}</div>`;
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" rows="3"${staticReadonlyAttrs}></textarea>`;
      if (dataKey === "positive_prompts") {
        inputHtml += this._positivePromptCountHint(dataKey);
      }
    } else if (field.type === 'stepper' || field.type === 'number') {
      const constraints = this._numberConstraints(field);
      const sStep = constraints.step || 1;
      const defaultOnBlur = dataKey === 'lr_scheduler_timescale'
        ? ` x-data="{ editing: false }" x-effect="_syncLrTimescaleDefault(editing)" :class="{ 'is-default': ['default', 'auto'].includes(_fieldSources?.lr_scheduler_timescale) }" @focus="editing = true" @blur="editing = false; if (String(form.${dataKey} ?? '').trim() === '') resetField('${dataKey}')"` : '';
      const numberAttrs = `${constraints.min !== undefined ? ` min="${this.escapeAttr(constraints.min)}"` : ''}${constraints.max !== undefined ? ` max="${this.escapeAttr(constraints.max)}"` : ''} step="${this.escapeAttr(sStep)}"`;
      inputHtml = `<div class="stepper"><button type="button" aria-label="${stepDownLabel}" @click="stepField('${dataKey}', -${sStep})">−</button><input type="number" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"${numberAttrs}${defaultOnBlur}${staticReadonlyAttrs}><button type="button" aria-label="${stepUpLabel}" @click="stepField('${dataKey}', ${sStep})">+</button></div>`;
    } else {
      // Placeholders use the same profile defaults and auto-value rules as the form.
      const placeholders = this._optimizerAutoValueMap(field);
      if (Object.keys(placeholders).length || field.argKey) {
        const expression = JSON.stringify(placeholders).replace(/"/g, '&quot;');
        const defaultValue = JSON.stringify(field.default ?? '').replace(/"/g, '&quot;');
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" :placeholder="(${expression})[form.optimizer_type] ?? ${defaultValue}"${staticReadonlyAttrs}>`;
      } else if (field.placeholder) {
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" placeholder="${this.escapeAttr(field.placeholder)}"${staticReadonlyAttrs}>`;
      } else if (field.omitDefault && field.default !== undefined && field.default !== '' && field.default !== null) {
        // omitDefault 字段：值==默认值时不传，输入框用淡色 placeholder 提示默认值
        const _phVal = String(field.default).replace(/"/g, '&quot;');
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" placeholder="${_phVal}"${staticReadonlyAttrs}>`;
      } else {
        // DEFAULT_DIM_KEYS 字段：值==schema 原始默认值时加 is-default class，CSS 淡色模拟 placeholder 视觉
        // （假留空——值仍保留，不触发必填校验失败、不影响训练流程；改值后 class 移除恢复正常字色）
        // :class 属性用双引号包裹，内部字符串字面量必须用单引号，内部单引号转义为 \x27。
        const _dimCls = (window.DEFAULT_DIM_KEYS && window.DEFAULT_DIM_KEYS.has(dataKey) && field.default !== undefined && field.default !== '' && field.default !== null)
          ? ` :class="{ 'is-default': String(form.${dataKey}) === String('${String(field.default).replace(/'/g, '\\x27')}') }"`
          : '';
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"${_dimCls}${staticReadonlyAttrs}>`;
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
    const _menuPopupHtml = `<div class="field-menu-popup" x-ref="menu" x-show="open" :class="{ 'is-positioned': positioned }" :inert="!open" :id="$id('field-menu')" role="menu" :aria-label="t('common.fieldActions')" x-cloak><button type="button" role="menuitem" tabindex="-1" @click="undoField('${dataKey}');close()">${_undoSvg}<span>${this.t('common.undoField')}</span></button><button type="button" role="menuitem" tabindex="-1" @click="resetField('${dataKey}');close()">${_resetSvg}<span>${this.t('common.resetField')}</span></button></div>`;

    // ── Conditional display ──
    // LyCORIS 面板字段在主表单里只对原生模块（非 lycoris.kohya）显示；
    // lycoris.kohya 下它们收进 LyCORIS 弹窗（renderLycorisPanel 以 lycorisPanel 标记渲染）。
    const condField = this._lycorisMainFormConditions(field);
    const condShowIf = condField ? condField.showIf : field.showIf;
    const condShowIfAny = condField ? condField.showIfAny : field.showIfAny;
    let condClass = '';
    let condAttrs = '';
    if (condShowIf) {
      const sf = condShowIf;
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
    } else if (condShowIfAny) {
      // OR-of-ANDs: list[list[dict]] — 任一内层 AND 组全成立即显示
      condAttrs = ` data-show-if-any='${this.esc(JSON.stringify(condShowIfAny))}'`;
      const condMet = condShowIfAny.some(group => group.every(c => this._evalShowIfCond(c)));
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
    // merged 字段（优化器参数）显示真正写进 optimizer_args 的参数名，而不是内部表单键：
    // 同一时刻只显示一个优化器的参数，重名不会歧义，且这个名字与文档、日志一致。
    const displayKey = field.argKey || dataKey;
    const infoHtml = field.labelOnly
      ? `<div class="field-info"><div class="field-key">${label}${requiredMark}${docLink}</div>${field.helpKey ? `<div class="field-desc">${this.esc(this.t(field.helpKey))}</div>` : ''}</div>`
      : `<div class="field-info"><div class="field-key">${this.esc(displayKey)}${requiredMark}</div><div class="field-desc">${label}${docLink}</div></div>`;
    let controlSection = '';
    let fullWidthRow = '';
    if (isFullWidth) {
      // Textarea / path: info on top, input full-width below (outside field-row)
      controlSection = infoHtml + (field.controlActions || '');
      fullWidthRow = `<div class="field-input-row">${controlHtml}</div>`;
    } else {
      // Standard: info left, control right — single flex row
      controlSection = `${infoHtml}<div class="field-control">${controlHtml}${field.controlActions || ''}</div>`;
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
    const fieldMenuHtml = isStaticReadonly ? '' : `<div class="field-menu-wrap" x-data="actionMenu" x-id="['field-menu']" @keydown="key($event)" @click.outside="close(false)" @pointerenter="hoverEnter($event)" @pointerleave="hoverLeave()" @focusout="focusOut($event)">
          <button type="button" class="btn-menu" x-ref="trigger" :aria-label="t('common.fieldActions')" aria-haspopup="menu" :aria-expanded="open" :aria-controls="$id('field-menu')" @click="toggle()">${_dotsSvg}</button>
          ${_menuPopupHtml}
        </div>`;
    const staticReadonlyClass = isStaticReadonly ? ' field-readonly' : '';
    const hintExpr = `fieldHintText('${this.escapeAttr(dataKey)}')`;
    const hintHtml = dataKey === 'attn_mode'
      ? `<div class="field-hint" x-text="t('opt.attn_mode_' + form.attn_mode)">${this.esc(this.t('opt.attn_mode_' + val))}</div>`
      : field.hintKeyBy
      ? `<div class="field-hint" x-show="${hintExpr}" x-text="${hintExpr}">${this.esc(hint)}</div>`
      : (hint ? `<div class="field-hint">${hint}</div>` : '');
    const kreaSampleModeHtml = trainType === 'krea2-lora' && dataKey === 'enable_krea_samples'
      ? `<div class="field-hint" data-krea-sample-mode role="status" aria-live="polite" x-show="form.enable_krea_samples" x-text="kreaSampleModeText()">${this.esc(this.kreaSampleModeText())}</div>`
      : '';
    return `<div class="field${condClass}${nestedClass}${staticReadonlyClass}" :class="{ 'field-changed': String(form.${dataKey}) !== String(formDefaults.${dataKey}), 'field-filled': ${_filledExpr} }" data-field-row="${this.escapeAttr(dataKey)}"${condAttrs}${readonlyAttrs}${nestLevelAttr}>
      <div class="field-row">
        ${controlSection}
        ${fieldMenuHtml}
      </div>
      ${fullWidthRow}
      ${hintHtml}
      ${kreaSampleModeHtml}
      <div class="field-error" x-show="formErrors && formErrors.${dataKey}" x-text="formErrors.${dataKey} || ''" x-cloak></div>
      ${this._getEnvHint(dataKey)}
      ${this._getOutputPathHint(dataKey)}
      ${readonlyWarnHtml}
    </div>`;
  },

  // ── 环境联动提示：检查当前字段值依赖的后端是否已安装（Alpine 响应式）──
  // x-show 与扩展状态及 form 值联动。
  _getEnvHint(dataKey) {
    switch (dataKey) {
      case 'enable_reg_data':
        if (!['anima-lora', 'sdxl-lora'].includes(this.form.model_train_type)) return '';
        return `<div class="timestep-preview-entry"><button type="button" class="btn btn-ghost btn-sm" @click="openRegularizationFromTraining()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m21 15-5-5L5 21"/></svg><span x-text="regT('entry')"></span></button></div>`;
      case 'timestep_sampling':
        return `<div class="timestep-preview-entry">
          <button type="button" class="btn btn-ghost btn-sm" @click="openTimestepPreview()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
            <span x-text="t('timestepPreview.open')">View timestep distribution</span>
          </button>
          <span class="field-hint" x-text="t('timestepPreview.entryHint')"></span>
        </div>`;
      case 'lr_scheduler':
        return `<div class="lr-preview-entry">
          <button type="button" class="btn btn-ghost btn-sm" @click="openLrPreview()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
            <span x-text="t('lrPreview.open')">View learning-rate curve</span>
          </button>
        </div>`;
      case 'network_module':
        return this._shapePreviewEntry();
      case 'attn_mode':
        return `<div x-show="faStatus && !faStatus.installed && form.attn_mode==='flash'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintFlashNotInstalled')}</div>`
          + `<div x-show="xfStatus && !xfStatus.installed && form.attn_mode==='xformers'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'krea_attention_backend':
        return `<div x-show="faStatus && !faStatus.installed && form.krea_attention_backend==='flash_attn'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintFlashNotInstalled')}</div>`
          + `<div x-show="xfStatus && !xfStatus.installed && form.krea_attention_backend==='xformers'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'xformers':
        return `<div x-show="xfStatus && !xfStatus.installed && form.xformers" class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'compile':
        return `<div x-show="tritonStatus && !tritonStatus.installed && form.compile" class="field-hint field-hint-warn">${this.t('environment.envHintTritonNotInstalled')}</div>`;
    }
    return '';
  },

  _getOutputPathHint(dataKey) {
    if (dataKey !== 'output_dir') return '';
    return `<div class="output-path-hint" x-show="outputPathHintVisible()" :class="outputPathStatusClass()" role="status" aria-live="polite" x-cloak>
      <div class="output-path-hint-summary"><span class="output-path-hint-dot" aria-hidden="true"></span><span x-text="outputPathSummaryText()"></span></div>
    </div>`;
  },

  // positive prompts line count hint: real-time sample count below textarea
  _positivePromptCountHint(dataKey) {
    if (this.form.model_train_type === 'moss-image-lora') return '';
    var h = [];
    h.push('<div class="field-hint field-hint-warn" x-show="(form.');
    h.push(dataKey);
    h.push(" || '').split('\\n').filter(function(l){return l.trim()}).length >= 2\"");
    h.push(" x-text=\"t('field.samplePromptsCountHint').replaceAll('{n}', (form.");
    h.push(dataKey);
    h.push(" || '').split('\\n').filter(function(l){return l.trim()}).length)\"></div>");
    return h.join('');
  },

  // esc() 定义在 utils.js（跨模块共享，monitor/environment 渲染层同样依赖）。
  // Canonical HTML escape for '-delimited attributes (also escapes single quotes).
  escapeAttr(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  // JS string escape for embedding values into @click="func('...')" etc.
  escapeJsString(s) { if (s == null) return ''; return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029'); },
  escJson(obj) { try { return btoa(new TextEncoder().encode(JSON.stringify(obj)).reduce((s,b)=>s+String.fromCharCode(b),'')); } catch (e) { console.error('escJson failed:', e); return btoa('{"options":[]}'); } },

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
        if (key === 'optimizer_type') {
          this._switchOptimizer(entry[key]);
        } else {
          this.form[key] = entry[key];
          this._setFieldSource(key, 'user');
        }
        this._persistProfileFieldSources();
        this.formHistoryIdx = i;
        this.updateToml();
        return;
      }
    }
    // No different value found → restore to default
    const def = this._currentEffectiveFieldDefault(key);
    if (key === 'optimizer_type') {
      this._switchOptimizer(def !== undefined ? def : '');
    } else {
      this.form[key] = def !== undefined ? def : '';
      this._setFieldSource(key, 'user');
    }
    this._persistProfileFieldSources();
    this.updateToml();
  },

  _defaultLrTimescale() {
    const warmup = Number(this.form.lr_warmup_steps) || 0;
    const explicitSteps = this.form.model_train_type === 'krea2-lora' && this.form.krea_training_duration_mode === 'steps';
    const steps = Number(explicitSteps ? this.form.max_train_steps : this.stepEstimate?.total_steps) || 10000;
    const processes = Math.max(1, Number(this.stepEstimate?.gpu_processes)
      || (Array.isArray(this.form.gpu_ids) ? this.form.gpu_ids.length : 1));
    const warmupSteps = warmup > 0 && warmup < 1 ? Math.floor(warmup * steps * processes) : warmup;
    return warmupSteps > 0 ? warmupSteps : 10000;
  },

  _syncLrTimescaleDefault(editing = false) {
    const key = 'lr_scheduler_timescale';
    if (!Object.prototype.hasOwnProperty.call(this.form, key)) return;
    const value = this.form[key];
    const source = this._fieldSources?.[key];
    const fallback = this._defaultLrTimescale();
    if (editing) return;
    if (String(value ?? '').trim() !== '' && !['default', 'auto'].includes(source)) return;
    const changed = value !== fallback;
    if (changed) this.form[key] = fallback;
    if (source !== 'default') this._setFieldSource(key, 'default');
    if (changed) {
      if (this.lrPreviewOpen) this.refreshLrPreview();
      this.updateTomlDebounced();
    }
  },

  resetField(key) {
    // formDefaults may reflect imported values. "Reset to default"
    // must use the active dependency-aware default. Optimizer fields commonly
    // replace the static registry default through autoValue rules.
    const { value, source } = this._resolveFieldDefault(key);
    const unchanged = this.form[key] === value;
    this.setField(key, value);
    this.formDefaults[key] = value;
    this._setFieldSource(key, source);
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
    this._optimizerDrafts = { ...this._optimizerDrafts, [currentTrainType]: {} };
    this._optimizerRestore = null;
    const profileDefaults = this._buildFormDefaults(currentTrainType);
    this.formDefaults = { ...profileDefaults };
    this.form = { ...profileDefaults, model_train_type: currentTrainType };
    this._replaceProfileFieldSources(currentTrainType, profileDefaults);
    if (currentTrainType === 'krea2-lora') {
      this._applyKrea2ModelDefaults(this.form, profileDefaults);
    }
    this._normalizeProfileSelectValues(currentTrainType, profileDefaults);

    // Adjust network_module based on train type
    const targetNetworkModule = this._defaultNetworkModule(currentTrainType);
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

// Preserve computed getters when composing the training form modules.
for (const source of [
  window.trainingFieldRelations,
  window.trainingTimestepPreview,
  window.trainingConditions,
  window.trainingSections,
  window.trainingValidation,
  window.trainingProfiles,
  window.trainingPreflight,
  window.trainingFilePicker,
]) {
  Object.defineProperties(window.trainingCoreMixin, Object.getOwnPropertyDescriptors(source));
}
