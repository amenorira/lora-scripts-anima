/* ================================================================
   training-presets.js — Presets, param save/load, confirm modal
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.trainingPresetsMixin = {
  showLoadModal: false,
  showSaveModal: false,
  showConfirmModal: false,
  confirmTitle: '',
  confirmMessage: '',
  confirmCallback: null,
  savePresetName: '',
  savePresetDesc: '',
  presets: [],
  allPresets: [],
  currentPreset: null,
  currentPresetName: '',

  // ── Param Save/Load (server presets) ──────────────────
  openSavePresetModal() {
    this.savePresetName = this.form.output_name || '';
    this.savePresetDesc = '';
    this.showSaveModal = true;
  },

  async confirmSavePreset() {
    const name = (this.savePresetName || '').trim();
    if (!name) { this.toast(this.t('common.enterConfigName')); return; }
    const routeCfg = ROUTE_CONFIG[this.currentRoute] || {};
    const trainType = routeCfg.trainType || this.form.model_train_type || 'sd-lora';
    try {
      const r = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name, description: this.savePresetDesc || '',
          train_type: trainType, data: { ...this.form }
        })
      });
      const d = await r.json();
      if (d.status !== 'success') { this.toast(this.t('common.failed') + ': ' + (d.message || '')); return; }
      this.showSaveModal = false;
      this.currentPresetName = name;
      this.currentPreset = { metadata: { name }, data: { ...this.form } };
      await this.loadPresets();
      this.toast(this.t('common.saved'));
    } catch (e) { this.toast(this.t('common.failed') + ': ' + e.message); }
  },

  cancelSavePreset() {
    this.showSaveModal = false;
    this.savePresetName = '';
    this.savePresetDesc = '';
  },

  loadPresetFromList(preset) {
    if (!preset) return;
    this.applyPreset(preset);
    this.showLoadModal = false;
  },

  // ── Confirm Modal ─────────────────────────────────────
  openConfirm(title, message, callback) {
    this.confirmTitle = title;
    this.confirmMessage = message;
    this.confirmCallback = callback;
    this.showConfirmModal = true;
  },
  confirmAction() {
    this.showConfirmModal = false;
    const cb = this.confirmCallback;
    this.confirmCallback = null;
    if (cb) cb();
  },
  cancelConfirm() {
    this.showConfirmModal = false;
    this.confirmCallback = null;
  },

  async deletePresetFromList(preset) {
    if (!preset || !preset.metadata || !preset.metadata.name) return;
    const name = preset.metadata.name;
    const self = this;
    this.openConfirm(
      this.t('preset.confirmDelete'),
      this.t('preset.confirmDeleteMsg') + ': ' + name,
      async function() {
        try {
          const r = await fetch('/api/presets/' + encodeURIComponent(name), { method: 'DELETE' });
          const d = await r.json();
          if (d.status !== 'success') { self.toast(self.t('common.failed') + ': ' + (d.message || '')); return; }
          await self.loadPresets();
          self.toast(d.message || self.t('preset.cleared'));
        } catch (e) { self.toast(self.t('common.failed') + ': ' + e.message); }
      }
    );
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
      // Inline array: ["a", "b"] or ['a', 'b']
      if (val.startsWith('[') && val.endsWith(']')) {
        try {
          // Normalize TOML array to JSON: unquoted strings → quoted
          const inner = val.slice(1,-1).trim();
          if (inner === '') { result[key] = []; continue; }
          // Try native JSON parse first (works if all items are quoted)
          result[key] = JSON.parse(val);
        } catch(_) {
          // Fallback: split by comma, strip quotes
          result[key] = inner.split(',').map(s => {
            s = s.trim();
            if ((s.startsWith('"')&&s.endsWith('"'))||(s.startsWith("'")&&s.endsWith("'"))) return s.slice(1,-1);
            return s;
          }).filter(s => s);
        }
        continue;
      }
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

  // ── Presets ────────────────────────────────────────────
  async loadPresets() {
    try {
      const r = await fetch('/api/presets');
      const d = await r.json();
      if (d.status === 'success' && d.data && d.data.presets) {
        this.allPresets = d.data.presets;
        const routeCfg = ROUTE_CONFIG[this.currentRoute] || {};
        const currentType = routeCfg.trainType || this.form.model_train_type || 'sd-lora';
        this.presets = d.data.presets.filter(p =>
          p && p.metadata && (!p.metadata.train_type || p.metadata.train_type === currentType)
        );
      }
    } catch (e) { /* ignore */ }
  },

  applyPreset(preset) {
    if (!preset || !preset.data) return;
    const data = preset.data;
    const overrideKeys = Object.keys(data);
    for (const k of overrideKeys) {
      if (k === 'model_train_type') {
        this.form.model_train_type = data.model_train_type;
        continue;
      }
      this.form[k] = data[k];
    }
    this.formDefaults = { ...this.form };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.currentPreset = preset;
    this.currentPresetName = (preset.metadata && preset.metadata.name) || '';
    this.updateToml();
    this.rebuildForm();
    this.toast(this.t('preset.loaded') + ': ' + this.currentPresetName);
  },

  switchPreset(dir) {
    if (this.presets.length < 2) return;
    let idx = this.presets.findIndex(p => p === this.currentPreset);
    if (idx < 0) idx = 0;
    idx = (idx + dir + this.presets.length) % this.presets.length;
    this.applyPreset(this.presets[idx]);
  },

  clearPreset() {
    this.currentPreset = null;
    this.currentPresetName = '';
    this.form = { ...this.formDefaults };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.updateToml();
    this.rebuildForm();
    this.toast(this.t('preset.cleared'));
  },

  applyPresetNavigate(preset) {
    if (!preset || !preset.data) return;
    // Determine target route from preset train_type
    const tt = (preset.metadata && preset.metadata.train_type) || 'sd-lora';
    const routeMap = { 'sd-lora': 'train-basic', 'sdxl-lora': 'train-basic', 'anima-lora': 'train-anima' };
    const targetRoute = routeMap[tt] || 'train-basic';
    this.navigate(targetRoute);
    // Apply after navigate so buildTrainForm runs first
    this.$nextTick(() => this.applyPreset(preset));
  }
};
