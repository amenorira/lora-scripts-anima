const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend, response, deferred } = require('./helpers.cjs');
global.document = { getElementById: () => null };
global.WebSocket = { OPEN: 1 };
loadGlobalFrontend(['monitor/logs', 'monitor/core', 'monitor/artifacts-render', 'shared/realtime']);

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

test('page switches retain the task subscription and history does not overwrite live curves', () => {
  const a = app({ refreshMonitorRealtimeDetail() {} });
  a._setMonitorRealtimeTask('A');
  a.stopMonitorRealtime();
  a.currentRoute = 'settings';
  assert.equal(a._monitorRealtimeTopic, 'task:A');
  a.handleRealtimeMonitorEvent({ topic: 'task:A', type: 'task.progress', payload: { data: { step: 98 } } });
  a.selectedRunDir = 'output/history';
  a.runDetailData = { tensorboard_loss: [{ tag: 'history' }] };
  a.handleRealtimeTaskMetrics({ points: { 'loss/current': [{ step: 98, value: .2 }] } });
  assert.equal(a.lossSeries[0].latest, .2);
  assert.equal(a.monitorLossSeries[0].tag, 'history');
  a.resetRunDetailState();
  assert.equal(a.monitorLossSeries[0].latest, .2);
  a.currentRoute = 'monitor-dashboard';
  a.startMonitorRealtime();
  assert.equal(a._monitorRealtimeTopic, 'task:A');
  assert.ok(a._realtimeTopics.has('task:A'));
  a.handleRealtimeMonitorEvent({ topic: 'task:A', type: 'task.progress', payload: { data: { step: 99 } } });
  assert.equal(a.monitorData.step, 99);
  a._setMonitorRealtimeTask(null);
  a._applyManagedTrainingState(snapshot());
  assert.equal(a._monitorRealtimeTopic, 'task:A');
  a.stopMonitorRealtime();
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

test('leaving the dashboard cancels retained grid motion before exit callbacks can restart media loading', async () => {
  const exit = deferred();
  let cancelled = 0, mediaUpdates = 0;
  const animation = {finished: exit.promise, cancel() {cancelled++; exit.reject(new Error('cancelled'));}};
  const ghost = {style: {}, isConnected: false,
    classList: {remove() {}, add() {}, contains: name => name === 'm-sample-motion-ghost'},
    removeAttribute() {}, setAttribute() {}, querySelectorAll: () => [],
    animate: () => animation, getAnimations: () => [animation], remove() {this.isConnected = false;}};
  const rect = left => ({left, top: 0, right: left + 100, bottom: 120, width: 100, height: 120});
  const cover = {node: {}, visual: {animate() {throw new Error('the unchanged cover visual must remain still');}}, batchId: 'batch', rect: rect(0)};
  const grid = {scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => ({left: 0, top: 0, right: 600, bottom: 400}),
    append(node) {node.isConnected = true;}, querySelectorAll: () => ghost.isConnected ? [ghost] : [], closest: () => ({})};
  const a = app({...window.monitorArtifactsRenderMixin,
    _sampleLayoutAction: 7, _sampleOverviewPanel: () => ({querySelector: () => grid}),
    _captureSampleLayout: () => new Map([['cover', cover]]), closePreviewLightbox() {},
    _updateSampleExpansionMedia() {mediaUpdates++;},
  });
  a._animateSampleLayout(grid, new Map([['cover', cover], ['child', {
    node: {animate() {}, cloneNode: () => ghost}, batchId: 'batch', rect: rect(112),
  }]]));
  assert.equal(ghost.isConnected, true);
  a.stopMonitorRealtime();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a._sampleLayoutAction, 8, 'pending sidebar layout callbacks become stale');
  assert.equal(cancelled, 1);
  assert.equal(ghost.isConnected, false);
  assert.equal(mediaUpdates, 0, 'cancelled exits cannot restart the stopped media queue');
});
