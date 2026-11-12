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

test('filter counts match the available results across buckets and regularization scopes', () => {
  const a = app();
  a.cropPreviewItems = [
    sample,
    {...sample, id:'1', crop_percent:0, scale:1.001},
    {...sample, id:'2', is_reg:true, bucket:[256,256], scale:1.002},
    {...sample, id:'3', is_reg:true, crop_percent:0, scale:1.25},
    {id:'4', name:'broken.png', error:'broken', crop_percent:10, scale:2},
    {id:'5', name:'reg/broken.png', error:'broken', is_reg:true},
  ];
  const counts = () => Array.from(a.cropPreviewFilterOptions(), option => [option.value, option.count]);
  assert.deepEqual(counts(), [['all', 6], ['cropped', 2], ['upscaled', 2], ['errors', 2]]);
  a.setCropPreviewFilter('upscaled');
  assert.deepEqual(counts(), [['all', 6], ['cropped', 2], ['upscaled', 2], ['errors', 2]]);

  a.cropPreviewBucket = '128 × 128';
  assert.deepEqual(counts(), [['all', 3], ['cropped', 1], ['upscaled', 1], ['errors', 2]]);
  for (const [value, count] of counts()) {
    a.cropPreviewBucket = '128 × 128';
    a.setCropPreviewFilter(value);
    assert.equal(a.cropPreviewView.items.length, count, value);
  }
  assert.equal(a.cropPreviewBucket, '');

  a.setCropPreviewSource('only');
  assert.deepEqual(counts(), [['all', 3], ['cropped', 1], ['upscaled', 2], ['errors', 1]]);
  a.cropPreviewBucket = '256 × 256';
  assert.deepEqual(counts(), [['all', 1], ['cropped', 1], ['upscaled', 1], ['errors', 1]]);
  a.setCropPreviewSource('exclude');
  assert.equal(a.cropPreviewBucket, '');
  assert.deepEqual(counts(), [['all', 3], ['cropped', 1], ['upscaled', 0], ['errors', 1]]);

  a.cropPreviewItems = [];
  assert.deepEqual(counts(), [['all', 0], ['cropped', 0], ['upscaled', 0], ['errors', 0]]);
  a.cropPreviewLoading = true;
  assert.ok(counts().every(([, count]) => count === null));
  a.cropPreviewLoading = false;
  a.cropPreviewError = 'failed';
  assert.ok(counts().every(([, count]) => count === null));
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

test('bucket selection preserves image filters and keeps every bucket available in both states', () => {
  const a = app();
  a.cropPreviewItems = [sample, {...sample,id:'1',sample_count:2,bucket:[256,256]}, {...sample,id:'2',sample_count:1,bucket:[512,512]}];
  a.cropPreviewFilter = 'cropped';
  a.selectCropPreviewBucket('512 × 512');
  assert.equal(a.cropPreviewFilter, 'cropped');
  assert.deepEqual(Array.from(a.cropPreviewBuckets, b=>b.key), ['128 × 128','256 × 256','512 × 512']);
  a.cropPreviewBucketsExpanded = true;
  assert.equal(a.cropPreviewBuckets.length, 3);
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

test('bucket resizes update row limits after layout and preserve selection without interrupting motion', async () => {
  const canvas = {};
  const content = { querySelector: () => canvas };
  const panel = {};
  const buckets = { closest: selector => selector === '.cp-content' ? content : panel };
  const frames = new Map();
  const observed = [];
  const corrections = [];
  const updates = [];
  let observer, disconnected = false, frameId = 0;
  const context = loadFrontend(['training/crop-preview'], {
    window: {}, AbortController, setTimeout, clearTimeout,
    document: { querySelector: () => buckets, getElementById: () => null },
    fetch: async () => response({ items: [], random_crop: false }),
    ResizeObserver: class {
      constructor(callback) { observer = callback; }
      observe(target) { observed.push(target); }
      disconnect() { disconnected = true; }
    },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const a = composeMixins(context.window.trainingCropPreviewMixin, {
    form: {}, _trainingDatasetPayload: () => ({}), $nextTick: async () => {},
    _keepCropPreviewBucketVisible: target => corrections.push(target),
    _updateCropPreviewBucketBounds: target => updates.push(target),
  });
  await a.openCropPreview();
  assert.deepEqual(observed, [buckets, panel, canvas]);
  const flushFrame = async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    await Promise.all(callbacks.map(callback => callback()));
  };
  observer(); observer();
  assert.equal(frames.size, 1);
  await flushFrame();
  assert.deepEqual(updates, [buckets]);
  assert.deepEqual(corrections, [panel]);
  a.cropPreviewBucketsExpanded = true;
  observer(); await flushFrame();
  assert.equal(corrections.length, 2);
  a._cropBucketMotionCleanup = () => {};
  observer(); await flushFrame();
  assert.equal(corrections.length, 2);
  a._cropBucketMotionCleanup = null;
  observer();
  a.closeCropPreview();
  assert.equal(disconnected, true);
  assert.equal(frames.size, 0);
  assert.equal(a._cropBucketFrame, null);
});

for (const rows of [1, 2, 3, 4, 5]) {
  test(`${rows} bucket rows keep their layout height during the modal scale animation`, () => {
    const box = (height, top = 0) => ({ offsetHeight: height, offsetTop: top,
      getBoundingClientRect: () => ({ height: height / 2, top: top / 2, bottom: (top + height) / 2 }) });
    const minimums = new Map();
    const panel = { style: { setProperty: (key, value) => minimums.set(key, value) } };
    const workspace = { querySelector: () => null, style: { setProperty() {} } };
    const content = { querySelector: () => workspace };
    const chips = Array.from({ length: rows * 3 - 1 }, (_, index) => box(72, 100 + Math.floor(index / 3) * 78));
    const buckets = { querySelectorAll: () => chips, closest: selector => selector === '.cp-stats' ? panel : content };
    const context = loadFrontend(['training/crop-preview'], {
      window: {}, getComputedStyle: element => element === panel ? { paddingTop: '8px', paddingBottom: '8px' } : { gridTemplateColumns: '240px 240px 240px' },
    });
    const a = composeMixins(context.window.trainingCropPreviewMixin);
    a._updateCropPreviewBucketBounds(buckets);
    assert.equal(minimums.get('--cp-bucket-min-height'), '88px');
    const expected = count => Math.min(rows, count) * 78 + 10;
    assert.equal(a.cropPreviewBucketCollapsedHeight, expected(2));
    assert.equal(a.cropPreviewBucketExpandedHeight, expected(4));
    assert.equal(a.cropPreviewBucketsCanExpand, rows > 2);
    a.cropPreviewBucketsExpanded = true;
    a._updateCropPreviewBucketBounds(buckets);
    assert.equal(a.cropPreviewBucketsExpanded, rows > 2);
  });
}

test('opening the crop preview always starts collapsed', async () => {
  const a = app(async () => response({ items: [sample], random_crop: false }));
  a.form = {};
  a.cropPreviewBucketsExpanded = true;
  await a.openCropPreview();
  assert.equal(a.cropPreviewBucketsExpanded, false);
});

function bucketMotionApp(reduced = false) {
  let a;
  const animations = [];
  const panel = {
    style: { height: '' },
    get offsetHeight() {
      const active = animations.at(-1);
      const height = active && !active.cancelled && active.currentHeight != null
        ? active.currentHeight : parseFloat(this.style.height) || a.cropPreviewBucketPanelHeight;
      return height;
    },
    getBoundingClientRect() { return { height: this.offsetHeight / 2 }; },
    animate(frames, options) {
      const ready = deferred();
      const animation = { frames, options, finished: ready.promise,
        finish: () => ready.resolve(),
        cancel() { this.cancelled = true; ready.reject(new Error('cancelled')); },
      };
      animations.push(animation);
      return animation;
    },
    querySelector: () => scroll,
  };
  const scroll = {
    scrollTop: 0,
    selectedTop: 300,
    get clientHeight() { return panel.offsetHeight - 16; },
    getBoundingClientRect: () => ({ top: 0, bottom: scroll.clientHeight / 2 }),
    querySelector: () => ({ get offsetTop() { return scroll.selectedTop; }, offsetHeight: 60,
      getBoundingClientRect: () => ({ top: (scroll.selectedTop - scroll.scrollTop) / 2, bottom: (scroll.selectedTop + 60 - scroll.scrollTop) / 2 }) }),
  };
  const context = loadFrontend(['training/crop-preview'], {
    window: { matchMedia: () => ({ matches: reduced }) },
    document: { getElementById: id => id === 'cropBucketStats' ? panel : null },
    getComputedStyle: () => ({ getPropertyValue: () => 'cubic-bezier(.1,.78,.21,1)' }),
    clearTimeout,
  });
  a = composeMixins(context.window.trainingCropPreviewMixin, {
    $nextTick: async () => {},
  });
  a.cropPreviewBucketCollapsedHeight = 80;
  a.cropPreviewBucketExpandedHeight = 200;
  a.cropPreviewItems = [sample, {...sample,id:'1',bucket:[256,256]}, {...sample,id:'2',bucket:[512,512]}];
  return { a, panel, scroll, animations };
}

test('bucket motion clears its fixed height and keeps the selection visible', async () => {
  const {a, panel, scroll, animations} = bucketMotionApp();
  a.cropPreviewBucket = '512 × 512';
  await a.toggleCropPreviewBuckets();
  assert.equal(a.cropPreviewBucketsExpanded, true);
  assert.deepEqual(Array.from(animations[0].frames, frame => frame.height), ['80px', '200px']);
  assert.equal(animations[0].options.duration, 220);
  assert.equal(animations[0].options.easing, 'cubic-bezier(.1,.78,.21,1)');
  animations[0].finish(); await Promise.resolve();
  assert.equal(panel.style.height, '');
  await a.toggleCropPreviewBuckets();
  assert.equal(a.cropPreviewBucketsExpanded, false);
  assert.deepEqual(Array.from(animations[1].frames, frame => frame.height), ['200px', '80px']);
  assert.equal(animations[1].options.duration, 180);
  animations[1].finish(); await Promise.resolve();
  assert.equal(panel.style.height, '');
  assert.equal(a._cropBucketMotionCleanup, null);
  assert.ok(scroll.scrollTop > 0);
  assert.ok(scroll.querySelector().getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom);
});

test('bucket motion reverses from the rendered height and cancels pending work when the dialog closes', async () => {
  const {a, panel, animations} = bucketMotionApp();
  await a.toggleCropPreviewBuckets();
  animations[0].currentHeight = 130;
  await a.toggleCropPreviewBuckets();
  assert.equal(animations[0].cancelled, true);
  assert.equal(animations[1].frames[0].height, '130px');
  a.closeCropPreview(); await Promise.resolve();
  assert.equal(animations[1].cancelled, true);
  assert.equal(panel.style.height, '');

  const pending = bucketMotionApp();
  const tick = deferred();
  pending.a.$nextTick = () => tick.promise;
  const opening = pending.a.toggleCropPreviewBuckets();
  pending.a.closeCropPreview();
  tick.resolve(); await opening;
  assert.equal(pending.animations.length, 0);
  assert.equal(pending.panel.style.height, '');
});

for (const direction of ['expand', 'collapse']) {
  test(`selecting another bucket during ${direction} keeps the new selection visible after its DOM update`, async () => {
    const {a, scroll, animations} = bucketMotionApp();
    a.cropPreviewBucket = '128 × 128';
    if (direction === 'collapse') {
      await a.toggleCropPreviewBuckets();
      animations[0].finish(); await Promise.resolve();
    }
    scroll.selectedTop = 0;
    scroll.scrollTop = 300;
    await a.toggleCropPreviewBuckets();
    const tick = deferred();
    a.$nextTick = () => tick.promise;
    const selection = a.selectCropPreviewBucket('512 × 512');
    assert.equal(animations.at(-1).cancelled, true);
    assert.equal(scroll.scrollTop, 0);
    assert.equal(a.cropPreviewBucket, '512 × 512');
    scroll.selectedTop = 300;
    tick.resolve(); await selection;
    assert.ok(scroll.scrollTop > 0);
    const selected = scroll.querySelector().getBoundingClientRect();
    const viewport = scroll.getBoundingClientRect();
    assert.ok(selected.top >= viewport.top && selected.bottom <= viewport.bottom);
  });
}

test('reduced motion switches bucket states without starting an animation', async () => {
  const {a, panel, scroll, animations} = bucketMotionApp(true);
  a.cropPreviewBucket = '512 × 512';
  await a.toggleCropPreviewBuckets();
  assert.equal(a.cropPreviewBucketsExpanded, true);
  await a.toggleCropPreviewBuckets();
  assert.equal(a.cropPreviewBucketsExpanded, false);
  assert.equal(animations.length, 0);
  assert.equal(panel.style.height, '');
  assert.ok(scroll.scrollTop > 0);
  assert.ok(scroll.querySelector().getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom);
});

test('unchanged bucket panel height settles immediately', async () => {
  const {a, panel, animations} = bucketMotionApp();
  a.cropPreviewBucketsExpanded = true;
  a.cropPreviewBucketCollapsedHeight = 200;
  await a.toggleCropPreviewBuckets();
  assert.equal(animations.length, 0);
  assert.equal(panel.style.height, '');
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
