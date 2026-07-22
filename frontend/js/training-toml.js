/* ================================================================
   training-toml.js — TOML generation, Training start/stop
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.trainingTomlMixin = {
  tomlRaw: '',
  tomlHighlighted: '',
  isTraining: false,
  trainingStarting: false,
  isIdle: true,
  taskId: null,
  statusText: 'Idle',
  _tomlDebounceTimer: null,

  // ── TOML ────────────────────────────────────────────────
  // 按表单分组顺序（getVisibleSections 返回 registry section_order + 字段顺序）
  // 生成 TOML 行，使预览顺序 == 参数设置面板顺序。network_args 插在 network 分组后，
  // optimizer_args 插在 optimizer 分组后。omitDefault 字段在值==默认值时跳过（不显示/不传）。
  updateToml() {
    const trainType = this.form.model_train_type || 'anima-lora';
    const allSections = window.getVisibleSections(trainType);
    const fieldByKey = new Map(
      allSections.flatMap(section => (section.fields || []).map(field => [field.key, field]))
    );

    // Collect which LyCORIS UI fields are active (visible in form based on showIf/showIfAny)
    const activeLycorisKeys = new Set();
    const networkModule = this.form.network_module || '';
    const isKohya = networkModule === 'lycoris.kohya';
    const isLycorisNative = networkModule === 'networks.loha' || networkModule === 'networks.lokr';

    // Map UI field key → network_args key (matching adapter.py mappings)
    const NET_ARG_MAP = {
      lycoris_algo: 'algo', conv_dim: 'conv_dim', conv_alpha: 'conv_alpha',
      lokr_factor: 'factor', use_tucker: 'use_tucker', use_scalar: 'use_scalar',
      decompose_both: 'decompose_both', full_matrix: 'full_matrix', train_norm: 'train_norm',
      rank_dropout: 'rank_dropout', module_dropout: 'module_dropout', dropout: 'dropout',
      dora_wd: 'dora_wd', block_size: 'block_size', constraint: 'constraint',
      rescaled: 'rescaled', bypass_mode: 'bypass_mode', rs_lora: 'rs_lora',
      lycoris_preset: 'preset', unbalanced_factorization: 'unbalanced_factorization',
      wd_on_output: 'wd_on_output',
    };
    // Fields only available for lycoris.kohya (not sd-scripts native LoHa/LoKr)
    const KOHYA_ONLY = new Set(['lycoris_algo', 'lycoris_preset',
      'use_scalar', 'decompose_both', 'full_matrix', 'train_norm', 'dropout',
      'dora_wd', 'block_size', 'constraint', 'rescaled', 'bypass_mode', 'rs_lora',
      'unbalanced_factorization', 'wd_on_output']);

    // 跳过的顶层字段：UI-only、merged 优化器字段（由 _buildOptimizerArgs 合并进 optimizer_args）
    const SKIP_TOP_LEVEL = new Set([
      'model_train_type','sample_prompts','optimizer_args_custom','network_args_custom',
      'enable_preview','positive_prompts','negative_prompts',
      'enable_loraplus','loraplus_lr_ratio','loraplus_unet_lr_ratio','loraplus_text_encoder_lr_ratio',
      'sample_cfg','sample_width','sample_height','sample_seed','sample_steps','sample_flow_shift',
      'prodigy_d_coef','prodigy_d0','prodigy_safeguard_warmup',
      'prodigyplus_use_stableadamw','schedulefree_warmup_steps',
      'adafactor_relative_step','adafactor_scale_parameter','adafactor_warmup_init',
      'adafactor_clip_threshold','adafactor_eps','weight_decay','stopcoef',
      'automagic_min_lr','automagic_max_lr','automagic_beta2',
      'automagic_clip_threshold','automagic_polarity_history','automagic_fused',
      'betas','eps','came_weight_decouple','came_fixed_decay','came_clip_threshold',
      'came_ams_bound','came_eps1','came_eps2',
    ]);

    // 分组桶：key=sectionKey → value=行数组。按 allSections 顺序填充再拼接，保证预览==表单顺序。
    const sectionLines = {};
    allSections.forEach(s => { sectionLines[s.key] = []; });

    const pushLine = (sectionKey, line) => {
      if (sectionLines[sectionKey]) sectionLines[sectionKey].push(line);
    };

    // 遍历 sections → fields，按表单同序处理
    for (const section of allSections) {
      for (const f of (section.fields || [])) {
        const k = f.key;
        if (f.hidden) continue;
        if (!this._fieldShowIfMet(f)) continue;
        if (SKIP_TOP_LEVEL.has(k) || k.startsWith('_')) continue;

        const v = this.form[k];
        if (v === '' || v === null || v === undefined) continue;

        // omitDefault：值==默认值时不传/不显示（仅 registry default == sd-scripts default 的字段标记）
        if (f.omitDefault && f.default !== undefined && String(v) === String(f.default)) continue;

        // Collect LyCORIS UI fields for network_args formatting
        if (NET_ARG_MAP[k] && (isKohya || (isLycorisNative && !KOHYA_ONLY.has(k)))) {
          activeLycorisKeys.add(k);
          continue; // not added as top-level line
        }

        if (typeof v === 'boolean') { pushLine(section.key, `${k} = ${v}`); }
        else if (typeof v === 'number') { pushLine(section.key, `${k} = ${v}`); }
        else {
          const coerced = this._coerceNum(v);
          if (coerced !== v) { pushLine(section.key, `${k} = ${coerced}`); }
          else { pushLine(section.key, `${k} = "${String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`); }
        }
      }
    }

    // ── Build network_args（插在 network 分组末尾）──────────────
    const LORAPLUS_ARG_KEYS = [
      'loraplus_lr_ratio',
      'loraplus_unet_lr_ratio',
      'loraplus_text_encoder_lr_ratio',
    ];
    const isManagedLoraplusArg = item => {
      const key = String(item).split('=', 1)[0].trim();
      return LORAPLUS_ARG_KEYS.includes(key);
    };
    const netArgsArr = [];
    const netCustom = this.form.network_args_custom;
    if (netCustom && typeof netCustom === 'string') {
      netArgsArr.push(...netCustom.split('\n').map(s => s.trim()).filter(s => s && !isManagedLoraplusArg(s)));
    }
    // LoRA+ uses the exact sd-scripts network_args names. The product toggle is UI-only.
    const setNetworkArg = (argKey, value) => {
      const prefix = argKey + '=';
      for (let i = netArgsArr.length - 1; i >= 0; i--) {
        if (String(netArgsArr[i]).trim().startsWith(prefix)) netArgsArr.splice(i, 1);
      }
      netArgsArr.push(prefix + String(value));
    };
    const loraplusToggleField = fieldByKey.get('enable_loraplus');
    const loraplusEnabled = this.form.enable_loraplus === true
      && loraplusToggleField
      && this._fieldShowIfMet(loraplusToggleField);
    if (loraplusEnabled) {
      LORAPLUS_ARG_KEYS.forEach(argKey => {
        const ratioField = fieldByKey.get(argKey);
        if (!ratioField || !this._fieldShowIfMet(ratioField)) return;
        const value = this.form[argKey];
        if (value === '' || value === null || value === undefined) return;
        if (typeof value === 'number' && isNaN(value)) return;
        setNetworkArg(argKey, value);
      });
    }
    // LyCORIS UI fields → key=value
    for (const k of activeLycorisKeys) {
      const v = this.form[k];
      // 与 adapter.py _is_empty_value 对齐：跳过 None/undefined/空串/NaN。
      // 注意：布尔 False 不跳过（adapter 明确"toggle 关闭时应显式传入 false"）。
      // 默认值已在收集阶段（omitDefault）过滤，此处剩下的都是用户显式设置的非默认值。
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number' && isNaN(v)) continue;
      const argKey = NET_ARG_MAP[k];
      const val = typeof v === 'boolean' ? String(v).toLowerCase() : String(v);
      netArgsArr.push(`${argKey}=${val}`);
    }
    if (netArgsArr.length > 0) {
      const quoted = netArgsArr.map(s => `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(', ');
      pushLine('network', `network_args = [${quoted}]`);
    }

    // ── Build optimizer_args（插在 optimizer 分组末尾）──────────
    const optArgsArr = this._buildOptimizerArgs(this.form);
    if (optArgsArr.length > 0) {
      const quoted = optArgsArr.map(s => `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(', ');
      pushLine('optimizer', `optimizer_args = [${quoted}]`);
    }

    // ── 按 section_order 拼接所有分组行 ─────────────────────────
    const lines = [];
    allSections.forEach(s => { lines.push(...sectionLines[s.key]); });

    this.tomlRaw = lines.join('\n') || '# ' + this.t('common.noConfigs');
    const highlighted = lines.map(line => {
      if (line.startsWith('#')) return `<span class="toml-comment">${this.esc(line)}</span>`;
      const eq = line.indexOf('=');
      if (eq === -1) return this.esc(line);
      const key = line.substring(0, eq).trim();
      const val = line.substring(eq + 1).trim();
      const valCls = (val.startsWith('"') || val.startsWith("'")) ? 'toml-str' : 'toml-num';
      return `<span class="toml-key">${this.esc(key)}</span> <span class="toml-eq">=</span> <span class="${valCls}">${this.esc(val)}</span>`;
    }).join('\n');
    const preview = document.getElementById('tomlPreview');
    if (preview) {
      if (lines.length === 0) preview.innerHTML = `<span class="toml-comment"># ${this.t('common.noConfigs')}</span>`;
      else preview.innerHTML = highlighted;
    }
  },

  // Debounced TOML update (for x-effect binding, avoids per-keystroke recalc)
  updateTomlDebounced() {
    clearTimeout(this._tomlDebounceTimer);
    this._tomlDebounceTimer = setTimeout(() => this.updateToml(), 250);
  },

  // Helper: check if a field's showIf condition is met
  _fieldShowIfMet(f) {
    const sf = f.showIf;
    if (sf) {
      if (Array.isArray(sf)) {
        // Multi-condition AND: all conditions must match
        return sf.every(c => this._evalShowIfCond(c));
      }
      // Single condition
      return this._evalShowIfCond(sf);
    }
    if (f.showIfAny) {
      // OR-of-ANDs: 任一内层 AND 组全成立
      return f.showIfAny.some(group => group.every(c => this._evalShowIfCond(c)));
    }
    return true;
  },

  copyToml() {
    navigator.clipboard.writeText(this.tomlRaw).then(() => this.toast(this.t('common.copied')));
  },

  _optimizerArgEqualsDefault(value, defaultValue) {
    if (typeof value === 'boolean' || typeof defaultValue === 'boolean') {
      return value === defaultValue;
    }

    const valueText = String(value).trim();
    const defaultText = String(defaultValue).trim();
    if (valueText === defaultText) return true;
    if (!valueText || !defaultText || valueText.includes(',') || defaultText.includes(',')) {
      return false;
    }

    const numericValue = Number(valueText);
    const numericDefault = Number(defaultText);
    return Number.isFinite(numericValue) && Number.isFinite(numericDefault) && numericValue === numericDefault;
  },

  /**
   * 组装 optimizer_args 数组（公共逻辑，TOML 预览和 startTraining 共用）。
   * merged 字段仅在值 ≠ 优化器默认值时写入。
   */
  _buildOptimizerArgs(form) {
    const optArgs = [];
    const optType = form.optimizer_type;

    // 1. 用户自定义参数（直接透传，仅保留含 '=' 的行——sd-scripts 用 arg.split('=') 解析）
    const optCustom = form.optimizer_args_custom;
    if (optCustom && typeof optCustom === 'string') {
      optArgs.push(...optCustom.split('\n').map(s => s.trim()).filter(s => s && s.includes('=')));
    }

    // 2. merged 字段规则：[formKey, argKey, defaultsByOptimizer]
    //    defaults 中值为 null → 非空即写；值为 '' → 空则跳过
    //    默认值取自 window.OPTIMIZER_DEFAULTS（单一数据源，与 training-core.js 共用）
    const DEFS = window.OPTIMIZER_DEFAULTS || {};
    const MERGED_RULES = [
      { form: 'weight_decay', arg: 'weight_decay', defaults: Object.assign({ _fallback: null }, DEFS.weight_decay) },
      { form: 'automagic_min_lr', arg: 'min_lr', defaults: DEFS.automagic_min_lr || { 'vendor.automagic_optimizer.integration.Automagic3': 1e-8 } },
      { form: 'automagic_max_lr', arg: 'max_lr', defaults: DEFS.automagic_max_lr || { 'vendor.automagic_optimizer.integration.Automagic3': 1e-3 } },
      { form: 'automagic_beta2', arg: 'beta2', defaults: DEFS.automagic_beta2 || { 'vendor.automagic_optimizer.integration.Automagic3': 0.999 } },
      { form: 'automagic_clip_threshold', arg: 'clip_threshold', defaults: DEFS.automagic_clip_threshold || { 'vendor.automagic_optimizer.integration.Automagic3': 1.0 } },
      { form: 'automagic_polarity_history', arg: 'polarity_history', defaults: DEFS.automagic_polarity_history || { 'vendor.automagic_optimizer.integration.Automagic3': 8 } },
      { form: 'automagic_fused', arg: 'fused', defaults: DEFS.automagic_fused || { 'vendor.automagic_optimizer.integration.Automagic3': false } },
      { form: 'stopcoef', arg: 'stopcoef', defaults: DEFS.stopcoef || { 'vendor.emo_optimizer.emosens.EmoSens': 0.04 } },
      { form: 'prodigy_d_coef', arg: 'd_coef', defaults: DEFS.prodigy_d_coef || { 'Prodigy': '1.0', 'prodigyplus.ProdigyPlusScheduleFree': '1.0' } },
      { form: 'prodigy_d0', arg: 'd0', defaults: DEFS.prodigy_d0 || { 'Prodigy': '1e-6', 'prodigyplus.ProdigyPlusScheduleFree': '1e-6' } },
      { form: 'prodigy_safeguard_warmup', arg: 'safeguard_warmup', defaults: DEFS.prodigy_safeguard_warmup || { 'Prodigy': false } },
      { form: 'prodigyplus_use_stableadamw', arg: 'use_stableadamw', defaults: DEFS.prodigyplus_use_stableadamw || { 'prodigyplus.ProdigyPlusScheduleFree': true } },
      { form: 'schedulefree_warmup_steps', arg: 'warmup_steps', defaults: DEFS.schedulefree_warmup_steps || { 'AdamWScheduleFree': 0 } },
      { form: 'adafactor_relative_step', arg: 'relative_step', defaults: DEFS.adafactor_relative_step || { 'AdaFactor': true } },
      { form: 'adafactor_scale_parameter', arg: 'scale_parameter', defaults: DEFS.adafactor_scale_parameter || { 'AdaFactor': true } },
      { form: 'adafactor_warmup_init', arg: 'warmup_init', defaults: DEFS.adafactor_warmup_init || { 'AdaFactor': false } },
      { form: 'adafactor_clip_threshold', arg: 'clip_threshold', defaults: DEFS.adafactor_clip_threshold || { 'AdaFactor': 1.0 } },
      { form: 'adafactor_eps', arg: 'eps', defaults: DEFS.adafactor_eps || { 'AdaFactor': '1e-30, 1e-3' } },
      { form: 'betas', arg: 'betas', defaults: DEFS.betas || {
        'AdamW': '0.9,0.999', 'AdamW8bit': '0.9,0.999', 'PagedAdamW8bit': '0.9,0.999',
        'Lion': '0.9,0.99', 'Lion8bit': '0.9,0.99', 'PagedLion8bit': '0.9,0.99',
        'pytorch_optimizer.CAME': '0.9,0.999,0.9999',
        'vendor.emo_optimizer.emosens.EmoSens': '0.9,0.995',
        'AdamWScheduleFree': '0.9,0.999',
        'Prodigy': '0.9,0.999', 'prodigyplus.ProdigyPlusScheduleFree': '0.9,0.99',
      }},
      { form: 'eps', arg: 'eps', defaults: DEFS.eps || {
        'AdamW': '1e-8', 'AdamW8bit': '1e-8', 'PagedAdamW8bit': '1e-8',
        'vendor.emo_optimizer.emosens.EmoSens': '1e-8',
        'AdamWScheduleFree': '1e-8',
        'Prodigy': '1e-8', 'prodigyplus.ProdigyPlusScheduleFree': '1e-8',
      }},
      { form: 'came_weight_decouple', arg: 'weight_decouple', defaults: DEFS.came_weight_decouple || { 'pytorch_optimizer.CAME': true } },
      { form: 'came_fixed_decay', arg: 'fixed_decay', defaults: DEFS.came_fixed_decay || { 'pytorch_optimizer.CAME': false } },
      { form: 'came_clip_threshold', arg: 'clip_threshold', defaults: DEFS.came_clip_threshold || { 'pytorch_optimizer.CAME': 1.0 } },
      { form: 'came_ams_bound', arg: 'ams_bound', defaults: DEFS.came_ams_bound || { 'pytorch_optimizer.CAME': false } },
      { form: 'came_eps1', arg: 'eps1', defaults: DEFS.came_eps1 || { 'pytorch_optimizer.CAME': '1e-30' } },
      { form: 'came_eps2', arg: 'eps2', defaults: DEFS.came_eps2 || { 'pytorch_optimizer.CAME': '1e-16' } },
    ];

    for (const rule of MERGED_RULES) {
      const val = form[rule.form];
      if (val === undefined || val === null || val === '') continue;
      // Skip fields whose showIf/showIfAny condition is not met (hidden fields)
      const fieldDef = this.findFieldDef(rule.form);
      if (fieldDef && !this._fieldShowIfMet(fieldDef)) continue;
      const defVal = rule.defaults[optType] ?? rule.defaults._fallback;
      if (defVal !== undefined && defVal !== null && this._optimizerArgEqualsDefault(val, defVal)) continue;
      // optimizer_args 的值经 sd-scripts 的 ast.literal_eval 解析，
      // 布尔必须用 Python 字面量 True/False（小写 true/false 会让 ast 崩溃）。
      // 注意：network_args 的布尔仍用小写（各 network module 用 == "true" 比较，不走 ast）。
      const formatted = typeof val === 'boolean' ? (val ? 'True' : 'False') : String(val);
      optArgs.push(rule.arg + '=' + formatted);
    }

    return optArgs;
  },

  // ── Training ───────────────────────────────────────────
  async startTraining() {
    if (this.isTraining || this.trainingStarting) return;

    // Form validation before starting
    if (!this.validateForm()) {
      this.toast(this.t('common.formErrors') || 'Please fix form errors before starting training', 'error');
      return;
    }

    const trainType = this.form.model_train_type || 'anima-lora';

    // Validation: Check required fields based on train type
    if (trainType === 'anima-lora') {
      if (!this.form.vae || this.form.vae.trim() === '') {
        this.toast(this.t('common.vaeRequired', 'VAE is required for Anima training'), 'error');
        return;
      }
      if (!this.form.qwen3 || this.form.qwen3.trim() === '') {
        this.toast(this.t('common.qwen3Required', 'Qwen3 model is required for Anima training'), 'error');
        return;
      }
    }

    this.trainingStarting = true;
    const outputPathInfo = await this.refreshOutputPathInfo(true);
    if (!outputPathInfo || !outputPathInfo.available || !outputPathInfo.writable || outputPathInfo.path_is_directory === false) {
      this.toast(this.outputPathBlockingText(), 'error');
      this.trainingStarting = false;
      return;
    }

    const estimate = await this.refreshStepEstimate(true);
    if (!estimate) {
      this.toast(
        this.stepEstimateErrorText() || this.t('stepEstimate.failed', 'Unable to calculate training steps'),
        'error'
      );
      this.trainingStarting = false;
      return;
    }

    this.isTraining = true; this.isIdle = false;
    this.statusText = this.t('common.training') + '...';

    const validKeys = new Set(['model_train_type']);
    const fieldDefMap = {}; // key → field def（查 omitDefault/default）
    const allSections = window.getVisibleSections(trainType);
    allSections.forEach(s => s.fields.forEach(f => {
      fieldDefMap[f.key] = f;
      if (this._fieldShowIfMet(f)) {
        validKeys.add(f.key);
      }
    }));

    const payload = {};
    for (const [k, v] of Object.entries(this.form)) {
      if (!validKeys.has(k)) continue;
      if (v === '' || v === null || v === undefined) continue;
      // omitDefault：值==默认值时不传（与预览一致，避免 sd-scripts 收到冗余的默认值）
      const fd = fieldDefMap[k];
      if (fd && fd.omitDefault && fd.default !== undefined && String(v) === String(fd.default)) continue;
      payload[k] = v;
    }
    for (const [k, v] of Object.entries(payload)) {
      const coerced = this._coerceNum(v);
      if (coerced !== v) { payload[k] = coerced; }
    }

    if (payload.sample_prompts && typeof payload.sample_prompts === 'string') {
      const sp = payload.sample_prompts.trim();
      if (sp) {
        const nIdx = sp.indexOf(' --n ');
        if (nIdx > 0) {
          payload.positive_prompts = sp.substring(0, nIdx).trim();
          const rest = sp.substring(nIdx + 5);
          const wIdx = rest.indexOf(' --w '), hIdx = rest.indexOf(' --h '),
                lIdx = rest.indexOf(' --l '), sIdx = rest.indexOf(' --s '), dIdx = rest.indexOf(' --d '),
                fsIdx = rest.indexOf(' --fs ');
          payload.negative_prompts = (wIdx > 0 ? rest.substring(0, wIdx) : rest).trim();
          if (wIdx > 0) payload.sample_width = parseInt(rest.substring(wIdx + 5)) || 512;
          if (hIdx > 0) payload.sample_height = parseInt(rest.substring(hIdx + 5)) || 512;
          if (lIdx > 0) payload.sample_cfg = parseInt(rest.substring(lIdx + 5)) || 7;
          if (sIdx > 0) payload.sample_steps = parseInt(rest.substring(sIdx + 5)) || 24;
          if (dIdx > 0) payload.sample_seed = parseInt(rest.substring(dIdx + 5)) || 2333;
          if (fsIdx > 0) payload.sample_flow_shift = parseFloat(rest.substring(fsIdx + 5)) || 3.0;
        } else {
          payload.positive_prompts = sp;
        }
      }
      delete payload.sample_prompts;
    }

    // ── Build optimizer_args via shared function ──────────
    const optArgs = this._buildOptimizerArgs(payload);
    // Remove merged fields from top-level payload (they are now in optimizer_args)
    for (const key of ['optimizer_args_custom','weight_decay','stopcoef','prodigy_d_coef','prodigy_d0',
                        'prodigy_safeguard_warmup','prodigyplus_use_stableadamw',
                        'schedulefree_warmup_steps','adafactor_relative_step',
                        'adafactor_scale_parameter','adafactor_warmup_init',
                        'adafactor_clip_threshold','adafactor_eps',
                        'automagic_min_lr','automagic_max_lr','automagic_beta2',
                        'automagic_clip_threshold','automagic_polarity_history','automagic_fused',
                        'betas','eps','came_weight_decouple','came_fixed_decay','came_clip_threshold',
                        'came_ams_bound','came_eps1','came_eps2']) {
      delete payload[key];
    }
    if (optArgs.length > 0) payload.optimizer_args = optArgs;

    try {
      const resp = await fetch('/api/run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const data = await resp.json();
      if (data.status !== 'success') { this.toast(data.message||'Failed'); this.isTraining=false; this.isIdle=true; this.statusText=this.t('monitor.idle','Idle'); }
      else {
        this.taskId = (data.data&&data.data.task_id)||null; this.toast(this.t('common.trainingStarted'));
        // 弹出适配器警告（如有）
        const warnings = data.data && data.data.warnings;
        if (warnings && warnings.length > 0) {
          setTimeout(() => {
            const msg = warnings.join('\n');
            this.toast('⚠️ ' + this.t('common.adapterWarnings'));
            // 使用 alert 确保用户看到重要警告（如 torch_compile 被自动关闭）
            alert('⚠️ ' + this.t('common.adapterWarnings') + ':\n\n' + msg);
          }, 500);
        }
      }
    } catch(e) { this.toast(this.t('common.requestFailed')+': '+e.message); this.isTraining=false; this.isIdle=true; this.statusText='Idle'; }
    this.trainingStarting = false;
  },

  async stopTraining() {
    if (!this.isTraining) return;
    try {
      if (this.taskId) await fetch('/api/tasks/terminate/'+this.taskId);
      this.isTraining = false; this.statusText = 'Idle';
      this.toast(this.t('common.trainingStopped'));
    } catch(e) { this.toast(this.t('common.failed')+': '+e.message); }
  },

  applyRealtimeTrainingSnapshot(snapshot) {
    const managed = snapshot && snapshot.tasks && snapshot.tasks.managed || [];
    this._applyRealtimeTrainingTasks(managed);
  },

  handleRealtimeTrainingEvent(event) {
    if (!event || event.type !== 'server.tasks' || !event.payload) return;
    this._applyRealtimeTrainingTasks(event.payload.tasks || []);
  },

  _applyRealtimeTrainingTasks(tasks) {
    const active = (tasks || []).find(task => task && ['CREATED', 'RUNNING'].includes(task.status));
    this.trainingActive = !!active;
    this.trainingBlocked = !!active;
    this.activeTaskId = active ? active.id : null;
    if (active) {
      this.taskId = active.id;
      this.isTraining = true;
      this.isIdle = false;
      this.statusText = active.status_label || (active.status === 'CREATED'
        ? this.t('monitor.created', 'Pending')
        : this.t('monitor.training', 'Training'));
      this.realtimeTaskStateUnknown = false;
      return;
    }
    if (!this.realtimeTaskStateUnknown) {
      this.isTraining = false;
      this.isIdle = true;
      this.taskId = null;
      this.statusText = this.t('monitor.idle', 'Idle');
    }
  },

  resetRealtimeTrainingState() {
    const wasRunning = !!(this.isTraining || this.taskId || this.activeTaskId || this.trainingBlocked);
    this.taskId = null;
    this.activeTaskId = null;
    this.trainingBlocked = false;
    this.trainingActive = false;
    this.isTraining = false;
    this.isIdle = true;
    if (wasRunning) this.statusText = this.t('monitor.taskStateUnknown', 'Task state unknown');
    return wasRunning;
  }
};
