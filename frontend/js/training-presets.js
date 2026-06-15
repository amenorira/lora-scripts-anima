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
  presetsLoading: false,
  currentPreset: null,
  currentPresetName: '',
  previewPreset: null,
  diffCounts: { modified: 0, added: 0 },
  formDiffMap: null,
  showEditModal: false,
  editPresetTarget: null,
  batchMode: false,
  selectedPresets: [],
  renamingPreset: null,
  renameNewName: '',
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
    const trainType = routeCfg.trainType || this.form.model_train_type || 'anima-lora';
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

  togglePreview(preset) {
    this.previewPreset = (this.previewPreset && this.previewPreset.metadata.name === preset.metadata.name) ? null : preset;
  },

  previewParamCount(preset) {
    if (!preset || !preset.data) return 0;
    return Object.keys(preset.data).length;
  },

  previewTopKeys(preset) {
    if (!preset || !preset.data) return [];
    return Object.keys(preset.data).slice(0, 8);
  },

  openEditModal(preset) {
    if (!preset || !preset.data || !this.form) return;
    this.editPresetTarget = preset;
    this._formBeforeEdit = { ...this.form };
    this._defaultsBeforeEdit = { ...this.formDefaults };
    this._historyBeforeEdit = [...this.formHistory];
    this._historyIdxBeforeEdit = this.formHistoryIdx;
    this.form = { ...preset.data };
    this.formDefaults = { ...this.form };
    this.formHistory = [this.formDefaults];
    this.formHistoryIdx = 0;
    this.showEditModal = true;
    this.updateToml();
    this.$nextTick(() => {
      this.renderTrainingForm(this.form.model_train_type || 'anima-lora', 'editPresetFormContent');
      const mb = document.querySelector('.modal-edit-preset .modal-body');
      if (mb) mb.scrollTop = 0;
    });
  },

  async saveEditedPreset() {
    const preset = this.editPresetTarget;
    if (!preset) return;
    const trainType = this.form.model_train_type || 'anima-lora';
    try {
      const r = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: preset.metadata.name,
          description: preset.metadata.description || '',
          train_type: trainType,
          data: { ...this.form }
        })
      });
      const d = await r.json();
      if (d.status !== 'success') { this.toast(this.t('common.failed') + ': ' + (d.message || '')); return; }
      this.showEditModal = false;
      this.editPresetTarget = null;
      await this.loadPresets();
      this.toast(this.t('common.saved'));
    } catch (e) { this.toast(this.t('common.failed') + ': ' + e.message); }
    finally {
      if (this._formBeforeEdit) {
        this.form = { ...this._formBeforeEdit };
        this.formDefaults = { ...this._defaultsBeforeEdit };
        this.formHistory = [...this._historyBeforeEdit];
        this.formHistoryIdx = this._historyIdxBeforeEdit;
      }
      this._formBeforeEdit = null;
      this._defaultsBeforeEdit = null;
      this._historyBeforeEdit = null;
      this.updateToml();
      this.rebuildForm();
    }
  },

  cancelEditPreset() {
    this.showEditModal = false;
    this.editPresetTarget = null;
    if (this._formBeforeEdit) {
      this.form = { ...this._formBeforeEdit };
      this.formDefaults = { ...this._defaultsBeforeEdit };
      this.formHistory = [...this._historyBeforeEdit];
      this.formHistoryIdx = this._historyIdxBeforeEdit;
    }
    this._formBeforeEdit = null;
    this._defaultsBeforeEdit = null;
    this._historyBeforeEdit = null;
    this.updateToml();
    this.rebuildForm();
  },

  startRename(preset) {
    this.renamingPreset = preset;
    this.renameNewName = preset.metadata.name || '';
    this.$nextTick(() => {
      const el = document.getElementById('renameInput');
      if (el) { el.focus(); el.select(); }
    });
  },

  async confirmRename() {
    const preset = this.renamingPreset;
    const newName = (this.renameNewName || '').trim();
    if (!preset || !newName || newName === preset.metadata.name) {
      this.renamingPreset = null;
      return;
    }
    try {
      const r = await fetch('/api/presets/' + encodeURIComponent(preset.metadata.name) + '/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: newName })
      });
      const d = await r.json();
      if (d.status !== 'success') { this.toast(this.t('common.failed') + ': ' + (d.message || '')); return; }
      this.renamingPreset = null;
      await this.loadPresets();
      this.toast(this.t('common.saved'));
    } catch (e) { this.toast(this.t('common.failed') + ': ' + e.message); }
  },

  cancelRename() {
    this.renamingPreset = null;
    this.renameNewName = '';
  },

  toggleBatchMode() {
    this.batchMode = !this.batchMode;
    this.selectedPresets = [];
  },

  togglePresetSelection(preset) {
    const name = preset.metadata.name;
    const idx = this.selectedPresets.indexOf(name);
    if (idx >= 0) {
      this.selectedPresets.splice(idx, 1);
    } else {
      this.selectedPresets.push(name);
    }
  },

  isPresetSelected(preset) {
    return this.selectedPresets.indexOf(preset.metadata.name) >= 0;
  },

  selectAllPresets() {
    this.selectedPresets = this.allPresets.map(p => p.metadata.name);
  },

  deselectAllPresets() {
    this.selectedPresets = [];
  },

  async batchDeletePresets() {
    if (this.selectedPresets.length === 0) return;
    const self = this;
    this.openConfirm(
      this.t('preset.batchDelete'),
      this.t('preset.confirmBatchDelete').replace('{n}', self.selectedPresets.length),
      async function() {
        const names = [...self.selectedPresets];
        let deleted = 0;
        for (const name of names) {
          try {
            const r = await fetch('/api/presets/' + encodeURIComponent(name), { method: 'DELETE' });
            const d = await r.json();
            if (d.status === 'success') deleted++;
          } catch (e) { /* continue */ }
        }
        const total = names.length;
        self.batchMode = false;
        self.selectedPresets = [];
        await self.loadPresets();
        self.toast(self.t('preset.deletedCount').replace('{deleted}', deleted).replace('{total}', total));
      }
    );
  },

  enterDiffMode() {
    const preset = this.previewPreset;
    if (!preset) return;
    const diffMap = {};
    let modified = 0, added = 0;
    const currentForm = this.form || {};
    const presetData = preset.data || {};
    const allKeys = new Set([...Object.keys(currentForm), ...Object.keys(presetData)]);
    for (const k of allKeys) {
      const cv = currentForm[k];
      const pv = presetData[k];
      if (pv === undefined) continue;
      if (cv === undefined) {
        diffMap[k] = { type: 'added', newVal: pv }; added++;
      } else if (String(cv) !== String(pv)) {
        diffMap[k] = { type: 'modified', oldVal: cv, newVal: pv }; modified++;
      }
    }
    this.formDiffMap = diffMap;
    this.diffCounts = { modified, added };
    this.showLoadModal = false;
    this.rebuildForm();
  },

  applyDiffPreset() {
    if (!this.previewPreset) return;
    this.applyPreset(this.previewPreset);
    this.formDiffMap = null;
    this.diffCounts = { modified: 0, added: 0 };
    this.previewPreset = null;
  },

  cancelDiff() {
    this.formDiffMap = null;
    this.diffCounts = { modified: 0, added: 0 };
    this.previewPreset = null;
    this.rebuildForm();
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
          var inner = val.slice(1,-1).trim();
          if (inner === '') { result[key] = []; continue; }
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

  // Called after buildTrainForm to show a toast about auto-loaded params
  _markAutoLoaded() {
    if (this._autoLoaded) return;
    if (!this.autoLoadHistory || !this.currentRoute.startsWith('train-')) return;
    this._autoLoaded = true;
    this.toast(this.t('common.autoLoadedHistory'));
  },

  // ── Presets ────────────────────────────────────────────
  async loadPresets() {
    this.presetsLoading = true;
    try {
      const r = await fetch('/api/presets');
      const d = await r.json();
      if (d.status === 'success' && d.data && d.data.presets) {
        this.allPresets = d.data.presets;
        const routeCfg = ROUTE_CONFIG[this.currentRoute] || {};
        const currentType = routeCfg.trainType || this.form.model_train_type || 'anima-lora';
        this.presets = d.data.presets.filter(p =>
          p && p.metadata && (!p.metadata.train_type || p.metadata.train_type === currentType)
        );
      }
    } catch (e) { /* ignore */ }
    finally { this.presetsLoading = false; }
  },

  applyPreset(preset) {
    if (!preset || !preset.data) return;
    if (this.formDiffMap) {
      this.formDiffMap = null;
      this.diffCounts = { modified: 0, added: 0 };
      this.previewPreset = null;
    }
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

  switchPresetWithDiff(dir) {
    if (this.presets.length < 2) return;
    const oldData = this.currentPreset && this.currentPreset.data ? { ...this.currentPreset.data } : null;
    this.switchPreset(dir);
    const newPreset = this.currentPreset;
    if (oldData && newPreset && newPreset.data) {
      const changes = this.computeChanges(oldData, newPreset.data);
      if (changes.length > 0) {
        const name = (newPreset.metadata && newPreset.metadata.name) || '';
        this.toast(this._formatSwitchToast(changes, name));
      }
    }
  },

  computeChanges(oldData, newData) {
    const changes = [];
    const allKeys = new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]);
    for (const k of allKeys) {
      const ov = oldData[k];
      const nv = newData[k];
      if (ov === undefined) { changes.push({ key: k, type: 'added', newVal: nv }); }
      else if (nv === undefined) { changes.push({ key: k, type: 'removed', oldVal: ov }); }
      else if (String(ov) !== String(nv)) { changes.push({ key: k, type: 'modified', oldVal: ov, newVal: nv }); }
    }
    return changes;
  },

  _formatSwitchToast(changes, name) {
    const t = this.t.bind(this);
    const lines = changes.slice(0, 5).map(c => {
      if (c.type === 'modified') {
        return c.key + ': ' + String(c.oldVal) + ' -> ' + String(c.newVal);
      } else if (c.type === 'added') {
        return '+ ' + c.key + ': ' + String(c.newVal) + ' (' + t('preset.diff.added') + ')';
      } else {
        return '- ' + c.key + ': ' + String(c.oldVal);
      }
    });
    if (changes.length > 5) lines.push('...' + t('preset.andMore').replace('{n}', changes.length - 5));
    return t('preset.switched') + ' ' + name + '\n' + lines.join('\n');
  },

  clearPreset() {
    this.formDiffMap = null;
    this.diffCounts = { modified: 0, added: 0 };
    this.previewPreset = null;
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
    const tt = (preset.metadata && preset.metadata.train_type) || 'anima-lora';
    const routeMap = { 'sdxl-lora': 'train-basic', 'anima-lora': 'train-anima' };
    const targetRoute = routeMap[tt] || 'train-anima';

    if (this.currentRoute === targetRoute) {
      // Already on target route — form is already built, apply directly
      this.$nextTick(() => this.applyPreset(preset));
    } else {
      // Store preset for deferred application after form initialization
      this._pendingPreset = preset;
      this.navigate(targetRoute);
    }
  }
};
