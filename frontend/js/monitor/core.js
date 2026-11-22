/* ================================================================
   monitor-core.js — Shared state, task lifecycle and realtime dispatch
   Mixin merged into animaApp Alpine component
   Previews, outputs, history and metrics compose into the same state owner.
   ================================================================ */

window.monitorCoreMixin = {
  // ── State ──────────────────────────────────────────────
  monitorData: null, monitorDetailError: false,
  previewsVersion: 0, trainParamsVersion: 0,
  runDetailLoading: false, runDetailError: '',
  gpuInfo: null, sysInfo: null, lossSeries: [], lossDataVersion: 0, trainParams: [],
  previews: [], previewStep: 0, previewsLoading: false, historyItems: [], runningTask: null,
  // Refresh ownership and cacheable snapshot freshness advance independently.
  _previewRequestSeq: 0, _previewSnapshotSeq: 0, _previewRefreshPending: false,
  weakNetworkMode: true,
  _previewMediaQueue: [], _previewMediaAbort: null, _previewMediaLoading: false, _previewMediaPaused: false, _previewMediaObjectUrls: [], _previewMediaGeneration: 0,
  configSnapshotOpen: false, configSnapshotLoading: false, configSnapshotError: '', configSnapshotRunDir: '',
  _currentSnapshot: null, _snapshotRequestSeq: 0, _snapshotAbort: null, _reuseRequestSeq: 0, _reuseAbort: null,
  historyReuseBusy: '', _historyReuseApplying: false,
  historyReuseSource: '', historyReuseWarning: '', historyResumeMeta: null, _historyReuseUndo: null,
  _historyCardPointer: null,
  logAutoScroll: true, monitorTab: 'overview',
  monitorChartMode: 'window',
  monitorChartShowLr: false,
  monitorParamQuery: '',
  monitorParamsExpanded: false,
  _monitorParamContext: null, _monitorParamCache: null,
  outputFiles: [], outputFilesVersion: 0, outputFilesLoading: false, outputFilesSelected: {}, _outputFilesLoaded: false,
  outputFilesError: '', _outputFilesRunDir: '', _outputFilesRequestSeq: 0,
  _outputFilesKnownCount: 0, _outputCountVersion: 0,
  outputSearch: '', outputFilter: 'all',
  outputModelSortKey: 'time', outputModelSortDir: 'desc',
  outputStateSortKey: 'time', outputStateSortDir: 'desc',
  outputOtherSortKey: 'time', outputOtherSortDir: 'desc',
  _renderRAF: null,  // requestAnimationFrame 节流标记

  // ── 日志增量渲染状态 ──
  _logAtBottom: true,          // 用户当前是否在底部（决定追加后是否滚底）

  // ── 完整日志模式（后端分页）状态 ──
  logFullLines: [],            // 当前页行
  logFullOffset: 0,            // 当前页起始行号
  logFullMatches: [],          // 全文件搜索匹配行号
  logFullQuery: '',            // 当前搜索词
  _logFullResultQuery: '',     // 已返回的匹配所属的搜索词
  logFullMatchIdx: -1,         // 当前定位的匹配在 logFullMatches 中的下标
  logFullLoading: false, logRefreshFeedback: false, _logRefreshFeedbackTimer: null,
  logTotal: 0,                 // 当前日志源的规范化总行数。
  _liveLogEnd: 0,              // 实时日志尾部行号，HTTP 翻页不更新。
  _logFullLoaded: false,       // full 模式末页是否已加载（首屏/重连自动拉取用）
  _logFullNeedsResync: false,  // 实时重连后需全量 resync（防丢事件）
  _logFullSlide: false,        // full 模式实时增量 slide 待执行
  _logSliceRequestSeq: 0,      // 日志分页请求序号；切换实时/历史源时丢弃过期响应
  _logFullSourceKey: '',       // 当前完整日志缓冲所属的 task/run，切页时用于安全复用

  // ── 历史页筛选状态 ──
  historySearch: '', historyFilter: 'all', historyPage: 1, historyPageSize: 30, historyFilteredCount: 0,
  historyLoading: false, historyRefreshing: false, historyRefreshFeedback: false,
  historyError: '', historyDeleting: '', _historyLoaded: false, _historyRefreshFeedbackTimer: null,
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

  // ── Realtime subscription state ────────────────────────
  _monitorRealtimeTopic: null,
  _monitorRealtimeDetailGeneration: 0,
  _monitorRealtimeDetailRequest: null,
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
    if (next && this.currentRoute === 'monitor-dashboard' && !this.selectedRunDir) this.realtimeSubscribe('artifacts');
    else this.realtimeUnsubscribe('artifacts');
    if (next === this._monitorRealtimeTopic) return;
    if (this._monitorRealtimeTopic) this.realtimeUnsubscribe(this._monitorRealtimeTopic);
    this._monitorRealtimeTopic = next;
    if (next) this.realtimeSubscribe(next);
  },

  // ── 训练状态所有权 ─────────────────────────────────────
  // 训练生命周期状态（在训/终态/空闲）只有一个事实来源：对
  // /api/realtime/state 的串行轮询；统一由 _applyTaskView 应用状态。
  // WebSocket 只负责流式数据（日志/loss/硬件/进度），不做状态拼装，
  // 迟到事件与过期响应仍需通过任务边界和请求版本检查后再应用。
  liveTaskId: null,
  liveTaskBoundaryAt: 0,      // 最近一次所有权变更（claim/release）的本地时刻
  _statePollTimer: null,
  _statePollInFlight: false,
  _statePollDiscard: false,

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
      FINISHED: 'monitor.finished', TERMINATED: 'monitor.terminated', STOPPED: 'control.stopped',
      FAILED: 'monitor.error', UNKNOWN: 'monitor.taskStateUnknown', IDLE: 'monitor.idle',
    };
    this.statusText = label || (keys[code] ? this.t(keys[code]) : code);
    if (!this.monitorData || typeof this.monitorData !== 'object') this.monitorData = {};
    const changed = this.monitorData.state !== code || this.monitorData.state_label !== this.statusText;
    this.monitorData.state = code;
    this.monitorData.state_label = this.statusText;
    this._prevState = code;
    if (changed && !this.selectedRunDir && this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  _scheduleTrainingStatePoll(delay) {
    clearTimeout(this._statePollTimer);
    this._statePollTimer = setTimeout(async () => {
      this._statePollTimer = null;
      try { await this._pollTrainingState(); }
      finally {
        const delay = document.hidden ? 10000 : this.liveTaskId || this.regularizationActive ? 1500 : 5000;
        this._scheduleTrainingStatePoll(delay);
      }
    }, delay);
  },

  _wakeTrainingStatePoll() {
    if (!this._statePollInFlight) this._scheduleTrainingStatePoll(0);
  },

  async _pollTrainingState() {
    if (this._statePollInFlight) return;
    this._statePollInFlight = true;
    this._statePollDiscard = false;
    const requestedAt = Date.now(), requestedInstanceId = this.realtimeInstanceId;
    let timeout, snapshot;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 4000);
      const url = '/api/realtime/state?hardware=' + !this.realtimeReady + (this.liveTaskId ? '&task_id=' + encodeURIComponent(this.liveTaskId) : '');
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('state request failed');
      const body = await response.json();
      if (body.status !== 'success' || !body.data) throw new Error('invalid state response');
      snapshot = body.data;
    } catch (_) { return; }
    finally {
      clearTimeout(timeout);
      this._statePollInFlight = false;
    }
    this._recordRealtimeHttpResult(true);
    const nextId = snapshot.server_instance_id;
    if (this.realtimeInstanceId !== requestedInstanceId && nextId !== this.realtimeInstanceId) return;
    const restarted = !!nextId && !!this.realtimeInstanceId && nextId !== this.realtimeInstanceId;
    const identified = !!nextId && !this.realtimeInstanceId;
    if (restarted || identified) {
      this.realtimeInstanceId = nextId;
      this._saveRealtimeInstanceId();
      if (restarted) this._handleRealtimeServerRestart();
    }
    // WS 掉线时资源圆环仍有数据（状态轮询顺带带回硬件采样）。
    if (!this.realtimeReady && snapshot.hardware) this.handleRealtimeHardware(snapshot.hardware);
    this.applyRegularizationActivity(snapshot, requestedAt);
    if (!this._statePollDiscard) this._applyManagedTrainingState(snapshot, requestedAt);
    if (restarted || (identified && (this.liveTaskId || !this.currentOutputRunDir))) void this.refreshMonitorRealtimeDetail();
  },

  _applyManagedTrainingState(snapshot, requestedAt) {
    // 任务归属在请求发出后发生变化时，跳过这份旧任务列表。
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
        this.applyTrainingControl?.(activeId, active.control || null);
        this.realtimeTaskStateUnknown = false;
        return;
      }
      // 任务边界（新启动/页面刷新恢复/他处启动）：清理上一轮残留并切换订阅。
      this.beginLiveMonitorTask(activeId, active.status);
      this.applyTrainingControl?.(activeId, active.control || null);
      return;
    }
    if (!activeId && prevId) {
      // 拥有的任务已到终态。注册表只驱逐终态任务，所以"列表里没有"或
      // "已是终态"都可作为结算依据（终态事件丢失时由这里兜底）。
      const finished = managed.find(task => task && task.id === prevId) || null;
      if (finished?.control) this.applyTrainingControl?.(prevId, finished.control);
      this.controlDialog = '';
      this.controlState = null;
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
      if (active.control) this.applyTrainingControl?.(activeId, active.control);
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
    if (event.topic === 'artifacts') {
      if (event.type === 'task.artifacts' && event.payload?.task_id === this.liveTaskId) {
        this.handleRealtimeTaskArtifacts(event.payload);
      }
      return;
    }
    if (!this._monitorRealtimeTopic || event.topic !== this._monitorRealtimeTopic) return;
    const payload = event.payload || {};
    // task.status / task.result 不在这里消费：生命周期状态由轮询统一结算，
    // 这里只处理流式增量（进度/日志/指标/产物）。
    if (event.type === 'task.progress') this.handleRealtimeTaskProgress(payload);
    else if (event.type === 'task.log') this.handleRealtimeTaskLog(payload);
    else if (event.type === 'task.metrics') this.handleRealtimeTaskMetrics(payload);
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
    if (!snapshotTaskId && this.currentOutputRunDir && ['FINISHED', 'FAILED', 'TERMINATED', 'STOPPED'].includes(this.monitorData && this.monitorData.state)) return;
    if (this.liveTaskId && snapshotTaskId !== this.liveTaskId) return;
    const nextLogSourceKey = snapshotTaskId ? 'task:' + snapshotTaskId : '';
    const reusingFullLog = !!(
      nextLogSourceKey
      && this._logFullSourceKey === nextLogSourceKey
      && this._logFullLoaded
      && this.logFullLines.length
    );

    if (nextLogSourceKey && this._logFullSourceKey && this._logFullSourceKey !== nextLogSourceKey) {
      this._resetLogPage();
      this._logSliceRequestSeq++;
      this.logFullLoading = false;
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
      if (!this._applyPreviewSnapshot(next.previews, versions?.previews ?? this._previewSnapshotSeq)) {
        next.previews = this.previews;
      }
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
    this.closePreviewLightbox();
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
    this._resetLogPage();
    this._logFullSourceKey = '';
    this.trainParams = [];
    this.trainParamsVersion++;
    this.previews = [];
    this.resetSampleBrowser?.();
    this.previewsVersion++;
    this.previewStep = 0;
    this._resetOutputFilesForRun('');
    this._cancelPreviewMediaQueue();
    this._releasePreviewMediaObjectUrls();
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
    const outcomes = {FINISHED: 'monitor.trainCompleted', FAILED: 'monitor.trainFailed', TERMINATED: 'monitor.trainTerminated', STOPPED: 'control.stopped'};
    if (!['RUNNING', 'CREATED'].includes(prevState) || !outcomes[newState]) return;
    const msg = this.t(outcomes[newState]);
    this.toast(msg, newState === 'FAILED' ? 'error' : 'info');
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('lora-scripts-anima', { body: msg });
    }
    const origTitle = document.title;
    let flashCount = 0;
    const flashTimer = setInterval(() => {
      document.title = flashCount % 2 === 0 ? msg : origTitle;
      flashCount++;
      if (flashCount >= 6) { clearInterval(flashTimer); document.title = origTitle; }
    }, 800);
  },

  handleRealtimeTaskProgress(data) {
    if (!data || !data.data) return;
    const progress = data.data;
    if (progress.step != null && this.monitorData?.step > progress.step) return;

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
      this._resetLogPage();
      this._logSliceRequestSeq++;
      this.logFullLoading = false;
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
      this._logFullResultQuery = '';
      this.logFullMatchIdx = -1;
      this._logFullNeedsResync = false;
    }
    const gap = logData.offset > this._liveLogEnd;
    this._liveLogEnd = logData.log_total;
    this.logTotal = logData.log_total;
    if (logData.truncated || gap) this._logFullNeedsResync = true;

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
    } else if (['tagger', 'ai-captioning'].includes(this.currentRoute)) {
      this.renderTaggerResourceBar();
    } else if (this.currentRoute === 'regularization') {
      this.renderRegularizationResourceBar();
    }
  },


  handleRealtimeTaskArtifacts(data) {
    // No one can see this list off the dashboard; defer its full metadata
    // refresh until the page is opened, where the detail snapshot hydrates it.
    if (!data || this.selectedRunDir || this.currentRoute !== 'monitor-dashboard') return;
    // Keep the socket payload small. Fetch the cacheable metadata list when an
    // artifact event arrives.
    this._outputCountVersion++;
    this._applyOutputCount(this.currentOutputRunDir, data.output_count);
    this._outputFilesNeedsRefresh = true;
    this.scheduleRender();
    if (data.previews_changed !== false) this._previewRefreshPending = true;
    if (this._previewRefreshPending && !this.previewsLoading) void this.refreshPreviews(false);
  },

  startMonitorRealtime() {
    this.stopMonitorRealtime();
    this._startMonitorClock();
    this.realtimeSubscribe('hardware');
    if (!this.selectedRunDir) this._setMonitorRealtimeTask(this.liveTaskId);
    if (!this.monitorData) this.monitorData = { state: 'IDLE', state_label: this.t('monitor.idle') };
    this.renderDashboard();
    // HTTP detail also works when the socket has never connected.
    void this.refreshMonitorRealtimeDetail();
  },
  async refreshMonitorRealtimeDetail(afterPending = false) {
    if (this.currentRoute !== 'monitor-dashboard' || this.selectedRunDir) return;
    const runDir = this.currentOutputRunDir;
    const taskId = this.liveTaskId, boundary = this.liveTaskBoundaryAt;
    const historical = !taskId && runDir;
    const instanceId = historical ? null : this.realtimeInstanceId;
    const key = JSON.stringify([instanceId, taskId, runDir, boundary]);
    const pending = this._monitorRealtimeDetailRequest;
    if (pending && pending.key === key && pending.generation === this._monitorRealtimeDetailGeneration) {
      if (!afterPending) return pending.promise;
      pending.followup ||= pending.promise.then(() => {
        if (pending.generation === this._monitorRealtimeDetailGeneration) return this.refreshMonitorRealtimeDetail();
      });
      return pending.followup;
    }
    if (pending) pending.controller.abort();
    const generation = ++this._monitorRealtimeDetailGeneration;
    this.monitorDetailError = false;
    const versions = { logs: this._logObservationVersion || 0, outputs: this._outputCountVersion || 0, progress: this._monitorProgressVersion || 0, previews: this._previewSnapshotSeq };
    const request = { key, generation, controller: new AbortController(), promise: null };
    const isCurrent = () => this.currentRoute === 'monitor-dashboard' && !this.selectedRunDir
      && generation === this._monitorRealtimeDetailGeneration && this.liveTaskId === taskId
      && this.liveTaskBoundaryAt === boundary && this.currentOutputRunDir === runDir
      && (historical || this.realtimeInstanceId === instanceId);
    request.promise = (async () => {
      const url = historical ? '/api/monitor/run-detail?run_dir=' + encodeURIComponent(runDir)
        : '/api/realtime/monitor-detail';
      const timeout = historical ? null : setTimeout(() => request.controller.abort(), 10000);
      let body;
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await fetch(url, { signal: request.controller.signal });
            body = await response.json();
            if (!response.ok || body.status !== 'success' || !body.data) throw new Error('monitor detail unavailable');
            break;
          } catch (error) {
            if (attempt || !isCurrent() || request.controller.signal.aborted) throw error;
          }
        }
      } catch (_) {
        if (isCurrent()) { this.monitorDetailError = true; this.finishProgress(); }
        return;
      } finally {
        if (timeout) clearTimeout(timeout);
        if (this._monitorRealtimeDetailRequest?.generation === generation) this._monitorRealtimeDetailRequest = null;
      }
      if (!isCurrent()) return;
      if (historical) {
        this.applyRealtimeMonitorSnapshot({ monitor: Object.assign({}, body.data, {
          detail: true, active_task: this.monitorData.active_task,
        }) }, versions);
        this._logFullNeedsResync = true;
        this._outputFilesNeedsRefresh = true;
        this.renderDashboard();
      } else if (!instanceId || body.data.server_instance_id === instanceId) {
        this.applyRealtimeMonitorSnapshot(body.data, versions);
      }
    })();
    this._monitorRealtimeDetailRequest = request;
    return request.promise;
  },
  stopMonitorRealtime() {
    this.monitorDetailError = false;
    this._invalidatePreviewRequest();
    this._sampleLayoutAction++;
    this._cancelSampleGridMotion?.(this._sampleOverviewPanel?.()?.querySelector('.preview-grid'));
    this._disconnectSampleExpansionUI?.();
    // Invalidate a detail request that is still fetching disk-backed data.
    if (this._monitorClockTimer) clearInterval(this._monitorClockTimer);
    this._monitorClockTimer = null;
    this._monitorRealtimeDetailGeneration++;
    this._monitorRealtimeDetailRequest?.controller.abort();
    this.realtimeUnsubscribe('hardware');
    this.realtimeUnsubscribe('artifacts');
    // 任务订阅由训练生命周期管理；离开页面只暂停绘制，继续维护当前任务的曲线。
    if (this._renderRAF) { cancelAnimationFrame(this._renderRAF); this._renderRAF = null; }
    this._dashboardRendered = false;
    this._shellBuilt = false;
    this._logFullSlide = false;
    this._cancelPreviewMediaQueue();
    this._releasePreviewMediaObjectUrls();
    this.closePreviewLightbox();
  },

};

window.composeAppMixins(window.monitorCoreMixin, { logs: window.monitorLogCoreMixin, previews: window.monitorPreviewsMixin });

window.composeAppMixins(window.monitorCoreMixin, { monitorOutputsMixin: window.monitorOutputsMixin });

window.composeAppMixins(window.monitorCoreMixin, { monitorHistoryMixin: window.monitorHistoryMixin });

window.composeAppMixins(window.monitorCoreMixin, { monitorMetricsMixin: window.monitorMetricsMixin });
