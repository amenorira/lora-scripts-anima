/* The crop grid keeps layout offsets for all rows and renders a small window. */
const cropPreviewGrids = new WeakMap();

function getCropPreviewGrid() {
  return cropPreviewGrids.get(document.getElementById('cropPreviewScroll'));
}

function buildCropGridLayout(view, columns, gaps) {
  const rows = [];
  const byKey = new Map();
  const byImage = new Map();
  const add = row => {
    row.index = rows.length;
    rows.push(row);
    byKey.set(row.key, row);
    return row;
  };
  let start = 0;
  for (const folder of view.folders) {
    add({ key: folder.key, folder, gap: start ? gaps.folder : 0, height: 18, items: [] });
    for (let index = start; index < folder.end; index += columns) {
      const items = view.items.slice(index, Math.min(index + columns, folder.end));
      const row = add({
        key: `${columns}:${items[0].id}`, items, gap: index === start ? gaps.heading : gaps.row,
        // Estimates are only used until a row has been measured at this width.
        height: items.some(item => !item.error) ? 262.5 : 220,
      });
      for (const item of items) byImage.set(item.id, row);
    }
    start = folder.end;
  }
  return { columns, rows, byKey, byImage };
}

function cropGridRowAt(rows, y) {
  let low = 0, high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].top + rows[mid].height <= y) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, rows.length - 1);
}

document.addEventListener('alpine:init', () => {
  Alpine.data('cropPreviewGrid', () => {
    let scroller, canvas, state, observer;
    let view, layout, detailId, revealRequest;
    let frame = null;
    let windowKey = '';

    const activeTile = () => {
      const node = document.activeElement;
      return node?.matches('.cp-tile') && scroller.contains(node) ? node : null;
    };
    const top = () => scroller.scrollTop - canvas.offsetTop;
    const rowAt = y => layout.rows[cropGridRowAt(layout.rows, y)];

    function renderWindow() {
      if (!layout) {
        state.cropGridRows = [];
        return;
      }
      const height = scroller.clientHeight;
      const scroll = top();
      const overscan = height / 2;
      const first = cropGridRowAt(layout.rows, scroll - overscan);
      const last = cropGridRowAt(layout.rows, scroll + height + overscan);
      const focus = layout.byImage.get(activeTile()?.dataset.cropImage);
      const detail = layout.byImage.get(detailId);
      const reveal = layout.byImage.get(revealRequest?.id);
      // Keep focused tiles, morph origins and in-flight reveals independent of the window.
      const pins = [...new Set([focus, detail, reveal].filter(row => row && (row.index < first || row.index > last)))];
      const key = `${first}:${last}:${pins.map(row => row.index).join(',')}`;
      if (key === windowKey) return;
      windowKey = key;
      const rows = layout.rows.slice(first, last + 1);
      if (pins.length) {
        rows.push(...pins);
        rows.sort((a, b) => a.index - b.index);
      }
      state.cropGridRows = rows.map(({ key, folder, items, top }) => ({ key, folder, items, top }));
    }

    function updateOffsets() {
      let end = 0;
      for (const row of layout.rows) {
        row.top = end + row.gap;
        end = row.top + row.height;
      }
      canvas.style.height = `${end}px`;
      windowKey = '';
    }

    function rebuild(resetScroll) {
      const style = getComputedStyle(canvas);
      const width = parseFloat(style.width);
      if (!width) return;
      const px = name => parseFloat(style.getPropertyValue(name));
      const gap = px('--cp-grid-gap');
      const nextColumns = Math.max(1, Math.floor((width + gap) / (px('--cp-column-min') + gap)));
      if (!resetScroll && nextColumns === layout?.columns) return;

      const anchor = resetScroll || !layout ? null : rowAt(top());
      const scroll = anchor && scroller.scrollTop;
      const focused = resetScroll ? null : activeTile();
      const focusedId = focused?.dataset.cropImage;
      const previousRows = layout?.byKey;
      layout = buildCropGridLayout(view, nextColumns, { row: gap, folder: px('--cp-folder-gap'), heading: px('--cp-heading-gap') });
      // Keyed rows may keep their DOM node and emit no resize notification.
      for (const row of layout.rows) row.height = previousRows?.get(row.key)?.height ?? row.height;
      canvas.style.setProperty('--cp-columns', nextColumns);
      updateOffsets();
      if (resetScroll) scroller.scrollTop = 0;
      else if (anchor) {
        const replacement = layout.byImage.get(anchor.items[0]?.id) || layout.byKey.get(anchor.key);
        if (replacement) scroller.scrollTop = scroll + replacement.top - anchor.top;
      }
      if (revealRequest) scrollToRow(layout.byImage.get(revealRequest.id));
      renderWindow();
      if (focused) Alpine.nextTick(() => {
        if (!focused.isConnected && document.activeElement === document.body) {
          document.getElementById(`crop-image-${focusedId}`)?.focus({ preventScroll: true });
        }
      });
    }

    function scrollToRow(row) {
      if (!row) return;
      const start = top();
      const height = scroller.clientHeight;
      if (row.top < start || row.height > height) scroller.scrollTop = canvas.offsetTop + row.top;
      else if (row.top + row.height > start + height) {
        scroller.scrollTop = canvas.offsetTop + row.top + row.height - height;
      }
    }

    async function reveal(id) {
      const row = layout?.byImage.get(id);
      if (!row) return null;
      const request = { id };
      revealRequest = request;
      scrollToRow(row);
      renderWindow();
      await Alpine.nextTick();
      if (revealRequest !== request) return null;
      revealRequest = null;
      scrollToRow(layout.byImage.get(id));
      return document.getElementById(`crop-image-${id}`);
    }

    function returnTo(id) {
      const tile = document.getElementById(`crop-image-${id}`);
      if (!tile) return reveal(id);
      const thumbnail = tile.querySelector('[data-dialog-anchor]');
      const { top, bottom } = thumbnail.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      // A clipped but visible thumbnail is already a valid morph origin.
      if (bottom <= viewport.top || top >= viewport.bottom) {
        thumbnail.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      }
    }

    function resize(entries) {
      if (!view?.items.length) return;
      if (entries.some(entry => entry.target === scroller)) rebuild(false);
      if (!layout) return;
      const anchor = rowAt(top());
      const oldTop = anchor.top;
      let changed = false;
      for (const entry of entries) {
        const row = layout.byKey.get(entry.target.dataset.cropGridRow);
        const height = entry.contentRect.height;
        if (!row || !height || row.height === height) continue;
        row.height = height;
        changed = true;
      }
      if (changed) {
        const scroll = scroller.scrollTop;
        updateOffsets();
        scroller.scrollTop = scroll + anchor.top - oldTop;
        if (revealRequest) scrollToRow(layout.byImage.get(revealRequest.id));
      }
      renderWindow();
    }

    return {
      cropGridRows: [],
      init() {
        state = this;
        scroller = this.$el;
        canvas = scroller.querySelector('.cp-virtual-grid');
        observer = new ResizeObserver(resize);
        observer.observe(scroller);
        cropPreviewGrids.set(scroller, {
          observe: node => observer.observe(node),
          unobserve: node => observer.unobserve(node),
          reveal,
          returnTo,
        });
      },
      destroy() {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
        cropPreviewGrids.delete(scroller);
      },
      setCropGridView(nextView, nextDetailId) {
        detailId = nextDetailId;
        if (view === nextView) {
          this.scheduleCropGridWindow();
          return;
        }
        view = nextView;
        revealRequest = null;
        if (!view.items.length) {
          layout = null;
          canvas.style.height = '';
          renderWindow();
        } else rebuild(true);
      },
      scheduleCropGridWindow() {
        if (frame !== null || !layout) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          renderWindow();
        });
      },
    };
  });

  Alpine.directive('crop-grid-row', (node, _, { cleanup }) => {
    const grid = cropPreviewGrids.get(node.closest('.cp-scroll'));
    grid.observe(node);
    cleanup(() => grid.unobserve(node));
  });
});
