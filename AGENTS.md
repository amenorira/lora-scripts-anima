# lora-scripts-anima — 本地 AI 训练器 · AI Agent 入口

> 本文件为 AI 编码代理（OpenCode、Claude Code、Gemini CLI、Copilot、Cursor 等）提供项目入口引导。

> **安全立场**：本地训练器，性能与用户体验至上。安全性可适当放宽以换取性能与效率提升，但绝不允许出现毁灭性 Bug（如清空磁盘等）。

## 快速参考

- **后端**: `backend/` — FastAPI
- **前端**: `frontend/` — Alpine.js SPA
- **第三方代码**: `vendor/` — **禁止修改**（除非用户给出直接指示）
- **配置**: `config/` — TOML 预设
- **工具**: `tools/` — 独立工具脚本
