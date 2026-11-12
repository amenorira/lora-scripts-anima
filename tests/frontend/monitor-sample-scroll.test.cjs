const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins} = require('./helpers.cjs');

test('successive inserted samples keep the same card at the same scroll position', () => {
  let keys = Array.from({length: 30}, (_, index) => `sample/${index}.png`);
  function makeGrid(items) {
    const grid = {
      scrollTop: 0,
      getBoundingClientRect: () => ({top: 0, bottom: 400}),
      querySelectorAll: () => items.map((key, index) => ({
        dataset: {previewPath: key},
        getBoundingClientRect: () => ({top: Math.floor(index / 6) * 200 - grid.scrollTop, bottom: Math.floor(index / 6) * 200 - grid.scrollTop + 200}),
      })),
    };
    return grid;
  }
  let grid = makeGrid(keys);
  grid.scrollTop = 150;
  const panel = {
    firstElementChild: {}, classList: {add() {}}, contains: () => false,
    querySelector: selector => selector === '.preview-grid' ? grid : null,
    set innerHTML(_html) { grid = makeGrid(keys); },
  };
  const content = {querySelector: () => panel};
  const {window} = loadFrontend(['monitor/render'], {
    window: {}, document: {activeElement: {}, getElementById: id => id === 'monitorTabContent' ? content : null},
  });
  const app = composeMixins(window.monitorRenderMixin, {
    _builtTab: 'samples', _shellLocale: 'zh', previewsVersion: 0,
    _renderSamplesTab: () => '', _cancelPreviewMediaQueue() {}, _capturePreviewMedia: () => new Map(), _restorePreviewMedia() {}, schedulePreviewMediaLoads() {},
  });
  for (let index = 0; index < 6; index++) {
    keys = [`new/${index}.png`, ...keys];
    app.previewsVersion++;
    app._renderTab('samples', {}, null, null, key => key, false);
  }
  const original = grid.querySelectorAll('.preview-grid-item').find(item => item.dataset.previewPath === 'sample/0.png');
  assert.equal(original.getBoundingClientRect().top, -150);
  assert.equal(grid.scrollTop, 350);
});
