/* ================================================================
   tag-editor.js — Tag Editor v3: 3-Column Layout
   Alpine.js mixin: left tag cloud, center image grid, right editor panel
   ================================================================ */

// ===== Top-level utilities (no `this` dependency, callable from any context) =====
function _teParseTags(s, lower) {
  if (!s) return [];
  var parts = s.split(',');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].trim();
    if (!t) continue;
    out.push(lower ? t.toLowerCase() : t);
  }
  return out;
}

function _teSuggestFromFreq(freq, query, limit, onResult) {
  var q = (query || '').toLowerCase();
  if (!q) { onResult([]); return; }
  var out = [];
  for (var i = 0; i < freq.length && out.length < limit; i++) {
    if (freq[i].tag.toLowerCase().indexOf(q) !== -1) out.push(freq[i].tag);
  }
  onResult(out);
}

function _teGetSuggestCoords(inputEl) {
  var rect = inputEl.getBoundingClientRect();
  var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  var margin = 8;
  var gap = 4;
  // 词典条目是"名称 + 中文 + 别名"的多行块，比纯标签列表高，宽度也要给够
  var width = Math.min(Math.max(rect.width, 240), Math.max(0, viewportWidth - margin * 2));
  var maxLeft = Math.max(margin, viewportWidth - width - margin);
  var left = Math.min(Math.max(rect.left, margin), maxLeft);
  var maxHeight = Math.max(0, Math.min(300, rect.top - gap - margin));
  var bottom = Math.max(margin, viewportHeight - rect.top + gap);
  return {
    left: Math.round(left),
    bottom: Math.round(bottom),
    width: Math.round(width),
    maxHeight: Math.floor(maxHeight)
  };
}

function _teGetCurrentToken(val, pos) {
  if (!val) return '';
  var before = val.substring(0, pos);
  var after = val.substring(pos);
  var startIdx = before.lastIndexOf(',');
  startIdx = startIdx === -1 ? 0 : startIdx + 1;
  var endIdx = after.indexOf(',');
  var tokenEnd = endIdx === -1 ? val.length : pos + endIdx;
  return val.substring(startIdx, tokenEnd).trim();
}

function _teReplaceToken(val, pos, suggestion) {
  var before = val.substring(0, pos);
  var after = val.substring(pos);
  var startIdx = before.lastIndexOf(',');
  startIdx = startIdx === -1 ? 0 : startIdx + 1;
  var endIdx = after.indexOf(',');
  var tokenEnd = endIdx === -1 ? val.length : pos + endIdx;

  var prefix = val.substring(0, startIdx);
  var suffix = val.substring(tokenEnd);
  var inserted = prefix + (prefix.trim() ? ' ' : '') + suggestion;
  return suffix
    ? { text: inserted + suffix, caretPos: inserted.length }
    : { text: inserted + ', ', caretPos: inserted.length + 2 };
}

window.tagEditorMixin = {

  // ===== Core State =====
  tagEditorDir: '',
  tagEditorRecursive: true,
  tagEditorImages: [],
  tagEditorOriginal: {},
  tagEditorModified: false,
  tagEditorTagFreq: [],
  tagEditorMaxFreq: 0,
  tagEditorLoading: false,
  tagEditorSaving: false,
  tagEditorLoadedDir: '',
  tagEditorPendingDir: '',
  tagEditorSwitchOpen: false,
  tagEditorTimeline: [],
  tagEditorRightWidth: 340,
  tagEditorLeftWidth: 260,
  _teResizeSide: 'right',
  tagEditorPreviewRatio: 0.5,
  _tePreviewDrag: null,
  tagEditorResizing: false,
  _teGridResizeObserver: null,
  tagEditorSessionId: '',
  tagEditorSessionGeneration: 0,
  tagEditorSessionRevision: '',
  tagEditorDatasetCount: 0,
  tagEditorFilteredTotal: 0,
  tagEditorServerTotalPages: 1,
  tagEditorPageItems: [],
  tagEditorNoTagCount: 0,

  // ===== Filters & Search =====
  tagEditorSearchQuery: '',
  tagEditorUseRegex: false,
  tagEditorRegexError: false,
  tagEditorQuickFilter: 'all',
  tagEditorSortBy: 'name',
  tagEditorSortAsc: true,
  tagEditorSortBy2: '',
  tagEditorSortAsc2: true,
  tagEditorTagSearch: '',
  tagEditorTagLogic: 'AND',
  tagEditorTagSelection: [],
  tagEditorExcludedTags: [],
  tagEditorTagSortBy: 'freq',
  tagEditorTagSortAsc: false,
  tagEditorTagCloudLimit: 500,
  tagEditorInlineEdit: null,
  _teCloudShowAll: false,
  _teSearchLoading: false,

  // ===== Selection & Grid =====
  tagEditorSelected: [],
  tagEditorPage: 1,
  tagEditorPageSize: 60,
  tagEditorContextMenu: null,
  tagEditorImageContextMenu: null,
  tagEditorPanelMenu: null,
  tagEditorQuickRemove: false,
  tagEditorRemovalTags: [],
  tagEditorLeftCollapsed: false,
  _teLastSelected: null,

  // ===== Image Lightbox =====
  tagEditorLightboxOpen: false,
  tagEditorLightboxImage: null,
  tagEditorLightboxLoading: false,
  tagEditorLightboxSrc: '',
  _teLightboxRequest: 0,
  tagEditorLightboxScale: 1,
  tagEditorLightboxX: 0,
  tagEditorLightboxY: 0,
  tagEditorLightboxPanning: false,
  tagEditorLightboxPointerId: null,
  tagEditorLightboxPanStartX: 0,
  tagEditorLightboxPanStartY: 0,
  _teLightboxPreviousSelection: null,

  // ===== Right Panel Editor =====
  tagEditorDetailView: 'chip',
  tagEditorDetailText: '',
  tagEditorAddInput: '',
  tagEditorSuggestions: [],
  _teSuggestCoords: null,
  _teSuggestInputEl: null,
  tagEditorSuggestIdx: -1,
  _teSuggestTimer: null,
  _teBlurTimer: null,
  _teSuggestSeq: 0,
  _teLocalSuggestTags: [],
  tagEditorDetailDragOverIdx: -1,
  tagEditorDetailDragSrcIdx: -1,
  tagEditorDetailDragOverPos: '',

  // ===== Batch Operations =====
  tagEditorBatchMode: 'add',
  tagEditorBatchTagFilter: 'all',
  batchAddInput: '',
  batchRemoveInput: '',
  batchOldTag: '',
  batchNewTag: '',
  tagEditorBatchPos: 'front',
  batchSuggestOpen: null,
  batchSuggestItems: [],
  batchSuggestIdx: -1,
  _teBatchSuggestTimer: null,
  _teBatchBlurTimer: null,

  // ===== Clipboard =====
  tagEditorCopiedTags: [],

  // ===== Undo/Redo =====
  tagEditorHistory: [],
  tagEditorHistoryIdx: -1,
  tagEditorHistoryOpen: false,

  // ===== Sidebar Tabs =====
  tagEditorSidebarTab: 'tags',
  tagEditorHistoryDetailIdx: -1,
  _teDiffExpanded: {},
  _teDiffReorderExpanded: {},

  // ===== Snapshots =====
  tagEditorSnapshots: [],
  tagEditorSnapshotLoading: false,
  tagEditorSnapshotBusy: false,
  tagEditorSnapshotError: false,

  tagEditorShortcutsOpen: false,

  // ===== Auto-save =====
  _teAutoSaveInterval: null,
  _tePendingTextEdits: {},
  _teDraftSavedAt: '',

  // ===== Cache =====
  _teFilteredCacheKey: '',
  _teFreqCacheKey: '',
  _teCachedFiltered: null,
  _teCachedFreqResult: null,
  _teCachedSelectedStatsKey: '',
  _teCachedSelectedStats: null,
  _teCachedDiffKey: -2,
  _teCachedDiffResult: null,
  _teSearchDebounce: null,
  _teTagSearchDebounce: null,
  _teIsSaving: false,
  _teSaveProgress: 0,
  _teModifiedCount: 0,
  _tePathIndex: null,
  _teQuickCountNoTag: undefined,
  _teQuickCountMod: undefined,
  _teFreqIndex: null,
  _teFreqFinalizeScheduled: false,
  _teHistoryState: null,
  _teLoadEpoch: 0,
  _teLoadAbort: null,
  _tePageAbort: null,
  _tePageEpoch: 0,
  _teAllAbort: null,
  _tePageCache: null,
  _tePageFetchTimer: null,
  _teTimelineAbort: null,
  _teSaveEpoch: 0,
  _teEditVersions: null,
  _teCaptionRevisions: null,
  // ===== Internal Utilities =====
  _teInvalidateFilter() {
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    this._teQuickCountNoTag = undefined;
    this._teQuickCountMod = undefined;
    this._teCachedSelectedStatsKey = '';
    this._teCachedSelectedStats = null;
  },
  _teInvalidateFreq() {
    this._teFreqCacheKey = '';
    this._teCachedFreqResult = null;
  },
  _teInvalidateDiff() {
    this._teCachedDiffKey = -2;
    this._teCachedDiffResult = null;
  },
  _teRebuildFreqIndex() {
    var index = new Map();
    for (var i = 0; i < this.tagEditorTagFreq.length; i++) {
      index.set(this.tagEditorTagFreq[i].tag, this.tagEditorTagFreq[i]);
    }
    this._teFreqIndex = index;
    this._teInvalidateFreq();
    if (typeof this._tdRequestChips === 'function') this._tdRequestChips();
    if (this.tagEditorTagSearch) this.tagEditorSetTagSearch(this.tagEditorTagSearch);
  },
  _teClearFreqData() {
    this.tagEditorTagFreq = [];
    this.tagEditorMaxFreq = 0;
    this._teFreqIndex = new Map();
    this._teInvalidateFreq();
  },
  _teScheduleFreqFinalize() {
    if (this._teFreqFinalizeScheduled) return;
    this._teFreqFinalizeScheduled = true;
    var self = this;
    queueMicrotask(function() {
      self._teFreqFinalizeScheduled = false;
      self.tagEditorTagFreq = self.tagEditorTagFreq.filter(function(item) { return item.count > 0; });
      self.tagEditorMaxFreq = self.tagEditorTagFreq.reduce(function(max, item) { return Math.max(max, item.count); }, 0);
      self._teRebuildFreqIndex();
      self._teInvalidateFreq();
    });
  },
  _teGetModified() {
    var orig = this.tagEditorOriginal;
    var out = [];
    var imgs = this.tagEditorImages;
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].tags !== orig[imgs[i].path]) out.push(imgs[i]);
    }
    return out;
  },
  _teFindByPath(path) {
    var map = this._tePathIndex;
    if (!map) {
      map = {};
      var imgs = this.tagEditorImages;
      for (var i = 0; i < imgs.length; i++) map[imgs[i].path] = imgs[i];
      this._tePathIndex = map;
    }
    return map[path] || null;
  },
  _teRebuildPathIndex() {
    var map = {};
    var imgs = this.tagEditorImages;
    for (var i = 0; i < imgs.length; i++) map[imgs[i].path] = imgs[i];
    this._tePathIndex = map;
  },
  _teFindCurrentFilteredIdx() {
    if (this.tagEditorSelected.length !== 1) return -1;
    var filtered = this.tagEditorGetFiltered();
    var path = this.tagEditorSelected[0];
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].path === path) return i;
    }
    return -1;
  },
  _teTagListToggle(list, other, tag) {
    var idx = list.indexOf(tag);
    if (idx === -1) {
      list.push(tag);
      var oIdx = other.indexOf(tag);
      if (oIdx !== -1) other.splice(oIdx, 1);
      return true;
    }
    list.splice(idx, 1);
    return false;
  },
  _teRecountModified() {
    var orig = this.tagEditorOriginal;
    var c = 0;
    var imgs = this.tagEditorImages;
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].tags !== orig[imgs[i].path]) c++;
    }
    this._teModifiedCount = c;
    return c;
  },
  _teBumpModified(delta) {
    if (this._teModifiedCount === undefined) {
      this._teRecountModified();
      return;
    }
    this._teModifiedCount = Math.max(0, this._teModifiedCount + delta);
  },
  _teImageLabel(img) {
    return img ? (img.rel_path || img.name || '') : '';
  },
  _teIsEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    var tagName = target.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    return typeof target.closest === 'function' && !!target.closest('[contenteditable="true"], [contenteditable=""]');
  },
  _teDiscardPendingTextEdits() {
    var keys = Object.keys(this._tePendingTextEdits);
    for (var i = 0; i < keys.length; i++) clearTimeout(this._tePendingTextEdits[keys[i]]);
    this._tePendingTextEdits = {};
  },
  _teFlushPendingTextEdit(path) {
    if (!Object.prototype.hasOwnProperty.call(this._tePendingTextEdits, path)) return;
    clearTimeout(this._tePendingTextEdits[path]);
    delete this._tePendingTextEdits[path];
    var img = this._teFindByPath(path);
    if (!img) return;
    this._tePushHistory({
      type: 'text',
      desc: this.t('tagEditor.historyStepText') + ' · ' + this._teImageLabel(img),
      affected: 1,
      paths: [path]
    });
  },
  _teFlushAllPendingTextEdits() {
    var paths = Object.keys(this._tePendingTextEdits);
    for (var i = 0; i < paths.length; i++) this._teFlushPendingTextEdit(paths[i]);
  },
  // ===== Lifecycle =====
  tagEditorCleanup() {
    this._teLoadEpoch++;
    if (this._teLoadAbort) { this._teLoadAbort.abort(); this._teLoadAbort = null; }
    this._teCancelPageFetch();
    if (this._teAllAbort) { this._teAllAbort.abort(); this._teAllAbort = null; }
    if (this._teTimelineAbort) { this._teTimelineAbort.abort(); this._teTimelineAbort = null; }
    this._teCloseSession(this.tagEditorSessionId);
    this.tagEditorSessionId = '';
    this.tagEditorStopResize();
    this.tagEditorStopPreviewResize();
    this.tagEditorCloseLightbox();
    this._teStopAutoSave();
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    if (this._teBatchBlurTimer) { clearTimeout(this._teBatchBlurTimer); this._teBatchBlurTimer = null; }
    if (this._teSearchDebounce) { clearTimeout(this._teSearchDebounce); this._teSearchDebounce = null; }
    if (this._teTagSearchDebounce) { clearTimeout(this._teTagSearchDebounce); this._teTagSearchDebounce = null; }
    this._teDiscardPendingTextEdits();
    // Worker 留着复用（换回本页不用再下词典），只清掉悬停卡与待发请求
    this.tagDictionaryCleanup();
  },

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
    return params;
  },

  _teSessionQueryKey(page, useFilters = true) {
    return this._teSessionQuery(page, useFilters).toString();
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
    this._teCancelPageFetch();
    if (!this.tagEditorSessionId) return;
    var targetPage = Math.max(1, Number(page || this.tagEditorPage || 1));
    if (this.tagEditorQuickFilter === 'modified') {
      this.tagEditorPage = targetPage;
      this.tagEditorSchedulePageFetch(false);
      return;
    }
    var cacheKey = this._teSessionQueryKey(targetPage);
    if (!(options && options.force) && this._tePageCache && this._tePageCache[cacheKey]) {
      this._teApplySessionPage(this._tePageCache[cacheKey], false);
      return;
    }
    var epoch = this._tePageEpoch;
    var controller = new AbortController();
    this._tePageAbort = controller;
    this._teSearchLoading = true;
    try {
      var response = await fetch('/api/tageditor/sessions/' + encodeURIComponent(this.tagEditorSessionId) + '/images?' + this._teSessionQuery(targetPage).toString(), { signal: controller.signal });
      var payload = await response.json();
      if (epoch !== this._tePageEpoch || controller.signal.aborted) return;
      if (payload.status !== 'success') {
        if (payload.code === 'session_expired') return this.tagEditorReloadSessionPage(targetPage);
        this.toast(payload.message || this.t('common.error'), 'error');
        return;
      }
      this._teApplySessionPage(payload.data || {}, false);
    } catch (e) {
      if (epoch === this._tePageEpoch && !controller.signal.aborted && (!e || e.name !== 'AbortError')) this.toast(this.t('common.networkError'), 'error');
    } finally {
      if (epoch === this._tePageEpoch) {
        this._teSearchLoading = false;
        this._tePageAbort = null;
      }
    }
  },

  tagEditorSchedulePageFetch(resetPage) {
    this._teCancelPageFetch();
    if (this._teAllAbort) this._teAllAbort.abort();
    if (resetPage) this.tagEditorPage = 1;
    if (this.tagEditorQuickFilter === 'modified') {
      var modified = this._teGetModified();
      var size = Number(this.tagEditorPageSize) || 60;
      this.tagEditorFilteredTotal = modified.length;
      this.tagEditorServerTotalPages = Math.max(1, Math.ceil(modified.length / size));
      var start = (this.tagEditorPage - 1) * size;
      this.tagEditorPageItems = modified.slice(start, start + size);
      return;
    }
    var self = this;
    this._tePageFetchTimer = setTimeout(function() {
      self._tePageFetchTimer = null;
      self.tagEditorFetchPage(self.tagEditorPage, { force: true });
    }, 80);
  },

  async tagEditorReloadSessionPage(page) {
    var drafts = {};
    var self = this;
    this._teGetModified().forEach(function(img) {
      drafts[img.path] = {
        image: Object.assign({}, img),
        original: self.tagEditorOriginal[img.path],
        editVersion: (self._teEditVersions && self._teEditVersions[img.path]) || 0,
        captionRevision: self._teCaptionRevisions ? self._teCaptionRevisions[img.path] : 'missing'
      };
    });
    await this.tagEditorLoad(this.tagEditorLoadedDir || this.tagEditorDir, { preserveDrafts: drafts, targetPage: page || 1 });
  },

  async tagEditorLoad(dir) {
    this.tagEditorCancelQuickRemove();
    this.tagEditorPanelMenu = null;
    var loadOptions = arguments.length > 1 && arguments[1] ? arguments[1] : {};
    var self = this;
    // 词典只在真正进入 Tag Editor 时才加载：问状态，数据已装就拉起唯一那个 Worker
    this.tagDictionaryInit();
    this.tagDictionaryEnsureWorker();
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
    var epoch = ++this._teLoadEpoch;
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
        if (Array.isArray(j.data.tags)) {
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
            self.tagEditorImages.push(img);
            self._tePathIndex[path] = img;
          }
          if (img && draft) {
            self.tagEditorOriginal[path] = draft.original;
            self._teEditVersions[path] = draft.editVersion;
            self._teCaptionRevisions[path] = draft.captionRevision;
            img.tags = draft.image.tags;
          }
        });
        this._teRecountModified();
        this.tagEditorModified = this._teModifiedCount > 0;
        if (this._teSessionQueryKey(this.tagEditorPage) !== this._teSessionQueryKey(Number(j.data.page || 1), false)) {
          await this.tagEditorFetchPage(this.tagEditorPage, { force: true });
        }
        if (epoch !== this._teLoadEpoch || controller.signal.aborted) return;
        this.tagEditorLoadSnapshots(epoch);
        this._teCheckDraft();
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

  tagEditorStartResize(e, side) {
    if (e.button !== undefined && e.button !== 0) return;
    this._teResizeSide = side || 'right';
    this.tagEditorResizing = true;
    document.body.classList.add('te-resizing');
  },

  tagEditorResize(e) {
    if (!this.tagEditorResizing) return;
    var main = document.querySelector('.te-main[data-te-main="active"]');
    if (!main) return;
    var rect = main.getBoundingClientRect();
    var side = this._teResizeSide;
    this.tagEditorSetPanelWidth(side, side === 'left' ? e.clientX - rect.left : rect.right - e.clientX);
  },

  tagEditorSetPanelWidth(side, width) {
    var left = side === 'left';
    var main = document.querySelector('.te-main[data-te-main="active"]');
    var other = left ? this.tagEditorRightWidth : (this.tagEditorLeftCollapsed ? 0 : this.tagEditorLeftWidth);
    var min = left ? 180 : 280;
    var max = left ? 420 : 520;
    if (main && main.clientWidth) max = Math.min(max, Math.max(min, main.clientWidth - other - 196));
    this[left ? 'tagEditorLeftWidth' : 'tagEditorRightWidth'] = Math.max(min, Math.min(max, width));
  },

  tagEditorStopResize() {
    if (!this.tagEditorResizing) return;
    this.tagEditorResizing = false;
    document.body.classList.remove('te-resizing');
    try { localStorage.setItem('tagEditor_rightWidth', String(Math.round(this.tagEditorRightWidth))); } catch (e) {}
    try { localStorage.setItem('tagEditor_leftWidth', String(Math.round(this.tagEditorLeftWidth))); } catch (e) {}
    this.tagEditorRefreshSuggestPosition();
  },

  tagEditorAdjustRightWidth(delta) {
    this.tagEditorSetPanelWidth('right', this.tagEditorRightWidth + delta);
    try { localStorage.setItem('tagEditor_rightWidth', String(Math.round(this.tagEditorRightWidth))); } catch (e) {}
    this.tagEditorRefreshSuggestPosition();
  },

  tagEditorAdjustLeftWidth(delta) {
    this.tagEditorSetPanelWidth('left', this.tagEditorLeftWidth + delta);
    try { localStorage.setItem('tagEditor_leftWidth', String(Math.round(this.tagEditorLeftWidth))); } catch (e) {}
  },

  tagEditorRestorePanelWidth() {
    var saved = 0;
    try { saved = parseInt(localStorage.getItem('tagEditor_rightWidth'), 10); } catch (e) {}
    this.tagEditorRightWidth = saved >= 280 && saved <= 520 ? saved : 340;
    try { saved = parseInt(localStorage.getItem('tagEditor_leftWidth'), 10); } catch (e) { saved = 0; }
    this.tagEditorLeftWidth = saved >= 180 && saved <= 420 ? saved : 260;
    try {
      var ratio = Number(localStorage.getItem('tagEditor_previewRatio'));
      this.tagEditorPreviewRatio = ratio >= 0.15 && ratio <= 0.85 ? ratio : 0.5;
    } catch (_) {}
  },

  tagEditorSetPreviewRatio(ratio, persist) {
    if (!Number.isFinite(ratio)) return;
    this.tagEditorPreviewRatio = Math.max(0.15, Math.min(0.85, ratio));
    if (persist) {
      try { localStorage.setItem('tagEditor_previewRatio', String(this.tagEditorPreviewRatio)); } catch (_) {}
    }
  },

  tagEditorStartPreviewResize(event) {
    if (event.button !== 0) return;
    var panel = event.currentTarget.closest('.te-editor-inner');
    var preview = panel.querySelector('.te-editor-preview');
    var body = panel.querySelector('.te-editor-lower');
    var height = preview.clientHeight + body.clientHeight;
    if (!height) return;
    event.preventDefault();
    this.tagDictionaryCloseHover();
    this._tePreviewDrag = { y: event.clientY, height: height, preview: preview.clientHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('te-preview-resizing');
  },

  tagEditorMovePreviewResize(event) {
    var drag = this._tePreviewDrag;
    if (!drag) return;
    var minimum = Math.min(96 / drag.height, 0.5);
    var ratio = (drag.preview + event.clientY - drag.y) / drag.height;
    this.tagEditorSetPreviewRatio(Math.max(minimum, Math.min(1 - minimum, ratio)), false);
  },

  tagEditorStopPreviewResize() {
    if (!this._tePreviewDrag) return;
    this._tePreviewDrag = null;
    document.body.classList.remove('te-preview-resizing');
    this.tagEditorSetPreviewRatio(this.tagEditorPreviewRatio, true);
    this.tagEditorRefreshSuggestPosition();
  },

  tagEditorInitLayout() {
    var self = this;
    this.$nextTick(function() {
      var grid = document.getElementById('teV3Grid');
      if (!grid) return;
      if (self._teGridResizeObserver) self._teGridResizeObserver.disconnect();
      var update = function() { self._teUpdateGridCardSize(grid); };
      self._teGridResizeObserver = new ResizeObserver(update);
      self._teGridResizeObserver.observe(grid);
      update();
    });
  },

  _teUpdateGridCardSize(grid) {
    if (!grid || grid.clientWidth <= 0) return;
    var style = getComputedStyle(grid);
    var gap = parseFloat(style.columnGap) || 8;
    var padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    var available = Math.max(1, grid.clientWidth - padding);
    var minSize = 160;
    var columns = Math.max(1, Math.floor((available + gap) / (minSize + gap)));
    var size = Math.max(minSize, Math.floor((available - gap * (columns - 1)) / columns));
    grid.style.setProperty('--te-card-size', size + 'px');
  },

  async tagEditorLoadTagFreq() {
    if (!this.tagEditorDir) return;
    try {
      var r = await fetch('/api/tageditor/tags?dir=' + encodeURIComponent(this.tagEditorDir) + '&recursive=' + (this.tagEditorRecursive ? 'true' : 'false'));
      var j = await r.json();
      if (j.status === 'success') {
        this.tagEditorTagFreq = j.data.tags || [];
        this.tagEditorMaxFreq = this.tagEditorTagFreq.length > 0 ? this.tagEditorTagFreq[0].count : 0;
        this._teRebuildFreqIndex();
        this._teInvalidateFreq();
      } else {
        this._teClearFreqData();
      }
    } catch (e) {
      this._teClearFreqData();
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

  // ===== Filtering & Sorting =====
  _teValidateRegex(query) {
    // 提前在写入入口校验正则，避免在 getter 求值期写响应式状态（A4）。
    if (!this.tagEditorUseRegex || !query) { this.tagEditorRegexError = false; return; }
    try { new RegExp(query, 'i'); this.tagEditorRegexError = false; }
    catch (e) { this.tagEditorRegexError = true; }
  },
  tagEditorSetSearch(val) {
    this._teValidateRegex(val);
    if (this._teSearchDebounce) clearTimeout(this._teSearchDebounce);
    var self = this;
    this._teSearchLoading = true;
    this._teSearchDebounce = setTimeout(function() {
      self.tagEditorSearchQuery = val;
      self._teSearchDebounce = null;
      self._teSearchLoading = false;
      self.tagEditorSchedulePageFetch(true);
    }, 150);
  },
  tagEditorClearSearch() {
    if (this._teSearchDebounce) { clearTimeout(this._teSearchDebounce); this._teSearchDebounce = null; }
    this._teSearchLoading = false;
    this.tagEditorRegexError = false;
    this.tagEditorSearchQuery = '';
    this.tagEditorSchedulePageFetch(true);
  },
  tagEditorSetTagSearch(val) {
    if (this._teTagSearchDebounce) clearTimeout(this._teTagSearchDebounce);
    var seq = this._teTagSearchSeq = (this._teTagSearchSeq || 0) + 1;
    this.tagEditorTagSearch = val;
    this._teTagSearchMatches = null;
    this._teInvalidateFreq();
    if (!val.trim()) { this._tdRequestChips(); return; }
    var self = this;
    this._teTagSearchDebounce = setTimeout(function() {
      self._teTagSearchDebounce = null;
      self.tagDictionaryFilterTags(self.tagEditorTagFreq.map(function(item) { return item.tag; }), val).then(function(matches) {
        if (seq !== self._teTagSearchSeq) return;
        self._teTagSearchMatches = matches ? new Set(matches) : null;
        self._teInvalidateFreq();
        self._tdRequestChips();
      });
    }, 150);
  },
  tagEditorClearTagSearch() {
    if (this._teTagSearchDebounce) { clearTimeout(this._teTagSearchDebounce); this._teTagSearchDebounce = null; }
    this.tagEditorTagSearch = '';
    this._teTagSearchSeq = (this._teTagSearchSeq || 0) + 1;
    this._teTagSearchMatches = null;
  },
  tagEditorGetFiltered() {
    if (this.tagEditorSessionId) return this.tagEditorPageItems;
    var cacheKey = this.tagEditorSearchQuery + '|' + this.tagEditorQuickFilter + '|' +
      this.tagEditorTagSelection.join(',') + '|' + this.tagEditorExcludedTags.join(',') + '|' +
      this.tagEditorTagLogic + '|' + this.tagEditorSortBy + '|' + this.tagEditorSortAsc + '|' +
      this.tagEditorSortBy2 + '|' + this.tagEditorSortAsc2 + '|' +
      this.tagEditorUseRegex;
    if (cacheKey === this._teFilteredCacheKey && this._teCachedFiltered) return this._teCachedFiltered;

    var images = this.tagEditorImages.slice();

    if (this.tagEditorQuickFilter === 'notag') {
      images = images.filter(function(img) { return !img.tags || img.tags.trim() === ''; });
    } else if (this.tagEditorQuickFilter === 'modified') {
      var orig = this.tagEditorOriginal;
      images = images.filter(function(img) { return img.tags !== orig[img.path]; });
    }

    if (this.tagEditorSearchQuery) {
      var q = this.tagEditorSearchQuery.toLowerCase();
      if (this.tagEditorUseRegex) {
        // getter 只读不写：仅在正则有效时过滤，非法时回退为空结果（错误状态已由 _teValidateRegex 提前设置）
        var reOk = null;
        try { reOk = new RegExp(this.tagEditorSearchQuery, 'i'); } catch (e) { reOk = null; }
        if (reOk) {
          images = images.filter(function(img) {
            return reOk.test(img.rel_path || img.name) || reOk.test(img.tags || '');
          });
        } else {
          images = [];
        }
      } else {
        images = images.filter(function(img) {
          return (img.rel_path || img.name).toLowerCase().indexOf(q) !== -1 ||
            (img.tags || '').toLowerCase().indexOf(q) !== -1;
        });
      }
    }

    var self = this;
    if (this.tagEditorTagSelection.length > 0) {
      var sel = this.tagEditorTagSelection;
      if (this.tagEditorTagLogic === 'AND') {
        images = images.filter(function(img) {
          var parts = _teParseTags(img.tags, true);
          return sel.every(function(s) { return parts.indexOf(s.toLowerCase()) !== -1; });
        });
      } else {
        images = images.filter(function(img) {
          var parts = _teParseTags(img.tags, true);
          return sel.some(function(s) { return parts.indexOf(s.toLowerCase()) !== -1; });
        });
      }
    }

    if (this.tagEditorExcludedTags.length > 0) {
      var exc = this.tagEditorExcludedTags;
      images = images.filter(function(img) {
        var parts = _teParseTags(img.tags, true);
        return !exc.some(function(s) { return parts.indexOf(s.toLowerCase()) !== -1; });
      });
    }

    var sortBy = this.tagEditorSortBy;
    var asc = this.tagEditorSortAsc;
    var sortBy2 = this.tagEditorSortBy2;
    var asc2 = this.tagEditorSortAsc2;
    var orig = this.tagEditorOriginal;
    var needsTagCount = sortBy === 'tagCount' || sortBy2 === 'tagCount';
    var needsMod = sortBy === 'modified' || sortBy2 === 'modified';

    // Decorate-sort-undecorate: precompute tagCount / isMod once per image
    var decorated = new Array(images.length);
    for (var di = 0; di < images.length; di++) {
      var dimg = images[di];
      decorated[di] = {
        img: dimg,
        name: dimg.rel_path || dimg.name,
        tagCount: needsTagCount ? _teParseTags(dimg.tags).length : 0,
        isMod: needsMod ? (dimg.tags !== orig[dimg.path] ? 1 : 0) : 0
      };
    }

    function pickVal(d, sb) {
      if (sb === 'tagCount') return d.tagCount;
      if (sb === 'modified') return d.isMod;
      return d.name;
    }
    function cmpVal(va, vb, sb, dirAsc) {
      if (sb === 'name') return dirAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return dirAsc ? va - vb : vb - va;
    }

    decorated.sort(function(a, b) {
      var cmp = cmpVal(pickVal(a, sortBy), pickVal(b, sortBy), sortBy, asc);
      if (cmp === 0 && sortBy2) {
        cmp = cmpVal(pickVal(a, sortBy2), pickVal(b, sortBy2), sortBy2, asc2);
      }
      return cmp;
    });

    images = new Array(decorated.length);
    for (var ui = 0; ui < decorated.length; ui++) images[ui] = decorated[ui].img;

    this._teFilteredCacheKey = cacheKey;
    this._teCachedFiltered = images;
    return images;
  },

  tagEditorGetPaged() {
    if (this.tagEditorSessionId) return this.tagEditorPageItems;
    var filtered = this.tagEditorGetFiltered();
    var start = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    return filtered.slice(start, start + this.tagEditorPageSize);
  },

  tagEditorFilteredCount() {
    if (this.tagEditorSessionId) return this.tagEditorFilteredTotal;
    return this.tagEditorGetFiltered().length;
  },

  tagEditorTotalPages() {
    if (this.tagEditorSessionId) return this.tagEditorServerTotalPages;
    return Math.max(1, Math.ceil(this.tagEditorGetFiltered().length / this.tagEditorPageSize));
  },

  tagEditorGetPageNumbers() {
    var total = this.tagEditorTotalPages();
    var current = this.tagEditorPage;
    var pages = [];
    if (total <= 7) {
      for (var i = 1; i <= total; i++) pages.push(i);
    } else {
      pages.push(1);
      if (current > 3) pages.push('...');
      var start = Math.max(2, current - 1);
      var end = Math.min(total - 1, current + 1);
      for (var i2 = start; i2 <= end; i2++) pages.push(i2);
      if (current < total - 2) pages.push('...');
      pages.push(total);
    }
    return pages;
  },

  tagEditorGetQuickCount(type) {
    if (this.tagEditorSessionId && type === 'notag') return this.tagEditorNoTagCount;
    if (this.tagEditorSessionId && type === 'modified') return this._teModifiedCount;
    var images = this._teCachedFiltered || this.tagEditorImages;
    if (type === 'notag') {
      if (this._teQuickCountNoTag !== undefined) return this._teQuickCountNoTag;
      var c = 0;
      for (var i = 0; i < images.length; i++) {
        if (!images[i].tags || images[i].tags.trim() === '') c++;
      }
      this._teQuickCountNoTag = c;
      return c;
    }
    if (type === 'modified') {
      if (this._teQuickCountMod !== undefined) return this._teQuickCountMod;
      var orig = this.tagEditorOriginal;
      var c2 = 0;
      for (var j = 0; j < images.length; j++) {
        if (images[j].tags !== orig[images[j].path]) c2++;
      }
      this._teQuickCountMod = c2;
      return c2;
    }
    return 0;
  },

  // ===== Tag Cloud =====
  tagEditorGetFilteredTagFreq() {
    var cacheKey = this.tagEditorTagSearch + '|' + this.tagEditorTagSortBy + '|' + this.tagEditorTagSortAsc;
    if (cacheKey === this._teFreqCacheKey && this._teCachedFreqResult) return this._teCachedFreqResult;

    var freq = this.tagEditorTagFreq.slice();
    if (this.tagEditorTagSearch) {
      var q = this.tagEditorTagSearch.toLowerCase();
      var matches = this._teTagSearchMatches;
      freq = freq.filter(function(item) { return item.tag.toLowerCase().indexOf(q) !== -1 || (matches && matches.has(item.tag)); });
    }
    var sortBy = this.tagEditorTagSortBy;
    var asc = this.tagEditorTagSortAsc;
    freq.sort(function(a, b) {
      if (sortBy === 'alpha') return asc ? a.tag.localeCompare(b.tag) : b.tag.localeCompare(a.tag);
      if (sortBy === 'length') return asc ? a.tag.length - b.tag.length : b.tag.length - a.tag.length;
      return asc ? a.count - b.count : b.count - a.count;
    });

    this._teFreqCacheKey = cacheKey;
    this._teCachedFreqResult = freq;
    return freq;
  },

  tagEditorGetDisplayFreq() {
    var freq = this.tagEditorGetFilteredTagFreq();
    if (this._teCloudShowAll) return freq;
    return freq.slice(0, this.tagEditorTagCloudLimit);
  },

  tagEditorSelectTag(tag) {
    this._teTagListToggle(this.tagEditorTagSelection, this.tagEditorExcludedTags, tag);
    this._teInvalidateFilter();
    this.tagEditorSchedulePageFetch(true);
  },

  tagEditorExcludeTag(tag) {
    this._teTagListToggle(this.tagEditorExcludedTags, this.tagEditorTagSelection, tag);
    this._teInvalidateFilter();
    this.tagEditorSchedulePageFetch(true);
  },

  tagEditorTagCtx(e, tag) {
    // Reserve space for the shared menu sizing and rename action.
    var menuW = 220, menuH = 230;
    var x = Math.min(e.clientX, window.innerWidth - menuW - 4);
    var y = Math.min(e.clientY, window.innerHeight - menuH - 4);
    this.tagEditorImageContextMenu = null;
    this.tagEditorPanelMenu = null;
    this.tagEditorContextMenu = { x: x, y: y, tag: tag };
    this.tagDictionaryCloseHover();
  },

  tagEditorCtxInclude() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this._teTagListToggle(this.tagEditorTagSelection, this.tagEditorExcludedTags, tag)) {
      this._teInvalidateFilter();
      this.tagEditorSchedulePageFetch(true);
    }
    this.tagEditorContextMenu = null;
  },

  tagEditorCtxExclude() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this._teTagListToggle(this.tagEditorExcludedTags, this.tagEditorTagSelection, tag)) {
      this._teInvalidateFilter();
      this.tagEditorSchedulePageFetch(true);
    }
    this.tagEditorContextMenu = null;
  },

  tagEditorCtxCopy() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag) {
      navigator.clipboard.writeText(tag).catch(function() {});
      this.toast(this.t('tagEditor.singleTagCopied').replace('{tag}', tag));
    }
    this.tagEditorContextMenu = null;
  },

  tagEditorCtxAddAll() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    this.tagEditorContextMenu = null;
    if (!tag) return;
    var self = this;
    // B6: 给"加入全部"加二次确认（DeleteTag 已有），避免误点难撤销
    this._teConfirmBatch(
      this.t('tagEditor.ctxAddAllConfirm').replace('{tag}', tag).replace('{n}', this.tagEditorDatasetCount || this.tagEditorImages.length),
      async function() {
        var affected = 0;
        var images;
        try { images = await self._teEnsureAllImagesLoaded(); }
        catch (e) { if (e.name !== 'AbortError') self.toast(e.message || self.t('common.networkError'), 'error'); return; }
        images.forEach(function(img) {
          var tags = _teParseTags(img.tags);
          if (tags.indexOf(tag) === -1) {
            tags.push(tag);
            self._teUpdateImageTags(img, tags.join(', '));
            affected++;
          }
        });
        self._tePushHistory({ type: 'batchAdd', desc: '+ ' + tag + ' · ' + self.t('tagEditor.historyStepImages').replace('{n}', affected), affected: affected });
      });
  },

  tagEditorCtxDeleteTag() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    this.tagEditorContextMenu = null;
    if (!tag) return;
    var self = this;
    this._teConfirmBatch(
      this.t('tagEditor.deleteTagConfirm').replace('{tag}', tag),
      async function() {
        var affected = 0;
        var images;
        try { images = await self._teEnsureAllImagesLoaded(); }
        catch (e) { if (e.name !== 'AbortError') self.toast(e.message || self.t('common.networkError'), 'error'); return; }
        images.forEach(function(img) {
          var tags = _teParseTags(img.tags);
          var idx = tags.indexOf(tag);
          if (idx !== -1) {
            tags.splice(idx, 1);
            self._teUpdateImageTags(img, tags.join(', '));
            affected++;
          }
        });
        if (affected > 0) {
          self._tePushHistory({ type: 'tagDelete', desc: '− ' + tag + ' · ' + self.t('tagEditor.historyStepImages').replace('{n}', affected), affected: affected });
          self.toast(self.t('tagEditor.tagDeleted').replace('{tag}', tag).replace('{n}', affected));
        }
      });
  },

  // ===== Download dataset =====
  tagEditorDownloadZip() {
    window.open('/api/tageditor/download-zip?dir=' + encodeURIComponent(this.tagEditorDir), '_blank');
  },

  // ===== Restore from .bak backup =====
  tagEditorRestoreBackup() {
    var self = this;
    this.openConfirm(this.t('tagEditor.backupRestoreConfirmTitle'), this.t('tagEditor.restoreConfirm'), function() {
      fetch('/api/tageditor/restore-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: self.tagEditorDir })
      }).then(function(r) { return r.json(); }).then(function(j) {
        if (j.status === 'success') {
          self.toast(self.t('tagEditor.restored'));
          self.tagEditorLoad(self.tagEditorDir);
        } else {
          self.toast(j.message || self.t('common.error'), 'error');
        }
      });
    }, this.t('common.confirm'));
  },

  // ===== Card Interactions =====
  tagEditorImageCtx(e, img) {
    var menuW = 168, menuH = 38, margin = 4;
    var x = Math.max(margin, Math.min(e.clientX, window.innerWidth - menuW - margin));
    var y = Math.max(margin, Math.min(e.clientY, window.innerHeight - menuH - margin));
    this.tagEditorContextMenu = null;
    this.tagEditorPanelMenu = null;
    this.tagEditorImageContextMenu = { x: x, y: y, image: img };
    this.tagDictionaryCloseHover();
  },

  tagEditorCtxViewImage() {
    var img = this.tagEditorImageContextMenu && this.tagEditorImageContextMenu.image;
    this.tagEditorImageContextMenu = null;
    if (img) this.tagEditorOpenLightbox(img);
  },

  tagEditorOriginalUrl(img) {
    if (!img || !this.tagEditorSessionId) return '';
    if (img.preview) {
      var url = new URL(img.preview, window.location.href);
      url.searchParams.set('variant', 'original');
      url.searchParams.delete('size');
      return url.pathname + url.search;
    }
    var params = new URLSearchParams();
    params.set('scope', 'dataset');
    params.set('session_id', this.tagEditorSessionId);
    params.set('path', img.rel_path || img.name || '');
    params.set('variant', 'original');
    return '/api/image-preview?' + params.toString();
  },

  tagEditorOpenLightbox(img) {
    if (!img) return;
    if (!this.tagEditorLightboxOpen) this._teLightboxPreviousSelection = this.tagEditorSelected.slice();
    this.tagEditorSelected = [img.path];
    this._updateEditorPanel();
    this.tagEditorLightboxImage = img;
    this.tagEditorLightboxSrc = img.preview || img.thumbnail || '';
    this.tagEditorLightboxLoading = true;
    this.tagEditorLightboxOpen = true;
    this.tagEditorImageContextMenu = null;
    this.tagEditorResetLightbox();
    document.body.classList.add('te-lightbox-open');
    var self = this;
    var request = ++this._teLightboxRequest;
    var original = new Image();
    original.src = this.tagEditorOriginalUrl(img);
    original.decode().then(function() {
      if (request !== self._teLightboxRequest || !self.tagEditorLightboxOpen) return;
      self.tagEditorLightboxSrc = original.src;
      self.tagEditorLightboxLoading = false;
    }).catch(function() {
      if (request !== self._teLightboxRequest || !self.tagEditorLightboxOpen) return;
      self.tagEditorLightboxLoading = false;
      self.toast(self.t('common.networkError'), 'error');
    });
    this.$nextTick(function() {
      var closeButton = document.querySelector('.te-lightbox-close');
      if (closeButton) closeButton.focus();
    });
  },

  tagEditorCloseLightbox() {
    ++this._teLightboxRequest;
    this.tagEditorLightboxSrc = '';
    this.tagEditorLightboxOpen = false;
    this.tagEditorLightboxLoading = false;
    this.tagEditorLightboxImage = null;
    this.tagEditorStopLightboxPan();
    this.tagEditorResetLightbox();
    if (Array.isArray(this._teLightboxPreviousSelection)) {
      this.tagEditorSelected = this._teLightboxPreviousSelection;
      this._teLightboxPreviousSelection = null;
      this._updateEditorPanel();
    }
    document.body.classList.remove('te-lightbox-open');
  },

  tagEditorLightboxTransform() {
    return 'translate3d(' + this.tagEditorLightboxX + 'px,' + this.tagEditorLightboxY + 'px,0) scale(' + this.tagEditorLightboxScale + ')';
  },

  tagEditorResetLightbox() {
    this.tagEditorLightboxScale = 1;
    this.tagEditorLightboxX = 0;
    this.tagEditorLightboxY = 0;
  },

  tagEditorSetLightboxScale(next, event) {
    var current = this.tagEditorLightboxScale || 1;
    next = Math.max(1, Math.min(8, next));
    if (Math.abs(next - current) < 0.001) return;
    var ratio = next / current;
    if (event) {
      var stage = event.currentTarget.closest('.te-lightbox-stage') || event.currentTarget;
      var rect = stage.getBoundingClientRect();
      var cursorX = event.clientX - (rect.left + rect.width / 2);
      var cursorY = event.clientY - (rect.top + rect.height / 2);
      this.tagEditorLightboxX = cursorX - (cursorX - this.tagEditorLightboxX) * ratio;
      this.tagEditorLightboxY = cursorY - (cursorY - this.tagEditorLightboxY) * ratio;
    }
    this.tagEditorLightboxScale = next;
    if (next === 1) {
      this.tagEditorLightboxX = 0;
      this.tagEditorLightboxY = 0;
    }
  },

  tagEditorZoomLightbox(event) {
    var factor = event.deltaY < 0 ? 1.18 : (1 / 1.18);
    this.tagEditorSetLightboxScale(this.tagEditorLightboxScale * factor, event);
  },

  tagEditorStartLightboxPan(event) {
    if (event.button !== 0 || this.tagEditorLightboxScale <= 1) return;
    this.tagEditorLightboxPanning = true;
    this.tagEditorLightboxPointerId = event.pointerId;
    this.tagEditorLightboxPanStartX = event.clientX - this.tagEditorLightboxX;
    this.tagEditorLightboxPanStartY = event.clientY - this.tagEditorLightboxY;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  },

  tagEditorMoveLightboxPan(event) {
    if (!this.tagEditorLightboxPanning || event.pointerId !== this.tagEditorLightboxPointerId) return;
    this.tagEditorLightboxX = event.clientX - this.tagEditorLightboxPanStartX;
    this.tagEditorLightboxY = event.clientY - this.tagEditorLightboxPanStartY;
  },

  tagEditorStopLightboxPan(event) {
    if (event && this.tagEditorLightboxPointerId !== null) {
      event.currentTarget.releasePointerCapture?.(this.tagEditorLightboxPointerId);
    }
    this.tagEditorLightboxPanning = false;
    this.tagEditorLightboxPointerId = null;
  },

  async tagEditorLightboxNav(dir) {
    await this.tagEditorNavDetail(dir);
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    this.tagEditorLightboxImage = img;
    this.tagEditorLightboxLoading = true;
    this.tagEditorResetLightbox();
  },

  async _teFetchAllSessionItems(useCurrentFilters) {
    if (useCurrentFilters && this.tagEditorQuickFilter === 'modified') return this._teGetModified().slice();
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
    base.set('page_size', '240');
    var all = [];
    var totalPages = 1;
    var generation;
    try {
      for (var page = 1; page <= totalPages; page++) {
        assertCurrent();
        base.set('page', String(page));
        var response = await fetch('/api/tageditor/sessions/' + encodeURIComponent(sessionId) + '/images?' + base.toString(), { signal: controller.signal });
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

  tagEditorGridBgClick(e) {
    if (!e.target.closest('.te-card') && !e.target.closest('.te-editor')) {
      this._teFlushAllPendingTextEdits();
      this.tagEditorSelected = [];
    }
  },

  tagEditorCardClick(img, idx, e) {
    this._teFlushAllPendingTextEdits();
    var filtered = this.tagEditorGetFiltered();
    var globalIdx = idx;

    if (e.ctrlKey || e.metaKey) {
      var existsIdx = this.tagEditorSelected.indexOf(img.path);
      if (existsIdx === -1) {
        this.tagEditorSelected.push(img.path);
      } else {
        this.tagEditorSelected.splice(existsIdx, 1);
      }
    } else if (e.shiftKey && this._teLastSelected !== null) {
      var lastIdx = this._teLastSelected;
      var start2 = Math.min(lastIdx, globalIdx);
      var end2 = Math.max(lastIdx, globalIdx);
      this.tagEditorSelected = [];
      for (var i = start2; i <= end2; i++) {
        if (filtered[i]) this.tagEditorSelected.push(filtered[i].path);
      }
    } else {
      if (this.tagEditorSelected.length === 1 && this.tagEditorSelected[0] === img.path) {
        this.tagEditorSelected = [];
      } else {
        this.tagEditorSelected = [img.path];
      }
    }
    this._teLastSelected = globalIdx;
    this._updateEditorPanel();
  },

  _teFocusEditorInput() {
    // 只聚焦当前视图可见的编辑控件（Chip=添加框 / Text=文本域），隐藏元素 focus 无效
    var selector = this.tagEditorDetailView === 'text'
      ? '.te-editor:not(.is-idle) .te-editor-textarea'
      : '.te-editor:not(.is-idle) .te-editor-add input';
    var el = document.querySelector(selector);
    if (el) el.focus();
    return !!el;
  },

  tagEditorCardEnter(img, idx, e) {
    // 焦点在已单选的本卡上时，Enter 视为“开始编辑”聚焦添加框；否则保持选中切换语义
    if (this.tagEditorSelected.length === 1 && this.tagEditorSelected[0] === img.path) {
      if (this._teFocusEditorInput()) {
        e.preventDefault();
        return;
      }
    }
    this.tagEditorCardClick(img, idx, e);
  },

  tagEditorCardDblClick(img, idx, e) {
    // 双击卡片 = 查看大图（聚焦添加框用 Enter 键，见 tagEditorHandleKeydown）
    if (e) e.preventDefault();
    this.tagEditorOpenLightbox(img);
  },

  tagEditorToggleSelect(path, e) {
    this._teFlushAllPendingTextEdits();
    var idx = this.tagEditorSelected.indexOf(path);
    if (idx === -1) {
      this.tagEditorSelected.push(path);
    } else {
      this.tagEditorSelected.splice(idx, 1);
    }
    this._updateEditorPanel();
  },

  tagEditorSelectAll() {
    this._teFlushAllPendingTextEdits();
    this.tagEditorSelected = this.tagEditorGetPaged().map(function(img) { return img.path; });
    this._updateEditorPanel();
  },

  async tagEditorSelectFiltered() {
    this._teFlushAllPendingTextEdits();
    var epoch = this._teLoadEpoch;
    try {
      this._teSearchLoading = true;
      var filtered = await this._teFetchAllSessionItems(true);
      this.tagEditorSelected = filtered.map(function(img) { return img.path; });
      this._teCachedSelectedStatsKey = '';
      this._teCachedSelectedStats = null;
      this._updateEditorPanel();
    } catch (e) {
      if (e.name !== 'AbortError') this.toast(e.message || this.t('common.networkError'), 'error');
    } finally {
      if (epoch === this._teLoadEpoch && !this._teAllAbort && !this._tePageAbort) this._teSearchLoading = false;
    }
  },

  tagEditorSelectInvert() {
    this._teFlushAllPendingTextEdits();
    var filtered = this.tagEditorGetPaged();
    var sel = this.tagEditorSelected;
    this.tagEditorSelected = [];
    for (var i = 0; i < filtered.length; i++) {
      var p = filtered[i].path;
      if (sel.indexOf(p) === -1) this.tagEditorSelected.push(p);
    }
    this._updateEditorPanel();
  },

  _updateEditorPanel() {
    this.tagEditorCancelQuickRemove();
    this.tagEditorPanelMenu = null;
    this._teCloseSuggestions();
    this.batchSuggestOpen = null;
    this._teBatchSuggestSeq = (this._teBatchSuggestSeq || 0) + 1;
    if (this.tagEditorSelected.length === 1) {
      var img = this.tagEditorGetSelectedImg();
      if (img) {
        this.tagEditorDetailText = img.tags || '';
      }
    }
    this.tagDictionarySyncChips();
  },

  tagEditorGetSelectedImg() {
    if (this.tagEditorSelected.length < 1) return null;
    return this._teFindByPath(this.tagEditorSelected[0]);
  },

  tagEditorGetSelectedTags() {
    var img = this.tagEditorGetSelectedImg();
    if (!img || !img.tags) return [];
    return _teParseTags(img.tags);
  },

  // ===== Drag Selection =====
  // ===== Single Image Editor =====
  tagEditorClearTagFilters() {
    this.tagEditorTagSelection = [];
    this.tagEditorExcludedTags = [];
    this.tagEditorSetTagSearch('');
    this._teInvalidateFilter();
    this.tagEditorSchedulePageFetch(true);
  },

  tagEditorCancelQuickRemove() {
    this.tagEditorQuickRemove = false;
    this.tagEditorRemovalTags = [];
  },

  tagEditorStartQuickRemove() {
    if (!this.tagEditorSelected.length) return;
    this._teFlushAllPendingTextEdits();
    this.tagEditorQuickRemove = true;
    this.tagEditorRemovalTags = [];
    this.tagEditorDetailView = 'chip';
    this.tagDictionaryCloseHover();
  },

  tagEditorToggleRemoval(tag) {
    if (!this.tagEditorQuickRemove) return;
    this.tagEditorRemovalTags = this.tagEditorRemovalTags.includes(tag)
      ? this.tagEditorRemovalTags.filter(function(value) { return value !== tag; })
      : this.tagEditorRemovalTags.concat(tag);
  },

  tagEditorApplyQuickRemove() {
    if (!this.tagEditorQuickRemove || !this.tagEditorRemovalTags.length) return;
    var removed = new Set(this.tagEditorRemovalTags);
    var targets = this.tagEditorGetBatchTargets();
    var paths = [];
    for (var img of targets) {
      var tags = _teParseTags(img.tags);
      var remaining = tags.filter(function(tag) { return !removed.has(tag); });
      if (remaining.length === tags.length) continue;
      this._teUpdateImageTags(img, remaining.join(', '));
      paths.push(img.path);
    }
    if (paths.length) this._tePushHistory({ type: 'batchRemove', desc: '− ' + Array.from(removed).join(', '), affected: paths.length, paths: paths });
    this.tagEditorCancelQuickRemove();
    this._updateEditorPanel();
  },

  tagEditorPanelContext(event) {
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (!this.tagEditorSelected.length) return;
    event.preventDefault();
    event.stopPropagation();
    var tag = event.target.closest('.te-editor-tag[data-tag], .te-selected-tag[data-tag]');
    var anchor = event.target.getBoundingClientRect();
    this.tagEditorPanelMenu = {
      tag: tag ? tag.dataset.tag : null,
      preview: !!event.target.closest('.te-editor-preview'),
      x: Math.max(4, Math.min(event.clientX || anchor.left, window.innerWidth - 224)),
      y: Math.max(4, Math.min(event.clientY || anchor.bottom, window.innerHeight - 260)),
    };
    this.tagEditorContextMenu = null;
    this.tagEditorImageContextMenu = null;
    this.tagDictionaryCloseHover();
    this.$nextTick(function() { document.querySelector('#tePanelMenu button:not([disabled])')?.focus(); });
  },

  async tagEditorPanelAction(action) {
    var menu = this.tagEditorPanelMenu;
    if (!menu) return;
    this.tagEditorPanelMenu = null;
    if (action === 'copy') {
      var text = menu.tag || (this.tagEditorSelected.length === 1 ? this.tagEditorGetSelectedImg()?.tags : this.tagEditorGetSelectedStats().map(function(item) { return item.tag; }).join(', '));
      try { await navigator.clipboard.writeText(text || ''); this.toast(this.t('tagEditor.tagsCopied').replace('{n}', _teParseTags(text || '').length)); }
      catch (_) { this.toast(this.t('common.error'), 'error'); }
    } else if (action === 'remove') {
      if (this.tagEditorQuickRemove) this.tagEditorToggleRemoval(menu.tag);
      else if (this.tagEditorSelected.length === 1) this.tagEditorRemoveTagFromSelected(menu.tag);
      else this.tagEditorPrepareRemove(menu.tag);
    } else if (action === 'filter') {
      this.tagEditorTagSelection = [menu.tag];
      this.tagEditorExcludedTags = [];
      this._teInvalidateFilter();
      this.tagEditorSchedulePageFetch(true);
    } else if (action === 'quick') this.tagEditorStartQuickRemove();
    else if (action === 'view') this.tagEditorOpenLightbox(this.tagEditorGetSelectedImg());
    else if (action === 'revert') this.tagEditorRevertSelectedImage();
    else if (action === 'undo') this.tagEditorUndo();
    else if (action === 'redo') this.tagEditorRedo();
  },

  tagEditorPanelMenuKeydown(event) {
    var buttons = Array.from(event.currentTarget.querySelectorAll('button')).filter(function(button) { return !button.disabled && button.getClientRects().length; });
    var index = buttons.indexOf(document.activeElement);
    if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    var next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  },

  tagEditorAddTagToSelected() {
    var val = this.tagEditorAddInput.trim();
    if (!val || this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var newTags = _teParseTags(val);
    var existing = _teParseTags(img.tags);
    var added = [];
    var self = this;
    newTags.forEach(function(t) {
      if (existing.indexOf(t) === -1) { existing.push(t); added.push(t); }
    });
    if (added.length > 0) {
      self._teUpdateImageTags(img, existing.join(', '));
      this._tePushHistory({ type: 'add', desc: '+ ' + added.join(', ') + ' · ' + this._teImageLabel(img), affected: 1 });
    }
    this.tagEditorAddInput = '';
    this._teCloseSuggestions();
  },

  tagEditorRemoveTagFromSelected(tag) {
    if (this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = _teParseTags(img.tags);
    var idx = tags.indexOf(tag);
    if (idx !== -1) {
      tags.splice(idx, 1);
      this._teUpdateImageTags(img, tags.join(', '));
      this._tePushHistory({ type: 'remove', desc: '− ' + tag + ' · ' + this._teImageLabel(img), affected: 1 });
    }
  },

  tagEditorCanRevertSelectedImage() {
    if (this.tagEditorSelected.length !== 1) return false;
    var img = this.tagEditorGetSelectedImg();
    return !!img && this.tagEditorOriginal[img.path] !== undefined && img.tags !== this.tagEditorOriginal[img.path];
  },

  tagEditorRevertSelectedImage() {
    if (this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var orig = this.tagEditorOriginal[img.path];
    if (orig === undefined || img.tags === orig) return; // 未修改或无原始可还原
    this._teUpdateImageTags(img, orig);
    this._tePushHistory({ type: 'replace', desc: this.t('tagEditor.revertImage') + ' · ' + this._teImageLabel(img), affected: 1 });
    this.toast(this.t('tagEditor.imageReverted'));
  },

  tagEditorDetailDragStart(e, idx) {
    this.tagEditorDetailDragSrcIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
  },

  tagEditorDetailDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  },

  tagEditorDetailTagDragOver(e, idx) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (idx === this.tagEditorDetailDragSrcIdx) {
      this.tagEditorDetailDragOverIdx = -1;
      this.tagEditorDetailDragOverPos = '';
      return;
    }
    var el = e.target.closest('.te-editor-tag');
    if (!el) return;
    var rect = el.getBoundingClientRect();
    var midX = rect.left + rect.width / 2;
    var pos = e.clientX < midX ? 'before' : 'after';
    if (this.tagEditorDetailDragOverIdx !== idx || this.tagEditorDetailDragOverPos !== pos) {
      this.tagEditorDetailDragOverIdx = idx;
      this.tagEditorDetailDragOverPos = pos;
    }
  },

  tagEditorDetailDragEnter(e, idx) {
    e.preventDefault();
    if (idx !== this.tagEditorDetailDragSrcIdx) {
      this.tagEditorDetailDragOverIdx = idx;
    }
  },

  tagEditorDetailDragLeave(e) {
    var el = e.target.closest('.te-editor-tag');
    if (!el || !el.contains(e.relatedTarget)) {
      this.tagEditorDetailDragOverIdx = -1;
      this.tagEditorDetailDragOverPos = '';
    }
  },

  tagEditorDetailDragEnd(e) {
    this.tagEditorDetailDragSrcIdx = -1;
    this.tagEditorDetailDragOverIdx = -1;
    this.tagEditorDetailDragOverPos = '';
  },

  tagEditorDetailDrop(e) {
    e.preventDefault();
    var srcIdx = this.tagEditorDetailDragSrcIdx;
    var dropPos = this.tagEditorDetailDragOverPos;
    this.tagEditorDetailDragSrcIdx = -1;
    this.tagEditorDetailDragOverIdx = -1;
    this.tagEditorDetailDragOverPos = '';
    if (srcIdx < 0) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = _teParseTags(img.tags);
    if (srcIdx >= tags.length) return;
    var moving = tags.splice(srcIdx, 1)[0];
    var destIdx = tags.length;
    var dropTarget = e.target.closest('.te-editor-tag');
    if (dropTarget && dropTarget.dataset.ti != null) {
      var dropIdx = parseInt(dropTarget.dataset.ti, 10);
      if (!isNaN(dropIdx)) {
        var adjIdx = dropIdx > srcIdx ? dropIdx - 1 : dropIdx;
        destIdx = dropPos === 'after' ? adjIdx + 1 : adjIdx;
      }
    }
    tags.splice(destIdx, 0, moving);
    this._teUpdateImageTags(img, tags.join(', '));
    this._tePushHistory({ type: 'reorder', desc: this.t('tagEditor.historyStepReorder') + ' · ' + moving + ' @' + this._teImageLabel(img), affected: 1 });
  },

  tagEditorDetailEditTag(ti) {
    this.tagEditorDetailView = 'text';
  },

  tagEditorDetailTextChange() {
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var self = this;
    var path = img.path;
    if (this._tePendingTextEdits[path]) {
      clearTimeout(this._tePendingTextEdits[path]);
      delete this._tePendingTextEdits[path];
    }
    // 文本内容立即进入编辑状态，只有历史记录防抖，避免快速保存或切图时丢失最后一次输入。
    this._teUpdateImageTags(img, this.tagEditorDetailText, { deferTextHistory: true });
    this._tePendingTextEdits[path] = setTimeout(function() {
      self._teFlushPendingTextEdit(path);
    }, 500);
  },

  tagEditorCopySelectedTags() {
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = _teParseTags(img.tags);
    this.tagEditorCopiedTags = tags.slice();
    this.toast(this.t('tagEditor.tagsCopied').replace('{n}', tags.length));
  },

  tagEditorPasteTagsToSelected() {
    if (this.tagEditorCopiedTags.length === 0) return;
    if (this.tagEditorSelected.length !== 1) {
      this.toast(this.t('tagEditor.selectOneImage'), 'warning');
      return;
    }
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var existing = _teParseTags(img.tags);
    var added = [];
    var self = this;
    this.tagEditorCopiedTags.forEach(function(t) {
      if (existing.indexOf(t) === -1) { existing.push(t); added.push(t); }
    });
    if (added.length > 0) {
      self._teUpdateImageTags(img, existing.join(', '));
      this._tePushHistory({ type: 'add', desc: '+ ' + added.length + ' tags · ' + this._teImageLabel(img), affected: 1 });
      this.toast(this.t('tagEditor.tagsPasted').replace('{n}', added.length));
    }
  },

  async tagEditorNavDetail(dir) {
    if (this.tagEditorSelected.length !== 1) return;
    this._teFlushAllPendingTextEdits();
    var filtered = this.tagEditorGetFiltered();
    var currentIdx = this._teFindCurrentFilteredIdx();
    if (currentIdx < 0) return;
    var newIdx = currentIdx + dir;
    if (newIdx >= 0 && newIdx < filtered.length) {
      this.tagEditorSelected = [filtered[newIdx].path];
      this._updateEditorPanel();
      this._teScrollSelectedIntoView();
      return;
    }
    if (this.tagEditorSessionId) {
      var nextPage = this.tagEditorPage + (dir < 0 ? -1 : 1);
      if (nextPage < 1 || nextPage > this.tagEditorTotalPages()) return;
      await this.tagEditorFetchPage(nextPage);
      var nextItems = this.tagEditorGetPaged();
      var next = dir < 0 ? nextItems[nextItems.length - 1] : nextItems[0];
      if (next) {
        this.tagEditorSelected = [next.path];
        this._updateEditorPanel();
        this._teScrollSelectedIntoView();
      }
    }
  },

  tagEditorShortcutRows() {
    return [
      { k: 'Ctrl+S', d: this.t('common.save') },
      { k: 'Ctrl+Z / Ctrl+Shift+Z', d: this.t('tagEditor.undoHint') + ' / ' + this.t('tagEditor.redoHint') },
      { k: 'Ctrl+A', d: this.t('tagEditor.selectPage') },
      { k: 'Ctrl+C / Ctrl+V', d: this.t('tagEditor.copyTags') + ' / ' + this.t('tagEditor.pasteTags') },
      { k: 'Ctrl+F', d: this.t('tagEditor.shortcutFocusSearch') },
      { k: 'Enter', d: this.t('tagEditor.shortcutAddTag') },
      { k: '← / →', d: this.t('tagEditor.shortcutNav') },
      { k: 'Tab / Shift+Tab', d: this.t('tagEditor.shortcutTab') },
      { k: 'Esc', d: this.t('tagEditor.shortcutEsc') },
      { k: this.t('tagEditor.shortcutMouse'), d: this.t('tagEditor.viewOriginal') }
    ];
  },

  _teScrollSelectedIntoView() {
    if (this.tagEditorSelected.length !== 1) return;
    var path = this.tagEditorSelected[0];
    // 等 Alpine 渲染完再滚动；block:'nearest' 只在卡片出屏时才滚
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        var cards = document.querySelectorAll('#teV3Grid .te-card');
        for (var i = 0; i < cards.length; i++) {
          if (cards[i].getAttribute('data-path') === path) {
            cards[i].scrollIntoView({ block: 'nearest' });
            break;
          }
        }
      });
    });
  },

  tagEditorSetTagSort(by) {
    if (this.tagEditorTagSortBy === by) {
      this.tagEditorTagSortAsc = !this.tagEditorTagSortAsc;
    } else {
      this.tagEditorTagSortBy = by;
      this.tagEditorTagSortAsc = by !== 'freq';
    }
  },

  tagEditorCanNavDetail(dir) {
    if (this.tagEditorSelected.length !== 1) return false;
    var filtered = this.tagEditorGetFiltered();
    var currentIdx = this._teFindCurrentFilteredIdx();
    if (currentIdx < 0) return false;
    var newIdx = currentIdx + dir;
    if (newIdx >= 0 && newIdx < filtered.length) return true;
    if (!this.tagEditorSessionId) return false;
    return dir < 0 ? this.tagEditorPage > 1 : this.tagEditorPage < this.tagEditorTotalPages();
  },

  // ===== Autocomplete =====
  _teMergeSuggestions(local, dictionary) {
    return _teSuggestMerge(local, dictionary, TD_SUGGEST_LIMIT, tag => this.tagDictionaryMetaFor(tag));
  },

  tagEditorGetSuggestions(val, inputEl) {
    var seq = ++this._teSuggestSeq;
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    var v = val == null ? (this.tagEditorAddInput || '') : val;
    if (!v.trim()) { this._teCloseSuggestions(); return; }
    this.tagEditorSuggestions = [];
    this.tagEditorSuggestIdx = -1;
    this._teLocalSuggestTags = [];
    var self = this;
    var el = inputEl || document.querySelector('.te-editor-add input');
    var pos = el ? el.selectionStart : v.length;
    this._teSuggestTimer = setTimeout(function() {
      var token = _teGetCurrentToken(v, pos);
      if (!token) { self._teCloseSuggestions(); return; }
      self.tagEditorSuggestIdx = -1;
      // 本地标签（当前数据集里出现过的）先出，词典结果随后补满
      _teSuggestFromFreq(self.tagEditorTagFreq, token, 8, function(localTags) {
        if (seq !== self._teSuggestSeq) return;
        self._teLocalSuggestTags = localTags;
        self._teSetSuggestions(self._teMergeSuggestions(localTags, null), el);
      });
      self.tagDictionarySuggest(token, seq, el);
    }, 50);
  },

  /* 词典结果比本地标签晚回来，只有 seq 仍是最新时才允许替换下拉内容。 */
  _teApplyDictSuggestions(token, seq, results, inputEl) {
    if (seq !== this._teSuggestSeq) return;
    this._teSetSuggestions(this._teMergeSuggestions(this._teLocalSuggestTags, results), inputEl || this._teSuggestInputEl);
  },

  _teSetSuggestions(items, el) {
    this.tagEditorSuggestions = items;
    if (this.tagEditorSuggestIdx >= items.length) this.tagEditorSuggestIdx = -1;
    if (items.length > 0 && el) {
      this._teSuggestCoords = _teGetSuggestCoords(el);
      this._teSuggestInputEl = el;
    } else {
      this._teSuggestCoords = null;
    }
  },

  tagEditorRefreshSuggestPosition() {
    var self = this;
    this.$nextTick(function() {
      var el = self._teSuggestInputEl;
      if (self._teSuggestCoords && el && el.isConnected) {
        self._teSuggestCoords = _teGetSuggestCoords(el);
      }
    });
  },

  /* 关掉下拉时必须让在途的词典搜索作废（seq 自增），
     否则几百毫秒后返回的结果会把刚关掉的下拉重新弹出来。 */
  _teCloseSuggestions() {
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    this._teSuggestSeq++;
    this.tagEditorSuggestions = [];
    this.tagEditorSuggestIdx = -1;
    this._teSuggestCoords = null;
  },

  _teScrollSuggestion() {
    this.$nextTick(function () {
      var active = document.querySelector('.te-suggest-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    });
  },

  tagEditorBlurSuggest() {
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    var self = this;
    this._teBlurTimer = setTimeout(function() {
      self._teCloseSuggestions();
    }, 200);
  },

  tagEditorSelectSuggestion(s) {
    // 下拉条目可能是词典结果对象：插入的是 Anima 格式的 insert，不是别名也不是下划线原形
    var insert = (s && typeof s === 'object') ? (s.insert || '') : s;
    if (!insert) return;
    var el = this._teSuggestInputEl || document.querySelector('.te-editor-add input');
    var val = this.tagEditorAddInput || '';
    var pos = el ? el.selectionStart : val.length;
    var result = _teReplaceToken(val, pos, insert);
    this.tagEditorAddInput = result.text;
    this._teCloseSuggestions();
    if (el) {
      var self = this;
      setTimeout(function() { el.focus(); el.setSelectionRange(result.caretPos, result.caretPos); }, 10);
    }
  },

  // ===== Batch Operations =====
  tagEditorSetBatchMode(mode) {
    if (this._teBatchSuggestTimer) clearTimeout(this._teBatchSuggestTimer);
    if (this._teBatchBlurTimer) clearTimeout(this._teBatchBlurTimer);
    this.tagEditorBatchMode = mode;
    this.batchSuggestOpen = null;
    this.batchSuggestItems = [];
    this.batchSuggestIdx = -1;
    this._teBatchSuggestSeq = (this._teBatchSuggestSeq || 0) + 1;
  },

  tagEditorPrepareRemove(tag) {
    this.tagEditorSetBatchMode('remove');
    this.batchRemoveInput = tag;
    this.tagDictionaryCloseHover();
  },

  tagEditorGetVisibleSelectedStats() {
    var filter = this.tagEditorBatchTagFilter;
    return this.tagEditorGetSelectedStats().filter(function(item) {
      return filter === 'all' || (filter === 'shared' ? item.state === 'intersection' : item.state === 'partial');
    });
  },

  tagEditorBatchSuggest(field) {
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    if (this._teBatchBlurTimer) { clearTimeout(this._teBatchBlurTimer); this._teBatchBlurTimer = null; }
    var seq = this._teBatchSuggestSeq = (this._teBatchSuggestSeq || 0) + 1;
    var val = this[{ add:'batchAddInput', remove:'batchRemoveInput', old:'batchOldTag', new:'batchNewTag' }[field]];
    this.batchSuggestItems = [];
    this.batchSuggestIdx = -1;
    if (!val || !val.trim()) { this.batchSuggestOpen = null; this.batchSuggestItems = []; return; }
    var self = this;
    var v = val.split(',').pop().trim().toLowerCase();
    if (!v) { this.batchSuggestOpen = null; return; }
    this._teBatchSuggestTimer = setTimeout(async function() {
      var existingOnly = field === 'remove' || field === 'old';
      var tags = (existingOnly ? self.tagEditorGetSelectedStats() : self.tagEditorTagFreq).map(function(item) { return item.tag; });
      var local = tags.filter(function(tag) { return tag.toLowerCase().includes(v); });
      var result = await self.tagDictionaryComplete(v, { sourceTags: tags });
      if (seq !== self._teBatchSuggestSeq) return;
      var items = self._teMergeSuggestions(result ? result.localTags : local, result ? result.results : []);
      if (existingOnly) {
        var allowed = new Set(tags);
        items = items.filter(function(item) { return allowed.has(item.insert); });
      }
      self.batchSuggestItems = items;
      self.batchSuggestOpen = items.length ? field : null;
    }, 100);
  },

  tagEditorBatchBlur() {
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    var self = this;
    this._teBatchBlurTimer = setTimeout(function() {
      self.batchSuggestOpen = null;
      self._teBatchSuggestSeq = (self._teBatchSuggestSeq || 0) + 1;
    }, 200);
  },

  tagEditorBatchSelectSuggestion(s) {
    var field = this.batchSuggestOpen;
    var key = { add:'batchAddInput', remove:'batchRemoveInput', old:'batchOldTag', new:'batchNewTag' }[field];
    if (!key) return;
    var insert = typeof s === 'string' ? s : s.insert;
    this[key] = field === 'add' || field === 'remove' ? _teReplaceToken(this[key], this[key].length, insert).text : insert;
    this._teBatchSuggestSeq = (this._teBatchSuggestSeq || 0) + 1;
    this.batchSuggestOpen = null;
    this.batchSuggestItems = [];
  },

  tagEditorBatchKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.stopPropagation(); this.tagEditorSetBatchMode(this.tagEditorBatchMode); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      var delta = event.key === 'ArrowDown' ? 1 : -1;
      this.batchSuggestIdx = Math.max(0, Math.min(this.batchSuggestItems.length - 1, this.batchSuggestIdx + delta));
      this.$nextTick(function() {
        var active = Array.from(document.querySelectorAll('.te-batch-row .te-suggest-item.active')).find(function(el) { return el.offsetParent !== null; });
        if (active) active.scrollIntoView({block:'nearest'});
      });
    }
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      if (this.batchSuggestOpen && this.batchSuggestItems[this.batchSuggestIdx]) {
        this.tagEditorBatchSelectSuggestion(this.batchSuggestItems[this.batchSuggestIdx]);
        return;
      }
      if (this.tagEditorBatchMode === 'add') this.tagEditorBatchAdd();
      else if (this.tagEditorBatchMode === 'remove') this.tagEditorBatchRemove();
      else if (this.tagEditorBatchMode === 'replace') this.tagEditorBatchReplace();
    }
  },

  tagEditorGetBatchTargets() {
    var selected = new Set(this.tagEditorSelected);
    return this.tagEditorImages.filter(function(img) { return selected.has(img.path); });
  },

  // ===== Inline Tag Editing =====
  tagEditorStartInlineEdit(tag, event) {
    event.stopPropagation();
    this.tagEditorInlineEdit = { oldTag: tag, newTag: tag };
    this.$nextTick(function() {
      var input = document.getElementById('te-inline-edit-input');
      if (input) { input.focus(); input.select(); }
    });
  },

  async tagEditorFinishInlineEdit() {
    if (!this.tagEditorInlineEdit) return;
    var oldTag = this.tagEditorInlineEdit.oldTag;
    var newTag = this.tagEditorInlineEdit.newTag.trim();
    this.tagEditorInlineEdit = null;
    if (!newTag || oldTag === newTag) return;

    // 左侧重命名作用于整个数据集，确认时明确范围，失去焦点不会直接修改图片。
    var self = this;
    var images;
    try { images = await this._teEnsureAllImagesLoaded(); }
    catch (e) { if (e.name !== 'AbortError') this.toast(e.message || this.t('common.networkError'), 'error'); return; }
    var targets = images.filter(function(img) { return _teParseTags(img.tags).includes(oldTag); });
    if (!targets.length) { this.toast(this.t('tagEditor.inlineRenameNone'), 'warning'); return; }
    var message = this.t('tagEditor.globalRenameConfirm').replace('{n}', targets.length) + '\n' + oldTag + ' → ' + newTag;
    this._teConfirmBatch(message, function() {
      targets.forEach(function(img) {
        var tags = _teParseTags(img.tags).map(function(tag) { return tag === oldTag ? newTag : tag; });
        self._teUpdateImageTags(img, self._teDedupTags(tags).join(', '));
      });
      self._teInvalidateFilter();
      self._tePushHistory({ type: 'rename', desc: oldTag + ' → ' + newTag, affected: targets.length });
      self.toast(self.t('tagEditor.inlineReplaceDone').replace('{old}', oldTag).replace('{new}', newTag).replace('{n}', targets.length));
    });
  },

  tagEditorCancelInlineEdit() {
    this.tagEditorInlineEdit = null;
  },

  _teConfirmBatchScope(action, transform, type, description, onDone) {
    this._teFlushAllPendingTextEdits();
    var targets = this.tagEditorGetBatchTargets();
    var count = targets.length;
    if (count === 0) { this.toast(this.t('tagEditor.batchNoChanges'), 'warning'); return; }
    var totalCount = this.tagEditorDatasetCount || this.tagEditorImages.length;
    var actionLabel = this.t('bulkAction.' + action) || action;
    var msg = this.t('tagEditor.confirmBatchDesc')
      .replace('{count}', count).replace('{operation}', actionLabel)
      .replace('{total}', totalCount);
    // 预览与提交共享同一份结果，确认期间标注变化则拒绝过期操作。
    var changes = targets.map(function(img) {
      return { img: img, before: img.tags, after: transform(img.tags) };
    }).filter(function(change) { return change.before !== change.after; });
    if (!changes.length) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    msg += '\n' + this.t('tagEditor.batchPreviewDiff').replace('{n}', changes.length) + ' · ' + description;
    var epoch = this._teLoadEpoch;
    var self = this;
    this._teConfirmBatch(msg, function() {
      if (epoch !== self._teLoadEpoch || changes.some(function(change) { return change.img.tags !== change.before; })) {
        self.toast(self.t('tagEditor.batchStale'), 'warning');
        return;
      }
      changes.forEach(function(change) { self._teUpdateImageTags(change.img, change.after); });
      self._tePushHistory({ type: type, desc: description + ' · ' + self.t('tagEditor.historyStepImages').replace('{n}', changes.length), affected: changes.length });
      onDone();
      self.toast(self.t('tagEditor.batchDone'));
    });
  },

  tagEditorRemoveBracketEscapes() {
    this._teFlushAllPendingTextEdits();
    var changes = this.tagEditorGetBatchTargets().map(function(img) {
      var before = String(img.tags || '');
      return { img: img, before: before, after: before.replace(/\\+([()])/g, '$1') };
    }).filter(function(change) { return change.before !== change.after; });
    if (!changes.length) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    var epoch = this._teLoadEpoch;
    var self = this;
    this._teConfirmBatch(this.t('tagEditor.unescapeConfirm').replace('{n}', changes.length), function() {
      if (epoch !== self._teLoadEpoch || changes.some(function(change) { return change.img.tags !== change.before; })) {
        self.toast(self.t('tagEditor.unescapeStale'), 'warning');
        return;
      }
      changes.forEach(function(change) { self._teUpdateImageTags(change.img, change.after); });
      self._tePushHistory({ type: 'unescape', desc: self.t('tagEditor.unescapeBrackets'), affected: changes.length });
      self.toast(self.t('tagEditor.batchDone'));
    });
  },

  tagEditorBatchAdd() {
    var val = this.batchAddInput.trim();
    if (!val) return;
    var newTags = _teParseTags(val);
    if (newTags.length === 0) return;
    var self = this;
    var pos = this.tagEditorBatchPos;
    this._teConfirmBatchScope('add', function(before) {
      var tags = _teParseTags(before);
      var existing = new Set(tags);
      var changed = false;
      newTags.forEach(function(t) {
        if (existing.has(t)) return;
        existing.add(t);
        if (pos === 'front') tags.unshift(t);
        else tags.push(t);
        changed = true;
      });
      return changed ? tags.join(', ') : before;
    }, 'batchAdd', '+ ' + newTags.join(', '), function() {
      self.batchAddInput = '';
    });
  },

  tagEditorBatchRemove() {
    var val = this.batchRemoveInput.trim();
    if (!val) return;
    var rmTags = _teParseTags(val);
    if (rmTags.length === 0) return;
    var self = this;
    var removed = new Set(rmTags);
    this._teConfirmBatchScope('removeTag', function(before) {
      var tags = _teParseTags(before);
      var after = tags.filter(function(t) { return !removed.has(t); });
      return tags.length !== after.length ? after.join(', ') : before;
    }, 'batchRemove', '− ' + rmTags.join(', '), function() {
      self.batchRemoveInput = '';
    });
  },

  tagEditorBatchReplace() {
    var oldTag = this.batchOldTag.trim();
    var newTag = this.batchNewTag.trim();
    if (!oldTag || !newTag || oldTag === newTag) return;
    var self = this;
    this._teConfirmBatchScope('replace', function(before) {
      var tags = _teParseTags(before);
      var idx = tags.indexOf(oldTag);
      if (idx === -1) return before;
      tags[idx] = newTag;
      return self._teDedupTags(tags).join(', ');
    }, 'replace', oldTag + ' → ' + newTag, function() {
      self.batchOldTag = ''; self.batchNewTag = '';
    });
  },

  tagEditorGetSelectedStats() {
    if (this.tagEditorSelected.length < 2) {
      this._teCachedSelectedStatsKey = '';
      this._teCachedSelectedStats = null;
      return [];
    }
    var versions = this._teEditVersions || {};
    var selKey = this.tagEditorSelected.map(function(path) { return path + ':' + (versions[path] || 0); }).join('\x00');
    if (selKey === this._teCachedSelectedStatsKey && this._teCachedSelectedStats) {
      return this._teCachedSelectedStats;
    }
    var selSet = Object.create(null);
    for (var si = 0; si < this.tagEditorSelected.length; si++) selSet[this.tagEditorSelected[si]] = true;
    var counter = {};
    var imgs = this.tagEditorImages;
    for (var i = 0; i < imgs.length; i++) {
      if (!selSet[imgs[i].path]) continue;
      var tags = Array.from(new Set(_teParseTags(imgs[i].tags)));
      for (var ti = 0; ti < tags.length; ti++) {
        counter[tags[ti]] = (counter[tags[ti]] || 0) + 1;
      }
    }
    var result = Object.keys(counter).map(function(k) { return { tag: k, count: counter[k] }; })
      .sort(function(a, b) { return b.count - a.count; });
    for (var ri = 0; ri < result.length; ri++) {
      result[ri].state = result[ri].count === this.tagEditorSelected.length ? 'intersection' : 'partial';
    }
    this._teCachedSelectedStatsKey = selKey;
    this._teCachedSelectedStats = result;
    return result;
  },

  _teDedupTags(tags) {
    var seen = new Set();
    return tags.filter(function(t) {
      var lower = t.trim().toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
  },

  // ===== Undo/Redo =====
  _tePushHistory(meta) {
    // 历史项仅保存本步骤发生变化的路径，避免每一步复制全部已修改图片。
    var requestedPaths = meta && Array.isArray(meta.paths) ? meta.paths : null;
    var previous = this._teHistoryState || {};
    var current = requestedPaths ? Object.assign({}, previous) : {};
    if (requestedPaths) {
      for (var ri = 0; ri < requestedPaths.length; ri++) {
        var requestedPath = requestedPaths[ri];
        var requestedImg = this._teFindByPath(requestedPath);
        if (requestedImg && requestedImg.tags !== this.tagEditorOriginal[requestedPath]) current[requestedPath] = requestedImg.tags;
        else delete current[requestedPath];
      }
    } else {
      var modified = this._teGetModified();
      for (var i = 0; i < modified.length; i++) current[modified[i].path] = modified[i].tags;
    }
    var changes = {};
    var paths = {};
    if (requestedPaths) {
      requestedPaths.forEach(function(path) { paths[path] = true; });
    } else {
      Object.keys(previous).forEach(function(path) { paths[path] = true; });
      Object.keys(current).forEach(function(path) { paths[path] = true; });
    }
    Object.keys(paths).forEach(function(path) {
      var before = Object.prototype.hasOwnProperty.call(previous, path) ? previous[path] : null;
      var after = Object.prototype.hasOwnProperty.call(current, path) ? current[path] : null;
      if (before !== after) changes[path] = { before: before, after: after };
    });
    this._teHistoryState = current;
    var changedPaths = Object.keys(changes);
    if (changedPaths.length === 0) return;
    var branched = this.tagEditorHistoryIdx < this.tagEditorHistory.length - 1;
    if (branched) this.tagEditorHistory = this.tagEditorHistory.slice(0, this.tagEditorHistoryIdx + 1);
    this.tagEditorHistoryDetailIdx = -1;
    var finalMeta = meta ? Object.assign({}, meta) : { type: 'edit', desc: this.t('tagEditor.historyStepText'), affected: changedPaths.length };
    delete finalMeta.paths;
    // D2: 合并连续细步（同类型 + 同 path + 1.2s 内的 text/reorder/add）合并为一步，避免历史膨胀
    var now = Date.now();
    var last = this.tagEditorHistory[this.tagEditorHistory.length - 1];
    if (!branched && last && last.meta && this._teShouldMergeHistory(last, finalMeta, now, changes)) {
      var mergePath = changedPaths[0];
      last.changes[mergePath].after = changes[mergePath].after;
      last._ts = now;
      last.meta = finalMeta;
      this._teInvalidateDiff();
      return;
    }
    this.tagEditorHistory.push({ meta: finalMeta, changes: changes, _ts: now });
    if (this.tagEditorHistory.length > 200) { this.tagEditorHistory.shift(); if (this.tagEditorHistoryIdx >= 0) this.tagEditorHistoryIdx = Math.max(0, this.tagEditorHistoryIdx - 1); }
    this.tagEditorHistoryIdx = this.tagEditorHistory.length - 1;
    this._teInvalidateDiff();
  },

  _teShouldMergeHistory(previousItem, newMeta, now, changes) {
    if (!previousItem || !previousItem.meta || !newMeta || !previousItem.changes) return false;
    if (now - previousItem._ts > 1200) return false;  // 1.2s 窗口
    // 仅合并单图细粒度操作（text / reorder / add / remove）
    var mergeableTypes = ['text', 'reorder', 'add', 'remove', 'edit'];
    if (mergeableTypes.indexOf(newMeta.type) === -1) return false;
    if (newMeta.type !== previousItem.meta.type) return false;
    var previousPaths = Object.keys(previousItem.changes);
    var newPaths = Object.keys(changes);
    return previousPaths.length === 1 && newPaths.length === 1 && previousPaths[0] === newPaths[0];
  },

  // 取历史项的快照字段（兼容旧格式 —— 旧 history 项直接是 {path:tags}）
  _teSnapOf(item) {
    if (item == null) return {};
    if (item.snapshot) return item.snapshot;
    return item;  // 旧格式直接是快照字典
  },

  tagEditorUndo() {
    this._teFlushAllPendingTextEdits();
    if (this.tagEditorHistoryIdx < 0) return;
    var item = this.tagEditorHistory[this.tagEditorHistoryIdx];
    if (item && item.changes) this._teApplyHistoryChanges(item.changes, 'before');
    else {
      var checkpoint = this.tagEditorHistoryIdx > 0 ? this._teSnapOf(this.tagEditorHistory[this.tagEditorHistoryIdx - 1]) : {};
      this._teApplyCheckpoint(checkpoint);
    }
    this.tagEditorHistoryIdx--;
  },

  tagEditorRedo() {
    this._teFlushAllPendingTextEdits();
    if (this.tagEditorHistoryIdx >= this.tagEditorHistory.length - 1) return;
    var nextIdx = this.tagEditorHistoryIdx + 1;
    var item = this.tagEditorHistory[nextIdx];
    if (item && item.changes) this._teApplyHistoryChanges(item.changes, 'after');
    else this._teApplyCheckpoint(this._teSnapOf(item));
    this.tagEditorHistoryIdx = nextIdx;
  },

  tagEditorJumpToHistory(idx) {
    this._teFlushAllPendingTextEdits();
    if (idx < 0 || idx >= this.tagEditorHistory.length || idx === this.tagEditorHistoryIdx) {
      this.tagEditorHistoryDetailIdx = -1;
      return;
    }
    if (this.tagEditorHistory.every(function(item) { return !!item.changes; })) {
      var combined = {};
      if (idx < this.tagEditorHistoryIdx) {
        for (var down = this.tagEditorHistoryIdx; down > idx; down--) {
          Object.assign(combined, this.tagEditorHistory[down].changes);
        }
        this._teApplyHistoryChanges(combined, 'before');
      } else {
        for (var up = this.tagEditorHistoryIdx + 1; up <= idx; up++) {
          Object.assign(combined, this.tagEditorHistory[up].changes);
        }
        this._teApplyHistoryChanges(combined, 'after');
      }
    } else {
      this._teApplyCheckpoint(this._teSnapOf(this.tagEditorHistory[idx]));
    }
    this.tagEditorHistoryIdx = idx;
    this.tagEditorHistoryDetailIdx = -1;
  },

  tagEditorSelectHistoryDetail(idx) {
    this.tagEditorHistoryDetailIdx = (this.tagEditorHistoryDetailIdx === idx) ? -1 : idx;
    this._teDiffExpanded = {};       // 切换 step 时重置折叠态
    this._teDiffReorderExpanded = {};
  },

  _teGetHistoryDiff(stepIdx) {
    // D7: 缓存 diff 结果，切换 step 才重算
    if (stepIdx === this._teCachedDiffKey && this._teCachedDiffResult) return this._teCachedDiffResult;
    if (stepIdx < 0 || stepIdx >= this.tagEditorHistory.length) return [];
    var historyItem = this.tagEditorHistory[stepIdx];
    if (historyItem && historyItem.changes) {
      var directDiff = [];
      var selfDirect = this;
      Object.keys(historyItem.changes).forEach(function(path) {
        var change = historyItem.changes[path];
        var beforeTags = change.before == null ? (selfDirect.tagEditorOriginal[path] || '') : change.before;
        var afterTags = change.after == null ? (selfDirect.tagEditorOriginal[path] || '') : change.after;
        var itemDiff = selfDirect._teBuildTagDiff(path, beforeTags, afterTags);
        if (itemDiff) directDiff.push(itemDiff);
      });
      directDiff.sort(function(a, b) { return a.name.localeCompare(b.name); });
      this._teCachedDiffKey = stepIdx;
      this._teCachedDiffResult = directDiff;
      return directDiff;
    }
    var after = this._teSnapOf(historyItem);
    var before = stepIdx > 0 ? this._teSnapOf(this.tagEditorHistory[stepIdx - 1]) : {};
    var original = this.tagEditorOriginal;
    var allPaths = {};
    Object.keys(after).forEach(function(p) { allPaths[p] = true; });
    Object.keys(before).forEach(function(p) { allPaths[p] = true; });
    var diff = [];
    var self = this;
    Object.keys(allPaths).forEach(function(path) {
      var beforeTags = before.hasOwnProperty(path) ? before[path] : (original[path] || '');
      var afterTags = after.hasOwnProperty(path) ? after[path] : (original[path] || '');
      if (beforeTags === afterTags) return;
      var itemDiff = self._teBuildTagDiff(path, beforeTags, afterTags);
      if (itemDiff) diff.push(itemDiff);
    });
    diff.sort(function(a, b) { return a.name.localeCompare(b.name); });
    this._teCachedDiffKey = stepIdx;
    this._teCachedDiffResult = diff;
    return diff;
  },

  _teBuildTagDiff(path, beforeTags, afterTags) {
    var beforeList = _teParseTags(beforeTags);
    var afterList = _teParseTags(afterTags);
    var added = afterList.filter(function(tag) { return beforeList.indexOf(tag) === -1; });
    var removed = beforeList.filter(function(tag) { return afterList.indexOf(tag) === -1; });
    var unchanged = afterList.filter(function(tag) { return beforeList.indexOf(tag) !== -1; });
    var reordered = added.length === 0 && removed.length === 0 && beforeTags !== afterTags;
    var reorderMap = null;
    if (reordered) {
      reorderMap = [];
      for (var i = 0; i < afterList.length; i++) {
        var fromIdx = beforeList.indexOf(afterList[i]);
        if (fromIdx !== -1 && fromIdx !== i) reorderMap.push({ tag: afterList[i], from: fromIdx, to: i });
      }
    }
    if (added.length === 0 && removed.length === 0 && !reordered) return null;
    var img = this._teFindByPath(path);
    return { path: path, name: img ? this._teImageLabel(img) : path, added: added, removed: removed,
      unchanged: unchanged, reordered: reordered, reorderMap: reorderMap };
  },

  _teApplyHistoryChanges(changes, direction) {
    var paths = Object.keys(changes || {});
    for (var i = 0; i < paths.length; i++) {
      var path = paths[i];
      var img = this._teFindByPath(path);
      if (!img) continue;
      var value = changes[path][direction];
      var desired = value == null ? (this.tagEditorOriginal[path] || '') : value;
      if (img.tags !== desired) this._teUpdateImageTags(img, desired);
    }
    var state = {};
    var modified = this._teGetModified();
    for (var j = 0; j < modified.length; j++) state[modified[j].path] = modified[j].tags;
    this._teHistoryState = state;
    this._teInvalidateFilter();
    this.tagEditorDetailText = this.tagEditorGetSelectedImg()?.tags || '';
    this._updateEditorPanel();
  },

  _teApplyCheckpoint(checkpoint) {
    var self = this;
    var hasAnyMod = false;
    this.tagEditorImages.forEach(function(img) {
      if (checkpoint.hasOwnProperty(img.path)) {
        var newTags = checkpoint[img.path];
        if (img.tags !== newTags) {
          self._teUpdateFreq(img.tags, newTags);
          img.tags = newTags;
        }
        if (img.tags !== self.tagEditorOriginal[img.path]) hasAnyMod = true;
      } else {
        if (img.tags !== self.tagEditorOriginal[img.path]) {
          self._teUpdateFreq(img.tags, self.tagEditorOriginal[img.path]);
          img.tags = self.tagEditorOriginal[img.path];
        }
      }
    });
    this.tagEditorModified = hasAnyMod;
    this._teRecountModified();
    var state = {};
    var modified = this._teGetModified();
    for (var i = 0; i < modified.length; i++) state[modified[i].path] = modified[i].tags;
    this._teHistoryState = state;
    this._teInvalidateFilter();
    this.tagEditorDetailText = this.tagEditorGetSelectedImg()?.tags || '';
    this._updateEditorPanel();
  },

  _teUpdateFreq(oldTags, newTags) {
    var oldList = _teParseTags(oldTags);
    var newList = _teParseTags(newTags);
    var newSet = new Set(newList);
    var oldSet = new Set(oldList);
    var removed = oldList.filter(function(t) { return !newSet.has(t); });
    var added = newList.filter(function(t) { return !oldSet.has(t); });
    if (removed.length === 0 && added.length === 0) return;
    if (!this._teFreqIndex) this._teRebuildFreqIndex();
    var freqMap = this._teFreqIndex;
    var self = this;
    removed.forEach(function(t) {
      var item = freqMap.get(t);
      if (item && item.count > 0) item.count--;
    });
    added.forEach(function(t) {
      var item = freqMap.get(t);
      if (item) { item.count++; } else { var newEntry = { tag: t, count: 1 }; self.tagEditorTagFreq.push(newEntry); freqMap.set(t, newEntry); }
    });
    this._teScheduleFreqFinalize();
  },

  // ===== Core Edit Helper =====
  _teUpdateImageTags(img, newTagsStr, options) {
    if (this._tePendingTextEdits[img.path] && !(options && options.deferTextHistory)) {
      this._teFlushPendingTextEdit(img.path);
    }
    var oldTags = img.tags || '';
    var wasMod = oldTags !== this.tagEditorOriginal[img.path];
    img.tags = newTagsStr;
    if (!this._teEditVersions) this._teEditVersions = {};
    this._teEditVersions[img.path] = (this._teEditVersions[img.path] || 0) + 1;
    var isMod = newTagsStr !== this.tagEditorOriginal[img.path];
    if (wasMod !== isMod) {
      this._teBumpModified(isMod ? 1 : -1);
    }
    this.tagEditorModified = this._teModifiedCount > 0;
    this._teInvalidateFilter();
    // Only update detail text if the image being edited is currently selected
    if (this.tagEditorSelected.length === 1 && this.tagEditorSelected[0] === img.path) {
      this.tagEditorDetailText = newTagsStr;
    }
    this._teUpdateFreq(oldTags, newTagsStr);
    this.tagDictionarySyncChips();
  },

  tagEditorModifiedCount() {
    return this._teModifiedCount;
  },

  // ===== Save =====
  async tagEditorSaveAll() {
    this._teFlushAllPendingTextEdits();
    var modified = this._teGetModified();
    if (modified.length === 0) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    var self2 = this;
    // C4: 小批量（≤5 张）跳过确认，减少打断；大批量仍确认
    if (modified.length > 5) {
      this._teConfirmBatch(this.t('tagEditor.batchConfirmAll').replace('{n}', modified.length), function() { self2._doSaveAll(modified); });
    } else {
      this._doSaveAll(modified);
    }
  },

  async _doSaveAll(modified) {
    this.tagEditorSaving = true;
    this._teIsSaving = true;
    this._teSaveProgress = 0;
    var self = this;
    var saveEpoch = ++this._teSaveEpoch;
    var loadEpoch = this._teLoadEpoch;
    var saveDir = this.tagEditorLoadedDir || this.tagEditorDir;
    var processedCount = 0;
    var writtenCount = 0;
    var failedItems = [];
    var saveErrorMessage = '';
    var payload = modified.map(function(img) {
      return {
        path: img.path,
        tags: img.tags,
        edit_version: (self._teEditVersions && self._teEditVersions[img.path]) || 0,
        expected_revision: self._teCaptionRevisions ? self._teCaptionRevisions[img.path] : undefined
      };
    });

    try {
      var r = await fetch('/api/tageditor/save-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: saveDir, images: payload })
      });
      var j = await r.json();
      if (saveEpoch !== self._teSaveEpoch || loadEpoch !== self._teLoadEpoch || saveDir !== (self.tagEditorLoadedDir || self.tagEditorDir)) return;
      if (j.status !== 'success') {
        saveErrorMessage = j.message || self.t('common.error');
        failedItems = modified.map(function(img) { return { path: img.path, reason: saveErrorMessage }; });
      } else {
        var data = j.data || {};
        var successfulPaths = (data.saved_paths || []).concat(data.skipped_paths || []);
        var successfulLookup = {};
        successfulPaths.forEach(function(path) { successfulLookup[path] = true; });
        var payloadByPath = {};
        payload.forEach(function(item) { payloadByPath[item.path] = item; });
        modified.forEach(function(img) {
          var savedPayload = payloadByPath[img.path];
          if (successfulLookup[img.path] && savedPayload &&
              ((self._teEditVersions && self._teEditVersions[img.path]) || 0) === savedPayload.edit_version) {
            self.tagEditorOriginal[img.path] = savedPayload.tags;
          }
        });
        if (data.revisions && self._teCaptionRevisions) {
          Object.keys(data.revisions).forEach(function(path) { self._teCaptionRevisions[path] = data.revisions[path]; });
        }
        if (Array.isArray(data.conflicts)) failedItems = failedItems.concat(data.conflicts);
        if (Array.isArray(data.failed)) failedItems = failedItems.concat(data.failed);
        processedCount = successfulPaths.length;
        writtenCount = Number(data.saved || 0);
        self._teSaveProgress = 100;
      }
    } catch (e) {
      saveErrorMessage = this.t('common.networkError');
      failedItems = modified.map(function(img) { return { path: img.path, reason: saveErrorMessage }; });
    } finally {
      this.tagEditorSaving = false;
      this._teIsSaving = false;
      this._teSaveProgress = 0;
    }

    var hadHistory = this.tagEditorHistory.length > 0;
    this._teRecountModified();
    this.tagEditorModified = this._teModifiedCount > 0;
    if (processedCount > 0 || this._teModifiedCount === 0) {
      this.tagEditorHistory = [];
      this.tagEditorHistoryIdx = -1;
      this.tagEditorHistoryDetailIdx = -1;
    }
    if (this._teModifiedCount === 0) {
      this._teHistoryState = {};
    } else if (processedCount > 0) {
      var remainingState = {};
      var remainingModified = this._teGetModified();
      for (var rm = 0; rm < remainingModified.length; rm++) {
        remainingState[remainingModified[rm].path] = remainingModified[rm].tags;
      }
      this._teHistoryState = remainingState;
    }
    if (failedItems.length > 0 || this._teModifiedCount > 0) {
      if (processedCount === 0 && saveErrorMessage) {
        this.toast(saveErrorMessage, 'error');
      } else {
        this.toast(this.t('tagEditor.partialSaveFailed')
          .replace('{saved}', processedCount)
          .replace('{failed}', Math.max(failedItems.length, this._teModifiedCount)), 'warning');
      }
      this._teSaveDraft();
    } else {
      this.toast(hadHistory ? this.t('tagEditor.savedArchived') : this.t('common.saved'));
      this._teDraftSavedAt = '';
      this._teRemoveDraft();
    }
    if (writtenCount > 0) {
      self.tagEditorLoadSnapshots(loadEpoch);
      if (this._teModifiedCount === 0) await this.tagEditorReloadSessionPage(this.tagEditorPage);
    }
  },

  tagEditorLoadSnapshots(epoch) {
    var self = this;
    var requestEpoch = epoch == null ? this._teLoadEpoch : epoch;
    if (this._teTimelineAbort) this._teTimelineAbort.abort();
    var controller = new AbortController();
    this._teTimelineAbort = controller;
    this.tagEditorSnapshotLoading = true;
    this.tagEditorSnapshotError = false;
    fetch('/api/tageditor/timeline?dataset_dir=' + encodeURIComponent(this.tagEditorLoadedDir || this.tagEditorDir), { signal: controller.signal })
      .then(function(r) { return r.json(); }).then(function(j) {
        if (requestEpoch !== self._teLoadEpoch || controller.signal.aborted) return;
        if (j.status === 'success') {
          self.tagEditorTimeline = j.data || [];
          self.tagEditorSnapshots = self.tagEditorTimeline;
        } else self.tagEditorSnapshotError = true;
        self.tagEditorSnapshotLoading = false;
        self._teTimelineAbort = null;
      }).catch(function(err) {
        if (requestEpoch !== self._teLoadEpoch || controller.signal.aborted) return;
        self.tagEditorSnapshotError = true;
        self.tagEditorSnapshotLoading = false;
        self._teTimelineAbort = null;
      });
  },

  tagEditorRestoreSnapshot(sid) {
    this._teFlushAllPendingTextEdits();
    if (this.tagEditorModified) {
      this.toast(this.t('tagEditor.timelineUnsaved'), 'warning');
      return;
    }
    this._teTimelineAction(sid, 'restore', 'snapshotRestoreConfirmTitle', 'snapshotRestoreConfirm', 'snapshotRestored');
  },

  tagEditorDeleteSnapshot(sid) {
    this._teTimelineAction(sid, 'delete', 'snapshotDelete', 'snapshotDeleteConfirm', 'snapshotDeleted');
  },

  // C5: 清理全部快照
  tagEditorClearAllSnapshots() {
    this._teTimelineAction(null, 'delete', 'snapshotClearConfirmTitle', 'snapshotClearAllConfirm', 'snapshotCleared');
  },

  _teTimelineAction(sid, action, title, message, success) {
    if (this.tagEditorSnapshotBusy) return;
    var self = this;
    var epoch = this._teLoadEpoch;
    var dir = this.tagEditorLoadedDir || this.tagEditorDir;
    var snapshot = this.tagEditorSnapshots.find(function(item) { return item.id === sid; });
    var description = this.t('tagEditor.' + message);
    if (snapshot) description = this._teFormatSnapshotTime(snapshot.timestamp) + ' · ' + this.t('tagEditor.historyStepImages').replace('{n}', snapshot.file_count) + '\n\n' + description;
    this.openConfirm(this.t('tagEditor.' + title), description, function() {
      if (epoch !== self._teLoadEpoch || self.tagEditorSnapshotBusy) return;
      if (action === 'restore' && (self.tagEditorModified || self._teIsSaving)) {
        self.toast(self.t('tagEditor.timelineUnsaved'), 'warning');
        return;
      }
      self.tagEditorSnapshotBusy = true;
      var path = '/api/tageditor/timeline' + (sid ? '/' + encodeURIComponent(sid) : '') + (action === 'restore' ? '/restore' : '');
      fetch(path + '?dataset_dir=' + encodeURIComponent(dir), { method: action === 'restore' ? 'POST' : 'DELETE' })
        .then(function(r) { return r.json(); }).then(function(j) {
          if (epoch !== self._teLoadEpoch) return;
          if (j.status !== 'success') throw new Error(j.message || self.t('common.error'));
          self.toast(self.t('tagEditor.' + success));
          if (action === 'restore') self.tagEditorLoad(dir);
          else self.tagEditorLoadSnapshots(epoch);
        }).catch(function(err) {
          if (epoch === self._teLoadEpoch) self.toast(err.message || self.t('common.error'), 'error');
        }).finally(function() { self.tagEditorSnapshotBusy = false; });
    }, this.t('common.confirm'));
  },

  _teTimelineLabel(event) {
    var key = { save: 'timelineSave', restore: 'timelineRestore', legacy_backup_restore: 'timelineBackup' }[event.event_type];
    return key ? this.t('tagEditor.' + key) : event.label || event.event_type;
  },

  _teFormatSnapshotTime(ts) {
    var numeric = Number(ts);
    var d = new Date(numeric > 1000000000000 ? numeric : numeric * 1000);
    return d.toLocaleString();
  },

  // ===== Auto-save Draft =====
  _teStartAutoSave() {
    this._teStopAutoSave();
    var self = this;
    this._teAutoSaveInterval = setInterval(function() {
      self._teSaveDraft();
    }, 30000);
  },

  _teStopAutoSave() {
    if (this._teAutoSaveInterval) { clearInterval(this._teAutoSaveInterval); this._teAutoSaveInterval = null; }
  },

  _teSaveDraft() {
    if (!this.tagEditorModified || this._teIsSaving) return;
    try {
      var key = 'tagEditor_draft_' + this.tagEditorDir;
      var orig = this.tagEditorOriginal;
      var data = this._teGetModified()
        .map(function(img) {
          return { path: img.path, tags: img.tags, original: orig[img.path] };
        });
      if (data.length > 0) {
        localStorage.setItem(key, JSON.stringify(data));
      }
      this._teDraftSavedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      this.toast(this.t('tagEditor.draftSaveFailed'), 'warning');
    }
  },

  _teCheckDraft() {
    try {
      var key = 'tagEditor_draft_' + this.tagEditorDir;
      var raw = localStorage.getItem(key);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && data.length > 0) {
          var self = this;
          this._teConfirmUnsaved(this.t('tagEditor.draftFound'), function() {
            data.forEach(function(item) {
              var img = self._teFindByPath(item.path);
              if (img) {
                img.tags = item.tags;
                self.tagEditorOriginal[img.path] = Object.prototype.hasOwnProperty.call(item, 'original')
                  ? item.original
                  : item.tags;
              }
            });
            self.tagEditorModified = true;
            self._teRecountModified();
            self._teRemoveDraft();
            var restoredState = {};
            var restoredModified = self._teGetModified();
            for (var i = 0; i < restoredModified.length; i++) restoredState[restoredModified[i].path] = restoredModified[i].tags;
            self._teHistoryState = restoredState;
            self._teInvalidateFilter();
            self.toast(self.t('tagEditor.autoSaveRestored'));
          });
        }
      }
    } catch (e) { /* ignore */ }
  },

  _teRemoveDraft() {
    try {
      var key = 'tagEditor_draft_' + this.tagEditorDir;
      localStorage.removeItem(key);
    } catch (e) { /* ignore */ }
  },

  // ===== Navigation Guard =====
  _teConfirmUnsaved(msg, cb) {
    this.openConfirm(this.t('tagEditor.unsavedConfirmTitle'), msg, cb, this.t('common.confirm'));
  },

  _teConfirmBatch(msg, cb) {
    this.openConfirm(this.t('tagEditor.batchEditConfirmTitle'), msg, cb, this.t('common.confirm'));
  },

  _teHasUnsavedEdits() {
    if (this.currentRoute !== 'tagEditor') return false;
    this._teFlushAllPendingTextEdits();
    return !!this.tagEditorModified;
  },

  // ===== Keyboard Shortcuts =====
  tagEditorHandleKeydown(e) {
    if (this.tagEditorSnapshotBusy) return;
    // Only active when tag editor is the current route
    if (this.currentRoute !== 'tagEditor') return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.target.closest && e.target.closest('#teDictHover')) {
      if (e.key === 'Escape') this.tagDictionaryCloseHover();
      return;
    }
    var modifier = e.ctrlKey || e.metaKey;
    var editableTarget = this._teIsEditableTarget(e.target);
    if (this.tagEditorLightboxOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.tagEditorCloseLightbox();
      } else if (e.key === 'ArrowLeft' && this.tagEditorCanNavDetail(-1)) {
        e.preventDefault();
        this.tagEditorLightboxNav(-1);
      } else if (e.key === 'ArrowRight' && this.tagEditorCanNavDetail(1)) {
        e.preventDefault();
        this.tagEditorLightboxNav(1);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.tagEditorSetLightboxScale(this.tagEditorLightboxScale * 1.18);
      } else if (e.key === '-') {
        e.preventDefault();
        this.tagEditorSetLightboxScale(this.tagEditorLightboxScale / 1.18);
      } else if (e.key === '0') {
        e.preventDefault();
        this.tagEditorResetLightbox();
      }
      return;
    }
    if (this.showConfirmModal) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelConfirm();
      }
      return;
    }
    if (modifier && (e.key === 's' || e.key === 'S')) {
      if (editableTarget) return;
      e.preventDefault();
      this.tagEditorSaveAll();
      return;
    }
    if (modifier && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (editableTarget) return;
      e.preventDefault();
      this.tagEditorUndo();
      return;
    }
    if (modifier && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (editableTarget) return;
      e.preventDefault();
      this.tagEditorRedo();
      return;
    }
    if (modifier && (e.key === 'a' || e.key === 'A')) {
      if (editableTarget) return;
      e.preventDefault();
      this.tagEditorSelectAll();
      return;
    }
    if (modifier && (e.key === 'c' || e.key === 'C')) {
      if (editableTarget) return;
      if (this.tagEditorSelected.length === 1) {
        e.preventDefault();
        this.tagEditorCopySelectedTags();
      }
      return;
    }
    if (modifier && (e.key === 'v' || e.key === 'V')) {
      if (editableTarget) return;
      if (this.tagEditorSelected.length === 1 && this.tagEditorCopiedTags.length > 0) {
        e.preventDefault();
        this.tagEditorPasteTagsToSelected();
      }
      return;
    }
    if (e.key === 'ArrowDown' && this.tagEditorSuggestions.length > 0
        && this._teSuggestInputEl && e.target === this._teSuggestInputEl) {
      e.preventDefault();
      this.tagEditorSuggestIdx = Math.min(this.tagEditorSuggestIdx + 1, this.tagEditorSuggestions.length - 1);
      this._teScrollSuggestion();
      return;
    }
    if (e.key === 'ArrowUp' && this.tagEditorSuggestions.length > 0
        && this._teSuggestInputEl && e.target === this._teSuggestInputEl) {
      e.preventDefault();
      this.tagEditorSuggestIdx = Math.max(this.tagEditorSuggestIdx - 1, -1);
      this._teScrollSuggestion();
      return;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && this.tagEditorSuggestions.length > 0 &&
        this._teSuggestInputEl && e.target === this._teSuggestInputEl &&
        this.tagEditorSuggestIdx >= 0 && this.tagEditorSuggestIdx < this.tagEditorSuggestions.length) {
      e.preventDefault();
      this.tagEditorSelectSuggestion(this.tagEditorSuggestions[this.tagEditorSuggestIdx]);
      return;
    }
    if (e.key === 'Escape') {
      if (this.tagEditorPanelMenu) { this.tagEditorPanelMenu = null; return; }
      if (this.tagEditorQuickRemove) { this.tagEditorCancelQuickRemove(); return; }
      if (this.tagEditorSuggestions.length) {
        e.preventDefault();
        this._teCloseSuggestions();
        return;
      }
      if (this.tagDictionaryPanelOpen) {
        this.tagDictionaryPanelOpen = false;
        return;
      }
      if (this.tagEditorShortcutsOpen) {
        this.tagEditorShortcutsOpen = false;
        return;
      }
      if (this.tagDictionaryHover) {
        this.tagDictionaryCloseHover();
        return;
      }
      if (this.tagEditorContextMenu) {
        this.tagEditorContextMenu = null;
        return;
      }
      if (editableTarget) {
        var editableElement = e.target && typeof e.target.closest === 'function'
          ? e.target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
          : null;
        if (editableElement && typeof editableElement.blur === 'function') editableElement.blur();
        return;
      }
      if (this.tagEditorSelected.length > 0) {
        this._teFlushAllPendingTextEdits();
        this.tagEditorSelected = [];
      }
      return;
    }
    if (e.key === 'ArrowLeft' && this.tagEditorSelected.length === 1) {
      // 不在可编辑元素内时才翻图，否则让光标移动（A2）
      if (editableTarget) return;
      e.preventDefault();
      this.tagEditorNavDetail(-1);
      return;
    }
    if (e.key === 'ArrowRight' && this.tagEditorSelected.length === 1) {
      if (editableTarget) return;
      e.preventDefault();
      this.tagEditorNavDetail(1);
      return;
    }
    if (e.key === 'Enter' && !modifier && !editableTarget && this.tagEditorSelected.length === 1) {
      // 卡片上的 Enter 由 tagEditorCardEnter 处理；其余区域 Enter 聚焦添加框，补全键盘流
      var enterCard = e.target && typeof e.target.closest === 'function' ? e.target.closest('.te-card') : null;
      if (!enterCard && this._teFocusEditorInput()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Tab' && !modifier) {
      var card = e.target && typeof e.target.closest === 'function' ? e.target.closest('.te-card') : null;
      if (card && !e.shiftKey) {
        if (this._teFocusEditorInput()) {
          e.preventDefault();
          return;
        }
      }
      if (editableTarget && e.shiftKey && e.target && e.target.closest && e.target.closest('.te-editor')) {
        var selectedCard = document.querySelector('.te-card.selected');
        if (selectedCard) {
          e.preventDefault();
          selectedCard.focus();
          return;
        }
      }
    }
    if (modifier && (e.key === 'f' || e.key === 'F')) {
      if (editableTarget) return;
      e.preventDefault();
      var searchInput = document.getElementById('te-search-input');
      if (searchInput) searchInput.focus();
      return;
    }
  }
};
