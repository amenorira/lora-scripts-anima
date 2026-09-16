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
    return !!(this.trainingActive || this.isTraining);
  },

  // 应用/重算在途时目录名正在变，中途再发请求会找不到子集。
  datasetRepeatReadOnly() {
    return this.datasetRepeatLocked() || !!this.datasetRepeatApplying;
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
        next[moves.get(key)] = value;
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
      throw new Error(this.datasetRepeatErrorText(result));
    }
    return result.data;
  },

  // 改名整批要么全成要么回滚（后端保证），所以一次请求只重算一次；等它返回再解除禁用，
  // 界面就不会出现"已改名但列表还是旧名"的窗口。
  async _runDatasetRepeatChanges(changes, dir) {
    this.datasetRepeatApplying = true;
    try {
      const applied = (await this._postDatasetRepeatChanges(changes, dir)).applied || [];
      if (!applied.length) return [];
      this.datasetRepeatDrafts = {};
      this._renameSubsetTimestepOffsets(applied);
      await this.refreshStepEstimate(true);
      return applied;
    } finally {
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
      // 失败时保留草稿：用户可以直接改掉冲突项再应用一次。
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
      text = text.replace(`{${name}}`, String(values[name]));
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
      trainingActive: 'datasetRepeat.errors.trainingActive',
    };
    // 未覆盖的 errorCode 走兜底，不把后端的中英双语 message 直接塞进界面。
    const key = keys[data.errorCode] || 'datasetRepeat.errors.failed';
    return this._datasetRepeatText(key, (result && result.message) || '', params);
  },

  renderDatasetSubsets() {
    return `<div class="dataset-subset-panel" :class="{ 'is-locked': datasetRepeatLocked() }">
      <div class="dataset-subset-header">
        <div>
          <div class="dataset-subset-title">${this.esc(this.t('datasetRepeat.title'))}</div>
          <div class="field-hint">${this.esc(this.t('datasetRepeat.hint'))}</div>
          <div class="field-hint dataset-subset-locked" x-show="datasetRepeatLocked()">${this.esc(this.t('datasetRepeat.locked'))}</div>
        </div>
        <span class="dataset-subset-total" x-show="datasetRepeatSubsets().length" x-text="datasetRepeatTotalLabel()"></span>
      </div>
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
