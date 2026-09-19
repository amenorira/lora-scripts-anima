// Run from the repository root: node --test tests/frontend/*.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const LIB = path.join(__dirname, '../../frontend/js/tag-dictionary-lib.js');
const CLIENT = path.join(__dirname, '../../frontend/js/tag-dictionary.js');

function loadLib() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(LIB, 'utf8'), context);
  return context.window.TagDictionary;
}

/* 词典记录的顺序就是图片数降序：id 升序 == 热门度降序，搜索排序依赖这个前提 */
const FIXTURE = [
  ['absurdly_long_hair', '超长发发型', 0, 9000000, ''],
  ['solo', '单人', 0, 6984063, 'alone'],
  ['long_hair', '长发', 0, 6134076, 'longhair|长髪'],
  ['black_hair', '黑发', 0, 2174401, '黑毛'],
  ['very_long_hair', '超长头发', 0, 1397857, ''],
  ['long_hair_between_eyes', '眼间长刘海', 0, 22141, ''],
  ['dairi', 'ダイリ', 1, 18783, 'dairi155'],
  ['hatsune_miku_(append)', '初音未来（追加）', 4, 1200, ''],
  ['long_dress', '长裙', 0, 1000, ''],
  ['some_artist', '', 1, 800, '']
];

function fixtureIndex(TD) {
  for (let i = 1; i < FIXTURE.length; i++) {
    assert.ok(FIXTURE[i - 1][3] >= FIXTURE[i][3], 'fixture 必须按图片数降序');
  }
  return TD.createIndex(FIXTURE, FIXTURE.map(() => ''));
}

/* vm 上下文里创建的数组属于另一个 realm，assert/strict 会比较原型，统一拷回本 realm */
function plain(value) {
  return Array.from(value);
}

function names(results) {
  return plain(results).map(item => item.canonical);
}

test('formatter follows Anima rules without escaping', () => {
  const TD = loadLib();
  const tag = (canonical, category) => TD.danbooruToAnimaTag(canonical, category);
  assert.equal(tag('long_hair', 0), 'long hair');
  assert.equal(tag('looking_at_viewer', 0), 'looking at viewer');
  assert.equal(tag('hatsune_miku', 4), 'hatsune miku');
  assert.equal(tag('hatsune_miku_(append)', 4), 'hatsune miku (append)');
  assert.equal(tag('fur-trimmed_gloves', 0), 'fur-trimmed gloves');
  assert.equal(tag('foo/bar_baz', 0), 'foo/bar baz');
  // 括号保持原样：这是训练 caption，不是 A1111 prompt，不做转义
  assert.equal(tag('foo_(bar)', 0), 'foo (bar)');
  for (let score = 1; score <= 9; score++) {
    assert.equal(tag(`score_${score}`, 0), `score_${score}`);
  }
  assert.equal(tag('score_10', 0), 'score 10');
});

test('artist tags get a single @ prefix', () => {
  const TD = loadLib();
  assert.equal(TD.danbooruToAnimaTag('some_artist', 1), '@some artist');
  assert.equal(TD.danbooruToAnimaTag('@some_artist', 1), '@some artist');
  assert.equal(TD.danbooruToAnimaTag('some_artist', 0), 'some artist');
});

test('reverse lookup recognizes canonical, anima, translated and alias forms', () => {
  const TD = loadLib();
  assert.deepEqual(plain(TD.lookupKeys('long_hair')), ['long_hair']);
  assert.deepEqual(plain(TD.lookupKeys('long hair')), ['long_hair']);
  assert.deepEqual(plain(TD.lookupKeys('LONG  Hair')), ['long_hair']);
  assert.deepEqual(plain(TD.lookupKeys('@some artist')), ['@some_artist', 'some_artist']);
  const index = fixtureIndex(TD);
  for (const value of ['long_hair', 'long hair', 'LONG_HAIR']) {
    const hit = TD.lookup(index, value);
    assert.ok(hit, `未命中 ${value}`);
    assert.equal(hit.result.canonical, 'long_hair');
    assert.equal(hit.result.animaTag, 'long hair');
  }
  assert.equal(TD.lookup(index, '@dairi').result.animaTag, '@dairi');
  // 中文标注的数据集：直接写中文也能认出来，但只影响显示，不改写 caption
  assert.equal(TD.lookup(index, '超长发发型').result.canonical, 'absurdly_long_hair');
  assert.equal(TD.lookup(index, '长髪').result.canonical, 'long_hair');
  // 自定义 trigger、自然语言、prompt weighting 都不该被词典认领
  for (const value of ['my_style_v2', 'A girl standing beside a window.', '(chibi:2)', '{red|blue} hair']) {
    assert.equal(TD.lookup(index, value), null, `不该命中 ${value}`);
  }
});

test('exact matches rank above prefix and contains, popularity breaks ties', () => {
  const TD = loadLib();
  const index = fixtureIndex(TD);
  // 中文精确命中排在子串命中之前，哪怕子串那条热门得多
  assert.deepEqual(names(TD.search(index, '长发', 20)), ['long_hair', 'absurdly_long_hair']);
  assert.deepEqual(plain(TD.search(index, '长发', 20)).map(item => item.match), ['translation', 'contains']);
  // 前缀命中按图片数降序，而不是字典序（long_dress 字母序最前但最冷门）
  const prefix = TD.search(index, 'long', 20);
  assert.deepEqual(names(prefix).slice(0, 3), ['long_hair', 'long_hair_between_eyes', 'long_dress']);
  assert.deepEqual(plain(prefix).map(item => item.match).slice(0, 3), ['canonical', 'canonical', 'canonical']);
  // 子串只作回退：absurdly_long_hair 不在前缀命中里
  assert.ok(names(prefix).includes('absurdly_long_hair'));
  assert.equal(prefix.at(-1).match, 'contains');
});

test('alias is a search entry, never the inserted value', () => {
  const TD = loadLib();
  const index = fixtureIndex(TD);
  const [hit] = TD.search(index, 'longhair', 5);
  assert.equal(hit.canonical, 'long_hair');
  assert.equal(hit.animaTag, 'long hair');
  assert.equal(hit.alias, 'longhair');
  assert.equal(hit.match, 'alias');
  const [cjk] = TD.search(index, '黑毛', 5);
  assert.equal(cjk.canonical, 'black_hair');
  assert.equal(cjk.match, 'alias');
  assert.notEqual(cjk.animaTag, cjk.alias);
});

test('search limits and empty queries', () => {
  const TD = loadLib();
  const index = fixtureIndex(TD);
  assert.equal(TD.search(index, 'hair', 3).length, 3);
  assert.ok(TD.search(index, 'hair', 999).length <= 50);
  assert.deepEqual(plain(TD.search(index, '   ', 20)), []);
  assert.deepEqual(plain(TD.search(index, 'zzzznope', 20)), []);
  // 没有前缀命中时按热门度给出子串结果
  const hair = TD.search(index, 'hair', 20);
  assert.equal(hair[0].canonical, 'absurdly_long_hair');
  assert.equal(hair[0].animaTag, 'absurdly long hair');
  assert.equal(hair[0].match, 'contains');
});

test('count formatting matches the autocomplete scale', () => {
  const TD = loadLib();
  assert.equal(TD.formatCount(8314081), '8.3M');
  assert.equal(TD.formatCount(6134076), '6.1M');
  assert.equal(TD.formatCount(580432), '580K');
  assert.equal(TD.formatCount(12345), '12.3K');
  assert.equal(TD.formatCount(187), '187');
  assert.equal(TD.formatCount(0), '');
});

test('builder output shape stays readable by the index', () => {
  // 构建脚本（Python）与这里共用一套 wire 格式：五元数组、图片数降序、core 与 detail 同下标。
  // 用同样的形状喂给索引，确认读得进、查得到。
  const TD = loadLib();
  const records = FIXTURE.map(row => [row[0], row[1], row[2], row[3], row[4]]);
  const details = records.map(record => (record[0] === 'long_hair' ? '从肩长到腰长的头发' : ''));
  const index = TD.createIndex(records, details);
  const hit = TD.lookup(index, 'long hair');
  assert.equal(hit.result.canonical, 'long_hair');
  assert.equal(TD.describe(index, hit.id), '从肩长到腰长的头发');
  assert.deepEqual(plain(TD.aliasesOf(index, hit.id)), ['longhair', '长髪']);
});

/* ===== 客户端：单例 Worker、revision 守卫、失败降级 ===== */

function makeClient(options) {
  const posted = [];
  const requests = [];
  const opts = options || {};
  const context = { window: {} };
  context.window = context;
  context.console = { warn() {} };
  context.setTimeout = setTimeout;
  context.clearTimeout = clearTimeout;
  context.setInterval = setInterval;
  context.clearInterval = clearInterval;
  context.Promise = Promise;
  // 后端状态队列：每次 GET 取一条，取完停在最后一条（模拟轮询）
  const statusQueue = (opts.status || []).slice();
  context.fetch = (url, init) => {
    const target = String(url);
    requests.push({ url: target, method: (init && init.method) || 'GET', body: (init && init.body) || '' });
    if (target.indexOf('/dictionary/install') !== -1) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'success', data: { started: true, reason: '', status: statusQueue[0] || null } })
      });
    }
    if (opts.statusBroken) return Promise.reject(new Error('backend down'));
    const next = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
    if (!next) return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'error' }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'success', data: next }) });
  };
  context.localStorage = { _v: {}, getItem(k) { return k in this._v ? this._v[k] : null; }, setItem(k, v) { this._v[k] = String(v); } };
  context.navigator = { clipboard: { writeText() { return Promise.resolve(); } } };
  const instances = [];
  context.Worker = class {
    constructor(url) {
      this.url = url;
      instances.push(this);
      this.terminated = false;
    }
    postMessage(payload) { posted.push(payload); }
    terminate() { this.terminated = true; }
  };

  vm.runInNewContext(fs.readFileSync(LIB, 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), context);

  const ctx = Object.assign({}, context.window.tagDictionaryMixin);
  ctx.toast = () => {};
  ctx.t = key => key;
  ctx.tagEditorGetSelectedTags = () => [];
  ctx.tagEditorTagSelection = [];
  ctx.tagEditorExcludedTags = [];
  ctx.tagEditorSchedulePageFetch = () => {};
  ctx._teInvalidateFilter = () => {};
  ctx.tagEditorSidebarTab = 'tags';
  ctx.tagEditorSearchQuery = '';
  ctx.tagEditorSuggestions = [];
  ctx._teSuggestSeq = 0;
  ctx._teLocalSuggestTags = [];

  context.TD_POLL_INTERVAL = 10;   // 轮询间隔直接写进 vm 上下文，测试不必真等 700ms
  ctx.currentRoute = opts.route || 'tagEditor';

  return {
    ctx, posted, requests,
    merge: context.window._teSuggestMerge,
    workers: () => instances,
    reply(payload) { ctx._tdHandleMessage(payload); }
  };
}

const INSTALLED = {
  status: 'ready', installed: true, data_version: '2026-09-18',
  tag_count: 97154, size_bytes: 9370504, percent: 0,
};
const ABSENT = { status: 'idle', installed: false, data_version: '', tag_count: 0, size_bytes: 0, percent: 0 };

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('environment retry refreshes failed updates and invalid source data', () => {
  const { ctx } = makeClient({ status: [INSTALLED] });
  const forces = [];
  ctx.tagDictionaryInstall = force => forces.push(force);
  ctx.tagDictionaryServer = { ...INSTALLED, status: 'failed' };
  ctx.tagDictionaryReady = true;
  assert.equal(ctx.tagDictionaryStatus(), 'ready');
  ctx.tagDictionaryDataAction();
  ctx.tagDictionaryServer = { ...ABSENT, status: 'failed', error_kind: 'build' };
  ctx.tagDictionaryDataAction();
  ctx.tagDictionaryServer = { ...ABSENT, status: 'failed', error_kind: 'download' };
  ctx.tagDictionaryDataAction();
  assert.deepEqual(forces, [true, true, false]);
});

test('dictionary details show useful state without a permanent info box or log', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/environment-render.js'), 'utf8'), context);
  const translations = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/i18n/zh-CN.json'), 'utf8')).environment;
  const T = key => translations[key] || key;
  const ctx = {
    ...context.window.environmentRenderMixin,
    tagDictionaryServer: { ...INSTALLED, status: 'failed', error_kind: 'integrity' },
    esc: text => String(text).replaceAll('<', '&lt;'),
    tagDictionaryLogText: () => 'Size mismatch <unsafe>',
  };
  const failed = ctx._renderDictionaryBody(T, 'failed', 0);
  assert.ok(failed.includes('已安装的词典仍可使用'));
  assert.ok(failed.includes('完整性校验'));
  assert.ok(failed.includes('<details>'));
  assert.ok(failed.includes('&lt;unsafe>'));
  assert.ok(!failed.includes('env-msg-info'));
  const installed = ctx._renderDictionaryBody(T, 'installed', 0);
  assert.ok(!installed.includes('env-log'));
  assert.ok(installed.includes('部分标签暂无翻译'));
  ctx.tagDictionaryServer = { status: 'downloading', current_file: 'meta.csv', file_index: 4,
    file_total: 5, total_bytes: 100, downloaded_bytes: 50, speed_mb: 1, download_source: 'huggingface.co' };
  ctx._renderProgressPanel = options => JSON.stringify(options);
  const downloading = ctx._renderDictionaryBody(T, 'installing', 90);
  assert.ok(downloading.includes('元标签 · 5/5'));
  assert.ok(downloading.includes('huggingface.co'));
  assert.ok(downloading.includes('"pct":50'));
});

/* init 现在先问后端状态，再决定要不要建 Worker */
async function initReady(ctx) {
  const done = ctx.tagDictionaryInit();
  await tick(10);
  return done;
}

test('worker is created once and reused', async () => {
  const { ctx, workers } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  ctx.tagDictionaryInit();
  ctx.tagDictionaryInit();
  assert.equal(workers().length, 1);
  assert.equal(ctx.tagDictionaryStatus(), 'loading');
  assert.equal(ctx.tagDictionaryServer.tag_count, 97154);
  assert.equal(ctx.tagDictionarySizeText(), '8.9 MB');
});

test('stale lookup results never reach the cache', async () => {
  const { ctx, posted, reply } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  reply({ type: 'READY_CORE', tagCount: 10 });
  assert.equal(ctx.tagDictionaryStatus(), 'ready');

  const tags = ['long_hair', 'custom_trigger'];
  ctx.tagEditorGetSelectedTags = () => tags;
  ctx.tagDictionarySyncChips();
  await tick(160);
  const batch = posted.find(message => message.type === 'LOOKUP_BATCH');
  assert.ok(batch, '没有发出批量查询');
  assert.deepEqual(plain(batch.tags), tags);
  assert.ok(batch.revision >= 1);

  // 图片切换后再返回旧结果：整批丢弃
  ctx.tagDictionarySyncChips();
  reply({
    type: 'LOOKUP_RESULT', id: batch.id, revision: batch.revision,
    results: [{ canonical: 'long_hair', animaTag: 'long hair', translation: '长发', category: 0, postCount: 10 }, null]
  });
  assert.equal(ctx.tagDictionaryMetaFor('long_hair'), null);
  assert.equal(ctx.tagDictionaryMetaFor('custom_trigger'), null);
});

test('fresh lookup results populate cache and version', async () => {
  const { ctx, posted, reply } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  reply({ type: 'READY_CORE', tagCount: 10 });
  ctx.tagEditorGetSelectedTags = () => ['long_hair', 'custom_trigger'];
  ctx.tagDictionarySyncChips();
  await tick(160);
  const batch = posted.filter(message => message.type === 'LOOKUP_BATCH').at(-1);
  const version = ctx.tagDictionaryVersion;
  reply({
    type: 'LOOKUP_RESULT', id: batch.id, revision: batch.revision,
    results: [{ canonical: 'long_hair', animaTag: 'long hair', translation: '长发', category: 0, postCount: 6134076 }, null]
  });
  assert.equal(ctx.tagDictionaryVersion, version + 1);
  assert.equal(ctx.tagDictionaryMetaFor('long_hair').translation, '长发');
  assert.equal(ctx.tagDictionaryMetaFor('custom_trigger'), null);
  // 未知标签也要缓存，否则每次渲染都会重新问一遍
  assert.equal(posted.filter(message => message.type === 'LOOKUP_BATCH').length, 1);
  ctx.tagDictionarySyncChips();
  await tick(160);
  assert.equal(posted.filter(message => message.type === 'LOOKUP_BATCH').length, 1);
  assert.equal(ctx.tagDictionaryTranslationFor('long_hair'), '长发');
  ctx.tagDictionaryShowTranslation = false;
  assert.equal(ctx.tagDictionaryTranslationFor('long_hair'), '');
  assert.equal(ctx.tagDictionaryChipState('long_hair')['te-dict-cat-general'], true);
});

test('dictionary failure degrades instead of breaking the editor', async () => {
  const { ctx, posted, workers } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  ctx._tdHandleMessage({ type: 'FAILED', scope: 'core', message: 'HTTP 404' });
  assert.equal(ctx.tagDictionaryFailed, true);
  assert.equal(ctx.tagDictionaryStatus(), 'failed');
  assert.equal(workers()[0].terminated, true);
  // 失败后不再重试，也不影响标签编辑器自身的查找
  ctx.tagDictionaryInit();
  assert.equal(workers().length, 1);
  assert.equal(ctx.tagDictionaryMetaFor('long_hair'), null);
  assert.equal(ctx.tagDictionaryTranslationFor('long_hair'), '');
  ctx.tagEditorGetSelectedTags = () => ['long_hair'];
  ctx.tagDictionarySyncChips();
  await tick(160);
  assert.equal(posted.filter(message => message.type === 'LOOKUP_BATCH').length, 0);
});

test('detail failure keeps the base dictionary usable', async () => {
  const { ctx } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  ctx._tdHandleMessage({ type: 'READY_CORE', tagCount: 10 });
  ctx._tdHandleMessage({ type: 'FAILED', scope: 'detail', message: 'HTTP 500' });
  assert.equal(ctx.tagDictionaryFailed, false);
  assert.equal(ctx.tagDictionaryStatus(), 'ready');
});

test('stale search results are dropped by sequence', async () => {
  const { ctx, posted } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  ctx._tdHandleMessage({ type: 'READY_CORE', tagCount: 10 });
  const applied = [];
  ctx._teApplyDictSuggestions = (token, seq, results) => applied.push([token, seq, results.length]);
  ctx.tagDictionarySuggest('长', 1, null);
  await tick(160);
  const search = posted.filter(message => message.type === 'SEARCH').at(-1);
  assert.equal(search.query, '长');
  ctx._teSuggestSeq = 2; // 用户又敲了一个字
  ctx._tdHandleMessage({ type: 'SEARCH_RESULT', id: search.id, results: [{ canonical: 'long_hair' }] });
  await tick(10);
  assert.deepEqual(applied, []);
  ctx.tagDictionarySuggest('长发', 2, null);
  await tick(160);
  const current = posted.filter(message => message.type === 'SEARCH').at(-1);
  ctx._tdHandleMessage({ type: 'SEARCH_RESULT', id: current.id, results: [{ canonical: 'long_hair' }] });
  await tick(10);
  assert.deepEqual(applied, [['长发', 2, 1]]);
});

test('未安装词典时不建 Worker，只提示可以下载', async () => {
  const { ctx, workers, requests } = makeClient({ status: [ABSENT] });
  await initReady(ctx);
  assert.equal(workers().length, 0);
  assert.equal(ctx.tagDictionaryStatus(), 'absent');
  assert.equal(ctx.tagDictionaryStateLabel(), 'tagEditor.dictStateAbsent');
  assert.equal(ctx.tagDictionaryActionLabel(), 'tagEditor.dictInstall');
  assert.ok(requests.some(item => item.url.indexOf('/api/tageditor/dictionary') !== -1));
  assert.equal(ctx.tagDictionaryMetaFor('long_hair'), null);
});

test('下载词典：POST 安装后轮询到就绪再拉起 Worker', async () => {
  const downloading = { status: 'downloading', installed: false, percent: 42, message: '', tag_count: 0, size_bytes: 0 };
  const { ctx, workers, requests } = makeClient({ status: [ABSENT, downloading, INSTALLED] });
  await initReady(ctx);
  assert.equal(workers().length, 0);
  assert.equal(ctx.tagDictionaryStatus(), 'absent');

  ctx.tagDictionaryInstall(true);
  await tick(10);
  const install = requests.find(item => item.method === 'POST');
  assert.ok(install, '没有发出安装请求');
  assert.equal(JSON.parse(install.body).force, true);
  await tick(10);
  assert.equal(ctx.tagDictionaryInstalling, true);
  assert.equal(ctx.tagDictionaryStatus(), 'installing');
  assert.equal(ctx.tagDictionaryInstallText(), 'tagEditor.dictDownloading'.replace('{percent}', 42));

  await tick(60);
  assert.equal(ctx.tagDictionaryInstalling, false);
  assert.equal(workers().length, 1);
  assert.equal(ctx.tagDictionaryStatus(), 'loading');
});

test('环境管理页只查数据状态，不建 Worker（9MB 词典不该为了一行状态拉下来）', async () => {
  const { ctx, workers } = makeClient({ status: [INSTALLED], route: 'environment' });
  await initReady(ctx);
  assert.equal(workers().length, 0);
  assert.equal(ctx.tagDictionaryDataState(), 'installed');
  assert.equal(ctx.tagDictionaryDataLabel(), 'tagEditor.dictStateReady');
  assert.equal(ctx.tagDictionaryDataActionLabel(), 'tagEditor.dictUpdate');
  assert.equal(ctx.tagDictionarySizeText(), '8.9 MB');
  // 进标签编辑器时才建 Worker
  ctx.currentRoute = 'tagEditor';
  ctx.tagDictionaryEnsureWorker();
  assert.equal(workers().length, 1);
});

test('数据动作在未装/已装/失败三种状态下给出对应按钮', () => {
  const withServer = payload => {
    const ctx = makeClient().ctx;
    ctx.tagDictionaryServer = payload;
    return ctx;
  };
  const absent = withServer(ABSENT);
  assert.equal(absent.tagDictionaryDataActionLabel(), 'tagEditor.dictInstall');
  assert.equal(absent.tagDictionaryDataActionVisible(), true);

  const installed = withServer(INSTALLED);
  assert.equal(installed.tagDictionaryDataActionLabel(), 'tagEditor.dictUpdate');
  assert.equal(installed.tagDictionaryDataState(), 'installed');

  const failed = withServer({ ...INSTALLED, status: 'failed', installed: false });
  assert.equal(failed.tagDictionaryDataActionLabel(), 'tagEditor.dictRetry');

  const busy = withServer(INSTALLED);
  busy.tagDictionaryInstalling = true;
  assert.equal(busy.tagDictionaryDataActionVisible(), false);
  assert.equal(busy.tagDictionaryDataState(), 'installing');

  const broken = withServer(null);
  broken.tagDictionaryFailed = true;
  assert.equal(broken.tagDictionaryDataState(), 'failed');
});

test('后端状态问不到时按词典不可用处理', async () => {
  const { ctx, workers } = makeClient({ statusBroken: true });
  await initReady(ctx);
  assert.equal(workers().length, 0);
  assert.equal(ctx.tagDictionaryFailed, true);
  assert.equal(ctx.tagDictionaryStatus(), 'failed');
});

test('已安装但不可用：先重拉 Worker，不重复下载', async () => {
  const { ctx, requests, workers } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  ctx._tdHandleMessage({ type: 'FAILED', scope: 'core', message: 'HTTP 404' });
  assert.equal(ctx.tagDictionaryStatus(), 'failed');
  const before = requests.filter(item => item.method === 'POST').length;
  ctx.tagDictionaryPrimaryAction();
  await tick(10);
  assert.equal(requests.filter(item => item.method === 'POST').length, before);
  assert.equal(workers().length, 2);   // 旧实例被终止，新实例接手
  assert.equal(workers()[0].terminated, true);
});

test('autocomplete merges local dataset tags with dictionary results', () => {
  const { merge } = makeClient();
  assert.equal(typeof merge, 'function');
  const results = [{
    canonical: 'long_hair', animaTag: 'long hair', translation: '长发',
    category: 0, postCount: 6134076, alias: 'longhair'
  }];
  const items = merge(['long_hair', 'my_style_v2'], results, 20);
  assert.deepEqual(plain(items).map(item => item.insert), ['long_hair', 'my_style_v2', 'long hair']);
  // 本地标签保持数据集里的写法，但顺手补上中文；词典命中的别名只作提示
  assert.equal(items[0].sub, '长发');
  assert.equal(items[1].sub, '');
  assert.equal(items[2].alias, 'longhair');
  assert.equal(items[2].cat, 0);
  assert.equal(merge(['a', 'b', 'c'], results, 2).length, 2);
  assert.deepEqual(plain(merge([], results, 20)).map(item => item.insert), ['long hair']);
});
