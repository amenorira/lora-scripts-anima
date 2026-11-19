const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function runtime() {
  let initialize;
  const factories = {};
  const context = loadFrontend(['shared/anima-select'], {
    document: { addEventListener(name, callback) { if (name === 'alpine:init') initialize = callback; } },
    window: { AnimaUI: { settleDialog() {}, registerPopup() {}, unregisterPopup() {} } },
    Alpine: { data(name, factory) { factories[name] = factory; } },
    console,
  });
  initialize();
  return { context, factories };
}

test('preview select shares selection behavior while retaining its event and typeahead', () => {
  const { factories } = runtime();
  const select = factories.previewSelect([
    { value: 'one', label: 'Alpha', count: 2 },
    { value: 'two', label: 'Beta', family: 'Group' },
  ], 'one');
  const events = [], trigger = { focus() {}, closest: () => true };
  select.$el = { querySelector: () => trigger };
  select.$nextTick = callback => callback();
  select.$dispatch = (name, value) => events.push([name, value]);
  select._syncOptionA11y = () => {};
  const key = value => select.onKeydown({ key: value, target: trigger, preventDefault() {}, stopPropagation() {} });

  assert.equal(select.selected.label, 'Alpha');
  key('b');
  assert.equal(select.open, true);
  assert.equal(select.active, 1);
  key('Enter');
  assert.equal(select.value, 'two');
  assert.equal(select.open, false);
  assert.deepEqual(events, [['preview-select', 'two']]);

  select.options = [{ value: 'three', label: 'Gamma' }];
  assert.equal(select.flatOptions[0].v, 'three');
  assert.equal(select.selected.label, 'Gamma');
  select.choose(0);
  assert.deepEqual(events.at(-1), ['preview-select', 'three']);
});

test('opening a large preview select resolves its options only once', () => {
  const { factories } = runtime();
  const options = Array.from({ length: 1000 }, (_, index) => ({ value: index, label: `Option ${index}` }));
  const select = factories.previewSelect(options, 999);
  let reads = 0;
  Object.defineProperty(select, 'options', { get() { reads++; return options; } });
  select.$el = {};
  select.$nextTick = () => {};

  select.show();
  assert.equal(select.active, 999);
  assert.equal(reads, 1);
});
