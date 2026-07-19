/* ================================================================
   training-core.js — State, Form building, File pickers
   Mixin merged into animaApp Alpine component
   ================================================================ */

// 绿色"已填"指示条字段清单：仅这些字段在"非空且非 schema 原始默认值"时显示绿色左边条，
// 表示关键路径字段已就绪填写。优先级高于橙色 field-changed。
// 用 field.default（schema 原始默认）而非 formDefaults 做基准，不被预设/导入重置影响。
window.FILLED_INDICATOR_KEYS = new Set([
  'pretrained_model_name_or_path', 'vae', 'qwen3', 'train_data_dir',
  'output_name', 'output_dir',
]);

// 预填默认值淡色字段清单：仅这些 text 字段在"值==schema 原始默认值"时 input 字色淡化为 placeholder 视觉。
// 三个 Anima 底模字段默认指向环境管理页可下载的文件（非空），纳入此清单以提示"仍为推荐默认值"。
window.DEFAULT_DIM_KEYS = new Set([
  'pretrained_model_name_or_path', 'vae', 'qwen3',
  'train_data_dir', 'output_name', 'output_dir',
]);

window.trainingCoreMixin = {
  // ── State ──────────────────────────────────────────────
  form: {},
  formDefaults: {},
  formHistory: [],
  formHistoryIdx: -1,
  formErrors: {},

  // 分组折叠状态（B2）与进阶参数折叠状态（A3），响应式驱动 UI
  _sectionCollapsed: {},
  _advancedCollapsed: {},

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
  showFilePickerModalFlag: false,
  _pickerKey: '',
  _pickerFiles: [],
  _pickerFilter: '',
  _pickerCwd: '',

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
  ],
  currentTrainTypeDesc: '',
  currentTrainTypeLabel: 'Anima LoRA',

  switchTrainType(v) {
    // 训练类型变化后，旧的预设对比数据已无意义，清理避免误显示"已修改"标识
    this.formDiffMap = null;
    this.diffCounts = { modified: 0, added: 0 };
    this.previewPreset = null;
    // Update display labels and descriptions
    const tt = this.trainTypes.find(t => t.v === v);
    this.currentTrainTypeDesc = tt ? window.t(tt.dk, tt.l) : '';
    this.currentTrainTypeLabel = tt ? tt.l : '';

    // 为新训练类型的可见字段补充默认值（已有值保留）。
    // 切换类型后，新类型专有字段若未初始化会显示空，且 omitDefault 比较失效；
    // 这里复用 buildTrainForm 的 default 构建逻辑，只填缺失的 key。
    const newDefaults = this._buildFormDefaults(v);
    for (const k in newDefaults) {
      if (this.form[k] === undefined || this.form[k] === null) {
        this.form[k] = newDefaults[k];
      }
    }
    this.formDefaults = { ...newDefaults };

    // network_module 兼容性修正：anima 用 networks.lora_anima，SDXL 用 networks.lora。
    // 放在 default 补充之后、渲染之前，确保 animaSelect 组件初始化时读到正确值。
    if (v === 'anima-lora' && this.form.network_module === 'networks.lora') {
      this.form.network_module = 'networks.lora_anima';
    } else if (v !== 'anima-lora' && this.form.network_module === 'networks.lora_anima') {
      this.form.network_module = 'networks.lora';
    }

    // Re-render form with new train type
    this.renderTrainingForm(v, null);
    this.setupAutoValueWatchers();
    this.setupShowIfWatchers();
    this.setupReadonlyWatchers();
    this.updateToml();
    this.loadPresets();

    // 防御：renderTrainingForm 用 innerHTML 重建了 animaSelect 组件，Alpine 异步初始化。
    // 在下一个 tick 再次确保 network_module 与训练类型一致，防止组件初始化时读到旧值
    // 导致下拉显示 networks.lora（anima 下该选项已被 group 过滤，会显示原始值而非标签）。
    const targetMod = (v === 'anima-lora') ? 'networks.lora_anima' : 'networks.lora';
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
        defaults[f.key] = f.default;
      } else if (!f.hidden) {
        if (f.type === 'toggle') defaults[f.key] = false;
        else if (f.type === 'number' || f.type === 'stepper') defaults[f.key] = '';
        else if (f.type === 'select' && f.options && f.options.length) defaults[f.key] = f.options[0].v;
        else defaults[f.key] = '';
      }
    }); });
    defaults.model_train_type = trainType;
    // Adjust network_module default based on train type
    if (trainType === 'anima-lora') {
      defaults.network_module = 'networks.lora_anima';
    }
    return defaults;
  },

  suspendTrainForm(route) {
    if (!route || !route.startsWith('train-')) return;

    clearTimeout(this._formSaveTimer);
    this._formSaveTimer = null;
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
    clearTimeout(this._formSaveTimer);
    this._formSaveTimer = null;
    if (this._trainFormMountedRoute) {
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

    this.buildSectionNav();
    this.startTrainingStatusPoll();
    this.scheduleStepEstimate();
    this.scheduleOutputPathInfo();
    this.$nextTick(() => this.updateToml());

    if (this._pendingPreset) {
      const pending = this._pendingPreset;
      this._pendingPreset = null;
      this.$nextTick(() => this.applyPreset(pending));
    }
    return true;
  },

  // ── Training Form ──────────────────────────────────────
  buildTrainForm() {
    this._autoLoaded = false; // Reset so _markAutoLoaded can run again
    const r = this.currentRoute;
    if (this._resumeTrainForm(r)) return;
    if (this._trainFormMountedRoute) this._disposeTrainForm();

    const cfg = ROUTE_CONFIG[r] || {};
    const routeTrainType = cfg.trainType || 'anima-lora';

    const savedKey = 'anima-form-' + r;
    let saved = null;
    try { const raw = localStorage.getItem(savedKey); if (raw) saved = JSON.parse(raw); } catch (e) {}

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

    this.form = { ...defaults, ...(saved || {}) };
    // Ensure model_train_type is valid (saved may have been from another route)
    if (!validTrainTypes.includes(this.form.model_train_type)) {
      this.form.model_train_type = trainType;
    }
    // Fix incompatible network_module after merge
    if (this.form.model_train_type === 'anima-lora' && this.form.network_module === 'networks.lora') {
      this.form.network_module = 'networks.lora_anima';
    } else if (this.form.model_train_type !== 'anima-lora' && this.form.network_module === 'networks.lora_anima') {
      this.form.network_module = 'networks.lora';
    }
    this.formDefaults = { ...defaults };
    this.formHistory = [{ ...this.form }];
    this.formHistoryIdx = 0;

    const tt = this.trainTypes.find(t => t.v === this.form.model_train_type);
    this.currentTrainTypeDesc = tt ? window.t(tt.dk, tt.l) : '';
    this.currentTrainTypeLabel = tt ? tt.l : '';

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
    this.loadPresets();

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
    };
    window.addEventListener('locale-changed', self._localeChangeHandler);

    // Start training status polling
    this.startTrainingStatusPoll();
    this.scheduleOutputPathInfo();

    // 非阻塞静默刷新环境状态（faStatus/xfStatus/tritonStatus），
    // 供 renderField 联动提示调用；不 await，不阻塞表单首屏。
    this.faRefresh(true).catch(() => {});
    this.xfRefresh(true).catch(() => {});
    if (typeof this.tritonRefresh === 'function') this.tritonRefresh(true).catch(() => {});

    // Apply pending preset if queued by applyPresetNavigate()
    if (this._pendingPreset) {
      const pending = this._pendingPreset;
      this._pendingPreset = null;
      this.$nextTick(() => this.applyPreset(pending));
    }
    this.scheduleStepEstimate();
  },

  _stepEstimatePayload() {
    const keys = [
      'model_train_type', 'train_data_dir', 'resolution', 'enable_bucket',
      'bucket_no_upscale', 'min_bucket_reso', 'max_bucket_reso', 'bucket_reso_steps',
      'train_batch_size', 'gradient_accumulation_steps', 'max_train_epochs', 'gpu_ids',
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
      fallback: fallback || this.t('stepEstimate.failed', 'Unable to calculate training steps'),
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
        : this.t('stepEstimate.failed', 'Unable to calculate training steps'),
      params,
      !code
    );
  },

  stepEstimateErrorText() {
    const error = this.stepEstimateError;
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (!error.key) {
      const fallback = error.fallback || this.t('stepEstimate.failed', 'Unable to calculate training steps');
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
      return this.t('training.outputPathInvalid', 'The output path is invalid.');
    }
    if (this.outputPathInfoError) {
      return this.t('training.outputPathCheckFailed', 'Unable to check the output path.');
    }
    if (!info) return '';
    if (info.path_exists && info.path_is_directory === false) {
      return this.t('training.outputPathNotDirectory', 'The selected output path is a file, not a folder.');
    }
    if (!info.available) {
      return this.t('training.outputPathUnavailable', 'The drive or parent folder is currently unavailable.');
    }
    if (!info.writable) {
      return this.t('training.outputPathNotWritable', 'The output folder is not writable.');
    }
    if (info.is_default) return '';
    return this.t(
      'training.outputPathCustomSummary',
      'Models and previews will use this folder; logs and TensorBoard remain managed by the trainer.'
    );
  },

  outputPathBlockingText() {
    return this.outputPathSummaryText() || this.t('training.outputPathCheckFailed', 'Unable to check the output path.');
  },

  stepEstimateTitle() {
    if (!this.stepEstimate) return '';
    return this._stepEstimateText('stepEstimate.total', 'Estimated total: {steps} steps', {
      steps: this.stepEstimate.total_steps,
    });
  },

  stepEstimateImageFormula() {
    if (!this.stepEstimate) return '';
    const terms = this.stepEstimate.subsets.map(subset => this._stepEstimateText(
      'stepEstimate.imageTerm', '{images} images × {repeats} repeats',
      { images: subset.image_count, repeats: subset.repeats }
    ));
    return this._stepEstimateText(
      'stepEstimate.imageFormula', '{images} source images: [{terms}] = {samples} training samples',
      {
        images: this.stepEstimate.original_images,
        terms: terms.join(' + '),
        samples: this.stepEstimate.repeated_samples,
      }
    );
  },

  stepEstimateBatchFormula() {
    const estimate = this.stepEstimate;
    if (!estimate) return '';
    if (estimate.enable_bucket) {
      return this._stepEstimateText(
        'stepEstimate.bucketFormula',
        '{samples} samples → {buckets} size buckets; split each bucket by Batch {batch} = {batches} batches/epoch',
        {
          samples: estimate.repeated_samples,
          buckets: estimate.bucket_count,
          batch: estimate.batch_size,
          batches: estimate.batches_per_epoch,
        }
      );
    }
    return this._stepEstimateText(
      'stepEstimate.batchFormula',
      '⌈{samples} samples ÷ Batch {batch}⌉ = {batches} batches/epoch',
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
      'stepEstimate.totalFormula',
      'Total: {steps} steps/epoch × {epochs} Epoch = {total} steps',
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
        <div class="step-estimate-line"><span class="step-estimate-number">2</span><span x-text="stepEstimateBatchFormula()"></span></div>
        <div class="step-estimate-line"><span class="step-estimate-number">3</span><span x-text="stepEstimateEpochFormula()"></span></div>
        <div class="step-estimate-line step-estimate-line-total"><span class="step-estimate-number">4</span><span x-text="stepEstimateTotalFormula()"></span></div>
        <div class="step-estimate-note" x-text="t('stepEstimate.sdScriptsNote')"></div>
      </div>
    </div>`;
  },

  renderTrainingForm(trainType, targetId) {
    const container = document.getElementById(targetId || 'trainFormContent');
    if (!container) return;
    const sections = window.getVisibleSections(trainType || this.form.model_train_type || 'anima-lora');
    // 失效嵌套层级缓存（字段集随训练类型变化）
    this._nestLevelCache = null;
    // 进阶参数计数映射：countKey → [field objects]，供 _updateAdvancedCounts 运行期重算。
    // 渲染期建立后，showConditionalFields 切换字段显隐时用 _fieldVisible 按表单状态重计括号数字。
    this._advCountFields = {};
    let html = '';
      sections.forEach(section => {
      const allFields = section.fields.filter(f => !f.hidden);
      // 拆分：常规字段（无 subGroup）与 kohya 子组字段
      const regularFields = allFields.filter(f => !f.subGroup);
      const subGroupFields = allFields.filter(f => f.subGroup);
      const regularAdvanced = regularFields.filter(f => f.advanced);
      // 子组字段按 subGroup 值分组
      const subGroups = new Map();
      subGroupFields.forEach(f => {
        const sg = f.subGroup;
        if (!subGroups.has(sg)) subGroups.set(sg, { basic: [], advanced: [] });
        const g = subGroups.get(sg);
        if (f.advanced) g.advanced.push(f); else g.basic.push(f);
      });

      html += `<div class="card" data-section="${section.key}" :class="{ 'card-collapsed': _sectionCollapsed['${section.key}'] }">`;
      html += `<div class="card-header" @click="toggleSection('${section.key}')">`;
      html += `<svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
      html += `<span>${this.t(section.titleKey) || section.titleKey}</span>`;
      html += `</div>`;
      html += `<div class="card-body">`;
      if (section.key === 'training' && !targetId) html += this.renderStepEstimatePanel();

      // 按 FIELDS 顺序渲染：常规 basic、子组 basic、子组 inline 折叠 穿插
      const doneSubGroups = new Set();
      allFields.forEach(f => {
        if (f.subGroup) {
          if (!doneSubGroups.has(f.subGroup)) {
            doneSubGroups.add(f.subGroup);
            const sg = subGroups.get(f.subGroup);
            // 子组公共显隐条件：取该子组字段的 showIf/showIfAny 中 network_module 的 eq 值。
            // kohya 子组所有字段 showIf 均含 network_module eq lycoris.kohya，整个子区块跟随它显隐。
            const sgShowIf = (sg.basic[0] && (sg.basic[0].showIf || sg.basic[0].showIfAny))
              || (sg.advanced[0] && (sg.advanced[0].showIf || sg.advanced[0].showIfAny));
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
            // 该子组的高级折叠标题
            const sgAdvTitleKey = (f.subGroup === 'kohya') ? 'common.lycorisSubgroupAdvanced' : 'common.inlineAdvancedParams';
            const sgAdvTitle = this.t(sgAdvTitleKey) || this.t('common.inlineAdvancedParams') || 'More options';

            if (sg.basic.length > 0) {
              // 有 basic 字段：渲染完整子组盒子（标题 + body + advanced 折叠）
              const sgTitleKey = (f.subGroup === 'kohya') ? 'common.lycorisSubgroupTitle' : '';
              const sgTitle = sgTitleKey ? (this.t(sgTitleKey) || 'LyCORIS') : f.subGroup;
              html += `<div class="subgroup-block${sgBlockHidden}"${sgShowIfAttrs}>`;
              html += `<div class="subgroup-header"><span class="subgroup-dot"></span><span>${this.esc(sgTitle)}</span></div>`;
              html += `<div class="subgroup-body">`;
              sg.basic.forEach(bf => { html += this.renderField(bf); });
              if (sg.advanced.length > 0) {
                const sgKey = section.key + '--' + f.subGroup;
                const sgAdvVisible = sg.advanced.filter(af => this._fieldVisible(af)).length;
                this._advCountFields[sgKey] = sg.advanced;
                html += `<div class="advanced-fold advanced-fold--inline" data-adv-key="${sgKey}" :class="{ 'advanced-fold-collapsed': _advancedCollapsed['${sgKey}'] !== false }">`;
                html += `<div class="advanced-fold-toggle" @click="toggleAdvanced('${sgKey}')">`;
                html += `<svg class="advanced-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
                html += `<span>${this.esc(sgAdvTitle)}</span>`;
                html += `<span class="advanced-count" data-adv-count-key="${sgKey}">(${sgAdvVisible})</span>`;
                html += `</div>`;
                html += `<div class="advanced-fold-body">`;
                sg.advanced.forEach(af => { html += this.renderField(af); });
                html += `</div></div>`;
              }
              html += `</div></div>`;
            } else if (sg.advanced.length > 0) {
              // 仅 advanced 字段：不渲染子组盒子/标题，直接渲染独立的高级折叠块。
              // 折叠容器自身带 network_module 显隐属性，模块切换时整体跟随显隐。
              const sgKey = section.key + '--' + f.subGroup;
              const sgAdvVisible = sg.advanced.filter(af => this._fieldVisible(af)).length;
              this._advCountFields[sgKey] = sg.advanced;
              html += `<div class="advanced-fold advanced-fold--inline${sgBlockHidden}"${sgShowIfAttrs} data-adv-key="${sgKey}" :class="{ 'advanced-fold-collapsed': _advancedCollapsed['${sgKey}'] !== false }">`;
              html += `<div class="advanced-fold-toggle" @click="toggleAdvanced('${sgKey}')">`;
              html += `<svg class="advanced-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
              html += `<span>${this.esc(sgAdvTitle)}</span>`;
              html += `<span class="advanced-count" data-adv-count-key="${sgKey}">(${sgAdvVisible})</span>`;
              html += `</div>`;
              html += `<div class="advanced-fold-body">`;
              sg.advanced.forEach(af => { html += this.renderField(af); });
              html += `</div></div>`;
            }
          }
        } else if (!f.advanced) {
          // 常规 basic 字段：直接渲染（常规 advanced 统一进底部全局折叠）
          html += this.renderField(f);
        }
      });

      // 底部全局高级折叠（仅常规字段中的 advanced）
      if (regularAdvanced.length > 0) {
        const advCollapsedKey = 'anima-advanced-collapsed-' + section.key;
        const advCollapsed = localStorage.getItem(advCollapsedKey) !== '0';
        const regularAdvVisible = regularAdvanced.filter(f => this._fieldVisible(f)).length;
        this._advCountFields[section.key] = regularAdvanced;
        html += `<div class="advanced-fold" :class="{ 'advanced-fold-collapsed': _advancedCollapsed['${section.key}'] !== false }">`;
        html += `<div class="advanced-fold-toggle" @click="toggleAdvanced('${section.key}')">`;
        html += `<svg class="advanced-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`;
        html += `<span>${this.t('common.advancedParams')}</span>`;
        html += `<span class="advanced-count" data-adv-count-key="${section.key}">(${regularAdvVisible})</span>`;
        html += `</div>`;
        html += `<div class="advanced-fold-body">`;
        regularAdvanced.forEach(field => { html += this.renderField(field); });
        html += `</div></div>`;
      }

      html += `</div></div>`;
    });
    container.innerHTML = html;
    // 初始化折叠状态对象（Alpine 响应式）
    this._initCollapseState(sections);
    // 构建右侧分组导航指示器（#1）并绑定滚动高亮
    this.buildSectionNav();
    // Re-check all conditional fields after render
    this._allShowIfKeys().forEach(k => this.showConditionalFields(k));
  },

  // ── Section / Advanced collapse state (B2 / A3) ──
  _initCollapseState(sections) {
    if (!this._sectionCollapsed) this._sectionCollapsed = {};
    if (!this._advancedCollapsed) this._advancedCollapsed = {};
    sections.forEach(s => {
      if (this._sectionCollapsed[s.key] === undefined) {
        this._sectionCollapsed[s.key] = localStorage.getItem('anima-section-collapsed-' + s.key) === '1';
      }
      // 全局高级折叠（无 subGroup 的 advanced 字段）
      const hasRegularAdvanced = s.fields.some(f => f.advanced && !f.hidden && !f.subGroup);
      if (hasRegularAdvanced && this._advancedCollapsed[s.key] === undefined) {
        this._advancedCollapsed[s.key] = localStorage.getItem('anima-advanced-collapsed-' + s.key) !== '0';
      }
      // 子组 inline 高级折叠（有 subGroup 的 advanced 字段）
      const subGroups = {};
      s.fields.forEach(f => {
        if (f.subGroup && f.advanced && !f.hidden) {
          subGroups[f.subGroup] = true;
        }
      });
      Object.keys(subGroups).forEach(sg => {
        const sgKey = s.key + '--' + sg;
        if (this._advancedCollapsed[sgKey] === undefined) {
          this._advancedCollapsed[sgKey] = localStorage.getItem('anima-advanced-collapsed-' + sgKey) !== '0';
        }
      });
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

  toggleAdvanced(key) {
    const willCollapse = !this._advancedCollapsed[key];
    this._advancedCollapsed[key] = willCollapse;
    localStorage.setItem('anima-advanced-collapsed-' + key, willCollapse ? '1' : '0');
    // Try section-level fold first, then fall back to data-adv-key (sub-group inline fold)
    let fold;
    if (key.indexOf('--') >= 0) {
      fold = document.querySelector(`#trainFormContent .advanced-fold[data-adv-key="${this.escapeAttr(key)}"]`);
    } else {
      const card = document.querySelector(`#trainFormContent .card[data-section="${this.escapeAttr(key)}"]`);
      fold = card && card.querySelector('.advanced-fold:not([data-adv-key])');
    }
    const body = fold && fold.querySelector('.advanced-fold-body');
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

  // 字段在当前表单状态下是否「实际可见」——综合 showIf / showIfAny 求值。
  // 用于进阶参数计数：被条件隐藏的 advanced 字段不计入括号数字，避免计数虚高。
  // renderField 渲染期与 showConditionalFields 运行期共用同一判定逻辑。
  _fieldVisible(field) {
    if (field.hidden) return false;
    if (field.showIf) {
      const sf = field.showIf;
      if (Array.isArray(sf)) {
        if (!sf.every(c => this._evalShowIfCond(c))) return false;
      } else {
        if (!this._evalShowIfCond(sf)) return false;
      }
    }
    if (field.showIfAny) {
      if (!field.showIfAny.some(group => group.every(c => this._evalShowIfCond(c)))) return false;
    }
    return true;
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
    const hint = field.hintKey ? this.t(field.hintKey) : '';
    const groupMap = { 'sdxl-lora': 'sdxl', 'anima-lora': 'anima' };
    const currentGroup = groupMap[this.form.model_train_type || 'anima-lora'] || 'all';
    let isRequired = field.required;
    if (!isRequired && field.requiredGroups && Array.isArray(field.requiredGroups)) {
      isRequired = field.requiredGroups.includes(currentGroup);
    }
    const requiredMark = isRequired ? '<span class="field-required" aria-hidden="true">*</span>' : '';
    const dataKey = field.key;
    const isToggle = field.type === 'toggle';
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
      const groupMap = { 'sdxl-lora': 'sdxl', 'anima-lora': 'anima' };
      const currentGroup = groupMap[currentTrainType] || 'all';

      const resolveOption = (o) => {
        const cloned = { v: o.v, l: o.l };
        if (o.dKey) { cloned.d = self.t(o.dKey) || ''; }
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
      const hasGroups = !!(fc.groups && fc.groups.length);
      const hasOptionDescs = (fc.options || []).some(o => o.d) || (fc.groups || []).some(g => (g.options || []).some(o => o.d));
      fc.hasOptionDescs = !!hasOptionDescs;
      const triggerHtml = `<button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="toggle()"><span class="anima-select-trigger-text" x-text="selectedLabel"></span><svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg></button>`;
      const descPanelHtml = fc.hasOptionDescs ? `<div class="anima-select-menu-desc" x-show="hoveredOpt && hoveredOpt.d" x-text="hoveredOpt ? hoveredOpt.d : ''"></div>` : '';
      const menuHtml = `<template x-if="open"><div class="anima-select-menu"><div class="anima-select-menu-scroll"><template x-for="(group, gIdx) in displayGroups" :key="gIdx"><div class="anima-select-group"><div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div><template x-for="(opt, oIdx) in group.options" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)" @mouseenter="onOptionMouseEnter(oIdx, opt)" @mouseleave="onOptionMouseLeave()"><span x-text="opt.l" :title="opt.l"></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div></template></div></template><div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div></div>${descPanelHtml}</div></template>`;
      inputHtml = `<div class="anima-select" x-data="animaSelect('${this.escJson(fc)}', '${this.escapeAttr(val ?? '')}')" @click.outside="closeOnOutside()" @anima-select-change="setField('${dataKey}', $event.detail.value)"><input type="hidden" x-ref="modelInput" :value="form.${dataKey}">${triggerHtml}${menuHtml}</div>`;
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" rows="3"></textarea>`;
      if (dataKey === "positive_prompts") {
        inputHtml += this._positivePromptCountHint(dataKey);
      }
    } else if (field.type === 'stepper' || field.type === 'number') {
      const sStep = field.step || 1;
      inputHtml = `<div class="stepper"><button type="button" @click="stepField('${dataKey}', -${sStep})">−</button><input type="number" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"><button type="button" @click="stepField('${dataKey}', ${sStep})">+</button></div>`;
    } else {
      // Text input: dynamic placeholder for optimizer merged fields (reactive via Alpine)
      // Values sourced from window.OPTIMIZER_DEFAULTS (single source of truth in constants.js)
      const _OPT_PH = window.OPTIMIZER_DEFAULTS || {};
      const _phMap = _OPT_PH[dataKey];
      if (_phMap) {
        // Dynamic placeholder that updates when optimizer_type changes
        const _phExpr = JSON.stringify(_phMap).replace(/"/g, '&quot;');
        inputHtml = `<input type="text" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" :placeholder="(${_phExpr})[form.optimizer_type] || ''">`;
      } else if (field.omitDefault && field.default !== undefined && field.default !== '' && field.default !== null) {
        // omitDefault 字段：值==默认值时不传，输入框用淡色 placeholder 提示默认值
        const _phVal = String(field.default).replace(/"/g, '&quot;');
        inputHtml = `<input type="text" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" placeholder="${_phVal}">`;
      } else {
        // DEFAULT_DIM_KEYS 字段：值==schema 原始默认值时加 is-default class，CSS 淡色模拟 placeholder 视觉
        // （假留空——值仍保留，不触发必填校验失败、不影响训练流程；改值后 class 移除恢复正常字色）
        // :class 属性用双引号包裹，内部字符串字面量必须用单引号，内部单引号转义为 \x27。
        const _dimCls = (window.DEFAULT_DIM_KEYS && window.DEFAULT_DIM_KEYS.has(dataKey) && field.default !== undefined && field.default !== '' && field.default !== null)
          ? ` :class="{ 'is-default': String(form.${dataKey}) === String('${String(field.default).replace(/'/g, '\\x27')}') }"`
          : '';
        inputHtml = `<input type="text" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"${_dimCls}>`;
      }
    }

    // ── Embed file picker buttons inside input ──
    let controlHtml = '';
    if (field.role && field.role.startsWith('file-')) {
      controlHtml = `<div class="field-input-wrap">${inputHtml}<div class="field-input-actions"><button type="button" class="btn-icon" @click="localFilePicker('${dataKey}','${field.role}')" :title="t('common.localPicker','Local picker')" :aria-label="t('common.browseLocal','Browse local files')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button><button type="button" class="btn-icon" @click="builtinFilePicker('${dataKey}','${field.role}')" :title="t('common.builtinBrowser','Built-in browser')" :aria-label="t('common.searchBuiltin','Search built-in models')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button></div></div>`;
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
    // list[dict]：任一条件（eq/neq）成立即锁定。用于多 key 的互斥（如 cache×caption）。
    // reason 来自 field 顶层 readonlyReasonKey（list 容纳不下 reason）。
    if (!field.readonlyIf && field.readonlyIfAny && Array.isArray(field.readonlyIfAny)) {
      // 复用 show_if 的条件求值语义（eq/neq/空串判定完全一致），readonly 互斥方向一样。
      const met = field.readonlyIfAny.some(c => this._evalShowIfCond(c));
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

    // ── Nested detection (child of a showIf/showIfAny parent) ──
    // 计算嵌套层级（A2）：一个字段的层级 = 其 showIf/showIfAny 父字段的层级 + 1，父级若无则为 0。
    // 这样"开关→选项→子选项"的树形层级通过递增缩进 + 加深左边框一眼可读。
    const nestLevel = this._nestLevel(field);
    const nestedClass = (field.showIf || field.showIfAny) ? ' field-nested' : '';
    const nestLevelAttr = ` data-nest-level="${nestLevel}"`;

    // ── Build body row ──
    let controlSection = '';
    let fullWidthRow = '';
    if (isFullWidth) {
      // Textarea / path: info on top, input full-width below (outside field-row)
      controlSection = `<div class="field-info"><div class="field-key">${this.esc(dataKey)}${requiredMark}</div><div class="field-desc">${label}</div></div>`;
      fullWidthRow = `<div class="field-input-row">${controlHtml}</div>`;
    } else {
      // Standard: info left, control right — single flex row
      controlSection = `<div class="field-info"><div class="field-key">${this.esc(dataKey)}${requiredMark}</div><div class="field-desc">${label}</div></div><div class="field-control">${controlHtml}</div>`;
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
    return `<div class="field${condClass}${nestedClass}" :class="{ 'field-changed': String(form.${dataKey}) !== String(formDefaults.${dataKey}) && !(formDiffMap && formDiffMap['${dataKey}']), 'field-filled': ${_filledExpr}, 'field-diff-modified': formDiffMap && formDiffMap['${dataKey}'] && formDiffMap['${dataKey}'].type === 'modified', 'field-diff-added': formDiffMap && formDiffMap['${dataKey}'] && formDiffMap['${dataKey}'].type === 'added' }" data-field-row="${this.escapeAttr(dataKey)}"${condAttrs}${readonlyAttrs}${nestLevelAttr}>
      <div class="field-row">
        ${controlSection}
        <div class="field-menu-wrap">
          <button type="button" class="btn-menu" :aria-label="t('common.fieldActions')" tabindex="-1">${_dotsSvg}</button>
          ${_menuPopupHtml}
        </div>
      </div>
      ${fullWidthRow}
      <div class="field-diff-info" x-show="formDiffMap && formDiffMap['${dataKey}']" x-cloak>
        <template x-if="formDiffMap && formDiffMap['${dataKey}'] && formDiffMap['${dataKey}'].type === 'modified'">
          <span class="field-diff-change"><span class="field-diff-old" x-text="String((formDiffMap['${dataKey}']||{}).oldVal||'')"></span> <span class="field-diff-arrow">&rarr;</span> <span class="field-diff-new" x-text="String((formDiffMap['${dataKey}']||{}).newVal||'')"></span></span>
        </template>
        <template x-if="formDiffMap && formDiffMap['${dataKey}'] && formDiffMap['${dataKey}'].type === 'added'">
          <span class="field-diff-type-added" x-text="String((formDiffMap['${dataKey}']||{}).newVal||'')"></span>
        </template>
      </div>
      ${hint ? `<div class="field-hint">${hint}</div>` : ''}
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
      case 'attn_mode':
        return `<div x-show="faStatus && !faStatus.installed && form.attn_mode==='flash'" class="field-hint field-hint-warn">${this.t('environment.envHintFlashNotInstalled')||'Flash Attention not installed'}</div>`
             + `<div x-show="xfStatus && !xfStatus.installed && form.attn_mode==='xformers'" class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')||'xformers not installed'}</div>`;
      case 'xformers':
        return `<div x-show="xfStatus && !xfStatus.installed && form.xformers" class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')||'xformers not installed'}</div>`;
      case 'compile':
        return `<div x-show="tritonStatus && !tritonStatus.installed && form.compile" class="field-hint field-hint-warn">${this.t('environment.envHintTritonNotInstalled')||'Triton not installed'}</div>`;
    }
    return '';
  },

  _getOutputPathHint(dataKey) {
    if (dataKey !== 'output_dir') return '';
    return `<div class="output-path-hint" x-show="outputPathHintVisible()" :class="outputPathStatusClass()" role="status" aria-live="polite" x-cloak>
      <div class="output-path-hint-summary"><span class="output-path-hint-dot" aria-hidden="true"></span><span x-text="outputPathSummaryText()"></span></div>
    </div>`;
  },

  copyFieldName(key) {
    navigator.clipboard.writeText(key).then(() => {
      this.toast(this.t('common.paramCopied') || 'Copied');
    });
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

  // 重算所有进阶参数折叠块的括号计数：仅统计当前表单状态下实际可见的 advanced 字段。
  // 渲染期在 _advCountFields 建立了 countKey→[fields] 映射，这里按 _fieldVisible 重计并
  // 写入对应 [data-adv-count-key] span 的文本。不依赖 DOM field-hidden 类，避免动画时序竞态。
  _updateAdvancedCounts() {
    const map = this._advCountFields;
    if (!map) return;
    document.querySelectorAll('#trainFormContent [data-adv-count-key]').forEach(span => {
      const key = span.getAttribute('data-adv-count-key');
      const fields = map[key];
      if (!fields) return;
      const visible = fields.filter(f => this._fieldVisible(f)).length;
      span.textContent = '(' + visible + ')';
    });
  },

  showConditionalFields(parentKey) {
    const container = document.getElementById('trainFormContent');
    if (!container) { this.updateToml(); return; }
    const expectedVal = this.form[parentKey];
    const toAnimate = [];
    // 进阶参数计数随字段显隐联动重算（按表单状态，与 DOM 动画时序无关）。
    this._updateAdvancedCounts();

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
        && row.parentElement.closest('.field-hidden, .advanced-fold-collapsed, .card-collapsed');
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

  /** Apply autoValue rules once based on current form state (no watcher side-effects). */
  _applyInitialAutoValues() {
    if (!this._autoValueRules || this._autoValueRules.length === 0) return;
    this._autoValueRules.forEach(r => {
      if (this._matchAutoValueRule(r)) {
        if (r.set !== null && r.set !== undefined) {
          this.form[r.target] = r.set;
          this.formDefaults[r.target] = r.set;
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
        f.autoValue.forEach(r => rules.push({ target: r.setTarget || f.key, defaultVal: f.default, watch: r.watch, when: r.when, set: r.set }));
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
              self.form[matched.target] = matched.set;
              self.formDefaults[matched.target] = matched.set;
            }
          } else {
            // No rule matches → restore default (also update formDefaults)
            const field = self.findFieldDef(target);
            const defVal = field ? field.default : (self.formDefaults[target]);
            if (field) self.form[target] = defVal;
            self.formDefaults[target] = defVal;
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
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.readonlyIf) keys.add(f.readonlyIf.key);
      // readonlyIfAny: 任一条件中的 key 都需监听，互斥字段变化要及时刷新锁定态
      if (f.readonlyIfAny && Array.isArray(f.readonlyIfAny)) {
        f.readonlyIfAny.forEach(c => { if (c && c.key) keys.add(c.key); });
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

    // 多 key readonly_if_any：list[dict]，任一条件（eq/neq）成立即锁定。
    // 求值语义与 _evalShowIfCond 一致（空串/null 不视为"非默认值"，避免误锁）。
    document.querySelectorAll('[data-readonly-if-any]').forEach(row => {
      let conds = [];
      try { conds = JSON.parse(row.getAttribute('data-readonly-if-any') || '[]'); } catch (e) { /* 防御损坏 */ }
      const met = Array.isArray(conds) && conds.some(c => self._evalShowIfCond(c));
      apply(row, met, row.getAttribute('data-readonly-if-reason'));
    });
  },

  // Canonical HTML escape (text content & "-delimited attributes).
  // Handles null/undefined/0 correctly.
  esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },
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

  setField(key, value) {
    const oldVal = this.form[key];
    if (oldVal === value) return;
    if (typeof this.formDefaults[key] === 'number' && value !== '' && value !== null) {
      const numVal = Number(value);
      if (!isNaN(numVal)) value = numVal;
    }

    // Enforce min/max bounds on number fields (skip empty/unset — means "disabled")
    const field = this.findFieldDef(key);
    if (field && field.type === 'number') {
      if (value === '' || value === null || value === undefined) {
        // preserve empty/unset — signals sd-scripts "not used"
      } else {
        const numVal = Number(value);
        if (!isNaN(numVal)) {
          if (field.min !== undefined && numVal < field.min) value = field.min;
          if (field.max !== undefined && numVal > field.max) value = field.max;
        }
      }
    }

    this.form[key] = value;
    if (key === 'output_dir' || key === 'output_name' || key === 'resume') {
      this.scheduleOutputPathInfo();
    }
    // model_train_type 切换：直接调用 switchTrainType，不依赖 $watch
    //（applyPreset 等流程会临时禁用 watcher，存在未恢复的风险）
    if (key === 'model_train_type' && value !== oldVal && !this._switchInProgress) {
      this._switchInProgress = true;
      try { this.switchTrainType(value); } finally { this._switchInProgress = false; }
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

    // Clear error for this field on change and re-render to update UI
    if (this.formErrors && this.formErrors[key]) {
      this.formErrors[key] = null;
      this.renderTrainingForm(this.form.model_train_type || 'anima-lora', null);
      return;
    }
    this.updateTomlDebounced();
  },

  stepField(key, delta) {
    const current = Number(this.form[key]) || 0;
    const field = this.findFieldDef(key);
    const step = field ? (field.step || 1) : 1;
    let newVal = current + delta;
    if (field && field.min !== undefined && newVal < field.min) newVal = field.min;
    if (field && field.max !== undefined && newVal > field.max) newVal = field.max;
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

  // ── Nest level: depth of showIf/showIfAny ancestry (A2) ──
  // 一个字段的层级 = 其 showIf/showIfAny 父字段层级 + 1；无则为 0。
  // 用于递增缩进与左边框深浅，让"开关→选项→子选项"层级一眼可读。
  _nestLevelCache: null,
  _nestLevel(field) {
    if (!field.showIf && !field.showIfAny) return 0;
    // 构建一次 key→field 映射，避免重复遍历（render 时调用频繁）
    if (!this._nestLevelCache) {
      const map = {};
      this._allSections().forEach(s => s.fields.forEach(f => { map[f.key] = f; }));
      this._nestLevelCache = map;
    }
    let level = 0;
    let cur = field;
    const guard = new Set();
    while (cur && (cur.showIf || cur.showIfAny) && !guard.has(cur.key)) {
      guard.add(cur.key);
      level += 1;
      // 确定父字段 key：showIf dict → .key；showIf 数组(AND) → 无明确父级(终止);
      // showIfAny → 取第一个 AND 组的第一个 key 作为父级近似
      let parentKey;
      if (cur.showIf) {
        parentKey = Array.isArray(cur.showIf) ? undefined : cur.showIf.key;
      } else if (cur.showIfAny) {
        parentKey = cur.showIfAny[0] && cur.showIfAny[0][0] && cur.showIfAny[0][0].key;
      }
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
        this.formHistoryIdx = i;
        this.updateToml();
        return;
      }
    }
    // No different value found → restore to default
    const def = this.formDefaults[key];
    this.form[key] = def !== undefined ? def : '';
    this.updateToml();
  },

  resetField(key) {
    const def = this.formDefaults[key];
    this.setField(key, def !== undefined ? def : '');
  },

  resetAllParams() {
    // 重置所有参数后，旧的预设对比数据无意义
    this.formDiffMap = null;
    this.diffCounts = { modified: 0, added: 0 };
    this.previewPreset = null;
    // Preserve current train type - don't reset it
    const currentTrainType = this.form.model_train_type;
    this.form = { ...this.formDefaults };
    this.form.model_train_type = currentTrainType;

    // Adjust network_module based on train type
    const targetNetworkModule = currentTrainType === 'anima-lora' ? 'networks.lora_anima' : 'networks.lora';
    this.form.network_module = targetNetworkModule;

    this.formHistory = [{ ...this.form }];
    this.formHistoryIdx = 0;
    this.updateToml();
    this.rebuildForm();

    // Ensure network_module is correct after rebuild
    this.$nextTick(() => {
      this.form.network_module = targetNetworkModule;
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
    // Re-apply autoValue rules so select fields, locked fields etc. stay consistent
    // after preset load, config import, or full reset.
    this._applyInitialAutoValues();
    this.renderTrainingForm(this.form.model_train_type || 'anima-lora');
    this.updateReadonlyStates();
  },

  // ── Validation ────────────────────────────────────────
  validateForm() {
    const errors = {};
    // Check all required fields
    const groupMap = { 'sdxl-lora': 'sdxl', 'anima-lora': 'anima' };
    const currentGroup = groupMap[this.form.model_train_type || 'anima-lora'] || 'all';
    const sections = this._allSections();
    for (const section of sections) {
      for (const field of section.fields) {
        const isFieldRequired = field.required ||
          (field.requiredGroups && Array.isArray(field.requiredGroups) && field.requiredGroups.includes(currentGroup));
        if (!isFieldRequired) continue;
        const val = this.form[field.key];
        if (val === undefined || val === null || val === '') {
          errors[field.key] = this.t('common.fieldRequired') || 'This field is required';
        }
      }
    }
    // Cross-field: min_bucket_reso <= max_bucket_reso
    if (this.form.enable_bucket) {
      const minR = Number(this.form.min_bucket_reso);
      const maxR = Number(this.form.max_bucket_reso);
      if (!isNaN(minR) && !isNaN(maxR) && minR > maxR) {
        errors.min_bucket_reso = this.t('common.minBucketResoError') || 'Min resolution cannot exceed max resolution';
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
        errors.min_timestep = this.t('common.minTimestepError') || 'Min timestep must be less than max timestep';
      }
    }

    // Anima mode: vae and qwen3 are required
    if (String(this.form.model_train_type) === 'anima-lora') {
      if (!this.form.vae || String(this.form.vae).trim() === '') {
        errors['vae'] = window.t('common.vaeRequired') || 'Anima training requires a VAE model';
      }
      if (!this.form.qwen3 || String(this.form.qwen3).trim() === '') {
        errors['qwen3'] = window.t('common.qwen3Required') || 'Anima training requires a Qwen3 model';
      }
    }

    this.formErrors = errors;
    const hasErrors = Object.keys(errors).length > 0;
    if (hasErrors) {
      this.renderTrainingForm(this.form.model_train_type || 'anima-lora', null);
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
          this.toast(this.t('common.localPickerCancelled','Cancelled'));
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
      this.showFilePickerModal(key, Array.isArray(files)?files:[]);
    } catch(e) { this.toast(this.t('common.fileBrowserFailed')); }
  },

  showFilePickerModal(key, files) {
    this._pickerKey = key;
    this._pickerFiles = files || [];
    this._pickerFilter = '';
    this._pickerCwd = '';
    this.showFilePickerModalFlag = true;
  },

  get filteredPickerFiles() {
    const filter = (this._pickerFilter || '').toLowerCase();
    if (!filter) return this._pickerFiles || [];
    return (this._pickerFiles || []).filter(f => f.name.toLowerCase().includes(filter));
  },

  pickFileFromModal(file) {
    if (!file) return;
    this.setField(this._pickerKey, file.path || file.name || '');
    this.showFilePickerModalFlag = false;
  },

  // ── Training Status Polling ──────────────────────────────
  async checkTrainingBlocked() {
    // 优先复用 /api/health 已采集的 trainingActive（减少冗余请求）；
    // 但 activeTaskId 需要单独获取，故仅在阻塞状态变化或首次时请求 is-active
    const fromHealth = this.trainingActive;
    if (fromHealth != null) {
      this.trainingBlocked = fromHealth;
      if (fromHealth && !this.activeTaskId) {
        // 仅在判定为阻塞且尚无 task_id 时补一次请求拿 task_id
        try {
          const r = await fetch('/api/monitor/is-active');
          const d = await r.json();
          if (d.status === 'success') this.activeTaskId = d.data.task_id || null;
        } catch (_) { this.activeTaskId = null; }
      } else if (!fromHealth) {
        this.activeTaskId = null;
      }
      return;
    }
    try {
      const r = await fetch('/api/monitor/is-active');
      const d = await r.json();
      if (d.status === 'success') {
        this.trainingBlocked = d.data.active;
        this.activeTaskId = d.data.task_id || null;
      }
    } catch (e) {
      this.trainingBlocked = false;
      this.activeTaskId = null;
    }
  },

  startTrainingStatusPoll() {
    this.stopTrainingStatusPoll();
    this.checkTrainingBlocked();
    this._trainStatusTimer = setInterval(() => {
      if (this.currentRoute.startsWith('train-')) {
        this.checkTrainingBlocked();
      }
    }, 5000);
  },

  stopTrainingStatusPoll() {
    if (this._trainStatusTimer) {
      clearInterval(this._trainStatusTimer);
      this._trainStatusTimer = null;
    }
  }
};
