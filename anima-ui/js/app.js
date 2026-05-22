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
    locale: 'zh-CN',
    i18nReady: true,
    showThemeDropdown: false,
    showLangDropdown: false,
    showMainScroll: false,

    // Progress bar (determinate 0→100%)
    progressPercent: 0,
    _progressTimer: null,
    _progressStartTime: 0,

    // UI Settings
    autoLoadHistory: true,

    // ── Mixin spread ──────────────────────────────────────
    ...(window.monitorMixin || {}),
    ...(window.environmentMixin || {}),
    ...(window.trainingMixin || {}),
    ...(window.taggerMixin || {}),
    ...(window.tagEditorMixin || {}),

    // ── Init ───────────────────────────────────────────────
    async init() {
      let route = (window.location.hash || '#home').replace('#', '');
      if (!ROUTE_CONFIG[route]) route = 'home';
      this.currentRoute = route;
      const cfg = ROUTE_CONFIG[route];
      this.pageTitle = cfg.titleKey ? (this.t(cfg.titleKey) || cfg.title || route) : (cfg.title || route);
      this.pageSubtitle = cfg.subtitleKey ? (this.t(cfg.subtitleKey) || cfg.subtitle || '') : (cfg.subtitle || '');
      document.title = this.pageTitle + ' | lora-scripts-anima';

      try {
        const r = await fetch('/api/version');
        const d = await r.json();
        if (d.status === 'success') this.version = d.data.version;
        else this.version = 'dev';
      } catch (e) { this.version = 'dev'; }

      this.theme = localStorage.getItem('anima-theme') || 'auto';
      this.resolveTheme();

      I18N.init();
      this.locale = I18N.getLocale();

      this.loadUISettings();

      window.addEventListener('hashchange', () => this.handleRoute());

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
        setTimeout(() => this.autoLoadLastParams(), 500);
      }

      document.title = this.pageTitle + ' | lora-scripts-anima';

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

    toggleTheme() {
      this.setTheme(this.resolvedTheme === 'dark' ? 'light' : 'dark');
    },

    themeLabel() {
      if (this.resolvedTheme === 'dark') return this.t('common.themeLight');
      return this.t('common.themeDark');
    },

    // ── Scroll ─────────────────────────────────────────────
    onContentScroll() {
      this.showMainScroll = true;
      clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(() => { this.showMainScroll = false; }, 1000);
    },

    // ── Progress Bar ───────────────────────────────────────
    startProgress() {
      clearInterval(this._progressTimer);
      this._progressStartTime = Date.now();
      this.progressPercent = 0;

      this._progressTimer = setInterval(() => {
        const elapsed = Date.now() - this._progressStartTime;
        if (elapsed < 300) {
          this.progressPercent = Math.round((elapsed / 300) * 30);
        } else if (elapsed < 2000) {
          this.progressPercent = Math.round(30 + ((elapsed - 300) / 1700) * 35);
        } else {
          this.progressPercent = Math.round(65 + ((elapsed - 2000) / (elapsed - 1800)) * 25);
        }
        if (this.progressPercent > 90) this.progressPercent = 90;
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
      return r && (r.startsWith('train-') || r === 'tools');
    },

    // ── Route Content Builder ───────────────────────────────
    buildRouteContent() {
      const r = this.currentRoute;
      if (!r.startsWith('monitor-')) this.stopMonitorPolling();
      if (r && r.startsWith('train-')) {
        this.buildTrainForm();
      } else if (r === 'tagger') {
        this.buildTaggerForm();
      } else if (r === 'tagEditor') {
        this.startProgress();
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
      }
    },

    // ── UI Settings ────────────────────────────────────────
    loadUISettings() {
      try {
        const s = JSON.parse(localStorage.getItem('anima-ui-settings')||'{}');
        if (s.autoLoadHistory!==undefined) this.autoLoadHistory = s.autoLoadHistory;
        this.refreshSavedConfigs();
      } catch(e){}
    },

    saveUISettings() {
      localStorage.setItem('anima-ui-settings', JSON.stringify({theme:this.theme,autoLoadHistory:this.autoLoadHistory}));
      this.resolveTheme();
      this.toast(this.t('common.saved'));
    },

    onLocaleChange() {
      I18N.setLocale(this.locale);
      this.showLangDropdown = false;
    },

    // ── Toast ──────────────────────────────────────────────
    toast(message) {
      const c = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = message;
      c.appendChild(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
      }, 2400);
    },

    t(key, fallback) {
      void this.locale;
      return window.t ? window.t(key, fallback) : (fallback||key);
    },

  }));

});
