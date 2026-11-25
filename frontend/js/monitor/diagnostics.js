/* 训练诊断与多视角交互示波器；由 monitor-render.js 装配。 */
window.monitorDiagnosticsMixin = {
  _trainingDiagnosticPoints(limit = 120) {
    const series = this.monitorLossSeries.find(item => item.tag === 'loss/average')
      || this.monitorLossSeries.find(item => item.tag === 'loss/current');
    const source = limit <= 160 && series?.diagnostic_points?.length ? series.diagnostic_points : series?.points;
    const cleaned = this._cleanLossPoints(source);
    return limit > 0 ? cleaned.slice(-limit) : cleaned;
  },

  _allPrimaryLossSeries() {
    const avg = this.monitorLossSeries.find(item => item.tag === 'loss/average');
    const raw = this.monitorLossSeries.find(item => item.tag === 'loss/current');
    return {
      primary: avg || raw || null,
      primaryIsAvg: !!avg,
      lr: window.selectMonitorLearningRateSeries?.(this.monitorLossSeries) || null,
      epoch: this.monitorLossSeries.find(item => item.tag === 'loss/epoch_average')
        || this.monitorLossSeries.find(item => item.tag === 'loss/epoch') || null,
    };
  },

  // Loss 点清洗唯一入口：按 step 去重（保留同 step 的最后一个值）后升序。
  _cleanLossPoints(rawPoints) {
    const byStep = new Map();
    (rawPoints || []).forEach(point => {
      const rawStep = point && point.step;
      const rawValue = point && point.value;
      const step = Number(rawStep);
      const value = Number(rawValue);
      if (rawStep !== null && rawStep !== '' && rawStep !== undefined && rawValue !== null && rawValue !== '' && rawValue !== undefined && Number.isFinite(step) && Number.isFinite(value)) {
        byStep.set(step, { step, value });
      }
    });
    return Array.from(byStep.values()).sort((left, right) => left.step - right.step);
  },

  _trainingDiagnosticRules() {
    return {
      minimumPoints: 6,
      windowMax: 60,
      reboundChange: 3,
      volatileCv: 12,
      convergingChange: -2,
      plateauAbsChange: 1,
      plateauCv: 4,
    };
  },

  _trainingDiagnostics(points) {
    const rules = this._trainingDiagnosticRules();
    const clean = points ? this._cleanLossPoints(points).slice(-rules.windowMax * 2) : this._trainingDiagnosticPoints();

    const base = {
      code: 'insufficient', tone: 'muted', count: clean.length,
      windowSize: 0, latestStep: clean.length ? clean[clean.length - 1].step : null,
      recentMean: null, previousMean: null, changePct: null, volatilityPct: null,
      bestValue: null, bestStep: null, gapFromBestPct: null,
      previousStartStep: null, previousEndStep: null, recentStartStep: null, recentEndStep: null,
    };
    if (!clean.length) return base;

    const windowSize = clean.length >= rules.minimumPoints ? Math.floor(clean.length / 2) : 0;
    const visible = windowSize ? clean.slice(-windowSize * 2) : clean;
    const best = this._lowestLossPoint(visible);
    base.bestValue = best.value;
    base.bestStep = best.step;
    base.gapFromBestPct = this._lossGapPercent(clean.at(-1).value, best.value);
    if (clean.length < rules.minimumPoints) return base;

    const recent = clean.slice(-windowSize);
    const previous = clean.slice(-windowSize * 2, -windowSize);
    const mean = values => values.reduce((sum, point) => sum + point.value, 0) / values.length;
    const recentMean = mean(recent);
    const previousMean = mean(previous);
    const variance = recent.reduce((sum, point) => sum + Math.pow(point.value - recentMean, 2), 0) / recent.length;
    const changePct = (recentMean - previousMean) / Math.max(Math.abs(previousMean), 1e-12) * 100;
    const volatilityPct = Math.sqrt(variance) / Math.max(Math.abs(recentMean), 1e-12) * 100;
    Object.assign(base, {
      windowSize, recentMean, previousMean, changePct, volatilityPct,
      previousStartStep: previous[0].step,
      previousEndStep: previous[previous.length - 1].step,
      recentStartStep: recent[0].step,
      recentEndStep: recent[recent.length - 1].step,
    });

    if (changePct >= rules.reboundChange) Object.assign(base, { code: 'rebound', tone: 'danger' });
    else if (volatilityPct >= rules.volatileCv) Object.assign(base, { code: 'volatile', tone: 'warn' });
    else if (changePct <= rules.convergingChange) Object.assign(base, { code: 'converging', tone: 'ok' });
    else if (Math.abs(changePct) < rules.plateauAbsChange && volatilityPct < rules.plateauCv) Object.assign(base, { code: 'plateau', tone: 'calm' });
    else Object.assign(base, { code: 'steady', tone: 'neutral' });
    return base;
  },

  _lowestLossPoint(points) {
    return points.reduce((best, point) => !best || point.value <= best.value ? point : best, null);
  },

  _lossGapPercent(latest, best) {
    if (latest === best) return 0;
    return Math.abs(best) > 1e-12 ? (latest - best) / Math.abs(best) * 100 : null;
  },

  _formatDiagnosticValue(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    if (Math.abs(number) > 0 && Math.abs(number) < 0.001) return number.toExponential(3);
    return number.toFixed(4);
  },

  _formatDiagnosticPercent(value, signed) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    const normalized = Math.abs(number) < 0.05 ? 0 : number;
    return (signed && normalized > 0 ? '+' : '') + normalized.toFixed(1) + '%';
  },

  _diagnosticText(t, code, kind) {
    const copy = {
      insufficient: {
        label: 'diagnosticInsufficient',
        summary: 'diagnosticInsufficientSummary',
      },
      converging: {
        label: 'diagnosticConverging',
        summary: 'diagnosticConvergingSummary',
      },
      plateau: {
        label: 'diagnosticPlateau',
        summary: 'diagnosticPlateauSummary',
      },
      rebound: {
        label: 'diagnosticRebound',
        summary: 'diagnosticReboundSummary',
      },
      volatile: {
        label: 'diagnosticVolatile',
        summary: 'diagnosticVolatileSummary',
      },
      steady: {
        label: 'diagnosticSteady',
        summary: 'diagnosticSteadySummary',
      },
    };
    const item = copy[code] || copy.insufficient;
    return t(item[kind]);
  },

  _fillDiagnosticTemplate(template, values) {
    let result = String(template || '');
    Object.keys(values).forEach(key => {
      result = result.split('{' + key + '}').join(String(values[key]));
    });
    return result;
  },

  _diagnosticEvidence(t, diagnostic) {
    const rules = this._trainingDiagnosticRules();
    const values = {
      count: diagnostic.count,
      minimum: rules.minimumPoints,
      window: diagnostic.windowSize,
      change: this._formatDiagnosticPercent(diagnostic.changePct, true),
      magnitude: this._formatDiagnosticPercent(Math.abs(Number(diagnostic.changePct)), false),
      volatility: this._formatDiagnosticPercent(diagnostic.volatilityPct, false),
      rebound: rules.reboundChange,
      volatile: rules.volatileCv,
      converging: Math.abs(rules.convergingChange),
      plateauChange: rules.plateauAbsChange,
      plateauVolatility: rules.plateauCv,
    };
    const copy = {
      insufficient: 'diagnosticEvidenceInsufficient',
      converging: 'diagnosticEvidenceConverging',
      plateau: 'diagnosticEvidencePlateau',
      rebound: 'diagnosticEvidenceRebound',
      volatile: 'diagnosticEvidenceVolatile',
      steady: 'diagnosticEvidenceSteady',
    };
    const key = copy[diagnostic.code] || copy.insufficient;
    return this._fillDiagnosticTemplate(t(key), values);
  },

  _diagnosticWindowEvidence(t, diagnostic) {
    if (!diagnostic.windowSize) return t('diagnosticWindowPending');
    return this._fillDiagnosticTemplate(
      t('diagnosticWindowEvidence'),
      {
        recentStart: Math.round(diagnostic.recentStartStep),
        recentEnd: Math.round(diagnostic.recentEndStep),
        previousStart: Math.round(diagnostic.previousStartStep),
        previousEnd: Math.round(diagnostic.previousEndStep),
        window: diagnostic.windowSize,
      }
    );
  },

  _setMonitorChartMode(mode) {
    if (!['window', 'full', 'epoch'].includes(mode) || this.monitorChartMode === mode) return;
    this.monitorChartMode = mode;
    this._refreshMonitorChart(true);
  },

  _refreshMonitorChart(animateSwitch) {
    const panel = document.querySelector('#monitorTabContent .m-tab-panel[data-tab="overview"]');
    if (panel) {
      const isHistory = !!this.selectedRunDir;
      const d = isHistory ? (this.runDetailData || {}) : (this.monitorData || {});
      this._patchTrainingDiagnostics(panel, (k, fb) => this.tMonitor(k, fb), d, isHistory, { animateSwitch });
    }
  },

  _jumpToPreviewBatch(batchId, firstIndex) {
    if (!batchId) return;
    this.sampleBatchId = batchId;
    if (Number.isInteger(firstIndex) && firstIndex >= 0) this.previewStep = firstIndex;
    this.setMonitorTab('samples');
    this._scrollOverviewToBatch(this._sampleOverviewPanel(), this._sampleDataModel().byBatch.get(batchId));
  },

  _trainingDiagnosticsHtml(t) {
    const rules = this._trainingDiagnosticRules();
    let html = '<section class="m-console-card m-training-diagnostics">';
    html += '<div class="m-card-heading m-diagnostic-heading"><div><span data-diagnostic-field="title">' + this.esc(t('trainingDiagnostics')) + '</span></div>';
    html += '<div class="m-diagnostic-heading-actions">';
    html += '<div class="m-segmented m-chart-modes" role="tablist" aria-label="' + this.esc(t('trainingDiagnostics')) + '">';
    html += '<button type="button" role="tab" class="m-segmented-btn" data-chart-mode="window" aria-selected="true">' + this.esc(t('chartModeWindow')) + '</button>';
    html += '<button type="button" role="tab" class="m-segmented-btn" data-chart-mode="full" aria-selected="false">' + this.esc(t('chartModeFull')) + '</button>';
    html += '<button type="button" role="tab" class="m-segmented-btn" data-chart-mode="epoch" aria-selected="false" hidden>' + this.esc(t('chartModeEpoch')) + '</button>';
    html += '</div>';
    html += '<button type="button" class="btn btn-sm btn-secondary m-tensorboard-link" @click="navigate(\'tensorboard\')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V9m7 10V5m7 14v-7"/></svg>' + this.esc(t('openTensorBoard')) + '</button>';
    html += '</div></div>';

    html += '<div class="m-diagnostic-body">';
    html += '<div class="m-diagnostic-verdict" data-diagnostic-tone="muted">';
    html += '<div class="m-diagnostic-copy"><div class="m-diagnostic-state"><i aria-hidden="true"></i><strong data-diagnostic-field="state">--</strong></div><p data-diagnostic-field="summary">--</p></div>';
    html += '<div class="m-chart-layers" data-chart-layers hidden>';
    html += '<button type="button" class="btn btn-sm btn-secondary m-lr-toggle" data-chart-layer="lr" aria-pressed="false" hidden><i aria-hidden="true"></i><span>' + this.esc(t('chartOverlayLr')) + '</span></button>';
    html += '</div></div>';

    html += '<div class="m-hero-chart-wrap" data-hero-chart-wrap hidden>';
    html += '<div class="m-chart-hud" data-chart-hud><span class="m-chart-hud-range" data-chart-hud-range></span><span class="m-chart-hud-readout" data-chart-hud-readout></span></div>';
    html += '<div class="m-hero-chart-stage" data-hero-chart-stage><svg class="m-hero-chart-svg" data-hero-chart-svg aria-hidden="true"></svg></div>';
    html += '<div class="m-chart-preview-pop" data-chart-preview-pop hidden><button type="button" class="m-preview-pop-main" data-preview-pop-lightbox><img alt="" decoding="async"/></button><div class="m-chart-preview-foot"><strong x-loop-marquee.bounce><span data-preview-pop-title></span></strong><button type="button" class="m-preview-pop-link" data-preview-pop-samples>' + this.esc(t('chartPreviewSamples')) + '</button></div></div>';
    html += '</div>';
    html += '</div>';

    html += '<div class="m-diagnostic-metrics" hidden>';
    html += `<div class="m-diagnostic-metric m-diagnostic-metric-gauge" data-diagnostic-metric="change" title="${this.esc(t('gaugeChangeHint'))}">
      <div class="m-diagnostic-metric-top"><span>${this.esc(t('recentLossChange'))}</span><strong data-diagnostic-field="change">--</strong></div>
      <div class="m-gauge m-gauge-change" data-gauge="change" aria-hidden="true">
        <div class="m-gauge-track">
          <span class="m-gauge-zero" style="left:50%"></span>
          <span class="m-gauge-fill" data-gauge-fill="change"></span>
        </div>
      </div>
      <small data-diagnostic-field="change-meta">${this.esc(t('comparedPreviousWindow'))}</small>
    </div>`;

    html += `<div class="m-diagnostic-metric m-diagnostic-metric-gauge" data-diagnostic-metric="volatility" title="${this.esc(t('gaugeVolatilityHint'))}">
      <div class="m-diagnostic-metric-top"><span>${this.esc(t('lossVolatility'))}</span><strong data-diagnostic-field="volatility">--</strong></div>
      <div class="m-gauge m-gauge-volatility" data-gauge="volatility" aria-hidden="true">
        <div class="m-gauge-track">
          <span class="m-gauge-origin"></span>
          <span class="m-gauge-fill" data-gauge-fill="volatility"></span>
        </div>
      </div>
      <small data-diagnostic-field="volatility-meta">${this.esc(t('lowerIsMoreStable'))}</small>
    </div>`;

    html += `<div class="m-diagnostic-metric m-diagnostic-metric-link" data-diagnostic-metric="best" data-diagnostic-link="best" tabindex="0">
      <div class="m-diagnostic-metric-top"><span><i class="m-anchor-dot is-best" aria-hidden="true"></i><span data-diagnostic-field="best-label">${this.esc(t('bestLoss'))}</span></span><strong data-diagnostic-field="best">--</strong></div>
      <small data-diagnostic-field="best-meta">${this.esc(t('bestObservedValue'))}</small>
    </div>`;

    html += `<div class="m-diagnostic-metric m-diagnostic-metric-link" data-diagnostic-metric="gap" data-diagnostic-link="gap" tabindex="0">
      <div class="m-diagnostic-metric-top"><span><i class="m-anchor-dot is-gap" aria-hidden="true"></i>${this.esc(t('gapFromBest'))}</span><strong data-diagnostic-field="gap">--</strong></div>
      <small data-diagnostic-field="gap-meta">${this.esc(t('gapHintShort'))}</small>
    </div>`;
    html += '</div>';

    html += '<details class="m-diagnostic-details"><summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg><span>' + this.esc(t('diagnosticMethodTitle')) + '</span></summary>';
    html += '<div class="m-diagnostic-method-content"><div class="m-diagnostic-evidence"><p data-diagnostic-field="evidence">--</p><small data-diagnostic-field="window-evidence">--</small></div>';
    const methodItems = [
      [t('diagnosticMethodSource'), t('diagnosticMethodSourceText')],
      [t('diagnosticMethodWindow'), this._fillDiagnosticTemplate(t('diagnosticMethodWindowText'), { total: rules.windowMax * 2, window: rules.windowMax, minimum: rules.minimumPoints })],
      [t('diagnosticMethodChange'), t('diagnosticMethodChangeText')],
      [t('diagnosticMethodVolatility'), t('diagnosticMethodVolatilityText')],
    ];
    html += '<dl class="m-diagnostic-method-grid">';
    methodItems.forEach(item => { html += '<div><dt>' + this.esc(item[0]) + '</dt><dd>' + this.esc(item[1]) + '</dd></div>'; });
    html += '</dl><p class="m-diagnostic-rule-title">' + this.esc(t('diagnosticRuleOrder')) + '</p><dl class="m-diagnostic-rules">';
    const ruleItems = [
      [t('diagnosticRuleRebound'), this._fillDiagnosticTemplate(t('diagnosticRuleReboundCondition'), { value: rules.reboundChange })],
      [t('diagnosticRuleVolatile'), this._fillDiagnosticTemplate(t('diagnosticRuleVolatileCondition'), { value: rules.volatileCv })],
      [t('diagnosticRuleConverging'), this._fillDiagnosticTemplate(t('diagnosticRuleConvergingCondition'), { value: rules.convergingChange })],
      [t('diagnosticRulePlateau'), this._fillDiagnosticTemplate(t('diagnosticRulePlateauCondition'), { change: rules.plateauAbsChange, volatility: rules.plateauCv })],
      [t('diagnosticRuleSteady'), t('diagnosticRuleOtherwise')],
    ];
    ruleItems.forEach(item => { html += '<div><dt>' + this.esc(item[0]) + '</dt><dd>' + this.esc(item[1]) + '</dd></div>'; });
    html += '</dl><p class="m-diagnostic-scope">' + this.esc(t('diagnosticScopeText')) + '</p></div>';
    html += '</details>';
    html += '<div class="preview-connector m-diagnostic-connector" data-diagnostic-connector aria-hidden="true"></div>';
    html += '</section>';
    return html;
  },

  _paintDiagnosticConnector(card, focus) {
    const conn = card?.querySelector('[data-diagnostic-connector]');
    if (!conn) return;
    if (!focus) {
      conn.classList.remove('is-active');
      return;
    }
    const source = card.querySelector(`[data-diagnostic-link="${focus}"]`);
    const wrap = card.querySelector('[data-hero-chart-wrap]');
    if (!source || !wrap || wrap.hidden) {
      conn.classList.remove('is-active');
      return;
    }
    const target = focus === 'best'
      ? (wrap.querySelector('.m-best-dot') || wrap.querySelector('.m-epoch-bar.is-best'))
      : (wrap.querySelector('[data-caliper-target]') || wrap.querySelector('.m-latest-dot') || wrap.querySelector('.m-epoch-bar.is-latest'));
    if (!target) {
      conn.classList.remove('is-active');
      return;
    }
    const cRect = card.getBoundingClientRect();
    const aEl = source.querySelector('strong') || source;
    const sRect = aEl.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    if (!cRect.width || !sRect.width || !tRect.width) {
      conn.classList.remove('is-active');
      return;
    }
    const sx = sRect.left + sRect.width / 2 - cRect.left;
    const sy = sRect.top - cRect.top - 5;
    const cx = tRect.left + tRect.width / 2 - cRect.left;
    const cy = target.classList.contains('m-epoch-bar')
      ? (tRect.top - cRect.top - 4)
      : (tRect.top + tRect.height / 2 - cRect.top);
    const dx = cx - sx;
    const dy = cy - sy;
    const dist = Math.hypot(dx, dy);
    if (dist < 14) {
      conn.classList.remove('is-active');
      return;
    }
    const pad = target.classList.contains('m-epoch-bar') ? 2 : 9;
    window.AnimaUI.drawPreviewConnector(conn, focus, sx, sy, [[cx - dx / dist * pad, cy - dy / dist * pad]]);
  },

  _bindDiagnosticInteractions(card) {
    if (!card || card._diagnosticBound) return;
    card._diagnosticBound = true;
    const wrap = card.querySelector('[data-hero-chart-wrap]');
    const setFocus = (focus, holdMs = 0) => {
      if (!wrap) return;
      if (wrap._focusTimer) { clearTimeout(wrap._focusTimer); wrap._focusTimer = null; }
      if (focus) {
        wrap.dataset.focus = focus;
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => this._paintDiagnosticConnector(card, wrap.dataset.focus));
        } else {
          this._paintDiagnosticConnector(card, focus);
        }
        if (holdMs > 0) {
          wrap._focusTimer = setTimeout(() => {
            delete wrap.dataset.focus;
            wrap._focusTimer = null;
            this._paintDiagnosticConnector(card, '');
          }, holdMs);
        }
      } else {
        delete wrap.dataset.focus;
        this._paintDiagnosticConnector(card, '');
      }
    };

    card.addEventListener('click', event => {
      const modeBtn = event.target.closest?.('[data-chart-mode]');
      if (modeBtn) { this._setMonitorChartMode(modeBtn.dataset.chartMode); return; }
      const layerBtn = event.target.closest?.('[data-chart-layer]');
      if (layerBtn) {
        this.monitorChartShowLr = !this.monitorChartShowLr;
        this._refreshMonitorChart(false);
        return;
      }
      const popSamples = event.target.closest?.('[data-preview-pop-samples]');
      if (popSamples) {
        const pop = popSamples.closest('[data-chart-preview-pop]');
        if (pop?.dataset.batchId) {
          pop.hidden = true;
          this._jumpToPreviewBatch(pop.dataset.batchId, Number(pop.dataset.firstIndex));
        }
        return;
      }
      const popLightbox = event.target.closest?.('[data-preview-pop-lightbox]');
      if (popLightbox) {
        const pop = popLightbox.closest('[data-chart-preview-pop]');
        if (pop?.dataset.batchId) {
          const idx = Number(pop.dataset.firstIndex);
          pop.hidden = true;
          if (typeof this.openPreviewLightbox === 'function' && Number.isInteger(idx) && idx >= 0) this.openPreviewLightbox(idx);
          else this._jumpToPreviewBatch(pop.dataset.batchId, idx);
        }
        return;
      }
      const marker = event.target.closest?.('[data-preview-batch-id]');
      if (marker) {
        const idx = Number(marker.dataset.previewIndex);
        if (typeof this.openPreviewLightbox === 'function' && Number.isInteger(idx) && idx >= 0) this.openPreviewLightbox(idx);
        else this._jumpToPreviewBatch(marker.dataset.previewBatchId, idx);
        return;
      }
      const linkCard = event.target.closest?.('[data-diagnostic-link]');
      if (linkCard) {
        setFocus(linkCard.dataset.diagnosticLink, 1600);
        return;
      }
      const stageHit = event.target.closest?.('[data-hero-chart-stage]');
      if (stageHit && wrap?._activePreviewEvent) {
        const ev = wrap._activePreviewEvent;
        if (typeof this.openPreviewLightbox === 'function' && Number.isInteger(ev.firstIndex) && ev.firstIndex >= 0) this.openPreviewLightbox(ev.firstIndex);
        else this._jumpToPreviewBatch(ev.batchId, ev.firstIndex);
      }
    });

    card.addEventListener('keydown', event => {
      const modeBtn = event.target.closest?.('[data-chart-mode]');
      if (modeBtn && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const visible = [...card.querySelectorAll('[data-chart-mode]:not([hidden])')];
        const idx = visible.indexOf(modeBtn);
        if (idx >= 0 && visible.length > 1) {
          event.preventDefault();
          const next = visible[(idx + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length];
          this._setMonitorChartMode(next.dataset.chartMode);
          next.focus();
        }
        return;
      }
      const linkCard = event.target.closest?.('[data-diagnostic-link]');
      if (linkCard && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        setFocus(linkCard.dataset.diagnosticLink, 1600);
      }
    });

    card.querySelectorAll('[data-diagnostic-link]').forEach(el => {
      const focus = el.dataset.diagnosticLink;
      el.addEventListener('mouseenter', () => setFocus(focus));
      el.addEventListener('mouseleave', () => setFocus(''));
      el.addEventListener('focus', () => setFocus(focus));
      el.addEventListener('blur', () => setFocus(''));
    });

    const stage = card.querySelector('[data-hero-chart-stage]');
    if (stage) {
      stage.addEventListener('dblclick', () => {
        this._setMonitorChartMode(this.monitorChartMode === 'full' ? 'window' : 'full');
      });
      const clearHover = () => {
        if (!wrap) return;
        wrap._hoverPointer = null;
        this._clearHeroChartHover(wrap);
      };
      stage.addEventListener('pointermove', event => {
        if (!wrap?._chartState) return;
        const rect = stage.getBoundingClientRect();
        if (!rect.width) return;
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const st = wrap._chartState;
        // 指针离开绘图区（例如移到左侧 Y 轴刻度或 X 轴下方留白）时立即收起游标。
        const stagePadL = Math.max(0, (rect.width - st.width) / 2);
        const svgX = x - stagePadL;
        if (st.mode !== 'epoch' && (svgX < st.padL - 8 || svgX > st.padL + st.plotW + 8 || y < st.padT - 8 || y > st.padT + st.plotH + 14)) {
          if (wrap.classList.contains('is-hovering')) clearHover();
          return;
        }
        wrap._hoverPointer = { xRatio: Math.max(0, Math.min(1, svgX / Math.max(1, st.width))), x: svgX, y };
        this._updateHeroChartHover(wrap, wrap._hoverPointer.xRatio, y);
      });
      stage.addEventListener('pointerleave', event => {
        const related = event.relatedTarget;
        if (related && wrap?.querySelector('[data-chart-preview-pop]')?.contains(related)) return;
        clearHover();
      });
      stage.addEventListener('mouseleave', event => {
        const related = event.relatedTarget;
        if (related && wrap?.querySelector('[data-chart-preview-pop]')?.contains(related)) return;
        clearHover();
      });
      stage.addEventListener('pointercancel', clearHover);
      const pop = wrap?.querySelector('[data-chart-preview-pop]');
      if (pop) {
        const img = pop.querySelector('img');
        const settlePreview = () => {
          if (img.getAttribute('src') === wrap._activePreviewEvent?.thumbUrl && wrap._chartState?.mode !== 'epoch') {
            this._syncPreviewPopImage(pop, img);
          }
        };
        img.addEventListener('load', settlePreview);
        img.addEventListener('error', settlePreview);
        pop.addEventListener('pointerleave', event => {
          const related = event.relatedTarget;
          if (related && stage.contains(related)) return;
          clearHover();
        });
        pop.addEventListener('mouseleave', event => {
          const related = event.relatedTarget;
          if (related && stage.contains(related)) return;
          clearHover();
        });
      }
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          if (!wrap?._lastRenderArgs) return;
          const nextW = Math.round(stage.clientWidth || 0);
          if (nextW > 80 && Math.abs(nextW - (wrap._renderedWidth || 0)) >= 4) {
            this._renderHeroChart(wrap, ...wrap._lastRenderArgs, { animateSwitch: false });
          }
        });
        ro.observe(stage);
      }
    }
  },

  // 连续 HSL 无级插值：按色相最短圆弧过渡，避免跨 0°/360° 红区时绕道出现紫色。
  _lerpHslColor(stops, value) {
    if (value <= stops[0].v) {
      const [h, s, l] = stops[0].hsl;
      return `hsl(${h} ${s}% ${l}%)`;
    }
    for (let i = 1; i < stops.length; i++) {
      if (value <= stops[i].v) {
        const a = stops[i - 1], b = stops[i];
        const ratio = Math.max(0, Math.min(1, (value - a.v) / Math.max(b.v - a.v, 1e-6)));
        const dh = ((b.hsl[0] - a.hsl[0] + 540) % 360) - 180;
        const h = (a.hsl[0] + dh * ratio + 360) % 360;
        const s = a.hsl[1] + (b.hsl[1] - a.hsl[1]) * ratio;
        const l = a.hsl[2] + (b.hsl[2] - a.hsl[2]) * ratio;
        return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
      }
    }
    const last = stops[stops.length - 1].hsl;
    return `hsl(${last[0]} ${last[1]}% ${last[2]}%)`;
  },

  _gaugeLightnessDelta() {
    const theme = typeof document !== 'undefined'
      ? document.documentElement?.getAttribute?.('data-theme')
      : '';
    return theme === 'light' ? -7 : 0;
  },

  _changeGaugeColor(changePct) {
    const dl = this._gaugeLightnessDelta();
    // 负向从中性灰平滑入翠绿（收敛好）；正向从中性灰平滑过琥珀、橙红到珊瑚红（反弹警告），不经过绿或紫。
    if (changePct < 0) {
      return this._lerpHslColor([
        { v: -4.5, hsl: [148, 66, 48 + dl] },
        { v: -2.0, hsl: [152, 58, 50 + dl] },
        { v: 0.0, hsl: [168, 12, 54 + dl] },
      ], changePct);
    }
    return this._lerpHslColor([
      { v: 0.0, hsl: [46, 12, 54 + dl] },
      { v: 1.8, hsl: [42, 82, 52 + dl] },
      { v: 3.0, hsl: [18, 84, 54 + dl] },
      { v: 6.0, hsl: [358, 78, 56 + dl] },
    ], changePct);
  },

  _volatilityGaugeColor(volPct) {
    const dl = this._gaugeLightnessDelta();
    // 越低越翠绿（平稳），4%~10% 平滑过渡到暖琥珀，10%~15%+ 按短弧过渡到珊瑚红（高波动）。
    return this._lerpHslColor([
      { v: 0.0, hsl: [148, 66, 48 + dl] },
      { v: 4.0, hsl: [142, 60, 48 + dl] },
      { v: 8.5, hsl: [42, 84, 52 + dl] },
      { v: 12.0, hsl: [12, 82, 54 + dl] },
      { v: 15.0, hsl: [358, 78, 56 + dl] },
    ], volPct);
  },

  _patchDiagnosticGauges(card, diagnostic, animate = false, motionContext = '') {
    const metrics = card.querySelector('.m-diagnostic-metrics');
    const hasValues = Number.isFinite(diagnostic.changePct) || Number.isFinite(diagnostic.volatilityPct);
    const readySameContext = metrics?.dataset.gaugeContext === motionContext && metrics?.dataset.gaugeReady === '1';
    if (metrics) {
      // 仅在实时训练的后续步数更新时启用过渡动画，避免刷新或首帧渲染时条色从默认态闪烁。
      metrics.classList.toggle('is-live-motion', Boolean(animate && readySameContext));
      if (hasValues) {
        metrics.dataset.gaugeContext = motionContext;
        metrics.dataset.gaugeReady = '1';
      } else {
        delete metrics.dataset.gaugeReady;
      }
    }

    // 1. 近期变化：零点居中对称平滑压缩尺（连续量程避免整数跳档）+ 无级连续语义色。
    const changePct = diagnostic.changePct;
    const changeGauge = card.querySelector('[data-gauge="change"]');
    if (changeGauge && Number.isFinite(changePct)) {
      const maxAbs = Math.max(10, Math.abs(changePct) * 1.25);
      const knee = 5;
      const denom = Math.log1p(maxAbs / knee);
      const norm = Math.sign(changePct) * (Math.log1p(Math.abs(changePct) / knee) / Math.max(denom, 1e-6));
      const pos = Math.max(2, Math.min(98, 50 + norm * 48));
      const fill = changeGauge.querySelector('[data-gauge-fill="change"]');
      if (fill) {
        const isNeg = changePct < -0.05;
        const isPos = changePct > 0.05;
        fill.classList.toggle('is-neg', isNeg);
        fill.classList.toggle('is-pos', isPos);
        const left = isNeg ? pos : 50;
        const width = isNeg || isPos ? Math.max(1.5, Math.abs(pos - 50)) : 0;
        fill.style.left = left.toFixed(1) + '%';
        fill.style.width = width.toFixed(1) + '%';
        fill.style.setProperty('--gauge-bar-color', this._changeGaugeColor(changePct));
      }
    }

    // 2. 波动程度：单向平滑胶囊条（连续量程避免整数跳档）+ 无级连续语义色。
    const volPct = diagnostic.volatilityPct;
    const volGauge = card.querySelector('[data-gauge="volatility"]');
    if (volGauge && Number.isFinite(volPct)) {
      const maxVol = Math.max(16, volPct * 1.25);
      const curPos = Math.max(2, Math.min(100, (volPct / maxVol) * 100));
      const fill = volGauge.querySelector('[data-gauge-fill="volatility"]');
      if (fill) {
        fill.style.width = curPos.toFixed(1) + '%';
        fill.style.setProperty('--gauge-bar-color', this._volatilityGaugeColor(volPct));
      }
    }
  },

  _previewMarkersForChart(d, totalSteps, totalEpochs, t = k => this.tMonitor(k)) {
    if (!this.previews?.length || typeof this._sampleDataModel !== 'function') return [];
    const model = this._sampleDataModel();
    if (!model?.batches?.length) return [];
    const out = [];
    for (const batch of model.batches) {
      const firstIdx = batch.indices[0];
      const rec = model.records[firstIdx];
      if (!rec) continue;
      const sample = rec.sample || {};
      const preview = rec.preview || {};
      const epoch = Number.isInteger(sample.epoch) && sample.epoch > 0 ? sample.epoch : null;
      let step = Number.isInteger(sample.step) && sample.step >= 0 ? sample.step : null;
      if (step === null && epoch !== null && totalSteps > 0 && totalEpochs > 0) {
        step = Math.round(epoch * (totalSteps / totalEpochs));
      }
      if (step === null && epoch === null) continue;
      const thumbUrl = preview.thumb_url || preview.url || '';
      const epochText = epoch !== null ? t('sampleEpoch').replace('{n}', epoch) : '';
      const stepText = step !== null ? t('sampleStep').replace('{n}', step) : '';
      const shortLabel = epochText && stepText ? `${epochText} (${stepText})` : (epochText || stepText);
      out.push({
        batchId: batch.id,
        firstIndex: firstIdx,
        label: shortLabel,
        step,
        epoch,
        thumbUrl,
      });
    }
    return out;
  },

  _downsampleHeroPoints(points, maxPoints = 200) {
    if (points.length <= maxPoints) return points;
    const buckets = Math.max(20, Math.floor(maxPoints / 2));
    const stride = (points.length - 2) / buckets;
    const result = [points[0]];
    for (let i = 0; i < buckets; i++) {
      const start = 1 + Math.floor(i * stride);
      const end = Math.min(points.length - 1, 1 + Math.floor((i + 1) * stride));
      if (start >= end) continue;
      let minPt = points[start], maxPt = points[start];
      for (let j = start + 1; j < end; j++) {
        if (points[j].value < minPt.value) minPt = points[j];
        if (points[j].value > maxPt.value) maxPt = points[j];
      }
      if (minPt === maxPt) result.push(minPt);
      else if (minPt.step <= maxPt.step) result.push(minPt, maxPt);
      else result.push(maxPt, minPt);
    }
    result.push(points[points.length - 1]);
    return result;
  },

  _lookupNearestByStep(points, targetStep) {
    if (!points?.length) return null;
    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].step < targetStep) lo = mid + 1;
      else hi = mid;
    }
    const curr = points[lo];
    const prev = lo > 0 ? points[lo - 1] : null;
    if (prev && Math.abs(prev.step - targetStep) <= Math.abs(curr.step - targetStep)) return prev;
    return curr;
  },

  _heroPathD(coords) {
    if (!coords || coords.length < 2) return '';
    return coords.map((c, i) => (i ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1)).join(' ');
  },

  _splitHeroCoordsAtX(coords, splitX) {
    if (!coords || coords.length < 2 || !Number.isFinite(splitX)) return { prev: [], recent: coords || [] };
    if (splitX <= coords[0].x) return { prev: [], recent: coords };
    if (splitX >= coords[coords.length - 1].x) return { prev: coords, recent: [] };
    const idx = coords.findIndex(c => c.x >= splitX);
    if (idx <= 0) return { prev: [], recent: coords };
    if (idx < coords.length - 1 && Math.abs(coords[idx].x - splitX) < 0.05) {
      return { prev: coords.slice(0, idx + 1), recent: coords.slice(idx) };
    }
    const a = coords[idx - 1];
    const b = coords[idx];
    const ratio = (splitX - a.x) / Math.max(b.x - a.x, 1e-6);
    const splitPt = { x: splitX, y: a.y + (b.y - a.y) * ratio };
    return {
      prev: [...coords.slice(0, idx), splitPt],
      recent: [splitPt, ...coords.slice(idx)],
    };
  },

  _patchHeroSeriesSvg(svg, m) {
    const q = sel => svg.querySelector(sel);
    const setAttrs = (el, attrs) => {
      if (!el) return;
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    };
    const showEl = (el, visible) => {
      if (!el) return;
      if (visible) el.removeAttribute('display');
      else el.setAttribute('display', 'none');
    };

    setAttrs(q('[data-hero-grid-top]'), { x1: m.padL, x2: m.padL + m.plotW, y1: m.padT, y2: m.padT });
    setAttrs(q('[data-hero-grid-mid]'), { x1: m.padL, x2: m.padL + m.plotW, y1: m.midY, y2: m.midY });
    setAttrs(q('[data-hero-grid-axis]'), { x1: m.padL, x2: m.padL + m.plotW, y1: m.padT + m.plotH, y2: m.padT + m.plotH });

    const fullBg = q('[data-hero-full-bg]');
    showEl(fullBg, m.showFullBg);
    if (m.showFullBg) {
      setAttrs(fullBg, {
        x: m.fullBgX.toFixed(1),
        y: m.padT,
        width: m.fullBgWidth.toFixed(1),
        height: m.plotH,
      });
    }

    const diffBand = q('[data-hero-diff-band]');
    showEl(diffBand, Boolean(m.diffBandD));
    if (m.diffBandD) setAttrs(diffBand, { d: m.diffBandD });

    const splitLine = q('[data-hero-split-line]');
    showEl(splitLine, m.showSplitLine);
    if (m.showSplitLine) {
      setAttrs(splitLine, { x1: m.splitX.toFixed(1), x2: m.splitX.toFixed(1), y1: m.padT, y2: m.padT + m.plotH });
    }

    const splitConn = q('[data-hero-split-conn]');
    showEl(splitConn, m.showSplitConn);
    if (m.showSplitConn) {
      setAttrs(splitConn, {
        x1: m.splitX.toFixed(1), x2: m.splitX.toFixed(1),
        y1: m.yPrev.toFixed(1), y2: m.yRec.toFixed(1),
      });
    }

    const prevMean = q('[data-hero-prev-mean]');
    const recMean = q('[data-hero-rec-mean]');
    const prevLabel = q('[data-hero-prev-label]');
    const recLabel = q('[data-hero-rec-label]');
    showEl(prevMean, m.showWindowMeans);
    showEl(recMean, m.showWindowMeans);
    showEl(prevLabel, m.showWindowMeans);
    showEl(recLabel, m.showWindowMeans);
    if (m.showWindowMeans) {
      const prevEndX = Math.max(m.padL + 4, m.splitX);
      const recEndX = m.padL + m.plotW;
      setAttrs(prevMean, { x1: m.padL.toFixed(1), x2: prevEndX.toFixed(1), y1: m.yPrev.toFixed(1), y2: m.yPrev.toFixed(1) });
      setAttrs(recMean, { x1: m.splitX.toFixed(1), x2: recEndX.toFixed(1), y1: m.yRec.toFixed(1), y2: m.yRec.toFixed(1) });
      setAttrs(prevLabel, { x: (m.padL + 3).toFixed(1), y: Math.max(m.padT + 9, m.yPrev - 4).toFixed(1) });
      if (prevLabel) prevLabel.textContent = m.prevMeanText;
      setAttrs(recLabel, { x: (recEndX - 3).toFixed(1), y: Math.max(m.padT + 9, m.yRec - 4).toFixed(1) });
      if (recLabel) recLabel.textContent = m.deltaText;
    }

    const prevPath = q('[data-hero-prev-path]');
    showEl(prevPath, Boolean(m.prevD));
    if (prevPath) {
      prevPath.setAttribute('class', m.prevPathClass);
      prevPath.setAttribute('d', m.prevD || '');
    }

    const lrPath = q('[data-hero-lr-path]');
    showEl(lrPath, Boolean(m.lrD));
    if (m.lrD) setAttrs(lrPath, { d: m.lrD });

    const mainPath = q('[data-hero-main-path]');
    showEl(mainPath, Boolean(m.recD));
    setAttrs(mainPath, { d: m.recD || '' });

    setAttrs(q('[data-hero-cal-ref]'), {
      x1: m.bestPt.x.toFixed(1), x2: m.latestPt.x.toFixed(1),
      y1: m.bestPt.y.toFixed(1), y2: m.bestPt.y.toFixed(1),
    });
    const showCalStem = m.calSpan >= 3;
    const calStem = q('[data-hero-cal-stem]');
    const calTopCap = q('[data-hero-cal-top]');
    const calBotCap = q('[data-hero-cal-bot]');
    showEl(calStem, showCalStem);
    showEl(calTopCap, showCalStem);
    showEl(calBotCap, showCalStem);
    if (showCalStem) {
      setAttrs(calStem, { x1: m.caliperX.toFixed(1), x2: m.caliperX.toFixed(1), y1: m.calTop.toFixed(1), y2: m.calBot.toFixed(1) });
      setAttrs(calTopCap, { x1: (m.caliperX - 3).toFixed(1), x2: (m.caliperX + 3).toFixed(1), y1: m.calTop.toFixed(1), y2: m.calTop.toFixed(1) });
      setAttrs(calBotCap, { x1: (m.caliperX - 3).toFixed(1), x2: (m.caliperX + 3).toFixed(1), y1: m.calBot.toFixed(1), y2: m.calBot.toFixed(1) });
    }
    setAttrs(q('[data-caliper-target]'), { cx: m.caliperX.toFixed(1), cy: m.calBot.toFixed(1) });
    const calText = q('[data-hero-cal-text]');
    setAttrs(calText, { x: (m.latestPt.x - 2).toFixed(1), y: m.calLabelY.toFixed(1) });
    if (calText) calText.textContent = m.gapText;

    setAttrs(q('[data-hero-best-gx]'), { x1: m.padL, x2: m.bestPt.x.toFixed(1), y1: m.bestPt.y.toFixed(1), y2: m.bestPt.y.toFixed(1) });
    setAttrs(q('[data-hero-best-gy]'), { x1: m.bestPt.x.toFixed(1), x2: m.bestPt.x.toFixed(1), y1: m.bestPt.y.toFixed(1), y2: (m.padT + m.plotH).toFixed(1) });
    setAttrs(q('[data-hero-best-ring]'), { cx: m.bestPt.x.toFixed(1), cy: m.bestPt.y.toFixed(1) });
    setAttrs(q('[data-hero-best-dot]'), { cx: m.bestPt.x.toFixed(1), cy: m.bestPt.y.toFixed(1) });
    setAttrs(q('[data-hero-best-callout]'), { x: m.bestTextX.toFixed(1), y: m.bestTextY.toFixed(1), 'text-anchor': m.bestAnchor });
    const bestValEl = q('[data-hero-best-val]');
    const bestStepEl = q('[data-hero-best-step]');
    if (bestValEl) bestValEl.textContent = m.bestValText;
    if (bestStepEl) bestStepEl.textContent = ' ' + m.bestStepText;

    const latestGroup = q('[data-hero-latest]');
    let pulse = q('[data-hero-latest-pulse]');
    if (m.isLiveRunning) {
      if (!pulse && latestGroup) {
        pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        pulse.setAttribute('class', 'm-latest-pulse');
        pulse.setAttribute('data-hero-latest-pulse', '');
        pulse.setAttribute('r', '6');
        latestGroup.insertBefore(pulse, latestGroup.firstChild);
      }
      setAttrs(pulse, { cx: m.latestPt.x.toFixed(1), cy: m.latestPt.y.toFixed(1) });
    } else if (pulse) {
      pulse.remove();
    }
    setAttrs(q('[data-hero-latest-dot]'), { cx: m.latestPt.x.toFixed(1), cy: m.latestPt.y.toFixed(1) });

    const eventsGroup = q('[data-hero-events]');
    if (eventsGroup) {
      const existing = Array.from(eventsGroup.children);
      m.events.forEach((ev, i) => {
        let el = existing[i];
        if (!el) {
          el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          el.setAttribute('class', 'm-chart-event-diamond');
          eventsGroup.appendChild(el);
        }
        setAttrs(el, {
          'data-event-idx': i,
          'data-preview-batch-id': ev.batchId,
          'data-preview-index': ev.firstIndex,
          d: `M${ev.x.toFixed(1)} ${(m.padT + m.plotH - 3).toFixed(1)} l3.2 3.2 -3.2 3.2 -3.2 -3.2 Z`,
        });
      });
      for (let i = m.events.length; i < existing.length; i++) existing[i].remove();
    }

    const axisHigh = q('[data-hero-axis-high]');
    const axisLow = q('[data-hero-axis-low]');
    const axisLrMax = q('[data-hero-axis-lrmax]');
    const axisLrMin = q('[data-hero-axis-lrmin]');
    const axisStart = q('[data-hero-axis-start]');
    const axisMid = q('[data-hero-axis-mid]');
    const axisEnd = q('[data-hero-axis-end]');
    if (axisHigh) { setAttrs(axisHigh, { x: m.padL - 6, y: m.padT + 4 }); axisHigh.textContent = m.highText; }
    if (axisLow) { setAttrs(axisLow, { x: m.padL - 6, y: m.padT + m.plotH + 1 }); axisLow.textContent = m.lowText; }
    showEl(axisLrMax, Boolean(m.lrMaxText));
    showEl(axisLrMin, Boolean(m.lrMinText));
    if (m.lrMaxText && axisLrMax) { setAttrs(axisLrMax, { x: m.padL + m.plotW - 4, y: m.padT + 10 }); axisLrMax.textContent = m.lrMaxText; }
    if (m.lrMinText && axisLrMin) { setAttrs(axisLrMin, { x: m.padL + m.plotW - 4, y: m.padT + m.plotH - 4 }); axisLrMin.textContent = m.lrMinText; }
    if (axisStart) { setAttrs(axisStart, { x: m.padL, y: m.height - 4 }); axisStart.textContent = m.startStepText; }
    showEl(axisMid, Boolean(m.splitStepText));
    if (m.splitStepText && axisMid) { setAttrs(axisMid, { x: m.splitX.toFixed(1), y: m.height - 4 }); axisMid.textContent = m.splitStepText; }
    if (axisEnd) { setAttrs(axisEnd, { x: m.padL + m.plotW, y: m.height - 4 }); axisEnd.textContent = m.endStepText; }

    setAttrs(q('[data-hover-line]'), { y1: m.padT, y2: m.padT + m.plotH });
  },

  _renderHeroChart(wrap, chart, d, isHistory, t, options = {}) {
    if (!wrap) return;
    wrap._lastRenderArgs = [chart, d, isHistory, t];
    const stage = wrap.querySelector('[data-hero-chart-stage]');
    const svg = wrap.querySelector('[data-hero-chart-svg]');
    if (!stage || !svg) return;

    const { mode, diagnostic, points: rawPrimary, best } = chart;
    if (wrap._chartState && wrap._chartState.mode !== mode) this._clearHeroChartHover(wrap);
    const { running } = this._summaryStatus(d, isHistory);
    const paused = !isHistory && running && this.controlState?.state === 'paused';
    const isLiveRunning = running && !paused;

    const width = Math.max(240, Math.round(stage.clientWidth || 500));
    const height = 152;
    wrap._renderedWidth = width;

    const padL = 46;
    const padR = 14;
    const padT = 12;
    const padB = 26;
    const plotW = Math.max(60, width - padL - padR);
    const plotH = Math.max(40, height - padT - padB);

    const totalSteps = Number(d.total_steps) || 0;
    const { totalEpochs } = this._parseEpochProgress ? this._parseEpochProgress(d, totalSteps, Number(d.step) || 0, false, 0) : { totalEpochs: 0 };
    const previewMarkersAll = this._previewMarkersForChart(d, totalSteps, totalEpochs, t);

    // ── Mode: 每轮（纯净渐变柱状图 + 聚光悬停，无折线/无杂点） ──
    if (mode === 'epoch') {
      if (svg.dataset) svg.dataset.heroScaffold = 'epoch';
      const epochPoints = rawPrimary;
      const vals = epochPoints.map(p => p.value);
      const bestIdx = epochPoints.indexOf(best);
      const minV = Math.min(...vals), maxV = Math.max(...vals);
      const padV = Math.max((maxV - minV) * 0.22, Math.abs(minV) * 0.08, 1e-6);
      const low = Math.max(0, minV - padV * 0.9), high = maxV + padV;
      const spanV = Math.max(high - low, 1e-9);
      const toY = v => padT + plotH - ((v - low) / spanV) * plotH;
      const count = epochPoints.length;
      const slot = plotW / count;
      const barW = Math.max(4, Math.min(22, slot * 0.58));
      const previewByEpoch = new Map();
      for (const m of previewMarkersAll) {
        if (m.epoch != null && !previewByEpoch.has(m.epoch)) previewByEpoch.set(m.epoch, m);
      }
      const coords = epochPoints.map((pt, idx) => {
        const ep = Math.round(pt.step);
        return {
          step: pt.step,
          epoch: ep,
          value: pt.value,
          prevValue: idx > 0 ? epochPoints[idx - 1].value : null,
          x: padL + slot * (idx + 0.5),
          y: toY(pt.value),
          isBest: idx === bestIdx,
          preview: previewByEpoch.get(ep) || null,
        };
      });
      const baseY = padT + plotH;
      const roundedTopBar = (x, y, w, h) => {
        const r = Math.min(3.5, w / 2, h);
        const right = x + w;
        const bot = y + h;
        return `M${x.toFixed(1)} ${bot.toFixed(1)} V${(y + r).toFixed(1)} Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + r).toFixed(1)} ${y.toFixed(1)} H${(right - r).toFixed(1)} Q${right.toFixed(1)} ${y.toFixed(1)} ${right.toFixed(1)} ${(y + r).toFixed(1)} V${bot.toFixed(1)} Z`;
      };
      const barGradId = 'm-ep-bar-' + (isHistory ? 'h' : 'l');
      const bestGradId = 'm-ep-best-' + (isHistory ? 'h' : 'l');
      const barsHtml = coords.map((c, idx) => {
        const h = Math.max(4, baseY - c.y);
        const x = c.x - barW / 2;
        const fillUrl = c.isBest ? `url(#${bestGradId})` : `url(#${barGradId})`;
        const isLatest = idx === coords.length - 1;
        return `<path class="m-epoch-bar${c.isBest ? ' is-best' : ''}${isLatest ? ' is-latest' : ''}" data-epoch-idx="${idx}" fill="${fillUrl}" d="${roundedTopBar(x, c.y, barW, h)}"/>`;
      }).join('');

      const bestC = coords[bestIdx];
      const bestValY = Math.max(padT + 9, bestC.y - 6);
      const midY = (padT + plotH / 2).toFixed(1);
      const midIdx = Math.floor((coords.length - 1) / 2);
      const midEpochLabel = coords.length >= 6
        ? `<text x="${coords[midIdx].x.toFixed(1)}" y="${height - 4}" text-anchor="middle">${this.esc(t('sampleEpoch').replace('{n}', coords[midIdx].epoch))}</text>`
        : '';

      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', String(width));
      svg.setAttribute('height', String(height));
      svg.innerHTML = `
        <defs>
          <linearGradient id="${barGradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--text-secondary)" stop-opacity=".55"/>
            <stop offset="100%" stop-color="var(--text-secondary)" stop-opacity=".16"/>
          </linearGradient>
          <linearGradient id="${bestGradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity=".95"/>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity=".35"/>
          </linearGradient>
        </defs>
        <g class="m-chart-grid">
          <line x1="${padL}" x2="${padL + plotW}" y1="${padT}" y2="${padT}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${midY}" y2="${midY}"/>
          <line x1="${padL}" x2="${padL + plotW}" y1="${baseY}" y2="${baseY}" class="is-axis"/>
        </g>
        <g class="m-chart-epoch-bars" data-epoch-bars>${barsHtml}</g>
        <text class="m-epoch-best-val" x="${bestC.x.toFixed(1)}" y="${bestValY.toFixed(1)}" text-anchor="middle">${this._formatDiagnosticValue(bestC.value)}</text>
        <g class="m-chart-axes">
          <text x="${padL - 6}" y="${padT + 4}" text-anchor="end">${this._formatDiagnosticValue(high)}</text>
          <text x="${padL - 6}" y="${baseY + 1}" text-anchor="end">${this._formatDiagnosticValue(low)}</text>
          <text x="${padL}" y="${height - 4}" text-anchor="start">${this.esc(t('sampleEpoch').replace('{n}', coords[0].epoch))}</text>
          ${midEpochLabel}
          <text x="${padL + plotW}" y="${height - 4}" text-anchor="end">${this.esc(t('sampleEpoch').replace('{n}', coords[coords.length - 1].epoch))}</text>
        </g>`;

      wrap.hidden = false;
      wrap.dataset.mode = 'epoch';
      wrap._chartState = {
        mode: 'epoch', width, height, padL, padR, padT, plotW, plotH,
        coords, events: [], t, indexLimit: Math.max(totalEpochs, coords.at(-1).epoch),
        defaultRange: t('epochAvgMeta').replace('{n}', count).replace('{best}', bestC.epoch),
      };
      this._setHeroHudDefault(wrap);
      if (options.animateSwitch && this._monitorMotionAllowed()) this._animateHeroEntrance(svg, 'epoch');
      if (wrap._hoverPointer) this._updateHeroChartHover(wrap, wrap._hoverPointer.xRatio, wrap._hoverPointer.y);
      return;
    }

    // ── Mode: 诊断窗口 (window) 或 全程 (full) ──
    const isFull = mode === 'full';
    if (rawPrimary.length < 2) {
      this._clearHeroChartHover(wrap);
      wrap.hidden = true;
      wrap._chartState = null;
      return;
    }

    const displayPrimary = isFull ? this._downsampleHeroPoints(rawPrimary, 200).slice() : rawPrimary;
    // 快照可能只保留抽样曲线；把区间内的原始最低点也画进折线。裁尾前的最低点单独标注。
    if (isFull && best.step >= displayPrimary[0].step && best.step <= displayPrimary.at(-1).step) {
      const at = displayPrimary.findIndex(point => point.step >= best.step);
      if (displayPrimary[at].step !== best.step) displayPrimary.splice(at, 0, best);
      else displayPrimary[at] = best;
    }
    const minStep = Math.min(best.step, displayPrimary[0].step);
    const maxStep = Math.max(displayPrimary[displayPrimary.length - 1].step, minStep + 1);
    const stepSpan = maxStep - minStep;
    const toX = step => padL + ((step - minStep) / stepSpan) * plotW;

    // 纵轴量程围绕主平滑曲线与均值自适应留白。
    const primaryVals = displayPrimary.map(p => p.value);
    let pLow = Math.min(best.value, ...primaryVals), pHigh = Math.max(...primaryVals);
    if (!isFull && Number.isFinite(diagnostic.previousMean) && Number.isFinite(diagnostic.recentMean)) {
      pLow = Math.min(pLow, diagnostic.previousMean, diagnostic.recentMean);
      pHigh = Math.max(pHigh, diagnostic.previousMean, diagnostic.recentMean);
    }
    const baseSpan = Math.max(pHigh - pLow, Math.abs(pHigh) * 0.08, 1e-6);
    const low = pLow - baseSpan * 0.18;
    const high = pHigh + baseSpan * 0.22;
    const spanV = Math.max(high - low, 1e-9);
    const toYUnclamped = v => padT + plotH - ((v - low) / spanV) * plotH;
    const toY = v => Math.max(padT + 1, Math.min(padT + plotH - 1, toYUnclamped(v)));

    // 主平滑曲线坐标
    const coords = displayPrimary.map(pt => ({ step: pt.step, value: pt.value, x: toX(pt.step), y: toY(pt.value) }));
    const smoothD = this._heroPathD(coords);

    // 紫色 LR 次坐标叠加曲线
    let lrD = '';
    let lrMaxText = '';
    let lrMinText = '';
    const lrPoints = this.monitorChartShowLr
      ? chart.lrPoints.filter(pt => pt.step >= minStep && pt.step <= maxStep)
      : [];
    let lrToY = null;
    if (lrPoints.length >= 2) {
      const lrDraw = this._downsampleHeroPoints(lrPoints, 120);
      const lrVals = lrDraw.map(p => p.value);
      const lrMin = Math.min(...lrVals), lrMax = Math.max(...lrVals);
      const lrPad = Math.max((lrMax - lrMin) * 0.14, Math.abs(lrMax) * 0.08, 1e-12);
      const lrLow = Math.max(0, lrMin - lrPad), lrHigh = lrMax + lrPad;
      const lrSpan = Math.max(lrHigh - lrLow, 1e-12);
      lrToY = v => padT + plotH - ((v - lrLow) / lrSpan) * plotH;
      lrD = lrDraw.map((p, i) => (i ? 'L' : 'M') + toX(p.step).toFixed(1) + ' ' + lrToY(p.value).toFixed(1)).join(' ');
      lrMaxText = this._formatLearningRate(lrMax, '');
      lrMinText = this._formatLearningRate(lrMin, '');
    }

    // 诊断窗口区间分区：中线精准落在前段末点与近段首点正中（锁定在 50% 位置），推进步数时绝不左右抖动。
    const rules = this._trainingDiagnosticRules();
    const hasWindowSplit = diagnostic.windowSize > 0 && Number.isFinite(diagnostic.previousMean) && Number.isFinite(diagnostic.recentMean);
    const isFullHistorySplit = isFull && hasWindowSplit && diagnostic.windowSize >= rules.windowMax && diagnostic.previousStartStep > minStep;
    const splitStep = hasWindowSplit ? (isFullHistorySplit ? diagnostic.previousStartStep : diagnostic.recentStartStep) : null;
    let splitX = null;
    if (!isFull && hasWindowSplit) {
      const prevEndPt = rawPrimary[diagnostic.windowSize - 1];
      const recStartPt = rawPrimary[diagnostic.windowSize];
      splitX = (prevEndPt && recStartPt)
        ? (toX(prevEndPt.step) + toX(recStartPt.step)) / 2
        : toX(diagnostic.recentStartStep);
    } else if (isFull && hasWindowSplit) {
      splitX = isFullHistorySplit
        ? toX(diagnostic.previousStartStep)
        : (toX(diagnostic.previousEndStep) + toX(diagnostic.recentStartStep)) / 2;
    }

    let prevD = '';
    let recD = smoothD;
    if (hasWindowSplit && splitX != null) {
      const splitSegs = this._splitHeroCoordsAtX(coords, splitX);
      prevD = this._heroPathD(splitSegs.prev);
      const splitRecD = this._heroPathD(splitSegs.recent);
      recD = prevD ? splitRecD : (splitRecD || smoothD);
    }
    const prevPathClass = 'm-chart-prev-line' + (isFullHistorySplit ? ' is-full' : '');

    const showWindowMeans = !isFull && hasWindowSplit && splitX != null;
    const showFullBg = isFullHistorySplit && splitX != null;
    const showSplitLine = hasWindowSplit && splitX != null;
    const fullBgWidth = showFullBg ? Math.min(plotW, Math.max(4, padL + plotW - splitX)) : 0;
    const fullBgX = showFullBg ? Math.max(padL, Math.min(splitX, padL + plotW - fullBgWidth)) : padL;
    let yPrev = 0;
    let yRec = 0;
    let diffBandD = '';
    let showSplitConn = false;
    let deltaText = '';
    if (showWindowMeans) {
      const recEndX = padL + plotW;
      yPrev = toY(diagnostic.previousMean);
      yRec = toY(diagnostic.recentMean);
      const bandTop = Math.min(yPrev, yRec);
      const bandBot = Math.max(yPrev, yRec);
      if (bandBot - bandTop >= 0.5) {
        diffBandD = `M${splitX.toFixed(1)} ${bandTop.toFixed(1)} H${recEndX.toFixed(1)} V${bandBot.toFixed(1)} H${splitX.toFixed(1)} Z`;
        showSplitConn = true;
      }
      deltaText = this._formatDiagnosticPercent(diagnostic.changePct, true);
    }

    // 最低点与最新点锚点 + 电子卡尺（悬停距最低值时显出）
    const bestPt = { ...best, x: toX(best.step), y: toY(best.value) };
    const latestPt = coords[coords.length - 1];
    const caliperX = padL + plotW + 12;
    const calTop = Math.min(bestPt.y, latestPt.y);
    const calBot = Math.max(bestPt.y, latestPt.y);
    const calMidY = (calTop + calBot) / 2;
    const calSpan = Math.abs(calBot - calTop);
    const gapText = this._formatDiagnosticPercent(this._lossGapPercent(latestPt.value, bestPt.value), true);
    const bestValText = this._formatDiagnosticValue(bestPt.value);
    const bestStepText = t('sampleStep').replace('{n}', Math.round(bestPt.step));
    // 无边框高对比度抠边文字标注，避免厚重方框遮挡曲线。
    const bestAlignRight = bestPt.x > padL + plotW - 84;
    const bestAlignLeft = bestPt.x < padL + 84;
    const bestAnchor = bestAlignRight ? 'end' : (bestAlignLeft ? 'start' : 'middle');
    const bestTextX = bestAlignRight ? Math.min(padL + plotW - 2, bestPt.x + 4) : (bestAlignLeft ? Math.max(padL + 2, bestPt.x - 4) : bestPt.x);
    // 最低点下方必然没有曲线经过，有空间时优先放下方完全避开折线谷壁。
    const bestTextY = bestPt.y <= padT + plotH - 15 ? bestPt.y + 14 : bestPt.y - 11;
    const calLabelY = calSpan >= 14
      ? Math.max(padT + 12, Math.min(padT + plotH - 4, calMidY + 3.5))
      : (latestPt.y > padT + 20 ? latestPt.y - 10 : latestPt.y + 16);

    // X 轴底边预览图事件菱形刻度
    const events = previewMarkersAll
      .filter(m => m.step != null && m.step >= minStep && m.step <= maxStep)
      .map(m => ({ ...m, x: toX(m.step) }));

    const midY = (padT + plotH / 2).toFixed(1);
    const highText = this._formatDiagnosticValue(high);
    const lowText = this._formatDiagnosticValue(low);
    const startStepText = t('sampleStep').replace('{n}', Math.round(minStep));
    const splitStepText = showWindowMeans
      ? t('sampleStep').replace('{n}', Math.round(diagnostic.recentStartStep))
      : '';
    const endStepText = t('sampleStep').replace('{n}', Math.round(maxStep));
    const prevMeanText = t('chartPrevMean');

    const historyFlag = isHistory ? '1' : '0';
    const cursorGradId = 'm-hero-cursor-' + (isHistory ? 'h' : 'l');
    const canPatch = !!(
      svg.dataset
      && svg.dataset.heroScaffold === 'series'
      && svg.dataset.heroHistory === historyFlag
      && typeof svg.querySelector === 'function'
      && svg.querySelector('[data-hero-main-path]')
      && typeof document?.createElementNS === 'function'
    );

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));

    if (canPatch) {
      this._patchHeroSeriesSvg(svg, {
        width, height, padL, padT, plotW, plotH, midY, isLiveRunning,
        splitX, showFullBg, fullBgX, fullBgWidth, showSplitLine, showWindowMeans, showSplitConn,
        yPrev, yRec, diffBandD, prevMeanText, deltaText,
        prevD, prevPathClass, recD, lrD,
        bestPt, latestPt, caliperX, calTop, calBot, calSpan, calLabelY, gapText,
        bestValText, bestStepText, bestAnchor, bestTextX, bestTextY,
        events, highText, lowText, lrMaxText, lrMinText,
        startStepText, splitStepText, endStepText,
      });
    } else {
      const prevEndX = splitX != null ? Math.max(padL + 4, splitX) : padL + 4;
      const recEndX = padL + plotW;
      const splitXStr = (splitX != null ? splitX : padL).toFixed(1);
      const eventsHtml = events.map((ev, i) =>
        `<path class="m-chart-event-diamond" data-event-idx="${i}" data-preview-batch-id="${this.esc(ev.batchId)}" data-preview-index="${ev.firstIndex}" d="M${ev.x.toFixed(1)} ${(padT + plotH - 3).toFixed(1)} l3.2 3.2 -3.2 3.2 -3.2 -3.2 Z"/>`
      ).join('');
      const calStemAttrs = calSpan >= 3 ? '' : ' display="none"';

      svg.innerHTML = `
        <defs>
          <linearGradient id="${cursorGradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--text-secondary)" stop-opacity=".06"/>
            <stop offset="35%" stop-color="var(--text-secondary)" stop-opacity=".38"/>
            <stop offset="75%" stop-color="var(--text-secondary)" stop-opacity=".38"/>
            <stop offset="100%" stop-color="var(--text-secondary)" stop-opacity=".08"/>
          </linearGradient>
        </defs>
        <g class="m-chart-grid">
          <line data-hero-grid-top x1="${padL}" x2="${padL + plotW}" y1="${padT}" y2="${padT}"/>
          <line data-hero-grid-mid x1="${padL}" x2="${padL + plotW}" y1="${midY}" y2="${midY}"/>
          <line data-hero-grid-axis x1="${padL}" x2="${padL + plotW}" y1="${padT + plotH}" y2="${padT + plotH}" class="is-axis"/>
        </g>
        <g class="m-chart-plot-series" data-hero-series>
          <g class="m-chart-overlays" data-hero-overlays>
            <rect class="m-full-window-bg" data-hero-full-bg x="${fullBgX.toFixed(1)}" y="${padT}" width="${fullBgWidth.toFixed(1)}" height="${plotH}"${showFullBg ? '' : ' display="none"'}/>
            <path class="m-window-diff-band" data-hero-diff-band d="${diffBandD}"${diffBandD ? '' : ' display="none"'}/>
            <line class="m-window-split" data-hero-split-line x1="${splitXStr}" x2="${splitXStr}" y1="${padT}" y2="${padT + plotH}"${showSplitLine ? '' : ' display="none"'}/>
            <line class="m-window-split-connector" data-hero-split-conn x1="${splitXStr}" x2="${splitXStr}" y1="${yPrev.toFixed(1)}" y2="${yRec.toFixed(1)}"${showSplitConn ? '' : ' display="none"'}/>
            <line class="m-window-mean is-prev" data-hero-prev-mean x1="${padL.toFixed(1)}" x2="${prevEndX.toFixed(1)}" y1="${yPrev.toFixed(1)}" y2="${yPrev.toFixed(1)}"${showWindowMeans ? '' : ' display="none"'}/>
            <line class="m-window-mean is-recent" data-hero-rec-mean x1="${splitXStr}" x2="${recEndX.toFixed(1)}" y1="${yRec.toFixed(1)}" y2="${yRec.toFixed(1)}"${showWindowMeans ? '' : ' display="none"'}/>
            <text class="m-window-mean-label is-prev" data-hero-prev-label x="${(padL + 3).toFixed(1)}" y="${Math.max(padT + 9, yPrev - 4).toFixed(1)}"${showWindowMeans ? '' : ' display="none"'}>${this.esc(prevMeanText)}</text>
            <text class="m-window-mean-label is-recent" data-hero-rec-label x="${(recEndX - 3).toFixed(1)}" y="${Math.max(padT + 9, yRec - 4).toFixed(1)}" text-anchor="end"${showWindowMeans ? '' : ' display="none"'}>${this.esc(deltaText)}</text>
          </g>
          <path class="${prevPathClass}" data-hero-prev-path d="${prevD}"${prevD ? '' : ' display="none"'}/>
          <path class="m-chart-lr-line" data-hero-lr-path d="${lrD}"${lrD ? '' : ' display="none"'}/>
          <path class="m-chart-smooth-line" data-hero-main-path d="${recD}"${recD ? '' : ' display="none"'}/>
        </g>
        <g class="m-chart-caliper">
          <line class="m-caliper-ref" data-hero-cal-ref x1="${bestPt.x.toFixed(1)}" x2="${latestPt.x.toFixed(1)}" y1="${bestPt.y.toFixed(1)}" y2="${bestPt.y.toFixed(1)}"/>
          <line class="m-caliper-stem" data-hero-cal-stem x1="${caliperX.toFixed(1)}" x2="${caliperX.toFixed(1)}" y1="${calTop.toFixed(1)}" y2="${calBot.toFixed(1)}"${calStemAttrs}/>
          <line class="m-caliper-cap" data-hero-cal-top x1="${(caliperX - 3).toFixed(1)}" x2="${(caliperX + 3).toFixed(1)}" y1="${calTop.toFixed(1)}" y2="${calTop.toFixed(1)}"${calStemAttrs}/>
          <line class="m-caliper-cap" data-hero-cal-bot x1="${(caliperX - 3).toFixed(1)}" x2="${(caliperX + 3).toFixed(1)}" y1="${calBot.toFixed(1)}" y2="${calBot.toFixed(1)}"${calStemAttrs}/>
          <circle class="m-caliper-target" data-caliper-target cx="${caliperX.toFixed(1)}" cy="${calBot.toFixed(1)}" r="2"/>
          <text class="m-caliper-text" data-hero-cal-text x="${(latestPt.x - 2).toFixed(1)}" y="${calLabelY.toFixed(1)}" text-anchor="end">${this.esc(gapText)}</text>
        </g>
        <g class="m-chart-best-anchor">
          <g class="m-best-guides">
            <line data-hero-best-gx x1="${padL}" x2="${bestPt.x.toFixed(1)}" y1="${bestPt.y.toFixed(1)}" y2="${bestPt.y.toFixed(1)}"/>
            <line data-hero-best-gy x1="${bestPt.x.toFixed(1)}" x2="${bestPt.x.toFixed(1)}" y1="${bestPt.y.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}"/>
          </g>
          <circle class="m-best-ring" data-hero-best-ring cx="${bestPt.x.toFixed(1)}" cy="${bestPt.y.toFixed(1)}" r="8"/>
          <circle class="m-best-dot" data-hero-best-dot cx="${bestPt.x.toFixed(1)}" cy="${bestPt.y.toFixed(1)}" r="3.4"/>
          <text class="m-best-callout" data-hero-best-callout x="${bestTextX.toFixed(1)}" y="${bestTextY.toFixed(1)}" text-anchor="${bestAnchor}">
            <tspan class="is-val" data-hero-best-val>${this.esc(bestValText)}</tspan><tspan class="is-step" data-hero-best-step> ${this.esc(bestStepText)}</tspan>
          </text>
        </g>
        <g class="m-chart-latest" data-hero-latest>
          ${isLiveRunning ? `<circle class="m-latest-pulse" data-hero-latest-pulse cx="${latestPt.x.toFixed(1)}" cy="${latestPt.y.toFixed(1)}" r="6"/>` : ''}
          <circle class="m-latest-dot" data-hero-latest-dot cx="${latestPt.x.toFixed(1)}" cy="${latestPt.y.toFixed(1)}" r="3"/>
        </g>
        <g class="m-chart-events" data-hero-events>${eventsHtml}</g>
        <g class="m-chart-axes">
          <text data-hero-axis-high x="${padL - 6}" y="${padT + 4}" text-anchor="end">${highText}</text>
          <text data-hero-axis-low x="${padL - 6}" y="${padT + plotH + 1}" text-anchor="end">${lowText}</text>
          <text class="is-lr" data-hero-axis-lrmax x="${padL + plotW - 4}" y="${padT + 10}" text-anchor="end"${lrMaxText ? '' : ' display="none"'}>${lrMaxText}</text>
          <text class="is-lr" data-hero-axis-lrmin x="${padL + plotW - 4}" y="${padT + plotH - 4}" text-anchor="end"${lrMinText ? '' : ' display="none"'}>${lrMinText}</text>
          <text data-hero-axis-start x="${padL}" y="${height - 4}" text-anchor="start">${this.esc(startStepText)}</text>
          <text data-hero-axis-mid x="${splitXStr}" y="${height - 4}" text-anchor="middle"${splitStepText ? '' : ' display="none"'}>${this.esc(splitStepText)}</text>
          <text data-hero-axis-end x="${padL + plotW}" y="${height - 4}" text-anchor="end">${this.esc(endStepText)}</text>
        </g>
        <g class="m-chart-hover" data-chart-hover display="none">
          <line class="m-chart-crosshair" data-hover-line y1="${padT}" y2="${padT + plotH}" stroke="url(#${cursorGradId})"/>
          <circle class="m-hover-dot is-lr" data-hover-dot="lr" r="2.8" display="none"/>
          <circle class="m-hover-dot is-smooth" data-hover-dot="smooth" r="3.2" display="none"/>
        </g>`;
      if (svg.dataset) {
        svg.dataset.heroScaffold = 'series';
        svg.dataset.heroHistory = historyFlag;
      }
    }

    wrap.hidden = false;
    wrap.dataset.mode = mode;
    wrap._chartState = {
      mode, width, height, padL, padR, padT, plotW, plotH,
      coords: best.step < coords[0].step ? [bestPt, ...coords] : coords, minStep, stepSpan, lrLookup: lrPoints,
      seriesLabel: t(chart.primaryIsAvg ? 'chartSeriesSmooth' : 'currentLoss'), lrToY, events, t,
      indexLimit: Math.max(totalSteps, maxStep),
      defaultRange: '',
      splitX,
      splitStep,
      hasPrevSegment: Boolean(prevD),
      isFullHistorySplit,
    };
    this._setHeroHudDefault(wrap);
    if (options.animateSwitch && this._monitorMotionAllowed()) this._animateHeroEntrance(svg, mode);
    if (wrap._hoverPointer) this._updateHeroChartHover(wrap, wrap._hoverPointer.xRatio, wrap._hoverPointer.y);
    if (wrap.dataset.focus) {
      const card = wrap.closest?.('.m-training-diagnostics');
      if (card) this._paintDiagnosticConnector(card, wrap.dataset.focus);
    }
  },

  _animateHeroEntrance(svg, mode) {
    if (mode === 'epoch') {
      const bars = svg.querySelectorAll('.m-epoch-bar');
      bars.forEach((bar, i) => {
        bar.animate?.(
          [{ transform: 'scaleY(0.15)', opacity: 0.35 }, { transform: 'scaleY(1)', opacity: 1 }],
          { duration: 220, delay: Math.min(i * 9, 110), easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
        );
      });
      return;
    }
    const seriesGroup = svg.querySelector('[data-hero-series]');
    seriesGroup?.animate?.(
      [{ clipPath: 'inset(0 100% 0 0)', opacity: 0.45 }, { clipPath: 'inset(0 0% 0 0)', opacity: 1 }],
      { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
  },

  _setHeroHudDefault(wrap) {
    const state = wrap._chartState;
    const rangeEl = wrap.querySelector('[data-chart-hud-range]');
    const readEl = wrap.querySelector('[data-chart-hud-readout]');
    if (rangeEl) rangeEl.textContent = state?.defaultRange || '';
    if (readEl) readEl.innerHTML = '';
  },

  _epochDeltaText(point) {
    if (!Number.isFinite(point.prevValue) || Math.abs(point.prevValue) <= 1e-12) return '';
    return this._formatDiagnosticPercent((point.value - point.prevValue) / Math.abs(point.prevValue) * 100, true);
  },

  _sizeHeroHud(readout, state) {
    // Only size values that can actually be selected, once per rendered chart.
    let loss = 0, lr = 0, delta = 0;
    for (const point of state.coords) {
      loss = Math.max(loss, this._formatDiagnosticValue(point.value).length);
      if (state.mode === 'epoch') delta = Math.max(delta, this._epochDeltaText(point).length);
      else if (state.lrToY) {
        const nearest = this._lookupNearestByStep(state.lrLookup, point.step);
        lr = Math.max(lr, this._formatLearningRate(nearest.value, '—').length);
      }
    }
    readout.style.setProperty('--m-index-slot', String(Math.round(state.indexLimit)).length + 'ch');
    readout.style.setProperty('--m-loss-slot', loss + 'ch');
    readout.style.setProperty('--m-lr-slot', lr + 'ch');
    readout.style.setProperty('--m-delta-slot', delta + 'ch');
    state.hudSized = true;
  },

  _updateHeroChartHover(wrap, xRatio, pointerY = null) {
    const state = wrap._chartState;
    if (!state || !state.coords.length) return;
    const svg = wrap.querySelector('[data-hero-chart-svg]');
    if (!svg) return;

    const targetX = xRatio * state.width;
    const fraction = (targetX - state.padL) / state.plotW;
    const activeIdx = Math.min(state.coords.length - 1, Math.max(0, Math.floor(fraction * state.coords.length)));
    const nearest = state.mode === 'epoch' ? state.coords[activeIdx]
      : this._lookupNearestByStep(state.coords, state.minStep + fraction * state.stepSpan);
    if (state.hovered === nearest) {
      if (state.mode !== 'epoch') this._updateHeroPreviewPop(wrap, state, targetX, pointerY);
      return;
    }
    state.hovered = nearest;

    wrap.classList.add('is-hovering');
    const readEl = wrap.querySelector('[data-chart-hud-readout]');
    if (readEl && !state.hudSized) this._sizeHeroHud(readEl, state);
    const stage = wrap.querySelector('[data-hero-chart-stage]');
    const t = state.t;

    if (state.mode === 'epoch') {
      const barsGroup = svg.querySelector('[data-epoch-bars]');
      barsGroup?.classList.add('has-hover');
      svg.querySelectorAll('.m-epoch-bar.is-hovered').forEach(el => el.classList.remove('is-hovered'));
      svg.querySelector(`.m-epoch-bar[data-epoch-idx="${activeIdx}"]`)?.classList.add('is-hovered');
      wrap._activePreviewEvent = nearest.preview || null;
      stage?.classList.toggle('has-preview-snap', !!nearest.preview);
      if (readEl) {
        const delta = this._epochDeltaText(nearest);
        const deltaText = this.esc(t('epochDeltaPrev')).replace('{delta}', `<span class="m-hud-percent">${delta}</span>`);
        readEl.innerHTML = `<span class="m-hud-step">${this.esc(t('epoch'))} <span class="m-hud-index">${nearest.epoch}</span></span>`
          + `<span class="m-hud-item is-epoch"><i></i><em>${this.esc(t('chartSeriesSmooth'))}</em> <span class="m-hud-value">${this._formatDiagnosticValue(nearest.value)}</span></span>`
          + `<span class="m-hud-delta${delta ? '' : ' is-empty'}">${deltaText}</span>`
          + (nearest.preview ? `<span class="m-hud-hint">${this.esc(t('chartEpochClickSample'))}</span>` : '');
      }
      return;
    }

    const hoverGroup = svg.querySelector('[data-chart-hover]');
    if (!hoverGroup) return;
    hoverGroup.removeAttribute('display');
    const line = hoverGroup.querySelector('[data-hover-line]');
    if (line) { line.setAttribute('x1', nearest.x.toFixed(1)); line.setAttribute('x2', nearest.x.toFixed(1)); }
    const smoothDot = hoverGroup.querySelector('[data-hover-dot="smooth"]');
    const lrDot = hoverGroup.querySelector('[data-hover-dot="lr"]');

    const parts = [`<span class="m-hud-step">${this.esc(t('stepLabel'))} <span class="m-hud-index">${Math.round(nearest.step)}</span></span>`];
    if (smoothDot) {
      smoothDot.setAttribute('cx', nearest.x.toFixed(1));
      smoothDot.setAttribute('cy', nearest.y.toFixed(1));
      smoothDot.removeAttribute('display');
      const isPrevSeg = Boolean(state.hasPrevSegment && Number.isFinite(state.splitStep) && nearest.step < state.splitStep);
      const isFullSeg = isPrevSeg && Boolean(state.isFullHistorySplit);
      smoothDot.classList?.toggle('is-prev-seg', isPrevSeg);
      smoothDot.classList?.toggle('is-full-seg', isFullSeg);
      const hudSmoothClass = 'm-hud-item is-smooth' + (isPrevSeg ? ' is-prev-seg' : '') + (isFullSeg ? ' is-full-seg' : '');
      parts.push(`<span class="${hudSmoothClass}"><i></i><em>${this.esc(state.seriesLabel)}</em> <span class="m-hud-value">${this._formatDiagnosticValue(nearest.value)}</span></span>`);
    }
    const hasLr = state.lrToY && nearest.step >= state.lrLookup[0].step && nearest.step <= state.lrLookup.at(-1).step;
    const lrPt = hasLr ? this._lookupNearestByStep(state.lrLookup, nearest.step) : null;
    if (lrPt) {
      const ly = state.lrToY(lrPt.value);
      if (lrDot) {
        lrDot.setAttribute('cx', nearest.x.toFixed(1));
        lrDot.setAttribute('cy', ly.toFixed(1));
        lrDot.removeAttribute('display');
      }
      parts.push(`<span class="m-hud-item is-lr"><i></i><em>${this.esc(t('chartSeriesLr'))}</em> <span class="m-hud-value">${this._formatLearningRate(lrPt.value, '—')}</span></span>`);
    } else {
      lrDot?.setAttribute('display', 'none');
    }
    if (readEl) readEl.innerHTML = parts.join('');

    // 仅当指针落到底部预览节点刻度区时才弹出完整预览浮层，浏览曲线时绝不打扰。
    this._updateHeroPreviewPop(wrap, state, targetX, pointerY);
  },

  _updateHeroPreviewPop(wrap, state, targetX, pointerY = null) {
    const nearEventRail = pointerY !== null && pointerY >= state.padT + state.plotH - 12 && pointerY <= state.padT + state.plotH + 14;
    if ((!nearEventRail || !state.events?.length) && !wrap._activePreviewEvent) return;
    const pop = wrap.querySelector('[data-chart-preview-pop]');
    const svg = wrap.querySelector('[data-hero-chart-svg]');
    const stage = wrap.querySelector('[data-hero-chart-stage]');
    if (!pop || !svg || !stage) return;
    svg.querySelectorAll('.m-chart-event-diamond.is-active').forEach(el => el.classList.remove('is-active'));
    if (!state.events?.length || !nearEventRail) {
      pop.hidden = true;
      wrap._activePreviewEvent = null;
      stage.classList.remove('has-preview-snap');
      return;
    }
    let bestEv = null, bestIdx = -1, bestDist = 11;
    state.events.forEach((ev, idx) => {
      const dist = Math.abs(ev.x - targetX);
      if (dist <= bestDist) { bestDist = dist; bestEv = ev; bestIdx = idx; }
    });
    if (!bestEv || !bestEv.thumbUrl) {
      pop.hidden = true;
      wrap._activePreviewEvent = null;
      stage.classList.remove('has-preview-snap');
      return;
    }
    wrap._activePreviewEvent = bestEv;
    stage.classList.add('has-preview-snap');
    svg.querySelector(`.m-chart-event-diamond[data-event-idx="${bestIdx}"]`)?.classList.add('is-active');
    const img = pop.querySelector('img');
    if (img.getAttribute('src') !== bestEv.thumbUrl) img.setAttribute('src', bestEv.thumbUrl);
    const titleEl = pop.querySelector('[data-preview-pop-title]');
    if (titleEl && titleEl.textContent !== bestEv.label) {
      titleEl.textContent = bestEv.label;
      titleEl.closest('strong').title = bestEv.label;
    }
    pop.dataset.batchId = bestEv.batchId;
    pop.dataset.firstIndex = String(bestEv.firstIndex);

    // 使用 fixed 坐标突破卡片裁剪边界，完整按原图比例展示，绝不切头切尾。
    const svgRect = svg.getBoundingClientRect();
    const popWidth = 210;
    const anchorX = svgRect.left + bestEv.x;
    const anchorY = svgRect.top + state.padT + state.plotH - 8;
    const clampedX = Math.max(popWidth / 2 + 12, Math.min((window.innerWidth || 1440) - popWidth / 2 - 12, anchorX));
    pop.style.left = clampedX.toFixed(1) + 'px';
    pop.style.top = Math.max(12, anchorY).toFixed(1) + 'px';
    this._syncPreviewPopImage(pop, img);
  },

  _syncPreviewPopImage(pop, img) {
    // Settle before showing. A failed thumbnail still has a usable samples link.
    img.parentElement.hidden = !img.naturalWidth;
    pop.hidden = !img.complete;
  },

  _clearHeroChartHover(wrap) {
    if (wrap._chartState) wrap._chartState.hovered = null;
    wrap.classList?.remove('is-hovering');
    wrap._activePreviewEvent = null;
    wrap.querySelector('[data-hero-chart-stage]')?.classList?.remove('has-preview-snap');
    const svg = wrap.querySelector('[data-hero-chart-svg]');
    const hoverGroup = svg?.querySelector?.('[data-chart-hover]');
    if (hoverGroup) {
      hoverGroup.setAttribute('display', 'none');
      hoverGroup.querySelectorAll?.('[data-hover-dot]')?.forEach(el => el.setAttribute('display', 'none'));
    }
    svg?.querySelector?.('[data-epoch-bars]')?.classList?.remove('has-hover');
    svg?.querySelectorAll?.('.m-epoch-bar.is-hovered')?.forEach(el => el.classList.remove('is-hovered'));
    svg?.querySelectorAll?.('.m-chart-event-diamond.is-active')?.forEach(el => el.classList.remove('is-active'));
    const pop = wrap.querySelector('[data-chart-preview-pop]');
    if (pop) pop.hidden = true;
    this._setHeroHudDefault(wrap);
  },

  _patchTrainingDiagnostics(root, t, d, isHistory, options = {}) {
    const isPreviousRun = !isHistory && this._summaryStatus(d, isHistory).terminal;
    const context = isHistory ? 'history' : (isPreviousRun ? 'previous' : 'live');
    const mode = this.monitorChartMode || 'window';
    const version = [
      this.lossDataVersion, this.previewsVersion, this._shellLocale || '', context,
      mode, !!this.monitorChartShowLr, !isHistory && this.controlState?.state === 'paused',
      d.total_steps, d.epoch, this.trainParamsVersion, root.dataset.motionContext,
    ].join(':');
    if (root.dataset.diagnosticVersion === version) return;
    root.dataset.diagnosticVersion = version;

    const card = root.querySelector('.m-training-diagnostics');
    if (!card) return;
    this._bindDiagnosticInteractions(card);

    const windowPoints = this._trainingDiagnosticPoints();
    const diagnostic = this._trainingDiagnostics(windowPoints);
    const seriesSet = this._allPrimaryLossSeries();
    const epochPoints = this._cleanLossPoints(seriesSet.epoch?.points);
    const hasEpoch = epochPoints.length >= 2;
    const lrSource = seriesSet.lr?.points || seriesSet.lr?.diagnostic_points || [];
    const lrPoints = this.monitorChartShowLr ? this._cleanLossPoints(lrSource) : [];
    const hasLr = lrSource.length >= 2;
    const activeMode = (mode === 'epoch' && !hasEpoch) ? 'window' : mode;
    const hasPlotData = windowPoints.length >= 2 || hasEpoch;

    const motionContext = root.dataset.motionContext || '';
    const hasDiagnosticTone = diagnostic.code !== 'insufficient';
    const toneReadySameContext = card.dataset.toneContext === motionContext && card.dataset.toneReady === '1';
    // 仅在相同上下文且已首帧着色的后续实时更新时开启变色过渡，避免刷新或异步首帧拉取时灰→彩闪烁。
    card.classList?.toggle('is-live-motion', Boolean(root._metricMotion && toneReadySameContext && hasDiagnosticTone));
    if (hasDiagnosticTone) {
      card.dataset.toneContext = motionContext;
      card.dataset.toneReady = '1';
    } else {
      delete card.dataset.toneReady;
    }

    card.dataset.diagnosticState = diagnostic.code;
    card.dataset.diagnosticTone = diagnostic.tone;

    const modeGroup = card.querySelector('.m-chart-modes');
    if (modeGroup) modeGroup.hidden = !hasPlotData;
    card.querySelectorAll('[data-chart-mode]').forEach(btn => {
      const m = btn.dataset.chartMode;
      if (m === 'epoch') btn.hidden = !hasEpoch;
      const active = m === activeMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const layerGroup = card.querySelector('[data-chart-layers]');
    if (layerGroup) {
      const lrBtn = layerGroup.querySelector('[data-chart-layer="lr"]');
      const showLr = hasPlotData && activeMode !== 'epoch' && hasLr;
      layerGroup.hidden = !showLr;
      if (lrBtn) {
        lrBtn.hidden = !showLr;
        const pressed = !!this.monitorChartShowLr;
        lrBtn.classList.toggle('is-active', pressed);
        lrBtn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      }
    }

    const metrics = card.querySelector('.m-diagnostic-metrics');
    if (metrics) metrics.hidden = diagnostic.code === 'insufficient';

    const setText = (field, value) => {
      const element = card.querySelector('[data-diagnostic-field="' + field + '"]');
      if (element) {
        if (['change', 'volatility', 'best', 'gap'].includes(field)) this._patchMonitorNumber(element, value, root._metricMotion);
        else if (element.textContent !== String(value)) element.textContent = value;
      }
    };
    setText('title', isPreviousRun ? t('previousTrainingDiagnostics') : t('trainingDiagnostics'));
    const verdict = card.querySelector('.m-diagnostic-verdict');
    if (verdict) verdict.dataset.diagnosticTone = diagnostic.tone;
    setText('state', this._diagnosticText(t, diagnostic.code, 'label'));
    setText('summary', this._diagnosticText(t, diagnostic.code, 'summary'));
    setText('evidence', this._diagnosticEvidence(t, diagnostic));
    setText('window-evidence', this._diagnosticWindowEvidence(t, diagnostic));
    // 最低 Loss 与距最低值随当前视图模式（诊断窗口 / 全程 / 每轮）同步切换，保证与图上锚点和连线 100% 一致。
    let bestLabel = t('bestLoss');
    let bestVal = diagnostic.bestValue;
    let bestMeta = diagnostic.bestStep == null ? t('bestObservedValue') : t('atStep').replace('{n}', Math.round(diagnostic.bestStep));
    let gapVal = diagnostic.gapFromBestPct;
    let gapMetaKeyAtBest = 'gapAtBest';
    let gapMetaKeyAbove = 'gapHintShort';
    let points = diagnostic.windowSize ? windowPoints.slice(-2 * diagnostic.windowSize) : windowPoints;
    let best = { step: diagnostic.bestStep, value: diagnostic.bestValue };
    if (activeMode !== 'window') {
      const epochMode = activeMode === 'epoch';
      const series = seriesSet.primary;
      points = epochMode ? epochPoints : this._cleanLossPoints(series?.points || series?.diagnostic_points);
      best = this._lowestLossPoint(points);
      if (!epochMode && best && Number.isFinite(series.min_step) && Number.isFinite(series.min)
          && series.min <= best.value && series.min_step <= points.at(-1).step) {
        best = { step: series.min_step, value: series.min };
      }
      if (best) {
        bestLabel = t(epochMode ? 'bestLossEpoch' : 'bestLossFull');
        bestVal = best.value;
        bestMeta = t(epochMode ? 'atEpoch' : 'atStep').replace('{n}', Math.round(best.step));
        gapVal = this._lossGapPercent(points.at(-1).value, best.value);
        gapMetaKeyAtBest = epochMode ? 'gapAtBestEpoch' : 'gapAtBestFull';
        gapMetaKeyAbove = epochMode ? 'gapHintEpoch' : 'gapHintFull';
      }
    }

    setText('change', this._formatDiagnosticPercent(diagnostic.changePct, true));
    setText('volatility', this._formatDiagnosticPercent(diagnostic.volatilityPct, false));
    setText('best-label', bestLabel);
    setText('best', this._formatDiagnosticValue(bestVal));
    setText('gap', this._formatDiagnosticPercent(gapVal, true));

    const changeMeta = diagnostic.windowSize
      ? this._fillDiagnosticTemplate(t('diagnosticWindowShort'), {
        n: diagnostic.windowSize,
        start: Math.round(diagnostic.recentStartStep),
        end: Math.round(diagnostic.recentEndStep),
      })
      : t('needsMorePoints');
    setText('change-meta', changeMeta);
    setText('volatility-meta', diagnostic.windowSize ? t('recentWindowPoints').replace('{n}', diagnostic.windowSize) : t('lowerIsMoreStable'));
    setText('best-meta', bestMeta);
    const isAtBest = Number.isFinite(gapVal) && Math.abs(gapVal) < 0.05;
    setText('gap-meta', t(isAtBest ? gapMetaKeyAtBest : gapMetaKeyAbove));

    const changeMetric = card.querySelector('[data-diagnostic-metric="change"]');
    const volatilityMetric = card.querySelector('[data-diagnostic-metric="volatility"]');
    const gapMetric = card.querySelector('[data-diagnostic-metric="gap"]');
    const rules = this._trainingDiagnosticRules();
    if (changeMetric) changeMetric.dataset.tone = diagnostic.changePct == null ? 'muted' : (diagnostic.changePct <= rules.convergingChange ? 'ok' : (diagnostic.changePct >= rules.reboundChange ? 'danger' : 'neutral'));
    if (volatilityMetric) volatilityMetric.dataset.tone = diagnostic.volatilityPct == null ? 'muted' : (diagnostic.volatilityPct >= rules.volatileCv ? 'warn' : (diagnostic.volatilityPct < rules.plateauCv ? 'ok' : 'neutral'));
    if (gapMetric) gapMetric.dataset.tone = gapVal == null ? 'muted' : 'neutral';

    this._patchDiagnosticGauges(card, diagnostic, Boolean(root._metricMotion), motionContext);

    const wrap = card.querySelector('[data-hero-chart-wrap]');
    if (wrap) {
      if (wrap._chartContext !== root.dataset.motionContext) {
        wrap._chartContext = root.dataset.motionContext;
        wrap._hoverPointer = null;
        delete wrap.dataset.focus;
        this._clearHeroChartHover(wrap);
        this._paintDiagnosticConnector(card, '');
      }
      this._renderHeroChart(wrap, { mode: activeMode, points, best, diagnostic, lrPoints, primaryIsAvg: seriesSet.primaryIsAvg }, d, isHistory, t, options);
    }
  },
};
