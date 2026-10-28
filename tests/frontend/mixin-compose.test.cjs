const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {loadFrontend, readFrontend, readRepo} = require('./helpers.cjs');

test('composition preserves getters and rejects duplicates without partial mutation', () => {
  const {window} = loadFrontend('shared/mixin-compose');
  const target = {value:2};
  window.composeAppMixins(target,{derived:{get doubled(){return this.value*2;}}});
  assert.equal(target.doubled,4);
  target.value=3;
  assert.equal(target.doubled,6);
  assert.throws(()=>window.composeAppMixins(target,{extra:{added:true},duplicate:{value:4}}),/value: base \/ duplicate/);
  assert.equal(target.added,undefined);
  assert.throws(()=>window.composeAppMixins({}, {first:{same:1},second:{same:2}}),/same: first \/ second/);
});

test('the production script order assembles the complete application without collisions', () => {
  const listeners = new Map();
  let factory;
  const context = {window:{addEventListener(){},dispatchEvent(){}},
    navigator:{language:'en-US',languages:['en-US']},
    document:{addEventListener(name,callback){const list=listeners.get(name)||[];list.push(callback);listeners.set(name,list);},getElementById:()=>null},
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    Alpine:{data(name,create){if(name==='animaApp')factory=create;}},
    fetch:async()=>({json:async()=>({status:'error'})}),setTimeout,clearTimeout,setInterval,clearInterval,
  };
  const files = [...readRepo('frontend/index.html').matchAll(/<script src="\/anima-ui\/js\/([^\"]+)"/g)]
    .map(match=>match[1]).filter(file=>!file.startsWith('vendor/'));
  vm.createContext(context);
  for (const file of files) vm.runInContext(readFrontend(file),context,{filename:file});
  listeners.get('alpine:init').at(-1)();
  const app = factory();
  assert.equal(typeof app.startTraining,'function');
  assert.equal(typeof app.tagEditorSaveAll,'function');
  assert.equal(typeof Object.getOwnPropertyDescriptor(app,'currentOutputRunDir').get,'function');
});
