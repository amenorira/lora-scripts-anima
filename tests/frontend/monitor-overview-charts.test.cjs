const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend, readRepo } = require('./helpers.cjs');

global.document = { hidden: false, getElementById: () => null, querySelector: () => null };
loadGlobalFrontend(['shared/utils', 'training/lr-preview', 'monitor/metrics', 'monitor/diagnostics', 'monitor/summary']);

function makeOverview(overrides = {}) {
  return Object.assign(
    Object.create(window.monitorSummaryMixin),
    window.utilsMixin,
    window.monitorDiagnosticsMixin,
    window.monitorMetricsMixin,
    {
      monitorLossSeries: [],
      trainParams: [],
      monitorChartMode: 'window',
      monitorChartShowLr: false,
      monitorData: { gpu_processes: 1 },
      monitorTab: 'overview',
      setMonitorTab(tab) { this.monitorTab = tab; },
    },
    overrides
  );
}

// These plots inspect completed points while a subsequent batch is in progress.
function liveLossSeries(points, extra = {}) {
  return {tag: 'loss/average', points, ...extra, get diagnostic_points() {
    const last = points.at(-1);
    return [...points, {step: last.step + 1, value: last.value}];
  }};
}

test('a summary range retargets from its displayed projection and respects reduced motion', () => {
  const {withAnimationFrames} = require('./helpers-animation.cjs');
  withAnimationFrames(({tick, frames}) => {
    const view = makeOverview();
    const host = {isConnected: true, closest: () => null};
    const samples = [];
    const painter = () => project => samples.push(project(1));
    view._transitionSummaryProjection(host, -1, 20, true, painter);
    assert.equal(frames.size, 0);
    view._transitionSummaryProjection(host, -2, 10, true, painter);
    assert.equal(samples.at(-1), 19);
    tick(performance.now() + 60);
    const visible = samples.at(-1);
    assert.ok(visible < 19 && visible > 8);
    view._transitionSummaryProjection(host, -1, 16, true, painter);
    assert.equal(samples.at(-1), visible);
    assert.equal(frames.size, 1);
    tick(performance.now() + 300);
    assert.equal(samples.at(-1), 15);
    window.matchMedia = () => ({matches: true});
    view._transitionSummaryProjection(host, -4, 15, true, () => assert.fail('reduced motion'));
    assert.equal(frames.size, 0);
  });
});

test('the Loss tile scrolls by sample identity and retargets both axes and its mean from the visible frame', () => {
  const {withAnimationFrames} = require('./helpers-animation.cjs');
  withAnimationFrames(({tick, frames}) => {
    const view = makeOverview();
    const host = {isConnected: true, closest: () => null};
    const start = [{step:5,x:6,y:40}, {step:8,x:97,y:20}, {step:9,x:188,y:50}];
    const target = [{step:8,x:6,y:22}, {step:9,x:97,y:44}, {step:15,x:188,y:30}];
    let middle, lastY, meanY;
    const paint = (coords, mean) => {
      middle = coords.find(p => p.step === 9);
      lastY = coords.at(-1).y;
      meanY = mean;
    };
    view._transitionLossTrace(host, start, 40, true, paint);
    view._transitionLossTrace(host, target, 55, true, paint);
    assert.deepEqual([middle.x, lastY, meanY], [188, 50, 40]);
    tick(performance.now() + 60);
    assert.ok(middle.x > 97 && middle.x < 188 && lastY > 30 && lastY < 50 && meanY > 40 && meanY < 55);
    const screen = [middle.x, lastY, meanY];
    const newer = [{step:9,x:6,y:48}, {step:15,x:97,y:36}, {step:20,x:188,y:20}];
    view._transitionLossTrace(host, newer, 35, true, paint);
    assert.deepEqual([middle.x, lastY, meanY], screen);
    assert.equal(frames.size, 1);
    tick(performance.now() + 300);
    assert.deepEqual([middle.x, lastY, meanY], [6, 20, 35]);
    assert.equal(frames.size, 0);
  });
});

test('cosine LR schedule projects future decay for deterministic optimizers and skips adaptive ones', () => {
  const deterministic = makeOverview({
    trainParams: [
      { key: 'optimizer_type', value: 'AdamW8bit' },
      { key: 'lr_scheduler', value: 'cosine' },
      { key: 'lr_warmup_steps', value: 100 },
      { key: 'learning_rate', value: 1e-4 },
    ],
  });
  const future = deterministic._projectLrSchedule(
    [{ step: 100, value: 1e-4 }, { step: 550, value: 5e-5 }],
    1000
  );
  assert.ok(future.length > 5);
  assert.equal(future[0].step, 550);
  assert.equal(future[0].value, 5e-5);
  assert.equal(future.at(-1).step, 1000);
  assert.ok(future.at(-1).value < 1e-6);

  const adaptive = makeOverview({
    trainParams: [
      { key: 'optimizer_type', value: 'automagic4' },
      { key: 'lr_scheduler', value: 'cosine' },
    ],
  });
  assert.deepEqual(adaptive._projectLrSchedule([{ step: 500, value: 4e-4 }], 1000), []);
});

test('epoch progress parser resolves intra-epoch fill and parameter fallback', () => {
  const view = makeOverview({ trainParams: [{ key: 'max_train_epochs', value: 20 }] });
  const mid = view._parseEpochProgress({ epoch: '11' }, 1000, 525, false, 52.5);
  assert.equal(mid.currentEpoch, 11);
  assert.equal(mid.totalEpochs, 20);
  assert.ok(Math.abs(mid.epochFraction - 0.5) < 0.05);

  const done = view._parseEpochProgress({ epoch: '20/20' }, 1080, 1080, true, 100);
  assert.equal(done.totalEpochs, 20);
  assert.equal(done.epochFraction, 1);
});

test('hero chart downsampling keeps endpoints and extrema while the diagnostic window compares two sets of 40 points', () => {
  const longSeries = Array.from({ length: 1200 }, (_, i) => ({
    step: i + 1,
    value: i === 599 ? 0.005 : i === 899 ? 0.95 : 0.1 + Math.sin(i / 20) * 0.02,
  }));
  const view = makeOverview({
    monitorLossSeries: [{ tag: 'loss/average', points: longSeries }],
  });
  const compressed = view._downsampleMonitorPoints(longSeries, 160);
  assert.ok(compressed.length <= 180);
  assert.equal(compressed[0].step, 1);
  assert.equal(compressed.at(-1).step, 1200);
  assert.ok(compressed.some(p => p.step === 600 && p.value === 0.005));
  assert.ok(compressed.some(p => p.step === 900 && p.value === 0.95));

  const windowPts = view._trainingDiagnosticPoints();
  assert.equal(windowPts.length, 80);
  const diag = view._trainingDiagnostics(windowPts);
  assert.equal(diag.windowSize, 40);
  assert.equal(diag.previousStartStep, 1121);
  assert.equal(diag.recentEndStep, 1200);
});

test('jumping from a preview timeline marker selects that batch and opens the samples tab', () => {
  const batch = { id: 'batch-e10' };
  const panel = {};
  let located = false;
  const view = makeOverview({
    _sampleDataModel: () => ({ byBatch: new Map([[batch.id, batch]]) }),
    _sampleOverviewPanel: () => panel,
    _scrollOverviewToBatch(targetPanel, targetBatch) {
      assert.equal(this.monitorTab, 'samples');
      assert.equal(targetPanel, panel);
      assert.equal(targetBatch, batch);
      located = true;
    },
  });
  view._jumpToPreviewBatch('batch-e10', 18);
  assert.equal(view.sampleBatchId, 'batch-e10');
  assert.equal(view.previewStep, 18);
  assert.equal(view.monitorTab, 'samples');
  assert.ok(located);
});

test('odd diagnostic windows exclude the unplotted point from the minimum and gap', () => {
  const points = [1, 4, 3, 2, 5, 6, 7].map((value, i) => ({ step: i + 1, value }));
  const diagnostic = makeOverview()._trainingDiagnostics(points);
  assert.equal(diagnostic.bestStep, 4);
  assert.equal(diagnostic.gapFromBestPct, 250);
  const view = makeOverview();
  assert.equal(view._lossGapPercent(.1, 0), null);
  assert.equal(view._lossGapPercent(0, 0), 0);
});

test('full chart includes the reported minimum in its readout, with a disconnected anchor before retained history', () => {
  const pts = [{step: 10, value: .3}, {step: 12, value: .4}];
  const series = liveLossSeries(pts, {min: .1, min_step: 2});
  const svg = {setAttribute() {}};
  const wrap = { dataset: {}, querySelector: selector => ({
    '[data-hero-chart-stage]': {clientWidth: 500}, '[data-hero-chart-svg]': svg,
  })[selector] };
  const card = {dataset: {}, querySelectorAll: () => [], querySelector: selector => selector === '[data-hero-chart-wrap]' ? wrap : null};
  const root = {dataset: {}, querySelector: () => card};
  const view = makeOverview({monitorChartMode: 'full', monitorLossSeries: [series], esc: String,
    _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {}});
  const patch = () => view._patchTrainingDiagnostics(root, key => key, {state: 'RUNNING', step: 13, detail: true}, false);
  patch();
  assert.deepEqual(wrap._chartState.coords.map(p => p.step), [2, 10, 12]);
  const path = /data-hero-main-path d="([^"]+)"/.exec(svg.innerHTML)[1];
  assert.ok(path.startsWith('M' + wrap._chartState.coords[1].x.toFixed(1) + ' '));
  series.min_step = 11;
  view.lossDataVersion = 1;
  patch();
  assert.deepEqual(wrap._chartState.coords.map(p => p.step), [10, 11, 12]);
  assert.equal(pts.length, 2);
  assert.match(svg.innerHTML, /m-latest-pulse/);
  view.controlState = {state: 'paused'};
  patch();
  assert.doesNotMatch(svg.innerHTML, /m-latest-pulse/);
});

test('full chart spans a long live run after repeated compaction and keeps the raw diagnostic window', () => {
  const svg = { setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] };
  const wrap = { dataset: {}, querySelector: selector => ({
    '[data-hero-chart-stage]': { clientWidth: 500 }, '[data-hero-chart-svg]': svg,
  })[selector] };
  const card = { dataset: {}, querySelectorAll: () => [], querySelector: selector => selector === '[data-hero-chart-wrap]' ? wrap : null };
  const series = { tag: 'loss/average', points: [] };
  const view = makeOverview({ monitorChartMode: 'full', monitorLossSeries: [series], esc: String,
    _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {} });
  const points = Array.from({ length: 16000 }, (_, i) => ({ step: i + 1, value: i === 199 ? 2 : 1 - i / 16000 }));
  for (let i = 0; i < points.length; i += 100) {
    view._appendMonitorMetricPoints(series, points.slice(i, i + 100));
  }
  view._patchTrainingDiagnostics({ dataset: {}, querySelector: () => card }, key => key, { state: 'RUNNING', detail: true }, false);
  const steps = wrap._chartState.coords.map(point => point.step);
  assert.equal(steps[0], 1);
  assert.ok(steps.includes(200), 'the early spike stays on the displayed curve');
  assert.equal(steps.at(-1), 15999);
  assert.ok(series.points.length <= 5000);
  assert.deepEqual(view._trainingDiagnosticPoints(), points.slice(-80));
});

test('live Loss corrections and HTTP snapshots yield the same distinct-step window', () => {
  const tag = 'loss/average';
  const series = {tag, points: []};
  const pendingLoss = new Map();
  const view = makeOverview({lossSeries: [series], monitorLossSeries: [series], _monitorRealtimeDetailRequest: {pendingLoss}});
  const canonical = Array.from({length: 175}, (_, i) => ({step: i * 3, value: .1 + i / 1000}));
  const batch = canonical.flatMap(point => [{...point, value: 1}, point, {...point, value: NaN}]);
  view._appendMonitorMetricPoints(series, batch);
  assert.deepEqual(series.diagnostic_points, canonical.slice(-160));
  const snapshot = {tag, points: series.points.slice(), diagnostic_points: series.diagnostic_points.slice()};
  const updates = [canonical.at(-5), canonical.at(-1)].map(point => ({...point, value: .05}));
  view.handleRealtimeTaskMetrics({points: {[tag]: updates}});
  view.monitorLossSeries = view._mergeMonitorMetricSnapshot([snapshot], pendingLoss);
  const expected = canonical.slice(-80);
  expected[75] = updates[0];
  expected[79] = updates[1];
  assert.deepEqual(view._trainingDiagnosticPoints(), expected);
  assert.deepEqual(view._trainingDiagnostics(), view._trainingDiagnostics(expected));
});

test('each batch can update current Loss while the diagnostic plot waits for the next step or terminal state', () => {
  const series = [], charts = [];
  const card = {dataset: {}, querySelectorAll: () => [], querySelector: s => s === '[data-hero-chart-wrap]' ? wrap : null};
  const wrap = {_chartContext: 'run', dataset: {}};
  const root = {dataset: {motionContext: 'run'}, querySelector: () => card};
  const view = makeOverview({lossSeries: series, monitorLossSeries: series, lossDataVersion: 0,
    _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {}, _renderHeroChart(_, chart) { charts.push(chart); }});
  const read = (step, current, average, time, progress = step) => {
    view.handleRealtimeTaskMetrics({points: {
      'loss/current': [{step, value: current, wall_time: time}],
      'loss/average': [{step, value: average}],
    }});
    view._patchTrainingDiagnostics(root, String, {state:'RUNNING', detail: true, step:progress}, false);
    const raw = view._summaryLossSeries();
    return view._summaryCurrentLoss({metrics_step: step, loss: 1, metrics_time: time - 1}, raw.points.at(-1), raw.latest_wall_time).value;
  };
  read(407, .026491, .040475, 1);
  assert.equal(read(408, .030779, .039398, 2), .030779);
  const renders = charts.length;
  assert.equal(read(408, .043019, .039776, 3, 409), .043019);
  assert.equal(charts.length, renders);
  assert.equal(charts.at(-1).points.at(-1).step, 407);
  read(409, .04, .0395, 4);
  assert.deepEqual(charts.at(-1).points.at(-1), {step:408, value:.039776});
  view._patchTrainingDiagnostics(root, String, {state:'FINISHED', detail:true, step:409}, false);
  assert.equal(charts.at(-1).points.at(-1).step, 409);
  assert.equal(view._summaryCurrentLoss({metrics_step:409, loss:.05, metrics_time:5}, {step:409, value:.04}, 4).value, .05);
});

test('LR projections use the recorded process count, inverse sqrt timescale and polynomial end rate', () => {
  const project = (scheduler, args, processes = 1) => makeOverview({
    monitorData: { gpu_processes: processes },
    trainParams: Object.entries({ lr_scheduler: scheduler, learning_rate: 1e-4, ...args }).map(([key, value]) => ({key, value})),
  })._projectLrSchedule([{step: 100, value: 1e-4}], 1000);
  for (const processes of [1, 2]) {
    const curve = project('inverse_sqrt', {lr_warmup_steps: 100 * processes, lr_scheduler_timescale: 10000}, processes);
    assert.ok(Math.abs(curve.at(-1).value - 1e-4 / Math.sqrt(1 + 900 * processes / 10000)) < 1e-12);
  }
  const polynomial = project('polynomial', {lr_warmup_steps: 100, 'lr_scheduler_args.lr_end': 1e-6});
  assert.ok(Math.abs(polynomial.at(-1).value - 1e-6) < 1e-12);
  assert.deepEqual(project('inverse_sqrt', {}, null), []);
  assert.deepEqual(project('cosine', {lr_scheduler_type: 'StepLR'}), []);
});

test('restart projection samples both sides of a cycle boundary', () => {
  const view = makeOverview({trainParams: [
    {key: 'lr_scheduler', value: 'cosine_with_restarts'}, {key: 'lr_scheduler_num_cycles', value: 48},
  ]});
  const curve = view._projectLrSchedule([{step: 1200, value: 1e-4}], 2400);
  assert.ok(curve.find(p => p.step === 1249).value < 1e-6);
  assert.ok(curve.find(p => p.step === 1250).value > .99e-4);
});

test('continuous gauge color interpolation uses shortest hue arc without purple detours', () => {
  const view = makeOverview();
  const hueOf = color => Number(/^hsl\(([\d.]+)/.exec(color)?.[1]);
  const cNeg = view._changeGaugeColor(-3.0);
  const cMildNeg = view._changeGaugeColor(-1.0);
  const cZero = view._changeGaugeColor(0);
  const cMildPos = view._changeGaugeColor(0.9);
  const cMidPos = view._changeGaugeColor(3.5);
  const cHighPos = view._changeGaugeColor(5.4);
  assert.notEqual(cNeg, cMildNeg);
  assert.notEqual(cMildNeg, cZero);
  assert.notEqual(cZero, cMildPos);
  assert.notEqual(cMildPos, cHighPos);
  for (const col of [cMildPos, cMidPos, cHighPos]) {
    const h = hueOf(col);
    assert.ok(h <= 50 || h >= 350, `positive change hue should stay amber/red, got ${col}`);
  }

  const vLow = view._volatilityGaugeColor(2.0);
  const vMid = view._volatilityGaugeColor(7.0);
  const vHigh = view._volatilityGaugeColor(13.8);
  assert.notEqual(vLow, vMid);
  assert.notEqual(vMid, vHigh);
  const vh = hueOf(vHigh);
  assert.ok(vh <= 20 || vh >= 350, `high volatility hue should stay orange/red, got ${vHigh}`);
});

test('adaptive epoch grid keeps 1:1 direct blocks up to hundreds of epochs and falls back cleanly only when extreme', () => {
  const view = makeOverview();
  const g20 = view._computeAdaptiveEpochGrid(20, true, 152, 64);
  assert.equal(g20.useDirectEpochs, true);
  assert.equal(g20.blockCount, 20);
  assert.equal(g20.cols, 10);

  const g120 = view._computeAdaptiveEpochGrid(120, true, 152, 64);
  assert.equal(g120.useDirectEpochs, true);
  assert.equal(g120.blockCount, 120);
  assert.ok(g120.size >= 5.5, `expected readable squares for 120 epochs, got ${g120.size}`);

  const g240 = view._computeAdaptiveEpochGrid(240, true, 152, 64);
  assert.equal(g240.useDirectEpochs, true);
  assert.equal(g240.blockCount, 240);
  assert.ok(g240.size >= 3.5);

  const g800 = view._computeAdaptiveEpochGrid(800, true, 152, 64);
  assert.equal(g800.useDirectEpochs, false);
  assert.equal(g800.blockCount, 120);
  assert.ok(g800.size >= 5.5);
});

test('hero charts and summary HUD localize Step, Epoch, and Loss in Japanese', () => {
  const jaDict = JSON.parse(readRepo('frontend/i18n/ja-JP.json'));
  const tFn = key => key.split('.').reduce((v, part) => v?.[part], jaDict) ?? key;
  const view = makeOverview({
    t: tFn,
    _shellLocale: 'ja-JP',
    esc: String,
    monitorLossSeries: [
      { tag: 'loss/average', points: [{ step: 10, value: 0.4 }, { step: 20, value: 0.3 }, { step: 30, value: 0.2 }, { step: 40, value: 0.25 }, { step: 50, value: 0.22 }, { step: 60, value: 0.2 }, { step: 70, value: 0.19 }] },
      { tag: 'loss/epoch_average', points: [{ step: 1, value: 0.35 }, { step: 2, value: 0.25 }] },
    ],
    previews: [{ name: 'img.png', epoch: 2, step: 60, thumb_url: '/thumb' }],
    _sampleDataModel: () => ({
      batches: [{ id: 'b2', indices: [0] }],
      records: [{ sample: { epoch: 2, step: 60 }, preview: { thumb_url: '/thumb' } }],
    }),
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const translate = k => view.tMonitor(k);

  const markers = view._previewMarkersForChart({}, 100, 2, translate);
  assert.equal(markers[0].label, 'エポック 2 (ステップ 60)');

  const readEl = { style: { setProperty() {} }, innerHTML: '' };
  const stageEl = { clientWidth: 500, classList: { toggle() {}, remove() {} } };
  const hoverGroup = {
    setAttribute() {},
    removeAttribute() {},
    querySelectorAll: () => [],
    querySelector: () => ({ setAttribute() {}, removeAttribute() {} }),
  };
  const svg = {
    attrs: {},
    innerHTML: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll: () => [],
    querySelector: selector => selector === '[data-chart-hover]' ? hoverGroup : null,
  };
  const wrap = {
    dataset: {},
    classList: { add() {}, remove() {} },
    querySelector: selector => ({
      '[data-hero-chart-stage]': stageEl,
      '[data-hero-chart-svg]': svg,
      '[data-chart-hud-readout]': readEl,
    })[selector] || null,
  };
  const card = {
    dataset: {},
    querySelectorAll: () => [],
    querySelector: selector => selector === '[data-hero-chart-wrap]' ? wrap : null,
  };
  const root = { dataset: {}, querySelector: () => card };

  view.monitorChartMode = 'window';
  view._patchTrainingDiagnostics(root, translate, { state: 'RUNNING', detail: true, total_steps: 100, epoch: '2/2' }, false);
  assert.ok(svg.innerHTML.includes('ステップ 10'), svg.innerHTML);
  assert.ok(!svg.innerHTML.includes('Step '), svg.innerHTML);
  view._updateHeroChartHover(wrap, wrap._chartState.coords[1].x / wrap._chartState.width);
  assert.ok(readEl.innerHTML.includes('ステップ <span class="m-hud-index">'), readEl.innerHTML);
  assert.ok(!readEl.innerHTML.includes('Step '), readEl.innerHTML);

  view.monitorChartMode = 'epoch';
  view._patchTrainingDiagnostics(root, translate, { state: 'RUNNING', detail: true, total_steps: 100, epoch: '2/2' }, false);
  assert.ok(svg.innerHTML.includes('エポック 1'), svg.innerHTML);
  assert.ok(!svg.innerHTML.includes('Epoch '), svg.innerHTML);
  view._updateHeroChartHover(wrap, 0.75);
  assert.ok(readEl.innerHTML.includes('エポック <span class="m-hud-index">'), readEl.innerHTML);
  assert.ok(!readEl.innerHTML.includes('Epoch '), readEl.innerHTML);

  const hud = { style: { setProperty() {} }, classList: { toggle() {} }, innerHTML: '' };
  const tile = { clientWidth: 268, querySelector: selector => selector === '[data-summary-hud]' ? hud : null };
  const vizHost = {
    hidden: false,
    innerHTML: '',
    closest: () => tile,
    querySelector: () => null,
  };
  const summaryRoot = { dataset: {}, querySelector: selector => selector === '[data-summary-viz="time"]' ? vizHost : null };
  view._patchSummaryTimeViz(summaryRoot, { epoch: '2/2' }, 100, 60, 60, false, true, translate, false);
  assert.ok(vizHost.innerHTML.includes('data-viz-kind="epoch"'), vizHost.innerHTML);
  assert.ok(vizHost.innerHTML.includes('data-viz-val-kind="loss"'), vizHost.innerHTML);

  view._showSummaryVizHud(vizHost, { dataset: { vizKind: 'epoch', vizNum: '2', vizVal: '0.2500', vizValKind: 'loss' } }, true);
  assert.ok(hud.innerHTML.includes('エポック <span class="m-hud-index">2</span>'), hud.innerHTML);
  assert.ok(hud.innerHTML.includes('<span class="m-hud-prefix">損失 </span>0.2500'), hud.innerHTML);
  assert.ok(!hud.innerHTML.includes('Epoch') && !hud.innerHTML.includes('Loss'), hud.innerHTML);

  view._showSummaryVizHud(vizHost, { dataset: { vizKind: 'step', vizNum: '60', vizVal: '0.2000', vizValKind: '' } }, true);
  assert.ok(hud.innerHTML.includes('ステップ <span class="m-hud-index">60</span>'), hud.innerHTML);
  assert.ok(!hud.innerHTML.includes('Step'), hud.innerHTML);
});

test('early Loss comparisons describe the means until both windows reach ten valid points', () => {
  const view = makeOverview();
  const compare = (count, recentValue) => {
    const points = Array.from({ length: count }, (_, i) => ({
      step: (i + 1) * 20, value: i < Math.ceil(count / 2) ? 1 : recentValue,
    }));
    return view._trainingDiagnostics(points);
  };
  assert.equal(compare(5, .8).code, 'insufficient');
  for (const count of [6, 7, 18, 19]) {
    for (const [value, label] of [[.8, 'diagnosticEarlyDown'], [1.2, 'diagnosticEarlyUp'], [1.005, 'diagnosticEarlyClose']]) {
      const observed = compare(count, value);
      assert.equal(observed.code, 'early');
      assert.equal(view._diagnosticText(String, observed, 'label'), label);
    }
  }
  assert.equal(compare(20, .8).code, 'converging');
});

test('training diagnostics maps the five verdict states and insufficient state to distinct semantic tones', () => {
  const view = makeOverview();
  const makePts = vals => vals.flatMap(value => Array(4).fill(value)).map((value, i) => ({ step: (i + 1) * 10, value }));

  const insufficient = view._trainingDiagnostics(makePts([0.4]));
  assert.equal(insufficient.code, 'insufficient');
  assert.equal(insufficient.tone, 'muted');

  const converging = view._trainingDiagnostics(makePts([0.40, 0.38, 0.36, 0.30, 0.28, 0.26]));
  assert.equal(converging.code, 'converging');
  assert.equal(converging.tone, 'ok');

  const plateau = view._trainingDiagnostics(makePts([0.250, 0.252, 0.249, 0.251, 0.250, 0.251]));
  assert.equal(plateau.code, 'plateau');
  assert.equal(plateau.tone, 'calm');

  const volatile = view._trainingDiagnostics(makePts([0.25, 0.25, 0.25, 0.19, 0.31, 0.25]));
  assert.equal(volatile.code, 'volatile');
  assert.equal(volatile.tone, 'warn');

  const rebound = view._trainingDiagnostics(makePts([0.20, 0.20, 0.20, 0.22, 0.23, 0.24]));
  assert.equal(rebound.code, 'rebound');
  assert.equal(rebound.tone, 'danger');

  const steady = view._trainingDiagnostics(makePts([0.30, 0.30, 0.30, 0.28, 0.30, 0.31]));
  assert.equal(steady.code, 'steady');
  assert.equal(steady.tone, 'neutral');
});

test('hero chart splits window diff bands, full-mode odd/even counts, and ultra-long bounds cleanly', () => {
  const translate = k => k;
  const makeHarness = () => {
    const svg = { innerHTML: '', setAttribute() {} };
    const wrap = {
      dataset: {},
      classList: { add() {}, remove() {} },
      querySelector: s => ({ '[data-hero-chart-stage]': { clientWidth: 500 }, '[data-hero-chart-svg]': svg })[s] || null,
    };
    const volatilityMetric = { style: new Map(), querySelector: () => null };
    volatilityMetric.style.setProperty = volatilityMetric.style.set;
    const card = {
      dataset: {},
      querySelectorAll: () => [],
      querySelector: s => ({ '[data-hero-chart-wrap]': wrap, '[data-diagnostic-metric="volatility"]': volatilityMetric })[s] || null,
    };
    const root = { dataset: {}, querySelector: () => card };
    return { svg, wrap, card, root, volatilityMetric };
  };

  const winPts = [0.36, 0.34, 0.32, 0.26, 0.24, 0.22].map((value, i) => ({ step: (i + 1) * 10, value }));
  const winView = makeOverview({
    monitorChartMode: 'window',
    monitorLossSeries: [liveLossSeries(winPts)],
    esc: String,
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const winH = makeHarness();
  winView._patchTrainingDiagnostics(winH.root, translate, { state: 'RUNNING', step: 61, detail: true, total_steps: 100 }, false);
  assert.doesNotMatch(winH.svg.innerHTML, /m-chart-smooth-area/);
  assert.doesNotMatch(winH.svg.innerHTML, /clip-path/);
  assert.match(winH.svg.innerHTML, /class="m-chart-prev-line"/);
  assert.match(winH.svg.innerHTML, /class="m-window-diff-band" data-hero-diff-band d="M/);
  assert.match(winH.svg.innerHTML, /class="m-window-split-connector"/);
  const prevD = /data-hero-prev-path[^>]*d="([^"]+)"/.exec(winH.svg.innerHTML)[1];
  const mainD = /data-hero-main-path d="([^"]+)"/.exec(winH.svg.innerHTML)[1];
  const prevEnd = prevD.split(' ').slice(-2).join(' ').replace(/^[ML]/, '');
  const mainStart = mainD.slice(1).split(' ').slice(0, 2).join(' ');
  assert.equal(prevEnd, mainStart, 'split segments meet seamlessly at splitX');

  // 前 80 点在全程模式下按中点切分，覆盖奇数采样和窗口刚满的边界。
  for (const count of [7, 79, 80]) {
    const shortFullPts = Array.from({ length: count }, (_, i) => ({
      step: (i + 1) * 10,
      value: 0.4 - i * 0.001,
    }));
    const shortView = makeOverview({
      monitorChartMode: 'full',
      monitorLossSeries: [liveLossSeries(shortFullPts)],
      esc: String,
      _bindDiagnosticInteractions() {},
      _patchDiagnosticGauges() {},
    });
    const shortH = makeHarness();
    shortView._patchTrainingDiagnostics(shortH.root, translate, { state: 'RUNNING', step: count * 10 + 1, detail: true, total_steps: 1200 }, false);
    assert.match(shortH.svg.innerHTML, /class="m-chart-prev-line"/);
    assert.doesNotMatch(shortH.svg.innerHTML, /class="m-chart-prev-line is-full"/);
    const shortBgTag = /<rect class="m-full-window-bg"[^>]+>/.exec(shortH.svg.innerHTML)[0];
    assert.ok(shortBgTag.includes('display="none"'), `count ${count} <= 80 should not show full-history highlight`);
  }

  // 第 81 点起，全程模式标出最近 80 点。
  const historyPoints = Array.from({ length: 81 }, (_, i) => ({
    step: (i + 1) * 10,
    value: i < 45 ? 0.5 - i * 0.002 : 0.41 + (i - 45) * 0.002,
  }));
  const historyView = makeOverview({
    monitorChartMode: 'full',
    monitorLossSeries: [liveLossSeries(historyPoints)],
    esc: String,
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const history = makeHarness();
  historyView._patchTrainingDiagnostics(history.root, translate, { state: 'RUNNING', step: 811, detail: true, total_steps: 2000 }, false);
  assert.match(history.svg.innerHTML, /class="m-chart-prev-line is-full"/);
  const historyBand = /<rect class="m-full-window-bg"[^>]+>/.exec(history.svg.innerHTML)[0];
  assert.ok(!historyBand.includes('display="none"'));

  // 超长训练（尾部诊断窗宽度不足 4px）不向右溢出 plotW 边界
  const ultraLongPts = [
    ...Array.from({ length: 60 }, (_, i) => ({ step: i * 500, value: 0.5 - i * 0.003 })),
    ...Array.from({ length: 120 }, (_, i) => ({ step: 30000 + i, value: 0.32 + i * 0.0005 })),
  ];
  const ultraView = makeOverview({
    monitorChartMode: 'full',
    monitorLossSeries: [{ tag: 'loss/average', points: ultraLongPts }],
    esc: String,
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const ultraH = makeHarness();
  ultraView._patchTrainingDiagnostics(ultraH.root, translate, { state: 'RUNNING', detail: true, total_steps: 31000 }, false);
  const ultraBgTag = /<rect class="m-full-window-bg"[^>]+>/.exec(ultraH.svg.innerHTML)[0];
  const bgX = Number(/x="([^"]+)"/.exec(ultraBgTag)[1]);
  const bgW = Number(/width="([^"]+)"/.exec(ultraBgTag)[1]);
  assert.ok(bgW >= 4 && bgX + bgW <= 46 + 440 + 0.1, `expected tail highlight inside plot bounds, got x=${bgX}, w=${bgW}`);

  // _splitHeroCoordsAtX 末尾顶点边界不返回 1 点数组，且末尾之后不再覆盖前段
  const sampleCoords = [{ x: 46, y: 50 }, { x: 246, y: 60 }, { x: 486, y: 70 }];
  const nearEnd = winView._splitHeroCoordsAtX(sampleCoords, 485.97);
  assert.equal(nearEnd.prev.length, 3);
  assert.equal(nearEnd.recent.length, 2);
  const pastEnd = winView._splitHeroCoordsAtX(sampleCoords, 486);
  assert.equal(pastEnd.prev.length, 3);
  assert.equal(pastEnd.recent.length, 0);

  // 诊断结论沿用告警色，指标的数值与条共用实际波动率对应的连续色。
  const volPts = [0.25, 0.25, 0.25, 0.19, 0.31, 0.25].flatMap(value => Array(4).fill(value)).map((value, i) => ({ step: (i + 1) * 10, value }));
  const volView = makeOverview({
    monitorLossSeries: [liveLossSeries(volPts)],
    esc: String,
    _bindDiagnosticInteractions() {},
  });
  const volH = makeHarness();
  volView._patchTrainingDiagnostics(volH.root, translate, { state: 'RUNNING', step: 241, detail: true, total_steps: 300 }, false);
  assert.equal(volH.card.dataset.diagnosticTone, 'warn');
  const volatility = volView._trainingDiagnostics(volPts).volatilityPct;
  assert.equal(volH.volatilityMetric.style.get('--gauge-bar-color'), volView._volatilityGaugeColor(volatility));
});

test('live updates patch SVG attributes in place across modes, overlays, hover states, and context clears', () => {
  const makeNode = (tag, attrs = {}) => {
    const attrMap = { ...attrs };
    const el = {
      tagName: tag,
      children: [],
      parent: null,
      textContent: '',
      get firstChild() { return this.children[0] || null; },
      classList: {
        toggle(name, flag) {
          const set = new Set(String(attrMap.class || '').split(/\s+/).filter(Boolean));
          if (flag === undefined ? !set.has(name) : flag) set.add(name);
          else set.delete(name);
          attrMap.class = Array.from(set).join(' ');
          return set.has(name);
        },
        contains(name) {
          return String(attrMap.class || '').split(/\s+/).includes(name);
        },
      },
      setAttribute(k, v) { attrMap[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrMap, k) ? attrMap[k] : null; },
      removeAttribute(k) { delete attrMap[k]; },
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
        child.parent = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
        child.parent = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, child);
        else this.children.push(child);
        return child;
      },
      remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
        this.parent = null;
      },
      querySelector(sel) { return findAllBySelector(this, sel)[0] || null; },
      querySelectorAll(sel) { return findAllBySelector(this, sel); },
    };
    return el;
  };

  const buildScaffoldTree = html => {
    const rootNode = makeNode('svg');
    const stack = [rootNode];
    const tokenRe = /<(\/)?([a-zA-Z0-9-]+)([^>]*?)(\/)?>/g;
    let match;
    while ((match = tokenRe.exec(html))) {
      const [, isClose, tag, attrStr, selfClose] = match;
      if (isClose) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs = {};
      const attrRe = /([a-zA-Z0-9:-]+)(?:="([^"]*)")?/g;
      let am;
      while ((am = attrRe.exec(attrStr))) attrs[am[1]] = am[2] ?? '';
      const node = makeNode(tag, attrs);
      stack.at(-1).appendChild(node);
      if (!selfClose) stack.push(node);
    }
    return rootNode;
  };

  const findAllBySelector = (node, selector) => {
    const exact = /^\[([^=\]]+)="([^"]+)"\]$/.exec(selector);
    const presence = /^\[([^=\]]+)\]$/.exec(selector);
    const cls = /^\.([a-zA-Z0-9_-]+)$/.exec(selector);
    const matchNode = el => {
      if (exact) return el.getAttribute(exact[1]) === exact[2];
      if (presence) return el.getAttribute(presence[1]) !== null;
      if (cls) return el.classList.contains(cls[1]);
      return false;
    };
    const out = [];
    for (const child of node.children) {
      if (matchNode(child)) out.push(child);
      out.push(...findAllBySelector(child, selector));
    }
    return out;
  };

  let htmlWrites = 0;
  let tree = makeNode('svg');
  const svg = {
    dataset: {},
    setAttribute() {},
    get innerHTML() { return ''; },
    set innerHTML(val) {
      htmlWrites++;
      tree = buildScaffoldTree(val);
    },
    querySelector: sel => findAllBySelector(tree, sel)[0] || null,
    querySelectorAll: sel => findAllBySelector(tree, sel),
  };

  const readEl = { style: { setProperty() {} }, innerHTML: '' };
  const stageEl = { clientWidth: 500, classList: { toggle() {}, remove() {} } };
  const wrapClasses = new Set();
  const wrap = {
    dataset: {},
    classList: {
      add: n => wrapClasses.add(n),
      remove: n => wrapClasses.delete(n),
      contains: n => wrapClasses.has(n),
    },
    querySelector: s => ({
      '[data-hero-chart-stage]': stageEl,
      '[data-hero-chart-svg]': svg,
      '[data-chart-hud-readout]': readEl,
    })[s] || null,
  };
  const card = { dataset: {}, querySelectorAll: () => [], querySelector: s => s === '[data-hero-chart-wrap]' ? wrap : null };
  const root = { dataset: { motionContext: 'run-a' }, querySelector: () => card };

  const prevCreateElementNS = global.document.createElementNS;
  global.document.createElementNS = (_ns, tag) => makeNode(tag);
  try {
    const pts = Array.from({ length: 130 }, (_, i) => ({
      step: (i + 1) * 10,
      value: i < 90 ? 0.42 - i * 0.0015 : 0.285 + (i - 90) * 0.001,
    }));
    const lrPts = pts.map((p, i) => ({ step: p.step, value: 1e-4 * (1 - i / 200) }));
    let markers = [{ batchId: 'b1', firstIndex: 0, label: 'E1', step: 750, epoch: 1, thumbUrl: '/1.png' }];
    const view = makeOverview({
      monitorChartMode: 'window',
      lossDataVersion: 1,
      monitorLossSeries: [
        { tag: 'loss/average', points: pts },
        { tag: 'lr/unet', points: lrPts },
      ],
      esc: String,
      _previewMarkersForChart: () => markers,
      _bindDiagnosticInteractions() {},
      _patchDiagnosticGauges() {},
    });
    const runPatch = () => view._patchTrainingDiagnostics(root, k => k, { state: 'RUNNING', detail: true, total_steps: 2000 }, false);

    runPatch();
    assert.equal(htmlWrites, 1);
    assert.equal(svg.dataset.heroScaffold, 'series');
    const latestGroup = svg.querySelector('[data-hero-latest]');
    const pulse1 = svg.querySelector('[data-hero-latest-pulse]');
    const mainPath = svg.querySelector('[data-hero-main-path]');
    assert.ok(pulse1);
    assert.equal(latestGroup.children[0], pulse1);
    const firstCy = pulse1.getAttribute('cy');
    const firstMainD = mainPath.getAttribute('d');

    // 新增点 + 增加预览事件 + 开启 LR 叠加：原地 patch
    pts.push({ step: 1310, value: 0.35 }, { step: 1320, value: 0.37 });
    lrPts.push({ step: 1310, value: 3e-5 }, { step: 1320, value: 2.8e-5 });
    markers.push({ batchId: 'b2', firstIndex: 1, label: 'E2', step: 800, epoch: 2, thumbUrl: '/2.png' });
    view.monitorChartShowLr = true;
    view.lossDataVersion = 2;
    runPatch();
    assert.equal(htmlWrites, 1, 'live update patches SVG attributes in place without rebuilding innerHTML');
    const pulse2 = svg.querySelector('[data-hero-latest-pulse]');
    assert.equal(pulse2, pulse1, 'live pulse node identity is preserved across updates');
    assert.notEqual(pulse2.getAttribute('cy'), firstCy);
    assert.notEqual(mainPath.getAttribute('d'), firstMainD);
    assert.equal(svg.querySelector('[data-hero-lr-path]').getAttribute('display'), null);
    assert.equal(svg.querySelector('[data-hero-events]').children.length, 2);

    // 暂停移除脉冲节点，恢复后插回 latest-dot 之前
    view.controlState = { state: 'paused' };
    runPatch();
    assert.equal(htmlWrites, 1);
    assert.equal(svg.querySelector('[data-hero-latest-pulse]'), null);

    view.controlState = null;
    runPatch();
    assert.equal(htmlWrites, 1);
    const pulse3 = svg.querySelector('[data-hero-latest-pulse]');
    assert.ok(pulse3);
    assert.equal(latestGroup.children[0], pulse3, 'resumed pulse circle inserts before latest-dot');

    // 悬停分段样式与 HUD 圆点类同步；切到 full 模式原地更新 is-full 与事件缩减
    const smoothDot = svg.querySelector('[data-hover-dot="smooth"]');
    view._updateHeroChartHover(wrap, 0.25);
    assert.equal(wrap.classList.contains('is-hovering'), true);
    assert.equal(smoothDot.classList.contains('is-prev-seg'), true);
    assert.equal(smoothDot.classList.contains('is-full-seg'), false);
    assert.ok(readEl.innerHTML.includes('m-hud-item is-smooth is-prev-seg"'), readEl.innerHTML);

    view.monitorChartMode = 'full';
    view.monitorChartShowLr = false;
    markers = [];
    runPatch();
    assert.equal(htmlWrites, 1);
    const prevPath = svg.querySelector('[data-hero-prev-path]');
    assert.equal(prevPath.classList.contains('is-full'), true);
    assert.equal(svg.querySelector('[data-hero-lr-path]').getAttribute('display'), 'none');
    assert.equal(svg.querySelector('[data-hero-events]').children.length, 0);

    view._updateHeroChartHover(wrap, 0.12);
    assert.equal(smoothDot.classList.contains('is-prev-seg'), true);
    assert.equal(smoothDot.classList.contains('is-full-seg'), true);
    assert.ok(readEl.innerHTML.includes('m-hud-item is-smooth is-prev-seg is-full-seg"'), readEl.innerHTML);
    view._updateHeroChartHover(wrap, 0.75);
    assert.equal(smoothDot.classList.contains('is-prev-seg'), false);

    // 切换 motionContext 或点数回落 < 6（window 模式）时清除残留 hover 态
    root.dataset.motionContext = 'run-b';
    runPatch();
    assert.equal(wrap.classList.contains('is-hovering'), false);
    assert.equal(svg.querySelector('[data-chart-hover]').getAttribute('display'), 'none');

    view.monitorChartMode = 'window';
    runPatch();
    assert.equal(wrap.hidden, false);
    view._updateHeroChartHover(wrap, 0.85);
    assert.equal(wrap.classList.contains('is-hovering'), true);
    pts.splice(0, pts.length, { step: 10, value: 0.3 }, { step: 20, value: 0.28 }, { step: 30, value: 0.26 });
    view.lossDataVersion = 3;
    runPatch();
    assert.equal(wrap.hidden, true);
    assert.equal(wrap.classList.contains('is-hovering'), false);
    assert.equal(svg.querySelector('[data-chart-hover]').getAttribute('display'), 'none');
  } finally {
    if (prevCreateElementNS === undefined) delete global.document.createElementNS;
    else global.document.createElementNS = prevCreateElementNS;
  }
});

test('the dashboard expands chart and metrics together only when a loaded live diagnostic reaches 6 completed points', () => {
  const metrics = { hidden: true, getBoundingClientRect: () => ({height: 100}), animate() {} };
  const svg = { setAttribute() {}, innerHTML: '' };
  const wrap = {
    hidden: true, dataset: {}, classList: { add() {}, remove() {} },
    getBoundingClientRect: () => ({height: 152}), animate() {},
    querySelector: s => ({ '[data-hero-chart-stage]': { clientWidth: 500 }, '[data-hero-chart-svg]': svg })[s] || null,
  };
  let reveals = 0;
  const card = {
    dataset: {}, querySelectorAll: () => [],
    querySelector: selector => ({ '.m-diagnostic-metrics': metrics, '[data-hero-chart-wrap]': wrap })[selector] || null,
    getBoundingClientRect: () => ({height: 200}),
    animate() { reveals++; },
  };
  const root = { dataset: {motionContext: 'run-a'}, _metricMotion: true, querySelector: () => card };
  const view = makeOverview({lossDataVersion: 0, esc: String, _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {}});
  const paint = (detail, count) => {
    view.monitorLossSeries = [{tag: 'loss/average', points: Array.from({length: count}, (_, i) => ({step:i+1, value:1/(i+1)}))}];
    view.lossDataVersion++;
    view._patchTrainingDiagnostics(root, String, {state:'RUNNING', detail}, false);
  };
  paint(false, 0);
  assert.equal(card.hidden, true);
  assert.equal(card.dataset.diagnosticState, undefined);
  paint(true, 8);
  assert.equal(card.hidden, false);
  assert.equal(wrap.hidden, false);
  assert.equal(metrics.hidden, false);
  assert.equal(reveals, 0, 'restoring a populated snapshot stays still');
  root.dataset.motionContext = 'run-b';
  paint(true, 0);
  assert.equal(card.hidden, false);
  assert.equal(card.dataset.diagnosticState, 'insufficient');
  assert.equal(wrap.hidden, true);
  paint(true, 3);
  paint(true, 6); // 5 completed points under RUNNING
  assert.equal(wrap.hidden, true, 'window chart stays hidden before 6 completed points');
  assert.equal(metrics.hidden, true);
  assert.equal(reveals, 0);
  paint(true, 7); // 6 completed points: chart and metrics reveal together
  assert.equal(wrap.hidden, false);
  assert.equal(metrics.hidden, false);
  assert.equal(reveals, 1);
});

test('a short run can switch from the insufficient diagnostic window to its full Loss history', () => {
  const modes = {};
  const svg = { setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] };
  const wrap = { dataset: {}, querySelector: s => ({
    '[data-hero-chart-stage]': { clientWidth: 500 }, '[data-hero-chart-svg]': svg,
  })[s] };
  const card = { dataset: {}, querySelectorAll: () => [], querySelector: s => ({
    '.m-chart-modes': modes, '[data-hero-chart-wrap]': wrap,
  })[s] };
  const root = { dataset: {}, querySelector: () => card };
  const points = Array.from({ length: 4 }, (_, i) => ({ step: i + 1, value: 1 / (i + 1) }));
  const view = makeOverview({ monitorLossSeries: [{ tag: 'loss/average', points }],
    _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {} });
  const draw = () => view._patchTrainingDiagnostics(root, String, { state: 'FINISHED', detail: true }, true);
  draw();
  assert.equal(wrap.hidden, true);
  assert.equal(modes.hidden, false);
  view.monitorChartMode = 'full';
  draw();
  assert.equal(wrap.hidden, false);
  assert.equal(wrap._chartState.coords.length, 4);
  view.monitorLossSeries[0].points = points.slice(0, 1);
  view.monitorChartMode = 'window';
  draw();
  assert.equal(modes.hidden, true);
});

test('diagnostic tone transition activates only after initial paint within the same live context', () => {
  const cardClasses = new Set();
  const card = {
    dataset: {},
    classList: {
      toggle(name, flag) {
        if (flag === undefined ? !cardClasses.has(name) : flag) cardClasses.add(name);
        else cardClasses.delete(name);
        return cardClasses.has(name);
      },
      contains: name => cardClasses.has(name),
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const root = { dataset: { motionContext: 'live-1' }, _metricMotion: false, querySelector: () => card };
  const pts = [{ step: 10, value: 0.36 }, { step: 20, value: 0.34 }];
  const view = makeOverview({
    lossDataVersion: 1,
    monitorLossSeries: [liveLossSeries(pts)],
    esc: String,
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const patch = () => view._patchTrainingDiagnostics(root, k => k, { state: 'RUNNING', step: pts.at(-1).step + 1, detail: true, total_steps: 100 }, false);

  // 1. 刷新首帧（数据尚不足）不启用颜色过渡
  patch();
  assert.equal(card.dataset.diagnosticState, 'insufficient');
  assert.equal(card.classList.contains('is-live-motion'), false);

  // 2. 异步接口首次拉回有效 Loss（即便此时 _metricMotion 已为 true），首帧上色仍直接落位不闪烁
  root._metricMotion = true;
  pts.push({ step: 30, value: 0.32 }, { step: 40, value: 0.28 }, { step: 50, value: 0.26 }, { step: 60, value: 0.24 });
  view.lossDataVersion = 2;
  patch();
  assert.equal(card.dataset.diagnosticTone, 'neutral');
  assert.equal(card.classList.contains('is-live-motion'), false);

  // 3. 同一上下文的后续实时更新开启平滑变色过渡
  pts.push({ step: 70, value: 0.31 }, { step: 80, value: 0.35 });
  view.lossDataVersion = 3;
  patch();
  assert.equal(card.classList.contains('is-live-motion'), true);

  // 4. 切换上下文或切入历史模式（_metricMotion = false）立即关闭过渡
  root.dataset.motionContext = 'live-2';
  patch();
  assert.equal(card.classList.contains('is-live-motion'), false);

  pts.push({ step: 90, value: 0.36 });
  view.lossDataVersion = 4;
  patch();
  assert.equal(card.classList.contains('is-live-motion'), true);

  root._metricMotion = false;
  view.lossDataVersion = 5;
  patch();
  assert.equal(card.classList.contains('is-live-motion'), false);
});

test('live rescaling moves the axis and plotted values together at fixed window spacing and retargets from the visible range', t => {
  const frames = new Map();
  let id = 0;
  const originalRequest = global.requestAnimationFrame;
  const originalCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = cb => { frames.set(++id, cb); return id; };
  global.cancelAnimationFrame = key => frames.delete(key);
  t.after(() => {
    if (originalRequest) global.requestAnimationFrame = originalRequest; else delete global.requestAnimationFrame;
    if (originalCancel) global.cancelAnimationFrame = originalCancel; else delete global.cancelAnimationFrame;
  });
  const advance = ms => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(cb => cb(performance.now() + ms));
  };
  const svg = { setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] };
  const wrap = {dataset: {}, querySelector: key => ({
    '[data-hero-chart-stage]': {clientWidth: 500}, '[data-hero-chart-svg]': svg,
  })[key]};
  const points = [.4, .31, .24, .22, .23, .21].map((value, step) => ({step, value}));
  const lrPoints = points.map(p => ({step: p.step, value: .001}));
  const view = makeOverview({_previewMarkersForChart: () => [], _monitorMotionAllowed: () => true, monitorChartShowLr: true});
  const draw = () => view._renderHeroChart(wrap, {
    mode: 'window', points, best: view._lowestLossPoint(points), diagnostic: view._trainingDiagnostics(points), lrPoints,
  }, {state: 'RUNNING'}, false, String);
  draw();
  const initial = wrap._chartState.range.high;
  const oldX = wrap._chartState.coords[2].x;
  const oldSplitX = wrap._chartState.splitX;
  const pitch = wrap._chartState.plotW / 79;
  assert.ok(Math.abs((wrap._chartState.coords[3].x - oldX) - pitch) < 1e-8);
  assert.ok(Math.abs(wrap._chartState.coords.at(-1).x - (wrap._chartState.padL + wrap._chartState.plotW)) < 1e-8);
  points.push({step: 6, value: .6});
  lrPoints.push({step: 6, value: .002});
  draw();
  assert.equal(wrap._chartState.range.high, initial);
  advance(80);
  const state = wrap._chartState;
  assert.ok(initial < state.range.high && state.range.high < state.targetRange.high);
  assert.ok(state.splitX < oldSplitX && state.splitX > oldSplitX - pitch * 0.5);
  const point = state.coords[2];
  assert.ok(point.x < oldX && point.x > oldX - pitch);
  assert.ok(Math.abs((state.coords[3].x - point.x) - pitch) < 1e-8, 'horizontal point spacing stays locked during live animation');
  assert.ok(state.range.lrMax > .001 && state.range.lrMax < .002);
  assert.equal(state.coords.at(-1).step, 5, 'hover exposes only recorded points inside the moving viewport');
  const expectedY = state.padT + state.plotH * (state.range.high - point.value) / (state.range.high - state.range.low);
  assert.ok(Math.abs(point.y - expectedY) < 1e-8);
  points.push({step: 7, value: .75});
  draw();
  assert.equal(wrap._chartState.range.high, state.range.high);
  assert.equal(frames.size, 1);
  advance(300);
  assert.ok(wrap._chartState.range.high > .75);
  assert.ok(Math.abs(wrap._chartState.coords[2].x - (state.padL + state.plotW - 5 * pitch)) < 1e-8);
  assert.ok(Math.abs((wrap._chartState.coords[3].x - wrap._chartState.coords[2].x) - pitch) < 1e-8);
  assert.equal(frames.size, 0);
});

test('the diagnostic window aligns right at fixed 80-point spacing without deformation, hides unfilled hover, and scrolls seamlessly', () => {
  const svg = { setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] };
  const wrapClasses = new Set();
  const wrap = {
    dataset: {},
    classList: {
      add: n => wrapClasses.add(n),
      remove: n => wrapClasses.delete(n),
      contains: n => wrapClasses.has(n),
    },
    querySelector: s => ({
      '[data-hero-chart-stage]': { clientWidth: 600 },
      '[data-hero-chart-svg]': svg,
    })[s] || null,
  };
  const card = {dataset: {}, querySelectorAll: () => [], querySelector: s => s === '[data-hero-chart-wrap]' ? wrap : null};
  const root = {dataset: {}, querySelector: () => card};
  const points = Array.from({length: 6}, (_, i) => ({step: i * 20 + 20, value: .1 + i / 100}));
  const view = makeOverview({lossDataVersion: 0, monitorLossSeries: [liveLossSeries(points)],
    _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {}});
  const render = (running = true) => {
    view.lossDataVersion++;
    view._patchTrainingDiagnostics(root, String, {state: running ? 'RUNNING' : 'FINISHED', step: points.at(-1).step + 1, detail: true, total_steps:12000}, !running);
    return wrap._chartState;
  };
  const first = render();
  const fixedPitch = first.plotW / 79;
  assert.equal(first.coords.length, 6);
  assert.equal(first.stepSpan, 79 * 20);
  assert.ok(Math.abs(first.coords.at(-1).x - (first.padL + first.plotW)) < 1e-8);
  assert.ok(Math.abs((first.coords[1].x - first.coords[0].x) - fixedPitch) < 1e-8);

  // 左侧空白区悬停应自动清除（即使在历史/非滚动模式下）
  view._updateHeroChartHover(wrap, (first.padL + 10) / first.width);
  assert.equal(wrap.classList.contains('is-hovering'), false);
  view._updateHeroChartHover(wrap, (first.padL + first.plotW - 2) / first.width);
  assert.equal(wrap.classList.contains('is-hovering'), true);

  for (let step = 140; step <= 2460; step += 20) {
    points.push({step, value:.21});
    const state = render();
    assert.equal(state.coords[0].step, Math.max(20, step - 79 * 20));
    assert.ok(Math.abs(state.coords.at(-1).x - (first.padL + first.plotW)) < 1e-8);
    assert.equal(state.stepSpan, 79 * 20);
    assert.ok(Math.abs((state.coords[1].x - state.coords[0].x) - fixedPitch) < 1e-8);
    assert.doesNotMatch(svg.innerHTML, /sampleStep[^<]*-\d+/);
    const unfilledBg = /data-hero-unfilled-bg[^>]*>/.exec(svg.innerHTML)[0];
    const prevMeanLine = /data-hero-prev-mean[^>]*>/.exec(svg.innerHTML)[0];
    if (points.length < 80) {
      assert.ok(!unfilledBg.includes('display="none"'), `unfilled bg visible at count ${points.length}`);
      assert.ok(prevMeanLine.includes(`x1="${state.coords[0].x.toFixed(1)}"`), 'previous mean starts at actual data start');
      assert.ok(state.coords[0].x > first.padL + 2);
    } else {
      assert.ok(unfilledBg.includes('display="none"'), `unfilled bg hides once 80 points fill (${points.length})`);
      assert.ok(Math.abs(state.coords[0].x - first.padL) < 1e-8);
      assert.ok(Math.abs(state.splitX - (first.padL + first.plotW / 2)) < 1e-8);
    }
    if (step === 2020) {
      const diagnostic = view._trainingDiagnostics(points);
      assert.deepEqual([diagnostic.windowSize, diagnostic.previousStartStep, diagnostic.previousEndStep,
        diagnostic.recentStartStep, diagnostic.recentEndStep], [40, 440, 1220, 1240, 2020]);
    }
    if (step <= 200) assert.equal(state.range.low, first.range.low);
  }
  // 历史/已结束短训练在诊断窗口下同样右对齐定尺且屏蔽左侧空白 hover
  const shortHistory = Array.from({length: 12}, (_, i) => ({step: (i + 1) * 10, value: 0.3 - i * 0.01}));
  view.monitorLossSeries = [{tag: 'loss/average', points: shortHistory}];
  const histState = render(false);
  assert.ok(histState.coords[0].x > histState.padL + 100);
  assert.ok(Math.abs(histState.coords.at(-1).x - (histState.padL + histState.plotW)) < 1e-8);
  view._updateHeroChartHover(wrap, (histState.padL + 10) / histState.width);
  assert.equal(wrap.classList.contains('is-hovering'), false);

  // 空坐标不抛错
  wrap._chartState.coords = [];
  view._updateHeroChartHover(wrap, 0.5);
  assert.equal(wrap.classList.contains('is-hovering'), false);

  // 大步数/日文长标签在半窗较窄时自动标记 is-crowded，且 LR 叠加时右下最低点标注避让 axisLrMin
  const jaDict = JSON.parse(readRepo('frontend/i18n/ja-JP.json'));
  const jaT = key => key.split('.').reduce((v, part) => v?.[part], jaDict) ?? key;
  const jaView = makeOverview({
    t: jaT,
    _shellLocale: 'ja-JP',
    esc: String,
    monitorChartShowLr: true,
    monitorLossSeries: [
      { tag: 'loss/average', points: Array.from({ length: 14 }, (_, i) => ({ step: 10001 + i, value: i === 12 ? 0.04 : 0.2 - i * 0.004 })) },
      { tag: 'lr/unet', points: Array.from({ length: 14 }, (_, i) => ({ step: 10001 + i, value: 1e-4 - i * 2e-6 })) },
    ],
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  jaView._patchTrainingDiagnostics(root, k => jaView.tMonitor(k), { state: 'FINISHED', detail: true, total_steps: 20000 }, true);
  assert.match(svg.innerHTML, /class="is-crowded" data-hero-axis-start/);
  const bestCalloutY = Number(/data-hero-best-callout[^>]*y="([^"]+)"/.exec(svg.innerHTML)[1]);
  assert.ok(bestCalloutY <= 12 + 114 - 19, `expected bestCalloutY (${bestCalloutY}) above bottom-right LR label`);

  view.monitorLossSeries = [liveLossSeries(points)];
  render(true);
  points.push({step: 10000, value:.22});
  const sparse = render();
  const diagnostic = view._trainingDiagnostics(points);
  const cutoff = sparse.minStep + (sparse.splitX - sparse.padL) / sparse.plotW * sparse.stepSpan;
  assert.ok(cutoff >= diagnostic.previousEndStep - 1e-8 && cutoff <= diagnostic.recentStartStep + 1e-8);
});

test('the summary Loss sparkline anchors right at fixed 30-slot spacing without stretching early samples', () => {
  const makeEl = () => {
    const attrs = {};
    return {
      dataset: {},
      style: {},
      children: [],
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
      remove() {
        const idx = hits.children.indexOf(this);
        if (idx >= 0) hits.children.splice(idx, 1);
      },
    };
  };
  const pulse = makeEl(), dot = makeEl(), line = makeEl(), area = makeEl(), mean = makeEl();
  const hits = {
    children: [],
    get lastElementChild() { return this.children.at(-1) || null; },
    insertAdjacentHTML(_pos, _html) {
      const item = makeEl();
      item.children = [makeEl(), makeEl(), makeEl()];
      this.children.push(item);
    },
  };
  let hasSvg = false;
  const host = {
    isConnected: true,
    hidden: true,
    set innerHTML(val) { hasSvg = Boolean(val); },
    get innerHTML() { return hasSvg ? '<svg/>' : ''; },
    closest: () => null,
    querySelector: sel => {
      if (!hasSvg) return null;
      return ({
        '.m-loss-profile-svg': {},
        '.m-loss-pulse': pulse,
        '.m-loss-dot': dot,
        '.m-loss-line': line,
        '.m-loss-area': area,
        '.m-loss-mean-line': mean,
        '[data-loss-hits]': hits,
      })[sel] || null;
    },
  };
  const root = { querySelector: sel => sel === '[data-summary-viz="loss"]' ? host : null };
  const view = makeOverview();
  const slotStep = (188 - 6) / 29;

  for (const count of [2, 8, 30, 31]) {
    const points = Array.from({ length: count }, (_, i) => ({ step: i + 1, value: 0.3 - i * 0.005 }));
    view._patchSummaryLossProfile(root, { tag: 'loss/current', points }, 0.22, false, String, false);
    const trace = host._lossTrace.points;
    const expectedStart = count >= 30 ? 6 : 188 - (count - 1) * slotStep;
    assert.ok(Math.abs(trace[0].x - expectedStart) < 1e-8, `count ${count} start x`);
    assert.ok(Math.abs(trace.at(-1).x - 188) < 1e-8, `count ${count} tip stays anchored at xEnd`);
    assert.ok(Math.abs((trace[1].x - trace[0].x) - slotStep) < 1e-8, `count ${count} pitch locked`);
    assert.equal(mean.getAttribute('x1'), trace[0].x.toFixed(1));
    assert.ok(area.getAttribute('d').endsWith(`L188 92 L${trace[0].x.toFixed(1)} 92 Z`));
    const firstHitLeft = Number(hits.children[0].children[0].getAttribute('x'));
    assert.ok(firstHitLeft >= trace[0].x - slotStep / 2 - 0.11, `count ${count} hit rect excludes left whitespace`);
  }
});

test('the summary LR sparkline keeps early 30-point spacing when totalSteps is unknown, maps full-range when known, and splits hit rects at midpoints', () => {
  const parseLrHits = html => Array.from(
    html.matchAll(/<rect class="m-viz-hit" x="([^"]+)" y="6" width="([^"]+)"[^>]*\/>.*?<circle class="m-viz-hover-dot is-lr" cx="([^"]+)" cy="([^"]+)"/g),
    m => ({ x: Number(m[1]), width: Number(m[2]), cx: Number(m[3]), cy: Number(m[4]) })
  );
  const makeLrHost = () => ({
    isConnected: true,
    hidden: true,
    innerHTML: '',
    closest: () => null,
    querySelector: () => null,
  });

  // 1. 未知 totalSteps（0 / null / -1）：早期 2..29 点保留 30 点跨度，不拉满全宽
  const view = makeOverview({ esc: String });
  const slotStep = (188 - 6) / 29;
  for (const totalSteps of [0, null, -1]) {
    for (const count of [2, 8, 29, 30]) {
      const host = makeLrHost();
      const root = { _metricMotion: false, querySelector: sel => sel === '[data-summary-viz="lr"]' ? host : null };
      const points = Array.from({ length: count }, (_, i) => ({ step: i * 10, value: 1e-4 }));
      view._patchSummaryLrProfile(root, { tag: 'lr/unet', points }, totalSteps, true, String);
      const hits = parseLrHits(host.innerHTML);
      assert.equal(hits.length, count);
      const expectedLastX = 6 + (count - 1) * slotStep;
      assert.ok(Math.abs(hits[0].cx - 6) <= 0.1, `totalSteps=${totalSteps} count=${count} starts at xStart`);
      assert.ok(Math.abs(hits.at(-1).cx - expectedLastX) <= 0.1, `totalSteps=${totalSteps} count=${count} keeps fixed pitch`);
      if (count < 30) {
        assert.ok(hits.at(-1).cx < 188 - 2, `count=${count} should not stretch to xEnd`);
      } else {
        assert.ok(Math.abs(hits.at(-1).cx - 188) <= 0.1, 'count=30 reaches xEnd');
      }
    }
  }

  // 2. 已知 totalSteps：全程左->右映射，且热区不进入右侧未来预测区
  const schedView = makeOverview({
    esc: String,
    trainParams: [
      { key: 'optimizer_type', value: 'AdamW8bit' },
      { key: 'lr_scheduler', value: 'cosine' },
      { key: 'lr_warmup_steps', value: 100 },
      { key: 'learning_rate', value: 1e-4 },
    ],
  });
  const knownHost = makeLrHost();
  const knownRoot = { _metricMotion: false, querySelector: sel => sel === '[data-summary-viz="lr"]' ? knownHost : null };
  const earlyPts = [{ step: 50, value: 5e-5 }, { step: 150, value: 1e-4 }, { step: 300, value: 9.0e-5 }];
  schedView._patchSummaryLrProfile(knownRoot, { tag: 'lr/unet', points: earlyPts }, 1000, true, String);
  const knownHits = parseLrHits(knownHost.innerHTML);
  assert.equal(knownHits.length, 3);
  const expected300X = 6 + (300 / 1000) * (188 - 6);
  assert.ok(Math.abs(knownHits[2].cx - expected300X) <= 0.1);
  assert.match(knownHost.innerHTML, /class="m-lr-future" d="M[^"]+ 188\.0 /);
  const lastKnownRight = knownHits[2].x + knownHits[2].width;
  assert.ok(lastKnownRight <= expected300X + 6 + 0.15, `last hit right ${lastKnownRight} stays out of future region`);

  view._patchSummaryLrProfile(knownRoot, { points: [{ step: 1, value: 1e-4 }, { step: 2, value: 2e-4 }] }, 10000, true, String);
  const denseHits = parseLrHits(knownHost.innerHTML);
  assert.equal(denseHits.length, 2);
  assert.equal(denseHits[0].cx, denseHits[1].cx, 'both guides still use the true full-run scale');
  assert.ok(denseHits.every(hit => hit.width >= 3), 'each early step has a separate pointer target');
  assert.equal(denseHits[0].x + denseHits[0].width, denseHits[1].x);

  // 已知 totalSteps 且 lastStep > totalSteps：映射到 [minStep, Math.max(totalSteps, lastStep)]
  const overflowHost = makeLrHost();
  const overflowRoot = { _metricMotion: false, querySelector: sel => sel === '[data-summary-viz="lr"]' ? overflowHost : null };
  schedView._patchSummaryLrProfile(overflowRoot, { tag: 'lr/unet', points: [{ step: 10, value: 1e-4 }, { step: 1200, value: 1e-5 }] }, 1000, true, String);
  const overflowHits = parseLrHits(overflowHost.innerHTML);
  assert.ok(Math.abs(overflowHits[1].cx - 188) <= 0.1);

  // 3. 相邻中点热区无重叠、无空洞、且严格裁剪在 [xStart, xEnd]
  for (const irregularPts of [
    [
      { step: 0, value: 1e-4 },
      { step: 30, value: 1.2e-4 },
      { step: 90, value: 8e-5 },
      { step: 150, value: 6e-5 },
      { step: 290, value: 2e-5 },
    ],
    [
      { step: 1, value: 1e-4 },
      { step: 2, value: 9e-5 },
      { step: 100, value: 5e-5 },
    ],
    Array.from({ length: 64 }, (_, i) => ({ step: i + 1, value: 1e-4 })),
  ]) {
    const irregularHost = makeLrHost();
    const irregularRoot = { _metricMotion: false, querySelector: sel => sel === '[data-summary-viz="lr"]' ? irregularHost : null };
    const total = irregularPts.length === 64 ? 10000 : 0;
    view._patchSummaryLrProfile(irregularRoot, { tag: 'lr/unet', points: irregularPts }, total, false, String);
    const irregularHits = parseLrHits(irregularHost.innerHTML);
    assert.equal(irregularHits.length, irregularPts.length);
    assert.ok(irregularHits[0].x >= 6 - 1e-6, 'first hit rect never enters left margin < xStart');
    assert.ok(irregularHits.at(-1).x + irregularHits.at(-1).width <= 188 + 1e-6, 'last hit rect never exceeds xEnd');
    for (let i = 1; i < irregularHits.length; i++) {
      const prevRight = irregularHits[i - 1].x + irregularHits[i - 1].width;
      assert.ok(Math.abs(prevRight - irregularHits[i].x) < 1e-9);
    }
    assert.ok(irregularHits.every(hit => hit.width > 0));
  }

  // 数据回落 < 2 点时同步清理 HUD 与 tile title
  const shrinkHost = makeLrHost();
  const hud = { classList: { removed: [], remove(c) { this.removed.push(c); } } };
  const shrinkTile = {
    title: 'stale',
    removeAttribute(k) { if (k === 'title') this.title = null; },
    querySelector: sel => sel === '[data-summary-hud]' ? hud : null,
  };
  shrinkHost.closest = () => shrinkTile;
  shrinkHost._hoverIdx = 1;
  const shrinkRoot = { _metricMotion: false, querySelector: sel => sel === '[data-summary-viz="lr"]' ? shrinkHost : null };
  view._patchSummaryLrProfile(shrinkRoot, { tag: 'lr/unet', points: [{ step: 1, value: 1e-4 }] }, 0, false, String);
  assert.equal(shrinkHost.hidden, true);
  assert.equal(shrinkHost._hoverIdx, undefined);
  assert.equal(shrinkTile.title, null);
  assert.deepEqual(hud.classList.removed, ['is-visible']);

  // 4. LR 卡片继承 .m-metric-viz 左侧渐隐遮罩
  const appCss = readRepo('frontend/css/app.css');
  assert.doesNotMatch(appCss, /\.m-metric-viz-lr\b[^}]*mask-image\s*:\s*none/);

  // 5. _transitionSummaryProjection 与 _summaryLrPainter 在只变 Y 轴和变点数/X 轴时均无异常残留
  const { withAnimationFrames } = require('./helpers-animation.cjs');
  withAnimationFrames(({ tick, frames }) => {
    const prevCreateElementNS = global.document.createElementNS;
    const makeSvgEl = (cls = '') => {
      const attrs = { class: cls };
      return {
        children: [],
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
        removeAttribute(k) { delete attrs[k]; },
        remove() {},
      };
    };
    global.document.createElementNS = (_ns, _tag) => makeSvgEl();
    try {
      const svg = {
        past: makeSvgEl('m-lr-past'),
        area: makeSvgEl('m-lr-area'),
        future: makeSvgEl('m-lr-future'),
        dot: makeSvgEl('m-lr-dot'),
        pulse: makeSvgEl('m-lr-pulse'),
        guides: [],
        dots: [],
        hitsGroup: {
          _html: '',
          set innerHTML(val) {
            this._html = val;
            svg.guides = Array.from(val.matchAll(/class="m-viz-guide"[^>]*x1="([^"]+)"[^>]*y1="([^"]+)"/g), m => {
              const el = makeSvgEl('m-viz-guide');
              el.setAttribute('x1', m[1]);
              el.setAttribute('y1', m[2]);
              return el;
            });
            svg.dots = Array.from(val.matchAll(/class="m-viz-hover-dot is-lr" cx="([^"]+)" cy="([^"]+)"/g), m => {
              const el = makeSvgEl('m-viz-hover-dot is-lr');
              el.setAttribute('cx', m[1]);
              el.setAttribute('cy', m[2]);
              return el;
            });
          },
          get innerHTML() { return this._html; },
        },
        querySelector(sel) {
          return ({
            '[data-lr-hits]': this.hitsGroup,
            '.m-lr-area': this.area,
            '.m-lr-future': this.future,
            '.m-lr-past': this.past,
            '.m-lr-dot': this.dot,
            '.m-lr-pulse': this.pulse,
          })[sel] || null;
        },
        querySelectorAll(sel) {
          if (sel === '.m-lr-dot, .m-lr-pulse') return [this.dot, this.pulse];
          if (sel === '.m-viz-guide') return this.guides;
          if (sel === '.m-viz-hover-dot') return this.dots;
          return [];
        },
        insertBefore() {},
      };
      const host = {
        isConnected: true,
        hidden: false,
        closest: () => null,
        querySelector: sel => sel === '.m-lr-profile-svg' ? svg : svg.querySelector(sel),
        querySelectorAll: sel => svg.querySelectorAll(sel),
      };
      const root = { _metricMotion: true, querySelector: sel => sel === '[data-summary-viz="lr"]' ? host : null };
      const animView = makeOverview({ esc: String, _monitorMotionAllowed: () => true });

      const series1 = [{ step: 0, value: 1e-4 }, { step: 10, value: 1e-4 }];
      animView._patchSummaryLrProfile(root, { tag: 'lr/unet', points: series1 }, 0, true, String);
      assert.equal(frames.size, 0);

      // Y 轴比例变化（新增更高 LR 点，同时点数/X 增加）：启动平滑过渡且全部 hover 点数同步
      const series2 = [...series1, { step: 20, value: 2e-4 }];
      animView._patchSummaryLrProfile(root, { tag: 'lr/unet', points: series2 }, 0, true, String);
      assert.equal(frames.size, 1);
      assert.equal(svg.dots.length, 3);
      const midDotCy = Number(svg.dots[2].getAttribute('cy'));
      tick(performance.now() + 80);
      assert.notEqual(Number(svg.dots[2].getAttribute('cy')), midDotCy);
      tick(performance.now() + 300);
      assert.equal(frames.size, 0);

      // 仅 X/点数变化（maxVal 不变）：不启动额外投影动画且直接更新为 4 点坐标
      const series3 = [...series2, { step: 30, value: 1.5e-4 }];
      animView._patchSummaryLrProfile(root, { tag: 'lr/unet', points: series3 }, 0, true, String);
      assert.equal(frames.size, 0);
      assert.equal(svg.dots.length, 4);
      assert.ok(Math.abs(Number(svg.dot.getAttribute('cx')) - (6 + 3 * slotStep)) <= 0.1);
    } finally {
      if (prevCreateElementNS === undefined) delete global.document.createElementNS;
      else global.document.createElementNS = prevCreateElementNS;
    }
  });
});
