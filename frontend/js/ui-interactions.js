/* Shared popup interaction. Native dialogs own modality and focus containment;
   Alpine owns application state. Menus stay local to avoid rebuilding forms. */
(function () {
  'use strict';
  const dialogs = [];
  const popups = new Map();
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
          previousFocus = document.activeElement;
          nextTick(() => {
            if (current !== sequence || !requested || !element.isConnected) return;
            dismissPopups();
            element.inert = false;
            if (!element.open) element.showModal();
            dialogs.push(element);
            window.AnimaUI.placeNotifications?.();
            const target = Array.from(element.querySelectorAll('[data-dialog-autofocus]'))
              .find(node => !node.disabled && node.getClientRects().length);
            if (target) target.focus({ preventScroll: true });
          });
        } else {
          dismissPopups(element);
          element.inert = true;
          if (element.open) element.close();
          const index = dialogs.indexOf(element);
          if (index >= 0) dialogs.splice(index, 1);
          window.AnimaUI.placeNotifications?.();
          // Native close restores the opener. Only repair a missing/hidden opener;
          // never steal focus from a second dialog opened by the same action.
          nextTick(() => {
            if (current !== sequence || requested || document.querySelector('dialog[open]')) return;
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
    bindDialog, settleDialog, dismissPopups,
    registerPopup: (element, close) => popups.set(element, close),
    unregisterPopup: element => popups.delete(element),
    topDialog: () => dialogs.at(-1) || null,
  };

  document.addEventListener('alpine:init', () => {
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
