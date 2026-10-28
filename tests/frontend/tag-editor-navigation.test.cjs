const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTagEditor,deferred}=require('./helpers.cjs');

function fixture() {
  const pending=[],decodes=[],notices=[];
  const context={window:{},URLSearchParams,AbortController,setTimeout,clearTimeout,
    document:{body:{classList:{add(){},remove(){}}},querySelector:()=>null},
    fetch:()=>{const request=deferred();pending.push(request);return request.promise;},
    Image:class {constructor(){this.request=deferred();decodes.push(this);}decode(){return this.request.promise;}},
  };
  loadTagEditor(context);
  const app=Object.assign({},context.window.tagEditorMixin,{
    currentRoute:'tagEditor',tagEditorSessionId:'A',tagEditorPage:1,tagEditorServerTotalPages:2,
    tagEditorImages:[],tagEditorOriginal:{},_teEditVersions:{},_teCaptionRevisions:{},_tePathIndex:{},_tePageCache:{},
    _tdRequestChips(){},tagDictionarySyncChips(){},_teCloseSuggestions(){},_teFlushAllPendingTextEdits(){},_teScrollSelectedIntoView(){},
    toast:msg=>notices.push(msg),t:key=>key,$nextTick:cb=>cb(),tagEditorOriginalUrl:img=>'original/'+img.path,
  });
  app._teMergeSessionItems([0,1].map(i=>({path:'a'+i,name:'a'+i,tags:'\uFEFF  raw\r\n',preview:'preview/a'+i})),true);
  app.tagEditorSelected=['a1'];
  const reply=(idx,data)=>pending[idx].resolve({json:async()=>({status:'success',data})});
  return {app,pending,decodes,notices,reply};
}

test('failed page navigation preserves the selected image and raw text',async()=>{
  const {app,pending}=fixture();const before=app.tagEditorImages[1].tags;
  const action=app.tagEditorNavDetail(1);pending[0].reject(new Error('offline'));await action;
  assert.deepEqual(app.tagEditorSelected,['a1']);assert.equal(app.tagEditorImages[1].tags,before);
});

test('pending cross-page navigation cannot override a newer selection, filter or dataset',async()=>{
  for(const change of ['selection','filter','dataset']) {
    const {app,reply}=fixture();const action=app.tagEditorNavDetail(1);
    if(change==='selection') {app.tagEditorSelected=['a0'];app._updateEditorPanel();}
    if(change==='filter') app.tagEditorSearchQuery='different';
    if(change==='dataset') {app._teLoadEpoch++;app._teCancelPageFetch();app.tagEditorSessionId='B';app.tagEditorSelected=['b'];}
    const selection=app.tagEditorSelected.slice();
    reply(0,{page:2,total_pages:2,items:[{path:'a2',name:'a2',tags:'next'}]});await action;
    assert.deepEqual(app.tagEditorSelected,selection);
    assert.equal(app.tagEditorPage,1);
    assert.deepEqual(Array.from(app.tagEditorPageItems,img=>img.path),['a0','a1']);
  }
});

test('only the latest cross-page navigation selects a successfully loaded image',async()=>{
  const {app,reply}=fixture();const first=app.tagEditorNavDetail(1),second=app.tagEditorNavDetail(1);
  reply(0,{page:2,items:[{path:'stale',tags:'stale'}]});await first;
  reply(1,{page:2,total_pages:2,items:[{path:'a2',name:'a2',tags:'next'}]});await second;
  assert.deepEqual(Array.from(app.tagEditorSelected),['a2']);
  assert.equal(app.tagEditorPage,2);
});

test('lightbox navigation updates pixels and rejects old decode results; failures keep the new preview',async()=>{
  const {app,decodes,notices}=fixture();app.tagEditorOpenLightbox(app.tagEditorImages[0]);
  await app.tagEditorLightboxNav(1);
  assert.equal(app.tagEditorLightboxImage.path,'a1');assert.equal(app.tagEditorLightboxSrc,'preview/a1');
  decodes[0].request.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.tagEditorLightboxSrc,'preview/a1');assert.equal(app.tagEditorLightboxLoading,true);
  decodes[1].request.reject(new Error('decode'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.tagEditorLightboxSrc,'preview/a1');assert.equal(app.tagEditorLightboxLoading,false);assert.equal(notices.length,1);
  await app.tagEditorLightboxNav(-1);decodes[2].request.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.tagEditorLightboxSrc,'original/a0');assert.equal(app.tagEditorLightboxLoading,false);
});

test('closing a lightbox while paging or decoding preserves its previous selection',async()=>{
  const {app,reply,decodes}=fixture();app.tagEditorSelected=['a0','a1'];app.tagEditorOpenLightbox(app.tagEditorImages[1]);
  const navigation=app.tagEditorLightboxNav(1);app.tagEditorCloseLightbox();
  reply(0,{page:2,total_pages:2,items:[{path:'a2',name:'a2',tags:'next'}]});await navigation;
  decodes[0].request.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(app.tagEditorSelected,['a0','a1']);assert.equal(app.tagEditorLightboxOpen,false);
  assert.equal(app.tagEditorLightboxImage,null);assert.equal(app.tagEditorLightboxSrc,'');
  assert.equal(app.tagEditorPage,1);
  assert.deepEqual(Array.from(app.tagEditorPageItems,img=>img.path),['a0','a1']);
});

test('back-to-back lightbox navigation displays the latest selection',async()=>{
  const {app}=fixture();app.tagEditorOpenLightbox(app.tagEditorImages[0]);
  await Promise.all([app.tagEditorLightboxNav(1),app.tagEditorLightboxNav(-1)]);
  assert.equal(app.tagEditorSelected[0],'a0');assert.equal(app.tagEditorLightboxImage.path,'a0');
  assert.equal(app.tagEditorLightboxSrc,'preview/a0');
});

test('reversing direction while a lightbox page is loading keeps the active page navigable',async()=>{
  const {app,reply}=fixture();app.tagEditorOpenLightbox(app.tagEditorImages[1]);
  const pendingNext=app.tagEditorLightboxNav(1);
  await app.tagEditorLightboxNav(-1);
  reply(0,{page:2,total_pages:2,items:[{path:'a2',name:'a2',tags:'next'}]});await pendingNext;
  assert.equal(app.tagEditorLightboxImage.path,'a0');assert.equal(app.tagEditorLightboxSrc,'preview/a0');
  assert.equal(app.tagEditorPage,1);
  assert.equal(app.tagEditorCanNavDetail(1),true);
  await app.tagEditorLightboxNav(1);assert.equal(app.tagEditorLightboxImage.path,'a1');
});

test('an expired response from abandoned navigation cannot reload the active dataset',async()=>{
  const {app,pending}=fixture();const raw=app.tagEditorImages[0].tags;
  app.tagEditorReloadSessionPage=()=>assert.fail('abandoned navigation must not reload');
  const next=app.tagEditorNavDetail(1);await app.tagEditorNavDetail(-1);
  pending[0].resolve({json:async()=>({status:'error',code:'session_expired'})});await next;
  assert.equal(app.tagEditorPage,1);assert.deepEqual(Array.from(app.tagEditorSelected),['a0']);
  assert.equal(app.tagEditorImages[0].tags,raw);assert.equal(app._teSearchLoading,false);
});
