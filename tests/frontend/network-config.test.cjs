const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TRAINING_CORE_SCRIPTS, ROOT, loadFrontend, trainingFieldSections, readRepo } = require('./helpers.cjs');

function application(profile, values = {}) {
  const { window: w } = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS,
    'training/toml', 'training/shape-preview', 'training/config-io'], {
    window: { TRAIN_SECTIONS: trainingFieldSections() }, document: { getElementById: () => null }, btoa, TextEncoder,
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

test('imported prompt files survive drafts, native export, and launch without changing inline defaults', async () => {
  const file = './captions/Preview.TXT';
  for (const [key, schedule] of [['prompt_file', {sample_at_first: true}], ['sample_prompts', {}]]) {
    const raw = { model_train_type: 'moss-image-lora', [key]: file, ...schedule };
    const imported = python('from backend.training.config.config_import import import_native_training_form\nprint(json.dumps(import_native_training_form(data)))', raw);
    const app = application(raw.model_train_type);
    assert.equal(app._collectTrainingPayload().sample_prompts, undefined);
    await app._applyImportedFlatConfig(imported);
    assert.deepEqual(Array.from(app._lastConfigImportIgnoredFields), []);
    const draft = app._profileFormFromDraft(raw.model_train_type, app._buildFormDefaults(raw.model_train_type), app.form);
    assert.equal(draft.sample_prompts, file);
    app.form = draft;
    app.updateToml();
    assert.ok(app.tomlRaw.includes('sample_prompts = "./captions/Preview.TXT"'));
    const launch = app._collectTrainingPayload();
    assert.equal(launch.sample_prompts, file);
    assert.equal(launch.sample_at_first === true, !!schedule.sample_at_first);
    assert.equal(launch.sample_every_n_epochs, undefined);
    assert.equal(launch.prompt_file, undefined);
    python(`
from backend.training.config.training_config import build_training_config, extract_training_form
restored = extract_training_form(build_training_config(data, profile_id=data['model_train_type']))
assert restored['sample_prompts'] == data['sample_prompts'] == adapt_config(data)[0]['sample_prompts']
`, launch);
  }
});

test('changing the Anima checkpoint changes the structure preview request', () => {
  const app = application('anima-lora');
  for (const model of ['./models/original.safetensors', './models/deeper.safetensors']) {
    app.form.pretrained_model_name_or_path = model;
    assert.equal(app._shapeEstimatePayload().pretrained_model_name_or_path, model);
  }
});

test('Anima preview shares estimates across opens and retries failed estimates on reopen', async () => {
  let depth = 28;
  let requests = 0;
  let responseReady;
  let failNext = false;
  const q = { id: 'q', name: 'blocks.*.self_attn.q_proj' };
  const mlp = { id: 'mlp', name: 'blocks.*.mlp' };
  let groups = [q, mlp];
  const { window } = loadFrontend('training/shape-preview', {
    window: {}, setTimeout, clearTimeout, AbortController,
    fetch: async () => {
      requests++;
      if (responseReady) await responseReady;
      if (failNext) {
        failNext = false;
        return { ok: false, json: async () => ({ status: 'error', message: 'boom' }) };
      }
      return { ok: true, json: async () => ({ status: 'success', data: { depth, estimatedBytes: depth * 1024, groups } }) };
    },
  });
  const app = Object.assign({}, window.trainingShapePreviewMixin, {
    form: { model_train_type: 'anima-lora', network_dim: 8 },
    _openManagedModal(key) { this[key] = true; }, _closeManagedModal(key) { this[key] = false; }, $nextTick() {},
    _shapeEstimatePayload() { return { pretrained_model_name_or_path: './models/current.safetensors', network_dim: this.form.network_dim }; },
  });
  app.scheduleShapeEstimate(); // The file size estimate starts before the dialog opens.
  app.openShapePreview();
  assert.equal(app.shapePreviewMounted, true);
  await app.refreshShapeEstimate();
  assert.equal(app.shapePreviewSelected, 'q');
  app.selectShapePreview('mlp');
  app.closeShapePreview();
  app.openShapePreview();
  assert.equal(app.shapeEstimateLoading, false);
  assert.equal(app.shapeEstimate.estimatedBytes, 28 * 1024);
  app.form.network_dim = 16;
  app.scheduleShapeEstimate();
  await app.refreshShapeEstimate();
  app.form.network_dim = 8;
  app.scheduleShapeEstimate();
  assert.equal(app.shapeEstimateLoading, false);
  assert.equal(app.shapePreviewSelected, 'mlp');
  assert.equal(requests, 2);
  app.closeShapePreview();
  depth = 40;
  groups = [q];
  failNext = true;
  app.form.network_dim = 32;
  app.scheduleShapeEstimate();
  await app.refreshShapeEstimate();
  assert.equal(app.shapeEstimateError, 'boom');
  let finishRequest;
  responseReady = new Promise(resolve => { finishRequest = resolve; });
  app.openShapePreview();
  assert.equal(app.shapePreviewOpen, true);
  assert.equal(app.shapeEstimateLoading, true);
  assert.equal(app.shapeEstimateError, '');
  const pending = app.refreshShapeEstimate();
  finishRequest();
  await pending;
  assert.equal(app.shapeEstimate.estimatedBytes, 40 * 1024);
  assert.equal(app.shapePreviewSelected, 'q');
  assert.equal(requests, 4);
  app.form.network_dim = 16;
  app.scheduleShapeEstimate();
  assert.equal(app.shapeEstimateLoading, false);
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

test('shape preview localizes coded API failures instead of leaking bilingual backend messages', async () => {
  const jaDict = JSON.parse(readRepo('frontend/i18n/ja-JP.json'));
  const { window } = loadFrontend(['shared/utils', 'training/shape-preview'], {
    window: {},
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        status: 'fail',
        message: 'Unsupported custom network / 暂不支持此自定义网络',
        data: { errorCode: 'shapePreviewUnsupportedNetwork', errorParams: {} },
      }),
    }),
  });
  const app = Object.assign({}, window.utilsMixin, window.trainingShapePreviewMixin, {
    form: { model_train_type: 'anima-lora', network_dim: 8 },
    _shapeEstimateSignature: '{}',
    _shapeEstimateRevision: 1,
    t: key => key.split('.').reduce((v, part) => v?.[part], jaDict) ?? key,
  });
  await app.refreshShapeEstimate();
  assert.equal(app.shapeEstimateError, jaDict.errors.shapePreviewUnsupportedNetwork);
  assert.ok(!app.shapeEstimateError.includes('/'));
});

test('shape preview localizes Krea 2 validation failures while keeping invalid field names', async () => {
  const jaDict = JSON.parse(readRepo('frontend/i18n/ja-JP.json'));
  const { window } = loadFrontend(['shared/utils', 'training/shape-preview'], {
    window: {},
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        status: 'fail',
        message: 'module_dropout: invalid probability / 概率超出有效范围',
        data: { errorCode: 'shapePreviewInvalidKrea2Network', errorParams: { fields: 'module_dropout' } },
      }),
    }),
  });
  const app = Object.assign({}, window.utilsMixin, window.trainingShapePreviewMixin, {
    form: { model_train_type: 'krea2-lora', module_dropout: 2 },
    _shapeEstimateSignature: '{}',
    _shapeEstimateRevision: 1,
    t: key => key.split('.').reduce((v, part) => v?.[part], jaDict) ?? key,
  });
  await app.refreshShapeEstimate();
  assert.equal(
    app.shapeEstimateError,
    jaDict.errors.shapePreviewInvalidKrea2Network.replace('{fields}', 'module_dropout')
  );
  assert.ok(app.shapeEstimateError.includes('module_dropout'));
  assert.ok(!app.shapeEstimateError.includes('/'));
});
