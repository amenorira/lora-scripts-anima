const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: { TRAIN_GROUP_MAP: { 'anima-lora': 'anima' } } };
for (const file of ['config.js', 'training-core.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file), 'utf8'), context);
}
const fields = context.window.getVisibleSections('anima-lora').flatMap(section => section.fields || []);
const ui = Object.assign({}, context.window.trainingCoreMixin, { t: key => key });

test('LoKr rank dropout hint follows the active network after switching modules', () => {
  const field = fields.find(item => item.key === 'rank_dropout');
  const values = { network_module: 'lycoris.kohya', lycoris_algo: 'lokr' };
  const resolve = () => ui._resolveFieldHintKey(field, values, 'anima-lora');
  assert.equal(resolve(), 'field.rank_dropoutHint_lokr');
  for (const module of ['networks.lora_anima', 'networks.lora', 'networks.loha', 'networks.lokr']) {
    values.network_module = module;
    assert.equal(resolve(), 'field.rank_dropoutHint', module);
  }
  values.network_module = 'lycoris.kohya';
  assert.equal(resolve(), 'field.rank_dropoutHint_lokr');
  for (const algo of ['lora', 'loha']) {
    values.lycoris_algo = algo;
    assert.equal(resolve(), 'field.rank_dropoutHint', algo);
  }
});
