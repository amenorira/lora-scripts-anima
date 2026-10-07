const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
global.window = {};
global.document = { getElementById: () => null, hidden: false };
eval(fs.readFileSync('frontend/js/monitor-logs.js', 'utf8'));
eval(fs.readFileSync('frontend/js/monitor-core.js', 'utf8'));
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
    realtimeSubscribe() {}, realtimeUnsubscribe() {},
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

test('speed sparkline rises as iteration time falls while the displayed unit stays unchanged', () => {
  const a = app({ monitorPerfSamples: [
    { observation: 1, speedSec: 8 }, { observation: 2, speedSec: 4 },
    { observation: 3, speedSec: 0 }, { observation: 4, speedSec: null },
  ] });
  const root = summaryRoot();
  const frames = [];
  a._patchRollingSparkline = (path, points, animate, context, options) => {
    frames.push(a._rollingSparklineFrame(points, null, options));
    return frames.at(-1);
  };
  a._patchSummaryTelemetry(root, key => key, false);
  assert.equal(frames[0].coords.length, 2);
  assert.ok(frames[0].coords[1].y < frames[0].coords[0].y);
  assert.equal(frames[0].points[0].value, 1 / 8);
  assert.equal(frames[0].points[1].value, 1 / 4);
  a._patchOverviewStatus(root, { state: 'RUNNING', speed: '3.91s/it' }, key => key, false);
  assert.equal(root.node('[data-summary-field="speed"]').textContent, '3.91s/it');
});

test('summary patches live state, actual terminal progress, degraded connection and errors', () => {
  const a = app({ realtimeState: 'degraded', realtimeTaskStateUnknown: true, trainParams: [{ key: 'max_train_epochs', value: 20 }] });
  const root = summaryRoot();
  const t = key => key;
  a._patchOverviewStatus(root, { state: 'RUNNING', step: 518, total_steps: 740, percent: 70, epoch: 5, elapsed: '43:21', eta: '18:34', has_error: true, error_msg: 'Disk error' }, t, false);
  assert.equal(root.node('[data-summary-field="epoch"]').textContent, 'epochProgress 5/20');
  assert.equal(root.node('[data-summary-field="step"]').textContent, '518 / 740 stepsUnit');
  assert.equal(root.node('[data-summary-field="percent"]').textContent, '70%');
  assert.equal(root.node('[data-overview-progress]').style.width, '70%');
  assert.equal(root.node('[data-summary-stop]').hidden, false);
  assert.equal(root.node('[data-summary-connection]').textContent, 'realtimeDelayed');
  assert.match(root.node('[data-summary-notice]').textContent, /Disk error.*taskStateUnknown/);
  a._patchOverviewStatus(root, { state: 'FAILED', step: 520, total_steps: 740, percent: 70.27, epoch: '6/30', elapsed: '43:30' }, t, false);
  assert.equal(root.node('[data-summary-field="epoch"]').textContent, 'epochProgress 6/30');
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
  const hero = root.node('[data-diagnostic-trend]');
  a.handleRealtimeTaskMetrics({ points: { 'loss/average': [{ step: 3, value: .11 }] } });
  a._patchOverviewStatus(root, a.monitorData, t, false);
  assert.strictEqual(root.node('[data-diagnostic-trend]'), hero);
  assert.equal(hero._sparklineState.shift, 1);
  assert.equal(hero._sparklineState.points.at(-1).step, 3);
  assert.equal(root.node('[data-summary-field="loss"]').textContent, '0.1200');
  assert.equal(root.dataset.sparklineVersion, String(a.lossDataVersion));
  a.handleRealtimeTaskMetrics({ points: { 'lr/unet': [{ step: 1, value: .00006 }] } });
  assert.equal(a.monitorData.lr, '4.0000e-5');
});

test('live Loss follows arriving steps and compares batched updates with the last displayed reading', () => {
  const a = app({ liveTaskId: 'A', currentRoute: 'monitor-dashboard', monitorData: { state: 'RUNNING' } });
  const root = summaryRoot();
  const render = () => a._patchOverviewStatus(root, a.monitorData, key => key === 'lossUpdatedAt' ? 'Step {n}' : key, false);
  const metrics = points => a.handleRealtimeTaskMetrics({ points: { 'loss/current': points } });
  render();
  metrics([{ step: 137, value: .1 }, { step: 138, value: .08 }]);
  render();
  assert.equal(root.node('[data-summary-field="loss"]').textContent, '0.0800');
  assert.equal(root.node('[data-summary-loss-change]').hidden, true);
  metrics([{ step: 139, value: .0556 }, { step: 140, value: .0685 }]);
  render();
  assert.equal(root.node('[data-summary-field="loss"]').textContent, '0.0685');
  assert.equal(root.node('[data-summary-field="loss-meta"]').textContent, 'Step 140');
  assert.equal(root.node('[data-summary-loss-change]').dataset.direction, 'down');
  assert.equal(root.node('[data-loss-delta]').textContent, '14.4%');
  assert.equal(root.node('.m-change-caption').textContent, 'lossVsPreviousDisplay');
  // 硬件/进度重绘、LR 更新、重复指标均不重置比较基准。
  render();
  a.handleRealtimeTaskMetrics({ points: { 'lr/unet': [{ step: 140, value: .0001 }] } });
  metrics([{ step: 140, value: .0685 }]);
  render();
  assert.equal(root.node('[data-loss-delta]').textContent, '14.4%');
  metrics([{ step: 141, value: .03425 }]);
  render();
  assert.equal(root.node('[data-loss-delta]').textContent, '50.0%');
  a.liveTaskId = 'B';
  a.lossSeries = [{ tag: 'loss/current', points: [{ step: 1, value: .5 }] }];
  render();
  assert.equal(root.node('[data-summary-loss-change]').hidden, true);
});

test('Loss history uses adjacent samples while zero and empty live baselines hide the change', () => {
  const a = app({ selectedRunDir: 'output/history', runDetailData: { tensorboard_loss: [
    { tag: 'loss/current', points: [{ step: 139, value: .0556 }, { step: 140, value: .0685 }] },
  ] } });
  const root = summaryRoot();
  a._patchOverviewStatus(root, { state: 'FINISHED' }, key => key, true);
  assert.equal(root.node('[data-summary-loss-change]').dataset.direction, 'up');
  assert.equal(root.node('[data-loss-delta]').textContent, '23.2%');
  assert.equal(root.node('.m-change-caption').textContent, 'lossVsPreviousSample');
  a.selectedRunDir = null;
  a.lossSeries = [{ tag: 'loss/current', points: [{ step: 1, value: 0 }] }];
  a._patchOverviewStatus(root, { state: 'RUNNING' }, key => key, false);
  a.lossSeries[0].points.push({ step: 2, value: .1 });
  a._patchOverviewStatus(root, { state: 'RUNNING' }, key => key, false);
  assert.equal(root.node('[data-summary-loss-change]').hidden, true);
});

test('elapsed clock advances independently while remaining time follows logs and terminal/history values stay fixed', ctx => {
  let now = 1000;
  ctx.mock.method(performance, 'now', () => now);
  const progress = { state: 'RUNNING', elapsed: '4:11', eta: '37:47' };
  const a = app({ liveTaskId: 'A', monitorData: progress }), root = summaryRoot();
  const display = (data = progress, history = false) => {
    a._patchSummaryTime(root, data, key => key, history, false);
    return ['time', 'time-meta'].map(key => root.node('[data-summary-field="' + key + '"]').textContent);
  };
  assert.deepEqual(display(), ['37:47', 'elapsed 4:11']);
  now = 6000;
  assert.deepEqual(display(), ['37:47', 'elapsed 4:16']);
  assert.deepEqual(progress, { state: 'RUNNING', elapsed: '4:11', eta: '37:47' });
  a.handleRealtimeTaskProgress({ data: { eta: '37:40' } });
  assert.deepEqual(display(), ['37:40', 'elapsed 4:16']);
  a.handleRealtimeTaskProgress({ data: { elapsed: '4:17' } });
  now = 8000; // 从日志到达时计时，不能等到渲染才校准。
  assert.deepEqual(display(), ['37:40', 'elapsed 4:19']);
  now = 8900;
  a.handleRealtimeTaskProgress({ data: { elapsed: '4:18' } }); // 迟到日志不能回退或丢掉小数秒。
  now = 9000;
  assert.deepEqual(display(), ['37:40', 'elapsed 4:20']);
  ctx.mock.method(Date, 'now', () => 0); // 系统校时不影响经过时间，长间隔后补齐计时。
  now = 69000;
  assert.deepEqual(display(), ['37:40', 'elapsed 5:20']);
  assert.deepEqual(display({ ...progress, state: 'FINISHED', train_result: { duration_sec: 300 } }), ['5:00', '']);
  assert.deepEqual(display(progress, true), ['37:40', 'elapsed 4:18']);
  a.claimLiveTask('B');
  assert.deepEqual(display(), ['37:40', 'elapsed 4:18']);
  assert.deepEqual(display({ state: 'RUNNING' }), ['—', '']);
});

test('local trends reveal small real changes, keep constants flat and recover after an extreme leaves the window', () => {
  const a = app();
  const samples = (start, valueAt) => Array.from({ length: 40 }, (_, i) => ({ step: start + i, value: valueAt(start + i) }));
  const height = frame => Math.max(...frame.coords.map(p => p.y)) - Math.min(...frame.coords.map(p => p.y));
  for (const [baseline, amplitude, minimum, relative] of [
    [5.2, .01, .05, .005], [3600, 2, 10, 0], [-7.3, .05, .25, .02],
  ]) {
    const points = samples(0, step => baseline + amplitude * Math.sin(step));
    const frame = a._rollingSparklineFrame(points, null, { minimumSpan: minimum, relativeSpan: relative });
    assert.ok(height(frame) > 5);
    assert.deepEqual(frame.points, points);
    const constant = a._rollingSparklineFrame(samples(0, () => baseline), null, { minimumSpan: minimum, relativeSpan: relative });
    assert.ok(constant.coords.every(p => p.y === 17));
  }
  const valueAt = step => step === 0 ? 8 : 5.2 + .01 * Math.sin(step);
  let frame = a._rollingSparklineFrame(samples(0, valueAt), null, { minimumSpan: .05, relativeSpan: .005 });
  const initialSpan = frame.bounds.high - frame.bounds.low;
  for (let step = 1; step <= 20; step++) {
    const next = a._rollingSparklineFrame(samples(step, valueAt), frame, { minimumSpan: .05, relativeSpan: .005 });
    assert.equal(next.shift, 1);
    assert.ok(next.bounds.high - next.bounds.low < frame.bounds.high - frame.bounds.low);
    assert.ok(next.coords.every(p => p.y >= 4 && p.y <= 30));
    frame = next;
  }
  assert.ok(frame.bounds.high - frame.bounds.low < initialSpan / 10);
  assert.ok(height(frame) > 5);
});

test('diagnostic change keeps zero centered and scales to positive, negative and crossing values without smoothing', () => {
  const a = app();
  for (const values of [[1, 3, 2], [-1, -3, -2], [-3, 0, 2], [0, 0, 0]]) {
    const points = values.map((value, step) => ({ step, value }));
    const bounds = a._diagnosticTrendBounds('change', points);
    const frame = a._rollingSparklineFrame(points, null, { fixedBounds: bounds });
    assert.equal(bounds.low, -bounds.high);
    assert.deepEqual(frame.points, points);
    assert.equal((frame.path.match(/L/g) || []).length, points.length - 1);
    assert.doesNotMatch(frame.path, /[CQ]/);
    frame.coords.forEach((point, index) => {
      assert.ok(point.y >= 4 && point.y <= 30);
      assert.ok(values[index] > 0 ? point.y < 17 : values[index] < 0 ? point.y > 17 : point.y === 17);
    });
  }
  const wide = a._diagnosticTrendBounds('change', [{ value: 30 }, { value: -1 }]);
  const narrow = a._diagnosticTrendBounds('change', [{ value: .1 }, { value: -.2 }]);
  assert.ok(narrow.high < wide.high);
  const volatility = [{ step: 1, value: 6.3 }, { step: 2, value: 6.5 }, { step: 3, value: 6.4 }];
  const frame = a._rollingSparklineFrame(volatility, null, { fixedBounds: a._diagnosticTrendBounds('volatility', volatility) });
  assert.ok(Math.max(...frame.coords.map(p => p.y)) - Math.min(...frame.coords.map(p => p.y)) > 20);
  assert.equal(a._diagnosticTrendBounds('volatility', [{ value: 0 }]).low, 0);
});

test('diagnostic chart endpoints match displayed percentages and report their actual 40-sample step span', () => {
  const points = Array.from({ length: 160 }, (_, index) => ({ step: 100 + index * 2, value: .1 + .015 * Math.sin(index * .3) }));
  const a = app({ lossSeries: [{ tag: 'loss/average', points }] });
  const root = summaryRoot();
  const t = key => key === 'diagnosticTrendRange' ? '{n}: Step {first}–{last}' : key;
  a._patchTrainingDiagnostics(root, t, { state: 'RUNNING' }, false);
  const diagnostic = a._trainingDiagnostics();
  for (const [key, value] of [['change', diagnostic.changePct], ['volatility', diagnostic.volatilityPct]]) {
    const frame = root.node('[data-diagnostic-spark="' + key + '"]')._sparklineState;
    assert.equal(frame.points.length, 40);
    assert.equal(frame.points.at(-1).value, value);
    assert.equal(root.node('[data-diagnostic-field="' + key + '"]').textContent, a._formatDiagnosticPercent(value, key === 'change'));
    assert.equal(root.node('[data-diagnostic-field="' + key + '-range"]').textContent, '40: Step 340–418');
    assert.equal(root.node('[data-diagnostic-point="' + key + '"]').y1, frame.coords.at(-1).y);
  }
  assert.equal(root.node('[data-diagnostic-zero]').visibility, 'visible');
  a.lossSeries = [];
  a.lossDataVersion++;
  a._patchTrainingDiagnostics(root, t, { state: 'RUNNING' }, false);
  assert.equal(root.node('[data-diagnostic-zero]').visibility, 'hidden');
  assert.equal(root.node('[data-diagnostic-field="change-range"]').textContent, 'needsMorePoints');
});

test('speed and forecast retain same-step dips as new observations and ignore delayed log replay', () => {
  const a = app({ liveTaskId: 'A', monitorPerfSamples: [], logLines: [
    'steps: 10%|#| 10/100 [09:40<1:02:40, 6.32s/it]',
  ] });
  const samples = () => a._summaryTelemetrySamples(false).samples;
  a._ingestMonitorPerfSamples(a._parseMonitorPerfLogs(a.logLines));
  const initial = samples()[0];
  a._recordMonitorPerfSample({ step: 10, speed: '6.28 s/it', elapsed: '9:44', eta: '1:02:31' });
  const dip = samples().at(-1);
  a._recordMonitorPerfSample({ step: 10, speed: '6.32 s/it', elapsed: '9:53', eta: '1:02:44' });
  assert.deepEqual(samples().map(p => p.speedSec), [6.32, 6.28, 6.32]);
  assert.deepEqual(samples().map(p => p.remainingRate), [null, -9 / 4, 13 / 9]);
  assert.deepEqual(samples()[0], initial);
  assert.deepEqual(samples()[1], dip);
  const beforeReplay = samples();
  a.logLines.push('steps: 10%|#| 10/100 [09:44<1:02:31, 6.28s/it]', 'steps: 10%|#| 10/100 [09:53<1:02:44, 6.32s/it]');
  a._logContentVersion++;
  a._ingestMonitorPerfSamples(a._parseMonitorPerfLogs(a.logLines));
  assert.deepEqual(samples(), beforeReplay);
  const history = app({ selectedRunDir: 'output/A', runDetailData: { perf_samples: a._mergeMonitorPerfSamples([], a._parseMonitorPerfLogs(a.logLines)) } });
  assert.deepEqual(history._summaryTelemetrySamples(true).samples.map(p => p.speedSec), [6.32, 6.28, 6.32]);
  for (let step = 11; step <= 60; step++) {
    a._recordMonitorPerfSample({ step, speed: '6.32 s/it', elapsed: '10:00', eta: '1:02:44' });
    samples();
  }
  assert.equal(samples().length, 40);
  assert.equal(samples().at(-1).observation, 53);
  a.claimLiveTask('B');
  a.logLines = [];
  a._recordMonitorPerfSample({ step: 1, speed: '1 s/it', elapsed: '0:01', eta: '0:09' });
  assert.deepEqual(samples().map(p => [p.observation, p.speedSec]), [[1, 1]]);
});

test('remaining-time derivative is flat for steady countdowns and rises when the estimate grows', () => {
  const a = app({ liveTaskId: 'rate', monitorPerfSamples: [] }), root = summaryRoot();
  const report = (elapsed, eta) => {
    a._recordMonitorPerfSample({ step: 10, speed: '6 s/it', elapsed, eta });
    a._patchSummaryTelemetry(root, key => key, false);
    return root.node('[data-summary-spark="time"]')._sparklineState;
  };
  report('1:40', '3:20');
  report('1:44', '3:16');
  let frame = report('1:54', '3:06');
  assert.deepEqual(frame.points.map(p => p.value), [-1, -1]);
  assert.ok(frame.coords.every(p => p.y === 17));
  assert.equal(root.node('[data-summary-time-baseline]').visibility, 'visible');
  frame = report('1:59', '3:16');
  assert.equal(frame.points.at(-1).value, 2);
  assert.ok(frame.coords.at(-1).y < 17);
  assert.ok(frame.coords.slice(0, -1).every(p => p.y === 17));
  frame = report('2:09', '2:56');
  assert.equal(frame.points.at(-1).value, -2);
  assert.ok(frame.coords.at(-1).y > 17);
  const count = frame.points.length;
  frame = report('2:09', '3:00');
  assert.equal(frame.points.length, count); // 同秒刷新没有有效导数，不画伪尖峰。
  frame = report('2:14', '2:55');
  assert.equal(frame.points.at(-1).value, -1);
  assert.ok(frame.coords.every(p => Number.isFinite(p.y) && p.y >= 4 && p.y <= 30));
  a._patchSummaryTelemetry(root, key => key, true);
  assert.equal(root.node('[data-summary-time-baseline]').visibility, 'hidden');
});

test('finished, stopped and failed runs retain the remaining-time rate curve alongside total duration, including history', () => {
  for (const state of ['FINISHED', 'TERMINATED', 'FAILED']) {
    const a = app({ liveTaskId: 'time-trend', monitorPerfSamples: [] });
    for (const [step, elapsed, eta] of [[1, '14:40', '00:08'], [2, '14:42', '00:06'], [3, '14:44', '00:04']]) {
      a._recordMonitorPerfSample({ step, elapsed, eta, speed: '2 s/it' });
    }
    const root = summaryRoot();
    a._patchOverviewStatus(root, { state: 'RUNNING', elapsed: '14:44', eta: '00:04' }, key => key, false);
    const original = root.node('[data-summary-spark="time"]')._sparklineState;
    assert.deepEqual(original.points.map(point => point.value), [-1, -1]);
    assert.ok(original.coords.every(point => point.y === 17));
    const terminal = { state, elapsed: '14:44', train_result: { status: state, duration_sec: 884 } };
    a._patchOverviewStatus(root, terminal, key => key, false);
    assert.equal(root.node('[data-summary-field="time-label"]').textContent, 'totalDuration');
    assert.equal(root.node('[data-summary-field="time"]').textContent, '14:44');
    assert.equal(root.node('[data-summary-field="time-meta"]').textContent, 'timeTrendCaption');
    assert.equal(root.node('[data-summary-spark="time"]').d, original.path);
    assert.equal(root.node('[data-summary-time-baseline]').visibility, 'visible');
    // 重新打开历史详情也计算同一条曲线，不依赖结束前的 DOM 缓存。
    a.selectedRunDir = 'output/time-trend';
    a.runDetailData = { ...terminal, perf_samples: a.monitorPerfSamples };
    const historyRoot = summaryRoot();
    a._patchOverviewStatus(historyRoot, a.runDetailData, key => key, true);
    assert.equal(historyRoot.node('[data-summary-spark="time"]').d, original.path);
    assert.equal(historyRoot.node('[data-summary-time-baseline]').visibility, 'visible');
    assert.equal(historyRoot.node('[data-summary-field="time"]').textContent, '14:44');
    assert.equal(historyRoot.node('[data-summary-field="time-meta"]').textContent, 'timeTrendCaption');
  }
});

test('runs without enough remaining-time observations hide the time curve instead of plotting cumulative elapsed time', () => {
  const a = app({ monitorPerfSamples: [
    { observation: 1, elapsedSec: 880, remainingRate: null },
    { observation: 2, elapsedSec: 882, remainingRate: null },
    { observation: 3, elapsedSec: 884, remainingRate: -1 },
  ] });
  const root = summaryRoot();
  a._patchOverviewStatus(root, { state: 'FINISHED', elapsed: '14:44' }, key => key, false);
  assert.equal(root.node('[data-summary-spark="time"]').d, '');
  assert.equal(root.node('[data-summary-spark="time"]').parentElement.hidden, '');
  assert.equal(root.node('[data-summary-time-baseline]').visibility, 'hidden');
  assert.equal(root.node('[data-summary-field="time-meta"]').textContent, '');
});

test('all metric curves retain their meaning from running to terminal states and history', () => {
  for (const state of ['FINISHED', 'TERMINATED', 'FAILED']) {
    const lossSeries = [
      { tag: 'loss/current', points: Array.from({ length: 160 }, (_, step) => ({ step, value: .1 + .02 * Math.sin(step) })) },
      { tag: 'loss/average', points: Array.from({ length: 160 }, (_, step) => ({ step, value: .1 + .002 * Math.sin(step / 5) })) },
      { tag: 'lr/unet', points: [{ step: 158, value: .0001 }, { step: 159, value: .00009 }], latest: .00009 },
    ];
    const a = app({ liveTaskId: 'A', lossSeries, monitorPerfSamples: [] });
    for (const [step, elapsed, eta] of [[157, '14:40', '00:08'], [158, '14:42', '00:06'], [159, '14:44', '00:04']]) {
      a._recordMonitorPerfSample({ step, elapsed, eta, speed: '2 s/it' });
    }
    const progress = { state: 'RUNNING', step: 159, elapsed: '14:44', eta: '00:04', speed: '2 s/it' };
    const root = summaryRoot();
    const selectors = [
      ...['loss', 'lr', 'speed', 'time'].map(key => '[data-summary-spark="' + key + '"]'),
      ...['change', 'volatility', 'best', 'gap'].map(key => '[data-diagnostic-spark="' + key + '"]'),
    ];
    const curves = root => selectors.map(selector => root.node(selector).d);
    const values = root => ['loss', 'lr', 'speed'].map(key => root.node('[data-summary-field="' + key + '"]').textContent);
    a._patchOverviewStatus(root, progress, key => key, false);
    const before = curves(root), readings = values(root);
    assert.ok(before.every(path => path.startsWith('M')));
    assert.equal(root.node('[data-summary-field="speed-meta"]').textContent, 'currentSpeed');
    const result = { status: state === 'FINISHED' ? 'completed' : state.toLowerCase(), duration_sec: 884, ended_at: '2026-10-07T06:00:00Z' };
    a._patchOverviewStatus(root, { ...progress, state, train_result: result }, key => key, false);
    assert.deepEqual(curves(root), before);
    assert.deepEqual(values(root), readings);
    assert.equal(root.node('[data-summary-field="speed-meta"]').textContent, 'lastSpeed');
    const timeMeta = root.node('[data-summary-field="time-meta"]').textContent;
    assert.match(timeMeta, /^endedAt .*timeTrendCaption$/);
    a.selectedRunDir = 'output/A';
    // 历史结果覆盖旧进度中的 RUNNING；所有卡片均遵循同一个状态解释。
    a.runDetailData = { ...progress, train_result: result, tensorboard_loss: lossSeries, perf_samples: a.monitorPerfSamples };
    const history = summaryRoot();
    a._patchOverviewStatus(history, a.runDetailData, key => key, true);
    assert.deepEqual(curves(history), before);
    assert.deepEqual(values(history), readings);
    assert.equal(history.node('[data-summary-field="speed-meta"]').textContent, 'lastSpeed');
    assert.equal(history.node('[data-summary-field="time"]').textContent, '14:44');
    assert.equal(history.node('[data-summary-field="time-meta"]').textContent, timeMeta);
    assert.match(a._renderOverviewTab(a.runDetailData, key => key, true), /noParamsHint/);
    // 实时状态仍以任务轮询为准，旧的训练结果不能提前把正在运行的任务结束。
    assert.equal(a._summaryStatus({ ...progress, train_result: result }, false).running, true);
  }
});

test('late log backfill restores missing curve points and derivatives without replay drift', () => {
  const a = app({ liveTaskId: 'A', monitorPerfSamples: [] });
  const progress = step => ({ step, speed: '6 s/it', elapsed: a._formatMonitorDuration('', step * 6),
    eta: a._formatMonitorDuration('', 1200 - step * 6 + (step === 45 ? 12 : 0)) });
  const lines = count => Array.from({ length: count }, (_, i) => {
    const p = progress(i + 1);
    return `steps: 20%|#| ${p.step}/200 [${p.elapsed}<${p.eta}, ${p.speed}]`;
  });
  const fill = count => a._ingestMonitorPerfSamples(a._parseMonitorPerfLogs(lines(count)));
  fill(40);
  a._recordMonitorPerfSample(progress(51));
  a._summaryTelemetrySamples(false);
  fill(51);
  const samples = a._summaryTelemetrySamples(false).samples;
  assert.deepEqual(samples.slice(-11).map(p => p.step), Array.from({ length: 11 }, (_, i) => i + 41));
  assert.equal(samples.find(p => p.step === 45).remainingRate, 1);
  assert.equal(samples.find(p => p.step === 46).remainingRate, -3);
  fill(120);
  const retained = a.monitorPerfSamples;
  fill(120);
  assert.strictEqual(a.monitorPerfSamples, retained);
  assert.equal(retained.length, 80);
});

test('idle transport preserves the completed run; final detail remains readable', () => {
  const a = app({ monitorData: { state: 'FINISHED', step: 100, run_dir: 'output/A', active_task: { id: 'A' } } });
  a.applyRealtimeMonitorSnapshot({ monitor: { detail: true, state: 'IDLE', step: 0 } });
  assert.equal(a.monitorData.step, 100);
  assert.equal(a._logSliceRunDir(), 'output/A');
  a.applyRealtimeMonitorSnapshot({ monitor: { detail: true, run_dir: 'output/A', active_task: { id: 'A' }, step: 101, log_total: 12000, log_lines: ['tail'], output_count: 20 } });
  assert.equal(a.monitorData.state, 'FINISHED');
  assert.equal(a.monitorData.step, 101);
  assert.equal(a.logTotal, 12000);
  assert.equal(a.outputTabCount, 20);
});

test('batched logs retain the entire eviction range', () => {
  const a = app({ logFullLines: ['1', '2', '3'], logTotal: 3, _logPageSize: () => 3 });
  a.handleRealtimeTaskLog({ data: { lines: ['4'], offset: 3, log_total: 4 } });
  a.handleRealtimeTaskLog({ data: { lines: ['5'], offset: 4, log_total: 5 } });
  assert.deepEqual(a.logFullLines, ['3', '4', '5']);
  assert.equal(a.logFullOffset, 2);
  a.logAutoScroll = a._logAtBottom = false;
  a.handleRealtimeTaskLog({ data: { lines: ['5', '5'], offset: 5, log_total: 7 } });
  a.handleRealtimeTaskLog({ data: { lines: ['5', '5'], offset: 5, log_total: 7 } });
  assert.equal(a.logTotal, 7);
  assert.deepEqual(a.logFullLines, ['3', '4', '5']);
  assert.deepEqual(a.logLines.slice(-3), ['5', '5', '5']);
  a.handleRealtimeTaskLog({ data: { lines: ['new tail'], offset: 4999, log_total: 5000, reset: true, truncated: true } });
  assert.deepEqual(a.logFullLines, ['new tail']);
  a.handleRealtimeTaskLog({ data: { lines: [], offset: 0, log_total: 0, reset: true } });
  assert.equal(a.logTotal, 0);
  assert.deepEqual(a.logFullLines, []);
  a.logAutoScroll = true;
  a._applyMonitorLogSnapshot(['1', '2'], 2);
  a._applyMonitorLogSnapshot(['2', '3'], 3, true);
  assert.deepEqual(a.logFullLines, ['2', '3']);
});

test('artifact events during a request retain a trailing refresh', async () => {
  let resolve;
  const a = app({ currentRoute: 'monitor-dashboard', monitorData: { run_dir: 'output/A' }, _outputFilesRunDir: 'output/A', _lastRealtimePreviewRefreshAt: Date.now() });
  global.fetch = () => new Promise(done => { resolve = done; });
  const pending = a.loadOutputFiles();
  a.handleRealtimeTaskArtifacts({ output_count: 21 });
  resolve({ json: async () => ({ status: 'success', data: [] }) });
  await pending;
  assert.equal(a.outputFilesLoading, false);
  assert.equal(a._outputFilesNeedsRefresh, true);
  assert.equal(a.outputTabCount, 21);
});

test('failed automatic log loading gives feedback and releases loading state', async () => {
  const notices = [];
  const a = app({ monitorData: { run_dir: 'output/A' }, toast: message => notices.push(message) });
  global.fetch = async () => { throw new Error('offline'); };
  await a.fetchLogSlice({ silent: true });
  assert.equal(a.logFullLoading, false);
  assert.deepEqual(notices, ['monitor.logSliceError']);
});
