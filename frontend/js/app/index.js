/* ================================================================
   app/index.js — Application Core
   SPA router · Theme engine · Progress bar · Mixin assembly
   ================================================================ */

// Legacy training routes were replaced by the train-type selector. Keep old
// bookmarks working and copy their saved form/profile state before redirecting.
const LEGACY_TRAIN_ROUTE_ALIASES = {
  'train-master': 'train-basic',
  'train-anima': 'train-basic',
};

function migrateLegacyTrainRoute(from, to) {
  const suffixes = ['', 'profiles-', 'profile-sources-v1-'];
  suffixes.forEach((suffix) => {
    const oldKey = 'anima-form-' + suffix + from;
    const newKey = 'anima-form-' + suffix + to;
    try {
      const oldValue = localStorage.getItem(oldKey);
      if (oldValue !== null && localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldValue);
      }
    } catch (e) {
      // localStorage may be unavailable in private/embedded contexts.
    }
  });
}

function normalizeTrainRoute(route) {
  const target = LEGACY_TRAIN_ROUTE_ALIASES[route];
  if (!target) return route;
  migrateLegacyTrainRoute(route, target);
  return target;
}

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
    locale: 'en-US',
    i18nReady: true,
    sidebarCollapsed: false,
    _routeScrollPositions: {},
    routeTransitioning: false,
    _routeTransitionSeq: 0,
    _pendingRoute: '',
    _historyIndex: 0,
    _blockedRoute: null,

    // Progress bar (determinate 0→100%)
    progressPercent: 0,
    _progressInterval: null,
    _progressResetTimer: null,
    _progressFinishTimer: null,
    _progressDelayTimer: null,
    _progressStartTime: 0,
    _progressVisibleAt: 0,
    _progressSeq: 0,

    // UI Settings
    autoLoadHistory: true,
    selectedGpuIndex: 0,

    // Backend connectivity
    // This becomes true only after WebSocket ready + realtime snapshot.
    backendConnected: false,
    backendDisconnectedAt: null,
    backendDisconnectedDuration: '',
    _disconnectedTimer: null,
    // 训练与正则生成状态由全局状态轮询同步。
      trainingActive: false,
    get backendStatusLabel() {
      if (this.realtimeState === 'offline') return this.t('common.backendDisconnected');
      if (this.realtimeState === 'degraded' || this.realtimeState === 'connecting') return this.t('common.backendDelayed');
      if (this.trainingActive) return this.t('common.trainingInProgress');
      if (this.regularizationActive) return this.t('common.regularizationInProgress');
      return this.t('common.backendConnected');
    },
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
      document.documentElement.lang = this.locale;

      let route = (window.location.hash || '#home').replace('#', '').split('?')[0];
      const normalizedRoute = normalizeTrainRoute(route);
      if (normalizedRoute !== route) {
        route = normalizedRoute;
        const state = window.history.state || {};
        window.history.replaceState({ ...state, animaRoute: route }, '', '#' + route);
      }
      if (!ROUTE_CONFIG[route]) route = 'home';
      this.currentRoute = route;
      const historyState = window.history.state || {};
      this._historyIndex = Number.isInteger(historyState.animaIndex) ? historyState.animaIndex : 0;
      if (historyState.animaRoute !== route) {
        window.history.replaceState({ ...historyState, animaRoute: route, animaIndex: this._historyIndex }, '', window.location.href);
      }
      const cfg = ROUTE_CONFIG[route];
      this.pageTitle = cfg.titleKey ? (this.t(cfg.titleKey) || cfg.title || route) : (cfg.title || route);
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

      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.theme === 'auto') this.resolveTheme();
      });

      this.buildRouteContent();

      window.addEventListener('locale-changed', () => {
        this.locale = I18N.getLocale();
        document.documentElement.lang = this.locale;
        const r = this.currentRoute;
        const cfg = ROUTE_CONFIG[r] || {};
        if (cfg.titleKey) this.pageTitle = this.t(cfg.titleKey) || cfg.title || r;
        else this.pageTitle = cfg.title || r;
        document.title = this.pageTitle + ' | lora-scripts-anima';
        this.buildRouteContent();
        if (r === 'monitor-dashboard' && typeof this.renderDashboard === 'function') this.renderDashboard();
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
      clearTimeout(this._progressDelayTimer);
      const progressSeq = ++this._progressSeq;
      this._progressStartTime = Date.now();
      this._progressVisibleAt = 0;
      this.progressPercent = 0;
      var stages = (window.UI_CONSTANTS && window.UI_CONSTANTS.PROGRESS_STAGES) || [{ duration: 300, max: 30 }, { duration: 1700, max: 65 }, { duration: Infinity, max: 90 }];
      var t1 = stages[0].duration, m1 = stages[0].max;
      var t2 = stages[1].duration, m2 = stages[1].max;
      var maxPct = stages[2].max;

      // Fast local navigation needs no flash of simulated progress. Actual
      // training progress is independent of this route/loading indicator.
      this._progressDelayTimer = setTimeout(() => {
        if (progressSeq !== this._progressSeq) return;
        this._progressVisibleAt = Date.now();
        this.progressPercent = 8;
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
      }, 180);
    },

    finishProgress() {
      clearInterval(this._progressInterval);
      this._progressInterval = null;
      clearTimeout(this._progressFinishTimer);
      clearTimeout(this._progressDelayTimer);
      if (this.progressPercent === 0) return;
      const progressSeq = this._progressSeq;
      const complete = () => {
        if (progressSeq !== this._progressSeq) return;
        this.progressPercent = 100;
        this._progressResetTimer = setTimeout(() => {
          if (progressSeq === this._progressSeq) this.progressPercent = 0;
        }, 200);
      };
      // Prevent a sub-frame flash while still keeping route feedback crisp.
      this._progressFinishTimer = setTimeout(complete, Math.max(0, 120 - (Date.now() - this._progressVisibleAt)));
    },

    // ── Routing ─────────────────────────────────────────────
    focusMainContent() {
      const main = document.getElementById('mainContent');
      if (!main) return;
      main.focus({ preventScroll: true });
      main.scrollTop = 0;
    },

    navigate(route, params) {
      const hash = '#' + route + (params ? '?' + new URLSearchParams(params).toString() : '');
      if (!ROUTE_CONFIG[route] || (route === this.currentRoute && window.location.hash === hash)) {
        return;
      }
      const commit = () => {
        const nextIndex = this._historyIndex + 1;
        window.history.pushState({ ...(window.history.state || {}), animaRoute: route, animaIndex: nextIndex }, '', hash);
        this._historyIndex = nextIndex;
        this._scheduleRoute(route);
      };
      if (this._routeNeedsConfirmation()) {
        if (!this.showConfirmModal) this._teConfirmUnsaved(this.t('tagEditor.unsavedConfirm'), commit);
        return;
      }
      commit();
    },

    handleRoute() {
      let route = (window.location.hash || '#home').replace('#', '').split('?')[0];
      const normalizedRoute = normalizeTrainRoute(route);
      if (normalizedRoute !== route) {
        route = normalizedRoute;
        const state = window.history.state || {};
        window.history.replaceState({ ...state, animaRoute: route }, '', '#' + route);
      }
      if (!ROUTE_CONFIG[route]) route = 'home';
      const requestedRun = route === 'monitor-dashboard' ? new URLSearchParams((window.location.hash.split('?')[1] || '')).get('run') : null;
      if (route === this.currentRoute && (route !== 'monitor-dashboard' || (requestedRun || null) === (this.selectedRunDir || null))) {
        if (requestedRun) {
          const tab = new URLSearchParams(window.location.hash.split('?')[1] || '').get('tab') || 'overview';
          if (tab !== this.monitorTab) this.setMonitorTab(tab);
        }
        const currentState = window.history.state || {};
        if (currentState.animaRoute === route && Number.isInteger(currentState.animaIndex)) {
          this._historyIndex = currentState.animaIndex;
        }
        if (this._blockedRoute && !this._blockedRoute.reverted) {
          this._blockedRoute.reverted = true;
          if (this._blockedRoute.accepted) this._retryBlockedRoute();
        }
        if (this._pendingRoute) {
          ++this._routeTransitionSeq;
          this._pendingRoute = '';
          this.routeTransitioning = false;
          this.finishProgress();
        }
        return;
      }
      const state = window.history.state || {};
      const targetIndex = state.animaRoute === route && Number.isInteger(state.animaIndex)
        ? state.animaIndex : null;
      const accepted = this._blockedRoute && this._blockedRoute.accepted && this._blockedRoute.route === route;
      if (!accepted && this._routeNeedsConfirmation()) {
        const delta = targetIndex === null ? -1 : this._historyIndex - targetIndex;
        this._blockedRoute = { route, delta, accepted: false, reverted: false };
        // Traverse back to the committed entry. Replacing the target URL here
        // destroys the browser's Back/Forward entry.
        window.history.go(delta || -1);
        if (!this.showConfirmModal) {
          this._teConfirmUnsaved(this.t('tagEditor.unsavedConfirm'), () => {
            if (!this._blockedRoute) return;
            this._blockedRoute.accepted = true;
            if (this._blockedRoute.reverted) this._retryBlockedRoute();
          });
        }
        return;
      }
      this._blockedRoute = null;
      this._historyIndex = targetIndex === null ? this._historyIndex + 1 : targetIndex;
      if (targetIndex === null) {
        window.history.replaceState({ ...state, animaRoute: route, animaIndex: this._historyIndex }, '', window.location.href);
      }
      this._scheduleRoute(route);
    },

    _routeNeedsConfirmation() {
      return this.currentRoute === 'tagEditor' && this._teHasUnsavedEdits();
    },

    _retryBlockedRoute() {
      const blocked = this._blockedRoute;
      if (blocked) window.history.go(-(blocked.delta || -1));
    },

    _scheduleRoute(route) {
      const prev = this.currentRoute;
      this.cancelHistoryInteractions?.();
      const transitionSeq = ++this._routeTransitionSeq;
      this._pendingRoute = route;
      if (!this.routeTransitioning) {
        this.routeTransitioning = true;
        this.startProgress();
      }
      // The training form mounts hundreds of controls. Leave a short paint
      // window so the progress bar becomes visible before that work starts.
      // A timer also keeps routing reliable
      // in background tabs, where requestAnimationFrame may be paused.
      // 保持旧页可见，仅留一帧绘制点击反馈，再提交重量级挂载。
      const mountDelay = 16;
      setTimeout(() => {
        if (transitionSeq !== this._routeTransitionSeq) return;
        this._pendingRoute = '';
        this._commitRoute(route, prev, transitionSeq);
      }, mountDelay);
    },

    _commitRoute(route, prev, transitionSeq) {
      const mainContent = document.getElementById('mainContent');
      if (mainContent) this._routeScrollPositions[prev] = mainContent.scrollTop;
      if (prev === 'ai-captioning' && route !== prev) this.resetTaggerApiTest();
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
      if (mainContent) this._playRouteEnter(mainContent);
      this.currentRoute = route;

      const cfg = ROUTE_CONFIG[route];
      if (cfg.titleKey) this.pageTitle = this.t(cfg.titleKey) || cfg.title || route;
      else this.pageTitle = cfg.title || route;
      document.title = this.pageTitle + ' | lora-scripts-anima';

      const progressManagedByRoute = this.buildRouteContent({ routeTransition: true });
      const restoreScrollTop = this._routeScrollPositions[route] || 0;
      this.$nextTick(() => setTimeout(() => {
        if (transitionSeq !== this._routeTransitionSeq || this.currentRoute !== route) return;
        const scroller = document.getElementById('mainContent');
        if (scroller) {
          scroller.scrollTop = restoreScrollTop;
        }
        this.routeTransitioning = false;
        if (!progressManagedByRoute) this.finishProgress();
      }, 16));
    },

    // 在新页挂载前启用短淡入，避免先显示一帧再重启动画。
    _playRouteEnter(mainContent) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      mainContent.classList.remove('route-enter', 'scroll-entering');
      void mainContent.offsetWidth; // 强制 reflow，让连续切换能重启动画
      mainContent.classList.add('route-enter');
      clearTimeout(this._routeEnterTimer);
      this._routeEnterTimer = setTimeout(() => mainContent.classList.remove('route-enter'), 180);
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
      if (r !== 'history') this.stopHistoryRefresh?.();
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
      if (!['tagger', 'ai-captioning'].includes(r) && typeof this.stopTaggerWorkspace === 'function') this.stopTaggerWorkspace();
      if (r !== 'regularization' && typeof this.stopRegularizationWorkspace === 'function') this.stopRegularizationWorkspace();
      if (r && r.startsWith('train-')) {
        this.buildTrainForm();
      } else if (['tagger', 'ai-captioning'].includes(r)) {
        this.buildTaggerForm();
      } else if (r === 'regularization') {
        this.buildRegularizationForm();
      } else if (r === 'tagEditor') {
        this.tagEditorLoad();
        progressManagedByRoute = true;
      } else if (r === 'settings') {
        this.loadUISettings();
      } else if (r === 'monitor-dashboard') {
        if (!routeTransition) this.startProgress();
        const query = new URLSearchParams(window.location.hash.split('?')[1] || '');
        const runDir = query.get('run');
        if (runDir) this.viewRunDetail(runDir, true, query.get('tab') || 'overview');
        else if (this.selectedRunDir) this.resetRunDetailState();
        this.startMonitorRealtime();
        progressManagedByRoute = true;
        // The dashboard hydrates from the shared realtime snapshot.
      } else if (r === 'history') {
        if (!routeTransition) this.startProgress();
        this.loadHistory();
        this.startHistoryRefresh();
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
      el.innerHTML = `<iframe src="/tensorboard/" title="TensorBoard" class="iframe-full"
        onload="this.style.opacity='1'" style="opacity:0;transition:opacity 0.5s"></iframe>`;
    },

    onLocaleChange() {
      I18N.setLocale(this.locale);
      this.locale = I18N.getLocale();
      document.documentElement.lang = this.locale;
    },

    // ── Toast ──────────────────────────────────────────────
    toast(message, type, options = {}) {
      return window.AnimaUI.notify(message, type, options, (key, fallback) => this.t(key, fallback));
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
    // (e.g. "v26.1017.13c72-4-g3dc39b4f" → "v26.1017.13c72").
    // Keep loading/unknown states explicit instead of showing an old release.
    displayVersion() {
      const v = String(this.version || '');
      if (!v || v === '...') return '...';
      if (v === 'dev') return 'dev';
      const m = v.match(/^v?\d+\.\d+\.(?:[0-9a-f]{5}|\d+)(?=-|$)/);
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
      document.getElementById('panelResizer')?.setAttribute('aria-valuenow', String(Math.round(px)));
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
      const syncSize = () => {
        const width = document.getElementById('rightPanel')?.getBoundingClientRect().width;
        resizer.setAttribute('aria-valuemax', String(this._panelMaxWidth()));
        if (width > 0) {
          resizer.setAttribute('aria-valuenow', String(Math.round(width)));
        }
      };
      const panel = document.getElementById('rightPanel');
      if (panel && typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(syncSize);
        observer.observe(panel);
      }
      window.addEventListener('resize', syncSize);
      syncSize();
      resizer.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = document.getElementById('rightPanel').getBoundingClientRect().width;
        const width = clamp(event.key === 'Home' ? this._PANEL_MIN_W : event.key === 'End'
          ? this._panelMaxWidth() : current + (event.key === 'ArrowLeft' ? 8 : -8));
        this._applyPanelWidth(width);
        localStorage.setItem(this._PANEL_STORAGE_KEY, String(width));
      });

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

  window.composeAppMixins(data, {
    utils: window.utilsMixin, realtime: window.realtimeMixin,
    monitorCore: window.monitorCoreMixin, monitorRender: window.monitorRenderMixin,
    environmentCore: window.environmentCoreMixin, environmentRender: window.environmentRenderMixin,
    docs: window.docsMixin, trainingCore: window.trainingCoreMixin,
    datasetRepeat: window.datasetRepeatMixin, trainingLrPreview: window.trainingLrPreviewMixin,
    trainingShapePreview: window.trainingShapePreviewMixin, trainingToml: window.trainingTomlMixin,
    trainingConfigIo: window.trainingConfigIoMixin, tagger: window.taggerMixin,
    captionOptions: window.captionOptionsMixin, captionWorkspace: window.captionWorkspaceMixin,
    regularization: window.regularizationMixin, tagEditor: window.tagEditorMixin,
    tagDictionary: window.tagDictionaryMixin,
  });

  return data;

});  // Alpine.data('animaApp', ...)

});  // alpine:init
