const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, deferred, response } = require('./helpers.cjs');

function router(dirty) {
  let factory, confirm, cleaned = false;
  const window = { location: { hash: '#tagEditor' }, history: { state: {}, pushState() {} } };
  const document = { addEventListener(_event, callback) { callback(); }, getElementById: () => null };
  loadFrontend('app/index', {
    window, document, Alpine: { data(_name, callback) { factory = callback; } },
    ROUTE_CONFIG: { settings: { title: 'Settings' } }, setTimeout, clearTimeout,
  });
  window.composeAppMixins = () => {};
  const app = factory();
  Object.assign(app, {
    currentRoute: 'tagEditor', _teHasUnsavedEdits: () => dirty,
    _teConfirmUnsaved(_message, callback) { confirm = callback; },
    cancelHistoryInteractions() {}, startProgress() {}, t: key => key,
    tagEditorCleanup() { cleaned = true; }, buildRouteContent() {}, $nextTick() {},
  });
  return { app, confirmed: () => confirm?.(), cleaned: () => cleaned };
}

test('leaving a clean tag editor commits in the same turn as the unsaved check', () => {
  const { app, cleaned } = router(false);
  app.navigate('settings');
  assert.equal(app.currentRoute, 'settings');
  assert.equal(cleaned(), true);
});

test('leaving a dirty tag editor still waits for confirmation', () => {
  const { app, confirmed, cleaned } = router(true);
  app.navigate('settings');
  assert.equal(app.currentRoute, 'tagEditor');
  assert.equal(cleaned(), false);
  confirmed();
  assert.equal(app.currentRoute, 'settings');
  assert.equal(cleaned(), true);
});

test('dashboard refresh restores the server instance before loading its details', async () => {
  const detail = deferred(), applied = [];
  let alpineInit, factory;
  const window = {
    location: { hash: '#monitor-dashboard', href: 'http://localhost/#monitor-dashboard' },
    history: { state: {}, replaceState() {} }, TRAIN_SECTIONS: [],
    addEventListener() {}, matchMedia: () => ({ addEventListener() {} }),
  };
  const document = {
    documentElement: {}, getElementById: () => null,
    addEventListener(event, callback) { if (event === 'alpine:init') alpineInit = callback; },
  };
  loadFrontend(['shared/realtime', 'monitor/core', 'app/index'], {
    window, document, Alpine: { data(_name, callback) { factory = callback; } },
    I18N: { getLocale: () => 'en-US' }, ROUTE_CONFIG: { 'monitor-dashboard': { title: 'Monitor' } },
    sessionStorage: { getItem: () => 'instance-1' }, localStorage: { getItem: () => null },
    URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 1,
    fetch: url => url === '/api/realtime/monitor-detail' ? detail.promise : Promise.resolve(response({})),
  });
  alpineInit();
  window.composeAppMixins = (target, sources) => {
    for (const source of [sources.realtime, sources.monitorCore]) Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
  };
  const app = factory();
  Object.assign(app, {
    t: key => key, resolveTheme() {}, loadUISettings() {}, _initPanelResizer() {},
    _connectRealtimeNow() {}, _scheduleTrainingStatePoll() {}, stopHistoryRefresh() {},
    stopTaggerWorkspace() {}, stopRegularizationWorkspace() {}, stopMonitorRealtime() {},
    _startMonitorClock() {}, startProgress() {}, renderDashboard() {},
    applyRealtimeMonitorSnapshot: data => applied.push(data),
  });
  app.init();
  detail.resolve(response({ server_instance_id: 'instance-1', monitor: { detail: true } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.realtimeInstanceId, 'instance-1');
  assert.equal(applied.length, 1);
});
