const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins} = require('./helpers.cjs');

test('generation stops when named captions have no selected candidate', async () => {
  const {window} = loadFrontend('regularization/index', {window:{}});
  const messages = [], calls = [];
  const app = composeMixins(window.regularizationMixin, {
    regBusy:false, trainingActive:false, regTask:null,
    regPlan:{total:1, pending:1, candidate_selection_required:1},
    regScan:async()=>{}, regReportError:message=>messages.push(message),
    regT:key=>key, regStart:async()=>calls.push('start'), regAgain:async()=>calls.push('again'),
  });
  await app.regGenerate();
  assert.deepEqual(messages, ['candidateSelectionRequired']);
  assert.deepEqual(calls, []);
});

test('regularization source reasons use the selected language and preserve unknown details', () => {
  const {window} = loadFrontend(['shared/utils', 'regularization/index'], {window:{}});
  const app = composeMixins(window.utilsMixin, window.regularizationMixin, {
    t:key=>({'errors.regularization_missing_caption':'同名の .txt がありません'}[key] || key),
  });
  assert.equal(app.regReasonText({reason_code:'regularization_missing_caption', reason:'Missing caption txt / 缺少标签 txt'}), '同名の .txt がありません');
  assert.equal(app.regReasonText({reason_code:'unknown', reason:'disk error: details'}), 'disk error: details');
});
