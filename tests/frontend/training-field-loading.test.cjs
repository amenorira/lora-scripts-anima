const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, deferred, response } = require('./helpers.cjs');

test('training fields are loaded once on demand and can be retried', async () => {
  const requests = [];
  const { window } = loadFrontend('app/config', {
    window: {},
    fetch(url) {
      assert.equal(url, '/api/fields');
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
  });
  assert.equal(requests.length, 0);
  const first = window.loadTrainingFields();
  assert.equal(window.loadTrainingFields(), first);
  requests[0].reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  const retry = window.loadTrainingFields();
  const sections = [{key: 'training', fields: [{key: 'learning_rate'}]}];
  requests[1].resolve(response({sections}));
  assert.equal(await retry, sections);
  assert.equal(await window.loadTrainingFields(), sections);
  assert.equal(requests.length, 2);
});

test('a late training schema mounts only on the training route', async () => {
  let init, application;
  const fields = deferred();
  loadFrontend('app/index', {
    document: {addEventListener: (event, listener) => { init = listener; }},
    Alpine: {data: (name, factory) => { application = factory; }},
    window: {loadTrainingFields: () => fields.promise},
  });
  init();
  const app = application();
  const mounts = [];
  app.buildTrainForm = () => { mounts.push(app.currentRoute); app._trainFormMountedRoute = app.currentRoute; };
  app.currentRoute = 'train-basic';
  const leaving = app.loadTrainForm();
  app.currentRoute = 'home';
  fields.resolve([]);
  await leaving;
  assert.deepEqual(mounts, []);
  app.currentRoute = 'train-basic';
  await Promise.all([app.loadTrainForm(), app.loadTrainForm()]);
  assert.deepEqual(mounts, ['train-basic']);
});
