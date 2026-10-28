const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor } = require('./helpers.cjs');

function fixture() {
  const pending = [];
  const context = { window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch(url, options) { return new Promise((resolve, reject) => pending.push({ url, options, resolve, reject })); } };
  loadTagEditor( context);
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorSessionId: 'A', tagEditorImages: [], tagEditorPageItems: [],
    tagEditorOriginal: {}, _teEditVersions: {}, _teCaptionRevisions: {}, _tePathIndex: {}, _tePageCache: {},
    _tdRequestChips() {}, _teInvalidateFilter() {}, _teFlushAllPendingTextEdits() {}, _updateEditorPanel() {},
    toast() { throw new Error('Unexpected toast'); }, t: key => key,
  });
  const reply = (index, data) => pending[index].resolve({ json: async () => ({ status: 'success', data }) });
  return { app, pending, reply };
}

test('switching to modified filter immediately invalidates pending page', async () => {
  const { app, reply } = fixture();
  const request = app.tagEditorFetchPage(2);
  app.tagEditorQuickFilter = 'modified';
  app._teGetModified = () => [{ path: '/draft', name: 'draft.png', tags: 'draft' }];
  app.tagEditorSchedulePageFetch(true);
  reply(0, { page: 2, items: [{ path: '/old' }] });
  await request;
  assert.equal(app.tagEditorPageItems[0].path, '/draft');
});

test('bulk loading cannot merge or select the previous dataset after a switch', async () => {
  const { app, reply } = fixture();
  const request = app.tagEditorSelectFiltered();
  app.tagEditorSessionId = 'B';
  app._teLoadEpoch++;
  app._teMergeSessionItems([{ path: '/B/image', tags: 'b' }], true);
  app.tagEditorSelected = ['/B/image'];
  app._teSearchLoading = true;
  reply(0, { total_pages: 2, generation: 1, items: [{ path: '/A/image', tags: 'a' }] });
  await request;
  assert.deepEqual(Array.from(app.tagEditorImages, x => x.path), ['/B/image']);
  assert.deepEqual(app.tagEditorSelected, ['/B/image']);
  assert.equal(app._teSearchLoading, true);
});

test('bulk loading refuses a changed filter and a changed session generation', async () => {
  let f = fixture();
  const changedFilter = f.app._teFetchAllSessionItems(true);
  f.app.tagEditorSearchQuery = 'new';
  f.reply(0, { total_pages: 1, items: [{ path: '/old' }] });
  await assert.rejects(changedFilter, { name: 'AbortError' });
  assert.equal(f.app.tagEditorImages.length, 0);

  f = fixture();
  const changedGeneration = f.app._teFetchAllSessionItems(false);
  f.reply(0, { total_pages: 2, generation: 1, items: [{ path: '/first' }] });
  await new Promise(resolve => setImmediate(resolve));
  f.reply(1, { total_pages: 2, generation: 2, items: [{ path: '/second' }] });
  await assert.rejects(changedGeneration);
  assert.equal(f.app.tagEditorImages.length, 0);
});

test('bulk paging keeps drafts and visible page, and uses one fixed session', async () => {
  const { app, pending, reply } = fixture();
  app._teMergeSessionItems([{ path: '/first', tags: 'original' }], true);
  app.tagEditorImages[0].tags = 'draft';
  const request = app._teFetchAllSessionItems(false);
  reply(0, { total_pages: 2, generation: 1, items: [{ path: '/first', tags: 'server' }] });
  await new Promise(resolve => setImmediate(resolve));
  reply(1, { total_pages: 2, generation: 1, items: [{ path: '/second', tags: 'second' }] });
  const images = await request;
  assert.equal(images[0].tags, 'draft');
  assert.equal(images.length, 2);
  assert.equal(app.tagEditorPageItems.length, 1);
  assert.ok(pending.every(p => p.url.includes('/sessions/A/images?')));
  assert.equal(app._teAllAbort, null);
});

test('normal pages query sparse raw drafts without advancing the saved baseline', async () => {
  const { app, pending, reply } = fixture();
  app._teMergeSessionItems([{ path: '/a', tags: '\uFEFF  old\r\n', caption_revision: 'original' }, { path: '/b', tags: 'clean' }], true);
  const raw = '\uFEFF  新正文\r\n\r\n';
  app.tagEditorImages[0].tags = raw;
  app.tagEditorSearchQuery = '新正文';
  const request = app.tagEditorFetchPage(1, { force: true });
  assert.equal(pending[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(pending[0].options.body), { '/a': raw });
  reply(0, { total: 1, items: [{ path: '/a', tags: raw }] });
  assert.equal(await request, true);
  assert.equal(app.tagEditorOriginal['/a'], '\uFEFF  old\r\n');
  assert.equal(app._teCaptionRevisions['/a'], 'original');
  assert.equal(app.tagEditorPageItems[0].tags, raw);
});

test('caption changes invalidate page caches and late responses, including undo to clean', async () => {
  const { app, pending, reply } = fixture();
  app._teMergeSessionItems([{ path: '/a', tags: 'old' }], true);
  app._teUpdateFreq = app.tagDictionarySyncChips = app._teRemoveDraft = () => {};
  const oldKey = app._teSessionQueryKey(1);
  const request = app.tagEditorFetchPage(2, { force: true });
  app._teUpdateImageTags(app.tagEditorImages[0], 'new');
  assert.notEqual(app._teSessionQueryKey(1), oldKey);
  assert.deepEqual(Object.keys(app._tePageCache), []);
  reply(0, { items: [{ path: '/stale', tags: 'old' }] });
  assert.equal(await request, false);
  app._teUpdateImageTags(app.tagEditorImages[0], 'old');
  const clean = app.tagEditorFetchPage(1);
  assert.equal(pending[1].options.method, undefined);
  reply(1, { items: [{ path: '/a', tags: 'old' }] });
  assert.equal(await clean, true);
});

test('filtered bulk selection uses one caption snapshot and rejects edits between pages', async () => {
  const { app, pending, reply } = fixture();
  app._teMergeSessionItems([{ path: '/a', tags: 'old' }], true);
  app.tagEditorImages[0].tags = 'draft';
  const request = app._teFetchAllSessionItems(true);
  assert.deepEqual(JSON.parse(pending[0].options.body), { '/a': 'draft' });
  reply(0, { total_pages: 2, generation: 1, items: [{ path: '/a', tags: 'draft' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[1].options.body, pending[0].options.body);
  app._teInvalidateCaptionQuery();
  reply(1, { total_pages: 2, generation: 1, items: [] });
  await assert.rejects(request, { name: 'AbortError' });
});

test('no-caption count includes current edits and undo without a full dataset download', () => {
  const { app } = fixture();
  app._teMergeSessionItems([{ path: '/a', tags: 'old' }, { path: '/b', tags: '' }], true);
  app.tagEditorNoTagCount = 10;
  app.tagEditorImages[0].tags = ' \r\n';
  assert.equal(app.tagEditorGetQuickCount('notag'), 11);
  app.tagEditorImages[1].tags = 'new';
  assert.equal(app.tagEditorGetQuickCount('notag'), 10);
  app.tagEditorImages[0].tags = 'old';
  assert.equal(app.tagEditorGetQuickCount('notag'), 9);
});
