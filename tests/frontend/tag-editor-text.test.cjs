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
    _teRemoveDraft() {}, _updateEditorPanel() {}, t: key => key,
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
