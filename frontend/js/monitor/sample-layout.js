/* One workspace determines card size; opening the preview changes only columns. */
(() => {
  function calculate(width, inset = 20, gap = 12, sidebarGap = 8) {
    if (!Number.isFinite(width) || width <= 0) return null;
    inset = Math.max(0, Math.min(Number(inset) || 0, Math.max(0, width - 1)));
    gap = Math.max(0, Number(gap) || 0);
    sidebarGap = Math.max(0, Math.min(Number(sidebarGap) || 0, width));
    const available = width - inset;
    const columns = Math.max(1, Math.round((available + gap) / (180 + gap)));
    const cardWidth = (available - (columns - 1) * gap) / columns;
    const targetSidebar = Math.max(320, Math.min(640, width * 0.4));
    const countForSidebar = size => (width - sidebarGap - size - inset + gap) / (cardWidth + gap);
    const maximum = Math.max(1, Math.min(columns - 1, Math.floor(countForSidebar(320))));
    const minimum = Math.min(maximum, Math.max(1, Math.ceil(countForSidebar(640))));
    const sidebarColumns = Math.max(minimum, Math.min(maximum, Math.round(countForSidebar(targetSidebar))));
    const gridWidth = Math.max(0, Math.min(width - sidebarGap, inset + sidebarColumns * cardWidth + (sidebarColumns - 1) * gap));
    return {columns, cardWidth, sidebarColumns, gridWidth, sidebarWidth: width - sidebarGap - gridWidth};
  }

  function findAnchorItem(grid, anchor) {
    const group = anchor.batchId ? Array.from(grid.querySelectorAll('.m-sample-batch')).find(item => item.dataset.batchId === anchor.batchId) : null;
    return Array.from((group || grid).querySelectorAll('.preview-grid-item')).find(item => anchor.key && item.dataset.previewPath === anchor.key)
      || group?.querySelector('.preview-grid-item');
  }

  function captureAnchor(grid, preferred, remembered) {
    if (!grid?.getBoundingClientRect) return null;
    const bounds = grid.getBoundingClientRect();
    const visible = item => {
      const rect = item?.getBoundingClientRect?.();
      return rect && rect.bottom > bounds.top && rect.top < bounds.bottom;
    };
    const retained = remembered && Math.abs(grid.scrollTop - remembered.scrollTop) < 1 ? findAnchorItem(grid, remembered) : null;
    const item = retained && visible(retained) ? retained : preferred && grid.contains(preferred) && visible(preferred) ? preferred
      : Array.from(grid.querySelectorAll('.m-sample-tile .preview-grid-item')).find(visible);
    if (!item) return null;
    return {key: item.dataset.previewPath || '', batchId: item.closest('.m-sample-batch')?.dataset.batchId || '',
      offset: item.getBoundingClientRect().top - bounds.top};
  }

  function restoreAnchor(grid, anchor) {
    if (!grid || !anchor) return null;
    const item = findAnchorItem(grid, anchor);
    if (!item) return null;
    grid.scrollTop += item.getBoundingClientRect().top - grid.getBoundingClientRect().top - anchor.offset;
    return {...anchor, offset: item.getBoundingClientRect().top - grid.getBoundingClientRect().top, scrollTop: grid.scrollTop};
  }

  function update(workspace, {getAnchor, setAnchor} = {}) {
    const grid = workspace?.querySelector?.('.preview-grid');
    if (!grid) return;
    const style = window.getComputedStyle(workspace), gridStyle = window.getComputedStyle(grid);
    const width = parseFloat(style.width) || workspace.clientWidth;
    const inset = (parseFloat(gridStyle.paddingLeft) || 0) + (parseFloat(gridStyle.paddingRight) || 0)
      + Math.max(0, grid.offsetWidth - grid.clientWidth);
    const gap = parseFloat(gridStyle.columnGap) || 0, sidebarGap = parseFloat(style.getPropertyValue('--sample-sidebar-gap')) || 0;
    const signature = [width, inset, gap, sidebarGap].join(':');
    if (workspace._sampleLayoutSignature === signature) return;
    const layout = calculate(width, inset, gap, sidebarGap);
    if (!layout) return;
    // Resizes and sidebar toggles retain the same semantic card until the
    // shared scroll/selection handlers release it, even across column changes.
    const anchor = workspace._sampleLayoutSignature ? captureAnchor(grid, null, getAnchor?.()) : null;
    workspace._sampleLayoutSignature = signature;
    workspace.style.setProperty('--sample-columns', layout.columns);
    workspace.style.setProperty('--sample-card-width', layout.cardWidth + 'px');
    workspace.style.setProperty('--sample-sidebar-columns', layout.sidebarColumns);
    workspace.style.setProperty('--sample-grid-width', layout.gridWidth + 'px');
    if (anchor) {
      const restored = restoreAnchor(grid, anchor);
      setAnchor?.(restored);
    }
  }

  function create({getAnchor, setAnchor, cleanup} = {}) {
    let observer, active = false;
    const anchors = {getAnchor, setAnchor};
    return {
      init() {
        const workspace = this.$el;
        active = true;
        update(workspace, anchors);
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => { if (active && workspace.isConnected) update(workspace, anchors); });
          observer.observe(workspace);
        }
      },
      destroy() {
        if (!active) return;
        active = false; observer?.disconnect(); observer = null;
        cleanup?.();
      },
    };
  }

  window.AnimaSampleLayout = {calculate, captureAnchor, restoreAnchor, update, create};
})();
