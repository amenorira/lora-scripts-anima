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
.\venv\Scripts\python.exe -m unittest discover -s tests/monitor -t .
.\venv\Scripts\python.exe -m unittest tests.test_frontend
.\venv\Scripts\python.exe -m unittest discover -s tests -t .
node --test tests/frontend/monitor-lifecycle.test.cjs
```

## 2026-09-29 精简记录与覆盖边界

独立测试从 **449 个降至 229 个，删除 220 个（49.0%）**。按 unittest 测试方法和
Node 实际执行用例计数，包含 Node 循环生成的用例，不把断言或 `subTest` 数据行分别计数。
Python 的 `test_javascript_suite` 只是前端入口，不重复计入总数；没有通过合并用例或跳过执行缩减计数。

| 范围 | 精简前 | 精简后 |
| --- | ---: | ---: |
| 应用 | 20 | 7 |
| 环境与启动 | 69 | 32 |
| 监控与任务 | 69 | 42 |
| 打标与标签编辑 | 57 | 32 |
| 训练与配置 | 110 | 52 |
| Node 前端 | 124 | 64 |
| 合计（不含 Python 前端入口） | 449 | 229 |

统一入口的报告是 **166 个 Python 测试**（165 个独立用例 + 1 个前端入口）；
单独运行 `node --test tests/frontend/*.test.cjs` 可看到 **64 个前端用例**。
这是本次精简时的基线，不是禁止后续新增测试的硬性配额。

保留训练启动、停止、资源互斥和失败收尾，数据集重命名与标签写入回滚，快照路径保护，
历史删除时的模型保护，下载续传及完整性，配置往返、关键参数冲突、真实优化器步进与恢复，
以及前端旧响应覆盖新任务、未保存草稿和过期批量确认等回归。

本次取舍：

- 删除启动输出样式、结束时间展示、下拉菜单定位、字段顺序及提示文案的专用检查；相关界面变更依靠桌面交互检查。
- 删除部分重复层级检查，例如实时 Hub 的基础重放与过期游标单测，保留 WebSocket 路由行为测试；删除直接停止单进程用例，保留真实父子进程退出与 supervisor 生命周期测试。
- 缩减优化器参数映射、旧配置迁移、词典排序与缓存、打标默认值、预览曲线细节的组合覆盖；保留代表性流程和高风险失败场景。
- 删除仅验证第三方 TensorBoard 写入后再读取标量的往返检查，保留实际 TensorBoard 服务、代理与进程清理集成测试。

这些删除包含主动放弃的次要行为覆盖，不代表覆盖率保持不变，也不代表代码覆盖率下降了 49.0%。
修改被缩减的功能时，应做针对性验证；只有涉及重要行为或高风险回归时才增加长期用例。

保留的优化器状态来源测试仍直接使用生成的 `frontend/js/config.js`。
修改字段注册表后还应运行：

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
