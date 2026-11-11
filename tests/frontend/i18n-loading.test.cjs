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

test('bootstrap waits for active messages before loading Alpine and then preloads other languages', async () => {
  const h = runtime('zh-CN');
  loadFrontend(['app/bootstrap'], h.context);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].locale, 'zh-CN');
  assert.equal(h.scripts.length, 0);
  h.respond('zh-CN', '中文');
  await h.i18n.ready;
  await Promise.resolve();
  assert.equal(h.i18n.t('common.label'), '中文');
  assert.equal(h.i18n.getLocale(), 'zh-CN');
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, '/anima-ui/js/vendor/alpine.min.js');
  assert.deepEqual(h.requests.map(request => request.locale), ['zh-CN', 'en-US', 'ja-JP']);
});

test('switching to a language already preloading shares its request and commits only the newest selection', async () => {
  const h = runtime(); h.respond('en-US'); await h.i18n.ready;
  const first = h.i18n.setLocale('zh-CN'), second = h.i18n.setLocale('zh-CN');
  await Promise.resolve();
  assert.equal(h.requests.filter(request => request.locale === 'zh-CN').length, 1);
  h.respond('zh-CN');
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(h.events.length, 1);
  assert.equal(h.storage.get('anima-locale'), 'zh-CN');
});

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

test('choosing the current language cancels a pending different language', async () => {
  const h = runtime(); h.respond('en-US'); await h.i18n.ready;
  const older = h.i18n.setLocale('zh-CN'); await Promise.resolve();
  assert.equal(await h.i18n.setLocale('en-US'), true);
  h.respond('zh-CN'); assert.equal(await older, false);
  assert.equal(h.i18n.getLocale(), 'en-US');
  assert.equal(h.events.length, 0);
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

test('startup falls back to English without persisting a failed preferred locale as successful', async () => {
  const h = runtime('zh-CN'); h.fail('zh-CN');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  h.respond('en-US'); await h.i18n.ready;
  assert.equal(h.i18n.getLocale(), 'en-US');
  assert.equal(h.i18n.t('common.label'), 'en-US');
  assert.equal(h.storage.get('anima-locale'), 'zh-CN');
});

test('English can be retried after all startup loading failed and emits an update for the same locale', async () => {
  const h = runtime(); h.fail('en-US'); await h.i18n.ready;
  assert.equal(h.i18n.t('common.label', 'fallback'), 'fallback');
  const retry = h.i18n.setLocale('en-US'); await Promise.resolve();
  h.respond('en-US', 'recovered'); assert.equal(await retry, true);
  assert.equal(h.i18n.t('common.label'), 'recovered');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].detail.locale, 'en-US');
});

test('native language names are available before loading and survive startup failure and recovery', async () => {
  const h = runtime();
  const expected = [
    { code: 'zh-CN', name: '中文' }, { code: 'en-US', name: 'English' }, { code: 'ja-JP', name: '日本語' },
  ];
  const languages = () => Array.from(h.i18n.getAvailableLocales(), locale => ({ ...locale }));
  assert.deepEqual(languages(), expected);
  h.i18n.getAvailableLocales()[0].name = 'changed';
  assert.deepEqual(languages(), expected, 'callers cannot change the registered names');
  h.fail('en-US'); await h.i18n.ready;
  assert.deepEqual(languages(), expected);
  const retry = h.i18n.setLocale('en-US'); await Promise.resolve();
  h.respond('en-US', 'recovered'); assert.equal(await retry, true);
  assert.deepEqual(languages(), expected);
});
