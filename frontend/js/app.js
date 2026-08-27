/* ================================================================
   app.js — Application Core
   SPA router · Theme engine · Progress bar · Mixin assembly
   ================================================================ */

// ── Alpine App ─────────────────────────────────────────────
document.addEventListener('alpine:init', () => {

  Alpine.data('animaApp', () => {
    const data = {

      // ── State ──────────────────────────────────────────────
      version: '...',
    theme: 'auto',
    resolvedTheme: 'light',
    currentRoute: 'home',
    pageTitle: 'lora-scripts-anima',
    pageSubtitle: '',
    locale: 'en-US',
    i18nReady: true,
    showThemeDropdown: false,
    showLangDropdown: false,
    sidebarCollapsed: false,
    _routeScrollPositions: {},
    routeTransitioning: false,
    _routeTransitionSeq: 0,

    // Progress bar (determinate 0→100%)
    progressPercent: 0,
    _progressInterval: null,
    _progressResetTimer: null,
    _progressFinishTimer: null,
    _progressStartTime: 0,
    _progressSeq: 0,

    // UI Settings
    autoLoadHistory: true,

    // Backend connectivity
    // This becomes true only after WebSocket ready + realtime snapshot.
    backendConnected: false,
    backendDisconnectedAt: null,
    backendDisconnectedDuration: '',
    _healthTimer: null,
    _disconnectedTimer: null,
    // 训练状态（由 /api/health 返回，驱动侧栏连接指示器三态）
      trainingActive: false,
    // 本地系统文件选择器是否可用（无图形环境的 Linux 服务器上不可用，对应按钮直接隐藏）
    localPickerAvailable: true,

      // ── Init ───────────────────────────────────────────────
    async init() {
      // Initialize I18N first — must be ready before any t() call
      I18N.init();
      this.locale = I18N.getLocale();
      // Keep <html lang> in sync with the active locale from the very first
      // paint (index.html defaults to lang="en"): screen readers and browser
      // translation/checking features rely on it.
      document.documentElement.lang = this.locale === 'zh-CN' ? 'zh-CN' : 'en';

      let route = (window.location.hash || '#home').replace('#', '');
      if (!ROUTE_CONFIG[route]) route = 'home';
      this.currentRoute = route;
      const cfg = ROUTE_CONFIG[route];
      this.pageTitle = cfg.titleKey ? (this.t(cfg.titleKey) || cfg.title || route) : (cfg.title || route);
      this.pageSubtitle = cfg.subtitleKey ? (this.t(cfg.subtitleKey) || cfg.subtitle || '') : (cfg.subtitle || '');
      document.title = this.pageTitle + ' | lora-scripts-anima';

      try {
        const r = await fetch('/api/version');
        if (r.ok) {
          const d = await r.json();
          if (d.status === 'success' && d.data && d.data.version) this.version = d.data.version;
          else this.version = 'dev';
        } else {
          this.version = 'dev';
        }
      } catch (e) { this.version = 'dev'; }

      // 本地选择器可用性：请求失败保持默认 true（本地场景），只在后端明确返回 false 时隐藏按钮
      try {
        const pr = await fetch('/api/file_picker_available');
        const pd = await pr.json();
        if (pd.status === 'success' && pd.data) this.localPickerAvailable = !!pd.data.available;
      } catch (e) { /* 保持默认 */ }

      this.theme = localStorage.getItem('anima-theme') || 'auto';
      this.resolveTheme();

      this.loadUISettings();

      window.addEventListener('hashchange', () => this.handleRoute());

      // 窗口尺寸变化时重算监控台 tab 滑动指示条的位置
      window.addEventListener('resize', () => {
        if (this.currentRoute === 'monitor-dashboard' && typeof this._syncMonitorTabIndicator === 'function') {
          requestAnimationFrame(() => this._syncMonitorTabIndicator());
        }
      });

      window.addEventListener('beforeunload', (e) => {
        // Tag editor: 检查是否有未保存的修改
        if (this.currentRoute === 'tagEditor' && typeof this._teFlushAllPendingTextEdits === 'function') {
          this._teFlushAllPendingTextEdits();
        }
        if (this.tagEditorModified && this.currentRoute === 'tagEditor') {
          e.preventDefault();
          e.returnValue = '';
          return;
        }
        // 训练表单: 检查是否有尚未保存到 localStorage 的变更
        if (this._formSaveTimer && this.currentRoute && this.currentRoute.startsWith('train-')) {
          e.preventDefault();
          e.returnValue = '';
        }
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('.sidebar-dropdown')) {
          this.showThemeDropdown = false;
          this.showLangDropdown = false;
        }
      });

      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.theme === 'auto') this.resolveTheme();
      });

      this.buildRouteContent();
      this.$nextTick(() => this._syncSidebarIndicator());

      window.addEventListener('locale-changed', () => {
        this.locale = I18N.getLocale();
        const r = this.currentRoute;
        const cfg = ROUTE_CONFIG[r] || {};
        if (cfg.titleKey) this.pageTitle = this.t(cfg.titleKey) || cfg.title || r;
        else this.pageTitle = cfg.title || r;
        if (cfg.subtitleKey) this.pageSubtitle = this.t(cfg.subtitleKey) || cfg.subtitle || '';
        else this.pageSubtitle = cfg.subtitle || '';
        document.title = this.pageTitle + ' | lora-scripts-anima';
        this.buildRouteContent();
        if (r === 'monitor-dashboard' && typeof this.renderDashboard === 'function') this.renderDashboard();
        this.$nextTick(() => this._syncSidebarIndicator());
        // tagger 模式 tab 文本随语言变化，指示条需重算位置
        if (r === 'tagger' && typeof this._syncTaggerTabIndicator === 'function') {
          requestAnimationFrame(() => this._syncTaggerTabIndicator());
        }
      });

      this.startRealtime();

      this._initPanelResizer();

      window.__anima = this;
    },

    // ── Theme ──────────────────────────────────────────────
    resolveTheme() {
      if (this.theme === 'auto') {
        this.resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } else {
        this.resolvedTheme = this.theme;
      }
      document.documentElement.setAttribute('data-theme', this.resolvedTheme);
    },

    setTheme(t) {
      if (this.theme === t) return;
      this.theme = t;
      this.showThemeDropdown = false;

      const apply = () => {
        this.resolveTheme();
        localStorage.setItem('anima-theme', t);
      };

      if (document.startViewTransition) {
        document.startViewTransition(() => apply());
      } else {
        apply();
      }
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      localStorage.setItem('anima-sidebar-collapsed', this.sidebarCollapsed ? '1' : '0');
    },

    // ── Progress Bar ───────────────────────────────────────
    startProgress() {
      clearInterval(this._progressInterval);
      clearTimeout(this._progressResetTimer);
      clearTimeout(this._progressFinishTimer);
      const progressSeq = ++this._progressSeq;
      this._progressStartTime = Date.now();
      // Start above zero so Alpine can paint the bar before a heavy route mounts.
      this.progressPercent = 8;
      var stages = (window.UI_CONSTANTS && window.UI_CONSTANTS.PROGRESS_STAGES) || [{ duration: 300, max: 30 }, { duration: 1700, max: 65 }, { duration: Infinity, max: 90 }];
      var t1 = stages[0].duration, m1 = stages[0].max;
      var t2 = stages[1].duration, m2 = stages[1].max;
      var maxPct = stages[2].max;

      this._progressInterval = setInterval(() => {
        if (progressSeq !== this._progressSeq) return;
        var elapsed = Date.now() - this._progressStartTime;
        if (elapsed < t1) {
          this.progressPercent = Math.max(8, Math.round((elapsed / t1) * m1));
        } else if (elapsed < t1 + t2) {
          this.progressPercent = Math.round(m1 + ((elapsed - t1) / t2) * (m2 - m1));
        } else {
          this.progressPercent = Math.round(m2 + ((elapsed - t1 - t2) / (elapsed - t1 - t2 + 200)) * (maxPct - m2));
        }
        if (this.progressPercent > maxPct) this.progressPercent = maxPct;
      }, 80);
    },

    finishProgress() {
      clearInterval(this._progressInterval);
      this._progressInterval = null;
      clearTimeout(this._progressFinishTimer);
      const progressSeq = this._progressSeq;
      const elapsed = Date.now() - this._progressStartTime;
      const complete = () => {
        if (progressSeq !== this._progressSeq) return;
        this.progressPercent = 100;
        this._progressResetTimer = setTimeout(() => {
          if (progressSeq === this._progressSeq) this.progressPercent = 0;
        }, 520);
      };
      // Prevent a sub-frame flash while still keeping route feedback crisp.
      this._progressFinishTimer = setTimeout(complete, Math.max(0, 160 - elapsed));
    },

    // ── Routing ─────────────────────────────────────────────
    navigate(route) {
      if (!this._teConfirmNav(route)) return;
      if (!ROUTE_CONFIG[route] || route === this.currentRoute) {
        return;
      }
      // 点击即时反馈：侧栏高亮立即滑向目标项，不等路由提交
      this._syncSidebarIndicator(route);
      this.routeTransitioning = true;
      this.startProgress();
      window.location.hash = route;
    },

    handleRoute() {
      let route = (window.location.hash || '#home').replace('#', '');
      if (!ROUTE_CONFIG[route]) route = 'home';

      const prev = this.currentRoute;
      if (route === prev) {
        return;
      }
      const transitionSeq = ++this._routeTransitionSeq;
      if (!this.routeTransitioning) {
        this.routeTransitioning = true;
        this.startProgress();
      }
      // 浏览器前进/后退等 hash 直改场景：同样立即滑动侧栏高亮
      this._syncSidebarIndicator(route);

      // The training form mounts hundreds of controls. Leave a short paint
      // window so the active nav state, content fade and progress bar become
      // visible before that work starts. A timer also keeps routing reliable
      // in background tabs, where requestAnimationFrame may be paused.
      // 动画开启时延时让旧页淡出与点击反馈先被看到，再提交重量级挂载。
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const mountDelay = reduceMotion ? 16 : 70;
      setTimeout(() => {
        if (transitionSeq !== this._routeTransitionSeq) return;
        this._commitRoute(route, prev, transitionSeq);
      }, mountDelay);
    },

    _commitRoute(route, prev, transitionSeq) {
      const mainContent = document.getElementById('mainContent');
      if (mainContent) this._routeScrollPositions[prev] = mainContent.scrollTop;
      // Cleanup tag editor resources when leaving
      if (prev === 'tagEditor' && typeof this.tagEditorCleanup === 'function') {
        this.tagEditorCleanup();
      }
      if (prev === 'docs' && route !== 'docs' && typeof this.cleanupDocsReader === 'function') {
        this.cleanupDocsReader();
      }
      if (prev && prev.startsWith('train-') && !route.startsWith('train-')) {
        if (typeof this.suspendTrainForm === 'function') this.suspendTrainForm(prev);
        else if (typeof this.stopSectionScroll === 'function') this.stopSectionScroll();
      }
      this.currentRoute = route;

      const cfg = ROUTE_CONFIG[route];
      if (cfg.titleKey) this.pageTitle = this.t(cfg.titleKey) || cfg.title || route;
      else this.pageTitle = cfg.title || route;
      if (cfg.subtitleKey) this.pageSubtitle = this.t(cfg.subtitleKey) || cfg.subtitle || '';
      else this.pageSubtitle = cfg.subtitle || '';
      document.title = this.pageTitle + ' | lora-scripts-anima';

      const progressManagedByRoute = this.buildRouteContent({ routeTransition: true });
      const restoreScrollTop = this._routeScrollPositions[route] || 0;
      this.$nextTick(() => setTimeout(() => {
        if (transitionSeq !== this._routeTransitionSeq || this.currentRoute !== route) return;
        const scroller = document.getElementById('mainContent');
        if (scroller) {
          scroller.scrollTop = restoreScrollTop;
          this._playRouteEnter(scroller);
        }
        this._syncSidebarIndicator();
        this.routeTransitioning = false;
        if (!progressManagedByRoute) this.finishProgress();
      }, 16));
    },

    // 新页面内容自上而下错峰浮现（CSS: route-cascade，非线性缓出）
    _playRouteEnter(mainContent) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      mainContent.classList.remove('route-enter', 'scroll-entering');
      void mainContent.offsetWidth; // 强制 reflow，让连续切换能重启动画
      // scroll-entering：入场动画期间隐藏滚动条 thumb，避免向下位移撑大滚动区导致闪现
      mainContent.classList.add('route-enter', 'scroll-entering');
      clearTimeout(this._routeEnterTimer);
      this._routeEnterTimer = setTimeout(() => mainContent.classList.remove('route-enter', 'scroll-entering'), 900);
    },

    // 侧栏滑动高亮：跟随激活导航项的位置与高度（首次定位不播放动画）。
    // 可传入目标 route 在路由提交前提前滑动（点击即时反馈），否则按当前路由定位。
    _syncSidebarIndicator(route) {
      const nav = document.getElementById('sidebarNav');
      if (!nav) return;
      const indicator = nav.querySelector('.sidebar-nav-indicator');
      if (!indicator) return;
      const r = route || this.currentRoute;
      let active = null;
      if (r) {
        active = nav.querySelector('.sidebar-item[data-route="' + r + '"]')
          || (r.startsWith('train-') ? nav.querySelector('.sidebar-item[data-route="train-*"]') : null);
      }
      if (!active) active = nav.querySelector('.sidebar-item.active');
      if (!active || !active.offsetHeight) {
        // 无激活项（如首页）或布局不可用时隐藏高亮
        nav.classList.remove('indicator-ready');
        return;
      }
      if (!nav.classList.contains('indicator-ready')) {
        nav.classList.add('no-anim');
        indicator.style.height = active.offsetHeight + 'px';
        indicator.style.transform = 'translateY(' + active.offsetTop + 'px)';
        void indicator.offsetWidth; // 强制 reflow，确保无动画落位先生效
        nav.classList.remove('no-anim');
        nav.classList.add('indicator-ready');
        return;
      }
      indicator.style.height = active.offsetHeight + 'px';
      indicator.style.transform = 'translateY(' + active.offsetTop + 'px)';
    },

    showRightPanel() {
      const r = this.currentRoute;
      return !!(r && r.startsWith('train-'));
    },

    // ── Route Content Builder ───────────────────────────────
    buildRouteContent(options) {
      const r = this.currentRoute;
      const routeTransition = !!(options && options.routeTransition);
      let progressManagedByRoute = false;
      if (!r.startsWith('monitor-')) {
        this.stopMonitorRealtime();
        if ((this.selectedRunDir || this.runDetailData) && typeof this.resetRunDetailState === 'function') {
          this.resetRunDetailState();
        } else {
          this.selectedRunDir = null;
          this.runDetailData = null;
        }
      }
      // Stop rendering a tagger task when leaving; the backend task continues.
      if (r !== 'tagger' && this.taggerRunning) {
        this.taggerRunning = false;
        this.taggerTaskId = null;
        if (typeof this._setTaggerRealtimeTask === 'function') this._setTaggerRealtimeTask(null);
      }
      if (r !== 'tagger' && typeof this.stopTaggerWorkspace === 'function') this.stopTaggerWorkspace();
      if (r && r.startsWith('train-')) {
        this.buildTrainForm();
      } else if (r === 'tagger') {
        this.buildTaggerForm();
      } else if (r === 'tagEditor') {
        this.tagEditorLoad();
        progressManagedByRoute = true;
      } else if (r === 'settings') {
        this.loadUISettings();
      } else if (r === 'monitor-dashboard') {
        if (!routeTransition) this.startProgress();
        this.startMonitorRealtime();
        progressManagedByRoute = true;
        // The dashboard hydrates from the shared realtime snapshot.
      } else if (r === 'history') {
        if (!routeTransition) this.startProgress();
        this.loadHistory();
        progressManagedByRoute = true;
      } else if (r === 'environment') {
        if (!routeTransition) this.startProgress();
        this.buildEnvironmentPage();
        progressManagedByRoute = true;
      } else if (r === 'docs') {
        if (!routeTransition) this.startProgress();
        this.loadDocsPage().finally(() => this.finishProgress());
        progressManagedByRoute = true;
      } else if (r === 'tensorboard') {
        this.stopMonitorRealtime();
        this.renderTensorBoardPage();
      }
      return progressManagedByRoute;
    },

    // ── UI Settings ────────────────────────────────────────
    loadUISettings() {
      try {
        const s = JSON.parse(localStorage.getItem('anima-ui-settings')||'{}');
        if (s.autoLoadHistory!==undefined) this.autoLoadHistory = s.autoLoadHistory;
        if (typeof s.weakNetworkMode === 'boolean') {
          this.weakNetworkMode = s.weakNetworkMode;
        } else {
          // No explicit choice stored: enable serialized thumbnail loading
          // only on genuinely slow connections (2g/3g/save-data). Local and
          // LAN users get native parallel thumbnail loading by default.
          this.weakNetworkMode = this._detectSlowConnection();
        }
      } catch(e){}
      this.sidebarCollapsed = localStorage.getItem('anima-sidebar-collapsed') === '1';
    },

    // Network Quality Hints: slow-2g/2g/3g or save-data → weak mode on.
    _detectSlowConnection() {
      try {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn) return false;
        if (conn.saveData) return true;
        const et = String(conn.effectiveType || '');
        return et === 'slow-2g' || et === '2g' || et === '3g';
      } catch (e) {
        return false;
      }
    },

    saveUISettings() {
      localStorage.setItem('anima-ui-settings', JSON.stringify({
        autoLoadHistory: this.autoLoadHistory,
        weakNetworkMode: this.weakNetworkMode,
      }));
      this.resolveTheme();
      this.toast(this.t('common.saved'));
    },

    requestWeakNetworkModeChange(enabled, input) {
      const next = !!enabled;
      if (next === this.weakNetworkMode) return;
      if (next) {
        this.setWeakNetworkMode(true);
        return;
      }
      // This checkbox is intentionally not x-model-bound: keep it visually
      // enabled until the user accepts the built-in confirmation dialog.
      if (input) input.checked = true;
      this.openConfirm(
        this.t('settings.disableSlowConnectionTitle'),
        this.t('settings.disableSlowConnectionMessage'),
        () => this.setWeakNetworkMode(false),
        this.t('settings.disableSlowConnectionConfirm'),
      );
    },

    setWeakNetworkMode(enabled) {
      this.weakNetworkMode = !!enabled;
      if (typeof this._cancelPreviewMediaQueue === 'function') this._cancelPreviewMediaQueue();
      this.saveUISettings();
      if (typeof this.renderDashboard === 'function') this.renderDashboard();
    },

    renderTensorBoardPage() {
      const el = document.getElementById('tensorboardFrame');
      if (!el || el.querySelector('iframe')) return;
      el.innerHTML = `<iframe src="/proxy/tensorboard/" class="iframe-full"
        onload="this.style.opacity='1'" style="opacity:0;transition:opacity 0.5s"></iframe>`;
    },

    onLocaleChange() {
      I18N.setLocale(this.locale);
      this.showLangDropdown = false;
      document.documentElement.lang = this.locale === 'zh-CN' ? 'zh-CN' : 'en';
    },

    // ── Toast ──────────────────────────────────────────────
    toast(message, type) {
      const c = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', type === 'error' ? 'alert' : 'status');
      el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
      if (type) {
        el.classList.add(type);
        var icon;
        if (type === 'error') {
          icon = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/></svg>';
        } else if (type === 'warning') {
          icon = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        } else {
          icon = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16.5 9.5"/></svg>';
        }
        el.innerHTML = icon + '<span></span>';
        el.querySelector('span').textContent = message;
      } else {
        const messageEl = document.createElement('span');
        messageEl.textContent = message;
        el.appendChild(messageEl);
      }
      c.appendChild(el);
      const displayDuration = type === 'error' ? 4800 : type === 'warning' ? 3600 : 2800;
      setTimeout(function() {
        el.classList.add('out');
        setTimeout(function() { if (el.parentNode) el.remove(); }, 140);
      }, displayDuration);
    },

    // ── Backend disconnect duration (realtime.js owns connectivity) ─
    _updateDisconnectedDuration() {
      if (!this.backendDisconnectedAt) {
        this.backendDisconnectedDuration = '';
        return;
      }
      const elapsed = Math.floor((Date.now() - this.backendDisconnectedAt) / 1000);
      if (elapsed < 60) {
        this.backendDisconnectedDuration = this.t('common.disconnectedSeconds').replace('{n}', elapsed);
      } else if (elapsed < 3600) {
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        this.backendDisconnectedDuration = this.t('common.disconnectedMinutes').replace('{n}', m).replace('{s}', s);
      } else {
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        this.backendDisconnectedDuration = this.t('common.disconnectedHours').replace('{n}', h).replace('{s}', m);
      }
    },

    t(key, fallback) {
      void this.locale;
      return window.t ? window.t(key, fallback) : (fallback||key);
    },

    // Home hero "Release" badge: use the real version from /api/version
    // (e.g. "v2.3.6-4-g3dc39b4f" → "v2.3.6"). Falls back to the static text
    // until the version fetch resolves or when the backend is unreachable.
    displayVersion() {
      const v = String(this.version || '');
      if (!v || v === '...' || v === 'dev') return 'v1.3.3';
      const m = v.match(/^v?\d+\.\d+\.\d+/);
      return m ? m[0] : v;
    },

    // ── Right Panel Resizer ─────────────────────────────────
    // 鼠标拖拽调整右侧面板宽度并持久化到 localStorage。
    // 宽度通过 CSS 变量 --panel-w 应用（而非 element inline width），这样：
    //   1. 首帧渲染前由 index.html 的 blocking 脚本设好，无刷新闪现；
    //   2. 桌面窄窗口仍保留主表单的最小可用宽度。
    _PANEL_MIN_W: 300,
    _PANEL_MAX_W: 760,
    _PANEL_MIN_MAIN_W: 520,
    _PANEL_STORAGE_KEY: 'anima-panel-w',

    _applyPanelWidth(px) {
      document.documentElement.style.setProperty('--panel-w', px + 'px');
    },

    _panelMaxWidth() {
      const workspaceWidth = Math.max(window.innerWidth, 1024);
      return Math.max(
        this._PANEL_MIN_W,
        Math.min(this._PANEL_MAX_W, workspaceWidth - 180 - this._PANEL_MIN_MAIN_W)
      );
    },

    _initPanelResizer() {
      const resizer = document.getElementById('panelResizer');
      if (!resizer) return;
      // 保存的宽度已由 index.html 的 blocking 脚本在首帧前应用到 --panel-w，这里无需再设。

      const clamp = (w) => Math.max(this._PANEL_MIN_W, Math.min(this._panelMaxWidth(), w));

      const onMove = (e) => {
        const panel = document.getElementById('rightPanel');
        const panelRight = panel ? panel.getBoundingClientRect().right : window.innerWidth;
        this._applyPanelWidth(clamp(panelRight - e.clientX));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('panel-resizing');
        // 持久化最终宽度（从 CSS 变量读回，避免依赖 element style）
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--panel-w').trim();
        const w = parseInt(raw, 10);
        if (w >= this._PANEL_MIN_W && w <= this._PANEL_MAX_W) {
          localStorage.setItem(this._PANEL_STORAGE_KEY, String(w));
        }
      };

      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        document.body.classList.add('panel-resizing');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // 双击手柄：清除自定义宽度，恢复 CSS 默认 clamp
      resizer.addEventListener('dblclick', () => {
        document.documentElement.style.removeProperty('--panel-w');
        localStorage.removeItem(this._PANEL_STORAGE_KEY);
      });
    },  // _initPanelResizer

  };  // end data object

  // ── Merge mixins preserving getters/setters ──────────────────
  // IMPORTANT: ...spread evaluates getters to static values.
  // Object.defineProperties preserves them as reactive getters.
  const _mixinSources = [
    window.utilsMixin,
    window.realtimeMixin,
    window.monitorCoreMixin,
    window.monitorRenderMixin,
    window.environmentCoreMixin,
    window.environmentRenderMixin,
    window.docsMixin,
    window.trainingCoreMixin,
    window.trainingTomlMixin,
    window.trainingConfigIoMixin,
    window.taggerMixin,
    window.tagEditorMixin,
  ];
  for (const _src of _mixinSources) {
    if (_src) {
      Object.defineProperties(data, Object.getOwnPropertyDescriptors(_src));
    }
  }

  return data;

});  // Alpine.data('animaApp', ...)

});  // alpine:init
