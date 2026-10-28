const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application(profile, values = {}) {
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-toml', 'dataset-repeat', 'training-config-io'], {
    window: {}, document: { getElementById: () => null }, btoa, TextEncoder, clearTimeout,
  });
  w.t = key => key;
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, w.datasetRepeatMixin, w.trainingConfigIoMixin, {
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

function watchAutoValues(app) {
  // Load the shipped Alpine reactivity/watch implementation without starting
  // its DOM scan. Microtasks are enabled before registering production watchers.
  const context = loadFrontend('vendor/alpine.min', {
    window: { Element: class {} },
    document: { createElement: () => ({}), addEventListener() {} },
    MutationObserver: class {}, queueMicrotask() {}, setTimeout, clearTimeout,
  });
  context.queueMicrotask = queueMicrotask;
  const alpine = context.window.Alpine;
  const triggered = new Set();
  app.form = alpine.reactive(app.form);
  app.$nextTick = alpine.nextTick;
  app.$watch = (path, callback) => alpine.watch(() => app.form[path.slice('form.'.length)], () => {
    triggered.add(path);
    callback();
  });
  app.setupAutoValueWatchers();
  return triggered;
}

test('optimizer drafts survive Alpine dependency watchers and later edits still trigger constraints', async () => {
  const app = application('anima-lora', { optimizer_type: 'AdamW8bit', adafactor_relative_step: false });
  app._profileFieldSources = {};
  app._replaceProfileFieldSources('anima-lora', app.formDefaults, ['optimizer_type', 'adafactor_relative_step']);
  const triggered = watchAutoValues(app);
  const settle = () => app.$nextTick();
  try {
    await settle();
    app.setField('optimizer_type', 'AdaFactor');
    // Resolve against restored relative_step=true before asynchronous watchers
    // can mask a one-pass reset using the old relative_step=false learning rate.
    assert.equal(app.form.learning_rate, '1e-4');
    assert.equal(app.form.adafactor_scale_parameter, true);
    await settle();
    assert.equal(app.form.learning_rate, '1e-4');
    app.setField('adafactor_relative_step', false);
    await settle();
    assert.ok(triggered.has('form.adafactor_relative_step'));
    assert.equal(app.form.adafactor_scale_parameter, false);
    app.setField('adafactor_warmup_init', true);
    app.setField('learning_rate', '0.123');
    app.setField('betas', '0.3, 0.4');
    app.setField('optimizer_args_custom', 'amsgrad=True');
    await settle();
    triggered.clear();

    app.setField('optimizer_type', 'AdamW8bit');
    await settle();
    assert.ok(triggered.has('form.optimizer_type'));
    assert.equal(app.form.learning_rate, '2e-5');
    assert.equal(app.form.betas, '0.9, 0.999');
    assert.equal(app.form.optimizer_args_custom, '');
    assert.equal(app.form.adafactor_relative_step, false);
    assert.equal(app.form.adafactor_scale_parameter, false);
    assert.equal(app.form.adafactor_warmup_init, false);

    // Individual reset uses the same effective default and provenance as a switch.
    app.setField('betas', '0.1, 0.2');
    app.resetField('betas');
    await settle();
    assert.equal(app.form.betas, '0.9, 0.999');
    assert.equal(app.formDefaults.betas, '0.9, 0.999');
    assert.equal(app._fieldSources.betas, 'auto');

    app.setField('lr_scheduler', 'cosine');
    app.setField('optimizer_type', 'AdaFactor');
    await settle();
    assert.equal(app.form.learning_rate, '0.123');
    assert.equal(app.form.betas, '0.3, 0.4');
    assert.equal(app.form.optimizer_args_custom, 'amsgrad=True');
    assert.equal(app.form.adafactor_relative_step, false);
    assert.equal(app.form.adafactor_scale_parameter, false);
    assert.equal(app.form.adafactor_warmup_init, true);
    assert.equal(app._fieldSources.learning_rate, 'user');
    assert.equal(app.form.lr_scheduler, 'cosine');
    app.setField('adafactor_relative_step', true);
    await settle();
    assert.equal(app.form.lr_scheduler, 'constant');
    assert.equal(app.form.lr_warmup_steps, 0);
  } finally {
    app._autoValueWatchers.forEach(dispose => dispose());
  }
});

test('first optimizer selection uses defaults and switching back restores each optimizer draft', () => {
  for (const profile of ['anima-lora', 'sdxl-lora', 'moss-image-lora', 'krea2-lora']) {
    const krea = profile === 'krea2-lora';
    const betaKey = krea ? 'krea_optimizer_betas' : 'betas';
    const decayKey = krea ? 'krea_optimizer_weight_decay' : 'weight_decay';
    const dKey = krea ? 'krea_prodigy_d_coef' : 'prodigy_d_coef';
    const stableKey = krea ? 'krea_prodigyplus_use_stableadamw' : 'prodigyplus_use_stableadamw';
    const app = application(profile, {
      optimizer_type: krea ? 'AdamW' : 'AdamW8bit', learning_rate: '0.123',
      [betaKey]: '0.3, 0.4', [decayKey]: 0.7, [dKey]: '3.0',
      optimizer_args_custom: 'custom_option=42', [stableKey]: false,
    });
    app._fieldSources = { learning_rate: 'user', [betaKey]: 'user', [decayKey]: 'user' };
    app.setField('optimizer_type', 'prodigyplus.ProdigyPlusScheduleFree');
    assert.equal(app.form.learning_rate, '1.0', profile);
    assert.equal(app.form[betaKey], '0.9, 0.99', profile);
    assert.equal(app.form[decayKey], 0, profile);
    assert.equal(app.form[dKey], '1.0', profile);
    assert.equal(app.form.optimizer_args_custom, '', profile);
    assert.equal(app.form[stableKey], true, profile);
    assert.equal(app._fieldSources[betaKey], 'auto', profile);
    const payload = app._collectTrainingPayload();
    assert.equal(payload[betaKey], '0.9, 0.99', profile);
    assert.equal(payload.optimizer_args_custom, undefined, profile);
    if (profile === 'moss-image-lora') assert.equal(app.form.text_encoder_lr, '');
    app.setField(betaKey, '0.1, 0.2');
    app.setField('optimizer_type', krea ? 'AdamW' : 'AdamW8bit');
    assert.equal(app.form[betaKey], '0.3, 0.4', profile);
    assert.equal(app.form.learning_rate, '0.123', profile);
    assert.equal(app.form[decayKey], 0.7, profile);
    assert.equal(app.form.optimizer_args_custom, 'custom_option=42', profile);
    assert.equal(app._fieldSources[betaKey], 'user', profile);
    app.setField('optimizer_type', 'prodigyplus.ProdigyPlusScheduleFree');
    assert.equal(app.form[betaKey], '0.1, 0.2', profile);
    assert.equal(app.form.learning_rate, '1.0', profile);
    assert.equal(app.form.optimizer_args_custom, '', profile);
  }
});

test('undoing an optimizer selection also resets its parameters', () => {
  const app = application('anima-lora', { optimizer_type: 'AdamW8bit', betas: '0.3, 0.4' });
  app.formHistory = [{ optimizer_type: 'prodigyplus.ProdigyPlusScheduleFree' }, { ...app.form }];
  app.formHistoryIdx = 1;
  app.undoField('optimizer_type');
  assert.equal(app.form.optimizer_type, 'prodigyplus.ProdigyPlusScheduleFree');
  assert.equal(app.form.betas, '0.9, 0.99');
});

test('restored Prodigy learning rates survive queued watchers and rapid switches', async () => {
  const app = application('anima-lora');
  watchAutoValues(app);
  try {
    app.setField('optimizer_type', 'Prodigy');
    await app.$nextTick();
    app.setField('learning_rate', '0.5');
    app.setField('unet_lr', '0.6');
    app.setField('optimizer_args_custom', 'd0=1e-5');
    await app.$nextTick();
    app.setField('optimizer_type', 'AdamW8bit');
    await app.$nextTick();
    app.setField('optimizer_type', 'Prodigy');
    app.setField('optimizer_type', 'AdamW8bit');
    app.setField('optimizer_type', 'Prodigy');
    await app.$nextTick();
    assert.equal(app.form.learning_rate, '0.5');
    assert.equal(app.form.unet_lr, '0.6');
    assert.equal(app.form.optimizer_args_custom, 'd0=1e-5');
    assert.equal(app._fieldSources.learning_rate, 'user');
    assert.equal(app._optimizerRestore, null);
    app.resetField('learning_rate');
    await app.$nextTick();
    assert.equal(app.form.learning_rate, '1.0');
    assert.equal(app._fieldSources.learning_rate, 'auto');
  } finally {
    app._autoValueWatchers.forEach(dispose => dispose());
  }
});

test('undoing an optimizer switch restores the saved edits', () => {
  const app = application('anima-lora', { optimizer_type: 'AdamW8bit', betas: '0.3, 0.4' });
  const before = { ...app.form };
  app.setField('optimizer_type', 'Prodigy');
  app.formHistory = [before, { ...app.form }];
  app.formHistoryIdx = 1;
  app.undoField('optimizer_type');
  assert.equal(app.form.optimizer_type, 'AdamW8bit');
  assert.equal(app.form.betas, '0.3, 0.4');
});

test('restoring fused optimizer settings still checks the current training constraints', () => {
  const optimizer = 'vendor.automagic_optimizer.integration.Automagic3';
  const app = application('anima-lora', { max_grad_norm: 0, gradient_accumulation_steps: 1 });
  app.setField('optimizer_type', optimizer);
  app.setField('automagic_fused', true);
  assert.equal(app.form.automagic_fused, true);
  app.setField('optimizer_type', 'AdamW8bit');
  app.setField('gradient_accumulation_steps', 2);
  app.setField('optimizer_type', optimizer);
  assert.equal(app.form.gradient_accumulation_steps, 2);
  assert.equal(app.form.automagic_fused, false);
  app.setField('gradient_accumulation_steps', 1);
  app.setField('automagic_fused', true);
  app.setField('optimizer_type', 'AdamW8bit');
  app.setField('gradient_accumulation_steps', 2);
  app.formHistory = [{ optimizer_type: optimizer }, { optimizer_type: 'AdamW8bit' }];
  app.formHistoryIdx = 1;
  app.undoField('optimizer_type');
  assert.equal(app.form.optimizer_type, optimizer);
  assert.equal(app.form.automagic_fused, false);
});

test('optimizer drafts are isolated by training profile', () => {
  const app = application('anima-lora', { betas: '0.3, 0.4' });
  app.setField('optimizer_type', 'Prodigy');
  const anima = { ...app.form };
  app.formDefaults = app._buildFormDefaults('sdxl-lora');
  app.form = { ...app.formDefaults, model_train_type: 'sdxl-lora', betas: '0.5, 0.6' };
  app.setField('optimizer_type', 'Prodigy');
  app.setField('optimizer_type', 'AdamW8bit');
  assert.equal(app.form.betas, '0.5, 0.6');
  app.formDefaults = app._buildFormDefaults('anima-lora');
  app.form = anima;
  app.setField('optimizer_type', 'AdamW8bit');
  assert.equal(app.form.betas, '0.3, 0.4');
});

test('resetting all parameters and importing a config discard old optimizer drafts', async () => {
  const app = application('anima-lora');
  const editProdigy = () => {
    app.setField('optimizer_type', 'Prodigy');
    app.setField('betas', '0.3, 0.4');
    app.setField('optimizer_type', 'AdamW8bit');
  };
  editProdigy();
  app.resetAllParams();
  app.setField('optimizer_type', 'Prodigy');
  assert.equal(app.form.betas, '0.9, 0.999');
  app.setField('optimizer_type', 'AdamW8bit');
  editProdigy();
  await app._applyImportedFlatConfig({ model_train_type: 'anima-lora', optimizer_type: 'AdamW8bit', betas: '0.6, 0.7' });
  app.setField('optimizer_type', 'Prodigy');
  assert.equal(app.form.betas, '0.9, 0.999');
  app.setField('optimizer_type', 'AdamW8bit');
  assert.equal(app.form.betas, '0.6, 0.7');
  assert.equal(app._fieldSources.betas, 'import');
});

test('selecting the current optimizer preserves its edited parameters', () => {
  const app = application('anima-lora', {
    optimizer_type: 'AdamW8bit', betas: '0.3, 0.4', optimizer_args_custom: 'amsgrad=True',
  });
  app.setField('optimizer_type', 'AdamW8bit');
  assert.equal(app.form.betas, '0.3, 0.4');
  assert.equal(app.form.optimizer_args_custom, 'amsgrad=True');
});

test('automatic optimizer fallback resets old optimizer parameters', () => {
  const app = application('anima-lora', {
    optimizer_type: 'vendor.lora_muon.LoRA_Muon', network_module: 'networks.lora_anima',
    learning_rate: '0.8', betas: '0.3, 0.4', momentum: 0.5,
  });
  app.setField('network_module', 'lycoris.kohya');
  assert.equal(app.form.optimizer_type, 'AdamW8bit');
  assert.equal(app.form.learning_rate, '2e-5');
  assert.equal(app.form.betas, '0.9, 0.999');
  assert.equal(app.form.momentum, 0.9);
  app.setField('optimizer_type', 'vendor.lora_muon.LoRA_Muon');
  assert.equal(app.form.learning_rate, '0.8');
  assert.equal(app.form.betas, '0.3, 0.4');
  assert.equal(app.form.momentum, 0.5);
});

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
  app.setField('gradient_checkpointing_cpu_offload', true);
  assert.equal(app.form.gradient_checkpointing, true);
  app.setField('gradient_checkpointing', false);
  assert.equal(app.form.gradient_checkpointing_cpu_offload, false);
  assert.equal(Object.hasOwn(app.form, 'cpu_offload_checkpointing'), false);
  assert.equal(Object.hasOwn(app.form, 'unsloth_offload_checkpointing'), false);
  app.setField('enable_krea_samples', true);
  app.setField('turbo_dit', './models/turbo.safetensors');
  assert.equal(app.formErrors.turbo_dit, 'field.kreaTurboBlockSwapConflict');
  app.setField('enable_krea_samples', false);
  assert.equal(app.formErrors.turbo_dit, null);
  app.setField('enable_krea_samples', true);
  app.setField('blocks_to_swap', 0);
  assert.equal(app.formErrors.turbo_dit, null);
});

test('all block-swap profiles enforce the same upload-only prerequisites on edits and restored drafts', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'krea2-lora']) {
    const app = application(profile, { gradient_checkpointing: false, blocks_to_swap: 3 });
    app.setField('block_swap_h2d_only', true);
    assert.equal(app.form.gradient_checkpointing, true);
    app.setField('gradient_checkpointing', false);
    assert.equal(app.form.block_swap_h2d_only, false);
    app.setField('block_swap_h2d_only', true);
    app.setField('blocks_to_swap', 0);
    assert.equal(app.form.block_swap_h2d_only, false);
    app.form.block_swap_h2d_only = true;
    app.form.gradient_checkpointing = false;
    app._enforceSharedTrainingUiConstraints();
    app._refreshTrainingOptionErrors();
    assert.equal(app.form.gradient_checkpointing, true);
    assert.equal(app.formErrors.block_swap_h2d_only, 'field.blockSwapH2dRequiresBlocks');
    app.setField('blocks_to_swap', 2);
    assert.equal(app.formErrors.block_swap_h2d_only, null);
  }
});

test('SDXL starts with its bundled VAE instead of inheriting a Qwen-Image VAE', () => {
  assert.equal(application('sdxl-lora').form.pretrained_model_name_or_path, '');
  assert.equal(application('anima-lora').form.pretrained_model_name_or_path, './models/anima-base-v1.0.safetensors');
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
