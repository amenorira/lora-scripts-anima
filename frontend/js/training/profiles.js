/* Profile defaults, draft persistence and field provenance.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingProfiles = {
  _profileFormDrafts: {},
  _profileFieldSources: {},
  _fieldSources: {},
  // 构建指定训练类型的字段默认值字典（与 buildTrainForm 共用逻辑）。
  _defaultNetworkModule(trainType) {
    return ({
      'anima-lora': 'networks.lora_anima',
      'moss-image-lora': 'networks.lora_generic',
      'krea2-lora': 'networks.lora_krea2',
    })[trainType] || 'networks.lora';
  },

  _buildFormDefaults(trainType) {
    const defaults = {};
    const allSections = window.getVisibleSections(trainType);
    allSections.forEach(s => { s.fields.forEach(f => {
      const hasExplicitDefault = f.default !== undefined && f.default !== null && f.default !== '';
      if (hasExplicitDefault) {
        defaults[f.key] = f.default && typeof f.default === 'object'
          ? (Array.isArray(f.default) ? [...f.default] : { ...f.default })
          : f.default;
      } else if (!f.hidden) {
        if (f.type === 'toggle') defaults[f.key] = false;
        else if (f.type === 'number' || f.type === 'stepper') defaults[f.key] = '';
        else if (f.type === 'select' && f.options && f.options.length) defaults[f.key] = f.options[0].v;
        else defaults[f.key] = '';
      }
    }); });
    defaults.model_train_type = trainType;
    defaults.network_module = this._defaultNetworkModule(trainType);
    return defaults;
  },

  _normalizeLegacyLoraMuonForm(source) {
    const normalized = source && typeof source === 'object' && !Array.isArray(source)
      ? { ...source }
      : {};
    if (normalized.optimizer_type !== 'vendor.lora_muon.LoRA_Muon') return normalized;
    const aliases = {
      lora_muon_momentum: 'momentum',
      lora_muon_ns_steps: 'ns_steps',
      lora_muon_inv_sqrt_steps: 'inv_sqrt_steps',
      lora_muon_msign_eps: 'msign_eps',
      lora_muon_inv_sqrt_eps: 'inv_sqrt_eps',
      lora_muon_inv_sqrt_gamma: 'inv_sqrt_gamma',
      lora_muon_gauge_rebalance: 'gauge_rebalance',
      lora_muon_gauge_rebalance_alpha: 'gauge_rebalance_alpha',
      lora_muon_gauge_rebalance_interval: 'gauge_rebalance_interval',
      lora_muon_gauge_power_steps: 'gauge_power_steps',
    };
    Object.entries(aliases).forEach(([legacy, canonical]) => {
      if (!Object.prototype.hasOwnProperty.call(normalized, canonical) &&
          Object.prototype.hasOwnProperty.call(normalized, legacy)) {
        normalized[canonical] = normalized[legacy];
      }
      delete normalized[legacy];
    });
    return normalized;
  },

  _profileDraftStorageKey(route = this.currentRoute) {
    return route && route.startsWith('train-') ? `anima-form-profiles-${route}` : '';
  },

  _profileFieldSourceStorageKey(route = this.currentRoute) {
    return route && route.startsWith('train-')
      ? `anima-form-profile-sources-v1-${route}`
      : '';
  },

  _loadProfileDrafts(route = this.currentRoute) {
    const storageKey = this._profileDraftStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return {};
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const validTypes = new Set(this.trainTypes.map(item => item.v));
      return Object.fromEntries(
        Object.entries(parsed).filter(([key, value]) =>
          validTypes.has(key) && value && typeof value === 'object' && !Array.isArray(value))
      );
    } catch (e) {
      return {};
    }
  },

  _loadProfileFieldSources(route = this.currentRoute) {
    const storageKey = this._profileFieldSourceStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return {};
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (!parsed || parsed.version !== 1 || !parsed.profiles ||
          typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
        return {};
      }
      const validTypes = new Set(this.trainTypes.map(item => item.v));
      const validSources = new Set(['default', 'auto', 'user', 'import', 'saved']);
      return Object.fromEntries(
        Object.entries(parsed.profiles).filter(([trainType, sources]) =>
          validTypes.has(trainType) && sources && typeof sources === 'object' && !Array.isArray(sources)
        ).map(([trainType, sources]) => [
          trainType,
          Object.fromEntries(Object.entries(sources).map(([key, source]) => [
            key,
            source === 'preset' ? 'import' : source,
          ]).filter(([, source]) => validSources.has(source))),
        ])
      );
    } catch (e) {
      return {};
    }
  },

  _setIfDefaultTargets(trainType) {
    const targets = new Set();
    window.getVisibleSections(trainType).forEach(section => {
      (section.fields || []).forEach(field => {
        (field.autoValue || []).forEach(rule => {
          if (rule.setIfDefault === true) targets.add(rule.setTarget || field.key);
        });
      });
    });
    return targets;
  },

  _activateProfileFieldSources(
    trainType,
    defaults = this._buildFormDefaults(trainType),
    draft = null,
    hasLegacyDraft = false
  ) {
    const persisted = this._profileFieldSources[trainType];
    const hasPersisted = persisted && typeof persisted === 'object' && !Array.isArray(persisted);
    const sources = {};
    Object.keys(defaults).forEach(key => { sources[key] = 'default'; });

    if (hasPersisted) {
      Object.keys(defaults).forEach(key => {
        if (Object.prototype.hasOwnProperty.call(persisted, key)) sources[key] = persisted[key];
      });
    }

    if (hasLegacyDraft) {
      this._setIfDefaultTargets(trainType).forEach(key => {
        const missingMetadata = !hasPersisted || !Object.prototype.hasOwnProperty.call(persisted, key);
        if (missingMetadata && draft && Object.prototype.hasOwnProperty.call(draft, key)) {
          sources[key] = 'saved';
        }
      });
    }

    if (Object.prototype.hasOwnProperty.call(defaults, 'lr_scheduler_timescale')) {
      const timescale = draft?.lr_scheduler_timescale;
      if (String(timescale ?? '').trim() === '') {
        sources.lr_scheduler_timescale = 'default';
      } else if (!hasPersisted || !Object.prototype.hasOwnProperty.call(persisted, 'lr_scheduler_timescale')) {
        sources.lr_scheduler_timescale = 'saved';
      }
    }
    this._fieldSources = sources;
    this._profileFieldSources[trainType] = sources;
    return sources;
  },

  _replaceProfileFieldSources(trainType, defaults, explicitKeys = [], explicitSource = 'user') {
    const sources = {};
    Object.keys(defaults).forEach(key => { sources[key] = 'default'; });
    explicitKeys.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(defaults, key) || key === 'model_train_type') {
        sources[key] = explicitSource;
      }
    });
    this._fieldSources = sources;
    this._profileFieldSources[trainType] = sources;
    return sources;
  },

  _captureProfileFieldSources(trainType) {
    if (!trainType || !this._fieldSources || typeof this._fieldSources !== 'object') return null;
    const sources = { ...this._fieldSources };
    this._profileFieldSources[trainType] = sources;
    return sources;
  },

  _setFieldSource(key, source, trainType = this.form.model_train_type || this._activeTrainType) {
    if (!key || !trainType) return;
    if (!this._fieldSources || typeof this._fieldSources !== 'object') this._fieldSources = {};
    if (!this._profileFieldSources || typeof this._profileFieldSources !== 'object') {
      this._profileFieldSources = {};
    }
    this._fieldSources[key] = source;
    this._profileFieldSources[trainType] = this._fieldSources;
  },

  _profileFormFromDraft(trainType, defaults = this._buildFormDefaults(trainType), source = null) {
    const draft = this._migrateSdOptionModes(this._normalizeLegacyLoraMuonForm(
      source || this._profileFormDrafts[trainType] || {}
    ), trainType);
    const clean = { ...defaults };
    Object.keys(defaults).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(draft, key)) clean[key] = draft[key];
    });
    // Older drafts stored an empty timescale; use the editable form default.
    if (String(clean.lr_scheduler_timescale ?? '').trim() === '' && defaults.lr_scheduler_timescale !== undefined) {
      clean.lr_scheduler_timescale = defaults.lr_scheduler_timescale;
    }
    clean.model_train_type = trainType;
    return clean;
  },

  _migrateSdOptionModes(source, trainType) {
    const values = { ...source };
    // Sparse application snapshots used the old MOSS preset. Native imports carry
    // explicit argparse defaults from config_import.py before reaching this path.
    if (trainType === 'moss-image-lora' && Object.keys(source).length) {
      if (!values.timestep_sampling) values.timestep_sampling = 'sigma';
      if (!values.weighting_scheme && values.timestep_sampling !== 'truncated_logit_normal') {
        values.weighting_scheme = 'logit_normal';
      }
    }
    if (trainType === 'krea2-lora') {
      if (typeof values.network_args_custom === 'string') {
        values.network_args_custom = values.network_args_custom.split(/\r?\n/).filter(line => {
          const match = line.match(/^\s*loraplus_lr_ratio\s*=\s*([^\s]+)\s*$/);
          if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) return true;
          values.enable_loraplus = true;
          values.loraplus_lr_ratio = Number(match[1]);
          return false;
        }).join('\n');
      }
      return values;
    }
    const has = key => values[key] !== undefined && values[key] !== null && values[key] !== '';
    if (!has('sample_interval_mode')) {
      const specified = ['sample_every_n_epochs', 'sample_every_n_steps'].some(key => Object.hasOwn(values, key));
      values.sample_interval_mode = has('sample_every_n_epochs') ? 'epochs'
        : has('sample_every_n_steps') ? 'steps' : specified ? 'none' : 'epochs';
    }
    if (values.cpu_offload_checkpointing || values.unsloth_offload_checkpointing || values.block_swap_h2d_only) values.gradient_checkpointing = true;
    return values;
  },

  _captureProfileDraft(trainType, source = this.form, defaults = this._buildFormDefaults(trainType)) {
    if (!trainType) return null;
    const draft = this._profileFormFromDraft(trainType, defaults, source);
    this._profileFormDrafts[trainType] = draft;
    if (trainType === (this._activeTrainType || this.form.model_train_type)) {
      this._captureProfileFieldSources(trainType);
    }
    return draft;
  },

  _persistProfileDrafts(route = this.currentRoute) {
    const storageKey = this._profileDraftStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(this._profileFormDrafts));
    } catch (e) {}
  },

  _persistProfileFieldSources(route = this.currentRoute) {
    const storageKey = this._profileFieldSourceStorageKey(route);
    if (!storageKey || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        version: 1,
        profiles: this._profileFieldSources,
      }));
    } catch (e) {}
  },

  _applyKrea2ModelDefaults(target = this.form, defaults = this._buildFormDefaults('krea2-lora')) {
    ['dit', 'vae', 'text_encoder'].forEach(key => {
      if (target[key] === undefined || target[key] === null || String(target[key]).trim() === '') {
        target[key] = defaults[key];
      }
    });
  },

  _normalizeProfileSelectValues(trainType, defaults = this._buildFormDefaults(trainType), target = this.form) {
    window.getVisibleSections(trainType).forEach(section => {
      section.fields.forEach(field => {
        if (field.type !== 'select' || !Array.isArray(field.options) || !field.options.length) return;
        const group = window.TRAIN_GROUP_MAP?.[trainType];
        const validValues = field.options.filter(option => !group || !option.group || option.group === 'all'
          || (Array.isArray(option.group) ? option.group.includes(group) : option.group === group)).map(option => option.v);
        if (!validValues.includes(target[field.key])) {
          target[field.key] = defaults[field.key] ?? validValues[0];
        }
      });
    });
  },

  _deriveKrea2CacheDir(trainDataDir) {
    const raw = String(trainDataDir ?? '').trim();
    if (!raw) return '';
    const lastBackslash = raw.lastIndexOf('\\');
    const lastSlash = raw.lastIndexOf('/');
    const separator = lastBackslash > lastSlash ? '\\' : '/';
    const base = raw.replace(/[\\/]+$/, '');
    if (!base) return separator + '.krea2-cache';
    return `${base}${separator}.krea2-cache`;
  },

  _syncKrea2CacheDir() {
    if (!this.form || this.form.model_train_type !== 'krea2-lora') return false;
    const cacheDir = this._deriveKrea2CacheDir(this.form.train_data_dir);
    const changed = this.form.dataset_cache_dir !== cacheDir;
    if (changed) this.form.dataset_cache_dir = cacheDir;
    if (this.formDefaults && this.formDefaults.dataset_cache_dir !== cacheDir) {
      this.formDefaults.dataset_cache_dir = cacheDir;
    }
    return changed;
  },
};
