const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');
const {withAnimationFrames} = require('./helpers-animation.cjs');

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
  const bounds = () => {
    const width = parseFloat(group.style.width), height = parseFloat(group.style.height), scale = value.previewViewScale;
    const left = parseFloat(group.style.left) + width * (1 - scale) / 2 - viewport.scrollLeft;
    const top = parseFloat(group.style.top) + height * (1 - scale) / 2 - viewport.scrollTop;
    return {left, top, right: left + width * scale, bottom: top + height * scale, width: width * scale, height: height * scale};
  };
  return {value, viewport, extent, group, capture, bounds};
}

test('zoom changes one group transform and preserves the group point under the pointer', () => {
  const {value, group, bounds} = fixture();
  value.setPreviewViewScale(2, {clientX: 250, clientY: 200});
  assert.equal(group.style.transform, 'scale(2)');
  assert.equal(bounds().left, -50);
  assert.equal(bounds().top, -100);
  assert.deepEqual(value._previewGroupGeometry, {width: 800, height: 500, count: 2});
  assert.equal(value.previewViewZoomLabel(), '2.00×');
});

test('fitting a long vertical group displays the complete group rather than fitting each image separately', () => {
  const {value, viewport, group, bounds} = fixture({width: 400, height: 1800, fit: 1 / 3, vertical: true});
  viewport.scrollTop = 600;
  assert.equal(value.previewViewZoomLabel(), '3.00×');
  value.resetPreviewView();
  assert.equal(value.previewViewAtFit(), true);
  assert.equal(value.previewViewScale, 1 / 3);
  assert.equal(group.style.transform, 'scale(' + 1 / 3 + ')');
  assert.equal(bounds().height, 600);
  assert(Math.abs(bounds().top) < 0.001);
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

test('viewer side targets stay in the empty viewport and do not cover the image or scrollbars', () => {
  const {value} = fixture();
  const previousDocument = global.document;
  let groupRect = {left: 400, right: 800};
  const canvas = {offsetWidth: 1000, clientWidth: 1000, clientHeight: 600,
    getBoundingClientRect: () => ({left: 100, top: 20, width: 1000})};
  const viewport = {clientWidth: 940, clientHeight: 550, getBoundingClientRect: () => ({left: 116, top: 32})};
  const button = () => {
    const flags = {};
    return {style: {}, flags, classList: {toggle(name, enabled) {flags[name] = enabled;}}, hidden: false};
  };
  const prev = button(), next = button();
  const nodes = {previewLightboxCanvas: canvas, previewLightboxViewport: viewport,
    previewLightboxGroup: {getBoundingClientRect: () => groupRect}, previewSideNavPrev: prev, previewSideNavNext: next};
  global.document = {getElementById: id => nodes[id] || null};
  try {
    value._layoutPreviewSideNav();
    assert.equal(prev.style.left, '16px'); assert.equal(prev.style.width, '284px');
    assert.equal(next.style.right, '44px'); assert.equal(next.style.width, '256px');
    assert.equal(next.style.bottom, '38px');
    groupRect = {left: 146, right: 1036}; value._layoutPreviewSideNav();
    assert.equal(prev.hidden, false); assert.equal(prev.flags['is-narrow'], true, 'a 30px margin keeps a compact visible control');
    assert.equal(next.hidden, true, 'less than 24px leaves navigation to the toolbar');
    groupRect = {left: 50, right: 1200}; value._layoutPreviewSideNav();
    assert.equal(prev.hidden, true); assert.equal(next.hidden, true);
    value.previewCompareActive = false; value._layoutPreviewSideNav();
    assert.equal(prev.hidden, false); assert.equal(next.hidden, false);
    assert.equal(prev.style.width, '56px'); assert.equal(next.style.width, '56px');
    assert.equal(prev.flags['is-image-edge'], true, 'a full-width image still has an edge navigation target');
  } finally {global.document = previousDocument;}
});

test('side navigation distinguishes a click from a drag and hands dragging to the viewer', () => {
  const {value, viewport} = fixture();
  let captured = null, starts = [], moves = [], clicks = [];
  const button = {setPointerCapture(id) {captured = id;}};
  const down = {currentTarget: button, button: 0, pointerId: 7, clientX: 50, clientY: 100};
  value.previewLightboxNav = direction => clicks.push(direction);
  value.startPreviewSideNavPress(down, viewport);
  assert.equal(captured, 7);
  value.movePreviewSideNavPress({...down, clientX: 54}, start => starts.push(start), move => moves.push(move));
  value.activatePreviewSideNav({detail: 1}, 1);
  assert.deepEqual(clicks, [1]); assert.equal(starts.length, 0);
  value.startPreviewSideNavPress(down, viewport);
  value.movePreviewSideNavPress({...down, clientX: 80}, start => starts.push(start), move => moves.push(move));
  assert.equal(starts[0].currentTarget, viewport); assert.equal(starts[0].clientX, 50);
  assert.equal(moves.length, 1);
  value.activatePreviewSideNav({detail: 1}, -1);
  assert.deepEqual(clicks, [1], 'the click following a drag must not navigate');
  value.startPreviewSideNavPress(down, viewport);
  value.cancelPreviewSideNavPress({pointerId: 7});
  assert.equal(value._previewSideNavPress, null);
});

test('sidebar dragging continues when the side button transfers pointer capture to the image viewport', () => {
  const {value, viewport} = fixture();
  const state = {scale: 2, x: 0, y: 0}, view = window.AnimaImageViewport.create(state);
  view.$refs = {viewport};
  const button = {setPointerCapture() {}};
  const down = {currentTarget: button, button: 0, pointerId: 7, clientX: 50, clientY: 100, preventDefault() {}};
  value.startPreviewSideNavPress(down, viewport);
  value.movePreviewSideNavPress({...down, clientX: 80}, event => view.startPan(event), event => view.movePan(event));
  assert.equal(view.panning, true);
  view.stopPan({type: 'lostpointercapture', pointerId: 7, target: button, currentTarget: viewport});
  assert.equal(view.panning, true, 'the child capture loss must not end the viewport drag');
  view.movePan({...down, clientX: 100});
  assert.equal(state.x, 50);
  view.stopPan({type: 'lostpointercapture', pointerId: 7, target: viewport, currentTarget: viewport});
  assert.equal(view.panning, false, 'losing the viewport capture still ends the drag');
});

test('modal drag coalesces pointer bursts and retains the final position when released', () => withAnimationFrames(({tick, frames}) => {
  const {value, viewport, capture} = fixture(); value.setPreviewViewScale(2);
  const event = {currentTarget: viewport, target: {closest: () => null}, button: 0, pointerId: 7,
    clientX: 500, clientY: 300, preventDefault() {}};
  value.startPreviewPan(event);
  const left = viewport.scrollLeft;
  for (let x = 499; x >= 400; x--) value.movePreviewPan({...event, clientX: x});
  assert.equal(viewport.scrollLeft, left); assert.equal(frames.size, 1);
  tick(0); assert.equal(viewport.scrollLeft, left + 100);
  value.movePreviewPan({...event, clientX: 380});
  value.stopPreviewPan({...event, pointerId: 8});
  assert.equal(value.previewViewPanning, true, 'another pointer cannot release the drag');
  const stale = [...frames.values()][0];
  value.stopPreviewPan(event);
  assert.equal(viewport.scrollLeft, left + 120); assert.equal(capture.size, 0); assert.equal(frames.size, 0);
  stale(100); assert.equal(viewport.scrollLeft, left + 120);
}));

test('modal reset smoothly returns zoom and scroll offset to fit while retaining its image geometry', () => withAnimationFrames(({tick, frames}) => {
  const {value, viewport, group} = fixture();
  value.setPreviewViewScale(3);
  viewport.scrollLeft += 120; viewport.scrollTop -= 80;
  const geometry = value._previewGroupGeometry;
  value.resizePreviewComparisonImages = () => {throw new Error('reset must preserve the mounted image layout');};
  value.resetPreviewView(true);
  assert.equal(value.previewViewScale, 3);
  tick(0); tick(45);
  assert.equal(value.previewViewScale, 1.25);
  assert(Math.abs(viewport.scrollLeft - value._previewViewportLayout.centerX - 15) < 0.001);
  assert(Math.abs(viewport.scrollTop - value._previewViewportLayout.centerY + 10) < 0.001);
  tick(90);
  assert.equal(value.previewViewScale, 1); assert.equal(value._previewViewFitted, true);
  assert.equal(group.style.transform, 'scale(1)'); assert.equal(value._previewGroupGeometry, geometry);
  assert.equal(frames.size, 0);
}));

test('modal interactions, layout changes and closing cancel pending reset writes', () => withAnimationFrames(({tick, frames}) => {
  for (const interrupt of ['zoom', 'pan', 'layout', 'close', 'run']) {
    const {value, viewport, group} = fixture(); value.setPreviewViewScale(3); value.resetPreviewView(true);
    tick(0); tick(45);
    const stale = [...frames.values()][0];
    if (interrupt === 'zoom') value.setPreviewViewScale(2);
    if (interrupt === 'pan') value.startPreviewPan({currentTarget: viewport, target: {}, button: 0, pointerId: 7,
      clientX: 500, clientY: 300, preventDefault() {}});
    if (interrupt === 'layout') value.resizePreviewComparisonImages();
    if (interrupt === 'close') value.closePreviewLightbox();
    if (interrupt === 'run') value.resetSampleBrowser();
    const current = {scale: value.previewViewScale, transform: group.style.transform, x: viewport.scrollLeft, y: viewport.scrollTop};
    stale(200); tick(90);
    assert.deepEqual({scale: value.previewViewScale, transform: group.style.transform, x: viewport.scrollLeft, y: viewport.scrollTop}, current, interrupt);
    assert.equal(frames.size, 0, interrupt);
    value.stopPreviewPan();
  }
}));

test('single images and both comparison layouts can pan at fit while retaining a visible part at every edge', () => {
  for (const options of [{width: 800, height: 500}, {width: 1000, height: 500}, {width: 400, height: 600, vertical: true}]) {
    const {value, viewport, bounds} = fixture(options);
    value.previewCompareActive = options.width !== 800;
    const event = {currentTarget: viewport, target: {closest: () => null}, button: 0, pointerId: 9,
      clientX: 500, clientY: 300, preventDefault() {}};
    value.startPreviewPan(event);
    assert.equal(value.previewViewPanning, true);
    value.movePreviewPan({...event, clientX: 600, clientY: 400});
    assert.equal(bounds().left, (1000 - options.width) / 2 + 100);
    assert.equal(bounds().top, (600 - options.height) / 2 + 100);
    value.movePreviewPan({...event, clientX: 10000, clientY: 10000});
    assert.equal(bounds().left, 936);
    assert.equal(bounds().top, 536);
    value.movePreviewPan({...event, clientX: -10000, clientY: -10000});
    assert.equal(bounds().right, 64);
    assert.equal(bounds().bottom, 64);
    value.resetPreviewView();
    assert.equal(bounds().left, (1000 - options.width) / 2);
    assert.equal(bounds().top, (600 - options.height) / 2);
  }
});

test('zooming a panned image preserves the pointed image detail and relayout preserves its displacement', () => {
  const {value, viewport, bounds} = fixture();
  viewport.scrollLeft += 150; viewport.scrollTop += 100;
  const before = bounds(), point = {clientX: 250, clientY: 200};
  value.setPreviewViewScale(2, point);
  assert.equal((point.clientX - bounds().left) / 2, point.clientX - before.left);
  assert.equal((point.clientY - bounds().top) / 2, point.clientY - before.top);
  const zoomed = bounds();
  value.constrainPreviewView();
  assert.deepEqual(bounds(), zoomed);
});

test('comparison pan limits keep image pixels visible instead of only the unscaled caption', () => {
  for (const vertical of [false, true]) {
    const {value, viewport, bounds} = fixture({vertical});
    const captionWidth = vertical ? 160 : 0, captionHeight = vertical ? 0 : 32;
    Object.assign(value._previewGroupGeometry, {captionWidth, captionHeight});
    value._syncPreviewGroupViewport();
    const event = {currentTarget: viewport, target: {closest: () => null}, button: 0, pointerId: 7,
      clientX: 500, clientY: 300, preventDefault() {}};
    value.startPreviewPan(event);
    value.movePreviewPan({...event, clientX: 10000, clientY: 10000});
    assert.equal(bounds().left + captionWidth, 936);
    assert.equal(bounds().top, 536);
    value.movePreviewPan({...event, clientX: -10000, clientY: -10000});
    assert.equal(bounds().right, 64);
    assert.equal(bounds().bottom - captionHeight, 64);
  }
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
  const {value, group, bounds} = fixture();
  value._previewGroupGeometry.captionHeight = 48;
  value.setPreviewViewScale(2);
  assert.deepEqual(value._previewGroupDrawSize(2), {width: 1600, height: 1048});
  assert.equal(bounds().height, 1048);
  assert.equal(group.style['--preview-caption-y-space'], '24px');
  assert.equal(group.style['--preview-caption-counter-scale'], '0.5');
  assert.equal(group.style.height, '524px');
});
