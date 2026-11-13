const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, deferred } = require('./helpers.cjs');

function app() {
  const copied = [], errors = [];
  const { window } = loadFrontend(['shared/confirmation-dialog', 'regularization/index'], {
    window: {}, navigator: { clipboard: { writeText: async text => copied.push(text) } },
  });
  const model = composeMixins(window.confirmationDialogMixin, {
    t: key => key, toast: (...args) => errors.push(args),
    $nextTick: callback => callback(),
  });
  return { model, copied, errors, regularization: window.regularizationMixin };
}

test('only the chosen callback executes, and stale clicks cannot execute it again', async () => {
  const { model } = app();
  const calls = [];
  const choice = model.openConfirm({
    title: 'Cache', message: 'Rebuild?', actionLabel: 'Rebuild',
    onConfirm: () => calls.push('rebuild'),
    secondaryLabel: 'Keep', onSecondary: () => calls.push('keep'),
  });
  model.confirmSecondaryAction(); model.confirmAction(); model.cancelConfirm();
  assert.equal(await choice, 'secondary');
  assert.deepEqual(calls, ['keep']);
  assert.equal(model._confirmRequest, null);
  assert.equal(model.showConfirmModal, false);
});

test('synchronous and asynchronous callback failures are reported without blocking the queue', async () => {
  for (const callback of [() => { throw new Error('sync'); }, async () => { throw new Error('async'); }]) {
    const { model, errors } = app();
    const choice = model.openConfirm({ title: 'First', onConfirm: callback });
    model.openConfirm({ title: 'Next' });
    model.confirmAction();
    await choice; await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1], 'error');
    model.confirmAfterClose();
    assert.equal(model.confirmDialog.title, 'Next');
  }
});

test('async steps keep the host open, block duplicate actions, and defer unrelated requests', async () => {
  const { model } = app(), pending = deferred(), callbacks = [];
  const details = { open: true }, body = { scrollTop: 100 };
  let focused = 0;
  model.$refs = { confirmDetails: details, confirmBody: body, confirmRoot: {
    open: true, getBoundingClientRect() {},
    querySelectorAll: () => [
      { getClientRects: () => [], focus() { assert.fail('hidden buttons cannot receive focus'); } },
      { getClientRects: () => [{}], focus() { focused++; } },
    ],
  } };
  const flow = model.openConfirm({ title: 'Preview', size: 'wide',
    onConfirm: () => callbacks.push('old-step'), next: () => pending.promise,
  });
  const unrelated = model.openNotice({ title: 'Other' });
  const proceeding = model.confirmAction();
  model.confirmAction(); model.cancelConfirm();
  assert.equal(model.confirmBusy, true);
  assert.equal(model.showConfirmModal, true);
  assert.equal(model.confirmDialog.title, 'Preview');
  pending.resolve({ title: 'Cache', size: 'standard', secondaryLabel: 'Keep', onSecondary: () => callbacks.push('keep') });
  await proceeding;
  assert.equal(model.showConfirmModal, true);
  assert.equal(model._confirmClosing, false);
  assert.equal(model.confirmBusy, false);
  assert.equal(model.confirmDialog.title, 'Cache');
  assert.equal(model.confirmDialog.size, 'standard');
  assert.equal(details.open, false);
  assert.equal(body.scrollTop, 0);
  assert.equal(focused, 1);
  assert.deepEqual(callbacks, []);
  model.confirmSecondaryAction();
  assert.equal(await flow, 'secondary');
  assert.deepEqual(callbacks, ['keep']);
  model.confirmAfterClose();
  assert.equal(model.confirmDialog.title, 'Other');
  model.confirmAction();
  assert.equal(await unrelated, 'confirm');
});

test('flow failures reject once and release the host for the next request', async () => {
  const { model } = app();
  const flow = model.openConfirm({ next: async () => { throw new Error('request failed'); } });
  const rejected = assert.rejects(flow, /request failed/);
  model.openNotice({ title: 'Next' });
  await model.confirmAction();
  await rejected;
  assert.equal(model.confirmBusy, false);
  assert.equal(model.showConfirmModal, false);
  model.confirmAfterClose();
  assert.equal(model.confirmDialog.title, 'Next');
});

test('regeneration rechecks the run, selection, route and busy state after async confirmation', async () => {
  for (const [change, expected] of [
    [() => {}, 2], [m => { m.regRunKey = 'other'; }, 0], [m => { m.regSelected = {}; }, 0],
    [m => { m.trainingActive = true; }, 0], [m => { m.regRunning = true; }, 0],
    [m => { m.regBusy = true; }, 0], [m => { m.currentRoute = 'home'; }, 0],
    [m => { m.cancelConfirm(); }, 0],
  ]) {
    const { model, regularization } = app();
    const requests = [];
    const item = { index: 7 };
    Object.assign(model, {
      regMutate: regularization.regMutate, regRunKey: 'original', regSelected: item,
      currentRoute: 'regularization', regT: key => key,
      regAction: async callback => callback(), regAcceptStart() {}, regApplyTask() {}, regLoadResults() {},
      regRequest: async path => { requests.push(path); return { task_id: 'task' }; },
    });
    const mutation = model.regMutate(item, 'regenerate');
    assert.equal(requests.length, 0);
    change(model);
    model.confirmAction();
    await mutation;
    assert.equal(requests.length, expected);
    if (requests.length) assert.equal(requests[0], '/runs/original/items/7/regenerate');
  }
});
