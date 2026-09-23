const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(captions) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tag-editor.js'), 'utf8'), context);
  const history = [], messages = [], writes = [];
  let confirmation;
  const images = captions.map((tags, i) => ({ path: String(i), tags }));
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorImages: images, tagEditorSelected: images.map(img => img.path),
    _teLoadEpoch: 1, _teFlushAllPendingTextEdits() {},
    t: key => key === 'tagEditor.batchPreviewDiff' ? '{n} images' : key,
    toast: (...args) => messages.push(args),
    _teConfirmBatch: (message, accept) => { confirmation = { message, accept }; },
    _teUpdateImageTags: (img, tags) => { writes.push(img.path); img.tags = tags; },
    _tePushHistory: meta => history.push(meta),
  });
  return { app, images, history, messages, writes, confirm: () => confirmation };
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

test('front insertion retains order and ignores duplicate additions', () => {
  const f = fixture(['cat']);
  f.app.tagEditorBatchPos = 'front';
  f.app.batchAddInput = 'blue, sky, blue';
  f.app.tagEditorBatchAdd();
  f.confirm().accept();
  assert.equal(f.images[0].tags, 'sky, blue, cat');
});

test('remove and replace preserve unaffected caption formatting', () => {
  const f = fixture(['cat, blue, cat', ' dog , sky ']);
  f.app.batchRemoveInput = 'cat';
  f.app.tagEditorBatchRemove();
  f.confirm().accept();
  assert.deepEqual(f.images.map(img => img.tags), ['blue', ' dog , sky ']);
  f.app.batchOldTag = 'blue';
  f.app.batchNewTag = 'dog';
  f.app.tagEditorBatchReplace();
  f.confirm().accept();
  assert.equal(f.images[0].tags, 'dog');
  assert.deepEqual(f.history.map(meta => meta.affected), [1, 1]);
});

test('no-op batches create no confirmation or history', () => {
  const f = fixture(['cat']);
  f.app.batchAddInput = 'cat';
  f.app.tagEditorBatchAdd();
  f.app.batchRemoveInput = 'dog';
  f.app.tagEditorBatchRemove();
  f.app.batchOldTag = 'cat';
  f.app.batchNewTag = 'cat';
  f.app.tagEditorBatchReplace();
  assert.equal(f.confirm(), undefined);
  assert.deepEqual(f.history, []);
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

test('deduplication retains tags named like object prototype properties', () => {
  const { app } = fixture([]);
  assert.deepEqual(Array.from(app._teDedupTags(['constructor', '__proto__', 'Cat', 'cat'])),
    ['constructor', '__proto__', 'Cat']);
});
