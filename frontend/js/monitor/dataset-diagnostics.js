/* 训练集诊断状态管理、筛选排序、增量轮询与单图详情弹窗逻辑；由 monitor-core.js 装配。 */
(() => {
  function readStoredViewMode() {
    try {
      const value = globalThis.localStorage?.getItem('anima_dataset_diag_view');
      return value === 'table' ? 'table' : 'grid';
    } catch (_) {
      return 'grid';
    }
  }

  function writeStoredViewMode(mode) {
    try {
      globalThis.localStorage?.setItem('anima_dataset_diag_view', mode);
    } catch (_) {}
  }

  function readStoredGroupByFolder() {
    try {
      return globalThis.localStorage?.getItem('anima_dataset_diag_group_folder') === '1';
    } catch (_) {
      return false;
    }
  }

  function writeStoredGroupByFolder(enabled) {
    try {
      globalThis.localStorage?.setItem('anima_dataset_diag_group_folder', enabled ? '1' : '0');
    } catch (_) {}
  }

  function readStoredShowZones() {
    try {
      return globalThis.localStorage?.getItem('anima_dataset_diag_show_zones') === '1';
    } catch (_) {
      return false;
    }
  }

  function writeStoredShowZones(enabled) {
    try {
      globalThis.localStorage?.setItem('anima_dataset_diag_show_zones', enabled ? '1' : '0');
    } catch (_) {}
  }

  function readStoredRegMode() {
    try {
      const value = globalThis.localStorage?.getItem('anima_dataset_diag_reg_mode');
      return ['exclude', 'only', 'all'].includes(value) ? value : 'exclude';
    } catch (_) {
      return 'exclude';
    }
  }

  function writeStoredRegMode(mode) {
    try {
      globalThis.localStorage?.setItem('anima_dataset_diag_reg_mode', mode);
    } catch (_) {}
  }

  window.monitorDatasetDiagMixin = {
    datasetDiagData: null,
    datasetDiagLoading: false,
    datasetDiagError: '',
    datasetDiagRefreshFeedback: false,
    _datasetDiagRefreshTimer: null,
    _datasetDiagSourceKey: '',
    _datasetDiagPresetInitializedFor: '',
    _datasetDiagRequest: null,
    _datasetDiagQueryKey: '',
    _datasetDiagRequestedRunId: '',
    _datasetDiagPayloadRevision: '',
    _datasetDiagSnapshotVersion: 0,
    _datasetDiagUpdatedIds: null,
    _datasetDiagUpdatePulseSeq: 0,
    _datasetDiagContextFilterCache: null,
    _datasetDiagImageFilterCache: null,
    _datasetDiagGroupedCache: null,
    _datasetDiagLoaded: false,
    _datasetDiagNeedsRefresh: false,
    _datasetDiagPollTimer: null,

    // Query & view state
    datasetDiagRunId: '',
    datasetDiagMinCount: 3,
    datasetDiagSubTab: 'overview',
    datasetDiagGroupFilter: null,
    datasetDiagResoSort: 'order',
    datasetDiagGroupExpanded: {},
    datasetDiagCollapsedDims: {},
    datasetDiagScatterZoom: null,
    _datasetDiagHoverPreview: null,
    _datasetDiagPreviewClearTimer: null,
    _datasetDiagSideScrollingUntil: 0,
    _datasetDiagActiveDotId: '',
    _datasetDiagPinnedDotId: '',
    datasetDiagPreset: 'all',
    datasetDiagSearch: '',
    datasetDiagRegMode: readStoredRegMode(),
    datasetDiagEffectiveRegMode: '',
    datasetDiagSort: 'residual_desc',
    datasetDiagViewMode: readStoredViewMode(),
    datasetDiagGroupByFolder: readStoredGroupByFolder(),
    datasetDiagShowZones: readStoredShowZones(),
    datasetDiagCollapsedFolders: {},
    datasetDiagDisplayLimit: 120,

    // Modal state
    datasetDiagModalOpen: false,
    datasetDiagSamplesModalOpen: false,
    datasetDiagSamplesFilter: 'all',
    datasetDiagModalImageId: '',
    datasetDiagModalDetail: null,
    datasetDiagModalLoading: false,
    datasetDiagModalError: '',
    datasetDiagPageEditing: false,
    datasetDiagPageDraft: '',
    _datasetDiagPageLastDraft: '',
    _datasetDiagModalSeq: 0,
    _datasetDiagModalOpening: false,
    _datasetDiagOpenTimer: 0,
    _datasetDiagImgSeq: 0,
    _datasetDiagModalController: null,
    _datasetDiagDetailCache: null,
    _datasetDiagLightCacheKeys: null,
    _datasetDiagNeighborPrefetchTimer: 0,
    _datasetDiagNeighborControllers: null,
    _datasetDiagOpenObserver: null,
    _datasetDiagViewport: null,
    _datasetDiagViewportState: null,

    _datasetDiagSource() {
      const runDir = this.selectedRunDir || this.currentOutputRunDir || '';
      const taskId = (!this.selectedRunDir && this.liveTaskId) ? String(this.liveTaskId) : '';
      const key = runDir ? ('run:' + runDir) : (taskId ? ('task:' + taskId) : '');
      return { runDir, taskId, key };
    },

    _resetDatasetDiagForRun(key = '') {
      if (this._datasetDiagRefreshTimer) {
        clearTimeout(this._datasetDiagRefreshTimer);
        this._datasetDiagRefreshTimer = null;
      }
      this.datasetDiagRefreshFeedback = false;
      this._stopDatasetDiagPolling();
      this._cancelDatasetDiagRequest();
      this._cancelDatasetDiagPreviewFetch();
      this._datasetDiagSourceKey = key || '';
      this._datasetDiagPresetInitializedFor = '';
      this.datasetDiagData = null;
      this.datasetDiagError = '';
      this._datasetDiagLoaded = false;
      this._datasetDiagNeedsRefresh = false;
      this._datasetDiagQueryKey = '';
      this._datasetDiagRequestedRunId = '';
      this._datasetDiagPayloadRevision = '';
      this._datasetDiagSnapshotVersion++;
      this._datasetDiagUpdatedIds = null;
      this._datasetDiagUpdatePulseSeq = 0;
      this._datasetDiagContextFilterCache = null;
      this._datasetDiagImageFilterCache = null;
      this._datasetDiagGroupedCache = null;
      this.datasetDiagRunId = '';
      this.datasetDiagSubTab = 'overview';
      this.datasetDiagEffectiveRegMode = '';
      this.datasetDiagGroupFilter = null;
      this.datasetDiagResoSort = 'order';
      this.datasetDiagGroupExpanded = {};
      this.datasetDiagCollapsedDims = {};
      this.datasetDiagCollapsedFolders = {};
      this.datasetDiagScatterZoom = null;
      this._cancelDatasetDiagPreviewClear();
      this._datasetDiagHoverPreview = null;
      this._datasetDiagSideScrollingUntil = 0;
      this._datasetDiagActiveDotId = '';
      this._datasetDiagPinnedDotId = '';
      this.datasetDiagSearch = '';
      this.datasetDiagPreset = 'all';
      this.datasetDiagSort = 'residual_desc';
      this.datasetDiagDisplayLimit = 120;
      if (this._datasetDiagDetailCache) this._datasetDiagDetailCache.clear();
      if (this._datasetDiagLightCacheKeys) this._datasetDiagLightCacheKeys.clear();
      this.closeDatasetDiagModal();
    },

    _cancelDatasetDiagRequest() {
      const request = this._datasetDiagRequest;
      this._datasetDiagRequest = null;
      request?.controller.abort();
      this.datasetDiagLoading = false;
    },

    _stopDatasetDiagPolling() {
      if (this._datasetDiagPollTimer) {
        clearTimeout(this._datasetDiagPollTimer);
        this._datasetDiagPollTimer = null;
      }
    },

    _suspendDatasetDiagnostics() {
      this._stopDatasetDiagPolling();
      if (this._datasetDiagRequest || (!this.selectedRunDir && this._datasetDiagTrainingActive())) {
        this._datasetDiagNeedsRefresh = true;
      }
      this._cancelDatasetDiagRequest();
    },

    _datasetDiagTrainingActive() {
      const state = String(this.monitorData?.state || '').toUpperCase();
      return state === 'RUNNING' || state === 'CREATED';
    },

    _syncDatasetDiagPolling() {
      const canPoll = () => !this.selectedRunDir && this.currentRoute === 'monitor-dashboard'
        && this.monitorTab === 'dataset' && this._datasetDiagTrainingActive() && this._datasetDiagSource().key;
      if (!canPoll()) {
        this._stopDatasetDiagPolling();
        return;
      }
      if (this._datasetDiagPollTimer || this._datasetDiagRequest) return;
      this._datasetDiagPollTimer = setTimeout(() => {
        this._datasetDiagPollTimer = null;
        if (canPoll()) void this.loadDatasetDiagnostics({ silent: true });
      }, 6000);
    },

    refreshDatasetDiagnostics() {
      if (this.datasetDiagLoading) return;
      this.datasetDiagRefreshFeedback = true;
      if (this._datasetDiagRefreshTimer) clearTimeout(this._datasetDiagRefreshTimer);
      this._datasetDiagRefreshTimer = setTimeout(() => {
        this.datasetDiagRefreshFeedback = false;
        this._datasetDiagRefreshTimer = null;
      }, 450);
      return this.loadDatasetDiagnostics({ force: true, refreshLocal: true });
    },

    _datasetDiagRequestRegMode(source, runId = '') {
      const mode = this.datasetDiagRegMode;
      return ['exclude', 'only', 'all'].includes(mode) ? mode : 'exclude';
    },

    loadDatasetDiagnostics(options = {}) {
      const silent = !!options.silent;
      const source = this._datasetDiagSource();
      if (this._datasetDiagSourceKey !== source.key) {
        this._resetDatasetDiagForRun(source.key);
      }
      if (!source.key) {
        this._datasetDiagLoaded = true;
        this._datasetDiagNeedsRefresh = false;
        return;
      }

      const pending = this._datasetDiagRequest;
      const runId = options.runId ?? pending?.runId ?? this._datasetDiagRequestedRunId;
      const minCount = options.minCount ?? pending?.minCount ?? this.datasetDiagMinCount;
      const regMode = options.regMode ?? pending?.regMode ?? this._datasetDiagRequestRegMode(source, runId);
      const key = JSON.stringify([source.key, runId, minCount, regMode]);
      if (pending?.key === key && !options.force) return pending.promise;
      this._cancelDatasetDiagRequest();
      this._stopDatasetDiagPolling();
      this._datasetDiagNeedsRefresh = false;
      const request = { key, runId, minCount, regMode, controller: new AbortController(), promise: null };
      this._datasetDiagRequest = request;
      this.datasetDiagLoading = !silent || !this._datasetDiagLoaded;
      if (this.datasetDiagLoading) this.datasetDiagError = '';
      request.promise = this._fetchDatasetDiagnostics(source, request, options);
      if (this.datasetDiagLoading && options.renderStart !== false) this.renderDashboard?.();
      return request.promise;
    },

    async _fetchDatasetDiagnostics(source, request, options) {
      // Alpine wraps state objects. The AbortController is the stable request identity.
      const isCurrent = () => this._datasetDiagRequest?.controller === request.controller
        && this._datasetDiagSource().key === source.key;
      let repaint = this.datasetDiagLoading;
      try {
        const params = new URLSearchParams({
          min_count: String(request.minCount),
          bins: '10',
          reg_mode: request.regMode || 'exclude',
        });
        if (source.runDir) params.set('run_dir', source.runDir);
        if (source.taskId) params.set('task_id', source.taskId);
        if (request.runId) params.set('run_id', request.runId);
        if (options.refreshLocal) params.set('refresh_local', 'true');
        else if (this._datasetDiagQueryKey === request.key && this._datasetDiagPayloadRevision) {
          params.set('known_revision', this._datasetDiagPayloadRevision);
        }
        const diagUrl = '/api/monitor/dataset-diagnostics?' + params.toString();
        const resp = await fetch(window.animaUrl(diagUrl), {
          cache: 'no-store', signal: request.controller.signal,
        });
        const body = await resp.json();
        if (!isCurrent()) return;
        this._datasetDiagLoaded = true;
        if (!resp.ok || body.status !== 'success' || !body.data) {
          const hasDetail = Boolean(body?.error_code || body?.errorCode || body?.data?.errorCode || body?.message);
          const nextErr = hasDetail
            ? (this.localizeApiError?.(body, 'monitor.ddLoadFailed') || 'loadFailed')
            : 'loadFailed';
          repaint ||= this.datasetDiagError !== nextErr;
          this.datasetDiagError = nextErr;
          return;
        }

        const data = body.data;
        repaint ||= !!this.datasetDiagError;
        this.datasetDiagError = '';
        if (data.unchanged) {
          if (options.refreshLocal && (this.datasetDiagModalOpen || this._datasetDiagModalOpening)) {
            void this.loadDatasetDiagImageDetail(this.datasetDiagModalImageId, true, false);
          }
          return;
        }

        const runId = String(data.run_id || request.runId || '');
        const prevData = this.datasetDiagData;
        const segmentChanged = this.datasetDiagRunId !== runId;
        const sameEffectiveFallback = !segmentChanged
          && prevData?.available
          && prevData.reg_mode === data.reg_mode
          && this.datasetDiagMinCount === request.minCount
          && this._datasetDiagRequestedRunId === request.runId;
        const queryChanged = this._datasetDiagQueryKey !== request.key && !sameEffectiveFallback;
        const slopeModeChanged = !!(prevData?.available && (!!prevData.summary?.has_slope !== !!data.summary?.has_slope));
        const updatedIds = (!segmentChanged && !queryChanged)
          ? this._collectDatasetDiagUpdatedIds(prevData, data, runId)
          : null;
        this.datasetDiagRunId = runId;
        this._datasetDiagRequestedRunId = request.runId;
        this.datasetDiagMinCount = request.minCount;
        this._datasetDiagPayloadRevision = String(data.revision || '');
        this.datasetDiagData = data;
        this.datasetDiagEffectiveRegMode = ['exclude', 'only', 'all'].includes(data.reg_mode) ? data.reg_mode : '';
        this._datasetDiagQueryKey = request.key;
        this._datasetDiagUpdatedIds = updatedIds;
        if (updatedIds?.size) this._datasetDiagUpdatePulseSeq++;
        this._datasetDiagSnapshotVersion++;
        this._datasetDiagDetailCache?.clear();
        this._datasetDiagLightCacheKeys?.clear();
        this._datasetDiagContextFilterCache = null;
        this._datasetDiagImageFilterCache = null;
        this._datasetDiagFolderLabelsCache = null;
        this._datasetDiagGroupedCache = null;
        repaint = true;
        if (segmentChanged) {
          this.datasetDiagGroupFilter = null;
          this.datasetDiagResoSort = 'order';
          this.datasetDiagGroupExpanded = {};
          this.datasetDiagCollapsedDims = {};
          this._datasetDiagHoverPreview = null;
        }
        if (segmentChanged || queryChanged || slopeModeChanged) {
          this.datasetDiagScatterZoom = null;
        }
        if (segmentChanged || queryChanged) this.datasetDiagDisplayLimit = 120;
        this._applyDatasetDiagDefaults(JSON.stringify([source.key, runId]), data);

        if ((this.datasetDiagModalOpen || this._datasetDiagModalOpening) && this.datasetDiagModalImageId) {
          const imageId = this.datasetDiagModalImageId;
          if (segmentChanged || !data.by_image?.some(image => image.image_id === imageId)) {
            this.closeDatasetDiagModal();
          } else {
            void this.loadDatasetDiagImageDetail(imageId, true, false);
          }
        }
      } catch (_) {
        if (!isCurrent()) return;
        this._datasetDiagLoaded = true;
        repaint ||= this.datasetDiagError !== 'loadFailed';
        this.datasetDiagError = 'loadFailed';
      } finally {
        if (this._datasetDiagRequest?.controller === request.controller) {
          this._datasetDiagRequest = null;
          this.datasetDiagLoading = false;
          if (repaint || this._datasetDiagSource().key !== source.key) this.renderDashboard?.();
          this._syncDatasetDiagPolling();
        }
      }
    },

    _collectDatasetDiagUpdatedIds(prevData, nextData, runId) {
      if (!prevData?.available || !nextData?.available) return null;
      if (String(prevData.run_id || '') !== String(runId || '')) return null;
      const prevTotals = new Map();
      for (const img of prevData.by_image || []) {
        if (!img?.image_id) continue;
        prevTotals.set(img.image_id, (img.count || 0) + (img.non_finite_count || 0));
      }
      const updated = new Set();
      for (const img of nextData.by_image || []) {
        if (!img?.image_id) continue;
        const total = (img.count || 0) + (img.non_finite_count || 0);
        const prev = prevTotals.get(img.image_id);
        if (prev === undefined || total > prev) updated.add(img.image_id);
      }
      return updated;
    },

    _applyDatasetDiagDefaults(sourceKey, data) {
      if (!data || !data.available) return;
      const summary = data.summary || {};
      const counts = summary.counts || {};
      const newSegment = this._datasetDiagPresetInitializedFor !== sourceKey;
      if (newSegment) {
        this._datasetDiagPresetInitializedFor = sourceKey;
        this.datasetDiagPreset = 'all';
        this.datasetDiagScatterZoom = null;
        this.datasetDiagCollapsedFolders = {};
        this._datasetDiagHoverPreview = null;
      } else if (this.datasetDiagPreset === 'non_finite' && !(counts.non_finite > 0)) {
        this.datasetDiagPreset = 'all';
      } else if (this.datasetDiagPreset === 'unqualified' && !((counts.insufficient || 0) + (counts.insufficient_reference || 0) > 0)) {
        this.datasetDiagPreset = 'all';
      }
      if (this.datasetDiagSubTab !== 'images') {
        this.datasetDiagSubTab = 'overview';
      }
    },

    setDatasetDiagRunId(value) {
      const next = String(value || '');
      if (this.datasetDiagRunId === next && !this._datasetDiagRequest) return;
      this._cancelDatasetDiagPreviewFetch?.();
      this.datasetDiagScatterZoom = null;
      return this.loadDatasetDiagnostics({ runId: next });
    },

    setDatasetDiagMinCount(value) {
      const next = Math.max(1, Math.min(100, Math.round(Number(value) || 3)));
      if (this.datasetDiagMinCount === next && !this._datasetDiagRequest) return;
      this._cancelDatasetDiagPreviewFetch?.();
      this.datasetDiagScatterZoom = null;
      return this.loadDatasetDiagnostics({ minCount: next });
    },

    setDatasetDiagSubTab(tab) {
      if (!['overview', 'images'].includes(tab)) return;
      const changed = this.datasetDiagSubTab !== tab;
      this.datasetDiagSubTab = tab;
      if (tab === 'images') {
        this._cancelDatasetDiagPreviewFetch?.();
        this._datasetDiagHoverPreview = null;
      } else if (tab === 'overview' && this.datasetDiagSearch) {
        this.datasetDiagSearch = '';
        this._datasetDiagContextFilterCache = null;
        this._datasetDiagImageFilterCache = null;
      }
      if (changed) this.renderDashboard?.();
    },

    openDatasetDiagPreset(preset) {
      if (!['all', 'attention', 'learning', 'normal', 'easy', 'non_finite', 'unqualified', 'insufficient', 'insufficient_reference'].includes(preset)) return;
      this._cancelDatasetDiagPreviewClear?.();
      this._cancelDatasetDiagPreviewFetch?.();
      this._datasetDiagHoverPreview = null;
      this.datasetDiagSubTab = 'images';
      this.datasetDiagDisplayLimit = 120;
      if (this.datasetDiagPreset !== preset) {
        this.datasetDiagPreset = preset;
        if (preset === 'easy' && this.datasetDiagSort === 'residual_desc') {
          this.datasetDiagSort = 'residual_asc';
        } else if (preset !== 'easy' && this.datasetDiagSort === 'residual_asc') {
          this.datasetDiagSort = 'residual_desc';
        }
      }
      if (preset !== 'all' && this.datasetDiagGroupFilter && !this._datasetDiagFilteredImages().length) {
        const regMode = this._datasetDiagEffectiveRegMode();
        const hasInRegScope = (this.datasetDiagData?.by_image || []).some(img => {
          if (regMode === 'exclude' && img?.is_reg === true) return false;
          if (regMode === 'only' && img?.is_reg !== true) return false;
          return this._datasetDiagImageMatchesPreset(img, preset);
        });
        if (hasInRegScope) this.datasetDiagGroupFilter = null;
      }
      this.renderDashboard?.();
    },

    toggleDatasetDiagOverviewPreset(preset) {
      if (!['all', 'attention', 'learning', 'normal', 'easy', 'non_finite', 'unqualified', 'insufficient', 'insufficient_reference'].includes(preset)) return;
      const next = this.datasetDiagPreset === preset ? 'all' : preset;
      this.datasetDiagPreset = next;
      this.datasetDiagDisplayLimit = 120;
      if (next === 'easy' && this.datasetDiagSort === 'residual_desc') {
        this.datasetDiagSort = 'residual_asc';
      } else if (next !== 'easy' && this.datasetDiagSort === 'residual_asc') {
        this.datasetDiagSort = 'residual_desc';
      }
      if (next !== 'all' && this.datasetDiagGroupFilter && !this._datasetDiagFilteredImages().length) {
        this.datasetDiagGroupFilter = null;
      }
      this._cancelDatasetDiagPreviewClear?.();
      this._cancelDatasetDiagPreviewFetch?.();
      this._datasetDiagHoverPreview = null;
      this.renderDashboard?.();
    },

    openDatasetDiagFilteredImages() {
      this._cancelDatasetDiagPreviewClear?.();
      this._cancelDatasetDiagPreviewFetch?.();
      this._datasetDiagHoverPreview = null;
      this.datasetDiagSubTab = 'images';
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    toggleDatasetDiagGroupSort() {
      this.datasetDiagResoSort = this.datasetDiagResoSort === 'residual' ? 'order' : 'residual';
      if (typeof this._rerenderDatasetDiagGroups === 'function' && this._rerenderDatasetDiagGroups()) {
        return;
      }
      this.renderDashboard?.();
    },

    toggleDatasetDiagGroupFold(dim) {
      if (!dim) return;
      const expanded = !(this.datasetDiagGroupExpanded && this.datasetDiagGroupExpanded[dim]);
      this.datasetDiagGroupExpanded = { ...(this.datasetDiagGroupExpanded || {}), [dim]: expanded };
      const panel = globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const foldEl = panel?.querySelector?.(`[data-dd-group-fold="${dim}"]`);
      const btnEl = panel?.querySelector?.(`[data-dd-group-fold-btn="${dim}"]`);
      if (foldEl && btnEl) {
        foldEl.classList?.toggle('is-open', expanded);
        const hiddenCount = Number(btnEl.dataset?.ddFoldCount || 0);
        const t = (k, fb) => (typeof this.tMonitor === 'function' ? this.tMonitor(k, fb) : k);
        btnEl.setAttribute('aria-expanded', String(expanded));
        btnEl.textContent = expanded
          ? t('ddGroupFoldCollapse')
          : t('ddGroupFoldExpand').replace('{n}', hiddenCount);
        return;
      }
      this.renderDashboard?.();
    },

    toggleDatasetDiagGroupDim(dim) {
      const key = String(dim || '');
      if (!key) return;
      const collapsed = !(this.datasetDiagCollapsedDims && this.datasetDiagCollapsedDims[key]);
      const next = { ...(this.datasetDiagCollapsedDims || {}) };
      if (collapsed) next[key] = true;
      else delete next[key];
      this.datasetDiagCollapsedDims = next;
      if (collapsed && this._datasetDiagHoverPreview?.kind === 'group' && this._datasetDiagHoverPreview.dim === key) {
        this.clearDatasetDiagPreview?.();
      }
      const panel = globalThis.document?.querySelector?.('.m-tab-panel[data-tab="dataset"]');
      const blockEl = panel?.querySelector?.(`[data-dd-group-dim="${key}"]`);
      const toggleEl = blockEl?.querySelector?.('[data-dd-group-dim-toggle]');
      const bodyEl = blockEl?.querySelector?.('[data-dd-group-dim-body]');
      if (blockEl && toggleEl && bodyEl) {
        blockEl.classList?.toggle?.('is-collapsed', collapsed);
        toggleEl.setAttribute?.('aria-expanded', String(!collapsed));
        bodyEl.inert = collapsed;
        return;
      }
      this.renderDashboard?.();
    },

    toggleDatasetDiagGroupFilter(dim, key, label) {
      const cur = this.datasetDiagGroupFilter;
      const selected = !(cur && cur.dim === dim && cur.key === key);
      this.datasetDiagGroupFilter = selected ? { dim, key, label: label || key } : null;
      if (selected) {
        if (this.datasetDiagCollapsedDims?.[dim]) {
          const next = { ...this.datasetDiagCollapsedDims };
          delete next[dim];
          this.datasetDiagCollapsedDims = next;
        }
        if (!this._datasetDiagFilteredImages().length && this._datasetDiagContextImages().length) {
          this.datasetDiagPreset = 'all';
        }
      }
      this._cancelDatasetDiagPreviewClear?.();
      this._cancelDatasetDiagPreviewFetch?.();
      this._datasetDiagHoverPreview = null;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    openDatasetDiagGroupFilter(dim, key, label) {
      if (!dim || key == null || key === '') return;
      this.datasetDiagGroupFilter = { dim, key, label: label || key };
      if (!this._datasetDiagFilteredImages().length && this._datasetDiagContextImages().length) {
        this.datasetDiagPreset = 'all';
      }
      this._cancelDatasetDiagPreviewClear?.();
      this._cancelDatasetDiagPreviewFetch?.();
      this._datasetDiagHoverPreview = null;
      this.datasetDiagSubTab = 'images';
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    selectDatasetDiagNotableGroup(dim, key, label) {
      const cur = this.datasetDiagGroupFilter;
      const selected = !(cur && cur.dim === dim && cur.key === key);
      this.datasetDiagGroupFilter = selected ? { dim, key, label: label || key } : null;
      if (selected) {
        if (this.datasetDiagCollapsedDims?.[dim]) {
          const next = { ...this.datasetDiagCollapsedDims };
          delete next[dim];
          this.datasetDiagCollapsedDims = next;
        }
        if (!this._datasetDiagFilteredImages().length && this._datasetDiagContextImages().length) {
          this.datasetDiagPreset = 'all';
        }
        this.datasetDiagSubTab = 'images';
      }
      this._cancelDatasetDiagPreviewClear?.();
      this._cancelDatasetDiagPreviewFetch?.();
      this._datasetDiagHoverPreview = null;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    clearDatasetDiagGroupFilter() {
      if (!this.datasetDiagGroupFilter) return;
      this.datasetDiagGroupFilter = null;
      this._cancelDatasetDiagPreviewClear?.();
      this._cancelDatasetDiagPreviewFetch?.();
      this._datasetDiagHoverPreview = null;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    setDatasetDiagPreset(preset) {
      if (!['all', 'attention', 'learning', 'normal', 'easy', 'non_finite', 'unqualified', 'insufficient', 'insufficient_reference'].includes(preset)) return;
      if (this.datasetDiagPreset === preset) return;
      this.datasetDiagPreset = preset;
      this.datasetDiagDisplayLimit = 120;
      if (preset === 'easy' && this.datasetDiagSort === 'residual_desc') {
        this.datasetDiagSort = 'residual_asc';
      } else if (preset !== 'easy' && this.datasetDiagSort === 'residual_asc') {
        this.datasetDiagSort = 'residual_desc';
      }
      if (preset !== 'all' && this._datasetDiagHoverPreview?.kind !== 'image') {
        this._cancelDatasetDiagPreviewClear?.();
        this._cancelDatasetDiagPreviewFetch?.();
        this._datasetDiagHoverPreview = null;
      }
      this.renderDashboard?.();
    },

    toggleDatasetDiagZonePreset(preset) {
      if (!['attention', 'learning'].includes(preset)) return;
      this.toggleDatasetDiagOverviewPreset(preset);
    },

    _datasetDiagSelectionLocked() {
      return (this.datasetDiagPreset || 'all') !== 'all'
        || !!this.datasetDiagGroupFilter
        || !!String(this.datasetDiagSearch || '').trim();
    },

    _ddSameHoverPreview(a, b) {
      if (a === b) return true;
      if (!a || !b || a.kind !== b.kind) return false;
      if (a.kind === 'preset') return a.preset === b.preset;
      if (a.kind === 'group') return a.dim === b.dim && a.key === b.key;
      if (a.kind === 'image') return a.imageId === b.imageId;
      return false;
    },

    _cancelDatasetDiagPreviewClear() {
      if (this._datasetDiagPreviewClearTimer) {
        clearTimeout(this._datasetDiagPreviewClearTimer);
        this._datasetDiagPreviewClearTimer = null;
      }
    },

    scheduleDatasetDiagPreviewClear(delay = 90) {
      this._cancelDatasetDiagPreviewClear();
      if (!this._datasetDiagHoverPreview) return;
      this._datasetDiagPreviewClearTimer = setTimeout(() => {
        this._datasetDiagPreviewClearTimer = null;
        this.clearDatasetDiagPreview();
      }, delay);
    },

    previewDatasetDiagStatus(preset) {
      this._cancelDatasetDiagPreviewClear();
      if (!preset || Date.now() < (this._datasetDiagSideScrollingUntil || 0)) return;
      if (this._datasetDiagSelectionLocked()) return;
      const next = { kind: 'preset', preset };
      if (this._ddSameHoverPreview(this._datasetDiagHoverPreview, next)) return;
      this._cancelDatasetDiagPreviewFetch();
      this._datasetDiagHoverPreview = next;
      this._syncDatasetDiagScatterFilter?.(null, { skipReorder: true });
      this._syncDatasetDiagNoiseOverlay?.();
      this._syncDatasetDiagStatusHighlight?.();
    },

    previewDatasetDiagGroup(dim, key) {
      this._cancelDatasetDiagPreviewClear();
      if (!dim || key == null || Date.now() < (this._datasetDiagSideScrollingUntil || 0)) return;
      if (this._datasetDiagSelectionLocked()) return;
      const next = { kind: 'group', dim, key };
      if (this._ddSameHoverPreview(this._datasetDiagHoverPreview, next)) return;
      this._cancelDatasetDiagPreviewFetch();
      this._datasetDiagHoverPreview = next;
      this._syncDatasetDiagScatterFilter?.(null, { skipReorder: true });
      this._syncDatasetDiagNoiseOverlay?.();
      this._syncDatasetDiagStatusHighlight?.();
    },

    previewDatasetDiagImage(imageId) {
      this._cancelDatasetDiagPreviewClear();
      if (!imageId || Date.now() < (this._datasetDiagSideScrollingUntil || 0)) return;
      const next = { kind: 'image', imageId };
      if (this._ddSameHoverPreview(this._datasetDiagHoverPreview, next)) return;
      this._datasetDiagHoverPreview = next;
      this._syncDatasetDiagScatterFilter?.(null, { skipReorder: true });
      this._prefetchDatasetDiagPreviewDetail(imageId);
      this._syncDatasetDiagNoiseOverlay?.();
      this._syncDatasetDiagScatterTrajectory?.();
      this._syncDatasetDiagStatusHighlight?.();
    },

    clearDatasetDiagPreview() {
      this._cancelDatasetDiagPreviewClear();
      this._cancelDatasetDiagPreviewFetch();
      if (!this._datasetDiagHoverPreview) return;
      this._datasetDiagHoverPreview = null;
      this._syncDatasetDiagScatterFilter?.(null, { skipReorder: true });
      this._syncDatasetDiagNoiseOverlay?.();
      this._syncDatasetDiagScatterTrajectory?.();
      this._syncDatasetDiagStatusHighlight?.();
    },

    setDatasetDiagScatterZoom(zoom, options = {}) {
      let next = null;
      if (zoom && Number.isFinite(zoom.xMin) && Number.isFinite(zoom.xMax)) {
        const MIN_X = 0.001;
        const MIN_Y = 0.0005;
        let xMin = Math.min(zoom.xMin, zoom.xMax);
        let xMax = Math.max(zoom.xMin, zoom.xMax);
        if (xMax - xMin < MIN_X) {
          const cx = (xMin + xMax) / 2;
          xMin = cx - MIN_X / 2;
          xMax = cx + MIN_X / 2;
        }
        if (Number.isFinite(zoom.yMin) && Number.isFinite(zoom.yMax)) {
          let yMin = Math.min(zoom.yMin, zoom.yMax);
          let yMax = Math.max(zoom.yMin, zoom.yMax);
          if (yMax - yMin < MIN_Y) {
            const cy = (yMin + yMax) / 2;
            yMin = cy - MIN_Y / 2;
            yMax = cy + MIN_Y / 2;
          }
          next = { xMin, xMax, yMin, yMax };
        } else {
          next = { xMin, xMax };
        }
      }
      if (JSON.stringify(this.datasetDiagScatterZoom || null) === JSON.stringify(next)) return;
      this.datasetDiagScatterZoom = next;
      const rerenderOpts = { animate: options?.animate !== false };
      if (options?.durationMs != null) rerenderOpts.durationMs = options.durationMs;
      if (options?.cameraMode) rerenderOpts.cameraMode = options.cameraMode;
      this._rerenderDatasetDiagScatter?.(rerenderOpts);
    },

    resetDatasetDiagScatterZoom() {
      if (!this.datasetDiagScatterZoom) return;
      this.datasetDiagScatterZoom = null;
      this._rerenderDatasetDiagScatter?.({ animate: true });
    },

    setDatasetDiagShowZones(enabled) {
      const next = Boolean(enabled);
      if (this.datasetDiagShowZones === next) return;
      this.datasetDiagShowZones = next;
      writeStoredShowZones(next);
      this._syncDatasetDiagZonesVisibility?.();
    },

    setDatasetDiagSearch(value) {
      const next = String(value || '');
      if (this.datasetDiagSearch === next) return;
      this.datasetDiagSearch = next;
      this._datasetDiagImageFilterCache = null;
      this._datasetDiagHoverPreview = null;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    setDatasetDiagRegMode(mode) {
      if (
        !['exclude', 'only', 'all'].includes(mode)
        || (this.datasetDiagRegMode === mode && (!this.datasetDiagEffectiveRegMode || this.datasetDiagEffectiveRegMode === mode))
      ) return;
      this.datasetDiagRegMode = mode;
      this.datasetDiagEffectiveRegMode = '';
      writeStoredRegMode(mode);
      this._datasetDiagContextFilterCache = null;
      this._datasetDiagImageFilterCache = null;
      this._datasetDiagGroupedCache = null;
      this._datasetDiagHoverPreview = null;
      this.datasetDiagDisplayLimit = 120;
      this.datasetDiagScatterZoom = null;
      this._cancelDatasetDiagPreviewFetch?.();
      if ((this._datasetDiagLoaded || this._datasetDiagRequest) && this._datasetDiagSource().key && this._datasetDiagHasRegImages()) {
        void this.loadDatasetDiagnostics({ regMode: mode });
        return;
      }
      this.renderDashboard?.();
    },

    setDatasetDiagSort(sortKey) {
      if (!sortKey || this.datasetDiagSort === sortKey) return;
      this.datasetDiagSort = sortKey;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    toggleDatasetDiagColumnSort(column) {
      const pairs = {
        residual: ['residual_desc', 'residual_asc'],
        slope: ['slope_desc', 'slope_asc'],
        loss: ['loss_desc', 'loss_asc'],
        count: ['count_desc', 'count_asc'],
        name: ['name_asc', 'name_desc'],
      };
      const pair = pairs[column];
      if (!pair) return;
      this.setDatasetDiagSort(this.datasetDiagSort === pair[0] ? pair[1] : pair[0]);
    },

    setDatasetDiagViewMode(mode) {
      if (!['grid', 'table'].includes(mode) || this.datasetDiagViewMode === mode) return;
      this.datasetDiagViewMode = mode;
      writeStoredViewMode(mode);
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    setDatasetDiagGroupByFolder(enabled) {
      const next = Boolean(enabled);
      if (this.datasetDiagGroupByFolder === next) return;
      this.datasetDiagGroupByFolder = next;
      writeStoredGroupByFolder(next);
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    toggleDatasetDiagGroupByFolder() {
      this.setDatasetDiagGroupByFolder(!this.datasetDiagGroupByFolder);
    },

    toggleDatasetDiagFolderCollapsed(dirKey) {
      const key = String(dirKey || '');
      if (!key) return;
      const next = { ...(this.datasetDiagCollapsedFolders || {}) };
      if (next[key]) delete next[key];
      else next[key] = true;
      this.datasetDiagCollapsedFolders = next;
      if (!this._patchDatasetDiagFolderToggle?.(key)) {
        this.renderDashboard?.();
      }
    },

    showMoreDatasetDiagImages() {
      this.datasetDiagDisplayLimit = (this.datasetDiagDisplayLimit || 120) + 120;
      this.renderDashboard?.();
    },

    resetDatasetDiagFilters() {
      this._cancelDatasetDiagPreviewFetch?.();
      this.datasetDiagPreset = 'all';
      this.datasetDiagGroupFilter = null;
      this.datasetDiagSearch = '';
      this._datasetDiagImageFilterCache = null;
      this._datasetDiagHoverPreview = null;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    _datasetDiagHasActiveFilter() {
      return (this.datasetDiagPreset || 'all') !== 'all'
        || !!this.datasetDiagGroupFilter
        || !!String(this.datasetDiagSearch || '').trim();
    },

    _datasetDiagHasRegImages(data = this.datasetDiagData) {
      if (!data || !data.available) return false;
      if (typeof data.summary?.has_reg_images === 'boolean') return data.summary.has_reg_images;
      return Array.isArray(data.by_image) && data.by_image.some(img => img?.is_reg === true);
    },

    _datasetDiagEffectiveRegMode(data = this.datasetDiagData) {
      if (!this._datasetDiagHasRegImages(data)) return 'all';
      if (data === this.datasetDiagData && ['exclude', 'only', 'all'].includes(this.datasetDiagEffectiveRegMode)) {
        return this.datasetDiagEffectiveRegMode;
      }
      const mode = this.datasetDiagRegMode;
      return ['exclude', 'only', 'all'].includes(mode) ? mode : 'exclude';
    },

    _datasetDiagContextImages(options = {}) {
      const data = this.datasetDiagData;
      if (!data || !data.available || !Array.isArray(data.by_image)) return [];
      const gf = this.datasetDiagGroupFilter;
      const query = String(this.datasetDiagSearch || '').trim().toLowerCase();
      const ignoreReg = Boolean(options && options.ignoreReg);
      const regMode = ignoreReg ? 'all' : this._datasetDiagEffectiveRegMode(data);
      const ctxKey = JSON.stringify([gf?.dim, gf?.key, query, regMode]);
      const cached = this._datasetDiagContextFilterCache;
      if (cached?.data === data && cached.key === ctxKey) return cached.rows;

      const list = data.by_image.filter(img => {
        if (gf) {
          if (gf.dim === 'resolution' && !(img.resolutions || [img.resolution]).includes(gf.key)) return false;
          if (gf.dim === 'subset' && !(img.subsets || [img.subset]).includes(gf.key)) return false;
          if (gf.dim === 'directory' && (img.directory || '(root)') !== gf.key) return false;
        }
        if (regMode === 'exclude' && img.is_reg === true) return false;
        if (regMode === 'only' && img.is_reg !== true) return false;
        if (query) {
          const hay = (img.name + ' ' + img.image + ' ' + img.subset_label).toLowerCase();
          if (!hay.includes(query)) return false;
        }
        return true;
      });
      this._datasetDiagContextFilterCache = { data, key: ctxKey, rows: list };
      return this._datasetDiagContextFilterCache.rows;
    },

    _datasetDiagStatusCounts() {
      const rows = this._datasetDiagContextImages();
      const counts = {
        all: rows.length,
        attention: 0,
        learning: 0,
        easy: 0,
        non_finite: 0,
        unqualified: 0,
        normal: 0,
      };
      for (const img of rows) {
        if ((img.non_finite_count || 0) > 0 || img.status === 'non_finite') counts.non_finite++;
        if (img.status === 'attention') counts.attention++;
        else if (img.status === 'learning') counts.learning++;
        else if (img.status === 'easy') counts.easy++;
        else if (img.status === 'insufficient' || img.status === 'insufficient_reference') counts.unqualified++;
        else if (img.status === 'normal') counts.normal++;
      }
      return counts;
    },

    _datasetDiagImageMatchesPreset(img, preset) {
      const p = preset || 'all';
      if (p === 'all') return true;
      if (!img) return false;
      if (p === 'non_finite') return (img.non_finite_count || 0) > 0 || img.status === 'non_finite';
      if (p === 'unqualified') return img.status === 'insufficient' || img.status === 'insufficient_reference';
      return img.status === p;
    },

    _ddStatusBreakdown(data) {
      const images = Array.isArray(data?.by_image) ? data.by_image : [];
      const keys = ['non_finite', 'attention', 'learning', 'normal', 'easy', 'unqualified'];
      const counts = {};
      const buckets = {};
      for (const k of keys) {
        counts[k] = 0;
        buckets[k] = {
          count: 0,
          imgPct: 0,
          samples: 0,
          trainPct: 0,
          regCount: 0,
          nanCount: 0,
          residualSum: 0,
          residualWeight: 0,
          slopeSum: 0,
          slopeCount: 0,
          meanResidual: null,
          meanSlope: null,
        };
      }
      let totalSamples = 0;
      for (const img of images) {
        if (!img) continue;
        let bucketKey = 'normal';
        if ((img.non_finite_count || 0) > 0 || img.status === 'non_finite') bucketKey = 'non_finite';
        else if (img.status === 'attention') bucketKey = 'attention';
        else if (img.status === 'learning') bucketKey = 'learning';
        else if (img.status === 'easy') bucketKey = 'easy';
        else if (img.status === 'insufficient' || img.status === 'insufficient_reference') bucketKey = 'unqualified';

        counts[bucketKey]++;
        const b = buckets[bucketKey];
        b.count++;

        const finiteSamples = Math.max(0, Number(img.count) || 0);
        const nanHits = Math.max(0, Number(img.non_finite_count) || 0);
        const appCount = finiteSamples + nanHits;
        b.samples += appCount;
        totalSamples += appCount;
        b.nanCount += nanHits;
        if (img.is_reg) b.regCount++;

        if (img.mean_residual != null && Number.isFinite(Number(img.mean_residual))) {
          const w = Math.max(1, Number(img.comparable_count) || finiteSamples || 1);
          b.residualSum += Number(img.mean_residual) * w;
          b.residualWeight += w;
        }
        if (img.slope != null && Number.isFinite(Number(img.slope))) {
          b.slopeSum += Number(img.slope);
          b.slopeCount += 1;
        }
      }

      const total = images.length;
      let hasSkew = false;
      let anyReg = Boolean(data?.summary?.has_reg_images);
      for (const k of keys) {
        const b = buckets[k];
        b.imgPct = total > 0 ? Math.round((b.count / total) * 100) : 0;
        b.trainPct = totalSamples > 0 ? Math.round((b.samples / totalSamples) * 100) : b.imgPct;
        b.meanResidual = b.residualWeight > 0 ? (b.residualSum / b.residualWeight) : null;
        b.meanSlope = b.slopeCount > 0 ? (b.slopeSum / b.slopeCount) : null;
        if (b.regCount > 0) anyReg = true;
        if (b.count > 0 && totalSamples > 0 && Math.abs(b.trainPct - b.imgPct) >= 5) hasSkew = true;
      }
      const showTrainShare = totalSamples > 0 && (hasSkew || anyReg);
      return { total, totalSamples, counts, buckets, showTrainShare };
    },

    _datasetDiagFilteredImages(options = {}) {
      const data = this.datasetDiagData;
      if (!data || !data.available || !Array.isArray(data.by_image)) return [];
      const preset = this.datasetDiagPreset || 'all';
      const gf = this.datasetDiagGroupFilter;
      const query = String(this.datasetDiagSearch || '').trim().toLowerCase();
      const ignoreReg = Boolean(options && options.ignoreReg);
      const regMode = ignoreReg ? 'all' : this._datasetDiagEffectiveRegMode(data);
      const sortKey = this.datasetDiagSort || 'residual_desc';
      const filterKey = JSON.stringify([preset, gf?.dim, gf?.key, query, regMode, sortKey]);
      const cached = this._datasetDiagImageFilterCache;
      if (cached?.data === data && cached.key === filterKey) return cached.rows;

      const list = this._datasetDiagContextImages({ ignoreReg }).filter(img => this._datasetDiagImageMatchesPreset(img, preset));

      const numOr = (v, fb) => (v != null && Number.isFinite(Number(v))) ? Number(v) : fb;
      list.sort((a, b) => {
        if (sortKey === 'residual_asc') return numOr(a.mean_residual, 1e9) - numOr(b.mean_residual, 1e9);
        if (sortKey === 'slope_desc') return numOr(b.slope, -1e9) - numOr(a.slope, -1e9);
        if (sortKey === 'slope_asc') return numOr(a.slope, 1e9) - numOr(b.slope, 1e9);
        if (sortKey === 'loss_desc') return numOr(b.mean_loss, -1e9) - numOr(a.mean_loss, -1e9);
        if (sortKey === 'loss_asc') return numOr(a.mean_loss, 1e9) - numOr(b.mean_loss, 1e9);
        if (sortKey === 'count_desc') return (b.count - a.count) || (numOr(b.mean_residual, -1e9) - numOr(a.mean_residual, -1e9));
        if (sortKey === 'count_asc') return (a.count - b.count) || (numOr(b.mean_residual, -1e9) - numOr(a.mean_residual, -1e9));
        if (sortKey === 'name_asc') return String(a.name).localeCompare(String(b.name));
        if (sortKey === 'name_desc') return String(b.name).localeCompare(String(a.name));
        return ((b.non_finite_count || 0) > 0 ? 1 : 0) - ((a.non_finite_count || 0) > 0 ? 1 : 0)
          || numOr(b.mean_residual, -1e9) - numOr(a.mean_residual, -1e9);
      });
      this._datasetDiagImageFilterCache = { data, key: filterKey, rows: list };
      return this._datasetDiagImageFilterCache.rows;
    },

    _datasetDiagFilteredIdSet(options = {}) {
      return new Set(this._datasetDiagFilteredImages(options).map(img => img.image_id));
    },

    _datasetDiagHasMultipleFolders(data = this.datasetDiagData) {
      if (!data || !data.available) return false;
      if (Array.isArray(data.by_directory) && data.by_directory.length >= 2) return true;
      const dirs = new Set();
      for (const img of (data.by_image || [])) {
        if (!img) continue;
        dirs.add(img.directory || '(root)');
        if (dirs.size >= 2) return true;
      }
      return false;
    },

    _datasetDiagFolderLabels(data = this.datasetDiagData) {
      const cached = this._datasetDiagFolderLabelsCache;
      if (cached?.data === data) return cached.map;
      const dirInfo = new Map();
      const subsetDirs = new Map();
      const subsetLabelLookup = new Map();
      for (const sub of (data?.by_subset || [])) {
        if (sub?.key && sub.label) subsetLabelLookup.set(sub.key, sub.label);
      }
      for (const img of (data?.by_image || [])) {
        if (!img) continue;
        const dirKey = img.directory || '(root)';
        let info = dirInfo.get(dirKey);
        if (!info) {
          info = { dirLabel: img.dir_label || '', subsets: new Set(), subsetLabels: new Map(), total: 0, regCount: 0 };
          dirInfo.set(dirKey, info);
        }
        info.total += 1;
        if (img.is_reg === true) info.regCount += 1;
        if (!info.dirLabel && img.dir_label) info.dirLabel = img.dir_label;
        const subs = (Array.isArray(img.subsets) && img.subsets.length)
          ? img.subsets
          : (img.subset ? [img.subset] : []);
        for (const subKey of subs) {
          if (!subKey) continue;
          info.subsets.add(subKey);
          if (img.subset === subKey && img.subset_label) {
            info.subsetLabels.set(subKey, img.subset_label);
          } else if (!info.subsetLabels.has(subKey) && subsetLabelLookup.has(subKey)) {
            info.subsetLabels.set(subKey, subsetLabelLookup.get(subKey));
          }
          let ds = subsetDirs.get(subKey);
          if (!ds) {
            ds = new Set();
            subsetDirs.set(subKey, ds);
          }
          ds.add(dirKey);
        }
      }
      const result = new Map();
      for (const [dirKey, info] of dirInfo.entries()) {
        const validSubs = Array.from(info.subsets).filter(s => s && s !== '(unknown)');
        const useSubset = validSubs.length === 1 && (subsetDirs.get(validSubs[0])?.size || 0) === 1;
        const label = useSubset
          ? (info.subsetLabels.get(validSubs[0]) || info.dirLabel || dirKey)
          : (info.dirLabel || dirKey);
        result.set(dirKey, {
          label,
          fullPath: dirKey,
          isReg: info.total > 0 && info.regCount === info.total,
          total: info.total,
        });
      }
      this._datasetDiagFolderLabelsCache = { data, map: result };
      return result;
    },

    _datasetDiagGroupedImages(filteredList = null) {
      const data = this.datasetDiagData;
      const filtered = Array.isArray(filteredList) ? filteredList : this._datasetDiagFilteredImages();
      const sortKey = this.datasetDiagSort || 'residual_desc';
      const cached = this._datasetDiagGroupedCache;
      if (cached?.data === data && cached.rows === filtered && cached.sortKey === sortKey) {
        return cached.groups;
      }
      const metaMap = this._datasetDiagFolderLabels(data);
      const buckets = new Map();
      for (const img of filtered) {
        if (!img) continue;
        const key = img.directory || '(root)';
        let group = buckets.get(key);
        if (!group) {
          const meta = metaMap.get(key) || {
            label: img.dir_label || key,
            fullPath: key,
            isReg: img.is_reg === true,
            total: 0,
          };
          group = {
            key,
            label: meta.label,
            fullPath: meta.fullPath,
            isReg: meta.isReg,
            folderTotal: meta.total,
            items: [],
          };
          buckets.set(key, group);
        }
        group.items.push(img);
      }

      const groups = Array.from(buckets.values()).map(group => {
        let resSum = 0, resCnt = 0;
        let slopeSum = 0, slopeCnt = 0;
        let lossSum = 0, lossCnt = 0;
        let hasNan = false;
        let regInItems = 0;
        for (const item of group.items) {
          if ((item.non_finite_count || 0) > 0 || item.status === 'non_finite') hasNan = true;
          if (item.is_reg === true) regInItems += 1;
          const res = Number(item.mean_residual);
          if (item.mean_residual != null && Number.isFinite(res)) { resSum += res; resCnt += 1; }
          const slope = Number(item.slope);
          if (item.slope != null && Number.isFinite(slope)) { slopeSum += slope; slopeCnt += 1; }
          const loss = Number(item.mean_loss);
          if (item.mean_loss != null && Number.isFinite(loss)) { lossSum += loss; lossCnt += 1; }
        }
        return {
          ...group,
          isReg: group.isReg || (group.items.length > 0 && regInItems === group.items.length),
          totalCount: group.items.length,
          hasNan,
          meanResidual: resCnt ? (resSum / resCnt) : null,
          meanSlope: slopeCnt ? (slopeSum / slopeCnt) : null,
          meanLoss: lossCnt ? (lossSum / lossCnt) : null,
        };
      });

      const cmpDesc = (a, b) => (b == null ? -1e9 : b) - (a == null ? -1e9 : a);
      const cmpAsc = (a, b) => (a == null ? 1e9 : a) - (b == null ? 1e9 : b);
      groups.sort((a, b) => {
        if (sortKey === 'name_asc') return String(a.label).localeCompare(String(b.label)) || String(a.key).localeCompare(String(b.key));
        if (sortKey === 'name_desc') return String(b.label).localeCompare(String(a.label)) || String(b.key).localeCompare(String(a.key));
        if (sortKey === 'residual_asc') return cmpAsc(a.meanResidual, b.meanResidual) || String(a.label).localeCompare(String(b.label));
        if (sortKey === 'slope_desc') return cmpDesc(a.meanSlope, b.meanSlope) || cmpDesc(a.meanResidual, b.meanResidual);
        if (sortKey === 'slope_asc') return cmpAsc(a.meanSlope, b.meanSlope) || cmpAsc(a.meanResidual, b.meanResidual);
        if (sortKey === 'loss_desc') return cmpDesc(a.meanLoss, b.meanLoss) || cmpDesc(a.meanResidual, b.meanResidual);
        if (sortKey === 'loss_asc') return cmpAsc(a.meanLoss, b.meanLoss) || cmpAsc(a.meanResidual, b.meanResidual);
        if (sortKey === 'count_desc') return (b.totalCount - a.totalCount) || cmpDesc(a.meanResidual, b.meanResidual);
        if (sortKey === 'count_asc') return (a.totalCount - b.totalCount) || cmpDesc(a.meanResidual, b.meanResidual);
        return ((b.hasNan ? 1 : 0) - (a.hasNan ? 1 : 0))
          || cmpDesc(a.meanResidual, b.meanResidual)
          || String(a.label).localeCompare(String(b.label));
      });

      this._datasetDiagGroupedCache = { data, rows: filtered, sortKey, groups };
      return groups;
    },

    _datasetDiagDetailCacheKey(source, imageId) {
      const runId = this.datasetDiagRunId || this.datasetDiagData?.run_id || '';
      return JSON.stringify([
        source.key, runId, this.datasetDiagMinCount, this._datasetDiagEffectiveRegMode(),
        this._datasetDiagSnapshotVersion, imageId,
      ]);
    },

    // ── Modal Management ──────────────────────────────────────────────────────
    _datasetDiagDetailSignature(detail) {
      if (!detail) return '';
      const img = detail.image || {};
      const cap = detail.caption || {};
      const fi = detail.file_info || {};
      return [
        detail.revision ?? '',
        detail.samples_total ?? (detail.samples || []).length,
        img.mean_residual ?? '',
        img.slope ?? '',
        img.non_finite_count ?? 0,
        cap.exists ? '1' : '0',
        cap.text ?? '',
        fi.size ?? '',
        fi.width ?? '',
        fi.height ?? '',
      ].join('|');
    },

    openDatasetDiagModal(imageId, openerEl = null) {
      if (!imageId) return;
      this._unpinDatasetDiagScatterCard?.();
      this._cancelDatasetDiagNeighborPrefetch();
      if (this._datasetDiagOpenTimer) {
        clearTimeout(this._datasetDiagOpenTimer);
        this._datasetDiagOpenTimer = 0;
      }
      this._datasetDiagModalOpening = false;
      this.datasetDiagPageEditing = false;
      const source = this._datasetDiagSource();
      const cacheKey = this._datasetDiagDetailCacheKey(source, imageId);
      const cached = this._datasetDiagDetailCache?.get(cacheKey) || null;
      const hasFullCache = Boolean(cached && !this._datasetDiagLightCacheKeys?.has(cacheKey));
      const reopen = !this.datasetDiagModalOpen;
      this.datasetDiagSamplesModalOpen = false;
      this.datasetDiagSamplesFilter = 'all';
      this.datasetDiagModalImageId = imageId;
      this.datasetDiagModalDetail = hasFullCache ? cached : null;
      this.datasetDiagModalError = '';
      this.datasetDiagViewport.reset(false);
      const doc = globalThis.document;
      const dialog = doc?.getElementById?.('datasetDiagModal');

      if (reopen && !hasFullCache) {
        // Settle fast local detail fetches briefly (~90ms) so the dialog enters once with ready content.
        this._datasetDiagModalOpening = true;
        const detailPromise = this.loadDatasetDiagImageDetail(imageId, !hasFullCache);
        const commitOpen = () => {
          if (!this._datasetDiagModalOpening || this.datasetDiagModalImageId !== imageId) return;
          if (this._datasetDiagOpenTimer) {
            clearTimeout(this._datasetDiagOpenTimer);
            this._datasetDiagOpenTimer = 0;
          }
          this._datasetDiagModalOpening = false;
          if (dialog && openerEl) globalThis.window?.AnimaUI?.setDialogOrigin?.(dialog, openerEl);
          this.datasetDiagModalOpen = true;
          this._patchDatasetDiagModal?.();
          this._revealDatasetDiagModalAfterOpen();
        };
        this._datasetDiagOpenTimer = setTimeout(commitOpen, 90);
        Promise.resolve(detailPromise).finally(commitOpen);
        return;
      }

      if (reopen) {
        if (dialog && openerEl) globalThis.window?.AnimaUI?.setDialogOrigin?.(dialog, openerEl);
        this.datasetDiagModalOpen = true;
        this._patchDatasetDiagModal?.();
        this._revealDatasetDiagModalAfterOpen();
      } else {
        this.datasetDiagModalOpen = true;
        const resolvedOpener = openerEl || (() => {
          const openers = doc?.querySelectorAll?.('.m-dd-card[data-dd-image-id], .m-dd-table-row[data-dd-image-id]');
          return openers ? Array.from(openers).find(el => el.dataset?.ddImageId === String(imageId)) : null;
        })();
        if (dialog && resolvedOpener) globalThis.window?.AnimaUI?.setDialogOrigin?.(dialog, resolvedOpener);
        this._patchDatasetDiagModal?.();
      }
      void this.loadDatasetDiagImageDetail(imageId, reopen || !hasFullCache);
    },

    _revealDatasetDiagModalAfterOpen() {
      this._datasetDiagOpenObserver?.disconnect?.();
      this._datasetDiagOpenObserver = null;
      const dialog = globalThis.document?.getElementById?.('datasetDiagModal');
      if (!dialog) return;
      const onOpen = () => {
        if (!this.datasetDiagModalOpen || !dialog.isConnected || !dialog.open) return;
        this._datasetDiagOpenObserver?.disconnect?.();
        this._datasetDiagOpenObserver = null;
        this.datasetDiagViewport.constrain();
        const rightEl = globalThis.document?.getElementById?.('datasetDiagModalRight');
        if (rightEl && this.datasetDiagModalDetail) {
          this._bindDatasetDiagModalCharts?.(rightEl, this.datasetDiagModalDetail, (k, fb) => this.tMonitor(k, fb), { immediate: true });
        }
        if (this.datasetDiagModalDetail && this.datasetDiagModalImageId) {
          this._scheduleDatasetDiagNeighborPrefetch(this.datasetDiagModalImageId);
        }
      };
      if (dialog.open) {
        onOpen();
      } else if (typeof MutationObserver !== 'undefined') {
        this._datasetDiagOpenObserver = new MutationObserver(() => {
          if (dialog.open || !this.datasetDiagModalOpen) onOpen();
        });
        this._datasetDiagOpenObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
      }
    },

    closeDatasetDiagModal() {
      this._datasetDiagModalSeq++;
      this._datasetDiagModalController?.abort();
      this._datasetDiagModalController = null;
      if (this._datasetDiagOpenTimer) {
        clearTimeout(this._datasetDiagOpenTimer);
        this._datasetDiagOpenTimer = 0;
      }
      this._datasetDiagModalOpening = false;
      this._cancelDatasetDiagNeighborPrefetch();
      this._datasetDiagOpenObserver?.disconnect?.();
      this._datasetDiagOpenObserver = null;
      this.datasetDiagPageEditing = false;
      this.datasetDiagSamplesModalOpen = false;
      this.datasetDiagSamplesFilter = 'all';
      this.datasetDiagModalOpen = false;
      this.datasetDiagViewport.stopPan();
      this.datasetDiagViewport.cancelReset();
    },

    clearDatasetDiagModal() {
      if (this.datasetDiagModalOpen) return;
      if (this._datasetDiagOpenTimer) {
        clearTimeout(this._datasetDiagOpenTimer);
        this._datasetDiagOpenTimer = 0;
      }
      this._datasetDiagModalOpening = false;
      this._datasetDiagImgSeq = (this._datasetDiagImgSeq || 0) + 1;
      const stageImg = globalThis.document?.getElementById?.('datasetDiagModalImg');
      if (stageImg) {
        if (stageImg.dataset) delete stageImg.dataset.ddPendingFull;
        stageImg.removeAttribute?.('src');
      }
      const rightEl = globalThis.document?.getElementById?.('datasetDiagModalRight');
      if (rightEl) {
        (rightEl._ddModalROs || []).forEach(ro => ro.disconnect?.());
        rightEl._ddModalROs = [];
        rightEl._ddBindCtrl?.abort?.();
        rightEl._ddBindCtrl = null;
        rightEl._ddRenderedImageId = '';
        rightEl._ddWasPending = false;
        rightEl.innerHTML = '';
      }
      this.datasetDiagSamplesModalOpen = false;
      this.datasetDiagSamplesFilter = 'all';
      this.datasetDiagModalImageId = '';
      this.datasetDiagModalDetail = null;
      this.datasetDiagModalLoading = false;
      this.datasetDiagModalError = '';
      this.datasetDiagPageEditing = false;
      this.datasetDiagViewport.reset(false);
    },

    openDatasetDiagSamplesModal(filter = 'all') {
      if (!this.datasetDiagModalOpen || !this.datasetDiagModalDetail) return;
      const hasNan = Number(this.datasetDiagModalDetail.image?.non_finite_count || 0) > 0;
      this.datasetDiagSamplesFilter = (filter === 'nan' && hasNan) ? 'nan' : 'all';
      this.datasetDiagSamplesModalOpen = true;
      this._patchDatasetDiagSamplesModal?.(true);
    },

    setDatasetDiagSamplesFilter(mode) {
      const hasNan = Number(this.datasetDiagModalDetail?.image?.non_finite_count || 0) > 0;
      const filter = (mode === 'nan' && hasNan) ? 'nan' : 'all';
      const changed = this.datasetDiagSamplesFilter !== filter;
      this.datasetDiagSamplesFilter = filter;
      this._patchDatasetDiagSamplesModal?.(changed);
    },

    closeDatasetDiagSamplesModal() {
      this.datasetDiagSamplesModalOpen = false;
    },

    _datasetDiagModalNavList() {
      const filtered = this._datasetDiagFilteredImages();
      if (this.datasetDiagSubTab === 'images' && this.datasetDiagGroupByFolder && this._datasetDiagHasMultipleFolders?.()) {
        const groups = this._datasetDiagGroupedImages(filtered);
        const collapsed = this.datasetDiagCollapsedFolders || {};
        const ordered = [];
        for (const group of groups) {
          if (collapsed[group.key] && !group.items.some(item => item.image_id === this.datasetDiagModalImageId)) continue;
          for (const item of group.items) ordered.push(item);
        }
        if (ordered.length && (!this.datasetDiagModalImageId || ordered.some(item => item.image_id === this.datasetDiagModalImageId))) {
          return ordered;
        }
      }
      if (filtered.some(item => item.image_id === this.datasetDiagModalImageId)) return filtered;
      const contextRows = this._datasetDiagContextImages();
      if (contextRows.some(item => item.image_id === this.datasetDiagModalImageId)) return contextRows;
      return this.datasetDiagData?.by_image || [];
    },

    datasetDiagModalNav(delta) {
      const list = this._datasetDiagModalNavList();
      if (list.length <= 1) return;
      const idx = list.findIndex(item => item.image_id === this.datasetDiagModalImageId);
      if (idx < 0) return;
      const nextIdx = (idx + delta + list.length) % list.length;
      const target = list[nextIdx];
      if (target) this.openDatasetDiagModal(target.image_id);
    },

    _datasetDiagModalPagePosition(list = this._datasetDiagModalNavList()) {
      const idx = list.findIndex(item => item.image_id === this.datasetDiagModalImageId);
      return idx >= 0 ? idx + 1 : 0;
    },

    openDatasetDiagPageEditor() {
      const list = this._datasetDiagModalNavList();
      if (list.length <= 1) return;
      this.datasetDiagPageEditing = true;
      this.datasetDiagPageDraft = String(this._datasetDiagModalPagePosition(list) || 1);
      this._datasetDiagPageLastDraft = this.datasetDiagPageDraft;
      const focusInput = () => {
        if (!this.datasetDiagPageEditing) return;
        const input = globalThis.document?.getElementById?.('ddModalPageInput');
        if (input) { input.value = this.datasetDiagPageDraft; input.focus?.(); input.select?.(); }
      };
      if (typeof this.$nextTick === 'function') this.$nextTick(focusInput);
      else focusInput();
    },

    updateDatasetDiagPageDraft(event) {
      if (!this.datasetDiagPageEditing || event.isComposing) return;
      const input = event.currentTarget;
      const raw = String(input?.value ?? '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).trim();
      if (raw === '' || /^\d+$/.test(raw)) {
        this.datasetDiagPageDraft = raw;
        this._datasetDiagPageLastDraft = raw;
      }
      if (input) input.value = this._datasetDiagPageLastDraft;
    },

    commitDatasetDiagPageEdit(event) {
      if (!this.datasetDiagPageEditing) return false;
      const input = event?.currentTarget;
      const list = this._datasetDiagModalNavList();
      const raw = String(input?.value ?? this.datasetDiagPageDraft ?? '').replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).trim();
      const currentPos = this._datasetDiagModalPagePosition(list) || 1;
      const page = /^\d+$/.test(raw) && list.length
        ? Math.max(1, Math.min(list.length, Number(raw)))
        : currentPos;
      this.datasetDiagPageEditing = false;
      this.datasetDiagPageDraft = String(page);
      this._datasetDiagPageLastDraft = this.datasetDiagPageDraft;
      if (input) input.value = this.datasetDiagPageDraft;
      const target = list[page - 1];
      if (target && target.image_id !== this.datasetDiagModalImageId) {
        this.openDatasetDiagModal(target.image_id);
      }
      return true;
    },

    _restoreDatasetDiagModalFocus() {
      const dialog = globalThis.document?.getElementById?.('datasetDiagModal');
      if (!dialog || !this.datasetDiagModalOpen) return;
      const btn = globalThis.document?.getElementById?.('ddModalCounterDisplay');
      if (btn && !btn.disabled && btn.getClientRects?.().length) {
        btn.focus({ preventScroll: true });
        return;
      }
      dialog.querySelector?.('.m-dd-modal-window')?.focus?.({ preventScroll: true });
    },

    datasetDiagPageKeydown(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        this.commitDatasetDiagPageEdit(event);
        if (typeof this.$nextTick === 'function') this.$nextTick(() => this._restoreDatasetDiagModalFocus());
        else this._restoreDatasetDiagModalFocus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.datasetDiagPageEditing = false;
        if (typeof this.$nextTick === 'function') this.$nextTick(() => this._restoreDatasetDiagModalFocus());
        else this._restoreDatasetDiagModalFocus();
      }
    },

    jumpDatasetDiagModalToGroup(dim, key, label) {
      if (!dim || key == null || key === '') return;
      this.closeDatasetDiagModal();
      this.openDatasetDiagGroupFilter(dim, key, label);
    },

    _cancelDatasetDiagNeighborPrefetch() {
      if (this._datasetDiagNeighborPrefetchTimer) {
        clearTimeout(this._datasetDiagNeighborPrefetchTimer);
        this._datasetDiagNeighborPrefetchTimer = 0;
      }
      if (this._datasetDiagNeighborControllers) {
        for (const ctrl of this._datasetDiagNeighborControllers) {
          try { ctrl.abort(); } catch (_) {}
        }
        this._datasetDiagNeighborControllers = null;
      }
    },

    _scheduleDatasetDiagNeighborPrefetch(imageId) {
      this._cancelDatasetDiagNeighborPrefetch();
      const doc = globalThis.document;
      if (!doc || !doc.getElementById?.('datasetDiagModal')?.open || typeof fetch !== 'function') return;
      const source = this._datasetDiagSource();
      if (!source.key || !imageId) return;
      const list = this._datasetDiagModalNavList();
      if (!list || list.length <= 1) return;
      const idx = list.findIndex(item => item.image_id === imageId);
      if (idx < 0) return;
      const targets = [];
      for (const delta of [1, -1]) {
        const candidate = list[(idx + delta + list.length) % list.length];
        if (!candidate || candidate.image_id === imageId) continue;
        const key = this._datasetDiagDetailCacheKey(source, candidate.image_id);
        if (!this._datasetDiagDetailCache?.has(key) && !targets.some(t => t.imageId === candidate.image_id)) {
          targets.push({ imageId: candidate.image_id, cacheKey: key });
        }
      }
      if (!targets.length) return;
      const snapshotSeq = this._datasetDiagModalSeq;
      this._datasetDiagNeighborPrefetchTimer = setTimeout(() => {
        this._datasetDiagNeighborPrefetchTimer = 0;
        if (!this.datasetDiagModalOpen || snapshotSeq !== this._datasetDiagModalSeq) return;
        const controllers = [];
        this._datasetDiagNeighborControllers = controllers;
        for (const target of targets) {
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          if (controller) controllers.push(controller);
          const params = new URLSearchParams({
            image_id: target.imageId,
            min_count: String(this.datasetDiagMinCount || 3),
            bins: '10',
            reg_mode: this._datasetDiagEffectiveRegMode(),
          });
          if (source.runDir) params.set('run_dir', source.runDir);
          if (source.taskId) params.set('task_id', source.taskId);
          const runId = this.datasetDiagRunId || this.datasetDiagData?.run_id || '';
          if (runId) params.set('run_id', runId);
          const imgUrl = '/api/monitor/dataset-diagnostics/image?' + params.toString();
          fetch(window.animaUrl(imgUrl), {
            cache: 'no-store',
            ...(controller ? { signal: controller.signal } : {}),
          })
            .then(resp => resp.json().then(body => ({ resp, body })))
            .then(({ resp, body }) => {
              if (!this.datasetDiagModalOpen || snapshotSeq !== this._datasetDiagModalSeq) return;
              if (this._datasetDiagDetailCacheKey(source, target.imageId) !== target.cacheKey) return;
              if (resp.ok && body?.status === 'success' && body.data) {
                const revision = String(body.data.revision || '');
                if (!revision || !this._datasetDiagPayloadRevision || revision === this._datasetDiagPayloadRevision) {
                  if (!this._datasetDiagDetailCache) this._datasetDiagDetailCache = new Map();
                  this._datasetDiagDetailCache.set(target.cacheKey, body.data);
                  this._datasetDiagLightCacheKeys?.delete(target.cacheKey);
                  while (this._datasetDiagDetailCache.size > 40) {
                    const evicted = this._datasetDiagDetailCache.keys().next().value;
                    this._datasetDiagDetailCache.delete(evicted);
                    this._datasetDiagLightCacheKeys?.delete(evicted);
                  }
                }
              }
            })
            .catch(() => {});
        }
      }, 260);
    },

    async loadDatasetDiagImageDetail(imageId, force = false, refreshLocal = false) {
      const source = this._datasetDiagSource();
      if (!source.key || !imageId) return;
      const cacheKey = this._datasetDiagDetailCacheKey(source, imageId);
      this._datasetDiagModalController?.abort();
      this._datasetDiagModalController = null;
      const seq = ++this._datasetDiagModalSeq;
      if (!this._datasetDiagDetailCache) this._datasetDiagDetailCache = new Map();
      if (!force && this._datasetDiagDetailCache.has(cacheKey) && !this._datasetDiagLightCacheKeys?.has(cacheKey)) {
        this.datasetDiagModalDetail = this._datasetDiagDetailCache.get(cacheKey);
        this.datasetDiagModalLoading = false;
        this.datasetDiagModalError = '';
        this._patchDatasetDiagModal?.();
        this._scheduleDatasetDiagNeighborPrefetch(imageId);
        return;
      }

      const controller = new AbortController();
      this._datasetDiagModalController = controller;
      const isCurrent = () => seq === this._datasetDiagModalSeq
        && (this.datasetDiagModalOpen || this._datasetDiagModalOpening)
        && this.datasetDiagModalImageId === imageId && this._datasetDiagSource().key === source.key
        && this._datasetDiagDetailCacheKey(source, imageId) === cacheKey;
      const hadDetail = Boolean(this.datasetDiagModalDetail && this.datasetDiagModalDetail?.image?.image_id === imageId);
      const prevSig = hadDetail ? this._datasetDiagDetailSignature(this.datasetDiagModalDetail) : '';
      this.datasetDiagModalLoading = !hadDetail;
      this.datasetDiagModalError = '';
      if (this.datasetDiagModalOpen && !this.datasetDiagModalDetail) this._patchDatasetDiagModal?.();
      try {
        const params = new URLSearchParams({
          image_id: imageId,
          min_count: String(this.datasetDiagMinCount || 3),
          bins: '10',
          reg_mode: this._datasetDiagEffectiveRegMode(),
        });
        if (source.runDir) params.set('run_dir', source.runDir);
        if (source.taskId) params.set('task_id', source.taskId);
        const runId = this.datasetDiagRunId || this.datasetDiagData?.run_id || '';
        if (runId) params.set('run_id', runId);
        if (refreshLocal) params.set('refresh_local', 'true');
        const detailUrl = '/api/monitor/dataset-diagnostics/image?' + params.toString();
        const resp = await fetch(window.animaUrl(detailUrl), {
          cache: 'no-store', signal: controller.signal,
        });
        const body = await resp.json();
        if (!isCurrent()) return;
        if (resp.ok && body.status === 'success' && body.data) {
          const revision = String(body.data.revision || '');
          if (!revision || !this._datasetDiagPayloadRevision || revision === this._datasetDiagPayloadRevision) {
            this._datasetDiagDetailCache.set(cacheKey, body.data);
            this._datasetDiagLightCacheKeys?.delete(cacheKey);
          }
          while (this._datasetDiagDetailCache.size > 40) {
            const evicted = this._datasetDiagDetailCache.keys().next().value;
            this._datasetDiagDetailCache.delete(evicted);
            this._datasetDiagLightCacheKeys?.delete(evicted);
          }
          this.datasetDiagModalDetail = body.data;
          this.datasetDiagModalError = '';
        } else if (!hadDetail) {
          this.datasetDiagModalDetail = null;
          this.datasetDiagModalError = this.localizeApiError?.(body, 'monitor.ddModalLoadFailed') || 'loadFailed';
        }
      } catch (_) {
        if (!isCurrent()) return;
        if (!hadDetail) {
          this.datasetDiagModalDetail = null;
          this.datasetDiagModalError = 'loadFailed';
        }
      } finally {
        if (this._datasetDiagModalController === controller) {
          this._datasetDiagModalController = null;
        }
        if (seq === this._datasetDiagModalSeq) {
          this.datasetDiagModalLoading = false;
        }
        if (isCurrent()) {
          const nextSig = this.datasetDiagModalDetail ? this._datasetDiagDetailSignature(this.datasetDiagModalDetail) : '';
          if (this.datasetDiagModalOpen && (!hadDetail || nextSig !== prevSig || this.datasetDiagModalError)) {
            this._patchDatasetDiagModal?.();
          }
          if (this.datasetDiagModalDetail) this._scheduleDatasetDiagNeighborPrefetch(imageId);
        }
      }
    },

    _cancelDatasetDiagPreviewFetch() {
      if (this._datasetDiagPreviewFetchTimer) {
        clearTimeout(this._datasetDiagPreviewFetchTimer);
        this._datasetDiagPreviewFetchTimer = 0;
      }
      if (this._datasetDiagPreviewFetchController) {
        this._datasetDiagPreviewFetchController.abort();
        this._datasetDiagPreviewFetchController = null;
      }
      this._datasetDiagPreviewFetchKey = '';
    },

    _prefetchDatasetDiagPreviewDetail(imageId) {
      const source = this._datasetDiagSource();
      if (!source.key || !imageId || typeof fetch !== 'function') return;
      const cacheKey = this._datasetDiagDetailCacheKey(source, imageId);
      if (this._datasetDiagDetailCache?.has(cacheKey)) return;
      if (this._datasetDiagPreviewFetchKey === cacheKey && (this._datasetDiagPreviewFetchTimer || this._datasetDiagPreviewFetchController)) {
        return;
      }
      this._cancelDatasetDiagPreviewFetch();
      this._datasetDiagPreviewFetchKey = cacheKey;
      const timer = setTimeout(async () => {
        if (this._datasetDiagPreviewFetchTimer === timer) this._datasetDiagPreviewFetchTimer = 0;
        if (this._datasetDiagPreviewFetchKey !== cacheKey || this._datasetDiagSource().key !== source.key) return;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        this._datasetDiagPreviewFetchController = controller;
        try {
          const params = new URLSearchParams({
            image_id: imageId,
            min_count: String(this.datasetDiagMinCount || 3),
            bins: '10',
            reg_mode: this._datasetDiagEffectiveRegMode(),
            include_local: 'false',
            include_profile: 'false',
          });
          if (source.runDir) params.set('run_dir', source.runDir);
          if (source.taskId) params.set('task_id', source.taskId);
          const runId = this.datasetDiagRunId || this.datasetDiagData?.run_id || '';
          if (runId) params.set('run_id', runId);
          const previewImgUrl = '/api/monitor/dataset-diagnostics/image?' + params.toString();
          const resp = await fetch(window.animaUrl(previewImgUrl), {
            cache: 'no-store',
            ...(controller ? { signal: controller.signal } : {}),
          });
          const body = await resp.json();
          if (this._datasetDiagPreviewFetchKey !== cacheKey || this._datasetDiagSource().key !== source.key) return;
          if (resp.ok && body.status === 'success' && body.data) {
            const revision = String(body.data.revision || '');
            if (!revision || !this._datasetDiagPayloadRevision || revision === this._datasetDiagPayloadRevision) {
              if (!this._datasetDiagDetailCache) this._datasetDiagDetailCache = new Map();
              if (!this._datasetDiagDetailCache.has(cacheKey)) {
                if (!this._datasetDiagLightCacheKeys) this._datasetDiagLightCacheKeys = new Set();
                this._datasetDiagLightCacheKeys.add(cacheKey);
                this._datasetDiagDetailCache.set(cacheKey, body.data);
                while (this._datasetDiagDetailCache.size > 40) {
                  const evicted = this._datasetDiagDetailCache.keys().next().value;
                  this._datasetDiagDetailCache.delete(evicted);
                  this._datasetDiagLightCacheKeys?.delete(evicted);
                }
              }
              const previewId = this._datasetDiagHoverPreview?.kind === 'image' ? this._datasetDiagHoverPreview.imageId : '';
              if (this._datasetDiagActiveDotId === imageId || this._datasetDiagPinnedDotId === imageId || previewId === imageId) {
                this._syncDatasetDiagNoiseOverlay?.();
                this._syncDatasetDiagScatterTrajectory?.();
              }
            }
          }
        } catch (_) {
          // Hover prefetch failures are benign; modal click will retry cleanly.
        } finally {
          if (this._datasetDiagPreviewFetchController === controller) {
            this._datasetDiagPreviewFetchController = null;
          }
          if (this._datasetDiagPreviewFetchKey === cacheKey) {
            this._datasetDiagPreviewFetchKey = '';
          }
        }
      }, 50);
      this._datasetDiagPreviewFetchTimer = timer;
    },

    // ── Modal Image Zoom & Pan (powered by window.AnimaImageViewport) ───────
    get datasetDiagViewport() {
      if (!this._datasetDiagViewport) {
        if (!this._datasetDiagViewportState) this._datasetDiagViewportState = { scale: 1, x: 0, y: 0 };
        const state = this._datasetDiagViewportState;
        this._datasetDiagViewport = window.AnimaImageViewport.create(state, {
          smoothWheel: true,
          getStage: () => globalThis.document?.getElementById?.('datasetDiagModalStage')
            || globalThis.document?.querySelector?.('#datasetDiagModal .m-dd-modal-stage')
            || null,
          onInteract: (_vp, event) => {
            if (event?.type === 'dblclick') {
              const dialog = globalThis.document?.getElementById?.('datasetDiagModal');
              if (dialog && globalThis.document?.activeElement && !dialog.contains(globalThis.document.activeElement)) {
                dialog.querySelector?.('.m-dd-modal-window')?.focus?.({ preventScroll: true });
              }
            }
          },
          onChange: () => {
            this._syncDatasetDiagImageStyle?.();
          },
        });
      }
      return this._datasetDiagViewport;
    },

    datasetDiagZoomLabel() {
      const scale = this.datasetDiagViewport?.scale ?? 1;
      return scale <= 1.001
        ? this.t('imageViewer.fit')
        : Math.round(scale * 100) + '%';
    },

    datasetDiagModalKeydown(event) {
      if (!this.datasetDiagModalOpen || this.datasetDiagSamplesModalOpen) return;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target?.closest?.('input,select,textarea,summary,[contenteditable="true"],[role="combobox"],[role="listbox"],[role="menu"]')) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation?.();
        this.datasetDiagModalNav(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopPropagation?.();
        this.datasetDiagModalNav(1);
      } else if (event.key === '0') {
        event.preventDefault();
        this.datasetDiagViewport.reset(true);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        this.datasetDiagViewport.zoomBy(1.18);
      } else if (event.key === '-') {
        event.preventDefault();
        this.datasetDiagViewport.zoomBy(1 / 1.18);
      }
    },

    copyDatasetDiagText(text) {
      const value = String(text || '');
      if (!value) return;
      globalThis.navigator?.clipboard?.writeText(value)
        .then(() => this.toast?.(this.t('common.copied')))
        .catch(() => this.toast?.(this.t('common.failed'), 'error'));
    },

    openDatasetDiagInTagEditor() {
      const detail = this.datasetDiagModalDetail;
      const fi = detail?.file_info;
      const img = detail?.image;
      if (!fi?.exists || !fi.dir_path || !fi.abs_path || detail.caption?.editor_safe !== true) return;
      const name = String(img?.name || '');
      this.tagEditorDir = fi.dir_path;
      this.tagEditorOpenPath = fi.abs_path;
      this.tagEditorSearchQuery = name ? '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$' : '';
      this.tagEditorUseRegex = !!name;
      this.tagEditorQuickFilter = 'all';
      this.tagEditorTagSearch = '';
      this.tagEditorTagSelection = [];
      this.tagEditorExcludedTags = [];
      this.closeDatasetDiagModal();
      this.navigate?.('tagEditor');
    },
  };
})();
