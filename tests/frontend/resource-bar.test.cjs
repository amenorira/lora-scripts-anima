const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend,composeMixins} = require('./helpers.cjs');

test('resource bars select and display the requested device through an explicit callback', () => {
  const nodes = new Map();
  const selector = {};
  const bar = {dataset:{},firstElementChild:null,
    set innerHTML(html){this.html=html;this.firstElementChild={};},
    querySelector(query){
      if(query==='[data-resource-gpu]')return selector;
      if(query==='[data-res="gpu"]')return {};
      if(query==='[data-res="sys"]')return null;
      if(!nodes.has(query))nodes.set(query,{style:{}});
      return nodes.get(query);
    },
  };
  const {window} = loadFrontend('monitor/resource-bar',{window:{},document:{getElementById:()=>bar}});
  const selected=[];
  window.resourceBar.render('bar',{gpu:{gpus:[
    {index:0,name:'GPU 0',vram_used_mb:1024,vram_total_mb:4096},
    {index:1,name:'GPU 1',vram_used_mb:2048,vram_total_mb:8192},
  ]},sys:null,t:key=>key,locale:'en-US',selectedGpuIndex:1,onSelect:index=>selected.push(index)});
  assert.match(bar.html,/value="1" selected/);
  assert.doesNotMatch(bar.html,/@change|renderDashboard/);
  assert.equal(nodes.get('[data-field="vram-text"]').textContent,'2.0/8.0G');
  selector.onchange({target:{value:'0'}});
  assert.deepEqual(selected,[0]);
});

test('each workspace refreshes its own resource bar immediately after selecting a GPU', () => {
  const calls=[];
  const {window} = loadFrontend(['monitor/render','tagger/index','regularization/index'],{window:{},
    document:{getElementById:()=>null},
  });
  window.resourceBar={render:(id,options)=>calls.push({id,options})};
  for(const [source,method,id] of [
    [window.monitorRenderMixin,'renderMonitorResourceBar','monitorResbar'],
    [window.taggerMixin,'renderTaggerResourceBar','taggerResbar'],
    [window.regularizationMixin,'renderRegularizationResourceBar','regularizationResbar'],
  ]) {
    const app=composeMixins(source,{selectedGpuIndex:0,t:key=>key,tMonitor:key=>key});
    app.renderDashboard=()=>assert.fail('resource selection must not rebuild the dashboard');
    app[method]();
    const call=calls.at(-1);
    assert.equal(call.id,id);
    call.options.onSelect(1);
    assert.equal(app.selectedGpuIndex,1);
    assert.equal(calls.at(-1).id,id);
    assert.equal(calls.at(-1).options.selectedGpuIndex,1);
  }
});
