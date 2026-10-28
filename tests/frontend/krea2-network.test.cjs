const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

function application(values = {}) {
  const { window: w } = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS,
    'training/toml', 'training/shape-preview', 'training/config-io'], {
    window: {}, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated schema'); },
  });
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin,
    w.trainingShapePreviewMixin, w.trainingConfigIoMixin, {
      t: key => key, _renderTomlPreview() {}, rebuildForm() {},
      _captureProfileDraft() {}, _persistProfileDrafts() {}, _persistProfileFieldSources() {},
      trainTypes: ['anima-lora', 'krea2-lora'].map(v => ({ v })),
    });
  app.form = { ...app._buildFormDefaults('krea2-lora'), model_train_type: 'krea2-lora', ...values };
  return { app, w };
}

test('Krea2 portable preview and import preserve targets, algorithm and FlashAttention', async () => {
  const { app } = application();
  await app._applyImportedFlatConfig({ model_train_type: 'krea2-lora', network_module: 'lycoris.kohya',
    lycoris_algo: 'loha', use_scalar: true, rank_dropout: 0.2, krea_target_mode: 'custom',
    krea_target_include: 'blocks\\.0\\..*\nfirst', krea_target_exclude: '.*\\.mlp\\..*',
    krea_attention_backend: 'flash_attn' });
  assert.deepEqual(Array.from(app._lastConfigImportIgnoredFields), []);
  assert.equal(app.form.network_module, 'lycoris.kohya');
  assert.equal(app.form.krea_attention_backend, 'flash_attn');
  const payload = app._collectTrainingPayload();
  assert.equal(payload.krea_target_include, 'blocks\\.0\\..*\nfirst');
  assert.match(app.tomlRaw, /network_module = "lycoris.kohya"/);
  assert.match(app.tomlRaw, /lycoris_algo = "loha"/);
  assert.match(app.tomlRaw, /krea_target_mode = "custom"/);
  assert.match(app.tomlRaw, /krea_attention_backend = "flash_attn"/);
  assert.doesNotMatch(app.tomlRaw, /^network_dropout =/m);
});

test('Krea optimizer controls and raw arguments survive profile import and payload collection', async () => {
  const { app, w } = application();
  const fields = w.getVisibleSections('krea2-lora').flatMap(s => s.fields);
  assert.equal(fields.find(f => f.key === 'optimizer_type').groups.flatMap(g => g.options).length, 21);
  for (const values of [
    { optimizer_type: 'pytorch_optimizer.SOAP', max_precondition_dim: 128, precondition_frequency: 3,
      shampoo_beta: 0.9, normalize_gradient: true },
    { optimizer_type: 'vendor.lora_muon.LoRA_Muon', gauge_rebalance: true, gauge_rebalance_interval: 2,
      inv_sqrt_eps: '1e-4' },
    { optimizer_type: 'bitsandbytes.optim.AdEMAMix8bit', ademamix_alpha: 3, ademamix_t_alpha: 0, ademamix_t_beta3: 500 },
    { optimizer_type: 'prodigyplus.ProdigyPlusScheduleFree', optimizer_args_custom: 'eps=None\nuse_adopt=True' },
  ]) {
    await app._applyImportedFlatConfig({ model_train_type: 'krea2-lora', ...values });
    assert.deepEqual(Array.from(app._lastConfigImportIgnoredFields), []);
    const payload = app._collectTrainingPayload();
    for (const [key, value] of Object.entries(values)) assert.equal(payload[key], value, key);
  }
});
