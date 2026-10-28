const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application(fetch = async () => { throw new Error('Unexpected request'); }) {
  const context = loadFrontend(['environment/core', 'environment/render'], { window: {}, fetch });
  return Object.assign({}, context.window.environmentCoreMixin, context.window.environmentRenderMixin, {
    esc: value => String(value).replaceAll('<', '&lt;'), t: key => key,
    renderEnvironment() {}, scheduleEnvironmentRender() {}, startProgress() {}, finishProgress() {},
    realtimeSubscribe() {}, realtimeUnsubscribe() {},
  });
}
const T = key => key;

test('optional kernels expose install, enable and disable only for valid states', () => {
  const app = application();
  app.mossAccelStatus = { installed: false, available: false, enabled: false, can_install: true };
  assert.match(app._renderMossAccelRow(T), /data-env-action="moss-accel-install"/);
  app.mossAccelStatus.can_install = false;
  assert.doesNotMatch(app._renderMossAccelRow(T), /data-env-action="moss-accel-install"/);
  app.mossAccelStatus = { installed: true, available: true, enabled: false, can_install: true };
  assert.match(app._renderMossAccelRow(T), /data-env-action="moss-accel-enable"/);
  app.mossAccelStatus.enabled = true;
  assert.match(app._renderMossAccelRow(T), /data-env-action="moss-accel-disable"/);
  app.mossAccelBusy = true;
  const busy = app._renderMossAccelRow(T);
  assert.doesNotMatch(busy, /data-env-action="moss-accel-(install|enable|disable)"/);
  assert.match(busy, /aria-expanded="true"/);
});

test('failed verification retains its error after the status refresh', async () => {
  const app = application(async url => ({ ok: true, json: async () => ({ installed: false, enabled: false }) }));
  app.mossAccelBusy = true;
  app.mossAccelInstallJobId = 'verify-job';
  await app._finalizeEnvironmentRealtimeTask('mossAccel', { error: 'CUDA verification failed' }, true);
  assert.equal(app.mossAccelError, 'CUDA verification failed');
  assert.equal(app.mossAccelBusy, false);
  assert.equal(app.mossAccelInstallJobId, null);
});

test('realtime reconnect resumes the isolated installation task', () => {
  const app = application();
  app.applyRealtimeEnvironmentSnapshot({ tasks: { tracked: [
    { kind: 'moss-acceleration-install', task_id: 'job', status: 'RUNNING', data: { lines: 'Verifying CUDA' } },
  ] } });
  assert.equal(app.mossAccelBusy, true);
  assert.equal(app.mossAccelInstallJobId, 'job');
  assert.equal(app.mossAccelInstallLog, 'Verifying CUDA');
  assert.equal(app.resetRealtimeEnvironmentState(), true);
  assert.equal(app.mossAccelBusy, false);
  assert.equal(app.mossAccelError, 'monitor.taskStateUnknown');
});

test('enable requests change only the optional bundle setting', async () => {
  const calls = [];
  const app = application(async (url, options) => {
    calls.push([url, options]);
    return { ok: true, json: async () => ({ success: true, data: { available: true, enabled: false } }) };
  });
  await app.mossAccelSetEnabled(false);
  assert.equal(calls[0][0], '/api/moss-acceleration/enabled');
  assert.equal(calls[0][1].body, '{"enabled":false}');
  assert.equal(app.mossAccelStatus.enabled, false);
});
