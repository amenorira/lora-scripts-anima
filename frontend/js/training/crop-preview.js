/* Dataset crop workbench: geometry comes from the active training core. */
const cropPreviewSourceCache = new WeakMap();
const cropPreviewStatsCache = new WeakMap();
const cropPreviewViewCache = new WeakMap();
const cropPreviewWarmDelay = 100;
const cropPreviewWarmLifetime = 3000;
let cropPreviewDetailWarm = null;
let pendingCropPreviewFrame = null;

function cancelCropPreviewDetailImage(frame) {
  const full = frame?.querySelector('.cp-full-image:not(.is-loaded)');
  full?.removeAttribute('src');
}

function discardPendingCropPreviewFrame() {
  const frame = pendingCropPreviewFrame;
  pendingCropPreviewFrame = null;
  for (const image of frame?.querySelectorAll('img[src]') || []) image.removeAttribute('src');
}

function releaseCropPreviewDetailWarm(keepFrame = false) {
  const warm = cropPreviewDetailWarm;
  cropPreviewDetailWarm = null;
  clearTimeout(warm?.timer);
  if (!keepFrame) cancelCropPreviewDetailImage(warm?.frame);
  return warm;
}

window.trainingCropPreviewMixin = {
  cropPreviewOpen: false,
  cropPreviewLoading: false,
  cropPreviewError: '',
  cropPreviewItems: [],
  cropPreviewRandom: false,
  cropPreviewFilter: 'all',
  cropPreviewSource: 'include',
  cropPreviewRegConfigured: false,
  cropPreviewBucket: '',
  cropPreviewBucketsExpanded: false,
  cropPreviewBucketLimit: 9,
  cropPreviewFocus: null,
  cropPreviewFocusOpen: false,
  _cropFocusSeq: 0,
  _cropFocusRequested: null,
  _cropPreviewSeq: 0,
  _cropPreviewAbort: null,
  _cropPreviewEntered: false,
  _cropBucketResize: null,
  _cropBucketFrame: null,
  _cropBucketMotionCleanup: null,
  _cropBucketsClosing: false,

  async openCropPreview() {
    this._cropBucketMotionCleanup?.();
    ++this._cropFocusSeq;
    this.cropPreviewOpen = true;
    this.cropPreviewFocus = null;
    this.cropPreviewFocusOpen = false;
    this.cropPreviewFilter = 'all';
    this.cropPreviewSource = 'include';
    this.cropPreviewRegConfigured = false;
    this.cropPreviewBucket = '';
    this.cropPreviewBucketsExpanded = false;
    this.cropPreviewItems = [];
    this.cropPreviewRandom = false;
    this.cropPreviewError = '';
    this.cropPreviewLoading = true;
    const seq = ++this._cropPreviewSeq;
    this._cropPreviewAbort?.abort();
    this._cropPreviewAbort = new AbortController();
    const signal = this._cropPreviewAbort.signal;
    try {
      const { random_crop, cache_latents, cache_latents_to_disk } = this.form;
      const payload = { ...this._trainingDatasetPayload(), random_crop, cache_latents, cache_latents_to_disk };
      this.cropPreviewRegConfigured = payload.model_train_type !== 'krea2-lora'
        && (payload.enable_reg_data ?? true) && !!String(payload.reg_data_dir ?? '').trim();
      const response = await fetch('/api/training/crop-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (seq !== this._cropPreviewSeq) return;
      if (!response.ok || result.status !== 'success') throw new Error(result.message || this.t('cropPreview.failed'));
      this.cropPreviewRandom = result.data.random_crop;
      this.cropPreviewItems = result.data.items;
      if (this.cropPreviewRandom) this.shuffleCropPreview();
      this.cropPreviewLoading = false;
      await this.$nextTick();
      if (seq !== this._cropPreviewSeq) return;
      this._cropBucketResize?.disconnect();
      const buckets = document.querySelector('#cropBucketStats .cp-buckets');
      if (buckets) {
        this._cropBucketResize = new ResizeObserver(() => {
          if (this._cropBucketFrame !== null) return;
          // Updating the chip count changes the observed grid's height.
          this._cropBucketFrame = requestAnimationFrame(() => {
            this._cropBucketFrame = null;
            const style = getComputedStyle(buckets);
            const columns = style.gridTemplateColumns.split(' ').length;
            const rows = parseInt(style.getPropertyValue('--cp-bucket-rows'), 10) || 2;
            this.cropPreviewBucketLimit = Math.max(1, columns * rows - 1);
          });
        });
        this._cropBucketResize.observe(buckets);
        this._cropBucketResize.observe(buckets.closest('.cp-content'));
      }
    } catch (error) {
      if (seq === this._cropPreviewSeq && error.name !== 'AbortError') this.cropPreviewError = error.message;
    } finally {
      if (seq === this._cropPreviewSeq) this.cropPreviewLoading = false;
    }
  },

  closeCropPreview() {
    this._cropBucketMotionCleanup?.();
    ++this._cropPreviewSeq;
    this._cropPreviewAbort?.abort();
    this._cropBucketResize?.disconnect();
    this._cropBucketResize = null;
    if (this._cropBucketFrame !== null) cancelAnimationFrame(this._cropBucketFrame);
    this._cropBucketFrame = null;
    this._cropPreviewEntered = false;
    this.cropPreviewOpen = false;
    this.unfocusCropPreview();
  },

  clearCropPreview() {
    this.cropPreviewItems = [];
    this.cropPreviewLoading = false;
  },

  cropPreviewDismiss() {
    if (this.cropPreviewFocusOpen) this.unfocusCropPreview();
    else this.closeCropPreview();
  },

  cropPreviewFilterOptions() {
    return [['all', 'all'], ['cropped', 'hasCrop'], ['upscaled', 'upscaled'], ['errors', 'errors']]
      .map(([value, label]) => ({ value, label: this.t(`cropPreview.${label}`) }));
  },

  setCropPreviewFilter(value) {
    this.cropPreviewFilter = value;
    if (value === 'errors') this.cropPreviewBucket = '';
    const scroller = document.getElementById('cropPreviewScroll');
    if (scroller) scroller.scrollTop = 0;
  },

  cropPreviewSourceOptions() {
    return [['include', 'includeReg'], ['exclude', 'excludeReg'], ['only', 'onlyReg']]
      .map(([value, label]) => ({ value, label: this.t(`cropPreview.${label}`) }));
  },

  setCropPreviewSource(value) {
    this._cropBucketMotionCleanup?.();
    this.cropPreviewSource = value;
    if (this.cropPreviewBucket && !this.cropPreviewBuckets.some(bucket => bucket.key === this.cropPreviewBucket)) {
      this.cropPreviewBucket = '';
    }
    const scroller = document.getElementById('cropPreviewScroll');
    if (scroller) scroller.scrollTop = 0;
  },

  get cropPreviewSourceItems() {
    const items = this.cropPreviewItems;
    const source = this.cropPreviewSource;
    if (source === 'include') return items;
    const cached = cropPreviewSourceCache.get(items);
    if (cached?.source === source) return cached.items;
    const filtered = items.filter(item => !!item.is_reg === (source === 'only'));
    cropPreviewSourceCache.set(items, { source, items: filtered });
    return filtered;
  },

  get cropPreviewStats() {
    const items = this.cropPreviewSourceItems;
    // Random crop only changes the overlay coordinates.
    const cached = cropPreviewStatsCache.get(items);
    if (cached) return cached;
    const counts = new Map();
    const totals = { count: 0, samples: 0 };
    let errors = 0;
    let includesReg = false;
    for (const item of items) {
      if (item.is_reg) includesReg = true;
      if (item.error) { errors += 1; continue; }
      const key = item.bucket.join(' × ');
      const bucket = counts.get(key) || { key, count: 0, samples: 0, width: item.bucket[0], height: item.bucket[1] };
      const samples = Number(item.sample_count || 0);
      bucket.count += 1;
      bucket.samples += samples;
      totals.count += 1;
      totals.samples += samples;
      counts.set(key, bucket);
    }
    const buckets = Array.from(counts.values()).sort((a, b) => a.width - b.width || a.height - b.height);
    const stats = { buckets, totals, errors, includesReg };
    cropPreviewStatsCache.set(items, stats);
    return stats;
  },

  get cropPreviewBuckets() {
    return this.cropPreviewStats.buckets;
  },

  get cropPreviewView() {
    const items = this.cropPreviewSourceItems;
    const bucket = this.cropPreviewBucket;
    const filter = this.cropPreviewFilter;
    const cached = cropPreviewViewCache.get(items);
    if (cached && cached.bucket === bucket && cached.filter === filter) return cached;

    const groups = new Map();
    for (const item of items) {
      if (bucket && (item.error || item.bucket.join(' × ') !== bucket)) continue;
      if (filter === 'cropped' && (item.error || !(item.crop_percent > 0))) continue;
      if (filter === 'upscaled' && (item.error || !(item.scale > 1.001))) continue;
      if (filter === 'errors' && !item.error) continue;
      const path = item.name.replaceAll('\\', '/');
      const name = path.slice(0, Math.max(0, path.lastIndexOf('/')));
      const key = `${item.is_reg ? 'reg:' : 'train:'}${name}`;
      if (!groups.has(key)) groups.set(key, { key, name, items: [] });
      groups.get(key).items.push(item);
    }
    const ordered = [];
    const indices = new Map();
    const folders = Array.from(groups.values(), ({ key, name, items }) => {
      for (const item of items) {
        indices.set(item.id, ordered.length);
        ordered.push(item);
      }
      return { key, name, count: items.length, end: ordered.length };
    });
    const view = { bucket, filter, folders, items: ordered, indices };
    cropPreviewViewCache.set(items, view);
    return view;
  },

  async toggleCropPreviewBuckets() {
    const panel = document.getElementById('cropBucketStats');
    const from = panel.getBoundingClientRect().height;
    this._cropBucketMotionCleanup?.();
    const expanded = !this.cropPreviewBucketsExpanded;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._cropBucketsClosing = !expanded && !reduced;
    this.cropPreviewBucketsExpanded = expanded;
    if (reduced) return;

    let animation;
    const cleanup = () => {
      if (this._cropBucketMotionCleanup !== cleanup) return;
      this._cropBucketMotionCleanup = null;
      animation?.cancel();
      panel.style.height = '';
      this._cropBucketsClosing = false;
    };
    this._cropBucketMotionCleanup = cleanup;
    panel.style.height = `${from}px`;
    await this.$nextTick();
    if (this._cropBucketMotionCleanup !== cleanup) return;

    if (expanded) panel.style.height = '';
    const to = expanded ? panel.getBoundingClientRect().height : this._measureCropPreviewCollapsedHeight(panel);
    if (from === to) { cleanup(); return; }
    panel.style.height = `${to}px`;
    animation = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: expanded ? 220 : 180,
      easing: getComputedStyle(panel).getPropertyValue('--ease-disclosure').trim(),
    });
    animation.finished.then(cleanup, cleanup);
  },

  _measureCropPreviewCollapsedHeight(panel) {
    // Measure only the collapsed cards without disturbing the live scroll position.
    const measure = panel.cloneNode(false);
    measure.removeAttribute('id');
    measure.setAttribute('x-ignore', '');
    measure.inert = true;
    measure.style.cssText = `position:absolute;top:0;left:0;visibility:hidden;width:${panel.getBoundingClientRect().width}px`;
    const scroll = panel.querySelector('.cp-buckets-scroll').cloneNode(false);
    const grid = panel.querySelector('.cp-buckets').cloneNode(false);
    grid.removeAttribute('id');
    const chips = panel.querySelectorAll('.cp-bucket-chip');
    grid.append(chips[0].cloneNode(true));
    const buckets = this.cropPreviewBuckets;
    for (const bucket of this._cropPreviewCollapsedBucketChips()) {
      grid.append(chips[buckets.indexOf(bucket) + 1].cloneNode(true));
    }
    scroll.append(grid);
    measure.append(scroll);
    panel.after(measure);
    const height = measure.getBoundingClientRect().height;
    measure.remove();
    return height;
  },

  _cropPreviewCollapsedBucketChips() {
    const buckets = this.cropPreviewBuckets;
    const visible = buckets.slice(0, this.cropPreviewBucketLimit);
    const selected = buckets.find(bucket => bucket.key === this.cropPreviewBucket);
    // Keep the active filter visible when collapsing or narrowing the window.
    if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected;
    return visible;
  },

  get cropPreviewBucketChips() {
    return this.cropPreviewBucketsExpanded || this._cropBucketsClosing
      ? this.cropPreviewBuckets : this._cropPreviewCollapsedBucketChips();
  },

  cropPreviewFolderCount(count) {
    return this.t(count === 1 ? 'cropPreview.folderCountSingle' : 'cropPreview.folderCount').replace('{count}', count);
  },

  get cropPreviewTotals() {
    return this.cropPreviewStats.totals;
  },

  cropPreviewCount(count) {
    return this.t('cropPreview.imageCount').replace('{count}', count);
  },

  selectCropPreviewBucket(key) {
    this._cropBucketMotionCleanup?.();
    this.cropPreviewBucket = this.cropPreviewBucket === key ? '' : key;
    // Failed images have no bucket; leave that filter when choosing a valid bucket.
    if (key && this.cropPreviewFilter === 'errors') this.cropPreviewFilter = 'all';
    const scroller = document.getElementById('cropPreviewScroll');
    if (scroller) scroller.scrollTop = 0;
  },

  cropPreviewStatsNote() {
    const { includesReg, errors } = this.cropPreviewStats;
    const notes = [];
    if (includesReg) notes.push(this.t('cropPreview.includesReg'));
    if (errors) notes.push(this.t('cropPreview.statsErrors').replace('{count}', errors));
    return notes.join(' · ');
  },

  cropPreviewInfo(item) {
    if (item.error) return '';
    const parts = [item.bucket.join(' × ')];
    if (item.crop_percent > 0) parts.push(this.t('cropPreview.cropped').replace('{value}', item.crop_percent < .1 ? '<0.1' : item.crop_percent.toFixed(1)));
    if (item.scale > 1.001) parts.push(`↑ ${item.scale.toFixed(2)}×`);
    return parts.join(' · ');
  },

  cropPreviewCropPercent(item) {
    if (!item) return '';
    return item.crop_percent > 0 && item.crop_percent < .1 ? '<0.1%' : `${item.crop_percent.toFixed(1)}%`;
  },

  cropPreviewImageHtml(item, large = false) {
    if (!item || item.error) return '';
    const [x, y, w, h] = item.crop;
    const ratio = item.original[0] / item.original[1];
    const url = this.esc(item.thumb);
    let overlay = '';
    if (item.crop_percent > 0) {
      const rects = [[0, 0, 1, y], [0, y + h, 1, 1 - y - h], [0, y, x, h], [x + w, y, 1 - x - w, h]];
      overlay = rects.filter(r => r[2] > 0 && r[3] > 0).map(([l, t, rw, rh]) =>
        `<span class="cp-hatch" style="left:${l * 100}%;top:${t * 100}%;width:${rw * 100}%;height:${rh * 100}%"></span>`).join('');
    }
    const full = large ? `<img class="cp-full-image" data-preview-src="${this.esc(item.preview)}" alt="" aria-hidden="true" decoding="async">` : '';
    return `<div class="cp-frame" data-dialog-anchor${large ? '="target"' : ''} style="--cp-ratio:${ratio}"><img src="${url}" alt="${this.esc(item.name)}" loading="${large ? 'eager' : 'lazy'}" decoding="${large ? 'sync' : 'async'}">${full}${overlay}</div>`;
  },

  shuffleCropPreview() {
    releaseCropPreviewDetailWarm();
    for (const item of this.cropPreviewItems) {
      if (item.error) continue;
      const [rw, rh] = item.resized, [bw, bh] = item.bucket;
      item.crop = [Math.floor(Math.random() * (rw - bw + 1)) / rw, Math.floor(Math.random() * (rh - bh + 1)) / rh, bw / rw, bh / rh];
    }
  },

  createCropPreviewFrame(item) {
    const container = document.createElement('div');
    container.innerHTML = this.cropPreviewImageHtml(item, true);
    return container.firstElementChild;
  },

  async decodeCropPreviewDetail(frame, priority) {
    const image = frame.querySelector('.cp-full-image');
    if (!image?.dataset.previewSrc) return false;
    const thumb = frame.firstElementChild;
    image.fetchPriority = priority;
    image.src = image.dataset.previewSrc;
    try {
      await image.decode();
      if (!image.hasAttribute('src')) return false;
      image.classList.add('is-loaded');
      const removeThumb = () => {
        image.alt = thumb.alt;
        image.removeAttribute('aria-hidden');
        thumb.remove();
      };
      if (frame.isConnected) setTimeout(removeThumb, 100);
      else removeThumb();
      return true;
    } catch (_) { return false; }
  },

  scheduleCropPreviewDetailWarmup(event) {
    const tile = event.target.closest('.cp-tile');
    if (!tile || tile.disabled || tile.contains(event.relatedTarget) || cropPreviewDetailWarm?.tile === tile) return;
    if (cropPreviewDetailWarm?.ready && !cropPreviewDetailWarm.done) return;
    if (!this.cropPreviewOpen || this.cropPreviewFocusOpen || !this._cropPreviewEntered
        || document.body.hasAttribute('data-gpu-workload')) return;
    releaseCropPreviewDetailWarm();
    const index = Number(tile.dataset.cropImage);
    const warm = { tile };
    cropPreviewDetailWarm = warm;
    warm.timer = setTimeout(() => {
      if (!tile.isConnected || document.body.hasAttribute('data-gpu-workload')) {
        releaseCropPreviewDetailWarm();
        return;
      }
      warm.item = this.cropPreviewItems[index];
      if (!warm.item?.preview) {
        releaseCropPreviewDetailWarm();
        return;
      }
      warm.frame = this.createCropPreviewFrame(warm.item);
      warm.ready = this.decodeCropPreviewDetail(warm.frame, 'low').finally(() => {
        warm.done = true;
        if (cropPreviewDetailWarm === warm) warm.timer = setTimeout(releaseCropPreviewDetailWarm, cropPreviewWarmLifetime);
      });
    }, cropPreviewWarmDelay);
  },

  cancelCropPreviewDetailWarmup(event) {
    const warm = cropPreviewDetailWarm;
    if (warm?.tile.contains(event.target) && !warm.tile.contains(event.relatedTarget) && (!warm.ready || warm.done)) {
      releaseCropPreviewDetailWarm();
    }
  },

  async prepareCropPreviewFrame(item) {
    discardPendingCropPreviewFrame();
    const canReuse = cropPreviewDetailWarm?.item === item;
    const warmed = releaseCropPreviewDetailWarm(canReuse);
    const warm = canReuse ? warmed : null;
    const frame = warm?.frame || this.createCropPreviewFrame(item);
    const image = frame.querySelector('.cp-full-image');
    if (image?.classList.contains('is-loaded')) return frame;
    if (image) image.fetchPriority = 'high';
    const detail = warm?.ready || this.decodeCropPreviewDetail(frame, 'high');
    // Start with whichever of these exact display nodes decodes first. A cold
    // detail request never holds up a ready thumbnail.
    const thumb = frame.firstElementChild.decode().then(() => true, () => false);
    pendingCropPreviewFrame = frame;
    try {
      await Promise.race([detail.then(ok => ok || thumb), thumb.then(ok => ok || detail)]);
      return frame;
    } finally {
      if (pendingCropPreviewFrame === frame) pendingCropPreviewFrame = null;
    }
  },

  replaceCropPreviewFrame(frame) {
    const stage = document.getElementById('cropFocusOriginal');
    cancelCropPreviewDetailImage(stage?.firstElementChild);
    if (frame) stage?.replaceChildren(frame);
    else stage?.replaceChildren();
  },

  async focusCropPreview(item) {
    if (item.error) return;
    const seq = ++this._cropFocusSeq;
    this._cropFocusRequested = null;
    const frame = await this.prepareCropPreviewFrame(item);
    if (seq !== this._cropFocusSeq || !this.cropPreviewOpen) {
      cancelCropPreviewDetailImage(frame);
      return;
    }
    const tile = document.getElementById(`crop-image-${item.id}`) || await getCropPreviewGrid().reveal(item.id);
    if (!tile || seq !== this._cropFocusSeq || !this.cropPreviewOpen) {
      cancelCropPreviewDetailImage(frame);
      return;
    }
    this.replaceCropPreviewFrame(frame);
    this.cropPreviewFocus = item;
    window.AnimaUI.setDialogOrigin(document.getElementById('cropFocusDialog'), tile);
    this.cropPreviewFocusOpen = true;
  },

  unfocusCropPreview() {
    // The dialog clears its content after the image returns to the grid.
    const seq = ++this._cropFocusSeq;
    this._cropFocusRequested = null;
    releaseCropPreviewDetailWarm();
    discardPendingCropPreviewFrame();
    cancelCropPreviewDetailImage(document.getElementById('cropFocusOriginal')?.firstElementChild);
    if (this.cropPreviewOpen && this.cropPreviewFocusOpen) {
      const ready = getCropPreviewGrid().returnTo(this.cropPreviewFocus.id);
      if (ready) {
        return ready.then(() => {
          if (seq === this._cropFocusSeq) this.cropPreviewFocusOpen = false;
        });
      }
    }
    this.cropPreviewFocusOpen = false;
  },

  clearCropPreviewFocus() {
    this.replaceCropPreviewFrame();
    this.cropPreviewFocus = null;
  },

  cropPreviewAdjacent(direction, id = this.cropPreviewFocus?.id) {
    if (id == null) return null;
    const { items, indices } = this.cropPreviewView;
    const index = indices.get(id);
    if (index === undefined) return null;
    for (let i = index + direction; i >= 0 && i < items.length; i += direction) {
      if (!items[i].error) return items[i];
    }
    return null;
  },

  async cropPreviewTab(event) {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    const items = this.cropPreviewView.items;
    const wrap = event.shiftKey && target.matches('[data-dialog-autofocus]');
    let next;
    if (target.matches('.cp-tile')) {
      next = this.cropPreviewAdjacent(event.shiftKey ? -1 : 1, target.dataset.cropImage);
    } else if (wrap) {
      next = items.findLast(item => !item.error);
    } else if (!event.shiftKey && items.length) {
      const controls = Array.from(event.currentTarget.querySelectorAll('button:not(.cp-tile):not(:disabled)'));
      const last = controls.findLast(button => button.getClientRects().length && !button.closest('[inert]'));
      if (target === last) next = items.find(item => !item.error);
    }
    // The shared wrap uses preventScroll, so reveal even a mounted tail row.
    if (!next || (!wrap && document.getElementById(`crop-image-${next.id}`))) return;
    event.preventDefault();
    const tile = await getCropPreviewGrid().reveal(next.id);
    if (document.activeElement === target) tile?.focus({ preventScroll: true });
  },

  async stepCropPreview(direction) {
    const next = this.cropPreviewAdjacent(direction, this._cropFocusRequested ?? this.cropPreviewFocus?.id);
    if (!next || !this.cropPreviewFocusOpen) return;
    const seq = ++this._cropFocusSeq;
    this._cropFocusRequested = next.id;
    try {
      const frame = await this.prepareCropPreviewFrame(next);
      if (seq !== this._cropFocusSeq || !this.cropPreviewFocusOpen) {
        cancelCropPreviewDetailImage(frame);
        return;
      }
      const dialog = document.getElementById('cropFocusDialog');
      window.AnimaUI.settleDialog(dialog?.querySelector('[data-dialog-anchor]'));
      const tile = await getCropPreviewGrid().reveal(next.id);
      if (!tile || seq !== this._cropFocusSeq || !this.cropPreviewFocusOpen) {
        cancelCropPreviewDetailImage(frame);
        return;
      }
      this.replaceCropPreviewFrame(frame);
      this.cropPreviewFocus = next;
      tile.querySelector('[data-dialog-anchor]')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      window.AnimaUI.setDialogOrigin(dialog, tile);
    } finally {
      if (seq === this._cropFocusSeq) this._cropFocusRequested = null;
    }
  },

  cropPreviewKey(event) {
    if (!this.cropPreviewFocusOpen || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    this.stepCropPreview(event.key === 'ArrowLeft' ? -1 : 1);
  },
};
