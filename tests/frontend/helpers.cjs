const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '../..');
const readRepo = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const readFrontend = name => readRepo(`frontend/js/${name.replace(/\.js$/, '')}.js`);

let fieldSections;
function trainingFieldSections() {
  const executable = path.join(ROOT, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fieldSections ||= JSON.parse(execFileSync(executable, ['-B', '-X', 'utf8', '-c', [
    'import json',
    'from tools.runtime_paths import configure_test_paths',
    'configure_test_paths()',
    'from backend.training.fields.field_registry import get_fields_json',
    'print(json.dumps(get_fields_json()["sections"]))',
  ].join('\n')], {cwd: ROOT, encoding: 'utf8'}));
  return fieldSections;
}

const FRONTEND_DEPENDENCIES = {
  'environment/core': ['environment/loading', 'environment/models', 'environment/components', 'environment/tasks'],
  'monitor/core': ['monitor/logs', 'monitor/metrics', 'monitor/history', 'monitor/outputs', 'monitor/previews', 'monitor/dataset-diagnostics'],
  'monitor/render': [
    'shared/utils', 'monitor/logs', 'monitor/metrics', 'monitor/summary', 'monitor/diagnostics',
    'monitor/resource-bar', 'monitor/sample-layout', 'monitor/artifacts-render', 'monitor/history-render',
    'monitor/dataset-diagnostics-format', 'monitor/dataset-diagnostics-scatter',
    'monitor/dataset-diagnostics-timestep', 'monitor/dataset-diagnostics-modal', 'monitor/dataset-diagnostics-render',
  ],
  'monitor/artifacts-render': ['monitor/sample-layout'],
  'monitor/resource-bar': ['shared/utils'],
  'tagger/index': ['shared/utils', 'tagger/tasks', 'tagger/sources', ],
  'regularization/index': ['shared/utils'],
  'tag-editor/index': ['tag-editor/session', 'tag-editor/edits', 'tag-editor/persistence', 'tag-editor/view', 'tag-editor/actions', 'tag-editor/filters'],
  'environment/render': ['environment/dictionary-render', 'environment/components-render', 'environment/models-render', ],
};
const frontendScripts = files => ['shared/mixin-compose', 'shared/image-viewport', ...[].concat(files).flatMap(file => [
  ...(FRONTEND_DEPENDENCIES[file.replace(/\.js$/, '')] || []), file,
])];

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
    clear() { store.clear(); },
  };
}

function silenceUnconfiguredLocalStorage() {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (desc && desc.get) {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    });
  }
}

function loadFrontend(files, context = { window: {} }) {
  if (!vm.isContext(context)) vm.createContext(context);
  for (const file of frontendScripts(files)) {
    vm.runInContext(readFrontend(file), context, { filename: `${file.replace(/\.js$/, '')}.js` });
  }
  return context;
}

const TRAINING_CORE_SCRIPTS = [
  'training/field-relations', 'training/network-panel', 'training/field-renderer', 'training/preview-loras', 'training/timestep-preview', 'training/conditions', 'training/sections', 'training/validation', 'training/profiles', 'training/preflight', 'training/file-picker', 'training/core',
];

function loadTagEditor(context = { window: {} }) {
  return loadFrontend([
    'tag-editor/session', 'tag-editor/edits', 'tag-editor/persistence',
    'tag-editor/view', 'tag-editor/actions', 'tag-editor/filters', 'tag-editor/index',
  ], context);
}

// These tests intentionally compare arrays and objects in Node's own realm.
function loadGlobalFrontend(files) {
  silenceUnconfiguredLocalStorage();
  global.window = {};
  for (const file of frontendScripts(files)) vm.runInThisContext(readFrontend(file), { filename: `${file.replace(/\.js$/, '')}.js` });
}

const response = data => ({ ok: true, json: async () => ({ status: 'success', data }) });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function composeMixins(...sources) {
  const app = {};
  for (const source of sources) Object.defineProperties(app,Object.getOwnPropertyDescriptors(source));
  return app;
}

module.exports = { TRAINING_CORE_SCRIPTS, ROOT, readRepo, readFrontend, loadFrontend, loadTagEditor, loadGlobalFrontend, createMemoryStorage, response, deferred, composeMixins, trainingFieldSections };
