const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, TRAINING_CORE_SCRIPTS } = require('./helpers.cjs');

function model(profile, overrides = {}) {
  const context = loadFrontend(['shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS], {
    window: {}, document: { getElementById: () => null },
  });
  const app = Object.assign({}, context.window.utilsMixin, context.window.trainingCoreMixin, {
    form: { model_train_type: profile, optimizer_type: 'AdamW', foreach: 'auto',
      adamw_fused: 'auto', krea_adamw_fused: 'auto', ...overrides },
    t: key => key,
  });
  return app;
}

test('AdamW menus disable incompatible enable options in both directions for every profile', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora']) {
    const fused = profile === 'krea2-lora' ? 'krea_adamw_fused' : 'adamw_fused';
    const app = model(profile, { foreach: 'true' });
    const options = key => app._trainingSelectConfig(app.findFieldDef(key)).options;
    assert.equal(options(fused).find(option => option.v === 'true').disabled, true);
    assert.equal(options(fused).find(option => option.v === 'false').disabled, undefined);
    app.form.foreach = 'auto';
    assert.equal(options(fused).find(option => option.v === 'true').disabled, undefined);
    app.form[fused] = 'true';
    assert.equal(options('foreach').find(option => option.v === 'true').disabled, true);
    // Imported conflicts remain visible and can be repaired without changing stored values.
    app.form.foreach = 'true';
    app._refreshTrainingOptionErrors();
    assert.equal(app.formErrors.foreach, 'field.adamwFusedForeachConflict');
    assert.equal(app.formErrors[fused], 'field.adamwFusedForeachConflict');
    assert.equal(app.form.foreach, 'true');
    assert.equal(app.form[fused], 'true');
    app.form.foreach = 'false';
    app._refreshTrainingOptionErrors();
    assert.equal(app.formErrors.foreach, null);
    assert.equal(app.formErrors[fused], null);
  }
});

test('custom optimizer arguments follow backend precedence and show differentiable conflicts immediately', () => {
  for (const profile of ['anima-lora', 'krea2-lora']) {
    const fused = profile === 'krea2-lora' ? 'krea_adamw_fused' : 'adamw_fused';
    const app = model(profile, { optimizer_args_custom: 'fused=True\nforeach=False' });
    assert.equal(app._adamwOptionDisabledReason('foreach', 'true'), 'field.adamwFusedForeachConflict');
    app.form[fused] = 'false';
    assert.equal(app._adamwOptionDisabledReason('foreach', 'true'), '');
    app.form.optimizer_args_custom = 'differentiable=True';
    assert.equal(app._adamwOptionDisabledReason(fused, 'true'), 'field.adamwFusedDifferentiableConflict');
    app.form[fused] = 'true';
    app._refreshTrainingOptionErrors();
    assert.equal(app.formErrors.optimizer_args_custom, 'field.adamwFusedDifferentiableConflict');
    app.form.optimizer_type = 'pytorch_optimizer.CAME';
    assert.deepEqual(Object.keys(app._adamwOptionErrors()), []);
    assert.equal(app._adamwOptionDisabledReason('foreach', 'true'), '');
  }
});

test('Auto cannot restore a conflicting custom True while Disabled remains available', () => {
  for (const profile of ['anima-lora', 'krea2-lora']) {
    const fused = profile === 'krea2-lora' ? 'krea_adamw_fused' : 'adamw_fused';
    for (const [key, other, argument] of [[fused, 'foreach', 'fused'], ['foreach', fused, 'foreach']]) {
      const app = model(profile, { [key]: 'false', [other]: 'true',
        optimizer_args_custom: `${argument}=((True)) # Python literal` });
      assert.equal(app._adamwOptionDisabledReason(key, 'auto'), 'field.adamwFusedForeachConflict');
      assert.equal(app._adamwOptionDisabledReason(key, 'false'), '');
      assert.deepEqual(Object.keys(app._adamwOptionErrors()), []);
    }
  }
});

test('dynamic disabled options block mouse selection and are excluded from keyboard navigation', () => {
  let factory;
  loadFrontend(['shared/anima-select'], {
    window: {},
    document: { addEventListener: (_event, callback) => callback() },
    Alpine: { data: (_name, value) => { factory = value; } },
  });
  const app = model('anima-lora', { foreach: 'true' });
  const field = app.findFieldDef('adamw_fused');
  const select = factory(() => app._trainingSelectConfig(field), 'auto');
  select.select('true');
  assert.equal(select.value, 'auto');
  assert.deepEqual(Array.from(select._enabledIndices()), [0, 2]);
  app.form.foreach = 'false';
  assert.deepEqual(Array.from(select._enabledIndices()), [0, 1, 2]);
});
