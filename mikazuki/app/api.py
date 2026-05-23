import asyncio
import hashlib
import json
import os
import re
import random

from glob import glob
from datetime import datetime
from pathlib import Path
from typing import Tuple, Optional

import toml
from fastapi import APIRouter, BackgroundTasks, Body, Request
from starlette.requests import Request

import mikazuki.process as process
from mikazuki import launch_utils
from mikazuki.app.config import app_config
from mikazuki.app.models import (APIResponse, APIResponseFail,
                                 APIResponseSuccess, PresetSaveRequest,
                                 TaggerInterrogateRequest)
from mikazuki.log import log
from mikazuki.tagger.interrogator import (available_interrogators,
                                          on_interrogate)
from mikazuki.tasks import tm
from mikazuki.utils import train_utils
from mikazuki.utils.devices import printable_devices
from mikazuki.utils.tk_window import (open_directory_selector,
                                      open_file_selector)

router = APIRouter()


def _git_version() -> str:
    try:
        import subprocess
        r = subprocess.run(["git", "describe", "--tags", "--always"],
                          capture_output=True, text=True,
                          cwd=Path(__file__).parents[2])
        return r.stdout.strip() or "dev"
    except Exception:
        return "dev"


@router.get("/version")
async def get_version():
    return APIResponseSuccess(data={"version": _git_version()})

avaliable_scripts = [
    "networks/extract_lora_from_models.py",
    "networks/extract_lora_from_dylora.py",
    "networks/merge_lora.py",
    "tools/merge_models.py",
]

avaliable_schemas = []
avaliable_presets = []

trainer_mapping = {
    "sd-lora": "./vendor/sd-scripts/train_network.py",
    "sdxl-lora": "./vendor/sd-scripts/sdxl_train_network.py",

    "sd-dreambooth": "./vendor/sd-scripts/train_db.py",
    "sdxl-finetune": "./vendor/sd-scripts/sdxl_train.py",

    "sd3-lora": "./vendor/sd-scripts/sd3_train_network.py",
    "flux-lora": "./vendor/sd-scripts/flux_train_network.py",
    "flux-finetune": "./vendor/sd-scripts/flux_train.py",

    "anima-lora": "./vendor/sd-scripts/anima_train_network.py",
}


async def load_schemas():
    avaliable_schemas.clear()

    schema_dir = os.path.join(os.getcwd(), "mikazuki", "schema")
    schemas = os.listdir(schema_dir)

    def lambda_hash(x):
        return hashlib.md5(x.encode()).hexdigest()

    for schema_name in schemas:
        with open(os.path.join(schema_dir, schema_name), encoding="utf-8") as f:
            content = f.read()
            avaliable_schemas.append({
                "name": schema_name.rstrip(".ts"),
                "schema": content,
                "hash": lambda_hash(content)
            })


async def load_presets():
    avaliable_presets.clear()

    preset_dir = os.path.join(os.getcwd(), "config", "presets")
    presets = os.listdir(preset_dir)

    for preset_name in presets:
        with open(os.path.join(preset_dir, preset_name), encoding="utf-8") as f:
            content = f.read()
            avaliable_presets.append(toml.loads(content))


def get_sample_prompts(config: dict) -> Tuple[Optional[str], str]:
    # backward compatibility
    if "sample_prompts" in config and "positive_prompts" not in config:
        return None, config["sample_prompts"]

    train_data_dir = config["train_data_dir"]
    sub_dir = [dir for dir in glob(os.path.join(train_data_dir, '*')) if os.path.isdir(dir)]

    positive_prompts = config.pop('positive_prompts', None)
    negative_prompts = config.pop('negative_prompts', '')
    sample_width = config.pop('sample_width', 512)
    sample_height = config.pop('sample_height', 512)
    sample_cfg = config.pop('sample_cfg', 7)
    sample_seed = config.pop('sample_seed', 2333)
    sample_steps = config.pop('sample_steps', 24)
    randomly_choice_prompt = config.pop('randomly_choice_prompt', False)

    if randomly_choice_prompt:
        if len(sub_dir) != 1:
            raise ValueError('Multiple subdirectories found / 多子文件夹; random prompt selection requires a single subdirectory / 随机选取 Prompt 需要单一子文件夹')

        txt_files = glob(os.path.join(sub_dir[0], '*.txt'))
        if not txt_files:
            raise ValueError('No .txt files found in dataset directory / 数据集路径没有 txt 文件')
        try:
            sample_prompt_file = random.choice(txt_files)
            with open(sample_prompt_file, 'r', encoding='utf-8') as f:
                positive_prompts = f.read()
        except IOError:
            log.error(f"Failed to read prompt file / 读取失败: {sample_prompt_file}")

    return positive_prompts, f'{positive_prompts} --n {negative_prompts}  --w {sample_width} --h {sample_height} --l {sample_cfg}  --s {sample_steps}  --d {sample_seed}'


@router.post("/run")
async def create_toml_file(request: Request):
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    toml_file = os.path.join(os.getcwd(), f"config", "autosave", f"{timestamp}.toml")
    json_data = await request.body()

    config: dict = json.loads(json_data.decode("utf-8"))
    train_utils.fix_config_types(config)

    gpu_ids = config.pop("gpu_ids", None)

    suggest_cpu_threads = 8 if len(train_utils.get_total_images(config["train_data_dir"])) > 200 else 2
    model_train_type = config.get("model_train_type", "sd-lora")
    trainer_file = trainer_mapping[model_train_type]

    # ── 🆕 Anima Backend Adapter: 白名单过滤 + NaN 清理 + 路径规范化 ──
    try:
        from mikazuki.anima_backend import adapt_config, detect_attention_backend
        adapted_config, warnings = adapt_config(config)
        for w in warnings:
            log.warning(f"[Adapter] {w}")
        config = adapted_config

        # 🆕 attn_mode 自动降级检测
        if "attn_mode" in config:
            attn_requested = config.get("attn_mode", "torch")
            attn_actual, attn_warning = detect_attention_backend(attn_requested)
            if attn_warning:
                log.warning(f"[Attn] {attn_warning}")
                config["attn_mode"] = attn_actual
    except ImportError:
        pass  # adapter 可选，不影响现有逻辑
    # ──────────────────────────────────────────────────────────

    if model_train_type != "sdxl-finetune":
        if not train_utils.validate_data_dir(config["train_data_dir"]):
            return APIResponseFail(message="Dataset directory not found or no images / 数据集路径不存在或无图片")

    validated, message = train_utils.validate_model(config["pretrained_model_name_or_path"], model_train_type)
    if not validated:
        return APIResponseFail(message=message)

    if "prompt_file" in config and config["prompt_file"].strip() != "":
        prompt_file = config["prompt_file"].strip()
        if not os.path.exists(prompt_file):
            return APIResponseFail(message=f"Prompt file not found / 文件不存在: {prompt_file}")
        config["sample_prompts"] = prompt_file
    else:
        try:
            positive_prompt, sample_prompts_arg = get_sample_prompts(config=config)

            if positive_prompt is not None and train_utils.is_promopt_like(sample_prompts_arg):
                sample_prompts_file = os.path.join(os.getcwd(), f"config", "autosave", f"{timestamp}-promopt.txt")
                with open(sample_prompts_file, "w", encoding="utf-8") as f:
                    f.write(sample_prompts_arg)
                config["sample_prompts"] = sample_prompts_file
                log.info(f"Wrote prompts to file {sample_prompts_file}")

        except ValueError as e:
            log.error(f"Error while processing prompts: {e}")
            return APIResponseFail(message=str(e))

    with open(toml_file, "w", encoding="utf-8") as f:
        f.write(toml.dumps(config))

    result = process.run_train(toml_file, trainer_file, gpu_ids, suggest_cpu_threads)

    return result


@router.post("/run_script")
async def run_script(request: Request, background_tasks: BackgroundTasks):
    paras = await request.body()
    j = json.loads(paras.decode("utf-8"))
    script_name = j["script_name"]
    if script_name not in avaliable_scripts:
        return APIResponseFail(message="Script not found")
    del j["script_name"]
    result = []
    for k, v in j.items():
        result.append(f"--{k}")
        if not isinstance(v, bool):
            value = str(v)
            if " " in value:
                value = f'"{v}"'
            result.append(value)
    script_args = " ".join(result)
    script_path = Path(os.getcwd()) / "scripts" / script_name
    cmd = f"{launch_utils.python_bin} {script_path} {script_args}"
    background_tasks.add_task(launch_utils.run, cmd)
    return APIResponseSuccess()


@router.post("/interrogate")
async def run_interrogate(req: TaggerInterrogateRequest, background_tasks: BackgroundTasks):
    interrogator = available_interrogators.get(req.interrogator_model, available_interrogators["wd14-convnextv2-v2"])
    background_tasks.add_task(
        on_interrogate,
        image=None,
        batch_input_glob=req.path,
        batch_input_recursive=req.batch_input_recursive,
        batch_output_dir="",
        batch_output_filename_format="[name].[output_extension]",
        batch_output_action_on_conflict=req.batch_output_action_on_conflict,
        batch_remove_duplicated_tag=True,
        batch_output_save_json=False,
        interrogator=interrogator,
        threshold=req.threshold,
        character_threshold=req.character_threshold,
        add_rating_tag=req.add_rating_tag,
        add_model_tag=req.add_model_tag,
        additional_tags=req.additional_tags,
        exclude_tags=req.exclude_tags,
        sort_by_alphabetical_order=False,
        add_confident_as_weight=False,
        replace_underscore=req.replace_underscore,
        replace_underscore_excludes=req.replace_underscore_excludes,
        escape_tag=req.escape_tag,
        unload_model_after_running=True
    )
    return APIResponseSuccess()


@router.get("/tagger/models")
async def list_tagger_models():
    """List available tagger/interrogator models."""
    models = []
    for key, interrogator in available_interrogators.items():
        models.append({
            "id": key,
            "name": key
        })
    return APIResponseSuccess(data=models)


@router.get("/pick_file")
async def pick_file(picker_type: str):
    if picker_type == "folder":
        coro = asyncio.to_thread(open_directory_selector, "")
    elif picker_type == "model-file":
        file_types = [("checkpoints", "*.safetensors;*.ckpt;*.pt"), ("all files", "*.*")]
        coro = asyncio.to_thread(open_file_selector, "", "Select file", file_types)

    result = await coro
    if result == "":
        return APIResponseFail(message="User cancelled / 用户取消")

    return APIResponseSuccess(data={
        "path": result
    })


@router.get("/get_files")
async def get_files(pick_type) -> APIResponse:
    pick_preset = {
        "model-file": {
            "type": "file",
            "path": "./sd-models",
            "filter": "(.safetensors|.ckpt|.pt)"
        },
        "model-saved-file": {
            "type": "file",
            "path": "./output",
            "filter": "(.safetensors|.ckpt|.pt)"
        },
        "train-dir": {
            "type": "folder",
            "path": "./train",
            "filter": None
        },
    }

    folder_blacklist = [".ipynb_checkpoints", ".DS_Store"]

    def list_path_or_files(preset_info):
        path = Path(preset_info["path"])
        file_type = preset_info["type"]
        regex_filter = preset_info["filter"]
        result_list = []

        if file_type == "file":
            if regex_filter:
                pattern = re.compile(regex_filter)
                files = [f for f in path.glob("**/*") if f.is_file() and pattern.search(f.name)]
            else:
                files = [f for f in path.glob("**/*") if f.is_file()]
            for file in files:
                result_list.append({
                    "path": str(file.resolve().absolute()).replace("\\", "/"),
                    "name": file.name,
                    "size": f"{round(file.stat().st_size / (1024**3),2)} GB"
                })
        elif file_type == "folder":
            folders = [f for f in path.iterdir() if f.is_dir()]
            for folder in folders:
                if folder.name in folder_blacklist:
                    continue
                result_list.append({
                    "path": str(folder.resolve().absolute()).replace("\\", "/"),
                    "name": folder.name,
                    "size": 0
                })

        return result_list

    if pick_type not in pick_preset:
        return APIResponseFail(message="Invalid request")

    dirs = list_path_or_files(pick_preset[pick_type])
    return APIResponseSuccess(data={
        "files": dirs
    })


@router.get("/tasks", response_model_exclude_none=True)
async def get_tasks() -> APIResponse:
    return APIResponseSuccess(data={
        "tasks": tm.dump()
    })


@router.get("/tasks/terminate/{task_id}", response_model_exclude_none=True)
async def terminate_task(task_id: str):
    tm.terminate_task(task_id)
    return APIResponseSuccess()


@router.get("/graphic_cards")
async def list_avaliable_cards() -> APIResponse:
    if not printable_devices:
        return APIResponse(status="pending")

    return APIResponseSuccess(data={
        "cards": printable_devices
    })


@router.get("/schemas/hashes")
async def list_schema_hashes() -> APIResponse:
    if os.environ.get("MIKAZUKI_SCHEMA_HOT_RELOAD", "0") == "1":
        log.info("Hot reloading schemas")
        await load_schemas()

    return APIResponseSuccess(data={
        "schemas": [
            {
                "name": schema["name"],
                "hash": schema["hash"]
            }
            for schema in avaliable_schemas
        ]
    })


@router.get("/schemas/all")
async def get_all_schemas() -> APIResponse:
    return APIResponseSuccess(data={
        "schemas": avaliable_schemas
    })


@router.get("/presets")
async def get_presets() -> APIResponse:
    if os.environ.get("MIKAZUKI_SCHEMA_HOT_RELOAD", "0") == "1":
        log.info("Hot reloading presets")
        await load_presets()

    return APIResponseSuccess(data={
        "presets": avaliable_presets
    })


@router.post("/presets")
async def save_preset(req: PresetSaveRequest) -> APIResponse:
    """Save current form data as a preset TOML file in config/presets/."""
    preset_dir = os.path.join(os.getcwd(), "config", "presets")
    os.makedirs(preset_dir, exist_ok=True)

    # Build TOML content in the same format as existing presets
    meta = {
        "name": req.name,
        "version": req.version,
        "author": req.author,
        "train_type": req.train_type,
        "description": req.description,
    }
    preset = {"metadata": meta, "data": req.data}
    toml_str = toml.dumps(preset)

    # Sanitize filename
    safe_name = re.sub(r'[\\/*?:"<>|]', "_", req.name)
    filepath = os.path.join(preset_dir, f"{safe_name}.toml")

    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(toml_str)
    except OSError as e:
        log.error(f"Failed to save preset: {e}")
        return APIResponseFail(message=f"Failed to save preset / 保存失败: {e}")

    # Reload presets so the new one appears immediately
    await load_presets()

    log.info(f"Preset saved: {safe_name}")
    return APIResponseSuccess(data={"name": req.name, "file": f"{safe_name}.toml"})


@router.delete("/presets/{name}")
async def delete_preset(name: str) -> APIResponse:
    """Delete a preset file from config/presets/."""
    preset_dir = os.path.join(os.getcwd(), "config", "presets")
    safe_name = re.sub(r'[\\/*?:"<>|]', "_", name)
    filepath = os.path.join(preset_dir, f"{safe_name}.toml")

    if not os.path.isfile(filepath):
        return APIResponseFail(message="Preset not found / 预设不存在")

    try:
        os.remove(filepath)
    except OSError as e:
        log.error(f"Failed to delete preset: {e}")
        return APIResponseFail(message=f"Failed to delete preset / 删除失败: {e}")

    await load_presets()

    log.info(f"Preset deleted: {safe_name}")
    return APIResponseSuccess(message=f"Preset deleted / 已删除: {name}")


@router.get("/config/saved_params")
async def get_saved_params() -> APIResponse:
    saved_params = app_config["saved_params"]
    return APIResponseSuccess(data=saved_params)


# ═══════════════════════════════════════════════════════════
#  Flash Attention 环境管理 API
# ═══════════════════════════════════════════════════════════

_fa_cache: dict[str, dict] = {}  # key: source name → {candidates, fetch_error, from_disk, ts}
_FA_CACHE_TTL = 300  # 5 分钟，避免频繁请求 GitHub API 触发限流


def _import_flash_attn_tool():
    """延迟导入 tools/install_flash_attn.py，避免启动时拖慢 import。"""
    import importlib.util
    import sys
    _root = Path(__file__).parents[2]
    _path = _root / "tools" / "install_flash_attn.py"
    if not _path.exists():
        raise ImportError(f"install_flash_attn.py not found at {_path}")
    spec = importlib.util.spec_from_file_location("install_flash_attn", _path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["install_flash_attn"] = mod
    spec.loader.exec_module(mod)
    return mod.detect_env, mod.current_status, mod.fetch_candidates, mod.install_wheel


@router.get("/flash-attention/status")
async def flash_attn_status(source: str = "") -> dict:
    """返回 flash_attn 安装状态 + 环境检测 + GitHub 候选 wheel 列表。
    source: 可选 'default'|'mirror'|'fallback'，空则用默认源。
    """
    import time
    import os as _os
    detect_env, current_status, fetch_candidates, _ = _import_flash_attn_tool()
    # 支持切换源
    if source:
        import tools.install_flash_attn as fa_tool
        try:
            fa_tool.FA_RELEASES_URL, fa_tool.FA_FALLBACK_URLS = _fa_source_config(source)
        except Exception:
            pass
    try:
        status = current_status()
        env = detect_env()
        now = time.time()
        cache_key = source or "default"
        cached = _fa_cache.get(cache_key)
        if cached is None or (now - cached.get("ts", 0)) > _FA_CACHE_TTL:
            candidates, fetch_error = fetch_candidates(env)
            from_disk = False
            # 检测是否来自磁盘缓存（fetch_error 中包含 "回退磁盘缓存" 字样）
            if fetch_error and "回退磁盘缓存" in str(fetch_error):
                from_disk = True
            slim = [
                {"url": c["url"], "name": c["name"], "notes": c.get("notes", c["notes"]) if isinstance(c, dict) else [], "usable": c["usable"]}
                for c in candidates[:20]
            ]
            _fa_cache[cache_key] = {
                "candidates": slim, "fetch_error": fetch_error,
                "from_disk": from_disk, "ts": now
            }
        c = _fa_cache[cache_key]
        token_set = bool(
            _os.environ.get("FA_GITHUB_TOKEN") or _os.environ.get("GITHUB_TOKEN")
        )
        return {
            "installed": status["installed"], "version": status["version"],
            "env": env, "candidates": c["candidates"],
            "fetch_error": c["fetch_error"],
            "from_disk_cache": c.get("from_disk", False),
            "token_set": token_set,
            "source": cache_key,
        }
    except Exception as e:
        log.error(f"flash_attn status error: {e}")
        return {"installed": False, "version": None, "env": {}, "candidates": [], "fetch_error": str(e)}


def _fa_source_config(source: str):
    """切换候选源配置。
    - default: GitHub 官方 API（国际）
    - mirror:  ghproxy 代理（国内）
    - fallback: 备用 GitHub 仓库
    """
    if source == "mirror":
        return (
            "https://ghproxy.com/https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases",
            ["https://ghproxy.com/https://api.github.com/repos/bdashore3/flash-attention/releases"]
        )
    if source == "fallback":
        return (
            "https://api.github.com/repos/bdashore3/flash-attention/releases",
            ["https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases"]
        )
    # default
    return (
        "https://api.github.com/repos/mjun0812/flash-attention-prebuild-wheels/releases",
        ["https://api.github.com/repos/bdashore3/flash-attention/releases"]
    )


@router.post("/flash-attention/install")
async def flash_attn_install(request: Request) -> dict:
    """安装 flash_attn wheel。body: { url: string|null, source: string }。
    url=null 则自动从 GitHub 选最优匹配；否则用指定 URL。
    source='mirror' 时 wheel 下载 URL 自动走 ghproxy 代理。
    """
    detect_env, current_status, fetch_candidates, install_wheel = _import_flash_attn_tool()
    try:
        body = await request.json()
        url = body.get("url", None)
        source = body.get("source", "default")
    except Exception:
        url = None
        source = "default"

    try:
        if url is None:
            env = detect_env()
            # 切换源获取候选
            if source and source != "default":
                import tools.install_flash_attn as fa_tool
                try:
                    fa_tool.FA_RELEASES_URL, fa_tool.FA_FALLBACK_URLS = _fa_source_config(source)
                except Exception:
                    pass
            candidates, _ = fetch_candidates(env)
            url = None
            for c in candidates:
                if c["usable"]:
                    url = c["url"]
                    break
            if url is None:
                return {"success": False, "error": "No usable wheel found. Please specify a URL manually."}
        # 国内镜像：wheel 下载走 ghproxy 代理
        if source == "mirror" and url and not url.startswith("https://ghproxy.com/"):
            url = "https://ghproxy.com/" + url
        result = install_wheel(url)
        return {"success": True, **result}
    except Exception as e:
        log.error(f"flash_attn install error: {e}")
        return {"success": False, "error": str(e)}
