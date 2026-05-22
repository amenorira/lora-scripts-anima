/* ================================================================
   Anima Trainer UI �?Application Core
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
        { v: 'AdamW', l: 'AdamW' }, { v: 'AdamW8bit', l: 'AdamW8bit' },
        { v: 'PagedAdamW8bit', l: 'PagedAdamW8bit' },
        { v: 'Lion', l: 'Lion' }, { v: 'Lion8bit', l: 'Lion8bit' },
        { v: 'PagedLion8bit', l: 'PagedLion8bit' },
        { v: 'SGDNesterov', l: 'SGDNesterov' }, { v: 'SGDNesterov8bit', l: 'SGDNesterov8bit' },
        { v: 'Prodigy', l: 'Prodigy' }, { v: 'prodigyplus.ProdigyPlusScheduleFree', l: 'ProdigyPlus' },
        { v: 'AdaFactor', l: 'AdaFactor' },
        { v: 'DAdaptation', l: 'DAdaptation' }, { v: 'DAdaptAdam', l: 'DAdaptAdam' },
        { v: 'DAdaptAdaGrad', l: 'DAdaptAdaGrad' }, { v: 'DAdaptAdanIP', l: 'DAdaptAdanIP' },
        { v: 'DAdaptLion', l: 'DAdaptLion' }, { v: 'DAdaptSGD', l: 'DAdaptSGD' },
        { v: 'RAdamScheduleFree', l: 'RAdamScheduleFree' },
        { v: 'pytorch_optimizer.CAME', l: 'CAME' },
      ], descKey: 'field.optimizer_type' },
      { key: 'loss_type', type: 'select', default: '', options: [{ v: '', l: 'Default' }, { v: 'l1', l: 'l1' }, { v: 'l2', l: 'l2' }, { v: 'huber', l: 'huber' }, { v: 'smooth_l1', l: 'smooth_l1' }], descKey: 'field.loss_type' },
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
        { v: 'ddim', l: 'ddim' }, { v: 'euler', l: 'euler' }, { v: 'euler_a', l: 'euler_a' },
        { v: 'heun', l: 'heun' }, { v: 'dpmsolver', l: 'dpmsolver' }, { v: 'dpmsolver++', l: 'dpmsolver++' },
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

const TRAIN_SECTIONS_ANIMA = [
  {
    key: 'animaParams', titleKey: 'section.animaParams',
    fields: [
      { key: 'qwen3', type: 'text', default: '', role: 'file-model', descKey: 'field.qwen3' },
      { key: 'timestep_sampling', type: 'select', default: 'sigmoid', options: [
        { v: 'sigma', l: 'sigma' }, { v: 'uniform', l: 'uniform' }, { v: 'sigmoid', l: 'sigmoid' },
        { v: 'shift', l: 'shift' }, { v: 'flux_shift', l: 'flux_shift' }
      ], descKey: 'field.timestep_sampling' },
      { key: 'sigmoid_scale', type: 'number', default: 1.0, step: 0.001, descKey: 'field.sigmoid_scale' },
      { key: 'weighting_scheme', type: 'select', default: 'uniform', options: [
        { v: 'sigma_sqrt', l: 'sigma_sqrt' }, { v: 'logit_normal', l: 'logit_normal' },
        { v: 'mode', l: 'mode' }, { v: 'cosmap', l: 'cosmap' }, { v: 'none', l: 'none' }, { v: 'uniform', l: 'uniform' }
      ], descKey: 'field.weighting_scheme' },
      { key: 'logit_mean', type: 'number', default: 0.0, step: 0.01, descKey: 'field.logit_mean' },
      { key: 'logit_std', type: 'number', default: 1.0, step: 0.01, descKey: 'field.logit_std' },
      { key: 'qwen3_max_token_length', type: 'number', default: 512, step: 1, descKey: 'field.qwen3_max_token_length' },
      { key: 't5_max_token_length', type: 'number', default: 512, step: 1, descKey: 'field.t5_max_token_length' },
      { key: 'attn_mode', type: 'select', default: 'torch', options: [
        { v: 'torch', l: 'torch' }, { v: 'xformers', l: 'xformers' }, { v: 'flash', l: 'flash' }
      ], descKey: 'field.attn_mode' },
      { key: 'split_attn', type: 'toggle', default: false, descKey: 'field.split_attn' },
      { key: 'torch_compile', type: 'toggle', default: false, descKey: 'field.torch_compile' },
    ]
  },
];

const ROUTE_CONFIG = {
  'home': { title: 'Anima Trainer', subtitle: '' },
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
  Alpine.data('animaApp', () => ({

    // ── State ──────────────────────────────────────────────
    version: '...',
    theme: 'auto',
    resolvedTheme: 'light',
    currentRoute: 'home',
    pageTitle: 'Anima Trainer',
    pageSubtitle: '',
    locale: 'zh-CN',
    i18nReady: true,
    showThemeDropdown: false,
    showLangDropdown: false,

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
      document.title = this.pageTitle + ' | Anima Trainer';

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
        document.title = this.pageTitle + ' | Anima Trainer';
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

      document.title = this.pageTitle + ' | Anima Trainer';
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

    toggleTheme() {
      this.theme = this.resolvedTheme === 'dark' ? 'light' : 'dark';
      this.showThemeDropdown = false;
      // Diffusion animation
      document.documentElement.classList.add('theme-transitioning');
      this.resolveTheme();
      localStorage.setItem('anima-theme', this.theme);
      setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 450);
    },

    setTheme(t) {
      this.theme = t;
      this.showThemeDropdown = false;
      document.documentElement.classList.add('theme-transitioning');
      void document.documentElement.offsetHeight;
      this.resolveTheme();
      localStorage.setItem('anima-theme', t);
      setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 450);
    },

    toggleTheme() {
      this.setTheme(this.resolvedTheme === 'dark' ? 'light' : 'dark');
    },

    themeLabel() {
      if (this.resolvedTheme === 'dark') return this.t('common.themeLight');
      return this.t('common.themeDark');
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
      document.title = this.pageTitle + ' | Anima Trainer';

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
      if (r && r.startsWith('train-')) {
        this.buildTrainForm();
      } else if (r === 'tensorboard') {
        this.loadTbConfig();
      } else if (r === 'tagger') {
        this.buildTaggerForm();
      } else if (r === 'settings') {
        this.loadUISettings();
      }
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
        let opts = '';
        (field.options || []).forEach(o => {
          opts += `<option value="${o.v}">${o.l}</option>`;
        });
        inputHtml = `<select x-model="form.${dataKey}">${opts}</select>`;
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
