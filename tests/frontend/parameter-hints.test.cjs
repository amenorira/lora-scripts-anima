const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, readRepo } = require('./helpers.cjs');

function application(locale = 'zh-CN', profile = 'moss-image-lora') {
  const messages = JSON.parse(readRepo(`frontend/i18n/${locale}.json`));
  const t = key => key.split('.').reduce((value, part) => value?.[part], messages) || key;
  const context = loadFrontend(['constants', 'utils', 'config', 'training-core'], {
    window: { t }, btoa, TextEncoder,
  });
  const w = context.window;
  const app = Object.assign({}, w.utilsMixin, w.trainingCoreMixin, { t });
  app.form = app._buildFormDefaults(profile);
  return app;
}

test('optimizer guidance replaces generic hints and returns to the profile hint when switched back', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const app = application(locale);
    const field = app.findFieldDef('learning_rate');
    const base = app.t('field.learning_rateHint_moss');
    assert.equal(app.fieldHintText('learning_rate'), base);
    for (const [optimizer, key] of [
      ['vendor.emo_optimizer.emosens.EmoSens', 'field.learning_rateHint_emosens'],
      ['vendor.automagic_optimizer.integration.Automagic3', 'field.learning_rateHint_automagic'],
      ['Prodigy', 'field.learning_rateHint_prodigy'],
      ['prodigyplus.ProdigyPlusScheduleFree', 'field.learning_rateHint_prodigy'],
    ]) {
      app.form.optimizer_type = optimizer;
      const hint = app.t(key);
      assert.notEqual(hint, key);
      assert.equal(app.fieldHintText('learning_rate'), hint);
      const html = app.renderField(field);
      assert.equal((html.match(/class="field-hint"/g) || []).length, 1);
      assert.ok(html.includes(app.esc(hint)));
      assert.ok(!html.includes(base));
      assert.ok(!html.includes('field-hint-warn'));
      assert.ok(html.includes('x-text="fieldHintText(\'learning_rate\')"'));
    }
    app.form.optimizer_type = 'AdamW8bit';
    assert.equal(app.fieldHintText('learning_rate'), base);
  }
});

test('scheduler hints follow the selected schedule without listing unrelated schedules', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const app = application(locale);
    for (const [scheduler, cycleKey, minimumKey] of [
      ['cosine_with_restarts', 'lr_scheduler_num_cyclesHint_restarts', 'lr_scheduler_min_lr_ratioHint'],
      ['warmup_stable_decay', 'lr_scheduler_num_cyclesHint_wsd', 'lr_scheduler_min_lr_ratioHint_wsd'],
      ['cosine_with_min_lr', 'lr_scheduler_num_cyclesHint', 'lr_scheduler_min_lr_ratioHint'],
    ]) {
      app.form.lr_scheduler = scheduler;
      assert.equal(app.fieldHintText('lr_scheduler_num_cycles'), app.t(`field.${cycleKey}`));
      assert.equal(app.fieldHintText('lr_scheduler_min_lr_ratio'), app.t(`field.${minimumKey}`));
    }
  }
});

test('AdaFactor guidance follows relative step and warmup initialization together', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const app = application(locale);
    app.form.optimizer_type = 'AdaFactor';
    for (const [relative, warmup, mode] of [
      [true, false, 'relative'], [true, true, 'relative'],
      [false, true, 'relative'], [false, false, 'manual'],
    ]) {
      Object.assign(app.form, { adafactor_relative_step: relative, adafactor_warmup_init: warmup });
      assert.equal(app.fieldHintText('learning_rate'), app.t(`field.learning_rateHint_adafactor_${mode}`));
    }
    app.form.optimizer_type = 'AdamW8bit';
    assert.equal(app.fieldHintText('learning_rate'), app.t('field.learning_rateHint_moss'));
  }
});

test('algorithm hints respect the active network and retain the full-factor Alpha exception', () => {
  const app = application('zh-CN', 'anima-lora');
  Object.assign(app.form, { network_module: 'lycoris.kohya', lycoris_algo: 'lokr' });
  assert.equal(app.fieldHintText('rank_dropout'), app.t('field.rank_dropoutHint_lokr'));
  app.shapeEstimate = { groups: [{ algo: 'lokr', w2Full: true, shapes: { lokr_w1: [4, 4] } }] };
  assert.equal(app.fieldHintText('network_alpha'), app.t('field.network_alphaHint_lokr_full'));
  app.form.network_module = 'networks.lora_anima';
  assert.equal(app.fieldHintText('rank_dropout'), app.t('field.rank_dropoutHint'));
  assert.equal(app.fieldHintText('network_alpha'), app.t('field.network_alphaHint'));
});

test('MOSS text embedder guidance links to the detailed rate override in every locale', () => {
  const app = application();
  const field = app.findFieldDef('train_text_embedder');
  assert.equal(field.docSlug, 'network-parameters');
  assert.equal(field.docAnchor, 'moss-text-embedder');
  assert.ok(app.renderField(field).includes("openParameterDoc('network-parameters','moss-text-embedder')"));
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const doc = readRepo(`docs/parameters/network-parameters.${locale}.md`);
    assert.ok(doc.includes('<!-- doc-anchor: moss-text-embedder -->'));
    assert.ok(doc.includes('network_reg_lrs=.*text_embedder.*=5e-5'));
  }
});
