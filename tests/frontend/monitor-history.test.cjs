const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins, response, deferred} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/logs', 'monitor/core', 'monitor/render']);
window.loadTrainingFields = async () => {};

function app(overrides = {}) {
  return Object.assign(composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin), {
    historyItems: [], t: key => key, tMonitor: key => key,
    toast() {}, startProgress() {}, finishProgress() {}, renderHistory() {}, navigate() {},
  }, overrides);
}

test('opening history uses the catalog while manual refresh requests discovery', async () => {
  const requests = [];
  global.fetch = async url => {
    requests.push(url);
    return response({running: null, history: []});
  };
  const a = app();
  await a.loadHistory();
  await a.loadHistory(false, true);
  assert.deepEqual(requests, ['/api/monitor/history', '/api/monitor/history?refresh=true']);
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

test('history cards render self-hover bounce marquee on truncated model and dataset lines without host wrapper', () => {
  const listEl = {innerHTML: ''};
  const prevDoc = global.document;
  global.document = {getElementById: id => (id === 'historyList' ? listEl : null)};
  try {
    const a = app({
      historyItems: [{
        run_dir: 'output/run-1',
        name: 'run-1',
        status: 'completed',
        time: '2026-01-01 10:00',
        model: 'very-long-pretrained-model-name.safetensors',
        dataset: 'D:/datasets/very-long-dataset-directory-name',
        lr: 1e-4,
        dim: 16,
        alpha: 16,
        epochs: 10,
      }],
      renderHistory: window.monitorHistoryRenderMixin.renderHistory,
      escapeJsString: s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    });
    a.renderHistory();
    assert.ok(listEl.innerHTML.includes('<div class="hist-card-content is-clickable"'));
    assert.ok(!listEl.innerHTML.includes('hist-card-content is-clickable loop-marquee-host'));
    assert.ok(listEl.innerHTML.includes('<div class="hist-meta hist-truncate" title="very-long-pretrained-model-name.safetensors" x-loop-marquee.bounce><span>historyModel · very-long-pretrained-model-name.safetensors</span></div>'));
    assert.ok(listEl.innerHTML.includes('<div class="hist-dataset hist-truncate" title="D:/datasets/very-long-dataset-directory-name" x-loop-marquee.bounce><span>dataset · D:/datasets/very-long-dataset-directory-name</span></div>'));
  } finally {
    global.document = prevDoc;
  }
});
