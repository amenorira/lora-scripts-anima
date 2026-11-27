const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend, loadFrontend, composeMixins, createMemoryStorage, response, readRepo } = require('./helpers.cjs');

global.localStorage = createMemoryStorage();
const zhDict = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));

global.requestAnimationFrame = () => 0;
global.document = {
  hidden: false,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.window = {};
loadGlobalFrontend(['training/timestep-model', 'shared/utils', 'monitor/logs', 'monitor/core', 'monitor/render']);

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    _set: set,
    add: (...cs) => cs.forEach(c => String(c).split(/\s+/).filter(Boolean).forEach(cls => set.add(cls))),
    remove: (...cs) => cs.forEach(c => String(c).split(/\s+/).filter(Boolean).forEach(cls => set.delete(cls))),
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : Boolean(force);
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    contains: c => set.has(c),
  };
}

function makeEl(tag = 'div', attrs = {}) {
  const listeners = new Map();
  const classList = makeClassList(attrs.class ? String(attrs.class).split(/\s+/) : []);
  const dataset = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('data-')) {
      dataset[k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = String(v);
    }
  }
  const el = {
    tagName: tag,
    tag,
    nodeType: 1,
    isConnected: true,
    hidden: false,
    attrs: { ...attrs },
    style: {},
    dataset,
    children: [],
    parentNode: null,
    clientWidth: 420,
    clientHeight: 220,
    offsetWidth: 244,
    offsetHeight: 256,
    _html: '',
    _text: '',
    _parsed: [],
    classList,
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'class') {
        classList._set.clear();
        String(v).split(/\s+/).filter(Boolean).forEach(c => classList._set.add(c));
      }
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = String(v);
      }
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : undefined; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      child.parentNode = null;
    },
    remove() {
      this.removed = true;
      this.parentNode?.removeChild?.(this);
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners.has(type)) return;
      listeners.set(type, listeners.get(type).filter(f => f !== fn));
    },
    emit(type, ev = {}) {
      for (const fn of (listeners.get(type) || [])) fn(ev);
    },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight, width: el.clientWidth, height: el.clientHeight }; },
    querySelector(sel) {
      if (sel === 'text') return this.children.find(c => c.tagName === 'text') || null;
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean);
      const matchesOne = (node, s) => {
        if (s === 'rect') return node.tagName === 'rect';
        if (s.startsWith('.')) return node.classList.contains(s.slice(1));
        const exact = /^\[([^=\]]+)="([^"]+)"\]$/.exec(s);
        if (exact) return node.getAttribute(exact[1]) === exact[2];
        const pres = /^\[([^=\]]+)\]$/.exec(s);
        if (pres) return node.getAttribute(pres[1]) !== undefined;
        return false;
      };
      const out = [];
      const walk = list => {
        for (const c of list) {
          if (parts.some(p => matchesOne(c, p))) out.push(c);
          if (c.children?.length) walk(c.children);
        }
      };
      walk(this.children);
      walk(this._parsed);
      return out;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(val) {
      el._html = String(val);
      el.children.length = 0;
      el._parsed = [];
      const tagRe = /<(circle|g|line|rect|path|text|button|div|span)\b([^>]*)>/g;
      let m;
      while ((m = tagRe.exec(el._html)) !== null) {
        const node = makeEl(m[1]);
        const attrRe = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
        let am;
        while ((am = attrRe.exec(m[2])) !== null) {
          if (am[1]) node.setAttribute(am[1], am[2] ?? '');
        }
        el._parsed.push(node);
        if (el.tagName === 'g' && (el.attrs['data-dd-grid-lines'] !== undefined || el.attrs['data-dd-ag'] !== undefined || m[1] === 'line')) {
          el.children.push(node);
        }
      }
    },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; },
    set(val) { el._text = String(val); },
  });
  return el;
}

function makeWrapStage(mode = 'quadrant', stageW = 680, stageH = 0) {
  const resetBtn = { hidden: true, closest: () => null };
  const svg = makeEl('svg');
  svg.clientWidth = stageW;
  const stage = makeEl('div');
  stage.clientWidth = stageW;
  stage.clientHeight = stageH || 0;
  const wrap = makeEl('div');
  wrap.dataset = { mode };
  wrap.querySelector = sel => (
    sel === '[data-dd-zoom-reset]' ? resetBtn
      : sel === '[data-dd-hero-stage]' ? stage
        : sel === '[data-dd-hero-svg]' ? svg
          : null
  );
  return { wrap, stage, svg, resetBtn };
}

function withMockEnv(env, fn) {
  const prev = {
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    performance: global.performance,
    fetch: global.fetch,
    innerWidth: global.window.innerWidth,
    innerHeight: global.window.innerHeight,
  };
  const restore = () => {
    global.document = prev.document;
    global.requestAnimationFrame = prev.requestAnimationFrame;
    global.cancelAnimationFrame = prev.cancelAnimationFrame;
    global.setTimeout = prev.setTimeout;
    global.clearTimeout = prev.clearTimeout;
    global.performance = prev.performance;
    global.fetch = prev.fetch;
    global.window.innerWidth = prev.innerWidth;
    global.window.innerHeight = prev.innerHeight;
  };
  if ('document' in env) global.document = env.document;
  if ('requestAnimationFrame' in env) global.requestAnimationFrame = env.requestAnimationFrame;
  if ('cancelAnimationFrame' in env) global.cancelAnimationFrame = env.cancelAnimationFrame;
  if ('setTimeout' in env) global.setTimeout = env.setTimeout;
  if ('clearTimeout' in env) global.clearTimeout = env.clearTimeout;
  if ('performance' in env) global.performance = env.performance;
  if ('fetch' in env) global.fetch = env.fetch;
  if ('innerWidth' in env) global.window.innerWidth = env.innerWidth;
  if ('innerHeight' in env) global.window.innerHeight = env.innerHeight;
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        res => { restore(); return res; },
        err => { restore(); throw err; },
      );
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function makeApp(overrides = {}) {
  const base = composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin);
  return Object.assign(base, {
    currentRoute: 'monitor-dashboard',
    monitorTab: 'overview',
    selectedRunDir: 'output/demo',
    liveTaskId: '',
    locale: 'zh-CN',
    localeRevision: 0,
    logTotal: 0,
    previews: [],
    t(key) { return key.split('.').reduce((v, part) => v?.[part], zhDict) ?? key; },
    escapeJsString(s) { return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); },
    toast() {},
    navigate() {},
    renderDashboard() {},
    _patchDatasetDiagModal() {},
    _syncDatasetDiagImageStyle() {},
  }, overrides);
}

const SAMPLE_DATA = {
  available: true,
  profile: 'anima-lora',
  run_id: 'r1',
  available_runs: ['r0', 'r1'],
  timestep_scale: 'unit',
  thresholds: { high_residual: 0.2, low_residual: -0.2, converging_slope: -0.02, min_count: 3, num_bins: 10 },
  summary: {
    samples: 30, non_finite_total: 1, images_total: 4, images_qualified: 4, images_skipped: 0,
    step_from: 1, step_to: 30, epoch_from: 1, epoch_to: 5, mean_loss: 0.24,
    has_slope: true, has_reg_images: true, multi_gpu_partial: false, num_processes: 1,
    counts: { attention: 1, learning: 1, easy: 1, normal: 0, non_finite: 1, insufficient: 0 },
  },
  noise_zones: {
    high: { count: 12, share: 0.4, mean_loss: 0.36, mean_residual: 0.12 },
    mid: { count: 9, share: 0.3, mean_loss: 0.22, mean_residual: 0.01 },
    low: { count: 9, share: 0.3, mean_loss: 0.12, mean_residual: -0.08 },
  },
  by_timestep: [
    { bin: 0, timestep_from: 0.0, timestep_to: 0.5, count: 15, comparable_count: 15, mean_loss: 0.14 },
    { bin: 1, timestep_from: 0.5, timestep_to: 1.0, count: 15, comparable_count: 15, mean_loss: 0.34 },
  ],
  by_resolution: [
    { key: '768x1024', label: '768x1024', count: 15, comparable_count: 15, images: 2, mean_loss: 0.28, mean_residual: 0.28 },
    { key: '1024x1024', label: '1024x1024', count: 15, comparable_count: 15, images: 2, mean_loss: 0.18, mean_residual: -0.25 },
  ],
  by_batch_size: [{ key: '2', label: 'bs 2', count: 30, comparable_count: 30, images: 4, mean_loss: 0.24, mean_residual: 0.0 }],
  by_subset: [
    { key: '0-0', label: '10_char', is_reg: false, count: 22, comparable_count: 22, images: 3, mean_loss: 0.25, mean_residual: 0.08 },
    { key: '0-1', label: '1_reg', is_reg: true, count: 8, comparable_count: 8, images: 1, mean_loss: 0.19, mean_residual: -0.18 },
  ],
  by_directory: [
    { key: 'D:/ds/char', label: 'ds/char', full_path: 'D:/ds/char', count: 22, comparable_count: 22, images: 3, mean_loss: 0.25, mean_residual: 0.08 },
  ],
  by_image: [
    {
      image_id: 'aaaaaaaaaaaaaaaa', image: 'D:/ds/char/bad.png', name: 'bad.png',
      directory: 'D:/ds/char', dir_label: 'ds/char', resolution: '768x1024', subset: '0-0', subset_label: '10_char',
      is_reg: false, count: 8, comparable_count: 8, non_finite_count: 0, epochs: 4, mean_loss: 0.32, mean_residual: 0.42, slope: 0.03,
      noise_zones: { high: { count: 4, comparable_count: 4, mean_residual: 0.52 }, mid: { count: 2, comparable_count: 2, mean_residual: 0.35 }, low: { count: 2, comparable_count: 2, mean_residual: 0.20 } },
      status: 'attention', thumb_url: '/api/image-preview?path=aaaaaaaaaaaaaaaa', preview_url: '',
    },
    {
      image_id: 'bbbbbbbbbbbbbbbb', image: 'D:/ds/char/learn.png', name: 'learn.png',
      directory: 'D:/ds/char', dir_label: 'ds/char', resolution: '768x1024', subset: '0-0', subset_label: '10_char',
      is_reg: false, count: 8, comparable_count: 8, non_finite_count: 0, epochs: 4, mean_loss: 0.29, mean_residual: 0.25, slope: -0.06,
      noise_zones: { high: { count: 3, comparable_count: 3, mean_residual: 0.28 }, mid: { count: 3, comparable_count: 3, mean_residual: 0.24 }, low: { count: 2, comparable_count: 2, mean_residual: 0.21 } },
      status: 'learning', thumb_url: '', preview_url: '',
    },
    {
      image_id: 'cccccccccccccccc', image: 'D:/ds/char/nan.png', name: 'nan.png',
      directory: 'D:/ds/char', dir_label: 'ds/char', resolution: '1024x1024', subset: '0-0', subset_label: '10_char',
      is_reg: false, count: 6, comparable_count: 6, non_finite_count: 1, epochs: 3, mean_loss: 0.21, mean_residual: 0.05, slope: -0.01,
      noise_zones: { high: { count: 2, comparable_count: 2, mean_residual: 0.08 }, mid: { count: 2, comparable_count: 2, mean_residual: 0.05 }, low: { count: 2, comparable_count: 2, mean_residual: 0.02 } },
      status: 'non_finite', thumb_url: '', preview_url: '',
    },
    {
      image_id: 'dddddddddddddddd', image: 'D:/ds/reg/reg1.png', name: 'reg1.png',
      directory: 'D:/ds/reg', dir_label: 'ds/reg', resolution: '1024x1024', subset: '0-1', subset_label: '1_reg',
      is_reg: true, count: 8, comparable_count: 8, non_finite_count: 0, epochs: 4, mean_loss: 0.14, mean_residual: -0.32, slope: -0.02,
      noise_zones: { high: { count: 3, comparable_count: 3, mean_residual: -0.30 }, mid: { count: 3, comparable_count: 3, mean_residual: -0.34 }, low: { count: 2, comparable_count: 2, mean_residual: -0.31 } },
      status: 'easy', thumb_url: '', preview_url: '',
    },
  ],
};

test('monitor tab cycling includes dataset tab at the end', () => {
  const a = makeApp({ monitorTab: 'outputs' });
  a.moveMonitorTab(1);
  assert.equal(a.monitorTab, 'dataset');
  a.moveMonitorTab(1);
  assert.equal(a.monitorTab, 'overview');
  a.moveMonitorTab(-1);
  assert.equal(a.monitorTab, 'dataset');
});

test('detail polling preserves chart nodes across unrelated revisions and repaints changed geometry with identical KPI text', () => {
  const image = SAMPLE_DATA.by_image[0];
  const detail = { image, revision: 'a', epoch_series: [{ epoch: 1, mean_residual: 0.2 }, { epoch: 2, mean_residual: 0.1 }] };
  const right = makeEl();
  const modal = makeEl();
  const bindings = [];
  const app = makeApp({
    selectedRunDir: '',
    _monitorMotionAllowed: () => true,
    datasetDiagData: SAMPLE_DATA,
    datasetDiagModalImageId: image.image_id,
    datasetDiagModalDetail: detail,
    _patchDatasetDiagModal: window.datasetDiagnosticsModalMixin._patchDatasetDiagModal,
    _bindDatasetDiagModalCharts(_right, _detail, _t, opts) { bindings.push(opts.animate); },
  });
  withMockEnv({ document: {
    getElementById(id) { return ({ datasetDiagModalRight: right, datasetDiagModal: modal })[id] || null; },
  } }, () => {
    app._patchDatasetDiagModal();
    const stage = right.querySelector('[data-dd-epoch-stage]');
    assert.ok(stage);
    app.datasetDiagModalDetail = { ...detail, revision: 'b' };
    app._patchDatasetDiagModal();
    assert.deepEqual(bindings, [false]);
    assert.equal(right.querySelector('[data-dd-epoch-stage]'), stage);
    app.datasetDiagModalDetail = { ...detail, epoch_series: [{ epoch: 1, mean_residual: 0.3 }, detail.epoch_series[1]] };
    app._patchDatasetDiagModal();
    assert.deepEqual(bindings, [false, true]);
    assert.equal(right.querySelector('[data-dd-epoch-stage]'), stage);
    app._monitorMotionAllowed = () => false;
    app.datasetDiagModalDetail = detail;
    app._patchDatasetDiagModal();
    assert.deepEqual(bindings, [false, true, false]);
  });
});

test('uncached image navigation keeps the previous layout and scroll offset until the next detail is ready', () => {
  const [first, next] = SAMPLE_DATA.by_image;
  const right = makeEl(), modal = makeEl(), foot = makeEl();
  const app = makeApp({
    datasetDiagData: SAMPLE_DATA, datasetDiagModalImageId: first.image_id,
    datasetDiagModalDetail: { image: first }, selectedRunDir: 'output/example',
    _patchDatasetDiagModal: window.datasetDiagnosticsModalMixin._patchDatasetDiagModal,
    _bindDatasetDiagModalCharts() {},
  });
  withMockEnv({document: {getElementById: id => ({
    datasetDiagModal: modal, datasetDiagModalRight: right, datasetDiagModalFoot: foot,
  })[id] || null}}, () => {
    app._patchDatasetDiagModal();
    const previous = right.innerHTML;
    right.scrollTop = 42;
    app.datasetDiagModalImageId = next.image_id;
    app.datasetDiagModalDetail = null;
    app.datasetDiagModalLoading = true;
    app._patchDatasetDiagModal();
    assert.equal(right.innerHTML, previous);
    assert.ok(right.inert && foot.inert);
    app.datasetDiagModalDetail = { image: next };
    app.datasetDiagModalLoading = false;
    app._patchDatasetDiagModal();
    assert.equal(right._ddRenderedImageId, next.image_id);
    assert.equal(right.inert, false);
    assert.equal(foot.inert, false);
    assert.equal(right.scrollTop, 42);
  });
});

test('dashboard overview, images view, smart groups deduplication, folding, filtering, and sorting', async () => {
  const seenUrls = [];
  await withMockEnv({
    fetch: async url => {
      seenUrls.push(String(url));
      if (String(url).includes('/api/monitor/dataset-diagnostics?')) return response(SAMPLE_DATA);
      throw new Error('Unexpected fetch: ' + url);
    },
  }, async () => {
    const a = makeApp();
    await a.loadDatasetDiagnostics();
    assert.equal(a.datasetDiagSubTab, 'overview');
    assert.equal(a.datasetDiagPreset, 'all');
    assert.equal(a.datasetDiagRegMode, 'exclude');
    assert.equal(a._datasetDiagHasActiveFilter(), false);
    assert.deepEqual(a._ddRegOptions().map(o => o.value), ['exclude', 'only', 'all']);
    assert.equal(a._datasetDiagFilteredImages().length, 3);
    assert.equal(a._datasetDiagFilteredImages({ ignoreReg: true }).length, 4);

    a.openDatasetDiagPreset('non_finite');
    assert.equal(a.datasetDiagSubTab, 'images');
    assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['nan.png']);

    const runOpts = a._ddRunOptions();
    assert.equal(runOpts[0].value, 'all');
    assert.equal(runOpts.length, 3);

    a.setDatasetDiagPreset('attention');
    assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['bad.png']);

    const withNormal = structuredClone(SAMPLE_DATA);
    withNormal.by_image.push({
      image_id: 'eeeeeeeeeeeeeeee', image: 'D:/ds/char/ok.png', name: 'ok.png',
      directory: 'D:/ds/char', dir_label: 'ds/char', resolution: '1024x1024', subset: '0-0', subset_label: '10_char',
      is_reg: false, count: 6, comparable_count: 6, non_finite_count: 0, epochs: 4, mean_loss: 0.24, mean_residual: 0.02, slope: -0.01,
      status: 'normal', thumb_url: '', preview_url: '',
    });
    const normApp = makeApp({ datasetDiagData: withNormal });
    normApp.setDatasetDiagPreset('normal');
    assert.deepEqual(normApp._datasetDiagFilteredImages().map(i => i.name), ['ok.png']);
    const bd = normApp._ddStatusBreakdown(withNormal);
    assert.equal(bd.total, 5);
    assert.equal(
      bd.counts.non_finite + bd.counts.attention + bd.counts.learning + bd.counts.normal + bd.counts.easy + bd.counts.unqualified,
      5,
    );

    a.setDatasetDiagPreset('easy');
    assert.deepEqual(a._datasetDiagFilteredImages(), []);
    a.setDatasetDiagRegMode('all');
    assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['reg1.png']);

    a.setDatasetDiagPreset('all');
    a.toggleDatasetDiagGroupFilter('resolution', '768x1024', '768 × 1024');
    assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['bad.png', 'learn.png']);

    a.clearDatasetDiagGroupFilter();
    a.setDatasetDiagRegMode('only');
    assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['reg1.png']);

    a.setDatasetDiagRegMode('all');
    a.setDatasetDiagSearch('learn');
    assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['learn.png']);

    a.resetDatasetDiagFilters();
    assert.equal(a.datasetDiagRegMode, 'all');
    a.setDatasetDiagSort('slope_asc');
    assert.equal(a._datasetDiagFilteredImages()[0].name, 'learn.png');

    // Overview shell & inline notices
    a.setDatasetDiagSubTab('overview');
    const overviewHtml = a._renderDatasetDiagTab(k => a.tMonitor(k));
    assert.ok(overviewHtml.includes('id="ddViewTabOverview"'));
    assert.ok(overviewHtml.includes('id="ddViewTabImages"'));
    assert.ok(overviewHtml.includes('id="ddInfoBtn"') && overviewHtml.includes("openParameterDoc('dataset-diagnostics')"));
    assert.ok(overviewHtml.includes('data-dd-unknown-ts-note hidden'));

    const inlineHintsData = structuredClone(SAMPLE_DATA);
    inlineHintsData.summary.multi_gpu_partial = true;
    inlineHintsData.summary.unknown_timestep_count = 4;
    inlineHintsData.summary.has_slope = false;
    a.datasetDiagData = inlineHintsData;
    const inlineHtml = a._renderDatasetDiagTab(k => a.tMonitor(k));
    assert.ok(inlineHtml.includes(`data-dd-multi-gpu-note>${a.tMonitor('ddMultiGpuNotice')}</span>`));
    assert.ok(inlineHtml.includes('data-dd-unknown-ts-note><span data-dd-unknown-ts-text>'));
    assert.ok(inlineHtml.includes('data-dd-early-slope-note>'));
    a.datasetDiagData = SAMPLE_DATA;

    // Live indicator pill states
    const liveApp = makeApp({
      datasetDiagData: SAMPLE_DATA, selectedRunDir: '', liveTaskId: 'task-1', controlTask: 'task-1',
      monitorData: { state: 'RUNNING' }, controlState: { state: 'running' },
    });
    assert.ok(liveApp._renderDatasetDiagHeading(k => liveApp.tMonitor(k), SAMPLE_DATA).includes('data-dd-live-state data-phase="running"'));
    liveApp.controlState = { state: 'paused' };
    assert.ok(liveApp._renderDatasetDiagHeading(k => liveApp.tMonitor(k), SAMPLE_DATA).includes('data-phase="paused"'));

    // Active filter pill on overview
    a.setDatasetDiagPreset('attention');
    const filteredOverviewHtml = a._renderDatasetDiagTab(k => a.tMonitor(k));
    assert.ok(filteredOverviewHtml.includes('openDatasetDiagFilteredImages()'));
    assert.ok(filteredOverviewHtml.includes('resetDatasetDiagFilters()'));
    a.setDatasetDiagPreset('all');

    // Images view (grid + sortable table)
    a.setDatasetDiagSubTab('images');
    const imagesHtml = a._renderDatasetDiagTab(k => a.tMonitor(k));
    assert.ok(imagesHtml.includes('id="datasetDiagImagesSection"'));
    assert.ok(imagesHtml.includes('bad.png') && imagesHtml.includes('768 × 1024'));
    a.setDatasetDiagViewMode('table');
    const tableHtml = a._renderDatasetDiagTab(k => a.tMonitor(k));
    assert.equal((tableHtml.match(/class="output-table-sort m-dd-th-sort/g) || []).length, 5);
    a.setDatasetDiagViewMode('grid');

    // Residual color thresholds & gauge width scaling
    assert.match(a._ddResidualColor(0.25), /^color-mix\(/);
    assert.equal(a._ddResidualColor(0.0, { kind: 'graphic' }), 'var(--text-tertiary)');
    assert.ok(a._ddResidualColor(0.15, { scale: 'group' }).includes('var(--danger)'));
    assert.ok(a._ddResidualColor(0.15).includes('var(--warning)') && !a._ddResidualColor(0.15).includes('var(--danger)'));
    const grpGauge = a._ddGaugeMetrics(0.026, 0.20, { scale: 'group' });
    const imgGauge = a._ddGaugeMetrics(0.026, 0.45);
    assert.ok(grpGauge.width > imgGauge.width * 1.8);

    // Smart groups: deduplicate directory ONLY on true 1-to-1 bijection over by_image
    const smartGroupsData = structuredClone(SAMPLE_DATA);
    smartGroupsData.summary = { ...smartGroupsData.summary, bucket_ar_error: 0.068 };
    smartGroupsData.by_directory = [
      { key: 'D:/ds/char', label: 'ds/char', full_path: 'D:/ds/char', count: 22, comparable_count: 22, images: 3, mean_loss: 0.25, mean_residual: 0.08, attention_count: 1, non_finite_count: 0, slope: -0.025 },
      { key: 'D:/ds/reg', label: 'ds/reg', full_path: 'D:/ds/reg', count: 8, comparable_count: 8, images: 1, mean_loss: 0.19, mean_residual: -0.18, attention_count: 0, non_finite_count: 0, slope: 0.012 },
    ];
    smartGroupsData.by_batch_size = [
      { key: '2', label: 'bs 2', count: 24, comparable_count: 12, images: 3, mean_loss: 0.23, mean_residual: -0.02 },
      { key: '1', label: 'bs 1', count: 6, comparable_count: 6, images: 1, mean_loss: 0.30, mean_residual: 0.14 },
    ];
    smartGroupsData.by_subset[0] = {
      ...smartGroupsData.by_subset[0],
      comparable_count: 22, expected_images: 10, num_repeats: 2, loss_weight: 0.5,
      attention_count: 2, non_finite_count: 0, slope: -0.025, aug_flags: ['flip_aug'],
    };
    const dedupedGroupsHtml = a._renderDatasetDiagGroupsCard(k => a.tMonitor(k), smartGroupsData);
    assert.ok(!dedupedGroupsHtml.includes('data-dd-group-dim="directory"'));
    assert.ok(dedupedGroupsHtml.includes('data-dd-group-dim="batch_size"'));
    const batchSection = dedupedGroupsHtml.slice(dedupedGroupsHtml.indexOf('data-dd-group-dim="batch_size"'));
    assert.ok(!batchSection.includes('is-clickable'), 'Batch rows stay non-clickable');
    assert.ok(dedupedGroupsHtml.includes('-2.5%/ep'));
    assert.ok(dedupedGroupsHtml.includes('6.8%'));
    assert.ok(dedupedGroupsHtml.includes('0.2500'));

    // Stats collision WITHOUT matching image membership must NOT hide directory
    const statsCollisionData = structuredClone(SAMPLE_DATA);
    statsCollisionData.by_directory = SAMPLE_DATA.by_subset.map((r, i) => ({
      key: `D:/ds/other_${i}`, label: `other_${i}`, count: r.count, comparable_count: r.count, images: r.images, mean_loss: r.mean_loss, mean_residual: r.mean_residual,
    }));
    assert.ok(a._renderDatasetDiagGroupsCard(k => a.tMonitor(k), statsCollisionData).includes('data-dd-group-dim="directory"'));

    // Dimensions with >5 items fold excess items inside data-dd-group-fold
    smartGroupsData.by_subset = Array.from({ length: 7 }, (_, i) => ({
      key: `0-${i}`, label: `sub_${i}`, count: 5, comparable_count: 5, images: 2, mean_loss: 0.25, mean_residual: (i === 6 ? 0.65 : (i - 3) * 0.04),
    }));
    const fullGroupsHtml = a._renderDatasetDiagGroupsCard(k => a.tMonitor(k), smartGroupsData);
    assert.ok(fullGroupsHtml.includes('data-dd-group-fold="subset"'));

    // Resolution order vs residual sort toggle
    smartGroupsData.by_resolution = [
      { key: '192x256', label: '192x256', count: 5, comparable_count: 5, images: 2, mean_loss: 0.24, mean_residual: 0.01 },
      { key: '224x224', label: '224x224', count: 5, comparable_count: 5, images: 2, mean_loss: 0.24, mean_residual: 0.45 },
      { key: '256x192', label: '256x192', count: 5, comparable_count: 5, images: 2, mean_loss: 0.24, mean_residual: 0.05 },
      { key: '320x320', label: '320x320', count: 5, comparable_count: 5, images: 2, mean_loss: 0.24, mean_residual: -0.05 },
    ];
    a.datasetDiagResoSort = 'residual';
    const sortedResoHtml = a._renderDatasetDiagGroupsCard(k => a.tMonitor(k), smartGroupsData);
    assert.ok(sortedResoHtml.indexOf('data-dd-group-row-key="resolution::224x224"') < sortedResoHtml.indexOf('data-dd-group-row-key="resolution::192x256"'));
    a.datasetDiagResoSort = 'order';

    // Hovering batch_size overlays noise comparison
    assert.equal(a._ddResolveActiveNoiseComparison(smartGroupsData, null), null);
    a._datasetDiagHoverPreview = { kind: 'group', dim: 'batch_size', key: '2' };
    assert.equal(a._ddResolveActiveNoiseComparison(smartGroupsData, null).dim, 'batch_size');
    a._datasetDiagHoverPreview = null;

    // Omit group comparison when no dimension has >= 2 groups
    const singleGroup = structuredClone(SAMPLE_DATA);
    singleGroup.by_resolution = [SAMPLE_DATA.by_resolution[0]];
    singleGroup.by_subset = [SAMPLE_DATA.by_subset[0]];
    singleGroup.by_directory = [SAMPLE_DATA.by_directory[0]];
    assert.equal(a._renderDatasetDiagGroupsCard(k => a.tMonitor(k), singleGroup), '');

    // Switching run_id forwards run_id parameter
    await a.setDatasetDiagRunId('all');
    assert.ok(seenUrls.some(u => u.includes('run_id=all')));
    await a.setDatasetDiagRunId('r0');
    assert.ok(seenUrls.some(u => u.includes('run_id=r0')));
  });
});

test('group residual gauge uses the same zero origin in both directions', () => {
  const app = makeApp();
  assert.equal(app._ddGroupGaugeMetrics(-0.04, 0.12).barScale, -app._ddGroupGaugeMetrics(0.04, 0.12).barScale);
  assert.equal(app._ddGroupGaugeMetrics(null).barScale, 0);
});

test('status cards, scope pill/popover, and group dim collapse patch cleanly in-place', () => {
  const mkData = images => ({
    ...structuredClone(SAMPLE_DATA),
    summary: { ...SAMPLE_DATA.summary, images_total: images.length, has_reg_images: images.some(i => i.is_reg) },
    by_image: images,
  });

  // 1. Uniform repeats & no reg -> showTrainShare false; skewed repeats + reg -> showTrainShare true
  const uniformData = mkData([
    { image_id: 'u1', is_reg: false, count: 10, comparable_count: 10, non_finite_count: 0, mean_residual: 0.482, slope: 0.02, status: 'attention' },
    { image_id: 'u2', is_reg: false, count: 10, comparable_count: 10, non_finite_count: 0, mean_residual: -0.012, slope: 0.0, status: 'normal' },
    { image_id: 'u3', is_reg: false, count: 10, comparable_count: 10, non_finite_count: 0, mean_residual: -0.34, slope: -0.01, status: 'easy' },
  ]);
  const app = makeApp({ datasetDiagData: uniformData });
  assert.equal(app._ddStatusBreakdown(uniformData).showTrainShare, false);

  const skewedData = mkData([
    { image_id: 's1', is_reg: false, count: 5, comparable_count: 5, non_finite_count: 14, mean_residual: 0.1, slope: -0.05, status: 'non_finite' },
    { image_id: 's2', is_reg: true, count: 40, comparable_count: 40, non_finite_count: 0, mean_residual: 0.524, slope: 0.01, status: 'attention' },
    { image_id: 's3', is_reg: false, count: 16, comparable_count: 16, non_finite_count: 0, mean_residual: 0.382, slope: -0.13, status: 'learning' },
    { image_id: 's4', is_reg: false, count: 20, comparable_count: 20, non_finite_count: 0, mean_residual: 0.008, slope: 0.0, status: 'normal' },
    { image_id: 's5', is_reg: false, count: 5, comparable_count: 5, non_finite_count: 0, mean_residual: -0.31, slope: -0.02, status: 'easy' },
  ]);
  const bdSkewed = app._ddStatusBreakdown(skewedData);
  assert.equal(bdSkewed.showTrainShare, true);
  assert.equal(bdSkewed.buckets.non_finite.nanCount, 14);
  assert.equal(bdSkewed.buckets.attention.regCount, 1);
  assert.equal(bdSkewed.buckets.attention.trainPct, 40);

  // 2. Scope summary math (coverage + min_count + NaN) and in-place dashboard patch
  const partialData = {
    ...structuredClone(SAMPLE_DATA),
    thresholds: { ...SAMPLE_DATA.thresholds, min_count: 5 },
    summary: {
      ...SAMPLE_DATA.summary, samples: 112, non_finite_total: 6, images_total: 26, images_expected: 30,
      images_qualified: 22, images_skipped: 4, epoch_from: 1, epoch_to: 3, step_from: 1, step_to: 112, mean_loss: 0.3812,
      counts: { attention: 4, learning: 0, easy: 4, normal: 12, non_finite: 2, insufficient: 4 },
    },
  };
  const scopeInfo = app._ddScopeSummaryInfo(k => app.tMonitor(k), partialData);
  assert.equal(scopeInfo.pillCells.find(c => c.key === 'mean_loss').val, '0.3812');
  assert.equal(scopeInfo.pillCells.some(c => c.key === 'nan' && c.danger), true);
  assert.ok(scopeInfo.rows.find(r => r.key === 'images').main.includes('26 / 30'));

  const pillEl = { innerHTML: '' };
  const popEl = { innerHTML: '' };
  const filterHintEl = { textContent: '' };
  const filterJumpEl = { textContent: '' };
  const filterResetEl = { textContent: '' };
  const existingPillEl = {
    querySelector: sel => ({
      '[data-dd-filter-hint]': filterHintEl,
      '[data-dd-filter-jump]': filterJumpEl,
      '[data-dd-filter-reset]': filterResetEl,
    })[sel] || null,
  };
  let filterSlotRewrites = 0;
  let filterSlotInner = '';
  const filterSlotEl = {
    get innerHTML() { return filterSlotInner; },
    set innerHTML(val) { filterSlotInner = val; filterSlotRewrites += 1; },
    querySelector: sel => (sel === '.m-dd-scatter-filter-pill' && filterSlotInner ? existingPillEl : null),
  };
  const verdictEl = {
    dataset: {},
    querySelector: sel => ({
      '[data-dd-verdict-title]': { textContent: '' },
      '[data-dd-verdict-desc]': { textContent: '' },
      '[data-dd-scope-pill]': pillEl,
      '[data-dd-scope-pop]': popEl,
      '[data-dd-scatter-filter-slot]': filterSlotEl,
    })[sel] || null,
  };
  const slot = { querySelector: sel => (sel === '.m-dd-dash-verdict' ? verdictEl : null), querySelectorAll: () => [] };
  app.datasetDiagData = partialData;
  app.datasetDiagPreset = 'attention';
  app._patchDatasetDiagDashboard(slot, k => app.tMonitor(k), partialData, false);
  assert.ok(pillEl.innerHTML.includes('0.3812'));
  assert.equal(filterSlotRewrites, 1);

  // Switching between active filters updates pill text in-place without recreating DOM
  app.datasetDiagPreset = 'all';
  app.datasetDiagGroupFilter = { dim: 'subset', key: '0-0', label: '10_char' };
  app._patchDatasetDiagDashboard(slot, k => app.tMonitor(k), partialData, false);
  assert.equal(filterSlotRewrites, 1);
  assert.ok(filterHintEl.textContent.includes('3/26'));

  // Clearing filter removes the pill cleanly
  app.datasetDiagGroupFilter = null;
  app._patchDatasetDiagDashboard(slot, k => app.tMonitor(k), partialData, false);
  assert.equal(filterSlotRewrites, 2);
  assert.equal(filterSlotInner, '');

  // 3. toggleDatasetDiagGroupDim patches in-place without full re-render
  let dimRenders = 0;
  const dimBodyEl = { inert: false };
  const dimToggleEl = makeEl('button');
  const dimBlockEl = makeEl('div');
  dimBlockEl.querySelector = sel => (sel === '[data-dd-group-dim-toggle]' ? dimToggleEl : sel === '[data-dd-group-dim-body]' ? dimBodyEl : null);
  const dimPanel = { querySelector: sel => (sel === '[data-dd-group-dim="subset"]' ? dimBlockEl : null) };
  withMockEnv({ document: { querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? dimPanel : null) } }, () => {
    const dimApp = makeApp({ datasetDiagData: SAMPLE_DATA, renderDashboard() { dimRenders += 1; } });
    dimApp.toggleDatasetDiagGroupDim('subset');
    assert.equal(dimRenders, 0);
    assert.equal(dimBlockEl.classList.contains('is-collapsed'), true);
    assert.equal(dimToggleEl.getAttribute('aria-expanded'), 'false');
    assert.equal(dimBodyEl.inert, true);
    dimApp.toggleDatasetDiagGroupFilter('subset', '0-0', 'char');
    assert.equal(dimApp.datasetDiagCollapsedDims.subset, undefined);
  });
});

test('zone clicks select images by status when the same slope has different per-image thresholds', () => {
  const data = structuredClone(SAMPLE_DATA);
  data.thresholds.converging_slope = -0.10 / 19;
  const [late, full] = data.by_image;
  Object.assign(late, { slope: -0.01, converging_slope: -0.02 });
  Object.assign(full, { slope: -0.01, converging_slope: data.thresholds.converging_slope });
  const app = makeApp({ datasetDiagData: data, datasetDiagShowZones: true, datasetDiagPreset: 'all' });
  const { wrap, stage, svg } = makeWrapStage('quadrant', 680, 440);
  const panel = makeEl();
  panel.querySelectorAll = sel => sel === '[data-dd-hero-wrap]' ? [wrap] : [];
  withMockEnv({document: panel}, () => app._bindDatasetDiagCharts(panel));
  const chart = wrap._ddChartState;
  const attention = svg.querySelector('[data-dd-zone-preset="attention"]');
  const learning = svg.querySelector('[data-dd-zone-preset="learning"]');
  const attentionBottom = Number(attention.getAttribute('y')) + Number(attention.getAttribute('height'));
  const learningTop = Number(learning.getAttribute('y'));
  assert.ok(Math.abs(attentionBottom - chart.toY(full.converging_slope)) < 0.2);
  assert.ok(Math.abs(learningTop - chart.toY(late.converging_slope)) < 0.2);
  for (const dot of chart.coords.filter(dot => dot.image_id === late.image_id || dot.image_id === full.image_id)) {
    assert.ok(dot.cy > attentionBottom && dot.cy < learningTop);
  }

  const click = y => stage.emit('click', {clientX: chart.toX(0.35), clientY: y});
  const selected = () => app._datasetDiagFilteredImages().map(img => img.image_id);
  click(chart.toY(late.slope));
  assert.equal(app.datasetDiagPreset, 'all');
  click((chart.padT + attentionBottom) / 2);
  assert.deepEqual(selected(), [late.image_id]);
  click((learningTop + chart.padT + chart.plotH) / 2);
  assert.deepEqual(selected(), [full.image_id]);
  const modal = image => app._renderDatasetDiagModalRightHtml(key => app.t('monitor.' + key), { image });
  assert.doesNotMatch(modal(late), /m-dd-group-trend-pill is-good/);
  assert.match(modal(full), /m-dd-group-trend-pill is-good/);
});

test('quadrant scatter SVG, piecewise-log compression, auto-bounds soft-centering, zoom/pan, and zone shading', () => {
  const a = makeApp({ datasetDiagData: SAMPLE_DATA });
  const q = makeWrapStage('quadrant');
  a._renderDatasetDiagHeroSvg(q.wrap, q.stage, q.svg);
  assert.equal(Boolean(a.datasetDiagShowZones), false);
  assert.equal(q.svg.classList.contains('is-zones-on'), false);
  assert.equal(q.wrap._ddChartState.coords.length, 4);
  assert.equal(q.svg.attrs.height, '440');

  const qSmall = makeWrapStage('quadrant', 680, 200);
  a._renderDatasetDiagHeroSvg(qSmall.wrap, qSmall.stage, qSmall.svg);
  assert.equal(qSmall.svg.attrs.height, '196');

  const qLarge = makeWrapStage('quadrant', 680, 900);
  a._renderDatasetDiagHeroSvg(qLarge.wrap, qLarge.stage, qLarge.svg);
  assert.equal(qLarge.svg.attrs.height, '896');

  // Deep sub-1% zoom & clamp stay zoomed and toggle reset button
  a.setDatasetDiagScatterZoom({ xMin: 0.640, xMax: 0.646, yMin: 0.050, yMax: 0.053 });
  a._renderDatasetDiagHeroSvg(q.wrap, q.stage, q.svg);
  assert.equal(q.resetBtn.hidden, false);
  assert.ok(Math.abs(q.wrap._ddChartState.fromX(q.wrap._ddChartState.padL) - 0.640) < 1e-4);
  a.setDatasetDiagScatterZoom({ xMin: 0.642, xMax: 0.6422, yMin: 0.051, yMax: 0.0511 });
  assert.ok(a.datasetDiagScatterZoom.xMax - a.datasetDiagScatterZoom.xMin >= 0.001 - 1e-9);
  assert.ok(a.datasetDiagScatterZoom.yMax - a.datasetDiagScatterZoom.yMin >= 0.0005 - 1e-9);
  a.resetDatasetDiagScatterZoom();
  a._renderDatasetDiagHeroSvg(q.wrap, q.stage, q.svg);
  assert.equal(q.resetBtn.hidden, true);

  // Single-axis and dual-axis piecewise-log compression + status dot colors
  const xOnlyData = structuredClone(SAMPLE_DATA);
  xOnlyData.by_image.push({
    image_id: 'eeeeeeeeeeeeeeee', name: 'xonly.png', is_reg: false, count: 8, comparable_count: 8,
    mean_residual: 3.0, slope: 0.05, status: 'attention',
  });
  const xOnly = makeWrapStage('quadrant', 700, 440);
  makeApp({ datasetDiagData: xOnlyData })._renderDatasetDiagHeroSvg(xOnly.wrap, xOnly.stage, xOnly.svg);
  assert.ok(xOnly.wrap._ddCamera.symW_X === 1 && xOnly.wrap._ddCamera.symW_Y === 0);

  const dualData = structuredClone(SAMPLE_DATA);
  dualData.by_image.push({
    image_id: 'eeeeeeeeeeeeeeee', name: 'extreme.png', is_reg: false, count: 8, comparable_count: 8,
    mean_residual: 3.0, slope: -0.5, status: 'learning',
  });
  const dual = makeWrapStage('quadrant', 700, 440);
  makeApp({ datasetDiagData: dualData })._renderDatasetDiagHeroSvg(dual.wrap, dual.stage, dual.svg);
  const st = dual.wrap._ddChartState;
  assert.ok(Math.abs(st.fromX(st.coords.find(c => c.image_id === 'eeeeeeeeeeeeeeee').cx) - 3.0) < 0.02);
  assert.ok(Math.abs(st.fromY(st.coords.find(c => c.image_id === 'eeeeeeeeeeeeeeee').cy) - (-0.5)) < 0.01);
  const byId = Object.fromEntries(st.coords.map(c => [c.image_id, c]));
  assert.equal(byId.bbbbbbbbbbbbbbbb.fill, 'var(--accent)');
  assert.equal(byId.cccccccccccccccc.fill, 'var(--danger)');
  assert.equal(byId.dddddddddddddddd.fill, 'var(--success)');

  // Auto-bounds soft-centering & -100% physical floor
  const mkPt = (id, mean_residual, slope, status = 'normal') => ({
    image_id: id, name: `${id}.png`, count: 8, comparable_count: 8, mean_residual, slope, status,
  });
  const mild = makeWrapStage('quadrant', 700, 440);
  makeApp({ datasetDiagData: { ...structuredClone(SAMPLE_DATA), by_image: [mkPt('p1', -0.55, -0.10, 'easy'), mkPt('p2', 0.68, 0.06, 'attention')] } })
    ._renderDatasetDiagHeroSvg(mild.wrap, mild.stage, mild.svg);
  assert.deepEqual(mild.wrap._ddDataBounds, { xMin: -0.8, xMax: 0.8, yMin: -0.12, yMax: 0.12 });
  assert.equal(mild.wrap._ddCamera.xMax, -mild.wrap._ddCamera.xMin);

  const extX = makeWrapStage('quadrant', 700, 440);
  makeApp({ datasetDiagData: { ...structuredClone(SAMPLE_DATA), by_image: [mkPt('p1', -0.32, -0.05, 'easy'), mkPt('p2', 3.0, 0.05, 'attention')] } })
    ._renderDatasetDiagHeroSvg(extX.wrap, extX.stage, extX.svg);
  assert.equal(extX.wrap._ddCamera.xMin, -1.0);

  // Pan & wheel zoom math + stage listener binding (no contextmenu hook)
  const autoBounds = { xMin: -0.6, xMax: 0.8, yMin: -0.08, yMax: 0.10 };
  const shifted = a._ddComputePannedScatterZoom({ xMin: 0.1, xMax: 0.5, yMin: -0.02, yMax: 0.04 }, autoBounds, 100, 50, 400, 300, false);
  assert.ok(Math.abs(shifted.xMin - 0.0) < 1e-9 && Math.abs(shifted.yMin - (-0.01)) < 1e-9);
  const linSt = {
    kind: 'scatter', padL: 12, padT: 8, plotW: 400, plotH: 300,
    fromX: px => autoBounds.xMin + ((px - 12) / 400) * (autoBounds.xMax - autoBounds.xMin),
    fromY: py => autoBounds.yMin + ((8 + 300 - py) / 300) * (autoBounds.yMax - autoBounds.yMin),
  };
  const zIn = a._ddComputeWheeledScatterZoom(linSt, null, autoBounds, { symW_X: 0, symW_Y: 0 }, 312, 83, -120, 0, false);
  assert.ok(zIn && zIn.xMax - zIn.xMin < autoBounds.xMax - autoBounds.xMin);
  assert.equal(a._ddComputeWheeledScatterZoom(linSt, { xMin: -0.59, xMax: 0.79, yMin: -0.078, yMax: 0.098 }, autoBounds, { symW_X: 0, symW_Y: 0 }, 212, 158, 240, 0, false), null);

  // Zone shading toggle blocks hit-testing when OFF and cleans hover when turned OFF
  const zone = makeWrapStage('quadrant', 640, 380);
  zone.wrap._ddChartState = { kind: 'scatter', zones: [{ preset: 'attention', x1: 300, x2: 600, y1: 10, y2: 200 }] };
  const zonePanel = {
    querySelector: sel => (sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? zone.wrap : null),
    querySelectorAll: () => [],
  };
  withMockEnv({ document: { querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? zonePanel : null) } }, () => {
    assert.equal(a._ddHitTestScatterZone(zone.wrap._ddChartState, 400, 100), null);
    a.setDatasetDiagShowZones(true);
    assert.equal(zone.svg.classList.contains('is-zones-on'), true);
    assert.equal(a._ddHitTestScatterZone(zone.wrap._ddChartState, 400, 100)?.preset, 'attention');
    zone.wrap._ddHoverZone = 'attention';
    a.setDatasetDiagShowZones(false);
    assert.equal(zone.svg.classList.contains('is-zones-on'), false);
    assert.equal(zone.wrap._ddHoverZone, null);
  });
});

test('quadrant resizing preserves point geometry and hit coordinates at overview and zoom scales', () => {
  const data = structuredClone(SAMPLE_DATA);
  data.by_image[0].mean_residual = 2.5;
  const app = makeApp({datasetDiagData: data});
  const { wrap, stage, svg } = makeWrapStage('quadrant', 700, 440);
  for (const zoom of [null, {xMin: -1, xMax: 3, yMin: -0.3, yMax: 0.3}]) {
    app.datasetDiagScatterZoom = zoom;
    let initial;
    for (const [width, height] of [[700, 440], [1800, 1100], [850, 1150], [700, 440]]) {
      stage.clientWidth = width;
      stage.clientHeight = height;
      app._renderDatasetDiagHeroSvg(wrap, stage, svg);
      const st = wrap._ddChartState;
      const dx = st.toX(2.5) - st.toX(0);
      const dy = st.toY(0) - st.toY(0.05);
      initial ??= {ratio: dx / dy, x: st.toX(0), y: st.toY(0)};
      assert.ok(Math.abs(dx / dy - initial.ratio) < 1e-8);
      assert.equal(wrap._ddCamera.symW_X, zoom ? 0 : 1);
      assert.equal(wrap._ddCamera.symW_Y, 0);
      const dot = st.coords.find(d => d.image_id === data.by_image[0].image_id);
      assert.equal(app._ddHitTestScatterDot(st, dot.cx, dot.cy)?.image_id, dot.image_id);
      if (width === 700) {
        assert.ok(Math.abs(st.toX(0) - initial.x) < 1e-8);
        assert.ok(Math.abs(st.toY(0) - initial.y) < 1e-8);
      }
    }
  }
});

test('early 1D beeswarm, 3-stage dot choreography, MAX_SCATTER_EFFECTS cap, and camera rAF animation', () => {
  // 1. Early 1D beeswarm
  const earlyData = structuredClone(SAMPLE_DATA);
  earlyData.summary.has_slope = false;
  const early = makeWrapStage('quadrant');
  makeApp({ datasetDiagData: earlyData })._renderDatasetDiagHeroSvg(early.wrap, early.stage, early.svg);
  assert.equal(early.svg.attrs.height, '440');
  assert.equal(early.wrap._ddChartState.coords.length, 4);
  for (const pt of early.wrap._ddChartState.coords) {
    assert.ok(pt.cy >= early.wrap._ddChartState.padT && pt.cy <= early.wrap._ddChartState.padT + early.wrap._ddChartState.plotH);
  }

  // 2. 3-stage choreography + MAX_SCATTER_EFFECTS=72 priority cap
  let fakeNow = 1000;
  let rafId = 1;
  let timerId = 1;
  const rafQueue = new Map();
  const timers = new Map();
  const flushTimers = msFilter => {
    for (const [id, entry] of Array.from(timers.entries())) {
      if (msFilter === undefined || entry.ms === msFilter) {
        timers.delete(id);
        entry.fn();
      }
    }
  };
  const flushRaf = () => {
    const entries = Array.from(rafQueue.entries());
    rafQueue.clear();
    for (const [, cb] of entries) cb();
  };

  withMockEnv({
    document: { createElementNS: (_ns, tag) => makeEl(tag), querySelector: () => null },
    performance: { now: () => fakeNow },
    requestAnimationFrame: cb => { const id = rafId++; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame: id => rafQueue.delete(id),
    setTimeout: (fn, ms) => { const id = timerId++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  }, () => {
    const app = makeApp({ datasetDiagData: SAMPLE_DATA, _monitorMotionAllowed: () => true });
    const dotsGroup = makeEl('g');
    const dotOld = makeEl('circle', { class: 'm-dd-dot is-alert', 'data-dd-image-id': 'aaaaaaaaaaaaaaaa', cx: '100.0', cy: '100.0', r: '5.0' });
    dotOld.style.fill = 'var(--warning)';
    dotsGroup.appendChild(dotOld);
    const trailsGroup = makeEl('g');
    const pulsesGroup = makeEl('g');
    const svg = makeEl('svg');
    svg.querySelector = sel => (sel === '.m-dd-dots' ? dotsGroup : sel === '.m-dd-trails' ? trailsGroup : sel === '.m-dd-pulses' ? pulsesGroup : null);
    const wrap = { _ddLastPulseSeq: 0, _ddPrevDotCoords: new Map([['aaaaaaaaaaaaaaaa', { cx: 100, cy: 100 }]]) };

    app._ddReconcileScatterDots(svg, wrap, [
      { image_id: 'aaaaaaaaaaaaaaaa', idx: 0, cx: 200, cy: 200, r: 4.6, fill: 'var(--accent)', status: 'learning', cls: 'm-dd-dot is-learning' },
      { image_id: 'newdot0000000001', idx: 1, cx: 300, cy: 150, r: 4.0, fill: 'var(--success)', status: 'easy', cls: 'm-dd-dot is-easy' },
    ], { animate: true, updatedIds: new Set(['aaaaaaaaaaaaaaaa', 'newdot0000000001']), pulseSeq: 1 });

    // Stage 1: pulse on new dot only
    assert.equal(pulsesGroup.children.length, 1);
    assert.equal(pulsesGroup.children[0].attrs['data-dd-image-id'], 'newdot0000000001');
    assert.equal(dotOld.attrs.cx, '100.0');

    // Stage 2: dashed arrow grows linearly
    fakeNow = 1520;
    flushTimers(520);
    assert.equal(trailsGroup.children.length, 1);
    fakeNow = 1520 + 625;
    flushRaf();
    assert.equal(trailsGroup.children[0].children[0].attrs.x2, '150.0');

    // Stage 3: hold + expo-out glide
    fakeNow = 1520 + 1250;
    flushRaf();
    fakeNow += 220;
    flushTimers(220);
    assert.equal(svg.classList.contains('is-dot-choreo'), true);
    fakeNow += 190;
    flushRaf();
    assert.ok(Number(dotOld.attrs.cx) > 170);
    fakeNow += 800;
    flushRaf();
    assert.equal(dotOld.attrs.cx, '200.0');
    assert.equal(svg.classList.contains('is-dot-choreo'), false);

    // MAX_SCATTER_EFFECTS = 72 cap prioritizes non_finite > attention > normal
    const manyDots = Array.from({ length: 85 }, (_, i) => ({
      image_id: `id_${i}`,
      cx: 100 + i * 2,
      cy: 100 + i,
      r: 4,
      fill: 'var(--accent)',
      status: i === 80 ? 'non_finite' : (i === 79 ? 'attention' : 'normal'),
      mean_residual: 0.1,
    }));
    const capGroup = makeEl('g');
    const capWrap = { _ddLastPulseSeq: 0, _ddPrevDotCoords: new Map() };
    app._ddSpawnScatterPulses(capGroup, capWrap, manyDots, { pulseSeq: 2, updatedIds: new Set(manyDots.map(d => d.image_id)) });
    assert.equal(capGroup.children.length, 72);
    const pulsedIds = new Set(capGroup.children.map(n => n.attrs['data-dd-image-id']));
    assert.equal(pulsedIds.has('id_80'), true);
    assert.equal(pulsedIds.has('id_79'), true);

    // Camera rAF zoom + mid-flight wheel interruption + solid wheel grid opacity
    const bandsGroup = makeEl('g', { 'data-dd-compressed-bands': '' });
    const gridGroup = makeEl('g', { 'data-dd-grid-lines': '' });
    const zoneRects = { attention: makeEl('rect'), learning: makeEl('rect') };
    const zonesGroup = { querySelector: s => zoneRects[s.match(/data-dd-zone-preset="([^"]+)"/)?.[1]] || null };
    const axisXGroup = makeEl('g'), axisYGroup = makeEl('g'), axisXTicks = makeEl('g'), axisYTicks = makeEl('g'), axisOrigin = makeEl('g');
    axisOrigin.appendChild(makeEl('text'));
    const labelsGroup = makeEl('g', { class: 'm-dd-quad-labels' });
    const camDots = makeEl('g');
    camDots.appendChild(makeEl('circle', { class: 'm-dd-dot', 'data-dd-image-id': 'aaaaaaaaaaaaaaaa' }));
    const camSvg = makeEl('svg', { 'data-dd-svg-kind': 'quadrant', 'data-dd-svg-width': '700', 'data-dd-svg-height': '436' });
    camSvg.querySelector = sel => ({
      '.m-dd-dots': camDots, '[data-dd-compressed-bands]': bandsGroup, '[data-dd-grid-lines]': gridGroup,
      '[data-dd-zones]': zonesGroup, '[data-dd-axis-x-group]': axisXGroup, '[data-dd-axis-y-group]': axisYGroup,
      '[data-dd-axis-x-ticks]': axisXTicks, '[data-dd-axis-y-ticks]': axisYTicks, '[data-dd-axis-origin]': axisOrigin,
      '.m-dd-quad-labels': labelsGroup,
    })[sel] || null;
    const camWrap = makeEl('div'); camWrap.dataset = { mode: 'quadrant' };
    const camStage = makeEl('div'); camStage.clientWidth = 700; camStage.clientHeight = 440;
    app._renderDatasetDiagHeroSvg(camWrap, camStage, camSvg, { animate: false });
    app.datasetDiagScatterZoom = { xMin: 0.10, xMax: 0.65, yMin: -0.04, yMax: 0.06 };
    app._renderDatasetDiagHeroSvg(camWrap, camStage, camSvg, { animate: true, durationMs: 150, cameraMode: 'wheel' });
    assert.equal(camSvg.classList.contains('is-camera-anim'), true);
    assert.equal(gridGroup.children[0].style.opacity, '1');
    fakeNow += 75;
    flushRaf();
    const midCam = camWrap._ddCurrentCamEval();
    app.datasetDiagScatterZoom = { xMin: 0.22, xMax: 0.55, yMin: -0.02, yMax: 0.04 };
    app._renderDatasetDiagHeroSvg(camWrap, camStage, camSvg, { animate: true, durationMs: 150, cameraMode: 'wheel' });
    assert.ok(Math.abs(camWrap._ddCurrentCamera.xMin - midCam.xMin) < 1e-6);
    fakeNow += 200;
    flushRaf();
    assert.equal(camSvg.classList.contains('is-camera-anim'), true);
    fakeNow += 300;
    flushRaf();
    assert.equal(camSvg.classList.contains('is-camera-anim'), false);
    assert.equal(camWrap._ddTargetCamera.xMin, 0.22);

    // Return from a wide, off-center viewport to auto bounds in a narrow desktop chart.
    camStage.clientWidth = 450;
    app.datasetDiagScatterZoom = { xMin: -2, xMax: 3, yMin: -0.3, yMax: 0.3 };
    app._renderDatasetDiagHeroSvg(camWrap, camStage, camSvg, { animate: false });
    app.datasetDiagScatterZoom = null;
    app._renderDatasetDiagHeroSvg(camWrap, camStage, camSvg, { animate: true, durationMs: 200 });
    const axisPositions = [];
    const textBounds = (node, offsetX, size) => {
      const width = app._ddEstimateScatterLabelWidth(node.textContent, size);
      const anchor = offsetX + Number(node.getAttribute('x'));
      const left = node.getAttribute('text-anchor') === 'end' ? anchor - width : anchor;
      return [left, left + width];
    };
    for (const elapsed of [5, 20, 40, 70]) {
      fakeNow += elapsed;
      flushRaf();
      const axisX = Number(/translateX\(([-.\d]+)px\)/.exec(axisYGroup.style.transform)[1]);
      axisPositions.push(axisX);
      const slope = axisYTicks.querySelector('.m-dd-axis-dir');
      const threshold = labelsGroup.querySelector('[data-dd-thresh-label="high"]');
      assert.ok(slope && threshold);
      assert.equal(threshold.style.opacity, '1');
      const [slopeLeft, slopeRight] = textBounds(slope, axisX, 10.5);
      const [highLeft, highRight] = textBounds(threshold, 0, 10);
      const rowDistance = Math.abs(Number(slope.getAttribute('y')) - Number(threshold.getAttribute('y')));
      assert.ok(rowDistance >= 12 || slopeRight <= highLeft || highRight <= slopeLeft,
        'the threshold and moving Y-axis direction label must stay apart on every sampled frame');
    }
    assert.ok(new Set(axisPositions).size > 1);
  });
});

test('scatter hover trajectory, pinned card tether/dodge, popover bounds/hysteresis, and overview deselection', () => {
  const openedModals = [];
  const docListeners = new Map();
  const stage = makeEl('div');
  stage.getBoundingClientRect = () => ({ left: 0, right: 700, top: 0, bottom: 440, width: 700, height: 440 });
  const svg = makeEl('svg', { 'data-dd-svg-kind': 'quadrant' });
  svg.getBoundingClientRect = () => stage.getBoundingClientRect();
  const historyGroup = makeEl('g');
  const crosshair = makeEl('g');
  const chX = makeEl('line'), chY = makeEl('line');
  crosshair.querySelector = s => (s === '[data-dd-ch-x]' ? chX : s === '[data-dd-ch-y]' ? chY : null);
  const focusRing = makeEl('circle');
  const tether = makeEl('line');
  const dotAEl = makeEl('circle', { class: 'm-dd-dot is-alert', 'data-dd-image-id': 'aaaaaaaaaaaaaaaa' });
  const dotBEl = makeEl('circle', { class: 'm-dd-dot is-easy', 'data-dd-image-id': 'bbbbbbbbbbbbbbbb' });
  svg.querySelector = sel => ({ '[data-dd-history]': historyGroup, '[data-dd-crosshair]': crosshair, '[data-dd-dot-focus]': focusRing, '[data-dd-pin-tether]': tether })[sel] || null;
  svg.querySelectorAll = sel => (sel === '.m-dd-dot, .m-dd-dot-nan-ring' ? [dotAEl, dotBEl] : []);

  const pop = makeEl('div');
  pop.hidden = true;
  const popImg = makeEl('img');
  const popMedia = makeEl('div');
  popImg.parentElement = popMedia;
  pop.querySelector = sel => (sel === 'img' ? popImg : makeEl('span'));
  pop.getBoundingClientRect = () => {
    const l = parseFloat(pop.style.left) || 0;
    const t = parseFloat(pop.style.top) || 0;
    return { left: l, top: t, right: l + 244, bottom: t + 256, width: 244, height: 256 };
  };
  const wrap = makeEl('div');
  wrap.dataset = { mode: 'quadrant' };
  wrap.querySelector = sel => ({ '[data-dd-hero-stage]': stage, '[data-dd-hero-svg]': svg, '[data-dd-preview-pop]': pop, '[data-dd-pin-tether]': tether })[sel] || null;
  const panel = makeEl('div');
  panel.querySelectorAll = sel => (sel === '[data-dd-hero-wrap]' ? [wrap] : []);
  panel.querySelector = sel => (sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? wrap : null);

  withMockEnv({
    innerWidth: 1440,
    innerHeight: 900,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    document: {
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"] [data-dd-hero-wrap][data-mode="quadrant"]' ? wrap : sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null),
      addEventListener(type, fn) { docListeners.set(type, fn); },
      removeEventListener(type) { docListeners.delete(type); },
    },
  }, () => {
    const app = makeApp({
      currentRoute: 'monitor-dashboard',
      monitorTab: 'dataset',
      datasetDiagData: SAMPLE_DATA,
      datasetDiagPreset: 'attention',
      _datasetDiagDetailCache: new Map(),
      _ddShouldKeepOverviewSelection: target => Boolean(target?.closest?.('.m-dd-preview-pop')),
      openDatasetDiagModal(id) { openedModals.push(id); },
    });
    const cacheKey = app._datasetDiagDetailCacheKey(app._datasetDiagSource(), 'aaaaaaaaaaaaaaaa');
    app._datasetDiagDetailCache.set(cacheKey, {
      trajectory: [
        { epoch: 3, mean_residual: 0.45, slope: 0.04, status: 'attention' },
        { epoch: 4, mean_residual: 0.35, slope: -0.04, status: 'learning' },
      ],
    });
    app._bindDatasetDiagCharts(panel);
    wrap._ddChartState = {
      kind: 'scatter', width: 700, height: 440, padL: 12, padR: 12, padT: 8, plotW: 676, plotH: 422,
      toX: v => 350 + v * 300, toY: v => 220 - v * 1200,
      coords: [
        { image_id: 'aaaaaaaaaaaaaaaa', name: 'bad.png', mean_residual: 0.35, slope: -0.04, count: 10, resolution: '512x512', status: 'learning', cx: 455, cy: 268, r: 4.6, fill: 'var(--accent)', thumb_url: '/thumb/a.png' },
        { image_id: 'bbbbbbbbbbbbbbbb', name: 'ok.png', mean_residual: -0.35, slope: -0.05, count: 10, resolution: '512x512', status: 'easy', cx: 245, cy: 280, r: 4.0, fill: 'var(--success)', thumb_url: '/thumb/b.png' },
      ],
      zones: [],
    };

    // Hover shows trajectory without popup
    app._updateDatasetDiagHeroHover(wrap, 455, 268);
    assert.equal(pop.hidden, true);
    assert.equal(svg.classList.contains('has-traj-focus'), true);
    assert.equal(dotAEl.classList.contains('is-traj-active'), true);
    assert.ok(historyGroup.innerHTML.includes('m-dd-hist-seg'));

    // Click pins card, pan keeps card stationary with tether, settle dodges only if covered
    wrap._ddLiveDotCoords = new Map([['aaaaaaaaaaaaaaaa', { cx: 380, cy: 230 }]]);
    stage.emit('pointerdown', { button: 0, isPrimary: true, clientX: 380, clientY: 230, target: svg });
    wrap._ddLiveDotCoords = null;
    stage.emit('click', { clientX: 382, clientY: 231, target: svg });
    assert.equal(pop.hidden, false);
    assert.equal(pop.classList.contains('is-pinned'), true);
    assert.equal(openedModals.length, 0);

    const pinnedLeft0 = pop.style.left;
    const pinnedTop0 = pop.style.top;
    wrap._ddPan = { active: true };
    wrap._ddChartState.coords[0] = { ...wrap._ddChartState.coords[0], cx: 560, cy: 360 };
    app._refreshDatasetDiagActiveHover(wrap);
    assert.equal(pop.style.left, pinnedLeft0);
    assert.equal(pop.style.top, pinnedTop0);
    assert.equal(wrap._ddPopDetached, true);
    assert.equal(tether.getAttribute('display'), undefined);
    wrap._ddPan = null;

    // Hovering pinned card freezes it; clicking media opens modal
    pop.emit('pointerenter');
    pop.emit('pointerleave');
    pop.emit('click', { target: { closest: sel => (sel === '.m-dd-pop-media' ? popMedia : null) }, stopPropagation() {} });
    assert.deepEqual(openedModals, ['aaaaaaaaaaaaaaaa']);
    assert.equal(pop.hidden, true);

    // First Esc unpins without clearing overview preset; second Esc clears preset
    stage.emit('pointerdown', { button: 0, isPrimary: true, clientX: 245, clientY: 280, target: svg });
    stage.emit('click', { clientX: 245, clientY: 280, target: svg });
    assert.equal(wrap._ddPinnedDot.image_id, 'bbbbbbbbbbbbbbbb');
    docListeners.get('keydown')({ key: 'Escape', defaultPrevented: false, isComposing: false, preventDefault() {}, target: svg });
    assert.equal(wrap._ddPinnedDot, null);
    assert.equal(app.datasetDiagPreset, 'attention');
    docListeners.get('keydown')({ key: 'Escape', defaultPrevented: false, isComposing: false, preventDefault() {}, target: svg });
    assert.equal(app.datasetDiagPreset, 'all');

    // Popover placement bounds, hysteresis, and narrow fallback
    const popBounds = makeEl('div');
    const bounds = { svgLeft: 20, svgRight: 760, svgTop: 180, svgBottom: 640 };
    app._ddPositionDatasetDiagPopover(popBounds, { ...bounds, x: 710, y: 400 }, { wasHidden: true });
    assert.equal(popBounds._ddPopPlacement, 'left');
    assert.ok(parseInt(popBounds.style.left, 10) + popBounds.offsetWidth <= bounds.svgRight - 8);
    app._ddPositionDatasetDiagPopover(popBounds, { ...bounds, x: 420, y: 390 }, { wasHidden: false });
    assert.equal(popBounds._ddPopPlacement, 'left');
    app._ddPositionDatasetDiagPopover(popBounds, { ...bounds, x: 120, y: 390 }, { wasHidden: false });
    assert.equal(popBounds._ddPopPlacement, 'right');

    const popNarrow = makeEl('div');
    app._ddPositionDatasetDiagPopover(popNarrow, { svgLeft: 20, svgRight: 440, svgTop: 80, svgBottom: 720, x: 230, y: 500 }, { wasHidden: true });
    assert.ok(popNarrow._ddPopPlacement === 'top' || popNarrow._ddPopPlacement === 'bottom');

    panel._ddHeroRO.disconnect();
    assert.equal(docListeners.has('click'), false);
    assert.equal(docListeners.has('keydown'), false);
  });
});

test('status highlight coordination and optional folder grouping in grid/table views', () => {
  const segs = ['non_finite', 'attention', 'learning', 'normal', 'easy', 'unqualified'].map(k => makeEl('span', { 'data-dd-status-seg': k }));
  const rows = ['attention', 'normal', 'unqualified'].map(k => makeEl('div', { 'data-dd-status-key': k }));
  const zones = ['attention', 'learning'].map(k => makeEl('rect', { 'data-dd-zone-preset': k }));
  const listEl = makeEl('div');
  const scatterWrap = { _ddActiveDot: null, _ddHoverZone: null, querySelectorAll: sel => (sel === '[data-dd-zone-preset]' ? zones : []) };
  const groupRows = [makeEl('div', { 'data-dd-group-row-key': 'subset::char' }), makeEl('div', { 'data-dd-group-row-key': 'subset::reg' })];
  const panel = {
    querySelector: sel => (sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? scatterWrap : sel === '[data-dd-status-list]' ? listEl : null),
    querySelectorAll: sel => (sel === '[data-dd-status-seg]' ? segs : sel === '[data-dd-status-key]' ? rows : sel === '.m-dd-flat-group-row.is-clickable' ? groupRows : []),
  };
  withMockEnv({ document: { querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null) } }, () => {
    const app = makeApp({ datasetDiagData: SAMPLE_DATA });
    app.previewDatasetDiagStatus('attention');
    assert.equal(rows[0].classList.contains('is-preview'), true);
    assert.equal(segs[3].classList.contains('is-dimmed'), true);
    assert.equal(zones[0].classList.contains('is-hover'), true);
    app.clearDatasetDiagPreview();

    scatterWrap._ddActiveDot = { image_id: 'x1', status: 'insufficient', subset: 'char', resolution: '512x512' };
    app._syncDatasetDiagStatusHighlight(panel);
    assert.equal(rows[2].classList.contains('is-linked'), true);
    assert.equal(groupRows[0].classList.contains('is-linked'), true);
  });

  // Folder grouping in grid/table views + shared subset fallback + collapsed nav filtering
  const app = makeApp({ datasetDiagData: SAMPLE_DATA, datasetDiagSubTab: 'images', datasetDiagGroupByFolder: false, datasetDiagRegMode: 'all' });
  assert.ok(!app._renderDatasetDiagImagesCard(k => app.tMonitor(k), SAMPLE_DATA).includes('m-dd-folder-group'));
  app.setDatasetDiagGroupByFolder(true);
  const groupedGrid = app._renderDatasetDiagImagesCard(k => app.tMonitor(k), SAMPLE_DATA);
  assert.equal((groupedGrid.match(/class="m-dd-folder-group"/g) || []).length, 2);
  assert.equal(app._datasetDiagModalNavList().map(i => i.image_id).join(','), 'cccccccccccccccc,aaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbb,dddddddddddddddd');

  app.setDatasetDiagViewMode('table');
  const groupedTable = app._renderDatasetDiagImagesCard(k => app.tMonitor(k), SAMPLE_DATA);
  assert.equal((groupedTable.match(/class="output-table-head"/g) || []).length, 1);
  assert.equal((groupedTable.match(/class="m-dd-table-folder-head/g) || []).length, 2);
  app.toggleDatasetDiagFolderCollapsed('D:/ds/char');
  app.datasetDiagModalImageId = 'dddddddddddddddd';
  assert.deepEqual(app._datasetDiagModalNavList().map(i => i.image_id), ['dddddddddddddddd']);
});

test('timestep chart 18-bin profile, IQR band, theoretical curves, morph animation, and tooltip smart-snap', () => {
  const a = makeApp({ datasetDiagData: SAMPLE_DATA });
  const profBins = Array.from({ length: 18 }, (_, bin) => {
    const empty = bin === 8 || bin === 9;
    const sparse = bin === 5;
    return {
      bin, t_from: bin * (1000 / 18), t_to: (bin + 1) * (1000 / 18),
      count: empty ? 0 : (sparse ? 1 : 6), images: empty ? 0 : (sparse ? 1 : 4), comparable: !empty && !sparse,
      mean_loss: empty ? null : (0.12 + bin * 0.015), p25: empty || sparse ? null : (0.09 + bin * 0.012),
      p75: empty || sparse ? null : (0.16 + bin * 0.018), trend: empty ? null : -0.15, non_finite_count: bin === 15 ? 2 : 0,
    };
  });
  const richData = {
    ...structuredClone(SAMPLE_DATA),
    sampling_config: { timestep_sampling: 'sigmoid', discrete_flow_shift: 2.0, min_timestep: 100, max_timestep: 900 },
    timestep_profile: {
      num_bins: 18,
      bins: profBins,
      by_status: {
        easy: { counts: Array.from({ length: 18 }, () => 4), mean_loss: Array.from({ length: 18 }, () => 0.09) },
        attention: { counts: Array.from({ length: 18 }, () => 6), mean_loss: Array.from({ length: 18 }, () => 0.55) },
      },
      by_group: {},
    },
  };
  a.datasetDiagData = richData;

  const ts = makeWrapStage('timestep', 360, 176);
  const tipEl = makeEl('div'); tipEl.hidden = true; tipEl.offsetWidth = 180; tipEl.offsetHeight = 90;
  const origQuery = ts.wrap.querySelector;
  ts.wrap.querySelector = sel => (sel === '[data-dd-ts-tooltip]' ? tipEl : origQuery(sel));
  a._renderDatasetDiagHeroSvg(ts.wrap, ts.stage, ts.svg);
  assert.equal(ts.wrap._ddChartState.coords.length, 18);
  assert.ok(ts.wrap._ddChartState.coords[0].xCenter < ts.wrap._ddChartState.coords.at(-1).xCenter);
  assert.ok(ts.svg.innerHTML.includes('m-dd-ts-iqr-band'));
  assert.ok(ts.svg.innerHTML.includes('m-dd-ts-theo-line'));
  assert.ok(ts.svg.innerHTML.includes('m-dd-ts-excluded'));

  // IQR band forms one continuous ribbon across non-excluded valid bins while staying clear of excluded bins
  const iqrEl = ts.svg.querySelector('[data-dd-ts-iqr]');
  const iqrD = iqrEl?.getAttribute('d') || '';
  const iqrSegs = iqrD.match(/M[^Z]+Z/g) || [];
  assert.equal(iqrSegs.length, 1);
  const gapBin = ts.wrap._ddChartState.coords.find(c => c.bin === 8);
  const nonExclIqr = ts.wrap._ddChartState.coords.filter(c => !c.excluded && c.yP25 != null && c.yP75 != null);
  const xs = Array.from(iqrSegs[0].matchAll(/[ML](-?\d+(?:\.\d+)?)\s+-?\d+(?:\.\d+)?/g), m => Number(m[1]));
  assert.ok(Math.abs(Math.min(...xs) - nonExclIqr[0].xCenter) <= 0.2);
  assert.ok(Math.abs(Math.max(...xs) - nonExclIqr.at(-1).xCenter) <= 0.2);

  // Hovering an interior empty bin stays on that bin, keeps density bars unlit, and shows unmeasured hint
  const densityBars = ts.svg.querySelectorAll('.m-dd-ts-density-bar');
  const origSvgQs = ts.svg.querySelector.bind(ts.svg);
  const origSvgQsa = ts.svg.querySelectorAll.bind(ts.svg);
  ts.svg.querySelector = sel => {
    const m = /^\.m-dd-ts-density-bar\[data-dd-ts-idx="(\d+)"\]$/.exec(sel);
    if (m) return densityBars.find(b => b.getAttribute('data-dd-ts-idx') === m[1]) || null;
    return origSvgQs(sel);
  };
  ts.svg.querySelectorAll = sel => (
    sel === '.m-dd-ts-density-bar.is-hovered'
      ? densityBars.filter(b => b.classList.contains('is-hovered'))
      : origSvgQsa(sel)
  );

  const validBin = ts.wrap._ddChartState.coords.find(c => c.bin === 7);
  a._updateDatasetDiagHeroHover(ts.wrap, validBin.xCenter, 60);
  assert.equal(ts.wrap._ddActiveBar, validBin);
  assert.equal(ts.svg.querySelectorAll('.m-dd-ts-density-bar.is-hovered').length, 1);

  a._updateDatasetDiagHeroHover(ts.wrap, gapBin.xCenter, 60);
  assert.equal(ts.wrap._ddActiveBar, gapBin);
  assert.equal(tipEl.hidden, false);
  assert.ok(tipEl.innerHTML.includes(a.tMonitor('ddNoiseTooltipUnmeasured')));
  assert.equal(ts.svg.querySelectorAll('.m-dd-ts-density-bar.is-hovered').length, 0);

  const exclBin = ts.wrap._ddChartState.coords[0];
  a._updateDatasetDiagHeroHover(ts.wrap, exclBin.xCenter, 60);
  assert.ok(tipEl.innerHTML.includes('900'));

  // Theoretical curves: flux_shift resolution weighting & subset timestep_offset
  const baseBins18 = a._ddPrepareTimestepBins(a._ddResolveNoiseProfileBins(richData, 18), null, { minT: 0, maxT: 1000, hasMin: false, hasMax: false }).bins;
  const sumHigh = shares => shares.slice(0, 6).reduce((acc, v) => acc + v, 0);
  const fluxSmall = a._ddComputeTheoreticalBinShares({
    profile: 'anima-lora', sampling_config: { timestep_sampling: 'flux_shift', sigmoid_scale: 1.0 },
    by_resolution: [{ key: '512x512', count: 100 }, { key: '1536x1536', count: 10 }],
  }, baseBins18, { minT: 0, maxT: 1000, hasMin: false, hasMax: false });
  const fluxLarge = a._ddComputeTheoreticalBinShares({
    profile: 'anima-lora', sampling_config: { timestep_sampling: 'flux_shift', sigmoid_scale: 1.0 },
    by_resolution: [{ key: '512x512', count: 10 }, { key: '1536x1536', count: 100 }],
  }, baseBins18, { minT: 0, maxT: 1000, hasMin: false, hasMax: false });
  assert.ok(sumHigh(fluxLarge) > sumHigh(fluxSmall) + 0.03);

  // Morph animation & reduced motion
  const tsRafQueue = new Map();
  let tsRafId = 0;
  let tsMotionAllowed = true;
  const runNextFrame = tsNow => {
    const first = tsRafQueue.entries().next();
    if (first.done) return false;
    const [id, cb] = first.value;
    tsRafQueue.delete(id);
    cb(tsNow);
    return true;
  };
  withMockEnv({
    document: { createElementNS: (_ns, tag) => makeEl(tag), querySelector: () => null },
    requestAnimationFrame: cb => { const id = ++tsRafId; tsRafQueue.set(id, cb); return id; },
    cancelAnimationFrame: id => tsRafQueue.delete(id),
  }, () => {
    const morphApp = makeApp({ datasetDiagData: richData, _monitorMotionAllowed: () => tsMotionAllowed });
    const baseEl = makeEl('g'), theoEl = makeEl('g'), compEl = makeEl('g'), selEl = makeEl('g'), yMaxEl = makeEl('text'), focusCompEl = makeEl('circle');
    const fakeSvg = makeEl('svg');
    fakeSvg.querySelector = sel => ({ '[data-dd-ts-base]': baseEl, '[data-dd-ts-density-theo]': theoEl, '[data-dd-ts-comp]': compEl, '[data-dd-ts-density-sel]': selEl, '[data-dd-ts-y-max]': yMaxEl, '[data-dd-ts-focus-comp]': focusCompEl })[sel] || null;
    const mStage = makeEl('div'); mStage.clientWidth = 380; mStage.clientHeight = 176;
    const mWrap = makeEl('div'); mWrap.dataset = { mode: 'timestep' };

    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    const baseHigh = fakeSvg._ddTsLiveState.high;
    morphApp.toggleDatasetDiagOverviewPreset('easy');
    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    assert.equal(tsRafQueue.size, 1);
    assert.equal(runNextFrame(0), true);
    assert.equal(runNextFrame(100), true);
    const midEasyHigh = fakeSvg._ddTsLiveState.high;

    morphApp.toggleDatasetDiagOverviewPreset('attention');
    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    assert.equal(runNextFrame(116), true);
    assert.ok(Math.abs(fakeSvg._ddTsLiveState.high - midEasyHigh) < 1e-6);
    assert.equal(runNextFrame(360), true);
    assert.ok(fakeSvg._ddTsLiveState.high > baseHigh + 0.05);

    morphApp.toggleDatasetDiagOverviewPreset('attention');
    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    assert.equal(runNextFrame(400), true);
    assert.equal(runNextFrame(600), true);
    assert.equal(fakeSvg._ddTsLiveState.kind, 'none');

    tsMotionAllowed = false;
    morphApp.toggleDatasetDiagOverviewPreset('easy');
    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    assert.equal(tsRafQueue.size, 0);
    assert.equal(fakeSvg._ddTsLiveState.kind, 'series');

    // New training samples keep the same scaffold. Retarget from the displayed
    // distribution even if the next snapshot arrives before the morph settles.
    tsMotionAllowed = true;
    const previous = fakeSvg._ddTsLiveState;
    const binIndex = previous.coords.findIndex(c => c.bin === 7);
    const updated = structuredClone(richData);
    const bin = updated.timestep_profile.bins[7];
    bin.mean_loss += 0.12;
    bin.count += 10;
    morphApp.datasetDiagData = updated;
    const hitLayer = fakeSvg.innerHTML;
    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    assert.equal(fakeSvg.innerHTML, hitLayer);
    assert.ok(runNextFrame(700) && runNextFrame(750));
    const shown = fakeSvg._ddTsLiveState.coords[binIndex];
    assert.ok(shown.mean_loss > previous.coords[binIndex].mean_loss && shown.mean_loss < bin.mean_loss);
    const pendingFrame = fakeSvg._ddTsAnimRaf;
    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    assert.equal(fakeSvg._ddTsAnimRaf, pendingFrame);
    const second = structuredClone(updated);
    second.timestep_profile.bins[7].mean_loss += 0.08;
    morphApp.datasetDiagData = second;
    morphApp._renderDatasetDiagHeroSvg(mWrap, mStage, fakeSvg);
    assert.ok(runNextFrame(760));
    assert.equal(fakeSvg._ddTsLiveState.coords[binIndex].mean_loss, shown.mean_loss);
    assert.ok(runNextFrame(970));
    assert.equal(fakeSvg._ddTsLiveState.coords[binIndex].mean_loss, second.timestep_profile.bins[7].mean_loss);
    assert.equal(fakeSvg.innerHTML, hitLayer);
  });
});

test('modal detail, NaN row, first_non_finite truncation, epoch/timestep charts, linked hover, viewport zoom, and Tag Editor handoff', async () => {
  let navigated = null;
  const makeDetail = (imageObj, extraSamples = []) => ({
    run_id: 'r1',
    timestep_scale: 'unit',
    thresholds: { high_residual: 0.20 },
    subset_meta: { num_repeats: 2, aug_flags: ['flip_aug'] },
    image: imageObj,
    epoch_series: [
      { epoch: 1, count: 2, mean_residual: 0.4, mean_loss: 0.3, non_finite_count: 0 },
      { epoch: 2, count: 2, mean_residual: 0.44, mean_loss: 0.34, non_finite_count: extraSamples.some(s => s.non_finite) ? 1 : 0 },
      { epoch: 3, count: 1, mean_residual: 0.25, mean_loss: 0.32, non_finite_count: 0 },
    ],
    timestep_profile: {
      num_bins: 18,
      bins: Array.from({ length: 18 }, (_, bin) => ({
        bin, t_from: bin * (1000 / 18), t_to: (bin + 1) * (1000 / 18),
        count: 4, images: 3, comparable: true, mean_loss: 0.25, p25: 0.18, p75: 0.32,
      })),
    },
    samples: [{ step: 1, epoch: 1, timestep: 0.5, loss: 0.3, residual: 0.4, width: 768, height: 1024 }, ...extraSamples],
    samples_total: 1 + extraSamples.length,
    caption: { exists: true, filename: 'bad.txt', text: '1girl, solo', error: '', editor_safe: true },
    file_info: { exists: true, abs_path: 'D:/ds/char/bad.png', dir_path: 'D:/ds/char', size: 1234, width: 768, height: 1024 },
  });

  await withMockEnv({
    fetch: async url => {
      const s = String(url);
      if (s.includes('image_id=aaaaaaaaaaaaaaaa')) return response(makeDetail(SAMPLE_DATA.by_image[0], [{ step: 3, epoch: 2, timestep: 0.5, loss: 0.301, residual: 0.4 }]));
      if (s.includes('image_id=cccccccccccccccc')) return response(makeDetail(SAMPLE_DATA.by_image[2], [{ step: 2, epoch: 2, timestep: 0.85, loss: null, residual: null, non_finite: true }]));
      throw new Error('Unexpected fetch: ' + url);
    },
  }, async () => {
    const a = makeApp({ datasetDiagData: SAMPLE_DATA, navigate(route) { navigated = route; } });
    a.openDatasetDiagModal('aaaaaaaaaaaaaaaa');
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(a.datasetDiagModalOpen, true);

    // Cards/rows omit removed data-dialog-opens while keeping data-dd-image-id and aria-haspopup="dialog"
    const cardHtml = a._ddImageCardHtml(k => a.tMonitor(k), SAMPLE_DATA.by_image[0]);
    assert.ok(cardHtml.includes('data-dd-image-id="aaaaaaaaaaaaaaaa"') && cardHtml.includes('aria-haspopup="dialog"'));
    assert.ok(!cardHtml.includes('data-dialog-opens'));
    const rowHtml = a._ddImageTableRowHtml(k => a.tMonitor(k), SAMPLE_DATA.by_image[0], 0.5);
    assert.ok(rowHtml.includes('data-dd-image-id="aaaaaaaaaaaaaaaa"') && rowHtml.includes('aria-haspopup="dialog"'));
    assert.ok(!rowHtml.includes('data-dialog-opens'));

    const cropDiff = a._ddComputeBucketDiff(1024, 768, '512x512', k => a.tMonitor(k));
    assert.equal(cropDiff.cropPct, 25);
    assert.equal(cropDiff.warn, true);

    // Right panel + Tag Editor handoff + footer actions
    const rightHtml = a._renderDatasetDiagModalRightHtml(k => a.tMonitor(k), a.datasetDiagModalDetail);
    assert.ok(rightHtml.indexOf('m-dd-caption-sec') < rightHtml.indexOf(a.tMonitor('ddEpochTrendTitle')));
    a.openDatasetDiagInTagEditor();
    assert.equal(navigated, 'tagEditor');
    assert.equal(a.tagEditorSearchQuery, '^bad\\.png$');

    // Truncated logs still show first_non_finite coordinates
    const nanDetail = makeDetail(SAMPLE_DATA.by_image[2], [{ step: 505, epoch: 5, timestep: 0.85, loss: null, residual: null, non_finite: true }]);
    nanDetail.image = { ...nanDetail.image, non_finite_count: 2 };
    nanDetail.first_non_finite = { step: 1, epoch: 1, timestep: 0.25, non_finite: true };
    nanDetail.samples_truncated = true;
    const truncNanHtml = a._renderDatasetDiagModalRightHtml(k => a.tMonitor(k), nanDetail);
    assert.ok(truncNanHtml.includes('t = 250'));

    // Linked hover between modal epoch & timestep charts + zone header hover
    const epStage = makeEl('div'); epStage.clientHeight = 180;
    const epSvg = makeEl('svg'); const epTip = makeEl('div'); epTip.hidden = true;
    const tsStage = makeEl('div'); tsStage.clientHeight = 220;
    const tsSvg = makeEl('svg'); const tsTip = makeEl('div'); tsTip.hidden = true;
    const zoneHigh = makeEl('div'); zoneHigh.dataset.ddZoneKey = 'high';
    const zoneMid = makeEl('div'); zoneMid.dataset.ddZoneKey = 'mid';
    const zoneLow = makeEl('div'); zoneLow.dataset.ddZoneKey = 'low';
    const rightEl = {
      querySelector: sel => ({
        '[data-dd-epoch-stage]': epStage, '[data-dd-epoch-svg]': epSvg, '[data-dd-ep-tooltip]': epTip,
        '[data-dd-ts-stage]': tsStage, '[data-dd-ts-svg]': tsSvg, '[data-dd-ts-tooltip]': tsTip,
      })[sel] || null,
      querySelectorAll: sel => (sel === '.m-dd-modal-zone[data-dd-zone-key]' ? [zoneHigh, zoneMid, zoneLow] : []),
    };
    const linkedDetail = makeDetail(SAMPLE_DATA.by_image[0], [
      { step: 20, epoch: 2, timestep: 0.5, loss: 0.301, residual: 0.2 },
      { step: 30, epoch: 1, timestep: 0.65, loss: 0.50, residual: 0.45 },
      { step: 40, epoch: 2, timestep: 0.654, loss: 0.501, residual: 0.46 },
      { step: 50, epoch: 3, timestep: 0.80, loss: 0.42, residual: 0.30 },
    ]);
    withMockEnv({ requestAnimationFrame: undefined, cancelAnimationFrame: undefined }, () => {
      a._bindDatasetDiagModalCharts(rightEl, linkedDetail, k => a.tMonitor(k), { immediate: true });
      const c500 = tsStage._ddState.clusters.find(c => c.items.length === 2 && Math.round(c.t1000) === 500);
      tsStage.emit('pointermove', { clientX: c500.cx, clientY: c500.cy });
      const epDots = epSvg.querySelectorAll('[data-dd-ep-dot]');
      assert.equal(epDots.find(n => n.getAttribute('data-dd-ep-dot') === '1').classList.contains('is-ts-linked'), true);
      assert.equal(epDots.find(n => n.getAttribute('data-dd-ep-dot') === '2').classList.contains('is-ts-linked'), true);
      assert.equal(zoneMid.classList.contains('is-zone-hover'), true);
      assert.ok(tsTip.innerHTML.includes('t = 500'));

      const c650 = tsStage._ddState.clusters.find(c => c.items.length === 2 && c.t1000 > 640 && c.t1000 < 660);
      tsStage.emit('pointermove', { clientX: c650.cx, clientY: c650.cy });
      assert.ok(tsTip.innerHTML.includes('650–654'));

      zoneHigh.emit('pointerenter');
      const tsZoneNodes = tsSvg.querySelectorAll('[data-dd-zone]');
      assert.ok(tsZoneNodes.filter(n => n.getAttribute('data-dd-zone') === 'high').every(n => n.classList.contains('is-zone-hot')));
      zoneHigh.emit('pointerleave');

      const ep2 = epStage._ddState.allCoords.find(c => c.epoch === 2);
      epStage.emit('pointermove', { clientX: ep2.x, clientY: ep2.y });
      assert.equal(tsSvg.classList.contains('is-ep-linking'), true);
      epStage.emit('pointerleave');
      assert.equal(tsSvg.classList.contains('is-ep-linking'), false);
    });

    // Modal continuous wheel zoom & reset animation via AnimaImageViewport
    const vpRafQueue = [];
    let vpNow = 0;
    const vpContext = loadFrontend(['shared/image-viewport', 'shared/utils', 'monitor/core', 'monitor/render'], {
      window: {},
      performance: { now: () => vpNow },
      requestAnimationFrame: cb => { vpRafQueue.push(cb); return vpRafQueue.length; },
      cancelAnimationFrame: () => {},
      document: { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    });
    vpContext.window.matchMedia = () => ({ matches: false });
    const modalApp = Object.assign(composeMixins(vpContext.window.utilsMixin, vpContext.window.monitorCoreMixin, vpContext.window.monitorRenderMixin), {
      t(key) { return key.split('.').reduce((v, part) => v?.[part], zhDict) ?? key; },
      _syncDatasetDiagImageStyle() {},
    });
    modalApp.datasetDiagViewport.zoom({ deltaY: -12, deltaX: 0, deltaMode: 0, preventDefault() {}, stopPropagation() {} });
    assert.ok(modalApp.datasetDiagViewport.scale > 1.01 && modalApp.datasetDiagViewport.scale < 1.03);
    modalApp.datasetDiagViewport.reset(false);
    modalApp.datasetDiagViewport.zoom({ deltaY: -120, deltaX: 0, deltaMode: 0, preventDefault() {}, stopPropagation() {} });
    assert.ok(modalApp.datasetDiagViewport.scale > 1.17 && modalApp.datasetDiagViewport.scale < 1.20);
    modalApp.datasetDiagViewport.reset(true);
    assert.equal(modalApp.datasetDiagViewport.animating, true);
    vpRafQueue.shift()(0);
    vpRafQueue.shift()(100);
    assert.equal(modalApp.datasetDiagViewport.animating, false);
    assert.equal(modalApp.datasetDiagViewport.scale, 1);

    // Modal footer omits Copy Path and retains Open Original & Tag Editor
    const footEl = { innerHTML: '' };
    withMockEnv({
      document: { getElementById: id => (id === 'datasetDiagModal' ? {} : id === 'datasetDiagModalFoot' ? footEl : null) },
    }, () => {
      a.datasetDiagModalOpen = true;
      a.datasetDiagModalImageId = 'aaaaaaaaaaaaaaaa';
      a.datasetDiagModalDetail = {
        ...linkedDetail,
        image: { ...linkedDetail.image, preview_url: '/preview/bad.png' },
        caption: { exists: true, editor_safe: true, text: '1girl' },
        file_info: { exists: true, abs_path: 'D:/ds/char/bad.png', width: 768, height: 1024, size: 1024 },
      };
      window.monitorRenderMixin._patchDatasetDiagModal.call(a);
      assert.ok(!footEl.innerHTML.includes('ddCopyPath'));
      assert.ok(footEl.innerHTML.includes('href="/preview/bad.png"'));
      assert.ok(footEl.innerHTML.includes('openDatasetDiagInTagEditor()'));
    });
  });
});

test('live polling uses 6s cadence, computes sample deltas, and reconciles scatter dots in-place', async () => {
  const scheduledDelays = [];
  let payload = { ...structuredClone(SAMPLE_DATA), revision: 'rev1' };
  await withMockEnv({
    setTimeout: (_fn, ms) => { scheduledDelays.push(ms); return 999; },
    clearTimeout: () => {},
    fetch: async () => response(payload),
  }, async () => {
    const app = makeApp({
      currentRoute: 'monitor-dashboard', monitorTab: 'dataset', selectedRunDir: '',
      liveTaskId: 'task-live', monitorData: { state: 'RUNNING' }, _monitorMotionAllowed: () => true,
    });
    await app.loadDatasetDiagnostics();
    assert.ok(scheduledDelays.includes(6000));
    assert.equal(app._datasetDiagUpdatePulseSeq, 0);

    const nextPayload = { ...structuredClone(SAMPLE_DATA), revision: 'rev2' };
    nextPayload.by_image = nextPayload.by_image.map(img => (
      img.image_id === 'aaaaaaaaaaaaaaaa' ? { ...img, count: img.count + 2, comparable_count: img.count + 2, mean_residual: 0.36 } : img
    ));
    payload = nextPayload;
    await app.loadDatasetDiagnostics({ silent: true });
    assert.equal(app._datasetDiagUpdatePulseSeq, 1);
    assert.equal(app._datasetDiagUpdatedIds.has('aaaaaaaaaaaaaaaa'), true);
    assert.equal(app._datasetDiagUpdatedIds.has('bbbbbbbbbbbbbbbb'), false);

    const dotA = makeEl('circle', { class: 'm-dd-dot is-alert', 'data-dd-image-id': 'aaaaaaaaaaaaaaaa' });
    const dotC = makeEl('circle', { class: 'm-dd-dot', 'data-dd-image-id': 'cccccccccccccccc' });
    const dotsGroup = makeEl('g');
    dotsGroup.children.push(dotA, dotC);
    const trailsGroup = makeEl('g');
    const pulsesGroup = makeEl('g');
    const fakeSvg = makeEl('svg');
    fakeSvg.querySelector = sel => (sel === '.m-dd-dots' ? dotsGroup : sel === '.m-dd-trails' ? trailsGroup : sel === '.m-dd-pulses' ? pulsesGroup : null);
    const wrap = { _ddLastPulseSeq: 0, _ddLastTrailSeq: 0, _ddPrevDotCoords: new Map([['aaaaaaaaaaaaaaaa', { cx: 360, cy: 140 }], ['cccccccccccccccc', { cx: 200, cy: 190 }]]) };

    withMockEnv({
      document: { createElementNS: (_ns, tag) => makeEl(tag) },
      requestAnimationFrame: undefined,
    }, () => {
      app._ddReconcileScatterDots(fakeSvg, wrap, [
        { image_id: 'aaaaaaaaaaaaaaaa', idx: 0, cx: 410.5, cy: 120.2, r: 4.5, fill: 'var(--danger)', status: 'attention', cls: 'm-dd-dot is-alert' },
        { image_id: 'bbbbbbbbbbbbbbbb', idx: 1, cx: 320.0, cy: 200.0, r: 4.0, fill: 'var(--success)', status: 'learning', cls: 'm-dd-dot' },
        { image_id: 'cccccccccccccccc', idx: 2, cx: 230.0, cy: 190.0, r: 4.0, fill: 'var(--warning)', status: 'normal', cls: 'm-dd-dot' },
      ], { animate: true, updatedIds: app._datasetDiagUpdatedIds, pulseSeq: app._datasetDiagUpdatePulseSeq });
      assert.equal(dotsGroup.children[0], dotA);
      assert.equal(dotA.attrs.cx, '410.5');
      assert.equal(pulsesGroup.children.length, 1);
      assert.equal(trailsGroup.children.length, 1);
      assert.equal(trailsGroup.children[0].attrs['data-dd-image-id'], 'aaaaaaaaaaaaaaaa');
    });
  });
});

// ── High-Value Regression & Boundary Tests ────────────────────────────────────

test('samples modal filter buttons sync .active, aria-pressed, and delegated click without inline onclick', () => {
  const filterEl = makeEl('div');
  const bodyEl = makeEl('div');
  const titleEl = makeEl('strong');
  const metaEl = makeEl('span');
  const sepEl = makeEl('span');
  const winEl = makeEl('div');

  const app = makeApp({
    datasetDiagModalOpen: true,
    datasetDiagSamplesModalOpen: true,
    datasetDiagModalDetail: {
      image: { image_id: 'nan1', name: 'nan.png', non_finite_count: 1 },
      samples_total: 2,
      samples: [
        { epoch: 1, step: 10, timestep: 0.4, loss: 0.25, residual: 0.1, non_finite: false },
        { epoch: 2, step: 20, timestep: 0.8, loss: null, residual: null, non_finite: true },
      ],
    },
  });

  withMockEnv({
    document: {
      querySelector: sel => (sel === '#datasetDiagSamplesModal .m-dd-samples-window' ? winEl : null),
      getElementById: id => ({
        datasetDiagSamplesTitle: titleEl,
        datasetDiagSamplesMeta: metaEl,
        datasetDiagSamplesFilter: filterEl,
        datasetDiagSamplesSep: sepEl,
        datasetDiagSamplesBody: bodyEl,
      })[id] || null,
    },
  }, () => {
    app.setDatasetDiagSamplesFilter('nan');
    assert.ok(!filterEl.innerHTML.includes('onclick='), 'Filter buttons must not use inline onclick handlers');
    const btns = filterEl.querySelectorAll('[data-dd-samples-filter]');
    assert.equal(btns.length, 2);
    const allBtn = btns.find(b => b.dataset.ddSamplesFilter === 'all');
    const nanBtn = btns.find(b => b.dataset.ddSamplesFilter === 'nan');
    assert.equal(allBtn.classList.contains('active'), false);
    assert.equal(allBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(nanBtn.classList.contains('active'), true);
    assert.equal(nanBtn.getAttribute('aria-pressed'), 'true');

    // Delegated click switches back to 'all' and updates .active + aria-pressed
    filterEl.emit('click', { target: { closest: sel => (sel === '[data-dd-samples-filter]' ? allBtn : null) } });
    assert.equal(app.datasetDiagSamplesFilter, 'all');
    const btnsAfter = filterEl.querySelectorAll('[data-dd-samples-filter]');
    assert.equal(btnsAfter.find(b => b.dataset.ddSamplesFilter === 'all').classList.contains('active'), true);
    assert.equal(btnsAfter.find(b => b.dataset.ddSamplesFilter === 'all').getAttribute('aria-pressed'), 'true');
    assert.equal(btnsAfter.find(b => b.dataset.ddSamplesFilter === 'nan').classList.contains('active'), false);
    assert.equal(btnsAfter.find(b => b.dataset.ddSamplesFilter === 'nan').getAttribute('aria-pressed'), 'false');
  });
});

test('1s live push updates dashboard in-place without full SVG rebuild or interrupting active scatter animations', () => {
  const analysisSlot = makeEl('div');
  const headingSlot = makeEl('div');
  const imagesSlot = makeEl('div');
  const shell = {
    querySelector: sel => ({
      '[data-dd-slot="heading"]': headingSlot,
      '[data-dd-slot="analysis"]': analysisSlot,
      '[data-dd-slot="images"]': imagesSlot,
    })[sel] || null,
  };
  const panel = makeEl('div');
  panel.dataset = { tab: 'dataset' };
  panel.querySelector = sel => (sel === '[data-dd-shell="1"]' ? shell : null);
  Object.defineProperty(panel, 'firstElementChild', { get: () => shell });
  const contentEl = {
    querySelectorAll: () => [panel],
    querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null),
  };

  let scatterRenderCalls = 0;
  let filterSyncCalls = 0;
  const app = makeApp({
    _builtTab: 'dataset',
    runDetailData: {},
    _datasetDiagSourceKey: 'run:output/demo',
    _datasetDiagLoaded: true,
    datasetDiagData: structuredClone(SAMPLE_DATA),
    _renderDatasetDiagHeading: () => '<div class="m-dd-topbar"></div>',
    _renderDatasetDiagAnalysisCard: () => {
      scatterRenderCalls += 1;
      return '<div data-dd-analysis><div data-dd-hero-wrap data-mode="quadrant"></div></div>';
    },
    _bindDatasetDiagCharts() {},
  });

  // Prime DOM with shell + initial analysis
  withMockEnv({
    document: {
      activeElement: null,
      getElementById: id => (id === 'monitorTabContent' ? contentEl : null),
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null),
    },
  }, () => {
    const analysisEl = { dataset: {} };
    const scatterWrap = makeEl('div');
    scatterWrap.dataset = { mode: 'quadrant' };
    analysisSlot.querySelector = sel => (sel === '[data-dd-analysis]' ? analysisEl : sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? scatterWrap : null);
    headingSlot.querySelector = () => null;

    // Override _syncDatasetDiagScatterFilter to count calls
    app._syncDatasetDiagScatterFilter = () => { filterSyncCalls += 1; };

    app._renderTab('dataset', {}, null, null, k => app.tMonitor(k), true);
    assert.equal(scatterRenderCalls, 1);
    assert.equal(filterSyncCalls, 1);

    // 1s live push bumps snapshot version -> patches in-place without rebuilding analysisCard DOM
    app.datasetDiagData = {
      ...structuredClone(SAMPLE_DATA),
      summary: { ...SAMPLE_DATA.summary, samples: 35 },
    };
    app._datasetDiagSnapshotVersion += 1;
    app._renderTab('dataset', {}, null, null, k => app.tMonitor(k), true);
    assert.equal(scatterRenderCalls, 1, 'Live snapshot push must patch in-place without rebuilding analysis HTML');

    // Active scatter zoom/choreo rAF suppresses filter sync so animation is never interrupted
    scatterWrap._ddZoomAnimRaf = 42;
    const prevSyncCalls = filterSyncCalls;
    app.datasetDiagPreset = 'attention';
    app._renderTab('dataset', {}, null, null, k => app.tMonitor(k), true);
    assert.equal(filterSyncCalls, prevSyncCalls, 'Active scatter rAF must suppress _syncDatasetDiagScatterFilter');
  });
});

test('folder grouping beyond 120-image display limit preserves subsequent folder headers and updates remaining counts', () => {
  const imagesA = Array.from({ length: 130 }, (_, i) => ({
    image_id: `a_${i}`, name: `a_${i}.png`, image: `D:/ds/a/a_${i}.png`,
    directory: 'D:/ds/a', dir_label: 'ds/a', subset: '0-0', subset_label: 'folder_a',
    is_reg: false, count: 6, comparable_count: 6, mean_residual: 0.4 - i * 0.001, slope: 0.01, status: 'attention',
  }));
  const imagesB = Array.from({ length: 20 }, (_, i) => ({
    image_id: `b_${i}`, name: `b_${i}.png`, image: `D:/ds/b/b_${i}.png`,
    directory: 'D:/ds/b', dir_label: 'ds/b', subset: '0-1', subset_label: 'folder_b',
    is_reg: false, count: 6, comparable_count: 6, mean_residual: 0.1, slope: -0.01, status: 'normal',
  }));
  const data = {
    ...structuredClone(SAMPLE_DATA),
    summary: { ...SAMPLE_DATA.summary, images_total: 150, has_reg_images: false },
    by_directory: [
      { key: 'D:/ds/a', label: 'ds/a', full_path: 'D:/ds/a', count: 780, images: 130, mean_residual: 0.3 },
      { key: 'D:/ds/b', label: 'ds/b', full_path: 'D:/ds/b', count: 120, images: 20, mean_residual: 0.1 },
    ],
    by_subset: [
      { key: '0-0', label: 'folder_a', is_reg: false, count: 780, images: 130, mean_residual: 0.3 },
      { key: '0-1', label: 'folder_b', is_reg: false, count: 120, images: 20, mean_residual: 0.1 },
    ],
    by_image: [...imagesA, ...imagesB],
  };

  const app = makeApp({ datasetDiagData: data, datasetDiagSubTab: 'images', datasetDiagGroupByFolder: true, datasetDiagDisplayLimit: 120 });
  const bodyHtml = app._renderDatasetDiagImagesBodyHtml(k => app.tMonitor(k), data);
  assert.equal((bodyHtml.match(/class="m-dd-folder-group"/g) || []).length, 2, 'Subsequent folder header beyond 120 limit must stay rendered');
  assert.ok(bodyHtml.includes('data-dd-folder-group="D:/ds/b"'));
  assert.ok(bodyHtml.includes('120 / 130'));
  assert.ok(bodyHtml.includes('data-dd-more-row'));
  assert.equal((bodyHtml.match(/class="m-dd-card"/g) || []).length, 120);

  const slices = app._ddComputeGroupedSlices(app._datasetDiagFilteredImages(), 120);
  assert.equal(slices.hasMore, true);
  assert.equal(slices.remaining, 30);
  assert.equal(slices.slices[0].visibleItems.length, 120);
  assert.equal(slices.slices[1].visibleItems.length, 0);
});

test('SDXL profile defaults to uniform theoretical curve and applies is_reg subset timestep_offset', () => {
  const a = makeApp({ datasetDiagData: SAMPLE_DATA });
  const bins18 = Array.from({ length: 18 }, (_, i) => {
    const bin = 17 - i;
    return {
      bin, tFrom: bin * (1000 / 18), tTo: (bin + 1) * (1000 / 18), count: 5, comparable: true, mean_loss: 0.2, excluded: false,
    };
  });
  const noExcl = { minT: 0, maxT: 1000, hasMin: false, hasMax: false };

  // SDXL with empty sampling_config defaults to uniform theoretical shares (~1/18 per bin)
  const sdxlShares = a._ddComputeTheoreticalBinShares({ profile: 'sdxl-lora', by_subset: [] }, bins18, noExcl);
  assert.ok(Array.isArray(sdxlShares) && sdxlShares.length === 18);
  for (const s of sdxlShares) {
    assert.ok(Math.abs(s - 1 / 18) < 1e-3, `Expected uniform ~0.0556 share for SDXL, got ${s}`);
  }

  // is_reg subset with timestep_offset MUST shift theoretical sampling mass (sd-scripts reads offset regardless of is_reg)
  const sumHigh = shares => shares.slice(0, 6).reduce((acc, v) => acc + v, 0);
  const sigBase = a._ddComputeTheoreticalBinShares({
    profile: 'anima-lora',
    sampling_config: { timestep_sampling: 'sigmoid', sigmoid_scale: 1.0 },
    by_subset: [{ key: '0-0', count: 50, is_reg: false }, { key: '0-1', count: 50, is_reg: true }],
  }, bins18, noExcl);
  const sigRegOffset = a._ddComputeTheoreticalBinShares({
    profile: 'anima-lora',
    sampling_config: { timestep_sampling: 'sigmoid', sigmoid_scale: 1.0 },
    by_subset: [{ key: '0-0', count: 50, is_reg: false }, { key: '0-1', count: 50, is_reg: true, timestep_offset: 1.2 }],
  }, bins18, noExcl);
  assert.ok(sumHigh(sigRegOffset) > sumHigh(sigBase) + 0.05, 'is_reg subset timestep_offset must apply to theoretical curve');
});

test('0-sample datasets and all-NaN images render safely without NaN/Infinity coordinates or errors', () => {
  const zeroData = {
    available: true,
    profile: 'anima-lora',
    run_id: 'r0',
    timestep_scale: 'unit',
    thresholds: { min_count: 3, high_residual: 0.2, low_residual: -0.2, converging_slope: -0.02 },
    summary: { samples: 0, non_finite_total: 0, images_total: 0, images_qualified: 0, has_slope: true, counts: {} },
    by_image: [],
    by_timestep: [],
    by_resolution: [],
    by_subset: [],
    by_directory: [],
  };
  const zeroApp = makeApp({ datasetDiagData: zeroData });
  const q0 = makeWrapStage('quadrant');
  zeroApp._renderDatasetDiagHeroSvg(q0.wrap, q0.stage, q0.svg);
  assert.ok(q0.svg.innerHTML.includes(zeroApp.tMonitor('ddNoQuadrantPoints')));

  const noSlopeZeroApp = makeApp({ datasetDiagData: { ...zeroData, summary: { ...zeroData.summary, has_slope: false } } });
  const qNoSlope = makeWrapStage('quadrant');
  noSlopeZeroApp._renderDatasetDiagHeroSvg(qNoSlope.wrap, qNoSlope.stage, qNoSlope.svg);
  assert.ok(qNoSlope.svg.innerHTML.includes(noSlopeZeroApp.tMonitor('ddNoReferencePoints')));

  const ts0 = makeWrapStage('timestep');
  zeroApp._renderDatasetDiagHeroSvg(ts0.wrap, ts0.stage, ts0.svg);
  assert.ok(ts0.svg.innerHTML.includes(zeroApp.tMonitor('ddTimestepOverlayEmpty')));
  assert.equal(zeroApp._renderDatasetDiagGroupsCard(k => zeroApp.tMonitor(k), zeroData), '');
  assert.ok(zeroApp._renderDatasetDiagImagesBodyHtml(k => zeroApp.tMonitor(k), zeroData).includes(zeroApp.tMonitor('ddNoMatchingImages')));

  // All-NaN image + dataset renders safely with no NaN/Infinity coordinates
  const allNanData = {
    ...structuredClone(zeroData),
    summary: { samples: 0, non_finite_total: 4, images_total: 1, images_qualified: 0, has_slope: false, counts: { non_finite: 1 } },
    by_image: [{
      image_id: 'nan_only', image: 'D:/ds/nan_only.png', name: 'nan_only.png',
      resolution: '1024x1024', subset: '0-0', is_reg: false,
      count: 0, comparable_count: 0, non_finite_count: 4, epochs: 2,
      mean_loss: null, mean_residual: null, slope: null, status: 'non_finite',
    }],
  };
  const nanApp = makeApp({ datasetDiagData: allNanData });
  const nanOverview = nanApp._renderDatasetDiagTab(k => nanApp.tMonitor(k));
  assert.ok(!nanOverview.includes('NaN%') && !nanOverview.includes('Infinity'));
  const nanDetail = {
    run_id: 'r0',
    timestep_scale: 'unit',
    image: allNanData.by_image[0],
    epoch_series: [{ epoch: 1, count: 0, mean_residual: null, mean_loss: null, non_finite_count: 4 }],
    samples: [{ step: 1, epoch: 1, timestep: 0.5, loss: null, residual: null, non_finite: true }],
    caption: { exists: false },
    file_info: { exists: true },
  };
  const nanRight = nanApp._renderDatasetDiagModalRightHtml(k => nanApp.tMonitor(k), nanDetail);
  assert.ok(nanRight.includes('m-dd-nan-row'));
  const tsModalSvg = makeEl('svg');
  const tsModalStage = makeEl('div');
  nanApp._renderDatasetDiagModalTimestepSvg(tsModalStage, tsModalSvg, nanDetail, k => nanApp.tMonitor(k));
  assert.ok(!tsModalSvg.innerHTML.includes('cx="NaN"') && !tsModalSvg.innerHTML.includes('cy="NaN"'));
  assert.ok(tsModalSvg.innerHTML.includes('m-dd-nan-lane'));
});

test('malicious filenames, directory paths, and captions are escaped across cards, table, groups, and modal', () => {
  const xssName = 'bad"><script>alert(1)</script>\'.png';
  const xssDir = 'D:/ds/<img src=x onerror="alert(2)">\'dir';
  const xssCap = '<script>steal()</script> & "quoted"';
  const xssImg = {
    image_id: 'id\'"><script>',
    image: `${xssDir}/${xssName}`,
    name: xssName,
    directory: xssDir,
    dir_label: '<svg onload=alert(3)>',
    resolution: '1024x1024',
    subset: '0-0\'"><b/>',
    subset_label: '<b onclick="xss()">sub</b>',
    is_reg: false,
    count: 5,
    comparable_count: 5,
    non_finite_count: 0,
    epochs: 2,
    mean_loss: 0.3,
    mean_residual: 0.25,
    slope: -0.01,
    status: 'attention',
    thumb_url: '/api/image-preview?path=x" onclick="alert(4)',
  };
  const xssData = {
    ...structuredClone(SAMPLE_DATA),
    summary: { ...SAMPLE_DATA.summary, images_total: 1, has_reg_images: false },
    by_directory: [
      { key: xssDir, label: '<img onerror=1>', full_path: xssDir, count: 5, comparable_count: 5, images: 1, mean_residual: 0.25 },
      { key: 'D:/safe', label: 'safe', full_path: 'D:/safe', count: 5, comparable_count: 5, images: 1, mean_residual: 0.0 },
    ],
    by_subset: [
      { key: xssImg.subset, label: xssImg.subset_label, is_reg: false, count: 5, comparable_count: 5, images: 1, mean_residual: 0.25 },
      { key: '0-1', label: 'safe', is_reg: false, count: 5, comparable_count: 5, images: 1, mean_residual: 0.0 },
    ],
    by_image: [xssImg],
  };

  const app = makeApp({ datasetDiagData: xssData });
  const outputs = [
    app._ddImageCardHtml(k => app.tMonitor(k), xssImg),
    app._ddImageTableRowHtml(k => app.tMonitor(k), xssImg, 0.5),
    app._renderDatasetDiagGroupsCard(k => app.tMonitor(k), xssData),
    app._renderDatasetDiagModalRightHtml(k => app.tMonitor(k), {
      run_id: 'r1',
      timestep_scale: 'unit',
      image: xssImg,
      epoch_series: [],
      samples: [{ step: 1, epoch: 1, timestep: 0.5, loss: 0.3, residual: 0.25 }],
      caption: { exists: true, filename: xssName + '.txt', text: xssCap, path: xssDir + '/a.txt', editor_safe: false },
      file_info: { exists: true, abs_path: xssImg.image, dir_path: xssDir },
    }),
    app._renderDatasetDiagSamplesBodyHtml(k => app.tMonitor(k), {
      timestep_scale: 'unit',
      samples: [{ step: 1, epoch: 1, timestep: 0.5, loss: 0.3, residual: 0.25 }],
    }, 'all'),
  ];

  for (const html of outputs) {
    assert.ok(!html.includes('<script>'), 'Unescaped <script> tag found');
    assert.ok(!html.includes('<img src=x'), 'Unescaped <img src=x found');
    assert.ok(!html.includes('<svg onload='), 'Unescaped <svg onload= found');
    assert.ok(!html.includes('" onclick="alert(4)'), 'Attribute breakout via double quote found');
  }
  assert.ok(outputs[0].includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(outputs[3].includes('&lt;script&gt;steal()&lt;/script&gt; &amp; &quot;quoted&quot;'));
});

test('grouped noise summary uses group series for resolution/subset and flux_shift uses joint resolution_offsets', () => {
  const a = makeApp();
  const bins = Array.from({ length: 18 }, (_, b) => ({
    bin: b,
    t_from: b * (1000 / 18),
    t_to: (b + 1) * (1000 / 18),
    count: 100,
    images: 5,
    comparable: true,
    mean_loss: 0.2,
  }));
  const multiResoData = {
    ...structuredClone(SAMPLE_DATA),
    profile: 'anima-lora',
    timestep_scale: 'unit',
    sampling_config: { timestep_sampling: 'flux_shift' },
    by_resolution: [
      { key: '512x512', label: '512x512', count: 50, images: 1, mean_loss: 0.2 },
      { key: '1536x1536', label: '1536x1536', count: 50, images: 1, mean_loss: 0.2 },
    ],
    by_subset: [
      { key: '0-0', label: 'low_sub', count: 50, images: 1, timestep_offset: -2.0 },
      { key: '0-1', label: 'high_sub', count: 50, images: 1, timestep_offset: 2.0 },
    ],
    by_image: [
      {
        image_id: 'shared1',
        name: 'shared.png',
        resolution: '1536x1536',
        resolutions: ['512x512', '1536x1536'],
        subset: '0-1',
        subsets: ['0-0', '0-1'],
        noise_zones: {
          high: { count: 9, comparable_count: 9, mean_residual: 0.5 },
          mid: { count: 0, comparable_count: 0, mean_residual: null },
          low: { count: 1, comparable_count: 1, mean_residual: 0.0 },
        },
      },
    ],
    timestep_profile: {
      num_bins: 18,
      bins,
      by_status: {},
      by_group: {
        resolution: {
          '512x512': {
            counts: [1, ...new Array(17).fill(0)],
            mean_loss: [0.2, ...new Array(17).fill(null)],
          },
        },
      },
      resolution_offsets: [
        { resolution: '512,512', offset: -2.0, count: 50 },
        { resolution: '1536,1536', offset: 2.0, count: 50 },
      ],
    },
  };

  // Grouping summary prefers backend 10-bin series.noise_zones over 18-bin plotting fallback
  const comp = {
    kind: 'group',
    dim: 'resolution',
    key: '512x512',
    label: '512x512',
    images: multiResoData.by_image,
    series: multiResoData.timestep_profile.by_group.resolution['512x512'],
    tone: 'accent',
  };
  const zonesWithSeriesNoise = a._ddComputeComparisonZones(multiResoData, {
    ...comp,
    series: {
      ...comp.series,
      noise_zones: {
        high: null,
        mid: { count: 1, comparable_count: 1, mean_residual: 0.5 },
        low: null,
      },
    },
  });
  assert.equal(zonesWithSeriesNoise.mid.count, 1);
  assert.equal(zonesWithSeriesNoise.mid.comparable_count, 1);
  assert.equal(zonesWithSeriesNoise.mid.mean_residual, 0.5);
  assert.equal(zonesWithSeriesNoise.high.count, 0);

  // Fallback when series.noise_zones is absent still counts only the group's 18-bin samples
  const zones = a._ddComputeComparisonZones(multiResoData, comp);
  assert.equal(zones.low.count, 1);
  assert.equal(zones.high.count, 0);

  // Pure-NaN group (omitted from by_group, so series is null) must stay 0 / null instead of falling back to comp.images
  const nanGroupZones = a._ddComputeComparisonZones(multiResoData, {
    kind: 'group',
    dim: 'resolution',
    key: '768x768',
    label: '768x768',
    images: multiResoData.by_image,
    series: null,
    tone: 'accent',
  });
  assert.deepEqual(nanGroupZones, {
    high: { count: 0, comparable_count: 0, mean_residual: null },
    mid: { count: 0, comparable_count: 0, mean_residual: null },
    low: { count: 0, comparable_count: 0, mean_residual: null },
  });

  // Theoretical flux_shift curve with joint resolution_offsets differs from independent marginal fallback
  const normedBins = bins.map(b => ({ ...b, tFrom: b.t_from, tTo: b.t_to, excluded: false }));
  const jointShares = a._ddComputeTheoreticalBinShares(multiResoData, normedBins, null);
  const marginalData = structuredClone(multiResoData);
  delete marginalData.timestep_profile.resolution_offsets;
  const marginalShares = a._ddComputeTheoreticalBinShares(marginalData, normedBins, null);
  assert.ok(Array.isArray(jointShares) && jointShares.length === 18);
  assert.ok(Math.abs(jointShares[17] - marginalShares[17]) > 0.05);

  // Pure-reg fallback (reg_mode='all' while stored preference datasetDiagRegMode='exclude') displays effective reg_mode in selects
  const pureRegData = {
    ...structuredClone(SAMPLE_DATA),
    reg_mode: 'all',
    summary: { ...SAMPLE_DATA.summary, has_reg_images: true },
  };
  const pureRegApp = makeApp({
    datasetDiagData: pureRegData,
    datasetDiagRegMode: 'exclude',
    datasetDiagEffectiveRegMode: 'all',
  });
  const topHtml = pureRegApp._renderDatasetDiagHeading(k => pureRegApp.tMonitor(k), pureRegData);
  const toolbarHtml = pureRegApp._renderDatasetDiagImagesToolbar(k => pureRegApp.tMonitor(k), pureRegData);
  assert.ok(topHtml.includes(':value="_datasetDiagEffectiveRegMode()"'));
  assert.ok(topHtml.includes('<option value="all" selected>'));
  assert.ok(!toolbarHtml.includes('data-dd-images-reg-wrap'));
});

test('scatter wheel coalesces per frame, uses pure camera path without is-live-motion/layout thrash, and freezes early beeswarm Y during gestures', () => {
  let fakeNow = 2000;
  let rafId = 1;
  const rafQueue = new Map();
  const flushRaf = () => {
    const entries = Array.from(rafQueue.entries());
    rafQueue.clear();
    for (const [, cb] of entries) cb();
  };

  const buildMockScatterDom = (modeKind = 'quadrant') => {
    const bandsGroup = makeEl('g', { 'data-dd-compressed-bands': '' });
    const gridGroup = makeEl('g', { 'data-dd-grid-lines': '' });
    const zoneRects = { attention: makeEl('rect', { 'data-dd-zone-preset': 'attention' }), learning: makeEl('rect', { 'data-dd-zone-preset': 'learning' }) };
    const zonesGroup = makeEl('g', { 'data-dd-zones': '' });
    zonesGroup.appendChild(zoneRects.attention);
    zonesGroup.appendChild(zoneRects.learning);
    const axisXGroup = makeEl('g', { 'data-dd-axis-x-group': '' });
    const axisYGroup = makeEl('g', { 'data-dd-axis-y-group': '' });
    const axisXTicks = makeEl('g', { 'data-dd-axis-x-ticks': '' });
    const axisYTicks = makeEl('g', { 'data-dd-axis-y-ticks': '' });
    const axesGroup = makeEl('g', { class: 'm-chart-axes' });
    const axisOrigin = makeEl('g', { 'data-dd-axis-origin': '' });
    axisOrigin.appendChild(makeEl('text'));
    const labelsGroup = makeEl('g', { class: 'm-dd-quad-labels' });
    const dotsGroup = makeEl('g', { class: 'm-dd-dots' });
    const pulsesGroup = makeEl('g', { class: 'm-dd-pulses' });
    const trailsGroup = makeEl('g', { class: 'm-dd-trails' });
    const historyGroup = makeEl('g', { 'data-dd-history': '' });
    const crosshair = makeEl('g', { 'data-dd-crosshair': '' });
    const focusRing = makeEl('circle', { 'data-dd-dot-focus': '' });
    const tether = makeEl('line', { 'data-dd-pin-tether': '' });

    let svgRectReads = 0;
    let liveMotionAdds = 0;
    const svg = makeEl('svg', {
      'data-dd-svg-kind': modeKind,
      'data-dd-svg-width': '700',
      'data-dd-svg-height': '436',
    });
    const origAdd = svg.classList.add;
    svg.classList.add = (...cs) => {
      if (cs.includes('is-live-motion')) liveMotionAdds += 1;
      origAdd(...cs);
    };
    svg.getBoundingClientRect = () => {
      svgRectReads += 1;
      return { left: 0, top: 0, right: 700, bottom: 436, width: 700, height: 436 };
    };
    const selMap = {
      '.m-dd-dots': dotsGroup,
      '.m-dd-pulses': pulsesGroup,
      '.m-dd-trails': trailsGroup,
      '[data-dd-history]': historyGroup,
      '[data-dd-compressed-bands]': bandsGroup,
      '[data-dd-grid-lines]': gridGroup,
      '[data-dd-zones]': zonesGroup,
      '[data-dd-axis-x-group]': axisXGroup,
      '[data-dd-axis-y-group]': axisYGroup,
      '[data-dd-axis-x-ticks]': axisXTicks,
      '[data-dd-axis-y-ticks]': axisYTicks,
      '.m-chart-axes': axesGroup,
      '[data-dd-axis-origin]': axisOrigin,
      '.m-dd-quad-labels': labelsGroup,
      '[data-dd-crosshair]': crosshair,
      '[data-dd-dot-focus]': focusRing,
      '[data-dd-pin-tether]': tether,
    };
    svg.querySelector = sel => selMap[sel] || null;

    const stage = makeEl('div');
    stage.clientWidth = 700;
    stage.clientHeight = 440;
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 440, width: 700, height: 440 });
    const resetBtn = { hidden: true, closest: () => null };
    const wrap = makeEl('div');
    wrap.dataset = { mode: 'quadrant' };
    wrap.querySelector = sel => ({
      '[data-dd-hero-stage]': stage,
      '[data-dd-hero-svg]': svg,
      '[data-dd-zoom-reset]': resetBtn,
    })[sel] || null;
    const panel = makeEl('div');
    panel.querySelectorAll = sel => (sel === '[data-dd-hero-wrap]' ? [wrap] : []);
    panel.querySelector = sel => (sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? wrap : null);
    return {
      panel, wrap, stage, svg, dotsGroup, gridGroup, axisXTicks, labelsGroup, resetBtn,
      getCounters: () => ({ svgRectReads, liveMotionAdds }),
      resetCounters: () => { svgRectReads = 0; liveMotionAdds = 0; },
    };
  };

  // 1. Quadrant wheel coalescing + pure camera path + continuous retargeting
  const qDom = buildMockScatterDom('quadrant');
  withMockEnv({
    document: {
      createElementNS: (_ns, tag) => makeEl(tag),
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? qDom.panel : null),
      addEventListener() {},
      removeEventListener() {},
    },
    performance: { now: () => fakeNow },
    requestAnimationFrame: cb => { const id = rafId++; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame: id => rafQueue.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
  }, () => {
    const app = makeApp({ datasetDiagData: SAMPLE_DATA, _monitorMotionAllowed: () => true });
    app._bindDatasetDiagCharts(qDom.panel);
    // Prime dot nodes as real DOM would have after initial render
    for (const img of SAMPLE_DATA.by_image) {
      qDom.dotsGroup.appendChild(makeEl('circle', { class: 'm-dd-dot', 'data-dd-image-id': img.image_id, cx: '350.0', cy: '220.0' }));
    }
    qDom.wrap._ddSvgRefs = null;
    qDom.wrap._ddDotBindings = null;
    qDom.resetCounters();

    let heroRenderCalls = 0;
    let reconcileCalls = 0;
    let filterCalls = 0;
    let setZoomCalls = 0;
    const origHero = app._renderDatasetDiagHeroSvg.bind(app);
    const origReconcile = app._ddReconcileScatterDots.bind(app);
    const origFilter = app._syncDatasetDiagScatterFilter.bind(app);
    const origSetZoom = app.setDatasetDiagScatterZoom.bind(app);
    app._renderDatasetDiagHeroSvg = (...args) => { heroRenderCalls++; return origHero(...args); };
    app._ddReconcileScatterDots = (...args) => { reconcileCalls++; return origReconcile(...args); };
    app._syncDatasetDiagScatterFilter = (...args) => { filterCalls++; return origFilter(...args); };
    app.setDatasetDiagScatterZoom = (...args) => { setZoomCalls++; return origSetZoom(...args); };

    // Emit 3 wheel events within the same frame -> must coalesce into ONE setDatasetDiagScatterZoom
    let prevented = 0;
    const mkWheel = dy => ({ deltaY: dy, deltaX: 0, deltaMode: 0, clientX: 350, clientY: 220, preventDefault() { prevented++; } });
    qDom.stage.emit('wheel', mkWheel(-100));
    qDom.stage.emit('wheel', mkWheel(-100));
    qDom.stage.emit('wheel', mkWheel(-100));
    assert.equal(prevented, 3);
    assert.equal(setZoomCalls, 0, 'Wheel events must coalesce until rAF flush');

    flushRaf();
    assert.equal(setZoomCalls, 1, 'Coalesced wheel batch triggers a single setDatasetDiagScatterZoom');
    assert.equal(heroRenderCalls, 0, 'Pure camera update must bypass _renderDatasetDiagHeroSvg');
    assert.equal(reconcileCalls, 0, 'Pure camera update must bypass _ddReconcileScatterDots');
    assert.equal(filterCalls, 0, 'Pure camera update must bypass _syncDatasetDiagScatterFilter');
    assert.equal(qDom.resetBtn.hidden, false);
    assert.equal(qDom.stage.classList.contains('is-zoomed'), true);
    assert.equal(qDom.svg.classList.contains('is-camera-anim'), true);
    assert.equal(qDom.svg.classList.contains('is-live-motion'), false);
    assert.deepEqual(qDom.getCounters(), { svgRectReads: 0, liveMotionAdds: 0 });

    const firstToken = qDom.wrap._ddZoomAnimToken;
    const firstZoom = structuredClone(app.datasetDiagScatterZoom);

    // Step 1 frame (16ms), then send another wheel event -> must retarget continuously without restarting animation
    fakeNow += 16;
    flushRaf();
    const midCam1 = qDom.wrap._ddCurrentCamEval();
    assert.ok(midCam1.xMin > qDom.wrap._ddAutoBounds.xMin);

    qDom.stage.emit('wheel', mkWheel(-100));
    flushRaf();
    assert.equal(setZoomCalls, 2);
    assert.equal(qDom.wrap._ddZoomAnimToken, firstToken, 'Continuous wheel retargeting must not restart camera animation');
    assert.ok(app.datasetDiagScatterZoom.xMax - app.datasetDiagScatterZoom.xMin < firstZoom.xMax - firstZoom.xMin);
    assert.equal(heroRenderCalls, 0);
    assert.equal(reconcileCalls, 0);
    assert.equal(filterCalls, 0);
    assert.deepEqual(qDom.getCounters(), { svgRectReads: 0, liveMotionAdds: 0 });

    // Settle exponential damping completely
    fakeNow += 500;
    flushRaf();
    assert.equal(qDom.svg.classList.contains('is-camera-anim'), false);
    assert.equal(reconcileCalls, 0, 'Camera settle must skip _ddReconcileScatterDots');
    assert.equal(filterCalls, 0, 'Camera settle must skip _syncDatasetDiagScatterFilter');
    assert.ok(Math.abs(qDom.wrap._ddCamera.xMin - app.datasetDiagScatterZoom.xMin) < 1e-9);
    assert.deepEqual(qDom.getCounters(), { svgRectReads: 0, liveMotionAdds: 0 });
  });

  // 2. Early 1D beeswarm freezes Y during pan & wheel gestures and reflows once on settle
  const earlyData = structuredClone(SAMPLE_DATA);
  earlyData.summary.has_slope = false;
  const eDom = buildMockScatterDom('early');
  withMockEnv({
    document: {
      createElementNS: (_ns, tag) => makeEl(tag),
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? eDom.panel : null),
      addEventListener() {},
      removeEventListener() {},
    },
    performance: { now: () => fakeNow },
    requestAnimationFrame: cb => { const id = rafId++; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame: id => rafQueue.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
  }, () => {
    const app = makeApp({ datasetDiagData: earlyData, _monitorMotionAllowed: () => true });
    app._bindDatasetDiagCharts(eDom.panel);
    for (const img of earlyData.by_image) {
      const pt = eDom.wrap._ddChartState.coords.find(c => c.image_id === img.image_id);
      eDom.dotsGroup.appendChild(makeEl('circle', {
        class: 'm-dd-dot',
        'data-dd-image-id': img.image_id,
        cx: pt.cx.toFixed(1),
        cy: pt.cy.toFixed(1),
      }));
    }
    eDom.wrap._ddSvgRefs = null;
    eDom.wrap._ddDotBindings = null;

    let beeswarmCalls = 0;
    let reconcileCalls = 0;
    let filterCalls = 0;
    const origBeeswarm = app._ddPlaceEarlyBeeswarm.bind(app);
    const origReconcile = app._ddReconcileScatterDots.bind(app);
    const origFilter = app._syncDatasetDiagScatterFilter.bind(app);
    app._ddPlaceEarlyBeeswarm = (...args) => { beeswarmCalls++; return origBeeswarm(...args); };
    app._ddReconcileScatterDots = (...args) => { reconcileCalls++; return origReconcile(...args); };
    app._syncDatasetDiagScatterFilter = (...args) => { filterCalls++; return origFilter(...args); };

    // Wheel zoom in early mode: freezes Y during animation, reflows once on settle
    eDom.stage.emit('wheel', { deltaY: -120, deltaX: 0, deltaMode: 0, clientX: 350, clientY: 220, preventDefault() {} });
    flushRaf();
    fakeNow += 32;
    flushRaf();
    assert.equal(beeswarmCalls, 0, 'Early wheel animation must freeze Y without running _ddPlaceEarlyBeeswarm');
    fakeNow += 500;
    flushRaf();
    assert.equal(beeswarmCalls, 1, 'Early wheel settle must reflow _ddPlaceEarlyBeeswarm once');
    assert.equal(reconcileCalls, 0);
    assert.equal(filterCalls, 0);

    // Pan in early mode: fast path freezes Y during drag, reflows once on pointerup
    beeswarmCalls = 0;
    eDom.stage.emit('pointerdown', { button: 0, isPrimary: true, pointerId: 1, clientX: 350, clientY: 220, target: eDom.svg });
    eDom.stage.emit('pointermove', { pointerId: 1, buttons: 1, clientX: 310, clientY: 220 });
    flushRaf();
    eDom.stage.emit('pointermove', { pointerId: 1, buttons: 1, clientX: 280, clientY: 220 });
    flushRaf();
    assert.equal(beeswarmCalls, 0, 'Early pan frames must freeze Y without running _ddPlaceEarlyBeeswarm');
    assert.equal(reconcileCalls, 0);
    assert.equal(filterCalls, 0);

    eDom.stage.emit('pointerup', { pointerId: 1, clientX: 280, clientY: 220 });
    assert.equal(beeswarmCalls, 1, 'Early pan finish must reflow _ddPlaceEarlyBeeswarm once');
    assert.equal(reconcileCalls, 0);
    assert.equal(filterCalls, 0);
  });
});

test('pan defers new snapshot until pointerup and reconciles residuals cleanly without stale cache', () => {
  let fakeNow = 3000;
  let rafId = 1;
  const rafQueue = new Map();
  const flushRaf = () => {
    const entries = Array.from(rafQueue.entries());
    rafQueue.clear();
    for (const [, cb] of entries) cb();
  };

  const mkPanDom = () => {
    const bandsGroup = makeEl('g', { 'data-dd-compressed-bands': '' });
    const gridGroup = makeEl('g', { 'data-dd-grid-lines': '' });
    const zoneRects = { attention: makeEl('rect', { 'data-dd-zone-preset': 'attention' }), learning: makeEl('rect', { 'data-dd-zone-preset': 'learning' }) };
    const zonesGroup = makeEl('g', { 'data-dd-zones': '' });
    zonesGroup.appendChild(zoneRects.attention);
    zonesGroup.appendChild(zoneRects.learning);
    const axisXGroup = makeEl('g', { 'data-dd-axis-x-group': '' });
    const axisYGroup = makeEl('g', { 'data-dd-axis-y-group': '' });
    const axisXTicks = makeEl('g', { 'data-dd-axis-x-ticks': '' });
    const axisYTicks = makeEl('g', { 'data-dd-axis-y-ticks': '' });
    const axesGroup = makeEl('g', { class: 'm-chart-axes' });
    const axisOrigin = makeEl('g', { 'data-dd-axis-origin': '' });
    axisOrigin.appendChild(makeEl('text'));
    const labelsGroup = makeEl('g', { class: 'm-dd-quad-labels' });
    const dotsGroup = makeEl('g', { class: 'm-dd-dots' });
    const pulsesGroup = makeEl('g', { class: 'm-dd-pulses' });
    const trailsGroup = makeEl('g', { class: 'm-dd-trails' });
    const historyGroup = makeEl('g', { 'data-dd-history': '' });
    const crosshair = makeEl('g', { 'data-dd-crosshair': '' });
    const focusRing = makeEl('circle', { 'data-dd-dot-focus': '' });
    const tether = makeEl('line', { 'data-dd-pin-tether': '' });
    const svg = makeEl('svg', {
      'data-dd-svg-kind': 'quadrant',
      'data-dd-svg-width': '700',
      'data-dd-svg-height': '436',
    });
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 436, width: 700, height: 436 });
    const selMap = {
      '.m-dd-dots': dotsGroup,
      '.m-dd-pulses': pulsesGroup,
      '.m-dd-trails': trailsGroup,
      '[data-dd-history]': historyGroup,
      '[data-dd-compressed-bands]': bandsGroup,
      '[data-dd-grid-lines]': gridGroup,
      '[data-dd-zones]': zonesGroup,
      '[data-dd-axis-x-group]': axisXGroup,
      '[data-dd-axis-y-group]': axisYGroup,
      '[data-dd-axis-x-ticks]': axisXTicks,
      '[data-dd-axis-y-ticks]': axisYTicks,
      '.m-chart-axes': axesGroup,
      '[data-dd-axis-origin]': axisOrigin,
      '.m-dd-quad-labels': labelsGroup,
      '[data-dd-crosshair]': crosshair,
      '[data-dd-dot-focus]': focusRing,
      '[data-dd-pin-tether]': tether,
    };
    svg.querySelector = sel => selMap[sel] || null;

    const stage = makeEl('div');
    stage.clientWidth = 700;
    stage.clientHeight = 440;
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 440, width: 700, height: 440 });
    const resetBtn = { hidden: true, closest: () => null };
    const wrap = makeEl('div');
    wrap.dataset = { mode: 'quadrant' };
    wrap.querySelector = sel => ({
      '[data-dd-hero-stage]': stage,
      '[data-dd-hero-svg]': svg,
      '[data-dd-zoom-reset]': resetBtn,
    })[sel] || null;
    const panel = makeEl('div');
    panel.querySelectorAll = sel => (sel === '[data-dd-hero-wrap]' ? [wrap] : []);
    panel.querySelector = sel => (sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? wrap : null);
    return { panel, wrap, stage, svg, dotsGroup };
  };

  const makeSnapshot = (rev, residualShift) => ({
    ...structuredClone(SAMPLE_DATA),
    revision: rev,
    summary: { ...SAMPLE_DATA.summary, images_total: 40, images_qualified: 40 },
    by_image: Array.from({ length: 40 }, (_, i) => ({
      image_id: `img_${String(i).padStart(4, '0')}`,
      image: `D:/ds/char/img_${i}.png`,
      name: `img_${i}.png`,
      directory: 'D:/ds/char',
      dir_label: 'ds/char',
      resolution: '768x1024',
      subset: '0-0',
      subset_label: '10_char',
      is_reg: false,
      count: 8,
      comparable_count: 8,
      non_finite_count: 0,
      epochs: 4,
      mean_loss: 0.25,
      mean_residual: -0.35 + i * 0.02 + residualShift,
      slope: -0.05 + (i % 7) * 0.015,
      status: i % 3 === 0 ? 'attention' : (i % 3 === 1 ? 'learning' : 'normal'),
      thumb_url: '',
      preview_url: '',
    })),
  });

  const data1 = makeSnapshot('rev1', 0);
  const data2 = makeSnapshot('rev2', 0.12);
  const dom = mkPanDom();

  withMockEnv({
    document: {
      createElementNS: (_ns, tag) => makeEl(tag),
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? dom.panel : null),
      addEventListener() {},
      removeEventListener() {},
    },
    performance: { now: () => fakeNow },
    requestAnimationFrame: cb => { const id = rafId++; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame: id => rafQueue.delete(id),
    setTimeout: undefined,
    clearTimeout: undefined,
  }, () => {
    const app = makeApp({ datasetDiagData: data1, _monitorMotionAllowed: () => true });
    app._bindDatasetDiagCharts(dom.panel);
    for (const pt of dom.wrap._ddChartState.coords) {
      dom.dotsGroup.appendChild(makeEl('circle', {
        class: pt.cls || 'm-dd-dot',
        'data-dd-image-id': pt.image_id,
        cx: pt.cx.toFixed(1),
        cy: pt.cy.toFixed(1),
        r: pt.r.toFixed(1),
      }));
    }
    dom.wrap._ddDotBindings = null;
    assert.equal(dom.wrap._ddRenderedData, data1);

    // Zoom in so panning is active, then start dragging
    app.setDatasetDiagScatterZoom({ xMin: -0.4, xMax: 0.5, yMin: -0.06, yMax: 0.06 }, { animate: false });
    dom.stage.emit('pointerdown', { button: 0, isPrimary: true, pointerId: 7, clientX: 350, clientY: 220, target: dom.svg });
    dom.stage.emit('pointermove', { pointerId: 7, buttons: 1, clientX: 310, clientY: 220 });
    flushRaf();
    assert.equal(dom.wrap._ddPan?.active, true);
    assert.equal(dom.stage.classList.contains('is-panning'), true);

    // New snapshot arrives mid-pan (via render path + pan move) -> deferred without jumping dots
    app.datasetDiagData = data2;
    app._renderDatasetDiagHeroSvg(dom.wrap, dom.stage, dom.svg, { animate: true });
    assert.equal(dom.wrap._ddPendingDataRefresh, true);
    assert.equal(dom.wrap._ddRenderedData, data1);
    assert.equal(dom.wrap._ddDotBindings.data, data1);

    dom.stage.emit('pointermove', { pointerId: 7, buttons: 1, clientX: 280, clientY: 220 });
    flushRaf();
    assert.equal(dom.wrap._ddPendingDataRefresh, true);
    assert.equal(dom.wrap._ddRenderedData, data1);

    // Release pan -> pending refresh is consumed immediately with 0 residual/coord mismatches
    dom.stage.emit('pointerup', { pointerId: 7, clientX: 280, clientY: 220 });
    assert.equal(dom.wrap._ddPan, null);
    assert.equal(dom.stage.classList.contains('is-panning'), false);
    assert.equal(dom.wrap._ddPendingDataRefresh, false);
    assert.equal(dom.wrap._ddRenderedData, data2);
    assert.equal(dom.wrap._ddDotBindings.data, data2);

    const byNewId = new Map(data2.by_image.map(p => [p.image_id, p]));
    const st = dom.wrap._ddChartState;
    let mismatches = 0;
    for (const pt of st.coords) {
      const expected = byNewId.get(pt.image_id);
      const dotEl = dom.wrap._ddDotBindings.dotMap.get(pt.image_id);
      if (!expected || !dotEl) { mismatches++; continue; }
      if (Math.abs(pt.mean_residual - expected.mean_residual) > 1e-9) mismatches++;
      if (Math.abs(Number(dotEl.getAttribute('cx')) - st.toX(expected.mean_residual)) > 0.2) mismatches++;
    }
    assert.equal(mismatches, 0, 'All dots must reflect the latest snapshot after pointerup');

    // Non-pan _rerenderDatasetDiagScatter with new data bypasses camera fast path and refreshes autoBounds & bindings
    const data3 = makeSnapshot('rev3', 0.45);
    app.datasetDiagData = data3;
    app._rerenderDatasetDiagScatter({ animate: false });
    assert.equal(dom.wrap._ddRenderedData, data3);
    assert.equal(dom.wrap._ddDotBindings.data, data3);
    assert.ok(dom.wrap._ddAutoBounds.xMax > 0.8);
  });
});

test('wheel zoom animation updates st.liveScale for 4-arg hit testing, hover visuals, and click pinning', () => {
  let fakeNow = 5000;
  let rafId = 1;
  const rafQueue = new Map();
  const flushRaf = () => {
    const entries = Array.from(rafQueue.entries());
    rafQueue.clear();
    for (const [, cb] of entries) cb();
  };

  const bandsGroup = makeEl('g', { 'data-dd-compressed-bands': '' });
  const gridGroup = makeEl('g', { 'data-dd-grid-lines': '' });
  const zoneRects = { attention: makeEl('rect', { 'data-dd-zone-preset': 'attention' }), learning: makeEl('rect', { 'data-dd-zone-preset': 'learning' }) };
  const zonesGroup = makeEl('g', { 'data-dd-zones': '' });
  zonesGroup.appendChild(zoneRects.attention);
  zonesGroup.appendChild(zoneRects.learning);
  const axisXGroup = makeEl('g', { 'data-dd-axis-x-group': '' });
  const axisYGroup = makeEl('g', { 'data-dd-axis-y-group': '' });
  const axisXTicks = makeEl('g', { 'data-dd-axis-x-ticks': '' });
  const axisYTicks = makeEl('g', { 'data-dd-axis-y-ticks': '' });
  const axisOrigin = makeEl('g', { 'data-dd-axis-origin': '' });
  axisOrigin.appendChild(makeEl('text'));
  const labelsGroup = makeEl('g', { class: 'm-dd-quad-labels' });
  const dotsGroup = makeEl('g', { class: 'm-dd-dots' });
  const pulsesGroup = makeEl('g', { class: 'm-dd-pulses' });
  const trailsGroup = makeEl('g', { class: 'm-dd-trails' });
  const historyGroup = makeEl('g', { 'data-dd-history': '' });
  const crosshair = makeEl('g', { 'data-dd-crosshair': '', display: 'none' });
  const chX = makeEl('line', { 'data-dd-ch-x': '' });
  const chY = makeEl('line', { 'data-dd-ch-y': '' });
  crosshair.appendChild(chX);
  crosshair.appendChild(chY);
  const focusRing = makeEl('circle', { 'data-dd-dot-focus': '', display: 'none' });
  const tether = makeEl('line', { 'data-dd-pin-tether': '', display: 'none' });

  const svg = makeEl('svg', {
    'data-dd-svg-kind': 'quadrant',
    'data-dd-svg-width': '700',
    'data-dd-svg-height': '436',
  });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 436, width: 700, height: 436 });
  svg.querySelector = sel => ({
    '.m-dd-dots': dotsGroup,
    '.m-dd-pulses': pulsesGroup,
    '.m-dd-trails': trailsGroup,
    '[data-dd-history]': historyGroup,
    '[data-dd-compressed-bands]': bandsGroup,
    '[data-dd-grid-lines]': gridGroup,
    '[data-dd-zones]': zonesGroup,
    '[data-dd-axis-x-group]': axisXGroup,
    '[data-dd-axis-y-group]': axisYGroup,
    '[data-dd-axis-x-ticks]': axisXTicks,
    '[data-dd-axis-y-ticks]': axisYTicks,
    '[data-dd-axis-origin]': axisOrigin,
    '.m-dd-quad-labels': labelsGroup,
    '[data-dd-crosshair]': crosshair,
    '[data-dd-ch-x]': chX,
    '[data-dd-ch-y]': chY,
    '[data-dd-dot-focus]': focusRing,
    '[data-dd-pin-tether]': tether,
  })[sel] || null;

  const pop = makeEl('div', { 'data-dd-preview-pop': '' });
  pop.hidden = true;
  const popImg = makeEl('img');
  popImg.parentElement = makeEl('div');
  pop.querySelector = sel => (sel === 'img' ? popImg : makeEl('span'));

  const stage = makeEl('div');
  stage.clientWidth = 700;
  stage.clientHeight = 440;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 440, width: 700, height: 440 });
  const resetBtn = { hidden: true, closest: () => null };
  const wrap = makeEl('div');
  wrap.dataset = { mode: 'quadrant' };
  wrap.querySelector = sel => ({
    '[data-dd-hero-stage]': stage,
    '[data-dd-hero-svg]': svg,
    '[data-dd-preview-pop]': pop,
    '[data-dd-zoom-reset]': resetBtn,
    '[data-dd-pin-tether]': tether,
  })[sel] || null;
  const panel = makeEl('div');
  panel.querySelectorAll = sel => (sel === '[data-dd-hero-wrap]' ? [wrap] : []);
  panel.querySelector = sel => (sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? wrap : null);

  withMockEnv({
    innerWidth: 1440,
    innerHeight: 900,
    document: {
      createElementNS: (_ns, tag) => makeEl(tag),
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null),
      addEventListener() {},
      removeEventListener() {},
    },
    performance: { now: () => fakeNow },
    requestAnimationFrame: cb => { const id = rafId++; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame: id => rafQueue.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
  }, () => {
    const app = makeApp({ datasetDiagData: SAMPLE_DATA, _monitorMotionAllowed: () => true });
    app._bindDatasetDiagCharts(panel);
    for (const pt of wrap._ddChartState.coords) {
      dotsGroup.appendChild(makeEl('circle', {
        class: pt.cls || 'm-dd-dot',
        'data-dd-image-id': pt.image_id,
        cx: pt.cx.toFixed(1),
        cy: pt.cy.toFixed(1),
      }));
    }
    wrap._ddSvgRefs = null;
    wrap._ddDotBindings = null;

    // Trigger wheel zoom keeping 'aaaaaaaaaaaaaaaa' visible inside plot bounds while live & target diverge
    stage.emit('wheel', { deltaY: -180, deltaX: 0, deltaMode: 0, clientX: 420, clientY: 190, preventDefault() {} });
    flushRaf();
    stage.emit('wheel', { deltaY: -180, deltaX: 0, deltaMode: 0, clientX: 420, clientY: 190, preventDefault() {} });
    flushRaf();
    fakeNow += 20;
    flushRaf();

    const curr = wrap._ddChartState;
    assert.ok(curr.liveScale && typeof curr.liveScale.toX === 'function' && typeof curr.liveScale.toY === 'function');
    const targetPt = curr.coords.find(pt => pt.image_id === 'aaaaaaaaaaaaaaaa');
    const liveCx = curr.liveScale.toX(targetPt.mean_residual);
    const liveCy = curr.liveScale.toY(targetPt.slope);
    assert.ok(liveCx >= curr.padL && liveCx <= curr.padL + curr.plotW && liveCy >= curr.padT && liveCy <= curr.padT + curr.plotH);
    assert.ok(Math.hypot(liveCx - targetPt.cx, liveCy - targetPt.cy) > 30, 'Live frame dot must differ significantly from target position');

    // 4-arg _ddHitTestScatterDot hits live frame position even when _ddLiveDotCoords is null
    const hitLive = app._ddHitTestScatterDot(curr, liveCx, liveCy, wrap._ddLiveDotCoords);
    assert.equal(hitLive?.image_id, 'aaaaaaaaaaaaaaaa');
    assert.equal(app._ddHitTestScatterDot(curr, targetPt.cx, targetPt.cy, wrap._ddLiveDotCoords), null);

    // Hovering at live frame coords aligns focusRing & crosshair to live projection
    app._updateDatasetDiagHeroHover(wrap, liveCx, liveCy);
    assert.equal(wrap._ddHoverDot?.image_id, 'aaaaaaaaaaaaaaaa');
    assert.equal(focusRing.getAttribute('cx'), liveCx.toFixed(1));
    assert.equal(focusRing.getAttribute('cy'), liveCy.toFixed(1));
    assert.equal(chX.getAttribute('x1'), liveCx.toFixed(1));
    assert.equal(chY.getAttribute('y1'), liveCy.toFixed(1));

    // Clicking at live frame coords pins card and anchors popover to live projection
    stage.emit('pointerdown', { button: 0, isPrimary: true, pointerId: 3, clientX: liveCx, clientY: liveCy, target: svg });
    stage.emit('click', { clientX: liveCx, clientY: liveCy, target: svg });
    assert.equal(wrap._ddPinnedDot?.image_id, 'aaaaaaaaaaaaaaaa');
    assert.equal(pop.hidden, false);
    assert.ok(Math.abs(wrap._ddPopAnchor.x - liveCx) < 0.2);
    assert.ok(Math.abs(wrap._ddPopAnchor.y - liveCy) < 0.2);

    // Settling animation clears liveScale to null
    fakeNow += 600;
    flushRaf();
    assert.equal(svg.classList.contains('is-camera-anim'), false);
    assert.equal(wrap._ddChartState.liveScale, null);

    // Stopping animation mid-flight also clears liveScale to null
    stage.emit('wheel', { deltaY: -120, deltaX: 0, deltaMode: 0, clientX: 250, clientY: 220, preventDefault() {} });
    flushRaf();
    fakeNow += 16;
    flushRaf();
    assert.ok(wrap._ddChartState.liveScale);
    assert.ok(Array.isArray(wrap._ddChartState.liveZones));
    app._ddStopScatterCameraAnim(wrap, svg);
    assert.equal(wrap._ddChartState.liveScale, null);
    assert.equal(wrap._ddChartState.liveZones, null);

    // Quadrant zone hit-testing uses liveZones during camera animation
    app.setDatasetDiagShowZones(true);
    stage.emit('wheel', { deltaY: -220, deltaX: 0, deltaMode: 0, clientX: 520, clientY: 160, preventDefault() {} });
    flushRaf();
    fakeNow += 16;
    flushRaf();
    const animSt = wrap._ddChartState;
    const liveAtt = animSt.liveZones?.find(z => z.preset === 'attention');
    assert.ok(liveAtt && liveAtt.x2 > liveAtt.x1 + 10);
    const zoneHit = app._ddHitTestScatterZone(animSt, (liveAtt.x1 + liveAtt.x2) * 0.5, (liveAtt.y1 + liveAtt.y2) * 0.5);
    assert.equal(zoneHit?.preset, 'attention');
    fakeNow += 600;
    flushRaf();
  });

  // Early beeswarm reset animation interpolates Y via cyProgress for 4-arg hit-testing & resolve
  const earlyWrap = makeEl('div');
  earlyWrap.dataset = { mode: 'quadrant' };
  const earlySvg = makeEl('svg', {
    'data-dd-svg-kind': 'early',
    'data-dd-svg-width': '700',
    'data-dd-svg-height': '436',
  });
  earlySvg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 436, width: 700, height: 436 });
  const earlyStage = makeEl('div');
  earlyStage.clientWidth = 700;
  earlyStage.clientHeight = 440;
  earlyStage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 700, bottom: 440, width: 700, height: 440 });
  const earlyDots = makeEl('g', { class: 'm-dd-dots' });
  const earlyAxes = makeEl('g', { class: 'm-chart-axes m-dd-axis-group' });
  const earlyBands = makeEl('g', { 'data-dd-compressed-bands': '' });
  const earlyGrid = makeEl('g', { 'data-dd-grid-lines': '' });
  const earlyZones = makeEl('g', { 'data-dd-zones': '' });
  earlyZones.appendChild(makeEl('rect', { 'data-dd-zone-preset': 'attention' }));
  const earlyAxisY = makeEl('g', { 'data-dd-axis-y-group': '' });
  const earlyOrigin = makeEl('g', { 'data-dd-axis-origin': '' });
  earlyOrigin.appendChild(makeEl('text'));
  const earlyLabels = makeEl('g', { class: 'm-dd-quad-labels' });
  const earlyFocus = makeEl('circle', { 'data-dd-dot-focus': '', display: 'none' });
  const earlyCh = makeEl('g', { 'data-dd-crosshair': '', display: 'none' });
  const earlyChX = makeEl('line', { 'data-dd-ch-x': '' });
  const earlyChY = makeEl('line', { 'data-dd-ch-y': '' });
  earlyCh.appendChild(earlyChX);
  earlyCh.appendChild(earlyChY);
  const earlyTether = makeEl('line', { 'data-dd-pin-tether': '', display: 'none' });
  earlySvg.querySelector = sel => ({
    '.m-dd-dots': earlyDots,
    '.m-dd-pulses': makeEl('g', { class: 'm-dd-pulses' }),
    '.m-dd-trails': makeEl('g', { class: 'm-dd-trails' }),
    '[data-dd-compressed-bands]': earlyBands,
    '[data-dd-grid-lines]': earlyGrid,
    '[data-dd-zones]': earlyZones,
    '[data-dd-axis-y-group]': earlyAxisY,
    '.m-chart-axes': earlyAxes,
    '[data-dd-axis-origin]': earlyOrigin,
    '.m-dd-quad-labels': earlyLabels,
    '[data-dd-crosshair]': earlyCh,
    '[data-dd-ch-x]': earlyChX,
    '[data-dd-ch-y]': earlyChY,
    '[data-dd-dot-focus]': earlyFocus,
    '[data-dd-pin-tether]': earlyTether,
  })[sel] || null;
  earlyWrap.querySelector = sel => ({
    '[data-dd-hero-stage]': earlyStage,
    '[data-dd-hero-svg]': earlySvg,
    '[data-dd-preview-pop]': pop,
    '[data-dd-zoom-reset]': resetBtn,
    '[data-dd-pin-tether]': earlyTether,
  })[sel] || null;
  const earlyPanel = makeEl('div');
  earlyPanel.querySelectorAll = sel => (sel === '[data-dd-hero-wrap]' ? [earlyWrap] : []);
  earlyPanel.querySelector = sel => (sel === '[data-dd-hero-wrap][data-mode="quadrant"]' ? earlyWrap : null);

  const earlyData = {
    ...structuredClone(SAMPLE_DATA),
    summary: { ...SAMPLE_DATA.summary, has_slope: false },
    by_image: Array.from({ length: 16 }, (_, i) => ({
      image_id: `early_${String(i).padStart(4, '0')}`,
      image: `D:/ds/early_${i}.png`,
      name: `early_${i}.png`,
      resolution: '512x512',
      subset: '0-0',
      is_reg: false,
      count: 2,
      comparable_count: 2,
      non_finite_count: 0,
      epochs: 1,
      mean_loss: 0.25,
      mean_residual: (i - 8) * 0.005,
      slope: null,
      status: 'normal',
    })),
  };
  withMockEnv({
    innerWidth: 1440,
    innerHeight: 900,
    document: {
      createElementNS: (_ns, tag) => makeEl(tag),
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? earlyPanel : null),
      addEventListener() {},
      removeEventListener() {},
    },
    performance: { now: () => fakeNow },
    requestAnimationFrame: cb => { const id = rafId++; rafQueue.set(id, cb); return id; },
    cancelAnimationFrame: id => rafQueue.delete(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
  }, () => {
    const app = makeApp({ datasetDiagData: earlyData, _monitorMotionAllowed: () => true });
    app._bindDatasetDiagCharts(earlyPanel);
    for (const pt of earlyWrap._ddChartState.coords) {
      earlyDots.appendChild(makeEl('circle', {
        class: pt.cls || 'm-dd-dot',
        'data-dd-image-id': pt.image_id,
        cx: pt.cx.toFixed(1),
        cy: pt.cy.toFixed(1),
      }));
    }
    earlyWrap._ddSvgRefs = null;
    earlyWrap._ddDotBindings = null;

    // Zoom in & settle so beeswarm spreads out, then reset zoom to trigger Y interpolation animation
    earlyStage.emit('wheel', { deltaY: -360, deltaX: 0, deltaMode: 0, clientX: 350, clientY: 220, preventDefault() {} });
    flushRaf();
    fakeNow += 600;
    flushRaf();

    app.resetDatasetDiagScatterZoom();
    fakeNow += 100;
    flushRaf();

    const curr = earlyWrap._ddChartState;
    assert.ok(curr.liveScale && curr.liveScale.toY == null);
    assert.ok(curr.liveScale.cyProgress > 0 && curr.liveScale.cyProgress < 1);
    const movingDot = curr.coords.find(pt => Math.abs(pt.cy - pt.prevCy) > 6);
    assert.ok(movingDot, 'Expected at least one beeswarm dot with Y displacement during reset');
    const livePos = app._ddResolveDotScreenPos(earlyWrap, movingDot);
    const expectedCy = movingDot.prevCy + (movingDot.cy - movingDot.prevCy) * curr.liveScale.cyProgress;
    assert.ok(Math.abs(livePos.cy - expectedCy) < 0.1);
    const hit = app._ddHitTestScatterDot(curr, livePos.cx, livePos.cy, earlyWrap._ddLiveDotCoords);
    assert.equal(hit?.image_id, movingDot.image_id);
  });
});

test('long-epoch converging_slope scales scatter threshold label, Y auto-bounds, slope color, and trend pill', () => {
  const longRunData = {
    ...structuredClone(SAMPLE_DATA),
    thresholds: { ...SAMPLE_DATA.thresholds, converging_slope: -0.005 },
  };
  const app = makeApp({ datasetDiagData: longRunData });
  assert.ok(app._ddSlopeColor(-0.006).includes('--diag-tone-ok'));
  assert.ok(!app._ddSlopeColor(-0.003).includes('--diag-tone-ok'));
  assert.ok(app._ddTrendPillHtml(k => k, -0.006).includes('is-good'));

  const bounds = app._ddResolveScatterAutoBounds(
    null,
    'q|long|3',
    { xMin: -0.25, xMax: 0.45, yMin: -0.012, yMax: 0.008 },
    true,
    -0.005,
  );
  assert.equal(bounds.yMin, -0.02);
  assert.equal(bounds.yMax, 0.02);

  const stage = makeEl('div');
  stage.clientWidth = 700;
  stage.clientHeight = 440;
  const svg = makeEl('svg');
  const wrap = makeEl('div');
  wrap.dataset = { mode: 'quadrant' };
  wrap.querySelector = sel => (sel === '[data-dd-hero-stage]' ? stage : sel === '[data-dd-hero-svg]' ? svg : null);
  app._renderDatasetDiagHeroSvg(wrap, stage, svg, { animate: false });
  assert.ok(svg.innerHTML.includes('data-dd-thresh-label="conv"'));
  assert.ok(svg.innerHTML.includes('>-0.5%</text>'));
});

test('narrow scatter and early charts flip +20% threshold label left or dodge to avoid overlapping attention label', () => {
  const narrowData = {
    ...structuredClone(SAMPLE_DATA),
    by_image: [
      { image_id: 'n1', name: 'n1.png', count: 8, comparable_count: 8, mean_residual: -0.25, slope: -0.05, status: 'easy' },
      { image_id: 'n2', name: 'n2.png', count: 8, comparable_count: 8, mean_residual: 0.15, slope: -0.02, status: 'normal' },
      { image_id: 'n3', name: 'n3.png', count: 8, comparable_count: 8, mean_residual: 0.30, slope: 0.08, status: 'attention' },
      { image_id: 'n4', name: 'n4.png', count: 8, comparable_count: 8, mean_residual: 0.36, slope: 0.12, status: 'attention' },
    ],
  };
  const app = makeApp({ datasetDiagData: narrowData });

  for (const [mode, stageW, stageH] of [['early', 320, 220], ['quadrant', 300, 260]]) {
    const { wrap, stage, svg } = makeWrapStage(mode, stageW, stageH);
    app._renderDatasetDiagHeroSvg(wrap, stage, svg, { animate: false });
    const highEl = svg.querySelector('[data-dd-thresh-label="high"]');
    const attEl = svg.querySelector('[data-dd-zone-label="attention"]');
    assert.ok(highEl, `Expected high threshold label in ${mode}`);
    assert.ok(attEl, `Expected attention zone label in ${mode}`);
    assert.equal(highEl.getAttribute('text-anchor'), 'end', `Expected ${mode} +20% label to flip left`);
    const attText = `${app.tMonitor(mode === 'early' ? 'ddEarlyRight' : 'ddQuadTopRight')} · 2`;
    const attLeft = Number(attEl.getAttribute('x')) - app._ddEstimateScatterLabelWidth(attText, 10.5);
    assert.ok(Number(highEl.getAttribute('x')) <= attLeft, `Expected ${mode} +20% label to stay left of attention label`);
  }

  // When flipping left would still touch the attention label horizontally, drop vertically below it
  for (const [mode, stageW, stageH] of [['early', 240, 220], ['quadrant', 260, 260]]) {
    const tight = makeWrapStage(mode, stageW, stageH);
    app._renderDatasetDiagHeroSvg(tight.wrap, tight.stage, tight.svg, { animate: false });
    const tightHigh = tight.svg.querySelector('[data-dd-thresh-label="high"]');
    const tightAtt = tight.svg.querySelector('[data-dd-zone-label="attention"]');
    assert.ok(tightHigh && tightAtt);
    assert.ok(Number(tightHigh.getAttribute('y')) >= Number(tightAtt.getAttribute('y')) + 10);
  }

  // When both right (collides with attention) and left (hits padL) lack room at top, drop below attention label
  const dodged = app._ddResolveScatterHighLabel(12, 8, 140, 200, 32, '+20%', true, 'Needs attention · 12');
  assert.ok(Number(dodged.y) >= 32);

  // When attVisible is false but convLabelY is at top row, avoid colliding with conv label
  const dodgedConv = app._ddResolveScatterHighLabel(12, 8, 300, 200, 120, '+20%', false, '', 19);
  assert.ok(dodgedConv.anchor === 'end' || Number(dodgedConv.y) >= 31);

  // Top-left obstacle blocks left-flip -> drop vertically instead of colliding with left axis hint
  const dodgedTopObs = app._ddResolveScatterHighLabel(12, 8, 220, 200, 110, '+20%', true, 'Needs attention · 12', null, [{ left: 14, right: 112 }]);
  assert.ok(Number(dodgedTopObs.y) >= 33);
});

test('CSS hides .m-dd-inline-ctl[hidden] and .m-dd-leg[hidden] so inline-flex does not override the hidden attribute', () => {
  const css = readRepo('frontend/css/app.css');
  assert.match(css, /\.m-dd-inline-ctl\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.m-dd-leg\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
});

test('images sub-tab keeps only the top-bar dataset/reg selector without duplicating it in the toolbar', () => {
  const regData = {
    ...structuredClone(SAMPLE_DATA),
    summary: { ...SAMPLE_DATA.summary, has_reg_images: true },
    by_image: [
      ...SAMPLE_DATA.by_image,
      { image_id: 'reg1', name: 'reg1.png', count: 6, comparable_count: 6, mean_residual: 0.05, slope: -0.01, status: 'normal', is_reg: true },
    ],
  };
  const app = makeApp({ datasetDiagData: regData, datasetDiagSubTab: 'images' });
  const html = app._renderDatasetDiagTab(k => app.tMonitor(k));
  assert.match(html, /data-dd-top-reg-wrap>/);
  assert.doesNotMatch(html, /data-dd-top-reg-wrap\s+hidden/);
  assert.doesNotMatch(html, /data-dd-images-reg-wrap/);
  assert.doesNotMatch(html, /ddRegSelect/);
});

test('discrete non-adjacent populated bins connect into one continuous P25-P75 IQR ribbon in overview and modal timestep charts', () => {
  const activeBins = new Set([16, 13, 10, 7, 4, 1]);
  const width = 1000 / 18;
  const bins = Array.from({ length: 18 }, (_, bin) => {
    const active = activeBins.has(bin);
    return {
      bin,
      t_from: bin * width,
      t_to: (bin + 1) * width,
      count: active ? 6 : 0,
      images: active ? 3 : 0,
      comparable: active,
      mean_loss: active ? (0.18 + bin * 0.015) : null,
      p25: active ? (0.14 + bin * 0.012) : null,
      p75: active ? (0.24 + bin * 0.018) : null,
      non_finite_count: 0,
      trend: active ? -0.02 : null,
    };
  });

  const discreteData = {
    ...structuredClone(SAMPLE_DATA),
    timestep_scale: 'thousand',
    timestep_profile: {
      bins,
      by_status: {},
      by_group: {},
    },
  };
  const app = makeApp({ datasetDiagData: discreteData });

  const ts = makeWrapStage('timestep', 420, 200);
  app._renderDatasetDiagHeroSvg(ts.wrap, ts.stage, ts.svg, { animate: false });
  const heroIqrEl = ts.svg.querySelector('[data-dd-ts-iqr]');
  assert.ok(heroIqrEl, 'Overview timestep chart should render .m-dd-ts-iqr-band for discrete bins');
  const heroIqrD = heroIqrEl.getAttribute('d') || '';
  const heroSegs = heroIqrD.match(/M[^Z]+Z/g) || [];
  assert.equal(heroSegs.length, 1);

  const populatedCoords = ts.wrap._ddChartState.coords.filter(c => activeBins.has(c.bin)).sort((a, b) => a.xCenter - b.xCenter);
  assert.equal(populatedCoords.length, 6);
  const heroXs = Array.from(heroSegs[0].matchAll(/[ML](-?\d+(?:\.\d+)?)\s+-?\d+(?:\.\d+)?/g), m => Number(m[1]));
  assert.ok(Math.abs(Math.min(...heroXs) - populatedCoords[0].xCenter) <= 0.2);
  assert.ok(Math.abs(Math.max(...heroXs) - populatedCoords.at(-1).xCenter) <= 0.2);

  const detail = {
    run_id: 'r0',
    timestep_scale: 'thousand',
    image: discreteData.by_image[0],
    timestep_profile: { bins },
    epoch_series: [{ epoch: 1, count: 6, mean_residual: 0.1, mean_loss: 0.3, non_finite_count: 0 }],
    samples: Array.from(activeBins).map((bin, i) => ({
      step: i + 1,
      epoch: 1,
      timestep: (bin + 0.5) * width,
      loss: 0.2 + bin * 0.015,
      residual: 0.05,
      non_finite: false,
    })),
    caption: { exists: false },
    file_info: { exists: true },
  };
  const modalStage = makeEl('div');
  modalStage.clientWidth = 520;
  modalStage.clientHeight = 220;
  const modalSvg = makeEl('svg');
  app._renderDatasetDiagModalTimestepSvg(modalStage, modalSvg, detail, k => app.tMonitor(k));
  const modalIqrEl = modalSvg.querySelector('.m-dd-ts-iqr-band');
  assert.ok(modalIqrEl, 'Modal timestep chart should render .m-dd-ts-iqr-band for discrete bins');
  const modalIqrD = modalIqrEl.getAttribute('d') || '';
  const modalSegs = modalIqrD.match(/M[^Z]+Z/g) || [];
  assert.equal(modalSegs.length, 1);

  const modalPts = modalStage._ddState.profilePoints.filter((_, i) => activeBins.has(bins.slice().sort((a, b) => b.bin - a.bin)[i].bin));
  modalPts.sort((a, b) => a.x - b.x);
  const modalXs = Array.from(modalSegs[0].matchAll(/[ML](-?\d+(?:\.\d+)?)\s+-?\d+(?:\.\d+)?/g), m => Number(m[1]));
  assert.ok(Math.abs(Math.min(...modalXs) - modalPts[0].x) <= 0.2);
  assert.ok(Math.abs(Math.max(...modalXs) - modalPts.at(-1).x) <= 0.2);
});
