const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, readRepo} = require('./helpers.cjs');

function fixture({defer = false, visibility = false, alpine = null} = {}) {
  const observers = [], visibilityObservers = [];
  const frames = new Map(); let frameId = 0;
  const created = []; let styleReads = 0;
  const docListeners = new Map();
  const node = (...initialClasses) => {
    const classes = new Set(initialClasses), listeners = new Map(), classWrites = [];
    return {children: [], classWrites, listeners, hovered: false, style: {setProperty(key, value) {this[key] = value;}},
      classList: {add(name) {classWrites.push(name); classes.add(name);}, remove(name) {classWrites.push(name); classes.delete(name);},
        toggle(name, value) {if (value) classes.add(name); else classes.delete(name);}, contains: name => classes.has(name)},
      get firstElementChild() {return this.children[0];},
      append(...items) {this.children.push(...items); items.forEach(item => item.parentElement = this);},
      replaceWith(other) {const p = this.parentElement; p.children[p.children.indexOf(this)] = other; other.parentElement = p; this.parentElement = null;},
      contains(other) {
        let cur = other;
        while (cur) {
          if (cur === this) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      matches(selector) {
        return selector.split(',').map(part => part.trim()).some(part => {
          if (part === ':hover') return !!this.hovered;
          if (part.startsWith('.')) return classes.has(part.slice(1));
          return false;
        });
      },
      closest(selector) {
        let cur = this;
        while (cur) {
          if (cur.matches?.(selector)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(selector) {
        for (const child of this.children) {
          if (child.matches?.(selector)) return child;
          const found = child.querySelector?.(selector);
          if (found) return found;
        }
        return null;
      },
      addEventListener(type, callback) {listeners.set(type, callback);},
      removeEventListener(type, callback) {if (listeners.get(type) === callback) listeners.delete(type);},
      dispatch(type, event) {listeners.get(type)?.(event);}, setAttribute() {},
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
  const document = {
    activeElement: null,
    createElement() {const element = node(); created.push(element); return element;},
    addEventListener(type, callback) {docListeners.set(type, callback);},
    dispatch(type, event) {docListeners.get(type)?.(event);},
  };
  const windowObj = {
    ResizeObserver: Observer, MutationObserver: Observer,
    IntersectionObserver: visibility ? VisibilityObserver : undefined,
    ...(alpine ? {Alpine: alpine} : {}),
  };
  const context = loadFrontend(['shared/loop-marquee'], {
    window: windowObj,
    ...(alpine ? {Alpine: alpine} : {}),
    ResizeObserver: Observer, MutationObserver: Observer, IntersectionObserver: VisibilityObserver,
    document,
    getComputedStyle: () => {styleReads++; return {columnGap: '64px'};},
    requestAnimationFrame: defer ? callback => {frames.set(++frameId, callback); return frameId;} : undefined,
    cancelAnimationFrame: id => frames.delete(id),
  });
  const element = node(), source = node(); element.clientWidth = 100; source.scrollWidth = 132; element.append(source);
  return {element, source, observers, visibilityObservers, created, frames, node, document, context,
    flush() {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0));},
    get styleReads() {return styleReads;}, init: context.window.initLoopMarquee, bind: context.window.bindDelegatedBounceMarquee};
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
  element.clientWidth = 130; observers[0].callback();
  assert.equal(element.classList.contains('is-overflowing'), true, 'overflow beyond 1px tolerance triggers bounce motion');
  assert.equal(element.style['--loop-marquee-distance'], '2px');
  element.clientWidth = 131; observers[0].callback();
  assert.equal(element.classList.contains('is-overflowing'), false, '1px subpixel rounding must not trigger bounce motion');
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

function makeDelegatedRow(h, {clientWidth = 100, scrollWidth = 140} = {}) {
  const host = h.node('card-host');
  const label = h.node('card-label');
  const text = h.node();
  const child = h.node('card-thumb');
  label.clientWidth = clientWidth;
  label.scrollWidth = scrollWidth;
  text.scrollWidth = scrollWidth;
  label.append(text);
  host.append(child, label);
  return {host, label, text, child};
}

test('bindDelegatedBounceMarquee guards invalid inputs safely', () => {
  const h = fixture();
  for (const args of [
    [null, {hostSelector: '.card-host', targetSelector: '.card-label'}],
    [{}, {hostSelector: '.card-host', targetSelector: '.card-label'}],
    [h.node(), null],
    [h.node(), {hostSelector: '', targetSelector: '.card-label'}],
    [h.node(), {hostSelector: '.card-host', targetSelector: ''}],
  ]) {
    const binding = h.bind(...args);
    assert.equal(typeof binding.clear, 'function');
    assert.equal(typeof binding.destroy, 'function');
    assert.doesNotThrow(() => {binding.clear(); binding.destroy();});
  }
});

test('bindDelegatedBounceMarquee activates on overflow, preserves hover/focus handoff, switches hosts, and cleans up', () => {
  const h = fixture();
  const container = h.node('list');
  const shortRow = makeDelegatedRow(h, {clientWidth: 100, scrollWidth: 101});
  const zeroRow = makeDelegatedRow(h, {clientWidth: 0, scrollWidth: 140});
  const first = makeDelegatedRow(h, {clientWidth: 100, scrollWidth: 148});
  const second = makeDelegatedRow(h, {clientWidth: 100, scrollWidth: 164});
  const outside = makeDelegatedRow(h, {clientWidth: 100, scrollWidth: 160});
  container.append(shortRow.host, zeroRow.host, first.host, second.host);

  const binding = h.bind(container, {hostSelector: '.card-host', targetSelector: '.card-label'});
  assert.equal(container.listeners.size, 4);

  // Non-overflowing (within 1px tolerance), hidden (clientWidth === 0), and outside hosts are skipped.
  container.dispatch('pointerover', {target: shortRow.child});
  assert.equal(shortRow.label.classList.contains('loop-marquee'), false);
  assert.equal(h.created.length, 0);
  container.dispatch('pointerover', {target: zeroRow.child});
  assert.equal(zeroRow.label.classList.contains('loop-marquee'), false);
  container.dispatch('pointerover', {target: outside.child});
  assert.equal(outside.label.classList.contains('loop-marquee'), false);
  assert.equal(h.created.length, 0);

  // Overflowing host activates on pointerover and ignores redundant events within the same host.
  container.dispatch('pointerover', {target: first.child});
  assert.equal(first.label.classList.contains('loop-marquee'), true);
  assert.equal(first.label.classList.contains('is-bouncing'), true);
  assert.equal(first.label.classList.contains('is-overflowing'), true);
  assert.equal(first.text.classList.contains('loop-marquee-text'), true);
  assert.equal(h.created.length, 1);

  container.dispatch('pointerover', {target: first.label});
  container.dispatch('focusin', {target: first.child});
  assert.equal(h.created.length, 1, 're-entering the active host must be a no-op');

  // Moving within the same host keeps marquee active.
  container.dispatch('pointerout', {target: first.child, relatedTarget: first.label});
  assert.equal(first.label.classList.contains('loop-marquee'), true);

  // Leaving via pointerout while focus stays inside host keeps marquee active.
  h.document.activeElement = first.child;
  container.dispatch('pointerout', {target: first.label, relatedTarget: container});
  assert.equal(first.label.classList.contains('loop-marquee'), true);

  // Leaving via focusout while host is hovered keeps marquee active.
  first.host.hovered = true;
  h.document.activeElement = null;
  container.dispatch('focusout', {target: first.child, relatedTarget: container});
  assert.equal(first.label.classList.contains('loop-marquee'), true);

  // Once neither hovered nor focused, focusout cleans up classes and DOM wrapper.
  first.host.hovered = false;
  container.dispatch('focusout', {target: first.child, relatedTarget: container});
  assert.equal(first.label.classList.contains('loop-marquee'), false);
  assert.equal(first.label.classList.contains('is-bouncing'), false);
  assert.equal(first.label.classList.contains('is-overflowing'), false);
  assert.equal(first.text.classList.contains('loop-marquee-text'), false);
  assert.equal(first.label.firstElementChild, first.text);

  // Activating via focusin and switching directly to another host cleans up the first.
  container.dispatch('focusin', {target: first.host});
  assert.equal(first.label.classList.contains('loop-marquee'), true);
  container.dispatch('pointerover', {target: second.child});
  assert.equal(first.label.classList.contains('loop-marquee'), false);
  assert.equal(first.text.classList.contains('loop-marquee-text'), false);
  assert.equal(first.label.firstElementChild, first.text);
  assert.equal(second.label.classList.contains('loop-marquee'), true);
  assert.equal(second.label.style['--loop-marquee-distance'], '64px');

  // clear() cleans up active state while keeping listeners bound.
  binding.clear();
  assert.equal(second.label.classList.contains('loop-marquee'), false);
  assert.equal(second.text.classList.contains('loop-marquee-text'), false);
  assert.equal(container.listeners.size, 4);

  // destroy() cleans up active state and removes all 4 listeners.
  container.dispatch('pointerover', {target: second.child});
  assert.equal(second.label.classList.contains('loop-marquee'), true);
  binding.destroy();
  assert.equal(second.label.classList.contains('loop-marquee'), false);
  assert.equal(second.text.classList.contains('loop-marquee-text'), false);
  assert.equal(container.listeners.size, 0);
  container.dispatch('pointerover', {target: first.child});
  assert.equal(first.label.classList.contains('loop-marquee'), false);
});

test('bindDelegatedBounceMarquee avoids redundant scrollWidth reads inside a non-overflowing host until pointerout', () => {
  const h = fixture();
  const container = h.node('list');
  const row = makeDelegatedRow(h, {clientWidth: 100, scrollWidth: 80});
  const other = makeDelegatedRow(h, {clientWidth: 100, scrollWidth: 80});
  container.append(row.host, other.host);

  let scrollWidthReads = 0;
  let currentScrollWidth = 80;
  Object.defineProperty(row.label, 'scrollWidth', {
    get() {
      scrollWidthReads++;
      return currentScrollWidth;
    },
  });

  const binding = h.bind(container, {hostSelector: '.card-host', targetSelector: '.card-label'});

  // Moving across child elements inside the same non-overflowing host reads scrollWidth once.
  container.dispatch('pointerover', {target: row.child});
  container.dispatch('pointerout', {target: row.child, relatedTarget: row.label});
  container.dispatch('pointerover', {target: row.label});
  container.dispatch('pointerout', {target: row.label, relatedTarget: row.text});
  container.dispatch('pointerover', {target: row.text});
  assert.equal(scrollWidthReads, 1);

  // Leaving the host resets the cache so re-entering re-checks scrollWidth.
  container.dispatch('pointerout', {target: row.text, relatedTarget: container});
  container.dispatch('pointerover', {target: row.child});
  assert.equal(scrollWidthReads, 2);

  // Switching to another host or calling clear() also resets the cache.
  container.dispatch('pointerover', {target: other.child});
  container.dispatch('pointerover', {target: row.child});
  assert.equal(scrollWidthReads, 3);

  currentScrollWidth = 150;
  row.text.scrollWidth = 150;
  binding.clear();
  container.dispatch('pointerover', {target: row.child});
  assert.equal(scrollWidthReads, 4);
  assert.equal(row.label.classList.contains('loop-marquee'), true);

  binding.destroy();
});

test('Alpine x-loop-marquee-delegate directive binds delegated bounce marquee and registers cleanup', () => {
  const directives = new Map();
  let mutateCalls = 0;
  const alpine = {
    directive(name, handler) {directives.set(name, handler);},
    mutateDom(fn) {mutateCalls++; fn();},
  };
  const h = fixture({alpine});
  h.document.dispatch('alpine:init');
  assert.equal(typeof directives.get('loop-marquee-delegate'), 'function');

  for (const cfg of [
    {host: '.card-host', target: '.card-label'},
    {hostSelector: '.card-host', targetSelector: '.card-label'},
  ]) {
    const container = h.node('grid');
    const row = makeDelegatedRow(h, {clientWidth: 100, scrollWidth: 150});
    container.append(row.host);
    let cleanupFn = null;
    directives.get('loop-marquee-delegate')(
      container,
      {expression: 'cfg'},
      {evaluate: () => cfg, cleanup: fn => {cleanupFn = fn;}},
    );
    assert.equal(container.listeners.size, 4);
    assert.equal(typeof cleanupFn, 'function');
    container.dispatch('pointerover', {target: row.child});
    assert.equal(row.label.classList.contains('loop-marquee'), true);
    assert.equal(row.label.classList.contains('is-bouncing'), true);
    cleanupFn();
    assert.equal(row.label.classList.contains('loop-marquee'), false);
    assert.equal(row.text.classList.contains('loop-marquee-text'), false);
    assert.equal(container.listeners.size, 0);
  }
  assert.equal(mutateCalls, 4, 'delegated wrap and unwrap run inside Alpine.mutateDom when Alpine is present');
});

test('loop-marquee.css scopes seamless host rules away from bounce and supports generic bounce hosts', () => {
  const css = readRepo('frontend/css/loop-marquee.css');
  assert.match(
    css,
    /\.loop-marquee-host:is\(:hover,:focus-visible\)\s+\.loop-marquee\.is-overflowing:not\(\.is-bouncing\)\s*\{[^}]*mask-image:/,
    'seamless host hover/focus mask must exclude .is-bouncing',
  );
  assert.match(
    css,
    /\.loop-marquee-host:is\(:hover,:focus-visible\)\s+\.loop-marquee\.is-overflowing:not\(\.is-bouncing\)\s+\.loop-marquee-track\s*\{[^}]*animation:loop-marquee-travel/,
    'seamless host travel animation must exclude .is-bouncing',
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:reduce\)\s*\{[\s\S]*\.loop-marquee-host:is\(:hover,:focus-visible\)\s+\.loop-marquee\.is-overflowing:not\(\.is-bouncing\)\s+\.loop-marquee-track\s*\{\s*animation:none;\s*\}/,
    'reduced-motion seamless host rule must exclude .is-bouncing',
  );
  assert.match(
    css,
    /\.loop-marquee\.is-bouncing\s*\{[^}]*text-overflow:\s*clip\s*;/,
    '.loop-marquee.is-bouncing must clip ellipsis',
  );
  assert.match(
    css,
    /\.loop-marquee-host:is\(:hover,:focus-visible,:focus-within,\.is-selected,\[aria-selected="true"\]\)\s+\.loop-marquee\.is-bouncing\.is-overflowing\s+\.loop-marquee-track,[\s\S]*?animation:loop-marquee-bounce/,
    'bounce animation block must include generic .loop-marquee-host trigger',
  );
});
