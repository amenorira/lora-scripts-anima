const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, deferred } = require('./helpers.cjs');

function importApplication(fields = [{ key: 'learning_rate' }]) {
  const readers = [], requests = [], toasts = [], ticks = [], persisted = [];
  const { window } = loadFrontend(['training/profiles', 'training/config-io'], {
    window: { getVisibleSections: () => [{ fields }], TRAIN_GROUP_MAP: { 'anima-lora': 'anima', 'sdxl-lora': 'sdxl' } },
    FileReader: class {
      constructor() { readers.push(this); }
      readAsText() {}
    },
    fetch: async (_url, options) => {
      const pending = deferred();
      requests.push({ ...pending, body: JSON.parse(options.body) });
      return pending.promise;
    },
    localStorage: { setItem: (_key, value) => persisted.push(JSON.parse(value)) },
  });
  const app = Object.assign({}, window.trainingProfiles, window.trainingConfigIoMixin, {
    trainTypes: ['anima-lora', 'sdxl-lora'].map(v => ({ v })),
    form: { model_train_type: 'anima-lora', learning_rate: 'original' },
    currentRoute: 'train-basic', _routeTransitionSeq: 0, _optimizerDrafts: {},
    _buildFormDefaults: type => ({ model_train_type: type, learning_rate: 'default' }),
    _replaceProfileFieldSources() {}, _normalizeProfileSelectValues() {}, _captureProfileDraft() {},
    _persistProfileDrafts() {}, _persistProfileFieldSources() {}, updateToml() {}, rebuildForm() {},
    _persistActiveTrainingForm() { persisted.push(JSON.parse(JSON.stringify(this.form))); },
    switchTrainType(type) { this.form = { model_train_type: type }; },
    $nextTick: callback => ticks.push(callback),
    toast: (...args) => toasts.push(args), t: key => key,
  });
  const select = name => app.handleConfigFileImport({ target: { files: [{ name }], value: name } });
  const read = index => readers[index].onload({ target: { result: String(index) } });
  const respond = (index, value, type = 'anima-lora') => requests[index].resolve({ json: async () => ({
    status: 'success', data: { data: { model_train_type: type, learning_rate: value }, document_id: value },
  }) });
  return { app, readers, requests, toasts, ticks, persisted, select, read, respond };
}

test('unsupported imported selections reject before changing the form, profile or document', async () => {
  const fields = [{ key: 'network_module', type: 'select', options: [
    { v: 'networks.lora_anima', group: 'anima' }, { v: 'networks.lora', group: 'sdxl' },
    { v: 'lycoris.kohya', group: ['anima', 'sdxl'] },
  ] }];
  for (const type of ['anima-lora', 'sdxl-lora']) {
    for (const value of ['networks.legacy_lora', type === 'anima-lora' ? 'networks.lora' : 'networks.lora_anima', null]) {
      const h = importApplication(fields);
      h.app.t = key => key === 'common.unsupportedConfigOption' ? 'Unsupported {field}: {value}' : key;
      h.app._trainingDocumentId = 'original-document';
      h.app._lastConfigImportIgnoredFields = ['previous-import'];
      const original = h.app.form;
      h.select('invalid.yaml');
      const pending = h.read(0);
      h.requests[0].resolve({ json: async () => ({ status: 'success', data: {
        data: { model_train_type: type, network_module: value }, document_id: 'replacement-document',
      } }) });
      await pending;
      assert.equal(h.app.form, original);
      assert.equal(h.app._trainingDocumentId, 'original-document');
      assert.deepEqual(h.app._lastConfigImportIgnoredFields, ['previous-import']);
      assert.equal(h.persisted.length, 0);
      assert.equal(h.ticks.length, 0);
      assert.deepEqual(h.toasts, [[`common.parseError: Unsupported network_module: ${JSON.stringify(value)}`, 'error']]);
    }
  }
  const h = importApplication(fields);
  h.app.currentRoute = 'monitor';
  h.app._ensureTrainingSession = () => assert.fail('invalid history import must not initialize a session');
  const original = h.app.form;
  assert.throws(() => h.app._applyImportedFlatConfig({ network_module: 'networks.legacy_lora' }));
  assert.equal(h.app.form, original);
});

test('newest selected file wins for out-of-order reads and parse responses', async () => {
  for (const delayRead of [false, true]) {
    const h = importApplication();
    h.select('A');
    const pendingA = delayRead ? null : h.read(0);
    h.select('B');
    const pendingB = h.read(1);
    h.respond(delayRead ? 0 : 1, 'B');
    await pendingB;
    if (delayRead) await h.read(0);
    else { h.respond(0, 'A'); await pendingA; }
    assert.equal(h.app.form.learning_rate, 'B');
    assert.equal(h.app._trainingDocumentId, 'B');
    assert.equal(h.toasts.length, 1);
    assert.equal(h.persisted.length, 1);
    assert.equal(h.app.formHistory.length, 1);
  }
});

test('replaced forms and route transitions invalidate pending imports, including stale errors', async () => {
  for (const change of [h => { h.app.form = { model_train_type: 'anima-lora', learning_rate: 'reset' }; },
    h => { h.app.form.model_train_type = 'sdxl-lora'; },
    h => { h.app._routeTransitionSeq++; }]) {
    for (const fail of [false, true]) {
      const h = importApplication();
      h.select('A');
      const pending = h.read(0);
      change(h);
      if (fail) h.requests[0].reject(new Error('obsolete'));
      else h.respond(0, 'A');
      await pending;
      assert.equal(h.app._trainingDocumentId, null);
      assert.equal(h.toasts.length, 0);
      assert.equal(h.persisted.length, 0);
    }
  }
});

test('superseded nextTick applications cannot overwrite a newer import or its metadata', async () => {
  const h = importApplication();
  h.select('A');
  const pendingA = h.read(0);
  h.respond(0, 'A', 'sdxl-lora');
  await new Promise(setImmediate);
  assert.equal(h.ticks.length, 1);
  h.select('B');
  const pendingB = h.read(1);
  h.respond(1, 'B', 'sdxl-lora');
  await pendingB;
  h.ticks.shift()();
  await pendingA;
  assert.equal(h.app.form.learning_rate, 'B');
  assert.equal(h.app._trainingDocumentId, 'B');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.persisted.length, 1);
});

test('cross-profile file import survives the real Alpine training type watcher', async () => {
  const context = {
    window: { Element: class {}, t: key => key,
      getVisibleSections: () => [{ fields: [{ key: 'learning_rate' }, { key: 'network_module' }] }] },
    document: { createElement: () => ({}) }, MutationObserver: class {},
    queueMicrotask() {}, setTimeout, clearTimeout,
  };
  loadFrontend(['vendor/alpine.min', ...TRAINING_CORE_SCRIPTS, 'training/config-io'], context);
  context.queueMicrotask = queueMicrotask;
  const alpine = context.window.Alpine;
  let renders = 0;
  const app = alpine.reactive(Object.assign({}, context.window.trainingCoreMixin, context.window.trainingConfigIoMixin, {
    currentRoute: 'train-basic', form: { model_train_type: 'anima-lora', learning_rate: 'original' },
    _activeTrainType: 'anima-lora', trainTypes: ['anima-lora', 'sdxl-lora'].map(v => ({ v })),
    _buildFormDefaults: type => ({ model_train_type: type, learning_rate: 'default', network_module: 'networks.lora' }),
    _profileFormFromDraft: (_type, defaults) => ({ ...defaults }),
    _invalidateTrainingPickers() {}, _clearProfileFieldWatchers() {}, _destroyTrainTypePanel() {},
    _captureProfileDraft() {}, _captureProfileFieldSources() {}, _activateProfileFieldSources() {},
    _normalizeProfileSelectValues() {}, _defaultNetworkModule: () => 'networks.lora', _syncKrea2CacheDir() {},
    _persistProfileDrafts() {}, _persistProfileFieldSources() {}, _refreshTrainingOptionErrors() {},
    renderTrainingForm() { renders++; }, _scheduleProfileFieldWatchers() {},
    updateToml() {}, rebuildForm() {}, _replaceProfileFieldSources() {},
    $nextTick: callback => alpine.nextTick(callback),
  }));
  app._setupTrainTypeWatcher();
  try {
    const applied = await app._applyImportedFlatConfig({ model_train_type: 'sdxl-lora', learning_rate: 'imported' }, () => true);
    assert.notEqual(applied, false);
    assert.equal(app.form.learning_rate, 'imported');
    assert.equal(renders, 1);
  } finally { app._trainTypeWatcher(); }
});
