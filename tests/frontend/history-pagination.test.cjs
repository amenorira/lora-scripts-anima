const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins } = require('./helpers.cjs');

test('history renders only one page and clamps it after filtering or removal', () => {
  const list = { innerHTML: '', contains: () => false };
  const { window } = loadFrontend(['shared/utils', 'monitor/core', 'monitor/render'], {
    window: {}, document: { getElementById: id => id === 'historyList' ? list : null, activeElement: null },
  });
  const app = composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin, {
    t: key => key, tMonitor: key => key, escapeJsString: value => value,
    historyItems: Array.from({ length: 500 }, (_, index) => ({ name: 'run-' + index, run_dir: 'run-' + index, status: 'completed' })),
  });
  app.renderHistory();
  assert.equal((list.innerHTML.match(/class="hist-card-content is-clickable"/g) || []).length, 30);
  assert.match(list.innerHTML, /@click="_viewHistoryCardSnapshot/);
  assert.match(list.innerHTML, /@keydown\.enter\.prevent=/);
  assert.equal(app.historyPageCount, 17);
  assert.equal(app.historyFilteredCount, 500);
  assert.equal(app.historyPageShown, 30);
  app.setHistoryPage(17);
  assert.equal((list.innerHTML.match(/class="hist-card-content is-clickable"/g) || []).length, 20);
  assert.equal(app.historyPageShown, 20);
  app.historyItems = app.historyItems.slice(0, 10);
  app.renderHistory();
  assert.equal(app.historyPage, 1);
  assert.equal((list.innerHTML.match(/class="hist-card-content is-clickable"/g) || []).length, 10);
  app.historySearch = 'run-2';
  app.renderHistory();
  assert.equal((list.innerHTML.match(/class="hist-card-content is-clickable"/g) || []).length, 1);
  assert.equal(app.historyFilteredCount, 1);
  const opened = [];
  app.viewSnapshot = path => opened.push(path);
  window.getSelection = () => ({ isCollapsed: false, containsNode: () => true });
  app._historyCardPointer = { x: 0, y: 0 };
  app._viewHistoryCardSnapshot('run-2', { detail: 1, clientX: 8, clientY: 0, currentTarget: {} });
  app._viewHistoryCardSnapshot('run-2', { detail: 0 });
  assert.deepEqual(opened, ['run-2']);
});
