const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend, composeMixins, response, deferred } = require('./helpers.cjs');

loadGlobalFrontend(['shared/utils', 'monitor/core', 'monitor/render']);

function makeApp(overrides = {}) {
  return Object.assign(composeMixins(window.utilsMixin, window.monitorCoreMixin, window.monitorRenderMixin), {
    currentRoute: 'monitor-dashboard',
    monitorTab: 'dataset',
    selectedRunDir: 'output/example',
    tMonitor: (_, fallback) => fallback,
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
    renderDashboard() { this._renderTab('dataset', {}, null, null, (_, fallback) => fallback, false); },
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

test('always-expanded analysis slot renders quadrant by default, switches to groups, and falls back when multi-group disappears', () => {
  const fields = Object.fromEntries(['heading', 'analysis', 'images'].map(name => [
    `[data-dd-slot="${name}"]`, { innerHTML: '', contains: () => false, querySelector: () => null },
  ]));
  const shell = { querySelector: selector => fields[selector] || null };
  const panel = { firstElementChild: shell, querySelector: () => shell, classList: { add() {} } };
  global.document = { getElementById: () => ({ querySelector: () => panel }) };
  let analysisRenderCount = 0;
  let lastAnalysisMode = '';
  const multiGroupSnapshot = snapshot('r1', {
    by_resolution: [
      { key: '512x512', label: '512x512', count: 2, images: 1, mean_loss: 0.2, mean_residual: 0.1 },
      { key: '768x768', label: '768x768', count: 2, images: 1, mean_loss: 0.3, mean_residual: -0.1 },
    ],
  });
  const app = makeApp({
    _builtTab: 'dataset', _datasetDiagSourceKey: 'run:output/example', _datasetDiagLoaded: true,
    datasetDiagData: multiGroupSnapshot, runDetailData: {},
    _renderDatasetDiagHeading: () => 'header',
    _renderDatasetDiagAnalysisCard(t, data) {
      analysisRenderCount++;
      lastAnalysisMode = this._ddActiveAnalysisMode(data);
      return `analysis:${lastAnalysisMode}:${this.datasetDiagGroupDim}:${this.datasetDiagGroupFilter?.key || ''}`;
    },
    _renderDatasetDiagImagesCard: () => 'images',
    _bindDatasetDiagCharts() {},
  });
  const render = () => app._renderTab('dataset', {}, null, null, (_, fallback) => fallback, true);

  render();
  assert.equal(lastAnalysisMode, 'quadrant');
  assert.equal(analysisRenderCount, 1);
  assert.equal(fields['[data-dd-slot="images"]'].innerHTML, 'images');

  // Changing image-only filters in quadrant mode must not re-render analysis slot
  app.setDatasetDiagPreset('attention');
  render();
  assert.equal(analysisRenderCount, 1);

  // Switching to groups mode and updating group dim / filter updates analysis slot
  app.setDatasetDiagHeroMode('groups');
  render();
  assert.equal(lastAnalysisMode, 'groups');
  assert.equal(analysisRenderCount, 2);

  app.setDatasetDiagGroupDim('subset');
  render();
  assert.equal(analysisRenderCount, 3);
  assert.match(fields['[data-dd-slot="analysis"]'].innerHTML, /^analysis:groups:subset:/);

  app.toggleDatasetDiagGroupFilter('resolution', '512x512', '512 × 512');
  render();
  assert.equal(analysisRenderCount, 4);
  assert.match(fields['[data-dd-slot="analysis"]'].innerHTML, /512x512$/);

  // Loading a snapshot without >=2 groups in any dimension falls back from groups to quadrant
  const singleGroupSnapshot = snapshot('r2');
  app._applyDatasetDiagDefaults(JSON.stringify(['run:output/example', 'old']), singleGroupSnapshot);
  assert.equal(app.datasetDiagHeroMode, 'quadrant');
  app.datasetDiagHeroMode = 'groups';
  assert.equal(app._ddActiveAnalysisMode(singleGroupSnapshot), 'quadrant');
});

test('group filter matches every membership and clears conflicting image filters', () => {
  const img = {
    image_id: 'image', name: 'item.png', resolution: '512x512', resolutions: ['512x512', '768x768'],
    subset: '0-0', subsets: ['0-0', '0-1'], status: 'insufficient_reference', is_reg: null,
  };
  const app = makeApp({
    datasetDiagData: snapshot('r1', { by_image: [img] }),
    datasetDiagPreset: 'attention', datasetDiagRegMode: 'only', datasetDiagSearch: 'missing',
  });
  app.toggleDatasetDiagGroupFilter('resolution', '768x768');
  assert.deepEqual(app._datasetDiagFilteredImages(), [img]);
  app.toggleDatasetDiagGroupFilter('subset', '0-1');
  app.setDatasetDiagRegMode('exclude');
  assert.deepEqual(app._datasetDiagFilteredImages(), [img]);
  app.setDatasetDiagRegMode('only');
  assert.deepEqual(app._datasetDiagFilteredImages(), []);
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
  const render = () => app._renderDatasetDiagQuadrantSvg(wrap, svg, app.datasetDiagData, 800, (_, fallback) => fallback);
  await app.loadDatasetDiagnostics();
  app.toggleDatasetDiagGroupFilter('resolution', '768x768');
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
  app._renderDatasetDiagQuadrantSvg(wrap, svg, data, 800, (_, fallback) => fallback);
  assert.equal(wrap._ddChartState.coords.length, 1000);
  const shown = new Set(wrap._ddChartState.coords.map(point => point.image_id));
  for (const id of [53, 987, 1234, 4401, 5100, 7097]) assert.ok(shown.has(String(id)));
  assert.equal(shown.has('insufficient'), false);
  assert.match(coverage.textContent, /1000 \/ 130000/);
  assert.match(coverage.textContent, /130001/);
});
