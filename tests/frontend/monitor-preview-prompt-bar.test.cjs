const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

loadGlobalFrontend(['shared/utils', 'monitor/artifacts-render']);

function setup() {
  const captured = new Set(), classes = new Set(), scrolls = [], ticks = [];
  const arrows = [{offsetWidth: 0}, {offsetWidth: 0}];
  const rail = {
    hidden: false, clientWidth: 200, offsetWidth: 200, scrollWidth: 800, scrollLeft: 0,
    parentElement: {querySelectorAll: () => arrows},
    getBoundingClientRect() { return {width: this.offsetWidth}; },
    scrollTo(options) { scrolls.push(options); this.scrollLeft = options.left; },
    setPointerCapture(id) { captured.add(id); },
    hasPointerCapture(id) { return captured.has(id); },
    releasePointerCapture(id) { captured.delete(id); },
    classList: {add: name => classes.add(name), remove: name => classes.delete(name)},
  };
  global.document = {getElementById: id => id === 'previewLightboxStrip' ? rail : null};
  window.getComputedStyle = () => ({columnGap: '6px'});
  window.matchMedia = () => ({matches: false});
  const value = composeMixins(window.utilsMixin, window.monitorArtifactsRenderMixin, {
    previewStep: 7, sampleBatchId: 'b7', $nextTick: callback => ticks.push(callback),
  });
  const event = (x, extra = {}) => ({currentTarget: rail, target: {tagName: 'BUTTON'}, pointerId: 1,
    button: 0, isPrimary: true, clientX: x, preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; }, ...extra});
  const flush = () => { while (ticks.length) ticks.shift()(); };
  return {value, rail, arrows, captured, classes, scrolls, event, flush};
}

test('prompt arrows track both boundaries and disappear when their own space is no longer needed', () => {
  const {value, rail, arrows, flush} = setup();
  value.syncPreviewPromptBar();
  assert.equal(value.previewPromptBarOverflow, true);
  assert.equal(value.previewPromptBarAtStart, true);
  assert.equal(value.previewPromptBarAtEnd, false);
  arrows.forEach(arrow => { arrow.offsetWidth = 28; });
  rail.clientWidth = 132;
  flush();
  rail.scrollLeft = 668;
  value.syncPreviewPromptBar();
  assert.equal(value.previewPromptBarAtStart, false);
  assert.equal(value.previewPromptBarAtEnd, true);
  rail.scrollWidth = 180;
  rail.scrollLeft = 0;
  value.syncPreviewPromptBar();
  assert.equal(value.previewPromptBarOverflow, false, '180px fits the original 200px without arrows');
  rail.clientWidth = 200; rail.scrollWidth = 200;
  arrows.forEach(arrow => { arrow.offsetWidth = 0; });
  flush();
  assert.equal(value.previewPromptBarAtStart, true);
  assert.equal(value.previewPromptBarAtEnd, true);
});

test('prompt arrows pan smoothly and clamp without changing the displayed sample', () => {
  const {value, rail, scrolls} = setup();
  value.syncPreviewPromptBar();
  value.scrollPreviewPromptBar(1);
  assert.deepEqual(scrolls.at(-1), {left: 150, behavior: 'smooth'});
  rail.scrollLeft = 590;
  value.scrollPreviewPromptBar(1);
  assert.equal(rail.scrollLeft, 600);
  assert.equal(value.previewPromptBarAtEnd, true);
  value.scrollPreviewPromptBar(-1);
  assert.equal(rail.scrollLeft, 450);
  assert.equal(value.previewStep, 7);
  assert.equal(value.sampleBatchId, 'b7');
  rail.scrollWidth = rail.clientWidth;
  value.syncPreviewPromptBar();
  const count = scrolls.length;
  value.scrollPreviewPromptBar(1);
  assert.equal(scrolls.length, count);
});

test('dragging from a prompt button captures only after the threshold and suppresses only the drag click', () => {
  const {value, rail, captured, classes, scrolls, event} = setup();
  rail.scrollLeft = 120;
  value.startPreviewPromptBarDrag(event(100));
  assert.deepEqual(scrolls.at(-1), {left: 120, behavior: 'instant'}, 'stop any pending smooth motion');
  value.movePreviewPromptBarDrag(event(105));
  assert.equal(captured.size, 0);
  assert.equal(rail.scrollLeft, 120);
  value.endPreviewPromptBarDrag(event(105));
  const click = event(105);
  value.suppressPreviewPromptBarClick(click);
  assert.equal(click.prevented, undefined, 'a normal button click still selects its prompt');
  value.startPreviewPromptBarDrag(event(100));
  const move = event(65);
  value.movePreviewPromptBarDrag(move);
  assert.equal(rail.scrollLeft, 155);
  assert.equal(move.prevented, true);
  assert.equal(captured.has(1), true);
  assert.equal(classes.has('is-dragging'), true);
  value.endPreviewPromptBarDrag(event(65));
  value.endPreviewPromptBarDrag(event(65)); // lostpointercapture after pointerup
  assert.equal(captured.size, 0);
  assert.equal(classes.size, 0);
  const dragClick = event(65);
  value.suppressPreviewPromptBarClick(dragClick);
  assert.equal(dragClick.prevented, true);
  assert.equal(dragClick.stopped, true);
  const nextClick = event(65);
  value.suppressPreviewPromptBarClick(nextClick);
  assert.equal(nextClick.prevented, undefined);
  assert.equal(value.previewStep, 7);
  value.cancelPreviewPromptBarDrag();
});

test('scaled drag, pointer cancellation, leaving before drag and hidden rails release gesture state', () => {
  const {value, rail, captured, event} = setup();
  rail.getBoundingClientRect = () => ({width: 100});
  value.startPreviewPromptBarDrag(event(100));
  value.movePreviewPromptBarDrag(event(80));
  assert.equal(rail.scrollLeft, 40, 'visual movement is normalized to the dialog scale');
  value.cancelPreviewPromptBarDrag();
  assert.equal(value._previewPromptBarDrag, null);
  assert.equal(captured.size, 0);
  assert.equal(value._previewPromptBarSuppressClick, false);
  value.startPreviewPromptBarDrag(event(100));
  value.leavePreviewPromptBarDrag(event(101));
  assert.equal(value._previewPromptBarDrag, null);
  value.startPreviewPromptBarDrag(event(100, {button: 2}));
  assert.equal(value._previewPromptBarDrag, null);
  value.startPreviewPromptBarDrag(event(100));
  value.movePreviewPromptBarDrag(event(80));
  rail.hidden = true;
  value.syncPreviewPromptBar();
  assert.equal(value._previewPromptBarDrag, null);
  assert.equal(captured.size, 0);
  assert.equal(value.previewPromptBarOverflow, false);
});
