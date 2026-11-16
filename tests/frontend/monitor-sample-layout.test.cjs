const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);
global.document = {getElementById: () => null};

const close = (actual, expected) => assert(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`);

test('workspace geometry fills whole columns and shares the same card size in both sidebar modes', () => {
  for (const width of [640, 800, 900, 932, 1000, 1150, 1172, 1280, 1440, 1920, 2560]) {
    for (const gutter of [0, 8, 17]) {
      const inset = 12 + gutter, layout = window.AnimaSampleLayout.calculate(width, inset);
      close(layout.columns * layout.cardWidth + (layout.columns - 1) * 12 + inset, width);
      close(layout.sidebarColumns * layout.cardWidth + (layout.sidebarColumns - 1) * 12 + inset, layout.gridWidth);
      close(layout.gridWidth + 8 + layout.sidebarWidth, width);
      assert(layout.cardWidth >= 160 && layout.cardWidth <= 215, 'integer column boundaries stay near the preferred card size');
      assert(layout.sidebarWidth >= 320 && layout.sidebarWidth <= 640);
      assert(layout.sidebarColumns < layout.columns);
    }
  }
  for (const width of [0, -1, NaN, Infinity]) assert.equal(window.AnimaSampleLayout.calculate(width), null);
  for (const width of [1, 20, 100, 300]) {
    const layout = window.AnimaSampleLayout.calculate(width);
    assert(Object.values(layout).every(value => Number.isFinite(value) && value >= 0));
    assert(layout.columns >= 1 && layout.cardWidth > 0);
  }
});

function gridFixture() {
  let columns = 6, cardWidth = 180, scroll = 2160;
  const groups = [], items = [];
  const grid = {isConnected: true, clientHeight: 600, scrollLeft: 0,
    get clientWidth() {return columns * (cardWidth + 12);},
    get scrollHeight() {return Math.ceil(items.length / columns) * (cardWidth + 48);},
    get scrollTop() {return Math.max(0, Math.min(this.scrollHeight - this.clientHeight, scroll));},
    set scrollTop(value) {scroll = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value));},
    getBoundingClientRect() {return {top: 100, bottom: 700, left: 0, right: this.clientWidth};},
    contains: item => items.includes(item),
    querySelectorAll: selector => selector === '.m-sample-batch' ? groups : items,
    querySelector: () => null};
  for (let index = 0; index < 80; index++) {
    const group = {dataset: {batchId: 'b' + index}, querySelectorAll: () => [item], querySelector: () => item};
    const item = {dataset: {previewPath: 'p' + index, sampleTileKey: 't' + index, batchId: 'b' + index},
      classList: {contains: () => false}, getAnimations: () => [], closest: () => group,
      getBoundingClientRect() {
        const top = 100 + Math.floor(index / columns) * (cardWidth + 48) - grid.scrollTop, left = (index % columns) * (cardWidth + 12);
        return {top, bottom: top + cardWidth + 36, left, right: left + cardWidth, width: cardWidth, height: cardWidth + 36};
      }};
    item.querySelector = () => ({querySelector: () => item});
    groups.push(group); items.push(item);
  }
  return {grid, items, setColumns(value, width = cardWidth) {columns = value; cardWidth = width;}};
}

test('reflow retains a visible selected card or the browsing anchor and repeated toggles do not drift', () => {
  const {grid, items, setColumns} = gridFixture(), layout = window.AnimaSampleLayout;
  const selected = layout.captureAnchor(grid, items[61]);
  setColumns(4); const selectedResult = layout.restoreAnchor(grid, selected);
  close(items[61].getBoundingClientRect().top - 100, selected.offset);
  setColumns(6); layout.restoreAnchor(grid, selectedResult);
  grid.scrollTop = 2160;
  let anchor = layout.captureAnchor(grid, items[0]);
  const original = {...anchor}, originalScroll = grid.scrollTop;
  for (let count = 0; count < 5; count++) {
    setColumns(4); anchor = layout.restoreAnchor(grid, anchor);
    anchor = layout.captureAnchor(grid, null, anchor);
    assert.equal(anchor.key, original.key);
    setColumns(6); anchor = layout.restoreAnchor(grid, anchor);
    close(grid.scrollTop, originalScroll);
    anchor = layout.captureAnchor(grid, null, anchor);
  }
  const remembered = layout.restoreAnchor(grid, anchor);
  grid.scrollTop += 600;
  assert.notEqual(layout.captureAnchor(grid, null, remembered).key, original.key, 'manual scrolling releases the cached semantic anchor');
});

test('sidebar layout restores the anchor before shared FLIP and superseded toggles cannot scroll back', () => {
  const {grid, items, setColumns} = gridFixture(), ticks = [], motions = [];
  const panel = {querySelector: () => grid};
  const value = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: items.map(item => ({path: item.dataset.previewPath})), previewStep: 61, sampleSidebarVisible: false,
    _sampleOverviewPanel: () => panel, _saveSampleViewPreferences() {}, _refreshSampleGroupOutline() {},
    $nextTick: callback => ticks.push(callback),
    _animateSampleLayout() {motions.push(grid.scrollTop);},
  });
  const previousDocument = global.document;
  global.document = {getElementById: id => id === 'sample-p61' ? items[61] : null};
  try {
    const top = items[61].getBoundingClientRect().top;
    value.toggleSampleSidebar(); setColumns(4); ticks.shift()();
    close(items[61].getBoundingClientRect().top, top); assert.equal(motions[0], grid.scrollTop);
    value.toggleSampleSidebar(); value.toggleSampleSidebar();
    ticks.shift()(); assert.equal(motions.length, 1);
    ticks.shift()(); assert.equal(motions.length, 2);
    value.toggleSampleSidebar(); value.closeSampleSidebarPreview(); ticks.shift()();
    assert.equal(motions.length, 2, 'a newer user action invalidates the pending layout callback');
    value._sampleScrollAnchor = {key: 'p61', scrollTop: grid.scrollTop};
    value.sampleOverviewScroll({currentTarget: grid}); assert(value._sampleScrollAnchor);
    grid.scrollTop += 50; value.sampleOverviewScroll({currentTarget: grid}); assert.equal(value._sampleScrollAnchor, null);
  } finally {global.document = previousDocument;}
});

test('the layout observer watches only the workspace, preserves card size across sidebar changes and disconnects', () => {
  const previousStyle = window.getComputedStyle, previousObserver = global.ResizeObserver;
  let width = 1000, callback, observed, disconnected = false, writes = 0, cleaned = 0;
  const values = new Map();
  const grid = {offsetWidth: 1000, clientWidth: 992, querySelectorAll: () => [], getBoundingClientRect: () => ({top: 0, bottom: 600})};
  const workspace = {isConnected: true, clientWidth: 1000, querySelector: () => grid,
    style: {setProperty(key, value) {writes++; values.set(key, value);}}};
  window.getComputedStyle = element => element === workspace
    ? {width: String(width), getPropertyValue: () => '8px'} : {paddingLeft: '6px', paddingRight: '6px', columnGap: '12px'};
  global.ResizeObserver = class {
    constructor(fn) {callback = fn;}
    observe(element) {observed = element;}
    disconnect() {disconnected = true;}
  };
  try {
    const controller = window.AnimaSampleLayout.create({cleanup() {cleaned++;}}); controller.$el = workspace; controller.init();
    assert.equal(observed, workspace); const card = values.get('--sample-card-width'), initialWrites = writes;
    grid.offsetWidth = 604; grid.clientWidth = 596; callback();
    assert.equal(values.get('--sample-card-width'), card); assert.equal(writes, initialWrites);
    width = 1150; callback(); assert.notEqual(values.get('--sample-card-width'), card);
    controller.destroy(); controller.destroy(); const finalWrites = writes; width = 1400; callback();
    assert.equal(disconnected, true); assert.equal(writes, finalWrites); assert.equal(cleaned, 1);
  } finally {window.getComputedStyle = previousStyle; global.ResizeObserver = previousObserver;}
});

test('resize and sidebar toggles share one browsing anchor until manual scrolling or selection releases it', () => {
  const previousStyle = window.getComputedStyle, previousObserver = global.ResizeObserver;
  const {grid, items, setColumns} = gridFixture(), layout = window.AnimaSampleLayout;
  let width = 1172, callback;
  Object.defineProperty(grid, 'offsetWidth', {get: () => grid.clientWidth + 8});
  const panel = {querySelector: () => grid};
  const value = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: items.map(item => ({path: item.dataset.previewPath})), previewStep: 54,
    _sampleOverviewPanel: () => panel, _saveSampleViewPreferences() {}, _refreshSampleGroupOutline() {}, _animateSampleLayout() {},
    $nextTick(finish) {applyGeometry(); finish();},
  });
  const applyGeometry = () => {
    const geometry = layout.calculate(width, 20);
    setColumns(value.sampleSidebarVisible ? geometry.sidebarColumns : geometry.columns, geometry.cardWidth);
  };
  const workspace = {isConnected: true, querySelector: () => grid,
    style: {setProperty(key) {if (key === '--sample-grid-width') applyGeometry();}}};
  window.getComputedStyle = element => element === workspace
    ? {width: String(width), getPropertyValue: () => '8px'} : {paddingLeft: '6px', paddingRight: '6px', columnGap: '12px'};
  global.ResizeObserver = class {constructor(notify) {callback = notify;} observe() {} disconnect() {}};
  const controller = layout.create({getAnchor: () => value._sampleScrollAnchor, setAnchor: anchor => {value._sampleScrollAnchor = anchor;}});
  try {
    controller.$el = workspace; controller.init(); grid.scrollTop = 3072;
    value._sampleScrollAnchor = layout.restoreAnchor(grid, layout.captureAnchor(grid, items[54]));
    const original = {...value._sampleScrollAnchor}, top = items[54].getBoundingClientRect().top;
    for (let index = 0; index < 5; index++) {
      width = 932; callback(); value.sampleOverviewScroll({currentTarget: grid});
      assert.equal(value._sampleScrollAnchor.key, original.key); close(items[54].getBoundingClientRect().top, top);
      if (index % 2) value.toggleSampleSidebar();
      width = 1172; callback();
      if (!value.sampleSidebarVisible) value.toggleSampleSidebar();
      close(grid.scrollTop, original.scrollTop); close(items[54].getBoundingClientRect().top, top);
    }
    grid.scrollTop += 600; value.sampleOverviewScroll({currentTarget: grid});
    assert.equal(value._sampleScrollAnchor, null);
    const scrolled = layout.captureAnchor(grid);
    width = 932; callback();
    assert.equal(value._sampleScrollAnchor.key, scrolled.key); close(value._sampleScrollAnchor.offset, scrolled.offset);
    value.selectSampleImage(54);
    assert.equal(value._sampleScrollAnchor, null, 'explicit selection releases the shared observer/toggle anchor');
  } finally {controller.destroy(); window.getComputedStyle = previousStyle; global.ResizeObserver = previousObserver;}
});

test('workspace background clearing excludes cards, controls, image panning surfaces and scrollbars', () => {
  const {grid} = gridFixture();
  const value = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin);
  const background = {matches: () => true}, control = {matches: () => false};
  const panel = {querySelector: () => grid, contains: target => target === background};
  assert.equal(value._sampleWorkspaceBlankTarget({target: grid, clientX: 30, clientY: 120}, panel), true);
  assert.equal(value._sampleWorkspaceBlankTarget({target: grid, clientX: grid.clientWidth + 1, clientY: 120}, panel), false);
  assert.equal(value._sampleWorkspaceBlankTarget({target: background}, panel), true);
  assert.equal(value._sampleWorkspaceBlankTarget({target: control}, panel), false);
  value.previewInfoOpen = true;
  assert.equal(value._sampleWorkspaceBlankTarget({target: background}, panel), false);
});

test('only a stationary primary press on workspace background clears the preview', () => {
  const previousDocument = global.document;
  const {grid} = gridFixture(), handlers = new Map();
  const panel = {querySelector: () => grid, contains: () => true};
  global.document = {getElementById: () => null, addEventListener: (type, handler) => handlers.set(type, handler), removeEventListener() {}};
  const value = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin);
  try {
    value._connectSampleExpansionUI(panel);
    const event = {target: grid, button: 0, pointerId: 1, clientX: 30, clientY: 120};
    for (const kind of ['click', 'drag', 'image', 'secondary', 'cancel', 'scrollbar']) {
      value.sampleSidebarOpen = true;
      handlers.get('pointerdown')({...event, target: kind === 'image' ? {} : grid,
        button: kind === 'secondary' ? 2 : 0, clientX: kind === 'scrollbar' ? grid.clientWidth + 1 : 30});
      if (kind === 'drag') handlers.get('pointermove')({...event, clientX: 50});
      if (kind === 'cancel') handlers.get('pointercancel')(event);
      handlers.get('click')(event);
      assert.equal(value.sampleSidebarOpen, kind !== 'click', kind);
      assert.equal(value.sampleSidebarVisible, true, kind);
    }
  } finally {value._disconnectSampleExpansionUI(); global.document = previousDocument;}
});

test('new visible cards reveal after shared FLIP, while stationary, offscreen and reduced-motion cards remain immediate', () => {
  const previousMatch = window.matchMedia;
  const animations = [];
  const rect = (left, top = 0) => ({left, right: left + 180, top, bottom: top + 216});
  const node = key => ({classList: {contains: () => false},
    animate(frames, timing) {
      const animation = {key, frames, timing, finished: new Promise(() => {}), cancelled: false, cancel() {this.cancelled = true;}};
      animations.push(animation); return animation;
    }, getAnimations: () => animations.filter(animation => animation.key === key)});
  const old = node('old'), added = node('added'), outside = node('outside');
  const grid = {getBoundingClientRect: () => ({left: 0, right: 600, top: 0, bottom: 600}), querySelectorAll: () => [old, added, outside]};
  const before = new Map([['old', {node: old, batchId: 'b1', rect: rect(0)}]]);
  const after = new Map([['old', {node: {}, visual: old, batchId: 'b1', rect: rect(192)}],
    ['added', {node: {}, visual: added, batchId: 'b2', rect: rect(0)}], ['outside', {node: {}, visual: outside, batchId: 'b3', rect: rect(0, 2000)}]]);
  const value = composeMixins(window.monitorArtifactsRenderMixin, {_captureSampleLayout: () => after});
  try {
    window.matchMedia = () => ({matches: false});
    value._animateSampleLayout(grid, before, '', {revealNew: true});
    assert.deepEqual(animations.map(animation => animation.key), ['old', 'added']);
    const reveal = animations[1];
    assert.equal(reveal.timing.delay, animations[0].timing.duration);
    assert.equal(reveal.timing.duration, 140); assert.equal(reveal.timing.fill, 'backwards');
    assert.equal(reveal.frames[0].opacity, 0); assert.equal(reveal.frames[1].opacity, 1);
    value._cancelSampleGridMotion(grid);
    assert(animations.every(animation => animation.cancelled), 'cancelling the common animation id also releases the reveal opacity hold');
    animations.length = 0;
    after.get('old').rect = rect(0);
    value._animateSampleLayout(grid, before, '', {revealNew: true});
    assert.equal(animations.length, 0, 'without existing-card movement there is no empty-slot delay');
    value._animateSampleLayout(grid, new Map(), '', {revealNew: true});
    assert.equal(animations.length, 0, 'initial content never starts hidden');
    after.get('old').rect = rect(192); window.matchMedia = () => ({matches: true});
    value._animateSampleLayout(grid, before, '', {revealNew: true});
    assert.equal(animations.length, 0);
  } finally {window.matchMedia = previousMatch;}
});
