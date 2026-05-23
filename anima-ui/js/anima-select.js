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
        const json = typeof fieldConfigJson === 'string'
          ? decodeURIComponent(escape(atob(fieldConfigJson)))
          : JSON.stringify(fieldConfigJson || {});
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
      document.addEventListener('keydown', this._escHandler);
    },

    destroy() {
      if (this._escHandler) {
        document.removeEventListener('keydown', this._escHandler);
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
      }
    },

  }));
});
