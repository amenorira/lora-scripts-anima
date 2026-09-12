# 工具与运行入口

本目录同时包含用户可调用的命令和启动流程依赖，不能整体视为可删除的开发脚本。根目录保留现有公开入口，避免破坏 `start.bat`、`start.sh`、后端导入及用户已有命令。

| 文件 | 用途与调用方 |
| --- | --- |
| `bootstrap_windows.ps1`、`bootstrap_messages.json` | `start.bat` 使用的 Windows 启动、初始化、更新流程及双语文案 |
| `ensure_runtime.py` | 启动器使用的基础运行环境校验与升级 |
| `ensure_musubi_runtime.py` | 启动器使用的 musubi 共享运行环境校验 |
| `download_anima_model.py` | 模型下载 CLI；后端环境管理也导入其接口 |
| `install_flash_attn.py` | Flash Attention 安装 CLI；后端环境管理也调用 |
| `python_startup/` | 运行时启动钩子、编码和学习率日志适配；启动器和后端依赖 |
| `dev/regen_config_fallback.py` | 开发工具：从字段注册表生成前端默认配置 |

开发工具与回归测试分离：自动测试统一放在 `tests/`，临时实验不要加入工具目录。新增开发脚本放 `dev/`，并在此说明用途和运行方法。

从仓库根目录检查生成配置是否一致：

```powershell
.\venv\Scripts\python.exe tools/dev/regen_config_fallback.py --check
```

Linux 使用 `./venv/bin/python`。去掉 `--check` 会更新 `frontend/js/config.js`。安装器用法见仓库主 README；测试入口见 [tests/README.md](../tests/README.md)。
