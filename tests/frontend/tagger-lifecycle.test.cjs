const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, response, deferred, readRepo} = require('./helpers.cjs');

test('local task creation response stays attached to the initiating source mode', async()=>{
  const pending=deferred(), storage=new Map([['anima-tagger-task-id','old-local-task']]);
  const {window}=loadFrontend('tagger/index',{window:{},fetch:()=>pending.promise,
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  const app=composeMixins(window.taggerMixin,{
    currentRoute:'tagger',taggerSourceMode:'folder',taggerSource:{source_token:'local'},
    taggerTaskId:'old-local-task',_taggerTasks:{'old-local-task':{status:'done'}},
    taggerItems:[{index:0,status:'failed',error:'Old error'}],taggerResultText:'old local result',
    taggerModels:[{id:'model',engine:'onnx'}],taggerSelectedModel:'model',
    taggerCanStart:()=>true,saveTaggerSettings(){},syncTaggerDictionary(){},
    realtimeSubscribe(){},realtimeUnsubscribe(){},toast:message=>assert.fail(message),
  });
  const start=app.startTagger();
  assert.equal(app.taggerResultText,'old local result');
  app._taggerModeStates.folder=app._captureTaggerModeState();
  app.currentRoute='ai-captioning';app.taggerSourceMode='api-folder';
  app.taggerSource={source_token:'api-draft'};
  app.taggerTaskId='api-task';app._taggerTasks['api-task']={status:'done'};
  app.taggerResultText='api result';
  pending.resolve(response({task_id:'new-local-task'}));await start;
  assert.equal(app.taggerTaskId,'api-task');
  assert.equal(app.taggerResultText,'api result');
  assert.equal(app._taggerModeStates.folder.taskId,'new-local-task');
  assert.equal(app._taggerModeStates.folder.resultText,'');
  assert.equal(app._taggerModeStates.folder.items[0].status,'pending');
  assert.equal(app._taggerModeStates.folder.items[0].error,undefined);
  assert.equal(app.taggerTaskById('old-local-task'),null);
  assert.equal(app.taggerSource.source_token,'api-draft');
  assert.equal(app.taggerTaskById('new-local-task').engine,'onnx');
  assert.equal(storage.get('anima-tagger-task-id'),'new-local-task');
  assert.equal(storage.has('anima-ai-tagger-task-id'),false);
});

test('a rejected local launch preserves the previous result, failures and recovery ID', async () => {
  const storage = new Map([['anima-tagger-task-id', 'old-task']]), errors = [];
  const {window} = loadFrontend('tagger/index', {
    window: {}, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async () => ({ json: async () => ({ status: 'fail', message: 'Another Tagger task is running' }) }),
  });
  const app = composeMixins(window.taggerMixin, {
    taggerSource: { source_token: 'source', total: 1 }, taggerSelectedModel: 'model',
    taggerTaskId: 'old-task', _taggerTasks: { 'old-task': { status: 'done', failed: 1 } },
    taggerResultText: 'old result', taggerItems: [{ index: 0, status: 'failed' }],
    toast: error => errors.push(error),
  });
  await app.startTagger();
  assert.deepEqual(errors, ['Another Tagger task is running']);
  assert.equal(app.taggerStarting, false);
  assert.equal(app.taggerTask.failed, 1);
  assert.equal(app.taggerItems[0].status, 'failed');
  assert.equal(app.taggerResultText, 'old result');
  assert.equal(storage.get('anima-tagger-task-id'), 'old-task');
});

test('failed retry releases the shared startup lock and reports its failure once', async () => {
  const messages=[];
  const {window}=loadFrontend('tagger/index',{window:{},localStorage:{getItem:()=>null},fetch:async()=>({json:async()=>({status:'fail',message:'retry failed'})})});
  const app=composeMixins(window.taggerMixin,{
    taggerTaskId:'failed-A',_taggerTasks:{'failed-A':{failed:1,status:'done'}},
    toast:message=>messages.push(message),t:key=>key,
  });
  await app.retryFailedTagger();
  assert.equal(app.taggerStarting,false);
  assert.deepEqual(messages,['retry failed']);
});

test('workspace cleanup and server restart keep an in-flight retry as the startup lock owner', async () => {
  const pending=deferred(); let requests=0;
  const {window}=loadFrontend('tagger/index',{window:{},clearTimeout,
    localStorage:{getItem:()=>null,removeItem(){}},fetch:()=>{requests++;return pending.promise;}});
  const app=composeMixins(window.taggerMixin,{
    taggerTaskId:'failed-A',_taggerTasks:{'failed-A':{failed:1,status:'done'}},
    stopCaptionWorkspace(){},tagDictionaryCleanup(){},realtimeUnsubscribe(){},
    stopTaggerSingleResize(){},toast(){},t:key=>key,
  });
  const retry=app.retryFailedTagger();
  app.stopTaggerWorkspace(); app.resetRealtimeTaggerState();
  assert.equal(app.taggerStarting,true);
  app.taggerTaskId='failed-B'; app._taggerTasks={'failed-B':{failed:1,status:'done'}};
  await app.retryFailedTagger();
  assert.equal(requests,1);
  pending.resolve(response({task_id:'retry-A'})); await retry;
  assert.equal(app.taggerStarting,false);
  assert.equal(app.taggerTaskId,'failed-B');
});

function retryRecoveryHarness({newStatus = 'done', newStatusPending, oldStatusPending, activePending} = {}) {
  const pending=deferred(), storage=new Map([['anima-tagger-task-id','failed-A']]), restored=[], requests=[];
  const {window}=loadFrontend('tagger/index',{window:{},
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    fetch:async path=>{
      requests.push(path);
      if(path.endsWith('/retry')) return pending.promise;
      if(path==='/api/tagger/tasks/active') return activePending?.promise || response({task_id:null});
      if(path==='/api/tagger/tasks/failed-A/status') return oldStatusPending?.promise || response({engine:'onnx',status:'done',failed:1,total:1,source_kind:'folder',source_token:'A',source_root:'A'});
      if(path==='/api/tagger/tasks/retry-A/status') {
        restored.push('retry-A');
        return newStatusPending?.promise || response({engine:'onnx',status:newStatus,failed:0,total:1,source_kind:'folder',source_token:'retry-source',source_root:'A'});
      }
      assert.fail('unexpected request '+path);
    },
  });
  const app=composeMixins(window.taggerMixin,{
    currentRoute:'tagger',realtimeInstanceId:'server-1',taggerSourceMode:'folder',taggerSourcePath:'A',
    taggerSource:{source_token:'A'},taggerTaskId:'failed-A',_taggerTasks:{'failed-A':{failed:1,status:'done'}},
    _mountTaggerWorkspace:async()=>{},tagDictionaryInit(){},_loadTaggerSettings(){},loadCaptionOptions(){},
    realtimeSubscribe(){},realtimeUnsubscribe(){},renderTaggerResourceBar(){},loadTaggerModels:async()=>{},
    syncTaggerDictionary(){},refreshTaggerItems:async()=>{},toast(){},t:key=>key,
  });
  return {app,pending,storage,restored,requests};
}

test('retry response after leaving and returning reconciles the task into the current mount', async () => {
  const {app,pending,storage}=retryRecoveryHarness({newStatus:'running'});
  const retry=app.retryFailedTagger();
  app.currentRoute='home'; app._taggerFormVersion++;
  app.currentRoute='tagger'; await app.buildTaggerForm();
  assert.equal(app.taggerTaskId,'failed-A');
  app.taggerSource={...app.taggerSource};
  pending.resolve(response({task_id:'retry-A'})); await retry;
  assert.equal(app.taggerTaskId,'retry-A');
  assert.equal(app.taggerTask.status,'running');
  assert.equal(app._taggerRealtimeTopic,'task:retry-A');
  assert.equal(storage.get('anima-tagger-task-id'),'retry-A');
  assert.equal(app.taggerStarting,false);
});

test('retry recovery uses the response instance when the server was initially unknown', async () => {
  for (const [started, current, returned, accepted, finalInstance] of [
    [null, null, 'server-a', true, 'server-a'],
    [null, 'server-a', 'server-a', true, 'server-a'],
    ['server-a', 'server-a', 'server-b', false, 'server-a'],
    ['server-a', 'server-b', 'server-b', false, 'server-b'],
  ]) {
    const { app, pending, storage, requests } = retryRecoveryHarness();
    app.realtimeInstanceId = started;
    app._saveRealtimeInstanceId = () => {};
    const retry = app.retryFailedTagger();
    app.realtimeInstanceId = current;
    pending.resolve(response({ task_id: 'retry-A', server_instance_id: returned }));
    await retry;
    assert.equal(app.taggerTaskId, accepted ? 'retry-A' : 'failed-A');
    assert.equal(storage.get('anima-tagger-task-id'), accepted ? 'retry-A' : 'failed-A');
    assert.equal(app.realtimeInstanceId, finalInstance);
    assert.equal(requests.filter(path => path.endsWith('/retry')).length, 1);
  }
});

test('task restore accepts only a matching response when an unknown instance becomes known', async () => {
  for (const [started, current, returned, accepted, finalInstance] of [
    [null, null, 'server-a', true, 'server-a'],
    [null, 'server-a', 'server-a', true, 'server-a'],
    [null, 'server-a', 'server-b', false, 'server-a'],
    ['server-a', 'server-b', 'server-b', false, 'server-b'],
  ]) {
    const pending = deferred(), storage = new Map([['anima-tagger-task-id', 'task-1']]);
    let itemReads = 0;
    const { window } = loadFrontend('tagger/index', {
      window: {}, fetch: () => pending.promise,
      localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    });
    const app = composeMixins(window.taggerMixin, {
      currentRoute: 'tagger', realtimeInstanceId: started, taggerSourceMode: 'folder', _taggerTasks: {}, _taggerModeStates: {},
      _saveRealtimeInstanceId() {}, refreshTaggerItems: async () => { itemReads++; }, toast() {}, t: key => key,
    });
    const restore = app.restoreTaggerTask('task-1');
    app.realtimeInstanceId = current;
    pending.resolve(response({ status: 'done', engine: 'onnx', source_kind: 'folder', server_instance_id: returned }));
    assert.equal(await restore, accepted);
    assert.equal(app.taggerTaskId, accepted ? 'task-1' : null);
    assert.equal(app.realtimeInstanceId, finalInstance);
    assert.equal(itemReads, accepted ? 1 : 0);
  }
});

test('a retry completed after leaving identifies the server and refreshes live monitor details', async () => {
  for (const runDir of ['', 'output/finished']) {
    const { app, pending, storage } = retryRecoveryHarness();
    let saved = 0, refreshes = 0;
    app.realtimeInstanceId = null;
    app._saveRealtimeInstanceId = () => { saved++; };
    app.refreshMonitorRealtimeDetail = () => { refreshes++; };
    const retry = app.retryFailedTagger();
    app.currentRoute = 'monitor-dashboard';
    app.currentOutputRunDir = runDir;
    pending.resolve(response({ task_id: 'retry-A', server_instance_id: 'server-a' }));
    await retry;
    assert.equal(storage.get('anima-tagger-task-id'), 'retry-A');
    assert.equal(app.realtimeInstanceId, 'server-a');
    assert.equal(saved, 1);
    assert.equal(refreshes, runDir ? 0 : 1);
  }
});

test('a retry does not identify or overwrite a newer recovery task', async () => {
  for (const route of ['tagger', 'monitor-dashboard']) {
    for (const replacement of [null, 'newer-task']) {
      const { app, pending, storage } = retryRecoveryHarness();
      app.realtimeInstanceId = null;
      app._saveRealtimeInstanceId = () => assert.fail('a superseded task must not identify the server');
      const retry = app.retryFailedTagger();
      app.currentRoute = route;
      if (replacement) storage.set('anima-tagger-task-id', replacement);
      else storage.delete('anima-tagger-task-id');
      pending.resolve(response({ task_id: 'retry-A', server_instance_id: 'server-a' }));
      await retry;
      assert.equal(storage.get('anima-tagger-task-id') || null, replacement);
      assert.equal(app.realtimeInstanceId, null);
      assert.equal(app.taggerTaskId, 'failed-A');
    }
  }
});

test('matching failure responses still clear missing tasks and report retry errors', async () => {
  const { app, pending, storage } = retryRecoveryHarness();
  const messages = [];
  app.realtimeInstanceId = null;
  app.toast = message => messages.push(message);
  const retry = app.retryFailedTagger();
  app.realtimeInstanceId = 'server-a';
  pending.resolve({ ok: true, json: async () => ({ status: 'fail', message: 'retry failed', data: { server_instance_id: 'server-a' } }) });
  await retry;
  assert.deepEqual(messages, ['retry failed']);
  assert.equal(storage.get('anima-tagger-task-id'), 'failed-A');

  const missing = deferred();
  const { window } = loadFrontend('tagger/index', {
    window: {}, fetch: () => missing.promise,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  const restored = composeMixins(window.taggerMixin, { currentRoute: 'tagger', realtimeInstanceId: null, taggerSourceMode: 'folder' });
  const request = restored.restoreTaggerTask('failed-A');
  restored.realtimeInstanceId = 'server-a';
  missing.resolve({ ok: true, json: async () => ({ status: 'fail', data: { server_instance_id: 'server-a' } }) });
  assert.equal(await request, false);
  assert.equal(storage.has('anima-tagger-task-id'), false);
});

test('restoring a completed task fetches its result page once', async () => {
  const requests = [], storage = new Map();
  const { window } = loadFrontend('tagger/index', {
    window: {}, clearTimeout, localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async url => {
      requests.push(url);
      return url.endsWith('/status')
        ? response({ status: 'done', engine: 'onnx', source_kind: 'folder', current: 200, items_version: 201 })
        : response({ total: 0, items: [] });
    },
  });
  const app = composeMixins(window.taggerMixin, {
    currentRoute: 'tagger', taggerSourceMode: 'folder', _taggerTasks: {}, _taggerModeStates: {},
    toast() {}, t: key => key,
  });
  assert.equal(await app.restoreTaggerTask('task-1'), true);
  assert.equal(requests.length, 2);
  assert.match(requests[1], /items\?offset=0/);
});

test('unchanged item versions do not reload results', () => {
  const { window } = loadFrontend('tagger/index', { window: {}, clearTimeout, setTimeout });
  const calls = [];
  const app = composeMixins(window.taggerMixin, {
    currentRoute: 'tagger', taggerSourceMode: 'folder', taggerTaskId: 'task-1', _taggerModeStates: {},
    _taggerTasks: { 'task-1': { status: 'running', engine: 'onnx', source_kind: 'folder', items_version: 1 } },
    refreshTaggerItems: reset => calls.push(reset), toast() {}, t: key => key,
  });
  app.applyTaggerTaskSnapshot({ status: 'running', engine: 'onnx', source_kind: 'folder', items_version: 1 }, '', 'task-1');
  assert.deepEqual(calls, []);
  app.applyTaggerTaskSnapshot({ status: 'running', engine: 'onnx', source_kind: 'folder', items_version: 2 }, '', 'task-1');
  assert.deepEqual(calls, [false]);
});

test('a failed item refresh remains retryable when the task version is unchanged', async () => {
  let calls = 0;
  const { window } = loadFrontend('tagger/index', {
    window: {}, setTimeout, clearTimeout,
    fetch: async () => ++calls === 1 ? { ok: false, json: async () => ({ status: 'error' }) }
      : response({ total: 0, items: [] }),
  });
  const app = composeMixins(window.taggerMixin, {
    currentRoute: 'tagger', taggerSourceMode: 'folder', taggerTaskId: 'task-1', _taggerModeStates: {},
    _taggerTasks: { 'task-1': { status: 'running', engine: 'onnx', source_kind: 'folder', items_version: 2 } },
  });
  await app.refreshTaggerItems(true);
  assert.equal(app._taggerItemsError.taskId, 'task-1');
  assert.equal(app._taggerItemsError.reset, true);
  app._taggerLastItemsFetch = 0;
  app.applyTaggerTaskSnapshot({ status: 'running', engine: 'onnx', source_kind: 'folder', items_version: 2 }, '', 'task-1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(app._taggerItemsError, null);
});

test('an immediate item retry cancels a scheduled refresh for the same task', async () => {
  let timer, reads = 0;
  const { window } = loadFrontend('tagger/index', {
    window: {}, setTimeout: callback => (timer = { callback }), clearTimeout: value => { if (value) value.cancelled = true; },
    fetch: async () => { reads++; return response({ total: 0, items: [] }); },
  });
  const app = composeMixins(window.taggerMixin, {
    currentRoute: 'tagger', taggerSourceMode: 'folder', taggerTaskId: 'task-1', _taggerModeStates: {},
    _taggerTasks: { 'task-1': { status: 'running', engine: 'onnx', source_kind: 'folder', items_version: 1 } },
    _taggerLastItemsFetch: Date.now(),
  });
  app.applyTaggerTaskSnapshot({ status: 'running', engine: 'onnx', source_kind: 'folder', items_version: 2 }, '', 'task-1');
  assert.ok(timer);
  await app.refreshTaggerItems(true);
  assert.equal(timer.cancelled, true);
  assert.equal(reads, 1);
});

test('an older replayed task event cannot replace a newer snapshot', () => {
  const { window } = loadFrontend('tagger/index', { window: {}, clearTimeout, setTimeout });
  const app = composeMixins(window.taggerMixin, {
    taggerSourceMode: 'folder', taggerTaskId: 'task-1', _taggerModeStates: {},
    _taggerTasks: { 'task-1': { status: 'running', engine: 'onnx', current: 8, items_version: 8, updated_at: 20 } },
    refreshTaggerItems() { assert.fail('stale data must not refresh results'); },
  });
  app.applyTaggerTaskSnapshot({ status: 'running', engine: 'onnx', current: 4, items_version: 4, updated_at: 10 }, '', 'task-1');
  assert.equal(app.taggerTask.current, 8);
  assert.equal(app.taggerTask.items_version, 8);
});

test('task revisions preserve progress and completion when the system clock moves backwards', () => {
  for (const engine of ['onnx', 'api']) {
    const { window } = loadFrontend('tagger/index', { window: {}, clearTimeout, setTimeout });
    const app = composeMixins(window.taggerMixin, {
      currentRoute: 'home', taggerSourceMode: engine === 'api' ? 'api-folder' : 'folder',
      taggerTaskId: 'task-1', _taggerModeStates: {}, _taggerRealtimeTopic: 'task:task-1',
      _taggerTasks: { 'task-1': { status: 'running', engine, items_version: 4, updated_at: 200, snapshot_revision: 4 } },
      _setTaggerRealtimeTask() { this._taggerRealtimeTopic = null; }, toast() {}, t: key => key,
    });
    app.applyTaggerTaskSnapshot({ status: 'cancelling', phase: 'cancelling', engine, items_version: 4, updated_at: 100, snapshot_revision: 5 }, '', 'task-1');
    assert.equal(app.taggerTask.phase, 'cancelling');
    app.applyTaggerTaskSnapshot({ status: 'cancelled', engine, items_version: 5, updated_at: 90, snapshot_revision: 6 }, '', 'task-1');
    app.applyTaggerTaskSnapshot({ status: 'running', engine, items_version: 4, updated_at: 200, snapshot_revision: 4 }, '', 'task-1');
    assert.equal(app.taggerTask.status, 'cancelled');
    assert.equal(app.taggerHasActiveTask(), false);
    assert.equal(app._taggerRealtimeTopic, null);
  }
});

test('retry completed after navigation is recovered on re-entry even when no active task remains', async () => {
  const {app,pending,storage,restored}=retryRecoveryHarness();
  const retry=app.retryFailedTagger();
  app.currentRoute='home'; app._taggerFormVersion++;
  pending.resolve(response({task_id:'retry-A'})); await retry;
  assert.equal(app.taggerTaskId,'failed-A');
  assert.equal(storage.get('anima-tagger-task-id'),'retry-A');
  app.currentRoute='tagger'; await app.buildTaggerForm();
  assert.deepEqual(restored,['retry-A']);
  assert.equal(app.taggerTaskId,'retry-A');
  assert.equal(app.taggerTask.status,'done');
  assert.equal(app.taggerTask.failed,0);
});
