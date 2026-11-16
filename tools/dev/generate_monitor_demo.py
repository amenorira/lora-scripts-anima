"""Create a completed, clearly simulated training run for manual monitor testing.

Run with the project venv, for example::

    venv/Scripts/python.exe -B tools/dev/generate_monitor_demo.py
    venv/Scripts/python.exe -B tools/dev/generate_monitor_demo.py --single
    venv/Scripts/python.exe -B tools/dev/generate_monitor_demo.py --single --epochs 100
    venv/Scripts/python.exe -B tools/dev/generate_monitor_demo.py --epochs 100
    venv/Scripts/python.exe -B tools/dev/generate_monitor_demo.py --prompt-count 10 --epochs 5
    venv/Scripts/python.exe -B tools/dev/generate_monitor_demo.py --sample-shape mixed --prompt-count 3 --epochs 5

Every invocation creates a new directory under output/. No existing run is
modified, and no model weights are generated.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import random
import sys
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[2]
STEPS = (400, 800, 1200, 1600, 2000)
SINGLE_STEPS = tuple(range(400, 3201, 400))
SEED = 4200
SAMPLE_SIZE = (1024, 1024)
ASPECT_SAMPLE_SIZES = ((832, 1216), (1216, 832), (832, 832))
SAMPLE_SHAPES = {"square": (SAMPLE_SIZE,), "portrait": (ASPECT_SAMPLE_SIZES[0],),
                 "landscape": (ASPECT_SAMPLE_SIZES[1],), "mixed": ASPECT_SAMPLE_SIZES}
SAMPLE_CFG = 5.0
DEFAULT_PROMPT_COUNT = 4
PROMPTS = (
    {"name": "正面特写", "prompt": "demo_anima, geometric fox, front portrait, neutral background"},
    {"name": "全身动作", "prompt": "demo_anima, geometric fox, full body, waving, outdoors"},
    {"name": "侧脸", "prompt": "demo_anima, geometric fox, side profile, soft lighting"},
    {"name": "复杂背景", "prompt": "demo_anima, geometric fox in a studio, window, plants, books"},
    {"name": "正面暖光", "prompt": "demo_anima, geometric fox, front portrait, warm lighting"},
    {"name": "夕阳动作", "prompt": "demo_anima, geometric fox, full body, waving, sunset outdoors"},
    {"name": "侧脸冷光", "prompt": "demo_anima, geometric fox, side profile, cool lighting"},
    {"name": "暖色室内", "prompt": "demo_anima, geometric fox in a warm studio, window, plants, books"},
    {"name": "正面柔光", "prompt": "demo_anima, geometric fox, front portrait, soft lighting"},
    {"name": "日光动作", "prompt": "demo_anima, geometric fox, full body, waving, bright daylight outdoors"},
)


def _write_json(path: Path, value: object) -> None:
    # This script only writes inside its newly created, exclusive run directory.
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def _font(size: int):
    from PIL import ImageFont

    for path in (Path("C:/Windows/Fonts/msyh.ttc"), Path("C:/Windows/Fonts/arial.ttf")):
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size=size)


def _draw_sample(prompt_index: int, seed: int, step: int, *, epoch: int | None = None, total_epochs: int | None = None,
                 size: tuple[int, int] = SAMPLE_SIZE):
    """Draw deterministic, recognizable samples with shared generation settings."""
    from PIL import Image, ImageDraw

    width, height = size
    composition = prompt_index % 4
    backgrounds = ((226, 235, 244), (225, 239, 228), (243, 231, 225), (235, 230, 246))
    image = Image.new("RGB", (width, height), backgrounds[composition])
    draw = ImageDraw.Draw(image)
    rng = random.Random(seed + prompt_index * 100)
    accent = (176 + rng.randrange(35), 108 + rng.randrange(35), 63 + rng.randrange(35))
    ink = (48, 55, 66)
    scale = min(width / 768, height / 768)

    # A consistent composition within each prompt/seed makes stage comparisons
    # easy, while stage-specific shapes remain visibly synthetic.
    draw.rounded_rectangle((22, 22, width - 22, height - 22), radius=18, outline=(175, 185, 198), width=2)
    draw.text((42, 35), f"{width} x {height}", font=_font(round(24 * scale)), fill=ink)
    if composition == 3:
        draw.rectangle((width * .05, height * .18, width * .29, height * .64), fill=(172, 192, 214), outline=(115, 139, 163), width=5)
        draw.line((width * .17, height * .18, width * .17, height * .64), fill=(235, 242, 247), width=6)
        draw.line((width * .05, height * .41, width * .29, height * .41), fill=(235, 242, 247), width=6)
        draw.rectangle((width * .74, height * .25, width * .94, height * .70), fill=(156, 143, 137))
        for shelf in range(3):
            y = height * (.33 + shelf * .13)
            draw.rectangle((width * .75, y, width * .93, y + 8), fill=(108, 100, 105))
            for book in range(6):
                x = width * (.765 + book * .025)
                draw.rectangle((x, y - 41 - rng.randrange(13), x + width * .018, y), fill=(93 + book * 15, 117 + book * 7, 147 + book * 6))
    elif composition == 1:
        draw.ellipse((width * .78, height * .14, width * .90, height * .30), fill=(242, 209, 118))
        draw.rectangle((40, height * .72, width - 40, height - 93), fill=(156, 191, 157))

    cx = width * (.53 if composition == 3 else .50)
    cy = height * (.43 if composition != 1 else .40)
    head = min(width, height) * (.20 if composition != 1 else .14)
    if composition == 2:
        draw.ellipse((cx - head, cy - head, cx + head * .68, cy + head), fill=accent, outline=ink, width=4)
        draw.polygon(((cx + head * .45, cy - head * .25), (cx + head * 1.28, cy + head * .15), (cx + head * .5, cy + head * .42)), fill=(246, 237, 219), outline=ink)
        draw.ellipse((cx + head * .15, cy - head * .20, cx + head * .28, cy - head * .05), fill=ink)
    else:
        draw.ellipse((cx - head, cy - head, cx + head, cy + head), fill=accent, outline=ink, width=4)
        for direction in (-1, 1):
            ex = cx + direction * head * .60
            draw.polygon(((ex - head * .34, cy - head * .62), (ex, cy - head * 1.45), (ex + head * .34, cy - head * .62)), fill=accent, outline=ink)
            eye_x = cx + direction * head * .40
            draw.ellipse((eye_x - head * .065, cy - head * .16, eye_x + head * .065, cy + head * .03), fill=ink)
        draw.polygon(((cx - head * .65, cy + head * .25), (cx, cy + head * .88), (cx + head * .65, cy + head * .25)), fill=(246, 237, 219))
        draw.ellipse((cx - head * .07, cy + head * .29, cx + head * .07, cy + head * .42), fill=ink)
    body_top = cy + head * .82
    body_bottom = min(height - 128, body_top + head * (2.0 if composition == 1 else 1.2))
    draw.rounded_rectangle((cx - head * .75, body_top, cx + head * .75, body_bottom), radius=round(head * .25), fill=(86, 126, 161), outline=ink, width=4)
    if composition == 1:
        draw.line((cx + head * .70, body_top + head * .35, cx + head * 1.40, body_top - head * .30), fill=accent, width=round(head * .24))
        draw.line((cx - head * .38, body_bottom, cx - head * .45, height - 122), fill=ink, width=round(head * .22))
        draw.line((cx + head * .38, body_bottom, cx + head * .62, height - 122), fill=ink, width=round(head * .22))

    # Synthetic geometry grows with the stage; this is a UI fixture, not a
    # visual quality metric or a claim about actual model training.
    if epoch is None:
        for index in range(step // 400 + 1):
            x = 56 + index * 30
            draw.rectangle((x, height - 138, x + 16, height - 119), fill=accent)
    else:
        # A progress marker makes late epochs distinct without implying real
        # model quality or changing the shared prompt/seed composition.
        left, right = 56, width - 56
        draw.rectangle((left, height - 138, right, height - 119), outline=accent, width=2)
        progress = max(0, min(1, epoch / (total_epochs or epoch)))
        draw.rectangle((left, height - 138, left + round((right - left) * progress), height - 119), fill=accent)
    draw.rectangle((24, height - 99, width - 24, height - 24), fill=(247, 248, 250))
    stage = f"Epoch {epoch} / Step {step}" if epoch is not None else f"Step {step}"
    draw.text((42, height - 94), f"SIMULATED / UI TEST    {stage}", font=_font(round(24 * scale)), fill=ink)
    draw.text((42, height - 57), f"Prompt {prompt_index + 1}", font=_font(round(21 * scale)), fill=ink)
    return image


def _write_tensorboard(run_dir: Path, started_at: datetime, total_steps: int) -> int:
    from tensorboard.compat.proto.event_pb2 import Event
    from tensorboard.compat.proto.summary_pb2 import Summary
    from tensorboard.summary.writer.event_file_writer import EventFileWriter

    writer = EventFileWriter(str(run_dir / "log" / "simulated"))
    count = 0
    try:
        for step in range(0, total_steps + 1, 20):
            loss = .092 + .28 * math.exp(-step / 620) + .009 * math.sin(step / 65)
            lr = .0001 * max(.05, 1 - step / (total_steps * 1.125))
            wall_time = (started_at + timedelta(seconds=step * .45)).timestamp()
            for tag, value in (("loss/current", loss), ("loss/average", loss + .006), ("lr/unet", lr)):
                writer.add_event(Event(wall_time=wall_time, step=step, summary=Summary(value=[Summary.Value(tag=tag, simple_value=value)])))
                count += 1
        writer.flush()
    finally:
        writer.close()
    return count


def _sample_parameters(prompt_index: int, size: tuple[int, int] = SAMPLE_SIZE) -> dict:
    width, height = size
    return {"prompt": PROMPTS[prompt_index]["prompt"], "negative_prompt": "lowres, blurry", "seed": SEED,
            "architecture": "anima", "width": width, "height": height, "steps": 30, "cfg_scale": SAMPLE_CFG,
            "sampler": "euler", "scheduler": "native", "flow_shift": 3.0, "loras": []}


def _write_sample_manifest(run_dir: Path, records: list[dict], steps: tuple[int, ...], expected: int, *, epoch_sampling: bool = False) -> None:
    """Use the same versioned per-batch manifest as newly generated samples."""
    from backend.monitor.sample_metadata import write_sample_batch

    for batch_index, step in enumerate(steps):
        items = {record["path"]: {"prompt_index": record["prompt_index"], "prompt_label": record["prompt_name"],
                                  "params": record["parameters"]}
                 for record in records if record["step"] == step}
        epoch = batch_index + 1 if epoch_sampling else None
        batch_id = f"demo-epoch-{epoch:06d}" if epoch is not None else f"demo-step-{step:06d}"
        write_sample_batch(run_dir, {"id": batch_id, "order": batch_index + 1,
                                     "step": step, "epoch": epoch, "expected": expected, "status": "complete"}, items)


def create_demo_run(single: bool = False, epochs: int | None = None, prompt_count: int | None = None,
                    sample_shape: str = "square") -> Path:
    from PIL.PngImagePlugin import PngInfo
    from backend.monitor.run_registry import write_run_record

    if epochs is not None and not 1 <= epochs <= 1000:
        raise ValueError("epochs must be between 1 and 1000")
    if prompt_count is not None and not 1 <= prompt_count <= len(PROMPTS):
        raise ValueError(f"prompt_count must be between 1 and {len(PROMPTS)}")
    if single and prompt_count not in (None, 1):
        raise ValueError("single cannot be combined with multiple prompts")
    if sample_shape not in SAMPLE_SHAPES:
        raise ValueError("unsupported sample shape")
    count = 1 if single else prompt_count or DEFAULT_PROMPT_COUNT
    single = count == 1
    steps = tuple(range(400, epochs * 400 + 1, 400)) if epochs is not None else SINGLE_STEPS if single else STEPS
    prompts = PROMPTS[:count]
    shape_sizes = SAMPLE_SHAPES[sample_shape]
    sizes = [shape_sizes[index % len(shape_sizes)] for index in range(count)]
    title = "模拟训练 单提示词" if single else "模拟训练 固定种子多提示词"
    if prompt_count is not None and not single:
        title = f"模拟训练 固定种子 {count} 提示词"
    if epochs is not None:
        title += f"（{epochs} Epoch）"
    if sample_shape != "square":
        title += " · " + {"portrait": "竖图 832×1216", "landscape": "横图 1216×832", "mixed": "横竖混合比例"}[sample_shape]
    now = datetime.now(timezone(timedelta(hours=8)))
    mode = "single" if single else "fixed_seed"
    if prompt_count is not None and not single:
        mode += f"_{count}prompts"
    if epochs is not None:
        mode += f"_{epochs}epochs"
    if sample_shape != "square":
        mode += f"_{sample_shape}"
    run_name = f"monitor_demo_{mode}_{now:%Y%m%d-%H%M%S}_{uuid4().hex[:6]}"
    run_dir = ROOT / "output" / run_name
    run_dir.resolve().relative_to((ROOT / "output").resolve())
    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "sample").mkdir()
    relative_run = run_dir.relative_to(ROOT).as_posix()
    duration_seconds = steps[-1] // 2
    started_at = now - timedelta(seconds=duration_seconds)
    sampling_schedule = "sample_every_n_epochs = 1" if epochs is not None else "sample_every_n_steps = 400"
    config = f'''# Simulated completed training record for manual UI testing only.
model_train_type = "anima-lora"
output_name = "{title}"
output_dir = "{relative_run}"
pretrained_model_name_or_path = "models/DEMO-NOT-A-MODEL.safetensors"
qwen3 = "models/DEMO-NOT-A-TEXT-ENCODER.safetensors"
network_module = "networks.lora_anima"
network_dim = 16
network_alpha = 16
learning_rate = 0.0001
optimizer_type = "AdamW8bit"
lr_scheduler = "cosine"
max_train_steps = {steps[-1]}
max_train_epochs = {len(steps)}
train_batch_size = 1
train_data_dir = "SIMULATED-DATASET-NOT-FOR-TRAINING"
resolution = "1024,1024"
mixed_precision = "bf16"
seed = 4200
{sampling_schedule}
sample_prompts = "{relative_run}/prompts.txt"
sample_sampler = "euler"
'''
    (run_dir / "config.toml").write_text(config, encoding="utf-8")
    prompt_lines = []
    for prompt_index, prompt in enumerate(prompts):
        width, height = sizes[prompt_index]
        prompt_lines.append(f'{prompt["prompt"]} --n lowres, blurry --w {width} --h {height} --s 30 --l {SAMPLE_CFG:g} --d {SEED} --fs 3')
    (run_dir / "prompts.txt").write_text("\n".join(prompt_lines) + "\n", encoding="utf-8")
    write_run_record(run_dir, artifact_dir=run_dir, task_id=f"simulated-monitor-{uuid4().hex}", created_at=started_at.isoformat(),
                     extra={"profile_id": "anima-lora", "preview_enabled": True, "simulation": True})
    duration_str = f"{duration_seconds // 60}m {duration_seconds % 60}s"
    _write_json(run_dir / "result.json", {"status": "completed", "duration_str": duration_str, "duration_sec": duration_seconds,
                "ended_at": now.isoformat(), "simulation": True, "total_steps": steps[-1]})
    records = []
    for batch_index, step in enumerate(steps):
        batch_time = started_at + timedelta(seconds=step * .45)
        epoch = batch_index + 1 if epochs is not None else None
        for prompt_index, prompt in enumerate(prompts):
            progress = f"e{epoch:06d}" if epoch is not None else f"{step:06d}"
            filename = f"demo_{progress}_{prompt_index:02d}_{batch_time:%Y%m%d%H%M%S}_{SEED}.png"
            parameters = _sample_parameters(prompt_index, sizes[prompt_index])
            metadata = PngInfo()
            metadata.add_text("Comment", "SIMULATED / UI TEST: generated geometric illustration; no trained model was used.")
            metadata.add_text("parameters", json.dumps(parameters, ensure_ascii=False))
            _draw_sample(prompt_index, SEED, step, epoch=epoch, total_epochs=epochs,
                         size=sizes[prompt_index]).save(run_dir / "sample" / filename, pnginfo=metadata)
            records.append({"path": f"sample/{filename}", "step": step, "epoch": epoch, "batch_index": batch_index,
                            "created_at": batch_time.isoformat(), "prompt_index": prompt_index,
                            "prompt_name": prompt["name"], "parameters": parameters})
    _write_sample_manifest(run_dir, records, steps, len(prompts), epoch_sampling=epochs is not None)
    scalar_count = _write_tensorboard(run_dir, started_at, steps[-1])
    log_lines = ["SIMULATED TRAINING RECORD / 模拟训练记录，仅供界面测试。", "No model was trained. No model weights are included."]
    def format_time(seconds: int) -> str:
        return f"{seconds // 60:02d}:{seconds % 60:02d}"

    for step in range(100, steps[-1] + 1, 100):
        loss = .092 + .28 * math.exp(-step / 620) + .009 * math.sin(step / 65)
        elapsed = round(duration_seconds * step / steps[-1])
        remaining = duration_seconds - elapsed
        log_lines.append(f"epoch: {max(1, math.ceil(step / 400))}/{len(steps)}")
        log_lines.append(f"steps: {step * 100 // steps[-1]:3d}%|##########| {step}/{steps[-1]} [{format_time(elapsed)}<{format_time(remaining)}, 2.00it/s, loss/current={loss:.5f}, lr={.0001 * max(.05, 1-step/(steps[-1] * 1.125)):.7f}]")
    log_lines.append(f"SIMULATED completed: {steps[-1]} steps; samples {len(records)}/{len(steps) * len(prompts)}; no model weights generated.")
    (run_dir / "train_simulated.log").write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    sample_description = ("每次使用同一条提示词生成 1 张"
                          if single else f"每次 {count} 个不同提示词，每条生成 1 张")
    expectation = ("默认按最新优先展示采样卡片；点击单图在侧栏预览，通过“打开详情”进入弹窗，使用弹窗缩略图切换采样时点。"
                   if single else "默认按最新优先展示采样卡片；点击多图封面展开本次所有样图，再点击单图在侧栏预览，通过“打开详情”进入弹窗；同提示词可按记录的种子和参数自动配对。")
    stage_description = (f"Epoch 1–{epochs}，每个 Epoch 采样一次，Step 400–{steps[-1]}（每次间隔 400）"
                         if epochs is not None else f'Step {"、".join(str(step) for step in steps)}')
    size_description = "、".join(f"{width} × {height}" for width, height in dict.fromkeys(sizes))
    info = f"""{title}

这是一份已完成状态的模拟训练记录，仅供训练监控界面手动测试。没有执行模型训练，不含可用模型权重。

打开方式：训练历史 → 刷新 → {title} → 预览样本。

覆盖场景：
- {len(steps)} 次采样：{stage_description}。
- {sample_description}，共用固定种子 {SEED}。
- {len(records)} 张几何合成样图，尺寸为 {size_description}，CFG {SAMPLE_CFG:g}；每条提示词在各轮保持相同尺寸和采样设置。
- TensorBoard 合成 Loss/LR：{scalar_count} 条标量；训练日志为模拟内容。

预期：{expectation}
本目录由 tools/dev/generate_monitor_demo.py 独立新建，未覆盖任何既有运行。
"""
    for name in ("run_info.txt", "DEMO_README.txt"):
        (run_dir / name).write_text(info, encoding="utf-8")
    return run_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="生成独立的模拟训练历史，供预览界面测试。")
    parser.add_argument("--single", action="store_true", help="每次采样使用单条提示词生成一张图")
    parser.add_argument("--epochs", type=int, help="按 Epoch 采样并生成指定次数（1–1000）的长历史")
    parser.add_argument("--prompt-count", type=int, help="每次采样的提示词数量（1–10，默认 4）")
    parser.add_argument("--sample-shape", choices=tuple(SAMPLE_SHAPES), default="square",
                        help="样图尺寸：默认 1024 方图；竖图 832×1216、横图 1216×832，mixed 按提示词循环横竖方图")
    args = parser.parse_args()
    if args.epochs is not None and not 1 <= args.epochs <= 1000:
        parser.error("--epochs 必须在 1–1000 之间")
    if args.prompt_count is not None and not 1 <= args.prompt_count <= len(PROMPTS):
        parser.error("--prompt-count 必须在 1–10 之间")
    if args.single and args.prompt_count not in (None, 1):
        parser.error("--single 不能与多个提示词同时使用")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT))
    from tools.runtime_paths import configure_test_paths

    configure_test_paths()
    path = create_demo_run(single=args.single, epochs=args.epochs, prompt_count=args.prompt_count,
                           sample_shape=args.sample_shape)
    print(path)
    count = 1 if args.single else args.prompt_count or DEFAULT_PROMPT_COUNT
    sample_count = (args.epochs or (len(SINGLE_STEPS) if count == 1 else len(STEPS))) * count
    print(f"模拟训练记录已生成：{sample_count} 张固定种子{'单提示词' if count == 1 else f'{count} 提示词'}样图；不含模型权重。")


if __name__ == "__main__":
    main()
