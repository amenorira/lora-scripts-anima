/* Search, sorting, directory grouping, tag-cloud filters and paging display. */
window.tagEditorFilters = {
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
  _teFilteredCacheKey: '',
  _teFreqCacheKey: '',
  _teCachedFiltered: null,
  _teCachedFreqResult: null,
  _teSearchDebounce: null,
  _teTagSearchDebounce: null,
  _teQuickCountNoTag: undefined,
  _teQuickCountMod: undefined,

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
};
