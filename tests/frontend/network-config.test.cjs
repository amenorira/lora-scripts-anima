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

test('structure preview and launch use identical effective network arguments', () => {
  const cases = [
    ['moss-image-lora', { network_module: 'networks.lokr', lokr_factor: -1, network_args_custom: 'factor=8' }, { factor: '8' }],
    ['moss-image-lora', { network_module: 'networks.lokr', lokr_factor: 4, network_args_custom: 'factor=8' }, { factor: '4' }],
    ['moss-image-lora', { network_module: 'networks.lora_generic', lokr_factor: 8, conv_dim: 8,
      train_text_embedder: true, enable_loraplus: true, loraplus_lr_ratio: 4 }, { train_text_embedder: 'true', loraplus_lr_ratio: '4' }],
    ['anima-lora', { network_module: 'lycoris.kohya', train_llm_adapter: false,
      network_args_custom: 'train_llm_adapter=true' }, { train_llm_adapter: 'true' }],
    ...['networks.lora_anima', 'networks.loha', 'networks.lokr'].map(network_module =>
      ['anima-lora', { network_module, train_llm_adapter: true }, { train_llm_adapter: 'true' }]),
  ].map(([profile, form, expected]) => {
    const app = application(profile, form);
    const preview = app._shapeEstimatePayload();
    assert.equal(preview.output_dir, undefined);
    assert.equal(preview.learning_rate, undefined);
    if (form.network_module === 'networks.lora_generic') {
      assert.equal(preview.lokr_factor, undefined);
      assert.equal(preview.conv_dim, undefined);
    }
    return { launch: app._collectTrainingPayload(), preview, expected };
  });
  python(`
def args(form):
    config, _ = adapt_config(form)
    return {k: v.lower() for k, v in (item.split('=', 1) for item in config.get('network_args', []))}
for case in data:
    launch, preview = args(case['launch']), args(case['preview'])
    assert launch == preview, (launch, preview)
    assert all(launch.get(k) == v for k, v in case['expected'].items()), launch
`, cases);
});

test('MOSS text embedder defaults, aliases and module-specific names agree with launch', async () => {
  const cases = [];
  for (const network_module of ['networks.lora_generic', 'networks.loha', 'networks.lokr']) {
    const expectedKey = network_module === 'networks.lora_generic' ? 'train_text_embedder' : 'train_llm_adapter';
    const app = application('moss-image-lora', { network_module });
    assert.equal(app.form.train_text_embedder, false);
    const imports = python('print(json.dumps([extract_network_form(form) for form in data]))',
      ['train_llm_adapter', 'train_text_embedder'].map(key => ({
        model_train_type: 'moss-image-lora', network_module, network_args: [`${key}=true`],
      })));
    for (const form of imports) {
      await app._applyImportedFlatConfig(form);
      assert.equal(app.form.train_text_embedder, true);
      for (const enabled of [true, false]) {
        app.form.train_text_embedder = enabled;
        // Explicitly disabling the switch must also remove stale advanced aliases.
        app.form.network_args_custom = 'train_llm_adapter=true\ntrain_text_embedder=true';
        app.updateToml();
        const args = JSON.parse(app.tomlRaw.match(/^network_args = (.+)$/m)?.[1] || '[]');
        const adapterArgs = args.filter(item => /^(train_llm_adapter|train_text_embedder)=/.test(item));
        assert.deepEqual(adapterArgs, enabled ? [`${expectedKey}=true`] : []);
        cases.push({ form: app._collectTrainingPayload(), expectedKey, enabled });
      }
    }
  }
  python(`
for case in data:
    config, _ = adapt_config(case['form'])
    args = {k: v.lower() for k, v in (item.split('=', 1) for item in config.get('network_args', []))
            if k in ('train_llm_adapter', 'train_text_embedder')}
    assert args == ({case['expectedKey']: 'true'} if case['enabled'] else {}), args
`, cases);
});

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

test('Anima native controls render on the main form and preset choices respect the architecture', () => {
  for (const network_module of ['networks.lora_anima', 'networks.loha', 'networks.lokr']) {
    const app = application('anima-lora', { network_module, train_llm_adapter: true });
    const field = app.findFieldDef('train_llm_adapter');
    assert.equal(app._fieldShowIfMet(field), true);
    assert.doesNotMatch(app.renderField(field), /field-hidden/);
    app.updateToml();
    assert.match(app.tomlRaw, /train_llm_adapter=true/);
  }
  for (const profile of ['anima-lora', 'sdxl-lora']) {
    const app = application(profile, { network_module: 'lycoris.kohya' });
    const html = app.renderField(app.findFieldDef('lycoris_preset'));
    const options = Buffer.from(html.match(/animaSelect\('([^']+)'/)[1], 'base64').toString('utf8');
    for (const name of ['attn-only', 'unet-convblock-only']) {
      assert.equal(options.includes(`"v":"${name}"`), profile === 'sdxl-lora');
    }
  }
  const moss = application('moss-image-lora');
  assert.equal(moss.findFieldDef('loraplus_lr_ratio').hintKeyBy.values['networks.lora_generic'],
    'field.loraplus_lr_ratioHint_standard_lora');
});
