const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function fixture(raw = '  原文,  with commas\r\n\r\n末段  \r\n') {
  const context = { window: {}, setTimeout, clearTimeout };
  loadFrontend('tag-editor.js', context);
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorImages: [{ path: 'a', tags: raw }], tagEditorOriginal: { a: raw }, tagEditorSelected: ['a'],
    tagEditorHistory: [], _teHistoryState: {}, _teEditVersions: {}, _tePendingTextEdits: {},
    _teInvalidateFilter() {}, _teInvalidateDiff() {}, _teUpdateFreq() {}, tagDictionarySyncChips() {},
    _teRemoveDraft() {}, _updateEditorPanel() {}, t: key => key, toast() {},
    tagEditorSchedulePageFetch() {},
  });
  return { app, context };
}

test('textarea input preserves raw whitespace, BOM and CRLF through undo and redo', () => {
  const raw = '\uFEFF  原文,  with commas\r\n\r\n末段  \r\n';
  const { app } = fixture(raw);
  app.tagEditorDetailText = raw.replace(/\r\n/g, '\n').replace('末段', '修改后的段落');
  app.tagEditorDetailTextChange();
  app._teFlushAllPendingTextEdits();
  const edited = raw.replace('末段', '修改后的段落');
  assert.equal(app.tagEditorImages[0].tags, edited);
  app.tagEditorUndo();
  assert.equal(app.tagEditorImages[0].tags, raw);
  app.tagEditorRedo();
  assert.equal(app.tagEditorImages[0].tags, edited);
});

test('description mode protects prose from tag entry points and does not change text or redo', async () => {
  const { app } = fixture();
  const raw = app.tagEditorImages[0].tags;
  app.tagEditorDetailText = raw.replace('原文', '编辑'); app.tagEditorDetailTextChange();
  app.tagEditorSetWorkMode('text');
  assert.equal(app.tagEditorHistory.length, 1);
  app.tagEditorUndo();
  for (const action of ['tagEditorAddTagToSelected', 'tagEditorRemoveTagFromSelected', 'tagEditorPasteTagsToSelected',
    'tagEditorApplyQuickRemove', 'tagEditorDetailDrop', 'tagEditorCtxAddAll', 'tagEditorCtxDeleteTag',
    'tagEditorFinishInlineEdit', 'tagEditorRemoveBracketEscapes']) await app[action]('原文');
  app.batchAddInput = 'bad'; app.tagEditorBatchAdd();
  app.batchRemoveInput = '原文'; app.tagEditorBatchRemove();
  app.batchOldTag = '原文'; app.batchNewTag = 'bad'; app.tagEditorBatchReplace();
  assert.equal(app.tagEditorImages[0].tags, raw);
  assert.equal(app.tagEditorDetailView, 'text');
  assert.equal(app.tagEditorGetSelectedTags().length, 0);
  assert.equal(app.tagEditorGetSelectedStats().length, 0);
  app.tagEditorSetDetailView('chip'); assert.equal(app.tagEditorDetailView, 'text');
  app.tagEditorSetWorkMode('tags'); app.tagEditorSetDetailView('text');
  assert.equal(app.tagEditorAllowsTagOps(), true);
  app.tagEditorRedo(); assert.equal(app.tagEditorImages[0].tags, raw.replace('原文', '编辑'));
});

test('mode is remembered per directory and stale tag confirmations cannot mutate descriptions', () => {
  const { app, context } = fixture('solo');
  const values = new Map();
  context.localStorage = {getItem: k => values.get(k), setItem: (k,v) => values.set(k,v)};
  app.tagEditorLoadedDir = '/descriptions'; app.tagEditorSetWorkMode('text');
  app._teRestoreWorkMode('/tags'); assert.equal(app.tagEditorWorkMode, 'tags');
  app._teRestoreWorkMode('/descriptions'); assert.equal(app.tagEditorWorkMode, 'text');
  app._teRestoreWorkMode('/tags', 'text'); assert.equal(values.get('tagEditor_mode_/tags'), 'text');
  app.tagEditorSetWorkMode('tags');
  let confirm;
  app._teConfirmBatch = (_msg, cb) => {confirm = cb;};
  app.batchAddInput = 'flower'; app.tagEditorBatchAdd();
  app.tagEditorSetWorkMode('text'); app.tagEditorSetWorkMode('tags');
  confirm(); assert.equal(app.tagEditorImages[0].tags, 'solo');
});

test('normalized textarea no-op creates no edit and mixed line endings survive local changes', () => {
  const raw = 'first\r\nsecond\nthird\rfourth\r\n';
  const { app } = fixture(raw);
  app.tagEditorDetailText = raw.replace(/\r\n|\r/g, '\n');
  app.tagEditorDetailTextChange(); app._teFlushAllPendingTextEdits();
  assert.equal(app.tagEditorImages[0].tags, raw);
  assert.equal(app.tagEditorModified, false);
  assert.equal(app.tagEditorHistory.length, 0);
  app.tagEditorDetailText = 'first\nsecond\ninserted\nthird\nfourth\n';
  app.tagEditorDetailTextChange(); app._teFlushAllPendingTextEdits();
  assert.equal(app.tagEditorImages[0].tags, 'first\r\nsecond\ninserted\r\nthird\rfourth\r\n');
});

test('clearing and retyping retains the original BOM and newline convention', () => {
  const { app } = fixture('\uFEFFone\r\ntwo');
  app.tagEditorDetailText = ''; app.tagEditorDetailTextChange();
  app.tagEditorDetailText = 'new\nparagraph\n'; app.tagEditorDetailTextChange();
  app._teFlushAllPendingTextEdits();
  assert.equal(app.tagEditorImages[0].tags, '\uFEFFnew\r\nparagraph\r\n');
});

test('text history displays complete before and after text, including whitespace-only changes', () => {
  const { app } = fixture('  first, second\r\n\r\n');
  app.tagEditorDetailText = ' first, second\n\n';
  app.tagEditorDetailTextChange(); app._teFlushAllPendingTextEdits();
  const diff = app._teGetHistoryDiff(0)[0];
  assert.equal(diff.kind, 'text');
  assert.equal(diff.beforeText, '  first, second\r\n\r\n');
  assert.equal(diff.afterText, ' first, second\r\n\r\n');
  assert.equal(diff.added.length, 0);
  assert.equal(app.tagEditorDetailText, ' first, second\n\n');
  app.tagEditorUndo();
  app.tagEditorDetailText = 'branched\n\n'; app.tagEditorDetailTextChange();
  app._teFlushAllPendingTextEdits();
  assert.equal(app.tagEditorHistory.length, 1);
  app.tagEditorRedo(); assert.equal(app.tagEditorImages[0].tags, 'branched\r\n\r\n');
});

test('IME commits completed text once and pending input is recorded before switching view', () => {
  const { app } = fixture('原文');
  const target = {value:'原文zhong',composing:true};
  app.tagEditorDetailTextChange({target,isComposing:true});
  assert.equal(app.tagEditorImages[0].tags, '原文');
  target.value = '原文中文'; target.composing = false;
  app.tagEditorDetailTextChange({target});
  app.tagEditorSetDetailView('chip');
  assert.equal(app.tagEditorHistory.length, 1);
  assert.equal(app.tagEditorImages[0].tags, '原文中文');
  app.tagEditorUndo(); assert.equal(app.tagEditorImages[0].tags, '原文');
  app.tagEditorRedo(); assert.equal(app.tagEditorImages[0].tags, '原文中文');
});

test('textarea keeps native undo shortcuts while Ctrl+S commits the current text', () => {
  const { app } = fixture(); app.currentRoute = 'tagEditor';
  const target = {tagName:'TEXTAREA',isContentEditable:false, closest: selector => selector === '.te-editor-textarea' ? target : null};
  const event = key => ({key,ctrlKey:true,target,preventDefault() {this.prevented=true;}});
  app.tagEditorUndo = app.tagEditorRedo = () => assert.fail('textarea undo belongs to the browser');
  const undo = event('z'); app.tagEditorHandleKeydown(undo); assert.equal(undo.prevented, undefined);
  const redo = {...event('z'),shiftKey:true}; app.tagEditorHandleKeydown(redo); assert.equal(redo.prevented, undefined);
  let saved = false; app.tagEditorSaveAll = () => {saved=true;};
  const save = event('s'); app.tagEditorHandleKeydown(save);
  assert.equal(save.prevented, true); assert.equal(saved, true);
});

function renameFixture() {
  const f = fixture('\uFEFF  cat, dog\r\n');
  f.app.tagEditorInlineEdit = {oldTag: 'cat', newTag: 'prefix'};
  f.app.$nextTick = callback => Promise.resolve().then(callback);
  f.confirmations = [];
  f.app._teConfirmTagBatch = (message, accept) => f.confirmations.push({message, accept});
  return f;
}

test('inline rename ignores composing Enter and Escape for all supported IME signals', async () => {
  for (const flag of ['isComposing', 'target', 'keyCode', 'state']) {
    const {app, confirmations} = renameFixture();
    const edit = app.tagEditorInlineEdit;
    const event = {type: 'keydown', target: {value: 'prefix中文'}};
    if (flag === 'target') event.target.composing = true;
    else if (flag === 'state') edit.composing = true;
    else event[flag] = flag === 'keyCode' ? 229 : true;
    await app.tagEditorFinishInlineEdit(event);
    assert.equal(app.tagEditorInlineEdit, edit, flag);
    app.tagEditorCancelInlineEdit(event);
    assert.equal(app.tagEditorInlineEdit, edit, flag);
    assert.equal(confirmations.length, 0);
    assert.equal(app.tagEditorHistory.length, 0);
  }
});

test('inline rename takes completed DOM text and confirmation retains raw undo/redo', async () => {
  const {app, confirmations} = renameFixture();
  const raw = app.tagEditorImages[0].tags;
  const target = {value: 'prefix中文'};
  await app.tagEditorFinishInlineEdit({type: 'keydown', target});
  await app.tagEditorFinishInlineEdit({type: 'blur', target});
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /cat → prefix中文$/);
  assert.equal(app.tagEditorImages[0].tags, raw);
  confirmations[0].accept();
  assert.equal(app.tagEditorImages[0].tags, 'prefix中文, dog');
  app.tagEditorUndo(); assert.equal(app.tagEditorImages[0].tags, raw);
  app.tagEditorRedo(); assert.equal(app.tagEditorImages[0].tags, 'prefix中文, dog');
});

test('blur during composition waits for final text and cannot commit a superseded editor', async () => {
  for (const superseded of [false, true]) {
    const {app, confirmations} = renameFixture();
    const target = {value: 'prefixzhong', composing: true};
    app.tagEditorInlineEdit.composing = true;
    await app.tagEditorFinishInlineEdit({type: 'blur', target});
    assert.equal(confirmations.length, 0);
    target.value = 'prefix中文'; target.composing = false;
    const end = app.tagEditorInlineCompositionEnd({target});
    if (superseded) app.tagEditorInlineEdit = null;
    await end;
    await Promise.resolve();
    assert.equal(confirmations.length, superseded ? 0 : 1);
    if (!superseded) assert.match(confirmations[0].message, /cat → prefix中文$/);
  }
});

test('ordinary Escape cancels rename without a blur confirmation', async () => {
  const {app, confirmations} = renameFixture();
  app.tagEditorCancelInlineEdit({type: 'keydown'});
  await app.tagEditorFinishInlineEdit({type: 'blur', target: {value: 'changed'}});
  assert.equal(confirmations.length, 0);
});
