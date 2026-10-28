const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response} = require('./helpers.cjs');

function harness() {
  const requests = [], renders = [];
  const {window} = loadFrontend(['monitor/logs', 'monitor/core'], {
    window: {}, document: {getElementById: () => null},
    fetch: url => { const pending = deferred(); requests.push({url, ...pending}); return pending.promise; },
  });
  const app = composeMixins(window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: 'A', taskId: 'A',
    monitorData: {state: 'RUNNING', active_task: {id: 'A'}},
    renderDashboard: () => renders.push(app.currentRoute), scheduleRender() {},
    realtimeSubscribe() {}, realtimeUnsubscribe() {}, refreshMonitorRealtimeDetail() {}, t: key => key,
  });
  return {app, requests, renders, core: window.monitorCoreMixin};
}

test('preview responses from a previous task are ignored before either run directory is known', async () => {
  const {app, requests} = harness();
  const pending = app.refreshPreviews();
  app.beginLiveMonitorTask('B', 'CREATED');
  requests[0].resolve(response([{name: 'old-task.png'}]));
  await pending;
  assert.deepEqual(Array.from(app.previews), []);
  assert.equal(app.liveTaskId, 'B');
});

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

function detailHarness() {
  const fixture = harness();
  const {app} = fixture;
  Object.assign(app, {
    liveTaskId: null, taskId: null,
    monitorData: {state: 'FINISHED', detail: true, run_dir: 'output/A', active_task: {id: 'A'}},
    startProgress() {}, finishProgress() {}, toast() {},
    _observeMonitorClock() {}, _ingestMonitorPerfSamples() {}, _recordMonitorPerfSample() {},
    _applyMonitorLogSnapshot() {},
  });
  return fixture;
}

test('a newer detail snapshot invalidates an older outstanding preview response', async () => {
  const {app, requests} = detailHarness();
  const old = app.refreshPreviews();
  app.applyRealtimeMonitorSnapshot({monitor: {
    detail: true, active_task: {id: 'A'}, run_dir: 'output/A',
    previews: [{name: 'new.png'}], tensorboard_loss: [],
  }}, {previews: app._previewRequestSeq});
  requests[0].resolve(response([{name: 'old.png'}]));
  await old;
  assert.equal(app.previews[0].name, 'new.png');
  assert.equal(app.previewsLoading, false);
});
