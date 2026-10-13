const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, loadFrontend } = require('./helpers.cjs');

function fixture(overrides = {}, processes = 1, totalSteps = 2000) {
  const context = loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-toml', 'training-lr-preview'], {
    window: {}, document: { getElementById: () => null },
  });
  const w = context.window;
  const form = Object.fromEntries(w.getVisibleSections('anima-lora').flatMap(s => s.fields).map(f => [f.key, f.default]));
  Object.assign(form, { model_train_type: 'anima-lora', optimizer_type: 'AdamW', learning_rate: '1e-4',
    pretrained_model_name_or_path: 'model.safetensors', vae: 'vae.safetensors', qwen3: 'qwen3.safetensors', train_data_dir: 'train' }, overrides);
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, w.trainingLrPreviewMixin, {
    form, stepEstimate: { total_steps: totalSteps, gpu_processes: processes },
    t: (key, fallback) => fallback || key, _renderTomlPreview() {}, $nextTick() {},
  });
  return { app, data: app._buildLrPreview() };
}

test('piecewise preview uses exact cumulative boundaries and keeps multipliers above one visible', () => {
  const { app, data } = fixture({ lr_scheduler: 'piecewise_constant', step_rules: '2:1000,0.5:1600,0.1', lr_warmup_steps: 100 });
  const evaluate = progress => app._lrPreviewMultiplier(progress, data.params);
  assert.equal(data.unavailable, '');
  assert.equal(data.warmupVisible, false);
  assert.equal(evaluate(0), 2);
  assert.equal(evaluate(0.4995), 2);
  assert.equal(evaluate(0.5), 0.5);
  assert.equal(evaluate(0.8), 0.1);
  assert.equal(evaluate(1), 0.1);
  assert.equal(data.yTicks[0].label, '2e-4');
  // Adjacent points at the same rendered x make a vertical jump, not a diagonal ramp.
  assert.match(data.currentLinePath, /50\.00000,[\d.]+ L 50\.00000,[\d.]+/);
  const distributed = fixture({ lr_scheduler: 'piecewise_constant', step_rules: '1:1000,0.1' }, 2);
  assert.equal(distributed.app._lrPreviewMultiplier(0.25, distributed.data.params), 0.1);
});

test('invalid rules block launch and unavailable step estimates never invent boundaries', () => {
  for (const value of ['', '1:100', '1:200,0.5:100,0.1', 'nan', '1:100,', '-1', '1e309', '1:9007199254740992,0.1']) {
    const { app, data } = fixture({ lr_scheduler: 'piecewise_constant', step_rules: value });
    assert.equal(data.unavailable, 'lrPreview.invalidNote', value);
    assert.equal(app.validateForm(), false, value);
    assert.equal(app.formErrors.step_rules, 'field.step_rulesError');
  }
  assert.equal(fixture({ lr_scheduler: 'piecewise_constant', step_rules: '1:1000,0.1' }, 1, 0).data.unavailable,
    'lrPreview.stepCountRequiredNote');
  assert.equal(fixture({ lr_scheduler: 'piecewise_constant', step_rules: '0.5' }, 1, 0).data.unavailable, '');
});

test('guided scheduler TOML and preview match the actual sd-scripts factory', () => {
  const cases = [];
  for (const warmup_type of ['linear', 'cosine', '1-sqrt']) {
    for (const decay_type of ['linear', 'cosine', '1-sqrt']) {
      for (const processes of [1, 2]) {
        cases.push({ form: { lr_scheduler: 'warmup_stable_decay', lr_warmup_steps: 0.1, lr_decay_steps: 0.2,
          lr_scheduler_min_lr_ratio: 0.1, warmup_type, decay_type, lr_scheduler_num_cycles: 2 }, processes });
      }
    }
  }
  cases.push(...['2:1000,0.5:1600,0', '1', ' 1 : 100 , 0.1 '].map(step_rules => ({
    form: { lr_scheduler: 'piecewise_constant', step_rules, lr_warmup_steps: 20 }, processes: 2,
  })));
  const samples = [0, 1, 20, 50, 99, 100, 199, 200, 499, 500, 799, 800, 1599, 1600, 1800, 1999, 2000];
  const payload = cases.map(({ form, processes }) => {
    const { app, data } = fixture(form, processes);
    assert.equal(data.unavailable, '');
    app.updateToml();
    assert.doesNotMatch(app.tomlRaw, /^(warmup_type|decay_type|step_rules) =/m);
    return { form: app.form, processes, samples,
      args: JSON.parse(app.tomlRaw.match(/^lr_scheduler_args = (.*)$/m)[1]),
      expected: samples.map(step => app._lrPreviewMultiplier(step / 2000, data.params)) };
  });
  const python = path.join(ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const script = `
import ast, json, sys, math
from argparse import Namespace
sys.path.insert(0, 'vendor/sd-scripts')
import torch
from library.optimizer import get_scheduler_fix
from backend.training.adapter import adapt_config
for case in json.load(sys.stdin):
    config, _ = adapt_config(case['form'])
    parse = lambda items: {k: ast.literal_eval(v) for k, v in (item.split('=', 1) for item in items)}
    assert parse(case['args']) == parse(config['lr_scheduler_args'])
    defaults = dict(lr_scheduler_type='', max_train_steps=2000, lr_warmup_steps=0, lr_decay_steps=0,
                    lr_scheduler_num_cycles=1, lr_scheduler_power=1, lr_scheduler_timescale=10000,
                    lr_scheduler_min_lr_ratio=0, lr_scheduler_args=[])
    defaults.update(config)
    optimizer = torch.optim.AdamW([torch.nn.Parameter(torch.zeros(1))], lr=1e-4)
    scheduler = get_scheduler_fix(Namespace(**defaults), optimizer, case['processes'])
    for step, expected in zip(case['samples'], case['expected']):
        actual = scheduler.lr_lambdas[0](step * case['processes'])
        assert math.isclose(actual, expected, abs_tol=1e-9), (case['form'], step, actual, expected)
`;
  const result = require('node:child_process').spawnSync(python, ['-c', script], {
    cwd: ROOT, input: JSON.stringify(payload), encoding: 'utf8', timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
