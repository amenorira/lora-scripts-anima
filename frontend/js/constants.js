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
    MODEL_FILE: { type: 'file', path: './models', filter: '(.safetensors|.ckpt|.pt)' },
    MODEL_SAVED_FILE: { type: 'file', path: './output', filter: '(.safetensors|.ckpt|.pt)' },
    TRAIN_DIR: { type: 'folder', path: './train', filter: null },
  },

  LOG: {
    MAX_LINES: 5000,        // 内存环形缓冲上限（实时尾部 DOM 渲染行数）
    FULL_PAGE_SIZE: 1000,   // 「完整日志」模式每页拉取行数
    MAX_MATCHES: 5000,      // 后端单次搜索返回的匹配行号上限（对齐 _LOG_SLICE_MAX_MATCHES）
  },
};

// ── 优化器默认参数（单一数据源）────────────────────────
// training-core.js (_OPT_PH) 和 training-toml.js (MERGED_RULES)
// 均引用此数据，避免重复定义导致不一致。
window.OPTIMIZER_DEFAULTS = {
  learning_rate: {
    'AdamW': '1e-4', 'AdamW8bit': '1e-4', 'PagedAdamW8bit': '1e-4',
    'pytorch_optimizer.StableAdamW': '1e-4',
    'Lion': '2e-5', 'Lion8bit': '2e-5', 'PagedLion8bit': '2e-5',
    'Prodigy': '1.0', 'prodigyplus.ProdigyPlusScheduleFree': '1.0',
    'pytorch_optimizer.CAME': '1e-4', 'AdamWScheduleFree': '3e-4',
    'vendor.automagic_optimizer.integration.Automagic3': '1e-4',
  },
  automagic_min_lr: { 'vendor.automagic_optimizer.integration.Automagic3': 1e-8 },
  automagic_max_lr: { 'vendor.automagic_optimizer.integration.Automagic3': 1e3 },
  automagic_beta2: { 'vendor.automagic_optimizer.integration.Automagic3': 0.999 },
  automagic_clip_threshold: { 'vendor.automagic_optimizer.integration.Automagic3': 1.0 },
  automagic_polarity_history: { 'vendor.automagic_optimizer.integration.Automagic3': 8 },
  automagic_fused: { 'vendor.automagic_optimizer.integration.Automagic3': false },
  betas: {
    'AdamW': '0.9, 0.999', 'AdamW8bit': '0.9, 0.999', 'PagedAdamW8bit': '0.9, 0.999',
    'pytorch_optimizer.StableAdamW': '0.9, 0.99',
    'Lion': '0.9, 0.99', 'Lion8bit': '0.9, 0.99', 'PagedLion8bit': '0.9, 0.99',
    'pytorch_optimizer.CAME': '0.9, 0.999, 0.9999',
    'vendor.emo_optimizer.emosens.EmoSens': '0.9, 0.995',
    'AdamWScheduleFree': '0.9, 0.999',
    'Prodigy': '0.9, 0.999', 'prodigyplus.ProdigyPlusScheduleFree': '0.9, 0.99',
  },
  eps: {
    'AdamW': '1e-8', 'AdamW8bit': '1e-8', 'PagedAdamW8bit': '1e-8',
    'pytorch_optimizer.StableAdamW': '1e-8',
    'vendor.emo_optimizer.emosens.EmoSens': '1e-8',
    'vendor.automagic_optimizer.integration.Automagic3': '1e-30',
    'AdamWScheduleFree': '1e-8',
    'Prodigy': '1e-8', 'prodigyplus.ProdigyPlusScheduleFree': '1e-8',
  },
  weight_decay: {
    'AdamW': 0.01, 'AdamW8bit': 0.01, 'PagedAdamW8bit': 0.01,
    'pytorch_optimizer.StableAdamW': 0.01,
    'Lion': 0, 'Lion8bit': 0, 'PagedLion8bit': 0,
    'Prodigy': 0, 'prodigyplus.ProdigyPlusScheduleFree': 0,
    'AdaFactor': 0, 'pytorch_optimizer.CAME': 0, 'AdamWScheduleFree': 0,
    'vendor.automagic_optimizer.integration.Automagic3': 0,
    'vendor.emo_optimizer.emosens.EmoSens': 0.01,
  },
  stopcoef: { 'vendor.emo_optimizer.emosens.EmoSens': 0.04 },
  came_eps1: { 'pytorch_optimizer.CAME': '1e-30' },
  came_eps2: { 'pytorch_optimizer.CAME': '1e-16' },
  // NOTE: 以下字段仅用于 TOML 生成，无 placeholder 效果
  prodigy_d_coef: { 'Prodigy': '1.0', 'prodigyplus.ProdigyPlusScheduleFree': '1.0' },
  prodigy_d0: { 'Prodigy': '1e-6', 'prodigyplus.ProdigyPlusScheduleFree': '1e-6' },
  prodigy_safeguard_warmup: { 'Prodigy': false },
  prodigyplus_use_stableadamw: { 'prodigyplus.ProdigyPlusScheduleFree': true },
  schedulefree_warmup_steps: { 'AdamWScheduleFree': 0 },
  bnb_percentile_clipping: {
    'AdamW8bit': 100, 'PagedAdamW8bit': 100,
    'Lion8bit': 100, 'PagedLion8bit': 100,
  },
  bnb_min_8bit_size: {
    'AdamW8bit': 4096, 'PagedAdamW8bit': 4096,
    'Lion8bit': 4096, 'PagedLion8bit': 4096,
  },
  stableadamw_kahan_sum: { 'pytorch_optimizer.StableAdamW': true },
  stableadamw_weight_decouple: { 'pytorch_optimizer.StableAdamW': true },
  adafactor_relative_step: { 'AdaFactor': true },
  adafactor_scale_parameter: { 'AdaFactor': true },
  adafactor_warmup_init: { 'AdaFactor': false },
  adafactor_clip_threshold: { 'AdaFactor': 1.0 },
  adafactor_eps: { 'AdaFactor': '1e-30, 1e-3' },
  came_weight_decouple: { 'pytorch_optimizer.CAME': true },
  came_fixed_decay: { 'pytorch_optimizer.CAME': false },
  came_clip_threshold: { 'pytorch_optimizer.CAME': 1.0 },
  came_ams_bound: { 'pytorch_optimizer.CAME': false },
};

// Anima uses rank/alpha=32 by default and has model-specific low-LR guidance.
// These values are conservative starting points, not hard validation limits.
window.ANIMA_OPTIMIZER_LR_DEFAULTS = {
  'AdamW': '2e-5', 'AdamW8bit': '2e-5', 'PagedAdamW8bit': '2e-5',
  'pytorch_optimizer.StableAdamW': '2e-5',
  'Lion': '5e-6', 'Lion8bit': '5e-6', 'PagedLion8bit': '5e-6',
  'pytorch_optimizer.CAME': '1.5e-5', 'AdamWScheduleFree': '1e-4',
  'Prodigy': '1.0', 'prodigyplus.ProdigyPlusScheduleFree': '1.0',
  'vendor.automagic_optimizer.integration.Automagic3': '1e-4',
  'vendor.emo_optimizer.emosens.EmoSens': '0.1',
};
