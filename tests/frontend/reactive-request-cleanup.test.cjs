const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, deferred, response } = require('./helpers.cjs');

test('completed request owners clear correctly through Alpine reactivity', async () => {
  const { window } = loadFrontend(['vendor/alpine.min', 'shared/realtime', 'monitor/core', 'regularization/index'], {
    window: { Element: class {} },
    document: { createElement: () => ({}), addEventListener() {}, getElementById: () => null },
    MutationObserver: class {}, queueMicrotask() {}, WebSocket: { OPEN: 1 }, AbortController, setTimeout, clearTimeout,
    fetch: async url => url.endsWith('/monitor-detail')
      ? response({ server_instance_id: 'server-1', monitor: { detail: true } })
      : response({ server_instance_id: 'server-1', cursors: {} }),
  });
  const app = window.Alpine.reactive(composeMixins(window.realtimeMixin, window.monitorCoreMixin, window.regularizationMixin, {
    realtimeInstanceId: 'server-1', currentRoute: 'monitor-dashboard', liveTaskId: 'task-a',
    monitorData: { state: 'RUNNING', active_task: { id: 'task-a' } }, regRunKey: 'reg_one',
    _saveRealtimeInstanceId() {}, _applyRealtimeSnapshot() {}, applyRealtimeMonitorSnapshot() {},
    regRequest: async () => ['line'],
  }));
  await app._refreshRealtimeSnapshot('server-1', null);
  assert.equal(app._realtimeSnapshotController, null);
  await app.refreshMonitorRealtimeDetail();
  assert.equal(app._monitorRealtimeDetailRequest, null);
  await app.regLoadLogs();
  assert.equal(app._regLogPending, null);
});

test('an old snapshot cannot clear the active controller through Alpine reactivity', async () => {
  const requests = [];
  const { window } = loadFrontend(['vendor/alpine.min', 'shared/realtime'], {
    window: { Element: class {} }, document: { createElement: () => ({}), addEventListener() {} },
    MutationObserver: class {}, queueMicrotask() {}, AbortController, setTimeout, clearTimeout,
    fetch: (_url, options) => { const pending = deferred(); requests.push({ ...pending, signal: options.signal }); return pending.promise; },
  });
  const app = window.Alpine.reactive(composeMixins(window.realtimeMixin, {
    realtimeInstanceId: 'server-1', _applyRealtimeSnapshot() {},
  }));
  const old = app._refreshRealtimeSnapshot('server-1', null);
  const current = app._refreshRealtimeSnapshot('server-1', null);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].reject(new Error('aborted'));
  assert.equal(await old, false);
  assert.equal(app._realtimeSnapshotController.signal, requests[1].signal);
  requests[1].resolve(response({ server_instance_id: 'server-1', cursors: {} }));
  assert.equal(await current, true);
  assert.equal(app._realtimeSnapshotController, null);
});

test('run refreshes coalesce, retry after a pending failure, and ignore requests from a previous visit', async () => {
  const requests = [];
  const { window } = loadFrontend(['vendor/alpine.min', 'regularization/index'], {
    window: { Element: class {} }, document: { createElement: () => ({}), addEventListener() {} },
    MutationObserver: class {}, queueMicrotask() {}, clearTimeout, clearInterval,
  });
  const app = window.Alpine.reactive(composeMixins(window.regularizationMixin, {
    currentRoute: 'regularization', realtimeUnsubscribe() {},
    regRequest() { const request = deferred(); requests.push(request); return request.promise; },
  }));
  const first = app.regRefreshRuns().catch(() => false);
  const shared = app.regRefreshRuns().catch(() => false);
  const retry = app.regRefreshRuns(true), alsoRetry = app.regRefreshRuns(true);
  assert.equal(requests.length, 1);
  requests[0].reject(new Error('temporary'));
  await Promise.all([first, shared]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].resolve([{ run_key: 'new' }]);
  assert.deepEqual(await Promise.all([retry, alsoRetry]), [true, true]);
  assert.equal(app.regRuns[0].run_key, 'new');

  const old = app.regRefreshRuns(), followup = app.regRefreshRuns(true);
  app.currentRoute = 'home';
  app.stopRegularizationWorkspace();
  app.currentRoute = 'regularization';
  const current = app.regRefreshRuns();
  requests[2].resolve([{ run_key: 'stale' }]);
  assert.deepEqual(await Promise.all([old, followup]), [false, false]);
  assert.equal(requests.length, 4);
  requests[3].resolve([{ run_key: 'current' }]);
  assert.equal(await current, true);
  assert.equal(app.regRuns[0].run_key, 'current');
  assert.equal(app._regRunsPending, null);
});
