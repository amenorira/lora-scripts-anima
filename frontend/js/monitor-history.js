/* 历史列表、筛选及运行详情加载；由 monitor-core.js 装配，沿用同一份监控状态。 */
window.monitorHistoryMixin = {
  // ── History ────────────────────────────────────────────
  startHistoryRefresh() {
    this.stopHistoryRefresh();
    this._historyTimer = setInterval(() => {
      if (this.currentRoute === 'history' && !document.hidden && !this.historyLoading && !this.historyDeleting) this.loadHistory(true);
    }, 15000);
  },

  stopHistoryRefresh() {
    if (this._historyTimer) clearInterval(this._historyTimer);
    this._historyTimer = null;
  },

  clearHistoryFilters() {
    this.historySearch = '';
    this.historyFilter = 'all';
    this.renderHistory();
  },

  async loadHistory(background = false) {
    if (background && (this.configSnapshotOpen || this.showConfirmModal || this.historyDeleting || this.historyReuseBusy)) return;
    const seq = ++this._historyRequestSeq;
    if (!background) this._historyProgressPending = true;
    this.historyLoading = true;
    this.historyError = '';
    try {
      const r = await fetch('/api/monitor/history' + (background ? '' : '?refresh=true'));
      const d = await r.json();
      if (seq !== this._historyRequestSeq) return;
      if (d.status !== 'success') throw new Error(d.message || this.t('monitor.historyLoadError'));
      const running = d.data.running || null;
      const items = d.data.history || [];
      if (!background || JSON.stringify([running, items]) !== JSON.stringify([this.runningTask, this.historyItems])) {
        this.runningTask = running;
        this.historyItems = items;
        this.renderHistory();
      }
    } catch(e) {
      if (seq === this._historyRequestSeq) this.historyError = e.message || this.t('monitor.historyLoadError');
    } finally {
      if (seq === this._historyRequestSeq) {
        this.historyLoading = false;
        if (this._historyProgressPending) {
          this._historyProgressPending = false;
          if (!this.currentRoute || this.currentRoute === 'history') this.finishProgress();
        }
      }
    }
  },

  get filteredHistoryItems() {
    const q = (this.historySearch||'').toLowerCase().trim();
    const filter = this.historyFilter || 'all';
    return (this.historyItems||[]).filter(h => {
      if (filter !== 'all' && (h.status||'') !== filter) return false;
      if (!q) return true;
      const hay = [h.name, h.model, h.dataset, h.time, h.artifact_dir, h.profile_label, h.network, h.optimizer].filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  },

  deleteHistoryRun(runDir) {
    if (!runDir || this.historyDeleting) return;
    const record = this.historyItems.find(item => item.run_dir === runDir);
    const identity = record ? [record.name, record.time].filter(Boolean).join(' · ') : runDir;
    this.openConfirm(this.t('monitor.confirmDeleteRunTitle'), identity + '\n\n' + this.t('monitor.confirmDeleteRun'), () => this._deleteHistoryRun(runDir), this.t('monitor.confirmDeleteRunTitle'), { danger: true });
  },

  async _deleteHistoryRun(runDir) {
    if (this.historyDeleting) return;
    this.historyDeleting = runDir;
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/history/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_dir: runDir })
      });
      const j = await r.json();
      if (j.status === 'success') {
        this.toast(this.t('monitor.runDeleted'), 'success');
      } else {
        this.toast(j.message || this.t('monitor.deleteFailed'), 'error');
      }
    } catch(e) {
      this.toast(this.t('monitor.deleteFailed'), 'error');
    } finally {
      await this.loadHistory();
      this.historyDeleting = '';
      this.finishProgress();
    }
  },

  // ── Run Detail (查看历史训练) ─────────────────────────
  async viewRunDetail(runDir, fromRoute = false, tab = 'overview') {
    /** 查看指定历史训练的详情（图表 + 日志 + 配置） */
    if (!fromRoute) {
      this.navigate('monitor-dashboard', { run: runDir });
      return;
    }
    this._runDetailRequestSeq++;
    this._logSliceRequestSeq++;
    this.logLines = [];
    this.logTotal = 0;
    this._logTailOffset = 0;
    this.logFullLines = [];
    this.logFullOffset = 0;
    this.logFullMatches = [];
    this.logFullQuery = '';
    this.logFullMatchIdx = -1;
    this.logFullLoading = false;
    this._logFullSourceKey = 'run:' + runDir;
    this._logContentVersion++;
    this.selectedRunDir = runDir;
    this.runDetailData = null;
    this.lossDataVersion++;
    this.trainParams = [];
    this.trainParamsVersion++;
    this.previews = [];
    this.previewsVersion++;
    this.runDetailLoading = true;
    this.runDetailError = '';
    this._resetOutputFilesForRun(runDir);
    this.monitorTab = ['overview', 'logs', 'samples', 'outputs'].includes(tab) ? tab : 'overview';
    this.monitorParamQuery = '';
    this._shellBuilt = false;
    this._forceLogRebuild = true;
    this.pageTitle = this.t('monitor.historyDetail');
    document.title = this.pageTitle + ' | lora-scripts-anima';
    // 等待 DOM 就绪后拉取数据
    await this.$nextTick();
    await this._fetchRunDetail(runDir);
  },

  async _fetchRunDetail(runDir) {
    if (this.selectedRunDir !== runDir) return;
    const requestSeq = ++this._runDetailRequestSeq;
    const isCurrent = () => requestSeq === this._runDetailRequestSeq && this.selectedRunDir === runDir;
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/run-detail?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (!isCurrent()) return;
      if (j.status === 'success') {
        this.runDetailLoading = false;
        this.runDetailData = j.data;
        this._applyOutputCount(runDir, j.data.output_count);
        this.runDetailData.perf_samples = this._mergeMonitorPerfSamples([], this._parseMonitorPerfLogs(j.data.log_lines));
        this.lossDataVersion++;
        this.trainParams = j.data.train_params || [];
        this.trainParamsVersion++;
        this.previews = j.data.previews || [];
        this.previewsVersion++;
        // 历史记录进入时定位到最新样本（末尾）
        this.previewStep = this.previews.length ? this.previews.length - 1 : 0;
        this._applyMonitorLogSnapshot(j.data.log_lines, j.data.log_total);
        this._forceLogRebuild = true;
        // 默认完整日志：末页 + 跟随（历史停在末尾；工具栏可翻页浏览全部）
        this.logFullLoading = false;
        this.logAutoScroll = true;
        this._logAtBottom = true;
        this.renderDashboard();
      } else {
        this.runDetailError = j.message || this.t('monitor.loadRunFailed');
        this.toast(j.message || this.t('monitor.loadRunFailed'));
      }
    } catch (e) {
      if (isCurrent()) this.runDetailError = this.t('monitor.runDetailError');
    } finally {
      if (isCurrent()) { this.runDetailLoading = false; this.renderDashboard(); this.finishProgress(); }
    }
  },

  resetRunDetailState() {
    /** 清除历史运行详情及其派生缓存，防止返回实时监控后继续显示历史数据。 */
    this._runDetailRequestSeq++;
    this._logSliceRequestSeq++;
    this.selectedRunDir = null;
    this.runDetailData = null;
    this.lossDataVersion++;
    this.trainParams = [];
    this.trainParamsVersion++;
    this.monitorParamQuery = '';
    this.previews = [];
    this.previewsVersion++;
    this.previewStep = 0;
    this._resetOutputFilesForRun('');
    this.logLines = [];
    this.logFullLines = [];
    this.logFullOffset = 0;
    this.logFullMatches = [];
    this.logFullQuery = '';
    this.logFullMatchIdx = -1;
    this.logFullLoading = false;
    this._shellBuilt = false;
    this._forceLogRebuild = true;
    this._logFullLoaded = false;
    this._logFullNeedsResync = false;
    this._logFullSlide = false;
    this._logFullSourceKey = '';
    this.logTotal = 0;
    this._logTailOffset = 0;
    this._logContentVersion++;
  },

  clearRunDetail() {
    /** 返回实时监控模式 */
    this.navigate('monitor-dashboard');
  },
};
