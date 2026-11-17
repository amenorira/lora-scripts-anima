const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadGlobalFrontend, composeMixins} = require('./helpers.cjs');
loadGlobalFrontend(['shared/utils', 'monitor/artifacts-render']);

test('native transient geometry freezes the first keyframe and reuses one effect without inline style writes', () => {
  const value = composeMixins(window.monitorArtifactsRenderMixin), owner = {};
  let created = 0, paused = 0, updates = 0, cancelled = 0, removed = 0;
  owner.anchor = {remove() {removed++;}};
  const motion = {finished: Promise.resolve(), effect: {setKeyframes(frames) {
    assert.equal(frames[0].offset, 0); updates++;
  }}, pause() {paused++;}, cancel() {cancelled++;}};
  const element = {style: new Proxy({}, {set() {assert.fail('native geometry must not mutate style attributes');}}),
    animate(frames, options) {created++; assert.equal(frames[0].offset, 0); assert.equal(options.fill, 'both'); return motion;}};
  value._setPreviewTransientStyle(owner, element, {left: '12px', width: '240px'});
  assert.equal(created, 1); assert.equal(paused, 1); assert.equal(motion.currentTime, 0);
  value._setPreviewTransientStyle(owner, element, {left: '12px', width: '240px'});
  assert.equal(updates, 0);
  value._setPreviewTransientStyle(owner, element, {left: '24px', width: '220px'});
  assert.equal(updates, 1); assert.equal(created, 1);
  const layer = {_lossNodes: new Map([['current', owner]]), replaceChildren() {}};
  value._clearPreviewLossOverlays(layer);
  assert.equal(cancelled, 1); assert.equal(removed, 1); assert.equal(layer._lossNodes.size, 0); assert.equal(layer.hidden, true);
});

test('delegated thumbnail results affect only the displayed thumbnail, excluding preload images', () => {
  const value = composeMixins(window.utilsMixin, window.monitorArtifactsRenderMixin, {weakNetworkMode: false});
  let failed = false;
  const frame = {classList: {toggle(name, flag) {assert.equal(name, 'is-error'); failed = flag;}}};
  const image = {classList: {contains: name => name === 'preview-thumb-image'}, closest: () => frame};
  value.previewThumbnailResult({target: image}, true); assert.equal(failed, true);
  value.previewThumbnailResult({target: {classList: {contains: () => false}}}, false);
  assert.equal(failed, true, 'a hidden preload load must not clear an error before decoding');
  value.previewThumbnailResult({target: image}, false); assert.equal(failed, false);
  const html = value._previewThumbImageHtml({name: 'one.png', url: '/one.png'});
  assert.match(html, /preview-thumb-image/); assert.doesNotMatch(html, /@load|@error/);
});

test('freshly rendered captions seed their content cache without replacing the new DOM', () => {
  let writes = 0, loss = '.1';
  const caption = {dataset: {sampleLossBatch: 'b', sampleLossDetail: '', sampleLossStatus: ''}, set outerHTML(_) {writes++;}};
  const value = composeMixins(window.monitorArtifactsRenderMixin, {sampleEffectiveLossMode: 'overall', lossDataVersion: 1,
    _sampleDataModel: () => ({byBatch: new Map([['b', {id: 'b'}]])}), _sampleCardCaptionHtml: () => loss});
  const panel = {querySelectorAll: () => [caption]};
  value._patchSampleLossCaptions(panel, true);
  assert.equal(writes, 0);
  value.lossDataVersion++; value._patchSampleLossCaptions(panel);
  assert.equal(writes, 0);
  loss = '.09'; value.lossDataVersion++; value._patchSampleLossCaptions(panel);
  assert.equal(writes, 1);
});
