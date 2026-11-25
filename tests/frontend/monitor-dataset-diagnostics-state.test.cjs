const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend, composeMixins, createMemoryStorage, response, deferred, readRepo } = require('./helpers.cjs');

global.localStorage = createMemoryStorage();
const zhDict = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));

loadGlobalFrontend(['shared/utils', 'monitor/core', 'monitor/render']);

function makeApp(overrides = {}) {
  return Object.assign(composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin), {
    currentRoute: 'monitor-dashboard',
    monitorTab: 'dataset',
    selectedRunDir: 'output/example',
    t(key) { return key.split('.').reduce((v, part) => v?.[part], zhDict) ?? key; },
    renderDashboard() {},
    _patchDatasetDiagModal() {},
    _syncDatasetDiagImageStyle() {},
  }, overrides);
}

function snapshot(revision, options = {}) {
  return {
    available: true, revision, run_id: 'old', available_runs: ['old', 'new'],
    summary: { images_total: 1, counts: {} },
    by_image: [{ image_id: 'image', name: 'item.png', count: 4, mean_residual: 0.25 }],
    ...options,
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const paramsFrom = url => new URL(url, 'http://localhost').searchParams;

test('initial selection follows the latest run and failed segment selection keeps committed data together', async () => {
  const requests = [];
  let next = response(snapshot('r1'));
  global.fetch = async url => {
    requests.push(paramsFrom(url));
    return next;
  };
  const app = makeApp();
  await app.loadDatasetDiagnostics();
  assert.equal(app.datasetDiagRunId, 'old');

  next = { ok: false, json: async () => ({ status: 'error' }) };
  await app.setDatasetDiagRunId('new');
  assert.equal(app.datasetDiagRunId, 'old');
  assert.equal(app.datasetDiagData.run_id, 'old');
  assert.equal(app.datasetDiagError, 'loadFailed');

  next = response(snapshot('r2', { run_id: 'new' }));
  await app.loadDatasetDiagnostics({ silent: true });
  assert.equal(requests.at(-1).get('run_id'), null);
  assert.equal(app.datasetDiagRunId, 'new');

  next = response({ available: false, reason: 'empty', run_id: 'old', available_runs: ['old', 'new'], revision: 'r3' });
  await app.setDatasetDiagRunId('old');
  assert.equal(app.datasetDiagRunId, 'old');
  assert.equal(app.datasetDiagData.reason, 'empty');
  assert.deepEqual(app._ddRunOptions().map(option => option.value), ['all', 'new', 'old']);

  next = response(snapshot('r4', { run_id: 'new' }));
  await app.setDatasetDiagRunId('new');
  assert.equal(app.datasetDiagData.run_id, 'new');
  assert.equal(app.datasetDiagData.available, true);
});

test('an in-flight task request cannot block a run-directory request or overwrite its result', async () => {
  const requests = [];
  const delays = [deferred(), deferred()];
  global.fetch = (url, { signal }) => {
    requests.push({ params: paramsFrom(url), signal });
    return delays[requests.length - 1].promise;
  };
  const panel = {
    classList: { add() {}, remove() {} },
    dataset: {},
    firstElementChild: null,
  };
  global.document = { getElementById: () => ({ querySelector: () => panel }) };
  const app = makeApp({
    selectedRunDir: null, liveTaskId: null, monitorData: { state: 'FINISHED' }, _builtTab: 'dataset',
    _renderDatasetDiagTab: () => '',
    renderDashboard() { this._renderTab('dataset', {}, null, null, k => this.tMonitor(k), false); },
  });
  app.renderDashboard();
  assert.equal(requests.length, 0);
  assert.equal(app._datasetDiagLoaded, true);

  app.liveTaskId = 'task';
  app.renderDashboard();
  assert.equal(requests[0].params.get('task_id'), 'task');
  app.monitorData.run_dir = 'output/example';
  app.renderDashboard();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].params.get('run_dir'), 'output/example');
  delays[1].resolve(response({ available: false, reason: 'empty', revision: 'new' }));
  await flush();
  delays[0].resolve(response({ available: false, reason: 'waiting', revision: 'old' }));
  await flush();
  assert.equal(app.datasetDiagData.revision, 'new');
  assert.equal(app.datasetDiagLoading, false);
  assert.equal(requests.length, 2);
});

test('unchanged polls reuse the snapshot, and a manual refresh requests fresh file metadata', async () => {
  const requests = [];
  let renderCount = 0;
  global.fetch = async url => {
    const params = paramsFrom(url);
    requests.push(params);
    if (params.get('known_revision') === 'r1') return response({ unchanged: true, revision: 'r1' });
    const local = params.get('refresh_local') === 'true';
    return response(snapshot(local ? 'r2' : 'r1', { by_image: [{ image_id: 'image', thumb_url: local ? '/new' : '' }] }));
  };
  const app = makeApp({ renderDashboard() { renderCount++; } });
  await app.loadDatasetDiagnostics();
  const beforePoll = renderCount;
  const original = app.datasetDiagData;
  await app.loadDatasetDiagnostics({ silent: true });
  assert.equal(renderCount, beforePoll);
  assert.equal(app.datasetDiagData, original);
  await app.refreshDatasetDiagnostics();
  clearTimeout(app._datasetDiagRefreshTimer);
  assert.equal(requests.at(-1).get('refresh_local'), 'true');
  assert.equal(requests.at(-1).get('known_revision'), null);
  assert.equal(app.datasetDiagData.by_image[0].thumb_url, '/new');
});

test('new dataset baseline refreshes an open detail with the same image sample count', async () => {
  let revision = 'old';
  let residual = 0.25;
  let detailRequests = 0;
  const image = () => ({ image_id: 'image', name: 'item.png', count: 4, mean_residual: residual });
  global.fetch = async url => {
    if (url.includes('/image?')) {
      detailRequests++;
      return response({ revision, image: image() });
    }
    return response(snapshot(revision, { by_image: [image()] }));
  };
  const app = makeApp();
  await app.loadDatasetDiagnostics();
  app.openDatasetDiagModal('image');
  await flush();
  assert.equal(app.datasetDiagModalDetail.image.mean_residual, 0.25);

  revision = 'new';
  residual = 0.10;
  await app.loadDatasetDiagnostics({ silent: true });
  await flush();
  assert.equal(detailRequests, 2);
  assert.equal(app.datasetDiagModalDetail.image.mean_residual, 0.10);
});

test('a late image response cannot overwrite a newly selected cached detail', async () => {
  const slow = deferred();
  const first = { image_id: 'first' };
  const second = { image_id: 'second' };
  global.fetch = (url, { signal }) => {
    if (paramsFrom(url).get('image_id') === 'first') {
      slow.signal = signal;
      return slow.promise;
    }
    return Promise.resolve(response({ revision: 'r1', image: second }));
  };
  const app = makeApp({ datasetDiagData: snapshot('r1', { by_image: [first, second] }) });
  app.openDatasetDiagModal('second');
  await flush();
  app.openDatasetDiagModal('first');
  app.openDatasetDiagModal('second');
  assert.equal(slow.signal.aborted, true);
  assert.equal(app.datasetDiagModalLoading, false);
  slow.resolve(response({ revision: 'r1', image: first }));
  await flush();
  assert.equal(app.datasetDiagModalDetail.image.image_id, 'second');
});

test('Tag Editor handoff requires explicit confirmation of the caption target', () => {
  const routes = [];
  const detail = {
    file_info: { exists: true, dir_path: 'D:/dataset', abs_path: 'D:/dataset/person.png' },
    image: { name: 'person.png' },
  };
  const app = makeApp({ datasetDiagModalOpen: true, navigate: route => routes.push(route) });
  for (const caption of [undefined, {}, { editor_safe: false }, { editor_safe: 'true' }]) {
    app.datasetDiagModalDetail = { ...detail, caption };
    app.openDatasetDiagInTagEditor();
    assert.equal(app.datasetDiagModalOpen, true);
    assert.equal(app.tagEditorOpenPath, undefined);
  }
  assert.deepEqual(routes, []);

  app.datasetDiagModalDetail = { ...detail, caption: { editor_safe: true } };
  app.openDatasetDiagInTagEditor();
  assert.deepEqual(routes, ['tagEditor']);
  assert.equal(app.tagEditorOpenPath, 'D:/dataset/person.png');
});

test('dashboard overview renders by default, patches updates in-place, toggles cleanly with images view, and keeps filter/expand state synced', () => {
  const fields = Object.fromEntries(['heading', 'analysis', 'images'].map(name => [
    `[data-dd-slot="${name}"]`, {
      innerHTML: '',
      contains: () => false,
      querySelector: sel => (fields[`[data-dd-slot="${name}"]`].innerHTML && (sel === '.m-dd-topbar' || sel === '[data-dd-analysis]') ? {} : null),
      classList: { toggle() {} },
    },
  ]));
  const shell = { querySelector: selector => fields[selector] || null };
  const panel = { firstElementChild: shell, querySelector: () => shell, classList: { add() {} } };
  global.document = { getElementById: () => ({ querySelector: () => panel }) };
  let headingRenderCount = 0;
  let headingPatchCount = 0;
  let analysisRenderCount = 0;
  let analysisPatchCount = 0;
  let scatterSyncCount = 0;
  const multiGroupSnapshot = snapshot('r1', {
    by_resolution: [
      { key: '512x512', label: '512x512', count: 2, images: 1, mean_loss: 0.2, mean_residual: 0.1 },
      { key: '768x768', label: '768x768', count: 2, images: 1, mean_loss: 0.3, mean_residual: -0.1 },
    ],
  });
  const app = makeApp({
    _builtTab: 'dataset', _datasetDiagSourceKey: 'run:output/example', _datasetDiagLoaded: true,
    datasetDiagData: multiGroupSnapshot, runDetailData: {},
    _renderDatasetDiagHeading() { headingRenderCount++; return 'header'; },
    _patchDatasetDiagHeading() { headingPatchCount++; },
    _renderDatasetDiagAnalysisCard() {
      analysisRenderCount++;
      return `overview:${this.datasetDiagPreset}:${this.datasetDiagGroupFilter?.key || ''}`;
    },
    _patchDatasetDiagDashboard() { analysisPatchCount++; },
    _renderDatasetDiagImagesCard: () => 'images',
    _bindDatasetDiagCharts() {},
    _syncDatasetDiagScatterFilter() { scatterSyncCount++; },
  });
  const render = () => app._renderTab('dataset', {}, null, null, k => app.tMonitor(k), true);

  render();
  assert.equal(app.datasetDiagSubTab, 'overview');
  assert.equal(headingRenderCount, 1);
  assert.equal(headingPatchCount, 0);
  assert.equal(analysisRenderCount, 1);
  assert.equal(analysisPatchCount, 0);
  assert.equal(scatterSyncCount, 1);
  assert.equal(fields['[data-dd-slot="analysis"]'].hidden, false);
  assert.equal(fields['[data-dd-slot="images"]'].hidden, true);

  // Changing filter on overview patches in-place without rebuilding DOM
  app.setDatasetDiagRegMode('exclude');
  app.setDatasetDiagPreset('attention');
  render();
  assert.equal(headingRenderCount, 1);
  assert.equal(headingPatchCount, 1);
  assert.equal(analysisRenderCount, 1);
  assert.equal(analysisPatchCount, 1);
  assert.equal(scatterSyncCount, 2);

  // Live data update on same structure also patches in-place instead of resetting DOM
  app.datasetDiagData = snapshot('r1', {
    summary: { ...multiGroupSnapshot.summary, samples: 8 },
    by_resolution: multiGroupSnapshot.by_resolution,
  });
  app._datasetDiagSnapshotVersion++;
  render();
  assert.equal(headingRenderCount, 1);
  assert.equal(headingPatchCount, 2);
  assert.equal(analysisRenderCount, 1);
  assert.equal(analysisPatchCount, 2);

  // Switching to images subtab shows frameless gallery and hides overview dashboard
  app.setDatasetDiagSubTab('images');
  render();
  assert.equal(fields['[data-dd-slot="images"]'].hidden, false);
  assert.equal(fields['[data-dd-slot="analysis"]'].hidden, true);
  assert.equal(fields['[data-dd-slot="images"]'].innerHTML, 'images');
  assert.equal(analysisRenderCount, 1);

  // Toggling a group row locks overview filter in-place; openDatasetDiagGroupFilter jumps to images
  app.setDatasetDiagSubTab('overview');
  render();
  assert.equal(analysisRenderCount, 2);
  app.toggleDatasetDiagGroupFilter('resolution', '512x512', '512 × 512');
  render();
  assert.equal(app.datasetDiagSubTab, 'overview');
  assert.equal(app.datasetDiagGroupFilter.key, '512x512');
  assert.equal(analysisPatchCount, 3);
  app.openDatasetDiagGroupFilter('resolution', '768x768', '768 × 768');
  render();
  assert.equal(app.datasetDiagSubTab, 'images');
  assert.equal(app.datasetDiagGroupFilter.key, '768x768');
  assert.equal(fields['[data-dd-slot="images"]'].hidden, false);
  assert.equal(fields['[data-dd-slot="analysis"]'].hidden, true);

  // Invalid legacy subtab names are ignored; segment defaults keep valid 'images' view while resetting per-segment state
  app.setDatasetDiagSubTab('groups');
  assert.equal(app.datasetDiagSubTab, 'images');
  app.setDatasetDiagSubTab('overview');
  assert.equal(app.datasetDiagSubTab, 'overview');
  app.setDatasetDiagSubTab('images');
  app.datasetDiagPreset = 'attention';
  app._applyDatasetDiagDefaults(JSON.stringify(['run:output/example', 'old']), multiGroupSnapshot);
  assert.equal(app.datasetDiagSubTab, 'images');
  assert.equal(app.datasetDiagPreset, 'all');

  app._resetDatasetDiagForRun('run:output/other');
  assert.equal(app.datasetDiagSubTab, 'overview');
  assert.equal(app.datasetDiagPreset, 'all');
});

test('group filter overlays additively while preserving active preset/reg/search, and notable group resets only conflicting preset', () => {
  const img = {
    image_id: 'image', name: 'item.png', resolution: '512x512', resolutions: ['512x512', '768x768'],
    subset: '0-0', subsets: ['0-0', '0-1'], status: 'attention', is_reg: false,
  };
  const img2 = {
    image_id: 'other', name: 'other.png', resolution: '768x768', resolutions: ['768x768'],
    subset: '0-1', subsets: ['0-1'], status: 'normal', is_reg: false,
  };
  const app = makeApp({
    datasetDiagData: snapshot('r1', { by_image: [img, img2] }),
    datasetDiagPreset: 'attention', datasetDiagRegMode: 'exclude', datasetDiagSearch: 'item',
  });
  app.toggleDatasetDiagGroupFilter('resolution', '768x768');
  assert.equal(app.datasetDiagPreset, 'attention');
  assert.equal(app.datasetDiagRegMode, 'exclude');
  assert.equal(app.datasetDiagSearch, 'item');
  assert.deepEqual(app._datasetDiagFilteredImages(), [img]);

  app.toggleDatasetDiagGroupFilter('subset', '0-1');
  app.setDatasetDiagPreset('all');
  app.setDatasetDiagSearch('');
  assert.deepEqual(app._datasetDiagFilteredImages(), [img, img2]);

  // Clicking again clears the additive group filter
  app.toggleDatasetDiagGroupFilter('subset', '0-1');
  assert.equal(app.datasetDiagGroupFilter, null);

  // selectDatasetDiagNotableGroup resets preset to 'all' only when current preset has 0 items in that group
  app.datasetDiagData = snapshot('r1', {
    by_image: [img, img2],
    notable_group: { dimension: 'resolution', key: '512x512', label: '512×512', mean_residual: 0.25 },
  });
  app.setDatasetDiagSubTab('overview');
  app.setDatasetDiagPreset('below_mean');
  app.selectDatasetDiagNotableGroup('resolution', '512x512', '512×512');
  assert.deepEqual(app.datasetDiagGroupFilter, { dim: 'resolution', key: '512x512', label: '512×512' });
  assert.equal(app.datasetDiagPreset, 'all');
  assert.equal(app.datasetDiagSubTab, 'images');
});

test('changing the comparison threshold updates classification and chart eligibility within the current group', async () => {
  const alwaysEligible = { image_id: 'other-group', count: 5, comparable_count: 5, mean_residual: 0.25, slope: -0.03, status: 'learning' };
  const fewReferences = { image_id: 'few-references', resolution: '512x512', resolutions: ['512x512', '768x768'], count: 8, comparable_count: 3, mean_residual: 0.3, slope: 0.01 };
  const fewSamples = { image_id: 'few-samples', resolution: '768x768', count: 4, comparable_count: 3, mean_residual: 0.3, slope: 0.01 };
  global.fetch = async url => {
    const min = Number(paramsFrom(url).get('min_count'));
    return response(snapshot(`min-${min}`, {
      thresholds: { min_count: min },
      by_image: [
        alwaysEligible,
        { ...fewReferences, status: min === 3 ? 'attention' : 'insufficient_reference' },
        { ...fewSamples, status: min === 3 ? 'attention' : 'insufficient' },
      ],
    }));
  };

  const app = makeApp();
  const coverage = {};
  const svg = { setAttribute() {} };
  const wrap = { querySelector: () => coverage };
  const render = () => app._renderDatasetDiagQuadrantSvg(wrap, svg, app.datasetDiagData, 800, k => app.tMonitor(k));
  await app.loadDatasetDiagnostics();
  app.toggleDatasetDiagGroupFilter('resolution', '768x768');
  app.setDatasetDiagRegMode('exclude');
  app.setDatasetDiagPreset('attention');
  assert.deepEqual(app._datasetDiagFilteredImages().map(row => row.image_id), ['few-references', 'few-samples']);
  render();
  assert.equal(wrap._ddChartState.coords.length, 3);

  await app.setDatasetDiagMinCount(5);
  assert.equal(app.datasetDiagMinCount, 5);
  assert.equal(app.datasetDiagGroupFilter.key, '768x768');
  assert.deepEqual(app._datasetDiagFilteredImages(), []);
  app.setDatasetDiagPreset('all');
  assert.deepEqual(app._datasetDiagFilteredImages().map(row => row.status), ['insufficient_reference', 'insufficient']);
  render();
  assert.deepEqual(wrap._ddChartState.coords.map(row => row.image_id), ['other-group']);
});

test('large scatter plots report coverage and preserve status representatives and axis extremes', () => {
  const app = makeApp();
  const count = 130000;
  const data = {
    available: true, thresholds: { min_count: 3 },
    by_image: Array.from({ length: count }, (_, i) => ({
      image_id: String(i), comparable_count: 3, mean_residual: (i % 100) / 100, slope: -(i % 100) / 100,
      status: i === 1234 ? 'non_finite' : i === 987 ? 'attention' : 'normal',
    })),
  };
  Object.assign(data.by_image[53], { mean_residual: -1 });
  Object.assign(data.by_image[4401], { mean_residual: 30 });
  Object.assign(data.by_image[5100], { slope: -5 });
  Object.assign(data.by_image[7097], { slope: 9 });
  data.by_image.push({ image_id: 'insufficient', count: 10, comparable_count: 2, mean_residual: 0, slope: 0 });
  const coverage = {};
  const svg = { setAttribute() {} };
  const wrap = { querySelector: () => coverage };
  app._renderDatasetDiagQuadrantSvg(wrap, svg, data, 800, k => app.tMonitor(k));
  assert.equal(wrap._ddChartState.coords.length, 1000);
  const shown = new Set(wrap._ddChartState.coords.map(point => point.image_id));
  for (const id of [53, 987, 1234, 4401, 5100, 7097]) assert.ok(shown.has(String(id)));
  assert.equal(shown.has('insufficient'), false);
  assert.match(coverage.textContent, /1000 \/ 130000/);
  assert.doesNotMatch(coverage.textContent, /130001/);
});

test('analysis collapse/expand, context status counts with unqualified merge, zone preset toggle, column sorting, and scatter dimming work together', () => {
  const rows = [
    { image_id: 'a1', name: 'a.png', status: 'attention', is_reg: false, mean_residual: 0.4, mean_loss: 0.5, count: 6, slope: 0.02 },
    { image_id: 'l1', name: 'b.png', status: 'learning', is_reg: false, mean_residual: 0.28, mean_loss: 0.3, count: 8, slope: -0.04 },
    { image_id: 'i1', name: 'c.png', status: 'insufficient', is_reg: false, mean_residual: 0.1, mean_loss: 0.2, count: 2, slope: null },
    { image_id: 'r1', name: 'd.png', status: 'insufficient_reference', is_reg: true, mean_residual: 0.05, mean_loss: 0.18, count: 4, slope: null },
  ];
  const app = makeApp({ datasetDiagData: snapshot('r1', { by_image: rows }) });

  // Context status counts merge insufficient + insufficient_reference into unqualified and track reg scope (defaults to 'exclude')
  let counts = app._datasetDiagStatusCounts();
  assert.equal(counts.all, 3);
  assert.equal(counts.attention, 1);
  assert.equal(counts.learning, 1);
  assert.equal(counts.unqualified, 1);

  app.setDatasetDiagRegMode('all');
  counts = app._datasetDiagStatusCounts();
  assert.equal(counts.all, 4);
  assert.equal(counts.attention, 1);
  assert.equal(counts.learning, 1);
  assert.equal(counts.unqualified, 2);

  // Unqualified preset returns only insufficient + insufficient_reference within reg scope
  app.setDatasetDiagPreset('unqualified');
  assert.deepEqual(app._datasetDiagFilteredImages().map(r => r.image_id), ['i1', 'r1']);

  // Zone preset toggle locks/clears preset on overview without leaving overview
  app.toggleDatasetDiagZonePreset('learning');
  assert.equal(app.datasetDiagPreset, 'learning');
  assert.equal(app.datasetDiagSubTab, 'overview');
  app.toggleDatasetDiagZonePreset('learning');
  assert.equal(app.datasetDiagPreset, 'all');
  assert.equal(app.datasetDiagSubTab, 'overview');

  // Overview preset toggle supports 'normal' and clears conflicting group filters; openDatasetDiagFilteredImages jumps
  const multiNormal = makeApp({
    datasetDiagData: snapshot('r1', {
      by_image: [
        { image_id: 'n1', name: 'n1.png', status: 'normal', resolution: '512x512', resolutions: ['512x512'] },
        { image_id: 'a2', name: 'a2.png', status: 'attention', resolution: '768x768', resolutions: ['768x768'] },
      ],
    }),
    datasetDiagGroupFilter: { dim: 'resolution', key: '768x768', label: '768 × 768' },
  });
  multiNormal.toggleDatasetDiagOverviewPreset('normal');
  assert.equal(multiNormal.datasetDiagSubTab, 'overview');
  assert.equal(multiNormal.datasetDiagPreset, 'normal');
  assert.equal(multiNormal.datasetDiagGroupFilter, null);
  multiNormal.openDatasetDiagFilteredImages();
  assert.equal(multiNormal.datasetDiagSubTab, 'images');
  assert.deepEqual(multiNormal._datasetDiagFilteredImages().map(r => r.image_id), ['n1']);

  // Column sort toggles primary descending / secondary ascending
  app.toggleDatasetDiagColumnSort('loss');
  assert.equal(app.datasetDiagSort, 'loss_desc');
  assert.deepEqual(app._datasetDiagFilteredImages().map(r => r.image_id), ['a1', 'l1', 'i1', 'r1']);
  app.toggleDatasetDiagColumnSort('loss');
  assert.equal(app.datasetDiagSort, 'loss_asc');
  assert.deepEqual(app._datasetDiagFilteredImages().map(r => r.image_id), ['r1', 'i1', 'l1', 'a1']);

  // Sub-tab switching, preset opener, and filter reset (switching back to overview clears search)
  app.setDatasetDiagSubTab('timestep');
  assert.equal(app.datasetDiagSubTab, 'overview');
  app.openDatasetDiagPreset('attention');
  assert.equal(app.datasetDiagSubTab, 'images');
  assert.equal(app.datasetDiagPreset, 'attention');
  app.setDatasetDiagRegMode('only');
  app.setDatasetDiagSearch('a');
  app.setDatasetDiagSubTab('overview');
  assert.equal(app.datasetDiagSubTab, 'overview');
  assert.equal(app.datasetDiagSearch, '');
  app.setDatasetDiagSearch('a');
  app.resetDatasetDiagFilters();
  assert.equal(app.datasetDiagPreset, 'all');
  assert.equal(app.datasetDiagGroupFilter, null);
  assert.equal(app.datasetDiagRegMode, 'only');
  assert.equal(app.datasetDiagSearch, '');

  // Scatter dot dimming updates .is-dimmed / .is-matched classes when filter active, skips reorder on live animation, and supports hover preview
  const mkNode = id => {
    const classes = new Set();
    return {
      dataset: { ddImageId: id },
      style: {},
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
      classes,
    };
  };
  const dotA = mkNode('a1');
  const dotL = mkNode('l1');
  const appended = [];
  const chX = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const chY = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const ch = {
    attrs: { display: 'none' },
    querySelector: s => (s === '[data-dd-ch-x]' ? chX : s === '[data-dd-ch-y]' ? chY : null),
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
  const focusRing = {
    attrs: { display: 'none' },
    style: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
  const fakeSvg = {
    querySelector: sel => (
      sel === '.m-dd-dots' ? { appendChild: n => appended.push(n.dataset.ddImageId) }
        : sel === '[data-dd-crosshair]' ? ch
          : sel === '[data-dd-dot-focus]' ? focusRing
            : null
    ),
    querySelectorAll: sel => (sel === '.m-dd-dot' ? [dotA, dotL] : []),
  };
  const fakeWrap = {
    _ddChartState: {
      kind: 'scatter', padL: 50, padT: 20, plotW: 600, plotH: 300,
      coords: [
        { image_id: 'a1', cx: 300, cy: 120, r: 4.5, fill: 'var(--warning)' },
        { image_id: 'l1', cx: 240, cy: 200, r: 4.2, fill: 'var(--accent)' },
      ],
    },
    matches: () => true,
    querySelector: sel => (sel === '[data-dd-hero-svg]' ? fakeSvg : null),
  };
  app.setDatasetDiagRegMode('exclude');
  app.setDatasetDiagPreset('attention');
  app._syncDatasetDiagScatterFilter(fakeWrap, { skipReorder: true });
  assert.equal(dotA.classes.has('is-matched'), true);
  assert.equal(dotA.classes.has('is-dimmed'), false);
  assert.equal(dotL.classes.has('is-dimmed'), true);
  assert.deepEqual(appended, [], 'Animated reconcile must not appendChild and interrupt CSS cx/cy transitions');

  app._syncDatasetDiagScatterFilter(fakeWrap);
  assert.deepEqual(appended, ['a1']);

  app.previewDatasetDiagImage('l1');
  app._syncDatasetDiagScatterFilter(fakeWrap);
  assert.equal(dotL.classes.has('is-matched'), true);
  assert.equal(dotA.classes.has('is-dimmed'), true);
  assert.equal(ch.attrs.display, undefined);
  assert.equal(focusRing.attrs.cx, '240.0');
  app.clearDatasetDiagPreview();
  app._syncDatasetDiagScatterFilter(fakeWrap);
  assert.equal(ch.attrs.display, 'none');
  assert.equal(dotA.classes.has('is-matched'), true);
});

test('scheduleDatasetDiagPreviewClear avoids empty-state flicker across adjacent rows and cancels cleanly', async () => {
  const history = [];
  const app = makeApp({
    _syncDatasetDiagScatterFilter() {},
    _syncDatasetDiagNoiseOverlay() {
      const p = this._datasetDiagHoverPreview;
      history.push(p ? `${p.kind}:${p.dim || ''}:${p.key || p.preset || p.imageId}` : null);
    },
  });

  app.previewDatasetDiagGroup('resolution', '384x512');
  assert.deepEqual(history, ['group:resolution:384x512']);

  // Leaving into the gap then re-entering the same row within grace period is a zero-work no-op
  app.scheduleDatasetDiagPreviewClear(40);
  await new Promise(resolve => setTimeout(resolve, 10));
  app.previewDatasetDiagGroup('resolution', '384x512');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(app._datasetDiagHoverPreview, { kind: 'group', dim: 'resolution', key: '384x512' });
  assert.deepEqual(history, ['group:resolution:384x512']);

  // Crossing gap to the next row cancels the clear timer and never visits null
  app.scheduleDatasetDiagPreviewClear(40);
  await new Promise(resolve => setTimeout(resolve, 10));
  app.previewDatasetDiagGroup('resolution', '448x448');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(app._datasetDiagHoverPreview, { kind: 'group', dim: 'resolution', key: '448x448' });
  assert.deepEqual(history, ['group:resolution:384x512', 'group:resolution:448x448']);

  // Leaving with no re-entry clears after the grace delay
  app.scheduleDatasetDiagPreviewClear(25);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(app._datasetDiagHoverPreview, null);
  assert.deepEqual(history, ['group:resolution:384x512', 'group:resolution:448x448', null]);

  // Synchronous clear cancels any pending timer
  app.previewDatasetDiagGroup('resolution', '512x384');
  app.scheduleDatasetDiagPreviewClear(40);
  app.clearDatasetDiagPreview();
  assert.equal(app._datasetDiagHoverPreview, null);
  assert.equal(app._datasetDiagPreviewClearTimer, null);
});

test('datasetDiagRegMode persists via localStorage, isolates overview from images scope, and falls back without overwriting on runs without reg images', () => {
  const { loadFrontend } = require('./helpers.cjs');
  const store = new Map();
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
  };
  const createIsolatedApp = (overrides = {}) => {
    const context = loadFrontend(['shared/utils', 'monitor/core', 'monitor/render'], {
      window: {},
      localStorage,
      requestAnimationFrame: () => 0,
      document: { hidden: false, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
      setTimeout,
      clearTimeout,
    });
    return Object.assign(composeMixins(context.window.utilsMixin, context.window.monitorCoreMixin, context.window.monitorRenderMixin), {
      currentRoute: 'monitor-dashboard',
      monitorTab: 'dataset',
      selectedRunDir: 'output/example',
      t(key) { return key.split('.').reduce((v, part) => v?.[part], zhDict) ?? key; },
      renderDashboard() {},
      _patchDatasetDiagModal() {},
      _syncDatasetDiagImageStyle() {},
    }, overrides);
  };

  const withReg = snapshot('r1', {
    summary: { images_total: 2, has_reg_images: true, counts: {} },
    by_image: [
      { image_id: 't1', name: 'train.png', status: 'attention', is_reg: false, mean_residual: 0.4, count: 6 },
      { image_id: 'reg1', name: 'reg.png', status: 'attention', is_reg: true, mean_residual: 0.3, count: 6 },
    ],
  });
  const withoutReg = snapshot('r2', {
    summary: { images_total: 1, has_reg_images: false, counts: {} },
    by_image: [
      { image_id: 't1', name: 'train.png', status: 'normal', is_reg: false, mean_residual: 0.05, count: 6 },
    ],
  });

  // Defaults to 'exclude' and does not flag overview as having an active filter
  const first = createIsolatedApp({ datasetDiagData: withReg });
  assert.equal(first.datasetDiagRegMode, 'exclude');
  assert.equal(first._datasetDiagHasActiveFilter(), false);
  assert.deepEqual(first._datasetDiagFilteredImages().map(img => img.image_id), ['t1']);
  assert.deepEqual(first._datasetDiagFilteredImages({ ignoreReg: true }).map(img => img.image_id), ['t1', 'reg1']);
  assert.deepEqual(Array.from(first._datasetDiagFilteredIdSet({ ignoreReg: true })), ['t1', 'reg1']);

  // Switching to 'only' persists to localStorage and still does not trigger active filter
  first.setDatasetDiagRegMode('only');
  assert.equal(store.get('anima_dataset_diag_reg_mode'), 'only');
  assert.equal(first._datasetDiagHasActiveFilter(), false);
  assert.deepEqual(first._datasetDiagFilteredImages().map(img => img.image_id), ['reg1']);
  assert.deepEqual(first._datasetDiagFilteredImages({ ignoreReg: true }).map(img => img.image_id), ['t1', 'reg1']);

  // Fresh reload restores 'only'; switching to a run without reg images falls back at read time without overwriting preference
  const reloaded = createIsolatedApp({ datasetDiagData: withoutReg });
  assert.equal(reloaded.datasetDiagRegMode, 'only');
  reloaded._applyDatasetDiagDefaults('run:output/no-reg', withoutReg);
  assert.equal(reloaded.datasetDiagRegMode, 'only');
  assert.equal(store.get('anima_dataset_diag_reg_mode'), 'only');
  assert.deepEqual(reloaded._datasetDiagFilteredImages().map(img => img.image_id), ['t1']);

  // Resetting for another run preserves persisted reg mode
  reloaded._resetDatasetDiagForRun('run:output/next');
  assert.equal(reloaded.datasetDiagRegMode, 'only');
});

test('selection locks status and group hover previews without blocking clicks, image hover, or unlock', () => {
  let syncCalls = 0;
  const app = makeApp({
    _syncDatasetDiagScatterFilter() { syncCalls += 1; },
    _syncDatasetDiagNoiseOverlay() { syncCalls += 1; },
    _syncDatasetDiagStatusHighlight() { syncCalls += 1; },
  });

  // Unlocked initially: status & group hover previews trigger sync
  assert.equal(app._datasetDiagSelectionLocked(), false);
  app.previewDatasetDiagStatus('easy');
  assert.deepEqual(app._datasetDiagHoverPreview, { kind: 'preset', preset: 'easy' });
  assert.equal(syncCalls, 3);
  app.clearDatasetDiagPreview();
  assert.equal(app._datasetDiagHoverPreview, null);

  // Locking via status preset selection prevents other status/group hover overrides
  syncCalls = 0;
  app.toggleDatasetDiagOverviewPreset('easy');
  assert.equal(app._datasetDiagSelectionLocked(), true);
  assert.equal(app._datasetDiagHoverPreview, null);
  app.previewDatasetDiagStatus('attention');
  app.previewDatasetDiagGroup('resolution', '384x512');
  assert.equal(app._datasetDiagHoverPreview, null);
  assert.equal(syncCalls, 0);

  // Clicking another status switches lock cleanly; clicking again unlocks and restores hover preview
  app.toggleDatasetDiagOverviewPreset('attention');
  assert.equal(app.datasetDiagPreset, 'attention');
  assert.equal(app._datasetDiagSelectionLocked(), true);
  app.toggleDatasetDiagOverviewPreset('attention');
  assert.equal(app.datasetDiagPreset, 'all');
  assert.equal(app._datasetDiagSelectionLocked(), false);
  app.previewDatasetDiagStatus('easy');
  assert.deepEqual(app._datasetDiagHoverPreview, { kind: 'preset', preset: 'easy' });
  app.clearDatasetDiagPreview();

  // Locking via group filter prevents both status & other-group hover overrides; clearing unlocks
  syncCalls = 0;
  app.toggleDatasetDiagGroupFilter('resolution', '384x512');
  assert.equal(app._datasetDiagSelectionLocked(), true);
  assert.equal(app._datasetDiagHoverPreview, null);
  app.previewDatasetDiagGroup('resolution', '448x448');
  app.previewDatasetDiagStatus('learning');
  assert.equal(app._datasetDiagHoverPreview, null);
  assert.equal(syncCalls, 0);
  app.clearDatasetDiagGroupFilter();
  assert.equal(app._datasetDiagSelectionLocked(), false);
  app.previewDatasetDiagGroup('resolution', '448x448');
  assert.deepEqual(app._datasetDiagHoverPreview, { kind: 'group', dim: 'resolution', key: '448x448' });
});

test('modal zoom label, double-click toggle, page editor jump/clamp, and modifier key guards', () => {
  const images = [
    { image_id: 'img1', name: '1.png', mean_residual: 0.3 },
    { image_id: 'img2', name: '2.png', mean_residual: 0.2 },
    { image_id: 'img3', name: '3.png', mean_residual: 0.1 },
  ];
  const opened = [];
  const app = makeApp({
    datasetDiagData: snapshot('r1', { by_image: images }),
    datasetDiagModalOpen: true,
    datasetDiagModalImageId: 'img1',
    t(key) { return key === 'imageViewer.fit' ? '适应' : key; },
    openDatasetDiagModal(id) { opened.push(id); this.datasetDiagModalImageId = id; },
  });

  // Fit vs percentage zoom label via AnimaImageViewport
  let styleSyncs = 0;
  app._syncDatasetDiagImageStyle = () => { styleSyncs += 1; };
  assert.equal(app.datasetDiagZoomLabel(), '适应');
  app.datasetDiagViewport.scale = 2;
  assert.equal(app.datasetDiagZoomLabel(), '200%');
  app.datasetDiagViewport.scale = 1;

  // Double-click and keyboard shortcuts delegate to AnimaImageViewport (1x <-> 2x, +, -, 0)
  const prevMatchMedia = global.window.matchMedia;
  const prevDocVp = global.document;
  const fakeStage = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    querySelector: () => null,
  };
  global.document = {
    getElementById: id => (id === 'datasetDiagModalStage' ? fakeStage : null),
    querySelector: () => null,
  };
  global.window.matchMedia = () => ({ matches: true });
  try {
    app.datasetDiagViewport.doubleClickZoom({ preventDefault() {}, clientX: 200, clientY: 200 });
    assert.equal(app.datasetDiagViewport.scale, 2);
    assert.ok(styleSyncs >= 1);
    app.datasetDiagViewport.doubleClickZoom({ preventDefault() {}, clientX: 200, clientY: 200 });
    assert.equal(app.datasetDiagViewport.scale, 1);

    app.datasetDiagModalKeydown({ key: '+', preventDefault() {} });
    assert.ok(app.datasetDiagViewport.scale > 1.15);
    app.datasetDiagModalKeydown({ key: '-', preventDefault() {} });
    assert.ok(Math.abs(app.datasetDiagViewport.scale - 1) < 1e-6);
    app.datasetDiagModalKeydown({ key: '=', preventDefault() {} });
    assert.ok(app.datasetDiagViewport.scale > 1.15);
    app.datasetDiagModalKeydown({ key: '0', preventDefault() {} });
    assert.equal(app.datasetDiagViewport.scale, 1);
  } finally {
    global.document = prevDocVp;
    if (prevMatchMedia === undefined) delete global.window.matchMedia;
    else global.window.matchMedia = prevMatchMedia;
  }

  // Page editor supports valid jump and clamps out-of-range
  app.openDatasetDiagPageEditor();
  assert.equal(app.datasetDiagPageEditing, true);
  assert.equal(app.datasetDiagPageDraft, '1');
  app.commitDatasetDiagPageEdit({ currentTarget: { value: '2' } });
  assert.equal(app.datasetDiagPageEditing, false);
  assert.deepEqual(opened, ['img2']);

  app.openDatasetDiagPageEditor();
  app.commitDatasetDiagPageEdit({ currentTarget: { value: '999' } });
  assert.deepEqual(opened, ['img2', 'img3']);

  // Modifier keys are never hijacked by modal shortcuts
  let navDelta = 0;
  app.datasetDiagModalNav = delta => { navDelta += delta; };
  app.datasetDiagViewport.reset(false);
  app.datasetDiagModalKeydown({ key: 'ArrowRight', ctrlKey: true, preventDefault() { throw new Error('must not prevent'); } });
  app.datasetDiagModalKeydown({ key: '0', metaKey: true, preventDefault() { throw new Error('must not prevent'); } });
  app.datasetDiagModalKeydown({ key: 'ArrowLeft', altKey: true, preventDefault() { throw new Error('must not prevent'); } });
  assert.equal(navDelta, 0);

  // Samples sub-dialog open/filter/close and parent shortcut guard
  let patchedSamples = 0;
  app._patchDatasetDiagSamplesModal = () => { patchedSamples += 1; };
  app.datasetDiagModalDetail = {
    image: { image_id: 'img1', name: '1.png', non_finite_count: 1 },
    samples: [
      { epoch: 1, step: 10, timestep: 0.5, loss: 0.25, residual: -0.1, non_finite: false },
      { epoch: 2, step: 20, timestep: 0.8, loss: null, residual: null, non_finite: true },
    ],
  };
  app.openDatasetDiagSamplesModal('nan');
  assert.equal(app.datasetDiagSamplesModalOpen, true);
  assert.equal(app.datasetDiagSamplesFilter, 'nan');
  assert.equal(patchedSamples, 1);

  // Parent modal shortcuts are paused while the standalone samples dialog is open
  app.datasetDiagModalKeydown({ key: 'ArrowRight', preventDefault() { throw new Error('must not prevent'); } });
  assert.equal(navDelta, 0);

  app.setDatasetDiagSamplesFilter('all');
  assert.equal(app.datasetDiagSamplesFilter, 'all');
  assert.equal(patchedSamples, 2);

  app.closeDatasetDiagSamplesModal();
  assert.equal(app.datasetDiagSamplesModalOpen, false);

  // Navigating to another image or closing parent modal closes any open samples sub-dialog
  app.openDatasetDiagSamplesModal('all');
  assert.equal(app.datasetDiagSamplesModalOpen, true);
  app.closeDatasetDiagModal();
  assert.equal(app.datasetDiagSamplesModalOpen, false);
  assert.equal(app.datasetDiagSamplesFilter, 'all');

  // Post-exit cleanup clears #datasetDiagModalImg src and bumps _datasetDiagImgSeq
  const removedAttrs = [];
  const fakeStageImg = { dataset: { ddPendingFull: '/preview.png' }, removeAttribute(attr) { removedAttrs.push(attr); } };
  const prevDoc = global.document;
  global.document = { ...prevDoc, getElementById: id => (id === 'datasetDiagModalImg' ? fakeStageImg : null) };
  try {
    const seqBefore = app._datasetDiagImgSeq || 0;
    app.clearDatasetDiagModal();
    assert.ok(app._datasetDiagImgSeq > seqBefore);
    assert.deepEqual(removedAttrs, ['src']);
    assert.equal(fakeStageImg.dataset.ddPendingFull, undefined);
  } finally {
    global.document = prevDoc;
  }
});

test('cold modal open pre-settles fast detail fetch and cached reopen skips unchanged background re-patch', async () => {
  const detailResp = {
    revision: 'r1',
    samples_total: 4,
    image: { image_id: 'fast1', name: 'fast.png', mean_residual: 0.2, slope: -0.02, non_finite_count: 0 },
    caption: { exists: true, text: '1girl' },
    file_info: { size: 512, width: 512, height: 512 },
  };
  let gate = deferred();
  const prevFetch = global.fetch;
  let patchCount = 0;
  let patchDetailNullCount = 0;
  global.fetch = () => gate.promise;
  try {
    const app = makeApp({
      datasetDiagData: snapshot('r1', { by_image: [detailResp.image] }),
      _patchDatasetDiagModal() {
        patchCount += 1;
        if (!this.datasetDiagModalDetail) patchDetailNullCount += 1;
      },
    });

    // Cold open settles quickly -> enters once with detail already loaded and zero pending flash
    app.openDatasetDiagModal('fast1');
    assert.equal(app.datasetDiagModalOpen, false);
    assert.equal(app._datasetDiagModalOpening, true);
    assert.equal(patchCount, 0);
    gate.resolve(response(detailResp));
    await flush();
    assert.equal(app.datasetDiagModalOpen, true);
    assert.equal(app._datasetDiagModalOpening, false);
    assert.equal(patchCount, 1);
    assert.equal(patchDetailNullCount, 0);

    // Close and reopen from cache -> opens immediately once and unchanged background refresh skips re-patching
    app.closeDatasetDiagModal();
    patchCount = 0;
    gate = deferred();
    app.openDatasetDiagModal('fast1');
    assert.equal(app.datasetDiagModalOpen, true);
    assert.equal(patchCount, 1);
    gate.resolve(response(detailResp));
    await flush();
    assert.equal(patchCount, 1, 'Unchanged cached refresh must not wipe right panel DOM mid-entrance');

    // Close while a cold pre-settle is in flight -> cancels opening cleanly
    app.closeDatasetDiagModal();
    gate = deferred();
    app.openDatasetDiagModal('cold2');
    assert.equal(app.datasetDiagModalOpen, false);
    assert.equal(app._datasetDiagModalOpening, true);
    app.closeDatasetDiagModal();
    assert.equal(app._datasetDiagModalOpening, false);
    gate.resolve(response({ ...detailResp, image: { ...detailResp.image, image_id: 'cold2' } }));
    await flush();
    assert.equal(app.datasetDiagModalOpen, false);
  } finally {
    global.fetch = prevFetch;
  }
});

test('P0-5: 90ms modal opening race with 6s poll cancels on missing/segment change, refreshes when valid, and resets loading in finally', async () => {
  const prevFetch = global.fetch;
  const imgA = { image_id: 'imgA', name: 'a.png', count: 4, comparable_count: 4, mean_residual: 0.25, is_reg: false };
  const imgB = { image_id: 'imgB', name: 'b.png', count: 4, comparable_count: 4, mean_residual: 0.15, is_reg: false };
  const detailOf = (id, rev, residual = 0.25) => ({
    revision: rev,
    samples_total: 4,
    image: { image_id: id, name: `${id}.png`, mean_residual: residual, slope: -0.01, non_finite_count: 0 },
    caption: { exists: true, text: '1girl' },
    file_info: { exists: true, size: 512, width: 512, height: 512 },
  });

  let detailGate = deferred();
  let mainGate = deferred();
  const detailCalls = [];
  global.fetch = url => {
    const s = String(url);
    if (s.includes('/image?')) {
      const id = paramsFrom(s).get('image_id');
      detailCalls.push(id);
      return detailGate.promise;
    }
    return mainGate.promise;
  };

  try {
    // 1. Slow detail (>90ms) commits dialog open via 90ms settle timer while loading, then finishes cleanly
    const app = makeApp({ datasetDiagData: snapshot('r1', { by_image: [imgA, imgB] }) });
    app.openDatasetDiagModal('imgA');
    assert.equal(app._datasetDiagModalOpening, true);
    assert.equal(app.datasetDiagModalOpen, false);
    assert.equal(app.datasetDiagModalLoading, true);
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.equal(app._datasetDiagModalOpening, false);
    assert.equal(app.datasetDiagModalOpen, true);
    assert.equal(app.datasetDiagModalLoading, true);
    detailGate.resolve(response(detailOf('imgA', 'r1')));
    await flush();
    assert.equal(app.datasetDiagModalLoading, false);
    assert.equal(app.datasetDiagModalDetail.image.image_id, 'imgA');
    app.closeDatasetDiagModal();
    app.clearDatasetDiagModal();
    app._datasetDiagDetailCache.clear();

    // 2. 6s poll removes pending image during 90ms opening window -> aborts opening cleanly
    detailGate = deferred();
    mainGate = deferred();
    app.openDatasetDiagModal('imgA');
    assert.equal(app._datasetDiagModalOpening, true);
    const pollDrop = app.loadDatasetDiagnostics({ silent: true, force: true });
    mainGate.resolve(response(snapshot('r2', { by_image: [imgB] })));
    await pollDrop;
    assert.equal(app._datasetDiagModalOpening, false);
    assert.equal(app.datasetDiagModalOpen, false);
    detailGate.resolve(response(detailOf('imgA', 'r1')));
    await flush();
    assert.equal(app.datasetDiagModalOpen, false);
    app.clearDatasetDiagModal();
    assert.equal(app.datasetDiagModalLoading, false);

    // 2b. Failed/aborted detail fetch resets datasetDiagModalLoading and controller in finally
    detailGate = deferred();
    app.datasetDiagModalOpen = true;
    app.datasetDiagModalImageId = 'imgB';
    const failFetch = app.loadDatasetDiagImageDetail('imgB', true);
    assert.equal(app.datasetDiagModalLoading, true);
    assert.ok(app._datasetDiagModalController);
    detailGate.reject(new Error('network error'));
    await failFetch;
    assert.equal(app.datasetDiagModalLoading, false);
    assert.equal(app._datasetDiagModalController, null);
    assert.equal(app.datasetDiagModalError, 'loadFailed');
    app.closeDatasetDiagModal();
    app.clearDatasetDiagModal();

    // 3. 6s poll updates same-segment snapshot while image stays present during 90ms window -> re-fetches detail
    detailGate = deferred();
    mainGate = deferred();
    detailCalls.length = 0;
    app.datasetDiagData = snapshot('r1', { by_image: [imgA, imgB] });
    app.openDatasetDiagModal('imgA');
    assert.equal(detailCalls.length, 1);
    const pollKeep = app.loadDatasetDiagnostics({ silent: true, force: true });
    mainGate.resolve(response(snapshot('r2', { by_image: [{ ...imgA, count: 5 }, imgB] })));
    await pollKeep;
    assert.equal(detailCalls.length, 2);
    detailGate.resolve(response(detailOf('imgA', 'r2', 0.12)));
    await flush();
    assert.equal(app.datasetDiagModalOpen, true);
    assert.equal(app.datasetDiagModalLoading, false);
    assert.equal(app.datasetDiagModalDetail.image.mean_residual, 0.12);
    app.closeDatasetDiagModal();
  } finally {
    global.fetch = prevFetch;
  }
});

test('reg_mode propagates across main fetch, hover prefetch light cache, modal nav, and P1-11 lifecycle cleanup', async () => {
  const prevFetch = global.fetch;
  const prevDoc = global.document;
  const requests = [];
  const trainImg = { image_id: 't1', name: 'train.png', count: 5, comparable_count: 5, mean_residual: 0.3, is_reg: false, status: 'attention' };
  const regImg = { image_id: 'r1', name: 'reg.png', count: 5, comparable_count: 5, mean_residual: -0.2, is_reg: true, status: 'easy' };

  global.fetch = async url => {
    const s = String(url);
    const p = paramsFrom(s);
    requests.push({ url: s, params: p });
    if (s.includes('/image?')) {
      const id = p.get('image_id');
      const light = p.get('include_local') === 'false';
      return response({
        revision: 'rev1',
        samples_total: 5,
        image: id === 'r1' ? regImg : trainImg,
        caption: light ? undefined : { exists: true, text: '1girl, solo', editor_safe: true },
        file_info: light ? undefined : { exists: true, dir_path: 'D:/ds', abs_path: `D:/ds/${id}.png`, width: 512, height: 512, size: 1024 },
      });
    }
    const mode = p.get('reg_mode') || 'exclude';
    return response(snapshot('rev1', {
      reg_mode: mode,
      summary: { images_total: 2, has_reg_images: true, counts: {} },
      by_image: [trainImg, regImg],
    }));
  };

  try {
    const app = makeApp({ datasetDiagRegMode: 'exclude' });
    await app.loadDatasetDiagnostics();
    assert.equal(requests[0].params.get('reg_mode'), 'exclude');
    assert.equal(app.datasetDiagEffectiveRegMode, 'exclude');

    // Modal nav excludes regImg when reg_mode === 'exclude'
    app.datasetDiagModalImageId = 't1';
    assert.deepEqual(app._datasetDiagModalNavList().map(i => i.image_id), ['t1']);

    // Hover prefetch sends reg_mode + include_local=false + include_profile=false and marks light cache
    app.previewDatasetDiagImage('t1');
    await new Promise(resolve => setTimeout(resolve, 75));
    const prefetchReq = requests.find(r => r.url.includes('/image?') && r.params.get('include_local') === 'false');
    assert.ok(prefetchReq, 'Expected lightweight hover prefetch request');
    assert.equal(prefetchReq.params.get('reg_mode'), 'exclude');
    assert.equal(prefetchReq.params.get('include_profile'), 'false');
    const lightKey = app._datasetDiagDetailCacheKey(app._datasetDiagSource(), 't1');
    assert.equal(app._datasetDiagLightCacheKeys.has(lightKey), true);

    // Opening modal on lightly-prefetched image still fetches full detail (caption + file_info)
    app.openDatasetDiagModal('t1');
    await flush();
    const fullReq = requests.filter(r => r.url.includes('/image?') && r.params.get('image_id') === 't1').at(-1);
    assert.equal(fullReq.params.get('include_local'), null);
    assert.equal(fullReq.params.get('reg_mode'), 'exclude');
    assert.equal(app.datasetDiagModalDetail.caption.exists, true);
    assert.equal(app._datasetDiagLightCacheKeys.has(lightKey), false);
    app.closeDatasetDiagModal();

    // Switching reg_mode to 'only' reloads baseline with reg_mode=only and restricts modal nav to reg images
    app.setDatasetDiagRegMode('only');
    await flush();
    const onlyMain = requests.filter(r => !r.url.includes('/image?')).at(-1);
    assert.equal(onlyMain.params.get('reg_mode'), 'only');
    assert.equal(app.datasetDiagEffectiveRegMode, 'only');
    app.openDatasetDiagModal('r1');
    await flush();
    assert.deepEqual(app._datasetDiagModalNavList().map(i => i.image_id), ['r1']);
    const onlyDetail = requests.filter(r => r.url.includes('/image?') && r.params.get('image_id') === 'r1').at(-1);
    assert.equal(onlyDetail.params.get('reg_mode'), 'only');

    // P1-11: clearDatasetDiagModal disconnects ROs, aborts bind controller, clears right panel, and resets viewport
    let disconnected = 0;
    let aborted = 0;
    const fakeRight = {
      _ddModalROs: [{ disconnect() { disconnected += 1; } }],
      _ddBindCtrl: { abort() { aborted += 1; } },
      _ddRenderedImageId: 'r1',
      _ddWasPending: true,
      innerHTML: '<section>stale</section>',
    };
    const fakeImg = { dataset: { ddPendingFull: '/full.png' }, removeAttribute() {} };
    global.document = {
      ...prevDoc,
      getElementById: id => (id === 'datasetDiagModalRight' ? fakeRight : (id === 'datasetDiagModalImg' ? fakeImg : null)),
    };
    app.datasetDiagViewport.scale = 2.5;
    app.closeDatasetDiagModal();
    app.clearDatasetDiagModal();
    assert.equal(disconnected, 1);
    assert.equal(aborted, 1);
    assert.equal(fakeRight.innerHTML, '');
    assert.equal(fakeRight._ddRenderedImageId, '');
    assert.equal(app.datasetDiagViewport.scale, 1);

    // P1-11: _resetDatasetDiagForRun cancels pending preview fetch and bumps snapshot version
    const verBefore = app._datasetDiagSnapshotVersion;
    app.previewDatasetDiagImage('t1');
    assert.ok(app._datasetDiagPreviewFetchTimer);
    app._resetDatasetDiagForRun('run:output/other');
    assert.equal(app._datasetDiagPreviewFetchTimer, 0);
    assert.equal(app._datasetDiagPreviewFetchKey, '');
    assert.ok(app._datasetDiagSnapshotVersion > verBefore);

    // _revealDatasetDiagModalAfterOpen schedules neighbor prefetch on open when detail is ready
    let scheduledFor = '';
    app._scheduleDatasetDiagNeighborPrefetch = id => { scheduledFor = id; };
    app.datasetDiagModalOpen = true;
    app.datasetDiagModalImageId = 'r1';
    app.datasetDiagModalDetail = { image: regImg };
    global.document = {
      ...prevDoc,
      getElementById: id => (id === 'datasetDiagModal' ? { isConnected: true, open: true } : null),
    };
    app._revealDatasetDiagModalAfterOpen();
    assert.equal(scheduledFor, 'r1');
  } finally {
    global.fetch = prevFetch;
    global.document = prevDoc;
  }
});

test('no-reg datasets align overview/detail revision, keep poll stability, cache grouped images, and avoid stack overflow', async () => {
  const prevFetch = global.fetch;
  const requests = [];
  const trainImg = { image_id: 't1', name: 'train.png', directory: 'D:/ds/big', dir_label: 'ds/big', count: 5, comparable_count: 5, mean_residual: 0.2, mean_loss: 0.25, is_reg: false, status: 'attention' };

  global.fetch = async url => {
    const s = String(url);
    const p = paramsFrom(s);
    requests.push({ url: s, params: p });
    if (s.includes('/image?')) {
      return response({
        revision: 'rev-noreg',
        reg_mode: 'all',
        samples_total: 5,
        image: trainImg,
        samples: [{ step: 1, epoch: 1, timestep: 0.5, loss: 0.25, residual: 0.0 }],
        trajectory: [],
      });
    }
    return response(snapshot('rev-noreg', {
      reg_mode: 'all',
      summary: { images_total: 1, has_reg_images: false, counts: {} },
      by_image: [trainImg],
    }));
  };

  try {
    const app = makeApp({ datasetDiagRegMode: 'exclude' });
    await app.loadDatasetDiagnostics();
    assert.equal(requests[0].params.get('reg_mode'), 'exclude');
    assert.equal(app.datasetDiagEffectiveRegMode, 'all');

    let syncedOverlay = 0;
    let syncedTrajectory = 0;
    app._syncDatasetDiagNoiseOverlay = () => { syncedOverlay += 1; };
    app._syncDatasetDiagScatterTrajectory = () => { syncedTrajectory += 1; };
    app.previewDatasetDiagImage('t1');
    await new Promise(resolve => setTimeout(resolve, 75));

    const cacheKey = app._datasetDiagDetailCacheKey(app._datasetDiagSource(), 't1');
    assert.equal(app._datasetDiagDetailCache.has(cacheKey), true);
    assert.equal(syncedOverlay, 2);
    assert.equal(syncedTrajectory, 2);

    // Next poll preserves user preference ('exclude') and forwards known_revision
    await app.loadDatasetDiagnostics({ silent: true });
    const pollReq = requests.filter(r => !r.url.includes('/image?')).at(-1);
    assert.equal(pollReq.params.get('reg_mode'), 'exclude');
    assert.equal(pollReq.params.get('known_revision'), 'rev-noreg');
  } finally {
    global.fetch = prevFetch;
  }

  // No-reg -> has-reg transition keeps stored 'only' preference and allows re-selecting 'only' if effective reg_mode was 'all'
  const regTransitionReqs = [];
  let hasRegNow = false;
  global.fetch = async url => {
    const p = paramsFrom(String(url));
    regTransitionReqs.push(p);
    const reqMode = p.get('reg_mode') || 'exclude';
    return response(snapshot(hasRegNow ? `rev-${reqMode}` : 'rev-empty', {
      reg_mode: hasRegNow ? reqMode : 'all',
      summary: { images_total: hasRegNow ? 1 : 2, has_reg_images: hasRegNow, counts: {} },
      by_image: [trainImg],
    }));
  };
  try {
    const regApp = makeApp({ datasetDiagRegMode: 'only' });
    await regApp.loadDatasetDiagnostics();
    assert.equal(regApp.datasetDiagEffectiveRegMode, 'all');
    hasRegNow = true;
    await regApp.refreshDatasetDiagnostics();
    assert.equal(regTransitionReqs.at(-1).get('reg_mode'), 'only');
    assert.equal(regApp.datasetDiagEffectiveRegMode, 'only');

    // Manual refresh while modal is open must not double-increment local_generation on the follow-up /image fetch
    const raceReqs = [];
    global.fetch = async url => {
      const s = String(url);
      raceReqs.push({ url: s, params: paramsFrom(s) });
      if (s.includes('/image?')) {
        return response({ revision: 'rev-refresh', reg_mode: 'all', samples_total: 1, image: trainImg, samples: [], trajectory: [] });
      }
      return response(snapshot('rev-refresh', {
        reg_mode: 'all',
        summary: { images_total: 1, has_reg_images: false, counts: {} },
        by_image: [trainImg],
      }));
    };
    const raceApp = makeApp({ datasetDiagRegMode: 'exclude' });
    await raceApp.loadDatasetDiagnostics();
    raceApp.datasetDiagModalOpen = true;
    raceApp.datasetDiagModalImageId = 't1';
    await raceApp.refreshDatasetDiagnostics();
    await flush();
    const followUpImgReq = raceReqs.filter(r => r.url.includes('/image?')).at(-1);
    assert.ok(followUpImgReq);
    assert.equal(followUpImgReq.params.get('refresh_local'), null);
  } finally {
    global.fetch = prevFetch;
  }

  // _datasetDiagGroupedImages hits cache when passed filtered array, and _datasetDiagModalNavList avoids spread overflow
  const hugeItems = Array.from({ length: 130000 }, (_, i) => ({
    image_id: `id${i}`, name: `img${i}.png`, directory: 'D:/ds/huge', dir_label: 'ds/huge',
    subset: '0-0', subset_label: '0-0', is_reg: false, count: 3, mean_residual: 0.1, mean_loss: 0.2, slope: 0.0,
  }));
  const hugeData = snapshot('rev-huge', {
    summary: { images_total: hugeItems.length, has_reg_images: false, counts: {} },
    by_image: [
      ...hugeItems,
      { image_id: 'other', name: 'other.png', directory: 'D:/ds/other', dir_label: 'ds/other', subset: '0-1', subset_label: '0-1', is_reg: false, count: 3, mean_residual: 0.1, mean_loss: 0.2, slope: 0.0 },
    ],
  });
  const navApp = makeApp({
    datasetDiagData: hugeData,
    datasetDiagSubTab: 'images',
    datasetDiagGroupByFolder: true,
    datasetDiagModalImageId: 'id0',
  });
  const filtered = navApp._datasetDiagFilteredImages();
  const g1 = navApp._datasetDiagGroupedImages(filtered);
  const g2 = navApp._datasetDiagGroupedImages(filtered);
  assert.strictEqual(g1, g2);
  const navList = navApp._datasetDiagModalNavList();
  assert.equal(navList.length, hugeData.by_image.length);
});

function makeImagesScrollFixture() {
  const makeClassList = () => {
    const set = new Set();
    return {
      add(...cs) { cs.forEach(c => set.add(c)); },
      remove(...cs) { cs.forEach(c => set.delete(c)); },
      toggle(cls, force) {
        const on = force === undefined ? !set.has(cls) : Boolean(force);
        if (on) set.add(cls);
        else set.delete(cls);
        return on;
      },
      contains: cls => set.has(cls),
    };
  };
  const toolbarEl = {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const makeSlot = () => ({
    innerHTML: '',
    hidden: false,
    scrollTop: 0,
    contains: () => false,
    classList: makeClassList(),
    querySelector() { return null; },
  });
  const imagesSlot = {
    ...makeSlot(),
    set innerHTML(markup) {
      this.markup = markup;
      this.root = { classList: makeClassList() };
      this.body = Object.assign(new EventTarget(), {
        classList: makeClassList(), scrollTop: 0, scrollLeft: 0,
      });
    },
    get innerHTML() { return this.markup || ''; },
    querySelector(sel) {
      if (sel === '[data-dd-images-toolbar]' && this.body) return toolbarEl;
      if (sel === '[data-dd-images-body]') return this.body;
      if (sel === '.m-dd-images') return this.root;
      return null;
    },
  };
  const fields = {
    '[data-dd-slot="heading"]': makeSlot(),
    '[data-dd-slot="analysis"]': makeSlot(),
    '[data-dd-slot="images"]': imagesSlot,
  };
  const shell = { querySelector: selector => fields[selector] || null };
  const panel = {
    scrollTop: 0,
    dataset: {},
    firstElementChild: shell,
    querySelector: sel => (sel === '[data-dd-shell="1"]' ? shell : null),
    classList: makeClassList(),
  };
  global.document = {
    activeElement: null,
    getElementById: () => ({ querySelector: () => panel }),
    querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null),
  };

  const app = makeApp({
    _builtTab: 'dataset',
    _datasetDiagSourceKey: 'run:output/example',
    _datasetDiagLoaded: true,
    datasetDiagSubTab: 'images',
    datasetDiagData: snapshot('r1'),
    runDetailData: {},
    renderDashboard() { this._renderTab('dataset', {}, null, null, k => this.tMonitor(k), true); },
    _renderDatasetDiagAnalysisCard: () => '<div data-dd-analysis></div>',
    _bindDatasetDiagCharts() {},
    _renderDatasetDiagHeading: () => '<div class="m-dd-topbar"></div>',
    _renderDatasetDiagImagesCard: () => '<section class="m-dd-images"><div data-dd-images-toolbar></div><div data-dd-images-body>body</div></section>',
    _patchDatasetDiagImagesToolbar: () => true,
    _renderDatasetDiagImagesBodyHtml: () => 'updated-body',
  });
  app.renderDashboard();
  const scroll = () => {
    imagesSlot.body.scrollTop = 140;
    imagesSlot.body.scrollLeft = 24;
    imagesSlot.body.dispatchEvent(new Event('scroll'));
  };
  const position = () => [imagesSlot.body.scrollTop, imagesSlot.body.scrollLeft];
  return { app, imagesSlot, scroll, position };
}

test('a poll that rebuilds the images toolbar restores both scroll axes on the new body', () => {
  const { app, imagesSlot, scroll, position } = makeImagesScrollFixture();
  const previousBody = imagesSlot.body;
  assert.equal(imagesSlot.root.classList.contains('is-scrolled'), false);
  scroll();
  assert.equal(imagesSlot.root.classList.contains('is-scrolled'), true);

  app.datasetDiagData = snapshot('r2', { by_directory: [{ directory: 'a' }, { directory: 'b' }] });
  app._datasetDiagSnapshotVersion += 1;
  app.renderDashboard();
  assert.notEqual(imagesSlot.body, previousBody);
  assert.deepEqual(position(), [140, 24]);
  assert.equal(imagesSlot.root.classList.contains('is-scrolled'), true);
  app.setDatasetDiagPreset('attention');
  assert.deepEqual(position(), [0, 0]);
  assert.equal(imagesSlot.root.classList.contains('is-scrolled'), false);
});

test('returning from overview preserves image scroll only for the same filter', () => {
  const { app, scroll, position } = makeImagesScrollFixture();
  scroll();
  app.setDatasetDiagSubTab('overview');
  app.setDatasetDiagSubTab('images');
  assert.deepEqual(position(), [140, 24]);
  app.setDatasetDiagSubTab('overview');
  app.openDatasetDiagPreset('attention');
  assert.deepEqual(position(), [0, 0]);
});

test('changing the run segment or minimum sample count resets image scroll', async () => {
  const { app, scroll, position } = makeImagesScrollFixture();
  global.fetch = async () => response(snapshot('r2', { run_id: 'new' }));
  scroll();
  await app.setDatasetDiagRunId('new');
  assert.deepEqual(position(), [0, 0]);
  scroll();
  await app.setDatasetDiagMinCount(5);
  assert.deepEqual(position(), [0, 0]);
});

test('leaving images view or dataset tab releases imagesSlot DOM and restores scroll on return', () => {
  const { app, imagesSlot, scroll, position } = makeImagesScrollFixture();
  const dsPanel = global.document.querySelector('.m-tab-panel[data-tab="dataset"]');
  const otherPanel = {
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: { tab: 'overview' },
    hidden: true,
    firstElementChild: {},
    contains: () => false,
    querySelector: () => null,
  };
  const prevGetById = global.document.getElementById;
  const prevRaf = global.requestAnimationFrame;
  global.requestAnimationFrame = () => 0;
  global.document.getElementById = id => (id === 'monitorTabContent'
    ? {
      querySelectorAll: () => [dsPanel, otherPanel],
      querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? dsPanel : otherPanel),
    }
    : prevGetById(id));
  let marqueeCleared = 0;
  app._clearDatasetDiagImagesMarquee = () => { marqueeCleared += 1; };
  app._summaryStatus = () => ({ state: 'FINISHED' });
  app._renderOverviewTab = () => 'overview';
  app._patchOverviewStatus = () => {};
  app.initMonitorParams = () => {};
  app.trainParamsVersion = 0;

  try {
    scroll();
    // 1. Leaving to overview clears imagesSlot and marquee, then restores scroll when returning
    app.setDatasetDiagSubTab('overview');
    assert.equal(imagesSlot.innerHTML, '');
    assert.equal(dsPanel._ddImagesSig, '');
    assert.ok(marqueeCleared >= 1);

    app.setDatasetDiagSubTab('images');
    assert.notEqual(imagesSlot.innerHTML, '');
    assert.deepEqual(position(), [140, 24]);
    assert.equal(imagesSlot.root.classList.contains('is-scrolled'), true);

    // 2. Leaving top-level dataset tab clears imagesSlot, then restores scroll when returning
    app._renderTab('overview', {}, null, null, k => app.tMonitor(k), true);
    assert.equal(imagesSlot.innerHTML, '');
    assert.equal(dsPanel._ddImagesSig, '');

    app._renderTab('dataset', {}, null, null, k => app.tMonitor(k), true);
    assert.notEqual(imagesSlot.innerHTML, '');
    assert.deepEqual(position(), [140, 24]);
    assert.equal(imagesSlot.root.classList.contains('is-scrolled'), true);
  } finally {
    global.document.getElementById = prevGetById;
    if (prevRaf === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = prevRaf;
  }
});

test('sorting and view mode switches reset datasetDiagDisplayLimit back to 120', () => {
  const app = makeApp({ datasetDiagData: snapshot('r1') });
  assert.equal(app.datasetDiagDisplayLimit, 120);

  app.showMoreDatasetDiagImages();
  app.showMoreDatasetDiagImages();
  assert.equal(app.datasetDiagDisplayLimit, 360);

  app.setDatasetDiagSort('residual_asc');
  assert.equal(app.datasetDiagDisplayLimit, 120);

  app.showMoreDatasetDiagImages();
  assert.equal(app.datasetDiagDisplayLimit, 240);
  app.toggleDatasetDiagColumnSort('loss');
  assert.equal(app.datasetDiagDisplayLimit, 120);

  app.showMoreDatasetDiagImages();
  assert.equal(app.datasetDiagDisplayLimit, 240);
  app.setDatasetDiagViewMode('table');
  assert.equal(app.datasetDiagDisplayLimit, 120);

  // Calling with the same value is a no-op and preserves current limit
  app.showMoreDatasetDiagImages();
  assert.equal(app.datasetDiagDisplayLimit, 240);
  app.setDatasetDiagSort('loss_desc');
  app.setDatasetDiagViewMode('table');
  assert.equal(app.datasetDiagDisplayLimit, 240);
});

test('image cards and rows omit per-item Alpine directives and use delegated modal open + on-demand marquee', () => {
  const img = {
    image_id: 'img_1', name: 'very_long_filename_for_marquee_test.png',
    image: 'D:/ds/very_long_filename_for_marquee_test.png', dir_label: 'ds',
    resolution: '1024x1024', count: 5, epochs: 3, mean_loss: 0.25, mean_residual: 0.15,
    slope: -0.02, status: 'learning', thumb_url: '/api/image-preview?path=img_1',
  };
  const modalApp = makeApp({ datasetDiagData: snapshot('r1', { by_image: [img] }) });
  const cardHtml = modalApp._ddImageCardHtml(k => modalApp.tMonitor(k), img);
  const rowHtml = modalApp._ddImageTableRowHtml(k => modalApp.tMonitor(k), img, 0.5);
  for (const html of [cardHtml, rowHtml]) {
    assert.ok(!html.includes('@click'));
    assert.ok(!html.includes('@keydown'));
    assert.ok(!html.includes('x-loop-marquee'));
    assert.ok(html.includes('data-dd-image-id="img_1"'));
  }

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cs) => cs.forEach(c => set.add(c)),
      remove: (...cs) => cs.forEach(c => set.delete(c)),
      contains: c => set.has(c),
    };
  };
  const opened = [];
  const marqueeCalls = [];
  let marqueeDestroyed = 0;
  const prevInit = global.window.initLoopMarquee;
  const prevDoc = global.document;
  global.window.initLoopMarquee = (el, source, opts) => {
    marqueeCalls.push({ el, source, opts });
    el.classList.add('loop-marquee');
    source.classList.add('loop-marquee-text');
    return () => { marqueeDestroyed += 1; };
  };
  global.document = { activeElement: null };

  try {
    const spanEl = { classList: makeClassList() };
    const nameEl = {
      clientWidth: 80,
      scrollWidth: 160,
      firstElementChild: spanEl,
      classList: makeClassList(),
    };
    const innerBtn = {
      closest: sel => (sel.includes('button') ? innerBtn : sel.includes('data-dd-image-id') ? cardEl : null),
    };
    const cardEl = {
      dataset: { ddImageId: 'img_1' },
      contains: node => node === cardEl || node === nameEl || node === innerBtn,
      matches: () => false,
      querySelector: sel => (sel.includes('.m-dd-card-name') ? nameEl : null),
      closest: sel => (sel.includes('data-dd-image-id') || sel.includes('.m-dd-card') ? cardEl : null),
    };
    const imagesBody = Object.assign(new EventTarget(), {
      contains: node => node === cardEl || node === nameEl || node === innerBtn,
    });

    const app = makeApp({
      openDatasetDiagModal(id, opener) { opened.push([id, opener]); },
    });
    app._bindDatasetDiagImagesBodyEvents(imagesBody);
    // Calling twice does not duplicate listeners
    app._bindDatasetDiagImagesBodyEvents(imagesBody);

    // Delegated click & keyboard open modal with openerEl
    const clickEv = new Event('click');
    Object.defineProperty(clickEv, 'target', { value: cardEl });
    imagesBody.dispatchEvent(clickEv);
    assert.deepEqual(opened, [['img_1', cardEl]]);

    let prevented = false;
    const spaceEv = Object.assign(new Event('keydown'), { key: ' ', preventDefault() { prevented = true; } });
    Object.defineProperty(spaceEv, 'target', { value: cardEl });
    imagesBody.dispatchEvent(spaceEv);
    assert.equal(prevented, true);
    assert.equal(opened.length, 2);

    // Nested interactive button or modifier keys do not trigger modal open
    const innerClick = new Event('click');
    Object.defineProperty(innerClick, 'target', { value: innerBtn });
    imagesBody.dispatchEvent(innerClick);
    const ctrlEnter = Object.assign(new Event('keydown'), { key: 'Enter', ctrlKey: true });
    Object.defineProperty(ctrlEnter, 'target', { value: cardEl });
    imagesBody.dispatchEvent(ctrlEnter);
    assert.equal(opened.length, 2);

    // Non-overflowing text skips initLoopMarquee
    nameEl.scrollWidth = 60;
    const overNonOverflow = new Event('pointerover');
    Object.defineProperty(overNonOverflow, 'target', { value: cardEl });
    imagesBody.dispatchEvent(overNonOverflow);
    assert.equal(marqueeCalls.length, 0);

    // Overflowing text initializes marquee on hover and cleans up on leave
    nameEl.scrollWidth = 160;
    const overEv = new Event('pointerover');
    Object.defineProperty(overEv, 'target', { value: cardEl });
    imagesBody.dispatchEvent(overEv);
    assert.equal(marqueeCalls.length, 1);
    assert.equal(marqueeCalls[0].opts.bounce, true);
    assert.equal(nameEl.classList.contains('loop-marquee'), true);

    const outEv = new Event('pointerout');
    Object.defineProperty(outEv, 'target', { value: cardEl });
    imagesBody.dispatchEvent(outEv);
    assert.equal(marqueeDestroyed, 1);
    assert.equal(nameEl.classList.contains('loop-marquee'), false);
    assert.equal(spanEl.classList.contains('loop-marquee-text'), false);
  } finally {
    global.window.initLoopMarquee = prevInit;
    global.document = prevDoc;
  }
});

function createMiniDomElement(tag = 'div') {
  const classSet = new Set();
  const listeners = new Map();
  const styleObj = {
    setProperty(k, v) { this[k] = String(v); },
  };
  const el = {
    tagName: tag.toUpperCase(),
    attrs: {},
    dataset: {},
    children: [],
    parentNode: null,
    style: styleObj,
    hidden: false,
    inert: false,
    scrollTop: 0,
    scrollLeft: 0,
    _text: '',
    _html: '',
    classList: {
      add(...cs) { cs.forEach(c => String(c).split(/\s+/).filter(Boolean).forEach(x => classSet.add(x))); },
      remove(...cs) { cs.forEach(c => String(c).split(/\s+/).filter(Boolean).forEach(x => classSet.delete(x))); },
      toggle(c, force) {
        const on = force === undefined ? !classSet.has(c) : Boolean(force);
        if (on) classSet.add(c);
        else classSet.delete(c);
        return on;
      },
      contains: c => classSet.has(c),
    },
    setAttribute(k, v) {
      const str = String(v);
      this.attrs[k] = str;
      if (k === 'class') {
        classSet.clear();
        str.split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
      } else if (k === 'style') {
        for (const decl of str.split(';')) {
          const idx = decl.indexOf(':');
          if (idx > 0) styleObj[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
        }
      } else if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = str;
      }
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      if (child) child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    replaceWith(other) {
      if (!this.parentNode || !other) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) {
        other.parentNode = this.parentNode;
        this.parentNode.children.splice(idx, 1, other);
        this.parentNode = null;
      }
    },
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSimple(cur, sel)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of (listeners.get(ev.type) || [])) fn(ev);
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const branches = String(sel).split(',').map(s => s.trim()).filter(Boolean);
      const out = [];
      const seen = new Set();
      const visit = node => {
        for (const child of node.children) {
          for (const branch of branches) {
            const parts = branch.split(/\s+/).filter(Boolean);
            if (matchesDescendant(child, parts, this)) {
              if (!seen.has(child)) {
                seen.add(child);
                out.push(child);
              }
              break;
            }
          }
          visit(child);
        }
      };
      visit(this);
      return out;
    },
  };
  Object.defineProperty(el, 'className', {
    get() { return Array.from(classSet).join(' '); },
    set(val) { el.setAttribute('class', val); },
  });
  Object.defineProperty(el, 'textContent', {
    get() {
      if (!el.children.length) return el._text;
      return el._text + el.children.map(c => c.textContent).join('');
    },
    set(val) {
      el.children.length = 0;
      el._text = String(val);
    },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(val) {
      el._html = String(val);
      el.children.length = 0;
      el._text = '';
      parseHtmlInto(el, el._html);
    },
  });
  return el;
}

function matchesSimple(node, sel) {
  if (!node || !node.tagName) return false;
  let rest = sel.trim();
  const tagMatch = /^([a-zA-Z0-9_-]+)/.exec(rest);
  if (tagMatch) {
    if (node.tagName !== tagMatch[1].toUpperCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }
  while (rest.length) {
    if (rest.startsWith('#')) {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m || node.attrs.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('.')) {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m || !node.classList.contains(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('[')) {
      const m = /^\[([^=\]]+)(?:="([^"]*)")?\]/.exec(rest);
      if (!m) return false;
      const val = node.getAttribute(m[1]);
      if (m[2] !== undefined ? val !== m[2] : val === null) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

function matchesDescendant(node, parts, root) {
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let idx = parts.length - 2;
  let cur = node.parentNode;
  while (idx >= 0 && cur && cur !== root) {
    if (matchesSimple(cur, parts[idx])) idx -= 1;
    cur = cur.parentNode;
  }
  return idx < 0;
}

function parseHtmlInto(root, html) {
  const voidTags = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'rect', 'circle', 'path', 'line', 'polyline']);
  const stack = [root];
  const tokenRe = /<(\/)?([a-zA-Z0-9-]+)([^>]*?)(\/)?>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    if (m[5] !== undefined) {
      stack[stack.length - 1]._text += m[5];
      continue;
    }
    const isClose = !!m[1];
    const tag = m[2].toLowerCase();
    const selfClose = !!m[4] || voidTags.has(tag);
    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node = createMiniDomElement(tag);
    const attrStr = m[3] || '';
    const attrRe = /([@:a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(attrStr)) !== null) {
      const rawVal = am[2] !== undefined ? am[2] : '';
      const decodedVal = rawVal
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      node.setAttribute(am[1], decodedVal);
    }
    stack[stack.length - 1].appendChild(node);
    if (!selfClose) stack.push(node);
  }
}

test('Chromium hidden=true zeroing scrollTop/scrollLeft still preserves grid vertical and narrow table scroll across images -> overview -> images', () => {
  const prevDoc = global.document;
  const makeClassList = () => {
    const set = new Set();
    return {
      add(...cs) { cs.forEach(c => set.add(c)); },
      remove(...cs) { cs.forEach(c => set.delete(c)); },
      toggle(cls, force) {
        const on = force === undefined ? !set.has(cls) : Boolean(force);
        if (on) set.add(cls);
        else set.delete(cls);
        return on;
      },
      contains: cls => set.has(cls),
    };
  };
  const toolbarEl = { querySelector: () => null, querySelectorAll: () => [] };
  const makeSlot = () => ({
    innerHTML: '', hidden: false, scrollTop: 0, contains: () => false, classList: makeClassList(), querySelector() { return null; },
  });
  // Emulate Chromium behavior: when imagesSlot.hidden becomes true (display: none), reading scrollTop/scrollLeft returns 0 and resets scroll offsets.
  const imagesSlot = {
    ...makeSlot(),
    _hidden: false,
    get hidden() { return this._hidden; },
    set hidden(val) {
      this._hidden = Boolean(val);
      if (this._hidden && this.body) {
        this.body._scrollTop = 0;
        this.body._scrollLeft = 0;
      }
    },
    set innerHTML(markup) {
      this.markup = markup;
      this.root = { classList: makeClassList() };
      const body = Object.assign(new EventTarget(), {
        classList: makeClassList(),
        _scrollTop: 0,
        _scrollLeft: 0,
        get scrollTop() { return imagesSlot._hidden ? 0 : this._scrollTop; },
        set scrollTop(v) { this._scrollTop = imagesSlot._hidden ? 0 : v; },
        get scrollLeft() { return imagesSlot._hidden ? 0 : this._scrollLeft; },
        set scrollLeft(v) { this._scrollLeft = imagesSlot._hidden ? 0 : v; },
      });
      this.body = body;
    },
    get innerHTML() { return this.markup || ''; },
    querySelector(sel) {
      if (sel === '[data-dd-images-toolbar]' && this.body) return toolbarEl;
      if (sel === '[data-dd-images-body]') return this.body;
      if (sel === '.m-dd-images') return this.root;
      return null;
    },
  };
  const fields = {
    '[data-dd-slot="heading"]': makeSlot(),
    '[data-dd-slot="analysis"]': makeSlot(),
    '[data-dd-slot="images"]': imagesSlot,
  };
  const shell = { querySelector: selector => fields[selector] || null };
  const panel = {
    scrollTop: 0, dataset: {}, firstElementChild: shell,
    querySelector: sel => (sel === '[data-dd-shell="1"]' ? shell : null),
    classList: makeClassList(),
  };
  global.document = {
    activeElement: null,
    getElementById: () => ({ querySelector: () => panel }),
    querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null),
  };

  try {
    const app = makeApp({
      _builtTab: 'dataset',
      _datasetDiagSourceKey: 'run:output/example',
      _datasetDiagLoaded: true,
      datasetDiagSubTab: 'images',
      datasetDiagViewMode: 'grid',
      datasetDiagData: snapshot('r1'),
      runDetailData: {},
      renderDashboard() { this._renderTab('dataset', {}, null, null, k => this.tMonitor(k), true); },
      _renderDatasetDiagAnalysisCard: () => '<div data-dd-analysis></div>',
      _bindDatasetDiagCharts() {},
      _renderDatasetDiagHeading: () => '<div class="m-dd-topbar"></div>',
      _renderDatasetDiagImagesCard: () => '<section class="m-dd-images"><div data-dd-images-toolbar></div><div data-dd-images-body>body</div></section>',
      _patchDatasetDiagImagesToolbar: () => true,
      _renderDatasetDiagImagesBodyHtml: () => 'updated-body',
    });
    app.renderDashboard();

    // 1. Grid vertical scroll preserved across images -> overview -> images
    imagesSlot.body.scrollTop = 320;
    imagesSlot.body.dispatchEvent(new Event('scroll'));
    app.setDatasetDiagSubTab('overview');
    assert.equal(imagesSlot.hidden, true);
    assert.equal(imagesSlot.innerHTML, '');
    app.setDatasetDiagSubTab('images');
    assert.equal(imagesSlot.hidden, false);
    assert.equal(imagesSlot.body.scrollTop, 320);

    // 2. Narrow table vertical + horizontal scroll preserved across images -> overview -> images
    app.setDatasetDiagViewMode('table');
    imagesSlot.body.scrollTop = 260;
    imagesSlot.body.scrollLeft = 88;
    imagesSlot.body.dispatchEvent(new Event('scroll'));
    app.setDatasetDiagSubTab('overview');
    assert.equal(imagesSlot.hidden, true);
    app.setDatasetDiagSubTab('images');
    assert.equal(imagesSlot.hidden, false);
    assert.deepEqual([imagesSlot.body.scrollTop, imagesSlot.body.scrollLeft], [260, 88]);
  } finally {
    global.document = prevDoc;
  }
});

test('_disconnectDatasetDiagUI releases imagesSlot DOM and clears marquee when leaving monitor route', () => {
  const prevDoc = global.document;
  const { app, imagesSlot, scroll } = makeImagesScrollFixture();
  const dsPanel = global.document.querySelector('.m-tab-panel[data-tab="dataset"]');
  let disconnectedRO = 0;
  let clearedMarquee = 0;
  app._clearDatasetDiagImagesMarquee = () => { clearedMarquee += 1; };
  const modalRight = { _ddModalROs: [{ disconnect() { disconnectedRO += 1; } }] };
  const prevGetById = global.document.getElementById;
  global.document.getElementById = id => (id === 'datasetDiagModalRight' ? modalRight : prevGetById(id));
  try {
    scroll();
    assert.notEqual(imagesSlot.innerHTML, '');
    assert.notEqual(dsPanel._ddImagesSig, '');
    app._disconnectDatasetDiagUI();
    assert.equal(imagesSlot.innerHTML, '');
    assert.equal(dsPanel._ddImagesSig, '');
    assert.ok(clearedMarquee >= 1);
    assert.equal(disconnectedRO, 1);
    assert.deepEqual(modalRight._ddModalROs, []);
  } finally {
    global.document = prevDoc;
  }
});

test('isDataPoll patches same-order images in-place preserving DOM/img nodes, skips untouched cards, and falls back on order change', () => {
  const prevDoc = global.document;
  const imgA = {
    image_id: 'a1', name: 'alpha.png', image: 'D:/ds/g1/alpha.png', directory: 'D:/ds/g1', dir_label: 'g1',
    resolution: '512x512', count: 5, epochs: 2, mean_loss: 0.25, mean_residual: 0.22, slope: 0.02,
    status: 'attention', is_reg: false, thumb_url: '/api/image-preview?id=a1&v=1',
  };
  const imgB = {
    image_id: 'b1', name: 'beta.png', image: 'D:/ds/g2/beta.png', directory: 'D:/ds/g2', dir_label: 'g2',
    resolution: '768x768', count: 6, epochs: 2, mean_loss: 0.12, mean_residual: -0.15, slope: -0.03,
    status: 'learning', is_reg: false, thumb_url: '/api/image-preview?id=b1&v=1',
  };
  const imgC = {
    image_id: 'c1', name: 'gamma.png', image: 'D:/ds/g2/gamma.png', directory: 'D:/ds/g2', dir_label: 'g2',
    resolution: '768x768', count: 4, epochs: 2, mean_loss: 0.18, mean_residual: 0.05, slope: -0.01,
    status: 'normal', is_reg: false, thumb_url: '/api/image-preview?id=c1&v=1',
  };

  const makeSnap = (rev, items, dirResidual = 0.1) => snapshot(rev, {
    summary: { images_total: items.length, counts: { attention: 1, learning: 1, normal: 1 } },
    by_directory: [
      { directory: 'D:/ds/g1', label: 'g1', count: 10, images: 1, mean_residual: 0.22 },
      { directory: 'D:/ds/g2', label: 'g2', count: 10, images: 2, mean_residual: dirResidual },
    ],
    by_image: items,
  });

  const headingSlot = createMiniDomElement('div');
  const analysisSlot = createMiniDomElement('div');
  const imagesSlot = createMiniDomElement('div');
  const shell = createMiniDomElement('div');
  shell.setAttribute('data-dd-shell', '1');
  headingSlot.setAttribute('data-dd-slot', 'heading');
  analysisSlot.setAttribute('data-dd-slot', 'analysis');
  imagesSlot.setAttribute('data-dd-slot', 'images');
  shell.appendChild(headingSlot);
  shell.appendChild(analysisSlot);
  shell.appendChild(imagesSlot);
  const panel = createMiniDomElement('div');
  panel.appendChild(shell);
  const monitorContent = { querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null) };
  global.document = {
    activeElement: null,
    getElementById: id => (id === 'monitorTabContent' ? monitorContent : null),
    querySelector: sel => (sel === '.m-tab-panel[data-tab="dataset"]' ? panel : null),
    createElement: tag => createMiniDomElement(tag),
  };

  try {
    const app = makeApp({
      _builtTab: 'dataset',
      _datasetDiagSourceKey: 'run:output/example',
      _datasetDiagLoaded: true,
      datasetDiagSubTab: 'images',
      datasetDiagViewMode: 'grid',
      datasetDiagSort: 'residual_desc',
      datasetDiagGroupByFolder: true,
      datasetDiagData: makeSnap('r1', [imgA, imgB, imgC]),
      runDetailData: {},
      renderDashboard() { this._renderTab('dataset', {}, null, null, k => this.tMonitor(k), true); },
      _renderDatasetDiagAnalysisCard: () => '<div data-dd-analysis></div>',
      _bindDatasetDiagCharts() {},
      _renderDatasetDiagHeading: () => '<div class="m-dd-topbar"></div>',
      _patchDatasetDiagHeading() {},
      escapeJsString: s => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    });
    app.renderDashboard();

    const bodyEl = imagesSlot.querySelector('[data-dd-images-body]');
    const cardA0 = bodyEl.querySelector('.m-dd-card[data-dd-image-id="a1"]');
    const imgElA0 = cardA0.querySelector('img');
    const cardB0 = bodyEl.querySelector('.m-dd-card[data-dd-image-id="b1"]');
    let touchedUntouchedCard = false;
    const origBQuery = cardB0.querySelector.bind(cardB0);
    cardB0.querySelector = sel => {
      touchedUntouchedCard = true;
      return origBQuery(sel);
    };

    // 1. Live data poll updates only a1 (same order & structure) -> in-place patch keeps DOM refs & skips b1
    const imgAUpdated = {
      ...imgA, count: 9, mean_residual: 0.15, slope: -0.04, status: 'learning',
      thumb_url: '/api/image-preview?id=a1&v=2',
    };
    app.datasetDiagData = makeSnap('r2', [imgAUpdated, imgB, imgC], -0.05);
    app._datasetDiagImageFilterCache = null;
    app._datasetDiagGroupedCache = null;
    app._datasetDiagUpdatedIds = new Set(['a1']);
    app._datasetDiagSnapshotVersion += 1;
    app.renderDashboard();

    assert.strictEqual(bodyEl.querySelector('.m-dd-card[data-dd-image-id="a1"]'), cardA0);
    assert.strictEqual(cardA0.querySelector('img'), imgElA0);
    assert.equal(imgElA0.getAttribute('src'), '/api/image-preview?id=a1&v=2');
    assert.equal(cardA0.querySelector('.m-dd-card-res b').textContent, '+15.0%');
    assert.equal(cardA0.querySelector('.m-dd-card-flag').classList.contains('is-info'), true);
    assert.equal(touchedUntouchedCard, false, 'Untouched card must skip DOM reads/writes when _datasetDiagUpdatedIds is non-empty');

    // 2. Table view patches residual bar, loss, count/epochs, status in-place when maxAbs changes
    app.setDatasetDiagGroupByFolder(false);
    app.setDatasetDiagViewMode('table');
    app.renderDashboard();
    const rowA0 = bodyEl.querySelector('.m-dd-table-row[data-dd-image-id="a1"]');
    const rowB0 = bodyEl.querySelector('.m-dd-table-row[data-dd-image-id="b1"]');
    const prevBWidth = rowB0.querySelector('.m-gauge-fill').style.width;

    const imgAExtreme = { ...imgAUpdated, count: 12, epochs: 3, mean_loss: 0.45, mean_residual: 1.5, slope: 0.05, status: 'attention' };
    app.datasetDiagData = makeSnap('r3', [imgAExtreme, imgB, imgC]);
    app._datasetDiagImageFilterCache = null;
    app._datasetDiagGroupedCache = null;
    app._datasetDiagUpdatedIds = new Set(['a1']);
    app._datasetDiagSnapshotVersion += 1;
    app.renderDashboard();

    assert.strictEqual(bodyEl.querySelector('.m-dd-table-row[data-dd-image-id="a1"]'), rowA0);
    assert.strictEqual(bodyEl.querySelector('.m-dd-table-row[data-dd-image-id="b1"]'), rowB0);
    assert.equal(rowA0.querySelector('.m-dd-num-val').textContent, '+150.0%');
    assert.equal(rowA0.querySelectorAll('.m-dd-num')[1].textContent, '12 / 3');
    assert.equal(rowA0.querySelectorAll('.m-dd-num')[2].textContent, '0.4500');
    assert.equal(rowA0.querySelector('.m-dd-pill').classList.contains('is-warn'), true);
    assert.notEqual(rowB0.querySelector('.m-gauge-fill').style.width, prevBWidth, 'maxAbs increase rescales gauge bar on untouched rows');

    // 3. Order change in new snapshot falls back to full body rebuild
    const imgBHigher = { ...imgB, mean_residual: 2.0, status: 'attention' };
    app.datasetDiagData = makeSnap('r4', [imgAExtreme, imgBHigher, imgC]);
    app._datasetDiagImageFilterCache = null;
    app._datasetDiagGroupedCache = null;
    app._datasetDiagUpdatedIds = new Set(['b1']);
    app._datasetDiagSnapshotVersion += 1;
    app.renderDashboard();

    const rowsAfterReorder = bodyEl.querySelectorAll('.m-dd-table-row');
    assert.deepEqual(rowsAfterReorder.map(r => r.dataset.ddImageId), ['b1', 'a1', 'c1']);
    assert.notStrictEqual(rowsAfterReorder[0], rowB0);
    assert.notStrictEqual(rowsAfterReorder[1], rowA0);

    // 4. Peer-baseline residual shift + is_reg badge toggle updates cards & rows in place even when _datasetDiagUpdatedIds only lists image A
    app.datasetDiagRegMode = 'all';
    app.datasetDiagEffectiveRegMode = '';
    app.setDatasetDiagSort('name_asc');
    app.setDatasetDiagViewMode('grid');
    app.datasetDiagData = makeSnap('r5', [
      { ...imgA, is_reg: true, mean_residual: 0.10 },
      { ...imgB, count: 6, mean_residual: -0.138 },
      { ...imgC, is_reg: false, mean_residual: 0.05 },
    ]);
    app._datasetDiagImageFilterCache = null;
    app._datasetDiagGroupedCache = null;
    app._datasetDiagSnapshotVersion += 1;
    app.renderDashboard();

    const peerGridBody = imagesSlot.querySelector('[data-dd-images-body]');
    const peerCardA = peerGridBody.querySelector('.m-dd-card[data-dd-image-id="a1"]');
    const peerCardB = peerGridBody.querySelector('.m-dd-card[data-dd-image-id="b1"]');
    const peerCardC = peerGridBody.querySelector('.m-dd-card[data-dd-image-id="c1"]');
    assert.ok(peerCardA.querySelector('.m-dd-card-reg'));
    assert.equal(peerCardC.querySelector('.m-dd-card-reg'), null);

    app.datasetDiagData = makeSnap('r6', [
      { ...imgA, count: 6, is_reg: null, mean_residual: 0.11 },
      { ...imgB, count: 6, mean_residual: -0.141 },
      { ...imgC, is_reg: true, mean_residual: 0.05 },
    ]);
    app._datasetDiagImageFilterCache = null;
    app._datasetDiagGroupedCache = null;
    app._datasetDiagUpdatedIds = new Set(['a1']);
    app._datasetDiagSnapshotVersion += 1;
    app.renderDashboard();

    assert.strictEqual(peerGridBody.querySelector('.m-dd-card[data-dd-image-id="b1"]'), peerCardB);
    assert.equal(peerCardB.querySelector('.m-dd-card-res b').textContent, '-14.1%', 'Peer image B residual must update in grid even if omitted from _datasetDiagUpdatedIds');
    assert.equal(peerCardA.querySelector('.m-dd-card-reg'), null, 'is_reg true -> null must remove badge in grid');
    assert.ok(peerCardC.querySelector('.m-dd-card-reg'), 'is_reg false -> true must add badge in grid');

    // Same check in table view
    app.setDatasetDiagViewMode('table');
    app.renderDashboard();
    const peerTableBody = imagesSlot.querySelector('[data-dd-images-body]');
    const peerRowA = peerTableBody.querySelector('.m-dd-table-row[data-dd-image-id="a1"]');
    const peerRowB = peerTableBody.querySelector('.m-dd-table-row[data-dd-image-id="b1"]');
    const peerRowC = peerTableBody.querySelector('.m-dd-table-row[data-dd-image-id="c1"]');
    assert.equal(peerRowA.querySelector('.output-dir-tag'), null);
    assert.ok(peerRowC.querySelector('.output-dir-tag'));

    app.datasetDiagData = makeSnap('r7', [
      { ...imgA, count: 7, is_reg: true, mean_residual: 0.12 },
      { ...imgB, count: 6, mean_residual: -0.149 },
      { ...imgC, is_reg: null, mean_residual: 0.05 },
    ]);
    app._datasetDiagImageFilterCache = null;
    app._datasetDiagGroupedCache = null;
    app._datasetDiagUpdatedIds = new Set(['a1']);
    app._datasetDiagSnapshotVersion += 1;
    app.renderDashboard();

    assert.strictEqual(peerTableBody.querySelector('.m-dd-table-row[data-dd-image-id="b1"]'), peerRowB);
    assert.equal(peerRowB.querySelector('.m-dd-num-val').textContent, '-14.9%', 'Peer image B residual must update in table even if omitted from _datasetDiagUpdatedIds');
    assert.ok(peerRowA.querySelector('.output-dir-tag'), 'is_reg null -> true must add badge in table');
    assert.equal(peerRowC.querySelector('.output-dir-tag'), null, 'is_reg true -> null must remove badge in table');
  } finally {
    global.document = prevDoc;
  }
});
