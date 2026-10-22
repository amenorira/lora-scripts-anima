const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend,response,deferred,readRepo,composeMixins} = require('./helpers.cjs');

function harness() {
  const storage = new Map();
  const context = loadFrontend(['tagger','ai-caption-options','caption-workspace'],{
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

test('navigation during initial template loading shares one mount and initializes once',async()=>{
  const {app,context}=harness(),template=deferred();let baseRequests=0,captionRequests=0,initialized=0;
  const host={dataset:{},textContent:'',hasMount:false,
    set innerHTML(value){this.hasMount=true;},
    querySelector(){return this.hasMount?{set outerHTML(value){host.hasMount=false;}}:null;}};
  context.document.getElementById=id=>id==='taggerWorkspaceHost'?host:null;
  context.window.Alpine=context.Alpine={initTree(){initialized++;}};
  app._mountTaggerWorkspace=context.window.taggerMixin._mountTaggerWorkspace;
  context.fetch=async url=>{
    if(url.includes('/tagger-workspace.html')) {baseRequests++;return {ok:true,text:async()=>'<div id="captionWorkspaceMount"></div>'};}
    if(url.includes('/caption-workspace.html')) {captionRequests++;return template.promise;}
    if(url.endsWith('/active')) return response({task_id:null});
    throw new Error(url);
  };
  const initial=app.buildTaggerForm();await new Promise(resolve=>setImmediate(resolve));
  app.currentRoute='tagger';const current=app.buildTaggerForm();await new Promise(resolve=>setImmediate(resolve));
  template.resolve({ok:true,text:async()=>'<div>Caption workspace</div>'});await Promise.all([initial,current]);
  assert.equal(baseRequests,1);assert.equal(captionRequests,1);assert.equal(initialized,1);
  assert.equal(host.textContent,'');assert.equal(host.dataset.mounted,'1');assert.equal(app.taggerSourceMode,'folder');
});

test('a failed shared mount can be retried on the next visit',async()=>{
  const {app,context}=harness();let attempt=0,initialized=0;
  const host={dataset:{},textContent:'',set innerHTML(value){this.textContent='';},querySelector:()=>({outerHTML:''})};
  context.document.getElementById=()=>host;context.window.Alpine=context.Alpine={initTree(){initialized++;}};
  app._mountTaggerWorkspace=context.window.taggerMixin._mountTaggerWorkspace;
  context.fetch=async url=>url.includes('/caption-workspace.html')
    ? {ok:++attempt>1,text:async()=>'<div>Caption workspace</div>'}
    : {ok:true,text:async()=>'<div id="captionWorkspaceMount"></div>'};
  await app._mountTaggerWorkspace();assert.match(host.textContent,/unavailable/);
  await app._mountTaggerWorkspace();assert.equal(host.dataset.mounted,'1');assert.equal(initialized,1);assert.equal(host.textContent,'');
});

for (const destination of ['tagger','single','return','source','superseded','unchanged']) {
  test(`overview rescan recovery respects navigation and request ownership: ${destination}`,async()=>{
    const {app,context,storage}=harness(),pending=deferred();let scans=0,annotations=0;
    app.captionTab='overview';app.taggerSource={source_token:'batch',kind:'folder',total:3,path:'dataset'};app.taggerSourcePath='dataset';
    storage.set('anima-ai-tab','overview');
    app._taggerModeStates.folder={source:{source_token:'local',total:2},sourcePath:'local-data',resultText:'Keep local result'};
    context.fetch=async url=>{
      if(url.includes('/annotations?')) {
        if(++annotations===1)return pending.promise;
        return response({counts:{total:3},items:[],total:3,offset:0});
      }
      if(url.endsWith('/source/scan')){scans++;return response({source_token:'rescanned',kind:'folder',total:3,path:'dataset'});}
      if(url.endsWith('/caption-plan'))return response({counts:{total:3},plan:{}});
      if(url.endsWith('/active'))return response({task_id:null});
      return response({active:false,tagger_busy:false});
    };
    const request=app.rescanCaptionOverview();
    if(destination==='tagger'||destination==='return') {
      app.currentRoute='tagger';await app.buildTaggerForm();
      if(destination==='return'){app.currentRoute='ai-captioning';await app.buildTaggerForm();}
    } else if(destination==='single') await app.selectCaptionTab('single');
    else if(destination==='source') app.setTaggerSource({source_token:'new-source',kind:'folder',path:'new-dataset',total:3});
    else if(destination==='superseded') await app.refreshCaptionOverview();
    await new Promise(resolve=>setImmediate(resolve));
    const before={mode:app.taggerSourceMode,source:app.taggerSource,result:app.taggerResultText};
    pending.resolve({json:async()=>({status:'fail',message:'Source expired'})});await request;
    if(destination==='unchanged') {assert.equal(scans,1);assert.equal(app.taggerSource.source_token,'rescanned');}
    else {assert.equal(scans,0);assert.equal(app.taggerSourceMode,before.mode);assert.equal(app.taggerSource,before.source);assert.equal(app.taggerResultText,before.result);}
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

test('preview still submits once and displays its result when the context remains current',async()=>{
  const {app,context}=harness();let submits=0;
  app.captionTab='single';app.taggerSourceMode='api-single';app.taggerSource={source_token:'image',total:1};
  context.fetch=async (url,init)=>{
    if(url.endsWith('/preview-state'))return response({active:false,tagger_busy:false});
    assert.ok(url.endsWith('/preview'));assert.equal(JSON.parse(init.body).source_token,'image');
    submits++;return response({candidates:{short:'Expected result'}});
  };
  await app.startCaptionPreview();
  assert.equal(submits,1);assert.equal(app.captionSingleResult.candidates.short,'Expected result');
  assert.equal(app.captionPreviewStatus,'idle');assert.equal(app.captionPreviewError,'');
});

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

test('retry task source subset cannot replace original batch overview source',()=>{
  const {app}=harness();app.taggerSource={source_token:'full',kind:'folder',path:'dataset',total:1000};
  app.refreshTaggerItems=async()=>{};app.captionTaskUpdated=()=>{};
  app.applyTaggerTaskSnapshot({engine:'api',status:'running',source_token:'subset',overview_source_token:'full',source_root:'dataset',total:2},'RUNNING','retry');
  assert.equal(app.taggerSource.source_token,'full');assert.equal(app.taggerSource.total,1000);
});

test('overview query always uses batch source and task, with server paging and output settings',async()=>{
  const {app,context}=harness();app.taggerSourceMode='api-single';app.taggerSource={source_token:'upload',total:1};
  app._taggerModeStates['api-folder']={source:{source_token:'batch',path:'dataset'},taskId:'retry-task'};
  app.captionOverviewOffset=60;app.captionOverviewQuery='角色';app.captionOverviewFilter='failed';let url;
  context.fetch=async input=>{url=input;return response({items:[{path:'dataset/second.png',index:9,task:{status:'failed'}}],total:1,offset:0,counts:{total:1000,outputs:50,missing_outputs:950}});};
  await app.refreshCaptionOverview();
  assert.match(url,/source\/batch\/annotations/);assert.match(url,/offset=60/);assert.match(url,/limit=60/);assert.match(url,/task_id=retry-task/);assert.match(url,/status=failed/);
  assert.equal(app.captionOverviewItems[0].path,'dataset/second.png');assert.equal(app.taggerSource.source_token,'upload');assert.equal(app.captionBatchState().source.total,1000);
});

test('late overview/detail responses cannot overwrite a changed source or closed detail',async()=>{
  const {app,context}=harness();app.taggerSource={source_token:'a',total:1};const pending=deferred();context.fetch=()=>pending.promise;
  const load=app.refreshCaptionOverview();app.taggerSource={source_token:'b',total:1};pending.resolve(response({items:[{name:'wrong'}],counts:{outputs:1,missing_outputs:0}}));await load;
  assert.equal(app.captionOverviewItems.length,0);
  const detail=deferred();context.fetch=()=>detail.promise;const open=app.openCaptionDetail({index:0,name:'old'},null);app.closeCaptionDetail();detail.resolve(response({text:'late'}));await open;
  assert.equal(app.captionOverviewDetail,null);
});

test('filter/search/page transitions retain server limit and clear stale details',()=>{
  const {app}=harness();let calls=0;app.refreshCaptionOverview=async()=>{calls++;};
  app.captionOverviewOffset=120;app.captionOverviewDetail={path:'old'};app.setCaptionOverviewFilter('missing');
  assert.equal(app.captionOverviewOffset,0);assert.equal(app.captionOverviewDetail,null);
  app.captionOverviewPage(1);assert.equal(app.captionOverviewOffset,60);app.captionOverviewSearch();assert.equal(app.captionOverviewOffset,0);assert.equal(calls,3);
});

test('clearing an empty search resets both filters in one request',()=>{
  const {app}=harness();let calls=0;
  app.captionOverviewQuery='no match';app.captionOverviewFilter='missing';app.captionOverviewOffset=60;
  app.captionOverviewDetail={path:'old'};app.refreshCaptionOverview=async()=>{calls++;};
  app.resetCaptionOverviewFilters();
  assert.equal(app.captionOverviewQuery,'');assert.equal(app.captionOverviewFilter,'all');
  assert.equal(app.captionOverviewOffset,0);assert.equal(app.captionOverviewDetail,null);assert.equal(calls,1);
});

test('sequential detail review follows the visible filtered order and keeps focus on navigation',async()=>{
  const {app,context}=harness();let focusMoves=0;
  app.taggerSource={source_token:'batch',kind:'folder',total:100};
  app.captionOverviewItems=[{path:'dataset/b.png',name:'b.png',index:9},{path:'dataset/a.png',name:'a.png',index:2}];
  app.captionOverviewOffset=60;app.captionOverviewTotal=62;app.captionOverviewFilter='missing';
  context.document.querySelector=()=>({focus(){focusMoves++;}});
  context.fetch=async url=>response({...app.captionOverviewItems.find(item=>url.includes(`/annotations/${item.index}?`)),text:'Caption'});
  const origin={focus(){}};await app.openCaptionDetail(app.captionOverviewItems[0],origin);
  assert.equal(app.captionDetailPosition(),'61 / 62');assert.equal(app.captionCanNavigateDetail(-1),true);
  await app.navigateCaptionDetail(1);
  assert.equal(app.captionOverviewDetail.index,2);assert.equal(app.captionDetailPosition(),'62 / 62');
  assert.equal(app.captionOverviewFilter,'missing');assert.equal(app._captionDetailFocus,origin);
  assert.equal(focusMoves,0);assert.equal(app.captionCanNavigateDetail(1),false);
  app.captionDetailLoading=true;assert.equal(app.captionCanNavigateDetail(-1),false);
});

test('sequential review crosses server pages without clearing the active filter',async()=>{
  const {app,context}=harness();
  app.taggerSource={source_token:'batch',kind:'folder',total:61};
  app.captionOverviewItems=Array.from({length:60},(_,index)=>({index,path:`${index}.png`,name:`${index}.png`}));
  app.captionOverviewDetail=app.captionOverviewItems[59];app.captionOverviewTotal=61;app.captionOverviewFilter='missing';
  context.fetch=async url=>url.includes('/annotations?')
    ? response({items:[{index:90,path:'last.png',name:'last.png'}],offset:60,total:61,counts:{total:100}})
    : response({index:90,path:'last.png',name:'last.png',text:'Last caption'});
  await app.navigateCaptionDetail(1);
  assert.equal(app.captionOverviewDetail.path,'last.png');assert.equal(app.captionOverviewOffset,60);
  assert.equal(app.captionDetailPosition(),'61 / 61');assert.equal(app.captionCanNavigateDetail(1),false);
  assert.equal(app.captionOverviewFilter,'missing');
});

test('API error messages expose service text while retaining status and non-JSON diagnostics',()=>{
  const {app}=harness();app.t=key=>key==='caption.serviceError'?'Service {status}: {message}':key;
  assert.equal(app.captionErrorMessage(new Error('HTTP 400: {"error":{"message":"Unknown model"}}')),'Service 400: Unknown model');
  assert.equal(app.captionErrorMessage(new Error('HTTP 502: upstream unavailable')),'HTTP 502: upstream unavailable');
  assert.equal(app.captionErrorMessage(new Error('HTTP 500: {truncated')),'HTTP 500: {truncated');
  app.locale='zh-CN';
  assert.equal(app.captionErrorMessage(new Error('Source does not exist / 输入路径不存在')),'输入路径不存在');
});

test('quiet directory scans expose a persistent field error and distinguish empty folders',async()=>{
  const {app,context}=harness();app.taggerSourcePath='dataset';app.refreshCaptionPlan=async()=>{};
  let toasts=0;app.toast=()=>{toasts++;};
  context.fetch=async()=>({json:async()=>({status:'fail',message:'Directory not found'})});
  await app.scanTaggerSource({quiet:true});
  assert.equal(app.captionSourceError,'Directory not found');assert.equal(toasts,0);
  assert.equal(app.taggerApiCanStart(),false);
  context.fetch=async()=>response({kind:'folder',path:'dataset',source_token:'empty',total:0,items:[]});
  await app.scanTaggerSource({quiet:true});
  assert.equal(app.captionSourceError,'');assert.equal(app.captionStartHint(),'caption.noImages');
});

test('directory errors from a previous route cannot appear in the current workspace',async()=>{
  const {app,context}=harness(),pending=deferred();app.taggerSourcePath='old';context.fetch=()=>pending.promise;
  const scanning=app.scanTaggerSource({quiet:true});app.currentRoute='tagger';
  pending.resolve({json:async()=>({status:'fail',message:'Old failure'})});await scanning;
  assert.equal(app.captionSourceError,'');
});

test('closed or superseded detail loads cannot move keyboard focus',async()=>{
  const {app,context}=harness(),pending=deferred();let focusMoves=0;
  app.taggerSource={source_token:'batch'};
  context.document.querySelector=()=>({focus(){focusMoves++;}});context.fetch=()=>pending.promise;
  const opening=app.openCaptionDetail({path:'a.png',index:0},null);app.closeCaptionDetail();
  pending.resolve(response({path:'a.png',text:'Late result'}));await opening;
  assert.equal(app.captionOverviewDetail,null);assert.equal(focusMoves,0);
});

test('same-tab initialization preserves a review opened immediately after returning from the editor',async()=>{
  const {app}=harness();app.captionTab='overview';
  const detail={path:'dataset/a.png',index:0};app.captionOverviewDetail=detail;
  app.refreshCaptionOverview=async()=>{};
  await app.selectCaptionTab('overview',false);
  assert.equal(app.captionOverviewDetail,detail);
  await app.selectCaptionTab('overview');
  assert.equal(app.captionOverviewDetail,null);
});

test('editor entry only opens the file format supported by the existing editor',()=>{
  const {app}=harness();let route;app.navigate=value=>{route=value;};app.taggerSource={source_token:'batch',kind:'folder',path:'dataset'};
  assert.equal(app.captionEditorAvailable(),true);
  app.openCaptionEditor();assert.equal(route,'tagEditor');assert.equal(app.tagEditorDir,'dataset');assert.equal(app.tagEditorDetailView,'text');
  route='';app.tagEditorDetailView='chip';
  app.captionOptions.caption_extension='.caption';assert.equal(app.captionEditorAvailable(),false);
  app.openCaptionEditor();assert.equal(route,'');assert.equal(app.tagEditorDetailView,'chip');
  app.captionOverviewSettings={caption_extension:' TXT '};assert.equal(app.captionEditorAvailable(),true);
  app.taggerSource=null;assert.equal(app.captionEditorAvailable(),false);
});

test('candidate switches retain canonical order after disabling and enabling',()=>{
  const {app}=harness();app.toggleCaptionCandidate('long',false);assert.deepEqual([...app.captionOptions.candidates],['original','medium','short']);
  app.toggleCaptionCandidate('long',true);assert.deepEqual([...app.captionOptions.candidates],['original','long','medium','short']);
  assert.ok(app.captionCandidateRows().includes('original'));
  assert.deepEqual([...app.captionCandidateRows(true)],['long','medium','short']);
});

test('library badges prioritize actionable problems without repeating normal caption types',()=>{
  const {app}=harness();
  assert.equal(app.captionItemStatus({caption_kind:'moss',task:{status:'success'}}),'');
  assert.equal(app.captionItemStatus({caption_kind:'ordinary'}),'');
  assert.equal(app.captionItemStatus({caption_kind:'missing'}),'caption.kind_missing');
  assert.equal(app.captionItemTone({caption_kind:'missing'}),'warning');
  assert.equal(app.captionItemStatus({caption_kind:'moss',sidecar_error:'Broken JSON',task:{status:'running'}}),'caption.invalidRecord');
  assert.equal(app.captionItemTone({sidecar_error:'Broken JSON'}),'danger');
  assert.equal(app.captionItemStatus({read_error:'Unreadable',sidecar_error:'Broken JSON'}),'caption.kind_unreadable');
  assert.equal(app.captionItemStatus({task:{status:'failed'}}),'caption.state_failed');
});

test('review filmstrip follows filtered order and stays bounded at both ends',()=>{
  const {app}=harness();app.captionOverviewItems=Array.from({length:20},(_,index)=>({path:`${index}.png`,index}));
  for (const [index,first,last] of [[0,0,6],[10,7,13],[19,13,19]]) {
    app.captionOverviewDetail=app.captionOverviewItems[index];
    const neighbors=app.captionDetailNeighbors();
    assert.equal(neighbors.length,7);assert.equal(neighbors[0].index,first);assert.equal(neighbors.at(-1).index,last);
  }
  app.captionOverviewItems=app.captionOverviewItems.slice(0,2);app.captionOverviewDetail=app.captionOverviewItems[0];
  assert.equal(app.captionDetailNeighbors().length,2);
});

test('single-image editor entry resets stale filters and targets the current image',()=>{
  const {app}=harness();app.taggerSource={kind:'folder',path:'dataset'};
  app.captionOverviewDetail={path:'dataset/sub/a.png',name:'a.png',relative:'sub/a.png'};
  app.tagEditorSearchQuery='old';app.tagEditorUseRegex=true;app.tagEditorQuickFilter='modified';
  app.tagEditorTagSearch='old';app.tagEditorTagSelection=['old'];app.tagEditorExcludedTags=['old'];app.navigate=()=>{};
  app.openCaptionEditor(app.captionOverviewDetail);
  assert.equal(app.tagEditorSearchQuery,'^sub/a\\.png$');assert.equal(app.tagEditorUseRegex,true);
  assert.equal(app.tagEditorOpenPath,'dataset/sub/a.png');
  assert.equal(app.tagEditorQuickFilter,'all');assert.equal(app.tagEditorTagSearch,'');
  assert.deepEqual([...app.tagEditorTagSelection],[]);assert.deepEqual([...app.tagEditorExcludedTags],[]);
  assert.equal(app.captionOverviewDetail,null);assert.equal(app.tagEditorDir,'dataset');
});

for (const separator of ['/','\\']) {
  test(`editor jump selects a same-named image beyond page one with ${JSON.stringify(separator)} paths`,async()=>{
    const {app,context}=harness();
    loadFrontend('tag-editor',context);
    Object.defineProperties(app,Object.getOwnPropertyDescriptors(context.window.tagEditorMixin));
    context.AbortController=AbortController;
    const root='C:/dataset';
    const images=Array.from({length:61},(_,index)=>({
      name:'image[1].png',rel_path:`${String(index).padStart(2,'0')}/image[1].png`,
      path:`${root}/${String(index).padStart(2,'0')}/image[1].png`.replaceAll('/',separator),tags:'',
    }));
    const target=images[60];
    images.push({...target,path:'other',rel_path:'copy/' + target.rel_path});
    const detail={index:60,name:target.name,path:target.path,relative:target.rel_path.replaceAll('/',separator)};
    app.taggerSource={source_token:'batch',kind:'folder',path:root.replaceAll('/',separator)};
    app.navigate=route=>{app.currentRoute=route;};
    let selectedPanel=0,focused=0,pageRequests=0;
    for (const name of ['tagDictionaryEnsureWorker','tagEditorCancelQuickRemove','_teStopAutoSave',
      '_teDiscardPendingTextEdits','startProgress','finishProgress','_tdRequestChips',
      'tagEditorLoadSnapshots','_teCheckDraft','_teStartAutoSave']) app[name]=()=>{};
    app._updateEditorPanel=()=>{selectedPanel++;};
    app._teFocusEditorInput=()=>{focused++;};
    app.toast=message=>assert.fail(message);
    context.fetch=async(url,options)=>{
      if(url.includes('/annotations/60?')) return response(detail);
      if(url==='/api/tageditor/sessions') {
        assert.equal(JSON.parse(options.body).dir,app.tagEditorDir);
        return response({session_id:'editor',dir:app.tagEditorDir,count:images.length,tags:[],page:1,
          page_size:60,total:images.length,total_pages:2,items:images.slice(0,60)});
      }
      if(url.startsWith('/api/tageditor/sessions/editor/images?')) {
        pageRequests++;
        const params=new URLSearchParams(url.split('?')[1]);
        assert.equal(params.get('use_regex'),'true');
        const pattern=new RegExp(params.get('search'),'i');
        const matches=images.filter(image=>pattern.test(image.rel_path) || pattern.test(image.tags));
        return response({page:1,total:matches.length,total_pages:Math.max(1,Math.ceil(matches.length/60)),items:matches.slice(0,60)});
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    await app.openCaptionDetail({index:60,name:target.name,path:target.path},null);
    app.openCaptionEditor(app.captionOverviewDetail);
    await app.tagEditorLoad(app.tagEditorDir);
    assert.equal(pageRequests,1);
    assert.equal(app.tagEditorFilteredTotal,1);
    assert.deepEqual(Array.from(app.tagEditorPageItems,image=>image.path),[target.path]);
    assert.deepEqual(Array.from(app.tagEditorSelected),[target.path]);
    assert.equal(selectedPanel,1);assert.equal(focused,1);
  });
}

test('content and logging switches preserve plan, gallery, detail and checked prompt',()=>{
  const {app,context}=harness();app.taggerSource={source_token:'batch',path:'dataset',total:10};
  app.captionOptionsChanged({initialize:true});
  const plan={requests:10,writes:10},detail={path:'dataset/a.png'};
  app.captionOverviewPlan=plan;app.captionOverviewDetail=detail;app.captionCheckPrompt='checked';
  let timers=0;context.setTimeout=()=>{timers++;return 1;};
  for(let i=0;i<20;i++) app.toggleCaptionCandidate('original',i%2===0);
  app.captionOptions.verbose=true;app.saveCaptionOptions();
  assert.equal(timers,0);assert.equal(app.captionOverviewPlan,plan);assert.equal(app.captionOverviewDetail,detail);
  assert.equal(app.captionCheckPrompt,'checked');assert.equal(app.captionPlanLoading,false);
  app.captionOptions.knowledge='new identity';app.saveCaptionOptions();
  assert.equal(app.captionCheckPrompt,'');assert.equal(app.captionOverviewDetail,detail);assert.equal(timers,0);
});

test('rapid recursive changes debounce one source scan and retain visible plan',()=>{
  const {app,context}=harness();app.taggerSource={source_token:'batch',path:'dataset',total:10};app.taggerSourcePath='dataset';
  app.captionOptionsChanged({initialize:true});const plan={requests:10,writes:10};app.captionOverviewPlan=plan;
  const timers=new Map();let id=0,scans=0;context.setTimeout=fn=>{timers.set(++id,fn);return id;};context.clearTimeout=key=>timers.delete(key);
  app.scanTaggerSource=async()=>{scans++;};
  for(let i=0;i<20;i++){app.captionOptions.recursive=i%2===0;app.scheduleTaggerSourceScan();app.saveCaptionOptions();}
  assert.equal(timers.size,1);assert.equal(app.captionOverviewPlan,plan);
  [...timers.values()][0]();assert.equal(scans,1);
});

test('newer plan owns pending state and older response cannot replace it',async()=>{
  const {app,context}=harness();app.taggerSource={source_token:'batch',path:'dataset',total:10};
  const oldPlan={requests:10};app.captionOverviewPlan=oldPlan;
  const first=deferred(),second=deferred();let calls=0;context.fetch=()=>++calls===1?first.promise:second.promise;
  const one=app.refreshCaptionPlan(),two=app.refreshCaptionPlan();assert.equal(app.captionOverviewPlan,oldPlan);assert.equal(app.captionPlanLoading,true);
  second.resolve(response({plan:{requests:4},counts:{total:10}}));await two;
  first.resolve(response({plan:{requests:99},counts:{total:99}}));await one;
  assert.equal(app.captionOverviewPlan.requests,4);assert.equal(app.captionPlanLoading,false);assert.equal(app.taggerSource.total,10);
});

test('settings restore supports both loaded values and factory defaults',()=>{
  const {app}=harness();app.taggerApiSettings.max_workers=4;app.loadCaptionOptions();
  app.taggerApiSettings.max_workers=9;assert.equal(app.captionFieldChanged('api','max_workers'),true);
  app.restoreCaptionField('api','max_workers');assert.equal(app.taggerApiSettings.max_workers,1);assert.equal(app.captionFieldChanged('api','max_workers'),false);
  app.restoreCaptionField('api','max_workers',true);assert.equal(app.taggerApiSettings.max_workers,4);
  app.captionOptions.candidates=['short','long'];app.restoreCaptionField('options','candidates');
  assert.deepEqual([...app.captionOptions.candidates],['original','long','medium','short']);
});

test('preflight counts are refreshed before overwrite confirmation and a changed plan reconfirms',async()=>{
  const {app,context}=harness();app.taggerSource={source_token:'batch',total:10};app.captionOptions.overwrite=true;
  let submits=0,confirmation;app.refreshCaptionPlan=async()=>({plan:{overwrite_captions:4,overwrite_json:3,overwrite_references:2}});
  app.openConfirm=(title,message,callback)=>{confirmation=callback;};context.fetch=async()=>{submits++;return response({task_id:'new'});};
  await app.startApiTagger();assert.equal(submits,0);assert.equal(typeof confirmation,'function');
  await confirmation();assert.equal(submits,1);assert.equal(app.taggerTaskId,'new');
});

test('navigation to local Tagger during planning cannot submit or clear the local dataset',async()=>{
  const {app,context}=harness();const plan=deferred();let submits=0;
  app.taggerSource={source_token:'batch-a',total:3};app.taggerSourcePath='dataset-a';
  app._taggerModeStates.folder={source:{source_token:'local-b',total:2},sourcePath:'dataset-b',taskId:'local-done'};
  app._taggerTasks['local-done']={status:'done',engine:'onnx'};
  context.fetch=async url=>{
    if(url.endsWith('/caption-plan')) return plan.promise;
    if(url.endsWith('/active')) return response({task_id:null});
    submits++;return response({task_id:'wrong'});
  };
  const start=app.startApiTagger();app.currentRoute='tagger';await app.buildTaggerForm();
  plan.resolve(response({counts:{total:3},plan:{requests:3,writes:3}}));await start;
  assert.equal(submits,0);assert.equal(app.taggerSource.source_token,'local-b');
  assert.equal(app.taggerTaskId,'local-done');assert.equal(app.taggerStarting,false);
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

test('an overwrite confirmation cannot be reused after switching the input source',async()=>{
  const {app,context}=harness();let confirm,submits=0;
  app.taggerSource={source_token:'batch-a',total:1};app.captionOptions.overwrite=true;
  app.openConfirm=(title,message,callback)=>{confirm=callback;};
  context.fetch=async url=>{
    if(url.endsWith('/caption-plan')) return response({counts:{total:1},plan:{overwrite_captions:1}});
    submits++;return response({task_id:'wrong'});
  };
  await app.startApiTagger();assert.equal(typeof confirm,'function');
  app.taggerSource={source_token:'batch-b',total:1};
  await confirm();assert.equal(submits,0);
});

for (const destination of ['single','tagger']) {
  test(`failed batch retry retains its workspace when switching to ${destination} before the response`,async()=>{
    const {app,context,storage}=harness();const pending=deferred();let requested;
    app.taggerSource={source_token:'batch',kind:'folder',total:3,path:'dataset'};app.taggerSourcePath='dataset';
    app.taggerTaskId='failed';app._taggerTasks.failed={status:'done',engine:'api',failed:1,_mode:'api-folder'};
    storage.set('anima-ai-tagger-task-id','failed');storage.set('anima-tagger-task-id','local-done');
    app._taggerModeStates.folder={source:{source_token:'local',total:2},sourcePath:'local-dataset',taskId:'local-done',resultText:'Keep local result'};
    app._taggerTasks['local-done']={status:'done',engine:'onnx'};
    app.captionTaskUpdated=()=>{};
    context.fetch=async url=>{
      if(url.endsWith('/retry')) {requested=url;return pending.promise;}
      if(url.endsWith('/active')) return response({task_id:null});
      if(url.endsWith('/local-done/status')) return response({status:'done',engine:'onnx',source_kind:'folder',source_token:'local',source_root:'local-dataset',total:2});
      if(url.includes('/items?')) return response({items:[],total:2});
      return response({active:false,tagger_busy:false});
    };
    const retry=app.retryFailedTagger();
    assert.equal(requested,'/api/tagger/tasks/failed/retry');
    if(destination === 'single') {
      await app.selectCaptionTab('single');app.taggerSource={source_token:'upload',total:1};
      app.captionSingleResult={candidates:{short:'Keep preview'}};
    } else {app.currentRoute='tagger';await app.buildTaggerForm();}
    const currentTask=app.taggerTaskId, currentSource=app.taggerSource;
    pending.resolve(response({task_id:'retry-new'}));await retry;
    assert.equal(app.taggerTaskId,currentTask);assert.equal(app.taggerSource,currentSource);
    assert.equal(app.captionBatchState().taskId,'retry-new');assert.equal(app.captionBatchRunning(),true);
    assert.equal(app.taggerTaskById('retry-new').engine,'api');
    assert.equal(storage.get('anima-ai-tagger-task-id'),'retry-new');
    assert.equal(storage.get('anima-tagger-task-id'),'local-done');
    assert.equal(storage.has(null) || storage.has('null'),false);
    const completed={engine:'api',status:'done',source_kind:'folder',source_token:'retry-subset',overview_source_token:'batch',source_root:'dataset',total:1,failed:0};
    app.handleRealtimeTaggerEvent({topic:'task:retry-new',type:'task.result',payload:{task_id:'retry-new',status:'FINISHED',data:completed}});
    assert.equal(app.taggerTaskId,currentTask);assert.equal(app.taggerSource,currentSource);
    assert.equal(app.captionBatchState().taskId,'retry-new');assert.equal(app.captionBatchRunning(),false);
    if(destination === 'single') assert.equal(app.captionSingleResult.candidates.short,'Keep preview');
    else assert.equal(app.taggerResultText,'Keep local result');
    // A fresh app must restore the retried task, not the original failed task.
    const reload=harness();for(const [key,value] of storage) reload.storage.set(key,value);
    reload.app.taggerSourceMode='folder';const restored=[];
    reload.context.fetch=async url=>{
      if(url.endsWith('/active')) return response({task_id:null});
      if(url.endsWith('/status')) {restored.push(url);return response(completed);}
      return response({active:false,tagger_busy:false,counts:{total:3},plan:{}});
    };
    await reload.app.buildTaggerForm();
    assert.deepEqual(restored,['/api/tagger/tasks/retry-new/status']);
    assert.equal(reload.app.captionBatchState().taskId,'retry-new');
    assert.equal(reload.app.captionBatchState().task.failed,0);
  });
}

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

test('preview remains allowed during training and regularization but blocks every Tagger kind',()=>{
  const {app}=harness();app.taggerSourceMode='api-single';app.taggerSource={total:1};app.trainingActive=true;app.regularizationActive=true;
  assert.equal(app.captionPreviewCanStart(),true);app.captionExternalTaggerBusy=true;assert.equal(app.captionPreviewCanStart(),false);
  app.captionExternalTaggerBusy=false;app.captionPreviewStatus='running';assert.equal(app.captionPreviewCanStart(),false);
});

test('prompt is fetched on demand and excluded from realtime frames',async()=>{
  const {app,context}=harness();app.taggerTaskId='dry-run';let url;context.fetch=async input=>{url=input;return response({prompt:'Full prompt',path:'dataset/next.png'});};
  await app.showCaptionCheckPrompt();assert.equal(url,'/api/tagger/tasks/dry-run/check-prompt');assert.equal(app.captionCheckPrompt,'Full prompt');assert.equal(app.captionPromptOpen,true);
});

for (const destination of ['source','tagger','monitor-dashboard','return','single','task']) {
  test(`late check-prompt response cannot overwrite the workspace after changing ${destination}`,async()=>{
    const {app,context}=harness(),pending=deferred();
    app.taggerSource={source_token:'old-source',kind:'folder',total:1,path:'old-dataset'};app.taggerSourcePath='old-dataset';
    app.taggerTaskId='old-check';app._taggerTasks['old-check']={status:'done',engine:'api',has_check_prompt:true};
    app.tagDictionaryCleanup=()=>{};
    context.fetch=async url=>{
      if(url.endsWith('/old-check/check-prompt'))return pending.promise;
      if(url.endsWith('/active'))return response({task_id:null});
      return response({active:false,tagger_busy:false,counts:{total:1},plan:{}});
    };
    const request=app.showCaptionCheckPrompt();
    if(destination==='source')app.setTaggerSource({source_token:'new-source',kind:'folder',total:1,path:'new-dataset'});
    else if(destination==='monitor-dashboard'||destination==='return') {
      app.currentRoute='monitor-dashboard';app.stopTaggerWorkspace();
      if(destination==='return'){app.currentRoute='ai-captioning';await app.buildTaggerForm();}
    } else if(destination==='tagger'){app.currentRoute='tagger';await app.buildTaggerForm();}
    else if(destination==='single')await app.selectCaptionTab('single');
    else {app.taggerTaskId='new-check';app._taggerTasks['new-check']={status:'done',engine:'api'};}
    app.captionCheckPrompt='Current prompt';app.captionCheckPromptPath='current/image.png';
    const before={route:app.currentRoute,mode:app.taggerSourceMode,source:app.taggerSource,task:app.taggerTaskId};
    pending.resolve(response({prompt:'Old prompt',path:'old-dataset/image.png'}));await request;
    assert.equal(app.captionPromptOpen,false);assert.equal(app.captionCheckPrompt,'Current prompt');
    assert.equal(app.captionCheckPromptPath,'current/image.png');assert.equal(app.currentRoute,before.route);
    assert.equal(app.taggerSourceMode,before.mode);assert.equal(app.taggerSource,before.source);assert.equal(app.taggerTaskId,before.task);
  });
}

test('a newer prompt request wins even when an older response arrives last',async()=>{
  const {app,context}=harness(),first=deferred(),second=deferred();let requests=0;
  app.taggerTaskId='check';context.fetch=()=>++requests===1?first.promise:second.promise;
  const old=app.showCaptionCheckPrompt(),current=app.showCaptionCheckPrompt();
  second.resolve(response({prompt:'Newest prompt',path:'new.png'}));await current;
  first.resolve(response({prompt:'Old prompt',path:'old.png'}));await old;
  assert.equal(app.captionCheckPrompt,'Newest prompt');assert.equal(app.captionCheckPromptPath,'new.png');assert.equal(app.captionPromptOpen,true);
});

test('a rejected prompt request cannot show an error after leaving its page',async()=>{
  const {app,context}=harness(),pending=deferred();const messages=[];
  app.taggerTaskId='check';app.tagDictionaryCleanup=()=>{};app.toast=message=>messages.push(message);context.fetch=()=>pending.promise;
  const request=app.showCaptionCheckPrompt();app.currentRoute='monitor-dashboard';app.stopTaggerWorkspace();
  pending.reject(new Error('Old request failed'));await request;
  assert.deepEqual(messages,[]);assert.equal(app.captionPromptOpen,false);
});

test('keyboard workspace navigation wraps and is blocked during preview',async()=>{
  const {app}=harness();app.refreshCaptionOverview=async()=>{};let prevented=0;
  app.captionTabKey({key:'ArrowLeft',preventDefault(){prevented++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(app.captionTab,'overview');
  app.captionPreviewStatus='running';await app.selectCaptionTab('single');assert.equal(app.captionTab,'overview');assert.equal(prevented,1);
});

test('locale parity includes every workspace string and all controls use production templates',()=>{
  const zh=JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
  for(const locale of ['en-US','ja-JP']) assert.deepEqual(Object.keys(JSON.parse(readRepo(`frontend/i18n/${locale}.json`)).caption).sort(),Object.keys(zh.caption).sort());
  const html=readRepo('frontend/caption-workspace.html');assert.match(html,/role="tablist"/);assert.match(html,/loading="lazy"/);assert.match(html,/captionDetailKey/);
});

test('failed uploads preserve previous image and preview; late uploads do not cross routes',async()=>{
  const {app,context}=harness();app.taggerSourceMode='api-single';app.taggerSource={source_token:'previous',total:1};
  app._taggerPreviewObjectUrl='blob:previous';app.captionSingleResult={candidates:{short:'Keep'}};
  context.fetch=async()=>({json:async()=>({status:'fail',message:'upload failed'})});
  await app.uploadTaggerFile({type:'image/png',name:'new.png'});
  assert.equal(app.taggerSource.source_token,'previous');assert.equal(app._taggerPreviewObjectUrl,'blob:previous');assert.equal(app.captionSingleResult.candidates.short,'Keep');
  const pending=deferred();context.fetch=()=>pending.promise;const upload=app.uploadTaggerFile({type:'image/png',name:'new.png'});
  app.currentRoute='tagger';app.taggerSourceMode='single';app.taggerSource={source_token:'local'};
  pending.resolve(response({source_token:'upload',total:1}));await upload;assert.equal(app.taggerSource.source_token,'local');
});

test('changing local Tagger model cannot clear stored AI batch task',()=>{
  const {app}=harness();app.currentRoute='tagger';app.taggerSourceMode='single';
  app._taggerModeStates['api-folder']={taskId:'moss-task',resultText:'MOSS result'};app._taggerTasks['moss-task']={status:'done',engine:'api'};
  app.handleTaggerModelChange(true);assert.equal(app._taggerModeStates['api-folder'].taskId,'moss-task');
  assert.equal(app._taggerModeStates['api-folder'].resultText,'MOSS result');
});

test('full page restore reads batch task even when saved navigation is single',async()=>{
  const {app,context,storage}=harness();storage.set('anima-ai-tab','single');storage.set('anima-ai-tagger-task-id','batch-saved');
  const restored=[];app.restoreTaggerTask=async id=>{restored.push(id);return true;};app.initCaptionWorkspace=async()=>{};
  context.fetch=async()=>response({task_id:null});await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode,'api-single');assert.deepEqual(restored,['batch-saved']);
  assert.equal(storage.get('anima-ai-tagger-task-id'),'batch-saved');
});

test('image URLs include stable identity and file version after a rescan',()=>{
  const {app}=harness();app.taggerSource={source_token:'batch'};app.captionOverviewItems=[{index:0,path:'dataset/a.png',image_version:'123'}];
  const old=app.captionOverviewImage(0);app.captionOverviewItems=[{index:0,path:'dataset/new.png',image_version:'456'}];
  assert.notEqual(old,app.captionOverviewImage(0));assert.match(old,/variant=thumb/);assert.match(old,/version=123/);
});

test('AI realtime does not also poll the removed task results list',()=>{
  const {app}=harness();let reads=0;app.refreshTaggerItems=async()=>{reads++;};app.captionTaskUpdated=()=>{};
  app.applyTaggerTaskSnapshot({engine:'api',status:'running',source_token:'source',source_root:'dataset',total:1},'RUNNING','api-task');
  assert.equal(reads,0);
  app.taggerSourceMode='folder';
  app.applyTaggerTaskSnapshot({engine:'onnx',status:'running',source_token:'source',source_root:'dataset',total:1},'RUNNING','local-task');
  assert.equal(reads,1);
});

test('preflight accepts normalized blank reference and becomes stale after a prompt change',()=>{
  const {app}=harness();app.taggerTaskId='check';app._taggerTasks.check={caption_options:{...app.captionOptions,reference_extension:'.txt',dry_run:true}};
  app.captionOptions.candidates=['long','short'];app.captionOptions.verbose=true;assert.equal(app.captionPrecheckStale(),false);
  app.captionOptions.candidates=['original'];assert.equal(app.captionPrecheckStale(),true);app.captionOptions.candidates=['long'];
  assert.equal(app.captionPrecheckStale(),false);app.captionOptions.knowledge='Changed';assert.equal(app.captionPrecheckStale(),true);
});

test('expired failure filter resets when a new directory clears the task',()=>{
  const {app}=harness();app.captionOverviewFilter='failed';app.taggerSource={source_token:'new',total:2};app.taggerSourcePath='new-directory';
  app.captionSourceChanged('api-folder');assert.equal(app.captionOverviewFilter,'all');
});

test('background task refresh keeps the grid interactive and does not overlap',async()=>{
  const {app,context}=harness();app.captionTab='overview';app.taggerSource={source_token:'batch',total:1};
  const pending=deferred();let calls=0;context.fetch=()=>{calls++;return pending.promise;};
  const refresh=app.refreshCaptionOverview({silent:true});assert.equal(app.captionOverviewLoading,false);assert.equal(app._captionOverviewInFlight,true);
  app.captionTaskUpdated({status:'running'},null,false);assert.equal(calls,1);
  pending.resolve(response({counts:{outputs:0,missing_outputs:1},items:[{path:'a.png'}],total:1,offset:0,plan:{}}));await refresh;
  assert.equal(app._captionOverviewInFlight,false);assert.equal(app.captionOverviewItems[0].path,'a.png');
});

test('changing a batch directory invalidates previous task, counts and preview plan',()=>{
  const {app,storage}=harness();app.taggerSource={source_token:'old',path:'old-directory',total:10};app.taggerSourcePath='new-directory';
  app.taggerTaskId='previous';app._taggerTasks.previous={status:'done'};app.captionOverviewPlan={requests:10};storage.set('anima-ai-tagger-task-id','previous');
  app.scheduleTaggerSourceScan();assert.equal(app.taggerTaskId,null);assert.equal(app.captionOverviewPlan,null);assert.equal(app.captionBatchState().source,null);
  assert.equal(storage.get('anima-ai-tagger-task-id'),undefined);
});

test('expired stored batch tasks are cleared while entering the single workspace',async()=>{
  const {app,context,storage}=harness();app.taggerSourceMode='api-single';storage.set('anima-ai-tagger-task-id','expired');
  context.fetch=async()=>({json:async()=>({status:'fail',message:'expired'})});assert.equal(await app.restoreTaggerTask('expired'),false);
  assert.equal(storage.get('anima-ai-tagger-task-id'),undefined);
});

test('switching before the first batch snapshot keeps preview blocked',async()=>{
  const {app}=harness();app.taggerSource={source_token:'batch',total:3};app.attachTaggerTask('starting');
  await app.selectCaptionTab('single');assert.equal(app.taggerRunning,false);assert.equal(app.captionBatchRunning(),true);
  app.handleRealtimeTaggerEvent({topic:'task:starting',type:'task.status',payload:{task_id:'starting',status:'CREATED',data:{}}});
  assert.equal(app.taggerTaskId,null);assert.equal(app.captionBatchRunning(),true);
  app.applyTaggerTaskSnapshot({engine:'api',status:'done'},'FINISHED','starting');assert.equal(app.captionBatchRunning(),false);
});

test('file drop reuses the shared upload handler for AI and local single modes',async()=>{
  const {app}=harness();const file={type:'image/png',name:'dropped.png'};const uploads=[];app.uploadTaggerFile=async value=>uploads.push(value);
  for(const mode of ['api-single','single']) {app.taggerSourceMode=mode;app.taggerDragOver=true;await app.handleTaggerDrop({dataTransfer:{files:[file]}});assert.equal(app.taggerDragOver,false);}
  app.taggerSourceMode='api-folder';await app.handleTaggerDrop({dataTransfer:{files:[file]}});assert.equal(uploads.length,2);assert.equal(uploads[0],file);
});

test('paste and drop cannot replace the image while a preview is active',async()=>{
  const {app,context}=harness();app.taggerSourceMode='api-single';app.captionPreviewStatus='running';app.taggerSource={source_token:'keep',total:1};
  let requests=0;context.fetch=async()=>{requests++;return response({});};const file={type:'image/png',name:'ignored.png'};
  await app.handleTaggerDrop({dataTransfer:{files:[file]}});
  await app.handleTaggerPaste({target:{},clipboardData:{files:[file]}});
  assert.equal(requests,0);assert.equal(app.taggerSource.source_token,'keep');
});

test('bootstrap snapshots finish the hidden batch task without changing single-image state',async()=>{
  const {app}=harness();
  app.taggerSource={source_token:'batch',path:'dataset',total:3};app.attachTaggerTask('batch-task');
  await app.selectCaptionTab('single');
  app.taggerSource={source_token:'upload',total:1};
  app.applyRealtimeTaggerSnapshot({tasks:{tracked:[{task_id:'batch-task',status:'FINISHED',data:{engine:'api',status:'done'}}]}});
  assert.equal(app.captionBatchRunning(),false);
  assert.equal(app.captionBatchState().task.status,'done');
  assert.equal(app.taggerTaskId,null);
  assert.equal(app.taggerSource.source_token,'upload');
  assert.equal(app.captionPreviewCanStart(),true);
  await app.selectCaptionTab('batch');
  assert.equal(app.taggerTask.status,'done');assert.equal(app.taggerRunning,false);
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

test('completed batch task survives page initialization in each saved workspace',async()=>{
  for (const tab of ['batch','single','overview']) {
    const {app,context,storage}=harness();app.taggerSourceMode='folder';
    storage.set('anima-ai-tab',tab);storage.set('anima-ai-tagger-task-id','completed');
    context.fetch=async url=>{
      if(url.endsWith('/active')) return response({task_id:null});
      if(url.endsWith('/completed/status')) return response({engine:'api',status:'done',source_kind:'folder',source_root:'dataset',source_token:'batch',total:3,checked:3,has_check_prompt:true});
      if(url.includes('/annotations?')) return response({counts:{total:3},items:[],total:3,offset:0,settings:{}});
      if(url.endsWith('/caption-plan')) return response({counts:{total:3},plan:{}});
      if(url.endsWith('/preview-state')) return response({active:false,tagger_busy:false,phase:'idle'});
      throw new Error(url);
    };
    await app.buildTaggerForm();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(app.captionTab,tab);
    assert.equal(app.captionBatchState().taskId,'completed');
    assert.equal(app.captionBatchState().task.checked,3);
    assert.equal(app.captionBatchState().task.has_check_prompt,true);
    assert.equal(storage.get('anima-ai-tagger-task-id'),'completed');
  }
});

test('leaving the tools page keeps the active task subscription until completion',()=>{
  const {app}=harness();app.attachTaggerTask('background');app.tagDictionaryCleanup=()=>{};
  app.stopTaggerWorkspace();app.currentRoute='train-anima';
  assert.equal(app._taggerRealtimeTopic,'task:background');
  app.handleRealtimeTaggerEvent({topic:'task:background',type:'task.status',payload:{task_id:'background',status:'FINISHED',data:{engine:'api',status:'done'}}});
  assert.equal(app.taggerHasActiveTask(),false);assert.equal(app._taggerRealtimeTopic,null);
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
