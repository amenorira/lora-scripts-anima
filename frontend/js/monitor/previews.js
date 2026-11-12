/* 样本筛选、刷新与媒体队列；由 monitor-core.js 装配，沿用同一份监控状态。 */
window.monitorPreviewsMixin = {
  samplePromptSelection: '',
  _sampleResetScroll: false, _sampleScrollAnchor: null,
  previewLightboxOpen: false, _previewClosePending: false,
  previewHasNew: false,
  previewRefreshFeedback: false, _previewRefreshFeedbackTimer: null,
  previewViewScale: 1, previewViewX: 0, previewViewY: 0,
  previewViewPanning: false, previewViewPointerId: null,
  _previewPanStartX: 0, _previewPanStartY: 0,
  previewImageLoading: false, previewImageError: false,
  previewReferenceLoading: false, previewReferenceError: false,
  _previewImageKey: '', _previewReferenceImageKey: '', _previewImageRequest: 0, _previewReferenceRequest: 0,

  _previewPromptIdentity(preview) {
    // Only the trainer's complete filename convention is eligible. Custom names
    // remain browsable, but cannot accidentally become members of a prompt group.
    const match = String(preview?.name || '').match(/^(.*?)(e?)(\d{6})_(\d{2})_(\d{14})(?:_(-?\d+))?\.(?:png|jpe?g|webp)$/i);
    if (!match || (match[1] && !match[1].endsWith('_'))) return null;
    return { key: match[1] + ':' + match[4], prefix: match[1], number: Number(match[4]) + 1, seed: match[6] ?? null,
      stage: (match[2] ? 'epoch:' : 'step:') + Number(match[3]) };
  },

  _previewItemKey(preview) {
    return String(preview?.path || preview?.url || preview?.name || '');
  },

  _samplePromptOptions() {
    const groups = new Map();
    let unknown = false;
    this.previews.forEach(preview => {
      const identity = this._previewPromptIdentity(preview);
      if (!identity) { unknown = true; return; }
      const group = groups.get(identity.key) || { ...identity, count: 0 };
      group.count++;
      groups.set(identity.key, group);
    });
    if (groups.size < 2 && !(unknown && groups.size)) return [];
    const entries = [...groups.values()].sort((a, b) => a.number - b.number || a.prefix.localeCompare(b.prefix));
    const numberCounts = new Map();
    entries.forEach(group => numberCounts.set(group.number, (numberCounts.get(group.number) || 0) + 1));
    return [{ value: '', label: this.t('monitor.allSamplePrompts') }, ...entries.map(group => ({
      value: group.key,
      label: this.t('monitor.samplePrompt').replace('{n}', group.number)
        + (numberCounts.get(group.number) > 1 ? ' · ' + (group.prefix.replace(/_$/, '') || '—') : ''),
      count: group.count,
    }))];
  },

  setSamplePromptSelection(value) {
    const next = this._samplePromptOptions().some(option => option.value === value) ? value : '';
    if (next === this.samplePromptSelection) return;
    this.samplePromptSelection = next;
    this._sampleResetScroll = true;
    this.previewsVersion++;
    this.renderDashboard();
  },

  _previewLightboxSequence(items = this.previews) {
    const indices = this._previewDisplayIndices(items);
    if (!this.previewReference) return { indices, samePrompt: false };
    const referenceKey = this._previewItemKey(this.previewReference);
    const candidates = indices.filter(index => this._previewItemKey(items[index]) !== referenceKey);
    const referencePrompt = this._previewPromptIdentity(this.previewReference);
    const currentPrompt = this._previewPromptIdentity(this.previews[this.previewStep]);
    if (referencePrompt && currentPrompt?.key === referencePrompt.key) {
      const samePrompt = candidates.filter(index => this._previewPromptIdentity(items[index])?.key === referencePrompt.key);
      if (samePrompt.length) return { indices: samePrompt, samePrompt: samePrompt.length < candidates.length };
    }
    return { indices: candidates, samePrompt: false };
  },

  _previewLightboxIndices(items = this.previews) {
    return this._previewLightboxSequence(items).indices;
  },

  _invalidatePreviewRequest() {
    this._previewRequestSeq++;
    this._previewSnapshotSeq++;
    this.previewsLoading = false;
  },

  _applyPreviewSnapshot(previews, snapshotSeq = this._previewSnapshotSeq) {
    if (snapshotSeq !== this._previewSnapshotSeq) return false;
    const wasAtEnd = this.previews.length === 0 || this.previewStep >= this.previews.length - 1;
    // A cacheable snapshot must not cancel a forced refresh already in flight.
    this._previewSnapshotSeq++;
    const changed = this._replacePreviewItems(Array.isArray(previews) ? previews : []);
    if (changed) this.previewsVersion++;
    this._followLatestPreview(wasAtEnd);
    return true;
  },

  _replacePreviewItems(items) {
    const previous = this.previews;
    const selectedKey = this._previewItemKey(previous[this.previewStep]);
    const referenceKey = this._previewItemKey(this.previewReference);
    const changed = previous.length !== items.length || previous.some((item, index) => {
      const next = items[index];
      return !next || ['name', 'path', 'version', 'url', 'thumb_url', 'inspect_url', 'metadata_url']
        .some(field => item[field] !== next[field]);
    });
    if (this.previewLightboxOpen && previous.length && items.length) {
      const visible = this._previewLightboxIndices(items);
      const latestIndex = visible.reduce((latest, index) => Math.max(latest, index), -1);
      const latestKey = this._previewItemKey(items[latestIndex]);
      if (latestKey && !previous.some(item => this._previewItemKey(item) === latestKey)) this.previewHasNew = true;
    }
    this.previews = items;
    if (selectedKey) {
      const index = items.findIndex(item => this._previewItemKey(item) === selectedKey);
      if (index >= 0) this.previewStep = index;
    }
    if (referenceKey && !this._previewClosePending) this.previewReference = items.find(item => this._previewItemKey(item) === referenceKey) || null;
    if (this.samplePromptSelection && !this._samplePromptOptions().some(option => option.value === this.samplePromptSelection)) {
      this.samplePromptSelection = '';
    }
    return changed;
  },

  setPreviewMediaPaused(paused) {
    this._previewMediaPaused = !!paused;
    if (paused) {
      this._cancelPreviewMediaQueue();
      return;
    }
    if (this.currentRoute !== 'monitor-dashboard' || this.monitorTab !== 'samples') return;
    const content = document.getElementById('monitorTabContent');
    if (content) this.schedulePreviewMediaLoads(content);
  },

  _cancelPreviewMediaQueue() {
    this._previewMediaGeneration++;
    for (const item of this._previewMediaQueue) delete item.image.dataset.previewQueued;
    if (this._previewMediaActive) delete this._previewMediaActive.dataset.previewQueued;
    this._previewMediaActive = null;
    if (this._previewMediaObserver) this._previewMediaObserver.disconnect();
    this._previewMediaObserver = null;
    this._previewMediaQueue = [];
    if (this._previewMediaAbort) this._previewMediaAbort.abort();
    this._previewMediaAbort = null;
    this._previewMediaLoading = false;
  },

  schedulePreviewMediaLoads(root) {
    if (!this.weakNetworkMode || this._previewMediaPaused || !root) return;
    const enqueue = image => {
      const url = image.dataset.previewUrl;
      if (!url || image.dataset.previewLoaded === '1' || image.dataset.previewQueued === '1') return;
      image.dataset.previewQueued = '1';
      this._previewMediaQueue.push({ image, url });
    };
    if (!this._previewMediaObserver && typeof IntersectionObserver !== 'undefined') {
      this._previewMediaObserver = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) enqueue(entry.target);
        this._drainPreviewMediaQueue();
      }, { rootMargin: '320px' });
    }
    const images = Array.from(root.querySelectorAll('img[data-preview-url]'));
    for (const image of images) {
      if (image.dataset.previewLoaded === '1') continue;
      if (this._previewMediaObserver) this._previewMediaObserver.observe(image);
      else enqueue(image);
    }
    this._drainPreviewMediaQueue();
  },

  async _drainPreviewMediaQueue() {
    if (this._previewMediaLoading || this._previewMediaPaused || !this.weakNetworkMode) return;
    const next = this._previewMediaQueue.shift();
    if (!next) return;
    const generation = this._previewMediaGeneration;
    this._previewMediaLoading = true;
    this._previewMediaActive = next.image;
    const controller = new AbortController();
    this._previewMediaAbort = controller;
    try {
      // `priority` is ignored by browsers that do not implement fetch priority;
      // serialisation and cancellation still provide the weak-link guarantee.
      const response = await fetch(next.url, { cache: 'default', signal: controller.signal, priority: 'low' });
      if (!response.ok) throw new Error('preview request failed');
      const blob = await response.blob();
      if (generation === this._previewMediaGeneration && next.image.isConnected && next.image.dataset.previewUrl === next.url && !this._previewMediaPaused) {
        const objectUrl = URL.createObjectURL(blob);
        this._previewMediaObjectUrls.push(objectUrl);
        next.image.src = objectUrl;
        next.image.dataset.previewLoaded = '1';
        if (this._previewMediaObserver) this._previewMediaObserver.unobserve(next.image);
      }
    } catch (error) {
      // Cancellation and transient slow-link failures remain retryable on the
      // next render or when realtime freshness recovers.
      if (next.image && next.image.isConnected) {
        delete next.image.dataset.previewQueued;
        if (error?.name !== 'AbortError' && generation === this._previewMediaGeneration) next.image.closest?.('.preview-thumb-frame')?.classList.add('is-error');
      }
    } finally {
      if (generation !== this._previewMediaGeneration || this._previewMediaAbort !== controller) return;
      this._previewMediaAbort = null;
      this._previewMediaActive = null;
      this._previewMediaLoading = false;
      if (!this._previewMediaPaused) this._drainPreviewMediaQueue();
    }
  },

  _releasePreviewMediaObjectUrls() {
    for (const url of this._previewMediaObjectUrls) URL.revokeObjectURL(url);
    this._previewMediaObjectUrls = [];
  },

  // Retain successfully decoded, versioned thumbnails across a grid rebuild.
  // The complete URL includes the run and file version, so overwritten files
  // and samples from another run will still be fetched again.
  _capturePreviewMedia(root) {
    const loaded = new Map();
    const owned = new Set(this._previewMediaObjectUrls);
    if (!root) return loaded;
    for (const image of root.querySelectorAll('img[data-preview-url]')) {
      const url = image.dataset.previewUrl || '';
      const path = image.closest('.preview-grid-item')?.dataset.previewPath;
      const src = image.getAttribute('src');
      if (path && /[?&]v=[^&]+/.test(url) && image.dataset.previewLoaded === '1'
          && image.complete && image.naturalWidth > 0 && owned.has(src)
          && !image.closest('.preview-thumb-frame')?.classList.contains('is-error')) {
        loaded.set(JSON.stringify([path, url]), src);
      }
    }
    return loaded;
  },

  _restorePreviewMedia(root, loaded) {
    const retained = new Set();
    if (root) for (const image of root.querySelectorAll('img[data-preview-url]')) {
      const path = image.closest('.preview-grid-item')?.dataset.previewPath;
      const src = loaded.get(JSON.stringify([path, image.dataset.previewUrl]));
      if (!src) continue;
      image.src = src;
      image.dataset.previewLoaded = '1';
      retained.add(src);
    }
    this._previewMediaObjectUrls = this._previewMediaObjectUrls.filter(url => {
      if (retained.has(url)) return true;
      URL.revokeObjectURL(url);
      return false;
    });
  },

  // ── 预览样本刷新 ────────────────────────────────────────
  async refreshPreviews(notifyOnFailure = true) {
    /** 主动重新拉取预览样本（绕过后端 5s 缓存）。 */
    if (this.previewsLoading) return;
    // A local refresh can finish before the first frame. Keep the click
    // feedback visible briefly without holding the request or its results.
    if (notifyOnFailure) {
      this.previewRefreshFeedback = true;
      clearTimeout(this._previewRefreshFeedbackTimer);
      this._previewRefreshFeedbackTimer = setTimeout(() => {
        this.previewRefreshFeedback = false;
        this._previewRefreshFeedbackTimer = null;
      }, 800);
    }
    this.previewsLoading = true;
    const requestSeq = ++this._previewRequestSeq;
    this._previewSnapshotSeq++;
    const sourceRunDir = this.currentOutputRunDir;
    const sourceTaskId = this.taskId;
    const isCurrent = () => requestSeq === this._previewRequestSeq
      && sourceRunDir === this.currentOutputRunDir
      && (sourceRunDir || sourceTaskId === this.taskId);
    const wasAtEnd = this.previews.length === 0 || this.previewStep >= this.previews.length - 1;
    try {
      // ``limit=0`` means all compact preview metadata. Image bytes continue
      // through the thumbnail queue (or normal browser loading when disabled).
      let url = '/api/monitor/previews?refresh=1&limit=0';
      const runDir = this.currentOutputRunDir;
      if (runDir) {
        url += '&run_dir=' + encodeURIComponent(runDir);
      } else if (this.taskId) {
        url += '&task_id=' + encodeURIComponent(this.taskId);
      }
      const r = await fetch(url);
      const j = await r.json();
      if (!isCurrent()) return;
      if (j.status === 'success') {
        // Reject snapshots started during the refresh if they arrive after it.
        this._previewSnapshotSeq++;
        const changed = this._replacePreviewItems(j.data || []);
        const failedMedia = notifyOnFailure && document.getElementById('monitorTabContent')?.querySelector('.preview-thumb-frame.is-error');
        if (changed || failedMedia) this.previewsVersion++;
        if (j.meta) {
          const target = this.currentArtifactData();
          target.artifact_available = j.meta.artifact_available;
          if (j.meta.artifact_dir) target.artifact_dir = j.meta.artifact_dir;
          if (j.meta.preview_enabled !== undefined) target.preview_enabled = j.meta.preview_enabled;
        }
        this._followLatestPreview(wasAtEnd);
      } else if (notifyOnFailure) this.toast?.(this.t('monitor.previewRefreshFailed'), 'error');
    } catch (e) {
      if (notifyOnFailure && isCurrent()) this.toast?.(this.t('monitor.previewRefreshFailed'), 'error');
    } finally {
      if (requestSeq === this._previewRequestSeq) {
        this.previewsLoading = false;
        if (this.currentRoute === 'monitor-dashboard') this.renderDashboard();
      }
    }
  },

  // Keep an open viewer on its selected image; only an idle viewer follows the latest.
  _followLatestPreview(wasAtEnd) {
    if (this._previewClosePending) return;
    const n = this.previews.length;
    if (n === 0) { this.previewStep = 0; if (this.closePreviewLightbox) this.closePreviewLightbox(); return; }
    let indices = this._previewLightboxIndices();
    if (this.previewReference && !indices.length) {
      this.previewReference = null;
      indices = this._previewLightboxIndices();
    }
    if (this.previewLightboxOpen && indices.length && !indices.includes(this.previewStep)) this.previewStep = indices[0];
    if (!this.previewLightboxOpen && !this.samplePromptSelection && wasAtEnd) {
      this.previewStep = n - 1;
    } else if (this.previewStep > n - 1) {
      this.previewStep = n - 1;
    }
    if (this.previewLightboxOpen) this._updatePreviewLightbox();
  },

  _previewDisplayIndices(items = this.previews) {
    const indices = items.map((_, index) => index).filter(index => !this.samplePromptSelection
      || this._previewPromptIdentity(items[index])?.key === this.samplePromptSelection);
    return this.previewSortDir === 'desc' ? indices.reverse() : indices;
  },

  _patchPreviewSortOrder() {
    const content = document.getElementById('monitorTabContent');
    if (!content) return false;
    const grid = content.querySelector('.m-samples-section .preview-grid');
    if (!grid) return false;
    const items = new Map(Array.from(grid.querySelectorAll('.preview-grid-item')).map(item => [Number(item.dataset.previewIndex), item]));
    for (const index of this._previewDisplayIndices()) {
      const item = items.get(index);
      if (item) grid.appendChild(item);
    }
    grid.scrollTop = 0;
    this._sampleScrollAnchor = null;
    content.querySelectorAll('[data-preview-sort]').forEach(button => {
      const active = button.dataset.previewSort === this.previewSortDir;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    return true;
  },

  _sampleMetadata(filename) {
    const match = String(filename || '').match(/(?:^|_)(e?)(\d{6})_(\d{2})_/i);
    if (!match) return { stage: '', stageLabel: '', prompt: '' };
    const kind = match[1] ? 'epoch' : 'step';
    return {
      stage: kind + ':' + Number(match[2]),
      stageLabel: this.t(match[1] ? 'monitor.sampleEpoch' : 'monitor.sampleStep').replace('{n}', Number(match[2])),
      prompt: this.t('monitor.samplePrompt').replace('{n}', Number(match[3]) + 1),
    };
  },

  setPreviewSort(dir) {
    if (dir !== 'asc' && dir !== 'desc') return;
    if (dir === this.previewSortDir) return;
    this.previewSortDir = dir;
    if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'samples' && this._patchPreviewSortOrder()) return;
    this.renderDashboard();
  },
};
