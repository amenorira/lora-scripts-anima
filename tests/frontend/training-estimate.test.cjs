const test = require('node:test');
const assert = require('node:assert/strict');
const {loadFrontend, composeMixins, response} = require('./helpers.cjs');

test('step requests retain the caption extension and invalidate when it changes', async () => {
  const requests = [];
  const {window} = loadFrontend('training/preflight', {window:{}, clearTimeout,
    fetch: async (url, options) => {requests.push(JSON.parse(options.body)); return response({total_steps:12});},
  });
  const app = composeMixins(window.trainingPreflight, {
    form:{model_train_type:'krea2-lora',train_data_dir:'train',caption_extension:'.caption'},
    _reconcileSubsetTimestepOffsets() {}, _refreshSubsetTimestepEditor() {},
  });
  await app.refreshStepEstimate();
  const signature = app._stepEstimateSignature;
  app.form.caption_extension = '.txt';
  await app.refreshStepEstimate();
  assert.equal(requests[0].caption_extension,'.caption');
  assert.equal(requests[1].caption_extension,'.txt');
  assert.notEqual(signature,app._stepEstimateSignature);
});

test('Krea formula renders counts and distinguishes explicit step budgets', () => {
  const {window} = loadFrontend('training/preflight');
  const labels = {'stepEstimate.imageTerm':'{images} x {repeats}',
    'stepEstimate.imageFormula':'{trainImages} images = {trainSamples} samples',
    'stepEstimate.totalFormula':'{epochs} x {steps} = {total}',
    'stepEstimate.maxStepsFormula':'{total} steps, approximately {epochs} epochs'};
  const app = composeMixins(window.trainingPreflight, {t:key=>labels[key] || key,
    stepEstimate:{engine_id:'musubi_tuner',duration_mode:'epochs',epochs:3,steps_per_epoch:4,total_steps:12,
      subsets:[{image_count:2,repeats:2,sample_count:4,is_reg:false}]},
  });
  assert.equal(app.stepEstimateImageFormula(),'2 images = 4 samples');
  assert.equal(app.stepEstimateTotalFormula(),'3 x 4 = 12');
  Object.assign(app.stepEstimate,{duration_mode:'steps',epochs:2,total_steps:5});
  assert.equal(app.stepEstimateTotalFormula(),'5 steps, approximately 2 epochs');
  assert.equal(app.stepEstimateNote(),'stepEstimate.kreaNote');
});
