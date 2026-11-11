/* ================================================================
   Loads translations asynchronously. The app bootstrap waits for ready
   before loading Alpine; other languages preload in the background.
   To add a new language: drop a JSON file in i18n/ and add its
   code and native name to the LOCALES array below.
   ================================================================ */

const I18N = (() => {
  // ── Register available locales here ──────────────────────
  const LOCALES = [
    { code: 'zh-CN', name: '中文' },
    { code: 'en-US', name: 'English' },
    { code: 'ja-JP', name: '日本語' },
  ];

  let _locale = 'en-US';
  let _messages = null;
  const _cache = {};    // locale → messages (loaded so far)
  const _pending = new Map();
  let _localeRequest = 0;

  function _loadLocale(locale) {
    if (_cache[locale]) return Promise.resolve(_cache[locale]);
    if (_pending.has(locale)) return _pending.get(locale);
    const request = (async () => {
      const response = await fetch('/anima-ui/i18n/' + locale + '.json');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const messages = await response.json();
      _cache[locale] = messages;
      return messages;
    })().finally(() => _pending.delete(locale));
    _pending.set(locale, request);
    return request;
  }

  function _supportedLocale(loc) {
    return LOCALES.some(locale => locale.code === loc) ? loc : null;
  }

  function _activeLocale() {
    return _supportedLocale(localStorage.getItem('anima-locale')) || detectBrowserLocale() || 'en-US';
  }

  /**
   * Detect browser language from navigator.language.
   * Returns a supported locale code, or null if not recognized.
   */
  function detectBrowserLocale() {
    const lang = (navigator.language || '').toLowerCase();
    if (lang.startsWith('zh')) return 'zh-CN';
    if (lang.startsWith('en')) return 'en-US';
    if (lang.startsWith('ja')) return 'ja-JP';
    return null;
  }

  // Priority: explicit locale > saved preference > browser language > English.
  async function init(locale) {
    const requested = _supportedLocale(locale) || _activeLocale();
    let resolved = requested;
    try {
      await _loadLocale(requested);
    } catch (error) {
      console.warn('[i18n] Failed to initialize locale: ' + requested, error);
      resolved = 'en-US';
      if (requested !== resolved) {
        try { await _loadLocale(resolved); }
        catch (fallbackError) { console.warn('[i18n] Failed to load fallback locale', fallbackError); }
      }
    }
    _locale = resolved;
    _messages = _cache[resolved] || null;
    return _locale;
  }

  const ready = init().then(() => {
    LOCALES.filter(locale => locale.code !== _locale).forEach(({ code }) => {
      _loadLocale(code).catch(() => {});
    });
  });

  /**
   * Look up a dotted key path (e.g. "tagger.imageDir").
   * Returns fallback or the key itself if not found.
   */
  function t(key, fallback) {
    if (!_messages) return fallback || key || '';
    if (key == null || typeof key !== 'string') return fallback || key || '';
    const parts = key.split('.');
    let val = _messages;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') return fallback || key;
      val = val[p];
    }
    return (val !== undefined && val !== null) ? val : (fallback || key);
  }

  /** Return the current locale code. */
  function getLocale() { return _locale; }

  async function setLocale(loc) {
    if (!_supportedLocale(loc)) return false;
    // Selecting the current language also cancels an older pending selection.
    const request = ++_localeRequest;
    await ready;
    if (request !== _localeRequest) return false;
    if (loc === _locale && _messages) return true;
    try { await _loadLocale(loc); }
    catch (error) {
      console.warn('[i18n] Failed to load locale: ' + loc, error);
      return false;
    }
    if (request !== _localeRequest) return false;
    _locale = loc;
    localStorage.setItem('anima-locale', loc);
    _messages = _cache[loc] || _cache['en-US'] || null;
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: loc } }));
    return true;
  }

  /**
   * Get list of available locales for building language pickers.
   * Returns [{ code: 'zh-CN', name: '中文' }, ...]
   */
  function getAvailableLocales() {
    return LOCALES.map(locale => ({ ...locale }));
  }

  return { ready, init, t, getLocale, setLocale, getAvailableLocales };
})();

window.I18N = I18N;
window.t = (key, fallback) => I18N.t(key, fallback);
