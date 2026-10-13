const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, loadFrontend } = require('./helpers.cjs');

function preview(profile, module, overrides = {}) {
  const context = loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-toml'], {
    window: {}, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated fallback schema'); },
  });
  const w = context.window;
  const form = Object.fromEntries(w.getVisibleSections(profile).flatMap(s => s.fields).map(f => [f.key, f.default]));
  Object.assign(form, { model_train_type: profile, network_module: module, lycoris_algo: 'lokr',
    rank_dropout: 0.2, conv_dim: 8, conv_alpha: 4, lokr_factor: 4, use_tucker: true }, overrides);
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, {
    form, t: key => key, _renderTomlPreview() {},
  });
  app.updateToml();
  const match = app.tomlRaw.match(/^network_args = (.*)$/m);
  return { app, context, text: app.tomlRaw, args: match ? JSON.parse(match[1]) : [] };
}

test('all profiles submit raw form fields through the common launch boundary', async () => {
  for (const profile of ['anima-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app, context } = preview(profile, 'networks.lora_anima', { weight_decay: 0.04 });
    let submitted, accepted;
    context.fetch = async (url, request) => {
      assert.equal(url, '/api/run');
      submitted = JSON.parse(request.body);
      return { ok: true, json: async () => ({ status: 'success', data: { task_id: 'owned-task' } }) };
    };
    Object.assign(app, {
      validateForm: () => true, refreshOutputPathInfo: async () => ({ available: true, writable: true }),
      refreshStepEstimate: async () => ({ total_steps: 10 }), toast() {},
      _acceptTrainingStart: data => { accepted = data.task_id; },
    });
    await app.startTraining();
    assert.equal(submitted.model_train_type, profile);
    assert.deepEqual(submitted._form_state, JSON.parse(JSON.stringify(app.form)));
    assert.equal(accepted, 'owned-task');
    assert.equal(app.trainingStarting, false);
    if (profile !== 'krea2-lora') {
      assert.equal(submitted.weight_decay, app.form.weight_decay);
      assert.equal(submitted.optimizer_args, undefined);
    }
  }
});

test('numeric-looking text stays text while the schema identifies numeric preview values', () => {
  for (const profile of ['anima-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app, text } = preview(profile, 'networks.lora_anima', {
      output_name: '00123', positive_prompts: '123', enable_preview: true,
      learning_rate: '1e-4', resolution: '1024',
    });
    const payload = app._collectTrainingPayload();
    assert.equal(payload.output_name, '00123');
    assert.equal(payload.resolution, '1024');
    if (profile !== 'krea2-lora') assert.equal(payload.positive_prompts, '123');
    assert.equal(payload.learning_rate, '1e-4');
    assert.match(text, /^output_name = "00123"$/m);
    assert.match(text, /^resolution = "1024"$/m);
    assert.match(text, /^learning_rate = 0.0001$/m);
  }
});

test('every optimizer preview agrees with the backend argument contract', () => {
  const field = preview('anima-lora', 'networks.lora_anima').app.findFieldDef('optimizer_type');
  const options = [...(field.options || []), ...(field.groups || []).flatMap(group => group.options)];
  const cases = options.map(option => {
    const { app } = preview('anima-lora', 'networks.lora_anima', { optimizer_type: option.v });
    return { payload: app._collectTrainingPayload(), preview: app._buildOptimizerArgs(app.form) };
  });
  assert.ok(cases.length > 10);
  const python = path.join(ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const script = `
import ast, json, sys
from backend.training.adapter import adapt_config
def parse(items):
    return {key: ast.literal_eval(value) for key, value in (item.split('=', 1) for item in items)}
for case in json.load(sys.stdin):
    config, _ = adapt_config(case['payload'])
    actual = parse(config.get('optimizer_args', []))
    for key, value in parse(case['preview']).items():
        assert key in actual and actual[key] == value, (case['payload']['optimizer_type'], key, value, actual)
`;
  const result = require('node:child_process').spawnSync(python, ['-c', script], {
    cwd: ROOT, input: JSON.stringify(cases), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

test('native LoRA, LoHa, LoKr and LyCORIS serialize supported fields without top-level leakage', () => {
  for (const module of ['networks.lora', 'networks.loha', 'networks.lokr', 'lycoris.kohya']) {
    const { text, args } = preview('sdxl-lora', module);
    for (const value of ['rank_dropout=0.2', 'conv_dim=8', 'conv_alpha=4']) assert.ok(args.includes(value), module + ': ' + value);
    assert.equal(args.includes('use_tucker=true'), module !== 'networks.lora');
    assert.equal(args.includes('factor=4'), ['networks.lokr', 'lycoris.kohya'].includes(module));
    assert.doesNotMatch(text, /^(rank_dropout|conv_dim|conv_alpha|lokr_factor|use_tucker) =/m);
  }
});
