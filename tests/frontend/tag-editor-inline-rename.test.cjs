const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor } = require('./helpers.cjs');

function fixture(captions = ['blue eyes, standing, blue eyes', 'blue eyes, sitting', 'blue eyes']) {
  const timers = new Map(), lookups = [], history = [], messages = [];
  let timer = 0, confirmation, focused = 0, selected = 0;
  const input = { focus: () => focused++, select: () => selected++ };
  const context = {
    window: {}, document: { getElementById: id => id === 'te-inline-edit-input' ? input : null },
    setTimeout: callback => { timers.set(++timer, callback); return timer; },
    clearTimeout: id => timers.delete(id),
  };
  loadTagEditor(context);
  const images = captions.map((tags, i) => ({ path: String(i), tags }));
  const app = Object.assign({}, context.window.tagEditorMixin, {
    currentRoute: 'tagEditor', tagEditorImages: images, tagEditorSelected: ['0'],
    tagEditorAllowsTagOps: () => true, tagDictionaryCloseHover() {},
    tagDictionaryLookupTags: tags => lookups.push(Array.from(tags)),
    tagDictionarySyncChips() {},
    _teFlushAllPendingTextEdits() {}, _teInvalidateFilter() {},
    _teUpdateImageTags: (img, tags) => { img.tags = tags; },
    _tePushHistory: entry => history.push(entry), _teImageLabel: img => img.path,
    _teOutsidePageHint: () => '',
    _teConfirmTagBatch: (message, accept) => { confirmation = { message, accept }; },
    t: key => key === 'tagEditor.batchPreviewDiff' ? '{n} images' : key,
    toast: (...args) => messages.push(args), $nextTick: callback => Promise.resolve().then(callback),
  });
  const anchor = {
    classList: { contains: name => name === 'te-editor-tag' }, dataset: { ti: '2' },
    getBoundingClientRect: () => ({ width: 92, height: 42 }),
    isConnected: true, focus() {},
  };
  return { app, context, images, anchor, lookups, history, messages, timers, input,
    focus: () => [focused, selected], confirm: () => confirmation };
}

test('single-image rename preserves BOM, spacing and line endings outside the clicked tag', async () => {
  const raw = '\uFEFF blue eyes  ,\r\n  standing ,\tblue eyes \r\n';
  const f = fixture([raw]);
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 2, f.anchor);
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'red eyes' } });
  assert.equal(f.images[0].tags, '\uFEFF blue eyes  ,\r\n  standing ,\tred eyes \r\n');
});

test('cancel, invalid names and changed selections never modify a caption', async () => {
  const f = fixture();
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorCancelInlineEdit({ type: 'keydown' });
  assert.equal(f.app.tagEditorInlineEdit, null);
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target: { value: 'red, eyes' } });
  assert.deepEqual(f.messages.at(-1), ['tagEditor.inlineRenameInvalid', 'warning']);
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorSelected = ['1'];
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target: { value: 'red eyes' } });
  assert.deepEqual(f.images.map(img => img.tags), ['blue eyes, standing, blue eyes', 'blue eyes, sitting', 'blue eyes']);
  assert.equal(f.history.length, 0);
});

test('blur during IME composition commits only the completed value', async () => {
  const f = fixture();
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorInlineEdit.composing = true;
  const target = { value: '半成品', composing: true };
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target });
  assert.equal(f.history.length, 0);
  target.value = '完成'; target.composing = false;
  await f.app.tagEditorInlineCompositionEnd({ type: 'compositionend', target });
  assert.equal(f.images[0].tags, '完成, standing, blue eyes');
  assert.equal(f.history.length, 1);
});
