/* ================================================================
   net.js — Unified URL/WebSocket/origin/clipboard/download helpers
   Loaded FIRST in frontend/index.html before all other app scripts.
   Safe in browser, subpath reverse proxies, HTTP remote IPs, and
   minimal Node VM test contexts.
   ================================================================ */
(function () {
  'use strict';

  const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

  function animaBasePath() {
    let pathname = '';
    try {
      if (typeof document !== 'undefined' && document && typeof document.baseURI === 'string' && /^https?:/i.test(document.baseURI)) {
        pathname = new URL(document.baseURI).pathname || '';
      }
    } catch (_) {}
    if (!pathname) {
      try {
        if (typeof window !== 'undefined' && window.location && typeof window.location.pathname === 'string') {
          pathname = window.location.pathname;
        }
      } catch (_) {}
    }
    if (!pathname || pathname === '/') return '';
    pathname = pathname.replace(/\/[^/]+\.html$/i, '').replace(/\/+$/, '');
    if (!pathname || pathname === '/') return '';
    return pathname.startsWith('/') ? pathname : '/' + pathname;
  }

  function animaUrl(path) {
    if (path == null || path === '') return '';
    const raw = String(path);
    if (ABSOLUTE_URL_RE.test(raw)) return raw;
    const base = animaBasePath();
    if (!base) return raw;
    if (raw === base || raw.startsWith(base + '/') || raw.startsWith(base + '?') || raw.startsWith(base + '#')) {
      return raw;
    }
    return base + (raw.startsWith('/') ? raw : '/' + raw);
  }

  function animaWsUrl(path) {
    const raw = String(path ?? '');
    if (/^wss?:/i.test(raw)) return raw;
    const loc = typeof window !== 'undefined' && window.location ? window.location : {};
    const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = loc.host || '';
    const normalized = raw.startsWith('/') ? raw : '/' + raw;
    return scheme + '//' + host + animaUrl(normalized);
  }

  function isRemoteOrigin() {
    try {
      const loc = typeof window !== 'undefined' && window.location ? window.location : null;
      if (!loc) return false;
      let hostname = typeof loc.hostname === 'string' ? loc.hostname.trim().toLowerCase() : '';
      if (!hostname && typeof loc.host === 'string' && loc.host.trim()) {
        const host = loc.host.trim().toLowerCase();
        hostname = host.startsWith('[')
          ? host.replace(/]:\d+$/, ']')
          : host.replace(/:\d+$/, '');
      }
      if (!hostname) return false;
      return !LOCAL_HOSTS.has(hostname);
    } catch (_) {
      return false;
    }
  }

  async function copyToClipboard(text) {
    const value = String(text ?? '');
    if (typeof navigator !== 'undefined' && navigator?.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch (err) {
        if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
          throw err;
        }
      }
    }
    if (typeof document === 'undefined' || !document.body || typeof document.createElement !== 'function') {
      throw new Error('Clipboard unavailable');
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    const active = document.activeElement;
    document.body.appendChild(textarea);
    try {
      textarea.focus?.({ preventScroll: true });
      textarea.select?.();
      textarea.setSelectionRange?.(0, value.length);
      if (typeof document.execCommand !== 'function' || !document.execCommand('copy')) {
        throw new Error('Clipboard copy failed');
      }
    } finally {
      textarea.remove?.();
      if (active && active !== textarea && typeof active.focus === 'function' && active.isConnected !== false) {
        try { active.focus({ preventScroll: true }); } catch (_) {}
      }
    }
  }

  function triggerSafeDownload(url, options = {}) {
    const targetUrl = animaUrl(url);
    if (!targetUrl || typeof document === 'undefined' || !document.body) return null;
    const frameId = options.frameId || 'anima-safe-download-frame';
    document.getElementById?.(frameId)?.remove?.();
    const frame = document.createElement('iframe');
    frame.id = frameId;
    frame.hidden = true;
    frame.onload = () => {
      if (typeof options.isCurrent === 'function' && !options.isCurrent()) return;
      let result = {};
      try {
        const doc = frame.contentDocument;
        if (doc?.URL === 'about:blank') return;
        const text = doc?.querySelector?.('pre')?.textContent || doc?.body?.textContent || '';
        if (text.trim()) result = JSON.parse(text);
      } catch (_) {
        // Browser network-error pages or non-JSON responses may be opaque.
      }
      if (typeof options.onError === 'function') options.onError(result);
    };
    frame.src = targetUrl;
    document.body.appendChild(frame);
    return frame;
  }

  window.animaBasePath = animaBasePath;
  window.animaUrl = animaUrl;
  window.animaWsUrl = animaWsUrl;
  window.isRemoteOrigin = isRemoteOrigin;
  window.copyToClipboard = copyToClipboard;
  window.triggerSafeDownload = triggerSafeDownload;
})();
