// 数据集子集重复次数面板（= 目录名的数字前缀，sd-scripts 开训时才解析）。
// 与 training-lr-preview.js / training-shape-preview.js 同属训练表单的功能面板 mixin。
window.datasetRepeatMixin = {
  // 一行草稿的合法性、改后的次数、改后的目录名都在这里判定一次，其余取值方法都从它派生。
  // 参数用 subset 对象而非名字：表格每格都会求值，按名字查找会退化成 O(n²)。
  datasetRepeatParse(subset) {
    const current = Number(subset.repeats || 0);
    const raw = String(this.datasetRepeatInputValue(subset)).trim();
    if (!/^\d+$/.test(raw)) return { state: 'invalid', repeats: current, nextName: '' };
    const repeats = Number(raw);
    if (repeats < 1 || repeats > 999) return { state: 'invalid', repeats: current, nextName: '' };
    if (repeats === current) return { state: 'clean', repeats: current, nextName: '' };
    const separator = subset.name.indexOf('_');
    return {
      state: 'dirty',
      repeats,
      // 目录名不带下划线时给不出合法新名，留空不预览，交给后端报明确的命名错误。
      nextName: separator < 0 ? '' : `${repeats}_${subset.name.slice(separator + 1)}`,
    };
  },

  datasetRepeatLocked() {
    return !!(this.trainingActive || this.isTraining || this.trainingStarting);
  },

  // 应用/重算在途时目录名正在变，中途再发请求会找不到子集。
  datasetRepeatReadOnly() {
    return this.datasetRepeatLocked() || !!this.datasetRepeatApplying;
  },

  datasetRepeatFailureText() {
    const failure = this.datasetRepeatFailure;
    return failure?.dir === String(this.form.train_data_dir || '').trim() ? failure.message : '';
  },

  datasetRepeatSubsets() {
    return ((this.stepEstimate && this.stepEstimate.subsets) || []).filter(subset => !subset.is_reg);
  },

  datasetRepeatInputValue(subset) {
    return Object.prototype.hasOwnProperty.call(this.datasetRepeatDrafts || {}, subset.name)
      ? this.datasetRepeatDrafts[subset.name]
      : String(Number(subset.repeats || 0));
  },

  datasetRepeatPreviewLabel(subset) {
    const nextName = this.datasetRepeatParse(subset).nextName;
    return nextName ? `→ ${nextName}` : '';
  },

  // 草稿生效后的采样数（图片数 × 生效 repeat），表格、合计、占比共用这一处算法。
  datasetRepeatSamples(subset) {
    return Number(subset.image_count || 0) * this.datasetRepeatParse(subset).repeats;
  },

  datasetRepeatSampleText(subset) {
    return String(this.datasetRepeatSamples(subset));
  },

  datasetRepeatTotalSamples() {
    return this.datasetRepeatSubsets().reduce((sum, subset) => sum + this.datasetRepeatSamples(subset), 0);
  },

  datasetRepeatTotalLabel() {
    const subsets = this.datasetRepeatSubsets();
    if (!subsets.length) return '';
    const applied = subsets.reduce((sum, subset) => sum + Number(subset.sample_count || 0), 0);
    const preview = this.datasetRepeatTotalSamples();
    return this._datasetRepeatText('datasetRepeat.total', 'Train samples {samples}', {
      samples: preview === applied ? String(applied) : `${applied} → ${preview}`,
    });
  },

  datasetRepeatShare(subset) {
    const total = this.datasetRepeatTotalSamples();
    if (total <= 0) return '';
    return `${((this.datasetRepeatSamples(subset) / total) * 100).toFixed(1)}%`;
  },

  datasetRepeatPendingChanges() {
    const changes = [];
    this.datasetRepeatSubsets().forEach(subset => {
      const parsed = this.datasetRepeatParse(subset);
      if (parsed.state === 'dirty') changes.push({ name: subset.name, repeats: parsed.repeats });
    });
    return changes;
  },

  datasetRepeatDirtyCount() {
    return this.datasetRepeatPendingChanges().length;
  },

  // 只要存了草稿就算数（含非法草稿）：重置按钮据此启用，否则非法草稿只能靠重新输入清掉。
  datasetRepeatHasDraft() {
    return Object.keys(this.datasetRepeatDrafts || {}).length > 0;
  },

  datasetRepeatHasInvalidRow() {
    return this.datasetRepeatSubsets().some(subset => this.datasetRepeatParse(subset).state === 'invalid');
  },

  datasetRepeatCanApply() {
    return !this.datasetRepeatReadOnly()
      && !this.datasetRepeatHasInvalidRow()
      && this.datasetRepeatDirtyCount() > 0;
  },

  datasetRepeatApplyLabel() {
    const count = this.datasetRepeatDirtyCount();
    const label = this.t('datasetRepeat.apply');
    return count ? `${label} (${count})` : label;
  },

  // 无数据时才让位给提示文案：重算期间保留现有行，免得目录名闪一下再回来。
  datasetRepeatShowList() {
    return this.datasetRepeatSubsets().length > 0;
  },

  datasetRepeatEmptyText() {
    if (!String(this.form.train_data_dir || '').trim()) return this.t('datasetRepeat.selectDir');
    if (this.stepEstimateLoading) return this.t('datasetRepeat.loading');
    if (this.stepEstimateError) return this.stepEstimateErrorText();
    return this.t('datasetRepeat.noSubsets');
  },

  // 草稿等于磁盘值就删掉，否则会留下一条清不掉的空草稿记录。
  setDatasetRepeatDraft(subset, rawValue) {
    const next = { ...(this.datasetRepeatDrafts || {}) };
    const raw = String(rawValue ?? '');
    if (raw.trim() === String(Number(subset.repeats || 0))) delete next[subset.name];
    else next[subset.name] = raw;
    this.datasetRepeatDrafts = next;
  },

  stepDatasetRepeat(subset, delta) {
    const parsed = this.datasetRepeatParse(subset);
    const current = parsed.state === 'invalid' ? Number(subset.repeats || 0) || 1 : parsed.repeats;
    this.setDatasetRepeatDraft(subset, String(Math.min(999, Math.max(1, current + delta))));
  },

  resetDatasetRepeatDrafts() {
    this.datasetRepeatDrafts = {};
  },

  datasetRepeatUndoVisible() {
    const last = this.datasetRepeatLastApplied;
    if (!last || !last.items.length) return false;
    // 换了数据集目录后，"撤销上一次应用"不再对应同一批目录。
    return last.dir === String(this.form.train_data_dir || '').trim();
  },

  datasetRepeatUndoLabel() {
    const last = this.datasetRepeatLastApplied;
    if (!last) return '';
    return this._datasetRepeatText('datasetRepeat.applied', 'Applied {count} changes', {
      count: last.items.length,
    });
  },

  // subset_timestep_offsets 用文件夹名做 key，对不上的 key 会被 _reconcileSubsetTimestepOffsets
  // 静默删掉，改名必须同步搬。从原字典整体映射而非逐个改写，互换/环形改名才不会互相覆盖。
  _renameSubsetTimestepOffsets(pairs) {
    const moves = new Map((pairs || [])
      .filter(item => item.oldName !== item.newName)
      .map(item => [item.oldName, item.newName]));
    if (!moves.size) return;
    const current = this.form.subset_timestep_offsets;
    if (!current || typeof current !== 'object' || Array.isArray(current)) return;

    let touched = false;
    const next = {};
    Object.entries(current).forEach(([key, value]) => {
      if (moves.has(key)) {
        // newName 为空时清除部分回滚后不再可靠的偏移。
        if (moves.get(key)) next[moves.get(key)] = value;
        touched = true;
      } else {
        next[key] = value;
      }
    });
    if (!touched) return;

    this.form.subset_timestep_offsets = next;
    this._setFieldSource('subset_timestep_offsets', 'user');
    this._persistProfileFieldSources();
    this.pushHistory({ ...this.form, subset_timestep_offsets: { ...next } });
    if (typeof this.queueTomlPreviewChange === 'function') this.queueTomlPreviewChange('subset_timestep_offsets');
    if (typeof this.updateToml === 'function') this.updateToml();
  },

  _renameDatasetRepeatProfileOffsets(pairs, dir) {
    const isCurrent = String(this.form.train_data_dir || '').trim() === dir;
    if (isCurrent) {
      this._renameSubsetTimestepOffsets(pairs);
      this._captureProfileDraft?.(this.form.model_train_type, this.form);
    }
    const moves = new Map(pairs.map(item => [item.oldName, item.newName]));
    for (const [draftProfile, draft] of Object.entries(this._profileFormDrafts || {})) {
      if ((isCurrent && draftProfile === this.form.model_train_type) || String(draft.train_data_dir || '').trim() !== dir) continue;
      const offsets = Object.fromEntries(Object.entries(draft.subset_timestep_offsets || {})
        .filter(([name]) => !moves.has(name) || moves.get(name))
        .map(([name, offset]) => [moves.get(name) || name, offset]));
      this._profileFormDrafts[draftProfile] = { ...draft, subset_timestep_offsets: offsets };
    }
    this._persistProfileDrafts();
  },

  async _postDatasetRepeatChanges(changes, dir) {
    let response;
    let result;
    try {
      response = await fetch('/api/training/dataset-repeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, changes }),
      });
      result = await response.json();
    } catch (error) {
      // 网络层/解析失败拿不到后端 errorCode，单独包一条本地化文案。
      throw new Error(this._datasetRepeatText('datasetRepeat.errors.requestFailed', 'Request failed: {message}', {
        message: error.message,
      }));
    }
    if (!response.ok || result.status !== 'success' || !result.data) {
      const error = new Error(this.datasetRepeatErrorText(result));
      error.datasetRepeatData = result.data;
      throw error;
    }
    return result.data;
  },

  // 请求失败也可能已改动磁盘：回滚不完整时同步实际名称，并保留人工恢复所需的信息。
  async _runDatasetRepeatChanges(changes, dir) {
    const drafts = this.datasetRepeatDrafts;
    const isCurrent = () => String(this.form.train_data_dir || '').trim() === dir;
    if (this.datasetRepeatFailure?.dir === dir) this.datasetRepeatFailure = null;
    this.datasetRepeatApplying = true;
    this._datasetRepeatMutationDir = dir;
    clearTimeout(this._stepEstimateTimer);
    this._stepEstimateTimer = null;
    this._stepEstimateRequestSeq = (this._stepEstimateRequestSeq || 0) + 1;
    this.stepEstimateLoading = false;
    try {
      const applied = (await this._postDatasetRepeatChanges(changes, dir)).applied || [];
      this._datasetRepeatMutationDir = null;
      if (!applied.length) return [];
      if (isCurrent() || this.datasetRepeatDrafts === drafts) this.datasetRepeatDrafts = {};
      this._renameDatasetRepeatProfileOffsets(applied, dir);
      if (isCurrent()) await this.refreshStepEstimate(true);
      return applied;
    } catch (error) {
      this._datasetRepeatMutationDir = null;
      const data = error.datasetRepeatData;
      const unknown = !data?.errorCode || data.errorCode === 'failed';
      if (unknown || data.errorCode === 'rollbackFailed') {
        const names = unknown ? changes.map(item => item.name)
          : (data.recovery || []).flatMap(item => [item.oldName, item.currentName]);
        this._renameDatasetRepeatProfileOffsets(names.map(name => ({ oldName: name, newName: null })), dir);
        if (this.datasetRepeatLastApplied?.dir === dir) this.datasetRepeatLastApplied = null;
        if (isCurrent() || this.datasetRepeatDrafts === drafts) this.datasetRepeatDrafts = {};
        this.datasetRepeatFailure = { dir, message: error.message };
      }
      if (isCurrent() && (unknown || ['renameFailed', 'rollbackFailed'].includes(data.errorCode))) {
        await this.refreshStepEstimate(true);
      }
      throw error;
    } finally {
      this._datasetRepeatMutationDir = null;
      this.datasetRepeatApplying = false;
    }
  },

  async applyDatasetRepeatChanges() {
    if (!this.datasetRepeatCanApply()) return;
    const changes = this.datasetRepeatPendingChanges();
    const dir = String(this.form.train_data_dir || '').trim();
    try {
      const applied = await this._runDatasetRepeatChanges(changes, dir);
      if (!applied.length) return;
      this.datasetRepeatLastApplied = {
        dir,
        items: applied.map(item => ({ oldName: item.oldName, newName: item.newName })),
      };
      this.toast(this._datasetRepeatText('datasetRepeat.applied', 'Applied {count} changes', {
        count: applied.length,
      }));
    } catch (error) {
      // 校验失败或完整回滚时保留草稿；部分回滚已在上层清除失效状态。
      this.toast(error.message, 'error');
    }
  },

  async undoDatasetRepeatChanges() {
    const last = this.datasetRepeatLastApplied;
    if (!last || !last.items.length || this.datasetRepeatReadOnly()) return;
    const changes = last.items.map(item => ({
      name: item.newName,
      repeats: Number(String(item.oldName).split('_')[0]),
    }));
    try {
      const applied = await this._runDatasetRepeatChanges(changes, last.dir);
      if (!applied.length) return;
      this.datasetRepeatLastApplied = null;
      this.toast(this.t('datasetRepeat.undone'));
    } catch (error) {
      this.toast(error.message, 'error');
    }
  },

  _datasetRepeatText(key, fallback, values) {
    void this.locale;
    let text = this.t(key, fallback);
    Object.keys(values || {}).forEach(name => {
      text = text.replaceAll(`{${name}}`, () => String(values[name]));
    });
    return text;
  },

  datasetRepeatErrorText(result) {
    const data = (result && result.data) || {};
    const params = data.errorParams || {};
    const keys = {
      datasetMissing: 'datasetRepeat.errors.datasetMissing',
      subsetMissing: 'datasetRepeat.errors.subsetMissing',
      invalidSubsetName: 'datasetRepeat.errors.invalidSubsetName',
      invalidRepeats: 'datasetRepeat.errors.invalidRepeats',
      repeatsOutOfRange: 'datasetRepeat.errors.repeatsOutOfRange',
      targetExists: 'datasetRepeat.errors.targetExists',
      duplicateTarget: 'datasetRepeat.errors.duplicateTarget',
      renameFailed: 'datasetRepeat.errors.renameFailed',
      rollbackFailed: 'datasetRepeat.errors.rollbackFailed',
      trainingActive: 'datasetRepeat.errors.trainingActive',
    };
    // 未覆盖的 errorCode 走兜底，不把后端的中英双语 message 直接塞进界面。
    const key = keys[data.errorCode] || 'datasetRepeat.errors.failed';
    const message = this._datasetRepeatText(key, (result && result.message) || '', params);
    const recovery = (data.recovery || []).map(item => `${item.currentPath} → ${item.originalPath}`).join('\n');
    return recovery ? `${message}\n${recovery}` : message;
  },

  renderDatasetSubsets() {
    if (this.form.model_train_type === 'krea2-lora') return '';
    return `<div class="dataset-subset-panel" :class="{ 'is-locked': datasetRepeatLocked() }">
      <div class="dataset-subset-header">
        <div>
          <div class="dataset-subset-title">${this.esc(this.t('datasetRepeat.title'))}</div>
          <div class="field-hint">${this.esc(this.t('datasetRepeat.hint'))}</div>
          <div class="field-hint dataset-subset-locked" x-show="datasetRepeatLocked()">${this.esc(this.t('datasetRepeat.locked'))}</div>
        </div>
        <span class="dataset-subset-total" x-show="datasetRepeatSubsets().length" x-text="datasetRepeatTotalLabel()"></span>
      </div>
      <div class="field-hint dataset-subset-invalid" style="white-space: pre-wrap; overflow-wrap: anywhere" x-show="datasetRepeatFailureText()" x-text="datasetRepeatFailureText()"></div>
      <div class="dataset-subset-empty field-hint" x-show="!datasetRepeatShowList()" x-text="datasetRepeatEmptyText()"></div>
      <div class="dataset-subset-list" x-show="datasetRepeatShowList()">
        <div class="dataset-subset-row dataset-subset-row--head">
          <span>${this.esc(this.t('datasetRepeat.subset'))}</span>
          <span>${this.esc(this.t('datasetRepeat.images'))}</span>
          <span>${this.esc(this.t('datasetRepeat.repeats'))}</span>
          <span>${this.esc(this.t('datasetRepeat.samples'))}</span>
          <span>${this.esc(this.t('datasetRepeat.share'))}</span>
        </div>
        <template x-for="subset in datasetRepeatSubsets()" :key="subset.name">
          <div class="dataset-subset-row" :class="{ 'is-dirty': datasetRepeatParse(subset).state === 'dirty', 'is-invalid': datasetRepeatParse(subset).state === 'invalid' }">
            <span class="dataset-subset-name" :title="subset.name"><span class="dataset-subset-folder" x-text="subset.name"></span><span class="dataset-subset-preview" x-text="datasetRepeatPreviewLabel(subset)"></span></span>
            <span class="dataset-subset-meta" x-text="subset.image_count"></span>
            <div class="stepper dataset-subset-stepper">
              <button type="button" @click="stepDatasetRepeat(subset, -1)" :disabled="datasetRepeatReadOnly()">−</button>
              <input type="text" inputmode="numeric" autocomplete="off" :value="datasetRepeatInputValue(subset)" @input="setDatasetRepeatDraft(subset, $event.target.value)" @keydown.enter.prevent="applyDatasetRepeatChanges()" :disabled="datasetRepeatReadOnly()">
              <button type="button" @click="stepDatasetRepeat(subset, 1)" :disabled="datasetRepeatReadOnly()">+</button>
            </div>
            <span class="dataset-subset-meta" x-text="datasetRepeatSampleText(subset)"></span>
            <span class="dataset-subset-meta" x-text="datasetRepeatShare(subset)"></span>
          </div>
        </template>
      </div>
      <div class="dataset-subset-footer" x-show="datasetRepeatShowList()">
        <span class="field-hint dataset-subset-invalid" x-show="datasetRepeatHasInvalidRow()">${this.esc(this.t('datasetRepeat.invalidRow'))}</span>
        <span class="dataset-subset-applied" x-show="datasetRepeatUndoVisible()" x-text="datasetRepeatUndoLabel()"></span>
        <button type="button" class="btn btn-ghost btn-sm" x-show="datasetRepeatUndoVisible()" @click="undoDatasetRepeatChanges()" :disabled="datasetRepeatReadOnly()">${this.esc(this.t('datasetRepeat.undo'))}</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="resetDatasetRepeatDrafts()" :disabled="!datasetRepeatHasDraft()">${this.esc(this.t('datasetRepeat.reset'))}</button>
        <button type="button" class="btn btn-primary btn-sm" @click="applyDatasetRepeatChanges()" :disabled="!datasetRepeatCanApply()" x-text="datasetRepeatApplyLabel()"></button>
      </div>
    </div>`;
  },
};
