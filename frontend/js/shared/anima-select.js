/* ================================================================
   anima-select.js — Custom select dropdown component
   Registers with Alpine on alpine:init event
   ================================================================ */

document.addEventListener('alpine:init', () => {
  let nextListboxId = 0;
  const createAnimaSelect = (fieldConfigJson, initialValue, { align = 'left', preview = false } = {}) => {
    const triggerSelector = preview ? '.preview-select-trigger' : '.anima-select-trigger';
    const menuSelector = preview ? '.preview-select-menu' : '.anima-select-menu';
    const optionSelector = preview ? '.preview-select-option' : '.anima-select-option';
    // Most field configs are static. A function may be supplied by workspaces
    // whose options arrive asynchronously (for example the Tagger registry).
    const fieldConfigFactory = typeof fieldConfigJson === 'function' ? fieldConfigJson : null;
    let fieldConfig = {};
    try {
      if (fieldConfigFactory && !preview) {
        fieldConfig = fieldConfigFactory() || {};
      } else if (fieldConfigFactory) {
        fieldConfig = {};
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
    const localized = staticDisplayGroups.some(group => group.labelKey
      || (group.options || []).some(option => option.labelKey || option.dKey));
    let translatedLocale;
    let translatedGroups;
    let translatedOptions;

    return ({
    open: false,
    positioned: false,
    _openUp: false,
    value: initialValue,
    activeIndex: -1,
    get active() { return this.activeIndex; },
    set active(index) { this.activeIndex = index; },
    search: '',
    searchTime: 0,
    position: '',
    _lastScrolledActiveIndex: -1,
    _listboxId: `anima-select-listbox-${++nextListboxId}`,
    _positionFrame: null,
    _closeAnimation: null,
    _reopenAnimation: null,
    _rootElement: null,
    // Declare instance-owned handlers: Alpine otherwise assigns new keys to
    // the outer scope, letting sibling selects overwrite each other's handlers.
    _scrollHandler: null,
    _resizeHandler: null,
    _keyHandler: null,

    get displayGroups() {
      if (!fieldConfigFactory) {
        if (!localized) return staticDisplayGroups;
        // Track the owning app's locale, translating once per change. Reuse
        // the component, selection and option values without emitting edits.
        const locale = `${this.locale}:${this.localeRevision || 0}`;
        if (!translatedGroups || translatedLocale !== locale) {
          translatedLocale = locale;
          translatedGroups = staticDisplayGroups.map(group => ({
            ...group,
            label: group.labelKey ? this.t(group.labelKey, group.label) : group.label,
            options: (group.options || []).map(option => ({
              ...option,
              l: option.labelKey ? this.t(option.labelKey, option.l) : option.l,
              d: option.dKey ? this.t(option.dKey, option.d) : option.d,
            })),
          }));
          translatedOptions = translatedGroups.flatMap(group => group.options);
        }
        return translatedGroups;
      }
      try { return normalizedGroups(fieldConfigFactory.call(this) || {}); }
      catch (_) { return []; }
    },

    get flatOptions() {
      if (!fieldConfigFactory) {
        if (!localized) return staticFlatOptions;
        void this.displayGroups;
        return translatedOptions;
      }
      return this.displayGroups.flatMap(group => group.options || []);
    },

    get hasDescriptions() {
      return this.flatOptions.some(opt => opt.d);
    },

    get selectedLabel() {
      const opt = this.flatOptions.find(o => o.v === this.value);
      return opt ? opt.l : String(this.value || '');
    },
    get selected() {
      return this.options?.find(option => String(option.value) === String(this.value)) || this.options?.[0];
    },

    init() {
      this._rootElement = this.$el;
      this.$watch('open', (isOpen) => {
        const trigger = this._rootElement.querySelector(triggerSelector);
        if (trigger) trigger.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) {
          this.positioned = false;
          this._lastScrolledActiveIndex = -1;
          window.addEventListener('scroll', this._scrollHandler, true);
          window.addEventListener('resize', this._resizeHandler);
          this.$nextTick(() => { if (this.open) this.positionMenu(); });
        } else {
          trigger?.removeAttribute('aria-activedescendant');
          window.AnimaUI?.unregisterPopup(this._rootElement);
          window.removeEventListener('scroll', this._scrollHandler, true);
          window.removeEventListener('resize', this._resizeHandler);
        }
      });
      const trigger = this.$el.querySelector(triggerSelector);
      if (trigger) {
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        if (preview) trigger.setAttribute('aria-controls', this._listboxId);
      }
      if (preview) this.$nextTick(() => {
        const menu = this.$el.querySelector(menuSelector);
        if (menu) menu.id = this._listboxId;
      });
      this._keyHandler = e => this.onKeydown(e);
      this.$el.addEventListener('keydown', this._keyHandler);

      // fixed 菜单在页面或面板滚动时按帧重定位；菜单自身滚动无需重算。
      this._scrollHandler = (e) => {
        if (!this.open) return;
        const target = e.target;
        if (target && typeof target.closest === 'function' && target.closest(menuSelector)) return;
        this.schedulePositionMenu();
      };
      this._resizeHandler = () => { if (this.open) this.schedulePositionMenu(); };

      // Sync display when the hidden input value is changed externally
      // (e.g. by autoValue, config import, undo, reset, or any programmatic form update).
      // Alpine x-model sets el.value directly on the DOM property, so we intercept
      // the native setter to keep this.value in sync.
      const input = preview ? null : this.$refs.modelInput;
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
      const root = this._rootElement || this.$el;
      window.AnimaUI?.unregisterPopup(root);
      if (this._closeAnimation) this._closeAnimation.cancel();
      if (this._reopenAnimation) this._reopenAnimation.cancel();
      if (this._keyHandler) {
        root.removeEventListener('keydown', this._keyHandler);
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

    close() {
      if (!this.open || this._closeAnimation) return;
      if (preview) { this.open = false; return; }
      const root = this._rootElement || this.$el;
      const menu = root.querySelector(menuSelector);
      const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!motion || !menu || !menu.animate) { this.open = false; return; }
      // Keep x-if mounted until exit finishes. Inert prevents duplicate selections.
      const style = getComputedStyle(menu);
      const from = { opacity: style.opacity, transform: style.transform };
      if (this._reopenAnimation) { this._reopenAnimation.cancel(); this._reopenAnimation = null; }
      menu.inert = true;
      root.querySelector(triggerSelector)?.setAttribute('aria-expanded', 'false');
      const animation = menu.animate([
        from,
        { opacity: 0, transform: `scale(${style.getPropertyValue('--menu-scale-exit').trim() || '.99'})` }
      ], { duration: parseFloat(style.getPropertyValue('--duration-menu-exit')) || 150,
        easing: style.getPropertyValue('--ease-out').trim() || 'ease-out', fill: 'forwards' });
      this._closeAnimation = animation;
      animation.onfinish = () => {
        this.open = false;
        this._closeAnimation = null;
      };
    },

    dismiss() {
      if (this._closeAnimation) {
        this._closeAnimation.onfinish = null;
        this._closeAnimation.cancel();
        this._closeAnimation = null;
      }
      if (this._reopenAnimation) { this._reopenAnimation.cancel(); this._reopenAnimation = null; }
      this.open = false;
    },

    _enabledIndices(options = this.flatOptions) {
      return options.map((option, index) =>
        option.disabled || option.enabled === false ? -1 : index).filter(index => index >= 0);
    },

    _syncOptionA11y(scroll = true) {
      const root = this._rootElement || this.$el;
      const trigger = root.querySelector(triggerSelector);
      const menu = root.querySelector(menuSelector);
      if (!trigger || !menu) return;
      menu.id = this._listboxId;
      menu.setAttribute('role', 'listbox');
      trigger.setAttribute('aria-controls', this._listboxId);
      const options = menu.querySelectorAll(optionSelector);
      const flatOptions = this.flatOptions;
      options.forEach((element, index) => {
        const option = flatOptions[index];
        element.id = `${this._listboxId}-option-${index}`;
        element.setAttribute('role', 'option');
        element.setAttribute('aria-selected', String(!!option && String(option.v) === String(this.value)));
        element.setAttribute('aria-disabled', String(!!option && (option.disabled || option.enabled === false)));
        element.classList.toggle('kb-active', index === this.activeIndex);
        if (preview) element.classList.toggle('is-active', index === this.activeIndex);
      });
      if (this.activeIndex >= 0 && options[this.activeIndex]) {
        trigger.setAttribute('aria-activedescendant', options[this.activeIndex].id);
        if (scroll && this._lastScrolledActiveIndex !== this.activeIndex) {
          const scroller = preview ? menu : menu.querySelector('.anima-select-menu-scroll');
          const optionRect = options[this.activeIndex].getBoundingClientRect();
          const scrollRect = scroller.getBoundingClientRect();
          // Only scroll the options, never the page or the containing panel.
          if (optionRect.top < scrollRect.top) scroller.scrollTop += optionRect.top - scrollRect.top;
          else if (optionRect.bottom > scrollRect.bottom) scroller.scrollTop += optionRect.bottom - scrollRect.bottom;
          this._lastScrolledActiveIndex = this.activeIndex;
        }
      } else {
        trigger.removeAttribute('aria-activedescendant');
        this._lastScrolledActiveIndex = -1;
      }
    },

    show(key) {
      const options = this.flatOptions;
      const enabled = this._enabledIndices(options);
      if (!enabled.length && !preview) return;
      const root = this._rootElement || this.$el;
      window.AnimaUI?.settleDialog(root);
      window.AnimaUI?.registerPopup(root, () => this.dismiss());
      if (this._closeAnimation) {
        const menu = root.querySelector(menuSelector);
        const style = menu && getComputedStyle(menu);
        const from = style && { opacity: style.opacity, transform: style.transform };
        this._closeAnimation.onfinish = null;
        this._closeAnimation.cancel();
        this._closeAnimation = null;
        if (menu) {
          menu.inert = false;
          if (from && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            this._reopenAnimation = menu.animate([from, { opacity: 1, transform: 'scale(1)' }], {
              duration: parseFloat(style.getPropertyValue('--duration-menu-enter')) || 250,
              easing: style.getPropertyValue('--ease-out').trim() || 'ease-out',
            });
          }
        }
        root.querySelector(triggerSelector)?.setAttribute('aria-expanded', 'true');
      }
      const selected = enabled.find(index => String(options[index].v) === String(this.value));
      if (preview) this.activeIndex = selected === undefined ? (enabled[0] ?? -1) : selected;
      else if (key === 'Home') this.activeIndex = enabled[0];
      else if (key === 'End') this.activeIndex = enabled[enabled.length - 1];
      else this.activeIndex = selected === undefined
        ? (key === 'ArrowUp' ? enabled[enabled.length - 1] : enabled[0]) : selected;
      this.open = true;
      this.$nextTick(() => { if (this.open) this._syncOptionA11y(); });
    },

    onKeydown(event) {
      if (!event.target.closest(triggerSelector) || event.target.disabled) return;
      const key = event.key;
      if (preview && key.length === 1 && key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (!this.open) this.show();
        this.search = Date.now() - this.searchTime > 700 ? key : this.search + key;
        this.searchTime = Date.now();
        const search = this.search.toLowerCase();
        const index = this.flatOptions.findIndex(option => `${option.family || ''} ${option.l}`.toLowerCase().includes(search));
        if (index >= 0) { this.activeIndex = index; this.$nextTick(() => this._syncOptionA11y()); }
        return;
      }
      if (this._closeAnimation && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
        event.preventDefault(); this.show(key); return;
      }
      if (key === 'Escape') {
        if (this.open && !this._closeAnimation) {
          event.preventDefault();
          event.stopPropagation();
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
        this.show(key);
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
        this.activeIndex = preview ? enabled[Math.max(0, Math.min(enabled.length - 1, current + direction))]
          : enabled[(current + direction + enabled.length) % enabled.length];
      }
      this._syncOptionA11y();
    },

    select(v) {
      const selectedOption = this.flatOptions.find(option => String(option.v) === String(v));
      if (selectedOption && (selectedOption.disabled || selectedOption.enabled === false)) return;
      this.value = v;
      this.activeIndex = this.flatOptions.findIndex(option => String(option.v) === String(v));
      this.close();
      if (!preview) this.syncToModel();
      if (preview) {
        (this._rootElement || this.$el).querySelector(triggerSelector)?.focus();
        this.$dispatch('preview-select', v);
      } else this.$dispatch('anima-select-change', { value: v });
    },

    choose(index) { const option = this.flatOptions[index]; if (option) this.select(option.v); },
    reveal() { this.$nextTick(() => { if (this.open) this._syncOptionA11y(); }); },
    key(event) { this.onKeydown(event); },

    syncToModel() {
      const input = this.$refs.modelInput;
      if (input) {
        input.value = this.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    },

    toggle() {
      if (this.open && !this._closeAnimation) this.close();
      else this.show();
    },

    schedulePositionMenu() {
      if (this._positionFrame !== null) return;
      this._positionFrame = requestAnimationFrame(() => {
        this._positionFrame = null;
        if (this.open) this.positionMenu();
      });
    },

    _triggerVisible(trigger, rect) {
      let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight;
      for (let parent = trigger.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clipX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
        const clipY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        if (!clipX && !clipY) continue;
        const bounds = parent.getBoundingClientRect();
        if (clipX) {
          left = Math.max(left, bounds.left + parent.clientLeft);
          right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
        }
        if (clipY) {
          top = Math.max(top, bounds.top + parent.clientTop);
          bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
        }
      }
      return rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom;
    },

    // 根据触发器的位置选择方向和可用高度，避免菜单覆盖触发器。
    positionMenu() {
      const root = this._rootElement || this.$el;
      const trigger = root.querySelector(triggerSelector);
      const menu = root.querySelector(menuSelector);
      if (!trigger || !menu) return;
      const firstPosition = !this.positioned;
      const r = trigger.getBoundingClientRect();
      if (!this._triggerVisible(trigger, r)) {
        this.dismiss();
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 带说明的选项需要更宽的阅读区域；窄屏下仍由视口宽度兜底。
      const width = preview ? Math.min(r.width, vw - 16) : Math.min(Math.max(r.width, this.hasDescriptions ? 320 : 200), vw - 16);
      menu.style.width = Math.round(width) + 'px';
      const menuScroll = preview ? menu : menu.querySelector('.anima-select-menu-scroll');
      const maxScrollHeight = preview ? 360 : 520;
      const desiredHeight = Math.min(menuScroll ? menuScroll.scrollHeight : menu.scrollHeight, maxScrollHeight) + 2;
      const spaceBelow = Math.max(0, vh - r.bottom - 12);
      const spaceAbove = Math.max(0, r.top - 12);
      this._openUp = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const availableHeight = this._openUp ? spaceAbove : spaceBelow;
      const scrollMaxHeight = `${Math.max(0, Math.min(maxScrollHeight, availableHeight - 2))}px`;
      const heightLimitChanged = menuScroll && menuScroll.style.maxHeight !== scrollMaxHeight;
      if (heightLimitChanged) menuScroll.style.maxHeight = scrollMaxHeight;
      const openUp = this._openUp;
      // 对齐方向由调用方配置，空间不足时统一避让视口边缘。
      let left = align === 'right' ? r.right - width : r.left;
      if (left + width > vw - 8) left = vw - width - 8;
      if (left < 8) left = 8;
      menu.style.position = 'fixed';
      menu.style.top = openUp ? 'auto' : `${r.bottom + 4}px`;
      menu.style.bottom = openUp ? `${vh - r.top + 4}px` : 'auto';
      menu.style.left = Math.round(left) + 'px';
      menu.style.right = 'auto';
      menu.style.transformOrigin = `${left < r.left ? 'right' : 'left'} ${openUp ? 'bottom' : 'top'}`;
      // 重定位时保留用户在菜单中的滚动位置；键盘导航仍会自行滚动到活动项。
      if (firstPosition) this._syncOptionA11y();
      this.positioned = true;
    },

    });
  };
  Alpine.data('animaSelect', createAnimaSelect);
  Alpine.data('previewSelect', (options, value) => {
    const component = createAnimaSelect(function() {
      return {options: this.options.map(option => ({...option, v: option.value, l: option.label, d: option.detail}))};
    }, value, {preview: true});
    component.options = options;
    return component;
  });
});

// Preview menus keep their compact presentation and event contract while using
// the same selection, keyboard and positioning implementation as other selects.
window.previewSelectHtml = function(options, value, label, triggerId = '', valueBinding = '', optionsBinding = '') {
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const initialValue = valueBinding ? esc(valueBinding) : esc(JSON.stringify(value));
  const initialOptions = optionsBinding ? esc(optionsBinding) : esc(JSON.stringify(options));
  const watchers = [];
  if (valueBinding) watchers.push(`$watch('${esc(valueBinding)}', next => value = next)`);
  if (optionsBinding) watchers.push(`$watch('${esc(optionsBinding)}', next => options = next)`);
  const sync = watchers.length ? ` x-init="${watchers.join('; ')}"` : '';
  return `<div class="preview-select" x-data="previewSelect(${initialOptions}, ${initialValue})"${sync} @click.outside="open = false" @resize.window="open = false">
    <button type="button" class="preview-select-trigger" ${triggerId ? `id="${esc(triggerId)}"` : ''} x-ref="trigger" role="combobox" aria-haspopup="listbox" aria-label="${esc(label)}" :aria-expanded="open" @click="open ? open = false : show()">
      <span><span x-text="selected?.selectedLabel || selected?.label || ''"></span><span class="preview-select-count" x-show="selected?.count != null" x-text="' (' + selected?.count + ')'"></span></span><span class="preview-select-chevron" aria-hidden="true"></span>
    </button>
    <div class="preview-select-menu" role="listbox" x-ref="menu" aria-label="${esc(label)}" x-show="open" x-cloak :inert="!open">
      <template x-for="(option, index) in options" :key="option.value">
        <div>
          <div class="preview-select-group" x-show="option.family && (index === 0 || options[index - 1].family !== option.family)" x-text="option.family"></div>
          <div class="preview-select-option" role="option" :data-index="index" :aria-selected="option.value === value" :class="{'is-active': index === active}" @mousemove="if (active !== index) { active = index; $nextTick(() => { if (open) _syncOptionA11y(false) }) }" @mousedown.prevent @click="choose(index)">
            <span><span x-text="option.label"></span><span class="preview-select-count" x-show="option.count != null" x-text="' (' + option.count + ')'"></span></span><small x-show="option.detail" x-text="option.detail"></small><span class="preview-select-check" x-show="option.value === value" aria-hidden="true">✓</span>
          </div>
        </div>
      </template>
    </div>
  </div>`;
};
