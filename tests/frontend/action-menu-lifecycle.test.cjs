const test = require('node:test');
const assert = require('node:assert/strict');
const { uiHarness } = require('./ui-helpers.cjs');

function menuHarness() {
  const h = uiHarness(), root = new h.Element(), trigger = new h.Element('button');
  h.document.body.appendChild(root); root.appendChild(trigger);
  const menu = h.factories.actionMenu();
  Object.assign(menu, { $el: root, $refs: { trigger }, $nextTick: callback => h.ticks.push(callback) });
  menu.init();
  return { ...h, menu, root, trigger,
    mount() {
      const popup = new h.Element(), first = new h.Element('button'), last = new h.Element('button');
      first.setAttribute('role', 'menuitem'); last.setAttribute('role', 'menuitem');
      popup.append(first, last); root.appendChild(popup); menu.$refs.menu = popup;
      return { popup, first, last };
    },
  };
}

test('first keyboard opening waits for lazy refs and reopening retains the mounted menu', () => {
  const h = menuHarness();
  assert.equal(h.menu.mounted, false);
  assert.equal(h.menu.items().length, 0);
  h.menu.show(true);
  assert.equal(h.menu.mounted, true);
  h.menu.close(false);
  const { popup, last } = h.mount();
  h.menu.show(true, true); h.flush(); h.advance(16);
  assert.equal(h.document.activeElement, last);
  h.menu.close();
  assert.equal(h.document.activeElement, h.trigger);
  assert.equal(h.menu.mounted, true, 'closing retains the subtree for its CSS exit');
  assert.equal(h.menu.$refs.menu, popup);
});

test('destroy before the first opening settles cannot focus a detached action', () => {
  const h = menuHarness();
  h.menu.show(true); h.mount();
  h.menu.destroy(); h.root.remove(); h.flush(); h.advance(32);
  assert.equal(h.menu.open, false);
  assert.equal(h.document.activeElement, h.document.body);
});
