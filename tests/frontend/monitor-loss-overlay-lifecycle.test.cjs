const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins} = require('./helpers.cjs');

function runtime() {
  const bounds = {left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500};
  const mutations = [];
  const element = () => {
    let hidden = false, html = '';
    return {
      children: [], dataset: {}, offsetWidth: 800,
      get offsetHeight() {return this.className === 'm-sample-loss-overlay' ? 93 : this.parent?.getBoundingClientRect().height || 500;},
      style: new Proxy({}, {set(target, key, value) {mutations.push(['style', key, value]); target[key] = value; return true;}}),
      get hidden() {return hidden;}, set hidden(value) {mutations.push(['hidden', value]); hidden = value;},
      get innerHTML() {return html;}, set innerHTML(value) {mutations.push(['html', value]); html = value;},
      append(child) {if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
        this.children.push(child); child.parent = this; mutations.push(['append']);},
      remove() {this.parent.children = this.parent.children.filter(child => child !== this); mutations.push(['remove']);},
      replaceChildren() {this.children = []; mutations.push(['replace']);},
      getBoundingClientRect: () => bounds,
    };
  };
  const layer = element(), stage = element(), viewport = element(), image = {[Symbol.toStringTag]: 'HTMLImageElement',
    dataset: {}, src: '/sample-1.png', getAttribute() {return this.src;}};
  let stageBounds = {...bounds};
  stage.getBoundingClientRect = () => stageBounds;
  const document = {createElement: element, getElementById: id => ({previewLossLayer: layer,
    previewLightboxViewport: viewport, previewCurrentStage: stage, previewLightboxImg: image})[id] || null};
  const microtasks = [];
  const context = loadFrontend(['vendor/alpine.min', 'monitor/artifacts-render'], {
    window: {Element: class {}, AnimaImages: {cancel() {}}}, document,
    MutationObserver: class {}, queueMicrotask() {}, setTimeout, clearTimeout,
  });
  context.queueMicrotask = callback => microtasks.push(callback);
  const alpine = context.window.Alpine;
  const value = alpine.reactive(composeMixins(context.window.monitorArtifactsRenderMixin, {
    previewLightboxOpen: true, previewComparisonWaiting: false, previewCompareActive: false,
    previewImageLoading: false, previewImageAvailable: true, sampleEffectiveLossMode: 'detailed', previewStep: 0,
    lossDataVersion: 1, previews: [{path: 'one', url: '/sample-1.png'}, {path: 'two', url: '/sample-2.png'}],
    _previewItemKey: preview => preview.path,
    _sampleLossOverlayHtml(preview, comparison) {
      assert.equal(comparison, true, 'viewer overlays use comparison-relative deltas');
      return `${preview.path}:${this.sampleEffectiveLossMode}:${this.lossDataVersion}`;
    },
  }));
  image.dataset.previewDisplayedKey = value._previewImageCacheKey(value.previews[0]);
  const effect = alpine.effect(() => value._syncPreviewLossOverlays());
  const flush = () => {
    let iterations = 0;
    while (microtasks.length) {
      assert.ok(++iterations < 100, 'the Alpine effect must settle');
      microtasks.shift()();
    }
  };
  const dispose = () => alpine.release(effect);
  return {value, image, layer, stage, viewport, mutations, flush, dispose, setBounds(next) {stageBounds = {...bounds, ...next};}};
}

test('Alpine keeps the displayed file loss through a pending image swap, mode change, and live scalar update', () => {
  const h = runtime(), {value, image, layer} = h;
  try {
    const node = layer._lossNodes.get('current');
    value.previewStep = 1; value.previewImageLoading = true; value.previewImageAvailable = false; h.flush();
    assert.equal(layer._lossNodes.get('current'), node);
    assert.equal(node.overlay.dataset.previewPath, 'one', 'old visible pixels retain their own epoch');
    assert.equal(node.overlay.innerHTML, 'one:detailed:1');
    value.sampleEffectiveLossMode = 'overall'; h.flush();
    value.lossDataVersion++; h.flush();
    assert.equal(layer._lossNodes.get('current'), node);
    assert.equal(node.overlay.innerHTML, 'one:overall:2');
    image.src = '/sample-2.png'; image.dataset.previewDisplayedKey = value._previewImageCacheKey(value.previews[1]);
    value.previewImageLoading = false; value.previewImageAvailable = true; h.flush();
    assert.equal(layer._lossNodes.get('current'), node, 'committing the new file updates the same overlay');
    assert.equal(node.overlay.dataset.previewPath, 'two');
    assert.equal(node.overlay.innerHTML, 'two:overall:2');
  } finally {h.dispose();}
});

test('enabling loss during a pending swap finds the actual displayed file without an old overlay', () => {
  const h = runtime(), {value, layer, image} = h;
  try {
    value.sampleEffectiveLossMode = 'off'; h.flush();
    value.previewStep = 1; value.previewImageLoading = true; value.previewImageAvailable = false; h.flush();
    value.sampleEffectiveLossMode = 'overall'; h.flush();
    assert.equal(layer._lossNodes.get('current').overlay.dataset.previewPath, 'one');
    image.src = ''; delete image.dataset.previewDisplayedKey;
    value.previewImageLoading = false; h.flush();
    assert.equal(layer._lossNodes.size, 0, 'a failed/removed image cannot leave an unrelated loss behind');
  } finally {h.dispose();}
});

test('reopening the viewer and reusing a decoded fallback thumbnail cannot retain an old displayed identity', () => {
  const h = runtime(), {value, image, layer} = h;
  try {
    const next = value.previews[1];
    next.thumb_url = '/sample-2-thumb.png';
    image.src = ''; image.isConnected = true;
    value.previewStep = 1; value._previewImageRequest = 0;
    value._queuePreviewImage = () => {};
    value._displayPreviewImage(image, next); h.flush();
    assert.equal(image.dataset.previewDisplayedKey, undefined, 'the new placeholder has no previously committed pixels');
    assert.equal(layer._lossNodes.size, 0, 'reopening must not put the last file loss over the new thumbnail');
    image.complete = true; image.naturalWidth = 512;
    const key = value._previewImageCacheKey(next);
    value._failPreviewViewerImage({element: image, preview: next, key, request: value._previewImageRequest}); h.flush();
    assert.equal(image.dataset.previewDisplayedKey, key, 'a reused decoded target thumbnail commits its file identity');
    assert.equal(layer._lossNodes.get('current').overlay.dataset.previewPath, 'two');
    value.previewStep = 0; value.previewImageLoading = true; value.previewImageAvailable = false; h.flush();
    assert.equal(layer._lossNodes.get('current').overlay.dataset.previewPath, 'two', 'the fallback remains stable during the following navigation');
  } finally {h.dispose();}
});

test('comparison panels share the image tree and never rewrite coordinates during scrolling or FLIP', () => {
  const h = runtime(), {value, layer, stage, mutations} = h;
  try {
    value.previewCompareActive = true; h.flush();
    const node = layer._lossNodes.get('current');
    assert.equal(node.parent, stage);
    assert.equal(node.anchor.dataset.imageAnchored, 'true');
    assert.equal(layer.hidden, true, 'the separate viewport layer is unused during comparisons');
    mutations.length = 0;
    value._layoutPreviewLossOverlays();
    assert.deepEqual(mutations, [], 'unchanged layout must not churn styles or hidden attributes');
    h.setBounds({left: -760, right: 40});
    value._layoutPreviewLossOverlays();
    assert.equal(node.anchor.hidden, false, 'a narrow visible image edge retains its panel');
    assert.deepEqual(mutations, [], 'the native scroll tree moves and clips the panel without a delayed geometry write');
    h.setBounds({left: 770, right: 1570});
    value._layoutPreviewLossOverlays();
    assert.equal(node.anchor.hidden, false);
    assert.deepEqual(mutations, []);
    h.setBounds({bottom: 100, height: 100});
    value._layoutPreviewLossOverlays();
    assert.equal(node.anchor.hidden, true, 'a short image container still suppresses a panel that cannot fit');
    mutations.length = 0; value._layoutPreviewLossOverlays();
    assert.deepEqual(mutations, [], 'hidden anchors retain stable measurements');
  } finally {h.dispose();}
});

test('single-image loss stays anchored to the viewport when the image is panned or zoomed', () => {
  const h = runtime(), {value, layer, mutations} = h;
  try {
    const node = layer._lossNodes.get('current');
    const initial = {...node.anchor.style};
    mutations.length = 0;
    h.setBounds({left: 300, right: 1900, width: 1600, top: -600, bottom: 400, height: 1000});
    value._layoutPreviewLossOverlays();
    assert.deepEqual({...node.anchor.style}, initial);
    assert.equal(node.anchor.hidden, false);
    assert.deepEqual(mutations, [], 'image movement does not reposition or hide the single-image panel');
  } finally {h.dispose();}
});

test('single-image anchors exclude scrollbar gutters and mode switches reuse the image-owned panel', () => {
  const h = runtime(), {value, layer, stage, viewport} = h;
  try {
    Object.assign(viewport, {clientLeft: 2, clientTop: 3, clientWidth: 780, clientHeight: 480});
    value._layoutPreviewLossOverlays();
    assert.equal(layer.style.clipPath, 'inset(3.00px 18.00px 17.00px 2.00px)');
    const node = layer._lossNodes.get('current');
    assert.equal(node.anchor.style.left, '2px');
    assert.equal(node.anchor.style.top, '3px');
    assert.equal(node.anchor.style.width, '780px');
    assert.equal(node.anchor.style.height, '494px', 'single-image anchors use the frame interior, independent of scrollbar height');
    value.previewCompareActive = true; h.flush();
    assert.equal(node.parent, stage);
    assert.equal(node.anchor.style.width, '', 'the comparison uses native container width');
    value.previewCompareActive = false; h.flush();
    assert.equal(layer._lossNodes.get('current'), node);
    assert.equal(node.parent, layer);
    assert.equal(stage.children.length, 0, 'switching modes leaves no panel in the old image container');
    assert.equal(node.anchor.style.width, '780px');
  } finally {h.dispose();}
});

test('appearing and disappearing horizontal scrollbars do not shift the single-image loss panel', () => {
  const h = runtime(), {value, layer, viewport, mutations} = h;
  try {
    Object.assign(viewport, {clientWidth: 792, clientHeight: 500});
    value._layoutPreviewLossOverlays();
    const node = layer._lossNodes.get('current'), initial = {...node.anchor.style};
    for (const height of [492, 500, 492, 500]) {
      viewport.clientHeight = height;
      mutations.length = 0;
      value._layoutPreviewLossOverlays();
      assert.deepEqual({...node.anchor.style}, initial, 'the same fixed anchor survives both scrollbar states');
      assert.equal(node.anchor.hidden, false);
      assert.equal(mutations.filter(([type, key]) => type === 'style' && key !== 'clipPath').length, 0,
        'only viewport clipping changes, without repositioning the panel');
      assert.equal(layer.style.clipPath, `inset(0.00px 8.00px ${(500 - height).toFixed(2)}px 0.00px)`);
    }
  } finally {h.dispose();}
});

test('loss modes and detail availability patch captions without rebuilding the sidebar Alpine viewport', () => {
  let rebuilds = 0, captionHtml = '';
  const caption = {dataset: {sampleLossBatch: 'epoch-1', sampleLossDetail: 'Prompt 2', sampleLossStatus: ''},
    set outerHTML(html) {captionHtml = html;}};
  const panel = {firstElementChild: {}, classList: {add() {}}, contains: () => false, querySelector: () => null,
    querySelectorAll: () => [caption], set innerHTML(_html) {rebuilds++;}};
  const document = {getElementById: id => id === 'monitorTabContent' ? {querySelector: () => panel} : null};
  const {window} = loadFrontend(['monitor/render'], {window: {}, document});
  const value = composeMixins(window.monitorArtifactsRenderMixin, window.monitorRenderMixin, {
    _builtTab: 'samples', _shellLocale: 'test', previewsVersion: 1, lossDataVersion: 1, _patchSampleBatchOrder() {},
    sampleEffectiveLossMode: 'off', sampleDetailedLossAvailable: true, runDetailData: {},
    _disconnectSampleExpansionUI() {}, _cancelSampleGridMotion() {}, _cancelPreviewMediaQueue() {},
    _capturePreviewMedia: () => new Map(), _restorePreviewMedia() {}, _renderSamplesTab: () => 'sample viewport',
    _sampleDataModel: () => ({byBatch: new Map([['epoch-1', {id: 'epoch-1'}]])}),
    _sampleCardCaptionHtml(batch, detail, status) {return [batch.id, this.sampleEffectiveLossMode, this.lossDataVersion, detail, status].join(':');},
    _refreshSampleGroupOutline() {}, _connectSampleExpansionUI() {}, schedulePreviewMediaLoads() {},
  });
  const render = () => value._renderTab('samples', {}, null, null, () => '', true);
  render();
  assert.equal(rebuilds, 1);
  for (const mode of ['overall', 'detailed', 'off']) {
    value.sampleEffectiveLossMode = mode; render();
    assert.equal(rebuilds, 1, `${mode} must preserve the existing sidebar viewport and its image`);
    assert.equal(captionHtml, `epoch-1:${mode}:1:Prompt 2:`);
  }
  value.sampleDetailedLossAvailable = false; value.lossDataVersion++; render();
  assert.equal(rebuilds, 1, 'logging availability and incoming scalars only update loss presentation');
  assert.equal(captionHtml, 'epoch-1:off:1:Prompt 2:', 'disabled loss does not rewrite unchanged captions on scalar updates');
});

test('unrelated live metrics preserve caption nodes and their in-progress marquee animation', () => {
  let writes = 0, loss = '.0943';
  const caption = {dataset: {sampleLossBatch: 'epoch-4', sampleLossDetail: '', sampleLossStatus: ''},
    set outerHTML(_html) {writes++;}};
  const panel = {querySelectorAll: () => [caption]};
  const {window} = loadFrontend(['monitor/artifacts-render'], {window: {}, document: {}});
  const value = composeMixins(window.monitorArtifactsRenderMixin, {
    sampleEffectiveLossMode: 'detailed', lossDataVersion: 1,
    _sampleDataModel: () => ({byBatch: new Map([['epoch-4', {id: 'epoch-4'}]])}),
    _sampleCardCaptionHtml: () => `Epoch 4 Step 1600 ${loss}`,
  });
  value._patchSampleLossCaptions(panel);
  assert.equal(writes, 1);
  for (let i = 0; i < 20; i++) {value.lossDataVersion++; value._patchSampleLossCaptions(panel);}
  assert.equal(writes, 1, 'step loss/LR updates must not restart the caption animation');
  loss = '.0900'; value.lossDataVersion++; value._patchSampleLossCaptions(panel);
  assert.equal(writes, 2, 'an actual epoch loss change updates the caption');
  panel.querySelectorAll = () => [];
  value.lossDataVersion++; value._patchSampleLossCaptions(panel);
  assert.equal(panel._sampleLossCaptionHtml.size, 0, 'removed captions must not accumulate in the cache');
});
