const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred} = require('./helpers.cjs');

test('environment refreshes prevent overlapping requests but keep fast feedback visible', async () => {
  const timers = [];
  const {window} = loadFrontend(['shared/utils', 'environment/render'], {
    window: {},
    setTimeout(fn, ms) { const timer = {fn, ms, cancelled: false}; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
  });
  const requests = [];
  const app = composeMixins(window.utilsMixin, window.environmentRenderMixin, {
    _syncEnvRefreshButtons() {},
    xfRefresh() { const request = deferred(); requests.push(request); return request.promise; },
  });
  const first = app._envRefresh('xf');
  await app._envRefresh('xf');
  assert.equal(requests.length, 1);
  assert.equal(app._envRefreshInFlight.xf, true);
  assert.equal(app.envxfRefreshFeedback, true);
  requests[0].resolve();
  await first;
  assert.equal(app._envRefreshInFlight.xf, undefined);
  assert.equal(app.envxfRefreshFeedback, true);
  const second = app._envRefresh('xf');
  assert.equal(requests.length, 2);
  assert.equal(timers[0].cancelled, true);
  assert.equal(timers[1].ms, 800);
  timers[1].fn();
  assert.equal(app.envxfRefreshFeedback, false);
  assert.equal(app._envRefreshInFlight.xf, true);
  requests[1].resolve();
  await second;
});

test('environment refresh all and individual refreshes cannot issue overlapping checks', async () => {
  const {window} = loadFrontend(['environment/render'], {window: {}});
  const requests = [];
  const app = composeMixins(window.environmentRenderMixin, {
    _showRefreshFeedback() {}, _syncEnvRefreshButtons() {}, environmentLoading: true,
    xfRefresh() { const request = deferred(); requests.push(['xf', request]); return request.promise; },
    _envRefreshAll() { const request = deferred(); requests.push(['all', request]); return request.promise; },
  });
  await app._envRefresh('xf');
  assert.equal(requests.length, 0); // The initial environment check is still running.
  app.environmentLoading = false;
  const single = app._envRefresh('xf');
  assert.equal(app._envRefreshBlocked('all'), true);
  await app._envRefresh('all');
  assert.deepEqual(requests.map(([kind]) => kind), ['xf']);
  requests[0][1].resolve();
  await single;
  const all = app._envRefresh('all');
  assert.equal(app._envRefreshBlocked('xf'), true);
  await app._envRefresh('xf');
  assert.deepEqual(requests.map(([kind]) => kind), ['xf', 'all']);
  requests[1][1].resolve();
  await all;
});

test('a rebuilt environment refresh button reflects its in-flight state', () => {
  const {window} = loadFrontend(['environment/render'], {window: {}});
  const attrs = {}, classes = new Set();
  const button = {
    dataset: {envRefresh: 'xf'}, disabled: false,
    classList: {toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }},
    setAttribute(name, value) { attrs[name] = value; },
  };
  const host = {querySelectorAll: () => [button]};
  const app = composeMixins(window.environmentRenderMixin, {_envRefreshInFlight: {xf: true}});
  app._syncEnvRefreshButtons(host);
  assert.equal(classes.has('is-loading'), true);
  assert.equal(attrs['aria-busy'], 'true');
  assert.equal(attrs['aria-disabled'], 'true');
  app._envRefreshInFlight.xf = false;
  app._syncEnvRefreshButtons(host);
  assert.equal(classes.has('is-loading'), false);
  assert.equal(attrs['aria-busy'], 'false');
});

test('environment refresh state is synchronized even if no slot markup changed', () => {
  const attrs = {}, classes = new Set();
  const button = {
    dataset: {envRefresh: 'all'}, disabled: false,
    classList: {toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }},
    setAttribute(name, value) { attrs[name] = value; },
  };
  const slot = {};
  const page = {querySelector: () => slot, querySelectorAll: () => [button]};
  const {window} = loadFrontend(['environment/render'], {window: {}, document: {getElementById: () => page}});
  const app = composeMixins(window.environmentRenderMixin, {
    _environmentRenderFrame: null, _envTabsBound: true, environmentLoading: true,
    _envSlotHtml: Object.fromEntries(['overview','xf','fa','triton','mossAccel','sd','lycoris','musubi','animaModel','krea2','moss','trainUse','dictionary'].map(key => [key, ''])),
    _ensureEnvSkeleton() {}, _updateEnvSectionTitles() {}, _syncEnvTabDom() {}, _observeEnvModelLayout() {}, t: key => key,
  });
  for (const method of ['_renderOverview','_renderXfRow','_renderFaRow','_renderTritonRow','_renderMossAccelRow','_renderSdRow','_renderLycorisRow','_renderMusubiRow','_renderModelGroup','_renderDictionaryRow']) app[method] = () => '';
  app.renderEnvironment();
  assert.equal(attrs['aria-busy'], 'true');
  app.environmentLoading = false;
  app.renderEnvironment();
  assert.equal(attrs['aria-busy'], 'false');
  assert.equal(classes.has('is-loading'), false);
});

test('rebuilt environment logs follow the bottom only when the user was already there', () => {
  const {window} = loadFrontend(['environment/render'], {window: {}});
  const logs = [{scrollHeight: 1000, scrollTop: 0}, {scrollHeight: 800, scrollTop: 0}, {scrollHeight: 400, scrollTop: 0}];
  const app = composeMixins(window.environmentRenderMixin);
  app._restoreEnvLogs({querySelectorAll: () => logs}, [{top: 120, following: false}, {top: 300, following: true}]);
  assert.deepEqual(logs.map(log => log.scrollTop), [120, 800, 400]);
});
