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
test('toggle removes complete tokens only and preserves other spelling',async()=>{
  const a=app();await a.openPromptWorkbench();
  a.updatePromptWorkbenchItem('hair, blue hair, long hair');
  a.togglePromptWorkbenchTag('hair');
  assert.equal(a.promptWorkbenchActive.text,'blue hair, long hair');
  a.updatePromptWorkbenchItem('hair, blue hair, long hair');
  a.togglePromptWorkbenchTag('blue hair');a.togglePromptWorkbenchTag('blue hair');
  assert.equal(a.promptWorkbenchActive.text,'hair, long hair, blue hair');
});
test('candidate selection reuses normalized membership until the active text changes',async()=>{
  const a=app();await a.openPromptWorkbench();a.updatePromptWorkbenchItem('long_hair, sky');
  const selected=a.promptWorkbenchSelectedTags;
  assert.equal(a.promptWorkbenchSelectedTags,selected);
  assert.equal(a.promptWorkbenchIsTagSelected('long hair'),true);
  a.togglePromptWorkbenchTag('long hair');assert.equal(a.promptWorkbenchActive.text,'sky');
  assert.notEqual(a.promptWorkbenchSelectedTags,selected);
  a.togglePromptWorkbenchTag('long hair');assert.equal(a.promptWorkbenchActive.text,'sky, long hair');
  assert.equal(a.promptWorkbenchIsTagSelected('LONG_HAIR'),true);
});
test('candidate toggles preserve grouped expressions and escaped commas as complete tags',async()=>{
  const a=app();await a.openPromptWorkbench();
  const text='(smile, blue hair, red eyes:1.2), long\\,name, sky';a.updatePromptWorkbenchItem(text);
  assert.equal(a.promptWorkbenchIsTagSelected('blue hair'),false);
  a.togglePromptWorkbenchTag('blue hair');assert.equal(a.promptWorkbenchActive.text,text+', blue hair');
  a.togglePromptWorkbenchTag('blue hair');assert.equal(a.promptWorkbenchActive.text,text);
  a.togglePromptWorkbenchTag('long\\,name');assert.equal(a.promptWorkbenchActive.text,'(smile, blue hair, red eyes:1.2), sky');
});
test('editing focuses the visible add input in chip mode and the textarea in text mode',async()=>{
  let focused='',selection;
  const a=app(undefined,{document:{getElementById:id=>({value:'abc',focus(){focused=id;},setSelectionRange(...range){selection=range;}})}});
  await a.openPromptWorkbench();a.promptWorkbenchUseTagChips=true;
  a.editPromptWorkbenchItem(a.promptWorkbenchActiveId,true);assert.equal(focused,'promptWorkbenchTagAdd');assert.deepEqual(selection,[3,3]);
  a.promptWorkbenchUseTagChips=false;a.editPromptWorkbenchItem(a.promptWorkbenchActiveId,true);assert.equal(focused,'promptWorkbenchEditor');
});
test('Shift adds or removes the displayed range according to the clicked tag, preserving tags outside the range',async()=>{
  const tags=['alpha','beta','gamma','delta'].map(tag=>({tag,count:1}));
  const a=app(async()=>response({tags,subsets:[]}));await a.openPromptWorkbench();
  a.togglePromptWorkbenchTag('beta');a.togglePromptWorkbenchTag('delta',{shiftKey:true});
  assert.equal(a.promptWorkbenchActive.text,'one, shared, beta, gamma, delta');
  a.togglePromptWorkbenchTag('alpha',{shiftKey:true});assert.equal(a.promptWorkbenchActive.text,'one, shared, beta, gamma, delta, alpha');
  a.togglePromptWorkbenchTag('delta',{shiftKey:true});assert.equal(a.promptWorkbenchActive.text,'one, shared, alpha');
  a.togglePromptWorkbenchTag('delta',{shiftKey:true});assert.equal(a.promptWorkbenchActive.text,'one, shared, alpha, beta, gamma, delta');
  a.togglePromptWorkbenchTag('alpha',{shiftKey:true});assert.equal(a.promptWorkbenchActive.text,'one, shared, gamma, delta');
});
test('reverse Shift removal uses complete prompt tags and preserves similarly named tags outside its range',async()=>{
  const tags=['hair','blue hair','long hair'].map(tag=>({tag,count:1}));
  const a=app(async()=>response({tags,subsets:[]}));a.form.positive_prompts='hair, blue hair, long hair, shared';await a.openPromptWorkbench();
  a.togglePromptWorkbenchTag('long hair');a.togglePromptWorkbenchTag('blue hair',{shiftKey:true});
  assert.equal(a.promptWorkbenchActive.text,'hair, shared');
});
test('Shift anchors reset after filtering or switching prompts and never select hidden tags',async()=>{
  const tags=['alpha','beta','gamma','delta'].map(tag=>({tag,count:1}));
  const a=app(async()=>response({tags,subsets:[]}));await a.openPromptWorkbench();
  a.togglePromptWorkbenchTag('alpha');a.promptWorkbenchSearch='delta';a.filterPromptWorkbench();
  a.togglePromptWorkbenchTag('delta',{shiftKey:true});assert.equal(a.promptWorkbenchActive.text,'one, shared, alpha, delta');
  a.promptWorkbenchSearch='';a.filterPromptWorkbench();a.togglePromptWorkbenchTag('beta');
  a.editPromptWorkbenchItem(a.promptWorkbenchItems[1].id);a.togglePromptWorkbenchTag('delta',{shiftKey:true});
  assert.equal(a.promptWorkbenchActive.text,'two, shared, delta');
});
test('subset, search and substring exclusions never change selected prompts or subset counts',async()=>{
  const a=app(async()=>response({tags:[{tag:'shared',count:2},{tag:'blue hair',count:1},{tag:'hair',count:1}],subsets:[{id:'a',name:'a',tags:[{tag:'shared',count:1}]}]}));
  await a.openPromptWorkbench();
  a.promptWorkbenchExcludeEnabled=true;a.promptWorkbenchExcludeText='hair';
  assert.deepEqual(Array.from(a.promptWorkbenchTags,row=>row.tag),['shared']);
  assert.equal(a.promptWorkbenchSubsetOptions[0].count,3);
  a.setPromptWorkbenchSubset('a');assert.equal(a.promptWorkbenchTags.length,1);
  a.promptWorkbenchSearch='missing';assert.equal(a.promptWorkbenchTags.length,0);
  assert.equal(a.promptWorkbenchActive.text,'one, shared');
});
test('exclusions match contained text ignoring case and blank rules never match every tag',async()=>{
  const tags=['smile','evil SMILE','smiley','smiling','blue hair'].map(tag=>({tag,count:1}));
  const a=app(async()=>response({tags,subsets:[]}));await a.openPromptWorkbench();
  a.promptWorkbenchExcludeEnabled=true;a.promptWorkbenchExcludeText='\n SMILE \n\nHAIR\n';
  assert.deepEqual(Array.from(a.promptWorkbenchTags,row=>row.tag),['smiling']);
  a.promptWorkbenchExcludeText=' , \n';assert.equal(a.promptWorkbenchTags.length,5);
  a.promptWorkbenchExcludeText='smile';a.promptWorkbenchExcludeEnabled=false;
  assert.equal(a.promptWorkbenchTags.length,5);assert.equal(a.promptWorkbenchActive.text,'one, shared');
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
test('restore persists immediately, empty lists persist, and Escape can cancel a single uncommitted edit',async()=>{
  const a=app();await a.openPromptWorkbench();a.promptWorkbenchExcludeText='only';a.openPromptWorkbenchExclusions();
  a.resetPromptWorkbenchExclusions();assert.ok(a.promptWorkbenchExclusionDraft.some(row=>row.value==='smile'));
  assert.ok(a.promptWorkbenchExcludeText.includes('smile'));a.closePromptWorkbenchExclusions();
  a.promptWorkbenchExcludeText='only';a.savePromptWorkbenchExclusions();
  a.openPromptWorkbenchExclusions();a.addPromptWorkbenchExclusion();a.cancelPromptWorkbenchExclusionEdit();
  assert.equal(a.promptWorkbenchExclusionDraft.length,1);
  a.editPromptWorkbenchExclusion();a.promptWorkbenchExclusionValue='changed';a.cancelPromptWorkbenchExclusionEdit();
  assert.equal(a.promptWorkbenchExclusionDraft[0].value,'only');
  a.deletePromptWorkbenchExclusion();assert.equal(a.promptWorkbenchExcludeText,'');a.closePromptWorkbenchExclusions();
  a.closePromptWorkbench();await a.openPromptWorkbench();assert.equal(a.promptWorkbenchExcludeText,'');
});
test('an empty edit disappears without leaving Delete targeted at the next row',async()=>{
  const a=app();await a.openPromptWorkbench();a.promptWorkbenchExcludeText='first\nsecond';a.openPromptWorkbenchExclusions();
  a.editPromptWorkbenchExclusion();a.promptWorkbenchExclusionValue='';a.commitPromptWorkbenchExclusion();
  assert.equal(a.promptWorkbenchExclusionDraft.length,1);
  assert.equal(a.promptWorkbenchExclusionSelectedId,'');
  a.deletePromptWorkbenchExclusion();assert.deepEqual(Array.from(a.promptWorkbenchExclusionDraft,row=>row.value),['second']);
  a.selectPromptWorkbenchExclusion(a.promptWorkbenchExclusionDraft[0].id);
  a.editPromptWorkbenchExclusion();a.promptWorkbenchExclusionValue='updated';a.commitPromptWorkbenchExclusion();
  assert.equal(a.promptWorkbenchExclusionEditingId,'');assert.equal(a.promptWorkbenchExcludeText,'updated');
  a.addPromptWorkbenchExclusion();a.addPromptWorkbenchExclusion();assert.equal(a.promptWorkbenchExclusionDraft.length,2);
  a.closePromptWorkbenchExclusions();assert.equal(a.promptWorkbenchExcludeText,'updated');
  assert.equal(a.promptWorkbenchExclusionDraft.length,1);
});
test('blank new rules are discarded on commit or close without saving preferences',async()=>{
  const a=app();await a.openPromptWorkbench();a.promptWorkbenchExcludeText='first\nsecond';a.openPromptWorkbenchExclusions();
  let writes=0;a.savePromptWorkbenchExclusions=()=>{writes++;};
  a.addPromptWorkbenchExclusion();a.promptWorkbenchExclusionValue='  ,  ';a.commitPromptWorkbenchExclusion();
  assert.deepEqual(Array.from(a.promptWorkbenchExclusionDraft,row=>row.value),['first','second']);
  assert.equal(a.promptWorkbenchExcludeText,'first\nsecond');assert.equal(writes,0);
  a.addPromptWorkbenchExclusion();a.closePromptWorkbenchExclusions();assert.equal(a.promptWorkbenchExclusionDraft.length,2);assert.equal(writes,0);
  a.openPromptWorkbenchExclusions();a.addPromptWorkbenchExclusion();a.promptWorkbenchExclusionValue='new';a.commitPromptWorkbenchExclusion();
  assert.equal(a.promptWorkbenchExcludeText,'first\nsecond\nnew');assert.equal(writes,1);
});
test('deleting the last prompt allows adding a new one',async()=>{
  const a=app();a.form.positive_prompts='only';await a.openPromptWorkbench();
  a.deletePromptWorkbenchItem(a.promptWorkbenchActiveId);assert.equal(a.promptWorkbenchActive,null);
  a.addPromptWorkbenchItem();
  a.togglePromptWorkbenchTag('new');assert.equal(a.promptWorkbenchActive.text,'new');
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
test('the closing animation retains its view until completion, then releases data and module caches',async()=>{
  const data={tags:[{tag:'shared',count:2}],subsets:[]},a=app(async()=>response(data));await a.openPromptWorkbench();
  let tagsReleased=0,triggersReleased=0;
  a.releasePromptWorkbenchTagTools=()=>tagsReleased++;a.releasePromptWorkbenchTriggers=()=>triggersReleased++;
  const items=a.promptWorkbenchItems,selected=a.promptWorkbenchSelectedTags;
  assert.equal(a.promptWorkbenchRendered,true);a.closePromptWorkbench();
  assert.equal(a.promptWorkbenchOpen,false);assert.equal(a.promptWorkbenchRendered,true);
  assert.equal(a.promptWorkbenchData,data);assert.equal(a.promptWorkbenchItems,items);
  a.releasePromptWorkbenchView();
  assert.equal(a.promptWorkbenchRendered,false);assert.equal(a.promptWorkbenchData,null);
  assert.equal(a.promptWorkbenchItems.length,0);assert.equal(a.promptWorkbenchActiveId,'');
  assert.equal(tagsReleased,1);assert.equal(triggersReleased,1);
  assert.notEqual(a.promptWorkbenchSelectedTags,selected);
});
test('an old closing-animation completion cannot release a reopened workbench',async()=>{
  const a=app();await a.openPromptWorkbench();a.closePromptWorkbench();await a.openPromptWorkbench();
  const items=a.promptWorkbenchItems,data=a.promptWorkbenchData;a.releasePromptWorkbenchView();
  assert.equal(a.promptWorkbenchOpen,true);assert.equal(a.promptWorkbenchRendered,true);
  assert.equal(a.promptWorkbenchData,data);assert.equal(a.promptWorkbenchItems,items);
});
test('manual refresh uses the shared feedback and ignores repeat clicks during a scan',async()=>{
  const pending=deferred();let hold=false,requests=0;
  const a=app(()=>{requests++;return hold?pending.promise:Promise.resolve(response({tags:[],subsets:[]}));});await a.openPromptWorkbench();let feedback=0;hold=true;
  a._showRefreshFeedback=kind=>{assert.equal(kind,'promptWorkbench');feedback++;};
  const refresh=a.refreshPromptWorkbenchTags();a.refreshPromptWorkbenchTags();assert.equal(feedback,1);
  assert.equal(requests,2);pending.resolve(response({tags:[],subsets:[]}));await refresh;a.closePromptWorkbench();a.refreshPromptWorkbenchTags();assert.equal(feedback,1);
});

// Exercise pointer delivery and the animation loop, including release between frames.
async function sorting(count = 3) {
  function classes() {
    const values = new Set();
    return {add:(...names)=>names.forEach(name=>values.add(name)),remove:(...names)=>names.forEach(name=>values.delete(name)),contains:name=>values.has(name)};
  }
  function events() {
    const listeners = new Map();
    return {
      addEventListener(type,fn){if(!listeners.has(type)) listeners.set(type,new Set());listeners.get(type).add(fn);},
      removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
      emit(type,event={}){for(const fn of [...(listeners.get(type)||[])]) fn(event);},
      listenerCount(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);},
    };
  }
  const win = events(), body = {classList:classes()}, frames = new Map();
  let clock=0, nextFrame=0;
  const a=app(undefined, {window:win,document:{body,getElementById:()=>null},
    requestAnimationFrame:fn=>{frames.set(++nextFrame,fn);return nextFrame;},cancelAnimationFrame:id=>frames.delete(id),
    getComputedStyle:()=>({rowGap:'4px'}),performance:{now:()=>clock},
  });
  a.form.positive_prompts=Array.from({length:count},(_,i)=>`prompt-${i+1}`).join('\n');
  await a.openPromptWorkbench();
  const dialog={children:[],append(node){this.children.push(node);node.remove=()=>{this.children=this.children.filter(value=>value!==node);};}};
  const list={classList:classes(),isConnected:true,scrollTop:0,scrollHeight:count*40-4,clientHeight:116,
    getBoundingClientRect:()=>({top:100,bottom:216,height:116}),closest:()=>dialog,querySelectorAll:()=>rows};
  const rows=a.promptWorkbenchItems.map((item,index)=>({
    dataset:{pwPromptId:item.id},style:{},classList:classes(),isConnected:true,
    closest:()=>list,getBoundingClientRect:()=>({left:20,top:100+index*40-list.scrollTop,width:400,height:36}),
    cloneNode(){return {style:{},classList:classes(),setAttribute(){},removeAttribute(){},querySelectorAll:()=>[]};},
  }));
  const handles=rows.map(row=>Object.assign(events(),{
    isConnected:true,captured:false,closest:()=>row,focus(){this.focused=true;},
    setPointerCapture(){this.captured=true;},releasePointerCapture(){this.captured=false;this.emit('lostpointercapture');},
  }));
  const event=(y,extra={})=>({button:0,isPrimary:true,pointerId:1,pointerType:'mouse',buttons:1,clientX:35,clientY:y,
    preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});
  return {a,win,body,list,rows,handles,dialog,frames,event,
    start(index=0,extra={}){a.startPromptWorkbenchSort(event(118+index*40-list.scrollTop,{currentTarget:handles[index],...extra}),a.promptWorkbenchItems[index].id);},
    move(y,extra={}){win.emit('pointermove',event(y,extra));},
    up(y,extra={}){win.emit('pointerup',event(y,extra));},
    frame(){clock+=16;const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(clock));},
    elapse(ms){clock+=ms;},
    order(){return Array.from(a.promptWorkbenchItems,item=>item.text);},
    assertClean(){assert.equal(dialog.children.length,0);assert.equal(frames.size,0);assert.equal(win.listenerCount(),0);
      assert.equal(body.classList.contains('pw-prompt-sorting'),false);
      assert.ok(handles.every(handle=>!handle.captured&&handle.listenerCount()===0));
      assert.ok(rows.every(row=>!row.style.transform&&!row.classList.contains('pw-sort-placeholder')));},
  };
}

test('pointer sorting follows immediately with a whole row and a full slot, then commits once',async()=>{
  const h=await sorting();h.start();h.move(121);
  assert.equal(h.dialog.children.length,0); // A short click must not start sorting.
  h.move(162);h.frame();
  const preview=h.dialog.children[0];
  assert.equal(preview.style.width,'400px');assert.equal(preview.style.height,'36px');
  assert.equal(preview.style.transform,'translate3d(20px, 144px, 0)');
  assert.equal(h.rows[0].classList.contains('pw-sort-placeholder'),true);
  assert.equal(h.rows[0].style.transform,'translate3d(0, 40px, 0)');
  assert.equal(h.rows[1].style.transform,'translate3d(0, -40px, 0)');
  assert.deepEqual(h.order(),['prompt-1','prompt-2','prompt-3']);
  h.up(162);
  assert.deepEqual(h.order(),['prompt-2','prompt-1','prompt-3']);
  assert.equal(h.a.promptWorkbenchActive.text,'prompt-1');h.assertClean();
});

test('release in a gap or beyond the list uses final coordinates even before the next frame',async()=>{
  const h=await sorting();h.start();h.move(159);h.up(178);
  assert.deepEqual(h.order(),['prompt-2','prompt-1','prompt-3']);h.assertClean();
  const other=await sorting();other.start();other.move(159);other.up(260);
  assert.deepEqual(other.order(),['prompt-2','prompt-3','prompt-1']);other.assertClean();
});

test('Escape cancels the proposed order and keeps the dialog open',async()=>{
  const h=await sorting();
  h.start();h.move(202);h.frame();
  const escape=h.event(202,{key:'Escape'});h.win.emit('keydown',escape);
  assert.equal(escape.prevented,true);assert.equal(escape.stopped,true);
  assert.equal(h.a.promptWorkbenchOpen,true);
  h.up(202);assert.deepEqual(h.order(),['prompt-1','prompt-2','prompt-3']);h.assertClean();
});

test('pointer cancellation, capture loss, window blur and resize all cleanly cancel sorting',async()=>{
  for(const type of ['pointercancel','lostpointercapture','blur','resize']) {
    const h=await sorting();h.start();h.move(202);h.frame();
    (type==='lostpointercapture'?h.handles[0]:h.win).emit(type,h.event(202));
    assert.deepEqual(h.order(),['prompt-1','prompt-2','prompt-3']);h.assertClean();
  }
});

test('holding the pointer at an edge scrolls while the preview stays attached to the pointer',async()=>{
  const h=await sorting(6);h.start();h.move(208);
  for(let i=0;i<30;i++) h.frame();
  assert.equal(h.list.scrollTop,h.list.scrollHeight-h.list.clientHeight);
  assert.equal(h.dialog.children[0].style.transform,'translate3d(20px, 190px, 0)');
  h.up(208);assert.deepEqual(h.order(),['prompt-2','prompt-3','prompt-4','prompt-5','prompt-6','prompt-1']);h.assertClean();
});

test('releasing at an unchanged pointer position commits the displayed slot without one last scroll',async()=>{
  const h=await sorting(6);h.start();h.move(208);
  for(let i=0;i<5;i++) h.frame();
  assert.equal(h.list.scrollTop,30);
  assert.equal(h.rows[0].style.transform,'translate3d(0, 80px, 0)');
  h.elapse(16); // Release between animation frames with no new pointer movement.
  h.up(208);
  assert.equal(h.list.scrollTop,30);
  assert.deepEqual(h.order(),['prompt-2','prompt-3','prompt-1','prompt-4','prompt-5','prompt-6']);
  h.assertClean();
});

test('other pointers cannot commit a drag, and closing cancels without saving its proposed order',async()=>{
  const h=await sorting();h.start();h.move(202,{pointerId:2});h.up(202,{pointerId:2});
  assert.equal(h.dialog.children.length,0);
  h.move(202);h.frame();h.a.closePromptWorkbench();
  assert.equal(h.a.form.positive_prompts,'prompt-1\nprompt-2\nprompt-3');h.assertClean();
});
