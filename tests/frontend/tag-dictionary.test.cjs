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

test('escaped caption tags display and resolve without rewriting source strings', () => {
  const TD = loadLib();
  const index = TD.createIndex([['star_(symbol)', '星形符号', 0, 100, '']]);
  const raw = String.raw`star \(symbol\)`;
  assert.equal(TD.displayTag(raw), 'star (symbol)');
  assert.equal(TD.lookup(index, raw).result.translation, '星形符号');
  assert.equal(TD.lookup(index, String.raw`star_\(symbol\)`).result.canonical, 'star_(symbol)');
  assert.equal(TD.search(index, raw, 10)[0].canonical, 'star_(symbol)');
  assert.deepEqual(plain(TD.filterTags(index, [raw], '星形符号')), [raw]);
  assert.deepEqual(plain(TD.filterTags(index, [raw], 'star (symbol)')), [raw]);
  assert.equal(raw, String.raw`star \(symbol\)`);
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

test('batch Enter applies the active operation unless selecting a visible suggestion or composing', () => {
  const { ctx } = makeClient();
  const actions = [];
  ctx.tagEditorBatchAdd = () => actions.push('add');
  ctx.tagEditorBatchRemove = () => actions.push('remove');
  ctx.tagEditorBatchReplace = () => actions.push('replace');
  ctx.tagEditorBatchSelectSuggestion = () => actions.push('suggestion');
  const enter = {key:'Enter',preventDefault() {},stopPropagation() {}};
  for (const mode of ['add', 'remove', 'replace']) {
    ctx.tagEditorBatchMode = mode;
    ctx.tagEditorBatchKeydown(enter);
  }
  assert.deepEqual(actions, ['add','remove','replace']);
  ctx.batchSuggestOpen = 'new';
  ctx.batchSuggestItems = [{insert:'flower'}];
  ctx.batchSuggestIdx = 0;
  ctx.tagEditorBatchKeydown(enter);
  assert.equal(actions.at(-1), 'suggestion');
  ctx.batchSuggestIdx = -1;
  ctx.tagEditorBatchKeydown(enter);
  assert.equal(actions.at(-1), 'replace');
  const count = actions.length;
  ctx.tagEditorBatchKeydown({...enter, isComposing:true});
  assert.equal(actions.length, count);
  ctx.batchSuggestOpen = null;
  ctx.batchSuggestIdx = 0;
  ctx.tagEditorBatchKeydown(enter);
  assert.equal(actions.at(-1), 'replace');
});

test('removing bracket escapes changes only selected captions and supports undo and redo', () => {
  const { ctx } = makeClient();
  const raw = String.raw`star \(symbol\),  custom\name, foo \\(bar\\)`;
  ctx.tagEditorImages = [{ path: 'a', tags: raw }, { path: 'b', tags: raw }, { path: 'c', tags: 'solo' }];
  ctx.tagEditorOriginal = { a: raw, b: raw, c: 'solo' };
  ctx.tagEditorSelected = ['a', 'c'];
  ctx.tagEditorHistory = [];
  ctx.tagEditorHistoryIdx = -1;
  ctx._teHistoryState = {};
  ctx._teModifiedCount = 0;
  ctx._teInvalidateFilter = () => {};
  ctx._teInvalidateDiff = () => {};
  ctx._teUpdateFreq = () => {};
  ctx._updateEditorPanel = () => {};
  let apply;
  ctx._teConfirmBatch = (message, callback) => { apply = callback; };
  ctx.tagEditorRemoveBracketEscapes();
  assert.equal(ctx.tagEditorImages[0].tags, raw);
  apply();
  assert.equal(ctx.tagEditorImages[0].tags, String.raw`star (symbol),  custom\name, foo (bar)`);
  assert.equal(ctx.tagEditorImages[1].tags, raw);
  assert.equal(ctx.tagEditorHistory.length, 1);
  assert.equal(ctx.tagEditorHistory[0].meta.affected, 1);
  assert.equal(ctx.tagEditorModifiedCount(), 1);
  ctx.tagEditorUndo();
  assert.equal(ctx.tagEditorImages[0].tags, raw);
  assert.equal(ctx.tagEditorModifiedCount(), 0);
  ctx.tagEditorRedo();
  assert.equal(ctx.tagEditorImages[0].tags, String.raw`star (symbol),  custom\name, foo (bar)`);
  apply = null;
  ctx.tagEditorRemoveBracketEscapes();
  assert.equal(apply, null);
});

test('bracket cleanup refuses a confirmation after captions or dataset change', () => {
  for (const changed of ['caption', 'dataset']) {
    const { ctx } = makeClient();
    ctx.tagEditorImages = [{ path: 'a', tags: String.raw`star \(symbol\)` }];
    ctx.tagEditorSelected = ['a'];
    let apply;
    ctx._teConfirmBatch = (message, callback) => { apply = callback; };
    ctx._teUpdateImageTags = () => assert.fail('stale confirmation must not modify captions');
    ctx.tagEditorRemoveBracketEscapes();
    if (changed === 'caption') ctx.tagEditorImages[0].tags = 'new caption';
    else ctx._teLoadEpoch++;
    apply();
  }
});

const INSTALLED = {
  status: 'ready', installed: true, data_version: '2026-09-18',
  tag_count: 97154, size_bytes: 9370504, percent: 0,
};

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

/* init 现在先问后端状态，再决定要不要建 Worker */
async function initReady(ctx) {
  const done = ctx.tagDictionaryInit();
  await tick(10);
  return done;
}

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

test('completion in the middle preserves following tags and a sensible caret', () => {
  const { context } = makeClient();
  const result = context._teReplaceToken('solo, 长发, blue eyes', 8, 'long hair');
  assert.equal(result.text, 'solo, long hair, blue eyes');
  assert.equal(result.caretPos, 'solo, long hair'.length);
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
