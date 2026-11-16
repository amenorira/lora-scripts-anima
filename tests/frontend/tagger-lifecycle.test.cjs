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
