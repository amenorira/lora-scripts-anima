const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo } = require('./helpers.cjs');

function application(profile = 'anima-lora') {
  const messages = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
  const t = (key, fallback) => key.split('.').reduce((value, part) => value?.[part], messages) || fallback || key;
  const { window } = loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-toml', 'training-config-io'], {
    window: { t }, document: { getElementById: () => null, querySelectorAll: () => [] },
    fetch: async () => { throw new Error('Use generated schema'); },
    setTimeout, clearTimeout, btoa, TextEncoder,
  });
  const app = Object.assign({}, window.utilsMixin, window.trainingCoreMixin, window.trainingTomlMixin, window.trainingConfigIoMixin, {
    t, $nextTick: fn => fn(), _renderTomlPreview() {}, showConditionalFields() {}, rebuildForm() {},
    _persistProfileDrafts() {}, _persistProfileFieldSources() {},
  });
  app.form = app._buildFormDefaults(profile);
  app.formDefaults = { ...app.form };
  app._fieldSources = Object.fromEntries(Object.keys(app.form).map(key => [key, 'default']));
  const fields = window.getVisibleSections(profile).flatMap(section => section.fields);
  app._autoValueRules = fields.flatMap(field => (field.autoValue || []).map(rule => ({ target: field.key, ...rule })));
  app._applyInitialAutoValues();
  return app;
}

test('network dimension, scaling and upstream-backed numeric ranges are not arbitrarily capped', () => {
  for (const profile of ['anima-lora', 'sdxl-lora', 'moss-image-lora', 'krea2-lora']) {
    const app = application(profile);
    for (const key of ['network_dim', 'network_alpha']) {
      const field = app.findFieldDef(key);
      assert.ok(field, `${profile}: missing ${key}`);
      assert.equal(field.max, undefined, `${profile}: ${key} must not have an arbitrary hard cap`);
      assert.doesNotMatch(app.renderField(field), /\bmax="/, `${profile}: ${key} input must not render a max attribute`);

      app.setField(key, 512);
      assert.equal(app.form[key], 512, `${profile}: ${key} should preserve 512`);
      app.stepField(key, 1);
      assert.equal(app.form[key], 513, `${profile}: ${key} stepper should continue past 256`);
    }
    const alphaField = app.findFieldDef('network_alpha');
    assert.equal(alphaField.min, 1, `${profile}: Alpha minimum should be 1`);
    assert.equal(alphaField.step, 1, `${profile}: Alpha should step by 1`);
    app.setField('network_alpha', 0.5);
    assert.equal(app.form.network_alpha, 1, `${profile}: Alpha should be clamped to its minimum`);
    app.setField('network_alpha', 512);
    assert.equal(app.form.network_alpha, 512, `${profile}: Alpha should still accept values above 256`);
    app.validateForm();
    assert.equal(app.formErrors.network_dim, undefined);
    assert.equal(app.formErrors.network_alpha, undefined);
  }

  const app = application();
  const dropout = app.findFieldDef('network_dropout');
  assert.equal(dropout.max, 1);
  app.setField('network_dropout', 1);
  assert.equal(app.form.network_dropout, 1, 'dropout=1 is documented upstream as dropping all neurons');

  const sampleCfg = app.findFieldDef('sample_cfg');
  assert.equal(sampleCfg.max, undefined);
  assert.doesNotMatch(app.renderField(sampleCfg), /\bmax="/);
  app.setField('sample_cfg', 50);
  assert.equal(app.form.sample_cfg, 50, 'sample CFG should not stop at 30');

  const muonSteps = app.findFieldDef('muon_ns_steps');
  assert.equal(muonSteps.max, undefined);
  assert.doesNotMatch(app.renderField(muonSteps), /\bmax="/);
  app.setField('muon_ns_steps', 100);
  assert.equal(app.form.muon_ns_steps, 100, 'Muon NS iterations should not stop at 99');
});
