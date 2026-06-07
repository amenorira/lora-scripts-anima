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

    // ═══ Section: 加速库 ═══
    html += `<div class="env-section"><div class="env-section-header">${T('sectionAccel', 'Acceleration')}</div><div class="env-section-grid">`;
    html += this._renderFaCard(T);
    html += this._renderXfCard(T);
    html += `</div></div>`;

    // ═══ Section: 训练核心 ═══
    html += `<div class="env-section"><div class="env-section-header">${T('sectionCore', 'Training Core')}</div><div class="env-section-grid">`;
    html += this._renderSdCard(T);
    html += `</div></div>`;

    el.innerHTML = html;

    // ── Bind events ──
    this._bindFaEvents(el, T);
    this._bindXfEvents(el);
    this._bindCardToggle(el);
  },

  // ═══════════════════════════════════════════════════════
  //  Flash Attention card render
  // ═══════════════════════════════════════════════════════
  _renderFaCard(T) {
    const s = this.faStatus;
    const env = s?.env || {};
    const candidates = s?.candidates || [];
    const usable = candidates.filter(c => c.usable);
    const best = usable[0] || null;
    const canAuto = !!env.torch_tag && !!env.platform && usable.length > 0;
    const faInstalled = s?.installed;
    let h = '';

    if (this.faBusy) {
      const elapsed = this._formatElapsed(this.faInstallElapsed);
      const log = this.faInstallLog || '';
      h += `<details id="env-flash-attn" ${this.faCardOpen?'open':''} class="env-card">
        <summary class="env-card-summary"><span class="env-chevron"></span><span class="env-card-title">Flash Attention</span><span class="env-badge env-badge-loading">${T('installing','Installing...')}</span></summary>
        <div class="env-card-body"><div class="env-install-progress"><div class="env-install-row"><div class="env-install-spinner"></div><div class="env-progress-info"><span>${T('installingHint','Downloading...')}</span><span class="env-progress-time">${elapsed}</span></div></div>${log?`<pre class="env-install-log">${log}</pre>`:''}</div></div></details>`;
      return h;
    }

    const faStatusBadge = this.faError
      ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !s ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : faInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')} &middot; v${s.version||'?'}</span>`
      : `<span class="env-badge env-badge-warn">${T('notInstalled','Not installed')}</span>`;

    h += `<details id="env-flash-attn" ${this.faCardOpen?'open':''} class="env-card">
      <summary class="env-card-summary"><span class="env-chevron"></span><span class="env-card-title">Flash Attention</span><span class="env-card-hint">${T('trainingAccel','Training acceleration (optional)')}</span><span class="env-card-hint">${T('restartHint','After install restart GUI for changes.')}</span>${faStatusBadge}</summary>
      <div class="env-card-body">`;

    if (this.faError) h += `<div class="env-msg env-msg-err"><pre>${this.faError}</pre></div>`;

    if (s) {
      const rows = [
        ['flash_attn', faInstalled?`v${s.version||'?'}`:`<span class="env-text-warn">${T('notInstalled','Not installed')}</span>`],
        ['Python', env.python_tag||'<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
        ['CUDA', env.cuda_tag?`${env.cuda_tag} <span class="env-text-dim">(${env.cuda_ver||'?'})</span>`:'<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
        ['PyTorch', env.torch_tag?`${env.torch_tag} <span class="env-text-dim">(${env.torch_ver||'?'})</span>`:'<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],
        ['Platform', env.platform||'<span class="env-text-dim">'+T('unsupported','Unsupported')+'</span>'],
      ];
      h += `<table class="env-table"><tbody>`; rows.forEach(([l,v]) => { h+=`<tr><td class="env-table-label">${l}</td><td class="env-table-value">${v}</td></tr>`; }); h+=`</tbody></table>`;

      if (s.fetch_error) {
        if (s.from_disk_cache) h+=`<div class="env-msg env-msg-info">${T('usingCachedData','Using cached data.')} ${T('cachedDataHint','Auto-updates on next success.')}</div>`;
        else if (/rate limit|限流/i.test(s.fetch_error)) h+=`<div class="env-msg env-msg-warn">${T('githubApiFail','GitHub API unavailable')}<br>${T('rateLimitHint','Will retry. Paste URL manually.')}</div>`;
        else h+=`<div class="env-msg env-msg-warn">${T('githubApiFail','GitHub API unavailable')}: ${s.fetch_error}<br>${T('manualUrlHint','Paste wheel URL manually.')}</div>`;
      }
      if (!canAuto && !s.fetch_error && env.platform && env.torch_tag) h+=`<div class="env-msg env-msg-warn">${T('noWheel','No matching wheel. Paste URL manually.')}</div>`;

      if (this.faConfirmMsg) {
        h+=`<div class="env-actions"><div class="env-confirm"><span class="env-confirm-msg">${this.faConfirmMsg}</span><button id="fa-confirm-yes" class="btn btn-sm btn-primary">${T('confirmYes','Confirm')}</button><button id="fa-confirm-no" class="btn btn-sm btn-ghost">${T('confirmNo','Cancel')}</button></div></div>`;
      } else {
        h+=`<div class="env-actions"><button id="fa-auto-btn" class="btn btn-secondary" ${this.faBusy||!canAuto?'disabled':''} title="${best?best.name:''}">${faInstalled?T('reinstall','Reinstall'):T('autoInstall','Auto Install')}</button><button id="fa-refresh-btn" class="btn-icon" ${this.faBusy?'disabled':''} title="${T('refresh','Refresh')}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button><span class="env-actions-spacer"></span><span class="env-source-group"><button id="fa-src-default" class="env-source-btn ${this.faSource==='default'?'active':''}">${T('sourceDefault','官方')}</button><button id="fa-src-mirror" class="env-source-btn ${this.faSource==='mirror'?'active':''}">${T('sourceMirror','镜像')}</button><button id="fa-src-fallback" class="env-source-btn ${this.faSource==='fallback'?'active':''}">${T('sourceFallback','备用')}</button></span><button id="fa-toggle-btn" class="btn btn-ghost btn-sm">${this.faCandidatesOpen?T('hideCandidates','Hide'):T('showCandidates','Show')+' ('+candidates.length+')'}</button></div>`;
      }

      if (this.faCandidatesOpen && candidates.length) {
        h+=`<ul class="env-candidate-list">`;
        candidates.forEach(c => {
          const mark = c.usable?'ok':'warn';
          h+=`<li class="env-candidate-item"><span class="env-candidate-mark env-candidate-${mark}">${c.usable?'&#10003;':'&#10007;'}</span><code class="env-candidate-name" title="${c.name}">${c.name}</code>${c.notes.length?`<span class="env-candidate-notes">${c.notes.map(n=>typeof n==='string'?n:(T('faNote.'+n.key)||n.text||n.key)).join('; ')}</span>`:''}<button class="fa-candidate-btn btn btn-sm ${c.usable?'btn-secondary':'btn-ghost'}" data-url="${c.url.replace(/'/g,"\\'")}">${c.usable?T('install','Install'):T('forceInstall','Force')}</button></li>`;
        });
        h+=`</ul>`;
      }

      h+=`<div class="env-manual-url"><input type="text" class="env-url-input" placeholder="https://github.com/.../flash_attn-...whl" id="fa-manual-input"><button id="fa-url-btn" class="btn btn-secondary">${T('installUrl','URL Install')}</button></div>`;
    }
    h+=`</div></details>`;
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  xformers card render
  // ═══════════════════════════════════════════════════════
  _renderXfCard(T) {
    const xs = this.xfStatus; const xfEnv = xs?.env || {}; const xfInstalled = xs?.installed;
    let h = '';
    if (this.xfBusy) {
      const elapsed = this._formatElapsed(this.xfInstallElapsed);
      h += `<details id="env-xformers" ${this.xfCardOpen?'open':''} class="env-card"><summary class="env-card-summary"><span class="env-chevron"></span><span class="env-card-title">xformers</span><span class="env-badge env-badge-loading">${T('installing','Installing...')}</span></summary><div class="env-card-body"><div class="env-install-progress"><div class="env-install-row"><div class="env-install-spinner"></div><div class="env-progress-info"><span>${T('xfInstallingHint','Downloading...')}</span><span class="env-progress-time">${elapsed}</span></div></div>${this.xfInstallLog?`<pre class="env-install-log">${this.xfInstallLog}</pre>`:''}</div></div></details>`;
      return h;
    }
    const xfStatusBadge = this.xfError ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !xs ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : xfInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')} &middot; v${xs.version||'?'}</span>`
      : `<span class="env-badge env-badge-warn">${T('notInstalled','Not installed')}</span>`;

    h+=`<details id="env-xformers" ${this.xfCardOpen?'open':''} class="env-card"><summary class="env-card-summary"><span class="env-chevron"></span><span class="env-card-title">xformers</span><span class="env-card-hint">${T('xfHint','Memory-efficient attention (optional)')}</span><span class="env-card-hint">${T('xfRestartHint','After install restart GUI.')}</span>${xfStatusBadge}</summary><div class="env-card-body">`;
    if (this.xfError) h+=`<div class="env-msg env-msg-err"><pre>${this.xfError}</pre></div>`;
    if (xs) {
      h+=`<table class="env-table"><tbody>`;
      [['xformers',xfInstalled?`v${xs.version||'?'}`:`<span class="env-text-warn">${T('notInstalled','Not installed')}</span>`],['Python',xfEnv.python_tag||'<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],['PyTorch',xfEnv.torch_ver||'<span class="env-text-dim">'+T('notDetected','N/A')+'</span>'],['CUDA',xfEnv.cuda_ver?`cu${xfEnv.cuda_ver.replace('.','')}`:'<span class="env-text-dim">'+T('notDetected','N/A')+'</span>']].forEach(([l,v])=>{h+=`<tr><td class="env-table-label">${l}</td><td class="env-table-value">${v}</td></tr>`;});
      h+=`</tbody></table>`;
      if (!xfInstalled) h+=`<div class="env-msg env-msg-info">${T('xfInstallInfo','Installs latest compatible version from PyPI.')}</div>`;
      h+=`<div class="env-actions"><button id="xf-install-btn" class="btn btn-secondary" ${this.xfBusy?'disabled':''}>${xfInstalled?T('reinstall','Reinstall'):T('xfInstallBtn','Install via PyPI')}</button><button id="xf-refresh-btn" class="btn-icon" ${this.xfBusy?'disabled':''} title="${T('refresh','Refresh')}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button></div>`;
    }
    h+=`</div></details>`;
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  sd-scripts card render (local version info only)
  // ═══════════════════════════════════════════════════════
  _renderSdCard(T) {
    const sd = this.sdStatus; const sdLocal = sd?.local || {};
    let h = '';

    const sdBadge = this.sdError ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !sd ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : `<span class="env-badge env-badge-ok">${T('sdScriptsUpToDate','Up to date')}</span>`;

    h+=`<details id="env-sdscripts" ${this.sdCardOpen?'open':''} class="env-card"><summary class="env-card-summary"><span class="env-chevron"></span><span class="env-card-title">${T('sdScriptsTitle','sd-scripts')}</span><span class="env-card-hint">${T('sdScriptsDesc','kohya-ss/sd-scripts')}</span>${sdBadge}</summary><div class="env-card-body">`;

    if (this.sdError) h+=`<div class="env-msg env-msg-err"><pre>${this.sdError}</pre></div>`;

    if (sd) {
      const repoUrl = sd.repo_url || `https://github.com/${sdLocal.repo||'kohya-ss/sd-scripts'}`;
      h+=`<table class="env-table"><tbody>`;
      [['Repo',`<a href="${repoUrl}" target="_blank" rel="noopener" class="env-link">${sdLocal.repo||'kohya-ss/sd-scripts'} &#8599;</a>`],['Branch',sdLocal.local_branch||'<span class="env-text-dim">-</span>'],sdLocal.tag?['Tag',`<a href="${repoUrl}/releases/tag/${sdLocal.tag}" target="_blank" rel="noopener" class="env-link"><code>${sdLocal.tag}</code></a>`]:null,['Commit',sdLocal.local_commit?`<a href="${repoUrl}/commit/${sdLocal.local_commit}" target="_blank" rel="noopener" class="env-link"><code>${sdLocal.local_commit}</code></a>`:'<span class="env-text-dim">UNKNOWN</span>'],['Sync date',sdLocal.sync_date||'<span class="env-text-dim">-</span>']].filter(r=>r).forEach(([l,v])=>{h+=`<tr><td class="env-table-label">${l}</td><td class="env-table-value">${v}</td></tr>`;});
      h+=`</tbody></table>`;

      h+=`<div class="env-actions"><a href="${repoUrl}" target="_blank" rel="noopener" class="btn btn-secondary">${T('sdScriptsOpenRepo','Open repo')} &#8599;</a><button id="sd-refresh-btn" class="btn-icon" title="${T('refresh','Refresh')}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button></div>`;
    }
    h+=`</div></details>`;
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

  _bindSdEvents(el) {
    const a = window.__anima || this;
    const sdRefreshBtn = el.querySelector('#sd-refresh-btn'); if (sdRefreshBtn) sdRefreshBtn.addEventListener('click', () => a.sdRefresh());
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
