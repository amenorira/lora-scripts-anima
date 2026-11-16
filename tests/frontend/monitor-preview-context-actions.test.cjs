const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

function image(epoch, seed = 42) {
  const params = {prompt: 'fox', negative_prompt: '', seed, architecture: 'anima', width: 512, height: 512,
    steps: 30, cfg_scale: 5, sampler: 'euler', scheduler: 'native'};
  return {name: `${epoch}.png`, path: `sample/${epoch}.png`, url: `/${epoch}.png`, sample: {
    batch_id: `b${epoch}`, batch_label: `Epoch ${epoch}`, batch_status: 'complete',
    prompt_id: 'fox', prompt_index: 0, seed, params, condition_key: 'same-settings',
    comparable: true, metadata_source: 'recorded',
  }};
}

function app(previews = [1, 2, 3, 4, 5].map(epoch => image(epoch))) {
  const value = composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [], previewsVersion: 0, previewStep: 0, currentOutputRunDir: 'output/test',
    t: key => key, renderDashboard() {}, _updatePreviewLightbox() {}, _focusPreviewPageNavigation() {},
  });
  value.resetSampleBrowser(); value._replacePreviewItems(previews); value.previewLightboxOpen = true;
  return value;
}

function target(value, index) {
  const preview = value.previews[index];
  return value.previewTimelineMenu = {key: value._previewItemKey(preview), batchId: value._sampleRecord(preview).batch_id,
    metadataKey: value._previewViewerMetadataKey(preview)};
}

test('context pin appends references and waits until compare explicitly selects the current image', () => {
  const value = app();
  assert.equal(value.previewStep, 4);
  target(value, 2);
  assert.equal(value.previewTimelineMenuAction('pin'), true);
  assert.deepEqual(value.previewReferences, [value.previews[2]]);
  assert.equal(value.previewStep, 4);
  assert.equal(value.previewComparisonWaiting, true);
  assert.equal(value.previewTimelineMenu, null);
  target(value, 0);
  assert.equal(value.previewTimelineMenuAction('pin'), true);
  assert.deepEqual(value.previewReferences, [value.previews[2], value.previews[0]]);
  assert.equal(value.previewStep, 4, 'pinning another thumbnail never selects a right image');
  assert.equal(value.previewComparisonWaiting, true);
  target(value, 1);
  assert.equal(value.previewTimelineMenuAction('compare'), true);
  assert.deepEqual(value.previewReferences, [value.previews[2], value.previews[0]]);
  assert.equal(value.previewStep, 1);
  assert.equal(value.previewComparisonWaiting, false);
  target(value, 3);
  assert.equal(value.previewTimelineMenuAction('pin'), true);
  assert.deepEqual(value.previewReferences, [value.previews[2], value.previews[0], value.previews[3]]);
  assert.equal(value.previewStep, 1);
  assert.equal(value.previewComparisonWaiting, true, 'adding a reference returns to the empty right-side placeholder');
  target(value, 1);
  assert.equal(value._previewTimelineMenuActions().compare, true, 'the previous current file may be selected explicitly again');
  assert.equal(value.previewTimelineMenuAction('compare'), true);
  assert.equal(value.previewComparisonWaiting, false);
});

test('context unpin removes only its fixed file while cancel exits the whole comparison', () => {
  const value = app();
  for (const index of [2, 0, 3]) {
    target(value, index); assert.equal(value.previewTimelineMenuAction('pin'), true);
  }
  target(value, 1); value.previewTimelineMenuAction('compare');
  target(value, 0);
  assert.deepEqual(value._previewTimelineMenuActions(), {pin: false, unpin: true, compare: false, cancel: true});
  assert.equal(value.previewTimelineMenuAction('unpin'), true);
  assert.deepEqual(value.previewReferences, [value.previews[2], value.previews[3]]);
  assert.equal(value.previewCompareActive, true);
  assert.equal(value.previewComparisonWaiting, false);
  assert.equal(value.previewStep, 1);
  target(value, 2);
  assert.equal(value.previewTimelineMenuAction('pin'), false, 'an already fixed file cannot be duplicated');
  assert.deepEqual(value.previewReferences, [value.previews[2], value.previews[3]]);
  assert.equal(value.previewTimelineMenuAction('cancel'), true);
  assert.equal(value.previewCompareActive, false);
  assert.equal(value.previewComparisonWaiting, false);
  assert.deepEqual(value.previewReferences, []);
  assert.equal(value.previewStep, 1);
});

test('unpinning the last reference also clears the waiting placeholder', () => {
  const value = app(); target(value, 2); value.previewTimelineMenuAction('pin');
  target(value, 2);
  assert.equal(value.previewTimelineMenuAction('unpin'), true);
  assert.equal(value.previewCompareActive, false);
  assert.equal(value.previewComparisonWaiting, false);
  assert.deepEqual(value.previewReferences, []);
  assert.equal(value.previewStep, 4);
});

test('comparing without a reference fixes the displayed file and shows the context target', () => {
  const value = app(); target(value, 0);
  assert.equal(value.previewTimelineMenuAction('compare'), true);
  assert.equal(value.previewReferences[0], value.previews[4]); assert.equal(value.previewStep, 0);
  assert.equal(value.previewComparisonWaiting, false);
  target(value, 0);
  assert.equal(value._previewTimelineMenuActions().compare, false, 'the displayed target is already on the right');
  value.previewStep = 4; value._syncPreviewReference(); target(value, 4);
  assert.equal(value._previewTimelineMenuActions().pin, false, 'the fixed file cannot be fixed again');
});

test('a fully unavailable current image cannot be fixed directly or implicitly by a compare action', () => {
  const value = app();
  value.previewImageError = true; value.previewImageAvailable = false;
  target(value, value.previewStep);
  assert.equal(value._previewTimelineMenuActions().pin, false);
  assert.equal(value.previewTimelineMenuAction('pin'), false);
  target(value, 0);
  assert.equal(value._previewTimelineMenuActions().pin, true, 'other timeline targets remain independently selectable');
  assert.equal(value._previewTimelineMenuActions().compare, false, 'compare cannot implicitly pin the failed current image');
  value.previewImageAvailable = true;
  assert.equal(value._previewTimelineMenuActions().compare, true, 'a usable fallback thumbnail permits comparison');
});

test('stale targets and different seed identities cannot be used for a context comparison', () => {
  const value = app(); target(value, 1);
  value.previews[1].sample.params.cfg_scale = 7;
  assert.equal(value.previewTimelineMenuAction('pin'), false);
  assert.equal(value.previewCompareActive, false);
  const otherSeed = app([image(1), image(2, 99)]); target(otherSeed, 0);
  assert.deepEqual(otherSeed._previewTimelineMenuActions(), {pin: false, unpin: false, compare: false, cancel: false});
  assert.equal(otherSeed.previewTimelineMenuAction('compare'), false);
  assert.deepEqual(otherSeed.previewReferences, []);
});

test('legacy filename-only histories support the same explicit context actions without inventing parameters', () => {
  const previews = [1, 2, 3].map(epoch => {
    const name = `legacy_e${String(epoch).padStart(6, '0')}_00_20261114120000_2333.png`;
    return {name, path: `sample/${name}`, url: `/${name}`};
  });
  const value = app(previews); target(value, 0);
  assert.equal(value.previewTimelineMenuAction('pin'), true);
  assert.equal(value.previewReferences[0], previews[0]); assert.equal(value.previewStep, 2);
  assert.equal(value.previewComparisonWaiting, true);
  assert.equal(value._previewComparisonKey(previews[0]), '');
  assert.equal(value._sampleRecord(previews[0]).comparable, false);
  target(value, 1);
  assert.equal(value.previewTimelineMenuAction('compare'), true);
  assert.equal(value.previewReferences[0], previews[0]); assert.equal(value.previewStep, 1);
  assert.equal(value.previewComparisonWaiting, false);
  target(value, 2); assert.equal(value.previewTimelineMenuAction('pin'), true);
  assert.deepEqual(value.previewReferences, [previews[0], previews[2]]);
  assert.equal(value.previewStep, 1);
  assert.ok(previews.every(preview => preview.sample === undefined));
});

test('clicking fixed thumbnails only locates their existing panes and never selects or reorders them', () => {
  const value = app(), located = [];
  value.pinPreviewReference(3); value.pinPreviewReference(1);
  value.selectPreviewComparisonCurrent(0);
  value.locatePreviewReference = key => located.push(key);
  value._updatePreviewLightbox = () => {throw new Error('locating must not rebuild comparison images');};
  for (const index of [1, 3, 1, 3]) {
    value.selectPreviewTimelineByKey(value.previews[index].path);
    assert.equal(value.previewStep, 0);
    assert.equal(value.sampleBatchId, 'b1');
    assert.equal(value.previewComparisonWaiting, false);
    assert.deepEqual(value.previewReferences, [value.previews[3], value.previews[1]]);
    assert.equal(value.selectPreviewComparisonCurrent(index), false, 'the model also rejects fixed current images');
  }
  assert.deepEqual(located, [1, 3, 1, 3].map(index => value.previews[index].path));
  value.pinPreviewReference(0, false);
  value.selectPreviewTimeline(0);
  assert.equal(value.previewComparisonWaiting, true, 'locating preserves the empty current placeholder');
  assert.equal(value.previewStep, 0);
});

test('arrows, timeline Home End and page input share the unpinned visual sequence in both sort orders', () => {
  for (const direction of ['asc', 'desc']) {
    const value = app([1, 2, 3, 4, 5, 6, 7].map(epoch => image(epoch)));
    value.setSampleBatchSort(direction);
    for (const index of [2, 3, 5]) value.pinPreviewReference(index);
    const available = direction === 'asc' ? [0, 1, 4, 6] : [6, 4, 1, 0];
    assert.deepEqual(value._previewLightboxNavigationIndices(), available);
    assert.equal(value._previewLightboxDisplayIndices().length, 7, 'fixed thumbnails remain in the rail');
    value.selectPreviewTimeline(available[0]);
    assert.equal(value._previewLightboxNavigationTarget(-1), -1);
    for (const expected of available.slice(1)) {
      value.previewLightboxKeydown({key: 'ArrowRight', preventDefault() {}, stopPropagation() {}});
      assert.equal(value.previewStep, expected);
    }
    value.previewLightboxNav(1);
    assert.equal(value.previewStep, available.at(-1), 'the end never wraps back to a fixed image');
    for (const expected of available.slice(0, -1).reverse()) {
      value.previewLightboxNav(-1);
      assert.equal(value.previewStep, expected);
    }
    const rail = {querySelector: () => ({focus() {}})};
    for (const [key, expected] of [['End', available.at(-1)], ['Home', available[0]], ['ArrowRight', available[1]], ['ArrowLeft', available[0]]]) {
      value.previewViewTimelineKeydown({key, currentTarget: rail, preventDefault() {}, stopPropagation() {}});
      assert.equal(value.previewStep, expected);
    }
    for (let page = 1; page <= available.length; page++) {
      const input = {value: '', select() {}};
      value.beginPreviewPageEdit({currentTarget: input}); input.value = String(page);
      value.commitPreviewPageEdit({currentTarget: input});
      assert.equal(value.previewStep, available[page - 1]);
      assert.equal(value._previewPagePosition(), page);
    }
    value.unpinPreviewReference(value.previews[2].path);
    assert.ok(value._previewLightboxNavigationIndices().includes(2), 'unpin restores the file to page navigation');
    value.selectPreviewTimeline(2);
    assert.equal(value.previewStep, 2);
  }
});

test('waiting navigation scans past adjacent fixed images and all-fixed sequences have no current candidates', () => {
  for (const direction of ['asc', 'desc']) {
    const value = app(); value.setSampleBatchSort(direction);
    value.selectPreviewComparisonCurrent(2);
    for (const index of [1, 2, 3]) value.pinPreviewReference(index);
    assert.equal(value.previewComparisonWaiting, true);
    assert.equal(value._previewLightboxNavigationTarget(1), direction === 'asc' ? 4 : 0);
    assert.equal(value._previewLightboxNavigationTarget(-1), direction === 'asc' ? 0 : 4);
    value.previewLightboxNav(1);
    assert.equal(value.previewStep, direction === 'asc' ? 4 : 0);
    assert.equal(value.previewComparisonWaiting, false);
    for (const index of [0, 4]) value.pinPreviewReference(index);
    const previous = value.previewStep;
    assert.deepEqual(value._previewLightboxNavigationIndices(), []);
    value.previewLightboxNav(-1); value.previewLightboxNav(1); value.openPreviewPageEditor();
    assert.equal(value.previewStep, previous);
    assert.equal(value.previewComparisonWaiting, true);
    assert.equal(value.previewPageEditing, false);
    value.stopPreviewComparison();
    assert.equal(value._previewLightboxNavigationIndices().length, 5);
  }
});

test('comparison counter excludes fixed images and disables page controls when every file is fixed', () => {
  const value = app(), display = {}, total = {}, input = {}, previous = {}, next = {};
  const nodes = {previewLightboxCounter: {}, previewLightboxCounterDisplay: display,
    previewLightboxCounterTotal: total, previewLightboxPage: input,
    previewLightbox: {querySelector: selector => selector.endsWith('.prev') ? previous : selector.endsWith('.next') ? next : null}};
  const originalDocument = global.document;
  global.document = {getElementById: id => nodes[id] || null};
  value._displayPreviewImage = () => {}; value._updatePreviewReferencePanes = () => {};
  value.constrainPreviewView = () => {};
  let timeline;
  value._updatePreviewViewTimeline = indices => {timeline = indices;};
  try {
    value.pinPreviewReference(4, false); value.pinPreviewReference(2, false); value.selectPreviewComparisonCurrent(3);
    window.monitorArtifactsRenderMixin._updatePreviewLightbox.call(value);
    assert.equal(display.textContent, '1'); assert.equal(total.textContent, '3');
    assert.equal(previous.disabled, true); assert.equal(next.disabled, false);
    assert.deepEqual(timeline, [4, 3, 2, 1, 0]);
    for (const index of [0, 1, 3]) value.pinPreviewReference(index, false);
    window.monitorArtifactsRenderMixin._updatePreviewLightbox.call(value);
    assert.equal(display.textContent, '—'); assert.equal(total.textContent, '0');
    assert.equal(display.disabled, true); assert.equal(input.disabled, true);
    assert.equal(previous.disabled, true); assert.equal(next.disabled, true);
    assert.deepEqual(timeline, [4, 3, 2, 1, 0]);
  } finally {global.document = originalDocument;}
});

test('locating a fixed image scrolls only the main viewport, accounting for entrance scale and reduced motion', () => {
  const value = app(), calls = [];
  value.pinPreviewReference(0, false); value.selectPreviewComparisonCurrent(1);
  const viewport = {offsetWidth: 400, clientWidth: 400, clientHeight: 200, scrollWidth: 1400, scrollHeight: 1000,
    scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({left: 100, top: 50, width: 320, height: 160}),
    scrollTo(options) {calls.push(options); this.scrollLeft = options.left; this.scrollTop = options.top;}};
  let rect = {left: 500, right: 660, top: 290, bottom: 370, width: 160, height: 80};
  value._previewReferenceMedia = {entries: new Map([[value.previews[0].path, {pane: {getBoundingClientRect: () => rect}}]])};
  const originalDocument = global.document, originalMatchMedia = window.matchMedia;
  global.document = {getElementById: id => id === 'previewLightboxViewport' ? viewport : null};
  window.matchMedia = () => ({matches: false});
  try {
    value.selectPreviewTimeline(0);
    assert.deepEqual(calls[0], {left: 300, top: 200, behavior: 'smooth'});
    assert.equal(value.previewStep, 1); assert.equal(value.previewComparisonWaiting, false);
    rect = {left: 120, right: 280, top: 70, bottom: 150, width: 160, height: 80};
    value.selectPreviewTimeline(0);
    assert.equal(calls.length, 1, 'a fully visible fixed pane stays in place');
    window.matchMedia = () => ({matches: true});
    rect = {left: -500, right: -340, top: -290, bottom: -210, width: 160, height: 80};
    value.selectPreviewTimeline(0);
    assert.deepEqual(calls[1], {left: 0, top: 0, behavior: 'instant'});
  } finally {global.document = originalDocument; window.matchMedia = originalMatchMedia;}
});
