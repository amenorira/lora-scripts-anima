const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend, composeMixins } = require('./helpers.cjs');

loadGlobalFrontend(['shared/utils', 'monitor/logs', 'monitor/diagnostics']);

test('API errors translate known codes and parameters while preserving unknown messages and details', () => {
  const messages = { 'errors.example': 'Could not read {path}; {count} files remain.', 'common.requestFailed': 'Request failed' };
  const app = Object.assign({}, window.utilsMixin, { t: key => messages[key] || key });
  const body = { error_code: 'example', error_params: { path: '训练/a.txt', count: 2 }, error_details: 'Permission denied' };
  assert.equal(app.localizeApiError(body), 'Could not read 训练/a.txt; 2 files remain.');
  assert.equal(app.apiErrorDetails(body), 'Permission denied');
  assert.equal(app.localizeApiError({ data: { errorCode: 'example', errorParams: { path: 'x', count: 1 } } }), 'Could not read x; 1 files remain.');
  assert.equal(app.localizeApiError({ error_code: 'unrecognized', message: 'third-party failure' }), 'third-party failure');
  app.t = key => key === 'errors.constructor' ? Object : (messages[key] || key);
  assert.equal(app.localizeApiError({ error_code: 'constructor', message: 'original failure' }), 'original failure');
  assert.equal(app.localizeApiError({}), 'Request failed');
});

test('history and finished runs use retrospective advice, while live runs keep their own advice', () => {
  const advice = { textContent: '' };
  const root = { dataset: {}, querySelector: selector => selector === '[data-diagnostic-field="advice"]' ? advice : null };
  const app = Object.assign(Object.create(window.monitorDiagnosticsMixin), {
    monitorLossSeries: [], lossDataVersion: 0,
    _summaryStatus: data => ({ terminal: !!data.terminal }),
  });
  const t = (key, fallback) => key === 'diagnosticHistoryAdvice' ? 'history advice' : fallback || key;
  app._patchTrainingDiagnostics(root, t, {}, true);
  assert.equal(advice.textContent, 'history advice');
  app.lossDataVersion++;
  app._patchTrainingDiagnostics(root, t, { terminal: true }, false);
  assert.equal(advice.textContent, 'history advice');
  app.lossDataVersion++;
  app._patchTrainingDiagnostics(root, t, {}, false);
  assert.notEqual(advice.textContent, 'history advice');
});

function logApp() {
  const notices = [];
  const frame = {};
  global.document = { getElementById: () => null, createElement: tag => {
    assert.equal(tag, 'iframe');
    return frame;
  }, body: {appendChild: () => {}} };
  const messages = { 'errors.monitorLogNotFound': 'Log not found',
    'monitor.logDownloadFailed': 'Download failed' };
  const app = composeMixins(window.utilsMixin, window.monitorLogCoreMixin, window.monitorLogRenderMixin, {
    selectedRunDir: 'output/run', t: key => messages[key] || key,
    toast: (...args) => notices.push(args),
  });
  return { app, notices, frame };
}

test('native log download leaves the app open and reports errors from the actual response', () => {
  const { app, notices, frame } = logApp();
  app.downloadLogs();
  assert.match(frame.src, /^\/api\/monitor\/log-download\?/);
  assert.equal(notices.length, 0);
  frame.contentDocument = {URL:'about:blank'};
  frame.onload();
  assert.equal(notices.length, 0);
  frame.contentDocument = {querySelector: () => ({textContent:JSON.stringify({error_code:'monitorLogNotFound'})})};
  frame.onload();
  assert.equal(notices[0][0], 'Log not found');
  assert.equal(notices[0][1], 'error');
});

test('log errors from an old source do not appear on the newly selected run', () => {
  const { app, notices, frame } = logApp();
  app.downloadLogs();
  app.selectedRunDir = 'output/other';
  frame.onload();
  assert.deepEqual(notices, []);
});
