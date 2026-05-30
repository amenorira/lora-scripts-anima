/* ================================================================
   constants.js — 集中 UI 常量 / Centralized UI constants
   Avoid hardcoding selector strings, route names, and magic
   numbers scattered across multiple JS files.
   ================================================================ */

window.UI_CONSTANTS = {
  SELECTORS: {
    SIDEBAR_DROPDOWN: '.sidebar-dropdown',
    TRAIN_FORM: '#trainFormContent',
    TOAST_CONTAINER: '#toastContainer',
    TAGGER_OUTPUT: '#tagger-output',
    TAGGER_STOP_BTN: '#tagger-stop-btn',
    TAGGER_PATH: '#tagger-path',
    TAGGER_MODEL: '#tagger-model',
    TAGGER_THRESHOLD: '#tagger-threshold',
  },

  LOCALES: ['zh-CN', 'en-US'],
  DEFAULT_LOCALE: 'en-US',

  TIMING: {
    MONITOR_POLL_MS: 2000,
    TAGGER_POLL_MS: 1500,
    TAGGER_TIMEOUT_MS: 30000,
    HEALTH_CHECK_INTERVAL: 5000,
    FORM_SAVE_DEBOUNCE: 1000,
    FA_CACHE_TTL: 300,
  },

  PROGRESS_STAGES: [
    { duration: 300, max: 30 },
    { duration: 1700, max: 65 },
    { duration: Infinity, max: 90 }
  ],

  FILE_PICKER: {
    MODEL_FILE: { type: 'file', path: './sd-models', filter: '(.safetensors|.ckpt|.pt)' },
    MODEL_SAVED_FILE: { type: 'file', path: './output', filter: '(.safetensors|.ckpt|.pt)' },
    TRAIN_DIR: { type: 'folder', path: './train', filter: null },
  },

  LOG: {
    MAX_LINES: 5000,
  },
};

// ── 优化器默认参数（单一数据源）────────────────────────
// training-core.js (_OPT_PH) 和 training-toml.js (MERGED_RULES)
// 均引用此数据，避免重复定义导致不一致。
window.OPTIMIZER_DEFAULTS = {
  betas: {
    'AdamW': '0.9, 0.999', 'AdamW8bit': '0.9, 0.999', 'PagedAdamW8bit': '0.9, 0.999',
    'Lion': '0.9, 0.99', 'Lion8bit': '0.9, 0.99', 'PagedLion8bit': '0.9, 0.99',
    'pytorch_optimizer.CAME': '0.9, 0.999, 0.9999',
    'vendor.emo_optimizer.emosens.EmoSens': '0.9, 0.995',
  },
  eps: {
    'AdamW': '1e-8', 'AdamW8bit': '1e-8', 'PagedAdamW8bit': '1e-8',
    'pytorch_optimizer.CAME': '1e-16',
    'vendor.emo_optimizer.emosens.EmoSens': '1e-8',
  },
  weight_decay: { 'vendor.emo_optimizer.emosens.EmoSens': '0.01' },
  max_grad_norm: { 'vendor.emo_optimizer.emosens.EmoSens': '0' },
  stopcoef: { 'vendor.emo_optimizer.emosens.EmoSens': 0.04 },
  came_eps1: { 'pytorch_optimizer.CAME': '1e-30' },
  came_eps2: { 'pytorch_optimizer.CAME': '1e-16' },
  // NOTE: 以下字段仅用于 TOML 生成，无 placeholder 效果
  prodigy_d_coef: { 'Prodigy': '1.0', 'prodigyplus.ProdigyPlusScheduleFree': '1.0' },
  prodigy_d0: { 'Prodigy': '', 'prodigyplus.ProdigyPlusScheduleFree': '' },
  came_weight_decouple: { 'pytorch_optimizer.CAME': true },
  came_fixed_decay: { 'pytorch_optimizer.CAME': false },
  came_clip_threshold: { 'pytorch_optimizer.CAME': 1.0 },
  came_ams_bound: { 'pytorch_optimizer.CAME': false },
};
