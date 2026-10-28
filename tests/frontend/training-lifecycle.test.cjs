const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, composeMixins, deferred, response } = require('./helpers.cjs');

for (const lifecycle of ['suspendTrainForm', '_disposeTrainForm']) {
test(`${lifecycle} invalidates outstanding step and output checks`, async () => {
  const steps = deferred(), output = deferred(), cleared = [];
  const { window } = loadFrontend(TRAINING_CORE_SCRIPTS, {
    window: {}, URLSearchParams,
    fetch: url => (url.includes('/estimate') ? steps : output).promise,
    clearTimeout: timer => cleared.push(timer),
    localStorage: { setItem() {} },
    document: { getElementById: () => null },
  });
  const app = composeMixins(window.trainingCoreMixin, {
    form: { model_train_type: 'anima-lora' },
    _captureProfileDraft() {}, _persistProfileDrafts() {}, _persistProfileFieldSources() {},
    _cancelScheduledTrainTypeSwitch() {}, stopSectionScroll() {},
    _destroyTrainTypePanel() {},
    _stepEstimateRequestSeq: 4, _outputPathInfoRequestSeq: 6,
    _stepEstimateTimer: 10, _outputPathInfoTimer: 11,
    _stepEstimateSignature: 'old', _outputPathInfoSignature: 'old',
    stepEstimateLoading: true, outputPathInfoLoading: true,
    _reconcileSubsetTimestepOffsets: () => assert.fail('stale response must not update the form'),
    _refreshSubsetTimestepEditor: () => assert.fail('stale response must not update the DOM'),
  });
  const oldSteps = app._requestStepEstimate(4, {});
  const oldOutput = app._requestOutputPathInfo(6, {});
  app[lifecycle]('train-basic');
  steps.resolve(response({ total_steps: 99 }));
  output.resolve(response({ available: true }));
  await Promise.all([oldSteps, oldOutput]);
  assert.equal(app.stepEstimate, null);
  assert.equal(app.outputPathInfo, null);
  assert.equal(app.stepEstimateLoading, false);
  assert.equal(app.outputPathInfoLoading, false);
  assert.equal(app._stepEstimateSignature, '');
  assert.equal(app._outputPathInfoSignature, '');
  assert.ok(cleared.includes(10) && cleared.includes(11));
});
}

test('collapse and expand clean up styles through either transition completion or timeout', () => {
  for (const collapsing of [true, false]) {
    for (const completion of ['event', 'timeout']) {
      const frames = [], timers = [];
      const { window } = loadFrontend('training/sections', {
        window: {}, requestAnimationFrame: callback => frames.push(callback),
        setTimeout: callback => timers.push(callback),
      });
      const events = new Map();
      const body = {
        style: {}, scrollHeight: 120, offsetHeight: 120,
        addEventListener: (name, callback) => events.set(name, callback),
        removeEventListener: name => events.delete(name),
      };
      window.trainingSections._animateCollapse(body, collapsing);
      assert.equal(body.style.maxHeight, collapsing ? '120px' : '0px');
      frames.shift()();
      assert.equal(body.style.maxHeight, collapsing ? '0px' : '120px');
      events.get('transitionend')({ propertyName: 'opacity' });
      assert.equal(body.style.overflow, 'hidden');
      if (completion === 'event') events.get('transitionend')({ propertyName: 'max-height' });
      else timers[0]();
      assert.equal(body.style.maxHeight, '');
      assert.equal(body.style.opacity, '');
      assert.equal(body.style.overflow, '');
      assert.equal(events.size, 0);
      timers[0]();
      assert.equal(events.size, 0);
    }
  }
});
