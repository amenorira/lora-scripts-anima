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

test('dataset selection ignores filters while filtered selection keeps them', async () => {
  const app = fixture();
  const calls = [];
  app._teFetchAllSessionItems = async filtered => {
    calls.push(filtered);
    return filtered ? [{path:'a1'}] : [{path:'a0'}, {path:'a1'}, {path:'other'}];
  };
  app.tagEditorSearchQuery = 'a1';
  await app.tagEditorSelectFiltered();
  assert.deepEqual(Array.from(app.tagEditorSelected), ['a1']);
  await app.tagEditorSelectDataset();
  assert.deepEqual(Array.from(app.tagEditorSelected), ['a0', 'a1', 'other']);
  assert.deepEqual(calls, [true, false]);
  assert.equal(app.tagEditorSearchQuery, 'a1');
});

test('unfiltered selection without a session uses all available images', async () => {
  const app = fixture();
  app.tagEditorSessionId = '';
  app.tagEditorImages = [{path:'a', name:'match', tags:''}, {path:'b', name:'other', tags:''}, {path:'gone', _teMissingOnDisk:true}];
  app.tagEditorSearchQuery = 'match';
  const all = await app._teFetchAllSessionItems(false);
  assert.deepEqual(Array.from(all, image => image.path), ['a', 'b']);
});
