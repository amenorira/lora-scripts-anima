/* ================================================================
   training-core.js — Form lifecycle, profile switching and history
   Composes focused modules into the animaApp Alpine component
   ================================================================ */

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
  datasetRepeatDrafts: {},
  datasetRepeatApplying: false,
  datasetRepeatLastApplied: null,
  datasetRepeatFailure: null,

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

  _setupTrainTypeWatcher() {
    this._trainTypeWatcher?.();
    this._trainTypeWatcher = this.$watch('form.model_train_type', (newVal, oldVal) => {
      if (newVal !== oldVal && newVal !== this._activeTrainType && !this._switchInProgress) {
        this._switchInProgress = true;
        try { this.switchTrainType(newVal); } finally { this._switchInProgress = false; }
      }
    });
  },

  switchTrainType(v) {
    this._invalidateTrainingPickers();
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
    const switchedForm = this.form;
    this.$nextTick(() => {
      if (this.form !== switchedForm || this.form.model_train_type !== v) return;
      if (this.form.network_module !== targetMod) {
        this.form.network_module = targetMod;
        this.updateToml();
      }
    });
  },

  suspendTrainForm(route) {
    this._cancelKreaDitFormatCheck();
    if (!route || !route.startsWith('train-')) return;

    this._invalidateTrainingPickers();
    this._cancelScheduledTrainTypeSwitch();
    clearTimeout(this._formSaveTimer);
    this._formSaveTimer = null;
    this._captureProfileDraft(this._activeTrainType || this.form.model_train_type, this.form);
    this._persistProfileDrafts(route);
    this._persistProfileFieldSources(route);
    try {
      localStorage.setItem('anima-form-' + route, JSON.stringify(this.form));
    } catch (e) {}

    this._cancelTrainingPreflight();
    this.stopSectionScroll();
  },

  _disposeTrainForm() {
    this._invalidateTrainingPickers();
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
    this._cancelTrainingPreflight();
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

    self._setupTrainTypeWatcher();

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

  _openManagedModal(stateKey, afterOpen) {
    this[stateKey] = true;
    this.$nextTick(() => {
      if (typeof afterOpen === 'function') afterOpen();
    });
  },

  _closeManagedModal(stateKey) {
    this[stateKey] = false;
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

  _allSections() {
    return window.getVisibleSections(this.form.model_train_type || 'anima-lora');
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

window.composeAppMixins(window.trainingCoreMixin, {
  fieldRelations: window.trainingFieldRelations, networkPanel: window.trainingNetworkPanel,
  fieldRenderer: window.trainingFieldRenderer, timestepPreview: window.trainingTimestepPreview,
  conditions: window.trainingConditions, sections: window.trainingSections,
  validation: window.trainingValidation, profiles: window.trainingProfiles,
  preflight: window.trainingPreflight, filePicker: window.trainingFilePicker,
  previewLoras: window.trainingPreviewLoras,
});
