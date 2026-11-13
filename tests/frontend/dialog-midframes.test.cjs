const test = require('node:test');
const assert = require('node:assert/strict');
const {uiHarness} = require('./ui-helpers.cjs');

function morph({media = false, reduced = false} = {}) {
  const harness = uiHarness();
  const {context, document, Element, ticks, flush, listeners} = harness;
  const make = tag => {
    const element = new Element(tag);
    element.classList.remove = name => element.classList.toggle(name, false);
    return element;
  };
  const opener = make('button'), dialog = make('dialog'), modal = make('div');
  opener.rect = {left:120, top:30, right:240, bottom:62, width:120, height:32};
  dialog.rect = {left:0, top:0, right:1280, bottom:720, width:1280, height:720};
  modal.rect = {left:100, top:100, right:900, bottom:600, width:800, height:500};
  dialog.className = 'modal-overlay modal-overlay--morph'; modal.className = 'modal';
  dialog.setAttribute('id', 'midframeDialog');
  opener.dataset = {dialogOpens:'midframeDialog'};
  opener.setAttribute('data-dialog-opens', 'midframeDialog');
  const motions = [];
  function animate(frames, options) {
    let resolve;
    const finished = new Promise(done => {resolve = done;});
    const motion = {frames, options, finished, effect:{target:this}, finish:resolve,
      cancel() {this.cancelled = true; resolve();}};
    motions.push(motion);
    return motion;
  }
  document.createElement = tag => Object.assign(make(tag), {animate});
  opener.cloneNode = () => Object.assign(make('button'), {animate});
  dialog.animate = modal.animate = animate;
  dialog.append(modal); document.body.append(opener, dialog);
  const baseStyle = context.getComputedStyle;
  context.getComputedStyle = node => ({...baseStyle(node),
    opacity:node.style.opacity ?? '1', transform:node.style.transform ?? 'none',
    getPropertyValue:name => name === '--duration-dialog-enter' ? '300ms'
      : name === '--duration-dialog-exit' ? '270ms' : 'linear',
  });
  context.window.matchMedia = () => ({matches:reduced});
  let thumbnail, image;
  if (media) {
    thumbnail = make('img'); thumbnail.rect = {...opener.rect};
    thumbnail.setAttribute('data-dialog-anchor', ''); opener.append(thumbnail);
    image = make('img'); image.rect = {...modal.rect}; image.animate = animate;
    image.setAttribute('data-dialog-anchor', 'target'); modal.append(image);
    const chrome = make('header'); chrome.animate = animate;
    chrome.setAttribute('data-dialog-chrome', ''); modal.append(chrome);
  }
  const binding = context.window.AnimaUI.bindDialog(dialog, callback => ticks.push(callback));
  listeners.get('click')({target:opener});
  const settle = async () => {
    motions.splice(0).forEach(motion => motion.finish());
    await new Promise(setImmediate); flush();
  };
  return {...harness, opener, dialog, modal, thumbnail, image, binding, motions, settle};
}

const opacityMotion = (motions, target) => motions.find(motion => motion.effect.target === target && 'opacity' in motion.frames[0]);
const transformMotion = (motions, target) => motions.find(motion => motion.effect.target === target && 'transform' in motion.frames[0]);

test('button label stays stationary while the dialog retains its original pop and fade', async () => {
  const {binding, flush, dialog, modal, opener, motions, settle} = morph();
  binding.setOpen(true); flush();
  let copy = dialog.querySelector('.dialog-morph-button');
  assert.equal(copy.style.left, '120px'); assert.equal(copy.style.top, '30px');
  assert.equal(copy.style.transform, 'none');
  assert.equal(transformMotion(motions, copy), undefined);
  const openingTransform = transformMotion(motions, modal).frames;
  assert.equal(openingTransform[0].transform, 'translate(-320px, -304px) scale(0.15)');
  assert.equal(openingTransform[1].transform, 'translate(0px, 0px) scale(1)');
  const openingLabel = opacityMotion(motions, copy).frames;
  const openingContent = opacityMotion(motions, modal).frames;
  assert.equal(openingLabel[1].opacity, 0);
  assert.equal(openingContent[1].opacity, 0);
  assert.equal(openingLabel[1].offset, .18);
  assert.equal(openingContent[1].offset, .10);
  assert.equal(openingContent[1].easing, 'ease-in-out');
  assert.equal(openingContent[2].opacity, 1);
  assert.equal(openingContent[2].offset, .63);
  assert.ok(motions.some(motion => motion.frames[0].clipPath));
  assert.equal(opacityMotion(motions, modal).options.duration, 300);
  await settle();
  binding.setOpen(false); flush();
  copy = dialog.querySelector('.dialog-morph-button');
  const closingLabel = opacityMotion(motions, copy).frames;
  const closingContent = opacityMotion(motions, modal).frames;
  assert.equal(closingContent[1].opacity, 1);
  assert.equal(closingContent[1].offset, .04);
  assert.equal(closingContent[1].easing, 'ease-in-out');
  assert.equal(closingContent[2].opacity, 0);
  assert.equal(closingContent[2].offset, .36);
  assert.equal(closingLabel[1].opacity, 0);
  assert.equal(closingLabel[1].offset, .72);
  assert.ok(closingContent[2].offset < closingLabel[1].offset);
  assert.equal(opacityMotion(motions, modal).options.duration, 270);
  assert.equal(transformMotion(motions, copy), undefined);
  const closingTransform = transformMotion(motions, modal).frames;
  assert.equal(closingTransform[0].transform, 'translate(0px, 0px) scale(1)');
  assert.equal(closingTransform[1].transform, openingTransform[0].transform);
  await settle();
  assert.equal(dialog.open, false);
  assert.equal(opener.classList.contains('dialog-morph-origin'), false);
});

test('reversing a morph preserves source-label phases and current panel motion', async () => {
  const {binding, flush, dialog, modal, motions, settle} = morph();
  binding.setOpen(true); flush();
  dialog.querySelector('.dialog-morph-button').style.opacity = '0';
  modal.style.opacity = '0';
  modal.style.transform = 'matrix(0.5, 0, 0, 0.5, -160, -152)';
  const entering = motions.splice(0);
  binding.setOpen(false); flush();
  assert.ok(entering.every(motion => motion.cancelled));
  let copy = dialog.querySelector('.dialog-morph-button');
  assert.equal(opacityMotion(motions, copy).frames[1].offset, .72);
  assert.equal(opacityMotion(motions, modal).frames[0].opacity, '0');
  assert.equal(transformMotion(motions, modal).frames[0].transform, modal.style.transform);
  copy.style.opacity = '.45';
  const exiting = motions.splice(0);
  binding.setOpen(true); flush();
  assert.ok(exiting.every(motion => motion.cancelled));
  copy = dialog.querySelector('.dialog-morph-button');
  assert.equal(opacityMotion(motions, copy).frames[0].opacity, '.45');
  assert.equal(opacityMotion(motions, copy).frames[1].opacity, 0);
  assert.equal(opacityMotion(motions, modal).frames.at(-1).opacity, 1);
  assert.equal(transformMotion(motions, modal).frames.at(-1).transform, 'translate(0px, 0px) scale(1)');
  await settle();
  assert.equal(dialog.open, true);
});

test('image morphs keep their image transform and reduced motion does not create button copies', async () => {
  const media = morph({media:true});
  media.binding.setOpen(true); media.flush();
  assert.equal(media.dialog.querySelector('.dialog-morph-button'), null);
  assert.ok(media.motions.some(motion => motion.effect.target === media.image && 'transform' in motion.frames[0]));
  await media.settle();
  media.binding.setOpen(false); media.flush(); await media.settle();
  assert.equal(media.thumbnail.classList.contains('dialog-morph-origin'), false);
  const reduced = morph({reduced:true});
  reduced.binding.setOpen(true); reduced.flush();
  assert.equal(reduced.motions.length, 0);
  assert.equal(reduced.dialog.querySelector('.dialog-morph-button'), null);
  reduced.binding.setOpen(false); reduced.flush();
  assert.equal(reduced.dialog.open, false);
});
