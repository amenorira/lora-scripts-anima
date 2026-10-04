"""GPU-isolated Anima worker. Run with the project's venv, never the server process."""
import argparse
import gc
import logging
import os
import sys
import time
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

if __name__ == "__main__":
    os.environ.setdefault("TQDM_DISABLE", "1")

import psutil
import torch
from PIL import Image, PngImagePlugin

from backend.constants import REPO_ROOT, SD_SCRIPTS_DIR
from backend.launch_utils import app_version
from .sampling import sample, sampling_sigmas, schedule
from .storage import atomic_write, item_path, read_manifest, save_manifest, manifest_summary, save_progress

logger = logging.getLogger(__name__)


class Cancelled(Exception):
    pass


def module_bytes(module):
    return sum(t.numel() * t.element_size() for t in (*module.parameters(), *module.buffers()))


def automatic_swap_count(model, available, reserve):
    """Reserve workspace, then offload only as many blocks as needed."""
    remaining = module_bytes(model)
    count = 0
    # The existing offloader must keep two blocks on the GPU.
    for block in reversed(list(model.blocks)[2:]):
        if remaining + reserve <= available:
            break
        remaining -= module_bytes(block)
        count += 1
    return count


class AnimaRunner:
    def __init__(self, settings, report, check):
        sys.path.insert(0, str(SD_SCRIPTS_DIR))
        from library import anima_utils, anima_train_utils
        from library.strategy_anima import AnimaTokenizeStrategy, AnimaTextEncodingStrategy
        self.settings, self.report, self.check = settings, report, check
        self.device = torch.device(f"cuda:{settings['gpu_index']}")
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU required / 需要 CUDA GPU")
        torch.cuda.set_device(self.device)
        # Missing mode identifies existing runs and preserves their explicit settings.
        self.automatic = settings.get("memory_mode", "manual") == "auto"
        self.dtype = (torch.bfloat16 if torch.cuda.is_bf16_supported(including_emulation=False) else torch.float16) if self.automatic else (
            torch.bfloat16 if settings["precision"] == "bf16" else torch.float16)
        # Vendor FP16 blocks promote residuals and modulation to FP32. Keep
        # their base weights in FP32 and use autocast, as in mixed training.
        self.model_dtype = self.dtype if self.dtype == torch.bfloat16 else torch.float32
        report("loading", "Loading Anima / 正在加载 Anima")
        self.model = anima_utils.load_anima_model(self.device, settings["dit"], "torch", True, "cpu", self.model_dtype, False)
        self.model.eval().requires_grad_(False)
        self.model.to(dtype=self.model_dtype)
        self.blocks_to_swap = settings["blocks_to_swap"]
        if self.automatic:
            # A conservative workspace budget for the default ~1 MP output;
            # this is not a guarantee for arbitrary resolutions or concurrent apps.
            self.blocks_to_swap = automatic_swap_count(self.model, torch.cuda.mem_get_info(self.device)[0], 3 * 1024**3)
        if self.blocks_to_swap:
            self.model.enable_block_swap(self.blocks_to_swap, self.device)
            self.model.move_to_device_except_swap_blocks(self.device)
            self.model.switch_block_swap_for_inference()
        else:
            self.model.to(self.device)
        check()
        self.encoder, _ = anima_utils.load_qwen3_text_encoder(settings["text_encoder"], dtype=self.dtype, device="cpu")
        self.encoder.eval().requires_grad_(False)
        self.tokenizer = AnimaTokenizeStrategy(qwen3_path=settings["text_encoder"], t5_tokenizer_path=None,
                                              qwen3_max_length=512, t5_max_length=512)
        self.encoding = AnimaTextEncodingStrategy()
        args = SimpleNamespace(vae=settings["vae"], vae_chunk_size=64, vae_disable_cache=True, qwen_image_vae_2d=True)
        self.vae = anima_train_utils.load_qwen_image_vae(args, device="cpu", disable_mmap=True).to(self.dtype)
        self.vae.eval().requires_grad_(False)
        self.encoder_bytes = module_bytes(self.encoder)
        self.vae_bytes = module_bytes(self.vae)
        self.model_offloaded = False
        report("loading", f"Inference / 推理: {self.dtype}, block swap / 卸载块数={self.blocks_to_swap}, {self.device}")
        self.negative = None
        self.positive_prompt = None
        self.positive = None
        self.check()

    @torch.inference_mode()
    def encode(self, prompt):
        self.check()
        if self.automatic:
            torch.cuda.empty_cache()
            target = self.device if torch.cuda.mem_get_info(self.device)[0] >= self.encoder_bytes + 1024**3 else "cpu"
        else:
            target = "cpu" if self.settings["text_encoder_cpu"] else self.device
        self.report("encoding", f"Text encoder / 文本编码: {target}")
        tokens = self.tokenizer.tokenize(prompt)
        try:
            self.encoder.to(target)
            encoded = self.encoding.encode_tokens(self.tokenizer, [self.encoder], tokens)
        finally:
            self.encoder.to("cpu")
        torch.cuda.empty_cache()
        with torch.autocast("cuda", dtype=self.dtype):
            embedding = self.model._preprocess_text_embeds(
                source_hidden_states=encoded[0].to(self.device), target_input_ids=encoded[2].to(self.device),
                target_attention_mask=encoded[3].to(self.device), source_attention_mask=encoded[1].to(self.device))
        embedding[~encoded[3].to(self.device).bool()] = 0
        return embedding

    @torch.inference_mode()
    def generate(self, item):
        if self.model_offloaded:
            self.model.to(self.device)
            self.model_offloaded = False
        self.report("encoding", "Encoding caption / 编码标签")
        if self.negative is None and self.settings["cfg"] != 1:
            self.negative = self.encode(self.settings["negative"])
        if self.positive_prompt != item["prompt"]:
            self.positive = None
            self.positive_prompt = None
            self.positive = self.encode(item["prompt"])
            self.positive_prompt = item["prompt"]
        positive = self.positive
        self.check()
        generator = torch.Generator("cpu").manual_seed(item["seed"])
        shape = (1, self.model.LATENT_CHANNELS, 1, item["height"] // 8, item["width"] // 8)
        initial = torch.randn(shape, generator=generator, dtype=torch.float32).to(self.device)
        padding = torch.zeros((1, 1, shape[-2], shape[-1]), device=self.device, dtype=self.dtype)
        def velocity(x, time_value):
            self.check()
            self.model.prepare_block_swap_before_forward()
            t = torch.tensor([time_value], device=self.device, dtype=self.dtype)
            with torch.autocast("cuda", dtype=self.dtype):
                v = self.model(x.to(self.dtype), t, positive, padding_mask=padding).float()
            if self.negative is not None:
                self.check()
                self.model.prepare_block_swap_before_forward()
                with torch.autocast("cuda", dtype=self.dtype):
                    uncond = self.model(x.to(self.dtype), t, self.negative, padding_mask=padding).float()
                v = uncond + self.settings["cfg"] * (v - uncond)
            return v
        sigmas = schedule(self.settings["scheduler"], self.settings["steps"], item["width"], item["height"], self.settings["flow_shift"])
        sigmas = sampling_sigmas(sigmas, self.settings["sampler"], self.settings["flow_shift"])
        item["sigmas"] = sigmas.tolist()
        def progress(step, total):
            self.check()
            self.report("sampling", "Sampling / 采样", step, total)
        latent = sample(velocity, initial, sigmas, self.settings["sampler"], generator, progress)
        del positive, initial, padding
        self.report("decoding", "Decoding / 解码")
        # VAE decoding overlaps no text encoder. Blocks stay swapped on the CPU.
        torch.cuda.empty_cache()
        if self.automatic and not self.blocks_to_swap and torch.cuda.mem_get_info(self.device)[0] < self.vae_bytes + 2 * 1024**3:
            self.model.to("cpu")
            self.model_offloaded = True
            torch.cuda.empty_cache()
        try:
            self.vae.to(self.device)
            pixels = self.vae.decode_to_pixels(latent.to(self.dtype)).float().cpu()
        finally:
            self.vae.to("cpu")
        del latent
        if not torch.isfinite(pixels).all():
            raise FloatingPointError("Non-finite VAE decode / VAE 解码含非有限值，请使用 BF16")
        if pixels.ndim == 5:
            pixels = pixels.squeeze(2)
        pixels = ((pixels[0].clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).numpy()
        self.check()
        return Image.fromarray(pixels)


def run(root: Path, runner_factory=AnimaRunner):
    manifest = read_manifest(root)
    manifest["worker"] = {"pid": os.getpid(), "created": psutil.Process().create_time()}
    manifest["status"] = "running"
    manifest["started_at"] = time.time()
    progress = manifest_summary(manifest)
    last_save = 0.
    def check():
        if (root / ".cancel").exists():
            raise Cancelled()
    def report(phase, message, step=0, total=0):
        nonlocal last_save
        manifest.update(phase=phase, step=step, steps=total, updated_at=time.time())
        progress.update(phase=phase, step=step, steps=total, updated_at=manifest["updated_at"],
                        current_index=manifest.get("current_index"))
        if not total or time.monotonic() - last_save >= .8 or step == total:
            save_progress(root, progress)
            last_save = time.monotonic()
        if not total:
            logger.info(message)
    exit_code = 0
    succeeded = failed = 0
    try:
        check()
        software = f"lora-scripts-anima {os.environ.get('ANIMA_VERSION', '').strip() or app_version(REPO_ROOT)}"
        runner = runner_factory(manifest["settings"], report, check)
        manifest["runtime"] = {"torch": torch.__version__, "device": str(getattr(runner, "device", "test")),
                               "precision": str(getattr(runner, "dtype", manifest["settings"]["precision"])), "sampler_version": 2,
                               "blocks_to_swap": getattr(runner, "blocks_to_swap", manifest["settings"]["blocks_to_swap"]),
                               "model_weight_dtype": str(getattr(runner, "model_dtype", "test")),
                               "attention": "torch", "vae_implementation": "qwen_image_vae_2d", "vae_chunk_size": 64,
                               "gpu": torch.cuda.get_device_name() if torch.cuda.is_available() else None}
        for item in manifest["items"]:
            if item["status"] not in {"pending", "failed", "running"}:
                continue
            if "selection" in manifest and item["index"] not in manifest["selection"]:
                continue
            check()
            item.update(status="running", error="")
            manifest["current_index"] = item["index"]
            save_manifest(root, manifest)
            try:
                image = runner.generate(item)
                report("saving", "Saving / 保存")
                info = PngImagePlugin.PngInfo()
                info.add_text("Software", software)
                info.add_text("parameters", f"{item['prompt']}\nNegative prompt: {manifest['settings']['negative']}\n"
                              f"Steps: {manifest['settings']['steps']}, Sampler: {manifest['settings']['sampler']}, "
                              f"Schedule type: {manifest['settings']['scheduler']}, CFG scale: {manifest['settings']['cfg']}, "
                              f"Flow shift: {manifest['settings']['flow_shift']}, "
                              f"Seed: {item['seed']}, Size: {item['width']}x{item['height']}")
                buffer = BytesIO()
                image.save(buffer, format="PNG", pnginfo=info)
                check()
                # Publish caption first: an interrupted save can leave an
                # orphan txt, but never a new trainable image without its txt.
                atomic_write(item_path(root, item, ".txt"), item["caption"].encode("utf-8"))
                atomic_write(item_path(root, item), buffer.getvalue())
                with Image.open(item_path(root, item)) as saved:
                    saved.verify()
                if item_path(root, item, ".txt").read_text(encoding="utf-8") != item["caption"]:
                    raise OSError("Caption write verification failed")
                item["status"] = "completed"
                succeeded += 1
                logger.info("Completed / 已完成 %s, seed=%s", item_path(root, item).name, item['seed'])
            except Cancelled:
                item["status"] = "pending"
                raise
            except (torch.cuda.OutOfMemoryError, MemoryError):
                item.update(status="pending", error="Out of memory / 显存或内存不足")
                raise
            except Exception as exc:
                logger.exception("Image generation failed / 图片生成失败")
                item.update(status="failed", error=f"{type(exc).__name__}: {exc}"[:1000])
                failed += 1
                # A failed half-pair must never be picked up by the trainer.
                storage_paths = [item_path(root, item), item_path(root, item, ".txt")]
                for path in storage_paths:
                    path.unlink(missing_ok=True)
                gc.collect()
                torch.cuda.empty_cache()
            save_manifest(root, manifest)
            progress = manifest_summary(manifest)
        manifest["status"] = "failed" if failed and not succeeded else "finished"
        if failed:
            manifest["error"] = f"{succeeded} succeeded, {failed} failed / 本次成功 {succeeded} 张，失败 {failed} 张"
            logger.warning(manifest["error"])
            exit_code = 1 if not succeeded else 0
        else:
            logger.info("Generation finished / 生成结束")
    except Cancelled:
        manifest["status"] = "terminated"
        logger.info("Generation stopped / 生成已停止")
    except (torch.cuda.OutOfMemoryError, MemoryError) as exc:
        manifest.update(status="failed", error=f"Out of memory / 显存或内存不足: {exc}"[:1000])
        logger.error(manifest["error"])
        exit_code = 1
    except Exception as exc:
        logger.exception("Generation failed / 生成失败")
        manifest.update(status="failed", error=f"{type(exc).__name__}: {exc}"[:1000])
        exit_code = 1
    finally:
        manifest.update(phase="idle", updated_at=time.time(), finished_at=time.time())
        save_manifest(root, manifest)
    return exit_code


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    sys.exit(run(Path(parser.parse_args().run_dir)))
