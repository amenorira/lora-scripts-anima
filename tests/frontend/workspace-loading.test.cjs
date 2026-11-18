const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, deferred } = require('./helpers.cjs');

test('concurrent template mounts share a request and retry after failure', async () => {
  const pending = deferred(), initialized = [], children = [{}, {}];
  const host = { dataset: {}, children, innerHTML: '' };
  let reads = 0;
  const { window } = loadFrontend('shared/utils', {
    window: {}, Alpine: { initTree: node => initialized.push(node) },
    fetch: () => ++reads === 1 ? pending.promise : Promise.resolve({ ok: true, text: async () => '<div></div>' }),
  });
  const first = window.mountWorkspaceTemplate(host, '/template', 'failed', true);
  const second = window.mountWorkspaceTemplate(host, '/template', 'failed', true);
  pending.resolve({ ok: false });
  assert.deepEqual((await Promise.allSettled([first, second])).map(result => result.status), ['rejected', 'rejected']);
  assert.equal(reads, 1);
  await window.mountWorkspaceTemplate(host, '/template', 'failed', true);
  await window.mountWorkspaceTemplate(host, '/template', 'failed', true);
  assert.equal(reads, 2);
  assert.deepEqual(initialized, children);
  assert.equal(host.dataset.mounted, '1');
});

test('caption template failure does not block tagger and can be retried', async () => {
  const mount = { dataset: {}, children: [], innerHTML: '' };
  const host = { dataset: {}, innerHTML: '', querySelector: () => mount };
  const requests = [];
  let captionAttempts = 0;
  const { window } = loadFrontend('tagger/index', {
    window: {}, document: { getElementById: () => host }, Alpine: { initTree() {} },
    fetch: async url => {
      requests.push(url);
      const caption = url.endsWith('/caption-workspace.html');
      return { ok: !caption || ++captionAttempts > 1, text: async () => '<div></div>' };
    },
  });
  const app = composeMixins(window.taggerMixin, { t: key => key });
  await app._mountTaggerWorkspace('tagger');
  assert.equal(requests.length, 1);
  await assert.rejects(app._mountTaggerWorkspace('ai-captioning'), /caption.workspaceLoadFailed/);
  await app._mountTaggerWorkspace('tagger');
  await app._mountTaggerWorkspace('ai-captioning');
  assert.equal(requests.length, 3);
  assert.equal(host.dataset.mounted, '1');
  assert.equal(mount.dataset.mounted, '1');
});

test('a failed regularization template remains unmounted and retries successfully', async () => {
  const host = { dataset: {}, innerHTML: '' };
  let attempts = 0;
  const { window } = loadFrontend('regularization/index', {
    window: {}, document: { getElementById: () => host }, Alpine: { initTree() {} },
    localStorage: { getItem: () => null },
    fetch: async () => ({ ok: ++attempts > 1, text: async () => '<div>workspace</div>' }),
  });
  const app = composeMixins(window.regularizationMixin, {
    currentRoute: 'regularization', _regLoaded: true, regRuns: [], t: key => key,
    regRenderControls() {}, realtimeSubscribe() {}, renderRegularizationResourceBar() {},
    regRefreshRuns: async () => {}, regScheduleScan() {},
  });
  await app.buildRegularizationForm();
  assert.equal(host.dataset.mounted, undefined);
  assert.equal(app.regWorkspaceError, 'common.requestFailed');
  await app.buildRegularizationForm();
  assert.equal(host.dataset.mounted, '1');
  assert.equal(app.regWorkspaceError, '');
  assert.equal(attempts, 2);
});

function regularizationRestoreHarness() {
  const requests = [], detailPaths = [], storage = new Map(), results = [], host = { dataset: { mounted: '1' } };
  const { window } = loadFrontend('regularization/index', {
    window: {}, document: { getElementById: () => host }, clearTimeout, clearInterval,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  });
  const app = composeMixins(window.regularizationMixin, {
    currentRoute: 'regularization', _regLoaded: true, regDefaults: {}, regSettings: {},
    regRequest(path) {
      if (path === '/runs') { const pending = deferred(); requests.push(pending); return pending.promise; }
      detailPaths.push(path);
      return Promise.resolve({ settings: { seed: '1', source_dir: 'new-source' } });
    },
    regRenderControls() {}, regSyncTimer() {},
    realtimeSubscribe() {}, realtimeUnsubscribe() {}, renderRegularizationResourceBar() {}, regLoadLogs: async () => {},
    regLoadResults: async () => results.push('loaded'), regReportError: error => assert.fail(error),
  });
  return { app, requests, detailPaths, storage, results, loadResults: window.regularizationMixin.regLoadResults };
}

test('an earlier regularization build cannot replace a newer restored run', async () => {
  const { app, requests, storage } = regularizationRestoreHarness();
  const oldBuild = app.buildRegularizationForm();
  app.currentRoute = 'home';
  app.stopRegularizationWorkspace();
  app.currentRoute = 'regularization';
  const newBuild = app.buildRegularizationForm();
  requests[1].resolve([{ run_key: 'new', task_id: 'new-task', status: 'running' }]);
  await newBuild;
  requests[0].resolve([{ run_key: 'old', task_id: 'old-task', status: 'running' }]);
  await oldBuild;
  assert.equal(app.regRunKey, 'new');
  assert.equal(app.regSettings.source_dir, 'new-source');
  assert.equal(storage.get('anima-reg-run'), 'new');
  assert.equal(app.regRuns[0].run_key, 'new');
});

test('switching tabs during restore claims the active run and loads results once', async () => {
  const { app, requests, results } = regularizationRestoreHarness();
  const build = app.buildRegularizationForm(), inspect = app.regInspect();
  assert.equal(requests.length, 1);
  requests[0].resolve([{ run_key: 'active', task_id: 'job', status: 'running' }]);
  await Promise.all([build, inspect]);
  assert.equal(app.regRunKey, 'active');
  assert.equal(app.regTask.task_id, 'job');
  assert.deepEqual(results, ['loaded']);
});

test('restoring an active run on inspect restores settings before loading results', async () => {
  const { app, requests, detailPaths, loadResults } = regularizationRestoreHarness();
  let resultReads = 0;
  app.regLoadResults = loadResults;
  app.regFetchItems = async () => {
    resultReads++;
    return { items: [], total: 0, settings: { seed: '7', source_dir: 'saved' },
      summary: { run_key: 'active', task_id: 'job', status: 'running' } };
  };
  const build = app.buildRegularizationForm(), inspect = app.regInspect();
  requests[0].resolve([{ run_key: 'active', task_id: 'job', status: 'running' }]);
  await Promise.all([build, inspect]);
  assert.equal(resultReads, 1);
  assert.deepEqual(detailPaths, ['/runs/active/items?limit=1']);
  assert.equal(app.regSettings.seed, '7');
  assert.equal(app.regSettings.source_dir, 'saved');
});

test('switching to settings while restoring results does not reread logs', async () => {
  const { app, requests } = regularizationRestoreHarness();
  const results = deferred();
  let logReads = 0;
  app.regTab = 'inspect';
  app.regLoadResults = () => results.promise;
  app.regLoadLogs = async () => { logReads++; };
  const build = app.buildRegularizationForm();
  requests[0].resolve([{ run_key: 'active', task_id: 'job', status: 'running' }]);
  await new Promise(resolve => setImmediate(resolve));
  app.regShowSettings();
  results.resolve();
  await build;
  assert.equal(logReads, 1);
});

test('switching to inspect while restored logs are loading loads the results', async () => {
  const { app, requests, storage, results } = regularizationRestoreHarness();
  const logs = deferred();
  storage.set('anima-reg-run', 'old');
  app.regLoadLogs = () => logs.promise;
  const build = app.buildRegularizationForm();
  requests[0].resolve([{ run_key: 'old', task_id: 'job', status: 'finished' }]);
  await new Promise(resolve => setImmediate(resolve));
  const inspect = app.regInspect();
  requests[1].resolve([{ run_key: 'old', task_id: 'job', status: 'finished' }]);
  await inspect;
  logs.resolve();
  await build;
  assert.deepEqual(results, ['loaded']);
});

test('a late inspect request cannot load results after leaving the workspace', async () => {
  const { app, requests, results } = regularizationRestoreHarness();
  app.regRunKey = 'active';
  const inspect = app.regInspect();
  app.currentRoute = 'home';
  app.stopRegularizationWorkspace();
  requests[0].resolve([{ run_key: 'active', task_id: 'job', status: 'running' }]);
  await inspect;
  assert.deepEqual(results, []);
});

test('a failed inspect request does not report a stale error after leaving', async () => {
  const { app, requests } = regularizationRestoreHarness();
  const inspect = app.regInspect();
  app.currentRoute = 'home';
  app.stopRegularizationWorkspace();
  requests[0].reject(new Error('old request'));
  await inspect;
});
