const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, deferred } = require('./helpers.cjs');

function runtime(saved = 'en-US') {
  const requests = [], events = [], scripts = [];
  const storage = new Map(saved ? [['anima-locale', saved]] : []);
  const context = loadFrontend(['shared/i18n'], {
    window: { dispatchEvent: event => events.push(event) },
    document: { createElement: () => ({}), head: { appendChild: script => scripts.push(script) } },
    navigator: { language: 'en-US' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    console: { warn() {} },
    fetch(url) {
      const pending = deferred();
      requests.push({ locale: url.match(/([^/]+)\.json$/)[1], pending, settled: false });
      return pending.promise;
    },
  });
  const take = locale => {
    const request = requests.find(request => request.locale === locale && !request.settled);
    assert.ok(request, 'expected pending request for ' + locale);
    request.settled = true;
    return request.pending;
  };
  return { context, i18n: context.window.I18N, requests, events, scripts, storage,
    respond(locale, label = locale) { take(locale).resolve({ ok: true, json: async () => ({ common: { label } }) }); },
    fail(locale) { take(locale).resolve({ ok: false, status: 503 }); },
  };
}


test('out-of-order language responses cannot overwrite a later choice', async () => {
  const h = runtime(); h.respond('en-US'); await h.i18n.ready;
  const older = h.i18n.setLocale('zh-CN');
  await Promise.resolve();
  const newer = h.i18n.setLocale('ja-JP');
  await Promise.resolve();
  h.respond('ja-JP'); assert.equal(await newer, true);
  h.respond('zh-CN'); assert.equal(await older, false);
  assert.equal(h.i18n.getLocale(), 'ja-JP');
  assert.equal(h.i18n.t('common.label'), 'ja-JP');
  assert.equal(h.events.length, 1);
});


test('a failed selection preserves current messages and can retry without a poisoned pending request', async () => {
  const h = runtime(); h.respond('en-US'); await h.i18n.ready;
  const failure = h.i18n.setLocale('zh-CN'); await Promise.resolve();
  h.fail('zh-CN'); assert.equal(await failure, false);
  assert.equal(h.i18n.t('common.label'), 'en-US');
  assert.equal(h.events.length, 0);
  const retry = h.i18n.setLocale('zh-CN'); await Promise.resolve();
  assert.equal(h.requests.filter(request => request.locale === 'zh-CN').length, 2);
  h.respond('zh-CN'); assert.equal(await retry, true);
});
