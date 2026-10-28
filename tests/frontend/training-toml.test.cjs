const test = require('node:test');
const assert = require('node:assert/strict');

const { TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

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
