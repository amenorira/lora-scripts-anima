const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend,composeMixins,response,deferred} = require('./helpers.cjs');

async function setup(text='custom two, c, b, a, custom one',data={tags:[{tag:'a',count:9},{tag:'b',count:9},{tag:'c',count:1}],subsets:[{id:'s',tags:[{tag:'c',count:7},{tag:'b',count:2}]}]}) {
  const values=new Map(),timers=new Map();let timerId=0;
  const context=loadFrontend(['tag-dictionary/lib','tag-dictionary/index','tag-editor/index','training/prompt-workbench','training/prompt-tag-tools'],{
    window:{innerWidth:1000,innerHeight:800},document:{getElementById:()=>null,querySelector:()=>null},AbortController,
    fetch:async()=>response(data),localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),cancelAnimationFrame(){},
  });
  const a=composeMixins(context.window.trainingPromptWorkbenchMixin,context.window.trainingPromptTagToolsMixin,{
    form:{model_train_type:'anima-lora',positive_prompts:text},locale:'zh-CN',tagDictionaryVersion:0,t:key=>key,
    $nextTick:async fn=>fn?.(),_trainingDatasetPayload:()=>({}),setField(key,value){this.form[key]=value;},tagDictionaryComplete:async()=>null,
  });
  await a.openPromptWorkbench();
  return {a,context,values,runTimers(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());}};
}
const tokens=a=>Array.from(a.promptWorkbenchPromptTags);
const input=value=>({value,selectionStart:value.length,isConnected:true,getBoundingClientRect:()=>({left:10,top:200,bottom:230,width:280})});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('organize follows raw all/subset candidate order on ties and keeps unknown tags in their original order',async()=>{
  const {a}=await setup();a.organizePromptWorkbenchTags();
  assert.deepEqual(tokens(a),['a','b','c','custom two','custom one']);
  a.updatePromptWorkbenchItem('custom two, c, b, a, custom one');
  a.setPromptWorkbenchSubset('s');a.promptWorkbenchSearch='nothing';a.promptWorkbenchExcludeEnabled=true;a.promptWorkbenchExcludeText='b,c';
  a.organizePromptWorkbenchTags();assert.deepEqual(tokens(a),['c','b','custom two','a','custom one']);
  assert.equal(a.promptWorkbenchTagCount('c'),7);assert.equal(a.promptWorkbenchTagCount('a'),null);assert.equal(a.promptWorkbenchTagCount('custom one'),null);
});

test('organize keeps trigger ties consistent with filtered candidates in each scope',async()=>{
  const {a}=await setup('custom, long_hair, z trigger, solo',{
    tags:[{tag:'solo',count:18},{tag:'z trigger',count:18},{tag:'long hair',count:18}],
    subsets:[{id:'s',tags:[{tag:'long hair',count:4},{tag:'z trigger',count:4},{tag:'solo',count:1}]}],
  });
  a.promptWorkbenchExcludeEnabled=true;a.promptWorkbenchExcludeText='solo';
  a.organizePromptWorkbenchTags();
  assert.deepEqual(tokens(a),['solo','z trigger','long_hair','custom']);
  assert.deepEqual(Array.from(a.promptWorkbenchTags,item=>item.tag),['z trigger','long hair']);
  a.setPromptWorkbenchSubset('s');a.organizePromptWorkbenchTags();
  assert.deepEqual(tokens(a),['long_hair','z trigger','solo','custom']);
  assert.deepEqual(Array.from(a.promptWorkbenchTags,item=>item.tag),['long hair','z trigger']);
});

test('tag parsing and organizing preserve grouped prompts and escaped commas',async()=>{
  const text='custom, (smile, blue hair:1.2), a, long\\,name, [b, c]';
  const {a}=await setup(text);assert.deepEqual(tokens(a),['custom','(smile, blue hair:1.2)','a','long\\,name','[b, c]']);
  a.organizePromptWorkbenchTags();assert.deepEqual(tokens(a),['a','custom','(smile, blue hair:1.2)','long\\,name','[b, c]']);
});

test('adding typed tags avoids normalized duplicates and keeps existing prompt spelling',async()=>{
  const {a}=await setup('blue_hair, (a, b:1.2)');a.promptWorkbenchTagInput='blue hair, new_tag, new tag';a.addPromptWorkbenchTags();
  assert.equal(a.promptWorkbenchActive.text,'blue_hair, (a, b:1.2), new_tag');assert.equal(a.promptWorkbenchTagInput,'');
  a.removePromptWorkbenchTagAt(1);assert.equal(a.promptWorkbenchActive.text,'blue_hair, new_tag');
});

test('removing chips keeps keyboard focus on the adjacent chip and then the add input',async()=>{
  const {a,context}=await setup('a, b, c');
  const focused=[],scrolled=[];
  context.document.querySelector=selector=>{
    const match=selector.match(/#promptWorkbenchTagChips \[data-pw-tag-index="(\d+)"\]/);
    return match ? {focus:()=>focused.push(Number(match[1])),scrollIntoView:()=>scrolled.push(Number(match[1]))} : null;
  };
  context.document.getElementById=id=>id==='promptWorkbenchTagAdd'?{focus:()=>focused.push('add')}:null;
  a.setPromptWorkbenchTagChips(true);
  a.removePromptWorkbenchTagAt(1);assert.deepEqual(tokens(a),['a','c']);
  a.removePromptWorkbenchTagAt(1);assert.deepEqual(tokens(a),['a']);
  a.removePromptWorkbenchTagAt(0);assert.deepEqual(tokens(a),[]);
  assert.deepEqual(focused,[1,0,'add']);assert.deepEqual(scrolled,[1,0]);
});

test('keyboard chip reordering follows the moved chip without stealing focus after switching prompts',async()=>{
  const {a,context}=await setup('a, b, c\nsecond');
  const focused=[],scrolled=[];
  context.document.querySelector=selector=>({focus:()=>focused.push(selector),scrollIntoView:()=>scrolled.push(selector)});
  a.setPromptWorkbenchTagChips(true);
  a.promptWorkbenchTagSortKey({key:'ArrowRight',altKey:true,preventDefault(){},stopPropagation(){}},0);
  assert.deepEqual(tokens(a),['b','a','c']);assert.match(focused[0],/data-pw-tag-index="1"/);assert.equal(scrolled.length,1);
  const ticks=[];a.$nextTick=fn=>ticks.push(fn);
  a.removePromptWorkbenchTagAt(1);a.editPromptWorkbenchItem(a.promptWorkbenchItems[1].id);
  ticks[0]();assert.equal(focused.length,1);
});

test('chip mode persists its preference and structured prompts cannot be changed by tag tools',async()=>{
  const {a}=await setup();a.setPromptWorkbenchTagChips(true);a.closePromptWorkbench();await a.openPromptWorkbench();
  assert.equal(a.promptWorkbenchUseTagChips,true);
  a.closePromptWorkbench();a.form={model_train_type:'moss-image-lora',positive_prompts:'{"description":"a scene"}'};await a.openPromptWorkbench();
  assert.equal(a.promptWorkbenchUseTagChips,false);a.promptWorkbenchTagInput='added';a.addPromptWorkbenchTags();a.organizePromptWorkbenchTags();
  assert.equal(a.promptWorkbenchActive.text,'{"description":"a scene"}');
});

test('autocomplete gives local results immediately and ignores a late reply after closing',async()=>{
  const {a,runTimers}=await setup('solo',{tags:[{tag:'blue hair',count:4},{tag:'long hair',count:2},{tag:'solo',count:5}],subsets:[]});
  const pending=deferred();a.tagDictionaryComplete=()=>pending.promise;a.promptWorkbenchTagInput='hair';
  a.suggestPromptWorkbenchTags(input('hair'));runTimers();
  assert.deepEqual(Array.from(a.promptWorkbenchTagSuggestions,s=>s.insert),['blue hair','long hair']);
  a.closePromptWorkbenchTagSuggestions();pending.resolve({localTags:[],results:[{canonical:'hair_bow',animaTag:'hair bow',translation:'发蝴蝶结',category:0,postCount:40}]});await flush();
  assert.equal(a.promptWorkbenchTagSuggestions.length,0);assert.equal(a.promptWorkbenchTagSuggestLoading,false);
});

test('dictionary candidates can add tags outside the dataset and IME Enter never adds prematurely',async()=>{
  const {a,runTimers}=await setup('solo',{tags:[{tag:'solo',count:1}],subsets:[]});
  a.tagDictionaryComplete=async()=>({localTags:[],results:[{canonical:'purple_hair',animaTag:'purple hair',translation:'紫发',category:0,postCount:90}]});
  a.promptWorkbenchTagInput='紫';a.suggestPromptWorkbenchTags(input('紫'));runTimers();await flush();
  assert.equal(a.promptWorkbenchTagSuggestions[0].insert,'purple hair');a.promptWorkbenchTagSuggestIndex=0;
  const key={key:'Enter',isComposing:true,preventDefault(){},stopPropagation(){}};a.promptWorkbenchTagKey(key);assert.equal(a.promptWorkbenchActive.text,'solo');
  key.isComposing=false;a.promptWorkbenchTagKey(key);assert.equal(a.promptWorkbenchActive.text,'solo, purple hair');assert.equal(a.promptWorkbenchTagCount('purple hair'),null);
});

test('dictionary artist completions add the at prefix only for Anima and retain original input',async()=>{
  for(const profile of ['anima-lora','sdxl-lora','krea2-lora','moss-image-lora']) {
    const {a,runTimers}=await setup('solo',{tags:[{tag:'solo',count:1}],subsets:[]});
    a.closePromptWorkbench();a.form.model_train_type=profile;await a.openPromptWorkbench();
    a.tagDictionaryComplete=async()=>({localTags:[],results:[{canonical:'test_artist',animaTag:'@test artist',translation:'测试画师',category:1,postCount:90}]});
    a.promptWorkbenchTagInput='test';a.suggestPromptWorkbenchTags(input('test'));runTimers();await flush();
    const expected=profile==='anima-lora'?'@test artist':'test artist';
    assert.equal(a.promptWorkbenchTagSuggestions[0].insert,expected,profile);
    assert.equal(a.promptWorkbenchTagSuggestions[0].label,expected,profile);
    a.addPromptWorkbenchTags(a.promptWorkbenchTagSuggestions[0]);assert.equal(a.promptWorkbenchActive.text,'solo, '+expected,profile);
    a.promptWorkbenchTagInput='@explicit artist';a.addPromptWorkbenchTags();
    assert.ok(a.promptWorkbenchActive.text.endsWith(', @explicit artist'),profile);
  }
});

test('non-Anima local artist tags keep dataset spelling and do not duplicate an existing equivalent',async()=>{
  const {a,runTimers}=await setup('solo',{tags:[{tag:'solo',count:2},{tag:'test_artist',count:1},{tag:'@original artist',count:1}],subsets:[]});
  a.closePromptWorkbench();a.form.model_train_type='sdxl-lora';await a.openPromptWorkbench();
  a.tagDictionaryComplete=async()=>({localTags:['test_artist','@original artist'],results:[{canonical:'test_artist',animaTag:'@test artist',translation:'测试画师',category:1,postCount:90}]});
  a.promptWorkbenchTagInput='artist';a.suggestPromptWorkbenchTags(input('artist'));runTimers();await flush();
  assert.deepEqual(Array.from(a.promptWorkbenchTagSuggestions,item=>item.insert),['test_artist','@original artist','test artist']);
  a.addPromptWorkbenchTags(a.promptWorkbenchTagSuggestions[0]);
  a.promptWorkbenchTagInput='artist';a.suggestPromptWorkbenchTags(input('artist'));runTimers();await flush();
  assert.ok(a.promptWorkbenchTagSuggestions.every(item=>!['test_artist','test artist','@test artist'].includes(item.insert)));
});

test('local autocomplete supports more results and switching prompts cancels outstanding completion',async()=>{
  const data={tags:Array.from({length:45},(_,i)=>({tag:'tag '+i,count:50-i})),subsets:[]};
  const {a,runTimers}=await setup('one\ntwo',data);a.promptWorkbenchTagInput='tag';a.suggestPromptWorkbenchTags(input('tag'));runTimers();await flush();
  assert.equal(a.promptWorkbenchTagSuggestions.length,20);assert.equal(a.promptWorkbenchTagSuggestMore,true);
  await a.morePromptWorkbenchTagSuggestions();assert.equal(a.promptWorkbenchTagSuggestions.length,40);
  a.editPromptWorkbenchItem(a.promptWorkbenchItems[1].id);assert.equal(a.promptWorkbenchTagSuggestions.length,0);assert.equal(a.promptWorkbenchTagInput,'');
});

test('wrapped chip insertion respects visual rows and clamps beyond either edge',async()=>{
  const {context}=await setup();
  const entries=[{rect:{left:0,right:40,top:0,bottom:25}},{rect:{left:44,right:90,top:0,bottom:25}},
    {rect:{left:0,right:55,top:29,bottom:64}},{rect:{left:59,right:110,top:29,bottom:54}}];
  const insert=context.promptTagInsertion;
  assert.equal(insert(entries,80,-10),0);assert.equal(insert(entries,20,80),4);
  assert.equal(insert(entries,50,12),1);assert.equal(insert(entries,5,40),2);assert.equal(insert(entries,100,40),4);
});
