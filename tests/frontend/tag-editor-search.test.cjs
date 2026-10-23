const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, readRepo} = require('./helpers.cjs');

test('clear filters cancels pending search, resets invalid regex and schedules one clean refresh', () => {
  const timers = new Map(); let next = 0;
  const context = {window: {}, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id)};
  loadFrontend('tag-editor', context);
  const calls = [];
  const raw = '\uFEFF  untouched\r\n';
  const history = [{changes: {a: {before: null, after: raw}}}];
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorImages: [{path: 'a', tags: raw}], tagEditorSelected: ['a'], tagEditorHistory: history,
    tagEditorUseRegex: true, tagEditorSearchQuery: '[', tagEditorRegexError: true,
    tagEditorTagSelection: ['cat'], tagEditorExcludedTags: ['dog'], tagEditorQuickFilter: 'notag',
    _teCachedFiltered: [],
    tagEditorSchedulePageFetch(reset) { calls.push({reset, query: this.tagEditorSearchQuery, error: this.tagEditorRegexError}); }
  });
  app.tagEditorSetSearch('pending');
  app.tagEditorClearFilters();
  for (const timer of timers.values()) timer();
  assert.deepEqual(calls, [{reset: true, query: '', error: false}]);
  assert.equal(app._teSearchDebounce, null);
  assert.equal(app._teSearchLoading, false);
  assert.equal(app._teCachedFiltered, null);
  assert.equal(app.tagEditorQuickFilter, 'all');
  assert.equal(app.tagEditorTagSelection.length + app.tagEditorExcludedTags.length, 0);
  assert.equal(app.tagEditorImages[0].tags, raw);
  assert.equal(app.tagEditorHistory, history);
  assert.deepEqual(app.tagEditorSelected, ['a']);
  assert.match(readRepo('frontend/index.html'), /@click="tagEditorClearFilters\(\)"/);
});
