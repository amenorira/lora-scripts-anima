const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');
const { uiHarness } = require('./ui-helpers.cjs');

test('action menu supports keyboard opening, wrapping, Escape and viewport bounds', () => {
  const h = uiHarness();
  const root = new h.Element(), trigger = new h.Element('button'), popup = new h.Element();
  const first = new h.Element('button'), last = new h.Element('button');
  first.setAttribute('role', 'menuitem'); last.setAttribute('role', 'menuitem');
  popup.append(first, last); root.append(trigger, popup); h.document.body.append(root);
  const menu = Object.assign(h.factories.actionMenu(), { $el: root, $refs: { trigger, menu: popup }, $nextTick: fn => h.ticks.push(fn) });
  menu.init(); trigger.focus();
  const event = key => ({ key, target: h.document.activeElement, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  menu.key(event('Enter')); h.flush(); h.advance(16);
  assert.equal(menu.open, true); assert.equal(h.document.activeElement, first);
  assert.equal(popup.style.top, 'auto', 'bottom-edge menus open upward');
  assert.ok(parseFloat(popup.style.left) >= 8);
  const contains = popup.contains.bind(popup);
  popup.contains = node => {
    assert.notEqual(node, h.context.window, 'native Node.contains cannot accept the resize event Window target');
    return contains(node);
  };
  menu._track({ type: 'resize', target: h.context.window }); h.advance(16);
  assert.equal(menu.open, true);
  menu.key(event('ArrowUp')); assert.equal(h.document.activeElement, last);
  menu.key(event('Home')); assert.equal(h.document.activeElement, first);
  const escape = event('Escape'); menu.key(escape);
  assert.equal(menu.open, false); assert.equal(h.document.activeElement, trigger);
  assert.equal(escape.stopped, true, 'Escape must not reach a surrounding dialog');
});

test('hover menu preserves editing focus, bridges the pointer gap and closes on leave', () => {
  const h = uiHarness();
  const input = new h.Element('input'), root = new h.Element(), trigger = new h.Element('button'), popup = new h.Element();
  h.document.body.append(input, root); root.append(trigger, popup); input.focus();
  const menu = Object.assign(h.factories.actionMenu(), { $el: root, $refs: { trigger, menu: popup }, $nextTick: fn => h.ticks.push(fn) });
  menu.init(); menu.hoverEnter({ pointerType: 'mouse' }); h.flush(); h.advance(16);
  assert.equal(menu.open, true); assert.equal(h.document.activeElement, input, 'hover does not steal input focus');
  menu.hoverLeave(); h.advance(100); assert.equal(menu.open, true);
  menu.hoverEnter({ pointerType: 'mouse' }); h.advance(100); assert.equal(menu.open, true, 'entering the popup cancels closure');
  trigger.focus(); menu.toggle(); assert.equal(menu.open, true, 'clicking an already hovered trigger keeps its actions open');
  menu.hoverLeave(); h.advance(120);
  assert.equal(menu.open, false); assert.equal(h.document.activeElement, h.document.body);
  trigger.focus(); menu.hoverEnter({ pointerType: 'mouse' }); menu.close();
  menu.hoverLeave(); h.advance(120);
  assert.equal(h.document.activeElement, h.document.body, 'leaving after an action clears the returned trigger focus');
});

test('dialog opening can be cancelled before next tick and Tab cycles at both ends', () => {
  const h = uiHarness();
  const opener = new h.Element('button'), dialog = new h.Element('dialog');
  const cancel = new h.Element('button'), confirm = new h.Element('button');
  cancel.setAttribute('data-dialog-autofocus', '');
  dialog.append(cancel, confirm); h.document.body.append(opener, dialog); opener.focus();
  const binding = h.context.window.AnimaUI.bindDialog(dialog, fn => h.ticks.push(fn));
  binding.setOpen(true); binding.setOpen(false); h.flush();
  assert.equal(dialog.opens || 0, 0, 'a cancelled opening must not revive later');
  binding.setOpen(true); h.flush();
  assert.equal(h.document.activeElement, cancel);
  confirm.focus(); assert.equal(dialog.fire('keydown', { key: 'Tab' }).event.defaultPrevented, true);
  assert.equal(h.document.activeElement, cancel);
  dialog.fire('keydown', { key: 'Tab', shiftKey: true }); assert.equal(h.document.activeElement, confirm);
  dialog.addEventListener('dialog-close', () => binding.setOpen(false));
  dialog.fire('keydown', { key: 'Escape', isComposing: true }); assert.equal(dialog.open, true);
  dialog.fire('keydown', { key: 'Escape', defaultPrevented: true }); assert.equal(dialog.open, true);
  assert.equal(dialog.fire('keydown', { key: 'Escape' }).event.defaultPrevented, true); h.flush();
  assert.equal(dialog.open, false); assert.equal(h.document.activeElement, opener);
  binding.setOpen(true); h.flush();
  assert.equal(dialog.fire('cancel').event.defaultPrevented, true); h.flush();
  assert.equal(dialog.open, false); assert.equal(h.document.activeElement, opener);
  binding.destroy();
});

test('closing one dialog does not steal focus from a newly opened dialog', () => {
  const h = uiHarness();
  const first = new h.Element('dialog'), second = new h.Element('dialog'), target = new h.Element('button');
  first.append(new h.Element('button')); second.append(target); h.document.body.append(first, second);
  const ui = h.context.window.AnimaUI;
  const a = ui.bindDialog(first, fn => h.ticks.push(fn)), b = ui.bindDialog(second, fn => h.ticks.push(fn));
  a.setOpen(true); h.flush(); a.setOpen(false); b.setOpen(true); h.flush();
  assert.equal(ui.topDialog(), second); assert.equal(h.document.activeElement, target);
  b.setOpen(false); h.flush(); assert.equal(ui.topDialog(), null);
});

test('closing a dialog dismisses its open child menus before it can be reopened', () => {
  const h = uiHarness(), dialog = new h.Element('dialog'), popup = new h.Element();
  h.document.body.append(dialog); dialog.append(popup);
  const ui = h.context.window.AnimaUI;
  const binding = ui.bindDialog(dialog, fn => h.ticks.push(fn));
  binding.setOpen(true); h.flush();
  let popupOpen = true;
  ui.registerPopup(popup, () => { popupOpen = false; });
  binding.setOpen(false); binding.setOpen(true); h.flush();
  assert.equal(dialog.open, true); assert.equal(popupOpen, false);
});

function notifications() {
  const h = uiHarness(), container = new h.Element(); h.document.body.append(container);
  const center = h.context.window.AnimaUI.createNotifications(container, (_, fallback) => fallback);
  return { ...h, container, center };
}

test('errors persist while warnings and ordinary feedback expire', () => {
  const h = notifications();
  const error = h.center.show('Request failed', 'error');
  const warning = h.center.show('Input needs attention', 'warning');
  const success = h.center.show('Saved', 'success');
  h.advance(2950);
  assert.equal(warning.isConnected, true); assert.equal(success.isConnected, false);
  h.advance(100000);
  assert.equal(error.isConnected, true); assert.equal(warning.isConnected, false);
  assert.ok(error.querySelector('.toast-copy')); assert.ok(error.querySelector('.toast-close'));
});

test('notification lifetime pauses under pointer and keyboard focus and resumes its remainder', () => {
  const h = notifications(), node = h.center.show('Saved', 'success');
  h.advance(1000); node.fire('mouseenter'); node.fire('focusin'); h.advance(10000);
  node.fire('mouseleave'); h.advance(10000); assert.equal(node.isConnected, true, 'keyboard focus still pauses expiry');
  node.fire('focusout', { relatedTarget: h.document.body }); h.advance(1799);
  assert.equal(node.isConnected, true); h.advance(151); assert.equal(node.isConnected, false);
});

test('all notifications appear immediately and identical messages remain independent', () => {
  const h = notifications();
  const first = h.center.show('Network failed', 'error'), second = h.center.show('Network failed', 'error');
  const third = h.center.show('Saved', 'success'), fourth = h.center.show('Check input', 'warning');
  assert.notEqual(first, second);
  for (const node of [first, second, third, fourth]) {
    assert.equal(node.hidden, false); assert.equal(node.isConnected, true);
  }
  assert.equal(h.container.querySelector('.toast-more'), null);
  assert.equal(h.container.querySelector('.toast-repeat'), null);
  first.querySelector('.toast-close').fire('click'); h.advance(150);
  assert.equal(first.isConnected, false); assert.equal(second.isConnected, true);
});

test('a keyed connection error can be replaced and dismissed on reconnection', () => {
  const h = notifications();
  const old = h.center.show('Disconnected', 'error', { key: 'backend-disconnected' });
  const current = h.center.show('Disconnected', 'error', { key: 'backend-disconnected' }); h.advance(150);
  assert.equal(old.isConnected, false);
  assert.equal(h.container.querySelectorAll('.toast').length, 1);
  h.center.dismiss('backend-disconnected'); h.advance(150);
  assert.equal(current.isConnected, false);
});

test('select exit can be reversed immediately and Escape is consumed by the select', () => {
  const h = uiHarness(); loadFrontend('anima-select', h.context); h.listeners.get('alpine:init')();
  const root = new h.Element(), trigger = new h.Element('button'), popup = new h.Element();
  trigger.className = 'anima-select-trigger'; popup.className = 'anima-select-menu';
  root.append(trigger, popup); h.document.body.append(root);
  const animations = [];
  popup.animate = () => { const animation = { cancel() { this.cancelled = true; } }; animations.push(animation); return animation; };
  const select = Object.assign(h.factories.animaSelect({ options: [{ v: 'a', l: 'A' }, { v: 'b', l: 'B' }] }, 'a'), {
    $el: root, $nextTick: fn => h.ticks.push(fn),
  });
  select.open = true; select.close(); assert.equal(popup.inert, true);
  select.toggle(); h.flush();
  assert.equal(animations[0].cancelled, true); assert.equal(animations[0].onfinish, null);
  assert.equal(select.open, true); assert.equal(popup.inert, false);
  const escape = { key: 'Escape', target: trigger, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  select.onKeydown(escape);
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true);
  const secondEscape = { ...escape, prevented: false, stopped: false };
  select.onKeydown(secondEscape);
  assert.equal(secondEscape.prevented, false, 'the closing animation must not swallow a second Escape');
  assert.equal(secondEscape.stopped, false);
});

test('reduced motion removes dismissed feedback without waiting for an animation', () => {
  const h = notifications(); h.context.window.matchMedia = () => ({ matches: true });
  const node = h.center.show('Failed', 'error', { key: 'reduced-motion' });
  h.center.dismiss('reduced-motion'); assert.equal(node.isConnected, false);
});

test('copy details includes both the summary and full details as plain text', async () => {
  const h = notifications(); let copied;
  h.context.navigator.clipboard.writeText = async value => { copied = value; };
  const node = h.center.show('File check failed', 'error', { details: '<model>\nFull diagnostic' });
  await Promise.all(node.querySelector('.toast-copy').fire('click').results);
  assert.equal(copied, 'File check failed\n\n<model>\nFull diagnostic');
  assert.equal(node.querySelector('.toast-copy').textContent, 'Copied');
});

test('fast loads do not flash progress and stale completion cannot finish a newer load', () => {
  const h = uiHarness(); loadFrontend('app', h.context); h.listeners.get('alpine:init')();
  const app = h.factories.animaApp();
  app.startProgress(); app.finishProgress(); h.advance(1000); assert.equal(app.progressPercent, 0);
  app.startProgress(); h.advance(180); assert.equal(app.progressPercent, 8);
  app.finishProgress(); app.startProgress(); h.advance(120); assert.equal(app.progressPercent, 0);
  h.advance(60); assert.equal(app.progressPercent, 8);
  app.finishProgress(); h.advance(120); assert.equal(app.progressPercent, 100);
  h.advance(200); assert.equal(app.progressPercent, 0);
});
