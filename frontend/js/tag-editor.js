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
  tagEditorBatchVal: '',
  tagEditorBatchVal2: '',
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
  tagEditorAutoSaveTimer: null,
  // Tag count range filter
  tagEditorTagCountMin: '',
  tagEditorTagCountMax: '',
  // Regex search
  tagEditorUseRegex: false,
  tagEditorRegexError: false,
  // Batch preview
  tagEditorBatchPreview: null,
  // Right-click context menu
  tagEditorContextMenu: null,
  // Drag select
  tagEditorDragSelect: false,
  tagEditorDragStart: null,
  tagEditorDragRect: null,
  // History panel
  tagEditorHistoryVisible: false,
  // Saving indicator
  tagEditorSaving: false,

  // ── Lifecycle ──────────────────────────────────────────
  async tagEditorLoad(dir) {
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
        this.tagEditorBatchPreview = null;
        this.tagEditorContextMenu = null;
        this.tagEditorDetailMode = false;
        this.tagEditorTagCountMin = '';
        this.tagEditorTagCountMax = '';
        this.tagEditorUseRegex = false;
        this._tePendingTextEdits = {};
        await this.tagEditorLoadTagFreq();
        this._teTryRestoreDraft();
      } else {
        this.tagEditorImages = [];
        this.tagEditorTagFreq = [];
        this.toast(j.message || 'Load failed', 'error');
      }
    } catch (e) {
      this.tagEditorImages = [];
      this.tagEditorTagFreq = [];
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

  _teStartAutoSave() {
    this._teStopAutoSave();
    var self = this;
    this.tagEditorAutoSaveTimer = setInterval(function() { self._teAutoSaveDraft(); }, 30000);
  },

  _teStopAutoSave() {
    if (this.tagEditorAutoSaveTimer) { clearInterval(this.tagEditorAutoSaveTimer); this.tagEditorAutoSaveTimer = null; }
  },

  _teAutoSaveDraft() {
    if (!this.tagEditorModified) return;
    var modifiedImgs = [];
    var orig = this.tagEditorOriginal;
    var self = this;
    this.tagEditorImages.forEach(function(img) {
      if (orig[img.path] !== undefined && orig[img.path] !== img.tags) {
        modifiedImgs.push({ path: img.path, tags: img.tags });
      }
    });
    if (modifiedImgs.length === 0) return;
    try {
      var draft = { dir: this.tagEditorDir, images: modifiedImgs, time: Date.now() };
      localStorage.setItem(this._teGetDraftKey(), JSON.stringify(draft));
    } catch (e) { /* quota exceeded, ignore */ }
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
    var freq = this.tagEditorTagFreq || [];
    var map = {};
    freq.forEach(function(t, i) { map[t.tag] = i; });
    var oldList = (oldTags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
    var newList = (newTags || '').split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
    // Remove old tags from count
    oldList.forEach(function(tag) {
      if (map[tag] !== undefined && freq[map[tag]]) {
        freq[map[tag]].count = Math.max(0, freq[map[tag]].count - 1);
      }
    });
    // Add new tags
    var tagMap = {};
    newList.forEach(function(tag) { tagMap[tag] = (tagMap[tag] || 0) + 1; });
    for (var tag in tagMap) {
      if (map[tag] !== undefined && freq[map[tag]]) {
        freq[map[tag]].count += tagMap[tag];
      } else {
        freq.push({ tag: tag, count: tagMap[tag] });
      }
    }
    // Remove zero-count tags and re-sort
    freq = freq.filter(function(t) { return t.count > 0; });
    freq.sort(function(a, b) { return b.count - a.count; });
    this.tagEditorTagFreq = freq;
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
    if (this.tagEditorHistory.length > 200) { this.tagEditorHistory.shift(); this.tagEditorHistoryIdx--; }
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
    }
  },

  tagEditorHasUndo() { return this.tagEditorHistoryIdx >= 0; },
  tagEditorHasRedo() { return this.tagEditorHistoryIdx < this.tagEditorHistory.length - 1; },
  tagEditorHistoryList() {
    return this.tagEditorHistory.slice(0, this.tagEditorHistoryIdx + 1).reverse().slice(0, 20);
  },

  // ── Filtering, Sorting & Pagination ────────────────────
  tagEditorGetFiltered() {
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
          imgs = imgs.filter(function(img) {
            return re.test(img.name || '') || re.test(img.tags || '');
          });
        } catch (e) { this.tagEditorRegexError = true; }
      } else {
        imgs = imgs.filter(function(img) {
          return (img.name && img.name.toLowerCase().indexOf(q) !== -1) ||
                 (img.tags && img.tags.toLowerCase().indexOf(q) !== -1);
        });
      }
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
  tagEditorGetFilteredTagFreq() {
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
    return freq;
  },
  tagEditorGetDisplayedTagFreq() {
    var freq = this.tagEditorGetFilteredTagFreq();
    var limit = this.tagEditorTagCloudExpanded ? this.tagEditorTagCloudLimit * 6 : this.tagEditorTagCloudLimit;
    if (freq.length > limit && !this.tagEditorTagCloudExpanded) {
      return freq.slice(0, limit);
    }
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
    if (this.tagEditorCopiedTags.length === 0) return;
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
      var tags = img.tags.split(',').map(function(t) { return t.trim(); });
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
      var tagList = img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t && t !== tag; });
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
    var tagList = img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t && t !== tag; });
    img.tags = tagList.join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
    this._teUpdateFreqIncremental(oldTags, img.tags);
  },

  tagEditorAddTagToImage(imgPath, tag) {
    tag = (tag || '').trim();
    if (!tag) return;
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var existing = img.tags.split(',').map(function(t) { return t.trim(); });
    if (existing.indexOf(tag) !== -1) return;
    var oldTags = img.tags;
    img.tags = img.tags ? tag + ', ' + img.tags : tag;
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
    this._teUpdateFreqIncremental(oldTags, img.tags);
  },

  tagEditorHandleTagInput(event, imgPath) {
    if (event.key !== 'Enter') return;
    var val = event.target.value.trim();
    if (!val) return;
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) { event.target.value = ''; return; }
    var oldTags = img.tags;
    var tags = img.tags.split(',').map(function(t){return t.trim();}).filter(function(t){return t;});
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
      delete self._tePendingTextEdits[imgPath];
    }, 500);
  },

  // ── Detail View (drawer mode) ─────────────────────────
  _teCachedFiltered: null,
  _teCachedDetailImg: null,
  _teCachedFreqCount: 0,

  tagEditorDetailImg() {
    var filtered = this.tagEditorGetFiltered();
    var len = filtered.length;
    if (this._teCachedFreqCount === len && this._teCachedDetailImg) {
      return this._teCachedDetailImg;
    }
    var img = len > this.tagEditorDetailIdx ? filtered[this.tagEditorDetailIdx] : null;
    this._teCachedDetailImg = img;
    this._teCachedFreqCount = len;
    this._teCachedFiltered = filtered;
    return img;
  },

  tagEditorOpenDetail(imgPath) {
    this._teCachedDetailImg = null;
    this._teCachedFiltered = null;
    this._teCachedFreqCount = 0;
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
    this._teCachedFiltered = null;
  },
  tagEditorDetailPrev() {
    this._teCachedDetailImg = null;
    if (this.tagEditorDetailIdx > 0) this.tagEditorDetailIdx--;
  },
  tagEditorDetailNext() {
    this._teCachedDetailImg = null;
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
        }
      }
      else if (e.key === 'v' && !inInput) {
        e.preventDefault();
        if (this.tagEditorDetailMode && this.tagEditorDetailImg()) {
          this.tagEditorPasteTags(this.tagEditorDetailImg().path);
        } else if (this.tagEditorSelected.length >= 1) {
          var self = this;
          this.tagEditorSelected.forEach(function(p) { self.tagEditorPasteTags(p); });
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

  // ── Batch Operations ───────────────────────────────────
  async tagEditorBatchOp(op) {
    var args = {};
    var needsVal = ['add_prefix', 'add_suffix', 'delete_tag', 'inject_trigger', 'remove_trigger'].indexOf(op) !== -1;
    var needsFind = op === 'find_replace' || op === 'regex_replace' || op === 'replace_tag';
    if (needsVal && !this.tagEditorBatchVal) { this.toast(this.t('tagEditor.batchPlaceholder') || 'Enter a value', 'warning'); return; }
    if (needsFind && !this.tagEditorBatchVal) { this.toast(this.t('tagEditor.batchPlaceholder') || 'Enter find text', 'warning'); return; }

    if (op === 'find_replace') { args.find = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else if (op === 'regex_replace') { args.pattern = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else if (op === 'replace_tag') { args.find = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else { args.value = this.tagEditorBatchVal; }

    var scope = this.tagEditorBatchScope;
    var count = scope === 'all' ? this.tagEditorImages.length : scope === 'selected' ? this.tagEditorSelected.length : this.tagEditorGetFiltered().length;
    if (count === 0) { this.toast(this.t('tagEditor.noImages') || 'No images to operate on', 'warning'); return; }
    var scopeLabel = scope === 'all' ? (this.t('tagEditor.scopeAll') || 'All') : scope === 'selected' ? (this.t('tagEditor.scopeSelected') || 'Selected') : (this.t('tagEditor.scopeFiltered') || 'Filtered');
    // Stronger confirm for 'all' scope
    if (scope === 'all') {
      var msg = (this.t('tagEditor.batchConfirmAll') || 'WARNING: This will affect ALL {n} images. Continue?').replace('{n}', count);
      if (!confirm(msg)) return;
    } else {
      if (!confirm((this.t('tagEditor.batchConfirm') || 'Apply') + ' [' + op + '] ' + (this.t('tagEditor.batchConfirmOn') || 'to') + ' ' + count + ' ' + (this.t('tagEditor.imageCount') || 'images') + ' (' + scopeLabel + ')?')) return;
    }

    var payload = { dir: this.tagEditorDir, operation: op, args: args, scope: scope };
    if (scope === 'selected') payload.selected_paths = this.tagEditorSelected;
    else if (scope === 'filtered') payload.selected_paths = this.tagEditorGetFiltered().map(function(i) { return i.path; });

    try {
      var r = await fetch('/api/tageditor/batch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var j = await r.json();
      if (j.status === 'success') {
        var msg = (this.t('tagEditor.batchDone') || 'Done') + ': ' + (j.data.modified || 0);
        if (j.data.errors && j.data.errors.length > 0) {
          msg += ' (' + (this.t('tagEditor.batchErrors') || 'errors') + ': ' + j.data.errors.length + ')';
          console.warn('Batch errors:', j.data.errors);
        }
        this.toast(msg, j.data.errors && j.data.errors.length > 0 ? 'warning' : 'success');
        // Incremental update instead of full reload
        if (j.data.modified > 0) {
          this.tagEditorLoadTagFreq();
          // Refresh images but keep state
          var refreshR = await fetch('/api/tageditor/images?dir=' + encodeURIComponent(this.tagEditorDir));
          var refreshJ = await refreshR.json();
          if (refreshJ.status === 'success') {
            this.tagEditorImages = refreshJ.data.images || [];
            var orig = this.tagEditorOriginal;
            var self2 = this;
            this.tagEditorImages.forEach(function(img) {
              self2.tagEditorOriginal[img.path] = orig[img.path] !== undefined ? orig[img.path] : img.tags;
            });
            this.tagEditorModified = false;
            this.tagEditorRefreshTagFreq();
            this._teClearDraft();
          }
        }
      } else { this.toast(j.message || 'Operation failed', 'error'); }
    } catch (e) { this.toast('Operation failed: ' + e, 'error'); }
  },

  async tagEditorPreviewBatchOp(op) {
    var args = {};
    var needsVal = ['add_prefix', 'add_suffix', 'delete_tag', 'inject_trigger', 'remove_trigger'].indexOf(op) !== -1;
    var needsFind = op === 'find_replace' || op === 'regex_replace' || op === 'replace_tag';
    if (needsVal && !this.tagEditorBatchVal) { this.toast(this.t('tagEditor.batchPlaceholder') || 'Enter a value', 'warning'); return; }
    if (needsFind && !this.tagEditorBatchVal) { this.toast(this.t('tagEditor.batchPlaceholder') || 'Enter find text', 'warning'); return; }

    if (op === 'find_replace') { args.find = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else if (op === 'regex_replace') { args.pattern = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else if (op === 'replace_tag') { args.find = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else { args.value = this.tagEditorBatchVal; }

    var scope = this.tagEditorBatchScope;
    var payload = { dir: this.tagEditorDir, operation: op, args: args, scope: scope };
    if (scope === 'selected') payload.selected_paths = this.tagEditorSelected;
    else if (scope === 'filtered') payload.selected_paths = this.tagEditorGetFiltered().map(function(i) { return i.path; });

    try {
      var r = await fetch('/api/tageditor/batch/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var j = await r.json();
      if (j.status === 'success') {
        // Store editable preview entries
        var previewList = (j.data.preview || []).map(function(item) {
          return { path: item.path, name: item.name, old_tags: item.old_tags, new_tags: item.new_tags, _edited: item.new_tags };
        });
        this.tagEditorBatchPreview = { operation: op, data: j.data, preview: previewList };
      } else { this.toast(j.message || 'Preview failed', 'error'); }
    } catch (e) { this.toast('Preview failed: ' + e, 'error'); }
  },

  tagEditorUpdatePreviewTag(previewIdx, value) {
    if (!this.tagEditorBatchPreview || !this.tagEditorBatchPreview.preview) return;
    var item = this.tagEditorBatchPreview.preview[previewIdx];
    if (item) item._edited = value;
  },

  async tagEditorConfirmBatchPreview() {
    if (!this.tagEditorBatchPreview) return;
    var pdata = this.tagEditorBatchPreview.preview;
    if (!pdata || pdata.length === 0) return;
    var images = pdata.map(function(item) {
      return { path: item.path, tags: item._edited || item.new_tags };
    });

    try {
      var r = await fetch('/api/tageditor/save-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: images }),
      });
      var j = await r.json();
      if (j.status === 'success') {
        this.tagEditorBatchPreview = null;
        // Refresh images
        var refreshR = await fetch('/api/tageditor/images?dir=' + encodeURIComponent(this.tagEditorDir));
        var refreshJ = await refreshR.json();
        if (refreshJ.status === 'success') {
          this.tagEditorImages = refreshJ.data.images || [];
          var orig = this.tagEditorOriginal;
          var self2 = this;
          this.tagEditorImages.forEach(function(img) {
            self2.tagEditorOriginal[img.path] = orig[img.path] !== undefined ? orig[img.path] : img.tags;
          });
          this.tagEditorModified = false;
          this.tagEditorRefreshTagFreq();
        }
        this.toast(this.t('tagEditor.batchDone') || 'Done', 'success');
      } else { this.toast(j.message || 'Save failed', 'error'); }
    } catch (e) { this.toast('Save failed: ' + e, 'error'); }
  },

  tagEditorCancelBatchPreview() { this.tagEditorBatchPreview = null; },

  tagEditorSortSingle(imgPath) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    var tags = img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t; });
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
  tagEditorGetSuggestions(imgPath) {
    if (this.tagEditorFocusedImg !== imgPath || !this.tagEditorFocusedVal || this.tagEditorFocusedVal.length < 1) return [];
    var q = this.tagEditorFocusedVal.toLowerCase();
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    var existing = img ? img.tags.split(',').map(function(t) { return t.trim().toLowerCase(); }) : [];
    var freq = this.tagEditorTagFreq || [];
    return freq.filter(function(t) { return t.tag.toLowerCase().indexOf(q) !== -1 && existing.indexOf(t.tag.toLowerCase()) === -1; })
               .slice(0, 8)
               .map(function(t) { return t.tag; });
  },

  tagEditorOnSuggestInput(event, imgPath) {
    clearTimeout(this._teBlurTimer);
    this.tagEditorFocusedImg = imgPath;
    this.tagEditorFocusedVal = event.target.value;
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
    var tags = img.tags.split(',').map(function(t) { return t.trim(); });
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

  // ── Drag to Select ─────────────────────────────────────
  tagEditorCardMouseDown(event, imgPath) {
    if (event.button !== 0) return;
    if (event.target.closest('input,textarea,button,.te-pill,.te-pill-arrow')) return;
    // Start drag selection
    var grid = event.currentTarget.closest('.te-image-grid');
    if (!grid) return;
    var gridRect = grid.getBoundingClientRect();
    this.tagEditorDragStart = { x: event.clientX, y: event.clientY, grid: grid, gridTop: gridRect.top, gridLeft: gridRect.left };
    this._teDragRect = { left: event.clientX, top: event.clientY, width: 0, height: 0 };
    this.tagEditorDragSelect = false;
    // Listen for move/up on window so drag works outside the grid
    var self = this;
    if (this._teDragMoveHandler) window.removeEventListener('mousemove', this._teDragMoveHandler);
    if (this._teDragUpHandler) window.removeEventListener('mouseup', this._teDragUpHandler);
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
    window.removeEventListener('mousemove', this._teDragMoveHandler);
    window.removeEventListener('mouseup', this._teDragUpHandler);
    this._teDragMoveHandler = null;
    this._teDragUpHandler = null;
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
    this.tagEditorDragSelect = false;
  },

  tagEditorDragRect() {
    return this._teDragRect || null;
  },

  tagEditorCardClick(event, imgPath) {
    if (event.target.closest('input,textarea,button,.te-pill,.te-pill-arrow,.te-card-check')) return;
    // If we just did a drag, don't process as click
    if (this.tagEditorDragSelect) return;
    this.tagEditorToggleSelect(imgPath, event);
  },

  tagEditorCardDblClick(event, imgPath) {
    if (event.target.closest('input,textarea,button,.te-pill,.te-pill-arrow,.te-card-check')) return;
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
    navigator.clipboard.writeText(txt).then(function() {
      this.toast((this.t('common.copied') || 'Copied') + ' ' + tagSet.size + ' tags', 'success');
    }.bind(this)).catch(function() {
      this.toast('Copy failed', 'error');
    }.bind(this));
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
