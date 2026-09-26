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
  - 下次正式发布起使用 **UTC+8** CalVer `YY.MDD.HMMSS`，各段为整数、不补零：`year % 100`、`month * 100 + day`、`hour * 10000 + minute * 100 + second`。例：`2026-09-25 08:03:07` → `26.925.80307`。
  - 本次规范迁移不发版，`VERSION` 保持 `2.20.5`；历史日志和 tag 不改动。以下 `<版本>` 均复用同一次生成结果，`VERSION` 不带 `v`，日志标题、tag、Release 名均带 `v`。
  1. 在 dev 用 venv Python 执行 `tools/dev/generate_version.py`，保存版本号；若 tag 已存在，至少等一秒再生成，禁止覆盖。
  2. 更新 `VERSION`、`CHANGELOG.md` 和 `CHANGELOG-en.md`，以 `chore: 发布 v<版本> 版本` 提交，并在该提交打 tag `v<版本>`。
  3. 将 dev 合并到 main（合并信息：`merge: 发布 v<版本>`），推送两分支和 tag；再在 dev 执行 `git merge --ff-only main` 并推送，保持分支齐平。
  4. 执行 `gh release create v<版本> --verify-tag --title v<版本> --notes-file <发布说明文件>`。正文使用自然语言，首行必须为：
     `**English release notes:** [CHANGELOG-en.md](https://github.com/amenorira/lora-scripts-anima/blob/main/CHANGELOG-en.md) · 中文更新日志：[CHANGELOG.md](https://github.com/amenorira/lora-scripts-anima/blob/main/CHANGELOG.md)`
- **桌面端优先**：本项目是桌面训练器，不要求移动端界面适配。前端布局、交互和视觉验证以常规桌面窗口及桌面窄窗口为准，无需针对手机视口单独设计或测试。
