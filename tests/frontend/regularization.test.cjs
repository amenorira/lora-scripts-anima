const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

test('generate checks changed settings then starts, and never starts after a failed check', async () => {
  const app = fixture();
  const calls = [];
  app.regPlanDirty = true;
  app.regScan = async () => { calls.push('scan'); app.regPlan = {total:2, pending:2}; app.regPlanDirty = false; };
  app.regStart = async () => calls.push('start');
  await app.regGenerate();
  assert.deepEqual(calls, ['scan', 'start']);
  app.regPlanDirty = true;
  app.regScan = async () => { app.regReportError('invalid folder'); };
  await app.regGenerate();
  assert.deepEqual(calls, ['scan', 'start']);
  assert.deepEqual(app.toasts.at(-1), {message:'invalid folder', type:'error'});
});

test('training blocks every generation entry point before scanning or requesting', async () => {
  const app = fixture();
  app.trainingActive = true;
  app.regPlan = {total:1, pending:1};
  app.regTab = 'inspect';
  app.regScan = async () => assert.fail('must not scan');
  app.regRequest = async () => assert.fail('must not request');
  await app.regGenerate();
  await app.regStart();
  await app.regAgain();
  await app.regResume();
  await app.regResume(true);
  await app.regMutate({index:1}, 'regenerate');
});

test('training starting during a generation scan prevents launch', async () => {
  const app = fixture();
  app.regScan = async () => {
    app.regPlan = {total:1, pending:1};
    app.trainingActive = true;
  };
  app.regRequest = async () => assert.fail('must not launch');
  await app.regGenerate();
});

function fixture() {
  const saved = new Map();
  const timers = new Map(); let timerId = 0;
  const context = {window: {}, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval: () => {}, localStorage: {getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k)}};
  loadFrontend(['regularization', 'training-core', 'tagger', 'monitor-logs'], context);
  const app = Object.create(context.window.regularizationMixin);
  app.savedSettings = saved;
  app.testWindow = context.window;
  app.flushTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  app.regSettings = {seed:'-1', cfg:4, width:1024, height:768, size_mode:'bucket', extra_positive:''}; app.regDefaults = {...app.regSettings};
  app._regUndo = {}; app.regEdits = {}; app.regT = key => key;
  app.regSources = []; app.regItems = [];
  app._regFields = {}; app.stepField = context.window.trainingCoreMixin.stepField;
  app.taggerVisibleLogs = context.window.taggerMixin.taggerVisibleLogs;
  app._parseLogRecord = context.window.monitorLogRenderMixin._parseLogRecord;
  app.realtimeSubscribe = app.realtimeUnsubscribe = () => {};
  app.toasts = []; app.toast = (message, type) => app.toasts.push({message, type});
  return app;
}

function activityFixture() {
  let app;
  const context = {
    window: {}, document: {addEventListener: (_, callback) => callback(), hidden: false},
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {getItem() {}, setItem() {}, removeItem() {}},
    Alpine: {data: (_, factory) => { app = factory(); }}, AbortController,
  };
  loadFrontend(['regularization', 'training-core', 'training-toml', 'tagger', 'monitor-core', 'app'], context);
  app.t = key => key;
  app.toast = () => {};
  app.realtimeSubscribe = app.realtimeUnsubscribe = () => {};
  app.realtimeState = 'online'; app.realtimeReady = true;
  app.taggerSource = {total:1}; app.taggerSelectedModel = 'test-model';
  app.setSnapshot = active => {
    context.fetch = async () => ({ok:true, json:async () => ({status:'success', data:{
      server:{regularization_active:active}, tasks:{managed:[]},
    }})});
  };
  return app;
}

test('generation status blocks training and local tagging across routes, then releases them', async () => {
  const app = activityFixture();
  app.validateForm = () => assert.fail('blocked training must not prepare');
  for (const route of ['home', 'train-anima', 'tagger']) {
    app.currentRoute = route;
    app.setSnapshot(true); await app._pollTrainingState();
    assert.equal(app.backendStatusLabel, 'common.regularizationInProgress');
    assert.equal(app.trainingActive, false);
    assert.equal(app.isTraining, false);
    assert.equal(app.taggerCanStart(), false);
    await app.startTraining(); await app.prepareKrea2Cache();
  }
  app.taggerApiSettings = {baseUrl:'https://example.test', apiKey:'test', model:'test', promptText:'caption'};
  app.taggerSourceMode = 'api-folder';
  assert.equal(app.taggerApiCanStart(), false);
  app.taggerSourceMode = 'api-single';
  assert.equal(app.taggerApiCanStart(), true);
  app.taggerSourceMode = 'api-folder';
  // Route-local details can still contain the last running task after leaving.
  app.regTask = {status:'running'};
  app.setSnapshot(false); await app._pollTrainingState();
  assert.equal(app.backendStatusLabel, 'common.backendConnected');
  assert.equal(app.taggerCanStart(), true);
  assert.equal(app.taggerApiCanStart(), true);
  app.realtimeState = 'offline';
  assert.equal(app.backendStatusLabel, 'common.backendDisconnected');
});

test('successful launch immediately blocks GPU entries even when the detail request fails', async () => {
  const app = fixture();
  app.regPlan = {token:'plan', pending:1};
  app.regRequest = async url => {
    if (url === '/tasks') return {task_id:'new', run_key:'reg_new'};
    throw new Error('detail unavailable');
  };
  await app.regStart();
  assert.equal(app.regularizationActive, true);
  assert.equal(app.regRunning, true);
  app.applyRegularizationActivity({server:{regularization_active:false}}, app._regActivityBoundaryAt - 1);
  assert.equal(app.regularizationActive, true);
  app.applyRegularizationActivity({server:{regularization_active:false}}, app._regActivityBoundaryAt + 1);
  assert.equal(app.regularizationActive, false);
});

test('starting consumes the reviewed plan without reporting a settings change', async () => {
  const app = fixture();
  app.regPlan = {token:'reviewed',output_path:'run1',pending:1};
  app.regRefreshRuns = async()=>{};
  let calls = 0;
  app.regRequest = async path => {calls++; return path === '/tasks' ? {task_id:'gen1',run_key:'run1'} : {task_id:'gen1',run_key:'run1',output_path:'run1',status:'created',completed:0,pending:1,total:1};};
  await app.regStart();
  assert.equal(app.regPlanConsumed, true); assert.equal(app.regPlanDirty, false);
  app.regTask.status = 'finished';
  await app.regStart();
  assert.equal(calls, 2);
});

test('changed settings cannot silently resume an old run from the settings page', async () => {
  const app = fixture();
  app.regPlanConsumed = true; app.regPlan = {output_path:'old'};
  app.regTask = {task_id:'old',status:'terminated',pending:1,output_path:'old'};
  app.regSetField('cfg', 8);
  app.regRequest = async()=>{throw new Error('must not submit');};
  await app.regResume();
  assert.equal(app.regError, 'resumeDirty');
  assert.equal(app.regSettings.cfg, 8);
});

test('late task and result responses cannot overwrite another selected run', async () => {
  const app = fixture(); app.currentRoute = 'regularization'; app.regRunKey = 'A';
  app.regTask = {task_id:'A',status:'running'}; app.regLoadLogs = async()=>{};
  let reply; app.regRequest = ()=>new Promise(resolve=>reply=resolve);
  const pending = app.regRefreshTask();
  app.regRunKey = 'B'; app.regTask = {task_id:'B',status:'finished',output_path:'B'};
  reply({task_id:'A',status:'finished',output_path:'A'}); await pending;
  assert.equal(app.regTask.task_id, 'B');
  const results = app.regLoadResults();
  app.regRunKey = 'C'; app.regItems = [{index:3}];
  reply({items:[{index:2}],total:1,summary:{task_id:'B',status:'finished'}}); await results;
  assert.equal(app.regItems[0].index, 3);
});

test('another round starts once after revalidating unchanged inputs, but changed inputs need review', async () => {
  for (const changed of [false,true]) {
    const app = fixture(); app.regPlan = {fingerprint:'reviewed'}; app.regPlanConsumed = true;
    app.regRequest = async()=>({token:'new',fingerprint:changed?'changed':'reviewed'});
    app.regLoadSources = async()=>{};
    let starts = 0; app.regStart = async()=>{starts++;};
    await app.regAgain();
    assert.equal(starts, changed?0:1);
    assert.equal(app.regPlanConsumed, false);
    if (changed) assert.equal(app.toasts.at(-1).message, 'changed');
  }
});
