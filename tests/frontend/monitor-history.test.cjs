const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins, response, deferred} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/logs', 'monitor/core', 'monitor/render']);

function app(overrides = {}) {
  return Object.assign(composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin), {
    historyItems: [], t: key => key, tMonitor: key => key,
    toast() {}, startProgress() {}, finishProgress() {}, renderHistory() {}, navigate() {},
  }, overrides);
}

test('YAML snapshot highlights values safely while preserving the original text', () => {
  const yaml = [
    '# training config',
    'kind: training',
    'learning_rate: 2e-5',
    'enabled: true',
    'path: D:\\lora训练\\model.safetensors',
    'url: https://example.com/a#part',
    "'quoted: key': 'it''s # still a string' # comment",
    'items: [null, 42, "<script>alert(1)</script>"]',
    'flow: {"count":2, active: false}',
    'nested:',
    '  - [{name: example, active: true}]',
    'prompt: |-',
    '  label: true',
    '  # part of the prompt',
    'after: false',
    'multiline: "first',
    '  # still quoted"',
    '',
  ].join('\r\n');
  const html = app()._highlightSnapshotYaml(yaml);
  assert.match(html, /<span class="yaml-key">kind<\/span>: <span class="yaml-string">training<\/span>/);
  assert.match(html, /<span class="yaml-number">2e-5<\/span>/);
  assert.match(html, /<span class="yaml-constant">true<\/span>/);
  assert.match(html, /<span class="yaml-string">https:\/\/example\.com\/a#part<\/span>/);
  assert.match(html, /<span class="yaml-string">'it''s # still a string'<\/span> <span class="yaml-comment"># comment<\/span>/);
  assert.match(html, /<span class="yaml-key">&quot;count&quot;<\/span>:<span class="yaml-number">2<\/span>/);
  assert.match(html, /\[\{<span class="yaml-key">name<\/span>: <span class="yaml-string">example<\/span>/);
  assert.match(html, /<span class="yaml-string">  # part of the prompt<\/span>/);
  assert.match(html, /<span class="yaml-string">  # still quoted&quot;<\/span>/);
  assert.doesNotMatch(html, /<script>/);
  const displayed = html.replace(/<\/?span(?: class="yaml-[a-z]+")?>/g, '')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(displayed, yaml);
});

test('snapshot reflows folded prompt lines without changing the YAML source', () => {
  const yaml = [
    'parameters:',
    '  positive_prompts: first part ending with white',
    '    hair, long description ending in rabbit',
    '    hair ornament, pink skirt',
    "  negative_prompts: 'text: bad quality,",
    "    # still part of the quoted value'",
    '  positive_prompts: |-',
    '    a real line',
    '    another real line',
    '  negative_prompts: value # comment',
    '    # keep this comment on its line',
    '',
  ].join('\r\n');
  const a = app();
  const html = a._renderSnapshotLines(yaml, a._highlightSnapshotYaml(yaml), 'yaml');
  assert.equal((html.match(/class="m-config-fold"/g) || []).length, 3);
  assert.match(html, /class="m-config-fold">\r\n    <\/span><span class="yaml-string">hair, long/);
  assert.match(html, /class="m-config-fold">\r\n    <\/span><span class="yaml-string"># still part/);
  const restored = html.replace(/<br>/g, '').replace(/<span[^>]*>|<\/span>/g, '')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(restored, yaml);
});

test('snapshot reflows prompt continuations beginning with YAML punctuation', () => {
  const yaml = [
    'positive_prompts: first part',
    '  [headpiece] and other details',
    '  {red eyes} and more',
    '  - detail',
    '  , final detail',
    'next: true',
  ].join('\n');
  const a = app();
  const html = a._renderSnapshotLines(yaml, a._highlightSnapshotYaml(yaml), 'yaml');
  assert.equal((html.match(/class="m-config-fold"/g) || []).length, 4);
  const restored = html.replace(/<br>/g, '').replace(/<span[^>]*>|<\/span>/g, '')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(restored, yaml);
});

test('plain scalar continuations do not change highlighting of later fields', () => {
  for (const text of ['[headpiece', '{red eyes', "'smile", '"smile']) {
    const yaml = `positive_prompts: first part\n  ${text}\nlearning_rate: 2e-5\nenabled: true\n`;
    const a = app();
    const highlighted = a._highlightSnapshotYaml(yaml);
    assert.match(highlighted, /<span class="yaml-key">learning_rate<\/span>: <span class="yaml-number">2e-5<\/span>/);
    assert.match(highlighted, /<span class="yaml-key">enabled<\/span>: <span class="yaml-constant">true<\/span>/);
    const html = a._renderSnapshotLines(yaml, highlighted, 'yaml');
    assert.equal((html.match(/class="m-config-fold"/g) || []).length, 1);
  }
});

test('snapshot keeps meaningful prompt breaks and unrelated YAML lines', () => {
  const yaml = [
    "positive_prompts: 'first prompt",
    '',
    "  second prompt'",
    'negative_prompts: "joined\\',
    '  without a space"',
    'description: ordinary text',
    '  with an existing continuation',
  ].join('\n');
  const a = app();
  const html = a._renderSnapshotLines(yaml, a._highlightSnapshotYaml(yaml), 'yaml');
  assert.doesNotMatch(html, /class="m-config-fold"/);
});

test('prompt-like text inside a block scalar is not reflowed as YAML fields', () => {
  const yaml = 'description: |-\n  positive_prompts: first line\n    second line\n';
  const a = app();
  const html = a._renderSnapshotLines(yaml, a._highlightSnapshotYaml(yaml), 'yaml');
  assert.doesNotMatch(html, /class="m-config-fold"/);
});

test('copying a selection from a snapshot retains its original line breaks', () => {
  const originalGetSelection = window.getSelection;
  const node = {};
  const originalText = '  prompt: first\n    continuation';
  let copied, prevented = false;
  window.getSelection = () => ({rangeCount: 1, getRangeAt: () => ({
    commonAncestorContainer: node, cloneContents: () => ({textContent: originalText}),
  })});
  try {
    app()._copySnapshotSelection({
      clipboardData: {setData: (type, text) => { copied = [type, text]; }},
      preventDefault: () => { prevented = true; },
    }, {contains: target => target === node});
    assert.deepEqual(copied, ['text/plain', originalText]);
    assert.equal(prevented, true);
  } finally {
    window.getSelection = originalGetSelection;
  }
});

test('snapshot copy listener is replaced and removed with the modal', () => {
  const oldDocument = global.document;
  const handlers = new Set();
  const pre = {};
  const content = {innerHTML: '', scrollTop: 0, querySelector: () => pre};
  global.document = {
    getElementById: id => id === 'configSnapshotContent' ? content : null,
    addEventListener: (type, handler) => handlers.add(handler),
    removeEventListener: (type, handler) => handlers.delete(handler),
  };
  try {
    const a = app();
    a.showSnapshotModal({content: 'key: value', config_format: 'yaml'});
    assert.equal(handlers.size, 1);
    a.showSnapshotModal({content: 'other: value', config_format: 'yaml'});
    assert.equal(handlers.size, 1);
    a.closeSnapshotModal();
    assert.equal(handlers.size, 0);
  } finally {
    global.document = oldDocument;
  }
});

test('snapshot rendering keeps copy text intact and leaves older TOML snapshots uncolored', () => {
  const oldDocument = global.document;
  const oldNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');
  const content = {innerHTML: '', scrollTop: 1};
  const body = {scrollTop: 1};
  let copied;
  global.document = {getElementById: id => id === 'configSnapshotContent' ? content : id === 'configSnapshotBody' ? body : null};
  Object.defineProperty(global, 'navigator', {configurable: true, value: {clipboard: {writeText: text => { copied = text; return Promise.resolve(); }}}});
  try {
    const a = app();
    const yaml = 'path: "<data>&"\nnumber: 42\n';
    a.showSnapshotModal({content: yaml, config_format: 'yaml'});
    assert.match(content.innerHTML, /class="yaml-key"/);
    a.copyConfigContent();
    assert.equal(copied, yaml);

    const toml = 'path = "<data>&"\n';
    a.showSnapshotModal({content: toml, config_format: 'toml'});
    assert.doesNotMatch(content.innerHTML, /class="yaml-/);
    assert.match(content.innerHTML, /path = &quot;&lt;data&gt;&amp;&quot;/);
    a.copyConfigContent();
    assert.equal(copied, toml);
  } finally {
    global.document = oldDocument;
    if (oldNavigator) Object.defineProperty(global, 'navigator', oldNavigator);
    else delete global.navigator;
  }
});

test('copy uses the converted form and undo restores both profile drafts', async () => {
  const original = {model_train_type: 'moss-image-lora', output_name: 'my draft'};
  const drafts = {'anima-lora': {output_name: 'saved anima'}, 'moss-image-lora': original};
  const a = app({form: {...original}, _profileFormDrafts: structuredClone(drafts),
    _profileFieldSources: {'anima-lora': {output_name: 'user'}}, _fieldSources: {output_name: 'user'},
    _trainingDocumentId: 'original-document',
    async _applyImportedFlatConfig(form) {
      this.form = {...form};
      this._profileFormDrafts[form.model_train_type] = {...form};
    },
  });
  await a.reuseConfig('output/old', {
    name: 'old', params: {resume: 'old-state'},
    reuse_params: {model_train_type: 'anima-lora', lycoris_algo: 'lokr', lokr_factor: 8, resume: ''},
  });
  assert.equal(a.form.model_train_type, 'anima-lora');
  assert.equal(a.form.lycoris_algo, 'lokr');
  assert.equal(a.form.resume, '');
  assert.equal(a._trainingDocumentId, null);
  await a.undoHistoryReuse();
  assert.deepEqual(a.form, original);
  assert.deepEqual(a._profileFormDrafts, drafts);
  assert.equal(a._trainingDocumentId, 'original-document');
  assert.equal(a.historyReuseSource, '');
});

test('an unidentifiable history configuration leaves the current draft untouched', async () => {
  let error;
  const a = app({form: {output_name: 'keep'}, toast: text => { error = text; }});
  await a.reuseConfig('output/unknown', {params: {output_name: 'unknown'}, reuse_params: null, reuse_error: 'unknown profile'});
  assert.equal(a.form.output_name, 'keep');
  assert.equal(error, 'unknown profile');
});

test('leaving history cancels a pending copy without changing the draft', async () => {
  const pending = deferred();
  global.fetch = () => pending.promise;
  const a = app({form: {output_name: 'keep'}, _routeTransitionSeq: 1});
  const request = a.reuseConfig('output/old');
  a.cancelHistoryInteractions();
  pending.resolve(response({name: 'old', reuse_params: {output_name: 'replace'}}));
  await request;
  assert.equal(a.form.output_name, 'keep');
  assert.equal(a.historyReuseBusy, '');
  assert.equal(a._historyReuseUndo, null);
});

test('undo keeps its recovery entry on failure and restores defaults and source badges on retry', async () => {
  const undo = {form: {output_name: 'original'}, formDefaults: {output_name: 'default'}, fieldSources: {output_name: 'user'}};
  let fail = true, rebuiltSources;
  const a = app({_historyReuseUndo: undo, form: {output_name: 'copied'}, historyReuseSource: 'old',
    async _applyImportedFlatConfig(form) { if (fail) throw new Error('failed'); this.form = {...form}; },
    rebuildForm() { rebuiltSources = {...this._fieldSources}; },
  });
  await a.undoHistoryReuse();
  assert.equal(a._historyReuseUndo, undo);
  assert.equal(a.historyReuseBusy, '');
  fail = false;
  await a.undoHistoryReuse();
  assert.deepEqual(a.formDefaults, undo.formDefaults);
  assert.deepEqual(rebuiltSources, undo.fieldSources);
  assert.equal(a._historyReuseUndo, null);
});
