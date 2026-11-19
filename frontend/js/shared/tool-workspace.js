document.addEventListener('alpine:init', () => {
  Alpine.directive('workspace-part', (element, { expression }) => {
    const fragment = document.getElementById(`tool-part-${expression}`).content.cloneNode(true);
    if (element instanceof HTMLTemplateElement) {
      element.content.append(fragment);
      return;
    }
    const children = Array.from(fragment.children);
    Alpine.mutateDom(() => {
      element.append(fragment);
      for (const child of children) Alpine.initTree(child);
    });
  }).before('bind');

  Alpine.data('toolWorkspaceTabs', (selection, items, disabled = () => false) => ({
    get toolTabs() { return items(); },
    get activeToolTab() { return selection(); },
    get toolTabsDisabled() { return disabled(); },
    init() {
      this.layoutObserver = new ResizeObserver(() => this.syncToolTabIndicator());
      this.layoutObserver.observe(this.$el);
    },
    destroy() { this.layoutObserver.disconnect(); },
    layoutObserver: null,
    syncToolTabIndicator(bar = this.$el) {
      const indicator = bar.querySelector('.monitor-tab-indicator');
      const active = bar.querySelector('[aria-selected="true"]');
      if (!indicator || !active?.offsetWidth) return;
      const first = !bar.classList.contains('indicator-ready');
      if (first) bar.classList.add('no-anim');
      indicator.style.width = active.offsetWidth + 'px';
      indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      if (first) {
        void indicator.offsetWidth;
        bar.classList.remove('no-anim');
        bar.classList.add('indicator-ready');
      }
    },
    moveToolTab(event) {
      const buttons = Array.from(event.currentTarget.querySelectorAll('button[role="tab"]:enabled'));
      const current = buttons.indexOf(event.target);
      if (current < 0) return;
      const last = buttons.length - 1;
      const next = {
        ArrowRight: (current + 1) % buttons.length,
        ArrowLeft: (current + last) % buttons.length,
        Home: 0,
        End: last,
      }[event.key];
      if (!Number.isInteger(next)) return;
      event.preventDefault();
      buttons[next].focus();
      if (next !== current) buttons[next].click();
    },
  }));

  Alpine.data('toolTaskLog', (view, toggle, copy = null) => {
    let lastTask;
    let follow = true;
    return {
      get taskLog() { return view(); },
      toggleTaskLog: () => toggle(),
      copyTaskLog: copy,
      updateLogFollow(element) {
        follow = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      },
      syncLogPosition(element, taskKey) {
        if (lastTask !== taskKey) follow = true;
        lastTask = taskKey;
        this.$nextTick(() => {
          if (follow && element.clientHeight) element.scrollTop = element.scrollHeight;
        });
      },
    };
  });
});
