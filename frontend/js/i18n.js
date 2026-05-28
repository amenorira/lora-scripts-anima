/* ================================================================
   lora-scripts-anima UI — I18n System v3
   Loads ALL locale JSON files synchronously at script execution
   time (before Alpine boots), so t() always has data available.
   To add a new language: drop a JSON file in i18n/ and add its
   code to the LOCALES array below.
   Memory: ~10 KB per locale. For 2 locales = ~20 KB. Negligible.
   ================================================================ */

const I18N = (() => {
  // ── Register available locales here ──────────────────────
  const LOCALES = ['zh-CN', 'en-US'];

  let _locale = 'en-US';
  let _messages = null;
  const _cache = {};  // locale → messages (all preloaded)

  // ── Synchronous JSON loader (blocks until data is ready) ─
  function _loadJSON(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);  // false = synchronous
    try {
      xhr.send();
    } catch (e) {
      throw new Error('Network error loading ' + url + ': ' + e.message);
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error('HTTP ' + xhr.status + ' loading ' + url);
    }
    try {
      return JSON.parse(xhr.responseText);
    } catch (e) {
      throw new Error('Invalid JSON in ' + url + ': ' + e.message);
    }
  }

  // ── Preload ALL locales synchronously ────────────────────
  LOCALES.forEach(function(loc) {
    try {
      _cache[loc] = _loadJSON('/anima-ui/i18n/' + loc + '.json');
    } catch (e) {
      console.warn('[i18n] Failed to preload locale: ' + loc, e);
    }
  });

  /**
   * Detect browser language from navigator.language.
   * Returns a supported locale code, or null if not recognized.
   */
  function detectBrowserLocale() {
    const lang = (navigator.language || '').toLowerCase();
    if (lang.startsWith('zh')) return 'zh-CN';
    if (lang.startsWith('en')) return 'en-US';
    return null;
  }

  /**
   * Initialize I18N. Synchronous — data already loaded, no await needed.
   * Priority: explicit arg > localStorage > browser language > 'en-US'
   */
  function init(locale) {
    _locale = locale || localStorage.getItem('anima-locale') || detectBrowserLocale() || 'en-US';
    _messages = _cache[_locale] || _cache['en-US'] || null;
  }

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

  /**
   * Switch locale instantly (all data preloaded). Synchronous.
   */
  function setLocale(loc) {
    if (loc === _locale) return;
    _locale = loc;
    localStorage.setItem('anima-locale', loc);
    _messages = _cache[loc] || _cache['en-US'] || null;
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: loc } }));
  }

  /**
   * Get list of available locales for building language pickers.
   * Returns [{ code: 'zh-CN', name: '中文' }, ...]
   */
  function getAvailableLocales() {
    const names = { 'zh-CN': '中文', 'en-US': 'English' };
    return LOCALES.filter(l => _cache[l]).map(l => ({ code: l, name: names[l] || l }));
  }

  return { init, t, getLocale, setLocale, getAvailableLocales };
})();

// ── Activate immediately so _messages is ready before Alpine renders ─
I18N.init();

window.I18N = I18N;
window.t = (key, fallback) => I18N.t(key, fallback);
