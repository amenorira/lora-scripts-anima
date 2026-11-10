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

test('a newer selection or explicit clear supersedes an in-flight bulk selection', async () => {
  for (const selectDataset of [false, true]) for (const selectAnother of [true, false]) {
    const { app, reply } = fixture();
    app._updateEditorPanel = function() { ++this._teNavRequest; };
    const items = [{ path: '/a', tags: 'a' }, { path: '/b', tags: 'b' }];
    app._teMergeSessionItems(items, true);
    app.tagEditorSelected = ['/a'];
    const selecting = selectDataset ? app.tagEditorSelectDataset() : app.tagEditorSelectFiltered();
    if (selectAnother) app.tagEditorCardClick(items[1], 1, {});
    else app.tagEditorClearSelection();
    reply(0, { generation: 1, total_pages: 1, items });
    await selecting;
    assert.deepEqual(Array.from(app.tagEditorSelected), selectAnother ? ['/b'] : []);
  }
});

test('manual selection change aborts an obsolete dataset-wide request', async () => {
  const {app, context, pending, reply}=fixture();
  app._updateEditorPanel=context.window.tagEditorMixin._updateEditorPanel;
  app.tagDictionarySyncChips=()=>{};
  app._teCloseSuggestions=()=>{};
  app._teMergeSessionItems([{path:'/a', tags:'original'}], true);
  app.tagEditorSelected=['/a'];
  const selecting=app.tagEditorSelectDataset();
  app.tagEditorClearSelection();
  assert.equal(pending[0].options.signal.aborted, true);
  reply(0, {generation:1, total_pages:1, items:[{path:'/a', tags:'original'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), []);
  assert.equal(app._teSearchLoading, false);
});

test('replacing one bulk selection with another keeps the new request and loading state', async () => {
  for (const datasetFirst of [false, true]) {
    const {app, pending, reply}=fixture();
    const first=datasetFirst ? app.tagEditorSelectDataset() : app.tagEditorSelectFiltered();
    const second=datasetFirst ? app.tagEditorSelectFiltered() : app.tagEditorSelectDataset();
    assert.equal(pending[0].options.signal.aborted, true);
    reply(0, {generation:1, total_pages:1, items:[{path:'/old', tags:'old'}]});
    await first;
    assert.equal(pending[1].options.signal.aborted, false);
    assert.equal(app._teSearchLoading, true);
    reply(1, {generation:1, total_pages:1, items:[{path:'/new', tags:'new'}]});
    await second;
    assert.deepEqual(Array.from(app.tagEditorSelected), ['/new']);
    assert.equal(app._teSearchLoading, false);
  }
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

test('filter and page refreshes do not cancel an in-flight dataset selection', async () => {
  const {app, pending, reply} = fixture();
  app._teMergeSessionItems([{path:'/a', name:'a', tags:'blue'}], true);
  const selecting = app.tagEditorSelectDataset();
  app.tagEditorSearchQuery = 'blue';
  app.tagEditorSchedulePageFetch(true);
  assert.equal(pending[0].options.signal.aborted, false);
  assert.equal(app._teSearchLoading, true);
  const refreshing = app.tagEditorFetchPage(1, {force:true});
  reply(1, {generation:1, total:1, total_pages:1, items:[{path:'/a', name:'a', tags:'blue'}]});
  await refreshing;
  assert.equal(app._teSearchLoading, true);
  reply(0, {generation:1, total_pages:1, items:[{path:'/a', tags:'blue'}, {path:'/b', tags:'red'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), ['/a', '/b']);
  assert.equal(app.tagEditorSearchQuery, 'blue');
  assert.equal(app._teSearchLoading, false);
});

test('a stale dataset selection cannot replace a newer page generation', async () => {
  const {app, pending, reply}=fixture();
  const notices=[];
  app.toast=(...args)=>notices.push(args);
  app._teExternalGeneration=1;
  app.tagEditorSessionGeneration=1;
  app._teMergeSessionItems([{path:'/a', tags:'old'}], true);
  app.tagEditorSelected=[];
  const selecting=app.tagEditorSelectDataset();
  app.tagEditorSearchQuery='new';
  const refreshing=app.tagEditorFetchPage(1, {force:true});
  reply(1, {generation:2, total:1, total_pages:1, items:[{path:'/b', tags:'new'}]});
  await refreshing;
  reply(0, {generation:1, total_pages:1, items:[{path:'/a', tags:'old'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), []);
  assert.deepEqual(Array.from(app.tagEditorPageItems, item=>item.path), ['/b']);
  assert.deepEqual(notices, [['tagEditor.selectDatasetChanged','warning']]);
});

test('an external change after loading but before applying cancels dataset selection', async () => {
  const {app, reply}=fixture();
  const notices=[];
  app.toast=(...args)=>notices.push(args);
  app._teApplyTagFreq=()=>{};
  app.tagEditorSchedulePageFetch=()=>{};
  app._teExternalGeneration=1;
  app.tagEditorSessionGeneration=1;
  app._teMergeSessionItems([{path:'/a', tags:'old'}], true);
  app.tagEditorSelected=[];
  const fetchAll=app._teFetchAllSessionItems;
  app._teFetchAllSessionItems=async function(...args) {
    const images=await fetchAll.apply(this,args);
    this._teApplyExternalChanges({generation:2, count:2, no_tag_count:0, tags:[],
      changed_images:[{path:'/b', tags:'new'}], removed_paths:[], unreadable_paths:[]});
    return images;
  };
  const selecting=app.tagEditorSelectDataset();
  reply(0, {generation:1, total_pages:1, items:[{path:'/a', tags:'old'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), []);
  assert.deepEqual(notices, [['tagEditor.selectDatasetChanged','warning']]);
});

test('a filter change after loading but before applying cancels filtered selection', async () => {
  const {app, reply}=fixture();
  app._teMergeSessionItems([{path:'/a', tags:'old'}], true);
  app.tagEditorSelected=[];
  const fetchAll=app._teFetchAllSessionItems;
  app._teFetchAllSessionItems=async function(...args) {
    const images=await fetchAll.apply(this,args);
    this.tagEditorSearchQuery='new';
    this.tagEditorSchedulePageFetch(true);
    return images;
  };
  const selecting=app.tagEditorSelectFiltered();
  reply(0, {generation:1, total_pages:1, items:[{path:'/a', tags:'old'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), []);
  app._teCancelPageFetch();
});

test('modified-image selection checks filters, captions and dataset generation before applying', async () => {
  for (const change of ['filter', 'caption', 'generation']) {
    const {app}=fixture();
    const notices=[];
    app.toast=(...args)=>notices.push(args);
    app.tagEditorQuickFilter='modified';
    app.tagEditorSessionGeneration=1;
    app.tagEditorSelected=[];
    app._teGetModified=()=>[{path:'/a', name:'a', tags:'draft'}];
    const fetchAll=app._teFetchAllSessionItems;
    app._teFetchAllSessionItems=async function(...args) {
      const images=await fetchAll.apply(this,args);
      if (change==='filter') this.tagEditorQuickFilter='all';
      if (change==='caption') this._teCaptionQueryVersion++;
      if (change==='generation') this.tagEditorSessionGeneration++;
      return images;
    };
    await app.tagEditorSelectFiltered();
    assert.deepEqual(Array.from(app.tagEditorSelected), []);
    assert.deepEqual(notices, change==='generation' ? [['tagEditor.datasetChangedRetry','warning']] : []);
  }
});

test('a newer page seen after loading prevents applying an older dataset selection', async () => {
  const {app, reply}=fixture();
  const notices=[];
  app.toast=(...args)=>notices.push(args);
  app._teExternalGeneration=1;
  app.tagEditorSessionGeneration=1;
  app._teMergeSessionItems([{path:'/a', tags:'old'}], true);
  app.tagEditorSelected=[];
  const fetchAll=app._teFetchAllSessionItems;
  app._teFetchAllSessionItems=async function(...args) {
    const images=await fetchAll.apply(this,args);
    this._teApplySessionPage({generation:2, total:1, total_pages:1, items:[{path:'/b', tags:'new'}]},false);
    return images;
  };
  const selecting=app.tagEditorSelectDataset();
  reply(0, {generation:1, total_pages:1, items:[{path:'/a', tags:'old'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), []);
  assert.deepEqual(notices, [['tagEditor.selectDatasetChanged','warning']]);
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

test('a pending search stays loading when a page and dataset selection finish', async () => {
  const {app, pending, reply}=fixture();
  app._teMergeSessionItems([{path:'/a', name:'a', tags:'blue'}], true);
  const selecting=app.tagEditorSelectDataset();
  const refreshing=app.tagEditorFetchPage(1, {force:true});
  app.tagEditorSetSearch('blue');
  reply(1, {generation:1, total:1, total_pages:1, items:[{path:'/a', name:'a', tags:'blue'}]});
  await refreshing;
  assert.equal(app._teSearchLoading, true);
  reply(0, {generation:1, total_pages:1, items:[{path:'/a', name:'a', tags:'blue'}]});
  await selecting;
  assert.equal(app._teSearchLoading, true);
  await new Promise(resolve=>setTimeout(resolve,170));
  assert.equal(app.tagEditorSearchQuery, 'blue');
  assert.equal(app._teSearchLoading, true);
  const filtered=app.tagEditorFetchPage(1, {force:true});
  reply(2, {generation:1, total:1, total_pages:1, items:[{path:'/a', name:'a', tags:'blue'}]});
  await filtered;
  assert.equal(app._teSearchLoading, false);
});

test('changing filters still cancels an in-flight filtered selection', async () => {
  const {app, pending, reply} = fixture();
  app._teMergeSessionItems([{path:'/a', tags:'original'}], true);
  app.tagEditorSelected=['/a'];
  const selecting=app.tagEditorSelectFiltered();
  app.tagEditorSearchQuery='new filter';
  app.tagEditorSchedulePageFetch(true);
  assert.equal(pending[0].options.signal.aborted, true);
  app._teCancelPageFetch();
  reply(0, {generation:1, total_pages:1, items:[{path:'/b', tags:'old filter'}]});
  await selecting;
  assert.deepEqual(Array.from(app.tagEditorSelected), ['/a']);
});

test('external dataset changes cancel dataset selection and warn only while it is current', async () => {
  for (const manuallyCleared of [false, true]) {
    const {app, pending, reply} = fixture();
    const notices=[];
    app._teExternalGeneration=1;
    app._teApplyTagFreq=()=>{};
    app.tagEditorSchedulePageFetch=()=>{};
    app._updateEditorPanel=function() { ++this._teNavRequest; };
    app.toast=(...args)=>notices.push(args);
    app._teMergeSessionItems([{path:'/a', tags:'original'}], true);
    app.tagEditorSelected=['/a'];
    const selecting=app.tagEditorSelectDataset();
    if (manuallyCleared) app.tagEditorClearSelection();
    app._teApplyExternalChanges({generation:2, count:1, no_tag_count:0, tags:[],
      changed_images:[{path:'/a', tags:'updated'}], removed_paths:[], unreadable_paths:[]});
    assert.equal(pending[0].options.signal.aborted, true);
    reply(0, {generation:1, total_pages:1, items:[{path:'/a', tags:'original'}]});
    await selecting;
    assert.deepEqual(notices, manuallyCleared ? [] : [['tagEditor.selectDatasetChanged','warning']]);
    assert.deepEqual(Array.from(app.tagEditorSelected), manuallyCleared ? [] : ['/a']);
  }
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

test('unreadable paths are reported once while other captions continue to refresh', () => {
  const { app } = fixture();
  const notices = [];
  app.tagEditorSchedulePageFetch = () => {};
  app._teApplyTagFreq = () => {};
  app.toast = (...args) => notices.push(args);
  app._teMergeSessionItems([{ path: '/a', tags: 'original' }, { path: '/b', tags: 'original' }], true);
  for (const [generation, tags, unreadable_paths] of [[2, 'first', ['/a']], [3, 'second', ['/a']], [4, 'fixed', []]]) {
    app._teApplyExternalChanges({ generation, count: 2, no_tag_count: 0, tags: [],
      changed_images: [{ path: '/b', tags }], removed_paths: [], unreadable_paths });
    assert.equal(app._teFindByPath('/b').tags, tags);
  }
  assert.equal(app._teFindByPath('/a').tags, 'original');
  assert.equal(notices.length, 1);
  assert.equal(notices[0][2].details, '/a');
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
