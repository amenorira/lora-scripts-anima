/* ================================================================
   anima-select.js — Custom select dropdown component
   Registers with Alpine on alpine:init event
   ================================================================ */

document.addEventListener('alpine:init', () => {
  let nextListboxId = 0;
  Alpine.data('animaSelect', (fieldConfigJson, initialValue) => {
    // Most field configs are static. A function may be supplied by workspaces
    // whose options arrive asynchronously (for example the Tagger registry).
    const fieldConfigFactory = typeof fieldConfigJson === 'function' ? fieldConfigJson : null;
    let fieldConfig = {};
    try {
      if (fieldConfigFactory) {
        fieldConfig = fieldConfigFactory() || {};
      } else if (typeof fieldConfigJson === 'string') {
        const binary = atob(fieldConfigJson);
        const bytes = Uint8Array.from(binary, function(c) { return c.charCodeAt(0); });
        fieldConfig = JSON.parse(new TextDecoder().decode(bytes));
      } else {
        fieldConfig = fieldConfigJson || {};
      }
    } catch (e) {
      console.warn('[animaSelect] Failed to parse field config:', e);
    }
    const normalizedGroups = config => config.groups && config.groups.length
      ? config.groups
      : (config.options && config.options.length
        ? [{ label: '', options: config.options }]
        : []);
    const staticDisplayGroups = normalizedGroups(fieldConfig);
    const staticFlatOptions = staticDisplayGroups.flatMap(group => group.options || []);

    return ({
    open: false,
    positioned: false,
    value: initialValue,
    activeIndex: -1,
    _lastScrolledActiveIndex: -1,
    _listboxId: `anima-select-listbox-${++nextListboxId}`,
    _positionFrame: null,
    _closeAnimation: null,

    get displayGroups() {
      if (!fieldConfigFactory) return staticDisplayGroups;
      try { return normalizedGroups(fieldConfigFactory() || {}); }
      catch (_) { return []; }
    },

    get flatOptions() {
      if (!fieldConfigFactory) return staticFlatOptions;
      return this.displayGroups.flatMap(group => group.options || []);
    },

    get hasDescriptions() {
      return this.flatOptions.some(opt => opt.d);
    },

    get selectedLabel() {
      const opt = this.flatOptions.find(o => o.v === this.value);
      return opt ? opt.l : String(this.value || '');
    },

    init() {
      this.$watch('open', (isOpen) => {
        const trigger = this.$el.querySelector('.anima-select-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
          window.addEventListener('scroll', this._scrollHandler, true);
          window.addEventListener('resize', this._resizeHandler);
          this.$nextTick(() => this.positionMenu());
        } else {
          window.removeEventListener('scroll', this._scrollHandler, true);
          window.removeEventListener('resize', this._resizeHandler);
        }
      });
      const trigger = this.$el.querySelector('.anima-select-trigger');
      if (trigger) {
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
      }
      this._keyHandler = e => this.onKeydown(e);
      this.$el.addEventListener('keydown', this._keyHandler);

      // fixed 菜单在页面或面板滚动时按帧重定位；菜单自身滚动无需重算。
      this._scrollHandler = (e) => {
        if (!this.open) return;
        const target = e.target;
        if (target && typeof target.closest === 'function' && target.closest('.anima-select-menu')) return;
        this.schedulePositionMenu();
      };
      this._resizeHandler = () => { if (this.open) this.schedulePositionMenu(); };

      // Sync display when the hidden input value is changed externally
      // (e.g. by autoValue, config import, undo, reset, or any programmatic form update).
      // Alpine x-model sets el.value directly on the DOM property, so we intercept
      // the native setter to keep this.value in sync.
      const input = this.$refs.modelInput;
      if (input) {
        const self = this;
        const protoDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (protoDesc && protoDesc.set) {
          Object.defineProperty(input, 'value', {
            get() { return protoDesc.get.call(this); },
            set(v) {
              protoDesc.set.call(this, v);
              if (String(v) !== String(self.value)) {
                self.value = v;
              }
            },
            configurable: true,
            enumerable: true
          });
        }
      }
    },

    destroy() {
      if (this._closeAnimation) this._closeAnimation.cancel();
      if (this._keyHandler) {
        this.$el.removeEventListener('keydown', this._keyHandler);
      }
      if (this._scrollHandler) {
        window.removeEventListener('scroll', this._scrollHandler, true);
      }
      if (this._resizeHandler) {
        window.removeEventListener('resize', this._resizeHandler);
      }
      if (this._positionFrame !== null) {
        cancelAnimationFrame(this._positionFrame);
      }
    },

    closeOnOutside() {
      this.close();
    },

    close() {
      if (!this.open || this._closeAnimation) return;
      const menu = this.$el.querySelector('.anima-select-menu');
      const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!motion || !menu || !menu.animate) { this.open = false; return; }
      // Keep x-if mounted until exit finishes. Inert prevents duplicate selections.
      const style = getComputedStyle(menu);
      menu.inert = true;
      const animation = menu.animate([
        { opacity: style.opacity, transform: style.transform },
        { opacity: 0, transform: 'scale(0.99)' }
      ], { duration: 150, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
      this._closeAnimation = animation;
      animation.onfinish = () => {
        this.open = false;
        this._closeAnimation = null;
      };
    },

    _enabledIndices() {
      return this.flatOptions.map((option, index) =>
        option.disabled || option.enabled === false ? -1 : index).filter(index => index >= 0);
    },

    _syncOptionA11y() {
      const trigger = this.$el.querySelector('.anima-select-trigger');
      const menu = this.$el.querySelector('.anima-select-menu');
      if (!trigger || !menu) return;
      menu.id = this._listboxId;
      menu.setAttribute('role', 'listbox');
      trigger.setAttribute('aria-controls', this._listboxId);
      const options = menu.querySelectorAll('.anima-select-option');
      const flatOptions = this.flatOptions;
      options.forEach((element, index) => {
        const option = flatOptions[index];
        element.id = `${this._listboxId}-option-${index}`;
        element.setAttribute('role', 'option');
        element.setAttribute('aria-selected', String(!!option && String(option.v) === String(this.value)));
        element.setAttribute('aria-disabled', String(!!option && (option.disabled || option.enabled === false)));
        element.classList.toggle('kb-active', index === this.activeIndex);
      });
      if (this.activeIndex >= 0 && options[this.activeIndex]) {
        trigger.setAttribute('aria-activedescendant', options[this.activeIndex].id);
        if (this._lastScrolledActiveIndex !== this.activeIndex) {
          options[this.activeIndex].scrollIntoView({ block: 'nearest' });
          this._lastScrolledActiveIndex = this.activeIndex;
        }
      } else {
        trigger.removeAttribute('aria-activedescendant');
        this._lastScrolledActiveIndex = -1;
      }
    },

    _openForKeyboard(key) {
      const enabled = this._enabledIndices();
      if (!enabled.length) return;
      const selected = enabled.find(index => String(this.flatOptions[index].v) === String(this.value));
      if (key === 'Home') this.activeIndex = enabled[0];
      else if (key === 'End') this.activeIndex = enabled[enabled.length - 1];
      else this.activeIndex = selected === undefined
        ? (key === 'ArrowUp' ? enabled[enabled.length - 1] : enabled[0]) : selected;
      this.open = true;
      this.positioned = false;
      this._lastScrolledActiveIndex = -1;
      this.$nextTick(() => this.positionMenu());
    },

    onKeydown(event) {
      if (!event.target.closest('.anima-select-trigger') || event.target.disabled) return;
      if (this._closeAnimation) return;
      const key = event.key;
      if (key === 'Escape') {
        if (this.open) {
          event.preventDefault();
          this.close();
          event.target.focus();
        }
        return;
      }
      if (key === 'Tab') {
        if (this.open) this.close();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) return;
      event.preventDefault();
      if (!this.open) {
        this._openForKeyboard(key);
        return;
      }
      const enabled = this._enabledIndices();
      if (!enabled.length) return;
      if (key === 'Enter' || key === ' ') {
        const option = this.flatOptions[this.activeIndex];
        if (option && !option.disabled && option.enabled !== false) this.select(option.v);
        return;
      }
      if (key === 'Home') this.activeIndex = enabled[0];
      else if (key === 'End') this.activeIndex = enabled[enabled.length - 1];
      else {
        const current = enabled.indexOf(this.activeIndex);
        const direction = key === 'ArrowDown' ? 1 : -1;
        this.activeIndex = enabled[(current + direction + enabled.length) % enabled.length];
      }
      this._syncOptionA11y();
    },

    select(v) {
      const selectedOption = this.flatOptions.find(option => String(option.v) === String(v));
      if (selectedOption && (selectedOption.disabled || selectedOption.enabled === false)) return;
      this.value = v;
      this.activeIndex = this.flatOptions.findIndex(option => String(option.v) === String(v));
      this.close();
      this.syncToModel();
      this.$dispatch('anima-select-change', { value: v });
    },

    syncToModel() {
      const input = this.$refs.modelInput;
      if (input) {
        input.value = this.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    },

    toggle(event) {
      if (this.open) {
        this.close();
        return;
      }
      this.open = !this.open;
      if (this.open) {
        const enabled = this._enabledIndices();
        const selected = enabled.find(index => String(this.flatOptions[index].v) === String(this.value));
        this.activeIndex = selected === undefined ? (enabled[0] ?? -1) : selected;
        this.positioned = false;
        this._lastScrolledActiveIndex = -1;
        // 下拉菜单使用 fixed 定位锚定到触发器，避免被祖先 overflow:hidden
        // （如分组的 .card-body）裁剪。
        this.$nextTick(() => this.positionMenu());
      }
    },

    schedulePositionMenu() {
      if (this._positionFrame !== null) return;
      this._positionFrame = requestAnimationFrame(() => {
        this._positionFrame = null;
        if (this.open) this.positionMenu();
      });
    },

    // 把菜单定位到触发器正下方（fixed，相对视口），并约束在视口内。
    positionMenu() {
      const root = this.$el;
      const trigger = root.querySelector('.anima-select-trigger');
      const menu = root.querySelector('.anima-select-menu');
      if (!trigger || !menu) return;
      const firstPosition = !this.positioned;
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 带说明的选项需要更宽的阅读区域；窄屏下仍由视口宽度兜底。
      const width = Math.min(Math.max(r.width, this.hasDescriptions ? 320 : 200), vw - 16);
      const menuScroll = menu.querySelector('.anima-select-menu-scroll');
      const maxScrollHeight = 520;
      if (menuScroll) menuScroll.style.maxHeight = `${maxScrollHeight}px`;
      const desiredHeight = Math.min(menu.scrollHeight, maxScrollHeight + 2);
      const spaceBelow = Math.max(0, vh - r.bottom - 8);
      const spaceAbove = Math.max(0, r.top - 8);
      const openUp = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const availableHeight = openUp ? spaceAbove : spaceBelow;
      if (menuScroll) menuScroll.style.maxHeight = `${Math.max(120, Math.min(maxScrollHeight, availableHeight - 2))}px`;
      const renderedHeight = Math.min(menu.scrollHeight, availableHeight);
      let top;
      if (openUp) {
        top = Math.max(8, r.top - renderedHeight - 4);
        menu.classList.add('anima-select-menu-up');
      } else {
        top = r.bottom + 4;
        menu.classList.remove('anima-select-menu-up');
      }
      // 带说明的宽菜单向左展开，避免侵入右侧预览栏；紧凑菜单保持左对齐。
      let left = this.hasDescriptions ? r.right - width : r.left;
      if (left + width > vw - 8) left = vw - width - 8;
      if (left < 8) left = 8;
      menu.style.position = 'fixed';
      menu.style.top = Math.round(top) + 'px';
      menu.style.left = Math.round(left) + 'px';
      menu.style.width = Math.round(width) + 'px';
      menu.style.right = 'auto';
      menu.style.transformOrigin = `${left < r.left ? 'right' : 'left'} ${openUp ? 'bottom' : 'top'}`;
      if (firstPosition && menuScroll) {
        const activeOption = menuScroll.querySelector('.anima-select-option.active');
        if (activeOption) {
          const optionTop = activeOption.offsetTop;
          const optionBottom = optionTop + activeOption.offsetHeight;
          if (optionTop < menuScroll.scrollTop || optionBottom > menuScroll.scrollTop + menuScroll.clientHeight) {
            menuScroll.scrollTop = Math.max(0, optionTop - (menuScroll.clientHeight - activeOption.offsetHeight) / 2);
          }
        }
      }
      this._syncOptionA11y();
      this.positioned = true;
    },

    });
  });
});
