const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend } = require('./helpers.cjs');

global.document = { hidden: false, getElementById: () => null, querySelector: () => null };
loadGlobalFrontend(['training/lr-preview', 'monitor/metrics', 'monitor/diagnostics', 'monitor/summary']);

function makeOverview(overrides = {}) {
  return Object.assign(
    Object.create(window.monitorSummaryMixin),
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
