const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend} = require('./helpers.cjs');

function element(text='') {
  const classes=new Set(),properties={},listeners={};
  return {
    textContent:text,children:[],parentElement:null,clientWidth:200,scrollWidth:330,
    attributes:{},properties,listeners,classes,
    classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),toggle:(name,value)=>value?classes.add(name):classes.delete(name)},
    style:{setProperty:(name,value)=>{properties[name]=value;}},
    setAttribute(name,value){this.attributes[name]=value;},
    append(...children){for(const child of children){if(child.parentElement){const siblings=child.parentElement.children;siblings.splice(siblings.indexOf(child),1);}this.children.push(child);child.parentElement=this;}},
    replaceWith(other){const parent=this.parentElement;parent.children[parent.children.indexOf(this)]=other;other.parentElement=parent;this.parentElement=null;},
    addEventListener:(name,fn)=>{listeners[name]=fn;},removeEventListener:name=>{delete listeners[name];},
  };
}
test('marquee repeats the original text with a 64px gap, remeasures changes and cleans observers',()=>{
  const observers=[];
  class Observer {constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
  const context=loadFrontend(['shared/loop-marquee'],{
    window:{ResizeObserver:Observer,MutationObserver:Observer},ResizeObserver:Observer,MutationObserver:Observer,
    document:{createElement:()=>element(),addEventListener(){}},getComputedStyle:()=>({columnGap:'64px'}),
  });
  const host=element(),source=element('D:\\very long dataset\\subject');host.append(source);
  const destroy=context.window.initLoopMarquee(host,source);
  assert.equal(host.classes.has('is-overflowing'),true);
  assert.equal(host.properties['--loop-marquee-distance'],'394px');
  const [track]=host.children;const [original,copy]=track.children;
  assert.equal(original,source);assert.equal(copy.textContent,source.textContent);assert.equal(copy.attributes['aria-hidden'],'true');
  host.clientWidth=400;observers[0].callback();assert.equal(host.classes.has('is-overflowing'),false);
  host.clientWidth=200;source.textContent='changed';source.scrollWidth=500;observers[1].callback();
  assert.equal(copy.textContent,'changed');assert.equal(host.properties['--loop-marquee-distance'],'564px');
  destroy();assert.equal(host.children[0],source);assert.deepEqual(host.listeners,{});assert.ok(observers.every(value=>value.disconnected));
});
