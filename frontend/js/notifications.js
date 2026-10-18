/* Basic feedback with dismissible errors, copyable details and pausable lifetimes.
   The existing toast(message, type) API remains valid. */
(function () {
  'use strict';

  function createNotifications(container, translate) {
    const records = new Map();
    const text = (key, fallback) => translate('notifications.' + key, fallback);
    const button = (label, className, handler) => {
      const node = document.createElement('button');
      node.type = 'button'; node.className = className; node.textContent = label;
      node.addEventListener('click', handler);
      return node;
    };
    const stop = record => {
      if (record.timer !== null) {
        clearTimeout(record.timer);
        record.remaining = Math.max(0, record.remaining - (Date.now() - record.started));
        record.timer = null;
      }
    };
    const start = record => {
      if (!records.has(record.key) || record.persistent || record.hovered || record.focused || record.timer !== null) return;
      record.started = Date.now();
      record.timer = setTimeout(() => dismiss(record.key), record.remaining);
    };
    function dismiss(key) {
      const record = records.get(key);
      if (!record) return;
      stop(record);
      records.delete(key);
      const hadFocus = record.node.contains(document.activeElement);
      record.node.inert = true;
      record.node.classList.add('out');
      // Leave room for the short exit, including when reduced motion is enabled.
      const remove = () => record.node.remove();
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const duration = parseFloat(getComputedStyle(record.node).getPropertyValue('--duration-toast-exit')) || 150;
      if (reduced) remove(); else setTimeout(remove, duration);
      if (hadFocus) {
        const target = records.values().next().value?.node.querySelector('.toast-close') || record.previousFocus;
        if (target?.isConnected && !target.closest('[inert]') && target.getClientRects().length) {
          target.focus({ preventScroll: true });
        } else document.getElementById('mainContent')?.focus({ preventScroll: true });
      }
    }

    function show(message, type = '', options = {}) {
      message = String(message ?? '');
      const key = options.key ?? Symbol();
      if (records.has(key)) dismiss(key);

      const node = document.createElement('div');
      node.className = 'toast' + (type ? ' ' + type : '');
      const content = document.createElement('div');
      content.className = 'toast-content';
      const messageNode = document.createElement('div');
      messageNode.className = 'toast-message';
      // Announce only the message, keeping action buttons out of the live region.
      messageNode.setAttribute('role', type === 'error' ? 'alert' : 'status');
      messageNode.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
      const detailsText = options.details || (message.length > 220 || message.split('\n').length > 3 ? message : '');
      messageNode.textContent = detailsText === message ? message.split('\n')[0].slice(0, 180) + (message.length > 180 ? '…' : '') : message;
      content.appendChild(messageNode);
      if (detailsText) {
        const details = document.createElement('details');
        details.className = 'toast-details';
        const summary = document.createElement('summary');
        summary.textContent = text('details', 'Details');
        const pre = document.createElement('pre');
        pre.textContent = detailsText;
        details.append(summary, pre); content.appendChild(details);
      }
      const record = {
        key, node, persistent: options.persistent ?? (type === 'error'),
        remaining: Math.max(0, options.duration ?? (type === 'warning' ? 6000 : 2800)),
        started: 0, timer: null, hovered: false, focused: false,
        previousFocus: document.activeElement,
      };
      if (type === 'error' || detailsText) {
        const copy = button(text('copy', 'Copy details'), 'toast-copy', async () => {
          try {
            await navigator.clipboard.writeText(detailsText && detailsText !== message ? message + '\n\n' + detailsText : message);
            copy.textContent = text('copied', 'Copied');
          } catch (_) { copy.textContent = text('copyFailed', 'Copy failed'); }
        });
        content.appendChild(copy);
      }
      const close = button('×', 'toast-close', () => dismiss(key));
      close.setAttribute('aria-label', text('dismiss', 'Dismiss notification'));
      close.title = text('dismiss', 'Dismiss notification');
      const icon = document.createElement('span');
      icon.className = 'toast-symbol'; icon.setAttribute('aria-hidden', 'true');
      icon.textContent = type === 'error' ? '!' : type === 'warning' ? '!' : type === 'success' ? '✓' : 'i';
      node.append(icon, content, close);
      node.addEventListener('mouseenter', () => { record.hovered = true; stop(record); });
      node.addEventListener('mouseleave', () => { record.hovered = false; start(record); });
      node.addEventListener('focusin', () => { record.focused = true; stop(record); });
      node.addEventListener('focusout', event => {
        if (node.contains(event.relatedTarget)) return;
        record.focused = false; start(record);
      });
      records.set(key, record);
      container.appendChild(node);
      start(record);
      return node;
    }
    return { show, dismiss };
  }

  let center = null;
  window.AnimaUI.createNotifications = createNotifications;
  window.AnimaUI.placeNotifications = () => {
    const container = document.getElementById('toastContainer');
    const parent = window.AnimaUI.topDialog() || document.body;
    if (container && container.parentElement !== parent) parent.appendChild(container);
  };
  window.AnimaUI.notify = (message, type, options, translate) => {
    window.AnimaUI.placeNotifications();
    if (!center) center = createNotifications(document.getElementById('toastContainer'), translate);
    return center.show(message, type, options);
  };
  window.AnimaUI.dismissNotification = key => center?.dismiss(key);
})();
