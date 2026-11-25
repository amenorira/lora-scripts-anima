/* 训练集诊断渲染、交互式 SVG 图表与单图审片弹窗；由 monitor-render.js 装配。 */
(() => {
  window.monitorDatasetDiagRenderMixin = {
    _ddResidualColor(residual) {
      if (residual == null || !Number.isFinite(Number(residual))) return 'var(--text-secondary)';
      const val = Number(residual);
      if (Math.abs(val) < 0.005) return 'color-mix(in srgb, var(--text-primary) 84%, var(--text-secondary))';
      if (val < 0) {
        const t = Math.min(1, Math.pow(Math.abs(val) / 0.25, 0.58));
        const pct = Math.round(16 + t * 74);
        return `color-mix(in srgb, var(--success) ${pct}%, var(--text-primary))`;
      }
      if (val <= 0.20) {
        const t = Math.min(1, Math.pow(val / 0.20, 0.58));
        const pct = Math.round(18 + t * 74);
        return `color-mix(in srgb, var(--warning) ${pct}%, var(--text-primary))`;
      }
      const t = Math.min(1, (val - 0.20) / 0.28);
      const pct = Math.round(t * 95);
      return `color-mix(in srgb, var(--danger) ${pct}%, var(--warning))`;
    },

    _ddSlopeColor(slope) {
      if (slope == null || slope === '' || !Number.isFinite(Number(slope))) return 'var(--text-secondary)';
      const val = Number(slope);
      if (val <= -0.02) return 'color-mix(in srgb, var(--success) 86%, var(--text-primary))';
      if (val >= 0.01) return 'color-mix(in srgb, var(--danger) 82%, var(--text-primary))';
      return 'color-mix(in srgb, var(--text-primary) 82%, var(--text-secondary))';
    },

    _ddFormatResidual(value) {
      if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
      let pct = Number(value) * 100;
      if (Math.abs(pct) < 0.05) pct = 0;
      return (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
    },

    _ddFormatSlope(value) {
      if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
      let pct = Number(value) * 100;
      if (Math.abs(pct) < 0.05) pct = 0;
      return (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
    },

    _ddFormatLoss(value) {
      if (value == null || value === '' || !Number.isFinite(Number(value))) return '—';
      const n = Number(value);
      if (Math.abs(n) > 0 && Math.abs(n) < 0.001) return n.toExponential(2);
      return n.toFixed(4);
    },

    _ddToTimestep1000(value, scale) {
      if (scale === 'unknown' || value == null || value === '' || !Number.isFinite(Number(value))) return null;
      const n = Number(value);
      const scaled = scale === 'unit' ? n * 1000 : n;
      return Math.max(0, Math.min(1000, scaled));
    },

    _ddFormatTimestep(value, scale) {
      if (scale === 'unknown' && value != null && value !== '' && Number.isFinite(Number(value))) return String(value);
      const t1000 = this._ddToTimestep1000(value, scale);
      return t1000 == null ? '—' : String(Math.round(t1000));
    },

    _ddFormatResolution(value) {
      if (value == null || value === '') return '';
      return String(value).replace(/(\d+)\s*[xX×]\s*(\d+)/g, '$1 × $2');
    },

    _ddStatusMeta(t, status, slope = null) {
      if (status === 'non_finite') return { label: t('ddStatusNonFinite'), tone: 'danger' };
      if (status === 'attention') {
        return {
          label: slope == null ? t('ddTrendPending')
            : slope < 0 ? t('ddSlowDrop') : t('ddStatusUnconverged'),
          tone: 'warn',
        };
      }
      if (status === 'learning') return { label: t('ddStatusLearning'), tone: 'info' };
      if (status === 'insufficient_reference') return { label: t('ddReferenceFew'), tone: 'muted' };
      if (status === 'easy') return { label: t('ddStatusLow'), tone: 'neutral' };
      if (status === 'insufficient') return { label: t('ddStatusInsufficient'), tone: 'muted' };
      return { label: t('ddStatusNormal'), tone: 'neutral' };
    },

    _ddSelectHtml(options, value, label, id, action, valueBinding = '', optionsBinding = '') {
      if (typeof window.previewSelectHtml === 'function') {
        const handler = action.replaceAll('$event.target.value', '$event.detail')
          + '; $nextTick(() => document.getElementById(' + JSON.stringify(id) + ')?.focus({ preventScroll: true }))';
        const select = valueBinding || optionsBinding
          ? window.previewSelectHtml(options, value, label, id, valueBinding, optionsBinding)
          : window.previewSelectHtml(options, value, label, id);
        return '<div class="m-sample-select m-dd-select" @preview-select="' + this.esc(handler) + '">' + select + '</div>';
      }
      return '<select id="' + this.esc(id) + '" class="m-dd-native-select" aria-label="' + this.esc(label) + '"'
        + (valueBinding ? ' :value="' + this.esc(valueBinding) + '"' : '') + ' @change="' + this.esc(action) + '">'
        + options.map(opt => '<option value="' + this.esc(opt.value) + '"' + (String(opt.value) === String(value) ? ' selected' : '') + '>'
          + this.esc(opt.label) + '</option>').join('')
        + '</select>';
    },

    _ddResidualBarHtml(residual, maxAbs = 0.6) {
      if (residual == null || !Number.isFinite(Number(residual))) {
        return '<div class="m-gauge m-gauge-change m-dd-gauge" aria-hidden="true"><div class="m-gauge-track"><span class="m-gauge-zero" style="left:50%"></span></div></div>';
      }
      const val = Number(residual);
      const bound = Math.max(0.45, Number(maxAbs) || 0.6);
      const knee = 0.20;
      const denom = Math.log1p(bound / knee);
      const norm = Math.sign(val) * (Math.log1p(Math.abs(val) / knee) / Math.max(denom, 1e-6));
      const pos = Math.max(2, Math.min(98, 50 + norm * 48));
      const isNeg = val < -0.002;
      const isPos = val > 0.002;
      const left = isNeg ? pos : 50;
      const width = isNeg || isPos ? Math.max(1.5, Math.abs(pos - 50)) : 0;
      const color = this._ddResidualColor(val);
      return '<div class="m-gauge m-gauge-change m-dd-gauge" aria-hidden="true"><div class="m-gauge-track">'
        + '<span class="m-gauge-zero" style="left:50%"></span>'
        + '<span class="m-gauge-fill ' + (isNeg ? 'is-neg' : 'is-pos') + '" style="left:' + left.toFixed(1)
        + '%;width:' + width.toFixed(1) + '%;--gauge-bar-color:' + color + '"></span>'
        + '</div></div>';
    },

    _ddMinCountOptions() {
      const t = (k, fb) => this.tMonitor(k, fb);
      return [1, 3, 5, 10].map(n => ({
        value: n,
        label: t('ddMinCountOpt').replace('{n}', n),
      }));
    },

    _ddRunOptions() {
      const t = (k, fb) => this.tMonitor(k, fb);
      const runs = Array.isArray(this.datasetDiagData?.available_runs) ? this.datasetDiagData.available_runs : [];
      const items = runs.slice().reverse().map((id, i) => {
        const shortId = String(id).length > 8 ? String(id).slice(0, 8) : String(id);
        const num = runs.length - i;
        const label = i === 0
          ? t('ddRunLatest').replace('{id}', shortId)
          : t('ddRunSegment').replace('{n}', num).replace('{id}', shortId);
        return { value: String(id), label };
      });
      if (runs.length > 1) {
        items.unshift({
          value: 'all',
          label: t('ddRunAll').replace('{n}', runs.length),
        });
      }
      return items;
    },

    _ddSortOptions() {
      const t = (k, fb) => this.tMonitor(k, fb);
      return [
        { value: 'residual_desc', label: t('ddSortResidualDesc') },
        { value: 'residual_asc', label: t('ddSortResidualAsc') },
        { value: 'slope_desc', label: t('ddSortSlopeDesc') },
        { value: 'slope_asc', label: t('ddSortSlopeAsc') },
        { value: 'loss_desc', label: t('ddSortLossDesc') },
        { value: 'count_desc', label: t('ddSortCountDesc') },
        { value: 'name_asc', label: t('ddSortNameAsc') },
      ];
    },

    _ddNoiseZonesSummaryHtml(t, data) {
      const nz = data.noise_zones || {};
      const zones = [
        ['high', t('ddZoneHigh'), '1000–667'],
        ['mid', t('ddZoneMid'), '667–333'],
        ['low', t('ddZoneLow'), '333–0'],
      ];
      let html = '<div class="m-dd-zones-strip" data-dd-hero-zones>';
      zones.forEach(([key, label, range]) => {
        const z = nz[key];
        const count = Number(z?.count || 0);
        const sharePct = count > 0 ? Math.round(Number(z.share || 0) * 100) : 0;
        const lossText = count > 0 ? this._ddFormatLoss(z.mean_loss) : '—';
        html += '<div class="m-dd-zone-col">';
        html += '<div class="m-dd-zone-title"><span>' + this.esc(label) + '</span><span class="m-dd-zone-range">' + this.esc(range) + '</span></div>';
        html += '<div class="m-dd-zone-vals"><strong class="m-dd-num-val">' + this.esc(lossText) + '</strong>'
          + '<span class="m-dd-zone-share">'
          + (count > 0
            ? this.esc(t('ddZoneShareCount').replace('{pct}', sharePct).replace('{n}', count))
            : this.esc(t('ddZoneEmpty')))
          + '</span></div>';
        html += '</div>';
      });
      html += '</div>';
      return html;
    },

    _renderDatasetDiagTab(t) {
      const data = this.datasetDiagData;
      const runDir = this.selectedRunDir || this.currentOutputRunDir || '';
      const hasSource = !!(runDir || (!this.selectedRunDir && this.liveTaskId));

      if (!hasSource) {
        return '<div class="m-section m-dd-section"><div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6M11 8v6"/></svg>'
          + '<p>' + this.esc(t('ddEmptyNoRun')) + '</p></div></div>';
      }

      if (this.datasetDiagLoading && !data) {
        return '<div class="m-section m-dd-section"><div class="dashboard-empty" role="status"><p>' + this.esc(t('loading')) + '</p></div></div>';
      }

      if (this.datasetDiagError && !data) {
        return '<div class="m-section m-dd-section"><div class="dashboard-empty dashboard-empty-danger"><p>' + this.esc(t('ddLoadFailed')) + '</p>'
          + '<button type="button" class="btn btn-sm btn-secondary" @click="refreshDatasetDiagnostics()">' + this.esc(t('refresh')) + '</button></div></div>';
      }

      if (!data || !data.available) {
        const reason = data?.reason || 'not_recorded';
        const copyMap = {
          unsupported_engine: 'ddEmptyUnsupported',
          waiting: 'ddEmptyWaiting',
          empty: 'ddEmptyNoSamples',
          not_recorded: 'ddEmptyNotRecorded',
          no_run: 'ddEmptyNoRun',
        };
        const reasonKey = copyMap[reason] || copyMap.not_recorded;
        let html = '<div class="m-section m-dd-section">' + (data?.available_runs?.length > 1 || this.datasetDiagError ? this._renderDatasetDiagHeading(t, data || {}) : '')
          + '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><circle cx="9" cy="14" r="1.5"/><circle cx="14" cy="9" r="1.5"/><circle cx="18" cy="12" r="1.5"/></svg>'
          + '<p>' + this.esc(t(reasonKey)) + '</p>';
        if (reason === 'waiting') {
          html += '<button type="button" class="btn btn-sm btn-secondary" @click="refreshDatasetDiagnostics()">' + this.esc(t('refresh')) + '</button>';
        }
        return html + '</div></div>';
      }

      return this._datasetDiagShellHtml(t, data);
    },

    _ddActiveAnalysisMode(data) {
      if (this.datasetDiagHeroMode === 'timestep') return 'timestep';
      const hasGroups = typeof this._ddHasGroupComparison === 'function'
        ? this._ddHasGroupComparison(data)
        : ['resolution', 'subset', 'directory', 'batch_size'].some(d => (data?.['by_' + d] || []).length >= 2);
      if (this.datasetDiagHeroMode === 'groups' && hasGroups) return 'groups';
      return 'quadrant';
    },

    _datasetDiagShellHtml(t, data = null) {
      return '<div class="m-section m-dd-section" data-dd-shell="1">'
        + '<div data-dd-slot="heading">' + (data ? this._renderDatasetDiagHeading(t, data) : '') + '</div>'
        + '<div data-dd-slot="analysis">' + (data ? this._renderDatasetDiagAnalysisCard(t, data) : '') + '</div>'
        + '<div data-dd-slot="images">' + (data ? this._renderDatasetDiagImagesCard(t, data) : '') + '</div>'
        + '</div>';
    },

    _renderDatasetDiagAnalysisCard(t, data) {
      const mode = this._ddActiveAnalysisMode(data);
      const hasGroups = typeof this._ddHasGroupComparison === 'function'
        ? this._ddHasGroupComparison(data)
        : ['resolution', 'subset', 'directory', 'batch_size'].some(d => (data?.['by_' + d] || []).length >= 2);

      let html = '<section class="m-console-card m-dd-analysis" data-dd-analysis>';
      html += '<div class="m-card-heading m-dd-analysis-head">';
      html += '<div class="m-dd-analysis-title-wrap"><span>' + this.esc(t('ddAnalysis')) + '</span>'
        + (mode === 'quadrant' ? '<span class="m-dd-qualified" data-dd-chart-coverage></span>' : '')
        + '</div>';
      html += '<div class="m-dd-analysis-head-ctl">';
      html += '<div class="m-segmented m-chart-modes" role="tablist" aria-label="' + this.esc(t('ddAnalysis')) + '">';
      html += '<button type="button" id="ddAnalysisModeQuadrant" role="tab" class="m-segmented-btn' + (mode === 'quadrant' ? ' active' : '') + '" aria-selected="' + (mode === 'quadrant') + '" @click="setDatasetDiagHeroMode(\'quadrant\')">'
        + this.esc(t('ddHeroScatter')) + '</button>';
      html += '<button type="button" id="ddAnalysisModeTimestep" role="tab" class="m-segmented-btn' + (mode === 'timestep' ? ' active' : '') + '" aria-selected="' + (mode === 'timestep') + '" @click="setDatasetDiagHeroMode(\'timestep\')">'
        + this.esc(t('ddHeroNoise')) + '</button>';
      if (hasGroups) {
        html += '<button type="button" id="ddAnalysisModeGroups" role="tab" class="m-segmented-btn' + (mode === 'groups' ? ' active' : '') + '" aria-selected="' + (mode === 'groups') + '" @click="setDatasetDiagHeroMode(\'groups\')">'
          + this.esc(t('ddGroupsTitle')) + '</button>';
      }
      html += '</div></div></div>';
      html += mode === 'groups' ? this._renderDatasetDiagGroupsCard(t, data) : this._renderDatasetDiagHeroSlot(t, data);
      html += '</section>';
      return html;
    },

    _renderDatasetDiagHeading(t, data) {
      const summary = data.summary || {};
      const availableRuns = Array.isArray(data.available_runs) ? data.available_runs : [];
      const activeRunId = this.datasetDiagRunId || data.run_id || '';

      const metaSpans = data.available ? [
        '<span>' + this.esc(t('ddMetaImages').replace('{n}', summary.images_total || 0)) + '</span>',
        '<span>' + this.esc(t('ddMetaSamples').replace('{n}', (summary.samples || 0) + (summary.non_finite_total || 0))) + '</span>',
      ] : [];
      if (summary.epoch_from != null && summary.epoch_to != null) {
        const epLabel = t('ddEpochLabel');
        metaSpans.push('<span>' + this.esc(summary.epoch_from === summary.epoch_to
          ? `${epLabel} ${summary.epoch_to}`
          : `${epLabel} ${summary.epoch_from}–${summary.epoch_to}`) + '</span>');
      }
      if ((summary.non_finite_total || 0) > 0) {
        metaSpans.push('<span class="is-danger">' + this.esc(t('ddMetaNanCount').replace('{n}', summary.non_finite_total)) + '</span>');
      }

      const infoLabel = t('ddInfoTooltip');
      const infoIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

      let html = '<section class="m-console-card m-dd-overview">';
      html += '<div class="m-card-heading m-diagnostic-heading">';
      html += '<div class="m-dd-title-block"><div class="m-dd-title-row"><span>' + this.esc(t('datasetDiagnostics')) + '</span>'
        + '<button type="button" id="ddInfoBtn" class="m-dd-info-btn" @click="openParameterDoc(\'dataset-diagnostics\')"'
        + ' aria-haspopup="dialog" title="' + this.esc(infoLabel) + '" aria-label="' + this.esc(infoLabel) + '">'
        + infoIcon + '</button></div>'
        + '<div class="m-dd-head-meta">' + metaSpans.join('') + '</div></div>';
      html += '<div class="m-diagnostic-heading-actions">';
      if (availableRuns.length > 1) {
        html += '<label class="m-dd-inline-ctl m-dd-run-wrap"><span>' + this.esc(t('ddRunSegmentLabel')) + '</span>'
          + this._ddSelectHtml(this._ddRunOptions(), activeRunId, t('ddRunSegmentLabel'),
            'ddRunSelect', 'setDatasetDiagRunId($event.target.value)', 'datasetDiagRunId', '_ddRunOptions()')
          + '</label>';
      }
      if (data.available) {
        html += '<label class="m-dd-inline-ctl" title="' + this.esc(t('ddMinSamplesHint')) + '">'
          + '<span>' + this.esc(t('ddMinSamplesLabel')) + '</span>'
          + this._ddSelectHtml(this._ddMinCountOptions(), this.datasetDiagMinCount, t('ddMinSamplesLabel'),
            'ddMinCountSelect', 'setDatasetDiagMinCount($event.target.value)', 'datasetDiagMinCount', '_ddMinCountOptions()')
          + '</label>';
        if ((summary.images_qualified || 0) < (summary.images_total || 0)) {
          html += '<span class="m-dd-qualified">' + this.esc(t('ddQualified').replace('{n}', summary.images_qualified || 0).replace('{total}', summary.images_total || 0)) + '</span>';
        }
      }
      html += '<button type="button" id="ddRefreshBtn" class="btn btn-sm btn-secondary refresh-button" :class="{ \'is-loading\': datasetDiagLoading || datasetDiagRefreshFeedback }" @click="refreshDatasetDiagnostics()" :disabled="datasetDiagLoading">'
        + this._refreshIconHtml() + '<span>' + this.esc(t('refresh')) + '</span></button></div></div>';
      if (this.datasetDiagError) html += '<div class="m-dd-notice-strip" role="alert">' + this.esc(t('ddRefreshFailed')) + '</div>';
      if (summary.multi_gpu_partial) html += '<div class="m-dd-notice-strip">' + this.esc(t('ddMultiGpuNotice')) + '</div>';
      if (summary.unknown_timestep_count > 0) html += '<div class="m-dd-notice-strip">' + this.esc(t('ddUnknownTimestep').replace('{n}', summary.unknown_timestep_count)) + '</div>';
      return html + '</section>';
    },

    _renderDatasetDiagHeroSlot(t, data) {
      const summary = data.summary || {};
      const counts = summary.counts || {};
      const hasSlope = !!summary.has_slope;
      const heroMode = this.datasetDiagHeroMode === 'timestep' ? 'timestep' : 'quadrant';
      let html = '<section class="m-dd-analysis-chart">';

      if (!hasSlope && heroMode === 'quadrant') html += '<div class="m-dd-notice-strip">' + this.esc(t('ddEarlySlopeHint')) + '</div>';

      html += '<div class="m-hero-chart-wrap m-dd-hero-wrap" data-dd-hero-wrap data-mode="' + this.esc(heroMode) + '">';

      // Row 1 (always static, never mutates on hover)
      let axisCaption = '';
      let legendHtml = '';
      if (heroMode === 'timestep') {
        axisCaption = t('ddTimestepAxisDesc');
        legendHtml = '<span class="m-dd-leg"><i class="is-bar-peak"></i><span>' + this.esc(t('ddLegPeakBin')) + '</span></span>'
          + '<span class="m-dd-leg"><i class="is-bar-base"></i><span>' + this.esc(t('ddLegMeanBin')) + '</span></span>';
      } else if (hasSlope) {
        axisCaption = t('ddQuadAxisDesc');
        legendHtml = '<span class="m-dd-leg"><i class="is-zone"></i><span>' + this.esc(t('ddPresetAttention')) + '</span></span>'
          + '<span class="m-dd-leg"><i class="is-dot is-high"></i><span>' + this.esc(t('ddStatusHighResidual')) + '</span></span>'
          + '<span class="m-dd-leg"><i class="is-dot is-ok"></i><span>' + this.esc(t('ddLegNegResidual')) + '</span></span>';
        if ((counts.non_finite || 0) > 0) {
          legendHtml += '<span class="m-dd-leg"><i class="is-nan-ring"></i><span>' + this.esc(t('ddStatusNonFinite')) + '</span></span>';
        }
      } else {
        axisCaption = t('ddEarlyAxisDesc');
        legendHtml = '<span class="m-dd-leg"><i class="is-line-dash-warn"></i><span>' + this.esc(t('ddLegHighThresh')) + '</span></span>';
        if ((counts.non_finite || 0) > 0) {
          legendHtml += '<span class="m-dd-leg"><i class="is-nan-ring"></i><span>' + this.esc(t('ddStatusNonFinite')) + '</span></span>';
        }
      }
      html += '<div class="m-dd-chart-bar"><span class="m-dd-axis-summary">' + this.esc(axisCaption) + '</span>'
        + '<div class="m-dd-legend">' + legendHtml + '</div></div>';

      // Row 2 (fixed-height readout strip; no shifting/wrapping on hover)
      const idleHint = heroMode === 'timestep'
        ? t('ddTimestepHoverHint')
        : t('ddScatterHoverHint');
      html += '<div class="m-dd-readout-bar">'
        + '<span class="m-dd-ro-idle" data-dd-hud-range>' + this.esc(idleHint) + '</span>'
        + '<div class="m-dd-ro-live" data-dd-hud-readout></div>'
        + '</div>';

      if (heroMode === 'timestep') {
        html += this._ddNoiseZonesSummaryHtml(t, data);
      }

      html += '<div class="m-hero-chart-stage m-dd-hero-stage" data-dd-hero-stage><svg class="m-dd-hero-svg" data-dd-hero-svg aria-hidden="true"></svg></div>';
      html += '<div class="m-chart-preview-pop m-dd-preview-pop" data-dd-preview-pop hidden>'
        + '<div class="m-preview-pop-main"><img alt="" decoding="async"/></div>'
        + '<div class="m-chart-preview-foot"><strong x-loop-marquee.bounce><span data-dd-pop-title></span></strong>'
        + '<span class="m-dd-pop-hint">' + this.esc(t('ddPopClickHint')) + '</span></div></div>';
      html += '</div></section>';
      return html;
    },

    _renderDatasetDiagGroupsCard(t, data) {
      const dims = [
        ['resolution', t('ddDimResolution'), data.by_resolution || []],
        ['subset', t('ddDimSubset'), data.by_subset || []],
        ['directory', t('ddDimDirectory'), data.by_directory || []],
        ['batch_size', t('ddDimBatchSize'), data.by_batch_size || []],
      ];
      if (!dims.some(d => d[2].length >= 2)) return '';

      const activeDim = this.datasetDiagGroupDim || 'resolution';
      const activeRows = (dims.find(d => d[0] === activeDim)?.[2]) || [];
      const maxAbs = activeRows.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0)), 0.45);
      const gf = this.datasetDiagGroupFilter;
      const canFilterByDim = activeDim !== 'batch_size';

      let html = '<section class="m-dd-groups">';
      html += '<div class="m-dd-groups-bar">';
      html += '<div class="m-segmented" role="tablist" aria-label="' + this.esc(t('ddGroupsTitle')) + '">';
      dims.forEach(([dim, label, rows]) => {
        const active = dim === activeDim;
        html += '<button type="button" id="ddGroupDim_' + this.esc(dim) + '" role="tab" class="m-segmented-btn' + (active ? ' active' : '') + '"'
          + ' aria-selected="' + active + '"' + (rows.length ? '' : ' disabled')
          + ' @click="setDatasetDiagGroupDim(\'' + dim + '\')">'
          + this.esc(label) + (rows.length ? ' <small class="m-dd-tab-n">' + rows.length + '</small>' : '')
          + '</button>';
      });
      html += '</div>';
      html += '<small class="m-dd-groups-hint">' + this.esc(canFilterByDim ? t('ddGroupsHint') : t('ddGroupsBatchHint')) + '</small>';
      html += '</div>';

      if (!activeRows.length) {
        html += '<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('ddNoGroupData')) + '</p></div>';
      } else {
        html += '<div class="m-dd-group-table">';
        html += '<div class="m-dd-group-head"><span>' + this.esc(t('ddColGroup')) + '</span>'
          + '<span class="m-dd-num-col">' + this.esc(t('ddColImages')) + '</span>'
          + '<span class="m-dd-num-col">' + this.esc(t('ddColSamples')) + '</span>'
          + '<span class="m-dd-num-col">' + this.esc(t('ddColMeanLoss')) + '</span>'
          + '<span class="m-dd-res-head">' + this.esc(t('ddColRelative')) + '</span></div>';
        activeRows.forEach(row => {
          const isSelected = gf && gf.dim === activeDim && gf.key === row.key;
          const resText = this._ddFormatResidual(row.mean_residual);
          const color = this._ddResidualColor(row.mean_residual);
          const rowLabel = activeDim === 'resolution' ? this._ddFormatResolution(row.label || row.key) : (row.label || row.key);
          const fullTitle = row.full_path || rowLabel;
          const attrs = canFilterByDim
            ? ' role="button" tabindex="0" aria-pressed="' + isSelected + '" @click="toggleDatasetDiagGroupFilter(\'' + this.esc(this.escapeJsString(activeDim)) + '\', \'' + this.esc(this.escapeJsString(row.key)) + '\', \'' + this.esc(this.escapeJsString(rowLabel)) + '\')" @keydown.enter.prevent="toggleDatasetDiagGroupFilter(\'' + this.esc(this.escapeJsString(activeDim)) + '\', \'' + this.esc(this.escapeJsString(row.key)) + '\', \'' + this.esc(this.escapeJsString(rowLabel)) + '\')"'
            : '';
          html += '<div class="m-dd-group-row' + (canFilterByDim ? ' is-clickable' : '') + (isSelected ? ' is-selected' : '') + '"' + attrs + '>';
          html += '<span class="m-dd-group-name" title="' + this.esc(fullTitle) + '"><span>' + this.esc(rowLabel) + '</span>'
            + (row.is_reg ? '<small class="output-dir-tag">' + this.esc(t('ddRegTag')) + '</small>' : '') + '</span>';
          html += '<span class="m-dd-num m-dd-num-col">' + this.esc(row.images) + '</span>';
          html += '<span class="m-dd-num m-dd-num-col">' + this.esc(row.count) + '</span>';
          html += '<span class="m-dd-num m-dd-num-col">' + this.esc(this._ddFormatLoss(row.mean_loss)) + '</span>';
          html += '<span class="m-dd-res-cell"><strong class="m-dd-num-val" style="color:' + color + '">' + this.esc(resText) + '</strong>' + this._ddResidualBarHtml(row.mean_residual, maxAbs) + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }
      html += '</section>';
      return html;
    },

    _renderDatasetDiagImagesCard(t, data) {
      const summary = data.summary || {};
      const counts = summary.counts || {};
      const filtered = this._datasetDiagFilteredImages();
      const limit = this.datasetDiagDisplayLimit || 120;
      const visible = filtered.slice(0, limit);
      const hasMore = filtered.length > visible.length;
      const viewMode = this.datasetDiagViewMode === 'table' ? 'table' : 'grid';
      const maxAbs = filtered.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0)), 0.55);

      const presets = [
        ['all', t('ddPresetAll'), summary.images_total || 0],
        ['attention', t('ddPresetAttention'), counts.attention || 0],
        ['learning', t('ddStatusLearning'), counts.learning || 0],
        ['easy', t('ddPresetLow'), counts.easy || 0],
      ];
      if ((counts.non_finite || 0) > 0) {
        presets.splice(3, 0, ['non_finite', t('ddPresetNonFinite'), counts.non_finite]);
      }

      let html = '<section id="datasetDiagImagesSection" class="m-console-card m-dd-images">';
      html += '<div class="m-card-heading m-dd-images-head">';
      html += '<div class="m-dd-images-title-wrap"><span>' + this.esc(t('ddImagesTitle')) + '</span>'
        + '<span class="m-logs-count">' + filtered.length + '</span></div>';
      html += '<div class="m-dd-images-head-ctl">';
      html += '<div class="m-segmented" role="group" aria-label="' + this.esc(t('ddPresetsLabel')) + '">';
      presets.forEach(([key, label, cnt]) => {
        const active = this.datasetDiagPreset === key;
        html += '<button type="button" class="m-segmented-btn' + (active ? ' active' : '') + '" aria-pressed="' + active + '" @click="setDatasetDiagPreset(\'' + key + '\')">'
          + this.esc(label) + ' <small class="m-dd-tab-n">' + cnt + '</small></button>';
      });
      html += '</div>';
      html += '<div class="m-segmented m-dd-view-switch" role="group" aria-label="' + this.esc(t('ddViewModeLabel')) + '">'
        + '<button type="button" class="m-segmented-btn' + (viewMode === 'grid' ? ' active' : '') + '" aria-pressed="' + (viewMode === 'grid') + '" @click="setDatasetDiagViewMode(\'grid\')" title="' + this.esc(t('ddViewGrid')) + '">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>'
        + '<span>' + this.esc(t('ddViewGrid')) + '</span></button>'
        + '<button type="button" class="m-segmented-btn' + (viewMode === 'table' ? ' active' : '') + '" aria-pressed="' + (viewMode === 'table') + '" @click="setDatasetDiagViewMode(\'table\')" title="' + this.esc(t('ddViewTable')) + '">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
        + '<span>' + this.esc(t('ddViewTable')) + '</span></button></div>';
      html += '</div></div>';

      html += '<div class="m-dd-subbar">';
      html += '<label class="m-output-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
        + '<input class="m-output-search-input" type="search" value="' + this.esc(this.datasetDiagSearch) + '"'
        + ' aria-label="' + this.esc(t('ddSearchImages')) + '" placeholder="' + this.esc(t('ddSearchImages')) + '"'
        + ' @input.debounce.180ms="setDatasetDiagSearch($event.target.value)"></label>';
      if (this.datasetDiagGroupFilter) {
        const gf = this.datasetDiagGroupFilter;
        html += '<button type="button" class="m-dd-filter-chip" @click="clearDatasetDiagGroupFilter()" title="' + this.esc(t('clearHistoryFilters')) + '">'
          + '<span>' + this.esc(gf.label || gf.key) + '</span><span aria-hidden="true">×</span></button>';
      }
      if (summary.has_reg_images) {
        html += '<div class="m-segmented" role="group" aria-label="' + this.esc(t('ddRegFilterLabel')) + '">';
        [
          ['all', this.t('cropPreview.includeReg') || t('ddRegInclude')],
          ['exclude', this.t('cropPreview.excludeReg') || t('ddRegExclude')],
          ['only', this.t('cropPreview.onlyReg') || t('ddRegOnly')],
        ].forEach(([mode, label]) => {
          const active = this.datasetDiagRegMode === mode;
          html += '<button type="button" class="m-segmented-btn' + (active ? ' active' : '') + '" aria-pressed="' + active + '" @click="setDatasetDiagRegMode(\'' + mode + '\')">' + this.esc(label) + '</button>';
        });
        html += '</div>';
      }
      html += '<div class="m-dd-sort-wrap">'
        + this._ddSelectHtml(this._ddSortOptions(), this.datasetDiagSort, t('ddSortLabel'),
          'ddSortSelect', 'setDatasetDiagSort($event.target.value)', 'datasetDiagSort', '_ddSortOptions()')
        + '</div>';
      html += '</div>';

      if (!visible.length) {
        html += '<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('ddNoMatchingImages')) + '</p>'
          + '<button type="button" class="btn btn-sm btn-secondary" @click="resetDatasetDiagFilters()">' + this.esc(t('clearHistoryFilters')) + '</button></div>';
        html += '</section>';
        return html;
      }

      if (viewMode === 'grid') {
        html += '<div class="m-dd-grid">';
        visible.forEach(img => {
          const resText = this._ddFormatResidual(img.mean_residual);
          const color = this._ddResidualColor(img.mean_residual);
          const slopeColor = this._ddSlopeColor(img.slope);
          const slopeText = img.slope != null
            ? (this._ddFormatSlope(img.slope) + t('ddSlopeUnit'))
            : t('ddZoneCount').replace('{n}', img.count);
          const statusMeta = this._ddStatusMeta(t, img.status, img.slope);
          const resoText = this._ddFormatResolution(img.resolution);
          const idJs = this.esc(this.escapeJsString(img.image_id));
          html += '<article class="m-dd-card" role="button" tabindex="0" data-dd-image-id="' + this.esc(img.image_id) + '"'
            + ' @click="openDatasetDiagModal(\'' + idJs + '\')" @keydown.enter.prevent="openDatasetDiagModal(\'' + idJs + '\')" @keydown.space.prevent="openDatasetDiagModal(\'' + idJs + '\')">';
          html += '<div class="m-dd-card-media">';
          if (img.thumb_url) {
            html += '<img src="' + this.esc(img.thumb_url) + '" alt="' + this.esc(img.name) + '" loading="lazy" decoding="async"/>';
          } else {
            html += '<div class="m-dd-media-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg><span>' + this.esc(t('ddLocalMissingShort')) + '</span></div>';
          }
          html += '</div>';
          html += '<div class="m-dd-card-body">';
          html += '<div class="m-dd-card-top"><strong class="m-dd-card-name" title="' + this.esc(img.image) + '">' + this.esc(img.name) + '</strong>'
            + '<span class="m-dd-card-res" style="color:' + color + '">' + this.esc(resText) + '</span></div>';
          html += '<div class="m-dd-card-metrics">'
            + '<span class="m-dd-card-slope" style="color:' + slopeColor + '">' + this.esc(slopeText) + '</span>'
            + '<span class="m-dd-card-reso">' + this.esc(resoText) + '</span></div>';
          html += '<div class="m-dd-card-foot">'
            + '<span class="m-dd-card-flag is-' + this.esc(statusMeta.tone) + '">' + this.esc(statusMeta.label) + '</span>'
            + (img.is_reg ? '<small class="output-dir-tag m-dd-card-reg">' + this.esc(t('ddRegTag')) + '</small>' : '')
            + '</div>';
          html += '</div></article>';
        });
        html += '</div>';
      } else {
        html += '<div class="m-dd-table-wrap"><div class="output-list output-table m-dd-table">';
        html += '<div class="output-table-head"><span></span><span>' + this.esc(t('ddColImage')) + '</span>'
          + '<span>' + this.esc(t('ddDimResolution')) + '</span>'
          + '<span class="m-dd-num-col">' + this.esc(t('ddColCountEpochs')) + '</span>'
          + '<span class="m-dd-num-col">' + this.esc(t('ddColMeanLoss')) + '</span>'
          + '<span class="m-dd-res-head">' + this.esc(t('ddColRelative')) + '</span>'
          + '<span class="m-dd-num-col">' + this.esc(t('ddColSlope')) + '</span>'
          + '<span>' + this.esc(t('ddColStatus')) + '</span></div>';
        visible.forEach(img => {
          const resText = this._ddFormatResidual(img.mean_residual);
          const color = this._ddResidualColor(img.mean_residual);
          const statusMeta = this._ddStatusMeta(t, img.status, img.slope);
          const idJs = this.esc(this.escapeJsString(img.image_id));
          html += '<div class="output-item m-dd-table-row" role="button" tabindex="0" data-dd-image-id="' + this.esc(img.image_id) + '"'
            + ' @click="openDatasetDiagModal(\'' + idJs + '\')" @keydown.enter.prevent="openDatasetDiagModal(\'' + idJs + '\')" @keydown.space.prevent="openDatasetDiagModal(\'' + idJs + '\')">';
          html += '<div class="m-dd-row-thumb">'
            + (img.thumb_url
              ? '<img src="' + this.esc(img.thumb_url) + '" alt="" loading="lazy" decoding="async"/>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>')
            + '</div>';
          html += '<div class="m-dd-row-name" title="' + this.esc(img.image) + '"><strong>' + this.esc(img.name) + '</strong>'
            + '<div class="m-dd-row-sub"><span>' + this.esc(img.dir_label) + '</span>'
            + (img.is_reg ? '<small class="output-dir-tag">' + this.esc(t('ddRegTag')) + '</small>' : '') + '</div></div>';
          html += '<span class="m-dd-num">' + this.esc(this._ddFormatResolution(img.resolution)) + '</span>';
          html += '<span class="m-dd-num m-dd-num-col">' + this.esc(img.count + ' / ' + img.epochs) + '</span>';
          html += '<span class="m-dd-num m-dd-num-col">' + this.esc(this._ddFormatLoss(img.mean_loss)) + '</span>';
          html += '<span class="m-dd-res-cell"><strong class="m-dd-num-val" style="color:' + color + '">' + this.esc(resText) + '</strong>' + this._ddResidualBarHtml(img.mean_residual, maxAbs) + '</span>';
          html += '<span class="m-dd-num m-dd-num-col" style="color:' + this._ddSlopeColor(img.slope) + '">' + this.esc(this._ddFormatSlope(img.slope)) + '</span>';
          html += '<span class="m-dd-pill is-' + this.esc(statusMeta.tone) + '">' + this.esc(statusMeta.label) + '</span>';
          html += '</div>';
        });
        html += '</div></div>';
      }

      if (hasMore) {
        const remaining = filtered.length - visible.length;
        html += '<div class="m-dd-more-row"><button type="button" class="btn btn-sm btn-secondary" @click="showMoreDatasetDiagImages()">'
          + this.esc(t('ddShowMore').replace('{n}', remaining)) + '</button></div>';
      }
      html += '</section>';
      return html;
    },

    // ═══════════════════════════════════════════════════════════════════════════
    //  Hero Charts (Quadrant Scatter / Early Distribution / Noise Bins 1000→0)
    // ═══════════════════════════════════════════════════════════════════════════
    _bindDatasetDiagCharts(panel) {
      if (!panel || panel.hidden || panel._ddHeroRO) return;
      const wrap = panel?.querySelector?.('[data-dd-hero-wrap]');
      if (!wrap) return;
      const stage = wrap.querySelector('[data-dd-hero-stage]');
      const svg = wrap.querySelector('[data-dd-hero-svg]');
      if (!stage || !svg) return;

      const clearHover = () => {
        wrap._ddHoverState = null;
        if (wrap._ddHoverFrame) cancelAnimationFrame(wrap._ddHoverFrame);
        wrap._ddHoverFrame = 0;
        this._clearDatasetDiagHeroHover(wrap);
      };

      const locate = event => {
        const st = wrap._ddChartState;
        if (!st) return;
        const rect = stage.getBoundingClientRect();
        if (!rect.width) return;
        const x = event.clientX - rect.left - Math.max(0, (rect.width - st.width) / 2);
        const y = event.clientY - rect.top;
        if (x < st.padL - 10 || x > st.padL + st.plotW + 10 || y < st.padT - 10 || y > st.padT + st.plotH + 10) return;
        return { x, y };
      };

      if (!wrap._ddBound) {
        wrap._ddBound = true;
        stage.addEventListener('pointermove', event => {
          wrap._ddHoverState = event;
          if (wrap._ddHoverFrame) return;
          wrap._ddHoverFrame = requestAnimationFrame(() => {
            wrap._ddHoverFrame = 0;
            const position = wrap._ddHoverState && locate(wrap._ddHoverState);
            if (position) this._updateDatasetDiagHeroHover(wrap, position.x, position.y);
            else clearHover();
          });
        });

        const onLeave = event => {
          const related = event.relatedTarget;
          if (related && wrap.querySelector('[data-dd-preview-pop]')?.contains(related)) return;
          clearHover();
        };
        stage.addEventListener('pointerleave', onLeave);
        stage.addEventListener('pointercancel', clearHover);

        stage.addEventListener('click', event => {
          const position = locate(event);
          if (!position || wrap._ddChartState?.kind !== 'scatter') return;
          this._updateDatasetDiagHeroHover(wrap, position.x, position.y);
          const active = wrap._ddActiveDot;
          if (active?.image_id) {
            clearHover();
            this.openDatasetDiagModal(active.image_id);
          }
        });

        const pop = wrap.querySelector('[data-dd-preview-pop]');
        if (pop) {
          const img = pop.querySelector('img');
          img.addEventListener('load', () => {
            if (!wrap._ddActiveDot) return;
            img.parentElement.hidden = !img.getAttribute('src') || !img.naturalWidth;
            pop.hidden = false;
          });
          img.addEventListener('error', () => {
            img.parentElement.hidden = true;
            if (wrap._ddActiveDot) pop.hidden = false;
          });
        }
      }

      let frame = 0;
      const render = () => {
        frame = 0;
        const nextWidth = Math.round(stage.clientWidth || 0);
        if (nextWidth > 120 && Math.abs(nextWidth - (wrap._ddMeasuredWidth || 0)) >= 4) {
          wrap._ddMeasuredWidth = nextWidth;
          clearHover();
          this._renderDatasetDiagHeroSvg(wrap, stage, svg);
        }
      };
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
        if (!frame) frame = requestAnimationFrame(render);
      });
      observer?.observe(stage);
      panel._ddHeroRO = {
        disconnect() {
          observer?.disconnect();
          if (frame) cancelAnimationFrame(frame);
          clearHover();
        },
      };
      render();
    },

    _pauseDatasetDiagCharts(panel) {
      if (!panel?._ddHeroRO) return;
      panel._ddHeroRO.disconnect();
      panel._ddHeroRO = null;
    },

    _renderDatasetDiagHeroSvg(wrap, stage, svg) {
      const data = this.datasetDiagData;
      if (!data || !data.available) return;
      const t = (k, fb) => this.tMonitor(k, fb);
      const mode = this.datasetDiagHeroMode === 'timestep' ? 'timestep' : 'quadrant';
      const width = Math.max(300, Math.round(stage.clientWidth || 700));

      const modeChanged = this._ddLastHeroMode && this._ddLastHeroMode !== mode;
      this._ddLastHeroMode = mode;
      svg.classList.toggle('is-mode-enter', !!modeChanged);

      if (mode === 'timestep') {
        this._renderDatasetDiagTimestepSvg(wrap, svg, data, width, t);
        return;
      }
      if (data.summary?.has_slope) {
        this._renderDatasetDiagQuadrantSvg(wrap, svg, data, width, t);
      } else {
        this._renderDatasetDiagEarlySvg(wrap, svg, data, width, t);
      }
    },

    _ddRepresentativePoints(points, limit, extrema) {
      if (points.length <= limit) return points;
      const selected = new Set(extrema);
      const spread = (items, count) => {
        const size = Math.min(items.length, count);
        for (let index = 0; index < size; index++) {
          const position = size === 1 ? 0 : Math.round(index * (items.length - 1) / (size - 1));
          selected.add(items[position]);
        }
      };
      spread(points.filter(point => point.status === 'non_finite'), Math.floor(limit / 4));
      spread(points.filter(point => point.status === 'attention'), Math.floor(limit / 4));
      spread(points.filter(point => !selected.has(point)), limit - selected.size);
      return Array.from(selected);
    },

    _ddSetChartCoverage(wrap, t, shown, eligible, total) {
      const element = wrap.querySelector('[data-dd-chart-coverage]')
        || wrap.closest?.('[data-dd-analysis]')?.querySelector('[data-dd-chart-coverage]')
        || wrap.closest?.('[data-dd-slot="analysis"]')?.querySelector('[data-dd-chart-coverage]')
        || wrap.closest?.('[data-dd-slot="hero"]')?.querySelector('[data-dd-chart-coverage]');
      if (!element) return;
      if (shown < eligible) {
        element.textContent = t('ddChartCoverage')
          .replace('{shown}', shown).replace('{eligible}', eligible).replace('{total}', total);
      } else if (eligible < total) {
        element.textContent = t('ddChartShown')
          .replace('{n}', eligible).replace('{total}', total);
      } else {
        element.textContent = '';
      }
    },

    _renderDatasetDiagQuadrantSvg(wrap, svg, data, width, t) {
      const height = 236;
      const padL = 56, padR = 36, padT = 22, padB = 28;
      const plotW = Math.max(120, width - padL - padR);
      const plotH = Math.max(80, height - padT - padB);
      const minCount = Number(data.thresholds?.min_count || 3);
      const images = data.by_image || [];
      const points = images.filter(i => (i.comparable_count ?? i.count) >= minCount
        && Number.isFinite(i.mean_residual) && Number.isFinite(i.slope));
      if (!points.length) {
        this._ddSetChartCoverage(wrap, t, 0, 0, images.length);
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        svg.innerHTML = `<text class="is-sans" x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--text-tertiary)" font-size="12">${this.esc(t('ddNoQuadrantPoints'))}</text>`;
        wrap._ddChartState = null;
        return;
      }

      let leftmost = points[0], rightmost = points[0], lowest = points[0], highest = points[0];
      for (const point of points) {
        if (point.mean_residual < leftmost.mean_residual) leftmost = point;
        if (point.mean_residual > rightmost.mean_residual) rightmost = point;
        if (point.slope < lowest.slope) lowest = point;
        if (point.slope > highest.slope) highest = point;
      }
      const displayed = this._ddRepresentativePoints(points, 1000, [leftmost, rightmost, lowest, highest]);
      this._ddSetChartCoverage(wrap, t, displayed.length, points.length, images.length);
      const rawXMin = leftmost.mean_residual, rawXMax = rightmost.mean_residual;
      const rawYMin = lowest.slope, rawYMax = highest.slope;
      const xDataSpan = Math.max(0.30, rawXMax - rawXMin);
      const yDataSpan = Math.max(0.10, rawYMax - rawYMin);
      const xMin = Math.min(-0.30, rawXMin - Math.max(0.05, xDataSpan * 0.08));
      const xMax = Math.max(0.35, rawXMax + Math.max(0.06, xDataSpan * 0.10));
      const yMin = Math.min(-0.08, rawYMin - Math.max(0.032, yDataSpan * 0.25));
      const yMax = Math.max(0.08, rawYMax + Math.max(0.030, yDataSpan * 0.22));
      const xSpan = Math.max(xMax - xMin, 0.1);
      const ySpan = Math.max(yMax - yMin, 0.02);
      const toX = v => padL + ((v - xMin) / xSpan) * plotW;
      const toY = v => padT + plotH - ((v - yMin) / ySpan) * plotH;

      const xZero = toX(0);
      const yZero = toY(0);
      const highResVal = data.thresholds?.high_residual ?? 0.20;
      const convSlopeVal = data.thresholds?.converging_slope ?? -0.02;
      const xHigh = toX(highResVal);
      const yConv = toY(convSlopeVal);

      const orderWeight = s => (s === 'non_finite' ? 4 : s === 'attention' ? 3 : s === 'learning' ? 2 : s === 'easy' ? 1 : 0);
      const ordered = displayed.slice().sort((a, b) => orderWeight(a.status) - orderWeight(b.status));
      const coords = ordered.map((img, idx) => {
        const cx = toX(img.mean_residual);
        const cy = toY(img.slope);
        const r = Math.max(3.4, Math.min(5.8, 3.0 + Math.log1p(img.count) * 0.72));
        const fill = img.status === 'non_finite' ? 'var(--danger)' : this._ddResidualColor(img.mean_residual);
        const cls = 'm-dd-dot' + (img.status === 'attention' || img.status === 'non_finite' ? ' is-alert' : '');
        return { ...img, idx, cx, cy, r, fill, cls };
      });

      const zoneW = Math.max(0, padL + plotW - xHigh);
      const zoneH = Math.max(0, yConv - padT);

      const dotsHtml = coords.map(d =>
        `<circle class="${d.cls}" data-dd-dot-idx="${d.idx}" data-dd-status="${this.esc(d.status)}" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${d.r.toFixed(1)}" style="fill:${d.fill}"/>`
        + (d.status === 'non_finite'
          ? `<circle class="m-dd-dot-nan-ring" data-dd-status="non_finite" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${(d.r + 3.2).toFixed(1)}"/>`
          : '')
      ).join('');

      const threshSvg = (zoneW > 4 && zoneH > 4)
        ? `<line class="is-thresh" x1="${xHigh.toFixed(1)}" x2="${xHigh.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>`
          + `<line class="is-thresh" x1="${xHigh.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y1="${yConv.toFixed(1)}" y2="${yConv.toFixed(1)}"/>`
        : `<line class="is-thresh" x1="${xHigh.toFixed(1)}" x2="${xHigh.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>`;

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));
      svg.innerHTML = `
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT}" y2="${padT}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT + plotH}" y2="${padT + plotH}" class="is-axis"/>
          <line x1="${padL}" x2="${padL}" y1="${padT}" y2="${padT + plotH}" class="is-axis"/>
        </g>
        ${zoneW > 4 && zoneH > 4 ? `<rect class="m-dd-alert-zone" x="${xHigh.toFixed(1)}" y="${padT}" width="${zoneW.toFixed(1)}" height="${zoneH.toFixed(1)}"/>` : ''}
        <g class="m-dd-ref-lines">
          <line x1="${xZero.toFixed(1)}" x2="${xZero.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${yZero.toFixed(1)}" y2="${yZero.toFixed(1)}"/>
          ${threshSvg}
        </g>
        <g class="m-dd-quad-labels">
          <text class="m-dd-axis-dir" x="${padL + 6}" y="${padT + 12}" text-anchor="start">${this.esc(t('ddQuadDirUp'))}</text>
          <text class="is-alert" x="${(padL + plotW - 6).toFixed(1)}" y="${padT + 12}" text-anchor="end">${this.esc(t('ddQuadTopRight'))}</text>
          <text class="m-dd-axis-dir" x="${padL + 6}" y="${(padT + plotH - 6).toFixed(1)}" text-anchor="start">${this.esc(t('ddQuadDirDown'))}</text>
          <text x="${(padL + plotW - 6).toFixed(1)}" y="${(padT + plotH - 6).toFixed(1)}" text-anchor="end">${this.esc(t('ddQuadBottomRight'))}</text>
        </g>
        <g class="m-dd-crosshair" data-dd-crosshair display="none">
          <line data-dd-ch-x y1="${padT}" y2="${padT + plotH}"/>
          <line data-dd-ch-y x1="${padL}" x2="${padL + plotW}"/>
        </g>
        <g class="m-dd-dots">${dotsHtml}</g>
        <circle class="m-dd-dot-focus" data-dd-dot-focus r="7" display="none"/>
        <g class="m-chart-axes">
          <text class="m-dd-thresh-label" x="${xHigh.toFixed(1)}" y="${padT - 7}" text-anchor="middle">+${Math.round(highResVal * 100)}%</text>
          ${(yConv > padT + 8 && yConv < padT + plotH - 8) ? `<text class="m-dd-thresh-label" x="${padL + plotW + 4}" y="${(yConv + 3).toFixed(1)}" text-anchor="start">${Math.round(convSlopeVal * 100)}%</text>` : ''}
          <text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${this._ddFormatSlope(yMax)}</text>
          <text x="${padL - 6}" y="${(yZero + 3).toFixed(1)}" text-anchor="end">0%</text>
          <text x="${padL - 6}" y="${padT + plotH + 1}" text-anchor="end">${this._ddFormatSlope(yMin)}</text>
          <text x="${padL}" y="${height - 6}" text-anchor="start">${this._ddFormatResidual(xMin)}</text>
          <text x="${xZero.toFixed(1)}" y="${height - 6}" text-anchor="middle">0%</text>
          <text x="${padL + plotW}" y="${height - 6}" text-anchor="end">${this._ddFormatResidual(xMax)}</text>
        </g>`;

      wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, coords };
    },

    _renderDatasetDiagEarlySvg(wrap, svg, data, width, t) {
      const height = 236;
      const padL = 48, padR = 36, padT = 22, padB = 28;
      const plotW = Math.max(120, width - padL - padR);
      const plotH = Math.max(70, height - padT - padB);
      const images = data.by_image || [];
      const points = images.filter(i => Number.isFinite(i.mean_residual));
      if (!points.length) {
        this._ddSetChartCoverage(wrap, t, 0, 0, images.length);
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        svg.innerHTML = `<text class="is-sans" x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--text-tertiary)" font-size="12">${this.esc(t('ddNoReferencePoints'))}</text>`;
        wrap._ddChartState = null;
        return;
      }

      let leftmost = points[0], rightmost = points[0];
      for (const point of points) {
        if (point.mean_residual < leftmost.mean_residual) leftmost = point;
        if (point.mean_residual > rightmost.mean_residual) rightmost = point;
      }
      const displayed = this._ddRepresentativePoints(points, 400, [leftmost, rightmost]);
      this._ddSetChartCoverage(wrap, t, displayed.length, points.length, images.length);
      const xMin = Math.min(-0.35, leftmost.mean_residual * 1.08);
      const xMax = Math.max(0.45, rightmost.mean_residual * 1.08);
      const xSpan = Math.max(xMax - xMin, 0.2);
      const toX = v => padL + ((v - xMin) / xSpan) * plotW;

      const numBins = 16;
      const binW = xSpan / numBins;
      const bins = Array.from({ length: numBins }, () => 0);
      points.forEach(({ mean_residual: residual }) => {
        const b = Math.min(numBins - 1, Math.max(0, Math.floor((residual - xMin) / binW)));
        bins[b]++;
      });
      const maxBin = Math.max(1, ...bins);
      const histH = plotH * 0.52;
      const baseHistY = padT + histH;
      const slotW = plotW / numBins;
      const barW = Math.max(4, slotW - 3);

      const barsHtml = bins.map((cnt, b) => {
        if (!cnt) return '';
        const midRes = xMin + (b + 0.5) * binW;
        const h = Math.max(3, (cnt / maxBin) * (histH - 8));
        const x = padL + b * slotW + (slotW - barW) / 2;
        const y = baseHistY - h;
        const fill = this._ddResidualColor(midRes);
        return `<rect class="m-dd-hist-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:${fill};fill-opacity:0.58"/>`;
      }).join('');

      const stripTop = baseHistY + 14;
      const stripH = Math.max(24, padT + plotH - stripTop - 6);
      const ordered = displayed.slice().sort((a, b) => Number(a.status === 'non_finite') - Number(b.status === 'non_finite')
        || Math.abs(a.mean_residual) - Math.abs(b.mean_residual));
      const coords = ordered.map((img, idx) => {
        const seed = parseInt(String(img.image_id || '0').slice(0, 6), 16) || idx * 13;
        const jitter = ((seed % 100) / 100);
        const cx = toX(img.mean_residual);
        const cy = stripTop + jitter * stripH;
        const fill = img.status === 'non_finite' ? 'var(--danger)' : this._ddResidualColor(img.mean_residual);
        return { ...img, idx, cx, cy, r: 3.6, fill };
      });
      const dotsHtml = coords.map(d =>
        `<circle class="m-dd-dot" data-dd-dot-idx="${d.idx}" data-dd-status="${this.esc(d.status)}" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${d.r}" style="fill:${d.fill}"/>`
        + (d.status === 'non_finite'
          ? `<circle class="m-dd-dot-nan-ring" data-dd-status="non_finite" cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="${(d.r + 3.2).toFixed(1)}"/>`
          : '')
      ).join('');

      const xZero = toX(0);
      const highResVal = data.thresholds?.high_residual ?? 0.20;
      const xHigh = toX(highResVal);

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));
      svg.innerHTML = `
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${baseHistY.toFixed(1)}" y2="${baseHistY.toFixed(1)}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT + plotH}" y2="${padT + plotH}" class="is-axis"/>
        </g>
        <g class="m-dd-ref-lines">
          <line x1="${xZero.toFixed(1)}" x2="${xZero.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>
          <line class="is-thresh" x1="${xHigh.toFixed(1)}" x2="${xHigh.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>
        </g>
        <g class="m-dd-quad-labels">
          <text class="m-dd-axis-dir" x="${padL + 6}" y="${padT + 12}" text-anchor="start">${this.esc(t('ddQuadLeft'))}</text>
          <text class="is-alert" x="${(padL + plotW - 6).toFixed(1)}" y="${padT + 12}" text-anchor="end">${this.esc(t('ddEarlyRight'))}</text>
        </g>
        <g class="m-dd-crosshair" data-dd-crosshair display="none">
          <line data-dd-ch-x y1="${padT}" y2="${padT + plotH}"/>
          <line data-dd-ch-y x1="${padL}" x2="${padL + plotW}"/>
        </g>
        <g>${barsHtml}</g>
        <g class="m-dd-dots">${dotsHtml}</g>
        <circle class="m-dd-dot-focus" data-dd-dot-focus r="7" display="none"/>
        <g class="m-chart-axes">
          <text class="m-dd-thresh-label" x="${xHigh.toFixed(1)}" y="${padT - 7}" text-anchor="middle">+${Math.round(highResVal * 100)}%</text>
          <text x="${padL - 6}" y="${padT + 8}" text-anchor="end">${maxBin}</text>
          <text x="${padL - 6}" y="${baseHistY.toFixed(1)}" text-anchor="end">0</text>
          <text x="${padL}" y="${height - 6}" text-anchor="start">${this._ddFormatResidual(xMin)}</text>
          <text x="${xZero.toFixed(1)}" y="${height - 6}" text-anchor="middle">0%</text>
          <text x="${padL + plotW}" y="${height - 6}" text-anchor="end">${this._ddFormatResidual(xMax)}</text>
        </g>`;

      wrap._ddChartState = { kind: 'scatter', width, height, padL, padR, padT, plotW, plotH, coords };
    },

    _renderDatasetDiagTimestepSvg(wrap, svg, data, width, t) {
      const height = 236;
      const padL = 52, padR = 20, padT = 10, padB = 28;
      const plotW = Math.max(120, width - padL - padR);
      const plotH = Math.max(70, height - padT - padB);
      const scale = data.timestep_scale || 'thousand';
      const bins = scale === 'unknown' ? [] : data.by_timestep || [];

      if (!bins.length) {
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        svg.innerHTML = `<text class="is-sans" x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--text-tertiary)" font-size="12">${this.esc(t('ddTimestepOverlayEmpty'))}</text>`;
        wrap._ddChartState = null;
        return;
      }

      const vals = bins.map(b => b.mean_loss);
      const minV = Math.min(...vals), maxV = Math.max(...vals);
      const padV = Math.max((maxV - minV) * 0.2, Math.abs(minV) * 0.08, 1e-6);
      const low = Math.max(0, minV - padV * 0.7);
      const high = maxV + padV * 0.7;
      const span = Math.max(high - low, 1e-9);
      const toY = v => padT + plotH - ((v - low) / span) * plotH;
      const toX = t1000 => padL + ((1000 - t1000) / 1000) * plotW;
      const baseY = padT + plotH;
      const peakVal = maxV;

      const roundedTopBar = (x, y, w, h) => {
        const r = Math.min(3.5, w / 2, h);
        const right = x + w, bot = y + h;
        return `M${x.toFixed(1)} ${bot.toFixed(1)} V${(y + r).toFixed(1)} Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)} H${(right - r).toFixed(1)} Q${right.toFixed(1)} ${y.toFixed(1)} ${right.toFixed(1)} ${(y + r).toFixed(1)} V${bot.toFixed(1)} Z`;
      };

      const gradId = 'm-dd-ts-grad-' + (this.selectedRunDir ? 'h' : 'l');
      const peakGradId = 'm-dd-ts-peak-' + (this.selectedRunDir ? 'h' : 'l');

      // Sort high noise (1000, left) down to low noise (0, right)
      const coords = bins.map(b => {
        const tLow = this._ddToTimestep1000(b.timestep_from, scale) ?? 0;
        const tHigh = this._ddToTimestep1000(b.timestep_to, scale) ?? tLow;
        const xLeft = toX(tHigh);
        const xRight = toX(tLow);
        const spanW = Math.max(0, xRight - xLeft);
        const xCenter = (xLeft + xRight) / 2;
        const barW = spanW > 0 ? Math.max(4, Math.min(36, spanW * 0.68)) : 24;
        return {
          ...b,
          tLow,
          tHigh,
          xCenter,
          barW,
          y: toY(b.mean_loss),
          isPeak: b.mean_loss === peakVal,
        };
      }).sort((a, b) => a.xCenter - b.xCenter).map((c, idx) => ({ ...c, idx }));

      const barsHtml = coords.map(c => {
        const h = Math.max(4, baseY - c.y);
        const x = c.xCenter - c.barW / 2;
        const fill = c.isPeak ? `url(#${peakGradId})` : `url(#${gradId})`;
        return `<path class="m-epoch-bar m-dd-ts-bar" data-dd-ts-idx="${c.idx}" fill="${fill}" d="${roundedTopBar(x, c.y, c.barW, h)}"/>`;
      }).join('');

      const xDiv667 = toX(2000 / 3);
      const xDiv333 = toX(1000 / 3);
      const ticksHtml = [1000, 750, 500, 250, 0].map((tick, idx) => {
        const anchor = idx === 0 ? 'start' : (idx === 4 ? 'end' : 'middle');
        return `<text x="${toX(tick).toFixed(1)}" y="${height - 6}" text-anchor="${anchor}">${tick}</text>`;
      }).join('');

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));
      svg.innerHTML = `
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--text-secondary)" stop-opacity=".55"/>
            <stop offset="100%" stop-color="var(--text-secondary)" stop-opacity=".16"/>
          </linearGradient>
          <linearGradient id="${peakGradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity=".9"/>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity=".32"/>
          </linearGradient>
        </defs>
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT}" y2="${padT}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${(padT + plotH / 2).toFixed(1)}" y2="${(padT + plotH / 2).toFixed(1)}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${baseY}" y2="${baseY}" class="is-axis"/>
        </g>
        <g class="m-dd-ref-lines">
          <line x1="${xDiv667.toFixed(1)}" x2="${xDiv667.toFixed(1)}" y1="${padT}" y2="${baseY}"/>
          <line x1="${xDiv333.toFixed(1)}" x2="${xDiv333.toFixed(1)}" y1="${padT}" y2="${baseY}"/>
        </g>
        <g class="m-chart-epoch-bars" data-dd-ts-bars>${barsHtml}</g>
        <g class="m-chart-axes">
          <text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${this._ddFormatLoss(high)}</text>
          <text x="${padL - 6}" y="${baseY + 1}" text-anchor="end">${this._ddFormatLoss(low)}</text>
          ${ticksHtml}
        </g>`;

      wrap._ddChartState = { kind: 'timestep', width, height, padL, padR, padT, plotW, plotH, coords, scale };
    },

    _updateDatasetDiagHeroHover(wrap, x, y) {
      const st = wrap._ddChartState;
      if (!st) return;
      const t = (k, fb) => this.tMonitor(k, fb);

      if (st.kind === 'timestep') {
        let bestBar = null, bestDist = Infinity;
        for (const c of st.coords) {
          const d = Math.abs(c.xCenter - x);
          if (d < bestDist) { bestDist = d; bestBar = c; }
        }
        if (!bestBar || bestDist > Math.max(36, bestBar.barW * 1.4)) {
          this._clearDatasetDiagHeroHover(wrap);
          return;
        }
        if (wrap._ddActiveBar === bestBar) return;
        const svg = wrap.querySelector('[data-dd-hero-svg]');
        const readEl = wrap.querySelector('[data-dd-hud-readout]');
        if (!svg) return;
        wrap._ddActiveBar = bestBar;
        wrap.classList.add('is-hovering');
        svg.querySelector('[data-dd-ts-bars]')?.classList.add('has-hover');
        svg.querySelectorAll('.m-dd-ts-bar.is-hovered').forEach(el => el.classList.remove('is-hovered'));
        svg.querySelector(`.m-dd-ts-bar[data-dd-ts-idx="${bestBar.idx}"]`)?.classList.add('is-hovered');
        if (readEl) {
          const hiStr = String(Math.round(bestBar.tHigh));
          const loStr = String(Math.round(bestBar.tLow));
          readEl.innerHTML = `<span class="m-dd-ro-metric"><em>${this.esc(t('ddColTimestep'))}</em><strong class="m-dd-ro-num" style="min-inline-size:9ch">${this.esc(hiStr)}–${this.esc(loStr)}</strong></span>`
            + `<span class="m-dd-ro-metric"><em>${this.esc(t('ddColMeanLoss'))}</em><strong class="m-dd-ro-num" style="min-inline-size:6.5ch">${this.esc(this._ddFormatLoss(bestBar.mean_loss))}</strong></span>`
            + `<span class="m-dd-ro-metric"><em>${this.esc(t('ddColSamples'))}</em><strong class="m-dd-ro-num" style="min-inline-size:4ch">${this.esc(bestBar.count)}</strong></span>`;
        }
        return;
      }

      // Scatter point nearest-hit search within 22px
      let best = null, bestDist = 22 * 22;
      for (const pt of st.coords) {
        const dx = pt.cx - x, dy = pt.cy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDist) { bestDist = d2; best = pt; }
      }
      if (!best) {
        this._clearDatasetDiagHeroHover(wrap);
        return;
      }
      if (wrap._ddActiveDot === best) return;
      const svg = wrap.querySelector('[data-dd-hero-svg]');
      if (!svg) return;
      const readEl = wrap.querySelector('[data-dd-hud-readout]');
      const pop = wrap.querySelector('[data-dd-preview-pop]');
      const stage = wrap.querySelector('[data-dd-hero-stage]');
      const focusRing = svg.querySelector('[data-dd-dot-focus]');
      const ch = svg.querySelector('[data-dd-crosshair]');
      wrap.classList.add('is-hovering');
      wrap._ddActiveDot = best;
      stage?.classList.add('has-preview-snap');
      if (ch) {
        const vx = ch.querySelector('[data-dd-ch-x]');
        const hy = ch.querySelector('[data-dd-ch-y]');
        if (vx) { vx.setAttribute('x1', best.cx.toFixed(1)); vx.setAttribute('x2', best.cx.toFixed(1)); }
        if (hy) { hy.setAttribute('y1', best.cy.toFixed(1)); hy.setAttribute('y2', best.cy.toFixed(1)); }
        ch.removeAttribute('display');
      }
      if (focusRing) {
        focusRing.setAttribute('cx', best.cx.toFixed(1));
        focusRing.setAttribute('cy', best.cy.toFixed(1));
        focusRing.setAttribute('r', (best.r + 3.5).toFixed(1));
        focusRing.style.stroke = best.fill;
        focusRing.removeAttribute('display');
      }
      if (readEl) {
        const resStr = this._ddFormatResidual(best.mean_residual);
        const slopeHtml = best.slope != null
          ? `<span class="m-dd-ro-metric"><em>${this.esc(t('ddColSlope'))}</em><strong class="m-dd-ro-num" style="min-inline-size:6ch">${this.esc(this._ddFormatSlope(best.slope))}</strong></span>`
          : '';
        readEl.innerHTML = `<span class="m-dd-ro-name"><i style="background:${best.fill}"></i><span>${this.esc(best.name)}</span></span>`
          + `<span class="m-dd-ro-metric"><em>${this.esc(t('ddColRelative'))}</em><strong class="m-dd-ro-num" style="min-inline-size:6.5ch">${this.esc(resStr)}</strong></span>`
          + slopeHtml
          + `<span class="m-dd-ro-metric"><em>${this.esc(t('ddColSamples'))}</em><strong class="m-dd-ro-num" style="min-inline-size:3.5ch">${this.esc(best.count)}</strong></span>`;
      }
      if (pop) {
        const img = pop.querySelector('img');
        const titleEl = pop.querySelector('[data-dd-pop-title]');
        if (titleEl) {
          titleEl.textContent = `${best.name} (${this._ddFormatResidual(best.mean_residual)})`;
        }
        if (best.thumb_url) {
          if (img.getAttribute('src') !== best.thumb_url) img.setAttribute('src', best.thumb_url);
          img.parentElement.hidden = !img.naturalWidth;
        } else {
          img.removeAttribute('src');
          img.parentElement.hidden = true;
        }
        const svgRect = svg.getBoundingClientRect();
        const popW = 210;
        const anchorX = svgRect.left + best.cx;
        const anchorY = svgRect.top + best.cy;
        const clampedX = Math.max(popW / 2 + 12, Math.min((window.innerWidth || 1440) - popW / 2 - 12, anchorX));
        const showBelow = anchorY < 260;
        pop.classList.toggle('is-below', showBelow);
        pop.style.left = clampedX.toFixed(1) + 'px';
        pop.style.top = (showBelow ? anchorY + 14 : Math.max(12, anchorY - 14)).toFixed(1) + 'px';
        pop.hidden = best.thumb_url ? !img.complete : false;
      }
    },

    _clearDatasetDiagHeroHover(wrap) {
      if (!wrap._ddActiveDot && !wrap._ddActiveBar) return;
      wrap.classList.remove('is-hovering');
      wrap._ddActiveDot = null;
      wrap._ddActiveBar = null;
      wrap.querySelector('[data-dd-hero-stage]')?.classList.remove('has-preview-snap');
      const svg = wrap.querySelector('[data-dd-hero-svg]');
      svg?.querySelector('[data-dd-crosshair]')?.setAttribute('display', 'none');
      svg?.querySelector('[data-dd-dot-focus]')?.setAttribute('display', 'none');
      svg?.querySelector('[data-dd-ts-bars]')?.classList.remove('has-hover');
      svg?.querySelectorAll('.m-dd-ts-bar.is-hovered').forEach(el => el.classList.remove('is-hovered'));
      const readEl = wrap.querySelector('[data-dd-hud-readout]');
      if (readEl) readEl.innerHTML = '';
      const pop = wrap.querySelector('[data-dd-preview-pop]');
      if (pop) pop.hidden = true;
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

      return '<dialog id="datasetDiagModal" class="modal-overlay m-dd-modal" data-dialog-fast-open'
        + ' x-dialog="datasetDiagModalOpen" @click.self="closeDatasetDiagModal()"'
        + ' @dialog-close="closeDatasetDiagModal()" @dialog-after-close="clearDatasetDiagModal()"'
        + ' @keydown="datasetDiagModalKeydown($event)" aria-labelledby="datasetDiagModalTitle" x-cloak>'
        + '<div class="modal m-dd-modal-window" tabindex="-1" data-dialog-autofocus>'
        + '<div class="modal-header m-dd-modal-header">'
        + '<div class="m-dd-modal-heading">'
        + '<strong id="datasetDiagModalTitle" class="m-dd-modal-title"></strong>'
        + '<span id="datasetDiagModalBadge" class="m-dd-pill"></span>'
        + '<div id="datasetDiagModalSub" class="m-dd-modal-sub"></div>'
        + '</div>'
        + '<div class="m-dd-modal-tools">'
        + '<div class="preview-lightbox-navigation">'
        + '<button type="button" id="ddModalPrev" class="btn-icon preview-lightbox-nav prev" @click="datasetDiagModalNav(-1)" title="' + this.esc(t('ddPrevShortcut')) + '" aria-label="' + this.esc(t('prev')) + '">' + left + '</button>'
        + '<span id="datasetDiagModalCounter" class="m-dd-modal-counter">0 / 0</span>'
        + '<button type="button" id="ddModalNext" class="btn-icon preview-lightbox-nav next" @click="datasetDiagModalNav(1)" title="' + this.esc(t('ddNextShortcut')) + '" aria-label="' + this.esc(t('next')) + '">' + right + '</button>'
        + '</div>'
        + '<div class="preview-lightbox-zoom">'
        + '<button type="button" class="btn-icon preview-icon-button" @click="setDatasetDiagZoomScale(datasetDiagZoomScale / 1.18)" :disabled="datasetDiagZoomScale <= 1" title="' + this.esc(t('ddZoomOutShortcut')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomOut')) + '">' + zoomOut + '</button>'
        + '<button type="button" class="preview-zoom-value" @click="resetDatasetDiagZoom(true)" title="' + this.esc(t('ddZoomResetShortcut')) + '" x-text="Math.round(datasetDiagZoomScale * 100) + \'%\'">100%</button>'
        + '<button type="button" class="btn-icon preview-icon-button" @click="setDatasetDiagZoomScale(datasetDiagZoomScale * 1.18)" :disabled="datasetDiagZoomScale >= 8" title="' + this.esc(t('ddZoomInShortcut')) + '" aria-label="' + this.esc(this.t('tagEditor.zoomIn')) + '">' + zoomIn + '</button>'
        + '</div>'
        + '<button type="button" class="btn-icon preview-icon-button preview-close" @click="closeDatasetDiagModal()" title="' + this.esc(t('ddCloseShortcut')) + '" aria-label="' + this.esc(t('close')) + '">' + close + '</button>'
        + '</div></div>'
        + '<div class="m-dd-modal-body">'
        + '<div class="m-dd-modal-left">'
        + '<div id="datasetDiagModalStage" class="m-dd-modal-stage" :class="{zoomed: datasetDiagZoomScale > 1, panning: datasetDiagPanning}"'
        + ' @wheel="zoomDatasetDiagImage($event)" @pointerdown="startDatasetDiagPan($event)" @pointermove="moveDatasetDiagPan($event)"'
        + ' @pointerup="stopDatasetDiagPan($event)" @pointercancel="stopDatasetDiagPan($event)" @lostpointercapture="stopDatasetDiagPan($event)"'
        + ' @dblclick="resetDatasetDiagZoom(true)" @resize.window="_constrainDatasetDiagZoom()" @dragstart.prevent>'
        + '<img id="datasetDiagModalImg" class="m-dd-modal-img" alt="" :style="\'transform:\' + _datasetDiagTransform()" draggable="false" @load="_constrainDatasetDiagZoom()"/>'
        + '<div id="datasetDiagModalMissing" class="m-dd-modal-missing" hidden>'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></svg>'
        + '<p>' + this.esc(t('ddModalImageMissing')) + '</p></div>'
        + '<button type="button" id="ddModalSidePrev" class="m-sample-sidebar-side-nav prev m-dd-modal-side-nav" @pointerdown.stop @click.stop="datasetDiagModalNav(-1)" title="' + this.esc(t('ddPrevShortcut')) + '" aria-label="' + this.esc(t('prev')) + '"><span>' + left + '</span></button>'
        + '<button type="button" id="ddModalSideNext" class="m-sample-sidebar-side-nav next m-dd-modal-side-nav" @pointerdown.stop @click.stop="datasetDiagModalNav(1)" title="' + this.esc(t('ddNextShortcut')) + '" aria-label="' + this.esc(t('next')) + '"><span>' + right + '</span></button>'
        + '</div>'
        + '<div id="datasetDiagModalFoot" class="m-dd-modal-foot"></div>'
        + '</div>'
        + '<div id="datasetDiagModalRight" class="m-dd-modal-right"></div>'
        + '</div></div></dialog>';
    },

    _syncDatasetDiagImageStyle() {
      const img = document.getElementById('datasetDiagModalImg');
      if (img) img.style.transform = this._datasetDiagTransform();
    },

    _patchDatasetDiagModal() {
      const dialog = document.getElementById('datasetDiagModal');
      if (!dialog) return;
      const t = (k, fb) => this.tMonitor(k, fb);

      const navList = this._datasetDiagModalNavList();
      const idx = navList.findIndex(item => item.image_id === this.datasetDiagModalImageId);
      const listImg = idx >= 0 ? navList[idx] : (this.datasetDiagData?.by_image || []).find(i => i.image_id === this.datasetDiagModalImageId);
      const detail = this.datasetDiagModalDetail;
      const imgInfo = detail?.image || listImg;

      const titleEl = document.getElementById('datasetDiagModalTitle');
      const badgeEl = document.getElementById('datasetDiagModalBadge');
      const subEl = document.getElementById('datasetDiagModalSub');
      const counterEl = document.getElementById('datasetDiagModalCounter');
      const prevBtn = document.getElementById('ddModalPrev');
      const nextBtn = document.getElementById('ddModalNext');
      const sidePrev = document.getElementById('ddModalSidePrev');
      const sideNext = document.getElementById('ddModalSideNext');

      if (titleEl && imgInfo) {
        titleEl.textContent = imgInfo.name || imgInfo.image;
        titleEl.title = imgInfo.image;
      }
      if (badgeEl && imgInfo) {
        const meta = this._ddStatusMeta(t, imgInfo.status, imgInfo.slope);
        badgeEl.className = 'm-dd-pill is-' + meta.tone;
        badgeEl.textContent = meta.label;
      }
      if (subEl && imgInfo) {
        const reso = this._ddFormatResolution(imgInfo.resolution);
        const bits = [];
        if (reso) bits.push('<span>' + this.esc(reso) + '</span>');
        if (imgInfo.subset_label) bits.push('<span>' + this.esc(imgInfo.subset_label) + '</span>');
        subEl.innerHTML = bits.join('');
      }
      if (counterEl) {
        counterEl.textContent = idx >= 0 ? `${idx + 1} / ${navList.length}` : '—';
      }
      if (prevBtn) prevBtn.disabled = navList.length <= 1;
      if (nextBtn) nextBtn.disabled = navList.length <= 1;
      if (sidePrev) sidePrev.hidden = navList.length <= 1;
      if (sideNext) sideNext.hidden = navList.length <= 1;

      const stageImg = document.getElementById('datasetDiagModalImg');
      const missingEl = document.getElementById('datasetDiagModalMissing');
      const srcUrl = detail?.image?.preview_url || imgInfo?.preview_url || imgInfo?.thumb_url || '';
      if (stageImg && missingEl) {
        if (srcUrl) {
          if (stageImg.getAttribute('src') !== srcUrl) stageImg.setAttribute('src', srcUrl);
          stageImg.hidden = false;
          missingEl.hidden = true;
        } else {
          stageImg.removeAttribute('src');
          stageImg.hidden = true;
          missingEl.hidden = false;
        }
      }

      const footEl = document.getElementById('datasetDiagModalFoot');
      if (footEl && imgInfo) {
        const fi = detail?.file_info;
        const metaSpans = [];
        if (fi?.width && fi?.height) {
          metaSpans.push('<span>' + this.esc(`${t('ddOrigSize')} ${fi.width} × ${fi.height}`) + '</span>');
        }
        if (fi?.size) {
          metaSpans.push('<span>' + this.esc(this._formatFileSize ? this._formatFileSize(fi.size) : `${fi.size} B`) + '</span>');
        }
        if (imgInfo.is_reg) {
          metaSpans.push('<span>' + this.esc(t('ddRegTag')) + '</span>');
        }
        if (!metaSpans.length && imgInfo.dir_label) {
          metaSpans.push('<span>' + this.esc(imgInfo.dir_label) + '</span>');
        }
        const rawPath = fi?.abs_path || imgInfo.image || '';
        const copyJs = this.esc(this.escapeJsString(rawPath));
        footEl.innerHTML = '<div class="m-dd-modal-meta" title="' + this.esc(rawPath) + '">' + metaSpans.join('') + '</div>'
          + '<div class="m-dd-modal-actions">'
          + '<button type="button" class="btn btn-sm btn-secondary" @click="copyDatasetDiagText(\'' + copyJs + '\')">' + this.esc(t('ddCopyPath')) + '</button>'
          + (fi?.exists && detail?.caption?.editor_safe === true
            ? '<button type="button" class="btn btn-sm btn-primary" @click="openDatasetDiagInTagEditor()">' + this.esc(t('ddOpenTagEditor')) + '</button>'
            : '')
          + '</div>';
      }

      const rightEl = document.getElementById('datasetDiagModalRight');
      if (!rightEl) return;

      if (this.datasetDiagModalLoading && !detail) {
        (rightEl._ddModalROs || []).forEach(ro => ro.disconnect());
        rightEl._ddModalROs = [];
        rightEl.innerHTML = '<div class="dashboard-empty dashboard-empty-compact m-dd-modal-loading"><p>' + this.esc(t('loading')) + '</p></div>';
        return;
      }
      if (this.datasetDiagModalError && !detail) {
        (rightEl._ddModalROs || []).forEach(ro => ro.disconnect());
        rightEl._ddModalROs = [];
        const modalError = this.datasetDiagModalError === 'loadFailed' ? t('ddModalLoadFailed') : this.datasetDiagModalError;
        rightEl.innerHTML = '<div class="dashboard-empty dashboard-empty-compact dashboard-empty-danger"><p>' + this.esc(modalError) + '</p></div>';
        return;
      }
      if (!detail) {
        rightEl.innerHTML = '';
        return;
      }

      rightEl.innerHTML = this._renderDatasetDiagModalRightHtml(t, detail);
      this._bindDatasetDiagModalCharts(rightEl, detail, t);
    },

    _renderDatasetDiagModalRightHtml(t, detail) {
      const img = detail.image || {};
      const cap = detail.caption || {};
      const epochs = (detail.epoch_series || []).filter(row => row.mean_residual != null);
      const samples = detail.samples || [];
      const resColor = this._ddResidualColor(img.mean_residual);
      const slopeColor = this._ddSlopeColor(img.slope);
      const hasNan = (img.non_finite_count || 0) > 0;

      let html = '';

      if (hasNan) {
        const nfSamples = samples.filter(s => s.non_finite);
        const firstNf = nfSamples[0];
        const coordsHtml = firstNf
          ? '<span class="m-dd-nan-coords">'
            + `<span>${this.esc(t('ddEpochLabel'))} ${this.esc(firstNf.epoch ?? '?')}</span>`
            + `<span>${this.esc(t('ddStepLabel'))} ${this.esc(firstNf.step ?? '?')}</span>`
            + `<span>t = ${this.esc(this._ddFormatTimestep(firstNf.timestep, detail.timestep_scale))}</span>`
            + '</span>'
          : '';
        const extraHtml = img.non_finite_count > 1
          ? '<span class="m-dd-nan-extra">' + this.esc(t('ddNanTotalCount').replace('{n}', img.non_finite_count)) + '</span>'
          : '';
        html += '<div class="m-dd-nan-row">'
          + '<span class="m-dd-nan-label">' + this.esc(t('ddNanSampleLabel')) + '</span>'
          + '<div class="m-dd-nan-meta">' + coordsHtml + extraHtml + '</div>'
          + '</div>';
      }

      html += '<div class="m-dd-modal-stats">';
      html += '<div class="m-dd-stat"><span>' + this.esc(t('ddKpiRelative')) + '</span><strong style="color:' + resColor + '">' + this.esc(this._ddFormatResidual(img.mean_residual)) + '</strong></div>';
      html += '<div class="m-dd-stat"><span>' + this.esc(t('ddKpiSlope')) + '</span><strong style="color:' + slopeColor + '">' + this.esc(this._ddFormatSlope(img.slope)) + '</strong></div>';
      html += '<div class="m-dd-stat"><span>' + this.esc(t('ddKpiMeanLoss')) + '</span><strong>' + this.esc(this._ddFormatLoss(img.mean_loss)) + '</strong></div>';
      html += '<div class="m-dd-stat"><span>' + this.esc(t('ddFiniteSamples')) + '</span><strong>'
        + this.esc(img.count) + '</strong><span>'
        + this.esc(t('ddEpochCoverage').replace('{n}', img.epochs)) + '</span></div>';
      html += '</div>';
      if (img.comparable_count != null && img.comparable_count < img.count) {
        html += '<p class="m-dd-notice-strip">' + this.esc(t('ddComparableCount').replace('{n}', img.comparable_count).replace('{total}', img.count)) + '</p>';
      }

      // 3-zone noise breakdown strip
      const imgZones = img.noise_zones || {};
      const zoneDefs = [
        ['high', t('ddModalZoneHigh'), '1000–667'],
        ['mid', t('ddModalZoneMid'), '667–333'],
        ['low', t('ddModalZoneLow'), '333–0'],
      ];
      html += '<div class="m-dd-modal-zones">';
      zoneDefs.forEach(([key, label, range]) => {
        const z = imgZones[key];
        const zVal = z ? this._ddFormatResidual(z.mean_residual) : '—';
        const zColor = z ? this._ddResidualColor(z.mean_residual) : 'var(--text-tertiary)';
        const zCountText = z
          ? t('ddZoneCount').replace('{n}', z.count)
          : t('ddZoneEmpty');
        html += '<div class="m-dd-modal-zone">'
          + '<span class="m-dd-modal-zone-label">' + this.esc(`${label} (${range})`) + '</span>'
          + '<strong style="color:' + zColor + '">' + this.esc(zVal) + '</strong>'
          + '<span class="m-dd-modal-zone-count">' + this.esc(zCountText) + '</span>'
          + '</div>';
      });
      html += '</div>';

      // Chart 1: Per-Epoch change (separated Row 1 title+legend / Row 2 fixed readout)
      html += '<section class="m-dd-modal-sec">';
      html += '<div class="m-dd-modal-sec-head">'
        + '<span class="m-dd-sec-title">' + this.esc(t('ddEpochTrendTitle')) + '</span>'
        + (epochs.length >= 2
          ? '<div class="m-dd-legend">'
            + '<span class="m-dd-leg"><i class="is-line-accent"></i><span>' + this.esc(t('ddLegEpochMean')) + '</span></span>'
            + (epochs.length >= 3 ? '<span class="m-dd-leg"><i class="is-line-dash"></i><span>' + this.esc(t('ddLegTrend')) + '</span></span>' : '')
            + '</div>'
          : '')
        + '</div>';
      if (epochs.length >= 2) {
        html += '<div class="m-dd-mini-readout" data-dd-epoch-readout>'
          + '<span class="m-dd-mini-idle">' + this.esc(t('ddEpochHoverHint')) + '</span>'
          + '<div class="m-dd-mini-live" data-dd-epoch-hud></div>'
          + '</div>';
        html += '<div class="m-dd-mini-stage" data-dd-epoch-stage><svg class="m-dd-mini-svg" data-dd-epoch-svg aria-hidden="true"></svg></div>';
      } else {
        html += '<p class="m-dd-mini-empty">' + this.esc(t('ddEpochTrendFew')) + '</p>';
      }
      html += '</section>';

      // Chart 2: Timestep vs Loss overlay (1000 → 0, separated Row 1 title+legend / Row 2 fixed readout)
      const hasAnyTs = detail.timestep_scale !== 'unknown' && samples.some(s => s.timestep != null);
      html += '<section class="m-dd-modal-sec">';
      html += '<div class="m-dd-modal-sec-head">'
        + '<span class="m-dd-sec-title">' + this.esc(t('ddTimestepOverlayTitle')) + '</span>'
        + (hasAnyTs
          ? '<div class="m-dd-legend">'
            + (detail.by_timestep?.length ? '<span class="m-dd-leg"><i class="is-line-base"></i><span>' + this.esc(t('ddLegDatasetBase')) + '</span></span>' : '')
            + '<span class="m-dd-leg"><i class="is-dot is-sample"></i><span>' + this.esc(t('ddLegThisImage')) + '</span></span>'
            + (samples.some(s => s.non_finite) ? '<span class="m-dd-leg"><i class="is-nan-x">×</i><span>NaN / Inf</span></span>' : '')
            + '</div>'
          : '')
        + '</div>';
      if (hasAnyTs) {
        html += '<div class="m-dd-mini-readout" data-dd-ts-readout>'
          + '<span class="m-dd-mini-idle">' + this.esc(t('ddModalTimestepHoverHint')) + '</span>'
          + '<div class="m-dd-mini-live" data-dd-ts-hud></div>'
          + '</div>';
        html += '<div class="m-dd-mini-stage" data-dd-ts-stage><svg class="m-dd-mini-svg" data-dd-ts-svg aria-hidden="true"></svg></div>';
      } else {
        html += '<p class="m-dd-mini-empty">' + this.esc(t('ddTimestepOverlayEmpty')) + '</p>';
      }
      html += '</section>';

      // Caption section
      html += '<section class="m-dd-modal-sec m-dd-caption-sec">';
      html += '<div class="m-dd-modal-sec-head">'
        + '<div class="m-dd-cap-head-left">'
        + '<span class="m-dd-sec-title">' + this.esc(cap.source === 'class_tokens' ? t('ddClassTokens') : t('ddCaptionTitle')) + '</span>'
        + (cap.filename && cap.source !== 'class_tokens' ? '<span class="m-dd-cap-file" title="' + this.esc(cap.path || cap.filename) + '">' + this.esc(cap.filename) + '</span>' : '')
        + '</div>';
      if (cap.path && cap.editor_safe === false && cap.source !== 'class_tokens') {
        html += '<button type="button" class="btn btn-sm btn-secondary" @click="copyDatasetDiagText(datasetDiagModalDetail.caption.path)">' + this.esc(t('ddCopyCaptionPath')) + '</button>';
      }
      if (cap.exists && cap.text) {
        html += '<button type="button" class="btn btn-sm btn-ghost" @click="copyDatasetDiagText(datasetDiagModalDetail.caption.text)">' + this.esc(t('copy')) + '</button>';
      }
      html += '</div>';
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

      // Samples collapsible table
      html += '<details class="m-dd-samples-details"><summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg><span>'
        + this.esc(t('ddSamplesLogTitle').replace('{n}', detail.samples_total || samples.length))
        + '</span></summary>';
      if (detail.samples_truncated) {
        html += '<p class="m-dd-mini-empty m-dd-samples-trunc">' + this.esc(t('ddSamplesTruncated').replace('{n}', samples.length)) + '</p>';
      }
      html += '<div class="m-dd-samples-table"><div class="m-dd-sample-head"><span>' + this.esc(t('ddEpochLabel')) + '</span><span>' + this.esc(t('ddStepLabel')) + '</span><span>' + this.esc(t('ddColTimestep')) + '</span><span>' + this.esc(t('ddLossLabel')) + '</span><span>' + this.esc(t('ddColRelativeShort')) + '</span><span>' + this.esc(t('ddDimResolution')) + '</span></div>';
      samples.slice().reverse().forEach(s => {
        const resColorCell = s.non_finite ? 'var(--danger)' : this._ddResidualColor(s.residual);
        html += '<div class="m-dd-sample-row">'
          + '<span>' + this.esc(s.epoch ?? '—') + '</span>'
          + '<span>' + this.esc(s.step ?? '—') + '</span>'
          + '<span>' + this.esc(this._ddFormatTimestep(s.timestep, detail.timestep_scale)) + '</span>'
          + '<span>' + this.esc(s.non_finite ? 'NaN / Inf' : this._ddFormatLoss(s.loss)) + '</span>'
          + '<span style="color:' + resColorCell + '">' + this.esc(this._ddFormatResidual(s.residual)) + '</span>'
          + '<span>' + this.esc(s.width && s.height ? `${s.width} × ${s.height}` : '—') + '</span>'
          + '</div>';
      });
      html += '</div></details>';
      return html;
    },

    _bindDatasetDiagModalCharts(rightEl, detail, t) {
      (rightEl._ddModalROs || []).forEach(ro => ro.disconnect());
      rightEl._ddModalROs = [];

      const epStage = rightEl.querySelector('[data-dd-epoch-stage]');
      const epSvg = rightEl.querySelector('[data-dd-epoch-svg]');
      const epReadout = rightEl.querySelector('[data-dd-epoch-readout]');
      const epHud = rightEl.querySelector('[data-dd-epoch-hud]');
      if (epStage && epSvg) {
        let epRaf = 0;
        const renderEp = () => {
          epRaf = 0;
          const nextW = Math.round(epStage.clientWidth || 0);
          if (nextW > 60 && Math.abs(nextW - (epStage._ddLastW || 0)) >= 2) {
            epStage._ddLastW = nextW;
            this._renderDatasetDiagModalEpochSvg(epStage, epSvg, epHud, detail, t);
          }
        };
        epRaf = requestAnimationFrame(renderEp);
        if (typeof ResizeObserver !== 'undefined') {
          const roEp = new ResizeObserver(() => {
            if (!epRaf) epRaf = requestAnimationFrame(renderEp);
          });
          roEp.observe(epStage);
          rightEl._ddModalROs.push({
            disconnect() {
              roEp.disconnect();
              if (epRaf) { cancelAnimationFrame(epRaf); epRaf = 0; }
            },
          });
        }
        epStage.addEventListener('pointermove', event => {
          const st = epStage._ddState;
          if (!st || !st.coords.length) return;
          const rect = epStage.getBoundingClientRect();
          const x = event.clientX - rect.left;
          let best = st.coords[0], dist = Infinity;
          for (const c of st.coords) {
            const d = Math.abs(c.x - x);
            if (d < dist) { dist = d; best = c; }
          }
          const ch = epSvg.querySelector('[data-dd-ep-ch]');
          if (ch) {
            ch.setAttribute('x1', best.x.toFixed(1));
            ch.setAttribute('x2', best.x.toFixed(1));
            ch.removeAttribute('display');
          }
          const dot = epSvg.querySelector('[data-dd-ep-focus]');
          if (dot) {
            dot.setAttribute('cx', best.x.toFixed(1));
            dot.setAttribute('cy', best.y.toFixed(1));
            dot.removeAttribute('display');
          }
          epReadout?.classList.add('is-hovering');
          if (epHud) {
            epHud.innerHTML = `<span class="m-dd-ro-metric"><b class="m-dd-ro-num">${this.esc(t('ddEpochLabel'))} ${this.esc(best.epoch)}</b></span>`
              + `<span class="m-dd-ro-metric"><em>${this.esc(t('ddColRelativeShort'))}</em><b class="m-dd-ro-num" style="min-inline-size:6.5ch">${this.esc(this._ddFormatResidual(best.mean_residual))}</b></span>`
              + `<span class="m-dd-ro-metric"><em>${this.esc(t('ddLossLabel'))}</em><b class="m-dd-ro-num" style="min-inline-size:6.5ch">${this.esc(this._ddFormatLoss(best.mean_loss))}</b></span>`;
          }
        });
        epStage.addEventListener('pointerleave', () => {
          epSvg.querySelector('[data-dd-ep-ch]')?.setAttribute('display', 'none');
          epSvg.querySelector('[data-dd-ep-focus]')?.setAttribute('display', 'none');
          epReadout?.classList.remove('is-hovering');
          if (epHud) epHud.innerHTML = '';
        });
      }

      const tsStage = rightEl.querySelector('[data-dd-ts-stage]');
      const tsSvg = rightEl.querySelector('[data-dd-ts-svg]');
      const tsReadout = rightEl.querySelector('[data-dd-ts-readout]');
      const tsHud = rightEl.querySelector('[data-dd-ts-hud]');
      if (tsStage && tsSvg) {
        let tsRaf = 0;
        const renderTs = () => {
          tsRaf = 0;
          const nextW = Math.round(tsStage.clientWidth || 0);
          if (nextW > 60 && Math.abs(nextW - (tsStage._ddLastW || 0)) >= 2) {
            tsStage._ddLastW = nextW;
            this._renderDatasetDiagModalTimestepSvg(tsStage, tsSvg, detail, t);
          }
        };
        tsRaf = requestAnimationFrame(renderTs);
        if (typeof ResizeObserver !== 'undefined') {
          const roTs = new ResizeObserver(() => {
            if (!tsRaf) tsRaf = requestAnimationFrame(renderTs);
          });
          roTs.observe(tsStage);
          rightEl._ddModalROs.push({
            disconnect() {
              roTs.disconnect();
              if (tsRaf) { cancelAnimationFrame(tsRaf); tsRaf = 0; }
            },
          });
        }
        tsStage.addEventListener('pointermove', event => {
          const st = tsStage._ddState;
          if (!st || !st.dots.length) return;
          const rect = tsStage.getBoundingClientRect();
          const x = event.clientX - rect.left, y = event.clientY - rect.top;
          let best = null, bestD2 = 24 * 24;
          for (const d of st.dots) {
            const dx = d.cx - x, dy = d.cy - y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= bestD2) { bestD2 = d2; best = d; }
          }
          const focus = tsSvg.querySelector('[data-dd-ts-focus]');
          if (!best) {
            focus?.setAttribute('display', 'none');
            tsReadout?.classList.remove('is-hovering');
            if (tsHud) tsHud.innerHTML = '';
            return;
          }
          if (focus) {
            focus.setAttribute('cx', best.cx.toFixed(1));
            focus.setAttribute('cy', best.cy.toFixed(1));
            focus.setAttribute('stroke', best.non_finite ? 'var(--danger)' : 'var(--accent)');
            focus.removeAttribute('display');
          }
          tsReadout?.classList.add('is-hovering');
          if (tsHud) {
            const epShort = this.esc(t('ddEpShort'));
            const stepLabel = this.esc(t('ddStepLabel'));
            const tsText = this._ddFormatTimestep(best.timestep, detail.timestep_scale);
            tsHud.innerHTML = best.non_finite
              ? `<span class="m-dd-ro-metric"><b class="m-dd-ro-num">${epShort} ${this.esc(best.epoch ?? '?')} / ${stepLabel} ${this.esc(best.step ?? '?')}</b></span>`
                + `<span class="m-dd-ro-metric"><em>t</em><b class="m-dd-ro-num" style="min-inline-size:3.5ch">${this.esc(tsText)}</b></span>`
                + `<span class="m-dd-ro-metric is-danger"><b class="m-dd-ro-num">NaN / Inf</b></span>`
              : `<span class="m-dd-ro-metric"><b class="m-dd-ro-num">${epShort} ${this.esc(best.epoch ?? '?')} / ${stepLabel} ${this.esc(best.step ?? '?')}</b></span>`
                + `<span class="m-dd-ro-metric"><em>t</em><b class="m-dd-ro-num" style="min-inline-size:3.5ch">${this.esc(tsText)}</b></span>`
                + `<span class="m-dd-ro-metric"><em>${this.esc(t('ddLossLabel'))}</em><b class="m-dd-ro-num" style="min-inline-size:6.5ch">${this.esc(this._ddFormatLoss(best.loss))}</b></span>`
                + `<span class="m-dd-ro-metric"><b class="m-dd-ro-num" style="min-inline-size:6.5ch;color:${this._ddResidualColor(best.residual)}">${this.esc(this._ddFormatResidual(best.residual))}</b></span>`;
          }
        });
        tsStage.addEventListener('pointerleave', () => {
          tsSvg.querySelector('[data-dd-ts-focus]')?.setAttribute('display', 'none');
          tsReadout?.classList.remove('is-hovering');
          if (tsHud) tsHud.innerHTML = '';
        });
      }
    },

    _renderDatasetDiagModalEpochSvg(stage, svg, hud, detail, t) {
      const series = (detail.epoch_series || []).filter(row => row.mean_residual != null);
      if (series.length < 2) return;
      const width = Math.max(240, Math.round(stage.clientWidth || 380));
      const height = 136;
      const padL = 46, padR = 14, padT = 12, padB = 24;
      const plotW = Math.max(60, width - padL - padR);
      const plotH = Math.max(40, height - padT - padB);

      const vals = series.map(s => s.mean_residual);
      const minV = Math.min(-0.1, Math.min(...vals) * 1.15);
      const maxV = Math.max(0.22, Math.max(...vals) * 1.15);
      const spanV = Math.max(maxV - minV, 0.05);
      const minE = series[0].epoch, maxE = series.at(-1).epoch;
      const spanE = Math.max(maxE - minE, 1);

      const toX = ep => padL + ((ep - minE) / spanE) * plotW;
      const toY = v => padT + plotH - ((v - minV) / spanV) * plotH;

      const coords = series.map(s => ({ ...s, x: toX(s.epoch), y: toY(s.mean_residual) }));
      const pathD = coords.map((c, i) => (i ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1)).join(' ');
      const yZero = toY(0);

      const slope = detail.image?.slope;
      let trendHtml = '';
      if (slope != null && series.length >= 3) {
        const meanX = series.reduce((a, b) => a + b.epoch, 0) / series.length;
        const meanY = series.reduce((a, b) => a + b.mean_residual, 0) / series.length;
        const y1 = meanY + slope * (minE - meanX);
        const y2 = meanY + slope * (maxE - meanX);
        trendHtml = `<line class="m-dd-trend-line" x1="${toX(minE).toFixed(1)}" y1="${toY(y1).toFixed(1)}" x2="${toX(maxE).toFixed(1)}" y2="${toY(y2).toFixed(1)}"/>`;
      }

      const dotsHtml = coords.map(c =>
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" style="fill:${this._ddResidualColor(c.mean_residual)}" stroke="var(--monitor-card-bg)" stroke-width="1.2"/>`
      ).join('');

      const showTopTick = Math.abs((padT + 4) - (yZero + 3)) >= 14;
      const showBotTick = Math.abs((padT + plotH + 1) - (yZero + 3)) >= 14;

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));
      svg.innerHTML = `
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT}" y2="${padT}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT + plotH}" y2="${padT + plotH}" class="is-axis"/>
        </g>
        <g class="m-dd-ref-lines"><line x1="${padL}" x2="${padL + plotW}" y1="${yZero.toFixed(1)}" y2="${yZero.toFixed(1)}"/></g>
        <line class="m-dd-mini-ch" data-dd-ep-ch y1="${padT}" y2="${padT + plotH}" display="none"/>
        ${trendHtml}
        <path class="m-dd-ep-line" d="${pathD}"/>
        <g>${dotsHtml}</g>
        <circle class="m-dd-dot-focus" data-dd-ep-focus r="5.5" stroke="var(--accent)" display="none"/>
        <g class="m-chart-axes">
          ${showTopTick ? `<text x="${padL - 5}" y="${padT + 4}" text-anchor="end">${this._ddFormatResidual(maxV)}</text>` : ''}
          <text x="${padL - 5}" y="${(yZero + 3).toFixed(1)}" text-anchor="end">0%</text>
          ${showBotTick ? `<text x="${padL - 5}" y="${padT + plotH + 1}" text-anchor="end">${this._ddFormatResidual(minV)}</text>` : ''}
          <text x="${padL}" y="${height - 5}" text-anchor="start">${this.esc(t('ddEpochLabel'))} ${minE}</text>
          <text x="${padL + plotW}" y="${height - 5}" text-anchor="end">${this.esc(t('ddEpochLabel'))} ${maxE}</text>
        </g>`;

      stage._ddState = { coords };
    },

    _renderDatasetDiagModalTimestepSvg(stage, svg, detail, t) {
      const bins = detail.by_timestep || [];
      const scale = detail.timestep_scale || 'thousand';
      const finiteSamples = (detail.samples || []).filter(s => s.timestep != null && !s.non_finite && s.loss != null);
      const nfSamples = (detail.samples || []).filter(s => s.timestep != null && s.non_finite);
      if (!finiteSamples.length && !nfSamples.length) return;
      const width = Math.max(240, Math.round(stage.clientWidth || 380));
      const height = 148;
      const padL = 48, padR = 14, padT = 18, padB = 24;
      const plotW = Math.max(60, width - padL - padR);
      const plotH = Math.max(40, height - padT - padB);

      const rawMidPts = bins.map(b => {
        const tFrom = this._ddToTimestep1000(b.timestep_from, scale) ?? 0;
        const tTo = this._ddToTimestep1000(b.timestep_to, scale) ?? tFrom;
        return { t: (tFrom + tTo) / 2, loss: b.mean_loss, tFrom, tTo };
      });
      // Sort descending so points walk strictly left (t=1000) to right (t=0)
      const descMids = rawMidPts.slice().sort((a, b) => b.t - a.t);
      const basePts = descMids.length >= 2
        ? [{ t: descMids[0].tTo, loss: descMids[0].loss }, ...descMids.map(p => ({ t: p.t, loss: p.loss })), { t: descMids.at(-1).tFrom, loss: descMids.at(-1).loss }]
        : descMids.map(p => ({ t: p.t, loss: p.loss }));

      const allL = [...basePts.map(p => p.loss), ...finiteSamples.map(s => s.loss)];
      const lMin = allL.length ? Math.max(0, Math.min(...allL) * 0.9) : 0;
      const lMax = allL.length ? Math.max(...allL) * 1.12 : 1;
      const lSpan = Math.max(lMax - lMin, 1e-6);

      // Unified 1000 (left, high noise) → 0 (right, low noise) linear scale
      const toX = t1000 => padL + ((1000 - t1000) / 1000) * plotW;
      const toY = v => padT + plotH - ((v - lMin) / lSpan) * plotH;

      const baseD = basePts.map((p, i) => (i ? 'L' : 'M') + toX(p.t).toFixed(1) + ' ' + toY(p.loss).toFixed(1)).join(' ');
      const areaD = basePts.length >= 2
        ? `${baseD} L${toX(basePts.at(-1).t).toFixed(1)} ${(padT + plotH).toFixed(1)} L${toX(basePts[0].t).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
        : '';

      const finiteDots = finiteSamples.map(s => {
        const t1000 = this._ddToTimestep1000(s.timestep, scale);
        if (t1000 == null) return null;
        const cx = toX(t1000), cy = toY(s.loss);
        const fill = this._ddResidualColor(s.residual);
        return { ...s, t1000, cx, cy, fill };
      }).filter(Boolean);
      const nfDots = nfSamples.map(s => {
        const t1000 = this._ddToTimestep1000(s.timestep, scale);
        if (t1000 == null) return null;
        return {
          ...s,
          t1000,
          cx: toX(t1000),
          cy: padT + 8,
        };
      }).filter(Boolean);

      const dotsHtml = finiteDots.map(d =>
        `<circle cx="${d.cx.toFixed(1)}" cy="${d.cy.toFixed(1)}" r="3.6" style="fill:${d.fill}" stroke="var(--monitor-card-bg)" stroke-width="1.1"/>`
      ).join('') + nfDots.map(d =>
        `<g class="m-dd-nan-mark"><line x1="${(d.cx - 3.2).toFixed(1)}" y1="${(d.cy - 3.2).toFixed(1)}" x2="${(d.cx + 3.2).toFixed(1)}" y2="${(d.cy + 3.2).toFixed(1)}"/><line x1="${(d.cx + 3.2).toFixed(1)}" y1="${(d.cy - 3.2).toFixed(1)}" x2="${(d.cx - 3.2).toFixed(1)}" y2="${(d.cy + 3.2).toFixed(1)}"/></g>`
      ).join('');

      const xDiv667 = toX(2000 / 3);
      const xDiv333 = toX(1000 / 3);

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', String(height));
      svg.innerHTML = `
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT}" y2="${padT}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT + plotH}" y2="${padT + plotH}" class="is-axis"/>
        </g>
        <g class="m-dd-ref-lines">
          <line x1="${xDiv667.toFixed(1)}" x2="${xDiv667.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>
          <line x1="${xDiv333.toFixed(1)}" x2="${xDiv333.toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>
        </g>
        <g class="m-dd-mini-zone-labels">
          <text x="${((padL + xDiv667) / 2).toFixed(1)}" y="${padT - 5}" text-anchor="middle">${this.esc(t('ddZoneHighShort'))}</text>
          <text x="${((xDiv667 + xDiv333) / 2).toFixed(1)}" y="${padT - 5}" text-anchor="middle">${this.esc(t('ddZoneMidShort'))}</text>
          <text x="${((xDiv333 + padL + plotW) / 2).toFixed(1)}" y="${padT - 5}" text-anchor="middle">${this.esc(t('ddZoneLowShort'))}</text>
        </g>
        ${areaD ? `<path class="m-dd-base-area" d="${areaD}"/>` : ''}
        <path class="m-dd-base-line" d="${baseD}"/>
        <g>${dotsHtml}</g>
        <circle class="m-dd-dot-focus" data-dd-ts-focus r="6" stroke="var(--accent)" display="none"/>
        <g class="m-chart-axes">
          <text x="${padL - 5}" y="${padT + 4}" text-anchor="end">${allL.length ? this._ddFormatLoss(lMax) : ''}</text>
          <text x="${padL - 5}" y="${padT + plotH + 1}" text-anchor="end">${allL.length ? this._ddFormatLoss(lMin) : ''}</text>
          <text x="${padL}" y="${height - 5}" text-anchor="start">1000</text>
          <text x="${toX(500).toFixed(1)}" y="${height - 5}" text-anchor="middle">500</text>
          <text x="${padL + plotW}" y="${height - 5}" text-anchor="end">0</text>
        </g>`;

      stage._ddState = { dots: [...finiteDots, ...nfDots] };
    },
  };
})();
