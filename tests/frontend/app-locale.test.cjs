const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, response } = require('./helpers.cjs');
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
