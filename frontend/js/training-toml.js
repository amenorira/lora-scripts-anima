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
    const validKeys = new Set();
    const r = this.currentRoute;
    const cfg = ROUTE_CONFIG[r] || {};
    const allSections = [...TRAIN_SECTIONS_COMMON];
    if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
    allSections.forEach(s => s.fields.forEach(f => {
      if (!f.showIf || this.form[f.showIf.key] === f.showIf.eq) {
        validKeys.add(f.key);
      }
    }));

    const lines = [];

    if (validKeys.has('model_train_type') && this.form.model_train_type) {
      lines.push(`model_train_type = "${this.form.model_train_type}"`);
    }

    for (const [k, v] of Object.entries(this.form)) {
      if (!validKeys.has(k)) continue;
      if (k === 'model_train_type') continue;
      if (k.startsWith('_')) continue;
      if (k === 'sample_prompts' || k === 'optimizer_args_custom') continue;
      if (v === '' || v === null || v === undefined) continue;
      if (k === 'prodigy_d_coef' || k === 'prodigy_d0') continue;

      if (typeof v === 'boolean') { if (v) lines.push(`${k} = true`); }
      else if (typeof v === 'number') lines.push(`${k} = ${v}`);
      else if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
        lines.push(`${k} = ${Number(v)}`);
      }
      else lines.push(`${k} = "${String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`);
    }

    const optArgsArr = [];
    const custom = this.form.optimizer_args_custom;
    if (custom && typeof custom === 'string') {
      optArgsArr.push(...custom.split('\n').map(s => s.trim()).filter(s => s));
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

  copyToml() {
    navigator.clipboard.writeText(this.tomlRaw).then(() => this.toast(this.t('common.copied')));
  },

  // ── Training ───────────────────────────────────────────
  async startTraining() {
    if (this.isTraining) return;
    this.isTraining = true; this.isIdle = false;
    this.statusText = this.t('common.training') + '...';

    const validKeys = new Set(['model_train_type']);
    const r = this.currentRoute;
    const cfg = ROUTE_CONFIG[r] || {};
    const allSections = [...TRAIN_SECTIONS_COMMON];
    if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
    allSections.forEach(s => s.fields.forEach(f => {
      if (!f.showIf || this.form[f.showIf.key] === f.showIf.eq) {
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
