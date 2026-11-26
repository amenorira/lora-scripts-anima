/* 训练集诊断逐图列表、单图详情弹窗与采样明细弹窗；由 dataset-diagnostics-render.js 聚合。 */
(() => {
  window.datasetDiagnosticsModalMixin = {
    _ddSortColHtml(t, column, descKey, ascKey, label, rightAlign = false) {
      const cur = this.datasetDiagSort || 'residual_desc';
      const isDesc = cur === descKey;
      const isAsc = cur === ascKey;
      const active = isDesc || isAsc;
      const arrow = isAsc ? '↑' : (isDesc ? '↓' : '');
      const dirLabel = active ? (' ' + t(isAsc ? 'sortAscending' : 'sortDescending')) : '';
      return '<button type="button" class="output-table-sort m-dd-th-sort' + (active ? ' active' : '') + (rightAlign ? ' is-right' : '') + '"'
        + ' aria-label="' + this.esc(label + dirLabel) + '" @click="toggleDatasetDiagColumnSort(\'' + column + '\')">'
        + '<span>' + this.esc(label) + '</span>'
        + '<span class="m-dd-th-arrow" aria-hidden="true">' + arrow + '</span>'
        + '</button>';
    },

    _ddImagePatchSig(img, viewMode, maxAbs) {
      return [
        img.mean_residual ?? '',
        img.slope ?? '',
        img.count ?? '',
        img.epochs ?? '',
        img.mean_loss ?? '',
        img.resolution ?? '',
        img.status ?? '',
        img.thumb_url || '',
        img.is_reg ? 1 : 0,
        viewMode === 'table' ? maxAbs : '',
      ].join('|');
    },

    _ddImageCardHtml(t, img) {
      const resText = this._ddFormatResidual(img.mean_residual);
      const color = this._ddResidualColor(img.mean_residual);
      const slopeColor = this._ddSlopeColor(img.slope, img.converging_slope);
      const slopeText = img.slope != null
        ? (this._ddFormatSlope(img.slope) + t('ddSlopeUnit'))
        : '—';
      const statusMeta = this._ddStatusMeta(t, img.status, img.slope);
      const resoText = this._ddFormatResolution(img.resolution);
      const countReso = t('ddCardCountReso').replace('{n}', img.count).replace('{reso}', resoText);
      const sig = this._ddImagePatchSig(img, 'grid', '');
      let html = '<article class="m-dd-card" role="button" tabindex="0" data-dd-image-id="' + this.esc(img.image_id) + '" data-dd-sig="' + this.esc(sig) + '"'
        + ' aria-haspopup="dialog">';
      html += '<div class="m-dd-card-media">';
      if (img.thumb_url) {
        html += '<img src="' + this.esc(img.thumb_url) + '" alt="' + this.esc(img.name) + '" loading="lazy" decoding="async"/>';
      } else {
        html += '<div class="m-dd-media-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg><span>' + this.esc(t('ddLocalMissingShort')) + '</span></div>';
      }
      html += '</div>';
      html += '<div class="m-dd-card-body">';
      html += '<div class="m-dd-card-top"><strong class="m-dd-card-name" title="' + this.esc(img.image) + '"><span>' + this.esc(img.name) + '</span></strong>'
        + '<span class="m-dd-card-res"><small class="m-dd-card-kv">' + this.esc(t('ddCardResidual')) + '</small><b style="color:' + color + '">' + this.esc(resText) + '</b></span></div>';
      html += '<div class="m-dd-card-metrics">'
        + '<span class="m-dd-card-slope"><small class="m-dd-card-kv">' + this.esc(t('ddCardSlope')) + '</small><b style="color:' + slopeColor + '">' + this.esc(slopeText) + '</b></span>'
        + '<span class="m-dd-card-reso" title="' + this.esc(countReso) + '">' + this.esc(countReso) + '</span></div>';
      html += '<div class="m-dd-card-foot">'
        + '<span class="m-dd-card-flag is-' + this.esc(statusMeta.tone) + '">' + this.esc(statusMeta.label) + '</span>'
        + (img.is_reg ? '<small class="output-dir-tag m-dd-card-reg">' + this.esc(t('ddRegTag')) + '</small>' : '')
        + '</div>';
      html += '</div></article>';
      return html;
    },

    _ddImageTableRowHtml(t, img, maxAbs) {
      const resText = this._ddFormatResidual(img.mean_residual);
      const color = this._ddResidualColor(img.mean_residual);
      const statusMeta = this._ddStatusMeta(t, img.status, img.slope);
      const sig = this._ddImagePatchSig(img, 'table', maxAbs);
      let html = '<div class="output-item m-dd-table-row" role="button" tabindex="0" data-dd-image-id="' + this.esc(img.image_id) + '" data-dd-sig="' + this.esc(sig) + '"'
        + ' aria-haspopup="dialog">';
      html += '<div class="m-dd-row-thumb">'
        + (img.thumb_url
          ? '<img src="' + this.esc(img.thumb_url) + '" alt="" loading="lazy" decoding="async"/>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>')
        + '</div>';
      html += '<div class="m-dd-row-name" title="' + this.esc(img.image) + '"><strong><span>' + this.esc(img.name) + '</span></strong>'
        + '<div class="m-dd-row-sub"><span>' + this.esc(img.dir_label) + '</span>'
        + (img.is_reg ? '<small class="output-dir-tag">' + this.esc(t('ddRegTag')) + '</small>' : '') + '</div></div>';
      html += '<span class="m-dd-num">' + this.esc(this._ddFormatResolution(img.resolution)) + '</span>';
      html += '<span class="m-dd-num m-dd-num-col">' + this.esc(img.count + ' / ' + img.epochs) + '</span>';
      html += '<span class="m-dd-num m-dd-num-col">' + this.esc(this._ddFormatLoss(img.mean_loss)) + '</span>';
      html += '<span class="m-dd-res-cell"><strong class="m-dd-num-val" style="color:' + color + '">' + this.esc(resText) + '</strong>' + this._ddResidualBarHtml(img.mean_residual, maxAbs) + '</span>';
      html += '<span class="m-dd-num m-dd-num-col" style="color:' + this._ddSlopeColor(img.slope, img.converging_slope) + '">' + this.esc(this._ddFormatSlope(img.slope)) + '</span>';
      html += '<span class="m-dd-pill is-' + this.esc(statusMeta.tone) + '">' + this.esc(statusMeta.label) + '</span>';
      html += '</div>';
      return html;
    },

    _ddFolderHeadInnerHtml(t, group, shownCount = null) {
      const countText = (shownCount != null && shownCount > 0 && shownCount < group.totalCount)
        ? (shownCount + ' / ' + group.totalCount)
        : t('ddGroupCountShort').replace('{n}', group.totalCount);
      const resText = group.meanResidual != null
        ? (t('ddCardResidual') + ' ' + this._ddFormatResidual(group.meanResidual))
        : '';
      const resColor = group.meanResidual != null
        ? this._ddResidualColor(group.meanResidual, { scale: 'group' })
        : '';
      return '<svg class="m-dd-folder-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.25 8 9.75l3.5-3.5"/></svg>'
        + '<span class="m-dd-folder-name">' + this.esc(group.label) + '</span>'
        + (group.isReg ? '<small class="output-dir-tag m-dd-folder-reg">' + this.esc(t('ddRegTag')) + '</small>' : '')
        + '<span class="m-dd-folder-meta">'
        + '<span class="m-dd-folder-count">' + this.esc(countText) + '</span>'
        + (resText ? '<strong class="m-dd-folder-res" style="color:' + resColor + '">' + this.esc(resText) + '</strong>' : '')
        + '</span>';
    },

    _ddComputeImagesSig(dataSig, sourceKey, gfKey) {
      const collapsedFoldersKey = Object.keys(this.datasetDiagCollapsedFolders || {})
        .filter(k => this.datasetDiagCollapsedFolders[k])
        .sort()
        .join('\u0000');
      const effectiveRegMode = this._datasetDiagEffectiveRegMode
        ? this._datasetDiagEffectiveRegMode()
        : this.datasetDiagRegMode;
      return JSON.stringify([
        this._shellLocale, dataSig, this.datasetDiagPreset, gfKey,
        this.datasetDiagSearch, effectiveRegMode, this.datasetDiagSort,
        this.datasetDiagViewMode, !!this.datasetDiagGroupByFolder, collapsedFoldersKey,
        this.datasetDiagDisplayLimit, sourceKey,
      ]);
    },

    _ddComputeGroupedSlices(filtered, limit) {
      const groups = this._datasetDiagGroupedImages(filtered);
      const collapsedMap = this.datasetDiagCollapsedFolders || {};
      let budget = limit;
      let renderedCount = 0;
      let totalExpandable = 0;
      const slices = [];
      for (const group of groups) {
        const isCollapsed = !!collapsedMap[group.key];
        if (!isCollapsed) totalExpandable += group.totalCount;
        if (isCollapsed) {
          slices.push({ group, isCollapsed: true, visibleItems: [] });
        } else if (budget > 0) {
          const visibleItems = group.items.slice(0, budget);
          budget -= visibleItems.length;
          renderedCount += visibleItems.length;
          slices.push({ group, isCollapsed: false, visibleItems });
        } else {
          // Keep remaining non-collapsed headers so folder counts stay aligned on toggle.
          slices.push({ group, isCollapsed: false, visibleItems: [] });
        }
      }
      return {
        groups,
        slices,
        hasMore: totalExpandable > renderedCount,
        remaining: totalExpandable - renderedCount,
      };
    },

    _patchDatasetDiagFolderToggle(dirKey) {
      const doc = globalThis.document;
      if (!doc?.querySelector) return false;
      const panel = doc.querySelector('.m-tab-panel[data-tab="dataset"]');
      const imagesSlot = panel?.querySelector?.('[data-dd-slot="images"]');
      const sectionEl = imagesSlot?.querySelector?.('#datasetDiagImagesSection');
      if (!sectionEl) return false;
      this._clearDatasetDiagImagesMarquee?.(sectionEl.querySelector?.('[data-dd-images-body]'));

      const t = k => this.tMonitor(k);
      const viewMode = this.datasetDiagViewMode === 'table' ? 'table' : 'grid';
      const headBtns = Array.from(sectionEl.querySelectorAll?.(
        viewMode === 'grid' ? '.m-dd-folder-head[data-dd-folder-group]' : '.m-dd-table-folder-head[data-dd-folder-group]'
      ) || []);
      const targetHead = headBtns.find(el => el.dataset?.ddFolderGroup === dirKey);
      const targetSec = viewMode === 'grid'
        ? targetHead?.closest?.('.m-dd-folder-group')
        : targetHead?.closest?.('.m-dd-table-folder-section');
      const targetBody = targetSec?.querySelector?.('[data-dd-folder-body]');
      const targetInner = targetBody?.querySelector?.('.m-dd-folder-body-inner');
      if (!targetHead || !targetSec || !targetBody || !targetInner) return false;

      const filtered = this._datasetDiagFilteredImages();
      const limit = this.datasetDiagDisplayLimit || 120;
      const maxAbs = filtered.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0)), 0.55);
      const { slices, hasMore, remaining } = this._ddComputeGroupedSlices(filtered, limit);

      const sliceByKey = new Map(slices.map(s => [s.group.key, s]));
      const secNodes = Array.from(sectionEl.querySelectorAll?.(
        viewMode === 'grid' ? '.m-dd-folder-group' : '.m-dd-table-folder-section'
      ) || []);
      const secKeyOf = sec => {
        if (viewMode === 'grid') return sec.dataset?.ddFolderGroup || '';
        return sec.querySelector?.('.m-dd-table-folder-head')?.dataset?.ddFolderGroup
          || sec.dataset?.ddTableFolderSection || '';
      };
      if (secNodes.length !== slices.length || !secNodes.every(sec => sliceByKey.has(secKeyOf(sec)))) {
        return false;
      }

      const renderItemsHtml = items => {
        if (!items.length) return '';
        return viewMode === 'grid'
          ? '<div class="m-dd-grid">' + items.map(img => this._ddImageCardHtml(t, img)).join('') + '</div>'
          : items.map(img => this._ddImageTableRowHtml(t, img, maxAbs)).join('');
      };
      const itemsMatchDom = (inner, items) => {
        const nodes = Array.from(inner.querySelectorAll?.(viewMode === 'grid' ? '.m-dd-card' : '.m-dd-table-row') || []);
        return nodes.length === items.length && items.every((item, idx) => nodes[idx]?.dataset?.ddImageId === item.image_id);
      };

      for (const sec of secNodes) {
        const secKey = secKeyOf(sec);
        const s = sliceByKey.get(secKey);
        const headBtn = secKey === dirKey
          ? targetHead
          : headBtns.find(el => el.dataset?.ddFolderGroup === secKey);
        const bodyEl = sec.querySelector?.('[data-dd-folder-body]');
        const innerEl = bodyEl?.querySelector?.('.m-dd-folder-body-inner');
        if (!headBtn || !bodyEl || !innerEl) return false;

        const countEl = headBtn.querySelector?.('.m-dd-folder-count');
        if (countEl) {
          const shown = s.isCollapsed ? null : s.visibleItems.length;
          const nextCount = (shown != null && shown > 0 && shown < s.group.totalCount)
            ? (shown + ' / ' + s.group.totalCount)
            : t('ddGroupCountShort').replace('{n}', s.group.totalCount);
          if (countEl.textContent !== nextCount) countEl.textContent = nextCount;
        }

        if (secKey === dirKey) {
          if (!s.isCollapsed) {
            if (!itemsMatchDom(innerEl, s.visibleItems)) {
              innerEl.innerHTML = renderItemsHtml(s.visibleItems);
              void bodyEl.offsetHeight;
            }
            bodyEl.inert = false;
            bodyEl.removeAttribute?.('inert');
            sec.classList?.remove?.('is-collapsed');
            headBtn.classList?.remove?.('is-collapsed');
            headBtn.setAttribute?.('aria-expanded', 'true');
          } else {
            bodyEl.inert = true;
            bodyEl.setAttribute?.('inert', '');
            sec.classList?.add?.('is-collapsed');
            headBtn.classList?.add?.('is-collapsed');
            headBtn.setAttribute?.('aria-expanded', 'false');
          }
        } else if (!s.isCollapsed && !itemsMatchDom(innerEl, s.visibleItems)) {
          innerEl.innerHTML = renderItemsHtml(s.visibleItems);
        }
      }

      let moreRow = sectionEl.querySelector?.('[data-dd-more-row]');
      if (hasMore) {
        if (!moreRow && typeof doc.createElement === 'function') {
          moreRow = doc.createElement('div');
          moreRow.className = 'm-dd-more-row';
          moreRow.setAttribute('data-dd-more-row', '');
          const bodyHost = sectionEl.querySelector?.('[data-dd-images-body]') || sectionEl;
          bodyHost.appendChild(moreRow);
        }
        if (moreRow) {
          moreRow.hidden = false;
          moreRow.innerHTML = '<button type="button" class="btn btn-sm btn-secondary" @click="showMoreDatasetDiagImages()">'
            + this.esc(t('ddShowMore').replace('{n}', remaining)) + '</button>';
        }
      } else if (moreRow) {
        moreRow.hidden = true;
      }

      const gfKey = this.datasetDiagGroupFilter
        ? (this.datasetDiagGroupFilter.dim + ':' + this.datasetDiagGroupFilter.key)
        : '';
      const sourceKey = this._datasetDiagSource?.()?.key || '';
      panel._ddImagesSig = this._ddComputeImagesSig(this._datasetDiagSnapshotVersion, sourceKey, gfKey);
      return true;
    },

    _ddImagesPresetSpecs(t, data) {
      const summary = data?.summary || {};
      const statusCounts = typeof this._datasetDiagStatusCounts === 'function'
        ? this._datasetDiagStatusCounts()
        : {
          all: summary.images_total || 0,
          attention: summary.counts?.attention || 0,
          learning: summary.counts?.learning || 0,
          easy: summary.counts?.easy || 0,
          non_finite: summary.counts?.non_finite || 0,
          unqualified: (summary.counts?.insufficient || 0) + (summary.counts?.insufficient_reference || 0),
        };
      const presets = [['all', t('ddPresetAll'), statusCounts.all]];
      if (statusCounts.non_finite > 0 || (summary.counts?.non_finite || 0) > 0 || this.datasetDiagPreset === 'non_finite') {
        presets.push(['non_finite', t('ddPresetNonFinite'), statusCounts.non_finite]);
      }
      presets.push(['attention', t('ddPresetAttention'), statusCounts.attention]);
      if (statusCounts.learning > 0 || this.datasetDiagPreset === 'learning') {
        presets.push(['learning', t('ddStatusLearning'), statusCounts.learning]);
      }
      if (statusCounts.normal > 0 || this.datasetDiagPreset === 'normal') {
        presets.push(['normal', t('ddStatusNormal'), statusCounts.normal]);
      }
      if (statusCounts.easy > 0 || this.datasetDiagPreset === 'easy') {
        presets.push(['easy', t('ddPresetLow'), statusCounts.easy]);
      }
      if (statusCounts.unqualified > 0 || this.datasetDiagPreset === 'unqualified') {
        presets.push(['unqualified', t('ddPresetUnqualified'), statusCounts.unqualified]);
      }
      return presets;
    },

    _ddPresetTabsHtml(t, presets) {
      return presets.map(([key, label, cnt]) => {
        const active = this.datasetDiagPreset === key;
        const dotHtml = key === 'all'
          ? ''
          : '<span class="m-dd-status-dot is-' + key + '" aria-hidden="true"></span>';
        return '<button type="button" class="m-segmented-btn' + (active ? ' active' : '') + (cnt === 0 ? ' is-empty' : '') + '" data-dd-preset-tab="' + key + '" aria-pressed="' + active + '" @click="setDatasetDiagPreset(\'' + key + '\')">'
          + dotHtml
          + '<span class="m-dd-tab-label">' + this.esc(label) + '</span>'
          + '<small class="m-dd-tab-n">' + cnt + '</small></button>';
      }).join('');
    },

    _renderDatasetDiagImagesToolbar(t, data) {
      const summary = data.summary || {};
      const presets = this._ddImagesPresetSpecs(t, data);
      const viewMode = this.datasetDiagViewMode === 'table' ? 'table' : 'grid';
      const canGroup = !!this._datasetDiagHasMultipleFolders?.(data);
      const groupByFolder = Boolean(canGroup && this.datasetDiagGroupByFolder);
      const hasRegImages = this._datasetDiagHasRegImages ? this._datasetDiagHasRegImages(data) : Boolean(summary.has_reg_images);
      const regMode = this._datasetDiagEffectiveRegMode ? this._datasetDiagEffectiveRegMode(data) : this.datasetDiagRegMode;

      let html = '<div class="m-dd-images-bar-left">';
      html += '<div class="m-segmented m-dd-preset-tabs" data-dd-preset-tabs role="group" aria-label="' + this.esc(t('ddPresetsLabel')) + '">';
      html += this._ddPresetTabsHtml(t, presets);
      html += '</div>';
      if (this.datasetDiagGroupFilter) {
        const gf = this.datasetDiagGroupFilter;
        html += '<button type="button" class="m-dd-filter-chip" data-dd-group-chip @click="clearDatasetDiagGroupFilter()" title="' + this.esc(t('clearHistoryFilters')) + '">'
          + '<span>' + this.esc(gf.label || gf.key) + '</span><span aria-hidden="true">×</span></button>';
      }
      html += '</div>';

      html += '<div class="m-dd-images-bar-right">';
      html += '<label class="m-output-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
        + '<input class="m-output-search-input" type="search" value="' + this.esc(this.datasetDiagSearch) + '"'
        + ' aria-label="' + this.esc(t('ddSearchImages')) + '" placeholder="' + this.esc(t('ddSearchImages')) + '"'
        + ' @input.debounce.180ms="setDatasetDiagSearch($event.target.value)"></label>';
      if (hasRegImages) {
        html += '<div class="m-dd-reg-wrap" data-dd-images-reg-wrap>'
          + this._ddSelectHtml(this._ddRegOptions(), regMode, t('ddRegFilterLabel'),
            'ddRegSelect', 'setDatasetDiagRegMode($event.target.value)', '_datasetDiagEffectiveRegMode()', '_ddRegOptions()')
          + '</div>';
      }
      html += '<div class="m-dd-sort-wrap">'
        + this._ddSelectHtml(this._ddSortOptions(), this.datasetDiagSort, t('ddSortLabel'),
          'ddSortSelect', 'setDatasetDiagSort($event.target.value)', 'datasetDiagSort', '_ddSortOptions()')
        + '</div>';
      if (canGroup) {
        const grpLabel = t('ddGroupByFolder');
        html += '<div class="m-sample-view-toggle m-dd-group-toggle" data-dd-group-toggle>'
          + '<label for="ddGroupByFolderToggle" id="ddGroupByFolderLabel">' + this.esc(grpLabel) + '</label>'
          + '<label class="toggle">'
          + '<input type="checkbox" role="switch" id="ddGroupByFolderToggle"'
          + (groupByFolder ? ' checked' : '')
          + ' :checked="datasetDiagGroupByFolder"'
          + ' aria-labelledby="ddGroupByFolderLabel"'
          + ' @change="setDatasetDiagGroupByFolder($event.target.checked)">'
          + '<span class="toggle-track"><span class="toggle-thumb"></span></span>'
          + '</label></div>';
      }
      html += '<div class="m-segmented m-dd-view-switch is-icon-only" data-dd-view-switch role="group" aria-label="' + this.esc(t('ddViewModeLabel')) + '">'
        + '<button type="button" class="m-segmented-btn' + (viewMode === 'grid' ? ' active' : '') + '" data-dd-view-btn="grid" aria-pressed="' + (viewMode === 'grid') + '" @click="setDatasetDiagViewMode(\'grid\')" title="' + this.esc(t('ddViewGrid')) + '" aria-label="' + this.esc(t('ddViewGrid')) + '">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>'
        + '<button type="button" class="m-segmented-btn' + (viewMode === 'table' ? ' active' : '') + '" data-dd-view-btn="table" aria-pressed="' + (viewMode === 'table') + '" @click="setDatasetDiagViewMode(\'table\')" title="' + this.esc(t('ddViewTable')) + '" aria-label="' + this.esc(t('ddViewTable')) + '">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button></div>';
      html += '</div>';
      return html;
    },

    _patchDatasetDiagImagesToolbar(toolbarEl, t, data) {
      if (!toolbarEl || !data) return false;
      const summary = data.summary || {};
      const hasRegImages = this._datasetDiagHasRegImages ? this._datasetDiagHasRegImages(data) : Boolean(summary.has_reg_images);
      const canGroup = !!this._datasetDiagHasMultipleFolders?.(data);
      const existingRegWrap = toolbarEl.querySelector?.('[data-dd-images-reg-wrap]');
      const existingGroupToggle = toolbarEl.querySelector?.('[data-dd-group-toggle]');
      if (Boolean(existingRegWrap) !== hasRegImages || Boolean(existingGroupToggle) !== canGroup) {
        return false;
      }

      const presets = this._ddImagesPresetSpecs(t, data);
      const tabsEl = toolbarEl.querySelector?.('[data-dd-preset-tabs]');
      if (tabsEl) {
        const btns = Array.from(tabsEl.querySelectorAll?.('[data-dd-preset-tab]') || []);
        const sameTabs = btns.length === presets.length
          && presets.every(([key], i) => btns[i]?.dataset?.ddPresetTab === key);
        if (sameTabs) {
          presets.forEach(([key, , cnt], i) => {
            const btn = btns[i];
            const active = this.datasetDiagPreset === key;
            btn.classList?.toggle?.('active', active);
            btn.classList?.toggle?.('is-empty', cnt === 0);
            btn.setAttribute?.('aria-pressed', String(active));
            const numEl = btn.querySelector?.('.m-dd-tab-n');
            const numStr = String(cnt);
            if (numEl && numEl.textContent !== numStr) numEl.textContent = numStr;
          });
        } else {
          tabsEl.innerHTML = this._ddPresetTabsHtml(t, presets);
        }
      }

      const barLeft = toolbarEl.querySelector?.('.m-dd-images-bar-left');
      if (barLeft) {
        let chip = barLeft.querySelector?.('[data-dd-group-chip]');
        const gf = this.datasetDiagGroupFilter;
        if (gf) {
          const chipLabel = String(gf.label || gf.key || '');
          if (!chip && typeof globalThis.document?.createElement === 'function') {
            const tmp = globalThis.document.createElement('div');
            tmp.innerHTML = '<button type="button" class="m-dd-filter-chip" data-dd-group-chip @click="clearDatasetDiagGroupFilter()" title="' + this.esc(t('clearHistoryFilters')) + '">'
              + '<span>' + this.esc(chipLabel) + '</span><span aria-hidden="true">×</span></button>';
            if (tmp.firstElementChild) barLeft.appendChild(tmp.firstElementChild);
          } else if (chip) {
            const span = chip.querySelector?.('span');
            if (span && span.textContent !== chipLabel) span.textContent = chipLabel;
          }
        } else if (chip) {
          chip.remove?.();
        }
      }

      const groupCb = toolbarEl.querySelector?.('#ddGroupByFolderToggle');
      if (groupCb) groupCb.checked = Boolean(canGroup && this.datasetDiagGroupByFolder);

      const viewMode = this.datasetDiagViewMode === 'table' ? 'table' : 'grid';
      toolbarEl.querySelectorAll?.('[data-dd-view-btn]')?.forEach?.(btn => {
        const active = btn.dataset?.ddViewBtn === viewMode;
        btn.classList?.toggle?.('active', active);
        btn.setAttribute?.('aria-pressed', String(active));
      });

      return true;
    },

    _ddFolderSectionHtml(t, { group, isCollapsed, visibleItems }, viewMode, maxAbs) {
      const grid = viewMode === 'grid';
      const tag = grid ? 'section' : 'div';
      const key = this.esc(group.key);
      const collapsed = isCollapsed ? ' is-collapsed' : '';
      const rows = isCollapsed ? '' : visibleItems.map(img => grid
        ? this._ddImageCardHtml(t, img) : this._ddImageTableRowHtml(t, img, maxAbs)).join('');
      return '<' + tag + ' class="' + (grid ? 'm-dd-folder-group' : 'm-dd-table-folder-section') + collapsed
        + '" ' + (grid ? 'data-dd-folder-group' : 'data-dd-table-folder-section') + '="' + key + '">'
        + '<button type="button" class="' + (grid ? 'm-dd-folder-head' : 'm-dd-table-folder-head') + collapsed
        + '" data-dd-folder-group="' + key + '" aria-expanded="' + (!isCollapsed) + '" title="' + this.esc(group.fullPath)
        + '" @click="toggleDatasetDiagFolderCollapsed(\'' + this.esc(this.escapeJsString(group.key)) + '\')">'
        + this._ddFolderHeadInnerHtml(t, group, isCollapsed ? null : visibleItems.length) + '</button>'
        + '<div class="m-dd-folder-body" data-dd-folder-body="' + key + '"' + (isCollapsed ? ' inert' : '') + '><div class="m-dd-folder-body-inner">'
        + (grid && !isCollapsed ? '<div class="m-dd-grid">' + rows + '</div>' : rows) + '</div></div></' + tag + '>';
    },

    _renderDatasetDiagImagesBodyHtml(t, data) {
      const filtered = this._datasetDiagFilteredImages();
      if (!filtered.length) {
        return '<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('ddNoMatchingImages')) + '</p>'
          + (this._datasetDiagHasActiveFilter?.()
            ? '<button type="button" class="btn btn-sm btn-secondary" @click="resetDatasetDiagFilters()">' + this.esc(t('clearHistoryFilters')) + '</button>'
            : '')
          + '</div>';
      }

      const limit = this.datasetDiagDisplayLimit || 120;
      const viewMode = this.datasetDiagViewMode === 'table' ? 'table' : 'grid';
      const canGroup = !!this._datasetDiagHasMultipleFolders?.(data);
      const groupByFolder = Boolean(canGroup && this.datasetDiagGroupByFolder);
      const maxAbs = filtered.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0)), 0.55);

      let html = '';
      let hasMore = false;
      let remaining = 0;

      if (groupByFolder) {
        const grouped = this._ddComputeGroupedSlices(filtered, limit);
        const slices = grouped.slices;
        hasMore = grouped.hasMore;
        remaining = grouped.remaining;

        if (viewMode === 'grid') {
          html += '<div class="m-dd-folder-groups">';
          html += slices.map(slice => this._ddFolderSectionHtml(t, slice, viewMode, maxAbs)).join('');
          html += '</div>';
        } else {
          html += '<div class="m-dd-table-wrap"><div class="output-list output-table m-dd-table" data-dd-max-abs="' + maxAbs + '">';
          html += '<div class="output-table-head">'
            + this._ddSortColHtml(t, 'name', 'name_desc', 'name_asc', t('ddColImage'))
            + '<span>' + this.esc(t('ddDimResolution')) + '</span>'
            + this._ddSortColHtml(t, 'count', 'count_desc', 'count_asc', t('ddColCountEpochs'), true)
            + this._ddSortColHtml(t, 'loss', 'loss_desc', 'loss_asc', t('ddColMeanLoss'), true)
            + '<span class="m-dd-res-head">' + this._ddSortColHtml(t, 'residual', 'residual_desc', 'residual_asc', t('ddColRelative'), true) + '</span>'
            + this._ddSortColHtml(t, 'slope', 'slope_desc', 'slope_asc', t('ddColSlope'), true)
            + '<span>' + this.esc(t('ddColStatus')) + '</span></div>';
          html += slices.map(slice => this._ddFolderSectionHtml(t, slice, viewMode, maxAbs)).join('');
          html += '</div></div>';
        }
      } else {
        const visible = filtered.slice(0, limit);
        hasMore = filtered.length > visible.length;
        remaining = filtered.length - visible.length;

        if (viewMode === 'grid') {
          html += '<div class="m-dd-grid">' + visible.map(img => this._ddImageCardHtml(t, img)).join('') + '</div>';
        } else {
          html += '<div class="m-dd-table-wrap"><div class="output-list output-table m-dd-table" data-dd-max-abs="' + maxAbs + '">';
          html += '<div class="output-table-head">'
            + this._ddSortColHtml(t, 'name', 'name_desc', 'name_asc', t('ddColImage'))
            + '<span>' + this.esc(t('ddDimResolution')) + '</span>'
            + this._ddSortColHtml(t, 'count', 'count_desc', 'count_asc', t('ddColCountEpochs'), true)
            + this._ddSortColHtml(t, 'loss', 'loss_desc', 'loss_asc', t('ddColMeanLoss'), true)
            + '<span class="m-dd-res-head">' + this._ddSortColHtml(t, 'residual', 'residual_desc', 'residual_asc', t('ddColRelative'), true) + '</span>'
            + this._ddSortColHtml(t, 'slope', 'slope_desc', 'slope_asc', t('ddColSlope'), true)
            + '<span>' + this.esc(t('ddColStatus')) + '</span></div>';
          html += visible.map(img => this._ddImageTableRowHtml(t, img, maxAbs)).join('');
          html += '</div></div>';
        }
      }

      html += '<div class="m-dd-more-row" data-dd-more-row' + (hasMore ? '' : ' hidden') + '><button type="button" class="btn btn-sm btn-secondary" @click="showMoreDatasetDiagImages()">'
        + this.esc(t('ddShowMore').replace('{n}', remaining)) + '</button></div>';
      return html;
    },

    _appendDatasetDiagImagesPage(bodyEl, t, data, prevLimit) {
      if (!bodyEl || !data) return false;
      const filtered = this._datasetDiagFilteredImages();
      if (!filtered.length) return false;
      const nextLimit = this.datasetDiagDisplayLimit || 120;
      const prev = Math.max(0, Number(prevLimit) || 0);
      if (nextLimit <= prev) return false;

      const viewMode = this.datasetDiagViewMode === 'table' ? 'table' : 'grid';
      const canGroup = !!this._datasetDiagHasMultipleFolders?.(data);
      const groupByFolder = Boolean(canGroup && this.datasetDiagGroupByFolder);
      const maxAbs = filtered.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0)), 0.55);

      const appendMarkup = (host, markup) => {
        if (!host || !markup) return true;
        if (typeof host.insertAdjacentHTML === 'function') {
          host.insertAdjacentHTML('beforeend', markup);
          return true;
        }
        return false;
      };

      let hasMore = false;
      let remaining = 0;

      if (groupByFolder) {
        const { slices, hasMore: more, remaining: rem } = this._ddComputeGroupedSlices(filtered, nextLimit);
        hasMore = more;
        remaining = rem;
        const secNodes = Array.from(bodyEl.querySelectorAll?.(
          viewMode === 'grid' ? '.m-dd-folder-group' : '.m-dd-table-folder-section'
        ) || []);
        if (secNodes.length !== slices.length) return false;
        const secByKey = new Map();
        for (const sec of secNodes) {
          const k = viewMode === 'grid'
            ? sec.dataset?.ddFolderGroup
            : (sec.querySelector?.('.m-dd-table-folder-head')?.dataset?.ddFolderGroup || sec.dataset?.ddTableFolderSection);
          if (k) secByKey.set(k, sec);
        }
        for (const s of slices) {
          const sec = secByKey.get(s.group.key);
          if (!sec) return false;
          if (s.isCollapsed) continue;
          const headBtn = sec.querySelector?.(viewMode === 'grid' ? '.m-dd-folder-head' : '.m-dd-table-folder-head');
          const countEl = headBtn?.querySelector?.('.m-dd-folder-count');
          if (countEl) {
            const nextCount = (s.visibleItems.length > 0 && s.visibleItems.length < s.group.totalCount)
              ? (s.visibleItems.length + ' / ' + s.group.totalCount)
              : t('ddGroupCountShort').replace('{n}', s.group.totalCount);
            if (countEl.textContent !== nextCount) countEl.textContent = nextCount;
          }
          const inner = sec.querySelector?.('.m-dd-folder-body-inner');
          if (!inner) return false;
          const existingNodes = Array.from(inner.querySelectorAll?.(viewMode === 'grid' ? '.m-dd-card' : '.m-dd-table-row') || []);
          if (existingNodes.length >= s.visibleItems.length) continue;
          const added = s.visibleItems.slice(existingNodes.length);
          if (existingNodes.length === 0) {
            inner.innerHTML = viewMode === 'grid'
              ? '<div class="m-dd-grid">' + added.map(img => this._ddImageCardHtml(t, img)).join('') + '</div>'
              : added.map(img => this._ddImageTableRowHtml(t, img, maxAbs)).join('');
          } else {
            const container = viewMode === 'grid' ? inner.querySelector?.('.m-dd-grid') : inner;
            const markup = added.map(img => viewMode === 'grid'
              ? this._ddImageCardHtml(t, img)
              : this._ddImageTableRowHtml(t, img, maxAbs)).join('');
            if (!appendMarkup(container, markup)) return false;
          }
        }
      } else {
        const added = filtered.slice(prev, nextLimit);
        hasMore = filtered.length > nextLimit;
        remaining = filtered.length - nextLimit;
        if (added.length) {
          const container = bodyEl.querySelector?.(viewMode === 'grid' ? '.m-dd-grid' : '.m-dd-table');
          if (!container) return false;
          const markup = added.map(img => viewMode === 'grid'
            ? this._ddImageCardHtml(t, img)
            : this._ddImageTableRowHtml(t, img, maxAbs)).join('');
          if (!appendMarkup(container, markup)) return false;
        }
      }

      const moreRow = bodyEl.querySelector?.('[data-dd-more-row]');
      if (hasMore) {
        if (moreRow) {
          moreRow.hidden = false;
          const btn = moreRow.querySelector?.('button');
          const txt = t('ddShowMore').replace('{n}', remaining);
          if (btn && btn.textContent !== txt) btn.textContent = txt;
        }
      } else if (moreRow) {
        moreRow.hidden = true;
      }
      return true;
    },

    _ddSetStatusToneClass(el, baseClass, tone) {
      if (!el) return;
      if (el.classList?.toggle) {
        for (const candidate of ['danger', 'warn', 'info', 'muted', 'neutral']) {
          el.classList.toggle('is-' + candidate, candidate === tone);
        }
        return;
      }
      const nextClass = baseClass + ' is-' + tone;
      if (el.className !== nextClass) el.className = nextClass;
    },

    _ddPatchCardMedia(mediaEl, img, isTable, t) {
      if (!mediaEl) return;
      const imgEl = mediaEl.querySelector?.('img');
      if (img.thumb_url) {
        if (imgEl) {
          const curSrc = typeof imgEl.getAttribute === 'function' ? imgEl.getAttribute('src') : imgEl.src;
          if (curSrc !== img.thumb_url) {
            if (typeof imgEl.setAttribute === 'function') imgEl.setAttribute('src', img.thumb_url);
            else imgEl.src = img.thumb_url;
          }
          if (!isTable) {
            const nextAlt = String(img.name || '');
            const curAlt = typeof imgEl.getAttribute === 'function' ? imgEl.getAttribute('alt') : imgEl.alt;
            if (curAlt !== nextAlt) {
              if (typeof imgEl.setAttribute === 'function') imgEl.setAttribute('alt', nextAlt);
              else imgEl.alt = nextAlt;
            }
          }
        } else {
          const altAttr = isTable ? '' : this.esc(img.name);
          mediaEl.innerHTML = '<img src="' + this.esc(img.thumb_url) + '" alt="' + altAttr + '" loading="lazy" decoding="async"/>';
        }
        return;
      }
      if (isTable) {
        if (imgEl || !mediaEl.querySelector?.('svg')) {
          mediaEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>';
        }
      } else if (imgEl || !mediaEl.querySelector?.('.m-dd-media-placeholder')) {
        mediaEl.innerHTML = '<div class="m-dd-media-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg><span>' + this.esc(t('ddLocalMissingShort')) + '</span></div>';
      }
    },

    _ddSyncRegBadge(hostEl, wantReg, className, labelText) {
      if (!hostEl) return true;
      const existing = hostEl.querySelector?.(className === 'output-dir-tag' ? '.output-dir-tag' : '.m-dd-card-reg');
      if (wantReg) {
        if (existing) {
          if (existing.textContent !== labelText) existing.textContent = labelText;
          return true;
        }
        const doc = globalThis.document;
        if (typeof doc?.createElement !== 'function' || typeof hostEl.appendChild !== 'function') return false;
        const badge = doc.createElement('small');
        badge.className = className;
        badge.textContent = labelText;
        hostEl.appendChild(badge);
        return true;
      }
      if (existing) {
        if (typeof existing.remove === 'function') existing.remove();
        else if (existing.parentNode && typeof existing.parentNode.removeChild === 'function') existing.parentNode.removeChild(existing);
        else return false;
      }
      return true;
    },

    _ddPatchImageCard(card, t, img) {
      this._ddPatchCardMedia(card.querySelector?.('.m-dd-card-media'), img, false, t);

      const resText = this._ddFormatResidual(img.mean_residual);
      const color = this._ddResidualColor(img.mean_residual);
      const resEl = card.querySelector?.('.m-dd-card-res b');
      if (resEl) {
        if (resEl.textContent !== resText) resEl.textContent = resText;
        if (resEl.style && resEl.style.color !== color) resEl.style.color = color;
      }

      const slopeColor = this._ddSlopeColor(img.slope, img.converging_slope);
      const slopeText = img.slope != null ? (this._ddFormatSlope(img.slope) + t('ddSlopeUnit')) : '—';
      const slopeEl = card.querySelector?.('.m-dd-card-slope b');
      if (slopeEl) {
        if (slopeEl.textContent !== slopeText) slopeEl.textContent = slopeText;
        if (slopeEl.style && slopeEl.style.color !== slopeColor) slopeEl.style.color = slopeColor;
      }

      const resoText = this._ddFormatResolution(img.resolution);
      const countReso = t('ddCardCountReso').replace('{n}', img.count).replace('{reso}', resoText);
      const resoEl = card.querySelector?.('.m-dd-card-reso');
      if (resoEl) {
        if (resoEl.textContent !== countReso) resoEl.textContent = countReso;
        const curTitle = typeof resoEl.getAttribute === 'function' ? resoEl.getAttribute('title') : resoEl.title;
        if (curTitle !== countReso) {
          if (typeof resoEl.setAttribute === 'function') resoEl.setAttribute('title', countReso);
          else resoEl.title = countReso;
        }
      }

      const statusMeta = this._ddStatusMeta(t, img.status, img.slope);
      const flagEl = card.querySelector?.('.m-dd-card-flag');
      if (flagEl) {
        this._ddSetStatusToneClass(flagEl, 'm-dd-card-flag', statusMeta.tone);
        if (flagEl.textContent !== statusMeta.label) flagEl.textContent = statusMeta.label;
      }
      this._ddSyncRegBadge(card.querySelector?.('.m-dd-card-foot'), Boolean(img.is_reg), 'output-dir-tag m-dd-card-reg', t('ddRegTag'));
    },

    _ddPatchTableRowGauge(row, img, maxAbs) {
      const gaugeEl = row.querySelector?.('.m-dd-gauge');
      if (!gaugeEl) return;
      const m = this._ddGaugeMetrics(img.mean_residual, maxAbs);
      const trackEl = gaugeEl.querySelector?.('.m-gauge-track');
      const fillEl = trackEl?.querySelector?.('.m-gauge-fill') || gaugeEl.querySelector?.('.m-gauge-fill');
      if (!m.valid) {
        if (fillEl) {
          if (trackEl) trackEl.innerHTML = '<span class="m-gauge-zero" style="left:50%"></span>';
          else fillEl.remove?.();
        }
        return;
      }
      if (fillEl) {
        if (fillEl.classList?.toggle) {
          fillEl.classList.toggle('is-neg', m.isNeg);
          fillEl.classList.toggle('is-pos', !m.isNeg);
        } else {
          fillEl.className = 'm-gauge-fill ' + (m.isNeg ? 'is-neg' : 'is-pos');
        }
        const leftStr = m.left.toFixed(1) + '%';
        const widthStr = m.width.toFixed(1) + '%';
        if (fillEl.style) {
          if (fillEl.style.left !== leftStr) fillEl.style.left = leftStr;
          if (fillEl.style.width !== widthStr) fillEl.style.width = widthStr;
          if (typeof fillEl.style.setProperty === 'function') {
            fillEl.style.setProperty('--gauge-bar-color', m.color);
          } else {
            fillEl.style['--gauge-bar-color'] = m.color;
          }
        }
      } else if (trackEl) {
        trackEl.innerHTML = '<span class="m-gauge-zero" style="left:50%"></span>'
          + '<span class="m-gauge-fill ' + (m.isNeg ? 'is-neg' : 'is-pos') + '" style="left:' + m.left.toFixed(1)
          + '%;width:' + m.width.toFixed(1) + '%;--gauge-bar-color:' + m.color + '"></span>';
      }
    },

    _ddPatchImageTableRow(row, t, img, maxAbs) {
      this._ddPatchCardMedia(row.querySelector?.('.m-dd-row-thumb'), img, true, t);

      const numCols = Array.from(row.querySelectorAll?.('.m-dd-num') || []);
      const resoText = this._ddFormatResolution(img.resolution);
      if (numCols[0] && numCols[0].textContent !== resoText) numCols[0].textContent = resoText;

      const countText = img.count + ' / ' + img.epochs;
      if (numCols[1] && numCols[1].textContent !== countText) numCols[1].textContent = countText;

      const lossText = this._ddFormatLoss(img.mean_loss);
      if (numCols[2] && numCols[2].textContent !== lossText) numCols[2].textContent = lossText;

      const slopeText = this._ddFormatSlope(img.slope);
      const slopeColor = this._ddSlopeColor(img.slope, img.converging_slope);
      if (numCols[3]) {
        if (numCols[3].textContent !== slopeText) numCols[3].textContent = slopeText;
        if (numCols[3].style && numCols[3].style.color !== slopeColor) numCols[3].style.color = slopeColor;
      }

      const resText = this._ddFormatResidual(img.mean_residual);
      const color = this._ddResidualColor(img.mean_residual);
      const resValEl = row.querySelector?.('.m-dd-num-val');
      if (resValEl) {
        if (resValEl.textContent !== resText) resValEl.textContent = resText;
        if (resValEl.style && resValEl.style.color !== color) resValEl.style.color = color;
      }
      this._ddPatchTableRowGauge(row, img, maxAbs);

      const statusMeta = this._ddStatusMeta(t, img.status, img.slope);
      const pillEl = row.querySelector?.('.m-dd-pill');
      if (pillEl) {
        this._ddSetStatusToneClass(pillEl, 'm-dd-pill', statusMeta.tone);
        if (pillEl.textContent !== statusMeta.label) pillEl.textContent = statusMeta.label;
      }
      this._ddSyncRegBadge(row.querySelector?.('.m-dd-row-sub'), Boolean(img.is_reg), 'output-dir-tag', t('ddRegTag'));
    },

    _ddPatchFolderHead(headBtn, t, group, shownCount) {
      const countEl = headBtn.querySelector?.('.m-dd-folder-count');
      if (countEl) {
        const nextCount = (shownCount != null && shownCount > 0 && shownCount < group.totalCount)
          ? (shownCount + ' / ' + group.totalCount)
          : t('ddGroupCountShort').replace('{n}', group.totalCount);
        if (countEl.textContent !== nextCount) countEl.textContent = nextCount;
      }
      if (group.meanResidual != null) {
        const resEl = headBtn.querySelector?.('.m-dd-folder-res');
        if (resEl) {
          const resText = t('ddCardResidual') + ' ' + this._ddFormatResidual(group.meanResidual);
          const resColor = this._ddResidualColor(group.meanResidual, { scale: 'group' });
          if (resEl.textContent !== resText) resEl.textContent = resText;
          if (resEl.style && resEl.style.color !== resColor) resEl.style.color = resColor;
        }
      }
    },

    _patchDatasetDiagImagesInPlace(bodyEl, t, data) {
      if (!bodyEl || !data) return false;
      const filtered = this._datasetDiagFilteredImages();
      if (!filtered.length) return false;

      const limit = this.datasetDiagDisplayLimit || 120;
      const viewMode = this.datasetDiagViewMode === 'table' ? 'table' : 'grid';
      const canGroup = !!this._datasetDiagHasMultipleFolders?.(data);
      const groupByFolder = Boolean(canGroup && this.datasetDiagGroupByFolder);
      const maxAbs = filtered.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0)), 0.55);
      const itemSelector = viewMode === 'grid' ? '.m-dd-card' : '.m-dd-table-row';
      const tableEl = viewMode === 'table' ? bodyEl.querySelector?.('.m-dd-table') : null;
      const gridEl = viewMode === 'grid' ? bodyEl.querySelector?.('.m-dd-grid') : null;
      if (viewMode === 'table' && (!tableEl || bodyEl.querySelector?.('.m-dd-grid'))) return false;
      if (viewMode === 'grid' && ((!gridEl && !groupByFolder) || bodyEl.querySelector?.('.m-dd-table'))) return false;

      let hasMore = false;
      let remaining = 0;
      let groupPlan = null;
      let flatNodes = null;
      let flatItems = null;
      const placeBefore = (host, node, anchor) => {
        if (node.nextElementSibling === anchor) return;
        if (host.moveBefore) host.moveBefore(node, anchor);
        else {
          const focus = document.activeElement;
          host.insertBefore(node, anchor);
          if (node.contains(focus)) focus.focus({ preventScroll: true });
        }
      };

      if (groupByFolder) {
        const grouped = this._ddComputeGroupedSlices(filtered, limit);
        const slices = grouped.slices;
        hasMore = grouped.hasMore;
        remaining = grouped.remaining;
        if (viewMode === 'grid' && !bodyEl.querySelector?.('.m-dd-folder-groups')) return false;
        const secNodes = Array.from(bodyEl.querySelectorAll?.(
          viewMode === 'grid' ? '.m-dd-folder-group' : '.m-dd-table-folder-section'
        ) || []);
        const foldersHost = viewMode === 'grid' ? bodyEl.querySelector('.m-dd-folder-groups') : tableEl;
        if (!foldersHost || !slices.length) return false;
        if (viewMode === 'table' && !secNodes.length && tableEl.querySelector('.m-dd-table-row')) return false;
        const byKey = new Map(secNodes.map(sec => [sec.dataset.ddFolderGroup || sec.dataset.ddTableFolderSection, sec]));
        groupPlan = [];
        let nextFolder = null;
        for (let i = slices.length - 1; i >= 0; i--) {
          const s = slices[i];
          let sec = byKey.get(s.group.key);
          if (!sec) {
            foldersHost.insertAdjacentHTML('beforeend', this._ddFolderSectionHtml(t, s, viewMode, maxAbs));
            sec = foldersHost.lastElementChild;
          }
          byKey.delete(s.group.key);
          placeBefore(foldersHost, sec, nextFolder);
          nextFolder = sec;
          const headBtn = sec.querySelector?.(viewMode === 'grid' ? '.m-dd-folder-head' : '.m-dd-table-folder-head');
          const folderBody = sec.querySelector?.('[data-dd-folder-body]');
          const inner = folderBody?.querySelector?.('.m-dd-folder-body-inner');
          if (!headBtn || !folderBody || !inner) return false;

          const domCollapsed = Boolean(
            sec.classList?.contains?.('is-collapsed')
            || folderBody.inert
            || folderBody.hasAttribute?.('inert')
          );
          if (domCollapsed !== s.isCollapsed) return false;
          if (Boolean(headBtn.querySelector?.('.m-dd-folder-res')) !== (s.group.meanResidual != null)
              || Boolean(headBtn.querySelector?.('.m-dd-folder-reg')) !== Boolean(s.group.isReg)) {
            headBtn.innerHTML = this._ddFolderHeadInnerHtml(t, s.group, s.isCollapsed ? null : s.visibleItems.length);
          }

          const nodes = Array.from(inner.querySelectorAll?.(itemSelector) || []);
          if (!s.isCollapsed) {
            if (viewMode === 'grid' && s.visibleItems.length > 0 && !inner.querySelector?.('.m-dd-grid')) return false;
          }
          groupPlan.push({ s, headBtn, inner, nodes });
        }
        for (const removed of byKey.values()) removed.remove();
      } else {
        if (bodyEl.querySelector?.('.m-dd-folder-group, .m-dd-table-folder-section')) return false;
        flatItems = filtered.slice(0, limit);
        hasMore = filtered.length > flatItems.length;
        remaining = filtered.length - flatItems.length;
        const container = viewMode === 'grid' ? gridEl : tableEl;
        if (!container) return false;
        flatNodes = Array.from(container.querySelectorAll?.(itemSelector) || []);
      }

      const moreRow = bodyEl.querySelector?.('[data-dd-more-row]');
      const moreBtn = hasMore ? moreRow?.querySelector?.('button') : null;
      if (hasMore && !moreBtn) return false;
      if (moreRow) moreRow.hidden = !hasMore;

      if (hasMore && moreBtn) {
        const nextMoreText = t('ddShowMore').replace('{n}', remaining);
        if (moreBtn.textContent !== nextMoreText) moreBtn.textContent = nextMoreText;
      }

      const patchPairList = (host, nodes, items) => {
        const byId = new Map(nodes.map(node => [node.dataset.ddImageId, node]));
        let next = null;
        for (let i = items.length - 1; i >= 0; i--) {
          const img = items[i];
          let node = byId.get(img.image_id);
          if (!node) {
            const markup = viewMode === 'grid' ? this._ddImageCardHtml(t, img) : this._ddImageTableRowHtml(t, img, maxAbs);
            host.insertAdjacentHTML('beforeend', markup);
            node = host.lastElementChild;
          }
          byId.delete(img.image_id);
          placeBefore(host, node, next);
          next = node;
          const sig = this._ddImagePatchSig(img, viewMode, maxAbs);
          const prevSig = node._ddPatchSig ?? node.dataset?.ddSig;
          if (prevSig === sig) continue;
          if (viewMode === 'grid') this._ddPatchImageCard(node, t, img);
          else this._ddPatchImageTableRow(node, t, img, maxAbs);
          node._ddPatchSig = sig;
          if (node.dataset) node.dataset.ddSig = sig;
        }
        for (const removed of byId.values()) removed.remove();
      };

      if (groupPlan) {
        for (const entry of groupPlan) {
          this._ddPatchFolderHead(entry.headBtn, t, entry.s.group, entry.s.isCollapsed ? null : entry.s.visibleItems.length);
          if (entry.s.isCollapsed) {
            // 折叠前曾展开的分组仍残留旧 DOM，清空可防止下次展开时命中旧指标。
            if (entry.nodes.length > 0) entry.inner.innerHTML = '';
          } else {
            const host = viewMode === 'grid' ? entry.inner.querySelector('.m-dd-grid') : entry.inner;
            if (host) patchPairList(host, entry.nodes, entry.s.visibleItems);
          }
        }
      } else {
        patchPairList(gridEl || tableEl, flatNodes, flatItems);
      }

      bodyEl._ddLastMaxAbs = maxAbs;
      if (tableEl?.dataset) tableEl.dataset.ddMaxAbs = String(maxAbs);
      return true;
    },

    _clearDatasetDiagImagesMarquee(imagesBody) {
      const cur = imagesBody?._ddActiveMarquee;
      if (!cur) return;
      imagesBody._ddActiveMarquee = null;
      try { cur.destroy?.(); } catch (_) {}
      cur.nameEl?.classList?.remove?.('loop-marquee');
      cur.sourceEl?.classList?.remove?.('loop-marquee-text');
    },

    _bindDatasetDiagImagesBodyEvents(imagesBody) {
      if (!imagesBody || imagesBody._ddEventsBound || typeof imagesBody.addEventListener !== 'function') return;
      imagesBody._ddEventsBound = true;

      const interactiveChild = (target, card) => {
        const hit = target?.closest?.('button, a, input, select, textarea, [contenteditable="true"], [role="button"]');
        return Boolean(hit && hit !== card && card.contains?.(hit));
      };

      imagesBody.addEventListener('click', event => {
        if (event.defaultPrevented) return;
        const card = event.target?.closest?.('.m-dd-card[data-dd-image-id], .m-dd-table-row[data-dd-image-id]');
        if (!card || (typeof imagesBody.contains === 'function' && !imagesBody.contains(card))) return;
        if (interactiveChild(event.target, card)) return;
        const imageId = card.dataset?.ddImageId;
        if (imageId) this.openDatasetDiagModal(imageId, card);
      });

      imagesBody.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target?.closest?.('.m-dd-card[data-dd-image-id], .m-dd-table-row[data-dd-image-id]');
        if (!card || (typeof imagesBody.contains === 'function' && !imagesBody.contains(card))) return;
        if (interactiveChild(event.target, card)) return;
        event.preventDefault?.();
        const imageId = card.dataset?.ddImageId;
        if (imageId) this.openDatasetDiagModal(imageId, card);
      });

      const activateMarquee = target => {
        const card = target?.closest?.('.m-dd-card, .m-dd-table-row');
        if (!card || (typeof imagesBody.contains === 'function' && !imagesBody.contains(card))) return;
        const cur = imagesBody._ddActiveMarquee;
        if (cur?.card === card) return;
        this._clearDatasetDiagImagesMarquee(imagesBody);
        if (typeof globalThis.window?.initLoopMarquee !== 'function') return;
        const nameEl = card.querySelector?.('.m-dd-card-name, .m-dd-row-name strong');
        const sourceEl = nameEl?.firstElementChild;
        if (!nameEl || !sourceEl) return;
        if (!(nameEl.clientWidth > 0 && nameEl.scrollWidth > nameEl.clientWidth)) return;
        const destroy = globalThis.window.initLoopMarquee(nameEl, sourceEl, { bounce: true });
        imagesBody._ddActiveMarquee = { card, nameEl, sourceEl, destroy };
      };

      const deactivateMarquee = (target, relatedTarget, isFocusLeave) => {
        const card = target?.closest?.('.m-dd-card, .m-dd-table-row');
        if (!card) return;
        if (relatedTarget && card.contains?.(relatedTarget)) return;
        const cur = imagesBody._ddActiveMarquee;
        if (!cur || cur.card !== card) return;
        if (isFocusLeave) {
          if (card.matches?.(':hover')) return;
        } else {
          const activeEl = globalThis.document?.activeElement;
          if (activeEl && card.contains?.(activeEl)) return;
        }
        this._clearDatasetDiagImagesMarquee(imagesBody);
      };

      imagesBody.addEventListener('pointerover', event => activateMarquee(event.target));
      imagesBody.addEventListener('focusin', event => activateMarquee(event.target));
      imagesBody.addEventListener('pointerout', event => deactivateMarquee(event.target, event.relatedTarget, false));
      imagesBody.addEventListener('focusout', event => deactivateMarquee(event.target, event.relatedTarget, true));
    },

    _renderDatasetDiagImagesCard(t, data) {
      let html = '<section id="datasetDiagImagesSection" class="m-dd-images is-frameless">';
      html += '<div class="m-dd-images-bar" data-dd-images-toolbar>' + this._renderDatasetDiagImagesToolbar(t, data) + '</div>';
      html += '<div class="m-dd-images-body" data-dd-images-body>' + this._renderDatasetDiagImagesBodyHtml(t, data) + '</div>';
      html += '</section>';
      return html;
    },

    // ═══════════════════════════════════════════════════════════════════════════
    //  Detail Modal (<dialog id="datasetDiagModal">)
    // ═══════════════════════════════════════════════════════════════════════════
    _datasetDiagModalHtml(t) {
      const svg = path => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
      const left = svg('<path d="m15 18-6-6 6-6"/>');
      const right = svg('<path d="m9 18 6-6-6-6"/>');
      const zoomOut = svg('<circle cx="11" cy="11" r="7"/><path d="M8 11h6m3 6 4 4"/>');
      const zoomIn = svg('<circle cx="11" cy="11" r="7"/><path d="M8 11h6m-3-3v6m6 3 4 4"/>');
      const close = svg('<path d="M6 6l12 12M18 6 6 18"/>');

      return '<dialog id="datasetDiagModal" class="modal-overlay m-dd-modal"'
        + ' x-dialog="datasetDiagModalOpen" @click.self="closeDatasetDiagModal()"'
        + ' @dialog-close="closeDatasetDiagModal()" @dialog-after-close="clearDatasetDiagModal()"'
        + ' @keydown="datasetDiagModalKeydown($event)" aria-labelledby="datasetDiagModalTitle" x-cloak>'
        + '<div class="modal m-dd-modal-window" tabindex="-1" data-dialog-autofocus>'
        + '<div class="modal-header m-dd-modal-header">'
        + '<div class="m-dd-modal-heading">'
        + '<strong id="datasetDiagModalTitle" class="m-dd-modal-title" x-loop-marquee.bounce><span data-dd-modal-title-text></span></strong>'
        + '<span id="datasetDiagModalBadge" class="m-dd-pill"></span>'
        + '<div id="datasetDiagModalSub" class="m-dd-modal-sub"></div>'
        + '</div>'
        + '<div class="m-dd-modal-tools">'
        + '<div class="preview-lightbox-navigation">'
        + '<button type="button" id="ddModalPrev" class="btn-icon preview-lightbox-nav prev" @click="datasetDiagModalNav(-1)" title="' + this.esc(this.t('imageViewer.previousHint')) + '" aria-label="' + this.esc(t('prev')) + '" aria-keyshortcuts="ArrowLeft">' + left + '</button>'
        + '<span id="datasetDiagModalCounter" class="preview-lightbox-counter m-dd-modal-counter">'
        + '<span class="preview-lightbox-counter-current">'
        + '<button type="button" id="ddModalCounterDisplay" class="preview-lightbox-counter-display" x-show="!datasetDiagPageEditing" @click="openDatasetDiagPageEditor()" aria-label="' + this.esc(t('previewPageNumber')) + '">0</button>'
        + '<input id="ddModalPageInput" class="preview-lightbox-page" x-show="datasetDiagPageEditing" x-cloak type="text" inputmode="numeric" autocomplete="off" spellcheck="false" aria-label="' + this.esc(t('previewPageNumber')) + '" aria-describedby="ddModalCounterTotal" @input="updateDatasetDiagPageDraft($event)" @compositionend="updateDatasetDiagPageDraft($event)" @blur="commitDatasetDiagPageEdit($event)" @keydown="datasetDiagPageKeydown($event)">'
        + '</span>'
        + '<span class="preview-lightbox-counter-divider" aria-hidden="true">/</span>'
        + '<span id="ddModalCounterTotal" class="preview-lightbox-counter-total">0</span>'
        + '</span>'
        + '<button type="button" id="ddModalNext" class="btn-icon preview-lightbox-nav next" @click="datasetDiagModalNav(1)" title="' + this.esc(this.t('imageViewer.nextHint')) + '" aria-label="' + this.esc(t('next')) + '" aria-keyshortcuts="ArrowRight">' + right + '</button>'
        + '</div>'
        + '<span class="m-dd-tools-sep" aria-hidden="true"></span>'
        + '<div class="preview-lightbox-zoom">'
        + '<button type="button" class="btn-icon preview-icon-button" @click="datasetDiagViewport.zoomBy(1 / 1.18, $event)" :disabled="datasetDiagViewport.scale <= 1" title="' + this.esc(t('ddZoomOutShortcut')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomOut')) + '" aria-keyshortcuts="-">' + zoomOut + '</button>'
        + '<button type="button" class="preview-zoom-value" @click="datasetDiagViewport.reset(true)" title="' + this.esc(this.t('imageViewer.zoomHint') + ' · ' + t('ddDoubleClickZoomHint')) + '" aria-keyshortcuts="0" x-text="datasetDiagZoomLabel()">' + this.esc(this.t('imageViewer.fit')) + '</button>'
        + '<button type="button" class="btn-icon preview-icon-button" @click="datasetDiagViewport.zoomBy(1.18, $event)" :disabled="datasetDiagViewport.scale >= 8" title="' + this.esc(t('ddZoomInShortcut')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomIn')) + '" aria-keyshortcuts="+">' + zoomIn + '</button>'
        + '</div>'
        + '<span class="m-dd-tools-sep" aria-hidden="true"></span>'
        + '<button type="button" class="btn-icon preview-icon-button preview-close" @click="closeDatasetDiagModal()" title="' + this.esc(this.t('imageViewer.closeHint')) + '" aria-label="' + this.esc(t('close')) + '" aria-keyshortcuts="Escape">' + close + '</button>'
        + '</div></div>'
        + '<div class="m-dd-modal-body">'
        + '<div class="m-dd-modal-left">'
        + '<div id="datasetDiagModalStage" class="m-dd-modal-stage" tabindex="-1" :class="{zoomed: datasetDiagViewport.scale > 1, panning: datasetDiagViewport.panning, \'is-zoom-animating\': datasetDiagViewport.animating}"'
        + ' @wheel="datasetDiagViewport.zoom($event)" @pointerdown="datasetDiagViewport.startPan($event)" @pointermove="datasetDiagViewport.movePan($event)"'
        + ' @pointerup="datasetDiagViewport.stopPan($event)" @pointercancel="datasetDiagViewport.stopPan($event)" @lostpointercapture="datasetDiagViewport.stopPan($event)"'
        + ' @dblclick="datasetDiagViewport.doubleClickZoom($event)" @resize.window="datasetDiagViewport.constrain($event)" @dragstart.prevent>'
        + '<img id="datasetDiagModalImg" class="m-dd-modal-img" alt="" :style="\'transform:\' + datasetDiagViewport.transform()" draggable="false" @load="datasetDiagViewport.constrain()"/>'
        + '<div id="datasetDiagModalMissing" class="m-dd-modal-missing" hidden>'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>'
        + '<p>' + this.esc(t('ddModalImageMissing')) + '</p></div>'
        + '<button type="button" id="ddModalSidePrev" class="m-sample-sidebar-side-nav prev m-dd-modal-side-nav" :class="{\'is-zoom-hidden\': datasetDiagViewport.scale > 1}" :disabled="datasetDiagViewport.scale > 1" @pointerdown.stop @click.stop="datasetDiagModalNav(-1)" title="' + this.esc(this.t('imageViewer.previousHint')) + '" aria-label="' + this.esc(t('prev')) + '"><span>' + left + '</span></button>'
        + '<button type="button" id="ddModalSideNext" class="m-sample-sidebar-side-nav next m-dd-modal-side-nav" :class="{\'is-zoom-hidden\': datasetDiagViewport.scale > 1}" :disabled="datasetDiagViewport.scale > 1" @pointerdown.stop @click.stop="datasetDiagModalNav(1)" title="' + this.esc(this.t('imageViewer.nextHint')) + '" aria-label="' + this.esc(t('next')) + '"><span>' + right + '</span></button>'
        + '</div>'
        + '<div id="datasetDiagModalFoot" class="m-dd-modal-foot"></div>'
        + '</div>'
        + '<div id="datasetDiagModalRight" class="m-dd-modal-right"></div>'
        + '</div></div></dialog>'
        + '<dialog id="datasetDiagSamplesModal" class="modal-overlay m-dd-samples-modal"'
        + ' x-dialog="datasetDiagSamplesModalOpen" @click.self.stop="closeDatasetDiagSamplesModal()"'
        + ' @dialog-close.stop="closeDatasetDiagSamplesModal()" @dialog-after-close.stop="closeDatasetDiagSamplesModal()"'
        + ' @keydown.stop aria-labelledby="datasetDiagSamplesTitle" x-cloak>'
        + '<div class="modal m-dd-samples-window" tabindex="-1" data-dialog-autofocus>'
        + '<div class="modal-header m-dd-samples-header">'
        + '<div class="m-dd-samples-heading">'
        + '<strong id="datasetDiagSamplesTitle" class="m-dd-samples-title"></strong>'
        + '<span id="datasetDiagSamplesMeta" class="m-dd-samples-meta"></span>'
        + '</div>'
        + '<div class="m-dd-samples-tools">'
        + '<div id="datasetDiagSamplesFilter" class="m-dd-samples-filter m-segmented" hidden></div>'
        + '<span id="datasetDiagSamplesSep" class="m-dd-tools-sep" hidden aria-hidden="true"></span>'
        + '<button type="button" class="btn-icon preview-icon-button preview-close" @click="closeDatasetDiagSamplesModal()"'
        + ' title="' + this.esc(this.t('imageViewer.closeHint')) + '" aria-label="' + this.esc(t('close')) + '" aria-keyshortcuts="Escape">' + close + '</button>'
        + '</div></div>'
        + '<div id="datasetDiagSamplesBody" class="m-dd-samples-body"></div>'
        + '</div></dialog>';
    },

    _syncDatasetDiagImageStyle() {
      const img = document.getElementById('datasetDiagModalImg');
      if (img && this.datasetDiagViewport) {
        img.style.transform = this.datasetDiagViewport.transform();
      }
    },

    _ddComputeBucketDiff(origW, origH, resoStr, t) {
      const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(resoStr || '').trim());
      if (!m || !(origW > 0) || !(origH > 0)) return null;
      const bw = Number(m[1]), bh = Number(m[2]);
      if (!(bw > 0) || !(bh > 0)) return null;
      const scale = Math.max(bw / origW, bh / origH);
      const resizedW = origW * scale;
      const resizedH = origH * scale;
      const cropFraction = Math.max(0, 1 - (bw * bh) / Math.max(1, resizedW * resizedH));
      const cropPct = Math.round(cropFraction * 100);
      let diffText = '';
      let warn = false;
      if (cropPct >= 1) {
        diffText = t('ddBucketCrop').replace('{pct}', cropPct);
        warn = cropPct >= 5;
      } else if (scale > 1.05) {
        diffText = t('ddBucketUpscale').replace('{scale}', scale.toFixed(2));
        warn = scale >= 1.25;
      } else if (origW === bw && origH === bh) {
        diffText = t('ddBucketMatch');
      }
      return { bw, bh, scale, cropPct, diffText, warn };
    },

    _ddModalKpiHtml(t, img, detail = null) {
      const resColor = this._ddResidualColor(img.mean_residual);
      const slopeColor = this._ddSlopeColor(img.slope, img.converging_slope);
      const totalSamples = detail?.samples_total != null
        ? Number(detail.samples_total)
        : ((Number(img.count) || 0) + (Number(img.non_finite_count) || 0));
      const nfCount = Number(img.non_finite_count || 0);
      const epochsCov = Number(img.epochs || 0);
      const slopeMain = img.slope != null ? this._ddFormatSlope(img.slope) : '—';
      const slopeSub = img.slope != null ? t('ddSlopeUnit') : t('ddSlopeNeedsEpochs');
      const samplesSub = nfCount > 0
        ? t('ddSamplesSummaryNan').replace('{epochs}', epochsCov).replace('{n}', nfCount)
        : (epochsCov === 1 ? t('ddEpochCoverageOne') : t('ddEpochCoverage')).replace('{n}', epochsCov);

      const jumpArrow = this._ddRowJumpIconHtml();
      const hasSampleRows = Boolean(detail) && (totalSamples > 0 || (detail.samples || []).length > 0);

      let html = '<div class="m-dd-modal-stats">';
      html += '<div class="m-dd-stat"><span>' + this.esc(t('ddKpiRelative')) + '</span>'
        + '<strong style="color:' + resColor + '">' + this.esc(this._ddFormatResidual(img.mean_residual)) + '</strong></div>';
      html += '<div class="m-dd-stat"><span>' + this.esc(t('ddKpiSlope')) + '</span>'
        + (img.slope != null
          ? '<strong style="color:' + slopeColor + '">' + this.esc(slopeMain) + '<small class="m-dd-stat-unit">' + this.esc(slopeSub) + '</small></strong>'
          : '<strong style="color:' + slopeColor + '">' + this.esc(slopeMain) + '</strong><span class="m-dd-stat-sub">' + this.esc(slopeSub) + '</span>')
        + '</div>';
      html += '<div class="m-dd-stat"><span>' + this.esc(t('ddKpiMeanLoss')) + '</span>'
        + '<strong>' + this.esc(this._ddFormatLoss(img.mean_loss)) + '</strong></div>';
      if (hasSampleRows) {
        html += '<button type="button" class="m-dd-stat m-dd-stat-btn" data-dd-open-samples'
          + ' aria-haspopup="dialog"'
          + ' @click="openDatasetDiagSamplesModal(\'all\')" title="' + this.esc(t('ddViewSamplesTip')) + '">'
          + '<span>' + this.esc(t('ddFiniteSamples')) + '</span>'
          + '<div class="m-dd-stat-main"><strong>' + this.esc(totalSamples) + '</strong>'
          + '<span class="m-dd-stat-link" aria-hidden="true">' + this.esc(t('ddViewSamplesShort')) + jumpArrow + '</span></div>'
          + '<span class="m-dd-stat-sub' + (nfCount > 0 ? ' is-danger' : '') + '">' + this.esc(samplesSub) + '</span>'
          + '</button>';
      } else {
        html += '<div class="m-dd-stat"><span>' + this.esc(t('ddFiniteSamples')) + '</span>'
          + '<strong>' + this.esc(totalSamples) + '</strong>'
          + '<span class="m-dd-stat-sub' + (nfCount > 0 ? ' is-danger' : '') + '">' + this.esc(samplesSub) + '</span></div>';
      }
      html += '</div>';
      if (img.comparable_count != null && img.comparable_count < img.count) {
        html += '<p class="m-dd-notice-strip">' + this.esc(t('ddComparableCount').replace('{n}', img.comparable_count).replace('{total}', img.count)) + '</p>';
      }
      return html;
    },

    _ddModalNanRowHtml(t, img, detail = null) {
      if (!((img?.non_finite_count || 0) > 0)) return '';
      const samples = detail?.samples || [];
      const nfSamples = samples.filter(s => s.non_finite);
      const firstNf = detail?.first_non_finite || nfSamples[0] || null;
      const scale = detail?.timestep_scale || this.datasetDiagData?.timestep_scale || 'thousand';
      const coordsHtml = firstNf
        ? '<span class="m-dd-nan-coords">'
          + `<span>${this.esc(t('ddEpochLabel'))} ${this.esc(firstNf.epoch ?? '?')}</span>`
          + `<span>${this.esc(t('ddStepLabel'))} ${this.esc(firstNf.step ?? '?')}</span>`
          + `<span>t = ${this.esc(this._ddFormatTimestep(firstNf.timestep, scale))}</span>`
          + '</span>'
        : '';
      const extraHtml = img.non_finite_count > 1
        ? '<span class="m-dd-nan-extra">' + this.esc(t('ddNanTotalCount').replace('{n}', img.non_finite_count)) + '</span>'
        : '';
      const clickable = Boolean(detail);
      return '<div class="m-dd-nan-row' + (clickable ? ' is-clickable' : '') + '"'
        + (clickable ? ' role="button" tabindex="0" data-dd-nan-jump aria-haspopup="dialog" title="' + this.esc(t('ddNanJumpTip')) + '"' : '')
        + '>'
        + '<span class="m-dd-nan-label">' + this.esc(t('ddNanSampleLabel')) + '</span>'
        + '<div class="m-dd-nan-meta">' + coordsHtml + extraHtml + '</div>'
        + '</div>';
    },

    _ddGroupCtxHtml(t, detail, imgInfo) {
      if (!imgInfo) return '';
      const data = this.datasetDiagData;
      const items = [];
      const pushGroupItem = (dim, ctxLabel, row, displayVal) => {
        if (!row || row.mean_residual == null) return;
        const color = this._ddResidualColor(row.mean_residual, { scale: 'group' });
        const dimJs = this.esc(this.escapeJsString(dim));
        const keyJs = this.esc(this.escapeJsString(row.key));
        const lblJs = this.esc(this.escapeJsString(displayVal));
        items.push('<button type="button" class="m-dd-ctx-item is-link" title="' + this.esc(t('ddGroupCtxJumpTip')) + '"'
          + ' @click="jumpDatasetDiagModalToGroup(\'' + dimJs + '\', \'' + keyJs + '\', \'' + lblJs + '\')">'
          + '<span class="m-dd-ctx-k">' + this.esc(ctxLabel) + '</span>'
          + '<span class="m-dd-ctx-name">' + this.esc(displayVal) + '</span>'
          + '<b class="m-dd-ctx-val" style="color:' + color + '">' + this.esc(this._ddFormatResidual(row.mean_residual)) + '</b>'
          + '</button>');
      };

      if (data?.available) {
        const resRow = (data.by_resolution || []).find(r => r.key === imgInfo.resolution);
        if (resRow && ((data.by_resolution || []).length >= 2 || resRow.mean_residual != null)) {
          pushGroupItem('resolution', t('ddGroupCtxBucket'), resRow, this._ddFormatResolution(resRow.label || resRow.key));
        }
        const subRow = (data.by_subset || []).find(r => r.key === imgInfo.subset);
        if (subRow && imgInfo.subset && imgInfo.subset !== '(unknown)') {
          pushGroupItem('subset', t('ddGroupCtxSubset'), subRow, subRow.label || imgInfo.subset_label || subRow.key);
        }
        if (!this._ddDirectoryMatchesSubsets?.(data)) {
          const dirKey = imgInfo.directory || '(root)';
          const dirRow = (data.by_directory || []).find(r => r.key === dirKey);
          if (dirRow && (data.by_directory || []).length >= 2) {
            pushGroupItem('directory', t('ddGroupCtxDir'), dirRow, dirRow.label || dirKey);
          }
        }
      }

      const subMeta = detail?.subset_meta;
      if (subMeta && typeof subMeta === 'object') {
        if (Number(subMeta.num_repeats || 0) > 1) {
          items.push('<span class="m-dd-ctx-tag">' + this.esc(t('ddGroupRepeatPlain').replace('{n}', Number(subMeta.num_repeats))) + '</span>');
        }
        if (subMeta.loss_weight != null && Number.isFinite(Number(subMeta.loss_weight)) && Math.abs(Number(subMeta.loss_weight) - 1) > 1e-4) {
          items.push('<span class="m-dd-ctx-tag">' + this.esc(t('ddGroupWeightPlain').replace('{w}', Number(subMeta.loss_weight))) + '</span>');
        }
        const augText = this._ddGroupAugText?.(t, subMeta.aug_flags);
        if (augText) {
          items.push('<span class="m-dd-ctx-tag">' + this.esc(augText) + '</span>');
        }
      }

      if (!items.length) return '';
      return '<div class="m-dd-group-ctx">' + items.join('') + '</div>';
    },

    _patchDatasetDiagModal() {
      const dialog = document.getElementById('datasetDiagModal');
      if (!dialog) return;
      const t = k => this.tMonitor(k);

      const navList = this._datasetDiagModalNavList();
      const idx = navList.findIndex(item => item.image_id === this.datasetDiagModalImageId);
      const listImg = idx >= 0 ? navList[idx] : (this.datasetDiagData?.by_image || []).find(i => i.image_id === this.datasetDiagModalImageId);
      const detail = this.datasetDiagModalDetail;
      const imgInfo = detail?.image || listImg;

      const titleEl = document.getElementById('datasetDiagModalTitle');
      const badgeEl = document.getElementById('datasetDiagModalBadge');
      const subEl = document.getElementById('datasetDiagModalSub');
      const curEl = document.getElementById('ddModalCounterDisplay');
      const totEl = document.getElementById('ddModalCounterTotal');
      const counterEl = document.getElementById('datasetDiagModalCounter');
      const prevBtn = document.getElementById('ddModalPrev');
      const nextBtn = document.getElementById('ddModalNext');
      const sidePrev = document.getElementById('ddModalSidePrev');
      const sideNext = document.getElementById('ddModalSideNext');

      if (titleEl && imgInfo) {
        const titleTextEl = titleEl.querySelector?.('[data-dd-modal-title-text]') || titleEl;
        titleTextEl.textContent = imgInfo.name || imgInfo.image;
        titleEl.title = imgInfo.image;
      }
      if (badgeEl && imgInfo) {
        const meta = this._ddStatusMeta(t, imgInfo.status, imgInfo.slope);
        badgeEl.className = 'm-dd-pill is-' + meta.tone;
        badgeEl.textContent = meta.label;
      }
      if (subEl && imgInfo) {
        const bits = [];
        if (imgInfo.subset_label) {
          const allSubs = Array.isArray(imgInfo.subsets) ? imgInfo.subsets : [];
          const subText = allSubs.length > 1 ? `${imgInfo.subset_label} +${allSubs.length - 1}` : imgInfo.subset_label;
          bits.push('<span title="' + this.esc(imgInfo.dir_label || imgInfo.subset_label) + '">' + this.esc(subText) + '</span>');
        } else if (imgInfo.dir_label) {
          bits.push('<span>' + this.esc(imgInfo.dir_label) + '</span>');
        }
        if (imgInfo.is_reg) {
          bits.push('<small class="output-dir-tag">' + this.esc(t('ddRegTag')) + '</small>');
        }
        subEl.innerHTML = bits.join('<span class="m-dd-modal-sub-sep" aria-hidden="true">·</span>');
      }
      if (curEl && totEl) {
        curEl.textContent = idx >= 0 ? String(idx + 1) : '—';
        totEl.textContent = idx >= 0 ? String(navList.length) : '—';
        curEl.disabled = navList.length <= 1;
        if (counterEl) {
          const digits = Math.max(2, String(navList.length || 0).length);
          counterEl.style.setProperty('--preview-counter-width', `${digits * 2 + 3}ch`);
        }
      } else if (counterEl) {
        counterEl.textContent = idx >= 0 ? `${idx + 1} / ${navList.length}` : '—';
      }
      if (prevBtn) prevBtn.disabled = navList.length <= 1;
      if (nextBtn) nextBtn.disabled = navList.length <= 1;
      if (sidePrev) sidePrev.hidden = navList.length <= 1;
      if (sideNext) sideNext.hidden = navList.length <= 1;

      const stageImg = document.getElementById('datasetDiagModalImg');
      const missingEl = document.getElementById('datasetDiagModalMissing');
      const thumbUrl = detail?.image?.thumb_url || imgInfo?.thumb_url || '';
      const fullUrl = detail?.image?.preview_url || imgInfo?.preview_url || '';
      const srcUrl = fullUrl || thumbUrl;
      if (stageImg && missingEl) {
        if (!srcUrl) {
          this._datasetDiagImgSeq = (this._datasetDiagImgSeq || 0) + 1;
          if (stageImg.dataset) delete stageImg.dataset.ddPendingFull;
          stageImg.removeAttribute('src');
          stageImg.hidden = true;
          missingEl.hidden = false;
        } else if (fullUrl && stageImg.getAttribute('src') === fullUrl) {
          if (stageImg.dataset) delete stageImg.dataset.ddPendingFull;
          stageImg.hidden = false;
          missingEl.hidden = true;
        } else if (thumbUrl && fullUrl && thumbUrl !== fullUrl && typeof Image === 'function') {
          if (stageImg.getAttribute('src') !== thumbUrl) stageImg.setAttribute('src', thumbUrl);
          stageImg.hidden = false;
          missingEl.hidden = true;
          if (stageImg.dataset?.ddPendingFull !== fullUrl) {
            if (stageImg.dataset) stageImg.dataset.ddPendingFull = fullUrl;
            const imgSeq = ++this._datasetDiagImgSeq;
            const loader = new Image();
            loader.decoding = 'async';
            const applyFull = () => {
              if (imgSeq !== this._datasetDiagImgSeq || !this.datasetDiagModalOpen || !stageImg.isConnected) return;
              if (stageImg.dataset) delete stageImg.dataset.ddPendingFull;
              if (stageImg.getAttribute('src') !== fullUrl) stageImg.setAttribute('src', fullUrl);
            };
            loader.src = fullUrl;
            if (typeof loader.decode === 'function') {
              loader.decode().then(applyFull, () => {
                if (loader.complete && loader.naturalWidth > 0) applyFull();
              });
            } else {
              loader.onload = applyFull;
            }
          }
        } else {
          this._datasetDiagImgSeq = (this._datasetDiagImgSeq || 0) + 1;
          if (stageImg.dataset) delete stageImg.dataset.ddPendingFull;
          if (stageImg.getAttribute('src') !== srcUrl) stageImg.setAttribute('src', srcUrl);
          stageImg.hidden = false;
          missingEl.hidden = true;
        }
      }

      const footEl = document.getElementById('datasetDiagModalFoot');
      if (footEl && imgInfo) {
        const fi = detail?.file_info;
        const metaSpans = [];
        const reso = this._ddFormatResolution(imgInfo.resolution);
        const diff = (fi?.width && fi?.height && imgInfo.resolution)
          ? this._ddComputeBucketDiff(fi.width, fi.height, imgInfo.resolution, t)
          : null;
        if (fi?.width && fi?.height && reso) {
          metaSpans.push('<span>' + this.esc(`${t('ddOrigSize')} ${fi.width} × ${fi.height} → ${t('ddBucketSize')} ${reso}`) + '</span>');
        } else if (fi?.width && fi?.height) {
          metaSpans.push('<span>' + this.esc(`${t('ddOrigSize')} ${fi.width} × ${fi.height}`) + '</span>');
        } else if (reso) {
          metaSpans.push('<span>' + this.esc(`${t('ddBucketSize')} ${reso}`) + '</span>');
        }
        if (diff?.diffText) {
          metaSpans.push('<span class="m-dd-modal-size-diff' + (diff.warn ? ' is-warn' : '') + '">' + this.esc(diff.diffText) + '</span>');
        }
        const extraResos = Array.isArray(imgInfo.resolutions) ? imgInfo.resolutions : [];
        if (extraResos.length > 1) {
          const extraCnt = extraResos.length - 1;
          metaSpans.push('<span title="' + this.esc(extraResos.map(r => this._ddFormatResolution(r)).join(', ')) + '">'
            + this.esc((extraCnt === 1 ? t('ddBucketMoreOne') : t('ddBucketMore')).replace('{n}', extraCnt)) + '</span>');
        }
        if (fi?.size) {
          metaSpans.push('<span>' + this.esc(this._formatFileSize ? this._formatFileSize(fi.size) : `${fi.size} B`) + '</span>');
        }
        if (!metaSpans.length && imgInfo.dir_label) {
          metaSpans.push('<span>' + this.esc(imgInfo.dir_label) + '</span>');
        }
        const rawPath = fi?.abs_path || imgInfo.image || '';
        const openOrigBtn = srcUrl
          ? '<a class="btn btn-sm btn-ghost" href="' + this.esc(srcUrl) + '" target="_blank" rel="noopener">' + this.esc(t('openOriginal')) + '</a>'
          : '';
        let tagEditorBtn = '';
        if (fi?.exists && detail) {
          if (detail.caption?.editor_safe === true) {
            tagEditorBtn = '<button type="button" class="btn btn-sm btn-primary" @click="openDatasetDiagInTagEditor()">' + this.esc(t('ddOpenTagEditor')) + '</button>';
          } else {
            tagEditorBtn = '<button type="button" class="btn btn-sm btn-primary" disabled title="' + this.esc(t('ddTagEditorDisabledReason')) + '">' + this.esc(t('ddOpenTagEditor')) + '</button>';
          }
        }
        footEl.innerHTML = '<div class="m-dd-modal-meta" title="' + this.esc(rawPath) + '">' + metaSpans.join('<span class="m-dd-modal-meta-dot" aria-hidden="true">·</span>') + '</div>'
          + '<div class="m-dd-modal-actions">'
          + openOrigBtn
          + tagEditorBtn
          + '</div>';
      }

      const rightEl = document.getElementById('datasetDiagModalRight');
      if (!rightEl) return;

      if (this.datasetDiagModalLoading && !detail) {
        (rightEl._ddModalROs || []).forEach(ro => ro.disconnect());
        rightEl._ddModalROs = [];
        rightEl._ddWasPending = true;
        if (listImg) {
          rightEl.innerHTML = this._ddModalNanRowHtml(t, listImg, null)
            + this._ddModalKpiHtml(t, listImg, null)
            + this._ddGroupCtxHtml(t, null, listImg)
            + '<div class="m-dd-modal-pending" role="status"><span class="m-dd-pending-dot" aria-hidden="true"></span><span>' + this.esc(t('loading')) + '</span></div>';
        } else {
          rightEl.innerHTML = '<div class="dashboard-empty dashboard-empty-compact m-dd-modal-loading"><p>' + this.esc(t('loading')) + '</p></div>';
        }
        return;
      }
      if (this.datasetDiagModalError && !detail) {
        (rightEl._ddModalROs || []).forEach(ro => ro.disconnect());
        rightEl._ddModalROs = [];
        rightEl._ddWasPending = false;
        const modalError = this.datasetDiagModalError === 'loadFailed' ? t('ddModalLoadFailed') : this.datasetDiagModalError;
        rightEl.innerHTML = '<div class="dashboard-empty dashboard-empty-compact dashboard-empty-danger"><p>' + this.esc(modalError) + '</p></div>';
        return;
      }
      if (!detail) {
        rightEl.innerHTML = '';
        rightEl._ddWasPending = false;
        if (!this.datasetDiagModalLoading && !this.datasetDiagModalError) rightEl._ddRenderedImageId = '';
        return;
      }

      const wasPending = Boolean(rightEl._ddWasPending);
      const navChanged = Boolean(rightEl._ddRenderedImageId && rightEl._ddRenderedImageId !== this.datasetDiagModalImageId);
      rightEl._ddWasPending = false;
      rightEl.innerHTML = this._renderDatasetDiagModalRightHtml(t, detail);
      rightEl._ddRenderedImageId = this.datasetDiagModalImageId;
      if (navChanged || wasPending) {
        rightEl.scrollTop = 0;
        if (rightEl.classList) {
          rightEl.classList.remove('m-dd-content-enter');
          void rightEl.getBoundingClientRect?.();
          rightEl.classList.add('m-dd-content-enter');
        }
      }
      this._bindDatasetDiagModalCharts(rightEl, detail, t);
      if (this.datasetDiagSamplesModalOpen && detail) {
        this._patchDatasetDiagSamplesModal();
      }
    },

    _renderDatasetDiagModalRightHtml(t, detail) {
      const img = detail.image || {};
      const cap = detail.caption || {};
      const allEpochs = detail.epoch_series || [];
      const finiteEpochs = allEpochs.filter(row => row.mean_residual != null);
      const samples = detail.samples || [];
      const hasAnyNanEpoch = allEpochs.some(row => (row.non_finite_count || 0) > 0);
      const hasNan = (img.non_finite_count || 0) > 0;

      let html = '';

      if (hasNan) {
        html += this._ddModalNanRowHtml(t, img, detail);
      }

      html += this._ddModalKpiHtml(t, img, detail);
      html += this._ddGroupCtxHtml(t, detail, img);

      let capCountText = '';
      if (cap.exists && cap.text && cap.text.trim()) {
        const trimmed = cap.text.trim();
        const tagParts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
        if (tagParts.length >= 2) {
          capCountText = (tagParts.length === 1 ? t('ddCapTagCountOne') : t('ddCapTagCount')).replace('{n}', tagParts.length);
        } else {
          capCountText = (trimmed.length === 1 ? t('ddCapCharCountOne') : t('ddCapCharCount')).replace('{n}', trimmed.length);
        }
      }
      html += '<section class="m-dd-modal-sec m-dd-caption-sec">';
      html += '<div class="m-dd-modal-sec-head">'
        + '<div class="m-dd-cap-head-left">'
        + '<span class="m-dd-sec-title">' + this.esc(cap.source === 'class_tokens' ? t('ddClassTokens') : t('ddCaptionTitle')) + '</span>'
        + (cap.filename && cap.source !== 'class_tokens' ? '<span class="m-dd-cap-file" title="' + this.esc(cap.path || cap.filename) + '">' + this.esc(cap.filename) + '</span>' : '')
        + (capCountText ? '<span class="m-dd-cap-tags">' + this.esc(capCountText) + '</span>' : '')
        + '</div>';
      html += '<div class="m-dd-cap-actions">';
      if (cap.path && cap.editor_safe === false && cap.source !== 'class_tokens') {
        html += '<button type="button" class="btn btn-sm btn-secondary" @click="copyDatasetDiagText(datasetDiagModalDetail.caption.path)">' + this.esc(t('ddCopyCaptionPath')) + '</button>';
      }
      if (cap.exists && cap.text) {
        html += '<button type="button" class="btn btn-sm btn-ghost" @click="copyDatasetDiagText(datasetDiagModalDetail.caption.text)">' + this.esc(t('copy')) + '</button>';
      }
      html += '</div></div>';
      if (cap.error) {
        html += '<p class="m-dd-mini-empty is-danger">' + this.esc(cap.error) + '</p>';
      } else if (cap.source === 'ambiguous') {
        html += '<p class="m-dd-mini-empty">' + this.esc(t('ddCaptionAmbiguous')) + '</p>';
      } else if (cap.source === 'metadata' && !cap.exists) {
        const hint = cap.text_available ? t('ddMetadataEntryMissing')
          : t('ddMetadataCaption');
        html += '<p class="m-dd-mini-empty">' + this.esc(hint) + '</p>';
      } else if (cap.source === 'unknown' && detail.file_info?.exists) {
        html += '<p class="m-dd-mini-empty">' + this.esc(t('ddUnknownCaption')) + '</p>';
      } else if (!cap.exists) {
        html += '<p class="m-dd-mini-empty">' + this.esc(detail.file_info?.exists ? t('ddCaptionNotFound') : t('ddCaptionUnavailable')) + '</p>';
      } else if (!cap.text.trim()) {
        html += '<p class="m-dd-mini-empty">' + this.esc(t('ddCaptionEmpty')) + '</p>';
      } else {
        html += '<pre class="m-dd-caption-text">' + this.esc(cap.text) + '</pre>';
      }
      html += '</section>';

      const trendBadge = img.slope != null
        ? (this._ddTrendPillHtml?.(t, img.slope, img.converging_slope)
          || '<span class="m-dd-sec-badge" style="color:' + this._ddSlopeColor(img.slope, img.converging_slope) + '">' + this.esc(this._ddFormatSlope(img.slope) + t('ddSlopeUnit')) + '</span>')
        : '';
      const infoIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 7.4v3.4"/><circle cx="8" cy="5.2" r=".6" fill="currentColor" stroke="none"/></svg>';
      html += '<section class="m-dd-modal-sec' + (finiteEpochs.length >= 2 ? ' m-dd-modal-sec-chart m-dd-modal-sec-ep' : '') + '">';
      html += '<div class="m-dd-modal-sec-head">'
        + '<div class="m-dd-cap-head-left">'
        + '<span class="m-dd-sec-title">' + this.esc(t('ddEpochTrendTitle')) + '</span>'
        + '<span class="m-dd-inline-info-wrap m-dd-modal-info-wrap">'
        + '<button type="button" class="m-dd-inline-info-btn" aria-label="' + this.esc(t('ddEpochPeerHint')) + '">' + infoIcon + '</button>'
        + '<span class="m-dd-inline-info-pop" role="tooltip">' + this.esc(t('ddEpochPeerHint')) + '</span>'
        + '</span>'
        + trendBadge
        + '</div>'
        + (finiteEpochs.length >= 2
          ? '<div class="m-dd-legend">'
            + '<span class="m-dd-leg"><i class="is-dot is-sample"></i><span>' + this.esc(t('ddLegEpochMean')) + '</span></span>'
            + (finiteEpochs.length >= 3 && img.slope != null ? '<span class="m-dd-leg"><i class="is-line-dash is-soft"></i><span>' + this.esc(t('ddLegTrend')) + '</span></span>' : '')
            + (hasAnyNanEpoch ? '<span class="m-dd-leg"><i class="is-nan-x">×</i><span>' + this.esc(t('ddStatusNonFinite')) + '</span></span>' : '')
            + '</div>'
          : '')
        + '</div>';
      if (finiteEpochs.length >= 2) {
        html += '<div class="m-dd-mini-stage" data-dd-epoch-stage>'
          + '<svg class="m-dd-mini-svg" data-dd-epoch-svg aria-hidden="true"></svg>'
          + '<div class="m-dd-ts-tooltip m-dd-modal-tooltip" data-dd-ep-tooltip hidden></div>'
          + '</div>';
      } else {
        html += '<p class="m-dd-mini-empty">' + this.esc(t('ddEpochTrendFew')) + '</p>';
      }
      html += '</section>';

      const hasAnyTs = detail.timestep_scale !== 'unknown' && samples.some(s => s.timestep != null);
      const profileBins = this._ddResolveNoiseProfileBins(detail, 18);
      const hasIqr = profileBins.some(b => b.p25 != null && b.p75 != null);
      const imgZones = img.noise_zones || {};
      const scale = detail.timestep_scale || 'thousand';
      const sampleLossAcc = { high: { sum: 0, n: 0 }, mid: { sum: 0, n: 0 }, low: { sum: 0, n: 0 } };
      for (const s of samples) {
        if (s.non_finite || s.loss == null || s.timestep == null) continue;
        const t1000 = this._ddToTimestep1000(s.timestep, scale);
        const lv = Number(s.loss);
        if (t1000 == null || !Number.isFinite(lv)) continue;
        const zk = t1000 >= 2000 / 3 ? 'high' : (t1000 >= 1000 / 3 ? 'mid' : 'low');
        sampleLossAcc[zk].sum += lv;
        sampleLossAcc[zk].n += 1;
      }
      const zoneDefs = [
        ['high', t('ddZoneHighShort')],
        ['mid', t('ddZoneMidShort')],
        ['low', t('ddZoneLowShort')],
      ];
      const zoneTotalCount = zoneDefs.reduce((acc, [key]) => acc + Number(imgZones[key]?.count || 0), 0);
      const samplingBadge = this._ddFormatSamplingConfig(detail.sampling_config || this.datasetDiagData?.sampling_config);
      html += '<section class="m-dd-modal-sec' + (hasAnyTs ? ' m-dd-modal-sec-chart m-dd-modal-sec-ts' : '') + '">';
      html += '<div class="m-dd-modal-sec-head">'
        + '<div class="m-dd-cap-head-left">'
        + '<span class="m-dd-sec-title">' + this.esc(t('ddTimestepOverlayTitle')) + '</span>'
        + (samplingBadge ? '<span class="m-dd-noise-cfg" title="' + this.esc(samplingBadge) + '">' + this.esc(samplingBadge) + '</span>' : '')
        + (detail.samples_truncated ? '<span class="m-dd-sec-badge" title="' + this.esc(t('ddSamplesTruncated').replace('{n}', samples.length)) + '">' + this.esc(t('ddSamplesTruncBadge').replace('{n}', samples.length)) + '</span>' : '')
        + '</div>'
        + (hasAnyTs
          ? '<div class="m-dd-legend">'
            + (profileBins.length ? '<span class="m-dd-leg"><i class="is-line-ref"></i><span>' + this.esc(t('ddNoiseTooltipBase')) + '</span></span>' : '')
            + (hasIqr ? '<span class="m-dd-leg"><i class="is-iqr"></i><span>' + this.esc(t('ddLegP2575')) + '</span></span>' : '')
            + '<span class="m-dd-leg"><i class="is-dot is-sample"></i><span>' + this.esc(t('ddLegThisImage')) + '</span></span>'
            + (samples.some(s => s.non_finite) ? '<span class="m-dd-leg"><i class="is-nan-x">×</i><span>' + this.esc(t('ddStatusNonFinite')) + '</span></span>' : '')
            + '</div>'
          : '')
        + '</div>';
      html += '<div class="m-dd-zones-strip is-compact m-dd-modal-zones-bar">';
      zoneDefs.forEach(([key, label]) => {
        const z = imgZones[key];
        const count = Number(z?.count || 0);
        const sharePct = (count > 0 && zoneTotalCount > 0) ? Math.round((count / zoneTotalCount) * 100) : 0;
        const zCountText = count > 0
          ? `${t('ddZoneCountShort').replace('{n}', count)} · ${sharePct}%`
          : t('ddZoneEmpty');
        const meanLoss = (z?.mean_loss != null && Number.isFinite(Number(z.mean_loss)))
          ? Number(z.mean_loss)
          : (sampleLossAcc[key].n > 0 ? sampleLossAcc[key].sum / sampleLossAcc[key].n : null);
        const lossText = (count > 0 && meanLoss != null) ? this._ddFormatLoss(meanLoss) : '—';
        const lossStyle = (count > 0 && meanLoss != null) ? '' : ' style="color:var(--text-tertiary)"';
        const resText = (count > 0 && z?.mean_residual != null) ? this._ddFormatResidual(z.mean_residual) : '';
        const resColor = (count > 0 && z?.mean_residual != null) ? this._ddResidualColor(z.mean_residual) : '';
        html += '<div class="m-dd-zone-col m-dd-modal-zone" data-dd-zone-key="' + key + '" title="' + this.esc(label) + '">'
          + '<div class="m-dd-zone-row"><span class="m-dd-zone-name">' + this.esc(label) + '</span>'
          + '<span class="m-dd-zone-share">' + this.esc(zCountText) + '</span></div>'
          + '<div class="m-dd-zone-row is-main"><strong class="m-dd-num-val"' + lossStyle + '>' + this.esc(lossText) + '</strong>'
          + (resText ? '<span class="m-dd-zone-delta" style="color:' + resColor + '">' + this.esc(resText) + '</span>' : '')
          + '</div>'
          + '</div>';
      });
      html += '</div>';
      if (hasAnyTs) {
        html += '<div class="m-dd-mini-stage" data-dd-ts-stage>'
          + '<svg class="m-dd-mini-svg" data-dd-ts-svg aria-hidden="true"></svg>'
          + '<div class="m-dd-ts-tooltip m-dd-modal-tooltip" data-dd-ts-tooltip hidden></div>'
          + '</div>';
      } else {
        html += '<p class="m-dd-mini-empty">' + this.esc(t('ddTimestepOverlayEmpty')) + '</p>';
      }
      html += '</section>';
      return html;
    },

    _renderDatasetDiagSamplesBodyHtml(t, detail, filter = 'all') {
      const samples = detail?.samples || [];
      const activeFilter = filter === 'nan' ? 'nan' : 'all';
      const filtered = activeFilter === 'nan' ? samples.filter(s => s.non_finite) : samples;
      const distinctBatches = new Set(samples.map(s => s.batch_size).filter(v => v != null));
      const showBatchCol = distinctBatches.size > 1;
      const showWeightCol = samples.some(s => s.loss_weight != null && Math.abs(Number(s.loss_weight) - 1) > 1e-4);
      const colCount = 6 + (showBatchCol ? 1 : 0) + (showWeightCol ? 1 : 0);

      let html = '';
      if (detail?.samples_truncated) {
        html += '<p class="m-dd-mini-empty m-dd-samples-trunc">' + this.esc(t('ddSamplesTruncated').replace('{n}', samples.length)) + '</p>';
      }
      html += '<div class="m-dd-samples-table is-cols-' + colCount + '">'
        + '<div class="m-dd-sample-head"><span>' + this.esc(t('ddEpochLabel')) + '</span><span>' + this.esc(t('ddStepLabel')) + '</span><span>' + this.esc(t('ddColTimestep')) + '</span><span>' + this.esc(t('ddLossLabel')) + '</span><span>' + this.esc(t('ddColRelativeShort')) + '</span><span>' + this.esc(t('ddDimResolution')) + '</span>'
        + (showBatchCol ? '<span>' + this.esc(t('ddColBatchSize')) + '</span>' : '')
        + (showWeightCol ? '<span>' + this.esc(t('ddColLossWeight')) + '</span>' : '')
        + '</div>';
      filtered.slice().reverse().forEach(s => {
        const resColorCell = s.non_finite ? 'var(--diag-tone-danger, var(--danger))' : this._ddResidualColor(s.residual);
        html += '<div class="m-dd-sample-row' + (s.non_finite ? ' is-nan-row' : '') + '" data-dd-sample-row>'
          + '<span>' + this.esc(s.epoch ?? '—') + '</span>'
          + '<span>' + this.esc(s.step ?? '—') + '</span>'
          + '<span>' + this.esc(this._ddFormatTimestep(s.timestep, detail.timestep_scale)) + '</span>'
          + '<span>' + this.esc(s.non_finite ? t('ddStatusNonFinite') : this._ddFormatLoss(s.loss)) + '</span>'
          + '<span style="color:' + resColorCell + '">' + this.esc(this._ddFormatResidual(s.residual)) + '</span>'
          + '<span>' + this.esc(s.width && s.height ? `${s.width} × ${s.height}` : '—') + '</span>'
          + (showBatchCol ? '<span>' + this.esc(s.batch_size ?? '—') + '</span>' : '')
          + (showWeightCol ? '<span>' + this.esc(s.loss_weight != null ? Number(s.loss_weight).toFixed(2).replace(/\.?0+$/, '') : '—') + '</span>' : '')
          + '</div>';
      });
      html += '</div>';
      return html;
    },

    _patchDatasetDiagSamplesModal() {
      const detail = this.datasetDiagModalDetail;
      if (!detail) return;
      const t = k => this.tMonitor(k);
      const img = detail.image || {};
      const samples = detail.samples || [];
      const totalSampleCount = Number(detail.samples_total ?? samples.length);
      const nfTotalCount = Number(img.non_finite_count || 0);
      const filter = (this.datasetDiagSamplesFilter === 'nan' && nfTotalCount > 0) ? 'nan' : 'all';

      const distinctBatches = new Set(samples.map(s => s.batch_size).filter(v => v != null));
      const showBatchCol = distinctBatches.size > 1;
      const showWeightCol = samples.some(s => s.loss_weight != null && Math.abs(Number(s.loss_weight) - 1) > 1e-4);
      const isWide = showBatchCol || showWeightCol;

      const winEl = document.querySelector('#datasetDiagSamplesModal .m-dd-samples-window');
      const titleEl = document.getElementById('datasetDiagSamplesTitle');
      const metaEl = document.getElementById('datasetDiagSamplesMeta');
      const filterEl = document.getElementById('datasetDiagSamplesFilter');
      const sepEl = document.getElementById('datasetDiagSamplesSep');
      const bodyEl = document.getElementById('datasetDiagSamplesBody');

      if (winEl) {
        winEl.classList.toggle('is-wide', isWide);
      }
      if (titleEl) {
        titleEl.textContent = nfTotalCount > 0
          ? t('ddSamplesModalTitle')
          : t('ddSamplesLogTitle').replace('{n}', totalSampleCount);
      }
      if (metaEl) {
        metaEl.textContent = img.name || img.image || '';
        metaEl.title = img.image || '';
      }
      if (filterEl) {
        if (nfTotalCount > 0) {
          filterEl.hidden = false;
          if (sepEl) sepEl.hidden = false;
          if (!filterEl._ddSamplesFilterBound && typeof filterEl.addEventListener === 'function') {
            filterEl._ddSamplesFilterBound = true;
            filterEl.addEventListener('click', event => {
              const btn = event.target?.closest?.('[data-dd-samples-filter]');
              if (btn) this.setDatasetDiagSamplesFilter(btn.dataset.ddSamplesFilter);
            });
          }
          filterEl.innerHTML =
            '<button type="button" class="m-segmented-btn' + (filter === 'all' ? ' active' : '') + '"'
            + ' aria-pressed="' + (filter === 'all') + '" data-dd-samples-filter="all">'
            + this.esc(t('ddSamplesFilterAll').replace('{n}', samples.length)) + '</button>'
            + '<button type="button" class="m-segmented-btn' + (filter === 'nan' ? ' active' : '') + '"'
            + ' aria-pressed="' + (filter === 'nan') + '" data-dd-samples-filter="nan">'
            + this.esc(t('ddSamplesFilterNan').replace('{n}', samples.filter(s => s.non_finite).length)) + '</button>';
        } else {
          filterEl.hidden = true;
          if (sepEl) sepEl.hidden = true;
          filterEl.innerHTML = '';
        }
      }
      if (bodyEl) {
        bodyEl.innerHTML = this._renderDatasetDiagSamplesBodyHtml(t, detail, filter);
        if (filter === 'nan') {
          const firstNanRow = bodyEl.querySelector('.m-dd-sample-row.is-nan-row');
          if (firstNanRow) {
            requestAnimationFrame(() => {
              firstNanRow.classList.remove('is-flash-hit');
              void firstNanRow.offsetWidth;
              firstNanRow.classList.add('is-flash-hit');
            });
          }
        }
      }
    },

    _ddPositionModalTooltip(stage, tipEl, anchorX, anchorY) {
      if (!stage || !tipEl) return;
      const st = stage._ddState;
      const stageW = st?.stageW || stage.clientWidth || 380;
      const stageH = st?.stageH || stage.clientHeight || 156;
      const tipW = tipEl.offsetWidth || 168;
      const tipH = tipEl.offsetHeight || 64;
      const placeLeft = anchorX > stageW * 0.56;
      const rawLeft = placeLeft ? (anchorX - tipW - 10) : (anchorX + 10);
      const left = Math.max(4, Math.min(Math.max(4, stageW - tipW - 4), rawLeft));
      const rawTop = anchorY - tipH / 2;
      const top = Math.max(4, Math.min(Math.max(4, stageH - tipH - 4), rawTop));
      tipEl.style.left = Math.round(left) + 'px';
      tipEl.style.top = Math.round(top) + 'px';
    },

    _bindDatasetDiagModalCharts(rightEl, detail, t, opts = {}) {
      (rightEl._ddModalROs || []).forEach(ro => ro.disconnect());
      rightEl._ddModalROs = [];
      rightEl._ddBindCtrl?.abort();
      const bindCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      rightEl._ddBindCtrl = bindCtrl;
      const evOpts = bindCtrl ? { signal: bindCtrl.signal } : undefined;

      const epStage = rightEl.querySelector('[data-dd-epoch-stage]');
      const epSvg = rightEl.querySelector('[data-dd-epoch-svg]');
      const epTip = rightEl.querySelector('[data-dd-ep-tooltip]');
      const tsStage = rightEl.querySelector('[data-dd-ts-stage]');
      const tsSvg = rightEl.querySelector('[data-dd-ts-svg]');
      const tsTip = rightEl.querySelector('[data-dd-ts-tooltip]');

      const setActiveZone = (zoneKey, source = 'chart') => {
        rightEl.querySelectorAll('.m-dd-modal-zone[data-dd-zone-key]').forEach(el => {
          el.classList.toggle('is-zone-hover', !!zoneKey && el.dataset.ddZoneKey === zoneKey);
        });
        const filterByHeader = source === 'header' && !!zoneKey;
        tsSvg?.querySelectorAll?.('[data-dd-zone]').forEach(node => {
          const nodeZone = node.getAttribute?.('data-dd-zone');
          node.classList?.toggle?.('is-zone-hot', filterByHeader && nodeZone === zoneKey);
          node.classList?.toggle?.('is-zone-dim', filterByHeader && nodeZone !== zoneKey);
        });
      };

      const syncLinkedEpoch = (epochVal, source = 'none') => {
        const rawList = Array.isArray(epochVal) ? epochVal : [epochVal];
        const epSet = new Set(
          rawList
            .filter(v => v != null && v !== '' && Number.isFinite(Number(v)))
            .map(Number),
        );

        if (tsSvg) {
          const linkTs = source === 'epoch' && epSet.size > 0;
          tsSvg.classList?.toggle?.('is-ep-linking', linkTs);
          tsSvg.querySelectorAll?.('[data-dd-ts-dot-epochs]').forEach(node => {
            if (!linkTs) {
              node.classList?.remove?.('is-ep-match', 'is-ep-dim');
              return;
            }
            const epochsAttr = String(node.getAttribute('data-dd-ts-dot-epochs') || '').split(',');
            const matched = epochsAttr.some(v => v !== '' && epSet.has(Number(v)));
            node.classList?.toggle?.('is-ep-match', matched);
            node.classList?.toggle?.('is-ep-dim', !matched);
          });
        }

        if (epSvg && epStage?._ddState && source !== 'epoch') {
          epSvg.querySelectorAll?.('[data-dd-ep-dot], [data-dd-ep-nan]').forEach(node => {
            if (!epSet.size) {
              node.classList?.remove?.('is-ts-linked');
              return;
            }
            const rawEp = node.getAttribute?.('data-dd-ep-dot') ?? node.getAttribute?.('data-dd-ep-nan');
            const matched = rawEp != null && rawEp !== '' && epSet.has(Number(rawEp));
            node.classList?.toggle?.('is-ts-linked', matched);
          });
          const epFocus = epSvg.querySelector?.('[data-dd-ep-focus]');
          const epCh = epSvg.querySelector?.('[data-dd-ep-ch]');
          const singleEp = epSet.size === 1 ? Array.from(epSet)[0] : null;
          const match = singleEp != null ? epStage._ddState.allCoords?.find(c => Number(c.epoch) === singleEp) : null;
          if (match) {
            if (epCh) {
              epCh.classList?.remove?.('is-moving');
              if (epCh.style) epCh.style.transform = `translateX(${match.x.toFixed(1)}px)`;
              epCh.setAttribute('x1', epCh.style ? '0' : match.x.toFixed(1));
              epCh.setAttribute('x2', epCh.style ? '0' : match.x.toFixed(1));
              epCh.removeAttribute('display');
            }
            if (epFocus && match.y != null) {
              epFocus.setAttribute('cx', match.x.toFixed(1));
              epFocus.setAttribute('cy', match.y.toFixed(1));
              epFocus.removeAttribute('display');
            } else {
              epFocus?.setAttribute('display', 'none');
            }
          } else {
            epCh?.setAttribute('display', 'none');
            epFocus?.setAttribute('display', 'none');
          }
        }
      };

      const showEpochTooltip = (coord) => {
        if (!epStage || !epTip || !coord) return;
        const wasHidden = !!epTip.hidden;
        epTip.classList?.toggle?.('is-moving', !wasHidden);
        let rowsHtml = '';
        if (coord.mean_residual != null) {
          const resCol = this._ddResidualColor(coord.mean_residual);
          rowsHtml += `<div class="m-dd-tt-row"><em>${this.esc(t('ddColRelativeShort'))}</em>`
            + `<strong class="m-dd-tt-v-main" style="color:${resCol}">${this.esc(this._ddFormatResidual(coord.mean_residual))}</strong></div>`;
        }
        if (coord.mean_loss != null) {
          rowsHtml += `<div class="m-dd-tt-row"><em>${this.esc(t('ddLossLabel'))}</em>`
            + `<strong class="m-dd-tt-v-main">${this.esc(this._ddFormatLoss(coord.mean_loss))}</strong></div>`;
        }
        if ((coord.non_finite_count || 0) > 0) {
          rowsHtml += `<div class="m-dd-tt-row"><em style="color:var(--diag-tone-danger, var(--danger))">${this.esc(t('ddStatusNonFinite'))}</em>`
            + `<strong class="m-dd-tt-v-main" style="color:var(--diag-tone-danger, var(--danger))">${this.esc(t('ddZoneCountShort').replace('{n}', coord.non_finite_count))}</strong></div>`;
        }
        epTip.innerHTML = `<div class="m-dd-tt-head"><strong>${this.esc(t('ddEpochLabel'))} ${this.esc(coord.epoch)}</strong>`
          + (coord.count ? `<span class="m-dd-tt-zone"><span class="m-dd-tt-zone-name">${this.esc(t('ddZoneCountShort').replace('{n}', coord.count))}</span></span>` : '')
          + `</div><div class="m-dd-tt-section">${rowsHtml}</div>`;
        epTip.hidden = false;
        this._ddPositionModalTooltip(epStage, epTip, coord.x, coord.y ?? 20);
      };

      const showTsClusterTooltip = (cluster) => {
        if (!tsStage || !tsTip || !cluster) return;
        const wasHidden = !!tsTip.hidden;
        tsTip.classList?.toggle?.('is-moving', !wasHidden);
        const items = cluster.items || [cluster];
        const tsTexts = items.map(it => this._ddFormatTimestep(it.timestep, detail.timestep_scale));
        const tsText = tsTexts[0];
        const uniqueTs = new Set(tsTexts.filter(v => v && v !== '—'));
        const hasDistinctTs = items.length > 1 && uniqueTs.size > 1;
        const zoneKey = cluster.t1000 >= 2000 / 3 ? 'high' : (cluster.t1000 >= 1000 / 3 ? 'mid' : 'low');
        const zoneName = zoneKey === 'high' ? t('ddZoneHighShort') : (zoneKey === 'mid' ? t('ddZoneMidShort') : t('ddZoneLowShort'));

        const epShort = this.esc(t('ddEpShort'));
        const stepLabel = this.esc(t('ddStepLabel'));
        let bodyHtml = '';
        const ordered = items.slice().reverse();
        const visible = ordered.slice(0, 4);
        visible.forEach(item => {
          const itemTs = hasDistinctTs ? ` · t = ${this.esc(this._ddFormatTimestep(item.timestep, detail.timestep_scale))}` : '';
          const epStr = `${epShort} ${this.esc(item.epoch ?? '?')} / ${stepLabel} ${this.esc(item.step ?? '?')}${itemTs}`;
          if (item.non_finite) {
            bodyHtml += `<div class="m-dd-tt-row"><em>${epStr}</em><strong class="m-dd-tt-v-main" style="color:var(--diag-tone-danger, var(--danger))">${this.esc(t('ddStatusNonFinite'))}</strong></div>`;
          } else {
            const rStr = item.residual != null ? this._ddFormatResidual(item.residual) : '';
            const rCol = item.residual != null ? this._ddResidualColor(item.residual) : '';
            bodyHtml += `<div class="m-dd-tt-row"><em>${epStr}</em>`
              + `<span class="m-dd-tt-v-group"><strong class="m-dd-tt-v-main">${this.esc(this._ddFormatLoss(item.loss))}</strong>`
              + (rStr ? `<span class="m-dd-tt-v-sub" style="color:${rCol}">${this.esc(rStr)}</span>` : '')
              + `</span></div>`;
          }
        });
        if (ordered.length > 4) {
          bodyHtml += `<div class="m-dd-tt-meta">${this.esc(t('ddClusterMore').replace('{n}', ordered.length - 4))}</div>`;
        }

        const st = tsStage._ddState;
        const binMatch = (st?.bins || []).find(b => cluster.t1000 >= b.tFrom && (cluster.t1000 < b.tTo || (b.tTo >= 999.9 && cluster.t1000 <= 1000)));
        let baseHtml = '';
        if (binMatch && binMatch.count > 0 && binMatch.mean_loss != null) {
          baseHtml += `<div class="m-dd-tt-sep"></div><div class="m-dd-tt-section">`
            + `<div class="m-dd-tt-row"><em>${this.esc(t('ddNoiseTooltipMeanLoss'))}</em><span class="m-dd-tt-v-sub is-val">${this.esc(this._ddFormatLoss(binMatch.mean_loss))}</span></div>`
            + (binMatch.p25 != null && binMatch.p75 != null
              ? `<div class="m-dd-tt-row"><em>${this.esc(t('ddLegP2575'))}</em><span class="m-dd-tt-v-sub is-val">${this.esc(this._ddFormatLossRangeNum(binMatch.p25) + ' – ' + this._ddFormatLossRangeNum(binMatch.p75))}</span></div>`
              : '')
            + `</div>`;
        }

        const clusterLabel = (items.length === 1 ? t('ddClusterCountOne') : t('ddClusterCount')).replace('{n}', items.length);
        let headTitle;
        if (items.length <= 1) {
          headTitle = `t = ${this.esc(tsText)}`;
        } else if (!hasDistinctTs) {
          headTitle = `t = ${this.esc(tsText)} · ${this.esc(clusterLabel)}`;
        } else {
          const tsNums = items
            .map(it => this._ddToTimestep1000(it.timestep, detail.timestep_scale))
            .filter(v => v != null)
            .map(v => Math.round(v));
          if (tsNums.length >= 2) {
            const minT = Math.min(...tsNums);
            const maxT = Math.max(...tsNums);
            const rangeText = minT !== maxT ? `${minT}–${maxT}` : `${minT}`;
            headTitle = `t = ${rangeText} · ${this.esc(clusterLabel)}`;
          } else {
            headTitle = this.esc(clusterLabel);
          }
        }
        tsTip.innerHTML = `<div class="m-dd-tt-head"><strong>${headTitle}</strong>`
          + `<span class="m-dd-tt-zone"><span class="m-dd-tt-zone-name">${this.esc(zoneName)}</span></span></div>`
          + `<div class="m-dd-tt-section">${bodyHtml}</div>${baseHtml}`;
        tsTip.hidden = false;
        this._ddPositionModalTooltip(tsStage, tsTip, cluster.cx, cluster.cy);
      };

      const nanJumpEl = rightEl.querySelector('[data-dd-nan-jump]');
      if (nanJumpEl) {
        const triggerNanJump = () => {
          this.openDatasetDiagSamplesModal?.('nan');
        };
        nanJumpEl.addEventListener('click', triggerNanJump, evOpts);
        nanJumpEl.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); triggerNanJump(); }
        }, evOpts);
      }

      if (epStage && epSvg) {
        let epRaf = 0;
        let epMoveRaf = 0;
        let epPendingEv = null;
        let epLastCoord = null;
        const renderEp = () => {
          epRaf = 0;
          const nextW = Math.round(epStage.clientWidth || 0);
          const nextH = Math.round(epStage.clientHeight || 0);
          if (nextW > 60 && (Math.abs(nextW - (epStage._ddLastW || 0)) >= 2 || Math.abs(nextH - (epStage._ddLastH || 0)) >= 2)) {
            epStage._ddLastW = nextW;
            epStage._ddLastH = nextH;
            epLastCoord = null;
            this._renderDatasetDiagModalEpochSvg(epStage, epSvg, epTip, detail, t);
            if (epStage._ddState) {
              epStage._ddState.stageW = nextW;
              epStage._ddState.stageH = nextH;
            }
          }
        };
        if (opts.immediate || (epStage.clientWidth || 0) > 60) renderEp();
        else epRaf = requestAnimationFrame(renderEp);
        const roEp = typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => { if (!epRaf) epRaf = requestAnimationFrame(renderEp); })
          : null;
        roEp?.observe(epStage);
        rightEl._ddModalROs.push({
          disconnect() {
            roEp?.disconnect();
            if (epRaf) { cancelAnimationFrame(epRaf); epRaf = 0; }
            if (epMoveRaf) { cancelAnimationFrame(epMoveRaf); epMoveRaf = 0; }
            epPendingEv = null;
          },
        });

        const handleEpMove = event => {
          const st = epStage._ddState;
          const pool = st?.allCoords?.length ? st.allCoords : st?.coords;
          if (!st || !pool?.length || !event) return;
          const rect = epStage.getBoundingClientRect();
          if (rect?.width) st.stageW = rect.width;
          if (rect?.height) st.stageH = rect.height;
          const x = event.clientX - rect.left;
          let best = pool[0], dist = Infinity;
          for (const c of pool) {
            const d = Math.abs(c.x - x);
            if (d < dist) { dist = d; best = c; }
          }
          if (epLastCoord === best && !epTip?.hidden) return;
          epLastCoord = best;
          const ch = epSvg.querySelector('[data-dd-ep-ch]');
          if (ch) {
            const wasHidden = ch.getAttribute?.('display') === 'none' || ch.attrs?.display === 'none';
            if (ch.style) {
              ch.classList?.toggle?.('is-moving', !wasHidden);
              ch.style.transform = `translateX(${best.x.toFixed(1)}px)`;
              ch.setAttribute('x1', '0');
              ch.setAttribute('x2', '0');
            } else {
              ch.setAttribute('x1', best.x.toFixed(1));
              ch.setAttribute('x2', best.x.toFixed(1));
            }
            ch.removeAttribute('display');
          }
          const dot = epSvg.querySelector('[data-dd-ep-focus]');
          if (dot) {
            if (best.y != null) {
              dot.setAttribute('cx', best.x.toFixed(1));
              dot.setAttribute('cy', best.y.toFixed(1));
              dot.removeAttribute('display');
            } else {
              dot.setAttribute('display', 'none');
            }
          }
          showEpochTooltip(best);
          syncLinkedEpoch(best.epoch, 'epoch');
        };
        epStage.addEventListener('pointermove', event => {
          epPendingEv = event;
          if (typeof requestAnimationFrame !== 'function') {
            handleEpMove(event);
            return;
          }
          if (!epMoveRaf) {
            epMoveRaf = requestAnimationFrame(() => {
              epMoveRaf = 0;
              const ev = epPendingEv;
              epPendingEv = null;
              if (ev) handleEpMove(ev);
            });
          }
        }, evOpts);
        epStage.addEventListener('pointerleave', () => {
          if (epMoveRaf) { cancelAnimationFrame(epMoveRaf); epMoveRaf = 0; }
          epPendingEv = null;
          epLastCoord = null;
          const epCh = epSvg.querySelector('[data-dd-ep-ch]');
          if (epCh) {
            epCh.setAttribute('display', 'none');
            epCh.classList?.remove?.('is-moving');
          }
          epSvg.querySelector('[data-dd-ep-focus]')?.setAttribute('display', 'none');
          if (epTip) epTip.hidden = true;
          syncLinkedEpoch(null, 'epoch');
        }, evOpts);
      }

      rightEl.querySelectorAll('.m-dd-modal-zone[data-dd-zone-key]').forEach(cell => {
        cell.addEventListener('pointerenter', () => setActiveZone(cell.dataset.ddZoneKey, 'header'), evOpts);
        cell.addEventListener('pointerleave', () => setActiveZone('', 'header'), evOpts);
      });
      if (tsStage && tsSvg) {
        let tsRaf = 0;
        let tsMoveRaf = 0;
        let tsPendingEv = null;
        let tsLastCluster = null;
        const renderTs = () => {
          tsRaf = 0;
          const nextW = Math.round(tsStage.clientWidth || 0);
          const nextH = Math.round(tsStage.clientHeight || 0);
          if (nextW > 60 && (Math.abs(nextW - (tsStage._ddLastW || 0)) >= 2 || Math.abs(nextH - (tsStage._ddLastH || 0)) >= 2)) {
            tsStage._ddLastW = nextW;
            tsStage._ddLastH = nextH;
            tsLastCluster = null;
            this._renderDatasetDiagModalTimestepSvg(tsStage, tsSvg, detail, t);
            if (tsStage._ddState) {
              tsStage._ddState.stageW = nextW;
              tsStage._ddState.stageH = nextH;
            }
          }
        };
        if (opts.immediate || (tsStage.clientWidth || 0) > 60) renderTs();
        else tsRaf = requestAnimationFrame(renderTs);
        const roTs = typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(() => { if (!tsRaf) tsRaf = requestAnimationFrame(renderTs); })
          : null;
        roTs?.observe(tsStage);
        rightEl._ddModalROs.push({
          disconnect() {
            roTs?.disconnect();
            if (tsRaf) { cancelAnimationFrame(tsRaf); tsRaf = 0; }
            if (tsMoveRaf) { cancelAnimationFrame(tsMoveRaf); tsMoveRaf = 0; }
            tsPendingEv = null;
          },
        });
        const clearTsHover = () => {
          if (tsMoveRaf) { cancelAnimationFrame(tsMoveRaf); tsMoveRaf = 0; }
          tsPendingEv = null;
          tsLastCluster = null;
          tsSvg.querySelector('[data-dd-ts-focus]')?.setAttribute('display', 'none');
          const tsCh = tsSvg.querySelector('[data-dd-ts-ch]');
          if (tsCh) {
            tsCh.setAttribute('display', 'none');
            tsCh.classList?.remove?.('is-moving');
          }
          tsSvg.querySelectorAll?.('[data-dd-modal-bin]').forEach(b => b.classList?.remove?.('is-hovered'));
          if (tsTip) tsTip.hidden = true;
          setActiveZone('', 'chart');
          syncLinkedEpoch(null, 'timestep');
        };
        const handleTsMove = event => {
          const st = tsStage._ddState;
          const pool = st?.clusters?.length ? st.clusters : st?.dots;
          if (!st || !pool?.length || !event) return;
          const rect = tsStage.getBoundingClientRect();
          if (rect?.width) st.stageW = rect.width;
          if (rect?.height) st.stageH = rect.height;
          const x = event.clientX - rect.left, y = event.clientY - rect.top;
          let best = null, bestD2 = 24 * 24;
          for (const d of pool) {
            const dx = d.cx - x, dy = d.cy - y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= bestD2) { bestD2 = d2; best = d; }
          }
          const focus = tsSvg.querySelector('[data-dd-ts-focus]');
          if (!best) {
            if (tsLastCluster !== null || !tsTip?.hidden) clearTsHover();
            return;
          }
          if (tsLastCluster === best && !tsTip?.hidden) return;
          tsLastCluster = best;
          const zKey = best.t1000 >= 2000 / 3 ? 'high' : (best.t1000 >= 1000 / 3 ? 'mid' : 'low');
          setActiveZone(zKey, 'chart');
          const tsCh = tsSvg.querySelector('[data-dd-ts-ch]');
          if (tsCh) {
            const wasHidden = tsCh.getAttribute?.('display') === 'none' || tsCh.attrs?.display === 'none';
            if (tsCh.style) {
              tsCh.classList?.toggle?.('is-moving', !wasHidden);
              tsCh.style.transform = `translateX(${best.cx.toFixed(1)}px)`;
              tsCh.setAttribute('x1', '0');
              tsCh.setAttribute('x2', '0');
            } else {
              tsCh.setAttribute('x1', best.cx.toFixed(1));
              tsCh.setAttribute('x2', best.cx.toFixed(1));
            }
            tsCh.removeAttribute('display');
          }
          const binIdx = (st.barBins || []).findIndex(b =>
            best.t1000 >= b.tFrom && (best.t1000 < b.tTo || (b.tTo >= 999.9 && best.t1000 <= 1000)),
          );
          tsSvg.querySelectorAll?.('[data-dd-modal-bin]').forEach(b => {
            b.classList?.toggle?.('is-hovered', binIdx >= 0 && b.getAttribute?.('data-dd-modal-bin') === String(binIdx));
          });
          if (focus) {
            focus.setAttribute('cx', best.cx.toFixed(1));
            focus.setAttribute('cy', best.cy.toFixed(1));
            focus.setAttribute('stroke', best.non_finite ? 'var(--danger)' : 'var(--accent)');
            focus.removeAttribute('display');
          }
          showTsClusterTooltip(best);
          const clusterItems = best.items?.length ? best.items : [best];
          const linkedEpochs = Array.from(new Set(
            clusterItems.map(it => it.epoch).filter(v => v != null && v !== '' && Number.isFinite(Number(v))).map(Number),
          ));
          syncLinkedEpoch(linkedEpochs.length ? linkedEpochs : null, 'timestep');
        };
        tsStage.addEventListener('pointermove', event => {
          tsPendingEv = event;
          if (typeof requestAnimationFrame !== 'function') {
            handleTsMove(event);
            return;
          }
          if (!tsMoveRaf) {
            tsMoveRaf = requestAnimationFrame(() => {
              tsMoveRaf = 0;
              const ev = tsPendingEv;
              tsPendingEv = null;
              if (ev) handleTsMove(ev);
            });
          }
        }, evOpts);
        tsStage.addEventListener('pointerleave', clearTsHover, evOpts);
      }
    },

    _renderDatasetDiagModalEpochSvg(stage, svg, tipEl, detail, t) {
      const allEpochs = (detail.epoch_series || []).filter(row => row.epoch != null);
      const series = allEpochs.filter(row => row.mean_residual != null);
      if (series.length < 2) return;
      const width = Math.max(240, Math.round(stage.clientWidth || 380));
      const hasNanEpochs = allEpochs.some(row => (row.non_finite_count || 0) > 0);
      const stageH = Math.round(stage.clientHeight || 0);
      const fallbackH = hasNanEpochs ? 176 : 164;
      const height = stageH >= 80 ? Math.min(320, stageH) : fallbackH;
      const padL = 48, padR = 14, padT = hasNanEpochs ? 22 : 12, padB = 22;
      const plotW = Math.max(60, width - padL - padR);
      const plotH = Math.max(40, height - padT - padB);
      const plotPadX = Math.min(10, Math.max(4, plotW * 0.03));

      const vals = series.map(s => s.mean_residual);
      const rawMin = Math.min(...vals);
      const rawMax = Math.max(...vals);
      const spanRaw = Math.max(rawMax - rawMin, 0.04);
      const highThresh = detail.thresholds?.high_residual ?? 0.20;
      const includeHighLine = rawMax >= highThresh * 0.72;
      const minV = Math.min(0, rawMin - spanRaw * 0.16);
      const maxV = Math.max(includeHighLine ? highThresh * 1.08 : 0.02, rawMax + spanRaw * 0.18);
      const spanV = Math.max(maxV - minV, 0.05);
      const minE = allEpochs[0]?.epoch ?? series[0].epoch;
      const maxE = allEpochs.at(-1)?.epoch ?? series.at(-1).epoch;
      const spanE = Math.max(maxE - minE, 1);

      const toX = ep => padL + plotPadX + ((ep - minE) / spanE) * Math.max(20, plotW - plotPadX * 2);
      const toY = v => padT + plotH - ((v - minV) / spanV) * plotH;

      const coords = series.map(s => ({ ...s, x: toX(s.epoch), y: toY(s.mean_residual) }));
      const coordByEpoch = new Map(coords.map(c => [c.epoch, c]));
      const allCoords = allEpochs.map(row => coordByEpoch.get(row.epoch) || ({ ...row, x: toX(row.epoch), y: null }));
      const yZero = toY(0);
      const yHigh = includeHighLine ? toY(highThresh) : null;

      const slope = detail.image?.slope;
      let trendHtml = '';
      if (slope != null && series.length >= 3) {
        const meanX = series.reduce((a, b) => a + b.epoch, 0) / series.length;
        const meanY = series.reduce((a, b) => a + b.mean_residual, 0) / series.length;
        const y1 = meanY + slope * (series[0].epoch - meanX);
        const y2 = meanY + slope * (series.at(-1).epoch - meanX);
        trendHtml = `<line class="m-dd-trend-line" x1="${toX(series[0].epoch).toFixed(1)}" y1="${toY(y1).toFixed(1)}" x2="${toX(series.at(-1).epoch).toFixed(1)}" y2="${toY(y2).toFixed(1)}"/>`;
      }

      const dotsHtml = coords.map(c =>
        `<circle class="m-dd-ep-dot" data-dd-ep-dot="${this.esc(c.epoch)}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.4" style="fill:${this._ddResidualColor(c.mean_residual, { kind: 'graphic' })}" stroke="var(--monitor-card-bg)" stroke-width="1.3"/>`
      ).join('');
      const nanEpochHtml = hasNanEpochs
        ? allCoords.filter(c => (c.non_finite_count || 0) > 0).map(c => {
          const cy = 11;
          return `<g class="m-dd-nan-mark" data-dd-ep-nan="${c.epoch}">`
            + `<line class="m-dd-ep-nan-guide" x1="${c.x.toFixed(1)}" x2="${c.x.toFixed(1)}" y1="${cy + 5}" y2="${padT + plotH}"/>`
            + `<line x1="${(c.x - 3).toFixed(1)}" y1="${(cy - 3).toFixed(1)}" x2="${(c.x + 3).toFixed(1)}" y2="${(cy + 3).toFixed(1)}"/>`
            + `<line x1="${(c.x + 3).toFixed(1)}" y1="${(cy - 3).toFixed(1)}" x2="${(c.x - 3).toFixed(1)}" y2="${(cy + 3).toFixed(1)}"/>`
            + `</g>`;
        }).join('')
        : '';

      const showTopTick = Math.abs((padT + 4) - (yZero + 3)) >= 14;
      const showBotTick = Math.abs((padT + plotH + 1) - (yZero + 3)) >= 14;

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', stageH >= 80 ? '100%' : String(height));
      svg.innerHTML = `
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT}" y2="${padT}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT + plotH}" y2="${padT + plotH}" class="is-axis"/>
        </g>
        <g class="m-dd-ref-lines">
          <line class="is-zero" x1="${padL}" x2="${padL + plotW}" y1="${yZero.toFixed(1)}" y2="${yZero.toFixed(1)}"/>
          ${yHigh != null ? `<line class="is-thresh" x1="${padL}" x2="${padL + plotW}" y1="${yHigh.toFixed(1)}" y2="${yHigh.toFixed(1)}"/>` : ''}
        </g>
        <line class="m-dd-mini-ch" data-dd-ep-ch x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" display="none"/>
        ${trendHtml}
        <g>${dotsHtml}</g>
        ${nanEpochHtml}
        <circle class="m-dd-dot-focus" data-dd-ep-focus r="5.5" stroke="var(--diag-full-line, var(--text-secondary))" display="none"/>
        <g class="m-chart-axes">
          ${yHigh != null && yHigh > padT + 10 ? `<text class="m-dd-thresh-label" x="${padL + plotW - 2}" y="${(yHigh - 3).toFixed(1)}" text-anchor="end">+${Math.round(highThresh * 100)}%</text>` : ''}
          ${showTopTick ? `<text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${this._ddFormatResidual(maxV)}</text>` : ''}
          <text class="is-zero" x="${padL - 6}" y="${(yZero + 3).toFixed(1)}" text-anchor="end">0%</text>
          ${showBotTick ? `<text x="${padL - 6}" y="${padT + plotH + 1}" text-anchor="end">${this._ddFormatResidual(minV)}</text>` : ''}
          <text x="${toX(minE).toFixed(1)}" y="${height - 5}" text-anchor="start">${this.esc(t('ddEpochLabel'))} ${minE}</text>
          <text x="${toX(maxE).toFixed(1)}" y="${height - 5}" text-anchor="end">${this.esc(t('ddEpochLabel'))} ${maxE}</text>
        </g>`;

      stage._ddState = { coords, allCoords, minE, maxE, stageW: width, stageH: height };
      if (tipEl) tipEl.hidden = true;
    },

    _ddClusterModalDots(dots, radius = 5.5) {
      const clusters = [];
      const r2 = radius * radius;
      for (const dot of dots) {
        let hit = null;
        for (const c of clusters) {
          const dx = c.cx - dot.cx, dy = c.cy - dot.cy;
          if (dx * dx + dy * dy <= r2) { hit = c; break; }
        }
        if (hit) {
          hit.items.push(dot);
          const n = hit.items.length;
          hit.sumCx += dot.cx;
          hit.sumCy += dot.cy;
          hit.sumT1000 += dot.t1000;
          hit.cx = hit.sumCx / n;
          hit.cy = hit.sumCy / n;
          hit.t1000 = hit.sumT1000 / n;
          hit.fill = dot.fill;
          hit.opacity = Math.max(hit.opacity, dot.opacity ?? 0.9);
        } else {
          clusters.push({
            cx: dot.cx,
            cy: dot.cy,
            t1000: dot.t1000,
            sumCx: dot.cx,
            sumCy: dot.cy,
            sumT1000: dot.t1000,
            non_finite: Boolean(dot.non_finite),
            fill: dot.fill,
            opacity: dot.opacity ?? 0.9,
            items: [dot],
          });
        }
      }
      return clusters;
    },

    _renderDatasetDiagModalTimestepSvg(stage, svg, detail, t) {
      const bins = this._ddResolveNoiseProfileBins(detail, 18);
      const scale = detail.timestep_scale || 'thousand';
      const finiteSamples = (detail.samples || []).filter(s => s.timestep != null && !s.non_finite && s.loss != null);
      const nfValid = (detail.samples || [])
        .filter(s => s.timestep != null && s.non_finite)
        .map(s => ({ ...s, t1000: this._ddToTimestep1000(s.timestep, scale) }))
        .filter(s => s.t1000 != null);
      if (!finiteSamples.length && !nfValid.length) return;
      const width = Math.max(240, Math.round(stage.clientWidth || 380));
      const hasNanTrack = nfValid.length > 0;
      const stageH = Math.round(stage.clientHeight || 0);
      const fallbackH = hasNanTrack ? 216 : 196;
      const height = stageH >= 80 ? Math.min(340, stageH) : fallbackH;
      const padL = 48, padR = 14, padT = hasNanTrack ? 36 : 12, padB = 20;
      const plotW = Math.max(60, width - padL - padR);
      const plotBottom = height - padB;
      const plotH = Math.max(64, plotBottom - padT);
      const densityH = Math.max(24, Math.min(44, Math.round(plotH * 0.25)));
      const densityGap = 8;
      const lossTop = padT;
      const lossBottom = Math.max(lossTop + 36, plotBottom - densityH - densityGap);
      const lossH = Math.max(36, lossBottom - lossTop);

      const samplingCfg = detail.sampling_config || this.datasetDiagData?.sampling_config;
      const excluded = this._ddNoiseExcludedBounds(samplingCfg);
      const toX = t1000 => padL + ((1000 - t1000) / 1000) * plotW;

      const allL = [
        ...bins.filter(b => b.count > 0 && b.mean_loss != null).map(b => Number(b.mean_loss)),
        ...bins.filter(b => b.count > 0 && b.p75 != null).map(b => Number(b.p75)),
        ...finiteSamples.map(s => Number(s.loss)),
      ].filter(v => Number.isFinite(v));
      const lMin = 0;
      const lMax = allL.length ? Math.max(Math.max(...allL) * 1.12, 1e-4) : 1;
      const lSpan = Math.max(lMax - lMin, 1e-6);
      const toY = v => lossBottom - ((Math.max(0, v) - lMin) / lSpan) * lossH;

      const basePts = bins.map(b => {
        const tMid = (b.tFrom + b.tTo) / 2;
        const valid = b.count > 0 && b.mean_loss != null;
        const isExcluded = (excluded.hasMax && b.tFrom >= excluded.maxT - 1e-6) || (excluded.hasMin && b.tTo <= excluded.minT + 1e-6);
        return {
          x: toX(tMid),
          y: valid ? toY(b.mean_loss) : null,
          yP25: (valid && b.p25 != null) ? toY(b.p25) : null,
          yP75: (valid && b.p75 != null) ? toY(b.p75) : null,
          comparable: b.comparable !== false && valid,
          valid,
          excluded: isExcluded,
        };
      });
      const basePaths = this._ddBuildSegmentedLossPaths(basePts, lossBottom);
      const iqrSegs = [];
      let iqrSpan = [];
      const flushIqr = () => {
        if (iqrSpan.length >= 2) {
          const top = iqrSpan.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.yP75.toFixed(1)).join(' ');
          const bot = iqrSpan.slice().reverse().map(p => 'L' + p.x.toFixed(1) + ' ' + p.yP25.toFixed(1)).join(' ');
          iqrSegs.push(`${top} ${bot} Z`);
        }
        iqrSpan = [];
      };
      for (const p of basePts) {
        if (p.excluded) flushIqr();
        else if (p.yP25 != null && p.yP75 != null) iqrSpan.push(p);
      }
      flushIqr();
      const iqrHtml = iqrSegs.length ? `<path class="m-dd-ts-iqr-band" d="${iqrSegs.join(' ')}"/>` : '';
      const isoDotsHtml = basePaths.isolated.map(p =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" fill="var(--text-secondary)" opacity=".85"/>`
      ).join('');

      const epNums = [...finiteSamples, ...nfValid].map(s => s.epoch).filter(v => v != null && Number.isFinite(Number(v))).map(Number);
      const epMin = epNums.length ? Math.min(...epNums) : 1;
      const epMax = epNums.length ? Math.max(...epNums) : 1;
      const epAlpha = ep => (ep == null || epMax <= epMin) ? 0.92 : (0.50 + 0.46 * ((Number(ep) - epMin) / (epMax - epMin)));

      const finiteDots = finiteSamples.map(s => {
        const t1000 = this._ddToTimestep1000(s.timestep, scale);
        if (t1000 == null) return null;
        const cx = toX(t1000), cy = toY(s.loss);
        const fill = this._ddResidualColor(s.residual, { kind: 'graphic' });
        return { ...s, t1000, cx, cy, fill, opacity: epAlpha(s.epoch), non_finite: false };
      }).filter(Boolean);
      const nanTrackY = 16;
      const nfDots = nfValid.map(s => ({
        ...s,
        cx: toX(s.t1000),
        cy: nanTrackY,
        fill: 'var(--danger)',
        opacity: 0.96,
        non_finite: true,
      }));

      const barBins = bins.length
        ? bins
        : Array.from({ length: 18 }, (_, i) => ({ bin: i, tFrom: i * (1000 / 18), tTo: (i + 1) * (1000 / 18) }));
      const barCounts = new Array(barBins.length).fill(0);
      for (const d of [...finiteDots, ...nfDots]) {
        const idx = barBins.findIndex(b => d.t1000 >= b.tFrom && (d.t1000 < b.tTo || (b.tTo >= 999.9 && d.t1000 <= 1000)));
        if (idx >= 0) barCounts[idx] += 1;
      }
      const maxBarCount = Math.max(1, ...barCounts);
      const densityBarsHtml = barBins.map((b, idx) => {
        const cnt = barCounts[idx];
        if (!cnt) return '';
        const xLeft = toX(b.tTo);
        const xRight = toX(b.tFrom);
        const colW = Math.max(2, xRight - xLeft);
        const xCenter = (xLeft + xRight) / 2;
        const barW = Math.max(3, Math.min(24, colW - 2));
        const barX = xCenter - barW / 2;
        const bh = Math.max(3, (cnt / maxBarCount) * densityH);
        const tMid = (b.tFrom + b.tTo) / 2;
        const zKey = tMid >= 2000 / 3 ? 'high' : (tMid >= 1000 / 3 ? 'mid' : 'low');
        return `<rect class="m-dd-ts-density-bar m-dd-modal-density-bar" data-dd-modal-bin="${idx}" data-dd-zone="${zKey}" x="${barX.toFixed(1)}" y="${(plotBottom - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.2"/>`;
      }).join('');

      const finiteClusters = this._ddClusterModalDots(finiteDots, 5.5);
      const nfClusters = this._ddClusterModalDots(nfDots, 5.5);

      const zoneOf = t1000 => (t1000 >= 2000 / 3 ? 'high' : (t1000 >= 1000 / 3 ? 'mid' : 'low'));
      const dotsHtml = finiteClusters.map(c => {
        const epochsAttr = Array.from(new Set(c.items.map(it => it.epoch).filter(v => v != null))).join(',');
        const dotZone = zoneOf(c.t1000);
        const isMulti = c.items.length > 1;
        const ring = isMulti
          ? `<circle class="m-dd-cluster-ring" data-dd-ts-dot-epochs="${this.esc(epochsAttr)}" data-dd-zone="${dotZone}" cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="6.2"/>`
          : '';
        return ring + `<circle class="m-dd-modal-dot" data-dd-ts-dot-epochs="${this.esc(epochsAttr)}" data-dd-zone="${dotZone}" cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="${isMulti ? '4.1' : '3.6'}" style="fill:${c.fill};fill-opacity:${c.opacity.toFixed(2)}" stroke="var(--monitor-card-bg)" stroke-width="1.1"/>`;
      }).join('') + nfClusters.map(c => {
        const epochsAttr = Array.from(new Set(c.items.map(it => it.epoch).filter(v => v != null))).join(',');
        const dotZone = zoneOf(c.t1000);
        const isMulti = c.items.length > 1;
        const ring = isMulti
          ? `<circle class="m-dd-cluster-ring is-danger" data-dd-ts-dot-epochs="${this.esc(epochsAttr)}" data-dd-zone="${dotZone}" cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="6.2"/>`
          : '';
        return ring + `<g class="m-dd-nan-mark" data-dd-ts-dot-epochs="${this.esc(epochsAttr)}" data-dd-zone="${dotZone}"><line x1="${(c.cx - 3.2).toFixed(1)}" y1="${(c.cy - 3.2).toFixed(1)}" x2="${(c.cx + 3.2).toFixed(1)}" y2="${(c.cy + 3.2).toFixed(1)}"/><line x1="${(c.cx + 3.2).toFixed(1)}" y1="${(c.cy - 3.2).toFixed(1)}" x2="${(c.cx - 3.2).toFixed(1)}" y2="${(c.cy + 3.2).toFixed(1)}"/></g>`;
      }).join('');

      const xDiv667 = toX(2000 / 3);
      const xDiv333 = toX(1000 / 3);
      const exclPatId = 'm-dd-modal-excl-' + (this.selectedRunDir ? 'h' : 'l');
      let excludedHtml = '';
      if (excluded.hasMax) {
        const xBound = toX(excluded.maxT);
        const w = Math.max(0, xBound - padL);
        if (w > 1) {
          excludedHtml += `<rect class="m-dd-ts-excluded" x="${padL}" y="${lossTop}" width="${w.toFixed(1)}" height="${(plotBottom - lossTop).toFixed(1)}" fill="url(#${exclPatId})"/>`
            + `<line class="m-dd-ts-excluded-line" x1="${xBound.toFixed(1)}" x2="${xBound.toFixed(1)}" y1="${lossTop}" y2="${plotBottom}"/>`;
        }
      }
      if (excluded.hasMin) {
        const xBound = toX(excluded.minT);
        const w = Math.max(0, (padL + plotW) - xBound);
        if (w > 1) {
          excludedHtml += `<rect class="m-dd-ts-excluded" x="${xBound.toFixed(1)}" y="${lossTop}" width="${w.toFixed(1)}" height="${(plotBottom - lossTop).toFixed(1)}" fill="url(#${exclPatId})"/>`
            + `<line class="m-dd-ts-excluded-line" x1="${xBound.toFixed(1)}" x2="${xBound.toFixed(1)}" y1="${lossTop}" y2="${plotBottom}"/>`;
        }
      }

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', stageH >= 80 ? '100%' : String(height));
      svg.innerHTML = `
        <defs>
          <pattern id="${exclPatId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--bg-sunken)" fill-opacity="0.34"/>
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-tertiary)" stroke-opacity="0.28" stroke-width="1.5"/>
          </pattern>
        </defs>
        ${excludedHtml ? `<g class="m-dd-ts-excluded-group">${excludedHtml}</g>` : ''}
        ${hasNanTrack ? `<g class="m-dd-nan-lane">
          <rect class="m-dd-nan-track" x="${padL}" y="6" width="${plotW}" height="20" rx="3"/>
          <line class="m-dd-nan-sep" x1="${padL}" x2="${padL + plotW}" y1="28" y2="28"/>
          <text class="m-dd-nan-axis" x="${padL - 6}" y="19" text-anchor="end">${this.esc(t('ddStatusNonFinite'))}</text>
        </g>` : ''}
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${lossTop}" y2="${lossTop}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${((lossTop + lossBottom) / 2).toFixed(1)}" y2="${((lossTop + lossBottom) / 2).toFixed(1)}" opacity="0.45"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${lossBottom}" y2="${lossBottom}" opacity="0.6"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${plotBottom}" y2="${plotBottom}" class="is-axis"/>
        </g>
        ${iqrHtml}
        ${basePaths.solidD ? `<path class="m-dd-base-line is-ref" d="${basePaths.solidD}"/>` : ''}
        ${basePaths.sparseD ? `<path class="m-dd-base-line is-sparse" d="${basePaths.sparseD}"/>` : ''}
        ${basePaths.gapD ? `<path class="m-dd-base-line is-gap" d="${basePaths.gapD}"/>` : ''}
        ${isoDotsHtml}
        <g data-dd-modal-density>${densityBarsHtml}</g>
        <line class="m-dd-mini-ch" data-dd-ts-ch x1="0" x2="0" y1="${lossTop}" y2="${plotBottom}" display="none"/>
        <g>${dotsHtml}</g>
        <circle class="m-dd-dot-focus" data-dd-ts-focus r="6.5" stroke="var(--accent)" display="none"/>
        <g class="m-chart-axes">
          <text x="${padL - 6}" y="${lossTop + 4}" text-anchor="end">${allL.length ? this._ddFormatLoss(lMax) : ''}</text>
          <text x="${padL - 6}" y="${lossBottom + 2}" text-anchor="end">0</text>
          <text x="${padL}" y="${height - 4}" text-anchor="start">1000</text>
          <text x="${xDiv667.toFixed(1)}" y="${height - 4}" text-anchor="middle">667</text>
          <text x="${xDiv333.toFixed(1)}" y="${height - 4}" text-anchor="middle">333</text>
          <text x="${padL + plotW}" y="${height - 4}" text-anchor="end">0</text>
        </g>`;

      stage._ddState = {
        dots: [...finiteDots, ...nfDots],
        clusters: [...finiteClusters, ...nfClusters],
        bins,
        barBins,
        scale,
        stageW: width,
        stageH: height,
      };
    },
  };
})();
