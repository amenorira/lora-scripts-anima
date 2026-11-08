const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor } = require('./helpers.cjs');

function fixture() {
  const pending = [];
  const context = { window: {}, document: { hidden: false }, URLSearchParams, AbortController, setTimeout, clearTimeout,
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

test('external refresh keeps a pending draft and its save revision while updating clean selections', async () => {
  const { app, pending, reply } = fixture();
  app.currentRoute = 'tagEditor';
  app._teExternalGeneration = 1;
  app._teApplyTagFreq = () => {};
  app.tagEditorSchedulePageFetch = () => {};
  const updatedPanels = [];
  app._updateEditorPanel = () => updatedPanels.push(app.tagEditorGetSelectedImg().tags);
  app._teMergeSessionItems([
    { path: '/a', tags: 'original', caption_revision: 'before' },
    { path: '/b', tags: 'clean', caption_revision: 'b1' },
  ], true);
  app.tagEditorSelected = ['/b'];
  const checking = app._teCheckExternalChanges();
  assert.match(pending[0].url, /refresh\?since_generation=1$/);
  app._teApplySessionPage({
    generation: 2, items: [{ path: '/a', tags: 'external', caption_revision: 'after' }],
  }, false);
  assert.equal(app._teFindByPath('/a').tags, 'original');
  app._teFindByPath('/a').tags = '\uFEFFdraft\r\n';
  reply(0, {
    generation: 2, revision: 'dataset2', count: 2, no_tag_count: 0, tags: [], removed_paths: [],
    changed_images: [
      { path: '/a', tags: 'external', caption_revision: 'after' },
      { path: '/b', tags: 'new clean', caption_revision: 'b2' },
    ],
  });
  await checking;
  assert.equal(app._teFindByPath('/a').tags, '\uFEFFdraft\r\n');
  assert.equal(app.tagEditorOriginal['/a'], 'external');
  assert.equal(app._teCaptionRevisions['/a'], 'before');
  assert.equal(app._teModifiedCount, 1);
  assert.equal(app._teExternalGeneration, 2);
  assert.equal(app._teCaptionRevisions['/b'], 'b2');
  assert.deepEqual(updatedPanels, ['new clean']);
});

test('a refresh response is ignored during IME input and after leaving the dataset', async () => {
  const { app, pending, reply } = fixture();
  app.currentRoute = 'tagEditor';
  app._teExternalGeneration = 1;
  let applied = 0;
  app._teApplyExternalChanges = () => { applied++; };
  const composing = app._teCheckExternalChanges();
  app._teDetailComposing = true;
  reply(0, { generation: 2 });
  await composing;
  await app._teCheckExternalChanges();
  assert.equal(pending.length, 1);
  app._teDetailComposing = false;
  const leaving = app._teCheckExternalChanges();
  app._teStopExternalRefresh();
  assert.equal(pending[1].options.signal.aborted, true);
  reply(1, { generation: 2 });
  await leaving;
  assert.equal(applied, 0);
  assert.equal(app._teExternalGeneration, 1);
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
