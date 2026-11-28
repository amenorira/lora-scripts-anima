const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, deferred, response, trainingFieldSections } = require('./helpers.cjs');

const turn = () => new Promise(resolve => setImmediate(resolve));
const cacheFound = { ok: true, json: async () => ({
  status: 'fail', data: { errorCode: 'trainingCacheFound', latents: 2, text: 1,
    directories: ['C:/train/1_data'], scope: 'server-cache-scope' },
}) };

function application(profile = 'anima-lora', run = async () => response({ task_id: 'started-task' })) {
  const requests = [], focused = [], errors = [], visibility = [];
  const context = loadFrontend(['shared/utils', 'app/config', 'training/conditions', 'training/toml', 'shared/confirmation-dialog'], {
    window: { TRAIN_SECTIONS: trainingFieldSections() }, fetch: async (url, options) => {
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
    _reconcileSubsetTimestepOffsets() {}, _refreshSubsetTimestepEditor() {},
    _cancelTrainingPreflight() {}, scheduleStepEstimate() {},
    _enforceCheckpointingUiConstraints() {}, _enforceMossTextEncoderFreeze() {},
    _applyTaskView(state) { if (state === 'IDLE') { this.isTraining = false; this.isIdle = true; } },
    _acceptTrainingStart(data) { this.acceptedTask = data.task_id; },
    toast: (...args) => errors.push(args), focusTrainingField: key => focused.push(key),
    $nextTick: callback => callback(),
    $refs: { confirmRoot: { open: true, getBoundingClientRect() {}, querySelectorAll: () => [] },
      confirmBody: { scrollTop: 0 }, confirmDetails: { scrollTop: 0 } },
  });
  let visible = false;
  Object.defineProperty(model, 'showConfirmModal', {
    get: () => visible, set: value => { visible = value; visibility.push(value); },
  });
  return { model, requests, focused, errors, visibility };
}

test('preview summary separates active prompts and keeps multiline MOSS text together', async () => {
  for (const profile of ['anima-lora', 'krea2-lora', 'moss-image-lora']) {
    const { model, requests } = application(profile);
    const key = profile === 'krea2-lora' ? 'krea_sample_prompts' : 'positive_prompts';
    const prompts = profile === 'moss-image-lora'
      ? 'A portrait.\nSoft light from the left.' : '# skipped\r\n\r\nportrait, soft light\r\nfull body, outdoors';
    Object.assign(model.form, { [key]: prompts, enable_quality_prompts: true, quality_prompts: 'best quality\nhighres' });
    const pending = model.startTraining();
    await turn();
    const field = model.confirmDialog.fields[2];
    const expected = profile === 'moss-image-lora'
      ? ['best quality, highres, A portrait.\nSoft light from the left.']
      : ['best quality, highres, portrait, soft light', 'best quality, highres, full body, outdoors'];
    assert.deepEqual(Array.from(field.items), expected);
    assert.equal(field.multiline, true);
    assert.equal(model.form[key], prompts, 'grouping the summary does not rewrite the configured prompts');
    model.cancelConfirm();
    await pending;
    assert.deepEqual(requests, [], 'reviewing or cancelling the summary never starts training');
  }
});

test('preview confirmation shows and edits the imported file that supplies the prompts', async () => {
  const { model, focused } = application('moss-image-lora');
  model.form.sample_prompts = './prompts.json';
  const pending = model.startTraining();
  await turn();
  const field = model.confirmDialog.fields[2];
  assert.equal(field.value, './prompts.json');
  model.confirmSecondaryAction();
  await pending;
  model.confirmAfterClose();
  assert.deepEqual(focused, ['sample_prompts']);
});

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

test('edits during preflight do not submit a configuration that was not checked', async () => {
  const pending = deferred();
  const { model, requests, errors } = application();
  let checked;
  model.refreshOutputPathInfo = async form => { checked = form; return pending.promise; };
  const start = model.startTraining();
  await turn();
  model.form.output_name = 'changed-during-check';
  pending.resolve({ available: true, writable: true });
  await start;
  assert.equal(checked.output_name, 'portrait_v3');
  assert.deepEqual(requests, []);
  assert.equal(errors[0][0], 'training.preflightChanged');
  assert.equal(model.trainingStarting, false);
});

test('an invalid output path is reported without waiting for a step estimate', async () => {
  const { model, errors } = application();
  let estimates = 0;
  model.refreshOutputPathInfo = async () => ({ available: false });
  model.outputPathBlockingText = () => 'output unavailable';
  model.refreshStepEstimate = async () => { estimates++; return { total_steps: 10 }; };
  await model.startTraining();
  assert.equal(estimates, 0);
  assert.equal(errors[0][0], 'output unavailable');
});

test('an invalid output path preserves a completed estimate but reschedules an interrupted one', async () => {
  for (const interrupted of [false, true]) {
    const timers = [];
    const { window } = loadFrontend(['training/preflight', 'training/toml'], {
      window: {}, setTimeout: (callback, delay) => (timers.push({ callback, delay }), timers.length), clearTimeout() {},
    });
    const app = composeMixins(window.trainingPreflight, window.trainingTomlMixin, {
      currentRoute: 'train-basic', form: { model_train_type: 'anima-lora', train_data_dir: 'C:/train' },
      stepEstimate: { total_steps: 10 }, stepEstimateLoading: interrupted,
      validateForm: () => true, _enforceCheckpointingUiConstraints() {}, _enforceMossTextEncoderFreeze() {},
      refreshOutputPathInfo: async () => ({ available: false }), outputPathBlockingText: () => 'invalid', toast() {},
    });
    app._stepEstimateSignature = JSON.stringify(app._stepEstimatePayload());
    await app.startTraining();
    assert.equal(timers.length, interrupted ? 1 : 0);
    if (interrupted) assert.equal(timers[0].delay, 500);
  }
});

test('leaving during output inspection suppresses stale errors and off-page estimates', async () => {
  for (const returned of [false, true]) {
    const output = deferred(), timers = [], notices = [];
    const { window } = loadFrontend(['training/preflight', 'training/toml'], {
      window: {}, setTimeout: (callback, delay) => (timers.push({ callback, delay }), timers.length), clearTimeout() {},
    });
    const app = composeMixins(window.trainingPreflight, window.trainingTomlMixin, {
      currentRoute: 'train-basic', _routeTransitionSeq: 1, form: { model_train_type: 'anima-lora', train_data_dir: 'C:/train' },
      validateForm: () => true, _enforceCheckpointingUiConstraints() {}, _enforceMossTextEncoderFreeze() {},
      refreshOutputPathInfo: () => output.promise, outputPathBlockingText: () => 'invalid', toast: text => notices.push(text),
    });
    const start = app.startTraining();
    app.currentRoute = 'monitor-dashboard'; app._routeTransitionSeq++; app._cancelTrainingPreflight();
    if (returned) { app.currentRoute = 'train-basic'; app._routeTransitionSeq++; }
    output.resolve(null);
    await start;
    assert.deepEqual(notices, []);
    assert.equal(timers.length, returned ? 1 : 0);
  }
});

test('step estimation reconciles subset offsets before capturing the submitted form', async () => {
  const submitted = [], notices = [];
  const { window } = loadFrontend(['training/timestep-preview', 'training/preflight', 'training/toml'], {
    window: {}, setTimeout, clearTimeout,
    fetch: async () => response({ total_steps: 10, subsets: [{ name: 'kept', is_reg: false }] }),
  });
  const app = composeMixins(window.trainingTimestepPreview, window.trainingPreflight, window.trainingTomlMixin, {
    form: { model_train_type: 'anima-lora', train_data_dir: 'C:/train', subset_timestep_offsets: { kept: '0.5', removed: 0.2 } },
    t: key => key, toast: message => notices.push(message), validateForm: () => true,
    _enforceCheckpointingUiConstraints() {}, _enforceMossTextEncoderFreeze() {},
    _collectTrainingPayload() { return { model_train_type: this.form.model_train_type, subset_timestep_offsets: this.form.subset_timestep_offsets }; },
    refreshOutputPathInfo: async () => ({ available: true, writable: true }),
    _refreshSubsetTimestepEditor() {}, _submitTraining: payload => submitted.push(payload),
  });
  await app.startTraining();
  assert.deepEqual(JSON.parse(JSON.stringify(submitted[0]._form_state.subset_timestep_offsets)), { kept: 0.5 });
  assert.deepEqual(JSON.parse(JSON.stringify(submitted[0].subset_timestep_offsets)), { kept: 0.5 });
  assert.deepEqual(notices, []);
});

test('a newer preview cannot erase offsets from the estimate used for submission', async () => {
  const output = deferred(), submitted = [];
  const { window } = loadFrontend(['training/timestep-preview', 'training/preflight', 'training/toml'], {
    window: {}, setTimeout, clearTimeout,
    fetch: async () => response({ total_steps: 10, subsets: [{ name: 'kept', is_reg: false }] }),
  });
  const app = composeMixins(window.trainingTimestepPreview, window.trainingPreflight, window.trainingTomlMixin, {
    form: { model_train_type: 'anima-lora', train_data_dir: 'C:/train', subset_timestep_offsets: { kept: 0.5 } },
    t: key => key, toast: message => assert.fail(message), validateForm: () => true,
    _enforceCheckpointingUiConstraints() {}, _enforceMossTextEncoderFreeze() {},
    _collectTrainingPayload() { return { model_train_type: this.form.model_train_type, subset_timestep_offsets: this.form.subset_timestep_offsets }; },
    refreshOutputPathInfo: () => output.promise,
    _refreshSubsetTimestepEditor() {}, _submitTraining: payload => submitted.push(payload),
  });
  const refresh = app.refreshStepEstimate.bind(app);
  app.refreshStepEstimate = async (...args) => {
    const estimate = await refresh(...args);
    app.stepEstimate = null;
    return estimate;
  };
  const start = app.startTraining();
  await turn();
  app.form.train_data_dir = '';
  app.scheduleStepEstimate();
  app.form.train_data_dir = 'C:/train';
  app.scheduleStepEstimate();
  output.resolve({ available: true, writable: true });
  await start;
  clearTimeout(app._stepEstimateTimer);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted[0].subset_timestep_offsets)), { kept: 0.5 });
});

test('editing the form before preview confirmation cancels the pending submission', async () => {
  const { model, requests, errors } = application();
  const start = model.startTraining();
  await turn();
  model.form.output_name = 'changed-before-confirm';
  await model.confirmAction();
  await start;
  assert.deepEqual(requests, []);
  assert.equal(errors[0][0], 'training.preflightChanged');
});

test('opening stop only reads choices, confirming twice sends one graceful command', async () => {
  const pending = deferred(), requests = [];
  const state = {allowed: ['stop'], command: null};
  const { window } = loadFrontend('training/run-control', { window: {}, fetch: (url, options) => {
    requests.push([url, options && JSON.parse(options.body)]);
    return options ? pending.promise : Promise.resolve({ok:true, json: async () => state});
  } });
  const app = composeMixins(window.trainingControlMixin, {
    liveTaskId: 'task-a', t: key => key, toast() {}, _wakeTrainingStatePoll() {},
  });
  await app.stopTraining();
  assert.equal(app.controlDialog, 'stop');
  assert.equal(app.controlSaveWeights, false);
  assert.equal(app.controlSaveState, false);
  assert.deepEqual(requests, [['/api/monitor/control/task-a?prompts=false', undefined]]);
  const stop = app.submitTrainingControl('stop');
  await app.submitTrainingControl('stop');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1][1], {action:'stop', mode:'discard'});
  pending.resolve({ ok: true, json: async () => state });
  await stop;
  assert.equal(app.controlDialog, '');
});

test('each stop dialog starts with both saves off and submits the selected combination', async () => {
  const posts = [];
  const {window} = loadFrontend('training/run-control', {window: {}, fetch: async (_, options) => {
    if (options) posts.push(JSON.parse(options.body));
    return {ok:true, json:async () => ({allowed:['stop'], command:null})};
  }});
  const app = composeMixins(window.trainingControlMixin, {
    liveTaskId:'running', t:k => k, toast() {}, _wakeTrainingStatePoll() {},
  });
  for (const [weights, state, mode] of [[true,true,'both'], [false,true,'state'], [true,false,'weights'], [false,false,'discard']]) {
    await app.stopTraining();
    assert.equal(app.controlSaveWeights, false);
    assert.equal(app.controlSaveState, false);
    app.controlSaveWeights = weights;
    app.controlSaveState = state;
    await app.submitTrainingControl('stop');
    assert.deepEqual(posts.at(-1), {action:'stop', mode});
  }
  assert.equal(posts.length, 4);
});

test('one force click targets the open stop dialog even when graceful stop is unavailable', async () => {
  const posts = [], pending = deferred();
  const {window} = loadFrontend('training/run-control', {window: {}, fetch: async (_, options) => {
    if (options) {
      posts.push(JSON.parse(options.body));
      return pending.promise;
    }
    return {ok:true, json:async () => ({allowed:[], command:{id:'1', status:'pending'}})};
  }});
  const app = composeMixins(window.trainingControlMixin, {
    liveTaskId:'running', t:k => k, toast() {}, _wakeTrainingStatePoll() {},
  });
  await app.submitTrainingControl('force');
  await app.stopTraining();
  await app.submitTrainingControl('stop');
  await app.submitTrainingControl('force', 'another-task');
  app.controlDialog = '';
  await app.submitTrainingControl('force');
  assert.deepEqual(posts, []);
  await app.stopTraining();
  app.controlSaveWeights = app.controlSaveState = true;
  const force = app.submitTrainingControl('force');
  await app.submitTrainingControl('force');
  await app.submitTrainingControl('stop');
  assert.deepEqual(posts, [{action:'force'}]);
  pending.resolve({ok:true, json:async () => ({status:'success'})});
  await force;
  assert.equal(app.controlDialog, '');
});

test('manual preview reuses preset index when unchanged and inherits selected preset via base_index when edited', async () => {
  const posts = [];
  const state = {
    state: 'running',
    allowed: ['sample', 'stop'],
    new_prompt: true,
    external_encoder: true,
    preview_defaults: { width: 1024, height: 1024, scale: 4.0, sample_steps: 20 },
    prompts: [
      { prompt: 'first prompt', width: 1024, height: 1024, scale: 4.0, seed: 11, sample_steps: 20 },
      { prompt: 'second prompt', width: 768, height: 512, scale: 5.5, negative_prompt: 'bad', seed: 77, sample_steps: 0 },
    ],
    command: null,
  };
  const { window } = loadFrontend('training/run-control', {
    window: {},
    fetch: async (_, options) => {
      if (options) posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => state };
    },
  });
  const app = composeMixins(window.trainingControlMixin, {
    liveTaskId: 'run-1', t: k => k, toast() {}, _wakeTrainingStatePoll() {},
  });

  await app.openTrainingControl('sample');
  assert.equal(app.controlIndex, '0');
  assert.equal(app.controlPrompt, 'first prompt');
  assert.equal(app.controlUsesText, false);

  app.selectControlPrompt('1');
  assert.equal(app.controlPrompt, 'second prompt');
  assert.equal(app.controlActiveTemplate.width, 768);
  assert.equal(app.controlStepsPlaceholder, 'control.modelDefaultSteps');
  await app.submitTrainingControl('sample');
  assert.deepEqual(posts.at(-1), { action: 'sample', index: 1 });

  await app.openTrainingControl('sample');
  app.selectControlPrompt('1');
  app.controlPrompt = 'second prompt, sunset light';
  app.controlSeed = '-9223372036854775808';
  assert.equal(app.controlPromptModified, true);
  assert.equal(app.controlStepsPlaceholder, 'control.modelDefaultSteps');
  assert.equal(app.controlUsesText, true);
  await app.submitTrainingControl('sample');
  assert.deepEqual(posts.at(-1), { action: 'sample', prompt: 'second prompt, sunset light', base_index: 1, seed: '-9223372036854775808' });
});
