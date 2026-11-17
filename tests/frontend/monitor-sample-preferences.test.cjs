const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

const preferenceKey = 'anima-sample-view';

function storage(initial = null) {
  const values = new Map(initial === null ? [] : [[preferenceKey, initial]]), writes = [];
  return {values, writes,
    getItem(key) {assert.equal(key, preferenceKey); return values.get(key) ?? null;},
    setItem(key, value) {assert.equal(key, preferenceKey); values.set(key, value); writes.push(JSON.parse(value));},
  };
}

function withStorage(value, callback) {
  const previous = Object.getOwnPropertyDescriptor(global, 'localStorage');
  Object.defineProperty(global, 'localStorage', {configurable: true, value});
  try {return callback();}
  finally {
    if (previous) Object.defineProperty(global, 'localStorage', previous);
    else delete global.localStorage;
  }
}

function app() {
  const value = composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [], previewsVersion: 0, previewStep: 0,
    currentOutputRunDir: 'output/test', weakNetworkMode: false,
    t: key => key, renderDashboard() {},
  });
  value.resetSampleBrowser();
  return value;
}

function settings(value) {
  return {sidebar: value.sampleSidebarVisible, viewerTimeline: value.previewViewTimelineVisible,
    sort: value.sampleBatchSortDir};
}

test('sidebar, viewer thumbnails and sorting save independent preferences without changing the selected image', () => {
  const saved = storage();
  withStorage(saved, () => {
    const value = app(); value.previewStep = 4; value.sampleBatchId = 'selected-batch';
    value.renderDashboard = () => {};
    value.toggleSampleSidebar({currentTarget: {checked: false}});
    assert.deepEqual(settings(value), {sidebar: false, viewerTimeline: true, sort: 'desc'});
    value.togglePreviewViewTimeline({currentTarget: {checked: false}});
    assert.deepEqual(settings(value), {sidebar: false, viewerTimeline: false, sort: 'desc'});
    value.toggleSampleSidebar({currentTarget: {checked: true}});
    assert.deepEqual(settings(value), {sidebar: true, viewerTimeline: false, sort: 'desc'});
    value.setSampleBatchSort('asc');
    assert.deepEqual(saved.writes, [
      {sidebar: false, viewerTimeline: true, sort: 'desc', comparisonLayout: 'horizontal', lossMode: 'off'},
      {sidebar: false, viewerTimeline: false, sort: 'desc', comparisonLayout: 'horizontal', lossMode: 'off'},
      {sidebar: true, viewerTimeline: false, sort: 'desc', comparisonLayout: 'horizontal', lossMode: 'off'},
      {sidebar: true, viewerTimeline: false, sort: 'asc', comparisonLayout: 'horizontal', lossMode: 'off'},
    ]);
    assert.equal(value.previewStep, 4);
    assert.equal(value.sampleBatchId, 'selected-batch');
    value.setSampleBatchSort('asc'); value.setSampleBatchSort('invalid');
    assert.equal(saved.writes.length, 4, 'unchanged or invalid sorting requests do not overwrite preferences');
  });
});

test('saved sidebar, viewer thumbnails and sorting restore after a run reset', () => {
  const expected = {sidebar: false, viewerTimeline: true, sort: 'asc'};
  const saved = storage(JSON.stringify(expected));
  withStorage(saved, () => {
    const value = app();
    assert.deepEqual(settings(value), expected);
    value.sampleSidebarVisible = true; value.previewViewTimelineVisible = false; value.sampleBatchSortDir = 'desc';
    value.resetSampleBrowser();
    assert.deepEqual(settings(value), expected, 'changing runs restores the saved layout');
    assert.deepEqual(settings(app()), expected, 'a fresh monitor state uses the same saved choices');
    assert.equal(saved.writes.length, 0, 'restoring preferences does not write back to storage');
  });
});

test('closing only the sidebar preview preserves the enabled preference and restores visible focus', () => {
  const saved = storage(), previousDocument = global.document;
  let focused = '';
  const closeButton = {focus() {throw new Error('the hidden close button must not retain focus');}};
  try {
    withStorage(saved, () => {
      for (const target of ['sample-selected.png', 'sampleBatch-b1', 'sampleSidebarToggle']) {
        global.document = {activeElement: closeButton, getElementById(id) {
          if (id === 'sampleSidebar') return {contains: element => element === closeButton};
          if (id === target) return {focus(options) {assert.deepEqual(options, {preventScroll: true}); focused = id;}};
          return null;
        }};
        const value = app(); value.previews = [{path: 'selected.png'}]; value.sampleBatchId = 'b1';
        value.previewInfoOpen = true; value._sampleSidebarInspecting = true;
        value.sampleSidebarView = {key: 'selected.png', scale: 2, x: 40, y: 20};
        value.closeSampleSidebarPreview();
        assert.equal(value.sampleSidebarVisible, true); assert.equal(value.sampleSidebarOpen, false);
        assert.equal(value.sampleSidebarActive, false); assert.equal(value.previewStep, 0);
        assert.equal(value.previewInfoOpen, false); assert.equal(value._sampleSidebarInspecting, false);
        assert.deepEqual(value.sampleSidebarView, {key: '', scale: 1, x: 0, y: 0});
        assert.equal(saved.writes.length, 0, 'dismissing a preview must not save a feature preference');
        assert.equal(focused, target);
      }
    });
  } finally {global.document = previousDocument;}
});

test('preference loading accepts only booleans and supported sorting values', () => {
  for (const [savedValue, expected] of [
    [{sidebar: false, viewerTimeline: false, sort: 'asc'}, {sidebar: false, viewerTimeline: false, sort: 'asc'}],
    [{sidebar: 'false', viewerTimeline: 0, sort: 'ASC'}, {sidebar: true, viewerTimeline: true, sort: 'desc'}],
    [{sidebar: true, viewerTimeline: false, sort: 'desc'}, {sidebar: true, viewerTimeline: false, sort: 'desc'}],
    [{sidebar: false, viewerTimeline: null, sort: 1}, {sidebar: false, viewerTimeline: true, sort: 'desc'}],
    [{sort: 'asc'}, {sidebar: true, viewerTimeline: true, sort: 'asc'}],
  ]) {
    withStorage(storage(JSON.stringify(savedValue)), () => assert.deepEqual(settings(app()), expected));
  }
});

test('empty, malformed and unrelated stored values leave the default controls usable', () => {
  for (const stored of [null, '', '{invalid json', 'null', '[]', '42', '"unrelated"']) {
    withStorage(storage(stored), () => {
      const value = app();
      assert.deepEqual(settings(value), {sidebar: true, viewerTimeline: true, sort: 'desc'}, String(stored));
      assert.doesNotThrow(() => value.togglePreviewViewTimeline());
      assert.equal(value.previewViewTimelineVisible, false);
    });
  }
});

test('the removed overview thumbnail preference does not hide the new sidebar or reset viewer preferences', () => {
  withStorage(storage(JSON.stringify({overviewTimeline: false, viewerTimeline: false, sort: 'asc', comparisonLayout: 'vertical'})), () => {
    const value = app();
    assert.deepEqual(settings(value), {sidebar: true, viewerTimeline: false, sort: 'asc'});
    assert.equal(value.previewComparisonLayout, 'vertical');
  });
});

test('storage read and write failures do not interrupt reset, timeline controls or sorting', () => {
  const unavailable = {getItem() {throw new Error('storage is blocked');}, setItem() {throw new Error('quota exceeded');}};
  withStorage(unavailable, () => {
    const value = app();
    assert.doesNotThrow(() => value.resetSampleBrowser());
    assert.doesNotThrow(() => value.toggleSampleSidebar());
    assert.doesNotThrow(() => value.togglePreviewViewTimeline());
    assert.doesNotThrow(() => value.setSampleBatchSort('asc'));
    assert.deepEqual(settings(value), {sidebar: false, viewerTimeline: false, sort: 'asc'});
  });
});

test('comparison layout restores only the two supported orientations', () => {
  for (const [layout, expected] of [['horizontal', 'horizontal'], ['vertical', 'vertical'], ['grid', 'horizontal'], [null, 'horizontal']]) {
    withStorage(storage(JSON.stringify({comparisonLayout: layout})), () => {
      const value = app();
      assert.equal(value.previewComparisonLayout, expected);
      value.resetSampleBrowser();
      assert.equal(value.previewComparisonLayout, expected);
    });
  }
});

test('changing comparison orientation preserves all four panes and saves the choice without rebuilding images', () => {
  const saved = storage(), previousDocument = global.document;
  const classes = new Set();
  const items = Array.from({length: 4}, () => {
    const properties = new Map();
    return {style: {setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key), getPropertyValue: key => properties.get(key)},
      querySelector: () => ({naturalWidth: 1024, naturalHeight: 1024})};
  });
  const panes = {scrollLeft: 250, scrollTop: 120, clientWidth: 1400, clientHeight: 700,
    querySelectorAll: () => items,
    classList: {toggle: (key, value) => value ? classes.add(key) : classes.delete(key)}};
  const references = {parentElement: panes, children: [{}, {}, {}], replaceChildren() {}};
  global.document = {getElementById: id => id === 'previewReferencePanes' ? references : null};
  try {
    withStorage(saved, () => {
      const value = app(); value.previewStep = 4;
      value.constrainPreviewView = value.syncPreviewPromptBar = () => {};
      value._layoutPreviewComparisonPanes(4);
      assert(items.every(item => parseFloat(item.style.getPropertyValue('--preview-pane-width')) > 0));
      assert.equal(classes.has('is-vertical'), false);
      value.setPreviewComparisonLayout('vertical');
      assert.equal(classes.has('is-vertical'), true);
      assert(items.every(item => parseFloat(item.style.getPropertyValue('--preview-pane-height')) === panes.clientHeight), 'four vertical images keep their individual fit size and scroll');
      const four = items.splice(2);
      value._layoutPreviewComparisonPanes(2);
      const pairHeight = items.reduce((sum, item) => sum + parseFloat(item.style.getPropertyValue('--preview-pane-height')), 12);
      assert(pairHeight <= panes.clientHeight, 'two vertical images fit in the viewport together');
      items.push(...four);
      assert.equal(panes.scrollLeft, 0); assert.equal(panes.scrollTop, 0);
      assert.equal(value.previewStep, 4);
      assert.equal(saved.writes.at(-1).comparisonLayout, 'vertical');
      assert.equal(app().previewComparisonLayout, 'vertical');
      value.setPreviewComparisonLayout('horizontal');
      assert.equal(classes.has('is-vertical'), false);
      value.setPreviewComparisonLayout('grid');
      assert.equal(saved.writes.length, 2);
      assert.equal(references.children.length, 3);
    });
  } finally {global.document = previousDocument;}
});
