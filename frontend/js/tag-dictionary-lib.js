/* ================================================================
   tag-dictionary-lib.js — Danbooru 中文词典纯逻辑层

   没有 DOM、没有 Worker API，同时被三方加载：
     - 主线程（index.html 普通 script）
     - Web Worker（importScripts）
     - Node 测试（vm.runInNewContext）

   这里只做数据与算法：Anima 格式转换、索引、查询、排序。
   词典数据本身只在 Worker 里存在，主线程只拿少量结果。
   ================================================================ */
(function (global) {
  'use strict';

  var SCHEMA_VERSION = 1;

  // Danbooru 分类 ID（2 = 已废弃的 spoiler，数据源不出现）
  var CATEGORY_NAMES = { 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' };

  // Anima 官方规则里唯一保留 underscore 的普通标签
  var SCORE_TAG = /^score_[1-9]$/;
  var WHITESPACE = /\s+/g;
  var LEADING_AT = /^@+/;

  // core 记录字段下标（与 tools/dev/build_tag_dictionary.py 的输出一致）
  var F_CANONICAL = 0, F_TRANSLATION = 1, F_CATEGORY = 2, F_POST_COUNT = 3, F_ALIASES = 4;

  // 单次前缀扫描的安全上限：命中再多也只保留这个数量，避免极端短前缀拖慢查询
  var PREFIX_SCAN_LIMIT = 20000;

  function normalizeKey(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(WHITESPACE, '_');
  }

  function categoryName(category) {
    return CATEGORY_NAMES[category] || 'general';
  }

  /* Danbooru canonical → Anima 训练格式。

     只做格式归一化，不做 escaping：下划线换空格、画师加 @、score_* 原样保留。
     `-` `/` `(` `)` 等字符一律保留，绝不删除特殊字符。 */
  function danbooruToAnimaTag(canonical, category) {
    var tag = String(canonical == null ? '' : canonical);
    if (!tag) return '';
    var out = SCORE_TAG.test(tag) ? tag : tag.replace(/_/g, ' ');
    if (category === 1 && out.charAt(0) !== '@') out = '@' + out;
    return out;
  }

  /* 反查候选：已有 caption 可能写成 Danbooru、Anima 或带 @ 的形式。
     只生成候选，命中与否由词典记录决定。 */
  function lookupKeys(value) {
    var raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    var keys = [normalizeKey(raw)];
    var stripped = raw.replace(LEADING_AT, '');
    if (stripped !== raw) {
      var key = normalizeKey(stripped);
      if (keys.indexOf(key) === -1) keys.push(key);
    }
    return keys;
  }

  function splitAliases(packed) {
    if (!packed) return [];
    return packed.split('|');
  }

  /* 建立索引。records 已按图片数降序（构建脚本保证），
     因此 id 升序 == 热门度降序，同级排序直接用 id 顺序即可。 */
  function createIndex(records, details) {
    var count = records.length;
    var index = {
      records: records,
      details: details || null,
      canonicalKeys: new Array(count),
      translationKeys: new Array(count),
      canonicalMap: new Map(),
      translationMap: new Map(),
      aliasMap: new Map(),
      aliasKeys: [],
      aliasTexts: [],
      aliasIds: [],
      translationIds: [],
      canonicalOrder: null,
      translationOrder: null,
      aliasOrder: null
    };

    var i, record, key, ids;
    for (i = 0; i < count; i++) {
      record = records[i];
      key = normalizeKey(record[F_CANONICAL]);
      index.canonicalKeys[i] = key;
      if (!index.canonicalMap.has(key)) index.canonicalMap.set(key, i);

      var translation = record[F_TRANSLATION];
      if (translation) {
        var tkey = normalizeKey(translation);
        index.translationKeys[i] = tkey;
        ids = index.translationMap.get(tkey);
        if (ids) ids.push(i); else index.translationMap.set(tkey, [i]);
        index.translationIds.push(i);
      }

      var aliases = splitAliases(record[F_ALIASES]);
      for (var a = 0; a < aliases.length; a++) {
        var akey = normalizeKey(aliases[a]);
        if (!akey || akey === key) continue;
        var entry = index.aliasKeys.length;
        index.aliasKeys.push(akey);
        index.aliasTexts.push(aliases[a]);
        index.aliasIds.push(i);
        ids = index.aliasMap.get(akey);
        if (ids) ids.push(entry); else index.aliasMap.set(akey, [entry]);
      }
    }

    index.canonicalOrder = sortedOrder(count, index.canonicalKeys);
    index.translationOrder = sortedOrder(index.translationIds.length, index.translationKeys, index.translationIds);
    index.aliasOrder = sortedOrder(index.aliasKeys.length, index.aliasKeys);
    return index;
  }

  /* 返回"按下标排序后的下标数组"。ids 给定时按 ids[i] 取键（用于只排子集）。 */
  function sortedOrder(length, keys, ids) {
    var order = new Array(length);
    for (var i = 0; i < length; i++) order[i] = i;
    order.sort(function (x, y) {
      var kx = keys[ids ? ids[x] : x];
      var ky = keys[ids ? ids[y] : y];
      if (kx < ky) return -1;
      if (kx > ky) return 1;
      return 0;
    });
    return order;
  }

  /* 二分定位前缀起点，再顺序扫出所有命中；结果按 id 升序（热门优先）。 */
  function prefixMatches(order, keyOf, prefix, bucket, cap) {
    var low = 0, high = order.length;
    while (low < high) {
      var mid = (low + high) >> 1;
      if (keyOf(order[mid]) < prefix) low = mid + 1; else high = mid;
    }
    for (var i = low; i < order.length && bucket.length < cap; i++) {
      if (!keyOf(order[i]).startsWith(prefix)) break;
      bucket.push(order[i]);
    }
  }

  /* 命中列表按 id 去重：先收录的层级优先级更高，重复命中直接跳过。 */
  function pushHit(out, ids, id, match, alias) {
    if (ids.has(id)) return;
    ids.add(id);
    out.push({ id: id, match: match, alias: alias || '' });
  }

  function pushAliasHit(index, out, ids, entry, match) {
    pushHit(out, ids, index.aliasIds[entry], match, index.aliasTexts[entry]);
  }

  /* 搜索结果对象：UI 直接可用，不暴露紧凑数组下标。 */
  function toResult(index, id, match, alias) {
    var record = index.records[id];
    return {
      id: id,
      canonical: record[F_CANONICAL],
      animaTag: danbooruToAnimaTag(record[F_CANONICAL], record[F_CATEGORY]),
      translation: record[F_TRANSLATION],
      category: record[F_CATEGORY],
      postCount: record[F_POST_COUNT],
      match: match || '',
      alias: alias || ''
    };
  }

  /* 精确匹配：canonical → 中文 → 别名，收录顺序即展示顺序。 */
  function exactMatches(index, keys, out, ids) {
    var i, k, list, id;
    for (i = 0; i < keys.length; i++) {
      id = index.canonicalMap.get(keys[i]);
      if (id != null) pushHit(out, ids, id, 'canonical');
    }
    for (i = 0; i < keys.length; i++) {
      list = index.translationMap.get(keys[i]);
      if (!list) continue;
      for (k = 0; k < list.length; k++) pushHit(out, ids, list[k], 'translation');
    }
    for (i = 0; i < keys.length; i++) {
      list = index.aliasMap.get(keys[i]);
      if (!list) continue;
      for (k = 0; k < list.length; k++) pushAliasHit(index, out, ids, list[k], 'alias');
    }
  }

  /* 前缀匹配：canonical → 中文 → 别名。

     前缀区间是按 key 字典序排的，同一层级内部要求图片数降序，
     而 id 升序就是图片数降序，所以命中要先按 id 排一遍再取前几条。 */
  function prefixMatchesAll(index, keys, out, ids, cap) {
    var i, pos, bucket, prefix, list;
    for (i = 0; i < keys.length; i++) {
      prefix = keys[i];
      bucket = [];
      prefixMatches(index.canonicalOrder, function (id) { return index.canonicalKeys[id]; },
        prefix, bucket, PREFIX_SCAN_LIMIT);
      bucket.sort(ascending);
      for (pos = 0; pos < bucket.length && out.length < cap; pos++) {
        pushHit(out, ids, bucket[pos], 'canonical');
      }
    }
    for (i = 0; i < keys.length; i++) {
      prefix = keys[i];
      bucket = [];
      prefixMatches(index.translationOrder, function (p) {
        return index.translationKeys[index.translationIds[p]];
      }, prefix, bucket, PREFIX_SCAN_LIMIT);
      list = bucket.map(function (p) { return index.translationIds[p]; }).sort(ascending);
      for (pos = 0; pos < list.length && out.length < cap; pos++) {
        pushHit(out, ids, list[pos], 'translation');
      }
    }
    for (i = 0; i < keys.length; i++) {
      prefix = keys[i];
      bucket = [];
      prefixMatches(index.aliasOrder, function (entry) { return index.aliasKeys[entry]; },
        prefix, bucket, PREFIX_SCAN_LIMIT);
      bucket.sort(function (a, b) { return index.aliasIds[a] - index.aliasIds[b]; });
      for (pos = 0; pos < bucket.length && out.length < cap; pos++) {
        pushAliasHit(index, out, ids, bucket[pos], 'alias');
      }
    }
  }

  function ascending(a, b) {
    return a - b;
  }

  /* 子串回退：records 与别名表都按热门度排列，扫够 limit 即可停。 */
  function containsMatches(index, keys, out, ids, cap) {
    var i, query, id, entry;
    var bucket;
    for (i = 0; i < keys.length; i++) {
      query = keys[i];
      bucket = [];
      for (id = 0; id < index.records.length && bucket.length < cap; id++) {
        if (index.canonicalKeys[id].indexOf(query) !== -1 ||
            (index.translationKeys[id] && index.translationKeys[id].indexOf(query) !== -1)) {
          bucket.push(id);
        }
      }
      for (var at = 0; at < bucket.length && out.length < cap; at++) {
        pushHit(out, ids, bucket[at], 'contains');
      }
      for (entry = 0; entry < index.aliasKeys.length && out.length < cap; entry++) {
        if (index.aliasKeys[entry].indexOf(query) !== -1) pushAliasHit(index, out, ids, entry, 'contains');
      }
    }
  }

  /* 查询入口：精确 → 前缀 → 子串回退。

     out 的顺序就是排序结果：同一层级内 id 升序 == 图片数降序
     （构建脚本已按图片数降序输出 records，见 createIndex 注释）。 */
  function search(index, query, limit) {
    var max = Math.max(1, Math.min(Number(limit) || 20, 50));
    var keys = lookupKeys(query);
    if (!keys.length) return [];

    var out = [];
    var ids = new Set();
    exactMatches(index, keys, out, ids);
    if (out.length < max) prefixMatchesAll(index, keys, out, ids, max);
    if (out.length < max) containsMatches(index, keys, out, ids, max);

    var results = [];
    for (var i = 0; i < out.length && results.length < max; i++) {
      var hit = out[i];
      results.push(toResult(index, hit.id, hit.match, hit.alias));
    }
    return results;
  }

  /* 反查：把 caption 里的真实值映射到词典记录。

     canonical 优先（Danbooru 与 Anima 写法都归一到这里），其次是中文和别名：
     有人直接用中文写 caption，认出来就能给中文、分类色和说明，但同样只影响显示，
     不会改写已有标注。 */
  function lookup(index, value) {
    var keys = lookupKeys(value);
    var i, hit, id;
    for (i = 0; i < keys.length; i++) {
      id = index.canonicalMap.get(keys[i]);
      if (id != null) return { id: id, result: toResult(index, id, 'canonical', '') };
    }
    for (i = 0; i < keys.length; i++) {
      var translations = index.translationMap.get(keys[i]);
      if (translations && translations.length) return { id: translations[0], result: toResult(index, translations[0], 'translation', '') };
    }
    for (i = 0; i < keys.length; i++) {
      hit = index.aliasMap.get(keys[i]);
      if (hit && hit.length) {
        var entry = hit[0];
        return { id: index.aliasIds[entry], result: toResult(index, index.aliasIds[entry], 'alias', index.aliasTexts[entry]) };
      }
    }
    return null;
  }

  function describe(index, id) {
    if (!index.details || id == null || id < 0 || id >= index.details.length) return '';
    return index.details[id] || '';
  }

  /* 别名列表只在说明卡里用，批量查询不返回，免得每张图都传一堆没人看的字符串。 */
  function aliasesOf(index, id) {
    if (id == null || id < 0 || id >= index.records.length) return [];
    return splitAliases(index.records[id][F_ALIASES]);
  }

  /* 图片数显示：3.6M / 580K / 187。只在同级排序和 UI 辅助里使用。 */
  function formatCount(value) {
    var count = Number(value) || 0;
    if (count <= 0) return '';
    if (count >= 1e6) return trimZero(count / 1e6, count < 1e7 ? 1 : 0) + 'M';
    if (count >= 1e4) return trimZero(count / 1e3, count < 1e5 ? 1 : 0) + 'K';
    return String(count);
  }

  /* 体积显示：9.4 MB / 812 KB，只用于词典状态面板 */
  function formatSize(bytes) {
    var value = Number(bytes) || 0;
    if (value <= 0) return '';
    if (value >= 1048576) return (value / 1048576).toFixed(1) + ' MB';
    if (value >= 1024) return Math.round(value / 1024) + ' KB';
    return value + ' B';
  }

  function trimZero(value, digits) {
    var text = value.toFixed(digits);
    return text.indexOf('.') === -1 ? text : text.replace(/\.0+$/, '');
  }

  global.TagDictionary = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    CATEGORY_NAMES: CATEGORY_NAMES,
    FIELD: {
      CANONICAL: F_CANONICAL,
      TRANSLATION: F_TRANSLATION,
      CATEGORY: F_CATEGORY,
      POST_COUNT: F_POST_COUNT,
      ALIASES: F_ALIASES
    },
    normalizeKey: normalizeKey,
    categoryName: categoryName,
    danbooruToAnimaTag: danbooruToAnimaTag,
    lookupKeys: lookupKeys,
    splitAliases: splitAliases,
    createIndex: createIndex,
    search: search,
    lookup: lookup,
    describe: describe,
    aliasesOf: aliasesOf,
    toResult: toResult,
    formatCount: formatCount,
    formatSize: formatSize
  };
})(typeof window !== 'undefined' ? window : self);
