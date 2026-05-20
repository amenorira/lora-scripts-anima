Schema.intersect([
    Schema.intersect([
        Schema.object({
            model_train_type: Schema.union(["sd-lora", "sdxl-lora", "anima-lora"]).default("sd-lora").description("训练种类"),
            pretrained_model_name_or_path: Schema.string().role('filepicker', { type: "model-file" }).default("./sd-models/model.safetensors").description("底模文件路径"),
            resume: Schema.string().role('filepicker', { type: "folder" }).description("从某个 `save_state` 保存的中断状态继续训练，填写文件路径"),
            vae: Schema.string().role('filepicker', { type: "model-file" }).description("(可选) VAE 模型文件路径，使用外置 VAE 文件覆盖模型内本身的"),
        }).description("训练用模型"),

        // Anima 专用模型路径
        Schema.union([
            Schema.object({
                model_train_type: Schema.const("anima-lora").required(),
                qwen3: Schema.string().role('filepicker', { type: "model-file" }).description("Qwen3-0.6B 文本编码器路径（.safetensors 文件或 HuggingFace 目录）"),
                llm_adapter_path: Schema.string().role('filepicker', { type: "model-file" }).description("(可选) LLM Adapter 模型路径，留空则从 DiT 模型自动加载"),
                t5_tokenizer_path: Schema.string().role('filepicker', { type: "folder" }).description("(可选) T5 分词器路径，留空使用内置 configs/t5_old/"),
            }),
            Schema.object({}),
        ]),

        Schema.union([
            Schema.object({
                model_train_type: Schema.const("sd-lora"),
                v2: Schema.boolean().default(false).description("底模为 sd2.0 以后的版本需要启用"),
            }),
            Schema.object({}),
        ]),

        Schema.union([
            Schema.object({
                model_train_type: Schema.const("sd-lora"),
                v2: Schema.const(true).required(),
                v_parameterization: Schema.boolean().default(false).description("v-parameterization 学习"),
                scale_v_pred_loss_like_noise_pred: Schema.boolean().default(false).description("缩放 v-prediction 损失（与v-parameterization配合使用）"),
            }),
            Schema.object({}),
        ]),
    ]),

    // 数据集设置
    Schema.object(
        UpdateSchema(SHARED_SCHEMAS.RAW.DATASET_SETTINGS, {
            resolution: Schema.string().default("1024,1024").description("训练图片分辨率，宽x高。支持非正方形，但必须是 64 倍数。"),
            min_bucket_reso: Schema.number().default(256).description("arb 桶最小分辨率"),
            max_bucket_reso: Schema.number().default(2048).description("arb 桶最大分辨率"),
        })
    ).description("数据集设置"),

    // Anima 专用分桶步长覆盖（Anima VAE 要求 16 的倍数）
    Schema.union([
        Schema.object({
            model_train_type: Schema.const("anima-lora").required(),
            bucket_reso_steps: Schema.number().step(16).default(16).description("arb 桶分辨率划分单位（Anima 必须为 16 的倍数）"),
        }).description(""),
        Schema.object({}),
    ]),

    // 保存设置
    SHARED_SCHEMAS.SAVE_SETTINGS,

    Schema.object({
        max_train_epochs: Schema.number().min(1).default(10).description("最大训练 epoch（轮数）"),
        max_train_steps: Schema.number().min(1).description("最大训练步数（设置后将覆盖 epoch 限制）"),
        train_batch_size: Schema.number().min(1).default(1).description("批量大小, 越高显存占用越高"),
        gradient_checkpointing: Schema.boolean().default(false).description("梯度检查点（用时间换显存，DiT 模型推荐开启）"),
        gradient_accumulation_steps: Schema.number().min(1).description("梯度累加步数（等效增大 batch size，不增加显存）"),
        network_train_unet_only: Schema.boolean().default(false).description("仅训练 U-Net 训练SDXL Lora时推荐开启"),
        network_train_text_encoder_only: Schema.boolean().default(false).description("仅训练文本编码器"),
        cpu_offload_checkpointing: Schema.boolean().default(false).description("[实验性] 梯度检查点时将张量卸载到 CPU（降显存，DiT 模型支持）"),
    }).description("训练相关参数"),

    // Anima 专用训练参数
    Schema.union([
        Schema.object({
            model_train_type: Schema.const("anima-lora").required(),
            timestep_sampling: Schema.union(["sigma", "uniform", "sigmoid", "shift", "flux_shift"]).default("sigmoid").description("时间步采样方式（sigma=对数正态, sigmoid=偏向中间步数, shift=位移分布, flux_shift=FLUX位移）"),
            sigmoid_scale: Schema.number().step(0.001).default(1.0).description("Sigmoid 采样缩放因子（越大越偏向中间时间步）"),
            discrete_flow_shift: Schema.number().step(0.001).default(1.0).description("Rectified Flow 时间步位移（仅 timestep_sampling=shift 时生效）"),
            weighting_scheme: Schema.union(["sigma_sqrt", "logit_normal", "mode", "cosmap", "none", "uniform"]).default("uniform").description("时间步损失加权方案（uniform=均匀, sigma_sqrt=依sigma加权, logit_normal=对数正态, mode=众数附近, cosmap=余弦映射）"),
            logit_mean: Schema.number().step(0.01).default(0.0).description("logit_normal 加权均值（仅 weighting_scheme=logit_normal 时生效）"),
            logit_std: Schema.number().step(0.01).default(1.0).description("logit_normal 加权标准差（仅 weighting_scheme=logit_normal 时生效）"),
            mode_scale: Schema.number().step(0.01).default(1.29).description("Mode 加权缩放（仅 weighting_scheme=mode 时生效）"),
            qwen3_max_token_length: Schema.number().step(1).default(512).description("Qwen3 最大 token 长度"),
            t5_max_token_length: Schema.number().step(1).default(512).description("T5 最大 token 长度"),
            attn_mode: Schema.union(["torch", "xformers", "flash"]).default("torch").description("注意力实现方式（torch=原生, xformers=省显存, flash=FlashAttention最快但需硬件支持）"),
            split_attn: Schema.boolean().default(false).description("拆分注意力计算以降低显存占用（使用 xformers 时必须开启）"),
            torch_compile: Schema.boolean().default(false).description("使用 torch.compile 加速训练（需 PyTorch 2.0+，首次编译较慢）"),
            dynamo_backend: Schema.union(["inductor", "eager", "aot_eager", "cudagraphs"]).default("inductor").description("torch.compile 后端（默认 inductor，cudagraphs 最快但可能不稳定）"),
            self_attn_lr: Schema.string().description("Self-Attention 层学习率（留空=跟随总学习率，填 0=冻结该组件）"),
            cross_attn_lr: Schema.string().description("Cross-Attention 层学习率"),
            mlp_lr: Schema.string().description("MLP 层学习率"),
            mod_lr: Schema.string().description("AdaLN 调制层学习率（注意：LoRA 默认不训练 mod 层）"),
            llm_adapter_lr: Schema.string().description("LLM Adapter 学习率（留空=跟随总学习率，填 0=冻结）"),
        }).description("Anima 专用参数"),
        Schema.object({}),
    ]),

    // 学习率&优化器设置
    SHARED_SCHEMAS.LR_OPTIMIZER,

    Schema.intersect([
        Schema.object({
            network_module: Schema.union(["networks.lora", "networks.dylora", "networks.oft", "lycoris.kohya"]).default("networks.lora").description("训练网络模块"),
            network_weights: Schema.string().role('filepicker').description("从已有的 LoRA 模型上继续训练，填写路径"),
            network_dim: Schema.number().min(1).default(32).description("网络维度，常用 4~128，不是越大越好, 低dim可以降低显存占用"),
            network_alpha: Schema.number().min(1).default(32).description("常用值：等于 network_dim 或 network_dim*1/2 或 1。使用较小的 alpha 需要提升学习率"),
            network_dropout: Schema.number().step(0.01).default(0).description('dropout 概率 （与 lycoris 不兼容，需要用 lycoris 自带的）'),
            scale_weight_norms: Schema.number().step(0.01).min(0).description("最大范数正则化。如果使用，推荐为 1"),
            network_args_custom: Schema.array(String).role('table').description('自定义 network_args，一行一个'),
            enable_block_weights: Schema.boolean().default(false).description('启用分层学习率训练（只支持网络模块 networks.lora）'),
            enable_base_weight: Schema.boolean().default(false).description('启用基础权重（差异炼丹）'),
        }).description("网络设置"),

        // Anima 专用网络模块
        Schema.union([
            Schema.object({
                model_train_type: Schema.const("anima-lora").required(),
                network_module: Schema.union(["networks.lora_anima", "lycoris.kohya"]).default("networks.lora_anima").description("训练网络模块（Anima 推荐 networks.lora_anima）"),
                network_dim: Schema.number().min(1).default(32).description("网络维度，常用 4~128，不是越大越好"),
                network_alpha: Schema.number().min(1).default(16).description("常用值：等于 network_dim 或 network_dim*1/2 或 1。"),
                dim_from_weights: Schema.boolean().default(false).description("从已有 LoRA 权重文件自动推断 dim（开启后上方 network_dim 失效）"),
            }),
            Schema.object({}),
        ]),

        // lycoris 参数
        SHARED_SCHEMAS.LYCORIS_MAIN,
        SHARED_SCHEMAS.LYCORIS_LOKR,

        // dylora 参数
        SHARED_SCHEMAS.NETWORK_OPTION_DYLORA,

        // 分层学习率参数
        SHARED_SCHEMAS.NETWORK_OPTION_BLOCK_WEIGHTS,

        SHARED_SCHEMAS.NETWORK_OPTION_BASEWEIGHT,
    ]),

    // 预览图设置
    SHARED_SCHEMAS.PREVIEW_IMAGE,

    // 日志设置
    SHARED_SCHEMAS.LOG_SETTINGS,

    // caption 选项
    Schema.object(SHARED_SCHEMAS.RAW.CAPTION_SETTINGS).description("caption（Tag）选项"),

    // 噪声设置
    SHARED_SCHEMAS.NOISE_SETTINGS,

    // 数据增强
    SHARED_SCHEMAS.DATA_ENCHANCEMENT,

    // 其他选项
    SHARED_SCHEMAS.OTHER,

    // 速度优化选项
    Schema.object(SHARED_SCHEMAS.RAW.PRECISION_CACHE_BATCH).description("速度优化选项"),

    // Anima 显存优化 & 高级选项
    Schema.union([
        Schema.object({
            model_train_type: Schema.const("anima-lora").required(),
            cache_text_encoder_outputs: Schema.boolean().default(true).description("缓存文本编码器的输出，减少显存使用（Anima 推荐开启）"),
            cache_text_encoder_outputs_to_disk: Schema.boolean().default(true).description("缓存文本编码器的输出到磁盘"),
            text_encoder_batch_size: Schema.number().min(1).description("文本编码器批量大小（留空使用数据集 batch size）"),
            blocks_to_swap: Schema.number().min(0).description("[实验性] 前向/反向传播时交换到 CPU 的 Transformer block 数量，降低显存但增加训练时间"),
            unsloth_offload_checkpointing: Schema.boolean().default(false).description("使用 Unsloth 异步卸载梯度检查点（不可与 blocks_to_swap 同时使用）"),
            disable_mmap_load_safetensors: Schema.boolean().default(false).description("禁用 safetensors 的 mmap 加载（WSL 环境下可加速）"),
            vae_chunk_size: Schema.number().step(1).description("VAE 编码空间分块大小（偶数），用于降低显存，留空关闭"),
            vae_disable_cache: Schema.boolean().default(false).description("禁用 VAE 内部缓存以降低显存"),
        }).description("Anima 显存优化"),
        Schema.object({}),
    ]),

    // Anima 验证设置
    Schema.union([
        Schema.object({
            model_train_type: Schema.const("anima-lora").required(),
            validation_split: Schema.number().min(0).max(1).step(0.01).description("从训练集中划分多少比例作为验证集（0=不划分）"),
            validation_seed: Schema.number().description("验证集随机种子（留空则使用训练 seed）"),
            validate_every_n_steps: Schema.number().min(1).description("每 N 步执行一次验证（留空=仅每 epoch 验证）"),
            validate_every_n_epochs: Schema.number().min(1).description("每 N 个 epoch 执行一次验证（留空=每个 epoch 都验证）"),
            max_validation_steps: Schema.number().min(1).description("验证时最多处理的样本数（留空=全量验证）"),
        }).description("Anima 验证设置"),
        Schema.object({}),
    ]),

    // 分布式训练
    SHARED_SCHEMAS.DISTRIBUTED_TRAINING
]);
