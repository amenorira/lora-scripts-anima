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
  _pickerMkdirOpen: false,
  _pickerMkdirName: '',
  _pickerMkdirBusy: false,
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
    if (key === 'resume' && role === 'file-folder') pickType = 'state-dir';
    if (role === 'state-dir' || role === 'file-state') pickType = 'state-dir';
    if (role === 'text-file' || role === 'file-text') pickType = 'text-file';
    if (role==='file-model') pickType='model-file';
    if (role==='file-model-saved') pickType='model-saved-file';
    const requestSeq = ++this._pickerRequestSeq;
    this._pickerRole = role;
    this.showFilePickerModal(key, [], pickType, target);
    this._pickerLoading = true;
    this._pickerError = '';
    try {
      const url = '/api/get_files?pick_type=' + encodeURIComponent(pickType);
      const r = await fetch(window.animaUrl(url));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (requestSeq !== this._pickerRequestSeq || !this.showFilePickerModalFlag) return;
      if (d.status !== 'success') throw new Error(d.message || this.t('common.fileBrowserFailed'));
      const files = d.data ? (d.data.files || d.data) : [];
      this._setPickerFiles(files);
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
    this._pickerMkdirOpen = false;
    this._pickerMkdirName = '';
    this._pickerMkdirBusy = false;
  },

  retryFilePicker() {
    if (this._pickerKey && this._pickerRole) this.builtinFilePicker(this._pickerKey, this._pickerRole, this._pickerTarget);
  },

  // 与后端 get_files 的扫描根目录保持一致，用于弹窗上下文显示与子目录分组
  PICKER_ROOTS: {
    'model-file': './models',
    'model-saved-file': './output',
    'train-dir': './train',
    'reg-dir': './train/regularization',
    'state-dir': './output',
    'text-file': './config · ./train',
  },

  _pickerIsDirKind(kind = this._pickerKind) {
    return ['train-dir', 'reg-dir', 'state-dir'].includes(kind);
  },

  showFilePickerModal(key, files, pickType, target = null) {
    this._pickerTarget = target;
    this._pickerKey = key;
    this._pickerFilter = '';
    this._pickerError = '';
    this._pickerKind = pickType || '';
    this._pickerRoot = this.PICKER_ROOTS[pickType] || '';
    this._pickerMkdirOpen = false;
    this._pickerMkdirName = '';
    this._pickerMkdirBusy = false;
    this._setPickerFiles(files);
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

  _groupPickerFiles(files) {
    const byDir = new Map();
    for (const f of files) {
      const dir = this._pickerRelDir(f.path);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(f);
    }
    return byDir;
  },

  _setPickerFiles(files) {
    const byDir = this._groupPickerFiles(Array.isArray(files) ? files : []);
    const dirs = [...byDir.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    this._pickerFiles = dirs.flatMap(dir => byDir.get(dir));
  },

  // 筛选和分组保留键盘导航使用的文件顺序。
  get pickerGroups() {
    let start = 0;
    return Array.from(this._groupPickerFiles(this.filteredPickerFiles), ([dir, files]) => {
      const group = { dir, files, start };
      start += files.length;
      return group;
    });
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
    const label = (this._pickerTarget && this._pickerTarget.label) || this._pickerFieldLabel(this._pickerKey);
    return this.t('common.pickerSelect')
      .replace('{field}', () => label);
  },

  // 与 renderField 的标签解析同规则：优先训练类型专属 descKey
  _pickerFieldLabel(key) {
    const trainType = this.form.model_train_type || 'anima-lora';
    const field = this._fieldDefinition(key, trainType);
    if (!field || !field.descKey) return key || '';
    const suffix = this._trainingTranslationSuffix(trainType);
    const specific = this.t(field.descKey + suffix);
    if (specific && specific !== field.descKey + suffix) return specific;
    return this.t(field.descKey) || key || '';
  },

  pickerContextText() {
    const n = this.filteredPickerFiles.length;
    const unit = this._pickerIsDirKind()
      ? this.t('common.pickerFolderUnit')
      : this.t('common.pickerFileUnit');
    return (this._pickerRoot || '') + ' · ' + n + ' ' + unit;
  },

  // 底部计数：仅在筛选时显示“命中/总数”，未筛选时头部已有目录与总数，不重复展示
  pickerCountText() {
    const total = (this._pickerFiles || []).length;
    const n = this.filteredPickerFiles.length;
    if (!this._pickerFilter || n === total) return '';
    const unit = this._pickerIsDirKind()
      ? this.t('common.pickerFolderUnit')
      : this.t('common.pickerFileUnit');
    return n + ' / ' + total + ' ' + unit;
  },

  pickerEmptyText() {
    return this.t('common.pickerEmpty') + (this._pickerRoot ? ' · ' + this._pickerRoot : '');
  },

  pickerSizeText(f) {
    const b = Number(f && (f.size_bytes ?? f.size));
    if (!b || !isFinite(b) || b <= 0) return '';
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1) return (Math.round(gb * 10) / 10) + ' GB';
    const mb = b / (1024 * 1024);
    if (mb >= 1) return (Math.round(mb * 10) / 10) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  },

  // 行内第二行详情：数据集给图片/打标进度，续训目录给 run/epoch/step，所有条目末尾补修改时间
  pickerDetailText(f) {
    const parts = [];
    if (this._pickerKind === 'state-dir') {
      if (f.run_name) parts.push(String(f.run_name));
      if (f.epoch != null) parts.push(this.t('monitor.sampleEpoch').replace('{n}', f.epoch));
      if (f.step != null) parts.push(this.t('monitor.sampleStep').replace('{n}', f.step));
    } else if (['train-dir', 'reg-dir'].includes(this._pickerKind) && typeof f.images === 'number') {
      let s = f.images + ' ' + this.t('common.pickerImagesUnit');
      if (f.images > 0) s += ' · ' + (f.captioned || 0) + ' ' + this.t('common.pickerCaptionedUnit');
      parts.push(s);
    }
    if (f.mtime) {
      const d = this._pickerFormatDate(f.mtime);
      if (d) parts.push(this.t('common.pickerModified') + ' ' + d);
    }
    return parts.join(' · ');
  },

  pickerOpenMkdir() {
    if (this._pickerKind !== 'train-dir') return;
    this._pickerMkdirOpen = true;
    this._pickerMkdirName = '';
    this.$nextTick(() => {
      document.getElementById('pickerMkdirInput')?.focus();
    });
  },

  pickerCloseMkdir() {
    this._pickerMkdirOpen = false;
    this._pickerMkdirName = '';
  },

  async _refreshPickerList(highlightPath = '') {
    if (!this.showFilePickerModalFlag || !this._pickerKind) return;
    const requestSeq = ++this._pickerRequestSeq;
    const pickType = this._pickerKind;
    this._pickerLoading = true;
    this._pickerError = '';
    try {
      const url = '/api/get_files?pick_type=' + encodeURIComponent(pickType);
      const r = await fetch(window.animaUrl(url));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (requestSeq !== this._pickerRequestSeq || !this.showFilePickerModalFlag) return;
      if (d.status !== 'success') throw new Error(d.message || this.t('common.fileBrowserFailed'));
      const files = d.data ? (d.data.files || d.data) : [];
      this._setPickerFiles(files);
      if (highlightPath) {
        this._pickerCurrent = this._normalizePickerPath(highlightPath);
      }
      this._pickerIndex = this._pickerCurrent
        ? this.filteredPickerFiles.findIndex(f => this._normalizePickerPath(f.path) === this._pickerCurrent)
        : -1;
      this.$nextTick(() => {
        if (requestSeq !== this._pickerRequestSeq) return;
        const active = document.querySelector('.picker-row.is-current, .picker-row.is-kb-active');
        if (active) active.scrollIntoView({ block: 'nearest' });
      });
    } catch (e) {
      if (requestSeq !== this._pickerRequestSeq || !this.showFilePickerModalFlag) return;
      this._pickerError = e.message || this.t('common.fileBrowserFailed');
    } finally {
      if (requestSeq === this._pickerRequestSeq) this._pickerLoading = false;
    }
  },

  async pickerSubmitMkdir() {
    const name = String(this._pickerMkdirName || '').trim();
    if (!name || this._pickerMkdirBusy || this._pickerKind !== 'train-dir') return;
    this._pickerMkdirBusy = true;
    try {
      const url = window.animaUrl('/api/files/mkdir');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: this._pickerRoot || './train', name }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status !== 'success') {
        const detailMsg = typeof body.detail === 'string' ? body.detail : '';
        const errMsg = body.error_code || body.errorCode
          ? this.localizeApiError?.(body, 'common.pickerMkdirFailed')
          : (body.message || detailMsg || this.localizeApiError?.(body, 'common.pickerMkdirFailed') || this.t('common.pickerMkdirFailed'));
        throw new Error(errMsg || this.t('common.pickerMkdirFailed'));
      }
      const data = body.data && typeof body.data === 'object' ? body.data : body;
      this._pickerMkdirOpen = false;
      this._pickerMkdirName = '';
      this.toast(this.t('common.pickerMkdirDone').replace('{name}', data.name || name), 'success');
      await this._refreshPickerList(data.path || '');
    } catch (e) {
      this.toast(e.message || this.t('common.pickerMkdirFailed'), 'error');
    } finally {
      this._pickerMkdirBusy = false;
    }
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
