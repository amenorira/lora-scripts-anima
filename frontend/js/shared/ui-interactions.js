/* Shared popup interaction. Native dialogs own modality and focus containment;
   Alpine owns application state. Menus stay local to avoid rebuilding forms. */
(function () {
  'use strict';
  const dialogs = [];
  const popups = new Map();
  const dialogOrigins = new WeakMap();
  const dialogSources = new WeakMap();
  const pendingDialogOrigins = new WeakMap();
  const dialogMotions = new WeakMap();
  const dialogFlights = new WeakMap();
  const hiddenDialogOrigins = new WeakMap();
  const anchorSelector = '[data-dialog-anchor]';
  const mediaTargetSelector = '[data-dialog-anchor="target"]';

  function syncDialogScrims() {
    // Let the first dialog own the page scrim so nested dialogs share it.
    dialogs.forEach((dialog, index) => {
      if (index) dialog.setAttribute('data-dialog-nested', '');
      else dialog.removeAttribute('data-dialog-nested');
    });
  }

  function setHiddenDialogOrigin(element, anchor) {
    const previous = hiddenDialogOrigins.get(element);
    if (previous === anchor) return;
    previous?.classList.remove('dialog-morph-origin');
    if (anchor) {
      anchor.classList.add('dialog-morph-origin');
      hiddenDialogOrigins.set(element, anchor);
    } else hiddenDialogOrigins.delete(element);
  }

  // data-dialog-opens points to the dialog ID. A data-dialog-anchor in the
  // opener matches data-dialog-anchor="target" in the detail dialog.
  function setDialogOrigin(element, origin) {
    if (!element || !origin) return;
    // Preserve the explicit opener because the underlying dialog may become
    // inert and lose focus before the next Alpine effect runs.
    const morph = element.classList?.contains('modal-overlay--morph');
    const source = morph ? measureOrigin(origin) : null;
    if (element.open) {
      dialogOrigins.set(element, origin);
      if (morph) {
        dialogSources.set(element, source);
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        if (element.querySelector(mediaTargetSelector)) {
          setHiddenDialogOrigin(element, reduced ? null : source?.anchor);
        }
      }
    } else pendingDialogOrigins.set(element, { opener: origin, source });
  }

  function resolveDialogOpener(element) {
    const opener = dialogOrigins.get(element);
    if (!opener || opener.isConnected) return opener;
    const byId = opener.id && document.getElementById(opener.id);
    if (byId) return byId;
    const dialogId = opener.getAttribute('data-dialog-opens');
    const action = opener.getAttribute('@click');
    if (!dialogId || !action) return opener;
    const matches = [...document.querySelectorAll('[data-dialog-opens]')].filter(node =>
      node.getAttribute('data-dialog-opens') === dialogId && node.getAttribute('@click') === action && node.getClientRects().length);
    return matches.length === 1 ? matches[0] : opener;
  }

  function parseDurationMs(style, name, fallback) {
    const raw = style.getPropertyValue(name).trim();
    const value = parseFloat(raw);
    if (!Number.isFinite(value)) return fallback;
    if (raw.endsWith('ms')) return value;
    if (raw.endsWith('s')) return value * 1000;
    return value;
  }

  function measureOrigin(opener) {
    const anchor = opener?.querySelector?.(anchorSelector) || opener;
    if (!anchor?.isConnected || !anchor.getClientRects?.().length) return null;
    const rect = anchor.getBoundingClientRect();
    const style = getComputedStyle(anchor);
    if (!rect.width || !rect.height || (style.visibility === 'hidden' && !anchor.classList?.contains('dialog-morph-origin'))) return null;
    const isButton = anchor === opener;
    const transparent = 'rgba(0, 0, 0, 0)';
    let backgroundColor = isButton ? style.backgroundColor : '';
    const visible = {
      top: Math.max(rect.top, 0), right: Math.min(rect.right, window.innerWidth),
      bottom: Math.min(rect.bottom, window.innerHeight), left: Math.max(rect.left, 0),
    };
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.body && (!isButton || backgroundColor !== transparent)) break;
      const parentStyle = getComputedStyle(parent);
      if (isButton && backgroundColor === transparent) backgroundColor = parentStyle.backgroundColor;
      if (parent === document.body) break;
      const { overflowX, overflowY } = parentStyle;
      if (overflowX === 'visible' && overflowY === 'visible') continue;
      const bounds = parent.getBoundingClientRect();
      const left = bounds.left + parent.clientLeft, top = bounds.top + parent.clientTop;
      if (overflowX !== 'visible') {
        visible.left = Math.max(visible.left, left);
        visible.right = Math.min(visible.right, left + parent.clientWidth);
      }
      if (overflowY !== 'visible') {
        visible.top = Math.max(visible.top, top);
        visible.bottom = Math.min(visible.bottom, top + parent.clientHeight);
      }
    }
    if (visible.right <= visible.left || visible.bottom <= visible.top) return null;
    let paint = null;
    if (isButton) {
      paint = {
        backgroundColor, borderRadius: style.borderRadius,
        borderTopColor: style.borderTopColor, borderTopWidth: style.borderTopWidth,
      };
      for (const name of ['color', 'font', 'letterSpacing', 'padding', 'display', 'gap', 'alignItems', 'justifyContent']) {
        paint[name] = style[name];
      }
    }
    return { anchor, rect, visible, paint };
  }

  function animateButtonSurface(element, { bounds, source, panelRect, panel, animate, reuse, flight }) {
    const surface = document.createElement('div');
    surface.className = 'dialog-morph-fill';
    surface.setAttribute('aria-hidden', 'true');
    surface.style.borderWidth = panel.borderTopWidth;
    element.append(surface);
    flight.surface = surface;
    reuse(surface, 'surface');
    const diffBorderWidth = source.paint.borderTopWidth !== panel.borderTopWidth;
    const shape = (rect, paint) => {
      const inset = [rect.top - bounds.top, bounds.right - rect.right,
        bounds.bottom - rect.bottom, rect.left - bounds.left].map(value => `${value}px`).join(' ');
      const { borderRadius, backgroundColor, borderTopColor, borderTopWidth } = paint;
      const surfaceFrame = { inset, borderRadius, backgroundColor, borderColor: borderTopColor };
      if (diffBorderWidth) surfaceFrame.borderWidth = borderTopWidth;
      return {
        clip: { clipPath: `inset(${inset} round ${borderRadius})` },
        surface: surfaceFrame,
      };
    };
    const start = shape(source.visible, source.paint);
    const end = shape(panelRect, panel);
    animate(element, start.clip, end.clip);
    animate(surface, start.surface, end.surface);
  }

  function buttonFlight(element, { source, panel, bounds, dest, opening, animate, reuse, previous, options, animations, flight }) {
    const { anchor, rect, paint, visible } = source;
    const copy = anchor.cloneNode(true);
    for (const node of [copy, ...(copy.querySelectorAll?.('[id]') || [])]) node.removeAttribute('id');
    copy.removeAttribute('data-dialog-opens');
    copy.setAttribute('x-ignore', '');
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    copy.classList.toggle('dialog-morph-origin', false);
    copy.classList.add('dialog-morph-button');
    Object.assign(copy.style, paint, {
      left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`, transform: 'none',
    });
    element.append(copy);
    flight.copy = copy;
    reuse(copy, 'copy');
    const dx = (visible.left + visible.right - dest.left - dest.right) / 2;
    const dy = (visible.top + visible.bottom - dest.top - dest.bottom) / 2;
    const btnScale = Math.max((visible.right - visible.left) / dest.width, (visible.bottom - visible.top) / dest.height);
    const startScale = Math.min(1, Math.max(0.22, btnScale));
    animate(panel, { transform: `translate(${dx}px, ${dy}px) scale(${startScale})` },
      { transform: 'translate(0px, 0px) scale(1)' });
    const copyStart = previous.get(copy);
    const copyOpacity = opening
      ? [{ opacity: copyStart?.opacity ?? 1 }, { opacity: 0, offset: 0.18 }, { opacity: 0 }]
      : [{ opacity: copyStart?.opacity ?? 0 }, { opacity: copyStart?.opacity ?? 0, offset: 0.72 }, { opacity: 1 }];
    animations.push(copy.animate(copyOpacity, { ...options, easing: 'linear' }));
    const panelStart = previous.get(panel);
    const panelOpacity = opening
      ? (panelStart
        ? [{ opacity: panelStart.opacity, easing: 'ease-out' }, { opacity: 1, offset: 0.56 }, { opacity: 1 }]
        : [{ opacity: 0 }, { opacity: 0, offset: 0.08, easing: 'ease-out' }, { opacity: 1, offset: 0.56 }, { opacity: 1 }])
      : [{ opacity: panelStart?.opacity ?? 1 }, { opacity: panelStart?.opacity ?? 1, offset: 0.04, easing: 'ease-in-out' }, { opacity: 0, offset: 0.38 }, { opacity: 0 }];
    animations.push(panel.animate(panelOpacity, { ...options, easing: 'linear' }));
    element.setAttribute('data-dialog-button-flight', '');
  }

  function stopDialogMotion(element) {
    for (const animation of dialogMotions.get(element) || []) {
      animation.finished?.catch(() => {});
      animation.cancel();
    }
    dialogMotions.delete(element);
    const flight = dialogFlights.get(element);
    flight?.copy?.remove();
    flight?.surface?.remove();
    dialogFlights.delete(element);
    element.removeAttribute('data-dialog-button-flight');
  }

  function playDialogMotion(element, opening, capturedSource) {
    const oldFlight = dialogFlights.get(element);
    const previous = new Map();
    for (const animation of dialogMotions.get(element) || []) {
      const node = animation.effect?.target;
      if (!node || previous.has(node)) continue;
      const computed = getComputedStyle(node);
      const props = node === oldFlight?.surface
        ? ['inset', 'borderRadius', 'backgroundColor', 'borderColor', 'borderWidth']
        : node === element
          ? ['clipPath']
          : ['transform', 'opacity'];
      previous.set(node, Object.fromEntries(props.map(name => [name, computed[name]])));
    }
    stopDialogMotion(element);
    const modal = element.querySelector('.modal');
    if (!modal?.animate) return [];
    const media = modal.querySelector(mediaTargetSelector);
    const opener = resolveDialogOpener(element);
    if (opener) dialogOrigins.set(element, opener);
    const saved = dialogSources.get(element);
    const source = capturedSource === undefined
      ? measureOrigin(opener) || (saved?.visible.right <= window.innerWidth && saved.visible.bottom <= window.innerHeight ? saved : null)
      : capturedSource;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return [];
    const style = getComputedStyle(element);
    const duration = parseDurationMs(style, opening ? '--duration-dialog-enter' : '--duration-dialog-exit', opening ? 280 : 240);
    if (duration <= 0) return [];
    const easing = style.getPropertyValue('--ease-disclosure').trim() || 'ease-out';
    const options = { duration, easing, fill: 'both' };
    const animations = [];
    const animate = (node, hidden, shown) => {
      const start = previous.get(node);
      const [from, to] = opening ? [hidden, shown] : [shown, hidden];
      const first = start && Object.fromEntries(
        Object.keys(from).map(name => [name, (start[name] ?? '') === '' ? from[name] : start[name]])
      );
      animations.push(node.animate([first || from, to], options));
    };
    dialogMotions.set(element, animations);
    try {
      const dest = media ? media.getBoundingClientRect() : null;
      const panelRect = !media && source?.paint ? modal.getBoundingClientRect() : null;
      if (media && source && source.anchor !== opener && dest.width && dest.height) {
        const { rect } = source;
        const dx = rect.left - dest.left;
        const dy = rect.top - dest.top;
        animate(media,
          { transform: `translate(${dx}px, ${dy}px) scale(${rect.width / dest.width}, ${rect.height / dest.height})` },
          { transform: 'translate(0px, 0px) scale(1, 1)' });
        for (const part of modal.querySelectorAll('[data-dialog-chrome]')) {
          const start = previous.get(part);
          const frames = opening
            ? (start
              ? [{ opacity: start.opacity, easing: 'ease-out' }, { opacity: 1, offset: 0.72 }, { opacity: 1 }]
              : [{ opacity: 0 }, { opacity: 0, offset: 0.12, easing: 'ease-out' }, { opacity: 1, offset: 0.72 }, { opacity: 1 }])
            : [{ opacity: start?.opacity ?? 1, easing: 'ease-out' }, { opacity: 0, offset: 0.42 }, { opacity: 0 }];
          animations.push(part.animate(frames, { ...options, easing: 'linear' }));
        }
        const heroSurface = modal.querySelector('.dialog-morph-surface');
        if (heroSurface) animate(heroSurface, { transform: 'scale(0.97)' }, { transform: 'scale(1)' });
        setHiddenDialogOrigin(element, source.anchor);
      } else if (panelRect?.width && panelRect?.height) {
        const bounds = element.getBoundingClientRect();
        const modalStyle = getComputedStyle(modal);
        const panel = {
          borderRadius: modalStyle.borderRadius,
          borderTopWidth: modalStyle.borderTopWidth,
          borderTopColor: modalStyle.borderTopColor,
          backgroundColor: modalStyle.backgroundColor,
        };
        const reuse = (node, key) => {
          const prev = oldFlight?.[key] && previous.get(oldFlight[key]);
          if (prev) previous.set(node, prev);
        };
        const flight = {};
        dialogFlights.set(element, flight);
        animateButtonSurface(element, { bounds, source, panelRect, panel, animate, reuse, flight });
        buttonFlight(element, {
          source, panel: modal, bounds, dest: panelRect, opening, animate, reuse, previous, options, animations, flight,
        });
        setHiddenDialogOrigin(element, source.anchor);
      } else {
        setHiddenDialogOrigin(element);
        animate(modal,
          { transform: `translate(0px, 0px) scale(${opening ? 0.95 : 0.97})`, opacity: 0 },
          { transform: 'translate(0px, 0px) scale(1)', opacity: 1 });
      }
      return animations;
    } catch (_) {
      stopDialogMotion(element);
      return [];
    }
  }

  // The sample viewer uses the normal dialog entrance. Its exit is delayed
  // until this small fade completes, so the native dialog and image remain
  // visible throughout the animation even without discrete overlay support.
  function playPreviewDialogExit(element) {
    stopDialogMotion(element);
    const modal = element.querySelector('.modal');
    if (!modal?.animate || !element.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return [];
    const animations = [];
    try {
      const overlayStyle = getComputedStyle(element), modalStyle = getComputedStyle(modal);
      const duration = parseDurationMs(overlayStyle, '--duration-dialog-exit', 150);
      if (duration <= 0) return [];
      const options = { duration, easing: overlayStyle.getPropertyValue('--ease-out').trim() || 'ease-out', fill: 'both' };
      animations.push(element.animate([{ opacity: overlayStyle.opacity }, { opacity: 0 }], options));
      animations.push(modal.animate([{ transform: modalStyle.transform }, { transform: 'translateY(4px)' }], options));
      dialogMotions.set(element, animations);
      return animations;
    } catch (_) {
      animations.forEach(animation => { animation.finished?.catch(() => {}); animation.cancel(); });
      return [];
    }
  }

  function dismissPopups(root) {
    for (const [element, close] of Array.from(popups)) {
      if (!root || root.contains(element)) { popups.delete(element); close(); }
    }
  }

  function settleDialog(anchor) {
    const modal = anchor?.closest('.modal');
    const dialog = modal?.closest('dialog[open]');
    if (!dialog || dialog.hasAttribute('data-dialog-closing')) return;
    // A transforming dialog temporarily becomes the containing block of fixed
    // menus. Finish its entrance and clear fill transforms synchronously.
    const active = dialogMotions.get(dialog);
    for (const animation of active || modal.getAnimations?.() || []) {
      if (animation.playState === 'running') animation.finish();
    }
    if (active) stopDialogMotion(dialog);
  }

  function bindDialog(element, nextTick, scheduleOpen = nextTick) {
    const morph = element.classList.contains('modal-overlay--morph');
    const preview = element.classList.contains('preview-lightbox');
    let requested = false;
    let sequence = 0;
    let previousFocus = null;
    let backdropPress = false;
    const cancel = event => {
      event.preventDefault();
      if (requested) element.dispatchEvent(new CustomEvent('dialog-close'));
    };
    const pointerDown = event => { backdropPress = event.target === element; };
    const click = event => {
      // Dragging/selecting from inside to outside must not dismiss the dialog.
      if (event.target === element && !backdropPress) event.stopImmediatePropagation();
    };
    const keydown = event => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        // Child popups consume their first Escape. Handle the next one here,
        // including while the child's exit animation is still running.
        event.preventDefault();
        event.stopPropagation();
        if (requested) element.dispatchEvent(new CustomEvent('dialog-close'));
        return;
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(element.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]'))
        .filter(node => node.tabIndex >= 0 && !node.disabled && !node.closest('[inert]')
          && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); element.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
        event.preventDefault(); last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
        event.preventDefault(); first.focus({ preventScroll: true });
      }
    };
    element.addEventListener('cancel', cancel);
    element.addEventListener('pointerdown', pointerDown);
    element.addEventListener('click', click, true);
    element.addEventListener('keydown', keydown);
    const waitFor = (animations, callback) => {
      if (!animations.length) { callback(); return; }
      Promise.allSettled(animations.map(animation => animation.finished)).then(callback);
    };
    return {
      setOpen(open) {
        open = !!open;
        if (requested === open) return;
        requested = open;
        const current = ++sequence;
        if (open) {
          if (preview) {
            stopDialogMotion(element);
            element.removeAttribute('data-dialog-closing');
          }
          const explicitOrigin = pendingDialogOrigins.get(element);
          pendingDialogOrigins.delete(element);
          if (!element.open) {
            previousFocus = document.activeElement;
            dialogOrigins.delete(element);
          }
          if (explicitOrigin) dialogOrigins.set(element, explicitOrigin.opener);
          if (morph && (!element.open || explicitOrigin)) dialogSources.set(element, explicitOrigin?.source);
          scheduleOpen(() => {
            if (current !== sequence || !requested || !element.isConnected) return;
            dismissPopups();
            element.inert = false;
            if (!element.open) {
              element.showModal();
              dialogs.push(element);
            }
            const target = Array.from(element.querySelectorAll('[data-dialog-autofocus]'))
              .find(node => !node.disabled && node.getClientRects().length);
            if (target && target !== document.activeElement) target.focus({ preventScroll: true });
            if (morph) {
              element.removeAttribute('data-dialog-closing');
              waitFor(playDialogMotion(element, true, explicitOrigin?.source), () => {
                if (current !== sequence) return;
                stopDialogMotion(element);
                element.dispatchEvent(new CustomEvent('dialog-after-open'));
              });
            }
            window.AnimaUI.placeNotifications?.();
            syncDialogScrims();
          });
        } else {
          dismissPopups(element);
          element.inert = true;
          const close = () => {
            if (current !== sequence || requested) return;
            if (element.open) element.close();
            stopDialogMotion(element);
            setHiddenDialogOrigin(element);
            const explicitOrigin = dialogOrigins.get(element);
            const returnFocus = previousFocus;
            dialogOrigins.delete(element);
            dialogSources.delete(element);
            previousFocus = null;
            element.removeAttribute('data-dialog-closing');
            const index = dialogs.indexOf(element);
            if (index >= 0) dialogs.splice(index, 1);
            syncDialogScrims();
            window.AnimaUI.placeNotifications?.();
            const animations = morph || preview ? [] : (element.getAnimations?.({ subtree: true }) || [])
              .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
            nextTick(() => {
              if (current !== sequence || requested) return;
              const top = dialogs.at(-1) || document.querySelector('dialog[open]');
              const origin = explicitOrigin || returnFocus;
              const opener = origin?.isConnected ? origin : origin?.id ? document.getElementById(origin.id) : null;
              const canFocus = opener && !opener.disabled && opener.getClientRects().length;
              if (top) {
                if (canFocus && top.contains(opener)) opener.focus({ preventScroll: true });
                return;
              }
              // Preserve an explicit focus destination set by the dialog action.
              const active = document.activeElement;
              const nativeRestore = explicitOrigin && active === returnFocus;
              if (!nativeRestore && active && active !== document.body && !element.contains(active)
                  && active.isConnected && !active.disabled && active.getClientRects().length) return;
              if (canFocus) opener.focus({ preventScroll: true });
              else document.getElementById('mainContent')?.focus({ preventScroll: true });
            });
            waitFor(animations, () => {
              if (current === sequence) element.dispatchEvent(new CustomEvent('dialog-after-close'));
            });
          };
          if (morph && element.open) {
            element.setAttribute('data-dialog-closing', '');
            waitFor(playDialogMotion(element, false), close);
          } else if (preview && element.open) {
            element.setAttribute('data-dialog-closing', '');
            waitFor(playPreviewDialogExit(element), close);
          } else close();
        }
      },
      destroy() {
        ++sequence;
        stopDialogMotion(element);
        dismissPopups(element);
        if (element.open) element.close();
        element.removeAttribute('data-dialog-closing');
        element.removeAttribute('data-dialog-nested');
        setHiddenDialogOrigin(element);
        dialogOrigins.delete(element);
        dialogSources.delete(element);
        pendingDialogOrigins.delete(element);
        previousFocus = null;
        const index = dialogs.indexOf(element);
        if (index >= 0) dialogs.splice(index, 1);
        if (index >= 0) syncDialogScrims();
        window.AnimaUI.placeNotifications?.();
        element.removeEventListener('cancel', cancel);
        element.removeEventListener('pointerdown', pointerDown);
        element.removeEventListener('click', click, true);
        element.removeEventListener('keydown', keydown);
      },
    };
  }

  // Each target gets a clipped strip of dashes and a stationary endpoint.
  function drawPreviewConnector(layer, kind, sx, sy, ends) {
    layer.dataset.kind = kind;
    layer.style.left = sx + 'px';
    layer.style.top = sy + 'px';
    ends.forEach(([tx, ty], index) => {
      let segment = layer.children[index];
      if (!segment) {
        segment = document.createElement('span');
        segment.className = 'preview-connector-segment';
        segment.append(document.createElement('i'));
        layer.append(segment);
      }
      const dx = tx - sx, dy = ty - sy;
      segment.style.width = Math.hypot(dx, dy) + 'px';
      segment.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
    });
    while (layer.children.length > ends.length) layer.lastElementChild.remove();
    layer.classList.toggle('is-active', ends.length > 0);
  }

  window.AnimaUI = {
    bindDialog, settleDialog, dismissPopups, setDialogOrigin, drawPreviewConnector,
    registerPopup: (element, close) => popups.set(element, close),
    unregisterPopup: element => popups.delete(element),
    topDialog: () => dialogs.at(-1) || null,
  };

  document.addEventListener('click', event => {
    const opener = event.target.closest?.('[data-dialog-opens]');
    if (opener) setDialogOrigin(document.getElementById(opener.dataset.dialogOpens), opener);
  }, true);

  document.addEventListener('alpine:init', () => {
    // Non-interactive straight leaders shared by chart and matrix previews.
    // Its endpoints come from the rendered elements, so resizing/localization
    // does not require hard-coded coordinates in either preview.
    // Contract: .preview-linked-layout + x-data="previewConnector" contains
    // data-preview-sidebar / data-preview-diagram regions. Matching link/target
    // keys connect one source to all targets; data-preview-anchor="region" is for chart ranges.
    Alpine.data('previewConnector', () => {
      let root, layer, hovered, focused, frame, resize, mutations;
      const sourceFor = node => node?.closest?.('[data-preview-link]');
      const paint = () => {
        frame = null;
        const source = hovered?.matches(':hover') ? hovered : focused?.matches(':focus-visible') ? focused : null;
        const kind = source?.dataset.previewLink;
        const targets = kind ? [...root.querySelectorAll(`[data-preview-target="${kind}"]`)] : [];
        if (!source || !root.contains(source) || !targets.length) { layer.classList.remove('is-active'); return; }
        if (dialogMotions.has(root.closest('dialog'))) { layer.classList.remove('is-active'); return; }
        const sidebar = source.closest('[data-preview-sidebar]');
        const chart = targets[0].closest('[data-preview-diagram]');
        const value = source.querySelector('dd, b') || source;
        const range = document.createRange();
        range.selectNodeContents(value.firstChild?.nodeType === 3 ? value.firstChild : value);
        const r = root.getBoundingClientRect(), s = range.getBoundingClientRect();
        const side = sidebar?.getBoundingClientRect(), diagram = chart?.getBoundingClientRect();
        // Only connect side-by-side layouts.
        if (!side || !diagram || diagram.left < side.right || !s.height) {
          layer.classList.remove('is-active'); return;
        }
        const x = value => value - r.left + root.scrollLeft;
        const y = value => value - r.top + root.scrollTop;
        const sx = x(s.right + 6), sy = y(s.top + s.height / 2);
        const ends = targets.filter(target => target.getClientRects().length).map(target => {
          const t = target.getBoundingClientRect();
          const cx = x(t.left + t.width / 2), cy = y(t.top + t.height / 2);
          // Point inside a highlighted range, away from its center and the axes.
          if (target.dataset.previewAnchor === 'region') return [x(t.left + t.width * .35), y(t.top + t.height * .75)];
          // Intersect the straight leader with the padded target boundary.
          const dx = sx - cx, dy = sy - cy;
          const scale = Math.max(Math.abs(dx) / (t.width / 2 + 4), Math.abs(dy) / (t.height / 2 + 4), 1);
          return [cx + dx / scale, cy + dy / scale];
        });
        drawPreviewConnector(layer, kind, sx, sy, ends);
      };
      const schedule = () => { if (frame == null) frame = requestAnimationFrame(paint); };
      const pointer = event => {
        hovered = sourceFor(event.type === 'pointerout' ? event.relatedTarget : event.target);
        if (hovered && !root.contains(hovered)) hovered = null;
        schedule();
      };
      const focus = event => {
        focused = sourceFor(event.type === 'focusout' ? event.relatedTarget : event.target);
        if (focused && !root.contains(focused)) focused = null;
        schedule();
      };
      return {
        init() {
          root = this.$el;
          layer = document.createElement('div');
          layer.className = 'preview-connector';
          layer.setAttribute('aria-hidden', 'true');
          root.append(layer);
          root.addEventListener('pointerover', pointer); root.addEventListener('pointerout', pointer);
          root.addEventListener('focusin', focus); root.addEventListener('focusout', focus);
          root.addEventListener('keydown', schedule);
          root.addEventListener('scroll', schedule, true);
          root.closest('dialog')?.addEventListener('dialog-after-open', schedule);
          resize = new ResizeObserver(schedule); resize.observe(root);
          mutations = new MutationObserver(schedule);
          mutations.observe(root, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-preview-link']});
        },
        destroy() {
          cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
          root.removeEventListener('pointerover', pointer); root.removeEventListener('pointerout', pointer);
          root.removeEventListener('focusin', focus); root.removeEventListener('focusout', focus);
          root.removeEventListener('keydown', schedule);
          root.removeEventListener('scroll', schedule, true); layer.remove();
          root.closest('dialog')?.removeEventListener('dialog-after-open', schedule);
        },
      };
    });

    Alpine.directive('dialog', (element, { expression }, { effect, evaluate, cleanup }) => {
      const nextTick = callback => Alpine.nextTick(callback);
      // Fixed-size panels can start as soon as Alpine's effects flush.
      // Content-sized panels need Alpine's deferred x-show before measuring.
      const scheduleOpen = element.hasAttribute('data-dialog-fast-open') ? queueMicrotask : nextTick;
      const dialog = bindDialog(element, nextTick, scheduleOpen);
      effect(() => dialog.setOpen(evaluate(expression)));
      cleanup(() => dialog.destroy());
    });

    let activeMenu = null;
    Alpine.data('actionMenu', () => ({
      open: false,
      mounted: false,
      positioned: false,
      _frame: null,
      _focusFrame: null,
      _hoverTimer: null,
      _hovered: false,
      _keyboard: false,
      _track: null,
      init() {
        this._track = event => {
          if (!this.open || (event.target?.nodeType && this.$refs.menu?.contains(event.target)) || this._frame !== null) return;
          this._frame = requestAnimationFrame(() => {
            this._frame = null;
            if (this.open) this.position();
          });
        };
      },
      destroy() { this.close(false); },
      items() {
        return Array.from(this.$refs.menu?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') || [])
          .filter(item => !item.disabled && item.getClientRects().length);
      },
      show(focus = false, last = false) {
        if (this.$refs.trigger.disabled || this.$refs.trigger.closest('.field-readonly')) return;
        settleDialog(this.$el);
        if (activeMenu && activeMenu.$el !== this.$el) activeMenu.close(false, true);
        activeMenu = this;
        window.AnimaUI.registerPopup(this.$el, () => this.close(false));
        if (!this.open) this.positioned = false;
        this._keyboard = this._keyboard || focus;
        this.mounted = true;
        this.open = true;
        window.addEventListener('scroll', this._track, true);
        window.addEventListener('resize', this._track);
        this.$nextTick(() => {
          if (!this.open) return;
          if (this._focusFrame !== null) cancelAnimationFrame(this._focusFrame);
          // x-show can defer its display change until the next animation frame.
          this._focusFrame = requestAnimationFrame(() => {
            this._focusFrame = null;
            if (!this.open) return;
            this.position();
            if (focus) this.$nextTick(() => {
              if (!this.open) return;
              const items = this.items();
              (last ? items.at(-1) : items[0])?.focus({ preventScroll: true });
            });
          });
        });
      },
      hoverEnter(event) {
        if (event.pointerType && event.pointerType !== 'mouse') return;
        this._hovered = true;
        clearTimeout(this._hoverTimer);
        if (!this.open) this.show();
      },
      hoverLeave() {
        this._hovered = false;
        clearTimeout(this._hoverTimer);
        // Bridge the 4px gap between the trigger and its floating menu.
        this._hoverTimer = setTimeout(() => {
          if (!this._hovered && !this._keyboard) this.close(false, true);
        }, 120);
      },
      focusOut(event) {
        if (!this.$el.contains(event.relatedTarget) && !this._hovered) this.close(false);
      },
      close(returnFocus = true, blur = false) {
        const wasOpen = this.open;
        this.open = false;
        window.AnimaUI.unregisterPopup(this.$el);
        this._keyboard = false;
        clearTimeout(this._hoverTimer);
        if (this._focusFrame !== null) cancelAnimationFrame(this._focusFrame);
        this._focusFrame = null;
        window.removeEventListener('scroll', this._track, true);
        window.removeEventListener('resize', this._track);
        if (this._frame !== null) cancelAnimationFrame(this._frame);
        this._frame = null;
        if (activeMenu?.$el === this.$el) activeMenu = null;
        if (wasOpen && returnFocus && this.$refs.trigger.isConnected) {
          this.$refs.trigger.focus({ preventScroll: true });
        } else if (blur && this.$el.contains(document.activeElement)) {
          document.activeElement.blur();
        }
      },
      toggle() {
        // Pointer entry already opened hover menus. A following click should
        // keep their actions available until the pointer leaves.
        if (this.open && this._hovered && !this._keyboard) return;
        if (this.open) this.close(); else this.show();
      },
      position() {
        const trigger = this.$refs.trigger;
        if (!trigger.isConnected || !trigger.getClientRects().length) { this.close(false); return; }
        const rect = trigger.getBoundingClientRect();
        const menu = this.$refs.menu;
        if (!menu) return;
        const height = menu.scrollHeight;
        const width = menu.offsetWidth;
        const upward = window.innerHeight - rect.bottom - 8 < height && rect.top > window.innerHeight - rect.bottom;
        menu.style.position = 'fixed';
        menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + 'px';
        menu.style.top = upward ? 'auto' : rect.bottom + 4 + 'px';
        menu.style.bottom = upward ? window.innerHeight - rect.top + 4 + 'px' : 'auto';
        menu.style.transformOrigin = (rect.right - width < 8 ? 'left ' : 'right ') + (upward ? 'bottom' : 'top');
        this.positioned = true;
      },
      key(event) {
        const key = event.key;
        if (key === 'Escape' && this.open) {
          event.preventDefault(); event.stopPropagation(); this.close(); return;
        }
        if (key === 'Tab' && this.open) { this.close(); return; }
        if (['Enter', ' '].includes(key) && event.target === this.$refs.trigger) {
          event.preventDefault(); event.stopPropagation();
          if (this.open && this._keyboard) this.close(); else this.show(true);
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
        event.preventDefault(); event.stopPropagation();
        if (!this.open) { this.show(true, key === 'ArrowUp' || key === 'End'); return; }
        this._keyboard = true;
        const items = this.items();
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1
          : index < 0 ? (key === 'ArrowUp' ? items.length - 1 : 0)
            : (index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus({ preventScroll: true });
      },
    }));
  });
})();
