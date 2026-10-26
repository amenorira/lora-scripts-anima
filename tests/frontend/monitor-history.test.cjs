const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins, response, deferred} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['utils', 'monitor-logs', 'monitor-core', 'monitor-render']);

function app(overrides = {}) {
  return Object.assign(composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin), {
    historyItems: [], t: key => key, tMonitor: key => key,
    toast() {}, startProgress() {}, finishProgress() {}, renderHistory() {}, navigate() {},
  }, overrides);
}

test('history ignores an older response and keeps current records on refresh failure', async () => {
  const first = deferred(), second = deferred();
  let call = 0;
  global.fetch = () => (++call === 1 ? first.promise : second.promise);
  let finishes = 0;
  const a = app({finishProgress: () => { finishes++; }});
  const oldRequest = a.loadHistory(), currentRequest = a.loadHistory(true);
  second.resolve(response({history: [{name: 'new'}]}));
  await currentRequest;
  first.resolve(response({history: [{name: 'stale'}]}));
  await oldRequest;
  assert.equal(a.historyItems[0].name, 'new');
  assert.equal(finishes, 1);
  global.fetch = async () => { throw new Error('offline'); };
  await a.loadHistory(true);
  assert.equal(a.historyItems[0].name, 'new');
  assert.equal(a.historyError, 'offline');
  assert.equal(a.historyLoading, false);
});

test('historical errors are terminal and missing results are never shown as idle', () => {
  const a = app();
  for (const status of ['error', 'timeout', 'failed']) {
    assert.deepEqual(a._summaryStatus({train_result: {status}}, true), {state: 'FAILED', running: false, completed: false, terminal: true});
  }
  assert.equal(a._summaryStatus({state: 'IDLE'}, true).state, 'UNKNOWN');
  assert.equal(a._summaryStatus({}, false).state, 'IDLE');
});

test('filters include profile and optimizer and offer recovery for zero matches', () => {
  const el = {innerHTML: ''};
  global.document = {getElementById: () => el};
  const a = app({historyItems: [{name: 'sample', profile_label: 'Anima', optimizer: 'CAME', status: 'completed'}]});
  a.historySearch = 'came';
  assert.equal(a.filteredHistoryItems.length, 1);
  a.historyFilter = 'failed';
  window.monitorRenderMixin.renderHistory.call(a);
  assert.match(el.innerHTML, /historyNoMatches/);
  assert.match(el.innerHTML, /clearHistoryFilters/);
  a.clearHistoryFilters();
  assert.equal(a.filteredHistoryItems.length, 1);
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

test('delete confirmation identifies the selected record and refreshes after partial failure', async () => {
  let confirmation, refreshed = 0;
  const a = app({historyItems: [{name: 'selected run', time: '2026-07-04', run_dir: 'output/run'}],
    openConfirm: (...args) => { confirmation = args; },
    loadHistory: async () => { refreshed++; },
  });
  a.deleteHistoryRun('output/run');
  assert.match(confirmation[1], /selected run.*2026-07-04/);
  global.fetch = async () => ({json: async () => ({status: 'error', message: 'locked', data: {retryable: true}})});
  await confirmation[2]();
  assert.equal(refreshed, 1);
  assert.equal(a.historyDeleting, '');
});

test('snapshot opens with loading feedback, resets scroll and ignores a closed request', async () => {
  const body = {scrollTop: 400}, content = {innerHTML: '', scrollTop: 300};
  global.document = {getElementById: id => id === 'configSnapshotBody' ? body : content};
  const pending = deferred();
  let signal;
  global.fetch = (_url, options) => { signal = options.signal; return pending.promise; };
  const a = app();
  const request = a.viewSnapshot('output/old');
  assert.equal(a.configSnapshotOpen, true);
  assert.equal(a.configSnapshotLoading, true);
  assert.equal(body.scrollTop, 0);
  a.closeSnapshotModal();
  assert.equal(signal.aborted, true);
  pending.resolve(response({name: 'old', run_dir: 'output/old', content: 'old = true'}));
  await request;
  assert.equal(a.configSnapshotOpen, false);
  assert.equal(a._currentSnapshot, null);

  body.scrollTop = 600;
  global.fetch = async () => response({name: 'new', run_dir: 'output/new', content: 'new = true'});
  await a.viewSnapshot('output/new');
  assert.equal(body.scrollTop, 0);
  assert.equal(content.scrollTop, 0);
  assert.equal(a._currentSnapshot.name, 'new');
  assert.equal(a.configSnapshotLoading, false);
  global.fetch = async () => { throw new Error('network error'); };
  await a.viewSnapshot('output/offline');
  assert.equal(a._currentSnapshot, null);
  assert.equal(a.configSnapshotError, 'configLoadError');
  assert.equal(a.configSnapshotOpen, true);
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

test('copy is single-flight and finishing an apply does not pull the user back after navigation', async () => {
  const pending = deferred();
  let calls = 0, navigations = 0;
  const a = app({form: {output_name: 'keep'}, _routeTransitionSeq: 1,
    navigate() { navigations++; },
    async _applyImportedFlatConfig(form) { calls++; await pending.promise; this.form = {...form}; },
  });
  const snapshot = {name: 'old', reuse_params: {output_name: 'copied'}};
  const request = a.reuseConfig('output/old', snapshot);
  await a.reuseConfig('output/another', snapshot);
  assert.equal(calls, 1);
  a.cancelHistoryInteractions();
  a._routeTransitionSeq++;
  pending.resolve();
  await request;
  assert.equal(a.form.output_name, 'copied');
  assert.equal(a._historyReuseUndo.form.output_name, 'keep');
  assert.equal(navigations, 0);
  assert.equal(a.historyReuseBusy, '');
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

test('background history refresh does not replace modal openers', async () => {
  global.fetch = () => assert.fail('background request while dialog is open');
  for (const state of [{configSnapshotOpen: true}, {showConfirmModal: true}, {historyReuseBusy: 'output/run'}]) {
    const a = app(state);
    await a.loadHistory(true);
    assert.equal(a.historyLoading, false);
  }
});

test('filtering files retains hidden selections and clearing filters restores the full list', () => {
  const a = app({outputFiles: [{path: 'one', name: 'model.safetensors', category: 'model'}, {path: 'two', name: 'log.txt', category: 'log'}],
    outputFilesSelected: {one: true}, outputSearch: 'log', renderDashboard() {},
  });
  assert.deepEqual(a._visibleOutputFiles().map(file => file.path), ['two']);
  a.selectAllOutputFiles();
  assert.deepEqual(a.selectedOutputFiles, ['one', 'two']);
  a.clearOutputFilters();
  assert.equal(a._visibleOutputFiles().length, 2);
  assert.equal(a.outputSearch, '');
});
