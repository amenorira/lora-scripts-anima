const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function fixture() {
  const timers = new Map();
  const pending = [];
  let timerId = 0;
  const context = {
    window: {}, AbortController,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      return new Promise((resolve, reject) => {
        pending.push({ url, options, resolve, reject });
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  loadFrontend('training-shape-preview.js', context);
  const app = Object.assign({}, context.window.trainingShapePreviewMixin, {
    form: { model_train_type: 'anima-lora', network_dim: 32 },
    t: key => key, _openManagedModal() {},
  });
  const fire = delay => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `Missing ${delay} ms timer`);
    timers.delete(entry[0]);
    return entry[1].callback();
  };
  const reply = index => pending[index].resolve({
    ok: true,
    json: async () => ({ status: 'success', data: {
      estimatedBytes: 1024, groups: [{ id: 'q', name: 'blocks.*.self_attn.q_proj' }],
    } }),
  });
  return { app, pending, timers, fire, reply };
}

test('a stalled estimate stops loading on timeout and can be retried from the preview button', async () => {
  const { app, pending, timers, fire, reply } = fixture();
  app.scheduleShapeEstimate();
  const request = fire(500);
  assert.equal(app.shapeEstimateLoading, true);
  fire(15000);
  await request;
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(app.shapeEstimateLoading, false);
  assert.equal(app._shapeEstimateBusy, false);
  assert.equal(app.shapeEstimateError, 'shapePreview.estimateTimeout');

  app.openShapePreview();
  const retry = fire(500);
  reply(1);
  await retry;
  assert.equal(app.shapeEstimateError, '');
  assert.equal(app.shapeEstimate.estimatedBytes, 1024);
  assert.equal(app.shapePreviewSelected, 'q');
  assert.equal(timers.size, 0);
});
