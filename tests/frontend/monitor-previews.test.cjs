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

test('leaving the dashboard invalidates a pending preview refresh without rendering another page', async () => {
  const {app, requests, renders} = harness();
  const pending = app.refreshPreviews();
  app.stopMonitorRealtime();
  app.currentRoute = 'settings';
  requests[0].resolve(response([{name: 'late.png'}]));
  await pending;
  assert.deepEqual(Array.from(app.previews), []);
  assert.deepEqual(renders, []);
  assert.equal(app.previewsLoading, false);
});

test('current preview responses retain metadata and follow the newest sample', async () => {
  const {app, requests} = harness();
  const pending = app.refreshPreviews();
  requests[0].resolve({json: async () => ({status: 'success', data: [{name: 'first.png'}, {name: 'last.png'}],
    meta: {artifact_available: true, artifact_dir: '/fixture', preview_enabled: true}})});
  await pending;
  assert.equal(app.previewStep, 1);
  assert.equal(app.previews.length, 2);
  assert.equal(app.monitorData.artifact_dir, '/fixture');
  assert.equal(app.monitorData.preview_enabled, true);
  assert.equal(app.previewsLoading, false);
});

for (const direction of ['history', 'live']) {
  test(`switching to ${direction} invalidates previews even when the run directory is unchanged`, async () => {
    const {app, requests} = harness();
    app.monitorData.run_dir = 'output/A';
    if (direction === 'live') app.selectedRunDir = 'output/A';
    const pending = app.refreshPreviews();
    if (direction === 'history') {
      app.$nextTick = async () => {};
      app._fetchRunDetail = async () => {};
      await app.viewRunDetail('output/A', true);
    } else app.resetRunDetailState();
    requests[0].resolve(response([{name: 'previous-view.png'}]));
    await pending;
    assert.deepEqual(Array.from(app.previews), []);
    assert.equal(app.previewsLoading, false);
  });
}

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

test('an older same-run detail response cannot erase a newer preview refresh', async () => {
  const {app, requests, core} = detailHarness();
  app.refreshMonitorRealtimeDetail = core.refreshMonitorRealtimeDetail;
  const detail = app.refreshMonitorRealtimeDetail();
  const previews = app.refreshPreviews();
  requests[1].resolve(response([{name: 'new.png'}]));
  await previews;
  requests[0].resolve(response({run_dir: 'output/A', previews: [], tensorboard_loss: []}));
  await detail;
  assert.equal(app.previews[0].name, 'new.png');
  assert.equal(app.monitorData.previews, app.previews);
});

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

test('a late historical detail cannot replace samples refreshed while its view was loading', async () => {
  const {app, requests} = detailHarness();
  app.$nextTick=async()=>{};
  const detail=app.viewRunDetail('output/history',true);
  await new Promise(setImmediate);
  assert.match(requests[0].url,/run-detail/);
  const previews=app.refreshPreviews();
  assert.match(requests[1].url,/run_dir=output%2Fhistory/);
  requests[1].resolve(response([{name:'new-history.png'}]));
  await previews;
  requests[0].resolve(response({previews:[],log_lines:[],tensorboard_loss:[]}));
  await detail;
  assert.equal(app.previews[0].name,'new-history.png');
  assert.equal(app.runDetailData.previews,app.previews);
  assert.equal(app.runDetailLoading,false);
});
