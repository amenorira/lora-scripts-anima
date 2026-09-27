import asyncio
import mimetypes
import os
import sys
from contextlib import asynccontextmanager

import fastapi.middleware.cors as fastapi_cors
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders, URL
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backend.server.api import router as api_router
from backend.server.routes.training import router as training_router
from backend.tensorboard_service import PREFIX, service as tensorboard
from backend.server.proxy import router as proxy_router
from backend.monitor import router as monitor_router
from backend.tageditor import router as tageditor_router
from backend.utils.devices import check_torch_gpu
from backend.monitor.monitor import task_monitor
from backend.monitor.artifacts import scan_history
from backend.server.routes.realtime import router as realtime_router
from backend.training.step_estimator import warm_up as warm_step_estimator
from backend.constants import REPO_ROOT
from backend.startup_output import show_environment, show_ready, show_step

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
    runtime = await asyncio.to_thread(check_torch_gpu) or {}

    host = os.environ.get("ANIMA_HOST", "127.0.0.1")
    port = os.environ.get("ANIMA_PORT", "12333")
    browser_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{browser_host}:{port}/"

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
        gpu_text = f"{first_gpu['name']} {first_gpu['memory_gb']} GB"
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

    if tensorboard.status() == "starting":
        show_step("Starting TensorBoard / 正在启动 TensorBoard")
        await tensorboard.wait_started()
    state = tensorboard.status()
    tensorboard_url = url.rstrip("/") + PREFIX + "/" if state != "disabled" else None
    show_ready(
        url,
        tensorboard_url=tensorboard_url,
        tensorboard_state=state,
        log_path=REPO_ROOT / "logs" / "anima.log",
    )


async def warm_startup_caches() -> None:
    """Optional disk scans and training imports run after the ready banner."""
    from backend.log import log
    results = await asyncio.gather(
        asyncio.to_thread(scan_history),  # Includes idempotent legacy migration.
        asyncio.to_thread(warm_step_estimator),
        return_exceptions=True,
    )
    for name, result in zip(("history", "step estimator"), results):
        if isinstance(result, Exception):
            log.warning("Startup cache warm-up failed / 启动缓存预热失败 (%s): %s", name, result)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cache_task = None
    tensorboard.start(
        enabled=os.environ.get("ANIMA_DISABLE_TENSORBOARD") != "1",
        port=int(os.environ.get("ANIMA_TENSORBOARD_PORT", "0")),
    )
    try:
        await task_monitor.start()
        await report_runtime_banner()
        cache_task = asyncio.create_task(warm_startup_caches())
        yield
    finally:
        try:
            from backend.training.shape_preview import close_preview_pool
            close_preview_pool()
            await task_monitor.stop()
        finally:
            try:
                await tensorboard.stop()
            finally:
                if cache_task is not None:
                    # Do not leave disk writes running after the app has shut down.
                    await cache_task


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

# 下载安装的词典资源：与 /anima-ui 同一套规则，内容文件带查询串换 immutable
_DICTIONARY_ASSET_PREFIX = "/api/tageditor/dictionary/asset/"


def apply_cache_policy(url: URL, headers: MutableHeaders) -> None:
    """按资源类型分级缓存策略：

    - 生成类预览走自身 ETag（慢速远程链路上不能再被 no-store 冲掉）
    - 词典内容文件与 /anima-ui 版本化资源同规则；manifest 保持 revalidate
    - /api/ 一律 revalidate（no-cache），稳定注册表靠各自 ETag 应答 304
    - /anima-ui 带 ?v= 内容版本号的资源 immutable 缓存一年；index.html 本身
      不版本化、保持 revalidate，由它引用新的版本化 URL
    - 图片/字体/图标短缓存；未版本化的 JS/CSS 不缓存
    """
    path = url.path
    if path in _IMMUTABLE_PREVIEW_PATHS:
        return
    if path.startswith(_DICTIONARY_ASSET_PREFIX):
        if url.query and not path.endswith("/manifest.json"):
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            headers["Cache-Control"] = "no-cache, max-age=0"
    elif path.startswith("/api/"):
        headers["Cache-Control"] = "no-cache, max-age=0"
    elif path.startswith("/anima-ui/"):
        if url.query:
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            headers["Cache-Control"] = "no-cache, max-age=0"
    elif path.endswith((".png", ".ico", ".svg", ".woff2")):
        headers["Cache-Control"] = "public, max-age=3600"
    elif path.endswith((".js", ".css")):
        headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"


class CachePolicyMiddleware:
    """直接修改响应头，避免 BaseHTTPMiddleware 将正常断连报为无响应异常。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        url = URL(scope=scope)

        async def send_with_cache_policy(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                apply_cache_policy(url, headers)
                if url.path.startswith(_DICTIONARY_ASSET_PREFIX) and message["status"] >= 400:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_with_cache_policy)


app.add_middleware(CachePolicyMiddleware)


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
    return FileResponse("frontend/assets/favicon.png")


app.add_api_route("/favicon.png", serve_favicon, methods=["GET"], response_class=FileResponse)


app.mount("/", SPAStaticFiles(directory="frontend", html=True), name="static")
