const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend: readScript } = require('./helpers.cjs');

test('dirty editor preserves Back and Forward entries when navigation is cancelled or accepted', () => {
  let register;
  const timers = [];
  const entries = [
    { hash: '#history', state: { animaRoute: 'history', animaIndex: 0 } },
    { hash: '#tagEditor', state: { animaRoute: 'tagEditor', animaIndex: 1 } },
    { hash: '#settings', state: { animaRoute: 'settings', animaIndex: 2 } },
  ];
  let index = 1;
  let app;
  let confirm;
  const location = { hash: '#tagEditor', href: 'http://local/#tagEditor' };
  const history = {
    get state() { return entries[index].state; },
    replaceState(state) { entries[index].state = state; },
    pushState(state, _, hash) { entries.splice(index + 1); entries.push({ hash, state }); index++; location.hash = hash; },
    go(delta) { index += delta; location.hash = entries[index].hash; if (app) app.handleRoute(); },
  };
  const context = {
    document: { addEventListener(_, callback) { register = callback; } },
    window: { location, history },
    Alpine: { data(_, factory) { context.factory = factory; } },
    ROUTE_CONFIG: { tagEditor: {}, history: {}, settings: {} },
    setTimeout(callback) { timers.push(callback); },
  };
  readScript('app.js', context);
  register();
  app = context.factory();
  app.currentRoute = 'tagEditor';
  app._historyIndex = 1;
  app._teHasUnsavedEdits = () => true;
  app._teConfirmUnsaved = (_, callback) => { confirm = callback; };
  app.t = key => key;
  app.startProgress = () => {};
  app.finishProgress = () => {};
  const commits = [];
  app._commitRoute = route => { commits.push(route); app.currentRoute = route; };

  history.go(-1);
  assert.equal(index, 1);
  assert.equal(location.hash, '#tagEditor');
  assert.deepEqual(entries.map(entry => entry.hash), ['#history', '#tagEditor', '#settings']);
  assert.equal(commits.length, 0);
  confirm();
  timers.splice(0).forEach(callback => callback());
  assert.deepEqual(commits, ['history']);
  assert.equal(index, 0);

  app.currentRoute = 'tagEditor';
  app._historyIndex = 1;
  index = 1;
  location.hash = '#tagEditor';
  history.go(1);
  assert.equal(index, 1);
  confirm();
  timers.splice(0).forEach(callback => callback());
  assert.equal(index, 2);
  assert.equal(commits.at(-1), 'settings');

  app.currentRoute = 'tagEditor';
  app._historyIndex = 1;
  index = 1;
  location.hash = '#tagEditor';
  entries.splice(index + 1);
  entries.push({ hash: '#history', state: null });
  index = 2;
  location.hash = '#history';
  app.handleRoute();
  assert.equal(index, 1);
  assert.equal(entries[2].hash, '#history');
  confirm();
  timers.splice(0).forEach(callback => callback());
  assert.equal(index, 2);
  assert.equal(commits.at(-1), 'history');
  assert.equal(entries[2].state.animaRoute, 'history');
});
