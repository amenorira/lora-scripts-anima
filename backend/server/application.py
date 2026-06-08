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

from backend.server.config import app_config
from backend.server.state import load_presets
from backend.server.api import router as api_router
from backend.server.routes.training import router as training_router
from backend.server.routes.presets import router as presets_router
from backend.server.proxy import router as proxy_router
from backend.monitor import router as monitor_router
from backend.tageditor import router as tageditor_router
from backend.utils.devices import check_torch_gpu

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
    app_config.load_config()

    await load_presets()
    await asyncio.to_thread(check_torch_gpu)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await app_startup()
    yield


app = FastAPI(lifespan=lifespan)
app.include_router(proxy_router)


# CORS only needed for dev debugging; not required for localhost use
if os.environ.get("ANIMA_DEV") == "1":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.middleware("http")
async def add_cache_control_header(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    elif path.startswith("/anima-ui/"):
        response.headers["Cache-Control"] = "no-cache, max-age=0"
    elif any(path.endswith(ext) for ext in (".png", ".ico", ".svg", ".woff2")):
        response.headers["Cache-Control"] = "public, max-age=3600"
    elif any(path.endswith(ext) for ext in (".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    return response

app.include_router(api_router, prefix="/api")
app.include_router(training_router, prefix="/api")
app.include_router(presets_router, prefix="/api")
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
