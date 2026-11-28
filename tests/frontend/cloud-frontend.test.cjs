const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, response } = require('./helpers.cjs');

test('currentOutputRunDir accepts canonical relative and external absolute paths while rejecting root sentinels', () => {
  const { window } = loadFrontend('monitor/core', { window: {} });
  const app = composeMixins(window.monitorCoreMixin, {});
  for (const valid of [
    'output/violet_run_1',
    './output/violet_run_1/',
    '/content/drive/MyDrive/Anima_LoRA/output/violet_20261128',
    '/workspace/output/run_42',
    'D:\\Anima\\output\\run_win',
  ]) {
    app.monitorData = { run_dir: valid };
    assert.ok(app.currentOutputRunDir.length > 0, `expected valid run_dir: ${valid}`);
  }
  assert.equal(
    (app.monitorData = { run_dir: '/content/drive/MyDrive/Anima_LoRA/output/violet_20261128' }, app.currentOutputRunDir),
    '/content/drive/MyDrive/Anima_LoRA/output/violet_20261128',
  );
  for (const sentinel of ['', '.', './', '/', 'output', './output', 'output/', 'C:/']) {
    app.monitorData = { run_dir: sentinel };
    assert.equal(app.currentOutputRunDir, '', `expected sentinel rejected: ${sentinel}`);
  }
});
