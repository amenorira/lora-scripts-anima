"""TensorBoard 反向代理。

httpx 客户端懒创建并全局复用，进程退出时由 application 生命周期关闭。
只代理本机 TensorBoard 一个上游；hop-by-hop 头按 RFC 7230 不转发。
"""
from __future__ import annotations

import os
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from starlette.background import BackgroundTask
from starlette.responses import PlainTextResponse
from starlette.responses import StreamingResponse

router = APIRouter()

_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
})

_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        host = os.environ.get("ANIMA_TENSORBOARD_HOST", "127.0.0.1")
        port = os.environ.get("ANIMA_TENSORBOARD_PORT", "6006")
        _client = httpx.AsyncClient(
            base_url=f"http://{host}:{port}/",
            trust_env=False,
            timeout=httpx.Timeout(300.0, connect=30, read=120, write=30),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
    return _client


async def close_client() -> None:
    """关闭共享客户端（由应用 lifespan 在关停时调用）。"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def _forward(request: Request, preserve_full_path: bool) -> StreamingResponse:
    path = request.url.path if preserve_full_path else request.path_params.get("path", "")
    target = httpx.URL(path=path, query=request.url.query.encode("utf-8"))
    headers = [
        (key, value) for key, value in request.headers.raw
        if key.decode("latin-1").lower() not in _HOP_BY_HOP
    ]

    client = _get_client()
    upstream_request = client.build_request(
        request.method,
        target,
        headers=headers,
        content=request.stream() if request.method != "GET" else None,
    )
    try:
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.ConnectError:
        return PlainTextResponse(
            "TensorBoard 尚未就绪：首次启动需要一点时间，请稍后刷新。\n"
            "TensorBoard is not ready yet; on first launch it may take a while — please refresh shortly.",
            status_code=502,
        )
    return StreamingResponse(
        upstream_response.aiter_raw(),
        status_code=upstream_response.status_code,
        headers=upstream_response.headers,
        background=BackgroundTask(upstream_response.aclose),
    )


async def _forward_subpath(request: Request) -> StreamingResponse:
    return await _forward(request, preserve_full_path=False)


async def _forward_as_is(request: Request) -> StreamingResponse:
    # TensorBoard 前端会从站点根路径直接拉 /font-roboto/...，需原样透传完整路径
    return await _forward(request, preserve_full_path=True)


router.add_route("/proxy/tensorboard/{path:path}", _forward_subpath, ["GET", "POST"])
router.add_route("/font-roboto/{path:path}", _forward_as_is, ["GET", "POST"])
