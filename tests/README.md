# 测试目录

这些文件只用于开发回归验证，不参与训练运行。请从仓库根目录执行，并始终使用项目 venv。

## 统一入口

Windows：

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\venv\Scripts\python.exe -m pytest tests -q
```

Linux：

```bash
./venv/bin/python -m pip install -r requirements-dev.txt
./venv/bin/python -m pytest tests -q
```

完整套件还需要 PATH 中的 Node.js（支持 `node:test`）和 Git。Windows 启动集成测试使用 PowerShell，在其他平台跳过。部分测试需要项目训练依赖，如 PyTorch；无需启动实际训练。

`test_frontend.py` 自动收集 `frontend/*.test.cjs` 并调用 Node。缺少 Node 会明确失败，避免把漏跑前端测试当成通过。不要为每个 JavaScript 文件再写一份 Python 包装。

## 分类

| 目录 | 范围 |
| --- | --- |
| `training/` | 参数、配置导入导出、优化器、内核适配、训练预览 |
| `monitor/` | 任务状态、WebSocket、日志、TensorBoard 代理、跨盘训练产物 |
| `environment/` | 启动更新、运行环境、安装器、进程编码、学习率日志注入 |
| `tagger/` | 打标任务、工作区、标签编辑事务与会话 |
| `application/` | 公共 API、文档、图片预览 |
| `frontend/` | 独立 JavaScript 行为测试：监控生命周期、学习率与时间步预览 |
| `helpers.py` | Python 测试共享辅助方法 |

按需运行示例（Linux 改用 `./venv/bin/python`）：

```powershell
.\venv\Scripts\python.exe -m pytest tests/monitor -q
.\venv\Scripts\python.exe -m pytest tests/test_frontend.py -q
.\venv\Scripts\python.exe -m unittest discover -s tests -t .
node --test tests/frontend/monitor-lifecycle.test.cjs
```

## 新增和清理规则

- 按功能放置测试；新 JavaScript 测试使用 `frontend/*.test.cjs`，不再放到 `tools/` 或嵌入新的 Python 字符串。
- 优先验证输入输出、状态变化、文件结果或请求时序。不要仅因修过一个 bug，就新增检查某段源码文字是否存在的断言。
- 删除测试前确认对应行为已取消，或有等价行为测试覆盖。已修复的 bug 仍需要回归保护。
- `__pycache__/` 是本地自动缓存，不应提交。
- 老测试中仍有内嵌 JavaScript 和源码契约检查；按所测功能逐步迁移，不因目录整理直接删除覆盖。

本次迁移保留了测试文件名，旧的 `tests.test_xxx` 模块路径改为 `tests.<分类>.test_xxx`。目录中的 `__init__.py` 保证 unittest 仍能递归发现测试。
