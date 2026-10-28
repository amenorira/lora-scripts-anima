const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend,readRepo} = require('./helpers.cjs');
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

test('skip link focuses main without navigating, changing history or prompting to discard edits',()=>{
  const {app,main,document,context}=harness();
  context.window.location={hash:'#tagEditor'};
  context.window.history={pushState(){assert.fail('skip must not push history');},replaceState(){assert.fail('skip must not replace history');}};
  app._scheduleRoute=()=>assert.fail('skip must not change route');
  app._teHasUnsavedEdits=()=>assert.fail('skip is not leaving the editor');
  for (const route of ['train-basic','tagEditor','docs']) {
    app.currentRoute=route;context.window.location.hash='#'+route;main.scrollTop=600;
    app.focusMainContent();
    assert.equal(document.activeElement,main);assert.equal(main.scrollTop,0);
    assert.equal(app.currentRoute,route);assert.equal(context.window.location.hash,'#'+route);
  }
  const link=readRepo('frontend/index.html').match(/<a[^>]+class="skip-link"[^>]*>/)[0];
  assert.match(link,/@click\.prevent="focusMainContent\(\)"/);
  assert.match(link,/@keydown\.enter\.stop/); // The editor's window shortcut must not consume native link activation.
});

test('normal routes and back history retain their existing behavior after using the skip link',()=>{
  const {app,context}=harness(),history=[];
  context.window.location={hash:'#train-basic'};
  context.window.history={state:{animaRoute:'train-basic',animaIndex:1},pushState(state,_title,url){
    history.push(state);this.state=state;context.window.location.hash=url;
  }};
  app.currentRoute='train-basic';app._historyIndex=1;app._scheduleRoute=route=>{app.currentRoute=route;};
  app.focusMainContent();app.navigate('docs');
  assert.equal(app.currentRoute,'docs');assert.equal(history.length,1);
  context.window.location.hash='#train-basic';context.window.history.state={animaRoute:'train-basic',animaIndex:1};
  app.handleRoute();assert.equal(app.currentRoute,'train-basic');assert.equal(app._historyIndex,1);
  app.currentRoute='tagEditor';app._teHasUnsavedEdits=()=>true;
  let confirm;app.t=k=>k;app._teConfirmUnsaved=(_message,action)=>{confirm=action;};
  app.navigate('docs');assert.equal(app.currentRoute,'tagEditor');assert.equal(typeof confirm,'function');
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

test('history detail tab changes in the URL update the panel without reloading the run', () => {
  const {app, context} = harness();
  context.window.location = {hash: '#monitor-dashboard?run=output%2Fa&tab=outputs'};
  context.window.history = {state: {}};
  Object.assign(app, {currentRoute: 'monitor-dashboard', selectedRunDir: 'output/a', monitorTab: 'logs',
    setMonitorTab(tab) { this.monitorTab = tab; },
    _scheduleRoute() { assert.fail('same run must keep its loaded data'); },
  });
  app.handleRoute();
  assert.equal(app.monitorTab, 'outputs');
});
