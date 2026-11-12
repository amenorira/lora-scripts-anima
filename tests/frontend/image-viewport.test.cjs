const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins} = require('./helpers.cjs');

test('dataset and sample viewers share cursor-centered zoom and reset', () => {
  const {window} = loadFrontend(['tag-editor/view', 'monitor/artifacts-render'], {window: {}});
  const app = composeMixins(window.tagEditorView, window.monitorArtifactsRenderMixin, {
    tagEditorLightboxScale: 1, tagEditorLightboxX: 0, tagEditorLightboxY: 0,
    previewViewScale: 1, previewViewX: 0, previewViewY: 0,
  });
  const stage = {closest: () => stage, getBoundingClientRect: () => ({left: 0, top: 0, width: 200, height: 100})};
  const event = {currentTarget: stage, clientX: 150, clientY: 75};
  app.tagEditorSetLightboxScale(2, event);
  app.setPreviewViewScale(2, event);
  assert.deepEqual([app.previewViewScale, app.previewViewX, app.previewViewY], [2, -50, -25]);
  assert.deepEqual([app.tagEditorLightboxScale, app.tagEditorLightboxX, app.tagEditorLightboxY], [2, -50, -25]);
  app.setPreviewViewScale(100);
  assert.equal(app.previewViewScale, 8);
  app.setPreviewViewScale(0.5);
  assert.deepEqual([app.previewViewScale, app.previewViewX, app.previewViewY], [1, 0, 0]);
});

function stage(width, height, imageWidth, imageHeight, naturalWidth, naturalHeight) {
  const image = {clientWidth: imageWidth, clientHeight: imageHeight, naturalWidth, naturalHeight};
  return {clientWidth: width, clientHeight: height, querySelector: () => image};
}

test('pan limits use contained image dimensions and keep both comparison images visible', () => {
  const {window} = loadFrontend([], {window: {}});
  const portrait = stage(1200, 600, 1200, 600, 800, 1200);
  const constrained = window.AnimaImageViewport.constrain({scale: 2, x: 5000, y: -5000}, [portrait]);
  assert.deepEqual([constrained.x, constrained.y], [840, -740]);
  const left = stage(600, 500, 600, 500, 800, 1200);
  const right = stage(600, 500, 600, 500, 1200, 600);
  const comparison = window.AnimaImageViewport.constrain({scale: 2, x: 5000, y: 0}, [left, right]);
  assert.ok(Math.abs(comparison.x - (600 + 800 * (500 / 1200) * 2) / 2 + 160) < 0.001);
  const unknown = window.AnimaImageViewport.constrain({scale: 2, x: 300, y: -50}, [stage(0, 0, 0, 0, 0, 0)]);
  assert.deepEqual([unknown.x, unknown.y], [300, -50]);
});

test('sample and dataset drag handlers both apply the shared boundary', () => {
  const surface = stage(1200, 600, 1200, 600, 800, 1200);
  const {window} = loadFrontend(['tag-editor/view', 'monitor/artifacts-render'], {window: {}});
  const app = composeMixins(window.tagEditorView, window.monitorArtifactsRenderMixin, {
    previewLightboxOpen: true, previewViewScale: 2, previewViewPanning: true, previewViewPointerId: 1,
    _previewPanStartX: 0, _previewPanStartY: 0,
    tagEditorLightboxOpen: true, tagEditorLightboxScale: 2, tagEditorLightboxPanning: true,
    tagEditorLightboxPointerId: 1, tagEditorLightboxPanStartX: 0, tagEditorLightboxPanStartY: 0,
  });
  const event = {pointerId: 1, currentTarget: surface, clientX: 5000, clientY: -5000};
  app.movePreviewPan(event);
  app.tagEditorMoveLightboxPan(event);
  assert.deepEqual([app.previewViewX, app.previewViewY], [840, -740]);
  assert.deepEqual([app.tagEditorLightboxX, app.tagEditorLightboxY], [840, -740]);
  event.clientX -= 10;
  app.movePreviewPan(event);
  app.tagEditorMoveLightboxPan(event);
  assert.equal(app.previewViewX, 830);
  assert.equal(app.tagEditorLightboxX, 830);
});
