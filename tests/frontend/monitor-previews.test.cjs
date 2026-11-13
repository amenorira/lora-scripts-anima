const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response, readRepo} = require('./helpers.cjs');

function harness() {
  const requests = [], renders = [];
  const {window} = loadFrontend(['shared/utils', 'shared/realtime', 'monitor/logs', 'monitor/core'], {
    window: {}, document: {getElementById: () => null},
    AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: url => { const pending = deferred(); requests.push({url, ...pending}); return pending.promise; },
  });
  const app = composeMixins(window.utilsMixin, window.realtimeMixin, window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: 'A', taskId: 'A',
    monitorData: {state: 'RUNNING', active_task: {id: 'A'}},
    renderDashboard: () => renders.push(app.currentRoute), scheduleRender() {},
    realtimeSubscribe() {}, realtimeUnsubscribe() {}, refreshMonitorRealtimeDetail() {}, t: key => key,
  });
  return {app, requests, renders, core: window.monitorCoreMixin};
}

test('a new task can refresh immediately and an old response cannot clear its loading state', async () => {
  const {app, requests} = harness();
  const old = app.refreshPreviews();
  app.beginLiveMonitorTask('B', 'CREATED');
  const current = app.refreshPreviews();
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /task_id=B/);
  requests[0].resolve(response([{name: 'old-task.png'}]));
  await old;
  assert.equal(app.previewsLoading, true);
  requests[1].resolve(response([{name: 'new-task.png'}]));
  await current;
  assert.equal(app.previewsLoading, false);
  assert.equal(app.previews[0].name, 'new-task.png');
});

function detailHarness(source) {
  const fixture = harness();
  const {app} = fixture;
  Object.assign(app, {
    liveTaskId: null, taskId: null,
    monitorData: {state: 'FINISHED', detail: true, run_dir: 'output/A', active_task: {id: 'A'}},
    startProgress() {}, finishProgress() {}, toast() {},
    refreshMonitorRealtimeDetail: fixture.core.refreshMonitorRealtimeDetail,
    _saveRealtimeInstanceId() {},
    _observeMonitorClock() {}, _ingestMonitorPerfSamples() {}, _recordMonitorPerfSample() {},
    _applyMonitorLogSnapshot() {},
  });
  if (source === 'history') app.selectedRunDir = 'output/A';
  if (source === 'live') {
    app.liveTaskId = app.taskId = 'A';
    app.monitorData.state = 'RUNNING';
  }
  return fixture;
}

test('a failed refresh releases loading after a detail snapshot and can be retried', async () => {
  const {app, requests} = detailHarness('completed');
  const refresh = app.refreshPreviews();
  const detail = app.refreshMonitorRealtimeDetail();
  requests[1].resolve(response({run_dir: 'output/A', previews: [{name: 'cached.png'}]}));
  await detail;
  assert.equal(app.previewsLoading, true);
  requests[0].reject(new Error('connection lost'));
  await refresh;
  assert.equal(app.previewsLoading, false);
  assert.equal(app.previews[0].name, 'cached.png');
  const retry = app.refreshPreviews();
  assert.equal(requests.length, 3);
  requests[2].resolve(response([{name: 'latest.png'}]));
  await retry;
  assert.equal(app.previewsLoading, false);
  assert.equal(app.previews[0].name, 'latest.png');
});
