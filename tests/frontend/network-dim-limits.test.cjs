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

test('network_dim and network_alpha accept ranks above 256 for every training profile', () => {
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
    app.validateForm();
    assert.equal(app.formErrors.network_dim, undefined);
    assert.equal(app.formErrors.network_alpha, undefined);
  }
});
