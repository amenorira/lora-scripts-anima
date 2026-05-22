/* ================================================================
   lora-scripts-anima UI — Application Core
   SPA router · Theme engine (diffusion) · Training forms · API
   ================================================================ */

// ── Training Form Field Definitions ────────────────────────
const TRAIN_SECTIONS_COMMON = [
  {
    key: 'model', titleKey: 'section.model',
    fields: [
      { key: 'pretrained_model_name_or_path', type: 'text', default: './sd-models/model.safetensors', role: 'file-model', descKey: 'field.pretrained_model_name_or_path' },
      { key: 'vae', type: 'text', default: '', role: 'file-model', descKey: 'field.vae' },
      { key: 'resume', type: 'text', default: '', role: 'file-folder', descKey: 'field.resume' },
      { key: 'model_train_type', type: 'select', default: 'sd-lora', options: [
        { v: 'sd-lora', l: 'SD LoRA', dKey: 'opt.model_train_type_sd-lora' },
        { v: 'sdxl-lora', l: 'SDXL LoRA', dKey: 'opt.model_train_type_sdxl-lora' },
        { v: 'anima-lora', l: 'Anima LoRA', dKey: 'opt.model_train_type_anima-lora' },
        { v: 'flux-lora', l: 'Flux LoRA', dKey: 'opt.model_train_type_flux-lora' },
        { v: 'sd3-lora', l: 'SD3 LoRA', dKey: 'opt.model_train_type_sd3-lora' }
      ], descKey: 'field.model_train_type' },
    ]
  },
  {
    key: 'dataset', titleKey: 'section.dataset',
    fields: [
      { key: 'train_data_dir', type: 'text', default: './train/aki', role: 'file-folder', descKey: 'field.train_data_dir' },
      { key: 'reg_data_dir', type: 'text', default: '', role: 'file-folder', descKey: 'field.reg_data_dir' },
      { key: 'resolution', type: 'text', default: '1024,1024', descKey: 'field.resolution', hintKey: 'field.resolutionHint' },
      { key: 'prior_loss_weight', type: 'number', default: 1.0, step: 0.1, descKey: 'field.prior_loss_weight' },
      { key: 'enable_bucket', type: 'toggle', default: true, descKey: 'field.enable_bucket' },
      { key: 'bucket_no_upscale', type: 'toggle', default: true, descKey: 'field.bucket_no_upscale', showIf: { key: 'enable_bucket', eq: true } },
      { key: 'min_bucket_reso', type: 'number', default: 256, min: 64, step: 64, descKey: 'field.min_bucket_reso', showIf: { key: 'enable_bucket', eq: true } },
      { key: 'max_bucket_reso', type: 'number', default: 2048, min: 256, step: 64, descKey: 'field.max_bucket_reso', showIf: { key: 'enable_bucket', eq: true } },
      { key: 'bucket_reso_steps', type: 'number', default: 64, min: 16, step: 16, descKey: 'field.bucket_reso_steps', showIf: { key: 'enable_bucket', eq: true } },
    ]
  },
  {
    key: 'save', titleKey: 'section.save',
    fields: [
      { key: 'output_name', type: 'text', default: 'my_lora', descKey: 'field.output_name' },
      { key: 'output_dir', type: 'text', default: './output', role: 'file-folder', descKey: 'field.output_dir' },
      { key: 'save_model_as', type: 'select', default: 'safetensors', options: [
        { v: 'safetensors', l: 'safetensors', dKey: 'opt.save_model_as_safetensors' },
        { v: 'pt', l: 'pt', dKey: 'opt.save_model_as_pt' },
        { v: 'ckpt', l: 'ckpt', dKey: 'opt.save_model_as_ckpt' }
      ], descKey: 'field.save_model_as' },
      { key: 'save_precision', type: 'select', default: 'fp16', options: [
        { v: 'fp16', l: 'fp16', dKey: 'opt.save_precision_fp16' },
        { v: 'bf16', l: 'bf16', dKey: 'opt.save_precision_bf16' },
        { v: 'float', l: 'float', dKey: 'opt.save_precision_float' }
      ], descKey: 'field.save_precision' },
      { key: 'save_every_n_epochs', type: 'number', default: 2, min: 1, descKey: 'field.save_every_n_epochs' },
      { key: 'save_state', type: 'toggle', default: false, descKey: 'field.save_state' },
      { key: 'save_last_n_epochs_state', type: 'number', default: null, min: 1, descKey: 'field.save_last_n_epochs_state', showIf: { key: 'save_state', eq: true } },
    ]
  },
  {
    key: 'trainParams', titleKey: 'section.trainParams',
    fields: [
      { key: 'max_train_epochs', type: 'number', default: 10, min: 1, descKey: 'field.max_train_epochs' },
      { key: 'max_train_steps', type: 'number', default: null, min: 1, descKey: 'field.max_train_steps' },
      { key: 'train_batch_size', type: 'number', default: 1, min: 1, descKey: 'field.train_batch_size' },
      { key: 'gradient_accumulation_steps', type: 'number', default: 1, min: 1, descKey: 'field.gradient_accumulation_steps' },
      { key: 'gradient_checkpointing', type: 'toggle', default: false, descKey: 'field.gradient_checkpointing' },
      { key: 'network_train_unet_only', type: 'toggle', default: true, descKey: 'field.network_train_unet_only' },
      { key: 'network_train_text_encoder_only', type: 'toggle', default: false, descKey: 'field.network_train_text_encoder_only' },
    ]
  },
  {
    key: 'lrOptimizer', titleKey: 'section.lrOptimizer',
    fields: [
      { key: 'learning_rate', type: 'text', default: '1e-4', descKey: 'field.learning_rate' },
      { key: 'unet_lr', type: 'text', default: '1e-4', descKey: 'field.unet_lr' },
      { key: 'text_encoder_lr', type: 'text', default: '1e-5', descKey: 'field.text_encoder_lr' },
      { key: 'lr_scheduler', type: 'select', default: 'cosine_with_restarts', options: [
        { v: 'cosine_with_restarts', l: 'cosine_with_restarts', dKey: 'opt.lr_scheduler_cosine_with_restarts' },
        { v: 'cosine', l: 'cosine', dKey: 'opt.lr_scheduler_cosine' },
        { v: 'linear', l: 'linear', dKey: 'opt.lr_scheduler_linear' },
        { v: 'polynomial', l: 'polynomial', dKey: 'opt.lr_scheduler_polynomial' },
        { v: 'constant', l: 'constant', dKey: 'opt.lr_scheduler_constant' },
        { v: 'constant_with_warmup', l: 'constant_with_warmup', dKey: 'opt.lr_scheduler_constant_with_warmup' }
      ], descKey: 'field.lr_scheduler' },
      { key: 'lr_scheduler_num_cycles', type: 'number', default: 1, min: 1, descKey: 'field.lr_scheduler_num_cycles', showIf: { key: 'lr_scheduler', eq: 'cosine_with_restarts' } },
      { key: 'lr_warmup_steps', type: 'number', default: 0, min: 0, descKey: 'field.lr_warmup_steps' },
      { key: 'optimizer_type', type: 'select', default: 'AdamW8bit', groups: [
        { labelKey: 'opt.group_adamw', options: [
          { v: 'AdamW', l: 'AdamW', dKey: 'opt.optimizer_type_AdamW' },
          { v: 'AdamW8bit', l: 'AdamW8bit', dKey: 'opt.optimizer_type_AdamW8bit' },
          { v: 'PagedAdamW8bit', l: 'PagedAdamW8bit', dKey: 'opt.optimizer_type_PagedAdamW8bit' },
        ]},
        { labelKey: 'opt.group_lion', options: [
          { v: 'Lion', l: 'Lion', dKey: 'opt.optimizer_type_Lion' },
          { v: 'Lion8bit', l: 'Lion8bit', dKey: 'opt.optimizer_type_Lion8bit' },
          { v: 'PagedLion8bit', l: 'PagedLion8bit', dKey: 'opt.optimizer_type_PagedLion8bit' },
        ]},
        { labelKey: 'opt.group_sgd', options: [
          { v: 'SGDNesterov', l: 'SGDNesterov', dKey: 'opt.optimizer_type_SGDNesterov' },
          { v: 'SGDNesterov8bit', l: 'SGDNesterov8bit', dKey: 'opt.optimizer_type_SGDNesterov8bit' },
        ]},
        { labelKey: 'opt.group_adaptive', options: [
          { v: 'Prodigy', l: 'Prodigy', dKey: 'opt.optimizer_type_Prodigy' },
          { v: 'prodigyplus.ProdigyPlusScheduleFree', l: 'ProdigyPlus', dKey: 'opt.optimizer_type_ProdigyPlus' },
          { v: 'AdaFactor', l: 'AdaFactor', dKey: 'opt.optimizer_type_AdaFactor' },
          { v: 'RAdamScheduleFree', l: 'RAdamScheduleFree', dKey: 'opt.optimizer_type_RAdamScheduleFree' },
        ]},
        { labelKey: 'opt.group_dadapt', options: [
          { v: 'DAdaptation', l: 'DAdaptation', dKey: 'opt.optimizer_type_DAdaptation' },
          { v: 'DAdaptAdam', l: 'DAdaptAdam', dKey: 'opt.optimizer_type_DAdaptAdam' },
          { v: 'DAdaptAdaGrad', l: 'DAdaptAdaGrad', dKey: 'opt.optimizer_type_DAdaptAdaGrad' },
          { v: 'DAdaptAdanIP', l: 'DAdaptAdanIP', dKey: 'opt.optimizer_type_DAdaptAdanIP' },
          { v: 'DAdaptLion', l: 'DAdaptLion', dKey: 'opt.optimizer_type_DAdaptLion' },
          { v: 'DAdaptSGD', l: 'DAdaptSGD', dKey: 'opt.optimizer_type_DAdaptSGD' },
        ]},
        { labelKey: 'opt.group_other', options: [
          { v: 'pytorch_optimizer.CAME', l: 'CAME', dKey: 'opt.optimizer_type_CAME' },
        ]},
      ], descKey: 'field.optimizer_type' },
      { key: 'loss_type', type: 'select', default: '', options: [
        { v: '', l: 'Default', dKey: 'opt.loss_type_default' },
        { v: 'l1', l: 'l1', dKey: 'opt.loss_type_l1' },
        { v: 'l2', l: 'l2', dKey: 'opt.loss_type_l2' },
        { v: 'huber', l: 'huber', dKey: 'opt.loss_type_huber' },
        { v: 'smooth_l1', l: 'smooth_l1', dKey: 'opt.loss_type_smooth_l1' }
      ], descKey: 'field.loss_type' },
      { key: 'min_snr_gamma', type: 'number', default: null, step: 0.1, descKey: 'field.min_snr_gamma' },
      { key: 'weight_decay', type: 'number', default: null, step: 0.001, descKey: 'field.weight_decay' },
      { key: 'prodigy_d_coef', type: 'text', default: '2.0', descKey: 'field.prodigy_d_coef', showIf: { key: 'optimizer_type', eq: 'Prodigy' } },
      { key: 'prodigy_d0', type: 'text', default: '', descKey: 'field.prodigy_d0', showIf: { key: 'optimizer_type', eq: 'Prodigy' } },
      { key: 'optimizer_args_custom', type: 'textarea', default: '', descKey: 'field.optimizer_args_custom', hintKey: 'field.optimizer_args_customHint' },
    ]
  },
  {
    key: 'network', titleKey: 'section.network',
    fields: [
      { key: 'network_module', type: 'select', default: 'networks.lora', options: [
        { v: 'networks.lora', l: 'networks.lora', dKey: 'opt.network_module_networks.lora' },
        { v: 'networks.lora_anima', l: 'networks.lora_anima', dKey: 'opt.network_module_networks.lora_anima' },
        { v: 'lycoris.kohya', l: 'lycoris.kohya', dKey: 'opt.network_module_lycoris.kohya' }
      ], descKey: 'field.network_module' },
      { key: 'network_dim', type: 'number', default: 32, min: 1, max: 256, step: 8, descKey: 'field.network_dim' },
      { key: 'network_alpha', type: 'number', default: 32, min: 1, descKey: 'field.network_alpha' },
      { key: 'network_weights', type: 'text', default: '', role: 'file-model-saved', descKey: 'field.network_weights' },
      { key: 'network_dropout', type: 'number', default: 0, min: 0, max: 0.5, step: 0.01, descKey: 'field.network_dropout' },
      { key: 'scale_weight_norms', type: 'number', default: null, min: 0, step: 0.01, descKey: 'field.scale_weight_norms' },
      { key: 'enable_base_weight', type: 'toggle', default: false, descKey: 'field.enable_base_weight' },
      { key: 'base_weights', type: 'textarea', default: '', descKey: 'field.base_weights', showIf: { key: 'enable_base_weight', eq: true } },
      { key: 'base_weights_multiplier', type: 'textarea', default: '', descKey: 'field.base_weights_multiplier', showIf: { key: 'enable_base_weight', eq: true } },
      { key: 'enable_block_weights', type: 'toggle', default: false, descKey: 'field.enable_block_weights' },
      { key: 'down_lr_weight', type: 'text', default: '1,1,1,1,1,1,1,1,1,1,1,1', descKey: 'field.down_lr_weight', showIf: { key: 'enable_block_weights', eq: true } },
      { key: 'mid_lr_weight', type: 'text', default: '1', descKey: 'field.mid_lr_weight', showIf: { key: 'enable_block_weights', eq: true } },
      { key: 'up_lr_weight', type: 'text', default: '1,1,1,1,1,1,1,1,1,1,1,1', descKey: 'field.up_lr_weight', showIf: { key: 'enable_block_weights', eq: true } },
      { key: 'block_lr_zero_threshold', type: 'number', default: 0, step: 0.01, descKey: 'field.block_lr_zero_threshold', showIf: { key: 'enable_block_weights', eq: true } },
    ]
  },
  {
    key: 'caption', titleKey: 'section.caption',
    fields: [
      { key: 'caption_extension', type: 'text', default: '.txt', descKey: 'field.caption_extension' },
      { key: 'max_token_length', type: 'number', default: 255, min: 1, descKey: 'field.max_token_length' },
      { key: 'keep_tokens', type: 'number', default: 0, min: 0, max: 255, descKey: 'field.keep_tokens' },
      { key: 'shuffle_caption', type: 'toggle', default: true, descKey: 'field.shuffle_caption' },
      { key: 'weighted_captions', type: 'toggle', default: false, descKey: 'field.weighted_captions' },
      { key: 'caption_dropout_rate', type: 'number', default: null, min: 0, step: 0.01, descKey: 'field.caption_dropout_rate' },
      { key: 'caption_dropout_every_n_epochs', type: 'number', default: null, min: 0, max: 100, descKey: 'field.caption_dropout_every_n_epochs' },
      { key: 'caption_tag_dropout_rate', type: 'number', default: null, min: 0, step: 0.01, descKey: 'field.caption_tag_dropout_rate' },
    ]
  },
  {
    key: 'preview', titleKey: 'section.preview',
    fields: [
      { key: 'enable_preview', type: 'toggle', default: false, descKey: 'field.enable_preview' },
      { key: 'sample_prompts', type: 'textarea', default: '', descKey: 'field.sample_prompts', hintKey: 'field.sample_promptsHint', showIf: { key: 'enable_preview', eq: true } },
      { key: 'sample_sampler', type: 'select', default: 'euler_a', options: [
        { v: 'ddim', l: 'ddim', dKey: 'opt.sample_sampler_ddim' },
        { v: 'euler', l: 'euler', dKey: 'opt.sample_sampler_euler' },
        { v: 'euler_a', l: 'euler_a', dKey: 'opt.sample_sampler_euler_a' },
        { v: 'heun', l: 'heun', dKey: 'opt.sample_sampler_heun' },
        { v: 'dpmsolver', l: 'dpmsolver', dKey: 'opt.sample_sampler_dpmsolver' },
        { v: 'dpmsolver++', l: 'dpmsolver++', dKey: 'opt.sample_sampler_dpmsolver++' },
      ], descKey: 'field.sample_sampler', showIf: { key: 'enable_preview', eq: true } },
      { key: 'sample_every_n_epochs', type: 'number', default: 2, min: 1, descKey: 'field.sample_every_n_epochs', showIf: { key: 'enable_preview', eq: true } },
      { key: 'sample_cfg', type: 'number', default: 7, min: 1, max: 30, descKey: 'field.sample_cfg', showIf: { key: 'enable_preview', eq: true } },
    ]
  },
  {
    key: 'speed', titleKey: 'section.speed',
    fields: [
      { key: 'mixed_precision', type: 'select', default: 'bf16', options: [
        { v: 'bf16', l: 'bf16', dKey: 'opt.mixed_precision_bf16' },
        { v: 'fp16', l: 'fp16', dKey: 'opt.mixed_precision_fp16' },
        { v: 'no', l: 'no', dKey: 'opt.mixed_precision_no' }
      ], descKey: 'field.mixed_precision' },
      { key: 'xformers', type: 'toggle', default: true, descKey: 'field.xformers' },
      { key: 'sdpa', type: 'toggle', default: false, descKey: 'field.sdpa' },
      { key: 'cache_latents', type: 'toggle', default: true, descKey: 'field.cache_latents' },
      { key: 'cache_latents_to_disk', type: 'toggle', default: true, descKey: 'field.cache_latents_to_disk' },
      { key: 'cache_text_encoder_outputs', type: 'toggle', default: false, descKey: 'field.cache_text_encoder_outputs' },
      { key: 'cache_text_encoder_outputs_to_disk', type: 'toggle', default: false, descKey: 'field.cache_text_encoder_outputs_to_disk' },
      { key: 'no_half_vae', type: 'toggle', default: false, descKey: 'field.no_half_vae' },
      { key: 'lowram', type: 'toggle', default: false, descKey: 'field.lowram' },
      { key: 'full_fp16', type: 'toggle', default: false, descKey: 'field.full_fp16' },
      { key: 'full_bf16', type: 'toggle', default: false, descKey: 'field.full_bf16' },
      { key: 'persistent_data_loader_workers', type: 'toggle', default: true, descKey: 'field.persistent_data_loader_workers' },
      { key: 'vae_batch_size', type: 'number', default: null, min: 1, descKey: 'field.vae_batch_size' },
    ]
  },
  {
    key: 'other', titleKey: 'section.other',
    fields: [
      { key: 'seed', type: 'number', default: 1337, descKey: 'field.seed' },
      { key: 'clip_skip', type: 'stepper', default: 2, min: 0, max: 12, step: 1, descKey: 'field.clip_skip' },
      { key: 'ui_custom_params', type: 'textarea', default: '', descKey: 'field.ui_custom_params' },
    ]
  },
];

const TRAIN_SECTIONS_ANIMA = [
  {
    key: 'animaParams', titleKey: 'section.animaParams',
    fields: [
      { key: 'qwen3', type: 'text', default: '', role: 'file-model', descKey: 'field.qwen3' },
      { key: 'timestep_sampling', type: 'select', default: 'sigmoid', options: [
        { v: 'sigma', l: 'sigma', dKey: 'opt.timestep_sampling_sigma' },
        { v: 'uniform', l: 'uniform', dKey: 'opt.timestep_sampling_uniform' },
        { v: 'sigmoid', l: 'sigmoid', dKey: 'opt.timestep_sampling_sigmoid' },
        { v: 'shift', l: 'shift', dKey: 'opt.timestep_sampling_shift' },
        { v: 'flux_shift', l: 'flux_shift', dKey: 'opt.timestep_sampling_flux_shift' }
      ], descKey: 'field.timestep_sampling' },
      { key: 'sigmoid_scale', type: 'number', default: 1.0, step: 0.001, descKey: 'field.sigmoid_scale' },
      { key: 'weighting_scheme', type: 'select', default: 'uniform', options: [
        { v: 'sigma_sqrt', l: 'sigma_sqrt', dKey: 'opt.weighting_scheme_sigma_sqrt' },
        { v: 'logit_normal', l: 'logit_normal', dKey: 'opt.weighting_scheme_logit_normal' },
        { v: 'mode', l: 'mode', dKey: 'opt.weighting_scheme_mode' },
        { v: 'cosmap', l: 'cosmap', dKey: 'opt.weighting_scheme_cosmap' },
        { v: 'none', l: 'none', dKey: 'opt.weighting_scheme_none' },
        { v: 'uniform', l: 'uniform', dKey: 'opt.weighting_scheme_uniform' }
      ], descKey: 'field.weighting_scheme' },
      { key: 'logit_mean', type: 'number', default: 0.0, step: 0.01, descKey: 'field.logit_mean' },
      { key: 'logit_std', type: 'number', default: 1.0, step: 0.01, descKey: 'field.logit_std' },
      { key: 'qwen3_max_token_length', type: 'number', default: 512, step: 1, descKey: 'field.qwen3_max_token_length' },
      { key: 't5_max_token_length', type: 'number', default: 512, step: 1, descKey: 'field.t5_max_token_length' },
      { key: 'attn_mode', type: 'select', default: 'torch', options: [
        { v: 'torch', l: 'torch', dKey: 'opt.attn_mode_torch' },
        { v: 'xformers', l: 'xformers', dKey: 'opt.attn_mode_xformers' },
        { v: 'flash', l: 'flash', dKey: 'opt.attn_mode_flash' }
      ], descKey: 'field.attn_mode' },
      { key: 'split_attn', type: 'toggle', default: false, descKey: 'field.split_attn' },
      { key: 'torch_compile', type: 'toggle', default: false, descKey: 'field.torch_compile' },
    ]
  },
];

const ROUTE_CONFIG = {
  'home': { title: 'lora-scripts-anima', subtitle: '' },
  'monitor-dashboard': { titleKey: 'nav.monitorDashboard', subtitle: '' },
  'monitor-logs': { titleKey: 'nav.monitorLogs', subtitle: '' },
  'history': { titleKey: 'nav.history', subtitle: '' },
  'train-basic': { titleKey: 'nav.basic', subtitleKey: 'section.trainParams', trainType: 'sd-lora' },
  'train-master': { titleKey: 'nav.master', subtitleKey: 'section.trainParams', trainType: 'sd-lora' },
  'train-anima': { titleKey: 'nav.anima', subtitleKey: 'section.animaParams', trainType: 'anima-lora', extraSections: true },
  'train-flux': { titleKey: 'nav.flux', subtitleKey: 'section.trainParams', trainType: 'flux-lora' },
  'train-sd3': { titleKey: 'nav.sd3', subtitleKey: 'section.trainParams', trainType: 'sd3-lora' },
  'tensorboard': { titleKey: 'nav.tensorboard', subtitle: '' },
  'tagger': { titleKey: 'tagger.title', subtitleKey: 'tagger.subtitle' },
  'tagEditor': { titleKey: 'tagEditor.title', subtitleKey: 'tagEditor.subtitle' },
  'tools': { titleKey: 'tools.title', subtitleKey: 'tools.subtitle' },
  'tool-params': { titleKey: 'paramRef.title', subtitleKey: 'paramRef.subtitle' },
  'settings': { titleKey: 'settings.title', subtitleKey: 'settings.subtitle' },
  'about': { titleKey: 'about.title', subtitleKey: 'about.subtitle' },
};

// ── Alpine App ─────────────────────────────────────────────
document.addEventListener('alpine:init', () => {

  // ── Anima Custom Select Component ───────────────────────
  // Reusable Alpine.data: replaces native <select> with a polished 2026-style dropdown.
  // Supports option groups, per-option tooltip descriptions, and trigger tooltip.
  // Usage: x-data="animaSelect(fieldConfig, initialValue)"
  Alpine.data('animaSelect', (fieldConfigJson, initialValue) => ({
    open: false,
    value: initialValue,
    hoveredIdx: -1,
    hoveredOpt: null,
    showTriggerTip: false,
    triggerTipTimer: null,
    _escHandler: null,
    _tipLeft: null,
    _tipTop: null,
    _tipMaxW: 260,

    // Derived: uniform groups array (always produces [{label, options}, ...])
    get displayGroups() {
      try {
        // fieldConfigJson is base64-encoded JSON (from escJson)
        const json = typeof fieldConfigJson === 'string'
          ? decodeURIComponent(escape(atob(fieldConfigJson)))
          : JSON.stringify(fieldConfigJson || {});
        const fc = typeof json === 'string' ? JSON.parse(json) : json;
        if (fc.groups && fc.groups.length) return fc.groups;
        if (fc.options && fc.options.length) return [{ label: '', options: fc.options }];
      } catch (e) {
        console.warn('[animaSelect] Failed to parse field config:', e);
      }
      return [];
    },

    // Flattened list of all options (for finding selected desc, etc.)
    get flatOptions() {
      const result = [];
      this.displayGroups.forEach(g => {
        (g.options || []).forEach(o => result.push(o));
      });
      return result;
    },

    get selectedLabel() {
      const opt = this.flatOptions.find(o => o.v === this.value);
      return opt ? opt.l : String(this.value || '');
    },

    get selectedDesc() {
      const opt = this.flatOptions.find(o => o.v === this.value);
      return opt ? (opt.d || '') : '';
    },

    // Init: the initialValue already carries the correct form value.
    // The hidden input x-model syncs write-backs; external changes trigger
    // a full form re-render, so no watcher is needed.
    init() {
      this._escHandler = (e) => {
        if (e.key === 'Escape' && this.open) { this.open = false; }
      };
      document.addEventListener('keydown', this._escHandler);
    },

    // Alpine calls destroy() when the component is removed from DOM
    destroy() {
      if (this._escHandler) {
        document.removeEventListener('keydown', this._escHandler);
      }
      clearTimeout(this.triggerTipTimer);
    },

    // Click outside to close
    closeOnOutside() {
      this.open = false;
    },

    select(v) {
      this.value = v;
      this.open = false;
      this.syncToModel();
      this.$dispatch('anima-select-change', { value: v });
    },

    syncToModel() {
      const input = this.$refs.modelInput;
      if (input) {
        input.value = this.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    },

    onTriggerMouseEnter() {
      this.triggerTipTimer = setTimeout(() => {
        // Capture button rect BEFORE showing tooltip, so there's no flicker
        const btn = this.$refs.triggerBtn;
        if (btn) {
          const r = btn.getBoundingClientRect();
          this._tipLeft = r.right + 10;
          this._tipTop = r.top + r.height / 2;
          this._tipMaxW = Math.min(260, window.innerWidth - r.right - 24);
        }
        this.showTriggerTip = true;
      }, 400);
    },

    onTriggerMouseLeave() {
      clearTimeout(this.triggerTipTimer);
      this.showTriggerTip = false;
      this._tipLeft = null;
      this._tipTop = null;
    },

    onOptionMouseEnter(idx, opt) {
      this.hoveredIdx = idx;
      this.hoveredOpt = opt;
    },

    onOptionMouseLeave() {
      this.hoveredIdx = -1;
      this.hoveredOpt = null;
    },

    // Toggle open: reset hovered when opening
    toggle() {
      this.open = !this.open;
      if (!this.open) {
        this.hoveredIdx = -1;
        this.hoveredOpt = null;
      }
    },

    // Fixed-position style for trigger tooltip (escapes ancestor overflow clipping)
    get triggerTipStyle() {
      if (!this.showTriggerTip || this.open || !this.selectedDesc || !this._tipLeft) return { display: 'none' };
      return {
        position: 'fixed',
        left: this._tipLeft + 'px',
        top: this._tipTop + 'px',
        transform: 'translateY(-50%)',
        maxWidth: (this._tipMaxW || 260) + 'px',
        zIndex: '9999',
      };
    },
  }));

  Alpine.data('animaApp', () => ({

    // ── State ──────────────────────────────────────────────
    version: '...',
    theme: 'auto',
    resolvedTheme: 'light',
    currentRoute: 'home',
    pageTitle: 'lora-scripts-anima',
    pageSubtitle: '',
    locale: 'zh-CN',
    i18nReady: true,
    showThemeDropdown: false,
    showLangDropdown: false,
    showMainScroll: false,

    // Form state
    form: {},
    formDefaults: {},
    formHistory: [],
    formHistoryIdx: -1,

    // Right panel
    tomlRaw: '',
    tomlHighlighted: '',

    // Training status
    isTraining: false,
    isIdle: true,
    taskId: null,
    statusText: 'Idle',

    // UI Settings
    autoLoadHistory: true,
    settingsTbUrl: '',
    showLoadModal: false,
    savedConfigs: [],

    // TB
    tbHost: '127.0.0.1',
    tbPort: '6006',

    // Tagger
    taggerRunning: false,

    // ── Tag Editor state ──────────────────────────────────
    tagEditorDir: '',
    tagEditorImages: [],
    tagEditorOriginal: {},
    tagEditorModified: false,
    tagEditorDirName: '',

    // ── Monitor state ────────────────────────────────────
    monitorData: null,
    monitorTimer: null,
    monitorPollMs: 2000,
    gpuInfo: null,
    sysInfo: null,
    lossSeries: [],
    trainParams: [],
    previews: [],
    historyItems: [],
    logAutoScroll: true,
    logLines: [],
    logMaxLines: 5000,

    get tensorboardUrl() {
      let url = `http://${this.tbHost}:${this.tbPort}`;
      // Pass dark mode preference to TensorBoard's own UI
      if (this.resolvedTheme === 'dark') url += '?darkMode=true';
      return url;
    },

    // ── Init ───────────────────────────────────────────────
    async init() {
      // Set route IMMEDIATELY to avoid flash of wrong page
      let route = (window.location.hash || '#home').replace('#', '');
      if (!ROUTE_CONFIG[route]) route = 'home';
      this.currentRoute = route;
      const cfg = ROUTE_CONFIG[route];
      this.pageTitle = cfg.titleKey ? (this.t(cfg.titleKey) || cfg.title || route) : (cfg.title || route);
      this.pageSubtitle = cfg.subtitleKey ? (this.t(cfg.subtitleKey) || cfg.subtitle || '') : (cfg.subtitle || '');
      document.title = this.pageTitle + ' | lora-scripts-anima';

      // Git version
      try {
        const r = await fetch('/api/version');
        const d = await r.json();
        if (d.status === 'success') this.version = d.data.version;
        else this.version = 'dev';
      } catch (e) { this.version = 'dev'; }

      // Theme
      this.theme = localStorage.getItem('anima-theme') || 'auto';
      this.resolveTheme();

      // Locale — read from localStorage (all locales preloaded synchronously)
      I18N.init();
      this.locale = I18N.getLocale();

      // UI settings
      this.loadUISettings();

      // Route
      this.handleRoute();
      window.addEventListener('hashchange', () => this.handleRoute());
      window.addEventListener('locale-changed', () => {
        this.locale = I18N.getLocale();
        // Force full rebuild: sidebar x-text + page title + route content
        const r = this.currentRoute;
        const cfg = ROUTE_CONFIG[r] || {};
        if (cfg.titleKey) this.pageTitle = this.t(cfg.titleKey) || cfg.title || r;
        else this.pageTitle = cfg.title || r;
        if (cfg.subtitleKey) this.pageSubtitle = this.t(cfg.subtitleKey) || cfg.subtitle || '';
        else this.pageSubtitle = cfg.subtitle || '';
        document.title = this.pageTitle + ' | lora-scripts-anima';
        this.buildRouteContent();
      });

      // Close dropdowns when clicking outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.sidebar-dropdown')) {
          this.showThemeDropdown = false;
          this.showLangDropdown = false;
        }
      });

      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.theme === 'auto') this.resolveTheme();
      });

      this.buildRouteContent();

      if (this.autoLoadHistory) {
        setTimeout(() => this.autoLoadLastParams(), 500);
      }

      document.title = this.pageTitle + ' | lora-scripts-anima';
    },

    // ── Theme with diffusion animation ──────────────────────
    resolveTheme() {
      if (this.theme === 'auto') {
        this.resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } else {
        this.resolvedTheme = this.theme;
      }
      document.documentElement.setAttribute('data-theme', this.resolvedTheme);
    },

    setTheme(t) {
      // Only skip if clicking the already-active explicit theme
      if (this.theme === t) return;
      this.theme = t;
      this.showThemeDropdown = false;

      const apply = () => {
        this.resolveTheme();
        localStorage.setItem('anima-theme', t);
      };

      // View Transition API: browser captures old/new states and crossfades.
      // Guarantees every pixel transitions in perfect sync (Chrome 111+, Edge 111+).
      // Falls back to instant switch on Firefox / Safari.
      if (document.startViewTransition) {
        document.startViewTransition(() => apply());
      } else {
        apply();
      }
    },

    toggleTheme() {
      this.setTheme(this.resolvedTheme === 'dark' ? 'light' : 'dark');
    },

    themeLabel() {
      if (this.resolvedTheme === 'dark') return this.t('common.themeLight');
      return this.t('common.themeDark');
    },

    // ── Main content scroll (shows custom scrollbar on scroll) ──
    onContentScroll() {
      this.showMainScroll = true;
      clearTimeout(this._scrollTimer);
      this._scrollTimer = setTimeout(() => { this.showMainScroll = false; }, 1000);
    },

    // ── Routing ─────────────────────────────────────────────
    navigate(route) {
      window.location.hash = route;
      this.handleRoute();
    },

    handleRoute() {
      let route = (window.location.hash || '#home').replace('#', '');
      if (!ROUTE_CONFIG[route]) route = 'home';

      const prev = this.currentRoute;
      this.currentRoute = route;

      const cfg = ROUTE_CONFIG[route];
      if (cfg.titleKey) this.pageTitle = this.t(cfg.titleKey) || cfg.title || route;
      else this.pageTitle = cfg.title || route;
      if (cfg.subtitleKey) this.pageSubtitle = this.t(cfg.subtitleKey) || cfg.subtitle || '';
      else this.pageSubtitle = cfg.subtitle || '';
      document.title = this.pageTitle + ' | lora-scripts-anima';

      if (route !== prev) {
        this.buildRouteContent();
      }

      this.showLoadModal = false;
    },

    showRightPanel() {
      const r = this.currentRoute;
      return r && (r.startsWith('train-') || r === 'tools');
    },

    // ── Route Content Builder ───────────────────────────────
    buildRouteContent() {
      const r = this.currentRoute;
      // Stop previous monitor polling when switching away
      if (!r.startsWith('monitor-')) this.stopMonitorPolling();
      if (r && r.startsWith('train-')) {
        this.buildTrainForm();
      } else if (r === 'tensorboard') {
        this.loadTbConfig();
      } else if (r === 'tagger') {
        this.buildTaggerForm();
      } else if (r === 'tagEditor') {
        this.tagEditorLoad();
      } else if (r === 'settings') {
        this.loadUISettings();
      } else if (r === 'monitor-dashboard') {
        this.startMonitorPolling();
        this.renderDashboard();
      } else if (r === 'monitor-logs') {
        this.startMonitorPolling();
        this.renderLogs();
      } else if (r === 'history') {
        this.loadHistory();
      }
    },

    // ═══════════════════════════════════════════════════════
    //  Monitor — Shared
    // ═══════════════════════════════════════════════════════

    startMonitorPolling() {
      this.stopMonitorPolling();
      this.fetchMonitorStatus();
      this.monitorTimer = setInterval(() => this.fetchMonitorStatus(), this.monitorPollMs);
    },

    stopMonitorPolling() {
      if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    },

    async fetchMonitorStatus() {
      try {
        const tid = this.taskId || '';
        const r = await fetch('/api/monitor/status?task_id=' + encodeURIComponent(tid));
        const j = await r.json();
        if (j.status === 'success') {
          this.monitorData = j.data;
          this.gpuInfo = j.data.gpu;
          this.sysInfo = j.data.system;
          this.lossSeries = j.data.tensorboard_loss || [];
          this.trainParams = j.data.train_params || [];
          this.previews = j.data.previews || [];
          if (j.data.state === '训练中') {
            this.isTraining = true; this.isIdle = false; this.statusText = j.data.state;
          } else if (j.data.state === '空闲') {
            this.isTraining = false; this.isIdle = true; this.statusText = 'Idle';
          }
          if (this.currentRoute === 'monitor-dashboard') this.renderDashboard();
        }
      } catch (e) { /* silent poll */ }
    },

    // ═══════════════════════════════════════════════════════
    //  Monitor — Dashboard
    // ═══════════════════════════════════════════════════════

    renderDashboard() {
      const el = document.getElementById('monitorDashboard');
      if (!el) return;
      const d = this.monitorData || {};
      const gpu = this.gpuInfo;
      const sys = this.sysInfo;
      const t = (k, fb) => this.t('monitor.' + k) || fb || k;

      let html = '<div class="monitor-dashboard">';

      // ── Row 1: system resource cards (always visible) ──
      html += '<div class="monitor-row">';
      html += this._statusCard(d, t);
      if (sys) html += this._systemCard(sys, t);
      if (gpu) html += this._gpuCard(gpu, t);
      html += '</div>';

      // ── Row 2: Training Params (show if exists) ──
      html += '<div class="card" style="margin-top:12px"><div class="card-header">' + t('trainParams', '训练参数') + '</div>';
      if (this.trainParams.length) {
        html += '<div class="param-grid">';
        this.trainParams.forEach(p => {
          html += `<div class="param-item"><span class="param-label">${p.label}</span><span class="param-value">${p.value}</span></div>`;
        });
        html += '</div>';
      } else {
        html += '<div style="text-align:center;padding:20px;color:var(--text-tertiary);font-size:12px">' + t('noTrainingHint', '启动训练后显示') + '</div>';
      }
      html += '</div>';

      // ── Row 3: Loss / LR Charts (always show panels) ──
      html += '<div class="card" style="margin-top:12px"><div class="card-header">' + t('lossCurve', 'Loss / LR 曲线') + '</div>';
      html += '<div class="chart-grid">';
      const chartTags = this.lossSeries.length ? this.lossSeries : [
        { tag: 'loss/average', name: 'loss average', latest: null, points: [] },
        { tag: 'loss/current', name: 'loss current', latest: null, points: [] },
        { tag: 'loss/epoch_average', name: 'loss epoch average', latest: null, points: [] },
        { tag: 'lr/unet', name: 'lr unet', latest: null, points: [] },
      ];
      chartTags.forEach(s => {
        html += `<div class="chart-panel"><div class="chart-title">${s.name} <span class="chart-val">${s.latest != null ? s.latest.toFixed(4) : '--'}</span></div>`;
        html += `<canvas id="chart-${s.tag.replace(/[/.]/g,'-')}" width="360" height="200"></canvas></div>`;
      });
      html += '</div></div>';

      // ── Row 4: Previews (always show panel) ──
      html += '<div class="card" style="margin-top:12px"><div class="card-header">' + t('previewSamples', '预览样本') + '</div>';
      if (this.previews.length) {
        html += '<div class="preview-grid">';
        this.previews.forEach(p => {
          html += `<div class="preview-item"><img src="${p.url}" alt="${p.name}" loading="lazy" onclick="window.open('${p.url}')"/><span>${p.name}</span></div>`;
        });
        html += '</div>';
      } else {
        html += '<div style="text-align:center;padding:20px;color:var(--text-tertiary);font-size:12px">' + t('noTrainingHint', '启动训练后显示') + '</div>';
      }
      html += '</div>';

      html += '</div>';
      el.innerHTML = html;
      setTimeout(() => this._drawCharts(), 100);
    },

    _statusCard(d, t) {
      const state = d.state || '空闲';
      const isTraining = state === '训练中';
      const color = isTraining ? 'var(--success)' : (d.has_error ? 'var(--danger)' : 'var(--text-secondary)');
      let html = `<div class="card flex-1">
        <div class="card-header">${t('status', '训练状态')}</div>
        <div style="font-size:20px;font-weight:700;color:${color};margin:8px 0">${state}</div>`;
      if (isTraining) {
        if (d.step) html += `<div>${t('step', '步数')}: <b>${d.step}</b> / ${d.total_steps} (${d.percent}%)</div>`;
        if (d.loss) html += `<div>${t('loss', 'Loss')}: <b>${d.loss}</b></div>`;
        if (d.lr) html += `<div>${t('lr', '学习率')}: <b>${d.lr}</b></div>`;
        if (d.epoch) html += `<div>${t('epoch', 'Epoch')}: <b>${d.epoch}</b></div>`;
        if (d.speed) html += `<div>${t('speed', '速度')}: <b>${d.speed}</b></div>`;
        if (d.eta) html += `<div>ETA: <b>${d.eta}</b></div>`;
      }
      if (d.has_error) html += `<div style="color:var(--danger);margin-top:8px">${d.error_msg || t('error', '训练异常')}</div>`;
      html += '</div>';
      return html;
    },

    _gpuCard(gpu, t) {
      const pct = gpu.vram_total_mb > 0 ? gpu.vram_used_mb / gpu.vram_total_mb * 100 : 0;
      const color = pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--success)';
      let html = `<div class="card flex-1" style="margin-left:12px">
        <div class="card-header">${t('gpu', 'GPU 监控')}</div>
        <div style="font-size:14px;font-weight:600;margin:4px 0">${gpu.name || 'NVIDIA GPU'}</div>`;
      html += `<div style="font-size:12px">${t('vramUsed', '显存')}: <b style="color:${color}">${gpu.vram_used_mb} MB</b> / ${gpu.vram_total_mb} MB</div>`;
      html += `<div style="font-size:12px">${t('gpuLoad', '负载')}: <b>${gpu.gpu_load_pct}%</b></div>`;
      if (gpu.temperature_c != null) html += `<div style="font-size:12px">${t('gpuTemp', '温度')}: <b>${gpu.temperature_c}°C</b></div>`;
      if (gpu.power_w != null) html += `<div style="font-size:12px">${t('gpuPower', '功耗')}: <b>${gpu.power_w}W</b></div>`;
      html += `<div style="margin-top:6px;background:var(--bg-input);border-radius:4px;height:6px"><div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.5s"></div></div>`;
      html += '</div>';
      return html;
    },

    _systemCard(sys, t) {
      const cpuColor = sys.cpu_pct > 80 ? 'var(--danger)' : sys.cpu_pct > 50 ? 'var(--warning)' : 'var(--success)';
      const ramColor = sys.ram_pct > 80 ? 'var(--danger)' : sys.ram_pct > 50 ? 'var(--warning)' : 'var(--success)';
      let html = `<div class="card flex-1" style="margin-left:12px">
        <div class="card-header">${t('system', '系统资源')}</div>`;
      html += `<div style="font-size:12px;margin:4px 0">${t('cpu', 'CPU')}: <b style="color:${cpuColor}">${sys.cpu_pct}%</b></div>`;
      html += `<div style="margin-top:4px;background:var(--bg-input);border-radius:4px;height:4px"><div style="width:${sys.cpu_pct}%;height:100%;background:${cpuColor};border-radius:4px;transition:width 0.5s"></div></div>`;
      html += `<div style="font-size:12px;margin:8px 0 4px">${t('ram', '内存')}: <b style="color:${ramColor}">${sys.ram_used_gb} GB</b> / ${sys.ram_total_gb} GB</div>`;
      html += `<div style="margin-top:4px;background:var(--bg-input);border-radius:4px;height:4px"><div style="width:${sys.ram_pct}%;height:100%;background:${ramColor};border-radius:4px;transition:width 0.5s"></div></div>`;
      html += '</div>';
      return html;
    },

    _drawCharts() {
      this.lossSeries.forEach(s => {
        const id = 'chart-' + s.tag.replace(/[/.]/g, '-');
        const c = document.getElementById(id);
        if (!c || !s.points || s.points.length < 2) return;
        const ctx = c.getContext('2d');
        const W = c.width, H = c.height;
        ctx.clearRect(0, 0, W, H);

        const xs = s.points.map(p => p.step);
        const ys = s.points.map(p => p.value);
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        const yMin = Math.min(...ys), yMax = Math.max(...ys);
        const pad = { t: 16, r: 16, b: 28, l: 48 };
        const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;

        const sx = (x) => pad.l + (x - xMin) / (xMax - xMin || 1) * pw;
        const sy = (y) => pad.t + (yMax - y) / (yMax - yMin || 1) * ph;

        // Grid
        ctx.strokeStyle = 'var(--border-color, #333)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 4; i++) {
          const y = pad.t + i * ph / 4;
          ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
          ctx.fillStyle = 'var(--text-tertiary, #888)';
          ctx.font = '10px monospace';
          ctx.fillText((yMax - i * (yMax - yMin) / 4).toFixed(4), 2, y + 3);
        }

        // Line
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        s.points.forEach((p, i) => {
          const x = sx(p.step), y = sy(p.value);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Last value dot
        const last = s.points[s.points.length - 1];
        ctx.fillStyle = '#8b5cf6';
        ctx.beginPath();
        ctx.arc(sx(last.step), sy(last.value), 4, 0, Math.PI * 2);
        ctx.fill();
      });
    },

    // ═══════════════════════════════════════════════════════
    //  Monitor — Logs
    // ═══════════════════════════════════════════════════════

    renderLogs() {
      const el = document.getElementById('monitorLogs');
      if (!el) return;
      const t = (k, fb) => this.t('monitor.' + k) || fb || k;
      if (!this.logLines.length) {
        el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-tertiary)"><p>'+t('noTrainingHint','No logs yet')+'</p></div>';
        return;
      }
      let html = '<div class="log-lines">';
      this.logLines.forEach(line => {
        const lower = line.toLowerCase();
        const cls = lower.includes('error') || lower.includes('traceback') ? 'log-error' :
                    lower.includes('warning') ? 'log-warn' : '';
        html += `<div class="log-line ${cls}">${this._escapeHtml(line)}</div>`;
      });
      html += '</div>';
      el.innerHTML = html;
      if (this.logAutoScroll) el.scrollTop = el.scrollHeight;
    },

    copyLogs() {
      const text = this.logLines.join('\n');
      navigator.clipboard.writeText(text).then(() => alert('已复制到剪贴板'));
    },

    clearLogs() { this.logLines = []; this.renderLogs(); },

    _escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    },

    // ═══════════════════════════════════════════════════════
    //  Monitor — History
    // ═══════════════════════════════════════════════════════

    async loadHistory() {
      try {
        const r = await fetch('/api/monitor/history');
        const j = await r.json();
        if (j.status === 'success') {
          this.historyItems = j.data || [];
          this.renderHistory();
        }
      } catch (e) {
        console.warn('Failed to load history:', e);
      }
    },

    renderHistory() {
      const el = document.getElementById('historyList');
      if (!el) return;
      if (!this.historyItems.length) {
        el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-tertiary)"><p>'+t('noTrainingHint','No training history')+'</p><p style="font-size:12px">'+t('noTrainingHint','Records will appear after training')+'</p></div>';
        return;
      }
      let html = '<div class="history-grid">';
      this.historyItems.forEach(h => {
        html += `<div class="card history-card">
          <div class="card-header">${h.time}</div>
          <div><b>${h.name}</b></div>
          <div style="font-size:12px;color:var(--text-secondary)">模型: ${h.model}</div>
          <div style="font-size:12px;color:var(--text-secondary)">LR: ${h.lr} · Dim: ${h.dim} · Epochs: ${h.epochs}</div>
          <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px">${h.config_file}</div>
        </div>`;
      });
      html += '</div>';
      el.innerHTML = html;
    },

    // ═══════════════════════════════════════════════════════
    //  Tag Editor (native, replaces Gradio iframe)
    // ═══════════════════════════════════════════════════════

    async tagEditorLoad(dir) {
      const d = dir || this.tagEditorDir || this.form?.train_data_dir || './train/aki';
      this.tagEditorDir = d;
      try {
        const r = await fetch('/api/tageditor/images?dir=' + encodeURIComponent(d));
        const j = await r.json();
        if (j.status === 'success') {
          this.tagEditorImages = j.data.images || [];
          this.tagEditorDirName = j.data.dir_name || '';
          this.tagEditorOriginal = {};
          this.tagEditorImages.forEach(img => { this.tagEditorOriginal[img.path] = img.tags; });
          this.tagEditorModified = false;
          this.renderTagEditor();
        } else {
          this.tagEditorImages = [];
          this.renderTagEditor();
        }
      } catch (e) { this.tagEditorImages = []; this.renderTagEditor(); }
    },

    tagEditorSaveAll() {
      if (!this.tagEditorModified) return;
      const images = this.tagEditorImages.map(img => ({ path: img.path, tags: img.tags }));
      fetch('/api/tageditor/save-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      }).then(r => r.json()).then(j => {
        if (j.status === 'success') {
          this.tagEditorOriginal = {};
          this.tagEditorImages.forEach(img => { this.tagEditorOriginal[img.path] = img.tags; });
          this.tagEditorModified = false;
          this.renderTagEditor();
        }
      });
    },

    tagEditorRevert() {
      this.tagEditorImages.forEach(img => {
        if (this.tagEditorOriginal[img.path] !== undefined) img.tags = this.tagEditorOriginal[img.path];
      });
      this.tagEditorModified = false;
      this.renderTagEditor();
    },

    async tagEditorBatchOp(op, args) {
      try {
        const r = await fetch('/api/tageditor/batch', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dir: this.tagEditorDir, operation: op, args }),
        });
        const j = await r.json();
        if (j.status === 'success') {
          this.tagEditorLoad(); // reload after batch op
        } else {
          alert(j.message || '操作失败');
        }
      } catch (e) { alert('操作失败: ' + e); }
    },

    tagEditorUpdate(imgPath, newTags) {
      const img = this.tagEditorImages.find(i => i.path === imgPath);
      if (img) { img.tags = newTags; this.tagEditorModified = true; }
    },

    renderTagEditor() {
      const el = document.getElementById('tagEditorContainer');
      if (!el) return;
      const imgs = this.tagEditorImages;
      const tt = (k, fb) => this.t('tagEditor.' + k) || fb || k;

      let html = '<div class="tag-editor">';

      // ── Dir selector ──
      html += `<div class="card" style="margin-bottom:12px"><div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:12px;color:var(--text-secondary)">${tt('datasetDir', '数据集')}:</span>
        <input type="text" style="flex:1" value="${this.tagEditorDir}" id="tagEditorDirInput"
          @keydown.enter="tagEditorLoad($event.target.value)">
        <button class="btn btn-sm btn-primary" @click="tagEditorLoad(document.getElementById('tagEditorDirInput').value)">${tt('loadImages', '加载')}</button>
        <span style="font-size:12px;color:var(--text-tertiary)">${imgs.length} images</span>
      </div></div>`;

      if (!imgs.length) {
        html += `<div style="text-align:center;padding:40px;color:var(--text-tertiary)">${tt('noImages', '暂无图片，请先加载数据集目录')}</div>`;
        el.innerHTML = html;
        return;
      }

      // ── Batch toolbar ──
      html += '<div class="card" style="margin-bottom:12px"><div class="batch-toolbar">';
      html += `<input type="text" id="batchVal" placeholder="value" style="width:120px"><input type="text" id="batchVal2" placeholder="${tt('findReplace', 'replace')}" style="width:120px">`;
      html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('add_prefix',{value:document.getElementById('batchVal').value})">${tt('addPrefix', '添加前缀')}</button>`;
      html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('add_suffix',{value:document.getElementById('batchVal').value})">${tt('addSuffix', '添加后缀')}</button>`;
      html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('find_replace',{find:document.getElementById('batchVal').value,replace:document.getElementById('batchVal2').value})">${tt('findReplace', '查找替换')}</button>`;
      html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('delete_tag',{value:document.getElementById('batchVal').value})">${tt('deleteTag', '删除')}</button>`;
      html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('dedup',{})">${tt('dedup', '去重')}</button>`;
      html += `<button class="btn btn-sm btn-secondary" @click="tagEditorBatchOp('sort',{})">${tt('sort', '排序')}</button>`;
      html += '</div></div>';

      // ── Image grid + tag editor ──
      html += '<div class="tag-editor-grid">';
      imgs.forEach((img, idx) => {
        const tagPills = (img.tags || '').split(',').filter(t => t.trim()).map(t =>
          `<span class="tag-pill" @click="tagEditorRemoveTag('${img.path}','${t.trim().replace(/'/g,"\\'")}')" title="${tt('clickToDelete', '点击删除')}">${t.trim()}</span>`
        ).join('');
        const isModified = this.tagEditorOriginal[img.path] !== undefined && this.tagEditorOriginal[img.path] !== img.tags;

        html += `<div class="tag-editor-item ${isModified ? 'modified' : ''}">
          <div class="tag-editor-thumb"><img src="${img.thumbnail}" loading="lazy" alt="${img.name}"/></div>
          <div class="tag-editor-info">
            <div class="tag-editor-filename">${img.name}${isModified ? ' *' : ''}</div>
            <div class="tag-editor-tags">${tagPills}</div>
            <textarea class="tag-editor-textarea" id="tagtext-${idx}"
              @input="tagEditorUpdate('${img.path.replace(/'/g,"\\'")}',$event.target.value)"
              @focus="tagEditorMarkDirty('${img.path.replace(/'/g,"\\'")}')"
              rows="2">${img.tags}</textarea>
          </div>
        </div>`;
      });
      html += '</div>';

      html += '</div>';
      el.innerHTML = html;
    },

    tagEditorRemoveTag(imgPath, tag) {
      const img = this.tagEditorImages.find(i => i.path === imgPath);
      if (!img) return;
      const tagList = img.tags.split(',').map(t => t.trim()).filter(t => t && t !== tag);
      img.tags = tagList.join(', ');
      this.tagEditorModified = true;
      this.renderTagEditor();
    },

    tagEditorMarkDirty() {
      this.tagEditorModified = true;
    },

    // ── Training Form ──────────────────────────────────────
    buildTrainForm() {
      const r = this.currentRoute;
      const cfg = ROUTE_CONFIG[r] || {};
      let trainType = cfg.trainType || 'sd-lora';
      if (r === 'train-anima') trainType = 'anima-lora';
      if (r === 'train-flux') trainType = 'flux-lora';
      if (r === 'train-sd3') trainType = 'sd3-lora';

      const savedKey = 'anima-form-' + r;
      let saved = null;
      try { const raw = localStorage.getItem(savedKey); if (raw) saved = JSON.parse(raw); } catch (e) {}

      const defaults = {};
      const allSections = [...TRAIN_SECTIONS_COMMON];
      if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
      allSections.forEach(s => { s.fields.forEach(f => { if (f.default !== undefined) defaults[f.key] = f.default; }); });
      defaults.model_train_type = trainType;

      this.form = { ...defaults, ...(saved || {}) };
      this.formDefaults = { ...this.form };
      this.formHistory = [this.formDefaults];
      this.formHistoryIdx = 0;

      this.renderTrainingForm(allSections);

      // Watch showIf-controlling keys — when toggled, rebuild form to show/hide conditional fields
      const showIfKeys = new Set();
      allSections.forEach(s => s.fields.forEach(f => {
        if (f.showIf) showIfKeys.add(f.showIf.key);
      }));
      const self = this;
      showIfKeys.forEach(k => {
        self.$watch('form.' + k, () => self.rebuildForm());
      });

      // Persist form to localStorage on any change
      const savedKeyLocal = savedKey;
      this.$watch('form', () => {
        try { localStorage.setItem(savedKeyLocal, JSON.stringify(self.form)); } catch (e) {}
      });
    },

    renderTrainingForm(sections) {
      const container = document.getElementById('trainFormContent');
      if (!container) return;
      let html = '';
      sections.forEach(section => {
        const visibleFields = section.fields.filter(f => {
          if (!f.showIf) return true;
          return this.form[f.showIf.key] === f.showIf.eq;
        });
        if (visibleFields.length === 0) return;
        html += `<div class="card" data-section="${section.key}">`;
        html += `<div class="card-header">${this.t(section.titleKey) || section.titleKey}</div>`;
        visibleFields.forEach(field => { html += this.renderField(field); });
        html += `</div>`;
      });
      container.innerHTML = html;
    },

    renderField(field) {
      const val = this.form[field.key];
      const label = this.t(field.descKey) || field.descKey || field.key;
      const hint = field.hintKey ? this.t(field.hintKey) : '';
      const dataKey = field.key; // Alpine-safe key for x-model binding

      let inputHtml = '';

      if (field.type === 'toggle') {
        inputHtml = `<label class="toggle"><input type="checkbox" x-model="form.${dataKey}"><span class="toggle-track"><span class="toggle-thumb"></span></span></label>`;
      } else if (field.type === 'select') {
        // Build field config for animaSelect component, resolving i18n keys
        const fc = {};
        const self = this; // capture for nested loops

        // Helper: clone an option and resolve dKey → d
        const resolveOption = (o) => {
          const cloned = { v: o.v, l: o.l };
          if (o.dKey) { cloned.d = self.t(o.dKey) || ''; }
          else if (o.d) { cloned.d = o.d; }
          return cloned;
        };

        // Helper: check if any option in groups/options has a description (dKey or d)
        const hasAnyDesc = (groups, options) => {
          if (groups) {
            for (const g of groups) {
              for (const o of (g.options || [])) { if (o.dKey || o.d) return true; }
            }
          }
          if (options) {
            for (const o of options) { if (o.dKey || o.d) return true; }
          }
          return false;
        };

        if (field.groups && field.groups.length) {
          fc.groups = field.groups.map(g => ({
            label: g.labelKey ? (self.t(g.labelKey) || g.label) : (g.label || ''),
            options: (g.options || []).map(o => resolveOption(o))
          }));
        } else if (field.options && field.options.length) {
          fc.options = field.options.map(o => resolveOption(o));
        } else {
          fc.options = [];
        }

        const hasGroups = !!(fc.groups && fc.groups.length);
        const hasOptionDescs = (fc.options || []).some(o => o.d) || (fc.groups || []).some(g => (g.options || []).some(o => o.d));

        // If there are NO groups and NO option descriptions, use a slightly simpler
        // template (no per-option tooltips), but still use the custom component.
        // If there ARE groups or descriptions, use the full template.
        if (hasGroups || hasOptionDescs) {
          inputHtml = `<div class="anima-select"
            x-data="animaSelect('${this.escJson(fc)}', '${(val || '').replace(/'/g, "\\'")}')"
            @click.outside="closeOnOutside()">
            <input type="hidden" x-ref="modelInput" x-model="form.${dataKey}">
            <button type="button" class="anima-select-trigger" :class="{ focused: open }"
              x-ref="triggerBtn"
              @click="toggle()"
              @mouseenter="onTriggerMouseEnter()"
              @mouseleave="onTriggerMouseLeave()">
              <span class="anima-select-trigger-text" x-text="selectedLabel"></span>
              <svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="anima-tooltip" :class="{ 'anima-tooltip-show': showTriggerTip && !open && selectedDesc }" :style="triggerTipStyle">
              <span x-text="selectedDesc"></span>
              <div class="anima-tooltip-arrow"></div>
            </div>
            <div class="anima-select-menu" x-show="open" x-transition>
              <div class="anima-select-menu-scroll">
                <template x-for="(group, gIdx) in displayGroups" :key="gIdx">
                  <div class="anima-select-group">
                    <div class="anima-select-group-label" x-show="group.label" x-text="group.label"></div>
                    <template x-for="(opt, oIdx) in group.options" :key="opt.v">
                      <div class="anima-select-option"
                        :class="{ active: opt.v === value }"
                        @click="select(opt.v)"
                        @mouseenter="onOptionMouseEnter(oIdx, opt)"
                        @mouseleave="onOptionMouseLeave()">
                        <span x-text="opt.l" :title="opt.l"></span>
                        <svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      </div>
                    </template>
                  </div>
                </template>
                <div x-show="displayGroups.length === 0" style="padding:8px 12px;font-size:12px;color:var(--text-tertiary)">—</div>
              </div>
              <div class="anima-select-menu-desc" x-show="hoveredOpt && hoveredOpt.d" x-text="hoveredOpt ? hoveredOpt.d : ''"></div>
            </div>
          </div>`;
        } else {
          // Simple flat options — no groups, no per-option descriptions
          inputHtml = `<div class="anima-select"
            x-data="animaSelect('${this.escJson(fc)}', '${(val || '').replace(/'/g, "\\'")}')"
            @click.outside="closeOnOutside()">
            <input type="hidden" x-ref="modelInput" x-model="form.${dataKey}">
            <button type="button" class="anima-select-trigger" :class="{ focused: open }"
              x-ref="triggerBtn"
              @click="toggle()"
              @mouseenter="onTriggerMouseEnter()"
              @mouseleave="onTriggerMouseLeave()">
              <span class="anima-select-trigger-text" x-text="selectedLabel"></span>
              <svg class="anima-select-chevron" :class="{ open: open }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="anima-tooltip" :class="{ 'anima-tooltip-show': showTriggerTip && !open && selectedDesc }" :style="triggerTipStyle">
              <span x-text="selectedDesc"></span>
              <div class="anima-tooltip-arrow"></div>
            </div>
            <div class="anima-select-menu" x-show="open" x-transition>
              <div class="anima-select-menu-scroll">
                <template x-for="group in displayGroups" :key="group.label">
                  <div class="anima-select-group">
                    <template x-for="opt in group.options" :key="opt.v">
                      <div class="anima-select-option"
                        :class="{ active: opt.v === value }"
                        @click="select(opt.v)"
                        @mouseenter="onOptionMouseEnter(0, opt)"
                        @mouseleave="onOptionMouseLeave()">
                        <span x-text="opt.l" :title="opt.l"></span>
                        <svg class="anima-select-check" x-show="opt.v === value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
              <div class="anima-select-menu-desc" x-show="hoveredOpt && hoveredOpt.d" x-text="hoveredOpt ? hoveredOpt.d : ''"></div>
            </div>
          </div>`;
        }
      } else if (field.type === 'textarea') {
        inputHtml = `<textarea x-model="form.${dataKey}" rows="3"></textarea>`;
      } else if (field.type === 'stepper') {
        inputHtml = `<div class="stepper"><button type="button" @click="stepField('${dataKey}', -${field.step || 1})">-</button><input type="number" x-model.number="form.${dataKey}" min="${field.min || 0}" max="${field.max || 999}" step="${field.step || 1}"><button type="button" @click="stepField('${dataKey}', ${field.step || 1})">+</button></div>`;
      } else if (field.type === 'number') {
        inputHtml = `<input type="number" x-model.number="form.${dataKey}" step="${field.step || 1}" min="${field.min !== undefined ? field.min : ''}" max="${field.max !== undefined ? field.max : ''}">`;
      } else {
        inputHtml = `<input type="text" x-model="form.${dataKey}">`;
      }

      let actionsHtml = '';
      if (field.role && field.role.startsWith('file-')) {
        actionsHtml = `<div class="field-actions">
          <button type="button" class="btn-icon" @click="localFilePicker('${dataKey}','${field.role}')" title="Local picker"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button>
          <button type="button" class="btn-icon" @click="builtinFilePicker('${dataKey}','${field.role}')" title="Built-in browser"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
          <button type="button" class="btn-icon" @click="undoField('${dataKey}')" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
          <button type="button" class="btn-icon" @click="resetField('${dataKey}')" title="Reset"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
        </div>`;
      } else if (field.type === 'text' || field.type === 'number' || field.type === 'textarea') {
        actionsHtml = `<div class="field-actions">
          <button type="button" class="btn-icon" @click="undoField('${dataKey}')" title="Undo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
          <button type="button" class="btn-icon" @click="resetField('${dataKey}')" title="Reset"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button>
        </div>`;
      }

      return `<div class="field" data-field-row="${dataKey.replace(/'/g, "\\'")}">
        <div class="field-left"><div class="field-label">${label}</div>${hint ? `<div class="field-desc">${hint}</div>` : ''}</div>
        <div class="field-right">${inputHtml}${actionsHtml}</div>
      </div>`;
    },

    esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; },

    // Safely encode a JSON object for embedding in HTML attributes.
    // Uses base64 to avoid all HTML/JS escaping issues (double quotes etc.).
    escJson(obj) {
      try {
        return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
      } catch (e) {
        // Fallback: minimal JSON (empty options)
        return btoa('{"options":[]}');
      }
    },

    setField(key, value) {
      const oldVal = this.form[key];
      if (oldVal === value) return;
      if (typeof this.formDefaults[key] === 'number' && value !== '' && value !== null) value = Number(value);
      this.form[key] = value;
      this.pushHistory({ ...this.form });
      const needsRerender = TRAIN_SECTIONS_COMMON.some(s => s.fields.some(f => f.showIf && f.showIf.key === key));
      if (needsRerender) this.rebuildForm();
    },

    stepField(key, delta) {
      const current = Number(this.form[key]) || 0;
      const field = this.findFieldDef(key);
      const step = field ? (field.step || 1) : 1;
      let newVal = current + delta;
      if (field && field.min !== undefined && newVal < field.min) newVal = field.min;
      if (field && field.max !== undefined && newVal > field.max) newVal = field.max;
      this.form[key] = newVal;  // x-model.number picks up the change reactively
      this.pushHistory({ ...this.form });
    },

    findFieldDef(key) {
      for (const s of [...TRAIN_SECTIONS_COMMON, ...TRAIN_SECTIONS_ANIMA]) {
        const f = s.fields.find(x => x.key === key);
        if (f) return f;
      }
      return null;
    },

    undoField(key) {
      if (this.formHistoryIdx > 0) {
        this.formHistoryIdx--;
        this.form = { ...this.formHistory[this.formHistoryIdx] };
        this.updateToml();
        this.rebuildForm();
      }
    },

    resetField(key) {
      const def = this.formDefaults[key];
      this.setField(key, def !== undefined ? def : '');
    },

    resetAllParams() {
      this.form = { ...this.formDefaults };
      this.formHistory = [this.formDefaults];
      this.formHistoryIdx = 0;
      this.updateToml();
      this.rebuildForm();
      this.toast(this.t('common.allReset'));
    },

    pushHistory(state) {
      this.formHistory = this.formHistory.slice(0, this.formHistoryIdx + 1);
      this.formHistory.push(state);
      if (this.formHistory.length > 50) this.formHistory.shift();
      else this.formHistoryIdx = this.formHistory.length - 1;
    },

    rebuildForm() {
      const r = this.currentRoute;
      if (!r || !r.startsWith('train-')) return;
      const cfg = ROUTE_CONFIG[r] || {};
      const allSections = [...TRAIN_SECTIONS_COMMON];
      if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
      this.renderTrainingForm(allSections);
    },

    // ── TOML (syntax highlighted) ──────────────────────────
    updateToml() {
      // Build set of valid, currently-visible keys for the current training route
      const validKeys = new Set();
      const r = this.currentRoute;
      const cfg = ROUTE_CONFIG[r] || {};
      const allSections = [...TRAIN_SECTIONS_COMMON];
      if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
      allSections.forEach(s => s.fields.forEach(f => {
        // Only include if showIf condition is met (or no condition)
        if (!f.showIf || this.form[f.showIf.key] === f.showIf.eq) {
          validKeys.add(f.key);
        }
      }));

      const lines = [];

      // Emit model_train_type first so it always appears at the top
      if (validKeys.has('model_train_type') && this.form.model_train_type) {
        lines.push(`model_train_type = "${this.form.model_train_type}"`);
      }

      for (const [k, v] of Object.entries(this.form)) {
        if (!validKeys.has(k)) continue;           // skip keys not in current form or hidden by showIf
        if (k === 'model_train_type') continue;     // already emitted at top
        if (k.startsWith('_')) continue;
        if (k === 'sample_prompts' || k === 'optimizer_args_custom') continue;  // processed separately
        if (v === '' || v === null || v === undefined) continue;

        // optimizer_args: merge custom args + Prodigy-specific fields (trainer reads --optimizer_args only)
        if (k === 'optimizer_args_custom' || k === 'prodigy_d_coef' || k === 'prodigy_d0') continue;

        if (typeof v === 'boolean') { if (v) lines.push(`${k} = true`); }
        else if (typeof v === 'number') lines.push(`${k} = ${v}`);
        else if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
          // Numeric string (e.g. "1e-4") → write as unquoted number for valid TOML
          lines.push(`${k} = ${Number(v)}`);
        }
        else lines.push(`${k} = "${String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`);
      }

      // Emit merged optimizer_args (custom + Prodigy-specific)
      const optArgsArr = [];
      const custom = this.form.optimizer_args_custom;
      if (custom && typeof custom === 'string') {
        optArgsArr.push(...custom.split('\n').map(s => s.trim()).filter(s => s));
      }
      if (this.form.optimizer_type === 'Prodigy' || this.form.optimizer_type === 'prodigyplus.ProdigyPlusScheduleFree') {
        if (this.form.prodigy_d_coef && this.form.prodigy_d_coef !== '2.0') optArgsArr.push(`d_coef=${this.form.prodigy_d_coef}`);
        if (this.form.prodigy_d0) optArgsArr.push(`d0=${this.form.prodigy_d0}`);
      }
      if (optArgsArr.length > 0) {
        const quoted = optArgsArr.map(s => `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`).join(', ');
        lines.push(`optimizer_args = [${quoted}]`);
      }

      this.tomlRaw = lines.join('\n') || '# ' + this.t('common.noConfigs');
      // Generate highlighted HTML: key | = | value (num or str)
      const highlighted = lines.map(line => {
        if (line.startsWith('#')) return `<span class="toml-comment">${this.esc(line)}</span>`;
        const eq = line.indexOf('=');
        if (eq === -1) return this.esc(line);
        const key = line.substring(0, eq).trim();
        const val = line.substring(eq + 1).trim();
        // Distinguish: quoted strings vs unquoted numbers/booleans
        const valCls = (val.startsWith('"') || val.startsWith("'")) ? 'toml-str' : 'toml-num';
        return `<span class="toml-key">${this.esc(key)}</span> <span class="toml-eq">=</span> <span class="${valCls}">${this.esc(val)}</span>`;
      }).join('\n');
      const preview = document.getElementById('tomlPreview');
      if (preview) {
        if (lines.length === 0) preview.innerHTML = `<span class="toml-comment"># ${this.t('common.noConfigs')}</span>`;
        else preview.innerHTML = highlighted;
      }
    },

    copyToml() {
      navigator.clipboard.writeText(this.tomlRaw).then(() => this.toast(this.t('common.copied')));
    },

    // ── Training ───────────────────────────────────────────
    async startTraining() {
      if (this.isTraining) return;
      this.isTraining = true; this.isIdle = false;
      this.statusText = this.t('common.training') + '...';

      // Build set of valid keys: only currently-visible fields (respects showIf)
      const validKeys = new Set(['model_train_type']);
      const r = this.currentRoute;
      const cfg = ROUTE_CONFIG[r] || {};
      const allSections = [...TRAIN_SECTIONS_COMMON];
      if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
      allSections.forEach(s => s.fields.forEach(f => {
        if (!f.showIf || this.form[f.showIf.key] === f.showIf.eq) {
          validKeys.add(f.key);
        }
      }));

      const payload = {};
      for (const [k, v] of Object.entries(this.form)) {
        if (!validKeys.has(k)) continue;
        if (v === '' || v === null || v === undefined) continue;
        payload[k] = v;
      }
      // Normalize numeric strings → numbers (learning_rate etc. are text-type fields)
      for (const [k, v] of Object.entries(payload)) {
        if (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && !v.includes(',')) {
          payload[k] = Number(v);
        }
      }

      // Convert sample_prompts (combined text) → old-format individual fields for backend
      if (payload.sample_prompts && typeof payload.sample_prompts === 'string') {
        const sp = payload.sample_prompts.trim();
        if (sp) {
          // Parse: "positive --n negative --w 512 --h 768 --l 7 --s 24 --d 1337"
          const nIdx = sp.indexOf(' --n ');
          if (nIdx > 0) {
            payload.positive_prompts = sp.substring(0, nIdx).trim();
            const rest = sp.substring(nIdx + 5); // after " --n "
            const wIdx = rest.indexOf(' --w '), hIdx = rest.indexOf(' --h '),
                  lIdx = rest.indexOf(' --l '), sIdx = rest.indexOf(' --s '), dIdx = rest.indexOf(' --d ');
            payload.negative_prompts = (wIdx > 0 ? rest.substring(0, wIdx) : rest).trim();
            if (wIdx > 0) payload.sample_width = parseInt(rest.substring(wIdx + 5)) || 512;
            if (hIdx > 0) payload.sample_height = parseInt(rest.substring(hIdx + 5)) || 512;
            if (lIdx > 0) payload.sample_cfg = parseInt(rest.substring(lIdx + 5)) || 7;
            if (sIdx > 0) payload.sample_steps = parseInt(rest.substring(sIdx + 5)) || 24;
            if (dIdx > 0) payload.sample_seed = parseInt(rest.substring(dIdx + 5)) || 2333;
          } else {
            payload.positive_prompts = sp;
          }
        }
        delete payload.sample_prompts;
      }

      // Convert optimizer_args_custom + Prodigy fields → optimizer_args (trainer reads this exclusively)
      const optArgs = [];
      if (payload.optimizer_args_custom && typeof payload.optimizer_args_custom === 'string') {
        optArgs.push(...payload.optimizer_args_custom.split('\n').map(s => s.trim()).filter(s => s));
        delete payload.optimizer_args_custom;
      }
      if (payload.optimizer_type === 'Prodigy' || payload.optimizer_type === 'prodigyplus.ProdigyPlusScheduleFree') {
        if (payload.prodigy_d_coef && payload.prodigy_d_coef !== '2.0') optArgs.push(`d_coef=${payload.prodigy_d_coef}`);
        if (payload.prodigy_d0) optArgs.push(`d0=${payload.prodigy_d0}`);
        delete payload.prodigy_d_coef;
        delete payload.prodigy_d0;
      }
      if (optArgs.length > 0) payload.optimizer_args = optArgs;

      try {
        const resp = await fetch('/api/run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
        const data = await resp.json();
        if (data.status !== 'success') { this.toast(data.message||'Failed'); this.isTraining=false; this.isIdle=true; this.statusText='Idle'; }
        else { this.taskId = (data.data&&data.data.task_id)||null; this.toast(this.t('common.trainingStarted')); }
      } catch(e) { this.toast(this.t('common.requestFailed')+': '+e.message); this.isTraining=false; this.isIdle=true; this.statusText='Idle'; }
    },

    async stopTraining() {
      if (!this.isTraining) return;
      try {
        if (this.taskId) await fetch('/api/tasks/terminate/'+this.taskId);
        this.isTraining = false; this.statusText = 'Idle';
        this.toast(this.t('common.trainingStopped'));
      } catch(e) { this.toast(this.t('common.failed')+': '+e.message); }
    },

    // ── Param Save/Load ────────────────────────────────────
    saveParamsToBrowser() {
      const name = prompt(this.t('common.enterConfigName'), 'config-'+Date.now().toString(36));
      if (!name) return;
      const configs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]');
      configs.push({ name, date: new Date().toLocaleString(), data: {...this.form} });
      localStorage.setItem('anima-saved-configs', JSON.stringify(configs));
      this.savedConfigs = configs;
      this.toast(this.t('common.saved'));
    },

    loadParamsFromBrowser(idx) {
      const configs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]');
      if (!configs[idx]) return;
      this.form = { ...configs[idx].data };
      this.formDefaults = { ...this.form };
      this.formHistory = [this.formDefaults];
      this.formHistoryIdx = 0;
      this.updateToml();
      this.rebuildForm();
      this.toast(this.t('common.loaded'));
    },

    deleteSavedConfig(idx) {
      const configs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]');
      configs.splice(idx,1);
      localStorage.setItem('anima-saved-configs', JSON.stringify(configs));
      this.savedConfigs = configs;
    },

    refreshSavedConfigs() {
      try { this.savedConfigs = JSON.parse(localStorage.getItem('anima-saved-configs')||'[]'); } catch(e) { this.savedConfigs = []; }
    },

    downloadConfig() {
      const blob = new Blob([this.tomlRaw], {type:'text/plain'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = (this.form.output_name||'config')+'.toml'; a.click();
      URL.revokeObjectURL(url); this.toast(this.t('common.downloaded'));
    },

    importConfigFile() { document.getElementById('configFileInput').click(); },

    handleConfigFileImport(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = this.parseToml(e.target.result);
          if (Object.keys(parsed).length===0) { this.toast(this.t('common.invalidToml')); return; }
          this.form = { ...this.formDefaults, ...parsed };
          this.formDefaults = { ...this.form };
          this.formHistory = [this.formDefaults]; this.formHistoryIdx = 0;
          this.updateToml(); this.rebuildForm();
          this.toast(this.t('common.imported'));
        } catch(err) { this.toast(this.t('common.parseError')+': '+err.message); }
      };
      reader.readAsText(file);
      event.target.value = '';
    },

    parseToml(text) {
      const result = {};
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t||t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq===-1) continue;
        const key = t.substring(0,eq).trim();
        let val = t.substring(eq+1).trim();
        if (val==='true') { result[key]=true; continue; }
        if (val==='false') { result[key]=false; continue; }
        if (!isNaN(val)&&val!=='') { result[key]=Number(val); continue; }
        if ((val.startsWith('"')&&val.endsWith('"'))||(val.startsWith("'")&&val.endsWith("'"))) { result[key]=val.slice(1,-1); continue; }
        result[key]=val;
      }
      return result;
    },

    autoLoadLastParams() {
      if (this._autoLoaded) return;
      if (!this.autoLoadHistory || !this.currentRoute.startsWith('train-')) return;
      this._autoLoaded = true;
      this.toast(this.t('common.autoLoadedHistory'));
    },

    // ── File Pickers ───────────────────────────────────────
    async localFilePicker(key, role) {
      let type = 'folder';
      if (role==='file-model'||role==='file-model-saved') type='model-file';
      try {
        const r = await fetch('/api/pick_file?picker_type='+type);
        const d = await r.json();
        if (d.status==='success'&&d.data&&d.data.path) this.setField(key, d.data.path);
      } catch(e) { this.toast(this.t('common.localPickerNA')); }
    },

    async builtinFilePicker(key, role) {
      let pickType = 'model-file';
      if (role==='file-folder') pickType='train-dir';
      if (role==='file-model') pickType='model-file';
      if (role==='file-model-saved') pickType='model-saved-file';
      try {
        const r = await fetch('/api/get_files?pick_type='+pickType);
        const d = await r.json();
        const files = (d.status==='success'&&d.data) ? (d.data.files||d.data) : [];
        this.showFilePickerModal(key, Array.isArray(files)?files:[]);
      } catch(e) { this.toast(this.t('common.fileBrowserFailed')); }
    },

    showFilePickerModal(key, files) {
      const safeKey = key.replace(/'/g, "\\'");
      const listHtml = files.map(f => {
        const safePath = f.path.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        return `<div class="config-list-item" @click="setField('${safeKey}','${safePath}'); showLoadModal = false"><span class="config-name">${f.name||''}</span><span class="config-date text-sm">${f.path||''}</span></div>`;
      }).join('');
      const modalBody = document.getElementById('savedConfigsList');
      if (modalBody) { modalBody.innerHTML = `<p class="text-sm text-muted mb-2">Select:</p>${listHtml}`; this.showLoadModal = true; }
    },

    // ── TB ─────────────────────────────────────────────────
    loadTbConfig() {
      try { const s = localStorage.getItem('anima-tb-url'); if(s){ const p=s.replace('http://','').split(':'); this.tbHost=p[0]||'127.0.0.1'; this.tbPort=p[1]||'6006'; } } catch(e){}
    },

    // ── Tagger ─────────────────────────────────────────────
    async buildTaggerForm() {
      const container = document.getElementById('taggerForm');
      if (!container) return;
      let models = [];
      try { const r=await fetch('/api/tagger/models'); const d=await r.json(); if(d.status==='success') models=d.data||[]; } catch(e){}
      if (!models.length) models = [
        {id:'wd-vit-v3',name:'WD ViT v3'},{id:'wd-swinv2-v3',name:'WD SwinV2 v3'},{id:'wd-convnext-v3',name:'WD ConvNext v3'},
        {id:'wd14-vit-v2',name:'WD14 ViT v2'},{id:'wd14-swinv2-v2',name:'WD14 SwinV2 v2'},{id:'wd14-convnextv2-v2',name:'WD14 ConvNextV2 v2'},
        {id:'wd14-moat-v2',name:'WD14 MOAT v2'},{id:'wd-eva02-large-tagger-v3',name:'WD EVA02 Large v3'},{id:'wd-vit-large-tagger-v3',name:'WD ViT Large v3'},
        {id:'cl_tagger_1_01',name:'CL Tagger 1.01'}
      ];
      const modelOpts = models.map(m=>`<option value="${m.id}">${m.name||m.id}</option>`).join('');
      const conflictOpts = [
        {v:'ignore',l:this.t('tagger.conflictIgnore')},{v:'copy',l:this.t('tagger.conflictCopy')},{v:'prepend',l:this.t('tagger.conflictPrepend')}
      ];
      const conflictSelect = `<select id="tagger-conflict-action">${conflictOpts.map(o=>`<option value="${o.v}" ${o.v==='copy'?'selected':''}>${o.l}</option>`).join('')}</select>`;
      container.innerHTML = `<div class="card-header">${this.t('tagger.title')}</div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.imageDir')}</div><div class="field-desc">${this.t('tagger.imageDirDesc')}</div></div><div class="field-right"><input type="text" id="tagger-path" value="./train/aki" style="flex:1"><div class="field-actions"><button type="button" class="btn-icon" @click="localFilePickerTagger('tagger-path')" title="${this.t('tagger.imageDir')}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></button></div></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.model')}</div><div class="field-desc">${this.t('tagger.modelDesc')}</div></div><div class="field-right"><select id="tagger-model">${modelOpts}</select></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.threshold')}</div><div class="field-desc">${this.t('tagger.thresholdDesc')}</div></div><div class="field-right"><div class="stepper"><button type="button" onclick="document.getElementById('tagger-threshold').stepDown()">-</button><input type="number" id="tagger-threshold" value="0.35" min="0" max="1" step="0.01"><button type="button" onclick="document.getElementById('tagger-threshold').stepUp()">+</button></div></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.characterThreshold')}</div><div class="field-desc">${this.t('tagger.characterThresholdDesc')}</div></div><div class="field-right"><div class="stepper"><button type="button" onclick="document.getElementById('tagger-char-threshold').stepDown()">-</button><input type="number" id="tagger-char-threshold" value="0.6" min="0" max="1" step="0.01"><button type="button" onclick="document.getElementById('tagger-char-threshold').stepUp()">+</button></div></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.additionalTags')}</div><div class="field-desc">${this.t('tagger.additionalTagsDesc')}</div></div><div class="field-right"><input type="text" id="tagger-additional" placeholder="e.g. 1girl, solo"></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.excludeTags')}</div><div class="field-desc">${this.t('tagger.excludeTagsDesc')}</div></div><div class="field-right"><input type="text" id="tagger-exclude" placeholder="e.g. watermark"></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.replaceUnderscore')}</div><div class="field-desc">${this.t('tagger.replaceUnderscoreDesc')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-replace-underscore" checked><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.escapeTag')}</div><div class="field-desc">${this.t('tagger.escapeTagDesc')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-escape-tag" checked><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.recursive')}</div><div class="field-desc">${this.t('tagger.recursiveDesc')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-recursive" checked><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.addRatingTag')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-add-rating"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.addModelTag')}</div></div><div class="field-right"><label class="toggle"><input type="checkbox" id="tagger-add-model"><span class="toggle-track"><span class="toggle-thumb"></span></span></label></div></div>
        <div class="field"><div class="field-left"><div class="field-label">${this.t('tagger.conflictAction')}</div><div class="field-desc">${this.t('tagger.conflictActionDesc')}</div></div><div class="field-right">${conflictSelect}</div></div>
        <div class="mt-4 flex gap-2"><button class="btn btn-primary" @click="runTagger()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${this.t('tagger.start')}</button><button class="btn btn-ghost" @click="stopTagger()" id="tagger-stop-btn" disabled><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> ${this.t('tagger.stop')}</button></div>
        <div id="tagger-output" class="mt-2" style="padding:12px;background:var(--bg-preview);border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;color:var(--text-preview);min-height:40px;display:none"></div>`;
    },

    async runTagger() {
      const path = document.getElementById('tagger-path').value;
      const model = document.getElementById('tagger-model').value;
      const threshold = parseFloat(document.getElementById('tagger-threshold').value);
      const charThreshold = parseFloat(document.getElementById('tagger-char-threshold')?.value || '0.6');
      const additional = document.getElementById('tagger-additional').value;
      const exclude = document.getElementById('tagger-exclude').value;
      const conflictAction = document.getElementById('tagger-conflict-action')?.value || 'copy';
      if (!path) { this.toast(this.t('common.specifyDir')); return; }
      this.taggerRunning = true; document.getElementById('tagger-stop-btn').disabled = false;
      const out = document.getElementById('tagger-output'); out.style.display='block'; out.textContent=this.t('tagger.running');
      try {
        const r = await fetch('/api/interrogate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,interrogator_model:model,threshold,character_threshold:charThreshold,additional_tags:additional,exclude_tags:exclude,replace_underscore:document.getElementById('tagger-replace-underscore').checked,batch_input_recursive:document.getElementById('tagger-recursive').checked,batch_output_action_on_conflict:conflictAction,add_rating_tag:document.getElementById('tagger-add-rating')?.checked||false,add_model_tag:document.getElementById('tagger-add-model')?.checked||false,escape_tag:document.getElementById('tagger-escape-tag')?.checked||false,character_threshold:charThreshold,sort_by_alphabetical_order:false,add_confident_as_weight:false,replace_underscore_excludes:'',batch_output_dir:'',batch_output_filename_format:'[name].[output_extension]',batch_output_save_json:false,batch_remove_duplicated_tag:false,unload_model_after_running:false})});
        const d = await r.json();
        out.textContent = d.status==='success' ? this.t('tagger.completed') : ('Error: '+(d.message||'Unknown'));
        this.toast(d.status==='success' ? this.t('tagger.completed') : (d.message||this.t('common.failed')));
      } catch(e) { out.textContent='Error: '+e.message; this.toast(this.t('common.failed')+': '+e.message); }
      this.taggerRunning=false; document.getElementById('tagger-stop-btn').disabled=true;
    },

    stopTagger() { this.taggerRunning=false; this.toast(this.t('tagger.stop')); },

    localFilePickerTagger(inputId) {
      fetch('/api/pick_file?picker_type=folder').then(r=>r.json()).then(d=>{if(d.status==='success'&&d.data&&d.data.path) document.getElementById(inputId).value=d.data.path;}).catch(()=>{});
    },

    openTagEditor() { window.open('/proxy/tageditor','_blank'); },

    // ── UI Settings ────────────────────────────────────────
    loadUISettings() {
      try {
        const s = JSON.parse(localStorage.getItem('anima-ui-settings')||'{}');
        if (s.autoLoadHistory!==undefined) this.autoLoadHistory = s.autoLoadHistory;
        if (s.tbUrl) this.settingsTbUrl = s.tbUrl;
        this.refreshSavedConfigs();
      } catch(e){}
    },

    saveUISettings() {
      localStorage.setItem('anima-ui-settings', JSON.stringify({theme:this.theme,autoLoadHistory:this.autoLoadHistory,tbUrl:this.settingsTbUrl}));
      this.resolveTheme();
      this.toast(this.t('common.saved'));
    },

    onLocaleChange() {
      I18N.setLocale(this.locale);
      this.showLangDropdown = false;
    },

    // ── Toast (top center, stackable, fade in/out only) ────
    toast(message) {
      const c = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = message;
      c.appendChild(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => { if (el.parentNode) el.remove(); }, 300);
      }, 2400);
    },

    t(key, fallback) {
      void this.locale;
      return window.t ? window.t(key, fallback) : (fallback||key);
    },

  }));
});
