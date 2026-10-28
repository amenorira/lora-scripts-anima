const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TRAINING_CORE_SCRIPTS, ROOT, loadFrontend } = require('./helpers.cjs');

function application(profile = 'moss-image-lora', values = {}) {
  const { window: w } = loadFrontend(['constants', 'utils', 'config', 'training-timestep-model', ...TRAINING_CORE_SCRIPTS, 'training-toml', 'training-config-io'], {
    window: {}, document: { getElementById: () => null }, clearTimeout,
  });
  w.t = key => key;
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, w.trainingConfigIoMixin, {
    t: key => key, updateToml() {}, rebuildForm() {}, _persistProfileDrafts() {},
    _persistProfileFieldSources() {}, $nextTick: fn => fn(),
  });
  app.formDefaults = app._buildFormDefaults(profile);
  app.form = { ...app.formDefaults, model_train_type: profile, ...values };
  app.trainTypes = ['anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora'].map(v => ({ v }));
  return { app, w };
}

test('new MOSS presets, sparse old snapshots and explicit imports keep their respective schedules', async () => {
  const { app, w } = application();
  assert.equal(app.form.timestep_sampling, 'truncated_logit_normal');
  assert.equal(app.form.weighting_scheme, 'uniform');
  assert.equal(app._profileFormFromDraft('moss-image-lora', app.formDefaults, {}).timestep_sampling, 'truncated_logit_normal');
  const sparse = app._profileFormFromDraft('moss-image-lora', app.formDefaults, { output_name: 'legacy' });
  assert.equal(sparse.timestep_sampling, 'sigma');
  assert.equal(sparse.weighting_scheme, 'logit_normal');
  await app._applyImportedFlatConfig({ model_train_type: 'moss-image-lora', timestep_sampling: 'sigma',
    weighting_scheme: 'logit_normal', logit_mean: -0.4, logit_std: 0.8 });
  assert.equal(app.form.timestep_sampling, 'sigma');
  assert.equal(app.form.logit_mean, -0.4);
  for (const profile of ['sdxl-lora', 'krea2-lora']) {
    const fields = w.getVisibleSections(profile).flatMap(section => section.fields);
    assert.ok(!fields.some(field => field.key === 'timestep_cutoff'));
    assert.ok(!fields.find(field => field.key === 'timestep_sampling')?.options.some(option => option.v === 'truncated_logit_normal'));
  }
});

test('new controls stay visible with uniform loss weighting and old sigma controls still work', () => {
  const { app } = application();
  const fields = app._allSections().flatMap(section => section.fields);
  for (const key of ['logit_mean', 'logit_std', 'discrete_flow_shift', 'timestep_cutoff', 'timestep_uniform_ratio']) {
    assert.equal(app._fieldShowIfMet(fields.find(field => field.key === key)), true, key);
  }
  app.form.timestep_sampling = 'sigma';
  assert.equal(app._fieldShowIfMet(fields.find(field => field.key === 'timestep_cutoff')), false);
  assert.equal(app.timestepOffsetSupported(), false);
  app.form.weighting_scheme = 'logit_normal';
  assert.equal(app.timestepOffsetSupported(), true);
  assert.equal(app._fieldShowIfMet(fields.find(field => field.key === 'logit_mean')), true);
});

test('INT8 fullgraph is accepted while swap and attention conflicts remain', () => {
  const { app } = application('moss-image-lora', { compile: true, compile_fullgraph: true, convrot_int8: true });
  assert.equal(Object.keys(app._mossOptionErrors()).length, 0);
  app.form.blocks_to_swap = 1;
  assert.ok(app._mossOptionErrors().compile_fullgraph);
  app.form.blocks_to_swap = 0;
  app.form.split_attn = true;
  assert.ok(app._mossOptionErrors().compile_fullgraph);
  app.form.split_attn = false;
  app.form.attn_mode = 'xformers';
  assert.ok(app._mossOptionErrors().compile_fullgraph);
});

test('active bounds are enforced and both new inputs refresh an open preview', () => {
  const { app } = application();
  for (const [key, value] of [['timestep_cutoff', 0], ['timestep_cutoff', 1.1],
    ['timestep_uniform_ratio', -1], ['timestep_uniform_ratio', 1.1], ['logit_std', 0]]) {
    const previous = app.form[key];
    app.form[key] = value;
    assert.ok(app._timestepOptionErrors()[key]);
    app.form[key] = previous;
  }
  Object.assign(app, { timestepPreviewOpen: true, toast() {}, pushHistory() {},
    _allShowIfKeys: () => [], updateTomlDebounced() {} });
  app.setField('timestep_cutoff', 0.8);
  assert.equal(app.timestepPreviewData.cutoffCard, '0.8');
  const before = app.timestepPreviewData.highPercent;
  app.setField('timestep_uniform_ratio', 1);
  assert.equal(app.timestepPreviewData.uniformRatioCard, '1');
  assert.notEqual(app.timestepPreviewData.highPercent, before);
  app.setField('timestep_cutoff', '');
  app.setField('timestep_uniform_ratio', '');
  assert.equal(app.timestepPreviewData.cutoffCard, '0.95');
  assert.equal(app.timestepPreviewData.uniformRatioCard, '0.01');
});

test('preview distributions and subset mixtures match actual upstream CPU sampling', () => {
  const cases = [
    {}, { discrete_flow_shift: 2 }, { discrete_flow_shift: 0.5 },
    { timestep_cutoff: 0.6, timestep_uniform_ratio: 0.15 },
    { timestep_cutoff: 1, timestep_uniform_ratio: 0 }, { timestep_uniform_ratio: 1 },
    { timestep_cutoff: 0.001 }, { timestep_cutoff: 0.004 }, { timestep_cutoff: 0.005 },
    { timestep_cutoff: 0.008 }, { timestep_cutoff: 0.01 },
    { offset: 0.4 }, { offset: -0.4 },
    { timestep_sampling: 'sigma', weighting_scheme: 'logit_normal', offset: 0.4 },
    { timestep_sampling: 'sigma', weighting_scheme: 'logit_normal', offset: -0.4 },
    { mixture: true }, { mixture: true, regularization: true },
  ].map(values => ({ timestep_sampling: 'truncated_logit_normal', weighting_scheme: 'uniform',
    logit_mean: -1.09, logit_std: 0.95, timestep_cutoff: 0.95, timestep_uniform_ratio: 0.01,
    discrete_flow_shift: 1, ...values }));
  const executable = path.join(ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(executable, ['-B', '-c', `
import json, sys
from pathlib import Path
from tools.runtime_paths import configure_test_paths
configure_test_paths()
sys.path.insert(0, str(Path('vendor/sd-scripts').resolve()))
import torch
from library import flux_train_utils as utils
from library.sd3_train_utils import FlowMatchEulerDiscreteScheduler
torch.set_num_threads(2)
torch.manual_seed(731)
results = []
for case in json.load(sys.stdin):
    count = 160000
    offsets = torch.full((count,), float(case.get('offset', 0)))
    if case.get('mixture'):
        offsets[:count // 4] = -0.4
        offsets[count // 4:count // 2 if case.get('regularization') else count] = 0.4
        if case.get('regularization'):
            offsets[count // 2:] = 0
    if case['timestep_sampling'] == 'sigma':
        u = utils.compute_density_for_timestep_sampling('logit_normal', count,
            case['logit_mean'], case['logit_std'], logit_offset=-offsets)
        indices = (u * 1000).long()
    else:
        indices = utils.sample_truncated_logit_normal_indices(count, 1000,
            case['logit_mean'], case['logit_std'], case['timestep_cutoff'],
            case['timestep_uniform_ratio'], -offsets)
    scheduler = FlowMatchEulerDiscreteScheduler(num_train_timesteps=1000, shift=case['discrete_flow_shift'])
    sigmas = scheduler.sigmas[indices]
    results.append(dict(low=(sigmas < 1/3).float().mean().item()*100,
        high=(sigmas >= 2/3).float().mean().item()*100, median=sigmas.median().item()*1000))
print(json.dumps(results))
`], { cwd: ROOT, input: JSON.stringify(cases), encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const expected = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  cases.forEach((values, index) => {
    const { app } = application('moss-image-lora', values);
    app.stepEstimate = { subsets: [
      { name: '1_detail', is_reg: false, sample_count: 1 },
      { name: '3_structure', is_reg: false, sample_count: values.regularization ? 1 : 3 },
      ...(values.regularization ? [{ name: '1_detail', is_reg: true, sample_count: 2 }] : []),
    ] };
    app.form.subset_timestep_offsets = values.mixture
      ? { '1_detail': -0.4, '3_structure': 0.4 } : { '1_detail': values.offset || 0 };
    const preview = app._buildTimestepPreview(null, values.mixture ? 'overall' : '1_detail');
    for (const [actual, reference] of [[preview.lowPercent, expected[index].low], [preview.highPercent, expected[index].high]]) {
      assert.ok(Math.abs(actual - reference) < 0.65, `${JSON.stringify(values)}: ${actual} != ${reference}`);
    }
    assert.ok(Math.abs(preview.median - expected[index].median) < 7, `${JSON.stringify(values)}: median`);
    assert.ok(Math.abs(preview.lowPercent + preview.midPercent + preview.highPercent - 100) < 1e-8);
    assert.ok(preview.densities.every(value => Number.isFinite(value) && value >= -1e-12));
  });
});
