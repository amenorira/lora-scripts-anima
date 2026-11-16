const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, response, deferred, composeMixins } = require('./helpers.cjs');

function harness() {
  const storage = new Map();
  const context = loadFrontend(['shared/utils','tagger/index','tagger/ai-caption-options','tagger/caption-workspace'],{
    window:{},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    fetch:async()=>response({active:false,tagger_busy:false,phase:'idle',counts:{total:1000},plan:{}}),URLSearchParams,crypto:{randomUUID:()=> 'fixture'},
    URL:{createObjectURL:()=> 'blob:new',revokeObjectURL(){}},FormData:class {append(){}},
    setTimeout:()=>1,clearTimeout(){},document:{querySelector:()=>null,getElementById:()=>null,body:{classList:{remove(){}}}},
  });
  const app = composeMixins(context.window.utilsMixin,context.window.taggerMixin,context.window.captionOptionsMixin,context.window.captionWorkspaceMixin);
  app.currentRoute='ai-captioning';app.taggerSourceMode='api-folder';app.t=k=>k;app.toast=()=>{};
  app.taggerApiSettings={...app.taggerApiSettings,baseUrl:'http://fixture/v1',model:'fixture'};
  app.captionOptions={...app.captionOptions,output_format:'multi',candidates:['original','long','medium','short']};
  app._taggerModeStates={folder:null,single:null,'api-folder':null,'api-single':null};
  app.syncTaggerDictionary=app.realtimeSubscribe=app.realtimeUnsubscribe=app._mountTaggerWorkspace=()=>{};
  app.tagDictionaryInit=app.loadTaggerModels=app.loadCaptionTemplate=app.renderTaggerResourceBar=()=>{};
  app.$nextTick=fn=>fn();
  return {app,context,storage};
}

test('late overview/detail responses cannot overwrite a changed source or closed detail',async()=>{
  const {app,context}=harness();app.taggerSource={source_token:'a',total:1};const pending=deferred();context.fetch=()=>pending.promise;
  const load=app.refreshCaptionOverview();app.taggerSource={source_token:'b',total:1};pending.resolve(response({items:[{name:'wrong'}],counts:{outputs:1,missing_outputs:0}}));await load;
  assert.equal(app.captionOverviewItems.length,0);
  const detail=deferred();context.fetch=()=>detail.promise;const open=app.openCaptionDetail({index:0,name:'old'},null);app.closeCaptionDetail();detail.resolve(response({text:'late'}));await open;
  assert.equal(app.captionOverviewDetail,null);
});

test('preflight counts are refreshed before overwrite confirmation and a changed plan reconfirms',async()=>{
  const {app,context}=harness();app.taggerSource={source_token:'batch',total:10};app.captionOptions.overwrite=true;
  let submits=0,confirmation;app.refreshCaptionPlan=async()=>({plan:{overwrite_captions:4,overwrite_json:3,overwrite_references:2}});
  app.openConfirm=({onConfirm})=>{confirmation=onConfirm;};context.fetch=async()=>{submits++;return response({task_id:'new'});};
  await app.startApiTagger();assert.equal(submits,0);assert.equal(typeof confirmation,'function');
  await confirmation();assert.equal(submits,1);assert.equal(app.taggerTaskId,'new');
});

test('a changed source or request configuration invalidates an in-flight start plan',async()=>{
  for (const change of [
    app=>{app.taggerSource={source_token:'batch-b',total:3};},
    app=>{app.captionOptions.overwrite=true;},
    app=>{app.captionOptions.candidates.reverse();},
    app=>{app.taggerApiSettings.model='different-model';},
  ]) {
    const {app,context}=harness();const plan=deferred();let submits=0;
    app.taggerSource={source_token:'batch-a',total:3};
    context.fetch=async url=>{
      if(url.endsWith('/caption-plan')) return plan.promise;
      submits++;return response({task_id:'wrong'});
    };
    const start=app.startApiTagger();change(app);
    plan.resolve(response({counts:{total:3},plan:{requests:3,writes:3}}));await start;
    assert.equal(submits,0);assert.equal(app.taggerStarting,false);
  }
});

test('a submitted batch task stays in its original workspace when the response arrives after navigation',async()=>{
  const {app,context,storage}=harness();const created=deferred();let submitted;
  app.taggerSource={source_token:'batch-a',total:3};app.taggerSourcePath='dataset-a';
  app._taggerModeStates.folder={source:{source_token:'local-b',total:2},sourcePath:'dataset-b',taskId:'local-done'};
  app._taggerTasks['local-done']={status:'done',engine:'onnx'};
  context.fetch=async (url,init)=>{
    if(url.endsWith('/caption-plan')) return response({counts:{total:3},plan:{requests:3,writes:3}});
    if(url.endsWith('/active')) return response({task_id:null});
    submitted=JSON.parse(init.body);return created.promise;
  };
  const start=app.startApiTagger();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(submitted.source_token,'batch-a');
  app.currentRoute='tagger';await app.buildTaggerForm();
  created.resolve(response({task_id:'batch-new'}));await start;
  assert.equal(app.taggerSource.source_token,'local-b');assert.equal(app.taggerTaskId,'local-done');
  assert.equal(app.captionBatchState().taskId,'batch-new');assert.equal(app.captionBatchRunning(),true);
  assert.equal(app.taggerTaskById('batch-new').engine,'api');
  assert.equal(storage.get('anima-ai-tagger-task-id'),'batch-new');
  assert.equal(storage.get('anima-tagger-task-id'),undefined);
});

test('preview uses synchronous API and cancellation keeps UI locked until server settles',async()=>{
  const {app,context}=harness();app.taggerSourceMode='api-single';app.captionTab='single';app.taggerSource={source_token:'upload',total:1};
  const pending=deferred(),settled=deferred();let sent;
  context.fetch=async(url,init)=>{
    if(url.endsWith('preview-state')) return response({active:false,tagger_busy:false});
    if(url.endsWith('preview-cancel')) return response({cancelling:true});
    if(url.endsWith('/preview')){sent=JSON.parse(init.body);return pending.promise;}
    throw new Error(url);
  };
  app.waitCaptionPreviewSettled=()=>settled.promise;
  const run=app.startCaptionPreview();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.source_token,'upload');assert.equal(app.captionPreviewBusy,true);assert.equal(app.taggerTaskId,null);
  await app.cancelCaptionPreview();assert.equal(app.captionPreviewStatus,'cancelling');
  await app.selectCaptionTab('batch');assert.equal(app.captionTab,'single');
  pending.resolve(response({candidates:{short:'discard'}}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.captionSingleResult,null);assert.equal(app.captionPreviewBusy,true);
  app.captionPreviewStatus='idle';settled.resolve();await run;
});

test('server restart clears active task references in every workspace',async()=>{
  const {app,storage}=harness();app.taggerSource={source_token:'old-server',total:3};app.attachTaggerTask('lost-task');
  await app.selectCaptionTab('single');app.taggerSource={source_token:'old-upload',total:1};
  assert.equal(app.resetRealtimeTaggerState(),true);
  assert.equal(app.captionBatchRunning(),false);assert.equal(app.captionBatchState().taskId,null);
  assert.equal(app.taggerSource,null);assert.equal(app._taggerRealtimeTopic,null);
  assert.equal(storage.get('anima-ai-tagger-task-id'),undefined);
  await app.selectCaptionTab('batch');assert.equal(app.taggerRunning,false);
});
