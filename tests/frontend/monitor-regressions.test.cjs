const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
global.window = {};
global.document = { getElementById: () => null, hidden: false };
eval(fs.readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-core.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-render.js', 'utf8'));
// 监控页与训练页共用一个 Alpine 组件：参数摘要复用训练表单的选项标签解析。
eval(fs.readFileSync('frontend/js/training-core.js', 'utf8'));
function app(overrides = {}) {
  const value = Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(window.monitorCoreMixin),
    ...Object.getOwnPropertyDescriptors(window.monitorRenderMixin),
    ...Object.getOwnPropertyDescriptors(window.trainingCoreMixin),
  });
  return Object.assign(value, {
    renderDashboard() {}, scheduleRender() {}, finishProgress() {}, t: k => k,
    closePreviewLightbox() {}, esc: value => String(value),
    lossSeries: [], previews: [], logLines: [], logFullLines: [], outputFiles: [], outputFilesSelected: {},
  }, overrides);
}

function summaryRoot() {
  const nodes = new Map();
  const querySelector = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      dataset: {}, style: {}, textContent: '', hidden: false,
      parentElement: {
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
      },
      setAttribute(name, value) { this[name] = value; },
      querySelector,
    });
    return nodes.get(selector);
  };
  return {
    dataset: {},
    node(selector) { return nodes.get(selector); },
    querySelector,
  };
}

test('summary patches live state, actual terminal progress, degraded connection and errors', () => {
  const a = app({ realtimeState: 'degraded', realtimeTaskStateUnknown: true });
  const root = summaryRoot();
  const t = key => key;
  a._patchOverviewStatus(root, { state: 'RUNNING', step: 518, total_steps: 740, percent: 70, elapsed: '43:21', eta: '18:34', has_error: true, error_msg: 'Disk error' }, t, false);
  assert.equal(root.node('[data-summary-field="step"]').textContent, '518 / 740 stepsUnit');
  assert.equal(root.node('[data-summary-field="percent"]').textContent, '70%');
  assert.equal(root.node('[data-overview-progress]').style.width, '70%');
  assert.equal(root.node('[data-summary-stop]').hidden, false);
  assert.equal(root.node('[data-summary-connection]').textContent, 'realtimeDelayed');
  assert.match(root.node('[data-summary-notice]').textContent, /Disk error.*taskStateUnknown/);
  a._patchOverviewStatus(root, { state: 'FAILED', step: 520, total_steps: 740, percent: 70.27, elapsed: '43:30' }, t, false);
  assert.equal(root.node('[data-summary-field="percent"]').textContent, '70.3%');
  assert.equal(root.node('[data-summary-stop]').hidden, true);
});

test('incremental task metrics update real Loss and LR paths without rebuilding summary', () => {
  const a = app({ currentRoute: 'monitor-dashboard', monitorData: { state: 'RUNNING' } });
  const root = summaryRoot();
  const t = key => key;
  a._patchOverviewStatus(root, a.monitorData, t, false);
  const path = root.node('[data-summary-spark="loss"]');
  a.handleRealtimeTaskMetrics({ points: {
    'loss/average': [{ step: 1, value: 0.2 }, { step: 2, value: 0.1 }],
    'loss/current': [{ step: 1, value: 0.3 }, { step: 2, value: 0.12 }],
    'lr/unet': [{ step: 1, value: 0.00006 }, { step: 2, value: 0.00004 }],
  } });
  a._patchOverviewStatus(root, a.monitorData, t, false);
  assert.strictEqual(root.node('[data-summary-spark="loss"]'), path);
  assert.match(path.d, /^M/);
  assert.match(root.node('[data-summary-spark="lr"]').d, /^M/);
  assert.match(root.node('[data-diagnostic-trend]').d, /^M/);
  assert.equal(root.node('[data-summary-field="loss"]').textContent, '0.1200');
  assert.equal(root.dataset.sparklineVersion, String(a.lossDataVersion));
});

test('idle transport preserves the completed run; final detail remains readable', () => {
  const a = app({ monitorData: { state: 'FINISHED', step: 100, run_dir: 'output/A', active_task: { id: 'A' } } });
  a.applyRealtimeMonitorSnapshot({ monitor: { detail: true, state: 'IDLE', step: 0 } });
  assert.equal(a.monitorData.step, 100);
  assert.equal(a._logSliceRunDir(), 'output/A');
  a.applyRealtimeMonitorSnapshot({ monitor: { detail: true, run_dir: 'output/A', active_task: { id: 'A' }, step: 101 } });
  assert.equal(a.monitorData.state, 'FINISHED');
  assert.equal(a.monitorData.step, 101);
});

test('batched logs retain the entire eviction range', () => {
  const a = app({ logFullLines: ['1', '2', '3'], logFullTotal: 3, _logPageSize: () => 3 });
  a.handleRealtimeTaskLog({ data: { lines: ['4'] } });
  a.handleRealtimeTaskLog({ data: { lines: ['5'] } });
  assert.deepEqual(a.logFullLines, ['3', '4', '5']);
  assert.equal(a._logFullEvictK, 2);
});

test('artifact events during a request retain a trailing refresh', async () => {
  let resolve;
  const a = app({ monitorData: { run_dir: 'output/A' }, _outputFilesRunDir: 'output/A' });
  global.fetch = () => new Promise(done => { resolve = done; });
  const pending = a.loadOutputFiles();
  await a.loadOutputFiles();
  resolve({ json: async () => ({ status: 'success', data: [] }) });
  await pending;
  assert.equal(a.outputFilesLoading, false);
  assert.equal(a._outputFilesNeedsRefresh, true);
});

test('failed automatic log loading gives feedback and releases loading state', async () => {
  const notices = [];
  const a = app({ monitorData: { run_dir: 'output/A' }, toast: message => notices.push(message) });
  global.fetch = async () => { throw new Error('offline'); };
  await a.fetchLogSlice({ silent: true });
  assert.equal(a.logFullLoading, false);
  assert.deepEqual(notices, ['monitor.logSliceError']);
});
