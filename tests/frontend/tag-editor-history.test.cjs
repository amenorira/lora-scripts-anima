// Caption editing, stale confirmations, and undo/redo regressions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, loadTagEditor, deferred } = require('./helpers.cjs');

// Caption edits and history need an isolated editor, without a dictionary worker.

function makeClient() {
  const context = { window: {} };
  context.window = context;
  context.console = { warn() {} };
  context.setTimeout = (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; };
  context.clearTimeout = clearTimeout;
  context.fetch = () => { throw new Error('Caption history must not access the network'); };
  context.localStorage = { _v: {}, getItem(k) { return k in this._v ? this._v[k] : null; }, setItem(k, v) { this._v[k] = String(v); }, removeItem(k) { delete this._v[k]; } };
  context.navigator = { clipboard: { writeText() { return Promise.resolve(); } } };

  loadFrontend(['tag-dictionary/lib', 'tag-dictionary/index'], context);
  loadTagEditor(context);

  const ctx = Object.assign({}, context.window.tagEditorMixin, context.window.tagDictionaryMixin);
  ctx.locale = 'zh-CN';
  ctx.toast = () => {};
  ctx.t = key => key;
  ctx.tagEditorGetSelectedTags = () => [];
  ctx.tagEditorTagSelection = [];
  ctx.tagEditorExcludedTags = [];
  ctx.tagEditorSchedulePageFetch = () => {};
  ctx._teInvalidateFilter = () => {};
  ctx.tagEditorSidebarTab = 'tags';
  ctx.tagEditorSearchQuery = '';
  ctx.tagEditorSuggestions = [];
  ctx._teSuggestSeq = 0;
  ctx.$nextTick = callback => callback();
  context.innerWidth = 1280;
  context.innerHeight = 900;

  ctx.currentRoute = 'tagEditor';

  return { ctx, context };
}

function draftClient(storage) {
  const {ctx,context}=makeClient();
  if (storage) context.localStorage=storage;
  ctx.tagEditorDir=ctx.tagEditorLoadedDir='/dataset';
  ctx.tagEditorImages=[{path:'a',tags:'solo'}];ctx.tagEditorOriginal={a:'solo'};
  ctx.tagEditorSelected=['a'];ctx._teModifiedCount=0;ctx._teHistoryState={};
  ctx.tagEditorHistory=[];ctx.tagEditorHistoryIdx=-1;
  ctx._teInvalidateDiff=ctx._teUpdateFreq=ctx._updateEditorPanel=ctx.tagDictionarySyncChips=()=>{};
  let autosave;
  context.setInterval=(callback,delay)=>{assert.equal(delay,30000);autosave=callback;return 1;};
  context.clearInterval=()=>{};
  ctx._teStartAutoSave();
  return {ctx,context,tick:()=>autosave()};
}

test('draft recovery loads missing pages, preserves raw text and supports undo/redo', async () => {
  const {ctx,context,tick}=draftClient();
  ctx._teCaptionRevisions={a:'r-a'};
  ctx._teEditVersions={};
  const raw='  跨页,  描述\r\n\r\n末段  \r\n';
  context.localStorage.setItem('tagEditor_draft_/dataset',JSON.stringify({version:2,items:[
    {path:'a',tags:'new a',original:'solo',revision:'r-a'},
    {path:'b',tags:raw,original:'old b',revision:'r-b'}
  ],pending:[]}));
  let loaded=0, recover;
  ctx._teEnsureAllImagesLoaded=async()=>{
    loaded++;ctx._teMergeSessionItems([{path:'b',tags:'old b',caption_revision:'r-b'}],false);
  };
  ctx.openConfirm=({onConfirm:action})=>{recover=action;};ctx._teCheckDraft();await recover();
  assert.equal(loaded,1);assert.equal(ctx._teFindByPath('b').tags,raw);
  assert.equal(ctx.tagEditorModifiedCount(),2);assert.equal(ctx.tagEditorHistory.length,1);
  tick();assert.equal(JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset')).items[1].revision,'r-b');
  ctx.tagEditorUndo();assert.equal(ctx._teFindByPath('b').tags,'old b');
  assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),null);
  ctx.tagEditorRedo();assert.equal(ctx._teFindByPath('b').tags,raw);
});

test('edits and undo during a save remain dirty against the text actually written to disk', async () => {
  for (const action of ['undo', 'type']) {
    const {ctx,context}=draftClient();
    const original='\uFEFF  原文\r\n\r\n';
    const saved=original.replace('原文','已发送');
    const typed=original.replace('原文','继续输入');
    ctx.tagEditorImages[0].tags=ctx.tagEditorOriginal.a=original;
    ctx._teSessionTags=[{tag:'原文',count:1}];
    ctx._teCaptionRevisions={a:'old-revision'};
    ctx._teUpdateImageTags(ctx.tagEditorImages[0],saved);ctx._tePushHistory({type:'text'});
    let finish;
    context.fetch=()=>new Promise(resolve=>{finish=resolve;});
    ctx.tagEditorLoadSnapshots=()=>{};
    ctx.tagEditorReloadSessionPage=()=>assert.fail('unsaved edits must not be reloaded');
    const request=ctx._doSaveAll(ctx.tagEditorImages);
    if (action==='undo') ctx.tagEditorUndo();
    else {ctx.tagEditorDetailText=typed.replace(/\r\n/g,'\n');ctx.tagEditorDetailTextChange();}
    finish({json:async()=>({status:'success',data:{saved:1,saved_paths:['a'],revisions:{a:'new-revision'}}})});
    await request;
    const expected=action==='undo' ? original : typed;
    assert.equal(ctx.tagEditorImages[0].tags,expected);
    assert.equal(ctx.tagEditorOriginal.a,saved);
    assert.deepEqual(Array.from(ctx._teSessionTags, item => [item.tag, item.count]), [['已发送',1]]);
    assert.equal(ctx.tagEditorModified,true);
    const draft=JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset')).items[0];
    assert.equal(draft.tags,expected);assert.equal(draft.original,saved);assert.equal(draft.revision,'new-revision');
    const next=draftClient(context.localStorage);
    next.ctx.tagEditorImages[0].tags=next.ctx.tagEditorOriginal.a=saved;
    next.ctx._teCaptionRevisions={a:'new-revision'};
    let recover;next.ctx.openConfirm=({onConfirm:callback})=>{recover=callback;};
    next.ctx._teCheckDraft();await recover();
    assert.equal(next.ctx.tagEditorImages[0].tags,expected);
    next.ctx.tagEditorUndo();assert.equal(next.ctx.tagEditorImages[0].tags,saved);
    if (action==='undo') {
      ctx.tagEditorRedo();assert.equal(ctx.tagEditorImages[0].tags,saved);assert.equal(ctx.tagEditorModified,false);
      ctx.tagEditorUndo();assert.equal(ctx.tagEditorImages[0].tags,original);assert.equal(ctx.tagEditorModified,true);
    } else {
      ctx.tagEditorUndo();assert.equal(ctx.tagEditorImages[0].tags,original);
      ctx.tagEditorRedo();assert.equal(ctx.tagEditorImages[0].tags,typed);
    }
  }
});

test('repeated save commands share one in-flight request', async () => {
  const {ctx,context}=draftClient();
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],'new');
  let finish,calls=0;
  context.fetch=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  ctx.tagEditorLoadSnapshots=()=>{};ctx.tagEditorReloadSessionPage=async()=>{};
  const request=ctx._doSaveAll(ctx.tagEditorImages);
  ctx.tagEditorSaveAll();ctx._doSaveAll(ctx.tagEditorImages);
  assert.equal(calls,1);assert.equal(ctx._teIsSaving,true);
  finish({json:async()=>({status:'success',data:{saved:1,saved_paths:['a']}})});
  await request;assert.equal(ctx._teIsSaving,false);
});

test('a save confirmation from a previous dataset cannot submit its captions', () => {
  const {ctx,context}=draftClient();
  ctx.tagEditorImages=Array.from({length:6},(_,i)=>({path:String(i),tags:'new'}));
  ctx.tagEditorOriginal={};
  let confirm,calls=0;ctx._teConfirmBatch=(_message,callback)=>{confirm=callback;};
  context.fetch=()=>{calls++;return new Promise(()=>{});};
  ctx.tagEditorSaveAll();
  ctx._teLoadEpoch++;ctx.tagEditorDir=ctx.tagEditorLoadedDir='/other';
  confirm();assert.equal(calls,0);assert.equal(ctx._teIsSaving,false);
});

test('idle autosave preserves a deferred recovery draft and save failures preserve edited content',async()=>{
  const {ctx,context,tick}=draftClient();
  const pending=JSON.stringify([{path:'a',tags:'recover me',original:'solo'}]);
  context.localStorage.setItem('tagEditor_draft_/dataset',pending);
  ctx.openConfirm=()=>{};ctx._teCheckDraft();tick();
  assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),pending);
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],'new edit');tick();
  context.fetch=async()=>{throw new Error('offline');};
  await ctx._doSaveAll(ctx.tagEditorImages);
  assert.equal(JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset')).items[0].tags,'new edit');
  assert.equal(ctx.tagEditorModified,true);
});

test('backup failure releases busy state, preserves history and allows retry',async()=>{
  const {ctx,context}=makeClient();let accept;const notices=[];
  ctx.tagEditorHistory=[{changes:{a:{before:'old',after:'new'}}}];ctx.tagEditorHistoryIdx=-1;
  const history=JSON.stringify(ctx.tagEditorHistory);
  ctx.openConfirm=({onConfirm:action})=>{accept=action;};ctx.toast=msg=>notices.push(msg);
  ctx.tagEditorLoad=()=>assert.fail('failed restore must not reload');
  context.fetch=async()=>{throw new Error('offline');};
  ctx.tagEditorRestoreBackup();await accept();
  assert.equal(ctx.tagEditorSnapshotBusy,false);assert.equal(JSON.stringify(ctx.tagEditorHistory),history);
  assert.deepEqual(notices,['offline']);
});
