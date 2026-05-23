/* ================================================================
   training.js — Training forms, TOML, start/stop, param save/load
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.trainingMixin = {
  // ── State ──────────────────────────────────────────────
  form: {},
  formDefaults: {},
  formHistory: [],
  formHistoryIdx: -1,
  tomlRaw: '',
  tomlHighlighted: '',
  isTraining: false,
  isIdle: true,
  taskId: null,
  statusText: 'Idle',
  showLoadModal: false,
  savedConfigs: [],

  // ── Training Form ──────────────────────────────────────
  buildTrainForm() {
    const r = this.currentRoute;
    const cfg = ROUTE_CONFIG[r] || {};
    let trainType = cfg.trainType || 'sd-lora';
    if (r === 'train-anima') trainType = 'anima-lora';

    const savedKey = 'anima-form-' + r;
    let saved = null;
    try { const raw = localStorage.getItem(savedKey); if (raw) saved = JSON.parse(raw); } catch (e) {}

    const defaults = {};
    const allSections = [...TRAIN_SECTIONS_COMMON];
    if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
    allSections.forEach(s => { s.fields.forEach(f => { if (f.default !== undefined) defaults[f.key] = f.default; }); });
    defaults.model_train_type = trainType;

    this.form = { ...defaults, ...(saved || {}) };
    this.formDefaults = { ...this.form };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;

    this.renderTrainingForm(allSections);

    const showIfKeys = new Set();
    allSections.forEach(s => s.fields.forEach(f => {
      if (f.showIf) showIfKeys.add(f.showIf.key);
    }));
    const self = this;
    showIfKeys.forEach(k => {
      self.$watch('form.' + k, () => self.rebuildForm());
    });

    const savedKeyLocal = savedKey;
    this.$watch('form', () => {
      try { localStorage.setItem(savedKeyLocal, JSON.stringify(self.form)); } catch (e) {}
    });
  },

  renderTrainingForm(sections) {
    const container = document.getElementById('trainFormContent');
    if (!container) return;
    let html = '';
    sections.forEach(section => {
      const visibleFields = section.fields.filter(f => {
        if (!f.showIf) return true;
        return this.form[f.showIf.key] === f.showIf.eq;
      });
      if (visibleFields.length === 0) return;
      html += `<div class="card" data-section="${section.key}">`;
      html += `<div class="card-header">${this.t(section.titleKey) || section.titleKey}</div>`;
      visibleFields.forEach(field => { html += this.renderField(field); });
      html += `</div>`;
    });
    container.innerHTML = html;
  },

  renderField(field) {
    const val = this.form[field.key];
    const label = this.t(field.descKey) || field.descKey || field.key;
    const hint = field.hintKey ? this.t(field.hintKey) : '';
    const dataKey = field.key;

    let inputHtml = '';

    if (field.type === 'toggle') {
      inputHtml = `<label class="toggle"><input type="checkbox" x-model="form.${dataKey}"><span class="toggle-track"><span class="toggle-thumb"></span></span></label>`;
    } else if (field.type === 'select') {
      const fc = {};
      const self = this;
      const resolveOption = (o) => {
        const cloned = { v: o.v, l: o.l };
        if (o.dKey) { cloned.d = self.t(o.dKey) || ''; }
        else if (o.d) { cloned.d = o.d; }
        return cloned;
      };

      if (field.groups && field.groups.length) {
        fc.groups = field.groups.map(g => ({
          label: g.labelKey ? (self.t(g.labelKey) || g.label) : (g.label || ''),
          options: (g.options || []).map(o => resolveOption(o))
        }));
      } else if (field.options && field.options.length) {
        fc.options = field.options.map(o => resolveOption(o));
      } else {
        fc.options = [];
      }

      const hasGroups = !!(fc.groups && fc.groups.length);
      const hasOptionDescs = (fc.options || []).some(o => o.d) || (fc.groups || []).some(g => (g.options || []).some(o => o.d));

      if (hasGroups || hasOptionDescs) {
        inputHtml = `<div class="anima-select"
          x-data="animaSelect('${this.escJson(fc)}', '${(val || '').replace(/'/g, "\\'")}')"
          @click.outside="closeOnOutside()">
          <input type="hidden" x-ref="modelInput" x-model="form.${dataKey}">
          <button type="button" class="anima-select-trigger" :class="{ focused: open }"
            @click="toggle()">
            <span class="anima-select-trigger-text" x-text="selectedLabel"></span>
            <svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="anima-select-menu" x-show="open" x-transition>
            <div class="anima-select-menu-scroll">
              <template x-for="(group, gIdx) in displayGroups" :key="gIdx">
                <div class="anima-select-group">
                  <div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div>
                  <template x-for="(opt, oIdx) in group.options" :key="opt.v">
                    <div class="anima-select-option"
                      :class="{ active: opt.v === value }"
                      @click="select(opt.v)"
                      @mouseenter="onOptionMouseEnter(oIdx, opt)"
                      @mouseleave="onOptionMouseLeave()">
                      <span x-text="opt.l" :title="opt.l"></span>
                      <svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                  </template>
                </div>
              </template>
              <div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div>
            </div>
            <div class="anima-select-menu-desc" x-show="hoveredOpt && hoveredOpt.d" x-text="hoveredOpt ? hoveredOpt.d : ''"></div>
          </div>
        </div>`;
      } else {
        inputHtml = `<div class="anima-select"
          x-data="animaSelect('${this.escJson(fc)}', '${(val || '').replace(/'/g, "\\'")}')"
          @click.outside="closeOnOutside()">
          <input type="hidden" x-ref="modelInput" x-model="form.${dataKey}">
          <button type="button" class="anima-select-trigger" :class="{ focused: open }"
            @click="toggle()">
            <span class="anima-select-trigger-text" x-text="selectedLabel"></span>
            <svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="anima-select-menu" x-show="open" x-transition>
            <div class="anima-select-menu-scroll">
              <template x-for="group in displayGroups" :key="group.label">
                <div class="anima-select-group">
                  <template x-for="opt in group.options" :key="opt.v">
                    <div class="anima-select-option"
                      :class="{ active: opt.v === value }"
                      @click="select(opt.v)"
                      @mouseenter="onOptionMouseEnter(0, opt)"
                      @mouseleave="onOptionMouseLeave()">
                      <span x-text="opt.l" :title="opt.l"></span>
                      <svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                  </template>
                </div>
              </template>
            </div>
            <div class="anima-select-menu-desc" x-show="hoveredOpt && hoveredOpt.d" x-text="hoveredOpt ? hoveredOpt.d : ''"></div>
          </div>
        </div>`;
      }
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea x-model="form.${dataKey}" rows="3"></textarea>`;
    } else if (field.type === 'stepper') {
      inputHtml = `<div class="stepper"><button type="button" @click="stepField('${dataKey}', -${field.step || 1})">-</button><input type="number" x-model.number="form.${dataKey}" min="${field.min || 0}" max="${field.max || 999}" step="${field.step || 1}"><button type="button" @click="stepField('${dataKey}', ${field.step || 1})">+</button></div>`;
    } else if (field.type === 'number') {
      inputHtml = `<input type="number" x-model.number="form.${dataKey}" step="${field.step || 1}" min="${field.min !== undefined ? field.min : ''}" max="${field.max !== undefined ? field.max : ''}">`;
    } else {
      inputHtml = `<input type="text" x-model="form.${dataKey}">`;
    }

    let actionsHtml = '';
    if (field.role && field.role.startsWith('file-')) {
      actionsHtml = `<div class="field-actions">
        <button type="button" class="btn-icon" @click="localFilePicker('${dataKey}','${field.role}')" title="Local picker"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
        <button type="button" class="btn-icon" @click="builtinFilePicker('${dataKey}','${field.role}')" title="Built-in browser"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
        <button type="button" class="btn-icon" @click="undoField('${dataKey}')" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
        <button type="button" class="btn-icon" @click="resetField('${dataKey}')" title="Reset"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
      </div>`;
    } else if (field.type === 'text' || field.type === 'number' || field.type === 'textarea') {
      actionsHtml = `<div class="field-actions">
        <button type="button" class="btn-icon" @click="undoField('${dataKey}')" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
        <button type="button" class="btn-icon" @click="resetField('${dataKey}')" title="Reset"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
      </div>`;
    }

    return `<div class="field" data-field-row="${dataKey.replace(/'/g, "\\'")}">
      <div class="field-left"><div class="field-label">${label}</div>${hint ? `<div class="field-desc">${hint}</div>` : ''}</div>
      <div class="field-right">${inputHtml}${actionsHtml}</div>
    </div>`;
  },

  esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; },

  escJson(obj) {
    try {
      return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    } catch (e) {
      return btoa('{"options":[]}');
    }
  },

  setField(key, value) {
    const oldVal = this.form[key];
    if (oldVal === value) return;
    if (typeof this.formDefaults[key] === 'number' && value !== '' && value !== null) value = Number(value);
    this.form[key] = value;
    this.pushHistory({ ...this.form });
    const needsRerender = TRAIN_SECTIONS_COMMON.some(s => s.fields.some(f => f.showIf && f.showIf.key === key));
    if (needsRerender) this.rebuildForm();
  },

  stepField(key, delta) {
    const current = Number(this.form[key]) || 0;
    const field = this.findFieldDef(key);
    const step = field ? (field.step || 1) : 1;
    let newVal = current + delta;
    if (field && field.min !== undefined && newVal < field.min) newVal = field.min;
    if (field && field.max !== undefined && newVal > field.max) newVal = field.max;
    this.form[key] = newVal;
    this.pushHistory({ ...this.form });
  },

  findFieldDef(key) {
    for (const s of [...TRAIN_SECTIONS_COMMON, ...TRAIN_SECTIONS_ANIMA]) {
      const f = s.fields.find(x => x.key === key);
      if (f) return f;
    }
    return null;
  },

  undoField(key) {
    if (this.formHistoryIdx > 0) {
      this.formHistoryIdx--;
      this.form = { ...this.formHistory[this.formHistoryIdx] };
      this.updateToml();
      this.rebuildForm();
    }
  },

  resetField(key) {
    const def = this.formDefaults[key];
    this.setField(key, def !== undefined ? def : '');
  },

  resetAllParams() {
    this.form = { ...this.formDefaults };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.updateToml();
    this.rebuildForm();
    this.toast(this.t('common.allReset'));
  },

  pushHistory(state) {
    this.formHistory = this.formHistory.slice(0, this.formHistoryIdx + 1);
    this.formHistory.push(state);
    if (this.formHistory.length > 50) this.formHistory.shift();
    else this.formHistoryIdx = this.formHistory.length - 1;
  },

  rebuildForm() {
    const r = this.currentRoute;
    if (!r || !r.startsWith('train-')) return;
    const cfg = ROUTE_CONFIG[r] || {};
    const allSections = [...TRAIN_SECTIONS_COMMON];
    if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
    this.renderTrainingForm(allSections);
  },

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
      if (k === 'optimizer_args_custom' || k === 'prodigy_d_coef' || k === 'prodigy_d0') continue;

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
  },

  // ── Param Save/Load ────────────────────────────────────
  saveParamsToBrowser() {
    const name = prompt(this.t('common.enterConfigName'), 'config-'+Date.now().toString(36));
    if (!name) return;
    const configs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]');
    configs.push({ name, date: new Date().toLocaleString(), data: {...this.form} });
    localStorage.setItem('anima-saved-configs', JSON.stringify(configs));
    this.savedConfigs = configs;
    this.toast(this.t('common.saved'));
  },

  loadParamsFromBrowser(idx) {
    const configs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]');
    if (!configs[idx]) return;
    this.form = { ...configs[idx].data };
    this.formDefaults = { ...this.form };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.updateToml();
    this.rebuildForm();
    this.toast(this.t('common.loaded'));
  },

  deleteSavedConfig(idx) {
    const configs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]');
    configs.splice(idx,1);
    localStorage.setItem('anima-saved-configs', JSON.stringify(configs));
    this.savedConfigs = configs;
  },

  refreshSavedConfigs() {
    try { this.savedConfigs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]'); } catch(e) { this.savedConfigs = []; }
  },

  downloadConfig() {
    const blob = new Blob([this.tomlRaw], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = (this.form.output_name||'config')+'.toml'; a.click();
    URL.revokeObjectURL(url); this.toast(this.t('common.downloaded'));
  },

  importConfigFile() { document.getElementById('configFileInput').click(); },

  handleConfigFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = this.parseToml(e.target.result);
        if (Object.keys(parsed).length===0) { this.toast(this.t('common.invalidToml')); return; }
        this.form = { ...this.formDefaults, ...parsed };
        this.formDefaults = { ...this.form };
        this.formHistory = [this.formDefaults]; this.formHistoryIdx = 0;
        this.updateToml(); this.rebuildForm();
        this.toast(this.t('common.imported'));
      } catch(err) { this.toast(this.t('common.parseError')+': '+err.message); }
    };
    reader.readAsText(file);
    event.target.value = '';
  },

  parseToml(text) {
    const result = {};
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t||t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq===-1) continue;
      const key = t.substring(0,eq).trim();
      let val = t.substring(eq+1).trim();
      if (val==='true') { result[key]=true; continue; }
      if (val==='false') { result[key]=false; continue; }
      if (!isNaN(val)&&val!=='') { result[key]=Number(val); continue; }
      if ((val.startsWith('"')&&val.endsWith('"'))||(val.startsWith("'")&&val.endsWith("'"))) { result[key]=val.slice(1,-1); continue; }
      result[key]=val;
    }
    return result;
  },

  autoLoadLastParams() {
    if (this._autoLoaded) return;
    if (!this.autoLoadHistory || !this.currentRoute.startsWith('train-')) return;
    this._autoLoaded = true;
    this.toast(this.t('common.autoLoadedHistory'));
  },

  // ── File Pickers ───────────────────────────────────────
  async localFilePicker(key, role) {
    let type = 'folder';
    if (role==='file-model'||role==='file-model-saved') type='model-file';
    try {
      const r = await fetch('/api/pick_file?picker_type='+type);
      const d = await r.json();
      if (d.status==='success'&&d.data&&d.data.path) this.setField(key, d.data.path);
    } catch(e) { this.toast(this.t('common.localPickerNA')); }
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
    const safeKey = key.replace(/'/g, "\\'");
    const listHtml = files.map(f => {
      const safePath = f.path.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      return `<div class="config-list-item" @click="setField('${safeKey}','${safePath}'); showLoadModal = false"><span class="config-name">${f.name||''}</span><span class="config-date text-sm">${f.path||''}</span></div>`;
    }).join('');
    const modalBody = document.getElementById('savedConfigsList');
    if (modalBody) { modalBody.innerHTML = `<p class="text-sm text-muted mb-2">Select:</p>${listHtml}`; this.showLoadModal = true; }
  },
};
