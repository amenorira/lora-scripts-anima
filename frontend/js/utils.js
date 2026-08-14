/* ================================================================
   utils.js — 跨模块共享的前端工具（mixin + 全局常量）
   由 app.js 的 _mixinSources 合并进 animaApp 组件；脚本本身必须
   在所有使用方（monitor-render / environment-render / training-core 等）
   之前加载，见 index.html 的 script 顺序。
   ================================================================ */

// 训练类型 → 字段分组映射（config.js 与 training-core.js 共用）
window.TRAIN_GROUP_MAP = { 'sdxl-lora': 'sdxl', 'anima-lora': 'anima', 'krea2-lora': 'krea2' };

window.utilsMixin = {
  // Canonical HTML escape (text content & "-delimited attributes).
  // Handles null/undefined/0 correctly.
  esc(s) { if (s == null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },

  // monitor 命名空间 i18n 快捷包装：带点的 key 原样传，否则补 'monitor.' 前缀。
  tMonitor(key, fb) {
    const fullKey = key.includes('.') ? key : ('monitor.' + key);
    return this.t(fullKey, fb) || fb || key;
  },
};
