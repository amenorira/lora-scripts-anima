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
