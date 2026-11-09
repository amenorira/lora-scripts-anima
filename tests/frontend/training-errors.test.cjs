const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function app(messages) {
  const context = loadFrontend(['training/toml'], { window: {} });
  return Object.assign({}, context.window.trainingTomlMixin, {
    t: (key, fallback) => messages[key] ?? fallback ?? key,
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
  model.openConfirm = (_title, message, rebuild, _label, options) => {
    assert.equal(message, '2 image, 1 text\nC:/train/1_data\nD:/reg/1_data\n\nTraining note');
    assert.equal(options.danger, true);
    assert.equal(requests.length, 0);
    model.form = { train_data_dir: 'C:/other' };
    rebuild();
    options.secondaryCallback();
  };
  model._showCacheRebuildDialog({
    latents: 2, text: 1, directories: ['C:/train/1_data', 'D:/reg/1_data'], scope: 'confirmed',
  }, payload, request => requests.push(request));
  assert.deepEqual(requests.map(request => [request.train_data_dir, request._cache_action]), [
    ['C:/train', 'confirmed'],
    ['C:/train', 'keep'],
  ]);
});
