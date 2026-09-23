const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('lightbox keeps a preview and ignores decoded images after navigation or close', async () => {
  const pending = [];
  const context = {
    window: { location: { href: 'http://localhost/' } }, URL, URLSearchParams,
    document: { body: { classList: { add() {}, remove() {} } }, querySelector() {} },
    Image: class { decode() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/tag-editor.js'), 'utf8'), context);
  const app = Object.assign({}, context.window.tagEditorMixin, {
    tagEditorSessionId: 'session', tagEditorSelected: ['prior'],
    _updateEditorPanel() {}, $nextTick(fn) { fn(); }, toast() {}, t: key => key,
  });
  const img = n => ({ path: `/${n}`, preview: `/api/image-preview?variant=preview&path=${n}&v=${n}` });
  app.tagEditorOpenLightbox(img(1));
  assert.equal(app.tagEditorLightboxSrc, img(1).preview);
  app.tagEditorOpenLightbox(img(2));
  pending[0].resolve();
  await Promise.resolve();
  assert.equal(app.tagEditorLightboxSrc, img(2).preview);
  assert.equal(app.tagEditorLightboxLoading, true);
  pending[1].resolve();
  await Promise.resolve();
  assert.match(app.tagEditorLightboxSrc, /variant=original&path=2&v=2/);
  assert.equal(app.tagEditorLightboxLoading, false);
  app.tagEditorOpenLightbox(img(3));
  app.tagEditorCloseLightbox();
  pending[2].resolve();
  await Promise.resolve();
  assert.equal(app.tagEditorLightboxSrc, '');
  assert.deepEqual(app.tagEditorSelected, ['prior']);
});
