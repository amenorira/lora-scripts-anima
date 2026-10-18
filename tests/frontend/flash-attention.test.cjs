const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function makeApp(fetch) {
  const { window } = loadFrontend(['environment-core', 'environment-render'], { window: {}, fetch });
  return Object.assign({}, window.environmentCoreMixin, window.environmentRenderMixin, {
    t: key => key, esc: value => String(value), _envCardOpen: () => true,
    escapeAttr: value => String(value), escJson: value => Buffer.from(JSON.stringify(value)).toString('base64'),
    _envForceOpen() {}, renderEnvironment() {}, scheduleEnvironmentRender() {},
    finishProgress() {}, _setEnvironmentRealtimeTask() {},
  });
}

test('installed extension uses the shared installed badge', () => {
  const app = makeApp();
  app.faStatus = { installed: true, version: '2.8.3', can_install: true };
  const html = app._renderFaRow(key => key);
  assert.match(html, /env-badge-ok">installed<\/span>/);
  assert.match(html, /data-env-action="fa-install"/);
});

test('install request carries download preference and prevents double submission', async () => {
  const calls = [];
  const app = makeApp(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ success: true, job_id: 'fa-job' }) };
  });
  app.faSource = 'mirror';
  await app.faInstall();
  await app.faInstall();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/flash-attn/install');
  assert.equal(calls[0].body.source, 'mirror');
  assert.equal(app.faInstallJobId, 'fa-job');
});

test('failed job preserves actionable error after refresh', async () => {
  const app = makeApp(async () => ({ ok: true, json: async () => ({ installed: false }) }));
  app.faBusy = true;
  await app._finalizeEnvironmentRealtimeTask('fa', { error: 'CUDA backward failed' }, true);
  assert.equal(app.faBusy, false);
  assert.equal(app.faError, 'CUDA backward failed');
});

test('real progress reaches the FlashAttention slot and remains bounded', () => {
  const app = makeApp();
  app.faBusy = true;
  app._applyEnvironmentRealtimeUpdate('fa', { progress: { stage: 'downloading', downloaded: 80, total: 100 }, lines: 'Downloading', elapsed: 3 }, 'RUNNING');
  assert.equal(app.faProgress.downloaded, 80);
  const html = app._renderFaRow(key => key);
  assert.match(html, /width:80%/);
  assert.doesNotMatch(html, /fa.stage.downloading/);
});
