const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

const series = (tag, points) => ({tag, points: points.map(([step, value]) => ({step, value}))});
const preview = (epoch, kind = 'epoch') => ({name: `epoch-${epoch}.png`, path: `sample/${kind}-${epoch}.png`, sample: {
  batch_id: `${kind}-${epoch}`, batch_label: `Epoch ${epoch} · Step ${epoch * 400}`, epoch, step: epoch * 400,
  stage_kind: kind, stage_value: kind === 'epoch' ? epoch : epoch * 400, prompt_index: 0, prompt_id: 'p1', seed: 42,
}});

function app() {
  return composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [preview(1), preview(3), preview(3, 'step')], previewsVersion: 1, lossDataVersion: 1,
    lossSeries: [series('loss/epoch', [[1, 0], [3, .0842]]), series('loss/epoch_average', [[1, .1], [2, .09], [3, .5]]),
      series('loss/timestep/epoch/low', [[1, .04], [3, .0318]])],
    monitorData: {}, currentOutputRunDir: 'output/current', selectedRunDir: null,
    t: key => key, renderDashboard() {}, _refreshIconHtml: () => '',
  });
}

test('sample losses match the exact epoch, preserve zero and gaps, and never use future epoch loss for step sampling', () => {
  const value = app(), batches = value._sampleDataModel().batches;
  assert.equal(value._sampleBatchEpochLoss(batches[0]).values.overall, 0);
  const third = value._sampleBatchEpochLoss(batches[1]);
  assert.deepEqual(third.values, {overall: .0842, low: .0318, mid: null, high: null});
  assert.equal(third.previous.overall, .09, 'the native SD epoch-average tag is accepted when loss/epoch is absent');
  assert.equal(third.previous.low, null, 'a missing epoch must not borrow an older partition value');
  assert.equal(value._sampleBatchEpochLoss(batches[2]).epoch, null);
  assert.equal(value._sampleBatchEpochLoss(batches[2]).values.overall, null);
  assert.equal(value._sampleLossChange(.1, 0), '—');
  assert.equal(value._sampleLossNumber(.000001, true), '1.0e-6');
});

test('unrelated metrics skip historical point reads while replacement snapshots invalidate captions', () => {
  const value = app(); value.sampleLossMode = 'detailed';
  let historicalReads = 0;
  Object.defineProperty(value.lossSeries[0].points[0], 'value', {get() {historicalReads++; return 0;}});
  const before = value._sampleEpochLossIndex();
  historicalReads = 0;
  value.lossSeries.push(series('lr/unet', [[1000, .0001]])); value.lossDataVersion++;
  assert.equal(value._sampleEpochLossIndex(), before);
  let scans = 0;
  const panel = {querySelectorAll() {scans++; return [];}};
  value._patchSampleLossCaptions(panel);
  value.lossDataVersion++; value._patchSampleLossCaptions(panel);
  assert.equal(scans, 1, 'unchanged epoch values bypass the entire caption scan');
  assert.equal(historicalReads, 0, 'step loss and LR updates must not rebuild or compare old epoch points');
  value.lossSeries[0].points = [{step: 1, value: .123}, {step: 3, value: .0842}]; value.lossDataVersion++;
  const corrected = value._sampleEpochLossIndex();
  assert.notEqual(corrected, before, 'a replacement snapshot can correct an older epoch');
  assert.equal(corrected.get('loss/epoch').get(1), .123);
  value._patchSampleLossCaptions(panel);
  assert.equal(scans, 2);
  value.previewsVersion++; value._patchSampleLossCaptions(panel);
  assert.equal(scans, 3, 'new preview metadata must not be hidden by the epoch cache');
});

test('epoch appends, changed tail values, and run switches invalidate the point index', () => {
  const value = app(), initial = value._sampleEpochLossIndex();
  value.lossSeries[0].points.push({step: 4, value: .08});
  const appended = value._sampleEpochLossIndex();
  assert.notEqual(appended, initial);
  assert.equal(appended.get('loss/epoch').get(4), .08);
  value.lossSeries[0].points.at(-1).value = .07;
  const corrected = value._sampleEpochLossIndex();
  assert.notEqual(corrected, appended);
  assert.equal(corrected.get('loss/epoch').get(4), .07);
  value.lossSeries[0].points = value.lossSeries[0].points.slice();
  const snapshot = value._sampleEpochLossIndex();
  assert.notEqual(snapshot, corrected, 'a full replacement snapshot gets a fresh index');
  value.currentOutputRunDir = 'output/other';
  assert.notEqual(value._sampleEpochLossIndex(), snapshot, 'a different run cannot reuse the old index');
});

test('legacy detailed-loss availability reads only the series tags', () => {
  const value = app();
  for (const item of value.lossSeries) Object.defineProperty(item, 'points', {
    get() {assert.fail('availability must not read the historical points');},
  });
  assert.equal(value.sampleDetailedLossAvailable, true);
  assert.equal(value._sampleLossCache, null);
  value.monitorData.log_timestep_loss = false;
  assert.equal(value.sampleDetailedLossAvailable, false);
});

test('loss detail availability belongs to the viewed run and historical values cannot leak from the live task', () => {
  const value = app(), batch = value._sampleDataModel().batches[1];
  value.sampleLossMode = 'detailed';
  assert.equal(value.sampleDetailedLossAvailable, true, 'old runs may establish availability through recorded partitions');
  value.monitorData.log_timestep_loss = false;
  assert.equal(value.sampleEffectiveLossMode, 'overall');
  value.selectedRunDir = 'output/history';
  value.runDetailData = {log_timestep_loss: true, tensorboard_loss: [series('loss/epoch_average', [[3, .25]])]};
  assert.equal(value.sampleEffectiveLossMode, 'detailed');
  assert.equal(value._sampleBatchEpochLoss(batch).values.overall, .25);
  assert.equal(value._sampleBatchEpochLoss(batch).values.low, null);
  value.runDetailData.tensorboard_loss[0].points.push({step: 4, value: .2});
  value.lossDataVersion++;
  value.previews.push(preview(4)); value.previewsVersion++;
  assert.equal(value._sampleBatchEpochLoss(value._sampleDataModel().batches.at(-1)).values.overall, .2);
});

test('shared artifact directories display each run loss in captions, ranking and comparisons', () => {
  const value = app();
  const own = preview(3), older = preview(3), step = preview(3, 'step');
  own.sample.task_id = 'current-task';
  older.path = 'sample/original.png'; older.sample.batch_id = 'original-epoch-3'; older.sample.task_id = 'original-task';
  const historical = {epoch: 3, values: {overall: .12, high: .2, mid: .1, low: .02},
    previous: {overall: .15, high: .3, mid: .2, low: .03}, detailed: true};
  older.sample.epoch_loss = historical;
  value.previews = [own, older, step]; value.previewsVersion++;
  value.sampleLossMode = 'detailed';
  value.monitorData.log_timestep_loss = false;
  assert.equal(value.sampleDetailedLossAvailable, true, 'foreign partition loss remains selectable');
  const model = value._sampleDataModel();
  const read = () => model.batches.map(batch => value._sampleBatchEpochLoss(batch));
  assert.deepEqual(read().map(loss => loss.values.overall), [.0842, .12, null]);
  assert.deepEqual(read()[1].previous, historical.previous);
  assert.match(value._sampleCardCaptionHtml(model.batches[1]), /0\.1200/);
  assert.match(value._sampleLossOverlayHtml(older), /-20\.0%/);
  value.sampleBatchSortDir = 'loss-overall-asc';
  assert.equal(value._sampleOverviewBatches()[0].id, own.sample.batch_id);
  value.sampleBatchSortDir = 'loss-low-asc';
  assert.equal(value._sampleOverviewBatches()[0].id, older.sample.batch_id);
  value.previewCompareActive = true;
  value.previewReferences = [older]; value.previewComparisonOrder = [older.path, null];
  assert.match(value._sampleLossOverlayHtml(own, true), /-29\.8%/);

  value.lossSeries[0].points = [{step: 3, value: .07}];
  assert.deepEqual(read().map(loss => loss.values.overall), [.07, .12, null], 'live metrics update only their own run');

  value.selectedRunDir = 'output/original';
  value.runDetailData = {task_id: 'original-task', tensorboard_loss: [series('loss/epoch_average', [[3, .12]])]};
  // Each API view attaches the other run's values, independently of selection.
  own.sample.epoch_loss = {epoch: 3, values: {overall: .07, high: null, mid: null, low: .0318},
    previous: {overall: null, high: null, mid: null, low: null}, detailed: true};
  delete older.sample.epoch_loss; value.previewsVersion++;
  assert.deepEqual(read().map(loss => loss.values.overall), [.07, .12, null]);
  assert.match(value._sampleLossOverlayHtml(own, true), /-41\.7%/);
});

test('legacy filenames and demo batches display loss without task IDs in either API generation', () => {
  const value = app();
  const demo = preview(3);
  demo.sample.batch_id = 'demo-epoch-000003';
  const name = 'demo_e000001_00_20261115145912_4200.png';
  value.previews = [{name, path: 'sample/' + name}, demo]; value.previewsVersion++;
  value.sampleLossMode = 'overall'; value.sampleBatchSortDir = 'loss-overall-asc';
  const model = value._sampleDataModel();
  for (const detail of [{tensorboard_loss: value.lossSeries}, {task_id: 'demo-task', tensorboard_loss: value.lossSeries}]) {
    value.selectedRunDir = 'output/demo'; value.runDetailData = detail;
    assert.deepEqual(model.batches.map(batch => value._sampleBatchEpochLoss(batch).values.overall), [0, .0842]);
    assert.equal(value._sampleOverviewBatches()[0].id, model.batches[0].id);
    assert.match(value._sampleCardCaptionHtml(model.batches[1]), /0\.0842/);
    assert.match(value._sampleLossOverlayHtml(demo), /\.0842/);
  }
});

test('loss preference persists independently and scalar updates replace only captions', () => {
  const value = app(), saved = [], originalStorage = global.localStorage;
  global.localStorage = {getItem: () => JSON.stringify({lossMode: 'detailed'}), setItem: (key, text) => saved.push(JSON.parse(text))};
  try {
    value._loadSampleViewPreferences();
    assert.equal(value.sampleLossMode, 'detailed');
    value.previewStep = 1; value.sampleBatchId = 'epoch-3';
    value.setSampleLossMode('overall');
    assert.equal(saved.at(-1).lossMode, 'overall');
    assert.equal(value.previewStep, 1); assert.equal(value.sampleBatchId, 'epoch-3');
    let replacement = '';
    const caption = {dataset: {sampleLossBatch: 'epoch-3', sampleLossDetail: '', sampleLossStatus: ''}, set outerHTML(html) {replacement = html;}};
    const panel = {dataset: {}, querySelectorAll: selector => {assert.equal(selector, '[data-sample-loss-batch]'); return [caption];}};
    value._patchSampleLossCaptions(panel);
    assert.match(replacement, /0\.0842/);
    value.lossSeries[0].points[1].value = .08; value.lossDataVersion++;
    value._patchSampleLossCaptions(panel);
    assert.match(replacement, /0\.0800/);
    value.monitorData.log_timestep_loss = false;
    value.setSampleLossMode('detailed');
    assert.equal(value.sampleLossMode, 'overall', 'an unavailable detail mode cannot be selected');
  } finally {if (originalStorage === undefined) delete global.localStorage; else global.localStorage = originalStorage;}
});

test('modal loss follows each displayed file, retains nodes on mode changes, and excludes a pending current image', () => {
  const value = app(), previousDocument = global.document;
  const bounds = {left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500};
  const element = () => ({children: [], dataset: {}, style: {}, hidden: false,
    get offsetHeight() {return this.className === 'm-sample-loss-overlay' ? 93 : 500;},
    append(child) {if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
      this.children.push(child); child.parent = this;},
    remove() {this.parent.children = this.parent.children.filter(child => child !== this);},
    replaceChildren() {this.children = [];}, getBoundingClientRect: () => bounds});
  const layer = element(); layer.offsetWidth = 800;
  let currentBounds = {...bounds, left: 400, width: 400};
  const current = element(), reference = element();
  current.getBoundingClientRect = () => currentBounds;
  reference.getBoundingClientRect = () => ({...bounds, right: 388, width: 388});
  global.document = {createElement: element, getElementById: id => ({previewLossLayer: layer,
    previewLightboxViewport: element(), previewCurrentStage: current})[id] || null};
  Object.assign(value, {previewLightboxOpen: true, previewCompareActive: true, previewComparisonWaiting: false,
    previewImageAvailable: true, previewImageLoading: false, previewStep: 1, sampleLossMode: 'detailed',
    _previewReferenceMedia: {entries: new Map([['ref', {preview: value.previews[0], pane: {querySelector: () => reference},
      image: {getAttribute: () => '/reference.png'}}]])}});
  try {
    value._syncPreviewLossOverlays();
    assert.equal(layer._lossNodes.size, 2);
    const currentNode = layer._lossNodes.get('current'), referenceNode = layer._lossNodes.get('reference:ref');
    assert.match(currentNode.overlay.innerHTML, />\.0842</);
    assert.match(referenceNode.overlay.innerHTML, />\.0000</);
    assert.equal(currentNode.parent, current);
    currentBounds = {...bounds, left: 200, right: 1000, width: 800};
    value._layoutPreviewLossOverlays();
    assert.equal(currentNode.anchor.style.width, undefined, 'native scrolling never writes image-relative anchor geometry');
    value.setSampleLossMode('overall'); value._syncPreviewLossOverlays();
    assert.equal(layer._lossNodes.get('current'), currentNode);
    assert.equal(layer._lossNodes.get('reference:ref'), referenceNode);
    assert.match(currentNode.overlay.innerHTML, /m-sample-loss-overall/);
    value.previewImageLoading = true; value._syncPreviewLossOverlays();
    assert.equal(layer._lossNodes.size, 1, 'the old pixels cannot display the newly selected file’s loss');
    assert.equal(layer._lossNodes.has('current'), false);
    value.setSampleLossMode('off'); value._syncPreviewLossOverlays();
    assert.equal(layer._lossNodes.size, 0); assert.equal(layer.hidden, true);
    assert.equal(current.children.length, 0); assert.equal(reference.children.length, 0);
  } finally {global.document = previousDocument;}
});
