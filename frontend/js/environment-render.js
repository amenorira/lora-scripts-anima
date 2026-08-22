/* ================================================================
   environment-render.js — renderEnvironment + event bindings
   Mixin merged into animaApp Alpine component

   架构：分槽增量渲染。renderEnvironment() 首次建立稳定骨架
   （加载状态 / Hero 总览 / 6 个组件行槽位 / 模型组槽位），
   之后每帧按槽位比对 HTML，只替换变化的槽位 → 进度 tick 不再
   摧毁整页 DOM，折叠动画、输入焦点、日志滚动位置全部存活。

   布局：Hero（全宽）→ 运行环境（双列独立堆叠）→ 模型文件（组并排）。
   组件以"行 + 行内展开详情"取代旧 details 卡片墙；健康组件只占一行。
   ================================================================ */

// 模型分组 → 槽位 / 标题 / 无文件时回退仓库（与后端 MODEL_FILES 的 group 字段对应）
const ENV_MODEL_GROUPS = {
  'Anima': { slot: 'animaModel', titleKey: 'animaModel.animaTitle', titleFallback: 'Anima Models', fallbackRepo: 'circlestone-labs/Anima' },
  'Krea 2': { slot: 'krea2', titleKey: 'animaModel.krea2Title', titleFallback: 'Krea 2 Models', fallbackRepo: 'Comfy-Org/Krea-2' },
  'Train Use': { slot: 'trainUse', titleKey: 'animaModel.trainUseTitle', titleFallback: 'Additional Models', fallbackRepo: 'ame-la/train_use_models' },
};

window.environmentRenderMixin = {
  renderEnvironment() {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    if (this._environmentRenderFrame != null) {
      cancelAnimationFrame(this._environmentRenderFrame);
      this._environmentRenderFrame = null;
    }
    const T = (k, fb) => this.t('environment.' + k) || fb || k;
    this._ensureEnvSkeleton(el, T);
    this._updateEnvSectionTitles(el, T);
    this._syncEnvTabDom(el);
    if (!this._envTabsBound && el.querySelector('[data-env-tabs]')) {
      this._envTabsBound = true;
      el.querySelectorAll('[data-env-tab]').forEach(btn => {
        btn.addEventListener('click', () => this.envSetTab(btn.dataset.envTab));
      });
    }

    const slots = {
      overview: this._renderOverview(T),
      fa: this._renderFaRow(T),
      xf: this._renderXfRow(T),
      triton: this._renderTritonRow(T),
      sd: this._renderSdRow(T),
      lycoris: this._renderLycorisRow(T),
      musubi: this._renderMusubiRow(T),
      animaModel: this._renderModelGroup(T, 'Anima'),
      krea2: this._renderModelGroup(T, 'Krea 2'),
      trainUse: this._renderModelGroup(T, 'Train Use'),
    };
    if (!this._envSlotHtml) this._envSlotHtml = {};
    for (const slot of Object.keys(slots)) {
      const host = el.querySelector('[data-env-slot="' + slot + '"]');
      if (!host) continue;
      const html = slots[slot];
      if (this._envSlotHtml[slot] === html) continue; // 无变化 → DOM 保留
      this._envSlotHtml[slot] = html;
      host.innerHTML = html;
      this._bindSlotEvents(host, slot, T);
    }
    this._autoScrollLogs(el);
  },

  // ── 稳定骨架（只建一次）──────────────────────────────
  _ensureEnvSkeleton(el, T) {
    if (el.dataset.envSkeleton === '1' && el.querySelector('[data-env-slot="overview"]')) return;
    el.dataset.envSkeleton = '1';
    el.innerHTML = ''
      + '<div data-env-slot="overview"></div>'
      + '<div class="env-tabs" role="tablist" data-env-tabs>'
      +   `<button type="button" role="tab" class="env-tab" data-env-tab="env">${this.esc(T('envTabEnv','Environment'))}</button>`
      +   `<button type="button" role="tab" class="env-tab" data-env-tab="models">${this.esc(T('envTabModels','Models'))}</button>`
      +   '<span class="env-tab-indicator" aria-hidden="true"></span>'
      + '</div>'
      + '<div class="env-tab-panel" data-env-tab-panel="env">'
      +   '<div class="env-env-grid">'
      +     '<div class="env-col" data-env-anchor-target="accel">'
      +       '<div class="env-section-title" data-env-title="accel"></div>'
      +       '<div data-env-slot="fa"></div>'
      +       '<div data-env-slot="xf"></div>'
      +       '<div data-env-slot="triton"></div>'
      +     '</div>'
      +     '<div class="env-col" data-env-anchor-target="core">'
      +       '<div class="env-section-title" data-env-title="core"></div>'
      +       '<div data-env-slot="sd"></div>'
      +       '<div data-env-slot="lycoris"></div>'
      +       '<div data-env-slot="musubi"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '<div class="env-tab-panel" data-env-tab-panel="models">'
      +   '<div class="env-models-wrap" data-env-anchor-target="models">'
      +     '<div class="env-section-title"><span data-env-title="models"></span><span class="env-section-note" data-env-note="models"></span></div>'
      +     '<div class="env-models-grid">'
      +       '<div data-env-slot="animaModel"></div>'
      +       '<div data-env-slot="krea2"></div>'
      +       '<div data-env-slot="trainUse"></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  },

  // Tab 状态同步到 DOM（隐藏面板 + active 按钮 + 面板淡入动画）
  _syncEnvTabDom(el) {
    const tab = this.environmentTab === 'models' ? 'models' : 'env';
    el.querySelectorAll('[data-env-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.envTab === tab);
    });
    el.querySelectorAll('[data-env-tab-panel]').forEach(p => {
      p.hidden = p.dataset.envTabPanel !== tab;
    });
    // 面板初次落位/切换回时播放淡入（避免进度 tick 重渲染反复触发）
    if (this._envVisiblePanel !== tab) {
      this._envVisiblePanel = tab;
      const panel = el.querySelector('[data-env-tab-panel="' + tab + '"]');
      if (panel) {
        panel.classList.remove('env-panel-in');
        void panel.offsetWidth;
        panel.classList.add('env-panel-in');
      }
    }
    if (this._envTabIndicatorScheduled) return;
    this._envTabIndicatorScheduled = true;
    requestAnimationFrame(() => {
      this._envTabIndicatorScheduled = false;
      this._syncEnvTabIndicator();
    });
  },

  // 滑动指示条：跟随激活 tab 的位置与宽度（参照监控台实现）
  _syncEnvTabIndicator() {
    const bar = document.getElementById('environmentPage')?.querySelector('.env-tabs');
    if (!bar) return;
    const indicator = bar.querySelector('.env-tab-indicator');
    const active = bar.querySelector('.env-tab.active');
    if (!indicator || !active || !active.offsetWidth) {
      this._envTabIndicatorGeom = null;
      return;
    }
    if (!this._envTabIndicatorRO) {
      this._envTabIndicatorRO = new ResizeObserver(() => {
        const a = bar.querySelector('.env-tab.active');
        const g = this._envTabIndicatorGeom;
        if (!a || !a.offsetWidth || !g) return;
        if (a.offsetLeft === g.l && a.offsetWidth === g.w) return;
        this._syncEnvTabIndicator();
      });
      bar.querySelectorAll('.env-tab').forEach(btn => this._envTabIndicatorRO.observe(btn));
    }
    const l = active.offsetLeft, w = active.offsetWidth;
    const g = this._envTabIndicatorGeom;
    if (g && g.l === l && g.w === w) return;
    if (!g) {
      bar.classList.add('no-anim');
      indicator.style.width = w + 'px';
      indicator.style.transform = 'translateX(' + l + 'px)';
      void indicator.offsetWidth;
      bar.classList.remove('no-anim');
      bar.classList.add('indicator-ready');
      this._envTabIndicatorGeom = { l, w };
      return;
    }
    indicator.style.width = w + 'px';
    indicator.style.transform = 'translateX(' + l + 'px)';
    this._envTabIndicatorGeom = { l, w };
  },

  _updateEnvSectionTitles(el, T) {
    const set = (key, text) => {
      const n = el.querySelector('[data-env-title="' + key + '"]');
      if (n && n.textContent !== text) n.textContent = text;
    };
    set('accel', T('sectionAccel', 'Performance acceleration'));
    set('core', T('sectionCore', 'Training Core'));
    set('models', T('sectionModels', 'Models'));
    // 「下载到哪」的极短说明只在区标题行出现一次（文件行已逐行显示目标路径）
    const note = el.querySelector('[data-env-note="models"]');
    const noteText = T('animaModel.destShort', 'Downloads to models/');
    if (note && note.textContent !== noteText) note.textContent = noteText;
  },

  // 页面级加载指示已并入 Hero 骨架（env-load-spinner + env-load-status，
  // 类名为 tests/test_realtime.py 契约），不再单独渲染顶部横条。

  // 分槽渲染只替换变化的槽位 DOM，未变化槽位的 .env-log 滚动位置天然保留；
  // 这里只把"刚重建且内容溢出"的日志滚到底（实时日志持续追加，用户要看最新行）。
  _autoScrollLogs(el) {
    el.querySelectorAll('.env-log').forEach(pre => {
      if (pre.scrollHeight > pre.clientHeight) {
        pre.scrollTop = pre.scrollHeight;
      }
    });
  },

  // ═══════════════════════════════════════════════════════
  //  Hero 总览面板
  // ═══════════════════════════════════════════════════════
  _renderOverview(T) {
    const faOk = !!(this.faStatus && this.faStatus.installed);
    const xfOk = !!(this.xfStatus && this.xfStatus.installed);
    const trOk = !!(this.tritonStatus && this.tritonStatus.installed);
    const accelReady = !!(this.faStatus && this.xfStatus && this.tritonStatus);
    const accelDone = [faOk, xfOk, trOk].filter(Boolean).length;

    const sdOk = !!(this.sdStatus && this.sdStatus.local);
    const lyAdapter = this.trainingCores && (this.trainingCores.adapters || []).find(i => i.id === 'lycoris');
    const muEngine = this.trainingCores && (this.trainingCores.engines || []).find(i => i.id === 'musubi_tuner');
    const lyOk = !!(lyAdapter && lyAdapter.available);
    const muOk = !!(muEngine && muEngine.available);
    const coreReady = !!(this.sdStatus && this.trainingCores);
    const coreDone = [sdOk, lyOk, muOk].filter(Boolean).length;

    const files = this.animaModelStatus || [];
    const modelsReady = !!this.animaModelStatus;
    const modelDone = files.filter(f => f.exists).length;
    const modelTotal = files.length;

    const hasError = !!(this.faError || this.xfError || this.tritonError || this.trainingCoresError || this.animaModelError);
    const allLoaded = accelReady && coreReady && modelsReady;

    // 三态 Hero：加载中 / 有真实错误（红）/ 运行正常（绿）。
    // 未安装、未下载、未配置都是可选增强的中性状态，不进 Hero 状态机。
    let heroState, heroTitle, heroSub;
    if (hasError) {
      heroState = 'err';
      heroTitle = T('overview.needsAttention', 'Needs attention');
      heroSub = T('overview.subError', 'Check the highlighted rows for error details.');
    } else if (!allLoaded) {
      heroState = 'loading';
      heroTitle = T('overview.checking', 'Checking environment...');
      heroSub = '';
    } else {
      heroState = 'ok';
      heroTitle = T('overview.allReady', 'Running normally');
      heroSub = T('overview.subReady', 'Acceleration libraries and models are optional enhancements — install them as needed.');
    }

    // 控制面板式摘要行：纯文字计数（加速 x/3 · 核心 x/3 · 模型 x/y），不做可点芯片
    const summary = (done, total, ready, label) => {
      const num = ready ? `${done}/${ready ? total : '–'}` : '–';
      return `<span>${label} ${num}</span>`;
    };
    const summaryHtml = `<div class="env-hero-summary">`
      + summary(accelDone, 3, accelReady, T('overview.accel', 'Acceleration'))
      + `<span class="env-summary-sep">·</span>`
      + summary(coreDone, 3, coreReady, T('overview.core', 'Training core'))
      + `<span class="env-summary-sep">·</span>`
      + summary(modelDone, modelTotal, modelsReady, T('overview.models', 'Models'))
      + `</div>`;

    // 加载态：spinner + 文案并入 Hero 标题行（页面级仅此一个加载指示，
    // env-load-spinner / env-load-status 类名为测试契约，勿改）
    const heroStatusHtml = heroState === 'loading'
      ? `<div class="env-hero-status"><span class="env-load-spinner" aria-hidden="true"></span><span class="env-load-status" role="status" aria-live="polite">${heroTitle}</span></div>`
      : `<div class="env-hero-status">${heroTitle}</div>`;

    return `<section class="env-hero env-hero-${heroState}">`
      + `<div class="env-hero-main">`
      +   `<div class="env-hero-text">`
      +     heroStatusHtml
      +     (heroSub ? `<div class="env-hero-sub">${heroSub}</div>` : '')
      +     summaryHtml
      +   `</div>`
      + `</div>`
      + `<div class="env-hero-side">`
      +   `<button type="button" class="btn btn-sm btn-ghost env-toggle-all" data-env-toggle-all="open">${T('envExpandAll','Expand all')}</button>`
      +   `<button type="button" class="btn btn-sm btn-ghost env-toggle-all" data-env-toggle-all="close">${T('envCollapseAll','Collapse all')}</button>`
      +   `<button class="btn btn-sm btn-secondary env-refresh-all" data-env-refresh-all ${this.environmentLoading ? 'disabled' : ''}>`
      +     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`
      +     `<span>${T('refreshAll', 'Refresh all')}</span></button>`
      + `</div>`
      + `</section>`;
  },

  // ═══════════════════════════════════════════════════════
  //  行组件（自然语言流式）：首行 名称+状态+版本，次行 次级说明，
  //  末行 主操作 + 详情文字链接；整行可点击展开（链接/按钮不触发）
  // ═══════════════════════════════════════════════════════
  _renderRowHead(slotId, open, parts) {
    return `<div class="env-row-head" role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}" data-env-toggle="${slotId}">`
      + `<div class="env-flow-main">`
      +   `<span class="env-row-name">${parts.name}</span>`
      +   (parts.badge || '')
      +   (parts.version || '')
      + `</div>`
      + (parts.desc ? `<div class="env-row-desc">${parts.desc}</div>` : '')
      + `<div class="env-row-ops">`
      +   (parts.action || '')
      +   (parts.detailKey
          ? `<button type="button" class="env-text-link env-detail-link" data-env-detail="${parts.detailKey}" aria-expanded="${open ? 'true' : 'false'}">${this.esc(parts.detailLabel || this.t('environment.details','Details'))}<span class="env-caret" aria-hidden="true"></span></button>`
          : '')
      + `</div>`
      + `</div>`;
  },

  _renderRow(slotId, state, open, headHtml, bodyHtml) {
    const hasBody = !!bodyHtml;
    return `<div class="env-trow env-trow-${state}${open && hasBody ? ' env-open' : ''}" data-env-row="${slotId}">`
      + headHtml
      + (hasBody ? `<div class="env-row-body" data-env-body="${slotId}"><div class="env-row-body-inner">${bodyHtml}</div></div>` : '')
      + `</div>`;
  },

  // 错误条：常驻显示失败原因 + 可选"复制日志"按钮
  _renderErrorBar(T, msg, logKey) {
    const copyBtn = logKey
      ? `<button class="btn btn-ghost btn-sm env-copy-log" data-env-copy="${logKey}">${T('copyLog', 'Copy log')}</button>`
      : '';
    return `<div class="env-msg env-msg-err env-errorbar"><pre>${this.esc(msg)}</pre>${copyBtn}</div>`;
  },

  // ═══════════════════════════════════════════════════════
  //  Shared render helpers
  // ═══════════════════════════════════════════════════════

  // 详情行：label(42px) + content。
  _renderDetailGroup(label, contentHtml) {
    return `<div class="env-detail-group"><span class="env-detail-label">${label||''}</span><div class="env-detail-content">${contentHtml}</div></div>`;
  },

  // 刷新图标按钮（FA/xf/triton/模型 共用）。
  _renderRefreshBtn(id, disabled, cls) {
    return `<button id="${id}" class="btn-icon ${cls || ''}" ${disabled?'disabled':''} title="${this.t('environment.refresh')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>`;
  },

  // 统一进度面板。opts: {stage, pct, speedMB, downloadedBytes, totalBytes, elapsed, fileIndex, fileTotal}
  //   stage: 'downloading' → 进度条+百分比+速度+大小
  //          'connecting'  → 不定式条 + 连接中文案
  //          'installing'/'working' → spinner + 阶段文案 + 计时
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


  // 日志渲染：按行套色（ERROR/RETRY/WARN 红/橙，完成/Successfully 绿），输出到 <pre class="env-log">。
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
  //  Flash Attention 行
  // ═══════════════════════════════════════════════════════
  _renderFaRow(T) {
    const s = this.faStatus;
    const env = s?.env || {};
    const candidates = s?.candidates || [];
    const usable = candidates.filter(c => c.usable);
    const best = usable[0] || null;
    const canAuto = !!env.torch_tag && !!env.platform && usable.length > 0;
    const faInstalled = s?.installed;
    const open = this._envCardOpen('fa');

    const state = this.faBusy ? 'loading' : this.faError ? 'err' : !s ? 'loading' : faInstalled ? 'ok' : 'muted';
    const badge = this.faBusy
      ? `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`
      : this.faError
        ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
        : !s
          ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
          : faInstalled
            ? `<span class="env-badge env-badge-ok">${T('installed','Installed')}</span>`
            : `<span class="env-badge env-badge-muted">${T('optionalNotInstalled','Optional · Not installed')}</span>`;
    const version = faInstalled && s.version ? `<span class="env-row-version">v${this.esc(s.version)}</span>` : '';
    const headBtn = this.faBusy
      ? `<button type="button" class="btn btn-sm btn-ghost env-head-btn" disabled>${T('installing','Installing...')}</button>`
      : `<button type="button" class="btn btn-sm ${faInstalled ? 'btn-ghost' : 'btn-secondary'} env-head-btn" data-env-action="fa" ${!faInstalled && !canAuto ? '' : ''}>${faInstalled ? T('reinstall','Reinstall') : T('install','Install')}</button>`;
    const head = this._renderRowHead('fa', open, {
      name: 'Flash Attention',
      desc: T('trainingAccel','Training acceleration (optional)'),
      version, badge, action: headBtn,
      detailKey: 'fa', detailLabel: T('details','Details'),
    });

    // Busy: 下载/安装进度面板 + 日志
    if (this.faBusy) {
      const p = this.faProgress || {};
      const stage = p.stage || 'downloading';
      let body = '';
      if (stage === 'downloading' && p.total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((p.downloaded||0) * 100 / p.total)));
        body += this._renderProgressPanel({
          stage: 'downloading', pct,
          speedMB: p.speed || 0,
          downloadedBytes: p.downloaded||0,
          totalBytes: p.total||0,
          elapsed: this.faInstallElapsed,
        });
      } else if (stage === 'downloading') {
        body += this._renderProgressPanel({ stage: 'connecting', elapsed: this.faInstallElapsed });
      } else {
        body += this._renderProgressPanel({ stage: stage === 'done' ? 'done' : 'installing', elapsed: this.faInstallElapsed });
      }
      body += this._renderLog(this.faLog);
      return this._renderRow('fa', state, open, head, body);
    }

    let body = '';
    if (this.faError) body += this._renderErrorBar(T, this.faError, 'faLog');

    if (s) {
      // Environment info
      const envItems = [];
      if (faInstalled) envItems.push(`<span class="env-env-item">flash_attn <em>v${s.version||'?'}</em></span>`);
      if (env.python_tag) envItems.push(`<span class="env-env-item"><em>${env.python_tag}</em></span>`);
      if (env.cuda_tag) envItems.push(`<span class="env-env-item">CUDA <em>${env.cuda_tag}</em> <span class="env-text-dim">(${env.cuda_ver||'?'})</span></span>`);
      if (env.torch_tag) envItems.push(`<span class="env-env-item">PyTorch <em>${env.torch_tag}</em></span>`);
      if (env.platform) envItems.push(`<span class="env-env-item"><em>${env.platform}</em></span>`);
      body += this._renderDetailGroup(T('envLabel','Env'), envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`);

      // Error / info messages
      if (s.fetch_error) {
        if (s.from_disk_cache) body +=`<div class="env-msg env-msg-info">${T('usingCachedData','Using cached data.')} ${T('cachedDataHint','Auto-updates on next success.')}</div>`;
        else if (/rate limit|限流/i.test(s.fetch_error)) body +=`<div class="env-msg env-msg-info">${T('githubApiFail','GitHub API unavailable')}<br>${T('rateLimitHint','Will retry. Paste URL manually.')}</div>`;
        else body +=`<div class="env-msg env-msg-info">${T('githubApiFail','GitHub API unavailable')}: ${this.esc(s.fetch_error)}<br>${T('manualUrlHint','Paste wheel URL manually.')}</div>`;
      }
      if (!canAuto && !s.fetch_error && env.platform && env.torch_tag) body +=`<div class="env-msg env-msg-info">${T('noWheel','No matching wheel. Paste URL manually.')}</div>`;

      // Confirm dialog
      if (this.faConfirmMsg) {
        body +=`<div class="env-confirm"><span class="env-confirm-msg">${this.faConfirmMsg}</span><button id="fa-confirm-yes" class="btn btn-sm btn-primary">${T('confirmYes','Confirm')}</button><button id="fa-confirm-no" class="btn btn-sm btn-ghost">${T('confirmNo','Cancel')}</button></div>`;
      } else {
        // 主操作行：source 三选一 + 安装此版本 + 自动/重装 + 刷新
        let ops = `<div class="env-actions">`;
        ops += `<span class="env-source-group"><button id="fa-src-default" class="env-source-btn ${this.faSource==='default'?'active':''}" title="${T('sourceDefaultHint','Direct to GitHub, auto-fallback to mirrors')}">${T('sourceDefault','Official')}</button><button id="fa-src-mirror" class="env-source-btn ${this.faSource==='mirror'?'active':''}" title="${T('sourceMirrorHint','Use mirrors directly')}">${T('sourceMirror','Mirror')}</button><button id="fa-src-fallback" class="env-source-btn ${this.faSource==='fallback'?'active':''}" title="${T('sourceFallbackHint','Alternate wheel repository')}">${T('sourceFallback','Alt')}</button></span>`;
        if (best) {
          ops += `<button id="fa-best-install-btn" class="btn btn-sm btn-secondary" ${this.faBusy?'disabled':''} data-url="${this.escapeAttr(best.url)}" title="${this.escapeAttr(best.name)}">${T('installThis','Install this')}</button>`;
        }
        ops += `<button id="fa-auto-btn" class="btn btn-sm btn-secondary" ${this.faBusy||!canAuto?'disabled':''} title="${best?this.escapeAttr(best.name):''}">${faInstalled?T('reinstall','Reinstall'):T('autoInstall','Auto Install')}</button>`;
        ops += this._renderRefreshBtn('fa-refresh-btn', this.faBusy);
        ops += `</div>`;
        body += ops;

        // 高级选项子折叠：候选 wheel 列表 + 手动 URL
        let adv = `<button id="fa-toggle-btn" class="btn btn-ghost btn-sm env-toggle-candidates">${this.faCandidatesOpen ? T('hideAllCandidates','Hide all') : T('showAllCandidates','Show all') + ' (' + candidates.length + ')'}</button>`;
        if (this.faCandidatesOpen && candidates.length) {
          adv += `<ul class="env-candidate-list">`;
          candidates.forEach(c => {
            const mark = c.usable?'ok':'warn';
            adv += `<li class="env-candidate-item"><span class="env-candidate-mark env-candidate-${mark}">${c.usable?'&#10003;':'&#10007;'}</span><code class="env-candidate-name" title="${this.escapeAttr(c.name)}">${this.esc(c.name)}</code>${c.notes.length?`<span class="env-candidate-notes">${this.esc(c.notes.map(n=>typeof n==='string'?n:(T('faNote.'+n.key)||n.text||n.key)).join('; '))}</span>`:''}<button class="fa-candidate-btn btn btn-sm ${c.usable?'btn-secondary':'btn-ghost'}" data-url="${this.escapeAttr(c.url)}">${c.usable?T('install','Install'):T('forceInstall','Force')}</button></li>`;
          });
          adv += `</ul>`;
        }
        adv += `<div class="env-manual-url"><input type="text" class="env-url-input" placeholder="https://github.com/.../flash_attn-...whl" id="fa-manual-input"><button id="fa-url-btn" class="btn btn-sm btn-secondary">${T('installUrl','URL Install')}</button></div>`;
        body += this._renderSubCollapse('faAdvanced', T('advancedOptions','Advanced options'), this.faAdvancedOpen, adv);
      }
    }

    return this._renderRow('fa', state, open, head, body);
  },

  // 子折叠面板（高级选项 / 下载日志共用）。open 为当前展开状态。
  _renderSubCollapse(key, label, open, innerHtml) {
    return `<div class="env-sub${open ? ' env-open' : ''}" data-env-sub="${key}">`
      + `<div class="env-sub-head" role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}" data-env-sub-head="${key}">`
      + `<span class="env-sub-arrow" aria-hidden="true"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg></span>`
      + `<span>${label}</span></div>`
      + `<div class="env-sub-body"><div class="env-sub-body-inner">${innerHtml}</div></div>`
      + `</div>`;
  },

  // ═══════════════════════════════════════════════════════
  //  xformers 行
  // ═══════════════════════════════════════════════════════
  _renderXfRow(T) {
    const xs = this.xfStatus; const xfEnv = xs?.env || {}; const xfInstalled = xs?.installed;
    const open = this._envCardOpen('xf');

    if (this.xfBusy) {
      const head = this._renderRowHead('xf', open, {
        name: 'xformers',
        desc: T('xfHint','Memory-efficient attention (optional)'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`,
        action: `<button type="button" class="btn btn-sm btn-ghost env-head-btn" disabled>${T('installing','Installing...')}</button>`,
        detailKey: 'xf', detailLabel: T('details','Details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.xfInstallElapsed, label: T('xfInstallingHint','Downloading...') })
        + this._renderLog(this.xfInstallLog);
      return this._renderRow('xf', 'loading', open, head, body);
    }

    const state = this.xfError ? 'err' : !xs ? 'loading' : xfInstalled ? 'ok' : 'muted';
    const badge = this.xfError ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !xs ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
      : xfInstalled ? `<span class="env-badge env-badge-ok">${T('installed','Installed')}</span>`
      : `<span class="env-badge env-badge-muted">${T('optionalNotInstalled','Optional · Not installed')}</span>`;
    const version = xfInstalled && xs.version ? `<span class="env-row-version">v${this.esc(xs.version)}</span>` : '';
    const headBtn = `<button type="button" class="btn btn-sm ${xfInstalled ? 'btn-ghost' : 'btn-secondary'} env-head-btn" data-env-action="xf">${xfInstalled ? T('reinstall','Reinstall') : T('install','Install')}</button>`;
    const head = this._renderRowHead('xf', open, {
      name: 'xformers',
      desc: T('xfHint','Memory-efficient attention (optional)'),
      version, badge, action: headBtn,
      detailKey: 'xf', detailLabel: T('details','Details'),
    });

    let body = '';
    if (this.xfError) body += this._renderErrorBar(T, this.xfError, 'xfInstallLog');

    if (xs) {
      const envItems = [];
      if (xfInstalled) envItems.push(`<span class="env-env-item">xformers <em>v${xs.version||'?'}</em></span>`);
      if (xfEnv.python_tag) envItems.push(`<span class="env-env-item"><em>${xfEnv.python_tag}</em></span>`);
      if (xfEnv.torch_ver) envItems.push(`<span class="env-env-item">PyTorch <em>${xfEnv.torch_ver}</em></span>`);
      if (xfEnv.cuda_ver) envItems.push(`<span class="env-env-item">CUDA <em>cu${xfEnv.cuda_ver.replace('.','')}</em></span>`);
      body += this._renderDetailGroup(T('envLabel','Env'), envItems.join(' &middot; ') || `<span class="env-text-dim">${T('notDetected','N/A')}</span>`);

      if (!xfInstalled) body += `<div class="env-msg env-msg-info">${T('xfInstallInfo','Installs latest compatible version from PyPI.')}</div>`;

      body += `<div class="env-actions"><button id="xf-install-btn" class="btn btn-sm btn-secondary" ${this.xfBusy?'disabled':''}>${xfInstalled?T('reinstall','Reinstall'):T('xfInstallBtn','Install via PyPI')}</button>${this._renderRefreshBtn('xf-refresh-btn', this.xfBusy)}</div>`;
    }

    return this._renderRow('xf', state, open, head, body);
  },

  // ═══════════════════════════════════════════════════════
  //  训练核心行（sd-scripts / LyCORIS / musubi-tuner）
  // ═══════════════════════════════════════════════════════
  // 行头右侧：版本号（mono，链 GitHub）+ 状态徽标。
  _renderCoreHeadParts(T, meta, available = true, error = null) {
    if (error) return { version: '', badge: `<span class="env-badge env-badge-err">${T('loadFailed', 'Load failed')}</span>` };
    if (!meta) return { version: '', badge: `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>` };
    if (!available) return { version: '', badge: `<span class="env-badge env-badge-muted">${T('coreNotReady', 'Not configured')}</span>` };
    const displayVersion = meta.describe || meta.tag;
    let version = '';
    if (displayVersion) {
      const repoUrl = `https://github.com/${meta.repo}`;
      const versionUrl = meta.local_commit
        ? `${repoUrl}/commit/${this.escapeAttr(meta.local_commit)}`
        : `${repoUrl}/releases/tag/${this.escapeAttr(meta.tag)}`;
      version = `<a href="${versionUrl}" target="_blank" rel="noopener" class="env-row-version env-link"><code>${this.esc(displayVersion)}</code></a>`;
    } else if (meta.local_commit) {
      version = `<span class="env-row-version"><code>${this.esc(meta.local_commit.slice(0,7))}</code></span>`;
    }
    return { version, badge: `<span class="env-badge env-badge-ok">${T('coreReady','Ready')}</span>` };
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
      + `<div class="env-actions"><a href="${repoUrl}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">${T('sdScriptsOpenRepo','Open repo')} &#8599;</a></div>`;
  },

  _renderSdRow(T) {
    const sd = this.sdStatus; const sdLocal = sd?.local || null;
    const open = this._envCardOpen('sd');
    const state = !sd ? 'loading' : 'ok';
    const parts = this._renderCoreHeadParts(T, sd ? sdLocal : null);
    const head = this._renderRowHead('sd', open, {
      name: T('sdScriptsTitle','sd-scripts'),
      desc: T('sdScriptsDesc','kohya-ss/sd-scripts'),
      version: parts.version, badge: parts.badge,
      detailKey: 'sd', detailLabel: T('details','Details'),
    });
    const body = sd ? this._renderCoreRepositoryDetails(T, sdLocal, 'kohya-ss/sd-scripts') : '';
    return this._renderRow('sd', state, open, head, body);
  },

  _renderLycorisRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const adapter = registry?.adapters?.find(item => item.id === 'lycoris');
    const available = !!adapter?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'muted';
    const open = this._envCardOpen('lycoris');
    const parts = this._renderCoreHeadParts(T, adapter?.version || null, available, error);
    const head = this._renderRowHead('lycoris', open, {
      name: 'LyCORIS',
      desc: T('lycorisDesc', 'LoRA adapter core'),
      version: parts.version, badge: parts.badge,
      detailKey: 'lycoris', detailLabel: T('details','Details'),
    });
    let body = '';
    if (error) body += this._renderErrorBar(T, error, null);
    if (adapter) body += this._renderCoreRepositoryDetails(T, adapter.version, 'KohakuBlueleaf/LyCORIS');
    return this._renderRow('lycoris', state, open, head, body);
  },

  _renderMusubiRow(T) {
    const registry = this.trainingCores;
    const error = this.trainingCoresError;
    const engine = registry?.engines?.find(item => item.id === 'musubi_tuner');
    const available = !!engine?.available;
    const state = error ? 'err' : !registry ? 'loading' : available ? 'ok' : 'muted';
    const open = this._envCardOpen('musubi');
    const parts = this._renderCoreHeadParts(T, engine?.version || null, available, error);
    const head = this._renderRowHead('musubi', open, {
      name: 'musubi-tuner',
      desc: T('musubiDesc', 'Krea 2 training core'),
      version: parts.version, badge: parts.badge,
      detailKey: 'musubi', detailLabel: T('details','Details'),
    });
    let body = '';
    if (error) body += this._renderErrorBar(T, error, null);
    if (engine) {
      body += this._renderCoreRepositoryDetails(T, engine.version, 'kohya-ss/musubi-tuner');
      const runtimeErrors = Array.isArray(engine.runtime_errors) ? engine.runtime_errors : [];
      if (runtimeErrors.length) body += `<div class="env-msg env-msg-err"><pre>${this.esc(runtimeErrors.join('\n'))}</pre></div>`;
    }
    return this._renderRow('musubi', state, open, head, body);
  },

  // ═══════════════════════════════════════════════════════
  //  Triton 行
  // ═══════════════════════════════════════════════════════
  _renderTritonRow(T) {
    const tr = this.tritonStatus;
    const open = this._envCardOpen('triton');

    // Busy: installing
    if (this.tritonBusy) {
      const head = this._renderRowHead('triton', open, {
        name: 'Triton',
        desc: T('tritonDesc','GPU compile backend for torch.compile'),
        version: '', badge: `<span class="env-badge env-badge-loading">${T('installing','Installing...')}</span>`,
        action: `<button type="button" class="btn btn-sm btn-ghost env-head-btn" disabled>${T('installing','Installing...')}</button>`,
        detailKey: 'triton', detailLabel: T('details','Details'),
      });
      const body = this._renderProgressPanel({ stage: 'working', elapsed: this.tritonInstallElapsed, label: T('tritonInstallingHint','Downloading...') })
        + this._renderLog(this.tritonInstallLog);
      return this._renderRow('triton', 'loading', open, head, body);
    }

    const state = this.tritonError ? 'err' : !tr ? 'loading' : tr.installed ? 'ok' : 'muted';
    const badge = this.tritonError
      ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !tr
        ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
        : tr.installed
          ? `<span class="env-badge env-badge-ok">${T('tritonInstalled','Installed')}</span>`
          : `<span class="env-badge env-badge-muted">${T('optionalNotInstalled','Optional · Not installed')}</span>`;
    const version = tr && tr.installed && tr.version
      ? `<span class="env-row-version">v${this.esc(tr.version)}${tr.package ? ' · ' + this.esc(tr.package) : ''}</span>` : '';
    const headBtn = `<button type="button" class="btn btn-sm ${tr?.installed ? 'btn-ghost' : 'btn-secondary'} env-head-btn" data-env-action="triton">${tr?.installed ? T('reinstall','Reinstall') : T('install','Install')}</button>`;
    const head = this._renderRowHead('triton', open, {
      name: 'Triton',
      desc: T('tritonDesc','GPU compile backend for torch.compile'),
      version, badge, action: headBtn,
      detailKey: 'triton', detailLabel: T('details','Details'),
    });

    let body = '';
    if (this.tritonError) body += this._renderErrorBar(T, this.tritonError, 'tritonInstallLog');

    if (tr) {
      if (tr.installed) {
        body += this._renderDetailGroup(T('verLabel','Ver'), `<span class="env-env-item">${this.esc(tr.package||'triton')} <em>v${this.esc(tr.version||'?')}</em></span>`);
        body += `<div class="env-actions"><button id="triton-reinstall-btn" class="btn btn-sm btn-secondary" ${this.tritonBusy?'disabled':''}>${T('reinstall','Reinstall')}</button>${this._renderRefreshBtn('triton-refresh-btn', this.tritonBusy)}</div>`;
      } else {
        body += `<div class="env-msg env-msg-info">${T('tritonInstallInfo','Enables DiT per-block compilation. Windows installs a triton-windows version matched to PyTorch; Linux installs triton.')}</div>`;
        body += `<div class="env-actions"><button id="triton-install-btn" class="btn btn-sm btn-secondary" ${this.tritonBusy?'disabled':''}>${T('tritonInstallBtn','Install')}</button>${this._renderRefreshBtn('triton-refresh-btn', this.tritonBusy)}</div>`;
      }
    }
    return this._renderRow('triton', state, open, head, body);
  },

  // ═══════════════════════════════════════════════════════
  //  模型组（Anima / Krea 2）：组头统计 + 文件行 + 日志子折叠
  // ═══════════════════════════════════════════════════════
  _renderModelGroup(T, modelGroup) {
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
    const view = ENV_MODEL_GROUPS[modelGroup] || { slot: 'animaModel', titleKey: 'animaModel.animaTitle', titleFallback: 'Anima Models', fallbackRepo: 'circlestone-labs/Anima' };
    const slotId = view.slot;
    const open = this._envCardOpen(slotId);
    const title = T(view.titleKey, view.titleFallback);

    const allReady = files.length > 0 && files.every(f => f.exists);
    const state = groupError ? 'err' : !files.length ? 'loading' : allReady ? 'ok' : groupBusy ? 'loading' : 'muted';
    // 未齐全不是警告：组头已有 x/y 计数，不再出徽标
    const badge = groupError
      ? `<span class="env-badge env-badge-err">${T('loadFailed','Load failed')}</span>`
      : !files.length
        ? `<span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span>`
        : allReady
          ? `<span class="env-badge env-badge-ok">${T('animaModel.allReady','All ready')}</span>`
          : groupBusy
            ? `<span class="env-badge env-badge-loading">${T('animaModel.downloading','Downloading')}</span>`
            : '';

    // 组头统计：x/y 已下载 · 合计大小
    const doneFiles = files.filter(f => f.exists);
    const totalBytes = doneFiles.reduce((sum, f) => sum + (f.size_gb || 0) * 1073741824, 0);
    const countText = totalBytes > 0
      ? T('animaModel.downloadedCount','{x}/{y} downloaded · {size}').replace('{x}', doneFiles.length).replace('{y}', files.length).replace('{size}', this._humanBytes(totalBytes))
      : `${doneFiles.length}/${files.length}`;
    const countHtml = files.length
      ? `<span class="env-mgroup-count">${countText}</span>`
      : '';

    // 组头操作：只有主按钮（下载全部 / 重新下载全部）；刷新已有 Hero 全局，仓库在文件名链接
    const hasMissing = files.some(f => !f.exists);
    const dlAllLabel = groupBusy
      ? T('animaModel.downloading','Downloading...')
      : (hasMissing ? T('animaModel.downloadAll','Download All') : T('animaModel.downloadAllAgain','Re-download All'));
    const actionHtml = files.length
      ? `<button class="btn btn-sm btn-secondary env-model-dl-all" data-group="${this.escapeAttr(modelGroup)}" ${busy?'disabled':''}>${dlAllLabel}</button>`
      : '';

    const head = this._renderRowHead(slotId, open, {
      name: title, version: countHtml, badge, action: actionHtml,
      detailKey: slotId, detailLabel: T('animaModel.filesLabel','Files'),
    });

    let body = '';
    if (groupError) body += this._renderErrorBar(T, groupError, 'animaModelLog');

    // 整体批量进度（下载中显示）
    if (groupBusy && aggregate) {
      const fileOf = T('animaModel.fileOf','File {i}/{n}').replace('{i}', aggregate.fileIndex).replace('{n}', aggregate.fileTotal);
      body += `<div class="env-model-aggregate">
        <div class="env-progress-bar"><div style="width:${aggregate.pct}%"></div></div>
        <div class="env-progress-meta">
          <span class="env-progress-pct">${aggregate.pct}%</span>
          <span class="env-progress-meta-r">${this.esc(fileOf)}${aggregate.label?' · '+this.esc(aggregate.label):''}</span>
        </div>
      </div>`;
    }

    // 文件行
    body += `<div class="env-file-list">`;
    for (const f of files) {
      const inBatch = !batch || batch.includes(f.filename);
      const isCurrent = groupBusy && curFile === f.filename;
      const isQueued = groupBusy && inBatch && !isCurrent;
      let statusHtml = '', actionHtml = '', rowCls = 'env-file', progressHtml = '';

      if (isCurrent && p.total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round(p.downloaded * 100 / p.total)));
        rowCls += ' env-file-active';
        progressHtml = `<div class="env-file-progress">
            <div class="env-progress-bar"><div style="width:${pct}%"></div></div>
            <div class="env-progress-meta">
              <span class="env-progress-pct">${pct}%</span>
              <span class="env-progress-meta-r">${(p.speed||0).toFixed(1)} MB/s &middot; ${this._humanBytes(p.downloaded||0)}/${this._humanBytes(p.total||0)}</span>
            </div>
          </div>`;
      } else if (isCurrent) {
        rowCls += ' env-file-active';
        const idx = p.file_index != null ? (p.file_index + 1) : '?';
        const tt = p.file_total || '?';
        progressHtml = `<div class="env-file-progress">
            <div class="env-progress-bar env-progress-indeterminate"><div></div></div>
            <div class="env-progress-meta">
              <span class="env-progress-stage">${T('animaModel.connecting','Connecting')} ${idx}/${tt}</span>
            </div>
          </div>`;
      } else if (isQueued) {
        rowCls += ' env-file-queued';
        statusHtml = `<span class="env-badge env-badge-loading">${T('animaModel.pending','Pending')}</span>`;
      } else if (f.exists) {
        statusHtml = `<span class="env-badge env-badge-ok">${T('animaModel.downloaded','Downloaded')}</span>`;
      } else if (!busy && groupTask && phase === 'error' && curFile === f.filename) {
        rowCls += ' env-file-failed';
        statusHtml = `<span class="env-badge env-badge-err">${T('animaModel.failed','Failed')}</span>`;
      } else if (!busy && groupTask && inBatch && phase === 'done') {
        rowCls += ' env-file-failed';
        statusHtml = `<span class="env-badge env-badge-err">${T('animaModel.failed','Failed')}</span>`;
      } else {
        // 未下载是中性状态：灰徽标，不用警告色
        statusHtml = `<span class="env-badge env-badge-muted">${T('animaModel.notDownloaded','Not downloaded')}</span>`;
      }

      if (isCurrent || isQueued) {
        actionHtml = `<button class="btn btn-sm btn-ghost env-model-dl" disabled>${T('animaModel.downloading','Downloading')}</button>`;
      } else if (f.exists) {
        actionHtml = `<button class="btn btn-sm btn-ghost env-model-dl" data-group="${this.escapeAttr(modelGroup)}" data-file="${this.escapeAttr(f.filename)}" ${busy?'disabled':''} title="${T('animaModel.redownload','Redownload')}">${T('animaModel.redownload','Redownload')}</button>`;
      } else {
        actionHtml = `<button class="btn btn-sm btn-secondary env-model-dl" data-group="${this.escapeAttr(modelGroup)}" data-file="${this.escapeAttr(f.filename)}" ${busy?'disabled':''}>${T('animaModel.download','Download')}</button>`;
      }

      const sizeHtml = f.exists ? `<span class="env-file-size">${this._humanBytes((f.size_gb||0)*1073741824)}</span>` : '';
      const destPath = f.dest_path || (destDir + f.filename);
      const originHtml = f.source_page
        ? ` <a href="${this.escapeAttr(f.source_page)}" target="_blank" rel="noopener" class="env-link" title="${T('animaModel.openOriginalPage','Open the original model page')}">${T('animaModel.originalPage','Original page')} &#8599;</a>`
        : '';
      body += `<div class="${rowCls}">
        <div class="env-file-main">
          <a href="${this.escapeAttr(f.source_url || '#')}" target="_blank" rel="noopener" class="env-link env-file-name"><code title="${this.escapeAttr(f.filename)}">${this.esc(f.filename)}</code></a>
          ${sizeHtml}
          <span class="env-file-status">${statusHtml}</span>
          <span class="env-file-action">${actionHtml}</span>
        </div>
        <div class="env-file-sub">${this.esc(f.desc || '')}${originHtml}<span class="env-file-dest">${this.esc(destPath)}</span></div>
        ${progressHtml}
      </div>`;
    }

    if (!files.length) {
      body += `<div class="env-file"><span class="env-badge env-badge-loading">${T('loadingShort','Loading…')}</span></div>`;
    }
    body += `</div>`; // .env-file-list

    // 下载日志（子折叠，覆盖持久化）
    if (this.animaModelLog && groupTask) {
      body += this._renderSubCollapse('animaModelLog', T('animaModel.progressLog','Progress Log'), this._envCardOpen('animaModelLog'), this._renderLog(this.animaModelLog));
    }

    return `<div class="env-mgroup env-row-${state}${open ? ' env-open' : ''}" data-env-row="${slotId}">`
      + head
      + `<div class="env-row-body" data-env-body="${slotId}"><div class="env-row-body-inner">${body}</div></div>`
      + `</div>`;
  },

  // ═══════════════════════════════════════════════════════
  //  Event bindings（按槽位绑定，只有重建的槽位重绑）
  // ═══════════════════════════════════════════════════════
  _bindSlotEvents(host, slot, T) {
    this._bindRowToggle(host);
    this._bindDetailToggles(host);
    this._bindHeadActionEvents(host);
    this._bindSubToggles(host);
    host.querySelectorAll('[data-env-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = window.__anima || this;
        a._envCopyLog(a[btn.dataset.envCopy] || '');
      });
    });
    if (slot === 'overview') this._bindOverviewEvents(host);
    else if (slot === 'fa') this._bindFaEvents(host, T);
    else if (slot === 'xf') this._bindXfEvents(host);
    else if (slot === 'triton') this._bindTritonEvents(host);
    else if (slot === 'animaModel' || slot === 'krea2' || slot === 'trainUse') this._bindModelGroupEvents(host);
  },

  // 行尾"详情"按钮：显式开合行下展开面板（行本身不再可点击）
  _bindDetailToggles(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-detail]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.envDetail;
        const row = host.querySelector('[data-env-row="' + key + '"]');
        if (!row) return;
        const body = row.querySelector('[data-env-body]');
        const open = !row.classList.contains('env-open');
        row.classList.toggle('env-open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        a._envSetCardOpen(key, open);
        if (body) a._animateCollapse(body, !open);
      });
    });
  },

  // 行尾主按钮（安装/重装）：FA 走自动匹配+确认，xf/triton 直接安装
  _bindHeadActionEvents(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.envAction;
        if (act === 'fa') a.faInstall(null);
        else if (act === 'xf') a.xfInstall();
        else if (act === 'triton') a.tritonInstall();
      });
    });
  },

  // 行头点击/键盘展开收起。行内 a/button/input 不触发展开（修 summary 链接误触 bug）。
  // 不重渲染：直接在现有 DOM 上做高度动画 + 类/aria 更新 + 覆盖持久化。
  _bindRowToggle(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-toggle]').forEach(head => {
      const slotId = head.dataset.envToggle;
      const doToggle = () => {
        const row = head.parentElement;
        if (!row) return;
        const body = row.querySelector('[data-env-body]');
        if (!body) return;
        const open = !row.classList.contains('env-open');
        row.classList.toggle('env-open', open);
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        a._envSetCardOpen(slotId, open);
        a._animateCollapse(body, !open);
      };
      head.addEventListener('click', e => {
        if (e.target.closest('a, button, input, select, textarea')) return;
        doToggle();
      });
      head.addEventListener('keydown', e => {
        if (e.target !== head) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doToggle(); }
      });
    });
  },

  // 子折叠（高级选项 / 下载日志）
  _bindSubToggles(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-sub-head]').forEach(head => {
      const key = head.dataset.envSubHead;
      const doToggle = () => {
        const wrap = head.parentElement;
        const body = wrap.querySelector('.env-sub-body');
        const open = !wrap.classList.contains('env-open');
        wrap.classList.toggle('env-open', open);
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (key === 'faAdvanced') a.faAdvancedOpen = open;
        else if (key === 'animaModelLog') a._envSetCardOpen('animaModelLog', open);
        if (body) a._animateCollapse(body, !open);
        if (open && key === 'animaModelLog') {
          const pre = wrap.querySelector('.env-log');
          if (pre) pre.scrollTop = pre.scrollHeight;
        }
      };
      head.addEventListener('click', e => {
        if (e.target.closest('a, button, input')) return;
        doToggle();
      });
      head.addEventListener('keydown', e => {
        if (e.target !== head) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doToggle(); }
      });
    });
  },

  _bindOverviewEvents(host) {
    const a = window.__anima || this;
    host.querySelectorAll('[data-env-anchor]').forEach(chip => {
      chip.addEventListener('click', () => a._envScrollTo(chip.dataset.envAnchor));
    });
    const btn = host.querySelector('[data-env-refresh-all]');
    if (btn) btn.addEventListener('click', () => {
      btn.disabled = true;
      a._envRefreshAll().finally(() => { btn.disabled = false; });
    });
    host.querySelectorAll('[data-env-toggle-all]').forEach(btn2 => {
      btn2.addEventListener('click', () => a._envToggleAll(btn2.dataset.envToggleAll === 'open'));
    });
  },

  // 全部展开/收起：作用于当前 Tab 的行（组件行 + 模型组），子折叠（高级选项/日志）不受影响。
  // 未渲染的槽位通过覆盖持久化（_envSetCardOpen），渲染时就带上目标状态。
  _envToggleAll(open) {
    const page = document.getElementById('environmentPage');
    if (!page) return;
    const tab = this.environmentTab || 'env';
    const panel = page.querySelector('[data-env-tab-panel="' + tab + '"]');
    if (!panel) return;
    panel.querySelectorAll('.env-trow[data-env-row], .env-mgroup[data-env-row]').forEach(row => {
      // 已处于目标状态的行跳过：不重播动画，也不重复写覆盖
      if (row.classList.contains('env-open') === open) return;
      const key = row.dataset.envRow;
      const body = row.querySelector('[data-env-body]');
      row.classList.toggle('env-open', open);
      const head = row.querySelector('[data-env-toggle]');
      if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
      const link = row.querySelector('[data-env-detail="' + key + '"]');
      if (link) link.setAttribute('aria-expanded', open ? 'true' : 'false');
      this._envSetCardOpen(key, open);
      if (body) this._animateCollapse(body, !open);
    });
  },

  // Hero chip 点击：平滑滚动到对应区 + 短暂高亮
  _envScrollTo(anchor) {
    const el = document.getElementById('environmentPage');
    if (!el) return;
    const target = el.querySelector('[data-env-anchor-target="' + anchor + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('env-flash');
    void target.offsetWidth;
    target.classList.add('env-flash');
  },

  _bindModelGroupEvents(host) {
    const a = window.__anima || this;
    host.querySelectorAll('.env-model-dl-all[data-group]').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelDownload(null, btn.dataset.group));
    });
    host.querySelectorAll('.env-model-refresh').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelRefresh());
    });
    host.querySelectorAll('.env-model-dl[data-file]').forEach(btn => {
      btn.addEventListener('click', () => a.animaModelDownload(btn.dataset.file, btn.dataset.group));
    });
  },

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
};
