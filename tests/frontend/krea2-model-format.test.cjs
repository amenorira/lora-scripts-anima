const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, deferred, response } = require('./helpers.cjs');

function application(fetch, values = {}) {
  let nextTimer = 0;
  const timers = new Map();
  const context = loadFrontend(['constants', 'utils', 'config', ...TRAINING_CORE_SCRIPTS, 'training-toml', 'training-config-io'], {
    window: {}, document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ click() {} }),
    },
    Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: (url, options) => url === '/api/fields'
      ? Promise.resolve({ json: async () => ({ status: 'fail' }) }) : fetch(url, options),
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  const w = context.window;
  const messages = [];
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, w.trainingConfigIoMixin, {
    t: key => key, toast: text => messages.push(text), pushHistory() {},
    _persistProfileFieldSources() {}, updateReadonlyStates() {}, updateTomlDebounced() {},
    _allShowIfKeys: () => [], queueTomlPreviewChange() {}, $nextTick: callback => callback(),
    refreshOutputPathInfo: async () => ({ available: true, writable: true }),
    refreshStepEstimate: async () => ({ total_steps: 10 }),
    _acceptTrainingStart() {}, _applyTaskView() {},
  });
  app.formDefaults = app._buildFormDefaults('krea2-lora');
  app.form = { ...app.formDefaults, model_train_type: 'krea2-lora', ...values };
  app.formErrors = {};
  const runCheck = () => {
    assert.equal(timers.size, 1);
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    return callback();
  };
  return { app, timers, messages, runCheck };
}

test('selecting an INT8 DiT enables ConvRot, disables FP8 and retains a correctable preview path', async () => {
  const calls = [];
  const { app, runCheck, messages } = application(async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return response({ format: 'convrot_int8' });
  }, { fp8_base: true, enable_krea_samples: true, turbo_dit: './turbo.safetensors' });
  app.setField('dit', './models/renamed.safetensors');
  await runCheck();
  assert.deepEqual(calls, [['/api/training/krea2/model-format', { path: './models/renamed.safetensors' }]]);
  assert.equal(app.form.convrot_int8, true);
  assert.equal(app.form.fp8_base, false);
  assert.equal(app._fieldSources.convrot_int8, 'auto');
  assert.equal(app._fieldSources.fp8_base, 'auto');
  assert.equal(app.form.turbo_dit, './turbo.safetensors');
  assert.equal(app.formErrors.turbo_dit, 'field.kreaTurboQuantizationConflict');
  assert.deepEqual(messages, ['krea2.int8ModelAutoConfigured']);
});

test('BF16 and failed format checks preserve quantization preferences regardless of filename', async () => {
  for (const format of ['unquantized', 'fp8', 'unknown']) {
    const { app, runCheck, messages } = application(async () => response({ format }), { fp8_base: true });
    app.setField('dit', './models/int8_convrot.safetensors');
    await runCheck();
    assert.equal(app.form.convrot_int8, false);
    assert.equal(app.form.fp8_base, true);
    assert.deepEqual(messages, []);
  }
  const { app, runCheck } = application(async () => { throw new Error('Disconnected'); }, { convrot_int8: true });
  app.setField('dit', './models/bf16.safetensors');
  await runCheck();
  assert.equal(app.form.convrot_int8, true);
  assert.equal(app.form.fp8_base, false);
});

test('typing paths is debounced and stale responses cannot change a later selection', async () => {
  const first = deferred();
  const calls = [];
  const { app, runCheck } = application(async (url, options) => {
    const path = JSON.parse(options.body).path;
    calls.push(path);
    return path.endsWith('first.safetensors') ? first.promise : response({ format: 'unquantized' });
  }, { fp8_base: true });
  app.setField('dit', './models/typing');
  app.setField('dit', './models/first.safetensors');
  const pending = runCheck();
  app.setField('dit', './models/second.safetensors');
  await runCheck();
  first.resolve(response({ format: 'convrot_int8' }));
  await pending;
  assert.deepEqual(calls, ['./models/first.safetensors', './models/second.safetensors']);
  assert.equal(app.form.convrot_int8, false);
  assert.equal(app.form.fp8_base, true);
});

test('leaving the profile or cancelling its watchers invalidates in-flight detection', async () => {
  for (const leave of [app => { app.form.model_train_type = 'moss-image-lora'; }, app => app._clearProfileFieldWatchers()]) {
    const gate = deferred();
    const { app, runCheck, messages } = application(() => gate.promise, { fp8_base: true });
    app.setField('dit', './models/base.safetensors');
    const pending = runCheck();
    leave(app);
    gate.resolve(response({ format: 'convrot_int8' }));
    await pending;
    assert.equal(app.form.convrot_int8, false);
    assert.equal(app.form.fp8_base, true);
    assert.deepEqual(messages, []);
  }
});

test('restored presets run detection on watcher setup and reselecting the same path checks again', async () => {
  let calls = 0;
  const { app, runCheck } = application(async () => { calls += 1; return response({ format: 'convrot_int8' }); });
  const watched = [];
  app.$watch = path => { watched.push(path); return () => {}; };
  app.setupKreaDitFormatWatcher();
  assert.ok(watched.includes('form.dit'));
  await runCheck();
  assert.equal(app.form.convrot_int8, true);
  app.setField('dit', app.form.dit);
  await runCheck();
  assert.equal(calls, 2);
});

for (const [method, endpoint] of [
  ['prepareKrea2Cache', '/api/training/krea2/cache'],
  ['startTraining', '/api/run'],
  ['downloadConfig', '/api/training/export-config'],
]) {
  for (const alreadyRunning of [false, true]) {
    test(`${method} waits for ${alreadyRunning ? 'in-flight' : 'debounced'} model detection before submitting`, async () => {
      const detection = deferred(), started = deferred();
      const calls = [];
      const { app, timers, runCheck } = application((url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith('/model-format')) {
          started.resolve();
          return detection.promise;
        }
        return Promise.resolve(response({ task_id: 'task', content: 'config', filename: 'training.yaml' }));
      }, { fp8_base: true });
      app.setField('dit', './models/renamed.safetensors');
      const background = alreadyRunning ? runCheck() : null;
      const submission = app[method]();
      await started.promise;
      assert.deepEqual(calls.map(call => call.url), ['/api/training/krea2/model-format']);
      assert.equal(timers.size, 0, 'submission flushes the typing debounce');
      // A queued path watcher must reuse this request instead of invalidating it.
      app.scheduleKreaDitFormatCheck();
      if (method !== 'downloadConfig') {
        assert.equal(app.trainingStarting, true);
        await app[method](); // Repeated clicks cannot start another submission while waiting.
      }
      detection.resolve(response({ format: 'convrot_int8' }));
      await Promise.all([background, submission]);
      assert.deepEqual(calls.map(call => call.url), ['/api/training/krea2/model-format', endpoint]);
      const payload = calls[1].body.form || calls[1].body;
      assert.equal(payload.convrot_int8, true);
      assert.equal(payload.fp8_base, false);
      if (method === 'startTraining') assert.equal(payload._form_state.convrot_int8, true);
      assert.equal(app.trainingStarting, false);
    });
  }
}

test('cache preparation and training revalidate conflicts introduced by detection', async () => {
  for (const method of ['prepareKrea2Cache', 'startTraining']) {
    const calls = [];
    const { app, messages } = application(async url => {
      calls.push(url);
      return response({ format: 'convrot_int8' });
    }, { enable_krea_samples: true, krea_sample_prompts: 'cat', turbo_dit: './turbo.safetensors' });
    assert.equal(app.validateForm(), true);
    await app[method]();
    assert.deepEqual(calls, ['/api/training/krea2/model-format']);
    assert.equal(app.formErrors.turbo_dit, 'field.kreaTurboQuantizationConflict');
    assert.ok(messages.includes('common.formErrors'));
    assert.equal(app.trainingStarting, false);
  }
});

test('changing the model or leaving the profile while waiting cancels the old submission', async () => {
  for (const change of [
    app => app.setField('dit', './models/second.safetensors'),
    app => { app.form.model_train_type = 'moss-image-lora'; },
    app => app._clearProfileFieldWatchers(),
  ]) {
    const detection = deferred();
    const calls = [];
    const { app } = application(url => { calls.push(url); return detection.promise; }, { fp8_base: true });
    const submission = app.prepareKrea2Cache();
    assert.deepEqual(calls, ['/api/training/krea2/model-format']);
    change(app);
    detection.resolve(response({ format: 'convrot_int8' }));
    await submission;
    assert.equal(calls.length, 1);
    assert.equal(app.form.convrot_int8, false);
    assert.equal(app.trainingStarting, false);
  }
});

test('readonly watcher setup does not start or invalidate model detection', async () => {
  const detection = deferred();
  const { app, timers, runCheck } = application(() => detection.promise);
  const watched = [];
  app.$watch = path => { watched.push(path); return () => {}; };
  app.setupReadonlyWatchers();
  assert.ok(!watched.includes('form.dit'));
  assert.equal(timers.size, 0);
  app.setupKreaDitFormatWatcher();
  const pending = runCheck();
  app.setupReadonlyWatchers();
  app.setupKreaDitFormatWatcher(); // A registry refresh can reinstall watchers during submission.
  detection.resolve(response({ format: 'convrot_int8' }));
  await pending;
  assert.equal(app.form.convrot_int8, true);
});

test('Alpine path watchers reuse the submission inspection and clean up on profile disposal', async () => {
  const detection = deferred();
  const calls = [];
  const fixture = application((url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return url.endsWith('/model-format') ? detection.promise : Promise.resolve(response({ task_id: 'task' }));
  }, { fp8_base: true });
  const context = loadFrontend('vendor/alpine.min', {
    window: { Element: class {} }, document: { createElement: () => ({}), addEventListener() {} },
    MutationObserver: class {}, queueMicrotask() {}, setTimeout, clearTimeout,
  });
  context.queueMicrotask = queueMicrotask;
  const alpine = context.window.Alpine;
  const app = alpine.reactive(fixture.app);
  app.$watch = (path, callback) => alpine.watch(() => app.form[path.slice('form.'.length)], callback);
  app.setupKreaDitFormatWatcher();
  try {
    app.setField('dit', './models/selected.safetensors');
    const submission = app.prepareKrea2Cache();
    await alpine.nextTick();
    assert.equal(calls.length, 1);
    detection.resolve(response({ format: 'convrot_int8' }));
    await submission;
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.convrot_int8, true);
    assert.equal(calls[1].body.fp8_base, false);
  } finally {
    app._clearProfileFieldWatchers();
  }
  app.form.dit = './models/after-disposal.safetensors';
  await alpine.nextTick();
  assert.equal(fixture.timers.size, 0);
});

test('Turbo LoRA picker lists and selects downloaded files from models', async () => {
  const file = { name: 'krea2_turbo_lora_rank_64_bf16_kohya.safetensors',
    path: './models/krea2_turbo_lora_rank_64_bf16_kohya.safetensors' };
  const { app } = application(async url => {
    assert.equal(url, '/api/get_files?pick_type=model-file');
    return response({ files: [file] });
  }, { enable_krea_samples: true });
  const field = app.findFieldDef('turbo_lora');
  await app.builtinFilePicker(field.key, field.role);
  assert.equal(app._pickerRoot, './models');
  assert.equal(app._pickerFiles[0].path, file.path);
  app.pickFileFromModal(app._pickerFiles[0]);
  assert.equal(app.form.turbo_lora, file.path);
});
