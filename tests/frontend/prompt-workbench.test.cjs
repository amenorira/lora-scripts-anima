const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, response, deferred} = require('./helpers.cjs');

function app(fetch = async () => response({tags:[], subsets:[]}), globals = {}) {
  const values = new Map();
  const context = loadFrontend(['tag-dictionary/lib','training/prompt-workbench'], {
    window:{}, AbortController, fetch, document:{getElementById:()=>null},
    localStorage:{getItem:key=>values.get(key), setItem:(key,value)=>values.set(key,value)},
    ...globals,
  });
  return composeMixins(context.window.trainingPromptWorkbenchMixin, {
    form:{model_train_type:'anima-lora',positive_prompts:'one, shared\ntwo, shared'},
    t:key=>key, locale:'zh-CN', tagDictionaryVersion:0,
    $nextTick:async fn=>fn?.(), _trainingDatasetPayload:()=>({train_data_dir:'dataset'}),
    setField(key,value){this.form[key]=value;},
  });
}
test('edits, addition, reordering and deletion preserve active identity and serialize on close',async()=>{
  const a=app();await a.openPromptWorkbench();
  const first=a.promptWorkbenchItems[0].id,second=a.promptWorkbenchItems[1].id;
  a.editPromptWorkbenchItem(first);
  a.movePromptWorkbenchItem(first,second,true);
  assert.equal(a.promptWorkbenchActiveId,first);
  assert.equal(a.promptWorkbenchItems[0].id,second);
  a.togglePromptWorkbenchTag('new');
  assert.equal(a.promptWorkbenchActive.text,'one, shared, new');
  a.addPromptWorkbenchItem();a.updatePromptWorkbenchItem('third\ncontinued');
  a.deletePromptWorkbenchItem(second);
  assert.equal(a.promptWorkbenchItems.length,2);
  a.closePromptWorkbench();
  assert.equal(a.form.positive_prompts,'one, shared, new\nthird continued');
});

test('row editor persists new, edit and delete immediately and closing commits the current edit',async()=>{
  const a=app();await a.openPromptWorkbench();a.promptWorkbenchExcludeEnabled=true;
  a.promptWorkbenchExcludeText='smile, solo\nSMILE';a.openPromptWorkbenchExclusions();
  assert.deepEqual(Array.from(a.promptWorkbenchExclusionDraft,row=>row.value),['smile','solo']);
  a.addPromptWorkbenchExclusion();a.promptWorkbenchExclusionValue=' Hair ';a.commitPromptWorkbenchExclusion();
  const first=a.promptWorkbenchExclusionDraft[0].id;
  a.selectPromptWorkbenchExclusion(first);a.editPromptWorkbenchExclusion();
  a.promptWorkbenchExclusionValue='evil smile';a.commitPromptWorkbenchExclusion();
  a.selectPromptWorkbenchExclusion(a.promptWorkbenchExclusionDraft[1].id);a.deletePromptWorkbenchExclusion();
  assert.equal(a.promptWorkbenchExcludeText,'evil smile\nHair');
  a.editPromptWorkbenchExclusion();a.promptWorkbenchExclusionValue='long hair';a.closePromptWorkbenchExclusions();
  assert.equal(a.promptWorkbenchExclusionsOpen,false);assert.equal(a.promptWorkbenchExcludeText,'evil smile\nlong hair');
  a.closePromptWorkbench();await a.openPromptWorkbench();
  assert.equal(a.promptWorkbenchExcludeText,'evil smile\nlong hair');assert.equal(a.promptWorkbenchExcludeEnabled,true);
});

test('MOSS preserves one structured prompt and refuses tag insertion',async()=>{
  const a=app();a.form={model_train_type:'moss-image-lora',positive_prompts:'{\n"description":"scene"\n}'};
  await a.openPromptWorkbench();assert.equal(a.promptWorkbenchItems.length,1);
  a.addPromptWorkbenchItem();assert.equal(a.promptWorkbenchItems.length,1);
  a.togglePromptWorkbenchTag('new');a.closePromptWorkbench();
  assert.equal(a.form.positive_prompts,'{\n"description":"scene"\n}');
});
test('closing cancels stale scans and commits to the original field only',async()=>{
  const pending=deferred();const a=app(()=>pending.promise);
  a.form.krea_sample_prompts='krea';const loading=a.openPromptWorkbench('krea_sample_prompts');
  a.updatePromptWorkbenchItem('edited');a.closePromptWorkbench();
  pending.resolve(response({tags:[{tag:'late',count:1}],subsets:[]}));await loading;
  assert.equal(a.promptWorkbenchData,null);assert.equal(a.form.krea_sample_prompts,'edited');
  assert.equal(a.form.positive_prompts,'one, shared\ntwo, shared');
});

test('an old closing-animation completion cannot release a reopened workbench',async()=>{
  const a=app();await a.openPromptWorkbench();a.closePromptWorkbench();await a.openPromptWorkbench();
  const items=a.promptWorkbenchItems,data=a.promptWorkbenchData;a.releasePromptWorkbenchView();
  assert.equal(a.promptWorkbenchOpen,true);assert.equal(a.promptWorkbenchRendered,true);
  assert.equal(a.promptWorkbenchData,data);assert.equal(a.promptWorkbenchItems,items);
});
