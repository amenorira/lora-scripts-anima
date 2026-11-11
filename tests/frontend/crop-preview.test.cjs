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

test('bucket statistics aggregate repeats independently of image filters', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',sample_count:2}, {...sample,id:'2',sample_count:10,bucket:[256,256],is_reg:true}, {id:'3',name:'broken.png',error:'broken',sample_count:50}];
  assert.deepEqual(Array.from(a.cropPreviewBuckets, b => [b.key,b.count,b.samples]), [['128 × 128',2,7],['256 × 256',1,10]]);
  a.cropPreviewBucket = '128 × 128'; a.cropPreviewFilter = 'upscaled';
  assert.equal(a.cropPreviewView.items.length, 0);
  assert.equal(a.cropPreviewBuckets.reduce((sum,b)=>sum+b.samples,0), 17);
  assert.equal(a.cropPreviewTotals.count, 3);
  assert.ok(a.cropPreviewStatsNote().includes('cropPreview.includesReg'));
  assert.ok(a.cropPreviewStatsNote().includes('cropPreview.statsErrors'));
  a.cropPreviewItems = [sample];
  assert.equal(a.cropPreviewTotals.count, 1);
  assert.equal(a.cropPreviewTotals.samples, 5);
  assert.equal(a.cropPreviewStatsNote(), '');
});

test('bucket order matches core logs by numeric width then height, independently of repeats', () => {
  const a = app();
  a.cropPreviewItems = [
    {...sample, id:'0', bucket:[1024,512], sample_count:999},
    {...sample, id:'1', bucket:[768,1024], sample_count:99},
    {...sample, id:'2', bucket:[640,1280], sample_count:1},
    {...sample, id:'3', bucket:[768,768], sample_count:2},
  ];
  assert.deepEqual(Array.from(a.cropPreviewBuckets, b => b.key),
    ['640 × 1280', '768 × 768', '768 × 1024', '1024 × 512']);
});

test('crop filter and bucket filter compose without losing error entries', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',crop_percent:0,scale:2,bucket:[256,256]}, {id:'2',name:'broken.png',error:'broken'}];
  assert.equal(a.cropPreviewView.items.length, 3);
  a.cropPreviewFilter = 'upscaled';
  assert.equal(a.cropPreviewView.items[0].id, '1');
  a.cropPreviewBucket = '128 × 128';
  assert.equal(a.cropPreviewView.items.length, 0);
  a.cropPreviewBucket = ''; a.cropPreviewFilter = 'errors';
  assert.equal(a.cropPreviewView.items[0].id, '2');
});

test('regularization filter follows the preview configuration even when there are no regularization images', async () => {
  const a = app(async () => response({items: [sample], random_crop: false}));
  a.form = {enable_reg_data: true, reg_data_dir: 'regularization'};
  await a.openCropPreview();
  assert.equal(a.cropPreviewError, '');
  assert.equal(a.cropPreviewRegConfigured, true);
  a.setCropPreviewSource('only');
  assert.equal(a.cropPreviewView.items.length, 0);

  a.form.enable_reg_data = false;
  await a.openCropPreview();
  assert.equal(a.cropPreviewRegConfigured, false);
  assert.equal(a.cropPreviewSource, 'include');

  a.form.enable_reg_data = true;
  a.form.reg_data_dir = ' ';
  await a.openCropPreview();
  assert.equal(a.cropPreviewRegConfigured, false);

  a.form.reg_data_dir = 'regularization';
  a.form.model_train_type = 'krea2-lora';
  await a.openCropPreview();
  assert.equal(a.cropPreviewRegConfigured, false);
});

test('crop preview sends the active cache flags for fixed-size training', async () => {
  const a = app(async (url, request) => {
    assert.equal(url, '/api/training/crop-preview');
    assert.deepEqual(JSON.parse(request.body), {
      train_data_dir: 'training', enable_bucket: false, random_crop: false,
      cache_latents: false, cache_latents_to_disk: true,
    });
    return response({ items: [sample], random_crop: false });
  });
  a.form = { train_data_dir: 'training', enable_bucket: false, random_crop: false,
    cache_latents: false, cache_latents_to_disk: true, max_train_epochs: 10 };
  await a.openCropPreview();
  assert.equal(a.cropPreviewError, '');
  assert.equal(a.cropPreviewItems.length, 1);
});

test('regularization scope composes with crop and bucket filters and scopes the totals', () => {
  const a = app();
  a.cropPreviewItems = [
    sample,
    {...sample, id:'1', is_reg:true, bucket:[256,256], sample_count:10},
    {...sample, id:'2', is_reg:true, crop_percent:0, sample_count:2},
    {id:'3', name:'reg/broken.png', error:'broken', is_reg:true},
  ];
  assert.equal(a.cropPreviewView.items.length, 4);
  a.selectCropPreviewBucket('256 × 256');
  a.setCropPreviewFilter('cropped');
  a.setCropPreviewSource('only');
  assert.equal(a.cropPreviewBucket, '256 × 256');
  assert.deepEqual(Array.from(a.cropPreviewView.items, item => item.id), ['1']);
  assert.equal(a.cropPreviewTotals.samples, 12);
  a.setCropPreviewSource('exclude');
  assert.equal(a.cropPreviewBucket, '');
  assert.equal(a.cropPreviewFilter, 'cropped');
  assert.deepEqual(Array.from(a.cropPreviewView.items, item => item.id), ['0']);
  assert.equal(a.cropPreviewTotals.samples, 5);
  assert.equal(a.cropPreviewStatsNote(), '');
  a.setCropPreviewFilter('errors');
  a.setCropPreviewSource('only');
  assert.deepEqual(Array.from(a.cropPreviewView.items, item => item.id), ['3']);
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
  assert.equal(a.cropPreviewView.items.length, 3);
});

test('bucket rows follow height-only resizes on the next frame and cancel work when closed', async () => {
  const content = {};
  const buckets = { closest: () => content };
  const frames = new Map();
  const observed = [];
  let observer, disconnected = false, frameId = 0, rows = 2;
  const context = loadFrontend(['training/crop-preview'], {
    window: {}, AbortController, setTimeout, clearTimeout,
    document: { querySelector: () => buckets, getElementById: () => null },
    fetch: async () => response({ items: [], random_crop: false }),
    ResizeObserver: class {
      constructor(callback) { observer = callback; }
      observe(target) { observed.push(target); }
      disconnect() { disconnected = true; }
    },
    getComputedStyle: () => ({ gridTemplateColumns: '240px 240px 240px', getPropertyValue: () => String(rows) }),
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const a = composeMixins(context.window.trainingCropPreviewMixin, {
    form: {}, _trainingDatasetPayload: () => ({}), $nextTick: async () => {},
  });
  await a.openCropPreview();
  assert.deepEqual(observed, [buckets, content]);
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback());
  };
  observer(); observer();
  assert.equal(frames.size, 1);
  assert.equal(a.cropPreviewBucketLimit, 9);
  flushFrame();
  assert.equal(a.cropPreviewBucketLimit, 5);
  rows = 1;
  observer(); flushFrame();
  assert.equal(a.cropPreviewBucketLimit, 2);
  observer();
  a.closeCropPreview();
  assert.equal(disconnected, true);
  assert.equal(frames.size, 0);
  assert.equal(a._cropBucketFrame, null);
});

test('random crop preserves size and stays inside resized image', () => {
  const a = app(); a.cropPreviewItems = [{...sample}];
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
  assert.deepEqual(Array.from(a.cropPreviewView.folders, f=>[f.name,f.count]), [['1_doll',1],['3_person',2]]);
  a.setCropPreviewFilter('cropped');
  assert.deepEqual(Array.from(a.cropPreviewView.folders, f=>f.count), [1,1]);
  a.selectCropPreviewBucket('256 × 256');
  assert.equal(a.cropPreviewView.folders.length, 0);
  a.setCropPreviewFilter('errors');
  assert.equal(a.cropPreviewBucket, '');
});

test('virtual rows follow folder boundaries and map every item at the current column count', () => {
  const a = app();
  a.cropPreviewItems = [
    {...sample, name:'a.png'},
    {...sample, id:'1', name:'nested/b.png'},
    {...sample, id:'2', name:'z.png'},
    {...sample, id:'3', name:'q.png'},
    {id:'4', name:'nested/broken.png', error:'broken'},
  ];
  const gaps = { row: 16, folder: 24, heading: 12 };
  const {rows, byImage} = a.buildCropGridLayout(a.cropPreviewView, 2, gaps);
  assert.deepEqual(Array.from(rows, row => [row.gap, Array.from(row.items, item => item.id)]),
    [[0, []], [12, ['0', '2']], [16, ['3']], [24, []], [12, ['1', '4']]]);
  assert.equal(byImage.get('3'), rows[2]);
  assert.equal(byImage.get('4'), rows[4]);
  let bottom = 0;
  for (const row of rows) {
    row.top = bottom + row.gap;
    bottom = row.top + row.height;
  }
  assert.equal(a.cropGridRowAt(rows, rows[2].top - 1), 2);
  assert.equal(a.cropGridRowAt(rows, bottom + 10), 4);
  const wider = a.buildCropGridLayout(a.cropPreviewView, 3, gaps);
  assert.equal(wider.byImage.get('3'), wider.byImage.get('0'));
});

test('focus navigation follows visible images across folders and stops at the ends', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',name:'folder/b.png'}, {id:'2',name:'broken.png',error:'broken'}, {...sample,id:'3',name:'z.png'}];
  a.cropPreviewFocus = sample;
  assert.equal(a.cropPreviewAdjacent(-1), null);
  assert.equal(a.cropPreviewAdjacent(1).id, '3');
  a.cropPreviewFocus = a.cropPreviewItems[1];
  assert.equal(a.cropPreviewAdjacent(-1).id, '3');
  assert.equal(a.cropPreviewAdjacent(1), null);
});

test('detail navigation reveals an unmounted thumbnail before scrolling to its morph anchor', async () => {
  const a = app();
  a.cropPreviewItems = Array.from({length: 26}, (_, id) => ({...sample, id: String(id)}));
  a.cropPreviewFocusOpen = true;
  a.cropPreviewFocus = a.cropPreviewItems[11];
  a.prepareCropPreviewFrame = async () => ({});
  let revealed, mounted = false;
  a.grid.reveal = async id => {
    revealed = id;
    await Promise.resolve();
    mounted = true;
    return a.document.getElementById(`crop-image-${id}`);
  };
  let scrolled = false;
  a.document.getElementById = id => {
    if (id !== 'crop-image-12') return null;
    assert.equal(revealed, '12');
    assert.equal(mounted, true);
    return {querySelector: () => ({scrollIntoView() { scrolled = true; }})};
  };
  await a.stepCropPreview(1);
  assert.equal(a.cropPreviewFocus.id, '12');
  assert.equal(scrolled, true);
});

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

test('closing crop previews retains their content until the dialog exit finishes', async () => {
  const a = app();
  a.prepareCropPreviewFrame = async () => ({});
  a.document.getElementById = id => id === 'crop-image-0' ? {} : null;
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
