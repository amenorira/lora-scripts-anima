const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, response, deferred } = require('./helpers.cjs');
const { uiHarness } = require('./ui-helpers.cjs');

const refreshByRoute = {
  home: [], settings: [], tensorboard: [], tagEditor: [],
  'train-basic': ['refreshTrainingLocale'],
  'monitor-dashboard': ['renderDashboard'],
  history: ['renderHistory'],
  environment: ['renderEnvironment'],
  docs: ['loadDocsPage'],
  tagger: ['renderTaggerResourceBar'],
  'ai-captioning': ['renderTaggerResourceBar'],
  regularization: ['regRenderControls', 'renderRegularizationResourceBar'],
};

async function localeHarness() {
  const { context, document, Element, factories, listeners } = uiHarness();
  const events = new Element();
  const calls = [];
  let locale = 'zh-CN';
  document.documentElement = new Element('html');
  Object.assign(context.window, {
    location: { hash: '#home' }, history: { state: { animaRoute: 'home' } },
    matchMedia: () => ({ addEventListener() {} }),
    addEventListener: events.addEventListener.bind(events),
    t: key => locale + '/' + key,
  });
  context.I18N = { init() {}, getLocale: () => locale };
  context.localStorage = { getItem: () => null };
  context.fetch = async url => { calls.push(url); return response({}); };
  loadFrontend(['shared/constants', 'app/config', 'app/index'], context);
  context.ROUTE_CONFIG = context.window.ROUTE_CONFIG;
  listeners.get('alpine:init')();
  const app = factories.animaApp();
  const lifecycleMethods = [
    'resolveTheme', 'loadUISettings', '_initPanelResizer', 'startRealtime', 'buildRouteContent',
    'tagEditorLoad', 'buildTaggerForm', 'buildRegularizationForm', 'buildTrainForm',
    'loadHistory', 'startHistoryRefresh', 'buildEnvironmentPage', 'startMonitorRealtime', 'viewRunDetail',
  ];
  for (const method of new Set([...lifecycleMethods, ...Object.values(refreshByRoute).flat()])) {
    app[method] = () => { calls.push(method); };
  }
  await app.init();
  app._regLoaded = true;
  app._trainFormMountedRoute = 'train-basic';
  return {
    app, document, calls, routes: context.ROUTE_CONFIG,
    changeLocale(route) {
      calls.length = 0;
      app.currentRoute = route;
      locale = locale === 'en-US' ? 'ja-JP' : 'en-US';
      events.fire('locale-changed');
      return locale;
    },
    reloadLocale(route) {
      calls.length = 0;
      app.currentRoute = route;
      events.fire('locale-changed');
    },
  };
}

test('locale events translate each route without remounting workspaces or restarting sessions and polling', async () => {
  const { app, document, calls, routes, changeLocale } = await localeHarness();
  assert.deepEqual(Object.keys(refreshByRoute).sort(), Object.keys(routes).sort());
  for (const [route, expected] of Object.entries(refreshByRoute)) {
    const locale = changeLocale(route);
    assert.deepEqual(calls, expected, route);
    assert.equal(app.locale, locale);
    assert.equal(document.documentElement.lang, locale);
    const title = routes[route].titleKey ? locale + '/' + routes[route].titleKey : routes[route].title;
    assert.equal(document.title, title + ' | lora-scripts-anima');
  }
});

test('a locale change while regularization is loading skips its controls and the suspended training form', async () => {
  const { app, calls, changeLocale } = await localeHarness();
  app._regLoaded = false;
  changeLocale('regularization');
  assert.deepEqual(calls, ['renderRegularizationResourceBar']);
});

test('recovering the same locale refreshes messages and invalidates suspended training text', async () => {
  const { app, calls, reloadLocale } = await localeHarness();
  app._trainFormLocale = app.locale;
  const revision = app.localeRevision;
  reloadLocale('train-basic');
  assert.equal(app.localeRevision, revision + 1);
  assert.equal(app._trainFormLocale, '');
  assert.deepEqual(calls, ['refreshTrainingLocale']);
});

for (const pauseAt of ['/api/version', '/api/file_picker_available']) {
  test(`a language selection during ${pauseAt} updates immediately and mounts the route once in that language`, async () => {
    const { context, document, Element, factories, listeners } = uiHarness();
    const events = new Element(), gate = deferred(), entered = deferred();
    const mountedLocales = [], refreshed = [];
    document.documentElement = new Element('html');
    Object.assign(context.window, {
      location: { hash: '#train-basic' }, history: { state: { animaRoute: 'train-basic' } },
      matchMedia: () => ({ addEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });
    context.localStorage = { getItem: () => null, setItem() {} };
    context.navigator.language = 'en-US';
    context.fetch = async url => {
      if (url.endsWith('.json')) return { ok: true, json: async () => ({ nav: { loraTraining: url } }) };
      if (url === pauseAt) { entered.resolve(); return gate.promise; }
      return response({});
    };
    loadFrontend(['shared/i18n', 'shared/constants', 'app/config', 'app/index'], context);
    await context.window.I18N.ready;
    context.ROUTE_CONFIG = context.window.ROUTE_CONFIG;
    listeners.get('alpine:init')();
    const app = factories.animaApp();
    for (const name of ['resolveTheme', 'loadUISettings', '_initPanelResizer', 'startRealtime']) app[name] = () => {};
    app.buildRouteContent = () => mountedLocales.push(app.locale);
    app.refreshRouteLocale = route => refreshed.push(route);
    const initializing = app.init();
    await entered.promise;
    await app.onLocaleChange('ja-JP');
    assert.equal(app.locale, 'ja-JP');
    assert.equal(document.documentElement.lang, 'ja-JP');
    assert.equal(app.localeRevision, 1);
    assert.equal(refreshed.length, 0, 'startup language changes must not mount a workspace early');
    assert.equal(mountedLocales.length, 0);
    gate.resolve(response({}));
    await initializing;
    assert.equal(context.window.I18N.getLocale(), app.locale);
    assert.deepEqual(mountedLocales, ['ja-JP']);
    assert.equal(refreshed.length, 0);
  });
}
