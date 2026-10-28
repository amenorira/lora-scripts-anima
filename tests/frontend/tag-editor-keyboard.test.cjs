const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTagEditor} = require('./helpers.cjs');

function fixture() {
  const context={window:{innerWidth:1200,innerHeight:800},document:{activeElement:null}};
  loadTagEditor(context);
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
