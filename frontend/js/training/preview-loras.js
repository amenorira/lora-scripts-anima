/* External adapters for in-process MOSS / Anima previews. */
window.trainingPreviewLoras = {
  _normalizePreviewLoras(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object'
        || Array.isArray(row) || (row.path != null && typeof row.path !== 'string')
        || (row.multiplier != null && typeof row.multiplier !== 'number' && typeof row.multiplier !== 'string'))) {
      throw new Error(this.t('previewLoras.invalid'));
    }
    return value.map(row => ({ path: row.path || '', multiplier: row.multiplier ?? 1 }));
  },
  addPreviewLora() {
    this.setField('preview_loras', [...(Array.isArray(this.form.preview_loras) ? this.form.preview_loras : []), { path: '', multiplier: 1 }]);
  },
  removePreviewLora(index) {
    this.setField('preview_loras', (Array.isArray(this.form.preview_loras) ? this.form.preview_loras : []).filter((_, i) => i !== index));
  },
  updatePreviewLora(index, key, value) {
    const rows = this.form.preview_loras || [];
    if (!rows[index]) return;
    const next = rows.map((row, i) => i === index ? { ...row, [key]: value } : row);
    this.setField('preview_loras', next);
  },
  pickPreviewLora(index, native = false) {
    const form = this.form, row = form.preview_loras?.[index], profile = form.model_train_type;
    if (!row) return;
    const target = {
      getValue: () => row.path,
      isCurrent: () => this.form === form && form.model_train_type === profile
        && form.preview_loras?.[index] === row,
      setValue: value => { if (target.isCurrent()) this.updatePreviewLora(index, 'path', value); },
    };
    return native ? this.localFilePicker('preview_loras', 'file-model', target)
      : this.builtinFilePicker('preview_loras', 'file-model', target);
  },
  previewLorasHtml() {
    const local = this.localPickerAvailable
      ? `<button type="button" class="btn-icon" @click="pickPreviewLora(index, true)" :title="t('common.localPicker')" :aria-label="t('common.browseLocal')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>` : '';
    return `<div class="preview-loras">
      <template x-for="(row, index) in (form.preview_loras || [])" :key="index">
        <div class="preview-lora-row">
          <div class="field-input-wrap"><input type="text" :aria-label="t('previewLoras.path')" :value="row.path" @input="updatePreviewLora(index, 'path', $event.target.value)"><div class="field-input-actions">${local}<button type="button" class="btn-icon" @click="pickPreviewLora(index)" :title="t('common.builtinBrowser')" :aria-label="t('common.searchBuiltin')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4-4"/></svg></button></div></div>
          <label class="preview-lora-multiplier"><span x-text="t('previewLoras.multiplier')"></span><input type="number" step="0.05" :aria-label="t('previewLoras.multiplier')" :value="row.multiplier" @input="updatePreviewLora(index, 'multiplier', $event.target.value)"></label>
          <button type="button" class="btn-icon" @click="removePreviewLora(index)" :title="t('common.delete')" :aria-label="t('common.delete')">×</button>
        </div>
      </template>
      <button type="button" class="btn btn-ghost btn-sm" @click="addPreviewLora()" x-text="t('previewLoras.add')"></button>
    </div>`;
  },
};
