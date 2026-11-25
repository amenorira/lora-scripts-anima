const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readRepo } = require('./helpers.cjs');

const LOCALES = ['zh-CN', 'en-US', 'ja-JP'];

function flattenDictionary(node, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(node || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenDictionary(value, full, out);
    } else {
      out.set(full, value);
    }
  }
  return out;
}

function collectFiles(dir, extensions) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(ROOT, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (rel === 'frontend/js/vendor' || rel === 'frontend/tensorboard') continue;
      results.push(...collectFiles(fullPath, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push({ fullPath, rel });
    }
  }
  return results;
}

test('all three locale dictionaries have identical keys, nonempty strings, and matching placeholders', () => {
  const flat = Object.fromEntries(LOCALES.map(locale => [
    locale,
    flattenDictionary(JSON.parse(readRepo(`frontend/i18n/${locale}.json`))),
  ]));
  const baseKeys = Array.from(flat['zh-CN'].keys());

  for (const locale of LOCALES) {
    const keys = new Set(flat[locale].keys());
    const missing = baseKeys.filter(key => !keys.has(key));
    const extra = Array.from(keys).filter(key => !flat['zh-CN'].has(key));
    assert.deepEqual(missing, [], `${locale} is missing keys`);
    assert.deepEqual(extra, [], `${locale} has extra keys`);
    for (const [key, value] of flat[locale]) {
      assert.equal(typeof value, 'string', `${locale}:${key} must be a string`);
      assert.ok(value.length > 0, `${locale}:${key} must not be empty`);
    }
  }

  const placeholderRe = /\{([A-Za-z0-9_]+)\}/g;
  for (const key of baseKeys) {
    const signatures = LOCALES.map(locale =>
      Array.from(new Set(Array.from(flat[locale].get(key).matchAll(placeholderRe), m => m[1]))).sort().join(',')
    );
    assert.equal(signatures[1], signatures[0], `Placeholder mismatch between zh-CN and en-US for ${key}`);
    assert.equal(signatures[2], signatures[0], `Placeholder mismatch between zh-CN and ja-JP for ${key}`);
  }
});

test('frontend references resolve to existing locale keys and contain no literal fallbacks', () => {
  const dicts = LOCALES.map(locale => flattenDictionary(JSON.parse(readRepo(`frontend/i18n/${locale}.json`))));
  const files = [
    { fullPath: path.join(ROOT, 'frontend/index.html'), rel: 'frontend/index.html' },
    ...collectFiles(path.join(ROOT, 'frontend/templates'), ['.html']),
    ...collectFiles(path.join(ROOT, 'frontend/js'), ['.js']),
  ];
  const refRe = /(?<![A-Za-z0-9_$])(?:this\.)?(t|T|tMonitor|trainingText|_setStepEstimateError)\(\s*(['"])([A-Za-z0-9_.-]+)\2\s*[,)]/g;
  const fallbackRe = /(?<![A-Za-z0-9_$])(?:this\.)?(t|T|tMonitor|trainingText|_datasetRepeatText|_setStepEstimateError)\(\s*(['"])([A-Za-z0-9_.-]+)\2\s*,\s*(['"`])([^'"`]+)\4/g;
  const notifyRefRe = /(?<![A-Za-z0-9_$.])text\(\s*(['"])([A-Za-z0-9_.-]+)\1\s*[,)]/g;
  const notifyFallbackRe = /(?<![A-Za-z0-9_$.])text\(\s*(['"])([A-Za-z0-9_.-]+)\1\s*,\s*(['"`])([^'"`]+)\3/g;

  const missingRefs = [];
  const literalFallbacks = [];
  let checkedCount = 0;

  for (const { fullPath, rel } of files) {
    const text = fs.readFileSync(fullPath, 'utf8');
    for (const match of text.matchAll(refRe)) {
      const [, fn, , rawKey] = match;
      let fullKey = rawKey;
      if (fn === 'T' && rel.startsWith('frontend/js/environment/')) {
        fullKey = `environment.${rawKey}`;
      } else if (!rawKey.includes('.')) {
        if (fn === 'tMonitor' || rel.startsWith('frontend/js/monitor/')) fullKey = `monitor.${rawKey}`;
        else if (rel === 'frontend/js/training/shape-preview.js') fullKey = `shapePreview.${rawKey}`;
        else if (rel.startsWith('frontend/js/regularization/')) fullKey = `regularization.${rawKey}`;
      }
      checkedCount++;
      for (let i = 0; i < LOCALES.length; i++) {
        if (!dicts[i].has(fullKey)) missingRefs.push(`${rel}:${fullKey}:${LOCALES[i]}`);
      }
    }
    for (const match of text.matchAll(fallbackRe)) {
      literalFallbacks.push(`${rel}: ${match[0]}`);
    }
    if (rel === 'frontend/js/shared/notifications.js') {
      for (const match of text.matchAll(notifyRefRe)) {
        const fullKey = `notifications.${match[2]}`;
        checkedCount++;
        for (let i = 0; i < LOCALES.length; i++) {
          if (!dicts[i].has(fullKey)) missingRefs.push(`${rel}:${fullKey}:${LOCALES[i]}`);
        }
      }
      for (const match of text.matchAll(notifyFallbackRe)) {
        literalFallbacks.push(`${rel}: ${match[0]}`);
      }
    }
  }

  assert.ok(checkedCount > 1500, `Expected at least 1500 static translation calls, got ${checkedCount}`);
  assert.deepEqual(missingRefs, [], `Missing translation keys: ${missingRefs.slice(0, 10).join(', ')}`);
  assert.deepEqual(literalFallbacks, [], `Found duplicate literal fallbacks: ${literalFallbacks.slice(0, 10).join(', ')}`);
});

test('all monitor.dd* locale keys are referenced in frontend code', () => {
  const zh = JSON.parse(readRepo('frontend/i18n/zh-CN.json'));
  const ddKeys = Object.keys(zh.monitor || {}).filter(k => k.startsWith('dd'));
  assert.ok(ddKeys.length > 0, 'Expected monitor.dd* keys in zh-CN.json');

  const files = [
    path.join(ROOT, 'frontend/index.html'),
    ...collectFiles(path.join(ROOT, 'frontend/templates'), ['.html']).map(f => f.fullPath),
    ...collectFiles(path.join(ROOT, 'frontend/js'), ['.js']).map(f => f.fullPath),
  ];

  const referenced = new Set();
  const refRe = /['"`](?:monitor\.)?(dd[A-Za-z0-9_]+)['"`]/g;
  for (const fullPath of files) {
    const text = fs.readFileSync(fullPath, 'utf8');
    for (const match of text.matchAll(refRe)) {
      referenced.add(match[1]);
    }
  }

  const KNOWN_DYNAMIC_PREFIXES = [];
  const orphanKeys = ddKeys.filter(key =>
    !referenced.has(key) && !KNOWN_DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))
  );
  assert.deepEqual(orphanKeys, [], `Orphan monitor.dd* keys not referenced in frontend/: ${orphanKeys.join(', ')}`);
});

test('backend coded errors exist in all locale dictionaries', () => {
  const dicts = Object.fromEntries(LOCALES.map(locale => [locale, JSON.parse(readRepo(`frontend/i18n/${locale}.json`))]));
  const backendFiles = [
    'backend/training/shape_preview.py',
    'backend/training/datasets/crop_preview.py',
    'backend/training/datasets/prompt_tags.py',
    'backend/training/config/config_import.py',
    'backend/training/config/network_config.py',
    'backend/training/config/krea2_network.py',
    'backend/training/config/training_config.py',
    'backend/training/preview/config.py',
    'backend/tagger/workspace.py',
    'backend/tagger/workspace_sources.py',
    'backend/tagger/workspace_tasks.py',
    'backend/server/routes/training.py',
    'backend/server/routes/tagger.py',
    'backend/monitor/routes.py',
  ];
  const codes = new Set();
  const ctorRe = /(?:ShapePreviewError|CropPreviewError|TaggerUserError|TaggerRuntimeError|TaggerNotFoundError|TaggerIndexError)\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  const configRe = /(?:TrainingConfigError|PreviewConfigError)\([^)]*?\bcode\s*=\s*['"]([A-Za-z0-9_]+)['"]/g;
  const stepRe = /StepEstimateError\([^)]*?\bcode\s*=\s*['"]([A-Za-z0-9_]+)['"]/g;
  const dictRe = /['"]error_?[Cc]ode['"]\s*:\s*['"]([A-Za-z0-9_]+)['"]/g;

  for (const rel of backendFiles) {
    const text = readRepo(rel);
    for (const re of [ctorRe, configRe, stepRe, dictRe]) {
      for (const match of text.matchAll(re)) codes.add(match[1]);
    }
  }

  assert.ok(codes.size >= 50, `Expected at least 50 backend error codes, got ${codes.size}`);
  for (const locale of LOCALES) {
    const d = dicts[locale];
    const known = new Set([
      ...Object.keys(d.errors || {}),
      ...Object.keys(d.stepEstimate?.errors || {}),
      ...Object.keys(d.datasetRepeat?.errors || {}),
      ...Object.keys(d.control?.errors || {}),
      ...Object.keys(d.training?.errors || {}),
    ]);
    for (const code of codes) {
      assert.ok(known.has(code), `${locale} is missing localization for backend error code: ${code}`);
    }
  }
});
