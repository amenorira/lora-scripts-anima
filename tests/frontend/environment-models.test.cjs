const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { ROOT, loadFrontend, readRepo } = require('./helpers.cjs');

test('MOSS download card renders the backend catalog in all three languages and binds its actions', () => {
  const python = path.join(ROOT, process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python');
  const catalog = JSON.parse(execFileSync(python, ['-c',
    'import json; from pathlib import Path; from tools.download_anima_model import list_local_model_files; print(json.dumps(list_local_model_files(Path("models"))))'
  ], { cwd: ROOT, encoding: 'utf8' }));
  const files = catalog.filter(file => file.group === 'MOSS-Image');
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const messages = JSON.parse(readRepo(`frontend/i18n/${locale}.json`));
    const t = (key, fallback) => key.split('.').reduce((value, part) => value?.[part], messages) || fallback || key;
    const { window } = loadFrontend(['utils', 'training-core', 'environment-core', 'environment-render'], { window: {} });
    const app = Object.assign({}, window.utilsMixin, window.trainingCoreMixin, window.environmentCoreMixin, window.environmentRenderMixin, {
      t, animaModelStatus: catalog, _envCardOpen: () => true,
    });
    const T = (key, fallback) => t('environment.' + key, fallback);
    const skeleton = { dataset: {} };
    app._ensureEnvSkeleton(skeleton, T);
    assert.match(skeleton.innerHTML, /data-env-slot="moss"/);
    const html = app._renderModelGroup(T, 'MOSS-Image');
    assert.match(html, /data-group="MOSS-Image"/);
    assert.equal((html.match(/class="env-file-main"/g) || []).length, 8);
    assert.doesNotMatch(html, /env-model-dl-all/);
    for (const [kind, count] of [['model', 4], ['encoder', 2], ['vae', 2]]) {
      const section = html.match(new RegExp(`data-env-component="${kind}">([\\s\\S]*?)</section>`));
      assert.ok(section, kind);
      assert.equal((section[1].match(/class="env-file-main"/g) || []).length, count);
      assert.doesNotMatch(section[1], /env-component-hint/);
    }
    assert.ok(html.includes(t('environment.animaModel.mossNote')));
    for (const file of files) {
      assert.ok(html.includes(file.source_url));
      assert.ok(html.includes(t(file.desc_key)));
    }
    const calls = [];
    const single = { dataset: { group: 'MOSS-Image', file: 'flux2-vae_small.safetensors' },
      addEventListener: (_, handler) => { single.click = handler; } };
    const host = { querySelectorAll: selector => selector.includes('[data-file]') ? [single] : [] };
    app.animaModelDownload = (...args) => calls.push(args);
    app._bindModelGroupEvents(host);
    single.click();
    assert.deepEqual(calls, [['flux2-vae_small.safetensors', 'MOSS-Image']]);
    for (const group of ['Anima', 'Krea 2', 'Train Use']) {
      assert.doesNotMatch(app._renderModelGroup(T, group), /env-model-dl-all/);
    }
    for (const key of ['kreaRaw', 'kreaTurbo', 'kreaVae']) {
      assert.ok(app._renderModelGroup(T, 'Krea 2').includes(T('animaModel.' + key)));
    }
    app.animaModelStatus = catalog.map(({ component_type, ...file }) => file);
    assert.equal(app._renderModelGroup(T, 'MOSS-Image'), html, 'an older running backend retains the same categories');

    const header = group => app._renderModelGroup(T, group).split('<div class="env-row-body"')[0];
    for (const [installed, ready, missing] of [
      [[], false, []],
      [[0, 1, 2, 3], false, ['componentEncoder', 'componentVae']],
      [[0, 4, 6], true, []],
      [[1, 5, 7], true, []],
      [[0, 1, 2, 3, 4, 5, 6, 7], true, []],
    ]) {
      app.animaModelStatus = files.map((file, index) => ({ ...file, exists: installed.includes(index), size_bytes: installed.includes(index) ? 1024 : 0 }));
      const rendered = header('MOSS-Image');
      assert.equal(rendered.includes(T('animaModel.componentsReady')), ready);
      assert.doesNotMatch(rendered, /\d+\/8/);
      if (!installed.length) assert.ok(rendered.includes(T('animaModel.notDownloaded')));
      for (const key of missing) assert.ok(rendered.includes(T('animaModel.' + key)));
    }
    app.animaModelBusy = true;
    app.animaModelProgress = { group: 'MOSS-Image' };
    assert.ok(header('MOSS-Image').includes(T('animaModel.downloading')));
    assert.ok(!header('MOSS-Image').includes(T('animaModel.componentsReady')));
    app.animaModelBusy = false;
    app.animaModelProgress = null;
    app.animaModelStatus = catalog.filter(file => file.group === 'Krea 2').map(file => ({ ...file, exists: file.filename !== 'krea2_raw_fp8_scaled.safetensors' }));
    assert.ok(header('Krea 2').includes(T('animaModel.componentTrainingModel')));
    assert.ok(!header('Krea 2').includes(T('animaModel.componentsReady')));
    app.animaModelStatus[0].exists = true;
    assert.ok(header('Krea 2').includes(T('animaModel.componentsReady')));
    app.animaModelStatus = catalog.filter(file => file.group === 'Train Use').map(file => ({ ...file, exists: true }));
    assert.ok(header('Train Use').includes(T('animaModel.downloaded')));
    assert.ok(!header('Train Use').includes(T('animaModel.componentsReady')));
    assert.ok(app._renderOverview(T).includes(T('animaModel.localFileCount').replace('{count}', '1')));
    app.animaModelStatus.push({ ...app.animaModelStatus[0], group: 'Anima' });
    assert.ok(app._renderOverview(T).includes(T('animaModel.localFileCount').replace('{count}', '1')), 'shared local files are counted once');
  }
});

test('every model download requires a file choice and MOSS opens its own group', async () => {
  const requests = [], opened = [];
  const { window } = loadFrontend('environment-core', {
    window: {}, fetch: async (_, options) => {
      requests.push(JSON.parse(options.body));
      return { json: async () => ({ success: true, job_id: 'test-job' }) };
    },
  });
  const app = Object.assign({}, window.environmentCoreMixin, {
    _envForceOpen: key => opened.push(key), renderEnvironment() {}, startProgress() {},
    _setEnvironmentRealtimeTask() {},
  });
  for (const group of ['Anima', 'Krea 2', 'MOSS-Image', 'Train Use', null]) {
    await app.animaModelDownload(null, group);
    await app.animaModelDownload('', group);
  }
  assert.equal(requests.length, 0);
  assert.equal(app.animaModelBusy, false);
  assert.deepEqual(opened, []);
  await app.animaModelDownload('flux2-vae_small.safetensors', 'MOSS-Image');
  assert.deepEqual(requests, [{ file: 'flux2-vae_small.safetensors', group: 'MOSS-Image' }]);
  assert.deepEqual(opened, ['moss']);
  app.animaModelBusy = false;
  await app.animaModelDownload(null, 'Anima');
  assert.equal(requests.length, 1);
});
