// Caption editing, stale confirmations, and undo/redo regressions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, deferred } = require('./helpers.cjs');

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

  loadFrontend(['tag-dictionary-lib', 'tag-dictionary', 'tag-editor'], context);

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

test('dropping in the same tag position preserves raw bytes, versions, drafts and history', () => {
  for (const [source, target, pos, raw] of [
    [0, 0, 'before'], [0, 0, 'after'], [0, 1, 'before'], [1, 0, 'after'], [1, null, 'after'],
    [0, 1, 'after', '\uFEFF  cat,  cat\r\n'],
  ]) {
    const {ctx, context} = draftClient();
    const original = raw || '\uFEFF  cat,  dog\r\n';
    ctx.tagEditorImages[0].tags = ctx.tagEditorOriginal.a = original;
    ctx._teEditVersions = {a: 7};
    context.localStorage.setItem('tagEditor_draft_/dataset', 'keep');
    ctx.tagEditorDetailDragSrcIdx = source; ctx.tagEditorDetailDragOverPos = pos;
    ctx.tagEditorDetailDrop({preventDefault() {}, target: {closest: () => target == null ? null : {dataset: {ti: String(target)}}}});
    assert.equal(ctx.tagEditorImages[0].tags, original);
    assert.equal(ctx._teEditVersions.a, 7);
    assert.equal(ctx.tagEditorHistory.length, 0);
    assert.equal(ctx.tagEditorModifiedCount(), 0);
    assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'), 'keep');
  }
});

test('a real reorder still records one step and restores exact original text on undo', () => {
  const {ctx} = draftClient();
  const original = '\uFEFF  cat,  dog\r\n';
  ctx.tagEditorImages[0].tags = ctx.tagEditorOriginal.a = original;
  ctx.tagEditorDetailDragSrcIdx = 0; ctx.tagEditorDetailDragOverPos = 'after';
  ctx.tagEditorDetailDrop({preventDefault() {}, target: {closest: () => ({dataset: {ti: '1'}})}});
  assert.equal(ctx.tagEditorImages[0].tags, 'dog, cat');
  assert.equal(ctx.tagEditorHistory.length, 1);
  ctx.tagEditorUndo(); assert.equal(ctx.tagEditorImages[0].tags, original);
  ctx.tagEditorRedo(); assert.equal(ctx.tagEditorImages[0].tags, 'dog, cat');
});

test('history excerpts preserve exact prefixes without changing raw history or splitting CRLF and emoji',()=>{
  const {ctx}=makeClient();
  const short='\uFEFF  原文， punctuation.\r\n\r\n  ';
  assert.equal(ctx._teHistoryTextExcerpt(short),short);
  for (const raw of [short.repeat(30),'x'.repeat(359)+'\r\nend','x'.repeat(359)+'🌸end']) {
    const diff=Object.freeze({beforeText:raw,afterText:raw+'\r\n  changed  '});
    const excerpt=ctx._teHistoryTextExcerpt(raw);
    assert.ok(raw.startsWith(excerpt));assert.ok(excerpt.length<=360);
    assert.equal(/[\uD800-\uDBFF]$/.test(excerpt),false);
    assert.equal(excerpt.endsWith('\r'),false);
    assert.equal(ctx._teHistoryTextTruncated(diff),true);
    assert.equal(diff.beforeText,raw);assert.equal(diff.afterText,raw+'\r\n  changed  ');
  }
  assert.equal(ctx._teHistoryTextTruncated({beforeText:short,afterText:''}),false);
  assert.equal(ctx._teHistoryTextExcerpt('1\r\n2\r3\n4\r\n5\n6\n7'),'1\r\n2\r3\n4\r\n5\n6');
});

test('autosaved edits undone to the baseline cannot reappear on the next visit; redo remains recoverable',()=>{
  const {ctx,context,tick}=draftClient();
  context.localStorage.setItem('tagEditor_draft_/other','keep');
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],'solo, flower');ctx._tePushHistory({type:'text'});
  tick();assert.ok(context.localStorage.getItem('tagEditor_draft_/dataset'));
  ctx.tagEditorUndo();
  assert.equal(ctx.tagEditorModifiedCount(),0);assert.equal(ctx.tagEditorModified,false);
  assert.equal(ctx._teDraftSavedAt,'');assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),null);
  assert.equal(context.localStorage.getItem('tagEditor_draft_/other'),'keep');
  const next=draftClient(context.localStorage);
  next.ctx.openConfirm=()=>assert.fail('undone changes must not prompt for recovery');next.ctx._teCheckDraft();
  ctx.tagEditorRedo();tick();
  const restored=draftClient(context.localStorage);let recover;
  restored.ctx.openConfirm=(_title,_message,action)=>{recover=action;};restored.ctx._teCheckDraft();recover();
  assert.equal(restored.ctx.tagEditorImages[0].tags,'solo, flower');assert.equal(restored.ctx.tagEditorModifiedCount(),1);
});

test('direct text reversion and legacy history checkpoints also retire a saved draft',()=>{
  for (const revert of ['text','checkpoint']) {
    const {ctx,context,tick}=draftClient();
    ctx._teUpdateImageTags(ctx.tagEditorImages[0],'changed');tick();
    if (revert==='text') ctx._teUpdateImageTags(ctx.tagEditorImages[0],'solo');
    else ctx._teApplyCheckpoint({});
    assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),null);
  }
});

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
  ctx.openConfirm=(_title,_message,action)=>{recover=action;};ctx._teCheckDraft();await recover();
  assert.equal(loaded,1);assert.equal(ctx._teFindByPath('b').tags,raw);
  assert.equal(ctx.tagEditorModifiedCount(),2);assert.equal(ctx.tagEditorHistory.length,1);
  tick();assert.equal(JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset')).items[1].revision,'r-b');
  ctx.tagEditorUndo();assert.equal(ctx._teFindByPath('b').tags,'old b');
  assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),null);
  ctx.tagEditorRedo();assert.equal(ctx._teFindByPath('b').tags,raw);
});

test('missing paths and revision conflicts survive recovery, autosave and clean edits', async () => {
  const {ctx,context,tick}=draftClient();ctx._teCaptionRevisions={a:'external'};
  const data=[{path:'a',tags:'my draft',original:'solo',revision:'old'}, {path:'missing',tags:'keep me',original:'old'}];
  context.localStorage.setItem('tagEditor_draft_/dataset',JSON.stringify(data));
  ctx._teEnsureAllImagesLoaded=async()=>{};
  let recover;ctx.openConfirm=(_title,_message,action)=>{recover=action;};ctx._teCheckDraft();await recover();
  assert.equal(ctx.tagEditorImages[0].tags,'solo');assert.equal(ctx._teDraftRemainder.length,2);
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],'new edit');tick();
  let stored=JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset'));
  assert.equal(stored.items[0].tags,'new edit');assert.equal(stored.pending[0].tags,'my draft');
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],'solo');
  stored=JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset'));
  assert.equal(stored.pending.length,2);assert.equal(stored.items.length,0);
});

test('stale draft confirmations and navigation during paging do not change the next dataset', async () => {
  for (const duringLoad of [false,true]) {
    const {ctx,context}=draftClient();
    const raw=JSON.stringify([{path:'b',tags:'draft b',original:'old b'}]);
    context.localStorage.setItem('tagEditor_draft_/dataset',raw);
    let recover,finish;ctx.openConfirm=(_title,_message,action)=>{recover=action;};
    ctx._teEnsureAllImagesLoaded=()=>new Promise(resolve=>{finish=resolve;});
    ctx._teCheckDraft();
    const request=duringLoad ? recover() : null;
    ctx._teLoadEpoch++;ctx.tagEditorDir=ctx.tagEditorLoadedDir='/other';
    ctx.tagEditorImages=[{path:'b',tags:'other'}];ctx.tagEditorOriginal={b:'other'};ctx._teRebuildPathIndex();
    if (duringLoad) {finish();await request;} else await recover();
    assert.equal(ctx.tagEditorImages[0].tags,'other');
    assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),raw);
  }
});

test('paging failure preserves the draft and an edit during paging is never overwritten', async () => {
  const {ctx,context}=draftClient();
  const raw=JSON.stringify([{path:'a',tags:'recovery',original:'solo'},{path:'b',tags:'draft b',original:'old b'}]);
  context.localStorage.setItem('tagEditor_draft_/dataset',raw);
  let recover;ctx.openConfirm=(_title,_message,action)=>{recover=action;};ctx._teCheckDraft();
  ctx._teEnsureAllImagesLoaded=async()=>{throw new Error('offline');};await recover();
  assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),raw);assert.equal(ctx._teDraftRestoreBusy,false);
  ctx._teEnsureAllImagesLoaded=async()=>{ctx._teUpdateImageTags(ctx.tagEditorImages[0],'typed meanwhile');};
  await recover();assert.equal(ctx.tagEditorImages[0].tags,'typed meanwhile');assert.equal(ctx._teDraftRemainder.length,2);
});

test('timeline failure before autosave retains the old baseline for recoverable undo', async () => {
  const {ctx,context}=draftClient();
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],'saved new');ctx._tePushHistory({type:'text'});
  context.fetch=async()=>({json:async()=>({status:'success',data:{saved:1,saved_paths:['a'],revisions:{a:'new-revision'},timeline_warning:'disk full'}})});
  ctx.tagEditorLoadSnapshots=()=>{};ctx.tagEditorReloadSessionPage=async()=>{};
  await ctx._doSaveAll(ctx.tagEditorImages);
  const stored=JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset'));
  assert.equal(stored.pending[0].original,'solo');assert.equal(stored.pending[0].tags,'saved new');
  const next=draftClient(context.localStorage);
  next.ctx.tagEditorImages[0].tags=next.ctx.tagEditorOriginal.a='saved new';
  next.ctx._teCaptionRevisions={a:'new-revision'};
  let recover;next.ctx.openConfirm=(_title,_message,action)=>{recover=action;};next.ctx._teCheckDraft();await recover();
  next.ctx.tagEditorUndo();assert.equal(next.ctx.tagEditorImages[0].tags,'solo');
  assert.equal(next.ctx.tagEditorModified,true);
});

test('edits and undo during a save remain dirty against the text actually written to disk', async () => {
  for (const action of ['undo', 'type']) {
    const {ctx,context}=draftClient();
    const original='\uFEFF  原文\r\n\r\n';
    const saved=original.replace('原文','已发送');
    const typed=original.replace('原文','继续输入');
    ctx.tagEditorImages[0].tags=ctx.tagEditorOriginal.a=original;
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
    assert.equal(ctx.tagEditorModified,true);
    const draft=JSON.parse(context.localStorage.getItem('tagEditor_draft_/dataset')).items[0];
    assert.equal(draft.tags,expected);assert.equal(draft.original,saved);assert.equal(draft.revision,'new-revision');
    const next=draftClient(context.localStorage);
    next.ctx.tagEditorImages[0].tags=next.ctx.tagEditorOriginal.a=saved;
    next.ctx._teCaptionRevisions={a:'new-revision'};
    let recover;next.ctx.openConfirm=(_title,_message,callback)=>{recover=callback;};
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

test('an old save response cannot clear the next dataset save state', async () => {
  const {ctx,context}=draftClient();
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],'new');
  let finish;context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const request=ctx._doSaveAll(ctx.tagEditorImages);
  ctx._teLoadEpoch++;ctx._teSaveEpoch++;ctx.tagEditorDir=ctx.tagEditorLoadedDir='/other';
  ctx._teIsSaving=ctx.tagEditorSaving=true;ctx._teSaveProgress=42;
  finish({json:async()=>({status:'success',data:{saved:1,saved_paths:['a']}})});
  await request;
  assert.equal(ctx._teIsSaving,true);assert.equal(ctx.tagEditorSaving,true);assert.equal(ctx._teSaveProgress,42);
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

test('archive and rollback failures preserve history and never report archived success', async () => {
  for (const failure of ['timeline', 'rollback']) {
    const { ctx, context } = makeClient();
    const notices = [];
    ctx.toast = message => notices.push(message);
    ctx.tagEditorDir = ctx.tagEditorLoadedDir = '/dataset';
    ctx.tagEditorImages = [{ path: 'a', tags: 'new' }];
    ctx.tagEditorOriginal = { a: 'old' };
    ctx.tagEditorHistory = [{ changes: { a: { before: null, after: 'new' } } }];
    ctx.tagEditorHistoryIdx = 0;
    ctx._teRecountModified = () => { ctx._teModifiedCount = failure === 'timeline' ? 0 : 1; };
    ctx._teSaveDraft = () => {};
    ctx._teRemoveDraft = () => assert.fail('failure must not discard the recovery draft');
    ctx.tagEditorLoadSnapshots = () => {};
    ctx.tagEditorReloadSessionPage = async () => {};
    context.fetch = async () => ({ json: async () => ({ status: 'success', data: failure === 'timeline'
      ? { saved: 1, saved_paths: ['a'], timeline_warning: 'disk full' }
      : { saved: 0, rollback_failed: ['a'], failed: [{ path: 'a' }] } }) });
    await ctx._doSaveAll(ctx.tagEditorImages);
    assert.equal(ctx.tagEditorHistory.length, 1);
    assert.equal(notices.length, 1);
    assert.equal(notices[0], failure === 'timeline' ? 'tagEditor.timelineSaveFailed' : 'tagEditor.rollbackFailed');
    if (failure === 'timeline') {
      assert.equal(ctx.tagEditorOriginal.a, 'new');
      assert.equal(ctx.tagEditorHistory[0].changes.a.before, 'old');
    }
  }
});

test('no-op history updates preserve redo and edits after undo start a new step', () => {
  const { ctx } = makeClient();
  ctx._teInvalidateDiff = () => {};
  ctx.tagEditorOriginal = { a: 'solo' };
  ctx._teHistoryState = { a: 'solo, flower' };
  ctx._teGetModified = () => [{ path: 'a', tags: 'solo, flower' }];
  ctx.tagEditorHistory = [
    { meta: { type: 'add' }, changes: { a: { before: null, after: 'solo, flower' } }, _ts: Date.now() },
    { meta: { type: 'add' }, changes: { a: { before: 'solo, flower', after: 'solo, flower, hat' } }, _ts: Date.now() },
  ];
  ctx.tagEditorHistoryIdx = 0;
  ctx._tePushHistory({ type: 'add' });
  assert.equal(ctx.tagEditorHistory.length, 2);
  ctx._teGetModified = () => [{ path: 'a', tags: 'solo, flower, shoes' }];
  ctx._tePushHistory({ type: 'add' });
  assert.equal(ctx.tagEditorHistory.length, 2);
  assert.equal(ctx.tagEditorHistory[0].changes.a.after, 'solo, flower');
  assert.equal(ctx.tagEditorHistoryIdx, 1);
});

test('timeline restore refuses unsaved edits and stale dataset confirmations', () => {
  const { ctx } = makeClient();
  ctx._teFlushAllPendingTextEdits = () => {};
  let confirm;
  ctx.openConfirm = (title, text, action) => { confirm = action; };
  ctx.tagEditorModified = true;
  ctx.tagEditorRestoreSnapshot('event');
  assert.equal(confirm, undefined);
  ctx.tagEditorModified = false;
  ctx.tagEditorRestoreSnapshot('event');
  assert.equal(typeof confirm, 'function');
  ctx._teLoadEpoch++;
  confirm();
  assert.equal(ctx.tagEditorSnapshotBusy, false);
});

test('legacy backup restore protects unsaved text, history and recovery drafts',()=>{
  const {ctx,context,tick}=draftClient();
  const raw='\uFEFF  未保存正文\r\n\r\n  ';
  ctx._teUpdateImageTags(ctx.tagEditorImages[0],raw);ctx._tePushHistory({type:'text'});tick();
  const draft=context.localStorage.getItem('tagEditor_draft_/dataset');
  const history=JSON.stringify(ctx.tagEditorHistory);
  ctx.openConfirm=()=>assert.fail('dirty captions must not offer destructive restore');
  ctx.tagEditorRestoreBackup();
  assert.equal(ctx.tagEditorImages[0].tags,raw);
  assert.equal(JSON.stringify(ctx.tagEditorHistory),history);
  assert.equal(context.localStorage.getItem('tagEditor_draft_/dataset'),draft);
});

test('backup confirmation rechecks edits, saves and the dataset before submitting',()=>{
  for(const change of ['edit','save','dataset']) {
    const {ctx}=makeClient();let accept;
    ctx.openConfirm=(_title,_message,action)=>{accept=action;};
    ctx.tagEditorRestoreBackup();assert.equal(typeof accept,'function');
    if(change==='edit') ctx.tagEditorModified=true;
    if(change==='save') ctx._teIsSaving=true;
    if(change==='dataset') ctx._teLoadEpoch++;
    accept();assert.equal(ctx.tagEditorSnapshotBusy,false);
  }
});

test('backup responses cannot reload a newer dataset or release its busy state',async()=>{
  const {ctx,context}=makeClient();const pending=deferred();let accept,request;
  ctx.tagEditorLoadedDir='/dataset';ctx.tagEditorDir='/uncommitted-path';
  ctx.openConfirm=(_title,_message,action)=>{accept=action;};
  ctx.tagEditorLoad=()=>assert.fail('stale backup response must not reload');
  context.fetch=(url,options)=>{request={url,...options};return pending.promise;};
  ctx.tagEditorRestoreBackup();const operation=accept();
  assert.equal(ctx.tagEditorSnapshotBusy,true);
  assert.equal(request.url,'/api/tageditor/restore-backup');
  assert.deepEqual(JSON.parse(request.body),{dir:'/dataset'});
  ctx._teLoadEpoch++;ctx.tagEditorLoadedDir='/new-dataset';
  pending.resolve({json:async()=>({status:'success'})});await operation;
  assert.equal(ctx.tagEditorSnapshotBusy,true);
});

test('backup failure releases busy state, preserves history and allows retry',async()=>{
  const {ctx,context}=makeClient();let accept;const notices=[];
  ctx.tagEditorHistory=[{changes:{a:{before:'old',after:'new'}}}];ctx.tagEditorHistoryIdx=-1;
  const history=JSON.stringify(ctx.tagEditorHistory);
  ctx.openConfirm=(_title,_message,action)=>{accept=action;};ctx.toast=msg=>notices.push(msg);
  ctx.tagEditorLoad=()=>assert.fail('failed restore must not reload');
  context.fetch=async()=>{throw new Error('offline');};
  ctx.tagEditorRestoreBackup();await accept();
  assert.equal(ctx.tagEditorSnapshotBusy,false);assert.equal(JSON.stringify(ctx.tagEditorHistory),history);
  assert.deepEqual(notices,['offline']);
});

test('removing bracket escapes changes only selected captions and supports undo and redo', () => {
  const { ctx } = makeClient();
  const raw = String.raw`star \(symbol\),  custom\name, foo \\(bar\\)`;
  ctx.tagEditorImages = [{ path: 'a', name: 'a', tags: raw }, { path: 'b', name: 'b', tags: raw }, { path: 'c', name: 'c', tags: 'solo' }];
  ctx.tagEditorOriginal = { a: raw, b: raw, c: 'solo' };
  ctx.tagEditorSelected = ['a', 'c'];
  ctx.tagEditorHistory = [];
  ctx.tagEditorHistoryIdx = -1;
  ctx._teHistoryState = {};
  ctx._teModifiedCount = 0;
  ctx._teInvalidateFilter = () => {};
  ctx._teInvalidateDiff = () => {};
  ctx._teUpdateFreq = () => {};
  ctx._updateEditorPanel = () => {};
  let apply;
  ctx._teConfirmBatch = (message, callback) => { apply = callback; };
  ctx.tagEditorRemoveBracketEscapes();
  assert.equal(ctx.tagEditorImages[0].tags, raw);
  apply();
  assert.equal(ctx.tagEditorImages[0].tags, String.raw`star (symbol),  custom\name, foo (bar)`);
  assert.equal(ctx.tagEditorImages[1].tags, raw);
  assert.equal(ctx.tagEditorHistory.length, 1);
  assert.equal(ctx.tagEditorHistory[0].meta.affected, 1);
  assert.equal(ctx.tagEditorModifiedCount(), 1);
  ctx.tagEditorUndo();
  assert.equal(ctx.tagEditorImages[0].tags, raw);
  assert.equal(ctx.tagEditorModifiedCount(), 0);
  ctx.tagEditorRedo();
  assert.equal(ctx.tagEditorImages[0].tags, String.raw`star (symbol),  custom\name, foo (bar)`);
  apply = null;
  ctx.tagEditorRemoveBracketEscapes();
  assert.equal(apply, null);
});

test('bracket cleanup refuses a confirmation after captions or dataset change', () => {
  for (const changed of ['caption', 'dataset']) {
    const { ctx } = makeClient();
    ctx.tagEditorImages = [{ path: 'a', tags: String.raw`star \(symbol\)` }];
    ctx.tagEditorSelected = ['a'];
    let apply;
    ctx._teConfirmBatch = (message, callback) => { apply = callback; };
    ctx._teUpdateImageTags = () => assert.fail('stale confirmation must not modify captions');
    ctx.tagEditorRemoveBracketEscapes();
    if (changed === 'caption') ctx.tagEditorImages[0].tags = 'new caption';
    else ctx._teLoadEpoch++;
    apply();
  }
});
