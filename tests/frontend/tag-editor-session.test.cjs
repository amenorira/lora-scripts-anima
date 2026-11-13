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
  return { app, context, pending, reply };
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

test('dataset selection fetches every page without active filters and preserves drafts', async () => {
  const { app, pending, reply } = fixture();
  app._teExternalGeneration = 1;
  app._teMergeSessionItems([{ path:'/a', tags:'original', caption_revision:'a1' }], true);
  app._teFindByPath('/a').tags = 'draft';
  app.tagEditorSearchQuery = 'only matching';
  app.tagEditorQuickFilter = 'notag';
  app.tagEditorTagSelection = ['blue'];
  app.tagEditorExcludedTags = ['red'];
  const selecting = app.tagEditorSelectDataset();
  const params = new URL('http://localhost' + pending[0].url).searchParams;
  assert.equal(params.get('search'), '');
  assert.equal(params.get('quick_filter'), 'all');
  assert.equal(params.get('include_tags'), '');
  assert.equal(params.get('exclude_tags'), '');
  reply(0, { generation:1, total_pages:2, items:[{ path:'/a', tags:'original' }] });
  await new Promise(resolve => setImmediate(resolve));
  reply(1, { generation:1, total_pages:2, items:[{ path:'/b', tags:'other' }] });
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), ['/a', '/b']);
  assert.deepEqual(Array.from(app.tagEditorPageItems, image => image.path), ['/a']);
  assert.equal(app._teFindByPath('/a').tags, 'draft');
  assert.equal(app.tagEditorOriginal['/a'], 'original');
  assert.equal(app.tagEditorSearchQuery, 'only matching');
  assert.deepEqual(app.tagEditorTagSelection, ['blue']);
});

test('a changing dataset during multi-page selection is reported before applying selection', async () => {
  const {app, pending, reply}=fixture();
  const notices=[];
  app.toast=(...args)=>notices.push(args);
  app.tagEditorSessionGeneration=1;
  app._teMergeSessionItems([{path:'/a', tags:'old'}], true);
  app.tagEditorSelected=['/a'];
  const selecting=app.tagEditorSelectDataset();
  reply(0, {generation:1, total_pages:2, items:[{path:'/a', tags:'old'}]});
  await new Promise(resolve=>setImmediate(resolve));
  reply(1, {generation:2, total_pages:2, items:[{path:'/b', tags:'new'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), ['/a']);
  assert.deepEqual(notices, [['tagEditor.selectDatasetChanged','warning']]);
});

test('external removal keeps a dirty draft until revert, then discards its image and selection', () => {
  const { app } = fixture();
  app.tagEditorSchedulePageFetch = () => {};
  app._teApplyTagFreq = () => {};
  app.tagDictionarySyncChips = () => {};
  app._teRemoveDraft = () => {};
  app.toast = () => {};
  app._teMergeSessionItems([{ path: '/a', tags: 'original', caption_revision: 'a1' }], true);
  app.tagEditorSelected = ['/a'];
  app._teFindByPath('/a').tags = 'draft';
  app._teApplyExternalChanges({ generation: 2, count: 0, no_tag_count: 0, tags: [],
    changed_images: [], removed_paths: ['/a'] });
  assert.equal(app.tagEditorGetSelectedImg().tags, 'draft');
  assert.equal(app._teModifiedCount, 1);
  app.tagEditorRevertSelectedImage();
  assert.equal(app._teModifiedCount, 0);
  assert.equal(app._teFindByPath('/a'), null);
  assert.equal(app.tagEditorGetSelectedImg(), null);
  assert.equal(app.tagEditorGetBatchTargets().length, 0);
  assert.equal(app.tagEditorPageItems.length, 0);
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
