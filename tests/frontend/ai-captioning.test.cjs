const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, response, deferred} = require('./helpers.cjs');

function harness() {
  const storage = new Map();
  const timers = new Map();
  const context = loadFrontend(['tagger', 'ai-caption-options'], {
    window: {}, localStorage: {getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k)},
    setTimeout: fn => {const id = timers.size + 1; timers.set(id, fn); return id;}, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => fn(), document: {querySelector: () => null, body: {classList: {remove() {}}}},
    fetch: async url => response(url.endsWith('/active') ? {task_id: null} : {}),
  });
  const app = {...context.window.taggerMixin, ...context.window.captionOptionsMixin};
  app.taggerSettings = {...app.taggerSettings};
  app.taggerApiSettings = {...app.taggerApiSettings};
  app.captionOptions = {...app.captionOptions, candidates: ['long', 'medium', 'short']};
  app.TAGGER_API_BUILTIN_PROMPT_TEXTS = {...app.TAGGER_API_BUILTIN_PROMPT_TEXTS, multi: 'Return caption.long / medium / short JSON.'};
  app._taggerModeStates = {folder: null, single: null, 'api-folder': null, 'api-single': null};
  app.t = key => key;
  app.toast = () => {};
  app._mountTaggerWorkspace = async () => {};
  app.tagDictionaryInit = app.syncTaggerDictionary = app.realtimeSubscribe = app.realtimeUnsubscribe = app.renderTaggerResourceBar = () => {};
  app.loadTaggerModels = async () => {};
  return {app, context, timers, storage};
}

test('separate sidebar routes preserve independent source and single-image state', async () => {
  const {app} = harness();
  app.currentRoute = 'tagger';
  app.taggerSourcePath = 'local-folder';
  await app.buildTaggerForm();
  app.currentRoute = 'ai-captioning';
  await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode, 'api-folder');
  assert.equal(app.taggerSourcePath, '');
  await app.selectTaggerSourceMode('api-single');
  app.taggerSourcePath = 'single-image.png';
  app.taggerResultText = 'saved caption';
  app.currentRoute = 'tagger';
  await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode, 'folder');
  assert.equal(app.taggerSourcePath, 'local-folder');
  app.currentRoute = 'ai-captioning';
  await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode, 'api-single');
  assert.equal(app.taggerSourcePath, 'single-image.png');
  assert.equal(app.taggerResultText, 'saved caption');
});

test('AI route does not restore a local tagger task into its batch page', async () => {
  const {app, context} = harness();
  app.currentRoute = 'ai-captioning';
  app.taggerSourceMode = 'api-single';
  app.taggerSourcePath = 'keep.png';
  context.fetch = async () => response({engine: 'pytorch', source_kind: 'folder', source_root: 'local-folder', status: 'running'});
  await app.restoreTaggerTask('local-task');
  assert.equal(app.taggerSourceMode, 'api-single');
  assert.equal(app.taggerSourcePath, 'keep.png');
  assert.equal(app.taggerTaskId, null);
});

test('JSON export needs neither model nor API; running tasks block duplicate starts', () => {
  const {app} = harness();
  app.taggerSourceMode = 'api-folder';
  app.taggerSource = {total: 1};
  assert.equal(app.taggerApiCanStart(), false);
  app.captionOptions.mode = 'export';
  assert.equal(app.taggerApiCanStart(), true);
  app.taggerRunning = true;
  assert.equal(app.taggerApiCanStart(), false);
  app.taggerRunning = false;
  app.taggerApiSettings.parseMode = 'multi-caption';
  app.captionOptions.candidates = [];
  assert.equal(app.taggerApiCanStart(), false);
});

test('output format updates built-in prompts while retaining a custom prompt', () => {
  const {app} = harness();
  app.applyCaptionFormat('multi-caption');
  assert.equal(app.taggerApiSettings.promptPresetId, 'multi');
  assert.equal(app.taggerApiSettings.parseMode, 'multi-caption');
  assert.equal(app.captionOptions.max_tokens, 16384);
  app.taggerApiUserPresets = [{id:'user-custom',text:'Keep this template',name:'Custom'}];
  app.taggerApiSettings.promptPresetId = 'user-custom';
  app.taggerApiSettings.promptText = 'Keep this template';
  app.applyCaptionFormat('caption');
  assert.equal(app.taggerApiSettings.parseMode, 'caption');
  assert.equal(app.taggerApiSettings.promptText, 'Keep this template');
});

test('prompt options contain only Booru and MOSS built-ins with descriptions', () => {
  const {app} = harness();
  assert.deepEqual(Array.from(app.taggerApiBuiltinPrompts(), preset => preset.id), ['booru', 'multi']);
  app.taggerApiUserPresets = [{id:'user-custom', name:'Custom', text:'Custom prompt', parseMode:'tags'}];
  const groups = app.taggerApiPromptSelectConfig().groups;
  assert.equal(groups.length, 2);
  assert(groups.flatMap(group => group.options).every(option => option.d));
  app.selectTaggerApiPromptPreset('multi');
  assert.equal(app.taggerApiPresetDescription(), 'tagger.apiPromptPresetMultiDesc');
});

test('removed natural-language built-ins fall back without deleting custom presets', () => {
  for (const id of ['caption', 'detailed']) {
    const {app, storage} = harness();
    storage.set('anima-tagger-api-settings', JSON.stringify({promptPresetId:id, promptText:'Removed built-in text', parseMode:'caption'}));
    storage.set('anima-tagger-api-prompts', JSON.stringify([{id:'user-custom', name:'Keep', text:'Keep my prompt', parseMode:'caption'}]));
    app._loadTaggerApiSettings();
    assert.equal(app.taggerApiSettings.promptPresetId, 'booru');
    assert.equal(app.taggerApiSettings.parseMode, 'tags');
    assert.equal(app.taggerApiSettings.promptText, app.TAGGER_API_BUILTIN_PROMPT_TEXTS.booru);
    assert.equal(app.taggerApiUserPresets[0].text, 'Keep my prompt');
  }
});

test('image transfer format controls whether JPEG quality applies', () => {
  const {app} = harness();
  assert.equal(app.captionImageFormat(), 'png');
  app.setCaptionImageFormat('jpeg');
  assert.equal(app.captionOptions.jpeg_quality, 90);
  app.captionOptions.jpeg_quality = 85;
  app.setCaptionImageFormat('jpeg');
  assert.equal(app.captionOptions.jpeg_quality, 85);
  app.setCaptionImageFormat('png');
  assert.equal(app.captionOptions.jpeg_quality, '');
});

test('AI requests ignore old local tag-processing settings', () => {
  const {app, storage} = harness();
  storage.set('anima-tagger-api-settings', JSON.stringify({model:'my-model', additionalTags:'old tag', excludeTags:'watermark', replaceUnderscore:true, escapeTag:true, removeDuplicated:true}));
  app._loadTaggerApiSettings();
  assert.equal(app.taggerApiSettings.model, 'my-model');
  assert.equal(app.taggerApiSettings.replaceUnderscore, undefined);
  assert.equal(app.taggerApiSettings.additionalTags, undefined);
  assert.deepEqual(Object.keys(app.taggerApiOptions()), ['captioning']);
});

test('a single-image response arriving after route change stays with its AI source', async () => {
  const {app, context} = harness();
  const pending = deferred();
  context.fetch = () => pending.promise;
  app.currentRoute = 'ai-captioning';
  app.taggerSourceMode = 'api-single';
  app.taggerSource = {source_token: 'ai-image', total: 1};
  app.taggerApiSettings.apiKey = 'test-key';
  app.taggerApiSettings.model = 'test-vlm';
  app.taggerApiSettings.promptText = 'Caption this image';
  const run = app.runApiTaggerSingle();
  app._taggerModeStates['api-single'] = app._captureTaggerModeState();
  app.currentRoute = 'tagger';
  app.taggerSourceMode = 'single';
  app.taggerSource = {source_token: 'local-image'};
  app.taggerResultText = 'local result';
  pending.resolve(response({text: 'AI result', raw: 'raw AI response', elapsed: 1}));
  await run;
  assert.equal(app.taggerResultText, 'local result');
  assert.equal(app._taggerModeStates['api-single'].resultText, 'AI result');
  assert.equal(app.taggerApiSingleRunning, false);
});

test('the initial local route restores its saved single-image tab', async () => {
  const {app, storage} = harness();
  app.currentRoute = 'tagger';
  storage.set('anima-tagger-mode', 'single');
  await app.buildTaggerForm();
  assert.equal(app.taggerSourceMode, 'single');
});

test('all formats restore through the same task with its output controls', async () => {
  const {app, context} = harness();
  app.currentRoute = 'ai-captioning';
  app.taggerSourceMode = 'api-single';
  app.taggerSourcePath = 'keep-single.png';
  context.fetch = async () => response({engine:'api',source_kind:'folder',source_token:'saved-source',status:'running',logs:[],parse_mode:'multi-caption',caption_options:{mode:'export',candidates:['short']}});
  app.refreshTaggerItems = async () => {};
  await app.restoreTaggerTask('shared-task');
  assert.equal(app.taggerSourceMode, 'api-folder');
  assert.equal(app.taggerApiSettings.parseMode, 'multi-caption');
  assert.equal(app.captionOptions.mode, 'export');
  assert.equal(app.captionOptions.candidates[0], 'short');
  assert.equal(app.taggerRunning, true);
  assert.equal(app._taggerModeStates['api-single'].sourcePath, 'keep-single.png');
});

test('model names stay empty until explicitly entered or selected', () => {
  const {app} = harness();
  app._loadTaggerApiSettings();
  assert.equal(app.taggerApiSettings.model, '');
  app.taggerApiSettings.model = 'manually-selected';
  app.applyTaggerApiProvider('openai');
  assert.equal(app.taggerApiSettings.model, '');
  app.taggerApiSettings.model = 'chosen-openai-model';
  app.saveTaggerApiSettings();
  app._loadTaggerApiSettings();
  assert.equal(app.taggerApiSettings.model, 'chosen-openai-model');
});

test('old auto-filled defaults are cleared without clearing later explicit choices', () => {
  const {app, storage} = harness();
  storage.set('anima-tagger-api-settings', JSON.stringify({model:'deepseek-v4-flash-vision-exp'}));
  app._loadTaggerApiSettings();
  assert.equal(app.taggerApiSettings.model, '');
  storage.set('anima-tagger-api-settings', JSON.stringify({model:'user-custom-model'}));
  app._loadTaggerApiSettings();
  assert.equal(app.taggerApiSettings.model, 'user-custom-model');
  storage.set('anima-tagger-api-settings', JSON.stringify({model:'gpt-4o-mini', modelSelectionVersion:1}));
  app._loadTaggerApiSettings();
  assert.equal(app.taggerApiSettings.model, 'gpt-4o-mini');
});
