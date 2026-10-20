# 开发测试

测试重点覆盖配置转换、文件保护、任务生命周期和关键前端交互。日常修改只运行相关模块，无需每次运行整个套件。

在项目根目录使用项目 venv 执行；测试基于标准库 unittest，前端检查需要 PATH 中的 Node.js，版本检查需要 Git。

```bash
# Windows：精简回归套件（包含 JavaScript 检查）
venv/Scripts/python.exe -B tools/dev/run_tests.py
# Linux
./venv/bin/python -B tools/dev/run_tests.py
# 只运行相关模块
venv/Scripts/python.exe -B tools/dev/run_tests.py tests.training.test_network_config
```

## Windows 启动器

仅在修改启动器或更新流程时，手动运行 3 项备份、更新保护和失败恢复检查，需要 Windows、Git 与 PowerShell：

```bash
venv/Scripts/python.exe -B tools/dev/check_windows_bootstrap.py
```

Git/MSYS 的 `NtCreateDirectoryObject` / `0xC0000022` 表示子进程创建系统对象被拒绝，应排查执行环境权限；它与 PyTorch 编译缓存目录无关。

## 测试产物

统一入口在加载项目模块前，将临时文件和编译缓存强制归入 `cache/tests/`（覆盖继承的缓存路径），并禁止测试及子进程写入 Python 字节码缓存。独立诊断脚本应在使用临时文件或导入训练依赖前调用 `tools.runtime_paths.configure_test_paths()`。

诊断脚本、截图和开发日志放入 `cache/dev/<任务名>/`。这套隔离仅用于测试和诊断，不得接入正常启动或训练流程。
