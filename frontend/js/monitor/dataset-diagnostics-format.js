/* 训练集诊断格式化、顶栏/总览卡片与分组对比渲染；由 dataset-diagnostics-render.js 聚合。 */
(() => {
  window.datasetDiagnosticsFormatMixin = {
    _ddResidualColor(residual, options = {}) {
      const isGraphic = options?.kind === 'graphic';
      if (residual == null || !Number.isFinite(Number(residual))) {
        return isGraphic ? 'var(--text-tertiary)' : 'var(--text-secondary)';
      }
      const val = Number(residual);
      if (Math.abs(val) < 0.003) {
        return isGraphic
          ? 'var(--text-tertiary)'
          : 'color-mix(in srgb, var(--text-primary) 80%, var(--text-secondary))';
      }
      const isGroup = options?.scale === 'group';
      const negFull = isGroup ? 0.15 : 0.25;
      const posWarn = isGroup ? 0.12 : 0.20;
      const posDangerSpan = isGroup ? 0.14 : 0.28;
      const base = isGraphic
        ? 'var(--text-tertiary)'
        : 'color-mix(in srgb, var(--text-primary) 45%, var(--text-tertiary))';
      const okTone = isGraphic ? 'var(--success)' : 'var(--diag-tone-ok, var(--success))';
      const warnTone = isGraphic ? 'var(--warning)' : 'var(--diag-tone-warn, var(--warning))';
      const dangerTone = isGraphic ? 'var(--danger)' : 'var(--diag-tone-danger, var(--danger))';
      if (val < 0) {
        const t = Math.min(1, Math.pow(Math.abs(val) / negFull, 0.55));
        const pct = isGraphic ? Math.round(38 + t * 62) : Math.round(36 + t * 58);
        return `color-mix(in srgb, ${okTone} ${pct}%, ${base})`;
      }
      if (val <= posWarn) {
        const t = Math.min(1, Math.pow(val / posWarn, 0.55));
        const pct = isGraphic ? Math.round(40 + t * 60) : Math.round(38 + t * 56);
        return `color-mix(in srgb, ${warnTone} ${pct}%, ${base})`;
      }
      const t = Math.min(1, (val - posWarn) / posDangerSpan);
      const pct = Math.round(t * 96);
      return `color-mix(in srgb, ${dangerTone} ${pct}%, ${warnTone})`;
    },

    _ddConvergingSlopeThreshold() {
      const val = Number(this.datasetDiagData?.thresholds?.converging_slope);
      return Number.isFinite(val) && val < 0 ? val : -0.02;
    },

    _ddSlopeColor(slope, convSlope = this._ddConvergingSlopeThreshold()) {
      if (slope == null || slope === '' || !Number.isFinite(Number(slope))) return 'var(--text-secondary)';
      const val = Number(slope);
      if (val <= convSlope) return 'color-mix(in srgb, var(--diag-tone-ok, var(--success)) 86%, var(--text-primary))';
      if (val >= Math.max(0.002, Math.abs(convSlope) * 0.5)) return 'color-mix(in srgb, var(--diag-tone-danger, var(--danger)) 82%, var(--text-primary))';
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

    _ddFormatLossRangeNum(value) {
      if (value == null || !Number.isFinite(Number(value))) return '—';
      const n = Number(value);
      if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return n.toFixed(3);
      return n.toFixed(2);
    },

    _ddFormatZoneTrend(value) {
      if (value == null || !Number.isFinite(Number(value))) return '';
      const pct = Math.round(Number(value) * 100);
      if (pct === 0) return '0%';
      return (pct > 0 ? '+' : '') + pct + '%';
    },

    _ddFormatTrendExact(value) {
      if (value == null || !Number.isFinite(Number(value))) return '';
      let pct = Number(value) * 100;
      if (Math.abs(pct) < 0.05) pct = 0;
      return (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
    },

    _ddTrendToneClass(value) {
      if (value == null || !Number.isFinite(Number(value))) return '';
      const v = Number(value);
      if (v <= -0.03) return 'is-good';
      if (v >= 0.015) return 'is-warn';
      return 'is-muted';
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
      if (status === 'easy') return { label: t('ddStatusLow'), tone: 'ok' };
      if (status === 'insufficient') return { label: t('ddStatusInsufficient'), tone: 'muted' };
      return { label: t('ddStatusNormal'), tone: 'neutral' };
    },

    _ddStatusDotColor(status) {
      if (status === 'non_finite') return 'var(--danger)';
      if (status === 'attention') return 'var(--warning)';
      if (status === 'learning') return 'var(--accent)';
      if (status === 'easy') return 'var(--success)';
      if (status === 'insufficient' || status === 'insufficient_reference') {
        return 'color-mix(in srgb, var(--text-tertiary) 65%, var(--border-default))';
      }
      return 'color-mix(in srgb, var(--text-secondary) 72%, var(--border-default))';
    },

    _ddScatterDotSpec(status) {
      if (status === 'non_finite') return { r: 5.2, cls: 'm-dd-dot is-alert' };
      if (status === 'attention') return { r: 5.0, cls: 'm-dd-dot is-alert' };
      if (status === 'learning') return { r: 4.6, cls: 'm-dd-dot is-learning' };
      if (status === 'easy') return { r: 4.0, cls: 'm-dd-dot is-easy' };
      if (status === 'insufficient' || status === 'insufficient_reference') return { r: 3.5, cls: 'm-dd-dot is-muted' };
      return { r: 3.8, cls: 'm-dd-dot is-muted' };
    },

    _ddSelectHtml(options, value, label, id, action, valueBinding = '', optionsBinding = '') {
      if (typeof this._monitorSelectHtml === 'function') {
        return this._monitorSelectHtml(options, value, label, id, action, 'm-dd-select', valueBinding, optionsBinding);
      }
      if (typeof window.previewSelectHtml === 'function') {
        const handler = action.replaceAll('$event.target.value', '$event.detail')
          + '; $nextTick(() => document.getElementById(' + JSON.stringify(id) + ')?.focus({ preventScroll: true }))';
        const select = valueBinding || optionsBinding
          ? window.previewSelectHtml(options, value, label, id, valueBinding, optionsBinding)
          : window.previewSelectHtml(options, value, label, id);
        return '<div class="m-sample-select m-compact-select m-dd-select" @preview-select="' + this.esc(handler) + '">' + select + '</div>';
      }
      return '<select id="' + this.esc(id) + '" class="m-compact-select m-dd-select m-dd-native-select" aria-label="' + this.esc(label) + '"'
        + (valueBinding ? ' :value="' + this.esc(valueBinding) + '"' : '') + ' @change="' + this.esc(action) + '">'
        + options.map(opt => '<option value="' + this.esc(opt.value) + '"' + (String(opt.value) === String(value) ? ' selected' : '') + '>'
          + this.esc(opt.label) + '</option>').join('')
        + '</select>';
    },

    _ddGaugeMetrics(residual, maxAbs = 0.6, options = {}) {
      if (residual == null || !Number.isFinite(Number(residual))) {
        return { valid: false, left: 50, width: 0, color: 'transparent', isNeg: false };
      }
      const val = Number(residual);
      const isGroup = options?.scale === 'group';
      const bound = Math.max(isGroup ? 0.20 : 0.45, Number(maxAbs) || (isGroup ? 0.20 : 0.6));
      const knee = isGroup ? 0.12 : 0.20;
      const denom = Math.log1p(bound / knee);
      const norm = Math.sign(val) * (Math.log1p(Math.abs(val) / knee) / Math.max(denom, 1e-6));
      const pos = Math.max(2, Math.min(98, 50 + norm * 48));
      const isNeg = val < -0.002;
      const isPos = val > 0.002;
      const left = isNeg ? pos : 50;
      const width = isNeg || isPos ? Math.max(1.5, Math.abs(pos - 50)) : 0;
      return {
        valid: true,
        left,
        width,
        color: this._ddResidualColor(val, { scale: isGroup ? 'group' : 'image', kind: 'graphic' }),
        isNeg,
      };
    },

    _ddResidualBarHtml(residual, maxAbs = 0.6, options = {}) {
      const m = this._ddGaugeMetrics(residual, maxAbs, options);
      if (!m.valid) {
        return '<div class="m-gauge m-gauge-change m-dd-gauge" aria-hidden="true"><div class="m-gauge-track"><span class="m-gauge-zero" style="left:50%"></span></div></div>';
      }
      return '<div class="m-gauge m-gauge-change m-dd-gauge" aria-hidden="true"><div class="m-gauge-track">'
        + '<span class="m-gauge-zero" style="left:50%"></span>'
        + '<span class="m-gauge-fill ' + (m.isNeg ? 'is-neg' : 'is-pos') + '" style="left:' + m.left.toFixed(1)
        + '%;width:' + m.width.toFixed(1) + '%;--gauge-bar-color:' + m.color + '"></span>'
        + '</div></div>';
    },

    _ddMinCountOptions() {
      const t = k => this.tMonitor(k);
      return [1, 3, 5, 10].map(n => ({
        value: n,
        label: t('ddMinCountOpt').replace('{n}', n),
      }));
    },

    _ddRunOptions() {
      const t = k => this.tMonitor(k);
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
      const t = k => this.tMonitor(k);
      return [
        { value: 'residual_desc', label: t('ddSortResidualDesc') },
        { value: 'residual_asc', label: t('ddSortResidualAsc') },
        { value: 'slope_desc', label: t('ddSortSlopeDesc') },
        { value: 'slope_asc', label: t('ddSortSlopeAsc') },
        { value: 'loss_desc', label: t('ddSortLossDesc') },
        { value: 'loss_asc', label: t('ddSortLossAsc') },
        { value: 'count_desc', label: t('ddSortCountDesc') },
        { value: 'count_asc', label: t('ddSortCountAsc') },
        { value: 'name_asc', label: t('ddSortNameAsc') },
        { value: 'name_desc', label: t('ddSortNameDesc') },
      ];
    },

    _ddRegOptions() {
      const t = k => this.tMonitor(k);
      return [
        { value: 'exclude', label: t('ddRegExclude') },
        { value: 'only', label: t('ddRegOnly') },
        { value: 'all', label: t('ddRegInclude') },
      ];
    },

    _ddNotableDimLabel(t, dim) {
      if (dim === 'resolution') return t('ddDimResolution');
      if (dim === 'subset') return t('ddDimSubset');
      if (dim === 'directory') return t('ddDimDirectory');
      return '';
    },

    _ddVerdictInfo(t, data) {
      const summary = data.summary || {};
      const counts = summary.counts || {};
      const nf = counts.non_finite || 0;
      const att = counts.attention || 0;
      const learn = counts.learning || 0;
      const qualified = summary.images_qualified || 0;
      const total = summary.images_total || 0;
      const hasSlope = !!summary.has_slope;
      let code = data.verdict?.code;
      let tone = data.verdict?.tone;
      if (!code) {
        if (nf > 0 || (summary.non_finite_total || 0) > 0) { code = 'non_finite'; tone = 'danger'; }
        else if (qualified === 0 && total > 0) { code = 'early'; tone = 'neutral'; }
        else if (att > 0) { code = 'attention'; tone = 'warn'; }
        else if (!hasSlope) { code = 'early_ok'; tone = 'neutral'; }
        else { code = 'balanced'; tone = 'ok'; }
      }
      if (!tone) tone = code === 'non_finite' ? 'danger' : (code === 'attention' ? 'warn' : (code === 'balanced' ? 'ok' : 'neutral'));

      let title = '';
      let desc = '';
      if (code === 'non_finite') {
        const nfImages = nf || summary.non_finite_total || 1;
        title = (Number(nfImages) === 1 ? t('ddVerdictNanTitleOne') : t('ddVerdictNanTitle')).replace('{n}', nfImages);
        desc = att > 0
          ? (Number(att) === 1 ? t('ddVerdictNanAndAttentionDescOne') : t('ddVerdictNanAndAttentionDesc')).replace('{n}', att)
          : t('ddVerdictNanDesc');
      } else if (code === 'attention') {
        title = (Number(att) === 1 ? t('ddVerdictAttentionTitleOne') : t('ddVerdictAttentionTitle')).replace('{n}', att);
        desc = t('ddVerdictAttentionDesc');
      } else if (code === 'early') {
        title = t('ddVerdictEarlyTitle');
        desc = t('ddVerdictEarlyDesc')
          .replace('{n}', qualified)
          .replace('{total}', total)
          .replace('{min}', this.datasetDiagMinCount || 3);
      } else if (code === 'early_ok') {
        title = t('ddVerdictEarlyOkTitle');
        desc = t('ddVerdictEarlyOkDesc');
      } else {
        title = t('ddVerdictBalancedTitle');
        desc = learn > 0
          ? (Number(learn) === 1 ? t('ddVerdictBalancedLearningDescOne') : t('ddVerdictBalancedLearningDesc')).replace('{n}', learn)
          : t('ddVerdictBalancedDesc');
      }
      return { code, tone, title, desc };
    },

    _ddFormatSamplingConfig(cfg) {
      if (!cfg || typeof cfg !== 'object') return '';
      const parts = [];
      if (cfg.timestep_sampling) parts.push(String(cfg.timestep_sampling));
      if (Number.isFinite(cfg.discrete_flow_shift)) {
        parts.push('shift ' + Number(cfg.discrete_flow_shift).toFixed(1).replace(/\.0$/, ''));
      }
      if (Number.isFinite(cfg.sigmoid_scale) && Math.abs(Number(cfg.sigmoid_scale) - 1) > 1e-3) {
        parts.push('scale ' + Number(cfg.sigmoid_scale).toFixed(2).replace(/\.?0+$/, ''));
      }
      if (cfg.weighting_scheme && cfg.weighting_scheme !== 'uniform' && cfg.weighting_scheme !== 'none') {
        parts.push(String(cfg.weighting_scheme));
      }
      const minT = Number.isFinite(cfg.min_timestep) ? Math.max(0, Math.min(1000, Math.round(cfg.min_timestep))) : 0;
      const maxT = Number.isFinite(cfg.max_timestep) ? Math.max(0, Math.min(1000, Math.round(cfg.max_timestep))) : 1000;
      if (minT < maxT && (minT > 0 || maxT < 1000)) {
        parts.push(`t = ${minT}–${maxT}`);
      }
      return parts.join(' · ');
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
        const errText = this.datasetDiagError === 'loadFailed' ? t('ddLoadFailed') : this.datasetDiagError;
        return '<div class="m-section m-dd-section"><div class="dashboard-empty dashboard-empty-danger"><p>' + this.esc(errText) + '</p>'
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
        const headCard = (data?.available_runs?.length > 1 || this.datasetDiagError)
          ? this._renderDatasetDiagHeading(t, data || {})
          : '';
        let html = '<div class="m-section m-dd-section">' + headCard
          + '<div class="dashboard-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><circle cx="9" cy="14" r="1.5"/><circle cx="14" cy="9" r="1.5"/><circle cx="18" cy="12" r="1.5"/></svg>'
          + '<p>' + this.esc(t(reasonKey)) + '</p>';
        if (reason === 'waiting') {
          html += '<button type="button" class="btn btn-sm btn-secondary" @click="refreshDatasetDiagnostics()">' + this.esc(t('refresh')) + '</button>';
        }
        return html + '</div></div>';
      }

      return this._datasetDiagShellHtml(t, data);
    },

    _ddActiveSubTab() {
      return this.datasetDiagSubTab === 'images' ? 'images' : 'overview';
    },

    _datasetDiagShellHtml(t, data = null) {
      const view = this._ddActiveSubTab(data);
      const showImages = view === 'images';
      return '<div class="m-section m-dd-section" data-dd-shell="1">'
        + '<div data-dd-slot="heading">' + (data ? this._renderDatasetDiagHeading(t, data) : '') + '</div>'
        + '<div data-dd-slot="analysis"' + (!showImages ? '' : ' hidden') + '>' + (data && !showImages ? this._renderDatasetDiagAnalysisCard(t, data) : '') + '</div>'
        + '<div data-dd-slot="images"' + (showImages ? '' : ' hidden') + '>' + (data && showImages ? this._renderDatasetDiagImagesCard(t, data) : '') + '</div>'
        + '</div>';
    },

    _renderDatasetDiagAnalysisCard(t, data) {
      return this._renderDatasetDiagDashboard(t, data);
    },

    _ddFormatAvgPerImage(samplesTotal, imageCount) {
      if (!(imageCount > 0)) return '';
      const avg = Number(samplesTotal || 0) / imageCount;
      if (!Number.isFinite(avg)) return '';
      if (Math.abs(avg - Math.round(avg)) < 0.05) return String(Math.round(avg));
      return avg.toFixed(1);
    },

    _ddScopeSummaryInfo(t, data) {
      const summary = data?.summary || {};
      const total = Number(summary.images_total ?? (data?.by_image || []).length) || 0;
      const expected = Number(summary.images_expected || 0);
      const qualified = summary.images_qualified != null ? Number(summary.images_qualified) : total;
      const skipped = summary.images_skipped != null
        ? Number(summary.images_skipped)
        : Math.max(0, total - qualified);
      const minCount = Number(data?.thresholds?.min_count || this.datasetDiagMinCount || 3);
      const samplesTotal = (Number(summary.samples) || 0) + (Number(summary.non_finite_total) || 0);
      const nfTotal = Number(summary.non_finite_total || 0);
      const hasEpochs = summary.epoch_from != null && summary.epoch_to != null;
      const hasSteps = summary.step_from != null && summary.step_to != null;
      const epLabel = t('ddEpochLabel');
      const stepLabel = t('ddStepLabel');
      const epRange = hasEpochs
        ? (summary.epoch_from === summary.epoch_to ? String(summary.epoch_to) : `${summary.epoch_from}–${summary.epoch_to}`)
        : '';
      const stepRange = hasSteps
        ? (summary.step_from === summary.step_to ? String(summary.step_to) : `${summary.step_from}–${summary.step_to}`)
        : '';
      const hasLoss = summary.mean_loss != null && Number.isFinite(Number(summary.mean_loss));
      const lossStr = hasLoss ? this._ddFormatLoss(summary.mean_loss) : '';
      const avgStr = this._ddFormatAvgPerImage(samplesTotal, total);

      const pillCells = [];
      if (hasEpochs) pillCells.push({ key: 'epochs', label: epLabel, val: epRange, danger: false });
      else if (hasSteps) pillCells.push({ key: 'steps', label: stepLabel, val: stepRange, danger: false });
      if (avgStr) pillCells.push({ key: 'avg', label: t('ddScopeAvgKey'), val: t('ddScopeAvgVal').replace('{n}', avgStr), danger: false });
      if (hasLoss) pillCells.push({ key: 'mean_loss', label: t('ddScopeLossKey'), val: lossStr, danger: false });
      if (nfTotal > 0) pillCells.push({ key: 'nan', label: t('ddScopeNanKey'), val: t('ddStatusNanVal').replace('{n}', nfTotal), danger: true });

      const rows = [];
      if (hasEpochs) {
        rows.push({
          key: 'range',
          label: t('ddScopeRowRange'),
          main: `${epLabel} ${epRange}`,
          sub: hasSteps ? `${stepLabel} ${stepRange}` : '',
        });
      } else if (hasSteps) {
        rows.push({
          key: 'range',
          label: t('ddScopeRowRange'),
          main: `${stepLabel} ${stepRange}`,
          sub: '',
        });
      }

      const imgMain = (expected > 0 && expected >= total)
        ? t('ddScopeImagesFrac').replace('{n}', total).replace('{total}', expected)
        : (Number(total) === 1 ? t('ddMetaImagesOne') : t('ddMetaImages')).replace('{n}', total);
      let imgSub = '';
      if (total > 0) {
        if (qualified === 0 && minCount > 0) {
          imgSub = t('ddScopeImagesNoneQualified').replace('{min}', minCount);
        } else if (skipped > 0) {
          imgSub = t('ddScopeImagesSkipped').replace('{n}', skipped).replace('{min}', minCount);
        } else {
          imgSub = t('ddScopeImagesAllQualified').replace('{min}', minCount);
        }
      }
      rows.push({
        key: 'images',
        label: t('ddScopeRowImages'),
        main: imgMain,
        sub: imgSub,
      });

      rows.push({
        key: 'samples',
        label: t('ddScopeRowLossCount'),
        main: t('ddScopeLossRecords').replace('{n}', samplesTotal),
        sub: avgStr ? t('ddScopeAvgDetail').replace('{n}', avgStr) : '',
      });

      if (hasLoss) {
        rows.push({
          key: 'mean_loss',
          label: t('ddScopeRowMeanLoss'),
          main: lossStr,
          okSub: nfTotal === 0 ? t('ddScopeNoNan') : '',
          dangerSub: nfTotal > 0 ? t('ddScopeWithNan').replace('{n}', nfTotal) : '',
        });
      } else if (nfTotal > 0) {
        rows.push({
          key: 'mean_loss',
          label: t('ddScopeRowMeanLoss'),
          main: t('ddStatusNonFinite'),
          dangerMain: true,
          dangerSub: t('ddScopeWithNan').replace('{n}', nfTotal),
        });
      }

      return { pillCells, rows };
    },

    _ddScopePillInnerHtml(t, info) {
      return (info?.pillCells || []).map(c =>
        '<span class="m-dd-scope-cell' + (c.danger ? ' is-danger' : '') + '">'
        + '<small class="m-dd-scope-k">' + this.esc(c.label) + '</small>'
        + '<b class="m-dd-scope-v">' + this.esc(c.val) + '</b>'
        + '</span>'
      ).join('<i class="m-dd-scope-sep" aria-hidden="true"></i>');
    },

    _ddScopePopoverInnerHtml(t, info) {
      const title = t('ddScopePopTitle');
      const rowsHtml = (info?.rows || []).map(r => {
        let subHtml = '';
        if (r.dangerSub) subHtml = '<span class="m-dd-scope-sub is-danger">' + this.esc(r.dangerSub) + '</span>';
        else if (r.okSub) subHtml = '<span class="m-dd-scope-sub"><i class="m-dd-scope-ok-dot" aria-hidden="true"></i><span>' + this.esc(r.okSub) + '</span></span>';
        else if (r.sub) subHtml = '<span class="m-dd-scope-sub">' + this.esc(r.sub) + '</span>';
        return '<div class="m-dd-scope-row">'
          + '<span class="m-dd-scope-row-k">' + this.esc(r.label) + '</span>'
          + '<span class="m-dd-scope-row-val">'
          + '<strong class="m-dd-scope-main' + (r.dangerMain ? ' is-danger' : '') + '">' + this.esc(r.main) + '</strong>'
          + subHtml
          + '</span></div>';
      }).join('');
      return '<div class="m-dd-scope-pop-head">' + this.esc(title) + '</div>' + rowsHtml;
    },

    _ddHeadScopeHtml(t, data) {
      const info = this._ddScopeSummaryInfo(t, data);
      const title = t('ddScopePopTitle');
      return '<div class="m-dd-head-meta" data-dd-head-scope>'
        + '<button type="button" class="m-dd-scope-pill" data-dd-scope-pill aria-expanded="false" aria-label="' + this.esc(title) + '">'
        + this._ddScopePillInnerHtml(t, info)
        + '</button>'
        + '<div class="m-dd-scope-pop" data-dd-scope-pop role="region" aria-label="' + this.esc(title) + '">'
        + this._ddScopePopoverInnerHtml(t, info)
        + '</div>'
        + '</div>';
    },

    _ddVerdictActionsHtml(t, data) {
      const summary = data.summary || {};
      const counts = summary.counts || {};
      const total = summary.images_total || (data.by_image || []).length;
      const actions = [];
      if ((counts.non_finite || 0) > 0) {
        actions.push('<button type="button" class="btn btn-sm btn-secondary m-dd-jump-btn is-danger" @click="openDatasetDiagPreset(\'non_finite\')">'
          + '<i class="m-dd-btn-dot" aria-hidden="true"></i>'
          + '<span>' + this.esc(t('ddJumpNan').replace('{n}', counts.non_finite)) + '</span></button>');
      }
      if ((counts.attention || 0) > 0) {
        actions.push('<button type="button" class="btn btn-sm btn-secondary m-dd-jump-btn is-warn" @click="openDatasetDiagPreset(\'attention\')">'
          + '<i class="m-dd-btn-dot" aria-hidden="true"></i>'
          + '<span>' + this.esc(t('ddJumpAttention').replace('{n}', counts.attention)) + '</span></button>');
      }
      const ng = data.notable_group;
      if (ng && ng.key) {
        const ngDimLabel = this._ddNotableDimLabel(t, ng.dimension);
        const ngLabel = ng.dimension === 'resolution' ? this._ddFormatResolution(ng.label || ng.key) : (ng.label || ng.key);
        const ngRes = this._ddFormatResidual(ng.mean_residual);
        const gf = this.datasetDiagGroupFilter;
        const ngActive = !!(gf && gf.dim === ng.dimension && gf.key === ng.key);
        const dimJs = this.esc(this.escapeJsString(ng.dimension));
        const keyJs = this.esc(this.escapeJsString(ng.key));
        const lblJs = this.esc(this.escapeJsString(ngLabel));
        actions.push('<button type="button" class="btn btn-sm btn-secondary m-dd-notable-btn' + (ngActive ? ' is-active' : '') + '"'
          + ' aria-pressed="' + ngActive + '" @click="selectDatasetDiagNotableGroup(\'' + dimJs + '\', \'' + keyJs + '\', \'' + lblJs + '\')">'
          + '<i class="m-dd-btn-dot" aria-hidden="true"></i>'
          + '<span>' + this.esc(t('ddNotableGroupChip').replace('{dim}', ngDimLabel).replace('{label}', ngLabel).replace('{res}', ngRes)) + '</span></button>');
      }
      if (!actions.length && total > 0) {
        actions.push('<button type="button" class="btn btn-sm btn-secondary m-dd-jump-btn" @click="openDatasetDiagPreset(\'all\')">'
          + '<span>' + this.esc(t('ddJumpAllImages').replace('{n}', total)) + '</span></button>');
      }
      return actions.join('');
    },

    _ddRowJumpIconHtml() {
      return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M5 11L11 5"/><path d="M6.5 5H11v4.5"/>'
        + '</svg>';
    },

    _ddLiveStatusState(t) {
      const visible = !!(typeof this._datasetDiagTrainingActive === 'function'
        && !this.selectedRunDir && this._datasetDiagTrainingActive());
      const paused = !!(visible && this.liveTaskId && this.controlTask === this.liveTaskId && this.controlState?.state === 'paused');
      const phase = paused ? 'paused' : 'running';
      const label = paused ? t('ddLivePaused') : t('ddLiveTracking');
      return { visible, paused, phase, label };
    },

    _ddScatterFilterHintText(t, data) {
      const summary = data.summary || {};
      const total = summary.images_total || (data.by_image || []).length;
      const filteredLen = this._datasetDiagFilteredImages ? this._datasetDiagFilteredImages().length : total;
      return t('ddScatterFilteredHint').replace('{n}', filteredLen).replace('{total}', total);
    },

    _ddScatterFilterPillHtml(t, data) {
      if (!this._datasetDiagHasActiveFilter?.()) return '';
      return '<div class="m-dd-scatter-filter-pill"><span data-dd-filter-hint>'
        + this.esc(this._ddScatterFilterHintText(t, data))
        + '</span><button type="button" class="m-dd-pill-jump-btn" data-dd-filter-jump @click="openDatasetDiagFilteredImages()">'
        + this.esc(t('ddInspectImages'))
        + '</button><button type="button" class="m-dd-clear-filter-btn" data-dd-filter-reset @click="resetDatasetDiagFilters()">'
        + this.esc(t('ddResetFilter')) + '</button></div>';
    },

    _ddScatterToolbarHtml(t, data) {
      const counts = data?.summary?.counts || {};
      const hasNan = (counts.non_finite || 0) > 0;
      const hasZoom = !!this.datasetDiagScatterZoom;
      const showZones = !!this.datasetDiagShowZones;
      const zoneLabel = t('ddZoneShadingToggle');
      const zoneHint = t('ddZoneShadingHint');
      return '<span data-dd-scatter-filter-slot>' + this._ddScatterFilterPillHtml(t, data) + '</span>'
        + '<button type="button" class="m-dd-zoom-reset-btn" data-dd-zoom-reset @click.stop="resetDatasetDiagScatterZoom()"'
        + (hasZoom ? '' : ' hidden') + '>' + this.esc(t('ddZoomReset')) + '</button>'
        + '<span class="m-dd-chart-cov" data-dd-chart-coverage></span>'
        + '<span class="m-dd-leg" data-dd-scatter-nan-leg' + (hasNan ? '' : ' hidden') + '>'
        + '<i class="is-nan-ring"></i><span>' + this.esc(t('ddStatusNonFinite')) + '</span></span>'
        + '<div class="m-sample-view-toggle m-dd-zone-toggle" data-dd-zone-toggle title="' + this.esc(zoneHint) + '">'
        + '<label for="ddZoneShadingToggle" id="ddZoneShadingLabel">' + this.esc(zoneLabel) + '</label>'
        + '<label class="toggle">'
        + '<input type="checkbox" role="switch" id="ddZoneShadingToggle"'
        + (showZones ? ' checked' : '')
        + ' :checked="datasetDiagShowZones"'
        + ' aria-labelledby="ddZoneShadingLabel"'
        + ' @change="setDatasetDiagShowZones($event.target.checked)">'
        + '<span class="toggle-track"><span class="toggle-thumb"></span></span>'
        + '</label></div>';
    },

    _ddSyncDashActionsVisibility(actionsEl) {
      if (!actionsEl) return;
      const left = actionsEl.querySelector?.('[data-dd-dash-actions-left]');
      const cov = actionsEl.querySelector?.('[data-dd-chart-coverage]');
      const filterSlot = actionsEl.querySelector?.('[data-dd-scatter-filter-slot]');
      const nanLeg = actionsEl.querySelector?.('[data-dd-scatter-nan-leg]');
      const resetBtn = actionsEl.querySelector?.('[data-dd-zoom-reset]');
      const zoneToggle = actionsEl.querySelector?.('[data-dd-zone-toggle]');
      const hasContent = el => Boolean(el && ((el.childElementCount || 0) > 0 || (el.innerHTML && el.innerHTML.trim())));
      const hasLeft = hasContent(left);
      const hasRight = Boolean(
        (cov && cov.textContent && cov.textContent.trim())
        || hasContent(filterSlot)
        || (nanLeg && !nanLeg.hidden)
        || (resetBtn && !resetBtn.hidden)
        || (zoneToggle && !zoneToggle.hidden)
      );
      actionsEl.hidden = !(hasLeft || hasRight);
    },

    _ddStatusRowsMeta(t) {
      return [
        { key: 'non_finite', label: t('ddStatusNonFinite') },
        { key: 'attention', label: t('ddPresetAttention') },
        { key: 'learning', label: t('ddStatusLearning') },
        { key: 'normal', label: t('ddStatusNormal') },
        { key: 'easy', label: t('ddStatusLow') },
        { key: 'unqualified', label: t('ddPresetUnqualified') },
      ];
    },

    _ddStatusCardKey(status) {
      if (status === 'insufficient' || status === 'insufficient_reference') return 'unqualified';
      if (['non_finite', 'attention', 'learning', 'normal', 'easy', 'unqualified'].includes(status)) return status;
      return null;
    },

    _ddFormatCompactResidual(value) {
      if (value == null || value === '' || !Number.isFinite(Number(value))) return '';
      const pct = Number(value) * 100;
      if (Math.abs(pct) < 0.05) return '0%';
      const abs = Math.abs(pct);
      const numStr = abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1);
      return (pct > 0 ? '+' : '-') + numStr + '%';
    },

    _ddStatusBucketFallback(counts, total, key) {
      const count = Number(counts?.[key] || 0);
      const imgPct = total > 0 ? Math.round((count / total) * 100) : 0;
      return {
        count,
        imgPct,
        samples: 0,
        trainPct: imgPct,
        regCount: 0,
        nanCount: 0,
        meanResidual: null,
        meanSlope: null,
      };
    },

    _ddStatusCardMetricInnerHtml(t, key, bucket) {
      if (key === 'non_finite' && Number(bucket?.nanCount || 0) > 0) {
        return '<small class="m-dd-status-k">' + this.esc(t('ddStatusNanKey')) + '</small>'
          + '<b class="m-dd-status-v is-tone-non_finite">' + this.esc(t('ddStatusNanVal').replace('{n}', bucket.nanCount)) + '</b>';
      }
      const resStr = this._ddFormatCompactResidual(bucket?.meanResidual);
      if (!resStr) return '';
      return '<small class="m-dd-status-k">' + this.esc(t('ddCardResidual')) + '</small>'
        + '<b class="m-dd-status-v is-tone-' + key + '">' + this.esc(resStr) + '</b>';
    },

    _ddStatusCardTrendHtml(t, key, bucket) {
      if (key === 'non_finite' || key === 'unqualified') return '';
      return this._ddTrendPillHtml(t, bucket?.meanSlope);
    },

    _ddStatusCardMicroInnerHtml(t, key, bucket, showTrainShare) {
      if (!showTrainShare) return '';
      const trainPct = Number(bucket?.trainPct ?? 0);
      const imgPct = Number(bucket?.imgPct ?? 0);
      const regCount = Number(bucket?.regCount || 0);
      const isWarn = (key === 'attention' || key === 'non_finite') && (trainPct - imgPct) >= 10;
      let html = this.esc(t('ddStatusTrainShare'))
        + ' <span class="m-dd-micro-v' + (isWarn ? ' is-warn' : '') + '">' + trainPct + '%</span>';
      if (regCount > 0) {
        html += ' · ' + this.esc(t('ddStatusRegInline').replace('{n}', regCount));
      }
      return html;
    },

    _ddStatusCardTooltip(t, item, bucket, showTrainShare) {
      const count = Number(bucket?.count || 0);
      const imgPct = Number(bucket?.imgPct ?? 0);
      const headTmpl = count === 1 ? t('ddStatusTipHeadOne') : t('ddStatusTipHead');
      const parts = [
        headTmpl.replace('{label}', item.label).replace('{n}', count).replace('{pct}', imgPct),
      ];
      if (item.key === 'non_finite' && Number(bucket?.nanCount || 0) > 0) {
        const nanCnt = Number(bucket.nanCount);
        parts.push((nanCnt === 1 ? t('ddStatusTipNanOne') : t('ddStatusTipNan')).replace('{n}', nanCnt));
      } else if (bucket?.meanResidual != null && Number.isFinite(Number(bucket.meanResidual))) {
        parts.push(t('ddStatusTipResidual').replace('{res}', this._ddFormatResidual(bucket.meanResidual)));
      }
      const meanSlope = bucket?.meanSlope != null && Number.isFinite(Number(bucket.meanSlope))
        ? Number(bucket.meanSlope)
        : null;
      const convSlope = this._ddConvergingSlopeThreshold();
      const riseSlope = Math.max(0.002, Math.abs(convSlope) * 0.4);
      if (meanSlope != null && item.key !== 'non_finite' && item.key !== 'unqualified'
          && (item.key === 'learning' || item.key === 'attention' || meanSlope <= convSlope || meanSlope >= riseSlope)) {
        parts.push(t('ddStatusTipSlope').replace('{slope}', this._ddFormatSlope(meanSlope) + t('ddSlopeUnit')));
      }
      if (showTrainShare) {
        parts.push(t('ddStatusTipTrainShare').replace('{pct}', Number(bucket?.trainPct ?? imgPct)));
      }
      if (Number(bucket?.regCount || 0) > 0) {
        parts.push(t('ddStatusTipReg').replace('{n}', bucket.regCount));
      }
      return parts.filter(Boolean).join(' · ');
    },

    _ddStatusSegTitle(t, label, cnt) {
      const locale = String(this.locale || '');
      const sep = locale.startsWith('zh') || locale.startsWith('ja') ? '：' : ': ';
      const cntStr = (Number(cnt) === 1 ? t('ddMetaImagesOne') : t('ddMetaImages')).replace('{n}', cnt);
      return `${label}${sep}${cntStr}`;
    },

    _ddStatusRowHtml(t, item, bucket, activePreset, showTrainShare = false) {
      const isSelected = activePreset === item.key;
      const isSiblingDim = activePreset !== 'all' && !isSelected;
      const cnt = Number(bucket?.count || 0);
      const pct = Number(bucket?.imgPct ?? 0);
      const trendHtml = this._ddStatusCardTrendHtml(t, item.key, bucket);
      const metricInner = this._ddStatusCardMetricInnerHtml(t, item.key, bucket);
      const microInner = this._ddStatusCardMicroInnerHtml(t, item.key, bucket, showTrainShare);
      const tipText = this._ddStatusCardTooltip(t, item, bucket, showTrainShare);
      return '<div class="m-dd-status-row is-' + item.key + (isSelected ? ' is-selected' : '') + (isSiblingDim ? ' is-sibling-dim' : '') + '"'
        + ' data-dd-status-key="' + item.key + '"' + (!cnt && !isSelected ? ' hidden' : '')
        + ' title="' + this.esc(tipText) + '"'
        + ' role="button" tabindex="0" aria-pressed="' + isSelected + '"'
        + ' @mouseenter="previewDatasetDiagStatus(\'' + item.key + '\')"'
        + ' @mouseleave="scheduleDatasetDiagPreviewClear()"'
        + ' @click="toggleDatasetDiagOverviewPreset(\'' + item.key + '\')"'
        + ' @keydown.enter.prevent="toggleDatasetDiagOverviewPreset(\'' + item.key + '\')"'
        + ' @keydown.space.prevent="toggleDatasetDiagOverviewPreset(\'' + item.key + '\')">'
        + '<span class="m-dd-status-name"><i class="m-dd-status-dot is-' + item.key + '" aria-hidden="true"></i><span>' + this.esc(item.label) + '</span></span>'
        + '<span class="m-dd-status-trend" data-dd-status-trend' + (trendHtml ? '' : ' hidden') + '>' + trendHtml + '</span>'
        + '<div class="m-dd-status-nums">'
        + '<div class="m-dd-status-main">'
        + '<strong class="m-dd-status-count" data-dd-status-count>' + this.esc(cnt) + '</strong>'
        + '<span class="m-dd-status-unit">' + this.esc(t('ddStatusUnitImg')) + '</span>'
        + '<span class="m-dd-status-sep" aria-hidden="true">·</span>'
        + '<span class="m-dd-status-pct" data-dd-status-pct>' + pct + '%</span>'
        + '</div>'
        + '<span class="m-dd-status-kv" data-dd-status-kv' + (metricInner ? '' : ' hidden') + '>' + metricInner + '</span>'
        + '</div>'
        + '<div class="m-dd-status-micro" data-dd-status-micro' + (microInner ? '' : ' hidden') + '>' + microInner + '</div>'
        + '</div>';
    },

    _renderDatasetDiagStatusCard(t, data) {
      const breakdown = typeof this._ddStatusBreakdown === 'function'
        ? this._ddStatusBreakdown(data)
        : { total: 0, counts: {}, buckets: null, showTrainShare: false };
      const { total, counts, buckets, showTrainShare } = breakdown;
      const bucketOf = key => (buckets && buckets[key]) || this._ddStatusBucketFallback(counts, total, key);
      const activePreset = this.datasetDiagPreset || 'all';
      const meta = this._ddStatusRowsMeta(t);
      const expected = Number(data?.summary?.images_expected || 0);
      const totalText = expected > total
        ? t('ddMetaImagesCoverage').replace('{n}', total).replace('{total}', expected)
        : (Number(total) === 1 ? t('ddMetaImagesOne') : t('ddMetaImages')).replace('{n}', total);
      let html = '<div class="m-dd-side-head">'
        + '<span class="m-dd-side-title">' + this.esc(t('ddStatusSummaryTitle')) + '</span>'
        + '<span class="m-dd-status-total" data-dd-status-total>' + this.esc(totalText) + '</span>'
        + '</div>';
      html += '<div class="m-dd-status-bar" role="group" aria-label="' + this.esc(t('ddStatusSummaryTitle')) + '">';
      meta.forEach(item => {
        const cnt = Number(counts[item.key] || 0);
        const w = total > 0 && cnt > 0 ? (cnt / total) * 100 : 0;
        const isEmpty = cnt <= 0;
        const isDimmed = activePreset !== 'all' && activePreset !== item.key;
        html += '<span class="m-dd-status-seg is-' + item.key + (isEmpty ? ' is-empty' : '') + (isDimmed ? ' is-dimmed' : '') + '"'
          + ' data-dd-status-seg="' + item.key + '"'
          + ' style="width:' + w.toFixed(2) + '%" title="' + this.esc(this._ddStatusSegTitle(t, item.label, cnt)) + '"'
          + ' @mouseenter="previewDatasetDiagStatus(\'' + item.key + '\')"'
          + ' @mouseleave="scheduleDatasetDiagPreviewClear()"'
          + ' @click="toggleDatasetDiagOverviewPreset(\'' + item.key + '\')"></span>';
      });
      html += '</div>';
      html += '<div class="m-dd-status-list' + (activePreset !== 'all' ? ' has-selection' : '') + '" data-dd-status-list>';
      meta.forEach(item => {
        html += this._ddStatusRowHtml(t, item, bucketOf(item.key), activePreset, !!showTrainShare);
      });
      html += '</div>';
      return html;
    },

    _patchDatasetDiagStatusCard(host, t, data, animate) {
      if (!host) return;
      const breakdown = typeof this._ddStatusBreakdown === 'function'
        ? this._ddStatusBreakdown(data)
        : { total: 0, counts: {}, buckets: null, showTrainShare: false };
      const { total, counts, buckets, showTrainShare } = breakdown;
      const bucketOf = key => (buckets && buckets[key]) || this._ddStatusBucketFallback(counts, total, key);
      const activePreset = this.datasetDiagPreset || 'all';
      const meta = this._ddStatusRowsMeta(t);
      const totalEl = host.querySelector('[data-dd-status-total]');
      const expected = Number(data?.summary?.images_expected || 0);
      const totalText = expected > total
        ? t('ddMetaImagesCoverage').replace('{n}', total).replace('{total}', expected)
        : (Number(total) === 1 ? t('ddMetaImagesOne') : t('ddMetaImages')).replace('{n}', total);
      if (totalEl) this._patchDiagStatNumber(totalEl, totalText, animate);
      meta.forEach(item => {
        const seg = host.querySelector(`[data-dd-status-seg="${item.key}"]`);
        if (!seg) return;
        const cnt = Number(counts[item.key] || 0);
        const w = total > 0 && cnt > 0 ? (cnt / total) * 100 : 0;
        seg.style.width = w.toFixed(2) + '%';
        seg.title = this._ddStatusSegTitle(t, item.label, cnt);
        seg.classList.toggle('is-empty', cnt <= 0);
      });
      const listEl = host.querySelector('[data-dd-status-list]');
      if (!listEl) return;
      listEl.classList.toggle('has-selection', activePreset !== 'all');
      meta.forEach(item => {
        const row = listEl.querySelector(`[data-dd-status-key="${item.key}"]`);
        if (!row) return;
        const bucket = bucketOf(item.key);
        const cnt = Number(bucket.count || 0);
        const pct = Number(bucket.imgPct ?? 0);
        const isSelected = activePreset === item.key;
        row.hidden = !cnt && !isSelected;
        if (row.hidden) return;
        row.classList.toggle('is-selected', isSelected);
        row.classList.toggle('is-sibling-dim', activePreset !== 'all' && !isSelected);
        row.setAttribute('aria-pressed', String(isSelected));
        const tipText = this._ddStatusCardTooltip(t, item, bucket, !!showTrainShare);
        if (row.title !== tipText) row.title = tipText;
        const cntEl = row.querySelector('[data-dd-status-count]');
        const cntText = String(cnt);
        if (cntEl && cntEl.textContent !== cntText) cntEl.textContent = cntText;
        const pctEl = row.querySelector('[data-dd-status-pct]');
        const pctText = `${pct}%`;
        if (pctEl && pctEl.textContent !== pctText) pctEl.textContent = pctText;
        const trendEl = row.querySelector('[data-dd-status-trend]');
        if (trendEl) {
          const trendHtml = this._ddStatusCardTrendHtml(t, item.key, bucket);
          trendEl.hidden = !trendHtml;
          this._ddPatchHtml(trendEl, trendHtml);
        }
        const kvEl = row.querySelector('[data-dd-status-kv]');
        if (kvEl) {
          const metricInner = this._ddStatusCardMetricInnerHtml(t, item.key, bucket);
          kvEl.hidden = !metricInner;
          this._ddPatchHtml(kvEl, metricInner);
        }
        const microEl = row.querySelector('[data-dd-status-micro]');
        if (microEl) {
          const microInner = this._ddStatusCardMicroInnerHtml(t, item.key, bucket, !!showTrainShare);
          microEl.hidden = !microInner;
          this._ddPatchHtml(microEl, microInner);
        }
      });
      this._syncDatasetDiagStatusHighlight?.(host.closest?.('.m-tab-panel[data-tab="dataset"]') || host);
    },

    _syncDatasetDiagStatusHighlight(container) {
      const panel = container || globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      if (!panel) return;
      const activePreset = this._ddStatusCardKey(this.datasetDiagPreset || 'all');
      const preview = this._datasetDiagHoverPreview;
      const previewStatus = preview?.kind === 'preset' ? this._ddStatusCardKey(preview.preset) : null;
      const scatterWrap = panel.querySelector?.('[data-dd-hero-wrap][data-mode="quadrant"]');
      const activeDot = scatterWrap?._ddActiveDot || null;
      const linkedStatus = activeDot
        ? this._ddStatusCardKey(activeDot.status)
        : (scatterWrap?._ddHoverZone ? this._ddStatusCardKey(scatterWrap._ddHoverZone) : null);
      const barFocus = previewStatus || linkedStatus || activePreset;

      panel.querySelectorAll?.('[data-dd-status-seg]')?.forEach?.(seg => {
        seg.classList?.toggle('is-dimmed', !!barFocus && seg.dataset?.ddStatusSeg !== barFocus);
      });

      const listEl = panel.querySelector?.('[data-dd-status-list]');
      listEl?.classList?.toggle('has-selection', !!activePreset);
      panel.querySelectorAll?.('[data-dd-status-key]')?.forEach?.(row => {
        const key = row.dataset?.ddStatusKey;
        const isLinked = !!linkedStatus && key === linkedStatus;
        const isPreview = !!previewStatus && key === previewStatus;
        const isSelected = !!activePreset && key === activePreset;
        row.classList?.toggle('is-linked', isLinked);
        row.classList?.toggle('is-preview', isPreview);
        row.classList?.toggle('is-sibling-dim', !!activePreset && !isSelected && !isLinked && !isPreview);
      });

      scatterWrap?.querySelectorAll?.('[data-dd-zone-preset]')?.forEach?.(zone => {
        const zp = zone.dataset?.ddZonePreset;
        zone.classList?.toggle('is-hover', !!zp && (previewStatus === zp || linkedStatus === zp));
      });

      const gf = this.datasetDiagGroupFilter;
      const selGroupKey = (gf && gf.dim && gf.key != null) ? `${gf.dim}::${gf.key}` : null;
      const previewGroupKey = preview?.kind === 'group' ? `${preview.dim}::${preview.key}` : null;
      const linkedResos = activeDot ? new Set(activeDot.resolutions || (activeDot.resolution ? [activeDot.resolution] : [])) : null;
      const linkedSubs = activeDot ? new Set(activeDot.subsets || (activeDot.subset ? [activeDot.subset] : [])) : null;
      const linkedDir = activeDot ? (activeDot.directory || '(root)') : null;
      panel.querySelectorAll?.('.m-dd-flat-group-row.is-clickable')?.forEach?.(row => {
        const rk = row.dataset?.ddGroupRowKey || '';
        const sepIdx = rk.indexOf('::');
        const dim = sepIdx >= 0 ? rk.slice(0, sepIdx) : '';
        const key = sepIdx >= 0 ? rk.slice(sepIdx + 2) : '';
        let isLinked = false;
        if (activeDot && dim) {
          if (dim === 'resolution') isLinked = linkedResos.has(key);
          else if (dim === 'subset') isLinked = linkedSubs.has(key);
          else if (dim === 'directory') isLinked = linkedDir === key;
        }
        row.classList?.toggle('is-linked', isLinked);
        const sameDimOther = Boolean(selGroupKey && gf?.dim === dim && rk !== selGroupKey && rk !== previewGroupKey && !isLinked);
        row.classList?.toggle('is-sibling-dim', sameDimOther);
      });
    },

    _patchDiagStatNumber(el, text, animate) {
      if (!el) return;
      const next = String(text ?? '');
      if (animate && typeof this._patchMonitorNumber === 'function') {
        this._patchMonitorNumber(el, next, true);
      } else {
        if (el.dataset) el.dataset.metricValue = next;
        if (el.textContent !== next) el.textContent = next;
      }
    },

    _ddPatchHtml(host, html) {
      if (!host || host._ddLastHtml === html) return;
      host._ddLastHtml = html;
      host.innerHTML = html;
    },

    _renderDatasetDiagDashboard(t, data) {
      const verdict = this._ddVerdictInfo(t, data);
      const scopeHtml = this._ddHeadScopeHtml(t, data);
      const actionsHtml = this._ddVerdictActionsHtml(t, data);
      const toolbarHtml = this._ddScatterToolbarHtml(t, data);
      const groupsHtml = this._renderDatasetDiagGroupsCard(t, data);
      const statusHtml = this._renderDatasetDiagStatusCard(t, data);

      let html = '<div class="m-dd-dash-grid" data-dd-analysis>';

      html += '<section class="m-console-card m-dd-dash-main">';
      html += '<div class="m-dd-dash-verdict" data-dd-tone="' + this.esc(verdict.tone) + '">';
      html += '<div class="m-dd-dash-verdict-head">'
        + '<div class="m-dd-verdict-title-row"><span class="m-dd-verdict-dot" aria-hidden="true"></span><strong data-dd-verdict-title>' + this.esc(verdict.title) + '</strong></div>'
        + scopeHtml + '</div>';
      html += '<p class="m-dd-verdict-desc" data-dd-verdict-desc>' + this.esc(verdict.desc) + '</p>';
      html += '<div class="m-dd-dash-actions" data-dd-dash-actions>'
        + '<div class="m-dd-dash-actions-left" data-dd-dash-actions-left>' + actionsHtml + '</div>'
        + '<div class="m-dd-dash-actions-right" data-dd-dash-actions-right>' + toolbarHtml + '</div>'
        + '</div>';
      html += '</div>';
      html += '<div class="m-dd-dash-scatter">' + this._renderDatasetDiagHeroSlot(t, data, 'quadrant') + '</div>';
      html += '</section>';

      html += '<div class="m-dd-dash-side-shell"><section class="m-console-card m-dd-dash-side" data-dd-side-scroll>';
      html += '<div class="m-dd-dash-status" data-dd-status-host>' + statusHtml + '</div>';
      html += '<div class="m-dd-dash-noise">' + this._renderDatasetDiagHeroSlot(t, data, 'timestep') + '</div>';
      html += '<div class="m-dd-dash-groups" data-dd-groups-host>'
        + (groupsHtml || ('<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('ddNoGroupData')) + '</p></div>'))
        + '</div>';
      html += '</section></div>';

      html += '</div>';
      return html;
    },

    _patchDatasetDiagDashboard(slot, t, data, animate = true) {
      if (!slot || !data || !data.available) return;
      const earlyNote = slot.querySelector('[data-dd-early-slope-note]');
      if (earlyNote) earlyNote.hidden = !!data.summary?.has_slope;
      const verdictEl = slot.querySelector('.m-dd-dash-verdict');
      if (verdictEl) {
        const verdict = this._ddVerdictInfo(t, data);
        verdictEl.dataset.ddTone = verdict.tone;
        const titleEl = verdictEl.querySelector('[data-dd-verdict-title]');
        if (titleEl && titleEl.textContent !== verdict.title) titleEl.textContent = verdict.title;
        const descEl = verdictEl.querySelector('[data-dd-verdict-desc]');
        if (descEl && descEl.textContent !== verdict.desc) descEl.textContent = verdict.desc;
        const pillEl = verdictEl.querySelector('[data-dd-scope-pill]');
        const popEl = verdictEl.querySelector('[data-dd-scope-pop]');
        if (pillEl || popEl) {
          const scopeInfo = this._ddScopeSummaryInfo(t, data);
          if (pillEl) this._ddPatchHtml(pillEl, this._ddScopePillInnerHtml(t, scopeInfo));
          if (popEl) this._ddPatchHtml(popEl, this._ddScopePopoverInnerHtml(t, scopeInfo));
        }
        const actionsEl = verdictEl.querySelector('[data-dd-dash-actions]');
        const actionsHost = verdictEl.querySelector('[data-dd-dash-actions-left]') || actionsEl;
        if (actionsHost) this._ddPatchHtml(actionsHost, this._ddVerdictActionsHtml(t, data));
        const nanLeg = verdictEl.querySelector('[data-dd-scatter-nan-leg]');
        if (nanLeg) nanLeg.hidden = !((data.summary?.counts?.non_finite || 0) > 0);
        const filterSlot = verdictEl.querySelector('[data-dd-scatter-filter-slot]');
        if (filterSlot) {
          const existingPill = filterSlot.querySelector?.('.m-dd-scatter-filter-pill');
          const hintEl = existingPill?.querySelector?.('[data-dd-filter-hint]');
          const nextPill = this._ddScatterFilterPillHtml(t, data);
          if (nextPill && existingPill && hintEl) {
            if (filterSlot._ddLastHtml !== nextPill) {
              hintEl.textContent = this._ddScatterFilterHintText(t, data);
              const jumpEl = existingPill.querySelector('[data-dd-filter-jump]');
              if (jumpEl) jumpEl.textContent = t('ddInspectImages');
              const resetEl = existingPill.querySelector('[data-dd-filter-reset]');
              if (resetEl) resetEl.textContent = t('ddResetFilter');
              filterSlot._ddLastHtml = nextPill;
            }
          } else {
            this._ddPatchHtml(filterSlot, nextPill);
          }
        }
        const zoneCb = verdictEl.querySelector('#ddZoneShadingToggle');
        if (zoneCb && zoneCb.checked !== !!this.datasetDiagShowZones) {
          zoneCb.checked = !!this.datasetDiagShowZones;
        }
        this._ddSyncDashActionsVisibility(actionsEl);
      }

      const unknownTs = Number(data.summary?.unknown_timestep_count || 0);
      const unknownNote = slot.querySelector('[data-dd-unknown-ts-note]');
      if (unknownNote) {
        unknownNote.hidden = unknownTs <= 0;
        if (unknownTs > 0) {
          const fullText = (unknownTs === 1 ? t('ddUnknownTimestepOne') : t('ddUnknownTimestep')).replace('{n}', unknownTs);
          const textEl = unknownNote.querySelector('[data-dd-unknown-ts-text]');
          if (textEl && textEl.textContent !== fullText) textEl.textContent = fullText;
        }
      }

      const statusHost = slot.querySelector('[data-dd-status-host]');
      if (statusHost && typeof this._patchDatasetDiagStatusCard === 'function') {
        this._patchDatasetDiagStatusCard(statusHost, t, data, animate);
      }

      const groupsHost = slot.querySelector('[data-dd-groups-host]');
      if (groupsHost) {
        const visibleDims = this._ddVisibleGroupDimensions(t, data);
        const expectedRows = [];
        const dimBounds = {};
        const dimTotals = {};
        visibleDims.forEach(([dim, , rows, canFilter]) => {
          const ordered = this._ddGroupDisplayRows(dim, rows);
          dimTotals[dim] = ordered.reduce((sum, r) => sum + Number(r.count || 0), 0);
          dimBounds[dim] = ordered.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0) * 1.18), 0.12);
          ordered.forEach(row => expectedRows.push({ dim, row, canFilter, totalRows: ordered.length }));
        });
        const arErr = Number(data?.summary?.bucket_ar_error);
        const wantAr = Number.isFinite(arErr) && arErr >= 0.04;
        const existingRows = Array.from(groupsHost.querySelectorAll('[data-dd-group-row-key]'));
        const byKey = new Map(existingRows.map(el => [el.dataset.ddGroupRowKey, el]));
        const orderedRows = expectedRows.map(({ dim, row }) => byKey.get(`${dim}::${row.key}`));
        const sameStructure = expectedRows.length > 0
          && expectedRows.length === existingRows.length
          && orderedRows.every(Boolean);
        if (sameStructure) {
          // Keep the existing fold containers and move ranked rows between their visible and folded slots.
          if (orderedRows.some((row, i) => row !== existingRows[i])) {
            const slots = existingRows.map(row => ({ parent: row.parentNode, next: row.nextElementSibling }));
            for (let i = orderedRows.length - 1; i >= 0; i--) {
              const { parent, next } = slots[i];
              const anchor = next && next === existingRows[i + 1] ? orderedRows[i + 1] : next;
              const el = orderedRows[i];
              if (el.parentNode !== parent || el.nextElementSibling !== anchor) {
                if (parent.moveBefore) parent.moveBefore(el, anchor);
                else parent.insertBefore(el, anchor);
              }
            }
            const filter = this.datasetDiagGroupFilter;
            const selected = filter && byKey.get(`${filter.dim}::${filter.key}`);
            groupsHost.querySelectorAll('[data-dd-group-fold]').forEach(fold => {
              const expanded = !!this.datasetDiagGroupExpanded?.[fold.dataset.ddGroupFold] || !!(selected && fold.contains(selected));
              if (fold.classList.contains('is-open') === expanded) return;
              fold.classList.toggle('is-open', expanded);
              const button = fold.nextElementSibling;
              button.setAttribute('aria-expanded', String(expanded));
              button.textContent = expanded ? t('ddGroupFoldCollapse') : t('ddGroupFoldExpand').replace('{n}', button.dataset.ddFoldCount);
            });
          }
          const groupsSection = groupsHost.querySelector('.m-dd-groups');
          if (groupsSection) groupsSection.classList.toggle('is-live-motion', !!animate);
          const gf = this.datasetDiagGroupFilter;
          visibleDims.forEach(([dim, , rows]) => {
            const dimEl = groupsHost.querySelector(`[data-dd-group-dim="${dim}"]`);
            if (dimEl) {
              const collapsed = !!this.datasetDiagCollapsedDims?.[dim];
              dimEl.classList?.toggle?.('is-collapsed', collapsed);
              const toggleEl = dimEl.querySelector?.('[data-dd-group-dim-toggle]');
              if (toggleEl) toggleEl.setAttribute?.('aria-expanded', String(!collapsed));
              const bodyEl = dimEl.querySelector?.('[data-dd-group-dim-body]');
              if (bodyEl) bodyEl.inert = collapsed;
            }
            const countEl = groupsHost.querySelector(`[data-dd-group-dim="${dim}"] [data-dd-group-dim-count]`);
            const countText = this._ddGroupDimCountText(t, dim, rows.length);
            if (countEl && countEl.textContent !== countText) countEl.textContent = countText;
            if (dim === 'resolution') {
              const arEl = groupsHost.querySelector('[data-dd-group-ar-badge]');
              if (arEl) {
                arEl.hidden = !wantAr;
                const arText = wantAr ? t('ddGroupArError').replace('{pct}', (arErr * 100).toFixed(1)) : '';
                if (arEl.textContent !== arText) arEl.textContent = arText;
              }
            }
          });
          expectedRows.forEach(({ dim, row, canFilter }, idx) => {
            const rowEl = orderedRows[idx];
            const isSelected = !!(gf && gf.dim === dim && gf.key === row.key);
            if (canFilter) {
              rowEl.classList.toggle('is-selected', isSelected);
              rowEl.setAttribute('aria-pressed', String(isSelected));
            }
            const imgCountEl = rowEl.querySelector('[data-dd-group-img-n]');
            const gmInfo = this._ddGroupMetaInfo(t, dim, row, dimTotals[dim]);
            this._ddPatchHtml(imgCountEl, gmInfo.metaHtml);
            if (rowEl.title !== gmInfo.tooltip) rowEl.title = gmInfo.tooltip;
            const resText = this._ddFormatResidual(row.mean_residual);
            const resEl = rowEl.querySelector('[data-dd-flat-res]');
            if (resEl) {
              this._patchDiagStatNumber(resEl, resText, animate);
              resEl.style.color = this._ddResidualColor(row.mean_residual, { scale: 'group' });
            }
            if (canFilter) {
              const alertEl = rowEl.querySelector('[data-dd-group-alert]');
              const nextAlert = this._ddGroupAlertHtml(t, row);
              this._ddPatchHtml(alertEl, nextAlert);
              const trendEl = rowEl.querySelector('[data-dd-group-trend]');
              const nextTrend = this._ddGroupTrendHtml(t, row);
              this._ddPatchHtml(trendEl, nextTrend);
            }
            const gm = this._ddGroupGaugeMetrics(row.mean_residual, dimBounds[dim]);
            const fillEl = rowEl.querySelector('[data-row-fill]');
            if (fillEl) {
              fillEl.classList.toggle('is-neg', gm.isNeg);
              fillEl.classList.toggle('is-pos', !gm.isNeg);
              fillEl.style.transform = `scaleX(${gm.barScale.toFixed(3)})`;
              fillEl.style.backgroundColor = gm.color;
            }
          });
        } else if (expectedRows.length || !groupsHost.querySelector('.dashboard-empty')) {
          const groupsHtml = this._renderDatasetDiagGroupsCard(t, data);
          groupsHost.innerHTML = groupsHtml || ('<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('ddNoGroupData')) + '</p></div>');
        }
      }
      this._syncDatasetDiagStatusHighlight?.(slot);

      const wraps = slot.querySelectorAll('[data-dd-hero-wrap]');
      const chartOpts = {
        animate: !!animate,
        updatedIds: this._datasetDiagUpdatedIds,
        pulseSeq: this._datasetDiagUpdatePulseSeq || 0,
      };
      wraps.forEach(wrap => {
        const stage = wrap.querySelector('[data-dd-hero-stage]');
        const svg = wrap.querySelector('[data-dd-hero-svg]');
        if (stage && svg) this._renderDatasetDiagHeroSvg(wrap, stage, svg, chartOpts);
      });
    },

    _renderDatasetDiagHeading(t, data) {
      const summary = data.summary || {};
      const availableRuns = Array.isArray(data.available_runs) ? data.available_runs : [];
      const activeRunId = this.datasetDiagRunId || data.run_id || '';
      const view = this._ddActiveSubTab(data);
      const live = this._ddLiveStatusState(t);
      const hasRegImages = this._datasetDiagHasRegImages ? this._datasetDiagHasRegImages(data) : Boolean(summary.has_reg_images);
      const regMode = this._datasetDiagEffectiveRegMode ? this._datasetDiagEffectiveRegMode(data) : this.datasetDiagRegMode;

      const infoLabel = t('ddInfoTooltip');
      const infoIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

      let html = '<div class="m-dd-topbar">';
      html += '<div class="m-dd-topbar-left">';
      if (data.available) {
        html += '<div class="m-segmented m-dd-view-switch-main" role="tablist" aria-label="' + this.esc(t('datasetDiagnostics')) + '">';
        html += '<button type="button" id="ddViewTabOverview" role="tab" class="m-segmented-btn' + (view === 'overview' ? ' active' : '') + '" aria-selected="' + (view === 'overview') + '" @click="setDatasetDiagSubTab(\'overview\')">'
          + '<span>' + this.esc(t('ddViewOverview')) + '</span></button>';
        html += '<button type="button" id="ddViewTabImages" role="tab" class="m-segmented-btn' + (view === 'images' ? ' active' : '') + '" aria-selected="' + (view === 'images') + '" @click="setDatasetDiagSubTab(\'images\')">'
          + '<span>' + this.esc(t('ddImagesTitle')) + '</span></button>';
        html += '</div>';
      } else {
        html += '<div class="m-view-heading"><span class="m-view-title">' + this.esc(t('datasetDiagnostics')) + '</span></div>';
      }
      html += '<button type="button" id="ddInfoBtn" class="btn-icon m-dd-info-btn" @click="openParameterDoc(\'dataset-diagnostics\')"'
        + ' aria-haspopup="dialog" title="' + this.esc(infoLabel) + '" aria-label="' + this.esc(infoLabel) + '">'
        + infoIcon + '</button>';
      html += '<span class="m-log-mode-indicator m-dd-live-pill" data-dd-live-state data-phase="' + this.esc(live.phase) + '"' + (live.visible ? '' : ' hidden') + '>'
        + '<i class="m-dd-live-dot" aria-hidden="true"></i>'
        + '<span data-dd-live-label>' + this.esc(live.label) + '</span></span>';
      html += '<span class="m-dd-inline-note-text" data-dd-multi-gpu-note'
        + (summary.multi_gpu_partial ? '' : ' hidden')
        + '>' + (summary.multi_gpu_partial ? this.esc(t('ddMultiGpuNotice')) : '') + '</span>';
      html += '</div>';

      html += '<div class="m-diagnostic-heading-actions">';
      if (availableRuns.length > 1) {
        html += '<label class="m-dd-inline-ctl m-dd-run-wrap"><span>' + this.esc(t('ddRunSegmentLabel')) + '</span>'
          + this._ddSelectHtml(this._ddRunOptions(), activeRunId, t('ddRunSegmentLabel'),
            'ddRunSelect', 'setDatasetDiagRunId($event.target.value)', 'datasetDiagRunId', '_ddRunOptions()')
          + '</label>';
      }
      if (data.available && hasRegImages) {
        html += '<label class="m-dd-inline-ctl m-dd-reg-wrap m-dd-top-reg-wrap" data-dd-top-reg-wrap>'
          + '<span>' + this.esc(t('ddRegFilterLabel')) + '</span>'
          + this._ddSelectHtml(this._ddRegOptions(), regMode, t('ddRegFilterLabel'),
            'ddTopRegSelect', 'setDatasetDiagRegMode($event.target.value)', '_datasetDiagEffectiveRegMode()', '_ddRegOptions()')
          + '</label>';
      }
      if (data.available) {
        html += '<label class="m-dd-inline-ctl" title="' + this.esc(t('ddMinSamplesHint')) + '">'
          + '<span>' + this.esc(t('ddMinSamplesLabel')) + '</span>'
          + this._ddSelectHtml(this._ddMinCountOptions(), this.datasetDiagMinCount, t('ddMinSamplesLabel'),
            'ddMinCountSelect', 'setDatasetDiagMinCount($event.target.value)', 'datasetDiagMinCount', '_ddMinCountOptions()')
          + '</label>';
      }
      html += '<button type="button" id="ddRefreshBtn" class="btn btn-sm btn-secondary refresh-button" :class="{ \'is-loading\': datasetDiagLoading || datasetDiagRefreshFeedback }" @click="refreshDatasetDiagnostics()" :disabled="datasetDiagLoading">'
        + this._refreshIconHtml() + '<span>' + this.esc(t('refresh')) + '</span></button></div></div>';

      if (this.datasetDiagError) {
        const errText = this.datasetDiagError === 'loadFailed' ? t('ddRefreshFailed') : this.datasetDiagError;
        html += '<div class="m-dd-notice-strip is-standalone is-error" role="alert">' + this.esc(errText) + '</div>';
      }
      return html;
    },

    _patchDatasetDiagHeading(slot, t, data) {
      if (!slot) return;
      const summary = data?.summary || {};
      const view = this._ddActiveSubTab(data);
      const ovBtn = slot.querySelector('#ddViewTabOverview');
      const imgBtn = slot.querySelector('#ddViewTabImages');
      if (ovBtn) {
        ovBtn.classList.toggle('active', view === 'overview');
        ovBtn.setAttribute('aria-selected', String(view === 'overview'));
      }
      if (imgBtn) {
        imgBtn.classList.toggle('active', view === 'images');
        imgBtn.setAttribute('aria-selected', String(view === 'images'));
      }

      const live = this._ddLiveStatusState(t);
      const liveEl = slot.querySelector('[data-dd-live-state]');
      if (liveEl) {
        liveEl.hidden = !live.visible;
        liveEl.dataset.phase = live.phase;
        const lblEl = liveEl.querySelector('[data-dd-live-label]');
        if (lblEl && lblEl.textContent !== live.label) lblEl.textContent = live.label;
      }

      const gpuEl = slot.querySelector('[data-dd-multi-gpu-note]');
      if (gpuEl) {
        gpuEl.hidden = !summary.multi_gpu_partial;
        if (summary.multi_gpu_partial) {
          const noticeText = t('ddMultiGpuNotice');
          if (gpuEl.textContent !== noticeText) gpuEl.textContent = noticeText;
        }
      }
    },

    _renderDatasetDiagHeroSlot(t, data, explicitMode = null) {
      const summary = data.summary || {};
      const hasSlope = !!summary.has_slope;
      const unknownTs = Number(summary.unknown_timestep_count || 0);
      const heroMode = explicitMode === 'timestep' ? 'timestep' : 'quadrant';
      let html = '<section class="m-dd-analysis-chart">';
      html += '<div class="m-hero-chart-wrap m-dd-hero-wrap" data-dd-hero-wrap data-mode="' + this.esc(heroMode) + '">';

      if (heroMode === 'timestep') {
        const activeComp = this._ddResolveActiveNoiseComparison(data);
        const excl = this._ddNoiseExcludedBounds(data.sampling_config);
        const prepared = this._ddPrepareTimestepBins(
          this._ddResolveNoiseProfileBins(data, 18),
          activeComp?.series || null,
          excl
        );
        const hasTheo = !activeComp && Boolean(this._ddComputeTheoreticalBinShares(data, prepared.bins, excl));
        const leftBarHtml = '<span class="m-dd-side-title">' + this.esc(t('ddHeroNoise')) + '</span>';
        const legendHtml = this._ddNoiseLegendHtml(t, activeComp, hasTheo);
        html += '<div class="m-dd-chart-bar is-compact">'
          + '<div class="m-dd-chart-bar-left">' + leftBarHtml + '</div>'
          + '<div class="m-dd-chart-bar-right"><div class="m-dd-legend" data-dd-noise-legend>' + legendHtml + '</div></div></div>';
        html += this._ddNoiseZonesSummaryHtml(t, data, activeComp);
      } else {
        html += '<p class="m-dd-chart-note" data-dd-early-slope-note' + (hasSlope ? ' hidden' : '') + '>' + this.esc(t('ddEarlySlopeHint')) + '</p>';
      }

      html += '<div class="m-hero-chart-stage m-dd-hero-stage" data-dd-hero-stage>'
        + '<svg class="m-dd-hero-svg" data-dd-hero-svg aria-hidden="true"></svg>'
        + (heroMode === 'timestep' ? '<div class="m-dd-ts-tooltip" data-dd-ts-tooltip hidden></div>' : '')
        + '</div>';
      if (heroMode === 'timestep') {
        const unknownText = unknownTs > 0
          ? (unknownTs === 1 ? t('ddUnknownTimestepOne') : t('ddUnknownTimestep')).replace('{n}', unknownTs)
          : '';
        html += '<p class="m-dd-ts-foot-note" data-dd-unknown-ts-note' + (unknownTs > 0 ? '' : ' hidden') + '>'
          + '<span data-dd-unknown-ts-text>' + (unknownText ? this.esc(unknownText) : '') + '</span></p>';
      } else {
        html += '<div class="m-chart-preview-pop m-dd-preview-pop" data-dd-preview-pop hidden>'
          + '<div class="m-dd-card-media m-dd-pop-media"><img alt="" decoding="async"/></div>'
          + '<div class="m-dd-card-body">'
          + '<div class="m-dd-card-top"><strong class="m-dd-card-name" x-loop-marquee.bounce><span data-dd-pop-title></span></strong><span class="m-dd-card-res" data-dd-pop-res></span></div>'
          + '<div class="m-dd-card-metrics"><span class="m-dd-card-slope" data-dd-pop-slope></span><span class="m-dd-card-reso" data-dd-pop-reso></span></div>'
          + '<div class="m-dd-card-foot"><span class="m-dd-pop-foot-left"><span class="m-dd-card-flag" data-dd-pop-status></span><small class="output-dir-tag m-dd-card-reg" data-dd-pop-reg hidden></small></span></div>'
          + '</div></div>';
      }
      html += '</div></section>';
      return html;
    },

    _ddDirectoryMatchesSubsets(data) {
      const subsets = data?.by_subset || [];
      const dirs = data?.by_directory || [];
      const images = data?.by_image || [];
      if (!subsets.length || subsets.length !== dirs.length || !images.length) return false;
      const subToDir = new Map();
      const dirToSub = new Map();
      for (const img of images) {
        if (!img) continue;
        if (Array.isArray(img.subsets) && img.subsets.length > 1) return false;
        const subKey = img.subset;
        const dirKey = img.directory || '(root)';
        if (!subKey || subKey === '(unknown)') return false;
        const prevDir = subToDir.get(subKey);
        if (prevDir !== undefined && prevDir !== dirKey) return false;
        subToDir.set(subKey, dirKey);
        const prevSub = dirToSub.get(dirKey);
        if (prevSub !== undefined && prevSub !== subKey) return false;
        dirToSub.set(dirKey, subKey);
      }
      if (subToDir.size !== subsets.length || dirToSub.size !== dirs.length) return false;
      const subKeys = new Set(subsets.map(s => s.key));
      const dirKeys = new Set(dirs.map(d => d.key));
      for (const [subKey, dirKey] of subToDir.entries()) {
        if (!subKeys.has(subKey) || !dirKeys.has(dirKey)) return false;
      }
      return true;
    },

    _ddGroupDisplayLabel(t, data, dim, key) {
      if (dim === 'resolution') return this._ddFormatResolution(key);
      if (dim === 'batch_size') {
        const strKey = String(key ?? '');
        if (/^\d+$/.test(strKey)) return t('ddBatchSizeLabel').replace('{n}', strKey);
        const match = (data?.by_batch_size || []).find(r => String(r.key) === strKey);
        return match?.label || strKey;
      }
      if (dim === 'subset') {
        const match = (data?.by_subset || []).find(r => String(r.key) === String(key));
        return match?.label || String(key);
      }
      if (dim === 'directory') {
        const match = (data?.by_directory || []).find(r => String(r.key) === String(key));
        return match?.label || String(key);
      }
      return String(key ?? '');
    },

    _ddGroupDimCountText(t, dim, count) {
      const n = Number(count);
      if (dim === 'resolution' || dim === 'batch_size') {
        return (n === 1 ? t('ddGroupDimCountResoOne') : t('ddGroupDimCountReso')).replace('{n}', count);
      }
      return (n === 1 ? t('ddGroupDimCountItemsOne') : t('ddGroupDimCountItems')).replace('{n}', count);
    },

    _ddGroupDisplayRows(dim, rows) {
      const list = Array.isArray(rows) ? rows : [];
      if (dim === 'resolution' && this.datasetDiagResoSort === 'residual') {
        return list.slice().sort((a, b) => {
          const nfDiff = Number(b?.non_finite_count || 0) - Number(a?.non_finite_count || 0);
          if (nfDiff !== 0) return nfDiff;
          const ar = a?.mean_residual != null ? Number(a.mean_residual) : -99;
          const br = b?.mean_residual != null ? Number(b.mean_residual) : -99;
          return br - ar;
        });
      }
      return list;
    },

    _ddGroupGaugeMetrics(residual, scaleBound = 0.12) {
      if (residual == null || !Number.isFinite(Number(residual))) {
        return { valid: false, barScale: 0, isNeg: false, color: 'transparent' };
      }
      const val = Number(residual);
      const bound = Math.max(0.12, Number(scaleBound) || 0.12);
      const barScale = Math.abs(val) < 0.002 ? 0 : Math.max(0.06, Math.min(1, Math.abs(val) / bound));
      return {
        valid: true,
        barScale: val < 0 ? -barScale : barScale,
        isNeg: val < 0,
        color: this._ddResidualColor(val, { scale: 'group', kind: 'graphic' }),
      };
    },

    _ddTrendPillHtml(t, slopeValue, convSlope = this._ddConvergingSlopeThreshold()) {
      const slope = slopeValue != null && Number.isFinite(Number(slopeValue)) ? Number(slopeValue) : null;
      if (slope == null) return '';
      const riseSlope = Math.max(0.002, Math.abs(convSlope) * 0.4);
      if (slope <= convSlope) {
        const pct = Math.abs(slope * 100).toFixed(1);
        const label = t('ddGroupTrendRate').replace('{slope}', this._ddFormatSlope(slope));
        const tip = t('ddGroupTrendTipGood').replace('{pct}', pct);
        return '<span class="m-dd-group-trend-pill is-good" title="' + this.esc(tip) + '">'
          + '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<polyline points="2,3.5 5.2,6.7 7.2,4.7 10,8.5"/><polyline points="7.5,8.5 10,8.5 10,6"/></svg>'
          + '<span>' + this.esc(label) + '</span></span>';
      }
      if (slope >= riseSlope) {
        const pct = Math.abs(slope * 100).toFixed(1);
        const label = t('ddGroupTrendRate').replace('{slope}', this._ddFormatSlope(slope));
        const tip = t('ddGroupTrendTipBad').replace('{pct}', pct);
        return '<span class="m-dd-group-trend-pill is-bad" title="' + this.esc(tip) + '">'
          + '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<polyline points="2,8.5 5.2,5.3 7.2,7.3 10,3.5"/><polyline points="7.5,3.5 10,3.5 10,6"/></svg>'
          + '<span>' + this.esc(label) + '</span></span>';
      }
      return '';
    },

    _ddGroupTrendHtml(t, row) {
      return this._ddTrendPillHtml(t, row?.slope);
    },

    _ddGroupAugText(t, augFlags) {
      if (!Array.isArray(augFlags) || !augFlags.length) return '';
      const map = {
        flip_aug: t('ddAugFlip'),
        color_aug: t('ddAugColor'),
        random_crop: t('ddAugCrop'),
        shuffle_caption: t('ddAugShuffle'),
      };
      const names = augFlags.map(f => map[f] || f).filter(Boolean);
      return names.length ? t('ddGroupAugPrefix').replace('{list}', names.join(' · ')) : '';
    },

    _ddGroupMetaInfo(t, dim, row, dimTotalCount = 0) {
      const seen = Number(row?.images || 0);
      const exp = row?.expected_images != null ? Number(row.expected_images) : null;
      const cmp = row?.comparable_count != null ? Number(row.comparable_count) : null;
      const tot = row?.count != null ? Number(row.count) : null;
      const imgText = (exp != null && exp > seen)
        ? t('ddGroupTrainedCoverage').replace('{n}', seen).replace('{total}', exp)
        : (seen === 1 ? t('ddGroupImagesPlainOne') : t('ddGroupImagesPlain')).replace('{n}', seen);
      let metaHtml;
      if (dim === 'batch_size') {
        const smpText = tot != null
          ? (tot === 1 ? t('ddGroupSamplesPlainOne') : t('ddGroupSamplesPlain')).replace('{n}', tot)
          : '';
        metaHtml = '<span>' + this.esc(imgText) + '</span>' + (smpText ? '<span>' + this.esc(smpText) + '</span>' : '');
      } else {
        const sharePct = (dimTotalCount > 0 && tot != null) ? Math.round((tot * 100) / dimTotalCount) : null;
        const shareText = sharePct != null ? t('ddGroupSharePct').replace('{pct}', sharePct) : '';
        metaHtml = '<span>' + this.esc(imgText) + '</span>' + (shareText ? '<span>' + this.esc(shareText) + '</span>' : '');
      }
      const labelText = dim === 'resolution'
        ? this._ddFormatResolution(row?.label || row?.key)
        : (dim === 'batch_size' && /^\d+$/.test(String(row?.key ?? ''))
          ? t('ddBatchSizeLabel').replace('{n}', String(row.key))
          : (row?.label || row?.key));
      const tipParts = [row?.full_path || labelText || '', imgText];
      if (dim === 'subset' && Number(row?.num_repeats || 0) > 1) {
        tipParts.push(t('ddGroupRepeatPlain').replace('{n}', Number(row.num_repeats)));
      }
      if (row?.mean_loss != null && Number.isFinite(Number(row.mean_loss))) {
        tipParts.push(t('ddLossLabel') + ' ' + this._ddFormatLoss(row.mean_loss));
      }
      if (tot != null) {
        if (cmp != null && cmp < tot) {
          tipParts.push(t('ddGroupTipMissingTs').replace('{total}', tot).replace('{missing}', tot - cmp));
        } else {
          tipParts.push((tot === 1 ? t('ddGroupTipSamplesPlainOne') : t('ddGroupTipSamplesPlain')).replace('{total}', tot));
        }
      }
      if (row?.slope != null && Number.isFinite(Number(row.slope))) {
        const s = Number(row.slope);
        const pct = Math.abs(s * 100).toFixed(1);
        const convSlope = this._ddConvergingSlopeThreshold();
        const riseSlope = Math.max(0.002, Math.abs(convSlope) * 0.4);
        if (s <= convSlope) tipParts.push(t('ddGroupTrendTipGood').replace('{pct}', pct));
        else if (s >= riseSlope) tipParts.push(t('ddGroupTrendTipBad').replace('{pct}', pct));
        else tipParts.push(t('ddGroupTrendTipFlat'));
      }
      const augText = this._ddGroupAugText(t, row?.aug_flags);
      if (augText) tipParts.push(augText);
      return { metaHtml, tooltip: tipParts.filter(Boolean).join(' · ') };
    },

    _ddVisibleGroupDimensions(t, data) {
      const subsets = data.by_subset || [];
      const dirs = data.by_directory || [];
      const candidates = [
        ['subset', t('ddDimSubsetTitle'), subsets, true],
        ['directory', t('ddDimDirectory'), this._ddDirectoryMatchesSubsets(data) ? [] : dirs, true],
        ['resolution', t('ddDimResolution'), data.by_resolution || [], true],
        ['batch_size', t('ddDimBatchRefTitle'), data.by_batch_size || [], false],
      ];
      return candidates.filter(([, , rows]) => rows.length >= 2);
    },

    _ddGroupAlertHtml(t, row) {
      const nfCount = Number(row?.non_finite_count || 0);
      const attCount = Number(row?.attention_count || 0);
      if (nfCount > 0) {
        return '<span class="m-dd-group-alert is-danger"><i class="m-dd-group-alert-dot" aria-hidden="true"></i><span>'
          + this.esc(t('ddGroupAlertNan').replace('{n}', nfCount)) + '</span></span>';
      }
      if (attCount > 0) {
        return '<span class="m-dd-group-alert is-warn"><i class="m-dd-group-alert-dot" aria-hidden="true"></i><span>'
          + this.esc(t('ddGroupAlertAttention').replace('{n}', attCount)) + '</span></span>';
      }
      return '';
    },

    _ddGroupRowHtml(t, dim, row, scaleBound, dimTotalCount, gf, activeDot) {
      const isSelected = !!(gf && gf.dim === dim && gf.key === row.key);
      const isSameDimOther = !!(gf && gf.dim === dim && !isSelected);
      let isLinked = false;
      if (activeDot) {
        if (dim === 'resolution') isLinked = (activeDot.resolutions || [activeDot.resolution]).includes(row.key);
        else if (dim === 'subset') isLinked = (activeDot.subsets || [activeDot.subset]).includes(row.key);
        else if (dim === 'directory') isLinked = (activeDot.directory || '(root)') === row.key;
      }
      const isSiblingDim = isSameDimOther && !isLinked;
      const resText = this._ddFormatResidual(row.mean_residual);
      const color = this._ddResidualColor(row.mean_residual, { scale: 'group' });
      const rowLabel = dim === 'resolution' ? this._ddFormatResolution(row.label || row.key) : (row.label || row.key);
      const fullTitle = row.full_path || rowLabel;
      const gmInfo = this._ddGroupMetaInfo(t, dim, row, dimTotalCount);
      const dimJs = this.esc(this.escapeJsString(dim));
      const keyJs = this.esc(this.escapeJsString(row.key));
      const lblJs = this.esc(this.escapeJsString(rowLabel));
      const jumpTitle = t('ddRowJumpImages');
      const gm = this._ddGroupGaugeMetrics(row.mean_residual, scaleBound);
      const alertHtml = this._ddGroupAlertHtml(t, row);
      const tagsHtml = (row.is_reg ? '<small class="output-dir-tag">' + this.esc(t('ddRegTag')) + '</small>' : '')
        + (dim === 'subset' && Number(row?.num_repeats || 0) > 1
          ? '<small class="m-dd-group-tag">' + this.esc(t('ddGroupRepeatPlain').replace('{n}', Number(row.num_repeats))) + '</small>' : '')
        + (dim === 'subset' && row?.loss_weight != null && Number.isFinite(Number(row.loss_weight)) && Math.abs(Number(row.loss_weight) - 1) > 1e-4
          ? '<small class="m-dd-group-tag">' + this.esc(t('ddGroupWeightPlain').replace('{w}', Number(row.loss_weight))) + '</small>' : '');
      const trendHtml = this._ddGroupTrendHtml(t, row);
      const attrs = ' role="button" tabindex="0" aria-pressed="' + isSelected + '"'
        + ' @mouseenter="previewDatasetDiagGroup(\'' + dimJs + '\', \'' + keyJs + '\')"'
        + ' @mouseleave="scheduleDatasetDiagPreviewClear()"'
        + ' @click="toggleDatasetDiagGroupFilter(\'' + dimJs + '\', \'' + keyJs + '\', \'' + lblJs + '\')"'
        + ' @keydown.enter.prevent="toggleDatasetDiagGroupFilter(\'' + dimJs + '\', \'' + keyJs + '\', \'' + lblJs + '\')"'
        + ' @keydown.space.prevent="toggleDatasetDiagGroupFilter(\'' + dimJs + '\', \'' + keyJs + '\', \'' + lblJs + '\')"';
      const fillClass = gm.valid ? (gm.isNeg ? 'is-neg' : 'is-pos') : 'is-pos';
      const fillStyle = gm.valid
        ? `transform:scaleX(${gm.barScale.toFixed(3)});background-color:${gm.color}`
        : 'transform:scaleX(0);background-color:transparent';
      return '<div class="m-dd-flat-group-row is-clickable' + (isSelected ? ' is-selected' : '') + (isLinked ? ' is-linked' : '') + (isSiblingDim ? ' is-sibling-dim' : '') + '" data-dd-group-row-key="' + this.esc(dim + '::' + row.key) + '" title="' + this.esc(gmInfo.tooltip) + '"' + attrs + '>'
        + '<div class="m-dd-group-row-top">'
        + '<div class="m-dd-group-name" title="' + this.esc(fullTitle) + '">'
        + '<span class="m-dd-group-name-marquee" x-loop-marquee.bounce><span class="m-dd-group-name-track"><span class="m-dd-group-name-text">' + this.esc(rowLabel) + '</span>' + tagsHtml + '</span></span>'
        + '</div>'
        + '<div class="m-dd-group-row-meta">'
        + '<span class="m-dd-group-alert-slot" data-dd-group-alert>' + alertHtml + '</span>'
        + '<span class="m-dd-group-row-res-group">'
        + '<strong class="m-dd-num-val m-dd-flat-res" data-dd-flat-res style="color:' + color + '">' + this.esc(resText) + '</strong>'
        + '<button type="button" class="m-dd-row-jump" @click.stop="openDatasetDiagGroupFilter(\'' + dimJs + '\', \'' + keyJs + '\', \'' + lblJs + '\')" title="' + this.esc(jumpTitle) + '" aria-label="' + this.esc(jumpTitle) + '">' + this._ddRowJumpIconHtml() + '</button>'
        + '</span></div></div>'
        + '<div class="m-dd-group-row-sub">'
        + '<div class="m-dd-group-img-n" data-dd-group-img-n>' + gmInfo.metaHtml + '</div>'
        + '<div class="m-dd-group-row-viz">'
        + '<span class="m-dd-group-trend-slot" data-dd-group-trend>' + trendHtml + '</span>'
        + '<div class="m-dd-gauge-inline" aria-hidden="true">'
        + '<span class="m-dd-gauge-zero"></span>'
        + '<span class="m-dd-gauge-fill ' + fillClass + '" data-row-fill style="' + fillStyle + '"></span>'
        + '</div></div></div></div>';
    },

    _rerenderDatasetDiagGroups() {
      const panel = globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const host = panel?.querySelector?.('[data-dd-groups-host]');
      if (!host || !this.datasetDiagData?.available) return false;
      const t = k => this.tMonitor(k);
      const html = this._renderDatasetDiagGroupsCard(t, this.datasetDiagData);
      host.innerHTML = html || ('<div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('ddNoGroupData')) + '</p></div>');
      this._syncDatasetDiagStatusHighlight?.(panel);
      return true;
    },

    _ddGroupDimHeadHtml(t, dim, dimLabel, count, isCollapsed, extraLeftHtml = '', rightHtml = '') {
      const dimJs = this.esc(this.escapeJsString(dim));
      return '<div class="m-dd-group-dim-head">'
        + '<button type="button" class="m-dd-group-dim-toggle" data-dd-group-dim-toggle aria-expanded="' + (!isCollapsed) + '" @click="toggleDatasetDiagGroupDim(\'' + dimJs + '\')">'
        + '<svg class="m-dd-group-dim-caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.25 8 9.75l3.5-3.5"/></svg>'
        + '<span class="m-dd-group-dim-title">' + this.esc(dimLabel) + '</span>'
        + '<span class="m-dd-group-dim-count" data-dd-group-dim-count>' + this.esc(this._ddGroupDimCountText(t, dim, count)) + '</span>'
        + extraLeftHtml
        + '</button>'
        + rightHtml
        + '</div>';
    },

    _renderDatasetDiagGroupsCard(t, data) {
      const visibleDims = this._ddVisibleGroupDimensions(t, data);
      if (!visibleDims.length) return '';

      const gf = this.datasetDiagGroupFilter;
      const panel = globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const activeDot = panel?.querySelector?.('[data-dd-hero-wrap][data-mode="quadrant"]')?._ddActiveDot || null;
      const arErr = Number(data?.summary?.bucket_ar_error);
      const showAr = Number.isFinite(arErr) && arErr >= 0.04;

      let html = '<section class="m-dd-groups">';
      html += '<div class="m-dd-groups-legend" aria-hidden="true">'
        + '<span class="m-dd-groups-legend-item"><i class="m-dd-legend-swatch is-easy"></i><span>' + this.esc(t('ddGroupLegendEasy')) + '</span></span>'
        + '<span class="m-dd-groups-legend-item"><i class="m-dd-legend-swatch is-hard"></i><span>' + this.esc(t('ddGroupLegendHard')) + '</span></span>'
        + '</div>';

      visibleDims.forEach(([dim, dimLabel, rows, canFilter]) => {
        const isCollapsed = !!this.datasetDiagCollapsedDims?.[dim];
        if (!canFilter) {
          const orderedRows = this._ddGroupDisplayRows(dim, rows);
          const scaleBound = orderedRows.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0) * 1.18), 0.12);
          html += '<div class="m-dd-group-dim-block' + (isCollapsed ? ' is-collapsed' : '') + '" data-dd-group-dim="' + this.esc(dim) + '">';
          html += this._ddGroupDimHeadHtml(t, dim, dimLabel, orderedRows.length, isCollapsed);
          html += '<div class="m-dd-group-dim-body" data-dd-group-dim-body' + (isCollapsed ? ' inert' : '') + '><div class="m-dd-group-dim-body-inner">';
          html += '<div class="m-dd-flat-group-list is-two-col">';
          orderedRows.forEach(row => {
            const resText = this._ddFormatResidual(row.mean_residual);
            const color = this._ddResidualColor(row.mean_residual, { scale: 'group' });
            const chipLabel = /^\d+$/.test(String(row.key ?? ''))
              ? t('ddBatchSizeLabel').replace('{n}', String(row.key))
              : (row.label || row.key);
            const gmInfo = this._ddGroupMetaInfo(t, dim, row, 0);
            const gm = this._ddGroupGaugeMetrics(row.mean_residual, scaleBound);
            const fillClass = gm.valid ? (gm.isNeg ? 'is-neg' : 'is-pos') : 'is-pos';
            const fillStyle = gm.valid
              ? `transform:scaleX(${gm.barScale.toFixed(3)});background-color:${gm.color}`
              : 'transform:scaleX(0);background-color:transparent';
            const dimJs = this.esc(this.escapeJsString(dim));
            const keyJs = this.esc(this.escapeJsString(row.key));
            html += '<div class="m-dd-flat-group-row is-batch-item" data-dd-group-row-key="' + this.esc(dim + '::' + row.key) + '" title="' + this.esc(gmInfo.tooltip) + '"'
              + ' @mouseenter="previewDatasetDiagGroup(\'' + dimJs + '\', \'' + keyJs + '\')"'
              + ' @mouseleave="scheduleDatasetDiagPreviewClear()">'
              + '<div class="m-dd-group-row-top">'
              + '<div class="m-dd-group-name"><span class="m-dd-group-name-text">' + this.esc(chipLabel) + '</span></div>'
              + '<strong class="m-dd-num-val m-dd-flat-res" data-dd-flat-res style="color:' + color + '">' + this.esc(resText) + '</strong>'
              + '</div>'
              + '<div class="m-dd-group-img-n" data-dd-group-img-n>' + gmInfo.metaHtml + '</div>'
              + '<div class="m-dd-gauge-inline" aria-hidden="true">'
              + '<span class="m-dd-gauge-zero"></span>'
              + '<span class="m-dd-gauge-fill ' + fillClass + '" data-row-fill style="' + fillStyle + '"></span>'
              + '</div>'
              + '</div>';
          });
          html += '</div></div></div></div>';
          return;
        }

        const orderedRows = this._ddGroupDisplayRows(dim, rows);
        const dimTotalCount = orderedRows.reduce((sum, r) => sum + Number(r.count || 0), 0);
        const scaleBound = orderedRows.reduce((m, r) => Math.max(m, Math.abs(Number(r.mean_residual) || 0) * 1.18), 0.12);
        const foldLimit = 5;
        const needFold = orderedRows.length > foldLimit;
        const visibleRows = needFold ? orderedRows.slice(0, foldLimit) : orderedRows;
        const hiddenRows = needFold ? orderedRows.slice(foldLimit) : [];
        const selectedInTail = !!(gf && gf.dim === dim && hiddenRows.some(r => r.key === gf.key));
        const isExpanded = !!(this.datasetDiagGroupExpanded?.[dim] || selectedInTail);
        const dimJs = this.esc(this.escapeJsString(dim));
        const arHtml = dim === 'resolution'
          ? '<span class="m-dd-group-ar-badge" data-dd-group-ar-badge' + (showAr ? '' : ' hidden') + ' title="' + this.esc(t('ddGroupArErrorTip')) + '">'
            + (showAr ? this.esc(t('ddGroupArError').replace('{pct}', (arErr * 100).toFixed(1))) : '') + '</span>'
          : '';
        const sortHtml = (dim === 'resolution' && orderedRows.length >= 4)
          ? '<button type="button" class="m-dd-group-sort-btn" @click="toggleDatasetDiagGroupSort()">'
            + this.esc(this.datasetDiagResoSort === 'residual' ? t('ddGroupSortResidual') : t('ddGroupSortOrder')) + '</button>'
          : '';

        html += '<div class="m-dd-group-dim-block' + (isCollapsed ? ' is-collapsed' : '') + '" data-dd-group-dim="' + this.esc(dim) + '">';
        html += this._ddGroupDimHeadHtml(t, dim, dimLabel, orderedRows.length, isCollapsed, arHtml, sortHtml);
        html += '<div class="m-dd-group-dim-body" data-dd-group-dim-body' + (isCollapsed ? ' inert' : '') + '><div class="m-dd-group-dim-body-inner">';
        html += '<div class="m-dd-flat-group-list">';
        visibleRows.forEach(row => {
          html += this._ddGroupRowHtml(t, dim, row, scaleBound, dimTotalCount, gf, activeDot);
        });
        if (needFold) {
          html += '<div class="m-dd-group-fold-body' + (isExpanded ? ' is-open' : '') + '" data-dd-group-fold="' + this.esc(dim) + '">';
          html += '<div class="m-dd-group-fold-inner">';
          hiddenRows.forEach(row => {
            html += this._ddGroupRowHtml(t, dim, row, scaleBound, dimTotalCount, gf, activeDot);
          });
          html += '</div></div>';
          html += '<button type="button" class="m-dd-group-fold-btn" data-dd-group-fold-btn="' + this.esc(dim) + '" data-dd-fold-count="' + hiddenRows.length + '" aria-expanded="' + isExpanded + '" @click="toggleDatasetDiagGroupFold(\'' + dimJs + '\')">'
            + this.esc(isExpanded ? t('ddGroupFoldCollapse') : t('ddGroupFoldExpand').replace('{n}', hiddenRows.length))
            + '</button>';
        }
        html += '</div></div></div></div>';
      });
      html += '</section>';
      return html;
    },
  };
})();
