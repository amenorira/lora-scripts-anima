/* Training section collapse, navigation and scroll tracking.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingSections = {
  // 分组折叠状态，响应式驱动 UI
  _sectionCollapsed: {},
  // 分组导航指示器（#1）：当前可见分组列表 + 滚动高亮的当前分组
  sectionNavList: [],
  activeSection: '',
  sectionNavOpen: false,
  sectionRailTop: 16,
  _sectionScrollHandler: null,

  get activeSectionIndex() {
    const idx = this.sectionNavList.findIndex(s => s.key === this.activeSection);
    return idx < 0 ? 0 : idx;
  },

  get activeSectionMeta() {
    return this.sectionNavList[this.activeSectionIndex] || null;
  },

  get activeSectionNumberText() {
    const total = this.sectionNavList.length;
    if (!total) return '';
    return String(this.activeSectionIndex + 1) + '/' + String(total);
  },
  // ── Section collapse state ──
  _initCollapseState(sections) {
    if (!this._sectionCollapsed) this._sectionCollapsed = {};
    sections.forEach(s => {
      if (this._sectionCollapsed[s.key] === undefined) {
        this._sectionCollapsed[s.key] = localStorage.getItem('anima-section-collapsed-' + s.key) === '1';
      }
    });
  },

  toggleSection(key) {
    const willCollapse = !this._sectionCollapsed[key];
    this._sectionCollapsed[key] = willCollapse;
    localStorage.setItem('anima-section-collapsed-' + key, willCollapse ? '1' : '0');
    // 同步导航指示器的折叠状态
    this.sectionNavList = this.sectionNavList.map(s => s.key === key ? { ...s, collapsed: willCollapse } : s);
    // 动画：测量 card-body 真实高度 → 锁定 → 过渡到 0/原高
    const card = document.querySelector(`#trainFormContent .card[data-section="${this.escapeAttr(key)}"]`);
    const body = card && card.querySelector('.card-body');
    if (body) this._animateCollapse(body, willCollapse);
  },

  // ── 统一的高度折叠动画（#3）──
  // 测量目标 scrollHeight → 起始高度 → 过渡到目标 → 清理 inline 样式。
  // 与 showConditionalFields 同一手法，避免 max-height:0!important/none 无法动画的问题。
  _animateCollapse(body, collapsing) {
    // 清理可能残留的过渡状态
    body.style.transition = 'none';
    body.style.maxHeight = '';
    body.style.opacity = '';
    const h = body.scrollHeight;
    body.style.overflow = 'hidden';
    body.style.maxHeight = collapsing ? h + 'px' : '0px';
    body.style.opacity = collapsing ? '1' : '0';
    void body.offsetHeight; // 强制 reflow
    body.style.transition = '';
    requestAnimationFrame(() => {
      body.style.maxHeight = collapsing ? '0px' : h + 'px';
      body.style.opacity = collapsing ? '0' : '1';
    });
    const cleanup = () => {
      body.style.maxHeight = '';
      body.style.opacity = '';
      body.style.transition = '';
      body.style.overflow = '';
      body.removeEventListener('transitionend', onEnd);
    };
    const onEnd = (e) => { if (e.propertyName === 'max-height') cleanup(); };
    body.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, 500);
  },

  // ── 分组导航指示器（#1）──
  // 构建可见分组列表（含颜色 + 标题），供右侧面板点击跳转与当前分组高亮。
  buildSectionNav() {
    const sections = this._allSections();
    const SECTION_COLORS = {
      model: 'var(--section-model)', network: 'var(--section-network)',
      training: 'var(--section-training)', optimizer: 'var(--section-optimizer)',
      regularization: 'var(--section-regularization)', performance: 'var(--section-performance)',
      save: 'var(--section-save)', caption: 'var(--section-caption)',
      preview: 'var(--section-preview)', misc: 'var(--section-caption)',
    };
    this.sectionNavList = sections.map(s => ({
      key: s.key,
      title: this.t(s.titleKey) || s.titleKey,
      color: SECTION_COLORS[s.key] || 'var(--section-caption)',
      collapsed: !!this._sectionCollapsed[s.key],
    }));
    // 默认激活第一个分组；训练类型重建后若旧分组不存在，回退到第一个
    if (this.sectionNavList.length && !this.sectionNavList.some(s => s.key === this.activeSection)) {
      this.activeSection = this.sectionNavList[0].key;
    }
    this.sectionNavOpen = false;
    this._bindSectionScroll();
    this.$nextTick(() => this.positionSectionRail());
  },

  // Position without transforming the text layer; snap to whole CSS pixels.
  positionSectionRail() {
    const rail = document.querySelector('.train-rail');
    if (!rail || !rail.offsetHeight) return;
    this.sectionRailTop = Math.max(16, Math.floor((window.innerHeight - rail.offsetHeight) / 2));
  },

  // 绑定主内容区滚动监听，更新当前可见分组（节流）
  _bindSectionScroll() {
    if (this._sectionScrollHandler) return; // 已绑定
    const self = this;
    let ticking = false;
    this._sectionScrollHandler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        self._updateActiveSection();
        ticking = false;
      });
    };
    const scroller = document.querySelector('.main-content');
    if (scroller) scroller.addEventListener('scroll', this._sectionScrollHandler, { passive: true });
    // 初次定位
    this._updateActiveSection();
  },

  // 离开训练页时解绑滚动监听，避免泄漏
  stopSectionScroll() {
    this.sectionNavOpen = false;
    if (this._sectionScrollHandler) {
      const scroller = document.querySelector('.main-content');
      if (scroller) scroller.removeEventListener('scroll', this._sectionScrollHandler);
      this._sectionScrollHandler = null;
    }
  },

  _updateActiveSection() {
    const scroller = document.querySelector('.main-content');
    if (!scroller) return;
    // 竖向导轨不占表单横向空间；分组标题越过顶部 24px 即视为当前。
    const offset = 24;
    const cards = document.querySelectorAll('#trainFormContent .card[data-section]');
    // A short final section cannot reach the top threshold once scrolling is
    // clamped at the end. Treat the scrollable form's bottom as that section.
    const scrollRange = scroller.scrollHeight - scroller.clientHeight;
    if (cards.length && scrollRange > 1 && scrollRange - scroller.scrollTop <= 2) {
      this.activeSection = cards[cards.length - 1].getAttribute('data-section');
      return;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    let current = '';
    cards.forEach(card => {
      const rect = card.getBoundingClientRect();
      // 标题顶部越过偏移线 → 该分组为当前；取最后一个满足条件的
      if (rect.top - scrollerTop <= offset) {
        current = card.getAttribute('data-section');
      }
    });
    if (!current && cards.length) current = cards[0].getAttribute('data-section');
    if (current && current !== this.activeSection) this.activeSection = current;
  },

  // 竖向导轨：鼠标离开关闭；键盘焦点由 focusout 单独处理
  sectionRailLeave() {
    const rail = document.querySelector('.train-rail');
    const focused = document.activeElement;
    if (rail && focused && rail.contains(focused) && focused.matches(':focus-visible')) return;
    this.sectionNavOpen = false;
  },

  sectionRailFocusOut(event) {
    if (event && event.currentTarget && event.currentTarget.contains(event.relatedTarget)) return;
    this.sectionNavOpen = false;
  },

  // 竖向导轨分段之间的键盘移动
  focusAdjacentSectionSegment(event, delta) {
    const track = event && event.currentTarget ? event.currentTarget.closest('.train-rail-track') : null;
    if (!track) return;
    const buttons = Array.from(track.querySelectorAll('.train-rail-segment'));
    if (!buttons.length) return;
    const current = buttons.indexOf(event.currentTarget);
    const next = buttons[(current + delta + buttons.length) % buttons.length];
    if (next) next.focus();
  },

  focusSectionSegmentEdge(event, edge) {
    const track = event && event.currentTarget ? event.currentTarget.closest('.train-rail-track') : null;
    if (!track) return;
    const buttons = Array.from(track.querySelectorAll('.train-rail-segment'));
    if (!buttons.length) return;
    const next = edge === 'last' ? buttons[buttons.length - 1] : buttons[0];
    if (next) next.focus();
  },

  // 点击导航项 → 平滑滚动到对应分组顶部
  scrollToSection(key) {
    const card = document.querySelector(`#trainFormContent .card[data-section="${this.escapeAttr(key)}"]`);
    const scroller = document.querySelector('.main-content');
    if (!card || !scroller) return;
    // 若分组已收起，先展开（否则跳过去看不到内容）
    if (this._sectionCollapsed[key]) this.toggleSection(key);
    const target = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16;
    const top = Math.min(Math.max(0, scroller.scrollHeight - scroller.clientHeight), Math.max(0, target));
    // A no-op scroll emits no event. Select directly only in that case;
    // otherwise the scroll observer owns highlighting throughout the motion.
    if (Math.abs(scroller.scrollTop - top) <= 1) {
      this.activeSection = key;
      return;
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
    if (reduceMotion) this.activeSection = key;
  },
};
