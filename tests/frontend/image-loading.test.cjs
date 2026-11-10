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

test('concurrent decodes share work; settled images are not retained in a second cache', async () => {
  const {loader,images} = fixture();
  const first = loader.decode('/a'), second = loader.decode('/a');
  assert.equal(first, second); assert.equal(images.length, 1);
  images[0].ready.resolve(); await first;
  const reopened = loader.decode('/a'); assert.equal(images.length, 2);
  images[1].ready.resolve(); await reopened;
});

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

test('failed loads retain the thumbnail and permit a retry', async () => {
  const {loader,images,element} = fixture(), img = element();
  const failed = loader.display(img,'/a','/thumb');
  images[0].ready.reject(new Error('decode')); assert.equal(await failed,false); assert.equal(img.src,'/thumb');
  const retry = loader.display(img,'/a','/thumb');
  images[1].ready.resolve(); assert.equal(await retry,true);
});

test('closing or removing the image prevents a pending request from writing back', async () => {
  const {loader,images,element} = fixture(), img = element();
  const first = loader.display(img,'/a','/thumb');
  loader.cancel(img); img.removeAttribute('src'); images[0].ready.resolve();
  assert.equal(await first,false); assert.equal(img.src,'');
  const second = loader.display(img,'/b','/thumb');
  img.isConnected = false; images[1].ready.resolve(); assert.equal(await second,false);
});

test('Alpine directive tracks source changes and cancels writes on cleanup', async () => {
  let init, directive, rerun, dispose;
  const images = [];
  const context = loadFrontend(['shared/image-loading'], {
    window: {}, document: {addEventListener(name, callback) {init = callback;}},
    Alpine: {directive(name, callback) {assert.equal(name,'image'); directive = callback;}},
    CustomEvent: class {},
    Image: class {constructor() {this.ready = deferred(); images.push(this);} decode() {return this.ready.promise;}},
  });
  init();
  const element = {isConnected:true,removeAttribute() {this.src = '';},dispatchEvent() {}};
  let value = {src:'/a',placeholder:'/thumb-a'};
  directive(element, {expression:'image'}, {
    evaluateLater: () => callback => callback(value),
    effect(callback) {rerun = callback; callback();}, cleanup(callback) {dispose = callback;},
  });
  assert.equal(element.src,'/thumb-a');
  value = {src:'/b',placeholder:'/thumb-b'}; rerun();
  images[0].ready.resolve(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(element.src,'/thumb-b');
  dispose(); images[1].ready.resolve(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(element.src,'/thumb-b');
});
