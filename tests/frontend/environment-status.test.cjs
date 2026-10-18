const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo } = require('./helpers.cjs');

function createApp(extra = {}) {
  const { window } = loadFrontend(['utils', 'training-core', 'environment-core', 'environment-render', 'tag-dictionary'], { window: {}, ...extra });
  const messages = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
  return Object.assign({}, window.utilsMixin, window.trainingCoreMixin, window.environmentCoreMixin,
    window.environmentRenderMixin, window.tagDictionaryMixin, {
      t: key => key.split('.').reduce((value, part) => value?.[part], messages) || key,
      _envCardOverrides: {}, renderEnvironment() {},
    });
}
const translate = app => key => app.t('environment.' + key);

test('completed detection never promises training readiness; failures and active jobs stay visible', () => {
  const app = createApp();
  Object.assign(app, { xfStatus: { installed: false }, tritonStatus: { installed: false },
    sdStatus: {}, trainingCores: { engines: [], adapters: [] }, animaModelStatus: [], tagDictionaryServer: { installed: false } });
  const T = translate(app);
  assert.match(app._renderOverview(T), /检测完成/);
  assert.doesNotMatch(app._renderOverview(T), /运行正常|0\/3|0\/8/);
  assert.doesNotMatch(app._renderSdRow(T), /加载中/);
  assert.doesNotMatch(app._renderLycorisRow(T), /加载中/);
  app.sdError = 'HTTP 503';
  assert.match(app._renderOverview(T), /需要处理/);
  assert.match(app._renderSdRow(T), /HTTP 503/);
  app.sdError = null;
  app.animaModelBusy = true;
  assert.match(app._renderOverview(T), /有任务进行中/);
});

test('failed status queries stop loading and offer refresh without an uninformed install action', async () => {
  const app = createApp({ fetch: async () => ({ ok: false, status: 503 }) });
  await app.tritonRefresh(true);
  assert.match(app.tritonError, /503/);
  const html = app._renderTritonRow(translate(app));
  assert.match(html, /操作失败/);
  assert.doesNotMatch(html, /加载中|data-env-action="triton"/);
  assert.match(html, /id="triton-refresh-btn"/);
});

test('unknown dictionary versions check before updating; unavailable status refreshes instead of downloading', async () => {
  const app = createApp();
  const calls = [];
  app.tagDictionaryCheckUpdate = () => calls.push('check');
  app.tagDictionaryInstall = () => calls.push('install');
  app.tagDictionaryServer = { installed: true, update: { state: 'unknown' } };
  assert.equal(app.tagDictionaryDataActionLabel(), app.t('environment.dictCheckUpdate'));
  app.tagDictionaryDataAction();
  assert.deepEqual(calls, ['check']);
  app.tagDictionaryServer.update.state = 'available';
  app.tagDictionaryDataAction();
  assert.deepEqual(calls, ['check', 'install']);
  app.tagDictionaryServer.update.state = 'error';
  assert.match(app._renderDictionaryRow(translate(app)), /env-badge-err/);
  app.tagDictionaryServer = null;
  app.tagDictionaryFailed = true;
  app.tagDictionaryRefreshStatus = async () => { calls.push('refresh'); return null; };
  app._tdRefreshPanelRow = () => {};
  await app.tagDictionaryDataAction();
  assert.deepEqual(calls, ['check', 'install', 'refresh']);
  const html = app._renderDictionaryRow(translate(app));
  assert.ok(html.includes(app.t('tagEditor.dictStatusUnavailable')));
  assert.doesNotMatch(html, /dictionary-redownload/);
});

test('a single file request immediately identifies its own progress and leaves unrelated files unqueued', async () => {
  let resolve;
  const app = createApp({ fetch: () => new Promise(done => { resolve = done; }) });
  Object.assign(app, { startProgress() {}, _envForceOpen() {}, _setEnvironmentRealtimeTask() {},
    animaModelStatus: [
      { filename: 'a.safetensors', group: 'Anima', component_type: 'model', exists: false },
      { filename: 'b.safetensors', group: 'Anima', component_type: 'encoder', exists: false },
    ] });
  const pending = app.animaModelDownload('a.safetensors', 'Anima');
  assert.equal(app.animaModelProgress.filename, 'a.safetensors');
  assert.equal(app._envDefaultCardOpen('animaModel'), true);
  assert.equal(app._envDefaultCardOpen('moss'), false);
  assert.equal(app._computeAnimaAggregate(app.animaModelProgress).fileTotal, 1);
  const html = app._renderModelGroup(translate(app), 'Anima');
  assert.doesNotMatch(html, /排队中/);
  resolve({ json: async () => ({ success: true, job_id: 'file-job' }) });
  await pending;
});

test('dictionary query failure is visible even with a previously installed cache', async () => {
  const app = createApp({ fetch: async () => ({ ok: false }), AbortSignal: { timeout: () => undefined } });
  app.tagDictionaryServer = { installed: true, update: { state: 'current' } };
  await app.tagDictionaryRefreshStatus();
  assert.equal(app.tagDictionaryDataState(), 'error');
  assert.equal(app.tagDictionaryDataActionLabel(), app.t('environment.refresh'));
  const html = app._renderDictionaryRow(translate(app));
  assert.doesNotMatch(html, /已是最新|dictionary-redownload/);
  assert.ok(html.includes(app.t('tagEditor.dictStatusUnavailable')));
});

test('model download failures keep their error after status refresh without claiming installation failed', async () => {
  const app = createApp();
  const notices = [];
  Object.assign(app, { _setEnvironmentRealtimeTask() {}, finishProgress() {}, scheduleEnvironmentRender() {},
    toast: text => notices.push(text), animaModelRefresh: async () => { app.animaModelError = null; } });
  await app._finalizeEnvironmentRealtimeTask('animaModel', { progress: { error: 'Connection interrupted' } }, true);
  assert.equal(app.animaModelError, 'Connection interrupted');
  assert.deepEqual(notices, [app.t('environment.animaModel.failed')]);
  assert.equal(app.animaModelBusy, false);
});
