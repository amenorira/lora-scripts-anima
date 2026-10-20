const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application(profile, values = {}) {
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-core', 'dataset-repeat', 'training-config-io'], {
    window: {}, document: { getElementById: () => null }, btoa, TextEncoder,
  });
  w.t = key => key;
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.datasetRepeatMixin, w.trainingConfigIoMixin, {
    t: key => key, toast() {}, pushHistory() {}, _persistProfileFieldSources() {},
    _persistProfileDrafts() {}, _scheduleProfileFieldWatchers() {},
    _allShowIfKeys: () => [], updateTomlDebounced() {}, updateToml() {},
    renderTrainingForm() {}, updateReadonlyStates() {}, $nextTick: callback => callback(),
  });
  app.formDefaults = app._buildFormDefaults(profile);
  app.form = { ...app.formDefaults, model_train_type: profile, ...values };
  app.formErrors = {};
  app.currentRoute = 'train-basic';
  app._activeTrainType = profile;
  return app;
}

test('training text encoders disables both caches without reversing the requested training scope', () => {
  for (const profile of ['anima-lora', 'sdxl-lora']) {
    for (const [key, value] of [['network_train_text_encoder_only', true], ['network_train_unet_only', false]]) {
      const app = application(profile, { cache_text_encoder_outputs: true, cache_text_encoder_outputs_to_disk: true });
      app.setField(key, value);
      assert.equal(app.form[key], value);
      assert.equal(app.form.cache_text_encoder_outputs, false);
      assert.equal(app.form.cache_text_encoder_outputs_to_disk, false);
    }
  }
});

test('epoch caption dropout disables and prevents re-enabling both text caches for every sd-scripts profile', () => {
  for (const profile of ['anima-lora', 'sdxl-lora', 'moss-image-lora']) {
    const app = application(profile, { cache_text_encoder_outputs: true, cache_text_encoder_outputs_to_disk: true });
    app.setField('caption_dropout_every_n_epochs', 2);
    assert.equal(app.form.cache_text_encoder_outputs, false);
    assert.equal(app.form.cache_text_encoder_outputs_to_disk, false);
    app.setField('cache_text_encoder_outputs', true);
    app.setField('cache_text_encoder_outputs_to_disk', true);
    assert.equal(app.form.cache_text_encoder_outputs, false);
    assert.equal(app.form.cache_text_encoder_outputs_to_disk, false);
  }
});

test('xformers always enables split attention and fullgraph conflicts update immediately', () => {
  for (const profile of ['anima-lora', 'moss-image-lora']) {
    const app = application(profile, { split_attn: false, compile: true, compile_fullgraph: true });
    app.setField('attn_mode', 'xformers');
    assert.equal(app.form.split_attn, true);
    assert.ok(app.formErrors.compile_fullgraph);
    app.setField('split_attn', false);
    assert.equal(app.form.split_attn, true);
    app.setField('attn_mode', 'torch');
    app.setField('split_attn', false);
    assert.equal(app.formErrors.compile_fullgraph, null);
  }
});

test('normalizing restored drafts keeps training scopes and attention dependencies consistent', () => {
  const app = application('anima-lora', {
    network_train_unet_only: false, network_train_text_encoder_only: true,
    cache_text_encoder_outputs: true, cache_text_encoder_outputs_to_disk: true,
    attn_mode: 'xformers', split_attn: false,
  });
  app._enforceSharedTrainingUiConstraints();
  assert.equal(app.form.network_train_text_encoder_only, true);
  assert.equal(app.form.cache_text_encoder_outputs, false);
  assert.equal(app.form.cache_text_encoder_outputs_to_disk, false);
  assert.equal(app.form.split_attn, true);
  const krea = application('krea2-lora', { block_swap_h2d_only: true, gradient_checkpointing: false });
  krea._enforceSharedTrainingUiConstraints();
  assert.equal(krea.form.gradient_checkpointing, true);
});

test('Krea hides sd-scripts dataset editing and subset offset controls, including preview subsets', () => {
  const app = application('krea2-lora', { timestep_sampling: 'shift' });
  app.stepEstimate = { subsets: [{ name: '10_face', is_reg: false }] };
  assert.equal(app.renderDatasetSubsets(), '');
  assert.equal(app.renderSubsetTimestepOffsets(), '');
  assert.equal(app.timestepOffsetSupported(), false);
  assert.equal(app.timestepOffsetSubsets().length, 0);
  assert.ok(application('anima-lora').renderDatasetSubsets());
});

test('Krea upload-only swapping follows gradient checkpointing and Turbo conflicts stay on their field', () => {
  const app = application('krea2-lora', { gradient_checkpointing: false, blocks_to_swap: 2 });
  app.setField('block_swap_h2d_only', true);
  assert.equal(app.form.gradient_checkpointing, true);
  app.setField('gradient_checkpointing', false);
  assert.equal(app.form.block_swap_h2d_only, false);
  app.setField('enable_krea_samples', true);
  app.setField('turbo_dit', './models/turbo.safetensors');
  assert.equal(app.formErrors.turbo_dit, 'field.kreaTurboBlockSwapConflict');
  app.setField('enable_krea_samples', false);
  assert.equal(app.formErrors.turbo_dit, null);
  app.setField('enable_krea_samples', true);
  app.setField('blocks_to_swap', 0);
  assert.equal(app.formErrors.turbo_dit, null);
});

test('SDXL starts with its bundled VAE instead of inheriting a Qwen-Image VAE', () => {
  assert.equal(application('sdxl-lora').form.vae, '');
  assert.equal(application('anima-lora').form.vae, './models/qwen_image_vae.safetensors');
});

test('SDXL attention switches use the latest selection and restored conflicts match engine precedence', () => {
  const app = application('sdxl-lora', { xformers: true, sdpa: false });
  app.setField('sdpa', true);
  assert.equal(app.form.sdpa, true);
  assert.equal(app.form.xformers, false);
  app.setField('xformers', true);
  assert.equal(app.form.xformers, true);
  assert.equal(app.form.sdpa, false);
  app.form.sdpa = true;
  app._enforceSharedTrainingUiConstraints();
  assert.equal(app.form.xformers, true);
  assert.equal(app.form.sdpa, false);
});

test('active option conflicts are retranslated without validating unrelated fields on locale changes', () => {
  const app = application('krea2-lora', { blocks_to_swap: 2, enable_krea_samples: true, turbo_dit: './turbo.safetensors' });
  app.formErrors = { output_dir: 'existing server error' };
  app.t = key => `en:${key}`;
  app._refreshTrainingOptionErrors();
  assert.equal(app.formErrors.turbo_dit, 'en:field.kreaTurboBlockSwapConflict');
  app.t = key => `ja:${key}`;
  app._refreshTrainingOptionErrors();
  assert.equal(app.formErrors.turbo_dit, 'ja:field.kreaTurboBlockSwapConflict');
  assert.equal(app.formErrors.output_dir, 'existing server error');
});

test('importing a valid Krea configuration clears the previous Turbo conflict through the real rebuild path', async () => {
  const app = application('krea2-lora', { blocks_to_swap: 2, enable_krea_samples: true, turbo_dit: './turbo.safetensors' });
  app._applyInitialAutoValues();
  assert.equal(app.formErrors.turbo_dit, 'field.kreaTurboBlockSwapConflict');
  app.formErrors.output_dir = 'server: output directory is not writable';

  await app._applyImportedFlatConfig({
    model_train_type: 'krea2-lora', enable_krea_samples: true,
    turbo_dit: './turbo.safetensors', blocks_to_swap: 0,
  });
  assert.equal(Object.keys(app._kreaOptionErrors()).length, 0);
  assert.equal(app.formErrors.turbo_dit, null);
  assert.equal(app.formErrors.output_dir, 'server: output directory is not writable');
});

test('resetting parameters and switching models remove expired conflicts and restore active draft conflicts', () => {
  const app = application('krea2-lora', { blocks_to_swap: 2, enable_krea_samples: true, turbo_dit: './turbo.safetensors' });
  app._applyInitialAutoValues();
  app.switchTrainType('anima-lora');
  assert.equal(app.formErrors.turbo_dit, null);
  app.switchTrainType('krea2-lora');
  assert.equal(app.formErrors.turbo_dit, 'field.kreaTurboBlockSwapConflict');
  app.resetAllParams();
  assert.equal(app.formErrors.turbo_dit, null);

  app.setField('enable_krea_samples', true);
  app.setField('turbo_dit', './turbo.safetensors');
  app.setField('blocks_to_swap', 2);
  assert.equal(app.formErrors.turbo_dit, 'field.kreaTurboBlockSwapConflict');
  app.resetField('blocks_to_swap');
  assert.equal(app.formErrors.turbo_dit, null);
});

test('refresh clears all resolved option checks while preserving unrelated server errors on the same field', () => {
  const cases = [
    ['anima-lora', { cpu_offload_checkpointing: true, unsloth_offload_checkpointing: true },
      { unsloth_offload_checkpointing: false }, 'unsloth_offload_checkpointing'],
    ['moss-image-lora', { convrot_int8: true, base_weights: './lora.safetensors' },
      { base_weights: '' }, 'base_weights'],
    ['krea2-lora', { enable_krea_samples: true, turbo_dit: './turbo.safetensors', blocks_to_swap: 2 },
      { blocks_to_swap: 0 }, 'turbo_dit'],
    ['anima-lora', { optimizer_type: 'Muon', muon_momentum: 1 },
      { muon_momentum: 0.95 }, 'muon_momentum'],
  ];
  for (const [profile, conflicting, valid, field] of cases) {
    const app = application(profile, conflicting);
    app._refreshTrainingOptionErrors();
    assert.ok(app.formErrors[field], field);
    Object.assign(app.form, valid);
    app._refreshTrainingOptionErrors();
    assert.equal(app.formErrors[field], null, field);

    Object.assign(app.form, conflicting);
    app._refreshTrainingOptionErrors();
    app.formErrors[field] = 'server: model file is unavailable';
    app.formErrors.output_dir = 'server: output directory is not writable';
    Object.assign(app.form, valid);
    app._refreshTrainingOptionErrors();
    assert.equal(app.formErrors[field], 'server: model file is unavailable', field);
    assert.equal(app.formErrors.output_dir, 'server: output directory is not writable');
  }
  const moss = application('moss-image-lora');
  moss.formErrors.base_weights = 'server: weight file is unavailable';
  moss.setField('seed', 42);
  assert.equal(moss.formErrors.base_weights, 'server: weight file is unavailable');
});
