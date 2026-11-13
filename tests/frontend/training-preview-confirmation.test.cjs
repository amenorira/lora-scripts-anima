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

for (const profile of ['anima-lora', 'sdxl-lora', 'moss-image-lora', 'krea2-lora']) {
  test(`${profile}: preview summary uses its submitted fields and modifying waits for the dialog to close`, async () => {
    for (const action of ['cancelConfirm', 'confirmSecondaryAction']) {
      const { model, requests, focused } = application(profile);
      const promptKey = profile === 'krea2-lora' ? 'krea_sample_prompts' : 'positive_prompts';
      const pending = model.startTraining();
      await turn();
      assert.equal(model.showConfirmModal, true);
      assert.equal(model.confirmDialog.title, 'trainingPreview.title');
      assert.equal(model.confirmDialog.size, 'wide');
      assert.deepEqual(JSON.parse(JSON.stringify(model.confirmDialog.fields)), [
        { label: 'field.train_data_dir', value: 'C:/train', multiline: false },
        { label: 'field.output_name', value: 'portrait_v3', multiline: false },
        { label: 'trainingPreview.positivePrompts', value: model.form[promptKey], multiline: true },
      ]);
      await model.startTraining();
      assert.equal(model._confirmQueue.length, 0, 'a repeated start cannot queue another preview');
      model[action]();
      await pending;
      assert.deepEqual(requests, []);
      assert.deepEqual(focused, [], 'the native dialog must release focus first');
      assert.equal(model.trainingStarting, false);
      model.confirmAfterClose();
      assert.deepEqual(focused, action === 'confirmSecondaryAction' ? [promptKey] : []);
      model.confirmAfterClose();
      assert.equal(focused.length, action === 'confirmSecondaryAction' ? 1 : 0);
    }
  });
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

test('disabling preview confirmation skips only that step and keeps cache confirmation functional', async () => {
  const { model, requests } = application('anima-lora', async number => number === 1 ? cacheFound : response({ task_id: 'started-task' }));
  model.confirmPreviewBeforeTraining = false;
  await model.startTraining();
  assert.equal(requests.length, 1);
  assert.equal(model.confirmDialog.title, 'trainingCache.title');
  model.confirmSecondaryAction();
  await turn();
  assert.equal(requests.length, 2);
  assert.equal(requests[1]._cache_action, 'keep');
  assert.equal(model.acceptedTask, 'started-task');
});

test('disabled model preview does not open a confirmation even when another profile flag is enabled', async () => {
  for (const profile of ['anima-lora', 'krea2-lora']) {
    const { model, requests } = application(profile);
    model.form[profile === 'krea2-lora' ? 'enable_krea_samples' : 'enable_preview'] = false;
    await model.startTraining();
    assert.equal(requests.length, 1);
    assert.equal(model.showConfirmModal, false);
    assert.equal(model.acceptedTask, 'started-task');
  }
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

test('confirming previews finishes normally when the server has no cache to confirm', async () => {
  const { model, requests, visibility } = application();
  const pending = model.startTraining();
  await turn();
  model.confirmAction();
  await pending;
  assert.equal(requests.length, 1);
  assert.equal(model.acceptedTask, 'started-task');
  assert.equal(model.trainingStarting, false);
  assert.equal(model.confirmBusy, false);
  assert.deepEqual(visibility, [true, false]);
});
