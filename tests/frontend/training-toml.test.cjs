const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

function preview(profile, module, overrides = {}) {
  const context = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS, 'training/toml'], {
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

test('model bucket defaults reach crop previews and training without overriding saved values', () => {
  for (const [profile, module, step] of [
    ['anima-lora', 'networks.lora_anima', 16],
    ['moss-image-lora', 'networks.lora_generic', 16],
    ['sdxl-lora', 'networks.lora', 32],
  ]) {
    const { app } = preview(profile, module);
    assert.equal(app.form.bucket_reso_steps, step);
    assert.equal(app._stepEstimatePayload().bucket_reso_steps, step);
    assert.equal(app._collectTrainingPayload().bucket_reso_steps, step);
    assert.match(app.tomlRaw, new RegExp(`^bucket_reso_steps = ${step}$`, 'm'));

    const restored = app._profileFormFromDraft(profile, app._buildFormDefaults(profile), { bucket_reso_steps: 64 });
    assert.equal(restored.bucket_reso_steps, 64);
    app.form.bucket_reso_steps = restored.bucket_reso_steps;
    app.updateToml();
    assert.equal(app._collectTrainingPayload().bucket_reso_steps, 64);
    assert.match(app.tomlRaw, /^bucket_reso_steps = 64$/m);
  }
  const { app: krea } = preview('krea2-lora', 'networks.lora_krea2');
  assert.equal(krea._collectTrainingPayload().bucket_reso_steps, undefined);
  assert.doesNotMatch(krea.tomlRaw, /^bucket_reso_steps =/m);
});

test('partial checkpointing exports only for enabled Anima and MOSS checkpointing', () => {
  for (const [profile, module, maximum] of [
    ['anima-lora', 'networks.lora_anima', 28], ['moss-image-lora', 'networks.lora_generic', 42],
  ]) {
    const { app } = preview(profile, module, { gradient_checkpointing: true, gradient_checkpointing_skip_blocks: maximum });
    assert.match(app.tomlRaw, new RegExp(`^gradient_checkpointing_skip_blocks = ${maximum}$`, 'm'));
    assert.equal(app._numberConstraints(app.findFieldDef('gradient_checkpointing_skip_blocks')).max, maximum);
    app.form.gradient_checkpointing = false;
    app.updateToml();
    assert.doesNotMatch(app.tomlRaw, /^gradient_checkpointing_skip_blocks =/m);
    app.form.gradient_checkpointing = true;
    app.form.gradient_checkpointing_skip_blocks = 0;
    app.updateToml();
    assert.doesNotMatch(app.tomlRaw, /^gradient_checkpointing_skip_blocks =/m);
  }
});

test('MOSS text encoder swapping exports without caches and stays outside other profiles', () => {
  const values = { text_encoder_blocks_to_swap: 32, cache_text_encoder_outputs: false,
    cache_text_encoder_outputs_to_disk: false, gradient_checkpointing: false, blocks_to_swap: 0 };
  const { app } = preview('moss-image-lora', 'networks.lora_generic', values);
  assert.match(app.tomlRaw, /^text_encoder_blocks_to_swap = 32$/m);
  assert.equal(app._collectTrainingPayload().text_encoder_blocks_to_swap, 32);
  for (const [profile, module] of [['anima-lora', 'networks.lora_anima'], ['sdxl-lora', 'networks.lora']]) {
    const { app: other } = preview(profile, module, { ...values, gradient_checkpointing_skip_blocks: 8 });
    assert.doesNotMatch(other.tomlRaw, /^text_encoder_blocks_to_swap =/m);
    assert.equal(other._collectTrainingPayload().text_encoder_blocks_to_swap, undefined);
    if (profile === 'sdxl-lora') assert.doesNotMatch(other.tomlRaw, /^gradient_checkpointing_skip_blocks =/m);
  }
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

test('ScheduleFree auto keeps its native default and explicit custom arguments', () => {
  for (const [profile, optimizer] of [['anima-lora', 'AdamWScheduleFree'], ['krea2-lora', 'schedulefree.AdamWScheduleFree']]) {
    const { app } = preview(profile, 'networks.lora_anima', { optimizer_type: optimizer, foreach: 'auto' });
    assert.ok(!app._buildOptimizerArgs(app.form).some(arg => arg.startsWith('foreach=')));
    app.form.optimizer_args_custom = 'foreach=None';
    assert.ok(app._buildOptimizerArgs(app.form).includes('foreach=None'));
    app.form.foreach = 'false';
    assert.ok(app._buildOptimizerArgs(app.form).includes('foreach=False'));
  }
});

test('Automagic defaults reach every profile without replacing a manual starting rate', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora']) {
    for (const version of [3, 4]) {
      const { app } = preview(profile, 'networks.lora_anima', {
        optimizer_type: `vendor.automagic_optimizer.integration.Automagic${version}`,
      });
      app.formDefaults = {};
      app._fieldSources = { learning_rate: 'default' };
      const rule = app._collectAutoValueRules().find(rule =>
        rule.target === 'learning_rate' && app._matchAutoValueRule(rule));
      assert.equal(app._applyAutoValueRule(rule), true, `${profile} Automagic${version}`);
      assert.equal(app.form.learning_rate, '2e-5');
      assert.equal(app.findFieldDef('automagic_max_lr').default, '2e-4');
      app.form.learning_rate = '3e-5';
      app._fieldSources.learning_rate = 'user';
      assert.equal(app._applyAutoValueRule(rule), false);
      assert.equal(app.form.learning_rate, '3e-5');
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
from tools.runtime_paths import configure_test_paths
configure_test_paths()
from backend.training.config.adapter import adapt_config
def parse(items):
    return {key: ast.literal_eval(value) for key, value in (item.split('=', 1) for item in items)}
for case in json.load(sys.stdin):
    config, _ = adapt_config(case['payload'])
    actual = parse(config.get('optimizer_args', []))
    for key, value in parse(case['preview']).items():
        assert key in actual and actual[key] == value, (case['payload']['optimizer_type'], key, value, actual)
`;
  const result = require('node:child_process').spawnSync(python, ['-B', '-c', script], {
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

test('TensorBoard timestep switches are independent and stay out of engine TOML', () => {
  const keys = ['log_grad_norm', 'log_grad_clipped', 'log_timestep_loss', 'log_timestep_count'];
  for (const profile of ['anima-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app } = preview(profile, 'networks.lora_anima');
    for (const key of keys) assert.equal(app.form[key], false, profile + ': ' + key);
    assert.equal(app._fieldShowIfMet(app.findFieldDef('log_grad_clipped')), false);
    assert.equal(app._fieldShowIfMet(app.findFieldDef('log_timestep_count')), true);
    app.form.log_grad_clipped = true;
    app.form.log_timestep_count = true;
    let payload = app._collectTrainingPayload();
    assert.equal(payload.log_grad_norm, false);
    assert.equal(payload.log_timestep_loss, false);
    assert.equal(payload.log_grad_clipped, undefined);
    assert.equal(payload.log_timestep_count, true);
    // Keep child preferences in the saved form even while the parent is off.
    assert.equal(app._collectTrainingFormSnapshot().log_grad_clipped, true);
    app.form.log_grad_norm = true;
    app.form.log_timestep_loss = true;
    for (const key of ['log_grad_clipped', 'log_timestep_count']) {
      assert.equal(app._fieldShowIfMet(app.findFieldDef(key)), true);
    }
    payload = app._collectTrainingPayload();
    for (const key of keys) assert.equal(payload[key], true);
    app.updateToml();
    assert.doesNotMatch(app.tomlRaw, /^(log_grad_norm|log_grad_clipped|log_timestep_loss|log_timestep_count) =/m);
    for (const loss of [false, true]) {
      for (const count of [false, true]) {
        app.form.log_timestep_loss = loss;
        app.form.log_timestep_count = count;
        const independent = app._collectTrainingPayload();
        assert.equal(independent.log_timestep_loss, loss);
        assert.equal(independent.log_timestep_count, count);
        assert.equal(app._collectTrainingFormSnapshot().log_timestep_count, count);
      }
    }
  }
});

test('foreach choices preserve native literals, custom precedence and optimizer visibility', () => {
  for (const profile of ['anima-lora', 'sdxl-lora', 'moss-image-lora', 'krea2-lora']) {
    for (const [choice, literal] of [['auto', 'None'], ['true', 'True'], ['false', 'False']]) {
      const { app, text } = preview(profile, 'networks.lora_anima', {
        optimizer_type: 'pytorch_optimizer.CAME', foreach: choice,
      });
      assert.equal(app._collectTrainingPayload().foreach, choice);
      if (profile === 'krea2-lora') assert.match(text, new RegExp(`^foreach = "${choice}"$`, 'm'));
      else {
        assert.ok(app._buildOptimizerArgs(app.form).includes(`foreach=${literal}`));
        assert.doesNotMatch(text, /^foreach =/m);
        assert.doesNotMatch(text, /foreach=\\"(?:auto|true|false)\\"/);
      }
    }
    const { app, context } = preview(profile, 'networks.lora_anima', {
      optimizer_type: 'pytorch_optimizer.CAME', foreach: 'auto', optimizer_args_custom: 'foreach=False',
    });
    if (profile === 'krea2-lora') {
      assert.equal(app._collectTrainingPayload().optimizer_args_custom, 'foreach=False');
    } else {
      assert.ok(app._buildOptimizerArgs(app.form).includes('foreach=False'));
      app.form.foreach = 'true';
      assert.ok(app._buildOptimizerArgs(app.form).includes('foreach=True'));
    }
    const field = context.window.getVisibleSections(profile).flatMap(s => s.fields).find(f => f.key === 'foreach');
    for (const optimizer of ['AdamW8bit', 'pytorch_optimizer.SOAP', 'Lion', 'pytorch_optimizer.Lion']) {
      app.form.optimizer_type = optimizer;
      assert.equal(app._fieldShowIfMet(field), optimizer === 'pytorch_optimizer.Lion');
    }
  }
});

test('AdamW fused control is visible and exports native booleans with custom precedence', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora']) {
    for (const [choice, literal] of [['auto', null], ['true', 'True'], ['false', 'False']]) {
      const { app } = preview(profile, 'networks.lora_anima', { optimizer_type: 'AdamW', adamw_fused: choice });
      const field = app.findFieldDef('adamw_fused');
      assert.ok(field);
      assert.equal(app._fieldShowIfMet(field), true);
      assert.equal(app._collectTrainingPayload().adamw_fused, choice);
      const args = app._buildOptimizerArgs(app.form);
      if (literal === null) assert.equal(args.some(arg => arg.startsWith('fused=')), false);
      else assert.ok(args.includes(`fused=${literal}`));
      assert.doesNotMatch(app.tomlRaw, /^adamw_fused =/m);
      app.form.optimizer_args_custom = 'fused=True';
      assert.ok(app._buildOptimizerArgs(app.form).includes(`fused=${choice === 'false' ? 'False' : 'True'}`));
      app.form.optimizer_type = 'AdamW8bit';
      assert.equal(app._fieldShowIfMet(field), false);
      assert.equal(app._collectTrainingPayload().adamw_fused, undefined);
    }
  }
  const { context } = preview('krea2-lora', 'networks.lora_krea2', { optimizer_type: 'AdamW' });
  const fields = context.window.getVisibleSections('krea2-lora').flatMap(section => section.fields);
  assert.equal(fields.filter(field => ['adamw_fused', 'krea_adamw_fused'].includes(field.key)).length, 1);
});
