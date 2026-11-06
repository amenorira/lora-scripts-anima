const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, deferred} = require('./helpers.cjs');

test('generation stops when named captions have no selected candidate', async () => {
  const {window} = loadFrontend('regularization/index', {window:{}});
  const messages = [], calls = [];
  const app = composeMixins(window.regularizationMixin, {
    regBusy:false, trainingActive:false, regTask:null,
    regPlan:{total:1, pending:1, candidate_selection_required:1},
    regScan:async()=>{}, regReportError:message=>messages.push(message),
    regT:key=>key, regStart:async()=>calls.push('start'), regAgain:async()=>calls.push('again'),
  });
  await app.regGenerate();
  assert.deepEqual(messages, ['candidateSelectionRequired']);
  assert.deepEqual(calls, []);
});

test('regularization source reasons use the selected language and preserve unknown details', () => {
  const {window} = loadFrontend(['shared/utils', 'regularization/index'], {window:{}});
  const app = composeMixins(window.utilsMixin, window.regularizationMixin, {
    t:key=>({'errors.regularization_missing_caption':'同名の .txt がありません'}[key] || key),
  });
  assert.equal(app.regReasonText({reason_code:'regularization_missing_caption', reason:'Missing caption txt / 缺少标签 txt'}), '同名の .txt がありません');
  assert.equal(app.regReasonText({reason_code:'unknown', reason:'disk error: details'}), 'disk error: details');
});

function restartHarness() {
  const {window} = loadFrontend(['shared/realtime', 'regularization/index'], {window:{},clearTimeout,clearInterval});
  return composeMixins(window.realtimeMixin, window.regularizationMixin, {
    currentRoute:'regularization', realtimeReady:true, realtimeState:'online',
    regTask:{task_id:'old-task',run_key:'reg_old',status:'running',updated_at:100}, regRunKey:'reg_old',
    realtimeUnsubscribe(){}, toast(){}, t:key=>key, regSyncTimer(){},
    regRefreshRuns:async()=>{}, regLoadLogs:async()=>{}, regReportError:message=>assert.fail(message),
  });
}

test('server restart reconciles a regularization run over HTTP despite a healthy websocket', async () => {
  const app = restartHarness(), pending = deferred(), calls = [];
  app.regRequest = path => { calls.push(path); return pending.promise; };
  app._handleRealtimeServerRestart();
  assert.equal(app.regTask.task_id, 'old-task');
  assert.equal(app.regRunning, true);
  assert.deepEqual(calls, ['/tasks/old-task']);
  pending.resolve({task_id:'old-task',run_key:'reg_old',status:'terminated',updated_at:200});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.regRunning, false);
  assert.equal(app._regTaskNeedsSync, false);
});

for (const change of ['restart', 'route', 'task']) {
  test(`regularization reconciliation ignores an old response after ${change}`, async () => {
    const app = restartHarness(), first = deferred(), second = deferred();
    let calls = 0;
    app.regRequest = () => ++calls === 1 ? first.promise : second.promise;
    app.realtimeReady = false;
    const old = app.regRefreshTask();
    if (change === 'restart') {
      app.realtimeReady = true;
      app.resetRealtimeRegularizationState();
      assert.equal(calls, 2);
    } else if (change === 'route') {
      app.currentRoute='home'; app.stopRegularizationWorkspace();
    } else {
      app.regRunKey='reg_new'; app.regTask={task_id:'new-task',status:'running',updated_at:300};
    }
    first.resolve({task_id:'old-task',run_key:'reg_old',status:'terminated',updated_at:200});
    await old;
    assert.equal(app.regRunning,true);
    if (change === 'restart') {
      assert.equal(app._regRefreshing,true);
      second.resolve({task_id:'old-task',run_key:'reg_old',status:'terminated',updated_at:201});
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal(app.regRunning,false);
      assert.equal(app._regRefreshing,false);
    }
  });
}

test('failed restart reconciliation retains the run and retries HTTP on the next refresh', async () => {
  const app=restartHarness(), errors=[];
  app.regReportError=message=>errors.push(message);
  app.regRequest=async()=>{throw new Error('temporary disconnect');};
  app.resetRealtimeRegularizationState();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.regRunning,true);
  assert.equal(app._regTaskNeedsSync,true);
  assert.equal(app._regRefreshing,false);
  assert.deepEqual(errors,['temporary disconnect']);
  app.regRequest=async()=>({task_id:'old-task',run_key:'reg_old',status:'finished',updated_at:200});
  await app.regRefreshTask();
  assert.equal(app.regRunning,false);
});
