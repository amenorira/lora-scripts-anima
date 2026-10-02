const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeForm() {
  const context = { window: { TRAIN_GROUP_MAP: { 'anima-lora': 'anima' } } };
  for (const file of ['config.js', 'training-core.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file), 'utf8'), context);
  }
  const fields = context.window.getVisibleSections('anima-lora').flatMap(s => s.fields || []);
  const selected = fields.filter(f => ['learning_rate', 'lr_scheduler'].includes(f.key));
  const noop = () => {};
  return Object.assign({}, context.window.trainingCoreMixin, {
    form: { model_train_type: 'anima-lora', optimizer_type: 'AdamW8bit', learning_rate: '1e-4', lr_scheduler: 'cosine_with_restarts' },
    formDefaults: Object.fromEntries(selected.map(f => [f.key, f.default])),
    formErrors: {}, _fieldSources: { learning_rate: 'default', lr_scheduler: 'default' },
    _profileFieldSources: {}, persistCalls: 0,
    _autoValueRules: selected.flatMap(f => (f.autoValue || []).map(rule => ({ target: f.key, ...rule }))),
    findFieldDef: key => fields.find(f => f.key === key),
    _currentProfileFieldDefault: key => fields.find(f => f.key === key).default,
    _allShowIfKeys: () => [], t: (_key, fallback) => fallback || '',
    queueTomlPreviewChange: noop, pushHistory: noop, updateTomlDebounced: noop,
    updateToml: noop, scheduleOutputPathInfo: noop,
    _persistProfileFieldSources() { this.persistCalls += 1; },
  });
}

test('timescale is an editable numeric default and restores empty legacy drafts', () => {
  const app = makeForm();
  for (const profile of ['anima-lora', 'sdxl-lora', 'krea2-lora']) {
    const defaults = app._buildFormDefaults(profile);
    assert.equal(defaults.lr_scheduler_timescale, 10000);
    for (const value of ['', null, undefined, '   ', 500]) {
      const form = app._profileFormFromDraft(profile, defaults, { lr_scheduler_timescale: value });
      assert.equal(form.lr_scheduler_timescale, value === 500 ? 500 : 10000);
    }
  }
});

test('timescale follows warmup defaults and preserves manual overrides until reset', () => {
  const app = makeForm();
  app.form.lr_scheduler_timescale = '';
  app.form.lr_warmup_steps = 100;
  app._syncLrTimescaleDefault();
  assert.equal(app.form.lr_scheduler_timescale, 100);
  app.form.lr_warmup_steps = 0.1;
  app._syncLrTimescaleDefault();
  assert.equal(app.form.lr_scheduler_timescale, 1000);
  app.stepEstimate = { total_steps: 2000, gpu_processes: 2 };
  app._syncLrTimescaleDefault();
  assert.equal(app.form.lr_scheduler_timescale, 400);
  app.setField('lr_scheduler_timescale', 500);
  app.form.lr_warmup_steps = 0;
  app._syncLrTimescaleDefault();
  assert.equal(app.form.lr_scheduler_timescale, 500);
  app.resetField('lr_scheduler_timescale');
  assert.equal(app.form.lr_scheduler_timescale, 10000);
  app.form.lr_warmup_steps = 200;
  app._syncLrTimescaleDefault();
  assert.equal(app.form.lr_scheduler_timescale, 200);
  app.setField('lr_scheduler_timescale', '');
  app._syncLrTimescaleDefault(true);
  assert.equal(app.form.lr_scheduler_timescale, '');
  app._syncLrTimescaleDefault(false);
  assert.equal(app.form.lr_scheduler_timescale, 200);
});

test('timescale source migration preserves saved numbers and repairs blank drafts', () => {
  const app = makeForm();
  const defaults = app._buildFormDefaults('anima-lora');
  app._setIfDefaultTargets = () => [];
  app._activateProfileFieldSources('anima-lora', defaults, { lr_scheduler_timescale: 700 }, true);
  assert.equal(app._fieldSources.lr_scheduler_timescale, 'saved');
  app._activateProfileFieldSources('anima-lora', defaults, { lr_scheduler_timescale: '' }, true);
  assert.equal(app._fieldSources.lr_scheduler_timescale, 'default');
});

test('derived timescale refreshes open curve and exported config after step estimate changes', () => {
  const app = makeForm();
  app.lrPreviewOpen = true;
  app.form.lr_warmup_steps = 0.1;
  app.form.lr_scheduler_timescale = 1000;
  app._fieldSources.lr_scheduler_timescale = 'default';
  app.stepEstimate = { total_steps: 2000 };
  const curves = [];
  const exports = [];
  app.refreshLrPreview = () => curves.push(app.form.lr_scheduler_timescale);
  app.updateTomlDebounced = () => exports.push(app.form.lr_scheduler_timescale);
  app._syncLrTimescaleDefault();
  assert.deepEqual(curves, [200]);
  assert.deepEqual(exports, [200]);
  app._syncLrTimescaleDefault();
  assert.equal(curves.length, 1);
  assert.equal(exports.length, 1);
});

test('optimizer transitions preserve user values, including an unchanged input, until reset', () => {
  const app = makeForm();
  for (const [optimizer, rate] of [['AdamW8bit', '2e-5'], ['pytorch_optimizer.CAME', '1.5e-5'], ['Lion', '5e-6']]) {
    app.form.optimizer_type = optimizer;
    app._applyInitialAutoValues();
    assert.equal(app.form.learning_rate, rate);
    assert.equal(app.form.lr_scheduler, 'constant');
  }
  app.setField('learning_rate', '2e-5');
  app.setField('lr_scheduler', 'cosine_with_restarts');
  app.form.optimizer_type = 'AdamW8bit';
  app._applyInitialAutoValues();
  assert.equal(app.form.learning_rate, '2e-5');
  assert.equal(app.form.lr_scheduler, 'cosine_with_restarts');
  assert.equal(app._fieldSources.learning_rate, 'user');
  assert.equal(app._fieldSources.lr_scheduler, 'user');
  app.resetField('learning_rate');
  assert.equal(app.form.learning_rate, '2e-5');
  assert.equal(app._fieldSources.learning_rate, 'auto');
  const before = app.persistCalls;
  app.setField('learning_rate', '2e-5');
  assert.equal(app._fieldSources.learning_rate, 'user');
  assert.equal(app.persistCalls, before + 1);
  app.resetField('learning_rate');
  assert.equal(app._fieldSources.learning_rate, 'auto');
  assert.equal(app.persistCalls, before + 3);
});

test('zero workers disable persistence while explicit disabled presets stay disabled', () => {
  const app = makeForm();
  app.form.persistent_data_loader_workers = true;
  app.setField('max_data_loader_n_workers', 0);
  assert.equal(app.form.persistent_data_loader_workers, false);
  app.setField('persistent_data_loader_workers', true);
  assert.equal(app.form.persistent_data_loader_workers, false);
  app.setField('max_data_loader_n_workers', 2);
  assert.equal(app.form.persistent_data_loader_workers, false);
  app.setField('persistent_data_loader_workers', true);
  assert.equal(app.form.persistent_data_loader_workers, true);
  app.form.max_data_loader_n_workers = '';
  app.form.persistent_data_loader_workers = false;
  app._applyInitialAutoValues();
  assert.equal(app.form.persistent_data_loader_workers, false);
  app.form.max_data_loader_n_workers = '0';
  app.form.persistent_data_loader_workers = true;
  app._applyInitialAutoValues();
  assert.equal(app.form.persistent_data_loader_workers, false);
});

test('initial scheduler recommendations immediately hide unrelated child fields', () => {
  const app = makeForm();
  const updates = [];
  app._allShowIfKeys = () => ['lr_scheduler'];
  app.showConditionalFields = key => updates.push([key, app.form.lr_scheduler]);
  app._applyInitialAutoValues();
  assert.equal(app.form.lr_scheduler, 'constant');
  assert.deepEqual(updates, [['lr_scheduler', 'constant']]);
});
