const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo } = require('./helpers.cjs');

function application(profile = 'anima-lora') {
  const messages = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
  const t = key => key.split('.').reduce((value, part) => value?.[part], messages) || key;
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-core'], {
    window: { t }, document: {}, setTimeout, clearTimeout,
  });
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, { t, $nextTick() {} });
  app.form = { ...app._buildFormDefaults(profile), optimizer_type: 'Muon',
    pretrained_model_name_or_path: 'model.safetensors', vae: 'vae.safetensors', qwen3: 'qwen3.safetensors',
    text_encoder: 'text-encoder.safetensors',
    train_data_dir: 'train', output_dir: 'output', output_name: 'test', enable_preview: false };
  return app;
}

test('Muon form rejects momentum outside the EMA range for both supported profiles', () => {
  for (const profile of ['anima-lora', 'moss-image-lora']) {
    const app = application(profile);
    for (const momentum of [-0.1, 1, 1.1]) {
      app.form.muon_momentum = momentum;
      assert.equal(app.validateForm(), false);
      assert.ok(app.formErrors.muon_momentum);
    }
    for (const momentum of [0, 0.95, 0.9999999]) {
      app.form.muon_momentum = momentum;
      assert.equal(app.validateForm(), true, JSON.stringify(app.formErrors));
    }
    app.form.muon_momentum = 1.1;
    app.form.optimizer_type = 'AdamW';
    assert.equal(app.validateForm(), true, JSON.stringify(app.formErrors));
  }
});

test('Muon form identifies the incompatible LyCORIS option without changing it', () => {
  const app = application();
  app.form.network_module = 'lycoris.kohya';
  for (const algo of ['lora', 'loha', 'lokr']) {
    app.form.lycoris_algo = algo;
    for (const key of ['use_scalar', 'train_norm']) {
      app.form[key] = true;
      assert.equal(app.validateForm(), false);
      assert.match(app.formErrors[key], /Muon.*二维/);
      assert.equal(app.form[key], true);
      app.form[key] = false;
      assert.equal(app.validateForm(), true, JSON.stringify(app.formErrors));
    }
  }
  app.form.use_scalar = true;
  app.form.train_norm = true;
  app.form.optimizer_type = 'AdamW';
  assert.equal(app.validateForm(), true, JSON.stringify(app.formErrors));
  app.form.optimizer_type = 'Muon';
  app.form.network_module = 'networks.lora_anima';
  assert.equal(app.validateForm(), true, JSON.stringify(app.formErrors));
});
