# Changelog

本项目的重要版本变更记录于此。

## v1.0.0 - 2026-07-11

首个正式稳定版本，提供完整的 Anima 与 SDXL LoRA 本地训练工作流。

### 主要功能

- 基于 FastAPI 与 Alpine.js 的本地训练工作台，集成 `sd-scripts` 训练引擎。
- 支持 Anima（Qwen3 + T5 双编码器）和 SDXL LoRA 训练。
- 提供训练参数表单、TOML 预览、预设管理与严格的模型相关参数校验。
- 提供实时硬件监控、训练日志、历史记录、Loss 统计与预览图灯箱。
- 内置标签编辑器、WD14 自动打标、模型下载与训练环境管理。
- 支持中英文界面、亮暗主题和 Windows/Linux 启动脚本。

### 正式版改进

- 修复训练样本预览串样本、扫描卡顿及多行采样提示词拼接问题。
- 优化训练日志查看体验和训练任务并发槽位管理。
- 对齐 `sd-scripts` 的字段范围、模型分组与 Anima/SDXL 分辨率约束。
- 完善 Anima 模型、VAE、Qwen3、dropout、token 与时间步参数校验。
- 优化图片计数、预览扫描和训练启动路径的性能。
- 精简重复字段提示，并同步 API 与前端离线回退配置。

[完整变更](https://github.com/amenorira/lora-scripts-anima/compare/v1.0.0-rc.3...v1.0.0)
