# lora-scripts-anima — AI Agent 入口

> 本文件为 AI 编码代理（OpenCode、Claude Code、Gemini CLI、Copilot、Cursor 等）提供项目入口引导。

## 必读文档

修改代码前，请按顺序阅读以下文件：

1. **`.ai/agent-guide.md`** — 编码规范、常见 Bug 模式、安全要求、测试命令
2. **`.ai/copilot.md`** — 项目架构、vendor 保护规则、sd-scripts 参考
3. **`.ai/i18n.md`** — 国际化规范、key 命名、验证命令
4. **`CHANGELOG.md`** — 版本变更记录，了解最近改动和历史 Bug

## 快速参考

- **后端**: `backend/` — FastAPI
- **前端**: `frontend/` — Alpine.js SPA
- **训练引擎**: `vendor/sd-scripts/` — **禁止修改**（第三方代码）
- **配置**: `config/` — TOML 预设
- **工具**: `tools/` — 独立工具脚本
