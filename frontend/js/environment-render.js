/* ================================================================
   environment-render.js — renderEnvironment + event bindings
   Mixin merged into animaApp Alpine component
   ================================================================ */

window.environmentRenderMixin = {
  renderEnvironment() {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    let html = '';

    html += `<div class="env-section"><div class="env-section-header">${T('sectionAccel', 'Acceleration')}</div>`;
    html += this._renderFaRow(T);
    html += this._renderXfRow(T);
    html += `</div>`;

    html += `<div class="env-section"><div class="env-section-header">${T('sectionCore', 'Training Core')}</div>`;
    html += this._renderSdRow(T);
    html += `</div>`;

    el.innerHTML = html;
    this._bindFaEvents(el, T);
    this._bindXfEvents(el);
    this._bindCardToggle(el);
  },

  // ═══════════════════════════════════════════════════════
  //  Flash Attention row
  // ═══════════════════════════════════════════════════════
  _renderFaRow(T) {
    const s = this.faStatus;
    const env = s?.env || {};
    const candidates = s?.candidates || [];
    const usable = candidates.filter(c => c.usable);
    const best = usable[0] || null;
    const canAuto = !!env.torch_tag && !!env.platform && usable.length > 0;
    const faInstalled = s?.installed;
    let h = '';

    const faBadge = this.faError
      ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !s ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : faInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')} &middot; v${s.version||'?'}</span>`
      : `<span class="env-badge env-badge-warn">${T('notInstalled','Not installed')}</span>`;

    h += `<details id="env-flash-attn" ${this.faCardOpen?'open':''} class="env-row">`;
    h += `<summary class="env-row-summary"><span class="env-row-arrow">&#9654;</span><span class="env-row-title">Flash Attention</span><span class="env-row-subtitle">${T('trainingAccel','Training acceleration (optional)')}</span>${faBadge}</summary>`;
    h += `<div class="env-row-detail">`;

    if (this.faBusy) {
      const elapsed = this._formatElapsed(this.faInstallElapsed);
      const log = this.faInstallLog || '';
      h += `<div class="env-install-progress"><div class="env-install-row"><div class="env-install-spinner"></div><div class="env-progress-info"><span>${T('installingHint','Downloading...')}</span><span class="env-progress-time">${elapsed}</span></div></div>${log?`<pre class="env-install-log">${log}</pre>`:''}</div>`;
      h += `</div></details>`;
      return h;
    }

    if (this.faError) h += `<div class="env-msg env-msg-err"><pre>${this.faError}</pre></div>`;

    if (s) {
      // Environment info
      const envItems = [];
      if (faInstalled) envItems.push(`<span class="env-env-item">flash_attn <em>v${s.version||'?'}</em></span>`);
      if (env.python_tag) envItems.push(`<span class="env-env-item"><em>${env.python_tag}</em></span>`);
      if (env.cuda_tag) envItems.push(`<span class="env-env-item">CUDA <em>${env.cuda_tag}</em> <span class="env-text-dim">(${env.cuda_ver||'?'})</span></span>`);
      if (env.torch_tag) envItems.push(`<span class="env-env-item">PyTorch <em>${env.torch_tag}</em></span>`);
      if (env.platform) envItems.push(`<span class="env-env-item"><em>${env.platform}</em></span>`);
      h += `<div class="env-detail-group"><span class="env-detail-label">${T('envLabel','Env')}</span><div class="env-detail-content">${envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`}</div></div>`;

      // Error / info messages
      if (s.fetch_error) {
        if (s.from_disk_cache) h+=`<div class="env-msg env-msg-info">${T('usingCachedData','Using cached data.')} ${T('cachedDataHint','Auto-updates on next success.')}</div>`;
        else if (/rate limit|限流/i.test(s.fetch_error)) h+=`<div class="env-msg env-msg-warn">${T('githubApiFail','GitHub API unavailable')}<br>${T('rateLimitHint','Will retry. Paste URL manually.')}</div>`;
        else h+=`<div class="env-msg env-msg-warn">${T('githubApiFail','GitHub API unavailable')}: ${s.fetch_error}<br>${T('manualUrlHint','Paste wheel URL manually.')}</div>`;
      }

      // Confirm dialog
      if (this.faConfirmMsg) {
        h+=`<div class="env-confirm"><span class="env-confirm-msg">${this.faConfirmMsg}</span><button id="fa-confirm-yes" class="btn btn-sm btn-primary">${T('confirmYes','Confirm')}</button><button id="fa-confirm-no" class="btn btn-sm btn-ghost">${T('confirmNo','Cancel')}</button></div>`;
      } else {
        // Install group
        h += `<div class="env-detail-group"><span class="env-detail-label">${T('installLabel','Install')}</span><div class="env-detail-content" style="flex-direction:column;align-items:flex-start;">`;
        h += `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">`;
        h += `<span class="env-source-group"><button id="fa-src-default" class="env-source-btn ${this.faSource==='default'?'active':''}">${T('sourceDefault','Official')}</button><button id="fa-src-mirror" class="env-source-btn ${this.faSource==='mirror'?'active':''}">${T('sourceMirror','Mirror')}</button><button id="fa-src-fallback" class="env-source-btn ${this.faSource==='fallback'?'active':''}">${T('sourceFallback','Alt')}</button></span>`;
        if (best) {
          h += `<button id="fa-best-install-btn" class="btn btn-sm btn-secondary" ${this.faBusy?'disabled':''} data-url="${best.url.replace(/'/g,"\\'")}">${T('installThis','Install this')}</button>`;
          h += `<code style="font-size:10.5px;color:var(--text-tertiary);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;" title="${best.name}">${best.name}</code>`;
        }
        h += `</div>`;

        // Candidates toggle
        h += `<button id="fa-toggle-btn" class="btn btn-ghost btn-sm" style="margin-top:4px;">${this.faCandidatesOpen ? T('hideAllCandidates','Hide all') : T('showAllCandidates','Show all') + ' (' + candidates.length + ')'}</button>`;

        // Candidate list
        if (this.faCandidatesOpen && candidates.length) {
          h += `<ul class="env-candidate-list" style="margin-top:4px;">`;
          candidates.forEach(c => {
            const mark = c.usable?'ok':'warn';
            h += `<li class="env-candidate-item"><span class="env-candidate-mark env-candidate-${mark}">${c.usable?'&#10003;':'&#10007;'}</span><code class="env-candidate-name" title="${c.name}">${c.name}</code>${c.notes.length?`<span class="env-candidate-notes">${c.notes.map(n=>typeof n==='string'?n:(T('faNote.'+n.key)||n.text||n.key)).join('; ')}</span>`:''}<button class="fa-candidate-btn btn btn-sm ${c.usable?'btn-secondary':'btn-ghost'}" data-url="${c.url.replace(/'/g,"\\'")}">${c.usable?T('install','Install'):T('forceInstall','Force')}</button></li>`;
          });
          h += `</ul>`;
        }

        // Manual URL
        h += `<div class="env-manual-url" style="margin-top:4px;"><input type="text" class="env-url-input" placeholder="https://github.com/.../flash_attn-...whl" id="fa-manual-input"><button id="fa-url-btn" class="btn btn-secondary">${T('installUrl','URL Install')}</button></div>`;
        h += `</div></div>`;
      }

      // Actions
      h += `<div class="env-detail-group"><span class="env-detail-label">${T('actionLabel','Actions')}</span><div class="env-detail-content"><div class="env-actions"><button id="fa-auto-btn" class="btn btn-secondary" ${this.faBusy||!canAuto?'disabled':''} title="${best?best.name:''}">${faInstalled?T('reinstall','Reinstall'):T('autoInstall','Auto Install')}</button><button id="fa-refresh-btn" class="btn-icon" ${this.faBusy?'disabled':''} title="${T('refresh','Refresh')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button></div></div></div>`;
    }

    h += `</div></details>`;
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  xformers row
  // ═══════════════════════════════════════════════════════
  _renderXfRow(T) {
    const xs = this.xfStatus; const xfEnv = xs?.env || {}; const xfInstalled = xs?.installed;
    let h = '';

    const xfBadge = this.xfError ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !xs ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : xfInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')} &middot; v${xs.version||'?'}</span>`
      : `<span class="env-badge env-badge-warn">${T('notInstalled','Not installed')}</span>`;

    h += `<details id="env-xformers" ${this.xfCardOpen?'open':''} class="env-row">`;
    h += `<summary class="env-row-summary"><span class="env-row-arrow">&#9654;</span><span class="env-row-title">xformers</span><span class="env-row-subtitle">${T('xfHint','Memory-efficient attention (optional)')}</span>${xfBadge}</summary>`;
    h += `<div class="env-row-detail">`;

    if (this.xfBusy) {
      const elapsed = this._formatElapsed(this.xfInstallElapsed);
      h += `<div class="env-install-progress"><div class="env-install-row"><div class="env-install-spinner"></div><div class="env-progress-info"><span>${T('xfInstallingHint','Downloading...')}</span><span class="env-progress-time">${elapsed}</span></div></div>${this.xfInstallLog?`<pre class="env-install-log">${this.xfInstallLog}</pre>`:''}</div>`;
      h += `</div></details>`;
      return h;
    }

    if (this.xfError) h += `<div class="env-msg env-msg-err"><pre>${this.xfError}</pre></div>`;

    if (xs) {
      const envItems = [];
      if (xfInstalled) envItems.push(`<span class="env-env-item">xformers <em>v${xs.version||'?'}</em></span>`);
      if (xfEnv.python_tag) envItems.push(`<span class="env-env-item"><em>${xfEnv.python_tag}</em></span>`);
      if (xfEnv.torch_ver) envItems.push(`<span class="env-env-item">PyTorch <em>${xfEnv.torch_ver}</em></span>`);
      if (xfEnv.cuda_ver) envItems.push(`<span class="env-env-item">CUDA <em>cu${xfEnv.cuda_ver.replace('.','')}</em></span>`);
      h += `<div class="env-detail-group"><span class="env-detail-label">${T('envLabel','Env')}</span><div class="env-detail-content">${envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`}</div></div>`;

      if (!xfInstalled) h += `<div class="env-msg env-msg-info">${T('xfInstallInfo','Installs latest compatible version from PyPI.')}</div>`;

      h += `<div class="env-detail-group"><span class="env-detail-label">${T('actionLabel','Actions')}</span><div class="env-detail-content"><div class="env-actions"><button id="xf-install-btn" class="btn btn-secondary" ${this.xfBusy?'disabled':''}>${xfInstalled?T('reinstall','Reinstall'):T('xfInstallBtn','Install via PyPI')}</button><button id="xf-refresh-btn" class="btn-icon" ${this.xfBusy?'disabled':''} title="${T('refresh','Refresh')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button></div></div></div>`;
    }

    h += `</div></details>`;
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  sd-scripts row
  // ═══════════════════════════════════════════════════════
  _renderSdRow(T) {
    const sd = this.sdStatus; const sdLocal = sd?.local || {};
    let h = '';

    const sdBadge = !sd
      ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : `<span class="env-badge env-badge-ok">${T('sdScriptsUpToDate','Up to date')}</span>`;

    h += `<details id="env-sdscripts" ${this.sdCardOpen?'open':''} class="env-row">`;
    h += `<summary class="env-row-summary"><span class="env-row-arrow">&#9654;</span><span class="env-row-title">${T('sdScriptsTitle','sd-scripts')}</span><span class="env-row-subtitle">${T('sdScriptsDesc','kohya-ss/sd-scripts')}</span>${sdBadge}</summary>`;
    h += `<div class="env-row-detail">`;

    if (sd) {
      const repoUrl = sd.repo_url || `https://github.com/${sdLocal.repo||'kohya-ss/sd-scripts'}`;
      const verItems = [
        `<span class="env-env-item">Repo <a href="${repoUrl}" target="_blank" rel="noopener" class="env-link">${sdLocal.repo||'kohya-ss/sd-scripts'} &#8599;</a></span>`,
        sdLocal.local_branch ? `<span class="env-env-item">Branch <em>${sdLocal.local_branch}</em></span>` : null,
        sdLocal.tag ? `<span class="env-env-item">Tag <a href="${repoUrl}/releases/tag/${sdLocal.tag}" target="_blank" rel="noopener" class="env-link"><code>${sdLocal.tag}</code></a></span>` : null,
        sdLocal.local_commit ? `<span class="env-env-item">Commit <a href="${repoUrl}/commit/${sdLocal.local_commit}" target="_blank" rel="noopener" class="env-link"><code>${sdLocal.local_commit.slice(0,8)}</code></a></span>` : null,
        sdLocal.sync_date ? `<span class="env-env-item">Sync <span class="env-text-dim">${sdLocal.sync_date}</span></span>` : null,
      ].filter(r=>r);
      h += `<div class="env-detail-group"><span class="env-detail-label">${T('verLabel','Ver')}</span><div class="env-detail-content">${verItems.join(' &middot; ')}</div></div>`;

      h += `<div class="env-detail-group"><span class="env-detail-label"></span><div class="env-detail-content"><a href="${repoUrl}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">${T('sdScriptsOpenRepo','Open repo')} &#8599;</a></div></div>`;
    }
    h += `</div></details>`;
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  Event bindings
  // ═══════════════════════════════════════════════════════
  _bindFaEvents(el, T) {
    const a = window.__anima || this;
    const autoBtn = el.querySelector('#fa-auto-btn');
    const faRefreshBtn = el.querySelector('#fa-refresh-btn');
    const toggleBtn = el.querySelector('#fa-toggle-btn');
    if (autoBtn) autoBtn.addEventListener('click', () => a.faInstall(null));
    if (faRefreshBtn) faRefreshBtn.addEventListener('click', () => a.faRefresh());
    if (toggleBtn) toggleBtn.addEventListener('click', () => { a.faCandidatesOpen = !a.faCandidatesOpen; a.renderEnvironment(); });
    const bestInstallBtn = el.querySelector('#fa-best-install-btn');
    if (bestInstallBtn) bestInstallBtn.addEventListener('click', () => a.faInstall(bestInstallBtn.dataset.url));
    el.querySelectorAll('.env-source-btn').forEach(btn => { btn.addEventListener('click', () => {
      if (btn.id === 'fa-src-mirror') a.faSource = 'mirror'; else if (btn.id === 'fa-src-fallback') a.faSource = 'fallback'; else a.faSource = 'default';
      a.faRefresh();
    });});
    const faConfirmYes = el.querySelector('#fa-confirm-yes'), faConfirmNo = el.querySelector('#fa-confirm-no');
    if (faConfirmYes) faConfirmYes.addEventListener('click', () => { const cb = a.faConfirmCallback; a.faDismissConfirm(); if (cb) cb(); });
    if (faConfirmNo) faConfirmNo.addEventListener('click', () => a.faDismissConfirm());
    el.querySelectorAll('.fa-candidate-btn').forEach(btn => { btn.addEventListener('click', () => a.faInstall(btn.dataset.url)); });
    const urlInput = el.querySelector('#fa-manual-input'), urlBtn = el.querySelector('#fa-url-btn');
    if (urlInput && urlBtn) { urlInput.value = a.faManualUrl || ''; urlInput.addEventListener('input', () => { a.faManualUrl = urlInput.value; }); urlBtn.addEventListener('click', () => { if (a.faManualUrl && a.faManualUrl.trim()) a.faInstall(a.faManualUrl.trim()); }); }
  },

  _bindXfEvents(el) {
    const a = window.__anima || this;
    const xfInstallBtn = el.querySelector('#xf-install-btn'), xfRefreshBtn = el.querySelector('#xf-refresh-btn');
    if (xfInstallBtn) xfInstallBtn.addEventListener('click', () => a.xfInstall());
    if (xfRefreshBtn) xfRefreshBtn.addEventListener('click', () => a.xfRefresh());
  },

  _bindCardToggle(el) {
    const a = window.__anima || this;
    ['env-flash-attn','env-xformers','env-sdscripts'].forEach(id => {
      const card = el.querySelector('#'+id); if (!card) return;
      card.addEventListener('toggle', () => {
        if (id==='env-flash-attn') a.faCardOpen = card.open;
        else if (id==='env-xformers') a.xfCardOpen = card.open;
        else a.sdCardOpen = card.open;
        a._envSaveCardState();
      });
    });
  }
};
