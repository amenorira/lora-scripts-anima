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
