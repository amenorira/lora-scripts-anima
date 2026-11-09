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
  const event={target:trigger,currentTarget:trigger,clientX:900,clientY:750};
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
