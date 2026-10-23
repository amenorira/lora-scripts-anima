const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend,readRepo} = require('./helpers.cjs');
const {uiHarness} = require('./ui-helpers.cjs');

function harness() {
  const ui=uiHarness();
  loadFrontend(['constants','config','app'],ui.context);
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
