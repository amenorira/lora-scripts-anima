const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {loadFrontend}=require('./helpers.cjs');
const {uiHarness}=require('./ui-helpers.cjs');

function fixture(kind) {
  const f=uiHarness();loadFrontend('tag-editor',f.context);
  f.document.body.classList.remove=name=>f.document.body.classList.toggle(name,false);
  const trigger=new f.Element('button'),dialog=new f.Element('dialog');
  dialog.id=kind==='lightbox'?'teLightbox':'help';
  const first=new f.Element('button'),last=new f.Element('button'),hidden=new f.Element('button');
  first.setAttribute('data-dialog-autofocus','');hidden.hidden=true;
  dialog.append(first,last,hidden);f.document.body.append(trigger,dialog);trigger.focus();
  const raw='\uFEFF  original\r\n\r\n  ';
  const app=Object.assign({},f.context.window.tagEditorMixin,{
    currentRoute:'tagEditor',tagEditorSelected:['a','b'],tagEditorImages:[{path:'a',tags:raw}],
    tagEditorHistory:[{desc:'history'}],_teFlushAllPendingTextEdits(){},_updateEditorPanel(){},
    _teLoadLightboxImage(img){this.tagEditorLightboxImage=img;},
    tagEditorSelectAll(){assert.fail('background selection');},tagEditorSaveAll(){assert.fail('background save');},
    tagEditorUndo(){assert.fail('background undo');},tagEditorRedo(){assert.fail('background redo');},
    tagEditorCopySelectedTags(){assert.fail('background copy');},tagEditorPasteTagsToSelected(){assert.fail('background paste');},
    tagEditorCanNavDetail:()=>true,tagEditorLightboxNav(dir){this.navigated=dir;},
  });
  const binding=f.context.window.AnimaUI.bindDialog(dialog,cb=>f.ticks.push(cb));
  const close=()=>{if(kind==='lightbox')app.tagEditorCloseLightbox();else app.tagEditorShortcutsOpen=false;binding.setOpen(false);};
  dialog.addEventListener('dialog-close',close);
  const open=()=>{if(kind==='lightbox')app.tagEditorOpenLightbox(app.tagEditorImages[0],trigger);else app.tagEditorOpenShortcuts({currentTarget:trigger});binding.setOpen(true);};
  const key=(key,extra={})=>{const {event}=dialog.fire('keydown',{key,target:f.document.activeElement,...extra});if(!event.stopped)app.tagEditorHandleKeydown(event);return event;};
  return {...f,app,dialog,trigger,first,last,binding,open,close,key,raw};
}

test('tag editor dialogs reuse native focus containment, autofocus and Escape restoration',()=>{
  for(const kind of ['lightbox','help']) {
    const f=fixture(kind);f.open();f.flush();
    assert.equal(f.dialog.open,true);assert.equal(f.document.activeElement,f.first);
    f.key('Tab',{shiftKey:true});assert.equal(f.document.activeElement,f.last);
    f.key('Tab');assert.equal(f.document.activeElement,f.first);
    for(const key of ['a','s','z','c','v'])f.key(key,{ctrlKey:true});
    f.key('z',{ctrlKey:true,shiftKey:true});
    if(kind==='lightbox'){f.key('ArrowRight');assert.equal(f.app.navigated,1);}
    f.key('Escape');f.flush();assert.equal(f.dialog.open,false);
    assert.equal(f.document.activeElement,f.trigger);
    assert.deepEqual(f.app.tagEditorSelected,['a','b']);
    assert.equal(f.app.tagEditorImages[0].tags,f.raw);assert.equal(f.app.tagEditorHistory[0].desc,'history');
  }
});

test('closing before autofocus cancels the old dialog opening and hidden triggers use a safe fallback',()=>{
  const f=fixture('help');f.open();f.close();f.flush();assert.equal(f.dialog.open,false);
  f.open();f.flush();f.trigger.hidden=true;
  const main=new f.Element('main');main.setAttribute('id','mainContent');f.document.body.append(main);
  f.close();f.flush();assert.equal(f.document.activeElement,main);
});

test('help isolates background shortcuts before the native dialog has opened',()=>{
  const f=fixture('help');f.open();
  f.app.tagEditorHandleKeydown({key:'a',ctrlKey:true,target:f.trigger});
  assert.deepEqual(f.app.tagEditorSelected,['a','b']);
});

test('production lightbox and help bind the shared native-dialog behavior',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../../frontend/index.html'),'utf8');
  for(const flag of ['tagEditorLightboxOpen','tagEditorShortcutsOpen']) {
    const dialog=html.match(new RegExp('<dialog[^>]*x-dialog="'+flag+'"[\\s\\S]*?</dialog>'))?.[0];
    assert.ok(dialog);assert.match(dialog,/@dialog-close=/);assert.match(dialog,/data-dialog-autofocus/);
  }
});
