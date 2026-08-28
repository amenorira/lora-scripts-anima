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
  confirmTitle: '',
  confirmMessage: '',
  confirmCallback: null,
  confirmActionLabel: '',
  _trainingDocumentId: null,

  async downloadConfig() {
    try {
      const response = await fetch('/api/training/export-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          form: this._collectTrainingFormSnapshot ? this._collectTrainingFormSnapshot() : { ...(this.form || {}) },
          document_id: this._trainingDocumentId || null,
        }),
      });
      const data = await response.json();
      if (data.status !== 'success' || !data.data || !data.data.content) {
        throw new Error(data.message || 'Failed to export configuration');
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

  _applyImportedFlatConfig(parsed) {
    const validTypes = new Set((this.trainTypes || []).map(item => item.v));
    const currentType = String(this.form && this.form.model_train_type || 'anima-lora');
    const importedType = String(parsed.model_train_type || currentType);
    if (!validTypes.has(importedType)) throw new Error(`Unsupported model_train_type: ${importedType}`);

    const applyValues = () => {
      const defaults = this._buildFormDefaults(importedType);
      const validKeys = new Set(['model_train_type']);
      window.getVisibleSections(importedType).forEach(section => {
        (section.fields || []).forEach(field => validKeys.add(field.key));
      });
      const imported = {};
      Object.entries(parsed).forEach(([key, value]) => {
        if (validKeys.has(key)) imported[key] = value;
      });
      this.form = { ...defaults, ...imported, model_train_type: importedType };
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
    };

    if (importedType !== currentType) {
      this._switchInProgress = true;
      try { this.switchTrainType(importedType); }
      finally { this._switchInProgress = false; }
      if (typeof this.$nextTick === 'function') {
        return new Promise((resolve, reject) => this.$nextTick(() => {
          try { applyValues(); resolve(); } catch (error) { reject(error); }
        }));
      }
    }
    applyValues();
    return Promise.resolve();
  },

  handleConfigFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const r = await fetch('/api/training/parse-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: e.target.result })
        });
        const d = await r.json();
        if (d.status !== 'success') throw new Error(d.message || this.t('common.parseError'));
        const parsed = d.data.data || {};
        if (Object.keys(parsed).length === 0) throw new Error(this.t('common.invalidToml'));
        await this._applyImportedFlatConfig(parsed);
        this._trainingDocumentId = d.data.document_id || null;
        this.toast(this.t('common.imported'));
      } catch (err) {
        this.toast(this.t('common.parseError') + ': ' + err.message);
      }
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
