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
