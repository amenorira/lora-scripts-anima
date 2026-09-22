const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const pending = [];
  const context = { window: {}, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch(url, options) { return new Promise((resolve, reject) => pending.push({ url, options, resolve, reject })); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tag-editor.js'), 'utf8'), context);
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorSessionId: 'A', tagEditorImages: [], tagEditorPageItems: [],
    tagEditorOriginal: {}, _teEditVersions: {}, _teCaptionRevisions: {}, _tePathIndex: {}, _tePageCache: {},
    _tdRequestChips() {}, _teInvalidateFilter() {}, _teFlushAllPendingTextEdits() {}, _updateEditorPanel() {},
    toast() { throw new Error('Unexpected toast'); }, t: key => key,
  });
  const reply = (index, data) => pending[index].resolve({ json: async () => ({ status: 'success', data }) });
  return { app, pending, reply };
}

test('cached navigation cancels older page and restores counts as well as images', async () => {
  const { app, pending, reply } = fixture();
  app._teApplySessionPage({ page: 1, total: 90, total_pages: 2, items: [{ path: '/a', tags: '' }] }, true);
  const request = app.tagEditorFetchPage(2);
  app.tagEditorFilteredTotal = 5;
  await app.tagEditorFetchPage(1);
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(app.tagEditorFilteredTotal, 90);
  reply(0, { page: 2, total: 90, items: [{ path: '/old', tags: '' }] });
  await request;
  assert.equal(app.tagEditorPage, 1);
  assert.equal(app.tagEditorPageItems[0].path, '/a');
});

test('switching to modified filter immediately invalidates pending page', async () => {
  const { app, reply } = fixture();
  const request = app.tagEditorFetchPage(2);
  app.tagEditorQuickFilter = 'modified';
  app._teGetModified = () => [{ path: '/draft' }];
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

test('select all under modified filter selects only local drafts', async () => {
  const { app, pending } = fixture();
  app.tagEditorQuickFilter = 'modified';
  app._teGetModified = () => [{ path: '/draft' }];
  await app.tagEditorSelectFiltered();
  assert.deepEqual(Array.from(app.tagEditorSelected), ['/draft']);
  assert.equal(pending.length, 0);
});

test('late network failure from old dataset is ignored without changing new loading state', async () => {
  const { app, pending } = fixture();
  const request = app.tagEditorSelectFiltered();
  app._teLoadEpoch++;
  app.tagEditorSessionId = 'B';
  app._teSearchLoading = true;
  pending[0].reject(new Error('network down'));
  await request;
  assert.equal(app._teSearchLoading, true);
});
