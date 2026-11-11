const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

function runtime(overrides = {}) {
  const microtasks = [];
  const timers = new Map();
  const frames = new Map();
  let nextTimer = 0;
  const context = loadFrontend(['vendor/alpine.min', ...TRAINING_CORE_SCRIPTS], {
    window: { Element: class {}, t: (_key, fallback) => fallback,
      addEventListener() {}, removeEventListener() {} },
    document: { createElement: () => ({}), getElementById: () => null, querySelectorAll: () => [] },
    MutationObserver: class {}, queueMicrotask() {},
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++nextTimer; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  // Keep the real shipped Alpine reactivity and scheduler, without its DOM scan.
  // Controlling microtasks lets us stop either side of the effect/callback gap.
  context.queueMicrotask = callback => microtasks.push(callback);
  const app = context.window.Alpine.reactive(Object.assign({}, context.window.trainingCoreMixin, overrides));
  const flush = () => {
    let iterations = 0;
    while (microtasks.length) {
      assert.ok(++iterations < 100, 'watchers should settle');
      microtasks.shift()();
    }
  };
  const flushFrames = () => {
    for (const [id, callback] of [...frames]) {
      if (!frames.delete(id)) continue;
      callback();
    }
  };
  return { app, microtasks, timers, frames, flush, flushFrames };
}

test('training unsubscribe cancels queued effects and already queued callbacks', () => {
  for (const afterEffect of [false, true]) {
    const h = runtime({ form: { value: 0 } });
    const seen = [];
    const stop = h.app._watchTrainingState(() => h.app.form.value, (...args) => seen.push(args));
    h.app.form.value = 1;
    h.flush();
    assert.deepEqual(seen, [[1, 0]], 'the real listener runs while active');
    h.app.form.value = 2;
    assert.equal(h.microtasks.length, 1);
    if (afterEffect) {
      h.microtasks.shift()();
      assert.equal(h.microtasks.length, 1, 'callback is queued after its effect flushes');
    }
    stop();
    stop();
    h.flush();
    h.app.form.value = 3;
    h.flush();
    assert.deepEqual(seen, [[1, 0]], `no stale callback after stopping ${afterEffect ? 'after' : 'before'} effect flush`);
  }
});

test('profile field listeners are replaced without accumulating old rules', () => {
  const calls = { auto: 0, show: 0, readonly: 0, dit: 0 };
  const h = runtime({
    form: { model_train_type: 'anima-lora', trigger: 0, dit: '' },
    _collectAutoValueRules: () => [{ target: 'derived', watch: 'trigger' }],
    _matchAutoValueRule: () => true,
    _applyAutoValueRule() { calls.auto++; },
    _applyInitialAutoValues() {},
    _allShowIfKeys: () => ['trigger'], _allReadonlyIfKeys: () => ['trigger'],
    showConditionalFields() { calls.show++; },
    updateReadonlyStates() { calls.readonly++; },
    scheduleKreaDitFormatCheck() { calls.dit++; },
  });
  const app = h.app;
  for (let i = 0; i < 6; i++) {
    app._clearProfileFieldWatchers();
    const type = i % 2 ? 'anima-lora' : 'krea2-lora';
    app.form = { model_train_type: type, trigger: 0, dit: '' };
    app.setupAutoValueWatchers();
    app.setupShowIfWatchers();
    app.setupReadonlyWatchers();
    app.setupKreaDitFormatWatcher();
    h.flush();
    const before = { ...calls };
    app.form.trigger = 1;
    app.form.dit = 'model.safetensors';
    h.flush();
    assert.deepEqual(calls, { auto: before.auto + 1, show: before.show + 1,
      readonly: before.readonly + 2, dit: before.dit + (type === 'krea2-lora' ? 1 : 0) });
    app.form.trigger = 2;
    app.form.dit = 'queued.safetensors';
    // Release while callback microtasks are pending, before replacing the form.
    h.microtasks.shift()();
    app._clearProfileFieldWatchers();
    const stopped = { ...calls };
    h.flush();
    assert.deepEqual(calls, stopped);
  }
});

test('readonly dependencies register one training type listener whether already included or not', () => {
  for (const keys of [['model_train_type', 'trigger'], ['trigger']]) {
    let calls = 0;
    const h = runtime({
      form: { model_train_type: 'anima-lora', trigger: 0 },
      _allReadonlyIfKeys: () => keys,
      updateReadonlyStates() { calls++; },
    });
    h.app.setupReadonlyWatchers();
    assert.equal(h.app._readonlyWatchers.length, 2);
    assert.equal(calls, 1, 'initial state is applied synchronously');
    h.app.form.model_train_type = 'sdxl-lora';
    h.flush();
    assert.equal(calls, 2, 'training type change invokes one listener');
    h.app._clearProfileFieldWatchers();
  }
});

test('readonly constraints stay immediate while deferred DOM updates share the final state', () => {
  const snapshots = [];
  const h = runtime({
    form: { model_train_type: 'anima-lora', max_data_loader_n_workers: 2,
      persistent_data_loader_workers: true, random_crop: false, cache_latents: true, cache_latents_to_disk: true },
    _setFieldSource() {},
    _syncReadonlyDom() { snapshots.push({ ...this.form }); },
  });
  h.app.updateReadonlyStates();
  assert.equal(snapshots.length, 1, 'direct callers still update the DOM immediately');
  h.app.form.max_data_loader_n_workers = 0;
  h.app.updateReadonlyStates(true);
  assert.equal(h.app.form.persistent_data_loader_workers, false);
  h.app.form.random_crop = true;
  h.app.updateReadonlyStates(true);
  assert.equal(h.app.form.cache_latents, false);
  assert.equal(h.app.form.cache_latents_to_disk, false);
  assert.equal(snapshots.length, 1);
  assert.equal(h.frames.size, 1);
  h.flushFrames();
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[1], { ...h.app.form });

  h.app.updateReadonlyStates(true);
  h.app.updateReadonlyStates();
  assert.equal(snapshots.length, 3);
  assert.equal(h.frames.size, 0, 'an immediate refresh consumes the queued work');
  h.flushFrames();
  assert.equal(snapshots.length, 3);
});

test('readonly watcher cascades share one DOM pass and profile cleanup cancels it', () => {
  let scans = 0;
  const h = runtime({
    form: { model_train_type: 'anima-lora', max_data_loader_n_workers: 2, persistent_data_loader_workers: true },
    _allReadonlyIfKeys: () => ['max_data_loader_n_workers', 'persistent_data_loader_workers'],
    _setFieldSource() {},
    _syncReadonlyDom() { scans++; },
  });
  h.app.setupReadonlyWatchers();
  h.app.form.max_data_loader_n_workers = 0;
  h.flush();
  assert.equal(h.app.form.persistent_data_loader_workers, false);
  assert.equal(h.frames.size, 1, 'constraint changes trigger more watchers without another DOM pass');
  h.flushFrames();
  assert.equal(scans, 2, 'one initial pass and one settled pass');

  h.app.form.max_data_loader_n_workers = 1;
  h.flush();
  assert.equal(h.frames.size, 1);
  h.app._clearProfileFieldWatchers();
  h.app.form.max_data_loader_n_workers = 0;
  h.flush();
  h.flushFrames();
  assert.equal(scans, 2, 'released profiles perform no stale DOM work');
});

test('disposing the training form stops save and type listeners and clears pending saves', () => {
  const calls = { estimates: 0, switches: 0, saves: 0, scans: 0 };
  const h = runtime({
    currentRoute: 'train-basic', locale: 'en-US',
    _resumeTrainForm: () => false,
    _initializeTrainingFormState() {
      this.form = { model_train_type: 'anima-lora', learning_rate: 'initial' };
      this._activeTrainType = 'anima-lora';
      return { trainType: 'anima-lora', defaults: { ...this.form } };
    },
    _persistProfileDrafts() {}, _persistProfileFieldSources() {}, _captureProfileDraft() {},
    _persistActiveTrainingForm() { calls.saves++; },
    buildSectionNav() {}, renderTrainingForm() {},
    setupAutoValueWatchers() {}, setupShowIfWatchers() {}, setupReadonlyWatchers() {}, setupKreaDitFormatWatcher() {},
    scheduleShapeEstimate() { calls.estimates++; }, scheduleStepEstimate() {}, scheduleOutputPathInfo() {},
    switchTrainType() { calls.switches++; },
    refreshTrainingRealtimeState() {}, xfRefresh: async () => {},
    _invalidateTrainingPickers() {}, _cancelTrainingPreflight() {}, stopSectionScroll() {}, _destroyTrainTypePanel() {},
    _syncReadonlyDom() { calls.scans++; },
  });
  const app = h.app;
  app.buildTrainForm();
  app.form.learning_rate = 'edited';
  h.flush();
  assert.equal(h.timers.size, 1, 'editing schedules the production delayed save');
  app.form.model_train_type = 'sdxl-lora';
  h.microtasks.shift()();
  app.updateReadonlyStates(true);
  assert.equal(h.frames.size, 1);
  app._disposeTrainForm();
  assert.equal(h.timers.size, 0);
  const disposed = { ...calls };
  h.flush();
  h.flushFrames();
  app.form.learning_rate = 'after disposal';
  app.form.model_train_type = 'krea2-lora';
  h.flush();
  assert.deepEqual(calls, disposed);
  assert.equal(app._formWatcher, null);
  assert.equal(app._trainTypeWatcher, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.size, 0);
});
