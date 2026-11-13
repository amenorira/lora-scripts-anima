const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, deferred, response } = require('./helpers.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
const cacheFound = { ok: true, json: async () => ({
  status: 'fail', data: { errorCode: 'trainingCacheFound', latents: 2, text: 1,
    directories: ['C:/train/1_data'], scope: 'server-cache-scope' },
}) };

function application(profile = 'anima-lora', run = async () => response({ task_id: 'started-task' })) {
  const requests = [], focused = [], errors = [], visibility = [];
  const context = loadFrontend(['shared/utils', 'app/config', 'training/conditions', 'training/toml', 'shared/confirmation-dialog'], {
    window: {}, fetch: async (url, options) => {
      if (url === '/api/fields') throw new Error('Use the fallback registry');
      assert.equal(url, '/api/run');
      requests.push(JSON.parse(options.body));
      return run(requests.length);
    },
  });
  const w = context.window;
  const form = Object.fromEntries(w.getVisibleSections(profile).flatMap(section => section.fields)
    .map(field => [field.key, field.default]));
  Object.assign(form, {
    model_train_type: profile, train_data_dir: 'C:/train', output_name: 'portrait_v3',
    enable_preview: true, positive_prompts: 'portrait, soft light\nfull body, outdoors',
    enable_krea_samples: true, krea_sample_prompts: 'krea portrait --w 1024\nkrea full body --w 768',
  });
  const model = composeMixins(w.trainingConditions, w.trainingTomlMixin, w.confirmationDialogMixin, {
    form, confirmPreviewBeforeTraining: true,
    t: key => key === 'trainingCache.scope' ? '{latents} image, {text} text\n{directories}' : key,
    validateForm: () => true, ensureKreaDitFormat: async () => true,
    refreshOutputPathInfo: async () => ({ available: true, writable: true }),
    refreshStepEstimate: async () => ({ total_steps: 10 }),
    _enforceCheckpointingUiConstraints() {}, _enforceMossTextEncoderFreeze() {},
    _applyTaskView(state) { if (state === 'IDLE') { this.isTraining = false; this.isIdle = true; } },
    _acceptTrainingStart(data) { this.acceptedTask = data.task_id; },
    toast: (...args) => errors.push(args), focusTrainingField: key => focused.push(key),
    $nextTick: callback => callback(),
    $refs: { confirmRoot: { open: true, getBoundingClientRect() {}, querySelectorAll: () => [] },
      confirmBody: { scrollTop: 0 }, confirmDetails: { open: false } },
  });
  let visible = false;
  Object.defineProperty(model, 'showConfirmModal', {
    get: () => visible, set: value => { visible = value; visibility.push(value); },
  });
  return { model, requests, focused, errors, visibility };
}

for (const [action, cacheAction] of [['confirmAction', 'server-cache-scope'], ['confirmSecondaryAction', 'keep']]) {
  test(`preview to cache ${action} keeps the host open through asynchronous checks and submits the reviewed snapshot`, async () => {
    const first = deferred(), second = deferred();
    const { model, requests, visibility, errors } = application('anima-lora', number => number === 1 ? first.promise : second.promise);
    const snapshot = JSON.parse(JSON.stringify(model.form));
    const pending = model.startTraining();
    await turn();
    const hostRequest = model._confirmRequest;
    model.confirmAction();
    assert.equal(requests.length, 1);
    assert.equal(model.confirmBusy, true);
    assert.equal(model.showConfirmModal, true);
    model.cancelConfirm(); model.confirmAction(); model.confirmSecondaryAction();
    await model.startTraining();
    assert.equal(requests.length, 1, 'busy confirmation blocks duplicate submission and closing');
    Object.assign(model.form, { train_data_dir: 'D:/other', output_name: 'changed', positive_prompts: 'changed' });
    first.resolve(cacheFound);
    await turn();
    assert.equal(model._confirmRequest, hostRequest);
    assert.deepEqual(visibility, [true], 'the host never closes between preview and cache');
    assert.equal(model.confirmDialog.title, 'trainingCache.title');
    assert.equal(model.confirmDialog.size, 'standard');
    assert.equal(model.confirmDialog.tone, 'danger');
    assert.deepEqual(Array.from(model.confirmDialog.fields), [], 'the preview summary is replaced');
    assert.equal(model.confirmBusy, false);
    assert.equal(model.trainingStarting, true);
    assert.equal(model.isTraining, false);
    model[action]();
    assert.equal(requests.length, 2);
    assert.equal(model.showConfirmModal, true);
    assert.equal(model.confirmBusy, true);
    assert.deepEqual(requests[1], { ...requests[0], _cache_action: cacheAction });
    assert.equal(requests[1].train_data_dir, 'C:/train');
    assert.equal(requests[1].output_name, 'portrait_v3');
    assert.deepEqual(requests[1]._form_state, snapshot);
    second.resolve(response({ task_id: 'started-task' }));
    await pending;
    assert.equal(model.acceptedTask, 'started-task');
    assert.equal(model.confirmBusy, false);
    assert.equal(model.trainingStarting, false);
    assert.deepEqual(visibility, [true, false]);
    assert.deepEqual(errors.map(entry => entry[0]), ['common.trainingStarted']);
  });
}

test('cancelling the cache step stops the chain without a retry or prompt focus', async () => {
  const { model, requests, focused } = application('krea2-lora', async () => cacheFound);
  const pending = model.startTraining();
  await turn();
  model.confirmAction();
  await turn();
  assert.equal(model.confirmDialog.title, 'trainingCache.title');
  model.cancelConfirm();
  await pending;
  model.confirmAfterClose();
  assert.equal(requests.length, 1);
  assert.deepEqual(focused, []);
  assert.equal(model.trainingStarting, false);
  assert.equal(model.isTraining, false);
});

test('a failed asynchronous submission at either step releases the flow so training can be retried', async () => {
  for (const failAt of [1, 2]) {
    const { model, requests, errors } = application('anima-lora', async number => {
      if (number === failAt) throw new Error('connection lost');
      return cacheFound;
    });
    const pending = model.startTraining();
    await turn();
    model.confirmAction();
    if (failAt === 2) {
      await turn();
      assert.equal(model.confirmDialog.title, 'trainingCache.title');
      model.confirmAction();
    }
    await pending;
    assert.equal(requests.length, failAt);
    assert.equal(model.showConfirmModal, false);
    assert.equal(model.confirmBusy, false);
    assert.equal(model.trainingStarting, false);
    assert.equal(model.isTraining, false);
    assert.equal(errors[0][0], 'common.requestFailed: connection lost');
    model.confirmAfterClose();
    const retry = model.startTraining();
    await turn();
    assert.equal(model.confirmDialog.title, 'trainingPreview.title');
    model.cancelConfirm();
    await retry;
  }
});
