const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, deferred } = require('./helpers.cjs');

function app(messages) {
  const context = loadFrontend(['training/toml'], { window: {} });
  return Object.assign({}, context.window.trainingTomlMixin, {
    t: (key, fallback) => messages[key] ?? fallback ?? key,
    _applyTaskView() {},
  });
}

test('training errors localize structured parameters without rewriting diagnostic content', () => {
  const model = app({ 'training.errors.outputDirectoryUnavailable': '出力先に書き込めません：{path}' });
  let shown;
  model.toast = (...args) => { shown = args; };
  model._showTrainingError({ message: 'English / 中文', data: {
    errorCode: 'outputDirectoryUnavailable', errorParams: { path: 'C:/data/$&/{path}' },
    errorDetails: ['Permission denied', 'WinError 5'],
  } });
  assert.equal(shown[0], '出力先に書き込めません：C:/data/$&/{path}');
  assert.equal(shown[1], 'error');
  assert.equal(shown[2].details, 'Permission denied\nWinError 5');
  assert.equal(model._trainingErrorText({ message: 'legacy diagnostic', data: { errorCode: 'newUnknownCode' } }), 'legacy diagnostic');
});

test('cache rebuild dialog uses the server scope and the original training request', () => {
  const model = app({
    'trainingCache.scope': '{latents} image, {text} text\n{directories}',
    'trainingCache.trainingNote': 'Training note',
  });
  const requests = [];
  const payload = { train_data_dir: 'C:/train' };
  model.openConfirm = options => {
    assert.equal(options.message, '2 image, 1 text\nC:/train/1_data\nD:/reg/1_data\n\nTraining note');
    assert.equal(options.tone, 'danger');
    assert.equal(requests.length, 0);
    model.form = { train_data_dir: 'C:/other' };
    options.onConfirm();
    options.onSecondary();
  };
  model._showCacheRebuildDialog({
    latents: 2, text: 1, directories: ['C:/train/1_data', 'D:/reg/1_data'], scope: 'confirmed',
  }, payload, request => requests.push(request));
  assert.deepEqual(requests.map(request => [request.train_data_dir, request._cache_action]), [
    ['C:/train', 'confirmed'],
    ['C:/train', 'keep'],
  ]);
});

const cacheFound = {
  status: 'fail',
  data: { errorCode: 'trainingCacheFound', latents: 2, text: 1, directories: ['C:/train/1_data'], scope: 'confirmed' },
};
const response = body => ({ ok: true, json: async () => body });
const activePreparation = { status: 'success', data: { tasks: { managed: [{ id: 'preparation', status: 'CREATED' }] } } };

function cacheFlowApp(profile, fetch) {
  const context = loadFrontend(['monitor/core', 'training/toml', 'shared/confirmation-dialog'], {
    window: {}, fetch, setTimeout, clearTimeout, AbortController,
    Date: class extends Date { static now() { return 100; } },
  });
  const { window } = context;
  return Object.assign({}, window.monitorCoreMixin, window.trainingTomlMixin, window.confirmationDialogMixin, {
    form: { model_train_type: profile },
    t: key => ({ 'trainingCache.scope': '{latents} image, {text} text\n{directories}' }[key] || key),
    validateForm: () => true,
    ensureKreaDitFormat: async () => true,
    refreshOutputPathInfo: async () => ({ available: true, writable: true }),
    refreshStepEstimate: async () => ({ total_steps: 1 }),
    _collectTrainingPayload: () => ({ model_train_type: profile, train_data_dir: 'C:/train' }),
    _collectTrainingFormSnapshot: () => ({ model_train_type: profile }),
    _setMonitorRealtimeTask() {}, _invalidatePreviewRequest() {}, _resetOutputFilesForRun() {},
    _cancelPreviewMediaQueue() {}, _releasePreviewMediaObjectUrls() {},
    toast() {}, currentRoute: 'train-basic',
  });
}

for (const [profile, method, endpoint] of [
  ['anima-lora', 'startTraining', '/api/run'],
  ['krea2-lora', 'prepareKrea2Cache', '/api/training/krea2/cache'],
]) {
  for (const [action, confirmedAction] of [['confirmAction', 'confirmed'], ['confirmSecondaryAction', 'keep']]) {
    for (const [pollOrder, timing] of [
      ['before', 'before cache confirmation'],
      ['after', 'after confirmation but before the choice'],
      ['after-choice', 'after the choice'],
    ]) {
      test(`${method}: ${action} works when the preparation status arrives ${timing}`, async () => {
        const first = deferred(), poll = deferred(), started = deferred();
        const requests = [], messages = [];
        let stateRequests = 0;
        const model = cacheFlowApp(profile, async (url, options) => {
          if (url.startsWith('/api/realtime/state')) {
            if (++stateRequests === 1) return poll.promise;
            return response({ status: 'success', data: { tasks: { managed: [{ id: 'started-task', status: 'RUNNING' }] } } });
          }
          assert.equal(url, endpoint);
          requests.push(JSON.parse(options.body));
          if (requests.length === 1) { started.resolve(); return first.promise; }
          return response({ status: 'success', data: { task_id: 'started-task' } });
        });
        model.toast = (...message) => messages.push(message);

        const submission = model[method]();
        await started.promise;
        await model[method]();
        assert.equal(requests.length, 1, 'repeated clicks during the request are ignored');
        const stateRequest = model._pollTrainingState();
        if (pollOrder === 'before') {
          poll.resolve(response(activePreparation));
          await stateRequest;
          assert.equal(model.isTraining, true);
        }
        first.resolve(response(cacheFound));
        await submission;
        assert.equal(model.showConfirmModal, true);
        assert.equal(model.isTraining, false);
        assert.deepEqual(messages, []);
        await model[method]();
        assert.equal(requests.length, 1, 'a pending confirmation blocks another start');
        if (pollOrder === 'after') {
          poll.resolve(response(activePreparation));
          await stateRequest;
          assert.equal(model.isTraining, false, 'an outdated preparation cannot block confirmation');
        }

        model[action]();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(model.showConfirmModal, false);
        assert.equal(requests.length, 2);
        assert.equal(requests[1]._cache_action, confirmedAction);
        assert.equal(requests[1].train_data_dir, 'C:/train');
        assert.equal(model.liveTaskId, 'started-task');
        if (pollOrder === 'after-choice') {
          poll.resolve(response(activePreparation));
          await stateRequest;
          assert.equal(model.liveTaskId, 'started-task', 'the old preparation cannot replace the new task');
        }
        await model._pollTrainingState();
        assert.equal(model.monitorData.state, 'RUNNING', 'subsequent polls still update the started task');
      });
    }
  }

  test(`${method}: cancelling the cache confirmation allows a new start`, async () => {
    let requests = 0;
    const model = cacheFlowApp(profile, async () => { requests++; return response(cacheFound); });
    await model[method]();
    assert.equal(model.showConfirmModal, true);
    model.cancelConfirm();
    model.confirmAfterClose();
    await model[method]();
    assert.equal(requests, 2);
    assert.equal(model.showConfirmModal, true);
  });
}
