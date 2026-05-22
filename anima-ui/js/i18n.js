/* ================================================================
   Anima Trainer UI — I18n System v2
   Loads locale data from anima-ui/i18n/{locale}.json at runtime.
   To add a new language: just drop a new JSON file in the i18n/ folder.
   First load is cached in memory; subsequent switches re-use cache.
   ================================================================ */

const I18N = (() => {
  let _locale = 'zh-CN';
  let _messages = null;
  const _cache = {};  // locale → messages cache

  /**
   * Initialize I18N with the given locale (or from localStorage).
   * Must be called (and awaited) once before any t() usage.
   */
  async function init(locale) {
    _locale = locale || localStorage.getItem('anima-locale') || 'zh-CN';
    try {
      _messages = await _load(_locale);
    } catch (e) {
      console.warn('[i18n] Failed to load locale "%s", trying fallback: %s', _locale, e.message);
      try { _messages = await _load('zh-CN'); }
      catch (e2) { console.error('[i18n] Fallback also failed:', e2.message); _messages = null; }
    }
  }

  /**
   * Fetch and cache a locale JSON file from the i18n/ folder.
   */
  async function _load(loc) {
    if (_cache[loc]) return _cache[loc];
    const resp = await fetch(`/anima-ui/i18n/${loc}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${loc}.json`);
    const data = await resp.json();
    _cache[loc] = data;
    return data;
  }

  /**
   * Look up a dotted key path (e.g. "tagger.imageDir") in the current locale.
   * Returns fallback or the key itself if not found.
   */
  function t(key, fallback) {
    if (!_messages) return fallback || key;
    const parts = key.split('.');
    let val = _messages;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') return fallback || key;
      val = val[p];
    }
    return (val !== undefined && val !== null) ? val : (fallback || key);
  }

  /** Return the current locale code, e.g. "zh-CN". */
  function getLocale() { return _locale; }

  /**
   * Switch to a new locale. Persists to localStorage and dispatches
   * a 'locale-changed' event so the Alpine app can re-render.
   */
  async function setLocale(loc) {
    if (loc === _locale) return;
    _locale = loc;
    localStorage.setItem('anima-locale', loc);
    try {
      _messages = await _load(loc);
    } catch (e) {
      console.warn('[i18n] Failed to load locale "%s": %s', loc, e.message);
      // Keep current messages; don't break the UI
    }
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: loc } }));
  }

  return { init, t, getLocale, setLocale };
})();

window.I18N = I18N;
window.t = (key, fallback) => I18N.t(key, fallback);
