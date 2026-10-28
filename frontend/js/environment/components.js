/* 运行组件状态刷新与安装操作；由 environment-core.js 装配，共享该工作区的状态。 */
window.environmentComponentsMixin = {
  async faRefresh(silent) {
    try {
      const response = await fetch('/api/flash-attn/status');
      if (!response.ok) throw new Error(this.t('environment.loadFailed'));
      this.faStatus = await response.json();
      this.faError = null;
    } catch (error) { this.faError = String(error); }
    if (silent) this.scheduleEnvironmentRender(); else this.renderEnvironment();
  },

  async faInstall() {
    if (this.faBusy) return;
    this.faBusy = true; this.faError = null; this.faInstallLog = ''; this.faInstallElapsed = 0;
    this.faProgress = { stage: 'resolving' };
    this._envForceOpen('fa'); this.renderEnvironment();
    try {
      const response = await fetch('/api/flash-attn/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: this.faSource }),
      });
      const result = await response.json();
      if (!response.ok || !result.success || !result.job_id) throw new Error(result.message || this.t('environment.installFailed'));
      this.faInstallJobId = result.job_id;
      this._setEnvironmentRealtimeTask('fa', result.job_id);
    } catch (error) {
      this.faBusy = false; this.faError = String(error); this.renderEnvironment();
    }
  },

  // ── xformers Methods ────────────────────────────────
  async xfRefresh(silent) { this.xfError = null;
    try { const r = await fetch('/api/xformers/status'); if (!r.ok) throw new Error('HTTP ' + r.status); this.xfStatus = await r.json(); } catch (e) { this.xfError = String(e); this.xfStatus = null; }
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
    try { const r = await fetch('/api/triton/status'); if (!r.ok) throw new Error('HTTP ' + r.status); this.tritonStatus = await r.json(); } catch (e) { this.tritonError = String(e); this.tritonStatus = null; }
    if (silent) this.scheduleEnvironmentRender(); else { this.renderEnvironment(); this.finishProgress(); }
  },

  async tritonInstall() {
    this.tritonBusy = true; this.tritonError = null; this.tritonInstallLog = ''; this.tritonInstallElapsed = 0; this._envForceOpen('triton'); this.startProgress(); this.renderEnvironment();
    try {
      const r = await fetch('/api/triton/install', { method: 'POST' });
      const result = await r.json();
      if (result.success && result.job_id) { this.tritonInstallJobId = result.job_id; this._setEnvironmentRealtimeTask('triton', result.job_id); }
      else { this.tritonBusy = false; this.tritonError = result.error || result.message || this.t('environment.installFailed'); this.toast(this.tritonError, 'error'); this.finishProgress(); this.renderEnvironment(); }
    } catch (e) { this.tritonBusy = false; this.tritonError = String(e); this.toast(this.tritonError, 'error'); this.finishProgress(); this.renderEnvironment(); }
  },

  async mossAccelRefresh(silent) {
    this.mossAccelError = null;
    try {
      const response = await fetch('/api/moss-acceleration/status');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      this.mossAccelStatus = await response.json();
    } catch (error) { this.mossAccelStatus = null; this.mossAccelError = String(error); }
    if (silent) this.scheduleEnvironmentRender(); else this.renderEnvironment();
  },

  async mossAccelInstall() {
    this.mossAccelBusy = true; this.mossAccelError = null;
    this.mossAccelInstallLog = ''; this.mossAccelInstallElapsed = 0;
    this._envForceOpen('mossAccel'); this.startProgress(); this.renderEnvironment();
    try {
      const response = await fetch('/api/moss-acceleration/install', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.success || !result.job_id) throw new Error(result.message || this.t('environment.installFailed'));
      this.mossAccelInstallJobId = result.job_id;
      this._setEnvironmentRealtimeTask('mossAccel', result.job_id);
    } catch (error) {
      this.mossAccelBusy = false; this.mossAccelError = String(error);
      this.finishProgress(); this.renderEnvironment();
    }
  },

  async mossAccelSetEnabled(enabled) {
    this.mossAccelError = null;
    try {
      const response = await fetch('/api/moss-acceleration/enabled', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || this.t('environment.installFailed'));
      this.mossAccelStatus = result.data;
    } catch (error) { this.mossAccelError = String(error); }
    this.renderEnvironment();
  },
};
