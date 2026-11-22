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
    _datasetDiagImageFilterCache: null,
    _datasetDiagLoaded: false,
    _datasetDiagNeedsRefresh: false,
    _datasetDiagPollTimer: null,

    // Query & view state
    datasetDiagRunId: '',
    datasetDiagMinCount: 3,
    datasetDiagHeroMode: 'quadrant',
    datasetDiagGroupDim: 'resolution',
    datasetDiagGroupFilter: null,
    datasetDiagPreset: 'all',
    datasetDiagSearch: '',
    datasetDiagRegMode: 'all',
    datasetDiagSort: 'residual_desc',
    datasetDiagViewMode: readStoredViewMode(),
    datasetDiagDisplayLimit: 120,

    // Modal state
    datasetDiagModalOpen: false,
    datasetDiagModalImageId: '',
    datasetDiagModalDetail: null,
    datasetDiagModalLoading: false,
    datasetDiagModalError: '',
    _datasetDiagModalSeq: 0,
    _datasetDiagModalController: null,
    _datasetDiagDetailCache: null,
    _datasetDiagZoomCancel: null,
    datasetDiagZoomScale: 1,
    datasetDiagZoomX: 0,
    datasetDiagZoomY: 0,
    datasetDiagPanning: false,
    _datasetDiagPointerId: null,
    _datasetDiagPanStartX: 0,
    _datasetDiagPanStartY: 0,

    get datasetDiagTabCount() {
      const d = this.datasetDiagData;
      return d && d.available ? Number(d.summary?.images_total || 0) : 0;
    },

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
      this._datasetDiagSourceKey = key || '';
      this._datasetDiagPresetInitializedFor = '';
      this.datasetDiagData = null;
      this.datasetDiagError = '';
      this._datasetDiagLoaded = false;
      this._datasetDiagNeedsRefresh = false;
      this._datasetDiagQueryKey = '';
      this._datasetDiagRequestedRunId = '';
      this._datasetDiagPayloadRevision = '';
      this._datasetDiagImageFilterCache = null;
      this.datasetDiagRunId = '';
      this.datasetDiagGroupFilter = null;
      this.datasetDiagSearch = '';
      this.datasetDiagRegMode = 'all';
      this.datasetDiagPreset = 'all';
      this.datasetDiagSort = 'residual_desc';
      this.datasetDiagDisplayLimit = 120;
      if (this._datasetDiagDetailCache) this._datasetDiagDetailCache.clear();
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
      }, 12000);
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
      const key = JSON.stringify([source.key, runId, minCount]);
      if (pending?.key === key && !options.force) return pending.promise;
      this._cancelDatasetDiagRequest();
      this._stopDatasetDiagPolling();
      this._datasetDiagNeedsRefresh = false;
      const request = { key, runId, minCount, controller: new AbortController(), promise: null };
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
        });
        if (source.runDir) params.set('run_dir', source.runDir);
        if (source.taskId) params.set('task_id', source.taskId);
        if (request.runId) params.set('run_id', request.runId);
        if (options.refreshLocal) params.set('refresh_local', 'true');
        else if (this._datasetDiagQueryKey === request.key && this._datasetDiagPayloadRevision) {
          params.set('known_revision', this._datasetDiagPayloadRevision);
        }
        const resp = await fetch('/api/monitor/dataset-diagnostics?' + params.toString(), {
          cache: 'no-store', signal: request.controller.signal,
        });
        const body = await resp.json();
        if (!isCurrent()) return;
        this._datasetDiagLoaded = true;
        if (!resp.ok || body.status !== 'success' || !body.data) {
          repaint ||= this.datasetDiagError !== 'loadFailed';
          this.datasetDiagError = 'loadFailed';
          return;
        }

        const data = body.data;
        repaint ||= !!this.datasetDiagError;
        this.datasetDiagError = '';
        if (data.unchanged) {
          if (options.refreshLocal && this.datasetDiagModalOpen) {
            void this.loadDatasetDiagImageDetail(this.datasetDiagModalImageId, true, true);
          }
          return;
        }

        const runId = String(data.run_id || request.runId || '');
        const segmentChanged = this.datasetDiagRunId !== runId;
        const queryChanged = this._datasetDiagQueryKey !== request.key;
        this.datasetDiagRunId = runId;
        this._datasetDiagRequestedRunId = request.runId;
        this.datasetDiagMinCount = request.minCount;
        this._datasetDiagQueryKey = request.key;
        this._datasetDiagPayloadRevision = String(data.revision || body.revision || '');
        this.datasetDiagData = data;
        this._datasetDiagSnapshotVersion++;
        this._datasetDiagDetailCache?.clear();
        this._datasetDiagImageFilterCache = null;
        repaint = true;
        if (segmentChanged) this.datasetDiagGroupFilter = null;
        if (segmentChanged || queryChanged) this.datasetDiagDisplayLimit = 120;
        this._applyDatasetDiagDefaults(JSON.stringify([source.key, runId]), data);

        if (this.datasetDiagModalOpen && this.datasetDiagModalImageId) {
          const imageId = this.datasetDiagModalImageId;
          if (segmentChanged || !data.by_image?.some(image => image.image_id === imageId)) {
            this.closeDatasetDiagModal();
          } else {
            void this.loadDatasetDiagImageDetail(imageId, true, !!options.refreshLocal);
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

    _ddHasGroupComparison(data) {
      return ['resolution', 'subset', 'directory', 'batch_size'].some(d => (data?.['by_' + d] || []).length >= 2);
    },

    _applyDatasetDiagDefaults(sourceKey, data) {
      if (!data || !data.available) return;
      const summary = data.summary || {};
      const counts = summary.counts || {};
      if (!summary.has_reg_images) this.datasetDiagRegMode = 'all';
      const newSegment = this._datasetDiagPresetInitializedFor !== sourceKey;
      if (newSegment) {
        this._datasetDiagPresetInitializedFor = sourceKey;
        if ((counts.non_finite || 0) > 0) this.datasetDiagPreset = 'non_finite';
        else if ((counts.attention || 0) > 0) this.datasetDiagPreset = 'attention';
        else this.datasetDiagPreset = 'all';
      } else if (this.datasetDiagPreset === 'non_finite' && !(counts.non_finite > 0)) {
        this.datasetDiagPreset = 'all';
      }
      if (this.datasetDiagHeroMode === 'groups' && !this._ddHasGroupComparison(data)) {
        this.datasetDiagHeroMode = 'quadrant';
      }
      const dimRows = dim => (data['by_' + dim] || []).length;
      if (!dimRows(this.datasetDiagGroupDim) || (newSegment && dimRows(this.datasetDiagGroupDim) < 2)) {
        const dims = ['resolution', 'subset', 'directory', 'batch_size'];
        const multi = dims.find(d => dimRows(d) >= 2);
        const any = dims.find(d => dimRows(d) >= 1);
        if (multi) this.datasetDiagGroupDim = multi;
        else if (!dimRows(this.datasetDiagGroupDim) && any) this.datasetDiagGroupDim = any;
      }
    },

    setDatasetDiagRunId(value) {
      const next = String(value || '');
      if (this.datasetDiagRunId === next && !this._datasetDiagRequest) return;
      return this.loadDatasetDiagnostics({ runId: next });
    },

    setDatasetDiagMinCount(value) {
      const next = Math.max(1, Math.min(100, Math.round(Number(value) || 3)));
      if (this.datasetDiagMinCount === next && !this._datasetDiagRequest) return;
      return this.loadDatasetDiagnostics({ minCount: next });
    },

    setDatasetDiagHeroMode(mode) {
      if (!['quadrant', 'timestep', 'groups'].includes(mode) || this.datasetDiagHeroMode === mode) return;
      this.datasetDiagHeroMode = mode;
      this.renderDashboard?.();
    },

    setDatasetDiagGroupDim(dim) {
      if (!['resolution', 'subset', 'directory', 'batch_size'].includes(dim) || this.datasetDiagGroupDim === dim) return;
      this.datasetDiagGroupDim = dim;
      this.renderDashboard?.();
    },

    toggleDatasetDiagGroupFilter(dim, key, label) {
      const cur = this.datasetDiagGroupFilter;
      const selected = !(cur && cur.dim === dim && cur.key === key);
      if (selected) {
        this.datasetDiagGroupFilter = { dim, key, label: label || key };
        this.datasetDiagPreset = 'all';
        this.datasetDiagRegMode = 'all';
        this.datasetDiagSearch = '';
      } else {
        this.datasetDiagGroupFilter = null;
      }
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
      if (selected && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          if (this.currentRoute === 'monitor-dashboard' && this.monitorTab === 'dataset') {
            globalThis.document?.getElementById('datasetDiagImagesSection')?.scrollIntoView({ block: 'start' });
          }
        });
      }
    },

    clearDatasetDiagGroupFilter() {
      if (!this.datasetDiagGroupFilter) return;
      this.datasetDiagGroupFilter = null;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    setDatasetDiagPreset(preset) {
      if (!['all', 'attention', 'learning', 'easy', 'non_finite', 'insufficient', 'insufficient_reference'].includes(preset)) return;
      if (this.datasetDiagPreset === preset) return;
      this.datasetDiagPreset = preset;
      this.datasetDiagDisplayLimit = 120;
      if (preset === 'easy' && this.datasetDiagSort === 'residual_desc') {
        this.datasetDiagSort = 'residual_asc';
      } else if (preset !== 'easy' && this.datasetDiagSort === 'residual_asc') {
        this.datasetDiagSort = 'residual_desc';
      }
      this.renderDashboard?.();
    },

    setDatasetDiagSearch(value) {
      const next = String(value || '');
      if (this.datasetDiagSearch === next) return;
      this.datasetDiagSearch = next;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    setDatasetDiagRegMode(mode) {
      if (!['all', 'exclude', 'only'].includes(mode) || this.datasetDiagRegMode === mode) return;
      this.datasetDiagRegMode = mode;
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    setDatasetDiagSort(sortKey) {
      if (!sortKey || this.datasetDiagSort === sortKey) return;
      this.datasetDiagSort = sortKey;
      this.renderDashboard?.();
    },

    setDatasetDiagViewMode(mode) {
      if (!['grid', 'table'].includes(mode) || this.datasetDiagViewMode === mode) return;
      this.datasetDiagViewMode = mode;
      writeStoredViewMode(mode);
      this.renderDashboard?.();
    },

    showMoreDatasetDiagImages() {
      this.datasetDiagDisplayLimit = (this.datasetDiagDisplayLimit || 120) + 120;
      this.renderDashboard?.();
    },

    resetDatasetDiagFilters() {
      this.datasetDiagPreset = 'all';
      this.datasetDiagGroupFilter = null;
      this.datasetDiagSearch = '';
      this.datasetDiagRegMode = 'all';
      this.datasetDiagDisplayLimit = 120;
      this.renderDashboard?.();
    },

    _datasetDiagFilteredImages() {
      const data = this.datasetDiagData;
      if (!data || !data.available || !Array.isArray(data.by_image)) return [];
      const preset = this.datasetDiagPreset || 'all';
      const gf = this.datasetDiagGroupFilter;
      const query = String(this.datasetDiagSearch || '').trim().toLowerCase();
      const regMode = this.datasetDiagRegMode || 'all';
      const sortKey = this.datasetDiagSort || 'residual_desc';
      const filterKey = JSON.stringify([preset, gf?.dim, gf?.key, query, regMode, sortKey]);
      const cached = this._datasetDiagImageFilterCache;
      if (cached?.data === data && cached.key === filterKey) return cached.rows;

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
        if (preset === 'non_finite') return img.non_finite_count > 0;
        return preset === 'all' || img.status === preset;
      });

      const numOr = (v, fb) => (v != null && Number.isFinite(Number(v))) ? Number(v) : fb;
      list.sort((a, b) => {
        if (sortKey === 'residual_asc') return numOr(a.mean_residual, 1e9) - numOr(b.mean_residual, 1e9);
        if (sortKey === 'slope_desc') return numOr(b.slope, -1e9) - numOr(a.slope, -1e9);
        if (sortKey === 'slope_asc') return numOr(a.slope, 1e9) - numOr(b.slope, 1e9);
        if (sortKey === 'loss_desc') return numOr(b.mean_loss, -1e9) - numOr(a.mean_loss, -1e9);
        if (sortKey === 'count_desc') return (b.count - a.count) || (numOr(b.mean_residual, -1e9) - numOr(a.mean_residual, -1e9));
        if (sortKey === 'name_asc') return String(a.name).localeCompare(String(b.name));
        return (b.non_finite_count > 0 ? 1 : 0) - (a.non_finite_count > 0 ? 1 : 0)
          || numOr(b.mean_residual, -1e9) - numOr(a.mean_residual, -1e9);
      });
      this._datasetDiagImageFilterCache = { data, key: filterKey, rows: list };
      return this._datasetDiagImageFilterCache.rows;
    },

    _datasetDiagDetailCacheKey(source, imageId) {
      const runId = this.datasetDiagRunId || this.datasetDiagData?.run_id || '';
      return JSON.stringify([source.key, runId, this.datasetDiagMinCount, this._datasetDiagSnapshotVersion, imageId]);
    },

    // ── Modal Management ──────────────────────────────────────────────────────
    openDatasetDiagModal(imageId) {
      if (!imageId) return;
      const source = this._datasetDiagSource();
      const cacheKey = this._datasetDiagDetailCacheKey(source, imageId);
      const cached = this._datasetDiagDetailCache?.get(cacheKey) || null;
      const reopen = !this.datasetDiagModalOpen;
      this.datasetDiagModalImageId = imageId;
      this.datasetDiagModalDetail = cached;
      this.datasetDiagModalError = '';
      this.resetDatasetDiagZoom(false);
      this.datasetDiagModalOpen = true;
      if (cached && reopen) this._patchDatasetDiagModal?.();
      void this.loadDatasetDiagImageDetail(imageId, reopen);
    },

    closeDatasetDiagModal() {
      this._datasetDiagModalSeq++;
      this._datasetDiagModalController?.abort();
      this._datasetDiagModalController = null;
      this._datasetDiagZoomCancel?.();
      this._datasetDiagZoomCancel = null;
      this.datasetDiagModalOpen = false;
      this.stopDatasetDiagPan();
    },

    clearDatasetDiagModal() {
      if (this.datasetDiagModalOpen) return;
      this.datasetDiagModalImageId = '';
      this.datasetDiagModalDetail = null;
      this.datasetDiagModalLoading = false;
      this.datasetDiagModalError = '';
      this.resetDatasetDiagZoom(false);
    },

    _datasetDiagModalNavList() {
      const filtered = this._datasetDiagFilteredImages();
      if (filtered.some(item => item.image_id === this.datasetDiagModalImageId)) return filtered;
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

    async loadDatasetDiagImageDetail(imageId, force = false, refreshLocal = false) {
      const source = this._datasetDiagSource();
      if (!source.key || !imageId) return;
      const cacheKey = this._datasetDiagDetailCacheKey(source, imageId);
      this._datasetDiagModalController?.abort();
      this._datasetDiagModalController = null;
      const seq = ++this._datasetDiagModalSeq;
      if (!this._datasetDiagDetailCache) this._datasetDiagDetailCache = new Map();
      if (!force && this._datasetDiagDetailCache.has(cacheKey)) {
        this.datasetDiagModalDetail = this._datasetDiagDetailCache.get(cacheKey);
        this.datasetDiagModalLoading = false;
        this.datasetDiagModalError = '';
        this._patchDatasetDiagModal?.();
        return;
      }

      const controller = new AbortController();
      this._datasetDiagModalController = controller;
      const isCurrent = () => seq === this._datasetDiagModalSeq && this.datasetDiagModalOpen
        && this.datasetDiagModalImageId === imageId && this._datasetDiagSource().key === source.key
        && this._datasetDiagDetailCacheKey(source, imageId) === cacheKey;
      this.datasetDiagModalLoading = true;
      this.datasetDiagModalError = '';
      if (!this.datasetDiagModalDetail) this._patchDatasetDiagModal?.();
      try {
        const params = new URLSearchParams({
          image_id: imageId,
          min_count: String(this.datasetDiagMinCount || 3),
          bins: '10',
        });
        if (source.runDir) params.set('run_dir', source.runDir);
        if (source.taskId) params.set('task_id', source.taskId);
        const runId = this.datasetDiagRunId || this.datasetDiagData?.run_id || '';
        if (runId) params.set('run_id', runId);
        if (refreshLocal) params.set('refresh_local', 'true');
        const resp = await fetch('/api/monitor/dataset-diagnostics/image?' + params.toString(), {
          cache: 'no-store', signal: controller.signal,
        });
        const body = await resp.json();
        if (!isCurrent()) return;
        if (resp.ok && body.status === 'success' && body.data) {
          const revision = String(body.data.revision || body.revision || '');
          if (!revision || !this._datasetDiagPayloadRevision || revision === this._datasetDiagPayloadRevision) {
            this._datasetDiagDetailCache.set(cacheKey, body.data);
          }
          while (this._datasetDiagDetailCache.size > 40) {
            this._datasetDiagDetailCache.delete(this._datasetDiagDetailCache.keys().next().value);
          }
          this.datasetDiagModalDetail = body.data;
          this.datasetDiagModalError = '';
        } else {
          this.datasetDiagModalDetail = null;
          this.datasetDiagModalError = body.message || 'loadFailed';
        }
      } catch (_) {
        if (!isCurrent()) return;
        this.datasetDiagModalDetail = null;
        this.datasetDiagModalError = 'loadFailed';
      } finally {
        if (isCurrent()) {
          this._datasetDiagModalController = null;
          this.datasetDiagModalLoading = false;
          this._patchDatasetDiagModal?.();
        }
      }
    },

    // ── Modal Image Zoom & Pan (reuses window.AnimaImageViewport math) ───────
    _datasetDiagTransform() {
      return `translate3d(${this.datasetDiagZoomX}px,${this.datasetDiagZoomY}px,0) scale(${this.datasetDiagZoomScale})`;
    },

    resetDatasetDiagZoom(smooth = false) {
      this._datasetDiagZoomCancel?.();
      this._datasetDiagZoomCancel = null;
      this.stopDatasetDiagPan();
      if (!smooth || !window.AnimaImageViewport?.animate) {
        this.datasetDiagZoomScale = 1;
        this.datasetDiagZoomX = 0;
        this.datasetDiagZoomY = 0;
        this._syncDatasetDiagImageStyle?.();
        return;
      }
      this._datasetDiagZoomCancel = window.AnimaImageViewport.animate(
        { scale: this.datasetDiagZoomScale, x: this.datasetDiagZoomX, y: this.datasetDiagZoomY },
        { scale: 1, x: 0, y: 0 },
        view => {
          this.datasetDiagZoomScale = view.scale;
          this.datasetDiagZoomX = view.x;
          this.datasetDiagZoomY = view.y;
          this._syncDatasetDiagImageStyle?.();
        },
      );
    },

    _constrainDatasetDiagZoom(stage) {
      if (!window.AnimaImageViewport?.constrain) return;
      const targetStage = stage || globalThis.document?.querySelector?.('#datasetDiagModal .m-dd-modal-stage');
      const view = window.AnimaImageViewport.constrain(
        { scale: this.datasetDiagZoomScale, x: this.datasetDiagZoomX, y: this.datasetDiagZoomY },
        targetStage ? [targetStage] : [],
      );
      this.datasetDiagZoomX = view.x;
      this.datasetDiagZoomY = view.y;
    },

    setDatasetDiagZoomScale(next, event = null) {
      const vp = window.AnimaImageViewport;
      if (!vp) return;
      this._datasetDiagZoomCancel?.();
      this._datasetDiagZoomCancel = null;
      const stage = event?.currentTarget?.closest?.('.m-dd-modal-stage')
        || globalThis.document?.querySelector?.('#datasetDiagModal .m-dd-modal-stage');
      const anchor = (event && stage) ? vp.pointerAnchor(event, stage) : null;
      const view = vp.zoom(
        { scale: this.datasetDiagZoomScale, x: this.datasetDiagZoomX, y: this.datasetDiagZoomY },
        next,
        anchor,
      );
      this.datasetDiagZoomScale = view.scale;
      this.datasetDiagZoomX = view.x;
      this.datasetDiagZoomY = view.y;
      this._constrainDatasetDiagZoom(stage);
      this._syncDatasetDiagImageStyle?.();
    },

    zoomDatasetDiagImage(event) {
      if (!event.deltaY || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.18 : (1 / 1.18);
      this.setDatasetDiagZoomScale(this.datasetDiagZoomScale * factor, event);
    },

    startDatasetDiagPan(event) {
      if (event.button !== 0 || event.isPrimary === false || this.datasetDiagZoomScale <= 1) return;
      this._datasetDiagZoomCancel?.();
      this._datasetDiagZoomCancel = null;
      this.datasetDiagPanning = true;
      this._datasetDiagPointerId = event.pointerId;
      this._datasetDiagPanStartX = event.clientX - this.datasetDiagZoomX;
      this._datasetDiagPanStartY = event.clientY - this.datasetDiagZoomY;
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    },

    moveDatasetDiagPan(event) {
      if (!this.datasetDiagPanning || event.pointerId !== this._datasetDiagPointerId) return;
      this.datasetDiagZoomX = event.clientX - this._datasetDiagPanStartX;
      this.datasetDiagZoomY = event.clientY - this._datasetDiagPanStartY;
      this._constrainDatasetDiagZoom(event.currentTarget);
      this._datasetDiagPanStartX = event.clientX - this.datasetDiagZoomX;
      this._datasetDiagPanStartY = event.clientY - this.datasetDiagZoomY;
      this._syncDatasetDiagImageStyle?.();
    },

    stopDatasetDiagPan(event) {
      if (event && this._datasetDiagPointerId !== null) {
        event.currentTarget?.releasePointerCapture?.(this._datasetDiagPointerId);
      }
      this.datasetDiagPanning = false;
      this._datasetDiagPointerId = null;
      this._syncDatasetDiagImageStyle?.();
    },

    datasetDiagModalKeydown(event) {
      if (!this.datasetDiagModalOpen) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.datasetDiagModalNav(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.datasetDiagModalNav(1);
      } else if (event.key === '0') {
        event.preventDefault();
        this.resetDatasetDiagZoom(true);
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        this.setDatasetDiagZoomScale(this.datasetDiagZoomScale * 1.18);
      } else if (event.key === '-') {
        event.preventDefault();
        this.setDatasetDiagZoomScale(this.datasetDiagZoomScale / 1.18);
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
