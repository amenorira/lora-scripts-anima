const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

function runtime(rules, values = {}, sources = {}) {
  const microtasks = [];
  const context = loadFrontend(['vendor/alpine.min', ...TRAINING_CORE_SCRIPTS], {
    window: { Element: class {} },
    document: { createElement: () => ({}) },
    MutationObserver: class {}, queueMicrotask() {},
  });
  context.queueMicrotask = callback => microtasks.push(callback);
  const visible = [];
  const calls = { visibilitySchema: 0, readonly: 0 };
  let currentRules = rules;
  let showIfKeys = ['derived', 'combined', 'replacement'];
  const defaults = { derived: 'default', combined: 'default-combined', replacement: 'default-replacement' };
  const app = context.window.Alpine.reactive(Object.assign({}, context.window.trainingCoreMixin, {
    form: { mode: 'off', alternative: 'off', ...defaults, ...values },
    formDefaults: { ...defaults }, _fieldSources: { ...sources },
    _collectAutoValueRules: () => currentRules,
    _allShowIfKeys() { calls.visibilitySchema++; return showIfKeys; },
    _applyInitialAutoValues() {},
    findFieldDef: key => ({ key, default: defaults[key] }),
    _setFieldSource(key, source) { this._fieldSources[key] = source; },
    showConditionalFields(key) { visible.push(key); },
    updateReadonlyStates() { calls.readonly++; },
  }));
  const flush = () => {
    let steps = 0;
    while (microtasks.length) {
      assert.ok(++steps < 100, 'automatic field updates must settle');
      microtasks.shift()();
    }
  };
  return { app, calls, visible, microtasks, flush,
    replaceRules(rules, visibleKeys = showIfKeys) { currentRules = rules; showIfKeys = visibleKeys; } };
}

test('a dependency change checks all target rules in priority order and retains multi-field matching', () => {
  const h = runtime([
    { target: 'derived', watch: 'mode', when: 'on', set: 'first-rule' },
    { target: 'derived', watch: 'alternative', when: 'on', set: 'second-rule' },
    { target: 'combined', watch: { mode: 'on', alternative: 'on' }, set: 'both' },
  ], { mode: 'on' });
  h.app.setupAutoValueWatchers();
  h.app.form.alternative = 'on';
  h.flush();
  assert.equal(h.app.form.derived, 'first-rule', 'another dependency can own the higher-priority matching rule');
  assert.equal(h.app.form.combined, 'both');
  assert.deepEqual(h.visible, ['derived', 'combined']);

  h.app.form.mode = 'off';
  h.flush();
  assert.equal(h.app.form.derived, 'second-rule');
  assert.equal(h.app.form.combined, 'default-combined');
  h.app.form.alternative = 'off';
  h.flush();
  assert.equal(h.app.form.derived, 'default');
  assert.equal(h.app.formDefaults.derived, 'default');
  assert.equal(h.app._fieldSources.derived, 'default');
  assert.equal(h.calls.visibilitySchema, 1, 'field changes reuse the installed visibility dependencies');
  assert.equal(h.calls.readonly, 3);
});

test('setIfDefault rules preserve user values for both automatic updates and default restoration', () => {
  const h = runtime([
    { target: 'derived', watch: 'mode', when: 'on', set: 'automatic', setIfDefault: true },
  ], { derived: 'custom' }, { derived: 'user' });
  h.app.setupAutoValueWatchers();
  h.app.form.mode = 'on';
  h.flush();
  assert.equal(h.app.form.derived, 'custom');
  h.app.form.mode = 'off';
  h.flush();
  assert.equal(h.app.form.derived, 'custom', 'unmatched guarded rules do not reset user edits');

  h.app._fieldSources.derived = 'default';
  h.app.form.mode = 'on';
  h.flush();
  assert.equal(h.app.form.derived, 'automatic');
  assert.equal(h.app._fieldSources.derived, 'auto');
  h.app.form.mode = 'off';
  h.flush();
  assert.equal(h.app.form.derived, 'default');
  assert.equal(h.app._fieldSources.derived, 'default');
});

test('reinstalling listeners replaces rule and visibility indexes and cancels the previous callbacks', () => {
  const h = runtime([{ target: 'derived', watch: 'mode', when: 'on', set: 'obsolete' }]);
  h.app.setupAutoValueWatchers();
  h.app.form.mode = 'on';
  h.microtasks.shift()();
  h.replaceRules([{ target: 'replacement', watch: 'alternative', when: 'on', set: 'current' }], ['replacement']);
  h.app.setupAutoValueWatchers();
  h.flush();
  assert.equal(h.app.form.derived, 'default', 'already queued callbacks from old rules are stopped');
  h.app.form.mode = 'off';
  h.app.form.alternative = 'on';
  h.flush();
  assert.equal(h.app.form.replacement, 'current');
  assert.deepEqual(h.visible, ['replacement']);
  assert.equal(h.calls.visibilitySchema, 2);

  h.replaceRules([]);
  h.app.setupAutoValueWatchers();
  h.app.form.alternative = 'off';
  h.flush();
  assert.equal(h.app.form.replacement, 'current', 'an empty registry removes the previous listeners');
  assert.equal(h.app._autoValueWatchers.length, 0);
});
