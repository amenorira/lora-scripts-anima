/* Subset timestep editing and interactive distribution preview.
 * Composed into trainingCoreMixin with property descriptors intact.
 */
window.trainingTimestepPreview = {
  timestepPreviewOpen: false,
  timestepPreviewData: null,
  timestepPreviewScope: 'base',
  subsetTimestepOffsetDrafts: {},
  timestepOffsetSupported() {
    return ['anima-lora', 'moss-image-lora'].includes(this.form.model_train_type)
      && (['sigmoid', 'shift', 'flux_shift', 'truncated_logit_normal'].includes(String(this.form.timestep_sampling || ''))
        || (this.form.timestep_sampling === 'sigma' && this.form.weighting_scheme === 'logit_normal'));
  },

  timestepOffsetSubsets() {
    if (!['anima-lora', 'moss-image-lora'].includes(this.form.model_train_type)) return [];
    return ((this.stepEstimate && this.stepEstimate.subsets) || []).filter(subset => !subset.is_reg);
  },

  subsetTimestepOffsetValue(name) {
    const offsets = this.form.subset_timestep_offsets;
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return '';
    return Object.prototype.hasOwnProperty.call(offsets, name) ? offsets[name] : '';
  },

  subsetTimestepOffsetInputValue(name) {
    if (Object.prototype.hasOwnProperty.call(this.subsetTimestepOffsetDrafts || {}, name)) {
      return this.subsetTimestepOffsetDrafts[name];
    }
    const value = this.subsetTimestepOffsetValue(name);
    return value === '' ? '' : String(value);
  },

  setSubsetTimestepOffsetDraft(name, rawValue) {
    if (this.datasetRepeatApplying) return;
    const raw = String(rawValue ?? '');
    this.subsetTimestepOffsetDrafts = { ...(this.subsetTimestepOffsetDrafts || {}), [name]: raw };
    // Keep intermediate keyboard states such as "-", "." and "0." visible.
    if (/^[-+]?\d*\.?\d+$/.test(raw)) this.setSubsetTimestepOffset(name, raw);
  },

  commitSubsetTimestepOffsetDraft(name) {
    if (this.datasetRepeatApplying) return;
    const drafts = this.subsetTimestepOffsetDrafts || {};
    if (!Object.prototype.hasOwnProperty.call(drafts, name)) return;
    const raw = String(drafts[name] ?? '').trim();
    if (raw === '' || /^[-+]?\d*\.?\d+$/.test(raw)) {
      this.setSubsetTimestepOffset(name, raw);
    }
    const nextDrafts = { ...drafts };
    delete nextDrafts[name];
    this.subsetTimestepOffsetDrafts = nextDrafts;
  },

  _reconcileSubsetTimestepOffsets() {
    if (!this.form || !['anima-lora', 'moss-image-lora'].includes(this.form.model_train_type)) return;
    const validNames = new Set(this.timestepOffsetSubsets().map(subset => subset.name));
    const current = this.form.subset_timestep_offsets;
    const clean = {};
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      Object.entries(current).forEach(([name, value]) => {
        const offset = Number(value);
        if (validNames.has(name) && Number.isFinite(offset) && offset !== 0) clean[name] = offset;
      });
    }
    if (JSON.stringify(clean) !== JSON.stringify(current || {})) this.form.subset_timestep_offsets = clean;
  },

  setSubsetTimestepOffset(name, rawValue) {
    if (this.datasetRepeatApplying) return;
    const previous = this.form.subset_timestep_offsets || {};
    const next = { ...(this.form.subset_timestep_offsets || {}) };
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      delete next[name];
    } else {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value === 0) delete next[name];
      else next[name] = value;
    }
    this.form.subset_timestep_offsets = next;
    this._setFieldSource('subset_timestep_offsets', 'user');
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.pushHistory({ ...this.form, subset_timestep_offsets: { ...next } });
      if (typeof this.queueTomlPreviewChange === 'function') this.queueTomlPreviewChange('subset_timestep_offsets');
      if (typeof this.updateToml === 'function') this.updateToml();
    }
    if (this.timestepPreviewOpen) this.refreshTimestepPreview();
  },

  stepSubsetTimestepOffset(name, delta) {
    if (this.datasetRepeatApplying) return;
    const current = Number(this.subsetTimestepOffsetValue(name) || 0);
    const nextDrafts = { ...(this.subsetTimestepOffsetDrafts || {}) };
    delete nextDrafts[name];
    this.subsetTimestepOffsetDrafts = nextDrafts;
    this.setSubsetTimestepOffset(name, Math.round((current + delta) * 100) / 100);
  },

  _subsetTimestepOffsetFromSnapshot(snapshot, name) {
    const offsets = snapshot && snapshot.subset_timestep_offsets;
    if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return '';
    return Object.prototype.hasOwnProperty.call(offsets, name) ? offsets[name] : '';
  },

  undoSubsetTimestepOffset(name) {
    if (this.datasetRepeatApplying) return;
    const drafts = { ...(this.subsetTimestepOffsetDrafts || {}) };
    delete drafts[name];
    this.subsetTimestepOffsetDrafts = drafts;
    const current = this.subsetTimestepOffsetValue(name);
    for (let i = this.formHistoryIdx - 1; i >= 0; i -= 1) {
      const previous = this._subsetTimestepOffsetFromSnapshot(this.formHistory[i], name);
      if (String(previous) !== String(current)) {
        const next = { ...(this.form.subset_timestep_offsets || {}) };
        if (previous === '' || previous === null || previous === undefined || Number(previous) === 0) delete next[name];
        else next[name] = Number(previous);
        this.form.subset_timestep_offsets = next;
        this.formHistoryIdx = i;
        this._setFieldSource('subset_timestep_offsets', 'user');
        this._persistProfileFieldSources();
        if (typeof this.updateToml === 'function') this.updateToml();
        return;
      }
    }
    this.resetSubsetTimestepOffset(name);
  },

  resetSubsetTimestepOffset(name) {
    if (this.datasetRepeatApplying) return;
    const drafts = { ...(this.subsetTimestepOffsetDrafts || {}) };
    delete drafts[name];
    this.subsetTimestepOffsetDrafts = drafts;
    this.setSubsetTimestepOffset(name, '');
    this._setFieldSource('subset_timestep_offsets', 'default');
    this._persistProfileFieldSources();
  },

  renderSubsetTimestepOffsets() {
    if (!['anima-lora', 'moss-image-lora'].includes(this.form.model_train_type)) return '';
    const supported = this.timestepOffsetSupported();
    const subsets = this.timestepOffsetSubsets();
    const disabled = ' :disabled="!timestepOffsetSupported() || datasetRepeatApplying"';
    const rows = subsets.map(subset => {
      const name = String(subset.name || '');
      const nameExpr = this.escapeAttr(JSON.stringify(name));
      const sampleText = this.t('timestepOffset.sampleFormat')
        .replace('{images}', String(subset.image_count || 0))
        .replace('{repeats}', String(subset.repeats || 0));
      return `<div class="subset-timestep-row">
        <span class="subset-timestep-name" title="${this.escapeAttr(name)}">${this.esc(name)}</span>
        <span class="subset-timestep-meta">${this.esc(sampleText)}</span>
        <div class="stepper subset-timestep-stepper">
          <button type="button" @click="stepSubsetTimestepOffset(${nameExpr}, -0.05)"${disabled}>−</button>
          <input type="text" inputmode="decimal" autocomplete="off" placeholder="0" :value="subsetTimestepOffsetInputValue(${nameExpr})" @input="setSubsetTimestepOffsetDraft(${nameExpr}, $event.target.value)" @blur="commitSubsetTimestepOffsetDraft(${nameExpr})"${disabled}>
          <button type="button" @click="stepSubsetTimestepOffset(${nameExpr}, 0.05)"${disabled}>+</button>
        </div>
        <button type="button" class="btn-icon" @click="openTimestepPreview(${nameExpr})"${disabled} title="${this.escapeAttr(this.t('timestepOffset.previewSubset'))}" aria-label="${this.escapeAttr(this.t('timestepOffset.previewSubset'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
        </button>
        <div class="field-menu-wrap subset-timestep-menu" x-data="actionMenu" x-id="['field-menu']" @keydown="key($event)" @click.outside="close(false)" @pointerenter="hoverEnter($event)" @pointerleave="hoverLeave()" @focusout="focusOut($event)">
          <button type="button" class="btn-menu" x-ref="trigger" :aria-label="t('common.fieldActions')" title="${this.escapeAttr(this.t('common.fieldActions'))}" aria-haspopup="menu" :aria-expanded="open" :aria-controls="$id('field-menu')" @click="toggle()"${disabled}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          <div class="field-menu-popup" x-ref="menu" x-show="open" :class="{ 'is-positioned': positioned }" :inert="!open" :id="$id('field-menu')" role="menu" :aria-label="t('common.fieldActions')" x-cloak>
            <button type="button" role="menuitem" tabindex="-1" @click="undoSubsetTimestepOffset(${nameExpr});close()"${disabled}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span>${this.esc(this.t('common.undoField'))}</span></button>
            <button type="button" role="menuitem" tabindex="-1" @click="resetSubsetTimestepOffset(${nameExpr});close()"${disabled}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg><span>${this.esc(this.t('common.resetField'))}</span></button>
          </div>
        </div>
      </div>`;
    }).join('');
    const body = rows || `<div class="subset-timestep-empty field-hint">${this.esc(this.t('timestepOffset.empty'))}</div>`;
    const previewDisabled = subsets.length ? '' : ' disabled';
    return `<div class="subset-timestep-editor${supported ? '' : ' is-disabled'}" :class="{ 'is-disabled': !timestepOffsetSupported() }">
      <div class="subset-timestep-header">
        <div>
          <div class="subset-timestep-title">
            <span>${this.esc(this.t('timestepOffset.title'))}</span>
            <button type="button" class="field-doc-link" @click.stop="openParameterDoc('timesteps','subset-offsets')" title="${this.escapeAttr(this.t('docs.openGuide'))}" aria-label="${this.escapeAttr(this.t('docs.openGuide'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              <span>${this.esc(this.t('docs.openGuide'))}</span>
            </button>
          </div>
          <div class="field-hint">${this.esc(this.t('timestepOffset.hint'))}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="openTimestepPreview('overall')"${previewDisabled}${disabled}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/></svg>
          <span>${this.esc(this.t('timestepOffset.preview'))}</span>
        </button>
      </div>
      ${rows ? `<div class="subset-timestep-list"><div class="subset-timestep-row subset-timestep-row--head"><span>${this.esc(this.t('timestepOffset.subset'))}</span><span>${this.esc(this.t('timestepOffset.samples'))}</span><span>${this.esc(this.t('timestepOffset.offset'))}</span><span></span></div>${body}</div>` : body}
      <div class="field-hint subset-timestep-footnote">${this.esc(this.t('timestepOffset.rangeWarning'))}</div>
    </div>`;
  },

  _refreshSubsetTimestepEditor() {
    const current = document.querySelector('.subset-timestep-editor');
    if (!current || !current.parentNode) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = this.renderSubsetTimestepOffsets();
    const next = wrapper.firstElementChild;
    if (!next) return;
    const alpine = window.Alpine;
    if (alpine && typeof alpine.mutateDom === 'function' && typeof alpine.destroyTree === 'function' && typeof alpine.initTree === 'function') {
      alpine.mutateDom(() => {
        alpine.destroyTree(current);
        current.replaceWith(next);
        alpine.initTree(next);
      });
    } else {
      current.replaceWith(next);
    }
  },

  timestepPreviewOptions() {
    const options = [{ value: 'base', label: this.t('timestepPreview.baseDistribution') }];
    const subsets = this.timestepOffsetSubsets();
    if (subsets.length) options.push({ value: 'overall', label: this.t('timestepPreview.overallDistribution') });
    subsets.forEach(subset => {
      const raw = this.subsetTimestepOffsetValue(subset.name);
      const suffix = raw === '' ? '0' : `${Number(raw) > 0 ? '+' : ''}${raw}`;
      options.push({ value: subset.name, label: `${subset.name} (${suffix})` });
    });
    return options;
  },

  setTimestepPreviewScope(scope) {
    this.timestepPreviewScope = scope;
    this.refreshTimestepPreview();
  },

  _buildTimestepPreview(values, requestedScope) {
    const source = values || this.form || {};
    const { noteKeys, scopeLabelKey, ...preview } = window.TrainingTimestepPreview.build(
      { ...source, resolution: source.resolution || this.form?.resolution },
      {
        scope: requestedScope || this.timestepPreviewScope || 'base',
        subsets: this.timestepOffsetSubsets(),
        allSubsets: this.stepEstimate?.subsets || [],
        subsetOffsets: this.form.subset_timestep_offsets,
      },
    );
    return {
      ...preview,
      scopeLabel: scopeLabelKey ? this.t(scopeLabelKey) : preview.scopeLabel,
      samplingLabel: this._fieldOptionLabel('timestep_sampling', preview.sampling, preview.sampling),
      weightingLabel: preview.weighting === 'uniform' ? this.t('timestepPreview.uniformWeighting')
        : this._fieldOptionLabel('weighting_scheme', preview.weighting, preview.weighting),
      notes: noteKeys.map(key => this.t(key)),
    };
  },

  // Render the training modal chart via x-html.
  _buildTimestepChartHtml(data) {
    if (!data) return '';
    const esc = value => String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const t = (key, fallback) => {
      const translated = typeof this.t === 'function' ? this.t(key) : '';
      return esc(translated || fallback);
    };
    const fmtPercent = (base, current, compare) => compare
      ? `${base.toFixed(1)}% → ${current.toFixed(1)}%`
      : `${current.toFixed(1)}%`;

    const yticks = (data.yTicks || []).map(tick =>
      `<span class="timestep-ytick-label" style="bottom:${(100 - parseFloat(tick.y)).toFixed(1)}%">${esc(tick.label)}</span>`
    ).join('');
    const gridH = (data.yTicks || []).map(tick =>
      `<line x1="0" y1="${esc(tick.y)}" x2="100" y2="${esc(tick.y)}" class="timestep-grid-h" />`
    ).join('');

    const baselineCurve = data.compare && data.baselineLinePath
      ? `<path class="timestep-curve-baseline" d="${esc(data.baselineLinePath)}"></path>` : '';
    const weightLine = data.weighting !== 'uniform'
      ? `<polyline class="timestep-curve-weight" points="${esc(data.weightPoints)}"></polyline>` : '';
    const baselineLegend = data.compare
      ? `<span><i class="legend-baseline"></i><span>${t('timestepPreview.baseline', 'Base distribution')}</span></span>` : '';
    const weightLegend = data.weighting !== 'uniform'
      ? `<span><i class="legend-weight"></i><span>${t('timestepPreview.lossWeight', 'Loss weight (log scale)')}</span></span>` : '';

    return `
    <div class="timestep-chart-box">
      <div class="timestep-inspect-bar">
        <span class="timestep-inspect-title">${data.fixedTimestep != null ? t('timestepPreview.fixedDistribution', 'Fixed timestep (100%)') : t('timestepPreview.relativeDensity', 'Relative PDF')}</span>
        <span class="timestep-inspect-value" aria-live="polite">
          <b class="ts-hover-t"></b><small>·</small><span class="ts-hover-density"></span>
        </span>
      </div>
      <div class="timestep-chart-yaxis">
        <div class="timestep-yaxis-ticks">${yticks}</div>
      </div>
      <div class="timestep-preview-chart" aria-hidden="true">
        <svg class="timestep-grid-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          ${gridH}
          <line x1="25" y1="0" x2="25" y2="100" class="timestep-grid-v" />
          <line x1="50" y1="0" x2="50" y2="100" class="timestep-grid-v" />
          <line x1="75" y1="0" x2="75" y2="100" class="timestep-grid-v" />
        </svg>
        <div class="timestep-preview-zones">
          <div class="zone-col"><span>${t('timestepPreview.structureZone', 'High noise')}</span></div>
          <div class="zone-col"><span>${t('timestepPreview.middleZone', 'Mid noise')}</span></div>
          <div class="zone-col"><span>${t('timestepPreview.detailZone', 'Low noise')}</span></div>
        </div>
        <svg class="timestep-preview-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          ${baselineCurve}
          <path class="timestep-curve-area" d="${esc(data.currentAreaPath)}"></path>
          <path class="timestep-curve-current" d="${esc(data.currentLinePath)}"></path>
          ${weightLine}
        </svg>
        <div class="timestep-median-line" style="left: ${esc(data.medianPercent)}%">
          <span class="timestep-median-tag">${t(data.fixedTimestep != null ? 'timestepPreview.fixedLabel' : 'timestepPreview.medianLabel', 't = {value}').replace('{value}', esc(data.median))}</span>
        </div>
        <div class="timestep-hover-indicator" style="display:none"></div>
      </div>
    </div>
    <div class="timestep-preview-axis">
      <span class="axis-left">1000</span>
      <div class="axis-mid-ticks"><span>750</span><span>500</span><span>250</span></div>
      <span class="axis-right">0</span>
    </div>
    <div class="timestep-preview-legend">
      ${baselineLegend}
      <span><i class="legend-distribution"></i><span>${t('timestepPreview.currentDistribution', 'Current distribution')}</span></span>
      ${weightLegend}
    </div>
    <div class="timestep-preview-summary">
      <div><b>${esc(fmtPercent(data.baselineHighPercent, data.highPercent, data.compare))}</b><span>${t('timestepPreview.structureZone', 'High noise')}</span></div>
      <div><b>${esc(fmtPercent(data.baselineMidPercent, data.midPercent, data.compare))}</b><span>${t('timestepPreview.middleZone', 'Mid noise')}</span></div>
      <div><b>${esc(fmtPercent(data.baselineLowPercent, data.lowPercent, data.compare))}</b><span>${t('timestepPreview.detailZone', 'Low noise')}</span></div>
    </div>`;
  },

  onTimestepChartHover(event) {
    if (!event || !event.currentTarget) return;
    const holder = event.currentTarget;
    const chart = holder.querySelector ? holder.querySelector('.timestep-preview-chart') : null;
    if (!chart) return;
    const rect = chart.getBoundingClientRect();
    if (!rect.width) return;
    if (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom) {
      this.onTimestepChartLeave(event);
      return;
    }
    const relX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    holder.dataset.inspectProgress = relX;
    const data = this.timestepPreviewData;
    if (!data) return;
    if (data.fixedTimestep != null) return;
    const densities = data.densities || [];
    const idx = Math.min(densities.length - 1, Math.floor(relX * densities.length));
    const density = densities.length ? (densities[idx] || 0) : 0;

    const hoverLine = chart.querySelector('.timestep-hover-indicator');
    if (hoverLine) {
      hoverLine.style.left = `${(relX * 100).toFixed(2)}%`;
      hoverLine.style.display = 'block';
    }
    const tEl = holder.querySelector('.ts-hover-t');
    const dEl = holder.querySelector('.ts-hover-density');
    const valueBox = holder.querySelector('.timestep-inspect-value');
    const translate = (key, fallback, value) => {
      const raw = typeof this.t === 'function' ? this.t(key) : '';
      return String(raw || fallback).replace('{value}', String(value));
    };
    if (tEl) tEl.textContent = translate('timestepPreview.timestepValue', 't = {value}', Math.round((1 - relX) * 1000));
    if (dEl) dEl.textContent = translate('timestepPreview.densityValue', 'Probability density: {value}', density.toFixed(5));
    if (valueBox) valueBox.classList.add('is-visible');
  },

  onTimestepChartLeave(event) {
    if (event && event.currentTarget && event.currentTarget.querySelector) {
      const holder = event.currentTarget;
      const hoverLine = holder.querySelector('.timestep-hover-indicator');
      if (hoverLine) hoverLine.style.display = 'none';
      const valueBox = holder.querySelector('.timestep-inspect-value');
      if (valueBox) valueBox.classList.remove('is-visible');
    }
  },

  openTimestepPreview(scope) {
    const available = new Set(this.timestepPreviewOptions().map(option => option.value));
    this.timestepPreviewScope = available.has(scope) ? scope : (available.has(this.timestepPreviewScope) ? this.timestepPreviewScope : 'base');
    this.timestepPreviewData = this._buildTimestepPreview(null, this.timestepPreviewScope);
    this._openManagedModal('timestepPreviewOpen');
  },

  closeTimestepPreview() {
    this._closeManagedModal('timestepPreviewOpen');
  },

  refreshTimestepPreview() {
    this.timestepPreviewData = this._buildTimestepPreview(null, this.timestepPreviewScope);
  },
};
