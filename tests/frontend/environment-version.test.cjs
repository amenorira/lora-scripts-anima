const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

const { window } = loadFrontend(['utils', 'training-core', 'environment-render'], { window: {} });
const app = Object.assign({}, window.utilsMixin, window.trainingCoreMixin, window.environmentRenderMixin);
const T = (_key, fallback) => fallback;

test('untagged cores show a blue branch and commit link with consistent details', () => {
  const meta = { repo: 'kohya-ss/sd-scripts', local_branch: 'dev', local_commit: '61fde69fc035413fb1472c20c02c441c6d558ee6', tag: '' };
  const head = app._renderCoreHeadParts(T, meta);
  assert.match(head.version, /dev 61fde69/);
  assert.match(head.version, /class="env-row-version env-link"/);
  assert.match(head.version, /\/commit\/61fde69fc035413fb1472c20c02c441c6d558ee6/);
  const details = app._renderCoreRepositoryDetails(T, meta, meta.repo);
  assert.match(details, /<dd>dev<\/dd>/);
  assert.match(details, /<code>61fde69<\/code>/);
  assert.doesNotMatch(details, /dev 61fde69/, 'details keep branch and commit once, without a duplicate combined version');
});

test('tagged cores preserve release labels and missing metadata never invents a version', () => {
  assert.match(app._renderCoreHeadParts(T, { repo: 'KohakuBlueleaf/LyCORIS', tag: 'v4.1.2' }).version, /releases\/tag\/v4.1.2/);
  assert.match(app._renderCoreHeadParts(T, { repo: 'kohya-ss/musubi-tuner', tag: 'v0.3.6', local_commit: 'abc123456' }).version, />v0.3.6</);
  assert.equal(app._renderCoreHeadParts(T, {}).version, '');
  assert.equal(app._renderCoreHeadParts(T, null).version, '');
  assert.equal(app._renderCoreHeadParts(T, {}, false).version, '');
});

test('release badge preserves old and hexadecimal versions and strips Git build suffixes', () => {
  let register, factory;
  loadFrontend('app', {
    window: {},
    document: { addEventListener(_, callback) { register = callback; } },
    Alpine: { data(_, callback) { factory = callback; } },
  });
  register();
  const app = factory();
  for (const version of ['v2.20.5', 'v26.925.80307', 'v26.1017.223010',
    'v26.1017.13c72', 'v26.1018.00000', '26.1018.00001', 'v26.1018.0000a']) {
    app.version = version;
    assert.equal(app.displayVersion(), version);
    app.version = version + '-4-g3dc39b4f';
    assert.equal(app.displayVersion(), version);
  }
  for (const version of ['...', 'dev', '3dc39b4f', '<none>']) {
    app.version = version;
    assert.equal(app.displayVersion(), version);
  }
});
