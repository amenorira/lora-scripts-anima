/* 训练诊断与趋势展示；由 monitor-render.js 装配。 */
window.monitorDiagnosticsMixin = {
  // 最低点/最新点参照图按真实步数铺满窗口，常量线居中。
  _diagnosticLossTrend(bestStep) {
    const points = this._trainingDiagnosticPoints();
    if (points.length < 2) return { path: '', coords: [], bestIndex: -1 };
    const values = points.map(point => point.value);
    const low = Math.min(...values), high = Math.max(...values);
    const range = Math.max(high - low, Math.max(Math.abs(low), Math.abs(high)) * .2, 1e-9) * 1.2;
    const bottom = (low + high - range) / 2;
    const first = points[0].step, span = points.at(-1).step - first;
    const coords = points.map(point => ({ x: (4 + (point.step - first) / span * 112).toFixed(1), y: (30 - (point.value - bottom) / range * 26).toFixed(1) }));
    return {
      path: coords.map((point, index) => (index ? 'L' : 'M') + point.x + ' ' + point.y).join(' '),
      coords,
      bounds: { low: bottom, high: bottom + range },
      points, signature: JSON.stringify(points), bestIndex: points.findIndex(point => point.step === bestStep),
    };
  },

  _diagnosticMetricTrends() {
    // 160 个原始点覆盖 40 个统计观测各自的 120 点窗口，刷新与实时更新使用同一计算。
    const points = this._trainingDiagnosticPoints(160);
    const trends = { change: [], volatility: [] };
    for (let index = Math.max(0, points.length - 40); index < points.length; index++) {
      const diagnostic = this._trainingDiagnostics(points.slice(Math.max(0, index - 119), index + 1));
      for (const [key, value] of [
        ['change', diagnostic.changePct], ['volatility', diagnostic.volatilityPct],
      ]) {
        if (Number.isFinite(value)) trends[key].push({ step: points[index].step, value });
      }
    }
    return trends;
  },

  _diagnosticTrendBounds(key, points) {
    const values = points.map(point => point.value);
    if (key === 'change') {
      // 对称缩放始终把 0 固定在中线，正负值不会因局部缩放跨错位置。
      const radius = Math.max(.05, ...values.map(Math.abs)) * 1.15;
      return { low: -radius, high: radius };
    }
    const low = values.length ? Math.min(...values) : 0;
    const high = values.length ? Math.max(...values) : 0;
    const span = Math.max(high - low, .1);
    const center = (high + low) / 2;
    return { low: Math.max(0, center - span * .6), high: center + span * .6 };
  },

  _trainingDiagnosticPoints(limit = 120) {
    const series = this.monitorLossSeries.find(item => item.tag === 'loss/average')
      || this.monitorLossSeries.find(item => item.tag === 'loss/current');
    return this._cleanLossPoints(series && (series.diagnostic_points || series.points)).slice(-limit);
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
    const clean = this._cleanLossPoints(points || this._trainingDiagnosticPoints());

    const base = {
      code: 'insufficient', tone: 'muted', count: clean.length,
      windowSize: 0, latestStep: clean.length ? clean[clean.length - 1].step : null,
      recentMean: null, previousMean: null, changePct: null, volatilityPct: null,
      bestValue: null, bestStep: null, gapFromBestPct: null,
      previousStartStep: null, previousEndStep: null, recentStartStep: null, recentEndStep: null,
    };
    if (!clean.length) return base;

    let best = clean[0];
    clean.forEach(point => { if (point.value <= best.value) best = point; });
    base.bestValue = best.value;
    base.bestStep = best.step;
    base.gapFromBestPct = (clean[clean.length - 1].value - best.value) / Math.max(Math.abs(best.value), 1e-12) * 100;
    if (clean.length < rules.minimumPoints) return base;

    const desiredWindow = rules.windowMax;
    const windowSize = Math.min(desiredWindow, Math.floor(clean.length / 2));
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
    else if (volatilityPct >= rules.volatileCv) Object.assign(base, { code: 'volatile', tone: 'danger' });
    else if (changePct <= rules.convergingChange) Object.assign(base, { code: 'converging', tone: 'ok' });
    else if (Math.abs(changePct) < rules.plateauAbsChange && volatilityPct < rules.plateauCv) Object.assign(base, { code: 'plateau', tone: 'warn' });
    else Object.assign(base, { code: 'steady', tone: 'neutral' });
    return base;
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
        label: ['diagnosticInsufficient', '数据不足'],
        summary: ['diagnosticInsufficientSummary', '至少需要 6 个有效 Loss 点才能判断近期趋势。'],
        advice: ['diagnosticInsufficientAdvice', '训练开始后诊断会随 Loss 数据自动更新。'],
      },
      converging: {
        label: ['diagnosticConverging', '训练 Loss 持续下降'],
        summary: ['diagnosticConvergingSummary', '近期训练 Loss 平均值持续下降，优化目标仍在改善。'],
        advice: ['diagnosticConvergingAdvice', '可保持当前配置继续观察，并用固定提示词样本确认实际质量变化。'],
      },
      plateau: {
        label: ['diagnosticPlateau', '进入平台期'],
        summary: ['diagnosticPlateauSummary', '近期变化很小且波动不大，Loss 可能进入平台期。'],
        advice: ['diagnosticPlateauAdvice', '结合样本质量判断是否继续；需要细节时打开 TensorBoard。'],
      },
      rebound: {
        label: ['diagnosticRebound', '近期反弹'],
        summary: ['diagnosticReboundSummary', '近期 Loss 平均值明显高于前一段时间。'],
        advice: ['diagnosticReboundAdvice', '先观察下一 Epoch；若持续反弹，再检查学习率与数据。'],
      },
      volatile: {
        label: ['diagnosticVolatile', '波动异常'],
        summary: ['diagnosticVolatileSummary', '近期 Loss 起伏较大，训练稳定性需要关注。'],
        advice: ['diagnosticVolatileAdvice', '优先检查学习率、batch size 和异常样本，不要因为某一步的数值变化就停止训练。'],
      },
      steady: {
        label: ['diagnosticSteady', '平稳运行'],
        summary: ['diagnosticSteadySummary', '近期波动可控，但改善幅度暂不显著。'],
        advice: ['diagnosticSteadyAdvice', '继续关注样本质量和后续窗口变化。'],
      },
    };
    const item = copy[code] || copy.insufficient;
    return t(item[kind][0], item[kind][1]);
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
      insufficient: ['diagnosticEvidenceInsufficient', '当前 {count} 个有效 Loss 点；至少 {minimum} 个点后才会比较两个相邻时间段。'],
      converging: ['diagnosticEvidenceConverging', '近期平均值下降 {magnitude}，达到 ≤ -{converging}% 的下降条件；波动程度 {volatility} 未达到 {volatile}% 异常阈值。'],
      plateau: ['diagnosticEvidencePlateau', '平均值变化幅度 {magnitude} < {plateauChange}%，且波动程度 {volatility} < {plateauVolatility}%，符合平台期条件。'],
      rebound: ['diagnosticEvidenceRebound', '近期平均值上升 {magnitude}，达到 ≥ +{rebound}% 的反弹条件；反弹信号优先判定。'],
      volatile: ['diagnosticEvidenceVolatile', '近期波动程度 {volatility}，达到 ≥ {volatile}% 的异常条件；同期平均值变化为 {change}。'],
      steady: ['diagnosticEvidenceSteady', '平均值变化 {change}、波动程度 {volatility}，不符合下降、反弹、异常波动或平台期条件。'],
    };
    const item = copy[diagnostic.code] || copy.insufficient;
    return this._fillDiagnosticTemplate(t(item[0], item[1]), values);
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

  _trainingDiagnosticsHtml(t) {
    const rules = this._trainingDiagnosticRules();
    let html = '<section class="m-console-card m-training-diagnostics">';
    html += '<div class="m-card-heading"><div><span data-diagnostic-field="title">' + this.esc(t('trainingDiagnostics')) + '</span></div><button type="button" class="btn btn-sm btn-secondary m-tensorboard-link" @click="navigate(\'tensorboard\')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V9m7 10V5m7 14v-7"/></svg>' + this.esc(t('openTensorBoard')) + '</button></div>';
    html += '<div class="m-diagnostic-body">';
    html += '<div class="m-diagnostic-verdict" data-diagnostic-tone="muted"><div class="m-diagnostic-copy"><div class="m-diagnostic-state"><i aria-hidden="true"></i><strong data-diagnostic-field="state">--</strong></div><p data-diagnostic-field="summary">--</p></div><svg class="m-diagnostic-trend" viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true"><path data-diagnostic-trend></path></svg></div>';
    html += '</div><div class="m-diagnostic-metrics">';
    const metrics = [
      ['change', t('recentLossChange'), t('comparedPreviousWindow')],
      ['volatility', t('lossVolatility'), t('lowerIsMoreStable')],
      ['best', t('bestLoss'), t('bestObservedValue')],
      ['gap', t('gapFromBest'), t('latestVsBest')],
    ];
    metrics.forEach(metric => {
      const title = ['change', 'volatility'].includes(metric[0]) ? ' title="' + this.esc(metric[1] + ' · ' + t('localTrendScaleHint')) + '"' : '';
      html += '<div class="m-diagnostic-metric" data-diagnostic-metric="' + metric[0] + '"' + title + '><span>' + this.esc(metric[1]) + '</span><strong data-diagnostic-field="' + metric[0] + '">--</strong><small data-diagnostic-field="' + metric[0] + '-meta">' + this.esc(metric[2]) + '</small>';
      if (['change', 'volatility'].includes(metric[0])) html += '<small class="m-diagnostic-range" data-diagnostic-field="' + metric[0] + '-range"></small>';
      html += '<svg class="m-diagnostic-mini" viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true">';
      if (metric[0] === 'change') html += '<line data-diagnostic-zero x1="4" x2="116" y1="17" y2="17" visibility="hidden"/>';
      html += '<path data-diagnostic-spark="' + metric[0] + '"></path><line data-diagnostic-low="' + metric[0] + '" visibility="hidden"></line><line data-diagnostic-point="' + metric[0] + '" visibility="hidden"></line></svg></div>';
    });
    html += '</div>';
    html += '<details class="m-diagnostic-details"><summary>' + this.esc(t('diagnosticMethodTitle')) + '</summary>';
    html += '<div class="m-diagnostic-evidence"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l5-5 4 3 7-8"/><path d="M16 7h4v4"/></svg><div><span>' + this.esc(t('diagnosticEvidence')) + '</span><strong data-diagnostic-field="evidence">--</strong><small data-diagnostic-field="window-evidence">--</small></div></div>';
    html += '<div class="m-diagnostic-guidance"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="4"/></svg><div><span>' + this.esc(t('diagnosticAdvice')) + '</span><strong data-diagnostic-field="advice">--</strong></div></div>';
    html += '<div class="m-diagnostic-method">';
    html += '<div class="m-diagnostic-method-content">';
    html += '<p class="m-diagnostic-boundary"><strong>' + this.esc(t('diagnosticScopeTitle')) + '</strong><span>' + this.esc(t('diagnosticScopeText')) + '</span></p>';
    const methodItems = [
      [t('diagnosticMethodSource'), t('diagnosticMethodSourceText')],
      [t('diagnosticMethodWindow'), t('diagnosticMethodWindowText')],
      [t('diagnosticMethodVolatility'), t('diagnosticMethodVolatilityText')],
    ];
    html += '<div class="m-diagnostic-method-grid">';
    methodItems.forEach(item => { html += '<div><span>' + this.esc(item[0]) + '</span><p>' + this.esc(item[1]) + '</p></div>'; });
    html += '</div><div class="m-diagnostic-rule-title">' + this.esc(t('diagnosticRuleOrder')) + '</div><div class="m-diagnostic-rules">';
    const ruleItems = [
      [t('diagnosticRuleRebound'), this._fillDiagnosticTemplate(t('diagnosticRuleReboundCondition'), { value: rules.reboundChange })],
      [t('diagnosticRuleVolatile'), this._fillDiagnosticTemplate(t('diagnosticRuleVolatileCondition'), { value: rules.volatileCv })],
      [t('diagnosticRuleConverging'), this._fillDiagnosticTemplate(t('diagnosticRuleConvergingCondition'), { value: rules.convergingChange })],
      [t('diagnosticRulePlateau'), this._fillDiagnosticTemplate(t('diagnosticRulePlateauCondition'), { change: rules.plateauAbsChange, volatility: rules.plateauCv })],
      [t('diagnosticRuleSteady'), t('diagnosticRuleOtherwise')],
    ];
    ruleItems.forEach(item => { html += '<div><span>' + this.esc(item[0]) + '</span><code>' + this.esc(item[1]) + '</code></div>'; });
    html += '</div><p class="m-diagnostic-method-note">' + this.esc(t('diagnosticMethodNote')) + '</p></div></div>';
    html += '</details></section>';
    return html;
  },

  _patchTrainingDiagnostics(root, t, d, isHistory) {
    const isPreviousRun = !isHistory && this._summaryStatus(d, isHistory).terminal;
    const context = isHistory ? 'history' : (isPreviousRun ? 'previous' : 'live');
    const version = String(this.lossDataVersion) + ':' + String(this._shellLocale || '') + ':' + context;
    if (root.dataset.diagnosticVersion === version) return;
    root.dataset.diagnosticVersion = version;
    const diagnostic = this._trainingDiagnostics();
    const setText = (field, value) => {
      const element = root.querySelector('[data-diagnostic-field="' + field + '"]');
      if (element) {
        if (['change', 'volatility', 'best', 'gap'].includes(field)) this._patchMonitorNumber(element, value, root._metricMotion);
        else if (element.textContent !== String(value)) element.textContent = value;
      }
    };
    setText('title', isPreviousRun ? t('previousTrainingDiagnostics') : t('trainingDiagnostics'));
    const verdict = root.querySelector('.m-diagnostic-verdict');
    if (verdict) verdict.dataset.diagnosticTone = diagnostic.tone;
    const trend = root.querySelector('[data-diagnostic-trend]');
    if (trend) this._patchRollingSparkline(trend, this._trainingDiagnosticPoints(), root._metricMotion, root.dataset.motionContext);
    setText('state', this._diagnosticText(t, diagnostic.code, 'label'));
    setText('summary', this._diagnosticText(t, diagnostic.code, 'summary'));
    setText('advice', this._diagnosticText(t, diagnostic.code, 'advice'));
    setText('evidence', this._diagnosticEvidence(t, diagnostic));
    setText('window-evidence', this._diagnosticWindowEvidence(t, diagnostic));
    setText('change', this._formatDiagnosticPercent(diagnostic.changePct, true));
    setText('volatility', this._formatDiagnosticPercent(diagnostic.volatilityPct, false));
    setText('best', this._formatDiagnosticValue(diagnostic.bestValue));
    setText('gap', this._formatDiagnosticPercent(diagnostic.gapFromBestPct, true));
    setText('change-meta', diagnostic.windowSize ? t('windowComparison').replaceAll('{n}', diagnostic.windowSize) : t('needsMorePoints'));
    setText('volatility-meta', diagnostic.windowSize ? t('recentWindowPoints').replace('{n}', diagnostic.windowSize) : t('lowerIsMoreStable'));
    setText('best-meta', diagnostic.bestStep == null ? t('bestObservedValue') : t('atStep').replace('{n}', Math.round(diagnostic.bestStep)));
    setText('gap-meta', t('latestVsBest'));
    const changeMetric = root.querySelector('[data-diagnostic-metric="change"]');
    const volatilityMetric = root.querySelector('[data-diagnostic-metric="volatility"]');
    const gapMetric = root.querySelector('[data-diagnostic-metric="gap"]');
    const rules = this._trainingDiagnosticRules();
    if (changeMetric) changeMetric.dataset.tone = diagnostic.changePct == null ? 'muted' : (diagnostic.changePct <= rules.convergingChange ? 'ok' : (diagnostic.changePct >= rules.reboundChange ? 'danger' : 'neutral'));
    if (volatilityMetric) volatilityMetric.dataset.tone = diagnostic.volatilityPct == null ? 'muted' : (diagnostic.volatilityPct >= rules.volatileCv ? 'danger' : (diagnostic.volatilityPct < rules.plateauCv ? 'ok' : 'neutral'));
    if (gapMetric) gapMetric.dataset.tone = diagnostic.gapFromBestPct == null ? 'muted' : 'neutral';
    const trends = this._diagnosticMetricTrends();
    const lossTrend = this._diagnosticLossTrend(diagnostic.bestStep);
    for (const key of ['change', 'volatility', 'best', 'gap']) {
      const isLossTrace = key === 'best' || key === 'gap';
      const path = root.querySelector('[data-diagnostic-spark="' + key + '"]');
      const point = root.querySelector('[data-diagnostic-point="' + key + '"]');
      const low = root.querySelector('[data-diagnostic-low="' + key + '"]');
      if (!isLossTrace) {
        const points = trends[key];
        const range = points.length ? this._fillDiagnosticTemplate(t('diagnosticTrendRange'), {
          n: points.length, first: points[0].step, last: points.at(-1).step,
        }) : t('needsMorePoints');
        setText(key + '-range', range);
        root.querySelector('[data-diagnostic-metric="' + key + '"]')?.setAttribute('title',
          range + ' · ' + t(key === 'change' ? 'diagnosticChangeScaleHint' : 'localTrendScaleHint'));
        if (path) {
          const frame = this._patchRollingSparkline(path, points, root._metricMotion, root.dataset.motionContext, {
            marker: point, fixedBounds: this._diagnosticTrendBounds(key, points),
          });
          if (key === 'change') root.querySelector('[data-diagnostic-zero]')?.setAttribute('visibility', frame.path ? 'visible' : 'hidden');
        }
        if (low) low.setAttribute('visibility', 'hidden');
        continue;
      }
      // 最低点/最新点保留真实步数位置；仅在纵轴量程变化时缩放，不做横向滚动。
      const geometry = lossTrend;
      if (path) this._patchSparklineFrame(path, geometry, root._metricMotion, root.dataset.motionContext + '|loss-reference', [
        { element: point, point: key === 'gap' ? geometry.coords.at(-1) : null },
        { element: low, point: geometry.coords[geometry.bestIndex] },
      ]);
    }
  },
};
