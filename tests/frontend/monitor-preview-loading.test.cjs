const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred} = require('./helpers.cjs');

function sample(batch, changes = {}) {
  const condition = changes.condition || 'same', prompt = changes.prompt || 'p1';
  return {name: `b${batch}.png`, path: `sample/b${batch}.png`, url: `/original-${batch}`,
    thumb_url: `/thumb-${batch}`, version: '1', sample: {
      batch_id: `b${batch}`, batch_label: `Epoch ${batch}`, prompt_id: prompt,
      prompt_index: 0, seed: 123, condition_key: condition, comparable: true,
      metadata_source: 'recorded', params: {prompt, negative_prompt: ''},
    }};
}

function fixture(previews = [sample(1), sample(2), sample(3)]) {
  const images = [], history = [];
  const element = (writes = []) => ({isConnected: true, _src: '', alt: '',
    get src() {return this._src;}, set src(value) {this._src = value; writes.push(value);},
    removeAttribute(name) {if (name === 'src') this._src = '';}, dispatchEvent() {}});
  const viewer = element(history);
  const document = {addEventListener() {}, getElementById(id) {
    return id === 'previewLightboxImg' ? viewer : null;
  }};
  const context = loadFrontend(['shared/image-loading', 'monitor/previews', 'monitor/artifacts-render'], {
    window: {}, document,
    CustomEvent: class {constructor(type, options) {this.type = type; this.detail = options.detail;}},
    Image: class {
      constructor() {this.ready = deferred(); this.naturalWidth = 1000; this.naturalHeight = 800; images.push(this);}
      decode() {return this.ready.promise;}
    },
  });
  const app = composeMixins(context.window.monitorPreviewsMixin, context.window.monitorArtifactsRenderMixin, {
    previews, previewsVersion: 1, previewStep: 1, previewLightboxOpen: true,
    weakNetworkMode: false, currentRoute: 'other',
    t(key) {return key;},
  });
  return {app, viewer, images, history};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('viewer preserves its decoded image until the next target is ready and revisits a prefetched original without a flash', async () => {
  const {app,viewer,images,history} = fixture();
  app._displayPreviewImage(viewer, app.previews[1]);
  assert.equal(viewer.src, '/thumb-2'); assert.equal(images[0].src, '/original-2');
  images[0].ready.resolve(); await tick();
  assert.equal(viewer.src, '/original-2');
  assert.equal(images[1].src, '/original-1'); assert.equal(images[1].fetchPriority, 'low');
  images[1].ready.resolve(); await tick();
  assert.equal(images[2].src, '/original-3');
  app.previewStep = 2; app._displayPreviewImage(viewer, app.previews[2]);
  assert.equal(viewer.src, '/original-2', 'keep the decoded frame until the new original is ready');
  assert.equal(images[2].fetchPriority, 'high', 'a selected in-flight prefetch becomes foreground work');
  app.previewStep = 0;
  const priorLength = history.length;
  app._displayPreviewImage(viewer, app.previews[0]);
  assert.equal(viewer.src, '/original-1');
  assert.deepEqual(history.slice(priorLength), ['/original-1']);
  images[2].ready.resolve(); await tick();
  assert.equal(viewer.src, '/original-1', 'a late original cannot replace the current image');
});

test('weak network avoids background originals and failures keep the target thumbnail for retry', async () => {
  const {app,viewer,images} = fixture(); app.weakNetworkMode = true;
  app._displayPreviewImage(viewer, app.previews[1]); images[0].ready.resolve(); await tick();
  assert.equal(images.length, 1);
  app.previewStep = 0; app._displayPreviewImage(viewer, app.previews[0]);
  assert.equal(viewer.src, '/original-2'); images[1].ready.reject(new Error('offline')); await tick();
  assert.equal(viewer.src, '/original-2', 'a fallback thumbnail also waits for decode');
  assert.equal(images[2].src, '/thumb-1'); images[2].ready.resolve(); await tick();
  assert.equal(viewer.src, '/thumb-1'); assert.equal(app.previewImageError, true);
  assert.equal(app.previewImageAvailable, true);
  assert.equal(app.canPinCurrentPreview(), true, 'a decoded target thumbnail is sufficient for comparison');
  app._previewImageKey = ''; app._displayPreviewImage(viewer, app.previews[0]);
  assert.equal(images.length, 4); images[3].ready.resolve(); await tick();
  assert.equal(viewer.src, '/original-1'); assert.equal(app.previewImageError, false);
  assert.equal(images.length, 4);
});

test('enabling weak mode discards queued neighbor work and ignores an obsolete prefetch', async () => {
  const {app,viewer,images} = fixture();
  app._displayPreviewImage(viewer, app.previews[1]); images[0].ready.resolve(); await tick();
  assert.equal(images.length, 2);
  const key = app._previewImageCacheKey(app.previews[0]);
  app.weakNetworkMode = true; app._displayPreviewImage(viewer, app.previews[1]);
  images[1].ready.resolve(); await tick();
  assert.equal(images.length, 2, 'the queued neighbor does not start');
  assert.equal(app._previewOriginalCache.get(key), undefined);
});

test('only matching prompt and generation conditions are prefetched', async () => {
  const {app,viewer,images} = fixture([sample(1, {condition:'changed'}), sample(2), sample(3)]);
  app._displayPreviewImage(viewer, app.previews[1]); images[0].ready.resolve(); await tick();
  assert.equal(images.length, 2); assert.equal(images[1].src, '/original-3');
  images[1].ready.resolve(); await tick(); assert.equal(images.length, 2);
});

test('a failed original and thumbnail clear the prior sample instead of showing it under the new label', async () => {
  const {app,viewer,images} = fixture(); app.weakNetworkMode = true;
  app._displayPreviewImage(viewer, app.previews[1]); images[0].ready.resolve(); await tick();
  app.previewStep = 0; app._displayPreviewImage(viewer, app.previews[0]);
  images[1].ready.reject(new Error('original missing')); await tick();
  images[2].ready.reject(new Error('thumbnail missing')); await tick();
  assert.equal(viewer.src, '');
  assert.equal(app.previewImageLoading, false); assert.equal(app.previewImageError, true);
  assert.equal(app.canPinCurrentPreview(), false);
  assert.equal(app.previewReferenceActionTitle(), 'monitor.previewImageFailed');
  let started = 0, pinned = 0;
  app.startPreviewComparison = () => {started++;};
  app.setCurrentPreviewAsReference = () => {pinned++; return false;};
  app.togglePreviewReference();
  app.previewCompareActive = true; app.pinCurrentPreviewReference();
  assert.equal(started, 0); assert.equal(pinned, 0, 'both current-image actions reject an unavailable target');
  app.previewCompareActive = false; app._previewImageKey = '';
  app._displayPreviewImage(viewer, app.previews[0]); images[3].ready.resolve(); await tick();
  assert.equal(app.canPinCurrentPreview(), true, 'a successful retry restores comparison');
  app.togglePreviewReference();
  app.previewCompareActive = true; app.pinCurrentPreviewReference();
  assert.equal(started, 1); assert.equal(pinned, 1);
  app._clearPreviewImageLoading();
  assert.equal(app.previewImageAvailable, false);
});

test('an early original failure still waits for the initial thumbnail to finish decoding', async () => {
  const {app,viewer,images} = fixture(); app.weakNetworkMode = true;
  viewer.complete = false; viewer.naturalWidth = 0;
  app._displayPreviewImage(viewer, app.previews[1]);
  images[0].ready.reject(new Error('original missing')); await tick();
  assert.equal(images[1].src, '/thumb-2');
  assert.equal(viewer.src, '/thumb-2');
  assert.equal(app.previewImageLoading, true, 'a pending thumbnail is not a failed image');
  images[1].ready.resolve(); await tick();
  assert.equal(viewer.src, '/thumb-2');
  assert.equal(app.previewImageLoading, false); assert.equal(app.previewImageError, true);
  assert.equal(app.canPinCurrentPreview(), true);
});

test('training keeps original loads in the foreground and button guidance follows loading state', async () => {
  const {app,viewer,images} = fixture(); app.trainingActive = true;
  app._displayPreviewImage(viewer, app.previews[1]);
  assert.equal(app.previewReferenceActionTitle(), 'monitor.loading');
  images[0].ready.resolve(); await tick();
  assert.equal(images.length, 1, 'training must not prefetch neighbor originals');
  assert.equal(app.previewReferenceActionTitle(), 'monitor.samplePinCurrentHint');
});

test('a replaced sample version is loaded anew even when its source path stays the same', async () => {
  const {app,viewer,images} = fixture(); app.weakNetworkMode = true;
  app._displayPreviewImage(viewer, app.previews[1]); images[0].ready.resolve(); await tick();
  app.previews[1] = {...app.previews[1], version: '2', thumb_url: '/new-thumb'};
  app._displayPreviewImage(viewer, app.previews[1]);
  assert.equal(viewer.src, '/original-2'); assert.equal(images.length, 2);
  images[1].ready.resolve(); await tick(); assert.equal(viewer.src, '/original-2');
});

test('rapid page or prompt changes retain only the latest queued original and ignore obsolete decodes', async () => {
  const {app,viewer,images} = fixture([1, 2, 3, 4, 5].map(number => sample(number)));
  app.weakNetworkMode = true;
  for (let index = 0; index < app.previews.length; index++) {
    app.previewStep = index; app._displayPreviewImage(viewer, app.previews[index]);
  }
  assert.equal(images.length, 2, 'foreground decoding is bounded while pages are being skipped');
  assert.equal(viewer.src, '/thumb-1');
  images[0].ready.resolve(); await tick();
  assert.equal(images.length, 3);
  assert.equal(images[2].src, '/original-5', 'intermediate queued targets are replaced');
  assert.equal(viewer.src, '/thumb-1');
  images[2].ready.resolve(); await tick();
  assert.equal(viewer.src, '/original-5');
  images[1].ready.resolve(); await tick();
  assert.equal(viewer.src, '/original-5');
});

test('closing or resetting cancels requests and releases the original cache', async () => {
  const {app,viewer,images} = fixture();
  app._displayPreviewImage(viewer, app.previews[1]);
  const cache = app._previewOriginalCache, key = app._previewImageCacheKey(app.previews[1]);
  app.closePreviewLightbox();
  assert.equal(viewer.src, '/thumb-2', 'the existing image remains visible during closing');
  assert.equal(app._previewOriginalCache, null);
  images[0].ready.resolve(); await tick();
  assert.equal(viewer.src, '/thumb-2'); assert.equal(cache.get(key), undefined);
  app.previewLightboxOpen = true; app._displayPreviewImage(viewer, app.previews[1]);
  assert.equal(images.length, 2);
  app.resetSampleBrowser();
  assert.equal(viewer.src, ''); assert.equal(app._previewOriginalCache, null);
  images[1].ready.resolve(); await tick(); assert.equal(viewer.src, '');
});
