import asyncio
import mimetypes
import os
import sys
from contextlib import asynccontextmanager

import fastapi.middleware.cors as fastapi_cors
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware

from backend.server.api import router as api_router
from backend.server.routes.training import router as training_router
from backend.server.proxy import close_client as close_proxy_client
from backend.server.proxy import router as proxy_router
from backend.monitor import router as monitor_router
from backend.tageditor import router as tageditor_router
from backend.utils.devices import check_torch_gpu
from backend.monitor.monitor import task_monitor
from backend.monitor.run_registry import import_legacy_external_runs
from backend.server.routes.realtime import router as realtime_router
from backend.constants import REPO_ROOT
from backend.startup_output import show_environment, show_ready

# Windows 注册表常把 .js 映射成 text/plain，导致浏览器拒执行模块脚本
mimetypes.add_type(ext=".js", type="application/javascript")
mimetypes.add_type(ext=".css", type="text/css")


class SPAStaticFiles(StaticFiles):
    """SPA 静态托管：路径不存在时回退 index.html，交给前端路由处理。"""

    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except HTTPException as ex:
            if ex.status_code == 404:
                index_response = await super().get_response("index.html", scope)
                return index_response
            raise


async def report_runtime_banner() -> None:
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
    await task_monitor.start()
    await report_runtime_banner()
    try:
        yield
    finally:
        await task_monitor.stop()
        await close_proxy_client()


app = FastAPI(lifespan=lifespan)
app.include_router(proxy_router)
app.include_router(realtime_router)

# CORS 只服务本地调试（ANIMA_DEV=1）；常规 localhost 使用不需要
if os.environ.get("ANIMA_DEV") == "1":
    app.add_middleware(
        fastapi_cors.CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# 压缩文本型响应（静态 JS/CSS、字段注册表 JSON 等）；解压后字节不变
app.add_middleware(GZipMiddleware, minimum_size=1024)

_IMMUTABLE_PREVIEW_PATHS = {"/api/image-preview", "/api/monitor/preview-metadata"}


@app.middleware("http")
async def apply_cache_policy(request, call_next):
    """按资源类型分级缓存策略：

    - 生成类预览走自身 ETag（慢速远程链路上不能再被 no-store 冲掉）
    - /api/ 一律 revalidate（no-cache），稳定注册表靠各自 ETag 应答 304
    - /anima-ui 带 ?v= 内容版本号的资源 immutable 缓存一年；index.html 本身
      不版本化、保持 revalidate，由它引用新的版本化 URL
    - 图片/字体/图标短缓存；未版本化的 JS/CSS 不缓存
    """
    response = await call_next(request)
    path = request.url.path
    if path in _IMMUTABLE_PREVIEW_PATHS:
        return response
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache, max-age=0"
    elif path.startswith("/anima-ui/"):
        if request.url.query:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache, max-age=0"
    elif path.endswith((".png", ".ico", ".svg", ".woff2")):
        response.headers["Cache-Control"] = "public, max-age=3600"
    elif path.endswith((".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    return response


app.include_router(api_router, prefix="/api")
app.include_router(training_router, prefix="/api")
app.include_router(monitor_router, prefix="/api")
app.include_router(tageditor_router, prefix="/api")

# Anima UI（SPA 前端）：静态资源 + 回退
app.mount("/anima-ui", StaticFiles(directory="frontend", html=True), name="anima-ui")


@app.get("/")
async def serve_index():
    return FileResponse("frontend/index.html")


async def serve_favicon():
    return FileResponse("frontend/assets/favicon.ico")


app.add_api_route("/favicon.ico", serve_favicon, methods=["GET"], response_class=FileResponse)


app.mount("/", SPAStaticFiles(directory="frontend", html=True), name="static")
