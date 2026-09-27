// Local menu state must not invalidate the surrounding x-html preview.
document.addEventListener('alpine:init', () => {
  Alpine.data('previewSelect', (options, value) => ({
    options, value, open: false, active: 0, position: '', search: '', searchTime: 0,
    _scrollHandler: null, _positionFrame: null, _openUp: false, _maxHeight: 0,
    init() {
      this._scrollHandler = event => {
        if (!this.open || this.$refs.menu.contains(event.target) || this._positionFrame !== null) return;
        this._positionFrame = requestAnimationFrame(() => {
          this._positionFrame = null;
          if (this.open) this.positionMenu();
        });
      };
      this.$watch('open', open => {
        if (open) window.addEventListener('scroll', this._scrollHandler, true);
        else window.removeEventListener('scroll', this._scrollHandler, true);
      });
    },
    destroy() {
      window.removeEventListener('scroll', this._scrollHandler, true);
      if (this._positionFrame !== null) cancelAnimationFrame(this._positionFrame);
    },
    get selected() { return this.options.find(option => option.value === this.value) || this.options[0]; },
    show() {
      this.positionMenu(true);
      this.active = Math.max(0, this.options.findIndex(option => option.value === this.value));
      this.open = true;
      this.reveal();
    },
    positionMenu(firstPosition = false) {
      const rect = this.$refs.trigger.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      if (firstPosition) {
        this._openUp = below < 200 && above > below;
        this._maxHeight = Math.max(0, Math.min(360, this._openUp ? above : below));
      }
      const upward = this._openUp;
      this.position = `left:${rect.left}px;width:${rect.width}px;max-height:${this._maxHeight}px;`
        + `transform-origin:left ${upward ? 'bottom' : 'top'};`
        + (upward ? `bottom:${window.innerHeight - rect.top + 4}px` : `top:${rect.bottom + 4}px`);
    },
    reveal() {
      this.$nextTick(() => {
        const menu = this.$refs.menu;
        const option = menu.querySelector(`[data-index="${this.active}"]`);
        if (!this.open || !option) return;
        const optionRect = option.getBoundingClientRect(), menuRect = menu.getBoundingClientRect();
        if (optionRect.top < menuRect.top) menu.scrollTop += optionRect.top - menuRect.top;
        else if (optionRect.bottom > menuRect.bottom) menu.scrollTop += optionRect.bottom - menuRect.bottom;
      });
    },
    choose(index) {
      this.value = this.options[index].value;
      this.open = false;
      this.$refs.trigger.focus();
      this.$dispatch('preview-select', this.value);
    },
    key(event) {
      if (event.key === 'Escape' && this.open) {
        event.preventDefault(); event.stopPropagation(); this.open = false; return;
      }
      if (event.key === 'Tab') { this.open = false; return; }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!this.open) { this.show(); return; }
        this.active = event.key === 'Home' ? 0 : event.key === 'End' ? this.options.length - 1
          : Math.max(0, Math.min(this.options.length - 1, this.active + (event.key === 'ArrowDown' ? 1 : -1)));
        this.reveal();
      } else if (['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        if (this.open) this.choose(this.active); else this.show();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (!this.open) this.show();
        this.search = Date.now() - this.searchTime > 700 ? event.key : this.search + event.key;
        this.searchTime = Date.now();
        const index = this.options.findIndex(option => `${option.family || ''} ${option.label}`.toLowerCase().includes(this.search.toLowerCase()));
        if (index >= 0) { this.active = index; this.reveal(); }
      }
    },
  }));
});

window.previewSelectHtml = function(options, value, label) {
  const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `<div class="preview-select" x-data="previewSelect(${esc(JSON.stringify(options))}, ${esc(JSON.stringify(value))})" x-id="['preview-list', 'preview-option']" @keydown="key($event)" @click.outside="open = false" @resize.window="open = false">
    <button type="button" class="preview-select-trigger" x-ref="trigger" role="combobox" aria-haspopup="listbox" aria-label="${esc(label)}" :aria-expanded="open" :aria-controls="$id('preview-list')" :aria-activedescendant="open ? $id('preview-option', active) : null" @click="open ? open = false : show()">
      <span x-text="selected?.selectedLabel || selected?.label || ''"></span><span class="preview-select-chevron" aria-hidden="true"></span>
    </button>
    <div class="preview-select-menu" role="listbox" x-ref="menu" :id="$id('preview-list')" aria-label="${esc(label)}" x-show="open" x-cloak :style="position" :inert="!open">
      <template x-for="(option, index) in options" :key="option.value">
        <div>
          <div class="preview-select-group" x-show="option.family && (index === 0 || options[index - 1].family !== option.family)" x-text="option.family"></div>
          <div class="preview-select-option" role="option" :id="$id('preview-option', index)" :data-index="index" :aria-selected="option.value === value" :class="{'is-active': index === active}" @mousemove="active = index" @mousedown.prevent @click="choose(index)">
            <span x-text="option.label"></span><small x-show="option.detail" x-text="option.detail"></small><span class="preview-select-check" x-show="option.value === value" aria-hidden="true">✓</span>
          </div>
        </div>
      </template>
    </div>
  </div>`;
};
