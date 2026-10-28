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

var TE_SUGGEST_FIELDS = { single: 'tagEditorAddInput', add: 'batchAddInput', remove: 'batchRemoveInput', old: 'batchOldTag', new: 'batchNewTag' };

// Textareas expose LF even for CRLF files. Keep file formatting in the single
// authoritative caption string; untouched lines retain their original endings.
function _teTextFromInput(value, previous, original) {
  var format = original == null ? previous : original;
  var bom = format.startsWith('\uFEFF') ? '\uFEFF' : '';
  if (bom && !value.startsWith(bom)) value = bom + value;
  var normalize = function(s) { return s.replace(/\r\n|\r/g, '\n'); };
  if (normalize(previous) === normalize(value)) return previous;
  if (normalize(format) === normalize(value)) return format;
  var oldLines = previous.split(/\r\n|\r|\n/);
  var endings = previous.match(/\r\n|\r|\n/g) || [];
  var lines = value.split(/\r\n|\r|\n/);
  var prefix = 0, suffix = 0;
  while (prefix < Math.min(lines.length, oldLines.length) && lines[prefix] === oldLines[prefix]) prefix++;
  while (suffix < Math.min(lines.length, oldLines.length) - prefix &&
      lines[lines.length - 1 - suffix] === oldLines[oldLines.length - 1 - suffix]) suffix++;
  var fallback = endings[0] || (format.match(/\r\n|\r|\n/) || [])[0] || '\n';
  return lines.map(function(line, index) {
    if (index === lines.length - 1) return line;
    var oldIndex = index < prefix || lines.length === oldLines.length ? index
      : index >= lines.length - suffix ? oldLines.length - (lines.length - index) : -1;
    return line + (endings[oldIndex] || fallback);
  }).join('');
}

function _teInputText(raw) {
  return (raw || '').replace(/\r\n|\r/g, '\n');
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
  var above = Math.max(0, rect.top - gap - margin);
  var below = Math.max(0, viewportHeight - rect.bottom - gap - margin);
  var openAbove = above >= below;
  return {
    left: Math.round(left) + 'px',
    top: openAbove ? 'auto' : Math.round(rect.bottom + gap) + 'px',
    bottom: openAbove ? Math.round(viewportHeight - rect.top + gap) + 'px' : 'auto',
    width: Math.round(width) + 'px',
    maxHeight: Math.floor(Math.min(300, openAbove ? above : below)) + 'px'
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
  ...window.tagEditorSession,

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
  tagEditorOpenPath: '',
  tagEditorSwitchOpen: false,
  tagEditorTimeline: [],
  tagEditorRightWidth: 340,
  tagEditorLeftWidth: 260,
  _teLayoutWidth: 0,
  tagEditorCompactLayout: false,
  _teResizeSide: 'right',
  tagEditorPreviewRatio: 0.5,
  _tePreviewDrag: null,
  tagEditorResizing: false,
  _teGridResizeObserver: null,

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
  tagEditorGroupByDir: false,
  tagEditorContextMenu: null,
  tagEditorImageContextMenu: null,
  tagEditorPanelMenu: null,
  _tePanelMenuTrigger: null,
  _teTagMenuTrigger: null,
  _teImageMenuTrigger: null,
  _teMenuFocusRequest: 0,
  tagEditorQuickRemove: false,
  tagEditorRemovalTags: [],
  tagEditorLeftCollapsed: false,
  _teLastSelected: null,
  _teNavRequest: 0,

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
  tagEditorWorkMode: 'tags',
  tagEditorRequestedMode: '',
  _teModeEpoch: 0,
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
  _teSuggestField: null,
  _teSuggestQuery: '',
  _teSuggestLimit: 20,
  tagEditorSuggestHasMore: false,
  tagEditorSuggestLoading: false,
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
  _teDraftRemainder: [],
  _teDraftRestoreBusy: false,
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
  _teTimelineAbort: null,
  _teSaveEpoch: 0,
  _teEditVersions: null,
  _teCaptionRevisions: null,
  _teModifiedRefreshPending: false,
  // ===== Internal Utilities =====
  _teInvalidateFilter() {
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    this._teQuickCountNoTag = undefined;
    this._teQuickCountMod = undefined;
    this._teCachedSelectedStatsKey = '';
    this._teCachedSelectedStats = null;
    if (this.tagEditorSessionId && this.tagEditorQuickFilter === 'modified' && !this._teModifiedRefreshPending) {
      // 合并同一次批量编辑中的刷新，避免每改一张都重新筛选整个集合。
      this._teModifiedRefreshPending = true;
      Promise.resolve().then(() => {
        this._teModifiedRefreshPending = false;
        if (this.tagEditorSessionId && this.tagEditorQuickFilter === 'modified') this._teRefreshModifiedPage();
      });
    }
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
    this._teSessionRecovery = null;
    this._teLastSelected = null;
    this._teLoadEpoch++;
    this.tagEditorSaving = this._teIsSaving = false;
    this.tagEditorSnapshotBusy = false;
    if (this._teLoadAbort) { this._teLoadAbort.abort(); this._teLoadAbort = null; }
    this._teCancelPageFetch();
    if (this._teAllAbort) { this._teAllAbort.abort(); this._teAllAbort = null; }
    if (this._teTimelineAbort) { this._teTimelineAbort.abort(); this._teTimelineAbort = null; }
    this._teCloseSession(this.tagEditorSessionId);
    this.tagEditorSessionId = '';
    this.tagEditorStopResize();
    this.tagEditorStopPreviewResize();
    this.tagEditorCloseLightbox();
    this.tagEditorShortcutsOpen = false;
    this._teStopAutoSave();
    this._teCloseSuggestions();
    if (this._teSearchDebounce) { clearTimeout(this._teSearchDebounce); this._teSearchDebounce = null; }
    if (this._teTagSearchDebounce) { clearTimeout(this._teTagSearchDebounce); this._teTagSearchDebounce = null; }
    this._teDiscardPendingTextEdits();
    // Worker 留着复用（换回本页不用再下词典），只清掉悬停卡与待发请求
    this.tagDictionaryCleanup();
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
    var layout = this.tagEditorPanelLayout();
    var other = left ? layout.right : (this.tagEditorLeftCollapsed || this.tagEditorCompactLayout ? 0 : layout.left);
    var min = left ? 180 : 280;
    var max = left ? 420 : 520;
    if (main && main.clientWidth) max = Math.min(max, Math.max(min, main.clientWidth - other - 216));
    this[left ? 'tagEditorLeftWidth' : 'tagEditorRightWidth'] = Math.max(min, Math.min(max, width));
  },

  tagEditorPanelLayout() {
    var left = this.tagEditorLeftWidth, right = this.tagEditorRightWidth;
    var width = this._teLayoutWidth;
    var hasLeft = !this.tagEditorLeftCollapsed && !this.tagEditorCompactLayout;
    if (width > 0) {
      // Keep a usable image column; fitting never changes the saved preference.
      if (hasLeft) left = Math.max(180, Math.min(left, width - right - 216));
      right = Math.max(280, Math.min(right, width - (hasLeft ? left + 16 : 8) - 200));
    }
    return { left: left, right: right };
  },

  tagEditorPanelStyle() {
    var layout = this.tagEditorPanelLayout();
    return '--te-right-w:' + layout.right + 'px;--te-left-w:' + layout.left + 'px';
  },

  tagEditorActiveFilterCount() {
    return this.tagEditorTagSelection.length + this.tagEditorExcludedTags.length
      + (this.tagEditorSearchQuery ? 1 : 0) + (this.tagEditorQuickFilter !== 'all' ? 1 : 0);
  },

  tagEditorCloseSidebar(event) {
    if (this.tagEditorLeftCollapsed || event?.isComposing || event?.keyCode === 229) return;
    event?.preventDefault();
    event?.stopPropagation();
    this.tagEditorLeftCollapsed = true;
    var epoch = this._teLoadEpoch;
    this.$nextTick(() => {
      if (epoch !== this._teLoadEpoch || this.currentRoute !== 'tagEditor') return;
      var toggle = document.getElementById('te-sidebar-toggle');
      if (toggle?.getClientRects().length) toggle.focus();
    });
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
    this.tagEditorSetPanelWidth('right', this.tagEditorPanelLayout().right + delta);
    try { localStorage.setItem('tagEditor_rightWidth', String(Math.round(this.tagEditorRightWidth))); } catch (e) {}
    this.tagEditorRefreshSuggestPosition();
  },

  tagEditorAdjustLeftWidth(delta) {
    this.tagEditorSetPanelWidth('left', this.tagEditorPanelLayout().left + delta);
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
    // At compact desktop widths the tag cloud overlays the grid instead of
    // permanently consuming a column. Start collapsed so the image wall is usable.
    if (window.matchMedia && window.matchMedia('(max-width: 1200px)').matches) {
      this.tagEditorCompactLayout = true;
      this.tagEditorLeftCollapsed = true;
    }
    if (!this._teCompactMedia && window.matchMedia) {
      this._teCompactMedia = window.matchMedia('(max-width: 1200px)');
      this._teCompactListener = function(event) {
        self.tagEditorCompactLayout = event.matches;
        if (event.matches) self.tagEditorLeftCollapsed = true;
      };
      if (this._teCompactMedia.addEventListener) {
        this._teCompactMedia.addEventListener('change', this._teCompactListener);
      }
    }
    this.$nextTick(function() {
      var grid = document.getElementById('teV3Grid');
      if (!grid) return;
      var main = grid.closest('.te-main');
      if (self._teGridResizeObserver) self._teGridResizeObserver.disconnect();
      var update = function() {
        if (main && main.clientWidth > 0) self._teLayoutWidth = main.clientWidth;
        self._teUpdateGridCardSize(grid);
      };
      self._teGridResizeObserver = new ResizeObserver(update);
      self._teGridResizeObserver.observe(grid);
      if (main) self._teGridResizeObserver.observe(main);
      update();
    });
  },

  _teUpdateGridCardSize(grid) {
    if (!grid || grid.clientWidth <= 0) return;
    var style = getComputedStyle(grid);
    var gap = parseFloat(style.columnGap) || 8;
    var padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    var available = Math.max(1, grid.clientWidth - padding);
    var compact = window.matchMedia && window.matchMedia('(max-width: 1200px)').matches;
    var minSize = compact ? 148 : 160;
    var columns = Math.max(1, Math.floor((available + gap) / (minSize + gap)));
    var size = Math.min(available, Math.max(minSize, Math.floor((available - gap * (columns - 1)) / columns)));
    grid.style.setProperty('--te-card-size', size + 'px');
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
  tagEditorClearFilters() {
    this.tagEditorTagSelection = [];
    this.tagEditorExcludedTags = [];
    this.tagEditorQuickFilter = 'all';
    this._teInvalidateFilter();
    this.tagEditorClearSearch();
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
      this.tagEditorUseRegex + '|' + this.tagEditorGroupByDir;
    if (cacheKey === this._teFilteredCacheKey && this._teCachedFiltered) return this._teCachedFiltered;

    var images = this._teFilterImages(this.tagEditorImages);
    this._teFilteredCacheKey = cacheKey;
    this._teCachedFiltered = images;
    return images;
  },

  _teFilterImages(source) {
    var images = source.slice();

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
    if (this.tagEditorGroupByDir) this._teGroupImagesByDir(images);

    return images;
  },

  tagEditorImageDirectory(img) {
    var path = (img.rel_path || img.name || '').replace(/\\/g, '/');
    var separator = path.lastIndexOf('/');
    return separator < 0 ? '' : path.slice(0, separator);
  },

  _teGroupImagesByDir(images) {
    var self = this;
    return images.sort(function(a, b) {
      var aDir = self.tagEditorImageDirectory(a);
      var bDir = self.tagEditorImageDirectory(b);
      return aDir < bDir ? -1 : aDir > bDir ? 1 : 0;
    });
  },

  tagEditorToggleDirectoryGroups() {
    this.tagEditorGroupByDir = !this.tagEditorGroupByDir;
    this._teInvalidateFilter();
    this.tagEditorSchedulePageFetch(true);
  },

  tagEditorIsDirectoryGroupStart(img, idx) {
    if (!this.tagEditorGroupByDir) return false;
    var previous = this.tagEditorGetPaged()[idx - 1];
    return !previous || this.tagEditorImageDirectory(previous) !== this.tagEditorImageDirectory(img);
  },

  tagEditorDirectoryImageCount(img) {
    var directory = this.tagEditorImageDirectory(img);
    if (this.tagEditorSessionId) {
      return this.tagEditorDirectoryCounts[directory] || 0;
    }
    var images = this.tagEditorGetFiltered();
    var self = this;
    return images.reduce(function(count, image) {
      return count + (self.tagEditorImageDirectory(image) === directory ? 1 : 0);
    }, 0);
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
    if (this.tagEditorSessionId && type === 'notag') {
      return this.tagEditorNoTagCount + this._teGetModified().reduce((delta, img) =>
        delta + Number(!img.tags.trim()) - Number(!(this.tagEditorOriginal[img.path] || '').trim()), 0);
    }
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
    if (!this.tagEditorAllowsTagOps()) return [];
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
    if (!this.tagEditorAllowsTagOps()) return;
    this._teTagListToggle(this.tagEditorTagSelection, this.tagEditorExcludedTags, tag);
    this._teInvalidateFilter();
    this.tagEditorSchedulePageFetch(true);
  },

  tagEditorTagCtx(e, tag) {
    if (!this.tagEditorAllowsTagOps()) return;
    // Reserve space for the shared menu sizing and rename action.
    var menuW = 220, menuH = 230;
    var x = Math.min(e.clientX, window.innerWidth - menuW - 4);
    var y = Math.min(e.clientY, window.innerHeight - menuH - 4);
    this.tagEditorImageContextMenu = null;
    this.tagEditorPanelMenu = null;
    this.tagEditorContextMenu = { x: x, y: y, tag: tag };
    this.tagDictionaryCloseHover();
    this._teFocusMenu('tagEditorContextMenu', '_teTagMenuTrigger', 'teTagMenu', e);
  },

  tagEditorCtxInclude() {
    if (!this.tagEditorAllowsTagOps()) return;
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this._teTagListToggle(this.tagEditorTagSelection, this.tagEditorExcludedTags, tag)) {
      this._teInvalidateFilter();
      this.tagEditorSchedulePageFetch(true);
    }
    this.tagEditorCloseTagMenu();
  },

  tagEditorCtxExclude() {
    if (!this.tagEditorAllowsTagOps()) return;
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this._teTagListToggle(this.tagEditorExcludedTags, this.tagEditorTagSelection, tag)) {
      this._teInvalidateFilter();
      this.tagEditorSchedulePageFetch(true);
    }
    this.tagEditorCloseTagMenu();
  },

  tagEditorCtxCopy() {
    if (!this.tagEditorAllowsTagOps()) return;
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag) {
      navigator.clipboard.writeText(tag).catch(function() {});
      this.toast(this.t('tagEditor.singleTagCopied').replace('{tag}', tag));
    }
    this.tagEditorCloseTagMenu();
  },

  tagEditorCtxAddAll() {
    if (!this.tagEditorAllowsTagOps()) return;
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    this.tagEditorCloseTagMenu(false);
    if (!tag) return;
    var self = this;
    var modeEpoch = this._teModeEpoch;
    // B6: 给"加入全部"加二次确认（DeleteTag 已有），避免误点难撤销
    this._teConfirmTagBatch(
      this.t('tagEditor.ctxAddAllConfirm').replace('{tag}', tag).replace('{n}', this.tagEditorDatasetCount || this.tagEditorImages.length),
      async function() {
        var affected = 0;
        var images;
        try { images = await self._teEnsureAllImagesLoaded(); }
        catch (e) { if (e.name !== 'AbortError') self.toast(e.message || self.t('common.networkError'), 'error'); return; }
        if (!self.tagEditorAllowsTagOps() || modeEpoch !== self._teModeEpoch) return;
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
    if (!this.tagEditorAllowsTagOps()) return;
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    this.tagEditorCloseTagMenu(false);
    if (!tag) return;
    var self = this;
    var modeEpoch = this._teModeEpoch;
    this._teConfirmTagBatch(
      this.t('tagEditor.deleteTagConfirm').replace('{tag}', tag),
      async function() {
        var affected = 0;
        var images;
        try { images = await self._teEnsureAllImagesLoaded(); }
        catch (e) { if (e.name !== 'AbortError') self.toast(e.message || self.t('common.networkError'), 'error'); return; }
        if (!self.tagEditorAllowsTagOps() || modeEpoch !== self._teModeEpoch) return;
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
    if (!this._teCanRestoreCaptions()) return;
    this._teTimelineAction(null, 'backup', 'backupRestoreConfirmTitle', 'restoreConfirm', 'restored');
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
    this._teFocusMenu('tagEditorImageContextMenu', '_teImageMenuTrigger', 'teImageMenu', e);
  },

  tagEditorCtxViewImage() {
    var img = this.tagEditorImageContextMenu && this.tagEditorImageContextMenu.image;
    var trigger = this._teImageMenuTrigger;
    this.tagEditorCloseImageMenu(false);
    if (img) this.tagEditorOpenLightbox(img, trigger);
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

  tagEditorOpenLightbox(img, trigger) {
    if (!img) return;
    this._teFlushAllPendingTextEdits();
    // 原生弹窗记录实际触发控件，避免将稍后隐藏的菜单项作为返回焦点。
    if (!this.tagEditorLightboxOpen && trigger?.isConnected && trigger.getClientRects().length) trigger.focus();
    if (!this.tagEditorLightboxOpen) this._teLightboxPreviousSelection = this.tagEditorSelected.slice();
    this.tagEditorSelected = [img.path];
    this._updateEditorPanel();
    this.tagEditorLightboxOpen = true;
    this.tagEditorImageContextMenu = null;
    document.body.classList.add('te-lightbox-open');
    this._teLoadLightboxImage(img);
  },

  _teLoadLightboxImage(img) {
    this.tagEditorLightboxImage = img;
    this.tagEditorLightboxSrc = img.preview || img.thumbnail || '';
    this.tagEditorLightboxLoading = true;
    this.tagEditorResetLightbox();
    var self = this;
    var epoch = this._teLoadEpoch;
    var request = ++this._teLightboxRequest;
    var original = new Image();
    original.src = this.tagEditorOriginalUrl(img);
    original.decode().then(function() {
      if (epoch !== self._teLoadEpoch || request !== self._teLightboxRequest || !self.tagEditorLightboxOpen) return;
      self.tagEditorLightboxSrc = original.src;
      self.tagEditorLightboxLoading = false;
    }).catch(function() {
      if (epoch !== self._teLoadEpoch || request !== self._teLightboxRequest || !self.tagEditorLightboxOpen) return;
      self.tagEditorLightboxLoading = false;
      self.toast(self.t('common.networkError'), 'error');
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
    if (!this.tagEditorLightboxOpen) return;
    var request = this._teLightboxRequest, epoch = this._teLoadEpoch;
    var img = await this.tagEditorNavDetail(dir);
    if (!img || !this.tagEditorLightboxOpen || epoch !== this._teLoadEpoch || request !== this._teLightboxRequest
      || this.tagEditorSelected.length !== 1 || this.tagEditorSelected[0] !== img.path) return;
    this._teLoadLightboxImage(img);
  },

  tagEditorGridBgClick(e) {
    if (!e.target.closest('.te-card') && !e.target.closest('.te-editor')) {
      this.tagEditorClearSelection();
    }
  },

  tagEditorClearSelection() {
    this._teFlushAllPendingTextEdits();
    this.tagEditorSelected = [];
    this._teLastSelected = null;
    this._updateEditorPanel();
  },

  tagEditorCardClick(img, idx, e) {
    this._teFlushAllPendingTextEdits();
    var filtered = this.tagEditorGetPaged();
    var currentIdx = filtered.findIndex(item => item.path === img.path);
    var anchorIdx = filtered.findIndex(item => item.path === this._teLastSelected);

    if (e.ctrlKey || e.metaKey) {
      var existsIdx = this.tagEditorSelected.indexOf(img.path);
      if (existsIdx === -1) {
        this.tagEditorSelected.push(img.path);
      } else {
        this.tagEditorSelected.splice(existsIdx, 1);
      }
    } else if (e.shiftKey && anchorIdx >= 0 && currentIdx >= 0) {
      var start2 = Math.min(anchorIdx, currentIdx);
      var end2 = Math.max(anchorIdx, currentIdx);
      var visible = new Set(filtered.map(item => item.path));
      this.tagEditorSelected = this.tagEditorSelected.filter(path => !visible.has(path));
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
    this._teLastSelected = img.path;
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
    if (e.target !== e.currentTarget) return;
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
    this.tagEditorOpenLightbox(img, e?.currentTarget);
  },

  tagEditorToggleSelect(path, e) {
    this._teFlushAllPendingTextEdits();
    var idx = this.tagEditorSelected.indexOf(path);
    if (idx === -1) {
      this.tagEditorSelected.push(path);
    } else {
      this.tagEditorSelected.splice(idx, 1);
    }
    this._teLastSelected = path;
    this._updateEditorPanel();
  },

  tagEditorSelectAll() {
    this._teFlushAllPendingTextEdits();
    this.tagEditorSelected = Array.from(new Set(this.tagEditorSelected.concat(this.tagEditorGetPaged().map(img => img.path))));
    this._teLastSelected = null;
    this._updateEditorPanel();
  },

  async tagEditorSelectFiltered() {
    this._teFlushAllPendingTextEdits();
    var epoch = this._teLoadEpoch;
    try {
      this._teSearchLoading = true;
      var filtered = await this._teFetchAllSessionItems(true);
      this.tagEditorSelected = filtered.map(function(img) { return img.path; });
      this._teLastSelected = null;
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
    var visible = new Set(filtered.map(img => img.path));
    this.tagEditorSelected = sel.filter(path => !visible.has(path));
    for (var i = 0; i < filtered.length; i++) {
      var p = filtered[i].path;
      if (sel.indexOf(p) === -1) this.tagEditorSelected.push(p);
    }
    this._teLastSelected = null;
    this._updateEditorPanel();
  },

  tagEditorOutsidePageCount(paths = this.tagEditorSelected) {
    var visible = new Set(this.tagEditorGetPaged().map(img => img.path));
    return paths.filter(path => !visible.has(path)).length;
  },

  tagEditorSelectionLabel() {
    var outside = this.tagEditorOutsidePageCount();
    return this.t(outside ? 'tagEditor.selectedOutsidePage' : 'tagEditor.selected')
      .replace('{n}', this.tagEditorSelected.length).replace('{outside}', outside);
  },

  _teOutsidePageHint(paths) {
    var count = this.tagEditorOutsidePageCount(paths);
    return count ? '\n' + this.t('tagEditor.batchOutsidePage').replace('{n}', count) : '';
  },

  _updateEditorPanel() {
    ++this._teNavRequest;
    this.tagEditorCancelQuickRemove();
    this.tagEditorPanelMenu = null;
    this._teCloseSuggestions();
    if (this.tagEditorSelected.length === 1) {
      var img = this.tagEditorGetSelectedImg();
      if (img) {
        this.tagEditorDetailText = _teInputText(img.tags);
      }
    }
    this.tagDictionarySyncChips();
  },

  tagEditorGetSelectedImg() {
    if (this.tagEditorSelected.length < 1) return null;
    return this._teFindByPath(this.tagEditorSelected[0]);
  },

  tagEditorGetSelectedTags() {
    if (!this.tagEditorAllowsTagOps()) return [];
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
    if (!this.tagEditorAllowsTagOps()) return;
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
    if (!this.tagEditorAllowsTagOps()) return;
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
    this._teFocusMenu('tagEditorPanelMenu', '_tePanelMenuTrigger', 'tePanelMenu', event);
  },

  _teFocusMenu(stateKey, triggerKey, id, event) {
    this[triggerKey] = event.target?.closest?.('[tabindex], button') || event.currentTarget?.querySelector?.('button, [tabindex]') || event.currentTarget;
    var state = this[stateKey], epoch = this._teLoadEpoch;
    var request = ++this._teMenuFocusRequest;
    this.$nextTick(() => {
      if (this[stateKey] !== state || epoch !== this._teLoadEpoch || request !== this._teMenuFocusRequest || this.currentRoute !== 'tagEditor') return;
      var menu = document.getElementById(id);
      (this._teVisibleMenuButtons(menu)[0] || menu)?.focus();
    });
  },

  _teVisibleMenuButtons(menu) {
    return Array.from(menu?.querySelectorAll('button') || []).filter(button => !button.disabled && button.getClientRects().length);
  },

  tagEditorClosePanelMenu(restoreFocus = true) {
    this._teCloseMenu('tagEditorPanelMenu', '_tePanelMenuTrigger', restoreFocus);
  },

  tagEditorCloseTagMenu(restoreFocus = true) {
    this._teCloseMenu('tagEditorContextMenu', '_teTagMenuTrigger', restoreFocus);
  },

  tagEditorCloseImageMenu(restoreFocus = true) {
    this._teCloseMenu('tagEditorImageContextMenu', '_teImageMenuTrigger', restoreFocus);
  },

  _teCloseMenu(stateKey, triggerKey, restoreFocus) {
    if (!this[stateKey]) return;
    var trigger = this[triggerKey];
    var epoch = this._teLoadEpoch;
    var request = ++this._teMenuFocusRequest;
    this[stateKey] = null;
    this[triggerKey] = null;
    if (restoreFocus) this.$nextTick(() => {
      if (epoch === this._teLoadEpoch && request === this._teMenuFocusRequest && this.currentRoute === 'tagEditor' && !this.tagEditorLightboxOpen && !this.tagEditorShortcutsOpen && !this.showConfirmModal && trigger?.isConnected && trigger.getClientRects().length) trigger.focus();
    });
  },

  async tagEditorPanelAction(action) {
    var menu = this.tagEditorPanelMenu;
    if (!menu) return;
    var trigger = this._tePanelMenuTrigger;
    this.tagEditorClosePanelMenu(action !== 'view');
    if (!this.tagEditorAllowsTagOps() && ['copy', 'remove', 'filter', 'quick'].includes(action)) return;
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
    else if (action === 'view') this.tagEditorOpenLightbox(this.tagEditorGetSelectedImg(), trigger);
    else if (action === 'revert') this.tagEditorRevertSelectedImage();
    else if (action === 'undo') this.tagEditorUndo();
    else if (action === 'redo') this.tagEditorRedo();
  },

  tagEditorPanelMenuKeydown(event) {
    // 菜单使用自己的键盘交互，不触发页面级翻图或“开始编辑”。
    event.stopPropagation();
    if (event.key === 'Tab') {
      var trigger = this.tagEditorPanelMenu ? this._tePanelMenuTrigger
        : this.tagEditorContextMenu ? this._teTagMenuTrigger : this._teImageMenuTrigger;
      this.tagEditorClosePanelMenu(false);
      this.tagEditorCloseTagMenu(false);
      this.tagEditorCloseImageMenu(false);
      if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus();
      return;
    }
    var buttons = this._teVisibleMenuButtons(event.currentTarget);
    var index = buttons.indexOf(document.activeElement);
    if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    var next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  },

  tagEditorAddTagToSelected() {
    if (!this.tagEditorAllowsTagOps()) return;
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
    if (!this.tagEditorAllowsTagOps()) return;
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
    if (!this.tagEditorAllowsTagOps()) return;
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
    if (!this.tagEditorAllowsTagOps()) return;
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
    var originalTags = tags.slice();
    var moving = tags.splice(srcIdx, 1)[0];
    var destIdx = tags.length;
    var dropTarget = e.target.closest('.te-editor-tag');
    if (dropTarget && dropTarget.dataset.ti != null) {
      var dropIdx = parseInt(dropTarget.dataset.ti, 10);
      if (!isNaN(dropIdx)) {
        if (dropIdx === srcIdx) return;
        var adjIdx = dropIdx > srcIdx ? dropIdx - 1 : dropIdx;
        destIdx = dropPos === 'after' ? adjIdx + 1 : adjIdx;
      }
    }
    tags.splice(destIdx, 0, moving);
    if (tags.every((tag, index) => tag === originalTags[index])) return;
    this._teUpdateImageTags(img, tags.join(', '));
    this._tePushHistory({ type: 'reorder', desc: this.t('tagEditor.historyStepReorder') + ' · ' + moving + ' @' + this._teImageLabel(img), affected: 1 });
  },

  tagEditorDetailEditTag(ti) {
    this.tagEditorSetDetailView('text');
  },

  tagEditorDetailTextChange(event) {
    // Alpine defers x-model during IME composition. Commit the completed input,
    // never the stale model or a half-composed candidate.
    if (event && (event.isComposing || event.target?.composing)) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    if (event && event.target) this.tagEditorDetailText = event.target.value;
    var self = this;
    var path = img.path;
    if (this._tePendingTextEdits[path]) {
      clearTimeout(this._tePendingTextEdits[path]);
      delete this._tePendingTextEdits[path];
    }
    // 文本内容立即进入编辑状态，只有历史记录防抖，避免快速保存或切图时丢失最后一次输入。
    this._teUpdateImageTags(img, _teTextFromInput(this.tagEditorDetailText, img.tags || '', this.tagEditorOriginal[img.path]), { deferTextHistory: true });
    this._tePendingTextEdits[path] = setTimeout(function() {
      self._teFlushPendingTextEdit(path);
    }, 500);
  },

  tagEditorCopySelectedTags() {
    if (!this.tagEditorAllowsTagOps()) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = _teParseTags(img.tags);
    this.tagEditorCopiedTags = tags.slice();
    this.toast(this.t('tagEditor.tagsCopied').replace('{n}', tags.length));
  },

  tagEditorPasteTagsToSelected() {
    if (!this.tagEditorAllowsTagOps()) return;
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
    var request = ++this._teNavRequest;
    var epoch = this._teLoadEpoch, session = this.tagEditorSessionId;
    var selected = this.tagEditorSelected[0];
    var filtered = this.tagEditorGetFiltered();
    var currentIdx = this._teFindCurrentFilteredIdx();
    if (currentIdx < 0) return;
    var newIdx = currentIdx + dir;
    if (newIdx >= 0 && newIdx < filtered.length) {
      this.tagEditorSelected = [filtered[newIdx].path];
      this._updateEditorPanel();
      this._teScrollSelectedIntoView();
      return filtered[newIdx];
    }
    if (this.tagEditorSessionId) {
      var nextPage = this.tagEditorPage + (dir < 0 ? -1 : 1);
      if (nextPage < 1 || nextPage > this.tagEditorTotalPages()) return;
      var query = this._teSessionQueryKey(nextPage);
      var isCurrent = () => request === this._teNavRequest && epoch === this._teLoadEpoch && session === this.tagEditorSessionId
        && this.tagEditorSelected.length === 1 && this.tagEditorSelected[0] === selected
        && query === this._teSessionQueryKey(nextPage);
      var loaded = await this.tagEditorFetchPage(nextPage, { isCurrent: isCurrent });
      if (!loaded || !isCurrent() || this.tagEditorPage !== nextPage) return;
      var nextItems = this.tagEditorGetPaged();
      var next = dir < 0 ? nextItems[nextItems.length - 1] : nextItems[0];
      if (next) {
        this.tagEditorSelected = [next.path];
        this._updateEditorPanel();
        this._teScrollSelectedIntoView();
        return next;
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
  tagEditorSuggestBindings(field) {
    var suggest = event => this.tagEditorGetSuggestions(field, event.target);
    return {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-controls': 'te-tag-suggestions',
      ':aria-expanded': () => this._teSuggestField === field && this.tagEditorSuggestions.length > 0,
      ':aria-activedescendant': () => this._teSuggestField === field && this.tagEditorSuggestIdx >= 0 ? 'te-tag-suggestion-' + this.tagEditorSuggestIdx : null,
      '@input': event => { if (!event.isComposing) suggest(event); },
      '@compositionstart': () => this._teCloseSuggestions(),
      '@compositionend': suggest,
      '@focus': suggest,
      '@click': suggest,
      '@keyup': event => { if (!event.isComposing && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) suggest(event); },
      '@blur': () => this.tagEditorBlurSuggest(),
      '@keydown': event => this.tagEditorSuggestKeydown(event, field)
    };
  },

  _teMergeSuggestions(local, dictionary, limit) {
    return _teSuggestMerge(local, dictionary, limit, tag => this.tagDictionaryMetaFor(tag));
  },

  tagEditorGetSuggestions(field, inputEl) {
    if (!this.tagEditorAllowsTagOps()) return;
    this._teCloseSuggestions();
    var key = TE_SUGGEST_FIELDS[field];
    if (!key || !inputEl) return;
    var val = inputEl.value;
    var token = field === 'old' || field === 'new' ? val.trim() : _teGetCurrentToken(val, inputEl.selectionStart);
    if (!token) return;
    this._teSuggestField = field;
    this._teSuggestInputEl = inputEl;
    this._teSuggestQuery = token;
    this._teSuggestLimit = TD_SUGGEST_LIMIT;
    var seq = this._teSuggestSeq;
    var self = this;
    this._teSuggestTimer = setTimeout(function() {
      self._teSuggestTimer = null;
      self._teFetchSuggestions(seq);
    }, 100);
  },

  async _teFetchSuggestions(seq) {
    var existingOnly = this._teSuggestField === 'remove' || this._teSuggestField === 'old';
    var source = existingOnly ? this.tagEditorGetSelectedStats() : this.tagEditorTagFreq;
    var tags = source.map(function(item) { return item.tag; });
    var limit = this._teSuggestLimit;
    var query = this._teSuggestQuery;
    var key = TagDictionary.normalizeKey(query);
    var local = tags.filter(function(tag) { return TagDictionary.normalizeKey(tag).includes(key); });
    // 先显示本地结果；词典没安装或查询失败时，仍然可以查看全部本地匹配。
    if (!this.tagEditorSuggestions.length) this._teSetSuggestions(this._teMergeSuggestions(local, [], limit + 1), limit);
    this.tagEditorSuggestLoading = true;
    var reply = await this.tagDictionaryComplete(query, { sourceTags: tags, existingOnly: existingOnly, limit: limit + 1 });
    if (seq !== this._teSuggestSeq) return;
    this.tagEditorSuggestLoading = false;
    this._teSetSuggestions(this._teMergeSuggestions(reply ? reply.localTags : local, reply ? reply.results : [], limit + 1), limit);
  },

  _teSetSuggestions(items, limit) {
    var active = this.tagEditorSuggestions[this.tagEditorSuggestIdx];
    this.tagEditorSuggestHasMore = items.length > limit;
    this.tagEditorSuggestions = items.slice(0, limit);
    if (active) this.tagEditorSuggestIdx = this.tagEditorSuggestions.findIndex(function(item) { return item.insert === active.insert; });
    this._teSuggestCoords = items.length && this._teSuggestInputEl ? _teGetSuggestCoords(this._teSuggestInputEl) : null;
  },

  async tagEditorMoreSuggestions() {
    if (!this.tagEditorSuggestHasMore || this.tagEditorSuggestLoading) return;
    this._teSuggestLimit += TD_SUGGEST_LIMIT;
    await this._teFetchSuggestions(++this._teSuggestSeq);
  },

  tagEditorRefreshSuggestPosition(event) {
    if (event && event.target.closest && event.target.closest('.te-suggest')) return;
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
    this._teSuggestInputEl = null;
    this._teSuggestField = null;
    this._teSuggestQuery = '';
    this.tagEditorSuggestHasMore = false;
    this.tagEditorSuggestLoading = false;
  },

  _teScrollSuggestion() {
    this.$nextTick(function () {
      var active = document.querySelector('#te-tag-suggestions .te-suggest-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    });
  },

  tagEditorBlurSuggest() {
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    this._teSuggestSeq++;
    this.tagEditorSuggestLoading = false;
    var self = this;
    this._teBlurTimer = setTimeout(function() {
      self._teCloseSuggestions();
    }, 200);
  },

  tagEditorSelectSuggestion(s) {
    if (!this.tagEditorAllowsTagOps()) return;
    // 下拉条目可能是词典结果对象：插入的是 Anima 格式的 insert，不是别名也不是下划线原形
    var insert = (s && typeof s === 'object') ? (s.insert || '') : s;
    if (!insert) return;
    var el = this._teSuggestInputEl;
    var field = this._teSuggestField;
    var key = TE_SUGGEST_FIELDS[field];
    if (!key) return;
    var val = this[key] || '';
    var pos = el ? el.selectionStart : val.length;
    var result = field === 'old' || field === 'new' ? { text: insert, caretPos: insert.length } : _teReplaceToken(val, pos, insert);
    this[key] = result.text;
    this._teCloseSuggestions();
    if (el) {
      var self = this;
      this.$nextTick(function() {
        el.focus();
        el.setSelectionRange(result.caretPos, result.caretPos);
        self._teCloseSuggestions();
      });
    }
  },

  tagEditorSuggestKeydown(event, field) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      this._teCloseSuggestions();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!this.tagEditorSuggestions.length) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowDown' && this.tagEditorSuggestIdx === this.tagEditorSuggestions.length - 1 && this.tagEditorSuggestHasMore) {
        var seq = this._teSuggestSeq;
        var next = this.tagEditorSuggestIdx + 1;
        this.tagEditorMoreSuggestions().then(() => {
          if (this._teSuggestSeq === seq + 1 && this.tagEditorSuggestions[next]) {
            this.tagEditorSuggestIdx = next;
            this._teScrollSuggestion();
          }
        });
        return;
      }
      var delta = event.key === 'ArrowDown' ? 1 : -1;
      this.tagEditorSuggestIdx = Math.max(-1, Math.min(this.tagEditorSuggestions.length - 1, this.tagEditorSuggestIdx + delta));
      this._teScrollSuggestion();
      return;
    }
    if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) && this.tagEditorSuggestions[this.tagEditorSuggestIdx]) {
      event.preventDefault(); event.stopPropagation();
      this.tagEditorSelectSuggestion(this.tagEditorSuggestions[this.tagEditorSuggestIdx]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      this._teCloseSuggestions();
      if (field === 'single') this.tagEditorAddTagToSelected();
      else if (this.tagEditorBatchMode === 'add') this.tagEditorBatchAdd();
      else if (this.tagEditorBatchMode === 'remove') this.tagEditorBatchRemove();
      else if (this.tagEditorBatchMode === 'replace') this.tagEditorBatchReplace();
    }
  },

  // ===== Batch Operations =====
  tagEditorSetBatchMode(mode) {
    this._teCloseSuggestions();
    this.tagEditorBatchMode = mode;
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

  tagEditorGetBatchTargets() {
    var selected = new Set(this.tagEditorSelected);
    return this.tagEditorImages.filter(function(img) { return selected.has(img.path); });
  },

  // ===== Inline Tag Editing =====
  tagEditorStartInlineEdit(tag, event) {
    if (!this.tagEditorAllowsTagOps()) return;
    event.stopPropagation();
    this.tagEditorInlineEdit = { oldTag: tag, newTag: tag };
    this.$nextTick(function() {
      var input = document.getElementById('te-inline-edit-input');
      if (input) { input.focus(); input.select(); }
    });
  },

  _teInlineEditIsComposing(event) {
    return this.tagEditorInlineEdit?.composing || event?.isComposing || event?.target?.composing || event?.keyCode === 229;
  },

  tagEditorInlineCompositionEnd(event) {
    var edit = this.tagEditorInlineEdit;
    if (!edit) return;
    edit.composing = false;
    edit.newTag = event.target.value;
    if (edit.finishAfterComposition) {
      // 等 Alpine 完成组合输入同步；期间切换模式或关闭编辑器时不再提交。
      return this.$nextTick(() => {
        if (this.tagEditorInlineEdit === edit) return this.tagEditorFinishInlineEdit(event);
      });
    }
  },

  async tagEditorFinishInlineEdit(event) {
    if (!this.tagEditorAllowsTagOps()) return;
    if (!this.tagEditorInlineEdit) return;
    if (this._teInlineEditIsComposing(event)) {
      if (event?.type === 'blur') this.tagEditorInlineEdit.finishAfterComposition = true;
      return;
    }
    if (event?.type === 'keydown') { event.preventDefault?.(); event.stopPropagation?.(); }
    var oldTag = this.tagEditorInlineEdit.oldTag;
    var newTag = (event?.target ? event.target.value : this.tagEditorInlineEdit.newTag).trim();
    this.tagEditorInlineEdit = null;
    if (!newTag || oldTag === newTag) return;

    // 左侧重命名作用于整个数据集，确认时明确范围，失去焦点不会直接修改图片。
    var self = this;
    var modeEpoch = this._teModeEpoch;
    var images;
    try { images = await this._teEnsureAllImagesLoaded(); }
    catch (e) { if (e.name !== 'AbortError') this.toast(e.message || this.t('common.networkError'), 'error'); return; }
    if (!this.tagEditorAllowsTagOps() || modeEpoch !== this._teModeEpoch) return;
    var targets = images.filter(function(img) { return _teParseTags(img.tags).includes(oldTag); });
    if (!targets.length) { this.toast(this.t('tagEditor.inlineRenameNone'), 'warning'); return; }
    var message = this.t('tagEditor.globalRenameConfirm').replace('{n}', targets.length) + '\n' + oldTag + ' → ' + newTag;
    this._teConfirmTagBatch(message, function() {
      targets.forEach(function(img) {
        var tags = _teParseTags(img.tags).map(function(tag) { return tag === oldTag ? newTag : tag; });
        self._teUpdateImageTags(img, self._teDedupTags(tags).join(', '));
      });
      self._teInvalidateFilter();
      self._tePushHistory({ type: 'rename', desc: oldTag + ' → ' + newTag, affected: targets.length });
      self.toast(self.t('tagEditor.inlineReplaceDone').replace('{old}', oldTag).replace('{new}', newTag).replace('{n}', targets.length));
    });
  },

  tagEditorCancelInlineEdit(event) {
    if (this._teInlineEditIsComposing(event)) return;
    if (event?.type === 'keydown') { event.preventDefault?.(); event.stopPropagation?.(); }
    this.tagEditorInlineEdit = null;
  },

  _teConfirmBatchScope(action, transform, type, description, onDone) {
    if (!this.tagEditorAllowsTagOps()) return;
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
    msg += this._teOutsidePageHint(targets.map(img => img.path));
    var epoch = this._teLoadEpoch;
    var self = this;
    this._teConfirmTagBatch(msg, function() {
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
    if (!this.tagEditorAllowsTagOps()) return;
    this._teFlushAllPendingTextEdits();
    var changes = this.tagEditorGetBatchTargets().map(function(img) {
      var before = String(img.tags || '');
      return { img: img, before: before, after: before.replace(/\\+([()])/g, '$1') };
    }).filter(function(change) { return change.before !== change.after; });
    if (!changes.length) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    var epoch = this._teLoadEpoch;
    var self = this;
    this._teConfirmTagBatch(this.t('tagEditor.unescapeConfirm').replace('{n}', changes.length) + this._teOutsidePageHint(changes.map(change => change.img.path)), function() {
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
      var added = [];
      newTags.forEach(function(t) {
        if (existing.has(t)) return;
        existing.add(t);
        added.push(t);
      });
      return added.length ? (pos === 'front' ? added.concat(tags) : tags.concat(added)).join(', ') : before;
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
    if (!this.tagEditorAllowsTagOps()) return [];
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
    finalMeta.contentMode = this.tagEditorWorkMode;
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

  _teHistoryTextExcerpt(text) {
    // 展示用的原文前缀；历史内容、换行和空白均不改写。
    var end = Math.min(text.length, 360), lines = 0;
    for (var i = 0; i < end; i++) {
      if (text[i] !== '\r' && text[i] !== '\n') continue;
      if (++lines === 6) { end = i; break; }
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
    }
    // 不把 CRLF 或 Unicode 代理对切成两半。
    if (end < text.length && ((text[end - 1] === '\r' && text[end] === '\n')
      || (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])))) end--;
    return text.slice(0, end);
  },

  _teHistoryTextTruncated(diff) {
    return this._teHistoryTextExcerpt(diff.beforeText) !== diff.beforeText
      || this._teHistoryTextExcerpt(diff.afterText) !== diff.afterText;
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
        var itemDiff = selfDirect._teBuildTagDiff(path, beforeTags, afterTags,
          historyItem.meta?.type === 'text' || historyItem.meta?.contentMode === 'text');
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

  _teBuildTagDiff(path, beforeTags, afterTags, textEdit) {
    if (beforeTags === afterTags) return null;
    if (textEdit || !this.tagEditorAllowsTagOps()) {
      var image = this._teFindByPath(path);
      return { path: path, name: image ? this._teImageLabel(image) : path, kind: 'text',
        beforeText: beforeTags, afterText: afterTags, added: [], removed: [], unchanged: [] };
    }
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
    this.tagEditorDetailText = _teInputText(this.tagEditorGetSelectedImg()?.tags);
    this._updateEditorPanel();
  },

  _teApplyCheckpoint(checkpoint) {
    var self = this;
    var wasModified = this.tagEditorModified;
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
    if (wasModified && !hasAnyMod && !this._teIsSaving) this._teRemoveDraft();
    var state = {};
    var modified = this._teGetModified();
    for (var i = 0; i < modified.length; i++) state[modified[i].path] = modified[i].tags;
    this._teHistoryState = state;
    this._teInvalidateCaptionQuery();
    this._teInvalidateFilter();
    this.tagEditorDetailText = _teInputText(this.tagEditorGetSelectedImg()?.tags);
    this._updateEditorPanel();
  },

  _teUpdateFreq(oldTags, newTags) {
    if (!this.tagEditorAllowsTagOps()) return;
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
    this._teInvalidateCaptionQuery();
    if (wasMod !== isMod) {
      this._teBumpModified(isMod ? 1 : -1);
    }
    this.tagEditorModified = this._teModifiedCount > 0;
    // An explicit edit/undo back to the disk baseline retires this session's
    // draft. Do not do this in the idle autosave path: an unopened recovery
    // draft must survive loading a clean dataset or dismissing its prompt.
    if (wasMod && !this.tagEditorModified && !this._teIsSaving) this._teRemoveDraft();
    this._teInvalidateFilter();
    // Only update detail text if the image being edited is currently selected
    if (this.tagEditorSelected.length === 1 && this.tagEditorSelected[0] === img.path) {
      // Keep x-model equal to the textarea's LF value so Alpine does not reset
      // the DOM value (and native undo/caret) on every CRLF keystroke.
      this.tagEditorDetailText = _teInputText(newTagsStr);
    }
    this._teUpdateFreq(oldTags, newTagsStr);
    this.tagDictionarySyncChips();
  },

  tagEditorModifiedCount() {
    return this._teModifiedCount;
  },

  // ===== Save =====
  async tagEditorSaveAll() {
    if (this._teIsSaving || this._teDraftRestoreBusy || this.tagEditorSnapshotBusy) return;
    this._teFlushAllPendingTextEdits();
    var modified = this._teGetModified();
    if (modified.length === 0) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    var self2 = this;
    var epoch = this._teLoadEpoch;
    var saveDir = this.tagEditorLoadedDir || this.tagEditorDir;
    // C4: 小批量（≤5 张）跳过确认，减少打断；大批量仍确认
    if (modified.length > 5) {
      this._teConfirmBatch(this.t('tagEditor.batchConfirmAll').replace('{n}', modified.length), function() {
        if (epoch !== self2._teLoadEpoch || saveDir !== (self2.tagEditorLoadedDir || self2.tagEditorDir)) return;
        return self2._doSaveAll(modified);
      });
    } else {
      return this._doSaveAll(modified);
    }
  },

  async _doSaveAll(modified) {
    if (this._teIsSaving || this._teDraftRestoreBusy || this.tagEditorSnapshotBusy) return;
    this._teFlushAllPendingTextEdits();
    // Persist the pre-save baseline even when the first save precedes autosave.
    this._teSaveDraft();
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
    var timelineWarning = '';
    var rollbackFailed = [];
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
        timelineWarning = data.timeline_warning || '';
        rollbackFailed = data.rollback_failed || [];
        if (timelineWarning) {
          payload.forEach(function(item) {
            if ((data.saved_paths || []).includes(item.path)) self._teDraftRemainder.push({
              path: item.path, tags: item.tags, original: self.tagEditorOriginal[item.path],
              revision: data.revisions?.[item.path]
            });
          });
        }
        var successfulPaths = (data.saved_paths || []).concat(data.skipped_paths || []);
        var successfulLookup = {};
        successfulPaths.forEach(function(path) { successfulLookup[path] = true; });
        // Input can continue while the request is in flight. Record it against
        // the old baseline before advancing that baseline to the saved payload.
        this._teFlushAllPendingTextEdits();
        this.tagEditorHistory.forEach(function(entry) {
          Object.entries(entry.changes || {}).forEach(function([path, change]) {
            if (!successfulLookup[path]) return;
            if (change.before == null) change.before = self.tagEditorOriginal[path] || '';
            if (change.after == null) change.after = self.tagEditorOriginal[path] || '';
          });
        });
        var payloadByPath = {};
        payload.forEach(function(item) { payloadByPath[item.path] = item; });
        modified.forEach(function(img) {
          var savedPayload = payloadByPath[img.path];
          if (successfulLookup[img.path] && savedPayload) {
            self.tagEditorNoTagCount += Number(!savedPayload.tags.trim()) - Number(!(self.tagEditorOriginal[img.path] || '').trim());
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
      if (saveEpoch === this._teSaveEpoch && loadEpoch === this._teLoadEpoch) {
        this.tagEditorSaving = false;
        this._teIsSaving = false;
        this._teSaveProgress = 0;
      }
    }

    if (saveEpoch !== this._teSaveEpoch || loadEpoch !== this._teLoadEpoch) return;
    var hadHistory = this.tagEditorHistory.length > 0;
    this._teRecountModified();
    this._teInvalidateCaptionQuery();
    this.tagEditorModified = this._teModifiedCount > 0;
    this._teInvalidateFilter();
    if (!timelineWarning && !rollbackFailed.length && this._teModifiedCount === 0) {
      this.tagEditorHistory = [];
      this.tagEditorHistoryIdx = -1;
      this.tagEditorHistoryDetailIdx = -1;
    }
    this._teInvalidateDiff();
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
    if (timelineWarning || rollbackFailed.length) {
      var warning = timelineWarning ? this.t('tagEditor.timelineSaveFailed').replace('{error}', timelineWarning) : '';
      if (rollbackFailed.length) warning += (warning ? '\n' : '') + this.t('tagEditor.rollbackFailed').replace('{paths}', rollbackFailed.join(', '));
      this.toast(warning, 'warning');
      this._teSaveDraft(true);
    } else if (failedItems.length > 0 || this._teModifiedCount > 0) {
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

  _teCanRestoreCaptions() {
    this._teFlushAllPendingTextEdits();
    if (this.tagEditorModified || this._teIsSaving || this._teDraftRestoreBusy) {
      this.toast(this.t('tagEditor.timelineUnsaved'), 'warning');
      return false;
    }
    return true;
  },

  tagEditorRestoreSnapshot(sid) {
    if (!this._teCanRestoreCaptions()) return;
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
    var restoring = action === 'restore' || action === 'backup';
    var snapshot = this.tagEditorSnapshots.find(function(item) { return item.id === sid; });
    var description = this.t('tagEditor.' + message);
    if (snapshot) description = this._teFormatSnapshotTime(snapshot.timestamp) + ' · ' + this.t('tagEditor.historyStepImages').replace('{n}', snapshot.file_count) + '\n\n' + description;
    this.openConfirm(this.t('tagEditor.' + title), description, function() {
      if (epoch !== self._teLoadEpoch || self.tagEditorSnapshotBusy) return;
      if (restoring && !self._teCanRestoreCaptions()) return;
      self.tagEditorSnapshotBusy = true;
      var path = '/api/tageditor/timeline' + (sid ? '/' + encodeURIComponent(sid) : '') + (action === 'restore' ? '/restore' : '');
      var url = path + '?dataset_dir=' + encodeURIComponent(dir);
      var options = { method: action === 'restore' ? 'POST' : 'DELETE' };
      if (action === 'backup') {
        url = '/api/tageditor/restore-backup';
        options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dir }) };
      }
      return fetch(url, options)
        .then(function(r) { return r.json(); }).then(function(j) {
          if (epoch !== self._teLoadEpoch) return;
          if (j.status !== 'success') throw new Error(j.message || self.t('common.error'));
          self.toast(self.t('tagEditor.' + success));
          if (restoring) return self.tagEditorLoad(dir);
          else self.tagEditorLoadSnapshots(epoch);
        }).catch(function(err) {
          if (epoch === self._teLoadEpoch) self.toast(err.message || self.t('common.error'), 'error');
        }).finally(function() { if (epoch === self._teLoadEpoch) self.tagEditorSnapshotBusy = false; });
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

  _teSaveDraft(forcePending = false) {
    if (this._teIsSaving || this._teDraftRestoreBusy || (!this.tagEditorModified && !(forcePending && this._teDraftRemainder.length))) return;
    try {
      var key = 'tagEditor_draft_' + (this.tagEditorLoadedDir || this.tagEditorDir);
      var orig = this.tagEditorOriginal;
      var revisions = this._teCaptionRevisions || {};
      var data = this._teGetModified()
        .map(function(img) {
          return { path: img.path, tags: img.tags, original: orig[img.path], revision: revisions[img.path] };
        });
      localStorage.setItem(key, JSON.stringify({ version: 2, items: data, pending: this._teDraftRemainder }));
      this._teDraftSavedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      this.toast(this.t('tagEditor.draftSaveFailed'), 'warning');
    }
  },

  _teCheckDraft() {
    if (this._teDraftRestoreBusy || this._teIsSaving) return;
    try {
      var dir = this.tagEditorLoadedDir || this.tagEditorDir;
      var epoch = this._teLoadEpoch;
      var key = 'tagEditor_draft_' + dir;
      var raw = localStorage.getItem(key);
      if (raw) {
        var stored = JSON.parse(raw);
        var data = Array.isArray(stored) ? stored : stored.version === 2 ? (stored.items || []).concat(stored.pending || []) : [];
        data = data.filter(function(item) { return item && typeof item.path === 'string' && typeof item.tags === 'string'; });
        if (data && data.length > 0) {
          var self = this;
          this._teDraftRemainder = data;
          this._teConfirmUnsaved(this.t('tagEditor.draftFound'), async function() {
            var isCurrent = () => epoch === self._teLoadEpoch && dir === (self.tagEditorLoadedDir || self.tagEditorDir) && self.currentRoute === 'tagEditor';
            if (!isCurrent() || self._teIsSaving || self._teDraftRestoreBusy) return;
            self._teFlushAllPendingTextEdits();
            self._teDraftRestoreBusy = true;
            try {
              if (data.some(item => !self._teFindByPath(item.path))) await self._teEnsureAllImagesLoaded();
              if (!isCurrent()) return;
              var remaining = [], changes = {}, seen = new Set();
              data.forEach(function(item) {
                var identity = JSON.stringify([item.path, item.tags, item.original, item.revision]);
                if (seen.has(identity)) return;
                seen.add(identity);
                var img = self._teFindByPath(item.path);
                // Never replace an in-session edit or an externally changed baseline.
                if (!img || img.tags !== self.tagEditorOriginal[item.path]) {
                  if (!img || img.tags !== item.tags) remaining.push(item);
                  return;
                }
                var alreadySaved = img.tags === item.tags;
                var matches = item.revision != null ? item.revision === self._teCaptionRevisions?.[item.path]
                  : typeof item.original === 'string' && item.original === img.tags;
                if (!alreadySaved && !matches) { remaining.push(item); return; }
                var before = alreadySaved && typeof item.original === 'string' ? item.original : img.tags;
                if (before !== item.tags) changes[item.path] = { before: before, after: item.tags };
                if (!alreadySaved) self._teUpdateImageTags(img, item.tags);
              });
              self._teDraftRemainder = remaining;
              self._teRecountModified();
              self.tagEditorModified = self._teModifiedCount > 0;
              if (Object.keys(changes).length) {
                self.tagEditorHistory = self.tagEditorHistory.slice(0, self.tagEditorHistoryIdx + 1);
                self.tagEditorHistory.push({
                  meta: { type: 'restoreDraft', contentMode: 'text', desc: self.t('tagEditor.autoSaveRestored'), affected: Object.keys(changes).length },
                  changes: changes, _ts: Date.now()
                });
                if (self.tagEditorHistory.length > 200) self.tagEditorHistory.shift();
                self.tagEditorHistoryIdx = self.tagEditorHistory.length - 1;
              }
              var restoredState = {};
              var restoredModified = self._teGetModified();
              for (var i = 0; i < restoredModified.length; i++) restoredState[restoredModified[i].path] = restoredModified[i].tags;
              self._teHistoryState = restoredState;
              self._teInvalidateFilter();
              self._teInvalidateDiff();
              self._updateEditorPanel();
              self._teDraftRestoreBusy = false;
              if (self.tagEditorModified || remaining.length) self._teSaveDraft(true);
              else self._teRemoveDraft();
              self.toast(remaining.length ? self.t('tagEditor.draftUnresolved').replace('{n}', remaining.length) : self.t('tagEditor.autoSaveRestored'), remaining.length ? 'warning' : undefined);
            } catch (error) {
              if (isCurrent()) self.toast(self.t('tagEditor.draftRestoreFailed'), 'warning');
            } finally {
              if (isCurrent()) self._teDraftRestoreBusy = false;
            }
          });
        }
      }
    } catch (e) { /* ignore */ }
  },

  _teRemoveDraft() {
    try {
      var key = 'tagEditor_draft_' + (this.tagEditorLoadedDir || this.tagEditorDir);
      if (this._teDraftRemainder.length) localStorage.setItem(key, JSON.stringify({ version: 2, items: [], pending: this._teDraftRemainder }));
      else localStorage.removeItem(key);
      this._teDraftSavedAt = '';
    } catch (e) { /* ignore */ }
  },

  // ===== Navigation Guard =====
  _teConfirmUnsaved(msg, cb) {
    this.openConfirm(this.t('tagEditor.unsavedConfirmTitle'), msg, cb, this.t('common.confirm'));
  },

  _teConfirmBatch(msg, cb) {
    this.openConfirm(this.t('tagEditor.batchEditConfirmTitle'), msg, cb, this.t('common.confirm'));
  },

  _teConfirmTagBatch(msg, cb) {
    var epoch = this._teLoadEpoch, modeEpoch = this._teModeEpoch;
    this._teConfirmBatch(msg, () => {
      if (epoch === this._teLoadEpoch && modeEpoch === this._teModeEpoch && this.tagEditorAllowsTagOps()) return cb();
      this.toast(this.t('tagEditor.batchStale'), 'warning');
    });
  },

  _teHasUnsavedEdits() {
    if (this.currentRoute !== 'tagEditor') return false;
    this._teFlushAllPendingTextEdits();
    return !!this.tagEditorModified;
  },

  // ===== Keyboard Shortcuts =====
  tagEditorOpenShortcuts(event) {
    var trigger = event?.currentTarget?.closest('details')?.querySelector('summary') || event?.currentTarget;
    trigger?.focus();
    this.tagEditorShortcutsOpen = true;
  },

  tagEditorHandleKeydown(e) {
    if (e.defaultPrevented) return;
    var dialog = e.target?.closest?.('dialog[open]');
    // 大图保留自身翻页/缩放快捷键，其余原生弹窗自行处理键盘与焦点。
    if (dialog && dialog.id !== 'teLightbox') return;
    if (this.tagEditorSnapshotBusy || this._teDraftRestoreBusy) return;
    // Only active when tag editor is the current route
    if (this.currentRoute !== 'tagEditor') return;
    if (e.isComposing || e.keyCode === 229 || e.target?.composing) return;
    // 内联输入的组合标记也要隔离冒泡的 Escape，避免全局 blur 间接触发重命名。
    if (e.target?.id === 'te-inline-edit-input' && this.tagEditorInlineEdit?.composing) return;
    if (this.tagEditorShortcutsOpen) return;
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
    if (this.tagEditorPanelMenu || this.tagEditorContextMenu || this.tagEditorImageContextMenu) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.tagEditorClosePanelMenu();
        this.tagEditorCloseTagMenu();
        this.tagEditorCloseImageMenu();
      }
      return;
    }
    if (modifier && (e.key === 's' || e.key === 'S')) {
      if (editableTarget && !e.target.closest?.('.te-editor-textarea')) return;
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
    if (e.key === 'Escape') {
      if (this.tagEditorPanelMenu) { this.tagEditorClosePanelMenu(); return; }
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
        this.tagEditorClearSelection();
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
      // 保留按钮、链接和展开控件的原生激活；空白区域 Enter 仍用于开始编辑。
      var enterCard = e.target && typeof e.target.closest === 'function' ? e.target.closest('.te-card') : null;
      var enterControl = e.target?.closest?.('button, a[href], summary, [role="button"], [role="menuitem"]');
      if (!enterCard && !enterControl && this._teFocusEditorInput()) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Tab' && !modifier) {
      var card = e.target && typeof e.target.closest === 'function' ? e.target.closest('.te-card') : null;
      if (card && e.target === card && !e.shiftKey) {
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
