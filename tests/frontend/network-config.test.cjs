const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TRAINING_CORE_SCRIPTS, ROOT, loadFrontend } = require('./helpers.cjs');

function application(profile, values = {}) {
  const { window: w } = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS,
    'training/toml', 'training/shape-preview', 'training/config-io'], {
    window: {}, document: { getElementById: () => null }, btoa, TextEncoder,
    fetch: async () => { throw new Error('Use generated schema'); },
  });
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin,
    w.trainingShapePreviewMixin, w.trainingConfigIoMixin, {
      t: key => key, _renderTomlPreview() {}, rebuildForm() {},
      _captureProfileDraft() {}, _persistProfileDrafts() {}, _persistProfileFieldSources() {},
      trainTypes: ['anima-lora', 'moss-image-lora', 'sdxl-lora'].map(v => ({ v })),
    });
  app.form = { ...app._buildFormDefaults(profile), model_train_type: profile, ...values };
  return app;
}

function python(code, input) {
  const executable = path.join(ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(executable, ['-B', '-X', 'utf8', '-c', `
import json, sys
from tools.runtime_paths import configure_test_paths
configure_test_paths()
from backend.training.config.adapter import adapt_config
from backend.training.config.network_config import extract_network_form
data = json.load(sys.stdin)
${code}`], { cwd: ROOT, input: JSON.stringify(input), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

test('native argument import survives frontend defaults, TOML export, and launch', async () => {
  const originals = [
    { model_train_type: 'anima-lora', network_module: 'lycoris.kohya', network_args:
      ['algo=lokr', 'preset=attn-mlp', 'factor=8', 'train_llm_adapter=true', 'network_reg_dims=blocks.*=8'] },
    ...['networks.lora_anima', 'networks.loha', 'networks.lokr'].map(network_module => ({
      model_train_type: 'anima-lora', network_module, network_args:
        ['train_llm_adapter=true', 'rank_dropout=0.2', 'loraplus_unet_lr_ratio=4'],
    })),
    { model_train_type: 'moss-image-lora', network_module: 'networks.lokr', network_args:
      ['factor=8', 'train_text_embedder=true', 'rank_dropout=0.2', 'network_reg_dims=layers.*=4'] },
    { model_train_type: 'sdxl-lora', network_module: 'lycoris.kohya', network_args:
      ['algo=loha', 'preset=attn-only', 'conv_dim=8', 'use_tucker=true'] },
  ];
  const forms = python('print(json.dumps([extract_network_form(form) for form in data]))', originals);
  const roundtrips = [];
  for (const form of forms) {
    const app = application(form.model_train_type);
    await app._applyImportedFlatConfig(form);
    assert.deepEqual(Array.from(app._lastConfigImportIgnoredFields), []);
    app.updateToml();
    const rawArgs = JSON.parse(app.tomlRaw.match(/^network_args = (.+)$/m)[1]);
    roundtrips.push({ launch: app._collectTrainingPayload(), tomlArgs: rawArgs });
  }
  python(`
def args(items):
    return {k: v.lower() for k, v in (item.split('=', 1) for item in items)}
for original, result in zip(data['originals'], data['roundtrips']):
    config, _ = adapt_config(result['launch'])
    actual = args(config['network_args'])
    assert actual == args(result['tomlArgs']), (actual, result)
    expected = args(original['network_args'])
    if 'train_text_embedder' in expected:
        expected['train_llm_adapter'] = expected.pop('train_text_embedder')
    assert all(actual.get(k) == v for k, v in expected.items()), (expected, actual)
`, { originals, roundtrips });
});
