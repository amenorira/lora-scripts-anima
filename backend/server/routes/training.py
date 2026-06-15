"""
Training routes — POST /run, POST /run_script
"""
import asyncio
import json
import os
from datetime import datetime

import toml
from fastapi import APIRouter, BackgroundTasks, Request

from backend.training import run_train
from backend import launch_utils
from backend.server.models import APIResponseFail, APIResponseSuccess
from backend.log import log
from backend.utils import train_utils

router = APIRouter()

trainer_mapping = {
    "sdxl-lora": "./vendor/sd-scripts/sdxl_train_network.py",
    "sdxl-finetune": "./vendor/sd-scripts/sdxl_train.py",
    "sd3-lora": "./vendor/sd-scripts/sd3_train_network.py",
    "sd3-finetune": "./vendor/sd-scripts/sd3_train.py",
    "flux-lora": "./vendor/sd-scripts/flux_train_network.py",
    "flux-finetune": "./vendor/sd-scripts/flux_train.py",
    "flux-controlnet": "./vendor/sd-scripts/flux_train_control_net.py",
    "anima-lora": "./vendor/sd-scripts/anima_train_network.py",
    "anima-controlnet": "./vendor/sd-scripts/anima_train_control_net_lllite.py",
    "hunyuan-lora": "./vendor/sd-scripts/hunyuan_image_train_network.py",
    "lumina-lora": "./vendor/sd-scripts/lumina_train_network.py",
    "lumina-finetune": "./vendor/sd-scripts/lumina_train.py",
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

    positive_prompts = config.get('positive_prompts', None)
    negative_prompts = config.get('negative_prompts', '')
    sample_width = config.get('sample_width', 512)
    sample_height = config.get('sample_height', 512)
    sample_cfg = config.get('sample_cfg', 7)
    sample_seed = config.get('sample_seed', 2333)
    sample_steps = config.get('sample_steps', 24)
    randomly_choice_prompt = config.get('randomly_choice_prompt', False)

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
            seed_val = config.get("seed", 2333)
            sample_prompt_file = random.Random(int(seed_val)).choice(txt_files)
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


def _cleanup_autosave(autosave_dir: str, keep: int = 50) -> None:
    """清理 autosave 目录，仅保留最近 N 个 TOML 文件"""
    try:
        files = sorted(
            [f for f in os.listdir(autosave_dir) if f.endswith(".toml")],
            key=lambda f: os.path.getmtime(os.path.join(autosave_dir, f)),
            reverse=True,
        )
        for old_file in files[keep:]:
            try:
                os.remove(os.path.join(autosave_dir, old_file))
            except OSError:
                pass
    except OSError:
        pass


def _write_run_info(run_dir: str, config: dict, train_type: str, timestamp: str, is_resume: bool) -> None:
    """写入人类可读的训练摘要 run_info.txt"""
    try:
        model_path = config.get("pretrained_model_name_or_path", "?")
        model_name = os.path.basename(model_path) if model_path else "?"
        dataset = config.get("train_data_dir", "?")
        lines = [
            f"Training Run: {os.path.basename(run_dir)}",
            f"Started:      {timestamp}",
            f"Type:         {train_type}",
            f"Resume:       {'yes' if is_resume else 'no'}",
            f"Model:        {model_name}",
            f"Dataset:      {dataset}",
            f"Output Name:  {config.get('output_name', '?')}",
            f"Resolution:   {config.get('resolution', '?')}",
            f"Batch Size:   {config.get('train_batch_size', '?')}",
            f"LR:           {config.get('learning_rate', '?')}",
            f"Optimizer:    {config.get('optimizer_type', '?')}",
            f"Network Dim:  {config.get('network_dim', '?')}",
            f"Network Alpha:{config.get('network_alpha', '?')}",
            f"Epochs:       {config.get('max_train_epochs', '?')}",
            f"Mixed Prec:   {config.get('mixed_precision', '?')}",
            f"Seed:         {config.get('seed', '?')}",
            "",
            f"Full config:  config.toml",
            f"Training log: train_*.log",
            f"Checkpoints:  checkpoints/",
        ]
        info_path = os.path.join(run_dir, "run_info.txt")
        with open(info_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except OSError as e:
        log.warning(f"Failed to write run_info.txt / 写入失败: {e}")


@router.post("/run")
async def create_toml_file(request: Request):
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_data = await request.body()

    config: dict = json.loads(json_data.decode("utf-8"))
    train_utils.fix_config_types(config)

    gpu_ids = config.pop("gpu_ids", None)

    model_train_type = config.get("model_train_type", "sdxl-lora")
    trainer_file = trainer_mapping.get(model_train_type)
    if not trainer_file:
        return APIResponseFail(message=f"Unsupported training type: {model_train_type} / 不支持的训练类型: {model_train_type}")

    # ── Anima Backend Adapter: whitelist filter + NaN cleanup + path normalization ──
    try:
        from backend.training import adapt_config, detect_attention_backend
    except ImportError as e:
        log.error(f"[Adapter] Failed to import training adapter / 训练适配器导入失败: {e}")
        return APIResponseFail(message=f"Training adapter import error / 训练适配器导入错误: {e}")

    adapted_config, adapter_warnings = adapt_config(config)
    for w in adapter_warnings:
        log.warning(f"[Adapter] {w}")
    config = adapted_config

    if "attn_mode" in config:
        attn_requested = config.get("attn_mode", "torch")
        attn_actual, attn_warning = detect_attention_backend(attn_requested)
        if attn_warning:
            log.warning(f"[Attn] {attn_warning}")
            config["attn_mode"] = attn_actual
    # ──────────────────────────────────────────────────────────

    # ── Per-run folder: isolate each training run ──────────────
    output_name = config.get("output_name", "my_lora")
    safe_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in output_name).strip("._-") or "my_lora"
    run_dir_name = f"{safe_name}_{timestamp}"
    is_resume = bool(config.get("resume", "").strip())

    # 用户设置的基础输出目录（默认 ./output），后端自动在其下创建子文件夹
    output_base = config.get("output_dir", "./output")

    if not is_resume:
        run_dir = os.path.join(output_base, run_dir_name)
        os.makedirs(run_dir, exist_ok=True)
        # sd-scripts 原生写入 checkpoints/（模型 + 样本图），log/ 单独指定
        config["output_dir"] = os.path.join(run_dir, "checkpoints")
        config["logging_dir"] = os.path.join(run_dir, "log")
    else:
        # 续训时保持原 output_dir（含 checkpoints/），但日志也放到对应 run 目录
        run_dir = config.get("output_dir", os.path.join(output_base, run_dir_name, "checkpoints"))
        # run_dir 在续训时是 checkpoints/ 的父目录
        if "checkpoints" in str(run_dir):
            run_dir = os.path.dirname(str(run_dir))
        if "logging_dir" not in config:
            config["logging_dir"] = os.path.join(str(run_dir), "log")
    # ──────────────────────────────────────────────────────────

    if model_train_type != "sdxl-finetune":
        if not train_utils.validate_data_dir(config["train_data_dir"]):
            return APIResponseFail(message="Dataset directory not found or no images / 数据集路径不存在或无图片")

    suggest_cpu_threads = 8 if len(await asyncio.to_thread(train_utils.get_total_images, config["train_data_dir"])) > 200 else 2

    validated, message = train_utils.validate_model(config["pretrained_model_name_or_path"], model_train_type)
    if not validated:
        return APIResponseFail(message=message)

    # ── Anima: qwen3 编码器路径必填校验 ─────────────────
    if model_train_type == "anima-lora":
        qwen3_path = config.get("qwen3", "").strip()
        if not qwen3_path:
            return APIResponseFail(
                message="Qwen3 path is required for Anima LoRA training / "
                "Anima LoRA 训练需要填写 Qwen3 编码器路径"
            )

    if "prompt_file" in config and config["prompt_file"].strip() != "":
        prompt_file = config["prompt_file"].strip()
        if not os.path.exists(prompt_file):
            return APIResponseFail(message=f"Prompt file not found / 文件不存在: {prompt_file}")
        config["sample_prompts"] = prompt_file
    else:
        try:
            positive_prompt, sample_prompts_arg = get_sample_prompts(config=config)

            if positive_prompt is not None and train_utils.is_prompt_like(sample_prompts_arg):
                # 样本提示词也放入运行文件夹
                os.makedirs(run_dir, exist_ok=True)
                sample_prompts_file = os.path.join(run_dir, "prompts.txt")
                with open(sample_prompts_file, "w", encoding="utf-8") as f:
                    f.write(sample_prompts_arg)
                config["sample_prompts"] = sample_prompts_file
                log.info(f"Wrote prompts to file {sample_prompts_file}")

        except ValueError as e:
            log.error(f"Error while processing prompts: {e}")
            return APIResponseFail(message=str(e))

    # ── A: autosave — 保留最近 50 个，清理旧文件 ────────────
    autosave_dir = os.path.join(os.getcwd(), "config", "autosave")
    os.makedirs(autosave_dir, exist_ok=True)
    _cleanup_autosave(autosave_dir, keep=50)

    toml_file = os.path.join(autosave_dir, f"{timestamp}.toml")
    toml_content = toml.dumps(config)

    def _write_configs():
        with open(toml_file, "w", encoding="utf-8") as f:
            f.write(toml_content)
        run_config_file = os.path.join(run_dir, "config.toml")
        with open(run_config_file, "w", encoding="utf-8") as f:
            f.write(toml_content)

    await asyncio.to_thread(_write_configs)
    # ──────────────────────────────────────────────────────────

    # ── G: 写入人类可读 run_info.txt ─────────────────────────
    await asyncio.to_thread(_write_run_info, run_dir, config, model_train_type, timestamp, is_resume)
    # ──────────────────────────────────────────────────────────

    result = run_train(toml_file, trainer_file, gpu_ids, suggest_cpu_threads, output_dir=run_dir)

    # 将适配器警告附加到返回结果中（前端弹窗展示）
    if result.get("status") == "success" and adapter_warnings:
        if "data" not in result or not isinstance(result["data"], dict):
            result["data"] = {}
        result["data"]["warnings"] = adapter_warnings

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
            result.append(str(v))
    script_path = Path(os.getcwd()) / "vendor" / "sd-scripts" / script_name
    if not script_path.exists():
        return APIResponseFail(message=f"Script not found / 脚本不存在: {script_name}")
    cmd_list = [launch_utils.python_bin, str(script_path)] + result
    background_tasks.add_task(launch_utils.run, cmd_list)
    return APIResponseSuccess()
