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
const input=value=>({value,selectionStart:value.length,isConnected:true,getBoundingClientRect:()=>({left:10,top:200,bottom:230,width:280})});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

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
