const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobalFrontend, composeMixins, response, readRepo } = require('./helpers.cjs');

const zhDict = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));

global.requestAnimationFrame = () => 0;
global.document = {
  hidden: false,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.window = {};
loadGlobalFrontend(['shared/utils', 'monitor/logs', 'monitor/core', 'monitor/render']);

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
    { bin: 0, timestep_from: 0.0, timestep_to: 0.5, count: 15, mean_loss: 0.14 },
    { bin: 1, timestep_from: 0.5, timestep_to: 1.0, count: 15, mean_loss: 0.34 },
  ],
  by_resolution: [
    { key: '768x1024', label: '768x1024', count: 15, images: 2, mean_loss: 0.28, mean_residual: 0.28 },
    { key: '1024x1024', label: '1024x1024', count: 15, images: 2, mean_loss: 0.18, mean_residual: -0.25 },
  ],
  by_batch_size: [{ key: '2', label: 'bs 2', count: 30, images: 4, mean_loss: 0.24, mean_residual: 0.0 }],
  by_subset: [
    { key: '0-0', label: '10_char', is_reg: false, count: 22, images: 3, mean_loss: 0.25, mean_residual: 0.08 },
    { key: '0-1', label: '1_reg', is_reg: true, count: 8, images: 1, mean_loss: 0.19, mean_residual: -0.18 },
  ],
  by_directory: [
    { key: 'D:/ds/char', label: 'ds/char', full_path: 'D:/ds/char', count: 22, images: 3, mean_loss: 0.25, mean_residual: 0.08 },
  ],
  by_image: [
    {
      image_id: 'aaaaaaaaaaaaaaaa', image: 'D:/ds/char/bad.png', name: 'bad.png',
      directory: 'D:/ds/char', dir_label: 'ds/char', resolution: '768x1024', subset: '0-0', subset_label: '10_char',
      is_reg: false, count: 8, non_finite_count: 0, epochs: 4, mean_loss: 0.32, mean_residual: 0.42, slope: 0.03,
      noise_zones: { high: { count: 4, mean_residual: 0.52 }, mid: { count: 2, mean_residual: 0.35 }, low: { count: 2, mean_residual: 0.20 } },
      status: 'attention', local_available: true, thumb_url: '/api/image-preview?path=aaaaaaaaaaaaaaaa', preview_url: '',
    },
    {
      image_id: 'bbbbbbbbbbbbbbbb', image: 'D:/ds/char/learn.png', name: 'learn.png',
      directory: 'D:/ds/char', dir_label: 'ds/char', resolution: '768x1024', subset: '0-0', subset_label: '10_char',
      is_reg: false, count: 8, non_finite_count: 0, epochs: 4, mean_loss: 0.29, mean_residual: 0.25, slope: -0.06,
      noise_zones: { high: { count: 3, mean_residual: 0.28 }, mid: { count: 3, mean_residual: 0.24 }, low: { count: 2, mean_residual: 0.21 } },
      status: 'learning', local_available: true, thumb_url: '', preview_url: '',
    },
    {
      image_id: 'cccccccccccccccc', image: 'D:/ds/char/nan.png', name: 'nan.png',
      directory: 'D:/ds/char', dir_label: 'ds/char', resolution: '1024x1024', subset: '0-0', subset_label: '10_char',
      is_reg: false, count: 6, non_finite_count: 1, epochs: 3, mean_loss: 0.21, mean_residual: 0.05, slope: -0.01,
      noise_zones: { high: { count: 2, mean_residual: 0.08 }, mid: { count: 2, mean_residual: 0.05 }, low: { count: 2, mean_residual: 0.02 } },
      status: 'non_finite', local_available: true, thumb_url: '', preview_url: '',
    },
    {
      image_id: 'dddddddddddddddd', image: 'D:/ds/reg/reg1.png', name: 'reg1.png',
      directory: 'D:/ds/reg', dir_label: 'ds/reg', resolution: '1024x1024', subset: '0-1', subset_label: '1_reg',
      is_reg: true, count: 8, non_finite_count: 0, epochs: 4, mean_loss: 0.14, mean_residual: -0.32, slope: -0.02,
      noise_zones: { high: { count: 3, mean_residual: -0.30 }, mid: { count: 3, mean_residual: -0.34 }, low: { count: 2, mean_residual: -0.31 } },
      status: 'easy', local_available: true, thumb_url: '', preview_url: '',
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

test('dataset diagnostics filtering, sorting, group linkage, multi-run merge, and streamlined rendering', async () => {
  const seenUrls = [];
  global.fetch = async url => {
    seenUrls.push(String(url));
    if (String(url).includes('/api/monitor/dataset-diagnostics?')) {
      return response(SAMPLE_DATA);
    }
    throw new Error('Unexpected fetch: ' + url);
  };
  const a = makeApp();
  await a.loadDatasetDiagnostics();
  assert.equal(a.datasetDiagTabCount, 4);
  // Prioritizes non_finite on initial load when NaN samples exist
  assert.equal(a.datasetDiagPreset, 'non_finite');
  assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['nan.png']);

  // Includes merged "all" option when multiple runs exist
  const runOpts = a._ddRunOptions();
  assert.equal(runOpts[0].value, 'all');
  assert.equal(runOpts.length, 3);

  a.setDatasetDiagPreset('attention');
  assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['bad.png']);

  a.setDatasetDiagPreset('easy');
  assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['reg1.png']);

  a.setDatasetDiagPreset('all');
  assert.equal(a._datasetDiagFilteredImages().length, 4);

  a.toggleDatasetDiagGroupFilter('resolution', '768x1024', '768 × 1024');
  assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['bad.png', 'learn.png']);

  a.clearDatasetDiagGroupFilter();
  a.setDatasetDiagRegMode('only');
  assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['reg1.png']);

  a.setDatasetDiagRegMode('all');
  a.setDatasetDiagSearch('learn');
  assert.deepEqual(a._datasetDiagFilteredImages().map(i => i.name), ['learn.png']);

  a.resetDatasetDiagFilters();
  a.setDatasetDiagSort('slope_asc');
  assert.equal(a._datasetDiagFilteredImages()[0].name, 'learn.png');

  const html = a._renderDatasetDiagTab(k => a.tMonitor(k));
  assert.ok(html.includes('m-dd-overview'));
  assert.ok(html.includes('id="ddInfoBtn"'));
  assert.ok(html.includes("openParameterDoc('dataset-diagnostics')"));
  assert.ok(html.includes('<section class="m-console-card m-dd-analysis" data-dd-analysis>'));
  assert.ok(!html.includes('<details class="m-console-card m-diagnostic-details m-dd-analysis"'));
  assert.ok(html.includes('id="ddAnalysisModeQuadrant"'));
  assert.ok(html.includes('id="ddAnalysisModeTimestep"'));
  assert.ok(html.includes('id="ddAnalysisModeGroups"'));
  assert.ok(html.includes('m-dd-grid'));
  assert.ok(html.includes('m-dd-chart-bar'));
  assert.ok(html.includes('m-dd-readout-bar'));
  assert.ok(html.includes('bad.png'));
  assert.ok(html.includes('768 × 1024'));
  // Inline method explanation block and AI styles must stay absent
  assert.ok(!html.includes('m-diagnostic-method-content'));
  assert.ok(!html.includes('m-diagnostic-rules'));
  assert.ok(!html.includes('m-dd-tile'));
  assert.ok(!html.includes('m-diagnostic-verdict'));
  assert.ok(!html.includes('m-dd-locate-btn'));
  assert.ok(!html.includes('m-view-header'));
  // Grid cards must render 3 rows so high-residual, NaN, and reg cards all keep slope visible
  const gridHtml = html.slice(html.indexOf('<div class="m-dd-grid">'));
  assert.ok(!gridHtml.includes('m-dd-gauge'));
  assert.ok(!gridHtml.includes('<i aria-hidden'));
  assert.ok(gridHtml.includes('m-dd-card-top'));
  assert.ok(gridHtml.includes('m-dd-card-metrics'));
  assert.ok(gridHtml.includes('m-dd-card-foot'));
  const cards = gridHtml.split('<article class="m-dd-card"').slice(1);
  assert.equal(cards.length, 4);
  for (const card of cards) {
    assert.ok(card.includes('/Epoch'), 'expected slope on every card: ' + card);
    assert.ok(card.includes('m-dd-card-flag'), 'expected status flag on every card: ' + card);
  }
  const regCard = cards.find(card => card.includes('reg1.png'));
  assert.ok(regCard && regCard.includes('正则') && regCard.includes('低于均值'));
  const learningCard = cards.find(card => card.includes('learn.png'));
  assert.ok(learningCard && learningCard.includes('m-dd-card-flag is-info'));

  // Residual colors use theme-aware color-mix()
  assert.match(a._ddResidualColor(0.25), /^color-mix\(/);
  assert.match(a._ddResidualColor(-0.2), /^color-mix\(/);
  assert.match(a._ddResidualColor(0.0), /^color-mix\(/);

  // Groups mode renders group comparison table inside the unified analysis card
  a.setDatasetDiagHeroMode('groups');
  const groupsAnalysisHtml = a._renderDatasetDiagAnalysisCard(k => a.tMonitor(k), SAMPLE_DATA);
  assert.ok(groupsAnalysisHtml.includes('m-dd-groups'));
  assert.ok(groupsAnalysisHtml.includes('m-dd-groups-bar'));
  assert.ok(groupsAnalysisHtml.includes('id="ddGroupDim_resolution"'));

  // Hero noise zone strip appears in timestep mode without inline method block
  a.setDatasetDiagHeroMode('timestep');
  const heroNoiseHtml = a._renderDatasetDiagHeroSlot(k => a.tMonitor(k), SAMPLE_DATA);
  assert.ok(heroNoiseHtml.includes('m-dd-zones-strip'));
  assert.ok(!heroNoiseHtml.includes('m-diagnostic-method-content'));
  assert.ok(!heroNoiseHtml.includes('m-diagnostic-rules'));

  // Omit group comparison mode tab and card when no dimension has >= 2 groups
  const singleGroup = structuredClone(SAMPLE_DATA);
  singleGroup.by_resolution = [SAMPLE_DATA.by_resolution[0]];
  singleGroup.by_subset = [SAMPLE_DATA.by_subset[0]];
  singleGroup.by_directory = [SAMPLE_DATA.by_directory[0]];
  assert.equal(a._renderDatasetDiagGroupsCard(k => a.tMonitor(k), singleGroup), '');
  const singleGroupAnalysisHtml = a._renderDatasetDiagAnalysisCard(k => a.tMonitor(k), singleGroup);
  assert.ok(!singleGroupAnalysisHtml.includes('id="ddAnalysisModeGroups"'));

  // Switching run_id (including merged "all") forwards run_id parameter
  a.setDatasetDiagRunId('all');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seenUrls.some(u => u.includes('run_id=all')));

  a.setDatasetDiagRunId('r0');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seenUrls.some(u => u.includes('run_id=r0')));
});

test('hero SVG builder maintains equal height and uses 1000-to-0 left-to-right timestep axis', () => {
  const a = makeApp({ datasetDiagData: SAMPLE_DATA });
  const makeFakeWrap = () => {
    const svg = {
      attrs: {},
      innerHTML: '',
      classList: { toggle() {} },
      setAttribute(k, v) { this.attrs[k] = v; },
    };
    return {
      svg,
      wrap: { querySelector() { return null; } },
      stage: { clientWidth: 680 },
    };
  };

  // Quadrant scatter
  const q = makeFakeWrap();
  a._renderDatasetDiagHeroSvg(q.wrap, q.stage, q.svg);
  assert.equal(q.wrap._ddChartState.kind, 'scatter');
  assert.equal(q.wrap._ddChartState.coords.length, 4);
  assert.equal(q.svg.attrs.height, '236');
  assert.ok(q.svg.innerHTML.includes('m-dd-alert-zone'));
  assert.ok(q.svg.innerHTML.includes('m-dd-dot-nan-ring'));
  assert.ok(q.svg.innerHTML.includes('m-dd-crosshair'));
  assert.ok(q.svg.innerHTML.includes('style="fill:color-mix('));
  assert.ok(q.svg.innerHTML.includes('>-2%</text>'));
  assert.ok(!q.svg.innerHTML.includes(' pp'));

  // Timestep baseline maintains exact 236px height and runs 1000 (left) -> 0 (right)
  a.datasetDiagHeroMode = 'timestep';
  const ts = makeFakeWrap();
  a._renderDatasetDiagHeroSvg(ts.wrap, ts.stage, ts.svg);
  assert.equal(ts.wrap._ddChartState.kind, 'timestep');
  assert.equal(ts.wrap._ddChartState.coords.length, 2);
  assert.equal(ts.svg.attrs.height, '236');
  assert.ok(ts.svg.innerHTML.includes('m-dd-ts-bar'));
  // High-noise bin [500, 1000] sits to the LEFT of low-noise bin [0, 500]
  const [leftBar, rightBar] = ts.wrap._ddChartState.coords;
  assert.ok(leftBar.tHigh > rightBar.tHigh);
  assert.ok(leftBar.xCenter < rightBar.xCenter);
  assert.ok(ts.svg.innerHTML.includes('>1000</text>'));
  assert.ok(ts.svg.innerHTML.includes('>0</text>'));

  // Early distribution (< 3 epochs) maintains exact 236px height
  const earlyData = structuredClone(SAMPLE_DATA);
  earlyData.summary.has_slope = false;
  a.datasetDiagData = earlyData;
  a.datasetDiagHeroMode = 'quadrant';
  const early = makeFakeWrap();
  a._renderDatasetDiagHeroSvg(early.wrap, early.stage, early.svg);
  assert.equal(early.svg.attrs.height, '236');
  assert.ok(early.svg.innerHTML.includes('m-dd-hist-bar'));
});

test('modal renders factual NaN row, 3 noise zones, anti-squeeze chart readouts, 1000-to-0 overlay, and Tag Editor handoff', async () => {
  let navigated = null;
  const makeDetail = (imageObj, extraSamples = []) => ({
    run_id: 'r1',
    timestep_scale: 'unit',
    image: imageObj,
    epoch_series: [{ epoch: 1, count: 2, mean_residual: 0.4, mean_loss: 0.3 }, { epoch: 2, count: 2, mean_residual: 0.44, mean_loss: 0.34 }],
    by_timestep: SAMPLE_DATA.by_timestep,
    samples: [{ step: 1, epoch: 1, timestep: 0.5, loss: 0.3, residual: 0.4, width: 768, height: 1024 }, ...extraSamples],
    samples_total: 1 + extraSamples.length,
    samples_truncated: false,
    caption: { exists: true, filename: 'bad.txt', text: '1girl, solo', error: '', editor_safe: true },
    file_info: { exists: true, abs_path: 'D:/ds/char/bad.png', dir_path: 'D:/ds/char', size: 1234, width: 768, height: 1024 },
  });
  global.fetch = async url => {
    const s = String(url);
    if (s.includes('image_id=aaaaaaaaaaaaaaaa')) return response(makeDetail(SAMPLE_DATA.by_image[0]));
    if (s.includes('image_id=cccccccccccccccc')) return response(makeDetail(SAMPLE_DATA.by_image[2], [{ step: 2, epoch: 2, timestep: 0.85, loss: null, residual: null, non_finite: true }]));
    throw new Error('Unexpected fetch: ' + url);
  };

  const a = makeApp({
    datasetDiagData: SAMPLE_DATA,
    datasetDiagPreset: 'all',
    navigate(route) { navigated = route; },
  });

  a.openDatasetDiagModal('aaaaaaaaaaaaaaaa');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(a.datasetDiagModalOpen, true);
  assert.equal(a.datasetDiagModalDetail.caption.text, '1girl, solo');

  // Normal/attention right panel has 3-zone strip, separated readout strips, NO pink-red AI note banner, NO middots
  const rightHtmlClean = a._renderDatasetDiagModalRightHtml(k => a.tMonitor(k), a.datasetDiagModalDetail);
  assert.ok(!rightHtmlClean.includes('m-dd-modal-note'));
  assert.ok(!rightHtmlClean.includes('m-dd-nan-row'));
  assert.ok(rightHtmlClean.includes('m-dd-modal-zones'));
  assert.ok(rightHtmlClean.includes('m-dd-mini-readout'));
  assert.ok(rightHtmlClean.includes('0.3000') || rightHtmlClean.includes('0.3200'));

  // Navigating to uncached NaN item (sorted first at index 0 by non_finite_count) clears previous detail immediately
  a.datasetDiagModalNav(-1);
  assert.equal(a.datasetDiagModalImageId, 'cccccccccccccccc');
  assert.equal(a.datasetDiagModalDetail, null);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(a.datasetDiagModalDetail.image.image_id, 'cccccccccccccccc');

  const rightHtmlNan = a._renderDatasetDiagModalRightHtml(k => a.tMonitor(k), a.datasetDiagModalDetail);
  assert.ok(rightHtmlNan.includes('m-dd-nan-row'));
  assert.ok(rightHtmlNan.includes('Epoch 2'));
  assert.ok(rightHtmlNan.includes('t = 850'));

  // Timestep overlay renders NaN marker and 1000 (left) -> 0 (right)
  const tsSvg = { attrs: {}, innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; } };
  const tsStage = { clientWidth: 420 };
  a._renderDatasetDiagModalTimestepSvg(tsStage, tsSvg, a.datasetDiagModalDetail, k => a.tMonitor(k));
  assert.ok(tsSvg.innerHTML.includes('m-dd-nan-mark'));
  assert.ok(tsSvg.innerHTML.includes('m-dd-base-line'));
  assert.ok(tsSvg.innerHTML.includes('m-dd-mini-zone-labels'));
  assert.ok(tsSvg.innerHTML.includes('style="fill:color-mix('));
  assert.equal(tsStage._ddState.dots.length, 2);
  const dotMid = tsStage._ddState.dots.find(d => d.timestep === 0.5);
  const dotHigh = tsStage._ddState.dots.find(d => d.timestep === 0.85);
  // Higher timestep (t=850) must be farther LEFT than lower timestep (t=500)
  assert.ok(dotHigh.cx < dotMid.cx);

  // Reopen first from cache and trigger Tag Editor handoff
  a.openDatasetDiagModal('aaaaaaaaaaaaaaaa');
  assert.equal(a.datasetDiagModalDetail.image.image_id, 'aaaaaaaaaaaaaaaa');
  a.openDatasetDiagInTagEditor();
  assert.equal(a.datasetDiagModalOpen, false);
  assert.equal(navigated, 'tagEditor');
  assert.equal(a.tagEditorDir, 'D:/ds/char');
  assert.equal(a.tagEditorOpenPath, 'D:/ds/char/bad.png');
  assert.equal(a.tagEditorSearchQuery, '^bad\\.png$');
  assert.equal(a.tagEditorUseRegex, true);
});
