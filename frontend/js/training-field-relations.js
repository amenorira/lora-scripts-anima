/* Training field edits, optimizer drafts and automatic value constraints.
 * Composed into trainingCoreMixin; form rendering and lifecycle stay in training-core.js.
 */
window.trainingFieldRelations = {
  _autoValueRules: null,
  _optimizerDrafts: {},
  _optimizerRestore: null,
  _optimizerRestoreEpoch: 0,

  _enforceCheckpointingUiConstraints(changedKey) {
    const dependentKeys = this.form.model_train_type === 'krea2-lora'
      ? ['block_swap_h2d_only', 'gradient_checkpointing_cpu_offload']
      : ['cpu_offload_checkpointing', 'unsloth_offload_checkpointing', 'block_swap_h2d_only'];
    if (changedKey === 'gradient_checkpointing' && this.form.gradient_checkpointing === false) {
      dependentKeys.forEach(key => { this.form[key] = false; });
    } else if (dependentKeys.some(key => this.form[key])) {
      this.form.gradient_checkpointing = true;
    }
  },

  _matchAutoValueRule(rule) {
    if (rule.watch && typeof rule.watch === 'object' && !Array.isArray(rule.watch)) {
      // Multi-condition: all watched fields must match their expected values
      return Object.entries(rule.watch).every(([k, v]) => String(this.form[k]) === String(v));
    }
    // Single condition
    return String(this.form[rule.watch]) === String(rule.when);
  },

  _autoValueRuleCanSet(rule) {
    if (this._isRestoringOptimizerField(rule.target)) return false;
    if (!rule.setIfDefault) return true;
    const source = this._fieldSources && this._fieldSources[rule.target];
    return source === 'default' || source === 'auto';
  },

  _autoValueTargetCanReset(target) {
    if (this._isRestoringOptimizerField(target)) return false;
    const guarded = this._autoValueRules.find(rule => rule.target === target && rule.setIfDefault);
    return !guarded || this._autoValueRuleCanSet(guarded);
  },

  _optimizerFields(sections = this._allSections()) {
    const rateKeys = new Set(['learning_rate', 'unet_lr', 'text_encoder_lr', 'optimizer_args_custom']);
    return sections.flatMap(section => section.fields || [])
      .filter(field => field.argKey || rateKeys.has(field.key));
  },

  _isRestoringOptimizerField(key) {
    const restore = this._optimizerRestore;
    return restore && restore.trainType === this.form.model_train_type
      && restore.optimizer === this.form.optimizer_type && restore.keys.includes(key);
  },

  _switchOptimizer(optimizer, source = 'user') {
    const trainType = this.form.model_train_type || 'anima-lora';
    const previous = this.form.optimizer_type;
    if (previous === optimizer) return;
    const fields = this._optimizerFields();
    const saved = {};
    fields.forEach(({ key }) => {
      saved[key] = {
        value: this.form[key], defaultValue: this.formDefaults[key],
        source: this._fieldSources?.[key] || 'user',
      };
    });
    const drafts = { ...this._optimizerDrafts[trainType], [previous]: saved };
    this._optimizerDrafts = { ...this._optimizerDrafts, [trainType]: drafts };
    const restored = drafts[optimizer];
    const epoch = ++this._optimizerRestoreEpoch;
    this._optimizerRestore = null;
    this.form.optimizer_type = optimizer;
    this._setFieldSource('optimizer_type', source);
    this._resetOptimizerFields();
    if (restored) {
      const keys = fields.map(field => field.key).filter(key => Object.prototype.hasOwnProperty.call(restored, key));
      this._optimizerRestore = { trainType, optimizer, keys };
      keys.forEach(key => {
        this.form[key] = restored[key].value;
        this.formDefaults[key] = restored[key].defaultValue;
        this._setFieldSource(key, restored[key].source);
      });
      // Keep restored values through the queued optimizer/dependency watchers.
      // Other targets (scheduler, clipping, etc.) still enforce their constraints.
      this.$nextTick(() => {
        if (this._optimizerRestoreEpoch === epoch) this._optimizerRestore = null;
      });
      this._enforceMossTextEncoderFreeze();
      this._persistProfileFieldSources();
    }
    this.toast(this.t(restored ? 'field.optimizerSwitchRestored' : 'field.optimizerSwitchReset'), 'info');
    this._enforceAutomagicFusedUiConstraints();
  },

  _resetOptimizerFields() {
    const sections = this._allSections();
    const defaults = this._buildFormDefaults(this.form.model_train_type || 'anima-lora');
    const rules = this._collectAutoValueRules(sections);
    const fields = this._optimizerFields(sections);

    // Start a new optimizer draft from defaults, including hidden fields.
    // Resolve dependent rules only after their inputs have also been restored.
    fields.forEach(field => {
      const value = Object.prototype.hasOwnProperty.call(defaults, field.key) ? defaults[field.key] : '';
      this.form[field.key] = value;
      this.formDefaults[field.key] = value;
      this._setFieldSource(field.key, 'default');
    });
    fields.forEach(field => {
      const { value, source } = this._resolveFieldDefault(field.key, defaults, rules);
      this.form[field.key] = value;
      this.formDefaults[field.key] = value;
      this._setFieldSource(field.key, source);
    });
    this._enforceMossTextEncoderFreeze();
    this._persistProfileFieldSources();
  },

  _enforceDataLoaderUiConstraints() {
    const workers = this.form.max_data_loader_n_workers;
    if (workers !== '' && workers !== null && workers !== undefined && Number(workers) === 0
        && this.form.persistent_data_loader_workers === true) {
      this.form.persistent_data_loader_workers = false;
      this._setFieldSource('persistent_data_loader_workers', 'auto');
    }
  },

  _enforceImageAugmentationUiConstraints() {
    if (this.form.model_train_type === 'krea2-lora' || this.form.random_crop !== true) return;
    // Also normalize imported presets, restored drafts and field resets.
    // Leaving disk caching on would make the backend re-enable cache_latents.
    for (const key of ['cache_latents', 'cache_latents_to_disk']) {
      if (this.form[key] === true) {
        this.form[key] = false;
        this._setFieldSource(key, 'auto');
      }
    }
  },

  _enforceKrea2UiConstraints() {
    if (this.form.model_train_type !== 'krea2-lora') return;
    if (this.form.convrot_int8 && this.form.fp8_base) {
      this.form.fp8_base = false;
      this._setFieldSource('fp8_base', 'auto');
    }
    if (!String(this.form.turbo_dit || '').trim() && this.form.turbo_dit_cache) {
      this.form.turbo_dit_cache = false;
      this._setFieldSource('turbo_dit_cache', 'auto');
    }
  },

  _enforceSharedTrainingUiConstraints() {
    this._enforceCheckpointingUiConstraints();
    if (this.form.model_train_type === 'krea2-lora') {
      this._enforceKrea2UiConstraints();
      if (this.form.network_module === 'lycoris.kohya' && (this.form.fp8_base || this.form.convrot_int8)) this.form.bypass_mode = true;
      else if (this.form.network_module === 'lycoris.kohya' && this.form.dora_wd) this.form.bypass_mode = false;
      else if (this.form.network_module === 'lycoris.kohya' && this.form.lycoris_algo === 'lora'
        && Number(this.form.dropout || 0) > 0) this.form.bypass_mode = true;
      return;
    }
    if (!['anima-lora', 'moss-image-lora', 'sdxl-lora'].includes(this.form.model_train_type)) return;
    if (this.form.model_train_type === 'sdxl-lora' && this.form.xformers && this.form.sdpa) {
      this.form.sdpa = false;
    }
    if (this.form.attn_mode === 'xformers') this.form.split_attn = true;
    if (this.form.network_train_unet_only === false || this.form.network_train_text_encoder_only === true
        || Number(this.form.caption_dropout_every_n_epochs || 0) > 0) {
      this.form.cache_text_encoder_outputs = false;
      this.form.cache_text_encoder_outputs_to_disk = false;
    }
  },

  _enforceMossTextEncoderFreeze() {
    if (this.form.model_train_type !== 'moss-image-lora') return;
    const fixed = { network_train_unet_only: true, network_train_text_encoder_only: false,
      text_encoder_lr: '', loraplus_text_encoder_lr_ratio: '' };
    for (const [key, value] of Object.entries(fixed)) {
      if (this.form[key] !== value) {
        this.form[key] = value;
        this._setFieldSource(key, 'auto');
      }
    }
  },

  _applyInitialAutoValues() {
    this._syncLrTimescaleDefault();
    this._enforceDataLoaderUiConstraints();
    this._enforceImageAugmentationUiConstraints();
    this._enforceMossTextEncoderFreeze();
    this._enforceSharedTrainingUiConstraints();
    const rules = Array.isArray(this._autoValueRules) ? this._autoValueRules : [];
    const targets = new Set(rules.map(rule => rule.target));
    targets.forEach(target => {
      const matched = rules.find(
        rule => rule.target === target && this._matchAutoValueRule(rule)
      );
      if (matched && matched.set !== null && matched.set !== undefined) {
        if (this._autoValueRuleCanSet(matched)) {
          this.form[matched.target] = matched.set;
          this._setFieldSource(matched.target, 'auto');
          this.formDefaults[matched.target] = matched.set;
          if (this._allShowIfKeys().includes(matched.target)) {
            this.showConditionalFields(matched.target);
          }
        }
      }
    });
    this._refreshTrainingOptionErrors();
  },

  _collectAutoValueRules(sections = this._allSections()) {
    const rules = [];
    sections.forEach(s => s.fields.forEach(f => {
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
    return rules;
  },

  setupAutoValueWatchers() {
    // Clean up previous watchers（防御：过滤非函数元素，避免 w is not a function 崩溃）
    if (this._autoValueWatchers) { this._autoValueWatchers.forEach(function(w) { if (typeof w === 'function') w(); }); }
    this._autoValueWatchers = [];
    const rules = this._collectAutoValueRules();
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

  _enforceAutomagicFusedUiConstraints() {
    if (!this.form.automagic_fused) return;
    const conflicts = this._automagicFusedConflicts();
    if (!this._automagicFusedHasConflict(conflicts)) return;
    this.form.automagic_fused = false;
    const details = this._automagicFusedConflictText(conflicts);
    this.toast(this.t('field.automagic_fusedAutoDisabled').replace('{details}', details), 'warning');
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
    if (key.startsWith('reg__')) { this.regSetField(key.slice(5), value); return; }
    if (key === 'split_attn' && this.form.attn_mode === 'xformers') value = true;
    if (this.form.model_train_type === 'moss-image-lora'
        && ['network_train_unet_only', 'network_train_text_encoder_only', 'text_encoder_lr', 'loraplus_text_encoder_lr_ratio'].includes(key)) {
      this._enforceMossTextEncoderFreeze();
      return;
    }
    if (key === 'dataset_cache_dir' && this.form.model_train_type === 'krea2-lora') {
      value = this._deriveKrea2CacheDir(this.form.train_data_dir);
    }
    const loraMuonType = 'vendor.lora_muon.LoRA_Muon';
    const loraMuonNetwork = 'networks.lora_anima';
    if (this.form.model_train_type !== 'krea2-lora' && key === 'optimizer_type' && value === loraMuonType &&
        this.form.network_module !== loraMuonNetwork) {
      this.form.network_module = loraMuonNetwork;
      this._setFieldSource('network_module', 'auto');
      this.toast(this.t('field.lora_muonNetworkAutoSelected'), 'warning');
    }
    if (this.form.model_train_type !== 'krea2-lora' && key === 'network_module' && value !== loraMuonNetwork &&
        this.form.optimizer_type === loraMuonType) {
      this._switchOptimizer('AdamW8bit', 'auto');
      this.toast(this.t('field.lora_muonOptimizerAutoDisabled'), 'warning');
    }
    const oldVal = this.form[key];
    if (oldVal === value) {
      this._setFieldSource(key, 'user');
      this._persistProfileFieldSources();
      if (key === 'dit') this.scheduleKreaDitFormatCheck();
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
    const kreaLockedReason = this.form.model_train_type === 'krea2-lora' ? this._readonlyReason(field) : '';
    if (kreaLockedReason && value !== oldVal) {
      this.toast(this.t(kreaLockedReason), 'warning');
      return;
    }

    // LyCORIS LoKr uses -1 for automatic factor selection; zero is not a
    // meaningful factor. Normalize manual input to the documented automatic
    // value instead of allowing a configuration that fails at train startup.
    if (key === 'lokr_factor' && value !== '' && value !== null && value !== undefined) {
      const factor = Number(value);
      if (factor === 0) value = -1;
    }

    if ((key === 'cache_latents' || key === 'cache_latents_to_disk') && value === true &&
        this.form.model_train_type !== 'krea2-lora' && this.form.random_crop === true) {
      this.toast(this.t('field.cache_latentsLocked'), 'warning');
      return;
    }

    if ((key === 'cache_text_encoder_outputs' || key === 'cache_text_encoder_outputs_to_disk') && value === true) {
      const hasShuffleConflict = this.form.shuffle_caption === true;
      const hasTagDropoutConflict = Number(this.form.caption_tag_dropout_rate || 0) > 0;
      const hasSdxlDropoutConflict = this.form.model_train_type === 'sdxl-lora' && Number(this.form.caption_dropout_rate || 0) > 0;
      const hasEpochDropoutConflict = Number(this.form.caption_dropout_every_n_epochs || 0) > 0;
      if (hasShuffleConflict || hasTagDropoutConflict || hasSdxlDropoutConflict || hasEpochDropoutConflict) {
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

    if (key === 'optimizer_type') {
      this._switchOptimizer(value);
    } else {
      this.form[key] = value;
      this._setFieldSource(key, 'user');
    }
    const kreaFp8WasEnabled = this.form.fp8_base;
    this._enforceKrea2UiConstraints();
    if (key === 'convrot_int8' && value === true && kreaFp8WasEnabled && !this.form.fp8_base) {
      this.toast(this.t('field.krea_fp8ConvrotLocked'), 'warning');
    }
    if (['gradient_checkpointing', 'cpu_offload_checkpointing', 'unsloth_offload_checkpointing',
      'gradient_checkpointing_cpu_offload', 'block_swap_h2d_only'].includes(key)) {
      this._enforceCheckpointingUiConstraints(key);
    }
    if (key === 'max_data_loader_n_workers' || key === 'persistent_data_loader_workers') {
      this._enforceDataLoaderUiConstraints();
    }
    if (['timestep_sampling', 'weighting_scheme'].includes(key)) {
      this._refreshSubsetTimestepEditor();
    }
    if (this.timestepPreviewOpen && [
      'timestep_sampling', 'sigmoid_scale', 'discrete_flow_shift', 'weighting_scheme',
      'logit_mean', 'logit_std', 'timestep_cutoff', 'timestep_uniform_ratio', 'mode_scale', 'resolution', 'min_timestep', 'max_timestep', 'preserve_distribution_shape'
    ].includes(key)) {
      this.refreshTimestepPreview();
    }
    if (key === 'cache_latents_to_disk' && oldVal !== true && value === true) {
      this.form.cache_latents = true;
      this._setFieldSource('cache_latents', 'auto');
    }
    if (key === 'cache_latents' && value === false && this.form.cache_latents_to_disk === true) {
      this.form.cache_latents_to_disk = false;
      this._setFieldSource('cache_latents_to_disk', 'auto');
    }
    if (key === 'random_crop' && value === true) {
      const hadCache = this.form.cache_latents === true || this.form.cache_latents_to_disk === true;
      this._enforceImageAugmentationUiConstraints();
      if (hadCache) this.toast(this.t('field.random_cropCacheDisabled'), 'warning');
    }
    if (typeof this.queueTomlPreviewChange === 'function') this.queueTomlPreviewChange(key);
    if (key === 'train_data_dir') this._syncKrea2CacheDir();
    if (key === 'dit') this.scheduleKreaDitFormatCheck();
    if (key === 'optimizer_type' || key === 'gradient_accumulation_steps' ||
        key === 'mixed_precision' || key === 'gpu_ids') {
      this._enforceEmosensUiConstraints(key, emosensPreviousConstraints);
    }
    const fusedInputs = ['automagic_fused', 'gradient_accumulation_steps', 'max_grad_norm', 'mixed_precision', 'gpu_ids'];
    if (fusedInputs.includes(key)) this._enforceAutomagicFusedUiConstraints();
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
    // The latest training-scope choice must not be silently reversed by cache normalization at launch.
    if ((key === 'network_train_unet_only' && value === false)
        || (key === 'network_train_text_encoder_only' && value === true)
        || (key === 'caption_dropout_every_n_epochs' && Number(value) > 0)) {
      this.form.cache_text_encoder_outputs = false;
      this.form.cache_text_encoder_outputs_to_disk = false;
    }
    if (key === 'attn_mode' && value === 'xformers') this.form.split_attn = true;
    if (key === 'blocks_to_swap' && Number(value || 0) === 0
        && ['anima-lora', 'moss-image-lora', 'krea2-lora'].includes(this.form.model_train_type)) {
      this.form.block_swap_h2d_only = false;
    }
    if (this.form.model_train_type === 'sdxl-lora' && value === true && ['xformers', 'sdpa'].includes(key)) {
      this.form[key === 'xformers' ? 'sdpa' : 'xformers'] = false;
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

    if (this.lrPreviewOpen && [
      'model_train_type', 'optimizer_type', 'learning_rate', 'unet_lr', 'text_encoder_lr',
      'lr_scheduler', 'lr_warmup_steps', 'lr_scheduler_num_cycles', 'lr_scheduler_power',
      'lr_decay_steps', 'lr_scheduler_timescale', 'lr_scheduler_min_lr_ratio',
      'warmup_type', 'decay_type', 'step_rules',
      'network_module', 'lycoris_algo', 'enable_loraplus', 'loraplus_lr_ratio',
      'network_train_unet_only', 'network_train_text_encoder_only', 'adafactor_relative_step',
      'krea_adafactor_relative_step', 'krea_training_duration_mode', 'max_train_steps'
    ].includes(key)) {
      this.refreshLrPreview();
    }

    // The error node is reactive; rebuilding the form here would replace the
    // focused input after its first corrected keystroke.
    if (this.formErrors && this.formErrors[key]) {
      this.formErrors[key] = null;
    }
    this._refreshTrainingOptionErrors();
    this.updateTomlDebounced();
  },

  stepField(key, delta) {
    const current = Number(this.form[key]) || 0;
    const field = this.findFieldDef(key);
    const constraints = this._numberConstraints(field);
    const step = constraints.step || 1;
    let newVal = current + delta;
    if (key === 'lokr_factor' && newVal === 0) newVal = delta > 0 ? 1 : -1;
    if (constraints.min !== undefined && newVal < constraints.min) newVal = constraints.min;
    if (constraints.max !== undefined && newVal > constraints.max) newVal = constraints.max;
    // Fix floating-point drift (e.g. 0.1 + 0.2 = 0.30000000000000004)
    const decimals = (String(step).split('.')[1] || '').length;
    newVal = Number(newVal.toFixed(decimals));
    this.setField(key, newVal);
  },

  _currentEffectiveFieldDefault(key) {
    return this._resolveFieldDefault(key).value;
  },

  _resolveFieldDefault(
    key,
    defaults = this._buildFormDefaults(this.form.model_train_type || this._activeTrainType || 'anima-lora'),
    rules = this._collectAutoValueRules(),
  ) {
    if (key === 'lr_scheduler_timescale') return { value: this._defaultLrTimescale(), source: 'default' };
    const matched = rules.find(rule =>
      rule.target === key && this._matchAutoValueRule(rule)
    );
    if (matched && matched.set !== null && matched.set !== undefined) {
      return { value: matched.set, source: 'auto' };
    }
    return { value: Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : '', source: 'default' };
  },
};
