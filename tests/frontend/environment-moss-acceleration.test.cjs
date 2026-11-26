const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application(fetch = async () => { throw new Error('Unexpected request'); }) {
  const context = loadFrontend(['environment/core', 'environment/render'], { window: {}, fetch });
  return Object.assign({}, context.window.environmentCoreMixin, context.window.environmentRenderMixin, {
    esc: value => String(value).replaceAll('<', '&lt;'),
    escapeAttr: value => String(value).replaceAll('"', '&quot;'),
    t: key => key,
    _envCardOpen: () => false,
    _refreshIconHtml: () => '',
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

function splitRowParts(html) {
  const [head, body = ''] = html.split('<div class="env-row-body"');
  return { head, body };
}

test('MOSS row hides version when not installed and moves target version into detail body', () => {
  const app = application();
  const T = key => key;

  app.mossAccelStatus = null;
  const loading = splitRowParts(app._renderMossAccelRow(T));
  assert.match(loading.head, /<div class="env-row-meta"><span class="env-text-dim">—<\/span><\/div>/);
  assert.doesNotMatch(loading.body, /data-env-action="moss-accel-install"/);

  app.mossAccelStatus = { installed: false, available: false, enabled: false, can_install: true,
    versions: { 'flash-linear-attention': '0.5.2', 'causal-conv1d': '1.7.0' } };
  const uninstalled = splitRowParts(app._renderMossAccelRow(T));
  assert.match(uninstalled.head, /<div class="env-row-meta"><span class="env-text-dim">—<\/span><\/div>/);
  assert.doesNotMatch(uninstalled.head, /FLA 0\.5\.2/);
  assert.match(uninstalled.body, /mossAccelTargetVersion/);
  assert.match(uninstalled.body, /FLA 0\.5\.2 · Conv1D 1\.7\.0/);
  assert.doesNotMatch(uninstalled.body, /data-env-action="moss-accel-install"/);

  app.mossAccelStatus = { installed: true, available: false, enabled: false, can_install: true, reason: 'changed',
    versions: { 'flash-linear-attention': '0.5.2', 'causal-conv1d': '1.7.0' } };
  const changed = splitRowParts(app._renderMossAccelRow(T));
  assert.match(changed.head, /data-env-action="moss-accel-install"/);
  assert.doesNotMatch(changed.body, /data-env-action="moss-accel-install"/);

  app.mossAccelStatus = { installed: true, available: true, enabled: true, can_install: true,
    versions: { 'flash-linear-attention': '0.5.2', 'causal-conv1d': '1.7.0' } };
  const installed = splitRowParts(app._renderMossAccelRow(T));
  assert.match(installed.head, /FLA 0\.5\.2 · Conv1D 1\.7\.0/);
  assert.doesNotMatch(installed.body, /mossAccelTargetVersion/);
  assert.match(installed.body, /data-env-action="moss-accel-install"[\s\S]*data-env-refresh="mossAccel"/);
});

test('xformers and Triton keep install on head when missing and move reinstall + labeled refresh to detail body when installed', () => {
  const app = application();
  const T = key => key;

  app.xfStatus = { installed: false, env: {} };
  const xfMissing = splitRowParts(app._renderXfRow(T));
  assert.match(xfMissing.head, /data-env-action="xf"/);
  assert.doesNotMatch(xfMissing.body, /data-env-action="xf"/);
  assert.match(xfMissing.body, /data-env-refresh="xf"[^>]*><span>environment\.refresh<\/span>/);

  app.xfStatus = { installed: true, version: '0.0.30', env: {} };
  const xfInstalled = splitRowParts(app._renderXfRow(T));
  assert.doesNotMatch(xfInstalled.head, /data-env-action="xf"/);
  assert.match(xfInstalled.body, /data-env-action="xf">reinstall<\/button>[\s\S]*data-env-refresh="xf"[^>]*><span>environment\.refresh<\/span>/);

  app.tritonStatus = { installed: false };
  const tritonMissing = splitRowParts(app._renderTritonRow(T));
  assert.match(tritonMissing.head, /data-env-action="triton"/);
  assert.doesNotMatch(tritonMissing.body, /data-env-action="triton"/);
  assert.match(tritonMissing.body, /data-env-refresh="triton"[^>]*><span>environment\.refresh<\/span>/);

  app.tritonStatus = { installed: true, version: '3.7.1.post27', package: 'triton-windows' };
  const tritonInstalled = splitRowParts(app._renderTritonRow(T));
  assert.doesNotMatch(tritonInstalled.head, /data-env-action="triton"/);
  assert.match(tritonInstalled.body, /data-env-action="triton">reinstall<\/button>[\s\S]*data-env-refresh="triton"[^>]*><span>environment\.refresh<\/span>/);
});
