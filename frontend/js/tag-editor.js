/* ================================================================
   tag-editor.js — Native Tag Editor v2.2
   Alpine.js mixin: clipboard, auto-save, multi-select batch ops,
   batch preview, drawer detail, drag-select, right-click context,
   incremental freq update, tag-count range filter, regex search
   ================================================================ */

window.tagEditorMixin = {
  // ── Core State ─────────────────────────────────────────
  tagEditorDir: '',
  tagEditorImages: [],
  tagEditorOriginal: {},
  tagEditorModified: false,
  tagEditorTagFreq: [],
  tagEditorSearchQuery: '',
  tagEditorTagSearch: '',
  tagEditorTagSelection: [],
  tagEditorExcludedTags: [],
  tagEditorSelected: [],
  tagEditorPage: 1,
  tagEditorPageSize: 60,
  tagEditorPageSizeOptions: [30, 60, 120, 240],
  tagEditorBatchScope: 'filtered',
  // Batch bar v2 state
  batchAddInput: '',
  batchRemoveInput: '',
  batchOldTag: '',
  batchNewTag: '',
  batchPos: 'front',
  batchSuggestOpen: null,
  batchSuggestTail: '',
  tagEditorTagLogic: 'AND',

  // ── v2.2 New State ─────────────────────────────────────
  tagEditorLoading: false,
  _teBlurTimer: null,
  tagEditorSortBy: 'name',
  tagEditorSortAsc: true,
  tagEditorDetailMode: false,
  tagEditorDetailIdx: 0,
  tagEditorDetailView: 'chip',
  tagEditorTagSortBy: 'freq',
  tagEditorTagSortAsc: false,
  tagEditorTagCloudLimit: 200,
  tagEditorTagCloudExpanded: false,
  tagEditorHistory: [],
  tagEditorHistoryIdx: -1,
  tagEditorQuickFilter: 'all',
  tagEditorFocusedImg: null,
  tagEditorFocusedVal: '',
  // Clipboard
  tagEditorCopiedTags: [],
  // Collapsible batch
  tagEditorBatchOpen: false,
  // Auto-save
  // Right-click context menu
  tagEditorContextMenu: null,
  // Drag select
  tagEditorDragSelect: false,
  tagEditorDragStart: null,
  // History panel
  tagEditorHistoryVisible: false,
  // Saving indicator
  tagEditorSaving: false,
  // Regex search
  tagEditorUseRegex: false,
  tagEditorRegexError: false,
  // Tag count range filter
  tagEditorTagCountMin: '',
  tagEditorTagCountMax: '',
  // Drag-and-drop reorder
  tagEditorDetailDragOverIdx: -1,
  tagEditorDetailDragSrcIdx: -1,

  // ── Lifecycle ──────────────────────────────────────────
  async tagEditorLoad(dir) {
    // 若无显式传入目录，尝试从 sessionStorage 恢复上次加载的目录
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
        // 加载成功，记住目录以便刷新后恢复
        try { sessionStorage.setItem('tagEditor_lastDir', d); } catch (e) {}
        this.tagEditorImages = j.data.images || [];
        this.tagEditorOriginal = {};
        var self = this;
        this.tagEditorImages.forEach(function(img) { self.tagEditorOriginal[img.path] = img.tags; });
        this.tagEditorModified = false;
        this.tagEditorSelected = [];
        this.tagEditorPage = 1;
        this.tagEditorSearchQuery = '';
        this.tagEditorTagSelection = [];
        this.tagEditorExcludedTags = [];
        this.tagEditorHistory = [];
        this.tagEditorHistoryIdx = -1;
        this.tagEditorQuickFilter = 'all';
        this.tagEditorTagCloudExpanded = false;
        this.tagEditorCopiedTags = [];
        this.tagEditorBatchOpen = false;
        this.tagEditorContextMenu = null;
        this.tagEditorDetailMode = false;
        this.tagEditorTagCountMin = '';
        this.tagEditorTagCountMax = '';
        this.tagEditorUseRegex = false;
        this._tePendingTextEdits = {};
        this._teFilteredCacheKey = '';
        this._teFreqCacheKey = '';
        await this.tagEditorLoadTagFreq();
        this._teTryRestoreDraft();
      } else {
        this.tagEditorImages = [];
        this.tagEditorTagFreq = [];
        this.tagEditorDir = '';
        try { sessionStorage.removeItem('tagEditor_lastDir'); } catch (e) {}
        this.toast(j.message || 'Load failed', 'error');
      }
    } catch (e) {
      this.tagEditorImages = [];
      this.tagEditorTagFreq = [];
      this.tagEditorDir = '';
      try { sessionStorage.removeItem('tagEditor_lastDir'); } catch (e2) {}
      this.toast('Load failed: ' + e, 'error');
    } finally {
      this.tagEditorLoading = false;
      this.finishProgress();
      this._teStartAutoSave();
    }
  },

  async tagEditorLoadTagFreq() {
    if (!this.tagEditorDir) return;
    try {
      var r = await fetch('/api/tageditor/tags?dir=' + encodeURIComponent(this.tagEditorDir));
      var j = await r.json();
      if (j.status === 'success') {
        this.tagEditorTagFreq = (j.data.tags || []);
      }
    } catch (e) { /* silent */ }
  },

  // ── Auto-save ──────────────────────────────────────────
  _teGetDraftKey() { return 'tagEditor_draft_' + (this.tagEditorDir || 'default'); },
  _teAutoSaveInProgress: false,

  _teStartAutoSave() {
    this._teStopAutoSave();
    var self = this;
    this.tagEditorAutoSaveTimer = setInterval(function() { self._teAutoSaveDraft(); }, 30000);
  },

  _teStopAutoSave() {
    if (this.tagEditorAutoSaveTimer) { clearInterval(this.tagEditorAutoSaveTimer); this.tagEditorAutoSaveTimer = null; }
  },

  _teAutoSaveDraft() {
    if (!this.tagEditorModified || this._teAutoSaveInProgress) return;
    this._teAutoSaveInProgress = true;
    var modifiedImgs = [];
    var orig = this.tagEditorOriginal;
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if (orig[img.path] !== undefined && orig[img.path] !== img.tags) {
        modifiedImgs.push({ path: img.path, tags: img.tags });
      }
    });
    if (modifiedImgs.length === 0) { this._teAutoSaveInProgress = false; return; }
    try {
      var draft = { dir: this.tagEditorDir, images: modifiedImgs, time: Date.now() };
      localStorage.setItem(this._teGetDraftKey(), JSON.stringify(draft));
    } catch (e) { /* quota exceeded, ignore */ }
    finally { this._teAutoSaveInProgress = false; }
  },

  _teTryRestoreDraft() {
    try {
      var raw = localStorage.getItem(this._teGetDraftKey());
      if (!raw) return;
      var draft = JSON.parse(raw);
      if (!draft || !draft.images || draft.images.length === 0) return;
      if (!confirm((this.t('tagEditor.draftFound') || 'Unsaved draft found. Restore?'))) {
        localStorage.removeItem(this._teGetDraftKey());
        return;
      }
      var self = this;
      draft.images.forEach(function(item) {
        var img = self.tagEditorImages.find(function(i) { return i.path === item.path; });
        if (img) { img.tags = item.tags; self.tagEditorModified = true; }
      });
      this.tagEditorRefreshTagFreq();
      localStorage.removeItem(this._teGetDraftKey());
      this.toast(this.t('tagEditor.autoSaveRestored') || 'Restored unsaved changes', 'success');
    } catch (e) { /* ignore */ }
  },

  _teClearDraft() {
    try { localStorage.removeItem(this._teGetDraftKey()); } catch (e) {}
  },

  // ── Incremental Tag Frequency ──────────────────────────
  _teUpdateFreqIncremental(oldTags, newTags) {
    var freq = (this.tagEditorTagFreq || []).slice(); // Create a copy to avoid race conditions
    var map = {};
    freq.forEach(function(t, i) { map[t.tag] = i; });
    var oldList = (oldTags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
    var newList = (newTags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
    // Remove old tags from count
    oldList.forEach(function(tag) {
      if (map[tag] !== undefined && freq[map[tag]]) {
        freq[map[tag]] = { tag: freq[map[tag]].tag, count: Math.max(0, freq[map[tag]].count - 1) };
      }
    });
    // Add new tags
    var tagMap = {};
    newList.forEach(function(tag) { tagMap[tag] = (tagMap[tag] || 0) + 1; });
    for (var tag in tagMap) {
      if (map[tag] !== undefined && freq[map[tag]]) {
        freq[map[tag]] = { tag: tag, count: freq[map[tag]].count + tagMap[tag] };
      } else {
        freq.push({ tag: tag, count: tagMap[tag] });
      }
    }
    // Remove zero-count tags and re-sort
    freq = freq.filter(function(t) { return t.count > 0; });
    freq.sort(function(a, b) { return b.count - a.count; });
    this.tagEditorTagFreq = freq;
    this._teFreqCacheKey = '';
  },

  tagEditorRefreshTagFreq() {
    var counter = {};
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
      tags.forEach(function(t) { counter[t] = (counter[t] || 0) + 1; });
    });
    var freq = [];
    for (var tag in counter) { freq.push({ tag: tag, count: counter[tag] }); }
    freq.sort(function(a, b) { return b.count - a.count; });
    this.tagEditorTagFreq = freq;
    this._teFreqCacheKey = '';
  },

  tagEditorSaveAll() {
    if (!this.tagEditorModified) return;
    this.tagEditorSaving = true;
    var orig = this.tagEditorOriginal;
    var images = this.tagEditorImages.filter(function(img) {
      return orig[img.path] !== undefined && orig[img.path] !== img.tags;
    }).map(function(img) { return { path: img.path, tags: img.tags }; });
    if (images.length === 0) { this.tagEditorModified = false; this.tagEditorSaving = false; return; }
    var self = this;
    this.startProgress();
    fetch('/api/tageditor/save-all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: images }),
    }).then(function(r) { return r.json(); }).then(function(j) {
      if (j.status === 'success') {
        self.tagEditorOriginal = {};
        self.tagEditorImages.forEach(function(img) { self.tagEditorOriginal[img.path] = img.tags; });
        self.tagEditorModified = false;
        self._teClearDraft();
        self._teFilteredCacheKey = '';
        self._teFreqCacheKey = '';
        self.toast((self.t('common.saved') || 'Saved') + ' (' + (j.data.saved || 0) + ')', 'success');
      } else { self.toast(j.message || 'Save failed', 'error'); }
    }).catch(function(e) { self.toast('Save failed: ' + e, 'error'); })
      .finally(function() { self.tagEditorSaving = false; self.finishProgress(); });
  },

  tagEditorRevert() {
    if (!confirm((this.t('tagEditor.revertConfirm') || 'Discard all unsaved changes?'))) return;
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if (self.tagEditorOriginal[img.path] !== undefined) img.tags = self.tagEditorOriginal[img.path];
    });
    this.tagEditorModified = false;
    this.tagEditorSelected = [];
    this.tagEditorHistory = [];
    this.tagEditorHistoryIdx = -1;
    this._teClearDraft();
    this.tagEditorRefreshTagFreq();
    this._teFilteredCacheKey = '';
    this._teFreqCacheKey = '';
  },

  _teConfirmNav(route) {
    if (!this.tagEditorModified || this.currentRoute !== 'tagEditor') return true;
    return confirm((this.t('tagEditor.unsavedConfirm') || 'You have unsaved changes. Leave without saving?'));
  },

  async tagEditorRestoreBackup() {
    if (!this.tagEditorDir) return;
    if (!confirm(this.t('tagEditor.restoreConfirm') || 'Restore all tag files from .bak backups?')) return;
    try {
      var r = await fetch('/api/tageditor/restore-backup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: this.tagEditorDir }),
      });
      var j = await r.json();
      if (j.status === 'success') {
        this.toast((this.t('tagEditor.restored') || 'Restored') + ': ' + (j.data.restored || 0), 'success');
        this.tagEditorLoad(this.tagEditorDir);
      }
    } catch (e) { this.toast('Restore failed: ' + e, 'error'); }
  },

  // ── Undo History ───────────────────────────────────────
  _tePushHistory(imgPath, oldTags, newTags) {
    this.tagEditorHistory = this.tagEditorHistory.slice(0, this.tagEditorHistoryIdx + 1);
    this.tagEditorHistory.push({ path: imgPath, oldTags: oldTags, newTags: newTags, time: Date.now() });
    this.tagEditorHistoryIdx = this.tagEditorHistory.length - 1;
    if (this.tagEditorHistory.length > 200) {
      this.tagEditorHistory.shift();
      this.tagEditorHistoryIdx = Math.max(0, this.tagEditorHistoryIdx - 1);
    }
    this._teFilteredCacheKey = '';
  },

  tagEditorUndo() {
    if (this.tagEditorHistoryIdx < 0) return;
    var entry = this.tagEditorHistory[this.tagEditorHistoryIdx];
    var img = this.tagEditorImages.find(function(i) { return i.path === entry.path; });
    if (img) {
      var oldTags = img.tags;
      img.tags = entry.oldTags;
      this.tagEditorModified = true;
      this._teUpdateFreqIncremental(oldTags, img.tags);
      this._teFilteredCacheKey = '';
    }
    this.tagEditorHistoryIdx--;
  },

  tagEditorRedo() {
    if (this.tagEditorHistoryIdx >= this.tagEditorHistory.length - 1) return;
    this.tagEditorHistoryIdx++;
    var entry = this.tagEditorHistory[this.tagEditorHistoryIdx];
    var img = this.tagEditorImages.find(function(i) { return i.path === entry.path; });
    if (img) {
      var oldTags = img.tags;
      img.tags = entry.newTags;
      this.tagEditorModified = true;
      this._teUpdateFreqIncremental(oldTags, img.tags);
      this._teFilteredCacheKey = '';
    }
  },

  tagEditorHasUndo() { return this.tagEditorHistoryIdx >= 0; },
  tagEditorHasRedo() { return this.tagEditorHistoryIdx < this.tagEditorHistory.length - 1; },
  tagEditorHistoryList() {
    return this.tagEditorHistory.slice(0, this.tagEditorHistoryIdx + 1).reverse().slice(0, 20);
  },

  // ── Filtering, Sorting & Pagination ────────────────────
  _teFilteredCacheKey: '',
  _teFilteredCacheResult: null,
  tagEditorGetFiltered() {
    // Build a cache key from all filter inputs
    var cacheKey = JSON.stringify({
      imgsLen: this.tagEditorImages.length,
      q: this.tagEditorSearchQuery,
      sel: this.tagEditorTagSelection,
      exc: this.tagEditorExcludedTags,
      logic: this.tagEditorTagLogic,
      qf: this.tagEditorQuickFilter,
      countMin: this.tagEditorTagCountMin,
      countMax: this.tagEditorTagCountMax,
      useRegex: this.tagEditorUseRegex,
      sortBy: this.tagEditorSortBy,
      sortAsc: this.tagEditorSortAsc,
    });
    if (this._teFilteredCacheKey === cacheKey && this._teFilteredCacheResult) {
      return this._teFilteredCacheResult;
    }
    this._teFilteredCacheKey = cacheKey;

    var imgs = this.tagEditorImages;
    var q = (this.tagEditorSearchQuery || '').toLowerCase().trim();
    var sel = this.tagEditorTagSelection || [];
    var exc = this.tagEditorExcludedTags || [];
    var logic = this.tagEditorTagLogic || 'AND';
    var qf = this.tagEditorQuickFilter || 'all';
    var countMin = parseInt(this.tagEditorTagCountMin) || 0;
    var countMax = parseInt(this.tagEditorTagCountMax);
    var useRegex = this.tagEditorUseRegex;
    this.tagEditorRegexError = false;

    if (q) {
      if (useRegex) {
        try {
          var re = new RegExp(q, 'i');
          this.tagEditorRegexError = false;
          imgs = imgs.filter(function(img) {
            return re.test(img.name || '') || re.test(img.tags || '');
          });
        } catch (e) { this.tagEditorRegexError = true; }
      } else {
        this.tagEditorRegexError = false;
        imgs = imgs.filter(function(img) {
          return (img.name && img.name.toLowerCase().indexOf(q) !== -1) ||
                 (img.tags && img.tags.toLowerCase().indexOf(q) !== -1);
        });
      }
    } else {
      this.tagEditorRegexError = false;
    }
    if (qf === 'notag') {
      imgs = imgs.filter(function(img) { return !img.tags || !img.tags.trim(); });
    } else if (qf === 'modified') {
      var orig = this.tagEditorOriginal;
      imgs = imgs.filter(function(img) { return orig[img.path] !== undefined && orig[img.path] !== img.tags; });
    }
    if (sel.length > 0) {
      imgs = imgs.filter(function(img) {
        var tags = (img.tags || '').split(',').map(function(t) { return t.trim().toLowerCase(); });
        if (logic === 'AND') { return sel.every(function(st) { return tags.indexOf(st.toLowerCase()) !== -1; }); }
        else { return sel.some(function(st) { return tags.indexOf(st.toLowerCase()) !== -1; }); }
      });
    }
    if (exc.length > 0) {
      imgs = imgs.filter(function(img) {
        var tags = (img.tags || '').split(',').map(function(t) { return t.trim().toLowerCase(); });
        return !exc.some(function(et) { return tags.indexOf(et.toLowerCase()) !== -1; });
      });
    }
    // Tag count range filter
    if (countMin > 0 || (!isNaN(countMax) && countMax >= 0)) {
      imgs = imgs.filter(function(img) {
        var cnt = (img.tags || '').split(',').filter(function(t){return t.trim();}).length;
        if (countMin > 0 && cnt < countMin) return false;
        if (!isNaN(countMax) && cnt > countMax) return false;
        return true;
      });
    }

    // Sort
    var sortBy = this.tagEditorSortBy || 'name';
    var asc = this.tagEditorSortAsc;
    var orig = this.tagEditorOriginal;
    imgs = imgs.slice().sort(function(a, b) {
      var va, vb;
      if (sortBy === 'tags') {
        va = (a.tags || '').split(',').filter(function(t){return t.trim();}).length;
        vb = (b.tags || '').split(',').filter(function(t){return t.trim();}).length;
      } else if (sortBy === 'modified') {
        va = (orig[a.path] !== undefined && orig[a.path] !== a.tags) ? 1 : 0;
        vb = (orig[b.path] !== undefined && orig[b.path] !== b.tags) ? 1 : 0;
      } else {
        va = (a.name || '').toLowerCase();
        vb = (b.name || '').toLowerCase();
      }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
    this._teFilteredCacheResult = imgs;
    return imgs;
  },

  tagEditorTotalPages() { return Math.max(1, Math.ceil(this.tagEditorGetFiltered().length / this.tagEditorPageSize)); },
  tagEditorGetPaged() {
    var f = this.tagEditorGetFiltered();
    var s = (this.tagEditorPage - 1) * this.tagEditorPageSize;
    return f.slice(s, s + this.tagEditorPageSize);
  },
  tagEditorRecompute() { this.tagEditorPage = 1; },

  tagEditorToggleSort(by) {
    if (this.tagEditorSortBy === by) { this.tagEditorSortAsc = !this.tagEditorSortAsc; }
    else { this.tagEditorSortBy = by; this.tagEditorSortAsc = true; }
  },

  tagEditorToggleTagSort(by) {
    if (this.tagEditorTagSortBy === by) { this.tagEditorTagSortAsc = !this.tagEditorTagSortAsc; }
    else { this.tagEditorTagSortBy = by; this.tagEditorTagSortAsc = false; }
  },

  // ── Tag Cloud Filtering ────────────────────────────────
  tagEditorToggleTagFilter(tag) {
    var idx = this.tagEditorTagSelection.indexOf(tag);
    if (idx !== -1) this.tagEditorTagSelection.splice(idx, 1);
    else this.tagEditorTagSelection.push(tag);
    this.tagEditorPage = 1;
  },
  tagEditorToggleExcludeTag(tag) {
    var idx = this.tagEditorExcludedTags.indexOf(tag);
    if (idx !== -1) this.tagEditorExcludedTags.splice(idx, 1);
    else this.tagEditorExcludedTags.push(tag);
    this.tagEditorPage = 1;
  },
  tagEditorClearFilters() {
    this.tagEditorTagSelection = [];
    this.tagEditorExcludedTags = [];
    this.tagEditorSearchQuery = '';
    this.tagEditorTagSearch = '';
    this.tagEditorQuickFilter = 'all';
    this.tagEditorTagCountMin = '';
    this.tagEditorTagCountMax = '';
    this.tagEditorUseRegex = false;
    this.tagEditorRegexError = false;
    this.tagEditorPage = 1;
  },
  tagEditorReset() {
    this.tagEditorImages = [];
    this.tagEditorOriginal = {};
    this.tagEditorModified = false;
    this.tagEditorTagFreq = [];
    this.tagEditorClearFilters();
    this.tagEditorSelectNone();
    this.tagEditorCloseDetail();
    this.tagEditorBatchOpen = false;
    this.tagEditorCopiedTags = [];
    this.tagEditorHistory = [];
    this.tagEditorHistoryIdx = -1;
    this.tagEditorHistoryVisible = false;
    this._teStopAutoSave();
  },
  _teFreqCacheKey: '',
  _teFreqCacheResult: null,
  tagEditorGetFilteredTagFreq() {
    var cacheKey = JSON.stringify({
      len: this.tagEditorTagFreq.length,
      q: this.tagEditorTagSearch,
      sortBy: this.tagEditorTagSortBy,
      sortAsc: this.tagEditorTagSortAsc,
    });
    if (this._teFreqCacheKey === cacheKey && this._teFreqCacheResult) {
      return this._teFreqCacheResult;
    }
    this._teFreqCacheKey = cacheKey;

    var q = (this.tagEditorTagSearch || '').toLowerCase().trim();
    var freq = this.tagEditorTagFreq || [];
    if (q) freq = freq.filter(function(t) { return t.tag.toLowerCase().indexOf(q) !== -1; });
    var sortBy = this.tagEditorTagSortBy || 'freq';
    var asc = this.tagEditorTagSortAsc;
    freq = freq.slice().sort(function(a, b) {
      var va, vb;
      if (sortBy === 'alpha') { va = a.tag.toLowerCase(); vb = b.tag.toLowerCase(); }
      else if (sortBy === 'length') { va = a.tag.length; vb = b.tag.length; }
      else { va = a.count; vb = b.count; }
      if (va < vb) return asc ? -1 : 1;
      if (va > vb) return asc ? 1 : -1;
      return 0;
    });
    this._teFreqCacheResult = freq;
    return freq;
  },
  tagEditorGetDisplayedTagFreq() {
    var freq = this.tagEditorGetFilteredTagFreq();
    var limit = this.tagEditorTagCloudExpanded ? this.tagEditorTagCloudLimit * 6 : this.tagEditorTagCloudLimit;
    return freq.slice(0, limit);
  },
  tagEditorHasMoreTags() {
    return this.tagEditorGetFilteredTagFreq().length > this.tagEditorTagCloudDisplayLimit();
  },
  tagEditorTagCloudDisplayLimit() {
    return this.tagEditorTagCloudExpanded ? this.tagEditorTagCloudLimit * 6 : this.tagEditorTagCloudLimit;
  },
  tagEditorIsTagSelected(tag) { return this.tagEditorTagSelection.indexOf(tag) !== -1; },
  tagEditorIsTagExcluded(tag) { return this.tagEditorExcludedTags.indexOf(tag) !== -1; },

  // ── Image Selection ────────────────────────────────────
  tagEditorIsSelected(p) { return this.tagEditorSelected.indexOf(p) !== -1; },
  tagEditorToggleSelect(p, event) {
    if (event && event.shiftKey && this.tagEditorSelected.length > 0) {
      // Shift+click range selection
      var filtered = this.tagEditorGetFiltered();
      var lastSelected = this.tagEditorSelected[this.tagEditorSelected.length - 1];
      var lastIdx = filtered.findIndex(function(i) { return i.path === lastSelected; });
      var curIdx = filtered.findIndex(function(i) { return i.path === p; });
      if (lastIdx !== -1 && curIdx !== -1) {
        var start = Math.min(lastIdx, curIdx);
        var end = Math.max(lastIdx, curIdx);
        for (var i = start; i <= end; i++) {
          var fp = filtered[i].path;
          if (this.tagEditorSelected.indexOf(fp) === -1) this.tagEditorSelected.push(fp);
        }
        return;
      }
    }
    var idx = this.tagEditorSelected.indexOf(p);
    if (idx !== -1) this.tagEditorSelected.splice(idx, 1);
    else this.tagEditorSelected.push(p);
  },
  tagEditorSelectAll() { this.tagEditorSelected = this.tagEditorGetFiltered().map(function(i) { return i.path; }); },
  tagEditorSelectNone() { this.tagEditorSelected = []; },
  tagEditorSelectInvert() {
    var cur = new Set(this.tagEditorSelected);
    this.tagEditorSelected = this.tagEditorGetFiltered().filter(function(i) { return !cur.has(i.path); }).map(function(i) { return i.path; });
  },
  tagEditorSelectPage() {
    var self = this;
    var pagePaths = this.tagEditorGetPaged().map(function(i) { return i.path; });
    var existing = new Set(this.tagEditorSelected);
    pagePaths.forEach(function(p) { if (!existing.has(p)) self.tagEditorSelected.push(p); });
  },

  // ── Copy / Paste ───────────────────────────────────────
  tagEditorCopyTags(imgPath) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    this.tagEditorCopiedTags = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    var msg = (this.t('tagEditor.tagsCopied') || 'Copied {n} tags').replace('{n}', this.tagEditorCopiedTags.length);
    this.toast(msg, 'success');
  },

  tagEditorPasteTags(imgPath) {
    if (this.tagEditorCopiedTags.length === 0) {
      this.toast('Nothing copied', 'warning');
      return;
    }
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    var existing = new Set((img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; }));
    var added = [];
    var self = this;
    this.tagEditorCopiedTags.forEach(function(tag) {
      if (!existing.has(tag)) { added.push(tag); existing.add(tag); }
    });
    if (added.length === 0) return;
    img.tags = Array.from(existing).join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
    this._teUpdateFreqIncremental(oldTags, img.tags);
    var msg = (this.t('tagEditor.tagsPasted') || 'Pasted {n} tags').replace('{n}', added.length);
    this.toast(msg, 'success');
  },

  tagEditorCopySingleTag(tag) {
    this.tagEditorCopiedTags = [tag];
    var msg = (this.t('tagEditor.singleTagCopied') || 'Copied tag: {tag}').replace('{tag}', tag);
    this.toast(msg, 'success');
  },

  // ── Multi-select Batch Tag Ops ─────────────────────────
  tagEditorAddTagToSelected(tag) {
    tag = (tag || '').trim();
    if (!tag) return;
    var self = this;
    var count = 0;
    this.tagEditorSelected.forEach(function(path) {
      var img = self.tagEditorImages.find(function(i) { return i.path === path; });
      if (!img) return;
      var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); });
      if (tags.indexOf(tag) === -1) {
        var oldTags = img.tags;
        img.tags = img.tags ? tag + ', ' + img.tags : tag;
        self.tagEditorModified = true;
        self._tePushHistory(path, oldTags, img.tags);
        count++;
      }
    });
    if (count > 0) { this.tagEditorRefreshTagFreq(); this.toast(tag + ' +' + count, 'success'); }
  },

  tagEditorRemoveTagFromSelected(tag) {
    tag = (tag || '').trim();
    if (!tag) return;
    var self = this;
    var count = 0;
    this.tagEditorSelected.forEach(function(path) {
      var img = self.tagEditorImages.find(function(i) { return i.path === path; });
      if (!img) return;
      var oldTags = img.tags;
      var tagList = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t && t !== tag; });
      if (tagList.join(', ') !== oldTags) {
        img.tags = tagList.join(', ');
        self.tagEditorModified = true;
        self._tePushHistory(path, oldTags, img.tags);
        count++;
      }
    });
    if (count > 0) { this.tagEditorRefreshTagFreq(); this.toast(tag + ' -' + count, 'success'); }
  },

  // ── Tag Editing (with undo) ────────────────────────────
  tagEditorRemoveTag(imgPath, tag) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    var tagList = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t && t !== tag; });
    img.tags = tagList.join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
    this._teUpdateFreqIncremental(oldTags, img.tags);
    this._teCachedDetailImg = null;
    this._teCachedDetailKey = '';
  },

  tagEditorAddTagToImage(imgPath, tag) {
    tag = (tag || '').trim();
    if (!tag || tag.length > 200 || /[<>]/.test(tag)) return;
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var existing = (img.tags || '').split(',').map(function(t) { return t.trim(); });
    if (existing.indexOf(tag) !== -1) return;
    var oldTags = img.tags;
    img.tags = img.tags ? tag + ', ' + img.tags : tag;
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
    this._teUpdateFreqIncremental(oldTags, img.tags);
    this._teCachedDetailImg = null;
    this._teCachedDetailKey = '';
  },

  tagEditorHandleTagInput(event, imgPath) {
    if (event.key !== 'Enter') return;
    var val = event.target.value.trim();
    if (!val) return;
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) { event.target.value = ''; return; }
    var oldTags = img.tags;
    var tags = (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
    var existing = new Set(tags);
    var added = [];
    val.split(',').forEach(function(t) {
      var tt = t.trim();
      if (tt && !existing.has(tt)) { added.push(tt); existing.add(tt); }
    });
    if (added.length === 0) { event.target.value = ''; return; }
    img.tags = Array.from(existing).join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
    this._teUpdateFreqIncremental(oldTags, img.tags);
    event.target.value = '';
    this.tagEditorFocusedVal = '';
    this.tagEditorFocusedImg = null;
  },

  tagEditorMarkDirty() { this.tagEditorModified = true; },

  // ── Debounced textarea handler ─────────────────────────
  _tePendingTextEdits: {},

  tagEditorUpdateTagsText(imgPath, newTags) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    // Capture original tags on first keystroke
    if (!this._tePendingTextEdits[imgPath]) {
      this._tePendingTextEdits[imgPath] = { oldTags: img.tags, timer: null };
    }
    // Update display immediately
    img.tags = newTags;
    this.tagEditorModified = true;
    this._teCachedDetailImg = null;
    this._teCachedDetailKey = '';
    var self = this;
    var pending = this._tePendingTextEdits[imgPath];
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(function() {
      var oldT = pending.oldTags;
      var newT = img.tags;
      // Merge with any existing history entry for same path
      var merged = false;
      for (var h = self.tagEditorHistoryIdx; h >= 0; h--) {
        if (self.tagEditorHistory[h].path === imgPath) {
          self.tagEditorHistory[h].newTags = newT;
          merged = true;
          break;
        }
      }
      if (!merged) self._tePushHistory(imgPath, oldT, newT);
      self._teUpdateFreqIncremental(oldT, newT);
      self._teFilteredCacheKey = '';
      self._teFreqCacheKey = '';
      delete self._tePendingTextEdits[imgPath];
    }, 500);
  },

  // ── Detail View (drawer mode) ─────────────────────────
  _teCachedDetailImg: null,
  _teCachedDetailKey: '',

  tagEditorDetailImg() {
    var filtered = this.tagEditorGetFiltered();
    var len = filtered.length;
    var idx = this.tagEditorDetailIdx;
    // Create a cache key based on filtered length, index, and image path
    var currentKey = len + ':' + idx + ':' + (filtered[idx] ? filtered[idx].path : '');
    if (this._teCachedDetailKey === currentKey && this._teCachedDetailImg) {
      return this._teCachedDetailImg;
    }
    var img = len > idx ? filtered[idx] : null;
    this._teCachedDetailImg = img;
    this._teCachedDetailKey = currentKey;
    return img;
  },

  tagEditorOpenDetail(imgPath) {
    this._teCachedDetailImg = null;
    this._teCachedDetailKey = '';
    var filtered = this.tagEditorGetFiltered();
    var idx = filtered.findIndex(function(i) { return i.path === imgPath; });
    if (idx === -1) return;
    this.tagEditorDetailIdx = idx;
    this.tagEditorDetailMode = true;
    this.tagEditorDetailView = 'chip';
    this.tagEditorContextMenu = null;
  },
  tagEditorCloseDetail() {
    this.tagEditorDetailMode = false;
    this.tagEditorContextMenu = null;
    this._teCachedDetailImg = null;
    this._teCachedDetailKey = '';
  },
  tagEditorDetailPrev() {
    this._teCachedDetailImg = null;
    this._teCachedDetailKey = '';
    if (this.tagEditorDetailIdx > 0) this.tagEditorDetailIdx--;
  },
  tagEditorDetailNext() {
    this._teCachedDetailImg = null;
    this._teCachedDetailKey = '';
    var filtered = this.tagEditorGetFiltered();
    if (this.tagEditorDetailIdx < filtered.length - 1) this.tagEditorDetailIdx++;
  },
  tagEditorOpenSelectedDetail() {
    if (this.tagEditorSelected.length === 1) {
      this.tagEditorOpenDetail(this.tagEditorSelected[0]);
    } else if (this.tagEditorDetailMode && this.tagEditorDetailImg()) {
      return;
    }
  },
  tagEditorDetailRemoveTag(tag) {
    var img = this.tagEditorDetailImg();
    if (!img) return;
    this.tagEditorRemoveTag(img.path, tag);
  },
  tagEditorDetailAddTag(event) {
    if (event.key !== 'Enter') return;
    var img = this.tagEditorDetailImg();
    if (!img) return;
    var val = event.target.value.trim();
    if (!val) return;
    var self = this;
    val.split(',').forEach(function(t) { self.tagEditorAddTagToImage(img.path, t.trim()); });
    event.target.value = '';
    this.tagEditorFocusedVal = '';
  },
  tagEditorDetailUpdateText(event) {
    var img = this.tagEditorDetailImg();
    if (!img) return;
    this.tagEditorUpdateTagsText(img.path, event.target.value);
  },

  // ── Keyboard Shortcuts ─────────────────────────────────
  tagEditorKeydown(e) {
    if (this.currentRoute !== 'tagEditor') return;
    if (!this.tagEditorImages.length) return;
    var inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's') { e.preventDefault(); this.tagEditorSaveAll(); }
      else if (e.key === 'z') { e.preventDefault(); if (e.shiftKey) this.tagEditorRedo(); else this.tagEditorUndo(); }
      else if (e.key === 'a' && !inInput) { e.preventDefault(); this.tagEditorSelectAll(); }
      else if (e.key === 'c' && !inInput) {
        e.preventDefault();
        if (this.tagEditorDetailMode && this.tagEditorDetailImg()) {
          this.tagEditorCopyTags(this.tagEditorDetailImg().path);
        } else if (this.tagEditorSelected.length === 1) {
          this.tagEditorCopyTags(this.tagEditorSelected[0]);
        } else if (this.tagEditorSelected.length === 0) {
          this.toast(this.t('tagEditor.selectOneImage') || 'Select an image to copy tags', 'warning');
        } else {
          this.toast(this.t('tagEditor.selectOneImage') || 'Select a single image to copy tags', 'warning');
        }
      }
      else if (e.key === 'v' && !inInput) {
        e.preventDefault();
        if (this.tagEditorDetailMode && this.tagEditorDetailImg()) {
          this.tagEditorPasteTags(this.tagEditorDetailImg().path);
        } else if (this.tagEditorSelected.length === 1) {
          this.tagEditorPasteTags(this.tagEditorSelected[0]);
        } else if (this.tagEditorSelected.length > 1) {
          var selCount = this.tagEditorSelected.length;
          if (!confirm('Paste ' + this.tagEditorCopiedTags.length + ' tags to ' + selCount + ' selected images?')) return;
          var self2 = this;
          this.tagEditorSelected.forEach(function(p) { self2.tagEditorPasteTags(p); });
        }
      }
    }
    if (this.tagEditorDetailMode && !inInput) {
      if (e.key === 'Escape') { this.tagEditorCloseDetail(); }
      else if (e.key === 'ArrowLeft') { this.tagEditorDetailPrev(); }
      else if (e.key === 'ArrowRight') { this.tagEditorDetailNext(); }
    }
  },

  // ── Right-Click Context Menu ───────────────────────────
  tagEditorShowContext(tag, event) {
    event.preventDefault();
    event.stopPropagation();
    var x = Math.min(event.clientX, window.innerWidth - 190);
    var y = Math.min(event.clientY, window.innerHeight - 160);
    this.tagEditorContextMenu = { tag: tag, x: Math.max(x, 4), y: Math.max(y, 4) };
  },

  tagEditorHideContext() { this.tagEditorContextMenu = null; },

  tagEditorContextInclude() {
    if (!this.tagEditorContextMenu) return;
    this.tagEditorToggleTagFilter(this.tagEditorContextMenu.tag);
    this.tagEditorHideContext();
  },

  tagEditorContextExclude() {
    if (!this.tagEditorContextMenu) return;
    this.tagEditorToggleExcludeTag(this.tagEditorContextMenu.tag);
    this.tagEditorHideContext();
  },

  tagEditorContextCopy() {
    if (!this.tagEditorContextMenu) return;
    this.tagEditorCopySingleTag(this.tagEditorContextMenu.tag);
    this.tagEditorHideContext();
  },

  tagEditorContextAddAll() {
    if (!this.tagEditorContextMenu) return;
    var tag = this.tagEditorContextMenu.tag;
    this.tagEditorHideContext();
    if (!confirm((this.t('tagEditor.batchConfirm') || 'Add') + ' "' + tag + '" ' + (this.t('tagEditor.batchConfirmOn') || 'to') + ' ' + this.tagEditorImages.length + ' ' + (this.t('tagEditor.imageCount') || 'images') + '?')) return;
    var self = this;
    var count = 0;
    this.tagEditorImages.forEach(function(img) {
      var oldTags = img.tags;
      var existing = (img.tags || '').split(',').map(function(t){return t.trim();});
      if (existing.indexOf(tag) === -1) {
        img.tags = img.tags ? tag + ', ' + img.tags : tag;
        self.tagEditorModified = true;
        self._tePushHistory(img.path, oldTags, img.tags);
        count++;
      }
    });
    if (count > 0) { this.tagEditorRefreshTagFreq(); this.toast(tag + ' +' + count, 'success'); }
    this.tagEditorHideContext();
  },

  // ── Batch Operations V2: 4-row layout, client-side ──────
  tagEditorBatchCanOperate() {
    return this.tagEditorBatchScope === 'all' ? this.tagEditorImages.length > 0 :
      this.tagEditorBatchScope === 'selected' ? this.tagEditorSelected.length > 0 :
      this.tagEditorGetFiltered().length > 0;
  },

  _teParseBatchTags(raw) {
    return (raw || '').split(/[,，\n]/).map(function(s) { return s.trim(); }).filter(Boolean);
  },

  tagEditorBatchSuggestList() {
    if (!this.batchSuggestTail || this.batchSuggestTail.length < 1) return [];
    var q = this.batchSuggestTail.toLowerCase();
    return (this.tagEditorTagFreq || [])
      .filter(function(t) { return t.tag.toLowerCase().indexOf(q) !== -1; })
      .slice(0, 8)
      .map(function(t) { return t.tag; });
  },

  batchOnInput(event, source) {
    var val = event.target.value || '';
    var m = val.match(/([^,，\n]*)$/);
    this.batchSuggestTail = (m ? m[1] : val).trim().toLowerCase();
    this.batchSuggestOpen = source;
  },
  batchOnFocus(source) { this.batchSuggestOpen = source; },
  batchOnBlur() {
    var self = this;
    setTimeout(function() { self.batchSuggestOpen = null; }, 200);
  },
  batchPickSuggestion(source, tag) {
    if (source === 'add') {
      this.batchAddInput = (this.batchAddInput || '').replace(/([^,，\n]*)$/, tag);
    } else if (source === 'remove') {
      this.batchRemoveInput = (this.batchRemoveInput || '').replace(/([^,，\n]*)$/, tag);
    } else if (source === 'replace') {
      this.batchOldTag = (this.batchOldTag || '').replace(/([^,，\n]*)$/, tag);
    }
    this.batchSuggestOpen = null;
  },

  tagEditorBatchApply(op) {
    var scope = this.tagEditorBatchScope;
    var keys = scope === 'all' ? this.tagEditorImages.map(function(i){return i.path;}) :
      scope === 'selected' ? this.tagEditorSelected.slice() :
      this.tagEditorGetFiltered().map(function(i){return i.path;});
    if (keys.length === 0) { this.toast(this.t('tagEditor.noImages') || 'No images', 'warning'); return; }

    var updates = {};
    var self = this;

    if (op === 'add') {
      var ts = this._teParseBatchTags(this.batchAddInput);
      if (ts.length === 0) { this.toast('Enter tags to add', 'warning'); return; }
      var insertFront = this.batchPos === 'front';
      keys.forEach(function(k) {
        var img = self.tagEditorImages.find(function(i){return i.path===k;});
        if (!img) return;
        var cur = (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
        var have = new Set(cur);
        var toAdd = ts.filter(function(tag){return !have.has(tag);});
        if (toAdd.length === 0) return;
        updates[k] = insertFront ? toAdd.concat(cur).join(', ') : cur.concat(toAdd).join(', ');
      });
    } else if (op === 'remove') {
      var drop = new Set(this._teParseBatchTags(this.batchRemoveInput));
      if (drop.size === 0) { this.toast('Enter tags to remove', 'warning'); return; }
      keys.forEach(function(k) {
        var img = self.tagEditorImages.find(function(i){return i.path===k;});
        if (!img) return;
        var cur = (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
        var next = cur.filter(function(tag){return !drop.has(tag);});
        if (next.join(', ') !== (img.tags || '')) updates[k] = next.join(', ');
      });
    } else if (op === 'replace') {
      var o = (this.batchOldTag || '').trim();
      var n = (this.batchNewTag || '').trim();
      if (!o || !n) { this.toast('Enter both old and new tags', 'warning'); return; }
      keys.forEach(function(k) {
        var img = self.tagEditorImages.find(function(i){return i.path===k;});
        if (!img) return;
        var cur = (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
        if (cur.indexOf(o) === -1) return;
        var seen = new Set(); var next = [];
        cur.forEach(function(t) { var out = t === o ? n : t; if (!seen.has(out)) { seen.add(out); next.push(out); } });
        updates[k] = next.join(', ');
      });
    } else if (op === 'dedupe') {
      keys.forEach(function(k) {
        var img = self.tagEditorImages.find(function(i){return i.path===k;});
        if (!img) return;
        var cur = (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
        var seen = new Set(); var next = [];
        cur.forEach(function(t) { if (!seen.has(t)) { seen.add(t); next.push(t); } });
        if (next.length !== cur.length) updates[k] = next.join(', ');
      });
    }

    var count = Object.keys(updates).length;
    if (count === 0) { this.toast(this.t('tagEditor.batchNoChanges') || 'No changes to apply', 'warning'); return; }

    var scopeLabel = scope === 'all' ? (this.t('tagEditor.scopeAll') || 'All') :
      scope === 'selected' ? (this.t('tagEditor.scopeSelected') || 'Selected') :
      (this.t('tagEditor.scopeFiltered') || 'Filtered');
    if (!confirm('Apply ' + op + ' to ' + count + ' images (' + scopeLabel + ')?')) return;

    for (var path in updates) {
      var img = self.tagEditorImages.find(function(i){return i.path===path;});
      if (img) {
        var oldTags = img.tags;
        img.tags = updates[path];
        self.tagEditorModified = true;
        self._tePushHistory(path, oldTags, updates[path]);
      }
    }
    this.tagEditorRefreshTagFreq();
    this._teFilteredCacheKey = '';

    if (op === 'add') this.batchAddInput = '';
    if (op === 'remove') this.batchRemoveInput = '';
    if (op === 'replace') { this.batchOldTag = ''; this.batchNewTag = ''; }

    this.toast(op + ': ' + count + ' ' + (this.t('tagEditor.imageCount') || 'images'), 'success');
  },

  // ── Tag Stats Panel ─────────────────────────────────────
  statsFilter: '',
  statsSort: 'count_desc',

  tagEditorStatsItems() {
    var counter = {};
    var self = this;
    this.tagEditorSelected.forEach(function(path) {
      var img = self.tagEditorImages.find(function(i){return i.path===path;});
      if (!img) return;
      (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;}).forEach(function(t){
        counter[t] = (counter[t] || 0) + 1;
      });
    });
    var items = [];
    for (var tag in counter) items.push({tag: tag, count: counter[tag]});
    items.sort(function(a,b){return b.count - a.count || a.tag.localeCompare(b.tag);});
    return items;
  },

  tagEditorStatsMax() {
    var items = this.tagEditorStatsItems();
    return items.length > 0 ? items[0].count : 1;
  },

  tagEditorStatsFiltered() {
    var items = this.tagEditorStatsItems();
    var f = (this.statsFilter || '').trim().toLowerCase();
    if (f) items = items.filter(function(i){return i.tag.toLowerCase().indexOf(f) !== -1;});
    if (this.statsSort === 'count_asc') items.sort(function(a,b){return a.count - b.count || a.tag.localeCompare(b.tag);});
    else if (this.statsSort === 'name_asc') items.sort(function(a,b){return a.tag.localeCompare(b.tag);});
    else if (this.statsSort === 'name_desc') items.sort(function(a,b){return b.tag.localeCompare(a.tag);});
    // default: count_desc (already sorted in tagEditorStatsItems)
    return items;
  },

  tagEditorPickStatsTag(tag) {
    var matched = [];
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if ((img.tags || '').split(',').map(function(t){return t.trim();}).indexOf(tag) !== -1) {
        matched.push(img.path);
      }
    });
    this.tagEditorSelected = matched;
    this.toast(tag + ': ' + matched.length + ' images', 'success');
  },

  tagEditorStatsRemoveTag(tag) {
    var self = this;
    var modified = 0;
    this.tagEditorSelected.forEach(function(path) {
      var img = self.tagEditorImages.find(function(i){return i.path===path;});
      if (!img) return;
      var oldTags = img.tags;
      var cur = (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t && t !== tag;});
      if (cur.join(', ') !== oldTags) {
        img.tags = cur.join(', ');
        self.tagEditorModified = true;
        self._tePushHistory(path, oldTags, img.tags);
        modified++;
      }
    });
    if (modified > 0) { this.tagEditorRefreshTagFreq(); this._teFilteredCacheKey = ''; }
  },

  tagEditorSortSingle(imgPath) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    tags.sort();
    img.tags = tags.join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
  },

  // ── No-tag / Modified counts ───────────────────────────
  tagEditorNoTagCount() {
    return this.tagEditorImages.filter(function(img) { return !img.tags || !img.tags.trim(); }).length;
  },
  tagEditorModifiedCount() {
    var orig = this.tagEditorOriginal;
    return this.tagEditorImages.filter(function(img) { return orig[img.path] !== undefined && orig[img.path] !== img.tags; }).length;
  },

  // ── Autocomplete ───────────────────────────────────────
  _teSuggestDebounceTimer: null,

  tagEditorGetSuggestions(imgPath) {
    if (this.tagEditorFocusedImg !== imgPath || !this.tagEditorFocusedVal || this.tagEditorFocusedVal.length < 1) return [];
    var q = this.tagEditorFocusedVal.toLowerCase();
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    var existing = img ? (img.tags || '').split(',').map(function(t) { return t.trim().toLowerCase(); }) : [];
    var freq = this.tagEditorTagFreq || [];
    return freq.filter(function(t) { return t.tag.toLowerCase().indexOf(q) !== -1 && existing.indexOf(t.tag.toLowerCase()) === -1; })
               .slice(0, 8)
               .map(function(t) { return t.tag; });
  },

  tagEditorOnSuggestInput(event, imgPath) {
    clearTimeout(this._teBlurTimer);
    clearTimeout(this._teSuggestDebounceTimer);
    this.tagEditorFocusedImg = imgPath;
    var self = this;
    var val = event.target.value;
    this._teSuggestDebounceTimer = setTimeout(function() {
      self.tagEditorFocusedVal = val;
    }, 50);
  },

  tagEditorPickSuggestion(imgPath, tag) {
    this.tagEditorAddTagToImage(imgPath, tag);
    this.tagEditorFocusedImg = null;
    this.tagEditorFocusedVal = '';
  },

  tagEditorBlurSuggest() {
    var self = this;
    clearTimeout(this._teBlurTimer);
    this._teBlurTimer = setTimeout(function() { self.tagEditorFocusedImg = null; self.tagEditorFocusedVal = ''; }, 200);
  },

  // ── Tag Reorder (move left/right) ─────────────────────
  tagEditorMoveTag(imgPath, tag, direction) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); });
    var idx = -1;
    for (var i = 0; i < tags.length; i++) {
      if (tags[i] === tag) { idx = i; break; }
    }
    if (idx === -1) return;
    var targetIdx = direction === 'left' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= tags.length) return;
    var tmp = tags[idx]; tags[idx] = tags[targetIdx]; tags[targetIdx] = tmp;
    img.tags = tags.join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
  },

  tagEditorDetailMoveTag(tag, direction) {
    var img = this.tagEditorDetailImg();
    if (!img) return;
    this.tagEditorMoveTag(img.path, tag, direction);
  },

  // ── Tag Drag-and-Drop Reorder ──────────────────────────
  tagEditorDetailDragStart(event, tagIdx) {
    this.tagEditorDetailDragSrcIdx = tagIdx;
    this.tagEditorDetailDragOverIdx = -1;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(tagIdx));
    var el = event.target.closest('.te-pill-wrap');
    if (el) { setTimeout(function() { el.style.opacity = '0.4'; }, 0); }
  },
  tagEditorDetailDragOver(event, tagIdx) {
    event.dataTransfer.dropEffect = 'move';
    this.tagEditorDetailDragOverIdx = tagIdx;
  },
  tagEditorDetailDragLeave(event) {
    this.tagEditorDetailDragOverIdx = -1;
  },
  tagEditorDetailDrop(event, targetIdx) {
    var srcIdx = parseInt(event.dataTransfer.getData('text/plain'));
    var srcEl = document.querySelector('.te-pill-drag-src');
    if (srcEl) srcEl.style.opacity = '';
    this.tagEditorDetailDragSrcIdx = -1;
    this.tagEditorDetailDragOverIdx = -1;
    if (isNaN(srcIdx) || srcIdx === targetIdx) return;

    var img = this.tagEditorDetailImg();
    if (!img) return;
    var oldTags = img.tags;
    var tags = (img.tags || '').split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
    if (srcIdx >= tags.length || targetIdx >= tags.length) return;
    var moved = tags.splice(srcIdx, 1)[0];
    tags.splice(targetIdx, 0, moved);
    img.tags = tags.join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(img.path, oldTags, img.tags);
  },

  // ── Drag to Select ─────────────────────────────────────
  tagEditorCardMouseDown(event, imgPath) {
    if (event.button !== 0) return;
    if (event.target.closest('input,textarea,button,.te-pill,.te-pill-del')) return;
    // Start drag selection
    var grid = event.currentTarget.closest('.te-image-grid');
    if (!grid) return;
    var gridRect = grid.getBoundingClientRect();
    this.tagEditorDragStart = { x: event.clientX, y: event.clientY, grid: grid, gridTop: gridRect.top, gridLeft: gridRect.left };
    this._teDragRect = { left: event.clientX, top: event.clientY, width: 0, height: 0 };
    this.tagEditorDragSelect = false;
    // Listen for move/up on window so drag works outside the grid
    this._teRemoveDragListeners();
    var self = this;
    this._teDragMoveHandler = function(e) { self._teOnDragMove(e); };
    this._teDragUpHandler = function(e) { self._teOnDragEnd(e); };
    window.addEventListener('mousemove', this._teDragMoveHandler);
    window.addEventListener('mouseup', this._teDragUpHandler);
  },

  _teOnDragMove(e) {
    if (!this.tagEditorDragStart) return;
    var dx = (e.clientX - this.tagEditorDragStart.x);
    var dy = (e.clientY - this.tagEditorDragStart.y);
    if (!this.tagEditorDragSelect && (dx * dx + dy * dy) > 16) {
      // Threshold crossed: start drag selection
      this.tagEditorDragSelect = true;
    }
    if (!this.tagEditorDragSelect) return;
    var left = Math.min(e.clientX, this.tagEditorDragStart.x);
    var top = Math.min(e.clientY, this.tagEditorDragStart.y);
    var width = Math.abs(e.clientX - this.tagEditorDragStart.x);
    var height = Math.abs(e.clientY - this.tagEditorDragStart.y);
    this._teDragRect = { left: left, top: top, width: width, height: height };
  },

  _teOnDragEnd(e) {
    this._teRemoveDragListeners();
    if (this.tagEditorDragSelect && this._teDragRect) {
      // Select cards that intersect the drag rectangle
      var rect = this._teDragRect;
      var grid = this.tagEditorDragStart ? this.tagEditorDragStart.grid : null;
      if (grid) {
        var cards = grid.querySelectorAll('.te-card');
        var self = this;
        cards.forEach(function(card) {
          var cr = card.getBoundingClientRect();
          // Check intersection
          if (cr.right > rect.left && cr.left < rect.left + rect.width &&
              cr.bottom > rect.top && cr.top < rect.top + rect.height) {
            var imgPath = card.getAttribute('data-te-path');
            if (imgPath && self.tagEditorSelected.indexOf(imgPath) === -1) {
              self.tagEditorSelected.push(imgPath);
            }
          }
        });
      }
    }
    this._teDragRect = null;
    this.tagEditorDragStart = null;
    // Use microtask to defer reset until after click event fires
    var self = this;
    Promise.resolve().then(function() { self.tagEditorDragSelect = false; });
  },

  // Cleanup drag listeners on route change
  tagEditorCleanup() {
    this._teRemoveDragListeners();
    this._teDragRect = null;
    this.tagEditorDragStart = null;
    this.tagEditorDragSelect = false;
    this._teStopAutoSave();
    // Cleanup debounce timers
    if (this._teBlurTimer) { clearTimeout(this._teBlurTimer); this._teBlurTimer = null; }
    var pending = this._tePendingTextEdits || {};
    for (var key in pending) {
      if (pending[key] && pending[key].timer) clearTimeout(pending[key].timer);
    }
    this._tePendingTextEdits = {};
  },

  _teRemoveDragListeners() {
    if (this._teDragMoveHandler) {
      window.removeEventListener('mousemove', this._teDragMoveHandler);
      this._teDragMoveHandler = null;
    }
    if (this._teDragUpHandler) {
      window.removeEventListener('mouseup', this._teDragUpHandler);
      this._teDragUpHandler = null;
    }
  },

  tagEditorDragRect() {
    return this._teDragRect || null;
  },

  tagEditorCardClick(event, imgPath) {
    if (event.target.closest('input,textarea,button,.te-pill,.te-pill-del,.te-card-check')) return;
    if (this.tagEditorDragSelect) return;
    this.tagEditorOpenDetail(imgPath);
  },

  // ── Tag Cloud scroll context ────────────────────────────
  tagEditorTagRightClick(tag, event) {
    this.tagEditorShowContext(tag, event);
  },

  tagEditorMaxFreq() {
    if (!this.tagEditorTagFreq || this.tagEditorTagFreq.length === 0) return 1;
    return this.tagEditorTagFreq[0].count;
  },

  // ── Card tag click handler ──────────────────────────────
  tagEditorCardTagClick(tag, event, imgPath) {
    if (event.ctrlKey || event.metaKey) {
      // Ctrl+click: remove from all selected
      event.preventDefault();
      this.tagEditorRemoveTagFromSelected(tag);
    } else if (event.shiftKey) {
      // Shift+click: add to all selected
      event.preventDefault();
      this.tagEditorAddTagToSelected(tag);
    } else {
      this.tagEditorRemoveTag(imgPath, tag);
    }
  },

  // ── Improved empty state ────────────────────────────────
  tagEditorHasImages() {
    return this.tagEditorImages.length > 0 && !this.tagEditorLoading;
  },
  tagEditorIsEmpty() {
    return this.tagEditorImages.length === 0 && !this.tagEditorLoading;
  },

  // ── Load from training directory ────────────────────────
  tagEditorLoadFromTraining() {
    if (this.form && this.form.train_data_dir) {
      this.tagEditorDir = this.form.train_data_dir;
      this.tagEditorLoad();
    }
  },

  // ── Page navigation ─────────────────────────────────────
  tagEditorGoPage(page) {
    var total = this.tagEditorTotalPages();
    this.tagEditorPage = Math.max(1, Math.min(page, total));
  },

  // ── Export filtered tags ────────────────────────────────
  tagEditorExportFilteredTags() {
    var filtered = this.tagEditorGetFiltered();
    var tagSet = new Set();
    filtered.forEach(function(img) {
      (img.tags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;}).forEach(function(t){tagSet.add(t);});
    });
    var txt = Array.from(tagSet).sort().join(', ');
    if (!txt) { this.toast('No tags to export', 'warning'); return; }
    var self = this;
    navigator.clipboard.writeText(txt).then(function() {
      self.toast((self.t('common.copied') || 'Copied') + ' ' + tagSet.size + ' tags', 'success');
    }).catch(function() {
      self.toast('Copy failed', 'error');
    });
  },

  // ── Keyboard: Enter opens detail on selected card ───────
  tagEditorHandleGlobalKey(e) {
    if (e.key !== 'Enter') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
    if (this.tagEditorDetailMode) return;
    if (this.tagEditorSelected.length === 1) {
      this.tagEditorOpenDetail(this.tagEditorSelected[0]);
    }
  }
};
