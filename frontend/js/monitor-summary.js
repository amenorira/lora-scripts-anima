/* 训练摘要、参数控制台与数值动画；由 monitor-render.js 装配。 */
window.monitorSummaryMixin = {
  // ═══════════════════════════════════════════════════════════
  //  概览标签
  // ═══════════════════════════════════════════════════════════

  // 训练参数标签：用字段 key 名（简洁，与训练表单 field-key 一致）。
  // network_args/optimizer_args 子项用 label_raw（如 algo/preset）。
  // 兼容旧后端响应（p.label 直接用）。
  _paramLabel(p) {
    if (p.label_raw) return this.esc(p.label_raw);
    if (p.label) return this.esc(p.label);
    return this.esc(p.key || '');
  },

  // 训练参数 hover title：用 desc_key 取 i18n 完整描述句，供鼠标悬停提示。
  _paramTitle(p, t) {
    if (p.desc_key) {
      const v = t(p.desc_key, '');
      return v && v !== p.desc_key ? v : '';
    }
    return '';
  },

  // 训练参数值 HTML：toggle 类型渲染 ✓/✕ 徽标，其余正常转义显示。
  _paramValueHtml(p) {
    const v = String(p.value == null ? '' : p.value);
    if (p.type === 'toggle') {
      const on = v === 'true' || v === 'True';
      return '<span class="param-toggle ' + (on ? 'on' : 'off') + '">' + (on ? '✓' : '✕') + '</span>';
    }
    return this.esc(v);
  },

  _patchOverviewStatus(root, d, t, isHistory) {
    if (!d || !root) return;
    const motionContext = [isHistory ? this.selectedRunDir : (this.liveTaskId || d.active_task?.id || 'live'), isHistory, this._shellLocale || ''].join('|');
    const animate = !isHistory && root.dataset.motionContext === motionContext;
    root.dataset.motionContext = motionContext;
    root._metricMotion = animate;
    const { state, completed, terminal, running } = this._summaryStatus(d, isHistory);
    const total = Number(d.total_steps) || 0;
    const step = completed && total ? total : (Number(d.step) || 0);
    const rawPercent = d.percent != null ? Number(d.percent) : (total ? step / total * 100 : 0);
    const percent = completed ? 100 : Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0));
    const lossSeries = this._summaryLossSeries();
    const lrSeries = this.monitorLossSeries.find(item => item.tag === 'lr/unet');
    const lrPoints = lrSeries && Array.isArray(lrSeries.points) ? lrSeries.points : [];
    const lrLatest = lrSeries && (lrSeries.latest != null ? Number(lrSeries.latest) : (lrPoints.length ? Number(lrPoints[lrPoints.length - 1].value) : null));
    const lrMax = lrSeries && (lrSeries.max != null ? Number(lrSeries.max) : (lrPoints.length ? Math.max(...lrPoints.map(point => Number(point.value)).filter(Number.isFinite)) : null));
    const lrRange = terminal && lrPoints.length >= 2 && Number.isFinite(lrMax) && Number.isFinite(lrLatest);
    const connection = isHistory ? null : this._monitorConnectionMeta(t);
    const stateLabels = { RUNNING: t('trainingInProgress'), CREATED: t('created'), FINISHED: t('finished'), FAILED: t('statusFailed'), TERMINATED: t('terminated'), UNKNOWN: t('statusUnknown'), IDLE: t('standby') };
    const set = (key, value) => {
      const el = root.querySelector('[data-summary-field="' + key + '"]');
      if (el) {
        // 仅指标读数滚动；进度与说明文字直接更新，避免整块摘要都在跳动。
        if (['loss', 'lr', 'speed'].includes(key)) this._patchMonitorNumber(el, value, animate);
        else if (el.textContent !== String(value)) el.textContent = String(value);
      }
    };
    const status = root.querySelector('[data-summary-state]');
    if (status) {
      status.dataset.tone = state === 'FAILED' ? 'danger' : (state === 'TERMINATED' ? 'muted' : (state === 'RUNNING' || completed ? 'ok' : 'muted'));
      status.textContent = stateLabels[state] || state;
    }
    const connectionEl = root.querySelector('[data-summary-connection]');
    if (connectionEl) {
      connectionEl.hidden = !connection;
      if (connection) connectionEl.textContent = connection.label;
    }
    const stop = root.querySelector('[data-summary-stop]');
    if (stop) stop.hidden = isHistory || !this._isActiveState(state);
    const notice = root.querySelector('[data-summary-notice]');
    if (notice) {
      const messages = [];
      if (!isHistory && d.has_error) messages.push(d.error_msg || t('error'));
      if (!isHistory && (this.realtimeTaskStateUnknown || state === 'UNKNOWN')) messages.push(t('taskStateUnknown'));
      notice.hidden = !messages.length;
      notice.textContent = messages.join(' · ');
    }
    set('step', step + ' / ' + (total || '—') + ' ' + t('stepsUnit'));
    set('percent', Number.isInteger(percent) ? percent + '%' : percent.toFixed(1) + '%');
    const epoch = String(d.epoch ?? '—').trim() || '—';
    // 日志只给当前轮数时，从本次训练参数补齐总轮数；已有 x/y 时保留日志中的实际总数。
    const totalEpochs = Number((this.trainParams || []).find(param => param.key === 'max_train_epochs')?.value);
    const epochProgress = !epoch.includes('/') && Number.isInteger(totalEpochs) && totalEpochs > 0
      ? epoch + '/' + totalEpochs : epoch;
    set('epoch', t('epochProgress') + ' ' + epochProgress);
    const lossPoints = this._cleanLossPoints(lossSeries && (lossSeries.diagnostic_points || lossSeries.points));
    const latestLoss = lossPoints[lossPoints.length - 1];
    set('loss', latestLoss ? this._formatDiagnosticValue(latestLoss.value) : (d.loss != null ? d.loss : '—'));
    // 每次实际显示新采样时记录比较基准；批量到达的中间 step 不冒充上次读数。
    const displayedLoss = root._displayedLoss;
    const sameLossContext = displayedLoss?.context === motionContext;
    if (isHistory || !sameLossContext || displayedLoss.point?.step !== latestLoss?.step || displayedLoss.point?.value !== latestLoss?.value) {
      root._displayedLoss = {
        context: motionContext,
        point: latestLoss,
        trend: this._summaryLossChange(lossSeries, isHistory ? undefined : (sameLossContext ? (displayedLoss.point ?? null) : null)),
      };
    }
    const lossTrend = root._displayedLoss.trend;
    const lossChange = root.querySelector('[data-summary-loss-change]');
    if (lossChange) {
      lossChange.hidden = !lossTrend;
      if (lossTrend) this._patchLossChange(lossChange, lossTrend.percent, t(isHistory ? 'lossVsPreviousSample' : 'lossVsPreviousDisplay'), animate);
    }
    set('loss-meta', latestLoss ? t('lossUpdatedAt').replace('{n}', latestLoss.step) : t('recentLoss'));
    set('lr', this._formatLearningRate(lrLatest ?? d.lr, '—'));
    const lrRangeEl = root.querySelector('[data-summary-field="lr-range"]');
    if (lrRangeEl) {
      lrRangeEl.hidden = !lrRange;
      if (lrRange) lrRangeEl.textContent = t('lrPeak') + ' ' + this._formatLearningRate(lrMax, '—');
    }
    set('lr-meta', this._summarySchedulerMeta(t, total) || (lrRange && completed && lrLatest === 0 ? t('schedulerFinished') : ''));
    set('speed', d.speed || '—');
    set('speed-meta', t(!isHistory && running ? 'currentSpeed' : 'lastSpeed'));
    this._patchSummaryTime(root, d, t, isHistory, animate);
    const progress = root.querySelector('[data-overview-progress]');
    if (progress) {
      progress.style.width = percent + '%';
      progress.parentElement.setAttribute('aria-valuenow', String(percent));
    }
    if (root.dataset.sparklineVersion !== String(this.lossDataVersion)) {
      root.dataset.sparklineVersion = String(this.lossDataVersion);
      const lossPath = root.querySelector('[data-summary-spark="loss"]');
      const lrPath = root.querySelector('[data-summary-spark="lr"]');
      for (const [path, series] of [[lossPath, lossSeries], [lrPath, lrSeries]]) {
        // 学习率展示近期斜率；20% 的绝对值下限会把缓慢衰减压成近乎水平的线。
        if (path) {
          this._patchRollingSparkline(path, series?.diagnostic_points?.length ? series.diagnostic_points : (series?.points || []), animate, root.dataset.motionContext, { relativeSpan: path === lrPath ? .02 : .2 });
        }
      }
    }
    this._patchSummaryTelemetry(root, t, isHistory);
    this._patchTrainingDiagnostics(root, t, d, isHistory);
  },

  _patchSummaryTime(root, d, t, isHistory, animate) {
    const { terminal, running } = this._summaryStatus(d, isHistory);
    const result = terminal && d.train_result;
    const elapsed = !isHistory && running ? this._observeMonitorClock(d) : this._monitorDurationSeconds(d.elapsed);
    const duration = this._formatMonitorDuration(result?.duration_str || d.elapsed || '—', result ? result.duration_sec : elapsed);
    const eta = d.eta ? this._formatMonitorDuration(d.eta) : '';
    const showRemaining = running && !!eta;
    const endedAt = result?.ended_at ? this._formatRunEndTime(result.ended_at) : '';
    const hasTimeTrend = this._summaryTelemetrySamples(isHistory).samples.filter(sample => Number.isFinite(sample.remainingRate)).length >= 2;
    const timeMeta = [
      showRemaining ? t('elapsed') + ' ' + duration : endedAt ? t('endedAt') + ' ' + endedAt : '',
      !showRemaining && hasTimeTrend ? t('timeTrendCaption') : '',
    ].filter(Boolean).join(' · ');
    for (const [key, value] of [
      ['time-label', t(showRemaining ? 'estimatedRemaining' : running ? 'elapsed' : 'totalDuration')],
      ['time', showRemaining ? eta : duration],
      ['time-meta', timeMeta],
    ]) {
      const element = root.querySelector('[data-summary-field="' + key + '"]');
      if (!element) continue;
      if (key === 'time') this._patchMonitorNumber(element, value, animate);
      else if (element.textContent !== value) element.textContent = value;
    }
  },

  _renderOverviewTab(d, t, isHistory) {
    let html = '';
    const { running } = this._summaryStatus(d, isHistory);
    html += '<div class="m-overview-grid">';
    html += this._overviewMetricsHtml(d, t, isHistory);
    html += this._trainingDiagnosticsHtml(t);
    html += '</div>';
    if (this.trainParams.length) html += this._parametersConsoleHtml(t);
    else if (!running) html += '<div class="m-console-card m-empty-params"><div class="m-card-heading"><span>' + this.esc(t('trainParams')) + '</span></div><div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t('noParamsHint')) + '</p></div></div>';
    return html;
  },

  _overviewMetricsHtml(d, t, isHistory) {
    const { state } = this._summaryStatus(d, isHistory);
    let html = '<section class="m-console-card m-overview-metrics">';
    html += '<div class="m-card-heading"><div><span>' + this.esc(t('runSummary')) + '</span></div>';
    html += '<div class="m-summary-actions"><span class="m-summary-state" data-summary-state></span><span class="m-summary-connection" data-summary-connection hidden role="status" aria-live="polite"></span>';
    if (!isHistory) html += '<button type="button" class="btn btn-sm m-summary-stop" data-summary-stop hidden @click="stopTraining()">' + this.esc(t('stopTraining')) + '</button>';
    html += '</div></div>';
    if (!isHistory) html += '<div class="m-summary-notice" data-summary-notice hidden role="alert"></div>';
    if (!isHistory && state === 'UNKNOWN') return html + '</section>';
    if (!isHistory && state === 'IDLE') {
      html += '<div class="m-idle-hero"><span class="m-idle-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9l6 3"/><circle cx="12" cy="12" r="9"/></svg></span><div><strong>' + this.esc(t('readyToTrain')) + '</strong><span>' + this.esc(t('readyToTrainHint')) + '</span></div></div>';
      html += '<button type="button" class="btn btn-primary m-start-training" @click="navigate(\'train-basic\')">' + this.esc(t('goToTraining')) + ' →</button>';
      if (d.last_config && d.last_config.name) {
        const lc = d.last_config;
        html += '<div class="m-last-run"><span>' + this.esc(t('lastTraining')) + '</span><strong>' + this.esc(lc.name) + '</strong><small>' + this.esc((lc.model || '') + ' · LR ' + (lc.lr || '--') + ' · ' + (lc.epochs || '--') + ' Epochs') + '</small></div>';
      }
      html += '</section>';
      return html;
    }
    html += '<div class="m-summary-progress"><div class="m-summary-progress-top"><span>' + this.esc(t('overallProgress')) + '</span><div class="m-summary-progress-figures"><strong data-summary-field="step"></strong><b data-summary-field="percent"></b></div></div>';
    html += '<div class="m-overview-progress" role="progressbar" aria-label="' + this.esc(t('overallProgress')) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-overview-progress></i></div>';
    html += '<div class="m-summary-progress-bottom"><span data-summary-field="epoch"></span></div></div>';
    html += '<div class="m-live-metrics">';
    html += this._summaryTileHtml('loss', t('currentLoss'), t('recentLoss'), t('localTrendScaleHint'));
    html += this._summaryTileHtml('lr', t('lr'), '', t('localTrendScaleHint'));
    html += this._summaryTileHtml('speed', t('speed'), t('currentSpeed'));
    html += this._summaryTileHtml('time', t('elapsed'), '');
    html += '</div></section>';
    return html;
  },

  // 所有卡片共用生命周期解释；状态只影响文案与交互，不改变曲线的指标定义。
  _summaryStatus(d, isHistory) {
    let state = isHistory ? 'UNKNOWN' : (d.state || 'IDLE');
    if (isHistory && d.train_result && d.train_result.status) {
      const status = String(d.train_result.status).toUpperCase();
      state = { COMPLETED: 'FINISHED', FINISHED: 'FINISHED', ERROR: 'FAILED', TIMEOUT: 'FAILED', FAILED: 'FAILED', TERMINATED: 'TERMINATED' }[status] || 'UNKNOWN';
    }
    return { state, running: state === 'RUNNING', completed: state === 'FINISHED', terminal: isHistory || ['FINISHED', 'FAILED', 'TERMINATED'].includes(state) };
  },

  _summaryTileHtml(key, label, meta, scaleHint = '') {
    let html = '<div class="m-live-metric m-live-metric-' + key + '"' + (scaleHint ? ' title="' + this.esc(label + ' · ' + scaleHint) + '"' : '') + '><span class="m-metric-label">' + this._monitorIconHtml(key) + '<span' + (key === 'time' ? ' data-summary-field="time-label"' : '') + '>' + this.esc(label) + '</span></span>';
    html += '<div class="m-metric-reading"><strong data-summary-field="' + key + '">—</strong>';
    if (key === 'loss') html += '<span class="m-metric-change" data-summary-loss-change hidden></span>';
    if (key === 'lr') html += '<span class="m-metric-range" data-summary-field="lr-range" hidden></span>';
    html += '</div><small data-summary-field="' + key + '-meta">' + this.esc(meta) + '</small>';
    html += '<svg class="m-metric-sparkline" viewBox="0 0 120 34" preserveAspectRatio="none" ' + (key === 'speed' || key === 'time' ? 'role="img" hidden' : 'aria-hidden="true"') + '>';
    if (key === 'time') html += '<line data-summary-time-baseline x1="4" x2="116" y1="17" y2="17" visibility="hidden"/>';
    html += '<path data-summary-spark="' + key + '"></path></svg>';
    return html + '</div>';
  },

  _summaryTelemetrySamples(isHistory) {
    const source = [isHistory, isHistory ? this.selectedRunDir : (this.liveTaskId || this.monitorData?.active_task?.id || 'live')].join('|');
    const version = [source, isHistory ? this._runDetailRequestSeq : this._monitorPerfVersion].join('|');
    const samples = isHistory ? this.runDetailData?.perf_samples : this.monitorPerfSamples;
    return { version, samples: (samples || []).slice(-40) };
  },

  _patchSummaryTelemetry(root, t, isHistory) {
    const telemetry = this._summaryTelemetrySamples(isHistory);
    // 时间小图始终表达预计剩余的变化率；结束和历史回看保留同一种统计口径。
    const version = telemetry.version;
    if (root.dataset.telemetryVersion === version) return;
    root.dataset.telemetryVersion = version;
    for (const [key, field, label] of [
      ['speed', 'speedSec', 'speedTrendLabel'], ['time', 'remainingRate', 'remainingTrendLabel'],
    ]) {
      const path = root.querySelector('[data-summary-spark="' + key + '"]');
      if (!path) continue;
      const rate = field === 'remainingRate';
      const speed = field === 'speedSec';
      const points = telemetry.samples.filter(sample => Number.isFinite(sample[field]) && (rate || (speed ? sample[field] > 0 : sample[field] >= 0)))
        .map(sample => ({ step: sample.observation, value: speed ? 1 / sample[field] : sample[field] }))
        .filter(point => Number.isFinite(point.value));
      const minimumSpan = speed ? .001 : 0;
      const relativeSpan = field === 'speedSec' ? .005 : .02;
      // 正常倒计时的导数为 -1，固定在中线；扩大两侧量程以容纳实际变化，不裁掉峰值。
      const radius = rate ? Math.max(1, ...points.map(point => Math.abs(point.value + 1))) * 1.2 : 0;
      const frame = this._patchRollingSparkline(path, points, root._metricMotion, root.dataset.motionContext + '|' + field, {
        minimumSpan, relativeSpan, fixedBounds: rate ? { low: -1 - radius, high: -1 + radius } : null,
      });
      if (key === 'time') root.querySelector('[data-summary-time-baseline]')?.setAttribute('visibility', rate && frame.path ? 'visible' : 'hidden');
      const svg = path.parentElement;
      if (svg) {
        const tile = svg.closest?.('.m-live-metric');
        if (frame.path) svg.removeAttribute('hidden');
        else svg.setAttribute('hidden', '');
        if (frame.path) {
          const title = t(label) + (rate ? '' : ' · ' + t('localTrendScaleHint'));
          svg.setAttribute('aria-label', title);
          svg.setAttribute('title', title);
          // 小图不接收鼠标事件，说明由整个卡片提供，窄桌面隐藏小图时也可查看。
          tile?.setAttribute('title', title);
        } else {
          svg.removeAttribute('aria-label');
          svg.removeAttribute('title');
          tile?.removeAttribute('title');
        }
      }
    }
  },

  _monitorIconHtml(kind) {
    const paths = {
      loss: '<path d="M2 13c3-9 6-9 9 0s6 9 11 0"/>',
      lr: '<path d="M4 19V11m5 8V5m5 14v-9m5 9V7"/>',
      speed: '<path d="M4 17a9 9 0 1 1 16 0m-8-2 4-6"/><circle cx="12" cy="15" r="1"/>',
      time: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
      pretrained_model_name_or_path: '<path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5m-9 5v10"/>',
      learning_rate: '<path d="M3 19h18M3 19V5m3 9 4-5 4 3 6-7"/>',
      network_dim: '<path d="M4 4v16m16-16v16M7 12h10m-7-3-3 3 3 3m4-6 3 3-3 3"/>',
      network_alpha: '<text x="12" y="17" text-anchor="middle" fill="currentColor" stroke="none" font-family="Georgia,serif" font-size="19">α</text>',
      max_train_epochs: '<path d="M19 8a8 8 0 1 0 1 5M19 3v5h-5"/>',
      optimizer_type: '<path d="M10 2h4l.5 2.2 1.5.7 1.9-1.2 2.8 2.8-1.2 1.9.7 1.5L22 10v4l-2.2.5-.7 1.5 1.2 1.9-2.8 2.8-1.9-1.2-1.5.7L14 22h-4l-.5-2.2-1.5-.7-1.9 1.2-2.8-2.8 1.2-1.9-.7-1.5L2 14v-4l2.2-.5.7-1.5-1.2-1.9 2.8-2.8 1.9 1.2 1.5-.7z"/><circle cx="12" cy="12" r="3"/>',
      train_batch_size: '<rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/>',
      resolution: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M7 17 17 7m-5 0h5v5M7 12v5h5"/>',
      seed: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="16" cy="16" r="1"/>',
    };
    return '<svg class="m-monitor-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[kind] || '') + '</svg>';
  },

  // 仅用于摘要：逐次 Loss 与诊断区的平均趋势各司其职。
  _summaryLossSeries() {
    return this.monitorLossSeries.find(item => item.tag === 'loss/current');
  },

  _summaryLossChange(series, previousPoint) {
    const points = this._cleanLossPoints(series && (series.diagnostic_points || series.points));
    const latest = points.at(-1);
    const baseline = previousPoint === undefined ? points.at(-2) : previousPoint;
    if (!latest || !baseline || latest.step < baseline.step) return null;
    const previous = baseline.value;
    if (Math.abs(previous) < 1e-12) return null;
    const percent = (points[points.length - 1].value - previous) / Math.abs(previous) * 100;
    return Number.isFinite(percent) ? { percent } : null;
  },

  _summarySchedulerMeta(t, totalSteps) {
    const params = new Map((this.trainParams || []).map(item => [item.key, item.value]));
    const scheduler = params.get('lr_scheduler');
    if (!scheduler) return '';
    const labels = { constant: 'lrScheduleConstant', constant_with_warmup: 'lrScheduleWarmup', linear: 'lrScheduleLinear', cosine: 'lrScheduleCosine', cosine_with_restarts: 'lrScheduleRestarts', polynomial: 'lrSchedulePolynomial', inverse_sqrt: 'lrScheduleInverseSqrt' };
    const label = labels[scheduler] ? t(labels[scheduler]) : String(scheduler);
    const raw = params.get('lr_warmup_steps');
    if (raw == null || raw === '' || !Number.isFinite(Number(raw))) return label;
    const warmup = Number(raw);
    const detail = warmup > 0
      ? (warmup < 1 && !totalSteps ? t('lrWarmupPercent').replace('{n}', +(warmup * 100).toFixed(2)) : t('lrWarmupSteps').replace('{n}', warmup < 1 ? Math.floor(warmup * totalSteps) : Math.floor(warmup)))
      : t('lrNoWarmup');
    return label + ' · ' + detail;
  },

  _monitorMotionAllowed() {
    return !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  },

  // 最终文本始终立即生效；动画仅覆盖数字外观，不插值业务数据、不排队。
  _patchMonitorNumber(element, value, animate, numericValue = null) {
    const text = String(value);
    const previous = element.dataset.metricValue;
    const previousNumber = Number(element.dataset.metricNumber);
    const hasNumericValue = Number.isFinite(numericValue);
    const numericDirection = hasNumericValue && Number.isFinite(previousNumber)
      ? (numericValue >= previousNumber ? -1 : 1) : null;
    // 显示文本可能不含正负号；即使幅度不变，也要记录最新符号供下一次比较。
    if (hasNumericValue) element.dataset.metricNumber = String(numericValue);
    else delete element.dataset.metricNumber;
    const allowed = animate && this._monitorMotionAllowed();
    if (!allowed) {
      for (const animation of element.getAnimations?.({ subtree: true }) || []) animation.cancel();
    }
    if (previous === text) return;
    element.dataset.metricValue = text;
    for (const animation of element.getAnimations?.({ subtree: true }) || []) animation.cancel();
    if (!allowed || previous == null || !element.animate || previous.replace(/\d/g, '#') !== text.replace(/\d/g, '#')) {
      element.textContent = text;
      return;
    }
    const accessible = document.createElement('span');
    accessible.className = 'm-number-accessible';
    accessible.textContent = text;
    const visual = document.createElement('span');
    visual.setAttribute('aria-hidden', 'true');
    visual.className = 'm-number-visual';
    const tracks = [];
    // 按每个数字组的整体方向滚动，进位时保持一致。
    let direction = numericDirection ?? -1;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (numericDirection === null && /\d/.test(char) && (index === 0 || !/[\d.]/.test(text[index - 1]))) {
        const nextNumber = parseFloat(text.slice(index));
        const oldNumber = parseFloat(previous.slice(index));
        const sign = index > 0 && /[-−]/.test(text[index - 1]) ? -1 : 1;
        direction = nextNumber * sign >= oldNumber * sign ? -1 : 1;
      }
      if (!/\d/.test(char) || char === previous[index]) {
        visual.appendChild(document.createTextNode(char));
        continue;
      }
      const slot = document.createElement('span');
      slot.className = 'm-number-slot';
      const incoming = document.createElement('span');
      incoming.className = 'm-number-incoming';
      incoming.textContent = char;
      const outgoing = document.createElement('span');
      outgoing.className = 'm-number-outgoing';
      outgoing.textContent = previous[index];
      slot.append(incoming, outgoing);
      visual.appendChild(slot);
      tracks.push({ incoming, outgoing, direction });
    }
    element.replaceChildren(accessible, visual);
    const options = { duration: 320, easing: 'cubic-bezier(.2,.75,.25,1)' };
    for (const { incoming, outgoing, direction: travel } of tracks) {
      incoming.animate([{ transform: `translateY(${-travel * 100}%)`, opacity: .25 }, { transform: 'translateY(0)', opacity: 1 }], options);
      const exit = outgoing.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${travel * 100}%)`, opacity: 0 }], options);
      exit.onfinish = exit.oncancel = () => outgoing.remove();
    }
  },

  _patchLossChange(element, percent, caption, animate) {
    const rounded = Number(percent.toFixed(1));
    const direction = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
    if (!element.querySelector('[data-loss-delta]')) {
      element.innerHTML = '<svg class="m-change-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg><span data-loss-delta></span><span class="m-change-caption"></span>';
    }
    const arrow = element.querySelector('.m-change-arrow');
    const angle = { up: -45, down: 45, flat: 0 };
    const previous = element.dataset.direction;
    element.dataset.direction = direction;
    if (arrow) {
      for (const animation of arrow.getAnimations?.() || []) animation.cancel();
      arrow.style.transform = `rotate(${angle[direction]}deg)`;
      if (animate && previous && previous !== direction && this._monitorMotionAllowed() && arrow.animate) {
        arrow.animate([{ transform: `rotate(${angle[previous]}deg)` }, { transform: `rotate(${angle[direction]}deg)` }], { duration: 220, easing: 'cubic-bezier(.2,.75,.25,1)' });
      }
    }
    const number = element.querySelector('[data-loss-delta]');
    this._patchMonitorNumber(number, Math.abs(rounded).toFixed(1) + '%', animate, rounded);
    element.querySelector('.m-change-caption').textContent = caption;
    element.setAttribute('aria-label', caption + ' ' + (rounded > 0 ? '+' : rounded < 0 ? '−' : '') + Math.abs(rounded).toFixed(1) + '%');
  },

  // 滚动图每个观测占一个固定槽位，新点只从右侧进入，不重新拉伸旧点的横坐标。
  _rollingSparklineFrame(rawPoints, previous = null, { minimumSpan = 0, relativeSpan = .2, fixedBounds = null } = {}) {
    const points = this._cleanLossPoints(rawPoints).slice(-40);
    const signature = JSON.stringify(points);
    if (previous?.signature === signature) return previous;
    const lastStep = previous?.points.at(-1)?.step;
    if (lastStep != null && points.at(-1)?.step < lastStep) previous = null;
    const appended = previous ? points.filter(point => point.step > lastStep) : [];
    const retained = previous ? previous.points.filter(point => point.step >= (points[0]?.step ?? Infinity)) : [];
    // 只有旧点位置和数值都连续时才平移；历史回填或数值修正直接重绘。
    const continuous = retained.length > 0 && retained.every((point, index) => point.step === points[index]?.step && point.value === points[index]?.value);
    const shift = continuous ? appended.length : 0;
    let bounds = fixedBounds || previous?.bounds || null;
    if (points.length && !fixedBounds) {
      const low = Math.min(...points.map(point => point.value));
      const high = Math.max(...points.map(point => point.value));
      const span = Math.max(high - low, Math.max(Math.abs(low), Math.abs(high)) * relativeSpan, minimumSpan, 1e-9);
      const center = (low + high) / 2;
      const target = { low: center - span * .6, high: center + span * .6 };
      if (!bounds) bounds = target;
      else if (low < bounds.low || high > bounds.high) {
        bounds = { low: Math.min(bounds.low, target.low), high: Math.max(bounds.high, target.high) };
      } else {
        // 极值出窗后逐步贴近近期量程，纵轴动画承接缩放，不再额外等满 40 步。
        const blend = 1 - Math.pow(.75, Math.max(1, Math.min(appended.length, 8)));
        bounds = {
          low: bounds.low + (target.low - bounds.low) * blend,
          high: bounds.high + (target.high - bounds.high) * blend,
        };
      }
    }
    // 多保留两个左侧衔接点，线段真正移出 SVG 后才删除；连续动画还需承接未移出的旧点。
    const prefix = previous && (continuous || points[0]?.step === previous.points[0]?.step)
      ? (previous.renderPoints || previous.points).filter(point => point.step < points[0]?.step) : [];
    const renderPoints = prefix.concat(points);
    return { points, signature, bounds, shift,
      path: this._rollingSparklineGeometry(renderPoints.slice(-42), bounds).path,
      coords: this._rollingSparklineGeometry(points, bounds).coords,
      renderPoints };
  },

  _rollingSparklineGeometry(samples, bounds) {
    const coords = samples.map((point, index) => ({
      x: 116 - (samples.length - 1 - index) * 112 / 39,
      y: 30 - (point.value - bounds.low) / (bounds.high - bounds.low) * 26,
    }));
    return { coords, path: coords.length < 2 ? '' : coords.map((point, index) => (index ? 'L' : 'M') + point.x.toFixed(2) + ' ' + point.y.toFixed(2)).join(' ') };
  },

  _patchRollingSparkline(path, points, animate, context, options = {}) {
    const marker = options.marker;
    const previous = path._sparklineState?.context === context ? path._sparklineState : null;
    const frame = this._rollingSparklineFrame(points, previous, options);
    const shift = frame.shift <= 8 ? frame.shift : 0;
    return this._patchSparklineFrame(path, frame, animate, context, [{ element: marker, point: frame.path ? frame.coords.at(-1) : null }], shift);
  },

  // 纵轴量程变化独立于横向滚动；用统一缩放保持点之间的关系，标记与曲线同步。
  _patchSparklineFrame(path, frame, animate, context, markers = [], shift = 0) {
    const svg = path.parentElement;
    const previous = path._sparklineState?.context === context ? path._sparklineState : null;
    if (previous && previous.signature === frame.signature) frame = previous;
    const allowed = animate && !!path.animate && svg.getClientRects().length > 0 && this._monitorMotionAllowed();
    const cancel = () => {
      for (const animation of svg.getAnimations?.({ subtree: true }) || []) {
        animation.onfinish = null;
        animation.cancel();
      }
    };
    if (frame === previous) {
      if (!allowed) {
        cancel(); path.setAttribute('d', frame.path);
        if (frame.renderPoints) frame.renderPoints = frame.renderPoints.slice(-42);
      }
      return frame;
    }
    const current = allowed && previous
      ? new DOMMatrixReadOnly(getComputedStyle(path).transform) : { d: 1, e: 0, f: 0 };
    cancel();
    frame.context = context;
    const renderPoints = frame.renderPoints;
    if (renderPoints) frame.renderPoints = renderPoints.slice(-42);
    path._sparklineState = frame;
    path.setAttribute('d', frame.path);
    for (const { element, point } of markers) {
      if (!element) continue;
      element.setAttribute('visibility', point ? 'visible' : 'hidden');
      if (point) for (const key of ['x1', 'x2', 'y1', 'y2']) element.setAttribute(key, point[key[0]]);
    }
    if (!allowed || !previous?.path || !frame.path || frame.points?.at(-1)?.step < previous.points?.at(-1)?.step) return frame;
    const ratio = (frame.bounds.high - frame.bounds.low) / (previous.bounds.high - previous.bounds.low);
    const offset = 30 * (1 - ratio) + (previous.bounds.low - frame.bounds.low) * 26 / (previous.bounds.high - previous.bounds.low);
    const scale = current.d * ratio, x = shift * 112 / 39 + current.e, y = current.d * offset + current.f;
    if (!shift && Math.abs(scale - 1) < 1e-9 && Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return frame;
    const start = `matrix(1,0,0,${scale},${x},${y})`;
    const keyframes = [{ transform: start }, { transform: 'matrix(1,0,0,1,0,0)' }];
    const options = { duration: shift ? 360 : 420, easing: 'cubic-bezier(.2,.75,.25,1)' };
    if (renderPoints && (shift || x > 1e-9)) {
      // 只裁去已在可视区域之外的点，更新再快也不提前截断左边仍可见的曲线。
      frame.renderPoints = renderPoints.slice(-(42 + Math.ceil(Math.max(0, x) / (112 / 39))));
      path.setAttribute('d', this._rollingSparklineGeometry(frame.renderPoints, frame.bounds).path);
    }
    const motion = path.animate(keyframes, options);
    motion.onfinish = () => {
      if (path._sparklineState !== frame) return;
      path.setAttribute('d', frame.path);
      if (frame.renderPoints) frame.renderPoints = frame.renderPoints.slice(-42);
    };
    for (const { element, point } of markers) if (point) element?.animate?.(keyframes, options);
    return frame;
  },

  _formatLearningRate(value, fallback) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    if (number === 0) return '0';
    const [mantissa, exponent] = number.toExponential(3).split('e');
    return Number(mantissa) + 'e' + Number(exponent);
  },

  _formatMonitorDuration(value, durationSeconds = null) {
    const raw = String(value == null ? '' : value).trim();
    const seconds = durationSeconds !== null && durationSeconds !== '' && Number.isFinite(Number(durationSeconds))
      ? Number(durationSeconds) : this._monitorDurationSeconds(raw);
    if (seconds === null) return raw || '—';
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    const remainder = total % 60;
    const pad = part => String(part).padStart(2, '0');
    return hours ? hours + ':' + pad(minutes) + ':' + pad(remainder) : minutes + ':' + pad(remainder);
  },

  _formatRunEndTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  },

  _parametersConsoleHtml(t) {
    const byKey = {};
    this.trainParams.forEach(param => { if (param.key) byKey[param.key] = param; });
    const keyDefs = [
      { key: 'pretrained_model_name_or_path', short: 'historyModel', basename: true }, { key: 'learning_rate', short: 'historyLR' },
      { key: 'network_dim', short: 'paramDim' }, { key: 'network_alpha', short: 'historyAlpha' },
      { key: 'max_train_epochs', short: 'historyEpochs' }, { key: 'optimizer_type', short: 'historyOptimizer' },
      { key: 'train_batch_size', short: 'historyBatch' }, { key: 'resolution', short: 'historyResolution' }, { key: 'seed', short: 'historySeed' },
    ];
    let html = '<section class="m-console-card m-parameters-console"><div class="m-card-heading"><div><span>' + this.esc(t('trainParams')) + '</span><small>' + this.trainParams.length + ' ' + this.esc(t('items')) + '</small></div></div>';
    html += '<div class="param-keygrid">';
    keyDefs.forEach(definition => {
      const param = byKey[definition.key];
      if (!param || param.value == null || param.value === '') return;
      let value = String(param.value);
      if (definition.basename) { const parts = value.replace(/\\/g, '/').split('/'); value = parts[parts.length - 1] || value; }
      if (definition.key === 'learning_rate' && Number.isFinite(Number(value))) value = this._formatLearningRate(value, value);
      // optimizer_type 用训练表单同款选项标签，避免历史 TOML 值（大小写不一致）直接露在摘要里
      if (definition.key === 'optimizer_type') value = this._fieldOptionLabel('optimizer_type', value, value);
      html += '<div class="param-key-item"><span class="param-key-icon">' + this._monitorIconHtml(definition.key) + '</span><span class="param-key-copy"><span class="param-key-label">' + this.esc(t(definition.short, definition.key)) + '</span><span class="param-key-value" title="' + this.esc(value) + '">' + this._paramValueHtml({ value, type: param.type }) + '</span></span></div>';
    });
    html += '</div>';
    html += '<div class="m-param-toolbar"><label class="m-param-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><input type="search" value="' + this.esc(this.monitorParamQuery || '') + '" placeholder="' + this.esc(t('parameterSearch')) + '" aria-label="' + this.esc(t('parameterSearch')) + '" @input="monitorParamQuery=$event.target.value;filterMonitorParams()"/></label><span class="m-param-match" data-param-match></span><button type="button" class="btn btn-sm btn-secondary" @click="setMonitorParamGroups(true)">' + this.esc(t('expandAll')) + '</button><button type="button" class="btn btn-sm btn-secondary" @click="setMonitorParamGroups(false)">' + this.esc(t('collapseAll')) + '</button></div>';
    const groups = {};
    const order = ['model','network','training','optimizer','regularization','caption','performance','save','preview','basic'];
    this.trainParams.forEach(param => { const group = param.section || param.group || ''; (groups[group] || (groups[group] = [])).push(param); });
    const keys = Object.keys(groups).sort((a, b) => { const ai = order.indexOf(a), bi = order.indexOf(b); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); });
    html += '<div class="m-param-groups">';
    keys.forEach(group => {
      const groupTitle = group && ['model','network','training','optimizer','regularization','caption','performance','save','preview'].includes(group) ? t('section.' + group, group) : (group || t('other'));
      html += '<details class="m-param-group"><summary><span>' + this.esc(groupTitle) + '</span><small>' + groups[group].length + '</small><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></summary><div class="m-param-list">';
      groups[group].forEach(param => {
        const rawLabel = param.label_raw || param.label || param.key || '';
        const searchText = (rawLabel + ' ' + (param.value == null ? '' : param.value)).toLowerCase();
        const title = this._paramTitle(param, t);
        html += '<div class="m-param-row" data-param-row data-search="' + this.esc(searchText) + '"><span class="param-label"' + (title ? ' title="' + this.esc(title) + '"' : '') + '>' + this._paramLabel(param) + '</span><span class="param-value">' + this._paramValueHtml(param) + '</span></div>';
      });
      html += '</div></details>';
    });
    html += '</div></section>';
    return html;
  },

  filterMonitorParams() {
    const root = document.getElementById('monitorTabContent');
    if (!root) return;
    const query = String(this.monitorParamQuery || '').trim().toLowerCase();
    let matches = 0;
    root.querySelectorAll('[data-param-row]').forEach(row => {
      const show = !query || String(row.dataset.search || '').includes(query);
      row.hidden = !show;
      if (show) matches++;
    });
    root.querySelectorAll('.m-param-group').forEach(group => {
      const count = group.querySelectorAll('[data-param-row]:not([hidden])').length;
      group.hidden = query ? count === 0 : false;
      if (query && count > 0) group.open = true;
    });
    const result = root.querySelector('[data-param-match]');
    if (result) result.textContent = query ? matches + ' ' + this.t('monitor.matches') : '';
  },

  setMonitorParamGroups(open) {
    const root = document.getElementById('monitorTabContent');
    if (!root) return;
    root.querySelectorAll('.m-param-group:not([hidden])').forEach(group => { group.open = !!open; });
  },
};
