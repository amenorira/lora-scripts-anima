const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor } = require('./helpers.cjs');

function fixture() {
  const context = {window:{}, URLSearchParams, setTimeout, clearTimeout};
  loadTagEditor(context);
  const app = Object.assign({},context.window.tagEditorMixin, {
    tagEditorSessionId:'test', tagEditorPageItems:[], tagEditorSelected:[],
    _teFlushAllPendingTextEdits(){}, _updateEditorPanel(){},
    t:key=>({'tagEditor.selectedOutsidePage':'{n} selected / {outside} outside',
      'tagEditor.batchOutsidePage':'{n} outside'}[key] || key),
  });
  app.tagEditorPageItems=Array.from({length:5},(_,i)=>({path:'a'+i,tags:'  raw\r\n'}));
  return app;
}

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
