const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFrontend, composeMixins, readRepo } = require('./helpers.cjs');

const dictionaries = Object.fromEntries(['zh-CN', 'en-US', 'ja-JP'].map(locale =>
  [locale, JSON.parse(readRepo(`frontend/i18n/${locale}.json`))]));

function application() {
  const context = loadFrontend(['training/preflight'], { window: {} });
  return composeMixins(context.window.trainingPreflight, {
    locale: 'zh-CN',
    t(key, fallback) {
      return key.split('.').reduce((value, part) => value?.[part], dictionaries[this.locale]) ?? fallback ?? key;
    },
  });
}

test('Krea step errors use locale keys and update when the language changes', () => {
  const app = application();
  app._setStepEstimateErrorFromResult({message: 'raw backend error', data: {
    errorCode: 'krea2NoCaptionedImages', errorParams: {},
  }});
  for (const [locale, expected] of [
    ['zh-CN', '数据集路径不存在或没有带同名标注的可用图片'],
    ['en-US', 'The dataset path does not exist or contains no supported images with matching captions'],
    ['ja-JP', 'データセットのパスが存在しないか、同名キャプションのある対応画像がありません'],
  ]) {
    app.locale = locale;
    assert.equal(app.stepEstimateErrorText(), expected);
  }
});

test('step errors keep raw diagnostics and paths intact', () => {
  const app = application();
  const detail = 'first cause / 原因一; second cause / 原因二: $&';
  const result = {message: detail, data: {errorCode: 'krea2EstimateInvalid', errorParams: {}}};
  app._setStepEstimateErrorFromResult(result);
  assert.equal(app.stepEstimateErrorText(), '无法计算 Krea 2 训练步数：' + detail);
  assert.deepEqual(result.data.errorParams, {});
  app._setStepEstimateErrorFromResult({data: {
    errorCode: 'datasetNotFound', errorParams: {path: 'C:/数据/$&/images'},
  }});
  assert.equal(app.stepEstimateErrorText(), '数据集目录不存在：C:/数据/$&/images');
  app._setStepEstimateErrorFromResult({message: detail, data: {errorCode: 'unknownError'}});
  assert.equal(app.stepEstimateErrorText(), detail);
});
