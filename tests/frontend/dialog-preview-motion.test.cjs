const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, deferred} = require('./helpers.cjs');

function setup({preview = true, reduced = false, failModal = false} = {}) {
  const callbacks = new Map(), animations = [], events = [];
  const document = {activeElement: null, body: {}, addEventListener() {}, querySelector() {return null;}, getElementById() {return null;}};
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
  const nestedDialog = () => {
    const nestedAttrs = new Set();
    const nested = {...element, open: false, closeCount: 0,
      classList: {contains(name) {return name === 'modal-overlay';}},
      querySelectorAll() {return [];},
      setAttribute(name) {nestedAttrs.add(name);}, removeAttribute(name) {nestedAttrs.delete(name);}, hasAttribute(name) {return nestedAttrs.has(name);},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    };
    return {element: nested, controller: context.window.AnimaUI.bindDialog(nested, callback => callback())};
  };
  return {controller, element, animations, events, document, opener, autofocus, emit, nestedDialog};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('sample dialog fades and moves slightly before native close and after-close cleanup', async () => {
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
  assert.equal(animations[1].frames[1].transform, 'translateY(4px)');
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

test('nested details keep the original scrim until the sample viewer actually closes', async () => {
  const value = setup();
  value.controller.setOpen(true);
  const detail = value.nestedDialog();
  detail.controller.setOpen(true);
  assert.equal(value.element.hasAttribute('data-dialog-nested'), false);
  assert.equal(detail.element.hasAttribute('data-dialog-nested'), true);
  detail.controller.setOpen(false);
  assert.equal(value.element.open, true);
  assert.equal(detail.element.hasAttribute('data-dialog-nested'), true, 'retain the transparent scrim during its CSS exit');
  value.controller.setOpen(false);
  value.animations.forEach(animation => animation.finish());
  await tick();
  detail.controller.setOpen(true);
  assert.equal(detail.element.hasAttribute('data-dialog-nested'), false, 'a later standalone opening owns its scrim');
  detail.controller.destroy();
});

test('reopening then destroying a sample viewer releases its scrim ownership', async () => {
  const value = setup();
  value.controller.setOpen(true);
  value.controller.setOpen(false);
  value.controller.setOpen(true);
  await tick();
  assert.equal(value.element.open, true);
  value.controller.destroy();
  await tick();
  assert.equal(value.element.open, false);
  const detail = value.nestedDialog();
  detail.controller.setOpen(true);
  assert.equal(detail.element.hasAttribute('data-dialog-nested'), false);
  detail.controller.destroy();
});

function makeRect(left, top, width, height) {
  return {left, top, width, height, right: left + width, bottom: top + height};
}

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(...names) {names.forEach(name => set.add(name));},
    remove(...names) {names.forEach(name => set.delete(name));},
    contains(name) {return set.has(name);},
    toggle(name, force) {
      const next = force === undefined ? !set.has(name) : !!force;
      if (next) set.add(name); else set.delete(name);
      return next;
    },
    [Symbol.iterator]() {return set.values();},
  };
}

function setupMorph({reduced = false} = {}) {
  const animations = [];
  const computedMap = new Map();
  const styleReads = new Map();
  const document = {
    activeElement: null, body: {},
    addEventListener() {}, querySelector() {return null;}, getElementById() {return null;},
    querySelectorAll() {return [];},
    createElement(tag) {
      const attrs = new Set();
      const node = {
        tagName: String(tag).toUpperCase(),
        className: '',
        style: {},
        setAttribute(name) {attrs.add(name);},
        removeAttribute(name) {attrs.delete(name);},
        hasAttribute(name) {return attrs.has(name);},
        remove() {
          this.removed = true;
          const idx = this._parentArr?.indexOf(this) ?? -1;
          if (idx >= 0) this._parentArr.splice(idx, 1);
        },
      };
      node.animate = makeAnimator(node, () => (node.className === 'dialog-morph-fill' ? 'fill' : tag));
      return node;
    },
  };
  const context = loadFrontend(['shared/ui-interactions'], {
    window: {innerWidth: 1280, innerHeight: 800, matchMedia: () => ({matches: reduced})},
    document,
    getComputedStyle(node) {
      styleReads.set(node, (styleReads.get(node) || 0) + 1);
      const custom = computedMap.get(node) || {};
      const props = custom.props || {};
      const visibility = node?.classList?.contains?.('dialog-morph-origin') ? 'hidden' : (custom.visibility ?? 'visible');
      return {
        transform: custom.transform ?? 'none',
        opacity: custom.opacity ?? '1',
        clipPath: custom.clipPath ?? 'none',
        inset: custom.inset ?? '0px',
        backgroundColor: custom.backgroundColor ?? 'rgb(32, 33, 33)',
        borderRadius: custom.borderRadius ?? '10px',
        borderColor: custom.borderColor ?? 'rgb(60, 61, 66)',
        borderWidth: custom.borderWidth ?? '1px',
        borderTopColor: custom.borderTopColor ?? 'rgb(60, 61, 66)',
        borderTopWidth: custom.borderTopWidth ?? '1px',
        color: custom.color ?? 'rgb(255, 255, 255)',
        font: custom.font ?? '13px Inter',
        letterSpacing: custom.letterSpacing ?? '0px',
        padding: custom.padding ?? '6px 12px',
        display: custom.display ?? 'inline-flex',
        gap: custom.gap ?? '6px',
        alignItems: custom.alignItems ?? 'center',
        justifyContent: custom.justifyContent ?? 'center',
        visibility,
        overflowX: custom.overflowX ?? 'visible',
        overflowY: custom.overflowY ?? 'visible',
        getPropertyValue(name) {return props[name] ?? '';},
      };
    },
    CustomEvent: class {constructor(type) {this.type = type;}},
  });

  const makeAnimator = (node, targetName, shouldFail = () => false) => (frames, options) => {
    const resolvedName = typeof targetName === 'function' ? targetName() : targetName;
    if (shouldFail()) throw new Error(`animate failed on ${resolvedName}`);
    const pending = deferred();
    const animation = {
      targetName: resolvedName, effect: {target: node}, frames: JSON.parse(JSON.stringify(frames)), options: {...options},
      playState: 'running', finished: pending.promise,
      cancelled: false, finishedCount: 0,
      finish() {this.playState = 'finished'; this.finishedCount++; pending.resolve();},
      cancel() {this.playState = 'idle'; this.cancelled = true; pending.reject(new Error('cancelled'));},
    };
    animations.push(animation);
    return animation;
  };

  const createOpener = ({id, rect, anchorRect, style = {}} = {}) => {
    let rectReads = 0;
    const anchor = anchorRect ? {
      classList: makeClassList(), isConnected: true, parentElement: document.body,
      getClientRects: () => [anchorRect],
      getBoundingClientRect: () => anchorRect,
    } : null;
    const opener = {
      id, classList: makeClassList(), isConnected: true, disabled: false, parentElement: document.body,
      get rectReads() {return rectReads;},
      anchor,
      querySelector(selector) {return selector === '[data-dialog-anchor]' ? anchor : null;},
      getClientRects: () => [rect],
      getBoundingClientRect: () => {rectReads++; return rect;},
      focus() {document.activeElement = this;},
      getAttribute() {return null;},
      cloneNode() {
        const attrs = new Set(['data-dialog-opens']);
        const copy = {
          classList: makeClassList(opener.classList),
          style: {},
          inert: false,
          querySelectorAll() {return [];},
          setAttribute(name) {attrs.add(name);},
          removeAttribute(name) {attrs.delete(name);},
          hasAttribute(name) {return attrs.has(name);},
          remove() {
            this.removed = true;
            const idx = this._parentArr?.indexOf(this) ?? -1;
            if (idx >= 0) this._parentArr.splice(idx, 1);
          },
        };
        copy.animate = makeAnimator(copy, 'copy');
        return copy;
      },
    };
    computedMap.set(opener, {
      backgroundColor: 'rgb(45, 45, 48)',
      borderRadius: '6px',
      borderTopColor: 'rgb(70, 70, 76)',
      borderTopWidth: '1px',
      ...style,
    });
    return opener;
  };

  const createDialog = ({
    morph = true, hero = false,
    modalRect = makeRect(300, 180, 600, 440),
    mediaRect = makeRect(200, 120, 400, 300),
    failTarget = null,
  } = {}) => {
    const attrs = new Set();
    const events = [];
    const appended = [];
    const classList = makeClassList(morph ? ['modal-overlay', 'modal-overlay--morph'] : ['modal-overlay']);
    const element = {
      classList, open: false, isConnected: true, inert: false, closeCount: 0,
      showModal() {this.open = true;},
      close() {this.open = false; this.closeCount++;},
      setAttribute(name) {attrs.add(name);},
      removeAttribute(name) {attrs.delete(name);},
      hasAttribute(name) {return attrs.has(name);},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent(event) {events.push(event.type);},
      getBoundingClientRect: () => makeRect(0, 0, 1280, 800),
      append(node) {node._parentArr = appended; appended.push(node);},
      getAnimations() {return [];},
    };
    const media = hero ? {getBoundingClientRect: () => mediaRect} : null;
    const surface = hero ? {} : null;
    const header = hero ? {} : null;
    const details = hero ? {} : null;
    const chrome = hero ? [surface, header, details] : [];
    const modal = {
      getBoundingClientRect: () => modalRect,
      closest(selector) {return selector === 'dialog[open]' && element.open ? element : null;},
      querySelector(selector) {
        if (selector === '[data-dialog-anchor="target"]') return media;
        if (selector === '.dialog-morph-surface') return surface;
        return null;
      },
      querySelectorAll(selector) {return selector === '[data-dialog-chrome]' ? chrome : [];},
      getAnimations() {return [];},
    };
    const autofocus = {
      disabled: false, getClientRects: () => [{}],
      focus() {document.activeElement = this;},
      closest(selector) {return selector === '.modal' ? modal : null;},
    };
    element.querySelector = selector => {
      if (selector === '.modal') return modal;
      if (selector === '[data-dialog-anchor="target"]') return media;
      return null;
    };
    element.querySelectorAll = selector => (selector === '[data-dialog-autofocus]' ? [autofocus] : []);
    element.contains = node => node === autofocus || node === modal || node === media;

    element.animate = makeAnimator(element, 'dialog', () => failTarget === 'dialog');
    modal.animate = makeAnimator(modal, 'modal', () => failTarget === 'modal');
    if (media) media.animate = makeAnimator(media, 'media', () => failTarget === 'media');
    if (surface) surface.animate = makeAnimator(surface, 'surface', () => failTarget === 'surface');
    if (header) header.animate = makeAnimator(header, 'header', () => failTarget === 'header');
    if (details) details.animate = makeAnimator(details, 'details', () => failTarget === 'details');

    computedMap.set(element, {
      props: {
        '--duration-dialog-enter': '280ms',
        '--duration-dialog-exit': '240ms',
        '--ease-disclosure': 'cubic-bezier(.1, .78, .21, 1)',
      },
    });
    const controller = context.window.AnimaUI.bindDialog(element, callback => callback());
    return {element, modal, media, surface, header, details, autofocus, controller, events, appended};
  };

  return {AnimaUI: context.window.AnimaUI, document, animations, computedMap, styleReads, createOpener, createDialog};
}

function parseTranslateScale(transform) {
  const match = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)$/.exec(transform);
  assert.ok(match, `unexpected transform format: ${transform}`);
  return {dx: Number(match[1]), dy: Number(match[2]), scale: Number(match[3])};
}

test('morph button-to-modal performs iOS container transform from button to window and back', async () => {
  const env = setupMorph();
  const opener = env.createOpener({id: 'openBtn', rect: makeRect(40, 20, 120, 32)});
  env.document.activeElement = opener;
  const dialog = env.createDialog({modalRect: makeRect(300, 180, 600, 440)});

  env.AnimaUI.setDialogOrigin(dialog.element, opener);
  dialog.controller.setOpen(true);

  assert.equal(env.animations.length, 5);
  assert.equal(dialog.appended.length, 2, 'appends .dialog-morph-fill and .dialog-morph-button');
  const [fillNode, copyNode] = dialog.appended;
  assert.equal(fillNode.className, 'dialog-morph-fill');
  assert.equal(fillNode.style.borderWidth, '1px');
  assert.equal(copyNode.classList.contains('dialog-morph-button'), true);
  assert.equal(copyNode.hasAttribute('data-dialog-opens'), false);
  assert.equal(copyNode.hasAttribute('x-ignore'), true);
  assert.equal(copyNode.inert, true);
  assert.equal(copyNode.style.transform, 'none');
  assert.equal(dialog.element.hasAttribute('data-dialog-button-flight'), true);
  assert.equal(opener.classList.contains('dialog-morph-origin'), true);

  const [clipEnter, fillEnter, modalTransformEnter, copyOpacityEnter, modalOpacityEnter] = env.animations;
  assert.equal(clipEnter.targetName, 'dialog');
  assert.equal(clipEnter.options.duration, 280);
  assert.equal(clipEnter.options.easing, 'cubic-bezier(.1, .78, .21, 1)');
  assert.deepEqual(clipEnter.frames, [
    {clipPath: 'inset(20px 1120px 748px 40px round 6px)'},
    {clipPath: 'inset(180px 380px 180px 300px round 10px)'},
  ]);
  assert.equal(fillEnter.targetName, 'fill');
  assert.equal('borderWidth' in fillEnter.frames[0], false, 'equal 1px borderWidth is omitted from keyframes');
  assert.deepEqual(fillEnter.frames, [
    {inset: '20px 1120px 748px 40px', borderRadius: '6px', backgroundColor: 'rgb(45, 45, 48)', borderColor: 'rgb(70, 70, 76)'},
    {inset: '180px 380px 180px 300px', borderRadius: '10px', backgroundColor: 'rgb(32, 33, 33)', borderColor: 'rgb(60, 61, 66)'},
  ]);

  assert.equal(modalTransformEnter.targetName, 'modal');
  const enterStart = parseTranslateScale(modalTransformEnter.frames[0].transform);
  assert.equal(enterStart.dx, -500);
  assert.equal(enterStart.dy, -364);
  assert.equal(enterStart.scale, 0.22, 'clamped to 0.22 minimum when btnScale is 0.2');
  assert.equal(modalTransformEnter.frames[1].transform, 'translate(0px, 0px) scale(1)');

  assert.equal(copyOpacityEnter.targetName, 'copy');
  assert.equal(copyOpacityEnter.options.easing, 'linear');
  assert.deepEqual(copyOpacityEnter.frames, [{opacity: 1}, {opacity: 0, offset: 0.18}, {opacity: 0}]);
  assert.equal(modalOpacityEnter.options.easing, 'linear');
  assert.deepEqual(modalOpacityEnter.frames, [
    {opacity: 0},
    {opacity: 0, offset: 0.08, easing: 'ease-out'},
    {opacity: 1, offset: 0.56},
    {opacity: 1},
  ]);
  assert.deepEqual(dialog.events, []);

  env.animations.slice(0, 5).forEach(a => a.finish());
  await tick();
  assert.equal(dialog.appended.length, 0, 'stopDialogMotion removes temporary flight nodes after entrance');
  assert.equal(dialog.element.hasAttribute('data-dialog-button-flight'), false);
  assert.equal(opener.classList.contains('dialog-morph-origin'), true, 'opener stays hidden while modal is open');
  assert.deepEqual(dialog.events, ['dialog-after-open']);

  dialog.controller.setOpen(false);
  assert.equal(dialog.element.open, true);
  assert.equal(dialog.element.hasAttribute('data-dialog-closing'), true);
  assert.equal(dialog.element.closeCount, 0);
  assert.equal(env.animations.length, 10);
  const [clipExit, fillExit, modalTransformExit, copyOpacityExit, modalOpacityExit] = env.animations.slice(5);
  assert.equal(clipExit.options.duration, 240);
  assert.deepEqual(clipExit.frames, [
    {clipPath: 'inset(180px 380px 180px 300px round 10px)'},
    {clipPath: 'inset(20px 1120px 748px 40px round 6px)'},
  ]);
  assert.deepEqual(fillExit.frames[1], fillEnter.frames[0]);
  assert.equal(modalTransformExit.frames[1].transform, 'translate(-500px, -364px) scale(0.22)');
  assert.deepEqual(copyOpacityExit.frames, [{opacity: 0}, {opacity: 0, offset: 0.72}, {opacity: 1}]);
  assert.deepEqual(modalOpacityExit.frames, [
    {opacity: 1},
    {opacity: 1, offset: 0.04, easing: 'ease-in-out'},
    {opacity: 0, offset: 0.38},
    {opacity: 0},
  ]);

  env.animations.slice(5, 10).forEach(a => a.finish());
  await tick();
  assert.equal(dialog.element.open, false);
  assert.equal(dialog.element.closeCount, 1);
  assert.equal(dialog.appended.length, 0);
  assert.equal(opener.classList.contains('dialog-morph-origin'), false, 'opener becomes visible after close');
  assert.deepEqual(dialog.events, ['dialog-after-open', 'dialog-after-close']);
  assert.equal(env.document.activeElement, opener);

  // Verify borderWidth keyframes are emitted only when opener and modal differ, and startScale clamps at 1.
  const thickBtn = env.createOpener({id: 'thickBtn', rect: makeRect(10, 10, 40, 20), style: {borderTopWidth: '2px'}});
  const clampDialog = env.createDialog({modalRect: makeRect(300, 180, 600, 440)});
  env.AnimaUI.setDialogOrigin(clampDialog.element, thickBtn);
  clampDialog.controller.setOpen(true);
  assert.equal(env.animations[11].frames[0].borderWidth, '2px');
  assert.equal(env.animations[11].frames[1].borderWidth, '1px');
  env.animations.slice(10).forEach(a => a.finish());
  await tick();
  clampDialog.controller.setOpen(false);
  env.animations.slice(15).forEach(a => a.finish());
  await tick();

  const wideBtn = env.createOpener({id: 'wideBtn', rect: makeRect(10, 10, 700, 500)});
  const wideDialog = env.createDialog({modalRect: makeRect(300, 180, 600, 440)});
  env.AnimaUI.setDialogOrigin(wideDialog.element, wideBtn);
  wideDialog.controller.setOpen(true);
  assert.equal(parseTranslateScale(env.animations[22].frames[0].transform).scale, 1, 'clamps startScale at 1');
  env.animations.slice(20).forEach(a => a.finish());
  await tick();
  wideDialog.controller.setOpen(false);
  env.animations.slice(25).forEach(a => a.finish());
  await tick();

  // Non-morph dialogs skip measureOrigin in setDialogOrigin while keeping focus restoration.
  const plainOpener = env.createOpener({id: 'plainBtn', rect: makeRect(10, 10, 80, 28)});
  const plainDialog = env.createDialog({morph: false});
  env.AnimaUI.setDialogOrigin(plainDialog.element, plainOpener);
  assert.equal(plainOpener.rectReads, 0);
  plainDialog.controller.setOpen(true);
  plainDialog.controller.setOpen(false);
  assert.equal(env.document.activeElement, plainOpener);
});

test('morph button-to-modal without opener falls back to centered scale and opacity', async () => {
  const env = setupMorph();
  const dialog = env.createDialog();

  dialog.controller.setOpen(true);
  assert.equal(env.animations.length, 1);
  assert.equal(env.animations[0].targetName, 'modal');
  assert.deepEqual(env.animations[0].frames, [
    {transform: 'translate(0px, 0px) scale(0.95)', opacity: 0},
    {transform: 'translate(0px, 0px) scale(1)', opacity: 1},
  ]);
  env.animations[0].finish();
  await tick();
  assert.deepEqual(dialog.events, ['dialog-after-open']);

  dialog.controller.setOpen(false);
  assert.equal(env.animations.length, 2);
  assert.deepEqual(env.animations[1].frames, [
    {transform: 'translate(0px, 0px) scale(1)', opacity: 1},
    {transform: 'translate(0px, 0px) scale(0.97)', opacity: 0},
  ]);
  env.animations[1].finish();
  await tick();
  assert.equal(dialog.element.open, false);
  assert.deepEqual(dialog.events, ['dialog-after-open', 'dialog-after-close']);
});

test('morph media hero animates pure transform, phased chrome opacity, surface scale, and swaps hidden origin', async () => {
  const env = setupMorph();
  const tile1 = env.createOpener({id: 'tile1', rect: makeRect(50, 30, 120, 110), anchorRect: makeRect(60, 40, 100, 75)});
  const tile2 = env.createOpener({id: 'tile2', rect: makeRect(170, 30, 120, 110), anchorRect: makeRect(180, 40, 100, 75)});
  env.document.activeElement = tile1;
  const dialog = env.createDialog({hero: true, mediaRect: makeRect(200, 120, 400, 300)});

  env.AnimaUI.setDialogOrigin(dialog.element, tile1);
  dialog.controller.setOpen(true);

  assert.equal(tile1.anchor.classList.contains('dialog-morph-origin'), true);
  assert.equal(tile1.classList.contains('dialog-morph-origin'), false);
  assert.equal(env.animations.length, 5);
  assert.equal(env.animations.every(a => a.options.duration === 280 && a.options.fill === 'both'), true);

  const [mediaEnter, surfaceOpacity, headerOpacity, detailsOpacity, surfaceScale] = env.animations;
  assert.equal(mediaEnter.targetName, 'media');
  assert.equal(mediaEnter.options.easing, 'cubic-bezier(.1, .78, .21, 1)');
  assert.deepEqual(mediaEnter.frames, [
    {transform: 'translate(-140px, -80px) scale(0.25, 0.25)'},
    {transform: 'translate(0px, 0px) scale(1, 1)'},
  ]);
  const expectedOpenChrome = [
    {opacity: 0},
    {opacity: 0, offset: 0.12, easing: 'ease-out'},
    {opacity: 1, offset: 0.72},
    {opacity: 1},
  ];
  for (const [anim, name] of [[surfaceOpacity, 'surface'], [headerOpacity, 'header'], [detailsOpacity, 'details']]) {
    assert.equal(anim.targetName, name);
    assert.equal(anim.options.easing, 'linear');
    assert.deepEqual(anim.frames, expectedOpenChrome);
  }
  assert.equal(surfaceScale.targetName, 'surface');
  assert.equal(surfaceScale.options.easing, 'cubic-bezier(.1, .78, .21, 1)');
  assert.deepEqual(surfaceScale.frames, [{transform: 'scale(0.97)'}, {transform: 'scale(1)'}]);

  env.animations.forEach(a => a.finish());
  await tick();
  assert.deepEqual(dialog.events, ['dialog-after-open']);
  assert.equal(tile1.anchor.classList.contains('dialog-morph-origin'), true);

  // Stepping to the next image while open swaps .dialog-morph-origin and return target.
  env.AnimaUI.setDialogOrigin(dialog.element, tile2);
  assert.equal(tile1.anchor.classList.contains('dialog-morph-origin'), false);
  assert.equal(tile2.anchor.classList.contains('dialog-morph-origin'), true);

  dialog.controller.setOpen(false);
  const exitAnims = env.animations.slice(5);
  assert.equal(exitAnims.length, 5);
  assert.equal(exitAnims.every(a => a.options.duration === 240), true);
  assert.deepEqual(exitAnims[0].frames, [
    {transform: 'translate(0px, 0px) scale(1, 1)'},
    {transform: 'translate(-20px, -80px) scale(0.25, 0.25)'},
  ]);
  const expectedCloseChrome = [
    {opacity: 1, easing: 'ease-out'},
    {opacity: 0, offset: 0.42},
    {opacity: 0},
  ];
  for (const anim of exitAnims.slice(1, 4)) {
    assert.equal(anim.options.easing, 'linear');
    assert.deepEqual(anim.frames, expectedCloseChrome);
  }
  assert.deepEqual(exitAnims[4].frames, [{transform: 'scale(1)'}, {transform: 'scale(0.97)'}]);

  exitAnims.forEach(a => a.finish());
  await tick();
  assert.equal(dialog.element.open, false);
  assert.equal(tile2.anchor.classList.contains('dialog-morph-origin'), false);
  assert.equal(env.document.activeElement, tile2);
  assert.deepEqual(dialog.events, ['dialog-after-open', 'dialog-after-close']);
});

test('mid-flight open-close-open interruption retargets both morph paths without premature close', async () => {
  // Button-to-modal container transform interruption
  const btnEnv = setupMorph();
  const btn = btnEnv.createOpener({id: 'btn', rect: makeRect(40, 20, 120, 32)});
  const btnDialog = btnEnv.createDialog();
  btnEnv.AnimaUI.setDialogOrigin(btnDialog.element, btn);
  btnDialog.controller.setOpen(true);

  const [fillEnterNode, copyEnterNode] = btnDialog.appended;
  btnEnv.computedMap.set(btnDialog.element, {
    props: {
      '--duration-dialog-enter': '280ms',
      '--duration-dialog-exit': '240ms',
      '--ease-disclosure': 'cubic-bezier(.1, .78, .21, 1)',
    },
    clipPath: 'inset(100px 750px 464px 170px round 8px)',
  });
  btnEnv.computedMap.set(fillEnterNode, {
    inset: '100px 750px 464px 170px',
    borderRadius: '8px',
    backgroundColor: 'rgb(38, 39, 40)',
    borderColor: 'rgb(65, 66, 71)',
  });
  btnEnv.computedMap.set(copyEnterNode, {opacity: '0.2'});
  btnEnv.computedMap.set(btnDialog.modal, {transform: 'matrix(0.6, 0, 0, 0.6, -250, -182)', opacity: '0.5'});
  btnDialog.controller.setOpen(false);
  assert.equal(btnEnv.animations.slice(0, 5).every(a => a.cancelled), true);
  assert.equal(fillEnterNode.removed, true);
  assert.equal(copyEnterNode.removed, true);
  assert.equal(btnDialog.element.open, true);
  assert.equal(btnDialog.element.closeCount, 0);

  const [fillExitNode, copyExitNode] = btnDialog.appended;
  const [btnClipExit, btnFillExit, btnModalTExit, btnCopyOExit, btnModalOExit] = btnEnv.animations.slice(5, 10);
  assert.equal(btnClipExit.frames[0].clipPath, 'inset(100px 750px 464px 170px round 8px)');
  assert.equal(btnFillExit.frames[0].inset, '100px 750px 464px 170px');
  assert.equal(btnModalTExit.frames[0].transform, 'matrix(0.6, 0, 0, 0.6, -250, -182)');
  assert.deepEqual(btnCopyOExit.frames, [{opacity: '0.2'}, {opacity: '0.2', offset: 0.72}, {opacity: 1}]);
  assert.deepEqual(btnModalOExit.frames, [{opacity: '0.5'}, {opacity: '0.5', offset: 0.04, easing: 'ease-in-out'}, {opacity: 0, offset: 0.38}, {opacity: 0}]);

  btnEnv.computedMap.set(btnDialog.element, {
    props: {
      '--duration-dialog-enter': '280ms',
      '--duration-dialog-exit': '240ms',
      '--ease-disclosure': 'cubic-bezier(.1, .78, .21, 1)',
    },
    clipPath: 'inset(60px 935px 606px 105px round 7px)',
  });
  btnEnv.computedMap.set(fillExitNode, {
    inset: '60px 935px 606px 105px',
    borderRadius: '7px',
    backgroundColor: 'rgb(41, 42, 44)',
    borderColor: 'rgb(67, 68, 73)',
  });
  btnEnv.computedMap.set(copyExitNode, {opacity: '0.4'});
  btnEnv.computedMap.set(btnDialog.modal, {transform: 'matrix(0.4, 0, 0, 0.4, -360, -260)', opacity: '0.35'});
  btnDialog.controller.setOpen(true);
  assert.equal(btnEnv.animations.slice(5, 10).every(a => a.cancelled), true);
  assert.equal(btnDialog.element.closeCount, 0);
  assert.equal(btnDialog.element.hasAttribute('data-dialog-closing'), false);
  const [btnClipReopen, btnFillReopen, btnModalTReopen, btnCopyOReopen, btnModalOReopen] = btnEnv.animations.slice(10, 15);
  assert.deepEqual(btnClipReopen.frames, [
    {clipPath: 'inset(60px 935px 606px 105px round 7px)'},
    {clipPath: 'inset(180px 380px 180px 300px round 10px)'},
  ]);
  assert.equal(btnFillReopen.frames[0].inset, '60px 935px 606px 105px');
  assert.deepEqual(btnModalTReopen.frames, [
    {transform: 'matrix(0.4, 0, 0, 0.4, -360, -260)'},
    {transform: 'translate(0px, 0px) scale(1)'},
  ]);
  assert.deepEqual(btnCopyOReopen.frames, [{opacity: '0.4'}, {opacity: 0, offset: 0.18}, {opacity: 0}]);
  assert.deepEqual(btnModalOReopen.frames, [
    {opacity: '0.35', easing: 'ease-out'},
    {opacity: 1, offset: 0.56},
    {opacity: 1},
  ]);
  btnEnv.animations.slice(10, 15).forEach(a => a.finish());
  await tick();
  assert.equal(btnDialog.element.open, true);
  assert.equal(btnDialog.element.closeCount, 0);
  assert.equal(btnDialog.appended.length, 0);
  assert.deepEqual(btnDialog.events, ['dialog-after-open']);

  // Media hero interruption (deduplicated node sampling + monotonic chrome reopen)
  const heroEnv = setupMorph();
  const tile = heroEnv.createOpener({id: 'tile', rect: makeRect(50, 30, 120, 110), anchorRect: makeRect(60, 40, 100, 75)});
  const heroDialog = heroEnv.createDialog({hero: true});
  heroEnv.AnimaUI.setDialogOrigin(heroDialog.element, tile);
  heroDialog.controller.setOpen(true);

  heroEnv.computedMap.set(heroDialog.media, {transform: 'matrix(0.6, 0, 0, 0.6, -70, -40)'});
  heroEnv.computedMap.set(heroDialog.surface, {transform: 'matrix(0.985, 0, 0, 0.985, 0, 0)', opacity: '0.55'});
  heroEnv.computedMap.set(heroDialog.header, {opacity: '0.55'});
  heroEnv.computedMap.set(heroDialog.details, {opacity: '0.55'});
  heroEnv.styleReads.clear();

  heroDialog.controller.setOpen(false);
  assert.equal(heroEnv.styleReads.get(heroDialog.surface), 1, 'surface computed style is sampled once across both its animations');
  assert.equal(heroEnv.animations.slice(0, 5).every(a => a.cancelled), true);
  const heroExit = heroEnv.animations.slice(5, 10);
  assert.equal(heroExit[0].frames[0].transform, 'matrix(0.6, 0, 0, 0.6, -70, -40)');
  for (const anim of heroExit.slice(1, 4)) {
    assert.deepEqual(anim.frames, [{opacity: '0.55', easing: 'ease-out'}, {opacity: 0, offset: 0.42}, {opacity: 0}]);
  }
  assert.deepEqual(heroExit[4].frames, [{transform: 'matrix(0.985, 0, 0, 0.985, 0, 0)'}, {transform: 'scale(0.97)'}]);

  heroEnv.computedMap.set(heroDialog.media, {transform: 'matrix(0.4, 0, 0, 0.4, -100, -60)'});
  heroEnv.computedMap.set(heroDialog.surface, {transform: 'matrix(0.978, 0, 0, 0.978, 0, 0)', opacity: '0.32'});
  heroEnv.computedMap.set(heroDialog.header, {opacity: '0.32'});
  heroEnv.computedMap.set(heroDialog.details, {opacity: '0.32'});

  heroDialog.controller.setOpen(true);
  assert.equal(heroExit.every(a => a.cancelled), true);
  assert.equal(heroDialog.element.closeCount, 0);
  assert.equal(heroDialog.element.hasAttribute('data-dialog-closing'), false);
  const heroReopen = heroEnv.animations.slice(10, 15);
  assert.deepEqual(heroReopen[0].frames, [
    {transform: 'matrix(0.4, 0, 0, 0.4, -100, -60)'},
    {transform: 'translate(0px, 0px) scale(1, 1)'},
  ]);
  for (const anim of heroReopen.slice(1, 4)) {
    assert.deepEqual(anim.frames, [{opacity: '0.32', easing: 'ease-out'}, {opacity: 1, offset: 0.72}, {opacity: 1}]);
  }
  assert.deepEqual(heroReopen[4].frames, [{transform: 'matrix(0.978, 0, 0, 0.978, 0, 0)'}, {transform: 'scale(1)'}]);
  heroReopen.forEach(a => a.finish());
  await tick();
  assert.equal(heroDialog.element.open, true);
  assert.equal(heroDialog.element.closeCount, 0);
  assert.deepEqual(heroDialog.events, ['dialog-after-open']);

  // Error during .animate() cancels started animations and cleans up temporary flight nodes cleanly.
  const errEnv = setupMorph();
  const errTile = errEnv.createOpener({id: 'errTile', rect: makeRect(50, 30, 120, 110), anchorRect: makeRect(60, 40, 100, 75)});
  const errDialog = errEnv.createDialog({hero: true, failTarget: 'header'});
  errEnv.AnimaUI.setDialogOrigin(errDialog.element, errTile);
  errDialog.controller.setOpen(true);
  assert.equal(errEnv.animations.length, 2);
  assert.equal(errEnv.animations.every(a => a.cancelled), true);
  assert.equal(errTile.anchor.classList.contains('dialog-morph-origin'), false, 'hero throw does not leave origin hidden');
  assert.deepEqual(errDialog.events, ['dialog-after-open']);

  for (const [failTarget, expectedStarted] of [['dialog', 0], ['modal', 2]]) {
    const errBtnEnv = setupMorph();
    const errBtn = errBtnEnv.createOpener({id: `errBtn_${failTarget}`, rect: makeRect(40, 20, 120, 32)});
    const errBtnDialog = errBtnEnv.createDialog({failTarget});
    errBtnEnv.AnimaUI.setDialogOrigin(errBtnDialog.element, errBtn);
    errBtnDialog.controller.setOpen(true);
    assert.equal(errBtnEnv.animations.length, expectedStarted);
    assert.equal(errBtnEnv.animations.every(a => a.cancelled), true);
    assert.equal(errBtnDialog.appended.length, 0, `${failTarget} throw does not leak flight nodes`);
    assert.equal(errBtnDialog.element.hasAttribute('data-dialog-button-flight'), false);
    assert.deepEqual(errBtnDialog.events, ['dialog-after-open']);
  }
});

test('settleDialog finishes running morph animations synchronously and reduced motion skips hiding/animations cleanly', async () => {
  const env = setupMorph();
  const settleBtn = env.createOpener({id: 'settleBtn', rect: makeRect(40, 20, 120, 32)});
  const dialog = env.createDialog();
  env.AnimaUI.setDialogOrigin(dialog.element, settleBtn);
  dialog.controller.setOpen(true);
  const enterAnims = env.animations.slice(0, 5);
  assert.equal(enterAnims.every(a => a.playState === 'running'), true);
  assert.equal(dialog.appended.length, 2);

  env.AnimaUI.settleDialog(dialog.autofocus);
  assert.equal(enterAnims.every(a => a.finishedCount === 1 && a.cancelled), true);
  assert.equal(dialog.appended.length, 0, 'settleDialog removes temporary flight nodes synchronously');
  assert.equal(dialog.element.hasAttribute('data-dialog-button-flight'), false);
  await tick();
  assert.deepEqual(dialog.events, ['dialog-after-open']);

  dialog.controller.setOpen(false);
  const exitAnims = env.animations.slice(5);
  env.AnimaUI.settleDialog(dialog.autofocus);
  assert.equal(exitAnims.every(a => a.finishedCount === 0), true, 'settleDialog ignores closing dialogs');
  exitAnims.forEach(a => a.finish());
  await tick();
  assert.equal(dialog.element.open, false);

  const reduced = setupMorph({reduced: true});
  const opener = reduced.createOpener({id: 'redBtn', rect: makeRect(40, 20, 120, 32)});
  reduced.document.activeElement = opener;
  const reducedDialog = reduced.createDialog();
  reduced.AnimaUI.setDialogOrigin(reducedDialog.element, opener);
  reducedDialog.controller.setOpen(true);
  assert.equal(reduced.animations.length, 0);
  assert.deepEqual(reducedDialog.events, ['dialog-after-open']);

  reducedDialog.controller.setOpen(false);
  assert.equal(reduced.animations.length, 0);
  assert.equal(reducedDialog.element.open, false);
  assert.equal(reducedDialog.element.closeCount, 1);
  assert.deepEqual(reducedDialog.events, ['dialog-after-open', 'dialog-after-close']);
  assert.equal(reduced.document.activeElement, opener);

  const tileA = reduced.createOpener({id: 'tileA', rect: makeRect(50, 30, 120, 110), anchorRect: makeRect(60, 40, 100, 75)});
  const tileB = reduced.createOpener({id: 'tileB', rect: makeRect(170, 30, 120, 110), anchorRect: makeRect(180, 40, 100, 75)});
  const reducedHero = reduced.createDialog({hero: true});
  reduced.AnimaUI.setDialogOrigin(reducedHero.element, tileA);
  reducedHero.controller.setOpen(true);
  assert.equal(reduced.animations.length, 0);
  assert.equal(tileA.anchor.classList.contains('dialog-morph-origin'), false, 'reduced motion does not hide hero origin');
  reduced.AnimaUI.setDialogOrigin(reducedHero.element, tileB);
  assert.equal(tileB.anchor.classList.contains('dialog-morph-origin'), false, 'reduced motion step does not hide hero origin');
  reducedHero.controller.setOpen(false);
});

test('nested morph dialog retains data-dialog-nested through exit and clears on standalone reopen', async () => {
  const env = setupMorph();
  const parent = env.createDialog();
  const child = env.createDialog({hero: true});
  const tile = env.createOpener({id: 'nestedTile', rect: makeRect(50, 30, 120, 110), anchorRect: makeRect(60, 40, 100, 75)});

  parent.controller.setOpen(true);
  assert.equal(parent.element.hasAttribute('data-dialog-nested'), false);
  env.animations.slice().forEach(a => a.playState === 'running' && a.finish());
  await tick();

  env.AnimaUI.setDialogOrigin(child.element, tile);
  child.controller.setOpen(true);
  assert.equal(child.element.hasAttribute('data-dialog-nested'), true);
  assert.equal(parent.element.hasAttribute('data-dialog-nested'), false);
  env.animations.slice().forEach(a => a.playState === 'running' && a.finish());
  await tick();

  child.controller.setOpen(false);
  assert.equal(child.element.open, true);
  assert.equal(child.element.hasAttribute('data-dialog-closing'), true);
  assert.equal(child.element.hasAttribute('data-dialog-nested'), true, 'nested morph scrim persists during exit');
  env.animations.slice().forEach(a => a.playState === 'running' && a.finish());
  await tick();
  assert.equal(child.element.open, false);
  assert.equal(parent.element.open, true);
  assert.equal(parent.element.hasAttribute('data-dialog-nested'), false);

  parent.controller.setOpen(false);
  env.animations.slice().forEach(a => a.playState === 'running' && a.finish());
  await tick();
  assert.equal(parent.element.open, false);

  child.controller.setOpen(true);
  assert.equal(child.element.hasAttribute('data-dialog-nested'), false, 'standalone reopen owns primary scrim');
  child.controller.destroy();
  parent.controller.destroy();
});
