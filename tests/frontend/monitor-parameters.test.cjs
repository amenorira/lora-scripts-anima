const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins, readRepo, trainingFieldSections} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'app/config', 'training/field-renderer', 'monitor/core', 'monitor/render']);
window.TRAIN_SECTIONS = trainingFieldSections();
const translations = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
const params = values => Object.entries(values).map(([key, value]) => ({key, value, desc_key: 'field.' + key}));
function app(values = {}, overrides = {}) {
  return Object.assign(composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin), {
    trainParams: params(values), trainParamsVersion: 1, locale: 'zh-CN',
    t(key, fallback) { return key.split('.').reduce((value, part) => value?.[part], translations) || fallback || key; },
    form: {model_train_type: 'anima-lora', network_dim: 999},
  }, overrides);
}
const translate = a => (key, fallback) => a.tMonitor(key, fallback);
const summary = a => a._monitorParamSummary(translate(a), a._monitorParamModel(translate(a)));
const row = (a, fieldKey) => summary(a).flatMap(group => group.rows).find(item => item.fieldKey === fieldKey)?.value;

test('saved configurations select the correct source and network for each training profile', () => {
  for (const [profile, module, network] of [
    ['anima-lora', 'networks.lora_anima', 'LoRA'],
    ['sdxl-lora', 'networks.lora', 'LoRA'],
    ['moss-image-lora', 'networks.lora_generic', 'LoRA'],
    ['krea2-lora', 'networks.lora_krea2', 'LoRA'],
  ]) {
    const a = app({model_train_type: profile, network_module: module, network_dim: 16, network_alpha: 8,
      [profile === 'krea2-lora' ? 'dit' : 'pretrained_model_name_or_path']: 'D:\\models\\' + profile + '.safetensors',
      train_data_dir: 'D:\\datasets\\train', max_train_epochs: 5});
    const html = a._parametersConsoleHtml(translate(a), {run_dir: 'output/' + profile});
    assert.ok(html.includes(profile + '.safetensors'));
    assert.ok(html.includes('D:\\datasets\\train'));
    assert.equal(row(a, 'network_module'), module);
    assert.equal(row(a, 'network_dim'), '16');
    assert.equal(row(a, 'network_alpha'), '8');
    assert.ok(!html.includes('999'));
  }
});

test('Krea steps, LyCORIS algorithm and dataset config retain their actual meaning', () => {
  const a = app({dit: 'krea.safetensors', pretrained_model_name_or_path: 'legacy.safetensors',
    dataset_config: 'D:\\train\\dataset.toml', train_data_dir: 'unused-folder',
    network_module: 'lycoris.kohya', 'network_args.algo': 'lokr', 'network_args.factor': 8,
    network_dim: 16, network_alpha: 16,
    max_train_epochs: 0, max_train_steps: 1200});
  const html = a._parametersConsoleHtml(translate(a), {run_dir: 'output/krea'});
  assert.ok(html.includes('krea.safetensors'));
  assert.ok(!html.includes('legacy.safetensors'));
  assert.ok(html.includes('dataset.toml'));
  assert.ok(!html.includes('unused-folder'));
  assert.equal(row(a, 'lycoris_algo'), 'LoKr');
  assert.equal(row(a, 'network_dim'), '16');
  assert.equal(row(a, 'max_train_steps'), '1200');
  assert.equal(row(a, 'lokr_factor'), '8');
  assert.equal(row(a, 'max_train_epochs'), undefined);
  a.trainParams = params({network_module: 'lycoris.kohya', 'network_args.algo': 'loha'});
  a.trainParamsVersion++;
  assert.equal(row(a, 'lycoris_algo'), 'LoHa');
});

test('Krea inferred rank is shown for a native LoRA initialized from saved weights', () => {
  const a = app({dit: 'krea.safetensors', network_module: 'networks.lora_krea2',
    network_weights: 'output/initial-lora.safetensors', dim_from_weights: true, network_dim: 16, network_alpha: 16});
  assert.equal(row(a, 'dim_from_weights'), '开启');
  assert.equal(row(a, 'network_dim'), undefined);
  assert.equal(row(a, 'network_alpha'), undefined);
  assert.ok(a._parametersConsoleHtml(translate(a)).includes('initial-lora.safetensors'));
});

test('native optimizer aliases resolve using all schema alternatives', () => {
  for (const profile of ['anima-lora', 'krea2-lora']) {
    const a = app({optimizer_type: 'vendor.automagic_optimizer.integration.Automagic4',
      'optimizer_args.fused': 'False', 'optimizer_args.clip_threshold': '1.2'}, {monitorData: {training_profile: profile}});
    const model = a._monitorParamModel(translate(a));
    assert.equal(model.byKey.get('optimizer_args.fused').fieldKey, 'automagic_fused');
    assert.equal(model.byKey.get('optimizer_args.clip_threshold').fieldKey, 'automagic_clip_threshold');
  }
  const a = app({optimizer_type: 'AdamW', 'optimizer_args.eps': '1e-8'}, {monitorData: {training_profile: 'krea2-lora'}});
  assert.equal(a._monitorParamModel(translate(a)).byKey.get('optimizer_args.eps').fieldKey, 'krea_optimizer_eps');
});

test('MOSS LoHa and LoKr use their module-specific text embedder argument names', () => {
  for (const module of ['networks.loha', 'networks.lokr']) {
    const a = app({network_module: module, 'network_args.train_llm_adapter': 'True'}, {monitorData: {training_profile: 'moss-image-lora'}});
    const param = a._monitorParamModel(translate(a)).byKey.get('network_args.train_llm_adapter');
    assert.equal(param.fieldKey, 'train_text_embedder');
    assert.equal(param.label, a.t('field.train_text_embedder_moss'));
    assert.equal(param.value, '开启');
    assert.ok(param.search.includes('train_llm_adapter'));
  }
});

test('known native options decode None and quoted strings while retaining their original literal', () => {
  const a = app({optimizer_type: 'AdamW', 'optimizer_args.foreach': 'None'});
  const param = a._monitorParamModel(translate(a)).byKey.get('optimizer_args.foreach');
  assert.equal(param.value, a.t('opt.tristate_auto'));
  assert.equal(param.raw, 'None');
  const krea = app({optimizer_type: 'AdamW', 'optimizer_args.fused': 'None'}, {monitorData: {training_profile: 'krea2-lora'}});
  const fused = krea._monitorParamModel(translate(krea)).byKey.get('optimizer_args.fused');
  assert.equal(fused.fieldKey, 'krea_adamw_fused');
  assert.equal(fused.value, krea.t('opt.tristate_auto'));
  for (const literal of ["'match_rms_adamw'", '"match_rms_adamw"']) {
    const b = app({optimizer_type: 'Muon', 'optimizer_args.adjust_lr_fn': literal});
    const value = b._monitorParamModel(translate(b)).byKey.get('optimizer_args.adjust_lr_fn');
    assert.equal(value.fieldKey, 'muon_adjust_lr_fn');
    assert.equal(value.value, 'match_rms_adamw');
    assert.equal(value.raw, literal);
  }
});

test('scheduler fields use schema labels and decoded text without taking values from reuse defaults', () => {
  const a = app();
  const saved = [
    {key: 'lr_scheduler', value: 'warmup_stable_decay'},
    {key: 'lr_scheduler_args.warmup_type', value: "'linear'", string_value: 'linear'},
    {key: 'lr_scheduler_args.decay_type', value: "'cosine'", string_value: 'cosine'},
    {key: 'lr_scheduler_args.step_rules', value: "'1:100,0.5'", string_value: '1:100,0.5'},
    {key: 'optimizer_type', value: 'prodigyplus.ProdigyPlusScheduleFree'},
    {key: 'optimizer_args.eps', value: 'None'},
    {key: 'optimizer_args.unknown', value: "'keep quotes'", string_value: 'keep quotes'},
  ];
  const model = a._monitorSnapshotParamModel({train_params: saved, training_profile: 'anima-lora',
    reuse_params: {model_train_type: 'anima-lora', step_rules: '1:200,0.2', eps: ''}}, translate(a));
  assert.equal(model.byField.get('warmup_type').value, 'linear');
  assert.equal(model.byField.get('warmup_type').label, a.t('field.warmup_type'));
  assert.equal(model.byField.get('decay_type').value, 'cosine');
  assert.equal(model.byField.get('step_rules').value, '1:100,0.5');
  assert.equal(model.byField.get('eps').value, 'None');
  assert.equal(model.byKey.get('optimizer_args.unknown').value, "'keep quotes'");
  assert.equal(model.rows.length, saved.length);
});

test('a known profile stays in the legacy snapshot summary without inventing a raw configuration item', () => {
  const a = app();
  const model = a._monitorSnapshotParamModel({params: {network_module: 'networks.lora_anima', network_dim: 16},
    reuse_params: {model_train_type: 'anima-lora'}}, translate(a));
  assert.equal(model.profileRow.raw, 'anima-lora');
  assert.equal(model.rows.length, 2);
  assert.equal(model.byField.has('model_train_type'), false);
  assert.ok(a._monitorParamSummary(translate(a), model).some(group => group.rows.includes(model.profileRow)));
});

test('partial snapshots preserve false and zero and never fill in current form defaults', () => {
  const a = app({learning_rate: 0, seed: 0, gradient_checkpointing: false, cache_latents: false,
    cache_latents_to_disk: true, cache_text_encoder_outputs_to_disk: true, future_custom_key: '<script>bad</script>'});
  assert.equal(row(a, 'learning_rate'), '0');
  assert.equal(row(a, 'seed'), '0');
  assert.equal(row(a, 'gradient_checkpointing'), '关闭');
  assert.equal(row(a, 'cache_latents'), '关闭');
  assert.equal(row(a, 'cache_latents_to_disk'), '开启');
  assert.equal(row(a, 'cache_text_encoder_outputs_to_disk'), '开启');
  assert.equal(row(a, 'network_dim'), undefined);
  assert.ok(a._monitorParamModel(translate(a)).rows.some(item => item.key === 'future_custom_key'));
});

test('numeric settings keep the form values and legacy factors use the same field key', () => {
  const a = app({lr_warmup_steps: 0.1, lokr_factor: 8});
  assert.equal(row(a, 'lr_warmup_steps'), '0.1');
  assert.equal(row(a, 'lokr_factor'), '8');
  a.trainParams = params({lr_warmup_steps: 120});
  a.trainParamsVersion++;
  assert.equal(row(a, 'lr_warmup_steps'), '120');
});

test('model caching is independent of metric updates and invalidates for snapshot or locale changes', () => {
  const a = app({learning_rate: 0.0001});
  const first = a._monitorParamModel(translate(a));
  a.monitorData = {step: 123, loss: 0.1};
  assert.equal(a._monitorParamModel(translate(a)), first);
  a.trainParamsVersion++;
  const second = a._monitorParamModel(translate(a));
  assert.notEqual(second, first);
  a.localeRevision = 1;
  assert.notEqual(a._monitorParamModel(translate(a)), second);
});

test('monitor names and enum values match the training form in every profile and locale', () => {
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const dictionary = JSON.parse(readRepo('frontend/i18n/' + locale + '.json'));
    for (const profile of ['anima-lora', 'sdxl-lora', 'krea2-lora', 'moss-image-lora']) {
      const values = {network_module: profile === 'krea2-lora' ? 'networks.lora_krea2' : profile === 'moss-image-lora' ? 'networks.lora_generic' : profile === 'sdxl-lora' ? 'networks.lora' : 'networks.lora_anima',
        optimizer_type: profile === 'krea2-lora' ? 'adamw8bit' : 'AdamW8bit', mixed_precision: 'bf16',
        lr_scheduler: 'cosine', network_dim: 16, network_alpha: 8, resolution: '1024,1024', lr_warmup_steps: '0.1',
        [profile === 'krea2-lora' ? 'dit' : 'pretrained_model_name_or_path']: 'models/base.safetensors'};
      const a = app(values, {locale, monitorData: {training_profile: profile},
        t(key, fallback) { return key.split('.').reduce((value, part) => value?.[part], dictionary) || fallback || key; }});
      const form = Object.assign({}, window.trainingFieldRenderer, {form: {model_train_type: profile}, t: a.t});
      const fields = window.getVisibleSections(profile).flatMap(section => section.fields);
      const model = a._monitorParamModel(translate(a));
      for (const param of model.rows) {
        const definition = fields.find(field => field.key === param.fieldKey);
        const suffix = {'anima-lora': '_anima', 'sdxl-lora': '_sdxl', 'moss-image-lora': '_moss'}[profile] || '';
        const specificKey = definition.descKey + suffix;
        const expectedLabel = a.t(specificKey) !== specificKey ? a.t(specificKey) : a.t(definition.descKey);
        assert.equal(param.label, expectedLabel, `${profile} ${locale} ${param.key}`);
        if (definition.type === 'select') {
          const config = form._trainingSelectConfig(definition);
          const options = config.options || config.groups.flatMap(group => group.options);
          assert.equal(param.value, options.find(option => String(option.v) === param.raw).l);
        } else assert.equal(param.value, String(values[param.key]));
      }
      assert.equal(a.form.model_train_type, 'anima-lora');
    }
  }
});

test('all parameters are lazy, escaped, searchable in translated labels, keys and values', () => {
  const a = app({learning_rate: 0.0001, gradient_checkpointing: false, custom: '<img onerror="bad()">'});
  const html = a._parametersConsoleHtml(translate(a), {run_dir: 'output/one'});
  assert.ok(!html.includes('data-param-row'));
  assert.ok(!html.includes('type="search"'));
  let writes = 0;
  const body = {firstElementChild: null, querySelectorAll: () => []};
  Object.defineProperty(body, 'innerHTML', {set(value) { writes++; this.html = value; this.firstElementChild = {}; }});
  const details = {isConnected: true, open: true, querySelector: () => body};
  a.filterMonitorParams = () => {};
  a.toggleMonitorParams(details);
  assert.ok(body.html.includes('&lt;img onerror=&quot;bad()&quot;&gt;'));
  assert.ok(body.html.includes('关闭'));
  assert.ok(body.html.includes('基础学习率'));
  assert.ok(body.html.includes('learning_rate'));
  assert.ok(body.html.includes('0.0001'));
  a.toggleMonitorParams(details);
  assert.equal(writes, 1);
  assert.equal(a.monitorParamsExpanded, true);
  details.open = false;
  a.toggleMonitorParams(details);
  assert.equal(a.monitorParamsExpanded, false);
  assert.equal(writes, 1);
});

test('disclosure/search survive re-rendering the same run and reset for another run', () => {
  const a = app({seed: 0});
  a._parametersConsoleHtml(translate(a), {run_dir: 'output/one'});
  a.monitorParamsExpanded = true;
  a.monitorParamQuery = 'seed';
  assert.ok(a._parametersConsoleHtml(translate(a), {run_dir: 'output/one'}).includes(' open'));
  assert.equal(a.monitorParamQuery, 'seed');
  assert.ok(!a._parametersConsoleHtml(translate(a), {run_dir: 'output/two'}).includes(' open'));
  assert.equal(a.monitorParamQuery, '');
  a.toggleMonitorParams({isConnected: false, open: true});
  assert.equal(a.monitorParamsExpanded, false);
});

test('filtering preserves the table nodes and explicitly reports empty results', () => {
  const a = app();
  const rows = [{dataset: {search: '学习率 learning_rate 1e-4'}, hidden: false}, {dataset: {search: '种子 seed 0'}, hidden: false}];
  const result = {}, empty = {};
  const root = {firstElementChild: {}, _paramRows: rows, querySelector: key => key === '[data-param-match]' ? result : empty};
  const previousDocument = global.document;
  global.document = {getElementById: () => ({querySelector: () => root})};
  try {
    for (const query of ['学习率', 'learning_rate', '1e-4']) {
      a.monitorParamQuery = query;
      a.filterMonitorParams();
      assert.equal(rows[0].hidden, false);
      assert.equal(rows[1].hidden, true);
      assert.equal(result.textContent, '1 项匹配');
    }
    a.monitorParamQuery = 'missing';
    a.filterMonitorParams();
    assert.equal(empty.hidden, false);
    a.monitorParamQuery = '';
    a.filterMonitorParams();
    assert.ok(rows.every(row => !row.hidden));
    assert.equal(empty.hidden, true);
  } finally { global.document = previousDocument; }
});

test('raw-config modal formatting shares the parameter model without replacing the dashboard cache', () => {
  const a = app({network_dim: 64});
  const cached = a._monitorParamModel(translate(a));
  const snapshot = {params: {dit: 'krea.safetensors', network_module: 'lycoris.kohya', network_args: ['algo=lokr', 'factor=8'],
    optimizer_type: 'AdamW', optimizer_args: ['fused=false'], resolution: [1024, 1024]}, reuse_params: {model_train_type: 'krea2-lora'}};
  const model = a._monitorSnapshotParamModel(snapshot, translate(a));
  assert.equal(model.byField.get('lycoris_algo').value, 'LoKr');
  assert.equal(model.byField.get('lokr_factor').value, '8');
  assert.equal(model.byField.get('dit').label, a.t('field.krea_dit'));
  assert.equal(model.byField.get('resolution').value, '1024, 1024');
  assert.equal(a._monitorParamCache, cached);
  assert.equal(a.trainParams[0].value, 64);
});
