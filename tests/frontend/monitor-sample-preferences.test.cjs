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
  return {overviewTimeline: value.sampleTimelineVisible, viewerTimeline: value.previewViewTimelineVisible,
    sort: value.sampleBatchSortDir};
}

test('both timeline controls and sorting save independent preferences without changing the selected image', () => {
  const saved = storage();
  withStorage(saved, () => {
    const value = app(); value.previewStep = 4; value.sampleBatchId = 'selected-batch';
    value.renderDashboard = () => {};
    value.toggleSampleTimeline({currentTarget: {checked: false}});
    assert.deepEqual(settings(value), {overviewTimeline: false, viewerTimeline: true, sort: 'desc'});
    value.togglePreviewViewTimeline({currentTarget: {checked: false}});
    assert.deepEqual(settings(value), {overviewTimeline: false, viewerTimeline: false, sort: 'desc'});
    value.toggleSampleTimeline({currentTarget: {checked: true}});
    assert.deepEqual(settings(value), {overviewTimeline: true, viewerTimeline: false, sort: 'desc'});
    value.setSampleBatchSort('asc');
    assert.deepEqual(saved.writes, [
      {overviewTimeline: false, viewerTimeline: true, sort: 'desc', comparisonLayout: 'horizontal'},
      {overviewTimeline: false, viewerTimeline: false, sort: 'desc', comparisonLayout: 'horizontal'},
      {overviewTimeline: true, viewerTimeline: false, sort: 'desc', comparisonLayout: 'horizontal'},
      {overviewTimeline: true, viewerTimeline: false, sort: 'asc', comparisonLayout: 'horizontal'},
    ]);
    assert.equal(value.previewStep, 4);
    assert.equal(value.sampleBatchId, 'selected-batch');
    value.setSampleBatchSort('asc'); value.setSampleBatchSort('invalid');
    assert.equal(saved.writes.length, 4, 'unchanged or invalid sorting requests do not overwrite preferences');
  });
});

test('saved timeline visibility and sorting restore in a new browser state and after a run reset', () => {
  const expected = {overviewTimeline: false, viewerTimeline: true, sort: 'asc'};
  const saved = storage(JSON.stringify(expected));
  withStorage(saved, () => {
    const value = app();
    assert.deepEqual(settings(value), expected);
    value.sampleTimelineVisible = true; value.previewViewTimelineVisible = false; value.sampleBatchSortDir = 'desc';
    value.resetSampleBrowser();
    assert.deepEqual(settings(value), expected, 'changing runs restores the saved layout');
    assert.deepEqual(settings(app()), expected, 'a fresh monitor state uses the same saved choices');
    assert.equal(saved.writes.length, 0, 'restoring preferences does not write back to storage');
  });
});

test('preference loading accepts only booleans and the two supported sorting values', () => {
  for (const [savedValue, expected] of [
    [{overviewTimeline: false, viewerTimeline: false, sort: 'asc'}, {overviewTimeline: false, viewerTimeline: false, sort: 'asc'}],
    [{overviewTimeline: 'false', viewerTimeline: 0, sort: 'ASC'}, {overviewTimeline: true, viewerTimeline: true, sort: 'desc'}],
    [{overviewTimeline: true, viewerTimeline: false, sort: 'desc'}, {overviewTimeline: true, viewerTimeline: false, sort: 'desc'}],
    [{overviewTimeline: false, viewerTimeline: null, sort: 1}, {overviewTimeline: false, viewerTimeline: true, sort: 'desc'}],
    [{sort: 'asc'}, {overviewTimeline: true, viewerTimeline: true, sort: 'asc'}],
  ]) {
    withStorage(storage(JSON.stringify(savedValue)), () => assert.deepEqual(settings(app()), expected));
  }
});

test('empty, malformed and unrelated stored values leave the default controls usable', () => {
  for (const stored of [null, '', '{invalid json', 'null', '[]', '42', '"unrelated"']) {
    withStorage(storage(stored), () => {
      const value = app();
      assert.deepEqual(settings(value), {overviewTimeline: true, viewerTimeline: true, sort: 'desc'}, String(stored));
      assert.doesNotThrow(() => value.togglePreviewViewTimeline());
      assert.equal(value.previewViewTimelineVisible, false);
    });
  }
});

test('storage read and write failures do not interrupt reset, timeline controls or sorting', () => {
  const unavailable = {getItem() {throw new Error('storage is blocked');}, setItem() {throw new Error('quota exceeded');}};
  withStorage(unavailable, () => {
    const value = app();
    assert.doesNotThrow(() => value.resetSampleBrowser());
    assert.doesNotThrow(() => value.toggleSampleTimeline());
    assert.doesNotThrow(() => value.togglePreviewViewTimeline());
    assert.doesNotThrow(() => value.setSampleBatchSort('asc'));
    assert.deepEqual(settings(value), {overviewTimeline: false, viewerTimeline: false, sort: 'asc'});
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
