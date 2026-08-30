/* ================================================================
   monitor-core.js — State, WebSocket events, history, outputs
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.monitorCoreMixin = {
  // ── State ──────────────────────────────────────────────
  monitorData: null,
  gpuInfo: null, sysInfo: null, lossSeries: [], lossDataVersion: 0, trainParams: [],
  previews: [], previewStep: 0, previewSortDir: 'asc', previewsLoading: false, historyItems: [], runningTask: null,
  weakNetworkMode: true,
  _previewMediaQueue: [], _previewMediaAbort: null, _previewMediaLoading: false, _previewMediaPaused: false, _previewMediaObjectUrls: [], _previewMediaGeneration: 0,
  previewMetadataOpen: false, previewMetadataLoading: false, previewMetadata: null, previewMetadataError: '', _previewMetadataRequestSeq: 0, _previewMetadataAbort: null,
  configSnapshotOpen: false,
  logAutoScroll: true, logLines: [],
  logSearch: '', logLevel: 'all', _logContentVersion: 0, monitorTab: 'overview',
  monitorParamQuery: '',
  outputFiles: [], outputFilesLoading: false, outputFilesSelected: {},
  outputFilesError: '', _outputFilesRunDir: '', _outputFilesRequestSeq: 0,
  _outputFilesKnownCount: 0,  // run-detail 首屏带回的输出文件计数（文件列表未加载时供 tab 徽标显示）
  outputSearch: '', outputFilter: 'all',
  outputModelSortKey: 'loss', outputModelSortDir: 'asc',
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
    const content = document.getElementById('monitorTabContent');
    if (content) this.schedulePreviewMediaLoads(content);
  },

  _cancelPreviewMediaQueue() {
    this._previewMediaGeneration++;
    this._previewMediaQueue = [];
    if (this._previewMediaAbort) this._previewMediaAbort.abort();
    this._previewMediaAbort = null;
    this._previewMediaLoading = false;
  },

  schedulePreviewMediaLoads(root) {
    if (!this.weakNetworkMode || this._previewMediaPaused || !root) return;
    const images = Array.from(root.querySelectorAll('img[data-preview-url]'));
    for (const image of images) {
      const url = image.dataset.previewUrl;
      if (!url || image.dataset.previewLoaded === '1' || image.dataset.previewQueued === '1') continue;
      image.dataset.previewQueued = '1';
      this._previewMediaQueue.push({ image, url });
    }
    this._drainPreviewMediaQueue();
  },

  async _drainPreviewMediaQueue() {
    if (this._previewMediaLoading || this._previewMediaPaused || !this.weakNetworkMode) return;
    const next = this._previewMediaQueue.shift();
    if (!next) return;
    const generation = this._previewMediaGeneration;
    this._previewMediaLoading = true;
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
      }
    } catch (_) {
      // Cancellation and transient slow-link failures remain retryable on the
      // next render or when realtime freshness recovers.
      if (next.image && next.image.isConnected) delete next.image.dataset.previewQueued;
    } finally {
      if (generation !== this._previewMediaGeneration || this._previewMediaAbort !== controller) return;
      this._previewMediaAbort = null;
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
    else panel.textContent = this.previewMetadata ? JSON.stringify(this.previewMetadata, null, 2) : '';
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

  handleRealtimeMonitorEvent(event) {
    if (!event) return;
    if (event.type === 'hardware.sample') {
      this.handleRealtimeHardware(event.payload);
      return;
    }
    if (!this._monitorRealtimeTopic || event.topic !== this._monitorRealtimeTopic) return;
    const payload = event.payload || {};
    if (event.type === 'task.status') this.handleRealtimeTaskStatus(payload);
    else if (event.type === 'task.progress') this.handleRealtimeTaskProgress(payload);
    else if (event.type === 'task.log') this.handleRealtimeTaskLog(payload);
    else if (event.type === 'task.metrics') this.handleRealtimeTaskMetrics(payload);
    else if (event.type === 'task.artifacts') this.handleRealtimeTaskArtifacts(payload);
    else if (event.type === 'task.result') this._refreshRealtimeSnapshot(this.realtimeInstanceId, null, { preserveSubscribedCursors: true });
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
    const snapshotTaskId = next.active_task && next.active_task.id || active && active.id || '';
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

    this.monitorData = next;
    if (next.gpu) this.gpuInfo = next.gpu;
    if (next.system) this.sysInfo = next.system;
    if (hasMonitorDetail) {
      this.lossSeries = Array.isArray(next.tensorboard_loss) ? next.tensorboard_loss : [];
      this.lossDataVersion++;
      this.trainParams = Array.isArray(next.train_params) ? next.train_params : [];
      this.logLines = Array.isArray(next.log_lines) ? next.log_lines.slice(-this._logCap()) : [];
      this._logContentVersion++;
      this._logDirty = true;
      this._logFullNeedsResync = this._logFullNeedsResync || !reusingFullLog;
      const wasAtEnd = this.previews.length === 0 || this.previewStep >= this.previews.length - 1;
      this.previews = Array.isArray(next.previews) ? next.previews : [];
      this._followLatestPreview(wasAtEnd);
    }
    const liveOutputRunDir = this.currentOutputRunDir;
    if (this._outputFilesRunDir && this._outputFilesRunDir !== liveOutputRunDir) {
      this._resetOutputFilesForRun(liveOutputRunDir);
    }

    this._setMonitorRealtimeTask(active && active.id);
    this._prevState = next.state;
    if (active) {
      this.trainingActive = true;
      this.isTraining = true;
      this.isIdle = false;
      this.statusText = next.state_label || active.status;
      this.realtimeTaskStateUnknown = false;
    } else if (!this.realtimeTaskStateUnknown) {
      this.trainingActive = false;
      this.isTraining = false;
      this.isIdle = true;
      this.statusText = this.t('monitor.idle');
    }
    if (this.currentRoute === 'monitor-dashboard') {
      this.renderDashboard();
      this.finishProgress();
    }
  },

  resetRealtimeMonitorState() {
    const wasRunning = !!(
      (this.monitorData && this.monitorData.state === 'RUNNING')
      || this._monitorRealtimeTopic
      || this.isTraining
      || this.runningTask
    );
    this._setMonitorRealtimeTask(null);
    this._prevState = null;
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
    this.logFullMatches = [];
    this._logFullSourceKey = '';
    this.trainParams = [];
    this.previews = [];
    this.previewStep = 0;
    this._resetOutputFilesForRun('');
    this._cancelPreviewMediaQueue();
    this._releasePreviewMediaObjectUrls();
    this._resetPreviewMetadata();
    this._logFullNeedsResync = true;
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
    return wasRunning;
  },

  handleTaskCompletion(prevState, newState) {
    if (prevState !== 'RUNNING' || newState === 'RUNNING') return;
    const msg = newState === 'FINISHED'
      ? this.t('monitor.trainCompleted')
      : this.t('monitor.trainTerminated');
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

  handleRealtimeTaskStatus(data) {
    if (!data) return;
    // A late terminal event from a previous task (e.g. its kill finishes
    // while a new task has already been started) must not overwrite the
    // new task's live state or fire the completion toast.
    const trackedId = this.activeTaskId || this.taskId;
    if (data.task_id && trackedId && data.task_id !== trackedId) return;
    const prevState = this._prevState;
    this._prevState = data.status;
    if (this.monitorData) {
      this.monitorData.state = data.status;
      this.monitorData.state_label = data.status_label || data.status;
    }
    this.handleTaskCompletion(prevState, data.status);
    if (data.status === 'RUNNING') {
      this.isTraining = true; this.isIdle = false; this.statusText = data.status_label || data.status;
      this.trainingActive = true;
      this.realtimeTaskStateUnknown = false;
    }
    else if (data.status === 'CREATED') {
      this.isTraining = true; this.isIdle = false;
      this.statusText = data.status_label || this.t('monitor.created');
      this.trainingActive = true;
      this.realtimeTaskStateUnknown = false;
    }
    else if (data.status === 'IDLE') { this.isTraining = false; this.isIdle = true; this.statusText = this.t('monitor.idle'); }
    else if (data.status === 'FINISHED' || data.status === 'TERMINATED' || data.status === 'FAILED') {
      this.isTraining = false; this.isIdle = true; this.statusText = data.status_label || data.status;
      this.trainingActive = false;
      // Final output/result details are hydrated from the HTTP bootstrap
      // snapshot, not placed in a potentially large WebSocket frame.
      this._refreshRealtimeSnapshot(this.realtimeInstanceId, null, { preserveSubscribedCursors: true });
    }
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
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
        this._logFullEvictK = k;
      }
      this._logFullSlide = !merged.replaced;
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
      this._logTrimK = this.logLines.length - cap;
      this.logLines.splice(0, this._logTrimK);
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

    if (hw.gpu) this.gpuInfo = hw.gpu;
    if (hw.system) this.sysInfo = hw.system;

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
        changed = true;
        if (series.latest === null || p.value < series.min) series.min = p.value;
        if (series.latest === null || p.value > series.max) series.max = p.value;
        series.latest = p.value;
      }

      if (series.points.length > 5000) {
        series.points.splice(0, series.points.length - 5000);
        series.min = Infinity;
        series.max = -Infinity;
        for (const p of series.points) {
          if (p.value < series.min) series.min = p.value;
          if (p.value > series.max) series.max = p.value;
        }
        series.latest = series.points[series.points.length - 1].value;
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
  },

  // ── Dashboard bootstrap + realtime subscriptions ───────
  startMonitorRealtime() {
    this.stopMonitorRealtime();
    this.realtimeSubscribe('hardware');
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
    const socket = this.realtimeSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
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
      && !(this.realtimeSnapshot.monitor && this.realtimeSnapshot.monitor.detail)) {
      const currentSocket = this.realtimeSocket;
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        await this._refreshRealtimeSnapshot(this.realtimeInstanceId, currentSocket, {
          monitorDetail: true,
          monitorDetailGeneration: generation,
          preserveSubscribedCursors: true,
        });
      }
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
  },

  // ── Log helpers ────────────────────────────────────────
  copyLogs() {
    const lines = this.logMode === 'full' ? (this.logFullLines || []) : (this.logLines || []);
    navigator.clipboard.writeText(lines.join('\n')).then(() => this.toast(this.t('common.copied')));
  },
  requestClearLogs() {
    this.openConfirm(this.t('monitor.confirmClearLogsTitle'), this.t('monitor.confirmClearLogs'), () => this.clearLogs(), this.t('common.confirm'), { danger: true });
  },
  clearLogs() {
    this.logLines = []; this._logContentVersion = 0;
    this._renderedLogCount = 0; this._renderedLogFilterKey = '';
    this._logDirty = true; this._logTrimK = 0; this._forceLogRebuild = true;
    this.renderDashboard();
  },

  // 内存缓冲上限 / 分页大小（取自 constants.js LOG）
  _logCap() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.MAX_LINES) || 5000; },
  _logPageSize() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.FULL_PAGE_SIZE) || 1000; },

  _tqdmProgressSignature(line) {
    const match = String(line || '').match(/^\s*steps:\s+\d+%\|.*\|\s*(\d+)\s*\/\s*(\d+)(?=\s*\[)/i);
    return match ? match[1] + '/' + match[2] : '';
  },

  _mergeRealtimeLogLines(target, incoming) {
    const lines = Array.isArray(incoming) ? incoming : [];
    let overlap = 0;
    const maxOverlap = Math.min(target.length, lines.length);
    for (let size = maxOverlap; size > 0; size--) {
      let matches = true;
      for (let index = 0; index < size; index++) {
        if (target[target.length - size + index] !== lines[index]) { matches = false; break; }
      }
      if (matches) { overlap = size; break; }
    }

    let appended = 0;
    let replaced = 0;
    for (const line of lines.slice(overlap)) {
      const signature = this._tqdmProgressSignature(line);
      const lastIndex = target.length - 1;
      if (signature && lastIndex >= 0 && signature === this._tqdmProgressSignature(target[lastIndex])) {
        if (target[lastIndex] !== line) {
          target[lastIndex] = line;
          replaced++;
        }
        continue;
      }
      target.push(line);
      appended++;
    }
    return { appended, replaced, overlap, changed: appended > 0 || replaced > 0 };
  },

  // ── 完整日志模式（后端分页）──────────────────────────────
  /** 当前完整日志模式定位日志的 run_dir（历史）或 task_id（实时） */
  _logSliceRunDir() { return this.selectedRunDir || null; },
  _logSliceTaskId() {
    if (this.selectedRunDir) return null;
    if (this.monitorData && this.monitorData.active_task) return this.monitorData.active_task.id || null;
    if (this.runningTask) return this.runningTask.id || null;
    return this.taskId || null;
  },
  _currentLogSourceKey() {
    const runDir = this._logSliceRunDir();
    if (runDir) return 'run:' + runDir;
    const taskId = this._logSliceTaskId();
    return taskId ? 'task:' + taskId : '';
  },
  /** 是否存在可拉取的实时/历史日志源（无训练且非历史模式时为 false） */
  _hasLogSource() { return !!this._currentLogSourceKey(); },

  /** 切换 tail/full 模式 */
  async setLogMode(mode) {
    if (mode === this.logMode) return;
    this.logMode = mode;
    this._renderedLogCount = 0;
    this._renderedLogFilterKey = '';
    this._forceLogRebuild = true;
    this._logFullSlide = false;
    this._logFullEvictK = 0;
    if (mode === 'full') {
      // 进入完整日志：末页 + 跟随（实时训练随 WebSocket 增量滚动；历史停在末尾）
      this.logAutoScroll = true;
      this._logAtBottom = true;
      this._logFullLoaded = true;       // setLogMode 自行拉取，标记已加载避免首屏重复拉
      this._logFullNeedsResync = false;
      this.logFullLoading = true;
      this.logFullLines = [];
      this.renderDashboard();           // 先渲染外壳 + Loading
      await this.fetchLogSlice({ tail: true });
      return;
    }
    // 切回 tail：恢复实时尾部缓冲视图
    this.logAutoScroll = true;
    this._logAtBottom = true;
    this._logDirty = true;
    this.renderDashboard();
  },

  /** 回到完整日志末尾并恢复跟随（实时增量刷新）。浏览历史页后用它回到 live 末尾。 */
  followFullTail(opts) {
    opts = opts || {};
    if (!this._hasLogSource()) {
      if (!opts.silent) this.toast(this.t('monitor.logSliceNoSource'), 'error');
      return;
    }
    this.logAutoScroll = true;
    this._logAtBottom = true;
    this._logFullNeedsResync = true;    // 触发 resync：重拉末页（补回浏览期间的新行）
    if (opts.fetchNow) {
      this._logFullNeedsResync = false;
      this._logFullLoaded = true;
      this.fetchLogSlice({ tail: true, silent: !!opts.silent });
      return;
    }
    this.renderDashboard();
  },

  /** 拉取完整日志分页：offset/tail/q 三选一驱动。
   *  opts.silent=true 时若无可拉取日志源则静默返回（不弹错误提示），
   *  用于进入日志标签时的自动末页拉取。用户主动点击工具栏按钮
   *  不传 silent，仍会在无源时给出 toast 反馈。 */
  async fetchLogSlice(opts) {
    opts = opts || {};
    const limit = this._logPageSize();
    const runDir = this._logSliceRunDir();
    const taskId = this._logSliceTaskId();
    if (!runDir && !taskId) {
      this.logFullLoading = false;
      if (!opts.silent) this.toast(this.t('monitor.logSliceNoSource'), 'error');
      return;
    }
    const requestSeq = ++this._logSliceRequestSeq;
    const sourceKey = runDir ? ('run:' + runDir) : ('task:' + taskId);
    const q = (opts.q !== undefined) ? opts.q : this.logFullQuery;
    let offset = this.logFullOffset;
    if (opts.offset !== undefined) offset = opts.offset;
    else if (opts.matchIdx !== undefined && this.logFullMatches.length && q === this.logFullQuery) {
      // 跳到指定匹配行所在页
      const m = this.logFullMatches[opts.matchIdx];
      offset = Math.floor(m / limit) * limit;
      this.logFullMatchIdx = opts.matchIdx;
    } else if (opts.tail) {
      offset = 0; // tail 由后端计算
    }
    this.logFullLoading = true;
    this.renderDashboard();
    const params = new URLSearchParams();
    if (runDir) params.set('run_dir', runDir);
    else params.set('task_id', taskId);
    params.set('offset', String(offset));
    params.set('limit', String(limit));
    params.set('q', q);
    if (opts.tail) params.set('tail', 'true');
    try {
      const r = await fetch('/api/monitor/log-slice?' + params.toString());
      const j = await r.json();
      const currentRunDir = this._logSliceRunDir();
      const currentTaskId = this._logSliceTaskId();
      const currentSourceKey = currentRunDir ? ('run:' + currentRunDir) : (currentTaskId ? ('task:' + currentTaskId) : '');
      if (requestSeq !== this._logSliceRequestSeq || sourceKey !== currentSourceKey) return;
      if (j.status === 'success' && j.data) {
        const d = j.data;
        const nextLines = d.lines || [];
        const nextMatches = d.match_indices || [];
        if (opts.matchIdx !== undefined && nextMatches.length && !opts._matchJumpResolved) {
          const idx = Math.max(0, Math.min(opts.matchIdx, nextMatches.length - 1));
          const target = nextMatches[idx];
          const pageEnd = d.offset + nextLines.length;
          if (target < d.offset || target >= pageEnd) {
            this.logFullMatches = nextMatches;
            this.logFullMatchIdx = idx;
            await this.fetchLogSlice({
              offset: Math.floor(target / limit) * limit,
              q,
              _matchIdx: idx,
              _matchJumpResolved: true,
            });
            return;
          }
        }
        this.logFullOffset = d.offset;
        this.logFullTotal = d.total;
        this.logFullLines = nextLines;
        this.logFullMatches = nextMatches;
        this.logFullQuery = q;
        this._logFullSourceKey = sourceKey;
        // 更新 logTotal（live 模式首次探得）
        if (!this.selectedRunDir) this.logTotal = d.total;
        if (opts._matchIdx !== undefined) {
          this.logFullMatchIdx = opts._matchIdx;
        } else if (opts.matchIdx === undefined) {
          // 非「跳匹配」操作：若当前 offset 落在某匹配所在页，定位到该页首个匹配
          const cur = this.logFullMatches.findIndex(mi => mi >= d.offset && mi < d.offset + this.logFullLines.length);
          this.logFullMatchIdx = cur;
        } else {
          this.logFullMatchIdx = Math.max(0, Math.min(opts.matchIdx, this.logFullMatches.length - 1));
        }
        this._forceLogRebuild = true;
      } else {
        if (!opts.silent) this.toast(j.message || this.t('monitor.logSliceError'), 'error');
      }
    } catch (e) {
      if (requestSeq !== this._logSliceRequestSeq) return;
      if (!opts.silent) this.toast(this.t('monitor.logSliceError'), 'error');
    } finally {
      if (requestSeq === this._logSliceRequestSeq) {
        this.logFullLoading = false;
        this.renderDashboard();
      }
    }
  },

  /** 完整日志搜索（全文件） */
  searchFullLog(q) {
    const query = (q !== undefined ? String(q) : '').trim();
    this.logAutoScroll = false;
    this._logAtBottom = false;
    if (!query) {
      this.logFullQuery = '';
      this.logFullMatches = [];
      this.logFullMatchIdx = -1;
      this.fetchLogSlice({ q: '' });
      return;
    }
    this.fetchLogSlice({ q: query, matchIdx: 0 });
  },

  /** 完整日志翻页 */
  async logFullFirstPage() {
    if (this.logFullLoading || this.logFullTotal <= 0) return;
    this.logAutoScroll = false;
    this._logAtBottom = false;
    if (this.logFullOffset > 0) await this.fetchLogSlice({ offset: 0 });
    requestAnimationFrame(() => this._scrollLogsToTop());
  },
  logFullLastPage() { this.followFullTail({ fetchNow: true }); },
  logFullPrevPage() { if (this.logFullOffset > 0) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: Math.max(0, this.logFullOffset - this._logPageSize()) }); } },
  logFullNextPage() { if (this.logFullOffset + this.logFullLines.length < this.logFullTotal) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: this.logFullOffset + this._logPageSize() }); } },
  /** 上一/下一匹配行 */
  logFullPrevMatch() {
    if (!this.logFullMatches.length) return;
    let idx = this.logFullMatchIdx;
    // 在当前页之前的最近匹配
    if (idx < 0) idx = this.logFullMatches.length;
    idx = idx - 1;
    if (idx < 0) idx = this.logFullMatches.length - 1;
    this.logAutoScroll = false; this._logAtBottom = false;
    this.fetchLogSlice({ matchIdx: idx });
  },
  logFullNextMatch() {
    if (!this.logFullMatches.length) return;
    let idx = this.logFullMatchIdx + 1;
    if (idx >= this.logFullMatches.length) idx = 0;
    this.logAutoScroll = false; this._logAtBottom = false;
    this.fetchLogSlice({ matchIdx: idx });
  },
  refreshFullLog() {
    // 保持当前 offset 重新拉取（文件可能已增长；offset 会被后端 clamp 到 total）
    this.fetchLogSlice({});
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
    if (n === 0) { this.previewStep = 0; return; }
    if (wasAtEnd) {
      this.previewStep = n - 1;
    } else if (this.previewStep > n - 1) {
      this.previewStep = n - 1;
    }
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
    for (const index of this._previewDisplayIndices()) {
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
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/run-detail?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (j.status === 'success') {
        this.runDetailData = j.data;
        this._outputFilesRunDir = runDir;
        this.lossSeries = j.data.tensorboard_loss || [];
        this.lossDataVersion++;
        this.trainParams = j.data.train_params || [];
        this.previews = j.data.previews || [];
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
        this.toast(j.message || this.t('monitor.loadRunFailed'));
      }
    } catch (e) {
      this.toast(this.t('monitor.runDetailError'));
    } finally {
      this.finishProgress();
    }
  },

  resetRunDetailState() {
    /** 清除历史运行详情及其派生缓存，防止返回实时监控后继续显示历史数据。 */
    this._logSliceRequestSeq++;
    this.selectedRunDir = null;
    this.runDetailData = null;
    this.lossSeries = [];
    this.lossDataVersion++;
    this.trainParams = [];
    this.monitorParamQuery = '';
    this.previews = [];
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
        this.outputFilesSelected = {};
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
        this._outputsDirty = true;
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
    this._outputsListDirty = true;
    this.renderDashboard();
  },

  selectAllOutputFiles() {
    this._visibleOutputFiles().forEach(f => { this.outputFilesSelected[f.path] = true; });
    this._outputsListDirty = true;
    this.renderDashboard();
  },

  deselectAllOutputFiles() {
    this.outputFilesSelected = {};
    this._outputsListDirty = true;
    this.renderDashboard();
  },

  get selectedOutputFiles() {
    return Object.keys(this.outputFilesSelected).filter(k => this.outputFilesSelected[k]);
  },

  // tab 徽标计数：文件列表已加载用真实长度，否则用 run-detail 首屏带回的计数
  get outputTabCount() {
    return this.outputFiles.length || this._outputFilesKnownCount || 0;
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
    requestAnimationFrame(() => {
      const input = document.querySelector('.m-output-search-input');
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
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
    if (!selected.length) {
      this.toast(this.t('monitor.selectFilesFirst'));
      return;
    }
    const filesParam = selected.map(f => encodeURIComponent(f)).join(',');
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir) + '&files=' + filesParam);
  },

  async downloadAllOutputs() {
    const runDir = this.currentOutputRunDir;
    if (!runDir) return;
    this._triggerDownload('/api/monitor/outputs/download?run_dir=' + encodeURIComponent(runDir));
  },

  downloadSingleOutput(path) {
    if (!path) return;
    const runDir = this.currentOutputRunDir;
    if (!runDir) return;
    this._triggerDownload('/api/monitor/outputs/download-file?run_dir=' + encodeURIComponent(runDir) + '&path=' + encodeURIComponent(path));
  }

};
