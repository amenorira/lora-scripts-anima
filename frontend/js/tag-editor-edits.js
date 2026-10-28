/* Caption mutations, modified counts, undo/redo and history diffs. */
window.tagEditorEdits = {
  tagEditorHistory: [],
  tagEditorHistoryIdx: -1,
  tagEditorHistoryOpen: false,
  tagEditorHistoryDetailIdx: -1,
  _teDiffExpanded: {},
  _teDiffReorderExpanded: {},
  _teCachedDiffKey: -2,
  _teCachedDiffResult: null,
  _teHistoryState: null,
  _teEditVersions: null,
  _tePendingTextEdits: {},

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
    // Match the backend scan's occurrence counts, including repeated tags.
    var deltas = new Map();
    _teParseTags(oldTags).forEach(tag => deltas.set(tag, (deltas.get(tag) || 0) - 1));
    _teParseTags(newTags).forEach(tag => deltas.set(tag, (deltas.get(tag) || 0) + 1));
    if (![...deltas.values()].some(delta => delta !== 0)) return;
    if (!this._teFreqIndex) this._teRebuildFreqIndex();
    var freqMap = this._teFreqIndex;
    var self = this;
    deltas.forEach(function(delta, tag) {
      if (!delta) return;
      var item = freqMap.get(tag);
      if (item) item.count = Math.max(0, item.count + delta);
      else if (delta > 0) {
        var newEntry = { tag: tag, count: delta };
        self.tagEditorTagFreq.push(newEntry);
        freqMap.set(tag, newEntry);
      }
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
};
