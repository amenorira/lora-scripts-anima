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

  // ── TOML ────────────────────────────────────────────────
  updateToml() {
    const trainType = this.form.model_train_type || 'sd-lora';
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
      if (k === 'prodigy_d_coef' || k === 'prodigy_d0' || k === 'weight_decay') continue;

      if (typeof v === 'boolean') { if (v) lines.push(`${k} = true`); }
      else if (typeof v === 'number') lines.push(`${k} = ${v}`);
      else if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
        lines.push(`${k} = ${Number(v)}`);
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

    // ── Build optimizer_args ────────────────────────────
    const optArgsArr = [];
    const optCustom = this.form.optimizer_args_custom;
    if (optCustom && typeof optCustom === 'string') {
      optArgsArr.push(...optCustom.split('\n').map(s => s.trim()).filter(s => s));
    }
    if (this.form.weight_decay !== undefined && this.form.weight_decay !== null && this.form.weight_decay !== '') {
      optArgsArr.push('weight_decay=' + this.form.weight_decay);
    }
    if (this.form.optimizer_type === 'Prodigy' || this.form.optimizer_type === 'prodigyplus.ProdigyPlusScheduleFree') {
      if (this.form.prodigy_d_coef && this.form.prodigy_d_coef !== '2.0') optArgsArr.push(`d_coef=${this.form.prodigy_d_coef}`);
      if (this.form.prodigy_d0) optArgsArr.push(`d0=${this.form.prodigy_d0}`);
    }
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

  // ── Training ───────────────────────────────────────────
  async startTraining() {
    if (this.isTraining) return;
    this.isTraining = true; this.isIdle = false;
    this.statusText = this.t('common.training') + '...';

    const validKeys = new Set(['model_train_type']);
    const trainType = this.form.model_train_type || 'sd-lora';
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
        payload[k] = Number(v);
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

    const optArgs = [];
    if (payload.optimizer_args_custom && typeof payload.optimizer_args_custom === 'string') {
      optArgs.push(...payload.optimizer_args_custom.split('\n').map(s => s.trim()).filter(s => s));
      delete payload.optimizer_args_custom;
    }
    if (payload.weight_decay !== undefined && payload.weight_decay !== null && payload.weight_decay !== '') {
      optArgs.push('weight_decay=' + payload.weight_decay);
      delete payload.weight_decay;
    }
    if (payload.optimizer_type === 'Prodigy' || payload.optimizer_type === 'prodigyplus.ProdigyPlusScheduleFree') {
      if (payload.prodigy_d_coef && payload.prodigy_d_coef !== '2.0') optArgs.push(`d_coef=${payload.prodigy_d_coef}`);
      if (payload.prodigy_d0) optArgs.push(`d0=${payload.prodigy_d0}`);
      delete payload.prodigy_d_coef;
      delete payload.prodigy_d0;
    }
    if (optArgs.length > 0) payload.optimizer_args = optArgs;

    try {
      const resp = await fetch('/api/run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      const data = await resp.json();
      if (data.status !== 'success') { this.toast(data.message||'Failed'); this.isTraining=false; this.isIdle=true; this.statusText='Idle'; }
      else { this.taskId = (data.data&&data.data.task_id)||null; this.toast(this.t('common.trainingStarted')); }
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
