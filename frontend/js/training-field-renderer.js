/* Training field HTML, hints, numeric constraints and dependency layout.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
// Indicator defaults come from the registry, independently of imported form defaults.
window.FILLED_INDICATOR_KEYS = new Set([
  'pretrained_model_name_or_path', 'dit', 'vae', 'qwen3', 'text_encoder', 'train_data_dir', 'dataset_cache_dir',
  'output_name', 'output_dir',
]);
window.DEFAULT_DIM_KEYS = new Set([
  'pretrained_model_name_or_path', 'dit', 'vae', 'qwen3', 'text_encoder',
  'train_data_dir', 'output_name', 'output_dir',
]);

window.trainingFieldRenderer = {
  // 选项标签解析入口：表单预览、监控参数摘要共用。
  // 值可能来自历史 TOML（大小写与下拉选项不完全一致），故精确匹配失败后按小写兜底。
  _fieldOptionLabel(fieldKey, value, fallback = '') {
    const field = this._fieldDefinition(fieldKey, this.form.model_train_type || 'anima-lora');
    if (!field) return String(value ?? fallback ?? '');
    const options = [];
    if (Array.isArray(field.options)) options.push(...field.options);
    if (Array.isArray(field.groups)) {
      field.groups.forEach(group => {
        if (Array.isArray(group.options)) options.push(...group.options);
      });
    }
    const text = String(value ?? fallback ?? '');
    const option = options.find(item => String(item.v) === String(value))
      || options.find(item => String(item.v).toLowerCase() === text.toLowerCase());
    if (!option) return text;
    return this.t(option.dk, option.l || text);
  },
  _orderFieldsByDependencies(fields) {
    const keys = new Set(fields.map(field => field.key));
    const fieldsByKey = new Map(fields.map(field => [field.key, field]));
    const children = new Map();
    const roots = [];

    fields.forEach(field => {
      const parent = this._fieldLayoutParentKey(field, keys);
      const parentField = fieldsByKey.get(parent);
      if (!parent || parent === field.key || parentField?.keepChildrenPosition) {
        roots.push(field);
        return;
      }
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(field);
    });

    const ordered = [];
    const visited = new Set();
    const append = field => {
      if (visited.has(field.key)) return;
      visited.add(field.key);
      ordered.push(field);
      (children.get(field.key) || []).forEach(append);
    };
    roots.forEach(append);
    fields.forEach(append);
    return ordered;
  },

  _fieldLayoutParentKey(field, availableKeys = null) {
    if (!field || field.nested === false) return null;
    const accepted = key => key && (!availableKeys || availableKeys.has(key));
    if (accepted(field.layoutParent)) return field.layoutParent;
    if (field.showIf && !Array.isArray(field.showIf)) {
      return accepted(field.showIf.key) ? field.showIf.key : null;
    }
    if (Array.isArray(field.showIf)) {
      for (let index = field.showIf.length - 1; index >= 0; index -= 1) {
        const key = field.showIf[index] && field.showIf[index].key;
        if (accepted(key)) return key;
      }
    }
    if (Array.isArray(field.showIfAny)) {
      for (const group of field.showIfAny) {
        if (!Array.isArray(group)) continue;
        for (let index = group.length - 1; index >= 0; index -= 1) {
          const key = group[index] && group[index].key;
          if (accepted(key)) return key;
        }
      }
    }
    return null;
  },
  _numberConstraints(field) {
    if (!field) return {};
    const group = window.TRAIN_GROUP_MAP[this.form.model_train_type || 'anima-lora'] || 'all';
    return { ...field, ...((field.constraintsByGroup || {})[group] || {}) };
  },

  _optimizerAutoValueMap(field, trainType = this.form.model_train_type || 'anima-lora') {
    const map = {};
    const rules = field && Array.isArray(field.autoValue) ? field.autoValue : [];
    rules.forEach(rule => {
      let optimizer = null;
      if (rule.watch && typeof rule.watch === 'object' && !Array.isArray(rule.watch)) {
        const watch = rule.watch;
        if (watch.model_train_type && String(watch.model_train_type) !== String(trainType)) return;
        const extraKeys = Object.keys(watch).filter(key => key !== 'optimizer_type' && key !== 'model_train_type');
        if (extraKeys.length > 0 || !watch.optimizer_type) return;
        optimizer = watch.optimizer_type;
      } else if (rule.watch === 'optimizer_type') {
        optimizer = rule.when;
      }
      if (optimizer === null || optimizer === undefined || rule.set === null || rule.set === undefined) return;
      if (!Object.prototype.hasOwnProperty.call(map, optimizer)) map[optimizer] = rule.set;
    });
    return map;
  },

  _fieldDefinition(fieldKey, trainType = this.form.model_train_type || 'anima-lora') {
    const sections = window.getVisibleSections
      ? window.getVisibleSections(trainType)
      : (window.TRAIN_SECTIONS || []);
    for (const section of sections) {
      const field = (section.fields || []).find(item => item.key === fieldKey);
      if (field) return field;
    }
    return null;
  },

  _resolveFieldBaseHintKey(field, trainType) {
    if (!field || !field.hintKey) return '';
    const suffix = trainType === 'moss-image-lora' ? '_moss' : (trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : ''));
    if (suffix) {
      const specificKey = field.hintKey + suffix;
      const specific = this.t(specificKey);
      if (specific && specific !== specificKey) return specificKey;
    }
    return field.hintKey;
  },

  _resolveFieldHintOverrideKey(field, values) {
    if (!field) return '';
    if (field.key === 'learning_rate' && values?.optimizer_type === 'AdaFactor') {
      const prefix = values.model_train_type === 'krea2-lora' ? 'krea_' : '';
      return values[`${prefix}adafactor_relative_step`] !== false || values[`${prefix}adafactor_warmup_init`] === true
        ? 'field.learning_rateHint_adafactor_relative'
        : 'field.learning_rateHint_adafactor_manual';
    }
    if (field.key === 'network_alpha' && this._hasFullLokrFactors(values)) {
      return 'field.network_alphaHint_lokr_full';
    }
    const hintBy = field.hintKeyBy;
    if (!hintBy || !hintBy.key || !hintBy.values) return '';
    if (hintBy.key === 'lycoris_algo' && values?.network_module !== 'lycoris.kohya') return '';
    const selected = values ? values[hintBy.key] : undefined;
    return hintBy.values[String(selected)] || '';
  },

  _hasFullLokrFactors(values) {
    if (!values || values.network_module !== 'lycoris.kohya' || values.lycoris_algo !== 'lokr') {
      return false;
    }
    const groups = Array.isArray(this.shapeEstimate?.groups) ? this.shapeEstimate.groups : [];
    const lokrGroups = groups.filter(group => group && group.algo === 'lokr');
    return lokrGroups.length > 0 && lokrGroups.every(group => {
      const shapes = group.shapes || {};
      return group.w2Full === true && !Object.prototype.hasOwnProperty.call(shapes, 'lokr_w1_a');
    });
  },

  _resolveFieldHintKey(field, values, trainType) {
    return this._resolveFieldHintOverrideKey(field, values)
      || this._resolveFieldBaseHintKey(field, trainType);
  },

  _resolveFieldHintText(field, values, trainType) {
    const key = this._resolveFieldHintKey(field, values, trainType);
    return key ? this.t(key) : '';
  },

  fieldHintText(fieldKey) {
    const trainType = this.form.model_train_type || 'anima-lora';
    return this._resolveFieldHintText(
      this._fieldDefinition(fieldKey, trainType),
      this.form,
      trainType
    );
  },

  kreaSampleModeText() {
    if (this.form.model_train_type !== 'krea2-lora' || !this.form.enable_krea_samples) return '';
    const errors = this._kreaOptionErrors();
    if (errors.turbo_dit || errors.turbo_lora || errors.convrot_int8) {
      return this.t('krea2.sampleModeConflict');
    }
    const precision = this.form.convrot_int8 ? 'ConvRot INT8' : this.form.fp8_base ? 'FP8' : 'BF16';
    const key = String(this.form.turbo_dit || '').trim() ? 'sampleModeTurboDit'
      : String(this.form.turbo_lora || '').trim() ? 'sampleModeTurboLora' : 'sampleModeRaw';
    return this.t('krea2.' + key).replace('{precision}', precision);
  },


  renderField(field) {
    const val = this.form[field.key];
    const trainType = this.form.model_train_type || 'anima-lora';
    const trainTypeSuffix = trainType === 'moss-image-lora' ? '_moss' : (trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : ''));

    // Try train-type-specific desc key first, then fall back to default
    // Only use if the i18n key actually exists (to avoid showing "field.qwen3_anima" etc.)
    const descKeyWithSuffix = field.descKey + trainTypeSuffix;
    const specificLabel = this.t(descKeyWithSuffix);
    const hasSpecificLabel = specificLabel && specificLabel !== descKeyWithSuffix;
    const label = hasSpecificLabel ? specificLabel : (this.t(field.descKey) || field.descKey || field.key);
    const hint = this._resolveFieldHintText(field, this.form, trainType);
    const docLink = field.docSlug
      ? `<button type="button" class="field-doc-link" @click.stop="openParameterDoc('${this.escapeAttr(field.docSlug)}','${this.escapeAttr(field.docAnchor || '')}')" title="${this.escapeAttr(this.t('docs.openGuide'))}" aria-label="${this.escapeAttr(this.t('docs.openGuide'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg><span>${this.esc(this.t('docs.openGuide'))}</span></button>`
      : '';
    const currentGroup = window.TRAIN_GROUP_MAP[this.form.model_train_type || 'anima-lora'] || 'all';
    let isRequired = field.required;
    if (!isRequired && field.requiredGroups && Array.isArray(field.requiredGroups)) {
      isRequired = field.requiredGroups.includes(currentGroup);
    }
    const requiredMark = isRequired ? '<span class="field-required" aria-hidden="true">*</span>' : '';
    const dataKey = field.key;
    const accessibleKey = field.argKey || dataKey;
    const fieldAriaLabel = this.escapeAttr(`${accessibleKey}，${label}`);
    const stepDownLabel = this.escapeAttr(`${accessibleKey} ${label} 减少`);
    const stepUpLabel = this.escapeAttr(`${accessibleKey} ${label} 增加`);
    const isToggle = field.type === 'toggle';
    const isStaticReadonly = field.readonly === true;
    const staticReadonlyAttrs = isStaticReadonly ? ' readonly aria-readonly="true"' : '';
    // Text/textarea/path fields get their input on a separate row (full-width)
    const isFullWidth = field.type === 'textarea' || (field.role && field.role.startsWith('file-'));

    // ── Generate input HTML ──
    let inputHtml = '';
    if (isToggle) {
      inputHtml = `<label class="toggle"><input type="checkbox" aria-label="${fieldAriaLabel}" :checked="form.${dataKey}" @change="setField('${dataKey}', $event.target.checked)"><span class="toggle-track"><span class="toggle-thumb"></span></span></label>`;
    } else if (field.type === 'select') {
      const fc = {};
      const selectAlign = field.selectAlign === 'left' ? 'left' : 'right';
      const self = this;
      const currentTrainType = this.form.model_train_type || 'anima-lora';
      const currentGroup = window.TRAIN_GROUP_MAP[currentTrainType] || 'all';

      const resolveOption = (o) => {
        const cloned = { v: o.v, l: o.labelKey ? self.t(o.labelKey, o.l) : o.l };
        if (o.dKey) { cloned.d = self.t(o.dKey); }
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
      const triggerHtml = `<button type="button" class="anima-select-trigger" :class="{ focused: open }" @click="toggle($event)" aria-label="${fieldAriaLabel}" aria-haspopup="listbox" :aria-expanded="open ? 'true' : 'false'"><span class="anima-select-trigger-text" x-text="selectedLabel"></span><svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
      const menuHtml = `<template x-if="open"><div class="anima-select-menu" :class="{ 'anima-select-menu-described': hasDescriptions, 'anima-select-menu-positioned': positioned }"><div class="anima-select-menu-scroll"><template x-for="(group, gIdx) in displayGroups" :key="gIdx"><div class="anima-select-group"><div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div><template x-for="opt in group.options" :key="opt.v"><div class="anima-select-option" :class="{ active: opt.v === value }" @click="select(opt.v)"><span class="anima-select-option-content"><span class="anima-select-option-label" x-text="opt.l" :title="opt.l"></span><span class="anima-select-option-desc" x-show="opt.d" x-text="opt.d"></span></span><svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div></template></div></template><div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div></div></div></template>`;
      inputHtml = `<div class="anima-select" x-data="animaSelect('${this.escJson(fc)}', '${this.escapeAttr(val ?? '')}', {align:'${selectAlign}'})" @click.outside="close()" @anima-select-change="setField('${dataKey}', $event.detail.value)"><input type="hidden" aria-hidden="true" tabindex="-1" x-ref="modelInput" :value="form.${dataKey}">${triggerHtml}${menuHtml}</div>`;
    } else if (field.type === 'textarea') {
      inputHtml = `<textarea aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" rows="3"${staticReadonlyAttrs}></textarea>`;
      if (dataKey === "positive_prompts") {
        inputHtml += this._positivePromptCountHint(dataKey);
      }
    } else if (field.type === 'stepper' || field.type === 'number') {
      const constraints = this._numberConstraints(field);
      const sStep = constraints.step || 1;
      const defaultOnBlur = dataKey === 'lr_scheduler_timescale'
        ? ` x-data="{ editing: false }" x-effect="_syncLrTimescaleDefault(editing)" :class="{ 'is-default': ['default', 'auto'].includes(_fieldSources?.lr_scheduler_timescale) }" @focus="editing = true" @blur="editing = false; if (String(form.${dataKey} ?? '').trim() === '') resetField('${dataKey}')"` : '';
      const numberAttrs = `${constraints.min !== undefined ? ` min="${this.escapeAttr(constraints.min)}"` : ''}${constraints.max !== undefined ? ` max="${this.escapeAttr(constraints.max)}"` : ''} step="${this.escapeAttr(sStep)}"`;
      inputHtml = `<div class="stepper"><button type="button" aria-label="${stepDownLabel}" @click="stepField('${dataKey}', -${sStep})">−</button><input type="number" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"${numberAttrs}${defaultOnBlur}${staticReadonlyAttrs}><button type="button" aria-label="${stepUpLabel}" @click="stepField('${dataKey}', ${sStep})">+</button></div>`;
    } else {
      // Placeholders use the same profile defaults and auto-value rules as the form.
      const placeholders = this._optimizerAutoValueMap(field);
      if (Object.keys(placeholders).length || field.argKey) {
        const expression = JSON.stringify(placeholders).replace(/"/g, '&quot;');
        const defaultValue = JSON.stringify(field.default ?? '').replace(/"/g, '&quot;');
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" :placeholder="(${expression})[form.optimizer_type] ?? ${defaultValue}"${staticReadonlyAttrs}>`;
      } else if (field.placeholder) {
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" placeholder="${this.escapeAttr(field.placeholder)}"${staticReadonlyAttrs}>`;
      } else if (field.omitDefault && field.default !== undefined && field.default !== '' && field.default !== null) {
        // omitDefault 字段：值==默认值时不传，输入框用淡色 placeholder 提示默认值
        const _phVal = String(field.default).replace(/"/g, '&quot;');
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)" placeholder="${_phVal}"${staticReadonlyAttrs}>`;
      } else {
        // DEFAULT_DIM_KEYS 字段：值==schema 原始默认值时加 is-default class，CSS 淡色模拟 placeholder 视觉
        // （假留空——值仍保留，不触发必填校验失败、不影响训练流程；改值后 class 移除恢复正常字色）
        // :class 属性用双引号包裹，内部字符串字面量必须用单引号，内部单引号转义为 \x27。
        const _dimCls = (window.DEFAULT_DIM_KEYS && window.DEFAULT_DIM_KEYS.has(dataKey) && field.default !== undefined && field.default !== '' && field.default !== null)
          ? ` :class="{ 'is-default': String(form.${dataKey}) === String('${String(field.default).replace(/'/g, '\\x27')}') }"`
          : '';
        inputHtml = `<input type="text" aria-label="${fieldAriaLabel}" :value="form.${dataKey}" @input="setField('${dataKey}', $event.target.value)"${_dimCls}${staticReadonlyAttrs}>`;
      }
    }

    // ── Embed file picker buttons inside input ──
    let controlHtml = '';
    if (field.role && field.role.startsWith('file-') && !isStaticReadonly) {
      // 本地系统选择器在无图形环境的服务器上不可用：整颗按钮不渲染，只留内置浏览器
      const localBtnHtml = this.localPickerAvailable
        ? `<button type="button" class="btn-icon" @click="localFilePicker('${dataKey}','${field.role}')" :title="t('common.localPicker')" :aria-label="t('common.browseLocal')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>`
        : '';
      controlHtml = `<div class="field-input-wrap">${inputHtml}<div class="field-input-actions">${localBtnHtml}<button type="button" class="btn-icon" @click="builtinFilePicker('${dataKey}','${field.role}')" :title="t('common.builtinBrowser')" :aria-label="t('common.searchBuiltin')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button></div></div>`;
    } else {
      controlHtml = inputHtml;
    }

    // ── Reset button + popup menu (in secondary layer) ──
    const _resetSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;
    const _undoSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
    const _dotsSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
    const _menuPopupHtml = `<div class="field-menu-popup" x-ref="menu" x-show="open" :class="{ 'is-positioned': positioned }" :inert="!open" :id="$id('field-menu')" role="menu" :aria-label="t('common.fieldActions')" x-cloak><button type="button" role="menuitem" tabindex="-1" @click="undoField('${dataKey}');close()">${_undoSvg}<span>${this.t('common.undoField')}</span></button><button type="button" role="menuitem" tabindex="-1" @click="resetField('${dataKey}');close()">${_resetSvg}<span>${this.t('common.resetField')}</span></button></div>`;

    // ── Conditional display ──
    // LyCORIS 面板字段在主表单里只对原生模块（非 lycoris.kohya）显示；
    // lycoris.kohya 下它们收进 LyCORIS 弹窗（renderLycorisPanel 以 lycorisPanel 标记渲染）。
    const condField = this._lycorisMainFormConditions(field);
    const condShowIf = condField ? condField.showIf : field.showIf;
    const condShowIfAny = condField ? condField.showIfAny : field.showIfAny;
    let condClass = '';
    let condAttrs = '';
    if (condShowIf) {
      const sf = condShowIf;
      if (Array.isArray(sf)) {
        // Multi-condition AND: store JSON for evaluation
        condAttrs = ` data-show-if-all='${this.esc(JSON.stringify(sf))}'`;
        const condMet = sf.every(c => this._evalShowIfCond(c));
        condClass = condMet ? ' field-conditional' : ' field-conditional field-hidden';
      } else {
        // Single condition (existing logic)
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
    } else if (condShowIfAny) {
      // OR-of-ANDs: list[list[dict]] — 任一内层 AND 组全成立即显示
      condAttrs = ` data-show-if-any='${this.esc(JSON.stringify(condShowIfAny))}'`;
      const condMet = condShowIfAny.some(group => group.every(c => this._evalShowIfCond(c)));
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

    // ── Readonly If Any ──
    // OR clauses; nested arrays represent AND groups.
    if (!field.readonlyIf && field.readonlyIfAny && Array.isArray(field.readonlyIfAny)) {
      const met = this._readonlyIfAnyMet(field.readonlyIfAny);
      readonlyAttrs = ` data-readonly-if-any='${this.esc(JSON.stringify(field.readonlyIfAny))}'`;
      if (field.readonlyReasonKey) {
        readonlyAttrs += ` data-readonly-if-reason="${this.escapeAttr(field.readonlyReasonKey)}"`;
      }
      if (met) {
        readonlyAttrs += ` data-readonly-if-active="1"`;
        const reasonText = field.readonlyReasonKey ? this.t(field.readonlyReasonKey) : '';
        if (reasonText) {
          readonlyWarnHtml = `<div class="field-readonly-warn">${reasonText}</div>`;
        }
      }
    }

    // ── Nested detection (explicit layout parent or conditional parent) ──
    // 计算嵌套层级：一个字段的层级 = 其布局父字段的层级 + 1，父级若无则为 0。
    // 这样"开关→选项→子选项"的树形层级通过递增缩进 + 加深左边框一眼可读。
    const isNested = Boolean(this._fieldLayoutParentKey(field));
    const nestLevel = isNested ? this._nestLevel(field) : 0;
    const nestedClass = isNested ? ' field-nested' : '';
    const nestLevelAttr = ` data-nest-level="${nestLevel}"`;

    // ── Build body row ──
    // merged 字段（优化器参数）显示真正写进 optimizer_args 的参数名，而不是内部表单键：
    // 同一时刻只显示一个优化器的参数，重名不会歧义，且这个名字与文档、日志一致。
    const displayKey = field.argKey || dataKey;
    const infoHtml = field.labelOnly
      ? `<div class="field-info"><div class="field-key">${label}${requiredMark}${docLink}</div>${field.helpKey ? `<div class="field-desc">${this.esc(this.t(field.helpKey))}</div>` : ''}</div>`
      : `<div class="field-info"><div class="field-key">${this.esc(displayKey)}${requiredMark}</div><div class="field-desc">${label}${docLink}</div></div>`;
    let controlSection = '';
    let fullWidthRow = '';
    if (isFullWidth) {
      // Textarea / path: info on top, input full-width below (outside field-row)
      controlSection = infoHtml + (field.controlActions || '');
      fullWidthRow = `<div class="field-input-row">${controlHtml}</div>`;
    } else {
      // Standard: info left, control right — single flex row
      controlSection = `${infoHtml}<div class="field-control">${controlHtml}${field.controlActions || ''}</div>`;
    }

    // ── Assemble ──
    // 绿色"已填"指示条：仅 FILLED_INDICATOR_KEYS 字段，判定非空且非 schema 原始默认值。
    // schema default 在渲染期已知，序列化为字面量拼进 Alpine 表达式（运行期无需访问 field 对象）。
    // 注意：:class 整个属性用双引号包裹，Alpine 表达式内的字符串字面量必须用单引号（双引号会截断 HTML 属性）。
    // default 值用单引号包裹，内部单引号转义为 \x27 避免破坏表达式。
    const _filledKey = `'${dataKey.replace(/'/g, '\\x27')}'`;
    const _filledDefaultLit = field.default !== undefined
      ? `'${String(field.default).replace(/'/g, '\\x27')}'`
      : 'undefined';
    const _filledExpr = `window.FILLED_INDICATOR_KEYS.has(${_filledKey}) && form.${dataKey} !== '' && form.${dataKey} !== null && form.${dataKey} !== undefined && String(form.${dataKey}) !== String(${_filledDefaultLit})`;
    const fieldMenuHtml = isStaticReadonly ? '' : `<div class="field-menu-wrap" x-data="actionMenu" x-id="['field-menu']" @keydown="key($event)" @click.outside="close(false)" @pointerenter="hoverEnter($event)" @pointerleave="hoverLeave()" @focusout="focusOut($event)">
          <button type="button" class="btn-menu" x-ref="trigger" :aria-label="t('common.fieldActions')" aria-haspopup="menu" :aria-expanded="open" :aria-controls="$id('field-menu')" @click="toggle()">${_dotsSvg}</button>
          ${_menuPopupHtml}
        </div>`;
    const staticReadonlyClass = isStaticReadonly ? ' field-readonly' : '';
    const hintExpr = `fieldHintText('${this.escapeAttr(dataKey)}')`;
    const hintHtml = dataKey === 'attn_mode'
      ? `<div class="field-hint" x-text="t('opt.attn_mode_' + form.attn_mode)">${this.esc(this.t('opt.attn_mode_' + val))}</div>`
      : field.hintKeyBy
      ? `<div class="field-hint" x-show="${hintExpr}" x-text="${hintExpr}">${this.esc(hint)}</div>`
      : (hint ? `<div class="field-hint">${hint}</div>` : '');
    const kreaSampleModeHtml = trainType === 'krea2-lora' && dataKey === 'enable_krea_samples'
      ? `<div class="field-hint" data-krea-sample-mode role="status" aria-live="polite" x-show="form.enable_krea_samples" x-text="kreaSampleModeText()">${this.esc(this.kreaSampleModeText())}</div>`
      : '';
    return `<div class="field${condClass}${nestedClass}${staticReadonlyClass}" :class="{ 'field-changed': String(form.${dataKey}) !== String(formDefaults.${dataKey}), 'field-filled': ${_filledExpr} }" data-field-row="${this.escapeAttr(dataKey)}"${condAttrs}${readonlyAttrs}${nestLevelAttr}>
      <div class="field-row">
        ${controlSection}
        ${fieldMenuHtml}
      </div>
      ${fullWidthRow}
      ${hintHtml}
      ${kreaSampleModeHtml}
      <div class="field-error" x-show="formErrors && formErrors.${dataKey}" x-text="formErrors.${dataKey} || ''" x-cloak></div>
      ${this._getEnvHint(dataKey)}
      ${this._getOutputPathHint(dataKey)}
      ${readonlyWarnHtml}
    </div>`;
  },

  // ── 环境联动提示：检查当前字段值依赖的后端是否已安装（Alpine 响应式）──
  // x-show 与扩展状态及 form 值联动。
  _getEnvHint(dataKey) {
    switch (dataKey) {
      case 'enable_reg_data':
        if (!['anima-lora', 'sdxl-lora'].includes(this.form.model_train_type)) return '';
        return `<div class="timestep-preview-entry"><button type="button" class="btn btn-ghost btn-sm" @click="openRegularizationFromTraining()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m21 15-5-5L5 21"/></svg><span x-text="regT('entry')"></span></button></div>`;
      case 'timestep_sampling':
        return `<div class="timestep-preview-entry">
          <button type="button" class="btn btn-ghost btn-sm" @click="openTimestepPreview()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
            <span x-text="t('timestepPreview.open')">View timestep distribution</span>
          </button>
          <span class="field-hint" x-text="t('timestepPreview.entryHint')"></span>
        </div>`;
      case 'lr_scheduler':
        return `<div class="lr-preview-entry">
          <button type="button" class="btn btn-ghost btn-sm" @click="openLrPreview()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
            <span x-text="t('lrPreview.open')">View learning-rate curve</span>
          </button>
        </div>`;
      case 'network_module':
        return this._shapePreviewEntry();
      case 'attn_mode':
        return `<div x-show="faStatus && !faStatus.installed && form.attn_mode==='flash'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintFlashNotInstalled')}</div>`
          + `<div x-show="xfStatus && !xfStatus.installed && form.attn_mode==='xformers'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'krea_attention_backend':
        return `<div x-show="faStatus && !faStatus.installed && form.krea_attention_backend==='flash_attn'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintFlashNotInstalled')}</div>`
          + `<div x-show="xfStatus && !xfStatus.installed && form.krea_attention_backend==='xformers'" x-cloak class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'xformers':
        return `<div x-show="xfStatus && !xfStatus.installed && form.xformers" class="field-hint field-hint-warn">${this.t('environment.envHintXformersNotInstalled')}</div>`;
      case 'compile':
        return `<div x-show="tritonStatus && !tritonStatus.installed && form.compile" class="field-hint field-hint-warn">${this.t('environment.envHintTritonNotInstalled')}</div>`;
    }
    return '';
  },

  _getOutputPathHint(dataKey) {
    if (dataKey !== 'output_dir') return '';
    return `<div class="output-path-hint" x-show="outputPathHintVisible()" :class="outputPathStatusClass()" role="status" aria-live="polite" x-cloak>
      <div class="output-path-hint-summary"><span class="output-path-hint-dot" aria-hidden="true"></span><span x-text="outputPathSummaryText()"></span></div>
    </div>`;
  },

  // positive prompts line count hint: real-time sample count below textarea
  _positivePromptCountHint(dataKey) {
    if (this.form.model_train_type === 'moss-image-lora') return '';
    var h = [];
    h.push('<div class="field-hint field-hint-warn" x-show="(form.');
    h.push(dataKey);
    h.push(" || '').split('\\n').filter(function(l){return l.trim()}).length >= 2\"");
    h.push(" x-text=\"t('field.samplePromptsCountHint').replaceAll('{n}', (form.");
    h.push(dataKey);
    h.push(" || '').split('\\n').filter(function(l){return l.trim()}).length)\"></div>");
    return h.join('');
  },

  // esc() 定义在 utils.js（跨模块共享，monitor/environment 渲染层同样依赖）。
  // Canonical HTML escape for '-delimited attributes (also escapes single quotes).
  escapeAttr(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); },
  // JS string escape for embedding values into @click="func('...')" etc.
  escapeJsString(s) { if (s == null) return ''; return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029'); },
  escJson(obj) { try { return btoa(new TextEncoder().encode(JSON.stringify(obj)).reduce((s,b)=>s+String.fromCharCode(b),'')); } catch (e) { console.error('escJson failed:', e); return btoa('{"options":[]}'); } },

  findFieldDef(key) {
    const sections = this._allSections();
    for (const s of sections) {
      const f = s.fields.find(x => x.key === key);
      if (f) return f;
    }
    return null;
  },

  // ── Nest level: depth of explicit/conditional layout ancestry ──
  // 一个字段的层级 = 其布局父字段层级 + 1；无则为 0。
  // 用于递增缩进与左边框深浅，让"开关→选项→子选项"层级一眼可读。
  _nestLevelCache: null,
  _nestLevel(field) {
    if (!this._fieldLayoutParentKey(field)) return 0;
    // 构建一次 key→field 映射，避免重复遍历（render 时调用频繁）
    if (!this._nestLevelCache) {
      const map = {};
      this._allSections().forEach(s => s.fields.forEach(f => { map[f.key] = f; }));
      this._nestLevelCache = map;
    }
    let level = 0;
    let cur = field;
    const guard = new Set();
    while (cur && this._fieldLayoutParentKey(cur) && !guard.has(cur.key)) {
      guard.add(cur.key);
      level += 1;
      const parentKey = this._fieldLayoutParentKey(cur);
      cur = parentKey ? this._nestLevelCache[parentKey] : undefined;
    }
    return level;
  },
};
