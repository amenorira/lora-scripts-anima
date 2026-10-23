const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend} = require('./helpers.cjs');

function fixture() {
  const context={window:{matchMedia:()=>({matches:false})},
    getComputedStyle:()=>({columnGap:'8px',paddingLeft:'8px',paddingRight:'8px'})};
  loadFrontend('tag-editor.js',context);
  return {app:Object.assign({},context.window.tagEditorMixin),context};
}

test('narrowing and restoring the window fits panels without overwriting preferred widths',()=>{
  const {app}=fixture();app.tagEditorLeftWidth=420;app.tagEditorRightWidth=520;
  for(const width of [1252,1092,1013,1092,1252]) {
    app._teLayoutWidth=width;
    const layout=app.tagEditorPanelLayout();
    assert.ok(width-layout.left-layout.right-16>=200);
    assert.ok(layout.left>=180 && layout.right>=280);
    assert.equal(app.tagEditorLeftWidth,420);assert.equal(app.tagEditorRightWidth,520);
  }
  assert.equal(app.tagEditorPanelLayout().left,420);
  assert.equal(app.tagEditorPanelLayout().right,520);
});

test('an overlay or collapsed sidebar does not consume the image column budget',()=>{
  const {app}=fixture();app._teLayoutWidth=800;app.tagEditorRightWidth=520;app.tagEditorLeftWidth=420;
  for(const state of ['tagEditorCompactLayout','tagEditorLeftCollapsed']) {
    app[state]=true;assert.equal(app.tagEditorPanelLayout().right,520);app[state]=false;
  }
});

test('cards shrink to fit the visible column at its lower bound',()=>{
  const {app}=fixture();let size;
  app._teUpdateGridCardSize({clientWidth:126,style:{setProperty:(_name,value)=>{size=parseInt(value);}}});
  assert.equal(size,110);
});
