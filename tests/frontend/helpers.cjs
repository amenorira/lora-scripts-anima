const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '../..');
const readRepo = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const readFrontend = name => readRepo(`frontend/js/${name.replace(/\.js$/, '')}.js`);

function loadFrontend(files, context = { window: {} }) {
  if (!vm.isContext(context)) vm.createContext(context);
  for (const file of [].concat(files)) {
    vm.runInContext(readFrontend(file), context, { filename: `${file.replace(/\.js$/, '')}.js` });
  }
  return context;
}

// These tests intentionally compare arrays and objects in Node's own realm.
function loadGlobalFrontend(files) {
  global.window = {};
  for (const file of [].concat(files)) vm.runInThisContext(readFrontend(file), { filename: `${file.replace(/\.js$/, '')}.js` });
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

module.exports = { ROOT, readRepo, readFrontend, loadFrontend, loadGlobalFrontend, response, deferred, composeMixins };
