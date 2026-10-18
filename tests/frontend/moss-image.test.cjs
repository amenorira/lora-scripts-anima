const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo } = require('./helpers.cjs');

function application() {
  const messages = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
  const t = (key, fallback) => key.split('.').reduce((value, part) => value?.[part], messages) || fallback || key;
  const context = loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-shape-preview', 'training-toml', 'training-config-io'], {
    window: { t }, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated schema'); },
    setTimeout, clearTimeout,
    btoa, TextEncoder,
  });
  const w = context.window;
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingShapePreviewMixin, w.trainingTomlMixin, w.trainingConfigIoMixin, {
    t, _renderTomlPreview() {},
  });
  app.form = app._buildFormDefaults('moss-image-lora');
  return { app, window: w };
}

test('MOSS discards unsupported saved algorithms across profile switches', () => {
  const { app } = application();
  Object.assign(app, {
    formDefaults: {}, _profileFormDrafts: {}, _profileFieldSources: {},
    _fieldSources: {}, _activeTrainType: 'moss-image-lora', currentRoute: '',
    renderTrainingForm() {}, setupAutoValueWatchers() {}, setupShowIfWatchers() {}, setupReadonlyWatchers() {},
    updateToml() {}, rebuildForm() {}, toast() {}, $nextTick: fn => fn(),
  });
  for (const module of ['networks.loha', 'networks.lokr']) {
    app.form.network_module = module;
    app.switchTrainType('anima-lora');
    assert.equal(app.form.network_module, 'networks.lora_anima');
    app.switchTrainType('moss-image-lora');
    assert.equal(app.form.network_module, 'networks.lora_generic');
  }
});

test('MOSS only offers supported LoRA and places backward mode descriptions inside options', () => {
  const { app } = application();
  const options = html => Buffer.from(html.match(/animaSelect\('([^']+)'/)[1], 'base64').toString('utf8');
  const network = app.renderField(app.findFieldDef('network_module'));
  assert.match(options(network), /networks.lora_generic/);
  assert.doesNotMatch(options(network), /networks\.(loha|lokr)/);
  const backward = app.renderField(app.findFieldDef('convrot_int8_bwd'));
  assert.match(options(backward), /梯度精度更高/);
  assert.match(options(backward), /需要 CUDA 和 Triton/);
  assert.match(backward, /anima-select-option-desc/);
  for (const profile of ['anima-lora', 'sdxl-lora']) {
    app.form = app._buildFormDefaults(profile);
    const html = app.renderField(app.findFieldDef('network_module'));
    assert.match(options(html), /networks.loha/);
    assert.match(options(html), /networks.lokr/);
    assert.match(options(html), /lycoris.kohya/);
    assert.doesNotMatch(options(html), /networks.lora_generic/);
  }
});

test('MOSS multiline prompts stay one sample and raw aliases cannot override the preview switch', () => {
  const { app } = application();
  app.form.network_args_custom = 'train_text_embedder=true\ntrain_llm_adapter=true';
  app.updateToml();
  assert.doesNotMatch(app.tomlRaw, /train_text_embedder=true|train_llm_adapter=true/);
  assert.match(app.tomlRaw, /train_llm_adapter=false/);
  assert.equal(app._positivePromptCountHint('positive_prompts'), '');
  app.form.model_train_type = 'anima-lora';
  assert.match(app._positivePromptCountHint('positive_prompts'), /samplePromptsCountHint/);
});

test('MOSS starts with isolated models, native LoRA and its own training and sampling defaults', () => {
  const { app, window } = application();
  assert.ok(app.trainTypes.some(type => type.v === 'moss-image-lora'));
  assert.equal(app.form.pretrained_model_name_or_path, '');
  assert.equal(app.form.vae, '');
  assert.equal(app.form.text_encoder, '');
  assert.equal(app.form.network_module, 'networks.lora_generic');
  assert.equal(app.form.moss_max_token_length, 4096);
  assert.equal(app.form.gradient_checkpointing, true);
  assert.equal(app.form.timestep_sampling, 'sigma');
  assert.equal(app.form.logit_mean, -1.09);
  assert.equal(app.form.logit_std, 0.95);
  assert.equal(app.form.discrete_flow_shift, 1);
  assert.equal(app.form.weighting_scheme, 'logit_normal');
  assert.equal(app.form.network_dim, 16);
  assert.equal(app.form.network_alpha, 16);
  assert.equal(app.form.enable_multiline_caption, true);
  assert.equal(app.form.train_text_embedder, false);
  assert.equal(app.form.convrot_int8, false);
  assert.equal(app.form.convrot_int8_text_encoder, false);
  assert.equal(app.form.convrot_int8_bwd, 'bf16');
  assert.equal(app.form.sample_uncond_skip_layers, '22');
  assert.equal(app.form.sample_steps, 50);
  assert.equal(app.form.sample_cfg, 3);
  assert.equal(app.form.sample_flow_shift, 5);
  assert.equal(app._numberConstraints(app.findFieldDef('blocks_to_swap')).max, 40);
  const keys = new Set(window.getVisibleSections('moss-image-lora').flatMap(section => section.fields.map(field => field.key)));
  for (const key of ['qwen3', 'qwen3_max_token_length', 't5_max_token_length', 'noise_offset', 'sample_sampler', 'conv_dim']) {
    assert.equal(keys.has(key), false, key);
  }
  assert.equal(app._buildFormDefaults('anima-lora').network_module, 'networks.lora_anima');
  assert.equal(app._buildFormDefaults('krea2-lora').network_module, 'networks.lora_krea2');
});

test('MOSS preview and launch preserve explicit distribution defaults and disabling skip layers', () => {
  const { app } = application();
  Object.assign(app.form, {
    pretrained_model_name_or_path: './models/moss.safetensors',
    text_encoder: './models/qwen35.safetensors', vae: './models/flux2.safetensors',
    enable_preview: true, sample_uncond_skip_layers: '', train_text_embedder: true,
    rank_dropout: 0.1, positive_prompts: 'first line\nsecond line',
  });
  app.updateToml();
  assert.match(app.tomlRaw, /^sample_uncond_skip_layers = ""$/m);
  assert.match(app.tomlRaw, /^logit_mean = -1.09$/m);
  assert.match(app.tomlRaw, /^logit_std = 0.95$/m);
  assert.match(app.tomlRaw, /train_llm_adapter=true/);
  assert.match(app.tomlRaw, /rank_dropout=0.1/);
  const payload = app._collectTrainingPayload();
  assert.equal(payload.sample_uncond_skip_layers, '');
  assert.equal(payload.logit_mean, -1.09);
  assert.equal(payload.positive_prompts, 'first line\nsecond line');
  assert.equal(payload.train_text_embedder, true);
  assert.equal(payload.qwen3, undefined);
  assert.equal(payload.engine_id, undefined);
});

test('MOSS validation rejects LoRA pre-merging into either INT8 model without changing the form', () => {
  const { app } = application();
  Object.assign(app.form, { pretrained_model_name_or_path: 'dit.safetensors',
    text_encoder: 'te.safetensors', vae: 'vae.safetensors', base_weights: 'prior.safetensors' });
  app.$nextTick = () => {};
  for (const flag of ['convrot_int8', 'convrot_int8_text_encoder']) {
    app.form[flag] = true;
    assert.equal(app.validateForm(), false);
    assert.match(app.formErrors.base_weights, /ConvRot INT8/);
    assert.equal(app.form.base_weights, 'prior.safetensors');
    app.form[flag] = false;
  }
  assert.equal(app.validateForm(), true);
  app.form.convrot_int8 = true;
  app.form.base_weights = '';
  assert.equal(app.validateForm(), true);
  app.form.model_train_type = 'anima-lora';
  app.form.base_weights = 'prior.safetensors';
  assert.deepEqual(Object.keys(app._mossOptionErrors()), []);
});

test('Huber defaults are exported explicitly instead of falling back to the native SNR schedule', () => {
  const { app } = application();
  for (const profile of ['moss-image-lora', 'anima-lora', 'sdxl-lora']) {
    app.form = app._buildFormDefaults(profile);
    for (const loss of ['huber', 'smooth_l1']) {
      app.form.loss_type = loss;
      app.updateToml();
      assert.match(app.tomlRaw, /^huber_schedule = "exponential"$/m);
      assert.equal(app._collectTrainingPayload().huber_schedule, 'exponential');
    }
  }
});

test('MOSS fullgraph validation preserves compatible compilation choices', () => {
  const { app } = application();
  Object.assign(app.form, { pretrained_model_name_or_path: 'dit.safetensors',
    text_encoder: 'te.safetensors', vae: 'vae.safetensors', compile: true, compile_fullgraph: true });
  app.$nextTick = () => {};
  for (const options of [{ blocks_to_swap: 1 }, { convrot_int8: true }, { split_attn: true }, { attn_mode: 'xformers' }]) {
    const original = { ...app.form };
    Object.assign(app.form, options);
    assert.equal(app.validateForm(), false);
    assert.match(app.formErrors.compile_fullgraph, /完整图编译/);
    assert.equal(app.form.compile_fullgraph, true);
    app.form.compile_fullgraph = false;
    assert.equal(app.validateForm(), true);
    assert.equal(app.form.compile, true);
    app.form = original;
  }
  app.form.convrot_int8_text_encoder = true;
  assert.equal(app.validateForm(), true);
});

test('restored native MOSS arguments survive form import and the next launch payload', async () => {
  const { app } = application();
  Object.assign(app, { rebuildForm() {}, _persistProfileDrafts() {}, _persistProfileFieldSources() {} });
  await app._applyImportedFlatConfig({ model_train_type: 'moss-image-lora',
    train_text_embedder: true, rank_dropout: 0.2, enable_loraplus: true, loraplus_lr_ratio: 4,
    network_args_custom: 'network_reg_dims=layers.*=8' });
  assert.match(app.tomlRaw, /train_llm_adapter=true/);
  assert.match(app.tomlRaw, /rank_dropout=0.2/);
  assert.match(app.tomlRaw, /loraplus_lr_ratio=4/);
  assert.match(app.tomlRaw, /network_reg_dims=layers\.\*=8/);
  const payload = app._collectTrainingPayload();
  assert.equal(payload.train_text_embedder, true);
  assert.equal(payload.rank_dropout, 0.2);
  assert.equal(payload.loraplus_lr_ratio, 4);
});

test('importing a component-only LoRA+ ratio keeps the global multiplier unset', async () => {
  const { app } = application();
  Object.assign(app, { rebuildForm() {}, _persistProfileDrafts() {}, _persistProfileFieldSources() {} });
  await app._applyImportedFlatConfig({ model_train_type: 'moss-image-lora',
    enable_loraplus: true, loraplus_lr_ratio: '', loraplus_unet_lr_ratio: '',
    loraplus_text_encoder_lr_ratio: 4 });
  assert.match(app.tomlRaw, /loraplus_text_encoder_lr_ratio=4/);
  assert.doesNotMatch(app.tomlRaw, /loraplus_lr_ratio=|loraplus_unet_lr_ratio=/);
  assert.equal(app._collectTrainingPayload().loraplus_lr_ratio, undefined);
});

test('preview schedule selects one native interval and retains inactive form values', () => {
  const { app } = application();
  for (const profile of ['anima-lora', 'sdxl-lora', 'moss-image-lora']) {
    app.form = app._buildFormDefaults(profile);
    Object.assign(app.form, { enable_preview: true, sample_at_first: true,
      sample_every_n_epochs: 3, sample_every_n_steps: 120 });
    const html = app.renderField(app.findFieldDef('sample_interval_mode'));
    const options = JSON.parse(Buffer.from(html.match(/animaSelect\('([^']+)'/)[1], 'base64').toString('utf8'));
    assert.deepEqual(options.options.map(option => option.l), ['按轮数', '按步数', '关闭定期预览']);
    for (const mode of ['epochs', 'steps', 'none', 'epochs']) {
      app.form.sample_interval_mode = mode;
      app.updateToml();
      const payload = app._collectTrainingPayload();
      assert.equal(payload.sample_every_n_epochs, mode === 'epochs' ? 3 : undefined);
      assert.equal(payload.sample_every_n_steps, mode === 'steps' ? 120 : undefined);
      assert.equal(payload.sample_at_first, true);
      assert.equal(app.form.sample_every_n_epochs, 3);
      assert.equal(app.form.sample_every_n_steps, 120);
      assert.equal(/^sample_every_n_epochs =/m.test(app.tomlRaw), mode === 'epochs');
      assert.equal(/^sample_every_n_steps =/m.test(app.tomlRaw), mode === 'steps');
      assert.doesNotMatch(app.tomlRaw, /^sample_interval_mode =/m);
    }
    app.form.enable_preview = false;
    const payload = app._collectTrainingPayload();
    assert.equal(payload.sample_every_n_epochs, undefined);
    assert.equal(payload.sample_every_n_steps, undefined);
    assert.equal(payload.sample_at_first, undefined);
  }
});

test('native imports and old drafts infer the effective preview interval without default overrides', async () => {
  const { app } = application();
  Object.assign(app, { rebuildForm() {}, _persistProfileDrafts() {}, _persistProfileFieldSources() {} });
  for (const [intervals, mode] of [
    [{ sample_every_n_steps: 120 }, 'steps'],
    [{ sample_every_n_steps: 120, sample_every_n_epochs: 3 }, 'epochs'],
    [{ sample_every_n_steps: '', sample_every_n_epochs: '' }, 'none'],
  ]) {
    await app._applyImportedFlatConfig({ model_train_type: 'moss-image-lora', enable_preview: true, ...intervals });
    assert.equal(app.form.sample_interval_mode, mode);
    const restored = app._profileFormFromDraft('moss-image-lora', app._buildFormDefaults('moss-image-lora'), intervals);
    assert.equal(restored.sample_interval_mode, mode);
    if (mode === 'steps') assert.equal(app._collectTrainingPayload().sample_every_n_epochs, undefined);
  }
  await app._applyImportedFlatConfig({ model_train_type: 'moss-image-lora', max_train_steps: 300, validation_split: 0.1 });
  assert.deepEqual(Array.from(app._lastConfigImportIgnoredFields), ['max_train_steps', 'validation_split']);
  assert.equal(app.form.max_train_steps, undefined);
  assert.equal(app.form.max_train_epochs, 10);
});

test('checkpoint offload enables checkpointing and switching checkpointing off clears both offloads', () => {
  const { app } = application();
  Object.assign(app, { formDefaults: {}, pushHistory() {}, updateToml() {}, updateTomlDebounced() {}, showConditionalFields() {},
    queueTomlPreviewChange() {}, requestLrPreviewRefresh() {}, scheduleStepEstimate() {} });
  for (const key of ['cpu_offload_checkpointing', 'unsloth_offload_checkpointing']) {
    app.form.gradient_checkpointing = false;
    app.setField(key, true);
    assert.equal(app.form.gradient_checkpointing, true);
    app.setField('gradient_checkpointing', false);
    assert.equal(app.form.cpu_offload_checkpointing, false);
    assert.equal(app.form.unsloth_offload_checkpointing, false);
  }
  const restored = app._profileFormFromDraft('moss-image-lora', app._buildFormDefaults('moss-image-lora'), {
    gradient_checkpointing: false, cpu_offload_checkpointing: true,
  });
  assert.equal(restored.gradient_checkpointing, true);
});

test('imported invalid preview and timestep numbers fail validation before launch', () => {
  const { app } = application();
  app.$nextTick = () => {};
  Object.assign(app.form, { pretrained_model_name_or_path: 'dit.safetensors', text_encoder: 'te.safetensors',
    vae: 'vae.safetensors', enable_preview: true, positive_prompts: 'test', sample_interval_mode: 'steps' });
  for (const [key, value] of [['sample_steps', 0], ['sample_steps', 1.5], ['sample_flow_shift', 0],
    ['logit_std', -0.1], ['sample_every_n_steps', 0], ['sample_every_n_steps', '']]) {
    const original = app.form[key];
    app.form[key] = value;
    assert.equal(app.validateForm(), false, key);
    assert.ok(app.formErrors[key], key);
    app.form[key] = original;
  }
  app.form.logit_std = 0;
  assert.equal(app.validateForm(), true);
});

test('MOSS rejects blank scheduled and initial previews but allows disabled previews', () => {
  const { app } = application();
  app.$nextTick = () => {};
  Object.assign(app.form, { pretrained_model_name_or_path: 'dit.safetensors', text_encoder: 'te.safetensors',
    vae: 'vae.safetensors', enable_preview: true });
  for (const [mode, first] of [['epochs', false], ['steps', false], ['none', true]]) {
    Object.assign(app.form, { sample_interval_mode: mode, sample_at_first: first, positive_prompts: ' \n\t ' });
    assert.equal(app.validateForm(), false);
    assert.match(app.formErrors.positive_prompts, /提示词/);
    app.form.positive_prompts = 'first line\nsecond line';
    assert.equal(app.validateForm(), true);
  }
  Object.assign(app.form, { sample_interval_mode: 'none', sample_at_first: false, positive_prompts: '' });
  assert.equal(app.validateForm(), true);
  Object.assign(app.form, { enable_preview: false, sample_interval_mode: 'epochs', sample_at_first: true });
  assert.equal(app.validateForm(), true);
});

test('offload controls match each architecture and block conflicting Anima/MOSS combinations', () => {
  const { app, window } = application();
  app.$nextTick = () => {};
  const controls = ['blocks_to_swap', 'cpu_offload_checkpointing', 'unsloth_offload_checkpointing',
    'gradient_checkpointing_cpu_offload', 'use_pinned_memory_for_block_swap', 'block_swap_h2d_only', 'block_swap_ring_size'];
  for (const [profile, expected] of [
    ['sdxl-lora', []],
    ['anima-lora', controls.slice(0, 3)],
    ['moss-image-lora', controls.slice(0, 3)],
    ['krea2-lora', [controls[0], ...controls.slice(3)]],
  ]) {
    const keys = new Set(window.getVisibleSections(profile).flatMap(section => section.fields.map(field => field.key)));
    assert.deepEqual(controls.filter(key => keys.has(key)), expected, profile);
  }
  for (const [profile, maximum] of [['anima-lora', 26], ['moss-image-lora', 40]]) {
    app.form = app._buildFormDefaults(profile);
    Object.assign(app.form, { pretrained_model_name_or_path: 'dit.safetensors', text_encoder: 'te.safetensors',
      qwen3: 'te.safetensors', vae: 'vae.safetensors' });
    assert.equal(app._numberConstraints(app.findFieldDef('blocks_to_swap')).max, maximum);
    const original = { ...app.form };
    for (const [options, error] of [
      [{ cpu_offload_checkpointing: true, unsloth_offload_checkpointing: true }, 'unsloth_offload_checkpointing'],
      [{ cpu_offload_checkpointing: true, blocks_to_swap: 1 }, 'blocks_to_swap'],
      [{ unsloth_offload_checkpointing: true, blocks_to_swap: 1 }, 'blocks_to_swap'],
      [{ compile: true, compile_fullgraph: true, blocks_to_swap: 1 }, 'compile_fullgraph'],
    ]) {
      app.form = { ...original, ...options };
      assert.equal(app.validateForm(), false, profile + JSON.stringify(options));
      assert.ok(app.formErrors[error]);
    }
    app.form = { ...original, blocks_to_swap: maximum, compile: true };
    assert.equal(app.validateForm(), true);
    app.updateToml();
    assert.equal(app._collectTrainingPayload().blocks_to_swap, maximum);
    assert.equal(app._collectTrainingPayload().compile, true);
  }
});
