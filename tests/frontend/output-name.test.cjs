const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

function application(profile = 'anima-lora', values = {}) {
  const { window: w } = loadFrontend(['shared/constants', 'shared/utils', 'app/config', ...TRAINING_CORE_SCRIPTS, 'training/toml'], {
    window: {}, document: { getElementById: () => null, querySelectorAll: () => [] }, btoa, TextEncoder,
  });
  const history = [];
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, {
    t: key => key, toast() {}, pushHistory: form => history.push(form), _persistProfileFieldSources() {},
    updateTomlDebounced() { this.tomlUpdates = (this.tomlUpdates || 0) + 1; },
    scheduleOutputPathInfo() { this.pathUpdates = (this.pathUpdates || 0) + 1; },
  });
  app.formDefaults = app._buildFormDefaults(profile);
  app.form = { ...app.formDefaults, model_train_type: profile, train_data_dir: 'D:\\训练集\\lanyin reine\\',
    optimizer_type: 'prodigyplus.ProdigyPlusScheduleFree', network_dim: 16, ...values };
  app.formErrors = {};
  return { app, history };
}

test('quick naming uses folder basename and optimizer shorthand across profiles and native networks', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app } = application(profile);
    assert.equal(app.suggestedOutputName(), 'lanyin reine_ppsf_lora_dim16');
  }
  const { app } = application();
  for (const [module, type] of [['networks.lora', 'lora'], ['networks.loha', 'loha'], ['networks.lokr', 'lokr']]) {
    Object.assign(app.form, { network_module: module, lokr_factor: 4, full_matrix: true });
    assert.equal(app.suggestedOutputName(), `lanyin reine_ppsf_${type}_${type === 'lokr' ? 'f4' : ''}dim16`);
  }
  for (const [optimizer, name] of [
    ['AdamW8bit', 'adamw8bit'], ['schedulefree.AdamWScheduleFree', 'adamwsf'],
    ['AdamWScheduleFree', 'adamwsf'], ['prodigyopt.Prodigy', 'prodigy'],
    ['vendor.lora_muon.LoRA_Muon', 'loramuon'], ['pytorch_optimizer.CAME', 'came'],
    ['vendor.automagic_optimizer.integration.Automagic3', 'automagic'],
  ]) {
    Object.assign(app.form, { optimizer_type: optimizer, network_module: 'networks.lora_anima' });
    assert.equal(app.suggestedOutputName(), `lanyin reine_${name}_lora_dim16`);
  }
});

test('LyCORIS names use the active algorithm and explicit full matrix setting', () => {
  const { app } = application('anima-lora', { network_module: 'lycoris.kohya', lycoris_algo: 'lokr',
    lokr_factor: 4, network_dim: 64 });
  assert.equal(app.suggestedOutputName(), 'lanyin reine_ppsf_lokr_f4dim64');
  Object.assign(app.form, { lokr_factor: 8, full_matrix: true });
  assert.equal(app.suggestedOutputName(), 'lanyin reine_ppsf_lokr_f8full');
  app.form.lycoris_algo = 'loha';
  assert.equal(app.suggestedOutputName(), 'lanyin reine_ppsf_loha_dim64');
  app.form.lycoris_algo = 'lora';
  assert.equal(app.suggestedOutputName(), 'lanyin reine_ppsf_lora_dim64');
  Object.assign(app.form, { lycoris_algo: 'lokr', full_matrix: false });
  for (const factor of [-1, '', null]) {
    app.form.lokr_factor = factor;
    assert.equal(app.suggestedOutputName(), 'lanyin reine_ppsf_lokr_fautodim64');
  }
  for (const factor of [0, -2, 1.5, 'bad', Infinity]) {
    app.form.lokr_factor = factor;
    assert.equal(app.suggestedOutputName(), '');
  }
});

test('folder names support Windows, POSIX, Unicode and filename cleanup; invalid inputs do not overwrite names', () => {
  const { app, history } = application();
  for (const [path, folder] of [
    ['/data/兰音/', '兰音'], ['\\\\server\\share\\dataset\\', 'dataset'],
    ['./train', 'train'], ['/data/a:b?c. ', 'a_b_c'],
  ]) {
    app.form.train_data_dir = path;
    assert.equal(app.suggestedOutputName(), `${folder}_ppsf_lora_dim16`);
  }
  for (const path of ['', ' ', '/', 'C:\\', '.', '..', '/data/..']) {
    app.form.train_data_dir = path;
    assert.equal(app.suggestedOutputName(), '');
    app.applySuggestedOutputName();
  }
  app.form.train_data_dir = './train';
  for (const dim of ['', null, 'bad', 0, 2.5, Infinity]) {
    app.form.network_dim = dim;
    assert.equal(app.suggestedOutputName(), '');
    app.applySuggestedOutputName();
  }
  assert.equal(history.length, 0);
  assert.equal(app.form.output_name, app.formDefaults.output_name);
});

test('clicking quick name preserves edit, path checking and undo pipelines without linking future edits', () => {
  const { app, history } = application('anima-lora', { output_name: 'custom_name' });
  history.push({ ...app.form });
  app.applySuggestedOutputName();
  assert.equal(app.form.output_name, 'lanyin reine_ppsf_lora_dim16');
  assert.equal(app._fieldSources.output_name, 'user');
  assert.equal(app.tomlUpdates, 1);
  assert.equal(app.pathUpdates, 1);
  app.form.network_dim = 64;
  assert.equal(app.form.output_name, 'lanyin reine_ppsf_lora_dim16');
  assert.equal(app.suggestedOutputName(), 'lanyin reine_ppsf_lora_dim64');
  app.formHistory = history;
  app.formHistoryIdx = history.length - 1;
  app.undoField('output_name');
  assert.equal(app.form.output_name, 'custom_name');
});

test('quick name renders beside the name input with a reactive preview and disabled state', () => {
  const { app } = application();
  const field = app._fieldDefinition('output_name');
  const html = app.renderField(field);
  assert.ok(html.indexOf('applySuggestedOutputName()') < html.indexOf('<input type="text"'));
  assert.match(html, /:disabled="!suggestedOutputName\(\)"/);
  assert.match(html, /:title="suggestedOutputName\(\)/);
  assert.equal(app._renderFieldQuickActions({ ...field, readonly: true }), '');
  assert.equal(app._renderFieldQuickActions(app._fieldDefinition('train_data_dir')), '');
});
