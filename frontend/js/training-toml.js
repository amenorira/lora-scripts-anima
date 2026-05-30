/* ================================================================
   training-toml.js — TOML generation, Training start/stop
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.trainingTomlMixin = {
  tomlRaw: '',
  tomlHighlighted: '',
  isTraining: false,
  isIdle: true,
  taskId: null,
  statusText: 'Idle',
  _tomlDebounceTimer: null,

  // ── TOML ────────────────────────────────────────────────
  updateToml() {
    const trainType = this.form.model_train_type || 'anima-lora';
    const allSections = window.getVisibleSections(trainType);
    const lines = [];

    // Collect which LyCORIS UI fields are active (visible in form based on showIf)
    const activeLycorisKeys = new Set();
    const networkModule = this.form.network_module || '';
    const isKohya = networkModule === 'lycoris.kohya';
    const isLycorisNative = networkModule === 'networks.loha' || networkModule === 'networks.lokr';

    // Map UI field key → network_args key (matching adapter.py mappings)
    const NET_ARG_MAP = {
      lycoris_algo: 'algo', conv_dim: 'conv_dim', conv_alpha: 'conv_alpha',
      lokr_factor: 'factor', use_cp: 'use_cp', use_scalar: 'use_scalar',
      decompose_both: 'decompose_both', full_matrix: 'full_matrix', train_norm: 'train_norm',
      rank_dropout: 'rank_dropout', module_dropout: 'module_dropout', dropout: 'dropout',
      dora_wd: 'dora_wd', block_size: 'block_size', constraint: 'constraint',
      rescaled: 'rescaled', bypass_mode: 'bypass_mode', rs_lora: 'rs_lora',
    };
    // Fields only available for lycoris.kohya (not sd-scripts native LoHa/LoKr)
    const KOHYA_ONLY = new Set(['lycoris_algo','use_cp','use_scalar','decompose_both','full_matrix',
      'train_norm','dropout','dora_wd','block_size','constraint','rescaled','bypass_mode','rs_lora']);

    for (const [k, v] of Object.entries(this.form)) {
      // Check if this field is visible (not hidden, showIf met)
      let fieldVisible = false;
      for (const s of allSections) {
        const f = (s.fields || []).find(x => x.key === k);
        if (f) {
          if (f.hidden) break;
          if (!f.showIf || this._fieldShowIfMet(f)) fieldVisible = true;
          break;
        }
      }
      if (!fieldVisible) continue;
      if (k === 'model_train_type' || k.startsWith('_')) continue;
      if (k === 'sample_prompts' || k === 'optimizer_args_custom' || k === 'network_args_custom') continue;
      if (v === '' || v === null || v === undefined) continue;

      // Collect LyCORIS UI fields for network_args formatting
      if (NET_ARG_MAP[k] && (isKohya || (isLycorisNative && !KOHYA_ONLY.has(k)))) {
        activeLycorisKeys.add(k);
        continue; // not added as top-level line
      }
      // Skip preview-only UI fields and merged optimizer fields
      if (['enable_preview','positive_prompts','negative_prompts',
           'sample_cfg','sample_width','sample_height','sample_seed','sample_steps'].includes(k)) continue;
      if (k === 'prodigy_d_coef' || k === 'prodigy_d0' || k === 'weight_decay' || k === 'stopcoef') continue;

      if (typeof v === 'boolean') { lines.push(`${k} = ${v}`); }
      else if (typeof v === 'number') lines.push(`${k} = ${v}`);
      else if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
        // Preserve scientific notation (e.g. "1e-4") as-is, convert plain numbers
        const trimmed = v.trim();
        if (/^-?\d+\.?\d*[eE][+-]?\d+$/.test(trimmed)) {
          lines.push(`${k} = ${trimmed}`);
        } else {
          lines.push(`${k} = ${Number(trimmed)}`);
        }
      }
      else lines.push(`${k} = "${String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`);
    }

    // ── Build network_args ──────────────────────────────
    const netArgsArr = [];
    // Custom network_args
    const netCustom = this.form.network_args_custom;
    if (netCustom && typeof netCustom === 'string') {
      netArgsArr.push(...netCustom.split('\n').map(s => s.trim()).filter(s => s));
    }
    // LyCORIS UI fields → key=value
    for (const k of activeLycorisKeys) {
      const v = this.form[k];
      // Match adapter.py _is_empty_value: skip None, false, NaN, empty strings
      if (v === null || v === undefined || v === false || v === '') continue;
      if (typeof v === 'number' && isNaN(v)) continue;
      const argKey = NET_ARG_MAP[k];
      const val = typeof v === 'boolean' ? String(v).toLowerCase() : String(v);
      netArgsArr.push(`${argKey}=${val}`);
    }
    if (netArgsArr.length > 0) {
      const quoted = netArgsArr.map(s => `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(', ');
      lines.push(`network_args = [${quoted}]`);
    }

    // ── Build optimizer_args (shared logic) ──────────────
    const optArgsArr = this._buildOptimizerArgs(this.form);
    if (optArgsArr.length > 0) {
      const quoted = optArgsArr.map(s => `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(', ');
      lines.push(`optimizer_args = [${quoted}]`);
    }

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
    if (!sf) return true;
    const pv = this.form[sf.key];
    if (sf.eq !== undefined) {
      if (String(pv) === String(sf.eq)) return true;
      if (sf.or && Array.isArray(sf.or)) return sf.or.some(function(v) { return String(pv) === String(v); });
      return false;
    }
    if (sf.neq !== undefined) {
      return String(pv) !== String(sf.neq) && pv !== null && pv !== undefined && pv !== '';
    }
    return true;
  },

  copyToml() {
    navigator.clipboard.writeText(this.tomlRaw).then(() => this.toast(this.t('common.copied')));
  },

  /**
   * 组装 optimizer_args 数组（公共逻辑，TOML 预览和 startTraining 共用）。
   * merged 字段仅在值 ≠ 优化器默认值时写入。
   */
  _buildOptimizerArgs(form) {
    const optArgs = [];
    const optType = form.optimizer_type;

    // 1. 用户自定义参数（直接透传）
    const optCustom = form.optimizer_args_custom;
    if (optCustom && typeof optCustom === 'string') {
      optArgs.push(...optCustom.split('\n').map(s => s.trim()).filter(s => s));
    }

    // 2. merged 字段规则：[formKey, argKey, defaultsByOptimizer]
    //    defaults 中值为 null → 非空即写；值为 '' → 空则跳过
    const MERGED_RULES = [
      { form: 'weight_decay', arg: 'weight_decay', defaults: { _fallback: null } },
      { form: 'stopcoef', arg: 'stopcoef', defaults: { 'vendor.emo_optimizer.emosens.EmoSens': 0.04 } },
      { form: 'prodigy_d_coef', arg: 'd_coef', defaults: { 'Prodigy': '1.0', 'prodigyplus.ProdigyPlusScheduleFree': '1.0' } },
      { form: 'prodigy_d0', arg: 'd0', defaults: { 'Prodigy': '', 'prodigyplus.ProdigyPlusScheduleFree': '' } },
      { form: 'betas', arg: 'betas', defaults: {
        'AdamW': '0.9,0.999', 'AdamW8bit': '0.9,0.999', 'PagedAdamW8bit': '0.9,0.999',
        'Lion': '0.9,0.99', 'Lion8bit': '0.9,0.99', 'PagedLion8bit': '0.9,0.99',
        'pytorch_optimizer.CAME': '0.9,0.999,0.9999',
        'vendor.emo_optimizer.emosens.EmoSens': '0.9,0.995',
      }},
      { form: 'eps', arg: 'eps', defaults: {
        'AdamW': '1e-8', 'AdamW8bit': '1e-8', 'PagedAdamW8bit': '1e-8',
        'pytorch_optimizer.CAME': '1e-16',
        'vendor.emo_optimizer.emosens.EmoSens': '1e-8',
      }},
      { form: 'came_weight_decouple', arg: 'weight_decouple', defaults: { 'pytorch_optimizer.CAME': true } },
      { form: 'came_fixed_decay', arg: 'fixed_decay', defaults: { 'pytorch_optimizer.CAME': false } },
      { form: 'came_clip_threshold', arg: 'clip_threshold', defaults: { 'pytorch_optimizer.CAME': 1.0 } },
      { form: 'came_ams_bound', arg: 'ams_bound', defaults: { 'pytorch_optimizer.CAME': false } },
      { form: 'came_eps1', arg: 'eps1', defaults: { 'pytorch_optimizer.CAME': '1e-30' } },
      { form: 'came_eps2', arg: 'eps2', defaults: { 'pytorch_optimizer.CAME': '1e-16' } },
    ];

    for (const rule of MERGED_RULES) {
      const val = form[rule.form];
      if (val === undefined || val === null || val === '') continue;
      // Skip fields whose showIf condition is not met (hidden fields)
      const fieldDef = this.findFieldDef(rule.form);
      if (fieldDef && fieldDef.showIf && !this._fieldShowIfMet(fieldDef)) continue;
      const defVal = rule.defaults[optType] ?? rule.defaults._fallback;
      if (defVal !== undefined && defVal !== null && String(val) === String(defVal)) continue;
      const formatted = typeof val === 'boolean' ? String(val).toLowerCase() : String(val);
      optArgs.push(rule.arg + '=' + formatted);
    }

    return optArgs;
  },

  // ── Training ───────────────────────────────────────────
  async startTraining() {
    if (this.isTraining) return;

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

    this.isTraining = true; this.isIdle = false;
    this.statusText = this.t('common.training') + '...';

    const validKeys = new Set(['model_train_type']);
    const allSections = window.getVisibleSections(trainType);
    allSections.forEach(s => s.fields.forEach(f => {
      if (!f.showIf || this._fieldShowIfMet(f)) {
        validKeys.add(f.key);
      }
    }));

    const payload = {};
    for (const [k, v] of Object.entries(this.form)) {
      if (!validKeys.has(k)) continue;
      if (v === '' || v === null || v === undefined) continue;
      payload[k] = v;
    }
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
        // Preserve scientific notation as string for TOML compatibility
        const trimmed = v.trim();
        if (/^-?\d+\.?\d*[eE][+-]?\d+$/.test(trimmed)) {
          payload[k] = trimmed; // keep as string "1e-4"
        } else {
          payload[k] = Number(trimmed);
        }
      }
    }

    if (payload.sample_prompts && typeof payload.sample_prompts === 'string') {
      const sp = payload.sample_prompts.trim();
      if (sp) {
        const nIdx = sp.indexOf(' --n ');
        if (nIdx > 0) {
          payload.positive_prompts = sp.substring(0, nIdx).trim();
          const rest = sp.substring(nIdx + 5);
          const wIdx = rest.indexOf(' --w '), hIdx = rest.indexOf(' --h '),
                lIdx = rest.indexOf(' --l '), sIdx = rest.indexOf(' --s '), dIdx = rest.indexOf(' --d ');
          payload.negative_prompts = (wIdx > 0 ? rest.substring(0, wIdx) : rest).trim();
          if (wIdx > 0) payload.sample_width = parseInt(rest.substring(wIdx + 5)) || 512;
          if (hIdx > 0) payload.sample_height = parseInt(rest.substring(hIdx + 5)) || 512;
          if (lIdx > 0) payload.sample_cfg = parseInt(rest.substring(lIdx + 5)) || 7;
          if (sIdx > 0) payload.sample_steps = parseInt(rest.substring(sIdx + 5)) || 24;
          if (dIdx > 0) payload.sample_seed = parseInt(rest.substring(dIdx + 5)) || 2333;
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
                        'betas','eps','came_weight_decouple','came_fixed_decay','came_clip_threshold',
                        'came_ams_bound','came_eps1','came_eps2']) {
      delete payload[key];
    }
    if (optArgs.length > 0) payload.optimizer_args = optArgs;

    try {
      const resp = await fetch('/api/run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const data = await resp.json();
      if (data.status !== 'success') { this.toast(data.message||'Failed'); this.isTraining=false; this.isIdle=true; this.statusText='Idle'; }
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
  },

  async stopTraining() {
    if (!this.isTraining) return;
    try {
      if (this.taskId) await fetch('/api/tasks/terminate/'+this.taskId);
      this.isTraining = false; this.statusText = 'Idle';
      this.toast(this.t('common.trainingStopped'));
    } catch(e) { this.toast(this.t('common.failed')+': '+e.message); }
  }
};
