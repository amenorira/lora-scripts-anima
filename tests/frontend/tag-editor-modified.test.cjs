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

test('modified view applies search, regex, tag conditions and sorting using current captions',()=>{
  const app=fixture();app.tagEditorSortAsc=false;app.tagEditorSchedulePageFetch(true);
  assert.deepEqual(paths(app),['b','z','a']);
  app.tagEditorSearchQuery='dir/a';app.tagEditorSchedulePageFetch(true);assert.deepEqual(paths(app),['a']);
  app.tagEditorSearchQuery='blue$';app.tagEditorUseRegex=true;app.tagEditorSchedulePageFetch(true);
  assert.deepEqual(paths(app),['b','z']);
  app.tagEditorSearchQuery='[';app.tagEditorSchedulePageFetch(true);assert.deepEqual(paths(app),[]);
  app.tagEditorSearchQuery='';app.tagEditorTagSelection=['cat'];app.tagEditorExcludedTags=['red'];
  app.tagEditorSchedulePageFetch(true);assert.deepEqual(paths(app),['z']);
  assert.equal(app.tagEditorDirectoryImageCount(app.tagEditorImages[0]),1);
});

test('selecting all modified results honors filters across pages without fetching or altering text',async()=>{
  const app=fixture();app.tagEditorPageSize=1;app.tagEditorTagSelection=['cat'];
  app.tagEditorSchedulePageFetch(true);const raw=app.tagEditorImages.map(img=>img.tags);
  await app.tagEditorSelectFiltered();assert.deepEqual(Array.from(app.tagEditorSelected),['a','z']);
  assert.deepEqual(app.tagEditorImages.map(img=>img.tags),raw);assert.deepEqual(paths(app),['a']);
});

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

test('a queued modified refresh cannot replace the page after leaving that filter',async()=>{
  const app=fixture();app._teInvalidateFilter();app.tagEditorQuickFilter='all';
  app.tagEditorPageItems=[{path:'server-result'}];await Promise.resolve();
  assert.deepEqual(paths(app),['server-result']);
});
