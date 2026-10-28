const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor } = require('./helpers.cjs');

function fixture(raw = '  原文,  with commas\r\n\r\n末段  \r\n') {
  const context = { window: {}, setTimeout, clearTimeout };
  loadTagEditor( context);
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

function renameFixture() {
  const f = fixture('\uFEFF  cat, dog\r\n');
  f.app.tagEditorInlineEdit = {oldTag: 'cat', newTag: 'prefix'};
  f.app.$nextTick = callback => Promise.resolve().then(callback);
  f.confirmations = [];
  f.app._teConfirmTagBatch = (message, accept) => f.confirmations.push({message, accept});
  return f;
}

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
