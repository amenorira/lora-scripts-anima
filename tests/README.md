# 测试目录

这些文件只用于开发回归验证，不参与训练运行。请从仓库根目录执行，并始终使用项目 venv。

## 统一入口

测试基于标准库 unittest，无需安装任何额外依赖。Windows：

```powershell
.\venv\Scripts\python.exe -m unittest discover -s tests -t .
```

Linux：

```bash
./venv/bin/python -m unittest discover -s tests -t .
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

## 精简后的覆盖边界

套件以关键流程和故障边界为主：配置转换、优化器兼容性、表单状态切换、任务并发与停止、
下载完整性、标签写入回滚、历史文件保护。保留少量真实优化器步进与状态恢复测试。

本轮删去大量固定字段/默认值/文案快照、源码字符串检查、第三方内部实现矩阵，以及部分
次要展示、排序和缓存用例；不再承诺原套件的全部覆盖。TOML 往返改为数据驱动，
字段顺序和优化器状态来源测试迁至 Node，直接使用前端配置和实现，避免重复 Python 包装。
这两个测试依赖生成的 `frontend/js/config.js`，修改字段注册表后还应运行：

```powershell
.\venv\Scripts\python.exe tools/dev/regen_config_fallback.py --check
```

## 新增和清理规则

- 按功能放置测试；新 JavaScript 测试使用 `frontend/*.test.cjs`，不再放到 `tools/` 或嵌入新的 Python 字符串。
- 优先验证输入输出、状态变化、文件结果或请求时序。不要仅因修过一个 bug，就新增检查某段源码文字是否存在的断言。
- 优先扩展现有数据表和共享场景；关键故障回归应保留。缩减覆盖时明确记录取舍，不把删除断言算作等价重构。
- `__pycache__/` 是本地自动缓存，不应提交。
- 老测试中仍有内嵌 JavaScript 和源码契约检查；按所测功能逐步迁移，不因目录整理直接删除覆盖。

Python 测试模块使用 `tests.<分类>.test_xxx` 路径。目录中的 `__init__.py` 保证 unittest 仍能递归发现测试。
