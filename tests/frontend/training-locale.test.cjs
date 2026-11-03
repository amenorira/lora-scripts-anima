const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, composeMixins, readRepo } = require('./helpers.cjs');

function mountedApplication({ hidden = false, scrollTop = 1200 } = {}) {
  const ticks = [];
  const scroller = { scrollTop, getBoundingClientRect: () => ({ top: 80, bottom: 800 }) };
  let layoutShift = 0;
  const clipped = {
    closest: () => ({}), getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: -500, bottom: 400, height: 900 }),
  };
  const field = {
    isConnected: true, closest: () => null, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ top: 1290 + layoutShift - scroller.scrollTop,
      bottom: 1390 + layoutShift - scroller.scrollTop, height: 100 }),
  };
  const panel = { dataset: { panelLocale: 'en-US' } };
  const root = { childElementCount: 1, querySelectorAll: () => [clipped, field] };
  const document = { getElementById: id => ({ trainFormContent: root, mainContent: scroller }[id] || null) };
  const { window } = loadFrontend(TRAINING_CORE_SCRIPTS, { window: {}, document });
  const app = composeMixins(window.trainingCoreMixin, {
    currentRoute: hidden ? 'settings' : 'train-basic', locale: 'zh-CN',
    _trainFormMountedRoute: 'train-basic', _trainFormLocale: 'en-US', _trainTypePanel: panel,
    form: { model_train_type: 'anima-lora', network_dim: 32 },
    formHistory: [{ network_dim: 16 }, { network_dim: 32 }], formHistoryIdx: 1,
    _optimizerDrafts: { AdamW8bit: { learning_rate: '0.0123' } },
    sectionNavList: [{ key: 'network', title: 'Network', collapsed: true }], sectionNavOpen: true,
    t: key => 'zh:' + key,
    _allSections: () => [{ key: 'network', titleKey: 'section.network' }],
    _refreshTrainingText() { layoutShift = 60; },
    _refreshTrainingOptionErrors() {},
    _updateActiveSection() {}, positionSectionRail() {},
    $nextTick(callback) { ticks.push(callback); },
    _setFieldSource() {}, _persistProfileFieldSources() {}, updateToml() {},
    _normalizeProfileSelectValues() {}, buildSectionNav() {}, refreshTrainingRealtimeState() {},
    scheduleStepEstimate() {}, scheduleOutputPathInfo() {}, scheduleKreaDitFormatCheck() {},
    _destroyTrainTypePanel() { assert.fail('locale change must retain mounted controls'); },
    renderTrainingForm() { assert.fail('locale change must not render the form'); },
    _initializeTrainingFormState() { assert.fail('locale change must retain the editing session'); },
  });
  return { app, panel, root, field, scroller, settle: () => ticks.splice(0).forEach(callback => callback()) };
}

test('locale refresh preserves controls, draft identity, undo and visible field position', () => {
  const { app, panel, scroller, field, settle } = mountedApplication();
  const form = app.form, history = app.formHistory, optimizerDrafts = app._optimizerDrafts;
  const top = field.getBoundingClientRect().top;
  app.refreshTrainingLocale();
  settle();
  assert.equal(app.form, form);
  assert.equal(app.formHistory, history);
  assert.equal(app.formHistoryIdx, 1);
  assert.equal(app._optimizerDrafts, optimizerDrafts);
  assert.equal(app._trainTypePanel, panel);
  assert.equal(app.sectionNavOpen, true);
  assert.equal(app.sectionNavList[0].collapsed, true);
  assert.equal(app.sectionNavList[0].title, 'zh:section.network');
  assert.equal(app._trainFormLocale, 'zh-CN');
  assert.equal(panel.dataset.panelLocale, 'zh-CN');
  assert.equal(scroller.scrollTop, 1260);
  assert.equal(field.getBoundingClientRect().top, top);
  app.undoField('network_dim');
  assert.equal(app.form.network_dim, 16);
  assert.equal(app.formHistoryIdx, 0);
});

test('changing language off the training route retains history on resume', () => {
  const { app, scroller, settle } = mountedApplication({ hidden: true });
  const history = app.formHistory, form = app.form;
  app.refreshTrainingLocale();
  settle();
  assert.equal(scroller.scrollTop, 1200);
  app.currentRoute = 'train-basic';
  assert.equal(app._resumeTrainForm('train-basic'), true);
  settle();
  assert.equal(app.form, form);
  assert.equal(app.formHistory, history);
  app.undoField('network_dim');
  assert.equal(app.form.network_dim, 16);
});

test('top stays at zero and a deferred locale refresh does not scroll another route', () => {
  const top = mountedApplication({ scrollTop: 0 });
  top.app.refreshTrainingLocale();
  top.settle();
  assert.equal(top.scroller.scrollTop, 0);
  const leaving = mountedApplication();
  leaving.app.refreshTrainingLocale();
  leaving.app.currentRoute = 'settings';
  leaving.settle();
  assert.equal(leaving.scroller.scrollTop, 1200);
});

test('rapid language changes restore the original position once after layout settles', () => {
  const { app, scroller, settle } = mountedApplication();
  app.refreshTrainingLocale();
  app.locale = 'ja-JP';
  app.refreshTrainingLocale();
  settle();
  assert.equal(scroller.scrollTop, 1260);
  assert.equal(app._trainFormLocale, 'ja-JP');
  assert.equal(app._trainingLocaleScrollSnapshot, null);
});

test('a viewport filled by subset rows retains its place without a focused field', () => {
  for (const rowType of ['.dataset-subset-row', '.subset-timestep-row']) {
    const { app, root, field: row, scroller, settle } = mountedApplication();
    root.querySelectorAll = selector => selector.split(', ').includes(rowType) ? [row] : [];
    app.refreshTrainingLocale();
    settle();
    assert.equal(scroller.scrollTop, 1260, rowType);
  }
});

test('a visible collapsed section heading can anchor a viewport with no fields', () => {
  const { app, root, field: heading, scroller, settle } = mountedApplication();
  heading.closest = selector => selector === '.card-collapsed' ? {} : null;
  heading.matches = selector => selector === '.card-header';
  root.querySelectorAll = selector => selector.split(', ').includes('.card-header') ? [heading] : [];
  app.refreshTrainingLocale();
  settle();
  assert.equal(scroller.scrollTop, 1260);
});

test('replacing a profile releases references to its removed controls', () => {
  const { window } = loadFrontend(TRAINING_CORE_SCRIPTS, { window: {} });
  const input = { isConnected: true };
  const app = composeMixins(window.trainingCoreMixin, {
    _trainingLocaleScrollSnapshot: { anchor: input }, _trainingLocaleRefreshSeq: 2,
  });
  app.rememberTrainingFocus(input);
  assert.equal(app._trainFormFocusedControl.deref(), input);
  app._releaseTrainingControlReferences({ contains: node => node === input });
  assert.equal(app._trainFormFocusedControl, null);
  assert.equal(app._trainingLocaleScrollSnapshot, null);
  assert.equal(app._trainingLocaleRefreshSeq, 3);
});

test('independently removed subset inputs are weakly held and cleared on later cleanup', () => {
  const { app } = mountedApplication();
  const input = { isConnected: false };
  app.rememberTrainingFocus(input);
  app._trainingLocaleScrollSnapshot = { anchor: input };
  app._releaseTrainingControlReferences({ contains: () => false });
  assert.equal(app._trainFormFocusedControl, null);
  assert.equal(app._trainingLocaleScrollSnapshot, null);
});

test('mounted select translates labels, groups and descriptions without changing its value', () => {
  let factory;
  loadFrontend('shared/anima-select', {
    window: {}, document: { addEventListener: (_, callback) => callback() },
    Alpine: { data: (_, value) => { factory = value; } },
  });
  const select = factory({ groups: [{ label: 'Group', labelKey: 'group', options: [
    { v: 'raw', l: 'Label', labelKey: 'label', d: 'Description', dKey: 'description' },
    { v: 'literal', l: 'Literal' },
  ] }] }, 'raw');
  select.locale = 'en-US';
  select.t = key => select.locale + ':' + key;
  assert.equal(select.selectedLabel, 'en-US:label');
  const first = select.displayGroups;
  assert.equal(select.displayGroups, first);
  select.locale = 'zh-CN';
  assert.equal(select.selectedLabel, 'zh-CN:label');
  assert.equal(select.displayGroups[0].label, 'zh-CN:group');
  assert.equal(select.flatOptions[0].d, 'zh-CN:description');
  assert.equal(select.flatOptions[1].l, 'Literal');
  assert.equal(select.value, 'raw');
  select.locale = 'en-US';
  assert.equal(select.selectedLabel, 'en-US:label');
});

test('static text refresh translates parameters and accessibility without changing inputs', () => {
  const nodes = [
    { dataset: { trainingI18n: 'counts', trainingI18nParams: '{"images":12}' }, textContent: 'old' },
    { dataset: { trainingI18nTitle: 'guide' }, attributes: { title: 'old', 'data-training-i18n-title': 'guide' } },
  ].map(node => Object.assign(node, {
    getAttribute(key) { return this.attributes?.[key] || null; },
    setAttribute(key, value) { this.attributes[key] = value; },
  }));
  const { window } = loadFrontend('training/field-renderer', { window: {} });
  const root = { querySelectorAll: selector => selector.startsWith('[data-training-i18n]') ? nodes : [] };
  window.trainingFieldRenderer._refreshTrainingText.call({ t: key => ({ counts: '{images} images', guide: 'Guide' }[key]) }, root);
  assert.equal(nodes[0].textContent, '12 images');
  assert.equal(nodes[1].attributes.title, 'Guide');
});

test('optimizer hints resolve the current model and locale while preserving generic fallbacks', () => {
  const { window } = loadFrontend(['shared/constants', 'shared/utils', 'app/config', 'training/field-renderer'], { window: {} });
  const app = Object.assign({}, window.trainingFieldRenderer);
  for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
    const translations = JSON.parse(readRepo(`frontend/i18n/${locale}.json`));
    app.t = key => key.split('.').reduce((value, part) => value?.[part], translations) ?? key;
    for (const profile of ['anima-lora', 'moss-image-lora', 'sdxl-lora']) {
      const field = app._fieldDefinition('learning_rate', profile);
      const optimizer = Object.entries(field.hintKeyBy.values)
        .find(([, key]) => key === 'field.learning_rateHint_emosens')[0];
      app.form = { model_train_type: profile, optimizer_type: optimizer };
      const expected = 'field.learning_rateHint_emosens' + (profile === 'sdxl-lora' ? '_sdxl' : '');
      assert.equal(app.fieldHintText('learning_rate'), app.t(expected), `${locale}: ${profile}`);
      app.form.optimizer_type = 'AdamW';
      assert.equal(app.fieldHintText('learning_rate'),
        app.t('field.learning_rateHint' + (profile === 'moss-image-lora' ? '_moss' : '')));
    }
  }
});
