/* ================================================================
   utils.js — 跨模块共享的前端工具（mixin + 全局常量）
   由 app.js 的 _mixinSources 合并进 animaApp 组件；脚本本身必须
   在所有使用方（monitor-render / environment-render / training-core 等）
   之前加载，见 index.html 的 script 顺序。
   ================================================================ */

// 训练类型 → 字段分组映射（config.js 与 training-core.js 共用）
window.TRAIN_GROUP_MAP = { 'sdxl-lora': 'sdxl', 'anima-lora': 'anima', 'krea2-lora': 'krea2', 'moss-image-lora': 'moss_image' };

window.utilsMixin = {
  // Canonical HTML escape (text content & "-delimited attributes).
  // Handles null/undefined/0 correctly.
  esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },

  nativePickerUrl(type) {
    const params = new URLSearchParams({
      picker_type: type,
      title: this.t(`nativePicker.${type}.title`),
    });
    if (type !== 'folder') {
      params.set('file_type_label', this.t(`nativePicker.${type}.files`));
      params.set('all_files_label', this.t('nativePicker.allFiles'));
    }
    return '/api/pick_file?' + params;
  },

  // Fixed API failures use stable codes; unknown and third-party errors retain
  // their original message. Parameters are text and must still be escaped by
  // callers that insert the returned string into HTML.
  localizeApiError(payload, fallbackKey = 'common.requestFailed', fallbackText) {
    const body = payload && typeof payload === 'object' ? payload : {};
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const code = body.error_code || data.errorCode;
    const key = code ? `errors.${code}` : '';
    const translated = key ? this.t(key) : '';
    if (typeof translated === 'string' && translated && translated !== key) {
      const params = body.error_params || data.errorParams || {};
      return String(translated).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
        Object.hasOwn(params, name) && params[name] != null ? String(params[name]) : match);
    }
    return body.message || this.t(fallbackKey, fallbackText) || fallbackText || fallbackKey;
  },

  // Keep low-level diagnostics separate from the localized action message.
  apiErrorDetails(payload) {
    const body = payload && typeof payload === 'object' ? payload : {};
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const details = body.error_details ?? data.errorDetails;
    if (details == null || details === '') return '';
    return typeof details === 'string' ? details : JSON.stringify(details, null, 2);
  },

  // monitor 命名空间 i18n 快捷包装：带点的 key 原样传，否则补 'monitor.' 前缀。
  tMonitor(key, fb) {
    const fullKey = key.includes('.') ? key : ('monitor.' + key);
    return this.t(fullKey, fb) || fb || key;
  },
};
