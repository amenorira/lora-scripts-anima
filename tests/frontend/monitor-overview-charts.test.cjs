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

test('hero chart downsampling keeps endpoints and extrema while full diagnostic window stays 120 points', () => {
  const longSeries = Array.from({ length: 1200 }, (_, i) => ({
    step: i + 1,
    value: i === 599 ? 0.005 : i === 899 ? 0.95 : 0.1 + Math.sin(i / 20) * 0.02,
  }));
  const view = makeOverview({
    monitorLossSeries: [{ tag: 'loss/average', points: longSeries }],
  });
  const compressed = view._downsampleHeroPoints(longSeries, 160);
  assert.ok(compressed.length <= 180);
  assert.equal(compressed[0].step, 1);
  assert.equal(compressed.at(-1).step, 1200);
  assert.ok(compressed.some(p => p.step === 600 && p.value === 0.005));
  assert.ok(compressed.some(p => p.step === 900 && p.value === 0.95));

  const windowPts = view._trainingDiagnosticPoints(120);
  assert.equal(windowPts.length, 120);
  const diag = view._trainingDiagnostics(windowPts);
  assert.equal(diag.windowSize, 60);
  assert.equal(diag.previousStartStep, 1081);
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
  const patch = () => view._patchTrainingDiagnostics(root, key => key, {state: 'RUNNING'}, false);
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
  view._patchTrainingDiagnostics(root, translate, { state: 'RUNNING', total_steps: 100, epoch: '2/2' }, false);
  assert.ok(svg.innerHTML.includes('ステップ 10'), svg.innerHTML);
  assert.ok(!svg.innerHTML.includes('Step '), svg.innerHTML);
  view._updateHeroChartHover(wrap, 0.5);
  assert.ok(readEl.innerHTML.includes('ステップ <span class="m-hud-index">'), readEl.innerHTML);
  assert.ok(!readEl.innerHTML.includes('Step '), readEl.innerHTML);

  view.monitorChartMode = 'epoch';
  view._patchTrainingDiagnostics(root, translate, { state: 'RUNNING', total_steps: 100, epoch: '2/2' }, false);
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
