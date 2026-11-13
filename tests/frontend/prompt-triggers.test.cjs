const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend,composeMixins,response} = require('./helpers.cjs');

const tags = rows => rows.map(([tag,count])=>({tag,count}));
async function setup() {
  const values=new Map();
  const data={dataset_id:'C:/Dataset',caption_count:12,tags:tags([
    ['general',12],['vocaloid',10],['pending_tag',10],['hatsune miku',8],['my_trigger',8],['artist_name',8],['other_trigger',2],['rare_character',1],
  ]),subsets:[{id:'one',caption_count:10,leading_tags:tags([['my_trigger',8],['general',2]]),tags:tags([
    ['general',10],['vocaloid',10],['pending_tag',10],['hatsune miku',8],['my_trigger',8],['artist_name',8],['rare_character',1],
  ])},{id:'two',caption_count:2,leading_tags:tags([['other_trigger',2]]),tags:tags([['general',2],['other_trigger',2]])}]};
  const context=loadFrontend(['tag-dictionary/lib','tag-dictionary/index','tag-editor/index','training/prompt-workbench','training/prompt-tag-tools','training/prompt-triggers'],{
    window:{innerWidth:1000,innerHeight:800},document:{getElementById:()=>null,querySelector:()=>null},AbortController,
    fetch:async()=>response(data),localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},cancelAnimationFrame(){},
  });
  const meta=new Map([['general',{category:0}],['vocaloid',{category:3}],['hatsune miku',{category:4}],['my_trigger',null],
    ['artist_name',{category:1}],['rare_character',{category:4}],['other_trigger',null]]);
  const a=composeMixins(context.window.trainingPromptWorkbenchMixin,context.window.trainingPromptTagToolsMixin,context.window.trainingPromptTriggersMixin,{
    form:{model_train_type:'anima-lora',train_data_dir:'C:/Dataset',positive_prompts:'general, my trigger, hatsune miku, artist_name, other_trigger, rare_character, custom'},
    locale:'zh-CN',tagDictionaryVersion:0,tagDictionaryReady:false,t:key=>key,tagDictionaryLookupResultFor:tag=>meta.get(tag),
    $nextTick:async fn=>fn?.(),_trainingDatasetPayload:()=>({}),setField(key,value){this.form[key]=value;},
  });
  await a.openPromptWorkbench();
  return {a,context,data,meta,values};
}
const names=a=>Array.from(a.promptWorkbenchScopeTags,item=>item.tag);
const selected=a=>Array.from(a.promptWorkbenchPromptTags);

test('automatic guesses use per-subset coverage and confirmed dictionary results, not frequency alone',async()=>{
  const {a,meta}=await setup();
  assert.equal(a.promptWorkbenchIsTrigger('my_trigger'),false);
  a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();
  assert.equal(a.promptWorkbenchTriggerStatus('hatsune miku'),'auto');
  assert.equal(a.promptWorkbenchTriggerStatus('my trigger'),'auto');
  assert.equal(a.promptWorkbenchTriggerStatus('artist_name'),'auto');
  assert.equal(a.promptWorkbenchTriggerStatus('other_trigger'),'auto');
  for(const tag of ['general','vocaloid','rare_character','pending_tag']) assert.equal(a.promptWorkbenchIsTrigger(tag),false,tag);
  // Cache eviction must not undo an already resolved guess.
  meta.delete('my_trigger');a.refreshPromptWorkbenchTriggerGuesses();assert.equal(a.promptWorkbenchIsTrigger('my trigger'),true);
  meta.set('pending_tag',{category:0});a.refreshPromptWorkbenchTriggerGuesses();assert.equal(a.promptWorkbenchIsTrigger('pending_tag'),false);
});

test('unknown descriptive tags need repeated leading position before being guessed as triggers',async()=>{
  const {a,data,meta}=await setup();
  data.subsets[0].tags.push({tag:'silver hair',count:10});data.tags.push({tag:'silver hair',count:10});meta.set('silver hair',null);
  a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();
  assert.equal(a.promptWorkbenchIsTrigger('silver hair'),false);
  assert.equal(a.promptWorkbenchIsTrigger('my_trigger'),true);
});

test('triggers precede more frequent ordinary tags in both organize and all/subset candidates',async()=>{
  const {a}=await setup();a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();
  assert.deepEqual(names(a).slice(0,5),['hatsune miku','my_trigger','artist_name','other_trigger','general']);
  a.organizePromptWorkbenchTags();
  assert.deepEqual(selected(a),['hatsune miku','my trigger','artist_name','other_trigger','general','rare_character','custom']);
  a.setPromptWorkbenchSubset('two');a.organizePromptWorkbenchTags();
  assert.deepEqual(names(a),['other_trigger','general']);
  assert.deepEqual(selected(a),['other_trigger','hatsune miku','my trigger','artist_name','general','rare_character','custom']);
  a.promptWorkbenchExcludeEnabled=true;a.promptWorkbenchExcludeText='trigger';a.promptWorkbenchSearch='general';
  assert.deepEqual(Array.from(a.promptWorkbenchTags,item=>item.tag),['general']);
  assert.equal(a.promptWorkbenchIsTrigger('other_trigger'),true,'filtering does not change trigger status');
});

test('late trigger guesses update an untouched organize result to match candidate order',async()=>{
  const {a}=await setup();
  a.organizePromptWorkbenchTags();assert.equal(selected(a)[0],'general');
  a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();
  assert.equal(names(a)[0],'hatsune miku');assert.equal(selected(a)[0],'hatsune miku');
});

test('late trigger guesses preserve edits, manual order and a changed subset after organizing',async()=>{
  for(const mutate of [
    a=>a.setPromptWorkbenchTags(['general','custom','my trigger','hatsune miku']),
    a=>{const original=a.promptWorkbenchActive.text;a.updatePromptWorkbenchItem('edited');a.updatePromptWorkbenchItem(original);},
    a=>a.togglePromptWorkbenchTag('custom'),
    a=>a.setPromptWorkbenchSubset('one'),
  ]) {
    const {a}=await setup();a.organizePromptWorkbenchTags();mutate(a);
    const text=a.promptWorkbenchActive.text;
    a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();
    assert.equal(a.promptWorkbenchActive.text,text);
    assert.equal(names(a)[0],'hatsune miku');
  }
});

test('manual corrections persist by canonical dataset, override guesses and can return to automatic detection',async()=>{
  const {a,data,values}=await setup();a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();
  const raw=JSON.stringify(data);
  a.setPromptWorkbenchTrigger('my trigger',false);a.setPromptWorkbenchTrigger('general',true);a.setPromptWorkbenchTrigger('custom',true);
  assert.equal(a.promptWorkbenchIsTrigger('my_trigger'),false);assert.equal(a.promptWorkbenchTriggerStatus('general'),'manual');
  assert.equal(selected(a)[0],'general');assert.ok(selected(a).indexOf('custom')<selected(a).indexOf('my trigger'));
  a.closePromptWorkbench();await a.openPromptWorkbench();
  assert.equal(a.promptWorkbenchIsTrigger('my trigger'),false);assert.equal(a.promptWorkbenchTriggerStatus('custom'),'manual');
  a.promptWorkbenchData={...data,dataset_id:'D:/Other'};a.preparePromptWorkbenchTriggers();assert.equal(a.promptWorkbenchTriggerStatus('custom'),'');
  a.promptWorkbenchData={...data,dataset_id:'c:\\DATASET\\'};a.preparePromptWorkbenchTriggers();assert.equal(a.promptWorkbenchTriggerStatus('custom'),'manual');
  a.setPromptWorkbenchTrigger('my_trigger',null);assert.equal(a.promptWorkbenchTriggerStatus('my trigger'),'auto');
  assert.equal(a.promptWorkbenchTriggerHasOverride('my trigger'),false);
  assert.equal(JSON.stringify(data),raw,'only preview preferences change; caption statistics stay intact');
  assert.ok(values.get('anima-preview-trigger-overrides'));
});

test('a single caption and missing dictionary never cause an automatic guess; manual correction still works',async()=>{
  const {a,data}=await setup();
  a.setPromptWorkbenchTrigger('general',true);assert.equal(a.promptWorkbenchTriggerStatus('general'),'manual');
  a.promptWorkbenchData={...data,caption_count:1,subsets:[],tags:tags([['my_trigger',1]])};a.preparePromptWorkbenchTriggers();
  a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();assert.equal(a.promptWorkbenchIsTrigger('my_trigger'),false);
  a.setPromptWorkbenchTrigger('my_trigger',true);assert.equal(a.promptWorkbenchTriggerStatus('my_trigger'),'manual');
});

test('closing releases trigger view state without losing saved dataset corrections',async()=>{
  const {a}=await setup();a.tagDictionaryReady=true;a.refreshPromptWorkbenchTriggerGuesses();
  a.setPromptWorkbenchTrigger('general',true);
  assert.equal(a.promptWorkbenchTriggerStatus('hatsune miku'),'auto');
  assert.equal(a.promptWorkbenchTriggerStatus('general'),'manual');
  names(a); // Populate the sorted-scope cache before releasing the view.
  a.closePromptWorkbench();a.releasePromptWorkbenchView();
  assert.equal(a.promptWorkbenchTriggerDataset,'');
  assert.equal(a.promptWorkbenchTriggerOverrides.length,0);
  assert.equal(a.promptWorkbenchAutoTriggers.length,0);
  assert.equal(a.promptWorkbenchTriggerMenu,null);
  assert.equal(a.promptWorkbenchData,null);
  await a.openPromptWorkbench();
  assert.equal(a.promptWorkbenchTriggerStatus('general'),'manual');
  assert.equal(a.promptWorkbenchTriggerStatus('hatsune miku'),'auto');
});
