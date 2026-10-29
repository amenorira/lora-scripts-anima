/* Training YAML/TOML import/export and shared confirmation dialog. */
window.trainingConfigIoMixin = {
  showConfirmModal: false,
  confirmTitle: '',
  confirmMessage: '',
  confirmCallback: null,
  confirmActionLabel: '',
  confirmDanger: false,
  confirmNotice: false,
  confirmSecondaryLabel: '',
  confirmSecondaryCallback: null,
  _trainingDocumentId: null,
  _configImportRequestSeq: 0,

  async downloadConfig() {
    try {
      if (!await this.ensureKreaDitFormat()) return;
      const response = await fetch('/api/training/export-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form: this._collectTrainingFormSnapshot(),
          document_id: this._trainingDocumentId || null,
        }),
      });
      const data = await response.json();
      if (data.status !== 'success' || !data.data || !data.data.content) {
        throw new Error(data.message || this.t('common.exportFailed'));
      }
      const blob = new Blob([data.data.content], { type: 'application/yaml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.data.filename || 'training.yaml';
      a.click();
      URL.revokeObjectURL(url);
      this._trainingDocumentId = data.data.document_id || this._trainingDocumentId || null;
      this.toast(this.t('common.downloaded'));
    } catch (error) {
      this.toast(this.t('common.requestFailed') + ': ' + error.message, 'error');
    }
  },

  importConfigFile() {
    document.getElementById('configFileInput').click();
  },

  _applyImportedFlatConfig(parsed, isCurrent) {
    const fileImport = typeof isCurrent === 'function';
    // History reuse also replaces the form, so it supersedes pending file imports.
    if (!isCurrent) {
      this._configImportRequestSeq++;
      isCurrent = () => true;
    }
    let targetForm = this.form;
    const route = this.currentRoute, routeSeq = this._routeTransitionSeq;
    const canApply = () => !fileImport || (isCurrent() && this.form === targetForm
      && this.currentRoute === route && this._routeTransitionSeq === routeSeq);
    if (!canApply()) return Promise.resolve(false);
    parsed = this._normalizeLegacyLoraMuonForm
      ? this._normalizeLegacyLoraMuonForm(parsed)
      : parsed;
    const validTypes = new Set((this.trainTypes || []).map(item => item.v));
    const currentType = String(this.form && this.form.model_train_type || 'anima-lora');
    const importedType = String(parsed.model_train_type || currentType);
    if (!validTypes.has(importedType)) throw new Error(this.t('common.unsupportedTrainingType').replace('{type}', () => importedType));

    const applyValues = () => {
      if (!canApply() || (fileImport && this.form.model_train_type !== importedType)) return false;
      const defaults = this._buildFormDefaults(importedType);
      const validKeys = new Set(['model_train_type']);
      window.getVisibleSections(importedType).forEach(section => {
        (section.fields || []).forEach(field => validKeys.add(field.key));
      });
      const imported = {};
      this._lastConfigImportIgnoredFields = Object.keys(parsed).filter(key => !validKeys.has(key));
      const migrated = this._migrateSdOptionModes ? this._migrateSdOptionModes(parsed, importedType) : parsed;
      Object.entries(migrated).forEach(([key, value]) => {
        if (validKeys.has(key)) imported[key] = value;
      });
      this.form = { ...defaults, ...imported, model_train_type: importedType };
      this._optimizerDrafts = { ...this._optimizerDrafts, [importedType]: {} };
      this._optimizerRestore = null;
      this._activeTrainType = importedType;
      this._replaceProfileFieldSources(importedType, defaults, Object.keys(imported), 'import');
      this._normalizeProfileSelectValues(importedType, defaults);
      if (importedType === 'krea2-lora') this._syncKrea2CacheDir();
      this._captureProfileDraft(importedType, this.form, defaults);
      this.formDefaults = { ...defaults };
      this.formHistory = [this.formDefaults];
      this.formHistoryIdx = 0;
      this.updateToml();
      this.rebuildForm();
      this._captureProfileDraft(importedType, this.form, defaults);
      this._persistProfileDrafts();
      this._persistProfileFieldSources();
      if (this.currentRoute && typeof localStorage !== 'undefined') {
        const targetRoute = this.currentRoute.startsWith('train-') ? this.currentRoute : 'train-basic';
        try { localStorage.setItem('anima-form-' + targetRoute, JSON.stringify(this.form)); } catch (e) {}
      }
      return this.form;
    };

    if (importedType !== currentType) {
      this._switchInProgress = true;
      try { this.switchTrainType(importedType); }
      finally { this._switchInProgress = false; }
      targetForm = this.form;
      if (typeof this.$nextTick === 'function') {
        return new Promise((resolve, reject) => this.$nextTick(() => {
          try { resolve(applyValues()); } catch (error) { reject(error); }
        }));
      }
    }
    return Promise.resolve(applyValues());
  },

  handleConfigFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const requestSeq = ++this._configImportRequestSeq;
    const form = this.form, route = this.currentRoute, routeSeq = this._routeTransitionSeq;
    const modelTrainType = this.form?.model_train_type || 'anima-lora';
    const isCurrent = () => requestSeq === this._configImportRequestSeq
      && this.currentRoute === route && this._routeTransitionSeq === routeSeq;
    const sourceIsCurrent = () => isCurrent() && this.form === form
      && (this.form?.model_train_type || 'anima-lora') === modelTrainType;
    const reader = new FileReader();
    reader.onload = async (e) => {
      if (!sourceIsCurrent()) return;
      let importForm = form, importProfile = modelTrainType;
      try {
        const r = await fetch('/api/training/parse-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: e.target.result, model_train_type: modelTrainType })
        });
        const d = await r.json();
        if (!sourceIsCurrent()) return;
        if (d.status !== 'success') throw new Error(d.message || this.t('common.parseError'));
        const parsed = d.data.data || {};
        if (Object.keys(parsed).length === 0) throw new Error(this.t('common.invalidToml'));
        let applying;
        try { applying = this._applyImportedFlatConfig(parsed, isCurrent); }
        finally { importForm = this.form; importProfile = this.form?.model_train_type; }
        const applied = await applying;
        if (applied === false || !isCurrent() || (applied && this.form !== applied)) return;
        this.dismissHistoryReuse?.();
        this._trainingDocumentId = d.data.document_id || null;
        const ignored = this._lastConfigImportIgnoredFields || [];
        if (ignored.length) {
          this.toast(this.t('common.importedWithIgnoredFields').replace('{fields}', ignored.join(', ')), 'warning');
        } else {
          this.toast(this.t('common.imported'));
        }
      } catch (err) {
        if (isCurrent() && this.form === importForm && this.form?.model_train_type === importProfile) {
          this.toast(this.t('common.parseError') + ': ' + err.message, 'error');
        }
      }
    };
    reader.onerror = () => {
      if (sourceIsCurrent()) this.toast(this.t('common.parseError') + ': ' + (reader.error?.message || this.t('common.requestFailed')), 'error');
    };
    reader.readAsText(file);
    event.target.value = '';
  },

  openConfirm(title, message, callback, actionLabel = '', opts = {}) {
    this.confirmTitle = title;
    this.confirmMessage = message;
    this.confirmCallback = callback;
    this.confirmActionLabel = actionLabel;
    this.confirmDanger = !!opts.danger;
    this.confirmNotice = !!opts.notice;
    this.confirmSecondaryLabel = opts.secondaryLabel || '';
    this.confirmSecondaryCallback = opts.secondaryCallback || null;
    this.showConfirmModal = true;
  },

  confirmAction() {
    this.showConfirmModal = false;
    const cb = this.confirmCallback;
    this.confirmCallback = null;
    this.confirmSecondaryCallback = null;
    if (typeof cb === 'function') cb();
  },

  confirmSecondaryAction() {
    this.showConfirmModal = false;
    const cb = this.confirmSecondaryCallback;
    this.confirmSecondaryCallback = null;
    if (typeof cb === 'function') cb();
  },

  cancelConfirm() {
    this.showConfirmModal = false;
    this.confirmCallback = null;
    this.confirmSecondaryCallback = null;
  },
};
