const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, deferred } = require('./helpers.cjs');

test('flat config import switches profile before filtering fields', async () => {
  const storage = new Map([['anima-form-train-basic', JSON.stringify({
    model_train_type: 'anima-lora', qwen3: './models/stale-qwen.safetensors',
  })]]);
  const context = loadFrontend([...TRAINING_CORE_SCRIPTS, 'training/config-io'], {
    window: { getVisibleSections: type => [{ key: 'model', fields:
      (type === 'sdxl-lora' ? ['model_train_type', 'pretrained_model_name_or_path', 'network_module', 'xformers']
        : ['model_train_type', 'qwen3']).map(key => ({ key })),
    }] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
  const events = [], ticks = [];
  const app = Object.assign({}, context.window.trainingCoreMixin, context.window.trainingConfigIoMixin, {
    currentRoute: 'train-basic', trainTypes: ['sdxl-lora', 'anima-lora', 'krea2-lora'].map(v => ({ v })),
    form: { model_train_type: 'anima-lora', qwen3: './models/old-qwen.safetensors' },
    _activeTrainType: 'anima-lora', _profileFormDrafts: {}, _profileFieldSources: {}, _fieldSources: {},
    switchTrainType(type) {
      events.push(`switch:${type}`);
      this.form = { model_train_type: type, network_module: 'networks.lora' };
      this._activeTrainType = type;
      this.$nextTick(() => { events.push(`switch-tick:${type}`); this.form.network_module = 'networks.lora'; });
    },
    $nextTick: callback => ticks.push(callback),
    _buildFormDefaults(type) {
      events.push(`defaults:${type}`);
      return type === 'sdxl-lora'
        ? { model_train_type: type, pretrained_model_name_or_path: './models/default.safetensors', network_module: 'networks.lora', xformers: false }
        : { model_train_type: type, qwen3: './models/default-qwen.safetensors' };
    },
    _normalizeProfileSelectValues() {}, _syncKrea2CacheDir() {}, _captureProfileDraft() {}, updateToml() {}, rebuildForm() {},
  });
  const importing = app._applyImportedFlatConfig({
    model_train_type: 'sdxl-lora', pretrained_model_name_or_path: './models/imported.safetensors',
    network_module: 'lycoris.kohya', xformers: true, qwen3: './models/must-not-leak.safetensors', unknown_field: 123,
  });
  while (ticks.length) ticks.shift()();
  await importing;
  assert.deepEqual(events.slice(0, 3), ['switch:sdxl-lora', 'switch-tick:sdxl-lora', 'defaults:sdxl-lora']);
  assert.deepEqual(JSON.parse(JSON.stringify(app.form)), {
    model_train_type: 'sdxl-lora', pretrained_model_name_or_path: './models/imported.safetensors',
    network_module: 'lycoris.kohya', xformers: true,
  });
  assert.deepEqual(JSON.parse(storage.get('anima-form-train-basic')), JSON.parse(JSON.stringify(app.form)));
});

test('training profiles keep independent drafts and reset from registry defaults', () => {
  const profiles = [['anima', 'anima-default', 'AnimaOpt'], ['sdxl', 'sdxl-default', 'SDXLOpt'], ['krea2', 'krea-default', 'KreaOpt']];
  const fields = Object.fromEntries(profiles.map(([name, rate, optimizer]) => [`${name}-lora`, [
    { key: 'learning_rate', type: 'text', default: rate },
    { key: 'optimizer_type', type: 'select', default: optimizer, options: [{ v: optimizer }] },
    ...(name === 'krea2' ? ['dit', 'vae', 'text_encoder'].map((key, i) => ({
      key, type: 'text', default: `./models/${['raw', 'vae', 'text'][i]}.safetensors`,
    })) : []),
  ]]));
  const { window } = loadFrontend([...TRAINING_CORE_SCRIPTS], {
    window: { getVisibleSections: type => [{ key: 'test', fields: fields[type] }], t: (_key, fallback) => fallback },
    setTimeout, clearTimeout,
  });
  const app = Object.assign({}, window.trainingCoreMixin, {
    form: { model_train_type: 'anima-lora', learning_rate: 'anima-custom', optimizer_type: 'AnimaOpt' },
    formDefaults: {}, _profileFormDrafts: {}, _profileFieldSources: {},
    _fieldSources: { learning_rate: 'user', optimizer_type: 'default' }, _activeTrainType: 'anima-lora', currentRoute: '',
    renderTrainingForm() {}, _scheduleProfileFieldWatchers() {},
    updateToml() {}, rebuildForm() {}, toast() {}, t: (_key, fallback) => fallback || '', $nextTick: fn => fn(),
  });
  app.stepEstimate = { subsets: [{ name: 'old-profile' }] };
  const previousRequest = app._stepEstimateRequestSeq;
  app.switchTrainType('krea2-lora');
  assert.equal(app.stepEstimate, null);
  assert.ok(app._stepEstimateRequestSeq > previousRequest);
  assert.equal(app.form.learning_rate, 'krea-default');
  app.form.learning_rate = 'krea-custom';
  app._setFieldSource('learning_rate', 'user');
  app.switchTrainType('sdxl-lora');
  assert.equal(app.form.learning_rate, 'sdxl-default');
  for (const [type, value] of [['anima-lora', 'anima-custom'], ['krea2-lora', 'krea-custom']]) {
    app.switchTrainType(type);
    assert.equal(app.form.learning_rate, value);
    assert.equal(app._fieldSources.learning_rate, 'user');
  }
  app.formDefaults.learning_rate = 'imported-baseline';
  app.form.learning_rate = 'edited-after-import';
  app.setField = (key, value) => { app.form[key] = value; };
  app.resetField('learning_rate');
  assert.equal(app.form.learning_rate, 'krea-default');
  assert.equal(app._fieldSources.learning_rate, 'default');
  app.formDefaults.learning_rate = 'polluted-default';
  app.form.learning_rate = 'polluted-value';
  app.resetAllParams();
  assert.equal(app.form.learning_rate, 'krea-default');
  assert.equal(app.formDefaults.learning_rate, 'krea-default');
  assert.equal(app._fieldSources.learning_rate, 'default');
});

test('preview lists validate before import and survive profile switch and reset', async () => {
  const fields = [
    { key: 'preview_loras', type: 'lora-list', default: [] },
    { key: 'preview_sampler', type: 'select', default: 'euler', options: [{ v: 'euler' }, { v: 'er_sde' }] },
    { key: 'preview_scheduler', type: 'select', default: 'native', options: [{ v: 'native' }, { v: 'beta57' }] },
  ];
  const { window } = loadFrontend([...TRAINING_CORE_SCRIPTS, 'training/config-io'], {
    window: { getVisibleSections: () => [{ key: 'preview', fields }], t: (_key, fallback) => fallback },
    setTimeout, clearTimeout,
  });
  const app = Object.assign({}, window.trainingCoreMixin, window.trainingConfigIoMixin, {
    form: { model_train_type: 'anima-lora', preview_loras: [] },
    _activeTrainType: 'anima-lora', _profileFormDrafts: {}, _profileFieldSources: {}, _fieldSources: {},
    currentRoute: '', formDefaults: {}, renderTrainingForm() {}, _scheduleProfileFieldWatchers() {},
    updateToml() {}, rebuildForm() {}, toast() {}, t: key => key, $nextTick: fn => fn(),
  });
  const original = app.form;
  for (const value of [{ path: 'one' }, [null], [{ multiplier: true }]]) {
    assert.throws(() => app._applyImportedFlatConfig({
      model_train_type: 'moss-image-lora', preview_loras: value,
    }), /previewLoras.invalid/);
    assert.equal(app.form, original);
    assert.equal(app._activeTrainType, 'anima-lora');
  }
  await app._applyImportedFlatConfig({ model_train_type: 'anima-lora', preview_sampler: 'er_sde', preview_scheduler: 'beta57', preview_loras: [
    { path: 'one.safetensors', multiplier: -0.3 }, { path: 'two.safetensors', multiplier: 0.7 },
  ] });
  app.switchTrainType('moss-image-lora');
  assert.equal(app.form.preview_loras.length, 0);
  assert.equal(app.form.preview_sampler, 'euler');
  assert.equal(app.form.preview_scheduler, 'native');
  app.form.preview_loras = [{ path: 'moss.safetensors', multiplier: 0.4 }];
  app.switchTrainType('anima-lora');
  assert.equal(app.form.preview_loras[0].multiplier, -0.3);
  assert.equal(app.form.preview_loras[1].path, 'two.safetensors');
  assert.equal(app.form.preview_sampler, 'er_sde');
  assert.equal(app.form.preview_scheduler, 'beta57');
  app.resetAllParams();
  assert.equal(app.form.preview_loras.length, 0);
  assert.equal(app.form.preview_sampler, 'euler');
  assert.equal(app.form.preview_scheduler, 'native');
  app._profileFormDrafts['moss-image-lora'].preview_loras = { path: 'corrupted draft' };
  app.switchTrainType('moss-image-lora');
  assert.equal(app.form.preview_loras.length, 0);
});

test('native TOML import keeps its parse profile but discards results after a profile switch', async () => {
  let reader, request, imported;
  const parsing = deferred();
  const { window } = loadFrontend('training/config-io', {
    window: {},
    FileReader: class {
      constructor() { reader = this; }
      readAsText() {}
    },
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      await parsing.promise;
      return { json: async () => ({ status: 'success', data: { data: {
        model_train_type: 'moss-image-lora', train_text_embedder: true, rank_dropout: 0.2,
      } } }) };
    },
  });
  const app = Object.assign({}, window.trainingConfigIoMixin, {
    form: { model_train_type: 'moss-image-lora' },
    _applyImportedFlatConfig: async form => { imported = form; },
    toast() {}, t: key => key,
  });
  app.handleConfigFileImport({ target: { files: [{}], value: 'config.toml' } });
  const pending = reader.onload({ target: { result: 'network_args = ["train_llm_adapter=True"]' } });
  app.form.model_train_type = 'anima-lora';
  parsing.resolve();
  await pending;
  assert.equal(request.model_train_type, 'moss-image-lora');
  assert.equal(imported, undefined);
});

function importApplication() {
  const readers = [], requests = [], toasts = [], ticks = [], persisted = [];
  const { window } = loadFrontend('training/config-io', {
    window: { getVisibleSections: () => [{ fields: [{ key: 'learning_rate' }] }] },
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
  const app = Object.assign({}, window.trainingConfigIoMixin, {
    trainTypes: ['anima-lora', 'sdxl-lora'].map(v => ({ v })),
    form: { model_train_type: 'anima-lora', learning_rate: 'original' },
    currentRoute: 'train-basic', _routeTransitionSeq: 0, _optimizerDrafts: {},
    _buildFormDefaults: type => ({ model_train_type: type, learning_rate: 'default' }),
    _replaceProfileFieldSources() {}, _normalizeProfileSelectValues() {}, _captureProfileDraft() {},
    _persistProfileDrafts() {}, _persistProfileFieldSources() {}, updateToml() {}, rebuildForm() {},
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

test('obsolete parse failures and file read errors stay quiet', async () => {
  const h = importApplication();
  h.select('A');
  const pendingA = h.read(0);
  h.select('B');
  h.requests[0].reject(new Error('old failure'));
  await pendingA;
  h.readers[0].error = new Error('old read failure');
  h.readers[0].onerror();
  assert.equal(h.toasts.length, 0);
  h.readers[1].error = new Error('current read failure');
  h.readers[1].onerror();
  assert.match(h.toasts[0][0], /current read failure/);
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

test('history reuse supersedes file imports still being parsed', async () => {
  const h = importApplication();
  h.select('A');
  const pending = h.read(0);
  await h.app._applyImportedFlatConfig({ model_train_type: 'anima-lora', learning_rate: 'history' });
  h.respond(0, 'A');
  await pending;
  assert.equal(h.app.form.learning_rate, 'history');
  assert.equal(h.toasts.length, 0);
});

test('history applications retain their atomic update when navigation changes during nextTick', async () => {
  const h = importApplication();
  const pending = h.app._applyImportedFlatConfig({ model_train_type: 'sdxl-lora', learning_rate: 'history' });
  h.app.currentRoute = 'monitor';
  h.app._routeTransitionSeq++;
  h.ticks.shift()();
  await pending;
  assert.equal(h.app.form.learning_rate, 'history');
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
  app.$watch = (path, callback) => {
    assert.equal(path, 'form.model_train_type');
    return alpine.watch(() => app.form.model_train_type, callback);
  };
  app._setupTrainTypeWatcher();
  try {
    const applied = await app._applyImportedFlatConfig({ model_train_type: 'sdxl-lora', learning_rate: 'imported' }, () => true);
    assert.notEqual(applied, false);
    assert.equal(app.form.learning_rate, 'imported');
    assert.equal(renders, 1);
  } finally { app._trainTypeWatcher(); }
});
