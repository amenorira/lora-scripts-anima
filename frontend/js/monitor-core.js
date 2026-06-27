/* ================================================================
   monitor-core.js — State, polling, SSE, history, outputs
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.monitorCoreMixin = {
  // ── State ──────────────────────────────────────────────
  monitorData: null, monitorTimer: null, monitorPollMs: 2000,
  gpuInfo: null, sysInfo: null, lossSeries: [], trainParams: [],
  previews: [], previewStep: 0, historyItems: [], runningTask: null,
  logAutoScroll: true, logLines: [],
  logSearch: '', logLevel: 'all', _logContentVersion: 0, monitorTab: 'overview',
  outputFiles: [], outputFilesLoading: false, outputFilesSelected: {},
  outputSortKey: 'loss', outputSortDir: 'asc',  // 模型存档排序：loss|time|size|name，asc|desc
  _monitorAbortCtrl: null,
  _renderRAF: null,  // requestAnimationFrame 节流标记

  // ── 日志增量渲染状态 ──
  _renderedLogCount: 0,        // 已渲染到 DOM 的日志行数
  _renderedLogFilterKey: '',   // 已渲染时使用的 filter key（搜索+级别）
  _logAtBottom: true,          // 用户当前是否在底部（决定追加后是否滚底）
  _logDirty: false,            // 日志数据有变化（仅 log_update/clear/过滤/run-detail 置位；Fix3 用）
  _logTrimK: 0,                // 上次环形缓冲裁剪的头部行数（供滑窗删顶；Fix2 用）
  _logChunking: false,         // 分帧全量渲染进行中（防 SSE 增量竞态；Fix1 用）

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
  _logFullNeedsResync: false,  // SSE 重连后需全量 resync（防丢事件）
  _logFullSlide: false,        // full 模式实时增量 slide 待执行
  _logFullEvictK: 0,           // full 模式 slide 删顶行数


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

  // ── 当前输出文件列表对应的 run 目录（live 用 monitorData.output_dir，历史用 selectedRunDir）──
  get currentOutputRunDir() {
    if (this.selectedRunDir) return this.selectedRunDir;
    if (this.monitorData && this.monitorData.output_dir) {
      // 规范化为正斜杠相对路径
      let od = String(this.monitorData.output_dir).replace(/\\/g, '/').replace(/^\.\//, '');
      // 排除 output 根目录这种回退值（必须是 run 子目录才返回，如 output/<name>_<ts>）
      if (od && od !== 'output' && od !== './output' && od.indexOf('output/') === 0 && od.split('/').length >= 2) {
        return od;
      }
    }
    return '';
  },

  // ── SSE Connection ─────────────────────────────────────
  connectMonitorSSE(taskId) {
    if (!taskId || this._eventSource) return;
    // 清空 lossSeries，避免 SSE 重连后产生重复数据点
    this.lossSeries = [];
    this._sseTaskId = taskId;
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
        // 重连后 full 模式末页可能漏了断线期间的日志 → 标记需全量 resync
        this._logFullNeedsResync = true;
        if (this._monitorAbortCtrl) { this._monitorAbortCtrl.abort(); this._monitorAbortCtrl = null; }
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
          // Use saved task ID instead of potentially stale monitorData
          const reconnectTaskId = this._sseTaskId || this.monitorData?.active_task?.id;
          if (reconnectTaskId && this.monitorData && this.monitorData.state === 'RUNNING') {
            this.connectMonitorSSE(reconnectTaskId);
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
    this._sseTaskId = null;
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
    else if (data.status === 'IDLE') { this.isTraining = false; this.isIdle = true; this.statusText = this.t('monitor.idle','Idle'); }
    else if (data.status === 'FINISHED' || data.status === 'TERMINATED') { this.isTraining = false; this.isIdle = true; this.statusText = data.status_label || data.status; }
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
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
      this.monitorData.elapsed = progress.elapsed;
      this.monitorData.speed = progress.speed;
    }
    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
  },

  handleSSELogUpdate(data) {
    if (!data || !data.data || this.selectedRunDir) return;
    const logData = data.data;
    const newLines = logData.lines || [];

    if (newLines.length === 0) return;

    // ── full 模式实时增量：仅 live + 末页 + 跟随时 push 到当前页，slide 渲染 ──
    if (this.logMode === 'full') {
      // 非末页或未跟随 → 冻结视图，用户在浏览历史页（回末页时 followFullTail 会 resync）
      const atLastPage = this.logFullTotal === 0 || (this.logFullOffset + this.logFullLines.length >= this.logFullTotal);
      const following = this.logAutoScroll || this._logAtBottom;
      if (!atLastPage || !following) return;
      const n = newLines.length;
      const cap = this._logPageSize();
      this.logFullLines.push(...newLines);
      this.logFullTotal += n;
      // 超页裁顶（保持 DOM ≤ 一页），counterReset 随 offset 上移 → 绝对行号仍连续
      if (this.logFullLines.length > cap) {
        const k = this.logFullLines.length - cap;
        this.logFullLines.splice(0, k);
        this.logFullOffset += k;
        this._logFullEvictK = k;
      }
      this._logFullSlide = true;
      if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'logs') {
        this.scheduleRender();
      }
      return;
    }

    // ── tail 模式：环形缓冲 ──
    this.logLines.push(...newLines);
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

  handleSSEHardware(data) {
    if (!data || !data.data) return;
    const hw = data.data;

    if (hw.gpu) this.gpuInfo = hw.gpu;
    if (hw.system) this.sysInfo = hw.system;

    if (this.currentRoute === 'monitor-dashboard') {
      this.scheduleRender();
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
        // 去重：跳过与最后一个点相同 step 的数据点
        if (series.points.length > 0 && series.points[series.points.length - 1].step === p.step) continue;
        series.points.push(p);
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

    if (this.currentRoute === 'monitor-dashboard') this.scheduleRender();
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
    if (this._renderRAF) { cancelAnimationFrame(this._renderRAF); this._renderRAF = null; }
    this._monitorFirstFetch = false;
    this._dashboardRendered = false;
    this._shellBuilt = false;
    this._renderedLogCount = 0;
    this._renderedLogFilterKey = '';
    this._logDirty = false;
    this._logTrimK = 0;
    this._logChunking = false;
    this.logMode = 'full';
    this._logFullLoaded = false;
    this._logFullNeedsResync = false;
    this._logFullSlide = false;
    this._logFullEvictK = 0;
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
          // SSE 连接时由增量推送管理 lossSeries、logLines，轮询仅做首次全量加载
          if (!this._sseConnected) {
            this.lossSeries = j.data.tensorboard_loss||[];
            if (j.data.log_lines) { this.logLines = j.data.log_lines.slice(-this._logCap()); this._logContentVersion++; this._logDirty = true; }
          }
          this.trainParams = j.data.train_params||[];
          this.previews = j.data.previews||[];
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
        else if (j.data.state==='IDLE') { this.isTraining=false; this.isIdle=true; this.statusText=this.t('monitor.idle','Idle'); }
        if (this.currentRoute==='monitor-dashboard') this.renderDashboard();
      }
      if (this._monitorFirstFetch) { this._monitorFirstFetch=false; this.finishProgress(); }
    } catch(e) {
      if (e.name === 'AbortError') return; // silently ignore aborted requests
      if (this._monitorFirstFetch) { this._monitorFirstFetch=false; this.finishProgress(); }
    }
  },

  // ── Log helpers ────────────────────────────────────────
  copyLogs() { navigator.clipboard.writeText(this.logLines.join('\n')).then(() => this.toast(this.t('common.copied'))); },
  clearLogs() {
    this.logLines = []; this._logContentVersion = 0;
    this._renderedLogCount = 0; this._renderedLogFilterKey = '';
    this._logDirty = true; this._logTrimK = 0; this._forceLogRebuild = true;
    this.renderDashboard();
  },

  // 内存缓冲上限 / 分页大小（取自 constants.js LOG）
  _logCap() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.MAX_LINES) || 5000; },
  _logPageSize() { return (window.UI_CONSTANTS && window.UI_CONSTANTS.LOG && window.UI_CONSTANTS.LOG.FULL_PAGE_SIZE) || 1000; },

  // ── 完整日志模式（后端分页）──────────────────────────────
  /** 当前完整日志模式定位日志的 run_dir（历史）或 task_id（实时） */
  _logSliceRunDir() { return this.selectedRunDir || null; },
  _logSliceTaskId() {
    if (this.selectedRunDir) return null;
    if (this.monitorData && this.monitorData.active_task) return this.monitorData.active_task.id || null;
    if (this.runningTask) return this.runningTask.id || null;
    return this.taskId || null;
  },

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
      // 进入完整日志：末页 + 跟随（实时训练随 SSE 增量滚动；历史停在末尾）
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
  followFullTail() {
    this.logAutoScroll = true;
    this._logAtBottom = true;
    this._logFullNeedsResync = true;    // 触发 resync：重拉末页（补回浏览期间的新行）
    this.renderDashboard();
  },

  /** 拉取完整日志分页：offset/tail/q 三选一驱动 */
  async fetchLogSlice(opts) {
    opts = opts || {};
    const limit = this._logPageSize();
    const runDir = this._logSliceRunDir();
    const taskId = this._logSliceTaskId();
    if (!runDir && !taskId) {
      this.toast(this.t('monitor.logSliceNoSource','No log source available'), 'error');
      return;
    }
    const q = (opts.q !== undefined) ? opts.q : this.logFullQuery;
    let offset = this.logFullOffset;
    if (opts.offset !== undefined) offset = opts.offset;
    else if (opts.matchIdx !== undefined && this.logFullMatches.length) {
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
    if (opts.tail) params.set('tail', '1');
    try {
      const r = await fetch('/api/monitor/log-slice?' + params.toString());
      const j = await r.json();
      if (j.status === 'success' && j.data) {
        const d = j.data;
        this.logFullOffset = d.offset;
        this.logFullTotal = d.total;
        this.logFullLines = d.lines || [];
        this.logFullMatches = d.match_indices || [];
        this.logFullQuery = q;
        // 更新 logTotal（live 模式首次探得）
        if (!this.selectedRunDir) this.logTotal = d.total;
        if (opts.matchIdx === undefined) {
          // 非「跳匹配」操作：若当前 offset 落在某匹配所在页，定位到该页首个匹配
          const cur = this.logFullMatches.findIndex(mi => mi >= d.offset && mi < d.offset + this.logFullLines.length);
          this.logFullMatchIdx = cur;
        }
        this._forceLogRebuild = true;
      } else {
        this.toast(j.message || this.t('monitor.logSliceError','Failed to load log slice'), 'error');
      }
    } catch (e) {
      this.toast(this.t('monitor.logSliceError','Failed to load log slice'), 'error');
    } finally {
      this.logFullLoading = false;
      this.renderDashboard();
    }
  },

  /** 完整日志搜索（全文件） */
  searchFullLog(q) {
    const query = (q !== undefined ? String(q) : '').trim();
    if (!query) { this.toast(this.t('monitor.enterSearch','Enter a search term'), 'error'); return; }
    this.logAutoScroll = false; this._logAtBottom = false;
    this.fetchLogSlice({ q: query, matchIdx: 0 });
  },

  /** 完整日志翻页 */
  logFullPrevPage() { if (this.logFullOffset > 0) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: Math.max(0, this.logFullOffset - this._logPageSize()) }); } },
  logFullNextPage() { if (this.logFullOffset + this.logFullLines.length < this.logFullTotal) { this.logAutoScroll = false; this._logAtBottom = false; this.fetchLogSlice({ offset: this.logFullOffset + this._logPageSize() }); } },
  logFullGotoLine(n) {
    const ln = parseInt(n, 10);
    if (isNaN(ln) || ln < 1) return;
    this.logAutoScroll = false; this._logAtBottom = false;
    this.fetchLogSlice({ offset: Math.max(0, (ln - 1) - ((ln - 1) % this._logPageSize())) });
  },
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
      this.toast(this.t('monitor.historyLoadError') || 'Failed to load history', 'error');
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
      const hay = ((h.name||'') + ' ' + (h.model||'') + ' ' + (h.dataset||'') + ' ' + (h.time||'')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  },

  async deleteHistoryRun(runDir) {
    if (!runDir) return;
    if (!confirm(this.t('monitor.confirmDeleteRun','Delete this training record? The output folder will be removed.'))) return;
    try {
      this.startProgress();
      const r = await fetch('/api/monitor/history/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_dir: runDir })
      });
      const j = await r.json();
      if (j.status === 'success') {
        this.toast(this.t('monitor.runDeleted','Record deleted'), 'success');
        await this.loadHistory();
      } else {
        this.toast(j.message || this.t('monitor.deleteFailed','Failed to delete'), 'error');
      }
    } catch(e) {
      this.toast(this.t('monitor.deleteFailed','Failed to delete'), 'error');
    } finally { this.finishProgress(); }
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
        this.lossSeries = j.data.tensorboard_loss || [];
            this.trainParams = j.data.train_params || [];
        this.previews = j.data.previews || [];
        // 重置预览步进，避免越界
        this.previewStep = 0;
        if (j.data.log_lines) {
          // 后端已截断为尾部 _LOG_DETAIL_TAIL_LINES 行；slice(-cap) 防御性兜底
          this.logLines = j.data.log_lines.slice(-this._logCap());
          this.logTotal = j.data.log_total || this.logLines.length;
          this._logContentVersion++;
          this._logDirty = true;
        }
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
        this.logFullTotal = 0;
        this.logAutoScroll = true;
        this._logAtBottom = true;
        this.renderDashboard();
      } else {
        this.toast(j.message || this.t('monitor.loadRunFailed','Failed to load run detail'));
      }
    } catch (e) {
      this.toast(this.t('monitor.runDetailError','Error loading run detail'));
    } finally {
      this.finishProgress();
    }
  },

  clearRunDetail() {
    /** 返回实时监控模式 */
    this.selectedRunDir = null;
    this.runDetailData = null;
    this._shellBuilt = false;
    this._renderedLogCount = 0;
    this._renderedLogFilterKey = '';
    this._logTrimK = 0;
    this._logDirty = true;
    this._forceLogRebuild = true;
    this.logMode = 'full';
    this._logFullLoaded = false;
    this.logTotal = 0;
    // 强制刷新：先停止再重启轮询
    this.stopMonitorPolling();
    this.startMonitorPolling();
  },

  // ── Output Files ──────────────────────────────────────
  async loadOutputFiles() {
    const runDir = this.currentOutputRunDir;
    if (!runDir) {
      this.outputFiles = [];
      this.outputFilesSelected = {};
      return;
    }
    this.outputFilesLoading = true;
    try {
      const r = await fetch('/api/monitor/outputs?run_dir=' + encodeURIComponent(runDir));
      const j = await r.json();
      if (j.status === 'success') {
        this.outputFiles = j.data || [];
        this.outputFilesSelected = {};
      } else {
        this.outputFiles = [];
      }
    } catch (e) {
      this.outputFiles = [];
    } finally {
      this.outputFilesLoading = false;
      this._outputsDirty = true;
      this.renderDashboard();
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
    this.outputFiles.forEach(f => { this.outputFilesSelected[f.path] = true; });
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

  // 模型存档排序：仅对 category=='model' 排序，其余文件保持原序分区。
  // 返回 { models: [...], others: [...] }。无 loss 的模型项按当前方向排末尾。
  _sortedOutputs() {
    const files = this.outputFiles || [];
    const models = files.filter(f => f.category === 'model');
    const others = files.filter(f => f.category !== 'model');
    const key = this.outputSortKey || 'loss';
    const dir = this.outputSortDir === 'desc' ? -1 : 1;
    const sorted = models.slice().sort((a, b) => {
      let va, vb;
      if (key === 'loss') {
        va = (a.ckpt_loss == null) ? Infinity : a.ckpt_loss;
        vb = (b.ckpt_loss == null) ? Infinity : b.ckpt_loss;
      } else if (key === 'time') {
        va = a.mtime || 0; vb = b.mtime || 0;
      } else if (key === 'size') {
        va = a.size || 0; vb = b.size || 0;
      } else { // name
        va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase();
        if (va < vb) return dir;
        if (va > vb) return -dir;
        return 0;
      }
      return (va - vb) * dir;
    });
    return { models: sorted, others };
  },

  setOutputSort(key) {
    if (this.outputSortKey === key) {
      this.outputSortDir = this.outputSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.outputSortKey = key;
      this.outputSortDir = (key === 'loss' || key === 'name') ? 'asc' : 'desc';
    }
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
    if (!selected.length) {
      this.toast(this.t('monitor.selectFilesFirst') || 'Please select files first');
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
    this._triggerDownload('/api/monitor/outputs/download-file?path=' + encodeURIComponent(path));
  }

};
