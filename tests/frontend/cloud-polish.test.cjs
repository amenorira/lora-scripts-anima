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
