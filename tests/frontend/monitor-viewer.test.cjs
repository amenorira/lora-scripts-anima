const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins} = require('./helpers.cjs');

test('closing preserves the visible comparison until the exit animation finishes', () => {
  const image = {src: 'current.png', removeAttribute() { this.src = ''; }};
  const reference = {src: 'reference.png', removeAttribute() { this.src = ''; }};
  const elements = {previewLightboxImg: image, previewReferenceImg: reference, previewLightbox: {}};
  const cancelled = [];
  const {window} = loadFrontend(['monitor/previews', 'monitor/artifacts-render'], {
    window: {AnimaImages: {cancel: element => cancelled.push(element)}}, document: {getElementById: id => elements[id] || null},
  });
  const app = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [{name: 'one.png'}, {name: 'two.png'}], previewStep: 0,
    previewLightboxOpen: true, previewReference: {name: 'two.png'}, previewViewScale: 2,
    _updatePreviewLightbox() {},
  });
  app.closePreviewLightbox();
  assert.equal(app.previewLightboxOpen, false);
  assert.equal(app._previewClosePending, true);
  assert.equal(image.src, 'current.png');
  assert.equal(reference.src, 'reference.png');
  assert.equal(app.previewViewScale, 2);
  assert.equal(app.previewReference.name, 'two.png');
  assert.equal(cancelled.length, 2);
  app.clearPreviewLightbox();
  assert.equal(image.src, '');
  assert.equal(reference.src, '');
  assert.equal(app.previewReference, null);
  assert.equal(app.previewViewScale, 1);
});

test('a delayed close cannot clear a viewer that has already reopened', () => {
  const image = {src: 'old.png', removeAttribute() { this.src = ''; }};
  const elements = {previewLightboxImg: image, previewLightbox: {}};
  const {window} = loadFrontend(['monitor/previews', 'monitor/artifacts-render'], {
    window: {AnimaImages: {cancel() {}}}, document: {getElementById: id => elements[id] || null},
  });
  const app = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [{name: 'one.png'}, {name: 'two.png'}], previewStep: 0,
    previewLightboxOpen: true, previewReference: {name: 'one.png'},
    _updatePreviewLightbox() { image.src = 'new.png'; },
  });
  app.closePreviewLightbox();
  app.openPreviewLightbox(1);
  assert.equal(app.previewReference, null);
  assert.equal(image.src, 'new.png');
  app.clearPreviewLightbox();
  assert.equal(image.src, 'new.png');
  assert.equal(app.previewLightboxOpen, true);
});
