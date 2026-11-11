const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins } = require('./helpers.cjs');

function controls(settings = {}) {
  const { window } = loadFrontend('regularization/index', { window: {} });
  const renders = [], changes = [];
  const app = composeMixins(window.regularizationMixin, {
    regSettings: { model_type: 'anima', sampler: 'euler_a', scheduler: 'simple', blocks_to_swap: 4, ...settings },
    regDefaults: { model_type: 'anima', sampler: 'euler_a', scheduler: 'simple' },
    _regLoaded: true, _regUndo: {}, _regFields: {},
    regChanged(key) { changes.push(key); },
    regRenderControls(force) { renders.push(force); },
  });
  return { app, renders, changes };
}

test('sampler edits preserve controls when their option sets do not change', () => {
  const { app, renders, changes } = controls();
  for (const sampler of ['heun', 'dpmpp_2m', 'euler_a']) app.regSetField('sampler', sampler);
  assert.deepEqual(renders, []);
  assert.deepEqual(changes, ['sampler', 'sampler', 'sampler']);
  assert.equal(app.regSettings.scheduler, 'simple');

  app.regSettings.model_type = 'sdxl';
  app.regSettings.sampler = 'heun';
  app.regSettings.scheduler = 'karras';
  app.regSetField('sampler', 'dpmpp_2m');
  assert.deepEqual(renders, []);
  assert.equal(app.regSettings.scheduler, 'karras');
  assert.equal(app.regSettings.blocks_to_swap, 0);
});

test('SDXL sampler option changes rebuild controls and preserve scheduler normalization', () => {
  const { app, renders } = controls({ model_type: 'sdxl', sampler: 'heun', scheduler: 'karras' });
  app.regSetField('sampler', 'euler_a');
  assert.equal(app.regSettings.scheduler, 'normal');
  assert.deepEqual(renders, [true]);
  app.regSetField('sampler', 'euler');
  assert.deepEqual(renders, [true, true]);
  app.regSetField('sampler', 'heun');
  assert.deepEqual(renders, [true, true]);
  // A disallowed sampler normalizes to Euler ancestral before comparing options.
  app.regSetField('sampler', 'er_sde');
  assert.equal(app.regSettings.sampler, 'euler_a');
  assert.equal(app.regSettings.scheduler, 'normal');
  assert.deepEqual(renders, [true, true, true]);
});

test('model changes, sampler undo and reset keep required rebuilds', () => {
  const { app, renders } = controls({ sampler: 'er_sde' });
  app.regSetField('model_type', 'sdxl');
  assert.equal(app.regSettings.sampler, 'euler_a');
  assert.equal(app.regSettings.scheduler, 'normal');
  assert.deepEqual(renders, [true]);
  const scope = app.regFormControls();
  scope.setField('sampler', 'heun');
  scope.undoField('sampler');
  assert.equal(app.regSettings.sampler, 'euler_a');
  scope.setField('sampler', 'dpmpp_2m');
  scope.resetField('sampler');
  assert.equal(app.regSettings.sampler, 'euler_a');
  assert.deepEqual(renders, [true, true, true, true, true]);
  scope.setField('model_type', 'anima');
  assert.deepEqual(renders, [true, true, true, true, true, true]);
});
