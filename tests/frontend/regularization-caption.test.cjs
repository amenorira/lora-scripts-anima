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

for (const eventFirst of [false, true]) {
  test(`cancel preserves terminal status with ${eventFirst ? 'an earlier event' : 'only the HTTP response'}`, async () => {
    const app = restartHarness(), pending = deferred(), unsubscribed = [];
    app._regTopic = 'task:old-task';
    app.realtimeUnsubscribe = topic => unsubscribed.push(topic);
    app.regRequest = path => {
      assert.equal(path, '/tasks/old-task/cancel');
      return pending.promise;
    };
    const stopping = app.regStop();
    const finished = { ...app.regTask, status: 'finished', updated_at: 200 };
    if (eventFirst) {
      app.handleRealtimeRegularizationEvent({ topic: 'task:old-task', type: 'task.status', payload: { data: finished } });
    }
    pending.resolve(eventFirst ? { task_id: 'old-task', status: 'stopping' } : finished);
    await stopping;
    assert.equal(app.regTask.status, 'finished');
    assert.equal(app.regRunning, false);
    assert.equal(app._regTopic, null);
    assert.deepEqual(unsubscribed, ['task:old-task']);
  });
}
