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
