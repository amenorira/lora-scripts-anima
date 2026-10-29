/* Single-image edits, context menus, clipboard and batch transformations. */
window.tagEditorActions = {
  tagEditorPanelMenu: null,
  _tePanelMenuTrigger: null,
  _teTagMenuTrigger: null,
  _teImageMenuTrigger: null,
  _teMenuFocusRequest: 0,
  tagEditorQuickRemove: false,
  tagEditorRemovalTags: [],
  tagEditorInlineEdit: null,
  tagEditorDetailDragOverIdx: -1,
  tagEditorDetailDragSrcIdx: -1,
  tagEditorDetailDragOverPos: '',
  tagEditorBatchMode: 'add',
  tagEditorBatchTagFilter: 'all',
  batchAddInput: '',
  batchRemoveInput: '',
  batchOldTag: '',
  batchNewTag: '',
  tagEditorBatchPos: 'front',
  tagEditorCopiedTags: [],

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
      this._tePushHistory({ type: 'add', desc: '+ ' + this.t('tagEditor.dictTagCount').replace('{n}', added.length) + ' · ' + this._teImageLabel(img), affected: 1 });
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
};
