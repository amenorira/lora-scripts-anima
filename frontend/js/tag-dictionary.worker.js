/* ================================================================
   tag-dictionary.worker.js — 词典运行时

   完整词典（9.7 万条）只存在这个 Worker 里：主线程既不解析大 JSON，
   也不持有索引。Worker 是单例，第一次真正打开 Tag Editor 时由
   tag-dictionary.js 创建，之后一直复用。

   协议（主线程 → Worker）：
     INIT        {base}                      加载 manifest + core，随后空闲加载 detail
     LOAD_DETAIL {}                          立即加载 detail（首次悬停时触发）
     LOOKUP_BATCH{id, revision, tags[]}      当前图片全部标签一次查完
     SEARCH      {id, query, limit}          补全/搜索
     DETAIL      {id, tag}                   悬停说明
   回复（Worker → 主线程）：
     READY_CORE / READY_DETAIL / FAILED / LOOKUP_RESULT / SEARCH_RESULT / DETAIL_RESULT
   ================================================================ */
importScripts('tag-dictionary-lib.js');

var TD = self.TagDictionary;
var index = null;
var manifest = null;
var baseUrl = '';
var detailState = 'idle'; // idle | loading | ready | failed
var detailTimer = null;

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.type === 'INIT') return init(msg.base);
  if (!index) return; // core 未就绪：静默丢弃，主线程会用 ready 状态自己降级
  if (msg.type === 'LOAD_DETAIL') return loadDetail();
  if (msg.type === 'LOOKUP_BATCH') return lookupBatch(msg);
  if (msg.type === 'SEARCH') return search(msg);
  if (msg.type === 'DETAIL') return detail(msg);
};

function post(message) {
  self.postMessage(message);
}

function init(base) {
  if (index) return;
  var root = String(base || '').replace(/\/?$/, '/');
  baseUrl = root;
  fetch(root + 'manifest.json', { cache: 'no-cache' })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (data) {
      if (Number(data.schema_version) !== TD.SCHEMA_VERSION) {
        throw new Error('schema ' + data.schema_version);
      }
      manifest = data;
      // 内容文件带 hash，用查询串换取一年 immutable 缓存；manifest 本身保持 revalidate
      return fetch(root + data.core + '?v=' + encodeURIComponent(data.core));
    })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (records) {
      var started = Date.now();
      index = TD.createIndex(records);
      post({
        type: 'READY_CORE',
        tagCount: index.records.length,
        dataVersion: manifest.data_version || '',
        indexMs: Date.now() - started
      });
      scheduleDetail();
    })
    .catch(function (error) {
      post({ type: 'FAILED', scope: 'core', message: String(error && error.message || error) });
    });
}

/* detail 只在 core 就绪后后台加载：先让 core 的翻译/搜索可用，
   说明文本晚一点到；用户提前悬停会直接触发加载。 */
function scheduleDetail() {
  if (detailState !== 'idle') return;
  detailTimer = setTimeout(loadDetail, 1200);
}

function loadDetail() {
  if (!index || detailState === 'loading' || detailState === 'ready') return;
  if (detailTimer) { clearTimeout(detailTimer); detailTimer = null; }
  detailState = 'loading';
  fetch(baseUrl + manifest.detail + '?v=' + encodeURIComponent(manifest.detail))
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (details) {
      index.details = details;
      detailState = 'ready';
      post({ type: 'READY_DETAIL', count: details.length });
    })
    .catch(function (error) {
      detailState = 'failed';
      post({ type: 'FAILED', scope: 'detail', message: String(error && error.message || error) });
    });
}

function lookupBatch(msg) {
  var tags = msg.tags || [];
  var results = new Array(tags.length);
  for (var i = 0; i < tags.length; i++) {
    var hit = TD.lookup(index, tags[i]);
    results[i] = hit ? TD.toResult(index, hit.id, 'canonical') : null;
  }
  post({ type: 'LOOKUP_RESULT', id: msg.id, revision: msg.revision, results: results });
}

function search(msg) {
  post({
    type: 'SEARCH_RESULT',
    id: msg.id,
    revision: msg.revision,
    results: TD.search(index, msg.query, msg.limit)
  });
}

function detail(msg) {
  var hit = TD.lookup(index, msg.tag);
  if (!hit) {
    post({ type: 'DETAIL_RESULT', id: msg.id, revision: msg.revision, result: null });
    return;
  }
  // 说明还没加载完就先返回空说明：主线程照常显示卡片，detail 到位后自己补上
  var result = TD.toResult(index, hit.id, 'canonical');
  result.description = TD.describe(index, hit.id);
  result.aliases = TD.aliasesOf(index, hit.id);
  post({ type: 'DETAIL_RESULT', id: msg.id, revision: msg.revision, result: result });
}
