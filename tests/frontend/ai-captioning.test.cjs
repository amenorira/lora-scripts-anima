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
  app.captionOptions={...app.captionOptions,candidates:['original','long','medium','short']};
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
