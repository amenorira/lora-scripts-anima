const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins } = require('./helpers.cjs');

function app() {
  const copied = [], errors = [];
  const { window } = loadFrontend(['shared/confirmation-dialog', 'regularization/index'], {
    window: {}, navigator: { clipboard: { writeText: async text => copied.push(text) } },
  });
  const model = composeMixins(window.confirmationDialogMixin, {
    t: key => key, toast: (...args) => errors.push(args),
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

test('overlapping notices wait for confirmation and its exit before opening', async () => {
  const { model } = app();
  const first = model.openConfirm({ title: 'Delete', tone: 'danger' });
  const second = model.openNotice({ title: 'Warning', details: 'a diagnostic' });
  assert.equal(model.confirmDialog.title, 'Delete');
  model.cancelConfirm();
  assert.equal(await first, 'cancel');
  assert.equal(model.showConfirmModal, false);
  model.confirmAfterClose();
  assert.equal(model.confirmDialog.title, 'Warning');
  assert.equal(model.confirmDialog.notice, true);
  model.confirmAction();
  assert.equal(await second, 'confirm');
});

test('callbacks can immediately enqueue another confirmation without losing it', async () => {
  const { model } = app();
  let second;
  const first = model.openConfirm({ title: 'First', onConfirm() { second = this.openConfirm({ title: 'Second' }); } });
  model.confirmAction();
  assert.equal(await first, 'confirm');
  model.confirmAfterClose();
  assert.equal(model.confirmDialog.title, 'Second');
  model.cancelConfirm();
  assert.equal(await second, 'cancel');
});

test('programmatic cancellation before the native dialog opens does not stall the queue', async () => {
  const { model } = app();
  const ticks = [];
  model.$refs = { confirmRoot: { open: false } };
  model.$nextTick = callback => ticks.push(callback);
  const first = model.openConfirm({ title: 'Cancelled before paint' });
  model.cancelConfirm();
  model.openConfirm({ title: 'Next' });
  ticks.shift()();
  assert.equal(await first, 'cancel');
  assert.equal(model.confirmDialog.title, 'Next');
  assert.equal(model.showConfirmModal, true);
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

test('details and third choices get readable defaults, while caller sizes take precedence', async () => {
  const { model, copied } = app();
  model.openNotice({ title: 'Failed', message: '<failure>', context: 'C:/训练', details: 'WinError 5', tone: 'error' });
  assert.equal(model.confirmDialog.size, 'standard');
  assert.equal(model.confirmDialog.message, '<failure>');
  await model.copyConfirmDetails();
  assert.deepEqual(copied, ['Failed\n\nC:/训练\n\n<failure>\n\nWinError 5']);
  model.confirmAction(); model.confirmAfterClose();
  model.openConfirm({ title: 'Custom', size: 'compact', width: 560 });
  assert.equal(model.confirmDialog.size, 'compact');
  assert.equal(model.confirmDialog.width, 560);
  model.cancelConfirm(); model.confirmAfterClose();
  model.openConfirm({ title: 'Keep or rebuild', secondaryLabel: 'Keep' });
  assert.equal(model.confirmDialog.size, 'standard');
  model.cancelConfirm(); model.confirmAfterClose();
  model.openNotice({ title: 'Diagnostic', details: Array.from({ length: 10 }, (_, i) => 'trace line ' + i).join('\n') });
  assert.equal(model.confirmDialog.size, 'wide');
});

test('a notice cannot expose or execute a secondary action', async () => {
  const { model } = app();
  const choice = model.openNotice({ title: 'Warning', secondaryLabel: 'Keep', onSecondary() { assert.fail(); } });
  model.confirmSecondaryAction();
  assert.equal(model.showConfirmModal, true);
  assert.equal(model.confirmDialog.secondaryLabel, '');
  model.confirmAction();
  assert.equal(await choice, 'confirm');
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
