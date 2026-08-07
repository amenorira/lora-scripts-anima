/* ================================================================
   environment-core.js — State, WebSocket task updates, xformers & sd-scripts
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.environmentCoreMixin = {
  // ── Flash Attention State ────────────────────────────
  faStatus: null, faBusy: false, faError: null,
  faManualUrl: '', faCandidatesOpen: false,
  faConfirmMsg: null, faConfirmCallback: null,
  faSource: 'default', faInstallJobId: null,
  // FA 安装改为"下载+安装"结构化进度任务（旧 faInstallLog/faInstallElapsed 已废弃）
  faProgress: null,    // 后端 progress dict: {stage, filename, downloaded, total, speed, ...}
  faLog: '',           // 安装日志文本（多行）
  faInstallElapsed: 0, // 已用时（秒）

  // ── xformers State ───────────────────────────────────
  xfStatus: null, xfBusy: false, xfError: null,
  xfInstallJobId: null, xfInstallLog: '', xfInstallElapsed: 0,

  // ── sd-scripts State ────────────────────────────────
  sdStatus: null,

  // ── Multi-core Registry State ───────────────────────
  trainingCores: null, trainingCoresError: null,

  // ── Triton State ─────────────────────────────────────
  tritonStatus: null, tritonBusy: false,
  tritonInstallJobId: null, tritonInstallLog: '', tritonInstallElapsed: 0,

  // ── 模型下载 State ──────────────────────────────────
  animaModelStatus: null,   // models/ 下已有文件清单 [{filename, desc, exists, size_gb, dest_path}]
  animaModelDestDir: '',    // 目标目录（相对仓库根，如 models/），用于"下载到哪里"说明
  animaModelBusy: false,
  animaModelJobId: null,
  animaModelProgress: null, // 后端 progress 字段
  animaModelAggregate: null,// 前端计算的批量整体进度 {pct, fileIndex, fileTotal, label}
  animaModelLog: '',
  animaModelError: null,
  animaModelLogOpen: false, // 日志折叠状态（持久化，避免实时重渲染被收起）

  // ── Card open/close state (persisted) ────────────────
  faCardOpen: true, xfCardOpen: true, sdCardOpen: true, lycorisCardOpen: true, musubiCardOpen: true, tritonCardOpen: true, animaModelCardOpen: true, kreaModelCardOpen: true,
  _envRealtimeTopics: null,
  environmentLoading: false,
  environmentLoadCompleted: 0,
  environmentLoadTotal: 0,
  _environmentLoadPromise: null,
  _environmentCommitChain: null,
  _environmentRenderFrame: null,

  _envInitCardState() {
    try {
      const v = localStorage.getItem('anima_env_cards');
      if (v) { const s = JSON.parse(v);
        if (typeof s.fa === 'boolean') this.faCardOpen = s.fa;
        if (typeof s.xf === 'boolean') this.xfCardOpen = s.xf;
        if (typeof s.sd === 'boolean') this.sdCardOpen = s.sd;
        if (typeof s.lycoris === 'boolean') this.lycorisCardOpen = s.lycoris;
        else if (typeof s.coreRegistry === 'boolean') this.lycorisCardOpen = s.coreRegistry;
        if (typeof s.musubi === 'boolean') this.musubiCardOpen = s.musubi;
        else if (typeof s.coreRegistry === 'boolean') this.musubiCardOpen = s.coreRegistry;
        if (typeof s.triton === 'boolean') this.tritonCardOpen = s.triton;
        if (typeof s.animaModel === 'boolean') this.animaModelCardOpen = s.animaModel;
        if (typeof s.kreaModel === 'boolean') this.kreaModelCardOpen = s.kreaModel;
        if (typeof s.animaModelLog === 'boolean') this.animaModelLogOpen = s.animaModelLog;
      }
    } catch (_) {}
  },
  _envSaveCardState() {
    try { localStorage.setItem('anima_env_cards', JSON.stringify({fa:this.faCardOpen,xf:this.xfCardOpen,sd:this.sdCardOpen,lycoris:this.lycorisCardOpen,musubi:this.musubiCardOpen,triton:this.tritonCardOpen,animaModel:this.animaModelCardOpen,kreaModel:this.kreaModelCardOpen,animaModelLog:this.animaModelLogOpen})); } catch (_) {}
  },

  // ── Realtime task bridge ─────────────────────────────
  _setEnvironmentRealtimeTask(slot, jobId) {
    if (!this._envRealtimeTopics) this._envRealtimeTopics = {};
    const next = jobId ? 'task:' + jobId : null;
    const previous = this._envRealtimeTopics[slot] || null;
    if (previous === next) return;
    if (previous) this.realtimeUnsubscribe(previous);
    this._envRealtimeTopics[slot] = next;
    if (next) this.realtimeSubscribe(next);
  },

  _environmentSlotForTopic(topic) {
    if (!topic || !this._envRealtimeTopics) return null;
    return Object.keys(this._envRealtimeTopics).find(slot => this._envRealtimeTopics[slot] === topic) || null;
  },

  handleRealtimeEnvironmentEvent(event) {
    if (!event || (event.type !== 'task.status' && event.type !== 'task.progress')) return;
    const slot = this._environmentSlotForTopic(event.topic);
    if (!slot) return;
    const envelope = event.payload || {};
    this._applyEnvironmentRealtimeUpdate(slot, envelope.data || {}, envelope.status || '');
  },

  applyRealtimeEnvironmentSnapshot(snapshot) {
    const tracked = snapshot && snapshot.tasks && snapshot.tasks.tracked || [];
    const slots = {
      'flash-attention-install': 'fa',
      'xformers-install': 'xf',
      'triton-install': 'triton',
      'model-download': 'animaModel',
    };
    for (const task of tracked) {
      const slot = slots[task.kind];
      if (!slot || !['CREATED', 'RUNNING'].includes(task.status)) continue;
      const idKey = slot === 'animaModel' ? 'animaModelJobId' : slot + 'InstallJobId';
      const busyKey = slot === 'animaModel' ? 'animaModelBusy' : slot + 'Busy';
      if (!this[idKey]) this[idKey] = task.task_id;
      this[busyKey] = true;
      this._setEnvironmentRealtimeTask(slot, task.task_id);
      this._applyEnvironmentRealtimeUpdate(slot, task.data || {}, task.status || '');
    }
  },

  resetRealtimeEnvironmentState() {
    const slots = ['fa', 'xf', 'triton', 'animaModel'];
    const hadTasks = !!(this.faBusy || this.xfBusy || this.tritonBusy || this.animaModelBusy || this.faInstallJobId || this.xfInstallJobId || this.tritonInstallJobId || this.animaModelJobId);
    slots.forEach(slot => this._setEnvironmentRealtimeTask(slot, null));
    const unknown = this.t('monitor.taskStateUnknown');
    if (this.faBusy || this.faInstallJobId) this.faError = unknown;
    if (this.xfBusy || this.xfInstallJobId) this.xfError = unknown;
    if (this.tritonBusy || this.tritonInstallJobId) this.tritonInstallLog = unknown;
    if (this.animaModelBusy || this.animaModelJobId) this.animaModelError = unknown;
    this.faBusy = this.xfBusy = this.tritonBusy = this.animaModelBusy = false;
    this.faInstallJobId = this.xfInstallJobId = this.tritonInstallJobId = this.animaModelJobId = null;
    this.scheduleEnvironmentRender();
    return hadTasks;
  },

  _applyEnvironmentRealtimeUpdate(slot, data, normalizedStatus) {
    const terminal = ['FINISHED', 'FAILED', 'TERMINATED'].includes(normalizedStatus) || !!data.done;
    const failed = normalizedStatus === 'FAILED' || data.success === false || data.returncode != null && data.returncode !== 0
      || (data.progress && (data.progress.stage === 'error' || data.progress.phase === 'error'));
    if (slot === 'fa') {
      this.faProgress = data.progress || this.faProgress;
      this.faLog = Array.isArray(data.log) ? data.log.join('\n') : (data.log || this.faLog);
      this.faInstallElapsed = data.elapsed || 0;
    } else if (slot === 'xf') {
      this.xfInstallLog = data.lines || this.xfInstallLog;
      this.xfInstallElapsed = data.elapsed || 0;
    } else if (slot === 'triton') {
      this.tritonInstallLog = data.lines || this.tritonInstallLog;
      this.tritonInstallElapsed = data.elapsed || 0;
    } else if (slot === 'animaModel') {
      this.animaModelProgress = data.progress || this.animaModelProgress;
      this.animaModelLog = Array.isArray(data.log) ? data.log.join('\n') : (data.log || this.animaModelLog);
      this.animaModelAggregate = this._computeAnimaAggregate(this.animaModelProgress);
    }
    if (!terminal) {
      this.scheduleEnvironmentRender();
      return;
    }
    this._finalizeEnvironmentRealtimeTask(slot, data, failed);
  },

  _finalizeEnvironmentRealtimeTask(slot, data, failed) {
    const idKey = slot === 'animaModel' ? 'animaModelJobId' : slot + 'InstallJobId';
    const busyKey = slot === 'animaModel' ? 'animaModelBusy' : slot + 'Busy';
    this[busyKey] = false;
    this[idKey] = null;
    this._setEnvironmentRealtimeTask(slot, null);
    const fallback = this.t('environment.installFailed');
    if (slot === 'fa') {
      if (failed) this.faError = (data.progress || {}).error || (Array.isArray(data.log) && data.log[data.log.length - 1]) || fallback;
      else this.toast(this.t('environment.refreshed'), 'success');
      this.faRefresh(true).catch(() => {});
    } else if (slot === 'xf') {
      if (failed) this.xfError = data.error || data.lines || fallback;
      this.xfRefresh(true).catch(() => {});
    } else if (slot === 'triton') {
      if (failed) this.tritonInstallLog = (this.tritonInstallLog ? this.tritonInstallLog + '\n' : '') + '[ERROR] ' + fallback;
      this.tritonRefresh(true).catch(() => {});
    } else if (slot === 'animaModel') {
      if (failed) {
        this.animaModelError = (data.progress || {}).error || (Array.isArray(data.log) && data.log[data.log.length - 1]) || fallback;
        this.toast(this.t('environment.installFailed'), 'error');
      }
      this.animaModelRefresh(true).catch(() => {});
    }
    this.finishProgress();
    this.scheduleEnvironmentRender();
  },

  _formatElapsed(sec) { const m = Math.floor(sec/60), s = Math.floor(sec%60); return m+':'+String(s).padStart(2,'0'); },

  // 字节数 → 人类可读，自适应单位（对齐后端 _human_bytes 风格，但带单位名）。
  // 239MB 显示 "239.11 MB" 而非 "0.23 GB"；5.2GB 仍显示 "5.20 GB"。
  _humanBytes(b) {
    if (!b || b < 0 || !isFinite(b)) return '0 B';
    const units = [['B',1],['KB',1024],['MB',1048576],['GB',1073741824],['TB',1099511627776]];
    for (let i = units.length-1; i >= 0; i--) {
      if (b >= units[i][1]) {
        const v = b / units[i][1];
        const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
        return s + ' ' + units[i][0];
      }
    }
    return b + ' B';
  },

  faShowConfirm(msg, callback) { this.faConfirmMsg = msg; this.faConfirmCallback = callback; this.renderEnvironment(); },
  faDismissConfirm() { this.faConfirmMsg = null; this.faConfirmCallback = null; this.renderEnvironment(); },

  scheduleEnvironmentRender() {
    if (this.currentRoute !== 'environment' || this._environmentRenderFrame != null) return;
    this._environmentRenderFrame = requestAnimationFrame(() => {
      this._environmentRenderFrame = null;
      if (this.currentRoute === 'environment') this.renderEnvironment();
    });
  },

  _waitForEnvironmentPaint() {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      setTimeout(finish, 80);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  },

  async _commitEnvironmentLoad(loader, outcome) {
    const commit = async () => {
      try {
        if (outcome.ok) loader.apply(outcome.value);
        else if (loader.fail) loader.fail(outcome.error);
      } finally {
        this.environmentLoadCompleted++;
        if (this.currentRoute === 'environment') this.renderEnvironment();
        await this._waitForEnvironmentPaint();
      }
    };
    this._environmentCommitChain = (this._environmentCommitChain || Promise.resolve()).then(commit, commit);
    await this._environmentCommitChain;
  },

  async _runEnvironmentLoadQueue(loaders, concurrency) {
    let cursor = 0;
    const worker = async () => {
      while (cursor < loaders.length) {
        const loader = loaders[cursor++];
        let outcome;
        try {
          outcome = { ok: true, value: await loader.load() };
        } catch (error) {
          outcome = { ok: false, error };
        }
        await this._commitEnvironmentLoad(loader, outcome);
      }
    };
    const workerCount = Math.min(Math.max(1, concurrency || 1), loaders.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  },

  _environmentJsonLoader(url, apply, fail, transform) {
    return {
      load: async () => {
        const response = await fetch(url);
        const payload = await response.json();
        if (!response.ok) throw new Error('Failed to load ' + url);
        return transform ? transform(payload) : payload;
      },
      apply,
      fail,
    };
  },

  async buildEnvironmentPage() {
    const el = document.getElementById('environmentPage');
    if (!el) { this.finishProgress(); return; }
    this._envInitCardState();
    if (this._environmentLoadPromise) {
      this.renderEnvironment();
      await this._environmentLoadPromise;
      if (this.currentRoute === 'environment') this.renderEnvironment();
      this.finishProgress();
      return;
    }
    const needsFa = !this.faStatus, needsXf = !this.xfStatus, needsSd = !this.sdStatus, needsCores = !this.trainingCores, needsTriton = !this.tritonStatus,
          needsAnimaModel = !this.animaModelStatus;
    if (needsFa || needsXf || needsSd || needsCores || needsTriton || needsAnimaModel) {
      // Render the full skeleton immediately, then load in a small queue.
      // This avoids stacking cold imports and disk scans while telemetry is active.
      const loaders = [];
      if (needsFa) {
        this.faError = null;
        const source = this.faSource && this.faSource !== 'default' ? '?source=' + encodeURIComponent(this.faSource) : '';
        loaders.push(this._environmentJsonLoader(
          '/api/flash-attention/status' + source,
          data => { this.faStatus = data; },
          error => { this.faError = String(error); this.faStatus = null; },
        ));
      }
      if (needsXf) {
        this.xfError = null;
        loaders.push(this._environmentJsonLoader(
          '/api/xformers/status',
          data => { this.xfStatus = data; },
          error => { this.xfError = String(error); this.xfStatus = null; },
        ));
      }
      if (needsTriton) loaders.push(this._environmentJsonLoader(
        '/api/triton/status',
        data => { this.tritonStatus = data; },
        () => { this.tritonStatus = null; },
      ));
      if (needsSd) loaders.push(this._environmentJsonLoader(
        '/api/sd-scripts/status',
        data => { this.sdStatus = data; },
        () => { this.sdStatus = null; },
      ));
      if (needsAnimaModel) {
        this.animaModelError = null;
        loaders.push(this._environmentJsonLoader(
          '/api/anima-model/status',
          data => {
            this.animaModelStatus = data.files || null;
            this.animaModelDestDir = data.dest_dir || 'models/';
          },
          error => { this.animaModelError = String(error); this.animaModelStatus = null; },
        ));
      }
      if (needsCores) {
        this.trainingCoresError = null;
        loaders.push(this._environmentJsonLoader(
          '/api/training/cores',
          data => { this.trainingCores = data; },
          error => { this.trainingCoresError = String(error.message || error); this.trainingCores = null; },
          payload => {
            if (payload.status !== 'success') throw new Error(payload.message || 'Failed to load training cores');
            return payload.data || null;
          },
        ));
      }

      this.environmentLoading = true;
      this.environmentLoadCompleted = 0;
      this.environmentLoadTotal = loaders.length;
      this._environmentCommitChain = Promise.resolve();
      this.renderEnvironment();
      this._environmentLoadPromise = (async () => {
        await this._waitForEnvironmentPaint();
        await this._runEnvironmentLoadQueue(loaders, 2);
      })();
      try {
        await this._environmentLoadPromise;
      } finally {
        this._environmentLoadPromise = null;
        this._environmentCommitChain = null;
        this.environmentLoading = false;
      }
    }
    this.renderEnvironment(); this.finishProgress();
  },

  async trainingCoresRefresh() {
    this.trainingCoresError = null;
    try {
      const response = await fetch('/api/training/cores');
      const payload = await response.json();
      if (!response.ok || payload.status !== 'success') throw new Error(payload.message || 'Failed to load training cores');
      this.trainingCores = payload.data || null;
    } catch (error) {
      this.trainingCoresError = String(error.message || error);
      this.trainingCores = null;
    }
  },

  async faRefresh(silent) {
    this.faError = null;
    if (!silent) { this.startProgress(); this.toast(this.t('environment.refreshing')); }
    try {
      const r = await fetch('/api/flash-attention/status' + (this.faSource && this.faSource!=='default' ? '?source='+this.faSource : ''));
      this.faStatus = await r.json();
      if (!silent) this.toast(this.t('environment.refreshed'));
    } catch (e) { this.faError = String(e); this.faStatus = null; }
    if (silent) this.scheduleEnvironmentRender(); else this.renderEnvironment();
    if (!silent) this.finishProgress();
  },

  async faInstall(url) {
    const T = (k,fb) => this.t('environment.'+k)||fb||k;
    const msg = url ? T('confirmUrlInstall','从该 URL 安装？') : T('confirmAutoInstall','自动匹配并安装？');
    this.faShowConfirm(msg, async () => {
      this.faBusy = true; this.faError = null;
      this.faProgress = null; this.faLog = ''; this.faInstallElapsed = 0;
      this.startProgress(); this.renderEnvironment();
      try {
        const r = await fetch('/api/flash-attention/install', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:url||null,source:this.faSource||'default'}) });
        const result = await r.json();
        if (result.success && result.job_id) {
          this.faInstallJobId = result.job_id;
          this._setEnvironmentRealtimeTask('fa', result.job_id);
        } else {
          this.faBusy = false; this.faError = result.error||this.t('environment.installFailed');
          this.finishProgress(); this.renderEnvironment();
        }
      } catch (e) { this.faBusy = false; this.faError = String(e); this.finishProgress(); this.renderEnvironment(); }
    });
  },

  // ── xformers Methods ────────────────────────────────
  async xfRefresh(silent) { this.xfError = null;
    try { const r = await fetch('/api/xformers/status'); this.xfStatus = await r.json(); } catch (e) { this.xfError = String(e); this.xfStatus = null; }
    if (silent) this.scheduleEnvironmentRender(); else { this.renderEnvironment(); this.finishProgress(); }
  },
  async xfInstall() { this.xfBusy = true; this.xfError = null; this.xfInstallLog = ''; this.xfInstallElapsed = 0; this.startProgress(); this.renderEnvironment();
    try { const r = await fetch('/api/xformers/install',{method:'POST'}); const result = await r.json();
      if (result.success && result.job_id) { this.xfInstallJobId = result.job_id; this._setEnvironmentRealtimeTask('xf', result.job_id); }
      else { this.xfBusy = false; this.xfError = result.error||this.t('environment.installFailed'); this.finishProgress(); this.renderEnvironment(); }
    } catch (e) { this.xfBusy = false; this.xfError = String(e); this.finishProgress(); this.renderEnvironment(); }
  },

  // ── Triton Methods ──────────────────────────────────
  async tritonRefresh(silent) {
    try { const r = await fetch('/api/triton/status'); this.tritonStatus = await r.json(); } catch (_) { this.tritonStatus = null; }
    if (silent) this.scheduleEnvironmentRender(); else { this.renderEnvironment(); this.finishProgress(); }
  },

  async tritonInstall() {
    this.tritonBusy = true; this.tritonInstallLog = ''; this.tritonInstallElapsed = 0; this.startProgress(); this.renderEnvironment();
    try {
      const r = await fetch('/api/triton/install', { method: 'POST' });
      const result = await r.json();
      if (result.success && result.job_id) { this.tritonInstallJobId = result.job_id; this._setEnvironmentRealtimeTask('triton', result.job_id); }
      else { this.tritonBusy = false; this.toast(this.t('environment.installFailed'), 'error'); this.finishProgress(); this.renderEnvironment(); }
    } catch (e) { this.tritonBusy = false; this.toast(String(e), 'error'); this.finishProgress(); this.renderEnvironment(); }
  },

  // ── Anima 模型下载 Methods ──────────────────────────
  async animaModelRefresh(silent) {
    this.animaModelError = null;
    try {
      const r = await fetch('/api/anima-model/status');
      const data = await r.json();
      this.animaModelStatus = data.files || null;
      this.animaModelDestDir = data.dest_dir || 'models/';
    } catch (e) { this.animaModelError = String(e); this.animaModelStatus = null; }
    if (silent) this.scheduleEnvironmentRender(); else { this.renderEnvironment(); this.finishProgress(); }
  },

  async animaModelDownload(file, group) {
    if (this.animaModelBusy) return; // 防止重复点击
    this.animaModelBusy = true; this.animaModelError = null;
    this.animaModelLog = ''; this.animaModelProgress = null;
    this.animaModelAggregate = null;
    this.animaModelLogOpen = false;  // 新任务默认收起日志，用户可手动展开
    this.startProgress(); this.renderEnvironment();
    try {
      const body = JSON.stringify({file: file || null, group: group || null});
      const r = await fetch('/api/anima-model/download', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body
      });
      const result = await r.json();
      if (result.success && result.job_id) {
        this.animaModelJobId = result.job_id;
        this._setEnvironmentRealtimeTask('animaModel', result.job_id);
      } else {
        this.animaModelBusy = false;
        this.animaModelError = result.message || this.t('environment.installFailed');
        this.finishProgress(); this.renderEnvironment();
      }
    } catch (e) {
      this.animaModelBusy = false;
      this.animaModelError = String(e);
      this.finishProgress(); this.renderEnvironment();
    }
  },

  // 由后端 progress dict 计算批量整体进度（前端展示"第 i/n 个 · pct%"）。
  // 策略：已完成文件按 100% 计，当前文件按其 pct 计，未到的按 0% 计，再除以总数。
  _computeAnimaAggregate(p) {
    if (!p) return null;
    const fileTotal = p.file_total || (this.animaModelStatus ? this.animaModelStatus.length : 0) || 1;
    const fileIndex = (p.file_index != null) ? p.file_index : 0;
    const batch = Array.isArray(p.batch) ? p.batch : null;
    // 当前文件百分比
    let curPct = 0;
    if (p.total > 0 && p.downloaded != null) {
      curPct = Math.max(0, Math.min(100, p.downloaded * 100 / p.total));
    }
    // 整体 = 已完成文件(100) + 当前文件部分(curPct)，再 / fileTotal
    const completed = fileIndex; // 前 fileIndex 个已完成
    const aggregatePct = Math.round((completed * 100 + curPct) / fileTotal);
    return {
      pct: Math.max(0, Math.min(100, aggregatePct)),
      fileIndex: fileIndex + 1,
      fileTotal,
      label: batch ? (p.filename || '') : (p.filename || ''),
      phase: p.phase || '',
    };
  },

};
