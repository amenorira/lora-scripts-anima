const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor, response, deferred } = require('./helpers.cjs');

function fixture() {
  const raw = '\uFEFF  cat, dog\r\n';
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const context = { window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout,
    localStorage: storage, sessionStorage: storage };
  let create = () => response({ session_id: 'new', dir: '/dataset', count: 2, page: 1,
    items: [{ path: 'b', tags: 'other', caption_revision: 'b1' }], tags: [] });
  context.fetch = (url, options) => options?.method === 'DELETE' ? Promise.resolve(response({})) : Promise.resolve(create(url, options));
  loadTagEditor( context);
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorSessionId: 'old', tagEditorDir: '/dataset', tagEditorLoadedDir: '/dataset',
    tagEditorImages: [{ path: 'a', tags: raw }], tagEditorOriginal: { a: raw },
    tagEditorSelected: ['a'], tagEditorHistory: [], _teHistoryState: {}, _tePendingTextEdits: {},
    _teEditVersions: { a: 0 }, _teCaptionRevisions: { a: 'a1' }, _teDraftRemainder: [],
    _tdRequestChips() {}, _teUpdateFreq() {}, tagDictionarySyncChips() {},
    tagDictionaryInit() {}, tagDictionaryEnsureWorker() {},
    _teStartAutoSave() {}, _teStopAutoSave() {}, tagEditorLoadSnapshots() {},
    startProgress() {}, finishProgress() {}, toast() {}, t: key => key,
    _teCheckDraft() { assert.fail('memory recovery must not reopen an old draft prompt'); },
  });
  return { app, raw, create: fn => { create = fn; } };
}

test('session recovery flushes text history and preserves raw undo/redo and selection off page', async () => {
  const { app, raw } = fixture();
  app.tagEditorImages[0].preview = '/api/image-preview?scope=dataset&session_id=old&path=a.png&variant=preview&size=960';
  app.tagEditorImages[0].thumbnail = '/api/image-preview?scope=dataset&session_id=old&path=a.png&variant=thumb&size=320';
  app.tagEditorDetailTextChange({ target: { value: '  edited\n' } });
  const edited = app.tagEditorImages[0].tags;
  assert.equal(app.tagEditorHistory.length, 0);
  app._teDraftRemainder = [{ path: 'missing', tags: 'pending' }];
  await app.tagEditorReloadSessionPage(1);
  assert.equal(app.tagEditorHistory.length, 1);
  assert.deepEqual(Array.from(app.tagEditorSelected), ['a']);
  assert.equal(app.tagEditorGetSelectedImg().tags, edited);
  for (const field of ['preview', 'thumbnail']) {
    const params = new URLSearchParams(app.tagEditorGetSelectedImg()[field].split('?')[1]);
    assert.equal(params.get('session_id'), 'new');
    assert.equal(params.get('path'), 'a.png');
  }
  assert.equal(app._teCaptionRevisions.a, 'a1');
  assert.equal(app._teDraftRemainder[0].tags, 'pending');
  app.tagEditorUndo();
  assert.equal(app.tagEditorGetSelectedImg().tags, raw);
  app.tagEditorRedo();
  assert.equal(app.tagEditorGetSelectedImg().tags, edited);
});

test('failed automatic recovery retains unsaved state for a normal load retry', async () => {
  const f = fixture();
  f.app.tagEditorDetailTextChange({ target: { value: 'unsaved' } });
  const savedCreate = () => response({ session_id: 'retry', dir: '/dataset', items: [], tags: [] });
  f.create(() => { throw new Error('offline'); });
  await f.app.tagEditorReloadSessionPage(1);
  assert.equal(f.app.tagEditorSessionId, '');
  assert.ok(f.app._teSessionRecovery);
  f.create(savedCreate);
  await f.app.tagEditorLoad('/dataset');
  assert.equal(f.app._teFindByPath('a').tags, '\uFEFFunsaved');
  assert.equal(f.app.tagEditorHistory.length, 1);
  assert.equal(f.app._teSessionRecovery, null);
});

test('a dataset switch supersedes recovery, and an already cleared save history stays cleared', async () => {
  let f = fixture();
  const wait = deferred();
  f.create(() => wait.promise);
  const recovering = f.app.tagEditorReloadSessionPage(1);
  f.create(() => response({ session_id: 'other', dir: '/other', items: [], tags: [] }));
  f.app._teCheckDraft = () => {};
  await f.app.tagEditorLoad('/other');
  wait.resolve(response({ session_id: 'stale', dir: '/dataset', items: [], tags: [] }));
  await recovering;
  assert.equal(f.app.tagEditorSessionId, 'other');
  assert.equal(f.app._teSessionRecovery, null);
  assert.equal(f.app.tagEditorImages.length, 0);
  f = fixture();
  await f.app.tagEditorReloadSessionPage(1);
  assert.equal(f.app.tagEditorHistory.length, 0);
  assert.equal(f.app.tagEditorHistoryIdx, -1);
});
