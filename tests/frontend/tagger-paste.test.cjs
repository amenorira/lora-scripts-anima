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

test('clipboard items fallback skips text and unavailable files', async () => {
  const { app, event, uploads } = fixture();
  const file = event.clipboardData.files[0];
  event.clipboardData = { items: [
    { kind: 'string', type: 'text/plain' },
    { kind: 'file', type: 'image/png', getAsFile: () => null },
    { kind: 'file', type: 'image/png', getAsFile: () => file },
  ] };
  await app.handleTaggerPaste(event);
  assert.deepEqual(uploads, [file]);
});

test('other pages, batch modes, and busy states do not upload', async () => {
  for (const overrides of [{ currentRoute: 'training' }, { taggerSourceMode: 'folder' },
    { taggerSourceMode: 'api-folder' }, { taggerRunning: true }, { taggerStarting: true },
    { taggerScanning: true }, { taggerApiSingleRunning: true }]) {
    const { app, event, uploads } = fixture(overrides);
    await app.handleTaggerPaste(event);
    assert.equal(uploads.length, 0);
    assert.equal(event.defaultPrevented, false);
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

test('workspace binds paste once at window scope', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/tagger-workspace.html'), 'utf8');
  assert.equal(html.split('@paste.window="handleTaggerPaste($event)"').length - 1, 1);
});
