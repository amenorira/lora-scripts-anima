/* ================================================================
   Anima Trainer UI — I18n System
   All locale messages embedded for instant synchronous loading.
   Offline-first: no network fetch required.
   ================================================================ */

const MESSAGES = {
  'zh-CN': {
    nav: {
      home: '首页', loraTraining: 'LoRA 训练', basic: '新手 (SD1.5)',
      master: '专家', anima: 'Anima LoRA', flux: 'Flux', sd3: 'SD3.5',
      tools: '工具', tensorboard: 'TensorBoard', tagger: 'Tagger 标签器',
      tagEditor: '标签编辑器', other: '其他', uiSettings: 'UI 设置',
      about: '关于', paramRef: '参数详解'
    },
    section: {
      model: '训练用模型', dataset: '数据集设置', save: '保存设置',
      trainParams: '训练参数', lrOptimizer: '学习率与优化器',
      network: '网络设置', caption: 'Caption 选项', preview: '预览图设置',
      speed: '速度与显存', other: '其他设置', animaParams: 'Anima 专用参数'
    },
    field: {
      pretrained_model_name_or_path: '底模文件路径',
      vae: 'VAE 模型文件路径（SD/SDXL 可选；Anima 必须指定 QwenImage VAE）',
      resume: '从某个 save_state 保存的中断状态继续训练，填写文件路径',
      model_train_type: '训练种类',
      train_data_dir: '训练数据集路径',
      reg_data_dir: '正则化数据集路径。默认留空，不使用正则化图像',
      resolution: '训练图片分辨率，宽x高。支持非正方形，但必须是 64 倍数',
      resolutionHint: '需为 64 的倍数',
      prior_loss_weight: '正则化 - 先验损失权重',
      enable_bucket: '启用 arb 桶以允许非固定宽高比的图片',
      bucket_no_upscale: 'arb 桶不放大图片',
      min_bucket_reso: 'arb 桶最小分辨率',
      max_bucket_reso: 'arb 桶最大分辨率',
      bucket_reso_steps: 'arb 桶分辨率划分单位，SDXL 可以使用 32',
      output_name: '模型保存名称',
      output_dir: '模型保存文件夹',
      save_model_as: '模型保存格式',
      save_precision: '模型保存精度',
      save_every_n_epochs: '每 N epoch（轮）自动保存一次模型',
      save_state: '保存训练状态，配合 resume 参数可以继续从某个状态训练',
      save_last_n_epochs_state: '仅保存最后 n epoch 的训练状态',
      max_train_epochs: '最大训练 epoch（轮数）',
      max_train_steps: '最大训练步数（设置后将覆盖 epoch 限制）',
      train_batch_size: '批量大小，越高显存占用越高',
      gradient_accumulation_steps: '梯度累加步数（等效增大 batch size，不增加显存）',
      gradient_checkpointing: '梯度检查点（用时间换显存，DiT 模型推荐开启）',
      network_train_unet_only: '仅训练主干网络（LoRA 训练推荐开启）',
      network_train_text_encoder_only: '仅训练文本编码器',
      learning_rate: '总学习率。在分开设置 U-Net 与文本编码器学习率后这个值失效',
      unet_lr: 'U-Net 学习率',
      text_encoder_lr: '文本编码器学习率',
      lr_scheduler: '学习率调度器设置',
      lr_scheduler_num_cycles: '重启次数',
      lr_warmup_steps: '学习率预热步数',
      optimizer_type: '优化器设置',
      loss_type: '损失函数类型',
      min_snr_gamma: '最小信噪比伽马值。如果启用推荐为 5',
      weight_decay: '权重衰减。推荐 0.01~0.1，留空则不启用',
      prodigy_d_coef: 'Prodigy 优化器 d_coef 参数',
      network_module: '训练网络模块。SD/SDXL 选 networks.lora；Anima 选 networks.lora_anima；lycoris.kohya 通用',
      network_dim: '网络维度。常用 4~128，不是越大越好，低 dim 可降低显存占用',
      network_alpha: '常用值：等于 network_dim 或 network_dim*1/2 或 1。使用较小的 alpha 需要提升学习率',
      network_weights: '从已有的 LoRA 模型上继续训练，填写路径',
      network_dropout: 'dropout 概率（与 lycoris 不兼容，需要用 lycoris 自带的）',
      scale_weight_norms: '最大范数正则化。如果使用，推荐为 1',
      enable_base_weight: '启用基础权重（差异炼丹）',
      base_weights: '合并入底模的 LoRA 路径，一行一个路径',
      base_weights_multiplier: '合并入底模的 LoRA 权重，一行一个数字',
      enable_block_weights: '启用分层学习率训练（只支持 U-Net 架构）',
      down_lr_weight: 'U-Net 的 Encoder 层分层学习率权重，共 12 层',
      mid_lr_weight: 'U-Net 的 Mid 层分层学习率权重，共 1 层',
      up_lr_weight: 'U-Net 的 Decoder 层分层学习率权重，共 12 层',
      block_lr_zero_threshold: '分层学习率置 0 阈值',
      caption_extension: 'Tag 文件扩展名',
      max_token_length: '最大 token 长度',
      keep_tokens: '在随机打乱 tokens 时，保留前 N 个不变',
      keep_tokens_separator: '保留 tokens 时使用的分隔符',
      shuffle_caption: '训练时随机打乱 tokens',
      weighted_captions: '使用带权重的 token，不推荐与 shuffle_caption 一同开启',
      caption_dropout_rate: '丢弃全部标签的概率',
      caption_dropout_every_n_epochs: '每 N 个 epoch 丢弃全部标签',
      caption_tag_dropout_rate: '按逗号分隔的标签来随机丢弃 tag 的概率',
      enable_preview: '启用训练预览图',
      sample_prompts: '预览图生成参数。--n 反向提示词，--w 宽，--h 高，--l CFG，--s 步数，--d 种子',
      sample_sampler: '生成预览图所用采样器',
      sample_every_n_epochs: '每 N 个 epoch 生成一次预览图',
      sample_cfg: 'CFG Scale',
      mixed_precision: '训练混合精度。RTX30系列以后也可以指定 bf16',
      xformers: '启用 xformers',
      sdpa: '启用 sdpa',
      cache_latents: '缓存图像 latent，缓存 VAE 输出以减少 VRAM 使用',
      cache_latents_to_disk: '缓存图像 latent 到磁盘',
      cache_text_encoder_outputs: '缓存文本编码器输出，减少显存使用。使用时需要关闭 shuffle_caption',
      cache_text_encoder_outputs_to_disk: '缓存文本编码器输出到磁盘',
      no_half_vae: '不使用半精度 VAE，当出现 NaN detected in latents 报错时使用',
      lowram: '低内存模式。该模式下会将 U-net、文本编码器、VAE 直接加载到显存中',
      full_fp16: '完全使用 FP16 精度',
      full_bf16: '完全使用 BF16 精度',
      persistent_data_loader_workers: '保留加载训练集的 worker，减少每个 epoch 之间的停顿',
      vae_batch_size: 'VAE 编码批量大小',
      seed: '随机种子',
      clip_skip: 'CLIP 跳过层数（仅 SD/SDXL 有效，Anima 忽略）',
      ui_custom_params: '自定义参数。请输入 TOML 格式，将直接覆盖当前界面内任何参数',
      qwen3: 'Qwen3-0.6B 文本编码器路径（.safetensors 文件或 HuggingFace 目录）',
      llm_adapter_path: 'LLM Adapter 模型路径，留空则从 DiT 模型自动加载',
      t5_tokenizer_path: 'T5 分词器路径，留空使用内置 configs/t5_old/',
      timestep_sampling: '时间步采样方式。sigma=对数正态，sigmoid=偏向中间步数',
      sigmoid_scale: 'Sigmoid 采样缩放因子（越大越偏向中间时间步）',
      discrete_flow_shift: 'Rectified Flow 时间步位移',
      weighting_scheme: '时间步损失加权方案',
      logit_mean: 'logit_normal 加权均值',
      logit_std: 'logit_normal 加权标准差',
      mode_scale: 'Mode 加权缩放',
      qwen3_max_token_length: 'Qwen3 最大 token 长度',
      t5_max_token_length: 'T5 最大 token 长度',
      attn_mode: '注意力实现方式。torch=原生兼容；xformers=省显存需 split_attn；flash=FlashAttention 最快，RTX 40/50 系推荐',
      split_attn: '拆分注意力计算以降低显存占用（使用 xformers 时必须开启）',
      torch_compile: '使用 torch.compile 加速训练（需 PyTorch 2.0+，首次编译较慢）',
      text_encoder_batch_size: '文本编码器批量大小（留空使用数据集 batch size）',
      unsloth_offload_checkpointing: '使用 Unsloth 异步卸载梯度检查点，降低显存占用'
    },
    common: {
      startTraining: '开始训练', stopTraining: '终止训练', training: '训练中',
      trainingStarted: '训练已启动', trainingStopped: '训练已终止',
      save: '保存', load: '读取', download: '下载', import: '导入', export: '导出',
      copy: '复制', copied: '已复制到剪贴板', resetAll: '全部重置',
      allReset: '已恢复默认值', saved: '已保存', loaded: '已加载',
      downloaded: '已下载', imported: '已导入', close: '关闭',
      themeLight: '浅色模式', themeDark: '深色模式', themeAuto: '跟随系统',
      autoLoadedHistory: '已自动加载历史参数',
      enterConfigName: '请输入配置名称', noConfigs: '暂无保存的配置',
      tomlPreview: '参数预览',
      requestFailed: '请求失败', failed: '失败',
      invalidToml: '无有效TOML配置', parseError: '解析错误',
      localPickerNA: '本地文件选择不可用', fileBrowserFailed: '文件浏览失败',
      specifyDir: '请指定目录'
    },
    tagger: {
      title: 'Tagger 标注工具', subtitle: '使用 WD14 模型自动为图片打标',
      description: '后端基于 wd14-tagger 开发。训练包内自带默认离线模型。推荐阈值大于 0.35。',
      start: '启动', stop: '停止', completed: '标注完成', running: '标注中...'
    },
    tagEditor: { title: '标签编辑器', subtitle: '编辑图片的标签和标注文本', openEditor: '打开标签编辑器' },
    tools: { title: '工具', subtitle: 'LoRA 提取、合并、转换等实用工具' },
    settings: {
      title: 'UI 设置', subtitle: '自定义训练 UI 体验',
      theme: '主题', themeDesc: '选择您偏好的外观主题',
      language: '语言', languageDesc: '界面显示语言（更多语言敬请期待）',
      autoLoadHistory: '自动加载历史参数', autoLoadHistoryDesc: '启动时自动恢复上次的训练参数',
      tensorboardUrl: 'TensorBoard 地址', tensorboardUrlDesc: '自定义 TensorBoard 访问地址',
      localeChanged: '语言已切换，正在重新渲染...'
    },
    about: {
      title: '关于', subtitle: 'Anima Trainer',
      version: '版本', description: '描述',
      descriptionText: 'Stable Diffusion LoRA / Dreambooth 训练的现代化 Web UI',
      github: 'GitHub', basedOn: '基于', modifiedBy: '修改者', frontend: '前端'
    }
  },

  'en-US': {
    nav: {
      home: 'Home', loraTraining: 'LoRA Training', basic: 'Beginner (SD1.5)',
      master: 'Expert', anima: 'Anima LoRA', flux: 'Flux', sd3: 'SD3.5',
      tools: 'Tools', tensorboard: 'TensorBoard', tagger: 'Tagger',
      tagEditor: 'Tag Editor', other: 'Other', uiSettings: 'UI Settings',
      about: 'About', paramRef: 'Parameter Ref'
    },
    section: {
      model: 'Training Model', dataset: 'Dataset Settings', save: 'Save Settings',
      trainParams: 'Training Parameters', lrOptimizer: 'Learning Rate & Optimizer',
      network: 'Network Settings', caption: 'Caption Options', preview: 'Preview Settings',
      speed: 'Speed & VRAM', other: 'Other Settings', animaParams: 'Anima Parameters'
    },
    field: {
      pretrained_model_name_or_path: 'Base model file path',
      vae: 'VAE model file path (optional for SD/SDXL; required for Anima)',
      resume: 'Resume from a save_state checkpoint. Fill in the file path.',
      model_train_type: 'Training type',
      train_data_dir: 'Training dataset directory',
      reg_data_dir: 'Regularization dataset path. Leave empty to skip regularization.',
      resolution: 'Training image resolution, width x height. Must be a multiple of 64.',
      resolutionHint: 'Must be a multiple of 64',
      prior_loss_weight: 'Prior loss weight for regularization',
      enable_bucket: 'Enable ARB bucketing for non-square aspect ratios',
      bucket_no_upscale: 'Do not upscale images in buckets',
      min_bucket_reso: 'Minimum bucket resolution',
      max_bucket_reso: 'Maximum bucket resolution',
      bucket_reso_steps: 'Bucket resolution step size (SDXL can use 32)',
      output_name: 'Model save name',
      output_dir: 'Model output directory',
      save_model_as: 'Model save format',
      save_precision: 'Model save precision',
      save_every_n_epochs: 'Save model every N epochs',
      save_state: 'Save training state for resuming later',
      save_last_n_epochs_state: 'Only keep last N epochs of training state',
      max_train_epochs: 'Maximum training epochs',
      max_train_steps: 'Maximum training steps (overrides epochs)',
      train_batch_size: 'Batch size. Higher = more VRAM usage.',
      gradient_accumulation_steps: 'Gradient accumulation steps',
      gradient_checkpointing: 'Gradient checkpointing (trade time for VRAM)',
      network_train_unet_only: 'Train backbone only (recommended for LoRA)',
      network_train_text_encoder_only: 'Train text encoder only',
      learning_rate: 'Overall learning rate',
      unet_lr: 'U-Net learning rate',
      text_encoder_lr: 'Text encoder learning rate',
      lr_scheduler: 'Learning rate scheduler',
      lr_scheduler_num_cycles: 'Number of restart cycles',
      lr_warmup_steps: 'Learning rate warmup steps',
      optimizer_type: 'Optimizer',
      loss_type: 'Loss function type',
      min_snr_gamma: 'Minimum SNR gamma. Recommended: 5 if enabled.',
      weight_decay: 'Weight decay. Recommended 0.01~0.1. Leave empty to disable.',
      prodigy_d_coef: 'Prodigy optimizer d_coef parameter',
      network_module: 'Training network module',
      network_dim: 'Network dimension. Common range 4~128. Lower dim reduces VRAM.',
      network_alpha: 'Common values: equal to network_dim, or half, or 1.',
      network_weights: 'Resume from existing LoRA weights. Fill in the file path.',
      network_dropout: 'Dropout probability (incompatible with lycoris)',
      scale_weight_norms: 'Max norm regularization. Recommended: 1 if used.',
      enable_base_weight: 'Enable base weight (difference training)',
      base_weights: 'LoRA paths to merge into base model, one per line',
      base_weights_multiplier: 'LoRA weight multipliers, one per line',
      enable_block_weights: 'Enable block-wise learning rate',
      down_lr_weight: 'U-Net Encoder block LR weights (12 layers)',
      mid_lr_weight: 'U-Net Mid block LR weight (1 layer)',
      up_lr_weight: 'U-Net Decoder block LR weights (12 layers)',
      block_lr_zero_threshold: 'Block LR zero threshold',
      caption_extension: 'Tag file extension',
      max_token_length: 'Maximum token length',
      keep_tokens: 'Keep first N tokens unchanged when shuffling',
      keep_tokens_separator: 'Separator used for kept tokens',
      shuffle_caption: 'Randomly shuffle tokens during training',
      weighted_captions: 'Use weighted tokens',
      caption_dropout_rate: 'Probability of dropping all tags for an image',
      caption_dropout_every_n_epochs: 'Drop all tags every N epochs',
      caption_tag_dropout_rate: 'Probability of randomly dropping individual tags',
      enable_preview: 'Enable training preview images',
      sample_prompts: 'Preview prompt. --n negative, --w width, --h height, --l CFG, --s steps, --d seed',
      sample_sampler: 'Sampler for preview images',
      sample_every_n_epochs: 'Generate previews every N epochs',
      sample_cfg: 'CFG Scale',
      mixed_precision: 'Training precision. RTX 30+ can use bf16.',
      xformers: 'Enable xformers acceleration',
      sdpa: 'Enable SDPA attention',
      cache_latents: 'Cache image latents to reduce VRAM',
      cache_latents_to_disk: 'Cache image latents to disk',
      cache_text_encoder_outputs: 'Cache text encoder outputs. Disable shuffle_caption when using.',
      cache_text_encoder_outputs_to_disk: 'Cache text encoder outputs to disk',
      no_half_vae: 'Disable half-precision VAE',
      lowram: 'Low VRAM mode',
      full_fp16: 'Use full FP16 precision',
      full_bf16: 'Use full BF16 precision',
      persistent_data_loader_workers: 'Keep data loader workers alive between epochs',
      vae_batch_size: 'VAE encoding batch size',
      seed: 'Random seed',
      clip_skip: 'CLIP skip layers (SD/SDXL only)',
      ui_custom_params: 'Custom parameters in TOML format. Will override UI settings.',
      qwen3: 'Qwen3-0.6B text encoder path',
      llm_adapter_path: 'LLM Adapter model path',
      t5_tokenizer_path: 'T5 tokenizer path',
      timestep_sampling: 'Timestep sampling method',
      sigmoid_scale: 'Sigmoid sampling scale factor',
      discrete_flow_shift: 'Rectified Flow timestep shift',
      weighting_scheme: 'Timestep loss weighting scheme',
      logit_mean: 'logit_normal weighting mean',
      logit_std: 'logit_normal weighting std deviation',
      mode_scale: 'Mode weighting scale',
      qwen3_max_token_length: 'Qwen3 max token length',
      t5_max_token_length: 'T5 max token length',
      attn_mode: 'Attention implementation. torch=native; xformers=VRAM efficient; flash=fastest.',
      split_attn: 'Split attention computation (required with xformers)',
      torch_compile: 'Use torch.compile (requires PyTorch 2.0+)',
      text_encoder_batch_size: 'Text encoder batch size',
      unsloth_offload_checkpointing: 'Use Unsloth async offload gradient checkpointing'
    },
    common: {
      startTraining: 'Start Training', stopTraining: 'Stop Training', training: 'Training',
      trainingStarted: 'Training started', trainingStopped: 'Training stopped',
      save: 'Save', load: 'Load', download: 'Download', import: 'Import', export: 'Export',
      copy: 'Copy', copied: 'Copied to clipboard', resetAll: 'Reset All',
      allReset: 'All parameters reset to defaults', saved: 'Saved successfully',
      loaded: 'Loaded successfully', downloaded: 'Downloaded', imported: 'Imported',
      close: 'Close', themeLight: 'Light Mode', themeDark: 'Dark Mode', themeAuto: 'Auto',
      autoLoadedHistory: 'Auto-loaded previous parameters',
      enterConfigName: 'Enter configuration name', noConfigs: 'No saved configurations',
      tomlPreview: 'Parameter Preview',
      requestFailed: 'Request failed', failed: 'Failed',
      invalidToml: 'No valid TOML keys', parseError: 'Parse error',
      localPickerNA: 'Local picker unavailable', fileBrowserFailed: 'File browser failed',
      specifyDir: 'Please specify a directory'
    },
    tagger: {
      title: 'Tagger', subtitle: 'Auto-tag images using WD14 models',
      description: 'Backend powered by wd14-tagger. Built-in offline model included. Recommended threshold > 0.35.',
      start: 'Start', stop: 'Stop', completed: 'Tagging completed', running: 'Tagging...'
    },
    tagEditor: { title: 'Tag Editor', subtitle: 'Edit image tags and captions', openEditor: 'Open Tag Editor' },
    tools: { title: 'Tools', subtitle: 'LoRA extraction, merging, conversion utilities' },
    settings: {
      title: 'UI Settings', subtitle: 'Customize your training UI experience',
      theme: 'Theme', themeDesc: 'Choose your preferred appearance',
      language: 'Language', languageDesc: 'Interface display language',
      autoLoadHistory: 'Auto-load History', autoLoadHistoryDesc: 'Automatically restore last training parameters on startup',
      tensorboardUrl: 'TensorBoard URL', tensorboardUrlDesc: 'Custom TensorBoard address override',
      localeChanged: 'Language changed, re-rendering...'
    },
    about: {
      title: 'About', subtitle: 'Anima Trainer', version: 'Version', description: 'Description',
      descriptionText: 'A modern web UI for Stable Diffusion LoRA / Dreambooth training.',
      github: 'GitHub', basedOn: 'Based on', modifiedBy: 'Modified by', frontend: 'Frontend'
    }
  }
};

const I18N = (() => {
  let _locale = 'zh-CN';
  let _messages = MESSAGES['zh-CN'];

  function init(locale) {
    _locale = locale || localStorage.getItem('anima-locale') || 'zh-CN';
    _messages = MESSAGES[_locale] || MESSAGES['zh-CN'];
  }

  function t(key, fallback) {
    if (!_messages) return fallback || key;
    const parts = key.split('.');
    let val = _messages;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') return fallback || key;
      val = val[p];
    }
    return (val !== undefined && val !== null) ? val : (fallback || key);
  }

  function getLocale() { return _locale; }

  function setLocale(loc) {
    _locale = loc;
    localStorage.setItem('anima-locale', loc);
    _messages = MESSAGES[_locale] || MESSAGES['zh-CN'];
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: { locale: loc } }));
  }

  return { init, t, getLocale, setLocale };
})();

window.I18N = I18N;
window.t = (key, fallback) => I18N.t(key, fallback);
