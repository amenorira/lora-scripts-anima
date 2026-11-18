const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, deferred, response } = require('./helpers.cjs');

test('fresh load and reconnect subscribe from a snapshot without persisting event cursors', async () => {
  const sent = [], delivered = [], storageKeys = [];
  let snapshotSeq = 7;
  const { window } = loadFrontend('shared/realtime', {
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
    _setRealtimeState() {}, _startRealtimePing() {}, _applyRealtimeSnapshot() {}, handleRealtimeResyncRequired() {},
    _sendRealtime(message) { sent.push(message); },
    _dispatchRealtimeEvent(event) { delivered.push(event.seq); },
  });
  app._loadRealtimeState();
  const connect = app._handleRealtimeReady({ server_instance_id: 'instance-1' }, socket);
  assert.equal(sent.length, 0);
  await connect;
  assert.equal(sent[0].resume['task:train-1'], 7);
  const deliver = seq => app._handleRealtimeMessage({ op: 'event', topic: 'task:train-1', seq }, socket);
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
  const { window } = loadFrontend(['shared/realtime', 'monitor/core', 'training/toml'], {
    window: {}, document: { getElementById: () => null }, requestAnimationFrame: callback => callback(),
  });
  const app = Object.assign({}, window.realtimeMixin, window.monitorCoreMixin, window.trainingTomlMixin, {
    t: key => key, currentRoute: '', closePreviewLightbox() {},
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

test('a delayed state poll cannot replace a newer server instance', async () => {
  const pending = deferred(), applied = [];
  const { window } = loadFrontend('monitor/core', {
    window: {}, AbortController, setTimeout, clearTimeout, fetch: () => pending.promise,
  });
  const app = composeMixins(window.monitorCoreMixin, {
    realtimeInstanceId: 'old', realtimeReady: true,
    _recordRealtimeHttpResult() {}, _saveRealtimeInstanceId() {},
    _handleRealtimeServerRestart() { applied.push('restart'); },
    applyRegularizationActivity() { applied.push('regularization'); },
    _applyManagedTrainingState() { applied.push('training'); },
  });
  const poll = app._pollTrainingState();
  app.realtimeInstanceId = 'new';
  pending.resolve(response({ server_instance_id: 'old', tasks: { managed: [{ id: 'old-task', status: 'RUNNING' }] } }));
  await poll;
  assert.equal(app.realtimeInstanceId, 'new');
  assert.deepEqual(applied, []);
});

test('repeated online updates resume sample loading only on a state change', () => {
  const { window } = loadFrontend('shared/realtime', { window: {} });
  const media = [];
  const app = Object.assign({}, window.realtimeMixin, {
    setPreviewMediaPaused: value => media.push(value),
  });
  app._setRealtimeState('online');
  app._setRealtimeState('online');
  app._setRealtimeState('degraded');
  app._setRealtimeState('degraded');
  app._setRealtimeState('online');
  assert.deepEqual(media, [false, true, false]);
});

test('received frames update transport freshness while earlier processing is pending', async () => {
  const processing = deferred();
  let socket;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { socket = this; this.readyState = 0; }
  }
  const { window } = loadFrontend('shared/realtime', {
    window: { location: { protocol: 'http:', host: 'localhost' } }, WebSocket: Socket,
    setTimeout: () => 1, clearTimeout() {},
  });
  const app = composeMixins(window.realtimeMixin, { _setRealtimeState() {}, _stopRealtimePing() {} });
  app._connectRealtimeNow();
  app._realtimeInboundChain = processing.promise;
  socket.onmessage({ data: JSON.stringify({ op: 'pong' }) });
  assert.ok(app._realtimeLastMessageAt > 0);
  processing.resolve();
  await app._realtimeInboundChain;
});

test('snapshot timeout remains active while the response body is being read', async () => {
  let deadline, signal, cleared = false;
  const reading = deferred();
  const { window } = loadFrontend('shared/realtime', {
    window: {}, AbortController,
    setTimeout(callback) { deadline = callback; return 1; }, clearTimeout() { cleared = true; },
    fetch: async (_url, options) => {
      signal = options.signal;
      return { ok: true, json: () => { reading.resolve(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); } };
    },
  });
  const app = composeMixins(window.realtimeMixin, { realtimeInstanceId: 'server-1' });
  const snapshot = app._refreshRealtimeSnapshot('server-1', null);
  await reading.promise;
  assert.equal(cleared, false);
  deadline();
  assert.equal(await snapshot, false);
  assert.equal(signal.aborted, true);
  assert.equal(cleared, true);
});

test('snapshot processing errors are reported without advancing cursors', async () => {
  const errors = [];
  const { window } = loadFrontend(['shared/realtime', 'monitor/core'], {
    window: {}, WebSocket: { OPEN: 1 }, AbortController, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args) },
    fetch: async () => response({ server_instance_id: 'server-1', cursors: { 'task:a': 9 }, monitor: { detail: true } }),
  });
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', realtimeInstanceId: 'server-1', liveTaskId: 'task-a',
    monitorData: { active_task: { id: 'task-a' } }, _saveRealtimeInstanceId() {},
    _applyRealtimeSnapshot() { throw new Error('snapshot bug'); },
    applyRealtimeMonitorSnapshot() { throw new Error('detail bug'); },
  });
  assert.equal(await app._refreshRealtimeSnapshot('server-1', null), false);
  assert.equal(app._realtimeCursors?.['task:a'], undefined);
  assert.match(errors[0][1].message, /snapshot bug/);
  await assert.rejects(app.refreshMonitorRealtimeDetail(), /detail bug/);
  assert.equal(app._realtimeSnapshotController, null);
  assert.equal(app._monitorRealtimeDetailRequest, null);
});

test('queued realtime messages apply snapshot scopes in order', async () => {
  const requests = [], applied = [];
  let socket;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { socket = this; this.readyState = 0; }
  }
  const { window } = loadFrontend('shared/realtime', {
    window: { location: { protocol: 'http:', host: 'localhost' } }, WebSocket: Socket, AbortController, setTimeout, clearTimeout,
    fetch() { const pending = deferred(); requests.push(pending); return pending.promise; },
  });
  const app = composeMixins(window.realtimeMixin, {
    currentRoute: 'home', realtimeInstanceId: 'server-1', _realtimeTopics: new Set(['task:a']),
    _stopRealtimePing() {}, _setRealtimeState() {}, _startRealtimePing() {}, _sendRealtimeSubscriptions() {},
    handleRealtimeResyncRequired() {},
    _saveRealtimeInstanceId() {}, _applyRealtimeSnapshot: snapshot => applied.push(snapshot.marker),
  });
  app._connectRealtimeNow();
  socket.readyState = 1;
  socket.onmessage({ data: JSON.stringify({ op: 'ready', server_instance_id: 'server-1' }) });
  await new Promise(resolve => setImmediate(resolve));
  socket.onmessage({ data: JSON.stringify({ op: 'resync_required', topics: ['task:a'] }) });
  assert.equal(requests.length, 1);
  requests[0].resolve(response({ server_instance_id: 'server-1', marker: 'old', cursors: { 'task:a': 1 }, tasks: { tracked: [] } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].resolve(response({ server_instance_id: 'server-1', marker: 'new', cursors: { 'task:a': 2 }, tasks: { tracked: [] } }));
  await app._realtimeInboundChain;
  assert.deepEqual(applied, ['old', 'new']);
  assert.equal(app._realtimeCursors['task:a'], 2);
});

test('a queued retry from an old socket cannot cancel a new socket retry', async () => {
  const blocked = deferred(), timers = [];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; }
  }
  const { window } = loadFrontend('shared/realtime', {
    window: { location: { protocol: 'http:', host: 'localhost' } }, WebSocket: Socket,
    setTimeout(callback) { const timer = { callback }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
  });
  const oldSocket = { readyState: 2 };
  const app = composeMixins(window.realtimeMixin, {
    realtimeSocket: oldSocket, realtimeInstanceId: 'server-1', _realtimeInboundChain: blocked.promise,
    _setRealtimeState() {}, _stopRealtimePing() {},
  });
  app._scheduleRealtimeSnapshotRetry('server-1');
  timers[0].callback();
  const oldRetry = app._realtimeInboundChain;
  app._connectRealtimeNow();
  app._scheduleRealtimeSnapshotRetry('server-1');
  const newRetry = app._realtimeSnapshotRetryTimer;
  blocked.resolve();
  await oldRetry;
  assert.equal(timers[0].cancelled, true);
  assert.equal(app._realtimeSnapshotRetryTimer, newRetry);
});

test('failed initial bootstrap retries on the same socket before subscribing', async () => {
  const timers = [], sent = [];
  let socket, reads = 0;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { socket = this; this.readyState = 0; }
  }
  const { window } = loadFrontend('shared/realtime', {
    window: { location: { protocol: 'http:', host: 'localhost' } }, WebSocket: Socket, AbortController,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    fetch: async () => ++reads === 1 ? { ok: false } : response({ server_instance_id: 'server-1', cursors: {} }),
  });
  const app = composeMixins(window.realtimeMixin, {
    currentRoute: 'home', _realtimeTopics: new Set(['task:a']), _setRealtimeState() {}, _stopRealtimePing() {},
    _wakeTrainingStatePoll() {}, _saveRealtimeInstanceId() {}, _applyRealtimeSnapshot() {}, _startRealtimePing() {},
    _sendRealtime: message => sent.push(message),
  });
  app._connectRealtimeNow();
  socket.readyState = 1;
  socket.onmessage({ data: JSON.stringify({ op: 'ready', server_instance_id: 'server-1' }) });
  await app._realtimeInboundChain;
  assert.equal(app.realtimeReady, false);
  assert.deepEqual(sent, []);
  timers.find(timer => timer.delay === 500 && !timer.cancelled).callback();
  await app._realtimeInboundChain;
  assert.equal(reads, 2);
  assert.equal(app.realtimeReady, true);
  assert.equal(sent[0].op, 'subscribe');
});

for (const transition of ['server restart', 'socket closing']) {
  test(`a snapshot from before ${transition} is ignored`, async () => {
    const pending = deferred(), socket = { readyState: 1 }, applied = [];
    let reads = 0;
    const { window } = loadFrontend('shared/realtime', {
      window: {}, WebSocket: { OPEN: 1 }, AbortController, setTimeout, clearTimeout,
      fetch: () => { reads++; return pending.promise; },
    });
    const app = composeMixins(window.realtimeMixin, {
      realtimeSocket: socket, realtimeInstanceId: 'server-1', _realtimeCursors: { 'task:a': 5 },
      _applyRealtimeSnapshot: data => applied.push(data),
    });
    const request = app._refreshRealtimeSnapshot('server-1', socket);
    if (transition === 'server restart') app.realtimeInstanceId = 'server-2';
    else socket.readyState = 2;
    pending.resolve(response({ server_instance_id: 'server-1', cursors: { 'task:a': 7 } }));
    assert.equal(await request, false);
    assert.equal(await app._refreshRealtimeSnapshot('server-1', socket), false);
    assert.equal(reads, 1);
    assert.equal(app.realtimeInstanceId, transition === 'server restart' ? 'server-2' : 'server-1');
    assert.equal(app._realtimeCursors['task:a'], 5);
    assert.deepEqual(applied, []);
  });
}

test('monitor detail retries a transient failure and offers retry after repeated failures', async () => {
  let failures = 1, requests = 0, progressFinished = 0;
  const { window } = loadFrontend('monitor/core', {
    window: {}, WebSocket: { OPEN: 1 }, AbortController, setTimeout, clearTimeout,
    fetch: async () => {
      requests++;
      if (failures-- > 0) return { ok: false, json: async () => ({ status: 'error' }) };
      return response({ server_instance_id: 'server-1', monitor: { detail: true } });
    },
  });
  const app = composeMixins(window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', realtimeInstanceId: 'server-1', liveTaskId: 'task-a',
    monitorData: { active_task: { id: 'task-a' } },
    applyRealtimeMonitorSnapshot() {}, finishProgress() { progressFinished++; },
  });
  await app.refreshMonitorRealtimeDetail();
  assert.equal(requests, 2);
  assert.equal(app.monitorDetailError, false);
  failures = 2;
  await app.refreshMonitorRealtimeDetail();
  assert.equal(app.monitorDetailError, true);
  assert.equal(progressFinished, 1);
  await app.refreshMonitorRealtimeDetail();
  assert.equal(app.monitorDetailError, false);
});

test('completed run details can finish on a slow disk without a fixed deadline', async () => {
  const pending = deferred(), timeouts = [], applied = [];
  const { window } = loadFrontend('monitor/core', {
    window: {}, WebSocket: { OPEN: 1 }, AbortController,
    setTimeout(_callback, delay) { timeouts.push(delay); return 1; }, clearTimeout() {},
    fetch: () => pending.promise,
  });
  const app = composeMixins(window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: null,
    monitorData: { state: 'FINISHED', run_dir: 'output/old', active_task: { id: 'old' } },
    applyRealtimeMonitorSnapshot: snapshot => applied.push(snapshot), renderDashboard() {},
  });
  const request = app.refreshMonitorRealtimeDetail();
  assert.deepEqual(timeouts, []);
  pending.resolve(response({ run_dir: 'output/old' }));
  await request;
  assert.equal(applied.length, 1);
});

test('monitor detail requests coalesce independently from the connection snapshot', async () => {
  const requests = [];
  const { window } = loadFrontend(['shared/realtime', 'monitor/core'], {
    window: {}, document: { getElementById: () => null }, WebSocket: { OPEN: 1 }, AbortController,
    setTimeout, clearTimeout,
    fetch(url) { const pending = deferred(); requests.push({ url, ...pending }); return pending.promise; },
  });
  const socket = { readyState: 1 }, applied = [];
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    realtimeSocket: socket, realtimeInstanceId: 'server-1', currentRoute: 'monitor-dashboard',
    liveTaskId: 'task-a', monitorData: { state: 'RUNNING', active_task: { id: 'task-a' } },
    _saveRealtimeInstanceId() {}, _applyRealtimeSnapshot() {},
    applyRealtimeMonitorSnapshot(data) { applied.push(data); },
  });
  const detail1 = app.refreshMonitorRealtimeDetail();
  const detail2 = app.refreshMonitorRealtimeDetail();
  const bootstrap = app._refreshRealtimeSnapshot('server-1', socket);
  assert.deepEqual(requests.map(r => r.url), ['/api/realtime/monitor-detail', '/api/realtime/snapshot']);
  requests[1].resolve(response({ server_instance_id: 'server-1', cursors: {} }));
  requests[0].resolve(response({ server_instance_id: 'server-1', monitor: { detail: true } }));
  await Promise.all([detail1, detail2, bootstrap]);
  assert.equal(applied.length, 1);
});

test('a disconnected socket does not discard an otherwise current HTTP detail', async () => {
  const pending = deferred(), applied = [];
  const { window } = loadFrontend('monitor/core', {
    window: {}, AbortController, setTimeout, clearTimeout, fetch: () => pending.promise,
  });
  const app = composeMixins(window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', realtimeInstanceId: 'server-1', realtimeSocket: { readyState: 1 },
    liveTaskId: 'task-a', monitorData: { active_task: { id: 'task-a' } },
    applyRealtimeMonitorSnapshot: data => applied.push(data),
  });
  const request = app.refreshMonitorRealtimeDetail();
  app.realtimeSocket = null;
  pending.resolve(response({ server_instance_id: 'server-1', monitor: { detail: true } }));
  await request;
  assert.equal(applied.length, 1);
});

test('bootstrap refreshes a pending live detail after advancing its subscription cursor', async () => {
  const requests = [], steps = [], socket = { readyState: 1 };
  const { window } = loadFrontend(['shared/realtime', 'monitor/core'], {
    window: {}, WebSocket: { OPEN: 1 }, AbortController, setTimeout, clearTimeout,
    fetch() { const pending = deferred(); requests.push(pending); return pending.promise; },
  });
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', realtimeInstanceId: 'server-1', realtimeSocket: socket,
    liveTaskId: 'task-a', monitorData: { active_task: { id: 'task-a' } },
    _setRealtimeState() {}, _startRealtimePing() {}, _sendRealtimeSubscriptions() {},
    applyRealtimeMonitorSnapshot: data => steps.push(data.monitor.step),
  });
  const first = app.refreshMonitorRealtimeDetail();
  app._finishRealtimeBootstrap('server-1', socket);
  const followup = app._monitorRealtimeDetailRequest.followup;
  assert.equal(requests.length, 1);
  requests[0].resolve(response({ server_instance_id: 'server-1', monitor: { detail: true, step: 10 } }));
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].resolve(response({ server_instance_id: 'server-1', monitor: { detail: true, step: 12 } }));
  await followup;
  assert.deepEqual(steps, [10, 12]);
});

test('an HTTP state poll reloads the dashboard after detecting a server restart', async () => {
  const requests = [], applied = [];
  const { window } = loadFrontend(['shared/realtime', 'monitor/core'], {
    window: {}, AbortController, setTimeout, clearTimeout,
    fetch(url) {
      if (url.startsWith('/api/realtime/state')) return Promise.resolve(response({ server_instance_id: 'new', tasks: { managed: [] } }));
      const pending = deferred(); requests.push(pending); return pending.promise;
    },
  });
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', realtimeInstanceId: 'old', monitorData: { state: 'IDLE' },
    _saveRealtimeInstanceId() {}, applyRegularizationActivity() {}, _applyManagedTrainingState() {},
    _handleRealtimeServerRestart() { this.liveTaskBoundaryAt++; },
    applyRealtimeMonitorSnapshot: data => applied.push(data.server_instance_id),
  });
  const old = app.refreshMonitorRealtimeDetail();
  await app._pollTrainingState();
  assert.equal(requests.length, 2);
  requests[0].resolve(response({ server_instance_id: 'old', monitor: { detail: true } }));
  requests[1].resolve(response({ server_instance_id: 'new', monitor: { detail: true } }));
  await old;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, ['new']);
});

test('an offline fresh session records its first instance and detects a later restart', async () => {
  const requests = [], applied = [], saved = [];
  let server = 'first';
  const { window } = loadFrontend(['shared/realtime', 'monitor/core'], {
    window: {}, AbortController, setTimeout, clearTimeout,
    fetch(url) {
      if (url.startsWith('/api/realtime/state')) return Promise.resolve(response({ server_instance_id: server, tasks: { managed: [] } }));
      const pending = deferred(); requests.push(pending); return pending.promise;
    },
  });
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', monitorData: { state: 'IDLE' },
    _saveRealtimeInstanceId() { saved.push(this.realtimeInstanceId); },
    applyRegularizationActivity() {}, _applyManagedTrainingState() {},
    _handleRealtimeServerRestart() { this.liveTaskBoundaryAt++; },
    applyRealtimeMonitorSnapshot: data => applied.push(data.server_instance_id),
  });
  const unknown = app.refreshMonitorRealtimeDetail();
  await app._pollTrainingState();
  assert.equal(app.realtimeInstanceId, 'first');
  assert.equal(requests.length, 2);
  requests[0].resolve(response({ server_instance_id: 'old', monitor: { detail: true } }));
  requests[1].resolve(response({ server_instance_id: 'first', monitor: { detail: true } }));
  await unknown;
  await new Promise(resolve => setImmediate(resolve));
  server = 'second';
  await app._pollTrainingState();
  assert.equal(requests.length, 3);
  requests[2].resolve(response({ server_instance_id: 'second', monitor: { detail: true } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved, ['first', 'second']);
  assert.deepEqual(applied, ['first', 'second']);
});

test('identifying the server does not restart an in-flight completed-run read', async () => {
  const pending = deferred(), requests = [], applied = [];
  const { window } = loadFrontend(['shared/realtime', 'monitor/core'], {
    window: {}, AbortController, setTimeout, clearTimeout,
    fetch(url) {
      if (url.startsWith('/api/realtime/state')) return Promise.resolve(response({ server_instance_id: 'first', tasks: { managed: [] } }));
      requests.push(url); return pending.promise;
    },
  });
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: null, monitorData: { state: 'FINISHED', run_dir: 'output/old' },
    _saveRealtimeInstanceId() {}, applyRegularizationActivity() {}, _applyManagedTrainingState() {},
    applyRealtimeMonitorSnapshot: data => applied.push(data), renderDashboard() {},
  });
  const detail = app.refreshMonitorRealtimeDetail();
  await app._pollTrainingState();
  pending.resolve(response({ run_dir: 'output/old' }));
  await detail;
  assert.equal(app.realtimeInstanceId, 'first');
  assert.equal(requests.length, 1);
  assert.equal(applied.length, 1);
});

test('a gap during an in-flight monitor read schedules one fresh follow-up', async () => {
  const requests = [];
  const { window } = loadFrontend('monitor/core', {
    window: {}, document: { getElementById: () => null }, WebSocket: { OPEN: 1 }, AbortController,
    setTimeout, clearTimeout,
    fetch(url) { const pending = deferred(); requests.push(pending); return pending.promise; },
  });
  const app = composeMixins(window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: 'task-a', realtimeInstanceId: 'server-1',
    monitorData: { state: 'RUNNING', active_task: { id: 'task-a' } }, applyRealtimeMonitorSnapshot() {},
  });
  const first = app.refreshMonitorRealtimeDetail();
  const follow1 = app.refreshMonitorRealtimeDetail(true), follow2 = app.refreshMonitorRealtimeDetail(true);
  assert.equal(requests.length, 1);
  requests[0].resolve(response({ server_instance_id: 'server-1', monitor: { detail: true } }));
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  requests[1].resolve(response({ server_instance_id: 'server-1', monitor: { detail: true } }));
  await Promise.all([follow1, follow2]);
  assert.equal(requests.length, 2);
});

test('a failed resync stops applying events until a fresh bootstrap succeeds', async () => {
  const { window } = loadFrontend('shared/realtime', { window: {}, WebSocket: { OPEN: 1 }, setTimeout, clearTimeout });
  let closed = 0;
  const socket = { close() { closed++; } }, delivered = [];
  const app = composeMixins(window.realtimeMixin, {
    realtimeSocket: socket, realtimeReady: true, realtimeInstanceId: 'server-1',
    _realtimeCursors: { 'task:a': 1 }, _realtimeTopics: new Set(['task:a', 'task:b']),
    _refreshRealtimeSnapshot: async () => false, _setRealtimeState() {}, _wakeTrainingStatePoll() {},
    handleRealtimeResyncRequired() {}, _dispatchRealtimeEvent: event => delivered.push(event),
  });
  const frame = seq => ({ op: 'event', topic: 'task:a', type: 'task.log', seq });
  await app._handleRealtimeMessage(frame(3), socket);
  await app._handleRealtimeMessage(frame(4), socket);
  assert.equal(app.realtimeReady, false);
  assert.deepEqual(delivered, []);
  assert.equal(app._realtimeCursors['task:a'], 1);
  assert.equal(app._realtimeReplayTopics.has('task:a'), true);
  assert.equal(app._realtimeReplayTopics.has('task:b'), true);
  assert.equal(closed, 1);
});

test('failed scoped resync retains cursors for replay on the new connection', async () => {
  const oldSocket = { readyState: 1, close() { this.readyState = 2; } }, socket = { readyState: 1 }, sent = [];
  let reads = 0;
  const { window } = loadFrontend('shared/realtime', {
    window: {}, WebSocket: { OPEN: 1 }, AbortController, setTimeout, clearTimeout,
    fetch: async () => ++reads === 1 ? { ok: false } : response({ server_instance_id: 'server-1', cursors: { 'task:a': 7, 'task:b': 10 } }),
  });
  const app = composeMixins(window.realtimeMixin, {
    currentRoute: 'home', realtimeSocket: oldSocket, realtimeReady: true, realtimeInstanceId: 'server-1',
    _realtimeTopics: new Set(['task:a', 'task:b']), _realtimeCursors: { 'task:a': 5, 'task:b': 8 },
    handleRealtimeResyncRequired() {}, _setRealtimeState() {}, _wakeTrainingStatePoll() {},
    _applyRealtimeSnapshot() {}, _startRealtimePing() {}, _sendRealtime: message => sent.push(message),
  });
  assert.equal(await app._handleRealtimeResync({ topics: ['task:a'] }, oldSocket), false);
  assert.equal(oldSocket.readyState, 2);
  await app._handleRealtimeMessage({ op: 'resync_required', topics: ['task:b'] }, oldSocket);
  assert.equal(reads, 1, 'a queued control frame from the closing connection is ignored');
  app.realtimeSocket = socket;
  assert.equal(await app._refreshRealtimeSnapshot('server-1', socket), true);
  app._finishRealtimeBootstrap('server-1', socket);
  assert.equal(sent[0].resume['task:a'], 5);
  assert.equal(sent[0].resume['task:b'], 8);
});

test('a failed task event replays on a new socket before later events', async () => {
  let closed = 0;
  const oldSocket = { readyState: 1, close() { this.readyState = 2; closed++; } }, socket = { readyState: 1 };
  const sent = [], delivered = [], states = [], errors = [];
  let fail = true;
  const { window } = loadFrontend('shared/realtime', {
    window: {}, WebSocket: { OPEN: 1 }, AbortController, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args) }, fetch: async () => response({ server_instance_id: 'server-1', cursors: { 'task:a': 7, 'task:b': 9 } }),
  });
  const app = composeMixins(window.realtimeMixin, {
    currentRoute: 'home', realtimeSocket: oldSocket, realtimeReady: true, realtimeInstanceId: 'server-1',
    _realtimeTopics: new Set(['task:a', 'task:b']), _realtimeCursors: { 'task:a': 5, 'task:b': 8 },
    _setRealtimeState: state => states.push(state), _wakeTrainingStatePoll() {}, _applyRealtimeSnapshot() {}, _startRealtimePing() {},
    _sendRealtime: message => sent.push(message),
    _dispatchRealtimeEvent(event) { if (fail) { fail = false; throw new Error('temporary'); } delivered.push(event.seq); },
  });
  const event = { op: 'event', topic: 'task:a', seq: 6, type: 'task.log' };
  await app._handleRealtimeMessage(event, oldSocket);
  assert.equal(oldSocket.readyState, 2);
  assert.equal(app.realtimeReady, false);
  assert.deepEqual(states, ['degraded']);
  assert.equal(closed, 1);
  assert.match(errors[0][1].message, /temporary/);
  await app._handleRealtimeMessage({ op: 'resync_required', topics: ['task:a'] }, oldSocket);
  assert.equal(app._realtimeCursors['task:a'], 5);
  app.realtimeSocket = socket;
  assert.equal(await app._refreshRealtimeSnapshot('server-1', socket), true);
  app._finishRealtimeBootstrap('server-1', socket);
  assert.equal(sent[0].resume['task:a'], 5);
  assert.equal(sent[0].resume['task:b'], 8);
  await app._handleRealtimeMessage({ op: 'event', topic: 'task:a', seq: 7, type: 'task.log' }, oldSocket);
  await app._handleRealtimeMessage(event, socket);
  await app._handleRealtimeMessage({ op: 'event', topic: 'task:a', seq: 7, type: 'task.log' }, socket);
  await app._handleRealtimeMessage({ op: 'event', topic: 'task:b', seq: 9, type: 'task.log' }, socket);
  assert.deepEqual(delivered, [6, 7, 9]);
  assert.equal(app._realtimeCursors['task:a'], 7);
  assert.equal(app._realtimeReplayTopics.has('task:a'), false);
});

test('unsubscribe is sent on an open socket even while resynchronizing', () => {
  const sent = [];
  const { window } = loadFrontend('shared/realtime', { window: {} });
  const app = composeMixins(window.realtimeMixin, {
    realtimeReady: false, _realtimeTopics: new Set(['hardware']), _sendRealtime: message => sent.push(message),
  });
  app.realtimeUnsubscribe('hardware');
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ op: 'unsubscribe', topics: ['hardware'] }]);
});

test('a closed socket uses a lightweight health probe independent of state polling', async () => {
  const calls = [], results = [false, false], intervals = [];
  const { window } = loadFrontend(['shared/realtime', 'monitor/core'], {
    window: {}, AbortController, setTimeout, clearTimeout,
    setInterval(callback, delay) { intervals.push({ callback, delay }); return 1; },
    fetch: async url => {
      calls.push(url);
      if (url.startsWith('/api/realtime/state')) throw new Error('state unavailable');
      return { ok: results.shift() };
    },
  });
  const states = [];
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    _realtimeSocketClosed: true, _setRealtimeState: state => states.push(state),
  });
  app._ensureRealtimeHealthProbe();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(intervals[0].delay, 2000);
  assert.deepEqual(states, []);
  await app._pollTrainingState();
  assert.equal(calls.filter(url => url === '/api/health').length, 1);
  await intervals[0].callback();
  assert.deepEqual(states, ['offline']);
  assert.equal(calls.filter(url => url === '/api/health').length, 2);
});

test('idle state polling keeps the normal cadence while realtime is disconnected', async () => {
  const timers = [];
  const { window } = loadFrontend('monitor/core', {
    window: {}, document: { hidden: false },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
  });
  const app = composeMixins(window.monitorCoreMixin, {
    realtimeState: 'degraded', liveTaskId: null, regularizationActive: false, _pollTrainingState: async () => {},
  });
  app._scheduleTrainingStatePoll(0);
  await timers[0].callback();
  assert.equal(timers[1].delay, 5000);
});
