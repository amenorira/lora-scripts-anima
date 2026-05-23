"""New SPA frontend routes (Anima UI).

Mounts at /v2/ — serves the client-side SPA at frontend/index.html.
The legacy HTMX/Alpine templates remain at /v2/legacy/ for backward compat.
"""
import os
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

router = APIRouter(prefix="/v2")

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
ANIMA_UI_INDEX = Path(__file__).parents[2] / "frontend" / "index.html"


def _version() -> str:
    try:
        import subprocess
        r = subprocess.run(["git", "describe", "--tags", "--always"],
                          capture_output=True, text=True,
                          cwd=Path(__file__).parents[2])
        return r.stdout.strip() or "dev"
    except Exception:
        return "dev"


# ── New SPA: catch-all serves frontend/index.html ────────────

@router.get("", response_class=HTMLResponse)
@router.get("/", response_class=HTMLResponse)
@router.get("/{rest:path}", response_class=HTMLResponse)
async def spa_catchall(request: Request, rest: str = ""):
    """Serve the new SPA for all /v2/* routes. Client-side hash routing handles navigation."""
    if ANIMA_UI_INDEX.exists():
        return FileResponse(str(ANIMA_UI_INDEX))
    # Fallback to legacy index
    return templates.TemplateResponse("index.html", {
        "request": request, "active_page": "index", "app_version": _version(),
    })


# ── Legacy template routes (for backward compat) ────────────

TRAIN_CFG = {
    "basic":  ("LoRA 训练 · 新手模式",     "SD1.5 LoRA — 改底模和数据集即可开始", "sd-lora",     "lora-basic"),
    "master": ("LoRA 训练 · 专家模式",     "开放全部高级参数, SD / SDXL / Anima",  "sd-lora",     "lora-master"),
    "anima":  ("Anima LoRA 训练",          "Anima DiT · Qwen3 + T5 双编码器",    "anima-lora",  "anima-lora"),
    "flux":   ("Flux LoRA 训练",           "Flux.1 模型 LoRA 训练",               "flux-lora",   "flux-lora"),
    "sd3":    ("SD3.5 LoRA 训练",          "Stable Diffusion 3.5 LoRA 训练",       "sd3-lora",    "sd3-lora"),
}


@router.get("/legacy/train/{name}", response_class=HTMLResponse)
async def train_page(request: Request, name: str):
    if name not in TRAIN_CFG:
        return HTMLResponse("<h2>未知训练页面</h2>", status_code=404)
    title, subtitle, train_type, active = TRAIN_CFG[name]
    return templates.TemplateResponse("train.html", {
        "request": request, "title": title, "subtitle": subtitle,
        "train_type": train_type, "active_page": active,
        "app_version": _version(),
    })
