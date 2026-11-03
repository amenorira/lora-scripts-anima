const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, readRepo, response, deferred } = require('./helpers.cjs');

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

test('relative guide links open the corresponding document and anchor', () => {
  const { window } = loadFrontend(['docs/index']);
  const calls = [];
  const app = composeMixins(window.docsMixin, {
    selectParameterDoc(slug, anchor) { calls.push([slug, anchor]); },
  });
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    let prevented = false;
    app.handleDocsContentClick({
      target: { closest: () => ({ getAttribute: () => `timesteps.${locale}.md#comparison-method` }) },
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.match(readRepo(`docs/parameters/timesteps.${locale}.md`), /id="comparison-method"/);
  }
  assert.deepEqual(calls, Array(3).fill(['timesteps', 'comparison-method']));
});

test('field guides stay on the configuration route and reuse document content without changing the full reader', async () => {
  const requests = [];
  const { window } = loadFrontend(['docs/index'], {
    window: {}, AbortController,
    fetch: async url => {
      requests.push(url);
      return response({ slug: 'optimizers', html: 'optimizer guide' });
    },
  });
  const app = composeMixins(window.docsMixin, {
    currentRoute: 'train-anima', locale: 'ja-JP', docsSelectedSlug: 'lora-plus', docsHtml: 'full reader',
    $nextTick() {}, t: key => key,
    _parameterDocSection(html, anchor) { return html + ':' + anchor; },
    navigate() { assert.fail('Field guides must keep the current route'); },
  });
  await app.openParameterDoc('optimizers', 'weight-decay');
  assert.equal(app.parameterDocOpen, true);
  assert.equal(app.parameterDocHtml, 'optimizer guide:weight-decay');
  assert.equal(app.parameterDocLoading, false);
  assert.equal(app.docsSelectedSlug, 'lora-plus');
  assert.equal(app.docsHtml, 'full reader');
  app.closeParameterDoc();
  assert.equal(app.parameterDocOpen, false);
  await app.openParameterDoc('optimizers', 'betas');
  assert.equal(app.parameterDocHtml, 'optimizer guide:betas');
  assert.deepEqual(requests, ['/api/docs/optimizers?locale=ja-JP']);
});

test('switching or closing a field guide ignores stale responses', async () => {
  const requests = [];
  const { window } = loadFrontend(['docs/index'], {
    window: {}, AbortController,
    fetch(url, { signal }) {
      const pending = deferred();
      requests.push({ ...pending, signal });
      return pending.promise;
    },
  });
  const app = composeMixins(window.docsMixin, {
    currentRoute: 'train-anima', $nextTick() {}, t: key => key,
    _parameterDocSection: html => html,
  });
  const first = app.openParameterDoc('optimizers', 'weight-decay');
  const second = app.openParameterDoc('timesteps', 'sampling');
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(response({ html: 'latest' }));
  await second;
  requests[0].resolve(response({ html: 'stale' }));
  await first;
  assert.equal(app.parameterDocHtml, 'latest');
  const third = app.openParameterDoc('lora-plus');
  app.closeParameterDoc();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(response({ html: 'closed' }));
  await third;
  assert.equal(app.parameterDocOpen, false);
  assert.equal(app.parameterDocHtml, '');
});

test('field guide failures can be retried and links keep opening inside the dialog', async () => {
  let fail = true;
  const { window } = loadFrontend(['docs/index'], {
    window: {}, AbortController,
    fetch: async () => fail ? { ok: false, status: 503 } : response({ html: 'recovered' }),
  });
  const app = composeMixins(window.docsMixin, {
    currentRoute: 'train-anima', $nextTick() {}, t: key => key,
    _parameterDocSection: html => html,
  });
  await app.openParameterDoc('optimizers', 'weight-decay');
  assert.match(app.parameterDocError, /HTTP 503/);
  assert.equal(app.parameterDocLoading, false);
  fail = false;
  await app.openParameterDoc(app.parameterDocSlug, app.parameterDocAnchor, { force: true });
  assert.equal(app.parameterDocHtml, 'recovered');
  assert.equal(app.parameterDocError, '');
  const calls = [];
  app.openParameterDoc = (...args) => calls.push(args);
  for (const href of ['timesteps.en-US.md#comparison-method', '#betas', 'https://example.com']) {
    let prevented = false;
    app.handleDocsContentClick({
      target: { closest: () => ({ getAttribute: () => href }) },
      preventDefault() { prevented = true; },
    }, true);
    assert.equal(prevented, !href.startsWith('https:'));
  }
  assert.deepEqual(calls, [['timesteps', 'comparison-method'], ['optimizers', 'betas']]);
});

test('opening a guide from the documentation route retains the full reader behavior', async () => {
  const { window } = loadFrontend(['docs/index']);
  const calls = [];
  const app = composeMixins(window.docsMixin, {
    currentRoute: 'docs', selectParameterDoc: (...args) => calls.push(args),
  });
  await app.openParameterDoc('optimizers', 'weight-decay');
  assert.deepEqual(calls, [['optimizers', 'weight-decay']]);
  assert.equal(app.parameterDocOpen, false);
});
