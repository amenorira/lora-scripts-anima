/* ================================================================
   Anima Trainer UI — I18n System
   Simple client-side localization with JSON locale files
   ================================================================ */

const I18N = (() => {
  let _locale = 'zh-CN';
  let _messages = {};
  let _loaded = false;

  async function init(locale) {
    _locale = locale || localStorage.getItem('anima-locale') || 'zh-CN';
    try {
      const resp = await fetch(`/anima-ui/i18n/${_locale}.json`);
      if (!resp.ok) throw new Error('Failed to load locale');
      _messages = await resp.json();
      _loaded = true;
    } catch (e) {
      console.warn('I18N: Failed to load locale, falling back to keys');
      _messages = {};
      _loaded = false;
    }
  }

  function t(key, fallback) {
    if (!_loaded || !_messages) return fallback || key;
    const parts = key.split('.');
    let val = _messages;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') return fallback || key;
      val = val[p];
    }
    return val !== undefined ? val : (fallback || key);
  }

  function getLocale() { return _locale; }

  function setLocale(loc) {
    _locale = loc;
    localStorage.setItem('anima-locale', loc);
    // Reload messages
    init(loc).then(() => {
      // Dispatch event so Alpine can re-render
      window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: loc } }));
    });
  }

  return { init, t, getLocale, setLocale };
})();

// Make available globally for Alpine
window.I18N = I18N;
window.t = (key, fallback) => I18N.t(key, fallback);
