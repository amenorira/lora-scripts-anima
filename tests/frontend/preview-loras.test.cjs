const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, deferred, response } = require('./helpers.cjs');

function application(fetch = async () => response({ files: [] })) {
  const { window } = loadFrontend(['training/preview-loras', 'training/file-picker'], {
    window: {}, fetch, document: { getElementById: () => null, querySelector: () => null },
  });
  return composeMixins(window.trainingPreviewLoras, window.trainingFilePicker, {
    form: { model_train_type: 'anima-lora', preview_loras: [] }, currentRoute: 'train-basic',
    setField(key, value) { this.form[key] = value; }, $nextTick: callback => callback(),
    nativePickerUrl: () => '/native', t: key => key, toast() {},
  });
}

test('rows keep independent strengths and use immutable edits', () => {
  const app = application();
  app.addPreviewLora(); app.addPreviewLora();
  const before = app.form.preview_loras;
  app.updatePreviewLora(0, 'multiplier', '-0.25');
  app.updatePreviewLora(1, 'path', 'second.safetensors');
  assert.equal(before[0].multiplier, 1);
  assert.equal(app.form.preview_loras[0].multiplier, '-0.25');
  assert.equal(app.form.preview_loras[1].multiplier, 1);
  app.removePreviewLora(0);
  assert.equal(app.form.preview_loras[0].path, 'second.safetensors');
});

test('native and built-in pickers edit the chosen row without replacing the list', async () => {
  const app = application(async () => response({ path: 'native.safetensors', files: [] }));
  app.addPreviewLora(); app.addPreviewLora();
  await app.pickPreviewLora(1, true);
  assert.equal(app.form.preview_loras[1].path, 'native.safetensors');
  await app.pickPreviewLora(0);
  app.pickFileFromModal({ path: 'builtin.safetensors' });
  assert.equal(app.form.preview_loras[0].path, 'builtin.safetensors');
  assert.equal(app.form.preview_loras[1].path, 'native.safetensors');
});

test('late picker results cannot write into a removed or replaced row', async () => {
  for (const native of [true, false]) {
    const pending = deferred();
    const app = application(() => pending.promise);
    app.addPreviewLora(); app.addPreviewLora();
    const request = app.pickPreviewLora(0, native);
    app.removePreviewLora(0);
    pending.resolve(response({ path: 'late.safetensors', files: [] }));
    await request;
    if (!native) app.pickFileFromModal({ path: 'late.safetensors' });
    assert.equal(app.form.preview_loras[0].path, '');
  }
});

test('native picker tolerates edits to other rows and newly added rows', async () => {
  const pending = deferred();
  const app = application(() => pending.promise);
  app.addPreviewLora(); app.addPreviewLora();
  const request = app.pickPreviewLora(0, true);
  app.updatePreviewLora(1, 'multiplier', '-0.4');
  app.addPreviewLora();
  pending.resolve(response({ path: 'chosen.safetensors' }));
  await request;
  assert.equal(app.form.preview_loras[0].path, 'chosen.safetensors');
  assert.equal(app.form.preview_loras[1].multiplier, '-0.4');
  assert.equal(app.form.preview_loras.length, 3);
});
