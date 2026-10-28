const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTagEditor}=require('./helpers.cjs');

function fixture() {
  const context={window:{},URLSearchParams,setTimeout,clearTimeout,
    fetch:()=>assert.fail('modified filtering must stay local'),
    localStorage:{removeItem(){}}};
  loadTagEditor(context);
  const images=[
    {path:'z',name:'z.png',rel_path:'dir/z.png',tags:'cat, blue'},
    {path:'a',name:'a.png',rel_path:'dir/a.png',tags:'cat, red'},
    {path:'b',name:'b.png',rel_path:'other/b.png',tags:'dog, blue'},
  ];
  const app=Object.assign({},context.window.tagEditorMixin,{
    tagEditorSessionId:'A',tagEditorQuickFilter:'modified',tagEditorImages:images,
    tagEditorOriginal:{z:'old',a:'old',b:'old'},tagEditorSelected:['b'],
    _teModifiedCount:3,tagEditorModified:true,_teHistoryState:{},tagEditorHistory:[],
    _tePathIndex:Object.fromEntries(images.map(img=>[img.path,img])),
    _teUpdateFreq(){},tagDictionarySyncChips(){},_teCloseSuggestions(){},toast(){},t:key=>key,
  });
  return app;
}
const paths=app=>Array.from(app.tagEditorPageItems,img=>img.path);

test('edits, undo and redo refresh modified pages while preserving raw text and off-page selection',async()=>{
  const app=fixture();app.tagEditorPageSize=1;app.tagEditorPage=3;app.tagEditorSchedulePageFetch(false);
  const original='\uFEFF  raw\r\n\r\n  ';app.tagEditorOriginal.b=original;
  const history={b:{before:app.tagEditorImages[2].tags,after:original}};
  app.tagEditorHistory=[{changes:history}];app.tagEditorHistoryIdx=-1;
  app.tagEditorRedo();await Promise.resolve();
  assert.equal(app.tagEditorFilteredTotal,2);assert.equal(app.tagEditorPage,2);
  assert.deepEqual(paths(app),['z']);assert.deepEqual(app.tagEditorSelected,['b']);
  assert.equal(app.tagEditorImages[2].tags,original);
  app.tagEditorUndo();await Promise.resolve();assert.equal(app.tagEditorFilteredTotal,3);
  assert.equal(app.tagEditorImages[2].tags,'dog, blue');
  app.tagEditorRedo();await Promise.resolve();assert.equal(app.tagEditorImages[2].tags,original);
  app._teUpdateImageTags(app.tagEditorImages[0],'old');app._teUpdateImageTags(app.tagEditorImages[1],'old');
  await Promise.resolve();assert.equal(app.tagEditorPage,1);assert.equal(app.tagEditorFilteredTotal,0);
  assert.deepEqual(paths(app),[]);assert.deepEqual(app.tagEditorSelected,['b']);
});
