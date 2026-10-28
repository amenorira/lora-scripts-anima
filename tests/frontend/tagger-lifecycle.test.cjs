const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, response, deferred} = require('./helpers.cjs');

function harness() {
  const pending = deferred(), scans = [], messages = [];
  const context = loadFrontend('tagger', {window:{}, fetch:()=>pending.promise});
  const app = composeMixins(context.window.taggerMixin, {
    currentRoute:'tagger', taggerSourceMode:'folder', taggerSourcePath:'original',
    scanTaggerSource:async()=>scans.push(app.taggerSourcePath),
    toast:message=>messages.push(message), t:key=>key,
  });
  return {app,pending,scans,messages};
}

for (const change of ['unchanged','route','mode','return','path','scan','starting']) {
  test(`file picker keeps its original workspace context after ${change}`, async()=>{
    const {app,pending,scans}=harness();
    const pick=app.pickTaggerSource();
    if(change==='route') app.currentRoute='ai-captioning';
    if(change==='mode') app.taggerSourceMode='single';
    if(change==='return') app._taggerFormVersion++;
    if(change==='path') app.taggerSourcePath='newer path';
    if(change==='scan') app._taggerSourceScanVersion=1;
    if(change==='starting') app.taggerStarting=true;
    const path=app.taggerSourcePath;
    pending.resolve(response({path:'picked folder'}));
    await pick;
    assert.equal(app.taggerSourcePath,change==='unchanged'?'picked folder':path);
    assert.deepEqual(scans,change==='unchanged'?['picked folder']:[]);
  });
}

test('picker failure after leaving the workspace does not notify another page', async()=>{
  const {app,pending,messages}=harness();
  const pick=app.pickTaggerSource();app.currentRoute='monitor-dashboard';
  pending.reject(new Error('picker closed'));await pick;
  assert.deepEqual(messages,[]);
});
