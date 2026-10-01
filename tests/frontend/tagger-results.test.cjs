const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tagger.js'), 'utf8'), context);

function fixture() {
  const requested = [];
  const app = { ...context.window.taggerMixin,
    taggerSourceMode: 'single', taggerSelectedModel: 'camie-tagger-v2',
    taggerSettings: { threshold: 0.5, categoryThresholds: {}, categoryEnabledByModel: {},
      removeDuplicated: true, replaceUnderscore: true, escapeTag: true },
    taggerCategoryState: {}, tagDictionaryLookupTags: tags => requested.push(...tags),
    taggerUsesCategoryThresholds: () => true, taggerCategoryLabel: key => key,
    saveTaggerSettings() {},
  };
  return { app, requested };
}

test('logs follow the UI language, preserve filenames, and expand the full retained history', () => {
  const { app } = fixture();
  const entry = { event: 'written', name: 'error_failed_{count}.png', current: 14, total: 19, count: 52 };
  app.taggerTask = { logs: Array(200).fill(entry) };
  assert.equal(app.taggerVisibleLogs().length, 32);
  app.taggerLogsOpen = true;
  assert.equal(app.taggerVisibleLogs().length, 200);
  for (const [locale, expected] of [['zh-CN', '：已写入 52 个标签'], ['en-US', ': wrote 52 tags']]) {
    const messages = JSON.parse(fs.readFileSync(path.join(__dirname, `../../frontend/i18n/${locale}.json`), 'utf8'));
    app.t = key => key.split('.').reduce((value, part) => value[part], messages);
    assert.equal(app.taggerLogMessage(entry), `[14/19] ${entry.name}${expected}`);
  }
  app.taggerTask.logs = ['[21:00:21] legacy {failed}'];
  assert.equal(app.taggerVisibleLogs()[0].time, '21:00:21');
  assert.equal(app.taggerLogMessage(app.taggerVisibleLogs()[0]), 'legacy {failed}');
});

test('preview limit never truncates output, including after lowering the threshold', () => {
  const { app } = fixture();
  const tags = Array.from({ length: 250 }, (_, i) => [`tag_${i}`, i < 200 ? 0.9 : 0.4]);
  app.setTaggerResult({ categories: { general: { tags, total: 250 } }, text: '' });
  assert.equal(app.taggerResultTags().length, 200);
  app.taggerCategoryState.general.threshold = 0.3;
  app.recalculateTaggerCategory('general');
  assert.equal(app.taggerResultTags().length, 250);
  assert.equal(app.taggerCategoryPreview(app.taggerCategoryState.general).length, 200);
  assert.ok(app.taggerResultText.endsWith('tag 249'));
});

test('dictionary receives raw names and cannot alter comma-separated output', () => {
  const { app, requested } = fixture();
  app.setTaggerResult({ categories: { general: { tags: [['long_hair', 0.9], ['name_(series)', 0.8]] } } });
  assert.deepEqual(requested, ['long_hair', 'name_(series)']);
  assert.equal(app.taggerResultText, 'long hair, name \\(series\\)');
  app.syncTaggerDictionary();
  assert.equal(app.taggerResultText, 'long hair, name \\(series\\)');
});

test('single category controls work before inference without creating a fake result', () => {
  const { app } = fixture();
  app.taggerCategoryKeys = () => ['general', 'character'];
  assert.deepEqual(Array.from(app.taggerSingleCategories(), row => row.key), ['general', 'character']);
  app.setTaggerSingleCategoryThreshold('general', 0.2);
  app.setTaggerSingleCategoryEnabled('character', false);
  assert.equal(app.taggerSettings.categoryThresholds.general, 0.2);
  assert.equal(app.taggerSingleCategoryEnabled('character'), false);
  assert.equal(Object.keys(app.taggerCategoryState).length, 0);
  app.setTaggerResult({ categories: { general: { tags: [['solo', 0.3], ['sky', 0.1]] }, character: { tags: [['alice', 0.9]] } } });
  assert.equal(app.taggerResultText, 'solo');
  app.setTaggerSingleCategoryThreshold('general', 0.05);
  assert.equal(app.taggerResultText, 'solo, sky');
  app.setTaggerSingleCategoryEnabled('general', false);
  assert.equal(app.taggerResultText, '');
  assert.equal(app.taggerSingleCategories().length, 2);
});

test('inline threshold increments preserve precision and clamp to the valid range', () => {
  const { app } = fixture();
  app.setTaggerSingleCategoryThreshold('general', 0.17 + 0.01);
  assert.equal(app.taggerSingleCategoryThreshold('general'), 0.18);
  app.setTaggerSingleCategoryThreshold('general', 0.18 - 0.01);
  assert.equal(app.taggerSingleCategoryThreshold('general'), 0.17);
  app.setTaggerSingleCategoryThreshold('general', -0.01);
  assert.equal(app.taggerSingleCategoryThreshold('general'), 0);
  app.setTaggerSingleCategoryThreshold('general', 1.01);
  assert.equal(app.taggerSingleCategoryThreshold('general'), 1);
});

test('WD inline thresholds update the proper category and keep complete output', () => {
  const { app } = fixture();
  app.taggerUsesCategoryThresholds = () => false;
  app.taggerSettings.characterThreshold = 0.6;
  app.taggerSettings.characterEnabledByModel = {};
  app.setTaggerResult({ categories: { general: { tags: [['solo', 0.4]] }, character: { tags: [['alice', 0.7]] } } });
  app.setTaggerSingleCategoryThreshold('general', 0.3);
  assert.equal(app.taggerResultText, 'solo, alice');
  app.setTaggerSingleCategoryThreshold('character', 0.8);
  assert.equal(app.taggerResultText, 'solo');
  assert.equal(app.taggerSettings.threshold, 0.3);
});

test('category inclusion persists and removing every category empties output', () => {
  const { app } = fixture();
  app.setTaggerResult({ categories: { general: { tags: [['solo', 0.9]] } } });
  app.setTaggerSingleCategoryEnabled('general', false);
  assert.equal(app.taggerResultText, '');
  assert.equal(app.taggerCategoryEnabled('general'), false);
  app.setTaggerSingleCategoryEnabled('general', true);
  assert.equal(app.taggerResultText, 'solo');
  assert.equal(app.taggerCategoryEnabled('general'), true);
});

test('excluded categories retain preview and translations while thresholds still filter them', () => {
  const { app, requested } = fixture();
  app.setTaggerResult({ categories: { general: { tags: [['solo', 0.9], ['long_hair', 0.4]] } } });
  app.setTaggerSingleCategoryEnabled('general', false);
  assert.equal(app.taggerResultText, '');
  assert.equal(app.taggerCategoryPreview(app.taggerCategoryState.general).length, 1);
  requested.length = 0;
  app.setTaggerSingleCategoryThreshold('general', 0.3);
  assert.equal(app.taggerCategoryPreview(app.taggerCategoryState.general).length, 2);
  assert.deepEqual(requested, ['solo', 'long_hair']);
  assert.equal(app.taggerResultText, '');
  app.setTaggerSingleCategoryEnabled('general', true);
  assert.equal(app.taggerResultText, 'solo, long hair');
});

test('AI captions remain intact and only tag-mode results use the dictionary', async () => {
  for (const mode of ['tags', 'caption']) {
    const { app, requested } = fixture();
    Object.assign(app, { taggerSourceMode: 'api-single', taggerSource: { source_token: 'test' },
      taggerApiCanStart: () => true, saveTaggerApiSettings() {},
      taggerApiPayload: () => ({ parse_mode: mode }), taggerApiOptions: () => ({}),
      toast(message) { throw new Error(message); },
    });
    const text = mode === 'tags' ? 'long_hair, solo' : 'Long hair, blue eyes. A portrait.';
    context.fetch = async () => ({ json: async () => ({ status: 'success', data: { text } }) });
    await app.runApiTaggerSingle();
    assert.equal(app.taggerResultText, text);
    assert.deepEqual(requested, mode === 'tags' ? ['long_hair', 'solo'] : []);
  }
});

test('truncated terminal event fetches and displays the complete result even within the throttle window', async () => {
  const { app } = fixture();
  const tags = Array.from({ length: 250 }, (_, i) => [`tag_${i}`, 0.9]);
  let requests = 0;
  let pending;
  Object.assign(app, { taggerTaskId: 'task-1', taggerSelectedIndex: 0, taggerItems: [],
    _taggerLastItemsFetch: Date.now(), _setTaggerRealtimeTask() {}, toast() {}, t: key => key });
  const refresh = app.refreshTaggerItems.bind(app);
  app.refreshTaggerItems = reset => (pending = refresh(reset));
  context.fetch = async () => {
    requests++;
    return { json: async () => ({ status: 'success', data: { total: 1,
      items: [{ index: 0, result: { index: 0, categories: { general: { tags } } } }] } }) };
  };
  app.applyTaggerTaskSnapshot({ status: 'done', current: 1, realtime_truncated: true }, 'FINISHED');
  assert.equal(requests, 1);
  await pending;
  assert.equal(app.taggerRunning, false);
  assert.equal(app.taggerResultTags().length, 250);
  assert.equal(app.taggerCategoryPreview(app.taggerCategoryState.general).length, 200);
});

test('a late items response cannot replace a newer task or mode', async () => {
  for (const change of ['task', 'mode']) {
    const { app } = fixture();
    Object.assign(app, { taggerTaskId: 'old-task', taggerItems: [], taggerResultText: 'new result' });
    let resolve;
    context.fetch = () => new Promise(done => { resolve = done; });
    const pending = app.refreshTaggerItems(false);
    if (change === 'task') app.taggerTaskId = 'new-task';
    else app.taggerSourceMode = 'api-single';
    resolve({ json: async () => ({ status: 'success', data: { total: 1,
      items: [{ index: 0, result: { index: 0, text: 'stale result' } }] } }) });
    await pending;
    assert.equal(app.taggerResultText, 'new result');
    assert.equal(app.taggerItems.length, 0);
  }
});

test('an older progress fetch cannot overwrite the completed result', async () => {
  const { app } = fixture();
  Object.assign(app, { taggerTaskId: 'task-1', taggerSelectedIndex: 0, taggerItems: [] });
  const replies = [];
  context.fetch = () => new Promise(resolve => replies.push(resolve));
  const progress = app.refreshTaggerItems(false);
  const completed = app.refreshTaggerItems(false);
  replies[1]({ json: async () => ({ status: 'success', data: { total: 1,
    items: [{ index: 0, status: 'success', result: { index: 0, text: 'solo' } }] } }) });
  await completed;
  assert.equal(app.taggerResultText, 'solo');
  replies[0]({ json: async () => ({ status: 'success', data: { total: 1,
    items: [{ index: 0, status: 'running' }] } }) });
  await progress;
  assert.equal(app.taggerItems[0].status, 'success');
  assert.equal(app.taggerResultText, 'solo');
});
