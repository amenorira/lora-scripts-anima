const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Anima and Krea dependency ordering preserves the registered training field order', () => {
  const context = { window: { TRAIN_GROUP_MAP: { 'anima-lora': 'anima', 'krea2-lora': 'krea2' } } };
  for (const file of ['config.js', 'training-core.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', file), 'utf8'), context);
  }
  const app = context.window.trainingCoreMixin;
  for (const profile of ['anima-lora', 'krea2-lora']) {
    const fields = context.window.getVisibleSections(profile).find(s => s.key === 'training').fields;
    const expected = Array.from(fields, f => f.key);
    assert.ok(expected.includes('weighting_scheme'));
    for (const key of ['logit_mean', 'logit_std', 'mode_scale']) {
      assert.ok(expected.indexOf(key) > expected.indexOf('weighting_scheme'), `${profile}: ${key}`);
    }
    assert.deepEqual(Array.from(app._orderFieldsByDependencies(fields), f => f.key), expected, profile);
  }
});
