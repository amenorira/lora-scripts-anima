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
  let rounds = 0; app.regAgain = async () => { rounds++; };
  await app.regGenerate();
  assert.equal(rounds, 1);
  app.regPlan = {total:0, pending:0};
  await app.regGenerate();
  assert.equal(rounds, 1);
  assert.equal(app.toasts.at(-1).message, 'noUsableSources');
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
  app.flushTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  app.regSettings = {seed:'-1', cfg:4, width:1024, height:768, size_mode:'bucket', extra_positive:''}; app.regDefaults = {...app.regSettings};
  app._regUndo = {}; app.regEdits = {}; app.regT = key => key;
  app._regFields = {}; app.stepField = context.window.trainingCoreMixin.stepField;
  app.taggerVisibleLogs = context.window.taggerMixin.taggerVisibleLogs;
  app._parseLogRecord = context.window.monitorLogRenderMixin._parseLogRecord;
  app.realtimeSubscribe = app.realtimeUnsubscribe = () => {};
  app.toasts = []; app.toast = (message, type) => app.toasts.push({message, type});
  return app;
}

test('source page jumps clamp boundaries and keep the displayed page on failure', async () => {
  const app = fixture(); app.regPlan = {token:'plan', source_count:59}; app.regSources = [{relative:'old'}];
  let finish;
  app.regRequest = () => new Promise(resolve => { finish = resolve; });
  const next = app.regSourcePage(1);
  assert.equal(app.regSourceOffset, 0);
  await app.regSourcePage(1);
  assert.equal(app.regSourceOffset, 0);
  finish({items:[{relative:'new',caption:'tag'}]}); await next;
  assert.equal(app.regSourceOffset, 12);
  assert.equal(app.regSourcePageCount, 5);
  app.regRequest = async () => { throw new Error('network error'); };
  await app.regSourcePage(1);
  assert.equal(app.regSourceOffset, 12);
  assert.equal(app.regSources[0].relative, 'new');
  app.regRequest = async () => ({items:[]});
  await app.regSourceGoPage(999); assert.equal(app.regSourceOffset, 48);
  await app.regSourcePage(1); assert.equal(app.regSourceOffset, 48);
  await app.regSourceGoPage(''); assert.equal(app.regSourceOffset, 48);
  await app.regSourceGoPage(-2); assert.equal(app.regSourceOffset, 0);
});

test('prompt preview uses the same comma trimming as generation', () => {
  const app = fixture(); app.regSources = [{caption:'tag',prompt:'tag'}];
  app.regSetField('extra_positive', ' ,quality,, ');
  assert.equal(app.regSources[0].prompt, 'quality, tag');
  assert.equal(app.regMapSources([{relative:'a.png',caption:'tag'}])[0].prompt, 'quality, tag');
  app.regSetField('extra_positive', ' ,,, ');
  assert.equal(app.regSources[0].prompt, 'tag');
});

test('inspection pagination retains the old page on failure and clamps after filtering removes the last item', async () => {
  const app = fixture(); app.regRunKey = 'run'; app.regItemsTotal = 49; app.regItems = [{index:1}];
  app.regRefreshRuns = async () => {}; app.regLoadLogs = async () => {}; app.regApplyTask = () => {};
  app.regRequest = async () => { throw new Error('offline'); };
  await app.regPage(1);
  assert.equal(app.regOffset, 0); assert.equal(app.regItems[0].index, 1);
  app.regOffset = 48;
  const urls = [];
  app.regRequest = async url => { urls.push(url); return {items:url.includes('offset=24') ? [{index:25}] : [],total:48,summary:{}}; };
  await app.regLoadResults();
  assert.equal(app.regOffset, 24); assert.equal(app.regItems[0].index, 25);
  assert.equal(urls.length, 2);
});

test('responsive source page size keeps the previous first image within the new page', async () => {
  const app = fixture(); app.regPlan = {token:'plan',source_count:59}; app.regSourceOffset = 24;
  const urls = []; app.regRequest = async url => { urls.push(url); return {items:[]}; };
  await app.regResizeSourcePage(10);
  assert.equal(app.regSourcePageSize, 10); assert.equal(app.regSourceOffset, 20);
  assert.equal(app.regSourcePageCount, 6); assert.match(urls[0], /offset=20&limit=10$/);
  await app.regSourcePage(1); assert.equal(app.regSourceOffset, 30);
  app.regRequest = async () => { throw new Error('offline'); };
  await app.regResizeSourcePage(6);
  assert.equal(app.regSourcePageSize, 10); assert.equal(app.regSourceOffset, 30);
});

test('source arrow shortcuts ignore editors, pinned details, other tabs and held keys', () => {
  const app = fixture(); const cards = app.regSourceCards();
  Object.assign(cards, {currentRoute:'regularization',regTab:'plan'});
  const pages = []; cards.regSourcePage = delta => { pages.push(delta); };
  let prevented = 0;
  const event = {key:'ArrowRight',target:{closest:()=>null},preventDefault(){prevented++;}};
  cards.onPageKey(event); cards.onPageKey({...event,key:'ArrowLeft'});
  cards.onPageKey({...event,target:{closest:()=>({})}});
  cards.onPageKey({...event,repeat:true});
  cards.pinned = true; cards.onPageKey(event);
  cards.pinned = false; cards.regTab = 'settings'; cards.onPageKey(event);
  assert.deepEqual(pages, [1,-1]); assert.equal(prevented, 2);
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

test('image preview skips unfinished images and navigates across pages', async () => {
  const app = fixture(); app.regRunKey = 'reg_preview'; app.regItemsTotal = 26;
  const first = {index:1,status:'completed'}, last = {index:24,status:'excluded'}, next = {index:26,status:'completed'};
  app.regItems = [first, {index:2,status:'failed'}, last]; app.regSelected = first;
  assert.equal(app.regCanNavigateImage(-1), false);
  await app.regNavigateImage(1); assert.equal(app.regSelected.index, 24);
  app.regLoadResults = async offset => { app.regOffset = offset; app.regItems = offset ? [{index:25,status:'pending'}, next] : [first, last]; };
  await app.regNavigateImage(1); assert.equal(app.regSelected.index, 26);
  assert.equal(app.regCanNavigateImage(1), false);
  await app.regNavigateImage(-1); assert.equal(app.regSelected.index, 24);
  assert.equal(app.regOffset, 0);
});

test('closing preview during page fetch does not reopen it', async () => {
  const app = fixture(); app.regRunKey = 'reg_preview'; app.regItemsTotal = 25;
  app.regItems = [{index:24,status:'completed'}]; app.regSelected = app.regItems[0];
  let finish;
  app.regLoadResults = offset => new Promise(resolve => { finish = () => { app.regOffset = offset; app.regItems = [{index:25,status:'completed'}]; resolve(); }; });
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

test('plan refresh preserves the draft seed token and page, new rounds do not reuse it', async () => {
  const app = fixture(); const bodies = [];
  app.regPlan = {token:'old'}; app.regSourceOffset = 12;
  app.regRequest = async (url, body) => { if (url !== '/plans') return {items:[]}; bodies.push(body); return {token:'updated', source_count:25}; };
  await app.regScan();
  assert.equal(bodies[0].previous_token, 'old'); assert.equal(app.regSourceOffset, 12);
  app.regPlanConsumed = true; await app.regScan();
  assert.equal(bodies[1].previous_token, undefined);
});

test('refresh keeps the previous snapshot until both plan and sources succeed', async () => {
  const app = fixture(); app.regPlan = {token:'old', source_count:59}; app.regSourceOffset = 12;
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
  assert.equal(app.regSourceOffset, 12);
  app.regRequest = async url => { if (url === '/plans') return {token:'failed',source_count:1}; throw new Error('read failed'); };
  await app.regScan();
  assert.equal(app.regPlan.token, 'new');
  assert.equal(app.regSourceOffset, 12);
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

test('generation logs reuse timestamp parsing and preserve error details and tail limits', () => {
  const app = fixture();
  app.regPlan = {output_path:'current'}; app.regTask = {status:'finished', output_path:'current'};
  app.regLogs = ['2026-10-04 00:10:11 INFO Completed / 已完成 reg_000001, seed=123', '2026-10-04 00:10:12 ERROR Image generation failed', 'Traceback: details', '[00:10:13] legacy message'];
  let lines = app.regVisibleLogs();
  assert.equal(lines[0].time, '00:10:11'); assert.equal(lines[0].level, 'success');
  assert.equal(lines[1].level, 'error'); assert.equal(lines[2].message, 'Traceback: details');
  assert.equal(lines[2].time, ''); assert.equal(lines[3].time, '00:10:13');
  app.regLogs = Array.from({length:60}, (_,index)=>'INFO message ' + index);
  assert.equal(app.regVisibleLogs().length, 32);
  app.regLogsOpen = true;
  assert.equal(app.regVisibleLogs().length, 60);
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
