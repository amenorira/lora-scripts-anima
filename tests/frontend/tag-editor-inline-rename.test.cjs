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

test('the panel menu opens a fixed-size editor, selects its name and renames only the clicked occurrence', async () => {
  const f = fixture();
  f.app.tagEditorPanelMenu = { tag: 'blue eyes' };
  f.app._tePanelMenuTrigger = f.anchor;
  await f.app.tagEditorPanelAction('rename');
  await Promise.resolve();
  assert.deepEqual(f.focus(), [1, 1]);
  assert.equal(f.app.tagEditorInlineEditMatches('image', 'blue eyes', 2), true);
  assert.equal(f.app.tagEditorInlineEditMatches('image', 'blue eyes', 0), false);
  assert.deepEqual({ ...f.app.tagEditorInlineEditStyle('image', 'blue eyes', 2) }, { width: '92px', height: '42px' });
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'red eyes' } });
  assert.deepEqual(f.images.map(img => img.tags), ['blue eyes, standing, red eyes', 'blue eyes, sitting', 'blue eyes']);
  assert.equal(f.history[0].affected, 1);
  assert.deepEqual(f.lookups, [['red eyes']]);
});

test('selection rename confirms its scope and leaves unselected images and unrelated duplicates intact', async () => {
  const f = fixture(['blue eyes, standing, standing, blue eyes', 'blue eyes, sitting', 'blue eyes']);
  f.app.tagEditorSelected = ['0', '1'];
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'selection', null, f.anchor);
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'red eyes' } });
  assert.match(f.confirm().message, /2 images/);
  assert.deepEqual(f.images.map(img => img.tags), ['blue eyes, standing, standing, blue eyes', 'blue eyes, sitting', 'blue eyes']);
  f.confirm().accept();
  assert.deepEqual(f.images.map(img => img.tags), ['red eyes, standing, standing, red eyes', 'red eyes, sitting', 'blue eyes']);
  assert.equal(f.history[0].affected, 2);
});

test('the panel menu opens selection-scoped renaming for a multi-image tag', async () => {
  const f = fixture();
  f.app.tagEditorSelected = ['0', '1'];
  f.anchor.classList.contains = name => name === 'te-selected-tag';
  f.app.tagEditorPanelMenu = { tag: 'blue eyes' };
  f.app._tePanelMenuTrigger = f.anchor;
  await f.app.tagEditorPanelAction('rename');
  assert.equal(f.app.tagEditorInlineEditMatches('selection', 'blue eyes'), true);
  assert.deepEqual(Array.from(f.app.tagEditorInlineEdit.selected), ['0', '1']);
});

test('global rename preserves unrelated duplicate tags', async () => {
  const f = fixture(['blue eyes, standing, standing', 'blue eyes']);
  f.app._teEnsureAllImagesLoaded = async () => f.images;
  f.app.tagEditorStartInlineEdit('blue eyes', null);
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'red eyes' } });
  f.confirm().accept();
  assert.deepEqual(f.images.map(img => img.tags), ['red eyes, standing, standing', 'red eyes']);
});

for (const type of ['keydown', 'blur']) {
  test(`an untouched multiline tag is not changed by ${type}`, async () => {
    const raw = '\uFEFF  red eyes\r\nblue eyes, standing\r\n';
    const f = fixture([raw]);
    f.app.tagEditorStartInlineEdit('red eyes\r\nblue eyes', null, 'image', 0, f.anchor);
    await f.app.tagEditorFinishInlineEdit({ type, target: { value: 'red eyesblue eyes' } });
    assert.equal(f.images[0].tags, raw);
    assert.equal(f.history.length, 0);
  });
}

test('explicitly entering the single-line version of a multiline tag is a rename', async () => {
  const f = fixture(['red eyes\r\nblue eyes, standing']);
  f.app.tagDictionaryTranslationFor = tag => tag === 'red eyesblue eyes' ? '译文' : '';
  f.app.tagEditorStartInlineEdit('red eyes\r\nblue eyes', null, 'image', 0, f.anchor);
  const target = { value: 'red eyesblue eyes' };
  f.app.tagEditorInlineEditInput({ type: 'input', target });
  assert.equal(f.app.tagEditorInlineTranslation(), '译文');
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target });
  assert.equal(f.images[0].tags, 'red eyesblue eyes, standing');
  assert.equal(f.history.length, 1);
});

test('single-image rename preserves BOM, spacing and line endings outside the clicked tag', async () => {
  const raw = '\uFEFF blue eyes  ,\r\n  standing ,\tblue eyes \r\n';
  const f = fixture([raw]);
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 2, f.anchor);
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'red eyes' } });
  assert.equal(f.images[0].tags, '\uFEFF blue eyes  ,\r\n  standing ,\tred eyes \r\n');
});

test('selected and global rename preserve original caption formatting', async () => {
  for (const scope of ['selection', 'dataset']) {
    const raw = '\uFEFF  blue eyes,\r\n  standing \r\n';
    const f = fixture([raw, ' blue eyes ,\tblue eyes\r\n', raw]);
    f.app.tagEditorSelected = ['0', '1'];
    f.app._teEnsureAllImagesLoaded = async () => f.images;
    f.app.tagEditorStartInlineEdit('blue eyes', null, scope, null, f.anchor);
    await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'red eyes' } });
    f.confirm().accept();
    assert.equal(f.images[0].tags, '\uFEFF  red eyes,\r\n  standing \r\n');
    assert.equal(f.images[1].tags, ' red eyes ,\tred eyes\r\n');
    assert.equal(f.images[2].tags, scope === 'dataset' ? '\uFEFF  red eyes,\r\n  standing \r\n' : raw);
  }
});

test('renaming to an existing tag merges only the introduced collision', async () => {
  for (const scope of ['image', 'selection', 'dataset']) {
    const raw = '\uFEFF blue eyes,\r\n  Red Eyes, standing, standing\r\n';
    const f = fixture([raw, 'blue eyes, red eyes, cat, cat', 'blue eyes, red eyes']);
    f.app.tagEditorSelected = scope === 'selection' ? ['0', '1'] : ['0'];
    f.app._teEnsureAllImagesLoaded = async () => f.images;
    f.app.tagEditorStartInlineEdit('blue eyes', null, scope, scope === 'image' ? 0 : null, f.anchor);
    await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'red eyes' } });
    if (scope !== 'image') f.confirm().accept();
    assert.equal(f.images[0].tags, '\uFEFF \r\n  Red Eyes, standing, standing\r\n');
    assert.equal(f.images[1].tags, scope === 'image' ? 'blue eyes, red eyes, cat, cat' : ' red eyes, cat, cat');
    assert.equal(f.images[2].tags, scope === 'dataset' ? ' red eyes' : 'blue eyes, red eyes');
  }
});

test('case-only renames keep pre-existing repeated occurrences', async () => {
  const f = fixture(['Cat, cat, standing']);
  f.app.tagEditorStartInlineEdit('Cat', null, 'image', 0, f.anchor);
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target: { value: 'cat' } });
  assert.equal(f.images[0].tags, 'cat, cat, standing');
});

test('translation lookup follows the latest input and ignores unfinished IME composition', () => {
  const f = fixture();
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorInlineEditInput({ type: 'input', target: { value: 'red' } });
  f.app.tagEditorInlineEditInput({ type: 'input', target: { value: 'red eyes' } });
  assert.equal(f.timers.size, 1);
  [...f.timers.values()][0]();
  assert.deepEqual(f.lookups, [['red eyes']]);
  f.app.tagEditorInlineEdit.composing = true;
  f.app.tagEditorInlineEditInput({ type: 'input', isComposing: true, target: { value: '半成品' } });
  assert.equal(f.app.tagEditorInlineEdit.newTag, 'red eyes');
  f.app.tagEditorInlineCompositionEnd({ type: 'compositionend', target: { value: '完成', composing: true } });
  assert.equal(f.app.tagEditorInlineEdit.newTag, '完成');
  [...f.timers.values()].at(-1)();
  assert.deepEqual(f.lookups.at(-1), ['完成']);
});

test('the inline translation uses the trimmed draft', () => {
  const f = fixture();
  f.app.tagDictionaryTranslationFor = tag => ({ 'red eyes': '红眼' })[tag] || '';
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorInlineEditInput({ type: 'input', target: { value: '  red eyes  ' } });
  assert.equal(f.app.tagEditorInlineTranslation(), '红眼');
  f.app.tagEditorCancelInlineEdit();
  assert.equal(f.app.tagEditorInlineTranslation(), '');
});

test('translation is shown only when a full line fits inside the original chip', () => {
  const f = fixture(), translation = {};
  let bottom = 64;
  f.anchor.getBoundingClientRect = () => ({ width: 90, height: 40, bottom });
  f.anchor.querySelector = () => translation;
  f.input.getBoundingClientRect = () => ({ bottom: 42 });
  f.context.window.getComputedStyle = element => element === translation
    ? { lineHeight: '15.4px', marginTop: '1px' }
    : { paddingBottom: '3px', borderBottomWidth: '1px' };
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorMeasureInlineTranslation();
  assert.equal(f.app.tagEditorInlineEdit.translationHasRoom, true);
  bottom = 58;
  f.app.tagEditorMeasureInlineTranslation();
  assert.equal(f.app.tagEditorInlineEdit.translationHasRoom, false);
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

test('invalid comma on Enter retains the input for correction', async () => {
  const f = fixture();
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  const target = { value: 'red, eyes' };
  f.app.tagEditorInlineEditInput({ type: 'input', target });
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target });
  assert.equal(f.app.tagEditorInlineEdit.newTag, 'red, eyes');
  assert.equal(f.history.length, 0);
  target.value = 'red eyes';
  f.app.tagEditorInlineEditInput({ type: 'input', target });
  await f.app.tagEditorFinishInlineEdit({ type: 'keydown', target });
  assert.equal(f.images[0].tags, 'red eyes, standing, blue eyes');
});

test('pending rename is guarded when navigation opens a confirmation', async () => {
  const f = fixture();
  f.app.tagEditorModified = false;
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  assert.equal(f.app._teHasUnsavedEdits(), false);
  const target = { value: 'red eyes' };
  f.app.tagEditorInlineEditInput({ type: 'input', target });
  assert.equal(f.app._teHasUnsavedEdits(), true);
  f.app.showConfirmModal = true;
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target });
  assert.equal(f.images[0].tags, 'blue eyes, standing, blue eyes');
  assert.equal(f.app.tagEditorInlineEdit.newTag, 'red eyes');
  f.app.showConfirmModal = false;
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target });
  assert.equal(f.images[0].tags, 'red eyes, standing, blue eyes');
});

test('a delayed blur after leaving the editor never commits a rename', async () => {
  const f = fixture();
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.currentRoute = 'home';
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target: { value: 'red eyes' } });
  assert.equal(f.images[0].tags, 'blue eyes, standing, blue eyes');
  assert.equal(f.app.tagEditorInlineEdit, null);
});

test('switching images or views clears pending inline input and its lookup', () => {
  const f = fixture();
  f.app._teCloseSuggestions = () => {};
  f.app.tagDictionarySyncChips = () => {};
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorInlineEditInput({ type: 'input', target: { value: 'red eyes' } });
  f.app.tagEditorSelected = ['1'];
  f.app._updateEditorPanel();
  assert.equal(f.app.tagEditorInlineEdit, null);
  assert.equal(f.timers.size, 0);
  f.app.tagEditorStartInlineEdit('blue eyes', null, 'image', 0, f.anchor);
  f.app.tagEditorInlineEdit.composing = true;
  f.app.tagEditorSetDetailView('text');
  assert.equal(f.app.tagEditorInlineEdit, null);
  assert.equal(f.images[1].tags, 'blue eyes, sitting');
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

test('cancelled IME composition does not modify an untouched multiline tag', async () => {
  const raw = 'red eyes\r\nblue eyes, standing';
  const f = fixture([raw]);
  f.app.tagEditorStartInlineEdit('red eyes\r\nblue eyes', null, 'image', 0, f.anchor);
  const target = { value: 'red eyesblue eyes' };
  f.app.tagEditorInlineCompositionStart({ target });
  target.value += 'temporary';
  f.app.tagEditorInlineEditInput({ type: 'input', isComposing: true, target });
  assert.equal(f.app.tagEditorInlineEdit.newTag, 'red eyes\r\nblue eyes');
  target.value = 'red eyesblue eyes';
  f.app.tagEditorInlineCompositionEnd({ type: 'compositionend', data: '', target });
  assert.equal(f.app.tagEditorInlineEdit.inputEdited, undefined);
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target });
  assert.equal(f.images[0].tags, raw);
  assert.equal(f.history.length, 0);
});

test('an IME commit can explicitly replace a multiline tag with its displayed value', async () => {
  const f = fixture(['red eyes\r\nblue eyes, standing']);
  f.app.tagEditorStartInlineEdit('red eyes\r\nblue eyes', null, 'image', 0, f.anchor);
  const target = { value: 'red eyesblue eyes' };
  f.app.tagEditorInlineCompositionStart({ target });
  f.app.tagEditorInlineCompositionEnd({ type: 'compositionend', data: 'red eyesblue eyes', target });
  await f.app.tagEditorFinishInlineEdit({ type: 'blur', target });
  assert.equal(f.images[0].tags, 'red eyesblue eyes, standing');
  assert.equal(f.history.length, 1);
});
