const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

test('details and keyboard row toggles synchronize both controls and exclude collapsed content from focus', () => {
  const { window } = loadFrontend('environment-render', { window: {} });
  const saved = [], animations = [];
  const app = Object.assign({}, window.environmentRenderMixin, {
    _envSetCardOpen: (key, open) => saved.push([key, open]),
    _animateCollapse: (body, collapsing) => animations.push([body.inert, collapsing]),
  });
  const control = dataset => ({
    dataset, attrs: { 'aria-expanded': 'false' }, handlers: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(event, handler) { this.handlers[event] = handler; },
  });
  const head = control({ envToggle: 'xf' });
  const detail = control({ envDetail: 'xf' });
  const body = { inert: true };
  let expanded = false;
  const row = {
    dataset: { envRow: 'xf' },
    classList: { contains: () => expanded, toggle: (_, open) => { expanded = open; } },
    querySelector: () => body,
    querySelectorAll: () => [head, detail],
  };
  head.parentElement = row;
  const host = {
    querySelector: () => row,
    querySelectorAll: selector => selector === '[data-env-toggle]' ? [head] : [detail],
  };
  app._bindRowToggle(host);
  app._bindDetailToggles(host);
  detail.handlers.click();
  assert.equal(expanded, true);
  assert.equal(body.inert, false);
  assert.equal(head.attrs['aria-expanded'], 'true');
  assert.equal(detail.attrs['aria-expanded'], 'true');
  // A nested action button must not toggle its containing row.
  head.handlers.click({ target: { closest: () => ({}) } });
  assert.equal(saved.length, 1);
  head.handlers.keydown({ target: head, key: 'Enter', preventDefault() {} });
  assert.equal(expanded, false);
  assert.equal(body.inert, true);
  assert.equal(head.attrs['aria-expanded'], 'false');
  assert.equal(detail.attrs['aria-expanded'], 'false');
  assert.deepEqual(saved, [['xf', true], ['xf', false]]);
  assert.deepEqual(animations, [[false, false], [true, true]]);
  assert.match(app._renderRow('xf', 'ok', false, '', '<button>Install</button>'), /data-env-body="xf" inert/);
  assert.doesNotMatch(app._renderRow('xf', 'ok', true, '', '<button>Install</button>'), / inert/);
});
