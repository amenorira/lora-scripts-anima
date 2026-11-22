/* 训练摘要、配置快照与数值动画；由 monitor-render.js 装配。 */
window.monitorSummaryMixin = {
  // ═══════════════════════════════════════════════════════════
  //  概览标签
  // ═══════════════════════════════════════════════════════════

  _patchOverviewStatus(root, d, t, isHistory) {
    if (!d || !root) return;
    const motionContext = [isHistory ? this.selectedRunDir : (this.liveTaskId || d.active_task?.id || 'live'), isHistory, this._shellLocale || ''].join('|');
    const animate = !isHistory && root.dataset.motionContext === motionContext;
    root.dataset.motionContext = motionContext;
    root._metricMotion = animate;
    const { state, completed, terminal, running } = this._summaryStatus(d, isHistory);
    const liveControl = !isHistory && this.liveTaskId && this.controlTask === this.liveTaskId ? this.controlState : null;
    const reported = liveControl?.progress;
    const paused = liveControl?.state === 'paused';
    const total = Number(d.total_steps) || 0;
    const step = completed && total ? total : (Number(d.step) || 0);
    const stepSlot = String(Math.max(total, step)).length + 'ch';
    if (root.style.getPropertyValue('--m-step-slot') !== stepSlot) root.style.setProperty('--m-step-slot', stepSlot);
    const rawPercent = d.percent != null ? Number(d.percent) : (total ? step / total * 100 : 0);
    const percent = completed ? 100 : Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0));
    const lossSeries = this._summaryLossSeries();
    const lrSeries = window.selectMonitorLearningRateSeries(this.monitorLossSeries);
    const lrPoints = lrSeries && Array.isArray(lrSeries.points) ? lrSeries.points : [];
    const lrLatest = lrSeries && (lrSeries.latest != null ? Number(lrSeries.latest) : (lrPoints.length ? Number(lrPoints[lrPoints.length - 1].value) : null));
    const lrMax = lrSeries && (lrSeries.max != null ? Number(lrSeries.max) : (lrPoints.length ? Math.max(...lrPoints.map(point => Number(point.value)).filter(Number.isFinite)) : null));
    const lrRange = terminal && lrPoints.length >= 2 && Number.isFinite(lrMax) && Number.isFinite(lrLatest);
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
      const command = liveControl?.command;
      const transition = running && command?.status === 'pending' && {pause:'pausing', resume:'resuming', stop:'stopping'}[command.action];
      const phase = transition || (running && paused ? 'paused' : state.toLowerCase());
      const label = transition || phase === 'paused' || phase === 'stopped' ? this.t('control.' + phase) : stateLabels[state] || state;
      status.dataset.phase = phase;
      if (status.textContent !== label) status.textContent = label;
    }
    const stop = root.querySelector('[data-summary-stop]');
    if (stop) stop.hidden = isHistory || !this._isActiveState(state);
    const toggle = root.querySelector('[data-summary-toggle]');
    if (toggle) {
      const allowed = running && liveControl?.allowed;
      const action = allowed && (allowed.includes('resume') ? 'resume' : allowed.includes('pause') ? 'pause' : '');
      toggle.hidden = !action;
      if (action) {
        toggle.dataset.action = action;
        toggle.classList.toggle('m-cmd-resume', action === 'resume');
        toggle.classList.toggle('btn-secondary', action !== 'resume');
        toggle.setAttribute('aria-label', this.t('control.' + action));
        const label = toggle.querySelector('span');
        const text = this.t('control.' + action + 'Button');
        if (label.textContent !== text) label.textContent = text;
      }
    }
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
    const seriesLoss = lossPoints.at(-1);
    const metricsStep = reported?.metrics_step ?? reported?.step;
    const latestLoss = Number.isFinite(reported?.loss) && metricsStep >= (seriesLoss?.step ?? 0)
      ? {step:metricsStep, value:reported.loss} : seriesLoss;
    const avgLossSeries = this.monitorLossSeries.find(item => item.tag === 'loss/average');
    const avgLossPoints = this._cleanLossPoints(avgLossSeries && (avgLossSeries.diagnostic_points || avgLossSeries.points));
    const latestAvgLoss = avgLossPoints.at(-1) || (Number.isFinite(avgLossSeries?.latest) ? { value: Number(avgLossSeries.latest) } : null);
    set('loss', latestLoss ? this._formatDiagnosticValue(latestLoss.value) : (d.loss != null ? d.loss : '—'));
    // 每次实际显示新采样时记录比较基准；批量到达的中间 step 不冒充上次读数。
    const displayedLoss = root._displayedLoss;
    const sameLossContext = displayedLoss?.context === motionContext;
    if (isHistory || !sameLossContext || displayedLoss.point?.step !== latestLoss?.step || displayedLoss.point?.value !== latestLoss?.value) {
      root._displayedLoss = {
        context: motionContext,
        point: latestLoss,
        trend: this._summaryLossChange(lossSeries, isHistory ? undefined : (sameLossContext ? (displayedLoss.point ?? null) : null), latestLoss),
      };
    }
    const lossTrend = root._displayedLoss.trend;
    const lossChange = root.querySelector('[data-summary-loss-change]');
    if (lossChange) {
      lossChange.hidden = !lossTrend;
      if (lossTrend) this._patchLossChange(lossChange, lossTrend.percent, t(isHistory ? 'lossVsPreviousSample' : 'lossVsPreviousDisplay'), animate);
    }
    const lossMetaText = latestLoss ? t('lossUpdatedAt').replace('{n}', latestLoss.step) : t('recentLoss');
    set('loss-meta', lossMetaText);
    const showReportedLr = Number.isFinite(reported?.lr) && metricsStep >= (lrPoints.at(-1)?.step ?? 0);
    set('lr', this._formatLearningRate(showReportedLr ? reported.lr : lrLatest ?? (isHistory ? null : d.lr), '—'));
    const lrRangeEl = root.querySelector('[data-summary-field="lr-range"]');
    if (lrRangeEl) {
      lrRangeEl.hidden = !lrRange;
      if (lrRange) lrRangeEl.textContent = t('lrPeak') + ' ' + this._formatLearningRate(lrMax, '—');
    }
    set('lr-meta', this._summarySchedulerMeta(t, total) || (lrRange && completed && lrLatest === 0 ? t('schedulerFinished') : ''));
    set('speed', d.speed || '—');
    const wait = !isHistory && running ? liveControl?.timing?.data_wait_ratio : null;
    const telemetrySamples = this._summaryTelemetrySamples(isHistory).samples;
    const validSpeeds = telemetrySamples.map(sample => sample.speedSec).filter(value => Number.isFinite(value) && value > 0);
    const avgSpeedSec = validSpeeds.length >= 2 ? validSpeeds.reduce((sum, value) => sum + value, 0) / validSpeeds.length : null;
    const speedLabel = Number.isFinite(wait)
      ? t('speedComputeWait').replace('{compute}', Math.round((1 - Math.max(0, Math.min(1, wait))) * 100)).replace('{wait}', Math.round(Math.max(0, Math.min(1, wait)) * 100))
      : (avgSpeedSec ? t('speedAvgShort').replace('{v}', this._formatSpeedFromSeconds(avgSpeedSec, d.speed)) : t(!isHistory && running && !paused ? 'currentSpeed' : 'lastSpeed'));
    set('speed-meta', speedLabel);
    const speedMeta = root.querySelector('[data-summary-field="speed-meta"]');
    if (speedMeta) {
      speedMeta.title = Number.isFinite(wait)
        ? this.t('control.waitShare').replace('{pct}', (wait * 100).toFixed(1) + '%') + '\n' + this.t('control.waitHint')
        : '';
    }
    this._patchSummaryTime(root, d, t, isHistory, animate);
    const progress = root.querySelector('[data-overview-progress]');
    if (progress) {
      progress.style.width = percent + '%';
      progress.parentElement.setAttribute('aria-valuenow', String(percent));
    }
    const live = running && !paused;
    this._patchSummaryLossProfile(root, lossSeries || avgLossSeries, latestAvgLoss?.value ?? null, live, t, animate);
    this._patchSummaryLrProfile(root, lrSeries, total, live, t);
    const matrixVersion = [this.lossDataVersion, this.trainParamsVersion, total, step, percent, d.epoch, live, completed, motionContext].join('|');
    if (root.dataset.matrixVersion !== matrixVersion) {
      root.dataset.matrixVersion = matrixVersion;
      this._patchSummaryTimeViz(root, d, total, step, percent, completed, live, t, animate);
    }
    this._bindSummaryVizInteractions(root);
    this._patchSummaryTelemetry(root, t, isHistory, wait, running && !paused);
    this._patchTrainingDiagnostics(root, t, d, isHistory);
  },

  _patchSummaryTime(root, d, t, isHistory, animate) {
    const { terminal, running } = this._summaryStatus(d, isHistory);
    const result = terminal && d.train_result;
    const paused = !isHistory && running && this.controlState?.state === 'paused';
    const elapsed = !isHistory && running && !paused ? this._observeMonitorClock(d) : this._monitorDurationSeconds(d.elapsed);
    const duration = this._formatMonitorDuration(result?.duration_str || d.elapsed || '—', result ? result.duration_sec : elapsed);
    const eta = d.eta ? this._formatMonitorDuration(d.eta) : '';
    const showRemaining = running && !paused && !!eta;
    const endedAt = result?.ended_at ? this._formatRunEndTime(result.ended_at) : '';
    const formattedEnd = endedAt ? String(endedAt).replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})$/, '$1\n$2') : '';
    const timeMeta = showRemaining ? t('elapsed') + ' ' + duration : (formattedEnd ? t('endedAt') + ' ' + formattedEnd : '');
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
    if (this.trainParams.length) html += this._parametersConsoleHtml(t, d);
    else if (!running) html += '<div class="m-console-card m-empty-params"><div class="m-card-heading"><span>' + this.esc(t('trainingConfig')) + '</span></div><div class="dashboard-empty dashboard-empty-compact"><p>' + this.esc(t(isHistory ? 'noSavedParams' : 'noParamsHint')) + '</p></div></div>';
    return html;
  },

  _overviewMetricsHtml(d, t, isHistory) {
    const { state } = this._summaryStatus(d, isHistory);
    let html = '<section class="m-console-card m-overview-metrics">';
    html += '<div class="m-card-heading m-summary-heading"><div class="m-summary-title"><span>' + this.esc(t('runSummary')) + '</span>' + (isHistory ? '' : '<span class="m-summary-state" data-summary-state role="status"></span>') + '</div>';
    html += '<div class="m-summary-actions">';
    if (!isHistory) {
      html += `
        <button type="button" class="btn btn-sm btn-secondary m-summary-command" data-summary-toggle hidden
          :aria-disabled="controlSubmitting || controlState?.command?.status === 'pending' || trainingStopping === liveTaskId"
          @click="submitTrainingControl($el.dataset.action)">
          <svg viewBox="0 0 16 16" aria-hidden="true"><g class="m-icon-pause"><rect x="3.5" y="3" width="3.2" height="10" rx="0.8"/><rect x="9.3" y="3" width="3.2" height="10" rx="0.8"/></g><path class="m-icon-resume" d="M4.5 3.1a.6.6 0 0 1 .9-.52l8.1 4.9a.6.6 0 0 1 0 1.04l-8.1 4.9a.6.6 0 0 1-.9-.52z"/></svg><span></span>
        </button>
        <button type="button" class="btn btn-sm btn-secondary m-summary-command m-cmd-stop" data-summary-stop hidden aria-haspopup="dialog"
          aria-label="${this.esc(t('stopTraining'))}" :disabled="trainingStopping === (liveTaskId || taskId)" @click="stopTraining()">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2"/></svg><span>${this.esc(this.t('control.stopButton'))}</span>
        </button>`;
    }
    if (isHistory || this._isActiveState(state)) html += this._summaryActionMenuHtml(isHistory);
    html += '</div></div>';
    if (!isHistory) html += '<div class="m-summary-notice" data-summary-notice hidden role="alert"></div>';
    if (!isHistory && state === 'UNKNOWN') return html + '</section>';
    if (!isHistory && state === 'IDLE') {
      html += '<div class="m-idle-hero"><span class="m-idle-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9l6 3"/><circle cx="12" cy="12" r="9"/></svg></span><div><strong>' + this.esc(t('noTraining')) + '</strong></div></div>';
      html += '<button type="button" class="btn btn-primary m-start-training" @click="navigate(\'train-basic\')">' + this.esc(t('goToTraining')) + ' →</button>';
      if (d.last_config && d.last_config.name) {
        const lc = d.last_config;
        html += '<div class="m-last-run"><span>' + this.esc(t('lastTraining')) + '</span><strong>' + this.esc(lc.name) + '</strong><small>' + this.esc((lc.model || '') + ' · ' + t('historyLR') + ' ' + (lc.lr || '--') + ' · ' + t('historyEpochs') + ' ' + (lc.epochs || '--')) + '</small></div>';
      }
      html += '</section>';
      return html;
    }
    html += '<div class="m-summary-progress"><div class="m-summary-progress-top"><span>' + this.esc(t('overallProgress')) + '</span><div class="m-summary-progress-figures"><strong data-summary-field="step"></strong><b data-summary-field="percent"></b></div></div>';
    html += '<div class="m-overview-progress" role="progressbar" aria-label="' + this.esc(t('overallProgress')) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-overview-progress></i></div>';
    html += '<div class="m-summary-progress-bottom"><span data-summary-field="epoch"></span>';
    if (!isHistory) html += `<span role="status" x-text="controlTask === liveTaskId && controlState?.command?.status === 'pending' && ['save','save_state','sample'].includes(controlState.command.action) ? t(controlState.command.action === 'sample' && controlState.command.phase === 'encoding' ? 'control.encodingPending' : 'control.' + controlState.command.action + 'Pending') : (controlState?.state === 'paused' && controlState.replica ? t('control.replica') : '')"></span>`;
    html += '</div></div>';
    html += '<div class="m-live-metrics">';
    html += this._summaryTileHtml('loss', t('currentLoss'), t('recentLoss'), t('lossPulseHint'));
    html += this._summaryTileHtml('lr', t('lr'), '', t('lrRecordedProfileHint'));
    html += this._summaryTileHtml('speed', t('speed'), t('currentSpeed'), t('speedCadenceHint'));
    html += this._summaryTileHtml('time', t('elapsed'), '');
    html += '</div></section>';
    return html;
  },

  _summaryActionMenuHtml(isHistory) {
    if (isHistory) {
      return `<button type="button" class="btn btn-sm btn-secondary m-summary-command" data-control-action="restore"
        x-show="runDetailData?.resume_state" x-cloak :disabled="!!historyReuseBusy"
        @click="reuseConfig(selectedRunDir, null, runDetailData.resume_state, runDetailData.resume_step)"
        x-text="runDetailData?.resume_step == null ? t('control.resumeFrom') : t('control.resumeStep').replace('{step}', runDetailData.resume_step)"></button>`;
    }
    const label = this.esc(this.t('control.more'));
    const visible = "liveTaskId && controlTask === liveTaskId && ['sample','save','save_state'].some(a => controlState?.allowed?.includes(a))";
    const sampleIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="1.5"/><path d="m4 17 5-5 3 3 3-4 6 7"/></svg>';
    const saveIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>';
    const stateIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    const items = `<button type="button" role="menuitem" tabindex="-1" data-control-action="sample"
        x-show="controlState?.allowed?.includes('sample')"
        :disabled="controlSubmitting || controlState?.command?.status === 'pending'"
        @click="close(); openTrainingControl('sample')">${sampleIcon}<span x-text="t('control.previewTitle')"></span></button>
      <button type="button" role="menuitem" tabindex="-1" data-control-action="save"
        x-show="controlState?.allowed?.includes('save')"
        :disabled="controlSubmitting || controlState?.command?.status === 'pending'"
        @click="close(); submitTrainingControl('save')">${saveIcon}<span x-text="t('control.save')"></span></button>
      <button type="button" role="menuitem" tabindex="-1" data-control-action="save_state"
        x-show="controlState?.allowed?.includes('save_state')"
        :disabled="controlSubmitting || controlState?.command?.status === 'pending'"
        @click="close(); submitTrainingControl('save_state')">${stateIcon}<span x-text="t('control.save_state')"></span></button>`;
    return `<div class="m-summary-menu" x-data="actionMenu" x-show="${visible}" x-cloak :class="{open}" @keydown="key($event)" @click.outside="close(false)" @focusout="focusOut($event)">
      <button type="button" class="btn btn-sm btn-secondary m-summary-command" data-summary-menu x-ref="trigger" title="${label}" aria-label="${label}" aria-haspopup="menu" :aria-expanded="open" aria-controls="summary-action-list" @click="toggle()">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.2" cy="8" r="1.35"/><circle cx="8" cy="8" r="1.35"/><circle cx="12.8" cy="8" r="1.35"/></svg>
      </button>
      <div id="summary-action-list" class="field-menu-popup" x-ref="menu" x-show="open" :class="{'is-positioned':positioned}" :inert="!open" role="menu" aria-label="${label}" x-cloak>${items}</div>
    </div>`;
  },

  // 所有卡片共用生命周期解释；状态只影响文案与交互，不改变曲线的指标定义。
  _summaryStatus(d, isHistory) {
    let state = isHistory ? 'UNKNOWN' : (d.state || 'IDLE');
    if (isHistory && d.train_result && d.train_result.status) {
      const status = String(d.train_result.status).toUpperCase();
      state = { COMPLETED: 'FINISHED', FINISHED: 'FINISHED', ERROR: 'FAILED', TIMEOUT: 'FAILED', FAILED: 'FAILED', TERMINATED: 'TERMINATED', STOPPED: 'STOPPED' }[status] || 'UNKNOWN';
    }
    return { state, running: state === 'RUNNING', completed: state === 'FINISHED', terminal: isHistory || ['FINISHED', 'FAILED', 'TERMINATED', 'STOPPED'].includes(state) };
  },

  _summaryTileHtml(key, label, meta, scaleHint = '') {
    let html = '<div class="m-live-metric m-live-metric-' + key + '"' + (scaleHint ? ' title="' + this.esc(scaleHint) + '"' : '') + '>';
    html += '<div class="m-metric-head"><span class="m-metric-label">' + this._monitorIconHtml(key) + '<span' + (key === 'time' ? ' data-summary-field="time-label"' : '') + '>' + this.esc(label) + '</span></span><span class="m-metric-hud" data-summary-hud aria-hidden="true"></span></div>';
    html += '<div class="m-metric-reading"><strong data-summary-field="' + key + '">—</strong>';
    if (key === 'loss') html += '<span class="m-metric-change" data-summary-loss-change hidden></span>';
    if (key === 'lr') html += '<span class="m-metric-range" data-summary-field="lr-range" hidden></span>';
    html += '</div><div class="m-metric-viz m-metric-viz-' + key + '" data-summary-viz="' + key + '" hidden></div>';
    html += '<small data-summary-field="' + key + '-meta">' + this.esc(meta) + '</small>';
    return html + '</div>';
  },

  _summaryTelemetrySamples(isHistory) {
    const source = [isHistory, isHistory ? this.selectedRunDir : (this.liveTaskId || this.monitorData?.active_task?.id || 'live')].join('|');
    const version = [source, isHistory ? this._runDetailRequestSeq : this._monitorPerfVersion].join('|');
    const samples = isHistory ? this.runDetailData?.perf_samples : this.monitorPerfSamples;
    return { version, samples: (samples || []).slice(-40) };
  },

  _formatSpeedFromSeconds(seconds, sampleText = '') {
    if (!Number.isFinite(seconds) || seconds <= 0) return '—';
    const preferItPerSec = /it\/s/i.test(String(sampleText || '')) || seconds < 1;
    if (preferItPerSec) return (1 / seconds).toFixed(2) + 'it/s';
    return seconds.toFixed(2) + 's/it';
  },

  _downsampleSeriesPoints(points, maxPoints = 72) {
    if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
    const lastIndex = points.length - 1;
    let minIdx = 0, maxIdx = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].value < points[minIdx].value) minIdx = i;
      if (points[i].value > points[maxIdx].value) maxIdx = i;
    }
    const indices = new Set([0, lastIndex, minIdx, maxIdx]);
    const stride = lastIndex / Math.max(1, maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) indices.add(Math.min(lastIndex, Math.round(i * stride)));
    return Array.from(indices).sort((a, b) => a - b).map(i => points[i]);
  },

  // 单调限幅平滑样条：保证折线顺滑有机，且在预热拐点与平直段绝不过冲。
  _smoothSplinePath(coords, tension = 0.2) {
    if (!coords.length) return '';
    if (coords.length === 1) return `M${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
    if (coords.length === 2) return `M${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)} L${coords[1].x.toFixed(1)} ${coords[1].y.toFixed(1)}`;
    let d = `M${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
    for (let i = 0; i < coords.length - 1; i++) {
      const p0 = coords[Math.max(0, i - 1)];
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const p3 = coords[Math.min(coords.length - 1, i + 2)];
      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);
      const cp1x = Math.min(p2.x, p1.x + (p2.x - p0.x) * tension);
      const cp1y = Math.max(minY, Math.min(maxY, p1.y + (p2.y - p0.y) * tension));
      const cp2x = Math.max(p1.x, p2.x - (p3.x - p1.x) * tension);
      const cp2y = Math.max(minY, Math.min(maxY, p2.y - (p3.y - p1.y) * tension));
      d += ` C${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  },

  // 青色 · 右下底边漫入式 Loss 平滑波形（左侧渐隐融入，无悬空底线）
  _patchSummaryLossProfile(root, series, avgValue, isLiveRunning, t, animate) {
    const host = root.querySelector('[data-summary-viz="loss"]');
    if (!host) return;
    const source = series?.diagnostic_points || series?.points;
    const last = host._profile;
    if (last && last.source === source && last.avgValue === avgValue && last.live === isLiveRunning) return;
    host._profile = { source, avgValue, live: isLiveRunning };
    const raw = this._cleanLossPoints(source).slice(-30);
    if (raw.length < 2) { host.hidden = true; host.innerHTML = ''; return; }
    // 轻度三点加权平滑用于轮廓造型，悬停仍读取真实单步数值。
    const display = raw.map((pt, i) => {
      const prev = raw[Math.max(0, i - 1)].value;
      const next = raw[Math.min(raw.length - 1, i + 1)].value;
      const smooth = i === 0 || i === raw.length - 1 ? pt.value : prev * 0.22 + pt.value * 0.56 + next * 0.22;
      return { step: pt.step, value: pt.value, yVal: smooth };
    });
    const yVals = display.map(p => p.yVal);
    const meanVal = Number.isFinite(avgValue) ? avgValue : yVals.reduce((s, v) => s + v, 0) / yVals.length;
    const minV = Math.min(...yVals, meanVal);
    const maxV = Math.max(...yVals, meanVal);
    const pad = Math.max((maxV - minV) * 0.24, Math.abs(meanVal) * 0.1, 1e-6);
    const low = Math.max(0, minV - pad * 0.85);
    const high = maxV + pad;
    const span = Math.max(high - low, 1e-9);
    const vbW = 200, vbH = 92;
    const xStart = 6, xEnd = 188;
    const toX = idx => xStart + (idx / Math.max(1, display.length - 1)) * (xEnd - xStart);
    const toY = v => 72 - ((v - low) / span) * 42;
    const coords = display.map((pt, i) => ({ x: toX(i), y: toY(pt.yVal), step: pt.step, value: pt.value }));
    const lineD = this._smoothSplinePath(coords, 0.2);
    const lastPt = coords[coords.length - 1];
    const firstPt = coords[0];
    const areaD = lineD + ` L${lastPt.x.toFixed(1)} ${vbH} L${firstPt.x.toFixed(1)} ${vbH} Z`;
    const meanY = Math.max(24, Math.min(76, toY(meanVal))).toFixed(1);
    const slotW = (xEnd - xStart) / Math.max(1, coords.length - 1);
    const gradId = 'm-loss-grad-' + (this.selectedRunDir ? 'h' : 'l');
    const guideId = 'm-loss-guide-' + (this.selectedRunDir ? 'h' : 'l');
    let hits = '';
    host._hudIndexChars = String(Math.round(lastPt.step)).length;
    host._hudValueChars = 0;
    coords.forEach((pt, idx) => {
      const k = `Step ${Math.round(pt.step)}`;
      const v = this._formatDiagnosticValue(pt.value);
      host._hudValueChars = Math.max(host._hudValueChars, v.length);
      hits += `<g class="m-viz-item" data-viz-idx="${idx}" data-viz-key="${this.esc(k)}" data-viz-val="${this.esc(v)}"><rect class="m-viz-hit" x="${(pt.x - slotW / 2).toFixed(1)}" y="14" width="${Math.max(4, slotW).toFixed(1)}" height="${vbH - 14}"/><line class="m-viz-guide" x1="${pt.x.toFixed(1)}" x2="${pt.x.toFixed(1)}" y1="${Math.max(16, pt.y - 6).toFixed(1)}" y2="${vbH}" stroke="url(#${guideId})"/><circle class="m-viz-hover-dot is-loss" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.4"/></g>`;
    });
    host.hidden = false;
    host.innerHTML = `<svg class="m-viz-svg m-loss-profile-svg" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity=".1"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${guideId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity=".72"/>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line class="m-loss-mean-line" x1="${xStart}" x2="${xEnd}" y1="${meanY}" y2="${meanY}"/>
      <path class="m-loss-area" fill="url(#${gradId})" d="${areaD}"/>
      <path class="m-loss-line" d="${lineD}"/>
      ${isLiveRunning ? `<circle class="m-loss-pulse" cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="5.6"/>` : ''}
      <circle class="m-loss-dot" cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.9"/>
      ${hits}
    </svg>`;
    const tile = host.closest?.('.m-live-metric');
    if (tile) {
      const avgNote = Number.isFinite(avgValue) ? ' (' + t('lossAvgShort').replace('{v}', this._formatDiagnosticValue(avgValue)) + ')' : '';
      tile.setAttribute('title', t('lossPulseHint') + avgNote);
    }
    this._restoreSummaryVizHover(host);
    if (animate && this._monitorMotionAllowed()) {
      host.querySelector('.m-loss-dot')?.animate?.(
        [{ transform: 'scale(1.45)', opacity: .72 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
    }
  },

  // 紫色 · 学习率全程调度曲线（确定性调度器预测虚线轨迹 + 实线已记录轨迹）
  _projectLrSchedule(lrPoints, totalSteps) {
    if (!lrPoints.length || !totalSteps) return [];
    const last = lrPoints[lrPoints.length - 1];
    if (!Number.isFinite(last.step) || !Number.isFinite(last.value) || last.step >= totalSteps) return [];
    const { params, scheduler, rawWarmup, optimizer, adaptive, parameterScaled } = this._summarySchedule();
    if (adaptive || parameterScaled || optimizer.endsWith('schedulefree') || params.get('lr_scheduler_type')) return [];
    if (!['constant', 'constant_with_warmup', 'linear', 'cosine', 'cosine_with_restarts', 'polynomial', 'inverse_sqrt'].includes(scheduler)) return [];
    for (const key of params.keys()) {
      if (key.startsWith('lr_scheduler_args.') && !(scheduler === 'polynomial' && key === 'lr_scheduler_args.lr_end')) return [];
    }
    const run = this.selectedRunDir ? this.runDetailData : this.monitorData;
    if (!run?.gpu_processes && (rawWarmup > 0 || scheduler === 'inverse_sqrt')) return [];
    const schedulerSteps = totalSteps * (run?.gpu_processes || 1);
    const warmup = rawWarmup > 0 && rawWarmup < 1 ? Math.floor(rawWarmup * schedulerSteps) : rawWarmup;
    const curve = {
      scheduler, totalSteps: schedulerSteps, warmupFraction: warmup / schedulerSteps,
      cycles: Number(params.get('lr_scheduler_num_cycles') ?? 1),
      power: Number(params.get('lr_scheduler_power') ?? 1),
      timescale: Number(params.get('lr_scheduler_timescale') ?? (warmup || 10000)),
      endRatio: Number(params.get('lr_scheduler_args.lr_end') ?? 1e-7) / Number(params.get('learning_rate')),
    };
    if (scheduler === 'polynomial' && !(curve.endRatio >= 0 && curve.endRatio < 1 && curve.power > 0 && warmup < schedulerSteps)) return [];
    const factorAt = step => window.trainingLrPreviewMixin._lrPreviewMultiplier(step / totalSteps, curve);
    const scale = last.value / factorAt(last.step);
    if (!Number.isFinite(scale) || scale <= 0) return [];
    const steps = new Set([totalSteps]);
    const add = step => { if (step > last.step && step <= totalSteps) steps.add(step); };
    for (let i = 1; i < 24; i++) add(last.step + (totalSteps - last.step) * i / 24);
    const warmupEnd = totalSteps * curve.warmupFraction;
    add(warmupEnd);
    if (scheduler === 'cosine_with_restarts' && warmupEnd < totalSteps) {
      const period = (totalSteps - warmupEnd) / curve.cycles;
      const first = Math.max(0, Math.floor((last.step - warmupEnd) / period));
      if (!Number.isSafeInteger(curve.cycles) || curve.cycles < 1 || curve.cycles - first > 24) return [];
      for (let i = first; i < curve.cycles; i++) {
        const start = warmupEnd + i * period;
        add(Math.ceil(start));
        add(start + period / 2);
        add(Math.ceil(warmupEnd + (i + 1) * period) - 1);
      }
    }
    return [last, ...Array.from(steps).sort((a, b) => a - b).map(step => ({step, value: factorAt(step) * scale}))];
  },

  _patchSummaryLrProfile(root, lrSeries, totalSteps, isLiveRunning, t) {
    const host = root.querySelector('[data-summary-viz="lr"]');
    if (!host) return;
    const source = lrSeries?.points || lrSeries?.diagnostic_points;
    const run = this.selectedRunDir ? this.runDetailData : this.monitorData;
    const version = [totalSteps, run?.gpu_processes, this.trainParamsVersion, isLiveRunning].join('|');
    if (host._profile?.version === version && host._profile.source === source) return;
    host._profile = { source, version };
    const allPoints = this._cleanLossPoints(source);
    if (allPoints.length < 2) { host.hidden = true; host.innerHTML = ''; return; }
    const past = this._downsampleSeriesPoints(allPoints, 64);
    const future = this._projectLrSchedule(past, totalSteps);
    const minStep = past[0].step <= Math.max(20, (totalSteps || 0) * 0.08) ? 0 : past[0].step;
    const maxStep = Math.max(totalSteps || 0, past[past.length - 1].step, minStep + 1);
    const maxVal = Math.max(...past.map(p => p.value), ...future.map(p => p.value), 1e-12) * 1.15;
    const vbW = 200, vbH = 92;
    const xStart = 6, xEnd = 188;
    const toX = s => xStart + ((s - minStep) / (maxStep - minStep)) * (xEnd - xStart);
    const toY = v => 72 - (Math.max(0, v) / maxVal) * 52;
    const pastCoords = past.map(p => ({ x: toX(p.step), y: toY(p.value), step: p.step, value: p.value }));
    const pastD = this._smoothSplinePath(pastCoords, 0.14);
    const lastPt = pastCoords[pastCoords.length - 1];
    const firstPt = pastCoords[0];
    const areaD = pastD + ` L${lastPt.x.toFixed(1)} ${vbH} L${firstPt.x.toFixed(1)} ${vbH} Z`;
    const futureCoords = future.map(p => ({ x: toX(p.step), y: toY(p.value) }));
    const futureD = futureCoords.length >= 2 ? this._smoothSplinePath(futureCoords, 0.16) : '';
    const slotW = Math.max(3, (lastPt.x - firstPt.x) / Math.max(1, pastCoords.length - 1));
    const gradId = 'm-lr-grad-' + (this.selectedRunDir ? 'h' : 'l');
    const guideId = 'm-lr-guide-' + (this.selectedRunDir ? 'h' : 'l');
    host._hudIndexChars = String(Math.round(maxStep)).length;
    host._hudValueChars = 0;
    const lrHits = pastCoords.map((pt, idx) => {
      const k = `Step ${Math.round(pt.step)}`;
      const v = this._formatLearningRate(pt.value, '—');
      host._hudValueChars = Math.max(host._hudValueChars, v.length);
      return `<g class="m-viz-item" data-viz-idx="${idx}" data-viz-key="${this.esc(k)}" data-viz-val="${this.esc(v)}"><rect class="m-viz-hit" x="${(pt.x - slotW / 2).toFixed(1)}" y="6" width="${slotW.toFixed(1)}" height="${vbH - 6}"/><line class="m-viz-guide" x1="${pt.x.toFixed(1)}" x2="${pt.x.toFixed(1)}" y1="${Math.max(10, pt.y - 6).toFixed(1)}" y2="${vbH}" stroke="url(#${guideId})"/><circle class="m-viz-hover-dot is-lr" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.4"/></g>`;
    }).join('');
    host.hidden = false;
    host.innerHTML = `<svg class="m-viz-svg m-lr-profile-svg" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--section-training)" stop-opacity=".1"/>
          <stop offset="100%" stop-color="var(--section-training)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${guideId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--lr-viz-color)" stop-opacity=".72"/>
          <stop offset="100%" stop-color="var(--lr-viz-color)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="m-lr-area" fill="url(#${gradId})" d="${areaD}"/>
      ${futureD ? `<path class="m-lr-future" d="${futureD}"/>` : ''}
      <path class="m-lr-past" d="${pastD}"/>
      ${isLiveRunning ? `<circle class="m-lr-pulse" cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="5.6"/>` : ''}
      <circle class="m-lr-dot" cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="2.9"/>
      ${lrHits}
    </svg>`;
    const tile = host.closest?.('.m-live-metric');
    if (tile) tile.setAttribute('title', t(futureD ? 'lrScheduleProfileHint' : 'lrRecordedProfileHint'));
    this._restoreSummaryVizHover(host);
  },

  // 翠绿 · 右下底边漫入式细竖脉冲纹（平稳时呈柔和渐升绿纹，卡顿掉速即明显凹陷标黄）+ 实时等待占比底边细线
  _patchSummaryTelemetry(root, t, isHistory, waitRatio = null, isLiveRunning = false) {
    const telemetry = this._summaryTelemetrySamples(isHistory);
    const waitKey = Number.isFinite(waitRatio) ? Math.round(waitRatio * 1000) : 'none';
    const version = [telemetry.version, waitKey, isLiveRunning ? 1 : 0, this._shellLocale || ''].join('|');
    if (root.dataset.telemetryVersion === version) return;
    root.dataset.telemetryVersion = version;
    const host = root.querySelector('[data-summary-viz="speed"]');
    if (!host) return;
    const samples = telemetry.samples.filter(s => Number.isFinite(s.speedSec) && s.speedSec > 0).slice(-26);
    const hasWait = Number.isFinite(waitRatio);
    const tile = host.closest?.('.m-live-metric');
    if (samples.length < 2 && !hasWait) {
      host.hidden = true;
      host.innerHTML = '';
      tile?.removeAttribute('title');
      return;
    }

    let svgHtml = '';
    host._hudIndexChars = String(samples.at(-1)?.step || 0).length;
    host._hudValueChars = 0;
    if (samples.length >= 2) {
      const sampleSpeedText = this.selectedRunDir ? this.runDetailData?.speed : this.monitorData?.speed;
      const rates = samples.map(s => ({ step: s.step, sec: s.speedSec, rate: 1 / s.speedSec }));
      const avgRate = rates.reduce((sum, r) => sum + r.rate, 0) / rates.length;
      const vbW = 200, vbH = 92;
      const floorY = hasWait ? 82 : 92;
      const maxBarH = hasWait ? 54 : 62;
      const baseBarH = hasWait ? 38 : 44;
      const count = rates.length;
      const barW = 3.8;
      const xRight = 188;
      const stepX = Math.min(7.2, (xRight - 10) / Math.max(1, count - 1));
      const xStart = xRight - stepX * (count - 1);
      const gradId = 'm-speed-bar-grad-' + (isHistory ? 'h' : 'l');
      const slowGradId = 'm-speed-slow-grad-' + (isHistory ? 'h' : 'l');
      let bars = '';
      rates.forEach((r, idx) => {
        // 以平均速度为基准（1.0 → baseBarH），平稳时整齐舒展，提速略高，卡顿掉速明显下凹并转暖琥珀警示。
        const rel = r.rate / Math.max(avgRate, 1e-6);
        const isSlow = rel < 0.8;
        const barH = Math.max(12, Math.min(maxBarH, baseBarH + (rel - 1) * baseBarH * 1.45));
        const cx = xStart + idx * stepX;
        const y = floorY - barH;
        const recency = count > 1 ? idx / (count - 1) : 1;
        const alpha = (0.46 + recency * 0.52).toFixed(2);
        const isLatest = idx === count - 1;
        const k = `Step ${Math.round(r.step)}`;
        const v = this._formatSpeedFromSeconds(r.sec, sampleSpeedText);
        host._hudValueChars = Math.max(host._hudValueChars, v.length);
        bars += `<g class="m-viz-item m-speed-bar-item${isLatest ? ' is-latest' : ''}${isSlow ? ' is-slow' : ''}" data-viz-idx="${idx}" data-viz-key="${this.esc(k)}" data-viz-val="${this.esc(v)}">
          <rect class="m-viz-hit" x="${(cx - stepX / 2).toFixed(1)}" y="10" width="${Math.max(stepX, barW + 2).toFixed(1)}" height="${floorY - 10}"/>
          <rect class="m-speed-bar" x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${(floorY - y).toFixed(1)}" rx="1.9" fill="url(#${isSlow ? slowGradId : gradId})" style="--bar-alpha:${alpha}"/>
          <circle class="m-speed-hover-dot" cx="${cx.toFixed(1)}" cy="${Math.max(12, y - 5).toFixed(1)}" r="2"/>
        </g>`;
      });
      svgHtml = `<svg class="m-viz-svg m-speed-profile-svg${isLiveRunning ? ' is-live' : ''}" viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--speed-viz-color)" stop-opacity=".72"/>
            <stop offset="68%" stop-color="var(--speed-viz-color)" stop-opacity=".24"/>
            <stop offset="100%" stop-color="var(--speed-viz-color)" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="${slowGradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--warning)" stop-opacity=".8"/>
            <stop offset="68%" stop-color="var(--warning)" stop-opacity=".24"/>
            <stop offset="100%" stop-color="var(--warning)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${bars}
      </svg>`;
    }

    let waitHtml = '';
    if (hasWait) {
      const clampedWait = Math.max(0, Math.min(1, waitRatio));
      const computePct = Math.round((1 - clampedWait) * 100);
      const waitPct = Math.round(clampedWait * 100);
      const tip = t('speedComputeWait').replace('{compute}', computePct).replace('{wait}', waitPct);
      const waitKeyLabel = t('speedComputeShort') + ' / ' + t('speedWaitShort');
      waitHtml = `<div class="m-speed-wait-bar" data-viz-idx="wait" data-viz-key="${this.esc(waitKeyLabel)}" data-viz-val="${computePct}% / ${waitPct}%" title="${this.esc(tip)}">
        <i class="m-speed-wait-compute" style="width:${(100 - clampedWait * 100).toFixed(1)}%"></i>
        <i class="m-speed-wait-io" style="width:${(clampedWait * 100).toFixed(1)}%"></i>
      </div>`;
      if (tile) tile.setAttribute('title', samples.length >= 2 ? t('speedCadenceHint') : tip);
    } else if (tile) {
      tile.setAttribute('title', t('speedCadenceHint'));
    }

    host.hidden = false;
    host.innerHTML = svgHtml + waitHtml;
    this._restoreSummaryVizHover(host);
    if (isLiveRunning && this._monitorMotionAllowed()) {
      host.querySelector('.m-speed-bar-item.is-latest .m-speed-bar')?.animate?.(
        [{ transform: 'scaleY(0.76)', opacity: .65 }, { transform: 'scaleY(1)', opacity: 1 }],
        { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
    }
  },

  _parseEpochProgress(d, totalSteps, step, completed, percent) {
    const raw = String(d.epoch ?? '').trim();
    const match = raw.match(/^(\d+)\s*(?:\/\s*(\d+))?$/);
    const paramEpochs = Number((this.trainParams || []).find(param => param.key === 'max_train_epochs')?.value);
    const currentEpoch = match ? Number(match[1]) : 0;
    const totalEpochs = match && match[2] ? Number(match[2]) : (Number.isInteger(paramEpochs) && paramEpochs > 0 ? paramEpochs : 0);
    let epochFraction = 0;
    if (completed || percent >= 99.9) {
      epochFraction = 1;
    } else if (totalEpochs > 0 && totalSteps > 0 && step >= 0) {
      const stepsPerEpoch = totalSteps / totalEpochs;
      const doneEpochs = Math.max(0, currentEpoch - 1);
      epochFraction = Math.max(0.06, Math.min(1, (step - doneEpochs * stepsPerEpoch) / Math.max(1, stepsPerEpoch)));
    } else if (totalEpochs > 0) {
      epochFraction = Math.max(0.1, Math.min(1, (percent / 100) * totalEpochs - Math.max(0, currentEpoch - 1)));
    }
    return { currentEpoch, totalEpochs, epochFraction };
  },

  // 自适应正方形矩阵排布：在可用矩形内求解最大方块边长，尽量一轮一格（至多 400 格），仅极端轮数才分桶。
  _computeAdaptiveEpochGrid(totalEpochs, hasStepFallback, availW = 148, availH = 64) {
    const minDirectCell = 3.5;
    const solveForCount = count => {
      const maxCell = count <= 10 ? 13 : (count <= 20 ? 11.5 : 10.5);
      let best = null;
      const maxRows = Math.min(count, 14);
      for (let rows = 1; rows <= maxRows; rows++) {
        const cols = Math.ceil(count / rows);
        const rough = Math.min(availW / cols, availH / rows);
        const gap = rough >= 10.5 ? 3 : (rough >= 6.2 ? 2 : (rough >= 4.4 ? 1.5 : 1));
        const maxW = (availW - (cols - 1) * gap) / cols;
        const maxH = (availH - (rows - 1) * gap) / rows;
        const size = Math.min(maxCell, maxW, maxH);
        if (size <= 0) continue;
        const waste = (rows * cols - count) / Math.max(1, cols);
        const landscapeBonus = cols >= rows ? 0.04 : 0;
        const score = size * (1 - waste * 0.22 + landscapeBonus);
        if (!best || score > best.score) {
          best = { cols, rows, size, gap, score };
        }
      }
      return best;
    };

    if (totalEpochs >= 1 && totalEpochs <= 400) {
      const direct = solveForCount(totalEpochs);
      if (direct && direct.size >= minDirectCell) {
        const radius = direct.size >= 9 ? 2 : (direct.size >= 5.5 ? 1.5 : 1);
        return { useDirectEpochs: true, blockCount: totalEpochs, cols: direct.cols, size: direct.size, gap: direct.gap, radius };
      }
    }
    if (totalEpochs > 0 || hasStepFallback) {
      const bucketCount = totalEpochs > 100 ? 120 : 40;
      const packed = solveForCount(bucketCount) || { cols: 10, size: 9, gap: 2 };
      const radius = packed.size >= 9 ? 2 : (packed.size >= 5.5 ? 1.5 : 1);
      return { useDirectEpochs: false, blockCount: bucketCount, cols: packed.cols, size: packed.size, gap: packed.gap, radius };
    }
    return { useDirectEpochs: false, blockCount: 0, cols: 0, size: 0, gap: 0, radius: 2 };
  },

  // 琥珀色 · 迅雷式轮次/进度正方形矩阵（自适应一轮一格，实时推进时从总进度条飞入新块）
  _patchSummaryTimeViz(root, d, totalSteps, step, percent, completed, isLiveRunning, t, animate) {
    const host = root.querySelector('[data-summary-viz="time"]');
    if (!host) return;
    const { currentEpoch, totalEpochs, epochFraction } = this._parseEpochProgress(d, totalSteps, step, completed, percent);

    const tile = host.closest?.('.m-live-metric');
    const tileW = tile?.clientWidth || 268;
    const leftTextW = Math.max(
      tile?.querySelector('.m-metric-reading')?.offsetWidth || 0,
      tile?.querySelector('small[data-summary-field="time-meta"]')?.offsetWidth || 0,
      86,
    );
    const availW = Math.max(106, Math.min(200, tileW - leftTextW - 38));
    const availH = 56;
    const prevState = host._matrixState;
    const sameContext = prevState?.context === root.dataset.motionContext;
    const epochSeries = this.monitorLossSeries.find(item => item.tag === 'loss/epoch_average')?.points;
    const legacyEpochSeries = this.monitorLossSeries.find(item => item.tag === 'loss/epoch')?.points;
    const directVersion = [currentEpoch, totalEpochs, completed, percent >= 99.9, isLiveRunning, availW].join('|');
    host._epochReflowArgs = [d, totalSteps, step, percent, completed, isLiveRunning, t];
    if (prevState && sameContext && prevState.directVersion === directVersion
        && prevState.epochSeries === epochSeries && prevState.legacyEpochSeries === legacyEpochSeries) {
      const activeCell = prevState.activeCell;
      const fill = activeCell?.querySelector('.m-epoch-fill');
      if (fill) fill.style.width = Math.round(epochFraction * 100) + '%';
      if (activeCell && animate && step > prevState.step && this._monitorMotionAllowed()) {
        this._launchProgressBlockFlight(root, activeCell, false);
      }
      prevState.step = step;
      return;
    }
    const layout = this._computeAdaptiveEpochGrid(totalEpochs, totalSteps > 0 || percent > 0, availW, availH);
    const { useDirectEpochs, blockCount, cols, size, gap, radius } = layout;
    if (!blockCount) {
      host._matrixState = null;
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    let doneCount = 0;
    let activeIdx = -1;
    const epochLossMap = new Map();
    if (useDirectEpochs) {
      for (const source of [epochSeries, legacyEpochSeries]) {
        for (const point of this._cleanLossPoints(source)) {
          const epoch = Math.round(point.step);
          if (!epochLossMap.has(epoch)) epochLossMap.set(epoch, point.value);
        }
      }
    }
    const cellData = [];
    host._hudIndexChars = useDirectEpochs && epochLossMap.size ? String(totalEpochs).length : 0;
    host._hudValueChars = 0;
    for (let i = 1; i <= blockCount; i++) {
      let isDone = false;
      let isActive = false;
      let fillPct = 0;
      let vizKey = '';
      let vizVal = '';
      if (useDirectEpochs) {
        isDone = completed || (currentEpoch > 0 && i < currentEpoch) || (i === currentEpoch && percent >= 99.9);
        isActive = !isDone && isLiveRunning && i === currentEpoch;
        fillPct = isActive ? Math.round(epochFraction * 100) : 0;
        const lossVal = epochLossMap.get(i);
        if (Number.isFinite(lossVal)) {
          vizKey = `Epoch ${i}`;
          vizVal = `Loss ${this._formatDiagnosticValue(lossVal)}`;
        } else {
          vizKey = 'Epoch';
          vizVal = `${i} / ${totalEpochs}`;
        }
      } else {
        const blockPct = 100 / blockCount;
        const startPct = (i - 1) * blockPct;
        const endPct = i * blockPct;
        isDone = completed || percent >= endPct - 0.05;
        isActive = !isDone && isLiveRunning && percent > startPct;
        fillPct = isActive ? Math.max(8, Math.min(100, Math.round(((percent - startPct) / blockPct) * 100))) : 0;
        if (totalEpochs > 0) {
          const epStart = Math.max(1, Math.floor(((i - 1) / blockCount) * totalEpochs) + 1);
          const epEnd = Math.min(totalEpochs, Math.ceil((i / blockCount) * totalEpochs));
          vizKey = 'Epoch';
          vizVal = epStart === epEnd ? `${epStart}` : `${epStart}–${epEnd}`;
        } else if (totalSteps > 0) {
          const sStart = Math.max(1, Math.floor(((i - 1) / blockCount) * totalSteps) + 1);
          const sEnd = Math.min(totalSteps, Math.ceil((i / blockCount) * totalSteps));
          vizKey = 'Step';
          vizVal = `${sStart}–${sEnd}`;
        } else {
          vizKey = '';
          vizVal = `${Math.round(endPct)}%`;
        }
      }
      if (isDone) doneCount++;
      host._hudValueChars = Math.max(host._hudValueChars, vizVal.length);
      if (isActive) activeIdx = i - 1;
      const tone = blockCount > 1 ? (0.82 + ((i - 1) / (blockCount - 1)) * 0.18).toFixed(2) : '1';
      cellData.push({ idx: i - 1, isDone, isActive, fillPct, vizKey, vizVal, tone });
    }

    host.hidden = false;
    const existingMatrix = host.querySelector('.m-epoch-matrix');
    const existingCells = existingMatrix?.children;
    if (existingMatrix && existingCells && existingCells.length === blockCount) {
      // 格数不变时原地更新各格状态，保留悬停态与进行中格的平滑填充过渡，绝不因重建 DOM 闪烁。
      existingMatrix.style.setProperty('--block-cols', String(cols));
      existingMatrix.style.setProperty('--block-size', size.toFixed(2) + 'px');
      existingMatrix.style.setProperty('--block-gap', gap + 'px');
      existingMatrix.style.setProperty('--block-radius', radius + 'px');
      for (const item of cellData) {
        const cell = existingCells[item.idx];
        if (!cell) continue;
        cell.style.setProperty('--cell-tone', item.tone);
        cell.dataset.vizKey = item.vizKey;
        cell.dataset.vizVal = item.vizVal;
        if (cell.dataset.sealing === '1') continue;
        cell.classList.toggle('is-done', item.isDone);
        cell.classList.toggle('is-active', item.isActive);
        let fill = cell.querySelector('.m-epoch-fill');
        if (item.isActive) {
          if (!fill) {
            fill = document.createElement('i');
            fill.className = 'm-epoch-fill';
            cell.appendChild(fill);
          }
          fill.style.width = item.fillPct + '%';
        } else if (fill) {
          fill.remove();
        }
      }
    } else {
      const cells = cellData.map(item => {
        const cls = 'm-block-cell m-epoch-cell' + (item.isDone ? ' is-done' : item.isActive ? ' is-active' : '');
        const inner = item.isActive ? `<i class="m-epoch-fill" style="width:${item.fillPct}%"></i>` : '';
        return `<span class="${cls}" style="--cell-tone:${item.tone}" data-block-index="${item.idx}" data-viz-idx="${item.idx}" data-viz-key="${this.esc(item.vizKey)}" data-viz-val="${this.esc(item.vizVal)}">${inner}</span>`;
      }).join('');
      const matrixStyle = `--block-cols:${cols};--block-size:${size.toFixed(2)}px;--block-gap:${gap}px;--block-radius:${radius}px`;
      host.innerHTML = `<div class="m-block-matrix m-epoch-matrix" style="${matrixStyle}">${cells}</div>`;
    }
    this._restoreSummaryVizHover(host);
    host._matrixState = { context: root.dataset.motionContext, doneCount, step, epochSeries, legacyEpochSeries,
      directVersion: useDirectEpochs ? directVersion : null,
      activeCell: activeIdx < 0 ? null : host.querySelector(`[data-block-index="${activeIdx}"]`) };
    host._epochLayoutArgs = { totalEpochs, hasStepFallback: totalSteps > 0 || percent > 0, blockCount, tileW };

    if (animate && isLiveRunning && sameContext && this._monitorMotionAllowed()) {
      const completedNewBlock = doneCount > prevState.doneCount;
      const steppedForward = step > (prevState.step || 0);
      if (completedNewBlock) {
        const targetIndex = Math.min(blockCount - 1, doneCount - 1);
        const targetCell = host.querySelector(`[data-block-index="${targetIndex}"]`);
        this._launchProgressBlockFlight(root, targetCell, true);
      } else if (steppedForward && activeIdx >= 0) {
        const targetCell = host.querySelector(`[data-block-index="${activeIdx}"]`);
        this._launchProgressBlockFlight(root, targetCell, false);
      }
    }
  },

  // 飞块落位动效：从顶部总进度条当前末端“生”出一个色块，弧线飞入并落位到方块矩阵对应格。
  _launchProgressBlockFlight(root, targetCell, isFullBlock) {
    if (!root || !targetCell || !document.body || !Element.prototype.animate) return;
    if (root._flightBusy && !isFullBlock) return;
    const bar = root.querySelector('[data-overview-progress]');
    if (!bar) return;
    const barRect = bar.getBoundingClientRect();
    const cellRect = targetCell.getBoundingClientRect();
    if (!barRect.width || !cellRect.width || !cellRect.height) return;

    root._flightBusy = true;
    const sx = Math.max(barRect.left + 4, barRect.right - 3);
    const sy = barRect.top + barRect.height / 2;
    const ex = cellRect.left + cellRect.width / 2;
    const ey = cellRect.top + cellRect.height / 2;
    const mx = sx + (ex - sx) * 0.48 + 16;
    const my = sy + (ey - sy) * 0.32 - 14;

    const flyer = document.createElement('span');
    flyer.className = 'm-flying-block' + (isFullBlock ? ' is-full' : ' is-micro');
    const w = isFullBlock ? Math.max(6, cellRect.width) : 4.5;
    const h = isFullBlock ? Math.max(6, cellRect.height) : 4.5;
    flyer.style.width = w + 'px';
    flyer.style.height = h + 'px';
    flyer.style.left = '0px';
    flyer.style.top = '0px';
    document.body.appendChild(flyer);

    let sealingFill = null;
    if (isFullBlock) {
      // 飞行途中保持当前格处于将满未满的亮态，绝不闪暗，等飞块落位瞬间封满。
      targetCell.dataset.sealing = '1';
      targetCell.classList.remove('is-done');
      targetCell.classList.add('is-active');
      sealingFill = targetCell.querySelector('.m-epoch-fill');
      if (!sealingFill) {
        sealingFill = document.createElement('i');
        sealingFill.className = 'm-epoch-fill';
        targetCell.appendChild(sealingFill);
      }
      sealingFill.style.width = '88%';
    }
    const duration = isFullBlock ? 400 : 340;
    const anim = flyer.animate([
      {
        transform: `translate(${(sx - w / 2).toFixed(1)}px, ${(sy - h / 2).toFixed(1)}px) scale(0.75)`,
        backgroundColor: 'var(--accent)',
        opacity: isFullBlock ? 0.96 : 0.85,
      },
      {
        transform: `translate(${(mx - w / 2).toFixed(1)}px, ${(my - h / 2).toFixed(1)}px) scale(${isFullBlock ? 1.12 : 1.05})`,
        backgroundColor: 'color-mix(in srgb, var(--accent) 42%, var(--section-optimizer))',
        opacity: 1,
        offset: 0.46,
      },
      {
        transform: `translate(${(ex - w / 2).toFixed(1)}px, ${(ey - h / 2).toFixed(1)}px) scale(1)`,
        backgroundColor: 'var(--section-optimizer)',
        opacity: isFullBlock ? 1 : 0.9,
      },
    ], { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });

    const cleanup = () => {
      flyer.remove();
      root._flightBusy = false;
      if (isFullBlock) {
        delete targetCell.dataset.sealing;
        sealingFill?.remove();
        targetCell.classList.remove('is-active');
        targetCell.classList.add('is-done');
        targetCell.animate?.(
          [{ transform: 'scale(1.18)', filter: 'brightness(1.16)' }, { transform: 'scale(1)', filter: 'brightness(1)' }],
          { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
      } else {
        targetCell.animate?.(
          [{ filter: 'brightness(1.15)' }, { filter: 'brightness(1)' }],
          { duration: 160, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
      }
    };
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
  },

  _showSummaryVizHud(host, item, visible = true) {
    const hud = host.closest('.m-live-metric')?.querySelector('[data-summary-hud]');
    if (!hud) return;
    const key = item.dataset.vizKey || '';
    const value = item.dataset.vizVal || '';
    const counter = /^(Step|Epoch)(?: (\d+))?$/.exec(key);
    const indexWidth = (host._hudIndexChars || 1) + 'ch';
    hud.style.setProperty('--m-index-slot', counter?.[1] === 'Step' ? `max(var(--m-step-slot, 1ch), ${indexWidth})` : indexWidth);
    hud.style.setProperty('--m-value-slot', (host._hudValueChars || 1) + 'ch');
    const keyHtml = counter && (counter[2] || host._hudIndexChars)
      ? counter[1] + ' <span class="m-hud-index">' + (counter[2] || '') + '</span>' : this.esc(key);
    const valHtml = value.startsWith('Loss ')
      ? '<span class="m-hud-prefix">Loss </span>' + this.esc(value.slice(5)) : this.esc(value);
    hud.innerHTML = (key ? `<span class="m-metric-hud-key">${keyHtml}</span>` : '')
      + `<b class="m-metric-hud-val">${valHtml}</b>`;
    hud.classList.toggle('is-visible', visible);
  },

  _restoreSummaryVizHover(host) {
    if (host._hoverIdx == null) {
      // Reserve the readout's intrinsic width before the pointer enters the graph.
      const sample = host.querySelector('[data-viz-idx]');
      if (sample) this._showSummaryVizHud(host, sample, false);
      return;
    }
    const item = host.querySelector(`[data-viz-idx="${host._hoverIdx}"]`);
    if (!item) return;
    host.querySelectorAll('.is-hovered').forEach(el => { if (el !== item) el.classList.remove('is-hovered'); });
    item.classList.add('is-hovered');
    this._showSummaryVizHud(host, item);
  },

  // 左卡右上角常驻 HUD 槽位：悬停微图时在右上角报数，不替换左下说明文字；跨方块间隙及实时步数更新时保持高亮与读数不闪烁。
  _bindSummaryVizInteractions(root) {
    const grid = root.querySelector('.m-live-metrics');
    if (!grid || grid._vizBound) return;
    grid._vizBound = true;
    const clearTile = tile => {
      if (!tile) return;
      const viz = tile.querySelector('[data-summary-viz]');
      if (viz) delete viz._hoverIdx;
      const hud = tile.querySelector('[data-summary-hud]');
      if (hud) hud.classList.remove('is-visible');
      tile.querySelectorAll('.is-hovered').forEach(el => el.classList.remove('is-hovered'));
    };
    grid.addEventListener('pointerover', event => {
      const item = event.target.closest?.('[data-viz-val]');
      if (!item) return;
      const viz = item.closest('[data-summary-viz]');
      if (viz) {
        viz._hoverIdx = item.dataset.vizIdx ?? null;
        viz.querySelectorAll('.is-hovered').forEach(el => {
          if (el !== item) el.classList.remove('is-hovered');
        });
        item.classList.add('is-hovered');
        this._showSummaryVizHud(viz, item);
      }
    });
    grid.addEventListener('pointerout', event => {
      const viz = event.target.closest?.('[data-summary-viz]');
      if (!viz) return;
      // 只要指针仍在同一个微图容器内（包括方块之间的间隙），就不清空读数和高亮，彻底杜绝闪烁。
      if (event.relatedTarget && viz.contains(event.relatedTarget)) return;
      clearTile(viz.closest('.m-live-metric'));
    });
    grid.addEventListener('mouseleave', () => {
      grid.querySelectorAll('.m-live-metric').forEach(clearTile);
    });

    // 侧边栏折叠或窗口缩放时，零重绘更新轮次正方形矩阵的行列与边长。
    const timeTile = grid.querySelector('.m-live-metric-time');
    if (timeTile && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        const host = timeTile.querySelector('[data-summary-viz="time"]');
        const meta = host?._epochLayoutArgs;
        if (!meta || host.hidden) return;
        const nextW = Math.round(timeTile.clientWidth || 0);
        if (nextW <= 120 || Math.abs(nextW - (meta.tileW || 0)) < 10) return;
        meta.tileW = nextW;
        const leftTextW = Math.max(
          timeTile.querySelector('.m-metric-reading')?.offsetWidth || 0,
          timeTile.querySelector('small[data-summary-field="time-meta"]')?.offsetWidth || 0,
          86,
        );
        const availW = Math.max(106, Math.min(200, nextW - leftTextW - 38));
        const layout = this._computeAdaptiveEpochGrid(meta.totalEpochs, meta.hasStepFallback, availW, 56);
        if (!layout.blockCount) return;
        if (layout.blockCount !== meta.blockCount && host._epochReflowArgs) {
          this._patchSummaryTimeViz(root, ...host._epochReflowArgs, false);
          return;
        }
        const matrix = host.querySelector('.m-epoch-matrix');
        if (matrix) {
          matrix.style.setProperty('--block-cols', String(layout.cols));
          matrix.style.setProperty('--block-size', layout.size.toFixed(2) + 'px');
          matrix.style.setProperty('--block-gap', layout.gap + 'px');
          matrix.style.setProperty('--block-radius', layout.radius + 'px');
        }
      });
      ro.observe(timeTile);
    }
  },

  _monitorIconHtml(kind) {
    const paths = {
      loss: '<path d="M2 13c3-9 6-9 9 0s6 9 11 0"/>',
      lr: '<path d="M4 19V11m5 8V5m5 14v-9m5 9V7"/>',
      speed: '<path d="M4 17a9 9 0 1 1 16 0m-8-2 4-6"/><circle cx="12" cy="15" r="1"/>',
      time: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
    };
    return '<svg class="m-monitor-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[kind] || '') + '</svg>';
  },

  // 仅用于摘要：逐次 Loss 与诊断区的平均趋势各司其职。
  _summaryLossSeries() {
    return this.monitorLossSeries.find(item => item.tag === 'loss/current');
  },

  _summaryLossChange(series, previousPoint, displayedPoint) {
    const points = this._cleanLossPoints(series && (series.diagnostic_points || series.points));
    const latest = displayedPoint ?? points.at(-1);
    const baseline = previousPoint === undefined ? points.at(-2) : previousPoint;
    if (!latest || !baseline || latest.step < baseline.step) return null;
    const previous = baseline.value;
    if (Math.abs(previous) < 1e-12) return null;
    const percent = (latest.value - previous) / Math.abs(previous) * 100;
    return Number.isFinite(percent) ? { percent } : null;
  },

  _summarySchedule() {
    const cached = this._summaryScheduleCache;
    if (cached && cached.source === this.trainParams && cached.version === this.trainParamsVersion) return cached;
    const params = new Map((this.trainParams || []).map(item => [item.key, item.value]));
    const optimizer = String(params.get('optimizer_type') || '').trim().toLowerCase().split('.').pop();
    // 训练配置中的 optimizer_args 已展开为独立条目；旧配置可能保留表单字段。
    const optimizerArg = (name, ...legacyKeys) => {
      for (const key of ['optimizer_args.' + name, ...legacyKeys]) {
        if (params.has(key)) return params.get(key);
      }
      return null;
    };
    const enabled = value => ['true', '1'].includes(String(value).trim().toLowerCase());
    const relativeStep = optimizerArg('relative_step', 'adafactor_relative_step', 'krea_adafactor_relative_step');
    const warmupInit = optimizerArg('warmup_init', 'adafactor_warmup_init', 'krea_adafactor_warmup_init');
    const adaptive = ['automagic', 'automagic3', 'automagic4', 'emosens', 'prodigyplus', 'prodigyplusschedulefree'].includes(optimizer)
      || optimizer === 'prodigy' || optimizer.startsWith('dadapt')
      || (optimizer === 'adafactor' && (relativeStep == null || enabled(relativeStep) || enabled(warmupInit)));
    const externalAdaptive = optimizer === 'prodigy' || optimizer.startsWith('dadapt');
    const scaleParameter = optimizerArg('scale_parameter', 'adafactor_scale_parameter', 'krea_adafactor_scale_parameter');
    const parameterScaled = optimizer === 'adafactor' && (scaleParameter == null || enabled(scaleParameter));
    return this._summaryScheduleCache = { source: this.trainParams, version: this.trainParamsVersion, params,
      optimizer, optimizerArg, adaptive, externalAdaptive, parameterScaled,
      scheduler: String(params.get('lr_scheduler') || '').trim().toLowerCase(),
      rawWarmup: Number(params.get('lr_warmup_steps') ?? 0) };
  },

  _summarySchedulerMeta(t, totalSteps) {
    const { params, scheduler, optimizer, optimizerArg, adaptive, externalAdaptive, parameterScaled } = this._summarySchedule();
    if (adaptive && !externalAdaptive) return t('lrAdaptive');
    const rateMode = externalAdaptive ? 'lrAdaptive' : parameterScaled ? 'lrParameterScaled' : '';

    // RAdamScheduleFree uses rectification for its warmup and has no warmup_steps argument.
    if (optimizer === 'radamschedulefree') return 'Schedule-Free';
    if (['adamwschedulefree', 'sgdschedulefree'].includes(optimizer)) {
      const raw = optimizerArg('warmup_steps', 'schedulefree_warmup_steps', 'krea_schedulefree_warmup_steps');
      const warmup = raw == null || raw === '' ? 0 : Number(raw);
      const detail = Number.isFinite(warmup) && warmup >= 0
        ? (warmup > 0 ? t('lrWarmupSteps').replace('{n}', Math.floor(warmup)) : t('lrNoWarmup')) : '';
      return ['Schedule-Free', detail].filter(Boolean).join(' · ');
    }

    if (!scheduler) return rateMode ? t(rateMode) : '';
    const labels = { constant: 'lrScheduleConstant', constant_with_warmup: 'lrScheduleWarmup', linear: 'lrScheduleLinear', cosine: 'lrScheduleCosine', cosine_with_restarts: 'lrScheduleRestarts', polynomial: 'lrSchedulePolynomial', inverse_sqrt: 'lrScheduleInverseSqrt' };
    const label = rateMode && scheduler === 'constant' ? t('lrScheduleConstantShort')
      : labels[scheduler] ? t(labels[scheduler]) : String(scheduler);
    const raw = params.get('lr_warmup_steps');
    if (rateMode) {
      const description = t(rateMode) + ' · ' + t('lrExternalSchedule').replace('{scheduler}', label);
      const warmup = Number(raw);
      if (raw == null || raw === '' || !Number.isFinite(warmup) || warmup <= 0 || scheduler === 'constant') return description;
      const detail = warmup < 1 && !totalSteps ? t('lrWarmupPercent').replace('{n}', +(warmup * 100).toFixed(2))
        : t('lrWarmupSteps').replace('{n}', warmup < 1 ? Math.floor(warmup * totalSteps) : Math.floor(warmup));
      return description + ' · ' + detail;
    }
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

  _formatLearningRate(value, fallback) {
    if (value == null || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    if (number === 0 || Math.abs(number) >= 0.01) return String(number);
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

  // 配置只在快照/语言变化时整理；不读取当前训练表单，也不在指标 tick 中重建。
  _monitorParamModel(t) {
    const locale = [this.locale, this.localeRevision].join(':');
    const cached = this._monitorParamCache;
    const snapshot = this.selectedRunDir ? this.runDetailData : this.monitorData;
    const values = new Map((this.trainParams || []).map(param => [param.key, param.value]));
    const profile = snapshot?.training_profile || snapshot?.config?.model_train_type || values.get('model_train_type')
      || (values.has('dit') ? 'krea2-lora' : ({ 'networks.lora_anima': 'anima-lora', 'networks.lora_generic': 'moss-image-lora', 'networks.lora': 'sdxl-lora' }[values.get('network_module')] || ''))
      || (cached?.params === this.trainParams ? cached.profile : '');
    if (cached?.params === this.trainParams && cached.version === this.trainParamsVersion && cached.locale === locale && cached.profile === profile && cached.schema === window.TRAIN_SECTIONS) return cached;
    return this._monitorParamCache = { ...this._buildMonitorParamModel(this.trainParams || [], profile, t),
      params: this.trainParams, version: this.trainParamsVersion, locale, profile, schema: window.TRAIN_SECTIONS };
  },

  _buildMonitorParamModel(params, profile, t) {
    const values = new Map(params.map(param => [param.key, param.value]));
    const fields = (window.getVisibleSections?.(profile) || window.TRAIN_SECTIONS || []).flatMap(section => section.fields || []);
    const definitions = new Map(fields.map(field => [field.key, field]));
    const display = window.trainingFieldDisplay;
    const translate = (key, fallback) => this.t(key, fallback);
    const argumentsByKind = { network_args: new Map(), optimizer_args: new Map(), lr_scheduler_args: new Map() };
    const module = values.get('network_module');
    const indexArgument = (kind, argument, field) => {
      if (!argument) return;
      const index = argumentsByKind[kind];
      if (!index.has(argument)) index.set(argument, []);
      index.get(argument).push(field);
    };
    for (const field of fields) {
      indexArgument('optimizer_args', field.argKey, field);
      indexArgument('lr_scheduler_args', field.schedulerArg, field);
      if (field.networkModules?.includes(module)) indexArgument('network_args', field.networkArgByModule?.[module] || field.networkArg, field);
    }
    const argumentField = (kind, argument) => {
      const candidates = argumentsByKind[kind]?.get(argument) || [];
      const driver = kind === 'optimizer_args' ? 'optimizer_type' : kind === 'lr_scheduler_args' ? 'lr_scheduler' : 'network_module';
      const selected = String(values.get(driver) || '').toLowerCase();
      return candidates.find(field => [field.showIf, ...(field.showIfAny || [])].flat(Infinity)
        .some(condition => condition?.key === driver && [condition.eq, ...(condition.or || [])]
          .some(value => value != null && String(value).toLowerCase() === selected)))
        || (candidates.length === 1 ? candidates[0] : definitions.get(argument));
    };
    // 只匹配已知选项对应的原生字面量；未知参数保留原文，不执行配置内容。
    const nativeOptionMatches = (value, raw) => {
      const text = raw.trim().toLowerCase();
      if (value === null) return text === 'none' || text === 'null';
      if (typeof value !== 'string') return String(value).toLowerCase() === text;
      return [value, JSON.stringify(value), "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"]
        .some(literal => literal.toLowerCase() === text);
    };
    const formatParam = param => {
      const key = param.key || param.label_raw || param.label || '';
      const [namespace, ...argumentParts] = key.split('.');
      const argument = argumentParts.join('.');
      const native = Object.hasOwn(argumentsByKind, namespace);
      const literal = namespace === 'optimizer_args' || namespace === 'lr_scheduler_args';
      const field = native ? argumentField(namespace, argument) : definitions.get(key);
      const fieldKey = field?.key || (native ? argument : key);
      const labelKey = field?.descKey || param.desc_key || ('field.' + fieldKey);
      const translated = display?.label(field || { key: fieldKey, descKey: labelKey }, profile, translate).text || t(labelKey, '');
      const label = translated && translated !== labelKey && translated !== fieldKey ? translated : (param.label_raw || param.label || fieldKey);
      const raw = String(param.value ?? '');
      const input = literal && field ? String(param.string_value ?? raw) : raw;
      let value = input;
      const trainType = key === 'model_train_type' && (this.trainTypes || window.trainingCoreMixin?.trainTypes || []).find(type => type.v === raw);
      const options = [...(field?.options || []), ...(field?.groups || []).flatMap(group => group.options || [])]
        .filter(option => !display || display.optionApplies(option, profile));
      const option = options.find(option => String(option.v) === input)
        || options.find(option => String(option.v).toLowerCase() === input.toLowerCase())
        || (literal && options.find(option => nativeOptionMatches(
          Object.hasOwn(field.optimizerArgValues || {}, option.v) ? field.optimizerArgValues[option.v] : option.v, input)));
      if (trainType) value = trainType.l;
      else if (option && display) value = display.optionLabel(option, translate);
      else if (/^(true|false)$/i.test(input) || ((field?.type || param.type) === 'toggle' && /^(0|1)$/.test(input))) value = t(/^(true|1)$/i.test(input) ? 'paramEnabled' : 'paramDisabled');
      const displayKey = field?.argKey || fieldKey;
      return { ...param, key, fieldKey, displayKey, label, raw, value, search: [label, key, fieldKey, displayKey, raw, value].join(' ').toLowerCase() };
    };
    const rows = params.map(formatParam);
    const byField = new Map(rows.map(row => [row.fieldKey, row]));
    const profileRow = byField.get('model_train_type') || (profile ? formatParam({ key: 'model_train_type', value: profile }) : null);
    return { rows, profileRow, byKey: new Map(rows.map(row => [row.key, row])), byField };
  },

  _monitorSnapshotParamModel(snapshot, t) {
    const profile = snapshot.training_profile || snapshot.params?.model_train_type || snapshot.reuse_params?.model_train_type || (snapshot.params?.dit ? 'krea2-lora' : '');
    if (Array.isArray(snapshot.train_params)) return this._buildMonitorParamModel(snapshot.train_params, profile, t);
    const params = [];
    for (const [key, value] of Object.entries(snapshot.params || {})) {
      if (value == null || value === '') continue;
      if (['network_args', 'optimizer_args', 'lr_scheduler_args'].includes(key) && Array.isArray(value)) {
        for (const argument of value) {
          const text = String(argument).trim();
          if (!text) continue;
          const separator = text.indexOf('=');
          const name = (separator < 0 ? text : text.slice(0, separator)).trim();
          params.push({ key: key + '.' + name, label_raw: name, value: separator < 0 ? 'true' : text.slice(separator + 1).trim() });
        }
      } else params.push({ key, value: Array.isArray(value) ? value.join(', ') : String(value) });
    }
    return this._buildMonitorParamModel(params, profile, t);
  },

  _monitorParamSummary(t, model) {
    const p = model.byField;
    const raw = key => p.get(key)?.raw;
    const present = key => raw(key) != null && raw(key) !== '';
    const enabled = key => /^(true|1)$/i.test(raw(key) || '');
    const groups = [];
    let rows = [];
    const field = key => { if (present(key)) rows.push(p.get(key)); };
    const group = title => { if (rows.length) groups.push({ title: t(title), rows }); rows = []; };
    if (model.profileRow) rows.push(model.profileRow);
    field('network_module');
    if (raw('network_module') === 'lycoris.kohya') field('lycoris_algo');
    field('dim_from_weights');
    if (!enabled('dim_from_weights')) { field('network_dim'); field('network_alpha'); }
    field('lokr_factor');
    group('paramNetwork');

    const stepsMode = raw('krea_training_duration_mode') === 'steps' || !(Number(raw('max_train_epochs')) > 0);
    field(stepsMode ? 'max_train_steps' : 'max_train_epochs');
    field('train_batch_size');
    field('gradient_accumulation_steps');
    field('resolution');
    field('enable_bucket');
    field('seed');
    group('paramTraining');

    field('learning_rate');
    field('unet_lr');
    field('text_encoder_lr');
    field('text_encoder_lr1');
    field('text_encoder_lr2');
    field('optimizer_type');
    field('lr_scheduler');
    field('lr_warmup_steps');
    group('paramOptimization');

    field('mixed_precision');
    field('gradient_checkpointing');
    field('gradient_checkpointing_cpu_offload');
    field('cache_latents');
    field('cache_latents_to_disk');
    field('cache_text_encoder_outputs');
    field('cache_text_encoder_outputs_to_disk');
    field('krea_latent_cache_device');
    field('krea_text_cache_device');
    field('krea_cache_reuse');
    field('blocks_to_swap');
    group('paramPerformance');
    return groups;
  },

  _parametersConsoleHtml(t, d = {}) {
    const context = this.selectedRunDir || d.run_dir || this.liveTaskId || d.active_task?.id || '';
    if (this._monitorParamContext !== context) {
      this._monitorParamContext = context;
      this.monitorParamQuery = '';
      this.monitorParamsExpanded = false;
    }
    const model = this._monitorParamModel(t);
    const p = model.byKey;
    let html = '<section class="m-console-card m-parameters-console"><div class="m-card-heading m-param-heading"><div><span>' + this.esc(t('trainingConfig')) + '</span></div>';
    html += '<div class="m-param-actions"><button type="button" class="btn btn-sm btn-secondary" :disabled="!currentOutputRunDir" @click="viewSnapshot(currentOutputRunDir)">' + this.esc(t('viewRawConfig')) + '</button>';
    html += '<button type="button" class="btn btn-sm btn-primary" :disabled="!currentOutputRunDir || !!historyReuseBusy" @click="reuseConfig(currentOutputRunDir)" x-text="t(historyReuseBusy === currentOutputRunDir ? \'monitor.copyingConfig\' : \'monitor.reuseRunConfig\')">' + this.esc(t('reuseRunConfig')) + '</button></div></div>';
    const source = (...keys) => keys.map(key => p.get(key)).find(param => param?.raw);
    const datasetConfig = source('dataset_config');
    const sources = [source('dit', 'pretrained_model_name_or_path'), datasetConfig || source('train_data_dir'), source('network_weights')].filter(Boolean);
    if (sources.length) {
      html += '<dl class="m-param-sources">';
      for (const param of sources) {
        const label = param.label;
        const basename = param.raw.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || param.raw;
        html += '<div><dt>' + this.esc(label) + '</dt><dd><strong>' + this.esc(basename) + '</strong>';
        if (basename !== param.raw) html += '<span>' + this.esc(param.raw) + '</span>';
        html += '</dd><button type="button" class="btn-icon" data-config-value="' + this.esc(param.raw) + '" @click="copyMonitorParamValue($el.dataset.configValue)" title="' + this.esc(t('paramCopyPath')) + '" aria-label="' + this.esc(t('paramCopyPath') + ': ' + label) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button></div>';
      }
      html += '</dl>';
    }
    const groups = this._monitorParamSummary(t, model);
    if (groups.length) {
      html += '<div class="m-param-summary">';
      for (const group of groups) {
        html += '<section><h3>' + this.esc(group.title) + '</h3><dl>';
        for (const row of group.rows) html += '<div><dt title="' + this.esc(row.displayKey) + '">' + this.esc(row.label) + '</dt><dd>' + this.esc(row.value) + '</dd></div>';
        html += '</dl></section>';
      }
      html += '</div>';
    }
    html += '<details class="m-param-all" @toggle="toggleMonitorParams($el)"' + (this.monitorParamsExpanded ? ' open' : '') + '><summary><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg><span>' + this.esc(t('allParams')) + '</span><small>' + model.rows.length + ' ' + this.esc(t('items')) + '</small></summary><div data-param-body></div></details></section>';
    return html;
  },

  initMonitorParams(panel) {
    const details = panel.querySelector('.m-param-all');
    if (details?.open) this.toggleMonitorParams(details);
  },

  toggleMonitorParams(details) {
    // 移除旧面板时可能还有待发送的 toggle 事件，不让它污染新记录。
    if (!details.isConnected) return;
    this.monitorParamsExpanded = details.open;
    if (!details.open) return;
    const body = details.querySelector('[data-param-body]');
    if (!body.firstElementChild) {
      const t = (key, fallback) => this.tMonitor(key, fallback);
      const model = this._monitorParamModel(t);
      let html = '<div class="m-param-toolbar"><input type="search" value="' + this.esc(this.monitorParamQuery || '') + '" placeholder="' + this.esc(t('parameterSearch')) + '" aria-label="' + this.esc(t('parameterSearch')) + '" @input="monitorParamQuery=$event.target.value;filterMonitorParams()"><span class="m-param-match" data-param-match role="status"></span></div>';
      html += '<table class="m-param-table"><thead><tr><th scope="col">' + this.esc(t('paramName')) + '</th><th scope="col">' + this.esc(t('paramValue')) + '</th></tr></thead><tbody>';
      for (const row of model.rows) {
        html += '<tr data-param-row data-search="' + this.esc(row.search) + '"><th scope="row">' + this.esc(row.label);
        if (row.label !== row.displayKey) html += '<small title="' + this.esc(row.key) + '">' + this.esc(row.displayKey) + '</small>';
        html += '</th><td>' + this.esc(row.value) + '</td></tr>';
      }
      html += '</tbody></table><p class="m-param-empty" data-param-empty hidden>' + this.esc(t('paramNoMatches')) + '</p>';
      body.innerHTML = html;
      body._paramRows = Array.from(body.querySelectorAll('[data-param-row]'));
    }
    this.filterMonitorParams();
  },

  filterMonitorParams() {
    const root = document.getElementById('monitorTabContent')?.querySelector('[data-param-body]');
    if (!root?.firstElementChild) return;
    const query = String(this.monitorParamQuery || '').trim().toLowerCase();
    let matches = 0;
    for (const row of root._paramRows || []) {
      const show = !query || row.dataset.search.includes(query);
      if (row.hidden === show) row.hidden = !show;
      if (show) matches++;
    }
    root.querySelector('[data-param-match]').textContent = matches + ' ' + this.tMonitor(query ? 'matches' : 'items');
    root.querySelector('[data-param-empty]').hidden = matches > 0;
  },

  async copyMonitorParamValue(value) {
    try { await navigator.clipboard.writeText(value); this.toast(this.t('common.copied')); }
    catch { this.toast(this.t('common.requestFailed'), 'error'); }
  },
};
