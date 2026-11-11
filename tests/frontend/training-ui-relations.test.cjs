const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

function application(profile, values = {}) {
  const { window: w } = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS, 'training/toml', 'training/dataset-repeat', 'training/config-io'], {
    window: {}, document: { getElementById: () => null, querySelectorAll: () => [] }, btoa, TextEncoder, clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  });
  w.t = key => key;
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, w.datasetRepeatMixin, w.trainingConfigIoMixin, {
    t: key => key, toast() {}, pushHistory() {}, _persistProfileFieldSources() {},
    _persistProfileDrafts() {}, _scheduleProfileFieldWatchers() {},
    _allShowIfKeys: () => [], updateTomlDebounced() {}, updateToml() {},
    renderTrainingForm() {}, $nextTick: callback => callback(),
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
  const context = loadFrontend(['vendor/alpine.min', ...TRAINING_CORE_SCRIPTS], {
    window: { Element: class {} },
    document: { createElement: () => ({}), addEventListener() {} },
    MutationObserver: class {}, queueMicrotask() {}, setTimeout, clearTimeout,
  });
  context.queueMicrotask = queueMicrotask;
  const alpine = context.window.Alpine;
  const triggered = { calls: 0 };
  app.form = alpine.reactive(app.form);
  app.$nextTick = alpine.nextTick;
  app._watchTrainingState = (getter, callback) => context.window.trainingCoreMixin._watchTrainingState.call(app,
    getter, (...args) => { triggered.calls++; callback(...args); });
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
    assert.ok(triggered.calls > 0);
    assert.equal(app.form.adafactor_scale_parameter, false);
    app.setField('adafactor_warmup_init', true);
    app.setField('learning_rate', '0.123');
    app.setField('betas', '0.3, 0.4');
    app.setField('optimizer_args_custom', 'amsgrad=True');
    await settle();
    triggered.calls = 0;

    app.setField('optimizer_type', 'AdamW8bit');
    await settle();
    assert.ok(triggered.calls > 0);
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

test('partial checkpointing with H2D swap reports unsafe ring reuse without changing counts', () => {
  for (const profile of ['anima-lora', 'moss-image-lora']) {
    for (const [swapped, skipped, ring, h2d, blocked] of [
      [6, 4, 2, true, true], [8, 8, 2, true, true],
      [6, 0, 2, true, false], [6, 2, 2, true, false],
      [6, 3, 3, true, false], [6, 8, 6, true, false], [6, 8, 2, false, false],
    ]) {
      const app = application(profile, { gradient_checkpointing: true, blocks_to_swap: swapped,
        gradient_checkpointing_skip_blocks: skipped, block_swap_ring_size: ring, block_swap_h2d_only: h2d });
      const before = { ...app.form };
      const errors = app._checkpointOffloadErrors();
      assert.equal(errors.gradient_checkpointing_skip_blocks,
        blocked ? 'field.partialCheckpointH2dConflict' : undefined, JSON.stringify({ profile, swapped, skipped, ring, h2d }));
      assert.deepEqual(app.form, before);
    }
  }
});

test('H2D partial checkpointing guard uses effective checkpointing and leaves invalid counts to numeric validation', () => {
  const values = { gradient_checkpointing: false, blocks_to_swap: 6,
    gradient_checkpointing_skip_blocks: 4, block_swap_ring_size: 2, block_swap_h2d_only: true };
  assert.equal(application('moss-image-lora', values)._checkpointOffloadErrors().gradient_checkpointing_skip_blocks, undefined);
  for (const offload of ['cpu_offload_checkpointing', 'unsloth_offload_checkpointing']) {
    assert.equal(application('moss-image-lora', { ...values, [offload]: true })
      ._checkpointOffloadErrors().gradient_checkpointing_skip_blocks, 'field.partialCheckpointH2dConflict');
  }
  assert.equal(application('krea2-lora', { ...values, gradient_checkpointing: true })
    ._checkpointOffloadErrors().gradient_checkpointing_skip_blocks, undefined);
  for (const key of ['blocks_to_swap', 'gradient_checkpointing_skip_blocks', 'block_swap_ring_size']) {
    for (const value of [true, -1, 0.5, Infinity, 'invalid']) {
      assert.equal(application('moss-image-lora', { ...values, gradient_checkpointing: true, [key]: value })
        ._checkpointOffloadErrors().gradient_checkpointing_skip_blocks, undefined, key + ': ' + value);
    }
  }
});

test('Krea ConvRot disables FP8 immediately and remains consistent through reactive watchers', async () => {
  const app = application('krea2-lora', { fp8_base: true });
  const triggered = watchAutoValues(app);
  app.setupReadonlyWatchers();
  try {
    app.setField('convrot_int8', true);
    assert.equal(app.form.fp8_base, false);
    app.setField('fp8_base', true);
    assert.equal(app.form.fp8_base, false);
    await app.$nextTick();
    assert.ok(triggered.calls > 0);
    assert.equal(app.form.fp8_base, false);
    app.setField('convrot_int8', false);
    await app.$nextTick();
    app.setField('fp8_base', true);
    await app.$nextTick();
    assert.equal(app.form.fp8_base, true);
  } finally {
    app._autoValueWatchers.forEach(dispose => dispose());
    app._readonlyWatchers.forEach(dispose => dispose());
  }
  const restored = application('krea2-lora', { convrot_int8: true, fp8_base: true });
  restored._applyInitialAutoValues();
  assert.equal(restored.form.convrot_int8, true);
  assert.equal(restored.form.fp8_base, false);
  const moss = application('moss-image-lora', { fp8_base: true });
  moss.setField('convrot_int8', true);
  assert.equal(moss.form.fp8_base, true);
});

test('Krea imported preview conflicts retain editable paths and can be resolved in either direction', () => {
  for (const [clear, keep] of [['turbo_dit', 'turbo_lora'], ['turbo_lora', 'turbo_dit']]) {
    const app = application('krea2-lora', { enable_krea_samples: true,
      turbo_dit: './turbo.safetensors', turbo_lora: './turbo-lora.safetensors' });
    app._applyInitialAutoValues();
    const keptPath = app.form[keep];
    assert.ok(app.formErrors.turbo_lora);
    assert.equal(app._readonlyReason(app.findFieldDef(clear)), '');
    app.setField(clear, '');
    assert.equal(app.form[keep], keptPath);
    assert.equal(Object.keys(app._kreaOptionErrors()).length, 0);
  }
  const app = application('krea2-lora', { enable_krea_samples: true,
    convrot_int8: true, blocks_to_swap: 2, turbo_dit: './turbo.safetensors' });
  app._applyInitialAutoValues();
  app.setField('convrot_int8', false);
  app.setField('blocks_to_swap', 0);
  assert.equal(app.form.turbo_dit, './turbo.safetensors');
  assert.equal(Object.keys(app._kreaOptionErrors()).length, 0);
});
