// sd-scripts scheduler preview; composed into the training UI by app.js.
window.trainingLrPreviewMixin = {
  lrPreviewComponent: 'unet',

  lrPreviewComponents(values) {
    const source = values || this.form || {};
    const options = [];
    if (source.network_train_text_encoder_only !== true) options.push({ value: 'unet', label: 'DiT / U-Net' });
    if (source.network_train_unet_only !== true) options.push({ value: 'text', label: this.t('lrPreview.textEncoderComponent') });
    return options;
  },

  setLrPreviewComponent(value) {
    this.lrPreviewComponent = value;
    this.refreshLrPreview();
  },

  onPreviewChartKey(event, kind) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const holder = event.currentTarget;
    const chart = holder.querySelector(kind === 'lr' ? '.lr-preview-chart' : '.timestep-preview-chart');
    if (!chart) return;
    const previous = Number(holder.dataset.inspectProgress || 0);
    const totalSteps = kind === 'lr' ? this.lrPreviewData?.totalSteps : 0;
    const increment = totalSteps > 0 ? Math.max(1, Math.round(totalSteps * 0.01)) / totalSteps : 0.01;
    const progress = event.key === 'Home' ? 0 : event.key === 'End' ? 1
      : Math.max(0, Math.min(1, previous + (event.key === 'ArrowRight' ? increment : -increment)));
    holder.dataset.inspectProgress = progress;
    const rect = chart.getBoundingClientRect();
    const sample = { currentTarget: holder, clientX: rect.left + rect.width * progress, clientY: rect.top + rect.height / 2 };
    if (kind === 'lr') this.onLrChartHover(sample); else this.onTimestepChartHover(sample);
  },
  // Shared by SVG sampling and the exact hover readout.
  _lrPreviewMultiplier(progress, params) {
    const { scheduler, warmupFraction, cycles, power, endRatio } = params;
    const p = Math.max(0, Math.min(1, progress));
    if (scheduler === 'constant') return 1;
    if (p < warmupFraction) return p / warmupFraction;
    if (scheduler === 'constant_with_warmup') return 1;
    const decay = (p - warmupFraction) / Math.max(1e-9, 1 - warmupFraction);
    switch (scheduler) {
      case 'linear': return Math.max(0, 1 - decay);
      case 'cosine': return Math.max(0, 0.5 * (1 + Math.cos(Math.PI * decay)));
      case 'cosine_with_restarts':
        return p >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * ((decay * cycles) % 1)));
      case 'polynomial': return (1 - decay) ** power * (1 - endRatio) + endRatio;
      default: return NaN;
    }
  },

  _lrPreviewNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },

  _lrPreviewWarmup(source, totalSteps) {
    const raw = this._lrPreviewNumber(source.lr_warmup_steps, 0);
    if (!(raw > 0)) {
      return { raw, fraction: 0, label: '', visible: false };
    }
    const stepsUnit = this.t('lrPreview.stepsUnit', 'steps');
    if (raw < 1) {
      return {
        raw,
        fraction: totalSteps > 0 ? Math.floor(raw * totalSteps) / totalSteps : raw,
        label: totalSteps > 0
          ? `${this._lrPreviewFormatPercent(raw)} · ${Math.floor(raw * totalSteps).toLocaleString()} ${stepsUnit}`
          : this._lrPreviewFormatPercent(raw),
        visible: true,
      };
    }
    if (totalSteps > 0) {
      const fraction = raw / totalSteps;
      return {
        raw,
        fraction,
        label: `${Math.round(raw).toLocaleString()} ${stepsUnit} (${this._lrPreviewFormatPercent(fraction)})`,
        visible: true,
      };
    }
    return {
      raw,
      fraction: 0.1,
      label: `${Math.round(raw).toLocaleString()} ${stepsUnit} (${this.t('lrPreview.estimatedWarmup', 'previewed as 10%')})`,
      visible: true,
      estimated: true,
    };
  },

  _lrPreviewFormatPercent(value) {
    const pct = Math.max(0, Number(value) || 0) * 100;
    const rounded = Math.round(pct * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
  },

  _lrPreviewFormatRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate < 0) return '—';
    if (rate === 0) return '0';
    return rate.toExponential(3)
      .replace(/(\.\d*?[1-9])0+e/, '$1e')
      .replace(/\.0+e/, 'e')
      .replace('e-0', 'e-');
  },

  _buildLrPreview(values) {
    const source = values || this.form || {};
    const scheduler = String(source.lr_scheduler || 'constant');
    const schedulerLabel = this._fieldOptionLabel('lr_scheduler', scheduler, scheduler);
    const optimizerLabel = this._fieldOptionLabel('optimizer_type', source.optimizer_type, source.optimizer_type);
    const baseRateText = String(source.learning_rate ?? '').trim();
    const unetRateText = String(source.unet_lr ?? '').trim();
    const trainTextEncoder = source.network_train_unet_only !== true;
    const textEncoderRateText = String(source.text_encoder_lr ?? '').trim();
    const components = this.lrPreviewComponents(source);
    const selectedComponent = components.find(option => option.value === this.lrPreviewComponent)?.value || components[0]?.value;
    const chartUnet = selectedComponent === 'unet';
    const chartComponent = chartUnet
      ? this.t('lrPreview.unetComponent', 'U-Net / DiT')
      : (trainTextEncoder ? this.t('lrPreview.textEncoderComponent', 'Text Encoder') : this.t('lrPreview.learningRate'));
    const chartRateText = chartUnet
      ? (unetRateText || baseRateText)
      : (textEncoderRateText || baseRateText);
    const chartRate = this._lrPreviewNumber(chartRateText, 0);
    const totalSteps = this.stepEstimate && Number(this.stepEstimate.total_steps || 0) > 0
      ? Number(this.stepEstimate.total_steps || 0)
      : 0;
    const warmup = this._lrPreviewWarmup(source, totalSteps);
    const cycles = String(source.lr_scheduler_num_cycles ?? '').trim();
    const power = String(source.lr_scheduler_power ?? '').trim();
    const pointCount = 160;
    const yUpper = 1.08;
    const optimizer = String(source.optimizer_type || '').toLowerCase();
    const internal = optimizer.endsWith('schedulefree') || optimizer.endsWith('.emosens')
      || optimizer.endsWith('automagic')
      || (optimizer === 'adafactor' && source.adafactor_relative_step !== false);
    const params = {
      scheduler, warmupFraction: warmup.fraction,
      cycles: this._lrPreviewNumber(cycles || 1, 1),
      power: this._lrPreviewNumber(power || 1, 1),
      endRatio: 1e-7 / this._lrPreviewNumber(baseRateText, 0),
    };
    let unavailable = '';
    if (internal) unavailable = this.t('lrPreview.internalNote');
    else if (!['constant', 'constant_with_warmup', 'linear', 'cosine', 'cosine_with_restarts', 'polynomial'].includes(scheduler)) {
      unavailable = this.t('lrPreview.unsupportedNote');
    } else if (!(chartRate > 0) || (scheduler === 'constant' && warmup.visible)
      || (scheduler === 'polynomial' && (!(params.endRatio > 0 && params.endRatio < 1)
        || !(params.power > 0) || warmup.fraction === 1))
      || (scheduler === 'cosine_with_restarts' && !(params.cycles >= 1))) {
      unavailable = this.t('lrPreview.invalidNote');
    }
    const evaluateMultiplier = progress => this._lrPreviewMultiplier(progress, params);
    // Include exact warmup and restart boundaries; avoid diagonal restart ramps.
    const positions = new Set(Array.from({ length: pointCount }, (_, i) => i / (pointCount - 1)));
    if (warmup.fraction > 0 && warmup.fraction < 1) positions.add(warmup.fraction);
    if (scheduler === 'cosine_with_restarts' && !unavailable && warmup.fraction < 1) {
      for (let cycle = 1; cycle < Math.min(params.cycles, 1000); cycle++) {
        const boundary = warmup.fraction + (1 - warmup.fraction) * cycle / params.cycles;
        positions.add(Math.max(0, boundary - 1e-10));
        positions.add(Math.min(1, boundary + 1e-10));
      }
    }
    const coords = [...positions].sort((a, b) => a - b).map(progress => {
      const value = unavailable ? 0 : evaluateMultiplier(progress);
      return `${(progress * 100).toFixed(5)},${Math.max(0, 100 - value / yUpper * 100).toFixed(5)}`;
    });
    const curvePaths = {
      linePath: `M ${coords.join(' L ')}`,
      areaPath: `M 0,100 L ${coords.join(' L ')} L 100,100 Z`,
    };

    const baselineY = (100 - (100 / yUpper)).toFixed(2);
    const warmupX = warmup.visible && warmup.fraction <= 1 ? (warmup.fraction * 100).toFixed(2) : null;
    const axisLabels = [0, 0.25, 0.5, 0.75, 1].map(progress => {
      if (totalSteps > 0) {
        return this.t('lrPreview.stepLabel', '{count} steps')
          .replace('{count}', Math.round(progress * totalSteps).toLocaleString());
      }
      return this._lrPreviewFormatPercent(progress);
    });
    const notes = [];
    if (unavailable) notes.push(unavailable);
    if (!unavailable) notes.push(this.t('lrPreview.baseGroupNote'));
    if (!internal && (optimizer.startsWith('prodigy') || optimizer === 'adafactor')) {
      notes.push(this.t('lrPreview.adaptiveNote'));
    }
    if (!totalSteps) {
      notes.push(this.t('lrPreview.noStepNote', 'Total steps are unavailable, so the x-axis shows 0–100% training progress.'));
      if (warmup.estimated) {
        notes.push(this.t('lrPreview.estimatedWarmupNote', 'Warmup is set to {steps}; the curve renders it as 10% of training progress for this preview.')
          .replace('{steps}', `${Math.round(warmup.raw).toLocaleString()} ${this.t('lrPreview.stepsUnit', 'steps')}`));
      }
    }

    return {
      scheduler,
      schedulerLabel,
      optimizerLabel,
      effectiveRateText: this._lrPreviewFormatRate(chartRate),
      component: selectedComponent,
      componentLabel: chartComponent,
      components,
      rateSource: chartUnet ? (unetRateText ? 'unet_lr' : 'learning_rate') : (textEncoderRateText ? 'text_encoder_lr' : 'learning_rate'),
      chartLabel: `${this.t('lrPreview.learningRateAxis', 'Learning rate')} · ${chartComponent}`,
      totalSteps,
      totalStepsText: totalSteps > 0 ? Number(totalSteps).toLocaleString() : '',
      warmupVisible: warmup.visible && !unavailable,
      warmupLabel: warmup.label,
      warmupX,
      warmupEstimated: !!warmup.estimated,
      warning: !!unavailable || warmup.estimated || !totalSteps,
      cycles: scheduler === 'cosine_with_restarts' ? cycles : '',
      power: scheduler === 'polynomial' ? power : '',
      notes,
      params,
      unavailable,
      chartRate,
      yTicks: [1, 0.75, 0.5, 0.25, 0].map((value, index) => ({
        label: chartRate > 0 ? this._lrPreviewFormatRate(chartRate * value) : value.toFixed(index === 4 ? 0 : 2),
        y: ((1 - value / yUpper) * 100).toFixed(2),
      })),
      currentLinePath: curvePaths.linePath,
      currentAreaPath: curvePaths.areaPath,
      baselineLinePath: `M 0,${baselineY} L 100,${baselineY}`,
      axisLabels,
      chartAlt: this.t(
        'lrPreview.chartAlt',
        'Learning-rate curve for the current configuration'
      ),
    };
  },

  _buildLrChartHtml(data) {
    if (!data || data.unavailable) return '';
    const esc = value => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const t = (key, fallback) => {
      const translated = typeof this.t === 'function' ? this.t(key) : '';
      return esc(translated || fallback);
    };
    const yTicks = (data.yTicks || []).map(tick =>
      `<span class="lr-ytick-label" style="bottom:${(100 - parseFloat(tick.y)).toFixed(1)}%">${esc(tick.label)}</span>`
    ).join('');
    const gridH = (data.yTicks || []).map(tick =>
      `<line x1="0" y1="${esc(tick.y)}" x2="100" y2="${esc(tick.y)}" class="lr-grid-h" />`
    ).join('');
    const baselineCurve = data.baselineLinePath
      ? `<path class="lr-curve-baseline" d="${esc(data.baselineLinePath)}"></path>` : '';
    const warmupEndLabel = data.warmupEstimated
      ? t('lrPreview.estimatedWarmupEnd', 'Warmup end (10% preview)')
      : t('lrPreview.warmupEnd', 'Warmup end');
    const warmupLine = data.warmupVisible && data.warmupX !== null
      ? `<div class="lr-warmup-line" style="left:${esc(data.warmupX)}%"><span class="lr-warmup-tag">${warmupEndLabel}</span></div>`
      : '';
    const axisLabels = data.axisLabels || ['0%', '25%', '50%', '75%', '100%'];
    return `
      <div class="lr-inspect-bar">
        <div class="lr-inspect-value">
          <span><small>${t('lrPreview.position', 'Step / progress')}</small><b class="lr-hover-x">—</b></span>
          <span title="${esc(data.chartLabel)}"><small>${t('lrPreview.learningRateAxis', 'Learning rate')}</small><b class="lr-hover-value">—</b></span>
          <span><small>${t('lrPreview.multiplier', 'Multiplier')}</small><b class="lr-hover-multiplier">—</b></span>
        </div>
      </div>
    <div class="lr-chart-box">
      <div class="lr-chart-yaxis">
        <div class="lr-yaxis-ticks">${yTicks}</div>
      </div>
      <div class="lr-preview-chart" role="img" aria-label="${esc(data.chartAlt)}">
        <svg class="lr-grid-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          ${gridH}
          <line x1="25" y1="0" x2="25" y2="100" class="lr-grid-v" />
          <line x1="50" y1="0" x2="50" y2="100" class="lr-grid-v" />
          <line x1="75" y1="0" x2="75" y2="100" class="lr-grid-v" />
        </svg>
        <svg class="lr-preview-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          ${baselineCurve}
          <path class="lr-curve-area" d="${esc(data.currentAreaPath)}"></path>
          <path class="lr-curve-current" d="${esc(data.currentLinePath)}"></path>
        </svg>
        ${warmupLine}
        <div class="lr-hover-indicator" style="display:none"></div>
      </div>
    </div>
    <div class="lr-preview-axis">
      <span class="axis-left">${esc(axisLabels[0])}</span>
      <div class="axis-mid-ticks"><span>${esc(axisLabels[1])}</span><span>${esc(axisLabels[2])}</span><span>${esc(axisLabels[3])}</span></div>
      <span class="axis-right">${esc(axisLabels[4])}</span>
    </div>
    <div class="lr-preview-legend">
      <span><i class="legend-current"></i><span>${t('lrPreview.currentCurve', 'Current curve')}</span></span>
      <span><i class="legend-baseline"></i><span>${t('lrPreview.baseReference', 'Base ×1.0')}</span></span>
    </div>`;
  },

  onLrChartHover(event, previewData) {
    if (!event || !event.currentTarget) return;
    const holder = event.currentTarget;
    const chart = holder.querySelector ? holder.querySelector('.lr-preview-chart') : null;
    if (!chart) return;
    const rect = chart.getBoundingClientRect();
    if (!rect.width) return;
    if (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) {
      this.onLrChartLeave(event);
      return;
    }
    const relX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const data = previewData || this.lrPreviewData;
    if (!data) return;
    const progress = data.totalSteps > 0 ? Math.round(relX * data.totalSteps) / data.totalSteps : relX;
    holder.dataset.inspectProgress = progress;
    const value = this._lrPreviewMultiplier(progress, data.params);
    const hoverLine = chart.querySelector('.lr-hover-indicator');
    if (hoverLine) {
      hoverLine.style.left = `${(progress * 100).toFixed(2)}%`;
      hoverLine.style.display = 'block';
    }
    const xEl = holder.querySelector('.lr-hover-x');
    const vEl = holder.querySelector('.lr-hover-value');
    const multiplierEl = holder.querySelector('.lr-hover-multiplier');
    const setText = (element, text) => {
      if (element && element.textContent !== text) element.textContent = text;
    };
    if (xEl) {
      if (data.totalSteps > 0) {
        const step = Math.round(progress * data.totalSteps);
        setText(xEl, `${step.toLocaleString()} / ${data.totalStepsText}`);
      } else {
        setText(xEl, `${Math.round(progress * 100)}%`);
      }
    }
    if (vEl) {
      const rate = (Number(data.chartRate) || 0) * value;
      setText(vEl, this._lrPreviewFormatRate(rate));
    }
    setText(multiplierEl, `${value.toFixed(2)}×`);
  },

  onLrChartLeave(event) {
    if (event && event.currentTarget && event.currentTarget.querySelector) {
      const holder = event.currentTarget;
      const hoverLine = holder.querySelector('.lr-hover-indicator');
      if (hoverLine) hoverLine.style.display = 'none';
    }
  },

  openLrPreview() {
    if (String(this.form?.model_train_type || '') === 'krea2-lora') return;
    this.lrPreviewData = this._buildLrPreview(null);
    this._openManagedModal('lrPreviewOpen', 'lrPreviewPreviousFocus', '.lr-preview-close');
  },

  closeLrPreview() {
    this._closeManagedModal('lrPreviewOpen', 'lrPreviewPreviousFocus');
  },

  refreshLrPreview() {
    if (String(this.form?.model_train_type || '') === 'krea2-lora') {
      this.closeLrPreview();
      return;
    }
    this.lrPreviewData = this._buildLrPreview(null);
  },

};
