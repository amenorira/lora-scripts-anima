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
