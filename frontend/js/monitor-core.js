/* ================================================================
   monitor-core.js — State, polling, history
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.monitorCoreMixin = {
  // ── State ──────────────────────────────────────────────
  monitorData: null, monitorTimer: null, monitorPollMs: 2000,
  gpuInfo: null, sysInfo: null, lossSeries: [], trainParams: [],
  previews: [], previewStep: 0, historyItems: [], runningTask: null,
  logAutoScroll: true, logLines: [], logMaxLines: 5000,
  logSearch: '', logErrorsOnly: false, logLevel: 'all',
  chartSmoothing: 0.6, dashTab: 'overview', _chartInstances: null,
  _monitorAbortCtrl: null,
  _monitorRequestSeq: 0,  // 递增请求序列号，丢弃过期响应

  // ── History run detail ─────────────────────────────────
  selectedRunDir: null,   // 当前查看的历史训练 run_dir（null = 查看实时）
  runDetailData: null,    // 历史训练详情缓存

  // ── Polling ────────────────────────────────────────────
  startMonitorPolling() {
    this.stopMonitorPolling(); this._monitorFirstFetch = true;
    this.fetchMonitorStatus();
    this.monitorTimer = setInterval(() => this.fetchMonitorStatus(), this.monitorPollMs);
  },
  stopMonitorPolling() {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    if (this._monitorAbortCtrl) { this._monitorAbortCtrl.abort(); this._monitorAbortCtrl = null; }
    this._monitorFirstFetch = false; this._dashboardRendered = false; this._destroyCharts();
  },
  async fetchMonitorStatus() {
    // Abort previous in-flight request to prevent stale data overwriting fresh data
    if (this._monitorAbortCtrl) this._monitorAbortCtrl.abort();
    this._monitorAbortCtrl = new AbortController();
    // 递增请求序列号，用于丢弃过期响应
    const seq = ++this._monitorRequestSeq;
    try {
      const tid = this.taskId || '';
      const r = await fetch('/api/monitor/status?task_id='+encodeURIComponent(tid), { signal: this._monitorAbortCtrl.signal });
      if (!r.ok) return;
      const j = await r.json();
      // 丢弃过期响应（序列号不匹配说明有更新的请求已发出）
      if (seq !== this._monitorRequestSeq) return;
      if (j.status==='success') {
        this.monitorData = j.data; this.gpuInfo = j.data.gpu; this.sysInfo = j.data.system;
        // 仅在实时模式下更新图表/日志数据（历史模式由 viewRunDetail 管理）
        if (!this.selectedRunDir) {
          this.lossSeries = j.data.tensorboard_loss||[];
          this.trainParams = j.data.train_params||[];
          this.previews = j.data.previews||[];
          if (j.data.log_lines) this.logLines = j.data.log_lines;
        }
        if (j.data.state==='RUNNING') { this.isTraining=true; this.isIdle=false; this.statusText=j.data.state_label||j.data.state; }
        else if (j.data.state==='IDLE') { this.isTraining=false; this.isIdle=true; this.statusText='Idle'; }
        if (this.currentRoute==='monitor-dashboard') this.renderDashboard();
        if (this.currentRoute==='monitor-logs') this.renderLogs();
      }
      if (this._monitorFirstFetch) { this._monitorFirstFetch=false; this.finishProgress(); }
    } catch(e) {
      if (e.name === 'AbortError') return; // silently ignore aborted requests
      if (this._monitorFirstFetch) { this._monitorFirstFetch=false; this.finishProgress(); }
    }
  },

  // ── Log helpers ────────────────────────────────────────
  copyLogs() { navigator.clipboard.writeText(this.logLines.join('\n')).then(() => this.toast(this.t('common.copied'))); },
  clearLogs() { this.logLines = []; this.renderLogs(); },

  // ── History ────────────────────────────────────────────
  async loadHistory() {
    try {
      const r = await fetch('/api/monitor/history');
      const d = await r.json();
      if (d.status==='success') {
        this.runningTask = d.data.running || null;
        this.historyItems = d.data.history || [];
      }
      this.renderHistory();
    } catch(e) {}
    finally { this.finishProgress(); }
  },

  _destroyCharts() {
    if (!this._chartInstances) return;
    Object.values(this._chartInstances).forEach(c => { try{c.destroy()}catch(_){} });
    this._chartInstances = {};
  },

  // ── Run Detail (查看历史训练) ─────────────────────────
  async viewRunDetail(runDir) {
    /** 查看指定历史训练的详情（图表 + 日志 + 配置） */
    this.selectedRunDir = runDir;
    this.runDetailData = null;
    this.dashTab = 'overview';
    this.navigate('monitor-dashboard');
    // 等待 DOM 就绪后拉取数据
    await this.$nextTick();
    await this._fetchRunDetail(runDir);
  },

  async _fetchRunDetail(runDir) {
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/run-detail?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (j.status === 'success') {
        this.runDetailData = j.data;
        this.lossSeries = j.data.tensorboard_loss || [];
        this.trainParams = j.data.train_params || [];
        this.previews = j.data.previews || [];
        if (j.data.log_lines) this.logLines = j.data.log_lines;
        this.renderDashboard();
      } else {
        this.toast(j.message || 'Failed to load run detail');
      }
    } catch (e) {
      this.toast('Error loading run detail');
    } finally {
      this.finishProgress();
    }
  },

  clearRunDetail() {
    /** 返回实时监控模式 */
    this.selectedRunDir = null;
    this.runDetailData = null;
    // 强制刷新：先停止再重启轮询
    this.stopMonitorPolling();
    this.startMonitorPolling();
  }
};
