/* 输出文件加载、筛选、排序与下载；由 monitor-core.js 装配，沿用同一份监控状态。 */
window.monitorOutputsMixin = {
  _resetOutputFilesForRun(runDir) {
    this._outputFilesRequestSeq++;
    this._outputFilesRunDir = runDir || '';
    this.outputFiles = [];
    this.outputFilesVersion++;
    this.outputFilesSelected = {};
    this.outputFilesError = '';
    this.outputFilesLoading = false;
    this._outputFilesKnownCount = 0;
    this._outputFilesNeedsRefresh = false;
  },

  _applyOutputCount(runDir, count) {
    if (this._outputFilesRunDir !== runDir) this._resetOutputFilesForRun(runDir);
    if (Number.isInteger(count) && count >= 0 && count !== this._outputFilesKnownCount) {
      this._outputFilesKnownCount = count;
      this._outputCountVersion++;
      this._outputFilesNeedsRefresh = true;
    }
  },

  // ── Output Files ──────────────────────────────────────
  async loadOutputFiles() {
    if (this.outputFilesLoading) {
      this._outputFilesNeedsRefresh = true;
      return;
    }
    this._outputFilesNeedsRefresh = false;
    const runDir = this.currentOutputRunDir;
    if (!runDir) {
      this._outputFilesRequestSeq++;
      this.outputFiles = [];
      this.outputFilesSelected = {};
      this.outputFilesError = 'noRun';
      return;
    }
    if (this._outputFilesRunDir !== runDir) this._resetOutputFilesForRun(runDir);
    const requestSeq = ++this._outputFilesRequestSeq;
    const countVersion = this._outputCountVersion;
    this.outputFilesLoading = true;
    this.outputFilesError = '';
    this.renderDashboard();
    try {
      const r = await fetch('/api/monitor/outputs?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (requestSeq !== this._outputFilesRequestSeq || runDir !== this.currentOutputRunDir) return;
      if (j.status === 'success') {
        this.outputFiles = j.data || [];
        const paths = new Set(this.outputFiles.map(file => file.path));
        this.outputFilesSelected = Object.fromEntries(this.selectedOutputFiles.filter(path => paths.has(path)).map(path => [path, true]));
        if (countVersion === this._outputCountVersion) {
          if (this._outputFilesKnownCount !== this.outputFiles.length) this._outputCountVersion++;
          this._outputFilesKnownCount = this.outputFiles.length;
        }
        else this._outputFilesNeedsRefresh = true;
        this.outputFilesError = '';
        const target = this.currentArtifactData();
        target.artifact_available = true;
        if (j.meta && j.meta.artifact_dir) target.artifact_dir = j.meta.artifact_dir;
      } else {
        this.outputFiles = [];
        this.outputFilesSelected = {};
        this.outputFilesError = (j.data && j.data.artifact_available === false)
          ? 'artifactUnavailable'
          : 'loadFailed';
        if (this.outputFilesError === 'artifactUnavailable') {
          const target = this.currentArtifactData();
          target.artifact_available = false;
          if (j.data && j.data.artifact_dir) target.artifact_dir = j.data.artifact_dir;
        }
      }
    } catch (e) {
      if (requestSeq !== this._outputFilesRequestSeq || runDir !== this.currentOutputRunDir) return;
      this.outputFiles = [];
      this.outputFilesSelected = {};
      this.outputFilesError = 'loadFailed';
    } finally {
      if (requestSeq === this._outputFilesRequestSeq && runDir === this.currentOutputRunDir) {
        this.outputFilesLoading = false;
        this.outputFilesVersion++;
        this.renderDashboard();
      }
    }
  },

  toggleOutputFile(path) {
    if (this.outputFilesSelected[path]) {
      delete this.outputFilesSelected[path];
    } else {
      this.outputFilesSelected[path] = true;
    }
    this.renderDashboard();
  },

  selectAllOutputFiles() {
    this._visibleOutputFiles().forEach(f => { this.outputFilesSelected[f.path] = true; });
    this.renderDashboard();
  },

  deselectAllOutputFiles() {
    this.outputFilesSelected = {};
    this.renderDashboard();
  },

  get selectedOutputFiles() {
    return Object.keys(this.outputFilesSelected).filter(k => this.outputFilesSelected[k]);
  },

  // 首屏详情与产物事件直接更新总数，列表保持按需加载；0 是有效结果。
  get outputTabCount() {
    return this._outputFilesRunDir === this.currentOutputRunDir && this.currentArtifactData().artifact_available !== false
      ? this._outputFilesKnownCount : 0;
  },

  _visibleOutputFiles() {
    const query = String(this.outputSearch || '').trim().toLowerCase();
    const filter = this.outputFilter || 'all';
    return (this.outputFiles || []).filter(file => {
      const isModel = file.category === 'model';
      if (filter === 'models' && !isModel) return false;
      if (filter === 'others' && isModel) return false;
      return !query || String(file.name || '').toLowerCase().includes(query);
    });
  },

  _sortedOutputs() {
    const files = this._visibleOutputFiles();
    const models = files.filter(f => f.category === 'model');
    const others = files.filter(f => f.category !== 'model');
    const sortFiles = (items, key, direction) => items.slice().sort((a, b) => {
      const dir = direction === 'desc' ? -1 : 1;
      let va, vb;
      if (key === 'loss') {
        if (a.ckpt_loss == null || b.ckpt_loss == null) return (a.ckpt_loss == null ? 1 : 0) - (b.ckpt_loss == null ? 1 : 0);
        va = (a.ckpt_loss == null) ? Infinity : a.ckpt_loss;
        vb = (b.ckpt_loss == null) ? Infinity : b.ckpt_loss;
      } else if (key === 'time') {
        va = a.mtime || 0; vb = b.mtime || 0;
      } else if (key === 'size') {
        va = a.size || 0; vb = b.size || 0;
      } else if (key === 'type') {
        va = (a.category || (a.name || '').split('.').pop() || '').toLowerCase();
        vb = (b.category || (b.name || '').split('.').pop() || '').toLowerCase();
        if (va < vb) return -dir;
        if (va > vb) return dir;
        return 0;
      } else {
        va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase();
        if (va < vb) return -dir;
        if (va > vb) return dir;
        return 0;
      }
      return (va - vb) * dir;
    });
    return {
      models: sortFiles(models, this.outputModelSortKey || 'loss', this.outputModelSortDir || 'asc'),
      others: sortFiles(others, this.outputOtherSortKey || 'time', this.outputOtherSortDir || 'desc'),
    };
  },

  setOutputSort(group, key) {
    const modelGroup = group === 'models';
    const keyField = modelGroup ? 'outputModelSortKey' : 'outputOtherSortKey';
    const dirField = modelGroup ? 'outputModelSortDir' : 'outputOtherSortDir';
    if (this[keyField] === key) {
      this[dirField] = this[dirField] === 'asc' ? 'desc' : 'asc';
    } else {
      this[keyField] = key;
      this[dirField] = (key === 'loss' || key === 'name' || key === 'type') ? 'asc' : 'desc';
    }
    this.renderDashboard();
  },

  setOutputFilter(filter) {
    if (!['all', 'models', 'others'].includes(filter)) return;
    this.outputFilter = filter;
    this.renderDashboard();
  },

  setOutputSearch(value) {
    this.outputSearch = String(value || '');
    this.renderDashboard();
  },

  clearOutputFilters() {
    this.outputSearch = '';
    this.outputFilter = 'all';
    this.renderDashboard();
  },

  // 用隐藏 <a download> 触发下载，避免 window.open 被拦截 / 返回 JSON 错误页
  _triggerDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { if (a.parentNode) a.remove(); }, 1000);
  },

  async downloadSelectedOutputs() {
    const runDir = this.currentOutputRunDir;
    if (!runDir) return;
    const selected = this.selectedOutputFiles;
    if (selected.length === 1) { this.downloadSingleOutput(selected[0]); return; }
    if (!selected.length) {
      this.toast(this.t('monitor.selectFilesFirst'));
      return;
    }
    const filesParam = selected.map(f => encodeURIComponent(f)).join(',');
    this.toast(this.t('monitor.preparingDownload'));
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir) + '&files=' + filesParam);
  },

  async downloadAllOutputs() {
    const runDir = this.currentOutputRunDir;
    if (!runDir) return;
    this.toast(this.t('monitor.preparingDownload'));
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir));
  },

  downloadSingleOutput(path) {
    if (!path) return;
    const runDir = this.currentOutputRunDir;
    if (!runDir) return;
    this._triggerDownload('/api/monitor/outputs/download-file?run_dir=' + encodeURIComponent(runDir) + '&path=' + encodeURIComponent(path));
  },
};
