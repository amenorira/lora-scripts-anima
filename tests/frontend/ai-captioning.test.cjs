const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, response, deferred, composeMixins} = require('./helpers.cjs');

function harness() {
  const storage = new Map();
  const context = loadFrontend(['tagger/index', 'tagger/ai-caption-options', 'tagger/caption-workspace'], {
    window: {}, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setTimeout:()=>1,clearTimeout:()=>{},requestAnimationFrame:fn=>fn(),document:{querySelector:()=>null,body:{classList:{remove(){}}}},
    fetch:async()=>response({task_id:null}), AbortController,
  });
  const app = composeMixins(context.window.taggerMixin,context.window.captionOptionsMixin);
  app.captionApiPayload = context.window.captionWorkspaceMixin.captionApiPayload;
  app.refreshCaptionPlan = async()=>({plan:{}});
  app.taggerSettings={...app.taggerSettings};app.taggerApiSettings={...app.taggerApiSettings};
  app.captionOptions={...app.captionOptions,output_format:'multi',candidates:['original','long','medium','short']};
  app._taggerModeStates={folder:null,single:null,'api-folder':null};
  app.t=k=>k;app.toast=()=>{};app._mountTaggerWorkspace=async()=>{};
  app.tagDictionaryInit=app.syncTaggerDictionary=app.realtimeSubscribe=app.realtimeUnsubscribe=app.renderTaggerResourceBar=()=>{};
  app.loadTaggerModels=app.loadCaptionTemplate=async()=>{};
  return {app,context,storage};
}

test('tasks send only fixed caption workflow and use existing API transport settings',async()=>{
  const {app,context}=harness();let sent;app.taggerSource={total:1,source_token:'folder'};
  app.captionOptions.mode='export';app.captionOptions.overwrite=true;app.attachTaggerTask=id=>{app.taggerTaskId=id;};
  context.fetch=async(url,init)=>{sent=JSON.parse(init.body);return response({task_id:'new'});};
  await app.startApiTagger();assert.equal(app.taggerTaskId,'new');assert.equal(sent.engine,'api');
  assert.deepEqual(Object.keys(sent.options),['captioning']);assert.equal(sent.options.captioning.mode,'export');
  assert.equal(sent.options.captioning.overwrite,true);assert.equal(sent.api.baseUrl,undefined);assert.equal(sent.api.base_url,'');
  assert.equal(sent.api.parse_mode,undefined);assert.equal(sent.options.captioning.save_json,undefined);
});

test('connection changes cancel the old test and cannot overwrite a newer result',async()=>{
  for (const [key,value] of [['baseUrl','http://b'],['apiKey','changed-key'],['protocol','responses']]) {
    const {app,context}=harness();
    app.currentRoute='ai-captioning';app.taggerApiSettings.baseUrl='http://a';
    const old=deferred(),next=deferred();let calls=0,oldSignal;
    context.fetch=(_url,options)=>{if (++calls===1) {oldSignal=options.signal;return old.promise;}return next.promise;};
    const first=app.testTaggerApiConnection();
    app.taggerApiSettings[key]=value;app.saveCaptionOptions();
    assert.equal(oldSignal.aborted,true);assert.equal(app.taggerApiTesting,false);
    const second=app.testTaggerApiConnection();
    // Even an implementation that delivers a response after abort cannot commit it.
    old.resolve(response({models:['old'],count:1}));await first;
    assert.equal(app.taggerApiTesting,true);assert.equal(app.taggerApiTestInfo.state,'');
    assert.equal(app.taggerApiModelSuggestions.length,0);
    next.resolve(response({models:['new'],count:1}));await second;
    assert.equal(app.taggerApiTesting,false);assert.equal(app.taggerApiTestInfo.state,'ok');
    assert.equal(app.taggerApiModelSuggestions[0],'new');
  }
});

test('switching task clears overwrite so an export choice cannot trigger regeneration',()=>{
  const {app}=harness();app.captionOptions.overwrite=true;app.setCaptionTaskMode('export');
  assert.equal(app.captionOptions.overwrite,false);app.captionOptions.overwrite=true;app.setCaptionTaskMode('generate');
  assert.equal(app.captionOptions.overwrite,false);
});

test('plain output selects one candidate and old saved workflows keep multi-candidate output',()=>{
  const {app,context,storage}=harness();
  app.setCaptionOutputFormat('plain');
  assert.deepEqual(Array.from(app.captionOptions.candidates),['long']);
  context.window.captionWorkspaceMixin.toggleCaptionCandidate.call(app,'short',true);
  assert.deepEqual(Array.from(app.captionOptions.candidates),['short']);
  context.window.captionWorkspaceMixin.toggleCaptionCandidate.call(app,'short',false);
  assert.deepEqual(Array.from(app.captionOptions.candidates),['short']);
  app._captionOptionsLoaded=false;
  storage.set('anima-moss-workflow',JSON.stringify({options:{candidates:['original','long','short']}}));
  app.loadCaptionOptions();
  assert.equal(app.captionOptions.output_format,'multi');
  assert.deepEqual(Array.from(app.captionOptions.candidates),['original','long','short']);
});

test('format candidate drafts survive switches, field actions and storage reload without leaking into API options',()=>{
  const {app,storage}=harness();app.loadCaptionOptions();
  app.captionOptions.candidates=['original','medium','short'];app.saveCaptionOptions();
  app.setCaptionOutputFormat('plain');app.captionOptions.candidates=['short'];app.saveCaptionOptions();
  app.setCaptionOutputFormat('multi');
  assert.deepEqual(Array.from(app.captionOptions.candidates),['original','medium','short']);
  app.restoreCaptionField('options','output_format');
  assert.equal(app.captionOptions.output_format,'plain');
  assert.deepEqual(Array.from(app.captionOptions.candidates),['short']);
  app.restoreCaptionField('options','candidates');assert.deepEqual(Array.from(app.captionOptions.candidates),['long']);
  app.setCaptionOutputFormat('multi');app.restoreCaptionField('options','candidates');
  assert.deepEqual(Array.from(app.captionOptions.candidates),['original','long','medium','short']);
  app.captionOptions.candidates=['medium','short'];app.saveCaptionOptions();app.setCaptionOutputFormat('plain');
  const saved=JSON.parse(storage.get('anima-moss-workflow'));
  assert.ok(saved.candidateDrafts);assert.equal(saved.options.candidateDrafts,undefined);
  app._captionOptionsLoaded=false;app.loadCaptionOptions();app.setCaptionOutputFormat('multi');
  assert.deepEqual(Array.from(app.captionOptions.candidates),['medium','short']);
});

test('legacy partial settings use old defaults and preserve the old single-image candidates',()=>{
  for(const legacyKey of ['anima-moss-workflow','anima-ai-caption-options']){
    const {app,storage}=harness();
    const options={separator:'OLD'};
    storage.set(legacyKey,JSON.stringify(legacyKey==='anima-moss-workflow'?{options}:options));app.loadCaptionOptions();
    assert.equal(app.captionOptions.output_format,'multi');
    assert.deepEqual(Array.from(app.captionOptions.candidates),['original','long','medium','short']);
    app.setCaptionCandidateContext('single');
    assert.equal(app.captionOptions.output_format,'multi');
    assert.deepEqual(Array.from(app.captionOptions.candidates),['long','medium','short']);
  }
  const {app,storage}=harness();
  storage.set('anima-moss-workflow',JSON.stringify({options:{output_format:'multi',candidates:['original']},candidateDrafts:{single:{format:'multi',multi:[],plain:['short']}}}));
  app.loadCaptionOptions();app.setCaptionCandidateContext('single');
  assert.deepEqual(Array.from(app.captionOptions.candidates),[]);
});

test('single-image trials keep valid independent candidates and restore the batch original selection',async()=>{
  const {app,context}=harness();app.loadCaptionOptions();app.captionTab='batch';
  app.selectTaggerSourceMode=async mode=>{app.taggerSourceMode=mode;};
  app.closeCaptionDetail=()=>{};app.syncCaptionPreviewState=async()=>{};
  app.setCaptionOutputFormat('plain');app.captionOptions.candidates=['original'];app.saveCaptionOptions();
  await context.window.captionWorkspaceMixin.selectCaptionTab.call(app,'single',false);
  assert.ok(app.captionOptions.candidates.every(name=>name!=='original'));
  app.setCaptionOutputFormat('plain');app.captionOptions.candidates=['short'];app.saveCaptionOptions();
  await context.window.captionWorkspaceMixin.selectCaptionTab.call(app,'batch',false);
  assert.equal(app.captionOptions.output_format,'plain');
  assert.deepEqual(Array.from(app.captionOptions.candidates),['original']);
  await context.window.captionWorkspaceMixin.selectCaptionTab.call(app,'single',false);
  assert.deepEqual(Array.from(app.captionOptions.candidates),['short']);
  app._captionOptionsLoaded=false;app.loadCaptionOptions();
  assert.deepEqual(Array.from(app.captionOptions.candidates),['original']);
  app.setCaptionCandidateContext('single');assert.deepEqual(Array.from(app.captionOptions.candidates),['short']);
});
