const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, composeMixins, deferred, response } = require('./helpers.cjs');

function application(fetch) {
  const { window } = loadFrontend(TRAINING_CORE_SCRIPTS, {
    window: {}, fetch, document: { getElementById: () => null, querySelector: () => null },
  });
  return composeMixins(window.trainingCoreMixin, { form: {}, $nextTick: callback => callback() });
}

test('composed picker getters track file, filter and root changes', () => {
  const app = application();
  app.showFilePickerModal('vae', [
    { name: 'alpha', path: './models/a/alpha.safetensors' },
    { name: 'beta', path: './models/beta.safetensors' },
  ], 'model-file');
  assert.equal(app.filteredPickerFiles.length, 2);
  assert.equal(app.pickerGroups[0].dir, '');
  app._pickerFilter = 'ALPHA';
  assert.equal(app.filteredPickerFiles.length, 1);
  assert.equal(app.pickerGroups[0].dir, 'a');
  app._pickerFiles = [];
  assert.equal(app.filteredPickerFiles.length, 0);
  assert.equal(app.pickerGroups.length, 0);
});

test('late picker responses cannot replace a newer selection or reopen a closed browser', async () => {
  const first = deferred(), second = deferred();
  const pending = [first, second];
  const app = application(() => pending.shift().promise);
  const oldRequest = app.builtinFilePicker('vae', 'file-model');
  const newRequest = app.builtinFilePicker('train_data_dir', 'file-folder');
  second.resolve(response({ files: [{ name: 'dataset', path: './train/dataset' }] }));
  await newRequest;
  first.resolve(response({ files: [{ name: 'model', path: './models/model.safetensors' }] }));
  await oldRequest;
  assert.equal(app._pickerKey, 'train_data_dir');
  assert.equal(app.filteredPickerFiles[0].name, 'dataset');
  const last = deferred();
  pending.push(last);
  const closedRequest = app.builtinFilePicker('vae', 'file-model');
  app.closeFilePickerModal();
  last.resolve(response({ files: [{ name: 'closed', path: './models/closed.safetensors' }] }));
  await closedRequest;
  assert.equal(app.showFilePickerModalFlag, false);
  assert.equal(app._pickerFiles.length, 0);
});

test('native picker ignores results after the form, profile, route or field changes', async () => {
  for (const change of [
    app => { app.form = { model_train_type: 'krea2-lora', vae: 'krea-vae' }; },
    app => { app.form.model_train_type = 'krea2-lora'; },
    app => { app.currentRoute = 'settings'; },
    app => { app.form.vae = 'manually-selected'; },
    app => app._invalidateTrainingPickers(),
  ]) {
    const pending = deferred();
    const app = application(() => pending.promise);
    app.form = { model_train_type: 'anima-lora', vae: 'original' };
    app.currentRoute = 'train-basic';
    app.setField = () => assert.fail('stale picker must not edit the form');
    const choice = app.localFilePicker('vae', 'file-model');
    change(app);
    pending.resolve(response({ path: 'late-vae' }));
    await choice;
  }
});

test('native picker accepts only the latest request in the current form', async () => {
  const first = deferred(), second = deferred(), pending = [first, second];
  const app = application(() => pending.shift().promise);
  app.form = { model_train_type: 'anima-lora', vae: 'original' };
  app.setField = (key, value) => { app.form[key] = value; };
  const old = app.localFilePicker('vae', 'file-model');
  const current = app.localFilePicker('vae', 'file-model');
  first.resolve(response({ path: 'old' }));
  await old;
  assert.equal(app.form.vae, 'original');
  second.resolve(response({ path: 'selected' }));
  await current;
  assert.equal(app.form.vae, 'selected');
});
