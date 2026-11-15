const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');

global.document = {getElementById: () => null};
loadGlobalFrontend(['shared/utils', 'monitor/previews', 'monitor/artifacts-render']);

function image(batch, prompt, seed, changes = {}) {
  const params = {prompt: 'prompt ' + prompt, negative_prompt: '', seed, architecture: 'anima', width: prompt === 0 ? 512 : 768,
    height: prompt === 0 ? 768 : 512, steps: 30, cfg_scale: 5, sampler: 'euler', scheduler: 'native', ...changes.params};
  const settings = {...params}; delete settings.prompt; delete settings.negative_prompt; delete settings.seed;
  const name = `${batch}-${prompt}-${seed}-${changes.suffix || ''}.png`;
  return {name, path: 'sample/' + name, url: '/' + name, version: '1', sample: {
    batch_id: batch, batch_label: batch, batch_order: Number(batch.slice(1)), batch_status: 'complete', batch_expected: 4,
    prompt_id: 'prompt-' + prompt, prompt_label: 'Prompt ' + (prompt + 1), prompt_index: prompt, seed, params,
    condition_key: JSON.stringify(settings), comparable: true, metadata_source: 'recorded', ...changes.sample,
  }};
}

function legacyImage(epoch, prompt = 0, seed = '2333', timestamp = '20261114120000') {
  const name = `amyu_automagic4_dim24_v2_低lr_e${String(epoch).padStart(6, '0')}_${String(prompt).padStart(2, '0')}_${timestamp}${seed == null ? '' : '_' + seed}.png`;
  return {name, path: 'sample/' + name, url: '/' + name, version: '1'};
}

function app(previews = []) {
  const value = composeMixins(window.utilsMixin, window.monitorPreviewsMixin, window.monitorArtifactsRenderMixin, {
    previews: [], previewsVersion: 0, previewStep: 0,
    weakNetworkMode: false, currentOutputRunDir: 'output/test', monitorData: {},
    t(key) {
      const text = {'monitor.sampleSeed': 'Seed {n}', 'monitor.samplePrompt': 'Prompt {n}',
        'monitor.sampleEpoch': 'Epoch {n}', 'monitor.sampleStep': 'Step {n}',
        'monitor.sampleConditionOption': 'Condition {n}',
        'monitor.sampleBatchCount': '{n} images',
        'monitor.sampleNoSeed': 'Unknown seed'};
      return text[key] || key;
    },
    renderDashboard() {}, _refreshIconHtml() {return '';}, _updatePreviewLightbox() {},
  });
  value.resetSampleBrowser();
  value._replacePreviewItems(previews);
  return value;
}

function pageInput() {
  return {value: '', select() {this.selected = true;}, blur() {this.blurred = true;}};
}

test('sidebar selection previews the exact prompt image without opening the modal or rebuilding the grid', () => {
  const value = app([image('b1', 0, 4200), image('b1', 1, 4201), image('b2', 0, 4200)]);
  value.renderDashboard = () => {throw new Error('selection must keep grid images mounted');};
  value.openPreviewLightbox = () => {throw new Error('single click belongs to the sidebar');};
  value.selectSampleImage(1);
  assert.equal(value.previewStep, 1);
  assert.equal(value.sampleBatchId, 'b1');
  assert.equal(value.previewLightboxOpen, false);
  value.selectSampleImage(-1); value.selectSampleImage(99);
  assert.equal(value.previewStep, 1);
});

test('a hidden sidebar retains single-click modal viewing and the selected image', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.selectSampleImage(0);
  value.toggleSampleSidebar({currentTarget: {checked: false}});
  assert.equal(value.previewStep, 0);
  const opened = []; value.openPreviewLightbox = index => opened.push(index);
  value.selectSampleImage(1);
  assert.deepEqual(opened, [1]);
  value.toggleSampleSidebar({currentTarget: {checked: true}});
  assert.equal(value.previewStep, 0);
});

test('thumbnail current-image semantics follow sidebar selection and clear while it is hidden', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  const html = value._sampleThumbnailHtml(0, value._sampleDataModel().byBatch.get('b1'));
  // This button identifies the current image, rather than toggling a pressed
  // state. Alpine removes aria-current for false without stringifying null.
  assert.doesNotMatch(html, /aria-pressed/);
  const current = new Function('sampleSidebarActive', 'previewStep', 'return ' + html.match(/:aria-current="([^"]+)"/)[1]);
  for (const [enabled, open, selected, expected] of [[true, true, 0, true], [true, true, 1, false], [false, true, 0, false], [true, false, 0, false], [true, false, 1, false], [true, true, 0, true]]) {
    value.sampleSidebarVisible = enabled; value.sampleSidebarOpen = open; value.previewStep = selected;
    assert.equal(current(value.sampleSidebarActive, value.previewStep), expected);
  }
});

test('a dismissed preview stays closed across snapshots, sorting and rendering until the same image is selected again', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.selectSampleImage(1); value.closeSampleSidebarPreview();
  value._replacePreviewItems([...value.previews, image('b3', 0, 4200)]);
  value.setSampleBatchSort('asc');
  const html = value._renderSamplesTab(key => key);
  assert.equal(value.sampleSidebarVisible, true); assert.equal(value.sampleSidebarOpen, false);
  assert.match(html, /class="m-samples-workspace has-sidebar"/);
  assert.match(html, /id="sampleSidebarToggle" checked/);
  assert.match(html, /<template x-if="sampleSidebarMediaActive">/);
  assert.equal(value.sampleSidebarView.key, '', 'rendering hidden previews does not prepare or reopen their viewport');
  value.openPreviewLightbox = () => {throw new Error('an enabled sidebar must handle the next image click');};
  value.selectSampleImage(1);
  assert.equal(value.sampleSidebarActive, true); assert.equal(value.previewStep, 1);
  const view = window.AnimaImageViewport.create(value._sampleSidebarViewState());
  view.apply({scale: 2, x: 40, y: -20});
  const state = value.sampleSidebarView;
  assert.equal(state.key, value._previewItemKey(value.previews[1]));
  value._replacePreviewItems([...value.previews, image('b4', 0, 4200)]);
  value._renderSamplesTab(key => key);
  const remounted = window.AnimaImageViewport.create(value._sampleSidebarViewState());
  assert.equal(value.sampleSidebarView, state);
  assert.deepEqual(remounted.view(), {scale: 2, x: 40, y: -20}, 'reopening, zooming and refreshing retain the same viewport');
  value.closeSampleSidebarPreview(); value.resetSampleBrowser();
  assert.equal(value.sampleSidebarOpen, true, 'changing runs restores the initial preview state');
});

test('opening a batch cover or explicitly jumping to latest reopens a dismissed preview only when the feature is enabled', () => {
  const value = app([image('b1', 0, 4200), image('b1', 1, 4201), image('b2', 0, 4200)]);
  value._sampleOverviewPanel = () => ({querySelector: () => ({})});
  value._replaceSampleBatchCards = value._scrollOverviewToBatch = value._acknowledgeNewPreviews = () => {};
  for (const enabled of [true, false]) {
    value.sampleSidebarVisible = enabled;
    for (const id of ['b2', 'b1']) {
      value.closeSampleSidebarPreview(); value.sampleExpandedBatchId = '';
      value.toggleSampleBatch(id);
      assert.equal(value.sampleBatchId, id);
      assert.equal(value.sampleSidebarOpen, enabled);
      assert.equal(value.sampleSidebarActive, enabled);
    }
    value.closeSampleSidebarPreview(); value.jumpToLatestOverviewBatch();
    assert.equal(value.sampleBatchId, 'b2'); assert.equal(value.sampleSidebarActive, enabled);
  }
});

test('modal viewing and navigation preserve a dismissed sidebar and sidebar dismissal leaves modal details alone', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]), previousDocument = global.document;
  global.document = {getElementById: id => id === 'previewLightbox' ? {} : null};
  value._revealPreviewViewAfterOpen = () => {};
  try {
    value.closeSampleSidebarPreview(); value.openPreviewLightbox(0);
    assert.equal(value.previewLightboxOpen, true); assert.equal(value.sampleSidebarOpen, false);
    value.previewInfoOpen = true; value.closeSampleSidebarPreview();
    assert.equal(value.previewInfoOpen, true, 'sidebar dismissal does not close a modal-owned info dialog');
    value.selectPreviewTimelineByKey(value._previewItemKey(value.previews[1]));
    assert.equal(value.previewStep, 1); assert.equal(value.sampleSidebarActive, false);
    value.closePreviewLightbox(); value.clearPreviewLightbox();
    assert.equal(value.sampleSidebarOpen, false); assert.equal(value.sampleSidebarVisible, true);
  } finally {global.document = previousDocument;}
});

test('explicit sidebar inspection survives new images even in the expanded latest batch or at the latest scroll edge', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200), image('b2', 1, 4201)]);
  value.sampleExpandedBatchId = 'b2'; value.selectSampleImage(2);
  value._sampleOverviewAtEnd = true;
  value._replacePreviewItems([...value.previews, image('b2', 2, 4202)]);
  assert.equal(value.previewStep, 2);
  assert.equal(value.previewHasNew, true);
  value._replacePreviewItems([...value.previews, image('b3', 0, 4200)]);
  assert.equal(value.previewStep, 2);
  assert.equal(value.sampleBatchId, 'b2');
  value._sampleOverviewPanel = () => ({querySelector: () => null});
  value._scrollOverviewToBatch = () => {};
  value.jumpToLatestOverviewBatch();
  assert.equal(value._sampleSidebarInspecting, false);
  value.resetSampleBrowser();
  assert.equal(value._sampleSidebarInspecting, false);
});

test('sidebar inspection follows its exact file through late metadata regrouping and falls back safely after deletion', () => {
  const first = image('b1', 0, 4200, {sample: {batch_id: 'legacy:b1'}});
  const second = image('b1', 1, 4201, {sample: {batch_id: 'legacy:b1'}});
  const value = app([first, second, image('b2', 0, 4200)]);
  value.selectSampleImage(0);
  const refined = {...first, version: '2', sample: {...first.sample, batch_id: 'recorded:b1'}};
  value._replacePreviewItems([refined, second, value.previews[2]]);
  assert.equal(value.previews[value.previewStep], refined);
  assert.equal(value.sampleBatchId, 'recorded:b1');
  value._replacePreviewItems([second]);
  assert.equal(value.previewStep, 0);
  assert.equal(value.previews[value.previewStep], second);
  value._replacePreviewItems([]);
  assert.equal(value.previewStep, 0);
  assert.equal(value.sampleBatchId, '');
});

test('the initial sidebar and grid selection use the same latest batch', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.sampleBatchId = ''; value.previewStep = 0;
  value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.equal(value.sampleBatchId, 'b2');
  assert.equal(value.previewStep, 1);
});

test('shared generation details use the sidebar selection and retain the waiting comparison reference in the modal', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.startPreviewComparison(); value.previewStep = 0;
  assert.equal(value._previewInfoPreview(), value.previews[0], 'sidebar details belong to the selected image');
  value.previewLightboxOpen = true;
  assert.equal(value._previewInfoPreview(), value.previewReferences[0], 'the waiting modal describes its pinned reference');
  value.previewComparisonWaiting = false;
  assert.equal(value._previewInfoPreview(), value.previews[0]);
  assert.equal(value._previewGenerationInfoHtml(undefined), '');
});

test('new samples do not replace the image described by an open generation-info dialog', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.previewInfoOpen = true;
  value._replacePreviewItems([...value.previews, image('b3', 0, 4200)]);
  assert.equal(value._previewInfoPreview().sample.batch_id, 'b2');
  assert.equal(value.previewHasNew, true);
});

test('refreshing a sidebar keeps its viewport for the same file and resets it for a different image', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value._sampleSidebarViewState();
  value.sampleSidebarView.scale = 2; value.sampleSidebarView.x = 40;
  value._sampleSidebarViewState();
  assert.equal(value.sampleSidebarView.scale, 2); assert.equal(value.sampleSidebarView.x, 40);
  value.selectSampleImage(0); value._sampleSidebarViewState();
  assert.equal(value.sampleSidebarView.scale, 1); assert.equal(value.sampleSidebarView.x, 0);
});

test('hidden monitor pages unmount sidebar media while retaining the selected file and viewport', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  const mediaCondition = value._sampleSidebarHtml(key => key).match(/<template x-if="([^"]+)"/)[1];
  const mounted = () => new Function('app', 'with (app) { return ' + mediaCondition + '; }')(value);
  value.currentRoute = 'monitor-dashboard'; value.monitorTab = 'samples';
  value.selectSampleImage(0);
  const state = value._sampleSidebarViewState();
  state.scale = 2; state.x = 40;
  assert.equal(mounted(), true);
  for (const [route, tab] of [['monitor-dashboard', 'overview'], ['monitor-dashboard', 'logs'], ['history', 'samples']]) {
    value.currentRoute = route; value.monitorTab = tab;
    assert.equal(mounted(), false, 'hidden originals must not download or remain decoded in an img');
    value._replacePreviewItems([...value.previews, image('b' + (value.previews.length + 1), 0, 4200)]);
    assert.equal(value.previewStep, 0, 'media cleanup must not discard an inspected selection');
    assert.equal(value.sampleSidebarOpen, true);
  }
  value.currentRoute = 'monitor-dashboard'; value.monitorTab = 'samples';
  assert.equal(mounted(), true);
  assert.equal(value._sampleSidebarViewState(), state);
  assert.deepEqual(window.AnimaImageViewport.create(state).view(), {scale: 2, x: 40, y: 0});
});

test('selecting the latest sidebar image clears its new-sample notice while older selections retain it', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.previewHasNew = true; value.selectSampleImage(0);
  assert.equal(value.previewHasNew, true);
  value.selectSampleImage(1);
  assert.equal(value.previewHasNew, false); assert.equal(value._sampleSidebarInspecting, true);
});

test('prompt buttons use short numbered labels while keeping the actual prompt and pairing identity', () => {
  const prompt = 'a very long actual prompt, \n with recorded details and lighting';
  const previews = [image('b1', 0, 4200, {params: {prompt}, sample: {prompt_label: '正面特写'}}),
    image('b1', 0, 4201, {params: {prompt}, sample: {prompt_label: '正面特写'}})];
  const value = app(previews), key = value._sampleCaseKey(previews[0]);
  assert.equal(value._samplePromptButtonLabel(previews[0]), 'Prompt 1 Seed 4200');
  assert.equal(value._samplePromptButtonLabel(previews[1]), 'Prompt 1 Seed 4201');
  assert.equal(value._samplePromptText(previews[0]), 'a very long actual prompt, with recorded details and lighting');
  assert.equal(value._sampleCaseKey(previews[0]), key);
  assert.equal(value._sampleDataModel().batches[0].indices.length, 2, 'equal display text never merges actual images');
  assert.equal(value._samplePromptButtonLabel(legacyImage(1)), 'Prompt 1', 'old files do not borrow the current configuration');
});

test('prompt numbers stay localized and full recorded text is exposed separately', () => {
  const preview = legacyImage(1), value = app([preview]);
  value.t = key => key === 'monitor.samplePrompt' ? '提示词 {n}' : key;
  assert.equal(value._sampleCaseLabel(preview), '提示词 1');
  preview.sample = {...value._sampleRecord(preview), prompt_label: 'Prompt 1', params: {prompt: 'actual prompt from this sampling call'}};
  assert.equal(value._sampleCaseLabel(preview), '提示词 1');
  assert.equal(value._samplePromptButtonLabel(preview), '提示词 1');
  assert.equal(value._samplePromptText(preview), 'actual prompt from this sampling call');
  assert.equal(value._previewComparisonKey(preview), '');
});

test('batch order uses API generation order across recorded and legacy order units', () => {
  const value = app([image('b1', 0, 4200, {sample: {batch_order: 20261114120000}}), image('b2', 0, 4200, {sample: {batch_order: 2}})]);
  assert.deepEqual(value._sampleDataModel().batches.map(batch => batch.id), ['b1', 'b2']);
  assert.equal(value.sampleBatchId, 'b2');
  assert.deepEqual(value._sampleSelectedBatch().indices, [1]);
});

test('structured epoch and step both display when an older backend label contains only epoch', () => {
  const value = app([image('b1', 0, 4200, {sample: {batch_label: 'Epoch 51', epoch: 51, step: 20400}})]);
  const batch = value._sampleSelectedBatch();
  assert.deepEqual(value._sampleStageParts(batch.label), {primary: 'Epoch 51', secondary: 'Step 20400'});
  assert.equal(value._previewCompareLabel(value.previews[0]), 'Epoch 51 Step 20400 Prompt 1');
});

test('overview batch sorting reverses presentation without mutating canonical chronology or images within a batch', () => {
  const value = app([image('b1', 0, 4200), image('b1', 1, 4200), image('b2', 0, 4200), image('b3', 0, 4200)]);
  assert.equal(value.sampleBatchSortDir, 'desc');
  assert.deepEqual(value._sampleOverviewBatches().map(batch => batch.id), ['b3', 'b2', 'b1']);
  value.setSampleBatchSort('asc');
  const display = value._sampleOverviewBatches();
  assert.deepEqual(display.map(batch => batch.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(display[0].indices, [0, 1]);
  display.reverse();
  assert.deepEqual(value._sampleDataModel().batches.map(batch => batch.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(value._sampleOverviewBatches().map(batch => batch.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(value.previews.map(item => item.sample.batch_id), ['b1', 'b1', 'b2', 'b3']);
});

test('changing overview order retains the selected batch image and reader state', () => {
  const value = app([image('b1', 0, 4200), image('b1', 1, 4200), image('b2', 0, 4200)]);
  value.previewStep = 1; value.sampleBatchId = 'b1';
  value._sampleOverviewAtEnd = false; value.previewHasNew = true;
  value._sampleResetScroll = false; value._sampleScrollAnchor = {key: value.previews[1].path};
  const selected = value.previews[value.previewStep], version = value.previewsVersion;
  let renders = 0; value.renderDashboard = () => {renders++;};
  value.setSampleBatchSort('asc');
  assert.equal(value.sampleBatchId, 'b1');
  assert.equal(value.previewStep, 1);
  assert.equal(value.previews[value.previewStep], selected);
  assert.equal(value._sampleOverviewAtEnd, false);
  assert.equal(value.previewHasNew, true);
  assert.equal(value._sampleResetScroll, true);
  assert.equal(value._sampleScrollAnchor, null);
  assert.equal(value.previewsVersion, version + 1);
  assert.equal(renders, 1);
  value.setSampleBatchSort('asc'); value.setSampleBatchSort('invalid');
  assert.equal(renders, 1);
  value.setSampleBatchSort('desc');
  assert.equal(value.sampleBatchSortDir, 'desc');
  assert.equal(value.sampleBatchId, 'b1');
  assert.equal(value.previewStep, 1);
});

test('overview sorting leaves the canonical viewer sequence chronological', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200), image('b3', 0, 4200)]);
  value.setSampleBatchSort('asc');
  assert.deepEqual(value._previewLightboxIndices(), [0, 1, 2]);
  assert.deepEqual(value._sampleDataModel().batches.map(batch => batch.position), [0, 1, 2]);
  value.resetSampleBrowser();
  assert.equal(value.sampleBatchSortDir, 'desc');
});

test('viewer thumbnails follow overview order while their canonical sequence stays chronological', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  for (const dir of ['desc', 'asc']) {
    value.setSampleBatchSort(dir);
    const expected = dir === 'desc' ? [2, 1, 0] : [0, 1, 2];
    const display = value._previewLightboxDisplayIndices();
    assert.deepEqual(display, expected);
    assert.deepEqual(value._sampleOverviewBatches().map(batch => batch.id), expected.map(index => 'b' + (index + 1)));
    const html = value._renderSamplesTab(key => value.t('monitor.' + key));
    const groups = [...html.matchAll(/class="m-sample-batch"[^>]*data-batch-id="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(groups, expected.map(index => 'b' + (index + 1)));
    display.reverse();
    assert.deepEqual(value._previewLightboxIndices(), [0, 1, 2]);
    assert.deepEqual(value._sampleDataModel().batches.map(batch => batch.position), [0, 1, 2]);
  }
});

test('modal navigation and timeline keyboard follow the same visual left to right order', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  const focused = [], rail = {querySelector(selector) {return {focus() {focused.push(selector);}};}};
  for (const dir of ['desc', 'asc']) {
    value.setSampleBatchSort(dir);
    value.previewStep = 1; value.sampleBatchId = 'b2';
    value.previewLightboxNav(1);
    assert.equal(value.previewStep, dir === 'desc' ? 0 : 2);
    value.previewLightboxNav(-1);
    assert.equal(value.previewStep, 1);
    const expected = dir === 'desc' ? [2, 1, 0, 1] : [0, 1, 2, 1];
    for (const [index, key] of ['Home', 'ArrowRight', 'End', 'ArrowLeft'].entries()) {
      let prevented = false, stopped = false;
      value.previewViewTimelineKeydown({key, currentTarget: rail,
        preventDefault() {prevented = true;}, stopPropagation() {stopped = true;}});
      assert.equal(prevented && stopped, true);
      assert.equal(value.previewStep, expected[index]);
      assert.equal(value.sampleBatchId, 'b' + (expected[index] + 1));
      assert.equal(focused.at(-1), '[data-preview-index="' + expected[index] + '"]');
    }
    assert.deepEqual(value._previewLightboxIndices(), [0, 1, 2]);
  }
});

test('page input jumps by visual position and clamps signed and overflowing integers', () => {
  const cases = [['1', 1], ['2', 2], ['0', 1], ['-5', 1], ['999', 5],
    ['9'.repeat(400), 5], ['-' + '9'.repeat(400), 1], ['２', 2]];
  for (const dir of ['desc', 'asc']) for (const [draft, page] of cases) {
    const value = app([10, 20, 30, 40, 50].map(index => image('b' + index, 0, 4200)));
    value.setSampleBatchSort(dir); value.previewStep = 2; value.sampleBatchId = 'b30';
    let updates = 0; value._updatePreviewLightbox = () => {updates++;};
    const input = pageInput();
    value.beginPreviewPageEdit({currentTarget: input});
    assert.equal(input.selected, true);
    input.value = draft; value.updatePreviewPageDraft({currentTarget: input});
    assert.equal(value.previewStep, 2, 'typing must not navigate');
    assert.equal(updates, 0);
    value.commitPreviewPageEdit({currentTarget: input});
    assert.equal(value.previewStep, dir === 'desc' ? 5 - page : page - 1);
    assert.equal(value.sampleBatchId, 'b' + ((value.previewStep + 1) * 10));
    assert.equal(input.value, String(page));
    assert.equal(value.previewPageEditing, false);
    assert.equal(updates, 1);
  }
});

test('page display enters editing after a click and defers focus until the editor is visible', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  const input = pageInput(), pending = [], originalDocument = global.document;
  let focused = 0;
  input.focus = () => {focused++; value.beginPreviewPageEdit({currentTarget: input});};
  value.$nextTick = callback => pending.push(callback);
  global.document = {getElementById: id => id === 'previewLightboxPage' ? input : null};
  try {
    assert.equal(value.previewPageEditing, false);
    value.openPreviewPageEditor();
    assert.equal(value.previewPageEditing, true);
    assert.equal(focused, 0, 'do not focus an editor which Alpine has not shown yet');
    pending.shift()();
    assert.equal(focused, 1);
    assert.equal(input.selected, true);
    assert.equal(input.value, '1');
    input.value = '2'; value.commitPreviewPageEdit({currentTarget: input});
    assert.equal(value.previewPageEditing, false, 'committing restores the plain counter display');
    value.openPreviewPageEditor(); pending.shift()();
    assert.equal(input.value, '2', 'reopening uses the actual current position rather than an old draft');
    value.previewLightboxOpen = true; value.closePreviewLightbox();
    value.openPreviewPageEditor(); value._resetPreviewPageEditor();
    pending.shift()();
    assert.equal(focused, 2, 'a canceled deferred open must not steal focus later');
  } finally {global.document = originalDocument;}
});

test('page input restores the current position for empty or invalid commits and retains the last valid draft', () => {
  const value = app(['b1', 'b2', 'b3', 'b4'].map(batch => image(batch, 0, 4200)));
  value.previewStep = 2; value.sampleBatchId = 'b3';
  for (const draft of ['', '-', 'abc', '2.5', '2e1', 'Infinity', '--5', '+2']) {
    const input = pageInput(); value.beginPreviewPageEdit({currentTarget: input});
    input.value = draft; value.commitPreviewPageEdit({currentTarget: input});
    assert.equal(value.previewStep, 2);
    assert.equal(input.value, '2');
  }
  const input = pageInput(); value.beginPreviewPageEdit({currentTarget: input});
  input.value = '3'; value.updatePreviewPageDraft({currentTarget: input});
  for (const invalid of ['3x', '3.5', '3e1']) {
    input.value = invalid; value.updatePreviewPageDraft({currentTarget: input});
    assert.equal(input.value, '3');
    assert.equal(value.previewPageDraft, '3');
  }
  value.commitPreviewPageEdit({currentTarget: input});
  assert.equal(value.previewStep, 1);
});

test('Enter commits once before blur while external blur never moves focus', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  const input = pageInput();
  let updates = 0, focuses = 0, prevented = false, stopped = false;
  value._updatePreviewLightbox = () => {updates++;};
  value._focusPreviewPageNavigation = () => {focuses++;};
  value.beginPreviewPageEdit({currentTarget: input}); input.value = '3';
  value.previewPageKeydown({key: 'Enter', currentTarget: input,
    preventDefault() {prevented = true;}, stopPropagation() {stopped = true;}});
  assert.equal(prevented && stopped, true);
  assert.equal(value.previewStep, 0);
  assert.equal(value.commitPreviewPageEdit({currentTarget: input}), false, 'the following blur must not submit again');
  assert.equal(updates, 1);
  assert.equal(focuses, 1);
  value.beginPreviewPageEdit({currentTarget: input}); input.value = '2';
  value.commitPreviewPageEdit({currentTarget: input});
  assert.equal(value.previewStep, 1);
  assert.equal(focuses, 1, 'a blur commit must preserve the externally clicked focus');
});

test('page Escape cancels only editing and arrow Tab and composition keys keep native input behavior', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.previewLightboxOpen = true;
  value._focusPreviewPageNavigation = () => {};
  const input = pageInput(); value.beginPreviewPageEdit({currentTarget: input}); input.value = '3';
  let stopped = 0, prevented = 0;
  const event = key => ({key, currentTarget: input, stopPropagation() {stopped++;}, preventDefault() {prevented++;}});
  value.previewPageKeydown(event('ArrowLeft'));
  assert.equal(stopped, 1); assert.equal(prevented, 0);
  value.previewPageKeydown(event('Tab'));
  assert.equal(stopped, 1); assert.equal(prevented, 0);
  value.previewPageKeydown({...event('Enter'), isComposing: true});
  assert.equal(value.previewPageEditing, true);
  assert.equal(value.previewStep, 2);
  value.previewPageKeydown(event('Escape'));
  assert.equal(value.previewPageEditing, false);
  assert.equal(input.value, '1');
  assert.equal(value.previewStep, 2);
  assert.equal(value.previewLightboxOpen, true);
  assert.equal(prevented, 1);
  assert.equal(value.commitPreviewPageEdit({currentTarget: input}), false);
});

test('page commit uses the latest visible sequence after samples grow or shrink during editing', () => {
  for (const count of [5, 12]) {
    const value = app(Array.from({length: 10}, (_, index) => image('b' + (index + 1), 0, 4200)));
    value.previewLightboxOpen = true; value.previewStep = 3; value.sampleBatchId = 'b4';
    const input = pageInput(); value.beginPreviewPageEdit({currentTarget: input});
    input.value = '999'; value.updatePreviewPageDraft({currentTarget: input});
    value._replacePreviewItems(Array.from({length: count}, (_, index) => image('b' + (index + 1), 0, 4200)));
    assert.equal(value.previewStep, 3);
    assert.equal(value.previewPageEditing, true);
    assert.equal(input.value, '999');
    value.commitPreviewPageEdit({currentTarget: input});
    assert.equal(value.previewStep, 0);
    assert.equal(input.value, String(count));
  }
});

test('counter updates preserve an active draft while reserving at least four digits', () => {
  const value = app(Array.from({length: 100}, (_, index) => image('b' + (index + 1), 0, 4200)));
  const input = pageInput(), display = {}, total = {}, widths = {};
  const counter = {style: {setProperty(name, text) {widths[name] = text;}}};
  const nodes = {previewLightboxCounter: counter, previewLightboxCounterDisplay: display, previewLightboxPage: input, previewLightboxCounterTotal: total};
  const originalDocument = global.document;
  global.document = {getElementById: id => nodes[id] || null};
  value.constrainPreviewView = () => {};
  try {
    value.beginPreviewPageEdit({currentTarget: input}); input.value = '99'; value.updatePreviewPageDraft({currentTarget: input});
    window.monitorArtifactsRenderMixin._updatePreviewLightbox.call(value);
    assert.equal(input.value, '99');
    assert.equal(display.textContent, '1');
    assert.equal(total.textContent, '100');
    assert.equal(widths['--preview-counter-width'], '11ch');
    value._resetPreviewPageEditor(); value.previewStep = 49;
    window.monitorArtifactsRenderMixin._updatePreviewLightbox.call(value);
    assert.equal(input.value, '51');
    assert.equal(display.textContent, '51');
    assert.equal(widths['--preview-counter-width'], '11ch');
  } finally {global.document = originalDocument;}
});

test('closing and resetting the sample browser cancel pending page edits without committing', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.previewLightboxOpen = true;
  const input = pageInput(); value.beginPreviewPageEdit({currentTarget: input}); input.value = '3';
  value.closePreviewLightbox();
  assert.equal(value.previewPageEditing, false);
  assert.equal(value.commitPreviewPageEdit({currentTarget: input}), false);
  assert.equal(value.previewStep, 2);
  value.beginPreviewPageEdit({currentTarget: input}); input.value = '2';
  value.resetSampleBrowser();
  assert.equal(value.previewPageEditing, false);
  assert.equal(value.previewPageDraft, '');
  assert.equal(value._previewPageLastDraft, '');
});

test('latest actions keep using the chronological newest point in either visual order', () => {
  for (const dir of ['desc', 'asc']) {
    const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
    value.setSampleBatchSort(dir);
    value.previewStep = 0; value.sampleBatchId = 'b1'; value.previewLightboxOpen = true;
    value._sampleOverviewAtEnd = false;
    value._replacePreviewItems([...value.previews, image('b4', 0, 4200)]);
    assert.equal(value.previewStep, 0);
    assert.equal(value.previewHasNew, true);
    assert.equal(value._previewHasNewInViewerSequence(), true);
    value.jumpToLatestPreview();
    assert.equal(value.previewStep, 3);
    assert.equal(value.sampleBatchId, 'b4');
    assert.equal(value.previewHasNew, false);
    assert.equal(value._sampleOverviewAtEnd, false);
    const calls = [];
    value._sampleOverviewPanel = () => ({querySelector: () => null});
    value._scrollOverviewToBatch = (panel, batch) => calls.push(batch.id);
    value.jumpToLatestOverviewBatch();
    assert.deepEqual(calls, ['b4']);
  }
});

test('a fixed actual image stays in the display timeline when its batch has ambiguous metadata', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200), image('b2', 0, 4200, {suffix: 'retry'})]);
  value.previewStep = 1; value.sampleBatchId = 'b2';
  value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(0);
  assert.equal(value.previewReferences[0], value.previews[1]);
  assert.equal(value.previewStep, 0);
  assert.deepEqual(value._previewLightboxIndices(), [0], 'ambiguous metadata must not expand the canonical matching sequence');
  assert.deepEqual(value._previewLightboxDisplayIndices(), [1, 0]);
  const located = []; value.locatePreviewReference = key => located.push(key);
  value.selectPreviewTimeline(1); value._syncPreviewReference();
  assert.equal(value.previewStep, 0, 'the explicitly fixed file locates its pane without replacing the current image');
  assert.deepEqual(located, [value.previews[1].path]);
  value.selectPreviewTimeline(0); value._syncPreviewReference();
  value.setSampleBatchSort('asc');
  assert.deepEqual(value._previewLightboxDisplayIndices(), [0, 1]);
});

test('latest-edge helpers follow the newest sampling batch at either presentation edge', () => {
  const value = app([]), grid = {scrollTop: 4, clientHeight: 200, scrollHeight: 1000};
  assert.equal(value._sampleOverviewAtLatestEdge(grid), true);
  assert.equal(value._sampleOverviewLatestScrollTop(grid), 0);
  grid.scrollTop = 5;
  assert.equal(value._sampleOverviewAtLatestEdge(grid), false);
  value.setSampleBatchSort('asc');
  grid.scrollTop = 796;
  assert.equal(value._sampleOverviewAtLatestEdge(grid), true);
  assert.equal(value._sampleOverviewLatestScrollTop(grid), 800);
  grid.scrollTop = 795;
  assert.equal(value._sampleOverviewAtLatestEdge(grid), false);
});

test('new batches follow only idle latest readers in either overview sort direction', () => {
  for (const dir of ['asc', 'desc']) {
    const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
    value.setSampleBatchSort(dir);
    value._replacePreviewItems([...value.previews, image('b3', 0, 4200)]);
    assert.equal(value.sampleBatchId, 'b3');
    assert.equal(value.previewStep, 2);
    assert.equal(value.previewHasNew, false);
    assert.equal(value._sampleOverviewBatches()[dir === 'desc' ? 0 : 2].id, 'b3');
    value._sampleOverviewAtEnd = false;
    value._replacePreviewItems([...value.previews, image('b4', 0, 4200)]);
    assert.equal(value.sampleBatchId, 'b3');
    assert.equal(value.previewStep, 2);
    assert.equal(value.previewHasNew, true);
    value.setSampleBatchSort(dir === 'asc' ? 'desc' : 'asc');
    assert.equal(value._sampleOverviewAtEnd, false);
    assert.equal(value.previewHasNew, true);
    value._replacePreviewItems([...value.previews, image('b5', 0, 4200)]);
    assert.equal(value.sampleBatchId, 'b3');
    assert.equal(value.previewStep, 2);
  }
});

test('new images follow an idle latest batch but preserve the open viewer selection', () => {
  const first = [image('b1', 0, 4200), image('b1', 1, 4200)];
  const value = app(first);
  value._replacePreviewItems([...first, image('b2', 0, 4200)]);
  assert.equal(value.sampleBatchId, 'b2');
  assert.equal(value.previewStep, 2);
  value._replacePreviewItems([...first, image('b2', 0, 4200), image('b2', 1, 4200)]);
  assert.equal(value.previewStep, 2, 'a second prompt must not select the last generated image');
  value.previewLightboxOpen = true;
  value._replacePreviewItems([...value.previews, image('b3', 0, 4200)]);
  assert.equal(value.sampleBatchId, 'b2');
  assert.equal(value.previewStep, 2);
  assert.equal(value.previewHasNew, true);
});

test('live updates do not move a reader away from the latest batch when the overview is scrolled up', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value._sampleOverviewAtEnd = false;
  value._replacePreviewItems([...value.previews, image('b3', 0, 4200)]);
  assert.equal(value.sampleBatchId, 'b2');
  assert.equal(value.previewStep, 1);
  assert.equal(value.previewHasNew, true);
  value.resetSampleBrowser();
  assert.equal(value._sampleOverviewAtEnd, true);
});

test('metadata-only completion and late parameter records dirty the sample view', () => {
  const pending = image('b1', 0, 4200, {sample: {batch_status: 'running', comparable: false, condition_key: null}});
  const value = app([pending]);
  const complete = image('b1', 0, 4200);
  assert.equal(value._replacePreviewItems([complete]), true);
  assert.equal(value._sampleSelectedBatch().status, 'complete');
  assert.equal(value._sampleDataModel().records[0].sample.comparable, true);
  value._previewSnapshotSeq = 0;
  const version = value.previewsVersion;
  value._applyPreviewSnapshot([image('b1', 0, 4200, {sample: {batch_expected: 8}})], 0);
  assert.equal(value.previewsVersion, version + 1);
  assert.equal(value._sampleSelectedBatch().expected, 8);
});

test('late manifests can rename a batch without moving an open viewer to another image', () => {
  const old = image('b1', 0, 4200, {sample: {batch_id: 'legacy:b1', comparable: false}});
  const later = image('b2', 0, 4200);
  const value = app([old, later]);
  value._activateOverviewBatch(value._sampleDataModel().byBatch.get('legacy:b1')); value.previewLightboxOpen = true;
  const recorded = {...old, sample: {...image('b1', 0, 4200).sample}};
  value._replacePreviewItems([recorded, later, image('b3', 0, 4200)]);
  assert.equal(value.previewStep, 0);
  assert.equal(value.sampleBatchId, 'b1');
  assert.equal(value.previewHasNew, true);
});

test('partial manifest arrivals preserve the selected file while its legacy batch still exists', () => {
  const first = image('b1', 0, 4200, {sample: {batch_id: 'legacy:b1', metadata_source: 'filename'}});
  const second = image('b1', 1, 4200, {sample: {batch_id: 'legacy:b1', metadata_source: 'filename'}});
  const value = app([first, second, image('b2', 0, 4200)]);
  value._activateOverviewBatch(value._sampleDataModel().byBatch.get('legacy:b1')); value.previewLightboxOpen = true;
  const recorded = {...first, sample: {...image('b1', 0, 4200).sample}};
  value._replacePreviewItems([recorded, second, value.previews[2]]);
  assert.equal(value.previews[value.previewStep].path, first.path);
  assert.equal(value.sampleBatchId, 'b1');
  assert.ok(value._sampleDataModel().byBatch.has('legacy:b1'), 'another file still belongs to the legacy batch');
});

test('sample snapshots preserve a valid context menu and dismiss only a removed or changed target', () => {
  for (const change of ['unchanged', 'new-sample', 'removed', 'metadata']) {
    const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
    value.previewLightboxOpen = true;
    const target = value.previews[1];
    const menu = {key: target.path, batchId: target.sample.batch_id, metadataKey: value._previewViewerMetadataKey(target)};
    value.previewTimelineMenu = menu;
    let closes = 0;
    value.closePreviewTimelineMenu = () => {closes++; value.previewTimelineMenu = null;};
    const updated = value.previews.map(item => ({...item}));
    if (change === 'new-sample') updated.push(image('b4', 0, 4200));
    if (change === 'removed') updated.splice(1, 1);
    if (change === 'metadata') updated[1] = image('b2', 0, 4200, {params: {cfg_scale: 7}});
    value._replacePreviewItems(updated);
    if (change === 'removed' || change === 'metadata') {
      assert.equal(closes, 1, change);
      assert.equal(value.previewTimelineMenu, null);
    } else {
      assert.equal(closes, 0, change);
      assert.equal(value.previewTimelineMenu, menu);
      assert.equal(menu.actions.pin, true);
    }
  }
});

test('batch navigation preserves prompt and seed across a parameter change without treating it as comparable', () => {
  const value = app([image('b1', 0, 4200), image('b1', 1, 4201, {params: {cfg_scale: 7}}), image('b2', 1, 4201)]);
  assert.equal(value.previewStep, 2);
  value._activateOverviewBatch(value._sampleDataModel().byBatch.get('b1'));
  assert.equal(value.previewStep, 1);
  value._activateOverviewBatch(value._sampleDataModel().byBatch.get('b2'));
  assert.equal(value.previewStep, 2);
  assert.deepEqual(value._previewLightboxIndices(), [1, 2]);
});

test('comparison pins its initial reference while navigating through other time points', () => {
  const value = app(['b1', 'b2', 'b3', 'b4'].map(batch => image(batch, 0, 4200)));
  value.previewStep = 2;
  value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(1);
  assert.equal(value.previewReferences[0], value.previews[2]);
  value.previewStep = 3; value._syncPreviewReference();
  assert.equal(value.previewReferences[0], value.previews[2], 'the reference must not become the new previous neighbor');
  value.previewStep = 0; value._syncPreviewReference();
  assert.equal(value.previewReferences[0], value.previews[2]);
  value.stopPreviewComparison();
  assert.equal(value.previewCompareActive, false);
  assert.deepEqual(value.previewReferences, []);
});

test('fixing the current image appends it and waits for a new explicit selection', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.previewLightboxOpen = true;
  let updates = 0; value._updatePreviewLightbox = () => {updates++;};
  value.startPreviewComparison();
  assert.equal(updates, 1);
  assert.equal(value.previewStep, 2);
  assert.equal(value.previewComparisonWaiting, true);
  value.selectPreviewComparisonCurrent(1);
  updates = 0;
  assert.equal(value.setCurrentPreviewAsReference(), true);
  assert.equal(value.previewStep, 1);
  assert.equal(value.sampleBatchId, 'b2');
  assert.deepEqual(value.previewReferences, [value.previews[2], value.previews[1]]);
  assert.equal(value.previewCompareActive, true);
  assert.equal(value.previewComparisonWaiting, true);
  assert.equal(updates, 1, 'pinning should update the viewer once');
  value.selectPreviewComparisonCurrent(0);
  assert.equal(value.previewComparisonWaiting, false);
  assert.equal(value.previewReferences[0], value.previews[2]);
});

test('pinning the displayed reference returns keyboard focus to its time point', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(1);
  value.previewImageAvailable = true;
  const previousDocument = global.document;
  let focused = false;
  const selected = {focus(options) {focused = options.preventScroll;}};
  global.document = {getElementById: id => id === 'previewLightboxTimeline' ? {querySelector: () => selected} : null};
  try {
    value.pinCurrentPreviewReference();
    assert.deepEqual(value.previewReferences, [value.previews[2], value.previews[1]]);
    assert.equal(value.previewComparisonWaiting, true);
    assert.equal(value.previewStep, 1);
    assert.equal(focused, true, 'focus must return to the pinned time point while awaiting selection');
  } finally {global.document = previousDocument;}
});

test('the pinned timeline marker is independent of the viewed time point and clears on exit', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  const translate = value.t;
  value.t = key => key === 'monitor.samplePinnedReference' ? 'Pinned reference' : translate(key);
  const items = value.previews.map((preview, index) => {
    const classes = new Set(), icon = {hidden: true}, attributes = {'aria-pressed': index === 1 ? 'true' : 'false'};
    return {classes, icon, attributes, dataset: {previewIndex: String(index), previewPath: preview.path},
      classList: {toggle(name, enabled) {if (enabled) classes.add(name); else classes.delete(name);}},
      querySelector() {return icon;}, setAttribute(name, text) {attributes[name] = text;}};
  });
  const timeline = {querySelector() {return items.find(item => item.classes.has('is-reference')) || null;}, querySelectorAll() {return items;}};
  value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(1);
  value._markPreviewViewReference(timeline);
  assert.equal(items[2].icon.hidden, false);
  assert.equal(items[2].classes.has('is-reference'), true);
  assert.equal(items[2].attributes['aria-pressed'], 'false', 'pinning must not claim this is the viewed target');
  assert.equal(items[1].attributes['aria-pressed'], 'true');
  assert.match(items[2].attributes['aria-label'], /Pinned reference/);
  value.previewStep = 0; value._syncPreviewReference(); value._markPreviewViewReference(timeline);
  assert.equal(items[2].icon.hidden, false, 'navigation must not move the pinned marker');
  value.setCurrentPreviewAsReference(); value._markPreviewViewReference(timeline);
  assert.equal(items[0].icon.hidden, false);
  assert.equal(items[2].icon.hidden, false, 'fixing another file keeps earlier markers');
  value.stopPreviewComparison(); value._markPreviewViewReference(timeline);
  assert.ok(items.every(item => item.icon.hidden && !item.classes.has('is-reference')));
  assert.doesNotMatch(items[0].attributes['aria-label'], /Pinned reference/);
});

test('starting comparison fixes the current file and waits without choosing any neighboring sample', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4201), image('b3', 0, 4200)]);
  value.previewStep = 0;
  assert.equal(value.canCompareCurrentPreview(), true);
  assert.equal(value.startPreviewComparison(), true);
  assert.equal(value.previewReferences[0], value.previews[0]);
  assert.equal(value.previewStep, 0);
  assert.equal(value.previewComparisonWaiting, true);
  value.selectPreviewComparisonCurrent(2);
  assert.equal(value.previewStep, 2);
  assert.equal(value.sampleBatchId, 'b3');
  const lone = app([image('b1', 0, 4200)]);
  assert.equal(lone.canCompareCurrentPreview(), true);
  assert.equal(lone.startPreviewComparison(), true);
  assert.equal(lone.previewComparisonWaiting, true);
  assert.equal(lone.previewStep, 0);
});

test('fixing the current image resolves every existing reference to its latest exact file version', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(1);
  const replacement = {...value.previews[2], version: '2', url: '/latest-fixed-version.png?v=2'};
  value.previews = [value.previews[0], value.previews[1], replacement];
  assert.equal(value.setCurrentPreviewAsReference(), true);
  assert.deepEqual(value.previewReferences, [replacement, value.previews[1]]);
  assert.equal(value.previewReferences[0], replacement);
  assert.equal(value.previewStep, 1);
  assert.equal(value.sampleBatchId, 'b2');
  assert.equal(value.previewComparisonWaiting, true);
});

test('fixing the current image removes unsafe references and waits without choosing a fallback target', () => {
  for (const change of ['removed', 'changed-condition', 'duplicate']) {
    const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
    value.startPreviewComparison();
    value.selectPreviewComparisonCurrent(1);
    const [first, current, previousReference] = value.previews;
    value.previews = change === 'removed' ? [first, current] : change === 'duplicate'
      ? [first, current, previousReference, {...previousReference}]
      : [first, current, image('b3', 0, 4200, {params: {cfg_scale: 7}})];
    assert.equal(value.setCurrentPreviewAsReference(), true);
    assert.equal(value.previewReferences[0], current);
    assert.deepEqual(value.previewReferences, [current]);
    assert.equal(value.previewStep, 1);
    assert.equal(value.sampleBatchId, 'b2');
    assert.equal(value.previewComparisonWaiting, true);
  }
});

test('the current image can remain fixed while waiting after other files are deleted', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(0);
  value.previews = [value.previews[0]];
  assert.equal(value.setCurrentPreviewAsReference(), true);
  assert.equal(value.previewCompareActive, true);
  assert.equal(value.previewReferences[0], value.previews[0]);
  assert.equal(value.previewComparisonWaiting, true);
  assert.equal(value.previewStep, 0);
});

test('multiple references keep selection order, deduplicate files, and can be removed independently', () => {
  const value = app(['b1', 'b2', 'b3', 'b4'].map(batch => image(batch, 0, 4200)));
  const [first, second, third] = value.previews;
  assert.equal(value.pinPreviewReference(1), true);
  assert.equal(value.pinPreviewReference(first), true);
  assert.equal(value.pinPreviewReference(2), true);
  assert.equal(value.previewStep, 3, 'fixing files never selects the comparison image');
  assert.deepEqual(value.previewReferences, [second, first, third]);
  value.selectPreviewComparisonCurrent(3);
  assert.equal(value.previewComparisonWaiting, false);
  assert.equal(value.pinPreviewReference(1), true);
  assert.equal(value.previewComparisonWaiting, true, 'a new pin action always awaits an explicit image selection');
  assert.deepEqual(value.previewReferences, [second, first, third], 'fixing an existing file does not reorder or duplicate it');
  assert.equal(value.unpinPreviewReference(first.path), true);
  assert.deepEqual(value.previewReferences, [second, third]);
  assert.equal(value.unpinPreviewReference('missing'), false);
  assert.equal(value.unpinPreviewReference(second.path), true);
  assert.equal(value.unpinPreviewReference(third.path), true);
  assert.equal(value.previewCompareActive, false);
  assert.equal(value.previewComparisonWaiting, false);
  assert.deepEqual(value.previewReferences, []);
  assert.deepEqual(value._previewReferenceEntries, []);
});

test('stop clears all fixed references and the waiting state at once', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.pinPreviewReference(0); value.pinPreviewReference(1);
  value.stopPreviewComparison();
  assert.equal(value.previewCompareActive, false);
  assert.equal(value.previewComparisonWaiting, false);
  assert.deepEqual(value.previewReferences, []);
  assert.deepEqual(value._previewReferenceEntries, []);
});

test('each fixed file invalidates independently while other references keep their exact identities and order', () => {
  for (const change of ['removed', 'duplicate', 'conditions', 'sampling-point', 'metadata']) {
    const value = app(['b1', 'b2', 'b3', 'b4'].map(batch => image(batch, 0, 4200)));
    value.previewLightboxOpen = true;
    value.pinPreviewReference(3); value.pinPreviewReference(1); value.pinPreviewReference(2);
    value.selectPreviewComparisonCurrent(0);
    const [current, second, third, invalid] = value.previews;
    const replacement = {...second, version: '2', url: '/second-v2.png'};
    let updated = [current, replacement, third, invalid];
    if (change === 'removed') updated.pop();
    if (change === 'duplicate') updated.push({...invalid});
    if (change === 'conditions') updated[3] = image('b4', 0, 4200, {params: {cfg_scale: 7}});
    if (change === 'sampling-point') updated[3] = {...invalid, sample: {...invalid.sample, batch_id: 'b5'}};
    if (change === 'metadata') updated[3] = {...invalid, sample: {...invalid.sample, params: {...invalid.sample.params, diagnostic: 'changed'}}};
    value._replacePreviewItems(updated);
    assert.equal(value.previewCompareActive, true, change);
    assert.equal(value.previewComparisonWaiting, false, change);
    assert.deepEqual(value.previewReferences, [replacement, third], change);
    assert.equal(value.previewReferences[0], replacement, change);
    assert.equal(value.previews[value.previewStep], current, change);
  }
});

test('waiting comparisons preserve valid references when the unselected previous current file changes', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.previewLightboxOpen = true;
  value.pinPreviewReference(0); value.pinPreviewReference(1);
  const [first, second] = value.previews;
  value._replacePreviewItems([first, second, image('b3', 1, 4201)]);
  assert.equal(value.previewComparisonWaiting, true);
  assert.deepEqual(value.previewReferences, [first, second]);
  assert.deepEqual(value._previewLightboxIndices(), [0, 1], 'the fixed group anchors the waiting image choices');
  value.selectPreviewComparisonCurrent(2);
  assert.equal(value.previewCompareActive, false, 'an explicit incompatible selection exits the fixed group');
});

test('every explicitly fixed retry remains in the display timeline without relaxing ambiguous automatic pairing', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200), image('b2', 0, 4200, {suffix: 'retry'}), image('b3', 0, 4200)]);
  value.pinPreviewReference(1); value.pinPreviewReference(2);
  value.selectPreviewComparisonCurrent(0);
  assert.deepEqual(value._previewLightboxIndices(), [0, 3]);
  assert.deepEqual(value._previewLightboxDisplayIndices(), [3, 2, 1, 0]);
  value.setSampleBatchSort('asc');
  assert.deepEqual(value._previewLightboxDisplayIndices(), [0, 1, 2, 3]);
  value.previews = [...value.previews, {...value.previews[2]}];
  assert.equal(value.pinPreviewReference(2), false, 'a duplicated actual file is never pinnable');
  value._syncPreviewReference();
  assert.deepEqual(value.previewReferences, [value.previews[1]], 'only the duplicated reference is removed');
  assert.deepEqual(value._previewLightboxDisplayIndices(), [0, 1, 3]);
});

test('a stale file object cannot pin overwritten metadata or change a valid explicit selection', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  const stale = value.previews[1];
  value.pinPreviewReference(2); value.selectPreviewComparisonCurrent(0);
  value.previews = [value.previews[0], image('b2', 0, 4200, {params: {cfg_scale: 7}}), value.previews[2]];
  assert.equal(value.pinPreviewReference(stale), false);
  assert.deepEqual(value.previewReferences, [value.previews[2]]);
  assert.equal(value.previewComparisonWaiting, false);
  assert.equal(value.previewStep, 0);
});

test('comparison exits on changed prompt seed or generation conditions and stays off on return', () => {
  const incompatible = [image('b3', 1, 4200), image('b3', 0, 4201), image('b3', 0, 4200, {params: {cfg_scale: 7}}),
    image('b3', 0, 4200, {params: {prompt: 'changed prompt'}}),
    image('b3', 0, 4200, {params: {negative_prompt: 'changed negative'}})];
  for (const target of incompatible) {
    const value = app([image('b1', 0, 4200), image('b2', 0, 4200), target]);
    value.previewStep = 1; value.startPreviewComparison();
    value.selectPreviewComparisonCurrent(2);
    assert.equal(value.previewCompareActive, false);
    assert.deepEqual(value.previewReferences, []);
    value.previewStep = 1; value._syncPreviewReference();
    assert.equal(value.previewCompareActive, false);
  }
});

test('incomplete recorded metadata remains unavailable to manual comparison', () => {
  const incomplete = [
    {sample: {comparable: false}}, {sample: {condition_key: null}},
    {sample: {seed: null}}, {params: {prompt: undefined}}, {params: {negative_prompt: undefined}},
  ];
  for (const changes of incomplete) {
    const value = app([image('b1', 0, 4200, changes), image('b2', 0, 4200, changes)]);
    assert.equal(value.canCompareCurrentPreview(), false);
    assert.equal(value.startPreviewComparison(), false);
    assert.equal(value.setCurrentPreviewAsReference(), false);
    assert.deepEqual(value.previewReferences, []);
  }
});

test('twenty legacy filename epochs with one prompt and seed support manual fixed comparison without becoming automatically comparable', () => {
  const previews = Array.from({length: 20}, (_, index) => legacyImage(index + 1));
  const value = app(previews), before = JSON.stringify(previews);
  assert.equal(value._previewLightboxIndices().length, 20);
  assert.equal(value._previewComparisonKey(value.previews[19]), '');
  assert.equal(value.canCompareCurrentPreview(), true);
  assert.equal(value.startPreviewComparison(), true);
  assert.equal(value.previewReferences[0], value.previews[19]);
  assert.equal(value.previewStep, 19);
  assert.equal(value.previewComparisonWaiting, true);
  value.selectPreviewComparisonCurrent(18);
  assert.equal(value.previewStep, 18);
  assert.equal(value.setCurrentPreviewAsReference(), true);
  assert.deepEqual(value.previewReferences, [value.previews[19], value.previews[18]]);
  assert.equal(value.previewStep, 18);
  assert.equal(value.previewComparisonWaiting, true);
  value.selectPreviewComparisonCurrent(19);
  assert.equal(value._sampleRecord(value.previewReferences[0]).comparable, false);
  assert.equal(JSON.stringify(previews), before, 'manual viewing must not manufacture sample metadata');
  const info = value._previewGenerationInfoHtml(value.previewReferences[0]);
  assert.doesNotMatch(info, /sampleUnverifiedHint/);
  assert.match(info, /2333/);
  assert.doesNotMatch(info, /sampleAxisSteps|sampleAxisCfg|sampleImageSize/);
});

test('legacy manual comparisons exit when explicitly selecting a different prompt slot or seed', () => {
  const value = app([legacyImage(1), legacyImage(2, 0, '9999'), legacyImage(3, 1), legacyImage(4)]);
  value.previewStep = 0;
  assert.equal(value.startPreviewComparison(), true);
  assert.equal(value.previewReferences[0], value.previews[0]);
  value.selectPreviewComparisonCurrent(3);
  assert.equal(value.previewStep, 3);
  value.selectPreviewComparisonCurrent(1);
  assert.equal(value.previewCompareActive, false);
  assert.equal(value.canCompareCurrentPreview(), true, 'a different valid identity can start its own waiting comparison');
  value.previewStep = 2;
  assert.equal(value.canCompareCurrentPreview(), true);
  assert.equal(app([legacyImage(1)]).canCompareCurrentPreview(), true);
});

test('unverified prompt slots and unknown file sequences can be viewed manually without crossing recorded generation identities', () => {
  const legacy = app([image('b1', 0, 2333, {sample: {metadata_source: 'unverified', comparable: false, params: {}, condition_key: null}}),
    image('b2', 0, 2333, {sample: {metadata_source: 'unverified', comparable: false, params: {}, condition_key: null}})]);
  assert.equal(legacy.startPreviewComparison(), true);
  const unknown = app([{name: 'first.png', path: 'first.png'}, {name: 'second.png', path: 'second.png'}]);
  assert.equal(unknown.canCompareCurrentPreview(), true);
  assert.equal(unknown.startPreviewComparison(), true);
  assert.equal(unknown.previewReferences[0], unknown.previews[1]);
  unknown.selectPreviewComparisonCurrent(0);
  assert.equal(unknown.previewStep, 0);
  assert.equal(unknown.setCurrentPreviewAsReference(), true);
  assert.equal(unknown.previewStep, 0);
  assert.deepEqual(unknown.previewReferences, [unknown.previews[1], unknown.previews[0]]);
  unknown.selectPreviewComparisonCurrent(1);
  assert.doesNotMatch(unknown._previewGenerationInfoHtml(unknown.previewReferences[0]), /sampleUnverifiedHint/);
  assert.equal(app([{name: 'only.png', path: 'only.png'}]).canCompareCurrentPreview(), true);
  const mixed = app([{name: 'unidentified.png', path: 'unidentified.png'}, image('b2', 0, 2333)]);
  assert.equal(mixed.canCompareCurrentPreview(), true);
  mixed.previewStep = 0;
  assert.equal(mixed.canCompareCurrentPreview(), true);
});

test('legacy fixed files keep their exact identity on version updates and exit on metadata mutations or deletion', () => {
  for (const change of ['version', 'seed', 'params', 'source', 'removed', 'duplicate-reference', 'duplicate-target']) {
    const value = app([legacyImage(1), legacyImage(2), legacyImage(3)]);
    value.previewLightboxOpen = true; value.startPreviewComparison();
    value.selectPreviewComparisonCurrent(1);
    const [first, target, reference] = value.previews;
    const sample = value._sampleRecord(reference);
    let updated = [first, target, {...reference, version: '2', url: reference.url + '?v=2'}];
    if (change === 'seed') updated[2].sample = {...sample, seed: '9999'};
    if (change === 'params') updated[2].sample = {...sample, params: {cfg_scale: 7}};
    if (change === 'source') updated[2].sample = {...sample, metadata_source: 'recorded'};
    if (change === 'removed') updated = [first, target];
    if (change === 'duplicate-reference') updated.push({...reference});
    if (change === 'duplicate-target') updated.push({...target});
    value._replacePreviewItems(updated);
    if (change === 'version') {
      assert.equal(value.previewCompareActive, true);
      assert.equal(value.previewReferences[0], updated[2]);
      assert.equal(value.previewReferences[0].version, '2');
      value.resetSampleBrowser();
      assert.equal(value.previewCompareActive, false);
      assert.deepEqual(value.previewReferences, []);
    } else {
      assert.equal(value.previewCompareActive, false, change);
      assert.deepEqual(value.previewReferences, []);
    }
  }
});

test('a fixed legacy file survives later log refinement of its batch and step', () => {
  const value = app([legacyImage(1), legacyImage(2)]);
  value.previewLightboxOpen = true;
  value.pinPreviewReference(0); value.selectPreviewComparisonCurrent(1);
  const first = value.previews[0], sample = value._sampleRecord(first, 0);
  const refined = {...first, sample: {...sample, batch_id: 'legacy:log-call:1', batch_label: 'Epoch 1 · Step 400',
    epoch: 1, step: 400}};
  value._replacePreviewItems([refined, value.previews[1]]);
  assert.equal(value.previewCompareActive, true);
  assert.equal(value.previewComparisonWaiting, false);
  assert.deepEqual(value.previewReferences, [refined]);
  assert.equal(value.previewStep, 1);
});

test('an explicitly fixed legacy retry stays in the display timeline without relaxing automatic pairing', () => {
  const value = app([legacyImage(1), legacyImage(2), legacyImage(2, 0, '2333', '20261114120001')]);
  value.previewStep = 1;
  assert.equal(value.startPreviewComparison(), true);
  value.selectPreviewComparisonCurrent(0);
  assert.deepEqual(value._previewLightboxIndices(), [0]);
  assert.deepEqual(value._previewLightboxDisplayIndices(), [1, 0]);
  const duplicate = app([legacyImage(1), {...legacyImage(1)}, legacyImage(2)]);
  duplicate.previewStep = 0;
  assert.equal(duplicate.canCompareCurrentPreview(), false);
  assert.equal(duplicate.startPreviewComparison(), false);
});

test('reference identity survives array replacement and follows a new version of that exact file', () => {
  const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
  value.previewLightboxOpen = true; value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(1);
  const replacement = {...value.previews[2], version: '2', url: '/replaced-b3.png?v=2'};
  value._replacePreviewItems([image('b0', 0, 4200), value.previews[0], value.previews[1], replacement, image('b4', 0, 4200)]);
  assert.equal(value.previewReferences[0], replacement);
  assert.equal(value.previewReferences[0].version, '2');
  assert.equal(value.previewReferences[0].url, '/replaced-b3.png?v=2');
  assert.equal(value.previews[value.previewStep].sample.batch_id, 'b2');
});

test('a missing ambiguous or condition-replaced reference never falls back to another matching image', () => {
  for (const change of ['removed', 'duplicate', 'conditions', 'sampling-point']) {
    const value = app(['b1', 'b2', 'b3'].map(batch => image(batch, 0, 4200)));
    value.previewLightboxOpen = true; value.startPreviewComparison();
    value.selectPreviewComparisonCurrent(1);
    const [first, current, reference] = value.previews;
    const updated = change === 'removed' ? [first, current] : change === 'duplicate'
      ? [first, reference, {...reference}, current] : change === 'sampling-point'
        ? [first, {...reference, sample: {...reference.sample, batch_id: 'b4'}}, current]
        : [first, image('b3', 0, 4200, {params: {cfg_scale: 7}}), current];
    value._replacePreviewItems(updated);
    assert.equal(value.previewCompareActive, false);
    assert.deepEqual(value.previewReferences, []);
  }
});

test('overwriting a reference while it is also the target cannot silently replace its pinned conditions', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  value.previewLightboxOpen = true; value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(0);
  value.previewStep = 1; value.sampleBatchId = 'b2'; value._syncPreviewReference();
  value._replacePreviewItems([value.previews[0], image('b2', 0, 4200, {params: {cfg_scale: 7}})]);
  assert.equal(value.previewCompareActive, false);
  assert.deepEqual(value.previewReferences, []);
});

test('lightbox history skips a missing seed and a changed negative prompt instead of using batch navigation fallbacks', () => {
  const value = app([image('b1', 1, 4201), image('b2', 1, 4200),
    image('b3', 1, 4201, {sample: {prompt_id: 'different-negative'}}), image('b4', 1, 4201)]);
  assert.equal(value.previewStep, 3);
  assert.deepEqual(value._previewLightboxIndices(), [0, 3]);
  value._activateOverviewBatch(value._sampleDataModel().byBatch.get('b2'));
  assert.equal(value.previewStep, 1, 'the whole-batch browser can still display an available prompt with another seed');
});

test('viewer timeline jumps by image identity while retaining prompt and seed', () => {
  const value = app([image('b1', 0, 4200), image('b1', 1, 4200), image('b2', 0, 4200), image('b2', 1, 4200)]);
  value.previewStep = 2; value.sampleBatchId = 'b2';
  value.selectPreviewTimeline(1);
  assert.equal(value.previewStep, 2, 'a different prompt cannot be selected as a time point');
  value.selectPreviewTimelineByKey(value.previews[0].path);
  assert.equal(value.previewStep, 0);
  assert.equal(value.sampleBatchId, 'b1');
});

test('filename history keeps separate prompt slots when the seed is unknown', () => {
  const value = app([image('b1', 0, null, {sample: {metadata_source: 'filename', comparable: false}}),
    image('b1', 1, null, {sample: {metadata_source: 'filename', comparable: false}}),
    image('b2', 0, null, {sample: {metadata_source: 'filename', comparable: false}})]);
  assert.deepEqual(value._previewLightboxIndices(), [0, 2]);
});

test('viewer timeline renders long histories using thumbnail URLs', () => {
  const value = app(Array.from({length: 1000}, (_, index) => image('b' + (index + 1), 0, 4200)));
  value.weakNetworkMode = true;
  const indices = value._previewLightboxIndices();
  const html = value._previewViewTimelineHtml(indices);
  assert.equal(indices.length, 1000);
  assert.equal((html.match(/class="preview-view-timeline-item"/g) || []).length, 1000);
  assert.equal((html.match(/data-preview-url=/g) || []).length, 1000);
  assert.doesNotMatch(html, /<img src=/);
});

test('thumbnail cleanup retains an existing object URL while the image is decoding', () => {
  const value = app([]), revoked = [];
  value._previewMediaObjectUrls = ['blob:pending', 'blob:unused'];
  const image = {dataset: {previewUrl: '/thumbnail?v=1'}, closest: () => ({dataset: {previewPath: 'image.png'}}),
    getAttribute(name) {return name === 'src' ? 'blob:pending' : null;}};
  const root = {querySelectorAll() {return [image];}};
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    value._restorePreviewMedia(root, new Map());
    assert.deepEqual(value._previewMediaObjectUrls, ['blob:pending']);
    assert.deepEqual(revoked, ['blob:unused']);
  } finally { URL.revokeObjectURL = original; }
});

test('weak-network queue skips detached and changed-URL images before fetching', async () => {
  const value = app([]), fetched = [];
  value.weakNetworkMode = true;
  const detached = {isConnected: false, dataset: {previewUrl: '/detached?v=1', previewQueued: '1'}};
  const changed = {isConnected: true, dataset: {previewUrl: '/new?v=2', previewQueued: '1'}};
  const current = {isConnected: true, dataset: {previewUrl: '/current?v=1', previewQueued: '1'}};
  value._previewMediaQueue = [{image: detached, url: '/detached?v=1'}, {image: changed, url: '/old?v=1'},
    {image: current, url: '/current?v=1'}];
  value._previewMediaObjectUrls = []; value._previewMediaGeneration = 0;
  value._previewMediaLoading = false; value._previewMediaPaused = false;
  const originalFetch = global.fetch, originalCreate = URL.createObjectURL;
  global.fetch = async url => {fetched.push(url); return {ok: true, blob: async () => ({})};};
  URL.createObjectURL = () => 'blob:current';
  try {
    await value._drainPreviewMediaQueue();
    assert.deepEqual(fetched, ['/current?v=1']);
    assert.equal(detached.dataset.previewQueued, undefined);
    assert.equal(changed.dataset.previewQueued, undefined);
    assert.equal(current.src, 'blob:current');
    assert.equal(value._previewMediaLoading, false);
    assert.deepEqual(value._previewMediaQueue, []);
  } finally {global.fetch = originalFetch; URL.createObjectURL = originalCreate;}
});

test('case labels omit redundant seeds but distinguish seeds and conditions within a batch', () => {
  const value = app([image('b1', 0, 4200), image('b1', 1, 4201), image('b2', 0, 4200),
    image('b2', 0, 4201), image('b2', 1, 4200), image('b2', 1, 4200, {params: {cfg_scale: 7}})]);
  assert.equal(value._sampleCaseLabel(value.previews[0]), 'Prompt 1');
  assert.equal(value._sampleCaseLabel(value.previews[1]), 'Prompt 2');
  assert.equal(value._sampleCaseLabel(value.previews[2]), 'Prompt 1 Seed 4200');
  assert.equal(value._sampleCaseLabel(value.previews[3]), 'Prompt 1 Seed 4201');
  assert.equal(value._sampleCaseLabel(value.previews[4]), 'Prompt 2 CFG 5');
  assert.equal(value._sampleCaseLabel(value.previews[5]), 'Prompt 2 CFG 7');
});

test('preview labels omit generated middle dots while preserving user prompt and file text', () => {
  const value = app([image('b1', 0, 4200, {suffix: 'user·file', params: {prompt: 'fox · cat'}, sample: {epoch: 1, step: 400, prompt_label: 'fox · cat'}}),
    image('b2', 0, 4201, {params: {prompt: 'fox · cat'}, sample: {epoch: 2, step: 800, prompt_label: 'fox · cat'}})]);
  assert.equal(value._sampleCaseLabel(value.previews[0], true), 'Prompt 1 Seed 4200');
  assert.equal(value._sampleDataModel().batches[0].label, 'Epoch 1 · Step 400', 'canonical stage metadata remains unchanged');
  value.sampleExpandedBatchId = 'b1';
  const overview = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.doesNotMatch(overview, /Epoch [12] · Step/);
  assert.equal(value._samplePromptText(value.previews[0]), 'fox · cat');
  assert.match(value._previewGenerationInfoHtml(value.previews[0]), /fox · cat/);
  assert.match(overview, /user·file/);
});

test('stage labels follow the active locale without rewriting canonical metadata or custom labels', () => {
  const value = app([image('b1', 0, 4200, {sample: {epoch: 2, step: 800}})]);
  const model = value._sampleDataModel();
  for (const [locale, epoch, step] of [['zh-CN', '第 2 轮', '第 800 步'], ['en-US', 'Epoch 2', 'Step 800'], ['ja-JP', 'エポック 2', 'ステップ 800']]) {
    const messages = require('../../frontend/i18n/' + locale + '.json');
    value.t = key => key.split('.').reduce((item, part) => item?.[part], messages) || key;
    assert.deepEqual(value._previewCaptionParts(value.previews[0]), {primary: epoch, secondary: step});
    assert.deepEqual(value._sampleStageParts('Epoch 2 · Step 800 (2)'), {primary: epoch, secondary: step + ' (2)'});
    assert.deepEqual(value._sampleStageParts('Epoch 2'), {primary: epoch, secondary: ''});
    assert.deepEqual(value._sampleStageParts('Step 800'), {primary: step, secondary: ''});
    assert.deepEqual(value._sampleStageParts('custom Epoch 2 · fox'), {primary: 'custom Epoch 2 · fox', secondary: ''});
    assert.equal(value._sampleDataModel(), model);
    assert.equal(model.batches[0].label, 'Epoch 2 · Step 800');
  }
});

test('historical filename labels switch language after the batch model was cached in Chinese', () => {
  const stepName = legacyImage(800).name.replace('e000800', '000800');
  const value = app([legacyImage(2), {name: stepName, path: 'sample/' + stepName, url: '/' + stepName}]);
  let model;
  for (const [locale, epoch, step] of [['zh-CN', '第 2 轮', '第 800 步'], ['en-US', 'Epoch 2', 'Step 800'], ['ja-JP', 'エポック 2', 'ステップ 800']]) {
    const messages = require('../../frontend/i18n/' + locale + '.json');
    value.t = key => key.split('.').reduce((item, part) => item?.[part], messages) || key;
    if (!model) { value._sampleModelCache = null; model = value._sampleDataModel(); }
    assert.deepEqual(value._previewCaptionParts(value.previews[0]), {primary: epoch, secondary: ''});
    assert.deepEqual(value._previewCaptionParts(value.previews[1]), {primary: step, secondary: ''});
    assert.equal(value._sampleDataModel(), model);
    assert.deepEqual(model.batches.map(batch => batch.label), ['Epoch 2', 'Step 800']);
  }
});

test('adjacent uint64 seeds remain different cases and cannot be paired after JavaScript integer rounding', () => {
  const first = '18446744073709551614', second = '18446744073709551615';
  const value = app([image('b1', 0, first), image('b2', 0, second), image('b3', 0, first)]);
  assert.deepEqual(value._previewLightboxIndices(), [0, 2]);
  value.startPreviewComparison();
  value.selectPreviewComparisonCurrent(1);
  assert.equal(value.previewCompareActive, false, 'an adjacent uint64 seed cannot join the fixed comparison');
});

test('model and external LoRA case labels show asset names and strengths instead of object coercions', () => {
  const value = app([
    image('b1', 0, 4200, {params: {base_model: {path: 'C:/models/base-a.safetensors', mtime_ns: '1794612000000000000'},
      model_variant: {turbo_dit: {path: 'C:/models/turbo-a.safetensors'}}, loras: [{path: 'C:/loras/style-a.safetensors', multiplier: 0.6}]}}),
    image('b1', 0, 4200, {suffix: 'other', params: {base_model: {path: 'C:/models/base-b.safetensors', mtime_ns: '1794612000000000001'},
      model_variant: {turbo_lora: {path: 'C:/loras/turbo-b.safetensors'}, turbo_lora_multiplier: 0.8}, loras: [{path: 'C:/loras/style-b.safetensors', multiplier: 1.2}]}}),
  ]);
  const labels = value.previews.map(preview => value._sampleCaseLabel(preview)).join(' ');
  assert.match(labels, /base-a\.safetensors/);
  assert.match(labels, /turbo-a\.safetensors/);
  assert.match(labels, /turbo-b\.safetensors × 0\.8/);
  assert.match(labels, /style-b\.safetensors × 1\.2/);
  assert.doesNotMatch(labels, /\[object Object\]|mtime_ns/);
});

test('historical duplicate files remain browsable with an unambiguous earlier time point', () => {
  const value = app([image('b1', 0, 4200), image('b1', 0, 4201), image('b2', 0, 4201), image('b2', 0, 4201, {suffix: 'retry'})]);
  assert.deepEqual(value._sampleDataModel().batches.map(batch => batch.indices), [[0, 1], [2, 3]]);
  value.previewStep = 2;
  assert.deepEqual(value._previewLightboxIndices(), [1, 2]);
});

test('the overview has no separate comparison controls and resetting a run clears its fixed viewer references', () => {
  const value = app([image('b1', 0, 4200), image('b2', 0, 4200)]);
  const html = value._renderSamplesTab(key => value.t('monitor.' + key));
  assert.match(html, /sampleSidebarToggle/);
  assert.doesNotMatch(html, /data-preview-sort|samplePromptTrigger|sampleMatrix|sampleCompare|sampleComparisonBack/);
  value.pinPreviewReference(0); value.pinPreviewReference(1);
  value.resetSampleBrowser();
  assert.equal(value.sampleBatchId, '');
  assert.equal(value.previewCompareActive, false);
  assert.equal(value.previewComparisonWaiting, false);
  assert.deepEqual(value.previewReferences, []);
});
