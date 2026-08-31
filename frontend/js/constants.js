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
    'Muon': '1e-4',
    'pytorch_optimizer.Adan': '5e-5',
    'bitsandbytes.optim.AdEMAMix': '1e-4',
    'bitsandbytes.optim.AdEMAMix8bit': '1e-4',
    'vendor.lora_rite.lora_rite.LoRA_RITE': '1e-4',
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
    'pytorch_optimizer.Adan': '0.98, 0.92, 0.99',
    'bitsandbytes.optim.AdEMAMix': '0.9, 0.999, 0.9999',
    'bitsandbytes.optim.AdEMAMix8bit': '0.9, 0.999, 0.9999',
    'vendor.lora_rite.lora_rite.LoRA_RITE': '0.9, 0.999',
  },
  eps: {
    'AdamW': '1e-8', 'AdamW8bit': '1e-8', 'PagedAdamW8bit': '1e-8',
    'pytorch_optimizer.StableAdamW': '1e-8',
    'vendor.emo_optimizer.emosens.EmoSens': '1e-8',
    'vendor.automagic_optimizer.integration.Automagic3': '1e-30',
    'AdamWScheduleFree': '1e-8',
    'Prodigy': '1e-8', 'prodigyplus.ProdigyPlusScheduleFree': '1e-8',
    'Muon': '1e-7',
    'pytorch_optimizer.Adan': '1e-8',
    'bitsandbytes.optim.AdEMAMix': '1e-8',
    'bitsandbytes.optim.AdEMAMix8bit': '1e-8',
    'vendor.lora_rite.lora_rite.LoRA_RITE': '1e-6',
  },
  weight_decay: {
    'AdamW': 0.01, 'AdamW8bit': 0.01, 'PagedAdamW8bit': 0.01,
    'pytorch_optimizer.StableAdamW': 0.01,
    'Lion': 0, 'Lion8bit': 0, 'PagedLion8bit': 0,
    'Prodigy': 0, 'prodigyplus.ProdigyPlusScheduleFree': 0,
    'AdaFactor': 0, 'pytorch_optimizer.CAME': 0, 'AdamWScheduleFree': 0,
    'vendor.automagic_optimizer.integration.Automagic3': 0,
    'vendor.emo_optimizer.emosens.EmoSens': 0.01,
    // Muon must emit the product default 0 to override torch.optim.Muon's 0.1.
    'Muon': 0.1,
    'pytorch_optimizer.Adan': 0.01,
    'bitsandbytes.optim.AdEMAMix': 0.01,
    'bitsandbytes.optim.AdEMAMix8bit': 0.01,
    'vendor.lora_rite.lora_rite.LoRA_RITE': 0,
  },
  adan_weight_decouple: { 'pytorch_optimizer.Adan': true },
  ademamix_alpha: {
    'bitsandbytes.optim.AdEMAMix': 5.0, 'bitsandbytes.optim.AdEMAMix8bit': 5.0,
  },
  // 留空 = 启动时按预估总步数自动注入；0 = 关闭调度
  ademamix_t_alpha: {
    'bitsandbytes.optim.AdEMAMix': '', 'bitsandbytes.optim.AdEMAMix8bit': '',
  },
  ademamix_t_beta3: {
    'bitsandbytes.optim.AdEMAMix': '', 'bitsandbytes.optim.AdEMAMix8bit': '',
  },
  lorarite_clip_unmagnified_grad: { 'vendor.lora_rite.lora_rite.LoRA_RITE': 1.0 },
  muon_adjust_lr_fn: { 'Muon': 'match_rms_adamw' },
  muon_momentum: { 'Muon': 0.95 },
  muon_nesterov: { 'Muon': true },
  muon_ns_steps: { 'Muon': 5 },
  muon_ns_coefficients: { 'Muon': '3.4445, -4.775, 2.0315' },
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
