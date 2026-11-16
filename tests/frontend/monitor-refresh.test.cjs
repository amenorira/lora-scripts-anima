const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response} = require('./helpers.cjs');

function requestHarness(document = {getElementById: () => null}) {
  const requests = [];
  const {window} = loadFrontend(['shared/utils', 'monitor/logs', 'monitor/core'], {
    window: {}, document, AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: url => { const request = deferred(); requests.push({url, ...request}); return request.promise; },
  });
  const app = composeMixins(window.utilsMixin, window.monitorCoreMixin, {
    monitorData: {run_dir: 'output/run'}, outputFiles: [], outputFilesSelected: {},
    _outputFilesRunDir: 'output/run', _outputFilesRequestSeq: 0, _outputCountVersion: 0,
    selectedRunDir: null, liveTaskId: null, renderDashboard() {}, toast() {}, t: key => key,
  });
  return {app, requests};
}

test('a delayed log search cannot overwrite newer input or enable stale match navigation', async () => {
  const {app, requests} = requestHarness();
  app.logFullQuery = 'old';
  const pending = app.fetchLogSlice({q: 'old'});
  app.logFullQuery = 'new';
  requests[0].resolve(response({offset: 0, total: 1, lines: ['old'], match_indices: [0]}));
  await pending;
  assert.equal(app.logFullQuery, 'new');
  assert.equal(app._logFullResultQuery, 'old');
  app.logFullNextMatch();
  assert.equal(requests.length, 1);
});

test('manual log refresh keeps the old page and prevents duplicate requests', async () => {
  const {app, requests} = requestHarness();
  app.logFullLines = ['existing line'];
  const pending = app.refreshFullLog();
  assert.equal(app.logRefreshFeedback, true);
  assert.equal(app.logFullLoading, true);
  assert.deepEqual(Array.from(app.logFullLines), ['existing line']);
  app.refreshFullLog();
  assert.equal(requests.length, 1);
  requests[0].resolve(response({offset: 0, total: 1, lines: ['existing line'], match_indices: []}));
  await pending;
  assert.equal(app.logFullLoading, false);
  assert.equal(app.logRefreshFeedback, true);
  app.resetRunDetailState();
  assert.equal(app.logRefreshFeedback, false);
  assert.equal(app._logRefreshFeedbackTimer, null);
});

test('a failed follow-up log page does not replace the previous search results', async () => {
  const {app, requests} = requestHarness();
  app.logFullQuery = 'new';
  app._logFullResultQuery = 'old';
  app.logFullMatches = [5];
  const pending = app.fetchLogSlice({q: 'new', matchIdx: 0});
  requests[0].resolve(response({offset: 0, total: 2000, lines: ['old page'], match_indices: [1001]}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].reject(new Error('offline'));
  await pending;
  assert.equal(app._logFullResultQuery, 'old');
  assert.deepEqual(Array.from(app.logFullMatches), [5]);
});

test('manual sample refresh retries failed lightbox thumbnails outside the tab panel', async () => {
  const failed = {};
  const document = {getElementById: id => id === 'monitorDashboard' ? {querySelector: () => failed}
    : id === 'monitorTabContent' ? {querySelector: () => null} : null};
  const {app, requests} = requestHarness(document);
  let retries = 0;
  app._clearPreviewTimelineImageSwaps = () => {retries++;};
  app._replacePreviewItems = () => false;
  app._followLatestPreview = () => {};
  const pending = app.refreshPreviews();
  requests[0].resolve(response([]));
  await pending;
  assert.equal(retries, 1);
  assert.equal(app.previewsVersion, 1, 'unchanged metadata still refreshes failed media');
  app._invalidatePreviewRequest();
});

test('sample refresh preserves grid position after modal selection, but initial and explicit resets reveal it', () => {
  for (const mode of ['refresh', 'initial', 'reset']) {
    let rebuilt = false;
    const makeGrid = scrollTop => {
      const grid = {scrollTop, classList: {contains: () => true}, getBoundingClientRect: () => ({top: 0, bottom: 200})};
      const item = {dataset: {previewPath: 'epoch-50.png'}, closest: () => group,
        getBoundingClientRect: () => ({top: 320 - grid.scrollTop, bottom: 440 - grid.scrollTop})};
      const group = {dataset: {batchId: 'epoch-50'}, querySelector: () => item, querySelectorAll: () => [item]};
      grid.querySelectorAll = selector => selector === '.m-sample-batch' ? [group] : [item];
      return grid;
    };
    const oldGrid = mode === 'initial' ? null : makeGrid(300), nextGrid = makeGrid(0);
    const panel = {firstElementChild: mode === 'initial' ? null : {}, classList: {add() {}}, contains: () => false,
      querySelector(selector) {
        if (selector === '.preview-grid' || selector === '.m-sample-batches') return rebuilt ? nextGrid : oldGrid;
        return null;
      },
      set innerHTML(value) {rebuilt = true;}};
    const document = {activeElement: {}, getElementById: id => id === 'monitorTabContent' ? {querySelector: () => panel} : null};
    const {window} = loadFrontend(['monitor/render'], {window: {}, document});
    const app = composeMixins(window.monitorArtifactsRenderMixin, window.monitorRenderMixin, {
      _builtTab: 'samples', _builtSamplesSig: 'previous-snapshot', _shellLocale: 'test', previewsVersion: 2,
      runDetailData: {}, weakNetworkMode: false, sampleBatchId: 'epoch-50', previewStep: 49,
      _sampleOverviewAtEnd: false, _sampleResetScroll: mode === 'reset',
      _disconnectSampleExpansionUI() {}, _cancelSampleGridMotion() {}, _cancelPreviewMediaQueue() {},
      _capturePreviewMedia() {return new Map();}, _restorePreviewMedia() {}, _renderSamplesTab() {return 'updated samples';},
      _sampleSelectedBatch() {return {id: this.sampleBatchId};},
      _sampleDataModel() {return {batches: [{id: 'epoch-50'}, {id: 'epoch-100'}]};},
      _refreshSampleGroupOutline() {}, _connectSampleExpansionUI() {}, schedulePreviewMediaLoads() {},
    });

    app._renderTab('samples', {}, null, null, () => '', true);

    assert.equal(rebuilt, true, mode);
    assert.equal(nextGrid.scrollTop, mode === 'refresh' ? 300 : 320, mode + ': grid position');
    assert.equal(app.sampleBatchId, 'epoch-50');
    assert.equal(app.previewStep, 49);
  }
});

test('sample snapshots keep a pressed cover in the DOM until pointer completion', () => {
  for (const ended of [false, true]) {
    const panel = {firstElementChild: {}};
    const document = {getElementById: () => ({querySelector: () => panel})};
    const {window} = loadFrontend(['monitor/render'], {window: {}, document});
    const app = composeMixins(window.monitorRenderMixin, {
      _builtTab: 'samples', _builtSamplesSig: 'previous-snapshot', previewsVersion: 2,
      runDetailData: {},
      _sampleGridPointer: {ended, cancelled: false},
    });
    app._renderTab('samples', {}, null, null, () => '', true);
    assert.equal(app._sampleGridPointer.renderPending, true);
    assert.equal(app._builtSamplesSig, 'previous-snapshot', 'the pending signature remains dirty for the retry');
  }
});

test('sample snapshots request staged arrival motion only for new tiles in the same visible browsing context', () => {
  for (const mode of ['incoming', 'refresh', 'initial', 'run', 'sort', 'locale', 'tab', 'reset']) {
    let rebuilt = false, motions = 0;
    const oldTile = {dataset: {sampleTileKey: 'old'}}, newTile = {dataset: {sampleTileKey: 'new'}};
    const grid = tiles => ({scrollTop: 0, classList: {contains: () => true},
      querySelectorAll: selector => selector === '.m-sample-batch' ? [] : tiles});
    const previous = mode === 'initial' ? null : grid([oldTile]);
    const next = grid(mode === 'refresh' ? [oldTile] : [oldTile, newTile]);
    const context = ['run', '', 'desc', 'test', false];
    if (mode === 'run') context[0] = 'previous-run';
    if (mode === 'sort') context[2] = 'asc';
    if (mode === 'locale') context[3] = 'previous-locale';
    const panel = {firstElementChild: previous ? {} : null, _sampleMotionContext: JSON.stringify(context),
      classList: {add() {}}, contains: () => false,
      querySelector: selector => ['.preview-grid', '.m-sample-batches'].includes(selector) ? (rebuilt ? next : previous) : null,
      set innerHTML(value) {rebuilt = true;}};
    const document = {activeElement: {}, getElementById: id => id === 'monitorTabContent' ? {querySelector: () => panel, querySelectorAll: () => []} : null};
    const {window} = loadFrontend(['monitor/render'], {window: {}, document, requestAnimationFrame() {}});
    const app = composeMixins(window.monitorArtifactsRenderMixin, window.monitorRenderMixin, {
      _builtTab: mode === 'tab' ? 'overview' : 'samples', _builtSamplesSig: 'previous', _shellLocale: 'test', previewsVersion: 2,
      currentOutputRunDir: 'run', selectedRunDir: '', sampleBatchSortDir: 'desc', weakNetworkMode: false, runDetailData: {},
      _sampleOverviewAtEnd: false, _sampleResetScroll: mode === 'reset',
      _disconnectSampleExpansionUI() {}, _cancelSampleGridMotion() {}, _cancelPreviewMediaQueue() {},
      _capturePreviewMedia: () => new Map(), _restorePreviewMedia() {}, _renderSamplesTab: () => 'samples',
      _sampleSelectedBatch: () => ({id: 'old'}), _sampleDataModel: () => ({batches: [{id: 'old'}, {id: 'new'}]}),
      _refreshSampleGroupOutline() {}, _connectSampleExpansionUI() {}, schedulePreviewMediaLoads() {},
      _captureSampleLayout: () => new Map([['old', oldTile]]),
      _animateSampleLayout(target, before, openingId, options) {
        assert.equal(target, next); assert.equal(before.size, 1); assert.equal(openingId, '');
        assert.equal(options.revealNew, true); motions++;
      },
    });
    app._renderTab('samples', {}, null, null, () => '', true);
    assert.equal(motions, mode === 'incoming' ? 1 : 0, mode);
  }
});
