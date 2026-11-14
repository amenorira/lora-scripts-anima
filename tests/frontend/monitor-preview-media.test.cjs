const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred} = require('./helpers.cjs');

function fixture() {
  const requests = [], created = [], revoked = [];
  const {window} = loadFrontend(['monitor/previews'], {
    window: {}, document: {getElementById: () => null}, AbortController,
    URL: {createObjectURL() {const source = 'blob:thumb-' + (created.length + 1); created.push(source); return source;},
      revokeObjectURL(source) {revoked.push(source);}},
    fetch(url, options) {const request = {...deferred(), url, options}; requests.push(request); return request.promise;},
  });
  const app = composeMixins(window.monitorPreviewsMixin, {
    weakNetworkMode: true, _previewMediaQueue: [], _previewMediaObjectUrls: [], _previewMediaGeneration: 0,
    _previewMediaLoading: false, _previewMediaPaused: false,
  });
  const image = (url = '/thumb?v=1') => ({isConnected: true, complete: true, naturalWidth: 320,
    dataset: {previewUrl: url}, src: '',
    getAttribute(name) {return name === 'src' ? this.src : null;},
    closest(selector) {return selector === '.preview-thumb-frame' ? {classList: {contains: () => false, add() {}}} : {dataset: {previewPath: 'sample.png'}};},
  });
  const root = images => ({querySelectorAll: () => images});
  const resolve = request => request.resolve({ok: true, blob: async () => ({})});
  const tick = () => new Promise(done => setImmediate(done));
  return {app, requests, created, revoked, image, root, resolve, tick};
}

test('weak mode shares one versioned thumbnail across the grid and timeline, including late consumers', async () => {
  const {app, requests, created, revoked, image, root, resolve, tick} = fixture();
  const grid = image(), rail = image();
  app.schedulePreviewMediaLoads(root([grid, rail]));
  assert.equal(requests.length, 1);
  resolve(requests[0]); await tick();
  assert.equal(requests.length, 1);
  assert.equal(created.length, 1);
  assert.equal(grid.src, rail.src);
  const viewerRail = image();
  app.schedulePreviewMediaLoads(root([viewerRail]));
  assert.equal(viewerRail.src, grid.src);
  assert.equal(requests.length, 1);
  const newer = image('/thumb?v=2');
  app.schedulePreviewMediaLoads(root([newer]));
  resolve(requests[1]); await tick();
  assert.notEqual(newer.src, grid.src);
  app._releasePreviewMediaObjectUrls();
  assert.deepEqual(revoked, created);
  assert.equal(app._previewMediaByUrl.size, 0);
});

test('cancelled thumbnail requests cannot populate a new queue or retain a stale blob', async () => {
  const {app, requests, created, image, root, resolve, tick} = fixture();
  const previous = image(), current = image();
  app.schedulePreviewMediaLoads(root([previous]));
  app._cancelPreviewMediaQueue();
  assert.equal(requests[0].options.signal.aborted, true);
  app.schedulePreviewMediaLoads(root([current]));
  resolve(requests[0]); await tick();
  assert.equal(created.length, 0);
  assert.equal(previous.src, '');
  assert.equal(app._previewMediaLoading, true, 'the replacement request retains queue ownership');
  resolve(requests[1]); await tick();
  assert.equal(created.length, 1);
  assert.equal(current.src, created[0]);
  assert.equal(app._previewMediaLoading, false);
});

test('shared thumbnails survive a rebuild and are revoked only after their final DOM reference disappears', async () => {
  const {app, requests, created, revoked, image, root, resolve, tick} = fixture();
  const first = image(), second = image();
  app.schedulePreviewMediaLoads(root([first, second]));
  resolve(requests[0]); await tick();
  const loaded = app._capturePreviewMedia(root([first, second]));
  const replacement = image();
  app._restorePreviewMedia(root([replacement, second]), loaded);
  assert.equal(replacement.src, second.src);
  assert.equal(revoked.length, 0);
  app._restorePreviewMedia(root([replacement]), loaded);
  assert.equal(revoked.length, 0);
  app._restorePreviewMedia(root([]), new Map());
  assert.deepEqual(revoked, created);
  assert.equal(app._previewMediaByUrl.size, 0);
  const next = image();
  app.schedulePreviewMediaLoads(root([next]));
  assert.equal(requests.length, 2, 'a revoked source is never reused');
  resolve(requests[1]); await tick();
  assert.notEqual(next.src, first.src);
});
