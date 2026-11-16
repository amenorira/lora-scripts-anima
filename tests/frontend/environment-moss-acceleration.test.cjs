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


test('reconnect applies the tracked job completion and ignores an older job in the same slot', async () => {
  const app = application(async () => ({ ok: true, json: async () => ({ installed: true, enabled: true }) }));
  const unsubscribed = [];
  app.realtimeUnsubscribe = topic => unsubscribed.push(topic);
  const previous = { kind: 'moss-acceleration-install', task_id: 'old', status: 'FAILED', data: { error: 'Old failure' } };
  const active = { kind: 'moss-acceleration-install', task_id: 'job', status: 'RUNNING', data: { lines: 'Verifying CUDA' } };
  const apply = tracked => app.applyRealtimeEnvironmentSnapshot({ tasks: { tracked } });
  apply([active]);
  apply([previous, active]);
  assert.equal(app.mossAccelBusy, true);
  assert.deepEqual(unsubscribed, []);

  apply([previous, { ...active, status: 'FINISHED', data: { done: true } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.mossAccelBusy, false);
  assert.equal(app.mossAccelInstallJobId, null);
  assert.equal(app.mossAccelStatus.enabled, true);
  assert.equal(app.mossAccelError, null);
  assert.deepEqual(unsubscribed, ['task:job']);
});
