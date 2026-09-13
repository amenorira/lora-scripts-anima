const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
global.window = {};
global.document = { getElementById: () => null };
global.WebSocket = { OPEN: 1 };
eval(fs.readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-core.js', 'utf8'));
eval(fs.readFileSync('frontend/js/realtime.js', 'utf8'));

function app(overrides = {}) {
  const value = Object.create(window.monitorCoreMixin);
  Object.assign(value, window.realtimeMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: 'A',
    monitorData: { state: 'RUNNING', active_task: { id: 'A' }, step: 12, detail: true },
    lossSeries: [], previews: [], logLines: [], logFullLines: [],
    _previewMediaObjectUrls: [], _realtimeTopics: new Set(),
    t: key => key, renderDashboard() {}, scheduleRender() {},
    startProgress() {}, finishProgress() {}, toast() {},
    _sendRealtimeSubscriptions() {}, _saveRealtimeCursors() {},
    _saveRealtimeInstanceId() {}, _applyRealtimeSnapshotCursors() {},
  }, overrides);
  return value;
}
const snapshot = (id = 'A') => ({
  tasks: { managed: [{ id, status: 'RUNNING' }] },
  monitor: { detail: true, state: 'RUNNING', active_task: { id }, step: 15 },
});
const response = data => ({ ok: true, json: async () => ({ status: 'success', data }) });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('detail hydration issues a valid HTTP request and applies metrics', async () => {
  const a = app();
  let url;
  global.fetch = async value => { url = value; return response(snapshot()); };
  assert.equal(await a._refreshRealtimeSnapshot(null, null, { monitorDetail: true }), true);
  assert.equal(new URL(url, 'http://localhost').searchParams.get('detail'), 'true');
  assert.equal(a.monitorData.step, 15);
});

test('returning to dashboard restores task subscription and consumes progress', () => {
  const a = app({ refreshMonitorRealtimeDetail() {} });
  a._setMonitorRealtimeTask('A');
  a.stopMonitorRealtime();
  a.startMonitorRealtime();
  assert.equal(a._monitorRealtimeTopic, 'task:A');
  assert.ok(a._realtimeTopics.has('task:A'));
  a.handleRealtimeMonitorEvent({ topic: 'task:A', type: 'task.progress', payload: { data: { step: 99 } } });
  assert.equal(a.monitorData.step, 99);
  a._setMonitorRealtimeTask(null);
  a._applyManagedTrainingState(snapshot());
  assert.equal(a._monitorRealtimeTopic, 'task:A');
});

test('late history response cannot overwrite live data or newer history', async () => {
  for (const destination of [null, 'output/B']) {
    const pending = deferred();
    global.fetch = () => pending.promise;
    const a = app({ selectedRunDir: 'output/A' });
    const request = a._fetchRunDetail('output/A');
    a.resetRunDetailState();
    a.selectedRunDir = destination;
    a.lossSeries = [{ tag: 'current' }];
    pending.resolve(response({ tensorboard_loss: [{ tag: 'stale' }] }));
    await request;
    assert.deepEqual(a.lossSeries, [{ tag: 'current' }]);
    assert.equal(a.runDetailData, null);
  }
});

test('snapshot started before task switch cannot overwrite the new task', async () => {
  const pending = deferred();
  global.fetch = () => pending.promise;
  const a = app();
  const request = a._refreshRealtimeSnapshot(null, null, { monitorDetail: true });
  a.claimLiveTask('B');
  a.monitorData = { state: 'RUNNING', active_task: { id: 'B' }, step: 2 };
  pending.resolve(response(snapshot('A')));
  await request;
  assert.equal(a.monitorData.active_task.id, 'B');
  assert.equal(a.monitorData.step, 2);
});

test('compact snapshot preserves progress and detail does not own lifecycle', () => {
  const a = app();
  a.applyRealtimeMonitorSnapshot({ monitor: { detail: false, state: 'IDLE', step: 0 } });
  assert.equal(a.monitorData.step, 12);
  a._applyTaskView('FINISHED');
  a.applyRealtimeMonitorSnapshot(snapshot());
  assert.equal(a.monitorData.state, 'FINISHED');
  assert.equal(a.isTraining, false);
});

test('new task subscribes and hydrates without accepting cached previous task', () => {
  let refreshes = 0;
  const a = app({ refreshMonitorRealtimeDetail() { refreshes++; } });
  a.beginLiveMonitorTask('B', 'RUNNING');
  assert.equal(a._monitorRealtimeTopic, 'task:B');
  assert.equal(refreshes, 1);
  a.applyRealtimeMonitorSnapshot(snapshot('A'));
  assert.equal(a.monitorData.active_task.id, 'B');
});

test('detail response is discarded after leaving and reentering dashboard', async () => {
  const pending = deferred();
  global.fetch = () => pending.promise;
  const a = app();
  const request = a._refreshRealtimeSnapshot(null, null, { monitorDetail: true });
  a.stopMonitorRealtime();
  pending.resolve(response(snapshot()));
  await request;
  assert.equal(a.monitorData.step, 12);
});

test('history browsing still tracks training start and completion', () => {
  const a = app({ selectedRunDir: 'output/history', liveTaskId: null });
  a._applyManagedTrainingState(snapshot());
  assert.equal(a.liveTaskId, 'A');
  assert.equal(a.isTraining, true);
  a.handleTaskCompletion = () => {};
  a._applyManagedTrainingState({ tasks: { managed: [{ id: 'A', status: 'FINISHED' }] } });
  assert.equal(a.isTraining, false);
  assert.equal(a.selectedRunDir, 'output/history');
});

test('offline detail refresh retries after joining compact bootstrap', async () => {
  const a = app({ monitorData: { detail: false }, realtimeSnapshot: { monitor: { detail: false } } });
  let calls = 0;
  a._refreshRealtimeSnapshot = async () => { calls++; };
  await a.refreshMonitorRealtimeDetail();
  assert.equal(calls, 2);
});
