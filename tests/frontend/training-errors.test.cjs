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

test('cache rebuilding notice names both directory trees and all profile caches', () => {
  const model = app({ 'teCache.warn.rateMismatch': 'Changed {count}',
    'teCache.deleteScope': 'All Anima, SDXL and MOSS caches in these trees:\n{directories}' });
  model.form = { train_data_dir: 'C:/train', enable_reg_data: true, reg_data_dir: 'D:/reg' };
  let message;
  model.openConfirm = (_title, text) => { message = text; };
  model._showTeCacheStaleDialog([{ code: 'rateMismatch', count: 2 }]);
  assert.equal(message, 'Changed 2\n\nAll Anima, SDXL and MOSS caches in these trees:\nC:/train\nD:/reg');
});
