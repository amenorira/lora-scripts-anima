const {test} = require('node:test');
const assert = require('node:assert/strict');

const charts = import('../../frontend/tensorboard/timesteps.mjs');

test('zoom preserves its anchor and stays inside the timestep range', async () => {
  const {zoomDomain} = await charts;
  assert.deepEqual(zoomDomain([0,1000],500,.5),[250,750]);
  assert.deepEqual(zoomDomain([0,1000],0,.5),[0,500]);
  assert.deepEqual(zoomDomain([0,1000],1000,.5),[500,1000]);
  assert.deepEqual(zoomDomain([250,750],500,10),[0,1000]);
  assert.deepEqual(zoomDomain([0,4],0,.01),[0,2]);
});

test('hover selects actual unit-width bins, including the final endpoint', async () => {
  const {binAt} = await charts;
  assert.equal(binAt(100.99),100);
  assert.equal(binAt(0),0);
  assert.equal(binAt(1000),999);
  assert.equal(binAt(-1),0);
});

test('count axes have distinct integer ticks for early sparse samples', async () => {
  const {countScale} = await charts;
  assert.deepEqual(countScale(1),{step:1,maximum:2});
  assert.deepEqual(countScale(197),{step:50,maximum:250});
  assert.deepEqual(countScale(550),{step:200,maximum:600});
});

test('zoomed bars retain independent exact counts and clip at the selected range', async () => {
  const {barPath} = await charts;
  const counts = new Array(1000).fill(0);
  counts[100]=2; counts[101]=4; counts[900]=999;
  const path = barPath(counts,[100,102],4);
  assert.equal((path.match(/M/g)||[]).length,2);
  assert.match(path,/v-165/);
  assert.match(path,/v-330/);
  assert.ok(!path.includes('NaN'));
  assert.equal(barPath(counts,[500,600],1),'');
});
