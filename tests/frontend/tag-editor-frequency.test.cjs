const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTagEditor } = require('./helpers.cjs');

test('incremental frequencies match a full rescan when duplicate tag counts change', () => {
  const cases = [
    ['blue, blue, sky', 'blue, sky'],
    ['blue', 'blue, blue'],
    ['blue, blue', 'green, green'],
    ['blue, sky', 'sky, blue'],
  ];
  const count = captions => {
    const counts = new Map();
    for (const caption of captions) for (const tag of caption.split(',').map(s => s.trim()).filter(Boolean)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return counts;
  };
  for (const [before, after] of cases) {
    const { window } = loadTagEditor();
    const app = Object.assign({}, window.tagEditorMixin, {
      tagEditorTagFreq: [...count([before, 'blue, green'])].map(([tag, count]) => ({ tag, count })),
      _teScheduleFreqFinalize() {},
    });
    app._teRebuildFreqIndex();
    app._teUpdateFreq(before, after);
    const actual = app.tagEditorTagFreq.filter(item => item.count > 0).map(item => [item.tag, item.count]).sort();
    assert.deepEqual(actual, [...count([after, 'blue, green'])].sort(), `${before} -> ${after}`);
  }
});
