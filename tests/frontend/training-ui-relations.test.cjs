const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { TRAINING_CORE_SCRIPTS, loadFrontend, readRepo, trainingFieldSections } = require('./helpers.cjs');

function application(profile, values = {}) {
  const context = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS, 'training/toml', 'training/dataset-repeat', 'training/config-io'], {
    window: { TRAIN_SECTIONS: trainingFieldSections() }, document: { getElementById: () => null, querySelectorAll: () => [] }, btoa, TextEncoder, clearTimeout,
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  });
  const w = context.window;
  context.ROUTE_CONFIG = w.ROUTE_CONFIG;
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

test('restored drafts retain their fields while incompatible network selections are normalized', () => {
  for (const [savedType, module, type, expected] of [
    ['sd-lora', 'networks.lora', 'anima-lora', 'networks.lora_anima'],
    ['sdxl-lora', 'networks.lora_anima', 'sdxl-lora', 'networks.lora'],
    ['anima-lora', 'lycoris.kohya', 'anima-lora', 'lycoris.kohya'],
    ['moss-image-lora', 'networks.lora_generic', 'moss-image-lora', 'networks.lora_generic'],
  ]) {
    const app = application('anima-lora', { model_train_type: savedType, network_module: module, learning_rate: '0.123' });
    app._initializeTrainingFormState('train-basic', true);
    assert.equal(app.form.model_train_type, type);
    assert.equal(app.form.network_module, expected);
    assert.equal(app.form.learning_rate, '0.123');
  }
});

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

test('learning_rate hints suppress editable Prodigy guidance when readonly and resolve profile suffixes', () => {
  const anima = application('anima-lora', { optimizer_type: 'Prodigy', learning_rate: '1.0' });
  anima.t = key => (key === 'field.learning_rateHint_emosens_sdxl' ? 'SDXL 1.0' : key);
  assert.equal(anima._resolveFieldHintKey(anima.findFieldDef('learning_rate'), anima.form, 'anima-lora'), '');

  const krea = application('krea2-lora', { optimizer_type: 'prodigyopt.Prodigy', learning_rate: '1.0' });
  assert.equal(krea._resolveFieldHintKey(krea.findFieldDef('learning_rate'), krea.form, 'krea2-lora'), '');

  const sdxl = application('sdxl-lora', { optimizer_type: 'vendor.emo_optimizer.emosens.EmoSens', learning_rate: '1.0' });
  sdxl.t = key => (key === 'field.learning_rateHint_emosens_sdxl' ? 'SDXL 1.0' : '');
  assert.equal(
    sdxl._resolveFieldHintKey(sdxl.findFieldDef('learning_rate'), sdxl.form, 'sdxl-lora'),
    'field.learning_rateHint_emosens_sdxl',
  );
});

test('Krea field help follows the sampling mode and dialog links follow their href', async () => {
  const app = docsApp({ form: { model_train_type: 'krea2-lora', timestep_sampling: 'logsnr' } });
  await app.openFieldDoc('timesteps', 'logit-normal');
  assert.equal(app.parameterDocOpen, true);
  assert.equal(app.parameterDocSlug, 'timesteps');
  assert.equal(app.parameterDocAnchor, 'logsnr');
  const link = { getAttribute: () => '#logit-normal' };
  await app.handleDocsContentClick({ target: { closest: () => link }, preventDefault() {} }, true);
  assert.equal(app.parameterDocAnchor, 'logit-normal');
});

function docsApp(extra = {}) {
  const context = loadFrontend(['docs/index'], {
    window: {},
    AbortController, setTimeout, clearTimeout,
    document: {
      createElement: () => ({ innerHTML: '', content: { querySelectorAll: () => [], replaceChildren() {} } }),
      getElementById: () => null,
    },
    fetch: async url => ({ ok: true, json: async () => ({ status: 'success', data: url.startsWith('/api/docs/')
      ? { slug: url.slice('/api/docs/'.length).split('?')[0], locale: 'zh-CN', html: `<h2 id="x">${url}</h2>` }
      : { locale: 'zh-CN', documents: [{ slug: 'optimizers' }, { slug: 'timesteps' }] } }) }),
  });
  return Object.assign({}, context.window.docsMixin, {
    currentRoute: 'train-basic', locale: 'zh-CN', form: {},
    t: key => key, $nextTick: callback => callback(), ...extra,
  });
}

test('reader retry button and sidebar retry both preserve a failed chapter link', async () => {
  const html = readRepo('frontend/index.html');
  const errorPanel = html.match(/<div class="docs-error"[^>]*>[\s\S]*?<\/div>/)[0];
  const visible = errorPanel.match(/x-show="([^"]+)"/)[1];
  const retryClick = errorPanel.match(/<button[^>]*@click="([^"]+)"/)[1];
  const sidebarClick = html.match(/<button[^>]*class="docs-index-item"[^>]*@click="([^"]+)"/)[1];

  for (const click of [retryClick, sidebarClick]) {
    const app = docsApp({
      currentRoute: 'docs', docsSelectedSlug: 'optimizers', _docsContentLocale: 'zh-CN',
      docsHtml: '<h2>optimizers</h2>', doc: { slug: 'timesteps' },
    });
    const evaluate = expression => vm.runInNewContext(`with (reader) { ${expression} }`, { reader: app });
    const scrolled = [];
    app.scrollToDocAnchor = anchor => scrolled.push(anchor);
    app._fetchDocsContent = async () => { throw new Error('HTTP 503'); };
    await app.selectParameterDoc('timesteps', 'krea-range');
    assert.equal(app.docsSelectedSlug, 'optimizers');
    assert.match(app.docsHtml, /optimizers/);
    assert.match(app.docsError, /HTTP 503/);
    assert.ok(evaluate(visible));

    app._fetchDocsContent = async slug => ({ slug, locale: 'zh-CN', html: '<h2 id="krea-range">Krea range</h2>' });
    await evaluate(click);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(app.docsSelectedSlug, 'timesteps');
    assert.match(app.docsHtml, /Krea range/);
    assert.ok(!evaluate(visible));
    assert.deepEqual(scrolled, ['krea-range']);
  }
});

test('inline outline collapses before measuring the anchor scroll target', () => {
  const app = docsApp({ currentRoute: 'docs' });
  const details = { open: true };
  const link = { getAttribute: () => '#logsnr', closest: selector => (selector === 'details' ? details : null) };
  let openWhenScrolled = null;
  app.scrollToDocAnchor = () => { openWhenScrolled = details.open; };
  app.handleInlineDocsTocClick({ target: { closest: () => link }, preventDefault() {} });
  assert.equal(openWhenScrolled, false);
});

test('Prodigy fields open prodigy-options, switching to ProdigyPlus options for ProdigyPlusScheduleFree', async () => {
  for (const [optimizer, expected] of [['prodigyopt.Prodigy', 'prodigy-options'],
    ['prodigyplus.ProdigyPlusScheduleFree', 'prodigyplus-options']]) {
    const app = docsApp({ form: { model_train_type: 'krea2-lora', optimizer_type: optimizer } });
    await app.openFieldDoc('optimizers', 'prodigy-options');
    assert.equal(app.parameterDocAnchor, expected);
    const link = { getAttribute: () => 'optimizers.zh-CN.md#prodigy-options' };
    await app.handleDocsContentClick({ target: { closest: () => link }, preventDefault() {} }, true);
    assert.equal(app.parameterDocAnchor, 'prodigy-options');
  }
});
