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
  formErrors: {},

  _formSaveTimer: null,
  _localeChangeHandler: null,
  showFilePickerModalFlag: false,
  _pickerKey: '',
  _pickerFiles: [],
  _pickerFilter: '',
  _pickerCwd: '',

  // Training state
  trainingBlocked: false,
  activeTaskId: null,

  trainTypes: [
    { v: 'anima-lora', l: 'Anima LoRA', dk: 'opt.model_train_type_anima-lora' },
    { v: 'sdxl-lora', l: 'SDXL LoRA', dk: 'opt.model_train_type_sdxl-lora' },
  ],
  currentTrainTypeDesc: '',
  currentTrainTypeLabel: 'Anima LoRA',

  switchTrainType(v) {
    // Update display labels and descriptions
    const tt = this.trainTypes.find(t => t.v === v);
    this.currentTrainTypeDesc = tt ? window.t(tt.dk, tt.l) : '';
    this.currentTrainTypeLabel = tt ? tt.l : '';

    // Auto-set network_module based on train type
    if (v === 'anima-lora' && this.form.network_module === 'networks.lora') {
      this.form.network_module = 'networks.lora_anima';
    } else if (v !== 'anima-lora' && this.form.network_module === 'networks.lora_anima') {
      this.form.network_module = 'networks.lora';
    }
    // Also update the default so individual field reset uses the correct value
    this.formDefaults.network_module = (v === 'anima-lora') ? 'networks.lora_anima' : 'networks.lora';

    // Re-render form with new train type
    this.renderTrainingForm(v, null);
    this.setupAutoValueWatchers();
    this.setupShowIfWatchers();
    this.setupReadonlyWatchers();
    this.updateToml();
    this.loadPresets();
  },

  // ── Training Form ──────────────────────────────────────
  buildTrainForm() {
    this._autoLoaded = false; // Reset so _markAutoLoaded can run again
    const r = this.currentRoute;
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
    // Clean up previous watchers
    if (this._autoValueWatchers) { this._autoValueWatchers.forEach(function(w) { w(); }); }
    if (this._showIfWatchers) { this._showIfWatchers.forEach(function(w) { w(); }); }
    if (this._readonlyWatchers) { this._readonlyWatchers.forEach(function(w) { w(); }); }
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
      if (newVal !== oldVal) {
        self.switchTrainType(newVal);
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
  },

  renderTrainingForm(trainType, targetId) {
    const container = document.getElementById(targetId || 'trainFormContent');
    if (!container) return;
    const sections = window.getVisibleSections(trainType || this.form.model_train_type || 'anima-lora');
    let html = '';
    sections.forEach(section => {
      const fields = section.fields.filter(f => !f.hidden);

      html += `<div class="card" data-section="${section.key}">`;
      html += `<div class="card-header">${this.t(section.titleKey) || section.titleKey}</div>`;

      fields.forEach(field => { html += this.renderField(field); });

      html += `</div>`;
    });
    container.innerHTML = html;
    // Re-check all conditional fields after render
    this._allShowIfKeys().forEach(k => this.showConditionalFields(k));
  },

  _allSections() {
    return window.getVisibleSections(this.form.model_train_type || 'anima-lora');
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
      const menuHtml = `<div class="anima-select-menu" x-show="open" x-transition><div class="anima-select-menu-scroll"><template x-for="(group, gIdx) in displayGroups" :key="gIdx"><div class="anima-select-group"><div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div><template x-for="(opt, oIdx) in group.options" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)" @mouseenter="onOptionMouseEnter(oIdx, opt)" @mouseleave="onOptionMouseLeave()"><span x-text="opt.l" :title="opt.l"></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div></template></div></template><div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div></div>${descPanelHtml}</div>`;
      inputHtml = `<div class="anima-select" x-data="animaSelect('${this.escJson(fc)}', '${this.escapeAttr(val ?? '')}')" @click.outside="closeOnOutside()" @anima-select-change="setField('${dataKey}', $event.detail.value)"><input type="hidden" x-ref="modelInput" :value="form.${dataKey}">${triggerHtml}${menuHtml}</div>`;
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" rows="3"></textarea>`;
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
      } else {
        inputHtml = `<input type="text" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)">`;
      }
    }

    // ── Embed file picker buttons inside input ──
    let controlHtml = '';
    if (field.role && field.role.startsWith('file-')) {
      controlHtml = `<div class="field-input-wrap">${inputHtml}<div class="field-input-actions"><button type="button" class="btn-icon" @click="localFilePicker('${dataKey}','${field.role}')" title="Local picker" aria-label="Browse local files"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button><button type="button" class="btn-icon" @click="builtinFilePicker('${dataKey}','${field.role}')" title="Built-in browser" aria-label="Search built-in models"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button></div></div>`;
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

    // ── Nested detection (child of a showIf parent) ──
    const nestedClass = field.showIf ? ' field-nested' : '';

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
    return `<div class="field${condClass}${nestedClass}" :class="{ 'field-changed': String(form.${dataKey}) !== String(formDefaults.${dataKey}) && !(formDiffMap && formDiffMap['${dataKey}']), 'field-diff-modified': formDiffMap && formDiffMap['${dataKey}'] && formDiffMap['${dataKey}'].type === 'modified', 'field-diff-added': formDiffMap && formDiffMap['${dataKey}'] && formDiffMap['${dataKey}'].type === 'added' }" data-field-row="${this.escapeAttr(dataKey)}"${condAttrs}${readonlyAttrs}>
      <div class="field-row">
        ${controlSection}
        <div class="field-menu-wrap">
          <button type="button" class="btn-menu" title="⋯">${_dotsSvg}</button>
          ${_menuPopupHtml}
        </div>
      </div>
      ${fullWidthRow}
      <div class="field-diff-info" x-show="formDiffMap && formDiffMap['${dataKey}']" x-cloak>
        <template x-if="formDiffMap['${dataKey}'].type === 'modified'">
          <span class="field-diff-change"><span class="field-diff-old" x-text="String(formDiffMap['${dataKey}'].oldVal)"></span> <span class="field-diff-arrow">&rarr;</span> <span class="field-diff-new" x-text="String(formDiffMap['${dataKey}'].newVal)"></span></span>
        </template>
        <template x-if="formDiffMap['${dataKey}'].type === 'added'">
          <span class="field-diff-type-added" x-text="String(formDiffMap['${dataKey}'].newVal)"></span>
        </template>
      </div>
      ${hint ? `<div class="field-hint">${hint}</div>` : ''}
      ${(this.formErrors && this.formErrors[dataKey]) ? `<div class="field-error">${this.formErrors[dataKey]}</div>` : ''}
      ${readonlyWarnHtml}
    </div>`;
  },

  copyFieldName(key) {
    navigator.clipboard.writeText(key).then(() => {
      this.toast(this.t('common.paramCopied') || 'Copied');
    });
  },

  showConditionalFields(parentKey) {
    const expectedVal = this.form[parentKey];
    const toAnimate = []; // collect rows that need animation

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

      const currentlyHidden = row.classList.contains('field-hidden');
      if (match === !currentlyHidden) return; // no state change

      // Clean up any in-flight transition
      row.style.transition = 'none';
      row.style.maxHeight = '';
      row.style.transform = '';

      if (!match) {
        // HIDE: measure → lock height → add .field-hidden to trigger CSS transition
        row.style.overflow = 'hidden';
        const h = row.scrollHeight;
        row.style.maxHeight = h + 'px';
        row.style.transform = 'translateY(0)';
        toAnimate.push({ row: row, action: 'hide', height: h });
      } else {
        // SHOW: measure target while hidden → start from 0 → animate to full height
        row.style.overflow = 'hidden';
        row.classList.remove('field-hidden');
        const h = row.scrollHeight;
        row.style.maxHeight = '0px';
        row.style.transform = 'translateY(-6px)';
        toAnimate.push({ row: row, action: 'show', height: h });
      }
    });

    if (toAnimate.length === 0) { this.updateToml(); return; }

    // Single forced layout read, then apply all animations in one frame
    toAnimate.forEach(item => { void item.row.offsetHeight; });

    // Double RAF ensures browser has processed layout before starting transitions
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toAnimate.forEach(item => {
          const row = item.row;
          row.style.transition = ''; // restore CSS transition
          if (item.action === 'hide') {
            row.classList.add('field-hidden');
          } else {
            row.style.maxHeight = item.height + 'px';
            row.style.transform = 'translateY(0)';
          }

          let timerId = null;
          const cleanup = function() {
            if (timerId) { clearTimeout(timerId); timerId = null; }
            row.style.maxHeight = '';
            row.style.transform = '';
            row.style.transition = '';
            row.style.overflow = '';
            row.removeEventListener('transitionend', onEnd);
          };
          const onEnd = function(e) {
            if (e.propertyName === 'max-height') cleanup();
          };
          row.addEventListener('transitionend', onEnd);
          timerId = setTimeout(cleanup, 500);
        });
      });
    });

    this.updateToml();
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
    // Clean up previous watchers
    if (this._autoValueWatchers) { this._autoValueWatchers.forEach(function(w) { w(); }); }
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
    // Clean up previous watchers
    if (this._showIfWatchers) { this._showIfWatchers.forEach(function(w) { w(); }); }
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
    }));
    return [...keys];
  },

  setupReadonlyWatchers() {
    const self = this;
    // Clean up previous watchers
    if (this._readonlyWatchers) { this._readonlyWatchers.forEach(function(w) { w(); }); }
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

      // Always apply full state (idempotent) to handle re-renders correctly
      if (met) {
        row.setAttribute('data-readonly-if-active', '1');
        row.classList.add('field-readonly');
        row.querySelectorAll('input, textarea, select').forEach(el => { el.disabled = true; });
        row.querySelectorAll('.stepper button').forEach(el => { el.disabled = true; });
        row.querySelectorAll('.field-actions .btn-icon').forEach(el => { el.disabled = true; el.style.pointerEvents = 'none'; });
        row.querySelectorAll('.anima-select').forEach(sel => { sel.style.pointerEvents = 'none'; sel.style.opacity = '0.55'; });
        // Ensure warning text exists (deduplicate: remove any stale ones first)
        const reasonKey = row.getAttribute('data-readonly-if-reason');
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
    });
  },

  // Canonical HTML escape (text content & "-delimited attributes).
  // Handles null/undefined/0 correctly.
  esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },
  // Canonical HTML escape for '-delimited attributes (also escapes single quotes).
  escapeAttr(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  // JS string escape for embedding values into @click="func('...')" etc.
  escapeJsString(s) { if (s == null) return ''; return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); },
  escJson(obj) { try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); } catch (e) { console.error('escJson failed:', e); return btoa('{"options":[]}'); } },

  /** Coerce a string value that looks like a number into an actual number for TOML/API.
   *  Returns the coerced value, or the original value if not coercible. */
  _coerceNum(v) {
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
      const trimmed = v.trim();
      if (/^-?\d+\.?\d*[eE][+-]?\d+$/.test(trimmed)) {
        return trimmed; // keep scientific notation as string
      }
      return Number(trimmed);
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
    this.pushHistory({ ...this.form });
    if (this._allShowIfKeys().indexOf(key) !== -1) this.showConditionalFields(key);

    // Mutual exclusion: network_train_unet_only and network_train_text_encoder_only
    if (key === 'network_train_unet_only' && value === true) {
      this.form['network_train_text_encoder_only'] = false;
    }
    if (key === 'network_train_text_encoder_only' && value === true) {
      this.form['network_train_unet_only'] = false;
    }
    // When enabling cache_text_encoder_outputs, force network_train_unet_only = true
    if (key === 'cache_text_encoder_outputs' && value === true) {
      this.form['network_train_unet_only'] = true;
      this.form['network_train_text_encoder_only'] = false;
    }

    // Clear error for this field on change and re-render to update UI
    if (this.formErrors && this.formErrors[key]) {
      this.formErrors[key] = null;
      this.renderTrainingForm(this.form.model_train_type || 'anima-lora', null);
      return;
    }
    this.updateToml();
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
    if (this.form.min_timestep !== undefined && this.form.max_timestep !== undefined) {
      const minT = Number(this.form.min_timestep);
      const maxT = Number(this.form.max_timestep);
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
  },

  // ── Training Status Polling ──────────────────────────────
  async checkTrainingBlocked() {
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
