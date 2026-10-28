/* ================================================================
   tag-editor.js — Module composition, shared state, lifecycle and selection
   Modules keep the public Alpine bindings used by the three-column template.
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
  // ===== Core State =====
  tagEditorDir: '',
  tagEditorRecursive: true,
  tagEditorImages: [],
  tagEditorOriginal: {},
  tagEditorModified: false,
  tagEditorTagFreq: [],
  tagEditorMaxFreq: 0,
  tagEditorLoading: false,
  tagEditorLoadedDir: '',
  tagEditorPendingDir: '',
  tagEditorOpenPath: '',
  tagEditorSwitchOpen: false,

  // ===== Selection & Grid =====
  tagEditorSelected: [],
  tagEditorPage: 1,
  tagEditorPageSize: 60,
  tagEditorGroupByDir: false,
  tagEditorContextMenu: null,
  tagEditorImageContextMenu: null,
  tagEditorLeftCollapsed: false,
  _teLastSelected: null,
  _teNavRequest: 0,

  // ===== Right Panel Editor =====
  tagEditorWorkMode: 'tags',
  tagEditorRequestedMode: '',
  _teModeEpoch: 0,
  tagEditorDetailView: 'chip',
  tagEditorDetailText: '',
  tagEditorAddInput: '',

  // ===== Sidebar Tabs =====
  tagEditorSidebarTab: 'tags',

  tagEditorShortcutsOpen: false,

  // ===== Cache =====
  _teCachedSelectedStatsKey: '',
  _teCachedSelectedStats: null,
  _teModifiedCount: 0,
  _tePathIndex: null,
  _teFreqIndex: null,
  _teFreqFinalizeScheduled: false,
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

window.composeAppMixins(window.tagEditorMixin, {
  filters: window.tagEditorFilters, actions: window.tagEditorActions, view: window.tagEditorView,
  persistence: window.tagEditorPersistence, edits: window.tagEditorEdits, session: window.tagEditorSession,
});
