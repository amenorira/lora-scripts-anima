const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins} = require('./helpers.cjs');

function navigation({reduced = false, scrollHeight = 12700} = {}) {
  let now = 0, frameId = 0, position = 0;
  const frames = new Map(), listeners = new Map();
  const scroller = {
    scrollHeight, clientHeight: 700,
    get scrollTop() { return position; },
    set scrollTop(value) { position = Math.max(0, Math.min(scrollHeight - this.clientHeight, value)); },
    getBoundingClientRect: () => ({top: 40}),
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  const cards = ['model', 'network', 'preview'].map((key, index) => ({
    key, offset: [0, 1000, 10000][index],
    getBoundingClientRect() { return {top: 56 + this.offset - scroller.scrollTop}; },
    getAttribute() { return this.key; },
  }));
  const {window} = loadFrontend(['training/sections'], {
    window: {matchMedia: () => ({matches: reduced})},
    document: {
      querySelector: selector => selector === '.main-content' ? scroller
        : cards.find(card => selector.includes(`data-section="${card.key}"`)),
      querySelectorAll: () => cards,
    },
    performance: {now: () => now},
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  const app = composeMixins(window.trainingSections, {
    _sectionCollapsed: {}, activeSection: 'model', escapeAttr: value => value,
  });
  const step = elapsed => {
    now += elapsed;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(now));
  };
  const input = type => [...(listeners.get(type) || [])].forEach(callback => callback());
  const listenerCount = () => [...listeners.values()].reduce((count, set) => count + set.size, 0);
  return {app, scroller, cards, frames, step, input, listenerCount};
}

test('near and far section jumps finish promptly, land exactly and clean up', () => {
  for (const [key, top, duration] of [['network', 1000, 175], ['preview', 10000, 260]]) {
    const {app, scroller, frames, step, listenerCount} = navigation();
    app.scrollToSection(key);
    assert.equal(scroller.scrollTop, 0);
    assert.equal(app.activeSection, 'model');
    step(duration / 2);
    assert.equal(scroller.scrollTop, top * 0.75);
    app._updateActiveSection();
    assert.equal(app.activeSection, key === 'network' ? 'model' : 'network');
    step(duration / 2);
    assert.equal(scroller.scrollTop, top);
    app._updateActiveSection();
    assert.equal(app.activeSection, key);
    assert.equal(frames.size, 0);
    assert.equal(listenerCount(), 0);
  }
});

test('rapid navigation replaces the old destination, including a no-op jump', () => {
  const {app, scroller, cards, frames, step, listenerCount} = navigation();
  app.scrollToSection('preview');
  step(80);
  app.scrollToSection('network');
  assert.equal(frames.size, 1);
  step(260);
  assert.equal(scroller.scrollTop, 1000);
  app.scrollToSection('preview');
  step(40);
  cards[1].offset = scroller.scrollTop;
  app.scrollToSection('network');
  const stoppedAt = scroller.scrollTop;
  step(300);
  assert.equal(scroller.scrollTop, stoppedAt);
  assert.equal(frames.size, 0);
  assert.equal(listenerCount(), 0);
  assert.equal(app.activeSection, 'network');
});

test('manual interaction and leaving the training route cancel a jump', () => {
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'route']) {
    const {app, scroller, step, input, frames, listenerCount} = navigation();
    app.scrollToSection('preview');
    step(64);
    if (type === 'route') app.stopSectionScroll();
    else input(type);
    scroller.scrollTop += 80;
    const stoppedAt = scroller.scrollTop;
    step(300);
    assert.equal(scroller.scrollTop, stoppedAt, type);
    assert.equal(frames.size, 0, type);
    assert.equal(listenerCount(), 0, type);
  }
});

test('reduced motion jumps immediately and short final sections stay within the scroll range', () => {
  const {app, scroller, frames, listenerCount} = navigation({reduced: true, scrollHeight: 10500});
  app.scrollToSection('preview');
  assert.equal(scroller.scrollTop, 9800);
  assert.equal(app.activeSection, 'preview');
  assert.equal(frames.size, 0);
  assert.equal(listenerCount(), 0);
  app.activeSection = 'network';
  app._updateActiveSection();
  assert.equal(app.activeSection, 'preview');
});
