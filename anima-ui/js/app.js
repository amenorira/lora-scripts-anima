/* ================================================================
   Anima Trainer UI — Application Core
   SPA router · Theme engine · Training forms · API · TOML preview
   ================================================================ */

// ── Training Form Field Definitions ────────────────────────
// Each section: { title: string, fields: [{ key, label, type, desc, default, options?, step?, min?, max?, role?, showIf? }] }

const TRAIN_SECTIONS_COMMON = [
  {
    key: 'model', titleKey: 'section.model',
    fields: [
      { key: 'pretrained_model_name_or_path', type: 'text', default: './sd-models/model.safetensors', role: 'file-model', descKey: 'field.pretrained_model_name_or_path' },
      { key: 'vae', type: 'text', default: '', role: 'file-model', descKey: 'field.vae' },
      { key: 'resume', type: 'text', default: '', role: 'file-folder', descKey: 'field.resume' },
      { key: 'model_train_type', type: 'select', default: 'sd-lora', options: [
        { v: 'sd-lora', l: 'SD LoRA' }, { v: 'sdxl-lora', l: 'SDXL LoRA' },
        { v: 'anima-lora', l: 'Anima LoRA' }, { v: 'flux-lora', l: 'Flux LoRA' },
        { v: 'sd3-lora', l: 'SD3 LoRA' }
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
      { key: 'save_model_as', type: 'select', default: 'safetensors', options: [{ v: 'safetensors', l: 'safetensors' }, { v: 'pt', l: 'pt' }, { v: 'ckpt', l: 'ckpt' }], descKey: 'field.save_model_as' },
      { key: 'save_precision', type: 'select', default: 'fp16', options: [{ v: 'fp16', l: 'fp16' }, { v: 'bf16', l: 'bf16' }, { v: 'float', l: 'float' }], descKey: 'field.save_precision' },
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
        { v: 'cosine_with_restarts', l: 'cosine_with_restarts' }, { v: 'cosine', l: 'cosine' },
        { v: 'linear', l: 'linear' }, { v: 'polynomial', l: 'polynomial' },
        { v: 'constant', l: 'constant' }, { v: 'constant_with_warmup', l: 'constant_with_warmup' }
      ], descKey: 'field.lr_scheduler' },
      { key: 'lr_scheduler_num_cycles', type: 'number', default: 1, min: 1, descKey: 'field.lr_scheduler_num_cycles', showIf: { key: 'lr_scheduler', eq: 'cosine_with_restarts' } },
      { key: 'lr_warmup_steps', type: 'number', default: 0, min: 0, descKey: 'field.lr_warmup_steps' },
      { key: 'optimizer_type', type: 'select', default: 'AdamW8bit', options: [
        { v: 'AdamW8bit', l: 'AdamW8bit' }, { v: 'AdamW', l: 'AdamW' },
        { v: 'Lion', l: 'Lion' }, { v: 'Lion8bit', l: 'Lion8bit' },
        { v: 'Prodigy', l: 'Prodigy' }, { v: 'AdaFactor', l: 'AdaFactor' },
        { v: 'DAdaptation', l: 'DAdaptation' }, { v: 'DAdaptAdam', l: 'DAdaptAdam' },
        { v: 'DAdaptLion', l: 'DAdaptLion' }, { v: 'RAdamScheduleFree', l: 'RAdamScheduleFree' },
        { v: 'SGDNesterov', l: 'SGDNesterov' }, { v: 'SGDNesterov8bit', l: 'SGDNesterov8bit' },
        { v: 'PagedAdamW8bit', l: 'PagedAdamW8bit' }, { v: 'PagedLion8bit', l: 'PagedLion8bit' },
        { v: 'DAdaptAdaGrad', l: 'DAdaptAdaGrad' }, { v: 'DAdaptAdanIP', l: 'DAdaptAdanIP' },
        { v: 'DAdaptSGD', l: 'DAdaptSGD' }, { v: 'prodigyplus.ProdigyPlusScheduleFree', l: 'ProdigyPlusScheduleFree' },
        { v: 'pytorch_optimizer.CAME', l: 'CAME' }
      ], descKey: 'field.optimizer_type' },
      { key: 'loss_type', type: 'select', default: '', options: [{ v: '', l: 'Default' }, { v: 'l1', l: 'l1' }, { v: 'l2', l: 'l2' }, { v: 'huber', l: 'huber' }, { v: 'smooth_l1', l: 'smooth_l1' }], descKey: 'field.loss_type' },
      { key: 'min_snr_gamma', type: 'number', default: null, step: 0.1, descKey: 'field.min_snr_gamma' },
      { key: 'weight_decay', type: 'number', default: null, step: 0.001, descKey: 'field.weight_decay' },
      { key: 'prodigy_d_coef', type: 'text', default: '2.0', descKey: 'field.prodigy_d_coef', showIf: { key: 'optimizer_type', eq: 'Prodigy' } },
    ]
  },
  {
    key: 'network', titleKey: 'section.network',
    fields: [
      { key: 'network_module', type: 'select', default: 'networks.lora', options: [
        { v: 'networks.lora', l: 'networks.lora' }, { v: 'networks.lora_anima', l: 'networks.lora_anima' },
        { v: 'lycoris.kohya', l: 'lycoris.kohya' }
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
      { key: 'keep_tokens_separator', type: 'text', default: '', descKey: 'field.keep_tokens_separator' },
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
        { v: 'ddim', l: 'ddim' }, { v: 'pndm', l: 'pndm' }, { v: 'lms', l: 'lms' },
        { v: 'euler', l: 'euler' }, { v: 'euler_a', l: 'euler_a' }, { v: 'heun', l: 'heun' },
        { v: 'dpm_2', l: 'dpm_2' }, { v: 'dpm_2_a', l: 'dpm_2_a' },
        { v: 'dpmsolver', l: 'dpmsolver' }, { v: 'dpmsolver++', l: 'dpmsolver++' },
        { v: 'dpmsingle', l: 'dpmsingle' }
      ], descKey: 'field.sample_sampler', showIf: { key: 'enable_preview', eq: true } },
      { key: 'sample_every_n_epochs', type: 'number', default: 2, min: 1, descKey: 'field.sample_every_n_epochs', showIf: { key: 'enable_preview', eq: true } },
      { key: 'sample_cfg', type: 'number', default: 7, min: 1, max: 30, descKey: 'field.sample_cfg', showIf: { key: 'enable_preview', eq: true } },
    ]
  },
  {
    key: 'speed', titleKey: 'section.speed',
    fields: [
      { key: 'mixed_precision', type: 'select', default: 'bf16', options: [{ v: 'bf16', l: 'bf16' }, { v: 'fp16', l: 'fp16' }, { v: 'no', l: 'no' }], descKey: 'field.mixed_precision' },
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

// Anima-specific extra sections
const TRAIN_SECTIONS_ANIMA = [
  {
    key: 'animaParams', titleKey: 'section.animaParams',
    fields: [
      { key: 'qwen3', type: 'text', default: '', role: 'file-model', descKey: 'field.qwen3' },
      { key: 'llm_adapter_path', type: 'text', default: '', role: 'file-model', descKey: 'field.llm_adapter_path' },
      { key: 't5_tokenizer_path', type: 'text', default: '', role: 'file-folder', descKey: 'field.t5_tokenizer_path' },
      { key: 'timestep_sampling', type: 'select', default: 'sigmoid', options: [
        { v: 'sigma', l: 'sigma' }, { v: 'uniform', l: 'uniform' },
        { v: 'sigmoid', l: 'sigmoid' }, { v: 'shift', l: 'shift' }, { v: 'flux_shift', l: 'flux_shift' }
      ], descKey: 'field.timestep_sampling' },
      { key: 'sigmoid_scale', type: 'number', default: 1.0, step: 0.001, descKey: 'field.sigmoid_scale', showIf: { key: 'timestep_sampling', eq: 'sigmoid' } },
      { key: 'discrete_flow_shift', type: 'number', default: 1.0, step: 0.001, descKey: 'field.discrete_flow_shift' },
      { key: 'weighting_scheme', type: 'select', default: 'uniform', options: [
        { v: 'sigma_sqrt', l: 'sigma_sqrt' }, { v: 'logit_normal', l: 'logit_normal' },
        { v: 'mode', l: 'mode' }, { v: 'cosmap', l: 'cosmap' },
        { v: 'none', l: 'none' }, { v: 'uniform', l: 'uniform' }
      ], descKey: 'field.weighting_scheme' },
      { key: 'logit_mean', type: 'number', default: 0.0, step: 0.01, descKey: 'field.logit_mean' },
      { key: 'logit_std', type: 'number', default: 1.0, step: 0.01, descKey: 'field.logit_std' },
      { key: 'mode_scale', type: 'number', default: 1.29, step: 0.01, descKey: 'field.mode_scale' },
      { key: 'qwen3_max_token_length', type: 'number', default: 512, step: 1, descKey: 'field.qwen3_max_token_length' },
      { key: 't5_max_token_length', type: 'number', default: 512, step: 1, descKey: 'field.t5_max_token_length' },
      { key: 'attn_mode', type: 'select', default: 'torch', options: [
        { v: 'torch', l: 'torch' }, { v: 'xformers', l: 'xformers' }, { v: 'flash', l: 'flash' }
      ], descKey: 'field.attn_mode' },
      { key: 'split_attn', type: 'toggle', default: false, descKey: 'field.split_attn' },
      { key: 'torch_compile', type: 'toggle', default: false, descKey: 'field.torch_compile' },
      { key: 'text_encoder_batch_size', type: 'number', default: null, min: 1, descKey: 'field.text_encoder_batch_size' },
      { key: 'unsloth_offload_checkpointing', type: 'toggle', default: false, descKey: 'field.unsloth_offload_checkpointing' },
    ]
  },
];

// Route → page config
const ROUTE_CONFIG = {
  'home': { title: 'Anima Trainer', subtitle: '' },
  'train-basic': { title: 'LoRA Training - Beginner', subtitle: 'SD1.5 LoRA — set base model and dataset to get started', trainType: 'sd-lora', formMode: 'basic' },
  'train-master': { title: 'LoRA Training - Expert', subtitle: 'All advanced parameters unlocked', trainType: 'sd-lora', formMode: 'master' },
  'train-anima': { title: 'Anima LoRA Training', subtitle: 'Anima DiT — Qwen3 + T5 dual encoder', trainType: 'anima-lora', formMode: 'master', extraSections: true },
  'train-flux': { title: 'Flux LoRA Training', subtitle: 'Flux.1 model LoRA training', trainType: 'flux-lora', formMode: 'master' },
  'train-sd3': { title: 'SD3.5 LoRA Training', subtitle: 'Stable Diffusion 3.5 LoRA training', trainType: 'sd3-lora', formMode: 'master' },
  'tensorboard': { title: 'TensorBoard', subtitle: '' },
  'tagger': { title: 'Tagger', subtitle: 'Auto-tag images using WD14 models' },
  'tagEditor': { title: 'Tag Editor', subtitle: 'Edit image tags and captions' },
  'tools': { title: 'Tools', subtitle: 'LoRA extraction, merging, conversion utilities' },
  'tool-params': { title: 'Parameters', subtitle: 'Parameter reference and documentation' },
  'settings': { title: 'UI Settings', subtitle: 'Customize your training UI experience' },
  'about': { title: 'About', subtitle: '' },
};

// ── Alpine App ─────────────────────────────────────────────
document.addEventListener('alpine:init', () => {
  Alpine.data('animaApp', () => ({

    // ── State ──────────────────────────────────────────────
    version: '2.0.0',
    theme: 'auto',          // 'light' | 'dark' | 'auto'
    resolvedTheme: 'light', // actual computed
    currentRoute: 'home',
    pageTitle: 'Anima Trainer',
    pageSubtitle: '',
    locale: 'zh-CN',
    i18nReady: false,

    // Form state
    form: {},               // Current field values
    formDefaults: {},       // Snapshotted defaults
    formHistory: [],        // Undo stack [{key: val, ...}, ...]
    formHistoryIdx: -1,     // Current position in history

    // Right panel
    tomlRaw: '',
    tomlHighlighted: '',
    showPanelScroll: false,
    showMainScroll: false,

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

    // TensorBoard
    tbHost: '127.0.0.1',
    tbPort: '6006',

    // Tagger
    taggerModels: [],
    taggerRunning: false,

    // File picker cache
    fileCache: {},

    get tensorboardUrl() {
      return `http://${this.tbHost}:${this.tbPort}`;
    },

    // ── Init ───────────────────────────────────────────────
    async init() {
      // Load saved theme preference
      const savedTheme = localStorage.getItem('anima-theme') || 'auto';
      this.theme = savedTheme;

      // Apply theme
      this.resolveTheme();

      // Init locale synchronously (messages embedded in i18n.js)
      I18N.init(this.locale);
      this.locale = I18N.getLocale();
      this.i18nReady = true;

      // Load UI settings
      this.loadUISettings();

      // Parse hash route
      this.handleRoute();
      window.addEventListener('hashchange', () => this.handleRoute());

      // Listen for system theme changes
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.theme === 'auto') this.resolveTheme();
      });

      // Build initial route content
      this.buildRouteContent();

      // Auto-load history
      if (this.autoLoadHistory) {
        setTimeout(() => this.autoLoadLastParams(), 400);
      }

      document.title = this.pageTitle + ' | Anima Trainer';
    },

    // ── Theme ───────────────────────────────────────────────
    resolveTheme() {
      if (this.theme === 'auto') {
        this.resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } else {
        this.resolvedTheme = this.theme;
      }
      document.documentElement.setAttribute('data-theme', this.resolvedTheme);
    },

    toggleTheme() {
      this.theme = this.resolvedTheme === 'dark' ? 'light' : 'dark';
      this.resolveTheme();
      localStorage.setItem('anima-theme', this.theme);
    },

    applyTheme() {
      this.resolveTheme();
      localStorage.setItem('anima-theme', this.theme);
    },

    themeLabel() {
      return this.resolvedTheme === 'dark' ? this.t('common.themeLight') : this.t('common.themeDark');
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
      this.pageTitle = cfg.title || route;
      this.pageSubtitle = cfg.subtitle || '';
      document.title = this.pageTitle + ' | Anima Trainer';

      if (route !== prev) {
        this.buildRouteContent();
      }

      // Close modal on navigation
      this.showLoadModal = false;
    },

    showRightPanel() {
      const r = this.currentRoute;
      return r && (r.startsWith('train-') || r === 'tools');
    },

    // ── Route Content Builder ───────────────────────────────
    buildRouteContent() {
      const r = this.currentRoute;

      if (r && r.startsWith('train-')) {
        this.buildTrainForm();
      } else if (r === 'tensorboard') {
        // TensorBoard iframe is already in the template
        this.loadTbConfig();
      } else if (r === 'tagger') {
        this.buildTaggerForm();
      } else if (r === 'settings') {
        this.loadUISettings();
      }
    },

    // ── Training Form Builder ───────────────────────────────
    buildTrainForm() {
      const r = this.currentRoute;
      const cfg = ROUTE_CONFIG[r];

      // Determine train type
      let trainType = cfg.trainType || 'sd-lora';
      if (r === 'train-anima') trainType = 'anima-lora';
      if (r === 'train-flux') trainType = 'flux-lora';
      if (r === 'train-sd3') trainType = 'sd3-lora';

      // Restore saved form or use defaults
      const savedKey = 'anima-form-' + r;
      let saved = null;
      try {
        const raw = localStorage.getItem(savedKey);
        if (raw) saved = JSON.parse(raw);
      } catch (e) { /* ignore */ }

      // Build defaults from section definitions
      const defaults = {};
      const allSections = [...TRAIN_SECTIONS_COMMON];
      if (cfg.extraSections) {
        allSections.push(...TRAIN_SECTIONS_ANIMA);
      }
      allSections.forEach(s => {
        s.fields.forEach(f => {
          if (f.default !== undefined) defaults[f.key] = f.default;
        });
      });
      defaults.model_train_type = trainType;

      // Merge saved over defaults
      this.form = { ...defaults, ...(saved || {}) };
      this.formDefaults = { ...this.form };
      this.formHistory = [this.formDefaults];
      this.formHistoryIdx = 0;

      // Save to localStorage on change
      this.$watch('form', () => {
        this.updateToml();
        try {
          localStorage.setItem(savedKey, JSON.stringify(this.form));
        } catch (e) { /* ignore */ }
      });

      this.updateToml();

      // Render form HTML
      this.renderTrainingForm(allSections);
    },

    renderTrainingForm(sections) {
      const container = document.getElementById('trainFormContent');
      if (!container) return;

      let html = '';
      sections.forEach(section => {
        const visibleFields = section.fields.filter(f => {
          if (!f.showIf) return true;
          const val = this.form[f.showIf.key];
          return val === f.showIf.eq;
        });
        if (visibleFields.length === 0) return;

        html += `<div class="card" data-section="${section.key}">`;
        html += `<div class="card-header">${this.t(section.titleKey) || section.titleKey}</div>`;

        visibleFields.forEach(field => {
          html += this.renderField(field);
        });

        html += `</div>`;
      });

      container.innerHTML = html;

      // Re-bind Alpine on the new content
      // Since we're inside x-data, Alpine should pick up the bindings
      // But we need to handle the x-model bindings manually for the injected HTML
      this.bindFormFields();
    },

    renderField(field) {
      const val = this.form[field.key];
      const label = this.t(field.descKey) || field.descKey || field.key;
      const hint = field.hintKey ? this.t(field.hintKey) : '';

      let inputHtml = '';

      if (field.type === 'toggle') {
        const checked = val === true ? 'checked' : '';
        inputHtml = `
          <label class="toggle">
            <input type="checkbox" data-field="${field.key}" ${checked} onchange="document.querySelector('[x-data]').__x.$data.setField('${field.key}', this.checked)">
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>`;
      } else if (field.type === 'select') {
        let opts = '';
        (field.options || []).forEach(o => {
          const sel = val === o.v ? 'selected' : '';
          opts += `<option value="${o.v}" ${sel}>${o.l}</option>`;
        });
        inputHtml = `
          <select data-field="${field.key}" onchange="document.querySelector('[x-data]').__x.$data.setField('${field.key}', this.value)">
            ${opts}
          </select>`;
      } else if (field.type === 'textarea') {
        inputHtml = `<textarea data-field="${field.key}" rows="3" oninput="document.querySelector('[x-data]').__x.$data.setField('${field.key}', this.value)">${this.escapeHtml(val || '')}</textarea>`;
      } else if (field.type === 'stepper') {
        const v = val || 0;
        inputHtml = `
          <div class="stepper">
            <button type="button" onclick="document.querySelector('[x-data]').__x.$data.stepField('${field.key}', -${field.step || 1})">-</button>
            <input type="number" data-field="${field.key}" value="${v}" min="${field.min || 0}" max="${field.max || 999}" step="${field.step || 1}" onchange="document.querySelector('[x-data]').__x.$data.setField('${field.key}', this.value)">
            <button type="button" onclick="document.querySelector('[x-data]').__x.$data.stepField('${field.key}', ${field.step || 1})">+</button>
          </div>`;
      } else if (field.type === 'number') {
        const v = val !== null && val !== undefined ? val : '';
        inputHtml = `<input type="number" data-field="${field.key}" value="${v}" step="${field.step || 1}" min="${field.min !== undefined ? field.min : ''}" max="${field.max !== undefined ? field.max : ''}" onchange="document.querySelector('[x-data]').__x.$data.setField('${field.key}', this.value)">`;
      } else {
        // text
        inputHtml = `<input type="text" data-field="${field.key}" value="${this.escapeHtml(val || '')}" oninput="document.querySelector('[x-data]').__x.$data.setField('${field.key}', this.value)">`;
      }

      // Action buttons for text/file fields
      let actionsHtml = '';
      if (field.role && (field.role.startsWith('file-') || field.role === 'file-folder' || field.role === 'file-folder')) {
        actionsHtml = `
          <div class="field-actions">
            <button type="button" class="btn-icon" onclick="document.querySelector('[x-data]').__x.$data.localFilePicker('${field.key}', '${field.role}')" title="Local file picker">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button type="button" class="btn-icon" onclick="document.querySelector('[x-data]').__x.$data.builtinFilePicker('${field.key}', '${field.role}')" title="Built-in file browser">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
            <button type="button" class="btn-icon" onclick="document.querySelector('[x-data]').__x.$data.undoField('${field.key}')" title="Undo">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
            <button type="button" class="btn-icon" onclick="document.querySelector('[x-data]').__x.$data.resetField('${field.key}')" title="Reset to default">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
          </div>`;
      } else if (field.type === 'text' || field.type === 'number' || field.type === 'textarea') {
        actionsHtml = `
          <div class="field-actions">
            <button type="button" class="btn-icon" onclick="document.querySelector('[x-data]').__x.$data.undoField('${field.key}')" title="Undo">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
            <button type="button" class="btn-icon" onclick="document.querySelector('[x-data]').__x.$data.resetField('${field.key}')" title="Reset to default">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
          </div>`;
      }

      let hintHtml = hint ? `<div class="field-desc">${hint}</div>` : '';

      return `
        <div class="field" data-field-row="${field.key}">
          <div class="field-left">
            <div class="field-label">${label}</div>
            ${hintHtml}
          </div>
          <div class="field-right">
            ${inputHtml}
            ${actionsHtml}
          </div>
        </div>`;
    },

    escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },

    bindFormFields() {
      // No special binding needed — we use event handlers on each element
      // that call setField() directly via the Alpine $data
    },

    setField(key, value) {
      const oldVal = this.form[key];
      if (oldVal === value) return;
      if (typeof this.formDefaults[key] === 'number' && value !== '' && value !== null) {
        value = Number(value);
      }

      // Push to history
      this.form[key] = value;
      this.pushHistory({ ...this.form });
      this.updateToml();

      // Re-render if toggle fields with showIf affect visibility
      const needsRerender = TRAIN_SECTIONS_COMMON.some(s =>
        s.fields.some(f => f.showIf && f.showIf.key === key)
      );
      if (needsRerender) {
        const r = this.currentRoute;
        const cfg = ROUTE_CONFIG[r] || {};
        const allSections = [...TRAIN_SECTIONS_COMMON];
        if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
        this.renderTrainingForm(allSections);
      }
    },

    stepField(key, delta) {
      const current = Number(this.form[key]) || 0;
      const field = this.findFieldDef(key);
      const step = field ? (field.step || 1) : 1;
      const min = field ? field.min : undefined;
      const max = field ? field.max : undefined;
      let newVal = current + delta;
      if (min !== undefined && newVal < min) newVal = min;
      if (max !== undefined && newVal > max) newVal = max;
      this.setField(key, newVal);

      // Update the input visually
      const input = document.querySelector(`[data-field="${key}"]`);
      if (input) input.value = newVal;
    },

    findFieldDef(key) {
      for (const s of TRAIN_SECTIONS_COMMON) {
        const f = s.fields.find(x => x.key === key);
        if (f) return f;
      }
      for (const s of TRAIN_SECTIONS_ANIMA) {
        const f = s.fields.find(x => x.key === key);
        if (f) return f;
      }
      return null;
    },

    undoField(key) {
      if (this.formHistoryIdx > 0) {
        this.formHistoryIdx--;
        const prev = this.formHistory[this.formHistoryIdx];
        this.form = { ...prev };
        this.updateToml();
        this.rebuildFormIfNeeded();
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
      this.toast(this.t('common.allReset'), 'info');
    },

    pushHistory(state) {
      // Remove future states and push
      this.formHistory = this.formHistory.slice(0, this.formHistoryIdx + 1);
      this.formHistory.push(state);
      if (this.formHistory.length > 50) this.formHistory.shift();
      this.formHistoryIdx = this.formHistory.length - 1;
    },

    rebuildFormIfNeeded() {
      const r = this.currentRoute;
      if (r && r.startsWith('train-')) {
        const cfg = ROUTE_CONFIG[r] || {};
        const allSections = [...TRAIN_SECTIONS_COMMON];
        if (cfg.extraSections) allSections.push(...TRAIN_SECTIONS_ANIMA);
        this.renderTrainingForm(allSections);
      }
    },

    rebuildForm() {
      this.rebuildFormIfNeeded();
    },

    // ── TOML Generation ─────────────────────────────────────
    updateToml() {
      const lines = [];
      for (const [k, v] of Object.entries(this.form)) {
        if (k === 'model_train_type') continue;
        if (k.startsWith('_')) continue;
        if (v === '' || v === null || v === undefined) continue;
        if (typeof v === 'boolean') {
          if (v) lines.push(`${k} = true`);
        } else if (typeof v === 'number') {
          lines.push(`${k} = ${v}`);
        } else {
          lines.push(`${k} = "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
        }
      }
      this.tomlRaw = lines.join('\n') || '# Configure parameters to generate TOML';
      this.tomlHighlighted = this.highlightToml(this.tomlRaw);
    },

    highlightToml(raw) {
      return raw
        .replace(/^#.*$/gm, m => `<span class="toml-comment">${m}</span>`)
        .replace(/^(\w[\w\d_]*(?:\s*\.\s*\w[\w\d_]*)*)\s*=/gm, (m, key) => `<span class="toml-key">${key}</span> =`)
        .replace(/=\s*(true|false)/g, '= <span class="toml-eq">$1</span>')
        .replace(/=\s*("[^"]*")/g, '= <span class="toml-eq">$1</span>');
    },

    copyToml() {
      navigator.clipboard.writeText(this.tomlRaw).then(() => {
        this.toast(this.t('common.copied'), 'success');
      }).catch(() => {
        this.toast('Failed to copy', 'error');
      });
    },

    // ── Training Actions ────────────────────────────────────
    async startTraining() {
      if (this.isTraining) return;
      this.isTraining = true;
      this.isIdle = false;
      this.statusText = this.t('common.training') + '...';

      // Build payload
      const payload = { ...this.form };
      // Clean empty values
      for (const k of Object.keys(payload)) {
        if (payload[k] === '' || payload[k] === null || payload[k] === undefined) {
          delete payload[k];
        }
      }

      try {
        const resp = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (data.status !== 'success') {
          this.toast(data.message || 'Failed to start training', 'error');
          this.isTraining = false;
          this.isIdle = true;
          this.statusText = 'Idle';
        } else {
          this.taskId = (data.data && data.data.task_id) || null;
          this.toast(this.t('common.trainingStarted'), 'success');
        }
      } catch (e) {
        this.toast('Request failed: ' + e.message, 'error');
        this.isTraining = false;
        this.isIdle = true;
        this.statusText = 'Idle';
      }
    },

    async stopTraining() {
      if (!this.isTraining) return;
      try {
        if (this.taskId) {
          await fetch('/api/tasks/terminate/' + this.taskId);
        }
        this.isTraining = false;
        this.statusText = 'Idle';
        this.toast(this.t('common.trainingStopped'), 'info');
      } catch (e) {
        this.toast('Failed to stop: ' + e.message, 'error');
      }
    },

    // ── Parameter Save/Load (Browser localStorage) ──────────
    saveParamsToBrowser() {
      const name = prompt(this.t('common.enterConfigName') || 'Enter configuration name:', 'config-' + Date.now().toString(36));
      if (!name) return;
      const configs = JSON.parse(localStorage.getItem('anima-saved-configs') || '[]');
      configs.push({
        name: name,
        date: new Date().toLocaleString(),
        trainType: ROUTE_CONFIG[this.currentRoute]?.trainType || 'sd-lora',
        data: { ...this.form }
      });
      localStorage.setItem('anima-saved-configs', JSON.stringify(configs));
      this.savedConfigs = configs;
      this.toast(this.t('common.saved'), 'success');
    },

    loadParamsFromBrowser(idx) {
      const configs = JSON.parse(localStorage.getItem('anima-saved-configs') || '[]');
      if (!configs[idx]) return;
      this.form = { ...configs[idx].data };
      this.formDefaults = { ...this.form };
      this.formHistory = [this.formDefaults];
      this.formHistoryIdx = 0;
      this.updateToml();
      this.rebuildForm();
      this.toast(this.t('common.loaded'), 'success');
    },

    deleteSavedConfig(idx) {
      const configs = JSON.parse(localStorage.getItem('anima-saved-configs') || '[]');
      configs.splice(idx, 1);
      localStorage.setItem('anima-saved-configs', JSON.stringify(configs));
      this.savedConfigs = configs;
    },

    refreshSavedConfigs() {
      try {
        this.savedConfigs = JSON.parse(localStorage.getItem('anima-saved-configs') || '[]');
      } catch (e) {
        this.savedConfigs = [];
      }
    },

    // ── Download / Import Config ────────────────────────────
    downloadConfig() {
      let content = this.tomlRaw;
      if (!content || content.startsWith('#')) content = this.generateFullToml();
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (this.form.output_name || 'config') + '.toml';
      a.click();
      URL.revokeObjectURL(url);
      this.toast(this.t('common.downloaded'), 'success');
    },

    generateFullToml() {
      const lines = [];
      for (const [k, v] of Object.entries(this.form)) {
        if (k.startsWith('_')) continue;
        if (v === '' || v === null || v === undefined) continue;
        if (typeof v === 'boolean') lines.push(`${k} = ${v}`);
        else if (typeof v === 'number') lines.push(`${k} = ${v}`);
        else lines.push(`${k} = "${String(v)}"`);
      }
      return lines.join('\n');
    },

    importConfigFile() {
      document.getElementById('configFileInput').click();
    },

    handleConfigFileImport(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          const parsed = this.parseToml(text);
          if (Object.keys(parsed).length === 0) {
            this.toast('No valid TOML keys found', 'error');
            return;
          }
          this.form = { ...this.formDefaults, ...parsed };
          this.formDefaults = { ...this.form };
          this.formHistory = [this.formDefaults];
          this.formHistoryIdx = 0;
          this.updateToml();
          this.rebuildForm();
          this.toast(this.t('common.imported'), 'success');
        } catch (err) {
          this.toast('Failed to parse config file: ' + err.message, 'error');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    },

    parseToml(text) {
      const result = {};
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        if (val === 'true') { result[key] = true; continue; }
        if (val === 'false') { result[key] = false; continue; }
        if (!isNaN(val) && val !== '') { result[key] = Number(val); continue; }
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          result[key] = val.slice(1, -1);
          continue;
        }
        result[key] = val;
      }
      return result;
    },

    // ── Auto-load History ───────────────────────────────────
    autoLoadLastParams() {
      if (!this.autoLoadHistory) return;
      if (!this.currentRoute.startsWith('train-')) return;
      const savedKey = 'anima-form-' + this.currentRoute;
      try {
        const raw = localStorage.getItem(savedKey);
        if (raw) {
          this.toast(this.t('common.autoLoadedHistory'), 'info');
        }
      } catch (e) { /* ignore */ }
    },

    // ── File Pickers ────────────────────────────────────────
    async localFilePicker(key, role) {
      let type = 'folder';
      if (role === 'file-model' || role === 'file-model-saved') type = 'model-file';
      try {
        const resp = await fetch('/api/pick_file?picker_type=' + type);
        const data = await resp.json();
        if (data.status === 'success' && data.data && data.data.path) {
          this.setField(key, data.data.path);
        }
      } catch (e) {
        this.toast('Local file picker not available (requires desktop)', 'error');
      }
    },

    async builtinFilePicker(key, role) {
      let pickType = 'model-file';
      if (role === 'file-folder' || role === 'file-folder') pickType = 'train-dir';
      if (role === 'file-model') pickType = 'model-file';
      if (role === 'file-model-saved') pickType = 'model-saved-file';

      try {
        const resp = await fetch('/api/get_files?pick_type=' + pickType);
        const data = await resp.json();
        if (data.status === 'success' && data.data && data.data.files) {
          this.showFilePickerModal(key, data.data.files);
        } else if (data.status === 'success' && data.data) {
          this.showFilePickerModal(key, data.data);
        }
      } catch (e) {
        this.toast('Built-in file browser failed', 'error');
      }
    },

    showFilePickerModal(key, files) {
      // Show files in a simple modal
      let listHtml = files.map(f =>
        `<div class="config-list-item" onclick="document.querySelector('[x-data]').__x.$data.setField('${key}', '${f.path}');document.querySelector('[x-data]').__x.$data.showLoadModal=false">
          <span>${f.name}</span><span class="text-sm text-muted">${f.path}</span>
        </div>`
      ).join('');

      const modalBody = document.getElementById('savedConfigsList');
      if (modalBody) {
        modalBody.innerHTML = `<p class="text-sm text-muted" style="margin-bottom:8px">Select a file:</p>${listHtml}`;
        this.showLoadModal = true;
      }
    },

    // ── TensorBoard ──────────────────────────────────────────
    loadTbConfig() {
      try {
        const saved = localStorage.getItem('anima-tb-url');
        if (saved) {
          const parts = saved.replace('http://', '').split(':');
          this.tbHost = parts[0] || '127.0.0.1';
          this.tbPort = parts[1] || '6006';
        }
      } catch (e) { /* ignore */ }
    },

    // ── Tagger ──────────────────────────────────────────────
    async buildTaggerForm() {
      const container = document.getElementById('taggerForm');
      if (!container) return;

      // Fetch available interrogators
      let models = [];
      try {
        const resp = await fetch('/api/tagger/models');
        const data = await resp.json();
        if (data.status === 'success') models = data.data || [];
      } catch (e) { /* ignore */ }
      if (models.length === 0) {
        models = [
          { id: 'wd14-convnextv2-v2', name: 'WD14 ConvNextV2 v2' },
          { id: 'wd14-vit-v2', name: 'WD14 ViT v2' },
          { id: 'wd14-swinv2-v2', name: 'WD14 SwinV2 v2' },
          { id: 'wd14-convnextv2-large', name: 'WD14 ConvNextV2 Large' },
          { id: 'wd14-vit-large', name: 'WD14 ViT Large' },
          { id: 'wd14-swinv2-large', name: 'WD14 SwinV2 Large' },
        ];
      }

      let modelOpts = models.map(m => `<option value="${m.id}">${m.name || m.id}</option>`).join('');

      container.innerHTML = `
        <div class="card-header">Tagger Settings</div>
        <div class="field">
          <div class="field-left">
            <div class="field-label">Image Directory</div>
            <div class="field-desc">Path to folder containing images to tag</div>
          </div>
          <div class="field-right">
            <input type="text" id="tagger-path" value="./train/aki" style="flex:1">
            <div class="field-actions">
              <button type="button" class="btn-icon" onclick="document.querySelector('[x-data]').__x.$data.localFilePickerTagger('tagger-path')" title="Browse">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div class="field">
          <div class="field-left">
            <div class="field-label">Model</div>
            <div class="field-desc">WD14 tagger model to use</div>
          </div>
          <div class="field-right">
            <select id="tagger-model">${modelOpts}</select>
          </div>
        </div>
        <div class="field">
          <div class="field-left">
            <div class="field-label">Threshold</div>
            <div class="field-desc">Confidence threshold for tags (recommended: 0.35)</div>
          </div>
          <div class="field-right">
            <div class="stepper">
              <button type="button" onclick="document.getElementById('tagger-threshold').stepDown()">-</button>
              <input type="number" id="tagger-threshold" value="0.35" min="0" max="1" step="0.01">
              <button type="button" onclick="document.getElementById('tagger-threshold').stepUp()">+</button>
            </div>
          </div>
        </div>
        <div class="field">
          <div class="field-left">
            <div class="field-label">Additional Tags</div>
            <div class="field-desc">Comma-separated tags to always include</div>
          </div>
          <div class="field-right">
            <input type="text" id="tagger-additional" value="" placeholder="e.g. 1girl, solo">
          </div>
        </div>
        <div class="field">
          <div class="field-left">
            <div class="field-label">Exclude Tags</div>
            <div class="field-desc">Comma-separated tags to exclude</div>
          </div>
          <div class="field-right">
            <input type="text" id="tagger-exclude" value="" placeholder="e.g. watermark, text">
          </div>
        </div>
        <div class="field">
          <div class="field-left">
            <div class="field-label">Replace Underscore</div>
            <div class="field-desc">Replace underscores with spaces in output tags</div>
          </div>
          <div class="field-right">
            <label class="toggle">
              <input type="checkbox" id="tagger-replace-underscore" checked>
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
        <div class="field">
          <div class="field-left">
            <div class="field-label">Recursive</div>
            <div class="field-desc">Process subdirectories recursively</div>
          </div>
          <div class="field-right">
            <label class="toggle">
              <input type="checkbox" id="tagger-recursive" checked>
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>
          </div>
        </div>
        <div style="margin-top:16px;display:flex;gap:10px">
          <button class="btn btn-primary" onclick="document.querySelector('[x-data]').__x.$data.runTagger()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start Tagger
          </button>
          <button class="btn btn-ghost" onclick="document.querySelector('[x-data]').__x.$data.stopTagger()" id="tagger-stop-btn" disabled>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            Stop
          </button>
        </div>
        <div id="tagger-output" style="margin-top:12px;padding:12px;background:var(--bg-preview);border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;color:var(--text-preview);min-height:40px;display:none"></div>
      `;
    },

    async runTagger() {
      const path = document.getElementById('tagger-path').value;
      const model = document.getElementById('tagger-model').value;
      const threshold = parseFloat(document.getElementById('tagger-threshold').value);
      const additional = document.getElementById('tagger-additional').value;
      const exclude = document.getElementById('tagger-exclude').value;
      const replaceUnderscore = document.getElementById('tagger-replace-underscore').checked;
      const recursive = document.getElementById('tagger-recursive').checked;

      if (!path) { this.toast('Please specify image directory', 'error'); return; }

      this.taggerRunning = true;
      document.getElementById('tagger-stop-btn').disabled = false;
      const output = document.getElementById('tagger-output');
      output.style.display = 'block';
      output.textContent = 'Running tagger...';

      try {
        const resp = await fetch('/api/interrogate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: path,
            interrogator_model: model,
            threshold: threshold,
            additional_tags: additional,
            exclude_tags: exclude,
            replace_underscore: replaceUnderscore,
            batch_input_recursive: recursive,
            batch_output_action_on_conflict: 'ignore',
            add_rating_tag: false,
            add_model_tag: false,
            escape_tag: false,
            character_threshold: 0
          })
        });
        const data = await resp.json();
        if (data.status === 'success') {
          output.textContent = 'Tagger completed successfully.';
          this.toast('Tagger completed', 'success');
        } else {
          output.textContent = 'Error: ' + (data.message || 'Unknown error');
          this.toast(data.message || 'Tagger failed', 'error');
        }
      } catch (e) {
        output.textContent = 'Error: ' + e.message;
        this.toast('Tagger failed: ' + e.message, 'error');
      }

      this.taggerRunning = false;
      document.getElementById('tagger-stop-btn').disabled = true;
    },

    stopTagger() {
      this.taggerRunning = false;
      this.toast('Tagger stopped', 'info');
    },

    localFilePickerTagger(inputId) {
      // Reuse localFilePicker pattern
      fetch('/api/pick_file?picker_type=folder').then(r => r.json()).then(data => {
        if (data.status === 'success' && data.data && data.data.path) {
          document.getElementById(inputId).value = data.data.path;
        }
      }).catch(() => {});
    },

    // ── Tag Editor ──────────────────────────────────────────
    openTagEditor() {
      window.open('/proxy/tageditor', '_blank');
    },

    // ── UI Settings ─────────────────────────────────────────
    loadUISettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('anima-ui-settings') || '{}');
        if (saved.theme) this.theme = saved.theme;
        if (saved.autoLoadHistory !== undefined) this.autoLoadHistory = saved.autoLoadHistory;
        if (saved.tbUrl) this.settingsTbUrl = saved.tbUrl;
        this.refreshSavedConfigs();
      } catch (e) { /* ignore */ }
      this.resolveTheme();
    },

    saveUISettings() {
      const settings = {
        theme: this.theme,
        autoLoadHistory: this.autoLoadHistory,
        tbUrl: this.settingsTbUrl,
      };
      localStorage.setItem('anima-ui-settings', JSON.stringify(settings));
      this.applyTheme();
      this.toast(this.t('common.saved'), 'success');
    },

    onLocaleChange() {
      I18N.setLocale(this.locale);
      this.toast(this.t('settings.localeChanged'), 'info');
      // Rebuild current form
      setTimeout(() => this.rebuildForm(), 300);
    },

    // ── Toast ───────────────────────────────────────────────
    toast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = message;
      container.appendChild(el);

      setTimeout(() => {
        el.classList.add('out');
        el.addEventListener('animationend', () => el.remove());
      }, 2500);
    },

    // ── i18n Shorthand ──────────────────────────────────────
    t(key, fallback) {
      return window.t ? window.t(key, fallback) : (fallback || key);
    },

    onContentScroll() {
      // noop — scroll class handled by CSS :hover
    },

    // ── Cleanup ─────────────────────────────────────────────
    destroy() {
      window.removeEventListener('hashchange', this.handleRoute);
    },

  }));
});
