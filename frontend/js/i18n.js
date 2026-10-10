/* ================================================================
   lora-scripts-anima UI — I18n System v3
   Loads the ACTIVE locale JSON synchronously at script execution
   time (before Alpine boots), so t() always has data for the active
   language. Other locales are preloaded in the background, so a
   language switch is instant in practice; if the user switches before
   the preload finishes, setLocale falls back to a one-time blocking
   load. Only the active language blocks startup.
   To add a new language: drop a JSON file in i18n/ and add its
   code to the LOCALES array below.
   ================================================================ */

const I18N = (() => {
  // ── Register available locales here ──────────────────────
  const LOCALES = ['zh-CN', 'en-US', 'ja-JP'];
  const MESSAGES_VERSION = '20261010-ja4';

  let _locale = 'en-US';
  let _messages = null;
  const _cache = {};    // locale → messages (loaded so far)

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

  // ── Asynchronous JSON loader (background preload only) ───
  function _loadJSONAsync(url) {
    return fetch(url)
      .then(function(response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .catch(function() { return null; });
  }

  // ── Bootstrap: block on the ACTIVE locale only, preload the others ──
  // The active locale must be present before Alpine renders (t() is called
  // by every x-text). Other locales are fetched in the background so a
  // later language switch is instant in practice; if the user switches
  // before the preload finishes, setLocale falls back to a blocking load.
  function _bootstrap() {
    const active = _activeLocale();
    try {
      _cache[active] = _loadJSON('/anima-ui/i18n/' + active + '.json?v=' + MESSAGES_VERSION);
    } catch (e) {
      console.warn('[i18n] Failed to preload locale: ' + active, e);
      if (active !== 'en-US') {
        try {
          _cache['en-US'] = _loadJSON('/anima-ui/i18n/en-US.json?v=' + MESSAGES_VERSION);
        } catch (fallbackError) {
          console.warn('[i18n] Failed to load fallback locale', fallbackError);
        }
      }
    }
    LOCALES.filter(loc => loc !== active && !_cache[loc]).forEach(function(other) {
      _loadJSONAsync('/anima-ui/i18n/' + other + '.json?v=' + MESSAGES_VERSION)
        .then(function(messages) {
          if (messages) _cache[other] = messages;
        });
    });
  }

  function _supportedLocale(loc) {
    return LOCALES.includes(loc) ? loc : null;
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

  _bootstrap();

  /**
   * Initialize I18N. Synchronous — active locale already loaded.
   * Priority: explicit arg > localStorage > browser language > 'en-US'
   */
  function init(locale) {
    const requested = _supportedLocale(locale) || _activeLocale();
    if (!_cache[requested]) {
      try {
        _cache[requested] = _loadJSON('/anima-ui/i18n/' + requested + '.json?v=' + MESSAGES_VERSION);
      } catch (e) {
        console.warn('[i18n] Failed to initialize locale: ' + requested, e);
      }
    }
    _locale = _cache[requested] ? requested : 'en-US';
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
   * Switch locale instantly. The target is normally already preloaded; if
   * not (very early switch before the background preload finishes), load it
   * synchronously so the switch is still correct and complete.
   */
  function setLocale(loc) {
    if (!_supportedLocale(loc)) return;
    if (loc === _locale) return;
    if (!_cache[loc]) {
      try {
        _cache[loc] = _loadJSON('/anima-ui/i18n/' + loc + '.json?v=' + MESSAGES_VERSION);
      } catch (e) {
        console.warn('[i18n] Failed to load locale: ' + loc, e);
        return;
      }
    }
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
    const names = { 'zh-CN': '中文', 'en-US': 'English', 'ja-JP': '日本語' };
    return LOCALES.map(l => ({ code: l, name: names[l] || l }));
  }

  return { init, t, getLocale, setLocale, getAvailableLocales };
})();

// ── Activate immediately so _messages is ready before Alpine renders ─
I18N.init();

window.I18N = I18N;
window.t = (key, fallback) => I18N.t(key, fallback);
