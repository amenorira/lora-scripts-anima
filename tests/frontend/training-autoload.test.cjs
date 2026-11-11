const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, composeMixins } = require('./helpers.cjs');

const route = 'train-basic';
const activeKey = 'anima-form-' + route;
const profilesKey = 'anima-form-profiles-' + route;
const sourcesKey = 'anima-form-profile-sources-v1-' + route;
const plain = value => JSON.parse(JSON.stringify(value));

function application(entries, autoLoadHistory) {
  const storage = new Map(Object.entries(entries));
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const window = {
    t: key => key, addEventListener() {}, removeEventListener() {},
    TRAIN_GROUP_MAP: {},
    getVisibleSections: () => [{ key: 'training', fields: [
      { key: 'learning_rate', type: 'text', default: 'default-rate' },
      { key: 'train_data_dir', type: 'text', default: 'train' },
      { key: 'subset_timestep_offsets', type: 'hidden', hidden: true, default: {} },
    ] }],
  };
  const context = loadFrontend([...TRAINING_CORE_SCRIPTS, 'training/dataset-repeat', 'training/config-io',
    'monitor/history-render'], {
    window, localStorage, setTimeout, clearTimeout, AbortController,
    ROUTE_CONFIG: { [route]: { trainType: 'anima-lora' } },
    document: { getElementById: () => null },
  });
  const app = composeMixins(context.window.trainingCoreMixin, context.window.datasetRepeatMixin,
    context.window.trainingConfigIoMixin, context.window.monitorHistoryRenderMixin, {
    currentRoute: route, locale: 'en-US', autoLoadHistory,
    _resumeTrainForm: () => false,
    _invalidateTrainingPickers() {}, _disposeKreaDitFormatWatcher() {},
    _cancelScheduledTrainTypeSwitch() {}, _cancelProfileFieldWatcherSetup() {},
    _cancelTrainingPreflight() {}, stopSectionScroll() {}, _destroyTrainTypePanel() {},
    buildSectionNav() {}, renderTrainingForm() {}, setupAutoValueWatchers() {},
    setupShowIfWatchers() {}, setupReadonlyWatchers() {}, setupKreaDitFormatWatcher() {},
    _clearProfileFieldWatchers() {}, _scheduleProfileFieldWatchers() {}, _refreshTrainingOptionErrors() {},
    updateToml() {}, rebuildForm() {}, toast() {}, startProgress() {}, finishProgress() {},
    t: key => key, tMonitor: key => key, historyReuseBusy: '', _reuseRequestSeq: 0,
    navigate(nextRoute) { this.currentRoute = nextRoute; this.buildTrainForm(); },
    scheduleShapeEstimate() {}, scheduleStepEstimate() {}, scheduleOutputPathInfo() {},
    refreshTrainingRealtimeState() {}, xfRefresh: async () => {},
    _watchTrainingState: () => () => {}, $nextTick: callback => callback(),
  });
  return { app, storage };
}

test('startup restore honors the setting and preserves old drafts when disabled', () => {
  const saved = { model_train_type: 'sdxl-lora', learning_rate: 'old-rate', train_data_dir: 'old-train' };
  const drafts = { 'sdxl-lora': saved, 'future-profile': { value: 'keep' } };
  const sources = { version: 1, profiles: { 'sdxl-lora': { learning_rate: 'user' },
    'future-profile': { value: 'saved' } } };
  const entries = { [activeKey]: JSON.stringify(saved), [profilesKey]: JSON.stringify(drafts),
    [sourcesKey]: JSON.stringify(sources) };
  const disabled = application(entries, false);
  disabled.app.buildTrainForm();
  assert.equal(disabled.app.form.model_train_type, 'anima-lora');
  assert.equal(disabled.app.form.learning_rate, 'default-rate');
  disabled.app.suspendTrainForm(route);
  assert.deepEqual(Object.fromEntries(disabled.storage), entries);
  disabled.app.form.learning_rate = 'new-rate';
  disabled.app._setFieldSource('learning_rate', 'user');
  disabled.app.suspendTrainForm(route);
  assert.deepEqual(JSON.parse(disabled.storage.get(profilesKey))['future-profile'], { value: 'keep' });
  assert.deepEqual(JSON.parse(disabled.storage.get(sourcesKey)).profiles['future-profile'], { value: 'saved' });
  assert.equal(JSON.parse(disabled.storage.get(profilesKey))['sdxl-lora'].learning_rate, 'old-rate');
  const enabled = application(entries, true);
  enabled.app.buildTrainForm();
  assert.equal(enabled.app.form.model_train_type, 'sdxl-lora');
  assert.equal(enabled.app.form.learning_rate, 'old-rate');
});

test('disabled restore preserves session edits on rebuild and migrates a legacy active draft', () => {
  const legacy = { model_train_type: 'sdxl-lora', learning_rate: 'legacy-rate', train_data_dir: 'old-train' };
  const h = application({ [activeKey]: JSON.stringify(legacy) }, false);
  h.app.buildTrainForm();
  h.app.form.learning_rate = 'new-rate';
  h.app._setFieldSource('learning_rate', 'user');
  h.app._captureProfileDraft('anima-lora', h.app.form);
  h.app._persistProfileDrafts();
  h.app._persistProfileFieldSources();
  h.app._persistActiveTrainingForm();
  const saved = JSON.parse(h.storage.get(profilesKey));
  assert.equal(saved['sdxl-lora'].learning_rate, 'legacy-rate');
  assert.equal(saved['anima-lora'].learning_rate, 'new-rate');
  h.app.suspendTrainForm(route);
  h.app.currentRoute = 'settings';
  h.app.currentRoute = route;
  h.app.locale = 'ja-JP';
  h.app.buildTrainForm();
  assert.equal(h.app.form.learning_rate, 'new-rate');
  const next = application(Object.fromEntries(h.storage), true);
  next.app.buildTrainForm();
  assert.equal(next.app.form.learning_rate, 'new-rate');
  assert.equal(next.app._profileFormDrafts['sdxl-lora'].learning_rate, 'legacy-rate');
});

test('disabled restore does not load other profile drafts when switching models', () => {
  const oldAnima = { model_train_type: 'anima-lora', learning_rate: 'old-anima' };
  const oldSdxl = { model_train_type: 'sdxl-lora', learning_rate: 'old-sdxl' };
  const h = application({ [activeKey]: JSON.stringify(oldAnima),
    [profilesKey]: JSON.stringify({ 'anima-lora': oldAnima, 'sdxl-lora': oldSdxl }) }, false);
  h.app.buildTrainForm();
  h.app.form.learning_rate = 'new-anima';
  h.app._setFieldSource('learning_rate', 'user');
  h.app.switchTrainType('sdxl-lora');
  assert.equal(h.app.form.learning_rate, 'default-rate');
  assert.equal(JSON.parse(h.storage.get(profilesKey))['sdxl-lora'].learning_rate, 'old-sdxl');
  h.app.switchTrainType('anima-lora');
  assert.equal(h.app.form.learning_rate, 'new-anima');
});

test('an explicit import remains available and is saved with restore disabled', async () => {
  const old = { model_train_type: 'sdxl-lora', learning_rate: 'old-rate' };
  const h = application({ [activeKey]: JSON.stringify(old) }, false);
  h.app.buildTrainForm();
  await h.app._applyImportedFlatConfig({ model_train_type: 'anima-lora', learning_rate: 'imported-rate' });
  assert.equal(h.app.form.learning_rate, 'imported-rate');
  assert.equal(JSON.parse(h.storage.get(activeKey)).learning_rate, 'imported-rate');
  assert.equal(JSON.parse(h.storage.get(profilesKey))['sdxl-lora'].learning_rate, 'old-rate');
});

test('history reuse before the first training visit is applied, and undo restores defaults and storage', async () => {
  const old = { model_train_type: 'sdxl-lora', learning_rate: 'old-rate' };
  const inactive = { model_train_type: 'anima-lora', learning_rate: 'unloaded-anima' };
  const entries = { [activeKey]: JSON.stringify(old),
    [profilesKey]: JSON.stringify({ 'sdxl-lora': old, 'anima-lora': inactive }),
    [sourcesKey]: JSON.stringify({ version: 1, profiles: {
      'sdxl-lora': { learning_rate: 'saved' }, 'anima-lora': { learning_rate: 'user' },
    } }) };
  const h = application(entries, false);
  h.app.currentRoute = 'history';
  await h.app.reuseConfig('output/run', { reuse_params: { model_train_type: 'sdxl-lora', learning_rate: 'copied' } });
  assert.equal(h.app.currentRoute, route);
  assert.equal(h.app.form.learning_rate, 'copied');
  assert.deepEqual(JSON.parse(h.storage.get(profilesKey))['anima-lora'], inactive);
  assert.deepEqual(JSON.parse(h.storage.get(sourcesKey)).profiles['anima-lora'], { learning_rate: 'user' });
  await h.app.undoHistoryReuse();
  assert.equal(h.app.form.model_train_type, 'anima-lora');
  assert.equal(h.app.form.learning_rate, 'default-rate');
  assert.equal(h.app._fieldSources.learning_rate, 'default');
  assert.deepEqual(Object.fromEntries(h.storage), entries);
  h.app.suspendTrainForm(route);
  assert.deepEqual(Object.fromEntries(h.storage), entries);
});

test('history reuse before the first visit restores both saved profiles and sources on undo when enabled', async () => {
  const sdxl = { model_train_type: 'sdxl-lora', learning_rate: 'old-active', train_data_dir: 'sdxl-dir' };
  const anima = { model_train_type: 'anima-lora', learning_rate: 'keep-also', train_data_dir: 'anima-dir' };
  const entries = {
    [activeKey]: JSON.stringify(sdxl),
    [profilesKey]: JSON.stringify({ 'sdxl-lora': sdxl, 'anima-lora': anima }),
    [sourcesKey]: JSON.stringify({ version: 1, profiles: {
      'sdxl-lora': { learning_rate: 'user', train_data_dir: 'import' },
      'anima-lora': { learning_rate: 'saved', train_data_dir: 'user' },
    } }),
  };
  const h = application(entries, true);
  h.app.currentRoute = 'history';
  await h.app.reuseConfig('output/run', { reuse_params: { model_train_type: 'anima-lora', learning_rate: 'copied' } });
  assert.equal(h.app.form.learning_rate, 'copied');
  await h.app.undoHistoryReuse();
  assert.equal(h.app.form.model_train_type, 'sdxl-lora');
  assert.equal(h.app.form.learning_rate, 'old-active');
  assert.equal(h.app.form.train_data_dir, 'sdxl-dir');
  const profiles = JSON.parse(h.storage.get(profilesKey));
  const sources = JSON.parse(h.storage.get(sourcesKey)).profiles;
  assert.equal(profiles['sdxl-lora'].learning_rate, 'old-active');
  assert.equal(profiles['anima-lora'].learning_rate, 'keep-also');
  assert.equal(profiles['anima-lora'].train_data_dir, 'anima-dir');
  assert.equal(sources['sdxl-lora'].learning_rate, 'user');
  assert.equal(sources['sdxl-lora'].train_data_dir, 'import');
  assert.deepEqual(sources['anima-lora'], { learning_rate: 'saved', train_data_dir: 'user' });
  const next = application(Object.fromEntries(h.storage), true);
  next.app.buildTrainForm();
  assert.equal(next.app.form.learning_rate, 'old-active');
  assert.equal(next.app._fieldSources.train_data_dir, 'import');
  next.app.switchTrainType('anima-lora');
  assert.equal(next.app.form.learning_rate, 'keep-also');
  assert.equal(next.app._fieldSources.learning_rate, 'saved');
});

test('undoing a cross-profile history reuse restores unloaded drafts and the previous edit markers', async () => {
  const old = { model_train_type: 'sdxl-lora', learning_rate: 'old-rate' };
  const entries = { [activeKey]: JSON.stringify(old), [profilesKey]: JSON.stringify({ 'sdxl-lora': old }),
    [sourcesKey]: JSON.stringify({ version: 1, profiles: { 'sdxl-lora': { learning_rate: 'user' } } }) };
  const h = application(entries, false);
  h.app.buildTrainForm();
  h.app.form.learning_rate = 'session-rate';
  h.app._setFieldSource('learning_rate', 'user');
  h.app.suspendTrainForm(route);
  const before = Object.fromEntries(h.storage);
  h.app.currentRoute = 'history';
  await h.app.reuseConfig('output/run', { reuse_params: { model_train_type: 'sdxl-lora', learning_rate: 'copied' } });
  assert.equal(JSON.parse(h.storage.get(profilesKey))['sdxl-lora'].learning_rate, 'copied');
  await h.app.undoHistoryReuse();
  assert.equal(h.app.form.model_train_type, 'anima-lora');
  assert.equal(h.app.form.learning_rate, 'session-rate');
  assert.deepEqual(Object.fromEntries(h.storage), before);
  assert.deepEqual(Array.from(h.app._sessionEditedProfiles), ['anima-lora']);
  h.app.suspendTrainForm(route);
  assert.equal(JSON.parse(h.storage.get(profilesKey))['sdxl-lora'].learning_rate, 'old-rate');
});

test('history undo keeps directory renames made after copying', async () => {
  const old = { model_train_type: 'sdxl-lora', train_data_dir: 'train',
    subset_timestep_offsets: { '5_cat': 0.2 } };
  const h = application({ [activeKey]: JSON.stringify(old),
    [profilesKey]: JSON.stringify({ 'sdxl-lora': old }) }, false);
  h.app.buildTrainForm();
  h.app.currentRoute = 'history';
  await h.app.reuseConfig('output/run', { reuse_params: { model_train_type: 'sdxl-lora' } });
  h.app._renameDatasetRepeatProfileOffsets([{ oldName: '5_cat', newName: '8_cat' }], 'train');
  await h.app.undoHistoryReuse();
  assert.deepEqual(JSON.parse(h.storage.get(activeKey)).subset_timestep_offsets, { '8_cat': 0.2 });
  assert.deepEqual(JSON.parse(h.storage.get(profilesKey))['sdxl-lora'].subset_timestep_offsets, { '8_cat': 0.2 });
});

test('history undo keeps renamed offsets when startup restore is enabled', async () => {
  const old = { model_train_type: 'sdxl-lora', train_data_dir: 'train',
    subset_timestep_offsets: { '5_cat': 0.2 } };
  const h = application({ [activeKey]: JSON.stringify(old),
    [profilesKey]: JSON.stringify({ 'sdxl-lora': old }) }, true);
  h.app.buildTrainForm();
  h.app.currentRoute = 'history';
  await h.app.reuseConfig('output/run', { reuse_params: { model_train_type: 'anima-lora' } });
  h.app._renameDatasetRepeatProfileOffsets([{ oldName: '5_cat', newName: '8_cat' }], 'train');
  await h.app.undoHistoryReuse();
  assert.deepEqual(plain(h.app.form.subset_timestep_offsets), { '8_cat': 0.2 });
  assert.deepEqual(plain(h.app.formHistory[0].subset_timestep_offsets), { '8_cat': 0.2 });
  assert.deepEqual(JSON.parse(h.storage.get(profilesKey))['sdxl-lora'].subset_timestep_offsets, { '8_cat': 0.2 });
});

test('legacy sd-lora is restored when enabled and preserved when another profile is edited', () => {
  const entries = { [activeKey]: JSON.stringify({ model_train_type: 'sd-lora', learning_rate: 'legacy-rate' }) };
  const enabled = application(entries, true);
  enabled.app.buildTrainForm();
  assert.equal(enabled.app.form.model_train_type, 'anima-lora');
  assert.equal(enabled.app.form.learning_rate, 'legacy-rate');
  const disabled = application(entries, false);
  disabled.app.buildTrainForm();
  assert.equal(disabled.app.form.learning_rate, 'default-rate');
  assert.equal(disabled.storage.get(activeKey), entries[activeKey]);
  disabled.app.switchTrainType('sdxl-lora');
  disabled.app.form.learning_rate = 'new-sdxl';
  disabled.app._setFieldSource('learning_rate', 'user');
  disabled.app.suspendTrainForm(route);
  const profiles = JSON.parse(disabled.storage.get(profilesKey));
  assert.equal(profiles['anima-lora'].learning_rate, 'legacy-rate');
  assert.equal(profiles['anima-lora'].model_train_type, 'anima-lora');
  assert.equal(profiles['sdxl-lora'].learning_rate, 'new-sdxl');
});

test('a legacy active form with missing or unknown model type is kept when editing another profile', () => {
  for (const [type, savedAs] of [[undefined, 'anima-lora'], ['future-profile', 'future-profile']]) {
    const old = { learning_rate: 'legacy-rate' };
    if (type) old.model_train_type = type;
    const h = application({ [activeKey]: JSON.stringify(old) }, false);
    h.app.buildTrainForm();
    h.app.switchTrainType('sdxl-lora');
    h.app.form.learning_rate = 'new-rate';
    h.app._setFieldSource('learning_rate', 'user');
    h.app.suspendTrainForm(route);
    assert.equal(JSON.parse(h.storage.get(profilesKey))[savedAs].learning_rate, 'legacy-rate');
  }
});

test('preserving an old active form retains its precedence over an older profile draft', () => {
  const old = { model_train_type: 'sdxl-lora', learning_rate: 'newer-active' };
  const h = application({ [activeKey]: JSON.stringify(old), [profilesKey]: JSON.stringify({
    'sdxl-lora': { model_train_type: 'sdxl-lora', learning_rate: 'older-profile', train_data_dir: 'keep-dir' },
  }) }, false);
  h.app.buildTrainForm();
  h.app.form.learning_rate = 'current-session';
  h.app._setFieldSource('learning_rate', 'user');
  h.app.suspendTrainForm(route);
  const saved = JSON.parse(h.storage.get(profilesKey))['sdxl-lora'];
  assert.equal(saved.learning_rate, 'newer-active');
  assert.equal(saved.train_data_dir, 'keep-dir');
});

test('renaming a subset updates unloaded historical offsets without restoring the draft', () => {
  const saved = { model_train_type: 'sdxl-lora', learning_rate: 'old-rate', train_data_dir: 'train',
    subset_timestep_offsets: { '5_cat': 0.2, '2_dog': -0.1 } };
  const h = application({ [activeKey]: JSON.stringify(saved),
    [profilesKey]: JSON.stringify({ 'sdxl-lora': saved, 'future-profile': { value: 'keep' } }) }, false);
  h.app.buildTrainForm();
  // A rename response can arrive after leaving the training page.
  h.app.currentRoute = 'settings';
  h.app._renameDatasetRepeatProfileOffsets([{ oldName: '5_cat', newName: '8_cat' }], 'train');
  assert.deepEqual(plain(h.app.form.subset_timestep_offsets), {});
  assert.deepEqual(JSON.parse(h.storage.get(activeKey)).subset_timestep_offsets, { '8_cat': 0.2, '2_dog': -0.1 });
  assert.deepEqual(JSON.parse(h.storage.get(profilesKey))['sdxl-lora'].subset_timestep_offsets,
    { '8_cat': 0.2, '2_dog': -0.1 });
  assert.deepEqual(JSON.parse(h.storage.get(profilesKey))['future-profile'], { value: 'keep' });
});
