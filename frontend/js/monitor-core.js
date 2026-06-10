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
  chartSmoothing: 0.6, monitorTab: 'overview', _chartInstances: null,
  outputFiles: [], outputFilesLoading: false, outputFilesSelected: {},
  _monitorAbortCtrl: null,
  _prevState: null,
  _monitorRequestSeq: 0,  // 递增请求序列号，丢弃过期响应

  // ── SSE State ──────────────────────────────────────────
  _eventSource: null,
  _sseConnected: false,
  _sseRetryTimer: null,
  _sseRetryDelay: 3000,  // 固定重试延迟（毫秒）

  // ── History run detail ─────────────────────────────────
  selectedRunDir: null,   // 当前查看的历史训练 run_dir（null = 查看实时）
  runDetailData: null,    // 历史训练详情缓存

  // ── SSE Connection ─────────────────────────────────────
  connectMonitorSSE(taskId) {
    if (!taskId || this._eventSource) return;
    const url = '/api/monitor/stream?task_id=' + encodeURIComponent(taskId);
    try {
      const es = new EventSource(url);
      this._eventSource = es;

      es.addEventListener('status_change', (e) => {
        try { this.handleSSEStatusChange(JSON.parse(e.data)); } catch(_) {}
      });
      es.addEventListener('progress', (e) => {
        try { this.handleSSEProgress(JSON.parse(e.data)); } catch(_) {}
      });
      es.addEventListener('log_update', (e) => {
        try { this.handleSSELogUpdate(JSON.parse(e.data)); } catch(_) {}
      });
      es.addEventListener('hardware', (e) => {
        try { this.handleSSEHardware(JSON.parse(e.data)); } catch(_) {}
      });
      es.addEventListener('loss_update', (e) => {
        try { this.handleSSELossUpdate(JSON.parse(e.data)); } catch(_) {}
      });

      es.onopen = () => {
        this._sseConnected = true;
        if (this._sseRetryTimer) { clearTimeout(this._sseRetryTimer); this._sseRetryTimer = null; }
      };

      es.onerror = () => {
        this._sseConnected = false;
        es.close();
        this._eventSource = null;
        // 重试逻辑：固定间隔重试
        if (this._sseRetryTimer) clearTimeout(this._sseRetryTimer);
        this._sseRetryTimer = setTimeout(() => {
          this._sseRetryTimer = null;
          const currentTaskId = this.monitorData?.active_task?.id;
          if (currentTaskId && this.monitorData && this.monitorData.state === 'RUNNING') {
            this.connectMonitorSSE(currentTaskId);
          }
        }, this._sseRetryDelay);
      };
    } catch(_) {
      this._eventSource = null;
      this._sseConnected = false;
    }
  },

  disconnectMonitorSSE() {
    if (this._sseRetryTimer) { clearTimeout(this._sseRetryTimer); this._sseRetryTimer = null; }
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
    this._sseConnected = false;
  },

  handleTaskCompletion(prevState, newState) {
    if (prevState !== 'RUNNING' || newState === 'RUNNING') return;
    const msg = newState === 'FINISHED'
      ? (this.t('monitor.trainCompleted') || 'Training completed!')
      : (this.t('monitor.trainTerminated') || 'Training terminated');
    this.toast(msg, newState === 'FINISHED' ? 'success' : 'error');
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('lora-scripts-anima', { body: msg });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
    const origTitle = document.title;
    let flashCount = 0;
    const flashTimer = setInterval(() => {
      document.title = flashCount % 2 === 0 ? '✅ ' + msg : origTitle;
      flashCount++;
      if (flashCount >= 6) { clearInterval(flashTimer); document.title = origTitle; }
    }, 800);
  },

  handleSSEStatusChange(data) {
    if (!data) return;
    const prevState = this._prevState;
    this._prevState = data.status;
    this.handleTaskCompletion(prevState, data.status);
    if (prevState === 'RUNNING' && data.status !== 'RUNNING') {
      this.disconnectMonitorSSE();
    }
    if (data.status === 'RUNNING') { this.isTraining = true; this.isIdle = false; this.statusText = data.status_label || data.status; }
    else if (data.status === 'IDLE') { this.isTraining = false; this.isIdle = true; this.statusText = 'Idle'; }
    else if (data.status === 'FINISHED' || data.status === 'TERMINATED') { this.isTraining = false; this.isIdle = true; this.statusText = data.status_label || data.status; }
    if (this.currentRoute === 'monitor-dashboard') this.renderDashboard();
  },

  handleSSEProgress(data) {
    if (!data || !data.data || this.selectedRunDir) return;
    const progress = data.data;
    
    // 更新 monitorData 中的进度字段
    if (this.monitorData) {
      this.monitorData.step = progress.step;
      this.monitorData.total_steps = progress.total_steps;
      this.monitorData.percent = progress.percent;
      this.monitorData.loss = progress.loss;
      this.monitorData.lr = progress.lr;
      this.monitorData.epoch = progress.epoch;
      this.monitorData.eta = progress.eta;
      this.monitorData.speed = progress.speed;
    }
    if (this.currentRoute === 'monitor-dashboard') this.renderDashboard();
  },

  handleSSELogUpdate(data) {
    if (!data || !data.data || this.selectedRunDir) return;
    const logData = data.data;
    
    if (logData.lines && logData.lines.length > 0) {
      this.logLines.push(...logData.lines);
      
      // 限制日志行数
      if (this.logLines.length > this.logMaxLines) {
        this.logLines.splice(0, this.logLines.length - this.logMaxLines);
      }
      
      // 更新日志显示
      if (this.currentRoute === 'monitor-logs') {
        this.renderLogs();
      }
    }
  },

  handleSSEHardware(data) {
    if (!data || !data.data) return;
    const hw = data.data;
    
    if (hw.gpu) this.gpuInfo = hw.gpu;
    if (hw.system) this.sysInfo = hw.system;
    
    if (this.currentRoute === 'monitor-dashboard') {
      this.renderDashboard();
    }
  },

  handleSSELossUpdate(data) {
    if (!data || !data.points || this.selectedRunDir) return;

    const points = data.points;

    for (const [tag, newPoints] of Object.entries(points)) {
      if (!newPoints || !newPoints.length) continue;

      let series = this.lossSeries.find(s => s.tag === tag);
      if (!series) {
        series = {
          tag: tag,
          name: tag.replace(/\//g, ' ').replace(/_/g, ' '),
          points: [],
          latest: null,
          min: Infinity,
          max: -Infinity,
        };
        this.lossSeries.push(series);
      }

      for (const p of newPoints) {
        series.points.push(p);
        if (series.latest === null || p.value < series.min) series.min = p.value;
        if (series.latest === null || p.value > series.max) series.max = p.value;
        series.latest = p.value;
      }

      // 防止长时间训练导致内存无限增长（每 series 最多 5000 点）
      if (series.points.length > 5000) {
        series.points.splice(0, series.points.length - 5000);
      }

      if (this.monitorData) {
        if (tag === 'loss/current' || tag === 'loss/average') {
          const lastPt = newPoints[newPoints.length - 1];
          this.monitorData.loss = lastPt.value.toFixed(6);
        }
        if (tag === 'lr/unet') {
          const lastPt = newPoints[newPoints.length - 1];
          this.monitorData.lr = lastPt.value.toExponential ? lastPt.value.toExponential(4) : String(lastPt.value);
        }
      }
    }

    if (typeof this._updateCharts === 'function') {
      this._updateCharts();
    }
  },

  // ── Polling ────────────────────────────────────────────
  startMonitorPolling() {
    this.stopMonitorPolling(); this._monitorFirstFetch = true;
    this.fetchMonitorStatus();
    // 仅在 SSE 不可用时使用轮询作为降级方案
    this.monitorTimer = setInterval(() => {
      if (!this._sseConnected) this.fetchMonitorStatus();
    }, this.monitorPollMs);
  },
  stopMonitorPolling() {
    this.disconnectMonitorSSE();
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
          // SSE 连接时由增量推送管理 lossSeries，轮询仅做首次全量加载
          if (!this._sseConnected) {
            this.lossSeries = j.data.tensorboard_loss||[];
          }
          this.trainParams = j.data.train_params||[];
          this.previews = j.data.previews||[];
          if (j.data.log_lines) this.logLines = j.data.log_lines;
        }
        // Notification on training completion
        const prevState = this._prevState || null;
        this._prevState = j.data.state;
        this.handleTaskCompletion(prevState, j.data.state);
        if (j.data.state==='RUNNING') {
          this.isTraining=true; this.isIdle=false; this.statusText=j.data.state_label||j.data.state;
          // 首次获取状态后连接 SSE（如果尚未连接）
          if (!this._eventSource && !this._sseConnected) {
            this.connectMonitorSSE(tid);
          }
        }
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
    } catch(e) { this.toast(this.t('monitor.historyLoadError') || 'Failed to load history', 'error'); }
    finally { this.finishProgress(); }
  },

  _destroyCharts() {
    if (!this._chartInstances) return;
    Object.values(this._chartInstances).forEach(c => { try{c.destroy()}catch(_){} });
    this._chartInstances = {};
  },

  // ── Stop Training ─────────────────────────────────────
  async stopTraining() {
    if (!this.monitorData || !this.monitorData.active_task) return;
    const taskId = this.monitorData.active_task.id;
    if (!taskId) return;
    if (!confirm(this.t('monitor.confirmStop') || 'Are you sure you want to stop training?')) return;
    try {
      const r = await fetch('/api/monitor/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: taskId })
      });
      const j = await r.json();
      if (j.status === 'success') {
        this.toast(this.t('monitor.trainStopped') || 'Training stopped', 'success');
        this.fetchMonitorStatus();
      } else {
        this.toast(j.message || 'Failed to stop training', 'error');
      }
    } catch(e) {
      this.toast(this.t('monitor.stopFailed') || 'Failed to stop training', 'error');
    }
  },

  // ── Run Detail (查看历史训练) ─────────────────────────
  async viewRunDetail(runDir) {
    /** 查看指定历史训练的详情（图表 + 日志 + 配置） */
    this.selectedRunDir = runDir;
    this.runDetailData = null;
    this.monitorTab = 'overview';
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
  },

  // ── Output Files ──────────────────────────────────────
  async loadOutputFiles() {
    const taskId = this.monitorData?.active_task?.id || '';
    if (!taskId) {
      this.outputFiles = [];
      this.outputFilesSelected = {};
      return;
    }
    this.outputFilesLoading = true;
    try {
      const r = await fetch('/api/monitor/outputs?task_id=' + encodeURIComponent(taskId));
      const j = await r.json();
      if (j.status === 'success') {
        this.outputFiles = j.data || [];
        this.outputFilesSelected = {};
      }
    } catch (e) {
      this.outputFiles = [];
    } finally {
      this.outputFilesLoading = false;
      this._tabContentCache = {};
      this.renderDashboard();
    }
  },

  toggleOutputFile(path) {
    if (this.outputFilesSelected[path]) {
      delete this.outputFilesSelected[path];
    } else {
      this.outputFilesSelected[path] = true;
    }
    this._tabContentCache = {};
    this.renderDashboard();
  },

  selectAllOutputFiles() {
    this.outputFiles.forEach(f => { this.outputFilesSelected[f.path] = true; });
    this._tabContentCache = {};
    this.renderDashboard();
  },

  deselectAllOutputFiles() {
    this.outputFilesSelected = {};
    this._tabContentCache = {};
    this.renderDashboard();
  },

  get selectedOutputFiles() {
    return Object.keys(this.outputFilesSelected).filter(k => this.outputFilesSelected[k]);
  },

  async downloadSelectedOutputs() {
    const taskId = this.monitorData?.active_task?.id || '';
    if (!taskId) return;
    const selected = this.selectedOutputFiles;
    if (!selected.length) {
      this.toast(this.t('monitor.selectFilesFirst') || 'Please select files first');
      return;
    }
    const filesParam = selected.map(f => encodeURIComponent(f)).join(',');
    window.open('/api/monitor/outputs/download?task_id=' + encodeURIComponent(taskId) + '&files=' + filesParam);
  },

  async downloadAllOutputs() {
    const taskId = this.monitorData?.active_task?.id || '';
    if (!taskId) return;
    window.open('/api/monitor/outputs/download?task_id=' + encodeURIComponent(taskId));
  }

};
