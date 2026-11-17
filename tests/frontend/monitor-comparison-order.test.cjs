const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');
const {withAnimationFrames} = require('./helpers-animation.cjs');
global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

function app() {
  const previews = [1, 2, 3, 4].map(epoch => ({name: `${epoch}.png`, path: `sample/${epoch}.png`, url: `/${epoch}.png`, sample: {
    batch_id: `b${epoch}`, batch_label: `Epoch ${epoch} · Step ${epoch * 400}`, epoch, step: epoch * 400, stage_kind: 'epoch',
    prompt_id: 'fox', prompt_index: 0, seed: 42, condition_key: 'same', comparable: true, metadata_source: 'recorded',
    params: {prompt: 'fox', negative_prompt: '', seed: 42, width: 512, height: 512, sampler: 'euler', cfg_scale: 5},
  }}));
  return composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews, previewsVersion: 1, previewStep: 3, previewImageAvailable: true, lossDataVersion: 1,
    lossSeries: [{tag: 'loss/epoch', points: [{step: 1, value: .1}, {step: 2, value: .09}, {step: 3, value: .08}, {step: 4, value: .07}]}],
    monitorData: {}, t: key => key, renderDashboard() {}, _updatePreviewLightbox() {},
  });
}

test('comparison order preserves the browsing slot while fixed references and the loss baseline move', () => {
  const value = app(); value.pinPreviewReference(0); value.pinPreviewReference(1); value.selectPreviewComparisonCurrent(3);
  assert.deepEqual(value.previewComparisonOrder, ['sample/1.png', 'sample/2.png', null]);
  assert.equal(value.reorderPreviewComparison(['sample/2.png', null, 'sample/1.png']), true);
  assert.equal(value._previewComparisonBaselinePreview(), value.previews[1]);
  value.selectPreviewComparisonCurrent(2);
  assert.deepEqual(value.previewComparisonOrder, ['sample/2.png', null, 'sample/1.png']);
  assert.equal(value.reorderPreviewComparison([null, 'sample/2.png', 'sample/1.png']), true);
  assert.deepEqual(value.previewComparisonOrder, ['sample/3.png', 'sample/2.png', 'sample/1.png', null]);
  assert.equal(value.previewComparisonWaiting, true, 'moving the browsing image to first freezes its file as the baseline');
  value.selectPreviewComparisonCurrent(3);
  assert.equal(value._previewComparisonBaselinePreview(), value.previews[2]);
  assert.equal(value.reorderPreviewComparison(['sample/3.png', 'sample/3.png', 'sample/1.png', null]), false);
});

test('right-click promotion adds or reuses a reference without losing a different current image', () => {
  const value = app(); value.pinPreviewReference(0); value.selectPreviewComparisonCurrent(3);
  assert.equal(value.movePreviewToFirst(1), true);
  assert.equal(value.previewStep, 3); assert.equal(value.previewComparisonWaiting, false);
  assert.deepEqual(value.previewComparisonOrder, ['sample/2.png', 'sample/1.png', null]);
  assert.equal(value.movePreviewToFirst(0), true);
  assert.equal(value.previewReferences.length, 2);
  assert.equal(value._previewComparisonBaselinePreview(), value.previews[0]);
  value.previewImageLoading = true;
  assert.equal(value.movePreviewToFirst(3), false);
  value.previewImageLoading = false;
  assert.equal(value.movePreviewToFirst(3), true);
  assert.equal(value.previewComparisonWaiting, true);
  assert.equal(value._previewComparisonBaselinePreview(), value.previews[3]);
});

test('modal percentages use the first fixed file while sidebar percentages retain the preceding epoch', () => {
  const value = app(); value.sampleLossMode = 'overall'; value.pinPreviewReference(0); value.selectPreviewComparisonCurrent(2);
  assert.match(value._sampleLossOverlayHtml(value.previews[2], true), /-20\.0%/);
  assert.match(value._sampleLossOverlayHtml(value.previews[2]), /-11\.1%/);
  assert.match(value._sampleLossOverlayHtml(value.previews[0], true), /sampleLossBaseline/);
  value.movePreviewToFirst(1);
  assert.match(value._sampleLossOverlayHtml(value.previews[2], true), /-11\.1%/);
  value.previewComparisonLayout = 'vertical';
  assert.match(value._sampleLossOverlayHtml(value.previews[2], true), /sampleLossVersusTop/);
  value.previews = value.previews.filter(preview => preview.sample.epoch !== 2); value.previewsVersion++;
  value.previewStep = 1; value._syncPreviewReference();
  assert.equal(value._previewComparisonBaselinePreview().sample.epoch, 1, 'deleting the baseline retains valid fixed files');
});

test('comparison allows image reordering while disabling canvas pan and caption drag', () => {
  const value = app(); value.previewCompareActive = true;
  value._cancelPreviewReset = () => assert.fail('comparison must not enter canvas pan');
  value.startPreviewPan({button: 0});
  assert.match(value._previewPaneImageEventsHtml(), /@pointerdown="startPreviewPaneDrag/);
  assert.doesNotMatch(value._previewPaneCaptionEventsHtml(), /pointerdown|startPreviewPaneDrag/);
});

test('wheel input cancels a captured reorder before scrolling or zooming changes its geometry', () => {
  const value = app(); let cancelled = 0, released = 0, removed = 0;
  value._previewPaneDrag = {pointerId: 7, writer: {cancel() {cancelled++;}},
    handle: {hasPointerCapture: () => true, releasePointerCapture() {released++;}},
    pane: {style: {translate: '100px 0px'}, classList: {remove() {removed++;}}}};
  const pane = value._previewPaneDrag.pane;
  value.zoomPreviewView({deltaY: 0});
  assert.equal(value._previewPaneDrag, null);
  assert.equal(cancelled, 1); assert.equal(released, 1); assert.equal(removed, 1);
  assert.equal(pane.style.translate, '');
});

test('sidebar loss follows the loaded file while a newly selected image is pending', () => {
  const value = app(), previous = global.document;
  global.document = {baseURI: 'http://fixture.test/'};
  try {
    const oldImage = {complete: true, naturalWidth: 512, currentSrc: 'http://fixture.test/1.png'};
    assert.equal(value._sampleSidebarLoadedPreview(oldImage), value.previews[0]);
    assert.equal(value._sampleSidebarLoadedPreview({...oldImage, currentSrc: 'http://fixture.test/4.png'}), value.previews[3]);
    assert.equal(value._sampleSidebarLoadedPreview({...oldImage, complete: false}), null);
    assert.equal(value._sampleSidebarLoadedPreview({...oldImage, currentSrc: 'http://fixture.test/unknown.png'}), null);
  } finally {global.document = previous;}
});

test('dragging an image across its neighbor previews placement, then commits order on release', () => withAnimationFrames(({tick}) => {
  const value = app(); value.pinPreviewReference(0); value.pinPreviewReference(1); value.selectPreviewComparisonCurrent(3);
  let resetCancelled = 0, captured = false;
  value._previewResetCancel = () => {resetCancelled++;};
  const items = value.previewComparisonOrder.map((key, index) => {
    const pane = {style: {order: String(index)}, offsetWidth: 100, dataset: {previewReferenceKey: key},
      classList: {contains: name => key === null && name === 'preview-current-pane', add() {}, remove() {}},
      querySelector: () => null, getBoundingClientRect() {
        const left = Number(this.style.order) * 100;
        return {left, right: left + 100, top: 0, bottom: 100, width: 100, height: 100};
      }};
    return {key, pane};
  });
  value._previewPaneNodes = () => items;
  const previous = global.document;
  const viewport = {scrollLeft: 0, scrollTop: 0, clientWidth: 300, clientHeight: 100,
    getBoundingClientRect: () => ({left: 0, right: 300, top: 0, bottom: 100})};
  global.document = {getElementById: id => id === 'previewLightboxViewport' ? viewport : null};
  value._previewGroupGeometry = {width: 300, height: 100};
  try {
    const pane = items[1].pane;
    const handle = {closest: () => pane, setPointerCapture() {captured = true;},
      hasPointerCapture: () => captured, releasePointerCapture() {captured = false;}};
    const event = {currentTarget: handle, target: {closest: () => null}, button: 0, pointerId: 9,
      clientX: 150, clientY: 50, preventDefault() {}, stopPropagation() {}};
    value.startPreviewPaneDrag(event);
    assert.equal(resetCancelled, 1); assert.equal(captured, true);
    value.movePreviewPaneDrag({...event, clientX: 40}); tick(0);
    assert.equal(pane.style.order, '0'); assert.equal(items[0].pane.style.order, '1');
    assert.equal(parseFloat(pane.style.translate), -10, 'dragged image remains under the pointer as its layout slot changes');
    assert.equal(value.previewComparisonOrder[0], 'sample/1.png', 'baseline changes only after release');
    value.movePreviewPaneDrag({...event, clientX: 310}); tick(20);
    assert.equal(viewport.scrollLeft, 0, 'holding at the edge cannot scroll a fitted comparison into blank space');
    value.movePreviewPaneDrag({...event, clientX: 40}); tick(40);
    value.endPreviewPaneDrag({...event, clientX: 40});
    assert.equal(value.previewComparisonOrder[0], 'sample/2.png');
    assert.equal(captured, false); assert.equal(pane.style.translate, '');
  } finally {global.document = previous;}
}));

test('same-size decoded image upgrades retain a reorder while changed image proportions cancel it', () => {
  const value = app(), previous = global.document;
  let cancellations = 0;
  const images = [{naturalWidth: 200, naturalHeight: 200}, {naturalWidth: 200, naturalHeight: 200}];
  const items = images.map(image => ({querySelector: () => image, style: {
    getPropertyValue: () => '200px', setProperty() {},
  }}));
  const group = {querySelectorAll: () => items};
  const viewport = {clientWidth: 412, clientHeight: 232, classList: {toggle() {}}};
  global.document = {getElementById: id => ({previewReferencePanes: {parentElement: group}, previewLightboxViewport: viewport})[id] || null};
  value._previewGroupGeometry = {count: 2, vertical: false};
  value._previewPaneDrag = {};
  value.cancelPreviewPaneDrag = () => {cancellations++; value._previewPaneDrag = null;};
  value._syncPreviewGroupViewport = () => {};
  try {
    value._layoutPreviewComparisonPanes(2);
    assert.equal(cancellations, 0, 'upgrading thumbnail resolution preserves drag capture');
    images[0].naturalWidth = 400;
    value._layoutPreviewComparisonPanes(2);
    assert.equal(cancellations, 1, 'new proportions invalidate the cached drag slots');
  } finally {global.document = previous;}
});

test('many horizontal comparisons retain room for detailed loss and scroll instead of shrinking again', () => {
  const value = app(), previous = global.document;
  const items = Array.from({length: 6}, () => ({querySelector: () => ({naturalWidth: 512, naturalHeight: 512}),
    style: {getPropertyValue(key) {return this[key] || '';}, setProperty(key, data) {this[key] = data;}}}));
  let visibleItems = items;
  const group = {querySelectorAll: () => visibleItems};
  const viewport = {clientWidth: 940, clientHeight: 500, classList: {toggle() {}}};
  global.document = {getElementById: id => ({previewReferencePanes: {parentElement: group}, previewLightboxViewport: viewport})[id] || null};
  value.previewCompareActive = true; value.previewViewScale = .5; value._previewViewFitted = true;
  value._syncPreviewGroupViewport = () => {};
  try {
    value._layoutPreviewComparisonPanes(6);
    assert.equal(value.previewViewScale, 1);
    assert.equal(value._previewViewFitScale, 1);
    assert.equal(parseFloat(items[0].style['--preview-pane-height']), 240);
    assert(value._previewGroupGeometry.width > viewport.clientWidth, 'existing horizontal scroll receives the overflow');
    viewport.clientWidth = 2400; viewport.clientHeight = 900;
    for (const ratio of [1, .65]) {
      for (const item of items) item.querySelector = () => ({naturalWidth: 1000 * ratio, naturalHeight: 1000});
      value._layoutPreviewComparisonPanes(6);
      const paneWidth = parseFloat(items[0].style['--preview-pane-width']);
      assert(Math.abs(paneWidth * 4 + 36 - viewport.clientWidth) < .1, 'wide windows show four slots even when portrait images are limited by height');
      assert(value._previewGroupGeometry.width > viewport.clientWidth);
    }
    visibleItems = items.slice(0, 4);
    viewport.clientWidth = 1140; viewport.clientHeight = 600;
    for (const ratios of [[.5, .5, 2, 2], [16 / 9, 16 / 9, 16 / 9, 16 / 9]]) {
      visibleItems.forEach((item, index) => {item.querySelector = () => ({naturalWidth: ratios[index] * 1000, naturalHeight: 1000});});
      value._layoutPreviewComparisonPanes(4);
      assert(visibleItems.every(item => parseFloat(item.style['--preview-pane-width']) === 276));
      assert.equal(value._previewGroupGeometry.width, viewport.clientWidth, 'mixed and wide images stay within four equal columns');
    }
    visibleItems = items.slice(0, 2);
    for (const item of visibleItems) item.querySelector = () => ({naturalWidth: 2000, naturalHeight: 1000});
    viewport.clientWidth = 960; viewport.clientHeight = 280;
    value._layoutPreviewComparisonPanes(2);
    assert(value._previewGroupGeometry.width <= viewport.clientWidth, 'short windows must not create a scrollbar feedback loop');
    viewport.clientHeight = 268;
    value._layoutPreviewComparisonPanes(2);
    assert(value._previewGroupGeometry.height + 32 <= viewport.clientHeight);
  } finally {global.document = previous;}
});

test('promoting the last pane scrolls horizontally to the new baseline after drop', () => {
  const value = app(), previous = global.document, scrolls = [];
  const viewport = {scrollLeft: 900, scrollTo(options) {scrolls.push(options);}};
  global.document = {getElementById: () => viewport};
  value.previewComparisonLayout = 'horizontal'; value.previewComparisonOrder = ['first', 'last'];
  value._previewPaneDrag = {pointerId: 1, writer: {flush() {}}, order: ['last', 'first']};
  value._previewPaneNodes = () => [];
  value.cancelPreviewPaneDrag = () => {value._previewPaneDrag = null;};
  value._cancelPreviewPaneAnimations = () => {};
  value._animatePreviewPanePositions = () => {};
  value.reorderPreviewComparison = order => {value.previewComparisonOrder = order; return true;};
  try {
    value.endPreviewPaneDrag({pointerId: 1});
    assert.equal(scrolls.length, 1); assert.equal(scrolls[0].left, 0);
    assert.equal(value.previewComparisonOrder[0], 'last');
    value._previewPaneDrag = {pointerId: 1, writer: {flush() {}}, order: ['last', 'first']};
    value.endPreviewPaneDrag({pointerId: 1});
    assert.equal(scrolls.length, 1, 'an unchanged drop preserves the current scroll');
  } finally {global.document = previous;}
});

test('the final FLIP frame schedules one settled overlay update', async () => {
  const value = app(); let resolve, queued = 0;
  const animation = {finished: new Promise(done => {resolve = done;})};
  value.previewLightboxOpen = true;
  value._previewPaneNodes = () => [{key: 'one', pane: {offsetWidth: 100,
    getBoundingClientRect: () => ({left: 100, top: 0, width: 100}), animate: () => animation}}];
  value.queuePreviewSideNavLayout = () => {queued++;};
  value._animatePreviewPanePositions(new Map([['one', {left: 0, top: 0}]]));
  resolve(); await new Promise(setImmediate);
  assert.equal(value._previewPaneAnimations.size, 0);
  assert.equal(queued, 1, 'the final position must be measured after native animation completion');
});
