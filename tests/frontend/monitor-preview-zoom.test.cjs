const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

loadGlobalFrontend(['shared/utils', 'shared/image-viewport', 'monitor/previews', 'monitor/artifacts-render']);

function fixture({width = 800, height = 500, fit = 1, vertical = false} = {}) {
  const group = {style: {setProperty(key, value) {this[key] = value;}}}, extent = {style: {}}, capture = new Set();
  let left = 0, top = 0;
  const viewport = {clientWidth: 1000, clientHeight: 600, offsetWidth: 1000, offsetHeight: 600,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 1000, height: 600}),
    get scrollWidth() {return Math.max(1000, parseFloat(extent.style.width) || 0);},
    get scrollHeight() {return Math.max(600, parseFloat(extent.style.height) || 0);},
    get scrollLeft() {return Math.max(0, Math.min(this.scrollWidth - 1000, left));},
    set scrollLeft(value) {left = Math.max(0, Math.min(this.scrollWidth - 1000, value));},
    get scrollTop() {return Math.max(0, Math.min(this.scrollHeight - 600, top));},
    set scrollTop(value) {top = Math.max(0, Math.min(this.scrollHeight - 600, value));},
    setPointerCapture: id => capture.add(id), hasPointerCapture: id => capture.has(id), releasePointerCapture: id => capture.delete(id)};
  global.document = {getElementById: id => ({previewLightboxViewport: viewport, previewLightboxExtent: extent, previewLightboxGroup: group})[id] || null};
  const value = composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previewLightboxOpen: true, previewCompareActive: true, previewComparisonLayout: vertical ? 'vertical' : 'horizontal',
    previewViewScale: 1, _previewViewFitScale: fit, _previewGroupGeometry: {width, height, count: vertical ? 3 : 2},
    t: key => key,
  });
  value._syncPreviewGroupViewport();
  return {value, viewport, extent, group, capture};
}

test('zoom changes one group transform and preserves the group point under the pointer', () => {
  const {value, viewport, group} = fixture();
  value.setPreviewViewScale(2, {clientX: 250, clientY: 200});
  assert.equal(group.style.transform, 'scale(2)');
  assert.equal(viewport.scrollLeft, 50);
  assert.equal(viewport.scrollTop, 100);
  assert.deepEqual(value._previewGroupGeometry, {width: 800, height: 500, count: 2});
  assert.equal(value.previewViewZoomLabel(), '2.00×');
});

test('fitting a long vertical group displays the complete group rather than fitting each image separately', () => {
  const {value, viewport, extent, group} = fixture({width: 400, height: 1800, fit: 1 / 3, vertical: true});
  viewport.scrollTop = 600;
  assert.equal(value.previewViewZoomLabel(), '3.00×');
  value.resetPreviewView();
  assert.equal(value.previewViewAtFit(), true);
  assert.equal(value.previewViewScale, 1 / 3);
  assert.equal(group.style.transform, 'scale(' + 1 / 3 + ')');
  assert.equal(extent.style.height, '600px');
  assert.equal(viewport.scrollTop, 0);
});

test('dragging pans the whole scroll surface and releases capture on reset', () => {
  const {value, viewport, capture} = fixture();
  value.setPreviewViewScale(2);
  const event = {currentTarget: viewport, target: {closest: () => null}, button: 0, pointerId: 7,
    clientX: 500, clientY: 300, preventDefault() {}};
  value.startPreviewPan(event);
  assert(capture.has(7));
  const left = viewport.scrollLeft, top = viewport.scrollTop;
  value.movePreviewPan({...event, clientX: 400, clientY: 200});
  assert.equal(viewport.scrollLeft, left + 100);
  assert.equal(viewport.scrollTop, top + 100);
  value.resetPreviewView();
  assert.equal(capture.size, 0);
  assert.equal(value.previewViewPanning, false);
});

test('reciprocal zoom returns exactly to fit without a misleading 100 percent state', () => {
  const {value} = fixture();
  for (let index = 0; index < 20; index++) {
    value.setPreviewViewScale(value.previewViewScale * 1.18);
    value.setPreviewViewScale(value.previewViewScale / 1.18);
    assert.equal(value.previewViewScale, 1);
    assert.equal(value.previewViewZoomLabel(), 'imageViewer.fit');
  }
  const view = window.AnimaImageViewport.zoom({scale: 1.18, x: 2, y: 3}, 1.0000000000000002);
  assert.deepEqual(view, {scale: 1, x: 0, y: 0});
});

test('vertical comparisons retain normal wheel scrolling while Control-wheel zooms the group', () => {
  const {value, viewport} = fixture({width: 400, height: 1800, fit: 1 / 3, vertical: true});
  let prevented = 0;
  const event = {currentTarget: viewport, target: {closest: () => null}, clientX: 500, clientY: 300,
    deltaY: -100, preventDefault() {prevented++;}, stopPropagation() {}};
  value.zoomPreviewView(event);
  assert.equal(prevented, 0); assert.equal(value.previewViewScale, 1);
  value.zoomPreviewView({...event, ctrlKey: true});
  assert.equal(prevented, 1); assert.equal(value.previewViewScale, 1.18);
});

test('page shortcuts do not escape into the main viewer while a child dialog opens or a dropdown is focused', () => {
  const {value} = fixture();
  let moves = 0;
  value.previewLightboxNav = () => {moves++;};
  const event = {key: 'ArrowRight', target: {closest: () => null}, preventDefault() {}, stopPropagation() {}};
  value.previewInfoOpen = true;
  value.previewLightboxKeydown(event);
  value.previewInfoOpen = false;
  value.previewLightboxKeydown({...event, target: {closest: () => ({role: 'combobox'})}});
  assert.equal(moves, 0);
  value.previewLightboxKeydown(event);
  assert.equal(moves, 1);
});

test('viewport resize notifications are coalesced and stop after the viewer disconnects', () => {
  const {value, viewport} = fixture();
  viewport.isConnected = true;
  const previous = {observer: global.ResizeObserver, frame: global.requestAnimationFrame, cancel: global.cancelAnimationFrame};
  const frames = new Map(); let callback, frameId = 0, resized = 0, disconnected = 0;
  global.ResizeObserver = class {
    constructor(notify) {callback = notify;}
    observe(element) {assert.equal(element, viewport);}
    disconnect() {disconnected++;}
  };
  global.requestAnimationFrame = run => {frames.set(++frameId, run); return frameId;};
  global.cancelAnimationFrame = id => frames.delete(id);
  value.resizePreviewComparisonImages = () => {resized++;};
  value.syncPreviewPromptBar = () => {};
  try {
    value._connectPreviewViewportResize();
    callback(); assert.equal(frames.size, 0, 'unchanged bounds do not trigger another layout');
    viewport.offsetHeight = 750; callback();
    viewport.offsetHeight = 800; callback();
    assert.equal(frames.size, 1);
    const pending = [...frames.values()][0]; frames.clear(); pending();
    assert.equal(resized, 1);
    viewport.offsetHeight = 850; callback();
    const stale = [...frames.values()][0];
    value._disconnectPreviewViewportResize();
    assert.equal(frames.size, 0); assert.equal(disconnected, 1);
    stale(); assert.equal(resized, 1, 'a queued callback cannot resize a closed viewer');
  } finally {
    global.ResizeObserver = previous.observer; global.requestAnimationFrame = previous.frame; global.cancelAnimationFrame = previous.cancel;
  }
});

test('caption space and counter-scaling remain fixed while the image group zooms', () => {
  const {value, group, extent} = fixture();
  value._previewGroupGeometry.captionHeight = 48;
  value.setPreviewViewScale(2);
  assert.deepEqual(value._previewGroupDrawSize(2), {width: 1600, height: 1048});
  assert.equal(extent.style.height, '1048px');
  assert.equal(group.style['--preview-caption-y-space'], '24px');
  assert.equal(group.style['--preview-caption-counter-scale'], '0.5');
  assert.equal(group.style.height, '524px');
});
