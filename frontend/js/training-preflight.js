/* Training step estimates, output path inspection and Krea model format checks.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingPreflight = {
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
  _kreaDitFormatTimer: null,
  _kreaDitFormatRequestSeq: 0,
  _kreaDitFormatCheck: null,
  _kreaDitFormatWatcher: null,
  _cancelTrainingPreflight() {
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
  },

  _stepEstimatePayload() {
    const keys = [
      'model_train_type', 'train_data_dir', 'enable_reg_data', 'reg_data_dir', 'dataset_cache_dir', 'resolution', 'enable_bucket',
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
      if (this.lrPreviewOpen) this.refreshLrPreview();
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
      if (this.lrPreviewOpen) this.refreshLrPreview();
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
      if (requestSeq === this._stepEstimateRequestSeq) {
        this.stepEstimateLoading = false;
        if (this.lrPreviewOpen) this.refreshLrPreview();
      }
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
  _disposeKreaDitFormatWatcher() {
    if (typeof this._kreaDitFormatWatcher === 'function') this._kreaDitFormatWatcher();
    this._kreaDitFormatWatcher = null;
    this._cancelKreaDitFormatCheck();
  },

  setupKreaDitFormatWatcher() {
    if (typeof this._kreaDitFormatWatcher === 'function') this._kreaDitFormatWatcher();
    this._kreaDitFormatWatcher = this.form.model_train_type === 'krea2-lora'
      ? this.$watch('form.dit', () => this.scheduleKreaDitFormatCheck()) : null;
    this.scheduleKreaDitFormatCheck();
  },

  _cancelKreaDitFormatCheck() {
    if (this._kreaDitFormatTimer !== null) clearTimeout(this._kreaDitFormatTimer);
    this._kreaDitFormatTimer = null;
    this._kreaDitFormatCheck = null;
    this._kreaDitFormatRequestSeq += 1;
  },

  scheduleKreaDitFormatCheck() {
    const path = String(this.form.dit || '').trim();
    if (this.form.model_train_type !== 'krea2-lora' || !path
        || typeof fetch !== 'function' || typeof setTimeout !== 'function') {
      this._cancelKreaDitFormatCheck();
      return;
    }
    // setField and the path watcher may both schedule the same selection.
    if (this._kreaDitFormatCheck?.path === path) return;
    this._cancelKreaDitFormatCheck();
    const check = { path, sequence: this._kreaDitFormatRequestSeq, promise: null };
    this._kreaDitFormatCheck = check;
    this._kreaDitFormatTimer = setTimeout(() => this._runKreaDitFormatCheck(check), 250);
  },

  _runKreaDitFormatCheck(check) {
    if (check.sequence !== this._kreaDitFormatRequestSeq) return Promise.resolve();
    if (this._kreaDitFormatTimer !== null) clearTimeout(this._kreaDitFormatTimer);
    this._kreaDitFormatTimer = null;
    if (!check.promise) {
      check.promise = this._checkKreaDitFormat(check.path, check.sequence).finally(() => {
        if (check.sequence === this._kreaDitFormatRequestSeq) this._kreaDitFormatCheck = null;
      });
    }
    return check.promise;
  },

  async ensureKreaDitFormat() {
    if (this.form.model_train_type !== 'krea2-lora') return true;
    this.scheduleKreaDitFormatCheck();
    const check = this._kreaDitFormatCheck;
    if (!check) return true;
    // Flush typing debounce and share any in-flight inspection before taking a snapshot.
    await this._runKreaDitFormatCheck(check);
    return check.sequence === this._kreaDitFormatRequestSeq
      && this.form.model_train_type === 'krea2-lora'
      && String(this.form.dit || '').trim() === check.path;
  },

  async _checkKreaDitFormat(path, sequence) {
    try {
      const response = await fetch('/api/training/krea2/model-format', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      });
      if (!response.ok) return;
      const result = await response.json();
      if (sequence !== this._kreaDitFormatRequestSeq || this.form.model_train_type !== 'krea2-lora'
          || String(this.form.dit || '').trim() !== path
          || result.status !== 'success' || result.data?.format !== 'convrot_int8') return;
      if (this.form.convrot_int8 === true && !this.form.fp8_base) return;
      this.form.convrot_int8 = true;
      this._setFieldSource('convrot_int8', 'auto');
      this._enforceSharedTrainingUiConstraints();
      this._persistProfileFieldSources();
      this.updateReadonlyStates();
      this._refreshTrainingOptionErrors();
      this.pushHistory({ ...this.form });
      this.updateTomlDebounced();
      this.toast(this.t('krea2.int8ModelAutoConfigured'), 'info');
    } catch (error) {
      // Paths can be incomplete while typing; launch preflight remains authoritative.
    }
  },
};
