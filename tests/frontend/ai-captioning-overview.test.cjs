const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, response, deferred, composeMixins } = require('./helpers.cjs');

function harness() {
  const storage = new Map();
  const context = loadFrontend(['tagger/index','tagger/ai-caption-options','tagger/caption-workspace'],{
    window:{},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    fetch:async()=>response({active:false,tagger_busy:false,phase:'idle',counts:{total:1000},plan:{}}),URLSearchParams,crypto:{randomUUID:()=> 'fixture'},
    URL:{createObjectURL:()=> 'blob:new',revokeObjectURL(){}},FormData:class {append(){}},
    setTimeout:()=>1,clearTimeout(){},document:{querySelector:()=>null,getElementById:()=>null,body:{classList:{remove(){}}}},
  });
  const app = composeMixins(context.window.taggerMixin,context.window.captionOptionsMixin,context.window.captionWorkspaceMixin);
  app.currentRoute='ai-captioning';app.taggerSourceMode='api-folder';app.t=k=>k;app.toast=()=>{};
  app.taggerApiSettings={...app.taggerApiSettings,baseUrl:'http://fixture/v1',model:'fixture'};
  app.captionOptions={...app.captionOptions,candidates:['original','long','medium','short']};
  app._taggerModeStates={folder:null,single:null,'api-folder':null,'api-single':null};
  app.syncTaggerDictionary=app.realtimeSubscribe=app.realtimeUnsubscribe=app._mountTaggerWorkspace=()=>{};
  app.tagDictionaryInit=app.loadTaggerModels=app.loadCaptionTemplate=app.renderTaggerResourceBar=()=>{};
  app.$nextTick=fn=>fn();
  return {app,context,storage};
}

for (const destination of ['tagger','monitor-dashboard','ai-captioning']) {
  test(`late workspace initialization preserves the current page after navigation to ${destination}`,async()=>{
    const {app,context,storage}=harness();const pending=deferred();let previewRequests=0,planRequests=0;
    app.taggerSource={source_token:'batch',kind:'folder',total:3,path:'dataset'};app.taggerSourcePath='dataset';
    app._taggerModeStates.folder={source:{source_token:'local',total:2},sourcePath:'local-dataset',taskId:'local-done',resultText:'Keep local result'};
    app._taggerTasks['local-done']={status:'done',engine:'onnx'};
    app.tagDictionaryCleanup=()=>{};
    context.fetch=async url=>{
      if(url.endsWith('/active')) return response({task_id:null});
      if(url.endsWith('/preview-state')) {
        if(++previewRequests===1) return pending.promise;
        return response({active:false,tagger_busy:false,phase:'idle'});
      }
      if(url.endsWith('/caption-plan')) {planRequests++;return response({counts:{total:3},plan:{requests:3}});}
      throw new Error(`Unexpected request: ${url}`);
    };
    const initial=app.buildTaggerForm();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(previewRequests,1);
    if(destination==='monitor-dashboard') {
      app.currentRoute=destination;app.stopTaggerWorkspace();
    } else {
      app.currentRoute='tagger';await app.buildTaggerForm();
      if(destination==='ai-captioning') {app.currentRoute=destination;await app.buildTaggerForm();}
    }
    await new Promise(resolve=>setImmediate(resolve));
    app.captionOverviewDetail={index:0,name:'Keep current detail'};
    const before={mode:app.taggerSourceMode,source:app.taggerSource,task:app.taggerTaskId,result:app.taggerResultText,
      detail:app.captionOverviewDetail,plans:planRequests,storage:[...storage]};
    pending.resolve(response({active:false,tagger_busy:true,phase:'idle'}));await initial;
    assert.equal(app.currentRoute,destination);assert.equal(app.taggerSourceMode,before.mode);
    assert.equal(app.taggerSource,before.source);assert.equal(app.taggerTaskId,before.task);
    assert.equal(app.taggerResultText,before.result);assert.equal(app.captionOverviewDetail,before.detail);
    assert.equal(app.captionExternalTaggerBusy,false);assert.equal(planRequests,before.plans);
    assert.deepEqual([...storage],before.storage);
  });
}

for (const destination of ['tagger','monitor-dashboard','return','source','settings']) {
  test(`preview preflight cannot submit after its original context changes: ${destination}`,async()=>{
    const {app,context,storage}=harness(),pending=deferred();let checks=0,submits=0;
    app.captionTab='single';app.taggerSourceMode='api-single';app.taggerSource={source_token:'original',kind:'upload',total:1};
    storage.set('anima-ai-tab','single');app.tagDictionaryCleanup=()=>{};
    context.fetch=async url=>{
      if(url.endsWith('/preview-state')) {if(++checks===1)return pending.promise;return response({active:false,tagger_busy:false});}
      if(url.endsWith('/preview')){submits++;return response({candidates:{short:'Wrong result'}});}
      if(url.endsWith('/active'))return response({task_id:null});
      throw new Error(url);
    };
    const request=app.startCaptionPreview();
    if(destination==='tagger'||destination==='return') {
      app.currentRoute='tagger';await app.buildTaggerForm();
      if(destination==='return'){app.currentRoute='ai-captioning';await app.buildTaggerForm();}
    } else if(destination==='monitor-dashboard') {app.currentRoute=destination;app.stopTaggerWorkspace();}
    else if(destination==='source') app.setTaggerSource({source_token:'new-image',kind:'upload',total:1});
    else app.taggerApiSettings.model='different-model';
    const result=app.captionSingleResult={candidates:{short:'Keep existing result'}};
    pending.resolve(response({active:false,tagger_busy:false}));await request;
    assert.equal(submits,0);assert.equal(app.captionSingleResult,result);assert.equal(app.captionPreviewStatus,'idle');
  });
}

test('three workspaces keep sources, batch task and preview results separate',async()=>{
  const {app,storage}=harness();
  app.taggerSource={source_token:'batch',kind:'folder',total:1000,path:'dataset'};app.taggerSourcePath='dataset';
  app.attachTaggerTask('batch-task');
  app.applyTaggerTaskSnapshot({status:'running',engine:'api',source_root:'dataset',source_token:'batch'});
  await app.selectCaptionTab('single');
  assert.equal(app.taggerSourceMode,'api-single');assert.equal(app.taggerSource,null);assert.equal(app.taggerRunning,false);
  assert.equal(app.captionBatchRunning(),true);assert.equal(app.captionPreviewCanStart(),false);
  assert.equal(storage.get('anima-ai-tagger-task-id'),'batch-task');
  app.taggerSource={source_token:'single',kind:'upload',total:1};app.captionSingleResult={candidates:{short:'Single'}};
  app.applyTaggerTaskSnapshot({status:'done',engine:'api',source_token:'batch',source_root:'dataset'},'FINISHED','batch-task');
  assert.equal(app.taggerSource.source_token,'single');assert.equal(app.captionBatchRunning(),false);
  app.refreshCaptionOverview=async()=>{};
  await app.selectCaptionTab('overview');assert.equal(app.taggerSource.source_token,'batch');assert.equal(app.taggerTask.status,'done');
  await app.selectCaptionTab('single');assert.equal(app.taggerSource.source_token,'single');assert.equal(app.captionSingleResult.candidates.short,'Single');
});

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
  app.openConfirm=(title,message,callback)=>{confirmation=callback;};context.fetch=async()=>{submits++;return response({task_id:'new'});};
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

test('cancel arriving before the preview POST is retried until acknowledged',async()=>{
  const {app,context}=harness();app.captionPreviewStatus='preparing';app.captionPreviewRequestId='early';
  context.setTimeout=fn=>{queueMicrotask(fn);return 1;};
  let calls=0;context.fetch=async()=>response({cancelling:++calls > 1});
  await app.cancelCaptionPreview();
  assert.equal(calls,2);assert.equal(app.captionPreviewStatus,'cancelling');
});

test('write-plan failure leaves the read-only gallery available and details retain its settings',async()=>{
  const {app,context}=harness();app.taggerSource={source_token:'batch',total:2};let detailUrl;
  context.fetch=async(url)=>{
    if(url.endsWith('/caption-plan')) return {json:async()=>({status:'fail',message:'conflicting output'})};
    if(url.includes('/annotations?')) return response({counts:{total:2},items:[{index:0,name:'a.png',path:'a.png'}],total:2,offset:0,
      settings:{caption_extension:'.caption',reference_extension:'.tags',sidecar_suffix:'_caption.json',separator:'==='}});
    detailUrl=url;return response({text:'Saved caption'});
  };
  assert.equal(await app.refreshCaptionPlan(),null);
  assert.equal(app.captionPlanError,'conflicting output');
  await app.refreshCaptionOverview();assert.equal(app.captionOverviewItems.length,1);assert.equal(app.captionOverviewError,'');
  app.captionOptions.caption_extension='.other';await app.openCaptionDetail(app.captionOverviewItems[0],null);
  assert.match(detailUrl,/caption_extension=\.caption/);assert.match(detailUrl,/separator=%3D%3D%3D/);
});
