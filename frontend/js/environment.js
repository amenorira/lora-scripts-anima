/* ================================================================
   environment.js — Flash Attention & xformers management page
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.environmentMixin = {
  // ── Flash Attention State ────────────────────────────
  faStatus: null,
  faBusy: false,
  faError: null,
  faManualUrl: '',
  faCandidatesOpen: false,
  faConfirmMsg: null,
  faConfirmCallback: null,
  faSource: 'default',
  faInstallJobId: null,
  faInstallLog: '',
  faInstallElapsed: 0,

  // ── xformers State ───────────────────────────────────
  xfStatus: null,
  xfBusy: false,
  xfError: null,
  xfInstallJobId: null,
  xfInstallLog: '',
  xfInstallElapsed: 0,

  // ── sd-scripts State ────────────────────────────────
  sdStatus: null,
  sdBusy: false,
  sdError: null,
  sdReleasesOpen: false,
  sdCommitsOpen: false,
  sdUpdateConfirmMsg: null,
  sdUpdateConfirmCallback: null,
  sdUpdateJobId: null,
  sdInstallLog: '',
  sdInstallElapsed: 0,

  // ── Card open/close state (persisted) ────────────────
  faCardOpen: true,
  xfCardOpen: true,
  sdCardOpen: true,

  _envInitCardState() {
    try {
      const v = localStorage.getItem('anima_env_cards');
      if (v) {
        const s = JSON.parse(v);
        if (typeof s.fa === 'boolean') this.faCardOpen = s.fa;
        if (typeof s.xf === 'boolean') this.xfCardOpen = s.xf;
        if (typeof s.sd === 'boolean') this.sdCardOpen = s.sd;
      }
    } catch (_) { /* ignore */ }
  },

  _envSaveCardState() {
    try {
      localStorage.setItem('anima_env_cards', JSON.stringify({
        fa: this.faCardOpen, xf: this.xfCardOpen, sd: this.sdCardOpen
      }));
    } catch (_) { /* ignore */ }
  },

  // ── Shared install polling ──────────────────────────
  _envPollTimer: null,

  _startPolling(jobId, prefix) {
    const a = this;
    const logKey = prefix + 'InstallLog';
    const elapsedKey = prefix + 'InstallElapsed';
    a._stopPolling();

    const tick = async () => {
      try {
        const r = await fetch('/api/install-log/' + jobId);
        const data = await r.json();
        a[logKey] = data.lines || '';
        a[elapsedKey] = data.elapsed || 0;
        if (data.done) {
          a._stopPolling();
          const busyKey = prefix + 'Busy';
          a[busyKey] = false;
          // Refresh status after install completes
          const refreshMap = { fa: 'faRefresh', xf: 'xfRefresh', sd: 'sdRefresh' };
          const refreshFn = refreshMap[prefix];
          if (refreshFn) {
            try { await a[refreshFn](true); } catch (_) {}
          }
          a.finishProgress();
          a.renderEnvironment();
        } else {
          a.renderEnvironment();
          a._envPollTimer = setTimeout(tick, 1500);
        }
      } catch (_) {
        a._envPollTimer = setTimeout(tick, 2000);
      }
    };
    a._envPollTimer = setTimeout(tick, 500);
  },

  _stopPolling() {
    if (this._envPollTimer) { clearTimeout(this._envPollTimer); this._envPollTimer = null; }
  },

  _formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  },
  faShowConfirm(msg, callback) {
    this.faConfirmMsg = msg;
    this.faConfirmCallback = callback;
    this.renderEnvironment();
  },

  faDismissConfirm() {
    this.faConfirmMsg = null;
    this.faConfirmCallback = null;
    this.renderEnvironment();
  },

  async buildEnvironmentPage() {
    const el = document.getElementById('environmentPage');
    if (!el) { this.finishProgress(); return; }
    this._envInitCardState();
    const needsFa = !this.faStatus;
    const needsXf = !this.xfStatus;
    const needsSd = !this.sdStatus;
    if (needsFa || needsXf || needsSd) {
      el.innerHTML = `<div class="env-loading">
        <div class="env-spinner"></div>
        <p>${this.t('environment.loading') || 'Loading environment info...'}</p>
      </div>`;
      const tasks = [];
      if (needsFa) tasks.push(this.faRefresh(true));
      if (needsXf) tasks.push(this.xfRefresh(true));
      if (needsSd) tasks.push(this.sdRefresh(true));
      await Promise.all(tasks);
    }
    this.renderEnvironment();
    this.finishProgress();
  },

  async faRefresh(silent) {
    this.faError = null;
    if (!silent) {
      this.startProgress();
      this.toast(this.t('environment.refreshing') || 'Refreshing...');
    }
    try {
      const src = this.faSource && this.faSource !== 'default' ? '?source=' + this.faSource : '';
      const r = await fetch('/api/flash-attention/status' + src);
      this.faStatus = await r.json();
      if (!silent) this.toast(this.t('environment.refreshed') || 'Refreshed');
    } catch (e) {
      this.faError = String(e);
      this.faStatus = null;
    }
    this.renderEnvironment();
    if (!silent) this.finishProgress();
  },

  async faInstall(url) {
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    const msg = url ? T('confirmUrlInstall', '从该 URL 安装 Flash Attention？') : T('confirmAutoInstall', '自动匹配并安装 Flash Attention？');
    this.faShowConfirm(msg, async () => {
      this.faBusy = true;
      this.faError = null;
      this.faInstallLog = '';
      this.faInstallElapsed = 0;
      this.startProgress();
      this.renderEnvironment();
      try {
        const r = await fetch('/api/flash-attention/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url || null, source: this.faSource || 'default' })
        });
        const result = await r.json();
        if (result.success && result.job_id) {
          this.faInstallJobId = result.job_id;
          this._startPolling(result.job_id, 'fa');
        } else {
          this.faBusy = false;
          this.faError = result.error || 'Installation failed';
          this.finishProgress();
          this.renderEnvironment();
        }
      } catch (e) {
        this.faBusy = false;
        this.faError = String(e);
        this.finishProgress();
        this.renderEnvironment();
      }
    });
  },

  // ── xformers Methods ────────────────────────────────
  async xfRefresh(silent) {
    this.xfError = null;
    try {
      const r = await fetch('/api/xformers/status');
      this.xfStatus = await r.json();
    } catch (e) {
      this.xfError = String(e);
      this.xfStatus = null;
    }
    if (!silent) {
      this.renderEnvironment();
      this.finishProgress();
    }
  },

  async xfInstall() {
    this.xfBusy = true;
    this.xfError = null;
    this.xfInstallLog = '';
    this.xfInstallElapsed = 0;
    this.startProgress();
    this.renderEnvironment();
    try {
      const r = await fetch('/api/xformers/install', { method: 'POST' });
      const result = await r.json();
      if (result.success && result.job_id) {
        this.xfInstallJobId = result.job_id;
        this._startPolling(result.job_id, 'xf');
      } else {
        this.xfBusy = false;
        this.xfError = result.error || 'Installation failed';
        this.finishProgress();
        this.renderEnvironment();
      }
    } catch (e) {
      this.xfBusy = false;
      this.xfError = String(e);
      this.finishProgress();
      this.renderEnvironment();
    }
  },

  // ── sd-scripts Methods ────────────────────────────────
  async sdRefresh(silent) {
    this.sdError = null;
    if (!silent) {
      this.startProgress();
      this.toast(this.t('environment.refreshing') || 'Refreshing...');
    }
    try {
      const r = await fetch('/api/sd-scripts/status');
      this.sdStatus = await r.json();
      if (!silent) this.toast(this.t('environment.refreshed') || 'Refreshed');
    } catch (e) {
      this.sdError = String(e);
      this.sdStatus = null;
    }
    this.renderEnvironment();
    if (!silent) this.finishProgress();
  },

  sdShowConfirm(msg, callback) {
    this.sdUpdateConfirmMsg = msg;
    this.sdUpdateConfirmCallback = callback;
    this.renderEnvironment();
  },

  sdDismissConfirm() {
    this.sdUpdateConfirmMsg = null;
    this.sdUpdateConfirmCallback = null;
    this.renderEnvironment();
  },

  async sdUpdate(target) {
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    const msg = target === 'main'
      ? T('sdScriptsUpdateConfirmMain', 'Update sd-scripts to the latest main branch commit?')
      : T('sdScriptsUpdateConfirmRelease', 'Update sd-scripts to the latest Release version?');
    this.sdShowConfirm(msg, async () => {
      this.sdBusy = true;
      this.sdError = null;
      this.sdInstallLog = '';
      this.sdInstallElapsed = 0;
      this.startProgress();
      this.renderEnvironment();
      try {
        const r = await fetch('/api/sd-scripts/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: target })
        });
        const result = await r.json();
        if (result.success && result.job_id) {
          this.sdUpdateJobId = result.job_id;
          this._startPolling(result.job_id, 'sd');
        } else {
          this.sdBusy = false;
          this.sdError = result.error || 'Update failed';
          this.finishProgress();
          this.renderEnvironment();
        }
      } catch (e) {
        this.sdBusy = false;
        this.sdError = String(e);
        this.finishProgress();
        this.renderEnvironment();
      }
    });
  },

  renderEnvironment() {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    const T = (k, fb) => this.t('environment.' + k) || fb || k;

    let html = '';

    // ═══════════════════════════════════════════════════
    //  Section: 加速库
    // ═══════════════════════════════════════════════════
    html += `<div class="env-section-header">${T('sectionAccel', 'Acceleration')}</div>`;

    // ═══════════════════════════════════════════════════
    //  Flash Attention card
    // ═══════════════════════════════════════════════════
    const s = this.faStatus;
    const env = s?.env || {};
    const candidates = s?.candidates || [];
    const usable = candidates.filter(c => c.usable);
    const best = usable[0] || null;
    const canAuto = !!env.torch_tag && !!env.platform && usable.length > 0;
    const faInstalled = s?.installed;

    if (this.faBusy) {
      const elapsed = this._formatElapsed(this.faInstallElapsed);
      const log = this.faInstallLog || '';
      html += `<details id="env-flash-attn" ${this.faCardOpen ? 'open' : ''} class="env-card">
        <summary class="env-card-summary">
          <span class="env-chevron"></span>
          <span class="env-card-title">Flash Attention</span>
          <span class="env-badge env-badge-loading">${T('installing', 'Installing...')}</span>
        </summary>
        <div class="env-card-body">
          <div class="env-install-progress">
            <div class="env-install-row">
              <div class="env-install-spinner"></div>
              <div class="env-progress-info">
                <span>${T('installingHint', 'Downloading & installing...')}</span>
                <span class="env-progress-time">${elapsed}</span>
              </div>
            </div>
            ${log ? `<pre class="env-install-log">${log}</pre>` : ''}
          </div>
        </div>
      </details>`;
    } else {
      const faStatusBadge = this.faError
        ? `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>`
        : !s
          ? `<span class="env-badge env-badge-loading">${T('loading', 'Loading...')}</span>`
          : faInstalled
            ? `<span class="env-badge env-badge-ok">${T('installed', 'Installed')} &middot; v${s.version || '?'}</span>`
            : `<span class="env-badge env-badge-warn">${T('notInstalled', 'Not installed')}</span>`;

      html += `<details id="env-flash-attn" ${this.faCardOpen ? 'open' : ''} class="env-card">
        <summary class="env-card-summary">
          <span class="env-chevron"></span>
          <span class="env-card-title">Flash Attention</span>
          <span class="env-card-hint">${T('trainingAccel', 'Training acceleration (optional)')}</span>
          <span class="env-card-hint">${T('restartHint', 'Flash Attention is a C extension. After install, restart the GUI for changes to take effect.')}</span>
          ${faStatusBadge}
        </summary>
        <div class="env-card-body">`;

      if (this.faError) {
        html += `<div class="env-msg env-msg-err"><pre>${this.faError}</pre></div>`;
      }

      if (s) {
        const rows = [
          ['flash_attn', faInstalled ? `v${s.version || '?'}` : `<span class="env-text-warn">${T('notInstalled', 'Not installed')}</span>`],
          ['Python', env.python_tag || '<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
          ['CUDA', env.cuda_tag ? `${env.cuda_tag} <span class="env-text-dim">(${env.cuda_ver||'?'})</span>` : '<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
          ['PyTorch', env.torch_tag ? `${env.torch_tag} <span class="env-text-dim">(${env.torch_ver||'?'})</span>` : '<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
          ['Platform', env.platform || '<span class="env-text-dim">'+T('unsupported','Unsupported')+'</span>'],
        ];
        html += `<table class="env-table"><tbody>`;
        rows.forEach(([label, value]) => {
          html += `<tr><td class="env-table-label">${label}</td><td class="env-table-value">${value}</td></tr>`;
        });
        html += `</tbody></table>`;

        if (s.fetch_error) {
          const isFromDisk = s.from_disk_cache;
          const isRateLimit = /rate limit|限流/i.test(s.fetch_error);
          if (isFromDisk) {
            html += `<div class="env-msg env-msg-info">
              ${T('usingCachedData', '正在使用本地缓存的候选列表。')}
              ${T('cachedDataHint', '首次联网成功后会自动更新。')}
            </div>`;
          } else if (isRateLimit) {
            html += `<div class="env-msg env-msg-warn">
              ${T('githubApiFail', 'GitHub API 暂时不可用')}<br>
              ${T('rateLimitHint', '稍后自动重试，你也可以手动粘贴 wheel URL 直接安装。')}
            </div>`;
          } else {
            html += `<div class="env-msg env-msg-warn">
              ${T('githubApiFail', 'GitHub API 不可用')}: ${s.fetch_error}<br>
              ${T('manualUrlHint', '你可以手动粘贴 wheel URL 直接安装。')}
            </div>`;
          }
        }

        if (!canAuto && !s.fetch_error && env.platform && env.torch_tag) {
          html += `<div class="env-msg env-msg-warn">${T('noWheel', 'No matching wheel found. Paste a URL manually.')}</div>`;
        }

        if (this.faConfirmMsg) {
          html += `<div class="env-actions">
            <div class="env-confirm">
              <span class="env-confirm-msg">${this.faConfirmMsg}</span>
              <button id="fa-confirm-yes" class="btn btn-sm btn-primary">${T('confirmYes', '确认')}</button>
              <button id="fa-confirm-no" class="btn btn-sm btn-ghost">${T('confirmNo', '取消')}</button>
            </div>
          </div>`;
        } else {
          html += `<div class="env-actions">
            <button id="fa-auto-btn" class="btn btn-secondary" ${this.faBusy || !canAuto ? 'disabled' : ''}
              title="${best ? best.name : ''}">
              ${faInstalled ? T('reinstall', 'Reinstall') : T('autoInstall', 'Auto Install')}
            </button>
            <button id="fa-refresh-btn" class="btn-icon" ${this.faBusy ? 'disabled' : ''}
              title="${T('refresh', 'Refresh')}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            </button>
            <span class="env-actions-spacer"></span>
            <span class="env-source-group">
              <button id="fa-src-default" class="env-source-btn ${this.faSource==='default'?'active':''}">${T('sourceDefault', '官方')}</button>
              <button id="fa-src-mirror" class="env-source-btn ${this.faSource==='mirror'?'active':''}">${T('sourceMirror', '镜像')}</button>
              <button id="fa-src-fallback" class="env-source-btn ${this.faSource==='fallback'?'active':''}">${T('sourceFallback', '备用')}</button>
            </span>
            <button id="fa-toggle-btn" class="btn btn-ghost btn-sm">
              ${this.faCandidatesOpen ? T('hideCandidates', 'Hide list') : T('showCandidates', 'Show candidates') + ' (' + candidates.length + ')'}
            </button>
          </div>`;
        }

        if (this.faCandidatesOpen && candidates.length) {
          html += `<ul class="env-candidate-list">`;
          candidates.forEach(c => {
            const mark = c.usable ? 'ok' : 'warn';
            html += `<li class="env-candidate-item">
              <span class="env-candidate-mark env-candidate-${mark}">${c.usable ? '&#10003;' : '&#10007;'}</span>
              <code class="env-candidate-name" title="${c.name}">${c.name}</code>
              ${c.notes.length ? `<span class="env-candidate-notes">${c.notes.map(n => typeof n === 'string' ? n : (T('faNote.' + n.key) || n.text || n.key)).join('; ')}</span>` : ''}
              <button class="fa-candidate-btn btn btn-sm ${c.usable ? 'btn-secondary' : 'btn-ghost'}"
                data-url="${c.url.replace(/'/g,"\\'")}">
                ${c.usable ? T('install', 'Install') : T('forceInstall', 'Force')}
              </button>
            </li>`;
          });
          html += `</ul>`;
        }

        html += `<div class="env-manual-url">
          <input type="text" class="env-url-input" placeholder="https://github.com/.../flash_attn-...whl"
            id="fa-manual-input">
          <button id="fa-url-btn" class="btn btn-secondary">${T('installUrl', 'URL Install')}</button>
        </div>`;
      }

      html += `</div></details>`;
    }

    // ═══════════════════════════════════════════════════
    //  xformers card
    // ═══════════════════════════════════════════════════
    const xs = this.xfStatus;
    const xfEnv = xs?.env || {};
    const xfInstalled = xs?.installed;

    if (this.xfBusy) {
      const elapsed = this._formatElapsed(this.xfInstallElapsed);
      const log = this.xfInstallLog || '';
      html += `<details id="env-xformers" ${this.xfCardOpen ? 'open' : ''} class="env-card">
        <summary class="env-card-summary">
          <span class="env-chevron"></span>
          <span class="env-card-title">xformers</span>
          <span class="env-badge env-badge-loading">${T('installing', 'Installing...')}</span>
        </summary>
        <div class="env-card-body">
          <div class="env-install-progress">
            <div class="env-install-row">
              <div class="env-install-spinner"></div>
              <div class="env-progress-info">
                <span>${T('xfInstallingHint', 'Downloading & installing...')}</span>
                <span class="env-progress-time">${elapsed}</span>
              </div>
            </div>
            ${log ? `<pre class="env-install-log">${log}</pre>` : ''}
          </div>
        </div>
      </details>`;
    } else {
      const xfStatusBadge = this.xfError
        ? `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>`
        : !xs
          ? `<span class="env-badge env-badge-loading">${T('loading', 'Loading...')}</span>`
          : xfInstalled
            ? `<span class="env-badge env-badge-ok">${T('installed', 'Installed')} &middot; v${xs.version || '?'}</span>`
            : `<span class="env-badge env-badge-warn">${T('notInstalled', 'Not installed')}</span>`;

      html += `<details id="env-xformers" ${this.xfCardOpen ? 'open' : ''} class="env-card">
        <summary class="env-card-summary">
          <span class="env-chevron"></span>
          <span class="env-card-title">xformers</span>
          <span class="env-card-hint">${T('xfHint', 'Memory-efficient attention (optional)')}</span>
          <span class="env-card-hint">${T('xfRestartHint', 'xformers is a compiled extension. After install, restart the GUI.')}</span>
          ${xfStatusBadge}
        </summary>
        <div class="env-card-body">`;

      if (this.xfError) {
        html += `<div class="env-msg env-msg-err"><pre>${this.xfError}</pre></div>`;
      }

      if (xs) {
        const xfRows = [
          ['xformers', xfInstalled ? `v${xs.version || '?'}` : `<span class="env-text-warn">${T('notInstalled', 'Not installed')}</span>`],
          ['Python', xfEnv.python_tag || '<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
          ['PyTorch', xfEnv.torch_ver ? `${xfEnv.torch_ver}` : '<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
          ['CUDA', xfEnv.cuda_ver ? `cu${xfEnv.cuda_ver.replace('.','')}` : '<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
        ];
        html += `<table class="env-table"><tbody>`;
        xfRows.forEach(([label, value]) => {
          html += `<tr><td class="env-table-label">${label}</td><td class="env-table-value">${value}</td></tr>`;
        });
        html += `</tbody></table>`;

        if (!xfInstalled) {
          html += `<div class="env-msg env-msg-info">${T('xfInstallInfo', 'Installs the latest compatible version from PyPI, auto-matched to your environment.')}</div>`;
        }

        html += `<div class="env-actions">
          <button id="xf-install-btn" class="btn btn-secondary" ${this.xfBusy ? 'disabled' : ''}>
            ${xfInstalled ? T('reinstall', 'Reinstall') : T('xfInstallBtn', 'Install via PyPI')}
          </button>
          <button id="xf-refresh-btn" class="btn-icon" ${this.xfBusy ? 'disabled' : ''}
            title="${T('refresh', 'Refresh')}">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
        </div>`;
      }

      html += `</div></details>`;
    }

    // ═══════════════════════════════════════════════════
    //  Section: 训练核心 (sd-scripts)
    // ═══════════════════════════════════════════════════
    html += `<div class="env-section-header">${T('sectionCore', 'Training Core')}</div>`;

    const sd = this.sdStatus;
    const sdLocal = sd?.local || {};
    const sdLatest = sd?.latest_release;
    const sdReleases = sd?.recent_releases || [];
    const sdCommits = sd?.recent_commits || [];
    const sdUpdateAvail = sd?.update_available;
    const sdFetchErr = sd?.releases_error || sd?.commits_error;

    const sdBadge = this.sdError
      ? `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>`
      : !sd
        ? `<span class="env-badge env-badge-loading">${T('loading', 'Loading...')}</span>`
        : sdUpdateAvail
          ? `<span class="env-badge env-badge-warn">${T('sdScriptsUpdateAvailable', 'Update available')}</span>`
          : `<span class="env-badge env-badge-ok">${T('sdScriptsUpToDate', 'Up to date')}</span>`;

    html += `<details id="env-sdscripts" ${this.sdCardOpen ? 'open' : ''} class="env-card">
      <summary class="env-card-summary">
        <span class="env-chevron"></span>
        <span class="env-card-title">${T('sdScriptsTitle', 'sd-scripts')}</span>
        <span class="env-card-hint">${T('sdScriptsDesc', 'Training core engine (kohya-ss/sd-scripts)')}</span>
        ${this.sdBusy ? `<span class="env-badge env-badge-loading">${T('sdScriptsUpdating', 'Updating...')}</span>` : sdBadge}
      </summary>
      <div class="env-card-body">`;

    if (this.sdError) {
      html += `<div class="env-msg env-msg-err"><pre>${this.sdError}</pre></div>`;
    }

    // Show update progress when busy
    if (this.sdBusy) {
      const elapsed = this._formatElapsed(this.sdInstallElapsed);
      const log = this.sdInstallLog || '';
      html += `<div class="env-install-progress">
        <div class="env-install-row">
          <div class="env-install-spinner"></div>
          <div class="env-progress-info">
            <span>${T('sdScriptsUpdating', 'Updating...')}</span>
            <span class="env-progress-time">${elapsed}</span>
          </div>
        </div>
        ${log ? `<pre class="env-install-log">${log}</pre>` : ''}
      </div>`;
    }

    if (sd && !this.sdBusy) {
      // Local info table
      html += `<table class="env-table"><tbody>`;
      const localRows = [
        [T('sdScriptsRepo', 'Upstream repo'),
          `<a href="https://github.com/${sdLocal.repo || 'kohya-ss/sd-scripts'}" target="_blank" rel="noopener" class="env-link">${sdLocal.repo || 'kohya-ss/sd-scripts'} <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`],
        [T('sdScriptsBranch', 'Branch'), sdLocal.local_branch || '<span class="env-text-dim">-</span>'],
        [sdLocal.tag ? 'Tag' : null, sdLocal.tag ? `<a href="https://github.com/${sdLocal.repo || 'kohya-ss/sd-scripts'}/releases/tag/${sdLocal.tag}" target="_blank" rel="noopener" class="env-link"><code>${sdLocal.tag}</code></a>` : null],
        [T('sdScriptsCommit', 'Commit'),
          sdLocal.local_commit
            ? `<a href="https://github.com/${sdLocal.repo || 'kohya-ss/sd-scripts'}/commit/${sdLocal.local_commit}" target="_blank" rel="noopener" class="env-link"><code>${sdLocal.local_commit}</code></a>`
            : '<span class="env-text-dim">UNKNOWN</span>'],
        [T('sdScriptsSyncDate', 'Sync date'), sdLocal.sync_date || '<span class="env-text-dim">-</span>'],
      ].filter(r => r[0] !== null);
      localRows.forEach(([label, value]) => {
        html += `<tr><td class="env-table-label">${label}</td><td class="env-table-value">${value}</td></tr>`;
      });
      html += `</tbody></table>`;

      // Fetch error / cache notice — 静默处理，仅在完全没有数据时提示
      if (sdFetchErr && !sdReleases.length && !sdCommits.length && !sdLatest) {
        html += `<div class="env-msg env-msg-warn">${T('sdScriptsFetchError', 'GitHub API 请求失败')}: ${sdFetchErr}</div>`;
      }

      // Latest release info
      if (sdLatest) {
        const bodyText = sdLatest.body || '';
        const bodyLen = bodyText.length;
        const releaseId = 'sd-release-body-' + (sdLatest.tag_name || 'latest');
        html += `<div class="env-subsection">
          <div class="env-subsection-title">${T('sdScriptsLatestRelease', 'Latest Release')}</div>`;
        html += `<div class="env-release-card">
          <div class="env-release-header">
            <a href="${sdLatest.html_url || '#'}" target="_blank" rel="noopener" class="env-link env-release-tag">
              ${sdLatest.tag_name || '?'}
            </a>
            ${sdLatest.prerelease ? `<span class="env-badge env-badge-warn env-badge-sm">${T('sdScriptsPrerelease', 'Pre-release')}</span>` : ''}
            <span class="env-text-dim">${sdLatest.published_at ? new Date(sdLatest.published_at).toLocaleDateString() : ''}</span>
            ${sdLatest.html_url ? `<a href="${sdLatest.html_url}" target="_blank" rel="noopener" class="env-link" style="margin-left:auto">GitHub &#8599;</a>` : ''}
          </div>
          ${bodyText ? `
          <div class="env-release-body-wrap">
            <pre class="env-release-body" id="${releaseId}">${bodyText}</pre>
            ${bodyLen > 400 ? `<button class="btn btn-ghost btn-sm env-release-toggle" data-target="${releaseId}">${T('sdScriptsShowMore', '展开全部')}</button>` : ''}
          </div>` : ''}
        </div></div>`;
      }

      // Latest main branch HEAD info
      const sdMain = sd?.latest_main_commit;
      if (sdMain && sdMain.sha) {
        html += `<div class="env-subsection">
          <div class="env-subsection-title">${T('sdScriptsMainHead', 'main branch HEAD')}</div>`;
        html += `<div class="env-release-card">
          <div class="env-release-header">
            <a href="${sdMain.html_url || '#'}" target="_blank" rel="noopener" class="env-link"><code>${sdMain.sha}</code></a>
            <span class="env-text-dim">${sdMain.date ? new Date(sdMain.date).toLocaleDateString() : ''}</span>
          </div>
          <span class="env-commit-msg">${sdMain.message || ''}</span>
        </div></div>`;
      }

      // Recent releases toggle
      if (sdReleases.length > 1) {
        html += `<div class="env-actions">
          <button id="sd-releases-btn" class="btn btn-ghost btn-sm">
            ${this.sdReleasesOpen ? '▲ ' + T('hideCandidates', 'Hide') : '▼ ' + T('sdScriptsLatestReleaseTag', 'Recent releases') + ' (' + (sdReleases.length - 1) + ')'}
          </button>
        </div>`;
        if (this.sdReleasesOpen) {
          html += `<ul class="env-candidate-list">`;
          sdReleases.slice(1).forEach(rel => {
            html += `<li class="env-candidate-item">
              <a href="${rel.html_url || '#'}" target="_blank" rel="noopener" class="env-link">${rel.tag_name || '?'}</a>
              ${rel.prerelease ? `<span class="env-badge env-badge-warn env-badge-sm">${T('sdScriptsPrerelease', 'Pre-release')}</span>` : ''}
              <span class="env-text-dim">${rel.published_at ? new Date(rel.published_at).toLocaleDateString() : ''}</span>
            </li>`;
          });
          html += `</ul>`;
        }
      }

      // Recent commits
      if (sdCommits.length) {
        html += `<div class="env-subsection">
          <div class="env-subsection-title">${T('sdScriptsRecentCommits', 'Recent Commits')}</div>`;
        html += `<ul class="env-commit-list">`;
        sdCommits.slice(0, 5).forEach(c => {
          html += `<li class="env-commit-item">
            <a href="${c.html_url || '#'}" target="_blank" rel="noopener" class="env-link"><code>${c.sha || '?'}</code></a>
            <span class="env-commit-msg">${c.message || ''}</span>
            <span class="env-text-dim">${c.date ? new Date(c.date).toLocaleDateString() : ''}</span>
          </li>`;
        });
        html += `</ul></div>`;
      }

      // Confirm dialog
      if (this.sdUpdateConfirmMsg) {
        html += `<div class="env-actions">
          <div class="env-confirm">
            <span class="env-confirm-msg">${this.sdUpdateConfirmMsg}</span>
            <button id="sd-confirm-yes" class="btn btn-sm btn-primary">${T('confirmYes', '确认')}</button>
            <button id="sd-confirm-no" class="btn btn-sm btn-ghost">${T('confirmNo', '取消')}</button>
          </div>
        </div>`;
      }

      // Actions
      html += `<div class="env-actions">
        <a href="https://github.com/${sdLocal.repo || 'kohya-ss/sd-scripts'}" target="_blank" rel="noopener" class="btn btn-secondary">
          ${T('sdScriptsOpenRepo', 'Open repo')} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </a>
        <button id="sd-update-release-btn" class="btn btn-sm btn-primary" ${this.sdBusy ? 'disabled' : ''}
          title="${T('sdScriptsUpdateToRelease', 'Update to latest Release')}">
          ${T('sdScriptsUpdateToRelease', 'Update to latest Release')}
        </button>
        <button id="sd-update-main-btn" class="btn btn-sm btn-secondary" ${this.sdBusy ? 'disabled' : ''}
          title="${T('sdScriptsUpdateToMain', 'Update to latest main')}">
          ${T('sdScriptsUpdateToMain', 'Update to latest main')}
        </button>
        <button id="sd-refresh-btn" class="btn-icon"
          title="${T('refresh', 'Refresh')}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>`;
    }

    html += `</div></details>`;

    el.innerHTML = html;

    // ── Bind Flash Attention events ──────────────────────
    const a = window.__anima || this;
    const autoBtn = el.querySelector('#fa-auto-btn');
    const faRefreshBtn = el.querySelector('#fa-refresh-btn');
    const toggleBtn = el.querySelector('#fa-toggle-btn');
    if (autoBtn) autoBtn.addEventListener('click', () => a.faInstall(null));
    if (faRefreshBtn) faRefreshBtn.addEventListener('click', () => a.faRefresh());
    if (toggleBtn) toggleBtn.addEventListener('click', () => { a.faCandidatesOpen = !a.faCandidatesOpen; a.renderEnvironment(); });
    el.querySelectorAll('.env-source-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.id === 'fa-src-mirror') a.faSource = 'mirror';
        else if (btn.id === 'fa-src-fallback') a.faSource = 'fallback';
        else a.faSource = 'default';
        a.faRefresh();
      });
    });
    const faConfirmYes = el.querySelector('#fa-confirm-yes');
    const faConfirmNo = el.querySelector('#fa-confirm-no');
    if (faConfirmYes) faConfirmYes.addEventListener('click', () => {
      const cb = a.faConfirmCallback;
      a.faDismissConfirm();
      if (cb) cb();
    });
    if (faConfirmNo) faConfirmNo.addEventListener('click', () => a.faDismissConfirm());
    el.querySelectorAll('.fa-candidate-btn').forEach(btn => {
      btn.addEventListener('click', () => a.faInstall(btn.dataset.url));
    });
    const urlInput = el.querySelector('#fa-manual-input');
    const urlBtn = el.querySelector('#fa-url-btn');
    if (urlInput && urlBtn) {
      urlInput.value = a.faManualUrl || '';
      urlInput.addEventListener('input', () => { a.faManualUrl = urlInput.value; });
      urlBtn.addEventListener('click', () => { if (a.faManualUrl && a.faManualUrl.trim()) a.faInstall(a.faManualUrl.trim()); });
    }

    // ── Bind xformers events ─────────────────────────────
    const xfInstallBtn = el.querySelector('#xf-install-btn');
    const xfRefreshBtn = el.querySelector('#xf-refresh-btn');
    if (xfInstallBtn) xfInstallBtn.addEventListener('click', () => a.xfInstall());
    if (xfRefreshBtn) xfRefreshBtn.addEventListener('click', () => a.xfRefresh());

    // ── Bind sd-scripts events ──────────────────────────
    const sdRefreshBtn = el.querySelector('#sd-refresh-btn');
    if (sdRefreshBtn) sdRefreshBtn.addEventListener('click', () => a.sdRefresh());
    const sdReleasesBtn = el.querySelector('#sd-releases-btn');
    if (sdReleasesBtn) sdReleasesBtn.addEventListener('click', () => {
      a.sdReleasesOpen = !a.sdReleasesOpen;
      a.renderEnvironment();
    });
    const sdUpdateReleaseBtn = el.querySelector('#sd-update-release-btn');
    if (sdUpdateReleaseBtn) sdUpdateReleaseBtn.addEventListener('click', () => a.sdUpdate('release'));
    const sdUpdateMainBtn = el.querySelector('#sd-update-main-btn');
    if (sdUpdateMainBtn) sdUpdateMainBtn.addEventListener('click', () => a.sdUpdate('main'));
    const sdConfirmYes = el.querySelector('#sd-confirm-yes');
    const sdConfirmNo = el.querySelector('#sd-confirm-no');
    if (sdConfirmYes) sdConfirmYes.addEventListener('click', () => {
      const cb = a.sdUpdateConfirmCallback;
      a.sdDismissConfirm();
      if (cb) cb();
    });
    if (sdConfirmNo) sdConfirmNo.addEventListener('click', () => a.sdDismissConfirm());

    // ── Release body toggle ─────────────────────────────
    el.querySelectorAll('.env-release-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const pre = document.getElementById(targetId);
        if (!pre) return;
        const isExpanded = pre.classList.toggle('expanded');
        btn.textContent = isExpanded
          ? (a.t('environment.sdScriptsShowLess') || '收起')
          : (a.t('environment.sdScriptsShowMore') || '展开全部');
      });
    });

    // ── Persist card open/close state ────────────────────
    const faCard = el.querySelector('#env-flash-attn');
    const xfCard = el.querySelector('#env-xformers');
    const sdCard = el.querySelector('#env-sdscripts');
    if (faCard) faCard.addEventListener('toggle', () => {
      a.faCardOpen = faCard.open;
      a._envSaveCardState();
    });
    if (xfCard) xfCard.addEventListener('toggle', () => {
      a.xfCardOpen = xfCard.open;
      a._envSaveCardState();
    });
    if (sdCard) sdCard.addEventListener('toggle', () => {
      a.sdCardOpen = sdCard.open;
      a._envSaveCardState();
    });
  },
};
