const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function row(attributes, hidden = false) {
  return { getAttribute: key => attributes[key] ?? null,
    classList: { contains: key => key === 'field-hidden' && hidden } };
}

function fixture(rows) {
  const context = { window: {}, document: {
    getElementById: id => id === 'trainFormContent' ? { querySelectorAll: () => rows } : null,
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/training-core.js'), 'utf8'), context);
  const initialized = new Map(), updated = new Map();
  const app = Object.assign({}, context.window.trainingCoreMixin, {
    form: {}, _setConditionalState: (row, match) => initialized.set(row, match),
    _toggleFieldRow: (row, match) => updated.set(row, match), updateToml() {},
  });
  return { app, initialized, updated };
}

test('single, AND and OR conditions agree on initialization and reactive updates', () => {
  const rows = [
    row({ 'data-show-if-key': 'module', 'data-show-if-eq': 'lora', 'data-show-if-or': 'loha,lokr' }),
    row({ 'data-show-if-key': 'module', 'data-show-if-neq': 'lora' }),
    row({ 'data-show-if-all': JSON.stringify([{ key: 'module', eq: 'lora' }, { key: 'enabled', eq: true }]) }),
    row({ 'data-show-if-any': JSON.stringify([[{ key: 'module', eq: 'lokr' }], [{ key: 'enabled', eq: true }]]) }),
  ];
  const f = fixture(rows);
  for (const value of ['lora', 'loha', 'lokr', '', null, undefined, 'other']) {
    for (const enabled of [false, true]) {
      f.app.form = { module: value, enabled };
      f.app._syncAllConditionalFields();
      f.app.showConditionalFields('module');
      assert.deepEqual([...f.initialized.values()], [
        ['lora', 'loha', 'lokr'].includes(value),
        !['lora', '', null, undefined].includes(value),
        value === 'lora' && enabled,
        value === 'lokr' || enabled,
      ]);
      assert.deepEqual([...f.updated.values()], [...f.initialized.values()]);
      f.updated.clear();
      f.app.showConditionalFields('unrelated');
      assert.equal(f.updated.size, 0);
    }
  }
});

test('malformed conditions retain initial visibility and are skipped on changes', () => {
  const rows = [row({ 'data-show-if-all': '{' }), row({ 'data-show-if-any': '{}' }, true)];
  const f = fixture(rows);
  f.app._syncAllConditionalFields();
  assert.deepEqual([...f.initialized.values()], [true, false]);
  f.app.showConditionalFields('module');
  assert.equal(f.updated.size, 0);
});
