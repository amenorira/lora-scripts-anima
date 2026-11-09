const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTagEditor} = require('./helpers.cjs');

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
