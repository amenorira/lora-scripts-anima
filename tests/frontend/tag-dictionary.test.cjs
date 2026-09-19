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

test('ambiguous translated titles do not steal general aliases', () => {
  const TD = loadLib();
  const index = TD.createIndex([
    ['flower', '花朵', 0, 875695, 'flowers'],
    ['flowers_(innocent_grey)', 'FLOWERS', 3, 232, 'flowers'],
    ['some_series', 'flower', 3, 100, ''],
  ]);
  assert.equal(TD.lookup(index, 'flowers').result.canonical, 'flower');
  assert.equal(TD.search(index, 'flowers', 20)[0].canonical, 'flower');
  assert.equal(TD.lookup(index, 'flowers (innocent grey)').result.category, 3);
  assert.equal(TD.lookup(index, 'flower').result.canonical, 'flower');
});

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

/* ===== 客户端：单例 Worker、缓存复用、失败降级 ===== */

function makeClient(options) {
  const posted = [];
  const requests = [];
  const opts = options || {};
  const context = { window: {} };
  context.window = context;
  context.console = { warn() {} };
  context.setTimeout = (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; };
  context.clearTimeout = clearTimeout;
  context.setInterval = setInterval;
  context.clearInterval = clearInterval;
  context.Promise = Promise;
  context.AbortSignal = AbortSignal;
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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tag-editor.js'), 'utf8'), context);

  const ctx = Object.assign({}, context.window.tagEditorMixin, context.window.tagDictionaryMixin);
  ctx.locale = 'zh-CN';
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
    context,
    merge: context.window._teSuggestMerge,
    workers: () => instances,
    reply(payload) { ctx._tdHandleMessage(payload); }
  };
}

test('translations follow locale and the saved display preference', () => {
  const { ctx } = makeClient();
  ctx.tagDictionaryMetaFor = () => ({ translation: '花朵', category: 0 });
  assert.equal(ctx.tagDictionaryTranslationFor('flowers'), '花朵');
  for (const locale of ['en-US', 'ja-JP', 'fr-FR']) {
    ctx.locale = locale;
    assert.equal(ctx.tagDictionaryTranslationFor('flowers'), '');
    assert.equal(ctx.tagDictionaryChipState('flowers')['te-dict-cat-general'], true);
  }
  ctx.locale = 'zh-CN';
  ctx.tagDictionaryShowTranslation = false;
  assert.equal(ctx.tagDictionaryTranslationFor('flowers'), '');
});

test('local alias keeps its spelling and the best dictionary category', () => {
  const { merge } = makeClient();
  const results = [
    { canonical:'flower', animaTag:'flower', translation:'花朵', category:0, postCount:875695, alias:'flowers' },
    { canonical:'flowers_(innocent_grey)', animaTag:'flowers (innocent grey)', translation:'FLOWERS', category:3, postCount:232, alias:'flowers' },
  ];
  const local = merge(['flowers'], results, 20)[0];
  assert.equal(local.insert, 'flowers');
  assert.equal(local.cat, 0);
  assert.equal(local.sub, '花朵');
});

test('hover switches immediately and remains outside the editor', () => {
  const { ctx, context } = makeClient();
  ctx.tagDictionaryReady = true;
  const shown = [];
  ctx._tdShowHover = tag => shown.push(tag);
  ctx.tagDictionaryHoverEnter('flower', {});
  ctx.tagDictionaryHoverEnter('solo', {});
  assert.deepEqual(shown, ['flower', 'solo']);
  context.innerWidth = 1440;
  context.innerHeight = 900;
  const editor = { getBoundingClientRect: () => ({ left: 1100 }) };
  const anchor = left => ({
    closest: selector => selector === '.te-editor' ? editor : null,
    getBoundingClientRect: () => ({ left, right: left + 80, top: 300, bottom: 330 }),
  });
  const first = ctx._tdHoverStyle(anchor(1110));
  assert.equal(first, ctx._tdHoverStyle(anchor(1310)));
  assert.match(first, /left:770px/);
  assert.match(first, /width:320px/);
});

test('dataset translation search returns only existing caption spellings', () => {
  const TD = loadLib();
  const index = fixtureIndex(TD);
  assert.deepEqual(plain(TD.filterTags(index, ['long hair', 'solo', 'custom_trigger'], '长发')), ['long hair']);
  assert.deepEqual(plain(TD.filterTags(index, ['long hair', 'solo', 'custom_trigger'], 'custom')), ['custom_trigger']);
});

test('batch targets stay selected and shared counts count images, not duplicate tags', () => {
  const { ctx } = makeClient();
  ctx.tagEditorImages = [{path:'a',tags:'solo, solo, long hair'}, {path:'b',tags:'solo'}, {path:'c',tags:'long hair'}];
  ctx.tagEditorSelected = ['a','b'];
  assert.deepEqual(plain(ctx.tagEditorGetBatchTargets()).map(img => img.path), ['a','b']);
  const stats = ctx.tagEditorGetSelectedStats();
  assert.equal(stats.find(item => item.tag === 'solo').count, 2);
  ctx.tagEditorBatchTagFilter = 'shared';
  assert.deepEqual(plain(ctx.tagEditorGetVisibleSelectedStats()).map(item => item.tag), ['solo']);
  ctx.tagEditorPrepareRemove('solo');
  assert.equal(ctx.tagEditorBatchMode, 'remove');
  assert.equal(ctx.batchRemoveInput, 'solo');
  assert.equal(ctx.tagEditorImages[0].tags, 'solo, solo, long hair');
});

test('no-op history updates preserve redo and edits after undo start a new step', () => {
  const { ctx } = makeClient();
  ctx._teInvalidateDiff = () => {};
  ctx.tagEditorOriginal = { a: 'solo' };
  ctx._teHistoryState = { a: 'solo, flower' };
  ctx._teGetModified = () => [{ path: 'a', tags: 'solo, flower' }];
  ctx.tagEditorHistory = [
    { meta: { type: 'add' }, changes: { a: { before: null, after: 'solo, flower' } }, _ts: Date.now() },
    { meta: { type: 'add' }, changes: { a: { before: 'solo, flower', after: 'solo, flower, hat' } }, _ts: Date.now() },
  ];
  ctx.tagEditorHistoryIdx = 0;
  ctx._tePushHistory({ type: 'add' });
  assert.equal(ctx.tagEditorHistory.length, 2);
  ctx._teGetModified = () => [{ path: 'a', tags: 'solo, flower, shoes' }];
  ctx._tePushHistory({ type: 'add' });
  assert.equal(ctx.tagEditorHistory.length, 2);
  assert.equal(ctx.tagEditorHistory[0].changes.a.after, 'solo, flower');
  assert.equal(ctx.tagEditorHistoryIdx, 1);
});

test('history jumps apply final file states once in either direction', () => {
  const { ctx } = makeClient();
  ctx._teFlushAllPendingTextEdits = () => {};
  const applied = [];
  ctx._teApplyHistoryChanges = (changes, direction) => applied.push({changes, direction});
  ctx.tagEditorHistory = [
    { changes: { a: { before: null, after: 'a' } } },
    { changes: { a: { before: 'a', after: 'b' } } },
    { changes: { a: { before: 'b', after: 'c' }, b: { before: null, after: 'x' } } },
  ];
  ctx.tagEditorHistoryIdx = 2;
  ctx.tagEditorJumpToHistory(0);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].direction, 'before');
  assert.equal(applied[0].changes.a.before, 'a');
  assert.equal(applied[0].changes.b.before, null);
  ctx.tagEditorJumpToHistory(2);
  assert.equal(applied.length, 2);
  assert.equal(applied[1].changes.a.after, 'c');
});

test('timeline restore refuses unsaved edits and stale dataset confirmations', () => {
  const { ctx } = makeClient();
  ctx._teFlushAllPendingTextEdits = () => {};
  let confirm;
  ctx.openConfirm = (title, text, action) => { confirm = action; };
  ctx.tagEditorModified = true;
  ctx.tagEditorRestoreSnapshot('event');
  assert.equal(confirm, undefined);
  ctx.tagEditorModified = false;
  ctx.tagEditorRestoreSnapshot('event');
  assert.equal(typeof confirm, 'function');
  ctx._teLoadEpoch++;
  confirm();
  assert.equal(ctx.tagEditorSnapshotBusy, false);
});

test('batch autocomplete replaces the last token without applying changes', () => {
  const { ctx } = makeClient();
  ctx.batchAddInput = 'solo, 长';
  ctx.batchSuggestOpen = 'add';
  ctx.tagEditorBatchSelectSuggestion({insert:'long hair'});
  assert.equal(ctx.batchAddInput, 'solo, long hair, ');
  ctx.batchSuggestItems = [{insert:'flower'}];
  ctx.batchSuggestIdx = 0;
  ctx.batchSuggestOpen = 'new';
  ctx.tagEditorBatchKeydown({key:'Enter',isComposing:true});
  assert.equal(ctx.batchNewTag, '');
});

test('quick removal stages tags, applies only to selected images and records one undo step', () => {
  const { ctx } = makeClient();
  ctx.tagEditorImages = [{path:'a',tags:'solo, flower, flower'}, {path:'b',tags:'solo, hat'}, {path:'c',tags:'solo, flower'}];
  ctx.tagEditorSelected = ['a', 'b'];
  ctx._teFlushAllPendingTextEdits = () => {};
  ctx._updateEditorPanel = () => {};
  ctx._teUpdateImageTags = (img, tags) => { img.tags = tags; };
  const history = [];
  ctx._tePushHistory = meta => history.push(meta);
  ctx.tagEditorStartQuickRemove();
  ctx.tagEditorToggleRemoval('flower');
  ctx.tagEditorToggleRemoval('hat');
  ctx.tagEditorToggleRemoval('hat');
  assert.equal(ctx.tagEditorImages[0].tags, 'solo, flower, flower');
  assert.equal(history.length, 0);
  ctx.tagEditorApplyQuickRemove();
  assert.deepEqual(ctx.tagEditorImages.map(img => img.tags), ['solo', 'solo, hat', 'solo, flower']);
  assert.equal(history.length, 1);
  assert.deepEqual(plain(history[0].paths), ['a']);
  assert.equal(ctx.tagEditorQuickRemove, false);
  assert.equal(ctx.tagEditorRemovalTags.length, 0);
  ctx.tagEditorStartQuickRemove();
  ctx.tagEditorToggleRemoval('solo');
  ctx.tagEditorCancelQuickRemove();
  ctx.tagEditorApplyQuickRemove();
  assert.equal(history.length, 1);
});

test('clear tag filters clears include, exclude and search in one refresh', () => {
  const { ctx } = makeClient();
  ctx.tagEditorTagSelection = ['solo'];
  ctx.tagEditorExcludedTags = ['flower'];
  ctx.tagEditorTagSearch = 'hair';
  ctx.tagEditorSetTagSearch = value => { ctx.tagEditorTagSearch = value; };
  ctx._teInvalidateFilter = () => {};
  let requests = 0;
  ctx.tagEditorSchedulePageFetch = () => { requests++; };
  ctx.tagEditorClearTagFilters();
  assert.equal(ctx.tagEditorTagSelection.length, 0);
  assert.equal(ctx.tagEditorExcludedTags.length, 0);
  assert.equal(ctx.tagEditorTagSearch, '');
  assert.equal(requests, 1);
});

test('batch mutation leaves unselected images intact and skips no-op confirmation', () => {
  const { ctx } = makeClient();
  ctx.tagEditorImages = [{path:'a',tags:'solo, long hair'}, {path:'b',tags:'solo'}, {path:'c',tags:'solo'}];
  ctx.tagEditorSelected = ['a','b'];
  let confirmations = 0;
  ctx._teConfirmBatch = (message, apply) => { confirmations++; apply(); };
  ctx._teUpdateImageTags = (img, tags) => { img.tags = tags; };
  ctx._tePushHistory = () => {};
  ctx.batchRemoveInput = 'solo';
  ctx.tagEditorBatchRemove();
  assert.deepEqual(ctx.tagEditorImages.map(img => img.tags), ['long hair', '', 'solo']);
  assert.equal(confirmations, 1);
  ctx.batchRemoveInput = 'solo';
  ctx.tagEditorBatchRemove();
  assert.equal(confirmations, 1);
});

test('clearing translated sidebar search immediately releases its previous matches', () => {
  const { ctx } = makeClient();
  ctx.tagEditorTagFreq = [{tag:'long hair',count:2},{tag:'solo',count:1}];
  ctx.tagEditorTagSearch = '长发';
  ctx._teTagSearchMatches = new Set(['long hair']);
  ctx.tagEditorSetTagSearch('');
  assert.equal(ctx.tagEditorTagSearch, '');
  assert.deepEqual(plain(ctx.tagEditorGetFilteredTagFreq()).map(item => item.tag), ['long hair','solo']);
});

test('sidebar rename waits for confirmation and deduplicates the destination tag', async () => {
  const { ctx } = makeClient();
  const images = [{path:'a',tags:'solo, solo, flower'}, {path:'b',tags:'sky'}];
  ctx.tagEditorInlineEdit = {oldTag:'solo',newTag:'flower'};
  ctx._teEnsureAllImagesLoaded = async () => images;
  let apply;
  ctx._teConfirmBatch = (message, action) => { apply = action; };
  ctx._teUpdateImageTags = (img, tags) => { img.tags = tags; };
  ctx._tePushHistory = () => {};
  await ctx.tagEditorFinishInlineEdit();
  assert.equal(images[0].tags, 'solo, solo, flower');
  apply();
  assert.equal(images[0].tags, 'flower');
  assert.equal(images[1].tags, 'sky');
});

test('page tags are prefetched once before selecting another image', async () => {
  const { ctx, posted, reply } = makeClient();
  ctx._tdStartWorker();
  ctx.tagEditorPageItems = [{ tags: 'flowers, solo' }, { tags: 'flowers, long hair' }];
  reply({ type: 'READY_CORE' });
  const request = posted.find(item => item.type === 'LOOKUP_BATCH');
  assert.deepEqual(plain(request.tags), ['flowers', 'solo', 'long hair']);
  reply({ type: 'LOOKUP_RESULT', id: request.id, results: [null, null, {translation:'长发', category:0}] });
  await Promise.resolve();
  ctx.tagEditorGetSelectedTags = () => ['long hair'];
  ctx.tagDictionarySyncChips();
  assert.equal(ctx.tagDictionaryTranslationFor('long hair'), '长发');
  assert.equal(posted.filter(item => item.type === 'LOOKUP_BATCH').length, 1);
});

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

test('tag metadata remains reusable when the image changes during lookup', async () => {
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

  // 标签元数据不属于某张图片，不必切图就废弃。
  ctx.tagDictionarySyncChips();
  reply({
    type: 'LOOKUP_RESULT', id: batch.id, revision: batch.revision,
    results: [{ canonical: 'long_hair', animaTag: 'long hair', translation: '长发', category: 0, postCount: 10 }, null]
  });
  await tick(0);
  assert.equal(ctx.tagDictionaryMetaFor('long_hair').translation, '长发');
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
  await tick(0);
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

test('failed update keeps the active dictionary and offers retry', async () => {
  const failure = { ...INSTALLED, status: 'failed', message: 'network down' };
  const { ctx, workers } = makeClient({ status: [INSTALLED, failure] });
  await initReady(ctx);
  ctx._tdHandleMessage({ type: 'READY_CORE' });
  ctx.tagDictionaryInstall(true);
  await tick(50);
  assert.equal(ctx.tagDictionaryReady, true);
  assert.equal(workers().length, 1);
  assert.equal(ctx.tagDictionaryInstallError, 'network down');
  assert.equal(ctx.tagDictionaryActionVisible(), true);
  assert.equal(ctx.tagDictionaryActionLabel(), 'tagEditor.dictRetry');
});

test('leaving the editor does not stop installation tracking', async () => {
  const { ctx, workers } = makeClient({ status: [ABSENT, INSTALLED] });
  await initReady(ctx);
  ctx.tagDictionaryInstall(false);
  ctx.tagDictionaryCleanup();
  ctx.currentRoute = 'environment';
  await tick(50);
  assert.equal(ctx.tagDictionaryInstalling, false);
  assert.equal(ctx.tagDictionaryDataState(), 'installed');
  assert.equal(workers().length, 0);
});

test('worker restart releases pending tags and ignores old replies', async () => {
  const { ctx, posted, reply } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  reply({ type: 'READY_CORE' });
  ctx.tagEditorGetSelectedTags = () => ['solo'];
  ctx._tdRequestChips();
  const old = posted.at(-1);
  ctx._tdRestartWorker();
  reply({ type: 'READY_CORE' });
  ctx._tdRequestChips();
  const fresh = posted.at(-1);
  assert.notEqual(old.id, fresh.id);
  reply({ type: 'LOOKUP_RESULT', id: old.id, results: [{ translation: '旧' }] });
  reply({ type: 'LOOKUP_RESULT', id: fresh.id, results: [{ translation: '单人' }] });
  await tick(0);
  assert.equal(ctx.tagDictionaryTranslationFor('solo'), '单人');
  reply({ type: 'FAILED', scope: 'worker', message: 'crash' });
  assert.equal(ctx.tagDictionaryReady, false);
  assert.doesNotThrow(() => ctx._tdRequestChips());
});

test('new input invalidates old completion before the debounce fires', async () => {
  const { ctx } = makeClient();
  const el = { selectionStart: 8, getBoundingClientRect: () => ({ top: 400, left: 0, width: 300 }) };
  const previous = ctx._teSuggestSeq;
  ctx.tagEditorGetSuggestions('  长发, 黑', el);
  assert.ok(ctx._teSuggestSeq > previous);
  ctx._teApplyDictSuggestions('old', previous, [{ animaTag: 'wrong', canonical: 'wrong' }], el);
  assert.equal(ctx.tagEditorSuggestions.length, 0);
  ctx._teCloseSuggestions();
  await tick(80);
  assert.equal(ctx.tagEditorSuggestions.length, 0);
});

test('contains search fills the limit after skipping earlier exact hits', () => {
  const TD = loadLib();
  const index = TD.createIndex([
    ['hair', '', 0, 30, ''], ['long_hair', '', 0, 20, ''], ['blue_hair', '', 0, 10, '']
  ]);
  assert.deepEqual(names(TD.search(index, 'hair', 3)), ['hair', 'long_hair', 'blue_hair']);
});

test('clipboard failure does not announce a successful copy', async () => {
  const { ctx, context } = makeClient();
  const notices = [];
  ctx.toast = message => notices.push(message);
  context.navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
  await ctx.tagDictionaryCopy('solo');
  assert.deepEqual(notices, ['tagEditor.dictCopyFailed']);
});

test('completion in the middle preserves following tags and a sensible caret', () => {
  const { context } = makeClient();
  const result = context._teReplaceToken('solo, 长发, blue eyes', 8, 'long hair');
  assert.equal(result.text, 'solo, long hair, blue eyes');
  assert.equal(result.caretPos, 'solo, long hair'.length);
});

test('choosing a completion closes the list until the user types again', async () => {
  const { ctx } = makeClient();
  ctx.tagEditorAddInput = '长发';
  ctx._teSuggestInputEl = { selectionStart: 2, focus() {}, setSelectionRange() {} };
  ctx.tagEditorGetSuggestions = () => assert.fail('must not query with the old caret');
  ctx.tagEditorSelectSuggestion({ insert: 'long hair' });
  await tick(30);
  assert.equal(ctx.tagEditorAddInput, 'long hair, ');
  assert.equal(ctx.tagEditorSuggestions.length, 0);
});

test('Chinese search ranks common related tags before rare prefix matches', () => {
  const TD = loadLib();
  const index = TD.createIndex([
    ['long_hair', '长发', 0, 1000, ''],
    ['very_long_hair', '超长发', 0, 500, ''],
    ['rapunzel', '长发公主', 4, 10, '']
  ]);
  assert.deepEqual(names(TD.search(index, '长发', 3)), ['long_hair', 'very_long_hair', 'rapunzel']);
});
