/* ================================================================
   config.js — Training form field definitions & route table
   
   Training routes and monitor parameters share the backend field registry.
   ================================================================ */

let trainingFieldsRequest;
window.loadTrainingFields = function() {
  if (window.TRAIN_SECTIONS) return Promise.resolve(window.TRAIN_SECTIONS);
  trainingFieldsRequest ||= fetch('/api/fields').then(async response => {
    const body = await response.json();
    if (!response.ok || body.status !== 'success' || !body.data?.sections?.length) {
      throw new Error('Training fields unavailable');
    }
    window.TRAIN_SECTIONS = body.data.sections;
    return window.TRAIN_SECTIONS;
  }).finally(() => { trainingFieldsRequest = null; });
  return trainingFieldsRequest;
};

/**
 * Get all sections with fields filtered by the given train type.
 * @param {string} trainType - 'sdxl-lora' | 'anima-lora' | 'krea2-lora'
 * @returns {Array} sections with .fields filtered by group
 */
let visibleSectionsSource = null;
const visibleSectionsCache = new Map();

window.getVisibleSections = function(trainType) {
  // 字段注册表只在 /api/fields 返回时整体替换。相同注册表与训练类型的
  // 过滤结果可以安全复用，避免一次切换期间几十次 map/filter 全量 schema。
  if (visibleSectionsSource !== window.TRAIN_SECTIONS) {
    visibleSectionsSource = window.TRAIN_SECTIONS;
    visibleSectionsCache.clear();
  }
  if (visibleSectionsCache.has(trainType)) return visibleSectionsCache.get(trainType);

  const targetGroup = window.TRAIN_GROUP_MAP[trainType] || 'all';
  const sections = (window.TRAIN_SECTIONS || []).map(function(section) {
    const filteredFields = (section.fields || []).filter(function(field) {
      // Profile-scoped fields belong to an independent runtime schema. Legacy
      // sd-scripts fields deliberately do not leak into Krea 2 payloads.
      if (field.profiles && Array.isArray(field.profiles)) {
        return field.profiles.indexOf(trainType) !== -1;
      }
      if (trainType === 'krea2-lora') {
        return field.key === 'model_train_type';
      }
      var g = field.group;
      if (!g || g === 'all') return true;
      if (Array.isArray(g)) return g.indexOf(targetGroup) !== -1;
      return g === targetGroup;
    }).map(function(field) {
      const overrides = field.defaultByGroup || {};
      if (!Object.prototype.hasOwnProperty.call(overrides, targetGroup)) return field;
      // A product default differing from argparse must be written explicitly.
      return { ...field, default: overrides[targetGroup], omitDefault: false };
    });
    return { key: section.key, titleKey: section.titleKey, fields: filteredFields };
  }).filter(function(s) { return s.fields.length > 0; });
  visibleSectionsCache.set(trainType, sections);
  return sections;
};

window.ROUTE_CONFIG = {
  'home': { title: 'lora-scripts-anima' },
  'monitor-dashboard': { titleKey: 'nav.monitorDashboard' },
  'history': { titleKey: 'nav.history' },
  'train-basic': { titleKey: 'nav.loraTraining', trainType: 'anima-lora' },
  'tagger': { titleKey: 'tagger.title' },
  'ai-captioning': { titleKey: 'moss.pageTitle' },
  'tagEditor': { titleKey: 'tagEditor.title' },
  'regularization': { titleKey: 'regularization.title' },
  'environment': { titleKey: 'environment.title' },
  'settings': { titleKey: 'settings.title' },
  'docs': { titleKey: 'docs.title' },
  'tensorboard': { title: 'TensorBoard' },
};
