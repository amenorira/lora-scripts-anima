const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

test('fresh load and reconnect subscribe from a snapshot without persisting event cursors', async () => {
  const sent = [], delivered = [], storageKeys = [];
  let snapshotSeq = 7;
  const { window } = loadFrontend('realtime', {
    window: {}, WebSocket: { OPEN: 1 }, AbortController, URLSearchParams, setTimeout, clearTimeout,
    sessionStorage: {
      getItem(key) { storageKeys.push(key); return 'instance-1'; },
      setItem(key) { storageKeys.push(key); },
    },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'success', data: {
      server_instance_id: 'instance-1', cursors: { 'task:train-1': snapshotSeq },
    } }) }),
  });
  const socket = { readyState: 1 };
  const app = Object.assign({}, window.realtimeMixin, {
    realtimeSocket: socket, _realtimeTopics: new Set(['task:train-1']),
    _setRealtimeState() {}, _startRealtimePing() {}, _applyRealtimeSnapshot() {},
    _sendRealtime(message) { sent.push(message); },
    _dispatchRealtimeEvent(event) { delivered.push(event.seq); },
  });
  app._loadRealtimeState();
  const connect = app._handleRealtimeReady({ server_instance_id: 'instance-1' }, socket);
  assert.equal(sent.length, 0);
  await connect;
  assert.equal(sent[0].resume['task:train-1'], 7);
  const deliver = seq => app._handleRealtimeMessage({ data: JSON.stringify({ op: 'event', topic: 'task:train-1', seq }) }, socket);
  await deliver(8);
  await deliver(8);
  snapshotSeq = 9;
  await app._handleRealtimeReady({ server_instance_id: 'instance-1' }, socket);
  assert.equal(sent[1].resume['task:train-1'], 9);
  await deliver(10);
  snapshotSeq = 11;
  await deliver(12); // A sequence gap must refresh the snapshot before dispatch.
  assert.deepEqual(delivered, [8, 10, 12]);
  assert.equal(app._realtimeCursors['task:train-1'], 12);
  assert.ok(storageKeys.length > 0);
  assert.ok(storageKeys.every(key => key === 'anima-realtime-instance-id'));
});

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

test('snapshot drops expired cursors while preserving subscribed replay positions', () => {
  const { window } = loadFrontend('realtime');
  const app = Object.assign({}, window.realtimeMixin, {
    _realtimeCursors: { 'task:old': 3, 'task:live': 8 }, _realtimeTopics: new Set(['task:live']),
  });
  app._applyRealtimeSnapshotCursors({ server: 2 }, { preserveSubscribedCursors: true });
  assert.deepEqual(JSON.parse(JSON.stringify(app._realtimeCursors)), { 'task:live': 8, server: 2 });
});
