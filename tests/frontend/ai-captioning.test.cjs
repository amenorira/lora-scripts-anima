const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, response, deferred, composeMixins} = require('./helpers.cjs');

function harness() {
  const storage = new Map();
  const context = loadFrontend(['tagger/index', 'tagger/ai-caption-options', 'tagger/caption-workspace'], {
    window: {}, localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    setTimeout:()=>1,clearTimeout:()=>{},requestAnimationFrame:fn=>fn(),document:{querySelector:()=>null,body:{classList:{remove(){}}}},
    fetch:async()=>response({task_id:null}), AbortController,
  });
  const app = composeMixins(context.window.taggerMixin,context.window.captionOptionsMixin);
  app.captionApiPayload = context.window.captionWorkspaceMixin.captionApiPayload;
  app.refreshCaptionPlan = async()=>({plan:{}});
  app.taggerSettings={...app.taggerSettings};app.taggerApiSettings={...app.taggerApiSettings};
  app.captionOptions={...app.captionOptions,output_format:'multi',candidates:['original','long','medium','short']};
  app._taggerModeStates={folder:null,single:null,'api-folder':null};
  app.t=k=>k;app.toast=()=>{};app._mountTaggerWorkspace=async()=>{};
  app.tagDictionaryInit=app.syncTaggerDictionary=app.realtimeSubscribe=app.realtimeUnsubscribe=app.renderTaggerResourceBar=()=>{};
  app.loadTaggerModels=app.loadCaptionTemplate=async()=>{};
  return {app,context,storage};
}

test('a rejected batch description launch keeps the previous record recoverable', async () => {
  const {app,context,storage} = harness();
  const errors = [];
  app.currentRoute = 'ai-captioning';
  app.taggerSourceMode = 'api-folder';
  app.taggerSource = { total: 1, source_token: 'folder' };
  app.captionOptions.mode = 'export';
  app.taggerTaskId = 'old-description';
  app._taggerTasks = { 'old-description': { status: 'done', failed: 1 } };
  app.toast = error => errors.push(error);
  storage.set('anima-ai-tagger-task-id', 'old-description');
  context.fetch = async () => ({ json: async () => ({ status: 'fail', message: 'Another Tagger task is running' }) });

  await app.startApiTagger();
  assert.deepEqual(errors, ['Another Tagger task is running']);
  assert.equal(app.taggerStarting, false);
  assert.equal(app.taggerTask.failed, 1);
  assert.equal(storage.get('anima-ai-tagger-task-id'), 'old-description');
});

test('switching task clears overwrite so an export choice cannot trigger regeneration',()=>{
  const {app}=harness();app.captionOptions.overwrite=true;app.setCaptionTaskMode('export');
  assert.equal(app.captionOptions.overwrite,false);app.captionOptions.overwrite=true;app.setCaptionTaskMode('generate');
  assert.equal(app.captionOptions.overwrite,false);
});
