const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred, response, readRepo} = require('./helpers.cjs');

function harness() {
  const requests = [], renders = [];
  const {window} = loadFrontend(['shared/realtime', 'monitor/logs', 'monitor/core'], {
    window: {}, document: {getElementById: () => null},
    AbortController, URLSearchParams, setTimeout, clearTimeout,
    fetch: url => { const pending = deferred(); requests.push({url, ...pending}); return pending.promise; },
  });
  const app = composeMixins(window.realtimeMixin, window.monitorCoreMixin, {
    currentRoute: 'monitor-dashboard', liveTaskId: 'A', taskId: 'A',
    monitorData: {state: 'RUNNING', active_task: {id: 'A'}},
    renderDashboard: () => renders.push(app.currentRoute), scheduleRender() {},
    realtimeSubscribe() {}, realtimeUnsubscribe() {}, refreshMonitorRealtimeDetail() {}, t: key => key,
  });
  return {app, requests, renders, core: window.monitorCoreMixin};
}

test('preview responses from a previous task are ignored before either run directory is known', async () => {
  const {app, requests} = harness();
  const pending = app.refreshPreviews();
  app.beginLiveMonitorTask('B', 'CREATED');
  requests[0].resolve(response([{name: 'old-task.png'}]));
  await pending;
  assert.deepEqual(Array.from(app.previews), []);
  assert.equal(app.liveTaskId, 'B');
});

test('a new task can refresh immediately and an old response cannot clear its loading state', async () => {
  const {app, requests} = harness();
  const old = app.refreshPreviews();
  app.beginLiveMonitorTask('B', 'CREATED');
  const current = app.refreshPreviews();
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /task_id=B/);
  requests[0].resolve(response([{name: 'old-task.png'}]));
  await old;
  assert.equal(app.previewsLoading, true);
  requests[1].resolve(response([{name: 'new-task.png'}]));
  await current;
  assert.equal(app.previewsLoading, false);
  assert.equal(app.previews[0].name, 'new-task.png');
});

function detailHarness(source) {
  const fixture = harness();
  const {app} = fixture;
  Object.assign(app, {
    liveTaskId: null, taskId: null,
    monitorData: {state: 'FINISHED', detail: true, run_dir: 'output/A', active_task: {id: 'A'}},
    startProgress() {}, finishProgress() {}, toast() {},
    refreshMonitorRealtimeDetail: fixture.core.refreshMonitorRealtimeDetail,
    _saveRealtimeInstanceId() {},
    _observeMonitorClock() {}, _ingestMonitorPerfSamples() {}, _recordMonitorPerfSample() {},
    _applyMonitorLogSnapshot() {},
  });
  if (source === 'history') app.selectedRunDir = 'output/A';
  if (source === 'live') {
    app.liveTaskId = app.taskId = 'A';
    app.monitorData.state = 'RUNNING';
  }
  return fixture;
}

for (const source of ['history', 'completed', 'live']) {
  for (const startsFirst of ['refresh', 'detail']) {
    for (const returnsFirst of ['refresh', 'detail']) {
      test(`${source} previews keep the forced refresh when ${startsFirst} starts first and ${returnsFirst} returns first`, async () => {
        const {app, requests} = detailHarness(source);
        const pending = {};
        const start = kind => {
          pending[kind] = kind === 'refresh' ? app.refreshPreviews()
            : source === 'history' ? app._fetchRunDetail('output/A') : app.refreshMonitorRealtimeDetail();
        };
        start(startsFirst);
        start(startsFirst === 'refresh' ? 'detail' : 'refresh');
        assert.equal(requests.length, 2);
        const refresh = requests.find(item => item.url.includes('/monitor/previews?'));
        const detail = requests.find(item => !item.url.includes('/monitor/previews?'));
        assert.ok(refresh && detail);
        assert.match(refresh.url, /refresh=1/);
        assert.match(detail.url, source === 'live' ? /\/realtime\/snapshot\?detail=true/ : /\/monitor\/run-detail\?/);
        const data = {detail: true, active_task: {id: 'A'}, run_dir: 'output/A',
          previews: [{name: 'cached.png'}], tensorboard_loss: [], log_lines: []};
        const resolve = async kind => {
          if (kind === 'refresh') refresh.resolve(response([{name: 'cached.png'}, {name: 'latest.png'}]));
          else detail.resolve(response(source === 'live' ? {monitor: data} : data));
          await pending[kind];
        };
        await resolve(returnsFirst);
        assert.equal(app.previewsLoading, returnsFirst !== 'refresh');
        if (returnsFirst === 'detail') {
          assert.deepEqual(Array.from(app.previews, item => item.name), startsFirst === 'refresh' ? ['cached.png'] : []);
        }
        await resolve(returnsFirst === 'refresh' ? 'detail' : 'refresh');
        assert.deepEqual(Array.from(app.previews, item => item.name), ['cached.png', 'latest.png']);
        assert.equal(app.previewStep, 1);
        assert.equal(app.previewsLoading, false);
        if (returnsFirst === 'refresh') {
          assert.deepEqual(Array.from(app.currentArtifactData().previews, item => item.name), ['cached.png', 'latest.png']);
        }
      });
    }
  }
}

test('a failed refresh releases loading after a detail snapshot and can be retried', async () => {
  const {app, requests} = detailHarness('completed');
  const refresh = app.refreshPreviews();
  const detail = app.refreshMonitorRealtimeDetail();
  requests[1].resolve(response({run_dir: 'output/A', previews: [{name: 'cached.png'}]}));
  await detail;
  assert.equal(app.previewsLoading, true);
  requests[0].reject(new Error('connection lost'));
  await refresh;
  assert.equal(app.previewsLoading, false);
  assert.equal(app.previews[0].name, 'cached.png');
  const retry = app.refreshPreviews();
  assert.equal(requests.length, 3);
  requests[2].resolve(response([{name: 'latest.png'}]));
  await retry;
  assert.equal(app.previewsLoading, false);
  assert.equal(app.previews[0].name, 'latest.png');
});

test('sample translations keep group identities and sorting stable across language changes', () => {
  const items = [0, 1, 2].map(index => ({dataset: {previewIndex: String(index)}}));
  const headings = ['epoch:1', 'step:20'].map(key => ({dataset: {previewGroup: key}}));
  const appended = [];
  const grid = {
    querySelectorAll: selector => selector === '.preview-grid-item' ? items : headings,
    appendChild: node => appended.push(node.dataset.previewGroup ?? Number(node.dataset.previewIndex)),
  };
  const content = {querySelector: () => grid, querySelectorAll: () => []};
  const {window} = loadFrontend(['monitor/previews', 'monitor/artifacts-render'], {
    window: {}, document: {getElementById: () => content},
  });
  const dictionaries = Object.fromEntries(['zh-CN', 'en-US', 'ja-JP'].map(locale =>
    [locale, JSON.parse(readRepo(`frontend/i18n/${locale}.json`))]));
  const app = composeMixins(window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: ['sample_e000001_00_time.png', 'sample_e000001_01_time.png', 'sample_000020_00_time.png'].map(name => ({name})),
    previewSortDir: 'desc',
    t(key) { return key.split('.').reduce((value, part) => value?.[part], dictionaries[this.locale]); },
  });
  for (const [locale, label] of [
    ['zh-CN', '第 1 轮 · 提示词 1'], ['en-US', 'Epoch 1 · Prompt 1'], ['ja-JP', 'エポック 1 · プロンプト 1'],
  ]) {
    app.locale = locale;
    assert.equal(app._parseSampleInfo(app.previews[0].name), label);
    assert.equal(app._sampleMetadata(app.previews[0].name).stage, 'epoch:1');
    appended.length = 0;
    assert.equal(app._patchPreviewSortOrder(), true);
    assert.deepEqual(appended, ['step:20', 2, 'epoch:1', 1, 0]);
  }
  assert.equal(app._parseSampleInfo('custom-sample.png'), 'custom-sample.png');
});
