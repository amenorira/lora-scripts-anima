const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend } = require('./helpers.cjs');

loadGlobalFrontend(['monitor/diagnostics']);

test('diagnostic metrics appear at six valid Loss points and hide again for a new empty run', () => {
  const card = { dataset: {} };
  const metrics = { hidden: true };
  const root = {
    dataset: {},
    querySelector(selector) {
      if (selector === '.m-training-diagnostics') return card;
      if (selector === '.m-diagnostic-metrics') return metrics;
      return null;
    },
  };
  const app = Object.assign(Object.create(window.monitorDiagnosticsMixin), {
    monitorLossSeries: [], lossDataVersion: 0,
    _summaryStatus: () => ({ terminal: false }),
  });
  const t = (key, fallback) => fallback || key;
  const update = points => {
    app.monitorLossSeries = [{ tag: 'loss/average', points }];
    app.lossDataVersion++;
    app._patchTrainingDiagnostics(root, t, {}, false);
  };
  const points = Array.from({ length: 6 }, (_, step) => ({ step, value: 1 - step / 10 }));

  update([]);
  assert.equal(metrics.hidden, true);
  assert.equal(card.dataset.diagnosticState, 'insufficient');
  update(points.slice(0, 5));
  assert.equal(metrics.hidden, true);
  update(points);
  assert.equal(metrics.hidden, false);
  assert.notEqual(card.dataset.diagnosticState, 'insufficient');
  update([]);
  assert.equal(metrics.hidden, true);
});
