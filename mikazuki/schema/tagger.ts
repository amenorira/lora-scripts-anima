Schema.intersect([
    Schema.object({
        interrogator_model: Schema.union(["cl_tagger_1_01", "wd-convnext-v3", "wd-swinv2-v3", "wd-vit-v3", "wd14-convnextv2-v2", "wd14-swinv2-v2", "wd14-vit-v2", "wd14-moat-v2", "wd-eva02-large-tagger-v3", "wd-vit-large-tagger-v3"]).default("wd-vit-v3").description("Tagger 模型"),
        path: Schema.string().role('folder').required().description("图片文件夹路径"),
        threshold: Schema.number().role("slider").min(0).max(1).step(0.01).default(0.35).description("阈值"),
        character_threshold: Schema.number().role("slider").min(0).max(1).step(0.01).default(0.6).description("角色名称识别阈值（仅 cl_tagger 生效）"),
        add_rating_tag: Schema.boolean().default(false).description("添加等级标签"),
        add_model_tag: Schema.boolean().default(false).description("添加 AI 模型标签"),
        additional_tags: Schema.string().role('folder').description("附加提示词 (逗号分隔)"),
        replace_underscore: Schema.boolean().default(true).description("使用空格代替下划线"),
        escape_tag: Schema.boolean().default(true).description("将结果中的括号进行转义处理"),
        batch_input_recursive: Schema.boolean().default(false).description("递归搜索子文件夹图片"),
        batch_output_action_on_conflict: Schema.union(["ignore", "copy", "prepend"]).default("copy").description("若已经存在识别的 Tag 文件，则"),
    }).description("Tagger 参数设置"),
])