const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
global.window = {};
global.document = { getElementById: () => null, hidden: false };
eval(fs.readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-core.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-render.js', 'utf8'));
function app(overrides = {}) {
  const value = Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(window.monitorCoreMixin), ...Object.getOwnPropertyDescriptors(window.monitorRenderMixin) });
  return Object.assign(value, {
    renderDashboard() {}, scheduleRender() {}, finishProgress() {}, t: k => k,
    closePreviewLightbox() {},
    lossSeries: [], previews: [], logLines: [], logFullLines: [], outputFiles: [], outputFilesSelected: {},
  }, overrides);
}

test('idle transport preserves the completed run; final detail remains readable', () => {
  const a = app({ monitorData: { state: 'FINISHED', step: 100, run_dir: 'output/A', active_task: { id: 'A' } } });
  a.applyRealtimeMonitorSnapshot({ monitor: { detail: true, state: 'IDLE', step: 0 } });
  assert.equal(a.monitorData.step, 100);
  assert.equal(a._logSliceRunDir(), 'output/A');
  a.applyRealtimeMonitorSnapshot({ monitor: { detail: true, run_dir: 'output/A', active_task: { id: 'A' }, step: 101 } });
  assert.equal(a.monitorData.state, 'FINISHED');
  assert.equal(a.monitorData.step, 101);
});

test('cancelled image queues can be resumed', () => {
  const a = app({ _previewMediaQueue: [], _drainPreviewMediaQueue() {} });
  const images = ['one', 'two'].map(url => ({ dataset: { previewUrl: url }, isConnected: true }));
  const root = { querySelectorAll: () => images };
  a.schedulePreviewMediaLoads(root);
  a._cancelPreviewMediaQueue();
  a.schedulePreviewMediaLoads(root);
  assert.equal(a._previewMediaQueue.length, 2);
});

test('batched logs retain the entire eviction range', () => {
  const a = app({ logFullLines: ['1', '2', '3'], logFullTotal: 3, _logPageSize: () => 3 });
  a.handleRealtimeTaskLog({ data: { lines: ['4'] } });
  a.handleRealtimeTaskLog({ data: { lines: ['5'] } });
  assert.deepEqual(a.logFullLines, ['3', '4', '5']);
  assert.equal(a._logFullEvictK, 2);
});

test('missing diagnostics are not reported as zero', () => {
  const a = app();
  assert.equal(a._formatDiagnosticValue(null), '—');
  assert.equal(a._formatDiagnosticPercent(null), '—');
  assert.equal(a._formatDiagnosticValue(0), '0.0000');
});

test('diagnostics use raw windows regardless of chart sampling', () => {
  const raw = Array.from({ length: 120 }, (_, n) => ({ step: n + 1, value: 1 - n / 1000 }));
  const a = app({ lossSeries: [{ tag: 'loss/average', diagnostic_points: raw, points: raw.filter((_, n) => n % 15 === 0) }] });
  const first = a._trainingDiagnostics();
  a.lossSeries[0].points = raw;
  assert.deepEqual(a._trainingDiagnostics(), first);
  assert.equal(first.windowSize, 60);
});

test('output refresh keeps valid selection and increments content version', async () => {
  const a = app({ monitorData: { run_dir: 'output/A' }, _outputFilesRunDir: 'output/A', outputFilesSelected: { a: true, deleted: true } });
  global.fetch = async () => ({ json: async () => ({ status: 'success', data: [{ path: 'a', size: 999 }] }) });
  await a.loadOutputFiles();
  assert.deepEqual(a.selectedOutputFiles, ['a']);
  assert.equal(a.outputFilesVersion, 1);
  assert.equal(a.outputFiles[0].size, 999);
});

test('hardware disappearance removes stale readings', () => {
  const a = app({ gpuInfo: { name: 'old' } });
  a.handleRealtimeHardware({ gpu: null, system: null });
  assert.equal(a.gpuInfo, null);
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
