/* ================================================================
   tag-editor.js — Tag Editor v3: 3-Column Layout
   Alpine.js mixin: left tag cloud, center image grid, right editor panel
   ================================================================ */

window.tagEditorMixin = {

  // ===== Core State =====
  tagEditorDir: '',
  tagEditorImages: [],
  tagEditorOriginal: {},
  tagEditorModified: false,
  tagEditorTagFreq: [],
  tagEditorMaxFreq: 0,
  tagEditorLoading: false,
  tagEditorSaving: false,

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
  _teCloudShowAll: false,
  _teSearchLoading: false,

  // ===== Selection & Grid =====
  tagEditorSelected: [],
  tagEditorPage: 1,
  tagEditorPageSize: 60,
  tagEditorContextMenu: null,
  tagEditorLeftCollapsed: false,
  _teLastSelected: null,

  // ===== Right Panel Editor =====
  tagEditorDetailView: 'chip',
  tagEditorDetailText: '',
  tagEditorAddInput: '',
  tagEditorSuggestions: [],
  _teSuggestTimer: null,
  _teBlurTimer: null,
  tagEditorDetailDragOverIdx: -1,
  tagEditorDetailDragSrcIdx: -1,

  // ===== Batch Operations =====
  tagEditorBatchScope: 'filtered',
  batchAddInput: '',
  batchRemoveInput: '',
  batchOldTag: '',
  batchNewTag: '',
  batchPos: 'front',
  batchSuggestOpen: null,
  batchSuggestItems: [],
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

  // ===== Confirm Dialog =====
  tagEditorConfirmOpen: false,
  tagEditorConfirmMsg: '',
  tagEditorConfirmCb: null,

  // ===== Auto-save =====
  _teAutoSaveInterval: null,
  _tePendingTextEdits: {},
  _teDraftSavedAt: '',

  // ===== Cache =====
  _teFilteredCacheKey: '',
  _teFreqCacheKey: '',
  _teCachedFiltered: null,
  _teCachedFreqResult: null,
  _teSearchDebounce: null,
  _teTagSearchDebounce: null,
  _teIsSaving: false,
  _teSaveProgress: 0,

  // ===== Lifecycle =====
  tagEditorCleanup() {
    this._teStopAutoSave();
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    if (this._teBatchBlurTimer) { clearTimeout(this._teBatchBlurTimer); this._teBatchBlurTimer = null; }
    if (this._teSearchDebounce) { clearTimeout(this._teSearchDebounce); this._teSearchDebounce = null; }
    if (this._teTagSearchDebounce) { clearTimeout(this._teTagSearchDebounce); this._teTagSearchDebounce = null; }
    var keys = Object.keys(this._tePendingTextEdits);
    for (var i = 0; i < keys.length; i++) {
      clearTimeout(this._tePendingTextEdits[keys[i]]);
    }
    this._tePendingTextEdits = {};
  },

  // ===== Data Loading =====
  async tagEditorLoad(dir) {
    if (!dir && !this.tagEditorDir) {
      var cached = null;
      try { cached = sessionStorage.getItem('tagEditor_lastDir'); } catch (e) {}
      if (cached) { dir = cached; }
    }
    var d = dir || this.tagEditorDir || (this.form && this.form.train_data_dir) || '';
    if (!d) { this.toast(this.t('common.specifyDir') || 'Please specify a directory', 'warning'); return; }
    this.tagEditorDir = d;
    this.tagEditorLoading = true;
    this._teStopAutoSave();
    if (this._teSearchDebounce) { clearTimeout(this._teSearchDebounce); this._teSearchDebounce = null; }
    if (this._teTagSearchDebounce) { clearTimeout(this._teTagSearchDebounce); this._teTagSearchDebounce = null; }
    this.startProgress();
    try {
      var r = await fetch('/api/tageditor/images?dir=' + encodeURIComponent(d));
      var j = await r.json();
      if (j.status === 'success') {
        try { sessionStorage.setItem('tagEditor_lastDir', d); } catch (e) {}
        this.tagEditorImages = j.data.images || [];
        this.tagEditorOriginal = {};
        var self = this;
        this.tagEditorImages.forEach(function(img) { self.tagEditorOriginal[img.path] = img.tags; });
      this.tagEditorModified = false;
      this._teModifiedCountCache = undefined;
        this.tagEditorSelected = [];
        this.tagEditorPage = 1;
        this.tagEditorHistory = [];
        this.tagEditorHistoryIdx = -1;
        this.tagEditorTagSelection = [];
        this.tagEditorExcludedTags = [];
        this._teFilteredCacheKey = '';
        this._teFreqCacheKey = '';
        this._teCachedFiltered = null;
        this._teCachedFreqResult = null;
        this._teSearchLoading = false;
        this.tagEditorRegexError = false;
        this._teDraftSavedAt = '';
        await this.tagEditorLoadTagFreq();
        this._teCheckDraft();
        this._teStartAutoSave();
      } else {
        this.toast(j.message || this.t('common.error'), 'error');
      }
    } catch (e) {
      this.toast(this.t('common.networkError'), 'error');
    } finally {
      this.tagEditorLoading = false;
      this.finishProgress();
    }
  },

  async tagEditorLoadTagFreq() {
    if (!this.tagEditorDir) return;
    try {
      var r = await fetch('/api/tageditor/tags?dir=' + encodeURIComponent(this.tagEditorDir));
      var j = await r.json();
      if (j.status === 'success') {
        this.tagEditorTagFreq = j.data.tags || [];
        this.tagEditorMaxFreq = this.tagEditorTagFreq.length > 0 ? this.tagEditorTagFreq[0].count : 0;
        this._teFreqCacheKey = '';
        this._teCachedFreqResult = null;
      }
    } catch (e) { this.tagEditorTagFreq = []; this.tagEditorMaxFreq = 0; }
  },

  tagEditorReloadDir() {
    if (this.tagEditorModifiedCount() > 0) {
      var self = this;
      this.tagEditorConfirmMsg = this.t('tagEditor.revertConfirm');
      this.tagEditorConfirmCb = function() { self.tagEditorLoad(self.tagEditorDir); };
      this.tagEditorConfirmOpen = true;
    } else {
      this.tagEditorLoad(this.tagEditorDir);
    }
  },

  // ===== Filtering & Sorting =====
  tagEditorSetSearch(val) {
    if (this._teSearchDebounce) clearTimeout(this._teSearchDebounce);
    var self = this;
    this._teSearchLoading = true;
    this._teSearchDebounce = setTimeout(function() {
      self.tagEditorSearchQuery = val;
      self._teSearchDebounce = null;
      self._teSearchLoading = false;
      self.tagEditorPage = 1;
    }, 150);
  },
  tagEditorClearSearch() {
    if (this._teSearchDebounce) { clearTimeout(this._teSearchDebounce); this._teSearchDebounce = null; }
    this._teSearchLoading = false;
    this.tagEditorRegexError = false;
    this.tagEditorSearchQuery = '';
    this.tagEditorPage = 1;
  },
  tagEditorSetTagSearch(val) {
    if (this._teTagSearchDebounce) clearTimeout(this._teTagSearchDebounce);
    var self = this;
    this._teTagSearchDebounce = setTimeout(function() {
      self.tagEditorTagSearch = val;
      self._teTagSearchDebounce = null;
    }, 150);
  },
  tagEditorClearTagSearch() {
    if (this._teTagSearchDebounce) { clearTimeout(this._teTagSearchDebounce); this._teTagSearchDebounce = null; }
    this.tagEditorTagSearch = '';
  },
  tagEditorGetFiltered() {
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
        try {
          var re = new RegExp(this.tagEditorSearchQuery, 'i');
          this.tagEditorRegexError = false;
          images = images.filter(function(img) {
            return re.test(img.name) || re.test(img.tags || '');
          });
        } catch (e) { this.tagEditorRegexError = true; }
      } else {
        images = images.filter(function(img) {
          return img.name.toLowerCase().indexOf(q) !== -1 ||
            (img.tags || '').toLowerCase().indexOf(q) !== -1;
        });
      }
    }

    if (this.tagEditorTagSelection.length > 0) {
      var sel = this.tagEditorTagSelection;
      if (this.tagEditorTagLogic === 'AND') {
        images = images.filter(function(img) {
          var parts = (img.tags || '').split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
          return sel.every(function(s) { return parts.indexOf(s.toLowerCase()) !== -1; });
        });
      } else {
        images = images.filter(function(img) {
          var parts = (img.tags || '').split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
          return sel.some(function(s) { return parts.indexOf(s.toLowerCase()) !== -1; });
        });
      }
    }

    if (this.tagEditorExcludedTags.length > 0) {
      var exc = this.tagEditorExcludedTags;
      images = images.filter(function(img) {
        var parts = (img.tags || '').split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(function(t) { return t; });
        return !exc.some(function(s) { return parts.indexOf(s.toLowerCase()) !== -1; });
      });
    }

    var sortBy = this.tagEditorSortBy;
    var asc = this.tagEditorSortAsc;
    var self = this;
    images.sort(function(a, b) {
      var cmp = 0;
      // Primary sort
      if (sortBy === 'tagCount') {
        var ca = a.tags ? a.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
        var cb = b.tags ? b.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
        cmp = asc ? ca - cb : cb - ca;
      } else if (sortBy === 'modified') {
        var ma = a.tags !== self.tagEditorOriginal[a.path] ? 1 : 0;
        var mb = b.tags !== self.tagEditorOriginal[b.path] ? 1 : 0;
        cmp = asc ? ma - mb : mb - ma;
      } else {
        cmp = asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      }
      // Secondary sort (only when primary is tied)
      if (cmp === 0 && self.tagEditorSortBy2) {
        var sortBy2 = self.tagEditorSortBy2;
        var asc2 = self.tagEditorSortAsc2;
        if (sortBy2 === 'tagCount') {
          var ca2 = a.tags ? a.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
          var cb2 = b.tags ? b.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
          cmp = asc2 ? ca2 - cb2 : cb2 - ca2;
        } else if (sortBy2 === 'modified') {
          var ma2 = a.tags !== self.tagEditorOriginal[a.path] ? 1 : 0;
          var mb2 = b.tags !== self.tagEditorOriginal[b.path] ? 1 : 0;
          cmp = asc2 ? ma2 - mb2 : mb2 - ma2;
        } else {
          cmp = asc2 ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
        }
      }
      return cmp;
    });

    this._teFilteredCacheKey = cacheKey;
    this._teCachedFiltered = images;
    return images;
  },

  tagEditorGetPaged() {
    var filtered = this.tagEditorGetFiltered();
    var start = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    return filtered.slice(start, start + this.tagEditorPageSize);
  },

  tagEditorTotalPages() {
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
    var images = this._teCachedFiltered || this.tagEditorImages;
    if (type === 'notag') {
      return images.filter(function(img) { return !img.tags || img.tags.trim() === ''; }).length;
    }
    if (type === 'modified') {
      var orig = this.tagEditorOriginal;
      return images.filter(function(img) { return img.tags !== orig[img.path]; }).length;
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
      freq = freq.filter(function(item) { return item.tag.toLowerCase().indexOf(q) !== -1; });
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
    var idx = this.tagEditorTagSelection.indexOf(tag);
    if (idx === -1) {
      this.tagEditorTagSelection.push(tag);
      // Remove from excluded if present (mutual exclusion)
      var excIdx = this.tagEditorExcludedTags.indexOf(tag);
      if (excIdx !== -1) this.tagEditorExcludedTags.splice(excIdx, 1);
    } else {
      this.tagEditorTagSelection.splice(idx, 1);
    }
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    this.tagEditorPage = 1;
  },

  tagEditorExcludeTag(tag) {
    var idx = this.tagEditorExcludedTags.indexOf(tag);
    if (idx === -1) {
      this.tagEditorExcludedTags.push(tag);
      // Remove from included if present (mutual exclusion)
      var selIdx = this.tagEditorTagSelection.indexOf(tag);
      if (selIdx !== -1) this.tagEditorTagSelection.splice(selIdx, 1);
    } else {
      this.tagEditorExcludedTags.splice(idx, 1);
    }
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    this.tagEditorPage = 1;
  },

  tagEditorTagCtx(e, tag) {
    this.tagEditorContextMenu = { x: e.clientX, y: e.clientY, tag: tag };
  },

  tagEditorCtxInclude() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this.tagEditorTagSelection.indexOf(tag) === -1) {
      this.tagEditorTagSelection.push(tag);
      var excIdx = this.tagEditorExcludedTags.indexOf(tag);
      if (excIdx !== -1) this.tagEditorExcludedTags.splice(excIdx, 1);
      this._teFilteredCacheKey = '';
      this._teCachedFiltered = null;
      this.tagEditorPage = 1;
    }
    this.tagEditorContextMenu = null;
  },

  tagEditorCtxExclude() {
    var tag = this.tagEditorContextMenu && this.tagEditorContextMenu.tag;
    if (tag && this.tagEditorExcludedTags.indexOf(tag) === -1) {
      this.tagEditorExcludedTags.push(tag);
      var selIdx = this.tagEditorTagSelection.indexOf(tag);
      if (selIdx !== -1) this.tagEditorTagSelection.splice(selIdx, 1);
      this._teFilteredCacheKey = '';
      this._teCachedFiltered = null;
      this.tagEditorPage = 1;
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
    if (tag) {
      var self = this;
      this.tagEditorImages.forEach(function(img) {
        var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
        if (tags.indexOf(tag) === -1) {
          tags.push(tag);
          self._teUpdateImageTags(img, tags.join(', '));
        }
      });
      this._tePushHistory();
    }
    this.tagEditorContextMenu = null;
  },

  // ===== Card Interactions =====
  tagEditorGridBgClick(e) {
    if (!e.target.closest('.te-card') && !e.target.closest('.te-editor')) {
      this.tagEditorSelected = [];
    }
  },

  tagEditorCardClick(img, idx, e) {
    var filtered = this.tagEditorGetFiltered();
    var pageStart = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    var globalIdx = pageStart + idx;

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

  tagEditorCardDblClick(img, idx, e) {
    var input = document.querySelector('.te-editor-add input');
    if (input) input.focus();
  },

  tagEditorCardCtx(img, e) {
    this.tagEditorContextMenu = { x: e.clientX, y: e.clientY, img: img };
  },

  tagEditorToggleSelect(path, e) {
    var idx = this.tagEditorSelected.indexOf(path);
    if (idx === -1) {
      this.tagEditorSelected.push(path);
    } else {
      this.tagEditorSelected.splice(idx, 1);
    }
    this._updateEditorPanel();
  },

  tagEditorSelectAll() {
    var filtered = this.tagEditorGetFiltered();
    var pageStart = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    var pageEnd = Math.min(filtered.length, pageStart + this.tagEditorPageSize);
    this.tagEditorSelected = [];
    for (var i = pageStart; i < pageEnd; i++) {
      this.tagEditorSelected.push(filtered[i].path);
    }
    this._updateEditorPanel();
  },

  tagEditorSelectInvert() {
    var selected = this.tagEditorSelected.slice();
    this.tagEditorSelectAll();
    var allCurrent = this.tagEditorSelected.slice();
    this.tagEditorSelected = allCurrent.filter(function(p) { return selected.indexOf(p) === -1; });
    this._updateEditorPanel();
  },

  _updateEditorPanel() {
    if (this.tagEditorSelected.length === 1) {
      var img = this.tagEditorGetSelectedImg();
      if (img) {
        this.tagEditorDetailText = img.tags || '';
      }
    }
  },

  tagEditorGetSelectedImg() {
    if (this.tagEditorSelected.length < 1) return null;
    var path = this.tagEditorSelected[0];
    for (var i = 0; i < this.tagEditorImages.length; i++) {
      if (this.tagEditorImages[i].path === path) return this.tagEditorImages[i];
    }
    return null;
  },

  tagEditorGetSelectedTags() {
    var img = this.tagEditorGetSelectedImg();
    if (!img || !img.tags) return [];
    return img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
  },

  // ===== Drag Selection =====
  // ===== Single Image Editor =====
  tagEditorAddTagToSelected() {
    var val = this.tagEditorAddInput.trim();
    if (!val || this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var newTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    var existing = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var added = [];
    var self = this;
    newTags.forEach(function(t) {
      if (existing.indexOf(t) === -1) { existing.push(t); added.push(t); }
    });
    if (added.length > 0) {
      self._teUpdateImageTags(img, existing.join(', '));
      this._tePushHistory();
    }
    this.tagEditorAddInput = '';
    this.tagEditorSuggestions = [];
  },

  tagEditorRemoveTagFromSelected(tag) {
    if (this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var idx = tags.indexOf(tag);
    if (idx !== -1) {
      tags.splice(idx, 1);
      this._teUpdateImageTags(img, tags.join(', '));
      this._tePushHistory();
    }
  },

  tagEditorSortSelectedTags() {
    if (this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    if (tags.length <= 1) return;
    tags.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    this._teUpdateImageTags(img, tags.join(', '));
    this._tePushHistory();
  },

  tagEditorDetailDragStart(e, idx) {
    this.tagEditorDetailDragSrcIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    var el = e.target.closest('.te-v3-right-tag');
    if (el) { setTimeout(function() { el.style.opacity = '0.4'; }, 0); }
  },

  tagEditorDetailDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  },

  tagEditorDetailDrop(e) {
    e.preventDefault();
    var srcIdx = this.tagEditorDetailDragSrcIdx;
    if (srcIdx < 0) { this.tagEditorDetailDragSrcIdx = -1; return; }
    var img = this.tagEditorGetSelectedImg();
    if (!img) { this.tagEditorDetailDragSrcIdx = -1; return; }
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    if (srcIdx >= tags.length) { this.tagEditorDetailDragSrcIdx = -1; return; }
    var moving = tags.splice(srcIdx, 1)[0];
    var destIdx = tags.length;
    var dropTarget = e.target.closest('.te-v3-right-tag');
    if (dropTarget) {
      var spanEl = dropTarget.querySelector('span');
      var tagText = spanEl ? spanEl.textContent.trim() : '';
      var foundIdx = tags.indexOf(tagText);
      if (foundIdx !== -1) destIdx = foundIdx;
    }
    tags.splice(destIdx, 0, moving);
    this._teUpdateImageTags(img, tags.join(', '));
    this._tePushHistory();
    this.tagEditorDetailDragSrcIdx = -1;
    this.tagEditorDetailDragOverIdx = -1;
  },

  tagEditorDetailEditTag(ti) {
    this.tagEditorDetailView = 'text';
  },

  tagEditorDetailTextChange() {
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var self = this;
    var path = img.path;
    var capturedText = this.tagEditorDetailText;
    var capturedImg = img;
    if (this._tePendingTextEdits[path]) clearTimeout(this._tePendingTextEdits[path]);
    this._tePendingTextEdits[path] = setTimeout(function() {
      self._teUpdateImageTags(capturedImg, capturedText);
      self._tePushHistory();
      delete self._tePendingTextEdits[path];
    }, 500);
  },

  tagEditorCopySelectedTags() {
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
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
    var existing = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var added = [];
    var self = this;
    this.tagEditorCopiedTags.forEach(function(t) {
      if (existing.indexOf(t) === -1) { existing.push(t); added.push(t); }
    });
    if (added.length > 0) {
      self._teUpdateImageTags(img, existing.join(', '));
      this._tePushHistory();
      this.toast(this.t('tagEditor.tagsPasted').replace('{n}', added.length));
    }
  },

  tagEditorNavDetail(dir) {
    if (this.tagEditorSelected.length !== 1) return;
    var filtered = this.tagEditorGetFiltered();
    var currentPath = this.tagEditorSelected[0];
    var currentIdx = -1;
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].path === currentPath) { currentIdx = i; break; }
    }
    var newIdx = currentIdx + dir;
    if (newIdx >= 0 && newIdx < filtered.length) {
      this.tagEditorSelected = [filtered[newIdx].path];
      this._updateEditorPanel();
      this.tagEditorPage = Math.floor(newIdx / this.tagEditorPageSize) + 1;
    }
  },

  tagEditorCanNavDetail(dir) {
    if (this.tagEditorSelected.length !== 1) return false;
    var filtered = this.tagEditorGetFiltered();
    var currentPath = this.tagEditorSelected[0];
    var currentIdx = -1;
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].path === currentPath) { currentIdx = i; break; }
    }
    var newIdx = currentIdx + dir;
    return newIdx >= 0 && newIdx < filtered.length;
  },

  // ===== Autocomplete =====
  tagEditorGetSuggestions(val) {
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    var v = (val || this.tagEditorAddInput || '').trim();
    if (!v) { this.tagEditorSuggestions = []; return; }
    var self = this;
    this._teSuggestTimer = setTimeout(function() {
      var parts = v.split(',');
      var last = parts[parts.length - 1].trim().toLowerCase();
      if (!last) { self.tagEditorSuggestions = []; return; }
      self.tagEditorSuggestions = self.tagEditorTagFreq
        .filter(function(item) { return item.tag.toLowerCase().indexOf(last) !== -1; })
        .slice(0, 8)
        .map(function(item) { return item.tag; });
    }, 50);
  },

  tagEditorBlurSuggest() {
    if (this._teSuggestTimer) { clearTimeout(this._teSuggestTimer); this._teSuggestTimer = null; }
    var self = this;
    this._teBlurTimer = setTimeout(function() {
      self.tagEditorSuggestions = [];
    }, 200);
  },

  tagEditorSelectSuggestion(s) {
    var parts = (this.tagEditorAddInput || '').split(',');
    parts.pop();
    parts.push(' ' + s);
    this.tagEditorAddInput = parts.join(',') + ', ';
    this.tagEditorSuggestions = [];
    this.tagEditorGetSuggestions(this.tagEditorAddInput);
  },

  // ===== Batch Operations =====
  tagEditorBatchSuggest(field) {
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    if (this._teBatchBlurTimer) { clearTimeout(this._teBatchBlurTimer); this._teBatchBlurTimer = null; }
    var val = '';
    if (field === 'add') val = this.batchAddInput;
    else if (field === 'remove') val = this.batchRemoveInput;
    else if (field === 'old') val = this.batchOldTag;
    if (!val || !val.trim()) { this.batchSuggestOpen = null; this.batchSuggestItems = []; return; }
    var self = this;
    var v = val.trim().toLowerCase();
    this._teBatchSuggestTimer = setTimeout(function() {
      self.batchSuggestItems = self.tagEditorTagFreq
        .filter(function(item) { return item.tag.toLowerCase().indexOf(v) !== -1; })
        .slice(0, 6)
        .map(function(item) { return item.tag; });
      self.batchSuggestOpen = field;
    }, 50);
  },

  tagEditorBatchBlur() {
    if (this._teBatchSuggestTimer) { clearTimeout(this._teBatchSuggestTimer); this._teBatchSuggestTimer = null; }
    var self = this;
    this._teBatchBlurTimer = setTimeout(function() {
      self.batchSuggestOpen = null;
    }, 200);
  },

  tagEditorBatchSelectSuggestion(s) {
    var field = this.batchSuggestOpen;
    if (field === 'add') this.batchAddInput = s;
    else if (field === 'remove') this.batchRemoveInput = s;
    else if (field === 'old') this.batchOldTag = s;
    this.batchSuggestOpen = null;
    this.batchSuggestItems = [];
  },

  tagEditorGetBatchTargets() {
    if (this.tagEditorBatchScope === 'all') return this.tagEditorImages;
    if (this.tagEditorBatchScope === 'selected') {
      var sel = this.tagEditorSelected;
      return this.tagEditorImages.filter(function(img) { return sel.indexOf(img.path) !== -1; });
    }
    return this.tagEditorGetFiltered();
  },

  _teConfirmBatchScope(action, cb) {
    var targets = this.tagEditorGetBatchTargets();
    var count = targets.length;
    if (count === 0) { this.toast(this.t('tagEditor.batchNoChanges'), 'warning'); return; }
    var actionLabel = this.t('bulkAction.' + action) || action;
    this.tagEditorConfirmMsg = this.t('tagEditor.confirmBatchDesc')
      .replace('{count}', count).replace('{operation}', actionLabel);
    this.tagEditorConfirmCb = cb;
    this.tagEditorConfirmOpen = true;
  },

  tagEditorBatchAdd() {
    var val = this.batchAddInput.trim();
    if (!val) return;
    var newTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    if (newTags.length === 0) return;
    var self = this;
    this._teConfirmBatchScope('add', function() {
      var targets = self.tagEditorGetBatchTargets();
      targets.forEach(function(img) {
        var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
        var changed = false;
        newTags.forEach(function(t) {
          if (tags.indexOf(t) === -1) {
            if (self.batchPos === 'front') tags.unshift(t);
            else tags.push(t);
            changed = true;
          }
        });
        if (changed) self._teUpdateImageTags(img, tags.join(', '));
      });
      self._tePushHistory();
      self.batchAddInput = '';
      self.toast(self.t('tagEditor.batchDone'));
    });
  },

  tagEditorBatchRemove() {
    var val = this.batchRemoveInput.trim();
    if (!val) return;
    var rmTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    if (rmTags.length === 0) return;
    var self = this;
    this._teConfirmBatchScope('removeTag', function() {
      var targets = self.tagEditorGetBatchTargets();
      targets.forEach(function(img) {
        var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
        var before = tags.length;
        tags = tags.filter(function(t) { return rmTags.indexOf(t) === -1; });
        if (tags.length !== before) self._teUpdateImageTags(img, tags.join(', '));
      });
      self._tePushHistory();
      self.batchRemoveInput = '';
      self.toast(self.t('tagEditor.batchDone'));
    });
  },

  tagEditorBatchReplace() {
    var oldTag = this.batchOldTag.trim();
    var newTag = this.batchNewTag.trim();
    if (!oldTag || !newTag) return;
    var self = this;
    this._teConfirmBatchScope('replace', function() {
      var targets = self.tagEditorGetBatchTargets();
      targets.forEach(function(img) {
        var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
        var idx = tags.indexOf(oldTag);
        if (idx !== -1) {
          tags[idx] = newTag;
          self._teUpdateImageTags(img, self._teDedupTags(tags).join(', '));
        }
      });
      self._tePushHistory();
      self.batchOldTag = ''; self.batchNewTag = '';
      self.toast(self.t('tagEditor.batchDone'));
    });
  },

  tagEditorBatchDedup() {
    var self = this;
    this._teConfirmBatchScope('dedupe', function() {
      var targets = self.tagEditorGetBatchTargets();
      targets.forEach(function(img) {
        var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
        var deduped = self._teDedupTags(tags);
        if (deduped.length !== tags.length) self._teUpdateImageTags(img, deduped.join(', '));
      });
      self._tePushHistory();
      self.toast(self.t('tagEditor.batchDone'));
    });
  },

  tagEditorBatchSort() {
    var self = this;
    this._teConfirmBatchScope('sort', function() {
      var targets = self.tagEditorGetBatchTargets();
      targets.forEach(function(img) {
        var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
        if (tags.length <= 1) return;
        var sorted = tags.slice().sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
        if (sorted.join(',') !== tags.join(',')) self._teUpdateImageTags(img, sorted.join(', '));
      });
      self._tePushHistory();
      self.toast(self.t('tagEditor.batchDone'));
    });
  },

  tagEditorBatchRemoveTag(tag) {
    this.batchRemoveInput = tag;
    this.tagEditorBatchRemove();
  },

  tagEditorGetSelectedStats() {
    if (this.tagEditorSelected.length < 2) return [];
    var counter = {};
    var sel = this.tagEditorSelected;
    this.tagEditorImages.forEach(function(img) {
      if (sel.indexOf(img.path) === -1) return;
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      tags.forEach(function(t) {
        counter[t] = (counter[t] || 0) + 1;
      });
    });
    return Object.keys(counter).map(function(k) { return { tag: k, count: counter[k] }; })
      .sort(function(a, b) { return b.count - a.count; });
  },

  _teDedupTags(tags) {
    var seen = {};
    return tags.filter(function(t) {
      var lower = t.trim().toLowerCase();
      if (seen[lower]) return false;
      seen[lower] = true;
      return true;
    });
  },

  // ===== Undo/Redo =====
  _tePushHistory() {
    if (this.tagEditorHistoryIdx < this.tagEditorHistory.length - 1) {
      this.tagEditorHistory = this.tagEditorHistory.slice(0, this.tagEditorHistoryIdx + 1);
    }
    var checkpoint = {};
    var orig = this.tagEditorOriginal;
    var count = 0;
    this.tagEditorImages.forEach(function(img) {
      if (img.tags !== orig[img.path]) {
        checkpoint[img.path] = img.tags;
        count++;
      }
    });
    if (count === 0) {
      checkpoint = {};
    }
    this.tagEditorHistory.push(checkpoint);
    if (this.tagEditorHistory.length > 200) this.tagEditorHistory.shift();
    this.tagEditorHistoryIdx = this.tagEditorHistory.length - 1;
  },

  tagEditorUndo() {
    if (this.tagEditorHistoryIdx < 0) return;
    this.tagEditorHistoryIdx--;
    var checkpoint = this.tagEditorHistoryIdx >= 0 ? this.tagEditorHistory[this.tagEditorHistoryIdx] : {};
    this._teApplyCheckpoint(checkpoint);
  },

  tagEditorRedo() {
    if (this.tagEditorHistoryIdx >= this.tagEditorHistory.length - 1) return;
    this.tagEditorHistoryIdx++;
    var checkpoint = this.tagEditorHistory[this.tagEditorHistoryIdx];
    this._teApplyCheckpoint(checkpoint);
  },

  tagEditorJumpToHistory(idx) {
    if (idx < 0 || idx >= this.tagEditorHistory.length || idx === this.tagEditorHistoryIdx) {
      this.tagEditorHistoryDetailIdx = -1;
      return;
    }
    this._teApplyCheckpoint(this.tagEditorHistory[idx]);
    this.tagEditorHistoryIdx = idx;
    this.tagEditorHistoryDetailIdx = -1;
  },

  tagEditorSelectHistoryDetail(idx) {
    this.tagEditorHistoryDetailIdx = (this.tagEditorHistoryDetailIdx === idx) ? -1 : idx;
  },

  _teGetHistoryDiff(stepIdx) {
    if (stepIdx < 0 || stepIdx >= this.tagEditorHistory.length) return [];
    var after = this.tagEditorHistory[stepIdx];
    var before = stepIdx > 0 ? this.tagEditorHistory[stepIdx - 1] : {};
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
      var beforeList = beforeTags ? beforeTags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var afterList = afterTags ? afterTags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var added = afterList.filter(function(t) { return beforeList.indexOf(t) === -1; });
      var removed = beforeList.filter(function(t) { return afterList.indexOf(t) === -1; });
      var unchanged = afterList.filter(function(t) { return beforeList.indexOf(t) !== -1; });
      var reordered = (added.length === 0 && removed.length === 0 && beforeTags !== afterTags);
      if (added.length > 0 || removed.length > 0 || reordered) {
        var img = self.tagEditorImages.find(function(i) { return i.path === path; });
        diff.push({
          path: path,
          name: img ? img.name : path,
          added: added,
          removed: removed,
          unchanged: unchanged,
          reordered: reordered
        });
      }
    });
    diff.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return diff;
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
    this._teModifiedCountCache = undefined;
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    this.tagEditorDetailText = this.tagEditorGetSelectedImg()?.tags || '';
    this._updateEditorPanel();
  },

  _teUpdateFreq(oldTags, newTags) {
    this._teModifiedCountCache = undefined;
    var oldList = oldTags ? oldTags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var newList = newTags ? newTags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var removed = oldList.filter(function(t) { return newList.indexOf(t) === -1; });
    var added = newList.filter(function(t) { return oldList.indexOf(t) === -1; });
    if (removed.length === 0 && added.length === 0) return;
    var self = this;
    removed.forEach(function(t) {
      var item = self.tagEditorTagFreq.find(function(f) { return f.tag === t; });
      if (item && item.count > 0) item.count--;
    });
    added.forEach(function(t) {
      var item = self.tagEditorTagFreq.find(function(f) { return f.tag === t; });
      if (item) { item.count++; } else { self.tagEditorTagFreq.push({ tag: t, count: 1 }); }
    });
    this.tagEditorTagFreq = this.tagEditorTagFreq.filter(function(f) { return f.count > 0; });
    this.tagEditorMaxFreq = this.tagEditorTagFreq.reduce(function(max, f) { return Math.max(max, f.count); }, 0);
    this._teFreqCacheKey = '';
    this._teCachedFreqResult = null;
  },

  // ===== Core Edit Helper =====
  _teUpdateImageTags(img, newTagsStr) {
    var oldTags = img.tags || '';
    img.tags = newTagsStr;
    this.tagEditorModified = this.tagEditorImages.some(function(i) {
      return i.tags !== this.tagEditorOriginal[i.path];
    }.bind(this));
    this._teModifiedCountCache = undefined;
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    // Cancel any pending text-edit debounce for this image (batch op takes precedence)
    if (this._tePendingTextEdits[img.path]) {
      clearTimeout(this._tePendingTextEdits[img.path]);
      delete this._tePendingTextEdits[img.path];
    }
    // Only update detail text if the image being edited is currently selected
    if (this.tagEditorSelected.length === 1 && this.tagEditorSelected[0] === img.path) {
      this.tagEditorDetailText = newTagsStr;
    }

    var oldList = oldTags ? oldTags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var newList = newTagsStr ? newTagsStr.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    var removed = oldList.filter(function(t) { return newList.indexOf(t) === -1; });
    var added = newList.filter(function(t) { return oldList.indexOf(t) === -1; });
    if (removed.length > 0 || added.length > 0) {
      var self = this;
      removed.forEach(function(t) {
        var item = self.tagEditorTagFreq.find(function(f) { return f.tag === t; });
        if (item && item.count > 0) item.count--;
      });
      added.forEach(function(t) {
        var item = self.tagEditorTagFreq.find(function(f) { return f.tag === t; });
        if (item) { item.count++; } else { self.tagEditorTagFreq.push({ tag: t, count: 1 }); }
      });
      this._teFreqCacheKey = '';
      this._teCachedFreqResult = null;
      this.tagEditorTagFreq = this.tagEditorTagFreq.filter(function(f) { return f.count > 0; });
      this.tagEditorMaxFreq = this.tagEditorTagFreq.reduce(function(max, f) { return Math.max(max, f.count); }, 0);
    }
  },

  tagEditorModifiedCount() {
    if (this._teModifiedCountCache !== undefined) return this._teModifiedCountCache;
    var orig = this.tagEditorOriginal;
    this._teModifiedCountCache = this.tagEditorImages.filter(function(img) { return img.tags !== orig[img.path]; }).length;
    return this._teModifiedCountCache;
  },

  // ===== Save =====
  async tagEditorSaveAll() {
    var self = this;
    var modified = this.tagEditorImages.filter(function(img) {
      return img.tags !== self.tagEditorOriginal[img.path];
    });
    if (modified.length === 0) { this.toast(this.t('tagEditor.batchNoChanges')); return; }
    this.tagEditorConfirmMsg = this.t('tagEditor.batchConfirmAll').replace('{n}', modified.length);
    var self2 = this;
    this.tagEditorConfirmCb = function() { self2._doSaveAll(modified); };
    this.tagEditorConfirmOpen = true;
  },

  async _doSaveAll(modified) {
    this.tagEditorSaving = true;
    this._teIsSaving = true;
    this._teSaveProgress = 0;
    var CHUNK_SIZE = 50;
    var self = this;

    try {
      for (var i = 0; i < modified.length; i += CHUNK_SIZE) {
        var chunk = modified.slice(i, i + CHUNK_SIZE);
        var payload = chunk.map(function(img) {
          return { path: img.path, tags: img.tags };
        });
        var r = await fetch('/api/tageditor/save-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images: payload })
        });
        var j = await r.json();
        if (j.status !== 'success') {
          self.toast(j.message || self.t('common.error'), 'error');
          self.tagEditorSaving = false;
          self._teIsSaving = false;
          self._teSaveProgress = 0;
          return;
        }
        var orig = self.tagEditorOriginal;
        chunk.forEach(function(img) { orig[img.path] = img.tags; });
        self._teSaveProgress = Math.round((i + chunk.length) / modified.length * 100);
      }
      this.tagEditorModified = false;
      this._teModifiedCountCache = undefined;
      this.tagEditorHistory = [];
      this.tagEditorHistoryIdx = -1;
      this.tagEditorSaving = false;
      this._teIsSaving = false;
      this._teSaveProgress = 0;
      this.toast(this.t('common.saved'));
      this._teDraftSavedAt = '';
      this._teRemoveDraft();
    } catch (e) {
      this.tagEditorSaving = false;
      this._teIsSaving = false;
      this._teSaveProgress = 0;
      this.toast(this.t('common.networkError'), 'error');
    }
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
      var data = this.tagEditorImages
        .filter(function(img) { return img.tags !== orig[img.path]; })
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
          this.tagEditorConfirmMsg = this.t('tagEditor.draftFound');
          this.tagEditorConfirmCb = function() {
            data.forEach(function(item) {
              var img = self.tagEditorImages.find(function(i) { return i.path === item.path; });
              if (img) {
                img.tags = item.tags;
                self.tagEditorOriginal[img.path] = item.original || item.tags;
              }
            });
            self.tagEditorModified = true;
            self._teModifiedCountCache = undefined;
            self._teFilteredCacheKey = '';
            self._teCachedFiltered = null;
            self.toast(self.t('tagEditor.autoSaveRestored'));
          };
          this.tagEditorConfirmOpen = true;
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
  _teConfirmNav(route) {
    if (this.currentRoute !== 'tagEditor') return true;
    if (!this.tagEditorModified) return true;
    return window.confirm(this.t('tagEditor.unsavedConfirm'));
  },

  // ===== Keyboard Shortcuts =====
  tagEditorHandleKeydown(e) {
    // Only active when tag editor is the current route
    if (this.currentRoute !== 'tagEditor') return;
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      this.tagEditorSaveAll();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      this.tagEditorUndo();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      this.tagEditorRedo();
      return;
    }
    if (e.ctrlKey && e.key === 'a') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      this.tagEditorSelectAll();
      return;
    }
    if (e.ctrlKey && e.key === 'c') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (this.tagEditorSelected.length === 1) {
        e.preventDefault();
        this.tagEditorCopySelectedTags();
      }
      return;
    }
    if (e.ctrlKey && e.key === 'v') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (this.tagEditorSelected.length === 1 && this.tagEditorCopiedTags.length > 0) {
        e.preventDefault();
        this.tagEditorPasteTagsToSelected();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (this.tagEditorContextMenu) {
        this.tagEditorContextMenu = null;
        return;
      }
      if (this.tagEditorConfirmOpen) {
        this.tagEditorConfirmOpen = false;
        this.tagEditorConfirmCb = null;
        return;
      }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        e.target.blur();
        return;
      }
      if (this.tagEditorSelected.length > 0) {
        this.tagEditorSelected = [];
      }
      return;
    }
    if (e.key === 'ArrowLeft' && this.tagEditorSelected.length === 1) {
      e.preventDefault();
      this.tagEditorNavDetail(-1);
      return;
    }
    if (e.key === 'ArrowRight' && this.tagEditorSelected.length === 1) {
      e.preventDefault();
      this.tagEditorNavDetail(1);
      return;
    }
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      var searchInput = document.querySelector('.te-v3-top-search input');
      if (searchInput) searchInput.focus();
      return;
    }
  }
};
