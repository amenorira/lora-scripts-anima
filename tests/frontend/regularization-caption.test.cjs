const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred} = require('./helpers.cjs');

test('generation stops when named captions have no selected candidate', async () => {
  const {window} = loadFrontend('regularization/index', {window:{}});
  const messages = [], calls = [];
  const app = composeMixins(window.regularizationMixin, {
    regBusy:false, trainingActive:false, regTask:null,
    regPlan:{total:1, pending:1, candidate_selection_required:1},
    regScan:async()=>{}, regReportError:message=>messages.push(message),
    regT:key=>key, regStart:async()=>calls.push('start'), regAgain:async()=>calls.push('again'),
  });
  await app.regGenerate();
  assert.deepEqual(messages, ['candidateSelectionRequired']);
  assert.deepEqual(calls, []);
});

function restartHarness() {
  const {window} = loadFrontend(['shared/realtime', 'regularization/index'], {window:{},clearTimeout,clearInterval});
  return composeMixins(window.realtimeMixin, window.regularizationMixin, {
    currentRoute:'regularization', realtimeReady:true, realtimeState:'online',
    regTask:{task_id:'old-task',run_key:'reg_old',status:'running',updated_at:100}, regRunKey:'reg_old',
    realtimeUnsubscribe(){}, toast(){}, t:key=>key, regSyncTimer(){},
    resetRealtimeMonitorState(){}, resetRealtimeTrainingState(){}, resetRealtimeTaggerState(){}, resetRealtimeEnvironmentState(){},
    regRefreshRuns:async()=>{}, regLoadLogs:async()=>{}, regReportError:message=>assert.fail(message),
  });
}

test('server restart reconciles a regularization run over HTTP despite a healthy websocket', async () => {
  const app = restartHarness(), pending = deferred(), calls = [];
  app.regRequest = path => { calls.push(path); return pending.promise; };
  app._handleRealtimeServerRestart();
  assert.equal(app.regTask.task_id, 'old-task');
  assert.equal(app.regRunning, true);
  assert.deepEqual(calls, ['/tasks/old-task']);
  pending.resolve({task_id:'old-task',run_key:'reg_old',status:'terminated',updated_at:200});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.regRunning, false);
  assert.equal(app._regTaskNeedsSync, false);
});

test('failed restart reconciliation retains the run and retries HTTP on the next refresh', async () => {
  const app=restartHarness(), errors=[];
  app.regReportError=message=>errors.push(message);
  app.regRequest=async()=>{throw new Error('temporary disconnect');};
  app.resetRealtimeRegularizationState();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.regRunning,true);
  assert.equal(app._regTaskNeedsSync,true);
  assert.equal(app._regRefreshing,false);
  assert.deepEqual(errors,['temporary disconnect']);
  app.regRequest=async()=>({task_id:'old-task',run_key:'reg_old',status:'finished',updated_at:200});
  await app.regRefreshTask();
  assert.equal(app.regRunning,false);
});

test('reconnect settles an active run without overwriting later result edits', () => {
  const app = restartHarness();
  const finished = {task_id:'old-task',run_key:'reg_old',status:'finished',updated_at:200,completed:2};
  const snapshot = {tasks: {tracked: [{task_id:'old-task', data:finished}]}};
  app.applyRealtimeRegularizationSnapshot(snapshot);
  assert.equal(app.regRunning, false);
  assert.equal(app.regTask.completed, 2);
  app.regApplyTask({...finished, completed:1, excluded:1});
  app.applyRealtimeRegularizationSnapshot(snapshot);
  assert.equal(app.regTask.completed, 1);
});

for (const eventFirst of [false, true]) {
  test(`cancel preserves terminal status with ${eventFirst ? 'an earlier event' : 'only the HTTP response'}`, async () => {
    const app = restartHarness(), pending = deferred(), unsubscribed = [];
    app._regTopic = 'task:old-task';
    app.realtimeUnsubscribe = topic => unsubscribed.push(topic);
    app.regRequest = path => {
      assert.equal(path, '/tasks/old-task/cancel');
      return pending.promise;
    };
    const stopping = app.regStop();
    const finished = { ...app.regTask, status: 'finished', updated_at: 200 };
    if (eventFirst) {
      app.handleRealtimeRegularizationEvent({ topic: 'task:old-task', type: 'task.status', payload: { data: finished } });
    }
    pending.resolve(eventFirst ? { task_id: 'old-task', status: 'stopping' } : finished);
    await stopping;
    assert.equal(app.regTask.status, 'finished');
    assert.equal(app.regRunning, false);
    assert.equal(app._regTopic, null);
    assert.deepEqual(unsubscribed, ['task:old-task']);
  });
}
test('concurrent regularization log reads share the in-flight request', async () => {
  const pending = deferred(), requests = [];
  const { window } = loadFrontend('regularization/index', { window: {} });
  const app = composeMixins(window.regularizationMixin, {
    regRunKey: 'reg_one', regLogs: [], regRequest: path => { requests.push(path); return pending.promise; },
  });
  const first = app.regLoadLogs(), second = app.regLoadLogs();
  assert.equal(requests.length, 1);
  pending.resolve(['line']);
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(app.regLogs), ['line']);
});

test('terminal log refresh starts a fresh read while an older read is pending', async () => {
  for (const failed of [false, true]) {
    const pending = deferred();
    let calls = 0;
    const { window } = loadFrontend('regularization/index', { window: {} });
    const app = composeMixins(window.regularizationMixin, {
      regRunKey: 'reg_one', regLogs: [], regRequest: () => ++calls === 1 ? pending.promise : Promise.resolve(['final']),
    });
    const first = app.regLoadLogs(), terminal = app.regLoadLogs(true);
    await terminal;
    assert.equal(calls, 2);
    if (failed) pending.reject(new Error('temporary'));
    else pending.resolve(['old']);
    await first;
    assert.deepEqual(app.regLogs, ['final']);
  }
});

test('leaving regularization ignores pending log reads without another refresh', async () => {
  for (const failed of [false, true]) {
    const pending = deferred();
    let calls = 0;
    const { window } = loadFrontend('regularization/index', { window: {}, clearTimeout, clearInterval });
    const app = composeMixins(window.regularizationMixin, {
      currentRoute: 'regularization', regRunKey: 'reg_one', regLogs: [],
      regRequest: () => { calls++; return pending.promise; }, realtimeUnsubscribe() {},
    });
    const first = app.regLoadLogs(), terminal = app.regLoadLogs(true);
    app.currentRoute = 'home';
    app.stopRegularizationWorkspace();
    if (failed) pending.reject(new Error('old request'));
    else pending.resolve(['old']);
    await Promise.all([first, terminal]);
    assert.equal(calls, 2);
    assert.deepEqual(app.regLogs, []);
  }
});

test('resuming or regenerating an inspected run reads results once', async () => {
  for (const action of ['resume', 'regenerate']) {
    let reads = 0;
    const { window } = loadFrontend('regularization/index', { window: {} });
    const task = { run_key: 'reg_one', task_id: 'new-task', status: 'running', completed: 2, failed: 0 };
    const app = composeMixins(window.regularizationMixin, {
      currentRoute: 'regularization', regTab: 'inspect', regRunKey: 'reg_one',
      regTask: { run_key: 'reg_one', task_id: 'old-task', status: 'finished', completed: 1 },
      regSelected: { index: 1 }, trainingActive: false, showConfirmModal: false,
      regRequest: async () => task, regLoadResults: async () => { reads++; },
      regSyncTimer() {}, realtimeSubscribe() {}, realtimeUnsubscribe() {}, t: key => key,
      openConfirm: async () => 'confirm', regReportError: error => assert.fail(error),
    });
    if (action === 'resume') await app.regResume();
    else await app.regMutate(app.regSelected, 'regenerate');
    assert.equal(reads, 1, action);
    assert.equal(app.regTask.task_id, 'new-task');
  }
});

test('a resumed run that finishes immediately refreshes terminal logs', async () => {
  const oldLogs = deferred();
  let logReads = 0;
  const { window } = loadFrontend('regularization/index', { window: {} });
  const finished = { run_key: 'reg_one', task_id: 'new-task', status: 'finished', completed: 2, failed: 0 };
  const app = composeMixins(window.regularizationMixin, {
    currentRoute: 'regularization', regTab: 'settings', regRunKey: 'reg_one', regSettings: {}, regDefaults: {},
    regTask: { run_key: 'reg_one', task_id: 'old-task', status: 'finished', completed: 1 },
    regRequest: async path => {
      if (path.endsWith('/logs')) return ++logReads === 1 ? oldLogs.promise : ['final'];
      if (path === '/runs') return [finished];
      return finished;
    },
    regFetchItems: async () => ({ items: [], total: 0, settings: {}, summary: finished }),
    regSyncTimer() {}, realtimeSubscribe() {}, realtimeUnsubscribe() {},
    regReportError: error => assert.fail(error),
  });
  const first = app.regLoadLogs();
  await app.regResume();
  oldLogs.resolve(['pre-terminal']);
  await first;
  assert.equal(logReads, 2);
  assert.deepEqual(app.regLogs, ['final']);
});

test('reading saved settings opens the settings tab and loads its logs', async () => {
  let logs = 0;
  const { window } = loadFrontend('regularization/index', { window: {} });
  const app = composeMixins(window.regularizationMixin, {
    currentRoute: 'regularization', regTab: 'inspect', regRunKey: 'reg_one', regSettings: {}, regDefaults: {},
    regRequest: async () => ({ settings: { seed: '5' }, overrides: {} }),
    regChanged() {}, regLoadLogs: async () => { logs++; }, toast() {}, t: key => key,
  });
  await app.regReadRunSettings();
  assert.equal(app.regTab, 'settings');
  assert.equal(app.regSettings.seed, '5');
  assert.equal(logs, 1);
});

test('regenerating while switching to settings refreshes the new task logs', async () => {
  const start = deferred();
  let logs = 0;
  const { window } = loadFrontend('regularization/index', { window: {} });
  const task = { run_key: 'reg_one', task_id: 'new-task', status: 'running', completed: 1, failed: 0 };
  const app = composeMixins(window.regularizationMixin, {
    currentRoute: 'regularization', regTab: 'inspect', regRunKey: 'reg_one',
    regTask: { run_key: 'reg_one', task_id: 'old-task', status: 'finished', completed: 1 },
    regSelected: { index: 1 }, openConfirm: async () => 'confirm',
    regRequest: async path => path.includes('/items/') ? start.promise : task,
    regLoadResults: async () => {}, regLoadLogs: async () => { logs++; },
    regSyncTimer() {}, realtimeSubscribe() {}, realtimeUnsubscribe() {}, t: key => key,
    regReportError: error => assert.fail(error),
  });
  const action = app.regMutate(app.regSelected, 'regenerate');
  await new Promise(resolve => setImmediate(resolve));
  app.regShowSettings();
  start.resolve(task);
  await action;
  assert.equal(logs, 2);
  assert.equal(app.regTask.task_id, 'new-task');
});

test('regularization tabs switch and move focus with arrow keys', () => {
  const focused = [];
  const { window } = loadFrontend('regularization/index', {
    window: {}, document: { getElementById: id => ({ focus: () => focused.push(id) }) },
  });
  const app = composeMixins(window.regularizationMixin, {
    regTab: 'settings', regShowPlan() { this.regTab = 'plan'; }, $nextTick: callback => callback(),
  });
  let prevented = false;
  app.regTabKey({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(app.regTab, 'plan');
  assert.deepEqual(focused, ['reg-tab-plan']);
});
