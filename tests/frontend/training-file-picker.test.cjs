const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, composeMixins, deferred, response, readRepo } = require('./helpers.cjs');

const dictionaries = Object.fromEntries(['zh-CN', 'en-US', 'ja-JP'].map(locale =>
  [locale, JSON.parse(readRepo(`frontend/i18n/${locale}.json`))]));

function application(fetch) {
  const { window } = loadFrontend(['shared/utils', ...TRAINING_CORE_SCRIPTS], {
    window: {}, fetch, URLSearchParams, document: { getElementById: () => null, querySelector: () => null },
  });
  return composeMixins(window.utilsMixin, window.trainingCoreMixin, {
    form: {}, locale: 'en-US', $nextTick: callback => callback(),
    t(key) { return key.split('.').reduce((value, part) => value?.[part], dictionaries[this.locale]) ?? key; },
  });
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

test('native picker sends labels from the active translation JSON', async () => {
  let url;
  const app = application(async value => { url = value; return response({path: './models/vae.safetensors'}); });
  app.currentRoute = 'train-basic';
  app.form = {model_train_type: 'anima-lora', vae: ''};
  app.setField = (key, value) => { app.form[key] = value; };
  for (const locale of Object.keys(dictionaries)) {
    app.locale = locale;
    await app.localFilePicker('vae', 'file-model');
    assert.equal(app.form.vae, './models/vae.safetensors');
    const params = new URL(url, 'http://fixture').searchParams;
    assert.equal(params.get('title'), dictionaries[locale].nativePicker['model-file'].title);
    for (const type of ['folder', 'model-file', 'text-file', 'image-file']) {
      const params = new URL(app.nativePickerUrl(type), 'http://fixture').searchParams;
      assert.equal(params.get('picker_type'), type);
      assert.equal(params.get('title'), dictionaries[locale].nativePicker[type].title);
      assert.equal(params.get('file_type_label'), dictionaries[locale].nativePicker[type].files ?? null);
      assert.equal(params.get('all_files_label'), type === 'folder' ? null : dictionaries[locale].nativePicker.allFiles);
    }
  }
  app.t = () => '标题 & type=other + # /';
  assert.equal(new URL(app.nativePickerUrl('text-file'), 'http://fixture').searchParams.get('title'), app.t());
});

test('caption text picker uses the same translated request', async () => {
  const app = application();
  const { window } = loadFrontend(['tagger/ai-caption-options'], {
    window: {}, fetch: async url => {
      assert.equal(url, app.nativePickerUrl('text-file'));
      return response({path: './prompts.txt'});
    },
  });
  const caption = composeMixins(app, window.captionOptionsMixin, {captionOptions: {}, saveCaptionOptions() {}});
  await caption.pickCaptionPath('prompt_file');
  assert.equal(caption.captionOptions.prompt_file, './prompts.txt');
});
