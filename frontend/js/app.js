/* ================================================================
   app.js — Application Core
   SPA router · Theme engine · Progress bar · Mixin assembly
   ================================================================ */

// ── Alpine App ─────────────────────────────────────────────
document.addEventListener('alpine:init', () => {

  Alpine.data('animaApp', () => ({

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

    // Progress bar (determinate 0→100%)
    progressPercent: 0,
    _progressTimer: null,
    _progressStartTime: 0,

    // UI Settings
    autoLoadHistory: true,

    // Backend connectivity
    backendConnected: true,
    backendDisconnectedAt: null,
    backendDisconnectedDuration: '',
    _healthTimer: null,
    _disconnectedTimer: null,

    // ── Mixin spread ──────────────────────────────────────
    ...(window.monitorCoreMixin || {}),
    ...(window.monitorRenderMixin || {}),
    ...(window.environmentCoreMixin || {}),
    ...(window.environmentRenderMixin || {}),
    ...(window.trainingCoreMixin || {}),
    ...(window.trainingTomlMixin || {}),
    ...(window.trainingPresetsMixin || {}),
    ...(window.taggerMixin || {}),
    ...(window.tagEditorMixin || {}),

    // ── Init ───────────────────────────────────────────────
    async init() {
      // Initialize I18N first — must be ready before any t() call
      I18N.init();
      this.locale = I18N.getLocale();

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

      this.theme = localStorage.getItem('anima-theme') || 'auto';
      this.resolveTheme();

      this.loadUISettings();

      window.addEventListener('hashchange', () => this.handleRoute());

      window.addEventListener('beforeunload', (e) => {
        if (this.tagEditorModified && this.currentRoute === 'tagEditor') {
          e.preventDefault();
          e.returnValue = '';
        }
      });

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

      if (this.autoLoadHistory) {
        setTimeout(() => this._markAutoLoaded(), 500);
      }

      this._startHealthCheck();

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
      clearInterval(this._progressTimer);
      this._progressStartTime = Date.now();
      this.progressPercent = 0;
      var stages = (window.UI_CONSTANTS && window.UI_CONSTANTS.PROGRESS_STAGES) || [{ duration: 300, max: 30 }, { duration: 1700, max: 65 }, { duration: Infinity, max: 90 }];
      var t1 = stages[0].duration, m1 = stages[0].max;
      var t2 = stages[1].duration, m2 = stages[1].max;
      var maxPct = stages[2].max;

      this._progressTimer = setInterval(() => {
        var elapsed = Date.now() - this._progressStartTime;
        if (elapsed < t1) {
          this.progressPercent = Math.round((elapsed / t1) * m1);
        } else if (elapsed < t1 + t2) {
          this.progressPercent = Math.round(m1 + ((elapsed - t1) / t2) * (m2 - m1));
        } else {
          this.progressPercent = Math.round(m2 + ((elapsed - t1 - t2) / (elapsed - t1 - t2 + 200)) * (maxPct - m2));
        }
        if (this.progressPercent > maxPct) this.progressPercent = maxPct;
      }, 100);
    },

    finishProgress() {
      clearInterval(this._progressTimer);
      this.progressPercent = 100;
      this._progressTimer = setTimeout(() => {
        this.progressPercent = 0;
      }, 900);
    },

    // ── Routing ─────────────────────────────────────────────
    navigate(route) {
      if (!this._teConfirmNav(route)) return;
      window.location.hash = route;
      this.handleRoute();
    },

    handleRoute() {
      let route = (window.location.hash || '#home').replace('#', '');
      if (!ROUTE_CONFIG[route]) route = 'home';

      const prev = this.currentRoute;
      if (route === prev) {
        this.showLoadModal = false;
        return;
      }
      this.currentRoute = route;

      const cfg = ROUTE_CONFIG[route];
      if (cfg.titleKey) this.pageTitle = this.t(cfg.titleKey) || cfg.title || route;
      else this.pageTitle = cfg.title || route;
      if (cfg.subtitleKey) this.pageSubtitle = this.t(cfg.subtitleKey) || cfg.subtitle || '';
      else this.pageSubtitle = cfg.subtitle || '';
      document.title = this.pageTitle + ' | lora-scripts-anima';

      this.buildRouteContent();
      this.showLoadModal = false;
    },

    showRightPanel() {
      const r = this.currentRoute;
      return r && (r.startsWith('train-') || r === 'tagger' || r === 'tools');
    },

    // ── Route Content Builder ───────────────────────────────
    buildRouteContent() {
      const r = this.currentRoute;
      if (!r.startsWith('monitor-')) {
        this.stopMonitorPolling();
        this.selectedRunDir = null;
        this.runDetailData = null;
      }
      // Stop tagger if navigating away
      if (r !== 'tagger' && this.taggerRunning) {
        this.stopTagger();
      }
      if (r && r.startsWith('train-')) {
        this.buildTrainForm();
      } else if (r === 'tagger') {
        this.buildTaggerForm();
      } else if (r === 'tagEditor') {
        this.tagEditorLoad();
      } else if (r === 'settings') {
        this.loadUISettings();
      } else if (r === 'monitor-dashboard') {
        this.startProgress();
        this.startMonitorPolling();
        // renderDashboard() is called by fetchMonitorStatus() when data arrives
      } else if (r === 'monitor-logs') {
        this.startProgress();
        this.startMonitorPolling();
        // renderLogs() is called by fetchMonitorStatus() when data arrives
      } else if (r === 'history') {
        this.startProgress();
        this.loadHistory();
      } else if (r === 'environment') {
        this.startProgress();
        this.buildEnvironmentPage();
      } else if (r === 'presets') {
        this.loadPresets();
      } else if (r === 'tensorboard') {
        this.stopMonitorPolling();
        this.renderTensorBoardPage();
      }
    },

    // ── UI Settings ────────────────────────────────────────
    loadUISettings() {
      try {
        const s = JSON.parse(localStorage.getItem('anima-ui-settings')||'{}');
        if (s.autoLoadHistory!==undefined) this.autoLoadHistory = s.autoLoadHistory;
      } catch(e){}
      this.sidebarCollapsed = localStorage.getItem('anima-sidebar-collapsed') === '1';
    },

    saveUISettings() {
      localStorage.setItem('anima-ui-settings', JSON.stringify({autoLoadHistory:this.autoLoadHistory}));
      this.resolveTheme();
      this.toast(this.t('common.saved'));
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
    },

    // ── Toast ──────────────────────────────────────────────
    toast(message, type) {
      const c = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast';
      if (type) {
        el.classList.add(type);
        const icon = type === 'error'
          ? '<svg class="toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
          : '<svg class="toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
        el.innerHTML = icon + '<span>' + message + '</span>';
      } else {
        el.textContent = message;
      }
      c.appendChild(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
      }, 2800);
    },

    // ── Backend Health Check ──────────────────────────────
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

    async checkBackendHealth() {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const r = await fetch('/api/health', { signal: controller.signal });
        clearTimeout(timeout);
        if (r.ok) {
          if (!this.backendConnected) {
            this.backendConnected = true;
            this.backendDisconnectedAt = null;
            this.backendDisconnectedDuration = '';
            clearInterval(this._disconnectedTimer);
            this._disconnectedTimer = null;
            this.toast(this.t('common.backendReconnectedToast'), 'success');
          }
        } else {
          this._markDisconnected();
        }
      } catch (e) {
        this._markDisconnected();
      }
    },

    _markDisconnected() {
      if (this.backendConnected) {
        this.backendConnected = false;
        this.backendDisconnectedAt = Date.now();
        this._updateDisconnectedDuration();
        this._disconnectedTimer = setInterval(() => this._updateDisconnectedDuration(), 1000);
        this.toast(this.t('common.backendDisconnectedToast'), 'error');
      }
    },

    _startHealthCheck() {
      this.checkBackendHealth();
      this._healthTimer = setInterval(() => this.checkBackendHealth(), 5000);
    },

    t(key, fallback) {
      void this.locale;
      return window.t ? window.t(key, fallback) : (fallback||key);
    },

  }));

});
