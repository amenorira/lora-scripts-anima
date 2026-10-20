const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, response, deferred} = require('./helpers.cjs');

function harness() {
  const storage = new Map();
  const context = loadFrontend(['tagger', 'ai-caption-options'], {
    window: {}, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setTimeout:()=>1,clearTimeout:()=>{},requestAnimationFrame:fn=>fn(),document:{querySelector:()=>null,body:{classList:{remove(){}}}},
    fetch:async()=>response({task_id:null}),
  });
  const app = {...context.window.taggerMixin,...context.window.captionOptionsMixin};
  app.taggerSettings={...app.taggerSettings};app.taggerApiSettings={...app.taggerApiSettings};
  app.captionOptions={...app.captionOptions,candidates:['original','long','medium','short']};
  app._taggerModeStates={folder:null,single:null,'api-folder':null};
  app.t=k=>k;app.toast=()=>{};app._mountTaggerWorkspace=async()=>{};
  app.tagDictionaryInit=app.syncTaggerDictionary=app.realtimeSubscribe=app.realtimeUnsubscribe=app.renderTaggerResourceBar=()=>{};
  app.loadTaggerModels=app.loadCaptionTemplate=async()=>{};
  return {app,context,storage};
}

test('AI directory route and local tagger tabs retain independent sources',async()=>{
  const {app}=harness();app.currentRoute='tagger';app.taggerSourcePath='local-folder';
  await app.buildTaggerForm();app.currentRoute='ai-captioning';await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode,'api-folder');assert.equal(app.taggerSourcePath,'');
  app.taggerSourcePath='ai-folder';app.currentRoute='tagger';await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode,'folder');assert.equal(app.taggerSourcePath,'local-folder');
  app.currentRoute='ai-captioning';await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode,'api-folder');assert.equal(app.taggerSourcePath,'ai-folder');
});

test('initial local route still restores its single-image tab',async()=>{
  const {app,storage}=harness();app.currentRoute='tagger';storage.set('anima-tagger-mode','single');
  await app.buildTaggerForm();assert.equal(app.taggerSourceMode,'single');
});

test('AI route ignores local active tasks and restores its own options',async()=>{
  const {app,context}=harness();app.currentRoute='ai-captioning';app.taggerSourceMode='api-folder';app.taggerSourcePath='keep';
  context.fetch=async()=>response({engine:'pytorch',source_kind:'folder',source_root:'local',status:'running'});
  await app.restoreTaggerTask('local');assert.equal(app.taggerSourcePath,'keep');assert.equal(app.taggerTaskId,null);
  context.fetch=async()=>response({engine:'api',source_kind:'folder',source_token:'saved',status:'running',logs:[],caption_options:{mode:'export',overwrite:true,candidates:['short']}});
  app.refreshTaggerItems=async()=>{};await app.restoreTaggerTask('ai');
  assert.equal(app.captionOptions.mode,'export');assert.equal(app.captionOptions.overwrite,true);assert.equal(app.taggerRunning,true);
});

test('export needs no model; generation checks active prompt, conflict and task state',()=>{
  const {app}=harness();app.taggerSource={total:1};assert.equal(app.taggerApiCanStart(),false);
  app.captionOptions.mode='export';assert.equal(app.taggerApiCanStart(),true);
  app.taggerRunning=true;assert.equal(app.taggerApiCanStart(),false);app.taggerRunning=false;
  app.captionOptions.mode='generate';Object.assign(app.taggerApiSettings,{baseUrl:'http://local/v1',model:'mine'});
  assert.equal(app.taggerApiCanStart(),true);app.captionOptions.reference_extension='.txt';assert.equal(app.taggerApiCanStart(),false);
  app.captionOptions.overwrite=true;assert.equal(app.taggerApiCanStart(),true);
  app.captionOptions.prompt_source='file';assert.equal(app.taggerApiCanStart(),false);
  app.captionOptions.prompt_file='prompt.txt';assert.equal(app.taggerApiCanStart(),true);
  app.captionOptions.candidates=[];assert.equal(app.taggerApiCanStart(),false);
});

test('input check needs no connection and inactive prompt inputs do not block it',()=>{
  const {app}=harness();app.taggerSource={total:1};assert.equal(app.captionCanCheck(),true);
  app.captionOptions.prompt_source='text';assert.equal(app.captionCanCheck(),false);
  app.captionDefaultPrompt='MOSS JSON template';app.setCaptionPromptSource('text');
  assert.equal(app.captionCanCheck(),true);assert.equal(app.captionOptions.prompt_text,'MOSS JSON template');
  app.setCaptionPromptSource('default');app.captionOptions.prompt_file='';assert.equal(app.captionCanCheck(),true);
  app.captionOptions.mode='export';assert.equal(app.captionCanCheck(),false);
});

test('tasks send only fixed caption workflow and use existing API transport settings',async()=>{
  const {app,context}=harness();let sent;app.taggerSource={total:1,source_token:'folder'};
  app.captionOptions.mode='export';app.captionOptions.overwrite=true;app.attachTaggerTask=id=>{app.taggerTaskId=id;};
  context.fetch=async(url,init)=>{sent=JSON.parse(init.body);return response({task_id:'new'});};
  await app.startApiTagger();assert.equal(app.taggerTaskId,'new');assert.equal(sent.engine,'api');
  assert.deepEqual(Object.keys(sent.options),['captioning']);assert.equal(sent.options.captioning.mode,'export');
  assert.equal(sent.options.captioning.overwrite,true);assert.equal(sent.api.baseUrl,undefined);assert.equal(sent.api.base_url,'');
  assert.equal(sent.api.parse_mode,undefined);assert.equal(sent.options.captioning.save_json,undefined);
});

test('migration retains useful settings but does not restore obsolete modes or tag cleanup',()=>{
  const {app,storage}=harness();
  storage.set('anima-tagger-api-settings',JSON.stringify({model:'my-model',baseUrl:'http://local',protocol:'responses',additionalTags:'old',parseMode:'tags',promptPresetId:'booru'}));
  storage.set('anima-ai-caption-options',JSON.stringify({mode:'regenerate',reference_extension:'.tags',knowledge:'Known',save_json:false}));
  app.loadCaptionOptions();assert.equal(app.taggerApiSettings.model,'my-model');assert.equal(app.taggerApiSettings.protocol,'responses');
  assert.equal(app.captionOptions.mode,'generate');assert.equal(app.captionOptions.knowledge,'Known');
  assert.equal(app.taggerApiSettings.additionalTags,undefined);assert.equal(app.taggerApiSettings.parseMode,undefined);assert.equal(app.captionOptions.save_json,undefined);
});

test('model list never selects the first result or fills a default model',async()=>{
  const {app,context}=harness();app.loadCaptionOptions();assert.equal(app.taggerApiSettings.model,'');
  app.taggerApiSettings.baseUrl='http://local';context.fetch=async()=>response({models:['model1'],count:1});
  await app.testTaggerApiConnection();assert.equal(app.taggerApiSettings.model,'');assert.equal(app.taggerApiModelSuggestions[0],'model1');
});

test('legacy autofilled model is cleared but explicit selection persists',()=>{
  for(const [saved,expected] of [[{model:'deepseek-v4-flash-vision-exp'},''],[{model:'my-custom'},'my-custom'],[{model:'gpt-4o-mini',modelSelectionVersion:1},'gpt-4o-mini']]){
    const {app,storage}=harness();storage.set('anima-tagger-api-settings',JSON.stringify(saved));app.loadCaptionOptions();
    assert.equal(app.taggerApiSettings.model,expected);app.saveCaptionOptions();assert.equal(JSON.parse(storage.get('anima-moss-workflow')).api.model,expected);
  }
});

test('image transfer format applies quality only to JPEG',()=>{
  const {app}=harness();assert.equal(app.captionImageFormat(),'png');app.setCaptionImageFormat('jpeg');
  assert.equal(app.taggerApiSettings.jpeg_quality,90);app.taggerApiSettings.jpeg_quality=85;app.setCaptionImageFormat('jpeg');
  assert.equal(app.taggerApiSettings.jpeg_quality,85);app.setCaptionImageFormat('png');assert.equal(app.taggerApiSettings.jpeg_quality,'');
});

test('switching task clears overwrite so an export choice cannot trigger regeneration',()=>{
  const {app}=harness();app.captionOptions.overwrite=true;app.setCaptionTaskMode('export');
  assert.equal(app.captionOptions.overwrite,false);app.captionOptions.overwrite=true;app.setCaptionTaskMode('generate');
  assert.equal(app.captionOptions.overwrite,false);
});

test('hidden original candidate cannot enable generation without a reference extension',()=>{
  const {app}=harness();app.taggerSource={total:1};Object.assign(app.taggerApiSettings,{baseUrl:'http://local',model:'mine'});
  app.captionOptions.reference_extension='';app.captionOptions.candidates=['original'];
  assert.equal(app.taggerApiCanStart(),false);assert.equal(app.captionCanCheck(),false);
  app.setCaptionTaskMode('export');assert.equal(app.taggerApiCanStart(),true);
});

test('a scan response from the previous route cannot replace the active source',async()=>{
  const {app,context}=harness();const pending=deferred();context.fetch=()=>pending.promise;
  app.currentRoute='ai-captioning';app.taggerSourceMode='api-folder';app.taggerSourcePath='same-path';
  const scan=app.scanTaggerSource();app.currentRoute='tagger';app.taggerSourceMode='folder';app.taggerSource={source_token:'local-source'};
  pending.resolve(response({source_token:'ai-source',path:'same-path',total:2}));await scan;
  assert.equal(app.taggerSource.source_token,'local-source');
});
