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
