const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preview(profile, module, overrides = {}) {
  const context = { window: {}, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated fallback schema'); } };
  vm.createContext(context);
  for (const file of ['constants', 'utils', 'config', 'training-core', 'training-toml']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file + '.js'), 'utf8'), context);
  }
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

test('native Anima dropout belongs to network_args, unsupported convolution fields stay out', () => {
  const { text, args } = preview('anima-lora', 'networks.lora_anima');
  assert.ok(args.includes('rank_dropout=0.2'));
  assert.ok(!args.some(s => /^(conv_dim|conv_alpha|factor|use_tucker)=/.test(s)));
  assert.doesNotMatch(text, /^(rank_dropout|conv_dim|conv_alpha|lokr_factor|use_tucker) =/m);
});

test('registry-driven optimizer preview preserves custom overrides and raw launch fields', () => {
  for (const eps of ['1e-8', '0.00000001']) {
    const { app } = preview('anima-lora', 'networks.lora_anima', {
      optimizer_type: 'AdamW', eps, optimizer_args_custom: 'eps=1e-6\neps=1e-7',
    });
    assert.equal(app._buildOptimizerArgs(app.form).filter(s => s.startsWith('eps=')).join(), 'eps=1e-7');
    const payload = app._collectTrainingPayload();
    assert.equal(payload.eps, eps);
    assert.equal(payload.optimizer_args_custom, 'eps=1e-6\neps=1e-7');
    app.form.eps = '1e-5';
    assert.ok(app._buildOptimizerArgs(app.form).includes('eps=1e-5'));
  }
  const { app } = preview('anima-lora', 'networks.lora_anima', {
    optimizer_type: 'Muon', muon_momentum: 0.87,
  });
  assert.ok(app._buildOptimizerArgs(app.form).includes('momentum=0.87'));
  for (const eps of ['1e-30, 1e-3', '(1e-30, 0.001)', '[1e-30, 0.001]']) {
    const { app } = preview('anima-lora', 'networks.lora_anima', {
      optimizer_type: 'AdaFactor', adafactor_eps: eps, optimizer_args_custom: 'eps=(1e-20, 0.01)',
    });
    assert.ok(app._buildOptimizerArgs(app.form).includes('eps=(1e-20, 0.01)'));
  }
});

test('LoRA+ arguments cover native modules and LyCORIS LoCon only', () => {
  for (const module of ['networks.lora', 'lycoris.kohya']) {
    const { args } = preview('sdxl-lora', module, {
      enable_loraplus: true, lycoris_algo: 'lora', loraplus_lr_ratio: 16,
    });
    assert.ok(args.includes('loraplus_lr_ratio=16'));
  }
  assert.ok(!preview('sdxl-lora', 'lycoris.kohya', {
    enable_loraplus: true, lycoris_algo: 'lokr', loraplus_lr_ratio: 16,
  }).args.some(arg => arg.startsWith('loraplus_')));
});

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

test('failed launch preflight releases the starting flag', async () => {
  const { app } = preview('anima-lora', 'networks.lora_anima');
  let state;
  Object.assign(app, { validateForm: () => true, toast() {},
    refreshOutputPathInfo: async () => { throw new Error('preflight failed'); },
    _applyTaskView: value => { state = value; },
  });
  await app.startTraining();
  assert.equal(app.trainingStarting, false);
  assert.equal(state, 'IDLE');
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
  const python = path.join(__dirname, '../../venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
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
    cwd: path.join(__dirname, '../..'), input: JSON.stringify(cases), encoding: 'utf8', timeout: 30000,
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

test('scheduler previews export only the parameters used by the selected scheduler', () => {
  const settings = { lr_scheduler_timescale: 500, lr_scheduler_min_lr_ratio: 0.1, lr_decay_steps: 0.2 };
  for (const profile of ['sdxl-lora', 'anima-lora']) {
    for (const scheduler of ['constant', 'inverse_sqrt', 'cosine_with_min_lr', 'warmup_stable_decay']) {
      const { text } = preview(profile, profile === 'sdxl-lora' ? 'networks.lora' : 'networks.lora_anima',
        { ...settings, lr_scheduler: scheduler });
      assert.equal(/^lr_scheduler_timescale = 500$/m.test(text), scheduler === 'inverse_sqrt');
      assert.equal(/^lr_scheduler_min_lr_ratio = 0.1$/m.test(text), ['cosine_with_min_lr', 'warmup_stable_decay'].includes(scheduler));
      assert.equal(/^lr_decay_steps = 0.2$/m.test(text), scheduler === 'warmup_stable_decay');
    }
  }
});

test('image augmentation presets export the effective cache settings for each sd-scripts profile', () => {
  for (const [profile, module] of [['anima-lora', 'networks.lora_anima'], ['sdxl-lora', 'networks.lora']]) {
    const flipped = preview(profile, module, { flip_aug: true }).text;
    assert.match(flipped, /^flip_aug = true$/m);
    assert.match(flipped, /^cache_latents = true$/m);
    assert.match(flipped, /^cache_latents_to_disk = true$/m);
    const cropped = preview(profile, module, { flip_aug: true, random_crop: true }).text;
    assert.match(cropped, /^flip_aug = true$/m);
    assert.match(cropped, /^random_crop = true$/m);
    assert.match(cropped, /^cache_latents = false$/m);
    assert.match(cropped, /^cache_latents_to_disk = false$/m);
    assert.doesNotMatch(preview(profile, module).text, /^(flip_aug|random_crop) =/m);
  }
});
