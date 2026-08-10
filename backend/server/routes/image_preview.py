"""Unified, capability-scoped image preview endpoint."""
from __future__ import annotations

import asyncio
import mimetypes
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, PlainTextResponse, Response

from backend.image_preview import (
    IMAGE_EXTENSIONS,
    get_cached_preview_path,
    normalize_variant,
    preview_etag,
)

router = APIRouter()


def _resolve_dataset_image(session_id: str, relative_path: str) -> Path | None:
    from backend.tageditor.sessions import dataset_sessions

    if not session_id or not relative_path or Path(relative_path).is_absolute():
        return None
    try:
        session = dataset_sessions.get(session_id)
    except KeyError:
        return None
    normalized = relative_path.replace("\\", "/")
    item = next(
        (entry for entry in session.images if str(entry.get("rel_path", "")).replace("\\", "/") == normalized),
        None,
    )
    if not item:
        return None
    candidate = Path(str(item.get("path", ""))).resolve()
    try:
        candidate.relative_to(session.directory.resolve())
    except ValueError:
        return None
    return candidate


async def serve_preview_file(
    source: Path,
    *,
    variant: str,
    size: int | None = None,
    request: Request | None = None,
):
    try:
        variant = normalize_variant(variant)
        source = source.resolve()
        if not source.is_file() or source.suffix.lower() not in IMAGE_EXTENSIONS:
            raise FileNotFoundError(source)
        etag = preview_etag(source, variant, size)
    except (FileNotFoundError, OSError, ValueError):
        return PlainTextResponse("", status_code=404)

    headers = {
        "Cache-Control": "private, max-age=86400, immutable",
        "ETag": f'"{etag}"',
    }
    if request and request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    if variant == "original":
        media_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        return FileResponse(source, media_type=media_type, headers=headers)
    try:
        rendered = await asyncio.to_thread(get_cached_preview_path, source, variant, size)
    except Exception:
        return PlainTextResponse("", status_code=500)
    return FileResponse(rendered, media_type="image/webp", headers=headers)


@router.get("/image-preview")
async def image_preview(
    request: Request,
    scope: str = Query(...),
    variant: str = Query("preview"),
    path: str = Query(""),
    run_dir: str = Query(""),
    session_id: str = Query(""),
    source_token: str = Query(""),
    index: int = Query(-1),
    size: int | None = Query(None, ge=64, le=4096),
):
    """Serve thumb/preview/inspect/original variants from a scoped image capability."""
    source: Path | None = None
    if scope == "artifact":
        from backend.monitor.run_registry import resolve_artifact_file

        source = await asyncio.to_thread(resolve_artifact_file, run_dir, path)
    elif scope == "dataset":
        source = await asyncio.to_thread(_resolve_dataset_image, session_id, path)
    elif scope == "tagger":
        from backend.tagger.workspace import source_item

        try:
            source = await asyncio.to_thread(source_item, source_token, index)
        except (KeyError, IndexError, ValueError):
            source = None
    if source is None:
        return PlainTextResponse("", status_code=404)
    return await serve_preview_file(source, variant=variant, size=size, request=request)
