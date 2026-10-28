/* ================================================================
   monitor-core.js — Shared state, task lifecycle and realtime dispatch
   Mixin merged into animaApp Alpine component
   Previews, outputs, history and metrics compose into the same state owner.
   ================================================================ */

window.monitorCoreMixin = {
  ...window.monitorLogCoreMixin,
  // ── State ──────────────────────────────────────────────
  monitorData: null,
  selectedGpuIndex: 0,
  previewsVersion: 0, trainParamsVersion: 0,
  runDetailLoading: false, runDetailError: '',
  gpuInfo: null, sysInfo: null, lossSeries: [], lossDataVersion: 0, trainParams: [],
  previews: [], previewStep: 0, previewSortDir: 'desc', previewsLoading: false, historyItems: [], runningTask: null,
  _previewRequestSeq: 0,
  weakNetworkMode: true,
  _previewMediaQueue: [], _previewMediaAbort: null, _previewMediaLoading: false, _previewMediaPaused: false, _previewMediaObjectUrls: [], _previewMediaGeneration: 0,
  previewMetadataOpen: false, previewMetadataLoading: false, previewMetadata: null, previewMetadataError: '', _previewMetadataRequestSeq: 0, _previewMetadataAbort: null,
  configSnapshotOpen: false, configSnapshotLoading: false, configSnapshotError: '', configSnapshotRunDir: '',
  _currentSnapshot: null, _snapshotRequestSeq: 0, _snapshotAbort: null, _reuseRequestSeq: 0, _reuseAbort: null,
  historyReuseBusy: '', _historyReuseApplying: false,
  historyReuseSource: '', historyReuseWarning: '', _historyReuseUndo: null,
  previewReference: null,
  logAutoScroll: true, logLines: [],
  _logContentVersion: 0, monitorTab: 'overview',
  monitorParamQuery: '',
  outputFiles: [], outputFilesVersion: 0, outputFilesLoading: false, outputFilesSelected: {},
  outputFilesError: '', _outputFilesRunDir: '', _outputFilesRequestSeq: 0,
  _outputFilesKnownCount: 0, _outputCountVersion: 0,
  outputSearch: '', outputFilter: 'all',
  outputModelSortKey: 'time', outputModelSortDir: 'desc',
  outputOtherSortKey: 'time', outputOtherSortDir: 'desc',
  _renderRAF: null,  // requestAnimationFrame 节流标记

  // ── 日志增量渲染状态 ──
  _logAtBottom: true,          // 用户当前是否在底部（决定追加后是否滚底）

  // ── 完整日志模式（后端分页）状态 ──
  logFullLines: [],            // 当前页行
  logFullOffset: 0,            // 当前页起始行号
  logFullMatches: [],          // 全文件搜索匹配行号
  logFullQuery: '',            // 当前搜索词
  logFullMatchIdx: -1,         // 当前定位的匹配在 logFullMatches 中的下标
  logFullLoading: false,
  logTotal: 0,                 // 当前日志源的规范化总行数，独立于分页/尾部缓冲。
  _logTailOffset: 0,
  _logFullLoaded: false,       // full 模式末页是否已加载（首屏/重连自动拉取用）
  _logFullNeedsResync: false,  // 实时重连后需全量 resync（防丢事件）
  _logFullSlide: false,        // full 模式实时增量 slide 待执行
  _logSliceRequestSeq: 0,      // 日志分页请求序号；切换实时/历史源时丢弃过期响应
  _logFullSourceKey: '',       // 当前完整日志缓冲所属的 task/run，切页时用于安全复用

  // ── 历史页筛选状态 ──
  historySearch: '', historyFilter: 'all',  // all|completed|failed|terminated
  historyLoading: false, historyError: '', historyDeleting: '',
  _historyRequestSeq: 0, _historyTimer: null, _historyTaskSignature: null, _historyProgressPending: false,

  // ── 节流渲染：每帧最多渲染一次 Dashboard ──
  scheduleRender() {
    if (this._renderRAF) return; // 已有待处理的渲染
    this._renderRAF = requestAnimationFrame(() => {
      this._renderRAF = null;
      if (this.currentRoute === 'monitor-dashboard') {
        this.renderDashboard();
      }
    });
  },
  setMonitorTab(tab, focusTab) {
    const tabs = ['overview', 'logs', 'samples', 'outputs'];
    if (!tabs.includes(tab)) return;
    this.monitorTab = tab;
    if (this.selectedRunDir && window.location?.hash) {
      const hash = '#monitor-dashboard?run=' + encodeURIComponent(this.selectedRunDir) + '&tab=' + tab;
      window.history.replaceState(window.history.state, '', hash);
    }
    this.renderDashboard();
    if (focusTab) {
      requestAnimationFrame(() => {
        const tabEl = document.getElementById('monitor-tab-' + tab);
        if (tabEl) tabEl.focus();
      });
    }
  },
  moveMonitorTab(delta) {
    const tabs = ['overview', 'logs', 'samples', 'outputs'];
    const current = Math.max(0, tabs.indexOf(this.monitorTab));
    const next = (current + delta + tabs.length) % tabs.length;
    this.setMonitorTab(tabs[next], true);
  },
  _prevState: null,
  _lastRealtimePreviewRefreshAt: 0,

  // ── Realtime subscription state ────────────────────────
  _monitorRealtimeTopic: null,
  _monitorRealtimeDetailGeneration: 0,
  monitorPerfSamples: null,
  _monitorPerfVersion: 0,
  _monitorProgressVersion: 0,
  _monitorClockTimer: null,
  _monitorClockSample: null,

  get monitorLossSeries() {
    return this.selectedRunDir ? (this.runDetailData?.tensorboard_loss || []) : this.lossSeries;
  },

  // ── History run detail ─────────────────────────────────
  selectedRunDir: null,   // 当前查看的历史训练 run_dir（null = 查看实时）
  runDetailData: null,    // 历史训练详情缓存
  _runDetailRequestSeq: 0,

  // ── 当前输出文件列表对应的 run 目录（live 用 monitorData.output_dir，历史用 selectedRunDir）──
  get currentOutputRunDir() {
    if (this.selectedRunDir) return this.selectedRunDir;
    if (this.monitorData && (this.monitorData.run_dir || this.monitorData.output_dir)) {
      // 规范化为正斜杠相对路径
      let od = String(this.monitorData.run_dir || this.monitorData.output_dir).replace(/\\/g, '/').replace(/^\.\//, '');
      // 排除 output 根目录这种回退值（必须是 run 子目录才返回，如 output/<name>_<ts>）
      if (od && od !== 'output' && od !== './output' && od.indexOf('output/') === 0 && od.split('/').length >= 2) {
        return od;
      }
    }
    return '';
  },

  currentArtifactData() {
    return this.selectedRunDir ? (this.runDetailData || {}) : (this.monitorData || {});
  },

  _setMonitorRealtimeTask(taskId) {
    const next = taskId ? 'task:' + taskId : null;
    if (next === this._monitorRealtimeTopic) return;
    if (this._monitorRealtimeTopic) this.realtimeUnsubscribe(this._monitorRealtimeTopic);
    this._monitorRealtimeTopic = next;
    if (next) this.realtimeSubscribe(next);
  },

  // ── 训练状态所有权 ─────────────────────────────────────
  // 训练生命周期状态（在训/终态/空闲）只有一个事实来源：对
  // /api/realtime/snapshot 的串行轮询；也只有一个写入方：_applyTaskView。
  // WebSocket 只负责流式数据（日志/loss/硬件/进度），不做状态拼装，
  // 因此"旧任务迟到事件/过期快照覆盖新状态"这类问题在结构上不存在。
  liveTaskId: null,
  liveTaskBoundaryAt: 0,      // 最近一次所有权变更（claim/release）的本地时刻
  _statePollTimer: null,
  _statePollInFlight: false,

  claimLiveTask(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return;
    if (id !== this.liveTaskId) {
      // 历史浏览也会切换任务所有权；仅清理实时采样，不触碰正在查看的历史内容。
      this.monitorPerfSamples = [];
      this._monitorPerfVersion++;
      this.lossSeries = [];
      this.lossDataVersion++;
      this.monitorData = { active_task: { id }, detail: false, run_dir: '', output_dir: '' };
    }
    this.liveTaskId = id;
    this.taskId = id;
    this.activeTaskId = id;
    this.liveTaskBoundaryAt = Date.now();
    this._setMonitorRealtimeTask(id);
  },

  releaseLiveTask() {
    this.liveTaskId = null;
    this.taskId = null;
    this.activeTaskId = null;
    this.liveTaskBoundaryAt = Date.now();
  },

  // 训练状态的唯一写入方：侧栏（training mixin 字段）与仪表盘（monitorData）
  // 永远一起更新，不会出现两处各写各的导致的不同步。
  _applyTaskView(status, label) {
    const code = String(status || 'IDLE').toUpperCase();
    const active = code === 'CREATED' || code === 'RUNNING';
    this.trainingActive = active;
    this.trainingBlocked = active;
    this.isTraining = active;
    this.isIdle = !active;
    const keys = {
      CREATED: 'monitor.created', RUNNING: 'monitor.training',
      FINISHED: 'monitor.finished', TERMINATED: 'monitor.terminated',
      FAILED: 'monitor.error', UNKNOWN: 'monitor.taskStateUnknown', IDLE: 'monitor.idle',
    };
    this.statusText = label || (keys[code] ? this.t(keys[code]) : code);
    if (!this.monitorData || typeof this.monitorData !== 'object') this.monitorData = {};
    this.monitorData.state = code;
    this.monitorData.state_label = this.statusText;
    this._prevState = code;
    if (!this.selectedRunDir && this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  startTrainingStatePoll() {
    if (this._statePollTimer) return;
    const poll = async () => {
      await this._pollTrainingState();
      this._statePollTimer = setTimeout(poll, document.hidden ? 10000 : this.liveTaskId || this.regularizationActive ? 1500 : 5000);
    };
    this._statePollTimer = setTimeout(poll, 0);
  },

  async _pollTrainingState() {
    if (this._statePollInFlight) return;
    this._statePollInFlight = true;
    const requestedAt = Date.now();
    let timeout;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 4000);
      const response = await fetch('/api/realtime/state?hardware=' + !this.realtimeReady, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) return;
      const body = await response.json();
      if (body.status !== 'success' || !body.data) return;
      const snapshot = body.data;
      const nextId = snapshot.server_instance_id;
      if (nextId && this.realtimeInstanceId && nextId !== this.realtimeInstanceId) {
        this.realtimeInstanceId = nextId;
        this._saveRealtimeInstanceId();
        this._handleRealtimeServerRestart();
      }
      // WS 掉线时资源圆环仍有数据（状态轮询顺带带回硬件采样）。
      if (!this.realtimeReady && snapshot.hardware) this.handleRealtimeHardware(snapshot.hardware);
      if (typeof this.applyRegularizationActivity === 'function') this.applyRegularizationActivity(snapshot, requestedAt);
      this._applyManagedTrainingState(snapshot, requestedAt);
    } catch (_) {
      // 后端不可达：保持最后已知状态；连接指示由探针/WS 状态机负责。
    } finally {
      clearTimeout(timeout);
      this._statePollInFlight = false;
    }
  },

  _applyManagedTrainingState(snapshot, requestedAt) {
    // 快照只代表"取回前"的事实：所有权在本轮请求发出后才变过的，
    // 这份任务列表既不能证明新任务存在，也不能证明旧任务已结束。
    if (requestedAt != null && requestedAt < (this.liveTaskBoundaryAt || 0)) return;
    const managed = snapshot && snapshot.tasks && snapshot.tasks.managed || [];
    const historySignature = managed.filter(Boolean).map(task => task.id + ':' + task.status).join('|');
    if (this.currentRoute === 'history' && this._historyTaskSignature !== null && this._historyTaskSignature !== historySignature) {
      void this.loadHistory(true);
    }
    this._historyTaskSignature = historySignature;
    const active = managed.find(task => task && task.id
      && (task.status === 'CREATED' || task.status === 'RUNNING')) || null;
    const activeId = active ? active.id : '';
    const prevId = this.liveTaskId;

    if (activeId && activeId !== prevId) {
      // History owns the visible buffers, but must not freeze global training state.
      if (this.selectedRunDir) {
        this.claimLiveTask(activeId);
        this._applyTaskView(active.status);
        this.realtimeTaskStateUnknown = false;
        return;
      }
      // 任务边界（新启动/页面刷新恢复/他处启动）：清理上一轮残留并切换订阅。
      this.beginLiveMonitorTask(activeId, active.status);
      return;
    }
    if (!activeId && prevId) {
      // 拥有的任务已到终态。注册表只驱逐终态任务，所以"列表里没有"或
      // "已是终态"都可作为结算依据（终态事件丢失时由这里兜底）。
      const finished = managed.find(task => task && task.id === prevId) || null;
      const status = finished ? finished.status : 'IDLE';
      const prevStatus = this._prevState;
      this.releaseLiveTask();
      this._setMonitorRealtimeTask(null);
      this._applyTaskView(status);
      if (finished) this.handleTaskCompletion(prevStatus, finished.status);
      if (!this.selectedRunDir && this.currentRoute === 'monitor-dashboard') void this.refreshMonitorRealtimeDetail();
      return;
    }
    if (active) {
      // 同一任务：同步状态（如 CREATED → RUNNING），进度字段由 WS 流维护。
      this._applyTaskView(active.status);
      this._setMonitorRealtimeTask(active.id);
      this.realtimeTaskStateUnknown = false;
      return;
    }
    if (!this.realtimeTaskStateUnknown && !this.trainingStarting
      && (this.isTraining || this.trainingActive)) {
      // 没有任务却仍处于"训练中"视图：启动实际失败等场景，回到空闲。
      // 启动请求在途（trainingStarting）时不矫正，避免闪烁。
      this._applyTaskView('IDLE');
    }
  },

  handleRealtimeMonitorEvent(event) {
    if (!event) return;
    if (event.type === 'hardware.sample') {
      this.handleRealtimeHardware(event.payload);
      return;
    }
    if (!this._monitorRealtimeTopic || event.topic !== this._monitorRealtimeTopic) return;
    const payload = event.payload || {};
    // task.status / task.result 不在这里消费：生命周期状态由轮询统一结算，
    // 这里只处理流式增量（进度/日志/指标/产物）。
    if (event.type === 'task.progress') this.handleRealtimeTaskProgress(payload);
    else if (event.type === 'task.log') this.handleRealtimeTaskLog(payload);
    else if (event.type === 'task.metrics') this.handleRealtimeTaskMetrics(payload);
    else if (event.type === 'task.artifacts') this.handleRealtimeTaskArtifacts(payload);
  },

  handleRealtimeResyncRequired(topics) {
    if (this.selectedRunDir) return;
    const currentTopic = this._monitorRealtimeTopic;
    if (!Array.isArray(topics) || topics.length === 0 || (currentTopic && topics.includes(currentTopic))) {
      this._logFullNeedsResync = true;
    }
  },

  applyRealtimeMonitorSnapshot(snapshot, versions = null) {
    const hardware = snapshot && snapshot.hardware;
    if (hardware) this.handleRealtimeHardware(hardware);
    if (this.selectedRunDir) return;

    const monitor = snapshot && snapshot.monitor;
    if (!monitor) return;
    const managed = snapshot && snapshot.tasks && snapshot.tasks.managed || [];
    const active = managed.find(task => task && ['CREATED', 'RUNNING'].includes(task.status));
    const taskWasLostOnRestart = this.realtimeTaskStateUnknown && !active;
    const next = Object.assign({}, monitor);
    const hasMonitorDetail = next.detail === true || taskWasLostOnRestart;
    // Compact transport snapshots contain placeholder zeros, not progress.
    if (!hasMonitorDetail) return;
    const snapshotTaskId = next.active_task && next.active_task.id || active && active.id || '';
    // Transport idle does not erase the run the user is still inspecting.
    if (!snapshotTaskId && this.currentOutputRunDir && ['FINISHED', 'FAILED', 'TERMINATED'].includes(this.monitorData && this.monitorData.state)) return;
    if (this.liveTaskId && snapshotTaskId !== this.liveTaskId) return;
    const nextLogSourceKey = snapshotTaskId ? 'task:' + snapshotTaskId : '';
    const reusingFullLog = !!(
      nextLogSourceKey
      && this._logFullSourceKey === nextLogSourceKey
      && this._logFullLoaded
      && this.logFullLines.length
    );

    if (nextLogSourceKey && this._logFullSourceKey && this._logFullSourceKey !== nextLogSourceKey) {
      this._logSliceRequestSeq++;
      this.logFullLoading = false;
      this.logFullLines = [];
      this.logFullOffset = 0;
      this.logTotal = 0;
      this.logFullMatches = [];
      this.logFullMatchIdx = -1;
      this._logFullLoaded = false;
      this._logFullNeedsResync = false;
      this._logFullSlide = false;
    }
    if (nextLogSourceKey) this._logFullSourceKey = nextLogSourceKey;

    if (taskWasLostOnRestart) {
      // A fresh backend has no in-memory ownership of the old process. Do not
      // turn its absence into an idle/completed claim from disk state.
      next.state = 'UNKNOWN';
      next.state_label = this.t('monitor.taskStateUnknown');
      next.active_task = null;
      next.tensorboard_loss = [];
      next.log_lines = [];
      next.previews = [];
      next.train_params = [];
    }

    // HTTP detail must not overwrite lifecycle state owned by the task poll.
    if (this.monitorData && this.monitorData.state) {
      next.state = this.monitorData.state;
      next.state_label = this.monitorData.state_label;
    }
    const current = this.monitorData || {};
    const sameTask = !taskWasLostOnRestart && !!snapshotTaskId
      && snapshotTaskId === (current.active_task?.id || this.liveTaskId);
    const liveStep = Number(current.step) || 0, snapshotStep = Number(next.step) || 0;
    const progressChanged = versions?.progress != null && versions.progress !== this._monitorProgressVersion;
    if (sameTask && (liveStep > snapshotStep || (progressChanged && liveStep === snapshotStep))) {
      for (const key of ['step', 'total_steps', 'percent', 'loss', 'lr', 'epoch', 'eta', 'elapsed', 'speed']) {
        if (current[key] != null && current[key] !== '') next[key] = current[key];
      }
    }
    if (sameTask && current.has_error) {
      next.has_error = true;
      next.error_msg = current.error_msg || next.error_msg;
    }
    this.monitorData = next;
    this._observeMonitorClock(next);
    this._ingestMonitorPerfSamples(this._parseMonitorPerfLogs(next.log_lines));
    this._recordMonitorPerfSample(next);
    if (next.gpu) this.gpuInfo = next.gpu;
    if (next.system) this.sysInfo = next.system;
    if (hasMonitorDetail) {
      const incoming = Array.isArray(next.tensorboard_loss) ? next.tensorboard_loss : [];
      this.lossSeries = sameTask ? this._mergeMonitorMetricSnapshot(incoming) : incoming;
      next.tensorboard_loss = this.lossSeries;
      this.lossDataVersion++;
      this.trainParams = Array.isArray(next.train_params) ? next.train_params : [];
      this.trainParamsVersion++;
      if (!versions || versions.logs === (this._logObservationVersion || 0)) {
        this._applyMonitorLogSnapshot(next.log_lines, next.log_total, reusingFullLog);
      }
      if (!versions || versions.previews == null || versions.previews === this._previewRequestSeq) {
        const wasAtEnd = this.previews.length === 0 || this.previewStep >= this.previews.length - 1;
        this._invalidatePreviewRequest();
        this.previews = Array.isArray(next.previews) ? next.previews : [];
        this.previewsVersion++;
        this._followLatestPreview(wasAtEnd);
      } else next.previews = this.previews;
    }
    const liveOutputRunDir = this.currentOutputRunDir;
    if (!versions || versions.outputs === (this._outputCountVersion || 0)) this._applyOutputCount(liveOutputRunDir, next.output_count);

    // 生命周期状态（state/statusText/isTraining…）由轮询写入方负责，
    // 这里只回填快照携带的详情内容（曲线/日志/样本/参数/目录）。
    if (this.currentRoute === 'monitor-dashboard') {
      this.renderDashboard();
      this.finishProgress();
    }
  },

  resetRealtimeMonitorState() {
    this._invalidatePreviewRequest();
    if (typeof this.closePreviewLightbox === 'function') this.closePreviewLightbox();
    const wasRunning = !!(
      (this.monitorData && this.monitorData.state === 'RUNNING')
      || this._monitorRealtimeTopic
      || this.isTraining
      || this.runningTask
    );
    this._setMonitorRealtimeTask(null);
    this._prevState = null;
    this.releaseLiveTask();
    this.monitorData = { state: 'UNKNOWN', state_label: this.t('monitor.taskStateUnknown') };
    this._monitorClockSample = null;
    this.gpuInfo = null;
    this.sysInfo = null;
    this.runningTask = null;
    this.taskId = null;
    this.monitorPerfSamples = [];
    this._monitorPerfVersion++;
    this.lossSeries = [];
    this.lossDataVersion++;
    if (this.selectedRunDir) {
      // Historical data is disk-backed and must remain readable across a
      // backend restart. Only the hidden live state above belongs to the old
      // in-memory server instance.
      if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
      return wasRunning;
    }
    this.logLines = [];
    this.logFullLines = [];
    this.logFullOffset = 0;
    this.logTotal = 0;
    this._logTailOffset = 0;
    this.logFullMatches = [];
    this._logFullSourceKey = '';
    this.trainParams = [];
    this.trainParamsVersion++;
    this.previews = [];
    this.previewsVersion++;
    this.previewStep = 0;
    this._resetOutputFilesForRun('');
    this._cancelPreviewMediaQueue();
    this._releasePreviewMediaObjectUrls();
    this._resetPreviewMetadata();
    this._logFullNeedsResync = true;
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
    return wasRunning;
  },

  beginLiveMonitorTask(taskId, status) {
    /** Establish a new live-task boundary before any progress event arrives. */
    const id = String(taskId || '').trim();
    if (!id) return;
    const code = String(status || 'CREATED').toUpperCase();
    this._runDetailRequestSeq++;
    this.selectedRunDir = null;
    this.runDetailData = null;
    this.resetRealtimeMonitorState();
    this.claimLiveTask(id);
    this.realtimeTaskStateUnknown = false;
    this._applyTaskView(code);
    this.monitorData.active_task.status = code;
    this._logFullSourceKey = 'task:' + id;
    if (this.currentRoute === 'monitor-dashboard') {
      this.renderDashboard();
      if (!this.selectedRunDir) void this.refreshMonitorRealtimeDetail();
    }
  },

  handleTaskCompletion(prevState, newState) {
    if (!['RUNNING', 'CREATED'].includes(prevState) || !['FINISHED', 'FAILED', 'TERMINATED'].includes(newState)) return;
    const msg = this.t(newState === 'FINISHED' ? 'monitor.trainCompleted' : newState === 'FAILED' ? 'monitor.statusFailed' : 'monitor.trainTerminated');
    this.toast(msg, newState === 'FINISHED' ? 'success' : 'error');
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('lora-scripts-anima', { body: msg });
    }
    const origTitle = document.title;
    let flashCount = 0;
    const flashTimer = setInterval(() => {
      document.title = flashCount % 2 === 0 ? (newState === 'FINISHED' ? '✅ ' : '⚠ ') + msg : origTitle;
      flashCount++;
      if (flashCount >= 6) { clearInterval(flashTimer); document.title = origTitle; }
    }, 800);
  },

  handleRealtimeTaskProgress(data) {
    if (!data || !data.data) return;
    const progress = data.data;

    // 只合并事件中实际存在的有效字段，避免增量日志用 null 清空旧状态。
    if (this.monitorData) {
      let changed = false;
      const fields = ['step', 'total_steps', 'percent', 'loss', 'lr', 'epoch', 'eta', 'elapsed', 'speed', 'has_error', 'error_msg'];
      fields.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(progress, key) && progress[key] != null && progress[key] !== '') {
          if (this.monitorData[key] !== progress[key]) changed = true;
          this.monitorData[key] = progress[key];
        }
      });
      if (changed) this._monitorProgressVersion++;
      this._observeMonitorClock(this.monitorData);
      this._recordMonitorPerfSample(this.monitorData);
    }
    if (!this.selectedRunDir && this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  handleRealtimeTaskLog(data) {
    if (!data || !data.data) return;
    const logData = data.data;
    if (!Number.isInteger(logData.log_total) || logData.log_total < 0 || !Number.isInteger(logData.offset) || logData.offset < 0) return;
    this._ingestMonitorPerfSamples(this._parseMonitorPerfLogs(logData.lines));
    if (this.selectedRunDir) return;
    this._logObservationVersion = (this._logObservationVersion || 0) + 1;
    const eventSourceKey = this._monitorRealtimeTopic || '';

    if (eventSourceKey && this._logFullSourceKey && this._logFullSourceKey !== eventSourceKey) {
      this._logSliceRequestSeq++;
      this.logFullLoading = false;
      this.logLines = [];
      this.logTotal = 0;
      this._logTailOffset = 0;
      this.logFullLines = [];
      this.logFullOffset = 0;
      this.logFullMatches = [];
      this.logFullMatchIdx = -1;
      this._logFullLoaded = false;
      this._logFullNeedsResync = true;
    }
    if (eventSourceKey) this._logFullSourceKey = eventSourceKey;

    // 详情快照可能已经包含队列中的旧推送；总数不能被这类重放倒退。
    if (!logData.reset && logData.log_total < this.logTotal) return;
    const atLastPage = !this.logTotal || this.logFullOffset + this.logFullLines.length >= this.logTotal;
    const following = this.logAutoScroll || this._logAtBottom;
    if (logData.reset) {
      this._logSliceRequestSeq++;
      this.logFullLoading = false;
      this.logFullMatches = [];
      this.logFullMatchIdx = -1;
      this._logFullNeedsResync = false;
    }
    const tail = this._mergeRealtimeLogPage(this.logLines, this._logTailOffset, logData, this._logCap());
    this._logTailOffset = tail.offset;
    this.logTotal = logData.log_total;
    if (tail.changed) {
      this._logContentVersion++;
    }
    if (logData.truncated || tail.gap) this._logFullNeedsResync = true;

    // 总数始终更新；只有当前末页正在跟随时才移动分页内容。
    if ((atLastPage && following && !logData.truncated) || logData.reset) {
      const full = this._mergeRealtimeLogPage(this.logFullLines, this.logFullOffset, logData, this._logPageSize());
      this.logFullOffset = full.offset;
      if (logData.reset || full.gap) this._forceLogRebuild = true;
      if (full.gap) this._logFullNeedsResync = true;
      if (full.changed) this._logFullSlide = !this._forceLogRebuild;
    }
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  handleRealtimeHardware(data) {
    if (!data) return;
    const hw = data;

    this.gpuInfo = hw.gpu || null;
    this.sysInfo = hw.system || null;

    if (!this.selectedRunDir && this.currentRoute === 'monitor-dashboard') {
      this.scheduleRender();
    } else if (['tagger', 'ai-captioning'].includes(this.currentRoute) && typeof this.renderTaggerResourceBar === 'function') {
      this.renderTaggerResourceBar();
    } else if (this.currentRoute === 'regularization') {
      this.renderRegularizationResourceBar();
    }
  },


  handleRealtimeTaskArtifacts(data) {
    // No one can see this list off the dashboard; defer its full metadata
    // refresh until the page is opened, where the detail snapshot hydrates it.
    if (!data || this.selectedRunDir || this.currentRoute !== 'monitor-dashboard') return;
    // The socket event is intentionally tiny. Load the cacheable metadata list
    // only after a real artifact notice, rather than repeatedly requesting it.
    this._outputCountVersion++;
    this._applyOutputCount(this.currentOutputRunDir, data.output_count);
    this._outputFilesNeedsRefresh = true;
    this.scheduleRender();
    const now = Date.now();
    if (now - this._lastRealtimePreviewRefreshAt < 500) return;
    this._lastRealtimePreviewRefreshAt = now;
    this.refreshPreviews();
    if (this.monitorTab === 'outputs') void this.loadOutputFiles();
  },

  startMonitorRealtime() {
    this.stopMonitorRealtime();
    this._startMonitorClock();
    this.realtimeSubscribe('hardware');
    if (!this.selectedRunDir) this._setMonitorRealtimeTask(this.liveTaskId);
    if (!this.monitorData) this.monitorData = { state: 'IDLE', state_label: this.t('monitor.idle') };
    this.renderDashboard();
    if (this.realtimeSnapshot) {
      if (!this.monitorData?.detail) this.applyRealtimeMonitorSnapshot(this.realtimeSnapshot);
      // Curves, progress and artifacts are refreshed from disk on entry. A
      // complete log page for the same task stays in memory so queued replay
      // can fill the page-switch gap without a later HTTP response replacing it.
      void this.refreshMonitorRealtimeDetail();
    }
  },
  async refreshMonitorRealtimeDetail() {
    if (this.currentRoute !== 'monitor-dashboard' || this.selectedRunDir) return;
    const runDir = this.currentOutputRunDir;
    if (!this.selectedRunDir && !this.liveTaskId && runDir) {
      const generation = ++this._monitorRealtimeDetailGeneration;
      const versions = { logs: this._logObservationVersion || 0, outputs: this._outputCountVersion || 0, progress: this._monitorProgressVersion || 0, previews: this._previewRequestSeq };
      try {
        const response = await fetch('/api/monitor/run-detail?run_dir=' + encodeURIComponent(runDir));
        const body = await response.json();
        if (generation !== this._monitorRealtimeDetailGeneration || this.selectedRunDir || this.liveTaskId || this.currentOutputRunDir !== runDir) return;
        if (body.status === 'success') {
          this.applyRealtimeMonitorSnapshot({ monitor: Object.assign({}, body.data, {
            detail: true, active_task: this.monitorData.active_task,
          }) }, versions);
          this._logFullNeedsResync = true;
          this._outputFilesNeedsRefresh = true;
          this.renderDashboard();
        }
      } catch (_) { this.toast(this.t('monitor.loadRunFailed'), 'error'); }
      return;
    }
    // 详情是 HTTP 读取，不要求 WS 存活：隧道弱网下 WS 可能长期不可用，
    // 而状态轮询仍在工作。socket 在线时传入它作为过期判据，离线时传 null。
    const socket = this.realtimeSocket && this.realtimeSocket.readyState === WebSocket.OPEN
      ? this.realtimeSocket
      : null;
    const generation = ++this._monitorRealtimeDetailGeneration;
    await this._refreshRealtimeSnapshot(this.realtimeInstanceId, socket, {
      monitorDetail: true,
      monitorDetailGeneration: generation,
      preserveSubscribedCursors: true,
    });
    if (this.currentRoute !== 'monitor-dashboard' || generation !== this._monitorRealtimeDetailGeneration) return;
    // If this call joined a compact bootstrap already in flight, issue one
    // detail request after it settles instead of leaving the dashboard empty.
    if (this.currentRoute === 'monitor-dashboard'
      && generation === this._monitorRealtimeDetailGeneration
      && this.realtimeSnapshot
      && !(this.monitorData && this.monitorData.detail)) {
      await this._refreshRealtimeSnapshot(this.realtimeInstanceId, socket, {
        monitorDetail: true,
        monitorDetailGeneration: generation,
        preserveSubscribedCursors: true,
      });
    }
  },
  stopMonitorRealtime() {
    this._invalidatePreviewRequest();
    // Invalidate a detail request that is still fetching disk-backed data.
    if (this._monitorClockTimer) clearInterval(this._monitorClockTimer);
    this._monitorClockTimer = null;
    this._monitorRealtimeDetailGeneration++;
    this.realtimeUnsubscribe('hardware');
    // 任务订阅由训练生命周期管理；离开页面只暂停绘制，继续维护当前任务的曲线。
    if (this._renderRAF) { cancelAnimationFrame(this._renderRAF); this._renderRAF = null; }
    this._dashboardRendered = false;
    this._shellBuilt = false;
    this._logFullSlide = false;
    this._cancelPreviewMediaQueue();
    this._releasePreviewMediaObjectUrls();
    this._resetPreviewMetadata();
    if (typeof this.closePreviewLightbox === 'function') this.closePreviewLightbox();
  },

};

Object.defineProperties(window.monitorCoreMixin, Object.getOwnPropertyDescriptors(window.monitorPreviewsMixin));

Object.defineProperties(window.monitorCoreMixin, Object.getOwnPropertyDescriptors(window.monitorOutputsMixin));

Object.defineProperties(window.monitorCoreMixin, Object.getOwnPropertyDescriptors(window.monitorHistoryMixin));

Object.defineProperties(window.monitorCoreMixin, Object.getOwnPropertyDescriptors(window.monitorMetricsMixin));
