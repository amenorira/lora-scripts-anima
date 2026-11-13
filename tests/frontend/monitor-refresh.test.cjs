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
