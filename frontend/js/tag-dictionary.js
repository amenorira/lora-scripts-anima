/* ================================================================
   tag-dictionary.js — 词典主线程客户端

   职责：向后端确认词典是否已安装（未装就引导下载）、Worker 生命周期、
   请求/结果对应、图片级 revision 防串图、小型 LRU 缓存、失败降级、
   补全下拉的词典数据源。

   词典数据不进仓库：后端下载数据源并构建到 cache/tag_dictionary/，
   浏览器从 /api/tageditor/dictionary/asset/ 按静态文件加载。

   完整词典与索引只在 Worker 里；这里最多缓存"最近看过的标签"
   （查过的标签元数据 + 悬停说明），并且刻意不放进 Alpine 响应式状态
   —— 否则每次渲染都会去追踪整个缓存。UI 侧的响应式只保留一个
   版本号 tagDictionaryVersion，缓存更新后自增，模板靠它重新求值。

   词典是增强不是依赖：manifest/core 任何一步失败都只是让翻译、配色、
   词典补全和悬停说明消失，Tag Editor 本身照常工作。
   ================================================================ */

// Worker 脚本的版本号：Worker 地址带 ?v= 才会命中一年 immutable 缓存，
// 所以改了 tag-dictionary.worker.js 必须同时改这里（其余三个文件在 index.html 里带 ?v=）。
var TD_ASSET_VERSION = '20260918-tagdict1';
var TD_BASE = '/api/tageditor/dictionary/asset/';
var TD_STATUS_URL = '/api/tageditor/dictionary';
var TD_INSTALL_URL = '/api/tageditor/dictionary/install';
var TD_POLL_INTERVAL = 700;

var TD_SUGGEST_LIMIT = 20;
var TD_LOOKUP_CACHE_MAX = 2000;
var TD_DETAIL_CACHE_MAX = 100;
var TD_SYNC_DEBOUNCE = 100;
var TD_HOVER_SHOW_DELAY = 250;
var TD_HOVER_HIDE_DELAY = 120;
var TD_REQUEST_TIMEOUT = 6000;
// 说明超过这个长度才给"展开"：卡片宽 320px，短说明本来就不会被截断
var TD_HOVER_CLAMP_CHARS = 72;

var TD_CATEGORY_KEYS = {
  0: 'tagEditor.dictCatGeneral',
  1: 'tagEditor.dictCatArtist',
  3: 'tagEditor.dictCatCopyright',
  4: 'tagEditor.dictCatCharacter',
  5: 'tagEditor.dictCatMeta'
};

/* ===== 补全条目：让"数据集内已有标签"和"词典结果"共用同一个下拉 ===== */

function _teSuggestItem(insert, label, sub, category, count, alias) {
  return {
    insert: insert || '',
    label: label || insert || '',
    sub: sub || '',
    cat: category == null ? -1 : category,
    count: count || 0,
    alias: alias || ''
  };
}

/* 本地标签优先（它们来自当前数据集，最贴合用户），词典结果补在后面并按词典排序。

   两边同名时只留一条：本地写法保留（不悄悄改写数据集的写法），用词典信息把
   翻译和分类补上。本地用的是 Danbooru 下划线写法时，词典的 Anima 写法仍然保留
   一条——用户可能正想把它换成 Anima 格式。 */
function _teSuggestMerge(localTags, dictResults, limit) {
  var max = limit || TD_SUGGEST_LIMIT;
  var out = [];
  var seen = Object.create(null);
  var byName = Object.create(null);
  var i, result, key;

  for (i = 0; i < (dictResults || []).length; i++) {
    result = dictResults[i];
    byName[result.animaTag.toLowerCase()] = result;
    byName[result.canonical.toLowerCase()] = result;
  }
  for (i = 0; i < (localTags || []).length && out.length < max; i++) {
    key = String(localTags[i]).toLowerCase();
    if (!key || seen[key]) continue;
    seen[key] = 1;
    result = byName[key];
    out.push(result
      ? _teSuggestItem(localTags[i], localTags[i], result.translation, result.category, result.postCount, '')
      : _teSuggestItem(localTags[i]));
  }
  for (i = 0; i < (dictResults || []).length && out.length < max; i++) {
    result = dictResults[i];
    key = result.animaTag.toLowerCase();
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(_teSuggestItem(result.animaTag, result.animaTag, result.translation,
      result.category, result.postCount, result.alias));
  }
  return out;
}

/* ===== 单例状态（刻意放在模块作用域，不进 Alpine） ===== */

var _tdState = null;

function _td() {
  if (!_tdState) {
    _tdState = {
      worker: null,
      status: 'idle',            // idle | loading | ready | failed
      detailReady: false,
      initStarted: false,
      pollTimer: null,
      revision: 0,
      requestId: 0,
      pending: {},
      lookupRequests: {},
      lookups: new Map(),        // 标签原文 → 词典条目 | null
      inflight: Object.create(null),
      details: new Map(),        // canonical → 条目 + description
      syncTimer: null,
      suggestTimer: null,
      hoverSeq: 0,
      hoverShowTimer: null,
      hoverHideTimer: null
    };
  }
  return _tdState;
}

function _tdLruGet(cache, key) {
  if (!cache.has(key)) return undefined;
  var value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function _tdLruSet(cache, key, value, max) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

/* 请求/响应配对：Worker 挂掉时用超时兜底，绝不让 UI 一直等。 */
function _tdSend(payload, timeout) {
  var state = _td();
  if (!state.worker) return Promise.resolve(null);
  return new Promise(function (resolve) {
    var id = ++state.requestId;
    payload.id = id;
    state.pending[id] = resolve;
    state.worker.postMessage(payload);
    setTimeout(function () {
      if (!state.pending[id]) return;
      delete state.pending[id];
      resolve(null);
    }, timeout || TD_REQUEST_TIMEOUT);
  });
}

function _tdResolve(id, payload) {
  var state = _td();
  var resolve = state.pending[id];
  if (!resolve) return false;
  delete state.pending[id];
  resolve(payload);
  return true;
}

function _tdFail(ctx, scope, message) {
  var state = _td();
  if (scope === 'detail') {
    // 说明只是卡片里的一段文字，拿不到就少显示一块，词典本身照常工作
    state.detailReady = true;
    if (window.console && console.warn) console.warn('[tag-dictionary] detail', message);
    return;
  }
  state.status = 'failed';
  ctx.tagDictionaryFailed = true;
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  if (window.console && console.warn) console.warn('[tag-dictionary]', scope, message);
}

window.tagDictionaryMixin = {

  // ===== 响应式状态（都很小；词典数据不在这里）=====
  tagDictionaryReady: false,
  tagDictionaryFailed: false,
  tagDictionaryInstalling: false,
  tagDictionaryInstallError: '',
  tagDictionaryServer: null,      // 后端返回的安装状态：数据版本、标签数、体积、进度
  tagDictionaryPanelOpen: false,
  tagDictionaryDetailReady: false,
  tagDictionaryShowTranslation: true,
  tagDictionaryVersion: 0,
  tagDictionaryHover: null,

  /* 数据状态：词典文件装没装、在不在下载。环境管理页只看这个——
     那边不建 Worker，所以不能用"加载中/可用"来描述它。

     先读一次 tagDictionaryVersion：这组状态（服务器状态、安装中、错误）都靠它
     统一触发重绘，和标签元数据用的是同一个版本号。 */
  tagDictionaryDataState() {
    void this.tagDictionaryVersion;
    if (this.tagDictionaryInstalling) return 'installing';
    if (this.tagDictionaryInstallError) return 'error';
    var server = this.tagDictionaryServer;
    // 状态都问不到（后端不通）时别再显示"读取中"：那会一直转下去
    if (server === null) return this.tagDictionaryFailed ? 'failed' : 'checking';
    if (server.status === 'failed') return 'failed';
    return server.installed ? 'installed' : 'absent';
  },

  /* 标签编辑器里的界面状态：还要看当前页面有没有把 Worker 拉起来。
     未装、下载中、加载中、可用、坏掉各走各的路。 */
  tagDictionaryStatus() {
    var data = this.tagDictionaryDataState();
    if (data === 'installing' || data === 'error') return data;
    if (this.tagDictionaryFailed) return 'failed';
    if (data === 'checking' || data === 'absent'
      || (data === 'failed' && !(this.tagDictionaryServer && this.tagDictionaryServer.installed))) return data;
    if (this.tagDictionaryReady) return 'ready';
    return 'loading';
  },

  /* 数据状态的中文标签（环境管理页与顶栏面板共用） */
  tagDictionaryDataLabel() {
    var keys = {
      checking: 'dictStateChecking', absent: 'dictStateAbsent', installing: 'dictStateInstalling',
      installed: 'dictStateReady', failed: 'dictStateFailed', error: 'dictStateFailed'
    };
    return this.t('tagEditor.' + keys[this.tagDictionaryDataState()]);
  },

  /* 环境管理页的主按钮：只管数据，下载/更新/重试 */
  tagDictionaryDataActionLabel() {
    var kind = this.tagDictionaryDataState();
    if (kind === 'installed') return this.t('tagEditor.dictUpdate');
    if (kind === 'failed' || kind === 'error') return this.t('tagEditor.dictRetry');
    return this.t('tagEditor.dictInstall');
  },

  tagDictionaryDataActionVisible() {
    var kind = this.tagDictionaryDataState();
    return kind === 'installed' || kind === 'absent' || kind === 'failed' || kind === 'error';
  },

  tagDictionaryDataAction() {
    this.tagDictionaryInstallError = '';
    // 更新才重新拉数据源；只是缺构建产物时先用本地 CSV 重建，省一次 8MB 下载
    this.tagDictionaryInstall(!!(this.tagDictionaryServer && this.tagDictionaryServer.installed)
      || !!(this.tagDictionaryServer && this.tagDictionaryServer.error_kind === 'build'));
  },

  /* 进度与最近几条日志：环境管理页的行内详情用 */
  tagDictionaryLogText() {
    var log = (this.tagDictionaryServer && this.tagDictionaryServer.log) || [];
    return log.join('\n');
  },

  tagDictionaryStatusText() {
    var kind = this.tagDictionaryStatus();
    if (kind === 'installing') return this.tagDictionaryInstallText();
    if (kind === 'loading') return this.t('tagEditor.dictLoading');
    return '';
  },

  tagDictionaryInstallText() {
    var server = this.tagDictionaryServer || {};
    if (server.status === 'building') return this.t('tagEditor.dictBuilding');
    return this.t('tagEditor.dictDownloading').replace('{percent}', server.percent || 0);
  },

  tagDictionarySizeText() {
    var bytes = (this.tagDictionaryServer && this.tagDictionaryServer.size_bytes) || 0;
    return bytes ? TagDictionary.formatSize(bytes) : '';
  },

  tagDictionaryVersionText() {
    var server = this.tagDictionaryServer || {};
    if (!server.data_version) return '';
    return this.t('tagEditor.dictUpdatedAt').replace('{date}', server.data_version);
  },

  tagDictionaryStateLabel() {
    var kind = this.tagDictionaryStatus();
    if (kind === 'loading') return this.t('tagEditor.dictStateLoading');
    return this.tagDictionaryDataLabel();
  },

  /* 面板只有一个主按钮：状态不同含义不同，避免摆一排按钮让人挑 */
  tagDictionaryActionVisible() {
    var kind = this.tagDictionaryStatus();
    return kind === 'ready' || kind === 'absent' || kind === 'failed';
  },

  tagDictionaryActionLabel() {
    var kind = this.tagDictionaryStatus();
    if (kind === 'ready') return this.t('tagEditor.dictUpdate');
    if (kind === 'failed') return this.t('tagEditor.dictRetry');
    return this.t('tagEditor.dictInstall');
  },

  tagDictionaryPrimaryAction() {
    var kind = this.tagDictionaryStatus();
    this.tagDictionaryInstallError = '';
    // 已安装却不可用（资源坏了 / 上次加载失败）：先重拉 Worker，别急着再下一次
    if (kind === 'failed' && this.tagDictionaryServer && this.tagDictionaryServer.installed) {
      this._tdRestartWorker();
      return;
    }
    this.tagDictionaryInstall(true);
  },

  tagDictionaryTagCountText() {
    var count = (this.tagDictionaryServer && this.tagDictionaryServer.tag_count) || 0;
    return count ? this.t('tagEditor.dictTagCount').replace('{n}', count) : '';
  },

  /* 查一次安装状态（环境管理页与标签编辑器都会调，重复调用无副作用）。
     只查状态不建 Worker：Worker 要 9MB 词典，只该在真正用它的时候拉。 */
  tagDictionaryInit() {
    var state = _td();
    if (state.initStarted) return;
    state.initStarted = true;
    this.tagDictionaryShowTranslation = this._tdReadTranslationPref();
    var self = this;
    this.tagDictionaryRefreshStatus().then(function (status) {
      if (!status) {
        // 状态都问不到（后端不通）：当作词典不可用，标签编辑器照常工作
        self.tagDictionaryFailed = true;
        return;
      }
      if (status.status === 'downloading' || status.status === 'building') self._tdPollInstall();
      else if (status.installed) self._tdStartWorkerForRoute();
    });
  },

  /* 标签编辑器专用：数据已装就拉起 Worker（没装就什么都不做） */
  tagDictionaryEnsureWorker() {
    var server = this.tagDictionaryServer;
    if (server && server.installed) this._tdStartWorker();
  },

  tagDictionaryRefreshStatus() {
    var self = this;
    return fetch(TD_STATUS_URL)
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload || payload.status !== 'success') return null;
        self.tagDictionaryServer = payload.data;
        if (payload.data.status === 'downloading' || payload.data.status === 'building') {
          self.tagDictionaryInstalling = true;
        }
        self.tagDictionaryVersion++;
        self._tdRefreshPanelRow();
        return payload.data;
      })
      .catch(function () { return null; });
  },

  // ===== 下载与更新 =====
  tagDictionaryInstall(force) {
    if (this.tagDictionaryInstalling) return;
    var self = this;
    this.tagDictionaryInstallError = '';
    this.tagDictionaryInstalling = true;
    fetch(TD_INSTALL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!force })
    })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload || payload.status !== 'success') {
          throw new Error((payload && payload.message) || 'install failed');
        }
        if (payload.data && payload.data.status) self.tagDictionaryServer = payload.data.status;
        self._tdPollInstall();
      })
      .catch(function (error) {
        self.tagDictionaryInstalling = false;
        self.tagDictionaryInstallError = String((error && error.message) || error);
        self.tagDictionaryVersion++;
        self._tdRefreshPanelRow();
      });
  },

  /* 安装进度靠轮询：后端在下载/构建期间只更新内存状态，
     完成后这里再重新拉起 Worker（顺带丢掉旧索引与旧缓存）。 */
  _tdPollInstall() {
    var state = _td();
    if (state.pollTimer) return;
    var self = this;
    state.pollTimer = setInterval(function () {
      self.tagDictionaryRefreshStatus().then(function (status) {
        if (!status) return;
        if (status.status === 'downloading' || status.status === 'building') return;
        self._tdStopPollInstall();
        self.tagDictionaryInstalling = false;
        self.tagDictionaryVersion++;
        self._tdRefreshPanelRow();
        if (status.installed) {
          self._tdRestartWorker();
          if (self.tagDictionaryPanelOpen) self.tagDictionaryPanelOpen = false;
        } else {
          self.tagDictionaryInstallError = status.message || self.t('tagEditor.dictInstallFailed');
        }
      });
    }, TD_POLL_INTERVAL);
  },

  /* 环境管理页的行由 environment-render 渲染成字符串：状态一变就让它重画一次。
     同步调用 renderEnvironment（不用 scheduleEnvironmentRender——那里走 rAF，
     后台标签页里可能不触发）。 */
  _tdRefreshPanelRow() {
    if (this.currentRoute !== 'environment') return;
    if (typeof this.renderEnvironment === 'function') this.renderEnvironment();
  },

  _tdStopPollInstall() {
    var state = _td();
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  },

  /* 只有真的要看译文时才建 Worker：在环境管理页装完词典不该顺手拉 9MB 数据 */
  _tdStartWorkerForRoute() {
    if (this.currentRoute === 'tagEditor') this._tdStartWorker();
  },

  /* 更新完词典或上次加载失败时重新拉起 Worker */
  _tdRestartWorker() {
    var state = _td();
    this._tdStopPollInstall();
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    state.status = 'idle';
    state.detailReady = false;
    state.lookups.clear();
    state.details.clear();
    this.tagDictionaryReady = false;
    this.tagDictionaryFailed = false;
    this.tagDictionaryDetailReady = false;
    this.tagDictionaryVersion++;
    this._tdStartWorkerForRoute();
  },

  _tdStartWorker() {
    var state = _td();
    if (state.worker || state.status === 'loading') return;
    this.tagDictionaryShowTranslation = this._tdReadTranslationPref();
    if (typeof Worker !== 'function') {
      this.tagDictionaryFailed = true;
      state.status = 'failed';
      return;
    }
    state.status = 'loading';
    var self = this;
    try {
      state.worker = new Worker('/anima-ui/js/tag-dictionary.worker.js?v=' + TD_ASSET_VERSION);
    } catch (e) {
      this.tagDictionaryFailed = true;
      state.status = 'failed';
      return;
    }
    state.worker.onmessage = function (event) { self._tdHandleMessage(event.data); };
    state.worker.onerror = function (event) { _tdFail(self, 'worker', event && event.message); };
    state.worker.postMessage({ type: 'INIT', base: TD_BASE });
    if (window.tagHoverCard) window.tagHoverCard.attach(this);
  },

  _tdReadTranslationPref() {
    try {
      var saved = localStorage.getItem('tagEditor_showTranslation');
      return saved === null ? true : saved === '1';
    } catch (e) { return true; }
  },

  _tdHandleMessage(msg) {
    if (!msg) return;
    var state = _td();
    if (msg.type === 'READY_CORE') {
      state.status = 'ready';
      this.tagDictionaryReady = true;
      this.tagDictionaryVersion++;
      this.tagDictionarySyncChips();
      return;
    }
    if (msg.type === 'READY_DETAIL') {
      state.detailReady = true;
      this.tagDictionaryDetailReady = true;
      state.details.clear();
      this._tdRefreshHover();
      return;
    }
    if (msg.type === 'FAILED') {
      _tdFail(this, msg.scope, msg.message);
      return;
    }
    if (msg.type === 'LOOKUP_RESULT') {
      var request = state.lookupRequests[msg.id];
      delete state.lookupRequests[msg.id];
      if (!request) return;
      var tags = request.tags || [];
      for (var i = 0; i < tags.length; i++) delete state.inflight[tags[i]];
      // 旧一轮图片的结果直接丢弃，避免覆盖当前图片的元数据
      if (msg.revision !== state.revision) return;
      var results = msg.results || [];
      for (var j = 0; j < tags.length; j++) {
        _tdLruSet(state.lookups, tags[j], results[j] || null, TD_LOOKUP_CACHE_MAX);
      }
      this.tagDictionaryVersion++;
      this.tagDictionarySyncChips();
      return;
    }
    if (msg.type === 'SEARCH_RESULT') {
      _tdResolve(msg.id, msg.results);
      return;
    }
    if (msg.type === 'DETAIL_RESULT') {
      _tdResolve(msg.id, msg.result || null);
      return;
    }
  },

  /* chip 上的词典元数据。读一次版本号以建立响应式依赖：缓存更新后模板重新求值。 */
  tagDictionaryMetaFor(tag) {
    void this.tagDictionaryVersion;
    if (!this.tagDictionaryReady) return null;
    return _tdLruGet(_td().lookups, tag) || null;
  },

  // ===== 展示辅助（模板只拿 class 与字符串，不碰词典结构）=====
  tagDictionaryCategoryClass(category) {
    if (category == null || category < 0) return '';
    return 'te-dict-cat-' + TagDictionary.categoryName(category);
  },

  tagDictionaryCategoryLabel(category) {
    var key = TD_CATEGORY_KEYS[category];
    return key ? this.t(key) : '';
  },

  /* chip 的分类色 class。Alpine 的 :class 数组会用 join(' ') 拼字符串，
     对象必须并进同一个对象里（见 index.html 里的 Object.assign），不能塞进数组。 */
  tagDictionaryChipState(tag) {
    var meta = this.tagDictionaryMetaFor(tag);
    if (!meta) return {};
    var state = {};
    state['te-dict-cat-' + TagDictionary.categoryName(meta.category)] = true;
    return state;
  },

  /* 中文副标题：关掉开关就返回空串，chip 上那一行由 CSS :empty 收起。 */
  tagDictionaryTranslationFor(tag) {
    if (!this.tagDictionaryShowTranslation) return '';
    var meta = this.tagDictionaryMetaFor(tag);
    var translation = (meta && meta.translation) || '';
    // 跟标签本身一样就不重复显示（中文标注的数据集里会撞上）
    return translation === tag ? '' : translation;
  },

  tagDictionaryHoverAliases() {
    var hover = this.tagDictionaryHover;
    var aliases = hover && hover.meta && hover.meta.aliases;
    return aliases && aliases.length ? aliases.join(' · ') : '';
  },

  tagDictionaryHoverExpandable() {
    var hover = this.tagDictionaryHover;
    return !!(hover && hover.description && hover.description.length > TD_HOVER_CLAMP_CHARS);
  },

  tagDictionaryFormatCount(value) {
    return TagDictionary.formatCount(value);
  },

  /* 当前图片的全部标签一次查完。切图/改标签都会走这里：
     先把 revision 推进（在途结果立刻作废），再攒一小段时间合并连续编辑。 */
  tagDictionarySyncChips() {
    if (!this.tagDictionaryReady) return;
    var state = _td();
    state.revision++;
    var self = this;
    if (state.syncTimer) clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(function () {
      state.syncTimer = null;
      self._tdRequestChips();
    }, TD_SYNC_DEBOUNCE);
  },

  _tdRequestChips() {
    if (!this.tagDictionaryReady) return;
    var state = _td();
    var tags = typeof this.tagEditorGetSelectedTags === 'function' ? this.tagEditorGetSelectedTags() : [];
    var missing = [];
    for (var i = 0; i < tags.length; i++) {
      if (!state.lookups.has(tags[i]) && !state.inflight[tags[i]]) missing.push(tags[i]);
    }
    if (!missing.length) return;
    for (var j = 0; j < missing.length; j++) state.inflight[missing[j]] = true;
    var id = ++state.requestId;
    state.lookupRequests[id] = { tags: missing };
    state.worker.postMessage({ type: 'LOOKUP_BATCH', id: id, revision: state.revision, tags: missing });
  },

  /* 补全下拉的词典部分。本地标签由 tag-editor.js 先给出，这里异步补词典结果，
     旧输入的结果不能覆盖新输入（seq 守卫）。 */
  tagDictionarySuggest(token, seq, inputEl) {
    if (!this.tagDictionaryReady) return;
    var state = _td();
    if (state.suggestTimer) clearTimeout(state.suggestTimer);
    var self = this;
    state.suggestTimer = setTimeout(function () {
      state.suggestTimer = null;
      self.tagDictionarySearch(token, TD_SUGGEST_LIMIT).then(function (results) {
        if (seq !== self._teSuggestSeq || !results) return;
        self._teApplyDictSuggestions(token, seq, results, inputEl);
      });
    }, 140);
  },

  tagDictionarySearch(query, limit) {
    if (!this.tagDictionaryReady) return Promise.resolve(null);
    return _tdSend({ type: 'SEARCH', query: query, limit: limit || TD_SUGGEST_LIMIT }, 4000);
  },

  /* 悬停说明：先给出缓存里的部分，再补 detail。 */
  tagDictionaryDetail(tag) {
    var state = _td();
    var hit = _tdLruGet(state.lookups, tag);
    var key = hit && hit.canonical;
    if (key && state.details.has(key)) return Promise.resolve(_tdLruGet(state.details, key));
    if (!this.tagDictionaryReady) return Promise.resolve(null);
    return _tdSend({ type: 'DETAIL', tag: tag }, 4000).then(function (result) {
      if (result && result.canonical) _tdLruSet(state.details, result.canonical, result, TD_DETAIL_CACHE_MAX);
      return result;
    });
  },

  // ===== 悬停卡 =====
  tagDictionaryHoverEnter(tag, el) {
    if (!this.tagDictionaryReady || !tag) return;
    var state = _td();
    this.tagDictionaryCancelHoverTimers();
    var self = this;
    state.hoverShowTimer = setTimeout(function () {
      state.hoverShowTimer = null;
      self._tdShowHover(tag, el);
    }, TD_HOVER_SHOW_DELAY);
  },

  tagDictionaryHoverLeave() {
    var state = _td();
    if (state.hoverShowTimer) { clearTimeout(state.hoverShowTimer); state.hoverShowTimer = null; }
    if (!this.tagDictionaryHover) return;
    var self = this;
    if (state.hoverHideTimer) clearTimeout(state.hoverHideTimer);
    state.hoverHideTimer = setTimeout(function () {
      state.hoverHideTimer = null;
      self.tagDictionaryCloseHover();
    }, TD_HOVER_HIDE_DELAY);
  },

  /* 鼠标进入卡片：取消关闭，否则卡里的"复制/查找"点不到。 */
  tagDictionaryHoverKeep() {
    var state = _td();
    if (state.hoverHideTimer) { clearTimeout(state.hoverHideTimer); state.hoverHideTimer = null; }
  },

  tagDictionaryCancelHoverTimers() {
    var state = _td();
    if (state.hoverShowTimer) { clearTimeout(state.hoverShowTimer); state.hoverShowTimer = null; }
    if (state.hoverHideTimer) { clearTimeout(state.hoverHideTimer); state.hoverHideTimer = null; }
  },

  _tdShowHover(tag, el) {
    var state = _td();
    if (!this.tagDictionaryReady) return;
    // 说明还没加载就现在拉一把，别让用户盯着没有说明的卡片等后台计时
    if (!state.detailReady && state.worker) state.worker.postMessage({ type: 'LOAD_DETAIL' });
    // 已知词典里没有这个标签（自定义 trigger / 自然语言）：不弹空卡片
    var meta = _tdLruGet(state.lookups, tag);
    if (state.lookups.has(tag) && !meta) return;
    var self = this;
    var seq = ++state.hoverSeq;
    this.tagDictionaryHover = {
      tag: tag,
      meta: meta || null,
      description: '',
      expanded: false,
      loading: true,
      style: this._tdHoverStyle(el)
    };
    this.tagDictionaryDetail(tag).then(function (result) {
      if (seq !== state.hoverSeq || !self.tagDictionaryHover) return;
      var current = self.tagDictionaryHover;
      if (current.tag !== tag) return;
      self.tagDictionaryHover = {
        tag: tag,
        meta: (result && result.canonical) ? result : current.meta,
        description: (result && result.description) || '',
        expanded: current.expanded,
        loading: false,
        style: current.style
      };
    });
  },

  /* detail 晚到时刷新已打开的卡片，不改变位置。 */
  _tdRefreshHover() {
    var hover = this.tagDictionaryHover;
    if (!hover || !hover.meta || hover.description) return;
    var self = this;
    var state = _td();
    var seq = state.hoverSeq;
    this.tagDictionaryDetail(hover.tag).then(function (result) {
      if (seq !== state.hoverSeq || !self.tagDictionaryHover) return;
      if (!result || !result.description) return;
      var current = self.tagDictionaryHover;
      if (current.tag !== hover.tag) return;
      self.tagDictionaryHover = {
        tag: current.tag,
        meta: result,
        description: result.description,
        expanded: current.expanded,
        loading: false,
        style: current.style
      };
    });
  },

  tagDictionaryCloseHover() {
    var state = _td();
    state.hoverSeq++;
    this.tagDictionaryCancelHoverTimers();
    this.tagDictionaryHover = null;
  },

  tagDictionaryToggleHoverExpand() {
    var hover = this.tagDictionaryHover;
    if (!hover) return;
    this.tagDictionaryHover = {
      tag: hover.tag,
      meta: hover.meta,
      description: hover.description,
      expanded: !hover.expanded,
      loading: hover.loading,
      style: hover.style
    };
  },

  /* 悬停卡定位：优先贴在标签左侧（右侧面板本来就贴着窗口右边），
     放不下就翻到右侧，最后按视口夹住。 */
  _tdHoverStyle(el) {
    var margin = 8;
    var gap = 10;
    var width = Math.min(320, Math.max(240, window.innerWidth - margin * 2));
    var maxHeight = Math.min(380, window.innerHeight - margin * 2);
    var rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 80, bottom: 100, left: 0, right: 0 };
    var left = rect.left - width - gap;
    if (left < margin) left = Math.min(rect.right + gap, window.innerWidth - width - margin);
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    var top = Math.max(margin, Math.min(rect.top, window.innerHeight - maxHeight - margin));
    return 'left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px;width:' + Math.round(width) +
      'px;max-height:' + Math.round(maxHeight) + 'px';
  },

  /* 悬停卡/卡片操作：复制的是当前 caption 里的真实值，不是 canonical。 */
  tagDictionaryCopy(tag) {
    if (!tag) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tag).catch(function () {});
    }
    this.toast(this.t('tagEditor.singleTagCopied').replace('{tag}', tag));
    this.tagDictionaryCloseHover();
  },

  /* 查找此标签：复用标签云的精确 token 过滤，不做字符串包含匹配。 */
  tagDictionaryFindTag(tag) {
    if (!tag) return;
    this.tagDictionaryCloseHover();
    if (this.tagEditorTagSelection.indexOf(tag) === -1) this.tagEditorTagSelection.push(tag);
    var excluded = this.tagEditorExcludedTags.filter(function (item) { return item !== tag; });
    this.tagEditorExcludedTags = excluded;
    this.tagEditorSidebarTab = 'tags';
    this.tagEditorSearchQuery = '';
    this._teInvalidateFilter();
    this.tagEditorSchedulePageFetch(true);
  },

  tagDictionaryToggleTranslation() {
    this.tagDictionaryShowTranslation = !this.tagDictionaryShowTranslation;
    try {
      localStorage.setItem('tagEditor_showTranslation', this.tagDictionaryShowTranslation ? '1' : '0');
    } catch (e) { /* 存不了就用当前会话 */ }
  },

  tagDictionaryCleanup() {
    var state = _td();
    this._tdStopPollInstall();
    this.tagDictionaryPanelOpen = false;
    this.tagDictionaryCloseHover();
    if (state.syncTimer) { clearTimeout(state.syncTimer); state.syncTimer = null; }
    if (state.suggestTimer) { clearTimeout(state.suggestTimer); state.suggestTimer = null; }
  }
};
