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
- **PyTorch 环境**：训练环境可能安装了特定 CUDA 版本的 PyTorch（当前默认如 `2.10.0+cu130`），版本号和依赖关系以 venv 中实际安装为准。
- **提交信息使用中文**：所有 git commit message 必须用中文撰写（可使用 Conventional Commits 前缀，如 `feat: 新增 xxx`、`fix: 修复 xxx`），禁止纯英文提交信息。
- **提交正文使用真实换行**：多行 commit body 必须包含实际换行和中文项目符号，禁止把 `\\n` 作为字面量写入提交信息；优先使用提交模板文件或 shell 的多行字符串传入正文。
- **发布流程（每次发版必须走完）**：
  1. 更新 `VERSION`、双语 `CHANGELOG.md` / `CHANGELOG-en.md`，提交信息为 `chore: 发布 vX.Y.Z 版本`；
  2. 打标签 `vX.Y.Z`；
  3. 合并 dev 到 main（合并信息用中文），推送 dev、main 与标签；
  4. 将 main 快进回 dev 并推送（`git merge --ff-only main`），保持两分支齐平、避免 GitHub 误显示 dev 落后；
  5. 创建 GitHub Release（`gh release create`），正文以自然语言撰写（参照 v2.3.0/v2.3.1 风格），**最开头一行必须附双语更新日志链接**，格式：
     `**English release notes:** [CHANGELOG-en.md](https://github.com/amenorira/lora-scripts-anima/blob/main/CHANGELOG-en.md) · 中文更新日志：[CHANGELOG.md](https://github.com/amenorira/lora-scripts-anima/blob/main/CHANGELOG.md)`
- **桌面端优先**：本项目是桌面训练器，不要求移动端界面适配。前端布局、交互和视觉验证以常规桌面窗口及桌面窄窗口为准，无需针对手机视口单独设计或测试。
