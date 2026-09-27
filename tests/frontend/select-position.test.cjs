const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(file, name) {
  let factory;
  const listeners = new Map(), frames = new Map();
  let nextFrame = 0;
  const window = {
    innerWidth: 1200, innerHeight: 900,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file), 'utf8'), {
    window, document: { addEventListener: (_, callback) => callback() },
    Alpine: { data: (key, callback) => { if (key === name) factory = callback; } },
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const parent = {};
  function instance(config = [], value = 'a') {
    const data = factory(config, value), watchers = {};
    const scope = {
      $watch: (key, callback) => { watchers[key] = callback; },
      $nextTick: callback => callback(),
      $el: { querySelector: () => null, addEventListener() {}, removeEventListener() {} },
      $refs: { trigger: { getBoundingClientRect: () => ({ left: 20, top: 100, bottom: 130, width: 200 }) }, menu: { contains: () => false } },
    };
    // Alpine's merged scope writes undeclared properties to the outer data.
    const proxy = new Proxy(data, {
      get: (_, key) => key in data ? data[key] : key in scope ? scope[key] : parent[key],
      set: (_, key, value) => { (key in data ? data : parent)[key] = value; return true; },
    });
    proxy.init();
    return { proxy, scope, setOpen(value) { proxy.open = value; watchers.open(value); } };
  }
  return { instance, listeners, frames, scroll() {
    for (const callback of listeners.get('scroll') || []) callback({ target: {} });
    for (const [id, callback] of frames) { frames.delete(id); callback(); }
  } };
}

test('animaSelect: pointer and keyboard share opening and initialize positioning once', () => {
  const h = harness('anima-select.js', 'animaSelect');
  const instance = h.instance({ options: [{ v: 'a' }, { v: 'b' }, { v: 'c', disabled: true }] }, 'b');
  const select = instance.proxy;
  let positions = 0;
  select.positionMenu = () => { positions++; };
  for (const [key, active] of [[undefined, 1], ['Home', 0], ['End', 1]]) {
    select.open = false;
    select.positioned = true;
    select._lastScrolledActiveIndex = 1;
    const before = positions;
    if (key) select.show(key); else select.toggle();
    assert.equal(select.activeIndex, active);
    instance.setOpen(true); // Deliver Alpine's open watcher.
    assert.equal(select.positioned, false);
    assert.equal(select._lastScrolledActiveIndex, -1);
    assert.equal(positions, before + 1);
  }
});

for (const [file, name] of [['anima-select.js', 'animaSelect'], ['preview-select.js', 'previewSelect']]) {
  test(`${name}: revealing an option scrolls only the menu`, () => {
    const { proxy, scope } = harness(file, name).instance();
    let optionTop = 250;
    const option = {
      getBoundingClientRect: () => ({ top: optionTop, bottom: optionTop + 30 }),
      setAttribute() {}, classList: { toggle() {} },
      scrollIntoView() { assert.fail('must not scroll ancestor panels'); },
    };
    const scroller = {
      scrollTop: 0,
      getBoundingClientRect: () => ({ top: 100, bottom: 200 }),
      querySelector: () => option,
    };
    const trigger = { setAttribute() {} };
    const menu = { setAttribute() {}, querySelector: () => scroller, querySelectorAll: () => [option] };
    scope.$el.querySelector = selector => selector === '.anima-select-trigger' ? trigger : menu;
    scope.$refs.menu = scroller;
    proxy.open = true;
    proxy.activeIndex = 0;
    const reveal = () => name === 'animaSelect' ? proxy._syncOptionA11y() : proxy.reveal();
    reveal();
    assert.equal(scroller.scrollTop, 80);
    optionTop = 60;
    proxy._lastScrolledActiveIndex = -1;
    reveal();
    assert.equal(scroller.scrollTop, 40);
  });
  for (const startUp of [false, true]) {
    test(`${name}: keeps opening side while scrolling, recalculates on reopen (${startUp})`, () => {
      const { proxy, scope } = harness(file, name).instance();
      let top = startUp ? 750 : 100;
      const trigger = { getBoundingClientRect: () => ({ left: 20, right: 220, top, bottom: top + 30, width: 200 }) };
      const menuScroll = { style: {}, scrollTop: 80, querySelector: () => null };
      const menu = {
        style: {}, scrollHeight: 300,
        querySelector: () => menuScroll,
      };
      scope.$el.querySelector = selector => selector === '.anima-select-trigger' ? trigger : menu;
      scope.$refs.trigger = trigger;
      proxy._syncOptionA11y = () => {};
      proxy.reveal = () => {};
      const open = () => {
        if (name === 'previewSelect') proxy.show();
        else { proxy.positioned = false; proxy.open = true; proxy.positionMenu(); }
      };
      const isUp = () => name === 'previewSelect'
        ? proxy.position.includes('transform-origin:left bottom')
        : menu.style.top === 'auto';
      const position = () => name === 'previewSelect' ? proxy.position : `${menu.style.top}/${menu.style.bottom}`;
      const maxHeight = () => name === 'previewSelect'
        ? proxy.position.match(/max-height:([^;]+)/)[1] : menuScroll.style.maxHeight;
      open();
      assert.equal(isUp(), startUp);
      const originalPosition = position();
      const originalHeight = maxHeight();
      top = startUp ? 100 : 750;
      proxy.positionMenu();
      assert.equal(isUp(), startUp);
      assert.notEqual(position(), originalPosition);
      assert.equal(maxHeight(), originalHeight, 'scrolling must not squeeze the menu');
      if (name === 'animaSelect') {
        assert.equal(menuScroll.scrollTop, 80);
        assert.equal(startUp ? menu.style.bottom : menu.style.top,
          `${startUp ? 900 - top + 4 : top + 34}px`, 'anchor must follow the trigger without viewport clamping');
      }
      proxy.open = false;
      open();
      assert.equal(isUp(), !startUp);
      const reopenedHeight = maxHeight();
      for (const nextTop of [-600, 1000, 300]) {
        top = nextTop;
        proxy.positionMenu();
        assert.equal(proxy.open, true, 'scrolling out of and back into view must not close the menu');
        assert.equal(isUp(), !startUp);
        assert.equal(maxHeight(), reopenedHeight);
      }
    });
  }
  test(`${name}: sibling selects keep independent scroll handlers and clean up`, () => {
    const h = harness(file, name);
    const first = h.instance(), second = h.instance();
    let firstMoves = 0, secondMoves = 0;
    first.proxy.positionMenu = () => firstMoves++;
    second.proxy.positionMenu = () => secondMoves++;
    first.setOpen(true);
    const before = firstMoves;
    h.scroll();
    assert.equal(firstMoves, before + 1);
    assert.equal(secondMoves, 0);
    for (const callback of h.listeners.get('scroll')) callback({ target: {} });
    first.setOpen(false);
    h.scroll();
    assert.equal(firstMoves, before + 1, 'queued frame must not position a closed menu');
    second.setOpen(true);
    first.proxy.destroy();
    const secondBefore = secondMoves;
    h.scroll();
    assert.equal(secondMoves, secondBefore + 1);
    second.proxy.destroy();
    assert.equal(h.listeners.get('scroll').size, 0);
    assert.equal(h.frames.size, 0);
  });
}
