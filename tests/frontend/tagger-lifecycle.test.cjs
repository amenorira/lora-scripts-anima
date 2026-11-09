const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, response, deferred, readRepo} = require('./helpers.cjs');

function harness() {
  const pending = deferred(), scans = [], messages = [];
  const context = loadFrontend(['shared/utils', 'tagger/index'], {window:{}, URLSearchParams, fetch:()=>pending.promise});
  const app = composeMixins(context.window.utilsMixin, context.window.taggerMixin, {
    currentRoute:'tagger', taggerSourceMode:'folder', taggerSourcePath:'original',
    scanTaggerSource:async()=>scans.push(app.taggerSourcePath),
    toast:message=>messages.push(message), t:key=>key,
  });
  return {app,pending,scans,messages};
}

for (const change of ['unchanged','route','mode','return','path','scan','starting']) {
  test(`file picker keeps its original workspace context after ${change}`, async()=>{
    const {app,pending,scans}=harness();
    const pick=app.pickTaggerSource();
    if(change==='route') app.currentRoute='ai-captioning';
    if(change==='mode') app.taggerSourceMode='single';
    if(change==='return') app._taggerFormVersion++;
    if(change==='path') app.taggerSourcePath='newer path';
    if(change==='scan') app._taggerSourceScanVersion=1;
    if(change==='starting') app.taggerStarting=true;
    const path=app.taggerSourcePath;
    pending.resolve(response({path:'picked folder'}));
    await pick;
    assert.equal(app.taggerSourcePath,change==='unchanged'?'picked folder':path);
    assert.deepEqual(scans,change==='unchanged'?['picked folder']:[]);
  });
}

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

test('scan failures localize UI fallback while keeping backend diagnostics intact', async () => {
  const dictionary = JSON.parse(readRepo('frontend/i18n/ja-JP.json'));
  const diagnostic = 'first cause / 原因一; second cause / 原因二: C:/images';
  for (const message of [undefined, diagnostic]) {
    const messages = [];
    const {window} = loadFrontend('tagger/index', {
      window: {}, fetch: async () => ({json: async () => ({status: 'fail', message})}),
    });
    const app = composeMixins(window.taggerMixin, {
      currentRoute: 'tagger', taggerSourceMode: 'folder', taggerSourcePath: './images',
      toast: text => messages.push(text),
      t: key => key.split('.').reduce((value, part) => value?.[part], dictionary),
    });
    await app.scanTaggerSource();
    assert.deepEqual(messages, [message ?? dictionary.tagger.scanFailed]);
  }
});

test('coded source errors are translated without exposing a bilingual backend message', async () => {
  const messages = [];
  const {window} = loadFrontend(['shared/utils', 'tagger/index'], {
    window: {}, fetch: async () => ({json: async () => ({
      status:'fail', message:'Source does not exist / 输入路径不存在',
      data:{errorCode:'tagger_source_not_found'},
    })}),
  });
  const app = composeMixins(window.utilsMixin, window.taggerMixin, {
    currentRoute:'tagger', taggerSourceMode:'folder', taggerSourcePath:'./missing',
    toast: text => messages.push(text),
    t: key => ({'errors.tagger_source_not_found':'指定されたパスが存在しません。'}[key] || key),
  });
  await app.scanTaggerSource();
  assert.deepEqual(messages, ['指定されたパスが存在しません。']);
});

for (const change of ['unchanged','source','path','task','mode','route','return','scan']) {
  test(`failed-task retry keeps busy and rejects stale ${change} context`, async () => {
    const pending=deferred(), attached=[], messages=[];
    let requests=0;
    const {window}=loadFrontend('tagger/index',{window:{},localStorage:{getItem:()=>null},fetch:()=>{requests++;return pending.promise;}});
    const app=composeMixins(window.taggerMixin,{
      currentRoute:'tagger',taggerSourceMode:'folder',taggerSourcePath:'A',
      taggerSource:{source_token:'A'},taggerTaskId:'failed-A',
      _taggerTasks:{'failed-A':{failed:1,status:'done'}},
      attachTaggerTask:(...args)=>attached.push(args),toast:message=>messages.push(message),t:key=>key,
    });
    const retry=app.retryFailedTagger();
    assert.equal(app.taggerStarting,true);
    await app.retryFailedTagger();
    await app.selectTaggerSourceMode('single');
    assert.equal(app.taggerSourceMode,'folder');
    assert.equal(requests,1);
    if(change==='source') app.taggerSource={source_token:'B'};
    if(change==='path') app.taggerSourcePath='B';
    if(change==='task') app.taggerTaskId='new-task';
    if(change==='mode') app.taggerSourceMode='single';
    if(change==='route') app.currentRoute='home';
    if(change==='return') app._taggerFormVersion++;
    if(change==='scan') app._taggerSourceScanVersion++;
    pending.resolve(response({task_id:'retry-A'})); await retry;
    assert.equal(app.taggerStarting,false);
    assert.deepEqual(attached,change==='unchanged'?[['retry-A','folder']]:[]);
    assert.deepEqual(messages,[]);
  });
}

test('failed retry releases the shared startup lock and reports its failure once', async () => {
  const messages=[];
  const {window}=loadFrontend('tagger/index',{window:{},fetch:async()=>({json:async()=>({status:'fail',message:'retry failed'})})});
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

for (const status of ['running','done']) {
  test(`pending initialization reads the latest retry identity before restoring ${status}`, async () => {
    const active=deferred(), task=deferred();
    const {app,pending,storage,requests}=retryRecoveryHarness({activePending:active,newStatusPending:task});
    const retry=app.retryFailedTagger();
    app.currentRoute='home'; app._taggerFormVersion++;
    app.currentRoute='tagger'; const mount=app.buildTaggerForm();
    await new Promise(resolve=>setImmediate(resolve));
    pending.resolve(response({task_id:'retry-A'}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(storage.get('anima-tagger-task-id'),'retry-A');
    active.resolve(response({task_id:null}));
    await new Promise(resolve=>setImmediate(resolve));
    task.resolve(response({engine:'onnx',status,failed:0,total:1,source_kind:'folder',source_token:'retry-source',source_root:'A'}));
    await Promise.all([retry,mount]);
    assert.equal(app.taggerTaskId,'retry-A');
    assert.equal(app.taggerTask.failed,0);
    assert.equal(app.taggerTask.status,status);
    assert.equal(storage.get('anima-tagger-task-id'),'retry-A');
    assert.equal(app._taggerRealtimeTopic,status==='running'?'task:retry-A':null);
    assert.equal(app.taggerStarting,false);
    assert.equal(requests.includes('/api/tagger/tasks/failed-A/status'),false);
  });
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

for (const change of ['source','task','server','route','mount','storage']) {
  test(`retry reconciliation ignores a status response after current ${change} changes`, async () => {
    const status=deferred();
    const {app,pending,storage}=retryRecoveryHarness({newStatusPending:status});
    const retry=app.retryFailedTagger();
    app.currentRoute='home'; app._taggerFormVersion++;
    app.currentRoute='tagger'; await app.buildTaggerForm();
    pending.resolve(response({task_id:'retry-A'}));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.taggerStarting,true);
    if(change==='source') {app.taggerSource={source_token:'B'};app.taggerSourcePath='B';}
    if(change==='task') app.taggerTaskId='new-task';
    if(change==='server') app.realtimeInstanceId='server-2';
    if(change==='route') app.currentRoute='home';
    if(change==='mount') app._taggerFormVersion++;
    if(change==='storage') storage.set('anima-tagger-task-id','new-task');
    status.resolve(response({engine:'onnx',status:'running',failed:0,total:1,source_kind:'folder',source_token:'retry-source',source_root:'A'}));
    await retry;
    assert.equal(app.taggerTaskId,change==='task'?'new-task':'failed-A');
    assert.equal(app._taggerRealtimeTopic,null);
    if(change==='source') assert.equal(app.taggerSource.source_token,'B');
    if(change==='storage') assert.equal(storage.get('anima-tagger-task-id'),'new-task');
    assert.equal(app.taggerStarting,false);
  });
}

test('initial old-task restore cannot undo a retry identity recovered by the current mount', async () => {
  const old=deferred();
  const {app,pending,storage}=retryRecoveryHarness({oldStatusPending:old});
  const retry=app.retryFailedTagger();
  app.currentRoute='home'; app._taggerFormVersion++;
  app.currentRoute='tagger'; const mount=app.buildTaggerForm();
  await new Promise(resolve=>setImmediate(resolve));
  pending.resolve(response({task_id:'retry-A'})); await retry;
  assert.equal(app.taggerTaskId,'retry-A');
  old.resolve(response({engine:'onnx',status:'done',failed:1,total:1,source_kind:'folder',source_token:'A',source_root:'A'}));
  await mount;
  assert.equal(app.taggerTaskId,'retry-A');
  assert.equal(app.taggerTask.failed,0);
  assert.equal(storage.get('anima-tagger-task-id'),'retry-A');
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

for (const change of ['source','new-task','server']) {
  test(`late retry cannot replace recovery ownership after ${change}`, async () => {
    const {app,pending,storage}=retryRecoveryHarness();
    const retry=app.retryFailedTagger();
    if(change==='source') {
      app.taggerSource={source_token:'B'}; app.taggerTaskId=null;
      storage.delete('anima-tagger-task-id');
    } else if(change==='new-task') {
      app.taggerTaskId='new-task'; storage.set('anima-tagger-task-id','new-task');
    } else app.realtimeInstanceId='server-2';
    pending.resolve(response({task_id:'retry-A'})); await retry;
    assert.equal(storage.get('anima-tagger-task-id'),change==='source'?undefined:change==='new-task'?'new-task':'failed-A');
    assert.equal(app.taggerTaskId,change==='source'?null:change==='new-task'?'new-task':'failed-A');
    if(change==='source') assert.equal(app.taggerSource.source_token,'B');
  });
}
