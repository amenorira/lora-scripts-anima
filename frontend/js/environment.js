/* ================================================================
   environment.js — Flash Attention management page
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.environmentMixin = {
  // ── State ──────────────────────────────────────────────
  faStatus: null,
  faBusy: false,
  faError: null,
  faManualUrl: '',
  faCandidatesOpen: false,
  faConfirmMsg: null,
  faConfirmCallback: null,
  faSource: 'default',

  // ── Methods ────────────────────────────────────────────
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
    if (!this.faStatus) {
      el.innerHTML = `<div class="env-loading">
        <div class="env-spinner"></div>
        <p>${this.t('environment.loading') || 'Loading environment info...'}</p>
      </div>`;
      await this.faRefresh(true);
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
      this.startProgress();
      this.renderEnvironment();
      try {
        const r = await fetch('/api/flash-attention/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url || null, source: this.faSource || 'default' })
        });
        const result = await r.json();
        if (result.success) {
          this.faError = null;
          await this.faRefresh(true);
        } else {
          this.faError = result.error || 'Installation failed';
        }
      } catch (e) {
        this.faError = String(e);
      } finally {
        this.faBusy = false;
        this.finishProgress();
        this.renderEnvironment();
      }
    });
  },

  renderEnvironment() {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    const s = this.faStatus;
    const env = s?.env || {};
    const candidates = s?.candidates || [];
    const usable = candidates.filter(c => c.usable);
    const best = usable[0] || null;
    const canAuto = !!env.torch_tag && !!env.platform && usable.length > 0;

    if (this.faBusy) {
      el.innerHTML = `<div class="env-loading">
        <div class="env-spinner"></div>
        <p>${T('installingHint', 'Downloading & installing (2-5 min, ~150MB)...')}</p>
        <p style="font-size:11px;color:var(--text-tertiary);margin-top:4px">${T('installingHint2', 'Do not close this page')}</p>
      </div>`;
      return;
    }

    let html = '';

    const installed = s?.installed;
    const statusBadge = this.faError
      ? `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>`
      : !s
        ? `<span class="env-badge env-badge-loading">${T('loading', 'Loading...')}</span>`
        : installed
          ? `<span class="env-badge env-badge-ok">${T('installed', 'Installed')} &middot; v${s.version || '?'}</span>`
          : `<span class="env-badge env-badge-warn">${T('notInstalled', 'Not installed')}</span>`;

    html += `<details id="env-flash-attn" open class="env-card">
      <summary class="env-card-summary">
        <span class="env-chevron"></span>
        <span class="env-card-title">Flash Attention</span>
        <span class="env-card-hint">${T('trainingAccel', 'Training acceleration (optional)')}</span>
        ${statusBadge}
      </summary>
      <div class="env-card-body">`;

    if (this.faError) {
      html += `<div class="env-msg env-msg-err"><pre>${this.faError}</pre></div>`;
    }

    if (s) {
      const rows = [
        ['flash_attn', installed ? `v${s.version || '?'}` : `<span class="env-text-warn">${T('notInstalled', 'Not installed')}</span>`],
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
          // 磁盘缓存兜底（透明，用户无需关心）
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
            ${installed ? T('reinstall', 'Reinstall') : T('autoInstall', 'Auto Install')}
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

    html += `<p class="env-hint">${T('restartHint', 'Flash Attention is a C extension. After install, restart the GUI for changes to take effect.')}</p>`;

    el.innerHTML = html;

    const a = window.__anima || this;
    const autoBtn = el.querySelector('#fa-auto-btn');
    const refreshBtn = el.querySelector('#fa-refresh-btn');
    const toggleBtn = el.querySelector('#fa-toggle-btn');
    if (autoBtn) autoBtn.addEventListener('click', () => a.faInstall(null));
    if (refreshBtn) refreshBtn.addEventListener('click', () => a.faRefresh());
    if (toggleBtn) toggleBtn.addEventListener('click', () => { a.faCandidatesOpen = !a.faCandidatesOpen; a.renderEnvironment(); });
    el.querySelectorAll('.env-source-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.id === 'fa-src-mirror') a.faSource = 'mirror';
        else if (btn.id === 'fa-src-fallback') a.faSource = 'fallback';
        else a.faSource = 'default';
        a.faRefresh();
      });
    });
    const confirmYes = el.querySelector('#fa-confirm-yes');
    const confirmNo = el.querySelector('#fa-confirm-no');
    if (confirmYes) confirmYes.addEventListener('click', () => {
      const cb = a.faConfirmCallback;
      a.faDismissConfirm();
      if (cb) cb();
    });
    if (confirmNo) confirmNo.addEventListener('click', () => a.faDismissConfirm());
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
  },
};
