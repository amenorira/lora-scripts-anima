const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

test('resource bar refreshes translated labels when messages recover in the same locale', () => {
  const bar = { dataset: {}, firstElementChild: {}, querySelector: () => null, innerHTML: '' };
  const { window } = loadFrontend(['monitor/resource-bar'], { window: {}, document: { getElementById: () => bar } });
  const renderer = Object.assign({}, window.resourceBar, { _patchResbar() {} });
  let prefix = 'missing';
  const options = { sys: { cpu_name: 'CPU', cpu_pct: 0, ram_pct: 0, ram_used_gb: 1, ram_total_gb: 8 }, t: key => prefix + ':' + key, locale: 'en-US' };
  renderer.render('resource', options);
  const original = bar.innerHTML;
  prefix = 'recovered'; renderer.render('resource', options);
  assert.equal(bar.innerHTML, original, 'unchanged versions retain the structure');
  renderer.render('resource', { ...options, localeRevision: 1 });
  assert.match(bar.innerHTML, /recovered:/);
  assert.doesNotMatch(bar.innerHTML, /missing:/);
});

test('monitor shell and history labels refresh after same-language messages recover', () => {
  const dashboard = {}, history = {};
  const { window } = loadFrontend(['monitor/render'], {
    window: {}, document: { getElementById: id => ({ monitorDashboard: dashboard, monitorHistoryContext: history })[id] },
    requestAnimationFrame() {},
  });
  let prefix = 'missing';
  const app = Object.assign({}, window.monitorRenderMixin, {
    locale: 'en-US', localeRevision: 0, selectedRunDir: 'history', runDetailData: {},
    previews: [], logTotal: 0, outputTabCount: 0,
    tMonitor: key => prefix + ':' + key,
    _previewLightboxHtml: translate => translate('preview'),
    _historyBannerHtml: (_data, translate) => translate('history'),
    _renderTab() {}, closePreviewLightbox() {},
  });
  app.renderDashboard();
  prefix = 'recovered'; app.localeRevision++;
  app.renderDashboard();
  assert.match(dashboard.innerHTML, /recovered:preview/);
  assert.equal(history.innerHTML, 'recovered:history');
});
