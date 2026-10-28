/* Dataset sessions, paging, query invalidation and recovery. */
window.tagEditorSession = {
  tagEditorSessionId: '',
  tagEditorSessionGeneration: 0,
  tagEditorSessionRevision: '',
  tagEditorDatasetCount: 0,
  tagEditorFilteredTotal: 0,
  tagEditorServerTotalPages: 1,
  tagEditorPageItems: [],
  tagEditorDirectoryCounts: {},
  tagEditorNoTagCount: 0,
  _teLoadEpoch: 0,
  _teLoadAbort: null,
  _tePageAbort: null,
  _tePageEpoch: 0,
  _teAllAbort: null,
  _tePageCache: null,
  _tePageFetchTimer: null,
  _teSessionRecovery: null,
  _teCaptionQueryVersion: 0,

  // ===== Data Loading =====
  _teCloseSession(sessionId) {
    if (!sessionId) return;
    fetch('/api/tageditor/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE', keepalive: true }).catch(function() {});
  },

  _teSessionQuery(page, useFilters = true) {
    var filters = useFilters ? this : {};
    var params = new URLSearchParams();
    params.set('page', String(page || this.tagEditorPage || 1));
    params.set('page_size', String(Number(this.tagEditorPageSize) || 60));
    params.set('search', filters.tagEditorSearchQuery || '');
    params.set('use_regex', filters.tagEditorUseRegex ? 'true' : 'false');
    params.set('quick_filter', filters.tagEditorQuickFilter || 'all');
    params.set('include_tags', (filters.tagEditorTagSelection || []).join('\x1f'));
    params.set('exclude_tags', (filters.tagEditorExcludedTags || []).join('\x1f'));
    params.set('tag_logic', filters.tagEditorTagLogic || 'AND');
    params.set('sort_by', filters.tagEditorSortBy || 'name');
    params.set('sort_asc', filters.tagEditorSortAsc === false ? 'false' : 'true');
    params.set('sort_by2', filters.tagEditorSortBy2 || '');
    params.set('sort_asc2', filters.tagEditorSortAsc2 === false ? 'false' : 'true');
    params.set('group_by_dir', filters.tagEditorGroupByDir ? 'true' : 'false');
    return params;
  },

  _teSessionQueryKey(page, useFilters = true) {
    return this._teSessionQuery(page, useFilters).toString() + '&caption_version=' + this._teCaptionQueryVersion;
  },

  _teCaptionQueryOptions(signal, useOverrides = true) {
    var overrides = {};
    if (useOverrides) this._teGetModified().forEach(img => { overrides[img.path] = img.tags; });
    return Object.keys(overrides).length ? {
      signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overrides)
    } : { signal };
  },

  _teInvalidateCaptionQuery() {
    this._teCaptionQueryVersion++;
    this._tePageCache = {};
    if (this.tagEditorSessionId && !this.tagEditorLoading && this.tagEditorQuickFilter !== 'modified' &&
        (this.tagEditorSearchQuery || this.tagEditorQuickFilter === 'notag' || this.tagEditorTagSelection.length ||
         this.tagEditorExcludedTags.length || this.tagEditorSortBy === 'tagCount' || this.tagEditorSortBy2 === 'tagCount')) {
      this.tagEditorSchedulePageFetch(false);
    }
  },

  _teCancelPageFetch() {
    this._tePageEpoch++;
    if (this._tePageAbort) this._tePageAbort.abort();
    this._tePageAbort = null;
    if (this._tePageFetchTimer) clearTimeout(this._tePageFetchTimer);
    this._tePageFetchTimer = null;
    this._teSearchLoading = false;
  },

  _teMergeSessionItems(items, reset) {
    if (reset || !this._tePageCache) this._tePageCache = {};
    if (reset) {
      this.tagEditorImages = [];
      this.tagEditorOriginal = {};
      this._teEditVersions = {};
      this._teCaptionRevisions = {};
      this._tePathIndex = {};
    }
    var self = this;
    (items || []).forEach(function(serverImg) {
      var existing = self._teFindByPath(serverImg.path);
      if (existing && existing.tags !== self.tagEditorOriginal[existing.path]) return;
      if (existing) Object.assign(existing, serverImg);
      else {
        existing = Object.assign({}, serverImg);
        self.tagEditorImages.push(existing);
        self._tePathIndex[existing.path] = existing;
      }
      self.tagEditorOriginal[existing.path] = existing.tags || '';
      if (!Object.prototype.hasOwnProperty.call(self._teEditVersions, existing.path)) self._teEditVersions[existing.path] = 0;
      self._teCaptionRevisions[existing.path] = existing.caption_revision || 'missing';
    });
    this.tagEditorPageItems = (items || []).map(function(item) { return self._teFindByPath(item.path); }).filter(Boolean);
  },

  _teApplySessionPage(data, reset) {
    this.tagEditorDirectoryCounts = data.directory_counts || {};
    this.tagEditorPage = Number(data.page || 1);
    this.tagEditorFilteredTotal = Number(data.total || 0);
    this.tagEditorServerTotalPages = Number(data.total_pages || 1);
    this.tagEditorSessionGeneration = Number(data.generation || this.tagEditorSessionGeneration || 1);
    this.tagEditorSessionRevision = data.revision || this.tagEditorSessionRevision || '';
    this._teMergeSessionItems(data.items || [], !!reset);
    this._tdRequestChips();
    if (this._tePageCache) {
      this._tePageCache[this._teSessionQueryKey(this.tagEditorPage, !reset)] = { ...data, items: this.tagEditorPageItems.slice() };
      var keys = Object.keys(this._tePageCache);
      if (keys.length > 24) delete this._tePageCache[keys[0]];
    }
    this._teInvalidateFilter();
  },

  async tagEditorFetchPage(page, options) {
    this._teLastSelected = null;
    this._teCancelPageFetch();
    if (!this.tagEditorSessionId) return false;
    if (options?.isCurrent && !options.isCurrent()) return false;
    var targetPage = Math.max(1, Number(page || this.tagEditorPage || 1));
    if (this.tagEditorQuickFilter === 'modified') {
      this.tagEditorPage = targetPage;
      this.tagEditorSchedulePageFetch(false);
      return true;
    }
    var cacheKey = this._teSessionQueryKey(targetPage);
    if (!(options && options.force) && this._tePageCache && this._tePageCache[cacheKey]) {
      this._teApplySessionPage(this._tePageCache[cacheKey], false);
      return true;
    }
    var epoch = this._tePageEpoch;
    var controller = new AbortController();
    this._tePageAbort = controller;
    this._teSearchLoading = true;
    try {
      var response = await fetch('/api/tageditor/sessions/' + encodeURIComponent(this.tagEditorSessionId) + '/images?' + this._teSessionQuery(targetPage).toString(), this._teCaptionQueryOptions(controller.signal));
      var payload = await response.json();
      if (epoch !== this._tePageEpoch || controller.signal.aborted) return false;
      if (cacheKey !== this._teSessionQueryKey(targetPage)) return false;
      // 导航失效时连分页状态也不能覆盖；仅在选中图片前检查已经太晚。
      if (options?.isCurrent && !options.isCurrent()) return false;
      if (payload.status !== 'success') {
        if (payload.code === 'session_expired') {
          await this.tagEditorReloadSessionPage(targetPage);
          return false;
        }
        this.toast(payload.message || this.t('common.error'), 'error');
        return false;
      }
      this._teApplySessionPage(payload.data || {}, false);
      return true;
    } catch (e) {
      if (epoch === this._tePageEpoch && !controller.signal.aborted && (!e || e.name !== 'AbortError')) this.toast(this.t('common.networkError'), 'error');
    } finally {
      if (epoch === this._tePageEpoch) {
        this._teSearchLoading = false;
        this._tePageAbort = null;
      }
    }
    return false;
  },

  tagEditorSchedulePageFetch(resetPage) {
    this._teLastSelected = null;
    this._teCancelPageFetch();
    if (this._teAllAbort) this._teAllAbort.abort();
    if (resetPage) this.tagEditorPage = 1;
    if (this.tagEditorQuickFilter === 'modified') {
      this._teRefreshModifiedPage();
      return;
    }
    var self = this;
    this._tePageFetchTimer = setTimeout(function() {
      self._tePageFetchTimer = null;
      self.tagEditorFetchPage(self.tagEditorPage, { force: true });
    }, 80);
  },

  _teRefreshModifiedPage() {
    var modified = this._teFilterImages(this._teGetModified());
    var size = Math.max(1, Number(this.tagEditorPageSize) || 60);
    this.tagEditorFilteredTotal = modified.length;
    this.tagEditorServerTotalPages = Math.max(1, Math.ceil(modified.length / size));
    this.tagEditorPage = Math.max(1, Math.min(this.tagEditorServerTotalPages, Number(this.tagEditorPage) || 1));
    var start = (this.tagEditorPage - 1) * size;
    this.tagEditorPageItems = modified.slice(start, start + size);
    var counts = Object.create(null);
    for (var img of modified) {
      var dir = this.tagEditorImageDirectory(img);
      counts[dir] = (counts[dir] || 0) + 1;
    }
    this.tagEditorDirectoryCounts = counts;
  },

  async tagEditorReloadSessionPage(page) {
    this._teFlushAllPendingTextEdits();
    var drafts = {};
    var self = this;
    var paths = new Set(this.tagEditorSelected);
    this._teGetModified().forEach(img => paths.add(img.path));
    this.tagEditorHistory.forEach(item => Object.keys(item.changes || this._teSnapOf(item)).forEach(path => paths.add(path)));
    paths.forEach(function(path) {
      var img = self._teFindByPath(path);
      if (!img) return;
      drafts[img.path] = {
        image: Object.assign({}, img),
        original: self.tagEditorOriginal[img.path],
        editVersion: (self._teEditVersions && self._teEditVersions[img.path]) || 0,
        captionRevision: self._teCaptionRevisions ? self._teCaptionRevisions[img.path] : 'missing'
      };
    });
    this._teSessionRecovery = {
      dir: this.tagEditorLoadedDir || this.tagEditorDir, preserveDrafts: drafts, targetPage: page || 1,
      history: this.tagEditorHistory.slice(), historyIdx: this.tagEditorHistoryIdx,
      historyState: Object.assign({}, this._teHistoryState), selected: this.tagEditorSelected.slice(),
      anchor: this._teLastSelected, include: this.tagEditorTagSelection.slice(), exclude: this.tagEditorExcludedTags.slice(),
      remainder: this._teDraftRemainder.slice(), mode: this.tagEditorWorkMode, detailView: this.tagEditorDetailView
    };
    await this.tagEditorLoad(this._teSessionRecovery.dir);
  },

  tagEditorAllowsTagOps() {
    return this.tagEditorWorkMode !== 'text';
  },

  _teRestoreWorkMode(dir, requested) {
    var mode = requested;
    if (!mode) {
      try { mode = localStorage.getItem('tagEditor_mode_' + dir); } catch (_) {}
    }
    this.tagEditorSetWorkMode(mode === 'text' ? 'text' : 'tags', false);
    if (requested) this._teRememberWorkMode(dir);
  },

  _teRememberWorkMode(dir) {
    if (!dir) return;
    try { localStorage.setItem('tagEditor_mode_' + dir, this.tagEditorWorkMode); } catch (_) {}
  },

  tagEditorSetWorkMode(mode, refresh = true) {
    if (!['tags', 'text'].includes(mode)) return;
    this._teFlushAllPendingTextEdits();
    var changed = mode !== this.tagEditorWorkMode;
    this.tagEditorWorkMode = mode;
    this._teModeEpoch++;
    this.tagEditorCancelQuickRemove();
    this.tagEditorInlineEdit = this.tagEditorContextMenu = this.tagEditorPanelMenu = null;
    this._teCloseSuggestions();
    this.tagDictionaryCloseHover?.();
    this.tagDictionaryPanelOpen = false;
    this._teInvalidateDiff();
    if (mode === 'text') {
      this.tagEditorDetailView = 'text';
      if (this.tagEditorSidebarTab === 'tags') this.tagEditorSidebarTab = 'history';
      this.tagEditorTagSelection = [];
      this.tagEditorExcludedTags = [];
      this.tagEditorTagSearch = '';
      if (this.tagEditorSortBy === 'tagCount') this.tagEditorSortBy = 'name';
      if (this.tagEditorSortBy2 === 'tagCount') this.tagEditorSortBy2 = '';
      this._teClearFreqData();
    }
    if (refresh) {
      this._teRememberWorkMode(this.tagEditorLoadedDir || this.tagEditorDir);
      if (changed && mode === 'tags') {
        this.tagDictionaryInit?.(); this.tagDictionaryEnsureWorker?.();
        void this.tagEditorLoadTagFreq();
      }
      this._teInvalidateFilter();
      if (changed && this.tagEditorSessionId) this.tagEditorSchedulePageFetch(true);
    }
  },

  tagEditorSetDetailView(view) {
    this._teFlushAllPendingTextEdits();
    this.tagEditorCancelQuickRemove();
    this.tagEditorDetailView = this.tagEditorAllowsTagOps() && view === 'chip' ? 'chip' : 'text';
  },

  async tagEditorLoad(dir) {
    if (this.tagEditorLightboxOpen) this.tagEditorCloseLightbox();
    this.tagEditorShortcutsOpen = false;
    this._teLastSelected = null;
    this.tagEditorCancelQuickRemove();
    this.tagEditorPanelMenu = null;
    var loadOptions = arguments.length > 1 && arguments[1] ? arguments[1] : {};
    var openPath = this.tagEditorOpenPath;
    this.tagEditorOpenPath = '';
    var self = this;
    var requestedMode = this.tagEditorRequestedMode;
    this.tagEditorRequestedMode = '';
    if (!dir && !this.tagEditorDir) {
      var cached = null;
      try { cached = sessionStorage.getItem('tagEditor_lastDir'); } catch (e) {}
      if (cached) { dir = cached; }
    }
    var d = dir || this.tagEditorDir || '';
    if (!d) {
      this.finishProgress();
      return;
    }
    // 重建失败后，普通“加载”重试仍须沿用内存中的正文和历史；切换数据集则丢弃该上下文。
    if (this._teSessionRecovery && this._teSessionRecovery.dir !== d) this._teSessionRecovery = null;
    var recovery = this._teSessionRecovery;
    if (recovery) loadOptions = recovery;
    var epoch = ++this._teLoadEpoch;
    this.tagEditorSaving = this._teIsSaving = false;
    this.tagEditorSnapshotBusy = false;
    if (this._teLoadAbort) this._teLoadAbort.abort();
    this._teCancelPageFetch();
    if (this._teAllAbort) { this._teAllAbort.abort(); this._teAllAbort = null; }
    this._teCloseSession(this.tagEditorSessionId);
    this.tagEditorSessionId = '';
    var controller = new AbortController();
    this._teLoadAbort = controller;
    this.tagEditorPendingDir = d;
    this.tagEditorLoading = true;
    this._teStopAutoSave();
    this._teDiscardPendingTextEdits();
    if (this._teSearchDebounce) { clearTimeout(this._teSearchDebounce); this._teSearchDebounce = null; }
    if (this._teTagSearchDebounce) { clearTimeout(this._teTagSearchDebounce); this._teTagSearchDebounce = null; }
    this.startProgress();
    try {
      var r = await fetch('/api/tageditor/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: d, recursive: this.tagEditorRecursive, page_size: Number(this.tagEditorPageSize) || 60 }),
        signal: controller.signal
      });
      var j = await r.json();
      if (epoch !== this._teLoadEpoch || controller.signal.aborted) return;
      if (j.status === 'success') {
        try { sessionStorage.setItem('tagEditor_lastDir', d); } catch (e) {}
        this.tagEditorDir = j.data.dir || d;
        this.tagEditorLoadedDir = this.tagEditorDir;
        this._teDraftRemainder = [];
        this._teDraftRestoreBusy = false;
        this._teRestoreWorkMode(this.tagEditorDir, recovery ? recovery.mode : requestedMode);
        if (this.tagEditorAllowsTagOps()) {
          this.tagDictionaryInit();
          this.tagDictionaryEnsureWorker();
        }
        this.tagEditorPendingDir = this.tagEditorDir;
        this.tagEditorSwitchOpen = false;
        this.tagEditorSessionId = j.data.session_id || '';
        this.tagEditorDatasetCount = Number(j.data.count || 0);
        this.tagEditorNoTagCount = Number(j.data.no_tag_count || 0);
        this._teApplySessionPage(j.data || {}, true);
        this.tagEditorModified = false;
        this._teModifiedCount = 0;
        this.tagEditorSelected = [];
        this.tagEditorBatchMode = 'add';
        this.tagEditorBatchTagFilter = 'all';
        this.tagEditorPage = Number(loadOptions.targetPage || 1);
        this.tagEditorHistory = [];
        this.tagEditorHistoryIdx = -1;
        this._teHistoryState = {};
        this.tagEditorTagSelection = [];
        this.tagEditorExcludedTags = [];
        this._teInvalidateFilter();
        this._teInvalidateFreq();
        this._teSearchLoading = false;
        this.tagEditorRegexError = false;
        this._teDraftSavedAt = '';
        if (!this.tagEditorAllowsTagOps()) {
          this._teClearFreqData();
        } else if (Array.isArray(j.data.tags)) {
          this.tagEditorTagFreq = j.data.tags;
          this.tagEditorMaxFreq = this.tagEditorTagFreq.length > 0 ? this.tagEditorTagFreq[0].count : 0;
          this._teRebuildFreqIndex();
          this._teInvalidateFreq();
        } else {
          await this.tagEditorLoadTagFreq();
        }
        var preservedDrafts = loadOptions.preserveDrafts || {};
        Object.keys(preservedDrafts).forEach(function(path) {
          var draft = preservedDrafts[path];
          var img = self._teFindByPath(path);
          if (!img && draft && draft.image) {
            img = Object.assign({}, draft.image);
            // 页外图片尚未取得新分页元数据，预览地址也要迁移到新会话。
            ['thumbnail', 'preview'].forEach(function(field) {
              if (!img[field]) return;
              var parts = img[field].split('?');
              var params = new URLSearchParams(parts[1] || '');
              if (params.get('scope') !== 'dataset') return;
              params.set('session_id', self.tagEditorSessionId);
              img[field] = parts[0] + '?' + params.toString();
            });
            self.tagEditorImages.push(img);
            self._tePathIndex[path] = img;
          }
          if (img && draft) {
            self.tagEditorOriginal[path] = draft.original;
            self._teEditVersions[path] = draft.editVersion;
            self._teCaptionRevisions[path] = draft.captionRevision;
            img.tags = draft.image.tags;
            self._teUpdateFreq(draft.original, img.tags);
          }
        });
        if (recovery) {
          this.tagEditorHistory = recovery.history;
          this.tagEditorHistoryIdx = recovery.historyIdx;
          this._teHistoryState = recovery.historyState;
          this.tagEditorSelected = recovery.selected;
          this.tagEditorTagSelection = recovery.include;
          this.tagEditorExcludedTags = recovery.exclude;
          this._teDraftRemainder = recovery.remainder;
          this.tagEditorDetailView = recovery.detailView;
          this._teInvalidateDiff();
          this._updateEditorPanel();
        }
        this._teRecountModified();
        this._teInvalidateCaptionQuery();
        this.tagEditorModified = this._teModifiedCount > 0;
        if (this._teSessionQueryKey(this.tagEditorPage) !== this._teSessionQueryKey(Number(j.data.page || 1), false)) {
          await this.tagEditorFetchPage(this.tagEditorPage, { force: true });
        }
        if (epoch !== this._teLoadEpoch || controller.signal.aborted) return;
        if (recovery) {
          this._teLastSelected = recovery.anchor;
          if (this._teSessionRecovery === recovery) this._teSessionRecovery = null;
        }
        if (openPath && this._teFindByPath(openPath)) {
          this.tagEditorSelected = [openPath];
          this._teLastSelected = openPath;
          this._updateEditorPanel();
          this.$nextTick?.(() => {
            if (epoch === this._teLoadEpoch && this.currentRoute === 'tagEditor' && this.tagEditorSelected[0] === openPath) this._teFocusEditorInput();
          });
        }
        this.tagEditorLoadSnapshots(epoch);
        if (!recovery) this._teCheckDraft();
        this._teStartAutoSave();
      } else {
        this.toast(j.message || this.t('common.error'), 'error');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (epoch !== this._teLoadEpoch) return;
      this.toast(this.t('common.networkError'), 'error');
    } finally {
      if (epoch === this._teLoadEpoch) {
        this.tagEditorLoading = false;
        this._teLoadAbort = null;
        this.finishProgress();
      }
    }
  },

  tagEditorRequestSwitch() {
    this.tagEditorPendingDir = this.tagEditorLoadedDir || this.tagEditorDir || '';
    this.tagEditorSwitchOpen = !this.tagEditorSwitchOpen;
    if (this.tagEditorSwitchOpen) {
      var self = this;
      this.$nextTick(function() {
        var input = document.getElementById('te-switch-dir-input');
        if (input) { input.focus(); input.select(); }
      });
    }
  },

  tagEditorConfirmSwitch() {
    var nextDir = (this.tagEditorPendingDir || '').trim();
    if (!nextDir || nextDir === this.tagEditorLoadedDir) { this.tagEditorSwitchOpen = false; return; }
    var self = this;
    var run = function() { self._teRemoveDraft(); self.tagEditorLoad(nextDir); };
    if (this.tagEditorModifiedCount() > 0) {
      this._teConfirmUnsaved(this.t('tagEditor.unsavedConfirm'), run);
    } else run();
  },

  tagEditorCloseDataset() {
    var self = this;
    var closeNow = function() {
      self.tagEditorCleanup();
      self.tagEditorDir = '';
      self.tagEditorLoadedDir = '';
      self.tagEditorPendingDir = '';
      self.tagEditorImages = [];
      self.tagEditorPageItems = [];
      self.tagEditorDatasetCount = 0;
      self.tagEditorFilteredTotal = 0;
      self.tagEditorServerTotalPages = 1;
      self.tagEditorNoTagCount = 0;
      self.tagEditorOriginal = {};
      self.tagEditorSelected = [];
      self.tagEditorTagFreq = [];
      self.tagEditorTimeline = [];
      self.tagEditorSnapshots = [];
      self.tagEditorModified = false;
      self._teModifiedCount = 0;
      self._teRebuildPathIndex();
      try { sessionStorage.removeItem('tagEditor_lastDir'); } catch (e) {}
    };
    if (this.tagEditorModifiedCount() > 0) {
      this._teConfirmUnsaved(this.t('tagEditor.unsavedConfirm'), closeNow);
    } else closeNow();
  },
  async tagEditorLoadTagFreq() {
    if (!this.tagEditorDir || !this.tagEditorAllowsTagOps()) return;
    var epoch = this._teLoadEpoch, modeEpoch = this._teModeEpoch;
    try {
      var r = await fetch('/api/tageditor/tags?dir=' + encodeURIComponent(this.tagEditorDir) + '&recursive=' + (this.tagEditorRecursive ? 'true' : 'false'));
      var j = await r.json();
      if (epoch !== this._teLoadEpoch || modeEpoch !== this._teModeEpoch) return;
      if (j.status === 'success') {
        this.tagEditorTagFreq = j.data.tags || [];
        this.tagEditorMaxFreq = this.tagEditorTagFreq.length > 0 ? this.tagEditorTagFreq[0].count : 0;
        this._teRebuildFreqIndex();
        this._teGetModified().forEach(img => this._teUpdateFreq(this.tagEditorOriginal[img.path] || '', img.tags));
        this._teInvalidateFreq();
      } else {
        this._teClearFreqData();
      }
    } catch (e) {
      if (epoch === this._teLoadEpoch && modeEpoch === this._teModeEpoch) this._teClearFreqData();
    }
  },

  tagEditorReloadDir() {
    if (this.tagEditorModifiedCount() > 0) {
      var self = this;
      this._teConfirmUnsaved(this.t('tagEditor.revertConfirm'), function() {
        self._teRemoveDraft();
        self.tagEditorLoad(self.tagEditorDir);
      });
    } else {
      this.tagEditorLoad(this.tagEditorDir);
    }
  },

  tagEditorToggleRecursive() {
    var self = this;
    var nextRecursive = !this.tagEditorRecursive;
    var applyToggle = function() {
      if (self.tagEditorModifiedCount() > 0) self._teRemoveDraft();
      self.tagEditorRecursive = nextRecursive;
      if (self.tagEditorDir) self.tagEditorLoad(self.tagEditorDir);
    };
    if (this.tagEditorModifiedCount() > 0) {
      this._teConfirmUnsaved(this.t('tagEditor.recursiveUnsavedConfirm'), applyToggle);
      return;
    }
    applyToggle();
  },
  async _teFetchAllSessionItems(useCurrentFilters) {
    if (useCurrentFilters && this.tagEditorQuickFilter === 'modified') return this._teFilterImages(this._teGetModified());
    if (!this.tagEditorSessionId) return this.tagEditorGetFiltered().slice();
    if (this._teAllAbort) this._teAllAbort.abort();
    var controller = new AbortController();
    this._teAllAbort = controller;
    var sessionId = this.tagEditorSessionId;
    var epoch = this._teLoadEpoch;
    var queryKey = this._teSessionQueryKey(1);
    var assertCurrent = () => {
      if (controller.signal.aborted || epoch !== this._teLoadEpoch || sessionId !== this.tagEditorSessionId ||
          (useCurrentFilters && queryKey !== this._teSessionQueryKey(1))) {
        var error = new Error('Dataset request cancelled');
        error.name = 'AbortError';
        throw error;
      }
    };
    var base = this._teSessionQuery(1, useCurrentFilters);
    var requestOptions = this._teCaptionQueryOptions(controller.signal, useCurrentFilters);
    base.set('page_size', '240');
    var all = [];
    var totalPages = 1;
    var generation;
    try {
      for (var page = 1; page <= totalPages; page++) {
        assertCurrent();
        base.set('page', String(page));
        var response = await fetch('/api/tageditor/sessions/' + encodeURIComponent(sessionId) + '/images?' + base.toString(), requestOptions);
        var payload = await response.json();
        assertCurrent();
        if (payload.status !== 'success') throw new Error(payload.message || this.t('common.error'));
        var data = payload.data || {};
        if (page === 1) generation = data.generation;
        else if (generation !== data.generation) throw new Error(this.t('common.error'));
        totalPages = Number(data.total_pages || 1);
        for (var item of data.items || []) all.push(item);
      }
      var currentItems = this.tagEditorPageItems.slice();
      this._teMergeSessionItems(all, false);
      this.tagEditorPageItems = currentItems;
      return all.map(function(item) { return this._teFindByPath(item.path); }, this).filter(Boolean);
    } catch (error) {
      assertCurrent();
      throw error;
    } finally {
      if (this._teAllAbort === controller) this._teAllAbort = null;
    }
  },

  async _teEnsureAllImagesLoaded() {
    var epoch = this._teLoadEpoch;
    if (this.tagEditorSessionId && this.tagEditorImages.length < this.tagEditorDatasetCount) {
      this._teSearchLoading = true;
      try {
        await this._teFetchAllSessionItems(false);
      } finally {
        if (epoch === this._teLoadEpoch && !this._teAllAbort && !this._tePageAbort) this._teSearchLoading = false;
      }
    }
    return this.tagEditorImages;
  },
};
