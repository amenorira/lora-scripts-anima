"""SDXL checkpoint inference using the trainer's existing SDXL pipeline."""
import sys

import torch
from PIL import Image

from backend.constants import SD_SCRIPTS_DIR


def create_scheduler(settings):
    from diffusers import (EulerDiscreteScheduler, EulerAncestralDiscreteScheduler,
                           HeunDiscreteScheduler, DPMSolverMultistepScheduler)
    sampler, schedule = settings["sampler"], settings["scheduler"]
    classes = {"euler": EulerDiscreteScheduler, "euler_a": EulerAncestralDiscreteScheduler,
               "heun": HeunDiscreteScheduler, "dpmpp_2m": DPMSolverMultistepScheduler,
               "dpmpp_2m_sde": DPMSolverMultistepScheduler}
    if sampler not in classes or schedule not in {"normal", "karras", "exponential"}:
        raise ValueError("Unsupported SDXL sampler/schedule")
    if sampler == "euler_a" and schedule != "normal":
        raise ValueError("SDXL Euler ancestral requires normal schedule")
    options = dict(num_train_timesteps=1000, beta_start=.00085, beta_end=.012,
                   beta_schedule="scaled_linear", prediction_type="epsilon")
    if sampler != "euler_a":
        options.update(use_karras_sigmas=schedule == "karras", use_exponential_sigmas=schedule == "exponential")
    if sampler.startswith("dpmpp"):
        options.update(algorithm_type="sde-dpmsolver++" if sampler.endswith("sde") else "dpmsolver++", solver_order=2)
    return classes[sampler](**options)


class SdxlRunner:
    def __init__(self, settings, report, check):
        sys.path.insert(0, str(SD_SCRIPTS_DIR))
        from library import model_util, sdxl_model_util, strategy_base, strategy_sdxl
        from library.sdxl_lpw_stable_diffusion import SdxlStableDiffusionLongPromptWeightingPipeline
        self.settings, self.report, self.check = settings, report, check
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU required / 需要 CUDA GPU")
        self.device = torch.device(f"cuda:{settings['gpu_index']}")
        torch.cuda.set_device(self.device)
        self.automatic = settings.get("memory_mode", "auto") == "auto"
        self.dtype = (torch.bfloat16 if torch.cuda.is_bf16_supported(including_emulation=False) else torch.float16) if self.automatic else (
            torch.bfloat16 if settings["precision"] == "bf16" else torch.float16)
        self.model_dtype, self.blocks_to_swap = self.dtype, 0
        report("loading", "Loading SDXL / 正在加载 SDXL")
        encoder1, encoder2, vae, unet, _, _ = sdxl_model_util.load_models_from_sdxl_checkpoint(
            sdxl_model_util.MODEL_VERSION_SDXL_BASE_V1_0, settings["checkpoint"], "cpu")
        check()
        if settings.get("sdxl_vae", "").strip():
            vae = model_util.load_vae(settings["sdxl_vae"], torch.float32)
        for module in (encoder1, encoder2, vae, unet):
            module.eval().requires_grad_(False)
        # CLIP remains FP32 on CPU; the standard SDXL VAE also needs FP32.
        vae.to(dtype=torch.float32)
        unet.to(dtype=self.dtype)
        unet.set_use_sdpa(True)
        tokenize = strategy_sdxl.SdxlTokenizeStrategy(225)
        strategy_base.TokenizeStrategy.set_strategy(tokenize)
        strategy_base.TextEncodingStrategy.set_strategy(strategy_sdxl.SdxlTextEncodingStrategy())
        self.pipeline = SdxlStableDiffusionLongPromptWeightingPipeline(
            vae, [encoder1, encoder2], [tokenize.tokenizer1, tokenize.tokenizer2], unet,
            create_scheduler(settings), None, None, requires_safety_checker=False)
        self.pipeline.to(self.device, self.dtype)
        from .worker import module_bytes
        self.offloaded = self.automatic and torch.cuda.mem_get_info(self.device)[0] < module_bytes(unet) + 3 * 1024**3
        if self.offloaded:
            from accelerate import cpu_offload
            cpu_offload(unet, execution_device=self.device)
        else:
            unet.to(self.device)
            if not self.automatic and not settings["text_encoder_cpu"]:
                encoder1.to(self.device)
                encoder2.to(self.device)
        check()

    @torch.inference_mode()
    def generate(self, item):
        self.check()
        pipe = self.pipeline
        if self.automatic and not self.offloaded:
            pipe.unet.to(self.device)
        # A fresh scheduler resets multistep history between images.
        pipe.scheduler = create_scheduler(self.settings)
        def progress(timesteps):
            total = len(timesteps)
            for index, timestep in enumerate(timesteps):
                self.check()
                self.report("sampling", "Sampling / 采样", index, total)
                yield timestep
            self.report("sampling", "Sampling / 采样", total, total)
        pipe.progress_bar = progress
        self.report("encoding", "Encoding caption / 编码标签")
        generator = torch.Generator(self.device).manual_seed(item["seed"])
        def callback(*args):
            self.check()
            if not torch.isfinite(args[-1]).all():
                raise FloatingPointError("Non-finite SDXL sampling / SDXL 采样结果含非有限值")
        with torch.autocast("cuda", dtype=self.dtype):
            latent = pipe(prompt=item["prompt"], negative_prompt=self.settings["negative"],
                          width=item["width"], height=item["height"],
                          num_inference_steps=self.settings["steps"], guidance_scale=self.settings["cfg"],
                          generator=generator, callback=callback)
        item["sigmas"] = pipe.scheduler.sigmas.cpu().tolist()
        self.check()
        self.report("decoding", "Decoding / 解码")
        if self.automatic:
            if not self.offloaded:
                pipe.unet.to("cpu")
            torch.cuda.empty_cache()
        try:
            pipe.vae.to(self.device)
            from library.sdxl_model_util import VAE_SCALE_FACTOR
            pixels = pipe.vae.decode(latent.float() / VAE_SCALE_FACTOR).sample.float().cpu()
        finally:
            pipe.vae.to("cpu")
        if not torch.isfinite(pixels).all():
            raise FloatingPointError("Non-finite SDXL VAE decode / SDXL VAE 解码含非有限值")
        self.check()
        pixels = ((pixels[0].clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).numpy()
        return Image.fromarray(pixels)
