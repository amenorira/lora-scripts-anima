/* ================================================================
   monitor-core.js — State, WebSocket events, history, outputs
   Mixin merged into animaApp Alpine component
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
  weakNetworkMode: true,
  _previewMediaQueue: [], _previewMediaAbort: null, _previewMediaLoading: false, _previewMediaPaused: false, _previewMediaObjectUrls: [], _previewMediaGeneration: 0,
  previewMetadataOpen: false, previewMetadataLoading: false, previewMetadata: null, previewMetadataError: '', _previewMetadataRequestSeq: 0, _previewMetadataAbort: null,
  configSnapshotOpen: false,
  previewReference: null,
  logAutoScroll: true, logLines: [],
  logSearch: '', logLevel: 'all', _logContentVersion: 0, monitorTab: 'overview',
  monitorParamQuery: '',
  outputFiles: [], outputFilesVersion: 0, outputFilesLoading: false, outputFilesSelected: {},
  outputFilesError: '', _outputFilesRunDir: '', _outputFilesRequestSeq: 0,
  _outputFilesKnownCount: 0,  // run-detail 首屏带回的输出文件计数（文件列表未加载时供 tab 徽标显示）
  outputSearch: '', outputFilter: 'all',
  outputModelSortKey: 'time', outputModelSortDir: 'desc',
  outputOtherSortKey: 'time', outputOtherSortDir: 'desc',
  _renderRAF: null,  // requestAnimationFrame 节流标记

  // ── 日志增量渲染状态 ──
  _renderedLogCount: 0,        // 已渲染到 DOM 的日志行数
  _renderedLogFilterKey: '',   // 已渲染时使用的 filter key（搜索+级别）
  _logAtBottom: true,          // 用户当前是否在底部（决定追加后是否滚底）
  _logDirty: false,            // 日志数据有变化（仅 log_update/clear/过滤/run-detail 置位；Fix3 用）
  _logTrimK: 0,                // 上次环形缓冲裁剪的头部行数（供滑窗删顶；Fix2 用）
  _logChunking: false,         // 分帧全量渲染进行中（防实时增量竞态；Fix1 用）

  // ── 完整日志模式（后端分页）状态 ──
  logMode: 'full',             // 'full'（完整日志, 后端分页, 默认）| 'tail'（实时尾部, 内存缓冲）
  logFullLines: [],            // 当前页行
  logFullOffset: 0,            // 当前页起始行号
  logFullTotal: 0,             // 文件总行数
  logFullMatches: [],          // 全文件搜索匹配行号
  logFullQuery: '',            // 当前搜索词
  logFullMatchIdx: -1,         // 当前定位的匹配在 logFullMatches 中的下标
  logFullLoading: false,
  logTotal: 0,                 // 完整日志总行数（run-detail 提供；live 由 full 模式探得）
  _logFullLoaded: false,       // full 模式末页是否已加载（首屏/重连自动拉取用）
  _logFullNeedsResync: false,  // 实时重连后需全量 resync（防丢事件）
  _logFullSlide: false,        // full 模式实时增量 slide 待执行
  _logFullEvictK: 0,           // full 模式 slide 删顶行数
  _logSliceRequestSeq: 0,      // 日志分页请求序号；切换实时/历史源时丢弃过期响应
  _logFullSourceKey: '',       // 当前完整日志缓冲所属的 task/run，切页时用于安全复用


  // ── 历史页筛选状态 ──
  historySearch: '', historyFilter: 'all',  // all|completed|failed|terminated

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

  setPreviewMediaPaused(paused) {
    this._previewMediaPaused = !!paused;
    if (paused) {
      this._cancelPreviewMediaQueue();
      return;
    }
    if (this.currentRoute !== 'monitor-dashboard' || this.monitorTab !== 'samples') return;
    const content = document.getElementById('monitorTabContent');
    if (content) this.schedulePreviewMediaLoads(content);
  },

  _cancelPreviewMediaQueue() {
    this._previewMediaGeneration++;
    for (const item of this._previewMediaQueue) delete item.image.dataset.previewQueued;
    if (this._previewMediaActive) delete this._previewMediaActive.dataset.previewQueued;
    this._previewMediaActive = null;
    if (this._previewMediaObserver) this._previewMediaObserver.disconnect();
    this._previewMediaObserver = null;
    this._previewMediaQueue = [];
    if (this._previewMediaAbort) this._previewMediaAbort.abort();
    this._previewMediaAbort = null;
    this._previewMediaLoading = false;
  },

  schedulePreviewMediaLoads(root) {
    if (!this.weakNetworkMode || this._previewMediaPaused || !root) return;
    const enqueue = image => {
      const url = image.dataset.previewUrl;
      if (!url || image.dataset.previewLoaded === '1' || image.dataset.previewQueued === '1') return;
      image.dataset.previewQueued = '1';
      this._previewMediaQueue.push({ image, url });
    };
    if (!this._previewMediaObserver && typeof IntersectionObserver !== 'undefined') {
      this._previewMediaObserver = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) enqueue(entry.target);
        this._drainPreviewMediaQueue();
      }, { rootMargin: '320px' });
    }
    const images = Array.from(root.querySelectorAll('img[data-preview-url]'));
    for (const image of images) {
      if (image.dataset.previewLoaded === '1') continue;
      if (this._previewMediaObserver) this._previewMediaObserver.observe(image);
      else enqueue(image);
    }
    this._drainPreviewMediaQueue();
  },

  async _drainPreviewMediaQueue() {
    if (this._previewMediaLoading || this._previewMediaPaused || !this.weakNetworkMode) return;
    const next = this._previewMediaQueue.shift();
    if (!next) return;
    const generation = this._previewMediaGeneration;
    this._previewMediaLoading = true;
    this._previewMediaActive = next.image;
    const controller = new AbortController();
    this._previewMediaAbort = controller;
    try {
      // `priority` is ignored by browsers that do not implement fetch priority;
      // serialisation and cancellation still provide the weak-link guarantee.
      const response = await fetch(next.url, { cache: 'default', signal: controller.signal, priority: 'low' });
      if (!response.ok) throw new Error('preview request failed');
      const blob = await response.blob();
      if (generation === this._previewMediaGeneration && next.image.isConnected && next.image.dataset.previewUrl === next.url && !this._previewMediaPaused) {
        const objectUrl = URL.createObjectURL(blob);
        this._previewMediaObjectUrls.push(objectUrl);
        next.image.src = objectUrl;
        next.image.dataset.previewLoaded = '1';
        if (this._previewMediaObserver) this._previewMediaObserver.unobserve(next.image);
      }
    } catch (_) {
      // Cancellation and transient slow-link failures remain retryable on the
      // next render or when realtime freshness recovers.
      if (next.image && next.image.isConnected) delete next.image.dataset.previewQueued;
    } finally {
      if (generation !== this._previewMediaGeneration || this._previewMediaAbort !== controller) return;
      this._previewMediaAbort = null;
      this._previewMediaActive = null;
      this._previewMediaLoading = false;
      if (!this._previewMediaPaused) this._drainPreviewMediaQueue();
    }
  },

  _releasePreviewMediaObjectUrls() {
    for (const url of this._previewMediaObjectUrls) URL.revokeObjectURL(url);
    this._previewMediaObjectUrls = [];
  },

  async togglePreviewMetadata() {
    this.previewMetadataOpen = !this.previewMetadataOpen;
    this._patchPreviewMetadataPanel();
    if (!this.previewMetadataOpen) return;
    const preview = this.previews[this.previewStep];
    if (!preview || !preview.metadata_url) return;
    const requestSeq = ++this._previewMetadataRequestSeq;
    if (this._previewMetadataAbort) this._previewMetadataAbort.abort();
    const controller = new AbortController();
    this._previewMetadataAbort = controller;
    this.previewMetadataLoading = true;
    this.previewMetadataError = '';
    this._patchPreviewMetadataPanel();
    try {
      const response = await fetch(preview.metadata_url, { cache: 'default', signal: controller.signal });
      const body = await response.json();
      if (requestSeq !== this._previewMetadataRequestSeq) return;
      if (body.status === 'success') this.previewMetadata = body.data;
      else this.previewMetadataError = body.message || this.t('common.failed');
    } catch (_) {
      if (requestSeq === this._previewMetadataRequestSeq) this.previewMetadataError = this.t('common.failed');
    } finally {
      if (requestSeq === this._previewMetadataRequestSeq) {
        this.previewMetadataLoading = false;
        if (this._previewMetadataAbort === controller) this._previewMetadataAbort = null;
        this._patchPreviewMetadataPanel();
      }
    }
  },

  _patchPreviewMetadataPanel() {
    const panel = document.getElementById('previewLightboxMetadata');
    const button = document.getElementById('previewLightboxMetadataButton');
    if (button) button.setAttribute('aria-expanded', this.previewMetadataOpen ? 'true' : 'false');
    if (!panel) return;
    panel.hidden = !this.previewMetadataOpen;
    if (!this.previewMetadataOpen) return;
    if (this.previewMetadataLoading) panel.textContent = this.t('monitor.loading');
    else if (this.previewMetadataError) panel.textContent = this.previewMetadataError;
    else if (this.previewMetadata) {
      const meta = this.previewMetadata;
      let html = '<p>' + this.esc([meta.format, meta.width + ' × ' + meta.height].filter(Boolean).join(' · ')) + '</p><dl>';
      for (const [key, value] of Object.entries(meta.png_text || {}).slice(0, 6)) html += '<dt>' + this.esc(key) + '</dt><dd>' + this.esc(String(value)) + '</dd>';
      panel.innerHTML = html + '</dl><details><summary>' + this.esc(this.t('monitor.rawMetadata')) + '</summary><pre>' + this.esc(JSON.stringify(meta, null, 2)) + '</pre></details>';
    } else panel.textContent = '';
  },

  _resetPreviewMetadata() {
    this._previewMetadataRequestSeq++;
    if (this._previewMetadataAbort) this._previewMetadataAbort.abort();
    this._previewMetadataAbort = null;
    this.previewMetadataOpen = false;
    this.previewMetadataLoading = false;
    this.previewMetadata = null;
    this.previewMetadataError = '';
    this._patchPreviewMetadataPanel();
  },

  _resetOutputFilesForRun(runDir) {
    this._outputFilesRequestSeq++;
    this._outputFilesRunDir = runDir || '';
    this.outputFiles = [];
    this.outputFilesVersion++;
    this.outputFilesSelected = {};
    this.outputFilesError = '';
    this.outputFilesLoading = false;
    this._outputFilesKnownCount = 0;
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
    this.liveTaskId = id;
    this.taskId = id;
    this.activeTaskId = id;
    this.liveTaskBoundaryAt = Date.now();
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
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  startTrainingStatePoll() {
    if (this._statePollTimer) return;
    const poll = async () => {
      await this._pollTrainingState();
      this._statePollTimer = setTimeout(poll, document.hidden ? 10000 : this.liveTaskId ? 1500 : 5000);
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
      const response = await fetch('/api/realtime/snapshot', { cache: 'no-store', signal: controller.signal });
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
      this.realtimeSnapshot = snapshot;
      // WS 掉线时资源圆环仍有数据（状态轮询顺带带回硬件采样）。
      if (!this.realtimeReady && snapshot.hardware) this.handleRealtimeHardware(snapshot.hardware);
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
      if (!this.selectedRunDir && this.currentRoute === 'monitor-dashboard') this._setMonitorRealtimeTask(active.id);
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

  applyRealtimeMonitorSnapshot(snapshot) {
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
      this.logFullTotal = 0;
      this.logFullMatches = [];
      this.logFullMatchIdx = -1;
      this._logFullLoaded = false;
      this._logFullNeedsResync = false;
      this._logFullSlide = false;
      this._logFullEvictK = 0;
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
    this.monitorData = next;
    if (next.gpu) this.gpuInfo = next.gpu;
    if (next.system) this.sysInfo = next.system;
    if (hasMonitorDetail) {
      this.lossSeries = Array.isArray(next.tensorboard_loss) ? next.tensorboard_loss : [];
      this.lossDataVersion++;
      this.trainParams = Array.isArray(next.train_params) ? next.train_params : [];
      this.trainParamsVersion++;
      this.logLines = Array.isArray(next.log_lines) ? next.log_lines.slice(-this._logCap()) : [];
      this._logContentVersion++;
      this._logDirty = true;
      this._logFullNeedsResync = this._logFullNeedsResync || !reusingFullLog;
      const wasAtEnd = this.previews.length === 0 || this.previewStep >= this.previews.length - 1;
      this.previews = Array.isArray(next.previews) ? next.previews : [];
      this.previewsVersion++;
      this._followLatestPreview(wasAtEnd);
    }
    const liveOutputRunDir = this.currentOutputRunDir;
    if (this._outputFilesRunDir && this._outputFilesRunDir !== liveOutputRunDir) {
      this._resetOutputFilesForRun(liveOutputRunDir);
    }

    // 生命周期状态（state/statusText/isTraining…）由轮询写入方负责，
    // 这里只回填快照携带的详情内容（曲线/日志/样本/参数/目录）。
    if (this.currentRoute === 'monitor-dashboard') {
      this.renderDashboard();
      this.finishProgress();
    }
  },

  resetRealtimeMonitorState() {
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
    this.gpuInfo = null;
    this.sysInfo = null;
    this.runningTask = null;
    this.taskId = null;
    if (this.selectedRunDir) {
      // Historical data is disk-backed and must remain readable across a
      // backend restart. Only the hidden live state above belongs to the old
      // in-memory server instance.
      if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
      return wasRunning;
    }
    this.lossSeries = [];
    this.lossDataVersion++;
    this.logLines = [];
    this.logFullLines = [];
    this.logFullOffset = 0;
    this.logFullTotal = 0;
    this.logTotal = 0;
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
    this.monitorData = {
      state: code,
      state_label: this.statusText,
      active_task: { id, status: code },
      run_dir: '',
      output_dir: '',
      detail: false,
    };
    this._logFullSourceKey = 'task:' + id;
    this._setMonitorRealtimeTask(id);
    if (this.currentRoute === 'monitor-dashboard') {
      this.renderDashboard();
      void this.refreshMonitorRealtimeDetail();
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
    if (!data || !data.data || this.selectedRunDir) return;
    const progress = data.data;

    // 只合并事件中实际存在的有效字段，避免增量日志用 null 清空旧状态。
    if (this.monitorData) {
      const fields = ['step', 'total_steps', 'percent', 'loss', 'lr', 'epoch', 'eta', 'elapsed', 'speed', 'has_error', 'error_msg'];
      fields.forEach(key => {
        if (Object.prototype.hasOwnProperty.call(progress, key) && progress[key] != null && progress[key] !== '') {
          this.monitorData[key] = progress[key];
        }
      });
    }
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  handleRealtimeTaskLog(data) {
    if (!data || !data.data || this.selectedRunDir) return;
    this._logEventVersion = (this._logEventVersion || 0) + 1;
    const logData = data.data;
    const newLines = logData.lines || [];
    const eventSourceKey = this._monitorRealtimeTopic || '';

    if (eventSourceKey && this._logFullSourceKey && this._logFullSourceKey !== eventSourceKey) {
      this._logSliceRequestSeq++;
      this.logFullLoading = false;
      this.logFullLines = [];
      this.logFullOffset = 0;
      this.logFullTotal = 0;
      this.logFullMatches = [];
      this.logFullMatchIdx = -1;
      this._logFullLoaded = false;
      this._logFullNeedsResync = true;
    }
    if (eventSourceKey) this._logFullSourceKey = eventSourceKey;

    if (newLines.length === 0) return;

    if (logData.truncated) {
      // A bounded WebSocket frame deliberately kept only the newest lines.
      // Rebuild the disk-backed page instead of pretending the missing range
      // was appended successfully.
      this._logFullNeedsResync = true;
      if (this.logMode === 'full') {
        if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'logs') this.scheduleRender();
        return;
      }
    }

    // ── full 模式实时增量：仅 live + 末页 + 跟随时 push 到当前页，slide 渲染 ──
    if (this.logMode === 'full') {
      // 非末页或未跟随 → 冻结视图，用户在浏览历史页（回末页时 followFullTail 会 resync）
      const atLastPage = this.logFullTotal === 0 || (this.logFullOffset + this.logFullLines.length >= this.logFullTotal);
      const following = this.logAutoScroll || this._logAtBottom;
      if (!atLastPage || !following) return;
      const cap = this._logPageSize();
      const merged = this._mergeRealtimeLogLines(this.logFullLines, newLines);
      if (!merged.changed) return;
      this.logFullTotal += merged.appended;
      if (merged.replaced) this._forceLogRebuild = true;
      // 超页裁顶（保持 DOM ≤ 一页），counterReset 随 offset 上移 → 绝对行号仍连续
      if (this.logFullLines.length > cap) {
        const k = this.logFullLines.length - cap;
        this.logFullLines.splice(0, k);
        this.logFullOffset += k;
        this._logFullEvictK += k;
      }
      this._logFullSlide = !this._forceLogRebuild;
      if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'logs') {
        this.scheduleRender();
      }
      return;
    }

    // ── tail 模式：环形缓冲 ──
    // A snapshot cursor is intentionally captured before the disk snapshot is
    // read, so a reconnect cannot skip a line written during that read. The
    // resulting replay can overlap the snapshot tail; remove that exact
    // suffix/prefix overlap before appending.
    const merged = this._mergeRealtimeLogLines(this.logLines, newLines);
    if (!merged.changed) return;
    if (merged.replaced) this._forceLogRebuild = true;
    const cap = this._logCap();
    if (this.logLines.length > cap) {
      const trimmed = this.logLines.length - cap;
      this._logTrimK += trimmed;
      this.logLines.splice(0, trimmed);
    }
    this._logContentVersion++;
    this._logDirty = true;

    // 仅实时尾部模式 + 当前在日志标签页时触发渲染
    if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'logs' && this.logMode === 'tail') {
      this.scheduleRender();
    }
  },

  handleRealtimeHardware(data) {
    if (!data) return;
    const hw = data;

    this.gpuInfo = hw.gpu || null;
    this.sysInfo = hw.system || null;

    if (this.currentRoute === 'monitor-dashboard') {
      this.scheduleRender();
    } else if (this.currentRoute === 'tagger' && typeof this.renderTaggerResourceBar === 'function') {
      this.renderTaggerResourceBar();
    }
  },

  handleRealtimeTaskMetrics(data) {
    if (!data || !data.points || this.selectedRunDir) return;

    if (data.truncated) {
      // The server intentionally bounded a delayed TensorBoard catch-up.
      // Rebuild the curve from the HTTP snapshot instead of displaying a
      // convincing but incomplete increment.
      this._refreshRealtimeSnapshot(this.realtimeInstanceId, null, { preserveSubscribedCursors: true });
    }

    const points = data.points;
    let changed = false;

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
        // 去重：重连后服务端若重放旧点，不把曲线追加成乱序或重复数据。
        if (series.points.length > 0 && Number(p.step) <= Number(series.points[series.points.length - 1].step)) continue;
        series.points.push(p);
        if (!series.diagnostic_points) series.diagnostic_points = [];
        series.diagnostic_points.push(p);
        if (series.diagnostic_points.length > 120) series.diagnostic_points.shift();
        changed = true;
        if (series.latest === null || p.value < series.min) { series.min = p.value; series.min_step = p.step; }
        if (series.latest === null || p.value > series.max) series.max = p.value;
        series.latest = p.value;
      }

      if (series.points.length > 5000) {
        series.points.splice(0, series.points.length - 5000);
        series.latest = series.points[series.points.length - 1].value;
      }

      if (this.monitorData) {
        if (tag === 'lr/unet') {
          const lastPt = newPoints[newPoints.length - 1];
          this.monitorData.lr = lastPt.value.toExponential ? lastPt.value.toExponential(4) : String(lastPt.value);
        }
      }
    }

    if (this.monitorData) {
      const loss = this.lossSeries.find(s => s.tag === 'loss/average') || this.lossSeries.find(s => s.tag === 'loss/current');
      if (loss && Number.isFinite(loss.latest)) this.monitorData.loss = loss.latest.toFixed(6);
    }

    if (changed) this.lossDataVersion++;
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  handleRealtimeTaskArtifacts(data) {
    // No one can see this list off the dashboard; defer its full metadata
    // refresh until the page is opened, where the detail snapshot hydrates it.
    if (!data || this.selectedRunDir || this.currentRoute !== 'monitor-dashboard') return;
    // The socket event is intentionally tiny. Load the cacheable metadata list
    // only after a real artifact notice, rather than repeatedly requesting it.
    const now = Date.now();
    if (now - this._lastRealtimePreviewRefreshAt < 500) return;
    this._lastRealtimePreviewRefreshAt = now;
    this.refreshPreviews();
    if (this.monitorTab === 'outputs') void this.loadOutputFiles();
    else this._outputFilesNeedsRefresh = true;
  },

  // ── Dashboard bootstrap + realtime subscriptions ───────
  startMonitorRealtime() {
    this.stopMonitorRealtime();
    this.realtimeSubscribe('hardware');
    if (!this.selectedRunDir) this._setMonitorRealtimeTask(this.liveTaskId);
    if (this.realtimeSnapshot) {
      this.applyRealtimeMonitorSnapshot(this.realtimeSnapshot);
      // Curves, progress and artifacts are refreshed from disk on entry. A
      // complete log page for the same task stays in memory so queued replay
      // can fill the page-switch gap without a later HTTP response replacing it.
      void this.refreshMonitorRealtimeDetail();
    }
    else {
      if (!this.monitorData) this.monitorData = { state: 'IDLE', state_label: this.t('monitor.idle') };
      this.renderDashboard();
    }
  },
  async refreshMonitorRealtimeDetail() {
    if (this.currentRoute !== 'monitor-dashboard') return;
    const runDir = this.currentOutputRunDir;
    if (!this.selectedRunDir && !this.liveTaskId && runDir) {
      const generation = ++this._monitorRealtimeDetailGeneration;
      try {
        const response = await fetch('/api/monitor/run-detail?run_dir=' + encodeURIComponent(runDir));
        const body = await response.json();
        if (generation !== this._monitorRealtimeDetailGeneration || this.selectedRunDir || this.liveTaskId || this.currentOutputRunDir !== runDir) return;
        if (body.status === 'success') {
          this.applyRealtimeMonitorSnapshot({ monitor: Object.assign({}, body.data, {
            detail: true, active_task: this.monitorData.active_task,
          }) });
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
    // Invalidate a detail request that is still fetching disk-backed data.
    const wasTailMode = this.logMode === 'tail';
    this._monitorRealtimeDetailGeneration++;
    this.realtimeUnsubscribe('hardware');
    this._setMonitorRealtimeTask(null);
    if (this._renderRAF) { cancelAnimationFrame(this._renderRAF); this._renderRAF = null; }
    this._dashboardRendered = false;
    this._shellBuilt = false;
    this._renderedLogCount = 0;
    this._renderedLogFilterKey = '';
    this._logDirty = false;
    this._logTrimK = 0;
    this._logChunking = false;
    this.logMode = 'full';
    if (wasTailMode) {
      // Tail mode does not keep the paged full-log buffer current. Returning
      // in full mode must therefore rebuild from disk instead of reusing it.
      this._logFullLoaded = false;
      this._logFullNeedsResync = true;
    }
    this._logFullSlide = false;
    this._logFullEvictK = 0;
    this._cancelPreviewMediaQueue();
    this._releasePreviewMediaObjectUrls();
    this._resetPreviewMetadata();
    if (typeof this.closePreviewLightbox === 'function') this.closePreviewLightbox();
  },

  // ── 预览样本刷新 ────────────────────────────────────────
  async refreshPreviews() {
    /** 主动重新拉取预览样本（绕过后端 5s 缓存），并自动跟随到最新一张。 */
    if (this.previewsLoading) return;
    this.previewsLoading = true;
    const sourceRunDir = this.currentOutputRunDir;
    const wasAtEnd = this.previews.length === 0 || this.previewStep >= this.previews.length - 1;
    try {
      // ``limit=0`` means all compact preview metadata. Image bytes continue
      // through the thumbnail queue (or normal browser loading when disabled).
      let url = '/api/monitor/previews?refresh=1&limit=0';
      const runDir = this.currentOutputRunDir;
      if (runDir) {
        url += '&run_dir=' + encodeURIComponent(runDir);
      } else if (this.taskId) {
        url += '&task_id=' + encodeURIComponent(this.taskId);
      }
      const r = await fetch(url);
      const j = await r.json();
      if (sourceRunDir !== this.currentOutputRunDir) return;
      if (j.status === 'success') {
        this.previews = j.data || [];
        this.previewsVersion++;
        if (j.meta) {
          const target = this.currentArtifactData();
          target.artifact_available = j.meta.artifact_available;
          if (j.meta.artifact_dir) target.artifact_dir = j.meta.artifact_dir;
          if (j.meta.preview_enabled !== undefined) target.preview_enabled = j.meta.preview_enabled;
        }
        this._followLatestPreview(wasAtEnd);
      }
    } catch (e) {
      /* 静默失败，不打扰用户 */
    } finally {
      this.previewsLoading = false;
      this.renderDashboard();
    }
  },

  // 预览列表更新后调整 previewStep：
  //   - 之前停在末尾（或为空）→ 跟随到新的末尾，确保最新样本第一时间可见
  //   - 否则保持当前选中（clamp 防越界）
  _followLatestPreview(wasAtEnd) {
    const n = this.previews.length;
    if (n === 0) { this.previewStep = 0; if (this.closePreviewLightbox) this.closePreviewLightbox(); return; }
    if (wasAtEnd) {
      this.previewStep = n - 1;
    } else if (this.previewStep > n - 1) {
      this.previewStep = n - 1;
    }
    const box = document.getElementById('previewLightbox');
    if (box && box.classList.contains('open')) this._updatePreviewLightbox();
  },

  _previewDisplayIndices() {
    const indices = this.previews.map((_, index) => index);
    return this.previewSortDir === 'desc' ? indices.reverse() : indices;
  },

  _patchPreviewSortOrder() {
    const content = document.getElementById('monitorTabContent');
    if (!content) return false;
    const grid = content.querySelector('.m-samples-section .preview-grid');
    if (!grid) return false;
    const items = new Map(Array.from(grid.querySelectorAll('.preview-grid-item')).map(item => [Number(item.dataset.previewIndex), item]));
    const headings = new Map(Array.from(grid.querySelectorAll('[data-preview-group]')).map(item => [item.dataset.previewGroup, item]));
    const seen = new Set();
    for (const index of this._previewDisplayIndices()) {
      const group = this._sampleMetadata(this.previews[index].name).stage;
      if (!seen.has(group) && headings.has(group)) { grid.appendChild(headings.get(group)); seen.add(group); }
      const item = items.get(index);
      if (item) grid.appendChild(item);
    }
    content.querySelectorAll('[data-preview-sort]').forEach(button => {
      const active = button.dataset.previewSort === this.previewSortDir;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    return true;
  },

  _sampleMetadata(filename) {
    const match = String(filename || '').match(/(?:^|_)(e?)(\d{6})_(\d{2})_/i);
    return match ? { stage: (match[1] ? 'Epoch ' : 'Step ') + Number(match[2]), prompt: 'Prompt ' + (Number(match[3]) + 1) } : { stage: '', prompt: '' };
  },

  setPreviewSort(dir) {
    if (dir !== 'asc' && dir !== 'desc') return;
    if (dir === this.previewSortDir) return;
    this.previewSortDir = dir;
    if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'samples' && this._patchPreviewSortOrder()) return;
    this.renderDashboard();
  },

  // ── History ────────────────────────────────────────────
  async loadHistory() {
    try {
      const r = await fetch('/api/monitor/history');
      const d = await r.json();
      if (d.status==='success') {
        this.runningTask = d.data.running || null;
        this.historyItems = d.data.history || [];
      }
    } catch(e) {
      this.toast(this.t('monitor.historyLoadError'), 'error');
    } finally {
      try { this.renderHistory(); } catch (e) {}
      this.finishProgress();
    }
  },

  get filteredHistoryItems() {
    const q = (this.historySearch||'').toLowerCase().trim();
    const filter = this.historyFilter || 'all';
    return (this.historyItems||[]).filter(h => {
      if (filter !== 'all' && (h.status||'') !== filter) return false;
      if (!q) return true;
      const hay = ((h.name||'') + ' ' + (h.model||'') + ' ' + (h.dataset||'') + ' ' + (h.time||'') + ' ' + (h.artifact_dir||'')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  },

  deleteHistoryRun(runDir) {
    if (!runDir) return;
    this.openConfirm(this.t('monitor.confirmDeleteRunTitle'), this.t('monitor.confirmDeleteRun'), () => this._deleteHistoryRun(runDir), this.t('common.confirm'), { danger: true });
  },

  async _deleteHistoryRun(runDir) {
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/history/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_dir: runDir })
      });
      const j = await r.json();
      if (j.status === 'success') {
        this.toast(this.t('monitor.runDeleted'), 'success');
        await this.loadHistory();
      } else {
        this.toast(j.message || this.t('monitor.deleteFailed'), 'error');
      }
    } catch(e) {
      this.toast(this.t('monitor.deleteFailed'), 'error');
    } finally { this.finishProgress(); }
  },

  // ── Run Detail (查看历史训练) ─────────────────────────
  async viewRunDetail(runDir) {
    /** 查看指定历史训练的详情（图表 + 日志 + 配置） */
    this._runDetailRequestSeq++;
    this._logSliceRequestSeq++;
    this.logLines = [];
    this.logTotal = 0;
    this.logFullLines = [];
    this.logFullOffset = 0;
    this.logFullTotal = 0;
    this.logFullMatches = [];
    this.logFullQuery = '';
    this.logFullMatchIdx = -1;
    this.logFullLoading = false;
    this._logFullSourceKey = 'run:' + runDir;
    this._logContentVersion++;
    this._logDirty = true;
    this.selectedRunDir = runDir;
    this.runDetailData = null;
    this.lossSeries = [];
    this.lossDataVersion++;
    this.trainParams = [];
    this.trainParamsVersion++;
    this.previews = [];
    this.previewsVersion++;
    this.runDetailLoading = true;
    this.runDetailError = '';
    this._resetOutputFilesForRun(runDir);
    this.monitorTab = 'overview';
    this.monitorParamQuery = '';
    this._shellBuilt = false;
    this._renderedLogCount = 0;
    this._renderedLogFilterKey = '';
    this._forceLogRebuild = true;
    this.navigate('monitor-dashboard');
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
        this._outputFilesRunDir = runDir;
        this.lossSeries = j.data.tensorboard_loss || [];
        this.lossDataVersion++;
        this.trainParams = j.data.train_params || [];
        this.trainParamsVersion++;
        this.previews = j.data.previews || [];
        this.previewsVersion++;
        this._outputFilesKnownCount = Number(j.data.output_count) || 0;
        // 历史记录进入时定位到最新样本（末尾）
        this.previewStep = this.previews.length ? this.previews.length - 1 : 0;
        // 后端已截断为尾部 _LOG_DETAIL_TAIL_LINES 行；slice(-cap) 防御性兜底
        this.logLines = Array.isArray(j.data.log_lines) ? j.data.log_lines.slice(-this._logCap()) : [];
        this.logTotal = Number.isFinite(Number(j.data.log_total)) ? Number(j.data.log_total) : this.logLines.length;
        this._logContentVersion++;
        this._logDirty = true;
        this._renderedLogCount = 0;
        this._renderedLogFilterKey = '';
        this._logTrimK = 0;
        this._forceLogRebuild = true;
        // 默认完整日志：末页 + 跟随（历史停在末尾；工具栏可翻页浏览全部）
        this.logMode = 'full';
        this._logFullLoaded = false;    // 新 run 首次渲染时自动拉取末页
        this._logFullNeedsResync = false;
        this._logFullSlide = false;
        this._logFullEvictK = 0;
        this.logFullLines = [];
        this.logFullLoading = false;
        // run-detail and log-slice share one normalized row definition, so the
        // count stays stable while the first full-log page is loading.
        this.logFullTotal = this.logTotal;
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
    this.lossSeries = [];
    this.lossDataVersion++;
    this.trainParams = [];
    this.trainParamsVersion++;
    this.monitorParamQuery = '';
    this.previews = [];
    this.previewsVersion++;
    this.previewStep = 0;
    this.outputFiles = [];
    this.outputFilesSelected = {};
    this.outputFilesError = '';
    this._outputFilesRunDir = '';
    this._outputFilesRequestSeq++;
    this._outputFilesKnownCount = 0;
    this.logLines = [];
    this.logFullLines = [];
    this.logFullOffset = 0;
    this.logFullTotal = 0;
    this.logFullMatches = [];
    this.logFullQuery = '';
    this.logFullMatchIdx = -1;
    this.logFullLoading = false;
    this._shellBuilt = false;
    this._renderedLogCount = 0;
    this._renderedLogFilterKey = '';
    this._logTrimK = 0;
    this._logDirty = true;
    this._forceLogRebuild = true;
    this.logMode = 'full';
    this._logFullLoaded = false;
    this._logFullNeedsResync = false;
    this._logFullSlide = false;
    this._logFullEvictK = 0;
    this._logFullSourceKey = '';
    this.logTotal = 0;
    this._logContentVersion++;
  },

  clearRunDetail() {
    /** 返回实时监控模式 */
    // Stop history-only subscriptions, then hydrate the live view from the
    // already-coherent realtime snapshot.
    this.stopMonitorRealtime();
    this.resetRunDetailState();
    this.renderDashboard();
    this.startMonitorRealtime();
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
    this.outputFilesLoading = true;
    this.outputFilesError = '';
    try {
      const r = await fetch('/api/monitor/outputs?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (requestSeq !== this._outputFilesRequestSeq || runDir !== this.currentOutputRunDir) return;
      if (j.status === 'success') {
        this.outputFiles = j.data || [];
        const paths = new Set(this.outputFiles.map(file => file.path));
        this.outputFilesSelected = Object.fromEntries(this.selectedOutputFiles.filter(path => paths.has(path)).map(path => [path, true]));
        this._outputFilesKnownCount = this.outputFiles.length;
        this.outputFilesError = '';
        const target = this.currentArtifactData();
        target.artifact_available = true;
        if (j.meta && j.meta.artifact_dir) target.artifact_dir = j.meta.artifact_dir;
      } else {
        this.outputFiles = [];
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

  // tab 徽标计数：文件列表已加载用真实长度，否则用 run-detail 首屏带回的计数
  get outputTabCount() {
    return this.outputFilesError ? 0 : (this.outputFiles.length || this._outputFilesKnownCount || 0);
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
  }

};
