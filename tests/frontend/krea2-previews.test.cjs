const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, loadFrontend } = require('./helpers.cjs');

function application(values = {}) {
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-core',
    'training-toml', 'training-lr-preview', 'training-shape-preview'], {
    window: {}, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated schema'); },
  });
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin,
    w.trainingLrPreviewMixin, w.trainingShapePreviewMixin, {
      t: (key, fallback) => fallback || key,
      _openManagedModal(key) { this[key] = true; },
      _closeManagedModal(key) { this[key] = false; },
    });
  app.form = { ...app._buildFormDefaults('krea2-lora'), model_train_type: 'krea2-lora', ...values };
  return { app, w };
}

test('Krea previews open with only the DiT rate and retain quantization in shape requests', () => {
  const { app } = application({ krea_training_duration_mode: 'steps', max_train_steps: 120,
    unet_lr: 999, text_encoder_lr: 999, fp8_base: true });
  app.openLrPreview();
  assert.equal(app.lrPreviewOpen, true);
  assert.equal(app.lrPreviewData.totalSteps, 120);
  assert.equal(app.lrPreviewData.chartRate, 1e-4);
  assert.equal(app.lrPreviewData.components.length, 1);
  assert.equal(app.lrPreviewData.unavailable, '');
  assert.equal(app.shapePreviewSupported(), true);
  assert.equal(app._shapeEstimatePayload().fp8_base, true);
  for (const optimizer of ['AdaFactor', 'schedulefree.AdamWScheduleFree', 'prodigyplus.ProdigyPlusScheduleFree']) {
    app.form.optimizer_type = optimizer;
    assert.equal(app._buildLrPreview().unavailable, 'lrPreview.internalNote');
  }
  app.form.krea_adafactor_relative_step = false;
  app.form.optimizer_type = 'AdaFactor';
  assert.equal(app._buildLrPreview().unavailable, '');
});

test('Krea default timescale follows the selected duration and the scheduler process count', () => {
  const { app } = application({ krea_training_duration_mode: 'steps', max_train_steps: 500,
    lr_warmup_steps: 0.1, gpu_ids: [0, 1] });
  app.stepEstimate = { total_steps: 9000, gpu_processes: 2 };
  assert.equal(app._defaultLrTimescale(), 100);
  app.form.lr_warmup_steps = 20;
  assert.equal(app._defaultLrTimescale(), 20);
  app.form.lr_warmup_steps = 0.1;
  app.form.krea_training_duration_mode = 'epochs';
  assert.equal(app._defaultLrTimescale(), 1800);
  app.stepEstimate = null;
  app.form.gpu_ids = [0];
  assert.equal(app._defaultLrTimescale(), 1000);
});

test('Krea LoRA+ previews use separate Down and Up learning rates', () => {
  const { app } = application({ enable_loraplus: true, loraplus_lr_ratio: 4,
    krea_training_duration_mode: 'steps', max_train_steps: 120, learning_rate: 0.001,
    lr_scheduler: 'cosine', lr_warmup_steps: 0.1 });
  assert.deepEqual(Array.from(app.lrPreviewComponents(), option => option.value), ['unet', 'unet_plus']);
  app.lrPreviewComponent = 'unet';
  const down = app._buildLrPreview();
  app.lrPreviewComponent = 'unet_plus';
  const up = app._buildLrPreview();
  assert.equal(down.chartRate, 0.001);
  assert.equal(up.chartRate, 0.004);
  assert.match(up.chartLabel, /lrPreview\.loraUpComponent$/);
  assert.equal(up.params.endRatio, down.params.endRatio);
  assert.equal(up.rateSource, 'learning_rate × loraplus_lr_ratio');
  app.form.network_module = 'lycoris.kohya';
  assert.equal(app.lrPreviewComponents().length, 1);
  assert.equal(app._buildLrPreview().chartRate, 0.001);
  app.form.lycoris_algo = 'lora';
  assert.deepEqual(Array.from(app.lrPreviewComponents(), option => option.value), ['unet', 'unet_plus']);
  app.lrPreviewComponent = 'unet_plus';
  assert.equal(app._buildLrPreview().chartRate, 0.004);
});

test('Krea missing-step previews provide a recovery note without progress-axis claims', () => {
  const { app } = application({ lr_scheduler: 'rex' });
  const preview = app._buildLrPreview();
  assert.equal(preview.unavailable, 'lrPreview.kreaStepCountRequiredNote');
  assert.deepEqual([...preview.notes], ['lrPreview.kreaStepCountRequiredNote']);
});

test('Krea open learning-rate previews follow LoCon and LoRA+ control changes', () => {
  const { app } = application({ krea_training_duration_mode: 'steps', max_train_steps: 120,
    learning_rate: 0.001 });
  Object.assign(app, { toast() {}, pushHistory() {}, _allShowIfKeys: () => [], updateTomlDebounced() {} });
  app.formDefaults = app._buildFormDefaults('krea2-lora');
  app.openLrPreview();
  app.setField('enable_loraplus', true);
  assert.equal(app.lrPreviewData.components.length, 2);
  app.setLrPreviewComponent('unet_plus');
  app.setField('loraplus_lr_ratio', 5);
  assert.equal(app.lrPreviewData.chartRate, 0.005);
  app.setField('network_module', 'lycoris.kohya');
  assert.equal(app.lrPreviewData.components.length, 1);
  app.setField('lycoris_algo', 'lora');
  assert.equal(app.lrPreviewData.components.length, 2);
  app.setLrPreviewComponent('unet_plus');
  assert.equal(app.lrPreviewData.chartRate, 0.005);
});

test('every Krea scheduler preview agrees with the real Musubi scheduler at every training step', () => {
  const { w } = application();
  const fields = w.getVisibleSections('krea2-lora').flatMap(section => section.fields);
  const names = fields.find(field => field.key === 'lr_scheduler').options.map(option => option.v);
  const cases = Array.from(names, lr_scheduler => ({ lr_scheduler, lr_warmup_steps:
    ['constant', 'piecewise_constant'].includes(lr_scheduler) ? 0 : 0.1,
    lr_decay_steps: 0.3, lr_scheduler_num_cycles: 3, lr_scheduler_power: 2,
    lr_scheduler_timescale: 40, lr_scheduler_min_lr_ratio: '', step_rules: '1:40,0.5:120,0.1',
    warmup_type: 'cosine', decay_type: '1-sqrt', gpu_ids: [0, 1],
  }));
  cases.push(...[0, 1, 20].map(lr_warmup_steps => ({ lr_scheduler: 'rex', lr_warmup_steps,
    lr_scheduler_min_lr_ratio: 0.2, gpu_ids: [0] })));
  const executable = path.join(ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(executable, ['-B', '-c', `
import json, sys
from pathlib import Path
from tools.runtime_paths import configure_test_paths
configure_test_paths()
sys.path[:0] = [str(Path('vendor/musubi-tuner/src').resolve()), str(Path('vendor').resolve())]
import torch
from musubi_tuner.training.trainer_base import NetworkTrainer
from musubi_tuner.training.parser_common import setup_parser_common
from backend.training.musubi_krea2 import KREA2_FIELDS, build_krea2_train_config, validate_krea2_config
results = []
for case in json.load(sys.stdin):
    form = {f['key']: f['default'] for f in KREA2_FIELDS if 'default' in f}
    form.update(model_train_type='krea2-lora', krea_training_duration_mode='steps', max_train_steps=100, optimizer_type='AdamW')
    form.update(case)
    assert not validate_krea2_config(form), validate_krea2_config(form)
    native = build_krea2_train_config(form, 'dataset.toml', 'output', 'log')
    args = setup_parser_common().parse_args([])
    for key, value in native.items(): setattr(args, key, value)
    processes = len(case['gpu_ids'])
    optimizer = torch.optim.AdamW([torch.nn.Parameter(torch.ones(1))], lr=1e-4)
    scheduler = NetworkTrainer().get_lr_scheduler(args, optimizer, processes)
    rates = []
    for step in range(100 * processes + 1):
        if step % processes == 0: rates.append(scheduler.get_last_lr()[0] / 1e-4)
        optimizer.step()
        scheduler.step()
    results.append(rates)
print(json.dumps(results))
`], { cwd: ROOT, input: JSON.stringify(cases), encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const expected = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  cases.forEach((values, index) => {
    const { app } = application({ ...values, optimizer_type: 'AdamW', krea_training_duration_mode: 'steps', max_train_steps: 100 });
    const preview = app._buildLrPreview();
    assert.equal(preview.unavailable, '', values.lr_scheduler);
    expected[index].forEach((rate, step) => {
      const actual = app._lrPreviewMultiplier(step / 100, preview.params);
      assert.ok(Math.abs(actual - rate) < 1e-8, `${values.lr_scheduler} step ${step}: ${actual} != ${rate}`);
    });
  });
});

test('Krea timestep previews honor direct ranges, reversed sigma indices, and degenerate distributions', () => {
  const { app } = application({ timestep_sampling: 'uniform', min_timestep: 100, max_timestep: 300 });
  let preview = app._buildTimestepPreview();
  assert.equal(preview.median, 200);
  assert.ok(preview.lowPercent > 99.99);
  app.form.timestep_sampling = 'sigma';
  preview = app._buildTimestepPreview();
  assert.equal(preview.median, 800);
  assert.ok(preview.highPercent > 99.99);
  app.form.timestep_sampling = 'sigmoid';
  app.form.sigmoid_scale = 0;
  preview = app._buildTimestepPreview();
  assert.equal(preview.fixedTimestep, 200);
  app.form.sigmoid_scale = 1;
  app.form.preserve_distribution_shape = true;
  preview = app._buildTimestepPreview();
  assert.ok(preview.lowPercent > 99.99);
  assert.ok(preview.median > 100 && preview.median < 300);
});
