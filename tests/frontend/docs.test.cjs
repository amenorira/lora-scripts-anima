const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, readRepo, response } = require('./helpers.cjs');

test('document titles follow the UI language when loading and restoring cached content', async () => {
  const dictionaries = Object.fromEntries(['zh-CN', 'en-US', 'ja-JP'].map(locale =>
    [locale, JSON.parse(readRepo(`frontend/i18n/${locale}.json`))]));
  const page = {title: ''};
  let contentRequests = 0;
  const { window } = loadFrontend(['docs/index'], {
    window: {}, document: page, AbortController,
    fetch: async url => {
      const parsed = new URL(url, 'http://fixture');
      const locale = parsed.searchParams.get('locale');
      if (parsed.pathname === '/api/docs') {
        return response({locale, documents: [{slug: 'optimizers', category: 'optimizer'}]});
      }
      contentRequests++;
      return response({slug: 'optimizers', locale, html: '<h1>Guide</h1>', toc: ''});
    },
  });
  const app = composeMixins(window.docsMixin, {
    currentRoute: 'docs', $nextTick() {},
    t(key, fallback) {
      return key.split('.').reduce((value, part) => value?.[part], dictionaries[this.locale]) ?? fallback ?? key;
    },
  });
  for (const locale of ['zh-CN', 'en-US', 'ja-JP', 'zh-CN']) {
    app.locale = locale;
    await app.loadDocsPage();
    const title = dictionaries[locale].docs.documents.optimizers.title;
    assert.equal(app.docsDocumentTitle(app.docsSelectedSlug), title);
    assert.equal(page.title, title + ' | lora-scripts-anima');
    assert.equal(app.docsHtml, '<h1>Guide</h1>');
  }
  assert.equal(contentRequests, 3);
  assert.equal(app.docsDocumentTitle('future-guide'), 'future-guide');
});
