const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tagger.js'), 'utf8'), context);
const mixin = context.window.taggerMixin;

function fixture(overrides = {}) {
  const uploads = [];
  const app = { ...mixin, currentRoute: 'tagger', taggerSourceMode: 'single',
    uploadTaggerFile: async file => uploads.push(file), ...overrides };
  const event = { clipboardData: { files: [{ type: 'image/png', name: 'screenshot.png' }] },
    target: {}, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; } };
  return { app, event, uploads };
}

test('both single modes upload a pasted image and consume the event', async () => {
  for (const taggerSourceMode of ['single', 'api-single']) {
    const { app, event, uploads } = fixture({ taggerSourceMode });
    await app.handleTaggerPaste(event);
    assert.deepEqual(uploads, event.clipboardData.files);
    assert.equal(event.defaultPrevented, true);
  }
});

test('editable targets and text-only clipboards keep native paste', async () => {
  for (const target of [{ isContentEditable: true }, { closest: () => ({}) }, {}]) {
    const { app, event, uploads } = fixture();
    event.target = target;
    if (!Object.keys(target).length) event.clipboardData = { files: [], items: [{ kind: 'string', type: 'text/plain' }] };
    await app.handleTaggerPaste(event);
    assert.equal(uploads.length, 0);
    assert.equal(event.defaultPrevented, false);
  }
});
