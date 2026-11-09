/* Dataset crop workbench: geometry comes from the active training core. */
window.trainingCropPreviewMixin = {
  cropPreviewOpen: false,
  cropPreviewLoading: false,
  cropPreviewError: '',
  cropPreviewItems: [],
  cropPreviewRandom: false,
  cropPreviewFilter: 'all',
  cropPreviewBucket: '',
  cropPreviewBucketsExpanded: false,
  cropPreviewBucketLimit: 9,
  cropPreviewFocus: null,
  cropPreviewFocusOpen: false,
  _cropPreviewSeq: 0,
  _cropPreviewAbort: null,
  _cropBucketResize: null,

  async openCropPreview() {
    this.cropPreviewOpen = true;
    this.cropPreviewFocus = null;
    this.cropPreviewFocusOpen = false;
    this.cropPreviewFilter = 'all';
    this.cropPreviewBucket = '';
    this.cropPreviewBucketsExpanded = false;
    this.cropPreviewItems = [];
    this.cropPreviewRandom = false;
    this.cropPreviewError = '';
    this.cropPreviewLoading = true;
    const seq = ++this._cropPreviewSeq;
    this._cropPreviewAbort?.abort();
    this._cropPreviewAbort = new AbortController();
    try {
      const response = await fetch('/api/training/crop-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: this._cropPreviewAbort.signal,
        body: JSON.stringify({ ...this._stepEstimatePayload(), random_crop: !!this.form.random_crop }),
      });
      const result = await response.json();
      if (seq !== this._cropPreviewSeq) return;
      if (!response.ok || result.status !== 'success') throw new Error(result.message || this.t('cropPreview.failed'));
      this.cropPreviewRandom = result.data.random_crop;
      this.cropPreviewItems = result.data.items;
      if (this.cropPreviewRandom) this.shuffleCropPreview();
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
    this.cropPreviewFocus = null;
    this.cropPreviewFocusOpen = false;
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
    const grid = document.querySelector('#cropPreviewDialog .cp-scroll');
    if (grid) grid.scrollTop = 0;
  },

  get cropPreviewBuckets() {
    const counts = new Map();
    this.cropPreviewItems.filter(item => !item.error).forEach(item => {
      const key = item.bucket.join(' × ');
      const bucket = counts.get(key) || { key, count: 0, samples: 0, width: item.bucket[0], height: item.bucket[1] };
      bucket.count += 1;
      bucket.samples += Number(item.sample_count || 0);
      counts.set(key, bucket);
    });
    return Array.from(counts.values()).sort((a, b) => b.samples - a.samples || a.width - b.width || a.height - b.height);
  },

  get cropPreviewVisible() {
    return this.cropPreviewItems.filter(item => {
      if (this.cropPreviewBucket && (item.error || item.bucket.join(' × ') !== this.cropPreviewBucket)) return false;
      if (this.cropPreviewFilter === 'cropped') return !item.error && item.crop_percent > 0;
      if (this.cropPreviewFilter === 'upscaled') return !item.error && item.scale > 1.001;
      if (this.cropPreviewFilter === 'errors') return !!item.error;
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
    return Array.from(folders.values());
  },

  cropPreviewFolderCount(count) {
    return this.t(count === 1 ? 'cropPreview.folderCountSingle' : 'cropPreview.folderCount').replace('{count}', count);
  },

  get cropPreviewTotals() {
    return this.cropPreviewBuckets.reduce((total, bucket) => ({
      count: total.count + bucket.count, samples: total.samples + bucket.samples,
    }), { count: 0, samples: 0 });
  },

  cropPreviewCount(count) {
    return this.t('cropPreview.imageCount').replace('{count}', count);
  },

  cropPreviewSummary() {
    const buckets = this.cropPreviewBuckets;
    return this.t('cropPreview.summary')
      .replace('{images}', buckets.reduce((sum, bucket) => sum + bucket.count, 0))
      .replace('{samples}', buckets.reduce((sum, bucket) => sum + bucket.samples, 0))
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
    const notes = [];
    if (this.cropPreviewItems.some(item => item.is_reg)) notes.push(this.t('cropPreview.includesReg'));
    const errors = this.cropPreviewItems.filter(item => item.error).length;
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
    const full = large ? `<img class="cp-full-image" src="${this.esc(item.preview)}" alt="" aria-hidden="true" decoding="async" x-init="window.AnimaImages.reveal($el)">` : '';
    return `<div class="cp-frame" data-dialog-anchor style="--cp-ratio:${ratio}"><img src="${url}" alt="${this.esc(item.name)}" loading="${large ? 'eager' : 'lazy'}" decoding="async">${full}${overlay}</div>`;
  },

  shuffleCropPreview() {
    this.cropPreviewItems = this.cropPreviewItems.map(item => {
      if (item.error) return item;
      const [rw, rh] = item.resized, [bw, bh] = item.bucket;
      return { ...item, crop: [Math.floor(Math.random() * (rw - bw + 1)) / rw, Math.floor(Math.random() * (rh - bh + 1)) / rh, bw / rw, bh / rh] };
    });
  },

  focusCropPreview(item) {
    if (item.error) return;
    window.AnimaUI?.setDialogOrigin(document.getElementById('cropFocusDialog'), document.getElementById(`crop-image-${item.id}`));
    this.cropPreviewFocus = item;
    this.cropPreviewFocusOpen = true;
  },

  async unfocusCropPreview() {
    const item = this.cropPreviewFocus;
    if (!item || !this.cropPreviewFocusOpen) return;
    const tile = document.getElementById(`crop-image-${item.id}`);
    // Retain the image while the dialog fades out; native dialog owns modality.
    this.cropPreviewFocusOpen = false;
    await this.$nextTick();
    tile?.focus({ preventScroll: true });
  },

  cropPreviewAdjacent(direction) {
    const items = this.cropPreviewVisible.filter(item => !item.error);
    const index = items.findIndex(item => item.id === this.cropPreviewFocus?.id);
    return index < 0 ? null : items[index + direction] || null;
  },

  stepCropPreview(direction) {
    const next = this.cropPreviewAdjacent(direction);
    if (next) {
      this.cropPreviewFocus = next;
      const tile = document.getElementById(`crop-image-${next.id}`);
      tile?.scrollIntoView({ block: 'nearest' });
      window.AnimaUI?.setDialogOrigin(document.getElementById('cropFocusDialog'), tile);
    }
  },

  cropPreviewKey(event) {
    if (!this.cropPreviewFocusOpen || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    this.stepCropPreview(event.key === 'ArrowLeft' ? -1 : 1);
  },
};
