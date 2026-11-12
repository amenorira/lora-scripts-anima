const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, readRepo} = require('./helpers.cjs');
const {uiHarness} = require('./ui-helpers.cjs');

test('morph dialogs keep the explicit opener hidden until the exit finishes', async () => {
  const {context, document, Element, ticks, flush, listeners} = uiHarness();
  const opener = new Element('button'), dialog = new Element('dialog'), modal = new Element('div');
  dialog.className = 'modal-overlay modal-overlay--morph'; modal.className = 'modal';
  dialog.setAttribute('id', 'testDialog');
  opener.dataset = {dialogOpens: 'testDialog'};
  opener.setAttribute('data-dialog-opens', 'testDialog');
  dialog.rect = {left:0,top:0,right:1280,bottom:720,width:1280,height:720};
  modal.rect = {left:100,top:100,right:900,bottom:600,width:800,height:500};
  const motions = [];
  function animate(frames) {
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const motion = {frames, finished, finish, cancel: finish, effect: {target: this}};
    motions.push(motion);
    return motion;
  }
  dialog.animate = modal.animate = animate;
  document.createElement = tag => Object.assign(new Element(tag), {animate});
  opener.classList.remove = name => opener.classList.toggle(name, false);
  opener.cloneNode = () => Object.assign(new Element('button'), {animate, className: opener.className});
  const settle = async () => { motions.splice(0).forEach(motion => motion.finish()); await new Promise(setImmediate); flush(); };
  opener.rect = {left:120,top:30,width:120,height:32,right:240,bottom:62};
  dialog.appendChild(modal); document.body.append(opener,dialog);
  const binding = context.window.AnimaUI.bindDialog(dialog, callback=>ticks.push(callback));
  listeners.get('click')({target: opener});
  opener.rect = {...opener.rect,top:600,bottom:632};
  binding.setOpen(true); flush();
  assert.equal(motions[0].frames[0].clipPath, 'inset(30px 1040px 658px 120px round 0px)');
  assert.equal(motions[0].frames[1].clipPath, 'inset(100px 380px 120px 100px round 0px)');
  assert.equal(opener.classList.contains('dialog-morph-origin'), true);
  await settle();
  assert.equal(opener.classList.contains('dialog-morph-origin'), true);
  const thumbnail = new Element('div');
  thumbnail.setAttribute('data-dialog-anchor', '');
  modal.appendChild(thumbnail);
  binding.setOpen(false); flush();
  assert.equal(dialog.open, true);
  assert.equal(opener.classList.contains('dialog-morph-origin'), true);
  assert.equal(dialog.querySelector('.dialog-morph-button').classList.contains('dialog-morph-origin'), false);
  assert.equal(motions[0].frames.at(-1).clipPath, 'inset(600px 1040px 88px 120px round 0px)');
  await settle();
  assert.equal(dialog.open, false);
  assert.equal(opener.classList.contains('dialog-morph-origin'), false);
  assert.equal(document.activeElement, opener);
  context.window.AnimaUI.setDialogOrigin(dialog, opener);
  binding.setOpen(true); flush(); await settle();
  opener.remove(); binding.setOpen(false); flush();
  assert.equal(motions[0].frames.at(-1).clipPath, 'inset(600px 1040px 88px 120px round 0px)');
  binding.setOpen(true); flush(); await settle();
  assert.equal(dialog.open, true);
  assert.equal(context.window.AnimaUI.topDialog(), dialog);
});

test('closing a dialog preserves an explicit destination focus and still restores lost focus', () => {
  const {context, document, Element, ticks, flush} = uiHarness();
  const opener = new Element('button'), target = new Element('input'), dialog = new Element('dialog');
  dialog.appendChild(new Element('button'));
  document.body.append(opener, target, dialog);
  const binding = context.window.AnimaUI.bindDialog(dialog, callback => ticks.push(callback));
  opener.focus(); binding.setOpen(true); flush();
  binding.setOpen(false); target.focus(); flush();
  assert.equal(document.activeElement, target);
  opener.focus(); binding.setOpen(true); flush();
  binding.setOpen(false); flush();
  assert.equal(document.activeElement, opener);
});

test('a LyCORIS conflict link waits for the modal to close before focusing the main form', () => {
  const dialog = new EventTarget();
  const focused = [];
  const input = { focus: () => focused.push('fp8_base') };
  const row = { dataset: { fieldRow: 'fp8_base' }, isConnected: true,
    closest: () => null, getClientRects: () => [{}], scrollIntoView() {}, querySelector: () => input };
  const { window } = loadFrontend(['training/sections', 'training/network-panel'], {
    window: { matchMedia: () => ({ matches: true }) },
    document: { getElementById: () => dialog, querySelectorAll: selector => selector.startsWith('#trainFormContent') ? [row] : [] },
  });
  const app = composeMixins(window.trainingSections, window.trainingNetworkPanel, {
    form: { network_module: 'lycoris.kohya' }, lycorisModalOpen: true,
    _allSections: () => [{ fields: [{ key: 'fp8_base' }] }],
    _closeManagedModal(key) { this[key] = false; },
    $nextTick: callback => callback(),
  });
  app.focusTrainingField('fp8_base');
  assert.equal(app.lycorisModalOpen, false);
  assert.deepEqual(focused, []);
  dialog.dispatchEvent(new Event('dialog-after-close'));
  assert.deepEqual(focused, ['fp8_base']);
});

const filename = (stage, prompt, prefix = 'sample_') => `${prefix}e${String(stage).padStart(6, '0')}_${String(prompt).padStart(2, '0')}_20261109120000_42.png`;
function previews(names) {
  const {window} = loadFrontend(['monitor/previews', 'monitor/artifacts-render'], {
    window: {}, document: {getElementById: () => null, body: {style: {}}},
  });
  return composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: names.map(name => ({name})), previewStep: 0, previewSortDir: 'asc', previewReference: null,
    _previewSnapshotSeq: 0, previewsVersion: 0, _updatePreviewLightbox() {}, renderDashboard() {},
    t(key) { return key === 'monitor.samplePrompt' ? 'Prompt {n}' : key; },
  });
}

test('the sample toolbar filters by prompt and the viewer follows the same visible order', () => {
  const app = previews([filename(1, 0), filename(1, 1), filename(2, 0), 'custom_e000003_00_something.png']);
  assert.deepEqual(Array.from(app._samplePromptOptions(), option => option.value), ['', 'sample_:00', 'sample_:01']);
  app.setSamplePromptSelection('sample_:00');
  assert.deepEqual(Array.from(app._previewLightboxIndices()), [0, 2]);
  app.previewLightboxNav(1);
  assert.equal(app.previewStep, 2);
  app.previewLightboxNav(1);
  assert.equal(app.previewStep, 2);
  app.previewSortDir = 'desc';
  assert.deepEqual(Array.from(app._previewLightboxIndices()), [2, 0]);
  app.previewLightboxNav(1);
  assert.equal(app.previewStep, 0);
  app.setSamplePromptSelection('');
  assert.equal(app._previewLightboxIndices().length, 4);
  assert.equal(previews([filename(1, 0), filename(2, 0)])._samplePromptOptions().length, 0);
  assert.equal(app._previewPromptIdentity({name: 'my000001_00_20261109120000.png'}), null);
});

test('filtered refresh preserves the selected image and never jumps to another prompt', () => {
  const app = previews([filename(1, 0), filename(1, 1), filename(2, 0)]);
  app.previewStep = 2;
  app.setSamplePromptSelection('sample_:00');
  app._applyPreviewSnapshot([filename(1, 0), filename(1, 1), filename(2, 1), filename(2, 0), filename(3, 1)].map(name => ({name})));
  assert.equal(app.previewStep, 3);
  assert.equal(app.previews[app.previewStep].name, filename(2, 0));
  app.closePreviewLightbox();
  assert.equal(app.samplePromptSelection, 'sample_:00');
  assert.equal(app._previewLightboxIndices().length, 2);
});

test('a removed prompt group clears the filter and clamps the current position', () => {
  const app = previews([filename(1, 0), filename(1, 1), filename(2, 0)]);
  app.previewStep = 2;
  app.setSamplePromptSelection('sample_:00');
  app._applyPreviewSnapshot([{name: filename(1, 1)}]);
  assert.equal(app.samplePromptSelection, '');
  assert.equal(app.previewStep, 0);
});

test('an open viewer keeps its selected path when new or earlier samples arrive', () => {
  const app = previews([]);
  const sample = (path, name = 'same.png') => ({path, name});
  app.previews = [sample('a/same.png'), sample('b/same.png')];
  app.previewStep = 1;
  app.previewLightboxOpen = true;
  app._applyPreviewSnapshot([sample('old/same.png'), ...app.previews, sample('new/same.png')]);
  assert.equal(app.previews[app.previewStep].path, 'b/same.png');
  assert.equal(app.previewHasNew, true);
  app.jumpToLatestPreview();
  assert.equal(app.previews[app.previewStep].path, 'new/same.png');
  assert.equal(app.previewHasNew, false);
});

test('the new-sample action follows the active prompt filter', () => {
  const app = previews([filename(1, 0), filename(1, 1), filename(2, 0)]);
  app.setSamplePromptSelection('sample_:00');
  app.previewStep = 2;
  app.previewLightboxOpen = true;
  app._applyPreviewSnapshot([...app.previews, {name: filename(2, 1)}]);
  assert.equal(app.previewHasNew, false);
  app._applyPreviewSnapshot([...app.previews, {name: filename(3, 0)}]);
  assert.equal(app.previewHasNew, true);
  app.jumpToLatestPreview();
  assert.equal(app.previews[app.previewStep].name, filename(3, 0));
});

test('pinning a reference immediately compares another image from the same prompt when available', () => {
  const app = previews([filename(1, 0), filename(1, 1), filename(2, 0), filename(2, 1)]);
  app.previewStep = 3;
  app.togglePreviewReference();
  assert.equal(app.previewReference.name, filename(2, 1));
  assert.equal(app.previews[app.previewStep].name, filename(1, 1));
  assert.deepEqual(Array.from(app._previewLightboxIndices()), [1]);
  app.togglePreviewReference();
  assert.equal(app.previewReference, null);
  assert.deepEqual(Array.from(app._previewLightboxIndices()), [0, 1, 2, 3]);
  const single = previews([filename(1, 0)]);
  single.togglePreviewReference();
  assert.equal(single.previewReference, null);
});

test('comparison navigation stays within the reference prompt and skips the pinned image', () => {
  const app = previews([filename(1, 0), filename(1, 1), filename(2, 0), filename(2, 1), filename(3, 0), filename(3, 1)]);
  app.previewStep = 5;
  app.previewLightboxOpen = true;
  app.togglePreviewReference();
  assert.equal(app.previews[app.previewStep].name, filename(2, 1));
  assert.deepEqual(Array.from(app._previewLightboxIndices()), [1, 3]);
  assert.equal(app._previewLightboxSequence().samePrompt, true);
  app.previewLightboxNav(-1);
  assert.equal(app.previews[app.previewStep].name, filename(1, 1));
  app._applyPreviewSnapshot([...app.previews, {name: filename(4, 0)}]);
  assert.equal(app.previewHasNew, false);
  app._applyPreviewSnapshot([...app.previews, {name: filename(4, 1)}]);
  assert.equal(app.previewHasNew, true);
  app.jumpToLatestPreview();
  assert.equal(app.previews[app.previewStep].name, filename(4, 1));
});

test('comparison scope does not claim a prompt filter when it falls back to other samples', () => {
  const app = previews([filename(1, 0), filename(1, 1), 'custom.png']);
  app.previewStep = 0;
  app.togglePreviewReference();
  assert.equal(app._previewLightboxSequence().samePrompt, false);
  assert.equal(app._previewLightboxIndices().length, 2);
});

test('custom sample names remain visible when several filenames cannot be parsed', () => {
  const app = previews(['custom-a.png', 'custom-b.png']);
  Object.assign(app, {currentOutputRunDir: 'output/a', monitorData: {}, weakNetworkMode: false, esc: value => String(value ?? '')});
  const html = app._renderSamplesTab(key => key);
  assert.match(html, /<strong>custom-a\.png<\/strong>/);
  assert.match(html, /<strong>custom-b\.png<\/strong>/);
});

test('failure count navigation clears the old query and pagination before requesting the task filter', async () => {
  const {window} = loadFrontend(['tagger/caption-workspace'], {window: {}});
  let selected;
  const app = composeMixins(window.captionWorkspaceMixin, {
    captionOverviewQuery: 'old search', captionOverviewOffset: 120,
    captionBatchState: () => ({source: {source_token: 'current'}, taskId: 'task-A', task: {failed: 3}}),
    async selectCaptionTab(tab) { selected = [tab, this.captionOverviewFilter, this.captionOverviewQuery, this.captionOverviewOffset]; },
  });
  await app.showCaptionFailures();
  assert.deepEqual(selected, ['overview', 'failed', '', 0]);
  selected = null;
  app.taggerScanning = true;
  await app.showCaptionFailures();
  assert.equal(selected, null);
});

test('conflict links use visible fields, handle Krea aliases, and escape all server text', () => {
  const {window} = loadFrontend(['training/validation'], {window: {}});
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const dict = JSON.parse(readRepo(`frontend/i18n/${locale}.json`));
    const app = composeMixins(window.trainingValidation, {
      form: {model_train_type: 'krea2-lora'},
      esc: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      t: key => key.split('.').reduce((value, part) => value?.[part], dict) ?? key,
      _allSections: () => [{fields: [{key: 'krea_adamw_fused', argKey: 'fused'}, {key: 'foreach'}, {key: 'optimizer_args_custom', hidden: true}]}],
      _fieldShowIfMet: field => !field.hidden,
    });
    app.formErrors = {foreach: dict.field.adamwFusedForeachConflict};
    const html = app.fieldErrorHtml('foreach');
    assert.match(html, /focusTrainingField\('krea_adamw_fused'\)/);
    assert.doesNotMatch(html, /focusTrainingField\('foreach'\)|focusTrainingField\('optimizer_args_custom'\)|\{adamw_fused\}/);
    app.formErrors.foreach = '<img src=x onerror=alert(1)>';
    assert.equal(app.fieldErrorHtml('foreach'), '&lt;img src=x onerror=alert(1)&gt;');
    for (const value of Object.values(dict.fieldConflict)) assert.doesNotMatch(value, /<|>/);
  }
});

test('matrix links cover every rank dimension and each whole Kronecker factor', () => {
  const {window} = loadFrontend(['training/shape-preview'], {window: {}});
  const app = composeMixins(window.trainingShapePreviewMixin, {esc: value => String(value), escapeAttr: value => String(value), t: key => key});
  const lora = app._shapePreviewLoraSvg({rank: 16, inDim: 1024, outDim: 1024});
  assert.equal((lora.match(/class="sp-rank-value"/g) || []).length, 2);
  const loha = app._shapePreviewLohaSvg({rank: 16, inDim: 1024, outDim: 1024});
  assert.equal((loha.match(/data-preview-target="rank"/g) || []).length, 4);
  const full = app._shapePreviewLokrSvg({rank: 16, inDim: 1024, outDim: 1024, outL: 32, outK: 32, inM: 32, inN: 32, w1LowRank: false, w2Full: true});
  assert.equal((full.match(/sp-rank-value/g) || []).length, 0);
  assert.equal((full.match(/sp-w2-matrix/g) || []).length, 1);
  for (const factor of ['w1', 'w2']) {
    assert.equal((full.match(new RegExp(`data-preview-target="${factor}"`, 'g')) || []).length, 1);
    assert.match(full, new RegExp(`<rect class="sp-block [^"]+" data-preview-target="${factor}"`));
  }
  const low = app._shapePreviewLokrSvg({rank: 4, inDim: 1024, outDim: 1024, outL: 32, outK: 32, inM: 32, inN: 32, w1LowRank: true, w2Full: false});
  assert.equal((low.match(/sp-rank-value/g) || []).length, 4);
  assert.equal((low.match(/sp-w2-matrix/g) || []).length, 2);
  for (const factor of ['w1', 'w2']) {
    assert.equal((low.match(new RegExp(`data-preview-target="${factor}"`, 'g')) || []).length, 1);
    assert.match(low, new RegExp(`<rect class="sp-group" data-preview-target="${factor}"`));
  }
});
