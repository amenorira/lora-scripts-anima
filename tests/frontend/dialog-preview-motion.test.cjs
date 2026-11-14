const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, deferred} = require('./helpers.cjs');

function setup({preview = true, reduced = false, failModal = false} = {}) {
  const callbacks = new Map(), animations = [], events = [];
  const backgroundClasses = new Set();
  const background = {classList: {toggle(name, enabled) {enabled ? backgroundClasses.add(name) : backgroundClasses.delete(name);}}};
  const document = {activeElement: null, body: {}, addEventListener() {}, querySelector(selector) {return selector === 'body > .app-layout' ? background : null;}, getElementById() {return null;}};
  const opener = {id: 'opener', isConnected: true, disabled: false, getClientRects: () => [{}], focus() {document.activeElement = this;}};
  const autofocus = {disabled: false, getClientRects: () => [{}], focus() {document.activeElement = this;}};
  document.activeElement = opener;
  const animate = (target, frames, options) => {
    const pending = deferred();
    const animation = {target, frames, options, finished: pending.promise, cancelled: false,
      finish: pending.resolve, cancel() {this.cancelled = true; pending.reject(new Error('cancelled'));}};
    animations.push(animation);
    return animation;
  };
  const modal = {animate(frames, options) {if (failModal) throw new Error('animation unavailable'); return animate('modal', frames, options);}};
  const attrs = new Set();
  const element = {
    classList: {contains(name) {return preview && name === 'preview-lightbox';}},
    open: false, isConnected: true, inert: false, closeCount: 0,
    showModal() {this.open = true;}, close() {this.open = false; this.closeCount++;},
    querySelector(selector) {return selector === '.modal' ? modal : null;},
    querySelectorAll(selector) {return selector === '[data-dialog-autofocus]' ? [autofocus] : [];},
    contains(node) {return node === autofocus;}, getAnimations() {return [];},
    setAttribute(name) {attrs.add(name);}, removeAttribute(name) {attrs.delete(name);}, hasAttribute(name) {return attrs.has(name);},
    addEventListener(name, callback) {callbacks.set(name, callback);}, removeEventListener(name) {callbacks.delete(name);},
    dispatchEvent(event) {events.push(event.type); if (event.type === 'dialog-close') controller.setOpen(false);},
    animate(frames, options) {return animate('overlay', frames, options);},
  };
  const context = loadFrontend(['shared/ui-interactions'], {
    window: {matchMedia: () => ({matches: reduced})}, document,
    getComputedStyle(node) {
      return {opacity: node === element ? '.62' : '1', transform: 'matrix(.97, 0, 0, .97, 0, 0)',
        getPropertyValue(name) {return name === '--duration-dialog-exit' ? '150ms' : name === '--ease-out' ? 'ease-out' : '';}};
    },
    CustomEvent: class {constructor(type) {this.type = type;}},
  });
  const controller = context.window.AnimaUI.bindDialog(element, callback => callback());
  const emit = (name, values = {}) => callbacks.get(name)?.({preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...values});
  return {controller, element, animations, events, document, opener, autofocus, emit, backgroundClasses};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('sample dialog fades and shrinks before native close and after-close cleanup', async () => {
  const {controller, element, animations, events, document, opener} = setup();
  controller.setOpen(true);
  controller.setOpen(false);
  assert.equal(element.open, true);
  assert.equal(element.inert, true);
  assert.equal(element.hasAttribute('data-dialog-closing'), true);
  assert.equal(element.closeCount, 0);
  assert.deepEqual(events, []);
  assert.equal(animations.length, 2);
  assert.equal(animations[0].target, 'overlay');
  assert.equal(animations[0].frames[0].opacity, '.62');
  assert.equal(animations[0].frames[1].opacity, 0);
  assert.equal(animations[1].target, 'modal');
  assert.equal(animations[1].frames[0].transform, 'matrix(.97, 0, 0, .97, 0, 0)');
  assert.equal(animations[1].frames[1].transform, 'scale(.99)');
  assert.equal(animations[0].options.duration, 150);
  animations[0].finish(); await tick();
  assert.equal(element.open, true, 'both exit animations must finish before closing');
  animations[1].finish(); await tick();
  assert.equal(element.open, false);
  assert.equal(element.closeCount, 1);
  assert.deepEqual(events, ['dialog-after-close']);
  assert.equal(document.activeElement, opener);
});

test('reopening during the exit cancels it without closing or restoring stale focus', async () => {
  const {controller, element, animations, events, document, autofocus} = setup();
  controller.setOpen(true);
  controller.setOpen(false);
  controller.setOpen(true);
  await tick();
  assert.equal(animations.every(animation => animation.cancelled), true);
  assert.equal(element.open, true);
  assert.equal(element.inert, false);
  assert.equal(element.closeCount, 0);
  assert.equal(element.hasAttribute('data-dialog-closing'), false);
  assert.deepEqual(events, []);
  assert.equal(document.activeElement, autofocus);
});

test('Escape uses the same exit and reduced motion closes immediately', async () => {
  const normal = setup();
  normal.controller.setOpen(true);
  normal.emit('keydown', {key: 'Escape'});
  assert.equal(normal.element.open, true);
  assert.deepEqual(normal.events, ['dialog-close']);
  normal.animations.forEach(animation => animation.finish());
  await tick();
  assert.equal(normal.element.open, false);
  assert.deepEqual(normal.events, ['dialog-close', 'dialog-after-close']);

  const reduced = setup({reduced: true});
  reduced.controller.setOpen(true);
  reduced.emit('cancel');
  assert.equal(reduced.element.open, false);
  assert.equal(reduced.animations.length, 0);
  assert.deepEqual(reduced.events, ['dialog-close', 'dialog-after-close']);
});

test('a backdrop click exits normally while a drag from inside cannot dismiss the dialog', async () => {
  const value = setup();
  value.controller.setOpen(true);
  let stopped = false;
  value.emit('pointerdown', {target: {}});
  value.emit('click', {target: value.element, stopImmediatePropagation() {stopped = true;}});
  assert.equal(stopped, true);
  assert.equal(value.element.open, true);
  stopped = false;
  value.emit('pointerdown', {target: value.element});
  value.emit('click', {target: value.element, stopImmediatePropagation() {stopped = true;}});
  assert.equal(stopped, false);
  // The existing @click.self handler closes the viewer after the capture guard.
  value.controller.setOpen(false);
  assert.equal(value.element.open, true);
  value.animations.forEach(animation => animation.finish());
  await tick();
  assert.equal(value.element.open, false);
});

test('an unavailable panel animation falls back to closing without leaving an active fade', async () => {
  const {controller, element, animations, events} = setup({failModal: true});
  controller.setOpen(true);
  controller.setOpen(false);
  await tick();
  assert.equal(element.open, false);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].cancelled, true);
  assert.deepEqual(events, ['dialog-after-close']);
});

test('other ordinary dialogs keep their existing synchronous native close', () => {
  const {controller, element, animations, events} = setup({preview: false});
  controller.setOpen(true);
  controller.setOpen(false);
  assert.equal(element.open, false);
  assert.equal(element.closeCount, 1);
  assert.equal(animations.length, 0);
  assert.deepEqual(events, ['dialog-after-close']);
});

test('the sample dialog does not blur the background while opening or closing', async () => {
  const value = setup();
  value.controller.setOpen(true);
  assert.equal(value.backgroundClasses.has('dialog-is-background'), false);
  value.controller.setOpen(false);
  assert.equal(value.backgroundClasses.has('dialog-is-background'), false);
  value.animations.forEach(animation => animation.finish());
  await tick();
  assert.equal(value.backgroundClasses.has('dialog-is-background'), false);
  value.controller.setOpen(true);
  value.controller.destroy();
  assert.equal(value.backgroundClasses.has('dialog-is-background'), false);
});
