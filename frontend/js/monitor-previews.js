/* 样本刷新、媒体队列与元数据交互；由 monitor-core.js 装配，沿用同一份监控状态。 */
window.monitorPreviewsMixin = {
  _invalidatePreviewRequest() {
    this._previewRequestSeq++;
    this.previewsLoading = false;
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
    } catch (_) {
      // Cancellation and transient slow-link failures remain retryable on the
      // next render or when realtime freshness recovers.
      if (next.image && next.image.isConnected) delete next.image.dataset.previewQueued;
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

  async togglePreviewMetadata() {
    this.previewMetadataOpen = !this.previewMetadataOpen;
    this._patchPreviewMetadataPanel();
    if (!this.previewMetadataOpen) return;
    const preview = this.previews[this.previewStep];
    if (!preview || !preview.metadata_url) return;
    const requestSeq = ++this._previewMetadataRequestSeq;
    if (this._previewMetadataAbort) this._previewMetadataAbort.abort();
    const controller = new AbortController();
    this._previewMetadataAbort = controller;
    this.previewMetadataLoading = true;
    this.previewMetadataError = '';
    this._patchPreviewMetadataPanel();
    try {
      const response = await fetch(preview.metadata_url, { cache: 'default', signal: controller.signal });
      const body = await response.json();
      if (requestSeq !== this._previewMetadataRequestSeq) return;
      if (body.status === 'success') this.previewMetadata = body.data;
      else this.previewMetadataError = body.message || this.t('common.failed');
    } catch (_) {
      if (requestSeq === this._previewMetadataRequestSeq) this.previewMetadataError = this.t('common.failed');
    } finally {
      if (requestSeq === this._previewMetadataRequestSeq) {
        this.previewMetadataLoading = false;
        if (this._previewMetadataAbort === controller) this._previewMetadataAbort = null;
        this._patchPreviewMetadataPanel();
      }
    }
  },

  _patchPreviewMetadataPanel() {
    const panel = document.getElementById('previewLightboxMetadata');
    const button = document.getElementById('previewLightboxMetadataButton');
    if (button) button.setAttribute('aria-expanded', this.previewMetadataOpen ? 'true' : 'false');
    if (!panel) return;
    panel.hidden = !this.previewMetadataOpen;
    if (!this.previewMetadataOpen) return;
    if (this.previewMetadataLoading) panel.textContent = this.t('monitor.loading');
    else if (this.previewMetadataError) panel.textContent = this.previewMetadataError;
    else if (this.previewMetadata) {
      const meta = this.previewMetadata;
      let html = '<p>' + this.esc([meta.format, meta.width + ' × ' + meta.height].filter(Boolean).join(' · ')) + '</p><dl>';
      for (const [key, value] of Object.entries(meta.png_text || {}).slice(0, 6)) html += '<dt>' + this.esc(key) + '</dt><dd>' + this.esc(String(value)) + '</dd>';
      panel.innerHTML = html + '</dl><details><summary>' + this.esc(this.t('monitor.rawMetadata')) + '</summary><pre>' + this.esc(JSON.stringify(meta, null, 2)) + '</pre></details>';
    } else panel.textContent = '';
  },

  _resetPreviewMetadata() {
    this._previewMetadataRequestSeq++;
    if (this._previewMetadataAbort) this._previewMetadataAbort.abort();
    this._previewMetadataAbort = null;
    this.previewMetadataOpen = false;
    this.previewMetadataLoading = false;
    this.previewMetadata = null;
    this.previewMetadataError = '';
    this._patchPreviewMetadataPanel();
  },

  // ── 预览样本刷新 ────────────────────────────────────────
  async refreshPreviews() {
    /** 主动重新拉取预览样本（绕过后端 5s 缓存），并自动跟随到最新一张。 */
    if (this.previewsLoading) return;
    this.previewsLoading = true;
    const requestSeq = ++this._previewRequestSeq;
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
        this.previews = j.data || [];
        this.previewsVersion++;
        if (j.meta) {
          const target = this.currentArtifactData();
          target.artifact_available = j.meta.artifact_available;
          if (j.meta.artifact_dir) target.artifact_dir = j.meta.artifact_dir;
          if (j.meta.preview_enabled !== undefined) target.preview_enabled = j.meta.preview_enabled;
        }
        this._followLatestPreview(wasAtEnd);
      }
    } catch (e) {
      /* 静默失败，不打扰用户 */
    } finally {
      if (requestSeq === this._previewRequestSeq) {
        this.previewsLoading = false;
        if (this.currentRoute === 'monitor-dashboard') this.renderDashboard();
      }
    }
  },

  // 预览列表更新后调整 previewStep：
  //   - 之前停在末尾（或为空）→ 跟随到新的末尾，确保最新样本第一时间可见
  //   - 否则保持当前选中（clamp 防越界）
  _followLatestPreview(wasAtEnd) {
    const n = this.previews.length;
    if (n === 0) { this.previewStep = 0; if (this.closePreviewLightbox) this.closePreviewLightbox(); return; }
    if (wasAtEnd) {
      this.previewStep = n - 1;
    } else if (this.previewStep > n - 1) {
      this.previewStep = n - 1;
    }
    const box = document.getElementById('previewLightbox');
    if (box && box.classList.contains('open')) this._updatePreviewLightbox();
  },

  _previewDisplayIndices() {
    const indices = this.previews.map((_, index) => index);
    return this.previewSortDir === 'desc' ? indices.reverse() : indices;
  },

  _patchPreviewSortOrder() {
    const content = document.getElementById('monitorTabContent');
    if (!content) return false;
    const grid = content.querySelector('.m-samples-section .preview-grid');
    if (!grid) return false;
    const items = new Map(Array.from(grid.querySelectorAll('.preview-grid-item')).map(item => [Number(item.dataset.previewIndex), item]));
    const headings = new Map(Array.from(grid.querySelectorAll('[data-preview-group]')).map(item => [item.dataset.previewGroup, item]));
    const seen = new Set();
    for (const index of this._previewDisplayIndices()) {
      const group = this._sampleMetadata(this.previews[index].name).stage;
      if (!seen.has(group) && headings.has(group)) { grid.appendChild(headings.get(group)); seen.add(group); }
      const item = items.get(index);
      if (item) grid.appendChild(item);
    }
    content.querySelectorAll('[data-preview-sort]').forEach(button => {
      const active = button.dataset.previewSort === this.previewSortDir;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    return true;
  },

  _sampleMetadata(filename) {
    const match = String(filename || '').match(/(?:^|_)(e?)(\d{6})_(\d{2})_/i);
    return match ? { stage: (match[1] ? 'Epoch ' : 'Step ') + Number(match[2]), prompt: 'Prompt ' + (Number(match[3]) + 1) } : { stage: '', prompt: '' };
  },

  setPreviewSort(dir) {
    if (dir !== 'asc' && dir !== 'desc') return;
    if (dir === this.previewSortDir) return;
    this.previewSortDir = dir;
    if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'samples' && this._patchPreviewSortOrder()) return;
    this.renderDashboard();
  },
};
