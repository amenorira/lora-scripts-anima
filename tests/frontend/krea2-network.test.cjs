const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application(values = {}) {
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-core',
    'training-toml', 'training-shape-preview', 'training-config-io'], {
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

test('Krea2 exposes scoped LyCORIS controls and algorithm-specific payloads', () => {
  const { app, w } = application({ network_module: 'lycoris.kohya', lycoris_algo: 'lokr',
    full_matrix: true, lokr_factor: 8, rank_dropout: 0.2, module_dropout: 0.1 });
  const fields = w.getVisibleSections('krea2-lora').flatMap(s => s.fields);
  assert.deepEqual(Array.from(fields.find(f => f.key === 'lycoris_algo').options, o => o.v), ['lokr', 'loha']);
  assert.equal(fields.find(f => f.key === 'use_scalar').lycorisGroup, 'advanced');
  const moduleDropout = fields.find(f => f.key === 'module_dropout');
  const mainConditions = app._lycorisMainFormConditions(moduleDropout);
  assert.equal(mainConditions.showIf.every(c => app._evalShowIfCond(c)), false);
  let payload = app._collectTrainingPayload();
  assert.equal(payload.full_matrix, true);
  assert.equal(payload.lokr_factor, 8);
  assert.equal(payload.rank_dropout, undefined);
  assert.equal(payload.network_dropout, undefined);
  assert.equal(payload.module_dropout, 0.1);
  assert.equal(payload.conv_dim, undefined);
  app.form.lycoris_algo = 'loha';
  payload = app._collectTrainingPayload();
  assert.equal(payload.rank_dropout, 0.2);
  assert.equal(payload.full_matrix, undefined);
  assert.equal(payload.lokr_factor, undefined);
  assert.equal(payload.unbalanced_factorization, undefined);
  assert.match(app.lycorisConfigPreview(), /algo = "loha"/);
  assert.doesNotMatch(app.lycorisConfigPreview(), /full_matrix|factor =|enable_conv/);
});

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

test('FP8 enforces bypass and warns about DoRA; swap controls retain checkpoint dependency', () => {
  const { app } = application({ network_module: 'lycoris.kohya', fp8_base: true, dora_wd: true,
    block_swap_h2d_only: true, gradient_checkpointing: false });
  app._enforceSharedTrainingUiConstraints();
  assert.equal(app.form.bypass_mode, true);
  assert.equal(app.form.gradient_checkpointing, true);
  assert.equal(app._kreaOptionErrors().dora_wd, 'field.krea_dora_fp8Conflict');
});

test('FlashAttention warning reuses environment installation state', () => {
  const { app } = application({ krea_attention_backend: 'flash_attn' });
  const hint = app._getEnvHint('krea_attention_backend');
  assert.match(hint, /faStatus.*installed/);
  assert.match(hint, /environment.envHintFlashNotInstalled/);
});
