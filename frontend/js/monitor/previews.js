/* 样本筛选、刷新与媒体队列；由 monitor-core.js 装配，沿用同一份监控状态。 */
window.monitorPreviewsMixin = {
  sampleBatchId: '', sampleBatchSortDir: 'desc',
  sampleLossMode: 'off', _sampleLossCache: null, _sampleSortCache: null,
  sampleSidebarVisible: true, sampleSidebarOpen: true, _sampleSidebarInspecting: false,
  sampleSidebarView: {key: '', scale: 1, x: 0, y: 0},
  previewViewTimelineVisible: true,
  previewViewTimelineAvailable: false,
  previewComparisonLayout: 'horizontal',
  sampleExpandedBatchId: '', _sampleExpansionPausedFollow: false,
  _sampleExpansionUI: null, _sampleExpansionPointer: null, _sampleExpansionAction: 0, _sampleExpansionDismissTimer: null,
  _sampleGridPointer: null, _sampleGridLastAction: null,
  previewCompareActive: false, previewComparisonWaiting: false,
  previewReferences: [], _previewReferenceEntries: [],
  previewComparisonOrder: [], _previewPaneDrag: null,
  _sampleModelCache: null,
  _sampleResetScroll: false, _sampleScrollAnchor: null, _sampleOverviewAtEnd: true,
  _sampleLayoutAction: 0,
  previewLightboxOpen: false, previewInfoOpen: false, _previewClosePending: false,
  previewPageEditing: false, previewPageDraft: '', _previewPageLastDraft: '',
  previewTimelineMenu: null, _previewTimelineMenuToken: 0, _previewTimelineMenuCleanup: null,
  previewHasNew: false,
  previewRefreshFeedback: false, _previewRefreshFeedbackTimer: null,
  previewViewScale: 1,
  _previewViewFitScale: 1, _previewViewFitted: true, _previewGroupGeometry: null, _previewViewportLayout: null,
  previewViewPanning: false, previewViewPointerId: null,
  _previewPanStartX: 0, _previewPanStartY: 0, _previewPanRatio: 1,
  _previewPanWrite: null,
  _previewSideNavFrame: null, _previewSideNavPress: null,
  previewImageLoading: false, previewImageError: false,
  _previewImageKey: '', _previewImageRequest: 0,
  _previewOriginalCache: null,
  _previewMediaByUrl: null,
  _previewMediaRetryNeeded: false,

  get sampleSidebarActive() {
    return this.sampleSidebarVisible && this.sampleSidebarOpen && !!this.previews?.[this.previewStep];
  },

  get sampleSidebarMediaActive() {
    return this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'samples' && this.sampleSidebarActive;
  },

  _previewPromptIdentity(preview) {
    if (preview?.sample?.prompt_id) {
      const sample = preview.sample;
      return { key: sample.prompt_id, prefix: '', number: Number(sample.prompt_index ?? 0) + 1,
        seed: sample.seed == null ? null : String(sample.seed),
        stage: sample.stage_kind + ':' + sample.stage_value };
    }
    // Only the trainer's complete filename convention is eligible. Custom names
    // remain browsable, but cannot accidentally become members of a prompt group.
    const match = String(preview?.name || '').match(/^(.*?)(e?)(\d{6})_(\d{2})_(\d{14})(?:_(-?\d+))?\.(?:png|jpe?g|webp)$/i);
    if (!match || (match[1] && !match[1].endsWith('_'))) return null;
    return { key: match[1] + ':' + match[4], prefix: match[1], number: Number(match[4]) + 1, seed: match[6] ?? null,
      stage: (match[2] ? 'epoch:' : 'step:') + Number(match[3]) };
  },

  _previewItemKey(preview) {
    return String(preview?.path || preview?.url || preview?.name || '');
  },

  resetSampleBrowser() {
    this._sampleLayoutAction++;
    this._cancelPreviewReset?.();
    this.stopPreviewPan?.();
    if (this._previewSideNavFrame != null) cancelAnimationFrame(this._previewSideNavFrame);
    this._previewSideNavFrame = null; this._previewSideNavPress = null;
    this.cancelPreviewPromptBarDrag?.();
    this.closePreviewTimelineMenu?.(false);
    this.previewInfoOpen = false;
    this.previewPageEditing = false; this.previewPageDraft = ''; this._previewPageLastDraft = '';
    this._clearPreviewImageLoading?.(true);
    this._disconnectSampleExpansionUI?.();
    this._sampleExpansionAction = (this._sampleExpansionAction || 0) + 1;
    this._cancelPreviewRailDrag?.('_previewViewTimeline');
    this._sampleOverviewJumpId = '';
    this.sampleBatchId = ''; this.sampleBatchSortDir = 'desc';
    this.sampleExpandedBatchId = ''; this._sampleExpansionPausedFollow = false;
    this._cancelSampleGridMotion?.(this._sampleOverviewPanel?.()?.querySelector('.m-sample-batches'));
    this._clearPreviewComparison();
    this.previewHasNew = false;
    this._sampleModelCache = null;
    this._sampleLossCache = null;
    this._sampleSortCache = null;
    this._sampleResetScroll = true; this._sampleScrollAnchor = null;
    this._sampleOverviewAtEnd = true;
    this.sampleSidebarOpen = true;
    this._sampleSidebarInspecting = false;
    this.sampleSidebarView = {key: '', scale: 1, x: 0, y: 0};
    this._loadSampleViewPreferences();
  },

  _loadSampleViewPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem('anima-sample-view') || '{}');
      if (typeof saved?.sidebar === 'boolean') this.sampleSidebarVisible = saved.sidebar;
      if (typeof saved?.viewerTimeline === 'boolean') this.previewViewTimelineVisible = saved.viewerTimeline;
      if (['asc', 'desc', 'loss-overall', 'loss-high', 'loss-mid', 'loss-low'].includes(saved?.sort)) this.sampleBatchSortDir = saved.sort;
      if (saved?.comparisonLayout === 'horizontal' || saved?.comparisonLayout === 'vertical') this.previewComparisonLayout = saved.comparisonLayout;
      if (['off', 'overall', 'detailed'].includes(saved?.lossMode)) this.sampleLossMode = saved.lossMode;
    } catch { /* Keep the current layout if storage is unavailable. */ }
  },

  _saveSampleViewPreferences() {
    try {
      localStorage.setItem('anima-sample-view', JSON.stringify({sidebar: this.sampleSidebarVisible,
        viewerTimeline: this.previewViewTimelineVisible, sort: this.sampleBatchSortDir, comparisonLayout: this.previewComparisonLayout,
        lossMode: this.sampleLossMode}));
    } catch { /* The controls remain usable without storage. */ }
  },

  _sampleEpochLossIndex() {
    const series = this.monitorLossSeries || (this.selectedRunDir ? this.runDetailData?.tensorboard_loss : this.lossSeries) || [];
    const run = this.selectedRunDir || this.currentOutputRunDir || '';
    const sources = [];
    for (const item of series) {
      if (!['loss/epoch', 'loss/epoch_average', 'loss/timestep/epoch/low', 'loss/timestep/epoch/mid', 'loss/timestep/epoch/high'].includes(item.tag)) continue;
      const points = item.points, last = points?.at(-1);
      sources.push({tag: item.tag, points, length: points?.length || 0, lastStep: last?.step, lastValue: last?.value});
    }
    const cached = this._sampleLossCache;
    // Production metric updates and snapshots replace points. Length and the
    // last point also cover in-place appends without scanning historical values.
    if (cached?.run === run && cached.sources.length === sources.length && sources.every((source, index) => {
      const previous = cached.sources[index];
      return source.tag === previous.tag && source.points === previous.points && source.length === previous.length
        && source.lastStep === previous.lastStep && source.lastValue === previous.lastValue;
    })) return cached.byTag;
    const byTag = new Map();
    for (const source of sources) {
      const points = new Map();
      for (const point of source.points || []) {
        if (Number.isInteger(point.step) && point.step > 0 && Number.isFinite(point.value)) points.set(point.step, point.value);
      }
      byTag.set(source.tag, points);
    }
    this._sampleLossCache = {run, sources, byTag};
    return this._sampleLossCache.byTag;
  },

  get sampleDetailedLossAvailable() {
    const data = this.selectedRunDir ? this.runDetailData : this.monitorData;
    if (typeof data?.log_timestep_loss === 'boolean') return data.log_timestep_loss;
    // Existing/imported runs have no saved switch; recorded partition scalars
    // establish that logging was enabled without consulting the current form.
    const series = this.monitorLossSeries || (this.selectedRunDir ? this.runDetailData?.tensorboard_loss : this.lossSeries) || [];
    return series.some(item => ['loss/timestep/epoch/low', 'loss/timestep/epoch/mid', 'loss/timestep/epoch/high'].includes(item.tag));
  },

  get sampleEffectiveLossMode() {
    return this.sampleLossMode === 'detailed' && !this.sampleDetailedLossAvailable ? 'overall' : this.sampleLossMode;
  },

  setSampleLossMode(mode) {
    if (!['off', 'overall', 'detailed'].includes(mode) || (mode === 'detailed' && !this.sampleDetailedLossAvailable) || mode === this.sampleLossMode) return;
    this.sampleLossMode = mode;
    this._saveSampleViewPreferences();
    this.renderDashboard();
  },

  _sampleBatchEpochLoss(batch) {
    const sample = batch && this._sampleRecord(this.previews[batch.indices[0]]);
    // A mid-epoch step sample must never acquire the later epoch-end loss.
    // Unknown/custom names likewise cannot borrow the latest training value.
    const epoch = sample?.stage_kind === 'epoch' ? sample.epoch ?? sample.stage_value : null;
    const index = this._sampleEpochLossIndex();
    const at = number => ({
      overall: index.get('loss/epoch')?.get(number) ?? index.get('loss/epoch_average')?.get(number) ?? null,
      low: index.get('loss/timestep/epoch/low')?.get(number) ?? null,
      mid: index.get('loss/timestep/epoch/mid')?.get(number) ?? null,
      high: index.get('loss/timestep/epoch/high')?.get(number) ?? null,
    });
    const known = Number.isInteger(epoch) && epoch > 0;
    return {epoch: known ? epoch : null, values: at(known ? epoch : null), previous: at(known ? epoch - 1 : null)};
  },

  _sampleLossNumber(value, compact = false) {
    if (!Number.isFinite(value)) return '—';
    if ((value !== 0 && Math.abs(value) < (compact ? 0.001 : 0.0001)) || Math.abs(value) >= 100) return value.toExponential(1);
    const result = value.toFixed(compact ? 3 : 4);
    return compact ? result.replace(/^(-?)0\./, '$1.') : result;
  },

  _sampleLossChange(value, previous) {
    if (!Number.isFinite(value) || !Number.isFinite(previous) || previous === 0) return '—';
    const change = (value - previous) / Math.abs(previous) * 100;
    if (!Number.isFinite(change)) return '—';
    return (change > 0 ? '+' : '') + change.toFixed(1) + '%';
  },

  _sampleRecord(preview, index = 0) {
    if (preview?.sample?.batch_id) return preview.sample;
    const identity = this._previewPromptIdentity(preview);
    const info = this._sampleMetadata(preview?.name);
    const [stageKind, stageValue] = info.stage.split(':');
    // Historical custom images remain inspectable without inventing an identity.
    return { batch_id: identity ? 'legacy:' + identity.prefix + ':' + identity.stage : 'file:' + this._previewItemKey(preview),
      // Keep cached stage labels language-independent, as recorded samples do.
      batch_label: info.stage ? (stageKind === 'epoch' ? 'Epoch ' : 'Step ') + stageValue : preview?.name || '', batch_order: index,
      stage_kind: stageKind || 'unknown', stage_value: info.stage ? Number(stageValue) : null,
      epoch: stageKind === 'epoch' ? Number(stageValue) : null, step: stageKind === 'step' ? Number(stageValue) : null,
      prompt_id: identity?.key || 'file:' + this._previewItemKey(preview),
      prompt_label: info.prompt || preview?.name || '', prompt_index: identity ? identity.number - 1 : null,
      seed: identity?.seed ?? null, params: {}, comparable: false, condition_key: null,
      metadata_source: identity ? 'filename' : 'unknown', batch_status: 'unknown' };
  },

  _sampleDataModel(items = this.previews) {
    if (this._sampleModelCache?.items === items && this._sampleModelCache.version === this.previewsVersion) return this._sampleModelCache;
    const groups = new Map();
    const records = items.map((preview, index) => {
      const sample = this._sampleRecord(preview, index);
      let batch = groups.get(sample.batch_id);
      if (!batch) {
        const epoch = Number.isInteger(sample.epoch) && sample.epoch > 0 ? sample.epoch : null;
        const step = Number.isInteger(sample.step) && sample.step >= 0 ? sample.step : null;
        const label = epoch !== null && step !== null ? 'Epoch ' + epoch + ' · Step ' + step : sample.batch_label || preview.name;
        batch = { id: sample.batch_id, label,
          indices: [], expected: null, status: sample.batch_status || 'unknown' };
        groups.set(batch.id, batch);
      }
      batch.indices.push(index);
      if (Number.isInteger(sample.batch_expected) && sample.batch_expected > 0) batch.expected = Math.max(batch.expected || 0, sample.batch_expected);
      if (sample.batch_status === 'running') batch.status = 'running';
      else if (sample.batch_status === 'failed' && batch.status !== 'running') batch.status = 'failed';
      return { index, preview, sample, batch };
    });
    // Map insertion order already follows the API's generation order for both
    // recorded and legacy samples, independent of their batch_order units.
    const batches = [...groups.values()];
    const labelCounts = new Map(), labelOrdinals = new Map();
    batches.forEach(batch => labelCounts.set(batch.label, (labelCounts.get(batch.label) || 0) + 1));
    batches.forEach(batch => {
      if (labelCounts.get(batch.label) > 1) {
        const original = batch.label, ordinal = (labelOrdinals.get(original) || 0) + 1;
        labelOrdinals.set(original, ordinal); batch.label += ' (' + ordinal + ')';
      }
    });
    batches.forEach((batch, position) => { batch.position = position; });
    const model = { items, version: this.previewsVersion, records, batches, byBatch: groups };
    if (items === this.previews) this._sampleModelCache = model;
    return model;
  },

  _sampleSelectedBatch() {
    const model = this._sampleDataModel();
    return model.byBatch.get(this.sampleBatchId) || model.batches[model.batches.length - 1] || null;
  },

  get sampleEffectiveBatchSort() {
    const sort = this.sampleBatchSortDir || 'desc';
    return ['loss-high', 'loss-mid', 'loss-low'].includes(sort) && !this.sampleDetailedLossAvailable ? 'loss-overall' : sort;
  },

  get sampleLossSortKey() {
    const sort = this.sampleEffectiveBatchSort;
    return sort.startsWith('loss-') ? sort.slice(5) : '';
  },

  _sampleBatchOrder(items = this.previews) {
    // Presentation ranking never changes canonical chronology or comparison baselines.
    const model = this._sampleDataModel(items), sort = this.sampleEffectiveBatchSort, key = this.sampleLossSortKey;
    const lossIndex = key ? this._sampleEpochLossIndex() : null, cached = this._sampleSortCache;
    if (cached?.model === model && cached.sort === sort && cached.requested === this.sampleBatchSortDir && cached.lossIndex === lossIndex) return cached;
    const batches = [...model.batches];
    if (key) {
      const values = new Map(batches.map(batch => {
        const sample = model.records[batch.indices[0]].sample;
        const epoch = sample.stage_kind === 'epoch' ? sample.epoch ?? sample.stage_value : null;
        const value = Number.isInteger(epoch) && epoch > 0 ? key === 'overall'
          ? lossIndex.get('loss/epoch')?.get(epoch) ?? lossIndex.get('loss/epoch_average')?.get(epoch)
          : lossIndex.get('loss/timestep/epoch/' + key)?.get(epoch) : null;
        return [batch.id, Number.isFinite(value) ? value : Infinity];
      }));
      batches.sort((a, b) => values.get(a.id) !== values.get(b.id) ? values.get(a.id) - values.get(b.id) : b.position - a.position);
    } else if (sort !== 'asc') batches.reverse();
    const order = {model, sort, requested: this.sampleBatchSortDir, lossIndex, batches, positions: new Map(batches.map((batch, index) => [batch.id, index]))};
    if (items === this.previews) this._sampleSortCache = order;
    return order;
  },

  _sampleOverviewBatches(items = this.previews) {
    return [...this._sampleBatchOrder(items).batches];
  },

  _sampleOverviewAtLatestEdge(grid) {
    if (!grid) return true;
    if (this.sampleLossSortKey) return false;
    return this.sampleBatchSortDir !== 'asc' ? grid.scrollTop <= 4
      : grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 4;
  },

  _sampleOverviewLatestScrollTop(grid) {
    return this.sampleBatchSortDir !== 'asc' ? 0 : Math.max(0, (grid?.scrollHeight || 0) - (grid?.clientHeight || 0));
  },

  setSampleBatchSort(dir) {
    if (!['asc', 'desc', 'loss-overall', 'loss-high', 'loss-mid', 'loss-low'].includes(dir) || dir === this.sampleBatchSortDir
        || (['loss-high', 'loss-mid', 'loss-low'].includes(dir) && !this.sampleDetailedLossAvailable)) return;
    this._sampleLayoutAction++;
    this.sampleBatchSortDir = dir;
    this._saveSampleViewPreferences();
    // Sorting changes presentation without selecting or acknowledging another image.
    this._sampleResetScroll = true; this._sampleScrollAnchor = null;
    this.renderDashboard();
    if (this.previewLightboxOpen) {
      this._updatePreviewLightbox();
      this._revealPreviewViewTimeline(false);
    }
  },

  _sampleCaseKey(preview) {
    const sample = this._sampleRecord(preview);
    return JSON.stringify([sample.prompt_id, sample.seed == null ? null : String(sample.seed), sample.condition_key || null]);
  },

  _sampleNeedsSeed(preview) {
    const sample = this._sampleRecord(preview);
    const model = this._sampleDataModel(), batch = model.byBatch.get(sample.batch_id);
    if (!batch) return false;
    const seeds = new Set(batch.indices.map(index => model.records[index].sample)
      .filter(other => other.prompt_id === sample.prompt_id)
      .map(other => other.seed == null ? 'unknown' : String(other.seed)));
    return seeds.size > 1;
  },

  _samplePromptButtonLabel(preview) {
    return this._sampleCaseLabel(preview);
  },

  _samplePromptText(preview) {
    const prompt = this._sampleRecord(preview).params?.prompt;
    return typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';
  },

  _sampleCaseLabel(preview, includeSeed = undefined, promptText = undefined) {
    const sample = this._sampleRecord(preview);
    const batchIndices = Number.isInteger(sample.prompt_index) ? null : this._sampleDataModel().byBatch.get(sample.batch_id)?.indices || [];
    const number = Number.isInteger(sample.prompt_index) && sample.prompt_index >= 0 ? sample.prompt_index + 1
      : Math.max(0, batchIndices?.findIndex(index => this.previews[index] === preview) ?? -1) + 1;
    const prompt = promptText ?? this.t('monitor.samplePrompt').replace('{n}', number);
    const showSeed = includeSeed === undefined ? this._sampleNeedsSeed(preview) : includeSeed;
    let label = prompt + (showSeed ? ' ' + (sample.seed == null ? this.t('monitor.sampleNoSeed') : this.t('monitor.sampleSeed').replace('{n}', sample.seed)) : '');
    const model = this._sampleDataModel(), batch = model.byBatch.get(sample.batch_id);
    const seed = sample.seed == null ? 'unknown' : String(sample.seed);
    const siblings = (batch?.indices || []).map(index => model.records[index].sample)
      .filter(other => other.prompt_id === sample.prompt_id && (other.seed == null ? 'unknown' : String(other.seed)) === seed);
    if (new Set(siblings.map(other => other.condition_key || 'unverified')).size > 1) {
      label += ' ' + this._sampleConditionDifference(sample, siblings, Math.max(0, siblings.indexOf(sample)));
    }
    return label;
  },

  _sampleBatchNavigationIndex(batch, preview, items = this.previews) {
    if (!batch?.indices.length) return -1;
    if (!preview) return batch.indices[0];
    const current = this._sampleRecord(preview), key = this._sampleCaseKey(preview);
    const sameSeed = sample => sample.seed != null && current.seed != null && String(sample.seed) === String(current.seed);
    const find = predicate => batch.indices.find(index => predicate(this._sampleRecord(items[index], index), items[index]));
    return find((sample, item) => this._sampleCaseKey(item) === key)
      ?? find(sample => sample.prompt_id === current.prompt_id && sameSeed(sample))
      ?? find(sample => sample.prompt_id === current.prompt_id)
      ?? (current.prompt_index != null ? find(sample => sample.prompt_index === current.prompt_index && sameSeed(sample)) : undefined)
      ?? batch.indices[0];
  },

  _previewComparisonKey(preview) {
    if (!preview) return '';
    const sample = this._sampleRecord(preview), params = sample.params || {};
    if (sample.comparable !== true || sample.metadata_source !== 'recorded' || !sample.prompt_id || sample.seed == null || !sample.condition_key
        || typeof params.prompt !== 'string' || typeof params.negative_prompt !== 'string') return '';
    return JSON.stringify([sample.prompt_id, String(sample.seed), sample.condition_key, params.prompt, params.negative_prompt]);
  },

  canCompareCurrentPreview() {
    const current = this.previews[this.previewStep];
    return !!this._previewViewerComparisonKey(current)
      && this._previewViewerFileIndex(this._previewItemKey(current)) === this.previewStep;
  },

  _previewViewerComparisonKey(preview) {
    if (!preview) return '';
    const sample = this._sampleRecord(preview);
    if (sample.metadata_source === 'recorded') {
      const key = this._previewComparisonKey(preview);
      return key ? 'recorded:' + key : '';
    }
    // Historical filenames establish a prompt slot and optional seed, not
    // complete generation settings. This identity only permits manual viewing.
    if (sample.metadata_source === 'filename' || sample.metadata_source === 'unverified') {
      return sample.prompt_id ? JSON.stringify(['legacy', sample.prompt_id, sample.seed == null ? null : String(sample.seed)]) : '';
    }
    return !sample.metadata_source || sample.metadata_source === 'unknown' ? 'unknown' : '';
  },

  _previewViewerMetadataKey(preview) {
    const sample = this._sampleRecord(preview);
    return JSON.stringify(this._sampleStableValue({source: sample.metadata_source || 'unknown', prompt: sample.prompt_id,
      seed: sample.seed == null ? null : String(sample.seed), params: sample.params || {},
      condition: sample.condition_key || null, comparable: sample.comparable === true}));
  },

  _previewViewerFileIndex(key) {
    if (!key) return -1;
    let found = -1;
    for (let index = 0; index < this.previews.length; index++) {
      if (this._previewItemKey(this.previews[index]) !== key) continue;
      if (found >= 0) return -1;
      found = index;
    }
    return found;
  },

  _clearPreviewComparison() {
    this.cancelPreviewPaneDrag?.();
    this.previewCompareActive = false;
    this.previewComparisonWaiting = false;
    this.previewReferences = []; this._previewReferenceEntries = [];
    this.previewComparisonOrder = [];
  },

  _resolvedPreviewReferenceEntries() {
    const files = new Map();
    this.previews.forEach((preview, index) => {
      const key = this._previewItemKey(preview);
      files.set(key, files.has(key) ? -1 : index);
    });
    return (this._previewReferenceEntries || []).flatMap(entry => {
      const index = files.get(entry.itemKey), preview = this.previews[index];
      const sample = preview && this._sampleRecord(preview);
      return Number.isInteger(index) && index >= 0 && entry.caseKey
        // Filename batches can be refined by later log records. The actual
        // file and captured conditions still identify a manually fixed image.
        && (sample.metadata_source === 'filename' || sample.batch_id === entry.batchId)
        && this._previewViewerComparisonKey(preview) === entry.caseKey
        && this._previewViewerMetadataKey(preview) === entry.metadataKey
        ? [{entry, preview, index}] : [];
    });
  },

  pinPreviewReference(previewOrIndex, refresh = true) {
    const preview = Number.isInteger(previewOrIndex) ? this.previews[previewOrIndex] : previewOrIndex;
    const key = this._previewViewerComparisonKey(preview);
    this._syncPreviewReference();
    const fileIndex = this._previewViewerFileIndex(this._previewItemKey(preview)), actual = this.previews[fileIndex];
    if (!key || fileIndex < 0) return false;
    const entry = {itemKey: this._previewItemKey(preview), caseKey: key,
      batchId: this._sampleRecord(preview).batch_id, metadataKey: this._previewViewerMetadataKey(preview)};
    if (this._sampleRecord(actual).batch_id !== entry.batchId || this._previewViewerComparisonKey(actual) !== key
        || this._previewViewerMetadataKey(actual) !== entry.metadataKey) return false;
    if (this._previewReferenceEntries.length && this._previewReferenceEntries[0].caseKey !== key) this._clearPreviewComparison();
    const entries = this._previewReferenceEntries || [];
    if (entry.itemKey === this._previewItemKey(this.previews[this.previewStep]) && !this.previewComparisonWaiting
        && this.previewComparisonOrder.includes(null)) {
      this.previewComparisonOrder = this.previewComparisonOrder.map(key => key === null ? entry.itemKey : key).concat(null);
    }
    if (!entries.some(other => other.itemKey === entry.itemKey)) this._previewReferenceEntries = [...entries, entry];
    this.previewCompareActive = true;
    this.previewComparisonWaiting = true;
    this._syncPreviewReference();
    if (refresh && this.previewLightboxOpen) this._updatePreviewLightbox();
    return this._previewReferenceEntries.some(other => other.itemKey === entry.itemKey);
  },

  selectPreviewComparisonCurrent(index) {
    const current = this.previews[index];
    if (!current || !Number.isInteger(index) || this._previewViewerFileIndex(this._previewItemKey(current)) !== index) return false;
    this._syncPreviewReference();
    if (this._isPreviewReference(current)) return false;
    this.previewStep = index;
    this.sampleBatchId = this._sampleRecord(current, index).batch_id;
    this.previewComparisonWaiting = false;
    this._syncPreviewReference();
    return true;
  },

  _isPreviewReference(preview) {
    return this.previewCompareActive && (this._previewReferenceEntries || [])
      .some(entry => entry.itemKey === this._previewItemKey(preview));
  },

  unpinPreviewReference(itemKey) {
    const entries = this._previewReferenceEntries || [];
    if (!entries.some(entry => entry.itemKey === itemKey)) return false;
    this._previewReferenceEntries = entries.filter(entry => entry.itemKey !== itemKey);
    this._syncPreviewReference();
    if (this.previewLightboxOpen) this._updatePreviewLightbox();
    return true;
  },

  startPreviewComparison() {
    return this.pinPreviewReference(this.previewStep);
  },

  stopPreviewComparison() {
    this._clearPreviewComparison();
    if (this.previewLightboxOpen) this._updatePreviewLightbox();
  },

  setCurrentPreviewAsReference() {
    return this.pinPreviewReference(this.previewStep);
  },

  _syncPreviewReference() {
    if (!this.previewCompareActive) { this._clearPreviewComparison(); return; }
    const entries = this._previewReferenceEntries || [], current = this.previews[this.previewStep];
    if (!entries.length || (!this.previewComparisonWaiting
        && (this._previewViewerComparisonKey(current) !== entries[0].caseKey
          || this._previewViewerFileIndex(this._previewItemKey(current)) !== this.previewStep))) {
      this._clearPreviewComparison(); return;
    }
    // Each fixed file resolves independently. A deleted or mutated reference
    // cannot replace its neighbors or remove other valid fixed images.
    const resolved = this._resolvedPreviewReferenceEntries();
    if (!resolved.length) { this._clearPreviewComparison(); return; }
    this._previewReferenceEntries = resolved.map(item => item.entry);
    this.previewReferences = resolved.map(item => item.preview);
    this._syncPreviewComparisonOrder();
  },

  _syncPreviewComparisonOrder() {
    const keys = this.previewReferences.map(preview => this._previewItemKey(preview));
    const valid = new Set([...keys, null]);
    let order = (this.previewComparisonOrder || []).filter((key, index, items) => valid.has(key) && items.indexOf(key) === index);
    for (const key of keys) if (!order.includes(key)) order.splice(order.includes(null) ? order.indexOf(null) : order.length, 0, key);
    if (!order.includes(null)) order.push(null);
    // A waiting slot is never the baseline. Removing a reference also retains
    // a fixed first image rather than turning the browsing slot into a baseline.
    if (this.previewComparisonWaiting || order[0] === null) order = order.filter(key => key !== null).concat(null);
    if (order.length !== this.previewComparisonOrder.length || order.some((key, index) => key !== this.previewComparisonOrder[index])) this.previewComparisonOrder = order;
    return order;
  },

  _previewComparisonBaselinePreview() {
    if (!this.previewCompareActive) return null;
    const first = this.previewComparisonOrder[0];
    return this.previewReferences.find(preview => this._previewItemKey(preview) === first) || this.previewReferences[0] || null;
  },

  movePreviewToFirst(previewOrIndex) {
    const preview = Number.isInteger(previewOrIndex) ? this.previews[previewOrIndex] : previewOrIndex;
    const key = this._previewItemKey(preview), index = this._previewViewerFileIndex(key);
    if (index < 0 || !this._previewViewerComparisonKey(preview)) return false;
    if (index === this.previewStep && !this.previewComparisonWaiting && !this.canPinCurrentPreview()) return false;
    const current = this.previewStep, waiting = this.previewComparisonWaiting;
    if (!this._isPreviewReference(preview)) {
      if (!this.pinPreviewReference(preview, false)) return false;
      if (index !== current && !waiting) this.selectPreviewComparisonCurrent(current);
    }
    this.previewComparisonOrder = [key, ...this.previewComparisonOrder.filter(item => item !== key)];
    this._syncPreviewReference();
    if (this.previewLightboxOpen) this._updatePreviewLightbox();
    return true;
  },

  reorderPreviewComparison(order) {
    if (!this.previewCompareActive || !Array.isArray(order)) return false;
    const existing = this._syncPreviewComparisonOrder();
    if (order.length !== existing.length || new Set(order).size !== order.length || order.some(key => !existing.includes(key))) return false;
    let result = [...order];
    if (result[0] === null) {
      if (this.previewComparisonWaiting || !this.canPinCurrentPreview()) return false;
      const key = this._previewItemKey(this.previews[this.previewStep]);
      if (!this.pinPreviewReference(this.previewStep, false)) return false;
      result = result.map(item => item === null ? key : item).concat(null);
    }
    this.previewComparisonOrder = result;
    this._syncPreviewReference();
    if (this.previewLightboxOpen) this._updatePreviewLightbox();
    return true;
  },

  selectPreviewCase(index) {
    if (!this.selectPreviewComparisonCurrent(index)) return;
    this._updatePreviewLightbox();
  },

  _sampleStableValue(value) {
    if (Array.isArray(value)) return value.map(item => this._sampleStableValue(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, this._sampleStableValue(value[key])]));
    return value;
  },

  _sampleConditionDifference(sample, siblings, index) {
    const changed = key => new Set(siblings.map(other => JSON.stringify(other.params?.[key] ?? null))).size > 1;
    const params = sample.params || {}, parts = [];
    if (changed('width') || changed('height')) parts.push((params.width ?? '—') + '×' + (params.height ?? '—'));
    if (changed('cfg_scale')) parts.push('CFG ' + (params.cfg_scale ?? '—'));
    if (changed('steps')) parts.push((params.steps ?? '—') + ' steps');
    ['sampler', 'scheduler', 'flow_shift', 'architecture'].forEach(key => {
      if (changed(key)) parts.push((key === 'flow_shift' ? 'shift ' : '') + String(params[key] ?? '—'));
    });
    if (changed('base_model')) parts.push(this._sampleWeightLabel(params.base_model) || '—');
    if (changed('model_variant')) {
      const variant = params.model_variant;
      if (variant && typeof variant === 'object') {
        const model = this._sampleWeightLabel(variant.turbo_dit), lora = this._sampleWeightLabel(variant.turbo_lora);
        if (model) parts.push(model);
        if (lora) parts.push(lora + ' × ' + (variant.turbo_lora_multiplier ?? 1));
      } else if (variant != null) parts.push(String(variant));
    }
    if (changed('loras') && Array.isArray(params.loras)) {
      const loras = params.loras.map(lora => { const name = this._sampleWeightLabel(lora); return name ? name + ' × ' + (lora.multiplier ?? 1) : ''; }).filter(Boolean);
      if (loras.length) parts.push(loras.join(', '));
      else if (!params.loras.length) parts.push('LoRA × 0');
    }
    return parts.join(' ') || this.t('monitor.sampleConditionOption').replace('{n}', index + 1);
  },

  _sampleWeightLabel(value) {
    const path = typeof value === 'string' ? value : value?.path;
    return typeof path === 'string' ? path.replace(/\\/g, '/').split('/').pop() || path : '';
  },

  _previewLightboxIndices(items = this.previews) {
    const current = this.previewComparisonWaiting && this.previewReferences?.length
      ? this.previewReferences[0] : this.previews[this.previewStep];
    const sample = current && this._sampleRecord(current);
    const model = this._sampleDataModel(items);
    if (!current || sample.metadata_source === 'unknown') return model.batches.flatMap(batch => batch.indices);
    const currentKey = this._previewItemKey(current);
    return model.batches.map(batch => {
      const selected = batch.indices.find(index => this._previewItemKey(items[index]) === currentKey);
      if (selected !== undefined) return selected;
      const candidates = batch.indices.filter(index => {
        const other = this._sampleRecord(items[index], index);
        return other.prompt_id === sample.prompt_id && (other.seed == null ? sample.seed == null : sample.seed != null && String(other.seed) === String(sample.seed));
      });
      const exact = candidates.filter(index => this._sampleCaseKey(items[index]) === this._sampleCaseKey(current));
      // A temporal inspection keeps the selected prompt and seed. Missing or
      // ambiguous cases are skipped rather than silently selecting another seed.
      return exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : -1;
    }).filter(index => index >= 0);
  },

  _previewLightboxDisplayIndices(indices = this._previewLightboxIndices()) {
    const display = [...indices];
    // Explicitly fixed actual files remain visible even when their batches
    // contain repeated metadata. Canonical automatic pairing stays unchanged.
    if (this.previewCompareActive) {
      const key = this.previewComparisonWaiting ? this._previewReferenceEntries[0]?.caseKey
        : this._previewViewerComparisonKey(this.previews[this.previewStep]);
      this._resolvedPreviewReferenceEntries().forEach(({entry, index}) => {
        if (entry.caseKey === key && !display.includes(index)) display.push(index);
      });
      const model = this._sampleDataModel();
      display.sort((a, b) => model.records[a].batch.position - model.records[b].batch.position || a - b);
    }
    if (this.sampleLossSortKey) {
      const order = this._sampleBatchOrder(), model = order.model;
      return display.sort((a, b) => order.positions.get(model.records[a].batch.id) - order.positions.get(model.records[b].batch.id) || b - a);
    }
    return this.sampleEffectiveBatchSort !== 'asc' ? display.reverse() : display;
  },

  _previewLightboxNavigationIndices(indices = this._previewLightboxDisplayIndices()) {
    if (!this.previewCompareActive) return indices;
    const fixed = new Set((this._previewReferenceEntries || []).map(entry => entry.itemKey));
    return indices.filter(index => !fixed.has(this._previewItemKey(this.previews[index])));
  },

  _previewLightboxNavigationTarget(direction, indices = this._previewLightboxDisplayIndices()) {
    const position = indices.indexOf(this.previewStep);
    const available = new Set(this._previewLightboxNavigationIndices(indices));
    const step = direction < 0 ? -1 : 1;
    // While waiting, the previous current file may be fixed or outside the
    // prompt sequence. Use its visual position without selecting fixed files.
    for (let cursor = position < 0 ? (step < 0 ? indices.length - 1 : 0) : position + step;
      cursor >= 0 && cursor < indices.length; cursor += step) {
      if (available.has(indices[cursor])) return indices[cursor];
    }
    return -1;
  },

  _invalidatePreviewRequest() {
    if (this._previewRefreshFeedbackTimer) clearTimeout(this._previewRefreshFeedbackTimer);
    this._previewRefreshFeedbackTimer = null;
    this.previewRefreshFeedback = false;
    this._previewRequestSeq++;
    this._previewSnapshotSeq++;
    this.previewsLoading = false;
  },

  _applyPreviewSnapshot(previews, snapshotSeq = this._previewSnapshotSeq) {
    if (snapshotSeq !== this._previewSnapshotSeq) return false;
    // A cacheable snapshot must not cancel a forced refresh already in flight.
    this._previewSnapshotSeq++;
    const changed = this._replacePreviewItems(Array.isArray(previews) ? previews : []);
    if (changed) this.previewsVersion++;
    this._followLatestPreview();
    return true;
  },

  _replacePreviewItems(items) {
    const previous = this.previews;
    const selectedKey = this._previewItemKey(previous[this.previewStep]);
    const selectedPreview = previous[this.previewStep];
    const previousModel = this._sampleDataModel();
    const previousBatch = this._sampleSelectedBatch();
    const latestBatch = previousModel.batches[previousModel.batches.length - 1];
    const nextLatestId = items.length ? this._sampleRecord(items[items.length - 1], items.length - 1).batch_id : '';
    const readingLatestGroup = this.sampleExpandedBatchId === latestBatch?.id && nextLatestId === latestBatch?.id;
    const inspecting = this.previewInfoOpen || (this.sampleSidebarActive && this._sampleSidebarInspecting);
    const follow = !this.sampleLossSortKey && !this.previewLightboxOpen && !inspecting && !this._sampleExpansionPausedFollow
      && (this._sampleOverviewAtEnd !== false || readingLatestGroup) && (!previousBatch || previousBatch.id === latestBatch?.id);
    const changed = previous.length !== items.length || previous.some((item, index) => {
      const next = items[index];
      return !next || ['name', 'path', 'version', 'url', 'thumb_url', 'inspect_url', 'metadata_url']
        .some(field => item[field] !== next[field]) || JSON.stringify(item.sample || null) !== JSON.stringify(next.sample || null);
    });
    const previousKeys = new Set(previous.map(item => this._previewItemKey(item)));
    if (!follow && items.some(item => !previousKeys.has(this._previewItemKey(item)))) this.previewHasNew = true;
    this.previews = items;
    this._sampleModelCache = null;
    const model = this._sampleDataModel();
    if (this.sampleExpandedBatchId && !model.byBatch.has(this.sampleExpandedBatchId)) {
      this.sampleExpandedBatchId = ''; this._sampleExpansionPausedFollow = false;
    }
    const selectedIndex = selectedKey ? items.findIndex(item => this._previewItemKey(item) === selectedKey) : -1;
    const selectedBatch = model.records[selectedIndex]?.batch;
    // A late manifest can move just this file out of a still-existing legacy
    // batch. An inspected image owns its file; the idle overview owns its batch.
    const target = follow ? model.batches[model.batches.length - 1]
      : ((this.previewLightboxOpen || inspecting) && selectedBatch) || model.byBatch.get(previousBatch?.id)
        || selectedBatch || model.batches[model.batches.length - 1];
    this.sampleBatchId = target?.id || '';
    if (selectedIndex >= 0) this.previewStep = selectedIndex;
    if (target && (!items[this.previewStep] || this._sampleRecord(items[this.previewStep], this.previewStep).batch_id !== target.id)) {
      this.previewStep = this._sampleBatchNavigationIndex(target, selectedPreview, items);
    }
    if (!target) this.previewStep = 0;
    if (!this._previewClosePending) this._syncPreviewReference();
    if (this.previewTimelineMenu) {
      if (this._previewTimelineMenuTarget() < 0) this.closePreviewTimelineMenu(false);
      else this._refreshPreviewTimelineMenuActions();
    }
    return changed;
  },

  setPreviewMediaPaused(paused) {
    this._previewMediaPaused = !!paused;
    if (paused) {
      this._cancelPreviewMediaQueue();
      return;
    }
    if (this.currentRoute !== 'monitor-dashboard' || this.monitorTab !== 'samples') return;
    const content = document.getElementById('monitorDashboard');
    if (content) this.schedulePreviewMediaLoads(content);
  },

  _cancelPreviewMediaQueue() {
    this._previewMediaGeneration++;
    for (const item of this._previewMediaQueue) delete item.image.dataset.previewQueued;
    if (this._previewMediaActive) delete this._previewMediaActive.dataset.previewQueued;
    this._previewMediaActive = null;
    if (this._previewMediaObserver) this._previewMediaObserver.disconnect();
    this._previewMediaObserver = null;
    this._previewMediaQueue = [];
    if (this._previewMediaAbort) this._previewMediaAbort.abort();
    this._previewMediaAbort = null;
    this._previewMediaLoading = false;
  },

  schedulePreviewMediaLoads(root) {
    if (!this.weakNetworkMode || this._previewMediaPaused || !root) return;
    const enqueue = image => {
      const url = image.dataset.previewUrl;
      if (!url || image.dataset.previewLoaded === '1' || image.dataset.previewQueued === '1') return;
      const source = this._previewMediaByUrl?.get(url);
      if (source) { this._setPreviewMediaSource(image, url, source); return; }
      image.dataset.previewQueued = '1';
      this._previewMediaQueue.push({ image, url });
    };
    if (!this._previewMediaObserver && typeof IntersectionObserver !== 'undefined') {
      this._previewMediaObserver = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) enqueue(entry.target);
        this._drainPreviewMediaQueue();
      }, { rootMargin: '320px' });
    }
    const images = Array.from(root.querySelectorAll('img[data-preview-url]'));
    for (const image of images) {
      if (image.dataset.previewLoaded === '1') continue;
      if (this._previewMediaObserver) this._previewMediaObserver.observe(image);
      else enqueue(image);
    }
    this._drainPreviewMediaQueue();
  },

  async _drainPreviewMediaQueue() {
    if (this._previewMediaLoading || this._previewMediaPaused || !this.weakNetworkMode) return;
    let next = this._previewMediaQueue.shift();
    while (next) {
      if (!next.image.isConnected || next.image.dataset.previewUrl !== next.url) delete next.image.dataset.previewQueued;
      else {
        const source = this._previewMediaByUrl?.get(next.url);
        if (!source) break;
        this._setPreviewMediaSource(next.image, next.url, source);
      }
      next = this._previewMediaQueue.shift();
    }
    if (!next) return;
    const generation = this._previewMediaGeneration;
    this._previewMediaLoading = true;
    this._previewMediaActive = next.image;
    const controller = new AbortController();
    this._previewMediaAbort = controller;
    try {
      // `priority` is ignored by browsers that do not implement fetch priority;
      // serialisation and cancellation still provide the weak-link guarantee.
      const response = await fetch(next.url, { cache: 'default', signal: controller.signal, priority: 'low' });
      if (!response.ok) throw new Error('preview request failed');
      const blob = await response.blob();
      if (generation === this._previewMediaGeneration && next.image.isConnected && next.image.dataset.previewUrl === next.url && !this._previewMediaPaused) {
        const objectUrl = URL.createObjectURL(blob);
        this._previewMediaObjectUrls.push(objectUrl);
        // The overview and viewer timeline can display the same thumbnail.
        // Share only immutable, versioned URLs so bare URLs remain refreshable.
        if (/[?&]v=[^&]+/.test(next.url)) (this._previewMediaByUrl ||= new Map()).set(next.url, objectUrl);
        this._setPreviewMediaSource(next.image, next.url, objectUrl);
      }
    } catch (error) {
      // Cancellation and transient slow-link failures remain retryable on the
      // next render or when realtime freshness recovers.
      if (next.image && next.image.isConnected) {
        delete next.image.dataset.previewQueued;
        if (error?.name !== 'AbortError' && generation === this._previewMediaGeneration) {
          this._previewMediaObserver?.unobserve(next.image);
          this._previewMediaRetryNeeded = true;
          next.image.closest?.('.preview-thumb-frame')?.classList.add('is-error');
        }
      }
    } finally {
      if (generation !== this._previewMediaGeneration || this._previewMediaAbort !== controller) return;
      this._previewMediaAbort = null;
      this._previewMediaActive = null;
      this._previewMediaLoading = false;
      if (!this._previewMediaPaused) this._drainPreviewMediaQueue();
    }
  },

  _setPreviewMediaSource(image, url, source) {
    if (!image.isConnected || image.dataset.previewUrl !== url) return;
    image.src = source;
    image.dataset.previewLoaded = '1';
    this._previewMediaObserver?.unobserve(image);
  },

  _releasePreviewMediaObjectUrls() {
    for (const url of this._previewMediaObjectUrls) URL.revokeObjectURL(url);
    this._previewMediaObjectUrls = [];
    this._previewMediaByUrl?.clear();
  },

  // Retain successfully decoded, versioned thumbnails across a grid rebuild.
  // The complete URL includes the run and file version, so overwritten files
  // and samples from another run will still be fetched again.
  _capturePreviewMedia(root) {
    const loaded = new Map();
    const owned = new Set(this._previewMediaObjectUrls);
    if (!root) return loaded;
    for (const image of root.querySelectorAll('img[data-preview-url]')) {
      const url = image.dataset.previewUrl || '';
      const path = image.closest('.m-sample-card-image, .preview-grid-item, .preview-view-timeline-item')?.dataset.previewPath;
      const src = image.getAttribute('src');
      // Keep a decoded old image's source when its replacement failed. Only
      // this image's own failed blob must leave the cache before a retry.
      if (image.complete && !image.naturalWidth && this._previewMediaByUrl?.get(url) === src) this._previewMediaByUrl.delete(url);
      if (path && /[?&]v=[^&]+/.test(url) && image.dataset.previewLoaded === '1'
          && image.complete && image.naturalWidth > 0 && owned.has(src)
          && !image.closest('.preview-thumb-frame')?.classList.contains('is-error')) {
        loaded.set(JSON.stringify([path, url]), src);
      }
    }
    return loaded;
  },

  _restorePreviewMedia(root, loaded) {
    const retained = new Set();
    const owned = new Set(this._previewMediaObjectUrls);
    if (root) for (const image of root.querySelectorAll('img[data-preview-url]')) {
      // Local disclosure retains the surrounding DOM. Its existing images can
      // still be decoding, so keep their URL before consulting a sibling cache.
      const current = image.getAttribute('src');
      if (owned.has(current)) {
        retained.add(current);
        continue;
      }
      const path = image.closest('.m-sample-card-image, .preview-grid-item, .preview-view-timeline-item')?.dataset.previewPath;
      const src = loaded.get(JSON.stringify([path, image.dataset.previewUrl]));
      if (src) {
        image.src = src;
        image.dataset.previewLoaded = '1';
        retained.add(src);
      }
    }
    this._previewMediaObjectUrls = this._previewMediaObjectUrls.filter(url => {
      if (retained.has(url)) return true;
      URL.revokeObjectURL(url);
      return false;
    });
    for (const [url, source] of this._previewMediaByUrl || []) {
      if (!retained.has(source)) this._previewMediaByUrl.delete(url);
    }
  },

  // ── 预览样本刷新 ────────────────────────────────────────
  async refreshPreviews(notifyOnFailure = true) {
    /** 主动重新拉取预览样本（绕过后端 5s 缓存）。 */
    if (this.previewsLoading) return;
    // A local refresh can finish before the first frame. Keep the click
    // feedback visible briefly without holding the request or its results.
    if (notifyOnFailure) this._showRefreshFeedback('preview');
    this.previewsLoading = true;
    const requestSeq = ++this._previewRequestSeq;
    this._previewSnapshotSeq++;
    const sourceRunDir = this.currentOutputRunDir;
    const sourceTaskId = this.taskId;
    const isCurrent = () => requestSeq === this._previewRequestSeq
      && sourceRunDir === this.currentOutputRunDir
      && (sourceRunDir || sourceTaskId === this.taskId);
    try {
      // ``limit=0`` means all compact preview metadata. Image bytes continue
      // through the thumbnail queue (or normal browser loading when disabled).
      let url = '/api/monitor/previews?refresh=1&limit=0';
      const runDir = this.currentOutputRunDir;
      if (runDir) {
        url += '&run_dir=' + encodeURIComponent(runDir);
      } else if (this.taskId) {
        url += '&task_id=' + encodeURIComponent(this.taskId);
      }
      const r = await fetch(url);
      const j = await r.json();
      if (!isCurrent()) return;
      if (j.status === 'success') {
        // Reject snapshots started during the refresh if they arrive after it.
        this._previewSnapshotSeq++;
        const changed = this._replacePreviewItems(j.data || []);
        const mediaRoot = document.getElementById('monitorDashboard') || document.getElementById('monitorTabContent');
        const failedMedia = notifyOnFailure && mediaRoot?.querySelector('.preview-thumb-frame.is-error');
        if (failedMedia) this._clearPreviewTimelineImageSwaps?.();
        if (changed || failedMedia) this.previewsVersion++;
        if (j.meta) {
          const target = this.currentArtifactData();
          target.artifact_available = j.meta.artifact_available;
          if (j.meta.artifact_dir) target.artifact_dir = j.meta.artifact_dir;
          if (j.meta.preview_enabled !== undefined) target.preview_enabled = j.meta.preview_enabled;
        }
        this._followLatestPreview();
      } else if (notifyOnFailure) this.toast?.(this.t('monitor.previewRefreshFailed'), 'error');
    } catch (e) {
      if (notifyOnFailure && isCurrent()) this.toast?.(this.t('monitor.previewRefreshFailed'), 'error');
    } finally {
      if (requestSeq === this._previewRequestSeq) {
        this.previewsLoading = false;
        if (this.currentRoute === 'monitor-dashboard') this.renderDashboard();
      }
    }
  },

  // Keep an open viewer on its selected image; only an idle viewer follows the latest.
  _followLatestPreview() {
    if (this._previewClosePending) return;
    const n = this.previews.length;
    if (n === 0) { this.previewStep = 0; if (this.closePreviewLightbox) this.closePreviewLightbox(); return; }
    if (this.previewStep > n - 1) this.previewStep = n - 1;
    if (this.previewLightboxOpen) this._updatePreviewLightbox();
  },

  _sampleMetadata(filename) {
    const match = String(filename || '').match(/(?:^|_)(e?)(\d{6})_(\d{2})_/i);
    if (!match) return { stage: '', prompt: '' };
    const kind = match[1] ? 'epoch' : 'step';
    return {
      stage: kind + ':' + Number(match[2]),
      prompt: this.t('monitor.samplePrompt').replace('{n}', Number(match[3]) + 1),
    };
  },

};
