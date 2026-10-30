# lora-scripts-anima — 本地 AI 训练器 · AI Agent 入口

> 本文件为 AI 编码代理（OpenCode、Claude Code、Gemini CLI、Copilot、Cursor 等）提供项目入口引导。

> **基本原则**：本项目是本地训练器，优先考虑性能和用户体验，同时保护用户数据。涉及删除或覆盖用户文件的操作，应明确目标并遵循用户授权，避免造成不可恢复的数据损失。

## 快速参考

- **后端**: `backend/` — FastAPI
- **前端**: `frontend/` — Alpine.js SPA
- **第三方代码**: `vendor/` — **禁止修改**（除非用户给出直接指示）
- **配置**: `config/` — TOML 预设
- **工具**: `tools/` — 独立工具脚本

## 开发与测试

- **必须使用 venv**：项目运行在 `venv/` 虚拟环境。任何 Python 命令（版本检查、测试、pip 等）都必须通过 `venv\Scripts\python.exe`（Windows）或 `venv/bin/python`（Linux）执行，**禁止使用系统 Python**。系统 Python 可能版本不同或缺少关键依赖（如 CUDA torch）。
- **开发产物统一归入 cache**：诊断脚本、截图、测试日志和临时提交说明放入 `cache/dev/<任务名>/`，禁止散落在项目根目录；`.anima_tmp/` 仅供 Windows 启动器保存恢复状态。测试使用 venv Python 执行 `-B tools/dev/run_tests.py`，临时文件与编译缓存强制进入 `cache/tests/`，禁写 Python 字节码；独立诊断脚本使用 `tempfile` 或导入训练依赖前可调用 `tools.runtime_paths.configure_test_paths()`，该配置仅用于测试和诊断，不得接入正常启动或训练流程。
- **测试按改动范围运行**：日常优先向统一入口传入相关测试模块，不要求每次全量测试。行为变更应验证关键路径和相关边界情况；不为静态文案、字段排列或第三方实现补大量测试。Windows 启动器的 3 项集成检查在 `tools/dev/check_windows_bootstrap.py`，仅修改启动器或更新流程时手动运行，不加入默认发现。
- **PyTorch 环境**：训练环境可能安装了特定 CUDA 版本的 PyTorch，版本号和依赖关系以 venv 中实际安装为准。

## 提交与发布

- **提交信息使用中文**：所有 git commit message 必须用中文撰写（可使用 Conventional Commits 前缀，如 `feat: 新增 xxx`、`fix: 修复 xxx`），禁止纯英文提交信息。提交正文不可省略，须用中文项目符号具体说明改动，并使用真实换行，禁止把 `\\n` 作为字面量写入提交信息；优先使用提交模板文件或 shell 的多行字符串传入正文。
- **发布流程（每次发版必须走完）**：
  - 使用 **UTC+8** CalVer `YY.MDD.sssss`：日期段保持整数、不补零（`year % 100`、`month * 100 + day`）；末段为当天累计秒数（`hour * 3600 + minute * 60 + second`）的固定 5 位小写十六进制，不足补零。例：`2026-10-17 22:30:10` → `26.1017.13c72`。
  - 历史日志和 tag 不改动。以下 `<版本>` 均复用同一次生成结果，`VERSION` 不带 `v`，日志标题、tag、Release 名均带 `v`。
  - 更新检测和版本先后以 Git 提交关系为准，兼容历史 SemVer 和十进制时间 CalVer；禁止对混合格式的 tag 按字符串、数字或 `packaging.Version` 排序（纯数字的 5 位时间段可能有歧义）。
  1. 在 dev 用 venv Python 执行 `tools/dev/generate_version.py`，保存版本号；若 tag 已存在，至少等一秒再生成，禁止覆盖。
  2. 更新 `VERSION`、`CHANGELOG.md` 和 `CHANGELOG-en.md`，以 `chore: 发布 v<版本> 版本` 提交，并在该提交打 tag `v<版本>`。
  3. 将 dev 合并到 main（合并信息：`merge: 发布 v<版本>`），推送两分支和 tag；再在 dev 执行 `git merge --ff-only main` 并推送，保持分支齐平。
  4. 执行 `gh release create v<版本> --verify-tag --title v<版本> --notes-file <发布说明文件>`。正文使用自然语言，首行必须为：
     `**English release notes:** [CHANGELOG-en.md](https://github.com/amenorira/lora-scripts-anima/blob/main/CHANGELOG-en.md) · 中文更新日志：[CHANGELOG.md](https://github.com/amenorira/lora-scripts-anima/blob/main/CHANGELOG.md)`

## 界面与文案

- **桌面端优先**：本项目是桌面训练器，不要求移动端界面适配。前端布局、交互和视觉验证以常规桌面窗口及桌面窄窗口为准，无需针对手机视口单独设计或测试。
- **用布局传达信息**：通过位置、分组和视觉层级体现元素之间的关系，避免添加不必要的次级标签和说明文字。
- **界面视觉克制**：优先沿用项目现有的颜色、间距、组件和交互。根据内容组织界面，避免为了装饰堆叠卡片、渐变、发光效果、大号圆角和重复图标；颜色和视觉强调应服务于信息层级与操作重点。
- **说明文案简洁具体**：直接说明作用、取值和必要限制，避免空话、重复标题和无关免责声明。是否保留括号、英文原名或中文释义，应按实际用途判断；矩阵结构预览等需要对照模型结构、代码或论文的界面，沿用“原名（中文释义）”。精简时保留操作方法、适用条件、必要示例及结果含义，避免用“不是……而是……”“不代表”等句式制造无关对比。
