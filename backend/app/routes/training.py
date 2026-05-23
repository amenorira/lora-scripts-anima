"""
Training routes — POST /run, POST /run_script
"""
import json
import os
from datetime import datetime

import toml
from fastapi import APIRouter, BackgroundTasks, Request

from backend.anima_backend import run_train
from backend import launch_utils
from backend.app.models import APIResponseFail, APIResponseSuccess
from backend.log import log
from backend.utils import train_utils

router = APIRouter()

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

avaliable_scripts = [
    "networks/extract_lora_from_models.py",
    "networks/extract_lora_from_dylora.py",
    "networks/merge_lora.py",
    "tools/merge_models.py",
]


def get_sample_prompts(config: dict):
    """Extract and format sample prompt configuration."""
    import random
    from glob import glob
    from typing import Optional, Tuple

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
            raise ValueError(
                'Multiple subdirectories found / 多子文件夹; '
                'random prompt selection requires a single subdirectory / 随机选取 Prompt 需要单一子文件夹'
            )

        txt_files = glob(os.path.join(sub_dir[0], '*.txt'))
        if not txt_files:
            raise ValueError('No .txt files found in dataset directory / 数据集路径没有 txt 文件')
        try:
            sample_prompt_file = random.choice(txt_files)
            with open(sample_prompt_file, 'r', encoding='utf-8') as f:
                positive_prompts = f.read()
        except IOError:
            log.error(f"Failed to read prompt file / 读取失败: {sample_prompt_file}")

    sample_prompts_arg = (
        f'{positive_prompts} --n {negative_prompts} '
        f'--w {sample_width} --h {sample_height} '
        f'--l {sample_cfg} --s {sample_steps} --d {sample_seed}'
    )
    return positive_prompts, sample_prompts_arg


@router.post("/run")
async def create_toml_file(request: Request):
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    toml_file = os.path.join(os.getcwd(), "config", "autosave", f"{timestamp}.toml")
    json_data = await request.body()

    config: dict = json.loads(json_data.decode("utf-8"))
    train_utils.fix_config_types(config)

    gpu_ids = config.pop("gpu_ids", None)

    suggest_cpu_threads = 8 if len(train_utils.get_total_images(config["train_data_dir"])) > 200 else 2
    model_train_type = config.get("model_train_type", "sd-lora")
    trainer_file = trainer_mapping[model_train_type]

    # ── Anima Backend Adapter: whitelist filter + NaN cleanup + path normalization ──
    try:
        from backend.anima_backend import adapt_config, detect_attention_backend
        adapted_config, warnings = adapt_config(config)
        for w in warnings:
            log.warning(f"[Adapter] {w}")
        config = adapted_config

        if "attn_mode" in config:
            attn_requested = config.get("attn_mode", "torch")
            attn_actual, attn_warning = detect_attention_backend(attn_requested)
            if attn_warning:
                log.warning(f"[Attn] {attn_warning}")
                config["attn_mode"] = attn_actual
    except ImportError:
        pass
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
                sample_prompts_file = os.path.join(os.getcwd(), "config", "autosave", f"{timestamp}-promopt.txt")
                with open(sample_prompts_file, "w", encoding="utf-8") as f:
                    f.write(sample_prompts_arg)
                config["sample_prompts"] = sample_prompts_file
                log.info(f"Wrote prompts to file {sample_prompts_file}")

        except ValueError as e:
            log.error(f"Error while processing prompts: {e}")
            return APIResponseFail(message=str(e))

    with open(toml_file, "w", encoding="utf-8") as f:
        f.write(toml.dumps(config))

    result = run_train(toml_file, trainer_file, gpu_ids, suggest_cpu_threads)
    return result


@router.post("/run_script")
async def run_script(request: Request, background_tasks: BackgroundTasks):
    from pathlib import Path

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
