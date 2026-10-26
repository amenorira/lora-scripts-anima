const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function fixture() {
  const context = {window:{}, URLSearchParams, setTimeout, clearTimeout};
  loadFrontend('tag-editor.js',context);
  const app = Object.assign({},context.window.tagEditorMixin, {
    tagEditorSessionId:'test', tagEditorPageItems:[], tagEditorSelected:[],
    _teFlushAllPendingTextEdits(){}, _updateEditorPanel(){},
    t:key=>({'tagEditor.selectedOutsidePage':'{n} selected / {outside} outside',
      'tagEditor.batchOutsidePage':'{n} outside'}[key] || key),
  });
  app.tagEditorPageItems=Array.from({length:5},(_,i)=>({path:'a'+i,tags:'  raw\r\n'}));
  return app;
}

test('Shift uses a path anchor only in the current page and checkbox clicks update it',()=>{
  const app=fixture();
  app.tagEditorCardClick(app.tagEditorPageItems[4],4,{});
  app.tagEditorPageItems=Array.from({length:5},(_,i)=>({path:'b'+i,tags:'raw'}));
  app.tagEditorCardClick(app.tagEditorPageItems[2],2,{shiftKey:true});
  assert.deepEqual(Array.from(app.tagEditorSelected),['b2']);
  app.tagEditorToggleSelect('b0');
  app.tagEditorCardClick(app.tagEditorPageItems[1],1,{shiftKey:true});
  assert.deepEqual(Array.from(app.tagEditorSelected),['b0','b1']);
});

test('filter and sort scheduling invalidates an otherwise still visible anchor',()=>{
  const app=fixture();
  app.tagEditorCardClick(app.tagEditorPageItems[4],4,{});
  app.tagEditorSchedulePageFetch(true);
  app._teCancelPageFetch();
  app.tagEditorCardClick(app.tagEditorPageItems[2],2,{shiftKey:true});
  assert.deepEqual(Array.from(app.tagEditorSelected),['a2']);
  app.tagEditorClearSelection();
  assert.equal(app._teLastSelected,null);
});

test('page selection and inversion preserve off-page selections and raw captions',()=>{
  const app=fixture();
  app.tagEditorSelected=['other','a1'];
  app.tagEditorSelectInvert();
  assert.deepEqual(Array.from(app.tagEditorSelected),['other','a0','a2','a3','a4']);
  assert.equal(app.tagEditorSelectionLabel(),'5 selected / 1 outside');
  assert.equal(app._teOutsidePageHint(app.tagEditorSelected),'\n1 outside');
  app.tagEditorSelectAll();
  assert.equal(app.tagEditorSelected.length,6);
  assert.equal(new Set(app.tagEditorSelected).size,6);
  assert.ok(app.tagEditorPageItems.every(img=>img.tags==='  raw\r\n'));
});
