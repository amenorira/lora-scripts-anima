const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function setup() {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.classList = { add() {} }; }
    appendChild(child) { this.children.push(child); child.parent = this; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute() {}
    contains(element) { return this === element || this.children.some(child => child.contains(element)); }
    remove() { this.removed = true; }
    dispatch(name, event = {}) { this.listeners[name](event); }
  }
  const container = new Element();
  const context = loadFrontend(['shared/notifications'], {
    window: { AnimaUI: {}, matchMedia: () => ({ matches: true }) },
    document: { createElement: () => new Element(), activeElement: null },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Date: { now: () => now },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const advance = duration => {
    now += duration;
    for (const [id, timer] of timers) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  };
  return { center: context.window.AnimaUI.createNotifications(container, key => key), advance };
}

test('error notifications expire after eight seconds, pausing while hovered or focused', () => {
  const { center, advance } = setup();
  const node = center.show('No source images found', 'error');
  advance(3000);
  node.dispatch('mouseenter');
  advance(10000);
  assert.equal(node.removed, undefined);
  node.dispatch('mouseleave');
  advance(2000);
  node.dispatch('focusin');
  advance(10000);
  assert.equal(node.removed, undefined);
  node.dispatch('focusout', { relatedTarget: null });
  advance(2999);
  assert.equal(node.removed, undefined);
  advance(1);
  assert.equal(node.removed, true);
});

test('explicit persistence and duration remain available', () => {
  const { center, advance } = setup();
  const persistent = center.show('Persistent', 'error', { persistent: true, key: 'persistent' });
  const timed = center.show('Timed', 'error', { duration: 100 });
  advance(100);
  assert.equal(timed.removed, true);
  advance(10000);
  assert.equal(persistent.removed, undefined);
  center.dismiss('persistent');
  assert.equal(persistent.removed, true);
});
