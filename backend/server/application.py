import asyncio
import mimetypes
import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware

from backend.server.api import router as api_router
from backend.server.routes.training import router as training_router
from backend.server.proxy import router as proxy_router
from backend.monitor import router as monitor_router
from backend.tageditor import router as tageditor_router
from backend.utils.devices import check_torch_gpu
from backend.monitor.monitor import task_monitor
from backend.monitor.run_registry import import_legacy_external_runs
from backend.server.routes.realtime import router as realtime_router
from backend.constants import REPO_ROOT
from backend.startup_output import show_environment, show_ready

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as ex:
            if ex.status_code == 404:
                return await super().get_response("index.html", scope)
            else:
                raise ex


async def app_startup():
    from backend.log import log as _log
    try:
        migration = await asyncio.to_thread(import_legacy_external_runs)
    except Exception as exc:
        migration = {}
        _log.warning(
            "Legacy external run import skipped: %s / 旧跨盘训练记录导入已跳过: %s",
            exc, exc,
        )
    runtime = await asyncio.to_thread(check_torch_gpu) or {}

    host = os.environ.get("ANIMA_HOST", "127.0.0.1")
    port = os.environ.get("ANIMA_PORT", "12333")
    browser_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{browser_host}:{port}/"
    if migration.get("imported"):
        _log.info(
            "Imported %s legacy external run(s) / 已恢复 %s 条旧跨盘训练记录",
            migration["imported"], migration["imported"],
        )

    software = [
        f"App {os.environ.get('ANIMA_VERSION', 'unknown')}",
        f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
    ]
    if runtime.get("torch_version"):
        software.append(f"Torch {runtime['torch_version']}")
    compute = [runtime.get("backend", "unknown")]
    gpus = runtime.get("gpus", [])
    if gpus:
        first_gpu = gpus[0]
        gpu_text = f"{first_gpu['name']} ({first_gpu['memory_gb']} GB)"
        if len(gpus) > 1:
            gpu_text += f" +{len(gpus) - 1}"
        compute.append(gpu_text)
    environment = [
        ("Software / 软件", "  |  ".join(software)),
        ("Compute / 计算", "  |  ".join(compute)),
    ]
    free_disk = os.environ.get("ANIMA_FREE_DISK_GB")
    if free_disk:
        environment.append(("Storage / 存储", f"{free_disk} GB free / 可用"))
    if host in {"0.0.0.0", "::"}:
        environment.append(("Network / 网络", f"LAN access enabled on port {port} / 已开放局域网访问"))
    show_environment(environment)

    tensorboard_url = os.environ.get("ANIMA_TENSORBOARD_URL") or None
    if tensorboard_url:
        tensorboard_host = os.environ.get("ANIMA_TENSORBOARD_HOST", "127.0.0.1")
        tensorboard_port = os.environ.get("ANIMA_TENSORBOARD_PORT", "6006")
        tensorboard_browser_host = (
            "127.0.0.1" if tensorboard_host in {"0.0.0.0", "::"} else tensorboard_host
        )
        tensorboard_url = f"http://{tensorboard_browser_host}:{tensorboard_port}/"
    show_ready(
        url,
        tensorboard_url=tensorboard_url,
        log_path=REPO_ROOT / "logs" / "anima.log",
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时
    await task_monitor.start()

    await app_startup()

    yield

    # 关闭时
    await task_monitor.stop()


app = FastAPI(lifespan=lifespan)
app.include_router(proxy_router)
app.include_router(realtime_router)


# CORS only needed for dev debugging; not required for localhost use
if os.environ.get("ANIMA_DEV") == "1":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


# Compress text-heavy responses (static JS/CSS, field registry JSON, ...).
# Content is byte-identical after decompression, so nothing observable
# changes except transfer size.
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def add_cache_control_header(request, call_next):
    response = await call_next(request)
    path = request.url.path
    # Generated preview variants are immutable for their versioned URL and
    # must keep their own ETag/cache policy on slow remote links.
    if path in {"/api/image-preview", "/api/monitor/preview-metadata"}:
        return response
    if path.startswith("/api/"):
        # no-store forced a full re-download on every load even for stable
        # registries (e.g. /api/fields, which now carries its own ETag and
        # answers 304 when unchanged). no-cache keeps revalidation semantics
        # while allowing validators to short-circuit.
        response.headers["Cache-Control"] = "no-cache, max-age=0"
    elif path.startswith("/anima-ui/"):
        # Every /anima-ui asset referenced from index.html carries a ?v=
        # content-version (see index.html). The same URL never changes, so
        # versioned assets may be cached immutably for a year; index.html
        # itself stays unversioned and revalidates, and it carries the new
        # versioned URLs whenever assets change. Unversioned /anima-ui files
        # keep the old no-cache policy for development safety.
        if request.url.query:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache, max-age=0"
    elif any(path.endswith(ext) for ext in (".png", ".ico", ".svg", ".woff2")):
        response.headers["Cache-Control"] = "public, max-age=3600"
    elif any(path.endswith(ext) for ext in (".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    return response

app.include_router(api_router, prefix="/api")
app.include_router(training_router, prefix="/api")
app.include_router(monitor_router, prefix="/api")
app.include_router(tageditor_router, prefix="/api")

# Anima UI (SPA frontend) — static assets + catch-all
app.mount("/anima-ui", StaticFiles(directory="frontend", html=True), name="anima-ui")


@app.get("/")
async def index():
    return FileResponse("frontend/index.html")


@app.get("/favicon.ico", response_class=FileResponse)
async def favicon():
    return FileResponse("frontend/assets/favicon.ico")

app.mount("/", SPAStaticFiles(directory="frontend", html=True), name="static")
