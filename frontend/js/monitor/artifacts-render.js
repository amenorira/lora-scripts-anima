/* 训练样本、预览灯箱与输出文件视图；由 monitor-render.js 装配。 */
window.monitorArtifactsRenderMixin = {
  _previewThumbImageHtml(preview) {
    const imageUrl = preview.thumb_url || preview.url;
    const common = ' alt="' + this.esc(preview.name) + '" loading="lazy" decoding="async" fetchpriority="low"';
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

  // ═══════════════════════════════════════════════════════════
  //  样本标签
  // ═══════════════════════════════════════════════════════════
  _renderSamplesTab(t) {
    const isHistory = !!this.selectedRunDir;
    const d = isHistory ? (this.runDetailData||{}) : (this.monitorData||{});
    const showPreviews = this.previews.length > 0;
    const lastIdx = this.previews.length - 1;

    const canRefresh = !!this.currentOutputRunDir;
    let html = '<div class="m-section m-samples-section"><div class="m-view-header"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t('previewSamples')) + '</span>' + (showPreviews ? '<span class="m-logs-count">' + this.previews.length + '</span>' : '') + '</div>';
    html += '<div class="m-view-actions"><div class="m-segmented" role="group" aria-label="' + this.esc(t('sampleOrder')) + '">';
    html += '<button type="button" data-preview-sort="asc" aria-pressed="' + (this.previewSortDir === 'asc' ? 'true' : 'false') + '" class="m-segmented-btn' + (this.previewSortDir === 'asc' ? ' active' : '') + '" @click="setPreviewSort(\'asc\')">' + this.esc(t('trainingOrder')) + '</button>';
    html += '<button type="button" data-preview-sort="desc" aria-pressed="' + (this.previewSortDir === 'desc' ? 'true' : 'false') + '" class="m-segmented-btn' + (this.previewSortDir === 'desc' ? ' active' : '') + '" @click="setPreviewSort(\'desc\')">' + this.esc(t('latestFirst')) + '</button></div>';
    html += '<button type="button" class="btn btn-sm btn-secondary" @click="refreshPreviews()" :disabled="previewsLoading || !currentOutputRunDir" x-text="previewsLoading ? t(\'monitor.loading\') : t(\'monitor.refresh\')"></button></div>';
    html += '</div>';
    html += this._artifactLocationHtml(t, d);
    if (showPreviews) {
      html += '<div class="preview-grid">';
      const groups = new Set();
      const counts = new Map();
      this.previews.forEach(preview => { const stage = this._sampleMetadata(preview.name).stage; counts.set(stage, (counts.get(stage) || 0) + 1); });
      this._previewDisplayIndices().forEach(i => {
        const pv = this.previews[i];
        const info = this._sampleMetadata(pv.name);
        if (info.stage && counts.get(info.stage) > 1 && !groups.has(info.stage)) {
          groups.add(info.stage);
          html += '<div class="m-preview-group-heading" data-preview-group="' + this.esc(info.stage) + '">' + this.esc(info.stage) + '</div>';
        }
        html += '<button type="button" class="preview-grid-item" data-preview-index="' + i + '" @click="openPreviewLightbox(' + i + ')">';
        if (i === lastIdx) html += '<span class="preview-thumb-fresh">' + this.esc(t('latest')) + '</span>';
        html += this._previewThumbImageHtml(pv);
        html += '<span class="preview-grid-item-label" title="' + this.esc(pv.name) + '"><strong>' + this.esc(counts.get(info.stage) > 1 ? info.prompt : this._parseSampleInfo(pv.name)) + '</strong></span>';
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
    // 在 shell 阶段注入一次；通过 .open 类切换显隐，开/关/翻页仅原地填充。
    return '<div class="preview-lightbox" id="previewLightbox" x-cloak @click="closePreviewLightbox()">'
      + '<button type="button" class="preview-lightbox-close" @click.stop="closePreviewLightbox()" aria-label="' + this.esc(t('close')) + '">×</button>'
      + '<button type="button" class="preview-lightbox-nav prev" @click.stop="previewLightboxNav(-1)" aria-label="' + this.esc(t('prev')) + '">‹</button>'
      + '<div class="preview-lightbox-inner" @click.stop>'
      + '<div class="preview-lightbox-images"><img class="preview-lightbox-img" id="previewLightboxImg" alt=""/><img class="preview-lightbox-img" id="previewReferenceImg" hidden alt=""/></div>'
       + '<div class="preview-lightbox-bar">'
       + '<span class="preview-lightbox-counter" id="previewLightboxCounter"></span>'
       + '<span class="preview-lightbox-label" id="previewLightboxLabel"></span>'
       + '<span class="preview-lightbox-label" id="previewReferenceLabel" hidden></span>'
       + '<div class="preview-lightbox-actions">'
       + '<button type="button" class="btn btn-sm btn-secondary" @click="togglePreviewReference()" x-text="previewReference ? t(\'monitor.clearReference\') : t(\'monitor.pinReference\')"></button>'
       + '<button type="button" class="btn btn-sm btn-secondary" id="previewLightboxMetadataButton" @click="togglePreviewMetadata()" aria-expanded="false">' + this.esc(t('previewMetadata')) + '</button>'
       + '<a class="btn btn-sm btn-secondary" id="previewLightboxOriginal" target="_blank" rel="noopener" @click.stop>' + this.esc(t('openOriginal')) + '</a>'
       + '</div>'
       + '<span class="preview-lightbox-hint">←/→ ' + this.esc(t('navigate')) + ' · Esc ' + this.esc(t('close')) + '</span>'
       + '</div>'
       + '<div class="preview-lightbox-metadata" id="previewLightboxMetadata" hidden></div>'
       + '</div>'
      + '<button type="button" class="preview-lightbox-nav next" @click.stop="previewLightboxNav(1)" aria-label="' + this.esc(t('next')) + '">›</button>'
      + '</div>';
  },

  openPreviewLightbox(i) {
    if (!this.previews.length) return;
    this.previewStep = Math.max(0, Math.min(i, this.previews.length - 1));
    const box = document.getElementById('previewLightbox');
    if (!box) return;
    box.classList.add('open');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', this.t('monitor.previewSamples'));
    this._previewReturnFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    this._updatePreviewLightbox();
    if (!this._lightboxKeyHandler) {
      this._lightboxKeyHandler = (e) => {
        if (e.defaultPrevented || e.target.closest?.('dialog[open]')) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.previewLightboxNav(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.previewLightboxNav(1); }
        else if (e.key === 'Escape') { this.closePreviewLightbox(); }
        else if (e.key === 'Tab') {
          const items = Array.from(box.querySelectorAll('button:not([disabled]), a[href], summary')).filter(el => el.getClientRects().length);
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
    }
    document.addEventListener('keydown', this._lightboxKeyHandler);
    box.querySelector('.preview-lightbox-close').focus();
  },

  closePreviewLightbox() {
    const box = document.getElementById('previewLightbox');
    if (box) box.classList.remove('open');
    const image = document.getElementById('previewLightboxImg');
    if (image) image.removeAttribute('src');
    const reference = document.getElementById('previewReferenceImg');
    if (reference) { reference.removeAttribute('src'); reference.hidden = true; }
    this.previewReference = null;
    if (typeof this._resetPreviewMetadata === 'function') this._resetPreviewMetadata();
    document.body.style.overflow = '';
    if (this._lightboxKeyHandler) document.removeEventListener('keydown', this._lightboxKeyHandler);
    this._lightboxKeyHandler = null;
    if (this._previewReturnFocus && this._previewReturnFocus.isConnected) this._previewReturnFocus.focus({ preventScroll: true });
    this._previewReturnFocus = null;
  },

  togglePreviewReference() {
    this.previewReference = this.previewReference ? null : this.previews[this.previewStep];
    this._updatePreviewLightbox();
  },

  previewLightboxNav(dir) {
    if (!this.previews.length) return;
    const indices = this._previewDisplayIndices();
    const current = Math.max(0, indices.indexOf(this.previewStep));
    const nextPosition = Math.max(0, Math.min(current + dir, indices.length - 1));
    const next = indices[nextPosition];
    if (next === this.previewStep) return;
    this.previewStep = next;
    this._updatePreviewLightbox();
  },

  _updatePreviewLightbox() {
    const n = this.previews.length;
    if (!n) return;
    const p = this.previews[this.previewStep] || this.previews[0];
    if (typeof this._resetPreviewMetadata === 'function') this._resetPreviewMetadata();
    const img = document.getElementById('previewLightboxImg');
    if (img) { img.src = p.inspect_url || p.url; img.alt = p.name; }
    const reference = document.getElementById('previewReferenceImg');
    if (reference) {
      reference.hidden = !this.previewReference;
      if (this.previewReference) {
        reference.src = this.previewReference.inspect_url || this.previewReference.url;
        reference.alt = this.t('monitor.pinReference') + ': ' + this.previewReference.name;
        reference.title = reference.alt;
      } else reference.removeAttribute('src');
    }
    const referenceLabel = document.getElementById('previewReferenceLabel');
    if (referenceLabel) {
      referenceLabel.hidden = !this.previewReference;
      referenceLabel.textContent = this.previewReference ? this.t('monitor.reference') + ': ' + this._parseSampleInfo(this.previewReference.name) : '';
    }
    const original = document.getElementById('previewLightboxOriginal');
    if (original) {
      original.hidden = !p.url;
      if (p.url) original.href = p.url;
      else original.removeAttribute('href');
    }
    const c = document.getElementById('previewLightboxCounter');
    const indices = this._previewDisplayIndices();
    const displayPosition = Math.max(0, indices.indexOf(this.previewStep));
    if (c) c.textContent = (displayPosition + 1) + ' / ' + n;
    const lbl = document.getElementById('previewLightboxLabel');
    if (lbl) lbl.textContent = this._parseSampleInfo(p.name);
    const box = document.getElementById('previewLightbox');
    if (box) {
      const prevBtn = box.querySelector('.preview-lightbox-nav.prev');
      const nextBtn = box.querySelector('.preview-lightbox-nav.next');
      if (prevBtn) prevBtn.disabled = displayPosition <= 0;
      if (nextBtn) nextBtn.disabled = displayPosition >= n - 1;
    }
  },

  _parseSampleInfo(filename) {
    const info = this._sampleMetadata(filename);
    return [info.stage, info.prompt].filter(Boolean).join(' · ') || filename;
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
    html += '<div class="m-view-header"><div class="m-output-toolbar-top"><div class="m-view-heading"><span class="m-view-title">' + this.esc(t('outputs')) + '</span>' + (this.outputFiles.length ? '<span class="m-logs-count">' + this.outputFiles.length + '</span>' : '') + '</div>';
    html += '<button type="button" id="outputRefresh" class="btn btn-sm btn-secondary" @click="loadOutputFiles()"' + (!runDir || this.outputFilesLoading ? ' disabled' : '') + '>' + this.esc(t(this.outputFilesLoading ? 'loading' : 'refresh')) + '</button>';
    html += '<div class="m-output-selection-tools"><span class="m-output-selection-count" role="status">' + this.esc(t('selected')) + ' <strong>' + selectedCount + '</strong> / ' + this.outputFiles.length;
    if (hiddenSelected > 0) html += '<small>' + this.esc(t('hiddenSelectedOutputs').replace('{n}', hiddenSelected)) + '</small>';
    html += '</span><button type="button" id="outputClearSelection" class="btn btn-sm btn-secondary" @click="deselectAllOutputFiles()"' + (!selectedCount ? ' disabled' : '') + '>' + this.esc(t('clearSelection')) + '</button>';
    html += '<button type="button" id="outputDownload" class="btn btn-sm btn-primary m-output-download" @click="' + (selectedCount ? 'downloadSelectedOutputs()' : 'downloadAllOutputs()') + '"' + (!canUseFiles || this.outputFilesLoading ? ' disabled' : '') + '><span' + (selectedCount ? ' class="is-hidden"' : '') + '>' + this.esc(t('downloadAll')) + '</span><span' + (!selectedCount ? ' class="is-hidden"' : '') + '>' + this.esc(t('downloadSelected')) + '</span></button></div></div>';
    html += '<div class="m-view-actions m-output-toolbar-filters">';
    html += '<label class="m-output-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="m-output-search-input" type="search" value="' + this.esc(this.outputSearch) + '" aria-label="' + this.esc(t('searchOutputs')) + '" placeholder="' + this.esc(t('searchOutputs')) + '" @input.debounce.180ms="setOutputSearch($event.target.value)"></label>';
    html += '<div class="m-segmented" role="group" aria-label="' + this.esc(t('outputFilter')) + '">';
    [['all', t('filterAll')], ['models', t('filterModels')], ['others', t('filterOthers')]].forEach(item => {
      html += '<button type="button" id="outputFilter-' + item[0] + '" aria-pressed="' + (this.outputFilter === item[0]) + '" class="m-segmented-btn' + (this.outputFilter === item[0] ? ' active' : '') + '" @click="setOutputFilter(\'' + item[0] + '\')">' + this.esc(item[1]) + '</button>';
    });
    html += '</div>';
    html += '<button type="button" id="outputSelectVisible" class="btn btn-sm btn-secondary" @click="selectAllOutputFiles()"' + (!canUseFiles || !visibleCount || this.outputFilesLoading ? ' disabled' : '') + '>' + this.esc(t('selectVisible')) + '</button>';
    if (d.artifact_dir) html += '<button type="button" class="btn btn-sm btn-secondary" @click="navigator.clipboard.writeText(currentArtifactData().artifact_dir).then(() => toast(t(\'common.copied\'))).catch(() => toast(t(\'common.failed\'), \'error\'))">' + this.esc(t('copyOutputPath')) + '</button>';
    html += '</div></div>';
    html += this._artifactLocationHtml(t, d);

    if (this.outputFilesLoading && !this.outputFiles.length) {
      html += '<div class="dashboard-empty" style="padding:48px"><p>' + this.esc(t('loading')) + '</p></div>';
      html += '</div>';
      return html;
    }

    if (!this.outputFiles.length) {
      let emptyKey = 'noOutputsHint';
      let emptyFallback = 'Training outputs will appear here after saving';
      if (!runDir) {
        emptyKey = 'noOutputsNoRunHint';
        emptyFallback = 'Start or select a training run to view its output files.';
      } else if (artifactUnavailable) {
        emptyKey = 'noOutputsArtifactUnavailableHint';
        emptyFallback = 'The output folder is unavailable. Logs and TensorBoard remain available; restore the path to list or download files.';
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
      html += '<div class="m-ckpt-section" style="margin-top:12px">';
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
