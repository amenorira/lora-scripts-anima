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
