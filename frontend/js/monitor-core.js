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

  // ── Polling ────────────────────────────────────────────
  startMonitorPolling() {
    this.stopMonitorPolling(); this._monitorFirstFetch = true;
    this.fetchMonitorStatus();
    this.monitorTimer = setInterval(() => this.fetchMonitorStatus(), this.monitorPollMs);
  },
  stopMonitorPolling() {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    this._monitorFirstFetch = false; this._dashboardRendered = false; this._destroyCharts();
  },
  async fetchMonitorStatus() {
    try {
      const tid = this.taskId || '';
      const r = await fetch('/api/monitor/status?task_id='+encodeURIComponent(tid));
      const j = await r.json();
      if (j.status==='success') {
        this.monitorData = j.data; this.gpuInfo = j.data.gpu; this.sysInfo = j.data.system;
        this.lossSeries = j.data.tensorboard_loss||[]; this.trainParams = j.data.train_params||[];
        this.previews = j.data.previews||[]; if (j.data.log_lines) this.logLines = j.data.log_lines;
        if (j.data.state==='RUNNING') { this.isTraining=true; this.isIdle=false; this.statusText=j.data.state_label||j.data.state; }
        else if (j.data.state==='IDLE') { this.isTraining=false; this.isIdle=true; this.statusText='Idle'; }
        if (this.currentRoute==='monitor-dashboard') this.renderDashboard();
        if (this.currentRoute==='monitor-logs') this.renderLogs();
      }
      if (this._monitorFirstFetch) { this._monitorFirstFetch=false; this.finishProgress(); }
    } catch(e) { if (this._monitorFirstFetch) { this._monitorFirstFetch=false; this.finishProgress(); } }
  },

  // ── Log helpers ────────────────────────────────────────
  copyLogs() { navigator.clipboard.writeText(this.logLines.join('\n')).then(() => alert('Copied')); },
  clearLogs() { this.logLines = []; this.renderLogs(); },
  _escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; },

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
  }
};
