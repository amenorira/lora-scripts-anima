/* ================================================================
   environment-render.js — renderEnvironment + event bindings
   Mixin merged into animaApp Alpine component

   设计：按训练环境与本地资源分栏；抽取共享 helper
   （_renderDetailGroup / _renderProgressPanel / _renderLog / _renderRefreshBtn）
   消除四处重复 HTML + 内联 style。日志可读性为核心目标。
   ================================================================ */

window.environmentRenderMixin = {
  renderEnvironment() {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    if (this._environmentRenderFrame != null) {
      cancelAnimationFrame(this._environmentRenderFrame);
      this._environmentRenderFrame = null;
    }
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    let html = '';

    if (this.environmentLoading) {
      const total = Math.max(1, this.environmentLoadTotal || 0);
      const done = Math.min(total, this.environmentLoadCompleted || 0);
      const pct = Math.round(done * 100 / total);
      html += `<div class="env-load-status" role="status" aria-live="polite">`
        + `<span class="env-load-spinner" aria-hidden="true"></span>`
        + `<div class="env-load-main"><div class="env-load-copy"><span>${T('loading','Loading environment info...')}</span><span class="env-load-count">${done}/${total}</span></div>`
        + `<div class="env-load-track"><span style="width:${pct}%"></span></div></div></div>`;
    }

    html += `<div class="env-layout"><div class="env-layout-column env-layout-training">`;
    html += `<div class="env-section"><div class="env-section-header">${T('sectionAccel', 'Performance acceleration')}</div>`;
    html += this._renderFaRow(T);
    html += this._renderXfRow(T);
    html += this._renderTritonRow(T);
    html += `</div>`;

    html += `<div class="env-section"><div class="env-section-header">${T('sectionCore', 'Training Core')}</div>`;
    html += this._renderSdRow(T);
    html += this._renderLycorisRow(T);
    html += this._renderMusubiRow(T);
    html += `</div>`;

    html += `</div><div class="env-layout-column env-layout-resources">`;
    html += `<div class="env-section"><div class="env-section-header">${T('sectionLocalAi', 'Local inference')}</div>`;
    html += this._renderLlamaRuntimeRow(T);
    html += `</div>`;

    html += `<div class="env-section"><div class="env-section-header">${T('sectionModels', 'Models')}</div>`;
    html += this._renderAnimaModelRow(T, 'Anima');
    html += this._renderAnimaModelRow(T, 'Krea 2');
    html += `</div>`;
    html += `</div></div>`;

    el.innerHTML = html;
    this._bindFaEvents(el, T);
    this._bindXfEvents(el);
    this._bindTritonEvents(el);
    this._bindLlamaRuntimeEvents(el);
    this._bindAnimaModelEvents(el);
    this._bindCardToggle(el);
    this._autoScrollLogs(el);
  },

  // 每次 renderEnvironment 用 innerHTML 全量重建 DOM，新建的 .env-log 容器
  // scrollTop 重置为 0（回顶部）；安装/下载日志是增量追加，用户要看最新行，
  // 所以渲染后把所有可见的 .env-log 滚到底部。仅滚"正在更新"的活跃日志，
  // 静态卡片里的日志若用户手动滚到中间则不强制（这里无活跃态时可忽略，影响小）。
  _autoScrollLogs(el) {
    el.querySelectorAll('.env-log').forEach(pre => {
      // 仅当容器有滚动高度（内容溢出）时才有意义
      if (pre.scrollHeight > pre.clientHeight) {
        pre.scrollTop = pre.scrollHeight;
      }
    });
  },

  // ═══════════════════════════════════════════════════════
  //  Shared render helpers（消除重复 HTML + 内联 style）
  // ═══════════════════════════════════════════════════════

  // 卡片外框：统一 details。state ∈ ok/warn/err/loading/idle，状态由 env-badge 承载。
  _renderCardOpen(id, state, open, summaryInner) {
    return `<details id="${id}" class="env-card env-card-${state}" ${open?'open':''}><summary class="env-card-header">${summaryInner}</summary><div class="env-card-body">`;
  },
  _renderCardClose() { return `</div></details>`; },

  _renderCardSummary(arrow, title, subtitle, badge) {
    return `<span class="env-card-arrow">${arrow}</span><span class="env-card-title">${title}</span>${subtitle?`<span class="env-card-subtitle">${subtitle}</span>`:''}${badge||''}`;
  },

  // 详情行：label(42px) + content，替代内联 env-detail-group。
  _renderDetailGroup(label, contentHtml) {
    return `<div class="env-detail-group"><span class="env-detail-label">${label||''}</span><div class="env-detail-content">${contentHtml}</div></div>`;
  },

  // 刷新图标按钮（FA/xf/triton/Anima 共用）。
  _renderRefreshBtn(id, disabled) {
    return `<button id="${id}" class="btn-icon" ${disabled?'disabled':''} title="${this.t('environment.refresh','Refresh')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>`;
  },

  // 统一进度面板。opts: {stage, pct, speedMB, downloadedGB, totalGB, elapsed, label, fileIndex, fileTotal}
  //   stage: 'downloading' → 进度条+百分比+速度+大小
  //          'connecting'  → 不定式条 + 连接中文案
  //          'installing'/'working' → spinner + 阶段文案 + 计时
  //   elapsed: 秒（已格式化为 mm:ss 的字符串）
  _renderProgressPanel(opts) {
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    const stage = opts.stage || 'working';
    const elapsed = this._formatElapsed(opts.elapsed || 0);
    let bar = '', meta = '';

    if (stage === 'downloading' && opts.totalBytes != null && opts.totalBytes > 0) {
      const pct = opts.pct != null ? opts.pct : 0;
      bar = `<div class="env-progress-bar"><div style="width:${pct}%"></div></div>`;
      meta = `<span class="env-progress-pct">${pct}%</span><span class="env-progress-meta-r">${(opts.speedMB||0).toFixed(1)} MB/s · ${this._humanBytes(opts.downloadedBytes||0)}/${this._humanBytes(opts.totalBytes||0)}</span>`;
    } else if (stage === 'downloading') {
      // 有速度但 total 未知（单连接兜底阶段）
      bar = `<div class="env-progress-bar env-progress-indeterminate"><div></div></div>`;
      meta = `<span class="env-progress-stage">${T('downloading','Downloading')}</span><span class="env-progress-meta-r">${(opts.speedMB||0).toFixed(1)} MB/s · ${this._humanBytes(opts.downloadedBytes||0)}</span>`;
    } else if (stage === 'connecting') {
      const idx = opts.fileIndex || '?', tt = opts.fileTotal || '?';
      bar = `<div class="env-progress-bar env-progress-indeterminate"><div></div></div>`;
      meta = `<span class="env-progress-stage">${T('connecting','Connecting')} ${idx}/${tt}</span>`;
    } else {
      // installing / working
      const stageLabel = stage === 'installing' ? T('faStageInstalling','Installing…') : T('installingHint','Working…');
      bar = `<div class="env-progress-spinner-wrap"><div class="env-install-spinner"></div><span class="env-progress-stage">${stageLabel}</span></div>`;
      meta = `<span class="env-progress-time">${elapsed}</span>`;
    }
    return `<div class="env-progress-panel">${bar}<div class="env-progress-meta">${meta}</div></div>`;
  },

  _renderLlamaRuntimeRow(T) {
    const runtime = this.llamaRuntimeStatus;
    const busy = this.llamaRuntimeBusy;
    const error = this.llamaRuntimeError;
    const installed = !!runtime?.installed;
    const updateAvailable = !!runtime?.update_available;
    const repairRequired = !!runtime?.repair_required;
    const running = !!runtime?.running;
    const state = error ? 'err' : busy ? 'loading' : installed && !updateAvailable && !repairRequired ? 'ok' : 'warn';
    const statusText = busy ? T('installing','Installing...')
      : running ? T('llamaRuntime.running','Running')
      : updateAvailable && runtime?.mandatory ? T('llamaRuntime.updateRequired','Update required')
      : updateAvailable ? T('llamaRuntime.updateAvailable','Update available')
      : repairRequired ? T('llamaRuntime.repairRequired','Repair required')
      : installed ? T('installed','Installed') : T('notInstalled','Not installed');
    const badgeClass = error ? 'err' : busy ? 'loading' : installed && !updateAvailable && !repairRequired ? 'ok' : 'warn';
    const summary = this._renderCardSummary('&#9654;', T('llamaRuntime.title','Vision LLM inference runtime'),
      T('llamaRuntime.subtitle','llama.cpp CUDA backend'),
      `<span class="env-badge env-badge-${badgeClass}">${statusText}</span>`);
    let h = this._renderCardOpen('env-llama-runtime', state, this.llamaRuntimeCardOpen, summary);

    if (error) h += `<div class="env-msg env-msg-err"><pre>${this.esc(error)}</pre></div>`;
    h += `<div class="env-msg env-msg-info">${T('llamaRuntime.description','Loads Qwen3.5 GGUF models on the local NVIDIA GPU. The runtime is installed outside Python; model weights are managed separately in Tagger.')}</div>`;

    if (runtime) {
      const archiveSize = this._humanBytes(runtime.archive_size_bytes || 0);
      const installedSize = runtime.installed_size_bytes ? this._humanBytes(runtime.installed_size_bytes) : '';
      const installedRef = runtime.installed_ref && runtime.installed_ref !== runtime.runtime_ref
        ? `<span class="env-env-item">${T('llamaRuntime.installedBuild','Installed')} <em>${this.esc(runtime.installed_ref)}</em></span>` : '';
      h += this._renderDetailGroup(T('llamaRuntime.build','Build'),
        `<span class="env-env-item">llama.cpp <em>${this.esc(runtime.runtime_ref || '?')}</em></span><span class="env-env-item">CUDA <em>${this.esc(runtime.cuda_version || '?')}</em></span><span class="env-env-item">${T('llamaRuntime.channel','Channel')} <em>${this.esc(runtime.channel || 'stable')}-v${this.esc(runtime.runtime_api_version || 1)}</em></span>${installedRef}`);
      h += this._renderDetailGroup(T('llamaRuntime.platform','Platform'),
        `<span class="env-env-item"><em>${this.esc(runtime.platform || '')}</em></span><span class="env-env-item">${T('llamaRuntime.downloadSize','Download')} <em>${archiveSize}</em></span>${installedSize ? `<span class="env-env-item">${T('llamaRuntime.diskUsage','Disk')} <em>${installedSize}</em></span>` : ''}`);
      if (runtime.install_path) h += this._renderDetailGroup(T('llamaRuntime.path','Path'), `<code class="env-runtime-path" title="${this.escapeAttr(runtime.install_path)}">${this.esc(runtime.install_path)}</code>`);
      if (running && runtime.loaded_model) h += this._renderDetailGroup(T('llamaRuntime.loadedModel','Loaded'), `<span class="env-env-item"><em>${this.esc(runtime.loaded_model)}</em></span>`);
    }

    if (busy && this.llamaRuntimeProgress) {
      const p = this.llamaRuntimeProgress;
      const phase = p.phase || 'working';
      h += this._renderProgressPanel({
        stage: phase === 'installing' ? 'installing' : (p.total > 0 ? 'downloading' : 'connecting'),
        pct: p.total > 0 ? Math.round((p.downloaded || 0) * 100 / p.total) : 0,
        downloadedBytes: p.downloaded || 0, totalBytes: p.total || 0, speedMB: p.speed || 0,
        fileIndex: 1, fileTotal: 1, label: p.filename || '',
      });
    }
    if (this.llamaRuntimeLog) h += this._renderLog(this.llamaRuntimeLog);

    const installLabel = updateAvailable ? T('llamaRuntime.update','Update component')
      : installed ? T('llamaRuntime.repair','Repair component') : T('llamaRuntime.install','Install component');
    h += this._renderDetailGroup(T('actionLabel','Actions'), `<div class="env-actions">
      <button id="llama-runtime-install" class="btn btn-secondary btn-sm" ${busy || running ? 'disabled' : ''}>${installLabel}</button>
      ${running ? `<button id="llama-runtime-stop" class="btn btn-ghost btn-sm">${T('llamaRuntime.stop','Stop runtime')}</button>` : ''}
      ${this._renderRefreshBtn('llama-runtime-refresh', busy)}
    </div>`);
    h += this._renderCardClose();
    return h;
  },

  _bindLlamaRuntimeEvents(el) {
    const a = window.__anima || this;
    const install = el.querySelector('#llama-runtime-install');
    const stop = el.querySelector('#llama-runtime-stop');
    const refresh = el.querySelector('#llama-runtime-refresh');
    if (install) install.addEventListener('click', () => a.llamaRuntimeInstall(!!a.llamaRuntimeStatus?.installed));
    if (stop) stop.addEventListener('click', () => a.llamaRuntimeStop());
    if (refresh) refresh.addEventListener('click', () => a.llamaRuntimeRefresh());
  },

  // 日志渲染：按行套色（ERROR/RETRY/WARN 红/橙，完成/Successfully 绿），输出到 <pre class="env-log">。
  // text 为多行字符串。核心可读性修复：字号/颜色由 CSS 接管，这里只做语义着色。
  _renderLog(text) {
    if (!text) return '';
    const lines = String(text).split('\n');
    let html = '';
    for (const raw of lines) {
      if (!raw) { html += '\n'; continue; }
      let cls = '';
      if (/^\[?ERROR\]?|\[ERROR\]|失败|failed|exit code|Traceback|Error:/i.test(raw)) cls = 'env-log-err';
      else if (/^\[?RETRY\]?|\[RETRY\]|重试|retry/i.test(raw)) cls = 'env-log-warn';
      else if (/^\[?WARN\]?|\[WARN\]|WARN|警告/i.test(raw)) cls = 'env-log-warn';
      else if (/完成|Done|Successfully installed|安装成功|已下载|Downloaded|100%/i.test(raw)) cls = 'env-log-ok';
      html += `<span class="env-log-line${cls?' '+cls:''}">${this.esc(raw)}</span>\n`;
    }
    return `<pre class="env-log">${html}</pre>`;
  },

  // ═══════════════════════════════════════════════════════
  //  Flash Attention card
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

    // 卡片状态：busy→loading，error→err，installed→ok，未安装→warn，无数据→loading
    const cardState = this.faBusy ? 'loading' : this.faError ? 'err' : !s ? 'loading' : faInstalled ? 'ok' : 'warn';

    // Busy: 显示下载/安装进度面板 + 日志（核心修复）
    if (this.faBusy) {
      const p = this.faProgress || {};
      const stage = p.stage || 'downloading';
      const summary = this._renderCardSummary('&#9654;', 'Flash Attention', '',
        `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`);
      h += this._renderCardOpen('env-flash-attn', cardState, this.faCardOpen, summary);
      // 进度面板：下载阶段用结构化进度条；安装阶段用 spinner
      if (stage === 'downloading' && p.total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((p.downloaded||0) * 100 / p.total)));
        h += this._renderProgressPanel({
          stage: 'downloading', pct,
          speedMB: p.speed || 0,
          downloadedBytes: p.downloaded||0,
          totalBytes: p.total||0,
          elapsed: this.faInstallElapsed,
        });
      } else if (stage === 'downloading') {
        // 连接中/total 未知
        h += this._renderProgressPanel({ stage: 'connecting', elapsed: this.faInstallElapsed });
      } else {
        // installing / done / error
        h += this._renderProgressPanel({ stage: stage === 'done' ? 'done' : 'installing', elapsed: this.faInstallElapsed });
      }
      h += this._renderLog(this.faLog);
      h += this._renderCardClose();
      return h;
    }

    const faBadge = this.faError
      ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !s ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : faInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')} &middot; v${s.version||'?'}</span>`
      : `<span class="env-badge env-badge-warn">${T('notInstalled','Not installed')}</span>`;

    const summary = this._renderCardSummary('&#9654;', 'Flash Attention', T('trainingAccel','Training acceleration (optional)'), faBadge);
    h += this._renderCardOpen('env-flash-attn', cardState, this.faCardOpen, summary);

    if (this.faError) h += `<div class="env-msg env-msg-err"><pre>${this.esc(this.faError)}</pre></div>`;

    if (s) {
      // Environment info
      const envItems = [];
      if (faInstalled) envItems.push(`<span class="env-env-item">flash_attn <em>v${s.version||'?'}</em></span>`);
      if (env.python_tag) envItems.push(`<span class="env-env-item"><em>${env.python_tag}</em></span>`);
      if (env.cuda_tag) envItems.push(`<span class="env-env-item">CUDA <em>${env.cuda_tag}</em> <span class="env-text-dim">(${env.cuda_ver||'?'})</span></span>`);
      if (env.torch_tag) envItems.push(`<span class="env-env-item">PyTorch <em>${env.torch_tag}</em></span>`);
      if (env.platform) envItems.push(`<span class="env-env-item"><em>${env.platform}</em></span>`);
      h += this._renderDetailGroup(T('envLabel','Env'), envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`);

      // Error / info messages
      if (s.fetch_error) {
        if (s.from_disk_cache) h+=`<div class="env-msg env-msg-info">${T('usingCachedData','Using cached data.')} ${T('cachedDataHint','Auto-updates on next success.')}</div>`;
        else if (/rate limit|限流/i.test(s.fetch_error)) h+=`<div class="env-msg env-msg-warn">${T('githubApiFail','GitHub API unavailable')}<br>${T('rateLimitHint','Will retry. Paste URL manually.')}</div>`;
        else h+=`<div class="env-msg env-msg-warn">${T('githubApiFail','GitHub API unavailable')}: ${this.esc(s.fetch_error)}<br>${T('manualUrlHint','Paste wheel URL manually.')}</div>`;
      }
      if (!canAuto && !s.fetch_error && env.platform && env.torch_tag) h+=`<div class="env-msg env-msg-warn">${T('noWheel','No matching wheel. Paste URL manually.')}</div>`;

      // Confirm dialog
      if (this.faConfirmMsg) {
        h+=`<div class="env-confirm"><span class="env-confirm-msg">${this.faConfirmMsg}</span><button id="fa-confirm-yes" class="btn btn-sm btn-primary">${T('confirmYes','Confirm')}</button><button id="fa-confirm-no" class="btn btn-sm btn-ghost">${T('confirmNo','Cancel')}</button></div>`;
      } else {
        // Install group
        h += this._renderDetailGroup(T('installLabel','Install'), (() => {
          let inner = `<div class="env-install-controls">`;
          inner += `<span class="env-source-group"><button id="fa-src-default" class="env-source-btn ${this.faSource==='default'?'active':''}" title="${T('sourceDefaultHint','Direct to GitHub, auto-fallback to mirrors')}">${T('sourceDefault','Official')}</button><button id="fa-src-mirror" class="env-source-btn ${this.faSource==='mirror'?'active':''}" title="${T('sourceMirrorHint','Use mirrors directly')}">${T('sourceMirror','Mirror')}</button><button id="fa-src-fallback" class="env-source-btn ${this.faSource==='fallback'?'active':''}" title="${T('sourceFallbackHint','Alternate wheel repository')}">${T('sourceFallback','Alt')}</button></span>`;
          if (best) {
            inner += `<button id="fa-best-install-btn" class="btn btn-sm btn-secondary" ${this.faBusy?'disabled':''} data-url="${this.escapeAttr(best.url)}">${T('installThis','Install this')}</button>`;
            inner += `<code class="env-best-name" title="${this.escapeAttr(best.name)}">${this.esc(best.name)}</code>`;
          }
          inner += `</div>`;
          // Candidates toggle
          inner += `<button id="fa-toggle-btn" class="btn btn-ghost btn-sm env-toggle-candidates">${this.faCandidatesOpen ? T('hideAllCandidates','Hide all') : T('showAllCandidates','Show all') + ' (' + candidates.length + ')'}</button>`;
          // Candidate list
          if (this.faCandidatesOpen && candidates.length) {
            inner += `<ul class="env-candidate-list">`;
            candidates.forEach(c => {
              const mark = c.usable?'ok':'warn';
              inner += `<li class="env-candidate-item"><span class="env-candidate-mark env-candidate-${mark}">${c.usable?'&#10003;':'&#10007;'}</span><code class="env-candidate-name" title="${this.escapeAttr(c.name)}">${this.esc(c.name)}</code>${c.notes.length?`<span class="env-candidate-notes">${this.esc(c.notes.map(n=>typeof n==='string'?n:(T('faNote.'+n.key)||n.text||n.key)).join('; '))}</span>`:''}<button class="fa-candidate-btn btn btn-sm ${c.usable?'btn-secondary':'btn-ghost'}" data-url="${this.escapeAttr(c.url)}">${c.usable?T('install','Install'):T('forceInstall','Force')}</button></li>`;
            });
            inner += `</ul>`;
          }
          // Manual URL
          inner += `<div class="env-manual-url"><input type="text" class="env-url-input" placeholder="https://github.com/.../flash_attn-...whl" id="fa-manual-input"><button id="fa-url-btn" class="btn btn-secondary">${T('installUrl','URL Install')}</button></div>`;
          return inner;
        })());

        // Actions
        h += this._renderDetailGroup(T('actionLabel','Actions'),
          `<div class="env-actions"><button id="fa-auto-btn" class="btn btn-secondary" ${this.faBusy||!canAuto?'disabled':''} title="${best?this.escapeAttr(best.name):''}">${faInstalled?T('reinstall','Reinstall'):T('autoInstall','Auto Install')}</button>${this._renderRefreshBtn('fa-refresh-btn', this.faBusy)}</div>`);
      }
    }

    h += this._renderCardClose();
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  xformers card
  // ═══════════════════════════════════════════════════════
  _renderXfRow(T) {
    const xs = this.xfStatus; const xfEnv = xs?.env || {}; const xfInstalled = xs?.installed;
    let h = '';

    if (this.xfBusy) {
      const summary = this._renderCardSummary('&#9654;', 'xformers', '',
        `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`);
      h += this._renderCardOpen('env-xformers', 'loading', this.xfCardOpen, summary);
      h += this._renderProgressPanel({ stage: 'working', elapsed: this.xfInstallElapsed, label: T('xfInstallingHint','Downloading...') });
      h += this._renderLog(this.xfInstallLog);
      h += this._renderCardClose();
      return h;
    }

    const cardState = this.xfError ? 'err' : !xs ? 'loading' : xfInstalled ? 'ok' : 'warn';
    const xfBadge = this.xfError ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !xs ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : xfInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')} &middot; v${xs.version||'?'}</span>`
      : `<span class="env-badge env-badge-warn">${T('notInstalled','Not installed')}</span>`;

    const summary = this._renderCardSummary('&#9654;', 'xformers', T('xfHint','Memory-efficient attention (optional)'), xfBadge);
    h += this._renderCardOpen('env-xformers', cardState, this.xfCardOpen, summary);

    if (this.xfError) h += `<div class="env-msg env-msg-err"><pre>${this.esc(this.xfError)}</pre></div>`;

    if (xs) {
      const envItems = [];
      if (xfInstalled) envItems.push(`<span class="env-env-item">xformers <em>v${xs.version||'?'}</em></span>`);
      if (xfEnv.python_tag) envItems.push(`<span class="env-env-item"><em>${xfEnv.python_tag}</em></span>`);
      if (xfEnv.torch_ver) envItems.push(`<span class="env-env-item">PyTorch <em>${xfEnv.torch_ver}</em></span>`);
      if (xfEnv.cuda_ver) envItems.push(`<span class="env-env-item">CUDA <em>cu${xfEnv.cuda_ver.replace('.','')}</em></span>`);
      h += this._renderDetailGroup(T('envLabel','Env'), envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`);

      if (!xfInstalled) h += `<div class="env-msg env-msg-info">${T('xfInstallInfo','Installs latest compatible version from PyPI.')}</div>`;

      h += this._renderDetailGroup(T('actionLabel','Actions'),
        `<div class="env-actions"><button id="xf-install-btn" class="btn btn-secondary" ${this.xfBusy?'disabled':''}>${xfInstalled?T('reinstall','Reinstall'):T('xfInstallBtn','Install via PyPI')}</button>${this._renderRefreshBtn('xf-refresh-btn', this.xfBusy)}</div>`);
    }

    h += this._renderCardClose();
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  sd-scripts card
  // ═══════════════════════════════════════════════════════
  _renderCoreVersionBadge(T, meta, available = true, error = null) {
    if (error) return `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>`;
    if (!meta) return `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`;
    if (!available) return `<span class="env-badge env-badge-warn">${T('coreNotReady', 'Needs setup')}</span>`;
    const displayVersion = meta.describe || meta.tag;
    if (displayVersion) {
      const repoUrl = `https://github.com/${meta.repo}`;
      const versionUrl = meta.local_commit
        ? `${repoUrl}/commit/${this.escapeAttr(meta.local_commit)}`
        : `${repoUrl}/releases/tag/${this.escapeAttr(meta.tag)}`;
      return `<a href="${versionUrl}" target="_blank" rel="noopener" class="env-badge env-badge-info env-badge-link"><code>${this.esc(displayVersion)}</code></a>`;
    }
    if (meta.local_commit) return `<span class="env-badge env-badge-info"><code>${this.esc(meta.local_commit.slice(0,7))}</code></span>`;
    return `<span class="env-badge env-badge-info">${T('sdScriptsLocal','Local')}</span>`;
  },

  _renderCoreRepositoryDetails(T, meta, fallbackRepo) {
    const repo = meta?.repo || fallbackRepo;
    const repoUrl = `https://github.com/${repo}`;
    const displayVersion = meta?.describe || meta?.tag;
    const versionUrl = meta?.local_commit
      ? `${repoUrl}/commit/${this.escapeAttr(meta.local_commit)}`
      : (meta?.tag ? `${repoUrl}/releases/tag/${this.escapeAttr(meta.tag)}` : null);
    const versionHtml = displayVersion
      ? `<span class="env-env-item">Version ${versionUrl ? `<a href="${versionUrl}" target="_blank" rel="noopener" class="env-link"><code>${this.esc(displayVersion)}</code></a>` : `<code>${this.esc(displayVersion)}</code>`}</span>`
      : null;
    const verItems = [
      `<span class="env-env-item">Repo <a href="${repoUrl}" target="_blank" rel="noopener" class="env-link">${this.esc(repo)} &#8599;</a></span>`,
      meta?.local_branch ? `<span class="env-env-item">Branch <em>${this.esc(meta.local_branch)}</em></span>` : null,
      versionHtml,
      meta?.local_commit ? `<span class="env-env-item">Commit <a href="${repoUrl}/commit/${this.escapeAttr(meta.local_commit)}" target="_blank" rel="noopener" class="env-link"><code>${this.esc(meta.local_commit.slice(0,7))}</code></a></span>` : null,
      meta?.sync_date ? `<span class="env-env-item">Sync <span class="env-text-dim">${this.esc(meta.sync_date)}</span></span>` : null,
    ].filter(Boolean);
    return this._renderDetailGroup(T('verLabel','Ver'), verItems.join(' &middot; '))
      + this._renderDetailGroup('', `<a href="${repoUrl}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">${T('sdScriptsOpenRepo','Open repo')} &#8599;</a>`);
  },

  _renderSdRow(T) {
    const sd = this.sdStatus; const sdLocal = sd?.local || {};
    let h = '';

    const sdBadge = this._renderCoreVersionBadge(T, sd ? sdLocal : null);
    const cardState = !sd ? 'loading' : 'idle';
    const summary = this._renderCardSummary('&#9654;', T('sdScriptsTitle','sd-scripts'), T('sdScriptsDesc','kohya-ss/sd-scripts'), sdBadge);
    h += this._renderCardOpen('env-sdscripts', cardState, this.sdCardOpen, summary);

    if (sd) h += this._renderCoreRepositoryDetails(T, sdLocal, 'kohya-ss/sd-scripts');
    h += this._renderCardClose();
    return h;
  },

  _renderLycorisRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const adapter = registry?.adapters?.find(item => item.id === 'lycoris');
    const available = !!adapter?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'warn';
    const badge = this._renderCoreVersionBadge(T, adapter?.version || null, available, error);
    let h = '';
    h += this._renderCardOpen('env-lycoris', state, this.lycorisCardOpen,
      this._renderCardSummary('&#9654;', 'LyCORIS', T('lycorisDesc', 'LoRA adapter core'), badge));
    if (error) h += `<div class="env-msg env-msg-err"><pre>${this.esc(error)}</pre></div>`;
    if (adapter) h += this._renderCoreRepositoryDetails(T, adapter.version, 'KohakuBlueleaf/LyCORIS');
    h += this._renderCardClose();
    return h;
  },

  _renderMusubiRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const engine = registry?.engines?.find(item => item.id === 'musubi_tuner');
    const available = !!engine?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'warn';
    const badge = this._renderCoreVersionBadge(T, engine?.version || null, available, error);
    let h = '';
    h += this._renderCardOpen('env-musubi', state, this.musubiCardOpen,
      this._renderCardSummary('&#9654;', 'musubi-tuner', T('musubiDesc', 'Krea 2 training core'), badge));
    if (error) h += `<div class="env-msg env-msg-err"><pre>${this.esc(error)}</pre></div>`;
    if (engine) {
      h += this._renderCoreRepositoryDetails(T, engine.version, 'kohya-ss/musubi-tuner');
      const runtimeErrors = Array.isArray(engine.runtime_errors) ? engine.runtime_errors : [];
      if (runtimeErrors.length) h += `<div class="env-msg env-msg-warn"><pre>${this.esc(runtimeErrors.join('\n'))}</pre></div>`;
    }
    h += this._renderCardClose();
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  Triton card
  // ═══════════════════════════════════════════════════════
  _renderTritonRow(T) {
    const tr = this.tritonStatus;
    let h = '';

    // Busy: installing
    if (this.tritonBusy) {
      const summary = this._renderCardSummary('&#9654;', 'Triton', '',
        `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`);
      h += this._renderCardOpen('env-triton', 'loading', this.tritonCardOpen, summary);
      h += this._renderProgressPanel({ stage: 'working', elapsed: this.tritonInstallElapsed, label: T('tritonInstallingHint','Downloading...') });
      h += this._renderLog(this.tritonInstallLog);
      h += this._renderCardClose();
      return h;
    }

    const cardState = !tr ? 'loading' : tr.installed ? 'ok' : 'warn';
    const trBadge = !tr
      ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
      : tr.installed
        ? `<span class="env-badge env-badge-ok">${T('tritonInstalled','Installed')}${tr.version ? ' &middot; v'+this.esc(tr.version) : ''}${tr.package ? ' &middot; '+this.esc(tr.package) : ''}</span>`
        : `<span class="env-badge env-badge-warn">${T('tritonNotInstalled','Not installed')}</span>`;

    const summary = this._renderCardSummary('&#9654;', 'Triton', T('tritonDesc','GPU compile backend for torch.compile'), trBadge);
    h += this._renderCardOpen('env-triton', cardState, this.tritonCardOpen, summary);

    if (tr) {
      if (tr.installed) {
        h += this._renderDetailGroup(T('verLabel','Ver'), `<span class="env-env-item">${this.esc(tr.package||'triton')} <em>v${this.esc(tr.version||'?')}</em></span>`);
        h += this._renderDetailGroup(T('actionLabel','Actions'),
          `<div class="env-actions"><button id="triton-reinstall-btn" class="btn btn-secondary btn-sm" ${this.tritonBusy?'disabled':''}>${T('reinstall','Reinstall')}</button>${this._renderRefreshBtn('triton-refresh-btn', this.tritonBusy)}</div>`);
      } else {
        h += `<div class="env-msg env-msg-info">${T('tritonInstallInfo','Enables DiT per-block compilation. Windows installs a triton-windows version matched to PyTorch; Linux installs triton.')}</div>`;
        h += this._renderDetailGroup(T('actionLabel','Actions'),
          `<div class="env-actions"><button id="triton-install-btn" class="btn btn-secondary btn-sm" ${this.tritonBusy?'disabled':''}>${T('tritonInstallBtn','Install')}</button>${this._renderRefreshBtn('triton-refresh-btn', this.tritonBusy)}</div>`);
      }
    }
    h += this._renderCardClose();
    return h;
  },

  // ═══════════════════════════════════════════════════════
  //  模型下载 cards
  // ═══════════════════════════════════════════════════════
  _renderAnimaModelRow(T, modelGroup) {
    const files = (this.animaModelStatus || []).filter(file => file.group === modelGroup);
    const progress = this.animaModelProgress;
    const aggregate = this.animaModelAggregate;
    const busy = this.animaModelBusy;
    const error = this.animaModelError;
    const destDir = this.animaModelDestDir || 'models/';
    const p = progress || {};
    const curFile = p.filename || '';
    const batch = Array.isArray(p.batch) ? p.batch : null;
    const phase = p.phase || '';
    const groupTask = !p.group || p.group === 'all' || p.group === modelGroup;
    const groupBusy = busy && groupTask;
    const groupError = error && groupTask ? error : null;
    const isKrea2 = modelGroup === 'Krea 2';
    const cardId = isKrea2 ? 'env-krea2-model' : 'env-anima-model';
    const cardOpen = isKrea2 ? this.kreaModelCardOpen : this.animaModelCardOpen;
    const title = isKrea2 ? T('animaModel.krea2Title','Krea 2 Models') : T('animaModel.animaTitle','Anima Models');
    const subtitle = isKrea2
      ? T('animaModel.krea2Subtitle','RAW / Turbo / Qwen3-VL / VAE')
      : T('animaModel.animaSubtitle','Base / Qwen3 / VAE');
    let h = '';

    // 卡片标题行 + 整体状态徽标
    const allReady = files.length > 0 && files.every(f => f.exists);
    const cardState = groupError ? 'err' : !files.length ? 'loading' : allReady ? 'ok' : groupBusy ? 'loading' : 'warn';
    const cardBadge = groupError
      ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !files.length
        ? `<span class="env-badge env-badge-loading">${T('loading','Loading...')}</span>`
        : allReady
          ? `<span class="env-badge env-badge-ok">${T('animaModel.allReady','All ready')}</span>`
          : groupBusy
            ? `<span class="env-badge env-badge-loading">${T('animaModel.downloading','Downloading')}</span>`
            : `<span class="env-badge env-badge-warn">${T('animaModel.incomplete','Incomplete')}</span>`;

    const summary = this._renderCardSummary('&#9654;', title, subtitle, cardBadge);
    h += this._renderCardOpen(cardId, cardState, cardOpen, summary);

    // 错误提示
    if (groupError) h += `<div class="env-msg env-msg-err"><pre>${this.esc(groupError)}</pre></div>`;

    // ── 目标路径说明 banner（"下载到哪里"）──
    if (files.length) {
      h += `<div class="env-model-banner">${T('animaModel.destHint','Models download to the models/ directory, used as base / text encoder / VAE during training.')}</div>`;
    }

    // ── 整体批量进度（下载中显示）──
    if (groupBusy && aggregate) {
      const fileOf = T('animaModel.fileOf','File {i}/{n}').replace('{i}', aggregate.fileIndex).replace('{n}', aggregate.fileTotal);
      h += `<div class="env-model-aggregate">
        <div class="env-progress-bar"><div style="width:${aggregate.pct}%"></div></div>
        <div class="env-progress-meta">
          <span class="env-progress-pct">${aggregate.pct}%</span>
          <span class="env-progress-meta-r">${this.esc(fileOf)}${aggregate.label?' · '+this.esc(aggregate.label):''}</span>
        </div>
      </div>`;
    }

    // ── 文件清单（逐文件卡片，带单文件下载按钮）──
    h += `<div class="env-model-list">`;

    for (const f of files) {
      const inBatch = !batch || batch.includes(f.filename);
      const isCurrent = groupBusy && curFile === f.filename;
      const isQueued = groupBusy && inBatch && !isCurrent;
      let statusHtml = '';
      let actionHtml = '';
      let rowCls = 'env-model-item';

      if (isCurrent && p.total > 0) {
        // 正在下载此文件，有字节进度
        const pct = Math.max(0, Math.min(100, Math.round(p.downloaded * 100 / p.total)));
        rowCls += ' env-model-item-active';
        statusHtml = `<div class="env-model-progress">
            <div class="env-model-progress-bar"><div style="width:${pct}%"></div></div>
            <div class="env-model-progress-meta">
              <span class="env-model-pct">${pct}%</span>
              <span class="env-model-speed">${(p.speed||0).toFixed(1)} MB/s &middot; ${this._humanBytes(p.downloaded||0)}/${this._humanBytes(p.total||0)}</span>
            </div>
          </div>`;
      } else if (isCurrent) {
        // 正在下载但还没拿到 total（HEAD/连接阶段）
        rowCls += ' env-model-item-active';
        const idx = p.file_index != null ? (p.file_index + 1) : '?';
        const tt = p.file_total || '?';
        statusHtml = `<div class="env-model-progress">
            <div class="env-model-progress-bar env-model-progress-indeterminate"><div></div></div>
            <div class="env-model-progress-meta">
              <span class="env-badge env-badge-loading">${T('animaModel.connecting','Connecting')} ${idx}/${tt}</span>
            </div>
          </div>`;
      } else if (isQueued) {
        // 本次任务排队中（尚未轮到）
        rowCls += ' env-model-item-queued';
        statusHtml = `<span class="env-badge env-badge-loading">${T('animaModel.pending','Pending')}</span>`;
      } else if (f.exists) {
        statusHtml = `<span class="env-badge env-badge-ok">${T('animaModel.downloaded','Downloaded')} &middot; ${this._humanBytes((f.size_gb||0)*1073741824)}</span>`;
      } else if (!busy && groupTask && phase === 'error' && curFile === f.filename) {
        // 本次任务里此文件失败
        rowCls += ' env-model-item-failed';
        statusHtml = `<span class="env-badge env-badge-err">${T('animaModel.failed','Failed')}</span>`;
      } else if (!busy && groupTask && inBatch && phase === 'done') {
        // 本次任务正常结束但该文件没落盘 → 视为失败
        rowCls += ' env-model-item-failed';
        statusHtml = `<span class="env-badge env-badge-err">${T('animaModel.failed','Failed')}</span>`;
      } else {
        statusHtml = `<span class="env-badge env-badge-warn">${T('animaModel.notDownloaded','Not downloaded')}</span>`;
      }

      // 操作按钮：每行可单独下载
      if (isCurrent || isQueued) {
        actionHtml = `<button class="btn btn-sm btn-ghost env-model-dl" disabled>${T('animaModel.downloading','Downloading')}</button>`;
      } else if (f.exists) {
        actionHtml = `<button class="btn btn-sm btn-ghost env-model-dl" data-group="${this.escapeAttr(modelGroup)}" data-file="${this.escapeAttr(f.filename)}" ${busy?'disabled':''} title="${T('animaModel.redownload','Redownload')}">${T('animaModel.redownload','Redownload')}</button>`;
      } else {
        actionHtml = `<button class="btn btn-sm btn-secondary env-model-dl" data-group="${this.escapeAttr(modelGroup)}" data-file="${this.escapeAttr(f.filename)}" ${busy?'disabled':''}>${T('animaModel.download','Download')}</button>`;
      }

      // 每文件目标相对路径作为副标题（"下载到哪里"的逐文件体现）
      const destPath = f.dest_path || (destDir + f.filename);
      h += `<div class="${rowCls}">
        <div class="env-model-item-top">
          <div class="env-model-item-main">
            <div class="env-model-item-name"><a href="${this.escapeAttr(f.source_url || '#')}" target="_blank" rel="noopener" class="env-link"><code title="${this.escapeAttr(f.filename)}">${this.esc(f.filename)}</code></a></div>
            <div class="env-model-item-desc">${this.esc(f.desc || '')}</div>
            <div class="env-model-destpath">${this.esc(destPath)}</div>
          </div>
          <div class="env-model-item-action">${actionHtml}</div>
        </div>
        <div class="env-model-item-status">${statusHtml}</div>
      </div>`;
    }

    // Loading 占位（status 还没拉回来）
    if (!files.length) {
      h += `<div class="env-model-item"><span class="env-badge env-badge-loading">${T('loading','Loading...')}</span></div>`;
    }
    h += `</div>`; // .env-model-list

    // ── 底部操作栏：一键下载全部 + 刷新 ──
    const hasMissing = files.some(f => !f.exists);
    const dlAllLabel = groupBusy
      ? T('animaModel.downloading','Downloading...')
      : (hasMissing ? T('animaModel.downloadAll','Download All') : T('animaModel.downloadAllAgain','Re-download All'));
    const repoId = files[0]?.repo_id || (isKrea2 ? 'Comfy-Org/Krea-2' : 'circlestone-labs/Anima');
    const repoUrl = `https://huggingface.co/${this.escapeAttr(repoId)}/tree/main`;
    h += `<div class="env-model-footer"><div class="env-actions"><button class="btn btn-secondary env-model-dl-all" data-group="${this.escapeAttr(modelGroup)}" ${busy?'disabled':''}>${dlAllLabel}</button><button class="btn-icon env-model-refresh" ${busy?'disabled':''} title="${T('refresh','Refresh')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button><a href="${repoUrl}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">${T('animaModel.openRepository','Open model repository')} &#8599;</a></div></div>`;

    // ── 下载日志（可折叠，状态持久化避免重渲染被收起）──
    if (this.animaModelLog && groupTask) {
      h += `<details class="env-model-log-wrap" data-model-log ${this.animaModelLogOpen?'open':''}><summary>${T('animaModel.progressLog','Progress Log')}</summary>${this._renderLog(this.animaModelLog)}</details>`;
    }

    h += this._renderCardClose();
    return h;
  },

  _bindAnimaModelEvents(el) {
    const a = window.__anima || this;
    el.querySelectorAll('.env-model-dl-all[data-group]').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelDownload(null, btn.dataset.group));
    });
    el.querySelectorAll('.env-model-refresh').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelRefresh());
    });

    // 逐文件下载按钮
    el.querySelectorAll('.env-model-dl[data-file]').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelDownload(btn.dataset.file, btn.dataset.group));
    });

    // 日志折叠持久化 + 自动滚到底
    el.querySelectorAll('[data-model-log]').forEach(logDet => {
      logDet.addEventListener('toggle', () => {
        a.animaModelLogOpen = logDet.open;
        a._envSaveCardState();
        if (logDet.open) {
          const pre = logDet.querySelector('.env-log');
          if (pre) pre.scrollTop = pre.scrollHeight;
        }
      });
      // 默认展开时也滚到底（实时日志持续追加）
      if (logDet.open) {
        const pre = logDet.querySelector('.env-log');
        if (pre) pre.scrollTop = pre.scrollHeight;
      }
    });
  },

  // ═══════════════════════════════════════════════════════
  //  Event bindings
  // ═══════════════════════════════════════════════════════
  _bindFaEvents(el, T) {
    const a = window.__anima || this;
    const autoBtn = el.querySelector('#fa-auto-btn');
    const faRefreshBtn = el.querySelector('#fa-refresh-btn');
    if (autoBtn) autoBtn.addEventListener('click', () => a.faInstall(null));
    if (faRefreshBtn) faRefreshBtn.addEventListener('click', () => a.faRefresh());
    const toggleBtn = el.querySelector('#fa-toggle-btn');
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

  _bindTritonEvents(el) {
    const a = window.__anima || this;
    const installBtn = el.querySelector('#triton-install-btn'), reinstallBtn = el.querySelector('#triton-reinstall-btn'), refreshBtn = el.querySelector('#triton-refresh-btn');
    if (installBtn) installBtn.addEventListener('click', () => a.tritonInstall());
    if (reinstallBtn) reinstallBtn.addEventListener('click', () => a.tritonInstall());
    if (refreshBtn) refreshBtn.addEventListener('click', () => a.tritonRefresh());
  },

  _bindCardToggle(el) {
    const a = window.__anima || this;
    ['env-flash-attn','env-xformers','env-sdscripts','env-lycoris','env-musubi','env-triton','env-llama-runtime','env-anima-model','env-krea2-model'].forEach(id => {
      const card = el.querySelector('#'+id); if (!card) return;
      card.addEventListener('toggle', () => {
        if (id==='env-flash-attn') a.faCardOpen = card.open;
        else if (id==='env-xformers') a.xfCardOpen = card.open;
        else if (id==='env-sdscripts') a.sdCardOpen = card.open;
        else if (id==='env-lycoris') a.lycorisCardOpen = card.open;
        else if (id==='env-musubi') a.musubiCardOpen = card.open;
        else if (id==='env-triton') a.tritonCardOpen = card.open;
        else if (id==='env-anima-model') a.animaModelCardOpen = card.open;
        else if (id==='env-llama-runtime') a.llamaRuntimeCardOpen = card.open;
        else if (id==='env-krea2-model') a.kreaModelCardOpen = card.open;
        a._envSaveCardState();
      });
    });
  }
};
