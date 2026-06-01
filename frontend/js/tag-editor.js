/* ================================================================
   tag-editor.js — Native Tag Editor v2.1
   Alpine.js mixin: preview modal, sort, keyboard shortcuts,
   tag autocomplete, token counter, undo history
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
  tagEditorBatchScope: 'all',
  tagEditorBatchVal: '',
  tagEditorBatchVal2: '',
  tagEditorTagLogic: 'AND',

  // ── New State ──────────────────────────────────────────
  tagEditorLoading: false,
  tagEditorSortBy: 'name',       // name | tags | modified
  tagEditorSortAsc: true,
  tagEditorPreviewImg: null,     // image object for preview modal
  tagEditorPreviewTags: '',      // editable tags in preview
  tagEditorDetailMode: false,    // split-screen detail view
  tagEditorDetailIdx: 0,         // current image index in detail
  tagEditorDetailView: 'chip',   // chip | text
  tagEditorTagSortBy: 'freq',    // freq | alpha | length
  tagEditorTagSortAsc: false,
  tagEditorTagCloudLimit: 200,    // 标签云最大显示数量
  tagEditorTagCloudExpanded: false, // 是否展开显示全部
  tagEditorHistory: [],          // undo stack [{path, oldTags, newTags}]
  tagEditorHistoryIdx: -1,
  tagEditorQuickFilter: 'all',   // all | notag | modified
  tagEditorFocusedImg: null,     // imgPath for autocomplete dropdown
  tagEditorFocusedVal: '',       // current input value for suggestions

  // ── Lifecycle ──────────────────────────────────────────
  async tagEditorLoad(dir) {
    var d = dir || this.tagEditorDir || (this.form && this.form.train_data_dir) || '';
    if (!d) { this.toast(this.t('common.specifyDir') || 'Please specify a directory', 'warning'); return; }
    this.tagEditorDir = d;
    this.tagEditorLoading = true;
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
        await this.tagEditorLoadTagFreq();
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
    var orig = this.tagEditorOriginal;
    var images = this.tagEditorImages.filter(function(img) {
      return orig[img.path] !== undefined && orig[img.path] !== img.tags;
    }).map(function(img) { return { path: img.path, tags: img.tags }; });
    if (images.length === 0) { this.tagEditorModified = false; return; }
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
        self.toast((self.t('common.saved') || 'Saved') + ' (' + (j.data.saved || 0) + ')', 'success');
      } else { self.toast(j.message || 'Save failed', 'error'); }
    }).catch(function(e) { self.toast('Save failed: ' + e, 'error'); })
      .finally(function() { self.finishProgress(); });
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
    this.tagEditorHistory.push({ path: imgPath, oldTags: oldTags, newTags: newTags });
    this.tagEditorHistoryIdx = this.tagEditorHistory.length - 1;
    if (this.tagEditorHistory.length > 200) { this.tagEditorHistory.shift(); this.tagEditorHistoryIdx--; }
  },

  tagEditorUndo() {
    if (this.tagEditorHistoryIdx < 0) return;
    var entry = this.tagEditorHistory[this.tagEditorHistoryIdx];
    var img = this.tagEditorImages.find(function(i) { return i.path === entry.path; });
    if (img) { img.tags = entry.oldTags; this.tagEditorModified = true; }
    this.tagEditorHistoryIdx--;
  },

  tagEditorRedo() {
    if (this.tagEditorHistoryIdx >= this.tagEditorHistory.length - 1) return;
    this.tagEditorHistoryIdx++;
    var entry = this.tagEditorHistory[this.tagEditorHistoryIdx];
    var img = this.tagEditorImages.find(function(i) { return i.path === entry.path; });
    if (img) { img.tags = entry.newTags; this.tagEditorModified = true; }
  },

  // ── Filtering, Sorting & Pagination ────────────────────
  tagEditorGetFiltered() {
    var imgs = this.tagEditorImages;
    var q = (this.tagEditorSearchQuery || '').toLowerCase().trim();
    var sel = this.tagEditorTagSelection || [];
    var exc = this.tagEditorExcludedTags || [];
    var logic = this.tagEditorTagLogic || 'AND';
    var qf = this.tagEditorQuickFilter || 'all';

    if (q) {
      imgs = imgs.filter(function(img) {
        return (img.name && img.name.toLowerCase().indexOf(q) !== -1) ||
               (img.tags && img.tags.toLowerCase().indexOf(q) !== -1);
      });
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
    if (this.tagEditorTagCloudExpanded) return freq;
    return freq.slice(0, this.tagEditorTagCloudLimit);
  },
  tagEditorHasMoreTags() {
    return this.tagEditorGetFilteredTagFreq().length > this.tagEditorTagCloudLimit;
  },
  tagEditorIsTagSelected(tag) { return this.tagEditorTagSelection.indexOf(tag) !== -1; },
  tagEditorIsTagExcluded(tag) { return this.tagEditorExcludedTags.indexOf(tag) !== -1; },

  // ── Image Selection ────────────────────────────────────
  tagEditorIsSelected(p) { return this.tagEditorSelected.indexOf(p) !== -1; },
  tagEditorToggleSelect(p) {
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

  // ── Tag Editing (with undo) ────────────────────────────
  tagEditorRemoveTag(imgPath, tag) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    var tagList = img.tags.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t && t !== tag; });
    img.tags = tagList.join(', ');
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, img.tags);
    this.tagEditorRefreshTagFreq();
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
    this.tagEditorRefreshTagFreq();
  },

  tagEditorHandleTagInput(event, imgPath) {
    if (event.key !== 'Enter') return;
    var val = event.target.value.trim();
    if (!val) return;
    var self = this;
    val.split(',').forEach(function(t) { self.tagEditorAddTagToImage(imgPath, t.trim()); });
    event.target.value = '';
    this.tagEditorFocusedVal = '';
  },

  tagEditorMarkDirty() { this.tagEditorModified = true; },

  tagEditorUpdateTagsText(imgPath, newTags) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    img.tags = newTags;
    this.tagEditorModified = true;
    this._tePushHistory(imgPath, oldTags, newTags);
    this.tagEditorRefreshTagFreq();
  },

  // ── Token Counter ──────────────────────────────────────
  tagEditorTokenCount(tags) {
    if (!tags) return 0;
    return tags.split(',').filter(function(t) { return t.trim(); }).length;
  },

  // ── Detail View (split-screen, like AnimaLoraStudio) ───
  tagEditorOpenDetail(imgPath) {
    var filtered = this.tagEditorGetFiltered();
    var idx = filtered.findIndex(function(i) { return i.path === imgPath; });
    if (idx === -1) return;
    this.tagEditorDetailIdx = idx;
    this.tagEditorDetailMode = true;
    this.tagEditorDetailView = 'chip';
  },
  tagEditorCloseDetail() {
    this.tagEditorDetailMode = false;
  },
  tagEditorDetailImg() {
    var filtered = this.tagEditorGetFiltered();
    return filtered[this.tagEditorDetailIdx] || null;
  },
  tagEditorDetailPrev() {
    if (this.tagEditorDetailIdx > 0) this.tagEditorDetailIdx--;
  },
  tagEditorDetailNext() {
    var filtered = this.tagEditorGetFiltered();
    if (this.tagEditorDetailIdx < filtered.length - 1) this.tagEditorDetailIdx++;
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
    var oldTags = img.tags;
    img.tags = event.target.value;
    this.tagEditorModified = true;
    this._tePushHistory(img.path, oldTags, img.tags);
    this.tagEditorRefreshTagFreq();
  },

  // ── Keyboard Shortcuts ─────────────────────────────────
  tagEditorKeydown(e) {
    if (!this.tagEditorImages.length) return;
    var inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 's') { e.preventDefault(); this.tagEditorSaveAll(); }
      else if (e.key === 'z') { e.preventDefault(); if (e.shiftKey) this.tagEditorRedo(); else this.tagEditorUndo(); }
      else if (e.key === 'a' && !inInput) { e.preventDefault(); this.tagEditorSelectAll(); }
    }
    if (this.tagEditorDetailMode && !inInput) {
      if (e.key === 'Escape') { this.tagEditorCloseDetail(); }
      else if (e.key === 'ArrowLeft') { this.tagEditorDetailPrev(); }
      else if (e.key === 'ArrowRight') { this.tagEditorDetailNext(); }
    }
  },

  // ── Batch Operations ───────────────────────────────────
  async tagEditorBatchOp(op) {
    var args = {};
    var needsVal = ['add_prefix', 'add_suffix', 'delete_tag', 'inject_trigger', 'remove_trigger'].indexOf(op) !== -1;
    var needsFind = op === 'find_replace' || op === 'regex_replace';
    if (needsVal && !this.tagEditorBatchVal) { this.toast(this.t('tagEditor.batchPlaceholder') || 'Enter a value', 'warning'); return; }
    if (needsFind && !this.tagEditorBatchVal) { this.toast(this.t('tagEditor.batchPlaceholder') || 'Enter find text', 'warning'); return; }

    if (op === 'find_replace') { args.find = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else if (op === 'regex_replace') { args.pattern = this.tagEditorBatchVal; args.replace = this.tagEditorBatchVal2 || ''; }
    else { args.value = this.tagEditorBatchVal; }

    var scope = this.tagEditorBatchScope;
    var count = scope === 'all' ? this.tagEditorImages.length : scope === 'selected' ? this.tagEditorSelected.length : this.tagEditorGetFiltered().length;
    var scopeLabel = scope === 'all' ? (this.t('tagEditor.scopeAll') || 'All') : scope === 'selected' ? (this.t('tagEditor.scopeSelected') || 'Selected') : (this.t('tagEditor.scopeFiltered') || 'Filtered');
    if (!confirm((this.t('tagEditor.batchConfirm') || 'Apply') + ' [' + op + '] ' + (this.t('tagEditor.batchConfirmOn') || 'to') + ' ' + count + ' ' + (this.t('tagEditor.imageCount') || 'images') + ' (' + scopeLabel + ')?')) return;

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
        this.tagEditorLoad(this.tagEditorDir);
      } else { this.toast(j.message || 'Operation failed', 'error'); }
    } catch (e) { this.toast('Operation failed: ' + e, 'error'); }
  },

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

  // ── No-tag count ───────────────────────────────────────
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
    setTimeout(function() { self.tagEditorFocusedImg = null; self.tagEditorFocusedVal = ''; }, 200);
  },

  // ── Tag Reorder (move left/right) ─────────────────────
  tagEditorMoveTag(imgPath, tag, direction) {
    var img = this.tagEditorImages.find(function(i) { return i.path === imgPath; });
    if (!img) return;
    var oldTags = img.tags;
    var tags = img.tags.split(',').map(function(t) { return t.trim(); });
    // Use index from the x-for loop context: find the tag position more reliably
    // by matching the exact tag string and its surrounding context
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
};
