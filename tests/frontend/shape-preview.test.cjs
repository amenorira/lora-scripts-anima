const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo } = require('./helpers.cjs');

function fixture() {
  const timers = new Map();
  const pending = [];
  let timerId = 0;
  const context = {
    window: {}, AbortController,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      if (url === '/api/fields') return Promise.reject(new Error('Use generated schema'));
      return new Promise((resolve, reject) => {
        pending.push({ url, options, resolve, reject });
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  loadFrontend(['constants', 'utils', 'config', 'training-core', 'training-toml', 'training-shape-preview'], context);
  const app = Object.assign({}, context.window.trainingCoreMixin, context.window.trainingTomlMixin, context.window.trainingShapePreviewMixin, {
    form: { model_train_type: 'anima-lora', network_dim: 32 },
    t: key => key, _openManagedModal() {},
  });
  const fire = delay => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `Missing ${delay} ms timer`);
    timers.delete(entry[0]);
    return entry[1].callback();
  };
  const reply = (index, groups = [{ id: 'q', name: 'blocks.*.self_attn.q_proj' }]) => pending[index].resolve({
    ok: true,
    json: async () => ({ status: 'success', data: {
      estimatedBytes: 1024, groups,
    } }),
  });
  return { app, pending, timers, fire, reply };
}

test('a stalled estimate stops loading on timeout and can be retried from the preview button', async () => {
  const { app, pending, timers, fire, reply } = fixture();
  app.scheduleShapeEstimate();
  const request = fire(500);
  assert.equal(app.shapeEstimateLoading, true);
  fire(15000);
  await request;
  assert.equal(pending[0].options.signal.aborted, true);
  assert.equal(app.shapeEstimateLoading, false);
  assert.equal(app._shapeEstimateBusy, false);
  assert.equal(app.shapeEstimateError, 'shapePreview.estimateTimeout');

  app.openShapePreview();
  const retry = fire(500);
  reply(1);
  await retry;
  assert.equal(app.shapeEstimateError, '');
  assert.equal(app.shapeEstimate.estimatedBytes, 1024);
  assert.equal(app.shapePreviewSelected, 'q');
  assert.equal(timers.size, 0);
});

test('MOSS previews include text embedder changes and discard stale estimates across profile switches', async () => {
  const { app, pending, fire, reply } = fixture();
  app.form = { model_train_type: 'moss-image-lora', network_module: 'networks.lora_generic',
    network_dim: 16, network_alpha: 1, train_text_embedder: false, save_precision: 'bf16',
    network_train_unet_only: true, network_args_custom: "exclude_patterns=['layers.0.*']" };
  assert.equal(app.shapePreviewSupported(), true);
  assert.match(app._shapePreviewEntry(), /openShapePreview/);
  app.scheduleShapeEstimate();
  const first = fire(500);
  const payload = JSON.parse(pending[0].options.body);
  assert.equal(payload.train_text_embedder, false);
  assert.equal(payload.network_args_custom, app.form.network_args_custom);

  app.form.train_text_embedder = true;
  app.scheduleShapeEstimate();
  fire(500);
  reply(0);
  await first;
  assert.equal(app.shapeEstimate, null);
  assert.equal(pending.length, 2);
  assert.equal(JSON.parse(pending[1].options.body).train_text_embedder, true);
  reply(1, [{ id: 'text', name: 'text_embedder.proj' }, { id: 'moss-q', name: 'layers.*.proj.q' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.shapePreviewSelected, 'moss-q');
  assert.match(app.shapeEstimateSummary(), /1.00 KiB/);

  app.form.network_dim = 32;
  app.form.save_precision = 'float';
  app.scheduleShapeEstimate();
  const third = fire(500);
  assert.equal(JSON.parse(pending[2].options.body).network_dim, 32);
  assert.equal(JSON.parse(pending[2].options.body).save_precision, 'float');
  app.form.model_train_type = 'sdxl-lora';
  app.scheduleShapeEstimate();
  reply(2);
  await third;
  assert.equal(app.shapeEstimate, null);
  assert.equal(app.shapeEstimateLoading, false);
  assert.equal(app._shapePreviewEntry(), '');
});

test('MOSS fused projections and DiT text layers render with localized families and actual dimensions', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const messages = JSON.parse(readRepo(`frontend/i18n/${locale}.json`)).shapePreview;
    const context = loadFrontend(['utils', 'training-core', 'preview-select', 'training-shape-preview'], {
      window: {}, document: { addEventListener() {} },
    });
    const app = Object.assign({}, context.window.utilsMixin, context.window.trainingShapePreviewMixin, {
      escapeAttr: context.window.trainingCoreMixin.escapeAttr,
      form: { model_train_type: 'moss-image-lora' },
      t: key => key.startsWith('shapePreview.') ? messages[key.slice('shapePreview.'.length)] || key : key,
    });
    const cases = [
      ['layers.*.proj.q', messages.selfAttention, messages.qProjection, 3072, 3072],
      ['layers.*.proj.ffn_up_gate', 'MLP', messages.mlpExpandGate, 3072, 16384],
      ['text_embedder.proj', messages.textEmbedder, messages.inputProjection, 4096, 3072],
      ['text_embedder.blocks.*.qkv', `${messages.textEmbedder} / ${messages.selfAttention}`, messages.qkvProjection, 3072, 9216],
      ['text_embedder.blocks.*.ffn_gate', `${messages.textEmbedder} / MLP`, messages.mlpGate, 3072, 8192],
    ];
    for (const [name, family, label, inDim, outDim] of cases) {
      const group = { id: name, name, in: inDim, out: outDim, algo: 'lora', rank: 16, alpha: 1,
        scale: 1 / 16, count: 2, params: (inDim + outDim) * 16, weightBytes: ((inDim + outDim) * 16 + 1) * 2,
        shapes: { 'lora_down.weight': [16, inDim], 'lora_up.weight': [outDim, 16], alpha: [] }, paths: [name] };
      assert.equal(app._shapeModuleLabel(group).family, family);
      assert.equal(app._shapeModuleLabel(group).label, label);
      app.shapeEstimate = { groups: [group], module: 'networks.lora_generic', params: group.params * 2,
        estimatedBytes: group.weightBytes * 2 + 1024, moduleCount: 2, precision: 'bf16' };
      app.shapePreviewSelected = name;
      const html = app.shapePreviewHtml();
      assert.ok(html.includes(`${outDim} × 16`));
      assert.ok(html.includes(`16 × ${inDim}`));
      assert.ok(html.includes(label));
      assert.doesNotMatch(html, /undefined|NaN|shapePreview\./);
    }
  }
});

test('MOSS LoHa and both LoKr modes render their actual matrices in all locales', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const messages = JSON.parse(readRepo(`frontend/i18n/${locale}.json`)).shapePreview;
    const context = loadFrontend(['utils', 'training-core', 'preview-select', 'training-shape-preview'], {
      window: {}, document: { addEventListener() {} },
    });
    const app = Object.assign({}, context.window.utilsMixin, context.window.trainingShapePreviewMixin, {
      escapeAttr: context.window.trainingCoreMixin.escapeAttr,
      form: { model_train_type: 'moss-image-lora' },
      t: key => key.startsWith('shapePreview.') ? messages[key.slice('shapePreview.'.length)] || key : key,
    });
    for (const name of ['layers.*.proj.q', 'text_embedder.blocks.*.qkv']) {
      const inDim = 3072, outDim = name.includes('qkv') ? 9216 : 3072;
      const variants = [
        { algo: 'loha', rank: 16, alpha: 1, scale: 1 / 16, shapes: {
          hada_w1_a: [outDim, 16], hada_w1_b: [16, inDim], hada_w2_a: [outDim, 16], hada_w2_b: [16, inDim], alpha: [],
        } },
        { algo: 'lokr', rank: 16, alpha: 1, scale: 1 / 16, factor: 8, w2Full: false, shapes: {
          lokr_w1: [8, 8], lokr_w2_a: [outDim / 8, 16], lokr_w2_b: [16, inDim / 8], alpha: [],
        } },
        { algo: 'lokr', rank: 256, alpha: 256, scale: 1, factor: 8, w2Full: true, shapes: {
          lokr_w1: [8, 8], lokr_w2: [outDim / 8, inDim / 8], alpha: [],
        } },
      ];
      for (const variant of variants) {
        const params = Object.entries(variant.shapes).filter(([key]) => key !== 'alpha')
          .reduce((sum, [, shape]) => sum + shape.reduce((a, b) => a * b, 1), 0);
        const group = { id: name, name, in: inDim, out: outDim, count: 2, params,
          weightBytes: (params + 1) * 2, paths: [name], ...variant };
        app.shapeEstimate = { groups: [group], module: `networks.${variant.algo}`, params: params * 2,
          estimatedBytes: group.weightBytes * 2 + 1024, moduleCount: 2, precision: 'bf16',
          fullW2Count: variant.w2Full ? 2 : 0 };
        app.shapePreviewSelected = name;
        const html = app.shapePreviewHtml();
        assert.match(html, variant.algo === 'loha' ? /LoHa/ : /LoKr/);
        assert.ok(html.includes(variant.algo === 'loha' ? `${outDim} × 16` : `${outDim / 8} ×`));
        assert.ok(html.includes(variant.algo === 'loha' ? messages.legendHadamard : messages.legendKron));
        assert.doesNotMatch(html, /undefined|NaN|shapePreview\./);
      }
    }
  }
});

test('changing the MOSS algorithm or LoKr factor refreshes the estimate payload', async () => {
  const { app, pending, fire, reply } = fixture();
  app.form = { model_train_type: 'moss-image-lora', network_module: 'networks.loha',
    train_text_embedder: true, network_dim: 16, network_alpha: 1 };
  for (const [module, factor] of [['networks.loha', -1], ['networks.lokr', -1], ['networks.lokr', 8]]) {
    Object.assign(app.form, { network_module: module, lokr_factor: factor });
    app.scheduleShapeEstimate();
    assert.equal(app.shapeEstimate, null);
    const request = fire(500);
    const index = pending.length - 1;
    const payload = JSON.parse(pending[index].options.body);
    assert.equal(payload.network_module, module);
    assert.equal(payload.lokr_factor, module === 'networks.lokr' && factor !== -1 ? factor : undefined);
    assert.equal(payload.train_text_embedder, true);
    reply(index, [{ id: 'q', name: 'layers.*.proj.q' }]);
    await request;
  }
  assert.equal(pending.length, 3);
});
