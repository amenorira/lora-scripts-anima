const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response, readRepo} = require('./helpers.cjs');

function app(fetch, dictionary = null, localStorage = undefined) {
  const document = {addEventListener() {}, querySelector: () => null, getElementById: () => null};
  const grid = {
    async reveal(id) { return document.getElementById(`crop-image-${id}`); },
    returnTo() {},
  };
  const context = loadFrontend(['shared/utils', 'training/preflight', 'training/crop-preview-grid', 'training/crop-preview'], {
    window: {AnimaUI: {setDialogOrigin() {}, settleDialog() {}}},
    AbortController, setTimeout, clearTimeout, document, fetch, localStorage,
  });
  context.getCropPreviewGrid = () => grid;
  return composeMixins(context.window.utilsMixin, context.window.trainingPreflight, context.window.trainingCropPreviewMixin, {
    document, grid, buildCropGridLayout: context.buildCropGridLayout, cropGridRowAt: context.cropGridRowAt,
    t: key => (dictionary ? key.split('.').reduce((v, part) => v?.[part], dictionary) ?? key : key),
    esc: text => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
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

test('crop preview localizes API errorCode and per-image error_code in Japanese', async () => {
  const jaDict = JSON.parse(readRepo('frontend/i18n/ja-JP.json'));
  const a = app(async () => ({
    ok: true,
    json: async () => ({
      status: 'fail',
      message: 'Select a valid training dataset directory / 请选择有效的训练数据集目录',
      data: { errorCode: 'cropPreviewInvalidDataset', errorParams: {} },
    }),
  }), jaDict);
  a.form = { model_train_type: 'anima-lora', train_data_dir: '' };
  a._trainingDatasetPayload = () => ({ train_data_dir: '' });

  await a.openCropPreview();
  assert.equal(a.cropPreviewError, jaDict.errors.cropPreviewInvalidDataset);
  assert.ok(!a.cropPreviewError.includes('/'));

  assert.equal(
    a.localizeApiError(
      { status: 'fail', message: 'raw / 原文', data: { errorCode: 'invalidResolution', errorParams: {} } },
      'cropPreview.failed',
      { prefixes: ['errors', 'stepEstimate.errors'] },
    ),
    jaDict.stepEstimate.errors.invalidResolution
  );
  assert.equal(
    a.cropPreviewItemError({ error: 'Image is smaller / 图片小于', error_code: 'cropPreviewImageSmaller' }),
    jaDict.errors.cropPreviewImageSmaller
  );
});

test('crop preview source scope defaults to training-only, persists via localStorage, and falls back when reg is not configured', async () => {
  const store = new Map();
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  const trainItem = { ...sample, id: 't1', name: 'train.png', is_reg: false };
  const regItem = { ...sample, id: 'r1', name: 'reg.png', is_reg: true };
  let regDir = 'D:/reg';
  const fetchMock = async () => ({
    ok: true,
    json: async () => ({
      status: 'success',
      data: { random_crop: false, items: regDir ? [trainItem, regItem] : [trainItem] },
    }),
  });

  const first = app(fetchMock, null, storage);
  first.form = { random_crop: false, cache_latents: false, cache_latents_to_disk: false };
  first._trainingDatasetPayload = () => ({ model_train_type: 'anima-lora', enable_reg_data: true, reg_data_dir: regDir });

  assert.equal(first.cropPreviewSource, 'exclude');
  assert.deepEqual(Array.from(first.cropPreviewSourceOptions(), option => option.value), ['exclude', 'only', 'include']);

  await first.openCropPreview();
  assert.equal(first.cropPreviewRegConfigured, true);
  assert.equal(first.cropPreviewSource, 'exclude');
  assert.deepEqual(Array.from(first.cropPreviewSourceItems, item => item.id), ['t1']);

  first.setCropPreviewSource('only');
  assert.equal(store.get('anima-crop-preview-source'), 'only');
  assert.deepEqual(Array.from(first.cropPreviewSourceItems, item => item.id), ['r1']);

  first.setCropPreviewSource('include');
  assert.equal(store.get('anima-crop-preview-source'), 'include');
  assert.deepEqual(Array.from(first.cropPreviewSourceItems, item => item.id), ['t1', 'r1']);

  // Persist 'only', reopen, and ensure it restores; then disable reg and confirm read-time fallback preserves stored preference
  first.setCropPreviewSource('only');
  const reopened = app(fetchMock, null, storage);
  reopened.form = { random_crop: false, cache_latents: false, cache_latents_to_disk: false };
  reopened._trainingDatasetPayload = () => ({ model_train_type: 'anima-lora', enable_reg_data: true, reg_data_dir: regDir });
  await reopened.openCropPreview();
  assert.equal(reopened.cropPreviewSource, 'only');
  assert.deepEqual(Array.from(reopened.cropPreviewSourceItems, item => item.id), ['r1']);

  regDir = '';
  await reopened.openCropPreview();
  assert.equal(reopened.cropPreviewRegConfigured, false);
  assert.equal(reopened.cropPreviewSource, 'only');
  assert.equal(store.get('anima-crop-preview-source'), 'only');
  assert.deepEqual(Array.from(reopened.cropPreviewSourceItems, item => item.id), ['t1']);
});
