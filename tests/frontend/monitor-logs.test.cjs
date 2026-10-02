const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
global.window = {};
eval(fs.readFileSync('frontend/js/monitor-logs.js', 'utf8'));
const log = window.monitorLogRenderMixin;
const record = (second, message = 'epoch is incremented. current_epoch: 0, epoch: 17', source = 'dataset.py:462') =>
  `2026-10-02 11:29:${second} INFO     ${message}  ${source}`;

test('consecutive records ignore timestamps, retain source rows and never alter input', () => {
  const lines = Array.from({ length: 8 }, (_, i) => record(22 + i));
  const original = lines.slice();
  const entries = log._coalesceRichLogLines(lines, 100);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 8);
  assert.equal(entries[0].lineNo, 101);
  assert.equal(entries[0].text, lines[0]);
  assert.deepEqual(lines, original);
});

test('progress, continuations and intervening messages break groups before filtering', () => {
  const step = 'steps: 67%|#######---| 322/480 [27:49<13:39, 5.18s/it, avr_loss=.0493]';
  const lines = [record(22), record(23), 'WARNING other', record(24), step, step, '', '', '  batch_size: 2', '  batch_size: 2'];
  const entries = log._coalesceRichLogLines(lines, 0, 'epoch');
  assert.deepEqual(entries.map(e => e.count), [2, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(entries.filter(e => e.text.includes('epoch')).length, 2);
});

test('different sources, levels or epoch values must not merge', () => {
  const entries = log._coalesceRichLogLines([
    record(22), record(23, undefined, 'dataset.py:463'),
    record(24).replace('INFO', 'WARNING'), record(25).replace('epoch: 17', 'epoch: 18'),
  ], 0);
  assert.equal(entries.length, 4);
});

test('timestamp search exposes matching record while counts and page offsets remain exact', () => {
  const lines = Array.from({ length: 8 }, (_, i) => record(22 + i));
  const entries = log._coalesceRichLogLines(lines, 20, '11:29:27');
  assert.equal(entries[0].text, lines[5]);
  assert.equal(entries[0].count, 8);
  assert.equal(entries[0].lineNo, 21);
  assert.equal(log._coalesceRichLogLines(lines.slice(0, 3), 20)[0].count, 3);
  const next = log._coalesceRichLogLines(lines.slice(3), 23)[0];
  assert.equal(next.count, 5);
  assert.equal(next.lineNo, 24);
});

function rendering() {
  const nodes = [];
  const container = {
    inserts: 0, scrollTop: 0, scrollHeight: 2000, clientHeight: 300,
    get firstElementChild() { return nodes[0] || null; },
    querySelectorAll() { return nodes.slice(); },
    getBoundingClientRect() { return { top: 100 }; },
    insertBefore(node, before) {
      this.inserts++;
      node.remove();
      nodes.splice(before ? nodes.indexOf(before) : nodes.length, 0, node);
    },
  };
  const app = Object.assign({}, log, {
    logFullLines: [], logFullOffset: 0, logFullMatches: [], logFullMatchIdx: -1,
    logAutoScroll: false, _logAtBottom: false, t: key => key,
    _setLogRepeatCount(node, count) { node.dataset.repeatCount = String(count); },
    _buildLogLineDom(text, search, cls, lineNo, count) {
      const badge = {};
      return { text, dataset: { lineNo: String(lineNo), repeatCount: String(count) },
        className: 'log-line' + (cls ? ' ' + cls : ''), offsetHeight: 20,
        querySelector() { return Number(this.dataset.repeatCount) > 1 ? badge : null; },
        get nextElementSibling() { return nodes[nodes.indexOf(this) + 1] || null; },
        getBoundingClientRect() { return { top: 100 + (lineNo - 1) * 20 }; },
        remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); },
      };
    },
  });
  const root = { querySelector: () => container };
  return { app, nodes, container, render: (reuse = true) => app._populateFullLogs(root, reuse) };
}

test('live rendering preserves existing DOM, updates badge and handles page eviction', () => {
  const { app, nodes, container, render } = rendering();
  app.logFullLines = ['start', record(22), record(23)];
  render(false);
  const first = nodes[0], group = nodes[1];
  container.inserts = 0;
  app.logFullLines.push(record(24));
  render();
  assert.equal(nodes[0], first);
  assert.equal(nodes[1], group);
  assert.equal(group.dataset.repeatCount, '3');
  assert.equal(container.inserts, 0);
  app.logFullLines.push('steps: 10%|x| 1/10 [loss=.8]');
  render();
  assert.equal(container.inserts, 1);
  const step = nodes[2];
  app.logFullLines.splice(0, 2);
  app.logFullOffset = 2;
  container.inserts = 0;
  render();
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].dataset.lineNo, '3');
  assert.equal(nodes[0].dataset.repeatCount, '2');
  assert.equal(nodes[1], step);
  assert.equal(container.inserts, 1, 'only clipped group is replaced');
});

test('changed final frame replaces only that row and preserves paused scroll', () => {
  const { app, nodes, container, render } = rendering();
  app.logFullLines = ['start', 'partial'];
  render(false);
  const first = nodes[0];
  container.scrollTop = 75;
  container.inserts = 0;
  app.logFullLines[1] = 'partial completed';
  render();
  assert.equal(nodes[0], first);
  assert.equal(nodes[1].text, 'partial completed');
  assert.equal(container.inserts, 1);
  assert.equal(container.scrollTop, 75);
});

test('search selects the exact repeated record and scrolls to its group', () => {
  const { app, nodes, container, render } = rendering();
  app.logFullLines = Array.from({length:8}, (_, i) => record(22 + i));
  app.logFullOffset = 50;
  app.logFullQuery = 'epoch';
  app.logFullMatches = [50,51,52,53,54,55,56,57];
  app.logFullMatchIdx = 3;
  app._logScrollTarget = 53;
  render(false);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].text, record(25));
  assert.match(nodes[0].className, /log-line-current-match/);
  assert.ok(container.scrollTop > 0);
  assert.equal(app._logScrollTarget, null);
});

test('shared header parser accepts WARN and fractional timestamps without classifying message words', () => {
  const parsed = log._parseLogRecord('2026-10-02 11:29:22.123 WARN     file error.log loaded  loader.py:12');
  assert.equal(parsed.level, 'WARN');
  assert.equal(parsed.source, 'loader.py:12');
  assert.equal(log._splitRichLogSource('WARN message  loader.py:12').source, 'loader.py:12');
  assert.equal(log._parseLogRecord('  File "error.py", line 3'), null);
  assert.equal(log._parseLogRecord('INFO error.log loaded').level, 'INFO');
});

test('binding scroll and searching at the bottom do not resume a paused view', () => {
  const container = { scrollHeight: 500, scrollTop: 200, clientHeight: 300 };
  const app = Object.assign({}, log, { logAutoScroll: false, _logAtBottom: false, logFullQuery: 'loss' });
  app._bindLogScroll({ querySelector: () => container });
  assert.equal(app._logAtBottom, false);
  container.onscroll();
  assert.equal(app.logAutoScroll, false);
  assert.equal(app._logAtBottom, false);
  app.logFullQuery = '';
  container.onscroll();
  assert.equal(app.logAutoScroll, true);
});
