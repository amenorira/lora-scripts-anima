const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');
const { test } = require('node:test');

const context = { window: {} };
loadFrontend('tagger.js', context);

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
