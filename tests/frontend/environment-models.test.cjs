const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function application() {
  return loadFrontend('environment-render').window.environmentRenderMixin;
}

function kreaFiles(...models) {
  return [
    ...models.map(filename => ({ filename, component_type: 'model', exists: true })),
    { filename: 'qwen3vl_4b_bf16.safetensors', component_type: 'encoder', exists: true },
    { filename: 'qwen_image_vae.safetensors', component_type: 'vae', exists: true },
  ];
}

test('either Krea RAW variant completes the training components, while Turbo alone does not', () => {
  const app = application();
  const turbo = 'krea2_turbo_bf16.safetensors';
  for (const raw of ['krea2_raw_bf16.safetensors', 'krea2_raw_int8_convrot.safetensors']) {
    assert.deepEqual(Array.from(app._envModelMissingComponents(kreaFiles(raw), 'Krea 2')), []);
    assert.deepEqual(Array.from(app._envModelMissingComponents(kreaFiles(raw, turbo), 'Krea 2')), []);
  }
  assert.deepEqual(Array.from(app._envModelMissingComponents(kreaFiles(turbo), 'Krea 2')), ['model']);
});

test('multiple RAW variants do not hide a missing text encoder or VAE', () => {
  const app = application();
  const files = kreaFiles('krea2_raw_bf16.safetensors', 'krea2_raw_int8_convrot.safetensors');
  for (const component of ['encoder', 'vae']) {
    const remaining = files.filter(file => file.component_type !== component);
    assert.deepEqual(Array.from(app._envModelMissingComponents(remaining, 'Krea 2')), [component]);
  }
});

test('preview LoRA is optional and cannot replace the training base', () => {
  const app = application();
  const preview = {
    filename: 'krea2_turbo_lora_rank_64_bf16_kohya.safetensors', component_type: 'lora', exists: true,
  };
  assert.equal(app._envModelFileComponent(preview), 'lora');
  assert.deepEqual(Array.from(app._envModelMissingComponents([...kreaFiles(), preview], 'Krea 2')), ['model']);
  assert.deepEqual(Array.from(app._envModelMissingComponents(kreaFiles('krea2_raw_int8_convrot.safetensors'), 'Krea 2')), []);
});
