/* ================================================================
   constants.js — 共享 UI 行为常量 / Shared UI behavior constants
   ================================================================ */

window.UI_CONSTANTS = {
  PROGRESS_STAGES: [
    { duration: 300, max: 30 },
    { duration: 1700, max: 65 },
    { duration: Infinity, max: 90 }
  ],

  LOG: {
    MAX_LINES: 5000,        // 内存环形缓冲上限（实时尾部 DOM 渲染行数）
    FULL_PAGE_SIZE: 1000,   // 「完整日志」模式每页拉取行数
  },
};
