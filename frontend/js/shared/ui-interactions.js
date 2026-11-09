/* Shared popup interaction. Native dialogs own modality and focus containment;
   Alpine owns application state. Menus stay local to avoid rebuilding forms. */
(function () {
  'use strict';
  const dialogs = [];
  const popups = new Map();
  const dialogOrigins = new WeakMap();
  const pendingDialogOrigins = new WeakMap();

  // Opt in with .modal-overlay--morph. Only transforms animate; layout stays fixed.
  function setDialogOrigin(element, origin) {
    if (!element || !origin) return;
    dialogOrigins.set(element, origin);
    // An underlying dialog may become inert before the next Alpine effect runs.
    // Preserve an explicit opener instead of capturing the now-blurred body.
    if (!element.open) pendingDialogOrigins.set(element, origin);
  }
  function syncDialogOrigin(element) {
    if (!element.classList.contains('modal-overlay--morph')) return;
    const modal = element.querySelector('.modal');
    if (!modal) return;
    const opener = dialogOrigins.get(element);
    const anchor = opener?.querySelector('[data-dialog-anchor]') || opener;
    const source = anchor?.getBoundingClientRect();
    let transform = 'scale(.97)';
    if (anchor?.isConnected && anchor.getClientRects().length && source?.width > 0 && source.height > 0
        && source.left >= 0 && source.top >= 0 && source.right <= window.innerWidth && source.bottom <= window.innerHeight
        && modal.offsetWidth > 0 && modal.offsetHeight > 0) {
      const root = element.getBoundingClientRect();
      const dx = source.left + source.width / 2 - (root.left + modal.offsetLeft + modal.offsetWidth / 2);
      const dy = source.top + source.height / 2 - (root.top + modal.offsetTop + modal.offsetHeight / 2);
      transform = `translate(${dx}px,${dy}px) scale(${Math.min(1, source.width / modal.offsetWidth)},${Math.min(1, source.height / modal.offsetHeight)})`;
    }
    modal.style.setProperty('--dialog-origin-transform', transform);
  }
  function dismissPopups(root) {
    for (const [element, close] of Array.from(popups)) {
      if (!root || root.contains(element)) { popups.delete(element); close(); }
    }
  }

  function settleDialog(anchor) {
    const modal = anchor.closest('.modal');
    if (!modal?.closest('dialog[open]')) return;
    // A transforming dialog temporarily becomes the containing block of fixed
    // menus. Finish its entrance before measuring an immediately opened menu.
    for (const animation of modal.getAnimations?.() || []) {
      if (animation.playState === 'running') animation.finish();
    }
  }

  function bindDialog(element, nextTick) {
    let requested = false;
    let sequence = 0;
    let previousFocus = null;
    let backdropPress = false;
    const cancel = event => {
      event.preventDefault();
      element.dispatchEvent(new CustomEvent('dialog-close'));
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
        element.dispatchEvent(new CustomEvent('dialog-close'));
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
    return {
      setOpen(open) {
        open = !!open;
        if (requested === open) return;
        requested = open;
        const current = ++sequence;
        if (open) {
          previousFocus = pendingDialogOrigins.get(element) || document.activeElement;
          pendingDialogOrigins.delete(element);
          dialogOrigins.set(element, previousFocus);
          nextTick(() => {
            if (current !== sequence || !requested || !element.isConnected) return;
            dismissPopups();
            element.inert = false;
            if (!element.open) element.showModal();
            syncDialogOrigin(element);
            dialogs.push(element);
            window.AnimaUI.placeNotifications?.();
            const target = Array.from(element.querySelectorAll('[data-dialog-autofocus]'))
              .find(node => !node.disabled && node.getClientRects().length);
            if (target) target.focus({ preventScroll: true });
          });
        } else {
          dismissPopups(element);
          syncDialogOrigin(element);
          element.inert = true;
          if (element.open) element.close();
          // Keep content until native display/overlay transitions finish.
          const animations = (element.getAnimations?.({ subtree: true }) || [])
            .filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity);
          Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(() => {
            if (current === sequence && !requested) element.dispatchEvent(new CustomEvent('dialog-after-close'));
          });
          const index = dialogs.indexOf(element);
          if (index >= 0) dialogs.splice(index, 1);
          window.AnimaUI.placeNotifications?.();
          // Native close restores the opener. Only repair a missing/hidden opener;
          // never steal focus from a second dialog opened by the same action.
          nextTick(() => {
            if (current !== sequence || requested || document.querySelector('dialog[open]')) return;
            const active = document.activeElement;
            // A link in the dialog may deliberately focus a field on the page.
            // Repair lost focus only; do not overwrite that explicit destination.
            if (active && active !== document.body && !element.contains(active)
              && active.isConnected && !active.disabled && active.getClientRects().length) return;
            const opener = previousFocus?.isConnected ? previousFocus
              : previousFocus?.id ? document.getElementById(previousFocus.id) : null;
            if (opener && !opener.disabled && opener.getClientRects().length) {
              opener.focus({ preventScroll: true });
            } else if (document.activeElement === document.body) {
              document.getElementById('mainContent')?.focus({ preventScroll: true });
            }
          });
        }
      },
      destroy() {
        ++sequence;
        dismissPopups(element);
        if (element.open) element.close();
        const index = dialogs.indexOf(element);
        if (index >= 0) dialogs.splice(index, 1);
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
        settleDialog(source);
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
        },
      };
    });

    Alpine.directive('dialog', (element, { expression }, { effect, evaluate, cleanup }) => {
      const dialog = bindDialog(element, callback => Alpine.nextTick(callback));
      effect(() => dialog.setOpen(evaluate(expression)));
      cleanup(() => dialog.destroy());
    });

    let activeMenu = null;
    Alpine.data('actionMenu', () => ({
      open: false,
      positioned: false,
      _frame: null,
      _focusFrame: null,
      _hoverTimer: null,
      _hovered: false,
      _keyboard: false,
      _track: null,
      init() {
        this._track = event => {
          if (!this.open || (event.target?.nodeType && this.$refs.menu.contains(event.target)) || this._frame !== null) return;
          this._frame = requestAnimationFrame(() => {
            this._frame = null;
            if (this.open) this.position();
          });
        };
      },
      destroy() { this.close(false); },
      items() {
        return Array.from(this.$refs.menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
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
