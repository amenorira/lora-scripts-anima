const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo, deferred } = require('./helpers.cjs');

const dictionary = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
const subset = (name, repeats = 1) => ({ name, repeats, image_count: 1, sample_count: repeats, is_reg: false });
function application(result, names) {
  const requests = [], toasts = [], state = { result, names };
  const { window } = loadFrontend(['training/dataset-repeat', 'training/preflight', 'training/timestep-preview'], {
    window: {}, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/dataset-repeat') && state.pending) return state.pending.promise;
      if (url.endsWith('/estimate') && state.estimatePending) return state.estimatePending.promise;
      return { ok: true, json: async () => url.endsWith('/estimate')
        ? { status: 'success', data: state.estimateData || { subsets: state.names.map(name => subset(name)) } } : state.result };
    },
  });
  const app = Object.assign({}, window.datasetRepeatMixin, window.trainingPreflight, window.trainingTimestepPreview, {
    form: { model_train_type: 'anima-lora', train_data_dir: 'train',
      subset_timestep_offsets: { '5_alpha': 0.2, '2_beta': -0.1 } },
    stepEstimate: { subsets: [subset('5_alpha', 5), subset('2_beta', 2)] },
    datasetRepeatDrafts: { '5_alpha': '8', '2_beta': '3' },
    datasetRepeatLastApplied: { dir: 'train', items: [{ oldName: '1_old', newName: '2_old' }] },
    datasetRepeatFailure: null, datasetRepeatApplying: false,
    _refreshSubsetTimestepEditor() {}, _setFieldSource() {}, _persistProfileFieldSources() {},
    _persistProfileDrafts() {}, pushHistory() {}, updateToml() {},
    t: (key, fallback) => key.split('.').reduce((value, part) => value?.[part], dictionary) ?? fallback ?? key,
    toast: (...args) => toasts.push(args),
  });
  return { app, state, requests, toasts };
}

const recovery = (oldName, currentName) => ({ oldName, currentName,
  originalPath: `C:/train/${oldName}`, currentPath: `C:/train/${currentName}` });
const failed = (code, items = []) => ({ status: 'fail', data: { errorCode: code,
  errorParams: { names: '5_alpha, 2_beta', reason: 'in use $&' }, recovery: items } });
const plain = value => JSON.parse(JSON.stringify(value));

test('partial rollback clears stale state and affected offsets, rescans and reports actual paths', async () => {
  for (const currentName of ['8_alpha', '.repeat_tmp_test']) {
    const h = application(failed('rollbackFailed', [recovery('5_alpha', currentName)]),
      currentName.startsWith('.') ? ['2_beta'] : [currentName, '2_beta']);
    await h.app.applyDatasetRepeatChanges();
    assert.deepEqual(plain(h.app.datasetRepeatDrafts), {});
    assert.equal(h.app.datasetRepeatLastApplied, null);
    assert.equal(h.app.datasetRepeatApplying, false);
    assert.deepEqual(plain(h.app.form.subset_timestep_offsets), { '2_beta': -0.1 });
    assert.deepEqual(h.requests.map(item => item.url), ['/api/training/dataset-repeat', '/api/training/estimate']);
    assert.ok(h.app.datasetRepeatFailureText().includes(`C:/train/${currentName} → C:/train/5_alpha`));
    assert.match(h.toasts[0][0], /in use \$&/);
    h.state.names = ['5_alpha', '2_beta'];
    await h.app.refreshStepEstimate(true);
    assert.equal(h.app.form.subset_timestep_offsets['5_alpha'], undefined);
    assert.equal(h.app.datasetRepeatReadOnly(), false);
  }
});

test('complete rollback keeps retry drafts and undo while refreshing the disk listing', async () => {
  const h = application(failed('renameFailed'), ['5_alpha', '2_beta']);
  const last = h.app.datasetRepeatLastApplied;
  await h.app.applyDatasetRepeatChanges();
  assert.deepEqual(plain(h.app.datasetRepeatDrafts), { '5_alpha': '8', '2_beta': '3' });
  assert.equal(h.app.datasetRepeatLastApplied, last);
  assert.equal(h.app.datasetRepeatFailure, null);
  assert.equal(h.requests.length, 2);
});

test('failed undo uses the same partial failure handling', async () => {
  const h = application(failed('rollbackFailed', [recovery('2_beta', '1_beta')]), ['5_alpha', '1_beta']);
  h.app.datasetRepeatLastApplied = { dir: 'train', items: [{ oldName: '1_beta', newName: '2_beta' }] };
  await h.app.undoDatasetRepeatChanges();
  assert.equal(h.app.datasetRepeatLastApplied, null);
  assert.deepEqual(plain(h.app.form.subset_timestep_offsets), { '5_alpha': 0.2 });
  assert.equal(h.requests.length, 2);
});

test('validation failures keep drafts without unnecessary rescans', async () => {
  const h = application(failed('targetExists'), ['5_alpha', '2_beta']);
  await h.app.applyDatasetRepeatChanges();
  assert.equal(h.requests.length, 1);
  assert.equal(h.app.datasetRepeatDrafts['5_alpha'], '8');
});

test('validation failures and no-op responses resume debounced estimates with the latest parameters', async () => {
  for (const result of [failed('targetExists'), { status: 'success', data: { applied: [] } }]) {
    const h = application(result, ['5_alpha', '2_beta']);
    h.app.stepEstimate.total_steps = 100;
    h.state.estimateData = { total_steps: 50, subsets: h.app.stepEstimate.subsets };
    h.app.form.train_batch_size = 2;
    h.app.scheduleStepEstimate();
    assert.ok(h.app._stepEstimateTimer);

    await h.app.applyDatasetRepeatChanges();

    assert.deepEqual(h.requests.map(item => item.url), ['/api/training/dataset-repeat', '/api/training/estimate']);
    assert.equal(h.requests[1].body.train_batch_size, 2);
    assert.equal(h.app.stepEstimate.total_steps, 50);
    assert.equal(h.app.stepEstimateLoading, false);
    assert.equal(h.app._stepEstimateTimer, null);
    assert.equal(h.app.datasetRepeatDrafts['5_alpha'], '8');
    h.app.scheduleStepEstimate();
    assert.equal(h.app._stepEstimateTimer, null);
  }
});

test('validation failures resume an in-flight estimate and ignore its late response', async () => {
  const h = application(failed('targetExists'), ['5_alpha', '2_beta']);
  h.state.estimatePending = deferred();
  const oldEstimate = h.state.estimatePending;
  const estimating = h.app.refreshStepEstimate(true);
  h.state.estimatePending = null;
  h.state.estimateData = { total_steps: 50, subsets: h.app.stepEstimate.subsets };

  await h.app.applyDatasetRepeatChanges();
  oldEstimate.resolve({ ok: true, json: async () => ({ status: 'success', data: { total_steps: 100, subsets: [] } }) });
  await estimating;

  assert.deepEqual(h.requests.map(item => item.url), ['/api/training/estimate', '/api/training/dataset-repeat', '/api/training/estimate']);
  assert.equal(h.app.stepEstimate.total_steps, 50);
  assert.equal(h.app.stepEstimateLoading, false);
});

test('validation failures run estimates deferred by parameter edits during the mutation', async () => {
  const h = application(failed('targetExists'), ['5_alpha', '2_beta']);
  h.state.pending = deferred();
  h.state.estimateData = { total_steps: 50, subsets: h.app.stepEstimate.subsets };
  const applying = h.app.applyDatasetRepeatChanges();
  h.app.form.train_batch_size = 2;
  h.app.scheduleStepEstimate();
  assert.equal(h.requests.length, 1);
  h.state.pending.resolve({ ok: true, json: async () => h.state.result });
  await applying;

  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.train_batch_size, 2);
  assert.equal(h.app.stepEstimate.total_steps, 50);
});

test('late partial failure updates the original dataset draft without touching an unrelated form', async () => {
  const h = application(failed('rollbackFailed', [recovery('5_alpha', '.repeat_tmp_test')]), ['2_beta']);
  h.state.pending = deferred();
  h.app._profileFormDrafts = { 'anima-lora': { ...h.app.form } };
  const pending = h.app.applyDatasetRepeatChanges();
  h.app.form = { model_train_type: 'moss-image-lora', train_data_dir: 'other', subset_timestep_offsets: { '5_alpha': 0.8 } };
  h.state.pending.resolve({ ok: true, json: async () => h.state.result });
  await pending;
  assert.equal(h.app.datasetRepeatFailureText(), '');
  assert.deepEqual(plain(h.app.datasetRepeatDrafts), {});
  assert.deepEqual(plain(h.app.form.subset_timestep_offsets), { '5_alpha': 0.8 });
  assert.deepEqual(plain(h.app._profileFormDrafts['anima-lora'].subset_timestep_offsets), { '2_beta': -0.1 });
  h.app.form.train_data_dir = 'train';
  assert.match(h.app.datasetRepeatFailureText(), /\.repeat_tmp_test/);
});

test('old and new estimates cannot reconcile temporary folder names during mutation', async () => {
  const h = application(failed('rollbackFailed', [recovery('5_alpha', '.repeat_tmp_test')]), ['2_beta']);
  h.state.estimatePending = deferred();
  const estimate = h.app.refreshStepEstimate(true), oldSequence = h.app._stepEstimateRequestSeq;
  h.state.pending = deferred();
  const applying = h.app.applyDatasetRepeatChanges();
  assert.ok(h.app._stepEstimateRequestSeq > oldSequence);
  assert.equal(await h.app.refreshStepEstimate(true), null);
  h.app.scheduleStepEstimate();
  assert.equal(h.requests.length, 2);
  h.state.estimatePending.resolve({ ok: true, json: async () => ({ status: 'success', data: { subsets: [subset('2_beta')] } }) });
  await estimate;
  assert.equal(h.app.form.subset_timestep_offsets['5_alpha'], 0.2);
  h.state.estimatePending = null;
  h.state.pending.resolve({ ok: true, json: async () => h.state.result });
  await applying;
  assert.equal(h.app._datasetRepeatMutationDir, null);
  assert.equal(h.app.stepEstimateLoading, false);
});

test('successful renames update all profiles using that dataset after a profile switch', async () => {
  const h = application({ status: 'success', data: { applied: [{ oldName: '5_alpha', newName: '8_alpha', repeats: 8 }] } },
    ['8_alpha', '2_beta']);
  h.state.pending = deferred();
  h.app._profileFormDrafts = { 'anima-lora': { ...h.app.form } };
  const pending = h.app.applyDatasetRepeatChanges();
  h.app.form = { model_train_type: 'moss-image-lora', train_data_dir: 'train',
    subset_timestep_offsets: { '5_alpha': 0.8, '2_beta': -0.2 } };
  h.state.pending.resolve({ ok: true, json: async () => h.state.result });
  await pending;
  assert.equal(h.app.form.subset_timestep_offsets['8_alpha'], 0.8);
  assert.equal(h.app._profileFormDrafts['anima-lora'].subset_timestep_offsets['8_alpha'], 0.2);
  assert.equal(h.app._profileFormDrafts['anima-lora'].subset_timestep_offsets['5_alpha'], undefined);
});

test('returning to a mutating dataset invalidates estimates started for another directory', async () => {
  const h = application({ status: 'success', data: { applied: [{ oldName: '5_alpha', newName: '8_alpha', repeats: 8 }] } },
    ['8_alpha', '2_beta']);
  h.state.pending = deferred();
  const original = h.app.form;
  const applying = h.app.applyDatasetRepeatChanges();
  h.app.form = { model_train_type: 'anima-lora', train_data_dir: 'other', subset_timestep_offsets: {} };
  h.state.estimatePending = deferred();
  const estimate = h.app.refreshStepEstimate(true);
  h.app.form = original;
  h.app.scheduleStepEstimate();
  h.state.estimatePending.resolve({ ok: true, json: async () => ({ status: 'success',
    data: { subsets: [subset('other_subset')] } }) });
  await estimate;
  assert.equal(h.app.form.subset_timestep_offsets['5_alpha'], 0.2);
  h.state.estimatePending = null;
  h.state.pending.resolve({ ok: true, json: async () => h.state.result });
  await applying;
  assert.equal(h.app.form.subset_timestep_offsets['8_alpha'], 0.2);
});

test('switching directories during a successful swap clears that batch of drafts', async () => {
  const h = application({ status: 'success', data: { applied: [
    { oldName: '1_cat', newName: '2_cat', repeats: 2 }, { oldName: '2_cat', newName: '1_cat', repeats: 1 },
  ] } }, ['1_cat', '2_cat']);
  h.app.stepEstimate = { subsets: [subset('1_cat', 1), subset('2_cat', 2)] };
  h.app.datasetRepeatDrafts = { '1_cat': '2', '2_cat': '1' };
  h.state.pending = deferred();
  const original = h.app.form;
  const pending = h.app.applyDatasetRepeatChanges();
  h.app.form = { model_train_type: 'anima-lora', train_data_dir: 'other' };
  h.state.pending.resolve({ ok: true, json: async () => h.state.result });
  await pending;
  h.app.form = original;
  assert.equal(h.app.datasetRepeatDirtyCount(), 0);
});

test('unknown request outcomes discard unreliable drafts, undo and offsets and rescan', async () => {
  const h = application(null, ['5_alpha', '2_beta']);
  h.state.pending = deferred();
  const pending = h.app.applyDatasetRepeatChanges();
  h.state.pending.reject(new Error('connection lost'));
  await pending;
  assert.equal(h.app.datasetRepeatLastApplied, null);
  assert.deepEqual(plain(h.app.datasetRepeatDrafts), {});
  assert.deepEqual(plain(h.app.form.subset_timestep_offsets), {});
  assert.match(h.app.datasetRepeatFailureText(), /connection lost/);
  assert.equal(h.requests.length, 2);
});

test('offset editing pauses only while the directory request is in flight', async () => {
  const h = application(failed('rollbackFailed', [recovery('5_alpha', '8_alpha')]), ['8_alpha', '2_beta']);
  h.state.pending = deferred();
  const pending = h.app.applyDatasetRepeatChanges();
  h.app.setSubsetTimestepOffset('5_alpha', '');
  assert.equal(h.app.form.subset_timestep_offsets['5_alpha'], 0.2);
  h.state.pending.resolve({ ok: true, json: async () => h.state.result });
  await pending;
  h.app.setSubsetTimestepOffset('8_alpha', '0.7');
  assert.equal(h.app.form.subset_timestep_offsets['8_alpha'], 0.7);
});
