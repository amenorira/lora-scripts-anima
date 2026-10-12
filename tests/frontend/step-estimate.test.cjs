const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const timers = new Map();
  let timerId = 0;
  const context = {
    window: {},
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/training-core.js'), 'utf8'), context);
  const app = Object.assign({}, context.window.trainingCoreMixin, {
    form: { model_train_type: 'anima-lora', train_data_dir: 'train', reg_data_dir: 'reg', enable_reg_data: true },
  });
  return {
    app, context,
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
  };
}

test('regularization toggle requests a fresh estimate while preserving the entered path', () => {
  for (const profile of ['anima-lora', 'sdxl-lora']) {
    const { app, flush } = fixture();
    app.form.model_train_type = profile;
    const requests = [];
    app._requestStepEstimate = (seq, payload) => requests.push({ seq, payload });
    for (const enabled of [true, false, true]) {
      app.form.enable_reg_data = enabled;
      app.scheduleStepEstimate();
      flush();
    }
    assert.deepEqual(requests.map(r => r.payload.enable_reg_data), [true, false, true]);
    assert.deepEqual(requests.map(r => r.seq), [1, 2, 3]);
    assert.ok(requests.every(r => r.payload.reg_data_dir === 'reg'));
    assert.equal(app.form.reg_data_dir, 'reg');
    app.scheduleStepEstimate();
    flush();
    assert.equal(requests.length, 3);
  }
});

test('an in-flight enabled estimate cannot overwrite the result after regularization is disabled', async () => {
  const { app, context } = fixture();
  const pending = [];
  context.fetch = (_url, options) => new Promise(resolve => {
    pending.push({ payload: JSON.parse(options.body), resolve });
  });
  app._reconcileSubsetTimestepOffsets = () => {};
  app._refreshSubsetTimestepEditor = () => {};
  const enabledRequest = app.refreshStepEstimate(true);
  app.form.enable_reg_data = false;
  const disabledRequest = app.refreshStepEstimate(true);
  const respond = (request, steps) => request.resolve({
    ok: true, json: async () => ({ status: 'success', data: { total_steps: steps } }),
  });
  assert.equal(pending[1].payload.enable_reg_data, false);
  respond(pending[1], 400);
  await disabledRequest;
  respond(pending[0], 800);
  await enabledRequest;
  assert.equal(app.stepEstimate.total_steps, 400);
  assert.equal(app.stepEstimateLoading, false);
});
