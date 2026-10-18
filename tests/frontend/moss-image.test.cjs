const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application() {
  const context = loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-toml'], {
    window: { t: (_key, fallback) => fallback }, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated schema'); },
    setTimeout, clearTimeout,
  });
  const w = context.window;
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, {
    t: key => key, _renderTomlPreview() {},
  });
  app.form = app._buildFormDefaults('moss-image-lora');
  return { app, window: w };
}

test('MOSS retains its selected native algorithm across profile switches', () => {
  const { app } = application();
  Object.assign(app, {
    formDefaults: {}, _profileFormDrafts: {}, _profileFieldSources: {},
    _fieldSources: {}, _activeTrainType: 'moss-image-lora', currentRoute: '',
    renderTrainingForm() {}, setupAutoValueWatchers() {}, setupShowIfWatchers() {}, setupReadonlyWatchers() {},
    updateToml() {}, rebuildForm() {}, toast() {}, $nextTick: fn => fn(),
  });
  for (const module of ['networks.loha', 'networks.lokr']) {
    app.form.network_module = module;
    app.switchTrainType('anima-lora');
    assert.equal(app.form.network_module, 'networks.lora_anima');
    app.switchTrainType('moss-image-lora');
    assert.equal(app.form.network_module, module);
  }
});

test('MOSS starts with isolated models, native LoRA and its own training and sampling defaults', () => {
  const { app, window } = application();
  assert.ok(app.trainTypes.some(type => type.v === 'moss-image-lora'));
  assert.equal(app.form.pretrained_model_name_or_path, '');
  assert.equal(app.form.vae, '');
  assert.equal(app.form.text_encoder, '');
  assert.equal(app.form.network_module, 'networks.lora_generic');
  assert.equal(app.form.moss_max_token_length, 4096);
  assert.equal(app.form.gradient_checkpointing, true);
  assert.equal(app.form.timestep_sampling, 'sigma');
  assert.equal(app.form.logit_mean, -1.09);
  assert.equal(app.form.sample_steps, 50);
  assert.equal(app.form.sample_cfg, 3);
  assert.equal(app.form.sample_flow_shift, 5);
  assert.equal(app._numberConstraints(app.findFieldDef('blocks_to_swap')).max, 40);
  const keys = new Set(window.getVisibleSections('moss-image-lora').flatMap(section => section.fields.map(field => field.key)));
  for (const key of ['qwen3', 'qwen3_max_token_length', 't5_max_token_length', 'noise_offset', 'sample_sampler', 'conv_dim']) {
    assert.equal(keys.has(key), false, key);
  }
  assert.equal(app._buildFormDefaults('anima-lora').network_module, 'networks.lora_anima');
  assert.equal(app._buildFormDefaults('krea2-lora').network_module, 'networks.lora_krea2');
});

test('MOSS preview and launch preserve explicit distribution defaults and disabling skip layers', () => {
  const { app } = application();
  Object.assign(app.form, {
    pretrained_model_name_or_path: './models/moss.safetensors',
    text_encoder: './models/qwen35.safetensors', vae: './models/flux2.safetensors',
    enable_preview: true, sample_uncond_skip_layers: '', train_text_embedder: true,
    rank_dropout: 0.1, positive_prompts: 'first line\nsecond line',
  });
  app.updateToml();
  assert.match(app.tomlRaw, /^sample_uncond_skip_layers = ""$/m);
  assert.match(app.tomlRaw, /^logit_mean = -1.09$/m);
  assert.match(app.tomlRaw, /^logit_std = 0.95$/m);
  assert.match(app.tomlRaw, /train_llm_adapter=true/);
  assert.match(app.tomlRaw, /rank_dropout=0.1/);
  const payload = app._collectTrainingPayload();
  assert.equal(payload.sample_uncond_skip_layers, '');
  assert.equal(payload.logit_mean, -1.09);
  assert.equal(payload.positive_prompts, 'first line\nsecond line');
  assert.equal(payload.train_text_embedder, true);
  assert.equal(payload.qwen3, undefined);
  assert.equal(payload.engine_id, undefined);
});
