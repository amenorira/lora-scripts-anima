const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo } = require('./helpers.cjs');

function application() {
  const messages = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
  const t = (key, fallback) => key.split('.').reduce((value, part) => value?.[part], messages) || fallback || key;
  const { window } = loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-toml', 'training-config-io'], {
    window: { t }, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated schema'); },
    setTimeout, clearTimeout, btoa, TextEncoder,
  });
  const app = Object.assign({}, window.utilsMixin, window.trainingCoreMixin, window.trainingTomlMixin, window.trainingConfigIoMixin, {
    t, _renderTomlPreview() {}, showConditionalFields() {}, rebuildForm() {},
    _persistProfileDrafts() {}, _persistProfileFieldSources() {},
  });
  app.form = app._buildFormDefaults('anima-lora');
  app.formDefaults = { ...app.form };
  app._fieldSources = Object.fromEntries(Object.keys(app.form).map(key => [key, 'default']));
  const fields = window.getVisibleSections('anima-lora').flatMap(section => section.fields);
  app._autoValueRules = fields.flatMap(field => (field.autoValue || []).map(rule => ({ target: field.key, ...rule })));
  app._applyInitialAutoValues();
  return app;
}

test('Anima exports performance defaults without changing optimizer or network settings', () => {
  const app = application();
  assert.equal(app.form.gradient_checkpointing, true);
  assert.equal(app.form.qwen_image_vae_2d, true);
  assert.equal(app.form.max_data_loader_n_workers, 2);
  assert.equal(app.form.persistent_data_loader_workers, true);
  assert.equal(app.form.network_dim, 32);
  assert.equal(app.form.network_alpha, 32);
  assert.equal(app.form.learning_rate, '2e-5');
  assert.equal(app.form.lr_scheduler, 'constant');
  assert.equal(app.form.timestep_sampling, 'sigmoid');
  assert.equal(app.form.vae_disable_cache, false);
  assert.equal(app.form.vae_chunk_size, '');
  app.updateToml();
  const payload = app._collectTrainingPayload();
  for (const [key, value] of Object.entries({ gradient_checkpointing: true, qwen_image_vae_2d: true, max_data_loader_n_workers: 2 })) {
    assert.match(app.tomlRaw, new RegExp(`^${key} = ${value}$`, 'm'));
    assert.equal(payload[key], value);
  }
  for (const profile of ['moss-image-lora', 'sdxl-lora', 'krea2-lora']) {
    app.form = app._buildFormDefaults(profile);
    assert.equal(app.form.qwen_image_vae_2d, undefined);
    assert.equal(app._collectTrainingPayload().qwen_image_vae_2d, undefined);
  }
  const sdxl = app._buildFormDefaults('sdxl-lora');
  assert.equal(sdxl.gradient_checkpointing, false);
  assert.equal(sdxl.max_data_loader_n_workers, '');
});

test('Anima imports preserve disabled defaults, zero workers and saved 3D cache settings', async () => {
  const app = application();
  await app._applyImportedFlatConfig({ model_train_type: 'anima-lora',
    gradient_checkpointing: false, qwen_image_vae_2d: false,
    max_data_loader_n_workers: 0, persistent_data_loader_workers: false, vae_disable_cache: true,
  });
  const draft = app._profileFormFromDraft('anima-lora', app._buildFormDefaults('anima-lora'), app.form);
  assert.equal(draft.gradient_checkpointing, false);
  assert.equal(draft.qwen_image_vae_2d, false);
  assert.equal(draft.max_data_loader_n_workers, 0);
  const payload = app._collectTrainingPayload();
  assert.equal(payload.gradient_checkpointing, false);
  assert.equal(payload.qwen_image_vae_2d, false);
  assert.equal(payload.max_data_loader_n_workers, 0);
  assert.match(app.tomlRaw, /^gradient_checkpointing = false$/m);
  assert.match(app.tomlRaw, /^qwen_image_vae_2d = false$/m);
  const cacheField = app.findFieldDef('vae_disable_cache');
  assert.doesNotMatch(app.renderField(cacheField), /data-readonly-if-active="1"/);
  app.form.qwen_image_vae_2d = true;
  assert.match(app.renderField(cacheField), /data-readonly-if-active="1"/);
  app.updateToml();
  assert.equal(app.form.vae_disable_cache, true);
  assert.equal(app._collectTrainingPayload().vae_disable_cache, true);
});
