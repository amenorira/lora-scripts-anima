const test = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins, deferred} = require('./helpers.cjs');

loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

function image(source = '/old-thumb') {
  const handlers = new Map();
  return {dataset: {}, style: {}, isConnected: true, complete: true, naturalWidth: 90, _src: source,
    get src() { return this._src; }, set src(value) { this._src = value; },
    get currentSrc() { return this._src; },
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return name === 'src' ? this._src || null : this[name] || null; },
    removeAttribute(name) { if (name === 'src') this._src = ''; },
    addEventListener(name, callback) { handlers.set(name, callback); },
    emit(name) { handlers.get(name)?.(); },
    decode() { return Promise.resolve(); },
    closest() { return this.parentElement; },
    remove() { this.isConnected = false; this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); },
  };
}

function fixture() {
  const preloads = [];
  const classes = new Set();
  const frame = {children: [], dataset: {previewPath: 'old.png'}, classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value)},
    appendChild(value) { value.parentElement = this; this.children.push(value); },
  };
  const current = image(); frame.appendChild(current);
  const timeline = {dataset: {signature: 'old'}, querySelectorAll: () => classes.has('is-error') ? frame.children : []};
  global.document = {
    getElementById: id => id === 'previewLightboxTimeline' ? timeline : null,
    createElement() { const next = image(''); preloads.push(next); return next; },
  };
  const app = composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    weakNetworkMode: false, _previewItemKey: preview => preview.path,
  });
  const preview = {name: 'new.png', path: 'new.png', version: '2', thumb_url: '/new-thumb?v=2'};
  return {app, current, frame, preloads, timeline, preview};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a changed timeline thumbnail stays visible until its replacement has loaded and decoded lazily', async () => {
  const {app, current, preloads, preview} = fixture();
  app._updatePreviewTimelineImage(current, preview);
  const preload = preloads[0], ready = deferred(); preload.decode = () => ready.promise;
  assert.equal(preload.loading, 'lazy');
  assert.equal(preload.fetchPriority, 'low');
  assert.equal(current.src, '/old-thumb');
  preload.emit('load'); await tick();
  assert.equal(current.src, '/old-thumb', 'load alone does not replace the decoded frame');
  ready.resolve(); await tick();
  assert.equal(current.src, '/new-thumb?v=2');
  assert.equal(preload.isConnected, false);
  app._updatePreviewTimelineImage(current, preview);
  assert.equal(preloads.length, 1, 'an unchanged target does not create another request');
});

test('weak timeline replacements remain in the existing serial queue and keep the old blob until commit', async () => {
  const {app, current, preloads, preview} = fixture();
  app.weakNetworkMode = true;
  current.src = 'blob:old'; current.dataset.previewUrl = '/old-thumb'; current.dataset.previewLoaded = '1';
  app._updatePreviewTimelineImage(current, preview);
  const preload = preloads[0];
  assert.equal(preload.src, '');
  assert.equal(preload.dataset.previewUrl, '/new-thumb?v=2');
  assert.equal(current.src, 'blob:old');
  assert.equal(current.dataset.previewUrl, '/old-thumb', 'the object URL owner can still retain the visible old blob');
  preload.src = 'blob:new'; preload.emit('load'); await tick();
  assert.equal(current.src, 'blob:new');
  assert.equal(current.dataset.previewUrl, '/new-thumb?v=2');
  assert.equal(current.dataset.previewLoaded, '1');
  assert.equal(preload.isConnected, false);
});

test('rapid thumbnail changes and closing invalidate obsolete lazy preloaders', async () => {
  const {app, current, preloads, preview, timeline} = fixture();
  app._updatePreviewTimelineImage(current, preview);
  const old = preloads[0], ready = deferred(); old.decode = () => ready.promise;
  old.emit('load');
  app._updatePreviewTimelineImage(current, {...preview, version: '3', thumb_url: '/new-thumb?v=3'});
  assert.equal(old.isConnected, false);
  ready.resolve(); await tick();
  assert.equal(current.src, '/old-thumb');
  const latest = preloads[1]; latest.emit('load'); await tick();
  assert.equal(current.src, '/new-thumb?v=3');
  app._updatePreviewTimelineImage(current, {...preview, version: '4', thumb_url: '/new-thumb?v=4'});
  app._clearPreviewTimelineImageSwaps();
  preloads[2].emit('load'); await tick();
  assert.equal(current.src, '/new-thumb?v=3');
  assert.equal(app._previewTimelineImageSwaps, null);
  assert.equal(timeline.dataset.signature, undefined);
});

test('failed timeline swaps mark the stale image and a refresh retries network and decode failures', async () => {
  for (const failure of ['network', 'decode']) {
    const {app, current, preloads, preview, timeline, frame} = fixture();
    app._updatePreviewTimelineImage(current, preview);
    const preload = preloads[0];
    if (failure === 'decode') preload.decode = () => Promise.reject(new Error('invalid image'));
    preload.emit(failure === 'network' ? 'error' : 'load');
    await tick();
    assert.equal(frame.classList.contains('is-error'), true, 'the previous prompt image is never presented as a successful replacement');
    assert.equal(current.dataset.previewTimelineSource, undefined);
    assert.equal(preload.isConnected, false);
    app._clearPreviewTimelineImageSwaps();
    assert.equal(timeline.dataset.signature, undefined);
    app._updatePreviewTimelineImage(current, preview);
    assert.equal(preloads.length, 2, failure + ' must be retryable for the same target URL');
    preloads[1].emit('load'); await tick();
    assert.equal(current.src, preview.thumb_url);
    assert.equal(frame.classList.contains('is-error'), false);
  }
});

test('refresh retries a failed initial timeline source even when its URL is unchanged', () => {
  const {app, current, preview, frame} = fixture();
  current.src = preview.thumb_url; current.naturalWidth = 0;
  current.dataset.previewTimelineSource = 'failed'; frame.classList.add('is-error');
  let writes = 0;
  Object.defineProperty(current, 'src', {get: () => preview.thumb_url, set: () => {writes++;}});
  app._clearPreviewTimelineImageSwaps();
  app._updatePreviewTimelineImage(current, preview);
  assert.equal(writes, 1);
});

test('weak timeline failures evict only the failed replacement and defer blob revocation to media cleanup', async () => {
  const revoke = URL.revokeObjectURL, revoked = [];
  URL.revokeObjectURL = source => revoked.push(source);
  try {
    for (const failure of ['network', 'decode']) {
      const {app, current, preview, frame, preloads} = fixture();
      app.weakNetworkMode = true;
      current.src = 'blob:old'; current.dataset.previewUrl = '/old-thumb?v=1'; current.dataset.previewLoaded = '1';
      app._previewMediaObjectUrls = ['blob:old', 'blob:failed'];
      app._previewMediaByUrl = new Map([['/old-thumb?v=1', 'blob:old'], [preview.thumb_url, 'blob:failed']]);
      app._updatePreviewTimelineImage(current, preview);
      const preload = preloads[0]; preload.src = 'blob:failed';
      if (failure === 'decode') preload.decode = () => Promise.reject(new Error('invalid bytes'));
      preload.emit(failure === 'network' ? 'error' : 'load'); await tick();
      assert.equal(app._previewMediaByUrl.has(preview.thumb_url), false, 'the retry must fetch the target again');
      assert.equal(app._previewMediaByUrl.get('/old-thumb?v=1'), 'blob:old');
      assert.deepEqual(app._previewMediaObjectUrls, ['blob:old', 'blob:failed'], 'the failure handler does not revoke shared sources');
      app._restorePreviewMedia({querySelectorAll: () => frame.children}, new Map());
      assert.deepEqual(app._previewMediaObjectUrls, ['blob:old']);
      assert.equal(revoked.at(-1), 'blob:failed');
      app._updatePreviewTimelineImage(current, preview);
      assert.equal(preloads[1].dataset.previewUrl, preview.thumb_url);
      assert.equal(preloads[1].src, '', 'the existing serial queue supplies a fresh source');
    }
  } finally {URL.revokeObjectURL = revoke;}
});

test('capturing weak media forgets an initial failed blob without evicting a decoded old image in an error frame', () => {
  const {app, current, frame} = fixture();
  current.src = 'blob:old'; current.dataset.previewUrl = '/old-thumb?v=1'; current.dataset.previewLoaded = '1';
  frame.classList.add('is-error');
  app._previewMediaObjectUrls = ['blob:old'];
  app._previewMediaByUrl = new Map([['/old-thumb?v=1', 'blob:old']]);
  const root = {querySelectorAll: () => frame.children};
  app._capturePreviewMedia(root);
  assert.equal(app._previewMediaByUrl.get('/old-thumb?v=1'), 'blob:old');
  current.naturalWidth = 0;
  app._capturePreviewMedia(root);
  assert.equal(app._previewMediaByUrl.has('/old-thumb?v=1'), false);
  assert.deepEqual(app._previewMediaObjectUrls, ['blob:old']);
});

function reconcileFixture(previews, oldIndices) {
  const app = composeMixins(window.utilsMixin, window.monitorArtifactsRenderMixin, {
    t: key => ({'monitor.sampleEpoch': 'Epoch {n}', 'monitor.sampleStep': 'Step {n}'})[key] || key,
    previews, _previewItemKey: preview => preview.path, _sampleRecord: preview => preview.sample,
    _sampleDataModel: () => ({byBatch: new Map(previews.map(preview => [preview.sample.batch_id, {label: preview.sample.batch_label}]))}),
    _previewCompareLabel: preview => preview.path, _previewViewTimelineHtml: indices => String(indices[0]),
    _updatePreviewTimelineImage(image, preview) { image.target = preview.path; },
  });
  const timeline = {children: [],
    get firstElementChild() { return this.children[0] || null; },
    querySelectorAll() { return [...this.children]; },
    insertBefore(item, next) {
      const previous = this.children.indexOf(item);
      if (previous >= 0) this.children.splice(previous, 1);
      this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, item);
    },
  };
  const createItem = index => {
    const preview = previews[index], img = image(), label = {innerHTML: ''};
    return {dataset: {previewPath: preview.path, previewBatchId: preview.sample.batch_id},
      querySelector: selector => selector === 'img' ? img : label, setAttribute() {},
      get nextElementSibling() { return timeline.children[timeline.children.indexOf(this) + 1] || null; },
      remove() { timeline.children.splice(timeline.children.indexOf(this), 1); },
    };
  };
  timeline.children = oldIndices.map(createItem);
  global.document = {createElement() {
    return {innerHTML: '', get content() { return {firstElementChild: createItem(Number(this.innerHTML))}; }};
  }};
  return {app, timeline};
}

test('timeline reuses unique batch buttons across prompts and preserves real file identity for duplicate batches', () => {
  const sample = (batch, prompt) => ({path: `${batch}-${prompt}`, sample: {batch_id: `b${batch}`, batch_label: `Epoch ${batch}`}});
  const previews = [sample(1, 1), sample(1, 2), sample(2, 1), sample(2, 2)];
  const {app, timeline} = reconcileFixture(previews, [0, 2]);
  const nodes = [...timeline.children], images = nodes.map(node => node.querySelector('img'));
  app._reconcilePreviewViewTimeline(timeline, [1, 3]);
  assert.deepEqual(timeline.children, nodes);
  assert.equal(timeline.children[0].querySelector('img'), images[0]);
  assert.equal(timeline.children[0].dataset.previewPath, '1-2');
  assert.equal(images[0].target, '1-2');
  app._reconcilePreviewViewTimeline(timeline, [0, 1, 3]);
  assert.equal(timeline.children[1], nodes[0], 'the exact duplicate-group file remains its own item');
  assert.notEqual(timeline.children[0], nodes[0], 'a second file in a batch receives a separate node');
  app._reconcilePreviewViewTimeline(timeline, [3, 1]);
  assert.deepEqual(timeline.children.map(node => node.dataset.previewPath), ['2-2', '1-2']);
});
