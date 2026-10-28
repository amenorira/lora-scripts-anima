const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const readRepo = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const readFrontend = name => readRepo(`frontend/js/${name.replace(/\.js$/, '')}.js`);

const FRONTEND_DEPENDENCIES = {
  'monitor-core': ['monitor-previews'],
  'monitor-render': ['monitor-summary', 'monitor-diagnostics', 'monitor-resources', 'monitor-artifacts-render', 'monitor-history-render', ],
  'tagger': ['tagger-tasks', 'tagger-sources', ],
  'environment-render': ['environment-dictionary-render', 'environment-components-render', 'environment-models-render', ],
};
const frontendScripts = files => [].concat(files).flatMap(file => [
  ...(FRONTEND_DEPENDENCIES[file.replace(/\.js$/, '')] || []), file,
]);

function loadFrontend(files, context = { window: {} }) {
  if (!vm.isContext(context)) vm.createContext(context);
  for (const file of frontendScripts(files)) {
    vm.runInContext(readFrontend(file), context, { filename: `${file.replace(/\.js$/, '')}.js` });
  }
  return context;
}

const TRAINING_CORE_SCRIPTS = [
  'training-field-relations', 'training-network-panel', 'training-field-renderer', 'training-timestep-preview', 'training-conditions', 'training-sections', 'training-validation', 'training-profiles', 'training-preflight', 'training-file-picker', 'training-core',
];

function loadTagEditor(context = { window: {} }) {
  return loadFrontend([
    'tag-editor-session', 'tag-editor-edits', 'tag-editor-persistence',
    'tag-editor-view', 'tag-editor-actions', 'tag-editor-filters', 'tag-editor',
  ], context);
}

// These tests intentionally compare arrays and objects in Node's own realm.
function loadGlobalFrontend(files) {
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

module.exports = { TRAINING_CORE_SCRIPTS, ROOT, readRepo, readFrontend, loadFrontend, loadTagEditor, loadGlobalFrontend, response, deferred, composeMixins };
