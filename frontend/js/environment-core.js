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
  tritonStatus: null, tritonBusy: false, tritonError: null,
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
  animaModelLogOpen: false, // 日志折叠状态（并入 _envCardOpen 覆盖机制）

  // ── Card open/close state ────────────────────────────
  // 覆盖模型：anima_env_cards_v2 只存用户显式展开/收起的槽位；
  // 未覆盖的槽位由 _envDefaultCardOpen 按健康度智能决定默认值。
  _envCardOverrides: null,
  _envSlotHtml: null, // 分槽渲染缓存 {slotId: html}
  faAdvancedOpen: false, // FA 高级选项子折叠（会话内状态）
  _envRealtimeTopics: null,
  environmentLoading: false,
  environmentLoadCompleted: 0,
  environmentLoadTotal: 0,
  _environmentLoadPromise: null,
  _environmentCommitChain: null,
  _environmentRenderFrame: null,

  _envInitCardState() {
    try {
      const v2 = localStorage.getItem('anima_env_cards_v2');
      this._envCardOverrides = (v2 && JSON.parse(v2)) || {};
      // 旧版 key（完整布尔表）迁移为覆盖后删除
      const old = localStorage.getItem('anima_env_cards');
      if (old) {
        const s = JSON.parse(old) || {};
        const map = { fa:'fa', xf:'xf', sd:'sd', lycoris:'lycoris', musubi:'musubi', triton:'triton', animaModel:'animaModel', kreaModel:'krea2', animaModelLog:'animaModelLog' };
        for (const k of Object.keys(map)) {
          if (typeof s[k] === 'boolean' && typeof this._envCardOverrides[map[k]] === 'undefined') this._envCardOverrides[map[k]] = s[k];
        }
        if (typeof s.coreRegistry === 'boolean') {
          if (typeof this._envCardOverrides.lycoris === 'undefined') this._envCardOverrides.lycoris = s.coreRegistry;
          if (typeof this._envCardOverrides.musubi === 'undefined') this._envCardOverrides.musubi = s.coreRegistry;
        }
        localStorage.removeItem('anima_env_cards');
        this._envSaveCardState();
      }
    } catch (_) { this._envCardOverrides = this._envCardOverrides || {}; }
  },
  _envSaveCardState() {
    try { localStorage.setItem('anima_env_cards_v2', JSON.stringify(this._envCardOverrides || {})); } catch (_) {}
  },

  // 智能默认展开：本页一切皆为可选增强，缺失不是警告。
  // 只有 busy / error 默认展开；未安装、未下载、未配置默认收起
  // （行上仍有安装/下载快捷按钮，不影响发现性）。
  _envDefaultCardOpen(slotId) {
    switch (slotId) {
      case 'fa': return !!(this.faBusy || this.faError);
      case 'xf': return !!(this.xfBusy || this.xfError);
      case 'triton': return !!(this.tritonBusy || this.tritonError);
      case 'sd': return false;
      case 'lycoris':
      case 'musubi': return !!this.trainingCoresError;
      case 'animaModel':
      case 'krea2': return !!(this.animaModelBusy || this.animaModelError);
      case 'animaModelLog': return !!this.animaModelLogOpen;
      default: return false;
    }
  },

  // 当前生效的展开状态 = 用户覆盖 ?? 智能默认
  _envCardOpen(slotId) {
    const o = (this._envCardOverrides || {})[slotId];
    return typeof o === 'boolean' ? o : this._envDefaultCardOpen(slotId);
  },
  _envSetCardOpen(slotId, open) {
    if (!this._envCardOverrides) this._envCardOverrides = {};
    this._envCardOverrides[slotId] = !!open;
    if (slotId === 'animaModelLog') this.animaModelLogOpen = !!open;
    this._envSaveCardState();
  },
  // 进入 busy 时强制展开一次：丢弃该槽覆盖，让智能默认（busy→true）生效
  _envForceOpen(slotId) {
    if (!this._envCardOverrides) return;
    if (slotId in this._envCardOverrides) {
      delete this._envCardOverrides[slotId];
      this._envSaveCardState();
    }
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
    if (this.tritonBusy || this.tritonInstallJobId) this.tritonError = unknown;
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
    this._finalizeEnvironmentRealtimeTask(slot, data, failed).catch(() => {});
  },

  // 任务收尾：先刷新状态（silent refresh 会清掉 error 字段），失败时再写回错误，
  // 保证失败原因常驻可见，不被紧随其后的 refresh 吞掉。
  async _finalizeEnvironmentRealtimeTask(slot, data, failed) {
    const idKey = slot === 'animaModel' ? 'animaModelJobId' : slot + 'InstallJobId';
    const busyKey = slot === 'animaModel' ? 'animaModelBusy' : slot + 'Busy';
    this[busyKey] = false;
    this[idKey] = null;
    this._setEnvironmentRealtimeTask(slot, null);
    const fallback = this.t('environment.installFailed');
    if (slot === 'fa') {
      const msg = failed ? ((data.progress || {}).error || (Array.isArray(data.log) && data.log[data.log.length - 1]) || fallback) : null;
      if (!failed) this.toast(this.t('environment.refreshed'), 'success');
      await this.faRefresh(true).catch(() => {});
      if (failed) this.faError = msg;
    } else if (slot === 'xf') {
      const msg = failed ? (data.error || data.lines || fallback) : null;
      await this.xfRefresh(true).catch(() => {});
      if (failed) this.xfError = msg;
    } else if (slot === 'triton') {
      const msg = failed ? ((Array.isArray(data.lines) && data.lines[data.lines.length - 1]) || data.lines || this.tritonInstallLog || fallback) : null;
      await this.tritonRefresh(true).catch(() => {});
      if (failed) this.tritonError = msg;
    } else if (slot === 'animaModel') {
      const msg = failed ? ((data.progress || {}).error || (Array.isArray(data.log) && data.log[data.log.length - 1]) || fallback) : null;
      if (failed) this.toast(this.t('environment.installFailed'), 'error');
      await this.animaModelRefresh(true).catch(() => {});
      if (failed) this.animaModelError = msg;
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

  _flashAttentionStatusUrl() {
    const source = this.faSource && this.faSource !== 'default'
      ? '?source=' + encodeURIComponent(this.faSource)
      : '';
    return '/api/flash-attention/status' + source;
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
        loaders.push(this._environmentJsonLoader(
          this._flashAttentionStatusUrl(),
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

  async faRefresh(silent) {
    this.faError = null;
    if (!silent) { this.startProgress(); this.toast(this.t('environment.refreshing')); }
    try {
      const r = await fetch(this._flashAttentionStatusUrl());
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
      this._envForceOpen('fa');
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
  async xfInstall() { this.xfBusy = true; this.xfError = null; this.xfInstallLog = ''; this.xfInstallElapsed = 0; this._envForceOpen('xf'); this.startProgress(); this.renderEnvironment();
    try { const r = await fetch('/api/xformers/install',{method:'POST'}); const result = await r.json();
      if (result.success && result.job_id) { this.xfInstallJobId = result.job_id; this._setEnvironmentRealtimeTask('xf', result.job_id); }
      else { this.xfBusy = false; this.xfError = result.error||this.t('environment.installFailed'); this.finishProgress(); this.renderEnvironment(); }
    } catch (e) { this.xfBusy = false; this.xfError = String(e); this.finishProgress(); this.renderEnvironment(); }
  },

  // ── Triton Methods ──────────────────────────────────
  async tritonRefresh(silent) {
    this.tritonError = null;
    try { const r = await fetch('/api/triton/status'); this.tritonStatus = await r.json(); } catch (_) { this.tritonStatus = null; }
    if (silent) this.scheduleEnvironmentRender(); else { this.renderEnvironment(); this.finishProgress(); }
  },

  async tritonInstall() {
    this.tritonBusy = true; this.tritonError = null; this.tritonInstallLog = ''; this.tritonInstallElapsed = 0; this._envForceOpen('triton'); this.startProgress(); this.renderEnvironment();
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
    // 手动刷新时清掉过期任务进度：旧 progress 残留（phase='done'+batch）会让
    // 手动删除的文件被误报为"失败"（bug 3）。silent（任务收尾）时保留，供失败行标红。
    if (!silent) { this.animaModelProgress = null; this.animaModelAggregate = null; }
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
    if (group === 'Krea 2') this._envForceOpen('krea2');
    else if (group === 'Anima') this._envForceOpen('animaModel');
    else { this._envForceOpen('animaModel'); this._envForceOpen('krea2'); }
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

  // 复制日志到剪贴板（错误条"复制日志"按钮，FA/Triton/模型通用）
  _envCopyLog(text) {
    const done = () => this.toast(this.t('environment.copied') || 'Copied', 'success');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text || '').then(done, () => {});
      }
    } catch (_) {}
  },

  // Hero「全部刷新」：并行静默刷新各组件状态
  async _envRefreshAll() {
    const tasks = [
      this.faRefresh(true).catch(() => {}),
      this.xfRefresh(true).catch(() => {}),
      this.tritonRefresh(true).catch(() => {}),
      this.animaModelRefresh(true).catch(() => {}),
      (async () => {
        try { const r = await fetch('/api/sd-scripts/status'); this.sdStatus = await r.json(); }
        catch (_) { this.sdStatus = null; }
      })(),
      (async () => {
        try {
          const r = await fetch('/api/training/cores');
          const payload = await r.json();
          if (payload.status === 'success') { this.trainingCores = payload.data || null; this.trainingCoresError = null; }
          else { this.trainingCoresError = payload.message || 'Failed to load training cores'; this.trainingCores = null; }
        } catch (e) { this.trainingCoresError = String(e && e.message || e); this.trainingCores = null; }
      })(),
    ];
    await Promise.allSettled(tasks);
    this.renderEnvironment();
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
