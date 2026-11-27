/* 训练集诊断时间步分布、理论采样曲线与形态过渡动画；由 dataset-diagnostics-render.js 聚合。 */
(() => {
  const _ddNoiseBinsCache = new WeakMap();
  const _ddTheoSharesCache = new WeakMap();

  function theoreticalPath(coords) {
    const segments = [];
    let span = [];
    for (const c of coords) {
      if (!c.excluded && c.yTheo != null) {
        span.push((span.length ? 'L' : 'M') + c.xCenter.toFixed(1) + ' ' + c.yTheo.toFixed(1));
      } else {
        if (span.length > 1) segments.push(span.join(' '));
        span = [];
      }
    }
    if (span.length > 1) segments.push(span.join(' '));
    return segments.join(' ');
  }

  function patchDensityProfile(svg, coords, bottom) {
    const bars = svg.querySelectorAll?.('[data-dd-ts-density-base] rect') || [];
    for (const bar of bars) {
      const c = coords[Number(bar.getAttribute('data-dd-ts-idx'))];
      bar.classList.toggle('is-sparse', !c.comparable);
      bar.setAttribute('height', c.densityHeight.toFixed(1));
      bar.setAttribute('y', (bottom - c.densityHeight).toFixed(1));
    }
    svg.querySelector?.('.m-dd-ts-theo-line')?.setAttribute('d', theoreticalPath(coords));
    const marks = svg.querySelectorAll?.('[data-dd-ts-nan] > g') || [];
    for (const mark of marks) {
      const c = coords[Number(mark.getAttribute('data-dd-ts-idx'))];
      if (c.non_finite_count > 0) mark.removeAttribute('display');
      else mark.setAttribute('display', 'none');
    }
  }

  function interpolateProfile(previous, next, fraction) {
    return next.map((c, i) => {
      const frame = { ...c };
      for (const key of ['mean_loss', 'p25', 'p75', 'densityHeight', 'yTheo']) {
        const from = previous[i][key];
        if (from != null && c[key] != null) frame[key] = from + (c[key] - from) * fraction;
      }
      return frame;
    });
  }

  window.datasetDiagnosticsTimestepMixin = {
    _ddNoiseExcludedBounds(cfg) {
      const hasMinRaw = Number.isFinite(cfg?.min_timestep);
      const hasMaxRaw = Number.isFinite(cfg?.max_timestep);
      const minT = hasMinRaw ? Math.max(0, Math.min(1000, Number(cfg.min_timestep))) : 0;
      const maxT = hasMaxRaw ? Math.max(0, Math.min(1000, Number(cfg.max_timestep))) : 1000;
      if (minT >= maxT) return { minT: 0, maxT: 1000, hasMin: false, hasMax: false };
      return { minT, maxT, hasMin: minT > 0, hasMax: maxT < 1000 };
    },

    _ddResolveNoiseProfileBins(data, numBins = 18) {
      const scale = data?.timestep_scale || 'thousand';
      if (scale === 'unknown') return [];
      const cacheKey = `${scale}|${numBins}|${data?.timestep_profile?.bins?.length || 0}|${data?.by_timestep?.length || 0}`;
      const cached = data && typeof data === 'object' ? _ddNoiseBinsCache.get(data) : null;
      if (cached && cached.key === cacheKey) return cached.bins;

      let result = [];
      const profileBins = data?.timestep_profile?.bins;
      if (Array.isArray(profileBins) && profileBins.length) {
        result = profileBins.map(b => ({
          bin: Number(b.bin),
          tFrom: Number(b.t_from ?? b.tFrom ?? 0),
          tTo: Number(b.t_to ?? b.tTo ?? 0),
          count: Number(b.count || 0),
          images: b.images != null ? Number(b.images) : null,
          comparable: b.comparable !== false && Number(b.count || 0) > 0,
          mean_loss: b.mean_loss != null && Number.isFinite(Number(b.mean_loss)) ? Number(b.mean_loss) : null,
          p25: b.p25 != null && Number.isFinite(Number(b.p25)) ? Number(b.p25) : null,
          p75: b.p75 != null && Number.isFinite(Number(b.p75)) ? Number(b.p75) : null,
          non_finite_count: Number(b.non_finite_count || 0),
          trend: b.trend != null && Number.isFinite(Number(b.trend)) ? Number(b.trend) : null,
          early_count: Number(b.early_count || 0),
          early_loss: Number(b.early_loss || 0),
          late_count: Number(b.late_count || 0),
          late_loss: Number(b.late_loss || 0),
        })).sort((a, b) => b.bin - a.bin);
      } else {
        const rawBins = Array.isArray(data?.by_timestep) ? data.by_timestep : [];
        if (rawBins.length) {
          const width = 1000 / numBins;
          const slots = Array.from({ length: numBins }, (_, bin) => ({
            bin,
            tFrom: bin * width,
            tTo: (bin + 1) * width,
            count: 0,
            lossSum: 0,
            imagesMax: null,
            hasComparable: false,
          }));
          const mappedRaw = rawBins.map(b => {
            const tLow = this._ddToTimestep1000(b.timestep_from, scale) ?? 0;
            const tHigh = this._ddToTimestep1000(b.timestep_to, scale) ?? tLow;
            return {
              ...b,
              tLow: Math.min(tLow, tHigh),
              tHigh: Math.max(tLow, tHigh),
            };
          });
          for (const s of slots) {
            const mid = (s.tFrom + s.tTo) / 2;
            const hits = mappedRaw.filter(b => mid >= b.tLow && (mid < b.tHigh || (b.tHigh >= 1000 && mid <= 1000)));
            const match = hits.length ? hits : mappedRaw.filter(b => Math.min(s.tTo, b.tHigh) > Math.max(s.tFrom, b.tLow));
            for (const b of match) {
              const c = Number(b.count || 0);
              if (!c || b.mean_loss == null) continue;
              s.count += c;
              s.lossSum += Number(b.mean_loss) * c;
              if (b.images != null) s.imagesMax = Math.max(s.imagesMax ?? 0, Number(b.images));
              if (b.comparable_count > 0) s.hasComparable = true;
            }
          }
          result = slots.map(s => ({
            bin: s.bin,
            tFrom: s.tFrom,
            tTo: s.tTo,
            count: s.count,
            images: s.imagesMax,
            comparable: s.count > 0 && s.hasComparable,
            mean_loss: s.count > 0 ? (s.lossSum / s.count) : null,
            p25: null,
            p75: null,
            non_finite_count: 0,
            trend: null,
            early_count: 0,
            early_loss: 0,
            late_count: 0,
            late_loss: 0,
          })).sort((a, b) => b.bin - a.bin);
        }
      }

      if (data && typeof data === 'object') {
        _ddNoiseBinsCache.set(data, { key: cacheKey, bins: result });
      }
      return result;
    },

    _ddPrepareTimestepBins(rawBins, compSeries, excluded) {
      if (!Array.isArray(rawBins) || !rawBins.length) {
        return { bins: [], totalCount: 0 };
      }
      const hasCompSeries = Boolean(compSeries && Array.isArray(compSeries.counts) && Array.isArray(compSeries.mean_loss));
      let totalCount = 0;
      const bins = rawBins.map(b => {
        totalCount += Number(b.count || 0);
        const isExcluded = Boolean(
          (excluded?.hasMax && b.tFrom >= excluded.maxT - 1e-6)
          || (excluded?.hasMin && b.tTo <= excluded.minT + 1e-6)
        );
        const compCount = hasCompSeries ? Number(compSeries.counts?.[b.bin] || 0) : 0;
        const compLossRaw = hasCompSeries ? compSeries.mean_loss?.[b.bin] : null;
        const compLoss = (compCount > 0 && compLossRaw != null && Number.isFinite(Number(compLossRaw)))
          ? Number(compLossRaw)
          : null;
        return {
          ...b,
          excluded: isExcluded,
          compCount,
          compLoss,
        };
      });
      return { bins, totalCount };
    },

    _ddComputeTheoreticalBinShares(data, bins, excluded) {
      const rawCfg = data?.sampling_config;
      const samplingName = rawCfg?.timestep_sampling || (data?.profile === 'sdxl-lora' ? 'uniform' : '');
      if (!samplingName) return null;
      const cfg = { ...(rawCfg || {}), timestep_sampling: samplingName };
      const previewLib = (typeof window !== 'undefined' ? window.TrainingTimestepPreview : null) || globalThis.TrainingTimestepPreview;
      if (typeof previewLib?.build !== 'function') return null;
      if (!Array.isArray(bins) || !bins.length) return null;

      const rawReso = Array.isArray(data?.by_resolution) ? data.by_resolution : [];
      const rawSubsets = Array.isArray(data?.by_subset) ? data.by_subset : [];
      const rawJointOffsets = Array.isArray(data?.timestep_profile?.resolution_offsets)
        ? data.timestep_profile.resolution_offsets
        : [];
      const sig = JSON.stringify([
        data?.profile || '',
        cfg,
        excluded?.hasMin ? excluded.minT : 0,
        excluded?.hasMax ? excluded.maxT : 1000,
        bins.map(b => `${b.bin}:${b.tFrom}:${b.tTo}:${b.excluded ? 1 : 0}`),
        rawReso.map(r => `${r?.key || ''}:${r?.count || 0}`),
        rawSubsets.map(s => `${s?.key || ''}:${s?.count || 0}:${s?.timestep_offset ?? ''}`),
        rawJointOffsets,
      ]);
      const cached = data && typeof data === 'object' ? _ddTheoSharesCache.get(data) : null;
      if (cached && cached.sig === sig) return cached.shares;

      const allSubsets = rawSubsets
        .filter(s => s && s.key !== '(unknown)' && Number(s.count || 0) > 0)
        .map(s => ({
          name: String(s.key),
          sample_count: Number(s.count || 0),
          // sd-scripts reads custom_attributes.timestep_sampling.offset regardless of is_reg.
          is_reg: false,
        }));
      const subsetOffsets = {};
      for (const s of rawSubsets) {
        if (!s) continue;
        const off = Number(s.timestep_offset);
        if (s.key && s.key !== '(unknown)' && Number.isFinite(off) && Math.abs(off) > 1e-9) {
          subsetOffsets[String(s.key)] = off;
        }
      }
      const hasOffsets = allSubsets.length > 0 && Object.keys(subsetOffsets).length > 0;
      const previewOpts = hasOffsets
        ? { scope: 'overall', subsets: allSubsets, allSubsets, subsetOffsets }
        : { scope: 'base' };

      const sampling = String(cfg.timestep_sampling || '');
      const isShiftSampling = ['flux_shift', 'krea2_shift'].includes(sampling);
      const jointBuckets = isShiftSampling
        ? rawJointOffsets
          .map(entry => {
            const m = /^(\d+)\s*[xX×,]\s*(\d+)$/.exec(String(entry?.resolution || '').trim());
            const c = Number(entry?.count || 0);
            const off = Number(entry?.offset || 0);
            if (!m || !(c > 0)) return null;
            const w = Number(m[1]), h = Number(m[2]);
            return (w > 0 && h > 0)
              ? { resolution: `${w},${h}`, weight: c, offset: Number.isFinite(off) ? off : 0 }
              : null;
          })
          .filter(Boolean)
        : [];
      const resBuckets = (isShiftSampling && !jointBuckets.length)
        ? rawReso
          .map(r => {
            const m = /^(\d+)\s*[xX×,]\s*(\d+)$/.exec(String(r?.key || '').trim());
            const c = Number(r?.count || 0);
            if (!m || !(c > 0)) return null;
            const w = Number(m[1]), h = Number(m[2]);
            return (w > 0 && h > 0) ? { resolution: `${w},${h}`, weight: c } : null;
          })
          .filter(Boolean)
        : [];

      const baseSource = {
        ...cfg,
        model_train_type: cfg.model_train_type || data?.profile || '',
        ...(hasOffsets ? { subset_timestep_offsets: subsetOffsets } : {}),
      };

      let combinedDensities = null;
      if (jointBuckets.length) {
        let totalWeight = 0;
        for (const bucket of jointBuckets) {
          const hasOff = Math.abs(bucket.offset) > 1e-9;
          const itemSource = hasOff
            ? { ...cfg, model_train_type: baseSource.model_train_type, resolution: bucket.resolution, subset_timestep_offsets: { __s: bucket.offset } }
            : { ...cfg, model_train_type: baseSource.model_train_type, resolution: bucket.resolution };
          const itemOpts = hasOff
            ? {
              scope: '__s',
              subsets: [{ name: '__s', sample_count: bucket.weight, is_reg: false }],
              allSubsets: [{ name: '__s', sample_count: bucket.weight, is_reg: false }],
              subsetOffsets: { __s: bucket.offset },
            }
            : { scope: 'base' };
          const m = previewLib.build(itemSource, itemOpts);
          if (!m || !Array.isArray(m.densities) || !m.densities.length || m.fixedTimestep != null) continue;
          if (!combinedDensities) combinedDensities = new Array(m.densities.length).fill(0);
          if (combinedDensities.length !== m.densities.length) continue;
          for (let i = 0; i < m.densities.length; i++) {
            combinedDensities[i] += Math.max(0, Number(m.densities[i] || 0)) * bucket.weight;
          }
          totalWeight += bucket.weight;
        }
        if (combinedDensities && totalWeight > 0) {
          combinedDensities = combinedDensities.map(v => v / totalWeight);
        } else {
          combinedDensities = null;
        }
      } else if (resBuckets.length) {
        let totalWeight = 0;
        for (const bucket of resBuckets) {
          const m = previewLib.build({ ...baseSource, resolution: bucket.resolution }, previewOpts);
          if (!m || !Array.isArray(m.densities) || !m.densities.length || m.fixedTimestep != null) continue;
          if (!combinedDensities) combinedDensities = new Array(m.densities.length).fill(0);
          if (combinedDensities.length !== m.densities.length) continue;
          for (let i = 0; i < m.densities.length; i++) {
            combinedDensities[i] += Math.max(0, Number(m.densities[i] || 0)) * bucket.weight;
          }
          totalWeight += bucket.weight;
        }
        if (combinedDensities && totalWeight > 0) {
          combinedDensities = combinedDensities.map(v => v / totalWeight);
        } else {
          combinedDensities = null;
        }
      } else {
        const model = previewLib.build(baseSource, previewOpts);
        if (model && Array.isArray(model.densities) && model.densities.length && model.fixedTimestep == null) {
          combinedDensities = model.densities;
        }
      }

      let shares = null;
      if (combinedDensities && combinedDensities.length) {
        const nDens = combinedDensities.length;
        const sliceW = 1000 / nDens;
        const loBound = excluded?.hasMin ? excluded.minT : 0;
        const hiBound = excluded?.hasMax ? excluded.maxT : 1000;
        const raw = bins.map(b => {
          if (b.excluded) return 0;
          const lo = Math.max(loBound, b.tFrom);
          const hi = Math.min(hiBound, b.tTo);
          if (hi <= lo) return 0;
          let mass = 0;
          for (let i = 0; i < nDens; i++) {
            const dHi = 1000 - i * sliceW;
            const dLo = dHi - sliceW;
            const overlap = Math.min(hi, dHi) - Math.max(lo, dLo);
            if (overlap > 0) mass += Math.max(0, Number(combinedDensities[i] || 0)) * overlap;
          }
          return mass;
        });
        const sum = raw.reduce((acc, v) => acc + v, 0);
        if (sum > 1e-9) shares = raw.map(v => v / sum);
      }

      if (data && typeof data === 'object') {
        _ddTheoSharesCache.set(data, { sig, shares });
      }
      return shares;
    },

    _ddBuildSegmentedLossPaths(points) {
      const solidSegs = [];
      const sparseSegs = [];
      const gapSegs = [];
      const isolated = [];
      let span = [];
      const flushSpan = () => {
        if (!span.length) return;
        const validItems = span.filter(item => item.pt.valid);
        if (validItems.length === 1) {
          isolated.push(validItems[0].pt);
        } else if (validItems.length >= 2) {
          for (let i = 0; i < validItems.length - 1; i++) {
            const a = validItems[i], b = validItems[i + 1];
            const seg = `M${a.pt.x.toFixed(1)} ${a.pt.y.toFixed(1)} L${b.pt.x.toFixed(1)} ${b.pt.y.toFixed(1)}`;
            if (b.idx === a.idx + 1) {
              if (a.pt.comparable && b.pt.comparable) solidSegs.push(seg);
              else sparseSegs.push(seg);
            } else {
              gapSegs.push(seg);
            }
          }
        }
        span = [];
      };
      points.forEach((pt, idx) => {
        if (pt && !pt.excluded) span.push({ pt, idx });
        else flushSpan();
      });
      flushSpan();
      return {
        solidD: solidSegs.join(' '),
        sparseD: sparseSegs.join(' '),
        gapD: gapSegs.join(' '),
        isolated,
      };
    },

    _ddNoiseToneClass(tone) {
      if (tone === 'danger') return ' is-tone-danger';
      if (tone === 'warn') return ' is-tone-warn';
      if (tone === 'ok') return ' is-tone-ok';
      return '';
    },

    _ddResolveActiveNoiseComparison(data, panel = null) {
      if (!data || !data.available) return null;
      const images = Array.isArray(data.by_image) ? data.by_image : [];
      const profile = data.timestep_profile || {};
      const t = k => this.tMonitor(k);
      const toneForPreset = p => (p === 'non_finite' ? 'danger' : (p === 'attention' ? 'warn' : (p === 'easy' ? 'ok' : 'accent')));
      const source = typeof this._datasetDiagSource === 'function' ? this._datasetDiagSource() : { key: '' };

      const resolveImage = imageId => {
        if (!imageId) return null;
        const img = images.find(i => i.image_id === imageId) || null;
        const cacheKey = (source.key && typeof this._datasetDiagDetailCacheKey === 'function')
          ? this._datasetDiagDetailCacheKey(source, imageId) : '';
        const detail = cacheKey ? (this._datasetDiagDetailCache?.get(cacheKey) || null) : null;
        return {
          kind: 'image',
          imageId,
          image: img,
          images: img ? [img] : [],
          label: img?.name || imageId,
          detail,
          series: null,
          tone: toneForPreset(img?.status),
        };
      };

      const preview = this._datasetDiagHoverPreview;
      if (preview?.kind === 'image' && preview.imageId) {
        return resolveImage(preview.imageId);
      }
      if (preview?.kind === 'preset' && preview.preset) {
        const matched = images.filter(img => (this._datasetDiagImageMatchesPreset
          ? this._datasetDiagImageMatchesPreset(img, preview.preset)
          : img.status === preview.preset));
        return {
          kind: 'status',
          key: preview.preset,
          label: t('ddStatusSummaryTitle'),
          images: matched,
          series: profile.by_status?.[preview.preset] || null,
          tone: toneForPreset(preview.preset),
        };
      }
      if (preview?.kind === 'group' && preview.dim) {
        const matched = preview.dim === 'batch_size'
          ? []
          : images.filter(img => {
            if (preview.dim === 'resolution') return (img.resolutions || [img.resolution]).includes(preview.key);
            if (preview.dim === 'subset') return (img.subsets || [img.subset]).includes(preview.key);
            if (preview.dim === 'directory') return (img.directory || '(root)') === preview.key;
            return false;
          });
        return {
          kind: 'group',
          dim: preview.dim,
          key: preview.key,
          label: this._ddGroupDisplayLabel(t, data, preview.dim, preview.key),
          images: matched,
          series: profile.by_group?.[preview.dim]?.[preview.key] || null,
          tone: 'accent',
        };
      }

      const scopePanel = panel || globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const activeDot = scopePanel?.querySelector?.('[data-dd-hero-wrap][data-mode="quadrant"]')?._ddActiveDot;
      if (activeDot?.image_id) {
        return resolveImage(activeDot.image_id);
      }

      if (!this._datasetDiagHasActiveFilter?.()) return null;
      const preset = this.datasetDiagPreset || 'all';
      const gf = this.datasetDiagGroupFilter;
      const q = String(this.datasetDiagSearch || '').trim();
      const filtered = this._datasetDiagFilteredImages ? this._datasetDiagFilteredImages() : images;
      if (preset !== 'all' && !gf && !q) {
        return {
          kind: 'status',
          key: preset,
          label: preset,
          images: filtered,
          series: profile.by_status?.[preset] || null,
          tone: toneForPreset(preset),
        };
      }
      if (gf && preset === 'all' && !q) {
        return {
          kind: 'group',
          dim: gf.dim,
          key: gf.key,
          label: gf.label || gf.key,
          images: filtered,
          series: profile.by_group?.[gf.dim]?.[gf.key] || null,
          tone: 'accent',
        };
      }
      return {
        kind: 'subset',
        label: t('ddLegSelectedShort'),
        images: filtered,
        series: null,
        tone: preset !== 'all' ? toneForPreset(preset) : 'accent',
      };
    },

    _ddComputeComparisonZones(data, comp) {
      if (!comp) return null;
      const out = {
        high: { count: 0, comparable_count: 0, mean_residual: null },
        mid: { count: 0, comparable_count: 0, mean_residual: null },
        low: { count: 0, comparable_count: 0, mean_residual: null },
      };
      if (comp.kind === 'group' && comp.series?.noise_zones) {
        for (const key of ['high', 'mid', 'low']) {
          const z = comp.series.noise_zones[key];
          if (!z) continue;
          const count = Number(z.count || 0);
          const compCount = z.comparable_count != null ? Number(z.comparable_count) : count;
          out[key] = {
            count,
            comparable_count: compCount,
            mean_residual: (compCount > 0 && z.mean_residual != null && Number.isFinite(Number(z.mean_residual)))
              ? Number(z.mean_residual)
              : null,
          };
        }
        return out;
      }
      if (comp.kind === 'group' && comp.series?.counts && comp.series?.mean_loss) {
        const baseMap = new Map((data?.timestep_profile?.bins || []).map(b => [Number(b.bin), b]));
        const ranges = { low: [0, 6], mid: [6, 12], high: [12, 18] };
        for (const key of ['high', 'mid', 'low']) {
          const [lo, hi] = ranges[key];
          let count = 0, compCount = 0, resSum = 0;
          for (let b = lo; b < hi; b++) {
            const c = Number(comp.series.counts[b] || 0);
            const ml = comp.series.mean_loss[b];
            const base = baseMap.get(b);
            count += c;
            if (c > 0 && ml != null && Number.isFinite(Number(ml)) && base?.comparable && Number(base.mean_loss) > 0) {
              compCount += c;
              resSum += c * (Number(ml) / Number(base.mean_loss) - 1);
            }
          }
          out[key] = {
            count,
            comparable_count: compCount,
            mean_residual: compCount > 0 ? (resSum / compCount) : null,
          };
        }
        return out;
      }
      if (
        comp.kind === 'group'
        && !comp.series
        && data?.timestep_profile
        && ((Array.isArray(data.timestep_profile.bins) && data.timestep_profile.bins.length > 0)
          || Object.keys(data.timestep_profile.by_group || {}).length > 0)
      ) {
        return out;
      }
      const rows = comp.kind === 'image' ? (comp.image ? [comp.image] : []) : (comp.images || []);
      for (const key of ['high', 'mid', 'low']) {
        let count = 0, compCount = 0, resSum = 0;
        for (const img of rows) {
          const z = img?.noise_zones?.[key];
          if (!z) continue;
          count += Number(z.count || 0);
          const cc = z.comparable_count != null ? Number(z.comparable_count) : Number(z.count || 0);
          if (cc > 0 && z.mean_residual != null && Number.isFinite(Number(z.mean_residual))) {
            compCount += cc;
            resSum += Number(z.mean_residual) * cc;
          }
        }
        out[key] = {
          count,
          comparable_count: compCount,
          mean_residual: compCount > 0 ? (resSum / compCount) : null,
        };
      }
      return out;
    },

    _ddNoiseLegendHtml(t, comp, hasTheo = false) {
      if (!comp) {
        return hasTheo
          ? '<span class="m-dd-leg"><i class="is-line-theo"></i><span>' + this.esc(t('ddLegTheoSampling')) + '</span></span>'
          : '';
      }
      const toneClass = this._ddNoiseToneClass(comp.tone);
      if (comp.kind === 'image') {
        return '<span class="m-dd-leg"><i class="is-line-base"></i><span>' + this.esc(t('ddNoiseTooltipBase')) + '</span></span>'
          + '<span class="m-dd-leg"><i class="is-dot is-sample"></i><span>' + this.esc(t('ddLegThisImage')) + '</span></span>';
      }
      return '<span class="m-dd-leg"><i class="is-line-base"></i><span>' + this.esc(t('ddNoiseTooltipBase')) + '</span></span>'
        + '<span class="m-dd-leg"><i class="is-line-accent' + toneClass + '"></i><span>' + this.esc(t('ddLegSelectedShort')) + '</span></span>';
    },

    _ddZoneColValues(t, data, comp, compZones, key, compTotal = 0) {
      if (!comp) {
        const z = data?.noise_zones?.[key];
        const count = Number(z?.count || 0);
        const sharePct = count > 0 ? Math.round(Number(z.share || 0) * 100) : 0;
        const trend = z?.trend != null && Number.isFinite(Number(z.trend)) ? Number(z.trend) : null;
        return {
          topRight: count > 0 ? `${t('ddZoneCountShort').replace('{n}', count)} · ${sharePct}%` : '—',
          primary: count > 0 ? this._ddFormatLoss(z.mean_loss) : '—',
          color: count > 0 ? '' : 'var(--text-tertiary)',
          delta: count > 0 && trend != null ? this._ddFormatZoneTrend(trend) : '',
          deltaTone: count > 0 && trend != null ? this._ddTrendToneClass(trend) : '',
        };
      }
      const cz = compZones?.[key];
      const count = Number(cz?.count || 0);
      const sharePct = (count > 0 && compTotal > 0) ? Math.round((count / compTotal) * 100) : 0;
      return {
        topRight: count > 0 ? `${t('ddZoneCountShort').replace('{n}', count)} · ${sharePct}%` : '—',
        primary: (cz?.mean_residual != null) ? this._ddFormatResidual(cz.mean_residual) : '—',
        color: (cz?.mean_residual != null) ? this._ddResidualColor(cz.mean_residual, { scale: comp?.kind === 'group' ? 'group' : 'image' }) : 'var(--text-tertiary)',
        delta: '',
        deltaTone: '',
      };
    },

    _ddNoiseZonesSummaryHtml(t, data, comp = null) {
      const compZones = this._ddComputeComparisonZones(data, comp);
      const compTotal = compZones ? ['high', 'mid', 'low'].reduce((s, k) => s + Number(compZones[k]?.count || 0), 0) : 0;
      const zones = [
        ['high', t('ddZoneHighShort')],
        ['mid', t('ddZoneMidShort')],
        ['low', t('ddZoneLowShort')],
      ];
      let html = '<div class="m-dd-zones-strip is-compact" data-dd-hero-zones>';
      zones.forEach(([key, label]) => {
        const vals = this._ddZoneColValues(t, data, comp, compZones, key, compTotal);
        const styleAttr = vals.color ? ` style="color:${this.esc(vals.color)}"` : '';
        const deltaCls = vals.deltaTone ? ' ' + vals.deltaTone : '';
        html += '<div class="m-dd-zone-col" data-dd-zone-col="' + key + '">';
        html += '<div class="m-dd-zone-row"><span class="m-dd-zone-name">' + this.esc(label) + '</span>'
          + '<span class="m-dd-zone-share" data-dd-zone-share="' + key + '">' + this.esc(vals.topRight) + '</span></div>';
        html += '<div class="m-dd-zone-row is-main"><strong class="m-dd-num-val" data-dd-zone-loss="' + key + '"' + styleAttr + '>' + this.esc(vals.primary) + '</strong>'
          + '<span class="m-dd-zone-delta' + deltaCls + '" data-dd-zone-delta="' + key + '">' + this.esc(vals.delta) + '</span></div>';
        html += '</div>';
      });
      html += '</div>';
      return html;
    },

    _ddPatchNoiseCardChrome(root, t, data, comp, animate = false, hasTheo = null, precomputedZones = null) {
      if (!root) return;
      const resolvedHasTheo = hasTheo !== null
        ? Boolean(hasTheo)
        : Boolean(!comp && this._ddComputeTheoreticalBinShares(
          data,
          this._ddPrepareTimestepBins(
            this._ddResolveNoiseProfileBins(data, 18),
            null,
            this._ddNoiseExcludedBounds(data.sampling_config)
          ).bins,
          this._ddNoiseExcludedBounds(data.sampling_config)
        ));
      const legEl = root.querySelector('[data-dd-noise-legend]');
      if (legEl) this._ddPatchHtml(legEl, this._ddNoiseLegendHtml(t, comp, resolvedHasTheo));
      const compZones = precomputedZones !== undefined && precomputedZones !== null
        ? precomputedZones
        : this._ddComputeComparisonZones(data, comp);
      const compTotal = compZones ? ['high', 'mid', 'low'].reduce((s, k) => s + Number(compZones[k]?.count || 0), 0) : 0;
      ['high', 'mid', 'low'].forEach(key => {
        const col = root.querySelector(`[data-dd-zone-col="${key}"]`);
        if (!col) return;
        const vals = this._ddZoneColValues(t, data, comp, compZones, key, compTotal);
        const valEl = col.querySelector(`[data-dd-zone-loss="${key}"]`);
        if (valEl) {
          this._patchDiagStatNumber(valEl, vals.primary, animate && !comp);
          valEl.style.color = vals.color || '';
        }
        const deltaEl = col.querySelector(`[data-dd-zone-delta="${key}"]`);
        if (deltaEl) {
          if (deltaEl.textContent !== vals.delta) deltaEl.textContent = vals.delta;
          deltaEl.className = 'm-dd-zone-delta' + (vals.deltaTone ? ' ' + vals.deltaTone : '');
        }
        const metaEl = col.querySelector(`[data-dd-zone-share="${key}"]`);
        if (metaEl && metaEl.textContent !== vals.topRight) metaEl.textContent = vals.topRight;
      });
    },

    _syncDatasetDiagNoiseOverlay(panel = null) {
      const data = this.datasetDiagData;
      if (!data || !data.available) return;
      const root = panel || globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const wrap = root?.querySelector?.('[data-dd-hero-wrap][data-mode="timestep"]');
      if (!wrap) return;
      const comp = this._ddResolveActiveNoiseComparison(data, root);
      const stage = wrap.querySelector('[data-dd-hero-stage]');
      const svg = wrap.querySelector('[data-dd-hero-svg]');
      if (stage && svg) {
        this._renderDatasetDiagHeroSvg(wrap, stage, svg, { animate: false, _resolvedComp: comp });
      }
    },

    _ddStopTimestepMorphAnim(svg) {
      if (!svg) return;
      if (svg._ddTsAnimRaf && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(svg._ddTsAnimRaf);
      }
      svg._ddTsAnimRaf = 0;
      svg.classList?.remove?.('is-ts-animating');
    },

    _ddBuildTimestepCompSeriesPaths(coords, compYArr, compComparableArr = null) {
      const compPaths = this._ddBuildSegmentedLossPaths(
        coords.map((c, idx) => ({
          x: c.xCenter,
          y: compYArr[idx],
          comparable: compComparableArr ? !!compComparableArr[idx] : (c.compCount > 0),
          valid: compYArr[idx] != null,
          excluded: c.excluded,
        }))
      );
      return {
        solidD: compPaths.solidD,
        dashedD: [compPaths.sparseD, compPaths.gapD].filter(Boolean).join(' '),
      };
    },

    _ddBuildTimestepBaseData(coords, toY) {
      const pts = coords.map(c => ({
        ...c,
        y: c.valid ? toY(c.mean_loss) : null,
        yP25: (c.valid && c.p25 != null) ? toY(c.p25) : null,
        yP75: (c.valid && c.p75 != null) ? toY(c.p75) : null,
      }));
      const basePaths = this._ddBuildSegmentedLossPaths(
        pts.map(c => ({ x: c.xCenter, y: c.y, comparable: c.comparable, valid: c.valid, excluded: c.excluded }))
      );
      const iqrSegs = [];
      let span = [];
      const flushIqr = () => {
        if (span.length >= 2) {
          const top = span.map((c, i) => (i ? 'L' : 'M') + c.xCenter.toFixed(1) + ' ' + c.yP75.toFixed(1)).join(' ');
          const bot = span.slice().reverse().map(c => 'L' + c.xCenter.toFixed(1) + ' ' + c.yP25.toFixed(1)).join(' ');
          iqrSegs.push(`${top} ${bot} Z`);
        }
        span = [];
      };
      for (const c of pts) {
        if (c.excluded) flushIqr();
        else if (c.yP25 != null && c.yP75 != null) span.push(c);
      }
      flushIqr();
      const iqrD = iqrSegs.join(' ');
      const isolatedX = new Set(basePaths.isolated.map(pt => pt.x.toFixed(1)));
      const showPointDot = (c, idx) => {
        if (c.excluded || !c.valid) return false;
        if (!c.comparable) return true;
        if (isolatedX.has(c.xCenter.toFixed(1))) return true;
        const prevValid = idx > 0 && !pts[idx - 1].excluded && pts[idx - 1].valid;
        const nextValid = idx + 1 < pts.length && !pts[idx + 1].excluded && pts[idx + 1].valid;
        return !prevValid && !nextValid;
      };
      const dotPts = [];
      pts.forEach((c, idx) => {
        if (showPointDot(c, idx)) dotPts.push(c);
      });
      return { pts, basePaths, iqrD, dotPts };
    },

    _ddBuildTimestepBaseMarkup(coords, toY) {
      const { basePaths, iqrD, dotPts } = this._ddBuildTimestepBaseData(coords, toY);
      const iqrBandHtml = iqrD ? `<path class="m-dd-ts-iqr-band" data-dd-ts-iqr d="${iqrD}"/>` : '';
      const basePtsHtml = dotPts.map(c => {
        const sparseCls = c.comparable ? '' : ' is-sparse';
        return `<circle class="m-dd-ts-dot${sparseCls}" data-dd-ts-base-dot="${c.idx}" cx="${c.xCenter.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${c.comparable ? '1.5' : '1.6'}"/>`;
      }).join('');
      return `${iqrBandHtml}`
        + `${basePaths.solidD ? `<path class="m-dd-ts-base-line" data-dd-ts-base-solid d="${basePaths.solidD}"/>` : ''}`
        + `${basePaths.sparseD ? `<path class="m-dd-ts-base-line is-sparse" data-dd-ts-base-sparse d="${basePaths.sparseD}"/>` : ''}`
        + `${basePaths.gapD ? `<path class="m-dd-ts-base-line is-gap" data-dd-ts-base-gap d="${basePaths.gapD}"/>` : ''}`
        + basePtsHtml;
    },

    _ddBuildTimestepOverlayMarkup(kind, subsetMarkers, imageFinite, imageNonFinite, toX, toY, lossTop, toneClass) {
      if (kind === 'subset' && subsetMarkers.length) {
        const pts = subsetMarkers.map(m => ({ x: toX(m.t1000), y: toY(m.loss) }));
        let html = '';
        if (pts.length >= 2) {
          const line = pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
          html += `<path class="m-dd-ts-comp-line${toneClass}" data-dd-ts-comp-line stroke-dasharray="3 3" d="${line}"/>`;
        }
        html += pts.map((p, i) =>
          `<circle class="m-dd-ts-dot is-comp${toneClass}" data-dd-ts-overlay-dot="${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.2"/>`
        ).join('');
        return html;
      }
      if (kind === 'image') {
        let html = imageFinite.map((s, i) => {
          const cx = toX(s.t1000), cy = toY(s.loss);
          return `<circle class="m-dd-ts-sample-dot" data-dd-ts-sample-dot data-dd-ts-overlay-dot="${i}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.1" style="fill:${this._ddResidualColor(s.residual, { kind: 'graphic' })}"/>`;
        }).join('');
        html += imageNonFinite.map(s => {
          const cx = toX(s.t1000), cy = lossTop + 6;
          return `<g class="m-dd-nan-mark" data-dd-ts-sample-dot><line x1="${(cx - 2.8).toFixed(1)}" y1="${(cy - 2.8).toFixed(1)}" x2="${(cx + 2.8).toFixed(1)}" y2="${(cy + 2.8).toFixed(1)}"/><line x1="${(cx + 2.8).toFixed(1)}" y1="${(cy - 2.8).toFixed(1)}" x2="${(cx - 2.8).toFixed(1)}" y2="${(cy + 2.8).toFixed(1)}"/></g>`;
        }).join('');
        return html;
      }
      return '';
    },

    _ddPatchTimestepOverlayInPlace(compEl, kind, subsetMarkers, imageFinite, toX, curToY, toneClass) {
      if (!compEl) return false;
      if (kind === 'subset') {
        const pts = subsetMarkers.map(m => ({ x: toX(m.t1000), y: curToY(m.loss) }));
        const pathEl = compEl.querySelector?.('[data-dd-ts-comp-line]');
        if (pts.length >= 2) {
          if (!pathEl) return false;
          const line = pts.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
          pathEl.setAttribute('d', line);
          pathEl.setAttribute('class', `m-dd-ts-comp-line${toneClass}`);
        }
        const dotEls = Array.from(compEl.querySelectorAll?.('[data-dd-ts-overlay-dot]') || []);
        if (dotEls.length !== pts.length) return false;
        dotEls.forEach((el, i) => {
          el.setAttribute('cx', pts[i].x.toFixed(1));
          el.setAttribute('cy', pts[i].y.toFixed(1));
        });
        return true;
      }
      if (kind === 'image') {
        const dotEls = Array.from(compEl.querySelectorAll?.('[data-dd-ts-overlay-dot]') || []);
        if (dotEls.length !== imageFinite.length) return false;
        dotEls.forEach((el, i) => {
          const s = imageFinite[i];
          el.setAttribute('cx', toX(s.t1000).toFixed(1));
          el.setAttribute('cy', curToY(s.loss).toFixed(1));
        });
        return true;
      }
      return false;
    },

    _ddPatchTimestepDensitySel(selEl, coords, barHArr, plotBottom, toneClass, isFinal = false) {
      if (!selEl) return;
      const canDomPatch = typeof globalThis.document?.createElementNS === 'function'
        && typeof selEl.querySelectorAll === 'function'
        && typeof selEl.appendChild === 'function';
      if (canDomPatch) {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const existing = Array.from(selEl.querySelectorAll('rect'));
        const byIdx = new Map();
        let hasUntagged = false;
        for (const rect of existing) {
          const key = rect.dataset?.ddTsSelIdx ?? rect.getAttribute?.('data-dd-ts-sel-idx');
          if (key != null && key !== '') byIdx.set(String(key), rect);
          else hasUntagged = true;
        }
        if (hasUntagged) {
          selEl.innerHTML = '';
          byIdx.clear();
        }
        coords.forEach((c, idx) => {
          const h = Math.max(0, Number(barHArr?.[idx] || 0));
          const key = String(c.idx);
          let rect = byIdx.get(key);
          if (h > 0.15) {
            if (!rect) {
              rect = globalThis.document.createElementNS(SVG_NS, 'rect');
              rect.setAttribute('data-dd-ts-sel-idx', key);
              rect.setAttribute('x', c.barX.toFixed(1));
              rect.setAttribute('width', c.barW.toFixed(1));
              rect.setAttribute('rx', '1');
              selEl.appendChild(rect);
            }
            rect.setAttribute('class', `m-dd-ts-density-sel${toneClass}`);
            rect.setAttribute('x', c.barX.toFixed(1));
            rect.setAttribute('width', c.barW.toFixed(1));
            rect.setAttribute('y', (plotBottom - h).toFixed(1));
            rect.setAttribute('height', h.toFixed(1));
          } else if (rect) {
            if (isFinal) {
              rect.remove?.();
              if (rect.parentNode === selEl && typeof selEl.removeChild === 'function') selEl.removeChild(rect);
            } else {
              rect.setAttribute('class', `m-dd-ts-density-sel${toneClass}`);
              rect.setAttribute('y', plotBottom.toFixed(1));
              rect.setAttribute('height', '0');
            }
          }
        });
        return;
      }
      let html = '';
      coords.forEach((c, idx) => {
        const h = Math.max(0, Number(barHArr?.[idx] || 0));
        if (h <= 0.15 && isFinal) return;
        if (h <= 0.15 && !isFinal) {
          html += `<rect class="m-dd-ts-density-sel${toneClass}" data-dd-ts-sel-idx="${c.idx}" x="${c.barX.toFixed(1)}" y="${plotBottom.toFixed(1)}" width="${c.barW.toFixed(1)}" height="0" rx="1"/>`;
          return;
        }
        html += `<rect class="m-dd-ts-density-sel${toneClass}" data-dd-ts-sel-idx="${c.idx}" x="${c.barX.toFixed(1)}" y="${(plotBottom - h).toFixed(1)}" width="${c.barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
      });
      selEl.innerHTML = html;
    },

    _ddPatchTimestepCompSeries(compEl, coords, compYArr, toneClass, compComparableArr = null) {
      if (!compEl) return;
      const { solidD, dashedD } = this._ddBuildTimestepCompSeriesPaths(
        coords, compYArr, compComparableArr
      );
      const canDomPatch = typeof globalThis.document?.createElementNS === 'function'
        && typeof compEl.querySelector === 'function'
        && typeof compEl.appendChild === 'function';
      if (canDomPatch) {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        let solidEl = compEl.querySelector('[data-dd-ts-comp-solid]');
        let gapEl = compEl.querySelector('[data-dd-ts-comp-gap]');
        let dotsWrap = compEl.querySelector('[data-dd-ts-comp-dots]');
        if (!solidEl || !gapEl || !dotsWrap) {
          compEl.innerHTML = '';
          solidEl = globalThis.document.createElementNS(SVG_NS, 'path');
          solidEl.setAttribute('data-dd-ts-comp-line', '');
          solidEl.setAttribute('data-dd-ts-comp-solid', '');
          gapEl = globalThis.document.createElementNS(SVG_NS, 'path');
          gapEl.setAttribute('data-dd-ts-comp-line', '');
          gapEl.setAttribute('data-dd-ts-comp-gap', '');
          dotsWrap = globalThis.document.createElementNS(SVG_NS, 'g');
          dotsWrap.setAttribute('data-dd-ts-comp-dots', '');
          compEl.appendChild(solidEl);
          compEl.appendChild(gapEl);
          compEl.appendChild(dotsWrap);
        }
        solidEl.setAttribute('class', `m-dd-ts-comp-line${toneClass}`);
        if (solidD) {
          solidEl.setAttribute('d', solidD);
          solidEl.removeAttribute('display');
        } else {
          solidEl.setAttribute('d', '');
          solidEl.setAttribute('display', 'none');
        }
        gapEl.setAttribute('class', `m-dd-ts-comp-line is-gap${toneClass}`);
        if (dashedD) {
          gapEl.setAttribute('d', dashedD);
          gapEl.removeAttribute('display');
        } else {
          gapEl.setAttribute('d', '');
          gapEl.setAttribute('display', 'none');
        }

        const existingDots = Array.from(dotsWrap.querySelectorAll('[data-dd-ts-comp-dot]'));
        const byDotIdx = new Map();
        for (const dEl of existingDots) {
          const dk = dEl.dataset?.ddTsCompDot ?? dEl.getAttribute?.('data-dd-ts-comp-dot');
          if (dk != null && dk !== '') byDotIdx.set(String(dk), dEl);
        }
        coords.forEach((c, idx) => {
          const cy = compYArr[idx];
          const key = String(c.idx);
          let dEl = byDotIdx.get(key);
          if (cy != null) {
            if (!dEl) {
              dEl = globalThis.document.createElementNS(SVG_NS, 'circle');
              dEl.setAttribute('data-dd-ts-comp-dot', key);
              dotsWrap.appendChild(dEl);
            }
            dEl.setAttribute('class', `m-dd-ts-dot is-comp${toneClass}`);
            dEl.setAttribute('cx', c.xCenter.toFixed(1));
            dEl.setAttribute('cy', cy.toFixed(1));
            dEl.setAttribute('r', '1.6');
          } else if (dEl) {
            dEl.remove?.();
            if (dEl.parentNode === dotsWrap && typeof dotsWrap.removeChild === 'function') dotsWrap.removeChild(dEl);
          }
        });
        return;
      }

      const dotsHtml = coords.map((c, idx) => {
        const cy = compYArr[idx];
        return cy != null
          ? `<circle class="m-dd-ts-dot is-comp${toneClass}" data-dd-ts-comp-dot="${c.idx}" cx="${c.xCenter.toFixed(1)}" cy="${cy.toFixed(1)}" r="1.6"/>`
          : '';
      }).join('');
      compEl.innerHTML =
        `<path class="m-dd-ts-comp-line${toneClass}" data-dd-ts-comp-line data-dd-ts-comp-solid d="${solidD}"${solidD ? '' : ' display="none"'}/>`
        + `<path class="m-dd-ts-comp-line is-gap${toneClass}" data-dd-ts-comp-line data-dd-ts-comp-gap d="${dashedD}"${dashedD ? '' : ' display="none"'}/>`
        + `<g data-dd-ts-comp-dots>${dotsHtml}</g>`;
    },

    _ddPatchTimestepBaseScale(svg, baseEl, coords, curHigh, lossBottom, lossH) {
      const maxTickEl = svg.querySelector?.('[data-dd-ts-y-max]');
      if (maxTickEl) {
        const txt = this._ddFormatLoss(curHigh);
        if (maxTickEl.textContent !== txt) maxTickEl.textContent = txt;
      }
      const curToY = v => lossBottom - (Math.max(0, v) / Math.max(1e-6, curHigh)) * lossH;
      if (!baseEl) return curToY;

      const builtData = this._ddBuildTimestepBaseData(coords, curToY);
      const canDomPatch = typeof globalThis.document?.createElementNS === 'function'
        && typeof baseEl.querySelector === 'function'
        && typeof baseEl.appendChild === 'function';
      if (canDomPatch) {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const ensurePath = (attr, cls, d) => {
          let el = baseEl.querySelector(`[${attr}]`);
          if (d) {
            if (!el) {
              el = globalThis.document.createElementNS(SVG_NS, 'path');
              el.setAttribute(attr, '');
              baseEl.appendChild(el);
            }
            el.setAttribute('class', cls);
            el.setAttribute('d', d);
            el.removeAttribute('display');
          } else if (el) {
            el.setAttribute('display', 'none');
          }
        };
        ensurePath('data-dd-ts-iqr', 'm-dd-ts-iqr-band', builtData.iqrD);
        ensurePath('data-dd-ts-base-solid', 'm-dd-ts-base-line', builtData.basePaths.solidD);
        ensurePath('data-dd-ts-base-sparse', 'm-dd-ts-base-line is-sparse', builtData.basePaths.sparseD);
        ensurePath('data-dd-ts-base-gap', 'm-dd-ts-base-line is-gap', builtData.basePaths.gapD);

        const existingDots = new Map();
        for (const dEl of Array.from(baseEl.querySelectorAll('[data-dd-ts-base-dot]'))) {
          const k = dEl.getAttribute?.('data-dd-ts-base-dot');
          if (k != null) existingDots.set(k, dEl);
        }
        const activeDotKeys = new Set();
        for (const c of builtData.dotPts) {
          const key = String(c.idx);
          activeDotKeys.add(key);
          let dEl = existingDots.get(key);
          if (!dEl) {
            dEl = globalThis.document.createElementNS(SVG_NS, 'circle');
            dEl.setAttribute('data-dd-ts-base-dot', key);
            baseEl.appendChild(dEl);
          }
          dEl.setAttribute('class', `m-dd-ts-dot${c.comparable ? '' : ' is-sparse'}`);
          dEl.setAttribute('cx', c.xCenter.toFixed(1));
          dEl.setAttribute('cy', c.y.toFixed(1));
          dEl.setAttribute('r', c.comparable ? '1.5' : '1.6');
          dEl.removeAttribute('display');
        }
        for (const [k, dEl] of existingDots) {
          if (!activeDotKeys.has(k)) dEl.setAttribute('display', 'none');
        }
        return curToY;
      }

      const baseLayerHtml = this._ddBuildTimestepBaseMarkup(coords, curToY);
      if (baseEl.innerHTML !== baseLayerHtml) {
        baseEl.innerHTML = baseLayerHtml;
      }
      return curToY;
    },

    _ddStartTimestepMorphAnim(svg, prev, next, ctx) {
      if (!svg || !ctx) return;
      const {
        wrap, baseEl, compEl, selEl, coords,
        lossTop, lossBottom, lossH, plotBottom,
        compHtml,
        imageFinite, imageNonFinite, subsetMarkers, toX,
      } = ctx;

      const prevState = prev || {
        high: next.high,
        hasComparison: false,
        kind: 'none',
        toneClass: '',
        barH: coords.map(() => 0),
        compY: coords.map(() => null),
        compComparable: coords.map(() => false),
        compOpacity: 0,
        compHtml: '',
      };

      const arrDiff = (a, b) => {
        if (!a || !b || a.length !== b.length) return true;
        for (let i = 0; i < a.length; i++) {
          const av = a[i], bv = b[i];
          if ((av == null) !== (bv == null)) return true;
          if (av != null && Math.abs(av - bv) > 0.05) return true;
        }
        return false;
      };
      const profileChanged = prevState.profileKey !== next.profileKey;
      const changed = profileChanged || Math.abs(prevState.high - next.high) > 1e-6
        || prevState.hasComparison !== next.hasComparison
        || prevState.kind !== next.kind
        || prevState.toneClass !== next.toneClass
        || arrDiff(prevState.barH, next.barH)
        || arrDiff(prevState.compY, next.compY)
        || (prevState.compHtml || '') !== (next.compHtml || '');

      // Repeated snapshots of the same target must not restart a running transition.
      const target = svg._ddTsTarget;
      const sameTarget = target && target.profileKey === next.profileKey
        && target.high === next.high && target.hasComparison === next.hasComparison
        && target.kind === next.kind && target.toneClass === next.toneClass
        && target.compHtml === next.compHtml && !arrDiff(target.barH, next.barH);
      const motionOk = (!this._monitorMotionAllowed || this._monitorMotionAllowed())
        && typeof globalThis.requestAnimationFrame === 'function';
      if (svg._ddTsAnimRaf && sameTarget && motionOk) return;
      if (!changed && !svg._ddTsAnimRaf) {
        const focusCompEl = svg.querySelector?.('[data-dd-ts-focus-comp]');
        if (focusCompEl) focusCompEl.setAttribute('class', `m-dd-ts-focus-dot is-comp${next.toneClass}`);
        return;
      }

      this._ddStopTimestepMorphAnim(svg);
      svg._ddTsTarget = next;

      const focusCompEl = svg.querySelector?.('[data-dd-ts-focus-comp]');
      if (focusCompEl) focusCompEl.setAttribute('class', `m-dd-ts-focus-dot is-comp${next.toneClass}`);

      svg.classList?.toggle?.('is-ts-comparing', next.hasComparison);

      const paintMarkers = (toY, final) => {
        if (!compEl) return;
        if (compEl._ddMarkerLayout === next.markerLayout
            && this._ddPatchTimestepOverlayInPlace(compEl, next.kind, subsetMarkers, imageFinite, toX, toY, next.toneClass)) return;
        compEl.innerHTML = final ? compHtml : this._ddBuildTimestepOverlayMarkup(
          next.kind, subsetMarkers, imageFinite, imageNonFinite, toX, toY, lossTop, next.toneClass
        );
        compEl._ddMarkerLayout = next.markerLayout;
      };
      if (next.kind !== 'image' && next.kind !== 'subset' && compEl) compEl._ddMarkerLayout = null;

      const commitFinal = () => {
        svg._ddTsAnimRaf = 0;
        svg.classList?.remove?.('is-ts-animating');
        const toY = this._ddPatchTimestepBaseScale(svg, baseEl, coords, next.high, lossBottom, lossH);
        if (profileChanged) patchDensityProfile(svg, coords, plotBottom);
        if (compEl) {
          if (compEl.style) compEl.style.opacity = '';
          if (next.kind === 'series') {
            this._ddPatchTimestepCompSeries(compEl, coords, next.compY, next.toneClass, next.compComparable);
          } else if (next.kind === 'image' || next.kind === 'subset') {
            paintMarkers(toY, true);
          } else {
            if (compEl.innerHTML) compEl.innerHTML = '';
          }
        }
        if (selEl) {
          if (next.kind === 'series') {
            this._ddPatchTimestepDensitySel(selEl, coords, next.barH, plotBottom, next.toneClass, true);
          } else {
            this._ddPatchTimestepDensitySel(selEl, coords, coords.map(() => 0), plotBottom, '', true);
          }
        }
        svg._ddTsLiveState = next;
        this._ddSyncTimestepFocus(wrap, svg);
      };

      if (!motionOk) {
        commitFinal();
        return;
      }

      const durationMs = next.kind === 'none' ? 165 : 200;
      const highChanged = Math.abs(prevState.high - next.high) > 1e-6;
      const prevToY = v => lossBottom - (Math.max(0, v) / Math.max(1e-6, prevState.high)) * lossH;
      const nextToY = v => lossBottom - (Math.max(0, v) / Math.max(1e-6, next.high)) * lossH;
      let t0 = null;

      if (compEl && (next.kind === 'image' || next.kind === 'subset')) {
        paintMarkers(prevToY, !highChanged);
      }
      svg.classList?.add?.('is-ts-animating');

      const step = now => {
        if (t0 === null) t0 = now;
        const rawT = Math.min(1, Math.max(0, (now - t0) / durationMs));
        if (rawT >= 1 || this._monitorMotionAllowed?.() === false) {
          commitFinal();
          return;
        }
        const e = 1 - Math.pow(1 - rawT, 3);
        const curHigh = prevState.high + (next.high - prevState.high) * e;
        const frameCoords = profileChanged && prevState.coords ? interpolateProfile(prevState.coords, coords, e) : coords;
        if (profileChanged) patchDensityProfile(svg, frameCoords, plotBottom);
        const curToY = highChanged || profileChanged
          ? this._ddPatchTimestepBaseScale(svg, baseEl, frameCoords, curHigh, lossBottom, lossH)
          : (v => lossBottom - (Math.max(0, v) / Math.max(1e-6, curHigh)) * lossH);
        const curBarH = coords.map((_, i) => (prevState.barH[i] || 0) + ((next.barH[i] || 0) - (prevState.barH[i] || 0)) * e);
        const barTone = next.kind === 'series' ? next.toneClass : prevState.toneClass;
        this._ddPatchTimestepDensitySel(selEl, coords, curBarH, plotBottom, barTone, false);

        let liveKind = next.kind;
        let liveTone = next.kind === 'series' ? next.toneClass : prevState.toneClass;
        let curCompY = coords.map(() => null);
        let curComparable = coords.map(() => false);
        let curOp = next.kind === 'none' ? 0 : 1;

        if (next.kind === 'series') {
          const fromOp = prevState.kind === 'series' ? (prevState.compOpacity ?? 1) : (prevState.compOpacity || 0);
          curOp = prevState.kind === 'series' ? Math.max(fromOp, Math.min(1, fromOp + rawT * 2)) : Math.min(1, rawT * 2.4);
          curComparable = next.compComparable;
          curCompY = coords.map((c, idx) => {
            const ny = next.compY[idx];
            if (ny == null) return null;
            const py = prevState.compY[idx];
            const startY = py != null ? py : (c.valid ? prevToY(c.mean_loss) : ny);
            return startY + (ny - startY) * e;
          });
          this._ddPatchTimestepCompSeries(compEl, coords, curCompY, next.toneClass, curComparable);
          if (compEl?.style) compEl.style.opacity = curOp.toFixed(3);
        } else if (prevState.kind === 'series' && next.kind === 'none') {
          liveKind = 'series';
          liveTone = prevState.toneClass;
          curComparable = prevState.compComparable;
          const startOp = prevState.compOpacity ?? 1;
          curOp = Math.max(0, startOp * (1 - rawT * 1.15));
          curCompY = coords.map((c, idx) => {
            const py = prevState.compY[idx];
            if (py == null) return null;
            const endY = c.valid ? nextToY(c.mean_loss) : py;
            return py + (endY - py) * e;
          });
          this._ddPatchTimestepCompSeries(compEl, coords, curCompY, prevState.toneClass, curComparable);
          if (compEl?.style) compEl.style.opacity = curOp.toFixed(3);
        } else if (next.kind === 'image' || next.kind === 'subset') {
          curOp = prevState.kind === next.kind ? (prevState.compOpacity + (1 - prevState.compOpacity) * e) : Math.min(1, rawT * 2.4);
          if (highChanged) paintMarkers(curToY, false);
          if (compEl?.style) compEl.style.opacity = curOp.toFixed(3);
        } else if (prevState.kind !== 'none' && next.kind === 'none') {
          liveKind = prevState.kind;
          const startOp = prevState.compOpacity ?? 1;
          curOp = Math.max(0, startOp * (1 - rawT * 1.25));
          if (compEl && highChanged) {
            this._ddPatchTimestepOverlayInPlace(compEl, prevState.kind, subsetMarkers, imageFinite, toX, curToY, prevState.toneClass);
          }
          if (compEl?.style) compEl.style.opacity = curOp.toFixed(3);
        } else if (compEl) {
          if (compEl.innerHTML) compEl.innerHTML = '';
        }

        svg._ddTsLiveState = {
          coords: frameCoords,
          profileKey: profileChanged ? null : next.profileKey,
          high: curHigh,
          hasComparison: next.hasComparison,
          kind: liveKind,
          toneClass: liveTone,
          barH: curBarH,
          compY: curCompY,
          compComparable: curComparable,
          compOpacity: curOp,
          compHtml: next.compHtml,
        };
        this._ddSyncTimestepFocus(wrap, svg);

        svg._ddTsAnimRaf = globalThis.requestAnimationFrame(step);
      };

      svg._ddTsAnimRaf = globalThis.requestAnimationFrame(step);
    },

    _renderDatasetDiagTimestepSvg(wrap, svg, data, width, t, options = {}) {
      const comp = options._resolvedComp !== undefined ? options._resolvedComp : this._ddResolveActiveNoiseComparison(data);
      const measuredH = Math.round(options.stageHeight || wrap?.querySelector?.('[data-dd-hero-stage]')?.clientHeight || 0);
      const height = measuredH > 90 ? measuredH : 176;
      const padL = 48, padR = 10, padT = 10, padB = 19;
      const plotW = Math.max(120, width - padL - padR);
      const plotBottom = height - padB;
      const plotH = Math.max(88, plotBottom - padT);
      const densityH = Math.max(30, Math.round(plotH * 0.27));
      const lossTop = padT;
      const lossBottom = plotBottom - densityH - 2;
      const lossH = Math.max(44, lossBottom - lossTop);

      const rawBins = this._ddResolveNoiseProfileBins(data, 18);
      if (!rawBins.length) {
        this._ddStopTimestepMorphAnim(svg);
        svg._ddTsLiveState = null;
        this._ddPatchNoiseCardChrome(wrap, t, data, comp, !!options.animate, false);
        const wasEmpty = svg.getAttribute?.('data-dd-svg-kind') === 'timestep-empty';
        svg.setAttribute('data-dd-svg-kind', 'timestep-empty');
        svg.removeAttribute?.('data-dd-svg-width');
        svg.removeAttribute?.('data-dd-svg-height');
        svg.removeAttribute?.('data-dd-svg-zoom');
        svg.removeAttribute?.('data-dd-ts-sig');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        const empty = `<text class="is-sans" x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--text-tertiary)" font-size="12">${this.esc(t('ddTimestepOverlayEmpty'))}</text>`;
        if (!wasEmpty || svg._ddTsEmpty !== empty) svg.innerHTML = empty;
        svg._ddTsEmpty = empty;
        wrap._ddChartState = null;
        return;
      }

      const excluded = this._ddNoiseExcludedBounds(data.sampling_config);
      svg._ddTsEmpty = null;
      const scale = data.timestep_scale || 'thousand';
      const totalImages = Number(data.summary?.images_total || 0) || null;
      const prepared = this._ddPrepareTimestepBins(rawBins, comp?.series || null, excluded);
      const bins = prepared.bins;
      const totalCount = prepared.totalCount;
      const theoShares = this._ddComputeTheoreticalBinShares(data, bins, excluded);
      const hasComparison = Boolean(comp);
      const hasTheoData = Boolean(theoShares && theoShares.some(v => v > 0));
      const hasTheo = Boolean(!hasComparison && hasTheoData);
      const compZones = this._ddComputeComparisonZones(data, comp);
      this._ddPatchNoiseCardChrome(wrap, t, data, comp, !!options.animate, hasTheo, compZones);

      const baseVals = [];
      for (const b of bins) {
        if (b.count > 0 && b.mean_loss != null) {
          baseVals.push(b.mean_loss);
          if (b.p75 != null) baseVals.push(b.p75);
        }
      }
      const compVals = [];
      for (const b of bins) {
        if (b.compCount > 0 && b.compLoss != null) compVals.push(b.compLoss);
      }
      const imageFinite = [];
      const imageNonFinite = [];
      if (comp?.kind === 'image' && comp.detail) {
        for (const s of (comp.detail.samples || [])) {
          const t1000 = this._ddToTimestep1000(s.timestep, scale);
          if (t1000 == null) continue;
          if (s.non_finite || s.loss == null) {
            imageNonFinite.push({ ...s, t1000 });
          } else {
            const lossVal = Number(s.loss);
            if (Number.isFinite(lossVal)) {
              compVals.push(lossVal);
              imageFinite.push({ ...s, t1000, loss: lossVal });
            }
          }
        }
      }
      const subsetMarkers = [];
      if (comp?.kind === 'subset' && compZones) {
        for (const [zKey, tCenter] of [['high', 1000 * 5 / 6], ['mid', 500], ['low', 1000 / 6]]) {
          const baseZ = data.noise_zones?.[zKey];
          const cz = compZones[zKey];
          if (baseZ?.mean_loss != null && cz?.mean_residual != null) {
            const estLoss = Math.max(0, Number(baseZ.mean_loss) * (1 + Number(cz.mean_residual)));
            compVals.push(estLoss);
            subsetMarkers.push({ zone: zKey, t1000: tCenter, loss: estLoss, residual: cz.mean_residual, count: cz.count });
          }
        }
      }

      const baseMax = baseVals.length ? Math.max(...baseVals) : 1;
      const baseHigh = Math.max(baseMax * 1.15, 1e-4);
      const compMax = compVals.length ? Math.max(...compVals) : 0;
      const high = compMax > baseHigh * 0.98 ? Math.max(compMax * 1.10, baseHigh) : baseHigh;
      const toX = t1000 => padL + ((1000 - t1000) / 1000) * plotW;
      const toY = v => lossBottom - (Math.max(0, v) / high) * lossH;

      const shareList = bins.map((b, i) => {
        const share = totalCount > 0 ? b.count / totalCount : 0;
        const theoShare = theoShares ? theoShares[i] : null;
        return { share, theoShare };
      });
      const maxShare = Math.max(1e-6, ...shareList.map(s => Math.max(s.share, (hasTheoData && s.theoShare != null) ? s.theoShare : 0)));
      const toDensityY = s => plotBottom - (Math.max(0, s) / maxShare) * densityH;

      const coords = bins.map((b, idx) => {
        const xLeft = toX(b.tTo);
        const xRight = toX(b.tFrom);
        const colW = Math.max(2, xRight - xLeft);
        const xCenter = (xLeft + xRight) / 2;
        const barW = Math.max(2, colW - 1.8);
        const barX = xCenter - barW / 2;
        const tMid = (b.tFrom + b.tTo) / 2;
        const zone = tMid >= 2000 / 3 ? 'high' : (tMid >= 1000 / 3 ? 'mid' : 'low');
        const valid = b.count > 0 && b.mean_loss != null;
        const y = valid ? toY(b.mean_loss) : null;
        const yP25 = (valid && b.p25 != null) ? toY(b.p25) : null;
        const yP75 = (valid && b.p75 != null) ? toY(b.p75) : null;
        const compY = b.compLoss != null ? toY(b.compLoss) : null;
        const shareInfo = shareList[idx];
        const yTheo = (!b.excluded && theoShares && theoShares[idx] != null) ? toDensityY(theoShares[idx]) : null;
        return {
          ...b,
          idx,
          zone,
          xLeft,
          xRight,
          colW,
          xCenter,
          barW,
          barX,
          valid,
          y,
          yP25,
          yP75,
          compY,
          share: shareInfo.share,
          densityHeight: b.count ? Math.max(2, shareInfo.share / maxShare * densityH) : 0,
          theoShare: shareInfo.theoShare,
          yTheo,
        };
      });

      const hasCompSeries = Boolean(comp?.series && coords.some(c => c.compCount > 0));
      const toneClass = this._ddNoiseToneClass(comp?.tone);
      const overlayKind = hasCompSeries
        ? 'series'
        : (subsetMarkers.length ? 'subset' : (comp?.kind === 'image' && comp.detail ? 'image' : 'none'));

      const compYArr = coords.map(c => (hasCompSeries && !c.excluded ? c.compY : null));
      const compComparableArr = coords.map(c => Boolean(hasCompSeries && !c.excluded && c.compCount > 0));
      const targetBarHArr = coords.map(c => {
        if (!hasCompSeries || !(c.compCount > 0)) return 0;
        const compShare = totalCount > 0 ? c.compCount / totalCount : 0;
        return Math.max(2, (compShare / maxShare) * densityH);
      });

      let compHtml = '';
      if (hasCompSeries) {
        const { solidD, dashedD } = this._ddBuildTimestepCompSeriesPaths(
          coords, compYArr, compComparableArr
        );
        const dotsHtml = coords.filter(c => !c.excluded && c.compY != null).map(c =>
          `<circle class="m-dd-ts-dot is-comp${toneClass}" data-dd-ts-comp-dot="${c.idx}" cx="${c.xCenter.toFixed(1)}" cy="${c.compY.toFixed(1)}" r="1.6"/>`
        ).join('');
        compHtml =
          `<path class="m-dd-ts-comp-line${toneClass}" data-dd-ts-comp-line data-dd-ts-comp-solid d="${solidD}"${solidD ? '' : ' display="none"'}/>`
          + `<path class="m-dd-ts-comp-line is-gap${toneClass}" data-dd-ts-comp-line data-dd-ts-comp-gap d="${dashedD}"${dashedD ? '' : ' display="none"'}/>`
          + `<g data-dd-ts-comp-dots>${dotsHtml}</g>`;
      } else if (overlayKind === 'subset' || overlayKind === 'image') {
        compHtml = this._ddBuildTimestepOverlayMarkup(
          overlayKind, subsetMarkers, imageFinite, imageNonFinite, toX, toY, lossTop, toneClass
        );
      }

      const densitySelHtml = hasCompSeries
        ? coords.map((c, idx) => {
          const ch = targetBarHArr[idx];
          if (!(ch > 0)) return '';
          return `<rect class="m-dd-ts-density-sel${toneClass}" data-dd-ts-sel-idx="${c.idx}" x="${c.barX.toFixed(1)}" y="${(plotBottom - ch).toFixed(1)}" width="${c.barW.toFixed(1)}" height="${ch.toFixed(1)}" rx="1"/>`;
        }).join('')
        : '';

      const nextState = {
        coords,
        markerLayout: overlayKind === 'image'
          ? JSON.stringify([overlayKind, imageFinite.map(s => [s.t1000, s.residual]), imageNonFinite.map(s => s.t1000)])
          : overlayKind === 'subset' ? JSON.stringify([overlayKind, toneClass, subsetMarkers.map(m => m.zone)]) : null,
        profileKey: coords.map(c => [c.mean_loss, c.p25, c.p75, c.densityHeight, c.yTheo, c.comparable, c.non_finite_count].join(':')).join('|'),
        high,
        hasComparison,
        kind: overlayKind,
        toneClass,
        barH: targetBarHArr,
        compY: compYArr,
        compComparable: compComparableArr,
        compOpacity: overlayKind === 'none' ? 0 : 1,
        compHtml,
      };

      const tsStructSig = [
        excluded.hasMax ? excluded.maxT : '',
        excluded.hasMin ? excluded.minT : '',
        this.selectedRunDir || this.liveTaskId || '', data.run_id || '',
        bins.map(b => `${b.bin}:${b.tFrom}:${b.tTo}`).join(','),
      ].join('|');

      const canPatchOverlay = svg.getAttribute?.('data-dd-svg-kind') === 'timestep'
        && Number(svg.getAttribute?.('data-dd-svg-width') || 0) === width
        && Number(svg.getAttribute?.('data-dd-svg-height') || 0) === height
        && svg.getAttribute?.('data-dd-ts-sig') === tsStructSig
        && typeof svg.querySelector === 'function'
        && !!svg.querySelector('[data-dd-ts-comp]')
        && !!svg.querySelector('[data-dd-ts-base]')
        && !!svg.querySelector('[data-dd-ts-density-theo]')
        && !!svg.querySelector('[data-dd-ts-density-sel]');

      if (canPatchOverlay) {
        const baseEl = svg.querySelector('[data-dd-ts-base]');
        const compEl = svg.querySelector('[data-dd-ts-comp]');
        const selEl = svg.querySelector('[data-dd-ts-density-sel]');
        this._ddStartTimestepMorphAnim(svg, svg._ddTsLiveState, nextState, {
          baseEl,
          wrap,
          compEl,
          selEl,
          coords,
          lossTop,
          lossBottom,
          lossH,
          plotBottom,
          compHtml,
          imageFinite,
          imageNonFinite,
          subsetMarkers,
          toX,
        });
      } else {
        this._ddStopTimestepMorphAnim(svg);
        svg.classList?.toggle?.('is-ts-comparing', hasComparison);
        const baseLayerHtml = this._ddBuildTimestepBaseMarkup(coords, toY);
        const densityBarsHtml = coords.map(c => {
          const h = c.densityHeight;
          const cls = 'm-dd-ts-density-bar' + (!c.comparable ? ' is-sparse' : '');
          return `<rect class="${cls}" data-dd-ts-idx="${c.idx}" x="${c.barX.toFixed(1)}" y="${(plotBottom - h).toFixed(1)}" width="${c.barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
        }).join('');

        const nanMarksHtml = coords.map(c => {
          const cx = c.xCenter;
          const cy = lossTop + 6;
          return `<g class="m-dd-ts-nan-mark" data-dd-ts-idx="${c.idx}"${c.non_finite_count > 0 ? '' : ' display="none"'}>`
            + `<line x1="${(cx - 2.8).toFixed(1)}" y1="${(cy - 2.8).toFixed(1)}" x2="${(cx + 2.8).toFixed(1)}" y2="${(cy + 2.8).toFixed(1)}"/>`
            + `<line x1="${(cx + 2.8).toFixed(1)}" y1="${(cy - 2.8).toFixed(1)}" x2="${(cx - 2.8).toFixed(1)}" y2="${(cy + 2.8).toFixed(1)}"/>`
            + `</g>`;
        }).join('');

        const xDiv667 = toX(2000 / 3);
        const xDiv333 = toX(1000 / 3);
        const exclPatId = 'm-dd-excl-' + (this.selectedRunDir ? 'h' : 'l');
        let excludedHtml = '';
        if (excluded.hasMax) {
          const xBound = toX(excluded.maxT);
          const w = Math.max(0, xBound - padL);
          if (w > 1) {
            excludedHtml += `<rect class="m-dd-ts-excluded" x="${padL}" y="${lossTop}" width="${w.toFixed(1)}" height="${plotH.toFixed(1)}" fill="url(#${exclPatId})"/>`
              + `<line class="m-dd-ts-excluded-line" x1="${xBound.toFixed(1)}" x2="${xBound.toFixed(1)}" y1="${lossTop}" y2="${plotBottom}"/>`;
          }
        }
        if (excluded.hasMin) {
          const xBound = toX(excluded.minT);
          const w = Math.max(0, (padL + plotW) - xBound);
          if (w > 1) {
            excludedHtml += `<rect class="m-dd-ts-excluded" x="${xBound.toFixed(1)}" y="${lossTop}" width="${w.toFixed(1)}" height="${plotH.toFixed(1)}" fill="url(#${exclPatId})"/>`
              + `<line class="m-dd-ts-excluded-line" x1="${xBound.toFixed(1)}" x2="${xBound.toFixed(1)}" y1="${lossTop}" y2="${plotBottom}"/>`;
          }
        }

        const hitRectsHtml = `<rect class="m-dd-ts-hit" data-dd-ts-hit x="${padL}" y="${lossTop}" width="${plotW.toFixed(1)}" height="${plotH.toFixed(1)}"/>`;

        const ticksHtml = [
          [1000, 'start', padL],
          [667, 'middle', xDiv667],
          [333, 'middle', xDiv333],
          [0, 'end', padL + plotW],
        ].map(([label, anchor, x]) => `<text x="${x.toFixed(1)}" y="${height - 4}" text-anchor="${anchor}">${label}</text>`).join('');

        const axesHtml = `
          <text data-dd-ts-y-max x="${padL - 6}" y="${lossTop + 4}" text-anchor="end">${this._ddFormatLoss(high)}</text>
          <text x="${padL - 6}" y="${(lossBottom + 2).toFixed(1)}" text-anchor="end">0</text>
          ${ticksHtml}`;

        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', String(height));
        svg.setAttribute('data-dd-svg-kind', 'timestep');
        svg.setAttribute('data-dd-svg-width', String(width));
        svg.setAttribute('data-dd-svg-height', String(height));
        svg.setAttribute('data-dd-svg-zoom', '');
        svg.setAttribute('data-dd-ts-sig', tsStructSig);
        svg._ddTsLiveState = nextState;
        svg._ddTsTarget = nextState;
        svg.innerHTML = `
          <defs>
            <pattern id="${exclPatId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--bg-sunken)" fill-opacity="0.34"/>
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-tertiary)" stroke-opacity="0.28" stroke-width="1.5"/>
            </pattern>
          </defs>
          ${excludedHtml ? `<g class="m-dd-ts-excluded-group">${excludedHtml}</g>` : ''}
          <g class="m-chart-grid">
            <line x1="${padL}" x2="${padL + plotW}" y1="${lossTop}" y2="${lossTop}"/>
            <line x1="${padL}" x2="${padL + plotW}" y1="${(lossTop + lossH / 2).toFixed(1)}" y2="${(lossTop + lossH / 2).toFixed(1)}"/>
            <line x1="${padL}" x2="${padL + plotW}" y1="${plotBottom}" y2="${plotBottom}" class="is-axis"/>
          </g>
          <g data-dd-ts-density><g data-dd-ts-density-base>${densityBarsHtml}</g><g data-dd-ts-density-sel>${densitySelHtml}</g><g data-dd-ts-density-theo><path class="m-dd-ts-theo-line" d="${theoreticalPath(coords)}"/></g></g>
          <g data-dd-ts-base>${baseLayerHtml}</g>
          <g data-dd-ts-comp>${compHtml}</g>
          <g data-dd-ts-nan>${nanMarksHtml}</g>
          <line class="m-dd-ts-crosshair" data-dd-ts-crosshair x1="0" x2="0" y1="${lossTop}" y2="${plotBottom}" display="none"/>
          <circle class="m-dd-ts-focus-dot" data-dd-ts-focus-base r="3.4" display="none"/>
          <circle class="m-dd-ts-focus-dot is-comp${toneClass}" data-dd-ts-focus-comp r="3.6" display="none"/>
          <g data-dd-ts-hits>${hitRectsHtml}</g>
          <g class="m-chart-axes">${axesHtml}</g>`;
        const initCompEl = typeof svg.querySelector === 'function' ? svg.querySelector('[data-dd-ts-comp]') : null;
        if (initCompEl) initCompEl._ddMarkerLayout = nextState.markerLayout;
      }

      wrap._ddChartState = {
        kind: 'timestep',
        width,
        height,
        padL,
        padR,
        padT: lossTop,
        plotW,
        plotH,
        lossTop,
        lossBottom,
        densityBottom: plotBottom,
        coords,
        scale,
        comp,
        hasCompSeries,
        imageFinite,
        imageNonFinite,
        hasTheo,
        excluded,
        totalCount,
        totalImages,
      };
      this._refreshDatasetDiagActiveHover?.(wrap);
    },

    _ddRenderTimestepTooltip(wrap, bestBar, hoverMeta = null) {
      const tipEl = wrap?.querySelector?.('[data-dd-ts-tooltip]');
      const st = wrap?._ddChartState;
      const stage = wrap?.querySelector?.('[data-dd-hero-stage]');
      if (!tipEl || !st || !bestBar) return;
      const t = k => this.tMonitor(k);
      const hiStr = String(Math.round(bestBar.tTo));
      const loStr = String(Math.round(bestBar.tFrom));
      const zoneLabel = bestBar.zone === 'high'
        ? t('ddZoneHighShort')
        : (bestBar.zone === 'mid' ? t('ddZoneMidShort') : t('ddZoneLowShort'));
      const zoneRole = bestBar.zone === 'high'
        ? t('ddZoneHighRole')
        : (bestBar.zone === 'mid' ? t('ddZoneMidRole') : t('ddZoneLowRole'));

      let html = `<div class="m-dd-tt-head"><strong>t = ${this.esc(hiStr)}–${this.esc(loStr)}</strong>`
        + `<span class="m-dd-tt-zone"><span class="m-dd-tt-zone-name">${this.esc(zoneLabel)}</span>`
        + `<span class="m-dd-tt-zone-role">${this.esc(zoneRole)}</span></span></div>`;

      const isExcl = Boolean(hoverMeta?.excludedHover || bestBar.excluded);
      if (isExcl) {
        const isMax = st.excluded?.hasMax && bestBar.tFrom >= st.excluded.maxT - 1e-6;
        const isMin = st.excluded?.hasMin && bestBar.tTo <= st.excluded.minT + 1e-6;
        const emptyMsg = isMax
          ? t('ddNoiseTooltipExcludedMax').replace('{max}', String(Math.round(st.excluded.maxT)))
          : (isMin
            ? t('ddNoiseTooltipExcludedMin').replace('{min}', String(Math.round(st.excluded.minT)))
            : t('ddNoiseTooltipExcluded'));
        html += `<div class="m-dd-tt-meta">${this.esc(emptyMsg)}</div>`;
      } else if (bestBar.count > 0 || bestBar.non_finite_count > 0) {
        let lossSection = '';
        if (bestBar.count > 0) {
          const trendTxt = bestBar.trend != null ? this._ddFormatTrendExact(bestBar.trend) : '';
          const trendCls = bestBar.trend != null ? this._ddTrendToneClass(bestBar.trend) : '';
          lossSection += `<div class="m-dd-tt-row"><em>${this.esc(t('ddNoiseTooltipMeanLoss'))}</em>`
            + `<span class="m-dd-tt-v-group"><strong class="m-dd-tt-v-main">${this.esc(this._ddFormatLoss(bestBar.mean_loss))}</strong>`
            + (trendTxt ? `<span class="m-dd-tt-v-sub${trendCls ? ' ' + trendCls : ''}">${this.esc(trendTxt)}</span>` : '')
            + `</span></div>`;
        }
        if (st.hasCompSeries && bestBar.compCount > 0 && bestBar.compLoss != null) {
          const rel = bestBar.mean_loss > 0 ? (bestBar.compLoss / bestBar.mean_loss - 1) : null;
          const relStr = rel != null ? this._ddFormatResidual(rel) : '';
          const relCol = rel != null ? this._ddResidualColor(rel, { scale: st.comp?.kind === 'group' ? 'group' : 'image' }) : '';
          lossSection += `<div class="m-dd-tt-row"><em>${this.esc(t('ddNoiseTooltipSelected'))}</em>`
            + `<span class="m-dd-tt-v-group"><strong class="m-dd-tt-v-main"${relCol ? ` style="color:${this.esc(relCol)}"` : ''}>${this.esc(this._ddFormatLoss(bestBar.compLoss))}</strong>`
            + (relStr ? `<span class="m-dd-tt-v-sub"${relCol ? ` style="color:${this.esc(relCol)}"` : ''}>${this.esc(relStr)}</span>` : '')
            + `</span></div>`;
        } else if (st.comp?.kind === 'image' && st.comp.detail) {
          const inBin = st.imageFinite.filter(s => s.t1000 >= bestBar.tFrom && (s.t1000 < bestBar.tTo || (bestBar.tTo >= 999.9 && s.t1000 <= 1000)));
          const nfInBin = st.imageNonFinite.filter(s => s.t1000 >= bestBar.tFrom && (s.t1000 < bestBar.tTo || (bestBar.tTo >= 999.9 && s.t1000 <= 1000)));
          if (inBin.length) {
            const avgL = inBin.reduce((a, s) => a + s.loss, 0) / inBin.length;
            const avgR = bestBar.mean_loss > 0 ? (avgL / bestBar.mean_loss - 1) : null;
            const rStr = avgR != null ? this._ddFormatResidual(avgR) : '';
            const rCol = avgR != null ? this._ddResidualColor(avgR) : '';
            lossSection += `<div class="m-dd-tt-row"><em>${this.esc(t('ddLegThisImage'))}</em>`
              + `<span class="m-dd-tt-v-group"><strong class="m-dd-tt-v-main"${rCol ? ` style="color:${this.esc(rCol)}"` : ''}>${this.esc(this._ddFormatLoss(avgL))}</strong>`
              + (rStr ? `<span class="m-dd-tt-v-sub"${rCol ? ` style="color:${this.esc(rCol)}"` : ''}>${this.esc(rStr)}</span>` : '')
              + `</span></div>`;
          } else if (nfInBin.length) {
            lossSection += `<div class="m-dd-tt-row"><em>${this.esc(t('ddLegThisImage'))}</em>`
              + `<span class="m-dd-tt-v-group"><strong class="m-dd-tt-v-main" style="color:var(--diag-tone-danger, var(--danger))">${this.esc(t('ddStatusNonFinite'))}</strong></span></div>`;
          }
        }
        if (bestBar.p25 != null && bestBar.p75 != null) {
          lossSection += `<div class="m-dd-tt-row"><em>${this.esc(t('ddLegP2575'))}</em>`
            + `<span class="m-dd-tt-v-group"><span class="m-dd-tt-v-sub is-val">${this.esc(this._ddFormatLossRangeNum(bestBar.p25) + ' – ' + this._ddFormatLossRangeNum(bestBar.p75))}</span></span></div>`;
        }

        let sampSection = '';
        if (bestBar.count > 0) {
          const sharePct = st.totalCount > 0 ? ((bestBar.count / st.totalCount) * 100).toFixed(1) + '%' : '';
          sampSection += `<div class="m-dd-tt-row"><em>${this.esc(t('ddNoiseTooltipActual'))}</em>`
            + `<span class="m-dd-tt-v-group"><strong class="m-dd-tt-v-main">${this.esc(t('ddZoneCountShort').replace('{n}', bestBar.count))}</strong>`
            + (sharePct ? `<span class="m-dd-tt-v-sub">${this.esc(sharePct)}</span>` : '')
            + `</span></div>`;
        }
        if (st.hasTheo && bestBar.theoShare != null) {
          const actShare = st.totalCount > 0 ? bestBar.count / st.totalCount : 0;
          const diffPct = (actShare - bestBar.theoShare) * 100;
          const diffStr = (diffPct >= 0.05 ? '+' : '') + diffPct.toFixed(1) + '%';
          sampSection += `<div class="m-dd-tt-row"><em>${this.esc(t('ddNoiseTooltipExpected'))}</em>`
            + `<span class="m-dd-tt-v-group"><span class="m-dd-tt-v-sub is-val">${this.esc((bestBar.theoShare * 100).toFixed(1) + '%')}</span>`
            + `<span class="m-dd-tt-v-sub">${this.esc(diffStr)}</span></span></div>`;
        }
        if (bestBar.non_finite_count > 0) {
          sampSection += `<div class="m-dd-tt-row"><em style="color:var(--diag-tone-danger, var(--danger))">${this.esc(t('ddStatusNonFinite'))}</em>`
            + `<span class="m-dd-tt-v-group"><strong class="m-dd-tt-v-main" style="color:var(--diag-tone-danger, var(--danger))">${this.esc(t('ddZoneCountShort').replace('{n}', bestBar.non_finite_count))}</strong></span></div>`;
        }

        if (lossSection) html += `<div class="m-dd-tt-section">${lossSection}</div>`;
        if (lossSection && sampSection) html += `<div class="m-dd-tt-sep"></div>`;
        if (sampSection) html += `<div class="m-dd-tt-section">${sampSection}</div>`;

        let footLeft = '';
        if (!bestBar.comparable && bestBar.count > 0) {
          footLeft = `<span class="is-warn">${this.esc(t('ddNoiseTooltipSparse'))}</span>`;
        }
        let footRight = '';
        if (bestBar.images != null && bestBar.images > 0) {
          const covTmpl = st.totalImages > 0
            ? t('ddNoiseTooltipCoverageOf')
            : (Number(bestBar.images) === 1 ? t('ddNoiseTooltipCoverageOne') : t('ddNoiseTooltipCoverage'));
          const covTxt = st.totalImages > 0
            ? covTmpl.replace('{n}', bestBar.images).replace('{total}', st.totalImages)
            : covTmpl.replace('{n}', bestBar.images);
          footRight = `<span>${this.esc(covTxt)}</span>`;
        }
        if (footLeft || footRight) {
          html += `<div class="m-dd-tt-foot">${footLeft || '<span></span>'}${footRight}</div>`;
        }
      } else {
        html += `<div class="m-dd-tt-meta">${this.esc(t('ddNoiseTooltipUnmeasured'))}</div>`;
      }

      const wasHidden = !!tipEl.hidden;
      tipEl.classList?.toggle?.('is-moving', !wasHidden);
      this._ddPatchHtml(tipEl, html);
      tipEl.hidden = false;
      const stageW = stage?.clientWidth || st.width || 360;
      const stageH = stage?.clientHeight || st.height || 176;
      const scaleX = st.width > 0 ? (stageW / st.width) : 1;
      const anchorX = (hoverMeta?.focusX ?? bestBar.xCenter) * scaleX;
      const tipW = tipEl.offsetWidth || 176;
      const tipH = tipEl.offsetHeight || 84;
      const placeLeft = anchorX > stageW * 0.54;
      const rawLeft = placeLeft ? (anchorX - tipW - 10) : (anchorX + 10);
      const left = Math.max(4, Math.min(Math.max(4, stageW - tipW - 4), rawLeft));
      const top = Math.max(4, Math.min(Math.max(4, stageH - tipH - 4), 6));
      tipEl.style.left = Math.round(left) + 'px';
      tipEl.style.top = Math.round(top) + 'px';
    },

    _ddApplyTimestepBinHover(wrap, bestBar, hoverMeta = null) {
      const svg = wrap?.querySelector?.('[data-dd-hero-svg]');
      const st = wrap?._ddChartState;
      if (!svg || !st || !bestBar) return;
      const excludedHover = Boolean(hoverMeta?.excludedHover || bestBar.excluded);
      const focusX = excludedHover ? (hoverMeta?.focusX ?? bestBar.xCenter) : bestBar.xCenter;
      wrap._ddActiveBar = bestBar;
      wrap._ddHoverMeta = { excludedHover, focusX };
      wrap.classList.add('is-hovering');
      svg.querySelectorAll('.m-dd-ts-density-bar.is-hovered').forEach(el => el.classList.remove('is-hovered'));
      if (!excludedHover && (bestBar.count > 0 || bestBar.non_finite_count > 0)) {
        svg.querySelector(`.m-dd-ts-density-bar[data-dd-ts-idx="${bestBar.idx}"]`)?.classList.add('is-hovered');
      }
      wrap.querySelectorAll('[data-dd-zone-col]').forEach(el => {
        el.classList.toggle('is-zone-hover', el.dataset.ddZoneCol === bestBar.zone);
      });

      const ch = svg.querySelector('[data-dd-ts-crosshair]');
      if (ch) {
        const wasHidden = ch.getAttribute?.('display') === 'none' || ch.attrs?.display === 'none';
        if (ch.style) {
          ch.classList?.toggle?.('is-moving', !wasHidden);
          ch.style.transform = `translateX(${focusX.toFixed(1)}px)`;
          ch.setAttribute('x1', '0');
          ch.setAttribute('x2', '0');
        } else {
          ch.setAttribute('x1', focusX.toFixed(1));
          ch.setAttribute('x2', focusX.toFixed(1));
        }
        ch.removeAttribute('display');
      }
      this._ddSyncTimestepFocus(wrap, svg);
      this._ddRenderTimestepTooltip(wrap, bestBar, wrap._ddHoverMeta);
    },

    _ddSyncTimestepFocus(wrap, svg) {
      const bar = wrap?._ddActiveBar;
      const chart = wrap?._ddChartState;
      const frame = svg._ddTsLiveState;
      if (!bar || !chart || !frame) return;
      const c = frame.coords?.[bar.idx];
      const baseY = c?.valid ? chart.lossBottom - Math.max(0, c.mean_loss) / frame.high * (chart.lossBottom - chart.lossTop) : null;
      const compY = frame.kind === 'series' ? frame.compY[bar.idx] : null;
      for (const [layer, y] of [['base', baseY], ['comp', compY]]) {
        const dot = svg.querySelector(`[data-dd-ts-focus-${layer}]`);
        if (!dot) continue;
        if (wrap._ddHoverMeta?.excludedHover || y == null) {
          dot.setAttribute('display', 'none');
        } else {
          dot.setAttribute('cx', bar.xCenter.toFixed(1));
          dot.setAttribute('cy', y.toFixed(1));
          dot.removeAttribute('display');
        }
      }
    },
  };
})();
