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
