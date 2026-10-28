/* Panel layout, image lightbox and autocomplete presentation. */
window.tagEditorView = {
  tagEditorRightWidth: 340,
  tagEditorLeftWidth: 260,
  _teLayoutWidth: 0,
  tagEditorCompactLayout: false,
  _teResizeSide: 'right',
  tagEditorPreviewRatio: 0.5,
  _tePreviewDrag: null,
  tagEditorResizing: false,
  _teGridResizeObserver: null,
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
};
