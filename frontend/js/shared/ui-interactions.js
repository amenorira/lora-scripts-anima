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

  function syncDialogBackgrounds() {
    const morphOpen = dialogs.some(dialog => dialog.classList.contains('modal-overlay--morph'));
    document.querySelector('body > .app-layout')?.classList.toggle('dialog-is-background', morphOpen);
    document.getElementById('cropPreviewDialog')?.classList.toggle('dialog-is-background',
      dialogs.some(dialog => dialog.id === 'cropFocusDialog'));
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
    // An underlying dialog may become inert before the next Alpine effect runs.
    // Preserve an explicit opener instead of capturing the now-blurred body.
    const source = measureOrigin(origin);
    if (element.open) {
      dialogOrigins.set(element, origin);
      dialogSources.set(element, source);
      if (element.querySelector(mediaTargetSelector)) setHiddenDialogOrigin(element, source?.anchor);
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
  function measureOrigin(opener) {
    const anchor = opener?.querySelector(anchorSelector) || opener;
    if (!anchor?.isConnected || !anchor.getClientRects().length) return null;
    const rect = anchor.getBoundingClientRect();
    const style = getComputedStyle(anchor);
    if (!rect.width || !rect.height || (style.visibility === 'hidden' && !anchor.classList.contains('dialog-morph-origin'))) return null;
    const transparent = 'rgba(0, 0, 0, 0)';
    let backgroundColor = style.backgroundColor;
    const visible = {
      top: Math.max(rect.top, 0), right: Math.min(rect.right, window.innerWidth),
      bottom: Math.min(rect.bottom, window.innerHeight), left: Math.max(rect.left, 0),
    };
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (backgroundColor === transparent) backgroundColor = parentStyle.backgroundColor;
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
    // Computed styles are live. Freeze the button's appearance before the
    // top layer takes hover and focus away from the source.
    const paint = { backgroundColor, borderRadius: style.borderRadius,
      borderTopColor: style.borderTopColor, borderTopWidth: style.borderTopWidth };
    if (anchor === opener) {
      for (const name of ['color', 'font', 'letterSpacing', 'padding', 'display', 'gap', 'alignItems', 'justifyContent']) {
        paint[name] = style[name];
      }
    }
    return { anchor, rect, visible, paint };
  }

  function buttonFlight(element, { source, panel, bounds, dest, opening, animate, reuse }) {
    const { anchor, rect, paint, visible } = source;
    const copy = anchor.cloneNode(true);
    for (const node of [copy, ...copy.querySelectorAll('[id]')]) node.removeAttribute('id');
    copy.removeAttribute('data-dialog-opens');
    copy.setAttribute('x-ignore', '');
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    copy.classList.toggle('dialog-morph-origin', false);
    copy.classList.add('dialog-morph-button');
    Object.assign(copy.style, paint, {
      left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    element.append(copy);
    reuse(copy, 'copy');
    const dx = (visible.left + visible.right - dest.left - dest.right) / 2;
    const dy = (visible.top + visible.bottom - dest.top - dest.bottom) / 2;
    const startScale = Math.max((visible.right - visible.left) / dest.width, (visible.bottom - visible.top) / dest.height);
    animate(copy, { transform: 'translate(0px, 0px)' }, { transform: `translate(${-dx}px, ${-dy}px)` });
    animate(panel, { transform: `translate(${dx}px, ${dy}px) scale(${startScale})` },
      { transform: 'translate(0px, 0px) scale(1)' });
    // Time the crossfade separately so it stays readable while the outline moves quickly.
    const label = opening
      ? [{ opacity: 1, offset: .04, easing: 'ease-in-out' }, { opacity: 0, offset: .36 }]
      : [{ opacity: 0, offset: .20, easing: 'ease-in-out' }, { opacity: 1, offset: .58 }];
    const content = opening
      ? [{ opacity: 0, offset: .10, easing: 'ease-in-out' }, { opacity: 1, offset: .63 }]
      : [{ opacity: 1, offset: .04, easing: 'ease-in-out' }, { opacity: 0, offset: .36 }];
    animate(copy, { opacity: 1 }, { opacity: 0 }, label, 'linear');
    animate(panel, { opacity: 0 }, { opacity: 1 }, content, 'linear');
    element.setAttribute('data-dialog-button-flight', '');
    return copy;
  }

  // Clip the panel to the moving outline and paint the rim as a real border.
  // A translucent fill must composite over the backdrop, not the rim color.
  function animateSurface(element, { bounds, source, dest, panel, opening, animate, reuse, rounded }) {
    const surface = document.createElement('div');
    surface.className = 'dialog-morph-fill';
    surface.setAttribute('aria-hidden', 'true');
    element.append(surface);
    reuse(surface, 'surface');
    const shape = (rect, paint) => {
      const inset = [rect.top - bounds.top, bounds.right - rect.right,
        bounds.bottom - rect.bottom, rect.left - bounds.left].map(value => `${value}px`).join(' ');
      const { borderRadius, backgroundColor, borderTopColor, borderTopWidth } = paint;
      return {
        clip: { clipPath: `inset(${inset} round ${borderRadius})` },
        surface: { inset, borderRadius, backgroundColor, borderColor: borderTopColor, borderWidth: borderTopWidth },
      };
    };
    const start = shape(source.visible, source.paint);
    const end = shape(dest, panel);
    const frames = [];
    if (rounded) {
      const middle = Object.fromEntries(['top', 'right', 'bottom', 'left'].map(side =>
        [side, source.visible[side] + (dest[side] - source.visible[side]) * .36]));
      frames.push({ ...shape(middle, { ...panel, borderRadius: '16px' }), offset: opening ? .36 : .64 });
    }
    for (const [node, layer] of [[element, 'clip'], [surface, 'surface']]) {
      animate(node, start[layer], end[layer], frames.map(frame => ({ ...frame[layer], offset: frame.offset })));
    }
    return surface;
  }

  function stopDialogMotion(element) {
    for (const animation of dialogMotions.get(element) || []) animation.cancel();
    dialogMotions.delete(element);
    const flight = dialogFlights.get(element);
    flight?.copy?.remove();
    flight?.surface?.remove();
    dialogFlights.delete(element);
    element.removeAttribute('data-dialog-button-flight');
  }

  function playDialogMotion(element, opening, capturedSource) {
    const oldFlight = dialogFlights.get(element);
    const previous = new Map((dialogMotions.get(element) || []).map(animation => {
      const node = animation.effect.target;
      const style = getComputedStyle(node);
      const properties = ['transform', 'opacity', 'clipPath', 'backgroundColor', 'inset', 'borderRadius', 'borderColor', 'borderWidth'];
      return [node, Object.fromEntries(properties.map(name => [name, style[name]]))];
    }));
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
    if (media && source?.anchor !== opener) setHiddenDialogOrigin(element, source?.anchor);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return [];
    const panelRect = modal.getBoundingClientRect();
    const dest = media ? media.getBoundingClientRect() : panelRect;
    const style = getComputedStyle(element);
    const options = {
      duration: parseFloat(style.getPropertyValue(opening ? '--duration-dialog-enter' : '--duration-dialog-exit')),
      easing: style.getPropertyValue('--ease-disclosure').trim(),
      fill: 'both',
    };
    const animations = [];
    const animate = (node, hidden, shown, between = [], easing = options.easing) => {
      const start = previous.get(node);
      const frames = opening ? [hidden, ...between, shown] : [shown, ...between, hidden];
      const first = start && Object.fromEntries(Object.keys(frames[0]).map(name => [name, start[name] || frames[0][name]]));
      animations.push(node.animate(first ? [first, frames.at(-1)] : frames, { ...options, easing }));
    };
    if (!source || !dest.width || !dest.height || (media && source.anchor === dialogOrigins.get(element))) {
      animate(modal, { opacity: 0 }, { opacity: 1 });
    } else {
      const { anchor, rect } = source;
      const bounds = element.getBoundingClientRect();
      const surfaceStyle = getComputedStyle(modal.querySelector('.dialog-morph-surface') || modal);
      const { borderRadius, borderTopWidth, borderTopColor, backgroundColor } = surfaceStyle;
      const panel = { borderRadius, borderTopWidth, borderTopColor, backgroundColor };
      const reuse = (node, key) => {
        if (oldFlight?.[key]) previous.set(node, previous.get(oldFlight[key]));
      };
      const surface = animateSurface(element, { bounds, source, dest: panelRect, panel, opening,
        animate, reuse, rounded: !!media });
      let copy;
      if (media) {
        const reveal = opening ? [{ opacity: 0, offset: .24 }, { opacity: 1, offset: .79 }]
          : [{ opacity: 1, offset: .21 }, { opacity: 0, offset: .76 }];
        const dx = rect.left - dest.left;
        const dy = rect.top - dest.top;
        animate(media, { transform: `translate(${dx}px, ${dy}px) scale(${rect.width / dest.width}, ${rect.height / dest.height})` },
          { transform: 'translate(0px, 0px) scale(1, 1)' });
        for (const part of modal.querySelectorAll('[data-dialog-chrome]')) {
          animate(part, { opacity: 0 }, { opacity: 1 }, reveal, 'linear');
        }
      } else {
        copy = buttonFlight(element, { source, panel: modal, bounds, dest, opening, animate, reuse });
        setHiddenDialogOrigin(element, anchor);
      }
      dialogFlights.set(element, { surface, copy });
    }
    dialogMotions.set(element, animations);
    return animations;
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
    // menus. Finish its entrance before measuring an immediately opened menu.
    for (const animation of dialogMotions.get(dialog) || modal.getAnimations?.() || []) {
      if (animation.playState === 'running') animation.finish();
    }
  }

  function bindDialog(element, nextTick, scheduleOpen = nextTick) {
    const morph = element.classList.contains('modal-overlay--morph');
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
          const explicitOrigin = pendingDialogOrigins.get(element);
          pendingDialogOrigins.delete(element);
          if (!element.open) {
            previousFocus = document.activeElement;
            dialogOrigins.delete(element);
          }
          if (explicitOrigin) dialogOrigins.set(element, explicitOrigin.opener);
          if (!element.open || explicitOrigin) dialogSources.set(element, explicitOrigin?.source);
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
            if (morph) syncDialogBackgrounds();
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
            if (morph) syncDialogBackgrounds();
            window.AnimaUI.placeNotifications?.();
            const animations = morph ? [] : (element.getAnimations?.({ subtree: true }) || [])
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
          } else close();
        }
      },
      destroy() {
        ++sequence;
        stopDialogMotion(element);
        dismissPopups(element);
        if (element.open) element.close();
        setHiddenDialogOrigin(element);
        dialogOrigins.delete(element);
        dialogSources.delete(element);
        pendingDialogOrigins.delete(element);
        previousFocus = null;
        const index = dialogs.indexOf(element);
        if (index >= 0) dialogs.splice(index, 1);
        if (morph && index >= 0) syncDialogBackgrounds();
        window.AnimaUI.placeNotifications?.();
        element.removeEventListener('cancel', cancel);
        element.removeEventListener('pointerdown', pointerDown);
        element.removeEventListener('click', click, true);
        element.removeEventListener('keydown', keydown);
      },
    };
  }

  window.AnimaUI = {
    bindDialog, settleDialog, dismissPopups, setDialogOrigin,
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
      let root, svg, path, dots, hovered, focused, frame, resize, mutations;
      const sourceFor = node => node?.closest?.('[data-preview-link]');
      const paint = () => {
        frame = null;
        const source = hovered?.matches(':hover') ? hovered : focused?.matches(':focus-visible') ? focused : null;
        const kind = source?.dataset.previewLink;
        const targets = kind ? [...root.querySelectorAll(`[data-preview-target="${kind}"]`)] : [];
        if (!source || !root.contains(source) || !targets.length) { svg.classList.remove('is-active'); return; }
        if (dialogMotions.has(root.closest('dialog'))) { svg.classList.remove('is-active'); return; }
        const sidebar = source.closest('[data-preview-sidebar]');
        const chart = targets[0].closest('[data-preview-diagram]');
        const value = source.querySelector('dd, b') || source;
        const range = document.createRange();
        range.selectNodeContents(value.firstChild?.nodeType === 3 ? value.firstChild : value);
        const r = root.getBoundingClientRect(), s = range.getBoundingClientRect();
        const side = sidebar?.getBoundingClientRect(), diagram = chart?.getBoundingClientRect();
        // Only connect side-by-side layouts.
        if (!side || !diagram || diagram.left < side.right || !s.height) {
          svg.classList.remove('is-active'); return;
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
        svg.dataset.kind = kind;
        path.setAttribute('d', ends.map(([tx, ty]) => `M ${sx} ${sy} L ${tx} ${ty}`).join(' '));
        dots.setAttribute('d', ends.map(([tx, ty]) => `M ${tx - 2} ${ty} a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0`).join(' '));
        svg.classList.toggle('is-active', ends.length > 0);
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
          const create = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);
          svg = create('svg'); path = create('path'); dots = create('path');
          svg.classList.add('preview-connector'); svg.setAttribute('aria-hidden', 'true');
          dots.classList.add('preview-connector-dots'); svg.append(path, dots); root.append(svg);
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
          root.removeEventListener('scroll', schedule, true); svg.remove();
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
