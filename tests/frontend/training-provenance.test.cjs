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
