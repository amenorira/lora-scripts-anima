"""Serve the real UI and its browser layout regression at /__caption_layout_test/.

Run with venv Python and -B. The test page reports PASS/FAIL for desktop sizes.
Training/monitor startup is disabled; no model requests or caption writes occur.
"""
from contextlib import asynccontextmanager
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.runtime_paths import configure_test_paths

configure_test_paths()
from backend.server.application import app
from fastapi import FastAPI
from fastapi.responses import FileResponse
import uvicorn


@asynccontextmanager
async def lifespan(application):
    yield


test_app = FastAPI(lifespan=lifespan)


@test_app.get('/__caption_layout_test/')
async def layout_test():
    return FileResponse(ROOT / 'tests/frontend/caption-layout.test.html')


test_app.mount('/', app)


if __name__ == '__main__':
    uvicorn.run(test_app, host='127.0.0.1', port=12336, log_level='warning')
