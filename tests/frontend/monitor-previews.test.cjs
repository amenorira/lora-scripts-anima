const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response} = require('./helpers.cjs');

function harness() {
  const requests = [], renders = [];
  const {window} = loadFrontend(['monitor-logs', 'monitor-core'], {
    window: {}, document: {getElementById: () => null},
    fetch: url => { const pending = deferred(); requests.push({url, ...pending}); return pending.promise; },
  });
  const app = composeMixins(window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: 'A', taskId: 'A',
    monitorData: {state: 'RUNNING', active_task: {id: 'A'}},
    renderDashboard: () => renders.push(app.currentRoute), scheduleRender() {},
    realtimeSubscribe() {}, realtimeUnsubscribe() {}, refreshMonitorRealtimeDetail() {}, t: key => key,
  });
  return {app, requests, renders};
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
