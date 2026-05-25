/* ================================================================
   training-core.js — State, Form building, File pickers
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.trainingCoreMixin = {
  // ── State ──────────────────────────────────────────────
  form: {},
  formDefaults: {},
  formHistory: [],
  formHistoryIdx: -1,

  trainTypes: [
    { v: 'sd-lora', l: 'SD LoRA', dk: 'opt.model_train_type_sd-lora' },
    { v: 'sdxl-lora', l: 'SDXL LoRA', dk: 'opt.model_train_type_sdxl-lora' },
    { v: 'anima-lora', l: 'Anima LoRA', dk: 'opt.model_train_type_anima-lora' },
  ],
  currentTrainTypeDesc: '',
  currentTrainTypeLabel: 'SD LoRA',

  switchTrainType(v) {
    if (this.form.model_train_type === v) return;
    this.form.model_train_type = v;
    const tt = this.trainTypes.find(t => t.v === v);
    this.currentTrainTypeDesc = tt ? window.t(tt.dk, tt.l) : '';
    this.currentTrainTypeLabel = tt ? tt.l : '';
    this.renderTrainingForm(v);
    this.setupAutoValueWatchers();
    this.setupShowIfWatchers();
    this.updateToml();
    this.loadPresets();
  },

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
    const allSections = window.getVisibleSections(trainType);
    allSections.forEach(s => { s.fields.forEach(f => { if (f.default !== undefined) defaults[f.key] = f.default; }); });
    defaults.model_train_type = trainType;

    this.form = { ...defaults, ...(saved || {}) };
    this.formDefaults = { ...this.form };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;

    const tt = this.trainTypes.find(t => t.v === this.form.model_train_type);
    this.currentTrainTypeDesc = tt ? window.t(tt.dk, tt.l) : '';
    this.currentTrainTypeLabel = tt ? tt.l : '';

    this.renderTrainingForm(trainType);
    this.setupAutoValueWatchers();
    this.setupShowIfWatchers();
    this.loadPresets();

    const self = this;
    this.$watch('form', () => {
      try { localStorage.setItem(savedKey, JSON.stringify(self.form)); } catch (e) {}
    });

    window.addEventListener('locale-changed', () => {
      const tt2 = self.trainTypes.find(t => t.v === self.form.model_train_type);
      self.currentTrainTypeDesc = tt2 ? window.t(tt2.dk, tt2.l) : '';
    });
  },

  setupStickyTabs() { /* no-op */ },

  renderTrainingForm(trainType) {
    const container = document.getElementById('trainFormContent');
    if (!container) return;
    const sections = window.getVisibleSections(trainType || this.form.model_train_type || 'sd-lora');
    let html = '';
    sections.forEach(section => {
      const basicFields = section.fields.filter(f => !f.advanced && !f.hidden);
      const advFields = section.fields.filter(f => f.advanced && !f.hidden);
      const hasAdvanced = advFields.length > 0;

      html += `<div class="card" data-section="${section.key}">`;
      html += `<div class="card-header">${this.t(section.titleKey) || section.titleKey}</div>`;

      // Basic fields
      basicFields.forEach(field => { html += this.renderField(field); });

      // Advanced fields (collapsible)
      if (hasAdvanced) {
        html += `<div class="field-advanced-toggle" x-data="{ open: false }">
          <button type="button" class="btn-advanced-toggle" @click="open = !open">
            <span x-text="open ? '收起进阶参数' : '展开进阶参数 (' + ${advFields.length} + ')'"></span>
            <svg class="advanced-chevron" :class="{ open: open }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
          </button>
        </div>`;
        html += `<div class="field-advanced-panel" x-show="open" x-transition>`;
        advFields.forEach(field => { html += this.renderField(field); });
        html += `</div>`;
      }

      html += `</div>`;
    });
    container.innerHTML = html;
    // Re-check all conditional fields after render
    this._allShowIfKeys().forEach(k => this.showConditionalFields(k));
  },

  _allSections() {
    return window.getVisibleSections(this.form.model_train_type || 'sd-lora');
  },

  _allShowIfKeys() {
    const keys = new Set();
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.showIf) keys.add(f.showIf.key);
    }));
    return [...keys];
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
      const triggerHtml = `<button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="toggle()"><span class="anima-select-trigger-text" x-text="selectedLabel"></span><svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg></button>`;
      const menuHtml = `<div class="anima-select-menu" x-show="open" x-transition><div class="anima-select-menu-scroll"><template x-for="(group, gIdx) in displayGroups" :key="gIdx"><div class="anima-select-group"><div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div><template x-for="(opt, oIdx) in group.options" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)" @mouseenter="onOptionMouseEnter(oIdx, opt)" @mouseleave="onOptionMouseLeave()"><span x-text="opt.l" :title="opt.l"></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div></template></div></template><div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div></div><div class="anima-select-menu-desc" x-show="hoveredOpt && hoveredOpt.d" x-text="hoveredOpt ? hoveredOpt.d : ''"></div></div>`;
      inputHtml = `<div class="anima-select" x-data="animaSelect('${this.escJson(fc)}', '${String(val ?? '').replace(/'/g, "\\'")}')" @click.outside="closeOnOutside()"><input type="hidden" x-ref="modelInput" x-model="form.${dataKey}">${triggerHtml}${menuHtml}</div>`;
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
      actionsHtml = `<div class="field-actions"><button type="button" class="btn-icon" @click="localFilePicker('${dataKey}','${field.role}')" title="Local picker"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button><button type="button" class="btn-icon" @click="builtinFilePicker('${dataKey}','${field.role}')" title="Built-in browser"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button><button type="button" class="btn-icon" @click="undoField('${dataKey}')" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button><button type="button" class="btn-icon" @click="resetField('${dataKey}')" title="Reset"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button></div>`;
    } else if (field.type === 'text' || field.type === 'number' || field.type === 'textarea') {
      actionsHtml = `<div class="field-actions"><button type="button" class="btn-icon" @click="undoField('${dataKey}')" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button><button type="button" class="btn-icon" @click="resetField('${dataKey}')" title="Reset"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button></div>`;
    }

    let condClass = '';
    let condAttrs = '';
    if (field.showIf) {
      const sf = field.showIf;
      const parentVal = this.form[sf.key];
      let condMet = false;
      condAttrs = ` data-show-if-key="${sf.key}"`;
      if (sf.eq !== undefined) {
        condMet = String(parentVal) === String(sf.eq);
        condAttrs += ` data-show-if-eq="${sf.eq}"`;
        if (sf.or && Array.isArray(sf.or)) {
          condMet = condMet || sf.or.some(function(v) { return String(parentVal) === String(v); });
          condAttrs += ` data-show-if-or="${sf.or.join(',')}"`;
        }
      } else if (sf.neq !== undefined) {
        condMet = String(parentVal) !== String(sf.neq) && parentVal !== null && parentVal !== undefined && parentVal !== '';
        condAttrs += ` data-show-if-neq="${sf.neq}"`;
      }
      condClass = condMet ? ' field-conditional' : ' field-conditional field-hidden';
    }

    return `<div class="field${condClass}" data-field-row="${dataKey.replace(/'/g, "\\'")}"${condAttrs}>
      <div class="field-left"><div class="field-label">${label}</div>${hint ? `<div class="field-desc">${hint}</div>` : ''}</div>
      <div class="field-right">${inputHtml}${actionsHtml}</div>
    </div>`;
  },

  showConditionalFields(parentKey) {
    const expectedVal = this.form[parentKey];
    document.querySelectorAll(`[data-show-if-key="${parentKey}"]`).forEach(row => {
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
      row.classList.toggle('field-hidden', !match);
    });
    this.updateToml();
  },

  // ── Auto Value: auto-set field value when watcher field changes ──
  _autoValueRules: null,
  setupAutoValueWatchers() {
    // Collect all autoValue rules from all visible fields
    const rules = [];
    this._allSections().forEach(s => s.fields.forEach(f => {
      if (f.autoValue && Array.isArray(f.autoValue)) {
        f.autoValue.forEach(r => rules.push({ target: f.key, defaultVal: f.default, watch: r.watch, when: r.when, set: r.set }));
      }
    }));
    this._autoValueRules = rules;
    if (rules.length === 0) return;
    // Apply initial state
    const self = this;
    rules.forEach(r => {
      self.$watch('form.' + r.watch, function(newVal) {
        const rule = self._autoValueRules.find(x => x.target === r.target && x.when === newVal);
        if (rule) {
          // The watcher matches → set auto value
          if (rule.set !== null && rule.set !== undefined) {
            self.form[rule.target] = rule.set;
          }
        } else {
          // Check if any rule for this target still matches
          const anyMatch = self._autoValueRules.some(x => x.target === r.target && String(self.form[x.watch]) === String(x.when));
          if (!anyMatch) {
            // Restore default if no rule matches
            const field = self.findFieldDef(r.target);
            if (field) self.form[r.target] = field.default;
          }
        }
      });
    });
  },

  // ── Show If Watchers: listen for parent field changes to show/hide children ──
  setupShowIfWatchers() {
    const self = this;
    this._allShowIfKeys().forEach(k => {
      // Use a named function for clarity; Alpine re-evaluates on change
      self.$watch('form.' + k, () => self.showConditionalFields(k));
    });
  },

  esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; },
  escJson(obj) { try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); } catch (e) { return btoa('{"options":[]}'); } },

  setField(key, value) {
    const oldVal = this.form[key];
    if (oldVal === value) return;
    if (typeof this.formDefaults[key] === 'number' && value !== '' && value !== null) value = Number(value);
    this.form[key] = value;
    this.pushHistory({ ...this.form });
    if (this._allShowIfKeys().indexOf(key) !== -1) this.showConditionalFields(key);
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
    for (const s of window.TRAIN_SECTIONS || []) {
      const f = s.fields.find(x => x.key === key);
      if (f) return f;
    }
    return null;
  },

  undoField(key) {
    if (this.formHistoryIdx > 0) {
      this.formHistoryIdx--;
      const prev = this.formHistory[this.formHistoryIdx];
      for (const [k, v] of Object.entries(prev)) {
        if (this.form[k] !== v) this.form[k] = v;
      }
      this.updateToml();
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
    this.renderTrainingForm(this.form.model_train_type || 'sd-lora');
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
  }
};
