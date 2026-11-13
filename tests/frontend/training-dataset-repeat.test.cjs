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
