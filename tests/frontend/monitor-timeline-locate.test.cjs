const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

function sample(index) {
  return {name: `${index}.png`, path: `${index}.png`, url: `/images/${index}.png`, sample: {
    batch_id: `b${index}`, batch_label: `Epoch ${index}`, batch_status: 'complete',
    prompt_id: 'p1', prompt_label: 'Prompt 1', seed: 42, condition_key: 'settings',
    metadata_source: 'recorded', comparable: true, params: {prompt: 'fox', negative_prompt: ''},
  }};
}

function app(count = 100) {
  const value = composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [], previewsVersion: 0, previewStep: 0,
    weakNetworkMode: false, currentOutputRunDir: 'output/test', monitorData: {},
    t(key) {return key;}, renderDashboard() {}, _refreshIconHtml() {},
  });
  value.resetSampleBrowser(); value._replacePreviewItems(Array.from({length: count}, (_, index) => sample(index + 1)));
  return value;
}

function railFixture({itemLeft = 4000, itemWidth = 40, scrollLeft = 0, scale = 1, width = 200, scrollWidth = 10000} = {}) {
  const rail = {hidden: false, clientWidth: width, offsetWidth: width, scrollWidth, scrollLeft,
    getBoundingClientRect() {return {left: 30, right: 30 + width * scale, width: width * scale};},
    querySelector(selector) {assert.equal(selector, '[aria-pressed="true"]'); return selected;}};
  const selected = {getBoundingClientRect() {
    const left = 30 + (itemLeft - rail.scrollLeft) * scale;
    return {left, right: left + itemWidth * scale};
  }};
  return rail;
}

function locate(value, rail) {
  const previous = global.document;
  global.document = {...previous, getElementById(id) {assert.equal(id, 'previewLightboxTimeline'); return rail;}};
  try {value.centerPreviewViewTimeline();}
  finally {global.document = previous;}
}

test('the overview exposes an image sidebar while the viewer retains its thumbnails and locate action', () => {
  const value = app();
  const main = value._renderSamplesTab(key => value.t('monitor.' + key));
  const modal = value._previewLightboxHtml(key => value.t('monitor.' + key));
  assert.doesNotMatch(main, /sampleOverviewTimelineFrame|m-sample-timeline-item/);
  assert.match(main, /id="sampleSidebar" class="m-sample-sidebar"/);
  assert.match(main, /id="sampleSidebarToggle"/);
  assert.doesNotMatch(main, /sample-timeline-locate/);
  assert.match(modal, /id="previewLightboxTimelineFrame" class="preview-view-timeline-frame"[^>]* hidden>/);
  assert.match(modal, /:class="\{'is-collapsed': !previewViewTimelineVisible\}"/);
  assert.match(modal, /:inert="!previewViewTimelineVisible"/);
  const barStart = modal.indexOf('id="previewLightboxBar"');
  const locateStart = modal.indexOf('@click="centerPreviewViewTimeline()"');
  assert.ok(barStart < locateStart && locateStart < modal.indexOf('id="previewLightboxTimelineFrame"'));
  assert.match(app(1)._renderSamplesTab(key => key), /id="sampleSidebarToggle"/);
});

test('locating from the prompt bar scrolls only its target rail smoothly and respects reduced motion', () => {
  const value = app(2), previousMatchMedia = window.matchMedia;
  const rail = railFixture();
  const scrolls = []; rail.scrollTo = options => scrolls.push(options);
  try {
    window.matchMedia = () => ({matches: false});
    locate(value, rail);
    assert.deepEqual(scrolls.pop(), {left: 3920, behavior: 'smooth'});
    window.matchMedia = () => ({matches: true});
    locate(value, rail);
    assert.deepEqual(scrolls.pop(), {left: 3920, behavior: 'instant'});
  } finally {window.matchMedia = previousMatchMedia;}
});

test('locating centers the selected thumbnail for either sorting direction and preserves comparison and grid state', () => {
  for (const dir of ['asc', 'desc']) {
    const value = app(); value.sampleBatchSortDir = dir; value.sampleBatchId = 'b50'; value.previewStep = 49;
    value.pinPreviewReference(20); value.selectPreviewComparisonCurrent(49);
    const grid = {scrollTop: 730};
    const position = dir === 'asc' ? 49 : 50;
    const rail = railFixture({itemLeft: position * 80, itemWidth: 60, scrollLeft: 10, scale: 0.8});
    const before = {batch: value.sampleBatchId, step: value.previewStep, references: [...value.previewReferences],
      entries: [...value._previewReferenceEntries], grid: grid.scrollTop};
    value.renderDashboard = () => {throw new Error('locating must not rebuild the UI');};
    value._updatePreviewLightbox = () => {throw new Error('locating must not change the preview');};
    locate(value, rail);
    assert.ok(Math.abs(rail.scrollLeft - (position * 80 + 30 - 100)) < 0.00001);
    assert.equal(value.sampleBatchId, before.batch); assert.equal(value.previewStep, before.step);
    assert.equal(value.previewCompareActive, true); assert.deepEqual(value.previewReferences, before.references);
    assert.deepEqual(value._previewReferenceEntries, before.entries); assert.equal(grid.scrollTop, before.grid);
  }
});

test('locating handles visible items, scaled dialogs and both scroll boundaries', () => {
  const value = app(2);
  for (const [options, expected] of [
    [{itemLeft: 220, scrollLeft: 200}, 140],
    [{itemLeft: 180, scrollLeft: 100}, 100],
    [{itemLeft: 0, scrollLeft: 400}, 0],
    [{itemLeft: 9980, scrollLeft: 400, scale: 0.5}, 9800],
    [{itemLeft: 20, scrollLeft: 0, scrollWidth: 200}, 0],
  ]) {
    const rail = railFixture(options); locate(value, rail);
    assert.ok(Math.abs(rail.scrollLeft - expected) < 0.00001, JSON.stringify(options));
  }
  const rail = railFixture(); rail.hidden = true; locate(value, rail);
  assert.equal(rail.scrollLeft, 0);
});

test('the viewer hides the entire rail and restores focus if its locate button was focused', () => {
  const value = app(2), previous = global.document;
  let restored = false;
  const locate = {}, frame = {hidden: true, contains: element => element === locate};
  const timeline = {hidden: true, dataset: {}, scrollLeft: 0, contains: () => false,
    querySelector: () => null, querySelectorAll: () => []};
  global.document = {activeElement: null, getElementById(id) {
    if (id === 'previewLightboxTimeline') return timeline;
    if (id === 'previewLightboxTimelineFrame') return frame;
    if (id === 'previewLightbox') return {querySelector: () => ({focus() {restored = true;}})};
    return null;
  }};
  value._markPreviewViewReference = () => {};
  value._reconcilePreviewViewTimeline = () => {};
  try {
    value._updatePreviewViewTimeline([0, 1]);
    assert.equal(timeline.hidden, false); assert.equal(frame.hidden, false);
    global.document.activeElement = locate;
    value._updatePreviewViewTimeline([0]);
    assert.equal(timeline.hidden, true); assert.equal(frame.hidden, true); assert.equal(restored, true);
  } finally {global.document = previous;}
});

test('the viewer locate action stays in place and is disabled when its timeline cannot be located', () => {
  const value = app(2), previous = global.document;
  const locate = {hidden: false, disabled: true};
  const frame = {hidden: true, contains: () => false};
  const timeline = {hidden: true, dataset: {}, scrollLeft: 0, contains: () => false,
    querySelector: () => null, querySelectorAll: () => []};
  global.document = {activeElement: null, getElementById(id) {
    if (id === 'previewLightboxTimeline') return timeline;
    if (id === 'previewLightboxTimelineFrame') return frame;
    if (id === 'previewLightboxBar') return {querySelector: () => locate};
    return null;
  }};
  value._markPreviewViewReference = () => {};
  value._reconcilePreviewViewTimeline = () => {};
  try {
    value._updatePreviewViewTimeline([0, 1]);
    assert.equal(value.previewViewTimelineAvailable, true);
    assert.equal(locate.hidden, false); assert.equal(locate.disabled, false);
    value.togglePreviewViewTimeline();
    assert.equal(value.previewViewTimelineVisible, false);
    assert.equal(value.sampleSidebarVisible, true);
    assert.equal(locate.disabled, true);
    value.togglePreviewViewTimeline();
    assert.equal(locate.disabled, false);
    value.previewComparisonWaiting = true;
    value._updatePreviewViewTimeline([0, 1]);
    assert.equal(locate.disabled, true, 'there is no selected current thumbnail to locate while waiting');
    value.previewComparisonWaiting = false;
    value._updatePreviewViewTimeline([0]);
    assert.equal(value.previewViewTimelineAvailable, false);
    assert.equal(locate.disabled, true, 'a single image has no temporal rail to locate');
    assert.equal(locate.hidden, false, 'unavailable actions keep their place in the bar');
  } finally {global.document = previous;}
});

test('toggling the sidebar preserves the sample and does not rebuild the grid', () => {
  const value = app();
  const before = {batch: value.sampleBatchId, step: value.previewStep, previews: value.previews};
  value.renderDashboard = () => {throw new Error('the sidebar toggle must not rebuild loaded images');};
  value.toggleSampleSidebar();
  assert.equal(value.sampleSidebarVisible, false);
  assert.equal(value.sampleBatchId, before.batch); assert.equal(value.previewStep, before.step);
  assert.equal(value.previews, before.previews);
  value.toggleSampleSidebar();
  assert.equal(value.sampleSidebarVisible, true);
});
