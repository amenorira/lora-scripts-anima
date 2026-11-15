const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response} = require('./helpers.cjs');

function requestHarness() {
  const requests = [];
  const {window} = loadFrontend(['shared/utils', 'monitor/logs', 'monitor/core'], {
    window: {}, document: {getElementById: () => null}, AbortController, URLSearchParams, setTimeout, clearTimeout,
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

test('sample refresh preserves grid and rail positions after modal selection, but initial and explicit resets reveal it', () => {
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
    const oldRail = mode === 'initial' ? null : {scrollLeft: 100, querySelector: () => ({id: 'sampleTimeline-epoch-100'})};
    const nextRail = {scrollLeft: 0, getBoundingClientRect: () => ({left: 0, right: 300})};
    const selected = {id: 'sampleTimeline-epoch-50', dataset: {batchId: 'epoch-50'}, attributes: {},
      setAttribute(name, value) {this.attributes[name] = value;},
      getBoundingClientRect: () => ({left: 800 - nextRail.scrollLeft, right: 900 - nextRail.scrollLeft})};
    nextRail.querySelector = () => selected;
    nextRail.querySelectorAll = () => [selected];
    const panel = {firstElementChild: mode === 'initial' ? null : {}, classList: {add() {}}, contains: () => false,
      querySelector(selector) {
        if (selector === '.preview-grid' || selector === '.m-sample-batches') return rebuilt ? nextGrid : oldGrid;
        return selector === '.m-sample-timeline' ? (rebuilt ? nextRail : oldRail) : null;
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
    assert.equal(nextRail.scrollLeft, mode === 'refresh' ? 100 : 600, mode + ': rail position');
    assert.equal(selected.attributes['aria-pressed'], 'true', mode + ': selection still updates');
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
