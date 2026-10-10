// Run from the repository root: node --test tests/frontend/*.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../..');
const locales = ['zh-CN', 'en-US', 'ja-JP'];
const messages = Object.fromEntries(locales.map(locale => [locale,
  JSON.parse(fs.readFileSync(path.join(root, 'frontend/i18n', locale + '.json'), 'utf8'))]));

function boot({ language = 'en-US', saved = null, failures = [] } = {}) {
  const requests = [], preloads = [], events = [];
  const storage = new Map(saved ? [['anima-locale', saved]] : []);
  const localeFromUrl = url => /\/([^/]+)\.json\?/.exec(url)[1];
  const window = { dispatchEvent: event => events.push(event) };
  const context = { window, navigator: { language }, console: { warn() {} },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    XMLHttpRequest: class {
      open(method, url, async) { assert.equal(async, false); this.locale = localeFromUrl(url); }
      send() {
        requests.push(this.locale);
        this.status = failures.includes(this.locale) ? 404 : 200;
        this.responseText = JSON.stringify(messages[this.locale]);
      }
    },
    // Leave preloads pending to exercise switching before they finish.
    fetch: url => { preloads.push(localeFromUrl(url)); return new Promise(() => {}); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'frontend/js/i18n.js'), 'utf8'), context);
  return { api: window.I18N, requests, preloads, storage, events };
}

test('Japanese browser language boots translated content and preloads both other languages', () => {
  const { api, requests, preloads } = boot({ language: 'ja' });
  assert.equal(api.getLocale(), 'ja-JP');
  assert.equal(api.t('common.startTraining'), '学習を開始');
  assert.deepEqual(requests, ['ja-JP']);
  assert.deepEqual(preloads.sort(), ['en-US', 'zh-CN']);
  assert.deepEqual(Array.from(api.getAvailableLocales(), item => item.name), ['中文', 'English', '日本語']);
});

test('saved supported locale overrides browser language; stale preference does not', () => {
  assert.equal(boot({ language: 'zh-CN', saved: 'ja-JP' }).api.getLocale(), 'ja-JP');
  assert.equal(boot({ language: 'ja-JP', saved: 'xx-stale' }).api.getLocale(), 'ja-JP');
  assert.equal(boot({ language: 'fr-FR' }).api.getLocale(), 'en-US');
});

test('early switches load all three languages, emit events and survive reload', () => {
  const { api, storage, events } = boot();
  for (const locale of ['ja-JP', 'zh-CN', 'en-US', 'ja-JP']) {
    api.setLocale(locale);
    assert.equal(api.getLocale(), locale);
    assert.equal(api.t('common.startTraining'), messages[locale].common.startTraining);
    assert.equal(storage.get('anima-locale'), locale);
  }
  assert.deepEqual(events.map(event => event.detail.locale), ['ja-JP', 'zh-CN', 'en-US', 'ja-JP']);
  assert.equal(boot({ language: 'en-US', saved: storage.get('anima-locale') }).api.getLocale(), 'ja-JP');
});

test('failed and unsupported switches preserve displayed language and preference', () => {
  const { api, storage, events } = boot({ saved: 'en-US', failures: ['ja-JP'] });
  api.setLocale('ja-JP');
  api.setLocale('unsupported');
  assert.equal(api.getLocale(), 'en-US');
  assert.equal(api.t('common.startTraining'), 'Start Training');
  assert.equal(storage.get('anima-locale'), 'en-US');
  assert.equal(events.length, 0);
});

test('unavailable startup language falls back to readable English', () => {
  const { api } = boot({ language: 'ja-JP', failures: ['ja-JP'] });
  assert.equal(api.getLocale(), 'en-US');
  assert.equal(api.t('common.startTraining'), 'Start Training');
});

function flatten(value, prefix = '', result = {}) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? prefix + '.' + key : key;
    if (typeof item === 'string') result[name] = item;
    else flatten(item, name, result);
  }
  return result;
}

test('all translations cover the same messages and preserve interpolation placeholders', () => {
  const reference = flatten(messages['en-US']);
  for (const locale of locales) {
    const translated = flatten(messages[locale]);
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(reference).sort(), locale);
    for (const [key, value] of Object.entries(reference)) {
      assert.ok(translated[key].trim(), `${locale}: ${key} is empty`);
      const translatedVariables = translated[key].match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || [];
      const referenceVariables = value.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || [];
      assert.deepEqual([...new Set(translatedVariables)].sort(),
        [...new Set(referenceVariables)].sort(), `${locale}: ${key}`);
      if (locale === 'ja-JP') assert.deepEqual(translatedVariables.sort(), referenceVariables.sort(), key);
    }
  }
});
