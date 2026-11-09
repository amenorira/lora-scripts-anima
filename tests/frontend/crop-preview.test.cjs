const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred} = require('./helpers.cjs');

function app() {
  const context = loadFrontend(['training/crop-preview'], {window:{}, AbortController, setTimeout, clearTimeout, document:{querySelector:()=>null, getElementById:()=>null}});
  return composeMixins(context.window.trainingCropPreviewMixin, {
    t: key => key, esc: text => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    $nextTick: async () => {},
  });
}
const sample = {id:'0',name:'a"<.png',sample_count:5,original:[300,200],bucket:[128,128],resized:[192,128],crop:[32/192,0,128/192,1],crop_percent:100/3,scale:.64,thumb:'/thumb',preview:'/preview'};

test('bucket statistics aggregate repeats independently of image filters', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',sample_count:2}, {...sample,id:'2',sample_count:10,bucket:[256,256],is_reg:true}, {id:'3',error:'broken',sample_count:50}];
  assert.deepEqual(Array.from(a.cropPreviewBuckets, b => [b.key,b.count,b.samples]), [['256 × 256',1,10],['128 × 128',2,7]]);
  a.cropPreviewBucket = '128 × 128'; a.cropPreviewFilter = 'upscaled';
  assert.equal(a.cropPreviewVisible.length, 0);
  assert.equal(a.cropPreviewBuckets.reduce((sum,b)=>sum+b.samples,0), 17);
  a.t = key => key === 'cropPreview.summary' ? '{images}/{samples}/{buckets}' : key;
  assert.equal(a.cropPreviewSummary(), '3/17/2');
  assert.ok(a.cropPreviewStatsNote().includes('cropPreview.includesReg'));
  assert.ok(a.cropPreviewStatsNote().includes('cropPreview.statsErrors'));
  a.cropPreviewItems = [sample];
  assert.equal(a.cropPreviewSummary(), '1/5/1');
  assert.equal(a.cropPreviewStatsNote(), '');
});

test('crop filter and bucket filter compose without losing error entries', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',crop_percent:0,scale:2,bucket:[256,256]}, {id:'2',error:'broken'}];
  assert.equal(a.cropPreviewVisible.length, 3);
  a.cropPreviewFilter = 'upscaled';
  assert.equal(a.cropPreviewVisible[0].id, '1');
  a.cropPreviewBucket = '128 × 128';
  assert.equal(a.cropPreviewVisible.length, 0);
  a.cropPreviewBucket = ''; a.cropPreviewFilter = 'errors';
  assert.equal(a.cropPreviewVisible[0].id, '2');
});

test('bucket chips preserve image filters and keep the selected bucket visible when collapsed', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',sample_count:2,bucket:[256,256]}, {...sample,id:'2',sample_count:1,bucket:[512,512]}];
  a.cropPreviewBucketLimit = 2;
  a.cropPreviewFilter = 'cropped';
  a.selectCropPreviewBucket('512 × 512');
  assert.equal(a.cropPreviewFilter, 'cropped');
  assert.deepEqual(Array.from(a.cropPreviewBucketChips, b=>b.key), ['128 × 128','512 × 512']);
  a.cropPreviewBucketsExpanded = true;
  assert.equal(a.cropPreviewBucketChips.length, 3);
  a.cropPreviewBucketsExpanded = false;
  a.selectCropPreviewBucket('512 × 512');
  assert.equal(a.cropPreviewBucket, '');
  assert.equal(a.cropPreviewFilter, 'cropped');
  a.cropPreviewFilter = 'errors';
  a.selectCropPreviewBucket('256 × 256');
  assert.equal(a.cropPreviewFilter, 'all');
  a.selectCropPreviewBucket('');
  assert.equal(a.cropPreviewVisible.length, 3);
});

test('random crop preserves size and stays inside resized image', () => {
  const a = app(); a.cropPreviewItems = [sample];
  for (let n = 0; n < 40; n++) {
    a.shuffleCropPreview();
    const [x,y,w,h] = a.cropPreviewItems[0].crop;
    assert.ok(x >= 0 && y >= 0 && x+w <= 1.000001 && y+h <= 1.000001);
    assert.equal(w, sample.crop[2]); assert.equal(h, sample.crop[3]);
    assert.equal(Math.round(x * 192), x * 192);
  }
});

test('thumbnail marks discarded strips and escapes filenames', () => {
  const a = app();
  const html = a.cropPreviewImageHtml(sample);
  assert.equal((html.match(/class="cp-hatch"/g) || []).length, 2);
  assert.ok(html.includes('a&quot;&lt;.png'));
  assert.ok(html.includes('loading="lazy"'));
  const focused = a.cropPreviewImageHtml(sample, true);
  assert.equal((focused.match(/class="cp-hatch"/g) || []).length, 2);
  assert.ok(!focused.includes('cp-crop-boundary'));
  assert.ok(focused.includes('/preview'));
  assert.ok(focused.includes('src="/thumb"'));
  assert.ok(focused.includes('data-preview-src="/preview"'));
});

test('folder groups follow combined filters and exclude empty groups', () => {
  const a = app();
  a.cropPreviewItems = [
    {...sample, name:'1_doll/a.png'},
    {...sample, id:'1', name:'3_person/b.png', crop_percent:0},
    {...sample, id:'2', name:'3_person/c.png'},
  ];
  assert.deepEqual(Array.from(a.cropPreviewFolders, f=>[f.name,f.items.length]), [['1_doll',1],['3_person',2]]);
  a.setCropPreviewFilter('cropped');
  assert.deepEqual(Array.from(a.cropPreviewFolders, f=>f.items.length), [1,1]);
  a.selectCropPreviewBucket('256 × 256');
  assert.equal(a.cropPreviewFolders.length, 0);
  a.setCropPreviewFilter('errors');
  assert.equal(a.cropPreviewBucket, '');
});

test('entry limits rendered cards without changing their order or folder counts', () => {
  const a = app();
  a.cropPreviewItems = [
    {...sample, name:'a/one.png'},
    {...sample, id:'1', name:'b/two.png'},
    {...sample, id:'2', name:'a/three.png'},
  ];
  const groups = () => Array.from(a.cropPreviewFolders, f => [f.name, f.count, Array.from(f.items, item => item.id)]);
  a.cropPreviewRenderLimit = 1;
  assert.deepEqual(groups(), [['a', 2, ['0']]]);
  a.cropPreviewRenderLimit = null;
  assert.deepEqual(groups(), [['a', 2, ['0', '2']], ['b', 1, ['1']]]);
});

test('focus navigation follows visible images across folders and stops at the ends', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',name:'folder/b.png'}, {id:'2',error:'broken'}];
  a.cropPreviewFocus = sample;
  assert.equal(a.cropPreviewAdjacent(-1), null);
  assert.equal(a.cropPreviewAdjacent(1).id, '1');
  a.cropPreviewFocus = a.cropPreviewItems[1];
  assert.equal(a.cropPreviewAdjacent(1), null);
});

test('two navigation steps while decoding advance twice without showing a stale frame', async () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample, id:'1'}, {...sample, id:'2'}];
  a.cropPreviewFocusOpen = true;
  a.cropPreviewFocus = sample;
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

test('closing crop previews retains their content until the dialog exit finishes', async () => {
  const a = app();
  a.prepareCropPreviewFrame = async () => ({});
  a.cropPreviewOpen = true;
  a.cropPreviewLoading = true;
  await a.focusCropPreview(sample);
  assert.equal(a.cropPreviewFocusOpen, true);
  a.unfocusCropPreview();
  assert.equal(a.cropPreviewFocusOpen, false);
  assert.equal(a.cropPreviewFocus, sample);
  a.closeCropPreview();
  assert.equal(a.cropPreviewOpen, false);
  assert.equal(a.cropPreviewLoading, true);
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
