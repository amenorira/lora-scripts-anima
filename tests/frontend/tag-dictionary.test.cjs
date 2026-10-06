// Run from the repository root: node --test tests/frontend/*.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const LIB = path.join(__dirname, '../../frontend/js/tag-dictionary-lib.js');
const CLIENT = path.join(__dirname, '../../frontend/js/tag-dictionary.js');
const WORKER = path.join(__dirname, '../../frontend/js/tag-dictionary.worker.js');

test('dictionary source errors use the selected language for checks and installs', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/environment-render.js'), 'utf8'), context);
  const app = Object.assign({}, context.window.environmentRenderMixin, {
    esc: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    tagDictionaryLogText: () => '',
    _renderLog(value) { return this.esc(value); },
  });
  for (const language of ['zh-CN', 'en-US']) {
    const texts = JSON.parse(fs.readFileSync(path.join(__dirname, `../../frontend/i18n/${language}.json`), 'utf8')).environment;
    assert.ok(texts.dictErrorSource);
    for (const state of ['installed', 'failed']) {
      app.tagDictionaryServer = state === 'installed'
        ? { installed: true, update: { state: 'error', error_kind: 'source', message: '<network error>' } }
        : { installed: true, status: 'failed', error_kind: 'source', message: '<network error>' };
      const html = app._renderDictionaryBody(key => texts[key], state);
      assert.ok(html.includes(texts.dictErrorSource));
      assert.ok(html.includes(texts.dictErrorDetails));
      assert.ok(html.includes('&lt;network error&gt;'));
      assert.ok(!html.includes('<network error>'));
    }
  }
});

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
  ctx.$nextTick = callback => callback();
  context.innerWidth = 1280;
  context.innerHeight = 900;

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

test('stale suggestions cannot replace the active field or reopen a closed list', async () => {
  const { ctx, posted } = makeClient({ status: [INSTALLED] });
  await initReady(ctx);
  ctx._tdHandleMessage({ type: 'READY_CORE', tagCount: 10 });
  const input = value => ({ value, selectionStart: value.length,
    getBoundingClientRect: () => ({ top: 400, bottom: 430, left: 0, width: 300 }) });
  ctx.tagEditorGetSuggestions('single', input('长'));
  await tick(120);
  const search = posted.filter(message => message.type === 'SUGGEST').at(-1);
  assert.equal(search.query, '长');
  ctx.tagEditorGetSuggestions('add', input('长发'));
  const result = { canonical: 'long_hair', animaTag: 'long hair', translation: '长发', category: 0, postCount: 6134076 };
  ctx._tdHandleMessage({ type: 'SUGGEST_RESULT', id: search.id, results: [result], localTags: [], localResults: [] });
  await tick(10);
  assert.equal(ctx.tagEditorSuggestions.length, 0);
  await tick(120);
  const current = posted.filter(message => message.type === 'SUGGEST').at(-1);
  ctx._tdHandleMessage({ type: 'SUGGEST_RESULT', id: current.id, results: [result], localTags: [], localResults: [] });
  await tick(10);
  assert.equal(ctx._teSuggestField, 'add');
  assert.equal(ctx.tagEditorSuggestions[0].count, 6134076);
  ctx.tagEditorGetSuggestions('new', input('长发'));
  await tick(120);
  const closed = posted.filter(message => message.type === 'SUGGEST').at(-1);
  ctx.tagEditorBlurSuggest();
  ctx._tdHandleMessage({ type: 'SUGGEST_RESULT', id: closed.id, results: [result], localTags: [], localResults: [] });
  await tick(220);
  assert.equal(ctx.tagEditorSuggestions.length, 0);
});

test('worker returns capped search and exact local metadata in one suggestion response', () => {
  const TD = loadLib();
  const posted = [];
  const self = { TagDictionary: TD, location: { search: '' }, postMessage: message => posted.push(message) };
  const context = { self, importScripts() {} };
  vm.runInNewContext(fs.readFileSync(WORKER, 'utf8'), context);
  context.index = TD.createIndex([
    ['back_bow', '背后的蝴蝶结', 0, 43700, ''],
    ['gradient_background', '渐变背景', 0, 18700, '']
  ]);
  self.onmessage({ data: { type: 'SUGGEST', id: 7, query: 'back', limit: 1, sourceTags: ['gradient background'] } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'SUGGEST_RESULT');
  assert.deepEqual(plain(posted[0].results).map(item => item.canonical), ['back_bow']);
  assert.deepEqual(plain(posted[0].localTags), ['gradient background']);
  assert.equal(posted[0].localResults[0].canonical, 'gradient_background');
  self.onmessage({ data: { type: 'SUGGEST', id: 8, query: 'back', limit: 1,
    sourceTags: ['gradient background', 'blue eyes'] } });
  assert.deepEqual(plain(posted[1].localTags), ['gradient background']);
  assert.equal(posted[1].localResults[0].canonical, 'gradient_background');
  self.onmessage({ data: { type: 'SUGGEST', id: 9, query: '渐变', limit: 20, existingOnly: true,
    sourceTags: ['gradient_background', 'GRADIENT_BACKGROUND', 'blue eyes'] } });
  assert.deepEqual(plain(posted[2].results), []);
  assert.deepEqual(plain(posted[2].localTags), ['gradient_background']);
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

test('dictionary primary action checks current data and downloads available updates', () => {
  const { ctx } = makeClient();
  let checked = 0, downloaded = 0;
  ctx.tagDictionaryCheckUpdate = force => { assert.equal(force, true); checked++; };
  ctx.tagDictionaryInstall = force => { assert.equal(force, true); downloaded++; };
  ctx.tagDictionaryServer = { ...INSTALLED, update: { state: 'current' } };
  assert.equal(ctx.tagDictionaryDataActionLabel(), 'environment.dictCheckUpdate');
  ctx.tagDictionaryDataAction();
  assert.equal(checked, 1);
  assert.equal(downloaded, 0);
  ctx.tagDictionaryServer.update.state = 'available';
  assert.equal(ctx.tagDictionaryDataActionLabel(), 'tagEditor.dictUpdate');
  ctx.tagDictionaryDataAction();
  assert.equal(downloaded, 1);
});

test('dictionary polling recovers after a temporary status failure', async () => {
  const { ctx } = makeClient();
  let calls = 0;
  ctx.tagDictionaryInstalling = true;
  ctx.tagDictionaryRefreshStatus = async () => ++calls === 1 ? null : { ...INSTALLED, status: 'ready' };
  ctx.tagDictionaryCheckUpdate = () => {};
  ctx._tdPollInstall();
  await tick(18);
  assert.equal(ctx.tagDictionaryInstalling, true);
  assert.equal(ctx.tagDictionaryReconnecting, true);
  await tick(60);
  assert.equal(ctx.tagDictionaryInstalling, false);
  assert.equal(ctx.tagDictionaryReconnecting, false);
  assert.equal(ctx.tagDictionaryInstallError, '');
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
  const el = { value: '  长发, 黑', selectionStart: 8 };
  const previous = ctx._teSuggestSeq;
  ctx.tagEditorGetSuggestions('single', el);
  assert.ok(ctx._teSuggestSeq > previous);
  assert.equal(ctx.tagEditorSuggestions.length, 0);
  ctx._teCloseSuggestions();
  await tick(80);
  assert.equal(ctx.tagEditorSuggestions.length, 0);
});

test('suggestions can load every match beyond the former local and dictionary limits', async () => {
  const TD = loadLib();
  const records = Array.from({ length: 75 }, (_, i) => [`hair_${i}`, `发型${i}`, 0, 1000 - i, '']);
  const index = TD.createIndex(records);
  assert.equal(TD.search(index, 'hair', 75).length, 75);
  const { ctx } = makeClient();
  ctx.tagEditorTagFreq = records.slice(0, 25).map(record => ({ tag: record[0].replaceAll('_', ' ') }));
  const replies = [];
  ctx.tagDictionaryComplete = async (query, options) => {
    replies.push(options);
    const localTags = TD.filterTags(index, options.sourceTags, query).slice(0, options.limit);
    const localResults = localTags.map(tag => TD.lookup(index, tag).result);
    ctx.tagDictionaryMetaFor = tag => TD.lookup(index, tag)?.result;
    return { localTags, results: TD.search(index, query, options.limit), localResults };
  };
  const el = { value: 'hair', selectionStart: 4,
    getBoundingClientRect: () => ({ top: 400, bottom: 430, left: 0, width: 300 }) };
  ctx.tagEditorGetSuggestions('single', el);
  await tick(120);
  assert.equal(ctx.tagEditorSuggestions.length, 20);
  assert.equal(ctx.tagEditorSuggestions[19].insert, 'hair 19');
  assert.equal(ctx.tagEditorSuggestHasMore, true);
  while (ctx.tagEditorSuggestHasMore) await ctx.tagEditorMoreSuggestions();
  assert.equal(ctx.tagEditorSuggestions.length, 75);
  assert.equal(ctx.tagEditorSuggestions[74].count, 926);
  assert.equal(new Set(ctx.tagEditorSuggestions.map(item => item.insert)).size, 75);
  assert.ok(replies.at(-1).limit > 50);
});

test('short prefixes include popular matches anywhere in the dictionary and remain fully pageable', () => {
  const TD = loadLib();
  const records = [['azzzzz', '', 0, 30000, ''],
    ...Array.from({ length: 21000 }, (_, i) => [`a${String(i).padStart(5, '0')}`, '', 0, 21000 - i, ''])];
  const index = TD.createIndex(records);
  assert.equal(TD.search(index, 'a', 20)[0].canonical, 'azzzzz');
  assert.equal(TD.search(index, 'a', records.length).length, records.length);
});

test('offline completion still loads all local matches and respects the selected scope', async () => {
  const { ctx } = makeClient();
  ctx.tagEditorTagFreq = Array.from({ length: 65 }, (_, i) => ({ tag: `custom_tag_${i}` }));
  ctx.tagEditorGetSelectedStats = () => ctx.tagEditorTagFreq.slice(0, 3);
  const el = { value: 'custom tag', selectionStart: 10,
    getBoundingClientRect: () => ({ top: 80, bottom: 110, left: 1000, width: 150 }) };
  ctx.tagEditorGetSuggestions('add', el);
  await tick(120);
  while (ctx.tagEditorSuggestHasMore) await ctx.tagEditorMoreSuggestions();
  assert.equal(ctx.tagEditorSuggestions.length, 65);
  assert.equal(ctx._teSuggestCoords.top, '114px');
  ctx.tagEditorGetSuggestions('remove', el);
  await tick(120);
  assert.equal(ctx.tagEditorSuggestions.length, 3);
  assert.equal(ctx.tagEditorSuggestHasMore, false);
});

test('all tag fields replace the token at the caret and share keyboard selection', async () => {
  const { ctx } = makeClient();
  for (const field of ['single', 'add', 'remove', 'old', 'new']) {
    const key = { single: 'tagEditorAddInput', add: 'batchAddInput', remove: 'batchRemoveInput', old: 'batchOldTag', new: 'batchNewTag' }[field];
    const val = field === 'old' || field === 'new' ? 'hair' : 'hair, solo';
    ctx[key] = val;
    let caret;
    const el = { value: val, selectionStart: 2, focus() {}, setSelectionRange(pos) { caret = pos; } };
    ctx.tagEditorGetSuggestions(field, el);
    ctx.tagEditorSuggestions = [{ insert: 'long hair' }];
    ctx.tagEditorSuggestIdx = 0;
    const event = { key: 'Tab', preventDefault() {}, stopPropagation() {} };
    ctx.tagEditorSuggestKeydown(event, field);
    assert.equal(ctx[key], field === 'old' || field === 'new' ? 'long hair' : 'long hair, solo');
    assert.equal(caret, 9);
    assert.equal(ctx.tagEditorSuggestions.length, 0);
  }
  await tick(120);
  assert.equal(ctx.tagEditorSuggestions.length, 0);
});

test('dictionary enrichment preserves the active tag while loading more keeps existing rows', async () => {
  const { ctx } = makeClient();
  ctx._teSuggestField = 'add';
  ctx._teSuggestQuery = 'hair';
  ctx.tagEditorTagFreq = [{ tag: 'long hair' }];
  ctx._teSuggestInputEl = { getBoundingClientRect: () => ({ top: 400, bottom: 430, left: 0, width: 300 }) };
  ctx._teSetSuggestions([{ insert: 'long hair' }, { insert: 'black hair' }], 20);
  ctx.tagEditorSuggestIdx = 1;
  ctx._teSetSuggestions([{ insert: 'hair' }, { insert: 'long hair' }, { insert: 'black hair' }], 20);
  assert.equal(ctx.tagEditorSuggestIdx, 2);
  let resolve;
  ctx.tagDictionaryComplete = () => new Promise(done => { resolve = done; });
  ctx.tagEditorSuggestHasMore = true;
  const more = ctx.tagEditorMoreSuggestions();
  assert.deepEqual(plain(ctx.tagEditorSuggestions).map(item => item.insert), ['hair', 'long hair', 'black hair']);
  ctx._teCloseSuggestions();
  resolve({ localTags: ['long hair'], results: [] });
  await more;
  assert.equal(ctx.tagEditorSuggestions.length, 0);
});
