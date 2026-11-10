const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, loadTagEditor} = require('./helpers.cjs');

function fixture() {
  const notices = [], copies = [];
  const context = {
    window:{innerWidth:1000, innerHeight:800},
    document:{activeElement:null},
    navigator:{clipboard:{writeText:async text => copies.push(text)}},
  };
  loadTagEditor(context);
  const app = Object.assign({}, context.window.tagEditorMixin, {
    currentRoute:'tagEditor', tagEditorSelected:['image'], tagEditorTagSelection:[], tagEditorExcludedTags:[],
    tagEditorAllowsTagOps:()=>true, tagDictionaryCloseHover(){},
    t:key=>({'tagEditor.singleTagCopied':'Copied {tag}', 'tagEditor.dictCopyFailed':'Copy failed'}[key] || key),
    toast:(...args)=>notices.push(args),
  });
  return {app, context, notices, copies};
}

test('each context menu is positioned before it becomes visible and receives focus', async () => {
  const {app, context} = fixture();
  const focusTarget = {disabled:false, getClientRects:()=>[{}], focus(){context.document.activeElement=this;}};
  const trigger = {dataset:{tag:'blue'}, getBoundingClientRect:()=>({left:50,bottom:70}),
    closest(selector) { return selector.includes('te-editor-tag') || selector === '[tabindex], button' ? this : null; }};
  const sizes = {teTagMenu:[200,250], teImageMenu:[200,42], tePanelMenu:[200,276]};
  context.document.getElementById = id => ({getBoundingClientRect:()=>({width:sizes[id][0],height:sizes[id][1]}), querySelectorAll:()=>[focusTarget]});
  const event = {target:trigger,currentTarget:trigger,clientX:990,clientY:790,preventDefault(){},stopPropagation(){}};
  for (const [open, stateKey, y] of [
    [()=>app.tagEditorTagCtx(event,'blue'),'tagEditorContextMenu',546],
    [()=>app.tagEditorImageCtx(event,{path:'image'}),'tagEditorImageContextMenu',754],
    [()=>app.tagEditorPanelContext(event),'tagEditorPanelMenu',520],
  ]) {
    context.document.activeElement=null;
    open();
    assert.equal(app[stateKey].positioned,false);
    await Promise.resolve();
    assert.equal(app[stateKey].x,796);
    assert.equal(app[stateKey].y,y);
    assert.equal(app[stateKey].positioned,true);
    assert.equal(context.document.activeElement,null);
    await Promise.resolve();
    assert.equal(context.document.activeElement,focusTarget);
  }
  assert.deepEqual({...app._teContextMenuPoint({target:trigger,clientX:0,clientY:0})},{x:50,y:70});
});

test('closing or replacing a menu cancels deferred positioning and focus', async () => {
  const {app, context} = fixture();
  const focused=[];
  const trigger={getBoundingClientRect:()=>({left:10,bottom:20}), closest:()=>null};
  context.document.getElementById=id=>({
    getBoundingClientRect:()=>({width:220,height:100}),
    querySelectorAll:()=>[{disabled:false,getClientRects:()=>[{}],focus:()=>focused.push(id)}],
  });
  const event={target:trigger,currentTarget:trigger,clientX:900,clientY:750,preventDefault(){},stopPropagation(){}};
  app.tagEditorTagCtx(event,'first');
  app.tagEditorCloseTagMenu(false);
  await Promise.resolve();
  assert.deepEqual(focused,[]);
  app.tagEditorTagCtx(event,'first');
  await Promise.resolve();
  app.tagEditorTagCtx(event,'replacement');
  await Promise.resolve();
  app.tagEditorImageCtx(event,{path:'second'});
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(focused,['teImageMenu']);
});

test('Escape from outside an open context menu closes it and restores its trigger', () => {
  const {app, context} = fixture();
  const trigger = { isConnected: true, getClientRects: () => [{}], focus() { context.document.activeElement = this; } };
  app.$nextTick = callback => callback();
  for (const [stateKey, triggerKey] of [
    ['tagEditorPanelMenu', '_tePanelMenuTrigger'],
    ['tagEditorContextMenu', '_teTagMenuTrigger'],
    ['tagEditorImageContextMenu', '_teImageMenuTrigger'],
  ]) {
    context.document.activeElement = null;
    app[stateKey] = {};
    app[triggerKey] = trigger;
    let prevented = false;
    app.tagEditorHandleKeydown({ key: 'Escape', target: { closest: () => null }, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(app[stateKey], null);
    assert.equal(context.document.activeElement, trigger);
  }
});

test('right-clicking an enabled menu option selects it once', () => {
  const {app} = fixture();
  let selections=0;
  const button={matches:()=>false,click:()=>selections++};
  const menu={contains:node=>node === button};
  const event={button:2,target:{closest:()=>button},currentTarget:menu};
  app.tagEditorMenuContextSelect(event);
  assert.equal(selections,1);
  button.matches=()=>true;
  app.tagEditorMenuContextSelect(event);
  app.tagEditorMenuContextSelect({...event,button:0});
  app.tagEditorMenuContextSelect({...event,target:{closest:()=>null}});
  assert.equal(selections,1);
});

test('layout changes restore focus only from a menu and do not scroll its trigger', () => {
  const {app, context} = fixture();
  const focusCalls=[];
  const rect={left:10,right:50,top:10,bottom:30};
  const trigger={isConnected:true,getClientRects:()=>[{}],getBoundingClientRect:()=>rect,closest:()=>null,focus:options=>focusCalls.push(options.preventScroll)};
  for (const [stateKey, triggerKey, id] of [
    ['tagEditorPanelMenu','_tePanelMenuTrigger','tePanelMenu'],
    ['tagEditorContextMenu','_teTagMenuTrigger','teTagMenu'],
    ['tagEditorImageContextMenu','_teImageMenuTrigger','teImageMenu'],
  ]) {
    app[stateKey]={tag:'blue'};
    app[triggerKey]=trigger;
    context.document.activeElement={closest:()=>({id})};
    app.tagEditorCloseContextMenus(true);
    assert.equal(app[stateKey],null);
  }
  assert.deepEqual(focusCalls,[true,true,true]);
  app.tagEditorContextMenu={tag:'blue'};
  app._teTagMenuTrigger=trigger;
  context.document.activeElement={closest:()=>null};
  app.tagEditorCloseContextMenus(true);
  assert.deepEqual(focusCalls,[true,true,true]);
  app.tagEditorContextMenu={tag:'blue'};
  app._teTagMenuTrigger=trigger;
  context.document.activeElement={closest:()=>({id:'teTagMenu'})};
  const scrollTarget={contains:node=>node === trigger,getBoundingClientRect:()=>({left:0,right:200,top:100,bottom:300})};
  app.tagEditorCloseContextMenus(true,scrollTarget);
  assert.deepEqual(focusCalls,[true,true,true]);
});

test('right-clicking the inline rename field leaves text editing to the browser', () => {
  const {app} = fixture();
  let prevented=false;
  const event={target:{closest:()=>({})},preventDefault:()=>{prevented=true;},stopPropagation(){}};
  app.tagEditorTagCtx(event,'blue');
  assert.equal(prevented,false);
  assert.equal(app.tagEditorContextMenu,null);
});

test('tag explanations follow the context menu and close with it', async () => {
  const timers = new Map(), details = new Map();
  let timerId = 0;
  const document = {
    activeElement: null,
    getElementById(id) {
      if (id === 'teDictHover') return null;
      return {getBoundingClientRect:()=>({width:150,height:200}), querySelectorAll:()=>[], focus(){}};
    },
  };
  const context = {
    window:{innerWidth:1000,innerHeight:800}, document,
    setTimeout(fn) { const id=++timerId; timers.set(id,fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame:()=>1, cancelAnimationFrame() {},
  };
  loadTagEditor(context);
  loadFrontend('tag-dictionary/index', context);
  const app = Object.assign({}, context.window.tagEditorMixin, context.window.tagDictionaryMixin, {
    currentRoute:'tagEditor', tagEditorSelected:['image'], tagEditorAllowsTagOps:()=>true,
    tagDictionaryReady:true, $nextTick:callback=>callback(),
    tagDictionaryDetail:tag=>new Promise(resolve=>details.set(tag,resolve)),
  });
  function anchor(tag, panel=false) {
    return {
      dataset:{tag}, isConnected:true,
      getBoundingClientRect:()=>({left:300,right:350,top:100,bottom:120}),
      closest(selector) {
        if (selector === '[tabindex], button' || (panel && selector.includes('te-editor-tag'))) return this;
        if (selector === '.te-editor' && panel) return {getBoundingClientRect:()=>({left:700})};
        if (selector === '.te-sidebar' && !panel) return {getBoundingClientRect:()=>({right:350})};
        return null;
      },
    };
  }
  const first=anchor('blue hair'), second=anchor('standing');
  const eventFor=node=>({target:node,currentTarget:node,clientX:320,clientY:110,preventDefault(){},stopPropagation(){}});
  app.tagEditorTagCtx(eventFor(first),'blue hair');
  app.tagDictionaryHoverLeave();
  app.tagDictionaryHoverEnter('standing',second);
  assert.equal(app.tagDictionaryHover.tag,'blue hair');
  assert.equal(timers.size,0);

  app.tagEditorTagCtx(eventFor(second),'standing');
  details.get('blue hair')({canonical:'blue hair',description:'outdated'});
  details.get('standing')({canonical:'standing',description:'current'});
  await Promise.resolve();
  assert.equal(app.tagDictionaryHover.tag,'standing');
  assert.equal(app.tagDictionaryHover.description,'current');
  app.tagEditorCloseTagMenu(false);
  assert.equal(app.tagDictionaryHover,null);
  assert.equal(timers.size,0);

  app.tagEditorInlineEdit={chip:first};
  app.tagDictionaryHoverEnter('blue hair',first);
  app._tdShowHover('blue hair',first);
  assert.equal(app.tagDictionaryHover,null);
  app.tagDictionaryHoverEnter('standing',second);
  assert.equal(app.tagDictionaryHover,null);
  app.tagEditorInlineEdit=null;
  app.tagDictionaryHoverEnter('standing',second);
  assert.equal(app.tagDictionaryHover.tag,'standing');
  app.tagDictionaryCloseHover();

  app.tagEditorQuickRemove=true;
  const panelTag=anchor('blue hair',true);
  app.tagEditorPanelContext(eventFor(panelTag));
  assert.equal(app.tagDictionaryHover.tag,'blue hair');
  app.tagEditorClosePanelMenu(false);
  assert.equal(app.tagDictionaryHover,null);
  app.tagEditorPanelContext(eventFor(panelTag));
  app.currentRoute='tagger';
  app.tagDictionaryHoverEnter('standing',second);
  assert.equal(app.tagDictionaryHover.tag,'standing');
  app.currentRoute='tagEditor';
  app.tagEditorClosePanelMenu(false);
});

test('refreshing or loading the editor closes the tag menu and explanation', async () => {
  const {app} = fixture();
  let closed=0;
  app.tagEditorPanelMenu={tag:'blue'};
  app.tagEditorSelected=[];
  app.tagDictionaryCloseHover=()=>closed++;
  app.tagDictionarySyncChips=()=>{};
  app._teCloseSuggestions=()=>{};
  app._updateEditorPanel();
  assert.equal(app.tagEditorPanelMenu,null);
  assert.equal(closed,1);
  app.tagEditorPanelMenu={tag:'blue'};
  app.tagEditorDir='';
  app.finishProgress=()=>{};
  await app.tagEditorLoad('');
  assert.equal(app.tagEditorPanelMenu,null);
  assert.equal(closed,2);
});

test('tag and panel filter actions toggle the same filter and retain unrelated filters', async () => {
  const {app} = fixture();
  let invalidations=0, fetches=0;
  app._teInvalidateFilter=()=>invalidations++;
  app.tagEditorSchedulePageFetch=()=>fetches++;
  app.tagEditorCloseTagMenu=()=>{app.tagEditorContextMenu=null;};
  app.tagEditorClosePanelMenu=()=>{app.tagEditorPanelMenu=null;};
  app.tagEditorTagSelection=['other'];
  app.tagEditorExcludedTags=['blue', 'red'];
  app.tagEditorPanelMenu={tag:'blue'};
  await app.tagEditorPanelAction('filter');
  assert.deepEqual(Array.from(app.tagEditorTagSelection),['other','blue']);
  assert.deepEqual(Array.from(app.tagEditorExcludedTags),['red']);
  app.tagEditorContextMenu={tag:'blue'};
  app.tagEditorCtxInclude();
  assert.deepEqual(Array.from(app.tagEditorTagSelection),['other']);
  app.tagEditorContextMenu={tag:'blue'};
  app.tagEditorCtxExclude();
  app.tagEditorContextMenu={tag:'blue'};
  app.tagEditorCtxExclude();
  assert.deepEqual(Array.from(app.tagEditorExcludedTags),['red']);
  assert.equal(invalidations,4);
  assert.equal(fetches,4);
});

test('removing a repeated single-image tag removes the clicked occurrence', async () => {
  const {app} = fixture();
  const img={path:'image',tags:'blue, standing, blue'};
  let history=0;
  app.tagEditorGetSelectedImg=()=>img;
  app._teUpdateImageTags=(_, tags)=>{img.tags=tags;};
  app._tePushHistory=()=>history++;
  app._teImageLabel=()=>img.path;
  app.tagEditorClosePanelMenu=()=>{app.tagEditorPanelMenu=null;};
  app.tagEditorPanelMenu={tag:'blue'};
  app._tePanelMenuTrigger={classList:{contains:()=>true},dataset:{ti:'2'}};
  await app.tagEditorPanelAction('remove');
  assert.equal(img.tags,'blue, standing');
  assert.equal(history,1);
  app.tagEditorPanelMenu={tag:'blue'};
  app._tePanelMenuTrigger.dataset.ti='1';
  await app.tagEditorPanelAction('remove');
  assert.equal(img.tags,'blue, standing');
  assert.equal(history,1);
});

test('deleting a dataset tag removes every occurrence in each image', async () => {
  const {app} = fixture();
  const images=[{path:'a',tags:'blue, standing, blue'},{path:'b',tags:'blue, blue'},{path:'c',tags:'standing'}];
  let operation, history, syncs=0;
  app.tagEditorContextMenu={tag:'blue'};
  app.tagEditorCloseTagMenu=()=>{app.tagEditorContextMenu=null;};
  app._teConfirmTagBatch=(_, callback)=>{operation=callback();};
  app._teEnsureAllImagesLoaded=async()=>images;
  app._teUpdateImageTags=(img, tags)=>{img.tags=tags;};
  app.tagDictionarySyncChips=()=>{syncs++;};
  app._tePushHistory=meta=>{history=meta;};
  app.tagEditorCtxDeleteTag();
  await operation;
  assert.deepEqual(images.map(img=>img.tags),['standing','','standing']);
  assert.equal(history.affected,2);
  assert.equal(syncs,1);
});

test('copy feedback is consistent and reports clipboard failures', async () => {
  const {app, context, notices, copies} = fixture();
  app.tagEditorCloseTagMenu=()=>{app.tagEditorContextMenu=null;};
  app.tagEditorClosePanelMenu=()=>{app.tagEditorPanelMenu=null;};
  app.tagEditorContextMenu={tag:'blue'};
  await app.tagEditorCtxCopy();
  app.tagEditorPanelMenu={tag:'blue'};
  await app.tagEditorPanelAction('copy');
  assert.deepEqual(copies,['blue','blue']);
  assert.deepEqual(notices,[['Copied blue'],['Copied blue']]);
  context.navigator.clipboard.writeText=async()=>{throw new Error('denied');};
  app.tagEditorContextMenu={tag:'blue'};
  await app.tagEditorCtxCopy();
  assert.deepEqual(notices[2],['Copy failed','error']);
});

test('copying from the blank panel includes all tags from the selected images', async () => {
  const {app, copies} = fixture();
  app.tagEditorClosePanelMenu=()=>{app.tagEditorPanelMenu=null;};
  app.tagEditorGetSelectedImg=()=>({tags:'blue hair, standing'});
  app.tagEditorPanelMenu={tag:null};
  await app.tagEditorPanelAction('copy');
  assert.equal(copies[0],'blue hair, standing');

  app.tagEditorSelected=['a','b'];
  app.tagEditorImages=[
    {path:'a',tags:'blue hair, standing, __proto__, constructor'},
    {path:'b',tags:'red hair, standing, constructor, toString'},
    {path:'other',tags:'not selected'},
  ];
  app._teEditVersions={};
  app.tagEditorPanelMenu={tag:null};
  await app.tagEditorPanelAction('copy');
  assert.deepEqual(new Set(copies[1].split(', ')),new Set(['blue hair','standing','red hair','__proto__','constructor','toString']));
  const stats=app.tagEditorGetSelectedStats();
  assert.equal(stats.find(item=>item.tag==='constructor').count,2);
  assert.equal(stats.find(item=>item.tag==='__proto__').count,1);
});
