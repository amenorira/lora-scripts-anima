// Run from the repository root: node --test tests/frontend/*.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readRepo } = require('./helpers.cjs');
const locales = ['zh-CN', 'en-US', 'ja-JP'];
const messages = Object.fromEntries(locales.map(locale => [locale,
  JSON.parse(readRepo(`frontend/i18n/${locale}.json`))]));

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
