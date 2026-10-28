"""检查点命名解析与 TensorBoard、日志 loss 对应。"""
from __future__ import annotations

import re
from pathlib import Path

from backend.constants import REPO_ROOT
from backend.monitor.log_files import _tail_file

LORA_EXTENSIONS = {".safetensors", ".pt", ".pth"}


# ── Checkpoint 解析（文件名 → epoch/step 编号）──────────────
# 命名约定见 vendor/sd-scripts/library/checkpoint_io.py:
#   epoch 存档: {name}-{:06d}.{ext}      → my_lora-000003.safetensors
#   step  存档: {name}-step{:08d}.{ext}  → my_lora-step00001000.safetensors
#   最终  存档: {name}.{ext}             → my_lora.safetensors / last.safetensors

_RE_CKPT_EPOCH = re.compile(r"^(?P<name>.+)-(?P<epoch>\d{6})\.(?:safetensors|pt|pth)$")
_RE_CKPT_STEP = re.compile(r"^(?P<name>.+)-step(?P<step>\d{8})\.(?:safetensors|pt|pth)$")


def parse_checkpoint(name: str) -> dict | None:
    """从模型文件名解析 checkpoint 类型与编号。

    返回:
      {'type': 'epoch', 'epoch_no': N, 'step': None} |
      {'type': 'step',  'epoch_no': None, 'step': S} |
      {'type': 'final', 'epoch_no': None, 'step': None} |
      None（非 .safetensors/.pt/.pth 或无法识别）
    """
    if not name:
        return None
    suffix = name.rsplit(".", 1)[-1].lower()
    if ("." + suffix) not in LORA_EXTENSIONS:
        return None
    m = _RE_CKPT_STEP.search(name)
    if m:
        return {"type": "step", "epoch_no": None, "step": int(m.group("step"))}
    m = _RE_CKPT_EPOCH.search(name)
    if m:
        return {"type": "epoch", "epoch_no": int(m.group("epoch")), "step": None}
    # 无数字后缀的模型文件 → 最终存档
    return {"type": "final", "epoch_no": None, "step": None}


# loss/epoch_average 每 epoch 末追加一次，第 N 个点对应第 N 个 epoch。
# 见 vendor/sd-scripts/train_network.py:1803-1804（loss_recorder.moving_average + epoch_logging）。
_LOSS_EPOCH_AVG = "loss/epoch_average"


def enrich_model_files_with_loss(files: list[dict], tb_series: list[dict], run_dir: str = "") -> list[dict]:
    """给 list_output_files 的结果中 model 类文件补充对应 loss。

    优先从 TensorBoard 读取；TB 无数据时回退到解析训练日志（从保存检查点
    之前的进度行提取 avr_loss/loss）。
    """
    if not files:
        return files
    # 预取常用 series，避免重复扫描
    epoch_avg = None
    step_series = None
    avg_latest = None
    if tb_series:
        for s in tb_series:
            tag = s.get("tag")
            if tag == _LOSS_EPOCH_AVG and epoch_avg is None:
                epoch_avg = s.get("points") or []
            if tag == "loss/average":
                avg_latest = s.get("latest")
            if tag == "loss/average":
                step_series = s.get("points") or []
            elif step_series is None and tag == "loss/current":
                step_series = s.get("points") or []

    for f in files:
        if f.get("category") != "model":
            continue
        ckpt_type = f.get("ckpt_type")
        loss = None
        try:
            if ckpt_type == "epoch" and f.get("ckpt_epoch") is not None and epoch_avg:
                point = next((p for p in epoch_avg if p["step"] == f["ckpt_epoch"]), None)
                if point:
                    loss = point["value"]
                    f["loss_source"] = _LOSS_EPOCH_AVG
                    f["loss_step"] = point["step"]
            elif ckpt_type == "step" and f.get("ckpt_step") is not None:
                from bisect import bisect_right
                points = step_series or []
                idx = bisect_right(points, f["ckpt_step"], key=lambda p: p["step"]) - 1
                if idx >= 0:
                    point = points[idx]
                    loss = point["value"]
                    f["loss_step"] = point["step"]
                    f["loss_approximate"] = point["step"] != f["ckpt_step"]
                    f["loss_source"] = "loss/average" if avg_latest is not None else "loss/current"
            elif ckpt_type == "final":
                loss = avg_latest
                f["loss_source"] = "loss/average"
        except (KeyError, IndexError, TypeError):
            loss = None
        f["ckpt_loss"] = loss

    # 回退：TensorBoard 无数据时从训练日志提取
    if run_dir and any(f.get("category") == "model" and f.get("ckpt_loss") is None for f in files):
        log_losses = _parse_log_checkpoint_losses(run_dir)
        for f in files:
            if f.get("category") != "model" or f.get("ckpt_loss") is not None:
                continue
            name = f.get("name", "")
            if name in log_losses:
                    f["ckpt_loss"] = log_losses[name]
                    f["loss_source"] = "log"
                    f["loss_approximate"] = True

    return files


def _parse_log_checkpoint_losses(run_dir: str) -> dict[str, float]:
    """从训练日志中提取每个检查点保存前的 loss 值。

    解析模式：在 'saving checkpoint' 行之前查找 'avr_loss=X.XXX' 或 'loss=X.XXX'。
    返回 {文件名: loss值} 字典。
    """
    rd = Path(run_dir)
    if not rd.is_absolute():
        rd = (REPO_ROOT / run_dir).resolve()
    if not rd.is_dir():
        return {}

    # 查找训练日志文件
    log_files = sorted(rd.glob("train_*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not log_files:
        return {}

    lines = _tail_file(log_files[0])
    if not lines:
        return {}

    re_loss = re.compile(r'(?:avr_loss|loss)[:=]\s*([\d.]+)')
    # 匹配: saving checkpoint: .../name-000002.safetensors 或 name-step00001000.safetensors
    re_save = re.compile(
        r'saving\s+checkpoint.*?[/\\](?P<name>[\w.-]+?)(?:-step(?P<step>\d{8})|-(?P<epoch>\d{6}))\.safetensors'
    )
    # 也匹配最终存档（无数字后缀的 safetensors）
    re_final = re.compile(
        r'saving\s+checkpoint.*?[/\\](?P<name>[\w.-]+)\.safetensors\s*$'
    )

    losses: dict[str, float] = {}
    for i, line in enumerate(lines):
        m = re_save.search(line)
        if m:
            fname = m.group(0).split('/')[-1].split('\\')[-1].strip()
            # 向前查找 loss
            for j in range(i - 1, max(i - 6, -1), -1):
                lm = re_loss.search(lines[j])
                if lm:
                    losses[fname] = float(lm.group(1))
                    break
            continue
        m = re_final.search(line)
        if m:
            fname = m.group(0).split('/')[-1].split('\\')[-1].strip()
            for j in range(i - 1, max(i - 6, -1), -1):
                lm = re_loss.search(lines[j])
                if lm:
                    losses[fname] = float(lm.group(1))
                    break

    return losses
