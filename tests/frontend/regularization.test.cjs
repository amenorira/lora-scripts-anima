const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('generate checks changed settings then starts, and never starts after a failed check', async () => {
  const app = fixture();
  const calls = [];
  app.regPlanDirty = true;
  app.regScan = async () => { calls.push('scan'); app.regPlan = {total:2, pending:2}; app.regPlanDirty = false; };
  app.regStart = async () => calls.push('start');
  await app.regGenerate();
  assert.deepEqual(calls, ['scan', 'start']);
  app.regPlanDirty = true;
  app.regScan = async () => { app.regReportError('invalid folder'); };
  await app.regGenerate();
  assert.deepEqual(calls, ['scan', 'start']);
  assert.deepEqual(app.toasts.at(-1), {message:'invalid folder', type:'error'});
});

test('generate creates another round after completion and reports empty plans', async () => {
  const app = fixture();
  app.regPlan = {total:1, pending:0};
  app.regScan = async () => {};
  let rounds = 0; app.regAgain = async () => { rounds++; };
  await app.regGenerate();
  assert.equal(rounds, 1);
  app.regPlan = {total:0, pending:0};
  await app.regGenerate();
  assert.equal(rounds, 1);
  assert.equal(app.toasts.at(-1).message, 'noUsableSources');
});

test('generate rescans a completed plan and starts additions instead of another round', async () => {
  const app = fixture();
  app.regPlan = {total:1, pending:0};
  app.regPlanConsumed = true;
  const calls = [];
  app.regScan = async () => {
    calls.push('scan');
    app.regPlan = {total:2, completed:1, pending:1};
    app.regPlanConsumed = false;
  };
  app.regStart = async () => calls.push('start');
  app.regAgain = async () => calls.push('again');
  await app.regGenerate();
  assert.deepEqual(calls, ['scan', 'start']);
});

test('training blocks every generation entry point before scanning or requesting', async () => {
  const app = fixture();
  app.trainingActive = true;
  app.regPlan = {total:1, pending:1};
  app.regTab = 'inspect';
  app.regScan = async () => assert.fail('must not scan');
  app.regRequest = async () => assert.fail('must not request');
  await app.regGenerate();
  await app.regStart();
  await app.regAgain();
  await app.regResume();
  await app.regResume(true);
  await app.regMutate({index:1}, 'regenerate');
});

test('training starting during a generation scan prevents launch', async () => {
  const app = fixture();
  app.regScan = async () => {
    app.regPlan = {total:1, pending:1};
    app.trainingActive = true;
  };
  app.regRequest = async () => assert.fail('must not launch');
  await app.regGenerate();
});

test('polling errors use the existing toast once per repeated error', async () => {
  const app = fixture();
  app.regReportError('disconnected'); app.regReportError('disconnected');
  assert.equal(app.toasts.length, 1);
  await app.regAction(async () => { throw new Error('bad input'); });
  assert.equal(app.toasts.at(-1).message, 'bad input');
  assert.equal(app.regBusy, false);
});

function fixture() {
  const saved = new Map();
  const timers = new Map(); let timerId = 0;
  const context = {window: {}, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval: () => {}, localStorage: {getItem: k => saved.get(k), setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/regularization.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/training-core.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tagger.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/monitor-logs.js'), 'utf8'), context);
  const app = Object.create(context.window.regularizationMixin);
  app.savedSettings = saved;
  app.testWindow = context.window;
  app.flushTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  app.regSettings = {seed:'-1', cfg:4, width:1024, height:768, size_mode:'bucket', extra_positive:''}; app.regDefaults = {...app.regSettings};
  app._regUndo = {}; app.regEdits = {}; app.regT = key => key;
  app.regSources = []; app.regItems = [];
  app._regFields = {}; app.stepField = context.window.trainingCoreMixin.stepField;
  app.taggerVisibleLogs = context.window.taggerMixin.taggerVisibleLogs;
  app._parseLogRecord = context.window.monitorLogRenderMixin._parseLogRecord;
  app.realtimeSubscribe = app.realtimeUnsubscribe = () => {};
  app.toasts = []; app.toast = (message, type) => app.toasts.push({message, type});
  return app;
}

function activityFixture() {
  let app;
  const context = {
    window: {}, document: {addEventListener: (_, callback) => callback(), hidden: false},
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: {getItem() {}, setItem() {}, removeItem() {}},
    Alpine: {data: (_, factory) => { app = factory(); }}, AbortController,
  };
  for (const file of ['regularization', 'training-core', 'training-toml', 'tagger', 'monitor-core', 'app']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../../frontend/js/${file}.js`), 'utf8'), context);
  }
  app.t = key => key;
  app.toast = () => {};
  app.realtimeSubscribe = app.realtimeUnsubscribe = () => {};
  app.realtimeState = 'online'; app.realtimeReady = true;
  app.taggerSource = {total:1}; app.taggerSelectedModel = 'test-model';
  app.setSnapshot = active => {
    context.fetch = async () => ({ok:true, json:async () => ({status:'success', data:{
      server:{regularization_active:active}, tasks:{managed:[]},
    }})});
  };
  return app;
}

test('generation status blocks training and local tagging across routes, then releases them', async () => {
  const app = activityFixture();
  app.validateForm = () => assert.fail('blocked training must not prepare');
  for (const route of ['home', 'train-anima', 'tagger']) {
    app.currentRoute = route;
    app.setSnapshot(true); await app._pollTrainingState();
    assert.equal(app.backendStatusLabel, 'common.regularizationInProgress');
    assert.equal(app.trainingActive, false);
    assert.equal(app.isTraining, false);
    assert.equal(app.taggerCanStart(), false);
    await app.startTraining(); await app.prepareKrea2Cache();
  }
  app.taggerApiSettings = {baseUrl:'https://example.test', apiKey:'test', model:'test', promptText:'caption'};
  app.taggerSourceMode = 'api-folder';
  assert.equal(app.taggerApiCanStart(), false);
  app.taggerSourceMode = 'api-single';
  assert.equal(app.taggerApiCanStart(), true);
  app.taggerSourceMode = 'api-folder';
  // Route-local details can still contain the last running task after leaving.
  app.regTask = {status:'running'};
  app.setSnapshot(false); await app._pollTrainingState();
  assert.equal(app.backendStatusLabel, 'common.backendConnected');
  assert.equal(app.taggerCanStart(), true);
  assert.equal(app.taggerApiCanStart(), true);
  app.realtimeState = 'offline';
  assert.equal(app.backendStatusLabel, 'common.backendDisconnected');
});

test('successful launch immediately blocks GPU entries even when the detail request fails', async () => {
  const app = fixture();
  app.regPlan = {token:'plan', pending:1};
  app.regRequest = async url => {
    if (url === '/tasks') return {task_id:'new', run_key:'reg_new'};
    throw new Error('detail unavailable');
  };
  await app.regStart();
  assert.equal(app.regularizationActive, true);
  assert.equal(app.regRunning, true);
  app.applyRegularizationActivity({server:{regularization_active:false}}, app._regActivityBoundaryAt - 1);
  assert.equal(app.regularizationActive, true);
  app.applyRegularizationActivity({server:{regularization_active:false}}, app._regActivityBoundaryAt + 1);
  assert.equal(app.regularizationActive, false);
});

test('SDXL model switch removes incompatible flow sampling and block swap', () => {
  const app = fixture();
  Object.assign(app.regSettings, {model_type:'anima', sampler:'er_sde', scheduler:'flux2', blocks_to_swap:20});
  app.regSetField('model_type', 'sdxl');
  assert.equal(app.regSettings.sampler, 'euler_a');
  assert.equal(app.regSettings.scheduler, 'normal');
  assert.equal(app.regSettings.blocks_to_swap, 0);
  app.regSetField('sampler', 'dpmpp_2m');
  app.regSetField('scheduler', 'karras');
  app.regSetField('sampler', 'euler_a');
  assert.equal(app.regSettings.scheduler, 'normal');
});

test('SDXL training import uses checkpoint and optional VAE, preserving captions', () => {
  const app = fixture();
  app.form = {model_train_type:'sdxl-lora', train_data_dir:'train-xl', pretrained_model_name_or_path:'xl.safetensors', vae:''};
  app.regSettings.extra_positive = 'custom';
  app.regImportTraining();
  assert.equal(app.regSettings.model_type, 'sdxl');
  assert.equal(app.regSettings.checkpoint, 'xl.safetensors');
  assert.equal(app.regSettings.sdxl_vae, '');
  assert.equal(app.regSettings.scheduler, 'normal');
  assert.equal(app.regSettings.extra_positive, 'custom');
  assert.equal(app.regError, '');
});

test('source scrolling appends once, preserves cards on failure and retries the same batch', async () => {
  const app = fixture(); app.regTab = 'plan'; app.regPlan = {token:'plan', source_count:59};
  const sources = Array.from({length:59}, (_,index) => ({relative:index + '.png',caption:'tag'}));
  const urls = [];
  app.regRequest = async url => {
    urls.push(url); const query = new URL('http://local' + url).searchParams;
    const offset = Number(query.get('offset')), limit = Number(query.get('limit'));
    return {items:sources.slice(offset, offset + limit), total:sources.length};
  };
  await app.regLoadSources();
  assert.equal(app.regSources.length, 24);
  const read = app.regRequest;
  let finish;
  app.regRequest = () => new Promise(resolve => { finish = resolve; });
  const next = app.regLoadMore();
  await app.regLoadMore();
  assert.equal(app.regSources.length, 24);
  finish({items:sources.slice(24,48),total:59}); await next;
  assert.equal(app.regSources.length, 48);
  assert.match(app.regSourceImage(24), /preview\/24\?variant=thumb$/);
  app.regRequest = async () => { throw new Error('network error'); };
  await app.regLoadMore();
  assert.equal(app.regSources.length, 48); assert.equal(app.regMoreError, 'network error');
  app.regRequest = read; await app.regLoadMore();
  assert.equal(app.regSources.length, 59); assert.equal(app.regMoreError, ''); assert.equal(app.regHasMore, false);
  const reads = urls.length; await app.regLoadMore(); assert.equal(urls.length, reads);
});

test('source details grow vertically first, widen only at viewport height, and pin without moving', () => {
  const app = fixture(); Object.assign(app.testWindow, {innerWidth:1280, innerHeight:720});
  const cards = app.regGallery(), ticks = [];
  let contentArea = 200000;
  const popup = {style:{}, get offsetWidth() { return parseFloat(this.style.width); },
    get offsetHeight() { return Math.min(696, Math.ceil(contentArea / this.offsetWidth)); }};
  const body = {scrollTop:0, get scrollHeight() { return Math.ceil(contentArea / popup.offsetWidth); },
    get clientHeight() { return Math.min(694, this.scrollHeight); }};
  popup.querySelector = () => body;
  cards.$refs = {sourceDetail:popup}; cards.$nextTick = fn => ticks.push(fn);
  const event = {clientX:1200,clientY:650,currentTarget:{getBoundingClientRect:() => ({right:100,top:100})}};
  const source = {relative:'short.png'};
  cards.showDetail(source, event); ticks.shift()();
  assert.equal(popup.offsetWidth, 420);
  const position = cards.detailStyle;
  cards.showDetail(source, {currentTarget:event.currentTarget}); // focus before click
  cards.showDetail(source, event, true);
  assert.equal(cards.detailStyle, position);
  assert.equal(cards.pinned, true);
  assert.equal(ticks.length, 0);
  cards.closeDetail(); contentArea = 500000;
  cards.showDetail({relative:'long.png'}, event); ticks.shift()();
  assert.ok(popup.offsetWidth > 420 && popup.offsetWidth <= 1256);
  assert.equal(body.scrollHeight, body.clientHeight);
  cards.closeDetail(); contentArea = 2000000;
  cards.showDetail({relative:'overflow.png'}, event); ticks.shift()();
  assert.equal(popup.offsetWidth, 1256);
  assert.ok(body.scrollHeight > body.clientHeight);
  cards.closeDetail();
  cards.showDetail(source, event); cards.closeDetail(); ticks.shift()();
  assert.equal(cards.detail, null);
});

test('prompt fields visibly migrate old blanks once and preserve later clearing', () => {
  const app = fixture();
  app.regMetadata = {defaults: {extra_positive:'', negative:''}};
  app.savedSettings.set('anima-reg-settings', JSON.stringify({extra_positive:'', negative:''}));
  app.regInitSettings();
  assert.equal(app.regSettings.extra_positive, 'masterpiece, best quality, score_7');
  assert.equal(app.regSettings.negative, 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration');
  assert.equal(app.regActualPrompt('1girl'), 'masterpiece, best quality, score_7, 1girl');
  app.regSetField('extra_positive', '');
  app.regSetField('negative', '');
  app.regSettings = {};
  app.regInitSettings();
  assert.equal(app.regSettings.extra_positive, '');
  assert.equal(app.regSettings.negative, '');
  assert.equal(app.regActualPrompt('1girl'), '1girl');
});

test('prompt default migration preserves custom saved prompts', () => {
  const app = fixture(); app.regSettings = {};
  app.regMetadata = {defaults: {extra_positive:'', negative:''}};
  app.savedSettings.set('anima-reg-settings', JSON.stringify({extra_positive:'custom positive', negative:'custom negative'}));
  app.regInitSettings();
  assert.equal(app.regSettings.extra_positive, 'custom positive');
  assert.equal(app.regSettings.negative, 'custom negative');
});

test('prompt preview uses the same comma trimming as generation', () => {
  const app = fixture(); app.regSources = [{caption:'tag',prompt:'tag'}];
  app.regSetField('extra_positive', ' ,quality,, ');
  assert.equal(app.regSources[0].prompt, 'quality, tag');
  assert.equal(app.regMapSources([{relative:'a.png',caption:'tag'}])[0].prompt, 'quality, tag');
  app.regSetField('extra_positive', ' ,,, ');
  assert.equal(app.regSources[0].prompt, 'tag');
});

test('result scrolling preserves loaded cards on failure and refreshes the whole loaded prefix', async () => {
  const app = fixture(); app.regTab = 'inspect'; app.regRunKey = 'run';
  let items = Array.from({length:49}, (_,index)=>({index:index+1,status:'completed'}));
  app.regRefreshRuns = async () => {}; app.regLoadLogs = async () => {}; app.regApplyTask = () => {};
  const read = async url => {
    const query = new URL('http://local' + url).searchParams, offset = Number(query.get('offset'));
    return {items:items.slice(offset,offset + Number(query.get('limit'))),total:items.length,summary:{}};
  };
  app.regRequest = read; await app.regLoadResults();
  assert.equal(app.regItems.length, 24);
  app.regRequest = async () => { throw new Error('offline'); };
  await app.regLoadMore(); assert.equal(app.regItems.length, 24); assert.equal(app.regMoreError, 'offline');
  app.regRequest = read; await app.regLoadMore(); await app.regLoadMore();
  assert.equal(app.regItems.length, 49); assert.equal(app.regHasMore, false);
  items = items.slice(0,48).map(item=>({...item,status:'excluded'}));
  await app.regLoadResults();
  assert.equal(app.regItems.length, 48); assert.equal(app.regItemsTotal, 48);
  assert.ok(app.regItems.every(item=>item.status === 'excluded'));
});

test('shared batch reader refreshes more than the backend limit without dropping loaded cards', async () => {
  const app = fixture(), urls = [];
  app.regRequest = async url => {
    urls.push(url); const query = new URL('http://local' + url).searchParams;
    const offset = Number(query.get('offset')), limit = Number(query.get('limit'));
    return {items:Array.from({length:Math.min(limit,225-offset)}, (_,i)=>({index:offset+i})),total:225};
  };
  const page = await app.regFetchItems('/items?status=all', 225);
  assert.equal(page.items.length, 225);
  assert.equal(page.items[224].index, 224);
  assert.match(urls[0], /offset=0&limit=100$/); assert.match(urls[1], /offset=100&limit=100$/); assert.match(urls[2], /offset=200&limit=25$/);
});

test('scroll loading waits for a valid plan and discards an obsolete source response', async () => {
  const app = fixture(); app.regTab = 'plan'; app.regPlan = {token:'old',source_count:50}; app.regSources = [{relative:'first.png',caption:'tag'}];
  app.regRequest = async () => assert.fail('must not load');
  app.regPreviewDirty = true; await app.regLoadMore();
  app.regPreviewDirty = false; app.regBusy = true; await app.regLoadMore();
  app.regBusy = false; app.regTab = 'settings'; await app.regLoadMore();
  app.regTab = 'plan'; let finish;
  app.regRequest = () => new Promise(resolve=>{finish=resolve;});
  const loading = app.regLoadMore();
  app.regPlan = {token:'new',source_count:1}; app.regSources = [{relative:'new.png',caption:'tag'}];
  finish({items:Array.from({length:24},(_,i)=>({relative:'stale'+i+'.png',caption:'tag'})),total:50}); await loading;
  assert.equal(app.regSources.length, 1); assert.equal(app.regSources[0].relative, 'new.png');
});

test('filter changes discard pending result batches and restart from the beginning', async () => {
  const app = fixture(); app.regTab = 'inspect'; app.regRunKey = 'run'; app.regItemsTotal = 50;
  app.regItems = [{index:1,status:'completed'}]; app.regLoadLogs = async()=>{}; app.regApplyTask = ()=>{};
  let finish;
  app.regRequest = () => new Promise(resolve=>{finish=resolve;});
  const loading = app.regLoadMore();
  app.regFilter = 'failed';
  app.regRequest = async url => { assert.match(url, /status=failed&offset=0&limit=24$/); return {items:[{index:7,status:'failed'}],total:1,summary:{}}; };
  await app.regSelectFilter();
  finish({items:Array.from({length:24},(_,i)=>({index:i+2,status:'completed'})),total:50}); await loading;
  assert.equal(app.regItems.length, 1); assert.equal(app.regItems[0].index, 7); assert.equal(app.regItemsTotal, 1);
});

test('a refresh supersedes an incremental request without duplicating result cards', async () => {
  const app = fixture(); app.regTab = 'inspect'; app.regRunKey = 'run'; app.regItemsTotal = 50;
  app.regItems = Array.from({length:24},(_,i)=>({index:i,status:'pending'}));
  app.regLoadLogs = async()=>{}; app.regApplyTask = ()=>{};
  let finish;
  app.regRequest = () => new Promise(resolve=>{finish=resolve;});
  const loading = app.regLoadMore();
  app.regRequest = async()=>({items:app.regItems.map(item=>({...item,status:'completed'})),total:50,summary:{}});
  await app.regLoadResults();
  finish({items:Array.from({length:24},(_,i)=>({index:i+24,status:'pending'})),total:50}); await loading;
  assert.equal(app.regItems.length, 24); assert.ok(app.regItems.every(item=>item.status === 'completed'));
});

test('incremental loading cannot supersede a pending task status refresh', async () => {
  const app = fixture(); app.regTab = 'inspect'; app.regRunKey = 'run'; app.regItemsTotal = 50;
  app.regItems = Array.from({length:24},(_,i)=>({index:i,status:'pending'}));
  app.regLoadLogs = async()=>{}; app.regApplyTask = ()=>{};
  let finish, requests = 0;
  app.regRequest = () => { requests++; return new Promise(resolve=>{finish=resolve;}); };
  const refresh = app.regLoadResults();
  await app.regLoadMore(); await app.regLoadResults({append:true});
  assert.equal(requests, 1);
  finish({items:app.regItems.map(item=>({...item,status:'completed'})),total:50,summary:{}}); await refresh;
  assert.ok(app.regItems.every(item=>item.status === 'completed'));
});

test('sampling, model and device edits retain dataset preview without requests, including opening plan tab', async () => {
  const app = fixture(); app.currentRoute = 'regularization'; app.regSettings.source_dir = 'dataset';
  app.regPlan = {token:'preview', source_count:59, valid_sources:59, total:59};
  app.regSources = [{relative:'a.png', caption:'1girl', prompt:'1girl'}];
  let scans = 0; app.regScan = async () => { scans++; };
  for (const [key, value] of Object.entries({scheduler:'beta', sampler:'heun', steps:24, cfg:5, flow_shift:2, seed:'42', dit:'model', vae:'vae', text_encoder:'encoder', memory_mode:'manual', precision:'fp16', blocks_to_swap:5, text_encoder_cpu:true, gpu_index:1, negative:'blur', extra_positive:'quality'})) {
    app.regSetField(key, value); app.flushTimers();
    assert.equal(app.regPreviewDirty, false, key);
  }
  await app.regShowPlan();
  assert.equal(scans, 0);
  assert.equal(app.regSources[0].prompt, 'quality, 1girl');
  assert.equal(app.regPlanDirty, true);
  assert.notEqual(app.regSourceSummary(), 'awaitPreview');
});

test('only active sizing, caption processing and quantity fields rescan the dataset', () => {
  for (const key of ['ignore_first','exclude_tags','per_image','expand_repeats','size_mode','resolution','enable_bucket']) {
    const app = fixture(); app.currentRoute = 'regularization'; app.regSettings.source_dir = 'dataset'; app.regPlan = {token:'preview'};
    let scans = 0; app.regScan = () => { scans++; };
    app.regSetField(key, key === 'size_mode' ? 'fixed' : 2); app.flushTimers();
    assert.equal(scans, 1, key);
  }
  const app = fixture(); app.currentRoute = 'regularization'; app.regSettings.source_dir = 'dataset'; app.regPlan = {token:'preview'};
  let scans = 0; app.regScan = () => { scans++; };
  app.regSettings.size_mode = 'auto';
  for (const key of ['width','height','resolution','min_bucket_reso']) app.regSetField(key, 512);
  app.flushTimers(); assert.equal(scans, 0);
  app.regSettings.size_mode = 'fixed'; app.regSetField('width', 832);
  app.flushTimers(); assert.equal(scans, 1);
});

test('runtime edits during a pending dataset refresh requeue the latest settings', async () => {
  const app = fixture(); app.currentRoute = 'regularization'; app.regSettings.source_dir = 'dataset'; app.regPlan = {token:'old'};
  app.regPreviewDirty = true;
  let finish;
  app.regRequest = () => new Promise(resolve => { finish = resolve; });
  const pending = app.regScan({quiet:true});
  app.regSetField('scheduler', 'beta');
  finish({token:'outdated', source_count:1}); await pending;
  assert.equal(app.regPlan.token, 'old');
  let scans = 0; app.regScan = () => { scans++; };
  app.flushTimers(); assert.equal(scans, 1);
});

test('directory autoscan debounces edits, ignores empty paths and stops after leaving', () => {
  const app = fixture(); app.currentRoute = 'regularization';
  const scanned = [];
  app.regScan = () => scanned.push(app.regSettings.source_dir);
  app.regSetField('source_dir', 'first');
  app.regSetField('source_dir', 'second');
  app.flushTimers();
  assert.deepEqual(scanned, ['second']);
  app.regSetField('source_dir', 'third');
  app.regSetField('source_dir', '');
  app.flushTimers();
  assert.equal(scanned.length, 1);
  app.regSetField('source_dir', 'fourth');
  app.stopRegularizationWorkspace();
  app.flushTimers();
  assert.equal(scanned.length, 1);
});

test('automatic scan errors stay quiet but an explicit scan reports them', async () => {
  const app = fixture();
  app.regRequest = async () => { throw new Error('Incomplete path'); };
  await app.regScan({quiet:true});
  assert.equal(app.toasts.length, 0);
  assert.equal(app.regBusy, false);
  await app.regScan();
  assert.equal(app.toasts.at(-1).message, 'Incomplete path');
});

test('image preview skips unfinished images and loads more without replacing previous cards', async () => {
  const app = fixture(); app.regRunKey = 'reg_preview'; app.regItemsTotal = 26;
  const first = {index:1,status:'completed'}, last = {index:24,status:'excluded'}, next = {index:26,status:'completed'};
  app.regItems = [first, {index:2,status:'failed'}, last]; app.regSelected = first;
  assert.equal(app.regCanNavigateImage(-1), false);
  await app.regNavigateImage(1); assert.equal(app.regSelected.index, 24);
  app.regLoadResults = async ({append}) => { assert.equal(append,true); app.regItems = [...app.regItems, {index:25,status:'pending'}, next]; app.regItemsTotal = app.regItems.length; };
  await app.regNavigateImage(1); assert.equal(app.regSelected.index, 26);
  assert.equal(app.regCanNavigateImage(1), false);
  await app.regNavigateImage(-1); assert.equal(app.regSelected.index, 24);
  assert.equal(app.regItems[0], first);
});

test('closing preview during incremental fetch does not reopen it', async () => {
  const app = fixture(); app.regRunKey = 'reg_preview'; app.regItemsTotal = 25;
  app.regItems = [{index:24,status:'completed'}]; app.regSelected = app.regItems[0];
  let finish;
  app.regLoadResults = () => new Promise(resolve => { finish = () => { app.regItems = [...app.regItems,{index:25,status:'completed'}]; resolve(); }; });
  const navigation = app.regNavigateImage(1);
  app.regSelected = null; finish(); await navigation;
  assert.equal(app.regSelected, null);
});

test('refresh clears a manually deleted run and invalidates late image responses', async () => {
  const app = fixture(); app.regRunKey = 'reg_deleted';
  app.regTask = {status:'finished', output_path:'/deleted'};
  app.regItems = [{index:1}]; app.regItemsTotal = 1; app.regSelected = app.regItems[0]; app.regLogs = ['old'];
  app.regPlan = {output_path:'/deleted'}; app.regPlanConsumed = true;
  let complete;
  app.regRequest = async url => url === '/runs' ? [] : new Promise(resolve => { complete = resolve; });
  const pending = app.regLoadResults();
  await app.regRefreshRuns();
  complete({items:[{index:1}],total:1,summary:{output_path:'/deleted'}});
  await pending;
  assert.equal(app.regRunKey, ''); assert.equal(app.regTask, null);
  assert.equal(app.regItems.length, 0); assert.equal(app.regItemsTotal, 0);
  assert.equal(app.regSelected, null); assert.equal(app.regLogs.length, 0);
  assert.equal(app.regPlan, null);
});

test('a run deleted after selection becomes empty but other read errors still surface', async () => {
  const app = fixture(); app.regRunKey = 'reg_deleted'; app.regTask = {status:'finished'};
  app.regRequest = async url => { if (url === '/runs') return []; throw new Error('missing manifest'); };
  await app.regAction(() => app.regLoadResults());
  assert.equal(app.regRunKey, ''); assert.equal(app.toasts.length, 0);
  app.regRunKey = 'reg_present';
  app.regRequest = async url => { if (url === '/runs') return [{run_key:'reg_present'}]; throw new Error('read failed'); };
  await app.regAction(() => app.regLoadResults());
  assert.equal(app.regRunKey, 'reg_present');
  assert.equal(app.toasts.at(-1).message, 'read failed');
});

test('edits before the first dataset preview debounce into one scan without changing the seed', () => {
  const app = fixture(); app.currentRoute = 'regularization'; app.regSettings.source_dir = 'dataset';
  const scans = [];
  app.regScan = () => scans.push({...app.regSettings});
  app.regSetField('cfg', 5);
  app.regSetField('steps', 24);
  app.regSetField('extra_positive', 'quality');
  app.flushTimers();
  assert.equal(scans.length, 1);
  assert.equal(scans[0].cfg, 5);
  assert.equal(scans[0].steps, 24);
  assert.equal(scans[0].extra_positive, 'quality');
  assert.equal(scans[0].seed, '-1');
});

test('background previews keep controls editable and reject late outdated results', async () => {
  const app = fixture(); app.currentRoute = 'regularization'; app.regSettings.source_dir = 'dataset';
  const requests = [];
  app.regRequest = async (url, body) => url === '/plans'
    ? new Promise(resolve => requests.push({resolve, body})) : {items:[]};
  const oldScan = app.regScan({quiet:true});
  assert.equal(app.regBusy, false);
  app.regSetField('cfg', 7);
  assert.equal(requests[0].body.settings.cfg, 4);
  const newScan = app.regScan({quiet:true});
  requests[1].resolve({token:'new', source_count:1}); await newScan;
  requests[0].resolve({token:'old', source_count:1}); await oldScan;
  assert.equal(app.regSettings.cfg, 7);
  assert.equal(app.regPlan.token, 'new');
  assert.equal(app.regPlanDirty, false);
});

test('detailed plan scans once between tabs and updates changed caption rules', async () => {
  const app = fixture(); let scans = 0;
  app.regScan = async () => { scans++; app.regPlan = {token:'plan', source_count:1}; app.regPlanDirty = false; };
  await app.regShowPlan();
  assert.equal(app.regTab, 'plan'); assert.equal(scans, 1);
  app.regTab = 'settings'; await app.regShowPlan();
  assert.equal(scans, 1);
  app.regSetField('exclude_tags', 'blue hair');
  app.regTab = 'settings'; await app.regShowPlan();
  assert.equal(scans, 2); assert.equal(app.regSettings.exclude_tags, 'blue hair');
});

test('plan refresh preserves the draft seed token and loaded range, new rounds do not reuse it', async () => {
  const app = fixture(); const bodies = [];
  app.regPlan = {token:'old'}; app.regSources = Array.from({length:48},(_,i)=>({relative:i+'.png',caption:'tag'}));
  app.regRequest = async (url, body) => { if (url !== '/plans') { assert.match(url, /offset=0&limit=48$/); return {items:app.regSources,total:59}; } bodies.push(body); return {token:'updated', source_count:59}; };
  await app.regScan();
  assert.equal(bodies[0].previous_token, 'old'); assert.equal(app.regSources.length, 48);
  app.regPlanConsumed = true; await app.regScan();
  assert.equal(bodies[1].previous_token, undefined);
});

test('refresh keeps the previous snapshot until both plan and sources succeed', async () => {
  const app = fixture(); app.regPlan = {token:'old', source_count:59};
  app.regSources = [{relative:'old.png'}];
  let finish, signal;
  const requested = new Promise(resolve => { signal = resolve; });
  app.regRequest = async url => url === '/plans' ? {token:'new',source_count:59} : new Promise(resolve => { finish = resolve; signal(); });
  const refresh = app.regScan();
  await requested;
  assert.equal(app.regPlan.token, 'old');
  assert.equal(app.regSources[0].relative, 'old.png');
  assert.equal(app.regPreviewDirty, false);
  finish({items:[{relative:'new.png',caption:'tag'}]}); await refresh;
  assert.equal(app.regPlan.token, 'new');
  assert.equal(app.regSources[0].relative, 'new.png');
  assert.equal(app.regSources.length, 1);
  app.regRequest = async url => { if (url === '/plans') return {token:'failed',source_count:1}; throw new Error('read failed'); };
  await app.regScan();
  assert.equal(app.regPlan.token, 'new');
  assert.equal(app.regSources.length, 1);
  assert.equal(app.regSources[0].relative, 'new.png');
});

test('running detailed plan reads the executed snapshot instead of rescanning sources', async () => {
  const app = fixture(); app.regTask = {status:'running', output_path:'run'}; app.regRunKey = 'reg_test';
  app.regRequest = async path => { assert.equal(path, '/runs/reg_test/plan'); return {token:'saved', output_path:'run', overrides:{'a.png':'edited'}}; };
  let loads = 0; app.regLoadSources = async () => { loads++; };
  await app.regShowPlan(); await app.regShowPlan();
  assert.equal(loads, 1); assert.equal(app.regPlanConsumed, true); assert.equal(app.regEdits['a.png'], 'edited');
});

test('historical result selection cannot masquerade as the current plan', () => {
  const app = fixture(); app.regPlan = {output_path:'current'}; app.regPlanConsumed = true;
  app.regTask = {status:'finished', output_path:'old'};
  assert.equal(app.regTaskMatchesPlan, false);
});

test('UI settings preserve size mode and int64 seed text', () => {
  const app = fixture();
  app.regSetField('size_mode', 'fixed');
  assert.equal(app.regSettings.size_mode, 'fixed');
  app.regSetField('seed', '9223372036854775807');
  assert.equal(app.regSettings.seed, '9223372036854775807');
  app.regTask = {status:'running'};
  app.regSetField('size_mode', 'bucket');
  assert.equal(app.regSettings.size_mode, 'fixed');
});

test('training import reads Anima model and bucket configuration without replacing captions', () => {
  const app = fixture();
  app.regSettings.extra_positive = 'masterpiece';
  app.form = {model_train_type:'anima-lora', train_data_dir:'chara', pretrained_model_name_or_path:'anima', qwen3:'qwen', vae:'vae', resolution:768, enable_bucket:false};
  app.regImportTraining();
  assert.equal(app.regSettings.source_dir, 'chara');
  assert.equal(app.regSettings.text_encoder, 'qwen');
  assert.equal(app.regSettings.resolution, '768');
  assert.equal(app.regSettings.enable_bucket, false);
  assert.equal(app.regSettings.extra_positive, 'masterpiece');
});

test('training application waits for route mount and preserves loss weight', () => {
  const app = fixture();
  app.form = {model_train_type:'anima-lora', prior_loss_weight:0.7};
  app.regTask = {status:'finished', completed:1, output_path:'train/regularization/reg_chara'};
  app.navigate = route => { app.currentRoute = route; };
  app.setField = (key,value) => { app.form[key] = value; };
  let estimates = 0; app.scheduleStepEstimate = () => { estimates++; }; app.updateToml = () => {};
  app.regUseForTraining();
  assert.equal(app.form.reg_data_dir, undefined);
  app.regApplyPendingTrainingPath();
  assert.equal(app.form.reg_data_dir, app.regTask.output_path);
  assert.equal(app.form.enable_reg_data, true);
  assert.equal(app.form.prior_loss_weight, 0.7);
  assert.equal(estimates, 1);
  app.regApplyPendingTrainingPath();
  assert.equal(estimates, 1);
});

test('shared training stepper clamps bounds, avoids floating drift and undoes size mode', () => {
  const app = fixture();
  app._regFields = {cfg:{type:'number',min:0,max:100,step:0.1},width:{type:'number',min:32,max:4096,step:32}};
  app.regSettings.cfg = 0.2; app.regSettings.width = 32;
  const controls = app.regFormControls();
  controls.stepField('cfg', 0.1);
  assert.equal(app.regSettings.cfg, 0.3);
  controls.stepField('width', -32);
  assert.equal(app.regSettings.width, 32);
  app.regSetField('size_mode', 'fixed');
  controls.undoField('size_mode');
  assert.equal(app.regSettings.size_mode, 'bucket');
});

test('generation logs preserve parsed details and stable rows when expanding or advancing the tail', () => {
  const app = fixture();
  app.regPlan = {output_path:'current'}; app.regTask = {status:'finished', output_path:'current'};
  app.regLogs = ['2026-10-04 00:10:11 INFO Completed / 已完成 reg_000001, seed=123', '2026-10-04 00:10:12 ERROR Image generation failed', 'Traceback: details', '[00:10:13] legacy message'];
  let lines = app.regVisibleLogs();
  assert.equal(lines[0].time, '00:10:11'); assert.equal(lines[0].level, 'success');
  assert.equal(lines[1].level, 'error'); assert.equal(lines[2].message, 'Traceback: details');
  assert.equal(lines[2].time, ''); assert.equal(lines[3].time, '00:10:13');
  app.regLogs = Array.from({length:60}, (_,index)=>'INFO message ' + index);
  const before = app.regVisibleLogs();
  assert.equal(before.length, 60);
  app.regLogsOpen = true;
  assert.equal(app.regVisibleLogs().length, 60);
  assert.equal(app.regVisibleLogs()[0].key, before[0].key);
  app.regLogs.shift(); app.regLogs.push('INFO message 60');
  assert.equal(app.regVisibleLogs()[0].key, before[1].key);
  app.regLogs = ['repeated', 'repeated'];
  assert.notEqual(app.regVisibleLogs()[0].key, app.regVisibleLogs()[1].key);
});

test('log polling ignores unchanged payloads and out-of-order responses from the same run', async () => {
  const app = fixture(); app.regRunKey = 'run'; app.regLogs = ['existing'];
  const original = app.regLogs;
  app.regRequest = async () => ['existing'];
  await app.regLoadLogs(); assert.equal(app.regLogs, original);
  const responses = [];
  app.regRequest = () => new Promise(resolve => responses.push(resolve));
  const older = app.regLoadLogs(), newer = app.regLoadLogs();
  responses[1](['existing', 'new']); await newer;
  responses[0](['existing']); await older;
  assert.deepEqual(app.regLogs, ['existing', 'new']);
});

test('an old log response cannot overwrite a newly selected run', async () => {
  const app = fixture();
  app.regRunKey = 'reg_old'; app.regLogs = ['current'];
  let resolve; app.regRequest = () => new Promise(done => {resolve = done;});
  const pending = app.regLoadLogs();
  app.regRunKey = 'reg_new'; resolve(['stale']);
  await pending;
  assert.deepEqual(app.regLogs, ['current']);
});

test('empty task registration events retain the task identity and cancel subscription', () => {
  const app = fixture();
  app.currentRoute = 'regularization'; app._regTopic = 'task:gen1';
  app.regTask = {task_id:'gen1',status:'running',phase:'loading',total:3,completed:0};
  app.realtimeUnsubscribe = () => {throw new Error('must retain the task subscription');};
  app.handleRealtimeRegularizationEvent({topic:'task:gen1',type:'task.status',payload:{task_id:'gen1',status:'CREATED',data:{}}});
  assert.equal(app.regTask.task_id, 'gen1'); assert.equal(app.regRunning, true);
  app.applyRealtimeRegularizationSnapshot({tasks:{tracked:[{task_id:'gen1',data:{}}]}});
  assert.equal(app.regTask.task_id, 'gen1');
  app.handleRealtimeRegularizationEvent({topic:'task:gen1',type:'task.progress',payload:{data:{task_id:'gen1',status:'running',phase:'sampling',total:3,completed:1}}});
  assert.equal(app.regTask.completed, 1); assert.equal(app.regTask.phase, 'sampling');
});

test('task progress updates reviewed counts and discards unfinished sampling on stop', () => {
  const app = fixture();
  app.regPlan = {output_path:'run1',completed:0,pending:3};
  app.regTask = {task_id:'gen1',status:'running',total:3,completed:1,step:4,steps:8};
  app._regTopic = 'task:gen1'; app.regRefreshRuns = async()=>{}; app.regLoadLogs = async()=>{};
  assert.equal(app.regProgress, 50);
  app.regApplyTask({task_id:'gen1',status:'terminated',output_path:'run1',total:3,completed:1,pending:2,step:4,steps:8});
  assert.equal(app.regPlan.completed, 1); assert.equal(app.regPlan.pending, 2);
  assert.ok(Math.abs(app.regProgress-100/3)<0.00001);
});

test('starting consumes the reviewed plan without reporting a settings change', async () => {
  const app = fixture();
  app.regPlan = {token:'reviewed',output_path:'run1',pending:1};
  app.regRefreshRuns = async()=>{};
  let calls = 0;
  app.regRequest = async path => {calls++; return path === '/tasks' ? {task_id:'gen1',run_key:'run1'} : {task_id:'gen1',run_key:'run1',output_path:'run1',status:'created',completed:0,pending:1,total:1};};
  await app.regStart();
  assert.equal(app.regPlanConsumed, true); assert.equal(app.regPlanDirty, false);
  app.regTask.status = 'finished';
  await app.regStart();
  assert.equal(calls, 2);
});

test('changed settings cannot silently resume an old run from the settings page', async () => {
  const app = fixture();
  app.regPlanConsumed = true; app.regPlan = {output_path:'old'};
  app.regTask = {task_id:'old',status:'terminated',pending:1,output_path:'old'};
  app.regSetField('cfg', 8);
  app.regRequest = async()=>{throw new Error('must not submit');};
  await app.regResume();
  assert.equal(app.regError, 'resumeDirty');
  assert.equal(app.regSettings.cfg, 8);
});

test('historical caption overrides survive pagination in read-only plans', async () => {
  const app = fixture(); app.regPlan = {token:'p'}; app.regSettings.extra_positive = 'quality';
  app.regEdits = {'a.png': 'edited'};
  app.regRequest = async()=>({items:[{relative:'a.png',caption:'original',prompt:'quality, original'}]});
  await app.regLoadSources();
  assert.equal(app.regSources[0].caption, 'edited');
  assert.equal(app.regSources[0].prompt, 'quality, edited');
});

test('late task and result responses cannot overwrite another selected run', async () => {
  const app = fixture(); app.currentRoute = 'regularization'; app.regRunKey = 'A';
  app.regTask = {task_id:'A',status:'running'}; app.regLoadLogs = async()=>{};
  let reply; app.regRequest = ()=>new Promise(resolve=>reply=resolve);
  const pending = app.regRefreshTask();
  app.regRunKey = 'B'; app.regTask = {task_id:'B',status:'finished',output_path:'B'};
  reply({task_id:'A',status:'finished',output_path:'A'}); await pending;
  assert.equal(app.regTask.task_id, 'B');
  const results = app.regLoadResults();
  app.regRunKey = 'C'; app.regItems = [{index:3}];
  reply({items:[{index:2}],total:1,summary:{task_id:'B',status:'finished'}}); await results;
  assert.equal(app.regItems[0].index, 3);
});

test('online websocket skips HTTP status polling and terminal tasks stop polling logs', async () => {
  const app = fixture(); app.currentRoute = 'regularization'; app.regRunKey = 'A';
  app.regTask = {task_id:'A',status:'running'}; app.realtimeReady = true; app.realtimeState = 'online';
  app.regRequest = async()=>{throw new Error('redundant status poll');};
  let logs = 0; app.regLoadLogs = async()=>{logs++;};
  await app.regRefreshTask(); assert.equal(logs, 1); assert.equal(app.regError, '');
  app.regTask.status = 'finished'; app._regTimer = 1;
  await app.regRefreshTask(); assert.equal(logs, 1); assert.equal(app._regTimer, null);
});

test('inspection refreshes on image completion, not on every sampling step', () => {
  const app = fixture(); app.regRunKey = 'A'; app.regTab = 'inspect';
  app.regTask = {task_id:'A',status:'running',completed:0,failed:0,updated_at:1};
  let refreshes = 0; app.regLoadResults = async()=>{refreshes++;};
  app.regApplyTask({...app.regTask,step:1,updated_at:2});
  assert.equal(refreshes, 0);
  app.regApplyTask({...app.regTask,completed:1,updated_at:3});
  assert.equal(refreshes, 1);
  app.regApplyTask({...app.regTask,completed:0,updated_at:2});
  assert.equal(app.regTask.completed, 1);
});

test('another round starts once after revalidating unchanged inputs, but changed inputs need review', async () => {
  for (const changed of [false,true]) {
    const app = fixture(); app.regPlan = {fingerprint:'reviewed'}; app.regPlanConsumed = true;
    app.regRequest = async()=>({token:'new',fingerprint:changed?'changed':'reviewed'});
    app.regLoadSources = async()=>{};
    let starts = 0; app.regStart = async()=>{starts++;};
    await app.regAgain();
    assert.equal(starts, changed?0:1);
    assert.equal(app.regPlanConsumed, false);
    if (changed) assert.equal(app.toasts.at(-1).message, 'changed');
  }
});

test('reading run parameters keeps reviewed caption overrides and width-height swap is reversible', async () => {
  const app = fixture(); app.regRunKey = 'old';
  app.regRequest = async()=>({settings:{cfg:7,seed:'9223372036854775807'},overrides:{'a.png':'custom'}});
  await app.regReadRunSettings();
  assert.equal(app.regSettings.cfg, 7); assert.equal(app.regEdits['a.png'], 'custom');
  assert.equal(app.regSettings.seed, '9223372036854775807');
  app.regSwapSize(); assert.equal(app.regSettings.width, 768); assert.equal(app.regSettings.height, 1024);
  app.regSwapSize(); assert.equal(app.regSettings.width, 1024); assert.equal(app.regSettings.height, 768);
});
