const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, deferred, response } = require('./helpers.cjs');

function application(fetch, values = {}) {
  let nextTimer = 0;
  const timers = new Map();
  const context = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS, 'training/toml', 'training/config-io'], {
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
