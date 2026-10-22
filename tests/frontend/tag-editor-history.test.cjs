// Caption editing, stale confirmations, and undo/redo regressions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

// Caption edits and history need an isolated editor, without a dictionary worker.

function makeClient() {
  const context = { window: {} };
  context.window = context;
  context.console = { warn() {} };
  context.setTimeout = (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; };
  context.clearTimeout = clearTimeout;
  context.fetch = () => { throw new Error('Caption history must not access the network'); };
  context.localStorage = { _v: {}, getItem(k) { return k in this._v ? this._v[k] : null; }, setItem(k, v) { this._v[k] = String(v); } };
  context.navigator = { clipboard: { writeText() { return Promise.resolve(); } } };

  loadFrontend(['tag-dictionary-lib', 'tag-dictionary', 'tag-editor'], context);

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

  ctx.currentRoute = 'tagEditor';

  return { ctx, context };
}

test('archive and rollback failures preserve history and never report archived success', async () => {
  for (const failure of ['timeline', 'rollback']) {
    const { ctx, context } = makeClient();
    const notices = [];
    ctx.toast = message => notices.push(message);
    ctx.tagEditorDir = ctx.tagEditorLoadedDir = '/dataset';
    ctx.tagEditorImages = [{ path: 'a', tags: 'new' }];
    ctx.tagEditorOriginal = { a: 'old' };
    ctx.tagEditorHistory = [{ changes: { a: { before: null, after: 'new' } } }];
    ctx.tagEditorHistoryIdx = 0;
    ctx._teRecountModified = () => { ctx._teModifiedCount = failure === 'timeline' ? 0 : 1; };
    ctx._teSaveDraft = () => {};
    ctx._teRemoveDraft = () => assert.fail('failure must not discard the recovery draft');
    ctx.tagEditorLoadSnapshots = () => {};
    ctx.tagEditorReloadSessionPage = async () => {};
    context.fetch = async () => ({ json: async () => ({ status: 'success', data: failure === 'timeline'
      ? { saved: 1, saved_paths: ['a'], timeline_warning: 'disk full' }
      : { saved: 0, rollback_failed: ['a'], failed: [{ path: 'a' }] } }) });
    await ctx._doSaveAll(ctx.tagEditorImages);
    assert.equal(ctx.tagEditorHistory.length, 1);
    assert.equal(notices.length, 1);
    assert.equal(notices[0], failure === 'timeline' ? 'tagEditor.timelineSaveFailed' : 'tagEditor.rollbackFailed');
    if (failure === 'timeline') {
      assert.equal(ctx.tagEditorOriginal.a, 'new');
      assert.equal(ctx.tagEditorHistory[0].changes.a.before, 'old');
    }
  }
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
