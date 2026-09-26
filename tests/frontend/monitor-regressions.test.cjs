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

test('live summary owns progress and stop; history keeps navigation without a stop action', () => {
  const a = app();
  const t = key => key;
  for (const state of ['CREATED', 'RUNNING']) {
    const html = a._overviewMetricsHtml({ state }, t, false, state === 'RUNNING');
    assert.match(html, /data-summary-stop/);
    assert.match(html, /data-overview-progress/);
    assert.equal((html.match(/class="m-live-metric /g) || []).length, 4);
    assert.doesNotMatch(html, /m-statusbar|m-sb-/);
  }
  const history = a._historyBannerHtml({ train_result: { status: 'completed', duration_str: '1h' } }, t);
  assert.match(history, /clearRunDetail\(\)/);
  assert.doesNotMatch(history, /1h|stopTraining/);
  assert.doesNotMatch(a._overviewMetricsHtml({ train_result: { status: 'completed' } }, t, true, false), /data-summary-stop/);
  assert.doesNotMatch(a._overviewMetricsHtml({ state: 'UNKNOWN' }, t, false, false), /readyToTrain|data-overview-progress/);
  assert.doesNotMatch(fs.readFileSync('frontend/index.html', 'utf8'), /monitorControlbar/);
});

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

test('remaining time leads the live tile and a recorded end time appears in history', () => {
  const a = app();
  const root = summaryRoot();
  const t = key => key;
  a._patchOverviewStatus(root, { state: 'RUNNING', elapsed: '43:21', eta: '18:34' }, t, false);
  assert.equal(root.node('[data-summary-field="time-label"]').textContent, 'estimatedRemaining');
  assert.equal(root.node('[data-summary-field="time"]').textContent, '18:34');
  assert.equal(root.node('[data-summary-field="time-meta"]').textContent, 'elapsed 43:21');
  assert.match(root.node('[data-summary-field="progress-time"]').textContent, /estimatedRemaining 18:34/);

  const endedAt = '2025-09-24T08:42:31+00:00';
  a._patchOverviewStatus(root, { train_result: { status: 'completed', duration_str: '1:04:50', ended_at: endedAt } }, t, true);
  assert.equal(root.node('[data-summary-field="time"]').textContent, '1:04:50');
  assert.equal(root.node('[data-summary-field="time-meta"]').textContent, 'endedAt ' + a._formatRunEndTime(endedAt));
  a._patchOverviewStatus(root, { train_result: { status: 'completed', duration_str: '1:04:50' } }, t, true);
  assert.equal(root.node('[data-summary-field="time-meta"]').textContent, '');
});

test('duration from current and older results is displayed in base 60', () => {
  const a = app();
  assert.equal(a._formatMonitorDuration('65m 50s'), '1:05:50');
  assert.equal(a._formatMonitorDuration('1h 5m 50s'), '1:05:50');
  assert.equal(a._formatMonitorDuration('65:50'), '1:05:50');
  assert.equal(a._formatMonitorDuration('43:21'), '43:21');
  assert.equal(a._formatMonitorDuration('—'), '—');
  const root = summaryRoot();
  a._patchOverviewStatus(root, { train_result: { status: 'completed', duration_str: '65m 50s' } }, key => key, true);
  assert.equal(root.node('[data-summary-field="time"]').textContent, '1:05:50');
});

test('speed and forecast duration trends come from recorded progress rows, never one current reading', () => {
  const a = app({ logLines: [
    'steps: 69%|########--| 516/740 [43:10<18:40, 5.00s/it]',
    'steps: 70%|########--| 517/740 [43:15<19:00, 5.20s/it]',
    'steps: 70%|########--| 518/740 [43:21<18:34, 5.26s/it]',
  ], _logContentVersion: 1 });
  const root = summaryRoot();
  const t = key => key;
  assert.deepEqual(a._summaryTelemetrySamples(false).samples.map(sample => sample.estimatedTotalSec), [3710, 3735, 3715]);
  a._patchOverviewStatus(root, { state: 'RUNNING', step: 518, total_steps: 740, speed: '5.26 s/it', elapsed: '43:21', eta: '18:34' }, t, false);
  assert.match(root.node('[data-summary-spark="speed"]').d, /^M4\.0 .*L116\.0 /);
  assert.match(root.node('[data-summary-spark="time"]').d, /^M4\.0 .*L116\.0 /);
  assert.equal(root.node('[data-summary-spark="time"]').parentElement.title, 'estimatedTotalTrendLabel');
  assert.equal(root.node('[data-summary-field="speed-meta"]').textContent, 'currentSpeed');
  assert.doesNotMatch(a._overviewMetricsHtml({ state: 'RUNNING' }, t, false), /m-metric-bars|m-time-strip/);
  assert.equal(a._monitorSpeedSeconds('2 it/s'), 0.5);
  a.selectedRunDir = 'output/older';
  a._patchOverviewStatus(root, { train_result: { status: 'completed', duration_str: '65m 50s' } }, t, true);
  assert.equal(root.node('[data-summary-field="speed-meta"]').textContent, 'lastSpeed');
  assert.match(root.node('[data-summary-spark="speed"]').d, /^M/);
  a.logLines = [];
  a._logContentVersion++;
  a._patchOverviewStatus(root, { train_result: { status: 'completed' }, speed: '5.26 s/it' }, t, true);
  assert.equal(root.node('[data-summary-spark="speed"]').d, '');
  assert.equal(root.node('[data-summary-spark="time"]').d, '');
  assert.equal(root.node('[data-summary-spark="speed"]').parentElement.hidden, '');
});

test('live progress events build real trend samples and clearing them removes the curves', () => {
  const a = app({ currentRoute: 'monitor-dashboard', monitorData: { state: 'RUNNING', step: 0 } });
  for (const [step, elapsed, eta, speed] of [[1, '0:05', '0:20', '5.0s/it'], [2, '0:11', '0:18', '6.0s/it'], [3, '0:16', '0:09', '5.0s/it']]) {
    a.handleRealtimeTaskProgress({ data: { step, elapsed, eta, speed } });
  }
  assert.equal(a.monitorPerfSamples.length, 3);
  assert.deepEqual(a._summaryTelemetrySamples(false).samples.map(sample => sample.estimatedTotalSec), [25, 29, 25]);
  const root = summaryRoot();
  a._patchOverviewStatus(root, a.monitorData, key => key, false);
  assert.match(root.node('[data-summary-spark="speed"]').d, /^M/);
  assert.match(root.node('[data-summary-spark="time"]').d, /^M/);
  a.monitorPerfSamples = [];
  a._monitorPerfVersion++;
  a._patchOverviewStatus(root, a.monitorData, key => key, false);
  assert.equal(root.node('[data-summary-spark="speed"]').d, '');
});

test('key parameters use the optimizer dropdown label and Dim caption', () => {
  const getVisibleSections = window.getVisibleSections;
  // 选项带 dk（真实注册表形态）；标签经 i18n 取词，所以本例的 t 认这个 key。
  window.getVisibleSections = () => [{ fields: [{ key: 'optimizer_type', groups: [{ options: [{ v: 'pytorch_optimizer.CAME', l: 'CAME', dk: 'opt.optimizer_type_came' }] }] }] }];
  try {
    const a = app({
      t: (key, fallback) => (key === 'opt.optimizer_type_came' ? 'CAME' : key),
      trainParams: [
        { key: 'optimizer_type', value: 'pytorch_optimizer.Came', section: 'optimizer' },
        { key: 'network_dim', value: 32, section: 'network' },
      ],
    });
    const html = a._parametersConsoleHtml(key => key);
    assert.match(html, /param-key-label">historyOptimizer<\/span><span class="param-key-value" title="CAME">CAME/);
    assert.match(html, /param-key-label">paramDim<\/span><span class="param-key-value" title="32">32/);
  } finally {
    window.getVisibleSections = getVisibleSections;
  }
});

test('completed LR uses series maximum and final value; missing series falls back to task data', () => {
  const a = app({ lossSeries: [{ tag: 'lr/unet', points: [{ step: 1, value: 1e-5 }, { step: 2, value: 6e-5 }, { step: 3, value: 0 }], max: 6e-5, latest: 0 }] });
  for (const [value, expected] of [[4.26349e-5, '4.263e-5'], [4.26351e-5, '4.264e-5'], [6e-5, '6e-5'], [9.9999e-5, '1e-4'], [0, '0'], [null, '—'], ['invalid', '—']]) {
    assert.equal(a._formatLearningRate(value, '—'), expected);
  }
  const root = summaryRoot();
  a._patchOverviewStatus(root, { state: 'FINISHED', step: 90, total_steps: 100, lr: 0 }, key => key, false);
  assert.equal(root.node('[data-summary-field="lr"]').textContent, '0');
  assert.equal(root.node('[data-summary-field="lr-range"]').textContent, 'lrPeak 6e-5');
  assert.equal(root.node('[data-summary-field="lr-meta"]').textContent, 'schedulerFinished');
  assert.equal(root.node('[data-summary-field="percent"]').textContent, '100%');
  a.lossSeries = [];
  a.lossDataVersion = 1;
  a._patchOverviewStatus(root, { state: 'RUNNING', loss: 0.123, lr: 4e-5 }, key => key, false);
  assert.equal(root.node('[data-summary-field="loss"]').textContent, '0.123');
  assert.equal(root.node('[data-summary-field="lr"]').textContent, '4e-5');
  assert.equal(root.node('[data-summary-spark="loss"]').d, '');
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

test('Loss tile compares the latest two distinct steps independently of the diagnostic mean', () => {
  const falling = [{ step: 60, value: .03 }, { step: 59, value: .04 }, { step: 60, value: .02 }];
  const a = app({ lossSeries: [{ tag: 'loss/current', points: falling }], lossDataVersion: 1 });
  const root = summaryRoot();
  a._patchOverviewStatus(root, { state: 'RUNNING' }, key => key, false);
  assert.equal(root.node('[data-loss-delta]').textContent, '50.0%');
  assert.equal(root.node('[data-summary-loss-change]').dataset.direction, 'down');
  assert.equal(root.node('[data-summary-field="loss"]').textContent, '0.0200');
  assert.equal(root.node('[data-summary-field="loss-meta"]').textContent, 'lossUpdatedAt');
  assert.equal(root.node('[data-summary-loss-change]').hidden, false);
  assert.equal(a._summaryLossChange({ points: [{ step: 1, value: 0 }, { step: 2, value: .02 }] }), null);
  assert.equal(a._summaryLossChange({ points: [{ step: 1, value: .02 }] }), null);
  a.lossSeries = [{ tag: 'loss/average', points: falling }];
  assert.equal(a._summaryLossSeries(), undefined);
});

test('scheduler summary reads recorded parameters, including fractional warmup, without guessing missing settings', () => {
  const a = app({ trainParams: [{ key: 'lr_scheduler', value: 'cosine' }, { key: 'lr_warmup_steps', value: '0.1' }] });
  const t = key => ({ lrScheduleCosine: 'cosine', lrWarmupSteps: '预热 {n} 步', lrWarmupPercent: '预热 {n}%', lrNoWarmup: '无预热' }[key] || key);
  assert.equal(a._summarySchedulerMeta(t, 740), 'cosine · 预热 74 步');
  assert.equal(a._summarySchedulerMeta(t, 0), 'cosine · 预热 10%');
  a.trainParams[1].value = 0;
  assert.equal(a._summarySchedulerMeta(t, 740), 'cosine · 无预热');
  a.trainParams.pop();
  assert.equal(a._summarySchedulerMeta(t, 740), 'cosine');
  a.trainParams = [];
  assert.equal(a._summarySchedulerMeta(t, 740), '');
});

test('number motion skips initial and unchanged values, cancels stale transitions, and respects reduced motion', () => {
  const originalDocument = global.document;
  const originalMatchMedia = window.matchMedia;
  const animations = [];
  class Element {
    constructor() { this.dataset = {}; this.children = []; this.textContent = ''; }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); }
    replaceChildren(...children) { this.children = children; }
    remove() { this.removed = true; }
    getAnimations() { return animations.filter(animation => !animation.cancelled); }
    animate(frames, options) {
      const animation = { frames, options, cancel() { this.cancelled = true; this.oncancel?.(); } };
      animations.push(animation);
      return animation;
    }
  }
  try {
    global.document = { hidden: false, createElement: () => new Element(), createTextNode: text => ({ textContent: text }) };
    window.matchMedia = () => ({ matches: false });
    const a = app();
    const node = new Element();
    a._patchMonitorNumber(node, '0.0337', true);
    assert.equal(animations.length, 0);
    a._patchMonitorNumber(node, '0.0338', true);
    assert.equal(animations.length, 2); // 只滚动发生变化的一位。
    assert.equal(node.children[0].textContent, '0.0338'); // 辅助技术立即读到最终值。
    a._patchMonitorNumber(node, '0.0338', true);
    assert.equal(animations.length, 2);
    a._patchMonitorNumber(node, '0.0336', true);
    assert.ok(animations.slice(0, 2).every(animation => animation.cancelled));
    assert.equal(animations.length, 4);
    window.matchMedia = () => ({ matches: true });
    a._patchMonitorNumber(node, '0.0335', true);
    assert.equal(node.textContent, '0.0335');
    assert.equal(animations.length, 4);
    assert.ok(animations.every(animation => animation.cancelled));
    window.matchMedia = () => ({ matches: false });
    document.hidden = true;
    a._patchMonitorNumber(node, '0.0334', true);
    assert.equal(animations.length, 4);
    document.hidden = false;
    a._patchMonitorNumber(node, '0.0333', false); // 历史或切换任务。
    assert.equal(animations.length, 4);
  } finally {
    global.document = originalDocument;
    window.matchMedia = originalMatchMedia;
  }
});

test('diagnostic mini charts use measured changes and mark the real best Loss', () => {
  const points = Array.from({ length: 120 }, (_, index) => ({ step: index + 1, value: 0.03 + index * 0.0001 + Math.sin(index) * 0.0002 }));
  const a = app({ lossSeries: [{ tag: 'loss/average', points, diagnostic_points: points }], lossDataVersion: 1 });
  const trends = a._diagnosticMetricTrends();
  const diagnostic = a._trainingDiagnostics();
  assert.equal(trends.change.at(-1), diagnostic.changePct);
  assert.equal(trends.volatility.at(-1), diagnostic.volatilityPct);
  const lossTrend = a._diagnosticLossTrend(diagnostic.bestStep);
  assert.equal(lossTrend.values[lossTrend.bestIndex], diagnostic.bestValue);
  const root = summaryRoot();
  a._patchOverviewStatus(root, { state: 'RUNNING' }, key => key, false);
  for (const key of ['change', 'volatility', 'best', 'gap']) {
    assert.match(root.node('[data-diagnostic-spark="' + key + '"]').d, /^M/);
    const marker = root.node('[data-diagnostic-point="' + key + '"]');
    assert.equal(marker.visibility, key === 'best' ? 'hidden' : 'visible');
    assert.equal(root.node('[data-diagnostic-low="' + key + '"]').visibility, key === 'best' || key === 'gap' ? 'visible' : 'hidden');
    assert.equal(marker.x1, '116.0');
    assert.equal(marker.x2, marker.x1);
    assert.equal(marker.y2, marker.y1);
  }
  assert.equal(a._sparklineGeometry([1, 2]).coords[0].x, '4.0');
});

test('Rich source columns accept single-space separators and preserve message indentation', () => {
  const a = app();
  for (const [text, main, source] of [
    ['2026-09-19 12:47:16 INFO     Loading settings from                 args.py:1177', '2026-09-19 12:47:16 INFO     Loading settings from', 'args.py:1177'],
    ['                    INFO     Initializing VAE qwen_image_autoencoder_kl.py:1609', '                    INFO     Initializing VAE', 'qwen_image_autoencoder_kl.py:1609'],
    ['                    INFO     loading image sizes.                dataset.py:464   ', '                    INFO     loading image sizes.', 'dataset.py:464'],
  ]) {
    assert.deepEqual(a._splitRichLogSource(text), { main, source });
  }
  for (const text of ['                             dataset.py:464', '  File "dataset.py", line 464', 'steps: 10%|##| 1/10 [00:01]', '                    INFO     caption_extension: .txt']) {
    assert.equal(a._splitRichLogSource(text), null);
  }
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
