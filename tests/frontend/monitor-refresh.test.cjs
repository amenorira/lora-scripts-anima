const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response} = require('./helpers.cjs');

test('a fast manual sample refresh keeps visible feedback without delaying results', async () => {
  const timers = [];
  const {window} = loadFrontend(['monitor/previews'], {
    window: {}, document: {getElementById: () => null},
    setTimeout(fn, ms) { const timer = {fn, ms, cancelled: false}; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    fetch: async () => response([{name: 'new.png'}]),
  });
  const app = composeMixins(window.monitorPreviewsMixin, {
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
  const {window} = loadFrontend(['monitor/logs', 'monitor/core'], {
    window: {}, document: {getElementById: () => null}, AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: url => { const request = deferred(); requests.push({url, ...request}); return request.promise; },
  });
  const app = composeMixins(window.monitorCoreMixin, {
    monitorData: {run_dir: 'output/run'}, outputFiles: [], outputFilesSelected: {},
    _outputFilesRunDir: 'output/run', _outputFilesRequestSeq: 0, _outputCountVersion: 0,
    selectedRunDir: null, liveTaskId: null, renderDashboard() {}, toast() {}, t: key => key,
  });
  return {app, requests};
}

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
