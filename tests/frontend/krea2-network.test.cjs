const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application(values = {}) {
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-field-relations', 'training-core',
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

test('Krea2 compute choices and legacy imports stay within supported runtime modes', async () => {
  const { app, w } = application();
  const fields = w.getVisibleSections('krea2-lora').flatMap(s => s.fields);
  assert.deepEqual(Array.from(fields.find(f => f.key === 'mixed_precision').options, o => o.v), ['bf16', 'fp16']);
  assert.deepEqual(Array.from(fields.find(f => f.key === 'krea_attention_backend').options, o => o.v),
    ['sdpa', 'flash_attn', 'xformers']);
  const anima = w.getVisibleSections('anima-lora').flatMap(s => s.fields);
  assert.ok(anima.find(f => f.key === 'mixed_precision').options.some(o => o.v === 'no'));

  await app._applyImportedFlatConfig({ model_train_type: 'krea2-lora',
    mixed_precision: 'no', krea_attention_backend: 'sage_attn' });
  const payload = app._collectTrainingPayload();
  assert.equal(payload.mixed_precision, 'bf16');
  assert.equal(payload.krea_attention_backend, 'sdpa');
  assert.match(app.tomlRaw, /^mixed_precision = "bf16"/m);
  assert.match(app.tomlRaw, /^krea_attention_backend = "sdpa"/m);
});

test('Krea2 exposes scoped LyCORIS controls and algorithm-specific payloads', () => {
  const { app, w } = application({ network_module: 'lycoris.kohya', lycoris_algo: 'lokr',
    full_matrix: true, lokr_factor: 8, rank_dropout: 0.2, module_dropout: 0.1 });
  const fields = w.getVisibleSections('krea2-lora').flatMap(s => s.fields);
  assert.deepEqual(Array.from(fields.find(f => f.key === 'lycoris_algo').options, o => o.v), ['lora', 'loha', 'lokr']);
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

test('Krea2 preserves the no-upscale cache setting in payloads when bucketing is disabled', () => {
  for (const bucket_no_upscale of [false, true]) {
    const { app } = application({ enable_bucket: false, bucket_no_upscale });
    const payload = app._collectTrainingPayload();
    assert.equal(payload.enable_bucket, false);
    assert.equal(payload.bucket_no_upscale, bucket_no_upscale);
  }
});

test('Krea2 cache and optimization controls survive portable import and export', async () => {
  const { app } = application();
  const settings = { model_train_type: 'krea2-lora', network_module: 'networks.lora_krea2',
    enable_loraplus: true, loraplus_lr_ratio: 3, optimizer_type: 'AdamW', krea_adamw_fused: 'true',
    krea_split_attn: 'true', krea_latent_cache_device: 'cpu', krea_text_cache_device: 'cuda',
    krea_latent_cache_batch_size: 2, text_cache_batch_size: 3, krea_cache_num_workers: 4,
    krea_cache_reuse: false, krea_cache_vae_tiling: true };
  await app._applyImportedFlatConfig(settings);
  assert.deepEqual(Array.from(app._lastConfigImportIgnoredFields), []);
  const payload = app._collectTrainingPayload();
  for (const [key, value] of Object.entries(settings)) {
    assert.equal(payload[key], value, key);
    if (key !== 'model_train_type') assert.match(app.tomlRaw, new RegExp(`^${key} = `, 'm'), key);
  }
  app.form.dim_from_weights = true;
  assert.equal(app._kreaOptionErrors().dim_from_weights, 'field.krea_loraplus_structureConflict');
});

test('legacy Krea LoRA+ arguments become visible controls when loading drafts or imports', async () => {
  const { app } = application();
  const legacy = { model_train_type: 'krea2-lora', network_module: 'networks.lora_krea2',
    network_args_custom: 'loraplus_lr_ratio=3\nrank_dropout=0.1' };
  for (const form of [app._profileFormFromDraft('krea2-lora', app._buildFormDefaults('krea2-lora'), legacy),
    (await app._applyImportedFlatConfig(legacy), app.form)]) {
    assert.equal(form.enable_loraplus, true);
    assert.equal(form.loraplus_lr_ratio, 3);
    assert.equal(form.network_args_custom, 'rank_dropout=0.1');
  }
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

test('Krea LoCon exposes dropout and LoRA+ while rejecting incompatible paired updates', () => {
  const { app } = application({ network_module: 'lycoris.kohya', lycoris_algo: 'lora', dropout: 0.2,
    enable_loraplus: true, loraplus_lr_ratio: 3 });
  app._enforceSharedTrainingUiConstraints();
  let payload = app._collectTrainingPayload();
  for (const [key, value] of Object.entries({ dropout: 0.2, enable_loraplus: true, loraplus_lr_ratio: 3, bypass_mode: true })) {
    assert.equal(payload[key], value, key);
  }
  app.form.dora_wd = true;
  assert.equal(app._kreaOptionErrors().dropout, 'field.krea_locon_dropoutHint');
  app.form.optimizer_type = 'vendor.lora_muon.LoRA_Muon';
  assert.equal(app._kreaOptionErrors().optimizer_type, 'field.krea_paired_optimizerHint');
  app.form.lycoris_algo = 'lokr';
  payload = app._collectTrainingPayload();
  assert.equal(payload.dropout, undefined);
  assert.equal(payload.enable_loraplus, undefined);
});
