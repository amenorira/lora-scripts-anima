const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readScript(name, context) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', name), 'utf8'), context);
}

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

test('application navigation confirms before pushing a history entry', () => {
  let register;
  const timers = [];
  const entries = [{ hash: '#tagEditor', state: { animaRoute: 'tagEditor', animaIndex: 0 } }];
  const location = { hash: '#tagEditor' };
  const context = {
    document: { addEventListener(_, callback) { register = callback; } },
    window: { location, history: {
      get state() { return entries.at(-1).state; },
      pushState(state, _, hash) { entries.push({ state, hash }); location.hash = hash; },
    } },
    Alpine: { data(_, factory) { context.factory = factory; } },
    ROUTE_CONFIG: { tagEditor: {}, history: {} },
    setTimeout(callback) { timers.push(callback); },
  };
  readScript('app.js', context);
  register();
  const app = context.factory();
  app.currentRoute = 'tagEditor';
  app._teHasUnsavedEdits = () => true;
  let confirm;
  app._teConfirmUnsaved = (_, callback) => { confirm = callback; };
  app.t = key => key;
  app.startProgress = () => {};
  app.navigate('history');
  assert.equal(entries.length, 1);
  confirm();
  assert.equal(entries.length, 2);
  assert.equal(entries[1].hash, '#history');
});

test('Alpine invokes the app init hook once', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
  assert.match(html, /<body x-data="animaApp\(\)" x-cloak>/);
  assert.doesNotMatch(html, /<body[^>]*x-init="init\(\)"/);
});

test('custom select keyboard navigation skips disabled choices and keeps value on Escape', () => {
  let register;
  const context = {
    document: { addEventListener(_, callback) { register = callback; } },
    Alpine: { data(_, factory) { context.factory = factory; } },
  };
  readScript('anima-select.js', context);
  register();
  const select = context.factory({ options: [
    { v: 'a', l: 'A' }, { v: 'b', l: 'B', disabled: true }, { v: 'c', l: 'C' },
  ] }, 'a');
  select.$nextTick = () => {};
  select.positionMenu = () => {};
  select._syncOptionA11y = () => {};
  select.close = () => { select.open = false; };
  const press = key => select.onKeydown({ key, target: { closest: () => true, disabled: false, focus() {} }, preventDefault() {} });
  press('End');
  assert.equal(select.activeIndex, 2);
  press('Home');
  assert.equal(select.activeIndex, 0);
  press('ArrowDown');
  assert.equal(select.activeIndex, 2);
  press('Escape');
  assert.equal(select.open, false);
  assert.equal(select.value, 'a');
});

test('closed custom selects do not retain global scroll and resize listeners', () => {
  let register;
  const globalListeners = new Map();
  const context = {
    document: { addEventListener(_, callback) { register = callback; } },
    window: {
      addEventListener(name, callback) { globalListeners.set(name, callback); },
      removeEventListener(name, callback) {
        if (globalListeners.get(name) === callback) globalListeners.delete(name);
      },
    },
    Alpine: { data(_, factory) { context.factory = factory; } },
  };
  readScript('anima-select.js', context);
  register();
  const select = context.factory({ options: [{ v: 'a', l: 'A' }] }, 'a');
  const trigger = { setAttribute() {} };
  let openWatcher;
  select.$el = {
    querySelector() { return trigger; },
    addEventListener() {}, removeEventListener() {},
  };
  select.$refs = {};
  select.$watch = (_, callback) => { openWatcher = callback; };
  select.$nextTick = () => {};
  select.init();
  assert.equal(globalListeners.size, 0);
  select.open = true;
  openWatcher(true);
  assert.deepEqual(Array.from(globalListeners.keys()), ['scroll', 'resize']);
  select.open = false;
  openWatcher(false);
  assert.equal(globalListeners.size, 0);
  select.destroy();
});

test('file picker opens before scan and ignores a response after closing', async () => {
  const pending = [];
  const context = {
    window: {},
    document: { getElementById() { return null; }, querySelector() { return null; } },
    fetch(url) { return new Promise(resolve => pending.push({ url, resolve })); },
  };
  readScript('training-core.js', context);
  const app = Object.assign({}, context.window.trainingCoreMixin, {
    form: { pretrained_model_name_or_path: '' },
    $nextTick(callback) { callback(); },
    t: key => key,
  });
  const request = app.builtinFilePicker('pretrained_model_name_or_path', 'file-model');
  assert.equal(app.showFilePickerModalFlag, true);
  assert.equal(app._pickerLoading, true);
  assert.equal(pending[0].url, '/api/get_files?pick_type=model-file');
  app.closeFilePickerModal();
  pending[0].resolve({ ok: true, json: async () => ({ status: 'success', data: { files: [{ path: 'old' }] } }) });
  await request;
  assert.deepEqual(Array.from(app._pickerFiles), []);
  assert.equal(app.showFilePickerModalFlag, false);
  assert.equal(app._pickerLoading, false);
});

test('training launch reports API failures as errors', async () => {
  const context = { window: { getVisibleSections: () => [] } };
  readScript('training-toml.js', context);
  const notices = [];
  const app = Object.assign({}, context.window.trainingTomlMixin, {
    form: { model_train_type: 'sdxl-lora' },
    isTraining: false,
    trainingStarting: false,
    validateForm: () => true,
    refreshOutputPathInfo: async () => ({ available: true, writable: true, path_is_directory: true }),
    refreshStepEstimate: async () => ({}),
    _coerceNum: value => value,
    _buildOptimizerArgs: () => [],
    _collectTrainingFormSnapshot: () => ({}),
    _applyTaskView() {},
    toast(...args) { notices.push(args); },
    t: key => key,
  });
  context.fetch = async () => ({ ok: false, json: async () => ({ status: 'error', message: 'busy' }) });
  await app.startTraining();
  assert.deepEqual(notices.pop(), ['busy', 'error']);
  assert.equal(app.trainingStarting, false);
});
