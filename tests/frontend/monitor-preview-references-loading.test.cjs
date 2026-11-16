const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred} = require('./helpers.cjs');

function sample(number, changes = {}) {
  return {name: `sample-${number}.png`, path: `sample/${number}.png`, version: '1',
    url: `/original-${number}?v=1`, thumb_url: `/thumb-${number}?v=1`, sample: {
      batch_id: `b${number}`, batch_label: `Epoch ${number}`, epoch: number, step: number * 100,
      prompt_id: 'p1', prompt_index: 0, prompt_label: 'fake alias', seed: 42,
    }, ...changes};
}

function fixture(count = 4, width = 300, observer = true) {
  const originals = [], panes = [], observers = [], listeners = new Map();
  const imageSize = {width: 1024, height: 1024};
  const root = {scrollLeft: 0,
    getBoundingClientRect: () => ({left: 0, top: 0, right: width, bottom: 200, width, height: 200}),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
  };
  const container = {children: [], hidden: true, inserts: 0, parentElement: root, closest: () => root,
    get firstElementChild() { return this.children[0] || null; },
    insertBefore(pane, next) {
      const previous = this.children.indexOf(pane);
      if (previous >= 0) this.children.splice(previous, 1);
      this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, pane);
      pane.parentElement = this; pane.image.isConnected = true; this.inserts++;
    },
    replaceChildren() { for (const pane of [...this.children]) pane.remove(); },
  };
  const document = {addEventListener() {},
    getElementById: id => id === 'previewReferencePanes' ? container : null,
    createElement() {
      const image = {isConnected: false, _src: '', writes: [],
        getBoundingClientRect: () => imageSize,
        get src() { return this._src; }, set src(value) { this._src = value; this.writes.push(value); },
        getAttribute(name) { return name === 'src' ? this._src || null : null; },
        removeAttribute(name) { if (name === 'src') this._src = ''; }, dispatchEvent() {},
      };
      const caption = {textContent: ''}, captionStep = {textContent: ''}, retry = {hidden: true};
      const pane = {dataset: {}, image, caption, captionStep, retry, parentElement: null, innerHTML: '',
        querySelector: selector => selector === 'img' ? image : selector.includes('strong') ? caption : selector === '.preview-caption-step' ? captionStep : retry,
        get nextElementSibling() { return container.children[container.children.indexOf(this) + 1] || null; },
        getBoundingClientRect() {
          const left = container.children.indexOf(this) * 100 - root.scrollLeft;
          return {left, right: left + 100, top: 0, bottom: 180, width: 100, height: 180};
        },
        remove() {
          const index = container.children.indexOf(this);
          if (index >= 0) container.children.splice(index, 1);
          this.parentElement = null; image.isConnected = false;
        },
      };
      panes.push(pane); return pane;
    },
  };
  const environment = {window: {innerWidth: 1200, innerHeight: 900, location: {href: 'http://localhost/'},
    addEventListener: (name, listener) => listeners.set('window:' + name, listener),
    removeEventListener: name => listeners.delete('window:' + name),
  }, document, URL,
  Image: class {
    constructor() { this.ready = deferred(); this.naturalWidth = 1024; this.naturalHeight = 1024; originals.push(this); }
    decode() { return this.ready.promise; }
  },
  CustomEvent: class {constructor(type, options) { this.type = type; this.detail = options.detail; }},
  };
  if (observer) environment.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(pane) { this.observed.add(pane); }
    unobserve(pane) { this.observed.delete(pane); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    notify() { this.callback([...this.observed].map(target => ({target, isIntersecting: true}))); }
  };
  const context = loadFrontend(['shared/utils', 'shared/image-loading', 'monitor/previews', 'monitor/artifacts-render'], environment);
  const previews = Array.from({length: count}, (_, index) => sample(index + 1));
  const app = composeMixins(context.window.utilsMixin, context.window.monitorPreviewsMixin, context.window.monitorArtifactsRenderMixin, {
    previews, previewsVersion: 1, previewStep: 0, previewLightboxOpen: true,
    t: key => ({'monitor.sampleEpoch': 'Epoch {n}', 'monitor.sampleStep': 'Step {n}'})[key] || key, constrainPreviewView() {},
    _layoutPreviewComparisonPanes() {if (this._previewReferenceMedia) this._refreshPreviewReferenceVisibility(this._previewReferenceMedia);},
  });
  return {app, previews, container, root, originals, panes, observers, listeners, imageSize, environment};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('reference resolution follows displayed pixels and DPR, with distinct cached tiers', async () => {
  const {app, previews, container, originals, imageSize, environment} = fixture(1);
  previews[0].thumb_url = '/api/image-preview?scope=artifact&run_dir=r&path=one.png&variant=thumb&size=320&v=1';
  imageSize.width = imageSize.height = 180;
  app._updatePreviewReferencePanes(previews);
  assert.equal(originals[0].src, previews[0].thumb_url);
  originals[0].ready.resolve(); await tick();
  environment.window.devicePixelRatio = 2;
  app._refreshPreviewReferenceVisibility(app._previewReferenceMedia);
  assert.match(originals[1].src, /variant=preview/); assert.doesNotMatch(originals[1].src, /size=/);
  originals[1].ready.resolve(); await tick();
  imageSize.width = imageSize.height = 600;
  app._refreshPreviewReferenceVisibility(app._previewReferenceMedia);
  assert.equal(originals[2].src, previews[0].url);
  originals[2].ready.resolve(); await tick();
  imageSize.width = imageSize.height = 120;
  app._refreshPreviewReferenceVisibility(app._previewReferenceMedia);
  assert.equal(container.children[0].image.src, previews[0].thumb_url);
  assert.equal(originals.length, 3, 'returning to a smaller tier reuses only that tier');
});

test('portrait reference tiers tolerate aspect-ratio rounding near resolution boundaries', () => {
  const {app, previews, environment} = fixture(1);
  const thumb = '/api/image-preview?scope=artifact&path=portrait.png&variant=thumb&size=320';
  previews[0].thumb_url = thumb;
  let height = 319;
  const entry = {preview: previews[0], source: '', image: {getBoundingClientRect: () => ({width: height * 2 / 3, height})}};
  entry.source = app._previewReferenceSource(entry);
  assert.equal(entry.source, thumb);
  height = 321; assert.equal(app._previewReferenceSource(entry), thumb);
  height = 360; entry.source = app._previewReferenceSource(entry);
  assert.match(entry.source, /variant=preview/);
  height = 319; assert.equal(app._previewReferenceSource(entry), entry.source);
  height = 959; assert.equal(app._previewReferenceSource(entry), entry.source);
  height = 961; assert.equal(app._previewReferenceSource(entry), entry.source);
  height = 1100; entry.source = app._previewReferenceSource(entry);
  assert.equal(entry.source, previews[0].url);
  height = 959; assert.equal(app._previewReferenceSource(entry), previews[0].url);
  environment.window.devicePixelRatio = 2;
  height = 400; assert.match(app._previewReferenceSource(entry), /variant=preview/);
});

test('current image and references share two decoding slots, and current navigation takes the next slot', async () => {
  const {app, previews, originals} = fixture(4, 600);
  app._updatePreviewReferencePanes(previews.slice(0, 3));
  const viewer = {isConnected: true, src: '', dispatchEvent() {}, removeAttribute() {this.src = '';}};
  app.previewStep = 3; app._displayPreviewImage(viewer, previews[3]);
  assert.equal(originals.length, 2);
  originals[0].ready.resolve(); await tick();
  assert.equal(originals[2].src, previews[3].url, 'current sample precedes queued references');
  originals[1].ready.resolve(); originals[2].ready.resolve(); await tick();
  originals[3].ready.resolve(); await tick();
  assert.equal(viewer.src, previews[3].url);
});

test('visible references load at most two originals concurrently while offscreen panes keep thumbnails', async () => {
  const {app, previews, container, originals, root, observers} = fixture();
  app._updatePreviewReferencePanes(previews);
  assert.equal(container.children.length, 4);
  assert.equal(originals.length, 2);
  assert.equal(container.children[3].image.src, '/thumb-4?v=1');
  originals[0].ready.resolve(); await tick();
  assert.equal(originals.length, 3);
  assert.equal(originals[2].src, '/original-3?v=1');
  originals[1].ready.resolve(); originals[2].ready.resolve(); await tick();
  assert.equal(originals.length, 3, 'the hidden fourth reference never starts an original');
  root.scrollLeft = 300; observers[0].notify();
  assert.equal(container.children[0].image.src, '/thumb-1?v=1', 'offscreen originals release their DOM source');
  assert.equal(originals.length, 4);
  originals[3].ready.resolve(); await tick();
  assert.equal(container.children[3].image.src, '/original-4?v=1');
  root.scrollLeft = 0; observers[0].notify(); await tick();
  assert.equal(container.children[0].image.src, '/original-1?v=1', 'a cached original is reused on return');
  assert.equal(originals.length, 4);
});

test('unchanged references keep their image nodes and originals while their order can change', async () => {
  const {app, previews, container, originals, panes} = fixture(3, 600);
  app._updatePreviewReferencePanes(previews);
  const nodes = [...container.children], inserts = container.inserts;
  app._updatePreviewReferencePanes(previews);
  assert.equal(container.inserts, inserts);
  assert.equal(panes.length, 3);
  originals[0].ready.resolve(); originals[1].ready.resolve(); await tick();
  originals[2].ready.resolve(); await tick();
  app._updatePreviewReferencePanes([previews[2], previews[0], previews[1]]);
  assert.deepEqual(container.children, [nodes[2], nodes[0], nodes[1]]);
  assert.equal(panes.length, 3);
  assert.equal(originals.length, 3);
  assert.equal(nodes[0].image.src, '/original-1?v=1');
  assert.equal(nodes[0].caption.textContent, 'Epoch 1');
  assert.equal(nodes[0].captionStep.textContent, 'Step 100');
  assert.ok(!nodes[0].innerHTML.includes('fake alias'));
  assert.ok(nodes[0].innerHTML.indexOf('preview-view-stage') < nodes[0].innerHTML.indexOf('preview-reference-caption'));
});

test('replacing a reference version cancels its stale write and reuses the pane for the new version', async () => {
  const {app, previews, container, originals} = fixture(2);
  app._updatePreviewReferencePanes(previews);
  const pane = container.children[0];
  const replacement = {...previews[0], version: '2', url: '/original-1?v=2', thumb_url: '/thumb-1?v=2'};
  app._updatePreviewReferencePanes([replacement, previews[1]]);
  assert.equal(container.children[0], pane);
  assert.equal(pane.image.src, '/thumb-1?v=1', 'keep the prior frame until the new version decodes');
  assert.equal(originals.length, 2, 'the replaced in-flight decode still occupies a bounded slot');
  originals[0].ready.resolve(); await tick();
  assert.equal(pane.image.src, '/thumb-1?v=1');
  assert.equal(originals.length, 3);
  assert.equal(originals[2].src, '/original-1?v=2');
  originals[1].ready.resolve(); originals[2].ready.resolve(); await tick();
  assert.equal(pane.image.src, '/original-1?v=2');
});

test('removing and closing references cancels late writes, queued originals and observer work', async () => {
  const {app, previews, container, originals, observers} = fixture(4, 600);
  app._updatePreviewReferencePanes(previews);
  const removed = container.children[1];
  app._updatePreviewReferencePanes([previews[0], previews[2], previews[3]]);
  assert.equal(removed.image.src, '');
  assert.equal(removed.image.isConnected, false);
  app._clearPreviewImageLoading(false);
  assert.equal(container.children.length, 3, 'closing preserves the visible layout during the exit animation');
  assert.equal(app._previewReferenceMedia, null);
  assert.equal(observers[0].disconnected, true);
  originals[0].ready.resolve(); originals[1].ready.resolve(); await tick();
  assert.equal(originals.length, 2, 'no queued original starts after close');
  assert.equal(removed.image.src, '');
  assert.equal(container.children[0].image.src, '/thumb-1?v=1');
  app._clearPreviewReferenceImages();
  assert.equal(container.children.length, 0);
  assert.equal(container.hidden, true);
});

test('reference failures retry independently and fallback listeners are removed on reset', async () => {
  const {app, previews, container, originals, listeners, root} = fixture(2, 300, false);
  app._updatePreviewReferencePanes(previews);
  originals[0].ready.reject(new Error('offline')); originals[1].ready.resolve(); await tick();
  originals[2].ready.resolve(); await tick();
  const failed = container.children[0], ready = container.children[1];
  assert.equal(failed.image.src, '/thumb-1?v=1');
  assert.equal(failed.retry.hidden, false);
  assert.equal(ready.image.src, '/original-2?v=1');
  app.retryPreviewReferenceImage(app._previewItemKey(previews[0]));
  assert.equal(originals.length, 4);
  originals[3].ready.resolve(); await tick();
  assert.equal(failed.retry.hidden, true);
  assert.equal(failed.image.src, '/original-1?v=1');
  assert.equal(ready.image.src, '/original-2?v=1');
  root.scrollLeft = 300; listeners.get('scroll')();
  assert.equal(failed.image.src, '/thumb-1?v=1');
  app._clearPreviewImageLoading(true);
  assert.equal(listeners.size, 0);
  assert.equal(container.children.length, 0);
});

test('a failed reference hides its retry action while returning onscreen queues and reloads it', async () => {
  const {app, previews, container, originals, root, observers} = fixture(4, 200);
  app._updatePreviewReferencePanes(previews);
  originals[0].ready.reject(new Error('offline')); await tick();
  originals[2].ready.resolve(); await tick();
  const entry = app._previewReferenceMedia.entries.get(app._previewItemKey(previews[0]));
  assert.equal(entry.status, 'error'); assert.equal(container.children[0].retry.hidden, false);
  root.scrollLeft = 200; observers[0].notify();
  assert.equal(entry.status, 'idle');
  root.scrollLeft = 0; observers[0].notify();
  assert.equal(entry.status, 'queued', 'both decoding slots remain occupied by prior visible references');
  assert.equal(entry.retry.hidden, true, 'an automatic queued retry must not offer an inactive retry action');
  originals[1].ready.resolve(); await tick();
  assert.equal(entry.status, 'loading'); assert.equal(entry.retry.hidden, true);
  originals[4].ready.resolve(); await tick();
  assert.equal(entry.status, 'ready'); assert.equal(entry.retry.hidden, true);
});
