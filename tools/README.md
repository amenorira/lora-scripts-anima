# 工具与运行入口

本目录同时包含用户可调用的命令和启动流程依赖，不能整体视为可删除的开发脚本。根目录保留现有公开入口，避免破坏 `start.bat`、`start.sh`、后端导入及用户已有命令。

| 文件 | 用途与调用方 |
| --- | --- |
| `bootstrap_windows.ps1`、`bootstrap_messages.json` | `start.bat` 使用的 Windows 启动、初始化、更新流程及双语文案 |
| `ensure_runtime.py` | 启动器使用的基础运行环境校验与升级 |
| `ensure_musubi_runtime.py` | 启动器使用的 musubi 共享运行环境校验 |
| `download_anima_model.py` | 模型下载 CLI；后端环境管理也导入其接口 |
| `python_startup/` | 运行时启动钩子、编码和学习率日志适配；启动器和后端依赖 |
| `dev/regen_config_fallback.py` | 开发工具：从字段注册表生成前端默认配置 |
| `dev/build_tag_dictionary.py` | 开发工具：把 Danbooru 中文词典 CSV 构建成 Tag Editor 用的静态资源 |
| `dev/generate_version.py` | 发版工具：按固定 UTC+8 生成 CalVer `YY.MDD.HMMSS` 版本号 |

开发工具与回归测试分离：自动测试统一放在 `tests/`，临时实验不要加入工具目录。新增开发脚本放 `dev/`，并在此说明用途和运行方法。

从仓库根目录检查生成配置是否一致：

```powershell
.\venv\Scripts\python.exe tools/dev/regen_config_fallback.py --check
```

Tag Editor 的中文词典由后端下载并构建：界面上点「下载词典」会走 [`backend/tageditor/dictionary.py`](../backend/tageditor/dictionary.py)，产物落在 `cache/tag_dictionary/`，不进仓库。下面是开发用的离线重建（数据源已缓存在 `cache/tag_dict_src/` 时不需要联网）：

```powershell
.\venv\Scripts\python.exe tools/dev/build_tag_dictionary.py             # 用缓存里的 CSV 重建
.\venv\Scripts\python.exe tools/dev/build_tag_dictionary.py --download  # 先下载数据源再重建
```

输出文件名带内容 hash：数据一变，浏览器就按新地址重新下载，旧缓存自然失效。

Linux 使用 `./venv/bin/python`。去掉 `--check` 会更新 `frontend/js/config.js`。安装器用法见仓库主 README；测试入口见 [tests/README.md](../tests/README.md)。

发布版本号生成（从下一次正式发布开始使用，流程见 [AGENTS.md](../AGENTS.md)）：

```powershell
.\venv\Scripts\python.exe tools/dev/generate_version.py
.\venv\Scripts\python.exe tools/dev/generate_version.py --at "2026-09-25T08:03:07"
# 指定时间的输出：26.925.80307
```

Linux 使用 `./venv/bin/python tools/dev/generate_version.py`。工具仅向标准输出打印不带 `v` 的版本号，不修改文件。默认取当前 UTC+8 时间；`--at` 接受 ISO 8601 时间，无时区时按 UTC+8 解释，有时区时先转换到 UTC+8。

每次发布只生成一次，将结果写入 `VERSION` 并复用于双语 CHANGELOG、提交、tag 和 Release；tag / Release 名加 `v` 前缀。计算式为 `year % 100`、`month * 100 + day`、`hour * 10000 + minute * 100 + second`，各段不按固定宽度补零。
