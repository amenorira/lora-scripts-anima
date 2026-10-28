/* Deterministic timestep curves and statistics; independent of Alpine and the DOM. */
window.TrainingTimestepPreview = (() => {
  function numberValue(value, fallback) {
    if (value == null || (typeof value === 'string' && !value.trim())) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function parseResolution(value) {
    const raw = String(value || '1024,1024');
    const values = raw.split(/[xX,]/).map(v => Number(v.trim())).filter(v => Number.isFinite(v) && v > 0);
    if (values.length === 1) return [values[0], values[0]];
    if (values.length >= 2) return [values[0], values[1]];
    return [1024, 1024];
  }

  function build(source, { scope = 'base', subsets = [], allSubsets = subsets, subsetOffsets = {} } = {}) {
    const subsetOffset = name => subsetOffsets && typeof subsetOffsets === 'object'
      && !Array.isArray(subsetOffsets) && Object.prototype.hasOwnProperty.call(subsetOffsets, name)
      ? subsetOffsets[name] : '';
    const sampling = String(source.timestep_sampling || 'sigmoid');
    const weighting = String(source.weighting_scheme || 'uniform');
    const isKrea2 = String(source.model_train_type || '') === 'krea2-lora';
    const truncated = !isKrea2 && sampling === 'truncated_logit_normal';
    const sigmoidScale = numberValue(source.sigmoid_scale, 1.0);
    const configuredFlowShift = Math.max(0.0001, numberValue(source.discrete_flow_shift, 1.0));
    // The current Krea 2 scheduler leaves its sigma table unshifted.
    const flowShift = isKrea2 && sampling === 'sigma'
      ? 1.0
      : configuredFlowShift;
    const logitMean = numberValue(source.logit_mean, 0.0);
    const logitStd = Math.max(0, numberValue(source.logit_std, 1.0));
    const cutoff = Math.max(Number.MIN_VALUE, Math.min(1, numberValue(source.timestep_cutoff, 0.95)));
    const uniformRatio = Math.max(0, Math.min(1, numberValue(source.timestep_uniform_ratio, 0.01)));
    const modeScale = numberValue(source.mode_scale, 1.29);
    const rangeMin = isKrea2 ? Math.max(0, Number(source.min_timestep || 0)) / 1000 : 0;
    const rangeMax = isKrea2 ? Math.min(1000, Number(source.max_timestep ?? 1000)) / 1000 : 1;
    const rangeWidth = rangeMax - rangeMin;
    const [width, height] = parseResolution(source.resolution);
    const pointCount = 120;
    const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-60, Math.min(60, value))));
    const logit = value => {
      return Math.log(value / (1 - value));
    };

    const inverseShift = (sigma, shift) => sigma / (shift + (1 - shift) * sigma);

    // MOSS has already patchified the VAE f8 latents to f16 before calling
    // the shared sampler, which then derives its shift from (h / 2) * (w / 2).
    const latentCompression = source.model_train_type === 'moss-image-lora' ? 16 : 8;
    const latentH = Math.floor(height / latentCompression);
    const latentW = Math.floor(width / latentCompression);
    const tokenCount = Math.floor(latentH / 2) * Math.floor(latentW / 2);
    const getShiftParam = maxTokens => {
      const mu = 0.5 + ((1.15 - 0.5) / (maxTokens - 256)) * (tokenCount - 256);
      return Math.exp(mu);
    };

    let activeShift = 1.0;
    if (sampling === 'shift') {
      activeShift = flowShift;
    } else if (sampling === 'flux_shift') {
      activeShift = getShiftParam(4096);
    } else if (sampling === 'krea2_shift') {
      activeShift = getShiftParam(6400);
    }

    const shiftSigma = (u, shift) => u * shift / (1 + (shift - 1) * u);
    const schedulerSigma = u => shiftSigma(1 - Math.min(999, Math.floor((rangeMin + u * rangeWidth) * 1000)) / 1000, flowShift);
    let fixedSigma = null;
    if (['sigmoid', 'shift', 'flux_shift', 'krea2_shift'].includes(sampling) && sigmoidScale === 0) {
      fixedSigma = shiftSigma(0.5, activeShift);
    } else if (sampling === 'sigma' && weighting === 'logit_normal' && logitStd === 0 &&
        (isKrea2 || scope === 'base' || !Object.values(source.subset_timestep_offsets || {}).some(Number))) {
      fixedSigma = schedulerSigma(sigmoid(logitMean));
    } else if (sampling === 'logsnr' && logitStd === 0) {
      fixedSigma = sigmoid(-logitMean / 2);
    }
    if (fixedSigma !== null && sampling !== 'sigma' && !source.preserve_distribution_shape) {
      fixedSigma = rangeMin + fixedSigma * rangeWidth;
    }

    // Normal CDF approximation (absolute error < 7.5e-8).
    const normalCdf = z => {
      if (z === 0) return 0.5;
      const t = 1 / (1 + 0.2316419 * Math.abs(z));
      const tail = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t
        * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
      return z < 0 ? tail : 1 - tail;
    };
    const bisect = (fn, target, lo = 0, hi = 1, increasing = true) => {
      for (let i = 0; i < 44; i++) {
        const mid = (lo + hi) / 2;
        if ((fn(mid) < target) === increasing) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };

    // Mode can fold back on itself. Integrate the uniform input on each monotone
    // branch instead of sampling a histogram or assuming a single inverse.
    const modeTransform = r => r + modeScale * (Math.cos(Math.PI * r / 2) ** 2 - 1 + r);
    const turningSin = 2 * (1 + modeScale) / (Math.PI * modeScale);
    const modeBounds = [0, 1];
    if (turningSin > 0 && turningSin < 1) {
      const turn = Math.asin(turningSin) / Math.PI;
      modeBounds.splice(1, 0, turn, 1 - turn);
    }
    const modeCdf = s => {
      let mass = 0;
      for (let i = 1; i < modeBounds.length; i++) {
        const lo = modeBounds[i - 1], hi = modeBounds[i];
        const a = modeTransform(lo), b = modeTransform(hi);
        if (s >= Math.max(a, b)) mass += hi - lo;
        else if (s > Math.min(a, b)) {
          const root = bisect(modeTransform, s, lo, hi, b > a);
          mass += b > a ? root - lo : hi - root;
        }
      }
      return mass;
    };

    const unboundedCdf = (sigma, offset) => {
      if (sigma <= 0) return 0;
      if (sigma >= 1) return 1;
      if (sampling === 'uniform') return sigma;
      if (sampling === 'sigma') {
        const s = inverseShift(sigma, flowShift);
        if (weighting === 'mode') return modeCdf(s);
        if (weighting === 'logit_normal') {
          const mean = logitMean - (isKrea2 ? 0 : offset);
          if (logitStd === 0) return sigma < schedulerSigma(sigmoid(mean)) ? 0 : 1;
          return normalCdf((logit(s) + mean) / logitStd);
        }
        return s;
      }
      if (truncated) {
        // Smooth density for the chart; computeStats integrates these cell
        // boundaries on the actual 1000-point grid used by ceil(S * 1000).
        const s = inverseShift(sigma, flowShift);
        if (s === 0) return 0;
        const mean = logitMean - offset;
        const std = Math.max(logitStd, 1e-12);
        // The trainer computes the lower normal CDF in float64 and clamps its
        // inverse-CDF input to 1 - 1e-12. In extreme tails this creates a point
        // mass, potentially clipped to the last grid cell; mirror it here.
        const lowerCdf = cutoff === 1 ? 0 : normalCdf((-logit(cutoff) - mean) / std);
        const retainedMass = 1 - lowerCdf;
        const maxNormalQuantile = 7.0344869100478356; // ndtri(1 - 1e-12)
        const minSample = sigmoid(-(mean + std * maxNormalQuantile)) / cutoff;
        let truncatedMass = 0;
        if (s >= minSample) {
          truncatedMass = lowerCdf >= 1 - 1e-12 ? 1
            : Math.min(1, normalCdf((logit(cutoff * s) + mean) / std) / retainedMass);
        }
        return uniformRatio * s + (1 - uniformRatio) * truncatedMass;
      }
      if (sampling === 'logsnr') return normalCdf((2 * logit(sigma) + logitMean) / logitStd);
      const appliedOffset = ['sigmoid', 'shift', 'flux_shift'].includes(sampling) ? offset : 0;
      const s = inverseShift(sigma, activeShift);
      return normalCdf((logit(s) - sigmoidScale * appliedOffset) / Math.abs(sigmoidScale));
    };
    const evaluateCdf = (sigma, offset) => {
      if (fixedSigma !== null) return sigma < fixedSigma ? 0 : 1;
      if (!isKrea2 || !(rangeWidth > 0)) return unboundedCdf(sigma, offset);
      if (sampling === 'sigma') {
        // Musubi ranges scheduler indices; its sigma table runs in reverse.
        return unboundedCdf((sigma - (1 - rangeMax)) / rangeWidth, offset);
      }
      if (!source.preserve_distribution_shape) return unboundedCdf((sigma - rangeMin) / rangeWidth, offset);
      const left = unboundedCdf(rangeMin, offset), mass = unboundedCdf(rangeMax, offset) - left;
      if (!(mass > 0)) return unboundedCdf(sigma, offset);
      return Math.max(0, Math.min(1, (unboundedCdf(sigma, offset) - left) / mass));
    };

    // Bin-average continuous density: differences of CDF values preserve all
    // probability mass, even when a peak is much narrower than one plotting bin.
    const generatePdfCurve = cdf => {
      if (fixedSigma !== null) return Array(pointCount).fill(0);
      const edges = Array.from({ length: pointCount + 1 }, (_, i) => cdf(i / pointCount));
      return edges.slice(1).map((value, i) => (value - edges[i]) * pointCount / 1000).reverse();
    };

    const baselineCdf = sigma => evaluateCdf(sigma, 0);
    let currentCdf = baselineCdf;
    let scopeLabelKey = 'timestepPreview.baseDistribution';
    let scopeLabel = '';
    let offset = 0;
    if (scope === 'overall' && subsets.length) {
      // Regularization samples have no per-subset offset, but still take part
      // in training and must contribute to the overall sampling distribution.
      const totalSamples = allSubsets.reduce((sum, subset) => sum + Number(subset.sample_count || 0), 0);
      const components = allSubsets.map(subset => ({
        weight: totalSamples ? Number(subset.sample_count || 0) / totalSamples : 1 / allSubsets.length,
        offset: subset.is_reg ? 0 : Number(subsetOffset(subset.name) || 0),
      }));
      currentCdf = sigma => components.reduce((sum, part) => sum + part.weight * evaluateCdf(sigma, part.offset), 0);
      scopeLabelKey = 'timestepPreview.overallDistribution';
    } else {
      const selectedSubset = subsets.find(subset => subset.name === scope);
      if (selectedSubset) {
        offset = Number(subsetOffset(selectedSubset.name) || 0);
        currentCdf = sigma => evaluateCdf(sigma, offset);
        scopeLabelKey = '';
        scopeLabel = selectedSubset.name;
      }
    }

    const baselineDensities = generatePdfCurve(baselineCdf);
    const densities = generatePdfCurve(currentCdf);
    const maxDensity = Math.max(...densities, ...baselineDensities, 0.00001);

    // Calculate clean scientific Y-Axis upper bound (e.g. 0.00175, 0.00200, 0.00250)
    let yUpper = 0.0020;
    if (maxDensity <= 0.0012) yUpper = 0.00125;
    else if (maxDensity <= 0.0017) yUpper = 0.00175;
    else if (maxDensity <= 0.0020) yUpper = 0.00200;
    else if (maxDensity <= 0.0025) yUpper = 0.00250;
    else if (maxDensity <= 0.0030) yUpper = 0.00300;
    else yUpper = Math.ceil(maxDensity * 10000) / 10000;

    const yTickCount = 4; // 0, 1/4, 2/4, 3/4, 4/4
    const yTicks = [];
    for (let i = 0; i <= yTickCount; i += 1) {
      const val = (yUpper * (yTickCount - i)) / yTickCount;
      const yPercent = (i / yTickCount) * 100; // 0% to 100% full coordinate span
      yTicks.push({
        label: val.toFixed(5),
        y: yPercent.toFixed(2),
        isZero: i === yTickCount,
      });
    }

    // Compute Loss Weighting Curve (matched from t=1000 down to t=0)
    const lossLogWeight = sigma => {
      let w = 1.0;
      // The sigma_sqrt limit at zero is infinite; a finite off-screen point
      // lets SVG clip the rising curve without drawing a flat cap at the top.
      if (weighting === 'sigma_sqrt') w = Math.max(Number.EPSILON, sigma) ** -2;
      else if (weighting === 'cosmap') w = 2 / (Math.PI * (1 - 2 * sigma + 2 * sigma * sigma));
      return Math.log1p(w);
    };
    const logWeights = Array.from({ length: pointCount }, (_, i) => lossLogWeight(1 - (i + 0.5) / pointCount));
    const maxLogWeight = Math.max(...logWeights, 1);

    // Build SVG Coordinates (x: 0~100, y: 0~100) mapped directly to 0~100%
    const buildSvgPath = values => {
      const densityY = val => Math.max(0, 100 - (Math.max(0, val) / yUpper) * 100).toFixed(2);
      const coords = values.map((val, idx) => {
        const x = ((idx + 0.5) / pointCount) * 100;
        return `${x.toFixed(2)},${densityY(val)}`;
      });
      // Extrapolate half a bin to each boundary along the adjacent segment.
      // Repeating the edge bin's height would introduce an artificial flat stub.
      coords.unshift(`0,${densityY(values[0] + (values[0] - values[1]) / 2)}`);
      const last = values.length - 1;
      coords.push(`100,${densityY(values[last] + (values[last] - values[last - 1]) / 2)}`);
      const linePath = 'M ' + coords.join(' L ');
      const areaPath = `M 0,100 L ${coords.join(' L ')} L 100,100 Z`;
      return { linePath, areaPath, coords };
    };

    const currentSvg = buildSvgPath(densities);
    const baselineSvg = buildSvgPath(baselineDensities);

    const weightPoints = [lossLogWeight(1), ...logWeights, lossLogWeight(0)].map((lw, idx) => {
      const x = (idx === 0 ? 0 : idx === pointCount + 1 ? 100 : ((idx - 0.5) / pointCount) * 100).toFixed(2);
      const y = (100 - (lw * 100 / maxLogWeight)).toFixed(2);
      return `${x},${y}`;
    }).join(' ');

    // Statistics do not depend on plotting resolution. Sigma sampling uses the
    // trainer's 1000 scheduler entries; other samplers use the continuous CDF.
    const computeStats = cdf => {
      if (fixedSigma !== null) {
        return {
          low: fixedSigma < 1 / 3 ? 100 : 0,
          mid: fixedSigma >= 1 / 3 && fixedSigma < 2 / 3 ? 100 : 0,
          high: fixedSigma >= 2 / 3 ? 100 : 0,
          median: Math.round(fixedSigma * 1000),
          medianPercent: ((1 - fixedSigma) * 100).toFixed(1),
        };
      }
      let low = cdf(1 / 3), high = 1 - cdf(2 / 3);
      let medianSigma = bisect(cdf, 0.5);
      if (sampling === 'sigma' || truncated) {
        low = 0;
        high = 0;
        let previous = 0;
        medianSigma = null;
        for (let k = 1; k <= 1000; k++) {
          const sigma = shiftSigma(k / 1000, flowShift);
          const cumulative = cdf(sigma);
          const mass = cumulative - previous;
          if (sigma < 1 / 3) low += mass;
          else if (sigma >= 2 / 3) high += mass;
          // Lower median; tolerance only absorbs numerical inversion roundoff.
          if (medianSigma === null && cumulative >= 0.5 - 1e-12) medianSigma = sigma;
          previous = cumulative;
        }
      }
      return {
        low: low * 100, mid: (1 - low - high) * 100, high: high * 100,
        median: Math.round(medianSigma * 1000), medianPercent: ((1 - medianSigma) * 100).toFixed(1),
      };
    };

    const baselineStats = computeStats(baselineCdf);
    const currentStats = currentCdf === baselineCdf ? baselineStats : computeStats(currentCdf);
    const noteKeys = [];
    if (isKrea2 && (rangeMin > 0 || rangeMax < 1)) noteKeys.push('timestepPreview.kreaRangeNote');
    const shiftIgnored = Math.abs(configuredFlowShift - 1) > 1e-9
      && (isKrea2 ? sampling !== 'shift' : !['shift', 'sigma', 'truncated_logit_normal'].includes(sampling));
    if (shiftIgnored) {
      noteKeys.push('timestepPreview.shiftIgnored');
    }
    if (sampling === 'flux_shift') noteKeys.push('timestepPreview.fluxShiftNote');
    if (sampling === 'krea2_shift') noteKeys.push('timestepPreview.krea2ShiftNote');
    if (['logit_normal', 'mode'].includes(weighting) && sampling !== 'sigma') {
      noteKeys.push('timestepPreview.densityIgnored');
    }
    if (!['sigma_sqrt', 'cosmap'].includes(weighting)) {
      noteKeys.push('timestepPreview.uniformWeightNote');
    }

    // Conditional parameter cards: only the inputs that actually shape the current
    // curve get a card; everything else stays hidden to keep the matrix honest.
    const fmtParam = value => String(Math.round(Number(value) * 1000) / 1000);
    const sigmoidFamily = ['sigmoid', 'shift', 'flux_shift', 'krea2_shift'].includes(sampling);
    const offsetText = `${offset > 0 ? '+' : ''}${fmtParam(offset)}`;

    return {
      sampling,
      weighting,
      scope,
      scopeLabelKey,
      scopeLabel,
      offset,
      offsetText,
      sigmoidScaleCard: sigmoidFamily ? fmtParam(sigmoidScale) : null,
      flowShiftCard: sampling === 'shift' || sampling === 'sigma' || truncated ? fmtParam(flowShift) : null,
      derivedShiftCard: sampling === 'flux_shift' || sampling === 'krea2_shift'
        ? fmtParam(Number(activeShift.toFixed(2))) : null,
      logitMeanCard: truncated || sampling === 'logsnr' || (sampling === 'sigma' && weighting === 'logit_normal')
        ? fmtParam(logitMean) : null,
      logitStdCard: truncated || sampling === 'logsnr' || (sampling === 'sigma' && weighting === 'logit_normal')
        ? fmtParam(logitStd) : null,
      cutoffCard: truncated ? fmtParam(cutoff) : null,
      uniformRatioCard: truncated ? fmtParam(uniformRatio) : null,
      modeScaleCard: sampling === 'sigma' && weighting === 'mode' ? fmtParam(modeScale) : null,
      resolution: `${width} × ${height}`,
      fixedTimestep: fixedSigma === null ? null : Math.round(fixedSigma * 1000),
      densities,
      baselineDensities,
      yTicks: fixedSigma === null ? yTicks : [],
      currentLinePath: fixedSigma === null ? currentSvg.linePath : '',
      currentAreaPath: fixedSigma === null ? currentSvg.areaPath : '',
      baselineLinePath: baselineSvg.linePath,
      weightPoints,
      median: currentStats.median,
      baselineMedian: baselineStats.median,
      medianPercent: currentStats.medianPercent,
      lowPercent: currentStats.low,
      midPercent: currentStats.mid,
      highPercent: currentStats.high,
      baselineLowPercent: baselineStats.low,
      baselineMidPercent: baselineStats.mid,
      baselineHighPercent: baselineStats.high,
      compare: scope !== 'base' && densities.some((density, index) => Math.abs(density - baselineDensities[index]) > 1e-10),
      warning: shiftIgnored
        || (['logit_normal', 'mode'].includes(weighting) && sampling !== 'sigma'),
      noteKeys,
    };
  }

  return { build };
})();
