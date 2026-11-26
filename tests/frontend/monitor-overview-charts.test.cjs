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

test('hero chart downsampling keeps endpoints and extrema while the diagnostic window compares two sets of 50 points', () => {
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
  assert.equal(windowPts.length, 100);
  const diag = view._trainingDiagnostics(windowPts);
  assert.equal(diag.windowSize, 50);
  assert.equal(diag.previousStartStep, 1101);
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
  const series = {tag: 'loss/average', points: pts, min: .1, min_step: 2};
  const svg = {setAttribute() {}};
  const wrap = { dataset: {}, querySelector: selector => ({
    '[data-hero-chart-stage]': {clientWidth: 500}, '[data-hero-chart-svg]': svg,
  })[selector] };
  const card = {dataset: {}, querySelectorAll: () => [], querySelector: selector => selector === '[data-hero-chart-wrap]' ? wrap : null};
  const root = {dataset: {}, querySelector: () => card};
  const view = makeOverview({monitorChartMode: 'full', monitorLossSeries: [series], esc: String,
    _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {}});
  const patch = () => view._patchTrainingDiagnostics(root, key => key, {state: 'RUNNING', detail: true}, false);
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
  const svg = { setAttribute() {} };
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
  assert.equal(steps.at(-1), 16000);
  assert.ok(series.points.length <= 5000);
  assert.deepEqual(view._trainingDiagnosticPoints(), points.slice(-100));
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
      { tag: 'loss/average', points: [{ step: 10, value: 0.4 }, { step: 20, value: 0.3 }, { step: 30, value: 0.2 }, { step: 40, value: 0.25 }, { step: 50, value: 0.22 }, { step: 60, value: 0.2 }] },
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
    monitorLossSeries: [{ tag: 'loss/average', points: winPts }],
    esc: String,
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const winH = makeHarness();
  winView._patchTrainingDiagnostics(winH.root, translate, { state: 'RUNNING', detail: true, total_steps: 100 }, false);
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

  // 前 100 点在全程模式下按中点切分，覆盖奇数采样和窗口刚满的边界。
  for (const count of [7, 99, 100]) {
    const shortFullPts = Array.from({ length: count }, (_, i) => ({
      step: (i + 1) * 10,
      value: 0.4 - i * 0.001,
    }));
    const shortView = makeOverview({
      monitorChartMode: 'full',
      monitorLossSeries: [{ tag: 'loss/average', points: shortFullPts }],
      esc: String,
      _bindDiagnosticInteractions() {},
      _patchDiagnosticGauges() {},
    });
    const shortH = makeHarness();
    shortView._patchTrainingDiagnostics(shortH.root, translate, { state: 'RUNNING', detail: true, total_steps: 1200 }, false);
    assert.match(shortH.svg.innerHTML, /class="m-chart-prev-line"/);
    assert.doesNotMatch(shortH.svg.innerHTML, /class="m-chart-prev-line is-full"/);
    const shortBgTag = /<rect class="m-full-window-bg"[^>]+>/.exec(shortH.svg.innerHTML)[0];
    assert.ok(shortBgTag.includes('display="none"'), `count ${count} <= 100 should not show full-history highlight`);
  }

  // 第 101 点起，全程模式标出最近 100 点。
  const historyPoints = Array.from({ length: 101 }, (_, i) => ({
    step: (i + 1) * 10,
    value: i < 45 ? 0.5 - i * 0.002 : 0.41 + (i - 45) * 0.002,
  }));
  const historyView = makeOverview({
    monitorChartMode: 'full',
    monitorLossSeries: [{ tag: 'loss/average', points: historyPoints }],
    esc: String,
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const history = makeHarness();
  historyView._patchTrainingDiagnostics(history.root, translate, { state: 'RUNNING', detail: true, total_steps: 2000 }, false);
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
    monitorLossSeries: [{ tag: 'loss/average', points: volPts }],
    esc: String,
    _bindDiagnosticInteractions() {},
  });
  const volH = makeHarness();
  volView._patchTrainingDiagnostics(volH.root, translate, { state: 'RUNNING', detail: true, total_steps: 100 }, false);
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

    // 切换 motionContext 或点数回落 < 2 时清除残留 hover 态
    root.dataset.motionContext = 'run-b';
    runPatch();
    assert.equal(wrap.classList.contains('is-hovering'), false);
    assert.equal(svg.querySelector('[data-chart-hover]').getAttribute('display'), 'none');

    view._updateHeroChartHover(wrap, 0.85);
    assert.equal(wrap.classList.contains('is-hovering'), true);
    pts.splice(0, pts.length, { step: 10, value: 0.3 });
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

test('the dashboard expands only when a loaded live diagnostic moves out of insufficient data', () => {
  const metrics = { hidden: true, getBoundingClientRect: () => ({height: 100}), animate() {} };
  let reveals = 0;
  const card = {
    dataset: {}, querySelectorAll: () => [],
    querySelector: selector => selector === '.m-diagnostic-metrics' ? metrics : null,
    getBoundingClientRect: () => ({height: 200}),
    animate() { reveals++; },
  };
  const root = { dataset: {motionContext: 'run-a'}, _metricMotion: true, querySelector: () => card };
  const view = makeOverview({lossDataVersion: 0, _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {}});
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
  assert.equal(metrics.hidden, false);
  assert.equal(reveals, 0, 'restoring a populated snapshot stays still');
  root.dataset.motionContext = 'run-b';
  paint(true, 0);
  assert.equal(card.hidden, false);
  assert.equal(card.dataset.diagnosticState, 'insufficient');
  paint(true, 2);
  assert.equal(reveals, 0, 'the curve is visible while the verdict is still insufficient');
  paint(true, 6);
  paint(true, 7);
  assert.equal(reveals, 1);
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
    monitorLossSeries: [{ tag: 'loss/average', points: pts }],
    esc: String,
    _bindDiagnosticInteractions() {},
    _patchDiagnosticGauges() {},
  });
  const patch = () => view._patchTrainingDiagnostics(root, k => k, { state: 'RUNNING', detail: true, total_steps: 100 }, false);

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

test('live rescaling moves the axis and plotted values together and retargets from the visible range', t => {
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
  const svg = { setAttribute() {} };
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
  const pitch = wrap._chartState.coords[3].x - oldX;
  points.push({step: 6, value: .6});
  lrPoints.push({step: 6, value: .002});
  draw();
  assert.equal(wrap._chartState.range.high, initial);
  advance(80);
  const state = wrap._chartState;
  assert.ok(initial < state.range.high && state.range.high < state.targetRange.high);
  assert.ok(Math.abs(state.splitX - (state.padL + state.plotW / 2)) < 1e-8);
  const point = state.coords[2];
  assert.ok(point.x < oldX && point.x > oldX - pitch);
  assert.ok(state.coords[3].x - point.x < pitch);
  assert.ok(state.coords[3].x - point.x > state.plotW / 6);
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
  assert.ok(Math.abs(wrap._chartState.coords[2].x - (state.padL + 2 * state.plotW / 7)) < 1e-8);
  assert.equal(frames.size, 0);
});

test('the initial trace fills the plot, grows from a stable origin, then scrolls at fixed spacing', () => {
  const svg = {setAttribute() {}};
  const wrap = {dataset: {}, querySelector: s => ({
    '[data-hero-chart-stage]': {clientWidth: 600}, '[data-hero-chart-svg]': svg,
  })[s]};
  const card = {dataset: {}, querySelectorAll: () => [], querySelector: s => s === '[data-hero-chart-wrap]' ? wrap : null};
  const root = {dataset: {}, querySelector: () => card};
  const points = Array.from({length: 6}, (_, i) => ({step: i * 20 + 20, value: .1 + i / 100}));
  const view = makeOverview({lossDataVersion: 0, monitorLossSeries: [{tag: 'loss/average', points}],
    _bindDiagnosticInteractions() {}, _patchDiagnosticGauges() {}});
  const render = () => {
    view.lossDataVersion++;
    view._patchTrainingDiagnostics(root, String, {state:'RUNNING', detail: true, total_steps:2000}, false);
    return wrap._chartState;
  };
  const first = render();
  for (let step = 140; step <= 2460; step += 20) {
    points.push({step, value:.21});
    const state = render();
    assert.equal(state.coords[0].step, Math.max(20, step - 99 * 20));
    assert.equal(state.coords[0].x, first.padL);
    assert.equal(state.coords.at(-1).x, first.padL + first.plotW);
    assert.equal(state.stepSpan, Math.min(step - 20, 99 * 20));
    assert.equal(state.splitX, first.padL + first.plotW / 2);
    if (step === 2020) {
      const diagnostic = view._trainingDiagnostics(points);
      assert.deepEqual([diagnostic.windowSize, diagnostic.previousStartStep, diagnostic.previousEndStep,
        diagnostic.recentStartStep, diagnostic.recentEndStep], [50, 40, 1020, 1040, 2020]);
    }
    if (step <= 200) assert.equal(state.range.low, first.range.low);
  }
  points.push({step: 10000, value:.22});
  const sparse = render();
  const diagnostic = view._trainingDiagnostics(points);
  const cutoff = sparse.minStep + (sparse.splitX - sparse.padL) / sparse.plotW * sparse.stepSpan;
  assert.ok(cutoff >= diagnostic.previousEndStep - 1e-8 && cutoff <= diagnostic.recentStartStep + 1e-8);
});
