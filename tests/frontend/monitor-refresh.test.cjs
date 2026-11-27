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

test('live overview keeps its chart and progress matrix across telemetry and parameter refreshes', () => {
  let builds = 0;
  const params = {};
  const panel = {dataset: {}, classList: {add() {}}, contains: () => false,
    querySelector: selector => selector === '[data-overview-params]' ? params : null,
    set innerHTML(html) { this.firstElementChild = html; builds++; }};
  const document = {getElementById: () => ({querySelector: () => panel})};
  const {window} = loadFrontend('monitor/render', {window: {TRAIN_SECTIONS: []}, document});
  const app = new Proxy(composeMixins(window.monitorRenderMixin, {
    _builtTab: 'overview', liveTaskId: 'run-a', trainParamsVersion: 1,
    _summaryStatus: () => ({state: 'RUNNING'}), _renderOverviewTab: () => 'overview',
    initMonitorParams() {}, _patchOverviewStatus() {}, _overviewParamsHtml() { return String(this.trainParamsVersion); },
  }), {
    // Alpine returns a reactive proxy when an array is read back from the component.
    get(target, key) {
      const value = target[key];
      return value === window.TRAIN_SECTIONS ? new Proxy(value, {}) : value;
    },
  });
  const render = step => app._renderTab('overview', {step}, null, null, String, false);
  render(1);
  render(2);
  assert.equal(builds, 1);
  app.trainParamsVersion++;
  render(3);
  assert.equal(params.innerHTML, '2');
  window.TRAIN_SECTIONS = [];
  render(4);
  assert.equal(builds, 1);
  app.liveTaskId = 'run-b';
  render(1);
  assert.equal(builds, 2);
});

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
  assert.match(requests[0].url, /[?&]refresh=1(?:&|$)/);
  requests[0].resolve(response([]));
  await pending;
  assert.equal(retries, 1);
  assert.equal(app.previewsVersion, 1, 'unchanged metadata still refreshes failed media');
  app._invalidatePreviewRequest();
});

test('background sample refresh can reuse the monitor cache', async () => {
  const {app, requests} = requestHarness();
  app._replacePreviewItems = () => false;
  app._followLatestPreview = () => {};
  const pending = app.refreshPreviews(false);
  assert.doesNotMatch(requests[0].url, /[?&]refresh=/);
  requests[0].resolve(response([]));
  await pending;
});

test('changing the state sort key or direction rerenders the output list', () => {
  const panel = {firstElementChild: {}, querySelector: () => null, contains: () => false, classList: {add() {}}};
  const document = {getElementById: () => ({querySelector: () => panel})};
  const {window} = loadFrontend('monitor/render', {window: {}, document});
  const app = composeMixins(window.monitorRenderMixin, {
    _builtTab: 'outputs', selectedOutputFiles: [], outputFiles: [{}], outputStateSortKey: 'name', outputStateSortDir: 'asc',
    _renderOutputsTab() {return this.outputStateSortKey + '-' + this.outputStateSortDir;},
  });
  const render = () => app._renderTab('outputs', {}, null, null, () => '', false);
  render();
  assert.equal(panel.innerHTML, 'name-asc');
  app.outputStateSortKey = 'size';
  render();
  assert.equal(panel.innerHTML, 'size-asc');
  app.outputStateSortDir = 'desc';
  render();
  assert.equal(panel.innerHTML, 'size-desc');
});

test('state checkpoint sorting uses saved steps and keeps epoch-only saves together at the end', () => {
  const {window} = loadFrontend('monitor/outputs');
  const app = composeMixins(window.monitorOutputsMixin, {
    outputStateSortKey: 'step', outputFiles: [
      {name: 'epoch2', ckpt_epoch: 2, ckpt_step: 240}, {name: 'legacy3', ckpt_epoch: 3},
      {name: 'step100', ckpt_step: 100}, {name: 'legacy1', ckpt_epoch: 1},
      {name: 'unknown'}, {name: 'step0', ckpt_step: 0},
    ].map(file => ({category: 'state', ...file})),
  });
  const order = () => Array.from(app._sortedOutputs().states, row => row.name);
  app.outputStateSortDir = 'asc';
  assert.deepEqual(order(), ['step0', 'step100', 'epoch2', 'legacy1', 'legacy3', 'unknown']);
  app.outputStateSortDir = 'desc';
  assert.deepEqual(order(), ['epoch2', 'step100', 'step0', 'legacy3', 'legacy1', 'unknown']);
});

test('history offers downloads for distributed states and resume for ordinary states', () => {
  const {window} = loadFrontend(['training/field-renderer', 'monitor/core', 'monitor/render']);
  const app = composeMixins(window.trainingFieldRenderer, window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin, {
    selectedRunDir: 'output/run', runDetailData: {}, t: key => key, outputFilter: 'states',
    outputFiles: [], outputFilesSelected: {},
  });
  for (const name of ['fsdp-state', 'deepspeed-state']) {
    app.outputFiles = [{category: 'state', name, path: name, resumable: false}];
    const html = app._renderOutputsTab(app.t);
    assert.ok(html.includes(`downloadSingleOutput('${name}')`));
    assert.doesNotMatch(html, /output-reveal-btn/);
    assert.doesNotMatch(html, /resumeFromOutputState|fsdpIncompatible/);
  }
  app.outputFiles[0] = {category: 'state', name: 'epoch-state', path: 'epoch-state', resumable: true, ckpt_step: 240};
  assert.match(app._renderOutputsTab(app.t), /resumeFromOutputState\('epoch-state',240\)/);
  app.outputCanReveal = true;
  app.outputFilter = 'all';
  app.outputFiles.push({category:'model', name:'model', path:'sub/model'}, {category:'other', name:'log', path:'sub/log'});
  for (const selectedRunDir of ['output/run', '']) {
    app.selectedRunDir = selectedRunDir;
    const html = app._renderOutputsTab(app.t);
    assert.equal((html.match(/output-reveal-btn/g) || []).length, 3);
    for (const {path} of app.outputFiles) assert.ok(html.includes('data-path="' + path + '"'));
  }
});

test('artifact notices refresh only changed samples and coalesce changes during a read', async () => {
  const {app, requests} = requestHarness();
  app.currentRoute = 'monitor-dashboard';
  app.scheduleRender = () => {};
  app._replacePreviewItems = () => false;
  app._followLatestPreview = () => {};
  app.handleRealtimeTaskArtifacts({output_count: 1, previews_changed: false});
  assert.equal(requests.length, 0);
  app.handleRealtimeTaskArtifacts({output_count: 2, previews_changed: true});
  app.handleRealtimeTaskArtifacts({output_count: 3, previews_changed: true});
  app.handleRealtimeTaskArtifacts({output_count: 4, previews_changed: true});
  assert.equal(requests.length, 1);
  requests[0].resolve(response([]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].resolve(response([]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.previewsLoading, false);
  assert.equal(requests.length, 2);
  app.handleRealtimeTaskArtifacts({output_count: 5, previews_changed: true});
  requests[2].reject(new Error('temporary'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3, 'a failed refresh does not immediately loop');
  app.handleRealtimeTaskArtifacts({output_count: 6, previews_changed: false});
  assert.equal(requests.length, 4);
  requests[3].resolve(response([]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app._previewRefreshPending, false);
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
      _patchSampleBatchOrder() {}, _disconnectSampleExpansionUI() {}, _cancelSampleGridMotion() {}, _cancelPreviewMediaQueue() {},
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
  for (const mode of ['incoming', 'refresh', 'initial', 'run', 'sort', 'direction', 'locale', 'tab', 'reset']) {
    let rebuilt = false, motions = 0;
    const oldTile = {dataset: {sampleTileKey: 'old'}}, newTile = {dataset: {sampleTileKey: 'new'}};
    const grid = tiles => ({scrollTop: 0, classList: {contains: () => true},
      querySelectorAll: selector => selector === '.m-sample-batch' ? [] : tiles});
    const previous = mode === 'initial' ? null : grid([oldTile]);
    const next = grid(mode === 'refresh' ? [oldTile] : [oldTile, newTile]);
    const sort = mode === 'direction' ? 'loss-overall-desc' : 'desc';
    const context = ['run', '', sort, 'test', false];
    if (mode === 'run') context[0] = 'previous-run';
    if (mode === 'sort') context[2] = 'asc';
    if (mode === 'direction') context[2] = 'loss-overall-asc';
    if (mode === 'locale') context[3] = 'previous-locale';
    const panel = {firstElementChild: previous ? {} : null, _sampleMotionContext: JSON.stringify(context),
      classList: {add() {}}, contains: () => false,
      querySelector: selector => ['.preview-grid', '.m-sample-batches'].includes(selector) ? (rebuilt ? next : previous) : null,
      set innerHTML(value) {rebuilt = true;}};
    const document = {activeElement: {}, getElementById: id => id === 'monitorTabContent' ? {querySelector: () => panel, querySelectorAll: () => []} : null};
    const {window} = loadFrontend(['monitor/render'], {window: {}, document, requestAnimationFrame() {}});
    const app = composeMixins(window.monitorArtifactsRenderMixin, window.monitorRenderMixin, {
      _builtTab: mode === 'tab' ? 'overview' : 'samples', _builtSamplesSig: 'previous', _shellLocale: 'test', previewsVersion: 2,
      currentOutputRunDir: 'run', selectedRunDir: '', sampleBatchSortDir: sort, weakNetworkMode: false, runDetailData: {},
      _sampleOverviewAtEnd: false, _sampleResetScroll: mode === 'reset',
      _patchSampleBatchOrder() {}, _disconnectSampleExpansionUI() {}, _cancelSampleGridMotion() {}, _cancelPreviewMediaQueue() {},
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

test('outputs tab binds delegated bounce marquee once, clears before rebuild, and renders marquee host markup', () => {
  const events = [];
  const bindings = [];
  const panel = {
    firstElementChild: null,
    classList: {add() {}, remove() {}},
    contains: () => false,
    querySelector: () => null,
    set innerHTML(html) {
      events.push('innerHTML:' + html);
      this._html = html;
      this.firstElementChild = {};
    },
    get innerHTML() { return this._html || ''; },
  };
  const contentEl = {
    querySelector: sel => (sel.includes('data-tab="outputs"') ? panel : null),
    querySelectorAll: () => [],
  };
  const document = {getElementById: id => (id === 'monitorTabContent' ? contentEl : null)};
  const {window} = loadFrontend(['training/field-renderer', 'monitor/core', 'monitor/render'], {
    window: {
      bindDelegatedBounceMarquee(container, opts) {
        bindings.push({container, opts});
        return {
          clear() { events.push('clear'); },
          destroy() { events.push('destroy'); },
        };
      },
    },
    document,
    requestAnimationFrame() {},
  });
  const app = composeMixins(window.trainingFieldRenderer, window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin, {
    _builtTab: 'outputs', selectedRunDir: 'output/run', runDetailData: {config: {output_name: 'demo-run'}},
    t: key => key, outputFilter: 'all', outputFilesSelected: {}, outputFilesVersion: 1,
    outputFiles: [
      {category: 'model', name: 'very-long-model.safetensors', path: 'm.safetensors', size: 10, mtime: 1},
      {category: 'state', name: 'very-long-state-dir', path: 's', size: 10, mtime: 1},
      {category: 'other', name: 'very-long-log.txt', path: 'l.txt', size: 10, mtime: 1},
    ],
  });

  app._renderTab('outputs', app.runDetailData, null, null, app.t, true);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].container, panel);
  assert.deepEqual({...bindings[0].opts}, {hostSelector: '.output-item', targetSelector: '.output-name-text'});
  assert.equal(events[0], 'clear');
  assert.ok(events[1].startsWith('innerHTML:'));
  assert.equal((panel.innerHTML.match(/class="output-item loop-marquee-host/g) || []).length, 3);
  assert.equal((panel.innerHTML.match(/<span class="output-name-text"><span>/g) || []).length, 3);
  assert.ok(!panel.innerHTML.includes('x-loop-marquee'));

  events.length = 0;
  app.outputFilesVersion = 2;
  app._renderTab('outputs', app.runDetailData, null, null, app.t, true);
  assert.equal(bindings.length, 1, 'persistent panel binding is reused across rebuilds');
  assert.equal(events[0], 'clear', 'clears active delegated marquee before replacing innerHTML');
  assert.ok(events[1].startsWith('innerHTML:'));

  events.length = 0;
  app._renderTab('overview', app.runDetailData, null, null, app.t, true);
  assert.equal(events[0], 'clear', 'clears active delegated marquee when leaving outputs tab');

  const bannerHtml = app._historyBannerHtml(app.runDetailData, app.t);
  assert.ok(bannerHtml.includes('<b class="m-history-name" title="demo-run" x-loop-marquee.bounce><span>demo-run</span></b>'));
});
