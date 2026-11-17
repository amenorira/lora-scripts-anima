const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend} = require('./helpers.cjs');

function fixture({defer = false, visibility = false} = {}) {
  const observers = [], visibilityObservers = [];
  const frames = new Map(); let frameId = 0;
  const created = []; let styleReads = 0;
  const node = () => {
    const classes = new Set(), listeners = new Map(), classWrites = [];
    return {children: [], classWrites, style: {setProperty(key, value) {this[key] = value;}},
      classList: {add(name) {classWrites.push(name); classes.add(name);}, remove(name) {classWrites.push(name); classes.delete(name);},
        toggle(name, value) {if (value) classes.add(name); else classes.delete(name);}, contains: name => classes.has(name)},
      get firstElementChild() {return this.children[0];},
      append(...items) {this.children.push(...items); items.forEach(item => item.parentElement = this);},
      replaceWith(other) {const p = this.parentElement; p.children[p.children.indexOf(this)] = other; other.parentElement = p; this.parentElement = null;},
      addEventListener(type, callback) {listeners.set(type, callback);},
      removeEventListener(type, callback) {if (listeners.get(type) === callback) listeners.delete(type);},
      dispatch(type) {listeners.get(type)?.();}, setAttribute() {},
    };
  };
  class Observer {
    constructor(callback) {this.callback = callback; observers.push(this);}
    observe() {} disconnect() {this.disconnected = true;}
  }
  class VisibilityObserver {
    constructor(callback, options) {this.callback = callback; this.options = options; this.targets = new Set(); visibilityObservers.push(this);}
    observe(element) {this.targets.add(element);}
    unobserve(element) {this.targets.delete(element);}
  }
  const context = loadFrontend(['shared/loop-marquee'], {
    window: {ResizeObserver: Observer, MutationObserver: Observer, IntersectionObserver: visibility ? VisibilityObserver : undefined},
    ResizeObserver: Observer, MutationObserver: Observer, IntersectionObserver: VisibilityObserver,
    document: {createElement() {const element = node(); created.push(element); return element;}, addEventListener() {}},
    getComputedStyle: () => {styleReads++; return {columnGap: '64px'};},
    requestAnimationFrame: defer ? callback => {frames.set(++frameId, callback); return frameId;} : undefined,
    cancelAnimationFrame: id => frames.delete(id),
  });
  const element = node(), source = node(); element.clientWidth = 100; source.scrollWidth = 132; element.append(source);
  return {element, source, observers, visibilityObservers, created, frames, node,
    flush() {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0));},
    get styleReads() {return styleReads;}, init: context.window.initLoopMarquee};
}

test('bounce captions travel only their overflow, without a duplicate, and resize back to static', () => {
  const h = fixture(), {element, source, observers, init} = h;
  const destroy = init(element, source, {bounce: true});
  assert.equal(element.firstElementChild.children.length, 1);
  assert.equal(h.created.length, 1, 'the return trip has no detached copy node');
  assert.equal(h.styleReads, 0, 'return trips do not need a computed column-gap read');
  assert.equal(element.style['--loop-marquee-distance'], '32px');
  assert.equal(element.classList.contains('is-overflowing'), true);
  assert.equal(element.classList.contains('is-marquee-visible'), true, 'the no-IO fallback allows bounce animation');
  element.clientWidth = 120; observers[0].callback();
  assert.equal(element.classList.contains('is-overflowing'), false, 'the 14px end padding alone must not trigger motion');
  destroy();
  assert.equal(element.firstElementChild, source);
  assert.equal(element.classList.contains('is-marquee-visible'), false);
  assert(observers.every(observer => observer.disconnected));
});

test('existing seamless marquee callers retain their duplicated text and full loop distance', () => {
  const {element, source, init, visibilityObservers} = fixture({visibility: true});
  init(element, source);
  assert.equal(visibilityObservers.length, 0, 'seamless callers keep their immediate measurement and observers');
  assert.equal(element.firstElementChild.children.length, 2);
  assert.equal(element.style['--loop-marquee-distance'], '196px');
  assert.equal(element.classList.contains('is-bouncing'), false);
  assert.equal(element.classList.contains('is-marquee-visible'), false);
});

test('many captions measure in one frame before writing styles, and destroyed captions leave no queued work', () => {
  const h = fixture({defer: true}), sequence = [];
  const second = h.node(), text = h.node(); second.clientWidth = 100; second.append(text);
  for (const [source, label] of [[h.source, 'first'], [text, 'second']]) {
    Object.defineProperty(source, 'scrollWidth', {get() {sequence.push('read ' + label); return 132;}});
  }
  for (const element of [h.element, second]) element.style.setProperty = () => sequence.push('write');
  const destroy = h.init(h.element, h.source, {bounce: true}), destroySecond = h.init(second, text, {bounce: true});
  assert.equal(h.frames.size, 1, 'all caption initializations share one animation frame');
  assert.deepEqual(sequence, []);
  const callback = [...h.frames.values()][0]; h.frames.clear(); callback(0);
  assert.deepEqual(sequence.slice(0, 2), ['read first', 'read second']);
  assert(sequence.slice(2).every(item => item === 'write'), 'writes cannot force a layout between caption reads');
  h.observers[0].callback(); h.observers[2].callback();
  destroy(); destroySecond();
  assert.equal(h.frames.size, 0);
});

test('bounce captions share visibility observation and only measure and watch nearby text', () => {
  const h = fixture({defer: true, visibility: true});
  const second = h.node(), text = h.node(); second.clientWidth = 100; second.append(text);
  let reads = 0;
  for (const source of [h.source, text]) Object.defineProperty(source, 'scrollWidth', {get() {reads++; return 132;}});
  const destroy = h.init(h.element, h.source, {bounce: true}), destroySecond = h.init(second, text, {bounce: true});
  assert.equal(h.visibilityObservers.length, 1);
  const visibility = h.visibilityObservers[0];
  assert.equal(visibility.targets.size, 2);
  assert.equal(h.observers.length, 0, 'offscreen captions do not create size or mutation observers');
  assert.equal(h.frames.size, 0);
  assert.equal(reads, 0);
  assert.equal(h.element.classList.contains('is-marquee-visible'), false);

  visibility.callback([{target: h.element, isIntersecting: true}, {target: second, isIntersecting: true}]);
  assert.equal(h.element.classList.contains('is-marquee-visible'), true);
  visibility.callback([{target: h.element, isIntersecting: true}]);
  assert.equal(h.element.classWrites.filter(name => name === 'is-marquee-visible').length, 1, 'unchanged visibility must not write the class again');
  assert.equal(h.observers.length, 4);
  assert.equal(h.frames.size, 1, 'visible captions still share one read/write batch');
  h.flush();
  assert.equal(reads, 2);
  visibility.callback([{target: h.element, isIntersecting: false}]);
  visibility.callback([{target: h.element, isIntersecting: false}]);
  assert.equal(h.element.classList.contains('is-marquee-visible'), false);
  assert.equal(h.element.classWrites.filter(name => name === 'is-marquee-visible').length, 2);
  assert(h.observers.slice(0, 2).every(observer => observer.disconnected));
  assert(h.observers.slice(2).every(observer => !observer.disconnected));
  h.observers[0].callback(); h.observers[1].callback();
  assert.equal(h.frames.size, 0, 'late callbacks cannot resume a caption that left the viewport');
  assert.equal(h.element.style['--loop-marquee-distance'], '32px', 'leaving preserves the existing caption structure and styles');

  visibility.callback([{target: h.element, isIntersecting: true}]);
  assert.equal(h.element.classList.contains('is-marquee-visible'), true);
  assert.equal(h.observers.length, 6, 'returning resumes observation and remeasures');
  assert.equal(h.frames.size, 1);
  destroy(); destroySecond();
  assert.equal(h.element.classList.contains('is-marquee-visible'), false);
  assert.equal(second.classList.contains('is-marquee-visible'), false);
  assert.equal(visibility.targets.size, 0);
  assert.equal(h.frames.size, 0);
  assert(h.observers.every(observer => observer.disconnected));
  visibility.callback([{target: h.element, isIntersecting: true}]);
  h.element.dispatch('mouseenter'); h.element.dispatch('focusin');
  assert.equal(h.observers.length, 6);
  assert.equal(h.frames.size, 0, 'destroyed captions cannot be reactivated by late visibility entries or events');
});

test('hover and focus resume bounce animation and observation before visibility delivery', () => {
  const h = fixture({defer: true, visibility: true});
  const destroy = h.init(h.element, h.source, {bounce: true});
  h.element.dispatch('mouseenter'); h.flush();
  assert.equal(h.element.style['--loop-marquee-distance'], '32px');
  assert.equal(h.element.classList.contains('is-marquee-visible'), true);
  h.source.scrollWidth = 180;
  h.element.dispatch('focusin'); h.flush();
  assert.equal(h.element.style['--loop-marquee-distance'], '80px');
  assert.equal(h.observers.length, 2);
  assert.equal(h.element.classWrites.filter(name => name === 'is-marquee-visible').length, 1);
  assert.equal(h.visibilityObservers[0].targets.size, 1);
  h.visibilityObservers[0].callback([{target: h.element, isIntersecting: false}]);
  h.element.dispatch('focusin'); h.flush();
  assert.equal(h.element.classList.contains('is-marquee-visible'), true);
  assert.equal(h.observers.length, 4, 'focus resumes observers after a caption was paused offscreen');
  destroy();
  assert.equal(h.element.classList.contains('is-marquee-visible'), false);
});
