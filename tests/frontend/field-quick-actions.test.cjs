const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend } = require('./helpers.cjs');

function application(profile = 'anima-lora', values = {}) {
  const { window: w } = loadFrontend(['shared/constants', 'shared/utils', 'app/config',
    ...TRAINING_CORE_SCRIPTS, 'training/toml'], {
    window: {}, document: { getElementById: () => null, querySelectorAll: () => [] }, btoa, TextEncoder,
  });
  const history = [];
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, w.trainingTomlMixin, {
    t: key => ({ 'common.setFieldValue': 'Set {field} to {value}' })[key] || key,
    toast() {}, pushHistory: form => history.push(form), _persistProfileFieldSources() {},
    updateTomlDebounced() { this.tomlUpdates = (this.tomlUpdates || 0) + 1; },
  });
  app.formDefaults = app._buildFormDefaults(profile);
  app.form = { ...app.formDefaults, model_train_type: profile, ...values };
  app.formErrors = {};
  return { app, w, history };
}

test('alpha shortcuts use the current dim once and preserve the normal edit pipeline in every profile', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app, history } = application(profile, { network_dim: 24, network_alpha: 8 });
    assert.equal(app._fieldDefinition('network_alpha').quickActions.length, 3);
    app.applyFieldQuickAction('network_alpha', 0);
    assert.equal(app.form.network_alpha, 24);
    app.setField('network_dim', '48');
    assert.equal(app.form.network_alpha, 24);
    assert.equal(app.fieldQuickActionValue('network_alpha', 0), 48);
    assert.match(app.fieldQuickActionTitle('network_alpha', 0), /Set network_alpha to 48/);
    app.applyFieldQuickAction('network_alpha', 0);
    app.applyFieldQuickAction('network_alpha', 1);
    assert.equal(app.form.network_alpha, 24);
    assert.equal(app._fieldSources.network_alpha, 'user');
    assert.equal(history.at(-2).network_alpha, 48);
    assert.equal(history.at(-1).network_alpha, 24);
    assert.equal(app.tomlUpdates, 4);
    app.formHistory = history;
    app.formHistoryIdx = history.length - 1;
    app.undoField('network_alpha');
    assert.equal(app.form.network_alpha, 48);
  }
});

test('alpha 1 shortcut is independent of dim and uses the normal edit and undo pipeline', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app, history } = application(profile, { network_dim: '', network_alpha: 8 });
    history.push({ ...app.form });
    assert.equal(app.fieldQuickActionValue('network_alpha', 2), 1);
    app.applyFieldQuickAction('network_alpha', 2);
    assert.equal(app.form.network_alpha, 1);
    assert.equal(app._fieldSources.network_alpha, 'user');
    assert.equal(app.tomlUpdates, 1);
    app.formHistory = history;
    app.formHistoryIdx = history.length - 1;
    app.undoField('network_alpha');
    assert.equal(app.form.network_alpha, 8);
  }
});

test('invalid sources and unsupported results never change a field or create history', () => {
  const { app, history } = application();
  for (const value of ['', ' ', null, undefined, true, 'bad', Infinity, NaN, 1, 25]) {
    app.form.network_dim = value;
    assert.equal(app.fieldQuickActionValue('network_alpha', 1), null, String(value));
    app.applyFieldQuickAction('network_alpha', 1);
  }
  assert.equal(app.form.network_alpha, 32);
  assert.equal(history.length, 0);
  assert.equal(app.fieldQuickActionValue('network_alpha', 99), null);
  const { app: krea } = application('krea2-lora', { network_dim: 25 });
  krea.applyFieldQuickAction('network_alpha', 1);
  assert.equal(krea.form.network_alpha, 12.5);
});

test('other numeric fields reuse literal, scaled and self-sourced shortcuts with profile constraints and locks', () => {
  const { app, w, history } = application();
  const field = { key: 'custom', type: 'number', min: 0, max: 10, step: 0.5,
    constraintsByGroup: { anima: { max: 8 } }, quickActions: [
      { label: 'zero', value: 0 }, { label: 'half', source: 'custom', factor: 0.5 },
      { label: 'too high', value: 9 }, { label: 'bad factor', value: 1, factor: Infinity },
    ] };
  w.TRAIN_SECTIONS = [{ key: 'custom', fields: [field] }];
  app.form.custom = 6;
  app.formDefaults.custom = 0;
  app.applyFieldQuickAction('custom', 1);
  assert.equal(app.form.custom, 3);
  app.applyFieldQuickAction('custom', 0);
  assert.equal(app.form.custom, 0);
  assert.equal(app.fieldQuickActionValue('custom', 2), null);
  assert.equal(app.fieldQuickActionValue('custom', 3), null);
  delete field.step;
  app.form.custom = 3;
  assert.equal(app.fieldQuickActionValue('custom', 1), null);
  field.step = 0.5;
  field.readonly = true;
  assert.equal(app.fieldQuickActionValue('custom', 0), null);
  field.readonly = false;
  field.readonlyIf = { key: 'network_dim', eq: 32 };
  app.applyFieldQuickAction('custom', 1);
  assert.equal(history.length, 2);
  delete field.readonlyIf;
  field.readonlyIfAny = [[{ key: 'network_dim', eq: 32 }]];
  assert.equal(app.fieldQuickActionValue('custom', 0), null);
});

test('source field constraints reject invalid imported dim and near-integer manual edits in every profile', () => {
  for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app, history } = application(profile);
    for (const value of [0, -1, 2.5, 2.0000000001]) {
      app.form.network_dim = value;
      for (const index of [0, 1]) {
        assert.equal(app.fieldQuickActionValue('network_alpha', index), null, `${profile}: ${value}`);
        app.applyFieldQuickAction('network_alpha', index);
      }
    }
    assert.equal(app.form.network_alpha, app.formDefaults.network_alpha);
    assert.equal(history.length, 0);
  }
});

test('shortcuts render before the numeric control and omit static readonly or nonnumeric fields', () => {
  const { app } = application();
  const alpha = app._fieldDefinition('network_alpha');
  const html = app.renderField(alpha);
  assert.ok(html.indexOf('class="field-quick-actions"') < html.indexOf('class="stepper"'));
  assert.match(html, />= dim<\/button>/);
  assert.match(html, />½ dim<\/button>/);
  assert.match(html, />1<\/button>/);
  assert.match(html, /:disabled="fieldQuickActionValue\(/);
  assert.match(html, /:aria-label="fieldQuickActionTitle\(/);
  assert.equal(app._renderFieldQuickActions({ ...alpha, readonly: true }), '');
  assert.equal(app._renderFieldQuickActions({ ...alpha, type: 'text' }), '');
});

test('memory tables are offered only for the three measured options and matching models', () => {
  for (const [profile, prefix] of [['anima-lora', 'anima'], ['moss-image-lora', 'moss']]) {
    const { app } = application(profile, { gradient_checkpointing: true });
    assert.ok(app.renderField(app._fieldDefinition('gradient_checkpointing_skip_blocks'))
      .includes(`openParameterDoc('memory-optimization','${prefix}-partial-checkpointing')`));
  }
  const { app: moss } = application('moss-image-lora');
  for (const [key, anchor] of [['blocks_to_swap', 'moss-block-swap'], ['text_encoder_blocks_to_swap', 'moss-text-encoder-swap']]) {
    assert.ok(moss.renderField(moss._fieldDefinition(key)).includes(`openParameterDoc('memory-optimization','${anchor}')`));
  }
  for (const profile of ['anima-lora', 'sdxl-lora', 'krea2-lora']) {
    const { app } = application(profile);
    for (const key of ['gradient_checkpointing', 'blocks_to_swap', 'resolution', 'train_batch_size', 'mixed_precision']) {
      const field = app._fieldDefinition(key);
      if (field) assert.ok(!app.renderField(field).includes("openParameterDoc('memory-optimization'"), `${profile}: ${key}`);
    }
  }
});
