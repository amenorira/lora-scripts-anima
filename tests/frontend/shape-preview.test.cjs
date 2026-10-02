const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/training-shape-preview.js'), 'utf8'), context);
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

test('the timeout also covers a response whose body never arrives', async () => {
  const { app, pending, fire } = fixture();
  app.scheduleShapeEstimate();
  const request = fire(500);
  pending[0].resolve({ ok: true, json: () => new Promise((resolve, reject) => {
    pending[0].options.signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
  }) });
  await new Promise(resolve => setImmediate(resolve));
  fire(15000);
  await request;
  assert.equal(app.shapeEstimateLoading, false);
  assert.equal(app.shapeEstimateError, 'shapePreview.estimateTimeout');
});

test('a timed out old configuration releases the queue for the latest configuration', async () => {
  const { app, pending, timers, fire, reply } = fixture();
  app.scheduleShapeEstimate();
  const oldRequest = fire(500);
  app.form.network_dim = 64;
  app.scheduleShapeEstimate();
  await fire(500);
  assert.equal(pending.length, 1);
  fire(15000);
  await oldRequest;
  assert.equal(pending.length, 2);
  assert.equal(JSON.parse(pending[1].options.body).network_dim, 64);
  assert.equal(app.shapeEstimateError, '');
  assert.equal(app.shapeEstimateLoading, true);
  reply(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.shapeEstimateLoading, false);
  assert.equal(app.shapeEstimate.estimatedBytes, 1024);
  assert.equal(timers.size, 0);
});
