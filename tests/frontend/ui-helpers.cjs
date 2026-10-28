const { loadFrontend } = require('./helpers.cjs');

function uiHarness() {
  let now = 0, timerId = 0;
  const timers = new Map(), ticks = [], factories = {}, listeners = new Map();
  const document = { activeElement: null };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map();
      this.events = new Map(); this.style = {}; this.className = ''; this.hidden = false;
      this.disabled = false; this.inert = false; this.open = false; this.textContent = '';
      this.offsetWidth = 168; this.scrollHeight = 70;
      this.classList = {
        contains: name => this.className.split(' ').includes(name),
        add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
        toggle: (name, on) => {
          if (on) this.classList.add(name);
          else this.className = this.className.split(' ').filter(item => item !== name).join(' ');
        },
      };
    }
    get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
    get tabIndex() { return this.attributes.has('tabindex') ? Number(this.attributes.get('tabindex')) : ['BUTTON', 'INPUT', 'SUMMARY'].includes(this.tagName) ? 0 : -1; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    removeAttribute(key) { this.attributes.delete(key); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(key, callback) { if (!this.events.has(key)) this.events.set(key, new Set()); this.events.get(key).add(callback); }
    removeEventListener(key, callback) { this.events.get(key)?.delete(callback); }
    fire(type, props = {}) {
      const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
      const results = Array.from(this.events.get(type) || [], callback => callback(event));
      return { event, results };
    }
    dispatchEvent(event) { this.fire(event.type, event); }
    appendChild(node) { node.remove(); this.children.push(node); node.parentElement = this; return node; }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    insertBefore(node, sibling) { node.remove(); this.children.splice(this.children.indexOf(sibling), 0, node); node.parentElement = this; }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    matches(selector) {
      if (selector === '[inert]') return this.inert;
      if (selector === 'dialog[open]') return this.tagName === 'DIALOG' && this.open;
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      if (selector.startsWith('[')) {
        const [, key, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) || [];
        return this.attributes.has(key) && (value === undefined || this.attributes.get(key) === value);
      }
      return this.tagName.toLowerCase() === selector;
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      return selector === '*' ? all : all.filter(node => selector.split(',').some(item => node.matches(item.trim())));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    getClientRects() { return !this.isConnected || this.hidden || this.parentElement?.getClientRects().length === 0 ? [] : [{}]; }
    getBoundingClientRect() { return this.rect || { left: 1000, right: 1024, top: 680, bottom: 704 }; }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = document.body; }
    showModal() { this.open = true; this.opens = (this.opens || 0) + 1; this.querySelector('button')?.focus(); }
    close() { this.open = false; document.activeElement = document.body; }
  }
  document.body = new Element('body'); document.activeElement = document.body;
  document.createElement = tag => new Element(tag);
  document.addEventListener = (type, callback) => listeners.set(type, callback);
  document.querySelector = selector => document.body.querySelector(selector);
  document.getElementById = id => document.body.querySelectorAll('*').find(node => node.getAttribute('id') === id) || null;
  const setTimer = (callback, delay = 0, interval = false) => {
    const id = ++timerId; timers.set(id, { callback, at: now + delay, interval: interval ? delay : 0 }); return id;
  };
  const context = {
    document, window: { matchMedia: () => ({ matches: false }), innerWidth: 1280, innerHeight: 720,
      addEventListener() {}, removeEventListener() {} },
    Alpine: { directive() {}, data(name, factory) { factories[name] = factory; }, nextTick: callback => ticks.push(callback) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    Date: class extends Date { static now() { return now; } },
    getComputedStyle: () => ({ visibility: 'visible', getPropertyValue: () => '' }),
    setTimeout: (fn, ms) => setTimer(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => setTimer(fn, ms, true), clearInterval: id => timers.delete(id),
    requestAnimationFrame: callback => setTimer(callback, 16), cancelAnimationFrame: id => timers.delete(id),
    navigator: { clipboard: { writeText: async () => {} } },
  };
  loadFrontend(['shared/ui-interactions', 'shared/notifications'], context);
  listeners.get('alpine:init')();
  const flush = () => { while (ticks.length) ticks.shift()(); };
  const advance = amount => {
    const until = now + amount;
    while (true) {
      const next = Array.from(timers.entries()).filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at; timers.delete(id);
      if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval });
      timer.callback(); flush();
    }
    now = until;
  };
  return { context, document, Element, factories, ticks, flush, advance, listeners };
}

module.exports = { uiHarness };
