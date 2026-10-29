const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, composeMixins, deferred, response } = require('./helpers.cjs');

function application(fetch) {
  const { window } = loadFrontend(TRAINING_CORE_SCRIPTS, {
    window: {}, fetch, document: { getElementById: () => null, querySelector: () => null },
  });
  return composeMixins(window.trainingCoreMixin, { form: {}, $nextTick: callback => callback() });
}

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

test('native picker sends the selected application language', async () => {
  let url;
  const app = application(async value => { url = value; return response({path: './models/vae.safetensors'}); });
  app.locale = 'ja-JP';
  app.currentRoute = 'train-basic';
  app.form = {model_train_type: 'anima-lora', vae: ''};
  app.setField = (key, value) => { app.form[key] = value; };
  await app.localFilePicker('vae', 'file-model');
  assert.match(url, /picker_type=model-file&locale=ja-JP/);
  assert.equal(app.form.vae, './models/vae.safetensors');
});
