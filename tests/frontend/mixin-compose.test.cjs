const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFrontend, readRepo } = require('./helpers.cjs');

test('the production script order assembles the complete application without collisions', async () => {
  const listeners = new Map();
  const scripts = [];
  let factory;
  const context = {window:{addEventListener(){},dispatchEvent(){}},
    navigator:{language:'en-US',languages:['en-US']},
    document:{addEventListener(name,callback){const list=listeners.get(name)||[];list.push(callback);listeners.set(name,list);},getElementById:()=>null,
      createElement:()=>({}),head:{appendChild:script=>scripts.push(script)}},
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    Alpine:{data(name,create){if(name==='animaApp')factory=create;}},
    fetch:async()=>({ok:true,json:async()=>({status:'error'})}),setTimeout,clearTimeout,setInterval,clearInterval,
  };
  const files = [...readRepo('frontend/index.html').matchAll(/<script src="\/anima-ui\/js\/([^\"]+)"/g)]
    .map(match=>match[1]).filter(file=>!file.startsWith('vendor/'));
  vm.createContext(context);
  for (const file of files) vm.runInContext(readFrontend(file),context,{filename:file});
  await context.window.I18N.ready;
  await Promise.resolve();
  assert.equal(scripts[0].src, '/anima-ui/js/vendor/alpine.min.js');
  listeners.get('alpine:init').at(-1)();
  const app = factory();
  assert.equal(typeof app.startTraining,'function');
  assert.equal(typeof app.tagEditorSaveAll,'function');
  assert.equal(typeof Object.getOwnPropertyDescriptor(app,'currentOutputRunDir').get,'function');
});
