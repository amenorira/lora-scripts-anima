const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend } = require('./helpers.cjs');
const {uiHarness} = require('./ui-helpers.cjs');

function harness() {
  const ui=uiHarness();
  ui.context.URLSearchParams = URLSearchParams;
  loadFrontend(['shared/constants','app/config','app/index'],ui.context);
  ui.context.ROUTE_CONFIG=ui.context.window.ROUTE_CONFIG;
  ui.listeners.get('alpine:init')();
  const app=ui.factories.animaApp();
  const main=new ui.Element('main');main.setAttribute('id','mainContent');main.setAttribute('tabindex','-1');
  ui.document.body.append(main);
  return {...ui,app,main};
}

test('preview confirmation defaults on and remembers an explicit off choice in UI settings', () => {
  const {app,context}=harness(), stored=new Map();
  context.localStorage={getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value)};
  app.resolveTheme=()=>{}; app.toast=()=>{}; app.t=key=>key;
  app.loadUISettings();
  assert.equal(app.confirmPreviewBeforeTraining,true);
  app.confirmPreviewBeforeTraining=false;
  app.saveUISettings();
  assert.equal(JSON.parse(stored.get('anima-ui-settings')).confirmPreviewBeforeTraining,false);
  app.confirmPreviewBeforeTraining=true;
  app.loadUISettings();
  assert.equal(app.confirmPreviewBeforeTraining,false);
});

test('history detail navigation preserves run identity and can return to live on the same route', () => {
  const {app,context}=harness(), mounted=[];
  context.window.location={hash:'#history'};
  context.window.history={state:{},pushState(state,_title,url){this.state=state;context.window.location.hash=url;}};
  app.currentRoute='history';
  app._scheduleRoute=route=>{mounted.push(route);app.currentRoute=route;};
  app.navigate('monitor-dashboard',{run:'output/a b'});
  assert.equal(context.window.location.hash,'#monitor-dashboard?run=output%2Fa+b');
  app.selectedRunDir='output/a b';
  app.navigate('monitor-dashboard');
  assert.equal(context.window.location.hash,'#monitor-dashboard');
  assert.equal(mounted.length,2);
  context.window.location.hash='#monitor-dashboard?run=output%2Fc&tab=logs';
  app.handleRoute();
  assert.equal(mounted.length,3);
  let restored;
  Object.assign(app,{viewRunDetail:(...args)=>{restored=args;},startMonitorRealtime(){},startProgress(){}});
  app.buildRouteContent();
  assert.deepEqual(restored,['output/c',true,'logs']);
});

test('route changes close a parameter guide before mounting the destination', () => {
  const {app}=harness(), events=[];
  Object.assign(app, {
    currentRoute:'train-basic', parameterDocOpen:true,
    closeParameterDoc(){ events.push('close'); this.parameterDocOpen=false; },
    _playRouteEnter(){}, suspendTrainForm(){}, t:key=>key, $nextTick(){},
    buildRouteContent(){ events.push('mount:'+this.currentRoute); },
  });
  app._commitRoute('home','train-basic',1);
  assert.deepEqual(events,['close','mount:home']);
  assert.equal(app.parameterDocOpen,false);
});
