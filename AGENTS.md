# lora-scripts-anima — 本地 AI 训练器 · AI Agent 入口

> 本文件为 AI 编码代理（OpenCode、Claude Code、Gemini CLI、Copilot、Cursor 等）提供项目入口引导。

> **安全立场**：本地训练器，性能与用户体验至上。安全性可适当放宽以换取性能与效率提升，但绝不允许出现毁灭性 Bug（如清空磁盘等）。

## 快速参考

- **后端**: `backend/` — FastAPI
- **前端**: `frontend/` — Alpine.js SPA
- **第三方代码**: `vendor/` — **禁止修改**（除非用户给出直接指示）
- **配置**: `config/` — TOML 预设
- **工具**: `tools/` — 独立工具脚本

## 重要约定

- **必须使用 venv**：项目运行在 `venv/` 虚拟环境。任何 Python 命令（版本检查、测试、pip 等）都必须通过 `venv\Scripts\python.exe`（Windows）或 `venv/bin/python`（Linux）执行，**禁止使用系统 Python**。系统 Python 可能版本不同或缺少关键依赖（如 CUDA torch）。
- **PyTorch 环境**：训练环境可能安装了特定 CUDA 版本的 PyTorch（如 `2.10.0+cu128`），版本号和依赖关系以 venv 中实际安装为准。
