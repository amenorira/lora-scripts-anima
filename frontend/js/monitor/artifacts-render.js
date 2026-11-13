/* 训练样本、预览灯箱与输出文件视图；由 monitor-render.js 装配。 */
window.monitorArtifactsRenderMixin = {
  _previewFullImageUrl(preview) {
    // Browser-native originals avoid re-encoding full-resolution samples.
    return (/\.tiff?$/i.test(preview.name) ? preview.inspect_url : preview.url) || preview.inspect_url || preview.url;
  },
  _previewThumbImageHtml(preview) {
    const imageUrl = preview.thumb_url || preview.url;
    const common = ' alt="' + this.esc(preview.name) + '" loading="lazy" decoding="async" fetchpriority="low"'
      + ' @load="$el.parentElement.classList.remove(\'is-error\')" @error="$el.parentElement.classList.add(\'is-error\')"';
    if (this.weakNetworkMode) {
      return '<img data-preview-url="' + this.esc(imageUrl) + '"' + common + '/>';
    }
    return '<img src="' + this.esc(imageUrl) + '"' + common + '/>';
  },

  _formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0; let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return size.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  },

  _artifactLocationHtml(t, d) {
    if (!d || d.artifact_available !== false || !d.artifact_dir) return '';
    let html = '<div class="m-artifact-location is-offline">';
    html += '<span class="m-badge m-badge-danger"><i aria-hidden="true"></i>' + this.esc(t('artifactOffline')) + '</span>';
    html += '<code title="' + this.esc(d.artifact_dir) + '">' + this.esc(d.artifact_dir) + '</code>';
    html += '<small>' + this.esc(t('artifactOfflineHint')) + '</small>';
    html += '</div>';
    return html;
  },

  _monitorRefreshButtonHtml(t, type) {
    const sample = type === 'sample';
    const log = type === 'log';
    const id = sample ? 'sampleRefresh' : log ? 'logRefresh' : 'outputRefresh';
    const action = sample ? 'refreshPreviews' : log ? 'refreshFullLog' : 'refreshOutputFiles';
    const loading = sample ? 'previewsLoading' : log ? 'logFullLoading' : 'outputFilesLoading';
    const feedback = sample ? 'previewRefreshFeedback' : log ? 'logRefreshFeedback' : 'outputRefreshFeedback';
    const disabled = log ? 'false' : '!currentOutputRunDir';
    return '<button type="button" id="' + id + '" class="btn btn-sm btn-secondary refresh-button"'
      + (!log && !this.currentOutputRunDir ? ' disabled' : '')
      + ' :class="{ \'is-loading\': ' + loading + ' || ' + feedback + ' }" @click="' + action + '()" :disabled="' + disabled + '"'
      + ' :aria-disabled="' + loading + ' || ' + disabled + ' ? \'true\' : \'false\'" :aria-busy="' + loading + ' ? \'true\' : \'false\'">'
      + this._refreshIconHtml()
      + '<span>' + this.esc(t('refresh')) + '</span><span class="m-number-accessible" role="status" aria-live="polite" x-text="' + loading + ' ? t(\'monitor.loading\') : \'\'"></span></button>';
  },

  // ═══════════════════════════════════════════════════════════
  //  样本标签
  // ═══════════════════════════════════════════════════════════
  _renderSamplesTab(t) {
    const isHistory = !!this.selectedRunDir;
    const d = isHistory ? (this.runDetailData||{}) : (this.monitorData||{});
    const showPreviews = this.previews.length > 0;
    const displayIndices = this._previewDisplayIndices();
    const lastIdx = displayIndices.reduce((latest, index) => Math.max(latest, index), -1);

    const promptOptions = this._samplePromptOptions();
    let html = '<div class="m-section m-samples-section"><div class="m-view-header m-samples-toolbar"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t('previewSamples')) + '</span>' + (showPreviews ? '<span class="m-logs-count">' + this.previews.length + '</span>' : '') + '</div>';
    html += '<div class="m-view-actions">';
    if (promptOptions.length && window.previewSelectHtml) {
      html += '<div class="m-sample-prompt-select" @preview-select="setSamplePromptSelection($event.detail)">'
        + window.previewSelectHtml(promptOptions, this.samplePromptSelection, t('samplePromptFilter'), 'samplePromptTrigger') + '</div>';
    }
    html += '<div class="m-segmented m-sample-sort" role="group" aria-label="' + this.esc(t('sampleOrder')) + '">';
    html += '<button type="button" data-preview-sort="asc" aria-pressed="' + (this.previewSortDir === 'asc' ? 'true' : 'false') + '" class="m-segmented-btn' + (this.previewSortDir === 'asc' ? ' active' : '') + '" @click="setPreviewSort(\'asc\')">' + this.esc(t('trainingOrder')) + '</button>';
    html += '<button type="button" data-preview-sort="desc" aria-pressed="' + (this.previewSortDir === 'desc' ? 'true' : 'false') + '" class="m-segmented-btn' + (this.previewSortDir === 'desc' ? ' active' : '') + '" @click="setPreviewSort(\'desc\')">' + this.esc(t('latestFirst')) + '</button></div>';
    html += this._monitorRefreshButtonHtml(t, 'sample') + '</div>';
    html += '</div>';
    html += this._artifactLocationHtml(t, d);
    if (showPreviews) {
      html += '<div class="preview-grid">';
      displayIndices.forEach(i => {
        const pv = this.previews[i];
        const info = this._sampleMetadata(pv.name);
        const key = this._previewItemKey(pv);
        const id = 'sample-' + encodeURIComponent(key);
        html += '<button type="button" id="' + this.esc(id) + '" class="preview-grid-item" data-preview-path="' + this.esc(key) + '" data-preview-index="' + i + '" data-dialog-opens="previewLightbox" @click="openPreviewLightbox(' + i + ')">';
        html += '<span class="preview-thumb-frame">' + this._previewThumbImageHtml(pv)
          + '<span class="preview-thumb-error">' + this.esc(t('previewImageFailed')) + '</span>';
        if (i === lastIdx) html += '<span class="preview-thumb-fresh">' + this.esc(t('latest')) + '</span>';
        html += '</span><span class="preview-grid-item-label" title="' + this.esc(pv.name) + '"><strong>' + this.esc(info.stageLabel || pv.name) + '</strong>'
          + (info.prompt && promptOptions.length && !this.samplePromptSelection ? '<small>' + this.esc(info.prompt) + '</small>' : '') + '</span>';
        html += '</button>';
      });
      html += '</div>';
    } else {
      // 区分空态场景：实时无训练 / 实时训练中未生成样本 / 历史记录无样本
      let hintKey, hintFallback;
      if (d.artifact_dir && d.artifact_available === false) {
        hintKey = 'monitor.noPreviewArtifactUnavailableHint';
        hintFallback = 'The output folder is unavailable. Restore the path and refresh to view preview images.';
      } else if (d.preview_enabled === false) {
        hintKey = 'monitor.noPreviewDisabledHint';
        hintFallback = 'Preview generation was not enabled for this run.';
      } else if (isHistory) {
        hintKey = 'monitor.noPreviewHistoryHint';
        hintFallback = 'No preview samples in this run';
      } else if (d.state === 'RUNNING') {
        hintKey = 'monitor.noPreviewRunningHint';
        hintFallback = 'Preview images will appear after the first sample step';
      } else {
        hintKey = 'monitor.noPreviewHint';
        hintFallback = 'Preview images appear during training';
      }
      html += '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><p>' + this.esc(t(hintKey, hintFallback)) + '</p></div>';
    }
    html += '</div>';
    return html;
  },

  // ═══════════════════════════════════════════════════════════
  //  预览灯箱：DOM 模板 + 开/关/翻页
  // ═══════════════════════════════════════════════════════════
  _previewLightboxHtml(t) {
    const svg = path => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
    const zoomOut = svg('<circle cx="11" cy="11" r="7"/><path d="M8 11h6m3 6 4 4"/>');
    const zoomIn = svg('<circle cx="11" cy="11" r="7"/><path d="M8 11h6m-3-3v6m6 3 4 4"/>');
    const close = svg('<path d="M6 6l12 12M18 6 6 18"/>');
    const left = svg('<path d="m15 18-6-6 6-6"/>');
    const right = svg('<path d="m9 18 6-6-6-6"/>');
    const stage = (reference = false) => '<div class="preview-view-stage" :class="{ zoomed: previewViewScale > 1, panning: previewViewPanning }"'
      + ' @wheel.prevent="zoomPreviewView($event)" @pointerdown="startPreviewPan($event)" @pointermove="movePreviewPan($event)" @pointerup="stopPreviewPan($event)" @pointercancel="stopPreviewPan($event)" @dblclick.prevent="resetPreviewView()">'
      + '<img id="' + (reference ? 'previewReferenceImg' : 'previewLightboxImg') + '" class="preview-view-image" alt="" draggable="false" @load="constrainPreviewView()" :style="\'transform:\' + previewViewTransform()">'
      + '<span class="preview-view-spinner" x-show="' + (reference ? 'previewReferenceLoading' : 'previewImageLoading') + '" aria-hidden="true"></span>'
      + '<button type="button" class="preview-view-error" x-show="' + (reference ? 'previewReferenceError' : 'previewImageError') + '" @click.stop="retryPreviewImage(' + (reference ? 'true' : 'false') + ')">' + this.esc(t('previewImageRetry')) + '</button></div>';
    return '<dialog class="preview-lightbox" id="previewLightbox" x-dialog="previewLightboxOpen" @dialog-close="closePreviewLightbox()" @dialog-after-close="clearPreviewLightbox()" @keydown="previewLightboxKeydown($event)" @resize.window="constrainPreviewView()" aria-label="' + this.esc(t('previewSamples')) + '" x-cloak>'
      + '<div class="preview-lightbox-topbar"><div class="preview-lightbox-leading"><button type="button" class="preview-new-samples" x-show="previewHasNew" @click="jumpToLatestPreview()">' + this.esc(t('previewNewSamples')) + '</button><span id="previewLightboxScope" class="preview-lightbox-scope" hidden></span></div>'
      + '<div class="preview-lightbox-heading"><button type="button" class="preview-lightbox-nav prev" @click="previewLightboxNav(-1)" title="' + this.esc(this.t('imageViewer.previousHint')) + '" aria-label="' + this.esc(t('prev')) + '" aria-keyshortcuts="ArrowLeft">' + left + '</button>'
      + '<div class="preview-lightbox-heading-text"><strong id="previewLightboxLabel"></strong><span id="previewLightboxCounter" class="preview-lightbox-counter"></span></div>'
      + '<button type="button" class="preview-lightbox-nav next" @click="previewLightboxNav(1)" title="' + this.esc(this.t('imageViewer.nextHint')) + '" aria-label="' + this.esc(t('next')) + '" aria-keyshortcuts="ArrowRight">' + right + '</button></div>'
      + '<div class="preview-lightbox-tools">'
      + '<button type="button" id="previewReferenceButton" class="preview-tool-action" :class="{ active: !!previewReference }" @click="togglePreviewReference()" x-text="previewReference ? t(\'monitor.clearReference\') : t(\'monitor.pinReference\')"></button>'
      + '<a class="preview-tool-action" id="previewLightboxOriginal" target="_blank" rel="noopener">' + this.esc(t('openOriginal')) + '</a>'
      + '<span class="preview-tool-divider"></span>'
      + '<button type="button" class="preview-icon-button" @click="setPreviewViewScale(previewViewScale / 1.18)" :disabled="previewViewScale <= 1" title="' + this.esc(this.t('tagEditor.zoomOut')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomOut')) + '">' + zoomOut + '</button>'
      + '<button type="button" class="preview-zoom-value" @click="resetPreviewView()" title="' + this.esc(this.t('imageViewer.zoomHint')) + '" aria-keyshortcuts="0" x-text="previewViewScale <= 1 ? t(\'imageViewer.fit\') : Math.round(previewViewScale * 100) + \'%\'"></button>'
      + '<button type="button" class="preview-icon-button" @click="setPreviewViewScale(previewViewScale * 1.18)" :disabled="previewViewScale >= 8" title="' + this.esc(this.t('tagEditor.zoomIn')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomIn')) + '">' + zoomIn + '</button>'
      + '<button type="button" class="preview-icon-button preview-close" data-dialog-autofocus @click="closePreviewLightbox()" title="' + this.esc(this.t('imageViewer.closeHint')) + '" aria-label="' + this.esc(t('close')) + '" aria-keyshortcuts="Escape">' + close + '</button></div></div>'
      + '<div class="preview-lightbox-body"><div class="preview-lightbox-canvas">'
      + '<div class="preview-lightbox-panes" :class="{ comparing: !!previewReference }"><div class="preview-lightbox-pane"><div class="preview-pane-caption" id="previewCurrentCaption" hidden><span>' + this.esc(t('currentSample')) + '</span><strong id="previewCurrentLabel"></strong></div>' + stage() + '</div>'
      + '<div class="preview-lightbox-pane" id="previewReferencePane" hidden><div class="preview-pane-caption"><span>' + this.esc(t('reference')) + '</span><strong id="previewReferenceLabel"></strong></div>' + stage(true) + '</div></div>'
      + '</div></div></dialog>';
  },

  openPreviewLightbox(i) {
    if (!this.previews.length) return;
    if (!this.previewLightboxOpen) this.clearPreviewLightbox();
    this.previewStep = Math.max(0, Math.min(i, this.previews.length - 1));
    const box = document.getElementById('previewLightbox');
    if (!box) return;
    this.previewHasNew = false;
    this.previewLightboxOpen = true;
    this.resetPreviewView();
    this._updatePreviewLightbox();
  },

  closePreviewLightbox() {
    if (!this.previewLightboxOpen) return;
    this.previewLightboxOpen = false;
    this._previewClosePending = true;
    ++this._previewImageRequest;
    ++this._previewReferenceRequest;
    const image = document.getElementById('previewLightboxImg');
    if (image) window.AnimaImages.cancel(image);
    const reference = document.getElementById('previewReferenceImg');
    if (reference) window.AnimaImages.cancel(reference);
  },

  clearPreviewLightbox() {
    if (this.previewLightboxOpen) return;
    const image = document.getElementById('previewLightboxImg');
    if (image) { window.AnimaImages.cancel(image); image.removeAttribute('src'); }
    const reference = document.getElementById('previewReferenceImg');
    if (reference) { window.AnimaImages.cancel(reference); reference.removeAttribute('src'); }
    this._previewClosePending = false;
    this.previewReference = null;
    this.previewHasNew = false;
    this._previewImageKey = '';
    this._previewReferenceImageKey = '';
    this.previewImageLoading = this.previewImageError = false;
    this.previewReferenceLoading = this.previewReferenceError = false;
    this.resetPreviewView();
  },

  togglePreviewReference() {
    if (this.previewReference) {
      this.previewReference = null;
    } else {
      const current = this.previews[this.previewStep];
      if (!current) return;
      const indices = this._previewLightboxIndices();
      const position = indices.indexOf(this.previewStep);
      const alternatives = [...indices.slice(position + 1), ...indices.slice(0, Math.max(0, position)).reverse()];
      if (!alternatives.length) return;
      const identity = this._previewPromptIdentity(current);
      const samePrompt = identity && alternatives.find(index => this._previewPromptIdentity(this.previews[index])?.key === identity.key);
      this.previewReference = current;
      this.previewStep = samePrompt ?? alternatives[0];
      this.previewHasNew = false;
    }
    this._updatePreviewLightbox();
  },

  previewLightboxNav(dir) {
    if (!this.previews.length) return;
    const indices = this._previewLightboxIndices();
    if (!indices.length) return;
    const current = Math.max(0, indices.indexOf(this.previewStep));
    const nextPosition = Math.max(0, Math.min(current + dir, indices.length - 1));
    const next = indices[nextPosition];
    if (next === this.previewStep) return;
    this.previewStep = next;
    this._updatePreviewLightbox();
  },

  jumpToLatestPreview() {
    const indices = this._previewLightboxIndices();
    if (!indices.length) return;
    this.previewStep = indices.reduce((latest, index) => Math.max(latest, index), 0);
    this.previewHasNew = false;
    this._updatePreviewLightbox();
  },

  previewLightboxKeydown(event) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); this.previewLightboxNav(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault(); this.setPreviewViewScale(this.previewViewScale * 1.18);
    } else if (event.key === '-') {
      event.preventDefault(); this.setPreviewViewScale(this.previewViewScale / 1.18);
    } else if (event.key === '0') {
      event.preventDefault(); this.resetPreviewView();
    }
  },

  previewViewTransform() {
    return 'translate3d(' + this.previewViewX + 'px,' + this.previewViewY + 'px,0) scale(' + this.previewViewScale + ')';
  },

  resetPreviewView() {
    this.previewViewScale = 1; this.previewViewX = 0; this.previewViewY = 0;
    this.previewViewPanning = false; this.previewViewPointerId = null;
  },

  _previewViewStages(fallback) {
    const box = typeof document !== 'undefined' ? document.getElementById('previewLightbox') : null;
    const stages = Array.from(box?.querySelectorAll?.('.preview-view-stage') || []);
    return stages.length ? stages : fallback ? [fallback] : [];
  },

  constrainPreviewView(fallback) {
    if (!this.previewLightboxOpen && !fallback) return;
    const view = window.AnimaImageViewport.constrain({ scale: this.previewViewScale, x: this.previewViewX, y: this.previewViewY }, this._previewViewStages(fallback));
    this.previewViewX = view.x; this.previewViewY = view.y;
  },

  setPreviewViewScale(next, event) {
    const anchor = event ? window.AnimaImageViewport.pointerAnchor(event, event.currentTarget) : null;
    const view = window.AnimaImageViewport.zoom({ scale: this.previewViewScale, x: this.previewViewX, y: this.previewViewY }, next, anchor);
    this.previewViewScale = view.scale; this.previewViewX = view.x; this.previewViewY = view.y;
    this.constrainPreviewView(event?.currentTarget);
  },

  zoomPreviewView(event) {
    this.setPreviewViewScale(this.previewViewScale * (event.deltaY < 0 ? 1.18 : 1 / 1.18), event);
  },

  startPreviewPan(event) {
    if (event.button !== 0 || this.previewViewScale <= 1 || event.target.closest?.('button')) return;
    this.previewViewPanning = true; this.previewViewPointerId = event.pointerId;
    this._previewPanStartX = event.clientX - this.previewViewX; this._previewPanStartY = event.clientY - this.previewViewY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  },

  movePreviewPan(event) {
    if (!this.previewViewPanning || event.pointerId !== this.previewViewPointerId) return;
    this.previewViewX = event.clientX - this._previewPanStartX; this.previewViewY = event.clientY - this._previewPanStartY;
    this.constrainPreviewView(event.currentTarget);
    this._previewPanStartX = event.clientX - this.previewViewX; this._previewPanStartY = event.clientY - this.previewViewY;
  },

  stopPreviewPan(event) {
    if (event && this.previewViewPointerId !== null) event.currentTarget.releasePointerCapture?.(this.previewViewPointerId);
    this.previewViewPanning = false; this.previewViewPointerId = null;
  },

  retryPreviewImage(reference) {
    if (reference) this._previewReferenceImageKey = '';
    else this._previewImageKey = '';
    this._updatePreviewLightbox();
  },

  _displayPreviewImage(element, preview, reference = false) {
    if (!element || !preview) return;
    const key = this._previewItemKey(preview) + '|' + (preview.version || '') + '|' + this._previewFullImageUrl(preview);
    const keyField = reference ? '_previewReferenceImageKey' : '_previewImageKey';
    if (this[keyField] === key) return;
    this[keyField] = key;
    const requestField = reference ? '_previewReferenceRequest' : '_previewImageRequest';
    const loadingField = reference ? 'previewReferenceLoading' : 'previewImageLoading';
    const errorField = reference ? 'previewReferenceError' : 'previewImageError';
    const request = ++this[requestField];
    this[loadingField] = true; this[errorField] = false;
    element.alt = reference ? this.t('monitor.reference') + ': ' + preview.name : preview.name;
    window.AnimaImages.display(element, this._previewFullImageUrl(preview), preview.thumb_url).then(success => {
      if (request !== this[requestField] || !this.previewLightboxOpen) return;
      this[loadingField] = false; this[errorField] = !success;
    });
  },

  _updatePreviewLightbox() {
    const n = this.previews.length;
    if (!n) return;
    const p = this.previews[this.previewStep] || this.previews[0];
    const img = document.getElementById('previewLightboxImg');
    this._displayPreviewImage(img, p);
    const reference = document.getElementById('previewReferenceImg');
    const referencePane = document.getElementById('previewReferencePane');
    const currentCaption = document.getElementById('previewCurrentCaption');
    if (referencePane) referencePane.hidden = !this.previewReference;
    if (currentCaption) currentCaption.hidden = !this.previewReference;
    if (reference) {
      if (this.previewReference) {
        this._displayPreviewImage(reference, this.previewReference, true);
      } else {
        ++this._previewReferenceRequest; this._previewReferenceImageKey = '';
        this.previewReferenceLoading = this.previewReferenceError = false;
        window.AnimaImages.cancel(reference); reference.removeAttribute('src');
      }
    }
    const referenceLabel = document.getElementById('previewReferenceLabel');
    if (referenceLabel) referenceLabel.textContent = this.previewReference ? this._previewCompareLabel(this.previewReference) : '';
    const currentLabel = document.getElementById('previewCurrentLabel');
    if (currentLabel) currentLabel.textContent = this._previewCompareLabel(p);
    const original = document.getElementById('previewLightboxOriginal');
    if (original) {
      original.hidden = !p.url;
      if (p.url) original.href = p.url;
      else original.removeAttribute('href');
    }
    const c = document.getElementById('previewLightboxCounter');
    const { indices, samePrompt } = this._previewLightboxSequence();
    const displayPosition = Math.max(0, indices.indexOf(this.previewStep));
    if (c) {
      c.textContent = (displayPosition + 1) + ' / ' + indices.length;
      c.title = samePrompt ? this.t('monitor.previewSamePromptHint') : '';
    }
    const scope = document.getElementById('previewLightboxScope');
    if (scope) {
      scope.hidden = !samePrompt;
      scope.textContent = samePrompt ? this.t('monitor.previewSamePrompt') : '';
      scope.title = samePrompt ? this.t('monitor.previewSamePromptHint') : '';
    }
    const referenceButton = document.getElementById('previewReferenceButton');
    if (referenceButton) referenceButton.disabled = !this.previewReference && indices.length < 2;
    const lbl = document.getElementById('previewLightboxLabel');
    if (lbl) {
      const label = this._parseSampleInfo(p.name);
      lbl.textContent = label;
      lbl.title = label === p.name ? p.name : label + '\n' + p.name;
    }
    const box = document.getElementById('previewLightbox');
    if (box) {
      const prevBtn = box.querySelector('.preview-lightbox-nav.prev');
      const nextBtn = box.querySelector('.preview-lightbox-nav.next');
      if (prevBtn) prevBtn.disabled = displayPosition <= 0;
      if (nextBtn) nextBtn.disabled = displayPosition >= indices.length - 1;
    }
    this.constrainPreviewView();
  },

  _parseSampleInfo(filename) {
    const info = this._sampleMetadata(filename);
    return [info.stageLabel, info.prompt].filter(Boolean).join(' · ') || filename;
  },

  _previewCompareLabel(preview) {
    const identity = this._previewPromptIdentity(preview);
    return this._parseSampleInfo(preview.name) + (identity?.seed != null ? ' · ' + this.t('monitor.sampleSeed').replace('{n}', identity.seed) : '');
  },

  // ═══════════════════════════════════════════════════════════
  //  输出标签
  // ═══════════════════════════════════════════════════════════
  _renderOutputsTab(t) {
    const d = this.currentArtifactData();
    const runDir = this.currentOutputRunDir;
    const artifactUnavailable = !!runDir && (d.artifact_available === false || this.outputFilesError === 'artifactUnavailable');
    const canUseFiles = !!runDir && !artifactUnavailable && this.outputFiles.length > 0;
    const visibleFiles = this._visibleOutputFiles();
    const visibleCount = visibleFiles.length;
    const selectedCount = this.selectedOutputFiles.length;
    const hiddenSelected = selectedCount - visibleFiles.filter(f => this.outputFilesSelected[f.path]).length;
    let html = '<div class="m-section m-outputs-section">';
    if (this.outputFilesLoading && !this.outputFiles.length && !this._outputFilesLoaded) {
      return html + '<div class="dashboard-empty m-output-loading" role="status" style="padding:48px"><p>' + this.esc(t('loading')) + '</p></div></div>';
    }
    html += '<div class="m-view-header"><div class="m-output-toolbar-top"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t('outputs')) + '</span>' + (this.outputFiles.length ? '<span class="m-logs-count">' + this.outputFiles.length + '</span>' : '') + '</div>';
    html += this._monitorRefreshButtonHtml(t, 'output');
    html += '<div class="m-output-selection-tools"><span class="m-output-selection-count" role="status">' + this.esc(t('selected')) + ' <strong>' + selectedCount + '</strong> / ' + this.outputFiles.length;
    if (hiddenSelected > 0) html += '<small>' + this.esc(t('hiddenSelectedOutputs').replace('{n}', hiddenSelected)) + '</small>';
    html += '</span><button type="button" id="outputClearSelection" class="btn btn-sm btn-secondary" @click="deselectAllOutputFiles()"' + (!selectedCount ? ' disabled' : '') + '>' + this.esc(t('clearSelection')) + '</button>';
    html += '<button type="button" id="outputDownload" class="btn btn-sm btn-primary m-output-download"' + (this.outputFilesLoading || !canUseFiles ? ' disabled' : '') + ' @click="' + (selectedCount ? 'downloadSelectedOutputs()' : 'downloadAllOutputs()') + '" :disabled="outputFilesLoading || ' + (!canUseFiles) + '"><span' + (selectedCount ? ' class="is-hidden"' : '') + '>' + this.esc(t('downloadAll')) + '</span><span' + (!selectedCount ? ' class="is-hidden"' : '') + '>' + this.esc(t('downloadSelected')) + '</span></button></div></div>';
    html += '<div class="m-view-actions m-output-toolbar-filters">';
    html += '<label class="m-output-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="m-output-search-input" type="search" value="' + this.esc(this.outputSearch) + '" aria-label="' + this.esc(t('searchOutputs')) + '" placeholder="' + this.esc(t('searchOutputs')) + '" @input.debounce.180ms="setOutputSearch($event.target.value)"></label>';
    html += '<div class="m-segmented" role="group" aria-label="' + this.esc(t('outputFilter')) + '">';
    [['all', t('filterAll')], ['models', t('filterModels')], ['others', t('filterOthers')]].forEach(item => {
      html += '<button type="button" id="outputFilter-' + item[0] + '" aria-pressed="' + (this.outputFilter === item[0]) + '" class="m-segmented-btn' + (this.outputFilter === item[0] ? ' active' : '') + '" @click="setOutputFilter(\'' + item[0] + '\')">' + this.esc(item[1]) + '</button>';
    });
    html += '</div>';
    html += '<button type="button" id="outputSelectVisible" class="btn btn-sm btn-secondary"' + (this.outputFilesLoading || !canUseFiles || !visibleCount ? ' disabled' : '') + ' @click="selectAllOutputFiles()" :disabled="outputFilesLoading || ' + (!canUseFiles || !visibleCount) + '">' + this.esc(t('selectVisible')) + '</button>';
    if (d.artifact_dir) html += '<button type="button" class="btn btn-sm btn-secondary" @click="navigator.clipboard.writeText(currentArtifactData().artifact_dir).then(() => toast(t(\'common.copied\'))).catch(() => toast(t(\'common.failed\'), \'error\'))">' + this.esc(t('copyOutputPath')) + '</button>';
    html += '</div></div>';
    html += this._artifactLocationHtml(t, d);

    if (!this.outputFiles.length) {
      let emptyKey = 'noOutputsHint';
      let emptyFallback = 'Training outputs will appear here after saving';
      if (!runDir) {
        emptyKey = 'noOutputsNoRunHint';
        emptyFallback = 'Start or select a training run to view its output files.';
      } else if (artifactUnavailable) {
        const hasLocationNotice = d.artifact_available === false && !!d.artifact_dir;
        emptyKey = hasLocationNotice ? 'noOutputsArtifactUnavailableHint' : 'artifactUnavailableStandalone';
        emptyFallback = hasLocationNotice ? 'Output files are unavailable.' : 'The output folder is unavailable. Check the path and refresh.';
      } else if (this.outputFilesError === 'loadFailed') {
        emptyKey = 'outputFilesLoadFailed';
        emptyFallback = 'Unable to load output files. Check the folder and try Refresh.';
      }
      html += '<div class="dashboard-empty' + (artifactUnavailable ? ' dashboard-empty-danger' : '') + '" style="padding:48px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><p>' + this.esc(t(emptyKey, emptyFallback)) + '</p></div>';
      html += '</div>';
      return html;
    }

    // Scrollable content
    html += '<div class="m-outputs-scroll">';

    const { models, others } = this._sortedOutputs();

    if (!models.length && !others.length) {
      html += '<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('noMatchingOutputs')) + '</p><button class="btn btn-sm btn-secondary" @click="clearOutputFilters()">' + this.esc(t('clearHistoryFilters')) + '</button></div>';
      return html + '</div></div>';
    }

    // ── 模型存档区（带 loss + 排序）──
    if (this.outputFilter !== 'others') {
    html += '<div class="m-ckpt-section">';
    html += '<div class="m-section-title"><span>' + this.esc(t('modelCheckpoints')) + ' <span class="m-logs-count">' + models.length + '</span></span></div>';

    if (models.length) {
      const bestPath = this._bestCheckpointPath(this.outputFiles.filter(file => file.category === 'model'));
      html += '<div class="output-list output-table"><div class="output-table-head"><span></span><span></span>' + this._outputSortHeadHtml('models', 'name', t('fileName')) + '<span>' + this.esc(t('checkpoint')) + '</span>' + this._outputSortHeadHtml('models', 'loss', t('loss')) + this._outputSortHeadHtml('models', 'size', t('sortSize')) + this._outputSortHeadHtml('models', 'time', t('modifiedTime')) + '<span>' + this.esc(t('actions')) + '</span></div>';
      models.forEach(f => {
        const isSelected = !!this.outputFilesSelected[f.path];
        const fpJs = this.esc(this.escapeJsString(f.path));
        const isBest = f.path === bestPath;
        html += '<div class="output-item' + (isSelected ? ' selected' : '') + (isBest ? ' m-ckpt-best' : '') + '" @click="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<input type="checkbox" id="outputSelect-' + this.esc(encodeURIComponent(f.path)) + '" aria-label="' + this.esc(t('selectOutputFile').replace('{name}', f.name)) + '" ' + (isSelected ? 'checked' : '') + ' @click.stop="toggleOutputFile(\'' + fpJs + '\')">';
        html += this._fileIconSvg(f);
        html += '<span class="output-name" title="' + this.esc(f.name) + '">' + this.esc(f.name) + (isBest ? '<small class="m-best-label">' + this.esc(t('lowestLoss')) + '</small>' : '') + '</span>';
        const badge = this._ckptBadgeHtml(f, t);
        if (badge) html += badge;
        else if (f.is_lora) html += '<span class="badge output-lora-badge">LoRA</span>';
        else html += '<span class="m-ckpt-badge m-muted">—</span>';
        const numericLoss = Number(f.ckpt_loss);
        const hasLoss = f.ckpt_loss != null && Number.isFinite(numericLoss);
        const lossTxt = hasLoss ? (f.loss_approximate ? '≈ ' : '') + numericLoss.toFixed(4) : '--';
        html += '<span title="' + this.esc((f.loss_source || '') + (f.loss_step != null ? ' · step ' + f.loss_step : '')) + '" class="m-ckpt-loss' + (hasLoss ? '' : ' m-muted') + '"><b>' + this.esc(lossTxt) + '</b></span>';
        html += '<span class="output-size">' + this._formatFileSize(f.size) + '</span>';
        html += '<span class="output-time">' + this._formatFileTime(f.mtime) + '</span>';
        html += '<button class="btn btn-sm btn-secondary output-dl-btn" @click.stop="downloadSingleOutput(\'' + fpJs + '\')" aria-label="' + this.esc(t('common.download') + ': ' + f.name) + '" title="' + this.esc(t('common.download')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="dashboard-empty" style="padding:24px"><p>' + this.esc(t('noModelFiles')) + '</p></div>';
    }
    html += '</div>';
    }

    // ── 其他文件区 ──
    if (this.outputFilter !== 'models' && others.length) {
      html += '<div class="m-ckpt-section">';
      html += '<div class="m-section-title"><span>' + this.esc(t('otherFiles')) + ' <span class="m-logs-count">' + others.length + '</span></span></div>';
      html += '<div class="output-list output-table output-table-other"><div class="output-table-head"><span></span><span></span>' + this._outputSortHeadHtml('others', 'name', t('fileName')) + this._outputSortHeadHtml('others', 'type', t('fileType')) + this._outputSortHeadHtml('others', 'size', t('sortSize')) + this._outputSortHeadHtml('others', 'time', t('modifiedTime')) + '<span>' + this.esc(t('actions')) + '</span></div>';
      others.forEach(f => {
        const isSelected = !!this.outputFilesSelected[f.path];
        const fpJs = this.esc(this.escapeJsString(f.path));
        const extension = (f.name || '').includes('.') ? (f.name || '').split('.').pop().toUpperCase() : '';
        const fileType = f.is_lora ? 'LoRA' : (f.category || extension || '—');
        html += '<div class="output-item' + (isSelected ? ' selected' : '') + '" @click="toggleOutputFile(\'' + fpJs + '\')">';
        html += '<input type="checkbox" id="outputSelect-' + this.esc(encodeURIComponent(f.path)) + '" aria-label="' + this.esc(t('selectOutputFile').replace('{name}', f.name)) + '" ' + (isSelected ? 'checked' : '') + ' @click.stop="toggleOutputFile(\'' + fpJs + '\')">';
        html += this._fileIconSvg(f);
        html += '<span class="output-name" title="' + this.esc(f.name) + '">' + this.esc(f.name) + '</span>';
        html += '<span class="output-kind">' + this.esc(fileType) + '</span>';
        html += '<span class="output-size">' + this._formatFileSize(f.size) + '</span>';
        html += '<span class="output-time">' + this._formatFileTime(f.mtime) + '</span>';
        html += '<button class="btn btn-sm btn-secondary output-dl-btn" @click.stop="downloadSingleOutput(\'' + fpJs + '\')" aria-label="' + this.esc(t('common.download') + ': ' + f.name) + '" title="' + this.esc(t('common.download')) + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>';
        html += '</div>';
      });
      html += '</div>';
      html += '</div>';
    }
    html += '</div>'; // m-outputs-scroll
    html += '</div>'; // m-section
    return html;
  },

  _outputSortHeadHtml(group, key, label) {
    const modelGroup = group === 'models';
    const activeKey = modelGroup ? this.outputModelSortKey : this.outputOtherSortKey;
    const activeDir = modelGroup ? this.outputModelSortDir : this.outputOtherSortDir;
    const active = activeKey === key;
    let html = '<button type="button" id="outputSort-' + group + '-' + key + '" aria-label="' + this.esc(label + (active ? ' · ' + this.t('monitor.' + (activeDir === 'asc' ? 'sortAscending' : 'sortDescending')) : '')) + '" class="output-table-sort' + (active ? ' active' : '') + '" @click="setOutputSort(\'' + group + '\',\'' + key + '\')">' + this.esc(label);
    if (active) html += '<span aria-hidden="true">' + (activeDir === 'asc' ? '↑' : '↓') + '</span>';
    return html + '</button>';
  },

  _bestCheckpointPath(models) {
    const sources = new Set((models || []).filter(f => f.ckpt_loss != null).map(f => f.loss_source || 'unknown'));
    if (sources.size > 1) return null;
    let bestPath = null;
    let bestLoss = Infinity;
    let bestTime = -Infinity;
    (models || []).forEach(file => {
      const loss = Number(file.ckpt_loss);
      if (file.ckpt_loss == null || !Number.isFinite(loss)) return;
      const time = Number(file.mtime) || 0;
      if (loss < bestLoss || (loss === bestLoss && time > bestTime)) {
        bestLoss = loss;
        bestTime = time;
        bestPath = file.path;
      }
    });
    return bestPath;
  },

  _fileIconSvg(f) {
    const cat = f.category || '';
    const ext = (f.name || '').split('.').pop().toLowerCase();
    // Weight icon for model files
    if (cat === 'model') {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
    }
    // Image icon for samples
    if (cat === 'sample' || ['png','jpg','jpeg','webp','gif'].includes(ext)) {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
    }
    // Chart icon for tensorboard
    if (cat === 'tensorboard' || ext === 'tfevents') {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>';
    }
    // Document icon for logs and text files
    if (cat === 'log' || ['txt','log','md'].includes(ext)) {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
    }
    // Gear icon for config files
    if (['toml','json','yaml','yml'].includes(ext)) {
      return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
    }
    // Default folder icon
    return '<svg class="output-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  },

  // checkpoint 类型 → 小标签（Epoch N / Step N / 最终）
  _ckptBadgeHtml(f, t) {
    if (f.ckpt_type === 'epoch' && f.ckpt_epoch != null) {
      return '<span class="m-ckpt-badge m-ckpt-epoch">' + this.esc(t('ckptEpoch').replace('{n}', f.ckpt_epoch)) + '</span>';
    }
    if (f.ckpt_type === 'step' && f.ckpt_step != null) {
      return '<span class="m-ckpt-badge m-ckpt-step">' + this.esc(t('ckptStep').replace('{n}', f.ckpt_step)) + '</span>';
    }
    if (f.ckpt_type === 'final') {
      return '<span class="m-ckpt-badge m-ckpt-final">' + this.esc(t('ckptFinal')) + '</span>';
    }
    return '';
  },

  _formatFileTime(mtime) {
    if (!mtime) return '';
    const d = new Date(mtime * 1000);
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  },
};
