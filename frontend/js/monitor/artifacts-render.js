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
  _sampleSelectHtml(options, value, label, id, action, className = '') {
    if (typeof window.previewSelectHtml === 'function') {
      const handler = action.replaceAll('$event.target.value', '$event.detail')
        + '; $nextTick(() => document.getElementById(' + JSON.stringify(id) + ')?.focus({ preventScroll: true }))';
      return '<div class="m-sample-select ' + this.esc(className) + '" @preview-select="' + this.esc(handler) + '">'
        + window.previewSelectHtml(options, value, label, id) + '</div>';
    }
    // The native control is a usable fallback if the shared component is unavailable.
    return '<select id="' + this.esc(id) + '" class="' + this.esc(className) + '" aria-label="' + this.esc(label) + '" @change="' + this.esc(action) + '">'
      + options.map(option => '<option value="' + this.esc(option.value) + '"' + (option.value === value ? ' selected' : '') + '>' + this.esc(option.label) + '</option>').join('') + '</select>';
  },

  _sampleStageParts(label) {
    const text = String(label || '');
    const stage = text.match(/^(Epoch|Step)\s+(\d+)(?:\s*·\s*Step\s+(\d+))?(\s+\(\d+\))?$/);
    if (!stage) return { primary: text, secondary: '' };
    const primary = this.t(stage[1] === 'Epoch' ? 'monitor.sampleEpoch' : 'monitor.sampleStep').replace('{n}', stage[2]);
    const secondary = stage[3] ? this.t('monitor.sampleStep').replace('{n}', stage[3]) : '';
    const suffix = stage[4] || '';
    return { primary: primary + (secondary ? '' : suffix), secondary: secondary ? secondary + suffix : '' };
  },

  _sampleStageHtml(label) {
    const stage = this._sampleStageParts(label);
    if (!stage.secondary) return '<strong>' + this.esc(stage.primary) + '</strong>';
    return '<span class="m-sample-stage"><strong>' + this.esc(stage.primary) + '</strong><small>'
      + this.esc(stage.secondary) + '</small></span>';
  },

  _sampleStageText(label) {
    const stage = this._sampleStageParts(label);
    return [stage.primary, stage.secondary].filter(Boolean).join(' ');
  },

  _sampleThumbnailHtml(index, batch, showPrompt = true, status = '') {
    const preview = this.previews[index], key = this._previewItemKey(preview);
    const detail = [showPrompt ? this._sampleCaseLabel(preview) : '', status].filter(Boolean).join(' ');
    return '<button type="button" id="sample-' + this.esc(encodeURIComponent(key)) + '" class="preview-grid-item" data-preview-path="' + this.esc(key) + '" data-preview-index="' + index
      + '" data-dialog-opens="previewLightbox" :data-sample-image-selected="sampleSidebarActive && previewStep === ' + index + '" :aria-current="sampleSidebarActive && previewStep === ' + index + '"'
      + ' aria-label="' + this.esc(this._previewCompareLabel(preview)) + '"><span class="m-sample-card-visual">'
      + '<span class="preview-thumb-frame">' + this._previewThumbImageHtml(preview) + '<span class="preview-thumb-error">' + this.esc(this.t('monitor.previewImageFailed')) + '</span></span>'
      + '<span class="preview-grid-item-label" title="' + this.esc([this._sampleStageText(batch.label), detail].filter(Boolean).join('\n')) + '">' + this._sampleStageHtml(batch.label)
      + (detail ? '<small class="m-sample-caption-detail">' + this.esc(detail) + '</small>' : '') + '</span></span></button>';
  },

  _sampleBatchCountText(t, batch) {
    let count = t('sampleBatchCount').replace('{n}', batch.indices.length);
    if (batch.status === 'running') count = batch.expected ? t('sampleIncompleteBatch').replace('{done}', batch.indices.length).replace('{total}', batch.expected) : count + ' ' + t('sampleBatchRunning');
    else if (batch.status === 'failed') count += ' ' + t('sampleBatchFailed');
    return count;
  },

  _sampleBatchStatusText(t, batch) {
    if (batch.status === 'running') return t('sampleBatchRunning');
    if (batch.status === 'failed') return t('sampleBatchFailed');
    return '';
  },

  _sampleBatchIsExpandable(batch) {
    return batch.indices.length > 1 || batch.expected > 1;
  },

  _sampleStackHtml(batch) {
    const total = batch.indices.length;
    let html = '<span class="m-sample-stack' + (total > 1 ? ' is-stack' : '') + '">';
    batch.indices.slice(0, 3).forEach((index, position) => {
      const preview = this.previews[index];
      const layer = total > 1 ? position === 0 ? ' is-cover' : ' is-behind-' + position : '';
      html += '<span class="preview-thumb-frame m-sample-card-image' + layer + '" data-preview-path="' + this.esc(this._previewItemKey(preview)) + '">' + this._previewThumbImageHtml(preview) + '</span>';
    });
    if (total > 1 || batch.expected > 1) html += '<span class="m-sample-card-count" aria-hidden="true">×' + total + '</span>';
    return html + '</span>';
  },

  _sampleBatchCardHtml(t, batch, showPrompt) {
    if (!this._sampleBatchIsExpandable(batch)) {
      return this._sampleThumbnailHtml(batch.indices[0], batch, showPrompt, this._sampleBatchStatusText(t, batch));
    }
    const expanded = this.sampleExpandedBatchId === batch.id;
    let html = '<button type="button" id="sampleBatch-' + this.esc(encodeURIComponent(batch.id)) + '" class="preview-grid-item m-sample-batch-cover"'
      + ' aria-expanded="' + expanded + '" aria-controls="sampleBatchImages-' + this.esc(encodeURIComponent(batch.id)) + '"'
      + ' aria-label="' + this.esc(this._sampleStageText(batch.label) + ' ' + this._sampleBatchCountText(t, batch)) + '"><span class="m-sample-card-visual">';
    html += this._sampleStackHtml(batch);
    const status = batch.status === 'running' ? this._sampleBatchCountText(t, batch) : this._sampleBatchStatusText(t, batch);
    html += '<span class="preview-grid-item-label">' + this._sampleStageHtml(batch.label)
      + (status ? '<small class="m-sample-caption-detail">' + this.esc(status) + '</small>' : '') + '</span></span></button>';
    return html;
  },

  _sampleBatchItemsHtml(t, batch, showPrompt = true) {
    const expanded = this.sampleExpandedBatchId === batch.id;
    const indices = expanded ? batch.indices : batch.indices.slice(0, 1);
    return indices.map((index, position) => {
      const key = this._previewItemKey(this.previews[index]);
      return '<div class="m-sample-tile' + (expanded ? ' is-expanded' + (position === 0 ? ' is-first' : '') : '')
        + '" data-sample-tile-key="' + this.esc(JSON.stringify([batch.id, key])) + '" data-batch-id="' + this.esc(batch.id) + '">'
        + (expanded ? this._sampleThumbnailHtml(index, batch) : this._sampleBatchCardHtml(t, batch, showPrompt)) + '</div>';
    }).join('');
  },

  _previewTimelineLocateHtml(t) {
    const label = this.esc(t('sampleLocateCurrent'));
    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/></svg>';
    return '<button type="button" class="btn-icon sample-timeline-locate" disabled'
      + ' @click="centerPreviewViewTimeline()" title="' + label + '" aria-label="' + label + '">' + icon + '</button>';
  },

  _previewInfoButtonHtml(t, id) {
    const label = this.esc(t('sampleGenerationInfo'));
    return '<button type="button" id="' + this.esc(id) + '" class="btn-icon preview-icon-button" data-dialog-opens="previewInfoDialog" @click="previewInfoOpen=true" title="' + label + '" aria-label="' + label + '" aria-haspopup="dialog">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/></svg></button>';
  },

  _sampleSidebarViewState() {
    const key = this._previewItemKey(this.previews[this.previewStep]);
    if (this.sampleSidebarView.key !== key) this.sampleSidebarView = {key, scale: 1, x: 0, y: 0};
    return this.sampleSidebarView;
  },

  _sampleSidebarHtml(t) {
    const close = this.esc(t('close'));
    return '<aside id="sampleSidebar" class="m-sample-sidebar" x-show="sampleSidebarVisible"' + (this.sampleSidebarVisible ? '' : ' style="display:none"') + ' aria-label="' + this.esc(t('sampleSelectedImage')) + '" data-sample-expansion-keep>'
      + '<template x-if="sampleSidebarMediaActive"><div class="m-sample-sidebar-content" x-data="AnimaImageViewport.create(_sampleSidebarViewState())" @image-view-interact="_sampleSidebarInspecting=true" x-init="$watch(\'_previewItemKey(previews[previewStep])\', key => {sampleSidebarView.key=key;reset(false)})">'
      + '<div class="m-sample-sidebar-heading"><div class="m-sample-sidebar-label"><span class="m-sample-sidebar-stage" :title="_previewStageLabel(previews[previewStep])"><strong x-text="_previewCaptionParts(previews[previewStep]).primary"></strong><small x-show="_previewCaptionParts(previews[previewStep]).secondary" x-text="_previewCaptionParts(previews[previewStep]).secondary"></small></span>'
      + this._previewInfoButtonHtml(t, 'sampleSidebarInfoButton') + '</div>'
      + '<div class="m-sample-sidebar-actions"><button type="button" class="btn btn-sm btn-secondary" data-dialog-opens="previewLightbox" @click="openPreviewLightbox(previewStep)">' + this.esc(t('sampleOpenViewer')) + '</button>'
      + '<button type="button" class="btn btn-sm btn-ghost" @click="reset()" :disabled="scale === 1 && x === 0 && y === 0">' + this.esc(t('sampleResetView')) + '</button>'
      + '<button type="button" class="btn-icon preview-icon-button" @click="closeSampleSidebarPreview()" title="' + close + '" aria-label="' + close + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></div>'
      + '<div id="sampleSidebarImage" class="m-sample-sidebar-image" x-ref="viewport" :class="{\'is-zoomed\':scale > 1, \'is-panning\':panning}" @wheel="zoom($event)"'
      + ' @pointerdown="startPan($event)" @pointermove="movePan($event)" @pointerup="stopPan($event)" @pointercancel="stopPan($event)" @lostpointercapture="stopPan($event)" @resize.window="constrain()" x-data="{failed:false}">'
      + '<img x-image="{src: _previewFullImageUrl(previews[previewStep]), placeholder: previews[previewStep].thumb_url || previews[previewStep].url}" :alt="previews[previewStep].name" :style="\'transform:\'+transform()" :class="{\'is-error\':failed}" @load="failed=false;constrain()" @error="failed=true" @dragstart.prevent>'
      + '<span class="m-sample-sidebar-error" x-show="failed" x-cloak>' + this.esc(t('previewImageFailed')) + '</span></div>'
      + '</div></template><div class="m-sample-sidebar-empty" x-show="!sampleSidebarActive"' + (this.sampleSidebarActive ? ' style="display:none"' : '') + '>'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></svg>'
      + '<span>' + this.esc(t('sampleSelectPreview')) + '</span></div></aside>';
  },

  _renderSamplesTab(t) {
    const isHistory = !!this.selectedRunDir;
    const d = isHistory ? (this.runDetailData||{}) : (this.monitorData||{});
    const showPreviews = this.previews.length > 0;
    const batch = this._sampleSelectedBatch();
    if (batch && !this.sampleBatchId && !this.previewLightboxOpen) {
      this.sampleBatchId = batch.id;
      this.previewStep = this._sampleBatchNavigationIndex(batch, this.previews[this.previewStep]);
    }
    let html = '<div class="m-section m-samples-section"><div class="m-view-header m-samples-toolbar"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t('previewSamples')) + '</span></div>';
    html += this._monitorRefreshButtonHtml(t, 'sample') + '<div class="m-view-actions">';
    if (showPreviews) {
      html += '<div class="m-sample-view-toggle"><span id="sampleSidebarToggleLabel">' + this.esc(t('sampleShowSidebar')) + '</span><label class="toggle"><input type="checkbox" role="switch" id="sampleSidebarToggle"' + (this.sampleSidebarVisible ? ' checked' : '') + ' :checked="sampleSidebarVisible" aria-labelledby="sampleSidebarToggleLabel" aria-controls="sampleSidebar" @change="toggleSampleSidebar($event)"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div>';
      if (this.previewHasNew) html += '<button type="button" id="sampleLatestBatch" class="btn btn-sm btn-secondary" @click="jumpToLatestOverviewBatch()">' + this.esc(t('previewNewSamples')) + '</button>';
      if (this._sampleDataModel().batches.length > 1) {
        const options = [{ value: 'asc', label: t('trainingOrder') }, { value: 'desc', label: t('latestFirst') }];
        html += '<div class="m-samples-sort"><span>' + this.esc(t('sampleOrder')) + '</span>'
          + this._sampleSelectHtml(options, this.sampleBatchSortDir || 'desc', t('sampleOrder'), 'sampleBatchSort', 'setSampleBatchSort($event.target.value)') + '</div>';
      }
    }
    html += '</div></div>';
    html += this._artifactLocationHtml(t, d);
    if (showPreviews) {
      const model = this._sampleDataModel(), batches = model.batches;
      const singleImageMode = batches.every(group => !this._sampleBatchIsExpandable(group));
      const showPrompt = !singleImageMode || new Set(model.records.map(record => record.sample.prompt_id)).size > 1;
      html += '<div class="m-samples-workspace' + (this.sampleSidebarVisible ? ' has-sidebar' : '') + '" :class="{\'has-sidebar\':sampleSidebarVisible}"'
        + ' x-data="AnimaSampleLayout.create({getAnchor: () => _sampleScrollAnchor, setAnchor: anchor => _sampleScrollAnchor=anchor, cleanup: () => _cancelSampleGridMotion($el.querySelector(\'.preview-grid\'))})"><div class="preview-grid m-sample-batches" @scroll.passive="sampleOverviewScroll($event)" @click="sampleGridClick($event)" @dblclick="sampleGridDoubleClick($event)"'
        + ' @pointerdown="sampleGridPointerDown($event)">';
      const displayBatches = this._sampleOverviewBatches();
      displayBatches.forEach(group => {
        html += '<section class="m-sample-batch" id="sampleBatchImages-' + this.esc(encodeURIComponent(group.id)) + '" data-batch-index="' + group.position + '" data-batch-id="' + this.esc(group.id) + '"'
          + ' data-sample-selected="' + (this.sampleSidebarActive && group.id === batch?.id) + '" :data-sample-selected="' + this.esc('sampleSidebarActive && sampleBatchId === ' + JSON.stringify(group.id)) + '" data-expanded="' + (group.id === this.sampleExpandedBatchId) + '" aria-label="' + this.esc(this._sampleStageText(group.label)) + '">';
        html += this._sampleBatchItemsHtml(t, group, showPrompt) + '</section>';
      });
      html += '</div>';
      html += this._sampleSidebarHtml(t) + '</div>';
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

  toggleSampleSidebar(event) {
    const visible = typeof event?.currentTarget?.checked === 'boolean' ? event.currentTarget.checked : !this.sampleSidebarVisible;
    if (visible === this.sampleSidebarVisible) return;
    const action = ++this._sampleLayoutAction, panel = this._sampleOverviewPanel(), grid = panel?.querySelector('.preview-grid');
    const selected = this.sampleSidebarOpen && (document.getElementById('sample-' + encodeURIComponent(this._previewItemKey(this.previews[this.previewStep])))
      || document.getElementById('sampleBatch-' + encodeURIComponent(this.sampleBatchId)));
    const anchor = window.AnimaSampleLayout.captureAnchor(grid, selected, this._sampleScrollAnchor);
    const before = grid ? this._captureSampleLayout(grid) : null;
    this._cancelSampleGridMotion(grid);
    this.sampleSidebarVisible = visible;
    this._saveSampleViewPreferences();
    const sidebar = document.getElementById('sampleSidebar');
    if (!this.sampleSidebarVisible && sidebar?.contains(document.activeElement)) {
      document.getElementById('sampleSidebarToggle')?.focus({preventScroll: true});
    }
    if (!grid) return;
    const finish = () => {
      if (this._sampleLayoutAction !== action || this._sampleOverviewPanel()?.querySelector('.preview-grid') !== grid || grid.isConnected === false) return;
      this._sampleScrollAnchor = window.AnimaSampleLayout.restoreAnchor(grid, anchor);
      this._refreshSampleGroupOutline(panel);
      this._animateSampleLayout(grid, before);
    };
    if (typeof this.$nextTick === 'function') this.$nextTick(finish);
    else finish();
  },

  closeSampleSidebarPreview() {
    this._sampleLayoutAction++;
    const sidebar = document.getElementById('sampleSidebar');
    const restoreFocus = sidebar?.contains(document.activeElement);
    this.sampleSidebarOpen = false;
    this._sampleSidebarInspecting = false;
    this.sampleSidebarView = {key: '', scale: 1, x: 0, y: 0};
    if (!this.previewLightboxOpen) this.previewInfoOpen = false;
    if (restoreFocus) {
      const image = document.getElementById('sample-' + encodeURIComponent(this._previewItemKey(this.previews[this.previewStep])));
      const cover = document.getElementById('sampleBatch-' + encodeURIComponent(this.sampleBatchId));
      (image || cover || document.getElementById('sampleSidebarToggle'))?.focus({preventScroll: true});
    }
  },
  _sampleOverviewJumpId: '',

  selectSampleImage(index) {
    if (!this.previews[index]) return;
    this._sampleLayoutAction++;
    this._sampleScrollAnchor = null;
    if (!this.sampleSidebarVisible) { this.openPreviewLightbox(index); return; }
    const model = this._sampleDataModel(), batch = model.records[index]?.batch, panel = this._sampleOverviewPanel();
    this._activateOverviewBatch(batch);
    this.previewStep = index;
    this.sampleSidebarOpen = true;
    this._sampleSidebarInspecting = true;
    this._sampleOverviewAtEnd = false;
    if (batch?.id === model.batches.at(-1)?.id) this._acknowledgeNewPreviews(panel);
  },

  _acknowledgeNewPreviews(panel = this._sampleOverviewPanel()) {
    this.previewHasNew = false;
    panel?.querySelector('#sampleLatestBatch')?.remove();
  },

  _sampleGridActionForTarget(target, grid) {
    if (target?.closest?.('.m-sample-motion-ghost')) return null;
    const cover = target?.closest?.('.m-sample-batch-cover');
    if (cover && grid.contains(cover)) {
      const id = cover.closest('.m-sample-batch')?.dataset.batchId;
      return id ? {kind: 'batch', id} : null;
    }
    const image = target?.closest?.('.preview-grid-item[data-preview-index]');
    return image && grid.contains(image)
      ? {kind: 'image', key: image.dataset.previewPath, index: Number(image.dataset.previewIndex), batchId: image.closest?.('.m-sample-batch')?.dataset.batchId} : null;
  },

  _sampleGridVisualAction(event, grid) {
    const motion = grid._sampleGridMotion;
    if (!motion?.animations.size) return null;
    const bounds = grid.getBoundingClientRect(), left = bounds.left + (grid.clientLeft || 0), top = bounds.top + (grid.clientTop || 0);
    const x = event.clientX, y = event.clientY;
    if (x < left || x >= left + grid.clientWidth || y < top || y >= top + grid.clientHeight) return {action: null};
    // The buttons stay at their final grid slots. During motion, interpret a
    // press against the painted visuals, including visuals over a grid gap.
    // Later siblings paint above earlier ones; transparent reveals and ghosts
    // never claim a press. No geometry is read outside an active animation.
    for (let index = motion.items.length - 1; index >= 0; index--) {
      const item = motion.items[index], rect = item.visual.getBoundingClientRect();
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue;
      if (Number(window.getComputedStyle(item.visual).opacity) <= 0.01) continue;
      return {action: this._sampleGridActionForTarget(item.button, grid)};
    }
    return {action: null};
  },

  _runSampleGridAction(action, event) {
    if (action?.kind === 'batch') {
      if (this._sampleDataModel().byBatch.has(action.id)) {
        this.toggleSampleBatch(action.id, event);
        return action;
      }
    } else if (action?.kind === 'image') {
      let index = action.index;
      if (!Number.isInteger(index) || this._previewItemKey(this.previews[index]) !== action.key) {
        index = this.previews.findIndex(preview => this._previewItemKey(preview) === action.key);
      }
      if (index >= 0) {
        window.AnimaUI?.setDialogOrigin?.(document.getElementById('previewLightbox'), document.getElementById('sample-' + encodeURIComponent(action.key)));
        this.selectSampleImage(index);
        return {...action, index};
      }
    }
    return null;
  },

  sampleGridPointerDown(event) {
    this._sampleGridPointer = null;
    if (event.button !== 0 || event.isPrimary === false) return;
    const visual = this._sampleGridVisualAction(event, event.currentTarget);
    const action = visual ? visual.action : this._sampleGridActionForTarget(event.target, event.currentTarget);
    if (action || visual) this._sampleGridPointer = {pointerId: event.pointerId, grid: event.currentTarget, action, visual: !!visual, x: event.clientX, y: event.clientY,
      moved: false, ended: false, cancelled: false};
  },

  _sampleGridPressMatches(event, grid, pointer = this._sampleGridPointer) {
    return event.detail !== 0 && pointer?.ended && pointer.grid === grid
      && (event.pointerId == null || event.pointerId === pointer.pointerId);
  },

  _sampleGridPressStationary(event, pointer) {
    return !pointer.cancelled && !pointer.moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= 6;
  },

  sampleGridPointerMove(event) {
    const pointer = this._sampleGridPointer;
    if (pointer && pointer.pointerId === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 6) pointer.moved = true;
  },

  sampleGridPointerUp(event) {
    const pointer = this._sampleGridPointer;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    this.sampleGridPointerMove(event);
    if (pointer.ended) return;
    pointer.ended = true;
    // Keep every pressed card through click, including microtask checkpoints
    // between pointerup and click. A cancelled native click must not strand it.
    setTimeout(() => {
      if (this._sampleGridPointer === pointer) this._sampleGridPointer = null;
      if (pointer.renderPending && this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'samples') this.renderDashboard();
    }, 0);
  },

  sampleGridPointerCancel(event) {
    const pointer = this._sampleGridPointer;
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    pointer.cancelled = true;
    this.sampleGridPointerUp(event);
  },

  sampleGridClick(event, grid = event.currentTarget) {
    const target = event.target, pointer = this._sampleGridPointer, previous = this._sampleGridLastAction;
    this._sampleGridPointer = null;
    this._sampleGridLastAction = null;
    if (event.defaultPrevented || (event.button != null && event.button !== 0) || target.closest?.('.m-sample-motion-ghost')) return;
    const pointerClick = this._sampleGridPressMatches(event, grid, pointer);
    if (pointerClick && !this._sampleGridPressStationary(event, pointer)) return;
    // FLIP and focus scrolling can retarget click to a tile, the grid or a
    // different card. Both images and batch covers keep the pressed identity;
    // keyboard activation resolves the current target through the same action.
    const action = this._runSampleGridAction(pointerClick ? pointer.action : this._sampleGridActionForTarget(target, grid), event);
    if (action) this._sampleGridLastAction = {...action, clickDetail: event.detail,
      doubleClick: event.detail === 2 && previous?.clickDetail === 1 && action.kind === 'image' && previous.kind === 'image' && previous.key === action.key};
  },

  sampleGridDoubleClick(event) {
    if (event.defaultPrevented || (event.button != null && event.button !== 0)) return;
    const action = this._sampleGridLastAction;
    if (action?.kind !== 'image' || !action.doubleClick) return;
    const index = this.previews.findIndex(preview => this._previewItemKey(preview) === action.key);
    if (index >= 0) this.openPreviewLightbox(index);
  },

  _sampleOutlineRows(items, id, padding = 4) {
    const allRows = [];
    [...items].sort((a, b) => a.top - b.top || a.left - b.left).forEach(item => {
      let row = allRows.at(-1);
      if (!row || Math.abs(row.top - item.top) > 1) {row = {top: item.top, items: []}; allRows.push(row);}
      row.items.push(item);
    });
    const rows = allRows.map(row => {
      const selected = row.items.filter(item => item.batchId === id);
      if (!selected.length) return null;
      return {left: Math.min(...selected.map(item => item.left)) - padding,
        right: Math.max(...selected.map(item => item.right)) + padding,
        top: row.top - padding, bottom: Math.max(...selected.map(item => item.bottom)) + padding,
        rowBottom: Math.max(...row.items.map(item => item.bottom))};
    }).filter(Boolean);
    // Horizontal bridges occupy the genuine CSS row-gap. A short group caption
    // must never route its bridge through a taller neighboring card's caption.
    rows.forEach((row, index) => {if (index < rows.length - 1) row.bottom = row.rowBottom + padding;});
    return rows;
  },

  _sampleOutlinePath(rows) {
    if (!rows.length) return '';
    const points = [[rows[0].left, rows[0].top], [rows[0].right, rows[0].top]];
    for (let index = 1; index < rows.length; index++) {
      const previous = rows[index - 1], next = rows[index];
      if (next.right > previous.right) points.push([previous.right, previous.bottom], [next.right, previous.bottom], [next.right, next.top]);
      else points.push([previous.right, next.top], [next.right, next.top]);
    }
    const last = rows.at(-1);
    points.push([last.right, last.bottom], [last.left, last.bottom]);
    for (let index = rows.length - 1; index > 0; index--) {
      const current = rows[index], previous = rows[index - 1];
      if (previous.left < current.left) points.push([current.left, current.top], [previous.left, current.top], [previous.left, previous.bottom]);
      else points.push([current.left, previous.bottom], [previous.left, previous.bottom]);
    }
    const bridges = rows.slice(0, -1).map((row, index) => ({top: row.bottom, bottom: rows[index + 1].top}));
    return this._sampleRoundedOutlinePath(points, bridges);
  },

  _sampleRoundedOutlinePath(points, bridges = []) {
    let corners = points.filter((point, index) => !index || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
    if (corners.length > 1 && corners[0][0] === corners.at(-1)[0] && corners[0][1] === corners.at(-1)[1]) corners.pop();
    // Remove straight-through vertices before trimming neighboring segments.
    let simplified;
    do {
      simplified = corners.filter((point, index) => {
        const previous = corners[(index + corners.length - 1) % corners.length], next = corners[(index + 1) % corners.length];
        return !((previous[0] === point[0] && point[0] === next[0]) || (previous[1] === point[1] && point[1] === next[1]));
      });
      if (simplified.length === corners.length) break;
      corners = simplified;
    } while (corners.length > 2);
    if (corners.length < 3) return '';
    const number = value => String(Math.round(value * 10) / 10);
    const position = point => point.map(number).join(' ');
    const turns = corners.map((point, index) => {
      const previous = corners[(index + corners.length - 1) % corners.length], next = corners[(index + 1) % corners.length];
      const incoming = [point[0] - previous[0], point[1] - previous[1]], outgoing = [next[0] - point[0], next[1] - point[1]];
      const before = Math.hypot(...incoming), after = Math.hypot(...outgoing);
      const bridgeLimit = bridges.reduce((limit, bridge) => Math.abs(point[1] - bridge.top) < 0.1 || Math.abs(point[1] - bridge.bottom) < 0.1
        ? Math.min(limit, Math.max(0, (bridge.bottom - bridge.top) / 2)) : limit, 6);
      const radius = Math.min(6, before / 2, after / 2, bridgeLimit);
      const enter = [point[0] - incoming[0] / before * radius, point[1] - incoming[1] / before * radius];
      const leave = [point[0] + outgoing[0] / after * radius, point[1] + outgoing[1] / after * radius];
      const sweep = incoming[0] * outgoing[1] - incoming[1] * outgoing[0] > 0 ? 1 : 0;
      return {enter, leave, radius, sweep};
    });
    return 'M' + position(turns[0].enter) + turns.map((turn, index) => (index ? 'L' + position(turn.enter) : '')
      + (turn.radius > 0 ? 'A' + number(turn.radius) + ' ' + number(turn.radius) + ' 0 0 ' + turn.sweep + ' ' + position(turn.leave) : '')).join('') + 'Z';
  },

  _sampleOutlineContainsPoint(rows, x, y) {
    if (rows.some(row => x >= row.left && x <= row.right && y >= row.top && y <= row.bottom)) return true;
    return rows.some((row, index) => {
      const next = rows[index + 1];
      return next && y > row.bottom && y < next.top && x >= Math.min(row.left, next.left) && x <= Math.max(row.right, next.right);
    });
  },

  _refreshSampleGroupOutline(panel, animate = false) {
    const grid = panel?.querySelector('.m-sample-batches');
    if (!grid) return;
    let outline = grid.querySelector('.m-sample-group-outline');
    if (!this.sampleExpandedBatchId) {outline?.remove(); return;}
    let bounds;
    const items = Array.from(grid.querySelectorAll('.m-sample-tile')).map(node => {
      // offset* reads the final layout while FLIP is translating the cards.
      if (Number.isFinite(node.offsetLeft)) return {batchId: node.dataset.batchId, left: node.offsetLeft, top: node.offsetTop,
        right: node.offsetLeft + node.offsetWidth, bottom: node.offsetTop + node.offsetHeight};
      bounds ||= grid.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return {batchId: node.dataset.batchId, left: rect.left - bounds.left + grid.scrollLeft, top: rect.top - bounds.top + grid.scrollTop,
        right: rect.right - bounds.left + grid.scrollLeft, bottom: rect.bottom - bounds.top + grid.scrollTop};
    });
    const rows = this._sampleOutlineRows(items, this.sampleExpandedBatchId);
    if (!rows.length) {outline?.remove(); return;}
    if (!outline) {
      outline = document.createElement('div');
      outline.setAttribute('class', 'm-sample-group-outline'); outline.setAttribute('aria-hidden', 'true');
      outline.setAttribute('x-ignore', '');
      outline.inert = true;
      const fill = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      fill.append(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
      outline.append(fill);
      grid.append(outline);
    }
    outline._sampleRows = rows;
    // Bound the isolated paint layer to this group instead of the entire
    // scroll history. Geometry changes keep the same flowing stroke alive.
    const left = Math.floor(Math.min(...rows.map(row => row.left))) - 1;
    const top = Math.floor(Math.min(...rows.map(row => row.top))) - 1;
    const width = Math.ceil(Math.max(...rows.map(row => row.right))) + 1 - left;
    const height = Math.ceil(Math.max(...rows.map(row => row.bottom))) + 1 - top;
    const viewBox = [left, top, width, height].join(' '), path = this._sampleOutlinePath(rows);
    const geometry = viewBox + '|' + path;
    if (outline._sampleGeometry !== geometry) {
      outline._sampleGeometry = geometry;
      Object.assign(outline.style, {left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px'});
      const fill = outline.firstElementChild;
      fill.setAttribute('viewBox', viewBox); fill.firstElementChild.setAttribute('d', path);
    }
    if (animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      outline.getAnimations?.().forEach(animation => animation.cancel());
      outline.animate?.([{opacity: 0}, {opacity: 1}], {duration: 200, easing: 'ease-out'});
    }
  },

  _disconnectSampleExpansionUI(keepPointer = false) {
    const ui = this._sampleExpansionUI;
    if (ui) {
      ui.observer?.disconnect();
      if (ui.frame != null) cancelAnimationFrame(ui.frame);
      Object.entries(ui.handlers).forEach(([type, handler]) => document.removeEventListener(type, handler, type !== 'keydown'));
      window.removeEventListener?.('blur', ui.blur);
    }
    this._sampleExpansionUI = null;
    if (!keepPointer) {
      this._sampleGridPointer = null;
      this._sampleGridLastAction = null;
      this._sampleExpansionPointer = null;
      if (this._sampleExpansionDismissTimer != null) clearTimeout(this._sampleExpansionDismissTimer);
      this._sampleExpansionDismissTimer = null;
    }
  },

  _sampleExpansionDismissAllowed(target, openingOutsideImage = false) {
    return !!this.sampleExpandedBatchId && (!this.currentRoute || this.currentRoute === 'monitor-dashboard')
      && (!this.monitorTab || this.monitorTab === 'samples') && (openingOutsideImage || (!this.previewLightboxOpen && !this._previewClosePending))
      && !target?.closest?.('dialog');
  },

  _sampleWorkspaceBlankTarget(event, panel) {
    const target = event.target, grid = panel?.querySelector('.m-sample-batches');
    if (!grid || this.previewLightboxOpen || this.previewInfoOpen || this._previewClosePending) return false;
    if (target === grid) {
      const bounds = grid.getBoundingClientRect();
      if (event.clientX >= bounds.left + grid.clientWidth || event.clientY >= bounds.top + grid.clientHeight) return false;
      return true;
    }
    return !!target?.matches?.('.m-samples-workspace, .m-sample-sidebar, .m-sample-sidebar-content, .m-sample-sidebar-heading, .m-sample-sidebar-empty')
      && panel.contains(target);
  },

  _connectSampleExpansionUI(panel) {
    const grid = panel?.querySelector('.m-sample-batches');
    if (this._sampleExpansionUI?.grid === grid && this._sampleExpansionUI?.batchId === this.sampleExpandedBatchId) return;
    this._disconnectSampleExpansionUI(true);
    if (!grid || !document.addEventListener) return;
    this._sampleExpansionUI = {grid, panel, batchId: this.sampleExpandedBatchId, handlers: {}, frame: null};
    const ui = this._sampleExpansionUI;
    ui.blur = () => {
      const pointer = this._sampleGridPointer;
      if (pointer && !pointer.ended) this.sampleGridPointerCancel({pointerId: pointer.pointerId});
    };
    window.addEventListener?.('blur', ui.blur);
    ui.handlers.pointerdown = event => {
      // A new press outside the grid invalidates an earlier unfinished press.
      // The grid's bubbling handler records a fresh card action when needed.
      const previous = this._sampleGridPointer;
      if (previous?.renderPending) this.sampleGridPointerCancel({pointerId: previous.pointerId});
      this._sampleGridPointer = null;
      const target = event.target, rect = target?.getBoundingClientRect?.();
      const scrollbar = rect && ((target.scrollHeight > target.clientHeight && event.clientX >= rect.left + target.clientWidth)
        || (target.scrollWidth > target.clientWidth && event.clientY >= rect.top + target.clientHeight));
      this._sampleExpansionPointer = {id: event.pointerId, target, primary: event.button === 0 && !scrollbar, x: event.clientX, y: event.clientY, moved: false,
        ignored: event.button !== 0 || scrollbar || !this._sampleExpansionDismissAllowed(target)};
    };
    const moveExpansionPointer = event => {
      const pointer = this._sampleExpansionPointer;
      if (pointer && pointer.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 6) pointer.moved = true;
    };
    ui.handlers.pointermove = event => {moveExpansionPointer(event); this.sampleGridPointerMove(event);};
    ui.handlers.pointerup = event => {moveExpansionPointer(event); this.sampleGridPointerUp(event);};
    ui.handlers.pointercancel = event => {
      this.sampleGridPointerCancel(event);
      if (this._sampleExpansionPointer?.id === event.pointerId) {
        this._sampleExpansionPointer.ignored = true; this._sampleExpansionPointer.primary = false;
      }
    };
    ui.handlers.click = event => {
      const path = event.composedPath?.() || [event.target];
      // A stationary card press can finish outside the grid after scrolling
      // or layout motion. Its click never reaches the grid's bubble listener.
      const pressed = this._sampleGridPointer;
      if (pressed?.grid === grid && !path.includes(grid) && !grid.contains(event.target)) {
        this._sampleGridPointer = null;
        if (pressed.ended && event.detail !== 0 && !this.previewLightboxOpen && !this._previewClosePending
            && this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'samples') {
          this._sampleExpansionPointer = null;
          this._sampleGridPointer = pressed;
          this.sampleGridClick(event, grid);
          return;
        }
      }
      const visualPress = pressed?.visual && this._sampleGridPressMatches(event, grid, pressed) && this._sampleGridPressStationary(event, pressed);
      const visualAction = visualPress ? pressed.action : null;
      const inside = visualPress ? (visualAction?.kind === 'batch' ? visualAction.id : visualAction?.batchId) === this.sampleExpandedBatchId
        : path.some(node => node?.matches?.('.m-sample-batch') && node.dataset.batchId === this.sampleExpandedBatchId);
      const cover = visualPress ? visualAction?.kind === 'batch' : path.some(node => node?.classList?.contains('m-sample-batch-cover'));
      const outsideImage = visualPress ? visualAction?.kind === 'image' : path.some(node => node?.matches?.('.preview-grid-item[data-dialog-opens="previewLightbox"]'));
      const keepExpanded = path.some(node => node?.hasAttribute?.('data-sample-expansion-keep'))
        || !!event.target?.closest?.('[data-sample-expansion-keep]');
      const pointer = this._sampleExpansionPointer;
      this._sampleExpansionPointer = null;
      if (visualPress ? !visualAction : pointer?.primary && !pointer.moved && pointer.target === event.target && this._sampleWorkspaceBlankTarget(event, panel)) this.closeSampleSidebarPreview();
      if (inside || cover || keepExpanded || pointer?.ignored || pointer?.moved || !this._sampleExpansionDismissAllowed(event.target)) return;
      if (event.target === grid) {
        const bounds = grid.getBoundingClientRect(), rows = grid.querySelector('.m-sample-group-outline')?._sampleRows || [];
        if (this._sampleOutlineContainsPoint(rows, event.clientX - bounds.left + grid.scrollLeft, event.clientY - bounds.top + grid.scrollTop)) return;
      }
      const batchId = this.sampleExpandedBatchId, action = this._sampleExpansionAction;
      // A native event can checkpoint microtasks between capture and target.
      // Use the next task so the original control and Alpine cleanup finish.
      if (this._sampleExpansionDismissTimer != null) clearTimeout(this._sampleExpansionDismissTimer);
      const timer = setTimeout(() => {
        if (this._sampleExpansionDismissTimer !== timer) return;
        this._sampleExpansionDismissTimer = null;
        const openingOutsideImage = outsideImage && this.previewLightboxOpen && !this._previewClosePending;
        if (this._sampleExpansionAction !== action || this.sampleExpandedBatchId !== batchId || !this._sampleExpansionDismissAllowed(event.target, openingOutsideImage)
          || String(window.getSelection?.() || '').trim()) return;
        this.toggleSampleBatch(batchId, event);
      }, 0);
      this._sampleExpansionDismissTimer = timer;
    };
    ui.handlers.keydown = event => {
      if (event.defaultPrevented || event.isComposing || event.key !== 'Escape' || !this._sampleExpansionDismissAllowed(event.target)) return;
      event.preventDefault(); event.stopPropagation();
      this.toggleSampleBatch(this.sampleExpandedBatchId, event);
    };
    Object.entries(ui.handlers).forEach(([type, handler]) => document.addEventListener(type, handler, type !== 'keydown'));
    if (this.sampleExpandedBatchId && typeof ResizeObserver !== 'undefined') {
      ui.observer = new ResizeObserver(() => {
        if (this._sampleExpansionUI !== ui) return;
        if (!grid.isConnected || (this.currentRoute && this.currentRoute !== 'monitor-dashboard') || (this.monitorTab && this.monitorTab !== 'samples')) {
          this._disconnectSampleExpansionUI(); return;
        }
        if (ui.frame != null) return;
        ui.frame = requestAnimationFrame(() => {ui.frame = null; if (this._sampleExpansionUI === ui) this._refreshSampleGroupOutline(panel);});
      });
      ui.observer.observe(grid);
      grid.querySelectorAll('.m-sample-tile.is-expanded').forEach(node => ui.observer.observe(node));
    }
  },

  _sampleBatchFirstItem(group) {
    // display:contents groups have no box; all navigation uses their first tile.
    return group?.querySelector('.m-sample-tile');
  },

  _captureSampleLayout(grid) {
    return new Map(Array.from(grid.querySelectorAll('.m-sample-tile')).map(node => {
      const button = node.querySelector('.preview-grid-item'), visual = button.querySelector('.m-sample-card-visual');
      return [node.dataset.sampleTileKey, {node, button, visual, rect: visual.getBoundingClientRect(), batchId: node.dataset.batchId}];
    }));
  },

  _cancelSampleGridMotion(grid) {
    if (grid) grid._sampleGridMotion = null;
    grid?.querySelectorAll('.m-sample-card-visual, .m-sample-motion-ghost').forEach(node => {
      node.getAnimations?.().forEach(animation => {if (animation.id === 'sample-grid-flip') animation.cancel();});
      if (node.classList.contains('m-sample-motion-ghost')) node.remove();
    });
  },

  _animateSampleLayout(grid, before, openingId = '', {revealNew = false} = {}) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const bounds = grid.getBoundingClientRect();
    const visible = rect => rect.bottom > bounds.top && rect.top < bounds.bottom && rect.right > bounds.left && rect.left < bounds.right;
    const timing = {duration: parseFloat(window.getComputedStyle?.(grid).getPropertyValue('--sample-fan-duration')) || 200,
      easing: 'cubic-bezier(.22,1,.36,1)'};
    const after = this._captureSampleLayout(grid);
    const origin = Array.from(before.values()).find(item => item.batchId === openingId)?.rect;
    const motion = {items: Array.from(after.values()), animations: new Set()};
    const animateVisual = (item, frames, options) => {
      // Keep the native hit box stable; only its pointer-inert visual moves.
      const animation = item.visual.animate(frames, options);
      animation.id = 'sample-grid-flip';
      motion.animations.add(animation); grid._sampleGridMotion = motion;
      const release = () => {
        motion.animations.delete(animation);
        if (!motion.animations.size && grid._sampleGridMotion === motion) grid._sampleGridMotion = null;
      };
      animation.finished.then(release, release);
    };
    let moved = false;
    for (const [key, item] of after) {
      if (!before.has(key) && !visible(item.rect)) continue;
      const from = before.get(key)?.rect || (item.batchId === openingId ? origin : null);
      if (!from || !item.visual.animate || (!visible(from) && !visible(item.rect))) continue;
      const x = from.left - item.rect.left, y = from.top - item.rect.top;
      if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
      animateVisual(item, [{transform: 'translate(' + x + 'px,' + y + 'px)'}, {transform: 'none'}], timing);
      if (before.has(key)) moved = true;
    }
    if (revealNew && moved) {
      for (const [key, item] of after) {
        if (before.has(key) || !visible(item.rect) || !item.visual.animate) continue;
        animateVisual(item, [{opacity: 0, transform: 'translateY(4px)'}, {opacity: 1, transform: 'none'}],
          {duration: 140, delay: timing.duration, fill: 'backwards', easing: timing.easing});
      }
    }
    // Removed children fly back to their cover without participating in layout.
    // They remain in the media root until the short exit finishes.
    const ghosts = [], exits = [];
    for (const [key, item] of before) {
      if (after.has(key) || !item.node.cloneNode) continue;
      const target = Array.from(after.values()).find(other => other.batchId === item.batchId)?.rect;
      if (!target || !visible(item.rect)) continue;
      const ghost = item.node.cloneNode(true);
      ghost.classList.remove('m-sample-tile'); ghost.classList.add('m-sample-motion-ghost');
      ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
      ghost.setAttribute('x-ignore', '');
      ghost.querySelectorAll('[data-dialog-opens]').forEach(node => node.removeAttribute('data-dialog-opens'));
      ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
      Object.assign(ghost.style, {position: 'absolute', left: item.rect.left - bounds.left + grid.scrollLeft + 'px',
        top: item.rect.top - bounds.top + grid.scrollTop + 'px', width: item.rect.width + 'px', height: item.rect.height + 'px',
        pointerEvents: 'none', zIndex: '3'});
      grid.append(ghost);
      const animation = ghost.animate([{transform: 'none', opacity: 1},
        {transform: 'translate(' + (target.left - item.rect.left) + 'px,' + (target.top - item.rect.top) + 'px)', opacity: 0}], timing);
      animation.id = 'sample-grid-flip';
      ghosts.push(ghost); exits.push(animation.finished);
    }
    if (ghosts.length) Promise.allSettled(exits).then(() => {
      if (ghosts.some(ghost => ghost.isConnected)) this._updateSampleExpansionMedia(grid.closest('.m-tab-panel'), () => ghosts.forEach(ghost => ghost.remove()));
    });
  },

  _updateSampleExpansionMedia(panel, update) {
    // Include the persistent viewer: local details must not revoke URLs still
    // used by its strip or by an overview image which is currently decoding.
    const root = document.getElementById('monitorDashboard') || panel;
    if (!root) { update(); return; }
    const loaded = this._capturePreviewMedia(root);
    this._cancelPreviewMediaQueue();
    try { update(); }
    finally {
      this._restorePreviewMedia(root, loaded);
      this.schedulePreviewMediaLoads(root);
    }
  },

  _replaceSampleBatchCards(panel, ids, preserveId = '', animate = true) {
    const grid = panel?.querySelector('.m-sample-batches');
    if (!grid) return;
    const groups = Array.from(grid.querySelectorAll('.m-sample-batch'));
    const anchor = this._sampleBatchFirstItem(groups.find(group => group.dataset.batchId === preserveId));
    const anchorTop = anchor?.getBoundingClientRect().top;
    const before = this._captureSampleLayout(grid);
    this._updateSampleExpansionMedia(panel, () => {
      this._cancelSampleGridMotion(grid);
      ids.forEach(id => {
        const group = groups.find(node => node.dataset.batchId === id), batch = this._sampleDataModel().byBatch.get(id);
        if (!group || !batch) return;
        group.innerHTML = this._sampleBatchItemsHtml((key, fallback) => this.tMonitor(key, fallback), batch);
        group.dataset.expanded = String(this.sampleExpandedBatchId === id);
      });
      const nextAnchor = this._sampleBatchFirstItem(groups.find(group => group.dataset.batchId === preserveId));
      if (nextAnchor && Number.isFinite(anchorTop)) grid.scrollTop += nextAnchor.getBoundingClientRect().top - anchorTop;
      this._refreshSampleGroupOutline(panel, animate && !!this.sampleExpandedBatchId);
      if (animate) this._animateSampleLayout(grid, before, this.sampleExpandedBatchId);
    });
    this._connectSampleExpansionUI(panel);
  },

  toggleSampleBatch(id, event) {
    const batch = this._sampleDataModel().byBatch.get(id);
    const panel = this._sampleOverviewPanel(), grid = panel?.querySelector('.m-sample-batches');
    if (!batch || !grid || !this._sampleBatchIsExpandable(batch)) return;
    this._sampleLayoutAction++;
    this._sampleScrollAnchor = null;
    const previousId = this.sampleExpandedBatchId;
    const closing = this.sampleExpandedBatchId === id;
    this._sampleExpansionAction = (this._sampleExpansionAction || 0) + 1;
    this.sampleExpandedBatchId = closing ? '' : id;
    if (!closing) {
      this._sampleExpansionPausedFollow = id !== this._sampleDataModel().batches.at(-1)?.id;
      if (this._sampleExpansionPausedFollow) this._sampleOverviewAtEnd = false;
      this._activateOverviewBatch(batch);
      if (this.sampleSidebarVisible) this.sampleSidebarOpen = true;
    }
    if (closing) this._sampleExpansionPausedFollow = false;
    this._replaceSampleBatchCards(panel, [...new Set([previousId, id].filter(Boolean))], id);
    this._sampleOverviewJumpId = id;
    if (!closing || event?.key === 'Escape') {
      const focusId = closing ? 'sampleBatch-' + encodeURIComponent(id) : 'sample-' + encodeURIComponent(this._previewItemKey(this.previews[batch.indices[0]]));
      const focus = document.getElementById(focusId);
      focus?.focus({preventScroll: true});
      if (closing && focus?.getBoundingClientRect) {
        const bounds = grid.getBoundingClientRect(), rect = focus.getBoundingClientRect();
        if (rect.top < bounds.top) grid.scrollTop += rect.top - bounds.top;
        else if (rect.bottom > bounds.bottom) grid.scrollTop += rect.bottom - bounds.bottom;
      }
    }
  },

  _sampleOverviewPanel() {
    return document.getElementById('monitorTabContent')?.querySelector('.m-tab-panel[data-tab="samples"]');
  },

  _activateOverviewBatch(batch) {
    if (!batch) return;
    if (this.sampleBatchId !== batch.id) {
      const selected = this.previews[this.previewStep];
      this.sampleBatchId = batch.id;
      if (!this.previewLightboxOpen) this.previewStep = this._sampleBatchNavigationIndex(batch, selected);
    }
  },

  _scrollOverviewToBatch(panel, batch) {
    const grid = panel?.querySelector('.m-sample-batches');
    const group = grid && Array.from(grid.querySelectorAll('.m-sample-batch')).find(item => item.dataset.batchId === batch?.id);
    if (!grid || !group) return;
    const before = grid.scrollTop;
    const pending = !!this._sampleOverviewJumpId;
    grid.scrollTop += this._sampleBatchFirstItem(group).getBoundingClientRect().top - grid.getBoundingClientRect().top;
    this._sampleOverviewJumpId = pending || Math.abs(grid.scrollTop - before) >= 1 ? batch.id : '';
  },

  sampleOverviewScroll(event) {
    const grid = event.currentTarget;
    const atEnd = this._sampleOverviewAtLatestEdge(grid);
    this._sampleOverviewAtEnd = atEnd;
    // A passive vertical scroll never changes the selected sample.
    // Render captures a fresh visible anchor only when data actually rebuilds.
    if (!Number.isFinite(this._sampleScrollAnchor?.scrollTop) || Math.abs(grid.scrollTop - this._sampleScrollAnchor.scrollTop) >= 1) this._sampleScrollAnchor = null;
    const jumpId = this._sampleOverviewJumpId;
    this._sampleOverviewJumpId = '';
    if (!atEnd || this._sampleExpansionPausedFollow) return;
    const latest = this._sampleDataModel().batches.at(-1);
    if (!latest || (jumpId && jumpId !== latest.id)) return;
    if (this.previewHasNew) this._acknowledgeNewPreviews(grid.closest('.m-tab-panel'));
  },

  jumpToLatestOverviewBatch() {
    this._sampleLayoutAction++;
    this._sampleScrollAnchor = null;
    const batch = this._sampleDataModel().batches.at(-1), panel = this._sampleOverviewPanel();
    if (!batch || !panel) return;
    this._sampleSidebarInspecting = false;
    this._resumeLatestSampleOverview(panel);
    this._activateOverviewBatch(batch);
    if (this.sampleSidebarVisible) this.sampleSidebarOpen = true;
    this._scrollOverviewToBatch(panel, batch);
    this._acknowledgeNewPreviews(panel);
  },

  _resumeLatestSampleOverview(panel) {
    this._sampleExpansionPausedFollow = false;
    if (this.sampleExpandedBatchId && this.sampleExpandedBatchId !== this._sampleDataModel().batches.at(-1)?.id) {
      const previousId = this.sampleExpandedBatchId;
      this.sampleExpandedBatchId = '';
      this._sampleExpansionAction = (this._sampleExpansionAction || 0) + 1;
      this._replaceSampleBatchCards(panel, [previousId], '', false);
    }
    this._sampleOverviewAtEnd = true;
  },

  scrollPreviewViewTimeline(event) {
    const rail = event.currentTarget;
    if (event.ctrlKey || event.metaKey || rail.scrollWidth <= rail.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const before = rail.scrollLeft;
    rail.scrollLeft += event.deltaY;
    if (rail.scrollLeft !== before) event.preventDefault();
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
    const stage = () => '<div class="preview-view-stage">'
      + '<img id="previewLightboxImg" class="preview-view-image" alt="" draggable="false" @load="resizePreviewComparisonImages()">'
      + '<button type="button" class="btn btn-sm btn-secondary preview-view-error" x-show="previewImageError" @click.stop="retryPreviewImage()">' + this.esc(t('previewImageRetry')) + '</button></div>';
    return '<dialog class="preview-lightbox modal-overlay" id="previewLightbox" x-dialog="previewLightboxOpen" @click.self="closePreviewLightbox()" @dialog-close="closePreviewLightbox()" @dialog-after-close="clearPreviewLightbox()" @keydown="previewLightboxKeydown($event)" @resize.window="resizePreviewLightbox()" aria-label="' + this.esc(t('previewSamples')) + '" x-cloak>'
      + '<div class="modal preview-lightbox-window" :class="{\'is-comparing\': previewCompareActive}"><div class="modal-header preview-lightbox-topbar">'
      + '<div class="preview-lightbox-heading"><div class="preview-lightbox-title"><strong id="previewLightboxLabel"></strong>'
      + this._previewInfoButtonHtml(t, 'previewInfoButton')
      + '<span id="previewLightboxPrompt" class="preview-lightbox-prompt" x-loop-marquee hidden><span id="previewLightboxPromptText"></span></span></div>'
      + '<div class="preview-lightbox-navigation" role="group" aria-label="' + this.esc(t('sampleBatchSelect')) + '">'
      + '<button type="button" class="btn-icon preview-lightbox-nav prev" @click="previewLightboxNav(-1)" title="' + this.esc(this.t('imageViewer.previousHint')) + '" aria-label="' + this.esc(t('prev')) + '" aria-keyshortcuts="ArrowLeft">' + left + '</button>'
      + '<span id="previewLightboxCounter" class="preview-lightbox-counter"><span class="preview-lightbox-counter-current"><button type="button" id="previewLightboxCounterDisplay" class="preview-lightbox-counter-display" x-show="!previewPageEditing" @click="openPreviewPageEditor()" aria-label="' + this.esc(t('previewPageNumber')) + '"></button><input id="previewLightboxPage" class="preview-lightbox-page" x-show="previewPageEditing" x-cloak type="text" inputmode="numeric" autocomplete="off" spellcheck="false" aria-label="' + this.esc(t('previewPageNumber')) + '" aria-describedby="previewLightboxCounterTotal" @focus="beginPreviewPageEdit($event)" @input="updatePreviewPageDraft($event)" @compositionend="updatePreviewPageDraft($event)" @blur="commitPreviewPageEdit($event)" @keydown="previewPageKeydown($event)"></span><span class="preview-lightbox-counter-divider" aria-hidden="true">/</span><span id="previewLightboxCounterTotal" class="preview-lightbox-counter-total"></span></span>'
      + '<button type="button" class="btn-icon preview-lightbox-nav next" @click="previewLightboxNav(1)" title="' + this.esc(this.t('imageViewer.nextHint')) + '" aria-label="' + this.esc(t('next')) + '" aria-keyshortcuts="ArrowRight">' + right + '</button></div>'
      + '</div>'
      + '<div class="preview-lightbox-tools">'
      + '<button type="button" class="btn btn-sm btn-primary preview-new-samples" x-show="_previewHasNewInViewerSequence()" @click="jumpToLatestPreview()">' + this.esc(t('previewNewSamples')) + '</button>'
      + '<button type="button" id="previewReferenceButton" class="btn btn-sm btn-secondary preview-tool-action" :class="{ active: previewCompareActive }" :disabled="!previewCompareActive && !canPinCurrentPreview()" :title="previewReferenceActionTitle()" :aria-pressed="previewCompareActive ? \'true\' : \'false\'" @click="togglePreviewReference()" x-text="previewCompareActive ? t(\'monitor.sampleEndCompare\') : t(\'monitor.sampleCompareReference\')"></button>'
      + '<button type="button" class="btn btn-sm btn-ghost preview-tool-action" x-show="previewCompareActive && !previewComparisonWaiting" :disabled="!canPinCurrentPreview()" @click="pinCurrentPreviewReference()" title="' + this.esc(t('samplePinRightHint')) + '" x-text="t(\'monitor.sampleCompareReference\')"></button>'
      + '<a class="btn btn-sm btn-ghost preview-tool-action" id="previewLightboxOriginal" target="_blank" rel="noopener">' + this.esc(t('openOriginal')) + '</a>'
      + '<div class="preview-lightbox-zoom">'
      + '<button type="button" class="btn-icon preview-icon-button" @click="setPreviewViewScale(previewViewScale / 1.18)" :disabled="previewViewAtFit()" title="' + this.esc(this.t('tagEditor.zoomOut')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomOut')) + '">' + zoomOut + '</button>'
      + '<button type="button" class="preview-zoom-value" @click="resetPreviewView(true)" :title="previewViewZoomLabel() + \' · \' + t(\'imageViewer.zoomHint\')" aria-keyshortcuts="0" x-text="previewViewZoomLabel()"></button>'
      + '<button type="button" class="btn-icon preview-icon-button" @click="setPreviewViewScale(previewViewScale * 1.18)" :disabled="previewViewScale >= 8" title="' + this.esc(this.t('tagEditor.zoomIn')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomIn')) + '">' + zoomIn + '</button></div>'
      + '<button type="button" class="btn-icon preview-icon-button preview-close" data-dialog-autofocus @click="closePreviewLightbox()" title="' + this.esc(this.t('imageViewer.closeHint')) + '" aria-label="' + this.esc(t('close')) + '" aria-keyshortcuts="Escape">' + close + '</button></div></div>'
      + '<div class="preview-lightbox-body"><div class="preview-lightbox-canvas">'
      + '<div id="previewLightboxViewport" class="preview-lightbox-panes" :class="{zoomed: !previewViewAtFit(), panning: previewViewPanning}" @wheel="zoomPreviewView($event)" @pointerdown="startPreviewPan($event)" @pointermove="movePreviewPan($event)" @pointerup="stopPreviewPan($event)" @pointercancel="stopPreviewPan($event)" @lostpointercapture="stopPreviewPan($event)" @dblclick="if (!$event.target.closest(\'button\')) { $event.preventDefault(); resetPreviewView(true); }" @dragstart.prevent><div id="previewLightboxExtent" class="preview-lightbox-extent"><div id="previewLightboxGroup" class="preview-lightbox-group"><div id="previewReferencePanes" class="preview-reference-panes" hidden></div>'
      + '<div class="preview-lightbox-pane preview-current-pane"><div id="previewCurrentStage" class="preview-current-stage">' + stage() + '</div><div id="previewComparisonPlaceholder" class="preview-comparison-placeholder" hidden>' + this.esc(t('sampleSelectComparison')) + '</div><div id="previewCurrentCaptionSlot" class="preview-caption-slot" hidden><div class="preview-pane-caption" id="previewCurrentCaption" hidden>' + this._previewCaptionTextHtml(true) + '</div></div></div></div></div></div>'
      + '</div><div class="preview-lightbox-footer"><div id="previewLightboxBar" class="preview-lightbox-bar">' + this._previewPromptBarArrowHtml(t, -1)
      + '<div id="previewLightboxStrip" class="preview-lightbox-strip" role="group" aria-label="' + this.esc(t('sampleBatchImages')) + '" @scroll.passive="syncPreviewPromptBar()" @pointerdown="startPreviewPromptBarDrag($event)" @pointermove="movePreviewPromptBarDrag($event)" @pointerup="endPreviewPromptBarDrag($event)" @pointercancel="endPreviewPromptBarDrag($event)" @lostpointercapture="endPreviewPromptBarDrag($event)" @pointerleave="leavePreviewPromptBarDrag($event)" @click.capture="suppressPreviewPromptBarClick($event)" @dragstart.prevent></div>'
      + this._previewPromptBarArrowHtml(t, 1)
      + '<div class="preview-lightbox-bar-controls" x-effect="previewCompareActive; $nextTick(() => syncPreviewPromptBar())"><div x-show="previewCompareActive" x-cloak>'
      + this._sampleSelectHtml([{value: 'horizontal', label: t('sampleCompareHorizontal')}, {value: 'vertical', label: t('sampleCompareVertical')}], this.previewComparisonLayout, t('sampleCompareLayout'), 'previewComparisonLayout', 'setPreviewComparisonLayout($event.target.value)')
      + '</div><div class="m-sample-view-toggle" x-show="previewViewTimelineAvailable"><span id="previewTimelineToggleLabel">' + this.esc(t('sampleThumbnails')) + '</span><label class="toggle"><input type="checkbox" role="switch" :checked="previewViewTimelineVisible" aria-labelledby="previewTimelineToggleLabel" aria-controls="previewLightboxTimelineFrame" @change="togglePreviewViewTimeline($event)"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div>'
      + this._previewTimelineLocateHtml(t) + '</div></div>'
      + '<div id="previewLightboxTimelineFrame" class="preview-view-timeline-frame" :class="{\'is-collapsed\': !previewViewTimelineVisible}" :inert="!previewViewTimelineVisible" :aria-hidden="!previewViewTimelineVisible" hidden><div class="preview-view-timeline-clip"><div id="previewLightboxTimeline" class="preview-view-timeline" role="group" aria-label="' + this.esc(t('sampleBatchSelect')) + '" @keydown="previewViewTimelineKeydown($event)" @wheel="scrollPreviewViewTimeline($event)"'
      + ' @pointerdown="startPreviewViewTimelineDrag($event)" @pointermove="movePreviewViewTimelineDrag($event)" @pointerup="endPreviewViewTimelineDrag($event)" @pointercancel="endPreviewViewTimelineDrag($event)" @pointerleave="leavePreviewViewTimeline($event)" @click.capture="suppressPreviewViewTimelineClick($event)" @dragstart.prevent hidden></div>'
      + '</div></div>'
      + '</div></div></div>'
      + this._previewTimelineContextMenuHtml(t) + '</dialog>'
      + '<dialog id="previewInfoDialog" class="modal-overlay preview-info-overlay" x-dialog="previewInfoOpen" @click.self.stop="previewInfoOpen=false" @dialog-close.stop="previewInfoOpen=false" @dialog-after-close.stop="previewInfoOpen=false" @keydown.stop aria-labelledby="previewInfoTitle" x-cloak>'
      + '<div class="modal preview-info-window"><div class="modal-header"><h3 id="previewInfoTitle">' + this.esc(t('sampleGenerationInfo')) + '</h3>'
      + '<button type="button" class="btn-icon preview-icon-button" data-dialog-autofocus @click="previewInfoOpen=false" aria-label="' + this.esc(t('close')) + '">' + close + '</button></div>'
      + '<div class="modal-body preview-info-content" id="previewGenerationInfo" x-html="previewInfoOpen ? _previewGenerationInfoHtml(_previewInfoPreview()) : \'\'"></div></div></dialog>';
  },

  openPreviewLightbox(i) {
    if (!this.previews.length) return;
    if (!this.previewLightboxOpen) this.clearPreviewLightbox();
    this.previewStep = Math.max(0, Math.min(i, this.previews.length - 1));
    this.sampleBatchId = this._sampleRecord(this.previews[this.previewStep], this.previewStep).batch_id;
    const box = document.getElementById('previewLightbox');
    if (!box) return;
    if (this.sampleBatchId === this._sampleDataModel().batches.at(-1)?.id) this._acknowledgeNewPreviews();
    this.previewLightboxOpen = true;
    this.resetPreviewView();
    this._updatePreviewLightbox();
    if (this.weakNetworkMode) this.schedulePreviewMediaLoads(box);
    this._revealPreviewViewAfterOpen(box);
  },

  _revealPreviewViewAfterOpen(box) {
    this._previewOpenObserver?.disconnect();
    this._previewOpenObserver = null;
    // The dialog opens on Alpine's next tick. Long histories can delay that
    // tick, so wait for the actual open attribute instead of a frame limit.
    const onOpen = () => {
      if (!this.previewLightboxOpen || !box.isConnected || !box.open) return;
      this._previewOpenObserver?.disconnect();
      this._previewOpenObserver = null;
      requestAnimationFrame(() => {
        if (this.previewLightboxOpen && box.isConnected && box.open) {
          this._connectPreviewViewportResize();
          this.resizePreviewComparisonImages();
          this._revealPreviewViewTimeline();
          this._revealPreviewPromptStrip();
          this.syncPreviewPromptBar();
        }
      });
    };
    if (box.open) onOpen();
    else if (typeof MutationObserver !== 'undefined') {
      this._previewOpenObserver = new MutationObserver(onOpen);
      this._previewOpenObserver.observe(box, { attributes: true, attributeFilter: ['open'] });
    } else {
      let attempts = 0;
      const retry = () => {
        if (!this.previewLightboxOpen || !box.isConnected) return;
        if (box.open) onOpen();
        else if (attempts++ < 120) requestAnimationFrame(retry);
      };
      requestAnimationFrame(retry);
    }
  },

  closePreviewLightbox() {
    this._cancelPreviewReset();
    this.stopPreviewPan();
    this.closePreviewTimelineMenu(false);
    this.cancelPreviewPromptBarDrag();
    if (!this.previewLightboxOpen) return;
    this._resetPreviewPageEditor();
    this.previewInfoOpen = false;
    this.previewLightboxOpen = false;
    this._previewOpenObserver?.disconnect();
    this._previewOpenObserver = null;
    this._previewClosePending = true;
    this._cancelPreviewRailDrag('_previewViewTimeline');
    // Keep the visible sources until the closing animation has finished.
    this._clearPreviewImageLoading();
    if (this.weakNetworkMode && this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'samples') {
      this._cancelPreviewMediaQueue();
      const content = document.getElementById('monitorTabContent');
      if (content) this.schedulePreviewMediaLoads(content);
    }
  },

  clearPreviewLightbox() {
    this.closePreviewTimelineMenu(false);
    this.cancelPreviewPromptBarDrag();
    if (this.previewLightboxOpen) return;
    this._resetPreviewPageEditor();
    this.previewInfoOpen = false;
    const restoreSample = this._previewClosePending && this.currentRoute === 'monitor-dashboard'
      && this.monitorTab === 'samples' && this.previews[this.previewStep];
    const image = document.getElementById('previewLightboxImg');
    if (image) { window.AnimaImages.cancel(image); image.removeAttribute('src'); }
    this._clearPreviewReferenceImages();
    this._previewClosePending = false;
    this.stopPreviewComparison();
    this._previewImageKey = '';
    this.previewImageLoading = this.previewImageError = false;
    this.previewImageAvailable = false;
    this._previewGroupGeometry = null; this._previewViewportLayout = null; this._previewViewFitScale = 1;
    this.resetPreviewView();
    if (restoreSample) {
      const item = document.getElementById('sample-' + encodeURIComponent(this._previewItemKey(restoreSample)));
      const cover = document.getElementById('sampleBatch-' + encodeURIComponent(this._sampleRecord(restoreSample).batch_id));
      (item || cover)?.focus({ preventScroll: true });
    }
  },

  togglePreviewReference() {
    if (this.previewCompareActive) this.stopPreviewComparison();
    else if (this.canPinCurrentPreview()) this.startPreviewComparison();
  },

  previewImageAvailable: false,

  canPinCurrentPreview() {
    return this.previewImageAvailable && !this.previewImageLoading && this.canCompareCurrentPreview();
  },

  _setPreviewImageAvailable(available) {
    this.previewImageAvailable = available;
    if (this.previewTimelineMenu) this.previewTimelineMenu.actions = this._previewTimelineMenuActions();
  },

  previewReferenceActionTitle() {
    if (this.previewCompareActive) return '';
    if (this.previewImageLoading) return this.t('monitor.loading');
    if (!this.previewImageAvailable) return this.t('monitor.previewImageFailed');
    return this.t(this.canCompareCurrentPreview() ? 'monitor.samplePinCurrentHint' : 'monitor.sampleNoReferenceMatch');
  },

  pinCurrentPreviewReference() {
    if (!this.canPinCurrentPreview() || !this.setCurrentPreviewAsReference()) return;
    // Keep keyboard navigation with the right-side time point after pinning.
    const timeline = document.getElementById('previewLightboxTimeline');
    const selected = timeline?.querySelector('[aria-pressed="true"]');
    (selected || document.getElementById('previewReferenceButton'))?.focus({ preventScroll: true });
  },

  previewLightboxNav(dir) {
    this.closePreviewTimelineMenu(false);
    if (!this.previews.length) return;
    const next = this._previewLightboxNavigationTarget(dir);
    if (next >= 0 && this.selectPreviewComparisonCurrent(next)) this._updatePreviewLightbox();
  },

  _resetPreviewPageEditor() {
    this.previewPageEditing = false; this.previewPageDraft = ''; this._previewPageLastDraft = '';
  },

  _normalizePreviewPageDraft(value) {
    return String(value ?? '').replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10)).trim();
  },

  _previewPagePosition(indices = this._previewLightboxNavigationIndices()) {
    return indices.indexOf(this.previewStep) + 1;
  },

  openPreviewPageEditor() {
    if (!this._previewLightboxNavigationIndices().length) return;
    this.previewPageEditing = true;
    this.previewPageDraft = String(this._previewPagePosition() || 1);
    this._previewPageLastDraft = this.previewPageDraft;
    const focus = () => {
      if (!this.previewPageEditing) return;
      const input = document.getElementById('previewLightboxPage');
      if (input) { input.value = this.previewPageDraft; input.focus?.(); input.select?.(); }
    };
    if (typeof this.$nextTick === 'function') this.$nextTick(focus);
    else focus();
  },

  beginPreviewPageEdit(event) {
    if (!this._previewLightboxNavigationIndices().length) return;
    const input = event.currentTarget;
    this.previewPageEditing = true;
    this.previewPageDraft = String(this._previewPagePosition() || 1);
    this._previewPageLastDraft = this.previewPageDraft;
    input.value = this.previewPageDraft;
    input.select?.();
  },

  updatePreviewPageDraft(event) {
    if (!this.previewPageEditing || event.isComposing) return;
    const input = event.currentTarget, draft = this._normalizePreviewPageDraft(input.value);
    if (draft === '' || draft === '-' || /^-?\d+$/.test(draft)) {
      this.previewPageDraft = draft; this._previewPageLastDraft = draft;
    }
    input.value = this._previewPageLastDraft;
  },

  commitPreviewPageEdit(event) {
    if (!this.previewPageEditing) return false;
    const input = event?.currentTarget, indices = this._previewLightboxNavigationIndices();
    const draft = this._normalizePreviewPageDraft(input?.value ?? this.previewPageDraft);
    // Validate before Number conversion: very long integers may become
    // +/-Infinity and should clamp, while decimals/exponents/text are rejected.
    const page = /^-?\d+$/.test(draft) && indices.length
      ? Math.max(1, Math.min(indices.length, Number(draft))) : this._previewPagePosition(indices);
    this.previewPageEditing = false;
    this.previewPageDraft = page ? String(page) : ''; this._previewPageLastDraft = this.previewPageDraft;
    if (input) input.value = this.previewPageDraft;
    const index = indices[page - 1];
    if (index !== undefined && (index !== this.previewStep || this.previewComparisonWaiting)) this.selectPreviewTimeline(index);
    else this._updatePreviewLightbox();
    return true;
  },

  _focusPreviewPageNavigation(input) {
    const focus = () => {
      const timeline = document.getElementById('previewLightboxTimeline');
      const selected = !timeline?.hidden && timeline?.querySelector('[aria-pressed="true"]');
      const box = document.getElementById('previewLightbox');
      const target = selected || box?.querySelector('.preview-lightbox-nav.next:not(:disabled)')
        || box?.querySelector('.preview-lightbox-nav.prev:not(:disabled)')
        || document.getElementById('previewLightboxCounterDisplay') || box?.querySelector('.preview-close');
      if (target) target.focus({preventScroll: true});
      else input?.blur?.();
    };
    if (typeof this.$nextTick === 'function') this.$nextTick(focus);
    else focus();
  },

  previewPageKeydown(event) {
    if (event.key === 'Tab') return;
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commitPreviewPageEdit(event);
      this._focusPreviewPageNavigation(event.currentTarget);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this._resetPreviewPageEditor();
      event.currentTarget.value = String(this._previewPagePosition());
      this._focusPreviewPageNavigation(event.currentTarget);
    }
  },

  selectPreviewTimeline(index) {
    this.closePreviewTimelineMenu(false);
    if (!this._previewLightboxDisplayIndices().includes(index)) return;
    const preview = this.previews[index];
    if (this._isPreviewReference(preview)) {
      this.locatePreviewReference(this._previewItemKey(preview));
      return;
    }
    if (index === this.previewStep && !this.previewComparisonWaiting) return;
    if (this.selectPreviewComparisonCurrent(index)) this._updatePreviewLightbox();
  },

  locatePreviewReference(key) {
    const pane = this._previewReferenceMedia?.entries.get(key)?.pane;
    const viewport = document.getElementById('previewLightboxViewport');
    if (!this.previewLightboxOpen || !pane || !viewport) return;
    const bounds = viewport.getBoundingClientRect(), rect = pane.getBoundingClientRect();
    const scale = viewport.offsetWidth ? bounds.width / viewport.offsetWidth : 1;
    if (!rect.width || !rect.height || !Number.isFinite(scale) || scale <= 0) return;
    const left = bounds.left + (viewport.clientLeft || 0) * scale;
    const top = bounds.top + (viewport.clientTop || 0) * scale;
    const delta = (start, end, near, far) => end - start > far - near
      ? (start + end - near - far) / 2 : start < near ? start - near : end > far ? end - far : 0;
    const targetLeft = Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth,
      viewport.scrollLeft + delta(rect.left, rect.right, left, left + viewport.clientWidth * scale) / scale));
    const targetTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight,
      viewport.scrollTop + delta(rect.top, rect.bottom, top, top + viewport.clientHeight * scale) / scale));
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    this._highlightPreviewReference(pane, reduced);
    if (Math.abs(targetLeft - viewport.scrollLeft) < 1 && Math.abs(targetTop - viewport.scrollTop) < 1) return;
    // Scroll this viewport only; scrollIntoView also moves the outer gallery.
    if (typeof viewport.scrollTo === 'function') viewport.scrollTo({left: targetLeft, top: targetTop, behavior: reduced ? 'instant' : 'smooth'});
    else {viewport.scrollLeft = targetLeft; viewport.scrollTop = targetTop;}
  },

  _previewReferenceLocateAnimation: null,

  _highlightPreviewReference(pane, reduced) {
    this._previewReferenceLocateAnimation?.cancel();
    const indicator = pane.querySelector?.('.preview-reference-locate-flash');
    const frames = reduced ? [{opacity: 1}, {opacity: 1, offset: 0.99}, {opacity: 0}]
      : [{opacity: 0}, {opacity: 1, offset: 0.1}, {opacity: 1, offset: 0.7}, {opacity: 0}];
    const animation = indicator?.animate?.(frames, {duration: reduced ? 700 : 1400, easing: 'ease-out'});
    this._previewReferenceLocateAnimation = animation || null;
    animation?.finished.then(() => {
      if (this._previewReferenceLocateAnimation === animation) this._previewReferenceLocateAnimation = null;
    }, () => {});
  },

  selectPreviewTimelineByKey(key) {
    const index = this.previews.findIndex(preview => this._previewItemKey(preview) === key);
    if (index >= 0) this.selectPreviewTimeline(index);
  },

  selectPreviewCaseByKey(key) {
    this.closePreviewTimelineMenu(false);
    const index = this.previews.findIndex(preview => this._previewItemKey(preview) === key);
    if (index >= 0) this.selectPreviewCase(index);
  },

  previewViewTimelineKeydown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const indices = this._previewLightboxNavigationIndices();
    let index;
    if (event.key === 'ArrowLeft') index = this._previewLightboxNavigationTarget(-1);
    else if (event.key === 'ArrowRight') index = this._previewLightboxNavigationTarget(1);
    else if (event.key === 'Home') index = indices[0];
    else if (event.key === 'End') index = indices.at(-1);
    else return;
    event.preventDefault(); event.stopPropagation();
    if (!Number.isInteger(index) || index < 0) return;
    this.selectPreviewTimeline(index);
    event.currentTarget.querySelector('[data-preview-index="' + index + '"]')?.focus({ preventScroll: true });
  },

  previewPromptBarOverflow: false,
  previewPromptBarAtStart: true,
  previewPromptBarAtEnd: true,
  _previewPromptBarDrag: null,
  _previewPromptBarSuppressClick: false,
  _previewPromptBarClickTimer: null,

  _previewPromptBarArrowHtml(t, direction) {
    const previous = direction < 0;
    const label = this.esc(t(previous ? 'samplePromptScrollLeft' : 'samplePromptScrollRight'));
    return '<button type="button" class="btn-icon preview-prompt-bar-arrow" x-show="previewPromptBarOverflow" x-cloak'
      + ' :disabled="' + (previous ? 'previewPromptBarAtStart' : 'previewPromptBarAtEnd') + '" @click="scrollPreviewPromptBar(' + (previous ? -1 : 1) + ')"'
      + ' title="' + label + '" aria-label="' + label + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="' + (previous ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6') + '"/></svg></button>';
  },

  syncPreviewPromptBar() {
    const rail = document.getElementById('previewLightboxStrip');
    if (!rail || rail.hidden || !rail.clientWidth) {
      this.previewPromptBarOverflow = false;
      this.previewPromptBarAtStart = this.previewPromptBarAtEnd = true;
      this.cancelPreviewPromptBarDrag();
      return;
    }
    const bar = rail.parentElement;
    const gap = parseFloat(window.getComputedStyle?.(bar)?.columnGap) || 0;
    // Test against the space available without arrows, so they cannot keep
    // themselves visible after the prompts fit following a resize/update.
    const arrowSpace = Array.from(bar?.querySelectorAll('.preview-prompt-bar-arrow') || [])
      .reduce((width, arrow) => width + (arrow.offsetWidth ? arrow.offsetWidth + gap : 0), 0);
    const overflow = rail.scrollWidth > rail.clientWidth + arrowSpace + 1;
    const changed = this.previewPromptBarOverflow !== overflow;
    this.previewPromptBarOverflow = overflow;
    const max = Math.max(0, rail.scrollWidth - rail.clientWidth);
    this.previewPromptBarAtStart = !overflow || rail.scrollLeft <= 1;
    this.previewPromptBarAtEnd = !overflow || max - rail.scrollLeft <= 1;
    if (!overflow) this.cancelPreviewPromptBarDrag();
    // x-show changes the rail width on the next Alpine flush.
    if (changed) this.$nextTick?.(() => this.syncPreviewPromptBar());
  },

  scrollPreviewPromptBar(direction) {
    const rail = document.getElementById('previewLightboxStrip');
    if (!rail || rail.hidden || !this.previewPromptBarOverflow) return;
    this.cancelPreviewPromptBarDrag();
    this._scrollSampleRail(rail, rail.scrollLeft + Math.sign(direction) * Math.max(80, rail.clientWidth * 0.75));
    this.syncPreviewPromptBar();
  },

  startPreviewPromptBarDrag(event) {
    this._startPreviewRailDrag(event, '_previewPromptBar');
  },

  movePreviewPromptBarDrag(event) {
    this._movePreviewRailDrag(event, '_previewPromptBar');
    this.syncPreviewPromptBar();
  },

  endPreviewPromptBarDrag(event) {
    this._endPreviewRailDrag(event, '_previewPromptBar');
  },

  leavePreviewPromptBarDrag(event) {
    this._leavePreviewRailDrag(event, '_previewPromptBar');
  },

  suppressPreviewPromptBarClick(event) {
    this._suppressPreviewRailClick(event, '_previewPromptBar');
  },

  cancelPreviewPromptBarDrag() {
    this._cancelPreviewRailDrag('_previewPromptBar');
  },

  _previewViewTimelineDrag: null,
  _previewViewTimelineSuppressClick: false,

  startPreviewViewTimelineDrag(event) {
    this._startPreviewRailDrag(event, '_previewViewTimeline');
  },

  movePreviewViewTimelineDrag(event) {
    this._movePreviewRailDrag(event, '_previewViewTimeline');
  },

  endPreviewViewTimelineDrag(event) {
    this._endPreviewRailDrag(event, '_previewViewTimeline');
  },

  leavePreviewViewTimeline(event) {
    this._leavePreviewRailDrag(event, '_previewViewTimeline');
  },

  suppressPreviewViewTimelineClick(event) {
    this._suppressPreviewRailClick(event, '_previewViewTimeline');
  },

  _startPreviewRailDrag(event, prefix) {
    if (event.button !== 0 || event.isPrimary === false) return;
    this._cancelPreviewRailDrag(prefix);
    const rail = event.currentTarget;
    if (rail.scrollWidth <= rail.clientWidth + 1) return;
    this._scrollSampleRail(rail, rail.scrollLeft, false);
    const width = rail.getBoundingClientRect?.().width;
    const scale = rail.offsetWidth && width ? width / rail.offsetWidth : 1;
    this[prefix + 'Drag'] = {rail, pointerId: event.pointerId, startX: event.clientX,
      startScroll: rail.scrollLeft, scale, dragging: false};
  },

  _movePreviewRailDrag(event, prefix) {
    const drag = this[prefix + 'Drag'];
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = event.clientX - drag.startX;
    if (!drag.dragging && Math.abs(distance) <= 6) return;
    if (!drag.dragging) {
      drag.dragging = true;
      drag.rail.setPointerCapture?.(event.pointerId);
      drag.rail.classList.add('is-dragging');
    }
    const maximum = drag.rail.scrollWidth - drag.rail.clientWidth;
    drag.rail.scrollLeft = Math.max(0, Math.min(Number.isFinite(maximum) ? maximum : Infinity, drag.startScroll - distance / drag.scale));
    event.preventDefault();
  },

  _endPreviewRailDrag(event, prefix) {
    const drag = this[prefix + 'Drag'];
    if (!drag || drag.pointerId !== event.pointerId) return;
    this[prefix + 'Drag'] = null;
    if (drag.rail.hasPointerCapture?.(event.pointerId)) drag.rail.releasePointerCapture(event.pointerId);
    drag.rail.classList.remove('is-dragging');
    if (!drag.dragging) return;
    this[prefix + 'SuppressClick'] = true;
    this[prefix + 'ClickTimer'] = setTimeout(() => {
      this[prefix + 'SuppressClick'] = false;
      this[prefix + 'ClickTimer'] = null;
    }, 0);
  },

  _leavePreviewRailDrag(event, prefix) {
    const drag = this[prefix + 'Drag'];
    if (drag && !drag.dragging && drag.pointerId === event.pointerId) this[prefix + 'Drag'] = null;
  },

  _suppressPreviewRailClick(event, prefix) {
    if (!this[prefix + 'SuppressClick']) return;
    this[prefix + 'SuppressClick'] = false;
    event.preventDefault(); event.stopImmediatePropagation();
  },

  _cancelPreviewRailDrag(prefix) {
    const drag = this[prefix + 'Drag'];
    this[prefix + 'Drag'] = null;
    if (drag?.rail.hasPointerCapture?.(drag.pointerId)) drag.rail.releasePointerCapture(drag.pointerId);
    drag?.rail.classList.remove('is-dragging');
    if (this[prefix + 'ClickTimer'] != null) clearTimeout(this[prefix + 'ClickTimer']);
    this[prefix + 'ClickTimer'] = null;
    this[prefix + 'SuppressClick'] = false;
  },

  _previewViewTimelineHtml(indices) {
    const model = this._sampleDataModel();
    return indices.map(index => {
      const preview = this.previews[index], sample = this._sampleRecord(preview, index);
      const label = model.byBatch.get(sample.batch_id)?.label || sample.batch_label || preview.name;
      const stage = this._sampleStageParts(label);
      return '<button type="button" class="preview-view-timeline-item" data-preview-index="' + index + '" data-preview-path="' + this.esc(this._previewItemKey(preview)) + '" data-preview-batch-id="' + this.esc(sample.batch_id) + '"'
        + ' aria-pressed="false" tabindex="-1" aria-label="' + this.esc(this._previewCompareLabel(preview)) + '" title="' + this.esc(this._previewCompareLabel(preview)) + '" aria-haspopup="menu" @contextmenu="openPreviewTimelineMenu($event,$event.currentTarget.dataset.previewPath)" @keydown="previewTimelineItemKeydown($event)" @click="selectPreviewTimelineByKey($event.currentTarget.dataset.previewPath)">'
        + '<span class="preview-thumb-frame">' + this._previewThumbImageHtml(preview) + '</span><span class="preview-view-time-label"><strong><span class="preview-reference-mark" aria-hidden="true" hidden></span>' + this.esc(stage.primary) + '</strong>'
        + (stage.secondary ? '<small>' + this.esc(stage.secondary) + '</small>' : '') + '</span></button>';
    }).join('');
  },

  _previewTimelineContextMenuHtml(t) {
    return '<div id="previewTimelineContextMenu" class="te-ctx preview-timeline-context-menu" role="menu" tabindex="-1" hidden :hidden="!previewTimelineMenu"'
      + ' :class="{\'is-positioned\':previewTimelineMenu?.positioned}" :style="\'left:\'+(previewTimelineMenu?.x||0)+\'px;top:\'+(previewTimelineMenu?.y||0)+\'px\'"'
      + ' aria-label="' + this.esc(t('sampleContextMenu')) + '" @contextmenu.prevent.stop @click.stop @keydown="previewTimelineMenuKeydown($event)">'
      + '<button type="button" role="menuitem" data-preview-menu-action="pin" :disabled="!previewTimelineMenu?.actions.pin" @click="previewTimelineMenuAction(\'pin\')"><span>' + this.esc(t('sampleCompareReference')) + '</span></button>'
      + '<button type="button" role="menuitem" data-preview-menu-action="unpin" :hidden="!previewTimelineMenu?.actions.unpin" @click="previewTimelineMenuAction(\'unpin\')"><span>' + this.esc(t('sampleUnpinComparison')) + '</span></button>'
      + '<button type="button" role="menuitem" data-preview-menu-action="compare" :disabled="!previewTimelineMenu?.actions.compare" @click="previewTimelineMenuAction(\'compare\')"><span>' + this.esc(t('sampleContextCompare')) + '</span></button>'
      + '<div class="te-ctx-divider" role="separator" :hidden="!previewTimelineMenu?.actions.cancel"></div>'
      + '<button type="button" role="menuitem" data-preview-menu-action="cancel" :hidden="!previewTimelineMenu?.actions.cancel" @click="previewTimelineMenuAction(\'cancel\')"><span>' + this.esc(t('sampleEndCompare')) + '</span></button></div>';
  },

  _previewTimelineMenuTarget(menu = this.previewTimelineMenu) {
    if (!menu) return -1;
    const index = this._previewViewerFileIndex(menu.key), preview = this.previews[index];
    return index >= 0 && this._previewLightboxDisplayIndices().includes(index)
      && this._sampleRecord(preview).batch_id === menu.batchId
      && this._previewViewerMetadataKey(preview) === menu.metadataKey ? index : -1;
  },

  _previewTimelineMenuActions(menu = this.previewTimelineMenu) {
    const actions = {pin: false, unpin: false, compare: false, cancel: this.previewCompareActive};
    const index = this._previewTimelineMenuTarget(menu), current = this.previews[this.previewStep];
    if (index < 0 || this._previewViewerFileIndex(this._previewItemKey(current)) !== this.previewStep) return actions;
    const key = this._previewViewerComparisonKey(current), target = this.previews[index];
    if (!key || this._previewViewerComparisonKey(target) !== key) return actions;
    const pinned = this.previewReferences.some(preview => this._previewItemKey(preview) === this._previewItemKey(target));
    const currentUnavailable = this.previewImageError && !this.previewImageAvailable && !this.previewImageLoading;
    actions.pin = !pinned && !(index === this.previewStep && currentUnavailable);
    actions.unpin = pinned;
    actions.compare = !pinned && (index !== this.previewStep || this.previewComparisonWaiting)
      && (this.previewCompareActive || !currentUnavailable);
    return actions;
  },

  previewTimelineItemKeydown(event) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    this.openPreviewTimelineMenu(event, event.currentTarget.dataset.previewPath, true);
  },

  async openPreviewTimelineMenu(event, key, keyboard = false) {
    event.preventDefault(); event.stopPropagation();
    if (!this.previewLightboxOpen || this._previewViewTimelineDrag?.dragging) return;
    const index = this._previewViewerFileIndex(key);
    if (index < 0 || !this._previewLightboxDisplayIndices().includes(index)) return;
    this.closePreviewTimelineMenu(false);
    window.AnimaUI?.settleDialog(event.currentTarget);
    const timeline = document.getElementById('previewLightboxTimeline');
    // Abort a locate/reveal smooth scroll before measuring its moving trigger.
    // A queued event from that old motion may still fire without any movement.
    if (timeline) this._scrollSampleRail(timeline, timeline.scrollLeft, false);
    const stoppedLeft = timeline?.scrollLeft, stoppedTop = timeline?.scrollTop;
    const anchor = event.currentTarget?.getBoundingClientRect?.() || {left: 4, bottom: 4};
    const pointer = !keyboard && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
      && (event.clientX !== 0 || event.clientY !== 0);
    this.previewTimelineMenu = {key, batchId: this._sampleRecord(this.previews[index]).batch_id,
      metadataKey: this._previewViewerMetadataKey(this.previews[index]), x: 0, y: 0, positioned: false,
      point: {x: pointer ? event.clientX : anchor.left, y: pointer ? event.clientY : anchor.bottom}};
    const state = this.previewTimelineMenu, request = ++this._previewTimelineMenuToken;
    state.actions = this._previewTimelineMenuActions(state);
    const current = () => this.previewLightboxOpen && this.previewTimelineMenu === state && request === this._previewTimelineMenuToken;
    await (typeof this.$nextTick === 'function' ? this.$nextTick() : Promise.resolve());
    if (!current()) return;
    const menu = document.getElementById('previewTimelineContextMenu'), dialog = document.getElementById('previewLightbox');
    if (!menu || !dialog) { this.closePreviewTimelineMenu(false); return; }
    menu.hidden = false;
    this._positionPreviewTimelineMenu(menu, dialog, state);
    state.positioned = true;
    const outside = event => { if (!menu.contains(event.target)) this.closePreviewTimelineMenu(false); };
    const scrolled = event => {
      if (menu.contains(event.target)) return;
      if (event.target === timeline && Math.abs(timeline.scrollLeft - stoppedLeft) < .5
          && Math.abs((timeline.scrollTop || 0) - (stoppedTop || 0)) < .5) return;
      this.closePreviewTimelineMenu(false);
    };
    const resized = () => this.closePreviewTimelineMenu(false);
    dialog.addEventListener('pointerdown', outside, true);
    dialog.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', resized);
    this._previewTimelineMenuCleanup = () => {
      dialog.removeEventListener('pointerdown', outside, true);
      dialog.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', resized);
    };
    window.AnimaUI?.registerPopup(menu, () => this.closePreviewTimelineMenu(false));
    await (typeof this.$nextTick === 'function' ? this.$nextTick() : Promise.resolve());
    if (current()) (this._previewTimelineMenuButtons(menu)[0] || menu).focus({preventScroll: true});
  },

  _positionPreviewTimelineMenu(menu, dialog, state) {
    const origin = dialog.getBoundingClientRect();
    const surface = dialog.querySelector('.preview-lightbox-window')?.getBoundingClientRect() || origin;
    const sx = dialog.offsetWidth && origin.width ? origin.width / dialog.offsetWidth : 1;
    const sy = dialog.offsetHeight && origin.height ? origin.height / dialog.offsetHeight : 1;
    const left = Math.max(4, origin.left + 4, surface.left + 4), top = Math.max(4, origin.top + 4, surface.top + 4);
    const right = Math.min(window.innerWidth - 4, origin.right - 4, surface.right - 4);
    const bottom = Math.min(window.innerHeight - 4, origin.bottom - 4, surface.bottom - 4);
    menu.style.maxWidth = Math.max(0, (right - left) / sx) + 'px';
    menu.style.maxHeight = Math.max(0, (bottom - top) / sy) + 'px';
    const rect = menu.getBoundingClientRect();
    state.x = (Math.max(left, Math.min(state.point.x, right - rect.width)) - origin.left) / sx;
    state.y = (Math.max(top, Math.min(state.point.y, bottom - rect.height)) - origin.top) / sy;
  },

  _previewTimelineMenuButtons(menu) {
    return Array.from(menu?.querySelectorAll('button') || []).filter(button => !button.disabled && !button.hidden
      && (!button.getClientRects || button.getClientRects().length));
  },

  closePreviewTimelineMenu(restoreFocus = false) {
    const state = this.previewTimelineMenu;
    this.previewTimelineMenu = null;
    this._previewTimelineMenuToken = (this._previewTimelineMenuToken || 0) + 1;
    this._previewTimelineMenuCleanup?.(); this._previewTimelineMenuCleanup = null;
    const menu = typeof document === 'undefined' ? null : document.getElementById?.('previewTimelineContextMenu');
    if (menu) { menu.hidden = true; window.AnimaUI?.unregisterPopup(menu); }
    if (restoreFocus && state && this.previewLightboxOpen) {
      const timeline = document.getElementById('previewLightboxTimeline');
      if (!timeline?.hidden) Array.from(timeline?.querySelectorAll('.preview-view-timeline-item') || [])
        .find(item => item.dataset.previewPath === state.key)?.focus({preventScroll: true});
    }
  },

  previewTimelineMenuKeydown(event) {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); this.closePreviewTimelineMenu(true); return;
    }
    if (event.key === 'Tab') { this.closePreviewTimelineMenu(true); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.stopPropagation(); return; }
    event.preventDefault(); event.stopPropagation();
    const buttons = this._previewTimelineMenuButtons(event.currentTarget);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus({preventScroll: true});
  },

  previewTimelineMenuAction(action) {
    const state = this.previewTimelineMenu, actions = this._previewTimelineMenuActions(state);
    if (!state || !actions[action]) return false;
    const index = this._previewTimelineMenuTarget(state), target = this.previews[index], current = this.previews[this.previewStep];
    this.closePreviewTimelineMenu(false);
    let success = true;
    if (action === 'cancel') this.stopPreviewComparison();
    else if (action === 'pin') success = this.pinPreviewReference(target);
    else if (action === 'unpin') success = this.unpinPreviewReference(this._previewItemKey(target));
    else if (action === 'compare') {
      if (!this.previewCompareActive) success = this.pinPreviewReference(current, false);
      if (success) { success = this.selectPreviewComparisonCurrent(index); this._updatePreviewLightbox(); }
    }
    if (success) this._focusPreviewPageNavigation();
    return success;
  },

  _markPreviewViewReference(timeline) {
    const keys = new Set(this.previewCompareActive ? this.previewReferences.map(preview => this._previewItemKey(preview)) : []);
    const mark = (item, pinned) => {
      if (!item) return;
      item.classList.toggle('is-reference', pinned);
      const icon = item.querySelector('.preview-reference-mark');
      if (icon) icon.hidden = !pinned;
      const preview = this.previews[Number(item.dataset.previewIndex)];
      if (preview) {
        const label = this._previewCompareLabel(preview) + (pinned ? ' ' + this.t('monitor.samplePinnedReference') : '');
        item.title = label; item.setAttribute('aria-label', label);
      }
    };
    timeline.querySelectorAll('.preview-view-timeline-item').forEach(item => mark(item, keys.has(item.dataset.previewPath)));
  },

  _previewTimelineImageSwaps: null,

  _cancelPreviewTimelineImageSwap(image, invalidate = true) {
    const swap = this._previewTimelineImageSwaps?.get(image);
    if (swap) {
      this._previewTimelineImageSwaps.delete(image);
      swap.preload.removeAttribute('src'); swap.preload.remove();
    }
    if (invalidate) delete image.dataset.previewTimelineSource;
  },

  _clearPreviewTimelineImageSwaps() {
    for (const image of this._previewTimelineImageSwaps?.keys() || []) this._cancelPreviewTimelineImageSwap(image);
    this._previewTimelineImageSwaps = null;
    const timeline = document.getElementById('previewLightboxTimeline');
    if (timeline) {
      delete timeline.dataset.signature;
      timeline.querySelectorAll('.preview-thumb-frame.is-error img').forEach(image => delete image.dataset.previewTimelineSource);
    }
  },

  _updatePreviewTimelineImage(image, preview) {
    const url = preview.thumb_url || preview.url;
    const key = JSON.stringify([this._previewItemKey(preview), preview.version || '', url, this.weakNetworkMode]);
    if (image.dataset.previewTimelineSource === key) return;
    this._cancelPreviewTimelineImageSwap(image);
    image.dataset.previewTimelineSource = key; image.alt = preview.name;
    const weak = this.weakNetworkMode;
    const failedSource = image.closest('.preview-thumb-frame')?.classList.contains('is-error');
    const setSource = (source, loaded) => {
      if (source && (failedSource || image.getAttribute('src') !== source)) image.src = source;
      if (weak) {
        image.dataset.previewUrl = url;
        if (loaded) image.dataset.previewLoaded = '1';
        else delete image.dataset.previewLoaded;
        delete image.dataset.previewQueued;
      } else {
        delete image.dataset.previewUrl; delete image.dataset.previewLoaded; delete image.dataset.previewQueued;
      }
    };
    if (!failedSource && (image.getAttribute('src') === url || (weak && image.dataset.previewUrl === url && image.dataset.previewLoaded === '1'))) return;
    if (!image.complete || !image.naturalWidth) {
      if (weak) { image.removeAttribute('src'); setSource('', false); }
      else setSource(url, false);
      return;
    }
    // A second lazy image occupies the same thumbnail slot while decoding.
    // Weak mode observes this image through its existing serial media queue.
    const preload = document.createElement('img');
    preload.alt = ''; preload.setAttribute('aria-hidden', 'true');
    preload.loading = 'lazy'; preload.decoding = 'async'; preload.fetchPriority = 'low';
    preload.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none';
    this._previewTimelineImageSwaps ||= new Map();
    this._previewTimelineImageSwaps.set(image, {preload, key, decoding: false});
    const swap = this._previewTimelineImageSwaps.get(image);
    const current = () => image.isConnected && this._previewTimelineImageSwaps?.get(image) === swap
      && image.dataset.previewTimelineSource === key;
    const failed = () => {
      if (!current()) return;
      image.closest('.preview-thumb-frame')?.classList.add('is-error');
      if (this._previewMediaByUrl?.get(url) === preload.getAttribute('src')) this._previewMediaByUrl.delete(url);
      this._cancelPreviewTimelineImageSwap(image);
    };
    preload.addEventListener('load', () => {
      if (!current() || swap.decoding) return;
      swap.decoding = true;
      Promise.resolve(preload.decode?.()).then(() => {
        if (!current()) return;
        setSource(preload.currentSrc || preload.getAttribute('src'), true);
        image.closest('.preview-thumb-frame')?.classList.remove('is-error');
        this._cancelPreviewTimelineImageSwap(image, false);
      }, failed);
    });
    preload.addEventListener('error', failed);
    image.parentElement.appendChild(preload);
    if (weak) preload.dataset.previewUrl = url;
    else preload.src = url;
  },

  _reconcilePreviewViewTimeline(timeline, indices) {
    const old = Array.from(timeline.querySelectorAll('.preview-view-timeline-item'));
    const batches = new Map(this.previews.map((preview, index) => [this._previewItemKey(preview), this._sampleRecord(preview, index).batch_id]));
    const byFile = new Map(), byBatch = new Map(), counts = new Map(), remaining = new Set(old);
    const group = (map, key, item) => map.set(key, [...(map.get(key) || []), item]);
    for (const item of old) {
      group(byFile, item.dataset.previewPath, item);
      group(byBatch, item.dataset.previewBatchId || batches.get(item.dataset.previewPath), item);
    }
    for (const index of indices) {
      const id = this._sampleRecord(this.previews[index], index).batch_id;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    let next = timeline.firstElementChild;
    for (const index of indices) {
      const preview = this.previews[index], sample = this._sampleRecord(preview, index), key = this._previewItemKey(preview);
      const exact = byFile.get(key), sameBatch = byBatch.get(sample.batch_id);
      let item = exact?.length === 1 && remaining.has(exact[0]) ? exact[0]
        : counts.get(sample.batch_id) === 1 && sameBatch?.length === 1 && remaining.has(sameBatch[0]) ? sameBatch[0] : null;
      if (!item) {
        const template = document.createElement('template');
        template.innerHTML = this._previewViewTimelineHtml([index]);
        item = template.content.firstElementChild;
      }
      remaining.delete(item);
      if (item === next) next = next.nextElementSibling;
      else timeline.insertBefore(item, next);
      item.dataset.previewIndex = String(index); item.dataset.previewPath = key; item.dataset.previewBatchId = sample.batch_id;
      const label = this._previewCompareLabel(preview);
      item.title = label; item.setAttribute('aria-label', label);
      const stage = this._sampleStageParts(this._sampleDataModel().byBatch.get(sample.batch_id)?.label || sample.batch_label || preview.name);
      const stageKey = JSON.stringify(stage);
      if (item.dataset.previewTimelineStage !== stageKey) {
        item.querySelector('.preview-view-time-label').innerHTML = '<strong><span class="preview-reference-mark" aria-hidden="true" hidden></span>'
          + this.esc(stage.primary) + '</strong>' + (stage.secondary ? '<small>' + this.esc(stage.secondary) + '</small>' : '');
        item.dataset.previewTimelineStage = stageKey;
      }
      this._updatePreviewTimelineImage(item.querySelector('img'), preview);
    }
    for (const item of remaining) {
      this._cancelPreviewTimelineImageSwap(item.querySelector('img'));
      item.remove();
    }
  },

  _updatePreviewViewTimeline(indices) {
    const timeline = document.getElementById('previewLightboxTimeline');
    if (!timeline) return;
    const frame = document.getElementById('previewLightboxTimelineFrame');
    const locate = document.getElementById('previewLightboxBar')?.querySelector('.sample-timeline-locate');
    const wasVisible = !timeline.hidden;
    const hadTimelineFocus = (frame || timeline).contains(document.activeElement) || (!!locate && locate === document.activeElement);
    timeline.hidden = indices.length < 2;
    this.previewViewTimelineAvailable = !timeline.hidden;
    if (frame) frame.hidden = timeline.hidden;
    if (locate) locate.disabled = timeline.hidden || !this.previewViewTimelineVisible || this.previewComparisonWaiting;
    if (timeline.hidden) {
      if (hadTimelineFocus) document.getElementById('previewLightbox')?.querySelector('.preview-close')?.focus({ preventScroll: true });
      if (wasVisible && this.weakNetworkMode) {
        this._cancelPreviewMediaQueue();
        const root = document.getElementById('monitorDashboard');
        if (root) this.schedulePreviewMediaLoads(root);
      }
      return;
    }
    const model = this._sampleDataModel();
    const signature = JSON.stringify([this.weakNetworkMode, indices.map(index => {
      const item = this.previews[index], sample = this._sampleRecord(item, index);
      return [index, this._previewItemKey(item), item.version || '', item.thumb_url || item.url, sample.batch_id,
        model.byBatch.get(sample.batch_id)?.label || sample.batch_label, this._previewCompareLabel(item)];
    })]);
    const previous = timeline.querySelector('[aria-pressed="true"]')?.dataset.previewPath;
    if (timeline.dataset.signature !== signature) {
      const root = document.getElementById('monitorDashboard') || timeline;
      const loaded = this.weakNetworkMode ? this._capturePreviewMedia(root) : null;
      const scrollLeft = timeline.scrollLeft;
      const hadFocus = timeline.contains(document.activeElement);
      const focusedPath = hadFocus ? document.activeElement.dataset.previewPath : '';
      if (this.weakNetworkMode) this._cancelPreviewMediaQueue();
      this._reconcilePreviewViewTimeline(timeline, indices);
      timeline.dataset.signature = signature;
      timeline.scrollLeft = scrollLeft;
      if (loaded) this._restorePreviewMedia(root, loaded);
      if (hadFocus) {
        const focus = Array.from(timeline.querySelectorAll('.preview-view-timeline-item')).find(item => item.dataset.previewPath === focusedPath)
          || timeline.querySelector('[data-preview-index="' + this.previewStep + '"]');
        focus?.focus({ preventScroll: true });
      }
      if (this.weakNetworkMode) this.schedulePreviewMediaLoads(root);
    }
    const selected = this.previewComparisonWaiting ? null : timeline.querySelector('[data-preview-index="' + this.previewStep + '"]');
    const old = timeline.querySelector('[aria-pressed="true"]');
    if (old && old !== selected) { old.setAttribute('aria-pressed', 'false'); old.tabIndex = -1; }
    this._markPreviewViewReference(timeline);
    if (!selected) return;
    selected.setAttribute('aria-pressed', 'true'); selected.tabIndex = 0;
    if (previous !== selected.dataset.previewPath) this._revealPreviewViewTimeline();
  },

  _scrollSampleRail(rail, left, smooth = true) {
    if (!Number.isFinite(left)) return;
    const max = Number.isFinite(rail.scrollWidth) && Number.isFinite(rail.clientWidth) ? Math.max(0, rail.scrollWidth - rail.clientWidth) : Infinity;
    const target = Math.max(0, Math.min(max, left));
    const motion = smooth && Math.abs(target - rail.scrollLeft) > 1 && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (typeof rail.scrollTo === 'function') rail.scrollTo({ left: target, behavior: motion ? 'smooth' : 'instant' });
    else rail.scrollLeft = target;
  },

  _revealPreviewViewTimeline(smooth = true) {
    if (!this.previewViewTimelineVisible) return;
    this._revealSampleRail(document.getElementById('previewLightboxTimeline'), smooth);
  },

  togglePreviewViewTimeline(event) {
    this.previewViewTimelineVisible = event?.currentTarget?.checked ?? !this.previewViewTimelineVisible;
    this._saveSampleViewPreferences();
    const locate = document.getElementById('previewLightboxBar')?.querySelector('.sample-timeline-locate');
    if (locate) locate.disabled = !this.previewViewTimelineAvailable || !this.previewViewTimelineVisible || this.previewComparisonWaiting;
    const frame = document.getElementById('previewLightboxTimelineFrame');
    if (!this.previewViewTimelineVisible && frame?.contains(document.activeElement)) event?.currentTarget?.focus({preventScroll: true});
  },

  _layoutPreviewComparisonPanes(count) {
    this._cancelPreviewReset();
    this.stopPreviewPan();
    const group = document.getElementById('previewReferencePanes')?.parentElement;
    const panes = document.getElementById('previewLightboxViewport') || group;
    if (!group || !panes) return;
    const vertical = this.previewComparisonLayout === 'vertical';
    panes.classList.toggle('is-vertical', vertical);
    panes.classList.toggle('comparing', count > 1);
    const items = Array.from(group.querySelectorAll('.preview-lightbox-pane'));
    if (!items.length) return;
    const cssHeight = parseFloat(window.getComputedStyle?.(panes)?.height);
    const width = panes.clientWidth, height = cssHeight > 0 ? cssHeight : panes.offsetHeight || panes.clientHeight;
    if (!width || !height) return;
    const images = items.map(item => item.querySelector('img'));
    const ratio = image => image?.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 0;
    const fallbackRatio = images.map(ratio).find(Boolean) || 1;
    const ratios = images.map(image => ratio(image) || fallbackRatio);
    const gap = 12, captionWidth = count > 1 && vertical ? 160 : 0, captionHeight = count > 1 && !vertical ? 32 : 0;
    let sizes;
    if (count < 2) {
      const imageHeight = Math.min(height, width / ratios[0]);
      sizes = [{width: imageHeight * ratios[0], height: imageHeight}];
    } else if (vertical) {
      const available = Math.max(0, width - captionWidth);
      const fit = count === 2
        ? (height - gap) / ratios.reduce((sum, value) => sum + 1 / value, 0)
        : height * Math.min(...ratios);
      const imageWidth = Math.max(0, Math.min(available, fit));
      sizes = items.map((item, index) => ({width: imageWidth, height: imageWidth / ratios[index]}));
    } else {
      const available = Math.max(0, height - captionHeight);
      const fit = (width - gap * (count - 1)) / ratios.reduce((sum, value) => sum + value, 0);
      const imageHeight = Math.max(Math.min(160, available), Math.min(available, fit));
      sizes = items.map((item, index) => ({width: imageHeight * ratios[index], height: imageHeight}));
    }
    items.forEach((item, index) => {
      item.style.setProperty('--preview-pane-width', sizes[index].width + 'px');
      item.style.setProperty('--preview-pane-height', sizes[index].height + 'px');
    });
    const baseWidth = vertical && count > 1 ? Math.max(...sizes.map(size => size.width))
      : sizes.reduce((sum, size) => sum + size.width, gap * (sizes.length - 1));
    const baseHeight = vertical && count > 1 ? sizes.reduce((sum, size) => sum + size.height, gap * (sizes.length - 1))
      : Math.max(...sizes.map(size => size.height));
    const previous = this._previewGroupGeometry;
    if (vertical && count > 2 && (previous?.count !== count || !previous?.vertical)) {
      this._previewViewFitted = false; this.previewViewScale = 1;
    }
    this._previewGroupGeometry = {width: baseWidth, height: baseHeight, count, vertical, captionWidth, captionHeight};
    this._previewViewFitScale = Math.max(0.0001, Math.min(1, (width - captionWidth) / baseWidth, (height - captionHeight) / baseHeight));
    if (this._previewViewFitted || this.previewViewScale < this._previewViewFitScale) this.previewViewScale = this._previewViewFitScale;
    this._syncPreviewGroupViewport();
    if (this._previewReferenceMedia) this._refreshPreviewReferenceVisibility(this._previewReferenceMedia);
  },

  _syncPreviewGroupViewport() {
    const geometry = this._previewGroupGeometry;
    const viewport = document.getElementById('previewLightboxViewport');
    const extent = document.getElementById('previewLightboxExtent');
    const group = document.getElementById('previewLightboxGroup');
    if (!geometry || !viewport || !extent || !group) return;
    const previous = this._previewViewportLayout;
    const offsetX = previous ? viewport.scrollLeft - previous.centerX : 0;
    const offsetY = previous ? viewport.scrollTop - previous.centerY : 0;
    const scale = this.previewViewScale;
    const drawn = this._previewGroupDrawSize(scale);
    const cssHeight = parseFloat(window.getComputedStyle?.(viewport)?.height);
    const availableHeight = cssHeight > 0 ? Math.min(viewport.clientHeight, cssHeight) : viewport.clientHeight;
    // Leave room past every edge, retaining 64 CSS pixels of the images,
    // rather than just their captions (or half of a small image/viewport).
    const captionWidth = geometry.captionWidth || 0, captionHeight = geometry.captionHeight || 0;
    const horizontalSpace = viewport.clientWidth - Math.min(64, (drawn.width - captionWidth) / 2, viewport.clientWidth / 2);
    const verticalSpace = availableHeight - Math.min(64, (drawn.height - captionHeight) / 2, availableHeight / 2);
    const left = Math.max(0, horizontalSpace - captionWidth), top = verticalSpace;
    const extentWidth = drawn.width + left + horizontalSpace;
    const extentHeight = drawn.height + top + Math.max(0, verticalSpace - captionHeight);
    extent.style.width = extentWidth + 'px';
    extent.style.height = extentHeight + 'px';
    group.style.setProperty('--preview-caption-x-space', ((geometry.captionWidth || 0) / scale) + 'px');
    group.style.setProperty('--preview-caption-y-space', ((geometry.captionHeight || 0) / scale) + 'px');
    group.style.setProperty('--preview-caption-counter-scale', String(1 / scale));
    group.style.setProperty('--preview-caption-zoom', String(scale));
    const width = drawn.width / scale, height = drawn.height / scale;
    Object.assign(group.style, {width: width + 'px', height: height + 'px',
      left: left + (drawn.width - width) / 2 + 'px', top: top + (drawn.height - height) / 2 + 'px', transform: 'scale(' + scale + ')'});
    const centerX = left + (drawn.width - viewport.clientWidth) / 2, centerY = top + (drawn.height - availableHeight) / 2;
    this._previewViewportLayout = {left, top, centerX, centerY};
    viewport.scrollLeft = previous ? centerX + offsetX : Math.min(centerX, left);
    viewport.scrollTop = previous ? centerY + offsetY : Math.min(centerY, top);
  },

  _previewGroupDrawSize(scale) {
    const geometry = this._previewGroupGeometry;
    return {width: geometry.width * scale + (geometry.captionWidth || 0),
      height: geometry.height * scale + (geometry.captionHeight || 0)};
  },

  resizePreviewComparisonImages() {
    const references = document.getElementById('previewReferencePanes');
    this._layoutPreviewComparisonPanes((references?.children.length || 0) + 1);
  },

  _previewViewportResize: null,

  _connectPreviewViewportResize() {
    const element = document.getElementById('previewLightboxViewport');
    if (!element || this._previewViewportResize?.element === element) return;
    this._disconnectPreviewViewportResize();
    if (typeof ResizeObserver === 'undefined') return;
    let state = {element, observer: null, frame: null, width: element.clientWidth, height: element.offsetHeight};
    this._previewViewportResize = state;
    state = this._previewViewportResize;
    state.observer = new ResizeObserver(() => {
      if (this._previewViewportResize !== state || !this.previewLightboxOpen || !element.isConnected) return;
      const width = element.clientWidth, height = element.offsetHeight;
      if (width === state.width && height === state.height) return;
      state.width = width; state.height = height;
      if (state.frame !== null) return;
      state.frame = requestAnimationFrame(() => {
        state.frame = null;
        if (this._previewViewportResize !== state || !this.previewLightboxOpen || !element.isConnected) return;
        this.resizePreviewComparisonImages();
        this.syncPreviewPromptBar();
      });
    });
    state.observer.observe(element, {box: 'border-box'});
  },

  _disconnectPreviewViewportResize() {
    const state = this._previewViewportResize;
    this._previewViewportResize = null;
    state?.observer?.disconnect();
    if (state?.frame != null) cancelAnimationFrame(state.frame);
  },

  setPreviewComparisonLayout(layout) {
    if (!['horizontal', 'vertical'].includes(layout) || layout === this.previewComparisonLayout) return;
    this.previewComparisonLayout = layout;
    this.previewViewScale = 1; this._previewViewFitted = false;
    this._saveSampleViewPreferences();
    const references = document.getElementById('previewReferencePanes');
    this._layoutPreviewComparisonPanes((references?.children.length || 0) + 1);
    const viewport = document.getElementById('previewLightboxViewport') || references?.parentElement;
    const position = this._previewViewportLayout;
    if (viewport) {
      viewport.scrollLeft = position ? Math.min(position.centerX, position.left) : 0;
      viewport.scrollTop = position ? Math.min(position.centerY, position.top) : 0;
    }
    this.constrainPreviewView();
    this.syncPreviewPromptBar();
  },

  _revealPreviewPromptStrip(smooth = true) {
    this._revealSampleRail(document.getElementById('previewLightboxStrip'), smooth);
  },

  _revealSampleRail(rail, smooth = true) {
    const selected = rail?.querySelector('[aria-pressed="true"]');
    if (!selected || rail.hidden) return;
    const bounds = rail.getBoundingClientRect(), rect = selected.getBoundingClientRect();
    if (!bounds.width) return;
    // Dialog entrance motion can scale measured rectangles. scrollLeft is in
    // unscaled CSS pixels, so normalize the distance before scrolling.
    const scale = rail.offsetWidth ? bounds.width / rail.offsetWidth : 1;
    let left = rail.scrollLeft;
    if (rect.left < bounds.left) left += (rect.left - bounds.left) / scale - 4;
    else if (rect.right > bounds.right) left += (rect.right - bounds.right) / scale + 4;
    this._scrollSampleRail(rail, left, smooth);
  },

  centerPreviewViewTimeline() {
    const rail = document.getElementById('previewLightboxTimeline');
    const selected = rail?.querySelector?.('[aria-pressed="true"]');
    if (!selected || rail.hidden) return;
    const bounds = rail.getBoundingClientRect(), rect = selected.getBoundingClientRect();
    // Both rectangles share the dialog's entrance scale; scrollLeft is in CSS
    // pixels. Keep the operation inside this rail, away from the main grid.
    const scale = rail.offsetWidth ? bounds.width / rail.offsetWidth : 1;
    if (!bounds.width || !Number.isFinite(scale) || scale <= 0) return;
    const delta = ((rect.left + rect.right) - (bounds.left + bounds.right)) / (2 * scale);
    this._scrollSampleRail(rail, rail.scrollLeft + delta);
  },

  resizePreviewLightbox() {
    const panes = document.getElementById('previewReferencePanes');
    this._layoutPreviewComparisonPanes((panes?.children.length || 0) + 1);
    this.constrainPreviewView();
    if (this.previewLightboxOpen) {
      this._revealPreviewViewTimeline(false);
      this._revealPreviewPromptStrip(false);
      this.syncPreviewPromptBar();
    }
  },

  jumpToLatestPreview() {
    this.closePreviewTimelineMenu(false);
    const indices = this._previewLightboxNavigationIndices(this._previewLightboxIndices());
    if (!indices.length) return;
    // Keep the current prompt/seed when the latest batch is still incomplete.
    this.selectPreviewComparisonCurrent(indices[indices.length - 1]);
    if (this.sampleBatchId === this._sampleDataModel().batches.at(-1)?.id) {
      this._acknowledgeNewPreviews();
    }
    this._updatePreviewLightbox();
  },

  _previewHasNewInViewerSequence() {
    if (!this.previewHasNew) return false;
    const indices = this._previewLightboxNavigationIndices(this._previewLightboxIndices()), position = indices.indexOf(this.previewStep);
    return position >= 0 && position < indices.length - 1;
  },

  previewLightboxKeydown(event) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.previewInfoOpen) {event.stopPropagation?.(); return;}
    if (event.target?.closest?.('input,select,textarea,summary,[contenteditable="true"],[role="combobox"],[role="listbox"],[role="menu"]')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation?.(); this.previewLightboxNav(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault(); this.setPreviewViewScale(this.previewViewScale * 1.18);
    } else if (event.key === '-') {
      event.preventDefault(); this.setPreviewViewScale(this.previewViewScale / 1.18);
    } else if (event.key === '0') {
      event.preventDefault(); this.resetPreviewView(true);
    }
  },

  previewViewAtFit() {
    const fit = this._previewViewFitScale || 1;
    return Math.abs(this.previewViewScale - fit) <= fit * 0.001;
  },

  previewViewZoomLabel() {
    return this.previewViewAtFit() ? this.t('imageViewer.fit')
      : (this.previewViewScale / (this._previewViewFitScale || 1)).toFixed(2) + '×';
  },

  _cancelPreviewReset() {
    this._previewResetCancel?.(); this._previewResetCancel = null;
  },

  resetPreviewView(smooth = false) {
    this._cancelPreviewReset();
    this.stopPreviewPan();
    const viewport = document.getElementById('previewLightboxViewport');
    if (smooth && this.previewLightboxOpen && this._previewGroupGeometry && this._previewViewportLayout && viewport) {
      const position = this._previewViewportLayout;
      const from = {scale: this.previewViewScale, x: viewport.scrollLeft - position.centerX, y: viewport.scrollTop - position.centerY};
      this._previewViewFitted = false;
      this._previewResetCancel = window.AnimaImageViewport.animate(from, {scale: this._previewViewFitScale || 1, x: 0, y: 0}, view => {
        this.previewViewScale = view.scale;
        this._syncPreviewGroupViewport();
        viewport.scrollLeft = this._previewViewportLayout.centerX + view.x;
        viewport.scrollTop = this._previewViewportLayout.centerY + view.y;
      }, () => { this._previewViewFitted = true; this._previewResetCancel = null; });
      return;
    }
    this._previewViewFitted = true;
    if (this.previewLightboxOpen) this.resizePreviewComparisonImages();
    this.previewViewScale = this._previewViewFitScale || 1;
    this._previewViewFitted = true;
    this._syncPreviewGroupViewport();
    const position = this._previewViewportLayout;
    if (viewport) {
      viewport.scrollLeft = position?.centerX || 0;
      viewport.scrollTop = position?.centerY || 0;
    }
  },

  constrainPreviewView(fallback) {
    if (!this.previewLightboxOpen && !fallback) return;
    this._syncPreviewGroupViewport();
  },

  setPreviewViewScale(next, event) {
    this._cancelPreviewReset();
    this.stopPreviewPan();
    const viewport = document.getElementById('previewLightboxViewport'), geometry = this._previewGroupGeometry;
    const fit = this._previewViewFitScale || 1;
    let scale = Math.max(fit, Math.min(8, Number(next) || fit));
    if (Math.abs(scale - fit) <= fit * 0.001) scale = fit;
    if (scale === this.previewViewScale) return;
    let anchor;
    if (viewport && geometry) {
      window.AnimaUI?.settleDialog?.(viewport);
      const rect = viewport.getBoundingClientRect();
      const entranceScale = viewport.offsetWidth && rect.width ? rect.width / viewport.offsetWidth : 1;
      const x = event ? (event.clientX - rect.left) / entranceScale : viewport.clientWidth / 2;
      const y = event ? (event.clientY - rect.top) / entranceScale : viewport.clientHeight / 2;
      const old = this.previewViewScale;
      const position = this._previewViewportLayout;
      anchor = {x, y,
        imageX: (viewport.scrollLeft + x - position.left - (geometry.captionWidth || 0)) / old,
        imageY: (viewport.scrollTop + y - position.top) / old};
    }
    this.previewViewScale = scale; this._previewViewFitted = scale === fit;
    this._syncPreviewGroupViewport();
    if (anchor) {
      const position = this._previewViewportLayout;
      viewport.scrollLeft = position.left + (geometry.captionWidth || 0) + anchor.imageX * scale - anchor.x;
      viewport.scrollTop = position.top + anchor.imageY * scale - anchor.y;
    }
    if (this._previewReferenceMedia) this._refreshPreviewReferenceVisibility(this._previewReferenceMedia);
  },

  zoomPreviewView(event) {
    if (event.target?.closest?.('button,.preview-pane-caption')) return;
    if (!event.deltaY || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY)) return;
    if (this.previewCompareActive && this.previewComparisonLayout === 'vertical' && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault(); event.stopPropagation();
    this.setPreviewViewScale(this.previewViewScale * (event.deltaY < 0 ? 1.18 : 1 / 1.18), event);
  },

  startPreviewPan(event) {
    this._cancelPreviewReset();
    this.stopPreviewPan();
    const viewport = event.currentTarget;
    if (event.button !== 0 || event.target.closest?.('button')
        || (viewport.scrollWidth <= viewport.clientWidth + 1 && viewport.scrollHeight <= viewport.clientHeight + 1)) return;
    window.AnimaUI?.settleDialog?.(viewport);
    const rect = viewport.getBoundingClientRect();
    this._previewPanRatio = viewport.offsetWidth && rect.width ? rect.width / viewport.offsetWidth : 1;
    this.previewViewPanning = true; this.previewViewPointerId = event.pointerId;
    this._previewPanStartX = event.clientX / this._previewPanRatio + viewport.scrollLeft;
    this._previewPanStartY = event.clientY / this._previewPanRatio + viewport.scrollTop;
    this._previewPanWrite = window.AnimaImageViewport.frameWriter(point => {
      viewport.scrollLeft = point.x;
      viewport.scrollTop = point.y;
    });
    viewport.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  },

  movePreviewPan(event) {
    if (!this.previewViewPanning || event.pointerId !== this.previewViewPointerId) return;
    this._previewPanWrite.schedule({x: this._previewPanStartX - event.clientX / this._previewPanRatio,
      y: this._previewPanStartY - event.clientY / this._previewPanRatio});
    event.preventDefault();
  },

  stopPreviewPan(event) {
    const pointer = this.previewViewPointerId, viewport = event?.currentTarget || document.getElementById('previewLightboxViewport');
    if (event && pointer !== event.pointerId) return;
    this._previewPanWrite?.flush(); this._previewPanWrite = null;
    this.previewViewPanning = false; this.previewViewPointerId = null;
    if (pointer != null && viewport?.hasPointerCapture?.(pointer)) viewport.releasePointerCapture(pointer);
  },

  retryPreviewImage() {
    this._previewImageKey = '';
    this._updatePreviewLightbox();
  },

  _previewReferenceMedia: null,

  _createPreviewReferencePane(key) {
    const pane = document.createElement('div');
    pane.className = 'preview-lightbox-pane preview-reference-pane';
    pane.dataset.previewReferenceKey = key;
    const escapedKey = this.esc(key);
    pane.innerHTML = '<div class="preview-view-stage">'
      + '<img class="preview-view-image" alt="" draggable="false" @load="resizePreviewComparisonImages()">'
      + '<span class="preview-reference-locate-flash" aria-hidden="true"></span>'
      + '<button type="button" class="btn btn-sm btn-secondary preview-view-error" data-preview-reference-key="' + escapedKey
      + '" @click.stop="retryPreviewReferenceImage($event.currentTarget.dataset.previewReferenceKey)" hidden>'
      + this.esc(this.t('monitor.previewImageRetry')) + '</button></div>'
      + '<div class="preview-caption-slot"><div class="preview-pane-caption preview-reference-caption">' + this._previewCaptionTextHtml()
      + '<button type="button" class="btn-icon preview-reference-remove" data-preview-reference-key="' + escapedKey
      + '" @click.stop="unpinPreviewReference($event.currentTarget.dataset.previewReferenceKey)" aria-label="'
      + this.esc(this.t('monitor.sampleUnpinComparison')) + '" title="' + this.esc(this.t('monitor.sampleUnpinComparison')) + '">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div></div>';
    return {pane, image: pane.querySelector('img'), caption: pane.querySelector('.preview-reference-caption strong'),
      captionStep: pane.querySelector('.preview-caption-step'), retry: pane.querySelector('.preview-view-error')};
  },

  _updatePreviewReferencePanes(references) {
    const container = document.getElementById('previewReferencePanes');
    if (!container || !this.previewLightboxOpen || !references?.length) {
      this._clearPreviewReferenceImages();
      this._layoutPreviewComparisonPanes(1);
      return;
    }
    let media = this._previewReferenceMedia;
    if (!media || media.container !== container) {
      this._clearPreviewReferenceImages();
      const root = container.closest('.preview-lightbox-panes') || container.parentElement;
      media = {container, root, entries: new Map(), observer: null, cleanup: null};
      this._previewReferenceMedia = media;
      media = this._previewReferenceMedia;
      if (typeof IntersectionObserver === 'function') {
        media.observer = new IntersectionObserver(entries => {
          if (this._previewReferenceMedia !== media) return;
          for (const item of entries) {
            const entry = media.entries.get(item.target.dataset.previewReferenceKey);
            if (entry?.pane === item.target) this._setPreviewReferenceVisibility(media, entry,
              item.isIntersecting && this._previewReferenceIsVisible(media, entry));
          }
        }, {root, threshold: 0.01});
      } else {
        const refresh = () => this._refreshPreviewReferenceVisibility(media);
        root?.addEventListener?.('scroll', refresh, {passive: true});
        window.addEventListener?.('resize', refresh, {passive: true});
        media.cleanup = () => { root?.removeEventListener?.('scroll', refresh); window.removeEventListener?.('resize', refresh); };
      }
    }
    const wanted = new Map(references.filter(Boolean).map(preview => [this._previewItemKey(preview), preview]));
    for (const [key, entry] of media.entries) {
      if (wanted.has(key)) continue;
      media.entries.delete(key); entry.request++;
      window.AnimaImages.cancel(entry.image); entry.image.removeAttribute('src');
      media.observer?.unobserve(entry.pane); entry.pane.remove();
    }
    container.hidden = false;
    let next = container.firstElementChild;
    for (const [key, preview] of wanted) {
      let entry = media.entries.get(key);
      if (!entry) {
        entry = {...this._createPreviewReferencePane(key), itemKey: key, preview, imageKey: '', versionKey: '', source: '', request: 0,
          status: 'idle', visible: false};
        media.entries.set(key, entry);
        entry = media.entries.get(key);
      }
      if (entry.pane === next) next = next.nextElementSibling;
      else container.insertBefore(entry.pane, next);
      entry.preview = preview;
      const caption = this._previewCaptionParts(preview);
      if (entry.caption.textContent !== caption.primary) entry.caption.textContent = caption.primary;
      entry.caption.title = [caption.primary, caption.secondary].filter(Boolean).join(' · ');
      entry.caption.closest?.('.preview-pane-caption')?.setAttribute('title', entry.caption.title);
      if (entry.captionStep.textContent !== caption.secondary) entry.captionStep.textContent = caption.secondary;
      entry.captionStep.hidden = !caption.secondary;
      entry.image.alt = this.t('monitor.reference') + ': ' + preview.name;
      const versionKey = this._previewImageCacheKey(preview);
      if (entry.versionKey !== versionKey) {
        entry.request++; window.AnimaImages.cancel(entry.image);
        entry.versionKey = versionKey; entry.imageKey = ''; entry.source = ''; entry.status = 'idle'; entry.retry.hidden = true;
        if (!entry.visible || !this._previewViewerImageSource(entry.image)) this._showPreviewReferenceThumb(entry);
      }
      media.observer?.observe(entry.pane);
    }
    this._layoutPreviewComparisonPanes(wanted.size + 1);
  },

  _showPreviewReferenceThumb(entry) {
    const thumb = entry.preview.thumb_url;
    if (thumb) {
      if (entry.image.getAttribute('src') !== thumb) {
        window.AnimaImages.cancel(entry.image);
        entry.image.src = thumb;
      }
    } else {
      if (entry.image.getAttribute('src')) window.AnimaImages.cancel(entry.image);
      entry.image.removeAttribute('src');
    }
  },

  _previewReferenceIsVisible(media, entry, bounds = media.root?.getBoundingClientRect()) {
    if (!bounds) return false;
    const width = window.innerWidth || Infinity, height = window.innerHeight || Infinity;
    const rect = entry.pane.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0
      && Math.min(rect.right, bounds.right, width) > Math.max(rect.left, bounds.left, 0)
      && Math.min(rect.bottom, bounds.bottom, height) > Math.max(rect.top, bounds.top, 0);
  },

  _refreshPreviewReferenceVisibility(media) {
    if (this._previewReferenceMedia !== media) return;
    const bounds = media.root?.getBoundingClientRect();
    for (const entry of media.entries.values()) {
      this._setPreviewReferenceVisibility(media, entry, this._previewReferenceIsVisible(media, entry, bounds));
    }
  },

  _setPreviewReferenceVisibility(media, entry, visible) {
    if (this._previewReferenceMedia !== media || media.entries.get(entry.itemKey) !== entry) return;
    entry.visible = visible;
    if (!visible) {
      if (entry.status !== 'idle') {entry.request++; entry.status = 'idle';}
      this._showPreviewReferenceThumb(entry);
    } else {
      const source = this._previewReferenceSource(entry);
      const key = this._previewImageCacheKey(entry.preview, source);
      if (key !== entry.imageKey) {
        entry.request++; entry.imageKey = key; entry.source = source;
        entry.status = 'idle'; entry.retry.hidden = true;
      }
      if (entry.status === 'idle') {
        this._queuePreviewReferenceImage(media, entry);
      }
    }
  },

  _previewReferenceSource(entry) {
    const thumb = entry.preview.thumb_url;
    const original = this._previewFullImageUrl(entry.preview);
    const bounds = entry.image.getBoundingClientRect?.() || entry.pane.getBoundingClientRect();
    const required = Math.max(bounds.width, bounds.height) * (window.devicePixelRatio || 1);
    // Thumbnail rounding can slightly alter the measured aspect ratio. Leave
    // room around tier boundaries so its load cannot trigger an upgrade loop.
    const tier = !entry.source ? 0 : entry.source === thumb ? 320 : entry.source === original ? Infinity : 960;
    const thumbLimit = tier > 320 ? 288 : tier === 320 ? 352 : 320;
    if (thumb && required <= thumbLimit) return thumb;
    const previewLimit = tier > 960 ? 864 : tier === 960 ? 1056 : 960;
    if (thumb?.startsWith('/api/image-preview?') && required <= previewLimit) {
      const url = new URL(thumb, window.location.href);
      url.searchParams.set('variant', 'preview'); url.searchParams.delete('size');
      return url.pathname + url.search;
    }
    return original;
  },

  _queuePreviewReferenceImage(media, entry) {
    const request = ++entry.request, key = entry.imageKey, source = entry.source;
    entry.status = 'queued'; entry.retry.hidden = true;
    const current = () => this._previewReferenceMedia === media && media.entries.get(entry.itemKey) === entry
      && entry.request === request && entry.imageKey === key && entry.image.isConnected && entry.visible;
    const finish = (image, success) => {
      if (!current()) return;
      if (image) {
        if (this._previewViewerImageSource(entry.image) !== image.src) entry.image.src = image.src;
        entry.image.dispatchEvent?.(new CustomEvent('image-ready', {detail: {width: image.naturalWidth, height: image.naturalHeight}}));
      } else entry.image.removeAttribute('src');
      entry.status = success ? 'ready' : 'error'; entry.retry.hidden = success;
      if (success) this.constrainPreviewView();
    };
    this._queuePreviewImage('reference:' + entry.itemKey, {key, source, current,
      start: () => {entry.status = 'loading';}, ready: image => finish(image, true),
      failed: () => {
        if (!current()) return;
        const thumb = entry.preview.thumb_url;
        if (!thumb || source === thumb) {finish(null, false); return;}
        return window.AnimaImages.decode(thumb).then(image => finish(image, false), () => finish(null, false));
      }});
  },

  retryPreviewReferenceImage(key) {
    const media = this._previewReferenceMedia, entry = media?.entries.get(key);
    if (!entry || entry.status !== 'error') return;
    entry.status = 'idle'; entry.retry.hidden = true;
    this._setPreviewReferenceVisibility(media, entry, entry.visible);
  },

  _clearPreviewReferenceImages(removeSources = true) {
    this._previewReferenceLocateAnimation?.cancel();
    this._previewReferenceLocateAnimation = null;
    const media = this._previewReferenceMedia;
    this._previewReferenceMedia = null;
    media?.observer?.disconnect(); media?.cleanup?.();
    if (media) {
      for (const entry of media.entries.values()) {
        entry.request++; window.AnimaImages?.cancel(entry.image);
        if (removeSources) entry.image.removeAttribute('src');
      }
    }
    if (removeSources) {
      const container = media?.container || document.getElementById('previewReferencePanes');
      if (container) { container.replaceChildren(); container.hidden = true; }
    }
  },

  _clearPreviewImageLoading(removeSources = false) {
    this._disconnectPreviewViewportResize();
    this._clearPreviewTimelineImageSwaps();
    this._clearPreviewReferenceImages(removeSources);
    this._previewImageQueue = null;
    this._previewImageElement = null;
    ++this._previewImageRequest;
    this._previewImageKey = '';
    this.previewImageLoading = this.previewImageError = false;
    this.previewImageAvailable = false;
    this._previewOriginalCache?.clear();
    this._previewOriginalCache = null;
    const image = document.getElementById('previewLightboxImg');
    if (image) {
      window.AnimaImages?.cancel(image);
      if (removeSources) image.removeAttribute('src');
    }
  },

  _previewImageCacheKey(preview, source = this._previewFullImageUrl(preview)) {
    return JSON.stringify([this._previewItemKey(preview), preview.version ?? '', source || '']);
  },

  _prefetchPreviewNeighbors() {
    const cache = this._previewOriginalCache;
    if (!cache) return;
    if (!this.previewLightboxOpen || this.weakNetworkMode || this.trainingActive) { cache.cancelPrefetch(); return; }
    const current = this.previews[this.previewStep];
    if (!current) { cache.cancelPrefetch(); return; }
    const indices = this._previewLightboxNavigationIndices(this._previewLightboxIndices()), position = indices.indexOf(this.previewStep);
    const comparisonKey = this._previewComparisonKey(current);
    const sample = this._sampleRecord(current), caseKey = this._sampleCaseKey(current);
    const candidates = position < 0 ? [] : [indices[position - 1], indices[position + 1]]
      .filter(Number.isInteger).map(index => this.previews[index]).filter(candidate => {
        if (!candidate) return false;
        if (comparisonKey) return this._previewComparisonKey(candidate) === comparisonKey;
        return sample.metadata_source !== 'unknown' && this._sampleCaseKey(candidate) === caseKey;
      }).map(candidate => ({key: this._previewImageCacheKey(candidate), source: this._previewFullImageUrl(candidate)}));
    cache.prefetch(candidates);
  },

  _previewImageQueue: null,

  _previewViewerImageSource(element) {
    return element.getAttribute?.('src') ?? element.src ?? '';
  },

  _previewViewerImageJobCurrent(job) {
    return this.previewLightboxOpen && !this.previewComparisonWaiting
      && this._previewImageRequest === job.request && this._previewImageKey === job.key
      && this._previewImageElement === job.element && job.element.isConnected;
  },

  _commitPreviewViewerImage(job, image, original) {
    if (!this._previewViewerImageJobCurrent(job)) return;
    if (this._previewViewerImageSource(job.element) !== image.src) job.element.src = image.src;
    if (job.element.dataset) job.element.dataset.previewDisplayedKey = job.key;
    job.element.dispatchEvent?.(new CustomEvent('image-ready', {detail: {width: image.naturalWidth, height: image.naturalHeight}}));
    this.previewImageLoading = false; this.previewImageError = !original;
    this._setPreviewImageAvailable(true);
    if (original) this._prefetchPreviewNeighbors();
  },

  _failPreviewViewerImage(job) {
    if (!this._previewViewerImageJobCurrent(job)) return;
    const thumb = job.preview.thumb_url;
    const unavailable = () => {
      if (!this._previewViewerImageJobCurrent(job)) return;
      job.element.removeAttribute('src');
      if (job.element.dataset) delete job.element.dataset.previewDisplayedKey;
      this.previewImageLoading = false; this.previewImageError = true;
      this._setPreviewImageAvailable(false);
    };
    // Once both target sources fail, remove the previous sample: the heading
    // and generation information already describe the newly selected target.
    if (!thumb) {unavailable(); return;}
    if (this._previewViewerImageSource(job.element) === thumb && job.element.complete && job.element.naturalWidth) {
      this.previewImageLoading = false; this.previewImageError = true;
      this._setPreviewImageAvailable(true);
      return;
    }
    return window.AnimaImages.decode(thumb).then(image => this._commitPreviewViewerImage(job, image, false), unavailable);
  },

  _queuePreviewImage(slot, job) {
    const cache = this._previewOriginalCache ||= window.AnimaImages.createReadyCache(5);
    cache.cancelPrefetch();
    this._previewImageQueue ||= {active: new Set(), pending: new Map()};
    const loads = this._previewImageQueue;
    loads.pending.delete(slot);
    const cached = cache.get(job.key);
    if (cached) {if (job.current()) job.ready(cached); return;}
    loads.pending.set(slot, {...job, cache});
    this._drainPreviewImageQueue(loads);
  },

  _drainPreviewImageQueue(loads = this._previewImageQueue) {
    if (!loads || this._previewImageQueue !== loads || !this.previewLightboxOpen) return;
    while (loads.active.size < 2 && loads.pending.size) {
      const slot = loads.pending.has('current') ? 'current' : loads.pending.keys().next().value;
      const job = loads.pending.get(slot);
      loads.pending.delete(slot);
      if (!job.current()) continue;
      const cached = job.cache.get(job.key);
      if (cached) {job.ready(cached); continue;}
      loads.active.add(job);
      job.start?.();
      const ticket = job.cache.ticket();
      window.AnimaImages.decode(job.source).then(image => {
        if (!job.current()) return;
        job.cache.put(job.key, image, ticket);
        job.ready(image);
      }, job.failed).finally(() => {
        loads.active.delete(job);
        if (this._previewImageQueue === loads) this._drainPreviewImageQueue(loads);
      });
    }
  },

  _displayPreviewImage(element, preview) {
    if (!element || !preview) return;
    const key = this._previewImageCacheKey(preview);
    if (this._previewImageKey === key && this._previewImageElement === element) {
      if (this.weakNetworkMode || this.trainingActive) this._previewOriginalCache?.cancelPrefetch();
      else if (!this.previewImageLoading && !this.previewImageError) this._prefetchPreviewNeighbors();
      return;
    }
    this._previewOriginalCache?.cancelPrefetch();
    this._previewImageKey = key;
    const request = ++this._previewImageRequest;
    this._previewImageElement = element;
    this.previewImageLoading = true; this.previewImageError = false;
    this._setPreviewImageAvailable(false);
    element.alt = preview.name;
    window.AnimaImages.cancel(element);
    const job = {element, preview, key, request};
    // Keep a decoded displayed sample through prompt/page changes. A thumbnail
    // is only the initial placeholder when this element has no visible image.
    if (!this._previewViewerImageSource(element) && preview.thumb_url) element.src = preview.thumb_url;
    this._queuePreviewImage('current', {key, source: this._previewFullImageUrl(preview),
      current: () => this._previewViewerImageJobCurrent(job),
      ready: image => this._commitPreviewViewerImage(job, image, true),
      failed: () => this._failPreviewViewerImage(job)});
  },

  _updatePreviewLightbox() {
    if (this.previewTimelineMenu && this._previewTimelineMenuTarget() < 0) this.closePreviewTimelineMenu(false);
    const n = this.previews.length;
    if (!n) return;
    const p = this.previews[this.previewStep] || this.previews[0];
    this._syncPreviewReference();
    const waiting = this.previewCompareActive && this.previewComparisonWaiting;
    const currentKey = this._previewItemKey(p);
    const references = this.previewCompareActive ? this.previewReferences.filter(item => waiting || this._previewItemKey(item) !== currentKey) : [];
    const headingPreview = waiting ? this.previewReferences[0] : p;
    const img = document.getElementById('previewLightboxImg');
    if (waiting) {
      ++this._previewImageRequest; this._previewImageKey = '';
      this.previewImageLoading = this.previewImageError = false;
      this.previewImageAvailable = false;
      if (img) { window.AnimaImages.cancel(img); img.removeAttribute('src'); }
    } else this._displayPreviewImage(img, p);
    const currentStage = document.getElementById('previewCurrentStage');
    const placeholder = document.getElementById('previewComparisonPlaceholder');
    if (currentStage) currentStage.hidden = waiting;
    if (placeholder) placeholder.hidden = !waiting;
    const currentCaption = document.getElementById('previewCurrentCaption');
    if (currentCaption) currentCaption.hidden = waiting || !references.length;
    const currentCaptionSlot = document.getElementById('previewCurrentCaptionSlot');
    if (currentCaptionSlot) currentCaptionSlot.hidden = !references.length;
    this._updatePreviewReferencePanes(references);
    const currentLabel = document.getElementById('previewCurrentLabel');
    const caption = this._previewCaptionParts(p);
    if (currentLabel) {
      currentLabel.textContent = caption.primary;
      currentLabel.title = [caption.primary, caption.secondary].filter(Boolean).join(' · ');
      currentCaption?.setAttribute('title', currentLabel.title);
    }
    const currentStep = document.getElementById('previewCurrentStep');
    if (currentStep) {currentStep.textContent = caption.secondary; currentStep.hidden = !caption.secondary;}
    const original = document.getElementById('previewLightboxOriginal');
    if (original) {
      original.hidden = waiting || !p.url;
      if (p.url) original.href = p.url;
      else original.removeAttribute('href');
    }
    const c = document.getElementById('previewLightboxCounter');
    const chronologicalIndices = this._previewLightboxIndices();
    const displayIndices = this._previewLightboxDisplayIndices(chronologicalIndices);
    const indices = this._previewLightboxNavigationIndices(displayIndices);
    const displayPosition = indices.indexOf(this.previewStep);
    if (c) {
      const display = document.getElementById('previewLightboxCounterDisplay');
      const input = document.getElementById('previewLightboxPage');
      const total = document.getElementById('previewLightboxCounterTotal');
      if (display) {
        display.textContent = waiting || displayPosition < 0 ? '—' : String(displayPosition + 1);
        display.disabled = !indices.length;
        display.setAttribute?.('aria-label', this.t('monitor.previewPageNumber') + ' ' + display.textContent + ' / ' + indices.length);
      }
      if (input) {
        input.disabled = !indices.length;
        if (!this.previewPageEditing) input.value = displayPosition < 0 ? '' : String(displayPosition + 1);
      }
      if (total) total.textContent = String(indices.length);
      const digits = Math.max(4, String(indices.length).length);
      c.style?.setProperty('--preview-counter-width', (digits * 2 + 3) + 'ch');
      c.title = '';
    }
    const lbl = document.getElementById('previewLightboxLabel');
    if (lbl) {
      const label = waiting ? this.t('monitor.sampleComparison') : this._previewStageLabel(p);
      lbl.textContent = label;
      lbl.title = label === p.name ? p.name : label + '\n' + p.name;
    }
    const prompt = document.getElementById('previewLightboxPrompt');
    const promptText = document.getElementById('previewLightboxPromptText');
    if (prompt && promptText) {
      const text = this._samplePromptText(headingPreview);
      if (promptText.textContent !== text) promptText.textContent = text;
      prompt.title = text;
      prompt.hidden = !text;
    }
    const box = document.getElementById('previewLightbox');
    if (box) {
      const prevBtn = box.querySelector('.preview-lightbox-nav.prev');
      const nextBtn = box.querySelector('.preview-lightbox-nav.next');
      if (prevBtn) prevBtn.disabled = this._previewLightboxNavigationTarget(-1, displayIndices) < 0;
      if (nextBtn) nextBtn.disabled = this._previewLightboxNavigationTarget(1, displayIndices) < 0;
    }
    const strip = document.getElementById('previewLightboxStrip');
    const batch = this._sampleDataModel().byBatch.get(this._sampleRecord(headingPreview).batch_id);
    if (strip && batch) {
      const hadStripFocus = strip.contains(document.activeElement);
      strip.hidden = !batch.indices.length;
      if (strip.hidden && hadStripFocus) document.getElementById('previewLightbox')?.querySelector('.preview-close')?.focus({ preventScroll: true });
      const signature = JSON.stringify(batch.indices.map(index => [index, this._previewItemKey(this.previews[index]), this._samplePromptButtonLabel(this.previews[index])]));
      if (strip.dataset.signature !== signature) {
        const hadFocus = strip.contains(document.activeElement);
        const focusedPath = hadFocus ? document.activeElement.dataset.previewPath : '';
        strip.innerHTML = batch.indices.map(index => '<button type="button" class="btn btn-sm btn-ghost preview-strip-item"'
          + ' data-preview-index="' + index + '" data-preview-path="' + this.esc(this._previewItemKey(this.previews[index]))
          + '" aria-pressed="false" @click="selectPreviewCaseByKey($event.currentTarget.dataset.previewPath)" aria-label="' + this.esc(this._samplePromptButtonLabel(this.previews[index])) + '">'
          + this.esc(this._samplePromptButtonLabel(this.previews[index])) + '</button>').join('');
        strip.dataset.signature = signature;
        if (hadFocus) {
          const focus = Array.from(strip.querySelectorAll('.preview-strip-item')).find(item => item.dataset.previewPath === focusedPath)
            || strip.querySelector('[data-preview-index="' + this.previewStep + '"]');
          focus?.focus({ preventScroll: true });
        }
      }
      strip.querySelectorAll('.preview-strip-item').forEach(item => {
        const active = Number(item.dataset.previewIndex) === (waiting ? this.previews.indexOf(headingPreview) : this.previewStep);
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      this._revealPreviewPromptStrip();
      this.syncPreviewPromptBar();
    }
    this._updatePreviewViewTimeline(displayIndices);
    this.constrainPreviewView();
  },

  _previewCompareLabel(preview) {
    const sample = this._sampleRecord(preview);
    const batch = this._sampleDataModel().byBatch.get(sample.batch_id);
    return [this._sampleStageText(batch?.label || sample.batch_label), this._sampleCaseLabel(preview)].filter(Boolean).join(' ') || preview.name;
  },

  _previewStageLabel(preview) {
    const sample = this._sampleRecord(preview);
    return this._sampleStageText(this._sampleDataModel().byBatch.get(sample.batch_id)?.label || sample.batch_label);
  },

  _previewCaptionParts(preview) {
    const sample = this._sampleRecord(preview);
    return this._sampleStageParts(this._sampleDataModel().byBatch.get(sample.batch_id)?.label || sample.batch_label || preview.name);
  },

  _previewCaptionTextHtml(current = false) {
    return '<span class="preview-caption-text"><span class="preview-caption-heading">'
      + (current ? '<span class="preview-caption-current">' + this.esc(this.t('monitor.currentSample')) + '</span>' : '')
      + '<strong' + (current ? ' id="previewCurrentLabel"' : '') + '></strong></span>'
      + '<small class="preview-caption-step"' + (current ? ' id="previewCurrentStep"' : '') + '></small></span>';
  },

  _previewInfoPreview() {
    return this.previewLightboxOpen && this.previewCompareActive && this.previewComparisonWaiting
      ? this.previewReferences[0] : this.previews[this.previewStep];
  },

  _previewGenerationInfoHtml(preview) {
    if (!preview) return '';
    const sample = this._sampleRecord(preview), params = sample.params || {};
    let html = '';
    const entries = [], add = (label, value) => {
      if (value != null && value !== '') entries.push([this.t('monitor.' + label), String(value)]);
    };
    const weightPath = value => typeof value === 'string' ? value : value?.path || '';
    add('sampleAxisPrompt', params.prompt);
    add('sampleNegativePrompt', params.negative_prompt);
    add('sampleAxisSeed', sample.seed ?? params.seed);
    if (params.width != null && params.height != null) add('sampleImageSize', params.width + ' × ' + params.height);
    add('sampleAxisSteps', params.steps);
    if (params.requested_steps != null && params.requested_steps !== params.steps) add('sampleRequestedSteps', params.requested_steps);
    add('sampleAxisCfg', params.cfg_scale);
    add('sampleAxisSampler', params.sampler);
    add('sampleAxisScheduler', params.scheduler);
    add('sampleAxisFlowShift', params.flow_shift);
    if (Array.isArray(params.uncond_skip_layers) && params.uncond_skip_layers.length) add('sampleUncondSkipLayers', params.uncond_skip_layers.join(', '));
    add('sampleBaseModel', weightPath(params.base_model));
    if (Array.isArray(params.loras) && params.loras.length) add('sampleExtraLoras', params.loras.map(lora => weightPath(lora) + (lora?.multiplier != null ? ' × ' + lora.multiplier : '')).join('\n'));
    if (params.model_variant?.turbo_dit) add('sampleTurboModel', weightPath(params.model_variant.turbo_dit));
    if (params.model_variant?.turbo_lora) add('sampleTurboLora', weightPath(params.model_variant.turbo_lora)
      + (params.model_variant.turbo_lora_multiplier != null ? ' × ' + params.model_variant.turbo_lora_multiplier : ''));
    if (entries.length) html += '<dl class="preview-generation-grid">' + entries.map(([label, value]) => '<dt>' + this.esc(label) + '</dt><dd>' + this.esc(value) + '</dd>').join('') + '</dl>';
    html += '<p class="preview-generation-file">' + this.esc(preview.name) + '</p>';
    return html;
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
    let html = '<button type="button" id="outputSort-' + group + '-' + key + '" aria-label="' + this.esc(label + (active ? ' ' + this.t('monitor.' + (activeDir === 'asc' ? 'sortAscending' : 'sortDescending')) : '')) + '" class="output-table-sort' + (active ? ' active' : '') + '" @click="setOutputSort(\'' + group + '\',\'' + key + '\')">' + this.esc(label);
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
