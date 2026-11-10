const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor } = require('./helpers.cjs');

function fixture(captions) {
  const context = { window: {} };
  loadTagEditor( context);
  const history = [], messages = [], writes = [];
  let confirmation;
  const images = captions.map((tags, i) => ({ path: String(i), name: String(i), tags }));
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorImages: images, tagEditorSelected: images.map(img => img.path),
    _teLoadEpoch: 1, _teFlushAllPendingTextEdits() {},
    t: key => key === 'tagEditor.batchPreviewDiff' ? '{n} images' : key,
    toast: (...args) => messages.push(args),
    _teConfirmBatch: (message, accept) => { confirmation = { message, accept }; },
    _teUpdateImageTags: (img, tags) => { writes.push(img.path); img.tags = tags; },
    _tePushHistory: meta => history.push(meta),
    tagDictionarySyncChips() {},
  });
  return { app, context, images, history, messages, writes, confirm: () => confirmation };
}

test('batch preview and commit use the same selected changes and count', () => {
  const f = fixture(['cat', 'cat, blue', 'dog']);
  f.app.tagEditorSelected = ['0', '1'];
  f.app.tagEditorBatchPos = 'back';
  f.app.batchAddInput = 'blue, blue';
  f.app.tagEditorBatchAdd();
  assert.match(f.confirm().message, /1 images/);
  assert.deepEqual(f.writes, []);
  f.app.tagEditorSelected = ['2']; // Confirmation retains the explicitly previewed scope.
  f.confirm().accept();
  assert.deepEqual(f.images.map(img => img.tags), ['cat, blue', 'cat, blue', 'dog']);
  assert.deepEqual(f.writes, ['0']);
  assert.equal(f.history[0].affected, 1);
  assert.equal(f.app.batchAddInput, '');
});

test('batch replacement renames every matching occurrence and preserves the other text', () => {
  const f = fixture(['\uFEFFblue, standing,\r\n blue, standing\r\n', 'blue, sitting', 'blue']);
  f.app.tagEditorSelected = ['0', '1'];
  f.app.batchOldTag = 'blue';
  f.app.batchNewTag = 'red';
  f.app.tagEditorBatchReplace();
  f.confirm().accept();
  assert.deepEqual(f.images.map(img => img.tags), ['\uFEFFred, standing,\r\n red, standing\r\n', 'red, sitting', 'blue']);
});

test('quick removal records every edit before syncing the dictionary once', () => {
  const f = fixture(Array(100).fill('blue, standing'));
  f.app.tagEditorOriginal = Object.fromEntries(f.images.map(img => [img.path, img.tags]));
  f.app._teUpdateImageTags = f.context.window.tagEditorMixin._teUpdateImageTags;
  f.app._teUpdateFreq = () => {};
  const synced = [];
  f.app.tagDictionarySyncChips = () => synced.push(f.images.filter(img => img.tags === 'standing').length);
  f.app.tagEditorQuickRemove = true;
  f.app.tagEditorRemovalTags = ['blue'];
  f.app.tagEditorApplyQuickRemove();
  assert.deepEqual(synced, [100]);
  assert.equal(f.history[0].affected, 100);
});

for (const change of ['dataset', 'caption']) {
  test(`confirmation rejects stale ${change} without partial changes`, () => {
    const f = fixture(['cat', 'dog']);
    f.app.batchAddInput = 'blue';
    f.app.tagEditorBatchAdd();
    if (change === 'dataset') f.app._teLoadEpoch++;
    else f.images[1].tags = 'new caption';
    f.confirm().accept();
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.history, []);
    assert.equal(f.app.batchAddInput, 'blue');
    assert.deepEqual(f.messages.at(-1), ['tagEditor.batchStale', 'warning']);
  });
}

test('global rename rejects stale scope after external refresh, even if a page already saw the new generation', async () => {
  const f = fixture(['cat', 'dog']);
  f.app.tagEditorSessionGeneration = 2;
  f.app._teExternalGeneration = 1;
  f.app.tagEditorInlineEdit = { scope: 'dataset', oldTag: 'cat', newTag: 'bird' };
  await f.app.tagEditorFinishInlineEdit();
  f.images[0].tags = '  external\r\n';
  f.images[1].tags = 'cat';
  f.app._teExternalGeneration = 2;
  f.confirm().accept();
  assert.deepEqual(f.images.map(img => img.tags), ['  external\r\n', 'cat']);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.messages.at(-1), ['tagEditor.batchStale', 'warning']);
});

for (const scope of ['selection', 'dataset']) {
  test(`${scope} rename syncs dictionary chips once after all updates`, async () => {
    const f = fixture(Array(100).fill('cat, dog'));
    f.app.tagEditorOriginal = Object.fromEntries(f.images.map(img => [img.path, img.tags]));
    f.app._teUpdateImageTags = f.context.window.tagEditorMixin._teUpdateImageTags;
    f.app._teUpdateFreq = () => {};
    const synced = [];
    f.app.tagDictionarySyncChips = () => synced.push(f.images.filter(img => img.tags === 'bird, dog').length);
    f.app.tagEditorInlineEdit = { scope, oldTag: 'cat', newTag: 'bird', selected: f.app.tagEditorSelected.slice() };

    await f.app.tagEditorFinishInlineEdit();
    assert.deepEqual(synced, []);
    f.confirm().accept();
    assert.deepEqual(synced, [100]);
    assert.equal(f.history[0].affected, 100);
  });
}
