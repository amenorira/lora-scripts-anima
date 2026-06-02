# AI Agent 编码指南 — lora-scripts-anima

> 本文件是所有 AI 编码代理（Copilot、Cursor、OpenCode 等）的**必读参考**。
> 修改代码前请先阅读本文件，避免重复已修复的 Bug。

---

## 1. 项目概览

lora-scripts-anima 是一个 LoRA 训练 Web UI，架构为 **FastAPI 后端 + Alpine.js 前端 SPA**。
训练引擎是 `vendor/sd-scripts/`（kohya-ss），我们只是参数收集和传递的包装层。

```
UI 表单 (JSON) → field_registry.py (校验) → adapter.py (白名单过滤) → TOML 文件 → accelerate launch vendor/sd-scripts/train_network.py
```

### 目录结构

| 目录 | 用途 | 可修改 |
|------|------|--------|
| `backend/` | FastAPI 后端 | ✅ |
| `frontend/` | Alpine.js 前端 SPA | ✅ |
| `gui.py` | 入口 | ✅ |
| `config/` | 训练预设 | ✅ |
| `vendor/sd-scripts/` | 训练引擎（第三方） | ❌ **禁止修改** |
| `.ai/` | Agent 指导文件 | ✅ |

### 关键文件速查

| 文件 | 职责 |
|------|------|
| `backend/server/api.py` | API 路由（文件选择器、安装任务） |
| `backend/server/routes/training.py` | `/run`、`/run_script` 训练路由 |
| `backend/server/routes/presets.py` | 预设 CRUD、saved_params |
| `backend/server/config.py` | 配置持久化（Config 类） |
| `backend/server/proxy.py` | TensorBoard / Tag Editor 反向代理 |
| `backend/server/state.py` | 运行时状态 |
| `backend/training/field_registry.py` | 表单字段定义（单一数据源） |
| `backend/training/adapter.py` | UI→TOML 白名单过滤 |
| `backend/training/supervisor.py` | 训练进程管理 |
| `backend/tagger/interrogator.py` | Tagger 模型推理 |
| `backend/tageditor/routes.py` | Tag Editor API |
| `backend/utils/train_utils.py` | 训练工具（数据集验证、模型类型检测） |
| `backend/monitor/training.py` | 训练日志解析、TensorBoard 读取 |
| `frontend/js/app.js` | Alpine.js 主组件、路由、主题 |
| `frontend/js/training-core.js` | 训练表单构建、字段逻辑 |
| `frontend/js/training-toml.js` | TOML 生成、训练启停 |
| `frontend/js/training-presets.js` | 预设管理 |
| `frontend/js/monitor-core.js` | 监控数据轮询 |
| `frontend/js/monitor-render.js` | 监控 UI 渲染 |
| `frontend/js/tagger.js` | Tagger 表单与 API |
| `frontend/js/tag-editor.js` | 标签编辑器 |
| `frontend/js/constants.js` | UI 常量 + OPTIMIZER_DEFAULTS |
| `frontend/js/config.js` | 路由表 + 字段定义 fallback |
| `frontend/js/i18n.js` | 国际化运行时 |
| `frontend/css/app.css` | 全局样式（CSS 变量设计系统） |

---

## 2. 编码规范

### 后端（Python / FastAPI）

#### 安全
- **所有接受文件路径的 API 必须校验路径范围**，防止路径穿越。使用 `Path.resolve()` + `relative_to()` 或白名单目录检查
- **禁止 `shell=True`**（除非是 `run_pip` 等内部可信命令且显式标注）
- **`run_script` 端点必须用列表传参**，不要拼接 shell 字符串

#### 数据持久化
- **修改 `app_config` 后必须调用 `app_config.save_config()`**，否则重启后数据丢失
- **`Config.__getitem__` 对缺失 key 应回退到默认值**，不要返回 `None`

#### 并发
- **共享可变状态（字典等）必须加锁**。`threading.Lock()` 保护 `_tagger_progress` 等跨线程数据
- **长时间运行的字典缓存必须清理**。添加 TTL 机制，防止内存泄漏

#### API 设计
- **所有 API 端点必须处理无效输入**，返回友好错误而非 500
- **WebSocket 代理必须同时处理 text 和 binary 消息**，使用 `receive()` 而非 `receive_text()`

#### 日志
- **禁止全局猴子补丁 `print`** 或其他内置函数

### 前端（JavaScript / Alpine.js / CSS）

#### CSS 变量
- **边框用 `var(--border-default)` 或 `var(--border-input)`**，不要用 `var(--border-color)`（不存在）
- **圆角用 `var(--radius-sm/md/lg)`**，不要用 `var(--radius)`（不存在）
- **主色用 `var(--accent)`**，不要用 `var(--primary)`（不存在）
- 完整设计系统变量见 `app.css` 顶部的 `:root` 和 `[data-theme="dark"]`

#### Alpine.js
- **`innerHTML` 插入含 Alpine 指令的 HTML 后必须调用 `Alpine.initTree(el)`**，否则指令不生效
- **事件监听器必须在组件销毁时移除**，或在重新添加前先移除旧的，防止内存泄漏
- **不要在 Alpine data 中使用未声明的响应式属性**（如 `_menuOpen`），应显式声明

#### i18n
- **所有用户可见文本必须走 i18n**，禁止硬编码中英文字符串
- 新增 key 必须同时加到 `zh-CN.json` 和 `en-US.json`
- 详见 `.ai/i18n.md`

#### 表单与数据
- **`escJson()` 不要用 `String.fromCharCode.apply(null, bytes)`**，大数据会栈溢出。用 `btoa(unescape(encodeURIComponent(json)))`
- **`findFieldDef()` 应搜索当前训练类型的可见 section**，不要搜索全部 `TRAIN_SECTIONS`
- **TOML 数字转换逻辑只写一份**（`_coerceNum`），`updateToml` 和 `startTraining` 共用

---

## 3. 常见 Bug 模式（已修复，请勿复犯）

### 🔴 安全类

| Bug | 文件 | 教训 |
|-----|------|------|
| 路径穿越 | `tageditor/routes.py` | 接受文件路径的 API 必须校验路径在允许范围内 |
| 命令注入 | `launch_utils.py` | 默认 `shell=False`，`run_pip` 显式 `shell=True` |
| 静默移动文件 | `train_utils.py` | "验证"函数不应有破坏性副作用 |

### 🟡 数据类

| Bug | 文件 | 教训 |
|-----|------|------|
| 不持久化 | `presets.py` | `__setitem__` 后必须 `save_config()` |
| 返回 None | `config.py` | `__getitem__` 应回退到 `_default` |
| 内存泄漏 | `api.py` | 长期字典必须清理（TTL 或上限） |
| 竞态条件 | `interrogator.py` | 跨线程共享字典必须加 `threading.Lock` |
| KeyError 500 | `training.py` | 用 `.get()` + 错误响应，不要直接 `dict[key]` |

### 🟢 前端类

| Bug | 文件 | 教训 |
|-----|------|------|
| CSS 变量不存在 | `app.css` | 只用 `:root` 中定义的变量 |
| 事件监听器泄漏 | `training-core.js` | 先 `removeEventListener` 再 `addEventListener` |
| 自动补全竞态 | `tag-editor.js` | `setTimeout` 要存 ID，新焦点时 `clearTimeout` |
| i18n 硬编码 | `index.html` | 用 `x-text="t('key')"` 替代硬编码文本 |
| 栈溢出 | `training-core.js` | 大数据编码用 `btoa(unescape(encodeURIComponent()))` |

---

## 4. 测试与验证

### Python 语法检查
```bash
python -m py_compile backend/server/api.py
python -m py_compile backend/server/routes/training.py
# ... 对每个修改的 .py 文件
```

### i18n 一致性检查
```bash
python -c "
import json
zh = json.load(open('frontend/i18n/zh-CN.json'))
en = json.load(open('frontend/i18n/en-US.json'))
def keys(d, p=''): return {f'{p}.{k}' if p else k for k,v in d.items()} | \
    {sk for k,v in d.items() if isinstance(v,dict) for sk in keys(v, f'{p}.{k}' if p else k)}
only_zh = keys(zh)-keys(en); only_en = keys(en)-keys(zh)
print('Only zh:', only_zh or 'none'); print('Only en:', only_en or 'none')
"
```

### CSS 变量检查
```bash
# 确保没有使用未定义的 CSS 变量
grep -rn 'var(--border-color)' frontend/css/   # 应该为空
grep -rn 'var(--radius)' frontend/css/          # 应该为空（只有 --radius-sm/md/lg）
grep -rn 'var(--primary)' frontend/             # 应该为空（只有 --accent）
```

---

## 5. Git 提交规范

- 提交信息用**中文**
- 格式：`类型: 简要描述`
  - `fix:` 缺陷修复
  - `feat:` 新功能
  - `refactor:` 重构
  - `docs:` 文档
  - `style:` 格式调整
  - `chore:` 构建/工具变更
- 示例：`fix: 修复 /tageditor/save 路径穿越漏洞`

---

## 6. 相关文件

- `.ai/copilot.md` — 项目架构、vendor 保护规则、sd-scripts 参考
- `.ai/i18n.md` — 国际化规范、key 命名、验证命令
- `CHANGELOG.md` — 版本变更记录