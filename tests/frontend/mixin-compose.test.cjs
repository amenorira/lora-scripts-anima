const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFrontend, readRepo } = require('./helpers.cjs');

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
