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

  // ── Card open/close state (persisted) ────────────────
  faCardOpen: true, xfCardOpen: true, sdCardOpen: true,
  _envPollTimer: null,

  _envInitCardState() {
    try {
      const v = localStorage.getItem('anima_env_cards');
      if (v) { const s = JSON.parse(v);
        if (typeof s.fa === 'boolean') this.faCardOpen = s.fa;
        if (typeof s.xf === 'boolean') this.xfCardOpen = s.xf;
        if (typeof s.sd === 'boolean') this.sdCardOpen = s.sd;
      }
    } catch (_) {}
  },
  _envSaveCardState() {
    try { localStorage.setItem('anima_env_cards', JSON.stringify({fa:this.faCardOpen,xf:this.xfCardOpen,sd:this.sdCardOpen})); } catch (_) {}
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
    const needsFa = !this.faStatus, needsXf = !this.xfStatus, needsSd = !this.sdStatus;
    if (needsFa || needsXf || needsSd) {
      el.innerHTML = `<div class="env-loading"><div class="env-spinner"></div><p>`+this.t('environment.loading')+`</p></div>`;
      const tasks = [];
      if (needsFa) tasks.push(this.faRefresh(true));
      if (needsXf) tasks.push(this.xfRefresh(true));
      if (needsSd) tasks.push((async () => {
        try { const r = await fetch('/api/sd-scripts/status'); this.sdStatus = await r.json(); } catch (_) { this.sdStatus = null; }
      })());
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

};
