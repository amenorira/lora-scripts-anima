/* ================================================================
   patch_i18n_usability.js — 一次性 i18n 补丁脚本
   为 LoRA 训练参数易用性改造补充所有新增字段的文案：
     - 新增 field.* 描述与 hint
     - 新增 opt.* 选项描述
     - common.advancedParams（进阶参数折叠区标题）
     - 修正 C3：timestep_sampling 描述（sigmoid 实为 logit_normal）
   用法：node tools/patch_i18n_usability.js
   幂等：已存在的键保留原值，仅补充缺失键；timestep_sampling 会被覆盖为修正版。
   ================================================================ */
const fs = require('fs');
const path = require('path');

const I18N_DIR = path.resolve(__dirname, '..', 'frontend', 'i18n');

// ── 新增/修正条目 ──
// field.* 描述（zh / en）
const FIELD_ZH = {
  // 新增字段
  dim_from_weights: '从 network_weights 自动推断 dim(rank)',
  dim_from_weightsHint: '启用后忽略 network_dim，按已有 LoRA 权重推断秩',
  cuda_allow_tf32: '允许 TF32 精度（Ampere 及以上 GPU）',
  cuda_allow_tf32Hint: 'Ampere+ GPU 几乎免费的 20~30% 加速，强烈建议开启',
  cuda_cudnn_benchmark: '启用 cuDNN benchmark 模式',
  cuda_cudnn_benchmarkHint: '固定分辨率下自动选最快卷积算法，提升性能',
  vae_batch_size: 'VAE 编码批大小',
  vae_batch_sizeHint: '留空=默认 1；增大可加速缓存，但增加显存占用',
  unsloth_offload_checkpointing: 'Unsloth 异步 CPU 卸载检查点',
  unsloth_offload_checkpointingHint: '比 cpu_offload_checkpointing 更快；不可与 blocks_to_swap 同用',
  compile: 'Anima 块级 torch.compile（需 Triton）',
  compileHint: 'DiT 逐块编译加速；与 torch_compile / blocks_to_swap 互斥，adapter 会自动校验',
  compile_backend: '编译后端',
  compile_mode: '编译模式',
  compile_dynamic: '动态形状模式',
  compile_cache_size_limit: 'dynamo 缓存大小上限',
  compile_cache_size_limitHint: '留空=PyTorch 默认(8~32)；推荐 32',
  persistent_data_loader_workers: '持久化 DataLoader 工作进程',
  persistent_data_loader_workersHint: '减少 epoch 间等待，大数据集有用；略增内存占用',
  max_data_loader_n_workers: 'DataLoader 最大工作进程数',
  max_data_loader_n_workersHint: '留空=默认 8；调低省内存，调快数据加载',
  save_last_n_epochs: '仅保留最近 N 个模型',
  save_last_n_epochsHint: '配合 save_every_n_epochs 使用，防止磁盘爆满；留空=不限制',
  save_state_on_train_end: '仅在训练结束时保存 state',
  debiased_estimation_loss: '去偏估计损失（debiased estimation loss）',
  noise_offset_random_strength: 'noise_offset 随机强度',
  noise_offsetHint: '推荐 0.1，用于改善亮度/对比度；留空=关闭',
  adaptive_noise_scale: '自适应噪声尺度（需配合 noise_offset）',
  min_snr_gammaHint: '降低高损失时间步权重，论文推荐 5；留空=关闭',
  multires_noise_iterations: '多分辨率噪声迭代次数',
  multires_noise_discount: '多分辨率噪声折扣值',
  ip_noise_gamma: '输入扰动噪声 gamma（正则化）',
  ip_noise_gamma_random_strength: '输入扰动噪声随机强度',
  // 修正 C3：sigmoid 实为 logit_normal（anima_train_utils.py 注释明确）
  timestep_sampling: '时间步采样方式（Anima）。sigmoid=logit-normal，sigma=对数正态，shift=可配合 discrete_flow_shift',
  cache_text_encoder_outputsHint: '强烈建议开启：缓存文本编码器输出可大幅省显存、提速（需 unet_only）',
  network_dropoutHint: '与 LyCORIS dropout 不兼容，仅 networks.lora 可用',
  scale_weight_normsHint: '通常留空；过拟合时设为 1（最大范数正则化）',
};
const FIELD_EN = {
  dim_from_weights: 'Infer dim (rank) from network_weights',
  dim_from_weightsHint: 'Ignores network_dim; derives rank from existing LoRA weights',
  cuda_allow_tf32: 'Allow TF32 on Ampere+ GPUs',
  cuda_allow_tf32Hint: 'Nearly free 20~30% speedup on Ampere+ GPUs. Strongly recommended.',
  cuda_cudnn_benchmark: 'Enable cuDNN benchmark mode',
  cuda_cudnn_benchmarkHint: 'Auto-picks fastest conv kernel at fixed resolution',
  vae_batch_size: 'VAE encode batch size',
  vae_batch_sizeHint: 'Empty=default 1; larger speeds up caching but uses more VRAM',
  unsloth_offload_checkpointing: 'Unsloth async CPU offload checkpointing',
  unsloth_offload_checkpointingHint: 'Faster than cpu_offload_checkpointing; incompatible with blocks_to_swap',
  compile: 'Anima per-block torch.compile (requires Triton)',
  compileHint: 'Per-DiT-block compile speedup; mutually exclusive with torch_compile / blocks_to_swap (adapter validates)',
  compile_backend: 'Compile backend',
  compile_mode: 'Compile mode',
  compile_dynamic: 'Dynamic shapes mode',
  compile_cache_size_limit: 'Dynamo cache size limit',
  compile_cache_size_limitHint: 'Empty=PyTorch default (8~32); recommended 32',
  persistent_data_loader_workers: 'Persistent DataLoader workers',
  persistent_data_loader_workersHint: 'Reduces inter-epoch wait; useful for large datasets, slightly more RAM',
  max_data_loader_n_workers: 'Max DataLoader workers',
  max_data_loader_n_workersHint: 'Empty=default 8; lower saves RAM, higher speeds loading',
  save_last_n_epochs: 'Keep only last N models',
  save_last_n_epochsHint: 'Pairs with save_every_n_epochs to avoid disk overflow; empty=no limit',
  save_state_on_train_end: 'Save state only at training end',
  debiased_estimation_loss: 'Debiased estimation loss',
  noise_offset_random_strength: 'Random strength for noise_offset',
  noise_offsetHint: '~0.1 recommended; improves brightness/contrast. Empty=off',
  adaptive_noise_scale: 'Adaptive noise scale (requires noise_offset)',
  min_snr_gammaHint: 'Down-weights high-loss timesteps; paper recommends 5. Empty=off',
  multires_noise_iterations: 'Multires noise iterations',
  multires_noise_discount: 'Multires noise discount',
  ip_noise_gamma: 'Input perturbation noise gamma (regularization)',
  ip_noise_gamma_random_strength: 'Random strength for input perturbation noise',
  timestep_sampling: 'Timestep sampling (Anima). sigmoid=logit-normal, sigma=lognormal, shift=pairs with discrete_flow_shift',
  cache_text_encoder_outputsHint: 'Strongly recommended: caches text encoder outputs to save VRAM and speed up (needs unet_only)',
  network_dropoutHint: 'Incompatible with LyCORIS dropout; only for networks.lora',
  scale_weight_normsHint: 'Usually empty; set 1 for max-norm regularization when overfitting',
};

// opt.* 选项描述
const OPT_ZH = {
  compile_backend_inductor: '默认编译后端，优化程度最高',
  compile_backend_eager: '兼容性最好，Windows 推荐',
  compile_backend_cudagraphs: '利用 CUDA Graph 减少内核启动开销',
  compile_mode_default: '默认模式，训练推荐',
  compile_mode_reduce_overhead: '减少开销模式',
  compile_mode_max_autotune: '最大自动调优',
  compile_mode_max_autotune_no_cudagraphs: '最大调优（禁用 CUDA Graph）',
  compile_dynamic_auto: '自动（默认）',
  compile_dynamic_true: '启用动态形状（Windows 需 VS2022 C++）',
  compile_dynamic_false: '禁用动态形状',
};
const OPT_EN = {
  compile_backend_inductor: 'Default backend, highest optimization',
  compile_backend_eager: 'Best compatibility, recommended on Windows',
  compile_backend_cudagraphs: 'Reduces kernel launch overhead via CUDA Graph',
  compile_mode_default: 'Default mode, recommended for training',
  compile_mode_reduce_overhead: 'Reduce-overhead mode',
  compile_mode_max_autotune: 'Max auto-tune',
  compile_mode_max_autotune_no_cudagraphs: 'Max tune without CUDA Graphs',
  compile_dynamic_auto: 'Auto (default)',
  compile_dynamic_true: 'Enable dynamic shapes (needs VS2022 C++ on Windows)',
  compile_dynamic_false: 'Disable dynamic shapes',
};

// common.*
const COMMON_ZH = { advancedParams: '显示进阶参数' };
const COMMON_EN = { advancedParams: 'Show advanced parameters' };

// 始终覆盖（修正项）
const ALWAYS_OVERWRITE_FIELD = ['timestep_sampling'];

function patch(locale) {
  const file = path.join(I18N_DIR, locale + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fieldSrc = locale === 'zh-CN' ? FIELD_ZH : FIELD_EN;
  const optSrc = locale === 'zh-CN' ? OPT_ZH : OPT_EN;
  const commonSrc = locale === 'zh-CN' ? COMMON_ZH : COMMON_EN;

  data.field = data.field || {};
  let addedF = 0, overwF = 0;
  for (const [k, v] of Object.entries(fieldSrc)) {
    if (data.field[k] === undefined || ALWAYS_OVERWRITE_FIELD.includes(k)) {
      if (data.field[k] === undefined) addedF++; else overwF++;
      data.field[k] = v;
    } else {
      // 已存在且非修正项：保留原值
    }
  }
  data.opt = data.opt || {};
  let addedO = 0;
  for (const [k, v] of Object.entries(optSrc)) {
    if (data.opt[k] === undefined) { data.opt[k] = v; addedO++; }
  }
  data.common = data.common || {};
  let addedC = 0;
  for (const [k, v] of Object.entries(commonSrc)) {
    if (data.common[k] === undefined) { data.common[k] = v; addedC++; }
  }

  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`[${locale}] field +${addedF} (overwrote ${overwF}), opt +${addedO}, common +${addedC}`);
}

patch('zh-CN');
patch('en-US');
console.log('i18n patch done.');
