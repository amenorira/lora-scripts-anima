/* 打标来源、模式草稿、扫描与上传；由 tagger.js 装配。 */
window.taggerSourcesMixin = {
  taggerModeIsApi() {
    return String(this.taggerSourceMode).startsWith('api-');
  },

  async selectTaggerSourceMode(mode, {allowActive = false} = {}) {
    if ((!allowActive && this.taggerRunning) || this.taggerStarting || this.taggerScanning
      || !['folder', 'single', 'api-folder', 'api-single'].includes(mode) || mode === this.taggerSourceMode) return;
    this._taggerSourceScanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    clearTimeout(this._taggerSourceScanTimer);
    this.stopTaggerSingleResize();
    this._taggerModeStates[this.taggerSourceMode] = this._captureTaggerModeState();
    this.taggerSourceMode = mode;
    if (this.currentRoute !== 'ai-captioning') localStorage.setItem('anima-tagger-mode', mode);
    const stored = this._taggerModeStates[mode];
    this._taggerModeStates[mode] = null;
    this._restoreTaggerModeState(stored);
    this.resetTaggerPreview();
    // 布局重建触发入场动画（m-tab-enter），期间隐藏页面滚动条 thumb 避免位移撑大滚动区导致闪现
    const scroller = document.querySelector('.main-content');
    if (scroller) {
      scroller.classList.add('scroll-entering');
      clearTimeout(this._scrollEnteringTimer);
      this._scrollEnteringTimer = setTimeout(() => scroller.classList.remove('scroll-entering'), 520);
    }
  },

  // 模式 tab 滑动指示条：与监控台 tab 共用 .monitor-tab-indicator 样式
  _syncTaggerTabIndicator(selector = '.tagger-mode-tabs') {
    const bar = document.querySelector(selector);
    if (!bar) return;
    const indicator = bar.querySelector('.monitor-tab-indicator');
    const active = bar.querySelector('button.active');
    if (!indicator || !active || !active.offsetWidth) return;
    if (!bar.classList.contains('indicator-ready')) {
      bar.classList.add('no-anim');
      indicator.style.width = active.offsetWidth + 'px';
      indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      void indicator.offsetWidth; // 强制 reflow，首次定位不播放动画
      bar.classList.remove('no-anim');
      bar.classList.add('indicator-ready');
      return;
    }
    indicator.style.width = active.offsetWidth + 'px';
    indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  },

  _captureTaggerModeState() {
    return {
      sourcePath: this.taggerSourcePath,
      source: this.taggerSource,
      taskId: this.taggerTaskId,
      items: this.taggerItems,
      itemsTotal: this.taggerItemsTotal,
      selectedIndex: this.taggerSelectedIndex,
      resultText: this.taggerResultText,
      resultCategories: this.taggerResultCategories,
      categoryState: this.taggerCategoryState,
      loadedResultKey: this._taggerLoadedResultKey,
      previewObjectUrl: this._taggerPreviewObjectUrl,
      failedOnly: this.taggerFailedOnly,
      logsOpen: this.taggerLogsOpen,
    };
  },

  _restoreTaggerModeState(state) {
    this.taggerSourcePath = state?.sourcePath || '';
    this.taggerSource = state?.source || null;
    this.taggerTaskId = state?.taskId || null;
    this.taggerItems = state?.items || [];
    this.taggerItemsTotal = Number(state?.itemsTotal || 0);
    this.taggerSelectedIndex = Number(state?.selectedIndex || 0);
    this.taggerResultText = state?.resultText || '';
    this.taggerResultCategories = state?.resultCategories || {};
    this.taggerCategoryState = state?.categoryState || {};
    this._taggerLoadedResultKey = state?.loadedResultKey || '';
    this._taggerPreviewObjectUrl = state?.previewObjectUrl || null;
    this.syncTaggerDictionary();
    this.taggerFailedOnly = !!state?.failedOnly;
    this.taggerLogsOpen = !!state?.logsOpen;
  },

  clearTaggerSource() {
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    this.stopTaggerSingleResize();
    this._clearTaggerTask();
    this._taggerModeStates[this.taggerSourceMode] = null;
    this._releaseTaggerPreview();
    this._restoreTaggerModeState(null);
    this.resetTaggerPreview();
    this.captionSourceChanged?.(this.taggerSourceMode);
  },

  _clearStoredTaggerResult(state) {
    if (!state) return;
    state.taskId = null;
    state.resultText = '';
    state.resultCategories = {};
    state.categoryState = {};
    state.loadedResultKey = '';
    state.items = (state.items || []).map(item => {
      const next = Object.assign({}, item, { status: 'pending' });
      delete next.result;
      delete next.tag_count;
      delete next.error;
      return next;
    });
  },

  _clearTaggerResultState(clearTask = false) {
    this.tagDictionaryCloseHover?.();
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    this._taggerLoadedResultKey = '';
    if (!clearTask) return;
    this._clearTaggerTask();
    this.taggerItems = this.taggerItems.map(item => {
      const next = Object.assign({}, item, { status: 'pending' });
      delete next.result;
      delete next.tag_count;
      delete next.error;
      return next;
    });
  },

  async pickTaggerSource() {
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    const mode = this.taggerSourceMode, route = this.currentRoute, path = this.taggerSourcePath;
    const formVersion = this._taggerFormVersion, scanVersion = this._taggerSourceScanVersion;
    const request = this._taggerPickerRequest = Number(this._taggerPickerRequest || 0) + 1;
    const isCurrent = () => request === this._taggerPickerRequest
      && mode === this.taggerSourceMode && route === this.currentRoute && path === this.taggerSourcePath
      && formVersion === this._taggerFormVersion && scanVersion === this._taggerSourceScanVersion
      && !this.taggerRunning && !this.taggerStarting && !this.captionPreviewBusy;
    try {
      const picker = mode.endsWith('single') ? 'image-file' : 'folder';
      const response = await fetch(this.nativePickerUrl(picker));
      const body = await response.json();
      if (!isCurrent()) return;
      if (body.status === 'success' && body.data && body.data.path) {
        this.taggerSourcePath = body.data.path;
        await this.scanTaggerSource();
      }
    } catch (_) { if (isCurrent()) this.toast(this.t('common.localPickerNA')); }
  },

  scheduleTaggerSourceScan() {
    if (this.taggerRunning || this.taggerStarting || this.captionPreviewBusy) return;
    if (this._taggerSourceScanTimer) clearTimeout(this._taggerSourceScanTimer);
    this._taggerSourceScanTimer = null;
    this._taggerSourceScanVersion = Number(this._taggerSourceScanVersion || 0) + 1;

    const path = this.taggerSourcePath.trim();
    const scannedPath = String(this.taggerSource?.path || '').trim();
    if (this.taggerSource && path !== scannedPath) {
      this.taggerSource = null;
      this.taggerItems = [];
      this.taggerItemsTotal = 0;
      this.taggerSelectedIndex = 0;
      this.taggerResultText = '';
      this.taggerResultCategories = {};
      this.taggerCategoryState = {};
      this._taggerLoadedResultKey = '';
      if (this.taggerSourceMode === 'api-folder') {
        this._clearTaggerResultState(true);
        this.captionSourceChanged?.(this.taggerSourceMode);
      }
    }
    if (!path || this.taggerRunning) return;

    this._taggerSourceScanTimer = setTimeout(() => {
      this._taggerSourceScanTimer = null;
      void this.scanTaggerSource({ quiet: true });
    }, 500);
  },

  async handleTaggerFileInput(event) {
    const file = event.target.files && event.target.files[0];
    if (file) await this.uploadTaggerFile(file);
    event.target.value = '';
  },

  async handleTaggerPaste(event) {
    if (event.defaultPrevented || !['tagger', 'ai-captioning'].includes(this.currentRoute) || !this.taggerSourceMode.endsWith('single')) return;
    if (this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    const target = event.target;
    if (target?.isContentEditable || target?.closest?.('input, textarea, select')) return;

    const clipboard = event.clipboardData;
    let file = Array.from(clipboard?.files || []).find(file => file.type.startsWith('image/'));
    if (!file) {
      for (const item of Array.from(clipboard?.items || [])) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        file = item.getAsFile();
        if (file) break;
      }
    }
    if (!file) return;
    event.preventDefault();
    await this.uploadTaggerFile(file);
  },

  async handleTaggerDrop(event) {
    this.taggerDragOver = false;
    if (!this.taggerSourceMode.endsWith('single')) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) await this.uploadTaggerFile(file);
  },

  async uploadTaggerFile(file) {
    if (!file || !file.type.startsWith('image/') || this.taggerRunning || this.taggerStarting || this.taggerScanning || this.captionPreviewBusy) return;
    const mode = this.taggerSourceMode, route = this.currentRoute;
    const version = this._taggerSourceScanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    this.taggerScanning = true;
    const previewUrl = URL.createObjectURL(file);
    let installed = false;
    try {
      const data = new FormData();
      data.append('file', file, file.name);
      const response = await fetch('/api/tagger/uploads', { method: 'POST', body: data });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || this.t('tagger.uploadFailed'));
      if (version !== this._taggerSourceScanVersion || mode !== this.taggerSourceMode || route !== this.currentRoute) return;
      body.data.display_name = file.name || this.t('tagger.singleImage');
      this._releaseTaggerPreview();
      this._taggerPreviewObjectUrl = previewUrl;
      installed = true;
      this.setTaggerSource(body.data);
    } catch (error) {
      if (version === this._taggerSourceScanVersion && route === this.currentRoute) this.toast(error.message, 'error');
    } finally {
      if (!installed) URL.revokeObjectURL(previewUrl);
      if (version === this._taggerSourceScanVersion) this.taggerScanning = false;
    }
  },

  async scanTaggerSource(options = {}) {
    if (this._taggerSourceScanTimer) clearTimeout(this._taggerSourceScanTimer);
    this._taggerSourceScanTimer = null;
    const path = this.taggerSourcePath.trim();
    if (!path) return;
    const mode = this.taggerSourceMode;
    const route = this.currentRoute;
    const scanVersion = Number(this._taggerSourceScanVersion || 0) + 1;
    this._taggerSourceScanVersion = scanVersion;
    this.taggerScanning = true;
    if (mode === 'api-folder') this.captionSourceError = '';
    try {
      const recursive = this.taggerModeIsApi() ? this.captionOptions.recursive !== false : this.taggerSettings.recursive;
      const response = await fetch('/api/tagger/source/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, recursive, caption_extension: this.taggerModeIsApi() ? this.captionOptions.caption_extension : '.txt', caption_options: this.taggerModeIsApi() ? this.captionOptions : undefined }),
      });
      const body = await response.json();
      if (body.status !== 'success') throw new Error(body.message || this.t('tagger.scanFailed'));
      if (mode.endsWith('single') && !['file','upload'].includes(body.data.kind)) throw new Error(this.t('caption.singleFileRequired'));
      if (mode === 'api-folder' && body.data.kind !== 'folder') throw new Error(this.t('caption.selectDirectory'));
      if (scanVersion !== this._taggerSourceScanVersion || path !== this.taggerSourcePath.trim() || mode !== this.taggerSourceMode || route !== this.currentRoute) return;
      this.setTaggerSource(body.data);
    } catch (error) {
      if (scanVersion === this._taggerSourceScanVersion && mode === this.taggerSourceMode && route === this.currentRoute && path === this.taggerSourcePath.trim()) {
        if (route === 'ai-captioning' && mode === 'api-folder') this.captionSourceError = this.captionErrorMessage?.(error) || error.message || String(error);
        else if (!options.quiet) this.toast(error.message, 'error');
      }
    } finally {
      if (scanVersion === this._taggerSourceScanVersion) this.taggerScanning = false;
    }
  },

  setTaggerSource(source) {
    if (!this.taggerRunning) {
      this._clearTaggerTask();
    }
    this.taggerSource = source;
    this.taggerSourcePath = source.display_name || source.path || this.taggerSourcePath;
    this.taggerItems = (source.items || []).map(item => Object.assign({ status: 'pending' }, item));
    this.taggerItemsTotal = Number(source.total || this.taggerItems.length);
    this.taggerSelectedIndex = 0;
    this.taggerResultText = '';
    this.taggerResultCategories = {};
    this.taggerCategoryState = {};
    this._taggerLoadedResultKey = '';
    this.resetTaggerPreview();
    this.saveTaggerSettings();
    this.captionSourceChanged?.(this.taggerSourceMode);
  },

  _releaseTaggerPreview() {
    if (this._taggerPreviewObjectUrl) URL.revokeObjectURL(this._taggerPreviewObjectUrl);
    this._taggerPreviewObjectUrl = null;
  },
};
