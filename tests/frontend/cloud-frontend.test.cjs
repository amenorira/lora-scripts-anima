const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, response } = require('./helpers.cjs');

test('animaBasePath, animaUrl, animaWsUrl and isRemoteOrigin handle root and subpath proxies', () => {
  const root = loadFrontend('shared/net', {
    window: { location: { protocol: 'http:', host: '127.0.0.1:12333', hostname: '127.0.0.1', pathname: '/' } },
    document: { baseURI: 'http://127.0.0.1:12333/' },
    URL,
  }).window;
  assert.equal(root.animaBasePath(), '');
  assert.equal(root.animaUrl('/api/health'), '/api/health');
  assert.equal(root.animaUrl('/anima-ui/i18n/zh-CN.json'), '/anima-ui/i18n/zh-CN.json');
  assert.equal(root.animaWsUrl('/ws/realtime'), 'ws://127.0.0.1:12333/ws/realtime');
  assert.equal(root.isRemoteOrigin(), false);

  const subpath = loadFrontend('shared/net', {
    window: { location: { protocol: 'https:', host: 'colab.example.com', hostname: 'colab.example.com', pathname: '/proxy/12333/' } },
    document: { baseURI: 'https://colab.example.com/proxy/12333/' },
    URL,
  }).window;
  assert.equal(subpath.animaBasePath(), '/proxy/12333');
  assert.equal(subpath.animaUrl('/api/health'), '/proxy/12333/api/health');
  assert.equal(subpath.animaUrl('/proxy/12333/api/health'), '/proxy/12333/api/health');
  assert.equal(subpath.animaUrl('/tensorboard/'), '/proxy/12333/tensorboard/');
  assert.equal(subpath.animaUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  assert.equal(subpath.animaUrl('blob:https://colab.example.com/123'), 'blob:https://colab.example.com/123');
  assert.equal(subpath.animaUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  assert.equal(subpath.animaWsUrl('/ws/realtime?token=abc'), 'wss://colab.example.com/proxy/12333/ws/realtime?token=abc');
  assert.equal(subpath.isRemoteOrigin(), true);

  const htmlPath = loadFrontend('shared/net', {
    window: { location: { protocol: 'https:', host: 'proxy.example.com', hostname: 'proxy.example.com', pathname: '/user/a/proxy/12333/index.html' } },
    document: { baseURI: 'https://proxy.example.com/user/a/proxy/12333/index.html' },
    URL,
  }).window;
  assert.equal(htmlPath.animaBasePath(), '/user/a/proxy/12333');
});

test('copyToClipboard falls back to textarea + execCommand on non-HTTPS remote origins', async () => {
  let selectedValue = '';
  let execCommandCalled = '';
  let appended = false;
  let removed = false;
  const textarea = {
    value: '',
    style: {},
    setAttribute() {},
    focus() {},
    select() { selectedValue = this.value; },
    setSelectionRange() {},
    remove() { removed = true; },
  };
  const { window } = loadFrontend('shared/net', {
    window: {},
    navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } },
    document: {
      activeElement: null,
      body: { appendChild(el) { appended = (el === textarea); } },
      createElement(tag) { assert.equal(tag, 'textarea'); return textarea; },
      execCommand(cmd) { execCommandCalled = cmd; return true; },
    },
  });
  await window.copyToClipboard('hello remote');
  assert.equal(appended, true);
  assert.equal(selectedValue, 'hello remote');
  assert.equal(execCommandCalled, 'copy');
  assert.equal(removed, true);
});

test('triggerSafeDownload resolves subpath URL and surfaces JSON errors via onError', () => {
  let frame;
  const errors = [];
  const { window } = loadFrontend('shared/net', {
    window: { location: { protocol: 'https:', host: 'host', hostname: 'host', pathname: '/proxy/12333/' } },
    document: {
      baseURI: 'https://host/proxy/12333/',
      getElementById: () => null,
      createElement(tag) {
        assert.equal(tag, 'iframe');
        frame = {
          contentDocument: { URL: 'https://host/proxy/12333/api/tageditor/download-zip', body: { textContent: '{"status":"fail","message":"Missing dir"}' } },
        };
        return frame;
      },
      body: { appendChild() {} },
    },
    URL,
  });
  window.triggerSafeDownload('/api/tageditor/download-zip?dir=foo', {
    frameId: 'test-dl',
    onError: result => errors.push(result),
  });
  assert.equal(frame.src, '/proxy/12333/api/tageditor/download-zip?dir=foo');
  assert.equal(frame.hidden, true);
  frame.onload();
  assert.deepEqual(JSON.parse(JSON.stringify(errors)), [{ status: 'fail', message: 'Missing dir' }]);
});

test('currentOutputRunDir accepts canonical relative and external absolute paths while rejecting root sentinels', () => {
  const { window } = loadFrontend('monitor/core', { window: {} });
  const app = composeMixins(window.monitorCoreMixin, {});
  for (const valid of [
    'output/violet_run_1',
    './output/violet_run_1/',
    '/content/drive/MyDrive/Anima_LoRA/output/violet_20261128',
    '/workspace/output/run_42',
    'D:\\Anima\\output\\run_win',
  ]) {
    app.monitorData = { run_dir: valid };
    assert.ok(app.currentOutputRunDir.length > 0, `expected valid run_dir: ${valid}`);
  }
  assert.equal(
    (app.monitorData = { run_dir: '/content/drive/MyDrive/Anima_LoRA/output/violet_20261128' }, app.currentOutputRunDir),
    '/content/drive/MyDrive/Anima_LoRA/output/violet_20261128',
  );
  for (const sentinel of ['', '.', './', '/', 'output', './output', 'output/', 'C:/']) {
    app.monitorData = { run_dir: sentinel };
    assert.equal(app.currentOutputRunDir, '', `expected sentinel rejected: ${sentinel}`);
  }
});

test('notifications deduplicate identical active (type, message) toasts by refreshing timer', () => {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.classList = { add() {} }; }
    appendChild(child) { this.children.push(child); child.parent = this; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute() {}
    contains(element) { return this === element || this.children.some(child => child.contains(element)); }
    remove() { this.removed = true; }
  }
  const container = new Element();
  const { window } = loadFrontend('shared/notifications', {
    window: { AnimaUI: {}, matchMedia: () => ({ matches: true }) },
    document: { createElement: () => new Element(), activeElement: null },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Date: { now: () => now },
    setTimeout: (cb, delay) => { const id = ++nextTimer; timers.set(id, { cb, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const advance = ms => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= now) { timers.delete(id); timer.cb(); }
    }
  };
  const center = window.AnimaUI.createNotifications(container, k => k);
  const first = center.show('Same error', 'error');
  advance(5000);
  const second = center.show('Same error', 'error');
  assert.equal(second, first);
  assert.equal(container.children.length, 1);
  // Original 8s deadline at t=8000 must have been refreshed to t=13000.
  advance(4000);
  assert.equal(first.removed, undefined);
  advance(4000);
  assert.equal(first.removed, true);
});

test('training/toml emits deduplicated training-start-error toasts and uses window.copyToClipboard', async () => {
  const toasts = [];
  const copied = [];
  const { window } = loadFrontend(['shared/utils', 'training/toml'], {
    window: {},
    fetch: async () => { throw new Error('network down'); },
  });
  window.copyToClipboard = async text => { copied.push(text); };

  const app = composeMixins(window.utilsMixin, window.trainingTomlMixin, {
    isTraining: false,
    trainingStarting: false,
    showConfirmModal: false,
    regularizationActive: false,
    datasetRepeatApplying: false,
    currentRoute: 'train-basic',
    _routeTransitionSeq: 1,
    tomlRaw: 'learning_rate = 1e-4',
    t: (key, fallback) => fallback || key,
    toast: (msg, type, opts) => toasts.push({ msg, type, opts }),
    _applyTaskView() {},
    scheduleStepEstimate() {},
  });

  app._showTrainingError({ message: 'bad config', data: {} });
  assert.equal(toasts[0].type, 'error');
  assert.equal(toasts[0].opts.key, 'training-start-error');

  await app.startTraining({ output_name: 'demo' });
  assert.equal(toasts[1].type, 'error');
  assert.equal(toasts[1].opts.key, 'training-start-error');
  assert.match(toasts[1].msg, /network down/);

  app.copyToml();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(copied, ['learning_rate = 1e-4']);
  assert.equal(toasts[2].msg, 'common.copied');
});

test('tag-editor and monitor outputs route downloads through triggerSafeDownload and never window.open', async () => {
  const downloads = [];
  let openCalls = 0;
  const toasts = [];
  const { window } = loadFrontend(['shared/utils', 'tag-editor/index', 'monitor/outputs'], {
    window: { open() { openCalls++; } },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  window.triggerSafeDownload = (url, opts) => downloads.push({ url, opts });

  const tagEditorApp = composeMixins(window.utilsMixin, window.tagEditorMixin, {
    tagEditorDir: './train/my set',
    t: key => key,
    toast: (msg, type, opts) => toasts.push({ msg, type, opts }),
  });
  tagEditorApp.tagEditorDownloadZip();
  assert.equal(openCalls, 0);
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].url, '/api/tageditor/download-zip?dir=.%2Ftrain%2Fmy%20set');
  downloads[0].opts.onError({ message: 'Zip failed' });
  assert.equal(toasts[0].type, 'error');

  const monitorApp = composeMixins(window.utilsMixin, window.monitorOutputsMixin, {
    outputFiles: [
      { name: 'a.safetensors', path: 'a.safetensors', size: 100 },
      { name: 'ckpt-state', path: 'ckpt-state', is_dir: true, size: 200 },
    ],
    outputFilesSelected: { 'a.safetensors': true, 'ckpt-state': true },
    get currentOutputRunDir() { return 'output/run_1'; },
    t: key => key,
    toast: (msg, type, opts) => toasts.push({ msg, type, opts }),
  });
  monitorApp.downloadSingleOutput('a.safetensors');
  monitorApp.downloadSingleOutput('ckpt-state');
  await monitorApp.downloadAllOutputs();
  await monitorApp.downloadSelectedOutputs();

  assert.equal(openCalls, 0);
  assert.deepEqual(downloads.slice(1).map(item => item.url), [
    '/api/monitor/outputs/download-file?run_dir=output%2Frun_1&path=a.safetensors',
    '/api/monitor/outputs/download?run_dir=output%2Frun_1&path=ckpt-state',
    '/api/monitor/outputs/download?run_dir=output%2Frun_1',
    '/api/monitor/outputs/download?run_dir=output%2Frun_1&path=a.safetensors&path=ckpt-state',
  ]);
});

test('app/index initializes localPickerAvailable to false and defaults weakNetworkMode to true on remote origins', () => {
  const createApp = (location, storedSettings = null) => {
    let factory;
    const listeners = {};
    const store = new Map();
    if (storedSettings !== null) store.set('anima-ui-settings', JSON.stringify(storedSettings));
    const context = {
      window: { location },
      document: {
        baseURI: `${location.protocol}//${location.host}${location.pathname}`,
        addEventListener(name, cb) { listeners[name] = cb; },
      },
      navigator: {},
      localStorage: {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, val) => store.set(key, String(val)),
        removeItem: key => store.delete(key),
      },
      Alpine: { data(name, fn) { if (name === 'animaApp') factory = fn; } },
      URL,
    };
    loadFrontend('app/index', context);
    context.window.composeAppMixins = () => {};
    listeners['alpine:init']();
    return factory();
  };

  const remoteApp = createApp({ protocol: 'https:', host: 'demo.trycloudflare.com', hostname: 'demo.trycloudflare.com', pathname: '/' });
  assert.equal(remoteApp.localPickerAvailable, false);
  remoteApp.loadUISettings();
  assert.equal(remoteApp.weakNetworkMode, true);

  const localApp = createApp({ protocol: 'http:', host: '127.0.0.1:12333', hostname: '127.0.0.1', pathname: '/' });
  assert.equal(localApp.localPickerAvailable, false);
  localApp.loadUISettings();
  assert.equal(localApp.weakNetworkMode, false);

  const remoteOverride = createApp({ protocol: 'https:', host: 'demo.trycloudflare.com', hostname: 'demo.trycloudflare.com', pathname: '/' }, { weakNetworkMode: false });
  remoteOverride.loadUISettings();
  assert.equal(remoteOverride.weakNetworkMode, false);
});
