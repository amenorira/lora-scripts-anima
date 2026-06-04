# Changelog

All notable changes to lora-scripts-anima.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [2.1.0-dev] — Unreleased

> ⚠️ This is a development version. The project is under active restructuring.

### Added
- i18n: browser language auto-detection via `navigator.language`
- Frontend/backend connectivity indicator with real-time disconnect duration
- Training artifact isolated storage per run
- Environment management: sd-scripts version info card
- `constants.js`: centralized UI constants + `OPTIMIZER_DEFAULTS` (single source of truth for optimizer defaults)

### Changed
- **i18n fallback changed from zh-CN to en-US** (more international default)
- **SD 1.5 training type removed** (only SDXL + Anima LoRA remain)
- Port changed from 28000 to 12333
- Runtime cache migrated from `output/` to `cache/` directory
- Training records renamed for clarity
- Sidebar group colors: blue-green-purple-yellow top-to-bottom
- Training form de-card-ified with flattened design
- Right panel toggle button: unified sizing, centered, icon-only
- Install section: spinning loader + timer + live log output
- Optimizer defaults unified: `training-core.js` and `training-toml.js` now share `OPTIMIZER_DEFAULTS`

### Removed
- sd-scripts update management feature (local version info only)
- Custom scrollbar styling (unstable across browsers)
- Empty "Tools" route page (placeholder, not yet implemented)
- Unused CSS classes: `.sidebar-bottom .divider`, `.sidebar-bottom .bottom-label`

### Fixed
- Training form rendering regression after restructuring
- Progress bar stuck at 90% after navigation
- History page blank after refactoring
- Encoding issues and crash-on-launch in Windows startup scripts
- Log level filter buttons now use i18n (were hardcoded English)
- Monitor chart placeholder labels now use i18n (were hardcoded English)
- Home page quick-action card now shows "Anima / SDXL" (was "SD / SDXL / Anima")
- Tagger model list now cached to avoid redundant API calls on page switch
- Tag editor: tag pill click handlers use data attributes (eliminates injection risk from inline onclick)
- **Tag editor v3: complete 3-column layout redesign** — left tag cloud (collapsible), center image grid, right persistent editor panel (single/batch adaptive), single-row top toolbar, bottom status bar

### 🔒 安全修复
- **[严重] `/tageditor/save` 路径穿越漏洞（再修复）**：先前声称的路径白名单实未生效——代码中缺少 `resolve()` 和父目录校验。已与 `/save-all` 对齐，添加 `cap.resolve().parent == p.resolve().parent` 检查
- **[严重] `shell=True` 命令注入风险**：Linux 下 `launch_utils.run()` 默认使用 `shell=True`，用户输入可能被注入。已改为默认 `shell=False`，`run_pip` 显式保留 `shell=True`（内部可信参数），`run_script` 改为列表传参

### 🐛 缺陷修复
- **[严重] `pick_file` 无效类型崩溃**：`picker_type` 不是 `folder` 或 `model-file` 时 `coro` 未定义导致 500 错误，已添加 `else` 分支返回错误响应
- **[严重] `validate_data_dir` 静默移动用户文件**：验证函数会自动创建子目录并移动文件，不可撤销。已改为返回验证错误，提示用户手动整理数据集
- **[严重] CSS 变量 `--border-color` 未定义**：6 处边框使用不存在的变量导致边框不可见，已替换为 `--border-default`
- **[严重] CSS 变量 `--radius` 未定义**：3 处圆角使用不存在的变量导致圆角失效，已替换为 `--radius-md`
- **[高] `save_params` 不持久化**：保存参数后未调用 `save_config()`，重启后数据丢失，已添加持久化调用
- **[高] `Config.__getitem__` 返回 None**：缺失 key 时前端收到 `null` 而非 `{}`，已改为回退到默认值
- **[高] `_install_jobs` 内存泄漏**：安装任务字典无限增长，已添加 10 分钟 TTL 清理机制
- **[高] WebSocket 代理不处理二进制消息**：收到二进制帧时连接静默断开，已改用 `receive()` 按类型分发
- **[高] `locale-changed` 事件监听器泄漏**：每次导航训练页都添加新监听器，已改为先移除再添加
- **[高] `--primary` CSS 变量未定义**：monitor-render 使用不存在的变量，已替换为 `--accent`
- **[中] `model_train_type` KeyError**：无效类型导致 500 错误，已改用 `.get()` 返回友好错误
- **[中] `sitecustomize.py` 全局替换 `print`**：每次调用额外输出 `i18n_print`，已移除猴子补丁
- **[中] `random.choice` 无种子**：训练随机选 prompt 不可复现，已使用训练 seed 初始化随机数
- **[中] `tagEditorBlurSuggest` 竞态条件**：快速切换焦点时自动补全异常，已存储 timeout ID 并在新焦点时清除
- **[中] `escJson` 调用栈溢出**：大数据时 `String.fromCharCode.apply` 栈溢出，已改用 `btoa(unescape(encodeURIComponent()))`
- **[中] `autoLoadLastParams` 名称误导**：函数名暗示加载参数但实际只显示 toast，已重命名为 `_markAutoLoaded`
- **[中] `taggerPreset` 强制覆盖**：Camie 模型时每次重建表单都重置用户选择，已添加初始化标志保护
- **[中] 硬编码 i18n 字符串**：TensorBoard、Light/Dark/Auto、Regex、Chip/Text 等未走 i18n，已替换为 Alpine 绑定
- **[中] `localFilePickerTagger` 静默吞错**：文件选择失败时无提示，已添加 toast 通知
- **[低] `httpx.AsyncClient` 从不关闭**：已添加连接池限制
- **[低] 端口检查 TOCTOU 竞态**：已添加文档注释说明
- **[低] Loss 正则匹配过宽**：`loss` 会匹配 `total_loss` 等，已添加 `\b` 词边界
- **[低] `tagEditorFocusedImg` Enter 后未清除**：已添加清除逻辑
- **[低] `saveUISettings` 重复存储 theme**：已移除重复字段
- **Tag editor v3 UX 修复 (15项)**：搜索防抖(150ms)、重载确认守卫、Escape 分级关闭、草稿仅存修改项、color-mix 兼容性、零计数标签清理、flex 高度自适应、折叠箭头动态方向、无效正则报错、批量全量确认、自动聚焦编辑器、排序方向 toggle、`v-for`→Alpine 语法、batch-row 定位、i18n 新 key
- **Tag editor v3: undo/redo 重构**：从 snapshot 改为 checkpoint 模型，修复无法增量回退的 bug，redo 可用，频率同步

### 🔧 内部改进
- `_tagger_progress` 字典添加 `threading.Lock` 保护，修复多线程竞态条件
- `findFieldDef` 改为只搜索当前训练类型的可见 section，避免返回错误字段定义
- TOML 数字转换逻辑提取为共享 `_coerceNum()` 方法，消除 `updateToml` 和 `startTraining` 的重复代码
- `run_script` 端点改为列表传参，消除 shell 拼接风险
- `scan_images` / `count_tags`: 单次 `rglob("*")` + 扩展名过滤替代 6 次独立遍历，大幅提升大数据集加载速度

---

## [2.0.0] — 2026-05-23

### Added
- **Project restructuring**: `mikazuki/` → `backend/`, `anima-ui/` → `frontend/`, `legacy-scripts/` → `legacy/`
- `backend/app/state.py` — shared schema/preset state extracted from api.py
- `backend/app/routes/training.py` — POST /run route module
- `backend/app/routes/presets.py` — preset CRUD route module
- `backend/anima_backend/adapter.py` — UI→TOML whitelist + defensive filtering
- `backend/anima_backend/supervisor.py` — unified training process manager
- `tools/install_flash_attn.py` — smart prebuilt wheel installer with GitHub API matching
- `.ai/i18n.md` — localization guide for AI coding agents
- `.ai/copilot.md` — AI agent guardrails (vendor protection, i18n rules)
- Alpine.js SPA frontend at `frontend/` (385 i18n keys, zh-CN/en-US)
- GPU hardware monitor + training dashboard
- Flash Attention auto-install with environment detection

### Changed
- **Breaking**: `mikazuki/` renamed to `backend/` — update any external scripts
- **Breaking**: `anima-ui/` renamed to `frontend/` — update any external scripts
- **Breaking**: `legacy-scripts/` moved to `legacy/scripts/`
- PyTorch upgraded to **2.10.0+cu128** (RTX 30/40/50 all supported)
- sd-scripts vendored to `vendor/sd-scripts/` (was git submodule)
- UI now supports 3 training modes: SD LoRA, SDXL LoRA, Anima LoRA
- All CLI/log output now bilingual (English / Chinese)
- Shell scripts use project name `lora-scripts-anima` consistently
- xformers is now a fallback (flash_attn is preferred)
- `api.py` split: training routes → `routes/training.py`, presets → `routes/presets.py`
- `process.py` training logic merged into `supervisor.run_train()`
- Env vars prefer `ANIMA_*` naming (fallback to `MIKAZUKI_*`)

### Removed
- SD3 / FLUX / HunyuanImage / Dreambooth UI training entries (engine still supports them)
- Standalone `tensorboard.ps1` reference (integrated in WebUI)
- xformers as primary dependency (flash_attn is now preferred)

### Fixed
- README model support table now matches actual UI capabilities
- Schema directory path corrected in architecture docs
- Training lifecycle messages now bilingual for better accessibility
- Duplicate training launcher (`process.py` vs `supervisor.py`) unified

---

*Based on lora-scripts v1.10.0 (Akegarasu) + sd-scripts (kohya-ss)*
