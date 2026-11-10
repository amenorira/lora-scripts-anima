const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');

function fixture(totalSteps = 0) {
  let init, create, nextFrame = 0;
  const frames = new Map();
  loadFrontend('shared/preview-chart', {
    window: {},
    document: { addEventListener(name, callback) { init = callback; } },
    Alpine: { data(name, factory) { assert.equal(name, 'previewChart'); create = factory; } },
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
  });
  init();

  let active;
  const content = {
    firstElementChild: null,
    querySelector: selector => selector === '[data-chart-plot]' ? active.plot : active.readout,
    querySelectorAll: () => [active.value],
  };
  const rebuild = () => {
    content.firstElementChild = {};
    const line = { style: { display: 'none' } };
    const classes = new Set();
    const readout = { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
    const value = {
      text: '', writes: 0,
      get textContent() { return this.text; },
      set textContent(text) { this.text = text; this.writes += 1; },
    };
    const plot = {
      reads: 0,
      querySelector: () => line,
      getBoundingClientRect() {
        this.reads += 1;
        return { left: 10, right: 110, top: 20, bottom: 70, width: 100 };
      },
    };
    active = { line, classes, readout, value, plot };
    return active;
  };
  const chart = create((data, progress) => data.fixed ? null : [progress.toFixed(2)]);
  chart.$el = { firstElementChild: content };
  chart.init();
  const nodes = rebuild();
  chart.setChartData({}, totalSteps);
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback());
  };
  const move = (clientX, clientY = 40) => chart.moveChart({ clientX, clientY });
  const key = key => chart.keyChart({ key, preventDefault() {} });
  return { chart, nodes, frames, flush, move, key, rebuild };
}

test('chart inspection uses the latest pointer coordinates and avoids unchanged readout writes', () => {
  const { nodes, frames, move, flush } = fixture();
  move(20);
  move(35);
  assert.equal(frames.size, 1);
  assert.equal(nodes.plot.reads, 0);
  flush();
  assert.equal(nodes.plot.reads, 1);
  assert.equal(nodes.line.style.left, '25%');
  assert.equal(nodes.value.textContent, '0.25');
  assert.equal(nodes.classes.has('is-visible'), true);
  move(35);
  flush();
  assert.equal(nodes.value.writes, 1);
  move(35, 80);
  flush();
  assert.equal(nodes.line.style.display, 'none');
  assert.equal(nodes.classes.has('is-visible'), false);
});

test('keyboard inspection is immediate, snaps to steps and supersedes pending pointer work', () => {
  const { nodes, move, key, flush } = fixture(5);
  move(110);
  key('ArrowRight');
  assert.equal(nodes.line.style.left, '20%');
  assert.equal(nodes.plot.reads, 0);
  flush();
  assert.equal(nodes.line.style.left, '20%');
  key('End');
  assert.equal(nodes.line.style.left, '100%');
  key('Home');
  assert.equal(nodes.line.style.left, '0%');
});

test('leaving, replacing chart markup or changing data discards queued pointer inspection', () => {
  const { chart, nodes, frames, move, rebuild, flush } = fixture();
  move(30);
  chart.leaveChart();
  assert.equal(frames.size, 0);
  move(50);
  const next = rebuild();
  flush();
  assert.equal(nodes.plot.reads, 0);
  assert.equal(next.plot.reads, 0);
  move(70);
  chart.setChartData({ fixed: true });
  assert.equal(frames.size, 0);
  move(90);
  flush();
  assert.equal(next.line.style.display, 'none');
});
