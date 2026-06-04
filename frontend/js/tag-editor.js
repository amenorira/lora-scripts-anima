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
  tagEditorTagSearch: '',
  tagEditorTagLogic: 'AND',
  tagEditorTagSelection: [],
  tagEditorExcludedTags: [],
  tagEditorTagSortBy: 'freq',
  tagEditorTagSortAsc: false,
  tagEditorTagCloudLimit: 200,
  tagEditorTagCloudExpanded: false,

  // ===== Selection & Grid =====
  tagEditorSelected: [],
  tagEditorPage: 1,
  tagEditorPageSize: 60,
  tagEditorDragSelect: false,
  tagEditorDragStart: null,
  tagEditorDragRect: null,
  tagEditorContextMenu: null,
  tagEditorLeftCollapsed: false,
  tagEditorRightCollapsed: false,
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

  // ===== Confirm Dialog =====
  tagEditorConfirmOpen: false,
  tagEditorConfirmMsg: '',
  tagEditorConfirmCb: null,

  // ===== Auto-save =====
  _teAutoSaveInterval: null,
  _tePendingTextEdits: {},

  // ===== Cache =====
  _teFilteredCacheKey: '',
  _teFreqCacheKey: '',
  _teCachedFiltered: null,
  _teCachedFreqResult: null,
  _teSearchDebounce: null,
  _teTagSearchDebounce: null,
  _teIsSaving: false,

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
        this.tagEditorTagFreq = j.data.freq || [];
        this.tagEditorMaxFreq = this.tagEditorTagFreq.length > 0 ? this.tagEditorTagFreq[0].count : 0;
        this._teFreqCacheKey = '';
        this._teCachedFreqResult = null;
      }
    } catch (e) { /* silent */ }
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
    this._teSearchDebounce = setTimeout(function() {
      self.tagEditorSearchQuery = val;
      self._teSearchDebounce = null;
    }, 150);
  },
  tagEditorSetTagSearch(val) {
    if (this._teTagSearchDebounce) clearTimeout(this._teTagSearchDebounce);
    var self = this;
    this._teTagSearchDebounce = setTimeout(function() {
      self.tagEditorTagSearch = val;
      self._teTagSearchDebounce = null;
    }, 150);
  },
  tagEditorGetFiltered() {
    var cacheKey = this.tagEditorSearchQuery + '|' + this.tagEditorQuickFilter + '|' +
      this.tagEditorTagSelection.join(',') + '|' + this.tagEditorExcludedTags.join(',') + '|' +
      this.tagEditorTagLogic + '|' + this.tagEditorSortBy + '|' + this.tagEditorSortAsc;
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
      if (sortBy === 'tagCount') {
        var ca = a.tags ? a.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
        var cb = b.tags ? b.tags.split(',').filter(function(t) { return t.trim(); }).length : 0;
        return asc ? ca - cb : cb - ca;
      } else if (sortBy === 'modified') {
        var ma = a.tags !== self.tagEditorOriginal[a.path] ? 1 : 0;
        var mb = b.tags !== self.tagEditorOriginal[b.path] ? 1 : 0;
        return asc ? ma - mb : mb - ma;
      }
      return asc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
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
    if (type === 'notag') {
      return this.tagEditorImages.filter(function(img) { return !img.tags || img.tags.trim() === ''; }).length;
    }
    if (type === 'modified') {
      var orig = this.tagEditorOriginal;
      return this.tagEditorImages.filter(function(img) { return img.tags !== orig[img.path]; }).length;
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
    var limit = this.tagEditorTagCloudExpanded ? 1200 : this.tagEditorTagCloudLimit;
    return freq.slice(0, limit);
  },

  tagEditorSelectTag(tag) {
    var idx = this.tagEditorTagSelection.indexOf(tag);
    if (idx === -1) {
      this.tagEditorTagSelection.push(tag);
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
      this._tePushHistory();
      this.tagEditorImages.forEach(function(img) {
        var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
        if (tags.indexOf(tag) === -1) {
          tags.push(tag);
          self._teUpdateImageTags(img, tags.join(', '));
        }
      });
    }
    this.tagEditorContextMenu = null;
  },

  // ===== Card Interactions =====
  tagEditorCardClick(img, idx, e) {
    var filtered = this.tagEditorGetFiltered();
    var pageStart = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    var globalIdx = pageStart + idx;

    if (e.shiftKey && this._teLastSelected !== null) {
      var lastIdx = this._teLastSelected;
      var start2 = Math.min(lastIdx, globalIdx);
      var end2 = Math.max(lastIdx, globalIdx);
      this.tagEditorSelected = [];
      for (var i = start2; i <= end2; i++) {
        if (filtered[i]) this.tagEditorSelected.push(filtered[i].path);
      }
    } else {
      var existsIdx = this.tagEditorSelected.indexOf(img.path);
      if (existsIdx === -1) {
        this.tagEditorSelected.push(img.path);
      } else {
        this.tagEditorSelected.splice(existsIdx, 1);
      }
    }
    this._teLastSelected = globalIdx;
    this._updateRightPanel();
  },

  tagEditorCardDblClick(img, idx, e) {
    this.tagEditorRightCollapsed = false;
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
    this._updateRightPanel();
  },

  tagEditorSelectAll() {
    var filtered = this.tagEditorGetFiltered();
    var pageStart = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    var pageEnd = Math.min(filtered.length, pageStart + this.tagEditorPageSize);
    this.tagEditorSelected = [];
    for (var i = pageStart; i < pageEnd; i++) {
      this.tagEditorSelected.push(filtered[i].path);
    }
    this._updateRightPanel();
  },

  tagEditorSelectInvert() {
    var selected = this.tagEditorSelected.slice();
    this.tagEditorSelectAll();
    var allCurrent = this.tagEditorSelected.slice();
    this.tagEditorSelected = allCurrent.filter(function(p) { return selected.indexOf(p) === -1; });
    this._updateRightPanel();
  },

  _updateRightPanel() {
    if (this.tagEditorSelected.length === 1) {
      this.tagEditorRightCollapsed = false;
      var img = this.tagEditorGetSelectedImg();
      if (img) {
        this.tagEditorDetailText = img.tags || '';
        this.tagEditorDetailView = 'chip';
      }
      var self = this;
      setTimeout(function() {
        var input = document.querySelector('.te-v3-right-add input');
        if (input) input.focus();
      }, 50);
    } else if (this.tagEditorSelected.length >= 2) {
      this.tagEditorRightCollapsed = false;
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
  tagEditorGridMouseDown(e) {
    if (e.target.closest('.te-v3-card')) return;
    if (e.target.closest('input') || e.target.closest('button') || e.target.closest('select')) return;
    this.tagEditorDragSelect = true;
    this.tagEditorDragStart = { x: e.clientX, y: e.clientY };
    this.tagEditorDragRect = null;
  },

  tagEditorGridMouseMove(e) {
    if (!this.tagEditorDragSelect || !this.tagEditorDragStart) return;
    var x1 = this.tagEditorDragStart.x, y1 = this.tagEditorDragStart.y;
    var x2 = e.clientX, y2 = e.clientY;
    this.tagEditorDragRect = {
      left: Math.min(x1, x2), top: Math.min(y1, y2),
      width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)
    };
  },

  tagEditorGridMouseUp(e) {
    if (!this.tagEditorDragSelect) return;
    this.tagEditorDragSelect = false;
    this.tagEditorDragStart = null;
    if (this.tagEditorDragRect) {
      var rect = this.tagEditorDragRect;
      var self = this;
      document.querySelectorAll('.te-v3-card').forEach(function(card) {
        var cr = card.getBoundingClientRect();
        var ix = rect.left < cr.right && (rect.left + rect.width) > cr.left &&
          rect.top < cr.bottom && (rect.top + rect.height) > cr.top;
        if (ix) {
          var input = card.querySelector('input[type=checkbox]');
          if (input) {
            var path = input.getAttribute('data-path') || '';
            if (path && self.tagEditorSelected.indexOf(path) === -1) {
              self.tagEditorSelected.push(path);
            }
          }
        }
      });
      this._updateRightPanel();
    }
    this.tagEditorDragRect = null;
  },

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
      this._tePushHistory();
      self._teUpdateImageTags(img, existing.join(', '));
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
      this._tePushHistory();
      tags.splice(idx, 1);
      this._teUpdateImageTags(img, tags.join(', '));
    }
  },

  tagEditorSortSelectedTags() {
    if (this.tagEditorSelected.length !== 1) return;
    var img = this.tagEditorGetSelectedImg();
    if (!img) return;
    var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
    if (tags.length <= 1) return;
    this._tePushHistory();
    tags.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    this._teUpdateImageTags(img, tags.join(', '));
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
    this._tePushHistory();
    tags.splice(destIdx, 0, moving);
    this._teUpdateImageTags(img, tags.join(', '));
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
    if (this._tePendingTextEdits[path]) clearTimeout(this._tePendingTextEdits[path]);
    this._tePendingTextEdits[path] = setTimeout(function() {
      self._tePushHistory();
      self._teUpdateImageTags(img, self.tagEditorDetailText);
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
      this._tePushHistory();
      self._teUpdateImageTags(img, existing.join(', '));
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
      this._updateRightPanel();
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

  _teConfirmBatchScope(action) {
    if (this.tagEditorBatchScope !== 'all') return true;
    var count = this.tagEditorImages.length;
    if (count <= 10) return true;
    return window.confirm(this.t('tagEditor.batchConfirmAll').replace('{n}', count));
  },

  tagEditorBatchAdd() {
    var val = this.batchAddInput.trim();
    if (!val) return;
    if (!this._teConfirmBatchScope('add')) return;
    var newTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    if (newTags.length === 0) return;
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
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
    this.batchAddInput = '';
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchRemove() {
    var val = this.batchRemoveInput.trim();
    if (!val) return;
    if (!this._teConfirmBatchScope('remove')) return;
    var rmTags = val.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    if (rmTags.length === 0) return;
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var before = tags.length;
      tags = tags.filter(function(t) { return rmTags.indexOf(t) === -1; });
      if (tags.length !== before) self._teUpdateImageTags(img, tags.join(', '));
    });
    this.batchRemoveInput = '';
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchReplace() {
    var oldTag = this.batchOldTag.trim();
    var newTag = this.batchNewTag.trim();
    if (!oldTag || !newTag) return;
    if (!this._teConfirmBatchScope('replace')) return;
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var idx = tags.indexOf(oldTag);
      if (idx !== -1) {
        tags[idx] = newTag;
        self._teUpdateImageTags(img, self._teDedupTags(tags).join(', '));
      }
    });
    this.batchOldTag = ''; this.batchNewTag = '';
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchDedup() {
    if (!this._teConfirmBatchScope('dedup')) return;
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      var deduped = self._teDedupTags(tags);
      if (deduped.length !== tags.length) self._teUpdateImageTags(img, deduped.join(', '));
    });
    this.toast(this.t('tagEditor.batchDone'));
  },

  tagEditorBatchSort() {
    var targets = this.tagEditorGetBatchTargets();
    var self = this;
    this._tePushHistory();
    targets.forEach(function(img) {
      var tags = img.tags ? img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }) : [];
      if (tags.length <= 1) return;
      var sorted = tags.slice().sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
      if (sorted.join(',') !== tags.join(',')) self._teUpdateImageTags(img, sorted.join(', '));
    });
    this.toast(this.t('tagEditor.batchDone'));
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
    var snapshot = {};
    var orig = this.tagEditorOriginal;
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if (img.tags !== orig[img.path]) {
        snapshot[img.path] = { old: orig[img.path], new: img.tags };
      }
    });
    if (Object.keys(snapshot).length === 0) return;
    this.tagEditorHistory.push(snapshot);
    if (this.tagEditorHistory.length > 200) this.tagEditorHistory.shift();
    this.tagEditorHistoryIdx = this.tagEditorHistory.length - 1;
  },

  tagEditorUndo() {
    if (this.tagEditorHistoryIdx < 0) return;
    var snapshot = this.tagEditorHistory[this.tagEditorHistoryIdx];
    this.tagEditorHistoryIdx--;
    this._teApplySnapshot(snapshot);
  },

  tagEditorRedo() {
    if (this.tagEditorHistoryIdx >= this.tagEditorHistory.length - 1) return;
    this.tagEditorHistoryIdx++;
    var snapshot = this.tagEditorHistory[this.tagEditorHistoryIdx];
    this._teApplySnapshot(snapshot);
  },

  _teApplySnapshot(snapshot) {
    var self = this;
    var hasAnyMod = false;
    this.tagEditorImages.forEach(function(img) {
      if (snapshot.hasOwnProperty(img.path)) {
        var s = snapshot[img.path];
        img.tags = s.old;
        self.tagEditorOriginal[img.path] = s.old;
        hasAnyMod = true;
      }
    });
    this.tagEditorModified = hasAnyMod;
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    this._teFreqCacheKey = '';
    this._teCachedFreqResult = null;
    this.tagEditorDetailText = this.tagEditorGetSelectedImg()?.tags || '';
  },

  // ===== Core Edit Helper =====
  _teUpdateImageTags(img, newTagsStr) {
    var oldTags = img.tags || '';
    img.tags = newTagsStr;
    this.tagEditorModified = this.tagEditorImages.some(function(i) {
      return i.tags !== this.tagEditorOriginal[i.path];
    }.bind(this));
    this._teFilteredCacheKey = '';
    this._teCachedFiltered = null;
    this.tagEditorDetailText = newTagsStr;

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
    var orig = this.tagEditorOriginal;
    return this.tagEditorImages.filter(function(img) { return img.tags !== orig[img.path]; }).length;
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
    try {
      var payload = modified.map(function(img) {
        return { path: img.path, tags: img.tags };
      });
      var r = await fetch('/api/tageditor/save-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: payload })
      });
      var j = await r.json();
      if (j.status === 'success') {
        var orig = this.tagEditorOriginal;
        modified.forEach(function(img) { orig[img.path] = img.tags; });
        this.tagEditorModified = false;
        this.tagEditorHistory = [];
        this.tagEditorHistoryIdx = -1;
        this.tagEditorSaving = false;
        this._teIsSaving = false;
        this.toast(this.t('common.saved'));
        this._teRemoveDraft();
      } else {
        this.tagEditorSaving = false;
        this._teIsSaving = false;
        this.toast(j.message || this.t('common.error'), 'error');
      }
    } catch (e) {
      this.tagEditorSaving = false;
      this._teIsSaving = false;
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
    } catch (e) { /* quota exceeded, ignore */ }
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
        this.tagEditorRightCollapsed = true;
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
