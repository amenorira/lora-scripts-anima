/* Dataset crop workbench: geometry comes from the active training core. */
const cropPreviewStatsCache = new WeakMap();
const cropPreviewWarmDelay = 100;
const cropPreviewWarmLifetime = 3000;
const cropPreviewWarmBytes = 1024 * 1024;
let cropPreviewWarm = null;
let cropPreviewDetailWarm = null;
let pendingCropPreviewFrame = null;

function requestCropPreview(body, signal) {
  return fetch('/api/training/crop-preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal,
  });
}

function releaseCropPreviewWarm(keepRequest = false) {
  const warm = cropPreviewWarm;
  cropPreviewWarm = null;
  clearTimeout(warm?.timer);
  if (!keepRequest) warm?.controller?.abort();
  return warm;
}

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
  cropPreviewRenderLimit: null,
  cropPreviewRandom: false,
  cropPreviewFilter: 'all',
  cropPreviewBucket: '',
  cropPreviewBucketsExpanded: false,
  cropPreviewBucketLimit: 9,
  cropPreviewFocus: null,
  cropPreviewFocusOpen: false,
  _cropFocusSeq: 0,
  _cropFocusRequested: null,
  _cropPreviewSeq: 0,
  _cropPreviewAbort: null,
  _cropBucketResize: null,

  cropPreviewRequestBody() {
    return JSON.stringify({ ...this._stepEstimatePayload(), random_crop: !!this.form.random_crop });
  },

  scheduleCropPreviewWarmup(opener) {
    if (cropPreviewWarm || this.cropPreviewOpen || !this.form.train_data_dir) return;
    if (document.body.hasAttribute('data-gpu-workload')) return;
    const warm = { opener };
    cropPreviewWarm = warm;
    warm.timer = setTimeout(() => {
      if (!opener.isConnected || !this.form.train_data_dir || document.body.hasAttribute('data-gpu-workload')) {
        releaseCropPreviewWarm();
        return;
      }
      warm.body = this.cropPreviewRequestBody();
      warm.controller = new AbortController();
      warm.promise = requestCropPreview(warm.body, warm.controller.signal).then(async response => {
        if (!response.ok) return null;
        const bytes = Number(response.headers.get('Content-Length'));
        if (!warm.used && (!bytes || bytes > cropPreviewWarmBytes)) {
          if (cropPreviewWarm === warm) releaseCropPreviewWarm();
          return null;
        }
        const result = await response.json();
        return result.status === 'success' ? result : null;
      }).catch(() => null).finally(() => {
        if (cropPreviewWarm === warm) warm.timer = setTimeout(releaseCropPreviewWarm, cropPreviewWarmLifetime);
      });
    }, cropPreviewWarmDelay);
  },

  cancelCropPreviewWarmup(opener) {
    // The server scan cannot be stopped by aborting the HTTP request. Keep
    // one in flight and reuse it if the pointer comes back.
    if (cropPreviewWarm?.opener === opener && !cropPreviewWarm.promise) releaseCropPreviewWarm();
  },

  async openCropPreview() {
    const dialog = !this.cropPreviewOpen && document.getElementById('cropPreviewDialog');
    ++this._cropFocusSeq;
    this.cropPreviewOpen = true;
    this.cropPreviewFocus = null;
    this.cropPreviewFocusOpen = false;
    this.cropPreviewFilter = 'all';
    this.cropPreviewBucket = '';
    this.cropPreviewBucketsExpanded = false;
    this.cropPreviewItems = [];
    // The widest preview fits six cards per row. Mount two rows during the morph.
    this.cropPreviewRenderLimit = dialog ? 12 : null;
    this.cropPreviewRandom = false;
    this.cropPreviewError = '';
    this.cropPreviewLoading = true;
    const seq = ++this._cropPreviewSeq;
    this._cropPreviewAbort?.abort();
    const body = this.cropPreviewRequestBody();
    const warm = cropPreviewWarm?.body === body ? releaseCropPreviewWarm(true) : null;
    if (!warm && !cropPreviewWarm?.promise) releaseCropPreviewWarm();
    if (warm) warm.used = true;
    this._cropPreviewAbort = warm?.controller || new AbortController();
    const signal = this._cropPreviewAbort.signal;
    if (dialog) {
      dialog.addEventListener('dialog-after-open', () => requestAnimationFrame(() => {
        if (seq === this._cropPreviewSeq) this.cropPreviewRenderLimit = null;
      }), { once: true, signal });
    }
    try {
      let result = warm ? await warm.promise : null;
      if (!result && !signal.aborted) {
        const response = await requestCropPreview(body, signal);
        result = await response.json();
        if (!response.ok) throw new Error(result.message || this.t('cropPreview.failed'));
      }
      if (seq !== this._cropPreviewSeq) return;
      if (result?.status !== 'success') throw new Error(result?.message || this.t('cropPreview.failed'));
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
          const columns = getComputedStyle(buckets).gridTemplateColumns.split(' ').length;
          this.cropPreviewBucketLimit = Math.max(1, columns * 2 - 1);
        });
        this._cropBucketResize.observe(buckets);
      }
    } catch (error) {
      if (seq === this._cropPreviewSeq && error.name !== 'AbortError') this.cropPreviewError = error.message;
    } finally {
      if (seq === this._cropPreviewSeq) this.cropPreviewLoading = false;
    }
  },

  closeCropPreview() {
    ++this._cropPreviewSeq;
    this._cropPreviewAbort?.abort();
    this._cropBucketResize?.disconnect();
    this._cropBucketResize = null;
    this.cropPreviewOpen = false;
    this.unfocusCropPreview();
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
    const grid = document.querySelector('#cropPreviewDialog .cp-scroll');
    if (grid) grid.scrollTop = 0;
  },

  get cropPreviewStats() {
    const items = this.cropPreviewItems;
    // Preview results and random-crop updates replace the array.
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
    const buckets = Array.from(counts.values()).sort((a, b) => b.samples - a.samples || a.width - b.width || a.height - b.height);
    const stats = { buckets, totals, errors, includesReg };
    cropPreviewStatsCache.set(items, stats);
    return stats;
  },

  get cropPreviewBuckets() {
    return this.cropPreviewStats.buckets;
  },

  get cropPreviewVisible() {
    const items = this.cropPreviewItems;
    const bucket = this.cropPreviewBucket;
    const filter = this.cropPreviewFilter;
    if (!bucket && filter === 'all') return items;
    return items.filter(item => {
      if (bucket && (item.error || item.bucket.join(' × ') !== bucket)) return false;
      if (filter === 'cropped') return !item.error && item.crop_percent > 0;
      if (filter === 'upscaled') return !item.error && item.scale > 1.001;
      if (filter === 'errors') return !!item.error;
      return true;
    });
  },

  get cropPreviewBucketChips() {
    const buckets = this.cropPreviewBuckets;
    if (this.cropPreviewBucketsExpanded) return buckets;
    const visible = buckets.slice(0, this.cropPreviewBucketLimit);
    const selected = buckets.find(bucket => bucket.key === this.cropPreviewBucket);
    // Keep the active filter visible when collapsing or narrowing the window.
    if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected;
    return visible;
  },

  get cropPreviewFolders() {
    const folders = new Map();
    for (const item of this.cropPreviewVisible) {
      const name = item.name.replaceAll('\\', '/');
      const folder = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : this.t('cropPreview.rootFolder');
      const key = `${item.is_reg ? 'reg:' : 'train:'}${folder}`;
      if (!folders.has(key)) folders.set(key, { key, name: folder, items: [] });
      folders.get(key).items.push(item);
    }
    let remaining = this.cropPreviewRenderLimit ?? Infinity;
    const rendered = [];
    for (const folder of folders.values()) {
      if (!remaining) break;
      folder.count = folder.items.length;
      if (folder.count > remaining) folder.items = folder.items.slice(0, remaining);
      remaining -= folder.items.length;
      rendered.push(folder);
    }
    return rendered;
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

  cropPreviewSummary() {
    const { buckets, totals } = this.cropPreviewStats;
    return this.t('cropPreview.summary')
      .replace('{images}', totals.count)
      .replace('{samples}', totals.samples)
      .replace('{buckets}', buckets.length);
  },

  selectCropPreviewBucket(key) {
    this.cropPreviewBucket = this.cropPreviewBucket === key ? '' : key;
    // Failed images have no bucket; leave that filter when choosing a valid bucket.
    if (key && this.cropPreviewFilter === 'errors') this.cropPreviewFilter = 'all';
    const grid = document.querySelector('#cropPreviewDialog .cp-scroll');
    if (grid) grid.scrollTop = 0;
  },

  cropPreviewStatsNote() {
    const { includesReg, errors } = this.cropPreviewStats;
    const notes = [];
    if (includesReg) notes.push(this.t('cropPreview.includesReg'));
    if (errors) notes.push(this.t('cropPreview.statsErrors').replace('{count}', errors));
    return notes.join(' · ');
  },

  cropPreviewInfo(item, detail = false) {
    if (!item || item.error) return '';
    const parts = [detail ? `${item.original.join(' × ')} → ${item.bucket.join(' × ')}` : item.bucket.join(' × ')];
    if (item.crop_percent > 0) parts.push(this.t('cropPreview.cropped').replace('{value}', item.crop_percent < .1 ? '<0.1' : item.crop_percent.toFixed(1)));
    else if (detail) parts.push(this.t('cropPreview.intact'));
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
    this.cropPreviewItems = this.cropPreviewItems.map(item => {
      if (item.error) return item;
      const [rw, rh] = item.resized, [bw, bh] = item.bucket;
      return { ...item, crop: [Math.floor(Math.random() * (rw - bw + 1)) / rw, Math.floor(Math.random() * (rh - bh + 1)) / rh, bw / rw, bh / rh] };
    });
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
    if (!this.cropPreviewOpen || this.cropPreviewFocusOpen || this.cropPreviewRenderLimit !== null
        || document.body.hasAttribute('data-gpu-workload')) return;
    releaseCropPreviewDetailWarm();
    const id = tile.id.slice('crop-image-'.length);
    const warm = { tile };
    cropPreviewDetailWarm = warm;
    warm.timer = setTimeout(() => {
      if (!tile.isConnected || document.body.hasAttribute('data-gpu-workload')) {
        releaseCropPreviewDetailWarm();
        return;
      }
      const item = this.cropPreviewItems[Number(id)];
      warm.item = item?.id === id ? item : this.cropPreviewItems.find(item => item.id === id);
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
    this.replaceCropPreviewFrame(frame);
    this.cropPreviewFocus = item;
    window.AnimaUI?.setDialogOrigin(document.getElementById('cropFocusDialog'), document.getElementById(`crop-image-${item.id}`));
    this.cropPreviewFocusOpen = true;
  },

  unfocusCropPreview() {
    // The dialog clears its content after the image returns to the grid.
    ++this._cropFocusSeq;
    this._cropFocusRequested = null;
    releaseCropPreviewDetailWarm();
    discardPendingCropPreviewFrame();
    cancelCropPreviewDetailImage(document.getElementById('cropFocusOriginal')?.firstElementChild);
    this.cropPreviewFocusOpen = false;
  },

  clearCropPreviewFocus() {
    this.replaceCropPreviewFrame();
    this.cropPreviewFocus = null;
  },

  cropPreviewAdjacent(direction, id = this.cropPreviewFocus?.id) {
    if (id == null) return null;
    const items = this.cropPreviewVisible;
    const index = items.findIndex(item => item.id === id);
    if (index < 0) return null;
    for (let i = index + direction; i >= 0 && i < items.length; i += direction) {
      if (!items[i].error) return items[i];
    }
    return null;
  },

  async stepCropPreview(direction) {
    const next = this.cropPreviewAdjacent(direction, this._cropFocusRequested ?? this.cropPreviewFocus?.id);
    if (!next || !this.cropPreviewFocusOpen) return;
    if (this.cropPreviewRenderLimit !== null && !document.getElementById(`crop-image-${next.id}`)) return;
    const seq = ++this._cropFocusSeq;
    this._cropFocusRequested = next.id;
    try {
      const frame = await this.prepareCropPreviewFrame(next);
      if (seq !== this._cropFocusSeq || !this.cropPreviewFocusOpen) {
        cancelCropPreviewDetailImage(frame);
        return;
      }
      const dialog = document.getElementById('cropFocusDialog');
      window.AnimaUI?.settleDialog(dialog?.querySelector('[data-dialog-anchor]'));
      await this.$nextTick();
      const tile = document.getElementById(`crop-image-${next.id}`);
      if (seq !== this._cropFocusSeq || !this.cropPreviewFocusOpen || (!tile && this.cropPreviewRenderLimit !== null)) {
        cancelCropPreviewDetailImage(frame);
        return;
      }
      this.replaceCropPreviewFrame(frame);
      this.cropPreviewFocus = next;
      tile?.querySelector('[data-dialog-anchor]')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      window.AnimaUI?.setDialogOrigin(dialog, tile);
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
