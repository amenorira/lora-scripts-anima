const test = require('node:test');
const assert = require('node:assert/strict');
const { TRAINING_CORE_SCRIPTS, loadFrontend, composeMixins, response, readRepo } = require('./helpers.cjs');

const dictionaries = Object.fromEntries(['zh-CN', 'en-US', 'ja-JP'].map(locale =>
  [locale, JSON.parse(readRepo(`frontend/i18n/${locale}.json`))]));

function translator(locale = 'en-US') {
  return function t(key) {
    return key.split('.').reduce((value, part) => value?.[part], dictionaries[locale]) ?? key;
  };
}

test('resume field uses state-dir pick_type and renders run/epoch/step/size details', async () => {
  const urls = [];
  const { window } = loadFrontend(['shared/utils', ...TRAINING_CORE_SCRIPTS], {
    window: { location: { protocol: 'https:', host: 'host', hostname: 'host', pathname: '/proxy/' } },
    URL,
    URLSearchParams,
    document: { baseURI: 'https://host/proxy/', getElementById: () => null, querySelector: () => null },
    fetch: async (url) => {
      urls.push(url);
      return response({
        files: [{
          name: 'my_lora-step00001000-state',
          path: './output/run_1/my_lora-step00001000-state',
          size: 512 * 1024 * 1024,
          mtime: 1730000000,
          run_name: 'run_1',
          step: 1000,
          epoch: 5,
        }],
      });
    },
  });
  const app = composeMixins(window.utilsMixin, window.trainingCoreMixin, {
    form: { resume: '' }, locale: 'en-US', $nextTick: cb => cb(),
    t: translator('en-US'),
  });

  await app.builtinFilePicker('resume', 'file-folder');
  assert.equal(urls[0], '/proxy/api/get_files?pick_type=state-dir');
  assert.equal(app._pickerKind, 'state-dir');
  assert.equal(app._pickerRoot, './output');
  assert.equal(app._pickerIsDirKind(), true);
  assert.equal(app.pickerSizeText(app._pickerFiles[0]), '512 MB');
  const detail = app.pickerDetailText(app._pickerFiles[0]);
  assert.match(detail, /run_1/);
  assert.match(detail, /5/);
  assert.match(detail, /1000/);
});

test('built-in picker supports mkdir in train-dir mode and refreshes list', async () => {
  const requests = [];
  let listCalls = 0;
  const toasts = [];
  const { window } = loadFrontend(['shared/utils', ...TRAINING_CORE_SCRIPTS], {
    window: { location: { protocol: 'https:', host: 'host', hostname: 'host', pathname: '/sub/' } },
    URL,
    URLSearchParams,
    document: { baseURI: 'https://host/sub/', getElementById: () => null, querySelector: () => null },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method || 'GET', body: opts.body });
      if (url.includes('/api/get_files')) {
        listCalls++;
        const files = listCalls === 1
          ? [{ name: 'ds_a', path: './train/ds_a', images: 10, captioned: 8 }]
          : [
              { name: 'ds_a', path: './train/ds_a', images: 10, captioned: 8 },
              { name: 'new_ds', path: './train/new_ds', images: 0, captioned: 0 },
            ];
        return response({ files });
      }
      if (url.includes('/api/files/mkdir')) {
        return { ok: true, status: 200, json: async () => ({ status: 'success', path: './train/new_ds', name: 'new_ds' }) };
      }
      throw new Error('unexpected url: ' + url);
    },
  });
  const app = composeMixins(window.utilsMixin, window.trainingCoreMixin, {
    form: { train_data_dir: '' }, locale: 'en-US', $nextTick: cb => cb(),
    t: translator('en-US'),
    toast: (msg, type) => toasts.push({ msg, type }),
  });

  await app.builtinFilePicker('train_data_dir', 'file-folder');

  app.pickerOpenMkdir();
  app._pickerMkdirName = 'new_ds';
  await app.pickerSubmitMkdir();

  const mkdirReq = requests.find(r => r.url === '/sub/api/files/mkdir');
  assert.ok(mkdirReq);
  assert.deepEqual(JSON.parse(mkdirReq.body), { parent: './train', name: 'new_ds' });
  assert.equal(listCalls, 2);
  assert.equal(app._pickerCurrent, 'train/new_ds');
  assert.equal(toasts.at(-1).type, 'success');
});

test('tagger, AI captioning, and tag editor wire built-in picker for folders and text files', async () => {
  const calls = [];
  const { window } = loadFrontend(['shared/utils', 'tagger/sources', 'tagger/ai-caption-options', 'tagger/caption-workspace', 'tag-editor/session'], {
    window: {},
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const app = composeMixins(
    window.utilsMixin, window.taggerSourcesMixin, window.captionOptionsMixin, window.captionWorkspaceMixin, window.tagEditorSession,
    {
      currentRoute: 'tagger',
      taggerSourceMode: 'folder',
      taggerSourcePath: './train/old',
      _taggerFormVersion: 1,
      _taggerModeStates: { 'api-folder': {} },
      taggerTaskById: () => null,
      taggerTaskActive: () => false,
      localPickerAvailable: false,
      tagEditorDir: './train/te',
      tagEditorPendingDir: '',
      tagEditorLoadedDir: './train/te',
      t: translator('en-US'),
      scanTaggerSource() { calls.push('scan:' + this.taggerSourcePath); },
      saveCaptionOptions() { calls.push('saveCaption:' + this.captionOptions.prompt_file); },
      tagEditorLoad(dir) { calls.push('teLoad:' + dir); },
      tagEditorModifiedCount: () => 0,
      _teHasUnsavedEdits: () => false,
      _teRemoveDraft() {},
      builtinFilePicker(key, role, target) {
        calls.push({ key, role, label: target.label, current: target.getValue() });
        target.setValue(role === 'text-file' ? './config/custom_prompt.txt' : './train/picked_dir');
      },
    },
  );

  app.browseTaggerFolder();
  assert.equal(app.taggerSourcePath, './train/picked_dir');
  assert.ok(calls.includes('scan:./train/picked_dir'));

  app.currentRoute = 'ai-captioning';
  await app.pickCaptionPath('prompt_file');
  assert.equal(app.captionOptions.prompt_file, './config/custom_prompt.txt');
  assert.equal(calls.find(c => c && c.key === 'prompt_file').role, 'text-file');

  app.currentRoute = 'tagEditor';
  app.tagEditorBrowseFolder('empty');
  assert.equal(app.tagEditorDir, './train/picked_dir');
  assert.ok(calls.includes('teLoad:./train/picked_dir'));
});

test('output_dir preflight shows free_bytes inline with low-space warning below 10 GB', () => {
  const { window } = loadFrontend(['shared/utils', ...TRAINING_CORE_SCRIPTS], { window: {} });
  const app = composeMixins(window.utilsMixin, window.trainingCoreMixin, {
    t: translator('en-US'),
  });

  app.outputPathInfo = { is_default: true, available: true, writable: true, path_is_directory: true, free_bytes: 50 * 1024 * 1024 * 1024 };
  assert.equal(app.outputPathHintVisible(), true);
  assert.equal(app.outputPathStatusClass(), 'is-ok');
  assert.match(app.outputPathSummaryText(), /50\.0 GB/);

  app.outputPathInfo = { is_default: true, available: true, writable: true, path_is_directory: true, free_bytes: 5 * 1024 * 1024 * 1024 };
  assert.equal(app.outputPathStatusClass(), 'is-low-space');
  assert.match(app.outputPathSummaryText(), /Low disk space: 5\.0 GB/);
});

test('environment hero renders compact disk free space from /api/storage/space', () => {
  const { window } = loadFrontend(['shared/utils', 'environment/core', 'environment/render'], { window: {} });
  const app = composeMixins(window.utilsMixin, window.environmentCoreMixin, window.environmentRenderMixin, {
    t: translator('en-US'),
    storageSpace: [{ key: 'output', path: '/workspace/output', free_bytes: 6 * 1024 * 1024 * 1024, total_bytes: 100 * 1024 * 1024 * 1024 }],
  });
  const html = app._renderOverview(k => app.t('environment.' + k));
  assert.match(html, /env-hero-disk is-low/);
  assert.match(html, /6\.00 GB \/ 100 GB/);
});

test('monitor outputs displays selected bytes, hides delete while running, and confirms deletion via openConfirm', async () => {
  const confirms = [];
  const fetchCalls = [];
  const toasts = [];
  const { window } = loadFrontend(['shared/utils', 'monitor/outputs', 'monitor/artifacts-render'], {
    window: { location: { protocol: 'https:', host: 'host', hostname: 'host', pathname: '/p/' } },
    URL,
    document: { baseURI: 'https://host/p/' },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, method: opts?.method || 'GET', body: opts?.body });
      if (url.includes('/outputs/delete')) {
        return { ok: true, status: 200, json: async () => ({ status: 'success', deleted: ['a.safetensors'], freed_bytes: 2 * 1024 * 1024 * 1024, errors: [] }) };
      }
      return response([]);
    },
  });
  const app = composeMixins(window.utilsMixin, window.monitorOutputsMixin, window.monitorArtifactsRenderMixin, {
    selectedRunDir: null,
    monitorData: { state: 'RUNNING', run_dir: 'output/run_1', artifact_available: true },
    trainingActive: true,
    outputFiles: [
      { name: 'a.safetensors', path: 'a.safetensors', category: 'model', size: 2 * 1024 * 1024 * 1024 },
      { name: 'b.safetensors', path: 'b.safetensors', category: 'model', size: 1024 * 1024 * 1024 },
    ],
    outputFilesSelected: { 'a.safetensors': true },
    _outputFilesLoaded: true,
    outputFilesLoading: false,
    outputFilesError: '',
    outputSearch: '',
    outputFilter: 'all',
    escapeJsString: s => String(s || ''),
    get currentOutputRunDir() { return 'output/run_1'; },
    currentArtifactData() { return this.monitorData; },
    renderDashboard() {},
    t: translator('en-US'),
    toast: (msg, type) => toasts.push({ msg, type }),
    openConfirm(opts) { confirms.push(opts); },
  });

  // While RUNNING: selected bytes shown, delete button hidden.
  const runningHtml = app._renderOutputsTab(k => app.t('monitor.' + k));
  assert.match(runningHtml, /2\.0 GB/);
  assert.doesNotMatch(runningHtml, /id="outputDeleteSelected"/);

  // When FINISHED: delete button appears and invokes openConfirm; cancelling leaves outputs untouched, confirming POSTs delete.
  app.trainingActive = false;
  app.monitorData.state = 'FINISHED';
  const finishedHtml = app._renderOutputsTab(k => app.t('monitor.' + k));
  assert.match(finishedHtml, /id="outputDeleteSelected"/);

  // Cancelled path: openConfirm called, onConfirm NOT invoked -> no delete fetch, selection intact.
  app.deleteSelectedOutputs();
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].tone, 'danger');
  assert.match(confirms[0].message, /2\.0 GB/);
  assert.equal(confirms[0].details, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(confirms[0].fields)), [{ label: 'Files to delete', items: ['a.safetensors'] }]);
  assert.equal(fetchCalls.length, 0);
  assert.equal(app.outputFilesSelected['a.safetensors'], true);

  // Confirmed path: invoking onConfirm sends POST delete and clears selection.
  await confirms[0].onConfirm();

  const delCall = fetchCalls.find(c => c.url === '/p/api/monitor/outputs/delete');
  assert.ok(delCall);
  assert.deepEqual(JSON.parse(delCall.body), { run_dir: 'output/run_1', files: ['a.safetensors'] });
  assert.equal(app.outputFilesSelected['a.safetensors'], undefined);
  assert.equal(toasts.at(-1).type, 'success');

  // Verify all selected files (>20) are passed without truncation via fields[].items.
  const manyFiles = Array.from({ length: 25 }, (_, i) => ({
    name: `ckpt_${i}.safetensors`, path: `ckpt_${i}.safetensors`, category: 'model', size: 1024 * 1024,
  }));
  app.outputFiles = manyFiles;
  app.outputFilesSelected = Object.fromEntries(manyFiles.map(f => [f.path, true]));
  app.deleteSelectedOutputs();
  assert.equal(confirms.length, 2);
  assert.equal(confirms[1].details, undefined);
  assert.equal(confirms[1].fields[0].label, 'Files to delete');
  assert.equal(confirms[1].fields[0].items.length, 25);
  assert.deepEqual(Array.from(confirms[1].fields[0].items), manyFiles.map(f => f.path));

  // Verify partial error objects with { file, error } format cleanly (no raw JSON).
  const partialToasts = [];
  const { window: w2 } = loadFrontend(['shared/utils', 'monitor/outputs', 'monitor/artifacts-render'], {
    window: {},
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ status: 'success', deleted: [], freed_bytes: 0, errors: [{ file: 'locked.safetensors', error: 'Permission denied' }] }),
    }),
  });
  const p2 = composeMixins(w2.utilsMixin, w2.monitorOutputsMixin, w2.monitorArtifactsRenderMixin, {
    outputFilesSelected: { 'locked.safetensors': true },
    outputFilesDeleting: false,
    renderDashboard() {},
    loadOutputFiles: async () => {},
    t: translator('en-US'),
    toast: (msg, type, opts) => partialToasts.push({ msg, type, opts }),
  });
  await p2._performDeleteOutputs('output/run_1', ['locked.safetensors']);
  assert.equal(partialToasts.at(-1).type, 'warning');
  assert.equal(partialToasts.at(-1).opts.details, 'locked.safetensors: Permission denied');
});

test('monitor outputs select-all excludes non-deletable task_meta.json from deletion while keeping download intact', async () => {
  const confirms = [];
  const fetchCalls = [];
  const downloads = [];
  const toasts = [];
  const { window } = loadFrontend(['shared/utils', 'monitor/outputs', 'monitor/artifacts-render'], {
    window: {
      location: { protocol: 'https:', host: 'host', hostname: 'host', pathname: '/p/' },
    },
    URL,
    URLSearchParams,
    document: { baseURI: 'https://host/p/' },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, method: opts?.method || 'GET', body: opts?.body });
      if (url.includes('/outputs/delete')) {
        const parsed = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'success',
            deleted: parsed.files,
            freed_bytes: 3 * 1024 * 1024 * 1024,
            errors: [],
          }),
        };
      }
      return response([
        { name: 'task_meta.json', path: 'task_meta.json', category: 'config', size: 1024 * 1024, deletable: false },
      ]);
    },
  });
  window.triggerSafeDownload = (url) => downloads.push(url);
  const app = composeMixins(window.utilsMixin, window.monitorOutputsMixin, window.monitorArtifactsRenderMixin, {
    selectedRunDir: 'output/run_1',
    runDetailData: { state: 'FINISHED', run_dir: 'output/run_1', artifact_available: true },
    monitorData: { state: 'IDLE', run_dir: '', artifact_available: true },
    trainingActive: false,
    outputFiles: [
      { name: 'a.safetensors', path: 'a.safetensors', category: 'model', size: 2 * 1024 * 1024 * 1024, deletable: true },
      { name: 'b.safetensors', path: 'b.safetensors', category: 'model', size: 1024 * 1024 * 1024, deletable: true },
      { name: 'task_meta.json', path: 'task_meta.json', category: 'config', size: 512 * 1024 * 1024, deletable: false },
    ],
    outputFilesSelected: {},
    _outputFilesLoaded: true,
    _outputFilesRequestSeq: 0,
    _outputFilesRunDir: 'output/run_1',
    _outputCountVersion: 0,
    outputFilesVersion: 0,
    outputFilesLoading: false,
    outputFilesError: '',
    outputSearch: '',
    outputFilter: 'all',
    escapeJsString: s => String(s || ''),
    get currentOutputRunDir() { return 'output/run_1'; },
    currentArtifactData() { return this.runDetailData; },
    renderDashboard() {},
    t: translator('en-US'),
    toast: (msg, type) => toasts.push({ msg, type }),
    openConfirm(opts) { confirms.push(opts); },
  });

  // Select all visible selects checkpoints AND task_meta.json.
  app.selectAllOutputFiles();
  assert.deepEqual(Array.from(app.selectedOutputFiles), ['a.safetensors', 'b.safetensors', 'task_meta.json']);
  assert.equal(app.selectedOutputBytes, (3 * 1024 + 512) * 1024 * 1024);

  // Download selected still includes all selected items including task_meta.json.
  await app.downloadSelectedOutputs();
  assert.equal(downloads.length, 1);
  assert.match(downloads[0], /path=task_meta\.json/);
  assert.match(downloads[0], /path=a\.safetensors/);
  assert.match(downloads[0], /path=b\.safetensors/);

  // Deletable getters exclude task_meta.json.
  assert.deepEqual(Array.from(app.deletableSelectedOutputFiles), ['a.safetensors', 'b.safetensors']);
  assert.equal(app.deletableSelectedOutputBytes, 3 * 1024 * 1024 * 1024);

  const mixedHtml = app._renderOutputsTab(k => app.t('monitor.' + k));
  const mixedDeleteBtn = mixedHtml.match(/<button[^>]*id="outputDeleteSelected"[^>]*>/);
  assert.ok(mixedDeleteBtn);
  assert.doesNotMatch(mixedDeleteBtn[0], /\sdisabled(?:\s|>)/);

  // Confirm dialog and POST payload only include deletable files and their total size.
  app.deleteSelectedOutputs();
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].message, /2/);
  assert.match(confirms[0].message, /3\.0 GB/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(confirms[0].fields)),
    [{ label: 'Files to delete', items: ['a.safetensors', 'b.safetensors'] }],
  );
  await confirms[0].onConfirm();

  const delCall = fetchCalls.find(c => c.url === '/p/api/monitor/outputs/delete');
  assert.ok(delCall);
  assert.deepEqual(JSON.parse(delCall.body), {
    run_dir: 'output/run_1',
    files: ['a.safetensors', 'b.safetensors'],
  });

  // When ONLY task_meta.json is selected (including fallback without explicit deletable flag):
  // #outputDeleteSelected is disabled, #outputDownload stays enabled, and no delete request is sent.
  app.outputFiles = [
    { name: 'task_meta.json', path: 'task_meta.json', category: 'config', size: 1024 },
  ];
  app.outputFilesSelected = { 'task_meta.json': true };
  assert.equal(app._isOutputItemDeletable({ rel_path: 'task_meta.json' }), false);
  assert.deepEqual(Array.from(app.selectedOutputFiles), ['task_meta.json']);
  assert.deepEqual(Array.from(app.deletableSelectedOutputFiles), []);
  assert.equal(app.deletableSelectedOutputBytes, 0);

  const metaOnlyHtml = app._renderOutputsTab(k => app.t('monitor.' + k));
  const metaOnlyDeleteBtn = metaOnlyHtml.match(/<button[^>]*id="outputDeleteSelected"[^>]*>/);
  const metaOnlyDownloadBtn = metaOnlyHtml.match(/<button[^>]*id="outputDownload"[^>]*>/);
  assert.ok(metaOnlyDeleteBtn);
  assert.match(metaOnlyDeleteBtn[0], /\sdisabled(?:\s|>)/);
  assert.match(metaOnlyDeleteBtn[0], /:disabled="outputFilesLoading \|\| outputFilesDeleting \|\| !deletableSelectedOutputFiles\.length"/);
  assert.ok(metaOnlyDownloadBtn);
  assert.doesNotMatch(metaOnlyDownloadBtn[0], /\sdisabled(?:\s|>)/);

  const fetchCountBefore = fetchCalls.length;
  app.deleteSelectedOutputs();
  assert.equal(confirms.length, 1);
  assert.equal(fetchCalls.length, fetchCountBefore);
});

test('picker mkdir handles FastAPI detail and non-JSON proxy errors cleanly', async () => {
  const toasts = [];
  let mode = 'detail';
  const { window } = loadFrontend(['shared/utils', ...TRAINING_CORE_SCRIPTS], {
    window: {},
    document: { getElementById: () => null, querySelector: () => null },
    fetch: async () => {
      if (mode === 'detail') {
        return { ok: false, status: 400, json: async () => ({ detail: 'Folder already exists' }) };
      }
      return { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    },
  });
  const app = composeMixins(window.utilsMixin, window.trainingCoreMixin, {
    _pickerKind: 'train-dir', _pickerRoot: './train', _pickerMkdirName: 'dup',
    t: translator('en-US'),
    toast: (msg, type) => toasts.push({ msg, type }),
  });

  await app.pickerSubmitMkdir();
  assert.deepEqual(toasts.at(-1), { msg: 'Folder already exists', type: 'error' });

  mode = 'html';
  app._pickerMkdirName = 'dup2';
  await app.pickerSubmitMkdir();
  assert.deepEqual(toasts.at(-1), { msg: 'Failed to create folder', type: 'error' });
});

test('resetAllParams prompts with openConfirm before resetting form (cancelled vs confirmed)', () => {
  const confirms = [];
  let performed = 0;
  const { window } = loadFrontend(['shared/utils', ...TRAINING_CORE_SCRIPTS], { window: {} });
  const app = composeMixins(window.utilsMixin, window.trainingCoreMixin, {
    form: { model_train_type: 'anima-lora', learning_rate: '9e-4' },
    currentTrainTypeLabel: 'Anima LoRA',
    t: translator('en-US'),
    openConfirm(opts) { confirms.push(opts); },
    _performResetAllParams() { performed++; this.form.learning_rate = '1e-4'; },
  });

  // Cancelled path: dialog opened without calling onConfirm -> form remains untouched.
  app.resetAllParams();
  assert.equal(performed, 0);
  assert.equal(app.form.learning_rate, '9e-4');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].tone, 'warning');

  // Confirmed path: invoking onConfirm runs reset.
  confirms[0].onConfirm();
  assert.equal(performed, 1);
  assert.equal(app.form.learning_rate, '1e-4');
});

test('trainingControlMixin defaults controlSaveWeights/controlSaveState to false and resets them on Stop dialog open', async () => {
  const requests = [];
  const { window } = loadFrontend('training/run-control', {
    window: {},
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method || 'GET', body: opts.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: 'running',
          allowed: ['stop'],
          updated_at: 10,
          progress: { step: 50, total_steps: 100 },
        }),
      };
    },
  });
  assert.equal(window.trainingControlMixin.controlSaveWeights, false);
  assert.equal(window.trainingControlMixin.controlSaveState, false);

  const app = composeMixins(window.trainingControlMixin, {
    liveTaskId: 'task-1',
    currentRoute: 'monitor-dashboard',
    t: translator('en-US'),
    toast() {},
    scheduleRender() {},
    _wakeTrainingStatePoll() {},
  });

  // Even if previously toggled on, opening the Stop dialog resets both flags to false.
  app.controlSaveWeights = true;
  app.controlSaveState = true;
  await app.openTrainingControl('stop');
  assert.equal(app.controlSaveWeights, false);
  assert.equal(app.controlSaveState, false);

  await app.submitTrainingControl('stop');
  const postReq = requests.find(r => r.method === 'POST');
  assert.ok(postReq);
  assert.deepEqual(JSON.parse(postReq.body), { action: 'stop', mode: 'discard' });
});

test('browser completion notifications are gated by desktopNotifications preference', () => {
  const shown = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(title, opts) { shown.push({ title, body: opts.body }); }
  }
  const { window } = loadFrontend(['shared/utils', 'monitor/core'], {
    window: { Notification: FakeNotification },
    Notification: FakeNotification,
    document: { title: 'Anima' },
    setInterval: () => 1,
    clearInterval() {},
  });
  const app = composeMixins(window.utilsMixin, window.monitorCoreMixin, {
    desktopNotifications: false,
    t: translator('en-US'),
    toast() {},
  });

  app.handleTaskCompletion('RUNNING', 'FINISHED');
  assert.equal(shown.length, 0);

  app.desktopNotifications = true;
  app.handleTaskCompletion('RUNNING', 'FINISHED');
  assert.equal(shown.length, 1);
});

test('tag editor directory inputs use shared field-input-wrap with local and built-in folder pickers and confirm dialog has no copy/fold details', () => {
  const html = readRepo('frontend/index.html');
  const css = readRepo('frontend/css/app.css');

  assert.doesNotMatch(html, /te-dir-input-wrap|te-dir-browse-btn/);
  assert.doesNotMatch(css, /te-dir-input-wrap|te-dir-browse-btn/);

  const emptyStart = html.indexOf('<div class="te-empty-actions">');
  const emptyEnd = html.indexOf('</div>\n          <!-- 未加载数据集时', emptyStart);
  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart);
  const emptyBlock = html.slice(emptyStart, emptyEnd);
  assert.match(
    emptyBlock,
    /<div class="field-input-wrap">[\s\S]*?<input[^>]*x-model="tagEditorDir"[\s\S]*?<div class="field-input-actions">[\s\S]*?x-show="localPickerAvailable"[^>]*@click="tagEditorPickLocalFolder\('empty'\)"[\s\S]*?@click="tagEditorBrowseFolder\('empty'\)"[\s\S]*?<\/div>[\s\S]*?<\/div>/,
  );
  assert.doesNotMatch(emptyBlock, /x-text="t\('common\.browse'\)"/);

  const switchStart = html.indexOf('<div class="te-dataset-switch"');
  const switchEnd = html.indexOf('</div>\n            </div>', switchStart);
  assert.ok(switchStart >= 0 && switchEnd > switchStart);
  const switchBlock = html.slice(switchStart, switchEnd);
  assert.match(
    switchBlock,
    /<div class="field-input-wrap">[\s\S]*?<input id="te-switch-dir-input"[\s\S]*?<div class="field-input-actions">[\s\S]*?x-show="localPickerAvailable"[^>]*@click="tagEditorPickLocalFolder\('switch'\)"[\s\S]*?@click="tagEditorBrowseFolder\('switch'\)"[\s\S]*?<\/div>[\s\S]*?<\/div>/,
  );

  const dialogStart = html.indexOf('<dialog id="confirmDialog"');
  const dialogEnd = html.indexOf('</dialog>', dialogStart);
  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart);
  const dialogBlock = html.slice(dialogStart, dialogEnd);
  assert.doesNotMatch(dialogBlock, /copyConfirmDetails/);
  assert.doesNotMatch(dialogBlock, /<details[^>]*confirm-details/);
  assert.match(dialogBlock, /<div class="confirm-details"[^>]*x-ref="confirmDetails"/);
});

test('tagEditorPickLocalFolder picks folders for empty/switch states and handles unavailable error', async () => {
  const calls = [];
  const toasts = [];
  let reply = { status: 'success', data: { path: './train/local_ds' } };
  const { window } = loadFrontend(['shared/utils', 'tag-editor/session'], {
    window: { location: { protocol: 'https:', host: 'host', hostname: 'host', pathname: '/sub/' } },
    URL,
    URLSearchParams,
    document: { baseURI: 'https://host/sub/' },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => reply };
    },
  });
  const app = composeMixins(window.utilsMixin, window.tagEditorSession, {
    currentRoute: 'tagEditor',
    tagEditorDir: '',
    tagEditorPendingDir: '',
    tagEditorLoadedDir: './train/old',
    t: translator('en-US'),
    toast: (msg, type) => toasts.push({ msg, type }),
    tagEditorLoad(dir) { calls.push('load:' + dir); },
    tagEditorModifiedCount: () => 0,
    _teHasUnsavedEdits: () => false,
    _teRemoveDraft() {},
  });

  await app.tagEditorPickLocalFolder('empty');
  assert.match(calls[0], /^\/sub\/api\/pick_file\?picker_type=folder/);
  assert.equal(app.tagEditorDir, './train/local_ds');
  assert.ok(calls.includes('load:./train/local_ds'));

  reply = { status: 'success', data: { path: './train/switched_ds' } };
  await app.tagEditorPickLocalFolder('switch');
  assert.equal(app.tagEditorPendingDir, './train/switched_ds');
  assert.ok(calls.includes('load:./train/switched_ds'));

  reply = { status: 'error', message: 'tkinter unavailable' };
  await app.tagEditorPickLocalFolder('empty');
  assert.equal(toasts.at(-1).type, 'error');
});

test('tagEditorLoad empty state initializes tag dictionary and starts worker when already installed', async () => {
  let initCalls = 0;
  let ensureCalls = 0;
  let workerStarts = 0;
  const posted = [];
  class FakeWorker {
    constructor(url) {
      workerStarts++;
      this.url = url;
    }
    postMessage(msg) { posted.push({ url: this.url, msg }); }
    terminate() {}
  }
  const { window } = loadFrontend(['shared/utils', 'tag-dictionary/index', 'tag-editor/session'], {
    window: { location: { protocol: 'https:', host: 'host', hostname: 'host', pathname: '/sub/' }, Worker: FakeWorker },
    Worker: FakeWorker,
    URL,
    AbortSignal,
    setTimeout: () => 1,
    clearTimeout() {},
    document: { baseURI: 'https://host/sub/' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({
      ok: true, status: 200,
      json: async () => ({ status: 'success', data: { installed: true, status: 'ready', tag_count: 100 } }),
    }),
  });
  const baseInit = window.tagDictionaryMixin.tagDictionaryInit;
  const baseEnsure = window.tagDictionaryMixin.tagDictionaryEnsureWorker;
  const app = composeMixins(window.utilsMixin, window.tagDictionaryMixin, window.tagEditorSession, {
    currentRoute: 'tagEditor',
    tagEditorDir: '',
    tagDictionaryServer: { installed: true, status: 'ready', tag_count: 100 },
    t: translator('en-US'),
    finishProgress() {},
    tagEditorClosePanelMenu() {},
    tagEditorCancelQuickRemove() {},
    _teClearInlineLookupTimer() {},
    tagDictionaryInit() { initCalls++; return baseInit.call(this); },
    tagDictionaryEnsureWorker() { ensureCalls++; return baseEnsure.call(this); },
  });

  await app.tagEditorLoad('');
  assert.equal(initCalls, 1);
  assert.equal(ensureCalls, 1);
  assert.equal(workerStarts, 1);
  assert.equal(posted[0].url, '/sub/anima-ui/js/tag-dictionary/worker.js');
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0].msg)), { type: 'INIT', base: '/sub/api/tageditor/dictionary/asset/' });
});
