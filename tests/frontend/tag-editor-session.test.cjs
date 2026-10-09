const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('directory counts use the full server result and all local drafts across pages', () => {
  const { app } = fixture();
  const image = { path: '/b/one', rel_path: 'b/one.png', tags: '' };
  app._teApplySessionPage({ page: 2, items: [image], directory_counts: { b: 10 } }, true);
  assert.equal(app.tagEditorDirectoryImageCount(image), 10);
  app.tagEditorQuickFilter = 'modified';
  app._teGetModified = () => [image, { path: '/b/two', rel_path: 'b/two.png' }, { path: '/a/one', rel_path: 'a/one.png' }];
  assert.equal(app.tagEditorDirectoryImageCount(image), 2);
  app.tagEditorSessionId = '';
  app.tagEditorGetFiltered = () => [image, { rel_path: 'b/two.png' }, { rel_path: 'b/nested/one.png' }];
  assert.equal(app.tagEditorDirectoryImageCount(image), 2);
});

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

test('directory grouping keeps local sort inside root and nested folders before paging', () => {
  const { app } = fixture();
  app.tagEditorSessionId = '';
  app.tagEditorSortBy = 'tagCount';
  app.tagEditorSortAsc = false;
  app.tagEditorImages = [
    { path: '/a/low', rel_path: 'a/low.png', tags: 'one' },
    { path: '/b/high', rel_path: 'b/high.png', tags: 'one, two, three' },
    { path: '/a/high', rel_path: 'a\\high.png', tags: 'one, two' },
    { path: '/root', rel_path: 'root.png', tags: '' },
    { path: '/nested', rel_path: 'a/nested/image.png', tags: 'one' },
  ];
  const flat = Array.from(app.tagEditorGetFiltered(), img => img.path);
  app.tagEditorGroupByDir = true;
  app.tagEditorPageSize = 3;
  assert.deepEqual(Array.from(app.tagEditorGetPaged(), img => img.path), ['/root', '/a/high', '/a/low']);
  assert.equal(app.tagEditorIsDirectoryGroupStart(app.tagEditorGetPaged()[0], 0), true);
  assert.equal(app.tagEditorIsDirectoryGroupStart(app.tagEditorGetPaged()[1], 1), true);
  assert.equal(app.tagEditorIsDirectoryGroupStart(app.tagEditorGetPaged()[2], 2), false);
  app.tagEditorPage = 2;
  assert.deepEqual(Array.from(app.tagEditorGetPaged(), img => img.path), ['/nested', '/b/high']);
  app.tagEditorGroupByDir = false;
  assert.deepEqual(Array.from(app.tagEditorGetFiltered(), img => img.path), flat);
  assert.equal(app.tagEditorIsDirectoryGroupStart(app.tagEditorImages[0], 0), false);
});

test('toggling directory groups resets paging and preserves selected drafts in modified filter', () => {
  const { app } = fixture();
  app.tagEditorQuickFilter = 'modified';
  app.tagEditorPage = 2;
  app.tagEditorSelected = ['/b'];
  app._teGetModified = () => [{ path: '/b', rel_path: 'b/image.png', tags: 'draft' }, { path: '/a', rel_path: 'a/image.png', tags: 'draft' }];
  const flatKey = app._teSessionQueryKey(1);
  app.tagEditorToggleDirectoryGroups();
  assert.equal(app.tagEditorPage, 1);
  assert.equal(app._teSessionQuery(1).get('group_by_dir'), 'true');
  assert.notEqual(app._teSessionQueryKey(1), flatKey);
  assert.deepEqual(Array.from(app.tagEditorPageItems, img => img.path), ['/a', '/b']);
  assert.deepEqual(app.tagEditorSelected, ['/b']);
  assert.equal(app.tagEditorPageItems[1].tags, 'draft');
});
