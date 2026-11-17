const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');
global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

function app() {
  const previews = [1, 2, 3, 4, 5].map(epoch => ({name: `${epoch}.png`, path: `sample/${epoch}.png`, sample: {
    batch_id: `b${epoch}`, batch_label: `Epoch ${epoch} · Step ${epoch * 400}`, epoch, step: epoch * 400,
    stage_kind: epoch === 5 ? 'step' : 'epoch', prompt_id: 'fox', prompt_index: 0, seed: 42,
    metadata_source: 'recorded', comparable: true, condition_key: 'same',
  }}));
  const series = (tag, values) => ({tag, points: values.flatMap((value, i) => value === null ? [] : [{step: i + 1, value}])});
  return composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews, previewsVersion: 1, previewStep: 3, sampleBatchId: 'b4', lossDataVersion: 1,
    monitorData: {log_timestep_loss: true}, currentOutputRunDir: 'current',
    lossSeries: [series('loss/epoch', [.3, 0, .2, .2, .001]), series('loss/timestep/epoch/high', [.1, .4, .2, null, 0]),
      series('loss/timestep/epoch/mid', [.3, .2, .1, .4, 0]), series('loss/timestep/epoch/low', [.2, .1, .3, .05, 0])],
    t: key => key, renderDashboard() {},
  });
}

test('loss ordering is ascending, keeps zero, breaks ties by recency, and leaves missing or step samples last', () => {
  const value = app();
  for (const [key, expected] of [['overall', [2, 4, 3, 1, 5]], ['high', [1, 3, 2, 5, 4]],
    ['mid', [3, 2, 1, 4, 5]], ['low', [4, 2, 1, 3, 5]]]) {
    value.sampleBatchSortDir = 'loss-' + key;
    assert.deepEqual(value._sampleOverviewBatches().map(batch => Number(batch.id.slice(1))), expected);
    assert.deepEqual(value._previewLightboxDisplayIndices().map(index => index + 1), expected);
  }
  assert.deepEqual(value._sampleDataModel().batches.map(batch => batch.id), ['b1', 'b2', 'b3', 'b4', 'b5']);
  value.sampleBatchSortDir = 'loss-overall';
  assert.equal(value.sampleSidebarNavigationTarget(-1), 1);
  assert.equal(value.sampleSidebarNavigationTarget(1), 2);
  assert.equal(value._previewLightboxNavigationTarget(1), 2);
});

test('unrelated metrics reuse the ranking while epoch corrections and historical runs invalidate it', () => {
  const value = app(); value.sampleBatchSortDir = 'loss-overall';
  const order = value._sampleBatchOrder();
  value.lossSeries.push({tag: 'lr/unet', points: [{step: 100, value: .1}]}); value.lossDataVersion++;
  assert.equal(value._sampleBatchOrder(), order);
  value.lossSeries[0].points = [{step: 1, value: -.1}, {step: 2, value: 0}]; value.lossDataVersion++;
  assert.notEqual(value._sampleBatchOrder(), order);
  assert.equal(value._sampleOverviewBatches()[0].id, 'b1');
  value.selectedRunDir = 'history'; value.runDetailData = {tensorboard_loss: [{tag: 'loss/epoch_average', points: [{step: 3, value: 0}]}]};
  assert.equal(value._sampleOverviewBatches()[0].id, 'b3', 'the viewed run owns the ranking');
});

test('loss ranking does not resume chronological following when another epoch is sampled', () => {
  const value = app(); value.previews = value.previews.slice(0, 4); value.previewsVersion++;
  value.sampleBatchSortDir = 'loss-overall';
  const selected = value.previews[3], next = {...selected, name: '6.png', path: 'sample/6.png',
    sample: {...selected.sample, batch_id: 'b6', batch_label: 'Epoch 6', epoch: 6, step: 2400}};
  value._replacePreviewItems([...value.previews, next]);
  assert.equal(value.previews[value.previewStep], selected);
  assert.equal(value.sampleBatchId, 'b4');
  assert.equal(value._sampleOverviewAtLatestEdge({scrollTop: 0}), false);
});

test('partition options follow logging availability and a saved partition falls back to overall loss', () => {
  const value = app();
  assert.deepEqual(value._sampleSortOptions().map(option => option.value), ['asc', 'desc', 'loss-overall', 'loss-high', 'loss-mid', 'loss-low']);
  value.sampleBatchSortDir = 'loss-high'; value.monitorData.log_timestep_loss = false;
  assert.equal(value.sampleEffectiveBatchSort, 'loss-overall');
  assert.deepEqual(value._sampleSortOptions().map(option => option.value), ['asc', 'desc', 'loss-overall']);
  value.setSampleBatchSort('loss-low'); assert.equal(value.sampleBatchSortDir, 'loss-high');
  value.monitorData.log_timestep_loss = true;
  const originalStorage = Object.getOwnPropertyDescriptor(global, 'localStorage'), writes = [];
  Object.defineProperty(global, 'localStorage', {configurable: true, value: {
    getItem: () => JSON.stringify({sort: 'loss-mid'}), setItem: (_key, data) => writes.push(JSON.parse(data)),
  }});
  try {
    value._loadSampleViewPreferences(); assert.equal(value.sampleBatchSortDir, 'loss-mid');
    value.previewComparisonOrder = ['fixed-b', 'fixed-a', null];
    value.setSampleBatchSort('loss-low');
    assert.equal(writes.at(-1).sort, 'loss-low');
    assert.equal(value.previewsVersion, 1, 'sorting does not rebuild the media viewport');
    assert.equal(value.previewStep, 3);
    assert.deepEqual(value.previewComparisonOrder, ['fixed-b', 'fixed-a', null]);
  } finally {
    if (originalStorage) Object.defineProperty(global, 'localStorage', originalStorage);
    else delete global.localStorage;
  }
});

test('new epoch values move existing batch nodes while preserving the visible anchor and skipping unrelated updates', () => {
  const value = app(), nodes = new Map(value._sampleDataModel().batches.map(batch => [batch.id, {dataset: {batchId: batch.id}}]));
  const grid = {children: ['b5', 'b4', 'b3', 'b2', 'b1'].map(key => nodes.get(key)), scrollTop: 30,
    contains: () => false, get firstElementChild() {return this.children[0];},
    insertBefore(node, next) {this.children.splice(this.children.indexOf(node), 1); this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node);}};
  for (const node of nodes.values()) Object.defineProperty(node, 'nextElementSibling', {get: () => grid.children[grid.children.indexOf(node) + 1]});
  let queries = 0, restores = 0, outlines = 0, viewerUpdates = 0;
  value.previewLightboxOpen = true; value._updatePreviewLightbox = () => {viewerUpdates++;};
  value.sampleExpandedBatchId = 'b3'; value._refreshSampleGroupOutline = () => {outlines++;};
  const panel = {querySelector() {queries++; return grid;}};
  const previousLayout = window.AnimaSampleLayout;
  window.AnimaSampleLayout = {captureAnchor: () => ({batchId: 'b3'}), restoreAnchor: (_grid, anchor) => {restores++; return anchor;}};
  try {
    value._patchSampleBatchOrder(panel, true);
    value.sampleBatchSortDir = 'loss-high'; value._patchSampleBatchOrder(panel);
    assert.deepEqual(grid.children.map(node => node.dataset.batchId), ['b1', 'b3', 'b2', 'b5', 'b4']);
    assert(grid.children.every(node => nodes.get(node.dataset.batchId) === node));
    assert.equal(restores, 1);
    assert.equal(viewerUpdates, 0, 'explicit sort controls perform their own single viewer refresh');
    const beforeQueries = queries;
    value.lossDataVersion++; value._patchSampleBatchOrder(panel);
    assert.equal(queries, beforeQueries, 'normal step updates do not rescan or reorder the DOM');
    value.lossSeries[1].points = [{step: 1, value: .5}, {step: 2, value: .4}, {step: 3, value: 0}];
    value._patchSampleBatchOrder(panel);
    assert.equal(grid.children[0], nodes.get('b3'));
    assert.equal(restores, 2);
    assert.equal(outlines, 2, 'the expanded group outline follows its reordered cards');
    assert.equal(viewerUpdates, 1, 'an arriving epoch value refreshes the open timeline and counter');
  } finally {window.AnimaSampleLayout = previousLayout;}
});
