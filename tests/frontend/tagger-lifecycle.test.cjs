const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, response, deferred} = require('./helpers.cjs');

function harness() {
  const pending = deferred(), scans = [], messages = [];
  const context = loadFrontend('tagger/index', {window:{}, fetch:()=>pending.promise});
  const app = composeMixins(context.window.taggerMixin, {
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
  const pending=deferred(), storage=new Map();
  const {window}=loadFrontend('tagger/index',{window:{},fetch:()=>pending.promise,
    localStorage:{setItem:(key,value)=>storage.set(key,value)}});
  const app=composeMixins(window.taggerMixin,{
    currentRoute:'tagger',taggerSourceMode:'folder',taggerSource:{source_token:'local'},
    taggerModels:[{id:'model',engine:'onnx'}],taggerSelectedModel:'model',
    taggerCanStart:()=>true,_clearTaggerResultState(){},saveTaggerSettings(){},
    realtimeSubscribe(){},realtimeUnsubscribe(){},toast:message=>assert.fail(message),
  });
  const start=app.startTagger();
  app.currentRoute='ai-captioning';app.taggerSourceMode='api-folder';
  app.taggerSource={source_token:'api-draft'};
  pending.resolve(response({task_id:'new-local-task'}));await start;
  assert.equal(app.taggerTaskId,null);
  assert.equal(app._taggerModeStates.folder.taskId,'new-local-task');
  assert.equal(app.taggerSource.source_token,'api-draft');
  assert.equal(app.taggerTaskById('new-local-task').engine,'onnx');
  assert.equal(storage.get('anima-tagger-task-id'),'new-local-task');
  assert.equal(storage.has('anima-ai-tagger-task-id'),false);
});
