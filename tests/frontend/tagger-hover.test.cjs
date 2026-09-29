const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('tagger tooltip follows its anchor using actual height and closes when collapsed', () => {
  const frames = new Map();
  let id = 0;
  const context = {
    window: { innerHeight: 900 },
    document: { activeElement: null, getElementById: () => ({ offsetHeight: 150 }) },
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: key => frames.delete(key),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tag-dictionary.js'), 'utf8'), context);
  const app = { ...context.window.tagDictionaryMixin };
  let top = 600;
  let collapsed = false;
  const browser = { getBoundingClientRect: () => ({ top: 100, bottom: 900 }) };
  const anchor = {
    isConnected: true,
    getBoundingClientRect: () => ({ top, bottom: top + 30, left: 600, right: 700 }),
    closest: selector => selector.includes('.tagger-category-browser') ? browser
      : selector === '.tagger-category-section.collapsed' && collapsed ? {} : null,
  };
  context._td().hoverAnchor = anchor;
  app.tagDictionaryHover = { style: app._tdHoverStyle(anchor) };
  assert.match(app.tagDictionaryHover.style, /top:540px/);
  app._tdTrackHover();
  function frame() {
    const [key, callback] = frames.entries().next().value;
    frames.delete(key);
    callback();
  }
  top = 650;
  frame();
  assert.match(app.tagDictionaryHover.style, /top:590px/);
  assert.equal(frames.size, 0, 'stationary tooltips must not poll');
  top = 850;
  app._tdTrackHover();
  app._tdTrackHover();
  assert.equal(frames.size, 1, 'position requests coalesce within one frame');
  frame();
  assert.match(app.tagDictionaryHover.style, /top:742px/);
  top = 20;
  assert.match(app._tdHoverStyle(anchor), /top:8px/);
  collapsed = true;
  app._tdTrackHover();
  frame();
  assert.equal(app.tagDictionaryHover, null);
  assert.equal(frames.size, 0);
  collapsed = false;
  top = 50;
  context._td().hoverAnchor = anchor;
  app.tagDictionaryHover = { style: '' };
  app._tdTrackHover();
  frame();
  assert.equal(app.tagDictionaryHover, null, 'anchors outside the scroll container close their tooltip');
});

test('detail requests coalesce, cache complete results, and ignore stale generations', async () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tag-dictionary.js'), 'utf8'), context);
  const app = { ...context.window.tagDictionaryMixin, tagDictionaryReady: true };
  const state = context._td();
  state.detailReady = true;
  state.lookups.set('solo', { canonical: 'solo' });
  let resolve;
  let requests = 0;
  context._tdSend = () => { requests++; return new Promise(done => { resolve = done; }); };
  const first = app.tagDictionaryDetail('solo');
  assert.equal(app.tagDictionaryDetail('solo'), first);
  resolve({ canonical: 'solo', description: 'One subject' });
  await first;
  assert.equal((await app.tagDictionaryDetail('solo')).description, 'One subject');
  assert.equal(requests, 1);
  assert.equal(state.detailInflight.size, 0);
  const stale = app.tagDictionaryDetail('sky');
  state.generation++;
  resolve({ canonical: 'sky', description: 'Stale' });
  assert.equal(await stale, null);
  assert.equal(state.details.has('sky'), false);
});
