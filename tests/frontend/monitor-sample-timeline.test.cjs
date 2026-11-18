const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

function image(batch, prompt = 'fox', expected = 1) {
  return {name: `${batch}-${prompt}.png`, path: `${batch}-${prompt}.png`, url: `/images/${batch}-${prompt}.png`, sample: {
    batch_id: batch, batch_label: batch, batch_expected: expected, batch_status: 'complete',
    prompt_id: prompt, prompt_label: prompt, seed: 42, condition_key: 'settings', comparable: true,
  }};
}

function app(previews) {
  const value = composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [], previewsVersion: 0, previewStep: 0,
    _previewMediaQueue: [], _previewMediaObjectUrls: [], _previewMediaGeneration: 0,
    weakNetworkMode: false, currentOutputRunDir: 'output/test', monitorData: {},
    t(key) { return ({'monitor.sampleBatchCount': '{n} images', 'monitor.sampleSeed': 'Seed {n}', 'monitor.samplePrompt': 'Prompt {n}',
      'monitor.sampleEpoch': 'Epoch {n}', 'monitor.sampleStep': 'Step {n}'})[key] || key; },
    renderDashboard() {}, _refreshIconHtml() {return '';}, _updatePreviewLightbox() {},
  });
  value.resetSampleBrowser(); value._replacePreviewItems(previews);
  return value;
}

test('single-image history uses one compact grid with every sampling point', () => {
  const value = app([image('step-1'), image('step-2'), image('step-3')]);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.equal((html.match(/class="m-sample-batch"/g) || []).length, 3);
  assert.equal((html.match(/class="preview-grid-item"/g) || []).length, 3);
  assert.match(html, /id="sampleSidebar"/);
  assert.equal((html.match(/class="preview-grid-item-label"/g) || []).length, 3);
  assert.match(html, /class="preview-thumb-frame"[\s\S]*?<span class="preview-grid-item-label" data-sample-loss-batch="step-1" data-sample-loss-detail="" data-sample-loss-status="" title="step-1"><strong>step-1<\/strong><\/span><\/span><\/button>/);
  assert.doesNotMatch(html, /m-sample-batch-heading/);
  assert.doesNotMatch(html, /m-sample-timeline-count/);
  assert.doesNotMatch(html, /Seed 42/);
});

test('single-image cards show epoch and step below the image with numbered prompt captions', () => {
  const first = image('step-1', 'fox'), second = image('step-2', 'cat');
  first.sample.batch_label = 'Epoch 1 · Step 400';
  second.sample.batch_label = 'Epoch 2 · Step 800';
  const value = app([first, second]);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.match(html, /class="preview-grid-item-label" data-sample-loss-batch="step-1" data-sample-loss-detail="Prompt 1" data-sample-loss-status="" title="Epoch 1 Step 400\nPrompt 1"><span class="m-sample-stage"><strong>Epoch 1<\/strong><small>Step 400<\/small><\/span><small class="m-sample-caption-detail">Prompt 1<\/small>/);
  assert.match(html, /class="preview-grid-item-label" data-sample-loss-batch="step-2" data-sample-loss-detail="Prompt 1" data-sample-loss-status="" title="Epoch 2 Step 800\nPrompt 1"><span class="m-sample-stage"><strong>Epoch 2<\/strong><small>Step 800<\/small><\/span><small class="m-sample-caption-detail">Prompt 1<\/small>/);
});

test('multi-image history starts with one cover card per sampling point', () => {
  const value = app([image('step-1', 'fox', 2), image('step-1', 'cat', 2), image('step-2', 'fox', 2), image('step-2', 'cat', 2)]);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.equal((html.match(/class="m-sample-batch"/g) || []).length, 2);
  assert.equal((html.match(/class="preview-grid-item m-sample-batch-cover"/g) || []).length, 2);
  assert.doesNotMatch(html, /class="m-sample-expansion"/);
  assert.equal((html.match(/aria-expanded="false"/g) || []).length, 2);
  assert.doesNotMatch(html, /m-sample-timeline-image/);
  assert.match(html, /fox/); assert.match(html, /cat/);
  assert.match(html, /m-sample-stack is-stack/);
  assert.match(html, /class="m-sample-card-count" aria-hidden="true">×2/);
  assert.doesNotMatch(html, /Seed 42/);
});

test('multi-prompt covers retain bounded real-image layers without a duplicate thumbnail rail', () => {
  const previews = ['fox', 'cat', 'bird', 'dog', 'horse', 'fish', 'lion', 'owl', 'bear', 'rabbit']
    .map(prompt => image('step-1', prompt, 10));
  previews.push(image('step-2', 'fox'));
  const value = app(previews);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  const item = html.match(/<button type="button" id="sampleBatch-step-1"[\s\S]*?<\/button>/)?.[0];
  assert.match(item, /m-sample-stack is-stack/);
  assert.match(item, /class="preview-thumb-frame m-sample-card-image is-cover" data-preview-path="step-1-fox.png"/);
  assert.match(item, /class="preview-thumb-frame m-sample-card-image is-behind-1" data-preview-path="step-1-cat.png"/);
  assert.match(item, /class="preview-thumb-frame m-sample-card-image is-behind-2" data-preview-path="step-1-bird.png"/);
  assert.equal((item.match(/class="preview-thumb-frame m-sample-card-image /g) || []).length, 3);
  assert.match(item, /class="m-sample-card-count" aria-hidden="true">×10/);
  assert.match(item, /10 images/);
  assert.doesNotMatch(html, /sampleOverviewTimelineFrame|m-sample-timeline-item/);
});

test('grid cards preserve both epoch and step', () => {
  const first = image('step-1'), second = image('step-2');
  second.sample.batch_label = 'Epoch 100 · Step 40000';
  const value = app([first, second]);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.match(html, /<strong>Epoch 100<\/strong><small>Step 40000<\/small>/);
});

test('sorting retains overview presentation order and selection', () => {
  const value = app([image('step-1', 'fox', 2), image('step-1', 'cat', 2), image('step-2', 'fox', 2), image('step-2', 'cat', 2)]);
  value.sampleBatchId = 'step-1';
  value.setSampleBatchSort('desc');
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  const groups = [...html.matchAll(/<section class="m-sample-batch"[^>]*data-batch-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(groups, ['step-2', 'step-1']);
  value.toggleSampleSortDirection();
  const ascending = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.deepEqual([...ascending.matchAll(/class="m-sample-batch"[^>]*data-batch-id="([^"]+)"/g)].map(match => match[1]), ['step-1', 'step-2']);
  assert.equal(value.sampleBatchId, 'step-1');
  assert.match(html, /id="sampleBatchSort"/);
  assert.match(html, /id="sampleBatchSortDirection"[^>]+@click="toggleSampleSortDirection\(\)"/);
  assert.equal((html.match(/class="preview-grid-item m-sample-batch-cover"/g) || []).length, 2);
});

test('passive overview scrolling pauses following without scanning cards or moving the selected sample and timeline', () => {
  for (const dir of ['asc', 'desc']) {
    const value = app([image('step-1'), image('step-2'), image('step-3')]);
    value.sampleBatchSortDir = dir; value.sampleBatchId = 'step-2'; value.previewStep = 1;
    value._sampleScrollAnchor = {key: 'old-anchor'};
    const rail = {scrollLeft: 333};
    const grid = {scrollTop: dir === 'desc' ? 200 : 0, clientHeight: 100, scrollHeight: 300,
      closest() {return {querySelector() {return rail;}};},
      querySelectorAll() {throw new Error('passive scrolling must not enumerate cards');},
      getBoundingClientRect() {throw new Error('passive scrolling must not measure card geometry');}};
    value._activateOverviewBatch = () => {throw new Error('scrolling history must not change selection');};
    value.sampleOverviewScroll({currentTarget: grid});
    assert.equal(value._sampleOverviewAtEnd, false);
    assert.equal(value.sampleBatchId, 'step-2'); assert.equal(value.previewStep, 1);
    assert.equal(value._sampleScrollAnchor, null); assert.equal(rail.scrollLeft, 333);
  }
});

test('returning to the latest edge keeps selection and the rail in place', () => {
  for (const dir of ['asc', 'desc']) {
    const value = app([image('step-1'), image('step-2'), image('step-3')]);
    value.sampleBatchSortDir = dir; value.sampleBatchId = 'step-1'; value.previewHasNew = true;
    const rail = {scrollLeft: 333}; let removed = false;
    const panel = {querySelector(selector) {return selector === '#sampleLatestBatch' ? {remove() {removed = true;}} : rail;}};
    const grid = {scrollTop: dir === 'desc' ? 0 : 200, clientHeight: 100, scrollHeight: 300, closest() {return panel;}};
    const selections = [];
    value._activateOverviewBatch = (batch, target, reveal) => {
      assert.equal(target, panel); selections.push({id: batch.id, reveal}); value.sampleBatchId = batch.id;
    };
    value.sampleOverviewScroll({currentTarget: grid});
    value.sampleOverviewScroll({currentTarget: grid});
    assert.equal(value._sampleOverviewAtEnd, true);
    assert.deepEqual(selections, [], 'passive scrolling never changes the selected sample');
    assert.equal(value.sampleBatchId, 'step-1');
    assert.equal(value.previewHasNew, false); assert.equal(removed, true); assert.equal(rail.scrollLeft, 333);
  }
});

test('history expansion and explicit historical jumps protect selection at the latest edge', () => {
  const value = app([image('step-1'), image('step-2')]);
  value.sampleBatchId = 'step-1'; value.previewHasNew = true;
  const grid = {scrollTop: 0, clientHeight: 300, scrollHeight: 300};
  value._activateOverviewBatch = () => {throw new Error('an explicit historical selection must survive its scroll');};
  value._sampleExpansionPausedFollow = true;
  value.sampleOverviewScroll({currentTarget: grid});
  assert.equal(value.sampleBatchId, 'step-1'); assert.equal(value.previewHasNew, true);
  value._sampleExpansionPausedFollow = false; value._sampleOverviewJumpId = 'step-1';
  value.sampleOverviewScroll({currentTarget: grid});
  assert.equal(value._sampleOverviewJumpId, '');
  assert.equal(value.sampleBatchId, 'step-1'); assert.equal(value.previewHasNew, true);
});

test('an unknown single-image batch stays compact without hiding failures', () => {
  const first = image('step-1'); first.sample.batch_expected = null; first.sample.batch_status = 'unknown';
  const value = app([first]); value.monitorData.state = 'RUNNING';
  let html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.doesNotMatch(html, /m-sample-batch-cover/);
  const second = image('step-2'); second.sample.batch_expected = null; second.sample.batch_status = 'failed';
  value._replacePreviewItems([first, second]); value.previewsVersion++;
  html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.doesNotMatch(html, /m-sample-batch-cover/);
  assert.match(html, /monitor\.sampleBatchFailed/);
});

const timelineDrags = [
  {start: 'startPreviewViewTimelineDrag', move: 'movePreviewViewTimelineDrag', end: 'endPreviewViewTimelineDrag', suppress: 'suppressPreviewViewTimelineClick', state: '_previewViewTimelineDrag', flag: '_previewViewTimelineSuppressClick'},
];

function dragRail(width = 600, initial = 100) {
  const classes = new Set(); let captured = false, left = initial;
  return {clientWidth: 300, scrollWidth: width, classes,
    get scrollLeft() {return left;}, set scrollLeft(value) {left = Math.max(0, Math.min(width - 300, value));},
    classList: {add(name) {classes.add(name);}, remove(name) {classes.delete(name);}},
    setPointerCapture() {captured = true;}, hasPointerCapture() {return captured;}, releasePointerCapture() {captured = false;},
    getBoundingClientRect() {return {width: 300};},
    querySelectorAll() {throw new Error('timeline pan must not scan timeline items');}};
}

test('dragging viewer timeline images pans the rail without changing the sample and suppresses its trailing click', () => {
  for (const methods of timelineDrags) {
    const value = app([image('step-1'), image('step-2')]);
    value.sampleBatchId = 'step-2'; value.previewStep = 1; value.sampleExpandedBatchId = 'step-1';
    const rail = dragRail();
    value[methods.start]({currentTarget: rail, target: {tagName: 'IMG'}, button: 0, pointerId: 1, clientX: 140});
    rail.getBoundingClientRect = () => {throw new Error('moving an active drag must not measure layout');};
    value[methods.move]({currentTarget: rail, pointerId: 1, clientX: 60, preventDefault() {}});
    assert.equal(rail.scrollLeft, 180); assert.equal(rail.hasPointerCapture(), true);
    assert.equal(rail.classes.has('is-dragging'), true);
    value[methods.end]({currentTarget: rail, pointerId: 1});
    assert.equal(rail.hasPointerCapture(), false); assert.equal(rail.classes.has('is-dragging'), false);
    assert.equal(value[methods.state], null); assert.equal(value[methods.flag], true);
    let cancelled = false;
    value[methods.suppress]({preventDefault() {cancelled = true;}, stopImmediatePropagation() {}});
    assert.equal(cancelled, true);
    assert.equal(value.sampleBatchId, 'step-2'); assert.equal(value.previewStep, 1);
    assert.equal(value.sampleExpandedBatchId, 'step-1', 'dragging a rail does not collapse its expanded group');
  }
});

test('short image presses remain clicks and select their stable target in the viewer timeline', () => {
  for (const methods of timelineDrags) {
    const value = app([image('step-1'), image('step-2')]);
    const rail = dragRail(); let prevented = false;
    value[methods.start]({currentTarget: rail, target: {tagName: 'IMG'}, button: 0, pointerId: 1, clientX: 140});
    value[methods.move]({currentTarget: rail, pointerId: 1, clientX: 146, preventDefault() {prevented = true;}});
    value[methods.end]({currentTarget: rail, pointerId: 1});
    value[methods.suppress]({preventDefault() {prevented = true;}, stopImmediatePropagation() {}});
    assert.equal(prevented, false); assert.equal(rail.hasPointerCapture(), false); assert.equal(rail.scrollLeft, 100);
    value._sampleOverviewPanel = () => ({querySelector() {return null;}});
    value.selectPreviewTimelineByKey('step-2-fox.png');
    assert.equal(value.sampleBatchId, 'step-2');
  }
});

test('timeline dragging accounts for dialog entrance scale', () => {
  for (const methods of timelineDrags) {
    const value = app([image('step-1'), image('step-2')]), rail = dragRail();
    rail.offsetWidth = 300; rail.getBoundingClientRect = () => ({width: 150});
    value[methods.start]({currentTarget: rail, button: 0, pointerId: 1, clientX: 140});
    value[methods.move]({currentTarget: rail, pointerId: 1, clientX: 60, preventDefault() {}});
    assert.equal(rail.scrollLeft, 260);
    value[methods.end]({currentTarget: rail, pointerId: 1});
  }
});

test('timeline panning uses native edge clamping without an edge-scroll animation loop', () => {
  const oldRequest = global.requestAnimationFrame;
  global.requestAnimationFrame = () => {throw new Error('pan must not start a frame loop');};
  try {
    for (const methods of timelineDrags) {
      const value = app([image('step-1'), image('step-2')]);
      for (const width of [300, 600]) {
        const rail = dragRail(width, width === 300 ? 0 : 100);
        value[methods.start]({currentTarget: rail, target: {tagName: 'IMG'}, button: 0, pointerId: 1, clientX: 100});
        value[methods.move]({currentTarget: rail, pointerId: 1, clientX: 1000, preventDefault() {}});
        assert.equal(rail.scrollLeft, 0);
        value[methods.move]({currentTarget: rail, pointerId: 1, clientX: -1000, preventDefault() {}});
        assert.equal(rail.scrollLeft, width - 300);
        value[methods.end]({type: 'pointercancel', currentTarget: rail, pointerId: 1});
        assert.equal(rail.hasPointerCapture(), false); assert.equal(value[methods.state], null);
      }
    }
  } finally {global.requestAnimationFrame = oldRequest;}
});

test('resetting the sample browser releases capture and dragging styles on the viewer timeline', () => {
  const value = app([image('step-1'), image('step-2')]);
  const rails = timelineDrags.map(methods => {
    const rail = dragRail();
    value[methods.start]({currentTarget: rail, button: 0, pointerId: 1, clientX: 100});
    value[methods.move]({currentTarget: rail, pointerId: 1, clientX: 80, preventDefault() {}});
    return rail;
  });
  value.resetSampleBrowser();
  rails.forEach(rail => {assert.equal(rail.hasPointerCapture(), false); assert.equal(rail.classes.has('is-dragging'), false);});
  timelineDrags.forEach(methods => {assert.equal(value[methods.state], null); assert.equal(value[methods.flag], false);});
});

test('resetting after a drag ends cancels deferred click cleanup and rendering', async () => {
  const value = app([image('step-1'), image('step-2')]);
  let renders = 0; value.renderDashboard = () => {renders++;};
  for (const methods of timelineDrags) {
    const rail = dragRail();
    value[methods.start]({currentTarget: rail, button: 0, pointerId: 1, clientX: 100});
    value[methods.move]({currentTarget: rail, pointerId: 1, clientX: 80, preventDefault() {}});
    value[methods.end]({currentTarget: rail, pointerId: 1});
  }
  value.resetSampleBrowser();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(renders, 0);
  assert.equal(value._previewViewTimelineClickTimer, null);
});

test('rapid jumps within one image row keep the last requested sampling point', () => {
  const value = app([image('step-1'), image('step-2')]);
  const groups = [100, 0].map((top, index) => ({dataset: {batchId: 'step-' + (index + 1)},
    querySelector(selector) {assert.equal(selector, '.m-sample-tile'); return {getBoundingClientRect: () => ({top})};}}));
  const grid = {scrollTop: 0, querySelectorAll() {return groups;}, getBoundingClientRect() {return {top: 0};}};
  const panel = {querySelector() {return grid;}};
  value._scrollOverviewToBatch(panel, value._sampleDataModel().batches[0]);
  value._scrollOverviewToBatch(panel, value._sampleDataModel().batches[1]);
  assert.equal(value._sampleOverviewJumpId, 'step-2');
});

test('sample viewer uses the standard centered modal rather than a fullscreen-only shell', () => {
  const value = app([image('step-1')]);
  const html = value._previewLightboxHtml(key => value.t('monitor.' + key));
  assert.match(html, /class="preview-lightbox modal-overlay"/);
  assert.match(html, /class="modal preview-lightbox-window"/);
  assert.doesNotMatch(html, /modal-overlay--morph/);
  assert.ok(html.indexOf('id="previewReferencePane"') < html.indexOf('id="previewCurrentCaption"'), 'the earlier reference is on the left');
  assert.match(html, /id="previewLightboxTimeline"/);
});

test('comparison settings use the shared project select and pass its selected value', () => {
  const value = app([image('step-1')]);
  const original = window.previewSelectHtml;
  let received;
  window.previewSelectHtml = (...args) => {received = args; return '<div class="preview-select"></div>';};
  try {
    const html = value._sampleSelectHtml([{value: 'batch', label: 'Batch'}], 'batch', 'Axis', 'sample-axis', 'setAxis($event.target.value)');
    assert.match(html, /class="preview-select"/);
    assert.match(html, /setAxis\(\$event\.detail\)/);
    assert.deepEqual(received, [[{value: 'batch', label: 'Batch'}], 'batch', 'Axis', 'sample-axis']);
  } finally { window.previewSelectHtml = original; }
});

test('opening a long viewer timeline brings its selected sampling point into view', () => {
  const value = app([image('step-1'), image('step-2')]);
  const selected = {getBoundingClientRect() {return {left: 145, right: 185};}};
  const timeline = {hidden: false, scrollLeft: 0, querySelector() {return selected;},
    getBoundingClientRect() {return {left: 0, right: 100, width: 100};}};
  const previous = global.document.getElementById;
  global.document.getElementById = id => id === 'previewLightboxTimeline' ? timeline : null;
  try {
    value._revealPreviewViewTimeline();
    assert.equal(timeline.scrollLeft, 89);
  } finally { global.document.getElementById = previous; }
});

test('the viewer reveals the selected item in unscaled scroll coordinates during dialog motion', () => {
  const value = app([image('step-1'), image('step-2')]);
  const selected = {getBoundingClientRect() {return {left: 145, right: 185};}};
  const timeline = {hidden: false, offsetWidth: 200, scrollLeft: 0, querySelector() {return selected;},
    getBoundingClientRect() {return {left: 0, right: 100, width: 100};}};
  const previous = global.document.getElementById;
  global.document.getElementById = id => id === 'previewLightboxTimeline' ? timeline : null;
  try {
    value._revealPreviewViewTimeline();
    assert.equal(timeline.scrollLeft, 174);
  } finally { global.document.getElementById = previous; }
});

test('the viewer waits for the dialog to actually open before revealing its selection', () => {
  const value = app([image('step-1'), image('step-2')]);
  const box = {open: false, isConnected: true};
  const oldObserver = global.MutationObserver, oldFrame = global.requestAnimationFrame;
  let observer, frame, reveals = 0;
  global.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  global.requestAnimationFrame = callback => {frame = callback;};
  value.previewLightboxOpen = true;
  value._revealPreviewViewTimeline = () => {reveals++;};
  try {
    value._revealPreviewViewAfterOpen(box);
    assert.equal(observer.target, box);
    assert.deepEqual(observer.options.attributeFilter, ['open']);
    observer.callback();
    assert.equal(reveals, 0);
    box.open = true; observer.callback();
    assert.equal(observer.disconnected, true);
    assert.equal(reveals, 0);
    frame();
    assert.equal(reveals, 1);
  } finally { global.MutationObserver = oldObserver; global.requestAnimationFrame = oldFrame; }
});

test('dragging the viewer timeline scrolls without opening an accidental sample', () => {
  const value = app([image('step-1'), image('step-2')]);
  const rail = {clientWidth: 300, scrollWidth: 600, scrollLeft: 100,
    classList: {add() {}, remove() {}}, setPointerCapture() {}, hasPointerCapture() {return false;}};
  value.startPreviewViewTimelineDrag({currentTarget: rail, pointerId: 1, button: 0, clientX: 200});
  value.movePreviewViewTimelineDrag({currentTarget: rail, pointerId: 1, clientX: 120, preventDefault() {}});
  assert.equal(rail.scrollLeft, 180);
  value.endPreviewViewTimelineDrag({currentTarget: rail, pointerId: 1});
  let cancelled = false;
  value.suppressPreviewViewTimelineClick({preventDefault() {cancelled = true;}, stopImmediatePropagation() {}});
  assert.equal(cancelled, true);
});

test('new-sample action keeps the current prompt when it is absent from the newest batch', () => {
  const value = app([image('step-1', 'fox'), image('step-2', 'cat')]);
  value.previewStep = 0; value.sampleBatchId = 'step-1'; value.previewHasNew = true;
  assert.equal(value._previewHasNewInViewerSequence(), false);
  value.jumpToLatestPreview();
  assert.equal(value.sampleBatchId, 'step-1');
  assert.equal(value.previews[value.previewStep].sample.prompt_id, 'fox');
  assert.equal(value.previewHasNew, true);
});

test('new-sample action only clears the global notice after reaching the latest batch', () => {
  const value = app([image('step-1', 'fox'), image('step-2', 'fox'), image('step-3', 'cat')]);
  value.previewStep = 0; value.sampleBatchId = 'step-1'; value.previewHasNew = true;
  assert.equal(value._previewHasNewInViewerSequence(), true);
  value.jumpToLatestPreview();
  assert.equal(value.sampleBatchId, 'step-2');
  assert.equal(value.previewHasNew, true);
  assert.equal(value._previewHasNewInViewerSequence(), false);
  value._replacePreviewItems([...value.previews, image('step-4', 'fox')]);
  assert.equal(value._previewHasNewInViewerSequence(), true);
  value.jumpToLatestPreview();
  assert.equal(value.sampleBatchId, 'step-4');
  assert.equal(value.previewHasNew, false);
});

test('closing a historical lightbox preserves the new-sample notice and overview position', () => {
  const value = app([image('step-1'), image('step-2')]);
  value.previewLightboxOpen = true; value.previewHasNew = true; value.sampleBatchId = 'step-1';
  let scrolled = '';
  value._sampleOverviewPanel = () => ({querySelector() {return null;}});
  value._scrollOverviewToBatch = (panel, batch) => {scrolled = batch.id;};
  value.closePreviewLightbox(); value.clearPreviewLightbox();
  assert.equal(value.previewHasNew, true);
  assert.equal(scrolled, '');
});

test('a hundred multi-image sampling points render a hundred collapsed covers', () => {
  const previews = Array.from({length: 100}, (_, batch) => ['fox', 'cat', 'bird', 'dog'].map(prompt => image('epoch-' + batch, prompt, 4))).flat();
  const value = app(previews);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.equal((html.match(/class="m-sample-batch"/g) || []).length, 100);
  assert.equal((html.match(/class="preview-grid-item m-sample-batch-cover"/g) || []).length, 100);
  assert.equal((html.match(/class="m-sample-card-count"/g) || []).length, 100);
  assert.doesNotMatch(html, /class="m-sample-expansion"/);
  value.sampleExpandedBatchId = 'epoch-40';
  const expanded = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.doesNotMatch(expanded, /class="m-sample-expansion"/);
  assert.equal((expanded.match(/class="preview-grid-item m-sample-batch-cover"/g) || []).length, 99);
  assert.equal((expanded.match(/data-sample-tile-key=/g) || []).length, 103);
  assert.equal((expanded.match(/class="preview-grid-item"/g) || []).length, 4);
  assert.doesNotMatch(expanded, /m-sample-collapse|sampleBatchCollapse/);
});

test('a partially generated multi-image batch keeps its first cover and actual count', () => {
  const first = image('step-1', 'fox', 3); first.sample.batch_status = 'running';
  const value = app([first]);
  let html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.match(html, /m-sample-batch-cover/);
  assert.match(html, /m-sample-card-count" aria-hidden="true">×1/);
  value.sampleExpandedBatchId = 'step-1'; value._sampleOverviewAtEnd = false;
  const items = [first, image('step-1', 'cat', 3), image('step-1', 'bird', 3)];
  value._replacePreviewItems(items); value.previewsVersion++;
  value._replacePreviewItems([...items]); value.previewsVersion++;
  html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.match(html, /class="m-sample-tile is-expanded is-first"[\s\S]*?data-preview-path="step-1-fox.png"/);
  assert.doesNotMatch(html, /m-sample-batch-cover/);
  assert.equal((html.match(/class="preview-grid-item"/g) || []).length, 3);
  assert.equal(value.previewHasNew, false);
});

test('historical expansion pauses following until the latest action is requested', () => {
  const value = app([image('step-1', 'fox', 2), image('step-1', 'cat', 2), image('step-2')]);
  value.sampleExpandedBatchId = value.sampleBatchId = 'step-1';
  value._sampleExpansionPausedFollow = true;
  value._replacePreviewItems([...value.previews, image('step-3')]);
  assert.equal(value.sampleBatchId, 'step-1');
  assert.equal(value.sampleExpandedBatchId, 'step-1');
  assert.equal(value.previewHasNew, true);
  value._sampleOverviewPanel = () => ({querySelector() {return null;}, querySelectorAll() {return [];}});
  value.jumpToLatestOverviewBatch();
  assert.equal(value.sampleBatchId, 'step-3');
  assert.equal(value.sampleExpandedBatchId, '');
  assert.equal(value._sampleExpansionPausedFollow, false);
  assert.equal(value._sampleOverviewAtEnd, true);
});

test('incoming pictures do not replace the image currently open in the modal', () => {
  const first = image('step-1', 'fox', 2), second = image('step-1', 'cat', 2);
  const value = app([first]); value.previewLightboxOpen = true;
  value._replacePreviewItems([first, second]);
  assert.equal(value._previewItemKey(value.previews[value.previewStep]), first.path);
});

test('display-contents sampling groups navigate using their first visible tile', () => {
  const value = app([image('step-1', 'fox', 2), image('step-1', 'cat', 2)]);
  const tile = {getBoundingClientRect: () => ({top: 250})};
  const group = {dataset: {batchId: 'step-1'}, querySelector() {return tile;},
    getBoundingClientRect() {throw new Error('display:contents has no layout box');}};
  const grid = {scrollTop: 20, querySelectorAll() {return [group];}, getBoundingClientRect: () => ({top: 100})};
  value._scrollOverviewToBatch({querySelector() {return grid;}}, value._sampleDataModel().batches[0]);
  assert.equal(grid.scrollTop, 170);
});

test('reduced motion completes disclosure immediately without running an animation', () => {
  const value = app([image('step-1')]);
  const previous = window.matchMedia;
  window.matchMedia = () => ({matches: true});
  let measured = false;
  try {
    value._animateSampleLayout({getBoundingClientRect() {measured = true;}}, new Map());
    assert.equal(measured, false);
  } finally {window.matchMedia = previous;}
});

test('cover stack images retain their loaded media through a sample refresh', () => {
  const value = app([image('step-1')]);
  value._previewMediaObjectUrls = ['blob:cover'];
  const frame = {dataset: {previewPath: 'step-1-fox.png'}};
  const picture = {src: 'blob:cover', dataset: {previewUrl: '/thumb?v=1', previewLoaded: '1'}, complete: true, naturalWidth: 100,
    getAttribute() {return 'blob:cover';}, closest(selector) {return selector.includes('.m-sample-card-image') ? frame : {classList: {contains() {return false;}}};}};
  const root = {querySelectorAll() {return [picture];}};
  const cache = value._capturePreviewMedia(root);
  assert.equal(cache.size, 1);
  value._restorePreviewMedia(root, cache);
  assert.equal(picture.src, 'blob:cover');
  assert.deepEqual(value._previewMediaObjectUrls, ['blob:cover']);
});

test('closing a modal within the expanded batch preserves the detail scroll position', () => {
  const value = app([image('step-1', 'fox', 2), image('step-1', 'cat', 2)]);
  value.previewLightboxOpen = true; value.sampleExpandedBatchId = 'step-1'; value.previewStep = 1;
  const grid = {scrollTop: 180, querySelector() {return null;}, getBoundingClientRect: () => ({top: 100, bottom: 500})};
  const panel = {querySelector() {return grid;}};
  const item = {getBoundingClientRect: () => ({top: 140, bottom: 400})};
  const previous = global.document.getElementById;
  global.document.getElementById = id => id === 'sample-step-1-cat.png' ? item : null;
  value._sampleOverviewPanel = () => panel;
  value._activateOverviewBatch = () => {};
  value._scrollOverviewToBatch = () => {throw new Error('expanded details must not jump to their cover');};
  try {
    value.closePreviewLightbox();
    assert.equal(grid.scrollTop, 180);
  } finally {global.document.getElementById = previous;}
});

test('FLIP scatters visible children from their cover and translates displaced neighbors', () => {
  const value = app([image('step-1', 'fox', 2)]);
  const animations = [];
  const rect = (left, top) => ({left, top, right: left + 100, bottom: top + 120, width: 100, height: 120});
  const node = key => ({animate(frames, options) {animations.push({key, frames, options}); return {finished: new Promise(() => {})};}});
  const before = new Map([['first', {node: node('first'), batchId: 'step-1', rect: rect(0, 0)}],
    ['neighbor', {node: node('neighbor'), batchId: 'step-2', rect: rect(112, 0)}]]);
  const after = new Map([['first', {node: node('first'), batchId: 'step-1', rect: rect(0, 0)}],
    ['child', {node: node('child'), batchId: 'step-1', rect: rect(112, 0)}],
    ['neighbor', {node: node('neighbor'), batchId: 'step-2', rect: rect(0, 132)}],
    ['offscreen-child', {node: node('offscreen-child'), batchId: 'step-1', rect: rect(0, 1000)}]]);
  after.forEach(item => {item.visual = item.node; item.node = {animate() {throw new Error('interactive tile must remain static');}};});
  value._captureSampleLayout = () => after;
  value._animateSampleLayout({getBoundingClientRect: () => ({left: 0, top: 0, right: 300, bottom: 400})}, before, 'step-1');
  assert.deepEqual(animations.map(item => item.key), ['child', 'neighbor']);
  assert.equal(animations[0].frames[0].transform, 'translate(-112px,0px)');
  assert.equal(animations[1].frames[0].transform, 'translate(112px,-132px)');
  assert.equal(animations[0].options.duration, 200);
  assert.doesNotMatch(JSON.stringify(animations), /height|scale/);
});

test('collapsing visible children flies them back without grid slots and cleans media after exit', async () => {
  const value = app([image('step-1', 'fox', 2)]);
  const rect = left => ({left, top: 0, right: left + 100, bottom: 120, width: 100, height: 120});
  let finish, frames, cleaned = 0, dialogOpenerRemoved = false;
  const attributes = new Map();
  const ghost = {style: {}, classList: {remove() {}, add() {}}, removeAttribute() {},
    querySelectorAll(selector) {return selector === '[data-dialog-opens]' ? [{removeAttribute() {dialogOpenerRemoved = true;}}] : [];},
    setAttribute(name, data) {attributes.set(name, data);},
    remove() {this.isConnected = false;}, animate(keyframes) {frames = keyframes; return {finished: new Promise(resolve => {finish = resolve;})};}};
  const first = {node: {}, visual: {animate() {throw new Error('the unchanged cover visual must remain still');}}, rect: rect(0), batchId: 'step-1'};
  const before = new Map([['first', first], ['child', {rect: rect(112), batchId: 'step-1', node: {animate() {}, cloneNode() {return ghost;}}}]]);
  value._captureSampleLayout = () => new Map([['first', first]]);
  value._updateSampleExpansionMedia = (panel, update) => {cleaned++; update();};
  const grid = {scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({left: 0, top: 0, right: 300, bottom: 400}),
    append(node) {node.isConnected = true;}, closest() {return {};}};
  value._animateSampleLayout(grid, before);
  assert.equal(ghost.style.position, 'absolute');
  assert.equal(attributes.has('x-ignore'), true, 'visual exit clones never initialize Alpine handlers');
  assert.equal(ghost.inert, true); assert.equal(dialogOpenerRemoved, true);
  assert.equal(frames[1].transform, 'translate(-112px,0px)');
  assert.equal(frames[1].opacity, 0);
  assert.equal(cleaned, 0, 'outgoing image URLs remain referenced during their exit');
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ghost.isConnected, false); assert.equal(cleaned, 1);
});

test('rapid layout updates cancel only sample FLIP and remove their outgoing clones', () => {
  const value = app([image('step-1')]);
  let cancelled = 0, removed = 0;
  const node = {getAnimations: () => [{id: 'sample-grid-flip', cancel() {cancelled++;}}, {id: 'other-motion', cancel() {throw new Error('unrelated animation');}}],
    classList: {contains() {return true;}}, remove() {removed++;}};
  value._cancelSampleGridMotion({querySelectorAll() {return [node];}});
  assert.equal(cancelled, 1); assert.equal(removed, 1);
});

test('local detail updates reuse cover media and release only URLs without surviving references', () => {
  const value = app([image('step-1')]); value.weakNetworkMode = true;
  const thumbnail = (path, src, complete = true) => ({src, complete, naturalWidth: complete ? 100 : 0,
    dataset: {previewUrl: '/thumb/' + path + '?v=1', previewLoaded: src ? '1' : undefined},
    getAttribute() {return this.src || null;},
    closest(selector) {return selector === '.preview-thumb-frame' ? {classList: {contains() {return false;}}} : {dataset: {previewPath: path}};}});
  const cover = thumbnail('cover', 'blob:cover');
  const oldDetail = thumbnail('old-only', 'blob:old-only');
  const dialog = thumbnail('viewer', 'blob:dialog');
  const decoding = thumbnail('cover', 'blob:decoding', false);
  const newDetail = thumbnail('cover', '');
  let images = [cover, oldDetail, dialog, decoding];
  const root = {querySelectorAll() {return images;}};
  const panel = {querySelectorAll() {throw new Error('the persistent viewer must share the root');}};
  value._previewMediaObjectUrls = ['blob:cover', 'blob:old-only', 'blob:dialog', 'blob:decoding'];
  const queued = {dataset: {previewQueued: '1'}};
  value._previewMediaQueue = [{image: queued}];
  let aborted = false, disconnected = false, scheduled;
  value._previewMediaAbort = {abort() {aborted = true;}};
  value._previewMediaObserver = {disconnect() {disconnected = true;}};
  value.schedulePreviewMediaLoads = target => {scheduled = target;};
  const revoked = [];
  const oldGet = global.document.getElementById, oldRevoke = URL.revokeObjectURL;
  global.document.getElementById = id => id === 'monitorDashboard' ? root : null;
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    value._updateSampleExpansionMedia(panel, () => {images = [cover, dialog, decoding, newDetail];});
    assert.equal(aborted, true); assert.equal(disconnected, true);
    assert.equal(queued.dataset.previewQueued, undefined);
    assert.equal(newDetail.src, 'blob:cover', 'new child images reuse an already decoded cover');
    assert.equal(decoding.src, 'blob:decoding', 'a surviving decode keeps its own URL despite a matching cover cache');
    assert.equal(dialog.src, 'blob:dialog');
    assert.deepEqual(revoked, ['blob:old-only']);
    assert.deepEqual(value._previewMediaObjectUrls, ['blob:cover', 'blob:dialog', 'blob:decoding']);
    assert.equal(scheduled, root);
  } finally {global.document.getElementById = oldGet; URL.revokeObjectURL = oldRevoke;}
});

test('replacing an expanded group performs its DOM changes inside the media update', () => {
  const value = app([image('step-1', 'fox', 2), image('step-2', 'fox', 2)]);
  value.sampleExpandedBatchId = 'step-2';
  const operations = [];
  const groups = ['step-1', 'step-2'].map(id => ({dataset: {batchId: id}, innerHTML: 'old', querySelector() {return {getBoundingClientRect: () => ({top: 100})};}}));
  const grid = {scrollTop: 0, querySelectorAll() {return groups;}};
  const panel = {querySelector() {return grid;}};
  value._sampleBatchItemsHtml = () => '<new-cards>';
  value._captureSampleLayout = () => new Map();
  value._cancelSampleGridMotion = () => operations.push('cancel-motion');
  value._animateSampleLayout = () => operations.push('animate');
  value._refreshSampleGroupOutline = () => {};
  value._connectSampleExpansionUI = () => {};
  value._updateSampleExpansionMedia = (target, mutate) => {assert.equal(target, panel); operations.push('capture-cancel'); mutate(); operations.push('restore-schedule');};
  value._replaceSampleBatchCards(panel, ['step-1', 'step-2'], 'step-2');
  assert.deepEqual(operations, ['capture-cancel', 'cancel-motion', 'animate', 'restore-schedule']);
  assert.deepEqual(groups.map(group => group.innerHTML), ['<new-cards>', '<new-cards>']);
  assert.deepEqual(groups.map(group => group.dataset.expanded), ['false', 'true']);
});

test('closing a spread and viewing the latest group replace its cards through the shared update', () => {
  const value = app([image('step-1', 'fox', 2), image('step-2', 'fox', 2)]);
  const operations = [];
  const grid = {};
  const panel = {querySelector(selector) {return selector === '.m-sample-batches' ? grid : null;}};
  value._sampleOverviewPanel = () => panel;
  value._replaceSampleBatchCards = (target, ids, preserveId, animate) => {assert.equal(target, panel); operations.push({ids, preserveId, animate});};
  value.sampleExpandedBatchId = 'step-1';
  value._sampleExpansionPausedFollow = true;
  value.toggleSampleBatch('step-1');
  assert.equal(value._sampleExpansionPausedFollow, false, 'closing details removes their explicit historical follow guard');
  assert.deepEqual(operations, [{ids: ['step-1'], preserveId: 'step-1', animate: undefined}]);
  operations.length = 0;
  value.sampleExpandedBatchId = 'step-1';
  value._activateOverviewBatch = () => {};
  value._scrollOverviewToBatch = () => {};
  value.jumpToLatestOverviewBatch();
  assert.deepEqual(operations, [{ids: ['step-1'], preserveId: '', animate: false}]);
});

test('jumping to the latest batch resumes following and closes historical details', () => {
  const value = app([image('step-1', 'fox', 2), image('step-2', 'fox', 2)]);
  value.sampleExpandedBatchId = value.sampleBatchId = 'step-1';
  value._sampleExpansionPausedFollow = true; value._sampleOverviewAtEnd = false; value.previewHasNew = true;
  let removed = false;
  const panel = {querySelector() {return null;}, querySelectorAll() {return [];}};
  value._sampleOverviewPanel = () => panel;
  value._replaceSampleBatchCards = () => {removed = true;};
  value.jumpToLatestOverviewBatch();
  assert.equal(removed, true);
  assert.equal(value.sampleExpandedBatchId, '');
  assert.equal(value.sampleBatchId, 'step-2');
  assert.equal(value._sampleExpansionPausedFollow, false);
  assert.equal(value._sampleOverviewAtEnd, true);
  assert.equal(value.previewHasNew, false);
  value._replacePreviewItems([...value.previews, image('step-3')]);
  assert.equal(value.sampleBatchId, 'step-3', 'the next batch follows without requiring another notice click');
});

test('a cross-row group outline has one stepped path and a positive bridge without enclosing other epochs', () => {
  const value = app([image('step-1')]);
  const item = (batchId, left, top, height = 120) => ({batchId, left, top, right: left + 100, bottom: top + height});
  const rows = value._sampleOutlineRows([item('other', 6, 6), item('other', 118, 6), item('other', 230, 6), item('open', 342, 6),
    item('open', 6, 138), item('other', 118, 138), item('other', 230, 138), item('other', 342, 138)], 'open');
  const path = value._sampleOutlinePath(rows);
  assert.equal((path.match(/M/g) || []).length, 1); assert.equal((path.match(/Z/g) || []).length, 1);
  assert.equal(rows[1].top - rows[0].bottom, 8, 'the connector uses the existing row gap without touching neighboring cards');
  assert.equal(value._sampleOutlineContainsPoint(rows, 390, 50), true);
  assert.equal(value._sampleOutlineContainsPoint(rows, 50, 170), true);
  assert.equal(value._sampleOutlineContainsPoint(rows, 200, 132), true, 'the empty bridge is inside the group');
  assert.equal(value._sampleOutlineContainsPoint(rows, 50, 50), false, 'the earlier epoch in the first row stays outside');
  assert.equal(value._sampleOutlineContainsPoint(rows, 390, 170), false, 'the later epoch in the second row stays outside');
  assert.equal((path.match(/A/g) || []).length, 8, 'every convex and concave turn is an actual arc');
  assert.equal((path.match(/A4 4 /g) || []).length, 4, 'all turns at an 8px bridge are capped at 4px');
  assert.equal((path.match(/A6 6 /g) || []).length, 4, 'the large outside corners retain a 6px radius');
  assert.match(path, /A4 4 0 0 0 /, 'inner turns use the opposite arc sweep');
  assert.doesNotMatch(path, /,/);
});

test('rounded orthogonal outlines remove duplicate straight vertices and clamp to short neighboring edges', () => {
  const value = app([image('step-1')]);
  const path = value._sampleRoundedOutlinePath([[0, 0], [5, 0], [10, 0], [10, 3], [10, 3], [0, 3], [0, 0]]);
  assert.equal((path.match(/A/g) || []).length, 4);
  assert.equal((path.match(/A1\.5 1\.5 /g) || []).length, 4, 'a 3px segment shares its length between both corner arcs');
  assert.doesNotMatch(path, /NaN|Infinity/);
  assert.equal(value._sampleRoundedOutlinePath([]), '');
});

test('outline bridges start below the tallest caption in the complete CSS row', () => {
  const value = app([image('step-1')]);
  const rows = value._sampleOutlineRows([
    {batchId: 'other', left: 6, right: 106, top: 6, bottom: 166},
    {batchId: 'open', left: 118, right: 218, top: 6, bottom: 126},
    {batchId: 'open', left: 6, right: 106, top: 178, bottom: 298}], 'open');
  assert.equal(rows[0].bottom, 168);
  assert.equal(rows[1].top, 176);
  assert.equal(value._sampleOutlineContainsPoint(rows, 50, 150), false, 'the taller neighboring caption is outside');
  assert.equal(value._sampleOutlineContainsPoint(rows, 50, 172), true);
  assert.equal(value._sampleOutlineContainsPoint(rows, 150, 150), true, 'a narrow neck stays in the selected column');
});

function outlineLayers() {
  const attributes = {}, writes = [], path = {setAttribute(name, value) {attributes[name] = value; writes.push(name);}};
  const fill = {firstElementChild: path, setAttribute(name, value) {attributes[name] = value; writes.push(name);}};
  const outline = {style: {}, firstElementChild: fill};
  return {attributes, path, fill, outline, writes};
}

test('outline refresh uses final offsets and bounds its paint layer without reading scroll height', () => {
  const value = app([image('step-1')]); value.sampleExpandedBatchId = 'step-1';
  const {attributes, outline} = outlineLayers();
  const tile = (left, top) => ({dataset: {batchId: 'step-1'}, offsetLeft: left, offsetTop: top, offsetWidth: 100, offsetHeight: 120,
    getBoundingClientRect() {throw new Error('a running FLIP transform must not affect the outline');}});
  let tiles = [tile(6, 6), tile(6, 138)];
  const grid = {clientWidth: 500, scrollTop: 0, scrollLeft: 0, querySelector() {return outline;}, querySelectorAll() {return tiles;},
    getBoundingClientRect() {throw new Error('offset geometry needs no extra grid measurement');},
    get scrollHeight() {throw new Error('the outline must not read or extend the entire history height');}};
  const panel = {querySelector() {return grid;}};
  value._refreshSampleGroupOutline(panel);
  assert.equal(outline.style.height, '262px'); assert.equal(outline.style.width, '110px'); assert.equal(outline._sampleRows.length, 2);
  assert.equal(attributes.viewBox, '1 1 110 262');
  assert.equal(attributes.d, value._sampleOutlinePath(outline._sampleRows), 'one closed path carries both fill and circulating dashes');
  tiles = [tile(6, 6), tile(118, 6)];
  value._refreshSampleGroupOutline(panel);
  assert.equal(outline.style.height, '130px'); assert.equal(outline.style.width, '222px'); assert.equal(outline._sampleRows.length, 1);
  tiles = [tile(6, 6), tile(6, 138)];
  value._refreshSampleGroupOutline(panel);
  assert.equal(outline.style.height, '262px'); assert.equal(outline._sampleRows.length, 2);
});

test('outline geometry refresh leaves continuous CSS flow intact and fades only on explicit expansion', () => {
  const value = app([image('step-1')]); value.sampleExpandedBatchId = 'step-1';
  const flows = [], fades = [];
  const {outline, path, writes} = outlineLayers();
  path.animate = (frames, options) => flows.push({frames, options});
  outline.getAnimations = () => [];
  outline.animate = (frames, options) => fades.push({frames, options});
  const tile = {dataset: {batchId: 'step-1'}, offsetLeft: 6, offsetTop: 6, offsetWidth: 100, offsetHeight: 120};
  const grid = {clientWidth: 300, scrollHeight: 140, scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({left: 0, top: 0}),
    querySelector: () => outline, querySelectorAll: () => [tile]};
  const panel = {querySelector: () => grid};
  const previous = window.matchMedia;
  window.matchMedia = () => ({matches: false});
  try {
    value._refreshSampleGroupOutline(panel, true);
    assert.equal(fades.length, 1); assert.equal(fades[0].options.duration, 200);
    assert.deepEqual(flows, [], 'the stroke keeps its CSS animation instead of starting a timed JavaScript flow');
    value._refreshSampleGroupOutline(panel);
    assert.equal(writes.length, 2, 'unchanged geometry reuses the existing viewport and path');
    grid.clientWidth = 420; tile.offsetLeft = 20; value._refreshSampleGroupOutline(panel);
    grid.scrollTop = 60; value._refreshSampleGroupOutline(panel);
    assert.equal(writes.length, 4, 'a scroll does not invalidate the content-coordinate path');
    assert.equal(flows.length, 0); assert.equal(fades.length, 1, 'geometry refresh never restarts the entrance');
    window.matchMedia = () => ({matches: true});
    value._refreshSampleGroupOutline(panel, true);
    assert.equal(flows.length, 0); assert.equal(fades.length, 1, 'reduced motion skips the entrance fade');
  } finally {window.matchMedia = previous;}
});

const afterSampleClick = () => new Promise(resolve => setTimeout(resolve, 0));

function expansionEvents(expanded = 'step-1') {
  const value = app([image('step-1', 'fox', 2), image('step-2')]);
  value.sampleExpandedBatchId = expanded; value.sampleBatchId = 'step-1';
  value.currentRoute = 'monitor-dashboard'; value.monitorTab = 'samples';
  const listeners = new Map(), capture = new Map(), oldDocument = global.document, oldSelection = window.getSelection;
  global.document = {...oldDocument,
    addEventListener(type, handler, capturing) {listeners.set(type, handler); capture.set(type, capturing);},
    removeEventListener(type, handler) {if (listeners.get(type) === handler) listeners.delete(type);}};
  const rows = [{left: 6, right: 218, top: 6, bottom: 126}, {left: 6, right: 106, top: 130, bottom: 250}];
  const grid = {isConnected: true, scrollLeft: 0, scrollTop: 0, contains: () => false,
    querySelector: () => ({_sampleRows: rows}), querySelectorAll: () => [],
    getBoundingClientRect: () => ({left: 0, top: 0, right: 500, bottom: 400})};
  const panel = {querySelector: () => grid};
  value._sampleOverviewPanel = () => panel;
  value._connectSampleExpansionUI(panel);
  const target = {closest: () => null};
  const click = (custom = {}) => ({target, clientX: 400, clientY: 300, composedPath: () => [target], ...custom});
  return {value, listeners, capture, grid, panel, target, click,
    restore() {value._disconnectSampleExpansionUI(); global.document = oldDocument; window.getSelection = oldSelection;}};
}

test('outside dismissal preserves group gaps and defers external controls until their click finishes', async () => {
  const fixture = expansionEvents(), {value, listeners, grid, click} = fixture;
  const closed = [];
  value.toggleSampleBatch = id => {closed.push(id);};
  try {
    listeners.get('click')(click({target: grid, clientX: 110, clientY: 60}));
    await afterSampleClick(); assert.deepEqual(closed, [], 'space between the group images is inside its frame');
    listeners.get('click')(click({target: grid, clientX: 180, clientY: 128}));
    await afterSampleClick(); assert.deepEqual(closed, [], 'the cross-row bridge remains inside');
    listeners.get('click')(click());
    assert.deepEqual(closed, [], 'an external control gets its original click before layout changes');
    await afterSampleClick(); assert.deepEqual(closed, ['step-1']);
  } finally {fixture.restore();}
});

test('a native click microtask checkpoint cannot dismiss before its target control runs', async () => {
  const fixture = expansionEvents(), {value, listeners, click} = fixture;
  let targetRan = false;
  const order = [];
  value.toggleSampleBatch = () => {order.push(targetRan ? 'dismiss-after-target' : 'dismiss-before-target');};
  try {
    listeners.get('click')(click());
    await Promise.resolve();
    assert.deepEqual(order, [], 'the capture listener must survive a native between-listener microtask checkpoint');
    targetRan = true;
    await afterSampleClick();
    assert.deepEqual(order, ['dismiss-after-target']);
  } finally {fixture.restore();}
});

test('resetting an expanded run cancels pending outside dismissal and leaves the next run untouched', async () => {
  const fixture = expansionEvents(), {value, listeners, click} = fixture;
  const closed = [];
  value.toggleSampleBatch = id => closed.push(id);
  try {
    listeners.get('click')(click());
    value.resetSampleBrowser();
    value.sampleExpandedBatchId = 'step-1';
    await afterSampleClick();
    assert.deepEqual(closed, []);
    assert.equal(value._sampleExpansionDismissTimer, null);
  } finally {fixture.restore();}
});

test('outside dismissal ignores original group paths, other stack openers, drags, selections and modal transitions', async () => {
  const fixture = expansionEvents(), {value, listeners, target, click} = fixture;
  const closed = [];
  value.toggleSampleBatch = id => closed.push(id);
  try {
    const group = {dataset: {batchId: 'step-1'}, matches: selector => selector === '.m-sample-batch'};
    listeners.get('click')(click({composedPath: () => [target, group]}));
    const cover = {classList: {contains: name => name === 'm-sample-batch-cover'}};
    listeners.get('click')(click({composedPath: () => [cover]}));
    listeners.get('pointerdown')({target, button: 0, pointerId: 1, clientX: 0, clientY: 0});
    listeners.get('pointermove')({pointerId: 1, clientX: 30, clientY: 0});
    listeners.get('click')(click());
    window.getSelection = () => 'selected text';
    listeners.get('click')(click()); await afterSampleClick();
    window.getSelection = () => '';
    value.previewLightboxOpen = true; listeners.get('click')(click());
    value.previewLightboxOpen = false; value._previewClosePending = true; listeners.get('click')(click());
    await afterSampleClick(); assert.deepEqual(closed, []);
  } finally {fixture.restore();}
});

test('an outside single-image opener closes the old spread after opening its modal', async () => {
  const fixture = expansionEvents(), {value, listeners, click} = fixture;
  const closed = [];
  value.toggleSampleBatch = id => closed.push(id);
  try {
    const imageButton = {closest: () => null, matches: selector => selector === '.preview-grid-item[data-dialog-opens="previewLightbox"]'};
    listeners.get('click')(click({target: imageButton, composedPath: () => [imageButton]}));
    value.previewLightboxOpen = true;
    await afterSampleClick(); assert.deepEqual(closed, ['step-1']);
  } finally {fixture.restore();}
});

test('outside collapse keeps the clicked control focus while Escape restores the cover', () => {
  const fixture = expansionEvents(), {value, listeners, target, click} = fixture;
  let focused = '';
  global.document.getElementById = id => ({focus() {focused = id;}});
  value._replaceSampleBatchCards = () => {};
  try {
    value.toggleSampleBatch('step-1', click());
    assert.equal(focused, '');
    value.sampleExpandedBatchId = 'step-1';
    let stopped = false;
    listeners.get('keydown')({key: 'Escape', target, preventDefault() {}, stopPropagation() {stopped = true;}});
    assert.equal(focused, 'sampleBatch-step-1'); assert.equal(stopped, true);
  } finally {fixture.restore();}
});

test('expanded groups let child menus and input composition consume Escape first', () => {
  const fixture = expansionEvents(), {value, listeners, capture, target} = fixture;
  let closed = false; value.toggleSampleBatch = () => {closed = true;};
  try {
    assert.equal(capture.get('keydown'), false, 'the group dismisses on bubbling after child popup handlers');
    listeners.get('keydown')({key: 'Escape', target, defaultPrevented: true});
    listeners.get('keydown')({key: 'Escape', target, isComposing: true});
    assert.equal(closed, false);
  } finally {fixture.restore();}
});

test('outline observers and pending geometry frames are disconnected when the run resets', () => {
  const oldObserver = global.ResizeObserver, oldFrame = global.requestAnimationFrame, oldCancel = global.cancelAnimationFrame;
  const observers = [], frames = new Map(); let sequence = 0;
  global.ResizeObserver = class {constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.disconnected = true;}};
  global.requestAnimationFrame = callback => {frames.set(++sequence, callback); return sequence;};
  global.cancelAnimationFrame = id => frames.delete(id);
  const fixture = expansionEvents(), {value, listeners} = fixture;
  let refreshed = 0; value._refreshSampleGroupOutline = () => refreshed++;
  try {
    observers[0].callback();
    assert.equal(frames.size, 1);
    const stale = [...frames.values()][0];
    value.resetSampleBrowser();
    assert.equal(observers[0].disconnected, true); assert.equal(frames.size, 0); assert.equal(listeners.size, 0);
    stale(); assert.equal(refreshed, 0, 'a stale geometry callback cannot revive a closed group frame');
  } finally {fixture.restore(); global.ResizeObserver = oldObserver; global.requestAnimationFrame = oldFrame; global.cancelAnimationFrame = oldCancel;}
});

test('the persistent grid delegates single and double clicks while card visuals remain passive', () => {
  const value = app([image('step-1', 'fox', 2), image('step-1', 'cat', 2)]);
  const batch = value._sampleDataModel().byBatch.get('step-1');
  assert.doesNotMatch(value._sampleBatchCardHtml(key => value.t('monitor.' + key), batch, true), /@click=/);
  assert.doesNotMatch(value._sampleThumbnailHtml(0, batch), /@click=/);
  assert.doesNotMatch(value._sampleThumbnailHtml(0, batch), /@dblclick=/);
  assert.match(value._sampleThumbnailHtml(0, batch), /<span class="m-sample-card-visual">/);
  assert.match(value._sampleBatchCardHtml(key => key, batch, true), /<span class="m-sample-card-visual">/);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.match(html, /@click="sampleGridClick\(\$event\)"/);
  assert.match(html, /@dblclick="sampleGridDoubleClick\(\$event\)"/);
  assert.match(html, /@pointerdown="sampleGridPointerDown\(\$event\)"/);
  assert.doesNotMatch(html, /@pointer(?:move|up|cancel)="sampleGridPointer/);
});

function delegatedCover(grid, id) {
  const group = {dataset: {batchId: id}};
  const cover = {closest: selector => selector === '.m-sample-batch' ? group : null};
  const target = {closest: selector => selector === '.m-sample-batch-cover' ? cover : null};
  grid.contains = node => node === cover;
  return {cover, target};
}

function delegatedImage(grid, index, key) {
  const image = {dataset: {previewIndex: String(index), previewPath: key}};
  image.closest = selector => selector === '.preview-grid-item[data-preview-index]' ? image : null;
  const target = {closest: selector => selector === '.preview-grid-item[data-preview-index]' ? image : null};
  grid.contains = node => node === image;
  return {image, target};
}

test('document capture alone completes grid gestures before click bubbling and deferred rendering', async () => {
  for (const gesture of ['click', 'drag-return', 'cancel', 'blank']) {
    const fixture = expansionEvents(''), {value, listeners, capture, grid} = fixture;
    const {target} = delegatedImage(grid, 0, 'step-1-fox.png');
    grid.clientWidth = 500; grid.clientHeight = 400;
    const html = value._renderSamplesTab(key => value.t('monitor.' + key));
    const gridAttributes = html.match(/<div class="preview-grid m-sample-batches"([^>]+)>/)[1];
    const bindings = new Map([...gridAttributes.matchAll(/@(pointerdown|pointermove|pointerup|pointercancel|click)="(\w+)\(\$event\)"/g)]
      .map(([, type, method]) => [type, method]));
    assert.deepEqual([...bindings.keys()].sort(), ['click', 'pointerdown']);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) assert.equal(capture.get(type), true);
    const order = [];
    value.sampleSidebarVisible = false;
    value.openPreviewLightbox = index => {assert.equal(index, 0); value.previewLightboxOpen = true; order.push('open');};
    value.closeSampleSidebarPreview = () => order.push('clear');
    value.renderDashboard = () => order.push('render');
    let gridMoves = 0;
    const moveGridPointer = value.sampleGridPointerMove;
    value.sampleGridPointerMove = event => {gridMoves++; moveGridPointer.call(value, event);};
    const dispatch = (type, changes = {}) => {
      const event = {target: grid, button: 0, pointerId: 1, detail: 1, clientX: 400, clientY: 300, ...changes};
      event.composedPath = () => [event.target, grid];
      event.currentTarget = global.document;
      listeners.get(type)?.(event);
      event.currentTarget = grid;
      if (bindings.has(type)) value[bindings.get(type)](event);
    };
    try {
      dispatch('pointerdown', {target: gesture === 'blank' ? grid : target});
      if (gesture === 'blank') assert.equal(value._sampleGridPointer, null);
      else value._sampleGridPointer.renderPending = true;
      if (gesture === 'drag-return') {
        dispatch('pointermove', {clientX: 420});
        assert.equal(gridMoves, 1, 'document capture updates grid movement once');
      }
      const movesBeforeCompletion = gridMoves;
      dispatch(gesture === 'cancel' ? 'pointercancel' : 'pointerup');
      assert.equal(gridMoves - movesBeforeCompletion, gesture === 'blank' ? 0 : 1, 'completion checks the grid endpoint once');
      await Promise.resolve();
      assert.deepEqual(order, [], 'a native microtask checkpoint must leave the original click intact');
      dispatch('click');
      assert.deepEqual(order, gesture === 'click' ? ['open'] : gesture === 'blank' ? ['clear'] : []);
      await afterSampleClick();
      assert.deepEqual(order, gesture === 'click' ? ['open', 'render'] : gesture === 'blank' ? ['clear'] : ['render']);
      assert.equal(value._sampleGridPointer, null);
    } finally {fixture.restore();}
  }
});

for (const sidebar of [false, true]) for (const retarget of ['grid', 'tile', 'image', 'outside']) {
  test(`a stationary image press retains its file through ${retarget} retargeting with sidebar ${sidebar}`, async () => {
    const fixture = expansionEvents(''), {value, listeners, grid, click, target: outside} = fixture;
    const {target: pressed} = delegatedImage(grid, 0, 'step-1-fox.png');
    const other = {dataset: {previewIndex: '1', previewPath: 'step-2-fox.png'}};
    const target = retarget === 'grid' ? grid : retarget === 'outside' ? outside
      : {closest: selector => retarget === 'image' && selector === '.preview-grid-item[data-preview-index]' ? other : null};
    if (retarget === 'image') {const contains = grid.contains; grid.contains = node => node === other || contains(node);}
    const opened = []; value.sampleSidebarVisible = sidebar;
    value.openPreviewLightbox = index => {opened.push(index); value.previewLightboxOpen = true;};
    try {
      listeners.get('pointerdown')({target: pressed, button: 0, pointerId: 4, clientX: 400, clientY: 300});
      value.sampleGridPointerDown({target: pressed, currentTarget: grid, button: 0, pointerId: 4, clientX: 400, clientY: 300});
      listeners.get('pointerup')({target, pointerId: 4, clientX: 400, clientY: 300});
      const event = click({target, currentTarget: grid, button: 0, detail: 1, pointerId: 4,
        composedPath: () => retarget === 'outside' ? [target] : [target, grid]});
      listeners.get('click')(event);
      if (retarget !== 'outside') value.sampleGridClick(event);
      await afterSampleClick();
      assert.deepEqual(opened, sidebar ? [] : [0]);
      if (sidebar) {assert.equal(value.previewStep, 0); assert.equal(value.sampleSidebarActive, true);}
      assert.equal(value._sampleGridPointer, null);
    } finally {fixture.restore();}
  });
}

test('image presses retain file identity through reordered snapshots and never select a replacement for a deleted file', () => {
  for (const deleted of [false, true]) {
    const value = app([image('step-1'), image('step-2')]), grid = {};
    const {target} = delegatedImage(grid, 0, 'step-1-fox.png');
    const selected = []; value.selectSampleImage = index => selected.push(value.previews[index].path);
    value.sampleGridPointerDown({target, currentTarget: grid, button: 0, pointerId: 1, clientX: 100, clientY: 100});
    value.previews = deleted ? [value.previews[1]] : value.previews.slice().reverse();
    value.sampleGridPointerUp({pointerId: 1, clientX: 100, clientY: 100});
    value.sampleGridClick({target: grid, currentTarget: grid, button: 0, detail: 1, pointerId: 1, clientX: 100, clientY: 100});
    assert.deepEqual(selected, deleted ? [] : ['step-1-fox.png']);
  }
});

test('image press actions reject drags cancellations and mismatched pointers while keyboard clicks remain usable', () => {
  for (const gesture of ['drag-return', 'cancel', 'different-pointer']) {
    const value = app([image('step-1')]), grid = {}, {target} = delegatedImage(grid, 0, 'step-1-fox.png');
    const selected = []; value.selectSampleImage = index => selected.push(index);
    value.sampleGridPointerDown({target, currentTarget: grid, button: 0, pointerId: 1, clientX: 100, clientY: 100});
    if (gesture === 'drag-return') value.sampleGridPointerMove({pointerId: 1, clientX: 120, clientY: 100});
    if (gesture === 'cancel') value.sampleGridPointerCancel({pointerId: 1});
    value.sampleGridPointerUp({pointerId: 1, clientX: 100, clientY: 100});
    value.sampleGridClick({target: grid, currentTarget: grid, button: 0, detail: 1,
      pointerId: gesture === 'different-pointer' ? 2 : 1, clientX: 100, clientY: 100});
    assert.deepEqual(selected, [], gesture);
    value.sampleGridClick({target, currentTarget: grid, button: 0, detail: 0});
    assert.deepEqual(selected, [0]);
  }
});

test('document capture treats moving visuals as cards and vacated static slots as workspace blank', () => {
  const originalStyle = window.getComputedStyle;
  window.getComputedStyle = () => ({opacity: '1'});
  for (const visible of [true, false]) {
    const fixture = expansionEvents(''), {value, listeners, grid, click} = fixture;
    const {image: button, target} = delegatedImage(grid, 0, 'step-1-fox.png');
    grid.clientWidth = 500; grid.clientHeight = 400;
    const visual = {getBoundingClientRect: () => ({left: visible ? 350 : 100, right: visible ? 450 : 200, top: 250, bottom: 350})};
    grid._sampleGridMotion = {items: [{button, visual}], animations: new Set([{}])};
    let cleared = 0; const selected = [];
    value.closeSampleSidebarPreview = () => {cleared++;}; value.selectSampleImage = index => selected.push(index);
    const nativeTarget = visible ? grid : target;
    try {
      listeners.get('pointerdown')({target: nativeTarget, button: 0, pointerId: 1, clientX: 400, clientY: 300});
      value.sampleGridPointerDown({target: nativeTarget, currentTarget: grid, button: 0, pointerId: 1, clientX: 400, clientY: 300});
      listeners.get('pointerup')({pointerId: 1, clientX: 400, clientY: 300});
      const event = click({target: nativeTarget, currentTarget: grid, button: 0, detail: 1, pointerId: 1, composedPath: () => [nativeTarget, grid]});
      listeners.get('click')(event); value.sampleGridClick(event);
      assert.equal(cleared, visible ? 0 : 1);
      assert.deepEqual(selected, visible ? [0] : []);
    } finally {fixture.restore();}
  }
  window.getComputedStyle = originalStyle;
});

test('a replaced cover without its own event listener switches A to B once through the grid', () => {
  const value = app([image('step-1', 'fox', 2), image('step-2', 'fox', 2)]);
  value.sampleExpandedBatchId = 'step-1';
  const grid = {}, panel = {querySelector: () => grid}, replacements = [];
  const {target} = delegatedCover(grid, 'step-2');
  value._sampleOverviewPanel = () => panel;
  value._replaceSampleBatchCards = (targetPanel, ids) => replacements.push(ids);
  value._activateOverviewBatch = batch => {value.sampleBatchId = batch.id;};
  value.sampleGridClick({currentTarget: grid, target, button: 0, detail: 1});
  assert.equal(value.sampleExpandedBatchId, 'step-2');
  assert.equal(value.sampleBatchId, 'step-2');
  assert.deepEqual(replacements, [['step-1', 'step-2']], 'A closes and B opens in one DOM update');
});

test('a short cover press retargeted to the grid by FLIP opens B and invalidates the old outside-dismiss task', async () => {
  const fixture = expansionEvents(), {value, listeners, grid, panel, click} = fixture;
  value.previews[1].sample.batch_expected = 2; value._sampleModelCache = null;
  const {target} = delegatedCover(grid, 'step-2');
  const replacements = [];
  value._replaceSampleBatchCards = (targetPanel, ids) => {assert.equal(targetPanel, panel); replacements.push(ids);};
  value._activateOverviewBatch = batch => {value.sampleBatchId = batch.id;};
  try {
    value.sampleGridPointerDown({currentTarget: grid, target, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    value.sampleGridPointerUp({pointerId: 1, clientX: 400, clientY: 300});
    const event = click({target: grid, currentTarget: grid, button: 0, detail: 1, composedPath: () => [grid]});
    listeners.get('click')(event);
    value.sampleGridClick(event);
    await afterSampleClick();
    assert.equal(value.sampleExpandedBatchId, 'step-2');
    assert.deepEqual(replacements, [['step-1', 'step-2']]);
  } finally {fixture.restore();}
});

for (const retarget of ['tile', 'group', 'image']) test('a short cover press keeps its batch when click is retargeted to another ' + retarget, async () => {
  const fixture = expansionEvents(), {value, listeners, grid, panel, click} = fixture;
  value.previews[1].sample.batch_expected = 2; value._sampleModelCache = null;
  const {target: pressed} = delegatedCover(grid, 'step-2');
  const group = {dataset: {batchId: 'step-2'}, matches: selector => selector === '.m-sample-batch'};
  const imageButton = {dataset: {previewIndex: '0', previewPath: 'step-1-fox.png'},
    matches: selector => selector === '.preview-grid-item[data-dialog-opens="previewLightbox"]'};
  const target = retarget === 'group' ? group : retarget === 'image' ? imageButton : {};
  target.closest = selector => retarget === 'image' && selector === '.preview-grid-item[data-preview-index]' ? imageButton : null;
  grid.contains = () => true;
  const replacements = [], opened = [];
  value._replaceSampleBatchCards = (targetPanel, ids) => {assert.equal(targetPanel, panel); replacements.push(ids);};
  value._activateOverviewBatch = batch => {value.sampleBatchId = batch.id;};
  value.openPreviewLightbox = index => {opened.push(index); value.previewLightboxOpen = true;};
  try {
    value.sampleGridPointerDown({currentTarget: grid, target: pressed, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    value.sampleGridPointerUp({pointerId: 1, clientX: 400, clientY: 300});
    const event = click({target, currentTarget: grid, button: 0, detail: 1, composedPath: () => [target, group, grid]});
    listeners.get('click')(event);
    value.sampleGridClick(event);
    await afterSampleClick();
    assert.equal(value.sampleExpandedBatchId, 'step-2', 'the original cover opens instead of dismissing the old group');
    assert.deepEqual(replacements, [['step-1', 'step-2']], 'one press is one atomic batch switch');
    assert.deepEqual(opened, [], 'an image moving under the pointer does not open its modal');
    assert.equal(value._sampleGridPointer, null);
  } finally {fixture.restore();}
});

test('a new outside press cannot reuse an earlier cover intent whose click was cancelled', async () => {
  const fixture = expansionEvents(), {value, listeners, grid, target: outside, click} = fixture;
  const {target: cover} = delegatedCover(grid, 'step-2');
  const actions = []; value.toggleSampleBatch = id => actions.push(id);
  try {
    value.sampleGridPointerDown({currentTarget: grid, target: cover, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    value.sampleGridPointerUp({pointerId: 1, clientX: 400, clientY: 300});
    listeners.get('pointerdown')({target: outside, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    assert.equal(value._sampleGridPointer, null);
    const event = click({target: grid, currentTarget: grid, button: 0, detail: 1, composedPath: () => [grid]});
    listeners.get('click')(event); value.sampleGridClick(event);
    await afterSampleClick();
    assert.deepEqual(actions, ['step-1'], 'the outside click only dismisses the expanded group');
  } finally {fixture.restore();}
});

for (const expanded of ['step-1', '']) test('a cover press finishing outside the grid opens its original batch with previous expansion ' + JSON.stringify(expanded), async () => {
  const fixture = expansionEvents(expanded), {value, listeners, grid, panel, target: outside, click} = fixture;
  value.previews[1].sample.batch_expected = 2; value._sampleModelCache = null;
  const {target: cover} = delegatedCover(grid, 'step-2');
  const replacements = [];
  value._replaceSampleBatchCards = (targetPanel, ids) => {assert.equal(targetPanel, panel); replacements.push(ids);};
  value._activateOverviewBatch = batch => {value.sampleBatchId = batch.id;};
  try {
    listeners.get('pointerdown')({target: cover, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    value.sampleGridPointerDown({currentTarget: grid, target: cover, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    listeners.get('pointerup')({target: outside, pointerId: 1, clientX: 400, clientY: 300});
    const event = click({button: 0, detail: 1, pointerId: 1});
    listeners.get('click')(event);
    await afterSampleClick();
    assert.equal(value.sampleExpandedBatchId, 'step-2');
    assert.equal(value.sampleBatchId, 'step-2');
    assert.deepEqual(replacements, [expanded ? ['step-1', 'step-2'] : ['step-2']]);
    assert.equal(value._sampleGridPointer, null);
  } finally {fixture.restore();}
});

test('document pointer tracking preserves drags and cancellations when release leaves the grid', async () => {
  for (const gesture of ['drag-return', 'cancel']) {
    const fixture = expansionEvents(), {value, listeners, grid, target: outside, click} = fixture;
    const {target: cover} = delegatedCover(grid, 'step-2');
    const actions = []; value.toggleSampleBatch = id => actions.push(id);
    try {
      value.sampleGridPointerDown({currentTarget: grid, target: cover, button: 0, pointerId: 1, clientX: 400, clientY: 300});
      if (gesture === 'drag-return') listeners.get('pointermove')({pointerId: 1, clientX: 420, clientY: 300});
      else listeners.get('pointercancel')({pointerId: 1});
      listeners.get('pointerup')({target: outside, pointerId: 1, clientX: 400, clientY: 300});
      listeners.get('click')(click({button: 0, detail: 1, pointerId: 1}));
      await afterSampleClick();
      assert.deepEqual(actions, [], gesture);
      assert.equal(value.sampleExpandedBatchId, 'step-1');
    } finally {fixture.restore();}
  }
});

test('document capture leaves in-grid cover clicks for the grid to switch exactly once', async () => {
  const fixture = expansionEvents(), {value, listeners, grid, click} = fixture;
  const {cover, target} = delegatedCover(grid, 'step-2');
  cover.classList = {contains: name => name === 'm-sample-batch-cover'};
  const actions = []; value.toggleSampleBatch = id => actions.push(id);
  try {
    value.sampleGridPointerDown({currentTarget: grid, target, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    listeners.get('pointerup')({pointerId: 1, clientX: 400, clientY: 300});
    const event = click({target, currentTarget: grid, button: 0, detail: 1, composedPath: () => [target, cover, grid]});
    listeners.get('click')(event);
    assert.deepEqual(actions, []);
    value.sampleGridClick(event);
    await afterSampleClick();
    assert.deepEqual(actions, ['step-2']);
  } finally {fixture.restore();}
});

test('a deferred sample snapshot resumes after pointer completion and the original click', async () => {
  for (const kind of ['cover', 'image']) for (const cancel of [false, true]) {
    const value = app([image('step-1', 'fox', 2)]);
    const grid = {}, {target} = kind === 'cover' ? delegatedCover(grid, 'step-1') : delegatedImage(grid, 0, 'step-1-fox.png'), order = [];
    value.currentRoute = 'monitor-dashboard'; value.monitorTab = 'samples';
    value.renderDashboard = () => order.push('render');
    value.toggleSampleBatch = () => order.push('click');
    value.selectSampleImage = () => order.push('click');
    value.sampleGridPointerDown({currentTarget: grid, target, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    value._sampleGridPointer.renderPending = true;
    const event = {pointerId: 1, clientX: 400, clientY: 300};
    if (cancel) value.sampleGridPointerCancel(event);
    else value.sampleGridPointerUp(event);
    value.sampleGridPointerUp(event);
    assert.deepEqual(order, []);
    value.sampleGridClick({currentTarget: grid, target, button: 0, detail: 1, ...event});
    await afterSampleClick();
    assert.deepEqual(order, cancel ? ['render'] : ['click', 'render']);
  }
});

test('a snapshot arriving after pointerup still retries when the browser cancels click', async () => {
  const value = app([image('step-1', 'fox', 2)]);
  const grid = {}, {target} = delegatedCover(grid, 'step-1');
  let renders = 0;
  value.currentRoute = 'monitor-dashboard'; value.monitorTab = 'samples';
  value.renderDashboard = () => {renders++; assert.equal(value._sampleGridPointer, null);};
  value.sampleGridPointerDown({currentTarget: grid, target, button: 0, pointerId: 1, clientX: 400, clientY: 300});
  value.sampleGridPointerUp({pointerId: 1, clientX: 400, clientY: 300});
  await Promise.resolve();
  value._sampleGridPointer.renderPending = true;
  await afterSampleClick();
  assert.equal(renders, 1);
  assert.equal(value._sampleGridPointer, null);
});

test('window blur releases an unfinished cover press and resumes pending snapshots without leaking listeners', async () => {
  const oldAdd = window.addEventListener, oldRemove = window.removeEventListener, windowEvents = new Map();
  window.addEventListener = (type, handler, capture) => {
    assert.equal(type, 'blur'); assert.ok(!capture, 'child focus changes must not cancel cover presses');
    assert.equal(windowEvents.size, 0); windowEvents.set(type, handler);
  };
  window.removeEventListener = (type, handler) => {if (windowEvents.get(type) === handler) windowEvents.delete(type);};
  const fixture = expansionEvents(), {value, grid, panel} = fixture;
  const {target} = delegatedCover(grid, 'step-2');
  let renders = 0; value.renderDashboard = () => {renders++;};
  try {
    value.sampleGridPointerDown({currentTarget: grid, target, button: 0, pointerId: 1, clientX: 400, clientY: 300});
    value._sampleGridPointer.renderPending = true;
    windowEvents.get('blur')();
    assert.equal(value._sampleGridPointer.cancelled, true);
    await afterSampleClick();
    assert.equal(value._sampleGridPointer, null);
    assert.equal(renders, 1);
    value.sampleExpandedBatchId = '';
    value._connectSampleExpansionUI(panel);
    assert.equal(windowEvents.size, 1, 'rebinding replaces the old window listener');
    fixture.restore();
    assert.equal(windowEvents.size, 0);
  } finally {fixture.restore(); window.addEventListener = oldAdd; window.removeEventListener = oldRemove;}
});

test('grid cover intent ignores drags cancellations and outside presses while keyboard clicks use the actual button', () => {
  for (const gesture of ['drag', 'cancel', 'outside']) {
    const value = app([image('step-1', 'fox', 2), image('step-2', 'fox', 2)]);
    const grid = {}, {target} = delegatedCover(grid, 'step-2');
    const opened = []; value.toggleSampleBatch = id => opened.push(id);
    value.sampleGridPointerDown({currentTarget: grid, target: gesture === 'outside' ? grid : target,
      button: 0, pointerId: 1, clientX: 100, clientY: 100});
    if (gesture === 'cancel') value.sampleGridPointerCancel({pointerId: 1});
    else {
      if (gesture === 'drag') value.sampleGridPointerMove({pointerId: 1, clientX: 110, clientY: 100});
      value.sampleGridPointerUp({pointerId: 1, clientX: gesture === 'drag' ? 110 : 100, clientY: 100});
    }
    value.sampleGridClick({currentTarget: grid, target: gesture === 'outside' ? grid : target,
      button: 0, detail: 1, clientX: gesture === 'drag' ? 110 : 100, clientY: 100});
    assert.deepEqual(opened, [], gesture + ' must not open a cover');
    value.sampleGridClick({currentTarget: grid, target, button: 0, detail: 0});
    assert.deepEqual(opened, ['step-2'], 'keyboard activation does not depend on pointer intent');
  }
});

test('delegated main image clicks retain file identity if a snapshot changed its array position', () => {
  const value = app([image('step-1'), image('step-2')]);
  const imageButton = {dataset: {previewIndex: '0', previewPath: 'step-2-fox.png'}};
  const target = {closest: selector => selector === '.preview-grid-item[data-preview-index]' ? imageButton : null};
  const grid = {contains: node => node === imageButton};
  let opened = -1; value.selectSampleImage = index => {opened = index;};
  value.sampleGridClick({currentTarget: grid, target, button: 0, detail: 1});
  assert.equal(opened, 1);
});
