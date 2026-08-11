/* ================================================================
   anima-select.js — Custom select dropdown component
   Registers with Alpine on alpine:init event
   ================================================================ */

document.addEventListener('alpine:init', () => {
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
    _escHandler: null,
    _positionFrame: null,
    _revealPoint: null,

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
        if (isOpen) this.$nextTick(() => this.positionMenu());
      });
      this._escHandler = (e) => {
        if (e.key === 'Escape' && this.open) { this.open = false; }
      };
      this.$el.addEventListener('keydown', this._escHandler);

      // fixed 菜单在页面或面板滚动时按帧重定位；菜单自身滚动无需重算。
      this._scrollHandler = (e) => {
        if (!this.open) return;
        const target = e.target;
        if (target && typeof target.closest === 'function' && target.closest('.anima-select-menu')) return;
        this.schedulePositionMenu();
      };
      window.addEventListener('scroll', this._scrollHandler, true);
      this._resizeHandler = () => { if (this.open) this.schedulePositionMenu(); };
      window.addEventListener('resize', this._resizeHandler);

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
      if (this._escHandler) {
        this.$el.removeEventListener('keydown', this._escHandler);
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
      this.open = false;
    },

    select(v) {
      this.value = v;
      this.open = false;
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
      this.open = !this.open;
      if (this.open) {
        this.positioned = false;
        this.setRevealOrigin(event);
        // 下拉菜单使用 fixed 定位锚定到触发器，避免被祖先 overflow:hidden
        // （如分组的 .card-body、.advanced-fold-body）裁剪。
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

    setRevealOrigin(event) {
      const trigger = this.$el.querySelector('.anima-select-trigger');
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const clientX = event && Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2;
      const clientY = event && Number.isFinite(event.clientY) ? event.clientY : rect.bottom;
      this._revealPoint = { x: clientX, y: clientY };
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
        this.$el.style.setProperty('--select-origin-y', '100%');
      } else {
        top = r.bottom + 4;
        menu.classList.remove('anima-select-menu-up');
        this.$el.style.setProperty('--select-origin-y', '0%');
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
      // 使用真实点击位置作为扩散中心；菜单上下翻转时仍保持指针位置自然衔接。
      const revealPoint = this._revealPoint || { x: r.left + r.width / 2, y: openUp ? r.top : r.bottom };
      const originX = Math.max(0, Math.min(width, revealPoint.x - left));
      const originY = Math.max(0, Math.min(renderedHeight, revealPoint.y - top));
      this.$el.style.setProperty('--select-origin-x', `${Math.round(originX)}px`);
      this.$el.style.setProperty('--select-origin-y', `${Math.round(originY)}px`);
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
      this.positioned = true;
    },

    });
  });
});
