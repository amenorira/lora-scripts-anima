/* ================================================================
   anima-select.js — Custom select dropdown component
   Registers with Alpine on alpine:init event
   ================================================================ */

document.addEventListener('alpine:init', () => {
  Alpine.data('animaSelect', (fieldConfigJson, initialValue) => ({
    open: false,
    value: initialValue,
    hoveredIdx: -1,
    hoveredOpt: null,
    _escHandler: null,

    get displayGroups() {
      try {
        let json;
        if (typeof fieldConfigJson === 'string') {
          const binary = atob(fieldConfigJson);
          const bytes = Uint8Array.from(binary, function(c) { return c.charCodeAt(0); });
          json = new TextDecoder().decode(bytes);
        } else {
          json = JSON.stringify(fieldConfigJson || {});
        }
        const fc = typeof json === 'string' ? JSON.parse(json) : json;
        if (fc.groups && fc.groups.length) return fc.groups;
        if (fc.options && fc.options.length) return [{ label: '', options: fc.options }];
      } catch (e) {
        console.warn('[animaSelect] Failed to parse field config:', e);
      }
      return [];
    },

    get flatOptions() {
      const result = [];
      this.displayGroups.forEach(g => {
        (g.options || []).forEach(o => result.push(o));
      });
      return result;
    },

    get selectedLabel() {
      const opt = this.flatOptions.find(o => o.v === this.value);
      return opt ? opt.l : String(this.value || '');
    },

    get selectedDesc() {
      const opt = this.flatOptions.find(o => o.v === this.value);
      return opt ? (opt.d || '') : '';
    },

    init() {
      this._escHandler = (e) => {
        if (e.key === 'Escape' && this.open) { this.open = false; }
      };
      this.$el.addEventListener('keydown', this._escHandler);

      // 滚动或窗口尺寸变化时关闭菜单（fixed 定位的菜单不会跟随页面滚动，
      // 关闭比错位重定位更安全，符合常见下拉交互直觉）。
      // 但菜单内部滚动（.anima-select-menu-scroll）不应关闭——需区分页面滚动与菜单滚动：
      // capture 阶段检查 e.target，若源自菜单内部则忽略。
      this._scrollHandler = (e) => {
        if (!this.open) return;
        const target = e.target;
        if (target && typeof target.closest === 'function' && target.closest('.anima-select-menu')) return;
        this.open = false;
      };
      window.addEventListener('scroll', this._scrollHandler, true);
      this._resizeHandler = () => { if (this.open) this.open = false; };
      window.addEventListener('resize', this._resizeHandler);

      // Sync display when the hidden input value is changed externally
      // (e.g. by autoValue, preset load, undo, reset, or any programmatic form update).
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

    onOptionMouseEnter(idx, opt) {
      this.hoveredIdx = idx;
      this.hoveredOpt = opt;
    },

    onOptionMouseLeave() {
      this.hoveredIdx = -1;
      this.hoveredOpt = null;
    },

    toggle() {
      this.open = !this.open;
      if (!this.open) {
        this.hoveredIdx = -1;
        this.hoveredOpt = null;
      } else {
        // 下拉菜单使用 fixed 定位锚定到触发器，避免被祖先 overflow:hidden
        // （如分组的 .card-body、.advanced-fold-body）裁剪。
        this.$nextTick(() => this.positionMenu());
      }
    },

    // 把菜单定位到触发器正下方（fixed，相对视口），并约束在视口内。
    positionMenu() {
      const root = this.$el;
      const trigger = root.querySelector('.anima-select-trigger');
      const menu = root.querySelector('.anima-select-menu');
      if (!trigger || !menu) return;
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 宽度：至少触发器宽，但不超出视口
      const width = Math.max(r.width, 200);
      // 预估菜单高度（最多 300 滚动区 + 描述栏 ~40），估算用 340
      const estMenuH = Math.min(340, vh - r.bottom - 8);
      // 若下方空间不足且上方更宽裕，则向上展开
      let top;
      if (r.bottom + estMenuH > vh - 8 && r.top - estMenuH > 8) {
        top = r.top - estMenuH; // 向上
        menu.classList.add('anima-select-menu-up');
      } else {
        top = r.bottom + 4;
        menu.classList.remove('anima-select-menu-up');
      }
      // 水平：左对齐触发器，若超出右侧则贴右
      let left = r.left;
      if (left + width > vw - 8) left = vw - width - 8;
      if (left < 8) left = 8;
      menu.style.position = 'fixed';
      menu.style.top = Math.round(top) + 'px';
      menu.style.left = Math.round(left) + 'px';
      menu.style.width = Math.round(width) + 'px';
      menu.style.right = 'auto';
    },

  }));
});
