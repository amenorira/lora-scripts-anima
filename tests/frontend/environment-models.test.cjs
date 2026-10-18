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
    assert.ok(html.includes(t('environment.animaModel.mossNote')));
    for (const file of files) {
      assert.ok(html.includes(file.source_url));
      assert.ok(html.includes(t(file.desc_key)));
    }
    const calls = [];
    const all = { dataset: { group: 'MOSS-Image' }, addEventListener: (_, handler) => { all.click = handler; } };
    const single = { dataset: { group: 'MOSS-Image', file: 'flux2-vae_small.safetensors' },
      addEventListener: (_, handler) => { single.click = handler; } };
    const host = { querySelectorAll: selector => selector.includes('dl-all') ? [all] : selector.includes('[data-file]') ? [single] : [] };
    app.animaModelDownload = (...args) => calls.push(args);
    app._bindModelGroupEvents(host);
    all.click(); single.click();
    assert.deepEqual(calls, [[null, 'MOSS-Image'], ['flux2-vae_small.safetensors', 'MOSS-Image']]);
  }
});
