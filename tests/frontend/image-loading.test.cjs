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
