const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);
global.document = {getElementById: () => null};

function fixture() {
  const selected = [], opened = [], animations = [], cards = [];
  const value = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [{path: 'p0'}, {path: 'p1'}], selectSampleImage(index) {selected.push(index);},
    openPreviewLightbox(index) {opened.push(index);},
  });
  const rect = left => ({left, right: left + 90, top: 10, bottom: 110, width: 90, height: 100});
  for (let index = 0; index < 2; index++) {
    const card = {left: index * 120, paintedLeft: null, opacity: '1', running: new Set()};
    const group = {dataset: {batchId: 'b' + index}};
    card.visual = {classList: {contains: () => false}, getBoundingClientRect: () => rect(card.paintedLeft ?? card.left),
      getAnimations: () => [...card.running], animate(frames, timing) {
        let finish;
        const animation = {frames, timing, finished: new Promise(resolve => {finish = resolve;}),
          cancel() {card.running.delete(animation); if (card.owner === animation) card.paintedLeft = null; finish();},
          finish() {card.running.delete(animation); if (card.owner === animation) card.paintedLeft = null; finish();}};
        card.owner = animation; card.running.add(animation); animations.push(animation); return animation;
      }};
    card.button = {dataset: {previewPath: 'p' + index, previewIndex: String(index)},
      closest: selector => selector === '.preview-grid-item[data-preview-index]' ? card.button : selector === '.m-sample-batch' ? group : null,
      querySelector: () => card.visual,
      animate() {throw new Error('interactive button must never animate');},
      getAnimations() {throw new Error('interactive button must not be animation-managed');}};
    card.tile = {dataset: {sampleTileKey: 'p' + index, batchId: 'b' + index}, querySelector: () => card.button,
      animate() {throw new Error('grid tile must never animate');},
      getAnimations() {throw new Error('grid tile must not be animation-managed');},
      getBoundingClientRect() {throw new Error('FLIP must capture the painted visual, not its final hit box');}};
    cards.push(card);
  }
  const grid = {clientWidth: 500, clientHeight: 400, getBoundingClientRect: () => ({left: 0, right: 500, top: 0, bottom: 400}),
    contains: node => cards.some(card => card.button === node),
    querySelectorAll: selector => selector === '.m-sample-tile' ? cards.map(card => card.tile) : cards.map(card => card.visual)};
  const previousStyle = window.getComputedStyle, previousMatch = window.matchMedia;
  window.getComputedStyle = node => node === grid ? {getPropertyValue: () => '200ms'} : {opacity: cards.find(card => card.visual === node)?.opacity || '1'};
  window.matchMedia = () => ({matches: false});
  const press = (target, x, detail = 1) => {
    value.sampleGridPointerDown({target, currentTarget: grid, button: 0, pointerId: 1, clientX: x, clientY: 50});
    value.sampleGridPointerUp({pointerId: 1, clientX: x, clientY: 50});
    value.sampleGridClick({target, currentTarget: grid, button: 0, detail, pointerId: 1, clientX: x, clientY: 50});
  };
  const motion = () => {grid._sampleGridMotion = {items: [...value._captureSampleLayout(grid).values()], animations: new Set([{}])};};
  return {value, cards, grid, selected, opened, animations, press, motion,
    restore() {window.getComputedStyle = previousStyle; window.matchMedia = previousMatch;}};
}

test('80 interrupted FLIPs animate only passive visuals, capture their current positions and release active hit testing', async () => {
  const f = fixture(), {value, cards, grid, animations} = f;
  try {
    for (let round = 0; round < 80; round++) {
      cards.forEach(card => {card.paintedLeft = round ? card.left + 17 : null;});
      const before = value._captureSampleLayout(grid), painted = before.get('p0').rect.left;
      value._cancelSampleGridMotion(grid);
      cards[0].left = round % 2 ? 0 : 120; cards[1].left = round % 2 ? 120 : 0;
      value._animateSampleLayout(grid, before);
      const current = grid._sampleGridMotion;
      assert.equal(animations.at(-2).frames[0].transform, `translate(${painted - cards[0].left}px,0px)`);
      await Promise.resolve();
      assert.equal(grid._sampleGridMotion, current, 'completion of cancelled effects cannot clear a newer motion');
    }
    [...grid._sampleGridMotion.animations].forEach(animation => animation.finish());
    await Promise.resolve();
    assert.equal(grid._sampleGridMotion, null);
    cards.forEach(card => {card.visual.getBoundingClientRect = () => {throw new Error('stable clicks do not need visual geometry');};});
    f.press(cards[0].button, 20);
    assert.deepEqual(f.selected, [0], 'native static-button hits work even if a browser cannot hit the formerly animated visual subtree');
  } finally {f.restore();}
});

test('animation-time presses follow the visible card across another slot and grid gaps, while vacated slots stay blank', () => {
  const f = fixture(), {cards, grid, value} = f;
  try {
    cards[0].paintedLeft = 120; cards[1].paintedLeft = 300; f.motion();
    f.press(cards[1].button, 140);
    assert.deepEqual(f.selected, [0], 'the visible first card wins over the second card static slot');
    cards[0].paintedLeft = 220;
    f.press(grid, 240);
    assert.deepEqual(f.selected, [0, 0], 'a visual passing over a native grid gap remains clickable');
    f.press(cards[0].button, 20);
    assert.deepEqual(f.selected, [0, 0], 'the old invisible slot cannot activate the moved card');
    assert.equal(value._sampleGridLastAction, null);
  } finally {f.restore();}
});

test('transparent delayed reveals never steal a moving card and hit testing respects the scroll viewport', () => {
  const f = fixture(), {cards, grid} = f;
  try {
    cards[0].paintedLeft = cards[1].paintedLeft = 120; cards[1].opacity = '0'; f.motion();
    f.press(cards[1].button, 140);
    assert.deepEqual(f.selected, [0]);
    cards[1].opacity = '1';
    f.press(cards[1].button, 140);
    assert.deepEqual(f.selected, [0, 1], 'the later painted card wins after it becomes visible');
    cards[1].paintedLeft = 480;
    f.press(grid, 520);
    assert.deepEqual(f.selected, [0, 1], 'clipped paint outside the scroll viewport is not interactive');
  } finally {f.restore();}
});

test('double-click requires two effective clicks on the same file, independent of animation-time native targets', () => {
  const f = fixture(), {cards, value, grid} = f;
  try {
    cards[0].paintedLeft = 120; cards[1].paintedLeft = 300; f.motion();
    f.press(cards[1].button, 140, 1); f.press(cards[1].button, 140, 2);
    value.sampleGridDoubleClick({target: cards[1].button, button: 0, detail: 2});
    assert.deepEqual(f.opened, [0]);
    grid._sampleGridMotion = null;
    f.press(cards[0].button, 20, 1); f.press(cards[1].button, 140, 2);
    value.sampleGridDoubleClick({target: grid, button: 0, detail: 2});
    assert.deepEqual(f.opened, [0], 'different cards sharing the grid cannot create a semantic double-click');
    value._sampleGridLastAction = {kind: 'batch', id: 'b0', clickDetail: 1};
    f.press(cards[0].button, 20, 2);
    value.sampleGridDoubleClick({target: grid, button: 0, detail: 2});
    assert.deepEqual(f.opened, [0], 'expanding a cover then clicking its new image is not an image double-click');
  } finally {f.restore();}
});
