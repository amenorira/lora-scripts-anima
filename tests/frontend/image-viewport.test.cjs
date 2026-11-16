const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend} = require('./helpers.cjs');
const {withAnimationFrames} = require('./helpers-animation.cjs');
loadGlobalFrontend(['shared/image-viewport']);

function fixture() {
  const captures = new Set();
  const image = {clientWidth: 500, clientHeight: 500, naturalWidth: 500, naturalHeight: 500};
  const stage = {clientWidth: 500, clientHeight: 500, querySelector: () => image,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 500, height: 500}),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id)};
  const view = window.AnimaImageViewport.create(); view.$refs = {viewport: stage};
  const event = {currentTarget: stage, pointerId: 7, button: 0, clientX: 350, clientY: 250, deltaY: -100,
    preventDefault() {}, stopPropagation() {}};
  return {view, stage, event, captures};
}

test('sidebar wheel zoom anchors the pointer and dragging releases capture when its view is destroyed', () => {
  const {view, event, captures} = fixture();
  view.zoom(event);
  assert.equal(view.scale, 1.18);
  assert(Math.abs((100 - view.x) / view.scale - 100) < 0.0001);
  view.startPan(event); assert(captures.has(7));
  const previousX = view.x;
  view.movePan({...event, pointerId: 8, clientX: 400});
  assert.equal(view.x, previousX, 'unrelated pointers cannot move the image');
  view.movePan({...event, clientX: 400});
  assert.equal(view.x, previousX + 50);
  view.destroy(); assert.equal(captures.size, 0); assert.equal(view.panning, false);
});

test('sidebar reset interpolates scale and pan together instead of jumping to fit', () => withAnimationFrames(({tick, frames}) => {
  const {view} = fixture(); view.apply({scale: 3, x: 120, y: -80});
  view.reset();
  assert.deepEqual(view.view(), {scale: 3, x: 120, y: -80});
  tick(0); tick(45);
  assert.deepEqual(view.view(), {scale: 1.25, x: 15, y: -10});
  tick(90);
  assert.deepEqual(view.view(), {scale: 1, x: 0, y: 0}); assert.equal(frames.size, 0);
}));

test('remounting a viewer retains its supplied zoom and pan state', () => {
  const state = {scale: 1, x: 0, y: 0};
  const first = window.AnimaImageViewport.create(state);
  first.apply({scale: 2, x: 40, y: -20}); first.destroy();
  const second = window.AnimaImageViewport.create(state);
  assert.deepEqual(second.view(), {scale: 2, x: 40, y: -20});
  second.reset(false); assert.deepEqual(state, {scale: 1, x: 0, y: 0});
});

test('zoom, image changes, resize and destruction cancel pending reset writes', () => withAnimationFrames(({tick, frames}) => {
  for (const interrupt of ['zoom', 'image', 'resize', 'destroy']) {
    const {view, event} = fixture(); view.apply({scale: 3, x: 120, y: -80});
    view.reset(); tick(0); tick(45);
    const stale = [...frames.values()][0];
    if (interrupt === 'zoom') view.zoom(event);
    if (interrupt === 'image') view.reset(false);
    if (interrupt === 'resize') view.constrain();
    if (interrupt === 'destroy') view.destroy();
    const selected = view.view();
    stale(200); tick(90);
    assert.deepEqual(view.view(), selected, interrupt);
    assert.equal(frames.size, 0, interrupt);
  }
}));

test('reduced motion returns to fit without scheduling animation frames', () => withAnimationFrames(({frames}) => {
  window.matchMedia = () => ({matches: true});
  const {view} = fixture(); view.apply({scale: 3, x: 120, y: -80}); view.reset();
  assert.deepEqual(view.view(), {scale: 1, x: 0, y: 0}); assert.equal(frames.size, 0);
}));

test('pointer writes use the latest position once per frame and flush the final point on release', () => withAnimationFrames(({tick, frames}) => {
  const {view, event, captures} = fixture(); view.apply({scale: 2, x: 0, y: 0});
  view.startPan(event);
  for (let x = 351; x <= 450; x++) view.movePan({...event, clientX: x});
  assert.equal(view.x, 0); assert.equal(frames.size, 1);
  tick(0); assert.equal(view.x, 100);
  view.movePan({...event, clientX: 480});
  const stale = [...frames.values()][0];
  view.stopPan(event);
  assert.equal(view.x, 130); assert.equal(frames.size, 0); assert.equal(captures.size, 0);
  stale(100); assert.equal(view.x, 130);
}));

test('destroying the sidebar discards a queued drag frame', () => withAnimationFrames(({frames}) => {
  const {view, event, captures} = fixture(); view.apply({scale: 2, x: 0, y: 0});
  view.startPan(event); view.movePan({...event, clientX: 450});
  const stale = [...frames.values()][0];
  view.destroy(); stale(100);
  assert.equal(view.x, 0); assert.equal(frames.size, 0); assert.equal(captures.size, 0);
}));
