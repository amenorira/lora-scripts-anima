const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function fixture() {
  let init, create;
  loadFrontend('shared/preview-select', {
    window: {},
    document: { addEventListener(name, callback) { init = callback; } },
    Alpine: { data(name, factory) { assert.equal(name, 'previewSelect'); create = factory; } },
  });
  init();
  const pending = [];
  const select = create([{ value: 'a', label: 'First' }], 'a');
  select.$nextTick = callback => pending.push(callback);
  select.$refs = {};
  return { select, flush: () => pending.splice(0).forEach(callback => callback()) };
}

test('queued preview selection reveal ignores closed and replaced menus', () => {
  const { select, flush } = fixture();
  select.open = true;
  select.reveal();
  select.open = false;
  flush();

  select.open = true;
  select.reveal();
  flush();

  let queries = 0;
  select.$refs.menu = { isConnected: false, querySelector() { queries += 1; } };
  select.reveal();
  flush();
  assert.equal(queries, 0);
});

test('preview reveal scrolls the active option into the live menu viewport', () => {
  const { select, flush } = fixture();
  select.open = true;
  select.active = 2;
  select.$refs.menu = {
    isConnected: true,
    scrollTop: 0,
    querySelector(selector) {
      assert.equal(selector, '[data-index="2"]');
      return { getBoundingClientRect: () => ({ top: 80, bottom: 110 }) };
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
  };
  select.reveal();
  flush();
  assert.equal(select.$refs.menu.scrollTop, 10);
});
