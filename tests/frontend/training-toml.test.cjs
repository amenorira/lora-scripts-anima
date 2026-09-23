const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function preview(profile, module, overrides = {}) {
  const context = { window: {}, document: { getElementById: () => null },
    fetch: async () => { throw new Error('Use generated fallback schema'); } };
  vm.createContext(context);
  for (const file of ['constants', 'utils', 'config', 'training-core', 'training-toml']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file + '.js'), 'utf8'), context);
  }
  const w = context.window;
  const form = Object.fromEntries(w.getVisibleSections(profile).flatMap(s => s.fields).map(f => [f.key, f.default]));
  Object.assign(form, { model_train_type: profile, network_module: module, lycoris_algo: 'lokr',
    rank_dropout: 0.2, conv_dim: 8, conv_alpha: 4, lokr_factor: 4, use_tucker: true }, overrides);
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, {
    form, t: key => key, _renderTomlPreview() {},
  });
  app.updateToml();
  const match = app.tomlRaw.match(/^network_args = (.*)$/m);
  return { text: app.tomlRaw, args: match ? JSON.parse(match[1]) : [] };
}

test('native Anima dropout belongs to network_args, unsupported convolution fields stay out', () => {
  const { text, args } = preview('anima-lora', 'networks.lora_anima');
  assert.ok(args.includes('rank_dropout=0.2'));
  assert.ok(!args.some(s => /^(conv_dim|conv_alpha|factor|use_tucker)=/.test(s)));
  assert.doesNotMatch(text, /^(rank_dropout|conv_dim|conv_alpha|lokr_factor|use_tucker) =/m);
});

test('native LoRA, LoHa, LoKr and LyCORIS serialize supported fields without top-level leakage', () => {
  for (const module of ['networks.lora', 'networks.loha', 'networks.lokr', 'lycoris.kohya']) {
    const { text, args } = preview('sdxl-lora', module);
    for (const value of ['rank_dropout=0.2', 'conv_dim=8', 'conv_alpha=4']) assert.ok(args.includes(value), module + ': ' + value);
    assert.equal(args.includes('use_tucker=true'), module !== 'networks.lora');
    assert.equal(args.includes('factor=4'), ['networks.lokr', 'lycoris.kohya'].includes(module));
    assert.doesNotMatch(text, /^(rank_dropout|conv_dim|conv_alpha|lokr_factor|use_tucker) =/m);
  }
});
