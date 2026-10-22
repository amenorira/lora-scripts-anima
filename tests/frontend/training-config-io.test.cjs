const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

test('flat config import switches profile before filtering fields', async () => {
  const storage = new Map([['anima-form-train-basic', JSON.stringify({
    model_train_type: 'anima-lora', qwen3: './models/stale-qwen.safetensors',
  })]]);
  const context = loadFrontend(['training-core', 'training-config-io'], {
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
  const { window } = loadFrontend('training-core', {
    window: { getVisibleSections: type => [{ key: 'test', fields: fields[type] }], t: (_key, fallback) => fallback },
    setTimeout, clearTimeout,
  });
  const app = Object.assign({}, window.trainingCoreMixin, {
    form: { model_train_type: 'anima-lora', learning_rate: 'anima-custom', optimizer_type: 'AnimaOpt' },
    formDefaults: {}, _profileFormDrafts: {}, _profileFieldSources: {},
    _fieldSources: { learning_rate: 'user', optimizer_type: 'default' }, _activeTrainType: 'anima-lora', currentRoute: '',
    renderTrainingForm() {}, setupAutoValueWatchers() {}, setupShowIfWatchers() {}, setupReadonlyWatchers() {},
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

test('native TOML import sends the profile selected when the file was opened', async () => {
  let reader, request, imported;
  const { window } = loadFrontend('training-config-io', {
    window: {},
    FileReader: class {
      constructor() { reader = this; }
      readAsText() {}
    },
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
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
  app.form.model_train_type = 'anima-lora';
  await reader.onload({ target: { result: 'network_args = ["train_llm_adapter=True"]' } });
  assert.equal(request.model_train_type, 'moss-image-lora');
  assert.equal(imported.train_text_embedder, true);
  assert.equal(imported.rank_dropout, 0.2);
});

test('file import reports unsupported fields instead of a plain success toast', async () => {
  let reader, notice;
  const { window } = loadFrontend('training-config-io', {
    window: {},
    FileReader: class { constructor() { reader = this; } readAsText() {} },
    fetch: async () => ({ json: async () => ({ status: 'success', data: { data: { max_train_steps: 300 } } }) }),
  });
  const app = Object.assign({}, window.trainingConfigIoMixin, {
    form: { model_train_type: 'moss-image-lora' },
    async _applyImportedFlatConfig() { this._lastConfigImportIgnoredFields = ['max_train_steps', 'validation_split']; },
    toast: (text, level) => { notice = { text, level }; },
    t: key => key === 'common.importedWithIgnoredFields' ? 'Not applied: {fields}' : key,
  });
  app.handleConfigFileImport({ target: { files: [{}], value: 'config.toml' } });
  await reader.onload({ target: { result: 'max_train_steps = 300' } });
  assert.equal(notice.level, 'warning');
  assert.match(notice.text, /max_train_steps, validation_split/);
});
