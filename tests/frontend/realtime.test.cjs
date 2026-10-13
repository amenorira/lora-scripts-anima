const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

test('poll response older than ownership boundary is ignored', () => {
  const { window } = loadFrontend(['realtime', 'monitor-core', 'training-toml'], {
    window: {}, document: { getElementById: () => null }, requestAnimationFrame: callback => callback(),
  });
  const app = Object.assign({}, window.realtimeMixin, window.monitorCoreMixin, window.trainingTomlMixin, {
    t: key => key, currentRoute: '',
  });
  app.beginLiveMonitorTask('train-2', 'RUNNING');
  app._applyTaskView('RUNNING');
  app._applyManagedTrainingState({ tasks: { managed: [] } }, app.liveTaskBoundaryAt - 1);
  assert.equal(app.liveTaskId, 'train-2');
  assert.equal(app.isTraining, true);
  assert.equal(app.statusText, 'monitor.training');
  app.releaseLiveTask();
  app._applyManagedTrainingState({ tasks: { managed: [{ id: 'train-2', status: 'RUNNING' }] } }, app.liveTaskBoundaryAt - 1);
  assert.equal(app.liveTaskId, null);
  assert.equal(app.statusText, 'monitor.training');
  app._applyManagedTrainingState({ tasks: { managed: [] } }, app.liveTaskBoundaryAt + 1);
  assert.equal(app.isTraining, false);
  assert.equal(app.statusText, 'monitor.idle');
});

test('monitor detail snapshot does not skip queued task replay', () => {
  const { window } = loadFrontend('realtime');
  const app = Object.assign({}, window.realtimeMixin, {
    _realtimeCursors: { 'task:train-1': 10, server: 3 }, _realtimeTopics: new Set(['server', 'task:train-1']),
  });
  app._applyRealtimeSnapshotCursors({ 'task:train-1': 40, server: 8, hardware: 7 }, { preserveSubscribedCursors: true });
  assert.deepEqual(JSON.parse(JSON.stringify(app._realtimeCursors)), { 'task:train-1': 10, server: 3, hardware: 7 });
});
