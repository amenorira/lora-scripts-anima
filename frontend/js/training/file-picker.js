/* Training file browser, native picker and keyboard navigation.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingFilePicker = {
  showFilePickerModalFlag: false,
  _pickerKey: '',
  _pickerFiles: [],
  _pickerFilter: '',
  _pickerLoading: false,
  _pickerError: '',
  _pickerRequestSeq: 0,
  _nativePickerRequestSeq: 0,
  _pickerRole: '',
  _pickerTarget: null,
  _invalidateTrainingPickers() {
    this._nativePickerRequestSeq++;
    this.closeFilePickerModal();
  },
  // ── File Pickers ───────────────────────────────────────
  async localFilePicker(key, role, target = null) {
    const requestSeq = ++this._nativePickerRequestSeq;
    const form = this.form, route = this.currentRoute, profile = form.model_train_type, value = form[key];
    const isCurrent = () => requestSeq === this._nativePickerRequestSeq
      && this.form === form && this.currentRoute === route
      && this.form.model_train_type === profile
      && (target ? target.isCurrent() : this.form[key] === value);
    let type = 'folder';
    if (role==='file-model'||role==='file-model-saved') type='model-file';
    try {
      const r = await fetch(this.nativePickerUrl(type));
      const d = await r.json();
      if (!isCurrent()) return;
      if (d.status==='success'&&d.data&&d.data.path) {
        if (target) target.setValue(d.data.path);
        else this.setField(key, d.data.path);
      } else {
        // 非 success：后端用 message 区分"unavailable"(tkinter 不可用) 与 "cancelled"(用户取消)。
        // 给出反馈，避免点击后毫无响应被误认为"不生效"。
        const msg = String(d.message || '');
        if (msg.indexOf('unavailable') !== -1) {
          this.toast(this.t('common.localPickerNA'), 'error');
        } else {
          this.toast(this.t('common.localPickerCancelled'));
        }
      }
    } catch(e) { if (isCurrent()) this.toast(this.t('common.localPickerNA'), 'error'); }
  },

  async builtinFilePicker(key, role, target = null) {
    let pickType = 'model-file';
    if (role==='file-folder') pickType='train-dir';
    if (key === 'reg_data_dir' && role === 'file-folder') pickType = 'reg-dir';
    if (role==='file-model') pickType='model-file';
    if (role==='file-model-saved') pickType='model-saved-file';
    const requestSeq = ++this._pickerRequestSeq;
    this._pickerRole = role;
    this.showFilePickerModal(key, [], pickType, target);
    this._pickerLoading = true;
    this._pickerError = '';
    try {
      const r = await fetch('/api/get_files?pick_type='+pickType);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (requestSeq !== this._pickerRequestSeq || !this.showFilePickerModalFlag) return;
      if (d.status !== 'success') throw new Error(d.message || this.t('common.fileBrowserFailed'));
      const files = d.data ? (d.data.files || d.data) : [];
      this._pickerFiles = Array.isArray(files) ? files : [];
      this._pickerCurrent = this._normalizePickerPath(target ? target.getValue() : this.form[key]);
      this._pickerIndex = this._pickerCurrent
        ? this.filteredPickerFiles.findIndex(f => this._normalizePickerPath(f.path) === this._pickerCurrent)
        : -1;
      this.$nextTick(() => {
        if (requestSeq !== this._pickerRequestSeq) return;
        const input = document.getElementById('pickerFilterInput');
        if (input && document.activeElement === document.querySelector('.picker-header .btn-icon')) input.focus();
        const active = document.querySelector('.picker-row.is-current');
        if (active) active.scrollIntoView({ block: 'center' });
      });
    } catch(e) {
      if (requestSeq !== this._pickerRequestSeq || !this.showFilePickerModalFlag) return;
      this._pickerError = e.message || this.t('common.fileBrowserFailed');
    } finally {
      if (requestSeq === this._pickerRequestSeq) this._pickerLoading = false;
    }
  },

  closeFilePickerModal() {
    this._pickerRequestSeq++;
    this._pickerLoading = false;
    this.showFilePickerModalFlag = false;
    this._pickerTarget = null;
  },

  retryFilePicker() {
    if (this._pickerKey && this._pickerRole) this.builtinFilePicker(this._pickerKey, this._pickerRole, this._pickerTarget);
  },

  // 与后端 get_files 的扫描根目录保持一致，用于弹窗上下文显示与子目录分组
  PICKER_ROOTS: { 'model-file': './models', 'model-saved-file': './output', 'train-dir': './train', 'reg-dir': './train/regularization' },

  showFilePickerModal(key, files, pickType, target = null) {
    this._pickerTarget = target;
    this._pickerKey = key;
    this._pickerFiles = files || [];
    this._pickerFilter = '';
    this._pickerError = '';
    this._pickerKind = pickType || '';
    this._pickerRoot = this.PICKER_ROOTS[pickType] || '';
    this._pickerCurrent = this._normalizePickerPath(target ? target.getValue() : this.form[key]);
    this.showFilePickerModalFlag = true;
    // 键盘高亮初始落在当前值所在行，并滚动到它
    const cur = this._pickerCurrent;
    this._pickerIndex = cur ? this.filteredPickerFiles.findIndex(f => this._normalizePickerPath(f.path) === cur) : -1;
    this.$nextTick(() => {
      const inp = document.getElementById('pickerFilterInput');
      if (inp) inp.focus();
      const active = document.querySelector('.picker-row.is-current');
      if (active) active.scrollIntoView({ block: 'center' });
    });
  },

  _normalizePickerPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  },

  pickerIsCurrent(f) {
    return !!this._pickerCurrent && this._normalizePickerPath(f.path) === this._pickerCurrent;
  },

  get filteredPickerFiles() {
    const filter = (this._pickerFilter || '').toLowerCase();
    if (!filter) return this._pickerFiles || [];
    return (this._pickerFiles || []).filter(f => f.name.toLowerCase().includes(filter));
  },

  // 按扫描根目录下的子目录分组；全部直接在根目录时只有一组（不显示分组头）
  get pickerGroups() {
    const byDir = new Map();
    for (const f of this.filteredPickerFiles) {
      const dir = this._pickerRelDir(f.path);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    const dirs = [...byDir.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    return dirs.map(d => ({ dir: d, files: byDir.get(d) }));
  },

  _pickerRelDir(path) {
    let p = String(path || '');
    const root = String(this._pickerRoot || '');
    if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1);
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '' : p.slice(0, idx);
  },

  // 注意：这些方法依赖 this.t()，不能写成 getter——测试会用 Object.assign 展开
  // mixin，getter 会在展开时被立即调用（此时 this 上还没有 t），直接抛错。
  pickerTitle() {
    return this.t('common.pickerSelect', 'Select') + ' ' + this._pickerFieldLabel(this._pickerKey);
  },

  // 与 renderField 的标签解析同规则：优先训练类型专属 descKey
  _pickerFieldLabel(key) {
    const trainType = this.form.model_train_type || 'anima-lora';
    const field = this._fieldDefinition(key, trainType);
    if (!field || !field.descKey) return key || '';
    const suffix = trainType === 'moss-image-lora' ? '_moss' : (trainType === 'anima-lora' ? '_anima' : (trainType === 'sdxl-lora' ? '_sdxl' : ''));
    const specific = this.t(field.descKey + suffix);
    if (specific && specific !== field.descKey + suffix) return specific;
    return this.t(field.descKey) || key || '';
  },

  pickerContextText() {
    const n = this.filteredPickerFiles.length;
    const unit = ['train-dir', 'reg-dir'].includes(this._pickerKind)
      ? this.t('common.pickerFolderUnit', 'folders')
      : this.t('common.pickerFileUnit', 'files');
    return (this._pickerRoot || '') + ' · ' + n + ' ' + unit;
  },

  // 底部计数：仅在筛选时显示“命中/总数”，未筛选时头部已有目录与总数，不重复展示
  pickerCountText() {
    const total = (this._pickerFiles || []).length;
    const n = this.filteredPickerFiles.length;
    if (!this._pickerFilter || n === total) return '';
    const unit = ['train-dir', 'reg-dir'].includes(this._pickerKind)
      ? this.t('common.pickerFolderUnit', 'folders')
      : this.t('common.pickerFileUnit', 'files');
    return n + ' / ' + total + ' ' + unit;
  },

  pickerEmptyText() {
    return this.t('common.pickerEmpty', 'No files found') + (this._pickerRoot ? ' · ' + this._pickerRoot : '');
  },

  pickerSizeText(f) {
    const b = Number(f && f.size_bytes);
    if (!b || !isFinite(b) || b <= 0) return '';
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1) return (Math.round(gb * 10) / 10) + ' GB';
    const mb = b / (1024 * 1024);
    if (mb >= 1) return (Math.round(mb * 10) / 10) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  },

  // 行内第二行详情：数据集给图片/打标进度，所有条目末尾补修改时间
  pickerDetailText(f) {
    const parts = [];
    if (['train-dir', 'reg-dir'].includes(this._pickerKind) && typeof f.images === 'number') {
      let s = f.images + ' ' + this.t('common.pickerImagesUnit', 'images');
      if (f.images > 0) s += ' · ' + (f.captioned || 0) + ' ' + this.t('common.pickerCaptionedUnit', 'captioned');
      parts.push(s);
    }
    if (f.mtime) {
      const d = this._pickerFormatDate(f.mtime);
      if (d) parts.push(this.t('common.pickerModified', 'Modified') + ' ' + d);
    }
    return parts.join(' · ');
  },

  _pickerFormatDate(ts) {
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  pickerMove(delta, e) {
    if (!this.showFilePickerModalFlag || this._pickerLoading || this._pickerError) return;
    const n = this.filteredPickerFiles.length;
    if (!n) return;
    if (e) e.preventDefault();
    let i = (typeof this._pickerIndex === 'number' ? this._pickerIndex : -1) + delta;
    if (i < 0) i = n - 1;
    if (i >= n) i = 0;
    this._pickerIndex = i;
    this.$nextTick(() => {
      const el = document.querySelector('.picker-row.is-kb-active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  },

  pickerConfirm(e) {
    if (!this.showFilePickerModalFlag || this._pickerLoading || this._pickerError) return;
    // 焦点在取消/关闭按钮上时，让按钮自身的点击行为生效
    if (e && e.target && e.target.tagName === 'BUTTON') return;
    if (e) e.preventDefault();
    const files = this.filteredPickerFiles;
    if (!files.length) return;
    let i = this._pickerIndex;
    if (typeof i !== 'number' || i < 0 || i >= files.length) i = 0;
    this.pickFileFromModal(files[i]);
  },

  pickFileFromModal(file) {
    if (!file) return;
    if (this._pickerTarget) this._pickerTarget.setValue(file.path || file.name || '');
    else this.setField(this._pickerKey, file.path || file.name || '');
    this.closeFilePickerModal();
  },
};
