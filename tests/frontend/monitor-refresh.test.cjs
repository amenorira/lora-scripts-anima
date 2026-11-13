const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response} = require('./helpers.cjs');

test('a fast manual sample refresh keeps visible feedback without delaying results', async () => {
  const timers = [];
  const {window} = loadFrontend(['shared/utils', 'monitor/core'], {
    window: {}, document: {getElementById: () => null},
    setTimeout(fn, ms) { const timer = {fn, ms, cancelled: false}; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    fetch: async () => response([{name: 'new.png'}]),
  });
  const app = composeMixins(window.utilsMixin, window.monitorCoreMixin, {
    previews: [], previewStep: 0, previewsLoading: false, previewsVersion: 0,
    _previewRequestSeq: 0, _previewSnapshotSeq: 0, currentOutputRunDir: 'output/run',
    currentRoute: 'monitor-dashboard', taskId: 'A', renderDashboard() {},
    _followLatestPreview() {},
  });
  await app.refreshPreviews();
  assert.equal(app.previewsLoading, false);
  assert.equal(app.previews[0].name, 'new.png');
  assert.equal(app.previewRefreshFeedback, true);
  assert.equal(timers[0].ms, 800);
  await app.refreshPreviews();
  assert.equal(timers[0].cancelled, true);
  timers[1].fn();
  assert.equal(app.previewRefreshFeedback, false);
  await app.refreshPreviews(false);
  assert.equal(timers.length, 2);
  await app.refreshPreviews();
  app._invalidatePreviewRequest();
  assert.equal(timers[2].cancelled, true);
  assert.equal(app.previewRefreshFeedback, false);
});

test('only decoded thumbnails with the same run, path and version survive a rebuild', () => {
  const revoked = [];
  const {window} = loadFrontend(['monitor/previews'], {window: {}, URL: {revokeObjectURL: url => revoked.push(url)}});
  const app = composeMixins(window.monitorPreviewsMixin, {
    _previewMediaObjectUrls: ['blob:keep', 'blob:changed', 'blob:failed', 'blob:run', 'blob:unversioned', 'blob:undecoded', 'blob:removed'],
  });
  function image(path, url, src, {failed = false, decoded = true} = {}) {
    return {
      dataset: {previewUrl: url, ...(src ? {previewLoaded: '1'} : {})}, src: src || '',
      complete: decoded, naturalWidth: decoded ? 100 : 0,
      getAttribute: () => src,
      closest: selector => selector === '.preview-grid-item' ? {dataset: {previewPath: path}} : {classList: {contains: () => failed}},
    };
  }
  const old = [
    image('keep', '/thumb?run=A&v=1', 'blob:keep'),
    image('changed', '/thumb?run=A&v=1', 'blob:changed'),
    image('failed', '/thumb?run=A&v=1', 'blob:failed', {failed: true}),
    image('run', '/thumb?run=A&v=1', 'blob:run'),
    image('unversioned', '/thumb?run=A', 'blob:unversioned'),
    image('undecoded', '/thumb?run=A&v=1', 'blob:undecoded', {decoded: false}),
    image('removed', '/thumb?run=A&v=1', 'blob:removed'),
  ];
  const next = [
    image('keep', '/thumb?run=A&v=1'), image('changed', '/thumb?run=A&v=2'),
    image('failed', '/thumb?run=A&v=1'), image('run', '/thumb?run=B&v=1'),
    image('unversioned', '/thumb?run=A'), image('undecoded', '/thumb?run=A&v=1'),
  ];
  const loaded = app._capturePreviewMedia({querySelectorAll: () => old});
  app._restorePreviewMedia({querySelectorAll: () => next}, loaded);
  assert.equal(next[0].src, 'blob:keep');
  assert.equal(next[0].dataset.previewLoaded, '1');
  assert.ok(next.slice(1).every(item => !item.src && !item.dataset.previewLoaded));
  assert.deepEqual(Array.from(app._previewMediaObjectUrls), ['blob:keep']);
  assert.deepEqual(revoked.sort(), ['blob:changed', 'blob:failed', 'blob:removed', 'blob:run', 'blob:undecoded', 'blob:unversioned'].sort());
});

test('a cancelled thumbnail request cannot write to a detached grid after it resolves', async () => {
  const request = deferred();
  let created = 0;
  const {window} = loadFrontend(['monitor/previews'], {
    window: {}, AbortController, fetch: () => request.promise,
    URL: {createObjectURL() { created++; return 'blob:late'; }},
  });
  const image = {dataset: {previewUrl: '/thumb?v=1', previewQueued: '1'}, isConnected: true};
  const app = composeMixins(window.monitorPreviewsMixin, {
    weakNetworkMode: true, _previewMediaPaused: false, _previewMediaLoading: false,
    _previewMediaGeneration: 0, _previewMediaQueue: [{image, url: image.dataset.previewUrl}],
    _previewMediaObjectUrls: [], _previewMediaObserver: null,
  });
  const pending = app._drainPreviewMediaQueue();
  app._cancelPreviewMediaQueue();
  request.resolve({ok: true, blob: async () => ({})});
  await pending;
  assert.equal(created, 0);
  assert.equal(image.dataset.previewLoaded, undefined);
});

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

test('a fast manual output refresh shows feedback without delaying results', async () => {
  const timers = [];
  const {window} = loadFrontend(['shared/utils', 'monitor/core'], {
    window: {},
    setTimeout(fn, ms) { const timer = {fn, ms, cancelled: false}; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    fetch: async () => response([{name: 'new', path: 'new'}]),
  });
  const app = composeMixins(window.utilsMixin, window.monitorCoreMixin, {
    currentOutputRunDir: 'output/run', _outputFilesRunDir: 'output/run',
    _outputFilesRequestSeq: 0, _outputCountVersion: 0, outputFilesVersion: 0,
    outputFiles: [], outputFilesSelected: {}, outputFilesLoading: false, _outputFilesLoaded: true,
    currentArtifactData: () => ({}), renderDashboard() {},
  });
  await app.refreshOutputFiles();
  assert.equal(app.outputFilesLoading, false);
  assert.equal(app.outputFiles[0].name, 'new');
  assert.equal(app.outputRefreshFeedback, true);
  assert.equal(timers[0].ms, 800);
  await app.refreshOutputFiles();
  assert.equal(timers[0].cancelled, true);
  timers[1].fn();
  assert.equal(app.outputRefreshFeedback, false);
  await app.loadOutputFiles();
  assert.equal(timers.length, 2);
  const pending = app.refreshOutputFiles();
  app._resetOutputFilesForRun('output/other');
  await pending;
  assert.equal(timers[2].cancelled, true);
  assert.equal(app.outputRefreshFeedback, false);
  assert.equal(app.outputFiles.length, 0);
});

test('history refresh keeps unchanged cards and ignores background loading for button feedback', async () => {
  const requests = [], timers = [];
  const {window} = loadFrontend(['shared/utils', 'monitor/core'], {
    window: {},
    fetch: () => { const request = deferred(); requests.push(request); return request.promise; },
    setTimeout(fn, ms) { const timer = {fn, ms}; timers.push(timer); return timer; },
    clearTimeout() {},
  });
  let renders = 0;
  const app = composeMixins(window.utilsMixin, window.monitorCoreMixin, {
    historyItems: [], runningTask: null, currentRoute: 'history',
    renderHistory() { renders++; }, finishProgress() {}, t: key => key,
  });
  const initial = app.loadHistory();
  requests[0].resolve(response({running: null, history: []}));
  await initial;
  assert.equal(renders, 1); // The initial empty result still needs an empty state.
  const manual = app.refreshHistory();
  assert.equal(app.historyRefreshing, true);
  assert.equal(app.historyRefreshFeedback, true);
  await app.refreshHistory();
  assert.equal(requests.length, 2);
  requests[1].resolve(response({running: null, history: []}));
  await manual;
  assert.equal(renders, 1);
  assert.equal(app.historyRefreshing, false);
  assert.equal(app.historyRefreshFeedback, true);
  assert.equal(timers[0].ms, 800);
  timers[0].fn();
  const background = app.loadHistory(true);
  assert.equal(app.historyRefreshing, false);
  assert.equal(app.historyRefreshFeedback, false);
  requests[2].resolve(response({running: null, history: [{name: 'new'}]}));
  await background;
  assert.equal(renders, 2);
  const oldManual = app.refreshHistory();
  const newerLoad = app.loadHistory();
  assert.equal(app.historyRefreshing, false);
  requests[4].resolve(response({running: null, history: [{name: 'new'}]}));
  await newerLoad;
  requests[3].resolve(response({running: null, history: []}));
  await oldManual;
  assert.equal(app.historyRefreshing, false);
  assert.equal(app.historyItems[0].name, 'new');
});

test('returning to history after a language change immediately retranslates unchanged cards', async () => {
  const requests = [];
  let builds = 0, html = '';
  const list = {get innerHTML() { return html; }, set innerHTML(value) { html = value; builds++; }};
  const {window} = loadFrontend(['shared/utils', 'monitor/core', 'monitor/render'], {
    window: {}, document: {activeElement: null, getElementById: id => id === 'historyList' ? list : null},
    fetch: () => { const request = deferred(); requests.push(request); return request.promise; },
  });
  const app = composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorHistoryRenderMixin, {
    currentRoute: 'history', locale: 'zh-CN', localeRevision: 1, historyItems: [], runningTask: null,
    t: key => key, tMonitor(key) { return this.locale + ':' + key; },
    escapeJsString: value => value, _formatLearningRate: value => value ?? '—', finishProgress() {},
  });
  const data = {running: null, history: [{name: 'run', run_dir: 'output/run', status: 'completed', time: 'today'}]};
  const first = app.loadHistory();
  requests[0].resolve(response(data));
  await first;
  assert.match(html, /zh-CN:viewDetails/);
  assert.equal(builds, 1);
  app.locale = 'en-US';
  app.localeRevision++;
  const returning = app.loadHistory();
  assert.match(html, /en-US:viewDetails/); // Do not wait for the network to translate the old cards.
  assert.equal(builds, 2);
  requests[1].resolve(response(data));
  await returning;
  assert.equal(builds, 2); // Unchanged data should not rebuild them a second time.
  app.localeRevision++;
  const updatedMessages = app.loadHistory();
  assert.equal(builds, 3); // Messages can change after retrying the same locale.
  requests[2].resolve(response(data));
  await updatedMessages;
  assert.equal(builds, 3);
});

test('output refresh invalidates its list only for changes and preserves queued updates', async () => {
  const {app, requests} = requestHarness();
  app.outputFiles = [{name: 'a', path: 'a'}, {name: 'b', path: 'b'}];
  app.outputFilesSelected = {a: true, b: true};
  app.outputFilesVersion = 3;
  const same = app.loadOutputFiles();
  await app.loadOutputFiles(); // an automatic update during a request remains queued
  assert.equal(app._outputFilesNeedsRefresh, true);
  requests[0].resolve(response([{name: 'a', path: 'a'}, {name: 'b', path: 'b'}]));
  await same;
  assert.equal(app.outputFilesVersion, 3);
  assert.deepEqual(Array.from(app.selectedOutputFiles), ['a', 'b']);
  const changed = app.loadOutputFiles();
  requests[1].resolve(response([{name: 'a', path: 'a'}]));
  await changed;
  assert.equal(app.outputFilesVersion, 4);
  assert.deepEqual(Array.from(app.selectedOutputFiles), ['a']);
  const failed = app.loadOutputFiles();
  requests[2].reject(new Error('offline'));
  await failed;
  assert.equal(app.outputFilesError, 'loadFailed');
  assert.equal(app.outputFiles.length, 0);
  assert.equal(app.outputFilesVersion, 5);
});

test('retrying an empty output list retains the previous result until the request finishes', async () => {
  const {app, requests} = requestHarness();
  app.outputFilesError = 'loadFailed';
  app._outputFilesLoaded = true;
  const retry = app.loadOutputFiles();
  assert.equal(app.outputFilesError, 'loadFailed');
  assert.equal(app._outputFilesLoaded, true);
  requests[0].resolve(response([]));
  await retry;
  assert.equal(app.outputFilesError, '');
  assert.equal(app._outputFilesLoaded, true);
});

test('an existing output panel stays mounted during an unchanged refresh', () => {
  let builds = 0;
  const panel = {firstElementChild: {}, classList: {add() {}, remove() {}}, contains: () => false,
    querySelector: () => null, set innerHTML(_html) { builds++; }};
  const content = {querySelector: () => panel};
  const {window} = loadFrontend(['monitor/render'], {
    window: {}, document: {activeElement: {}, getElementById: id => id === 'monitorTabContent' ? content : null},
  });
  const app = composeMixins(window.monitorRenderMixin, {
    _builtTab: 'outputs', _shellLocale: 'zh', outputFiles: [{path: 'a'}], selectedOutputFiles: [],
    outputFilesVersion: 1, outputFilesLoading: false, _outputFilesNeedsRefresh: false,
    outputSearch: '', outputFilter: 'all', outputFilesError: '', _renderOutputsTab: () => '',
  });
  const render = () => app._renderTab('outputs', {}, null, null, key => key, false);
  render();
  app.outputFilesLoading = true;
  render();
  app.outputFilesLoading = false;
  render();
  assert.equal(builds, 1);
  app.outputFilesVersion++;
  render();
  assert.equal(builds, 2);
});

test('an already loaded empty output panel stays mounted during a refresh', () => {
  let builds = 0;
  const panel = {firstElementChild: {}, classList: {add() {}, remove() {}}, contains: () => false,
    querySelector: () => null, set innerHTML(_html) { builds++; }};
  const content = {querySelector: () => panel};
  const {window} = loadFrontend(['monitor/render'], {
    window: {}, document: {activeElement: {}, getElementById: id => id === 'monitorTabContent' ? content : null},
  });
  const app = composeMixins(window.monitorRenderMixin, {
    _builtTab: 'outputs', _shellLocale: 'zh', outputFiles: [], selectedOutputFiles: [],
    outputFilesVersion: 1, outputFilesLoading: false, _outputFilesLoaded: true, _outputFilesNeedsRefresh: false,
    outputSearch: '', outputFilter: 'all', outputFilesError: '', _renderOutputsTab: () => '',
  });
  const render = () => app._renderTab('outputs', {}, null, null, key => key, false);
  render();
  app.outputFilesLoading = true;
  render();
  app.outputFilesLoading = false;
  render();
  assert.equal(builds, 1);
});

test('initial output loading does not render a temporary toolbar', () => {
  const {window} = loadFrontend(['shared/utils', 'monitor/artifacts-render'], {window: {}});
  const app = composeMixins(window.utilsMixin, window.monitorArtifactsRenderMixin, {
    currentOutputRunDir: 'output/run', currentArtifactData: () => ({}), outputFiles: [],
    outputFilesLoading: true, _outputFilesLoaded: false, outputFilesSelected: {}, selectedOutputFiles: [],
    _visibleOutputFiles: () => [],
  });
  const html = app._renderOutputsTab(key => key);
  assert.match(html, /m-output-loading/);
  assert.doesNotMatch(html, /outputRefresh|outputDownload|outputSelectVisible/);
  app.outputFilesLoading = false;
  app._outputFilesLoaded = true;
  const empty = app._renderOutputsTab(key => key);
  assert.match(empty, /id="outputDownload"[^>]* disabled/);
  assert.match(empty, /id="outputSelectVisible"[^>]* disabled/);
});

test('sample and output refresh controls share the same icon and unavailable state', () => {
  const {window} = loadFrontend(['shared/utils', 'monitor/artifacts-render'], {window: {}});
  const app = composeMixins(window.utilsMixin, window.monitorArtifactsRenderMixin, {currentOutputRunDir: ''});
  const sample = app._monitorRefreshButtonHtml(key => key, 'sample');
  const output = app._monitorRefreshButtonHtml(key => key, 'output');
  assert.match(sample, /id="sampleRefresh"[^>]* disabled/);
  assert.match(output, /id="outputRefresh"[^>]* disabled/);
  assert.match(sample, /previewsLoading \|\| !currentOutputRunDir/);
  assert.match(output, /outputFilesLoading \|\| !currentOutputRunDir/);
  assert.equal(sample.match(/<svg.*?<\/svg>/)[0], output.match(/<svg.*?<\/svg>/)[0]);
});

test('replacing the initial output loading state does not restart the panel animation', () => {
  const classes = new Set();
  const panel = {firstElementChild: {}, classList: {add: name => classes.add(name), remove: name => classes.delete(name)},
    contains: () => false, querySelector: () => null, set innerHTML(_html) {}};
  const content = {querySelector: () => panel};
  const {window} = loadFrontend(['monitor/render'], {
    window: {}, document: {activeElement: {}, getElementById: id => id === 'monitorTabContent' ? content : null},
  });
  const app = composeMixins(window.monitorRenderMixin, {
    _builtTab: 'outputs', _shellLocale: 'zh', outputFiles: [], selectedOutputFiles: [],
    outputFilesVersion: 1, outputFilesLoading: true, _outputFilesLoaded: false, _outputFilesNeedsRefresh: false,
    outputSearch: '', outputFilter: 'all', outputFilesError: '', _renderOutputsTab: () => '',
  });
  const render = () => app._renderTab('outputs', {}, null, null, key => key, false);
  render();
  assert.equal(classes.has('no-enter-anim'), true);
  app.outputFiles = [{path: 'a'}];
  app._outputFilesLoaded = true;
  app.outputFilesLoading = false;
  app.outputFilesVersion++;
  render();
  assert.equal(classes.has('no-enter-anim'), true);
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
