const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, deferred} = require('./helpers.cjs');

function fixture() {
  const images = [], events = [];
  const context = loadFrontend(['shared/image-loading'], {
    window: {}, document: {addEventListener() {}},
    CustomEvent: class {constructor(type, options) {this.type = type; this.detail = options.detail;}},
    Image: class {
      constructor() {this.ready = deferred(); images.push(this); this.naturalWidth = 1000; this.naturalHeight = 800;}
      decode() {return this.ready.promise;}
    },
  });
  const element = () => ({isConnected:true,src:'',removeAttribute() {this.src = '';}, dispatchEvent(event) {events.push(event);}});
  return {loader:context.window.AnimaImages,images,element,events};
}


test('large images keep their own thumbnail until decoded and ignore stale results', async () => {
  const {loader,images,element,events} = fixture(), img = element();
  const first = loader.display(img,'/a','/thumb-a');
  assert.equal(img.src,'/thumb-a');
  const second = loader.display(img,'/b','/thumb-b');
  images[0].ready.resolve(); assert.equal(await first,false); assert.equal(img.src,'/thumb-b');
  images[1].ready.resolve(); assert.equal(await second,true); assert.equal(img.src,'/b');
  assert.equal(events.length,1); assert.equal(events[0].detail.width,1000);
  assert.equal(await loader.display(img,'/b','/thumb-b'),true);
  assert.equal(img.src,'/b'); assert.equal(images.length,2);
});


test('closing or removing the image prevents a pending request from writing back', async () => {
  const {loader,images,element} = fixture(), img = element();
  const first = loader.display(img,'/a','/thumb');
  loader.cancel(img); img.removeAttribute('src'); images[0].ready.resolve();
  assert.equal(await first,false); assert.equal(img.src,'');
  const second = loader.display(img,'/b','/thumb');
  img.isConnected = false; images[1].ready.resolve(); assert.equal(await second,false);
});

test('an opt-in cache displays a decoded original immediately and distinguishes versions', async () => {
  const {loader,images,element} = fixture(), img = element(), cache = loader.createReadyCache(5);
  const first = loader.display(img, '/a?v=1', '/thumb-a', {cache, key: 'a:1'});
  assert.equal(img.src, '/thumb-a');
  images[0].ready.resolve(); assert.equal(await first, true);
  const second = loader.display(img, '/b', '/thumb-b', {cache, key: 'b:1'});
  assert.equal(img.src, '/thumb-b');
  const back = loader.display(img, '/a?v=1', '/thumb-a', {cache, key: 'a:1'});
  assert.equal(img.src, '/a?v=1', 'a cache hit must not flash the thumbnail');
  assert.equal(await back, true); assert.equal(images.length, 2);
  images[1].ready.resolve(); assert.equal(await second, false); assert.equal(img.src, '/a?v=1');
  const changed = loader.display(img, '/a?v=1', '/thumb-new', {cache, key: 'a:2'});
  assert.equal(img.src, '/thumb-new'); assert.equal(images.length, 3, 'a new version must decode again');
  images[2].ready.resolve(); assert.equal(await changed, true);
  const detached = element(); detached.isConnected = false;
  assert.equal(await loader.display(detached, '/a?v=1', '/thumb-new', {cache, key: 'a:2'}), false);
  assert.equal(detached.src, '', 'a detached image is never populated by a cache hit');
});

test('neighbor prefetch is serial, bounded and replaced on rapid navigation', async () => {
  const {loader,images} = fixture(), cache = loader.createReadyCache(2);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  cache.prefetch([{key:'a', source:'/a'}, {key:'b', source:'/b'}]);
  assert.equal(images.length, 1); assert.equal(images[0].fetchPriority, 'low');
  cache.prefetch([{key:'c', source:'/c'}, {key:'d', source:'/d'}]);
  images[0].ready.resolve(); await tick();
  assert.equal(cache.get('a'), undefined, 'obsolete prefetch must not enter the cache');
  assert.equal(images.length, 2); assert.equal(images[1].src, '/c');
  images[1].ready.resolve(); await tick();
  assert.equal(images.length, 3); assert.equal(images[2].src, '/d');
  images[2].ready.resolve(); await tick();
  assert.ok(cache.get('c')); assert.ok(cache.get('d'));
  cache.put('e', {src:'/e'});
  assert.equal(cache.get('c'), undefined); assert.ok(cache.get('d')); assert.ok(cache.get('e'));
});

test('clearing a cache invalidates in-flight prefetch and a foreground decode', async () => {
  const {loader,images,element} = fixture(), cache = loader.createReadyCache(5), img = element();
  const tick = () => new Promise(resolve => setImmediate(resolve));
  cache.prefetch([{key:'next', source:'/next'}, {key:'later', source:'/later'}]);
  const current = loader.display(img, '/current', '/thumb', {cache, key:'current'});
  cache.clear(); loader.cancel(img); img.removeAttribute('src');
  images[0].ready.resolve(); images[1].ready.resolve();
  assert.equal(await current, false); await tick();
  assert.equal(img.src, ''); assert.equal(cache.get('current'), undefined);
  assert.equal(cache.get('next'), undefined); assert.equal(images.length, 2, 'queued prefetch is discarded');
});

test('decoded cache uses a pixel budget and evicts the least recently used image', () => {
  const {loader} = fixture(), cache = loader.createReadyCache(5, {maxPixels: 1600000});
  const image = (src, width = 1000) => ({src, naturalWidth: width, naturalHeight: 800});
  cache.put('a', image('/a'));
  cache.put('b', image('/b'));
  assert.ok(cache.get('a'));
  cache.put('c', image('/c'));
  assert.equal(cache.get('b'), undefined);
  assert.ok(cache.get('a'));
  assert.ok(cache.get('c'));
  cache.put('a', image('/a-large', 1500));
  assert.equal(cache.get('c'), undefined, 'replacing a key adjusts its pixel cost');
  cache.put('oversized', image('/oversized', 3000));
  assert.equal(cache.get('oversized'), undefined);
  assert.ok(cache.get('a'), 'an oversized image must not flush smaller cached images');
  cache.clear();
  cache.put('b', image('/b'));
  cache.put('c', image('/c'));
  assert.ok(cache.get('b'));
  assert.ok(cache.get('c'), 'clearing also resets the pixel budget');
});

test('an image larger than the cache budget can still be displayed', async () => {
  const {loader, images, element} = fixture(), img = element();
  const cache = loader.createReadyCache(5, {maxPixels: 400000});
  const result = loader.display(img, '/large', '/thumb', {cache, key: 'large'});
  images[0].ready.resolve();
  assert.equal(await result, true);
  assert.equal(img.src, '/large');
  assert.equal(cache.get('large'), undefined);
});
