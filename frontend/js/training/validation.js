/* Client-side training validation and dependency error messages.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingValidation = {
  formErrors: {},
  _trainingOptionErrorMessages: null,
  fieldErrorHtml(key) {
    const message = this.formErrors?.[key] || '';
    if (!message) return '';
    const names = ['checkpointOffloadConflict', 'blockSwapOffloadConflict', 'blockSwapFullgraphConflict',
      'compile_fullgraphAttentionConflict', 'compile_fullgraphMossConflict', 'partialCheckpointH2dConflict',
      'blockSwapH2dRequiresBlocks', 'base_weightsConvrotConflict', 'adamwFusedForeachConflict',
      'adamwFusedDifferentiableConflict', 'muonNonMatrixConflict', 'kreaQuantizationConflict',
      'kreaTurboBlockSwapConflict', 'kreaTurboQuantizationConflict', 'kreaTurboSourceConflict',
      'krea_dora_fp8Conflict', 'krea_loraplus_structureConflict'];
    // Unknown/server messages are always plain escaped text. Only local,
    // translated conflicts may link to fields present in this training form.
    const name = names.find(name => message === this.t('field.' + name));
    if (!name) return this.esc(message);
    const template = this.t('fieldConflict.' + name);
    if (!template || template === 'fieldConflict.' + name) return this.esc(message);
    const fields = this._allSections().flatMap(section => section.fields || []);
    return template.split(/(\{[a-zA-Z0-9_]+\})/).map(part => {
      if (!/^\{\w+\}$/.test(part)) return this.esc(part);
      let target = part.slice(1, -1);
      if (target === 'adamw_fused' && this.form.model_train_type === 'krea2-lora') target = 'krea_adamw_fused';
      const field = fields.find(field => field.key === target);
      const label = this.esc(field?.argKey || target);
      if (target === key || !field || !this._fieldShowIfMet(field)) return label;
      return `<button type="button" class="field-conflict-link" @click="focusTrainingField('${target}')">${label}</button>`;
    }).join('');
  },

  // ── Validation ────────────────────────────────────────
  _parseStepRules(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parts = value.split(',');
    const numberPattern = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
    const boundaries = [];
    let previous = 0, finalMultiplier = 0;
    for (let index = 0; index < parts.length; index++) {
      const pair = parts[index].split(':').map(token => token.trim());
      const last = index === parts.length - 1;
      if (pair.length !== (last ? 1 : 2) || !numberPattern.test(pair[0])) return null;
      const multiplier = Number(pair[0]);
      if (!Number.isFinite(multiplier) || multiplier < 0) return null;
      if (last) finalMultiplier = multiplier;
      else {
        if (!/^[0-9]+$/.test(pair[1])) return null;
        const endStep = Number(pair[1]);
        if (!Number.isSafeInteger(endStep) || endStep <= previous) return null;
        boundaries.push({ endStep, multiplier });
        previous = endStep;
      }
    }
    return { boundaries, finalMultiplier };
  },

  _refreshTrainingOptionErrors() {
    const errors = { ...this.formErrors };
    // Only clear messages we still own; a server error may have replaced the same field's message.
    Object.entries(this._trainingOptionErrorMessages || {}).forEach(([key, message]) => {
      if (errors[key] === message) errors[key] = null;
    });
    const current = { ...this._timestepOptionErrors(), ...this._checkpointOffloadErrors(), ...this._mossOptionErrors(),
      ...this._kreaOptionErrors(), ...this._muonOptionErrors(), ...this._adamwOptionErrors() };
    this._trainingOptionErrorMessages = current;
    this.formErrors = { ...errors, ...current };
  },

  _adamwOptionValues(overrides = {}) {
    const form = { ...this.form, ...overrides };
    if (form.optimizer_type !== 'AdamW') return {};
    const values = {};
    for (const line of String(form.optimizer_args_custom || '').split('\n')) {
      const match = line.match(/^\s*(fused|foreach|differentiable)\s*=(.*)$/);
      if (!match) continue;
      let literal = match[2].split('#', 1)[0].trim();
      while (literal.startsWith('(') && literal.endsWith(')')) literal = literal.slice(1, -1).trim();
      values[match[1]] = { True: true, False: false, None: null }[literal];
    }
    const fusedKey = form.model_train_type === 'krea2-lora' ? 'krea_adamw_fused' : 'adamw_fused';
    for (const [key, argument] of [[fusedKey, 'fused'], ['foreach', 'foreach']]) {
      if (String(form[key]) === 'true') values[argument] = true;
      else if (String(form[key]) === 'false') values[argument] = false;
    }
    return values;
  },

  _adamwOptionDisabledReason(key, value) {
    const fusedKey = this.form.model_train_type === 'krea2-lora' ? 'krea_adamw_fused' : 'adamw_fused';
    if (this.form.optimizer_type !== 'AdamW' || !['foreach', fusedKey].includes(key)) return '';
    // Auto can restore a custom True, so evaluate the prospective exported values.
    const values = this._adamwOptionValues({ [key]: value });
    if (values.fused === true) {
      if (values.foreach === true) return this.t('field.adamwFusedForeachConflict');
      if (key === fusedKey && values.differentiable === true) return this.t('field.adamwFusedDifferentiableConflict');
    }
    return '';
  },

  _adamwOptionErrors() {
    const values = this._adamwOptionValues();
    if (values.fused !== true) return {};
    const errors = {};
    const fusedKey = this.form.model_train_type === 'krea2-lora' ? 'krea_adamw_fused' : 'adamw_fused';
    if (values.foreach === true) {
      errors.foreach = errors[fusedKey] = this.t('field.adamwFusedForeachConflict');
    }
    if (values.differentiable === true) {
      errors.optimizer_args_custom = errors[fusedKey] = this.t('field.adamwFusedDifferentiableConflict');
    }
    return errors;
  },

  _checkpointOffloadErrors() {
    if (!['anima-lora', 'moss-image-lora', 'krea2-lora'].includes(this.form.model_train_type)) return {};
    const errors = {};
    const swapping = Number(this.form.blocks_to_swap || 0) > 0;
    if (this.form.block_swap_h2d_only && !swapping) errors.block_swap_h2d_only = this.t('field.blockSwapH2dRequiresBlocks');
    // Musubi uses different offload and compile paths; only the H2D prerequisite is shared.
    if (this.form.model_train_type === 'krea2-lora') return errors;
    const cpu = this.form.cpu_offload_checkpointing, unsloth = this.form.unsloth_offload_checkpointing;
    const counts = [this.form.blocks_to_swap || 0, this.form.gradient_checkpointing_skip_blocks || 0,
      this.form.block_swap_ring_size ?? 2];
    const validCounts = counts.every(value => typeof value !== 'boolean'
      && Number.isFinite(Number(value)) && Number.isInteger(Number(value)) && Number(value) >= 0);
    const [swapped, skipped, slots] = counts.map(Number);
    if (this.form.block_swap_h2d_only && (this.form.gradient_checkpointing === true || cpu || unsloth)
        && validCounts && slots >= 1 && swapped > slots && skipped > slots) {
      errors.gradient_checkpointing_skip_blocks = this.t('field.partialCheckpointH2dConflict');
    }
    if (cpu && unsloth) errors.unsloth_offload_checkpointing = this.t('field.checkpointOffloadConflict');
    if (swapping && (cpu || unsloth)) errors.blocks_to_swap = this.t('field.blockSwapOffloadConflict');
    if (swapping && this.form.compile && this.form.compile_fullgraph) {
      errors.compile_fullgraph = this.t('field.blockSwapFullgraphConflict');
    }
    if (this.form.compile && this.form.compile_fullgraph
        && (this.form.split_attn || this.form.attn_mode === 'xformers')) {
      errors.compile_fullgraph = this.t('field.compile_fullgraphAttentionConflict');
    }
    return errors;
  },

  _timestepOptionErrors() {
    if (!['anima-lora', 'moss-image-lora'].includes(this.form.model_train_type)
      || this.form.timestep_sampling !== 'truncated_logit_normal') return {};
    const errors = {};
    for (const [key, fallback, maximum, inclusive] of [
      ['timestep_cutoff', 0.95, 1, false], ['timestep_uniform_ratio', 0.01, 1, true], ['logit_std', 1, Infinity, false],
    ]) {
      const raw = this.form[key];
      const value = raw === '' || raw == null ? fallback : Number(raw);
      if (typeof raw === 'boolean' || !Number.isFinite(value) || (inclusive ? value < 0 : value <= 0) || value > maximum) {
        errors[key] = this.t('field.' + (key === 'logit_std' ? 'truncatedLogitStdError' : key + 'Error'));
      }
    }
    return errors;
  },

  _kreaOptionErrors() {
    if (this.form.model_train_type !== 'krea2-lora') return {};
    const errors = {};
    if (this.form.krea_attention_backend === 'xformers' && this.form.krea_split_attn === 'false') {
      errors.krea_split_attn = this.t('field.split_attnXformersLocked');
    }
    if ((this.form.network_module === 'networks.lora_krea2' || this.form.lycoris_algo === 'lora')
        && this.form.enable_loraplus && this.form.dim_from_weights) {
      errors.dim_from_weights = this.t('field.krea_loraplus_structureConflict');
    }
    if (this.form.network_module === 'lycoris.kohya' && (this.form.fp8_base || this.form.convrot_int8) && this.form.dora_wd) {
      errors.dora_wd = this.t('field.krea_dora_fp8Conflict');
    }
    if (this.form.network_module === 'lycoris.kohya' && this.form.lycoris_algo === 'lora'
      && this.form.dora_wd && Number(this.form.dropout || 0) > 0) {
      errors.dropout = this.t('field.krea_locon_dropoutHint');
    }
    if (['vendor.lora_muon.LoRA_Muon', 'pytorch_optimizer.LoRARite'].includes(this.form.optimizer_type)) {
      if (this.form.network_module === 'lycoris.kohya'
        && (this.form.lycoris_algo !== 'lora' || this.form.use_scalar || this.form.dora_wd)) {
        errors.optimizer_type = this.t('field.krea_paired_optimizerHint');
      }
    }
    if (this.form.krea_target_mode === 'custom' && !String(this.form.krea_target_include || '').trim()) {
      errors.krea_target_include = this.t('common.fieldRequired');
    }
    if (this.form.network_module === 'lycoris.kohya' && this.form.lycoris_algo === 'lokr'
      && (Number(this.form.lokr_factor) === 0 || Number(this.form.lokr_factor) < -1)) {
      errors.lokr_factor = this.t('field.krea_factorRangeError');
    }
    if (this.form.enable_krea_samples && String(this.form.turbo_dit || '').trim()
        && Number(this.form.blocks_to_swap || 0) > 0) {
      errors.turbo_dit = this.t('field.kreaTurboBlockSwapConflict');
    }
    if (this.form.fp8_base && this.form.convrot_int8) errors.convrot_int8 = this.t('field.kreaQuantizationConflict');
    if (this.form.enable_krea_samples && String(this.form.turbo_dit || '').trim()) {
      if (this.form.convrot_int8) errors.turbo_dit = this.t('field.kreaTurboQuantizationConflict');
      if (String(this.form.turbo_lora || '').trim()) errors.turbo_lora = this.t('field.kreaTurboSourceConflict');
    }
    if (!(Number(this.form.min_timestep ?? 0) < Number(this.form.max_timestep ?? 1000))) {
      errors.max_timestep = this.t('field.kreaTimestepRangeError');
    }
    return errors;
  },

  _mossOptionErrors() {
    if (this.form.model_train_type !== 'moss-image-lora') return {};
    const errors = {};
    if (this.form.enable_preview && (this.form.sample_at_first || this.form.sample_interval_mode !== 'none')
      && !String(this.form.positive_prompts || '').trim()) {
      errors.positive_prompts = this.t('common.previewPromptRequired');
    }
    const weights = this.form.base_weights;
    const hasWeights = (Array.isArray(weights) ? weights : String(weights || '').split(','))
      .some(value => String(value).trim());
    if (hasWeights && (this.form.convrot_int8 || this.form.convrot_int8_text_encoder)) {
      errors.base_weights = this.t('field.base_weightsConvrotConflict');
    }
    if (this.form.compile && this.form.compile_fullgraph && (
      Number(this.form.blocks_to_swap || 0) > 0
      || this.form.split_attn || this.form.attn_mode === 'xformers'
    )) {
      errors.compile_fullgraph = this.t('field.compile_fullgraphMossConflict');
    }
    return errors;
  },

  _muonOptionErrors() {
    if (!['Muon', 'torch.optim.Muon'].includes(this.form.optimizer_type)) return {};
    const errors = {};
    const rawMomentum = this.form.muon_momentum;
    if (rawMomentum !== undefined && rawMomentum !== null && rawMomentum !== '') {
      const momentum = Number(rawMomentum);
      if (!Number.isFinite(momentum) || momentum < 0 || momentum >= 1) {
        errors.muon_momentum = this.t('field.muonMomentumRangeError');
      }
    }
    if (this.form.network_module !== 'lycoris.kohya') return errors;
    for (const key of ['use_scalar', 'train_norm']) {
      if (this.form[key] === true) errors[key] = this.t('field.muonNonMatrixConflict');
    }
    return errors;
  },

  validateForm() {
    const errors = {};
    // Check all required fields
    const currentGroup = window.TRAIN_GROUP_MAP[this.form.model_train_type || 'anima-lora'] || 'all';
    const sections = this._allSections();
    for (const section of sections) {
      for (const field of section.fields) {
        if (typeof this._fieldShowIfMet === 'function' && !this._fieldShowIfMet(field)) continue;
        const val = this.form[field.key];
        if (field.type === 'number' && val !== undefined && val !== null && val !== '') {
          const number = Number(val), constraints = this._numberConstraints(field);
          const step = Number(constraints.step), base = Number(constraints.min || 0);
          if (!Number.isFinite(number) || typeof val === 'boolean'
            || (constraints.min !== undefined && (number < constraints.min
              || (constraints.minExclusive && number === constraints.min)))
            || (constraints.max !== undefined && (number > constraints.max
              || (constraints.maxExclusive && number === constraints.max)))
            || (Number.isInteger(step) && step > 0 && (!Number.isInteger(number)
              || Math.abs((number - base) / step - Math.round((number - base) / step)) > 1e-9))) {
            errors[field.key] = this.t('common.invalidNumericValue');
          }
        }
        const isFieldRequired = field.required ||
          (field.requiredGroups && Array.isArray(field.requiredGroups) && field.requiredGroups.includes(currentGroup));
        if (!isFieldRequired) continue;
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
        errors['vae'] = this.t('common.vaeRequired');
      }
      if (!this.form.qwen3 || String(this.form.qwen3).trim() === '') {
        errors['qwen3'] = this.t('common.qwen3Required');
      }
    }

    if (this.form.lr_scheduler === 'piecewise_constant'
      && !this._parseStepRules(this.form.step_rules)) {
      errors.step_rules = this.t('field.step_rulesError');
    }
    Object.assign(errors, this._timestepOptionErrors(), this._checkpointOffloadErrors(), this._mossOptionErrors(), this._kreaOptionErrors(), this._muonOptionErrors(), this._adamwOptionErrors());
    if (this.form.model_train_type !== 'krea2-lora' && this.form.enable_preview && this.form.sample_interval_mode !== 'none') {
      const key = this.form.sample_interval_mode === 'steps' ? 'sample_every_n_steps' : 'sample_every_n_epochs';
      if (this.form[key] === '' || this.form[key] === null || this.form[key] === undefined) errors[key] = this.t('common.fieldRequired');
    }

    this.formErrors = errors;
    const hasErrors = Object.keys(errors).length > 0;
    if (hasErrors) {
      this.$nextTick(() => this.focusTrainingField(Object.keys(errors)[0]));
    }
    return !hasErrors;
  },
};
