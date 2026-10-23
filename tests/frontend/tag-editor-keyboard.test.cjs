const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend} = require('./helpers.cjs');

function fixture() {
  const context={window:{innerWidth:1200,innerHeight:800},document:{activeElement:null}};
  loadFrontend('tag-editor.js',context);
  const callbacks=[];
  const app=Object.assign({},context.window.tagEditorMixin,{
    currentRoute:'tagEditor',tagEditorSelected:['a'],tagDictionaryCloseHover(){},$nextTick:cb=>callbacks.push(cb),
  });
  const element=(visible=true,disabled=false)=>({disabled,isConnected:true,
    getClientRects:()=>visible?[{}]:[],focus(){context.document.activeElement=this;}});
  const trigger=element();trigger.closest=selector=>selector==='[tabindex], button'||selector==='.te-editor-preview'?trigger:null;
  trigger.getBoundingClientRect=()=>({left:100,bottom:100});
  const hidden=element(false),disabled=element(true,true),first=element(),last=element();
  const menu=element();menu.querySelectorAll=()=>[hidden,disabled,first,last];
  context.document.getElementById=()=>menu;
  const open=()=>app.tagEditorPanelContext({target:trigger,currentTarget:trigger,preventDefault(){},stopPropagation(){}});
  const flush=()=>{while(callbacks.length) callbacks.shift()();};
  return {app,context,trigger,menu,first,last,open,flush};
}

test('context menu focuses visible enabled actions and Escape restores its trigger',()=>{
  const f=fixture();f.open();f.flush();
  assert.equal(f.context.document.activeElement,f.first);
  f.app.tagEditorPanelMenuKeydown({currentTarget:f.menu,key:'ArrowUp',preventDefault(){},stopPropagation(){}});
  assert.equal(f.context.document.activeElement,f.last);
  f.app.tagEditorClosePanelMenu();f.flush();
  assert.equal(f.context.document.activeElement,f.trigger);
});

test('outside dismissal and stale menu callbacks cannot steal focus',()=>{
  const f=fixture();f.open();f.app.tagEditorClosePanelMenu(false);f.flush();
  assert.equal(f.context.document.activeElement,null);
  f.open();f.flush();f.app.tagEditorClosePanelMenu();f.app._teLoadEpoch++;f.flush();
  assert.equal(f.context.document.activeElement,f.first);
});

test('closing the compact sidebar consumes Escape without clearing selection or stealing stale focus',()=>{
  const f=fixture();
  const event={key:'Escape',defaultPrevented:false,stopped:false,
    preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;}};
  f.app.tagEditorCloseSidebar(event);f.app.tagEditorHandleKeydown(event);f.flush();
  assert.equal(event.stopped,true);assert.equal(f.app.tagEditorLeftCollapsed,true);
  assert.deepEqual(f.app.tagEditorSelected,['a']);assert.equal(f.context.document.activeElement,f.menu);
  f.app.tagEditorLeftCollapsed=false;f.context.document.activeElement=null;
  f.app.tagEditorCloseSidebar({isComposing:true});
  assert.equal(f.app.tagEditorLeftCollapsed,false);
  f.app.tagEditorCloseSidebar();f.app._teLoadEpoch++;f.flush();
  assert.equal(f.context.document.activeElement,null);
});

test('menu activation and horizontal arrows stay within the menu without blocking native activation',()=>{
  for (const key of ['Enter',' ','ArrowLeft','ArrowRight']) {
    const f=fixture();f.open();f.flush();
    let stopped=false,prevented=false;
    f.app.tagEditorPanelMenuKeydown({currentTarget:f.menu,key,
      preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
    assert.equal(stopped,true);assert.equal(prevented,false);
    assert.equal(f.context.document.activeElement,f.first);
  }
});

test('Enter activates focused controls while blank-space Enter still starts caption editing',()=>{
  for (const nativeControl of [true,false]) {
    const f=fixture();let focusCount=0,prevented=false;
    f.app._teFocusEditorInput=()=>{focusCount++;return true;};
    const target={closest(selector){return nativeControl && selector.includes('summary') ? this : null;}};
    f.app.tagEditorHandleKeydown({key:'Enter',target,preventDefault(){prevented=true;}});
    assert.equal(focusCount,nativeControl?0:1);
    assert.equal(prevented,!nativeControl);
  }
});
