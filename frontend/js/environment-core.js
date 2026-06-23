/* ================================================================
   environment-core.js — State, polling, xformers & sd-scripts
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.environmentCoreMixin = {
  // ── Flash Attention State ────────────────────────────
  faStatus: null, faBusy: false, faError: null,
  faManualUrl: '', faCandidatesOpen: false,
  faConfirmMsg: null, faConfirmCallback: null,
  faSource: 'default', faInstallJobId: null,
  faInstallLog: '', faInstallElapsed: 0,

  // ── xformers State ───────────────────────────────────
  xfStatus: null, xfBusy: false, xfError: null,
  xfInstallJobId: null, xfInstallLog: '', xfInstallElapsed: 0,

  // ── sd-scripts State ────────────────────────────────
  sdStatus: null,

  // ── Triton State ─────────────────────────────────────
  tritonStatus: null, tritonBusy: false,
  tritonInstallJobId: null, tritonInstallLog: '', tritonInstallElapsed: 0,

  // ── Anima 模型 State ────────────────────────────────
  animaModelStatus: null,   // models/ 下已有文件清单 [{filename, desc, exists, size_gb}]
  animaModelBusy: false,
  animaModelJobId: null,
  animaModelProgress: null, // 后端 progress 字段
  animaModelLog: '',
  animaModelError: null,
  animaModelLogOpen: false, // 日志折叠状态（持久化，避免轮询重渲染被收起）

  // ── Card open/close state (persisted) ────────────────
  faCardOpen: true, xfCardOpen: true, sdCardOpen: true, tritonCardOpen: true, animaModelCardOpen: true,
  _envPollTimer: null,

  _envInitCardState() {
    try {
      const v = localStorage.getItem('anima_env_cards');
      if (v) { const s = JSON.parse(v);
        if (typeof s.fa === 'boolean') this.faCardOpen = s.fa;
        if (typeof s.xf === 'boolean') this.xfCardOpen = s.xf;
        if (typeof s.sd === 'boolean') this.sdCardOpen = s.sd;
        if (typeof s.triton === 'boolean') this.tritonCardOpen = s.triton;
        if (typeof s.animaModel === 'boolean') this.animaModelCardOpen = s.animaModel;
        if (typeof s.animaModelLog === 'boolean') this.animaModelLogOpen = s.animaModelLog;
      }
    } catch (_) {}
  },
  _envSaveCardState() {
    try { localStorage.setItem('anima_env_cards', JSON.stringify({fa:this.faCardOpen,xf:this.xfCardOpen,sd:this.sdCardOpen,triton:this.tritonCardOpen,animaModel:this.animaModelCardOpen,animaModelLog:this.animaModelLogOpen})); } catch (_) {}
  },

  // ── Shared install polling ──────────────────────────
  _startPolling(jobId, prefix) {
    const a = this;
    const logKey = prefix + 'InstallLog', elapsedKey = prefix + 'InstallElapsed';
    let retries = 0;
    const MAX_RETRIES = 30;
    a._stopPolling();
    const tick = async () => {
      try {
        const r = await fetch('/api/install-log/' + jobId);
        const data = await r.json();
        retries = 0; // Reset on success
        a[logKey] = data.lines || ''; a[elapsedKey] = data.elapsed || 0;
        if (data.done) { a._stopPolling(); const busyKey = prefix + 'Busy'; a[busyKey] = false;
          const refreshMap = { fa: 'faRefresh', xf: 'xfRefresh' };
          const refreshFn = refreshMap[prefix]; if (refreshFn) { try { await a[refreshFn](true); } catch (_) {} }
          a.finishProgress(); a.renderEnvironment();
        } else { a.renderEnvironment(); a._envPollTimer = setTimeout(tick, 1500); }
      } catch (_) {
        retries++;
        if (retries >= MAX_RETRIES) {
          a._stopPolling();
          const busyKey = prefix + 'Busy'; a[busyKey] = false;
          a[logKey] += '\n[ERROR] ' + a.t('environment.connectionLost','Connection lost, please refresh');
          a.finishProgress(); a.renderEnvironment();
          return;
        }
        a._envPollTimer = setTimeout(tick, 2000);
      }
    };
    a._envPollTimer = setTimeout(tick, 500);
  },
  _stopPolling() { if (this._envPollTimer) { clearTimeout(this._envPollTimer); this._envPollTimer = null; } },
  _formatElapsed(sec) { const m = Math.floor(sec/60), s = Math.floor(sec%60); return m+':'+String(s).padStart(2,'0'); },

  faShowConfirm(msg, callback) { this.faConfirmMsg = msg; this.faConfirmCallback = callback; this.renderEnvironment(); },
  faDismissConfirm() { this.faConfirmMsg = null; this.faConfirmCallback = null; this.renderEnvironment(); },

  async buildEnvironmentPage() {
    const el = document.getElementById('environmentPage');
    if (!el) { this.finishProgress(); return; }
    this._envInitCardState();
    const needsFa = !this.faStatus, needsXf = !this.xfStatus, needsSd = !this.sdStatus, needsTriton = !this.tritonStatus,
          needsAnimaModel = !this.animaModelStatus;
    if (needsFa || needsXf || needsSd || needsTriton || needsAnimaModel) {
      // 立即渲染卡片骨架（4 张卡片 + Anima 模型卡 + Loading 徽章），给用户即时结构反馈；
      // 各卡片数据到达后由 faRefresh/xfRefresh 内的 renderEnvironment 独立刷新，
      // 比单一 spinner 体验更好，也避免长时间空白被误认为卡死。
      this.renderEnvironment();
      const tasks = [];
      if (needsFa) tasks.push(this.faRefresh(true));
      if (needsXf) tasks.push(this.xfRefresh(true));
      if (needsSd) tasks.push((async () => {
        try { const r = await fetch('/api/sd-scripts/status'); this.sdStatus = await r.json(); } catch (_) { this.sdStatus = null; }
      })());
      if (needsTriton) tasks.push(this.tritonRefresh(true));
      if (needsAnimaModel) tasks.push(this.animaModelRefresh(true));
      await Promise.all(tasks);
    }
    this.renderEnvironment(); this.finishProgress();
  },

  async faRefresh(silent) {
    this.faError = null;
    if (!silent) { this.startProgress(); this.toast(this.t('environment.refreshing')); }
    try {
      const r = await fetch('/api/flash-attention/status' + (this.faSource && this.faSource!=='default' ? '?source='+this.faSource : ''));
      this.faStatus = await r.json();
      if (!silent) this.toast(this.t('environment.refreshed'));
    } catch (e) { this.faError = String(e); this.faStatus = null; }
    this.renderEnvironment(); if (!silent) this.finishProgress();
  },

  async faInstall(url) {
    const T = (k,fb) => this.t('environment.'+k)||fb||k;
    const msg = url ? T('confirmUrlInstall','从该 URL 安装？') : T('confirmAutoInstall','自动匹配并安装？');
    this.faShowConfirm(msg, async () => {
      this.faBusy = true; this.faError = null; this.faInstallLog = ''; this.faInstallElapsed = 0;
      this.startProgress(); this.renderEnvironment();
      try {
        const r = await fetch('/api/flash-attention/install', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:url||null,source:this.faSource||'default'}) });
        const result = await r.json();
        if (result.success && result.job_id) { this.faInstallJobId = result.job_id; this._startPolling(result.job_id, 'fa'); }
        else { this.faBusy = false; this.faError = result.error||this.t('environment.installFailed','Install failed'); this.finishProgress(); this.renderEnvironment(); }
      } catch (e) { this.faBusy = false; this.faError = String(e); this.finishProgress(); this.renderEnvironment(); }
    });
  },

  // ── xformers Methods ────────────────────────────────
  async xfRefresh(silent) { this.xfError = null;
    try { const r = await fetch('/api/xformers/status'); this.xfStatus = await r.json(); } catch (e) { this.xfError = String(e); this.xfStatus = null; }
    if (!silent) { this.renderEnvironment(); this.finishProgress(); }
  },
  async xfInstall() { this.xfBusy = true; this.xfError = null; this.xfInstallLog = ''; this.xfInstallElapsed = 0; this.startProgress(); this.renderEnvironment();
    try { const r = await fetch('/api/xformers/install',{method:'POST'}); const result = await r.json();
      if (result.success && result.job_id) { this.xfInstallJobId = result.job_id; this._startPolling(result.job_id, 'xf'); }
      else { this.xfBusy = false; this.xfError = result.error||this.t('environment.installFailed','Install failed'); this.finishProgress(); this.renderEnvironment(); }
    } catch (e) { this.xfBusy = false; this.xfError = String(e); this.finishProgress(); this.renderEnvironment(); }
  },

  // ── Triton Methods ──────────────────────────────────
  async tritonRefresh(silent) {
    try { const r = await fetch('/api/triton/status'); this.tritonStatus = await r.json(); } catch (_) { this.tritonStatus = null; }
    if (!silent) { this.renderEnvironment(); this.finishProgress(); }
  },

  async tritonInstall() {
    this.tritonBusy = true; this.tritonInstallLog = ''; this.tritonInstallElapsed = 0; this.startProgress(); this.renderEnvironment();
    try {
      const r = await fetch('/api/triton/install', { method: 'POST' });
      const result = await r.json();
      if (result.success && result.job_id) { this.tritonInstallJobId = result.job_id; this._startPollingTriton(result.job_id); }
      else { this.tritonBusy = false; this.toast(this.t('environment.installFailed','Install failed'), 'error'); this.finishProgress(); this.renderEnvironment(); }
    } catch (e) { this.tritonBusy = false; this.toast(String(e), 'error'); this.finishProgress(); this.renderEnvironment(); }
  },

  // Triton 专用轮询（prefix = 'triton'，与 xf/fa 共享 _startPolling 逻辑但 prefix 需映射）
  _startPollingTriton(jobId) {
    const a = this;
    const logKey = 'tritonInstallLog', elapsedKey = 'tritonInstallElapsed';
    let retries = 0;
    const MAX_RETRIES = 30;
    a._stopPolling();
    const tick = async () => {
      try {
        const r = await fetch('/api/install-log/' + jobId);
        const data = await r.json();
        retries = 0;
        a[logKey] = data.lines || ''; a[elapsedKey] = data.elapsed || 0;
        if (data.done) { a._stopPolling(); a.tritonBusy = false;
          try { await a.tritonRefresh(true); } catch (_) {}
          a.finishProgress(); a.renderEnvironment();
        } else { a.renderEnvironment(); a._envPollTimer = setTimeout(tick, 1500); }
      } catch (_) {
        retries++;
        if (retries >= MAX_RETRIES) {
          a._stopPolling(); a.tritonBusy = false;
          a[logKey] += '\n[ERROR] ' + a.t('environment.connectionLost','Connection lost, please refresh');
          a.finishProgress(); a.renderEnvironment();
          return;
        }
        a._envPollTimer = setTimeout(tick, 2000);
      }
    };
    a._envPollTimer = setTimeout(tick, 500);
  },

  // ── Anima 模型下载 Methods ──────────────────────────
  async animaModelRefresh(silent) {
    this.animaModelError = null;
    try {
      const r = await fetch('/api/anima-model/status');
      const data = await r.json();
      this.animaModelStatus = data.files || null;
    } catch (e) { this.animaModelError = String(e); this.animaModelStatus = null; }
    if (!silent) { this.renderEnvironment(); this.finishProgress(); }
  },

  async animaModelDownload(file) {
    if (this.animaModelBusy) return; // 防止重复点击
    this.animaModelBusy = true; this.animaModelError = null;
    this.animaModelLog = ''; this.animaModelProgress = null;
    this.animaModelLogOpen = false;  // 新任务默认收起日志，用户可手动展开
    this.startProgress(); this.renderEnvironment();
    try {
      const body = file ? JSON.stringify({file}) : '{}';
      const r = await fetch('/api/anima-model/download', {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body
      });
      const result = await r.json();
      if (result.success && result.job_id) {
        this.animaModelJobId = result.job_id;
        this._startAnimaModelPolling(result.job_id);
      } else {
        this.animaModelBusy = false;
        this.animaModelError = result.message || this.t('environment.installFailed', 'Download failed');
        this.finishProgress(); this.renderEnvironment();
      }
    } catch (e) {
      this.animaModelBusy = false;
      this.animaModelError = String(e);
      this.finishProgress(); this.renderEnvironment();
    }
  },

  _startAnimaModelPolling(jobId) {
    const a = this;
    let retries = 0;
    const MAX_RETRIES = 60;
    a._stopPolling();
    const tick = async () => {
      try {
        const r = await fetch('/api/anima-model/progress/' + jobId);
        const data = await r.json();
        retries = 0;
        a.animaModelProgress = data.progress || null;
        a.animaModelLog = (data.log || []).join('\n');
        if (data.done) {
          a._stopPolling(); a.animaModelBusy = false;
          // 检查下载线程是否报错
          const phase = (data.progress || {}).phase;
          if (phase === 'error') {
            a.animaModelError = (data.progress || {}).error || data.log?.[data.log.length-1] || 'Download failed';
          }
          try { await a.animaModelRefresh(true); } catch (_) {}
          a.finishProgress(); a.renderEnvironment();
        } else { a.renderEnvironment(); a._envPollTimer = setTimeout(tick, 1500); }
      } catch (_) {
        retries++;
        if (retries >= MAX_RETRIES) {
          a._stopPolling(); a.animaModelBusy = false;
          a.animaModelError = a.t('environment.connectionLost', 'Connection lost, please refresh');
          a.finishProgress(); a.renderEnvironment();
          return;
        }
        a._envPollTimer = setTimeout(tick, 2000);
      }
    };
    a._envPollTimer = setTimeout(tick, 500);
  },

};
