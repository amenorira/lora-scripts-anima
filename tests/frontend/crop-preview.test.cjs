const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response} = require('./helpers.cjs');

function app(fetch) {
  const document = {addEventListener() {}, querySelector: () => null, getElementById: () => null};
  const grid = {
    async reveal(id) { return document.getElementById(`crop-image-${id}`); },
    returnTo() {},
  };
  const context = loadFrontend(['training/preflight', 'training/crop-preview-grid', 'training/crop-preview'], {
    window: {AnimaUI: {setDialogOrigin() {}, settleDialog() {}}},
    AbortController, setTimeout, clearTimeout, document, fetch,
  });
  context.getCropPreviewGrid = () => grid;
  return composeMixins(context.window.trainingPreflight, context.window.trainingCropPreviewMixin, {
    document, grid, buildCropGridLayout: context.buildCropGridLayout, cropGridRowAt: context.cropGridRowAt,
    t: key => key, esc: text => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    $nextTick: async () => {},
  });
}
const sample = {id:'0',name:'a"<.png',sample_count:5,original:[300,200],bucket:[128,128],resized:[192,128],crop:[32/192,0,128/192,1],crop_percent:100/3,scale:.64,thumb:'/thumb',preview:'/preview'};


test('two navigation steps while decoding advance twice without showing a stale frame', async () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample, id:'1'}, {...sample, id:'2'}];
  a.cropPreviewFocusOpen = true;
  a.cropPreviewFocus = sample;
  a.document.getElementById = id => id === 'crop-image-2' ? {querySelector: () => null} : null;
  const pending = [];
  a.prepareCropPreviewFrame = item => {
    const ready = deferred();
    pending.push({item, ready});
    return ready.promise;
  };
  const first = a.stepCropPreview(1);
  const second = a.stepCropPreview(1);
  assert.deepEqual(pending.map(({item}) => item.id), ['1', '2']);
  pending[1].ready.resolve();
  await second;
  pending[0].ready.resolve();
  await first;
  assert.equal(a.cropPreviewFocus.id, '2');
});


test('a late thumbnail decode cannot open the detail after the crop window closes', async () => {
  let decoded;
  const ready = new Promise(resolve => { decoded = resolve; });
  const a = app();
  a.prepareCropPreviewFrame = () => ready;
  a.cropPreviewOpen = true;
  const opening = a.focusCropPreview(sample);
  await Promise.resolve();
  assert.equal(a.cropPreviewFocusOpen, false);
  a.closeCropPreview();
  decoded();
  await opening;
  assert.equal(a.cropPreviewFocusOpen, false);
});
