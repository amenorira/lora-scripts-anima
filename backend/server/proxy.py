"""Same-origin TensorBoard gateway. The upstream owns the path prefix."""
from html import escape

import httpx
from fastapi import APIRouter, Request
from starlette.background import BackgroundTask
from starlette.requests import ClientDisconnect
from starlette.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse

from backend.tensorboard_service import PREFIX, service

router = APIRouter()

_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "trailers", "transfer-encoding", "upgrade",
})

def _headers(headers):
    excluded = _HOP_BY_HOP | {
        token.strip().lower() for token in headers.get("connection", "").split(",")
    }
    return [(key.lower(), value) for key, value in headers.raw
            if key.decode("latin-1").lower() not in excluded]


def _unavailable(request, state, detail=""):
    messages = {
        "starting": "TensorBoard 正在启动，请稍候… / TensorBoard is starting…",
        "disabled": "TensorBoard 未启用 / TensorBoard is disabled",
        "failed": "TensorBoard 不可用 / TensorBoard is unavailable",
    }
    message = messages[state]
    headers = {"Cache-Control": "no-store"}
    if request.url.path == PREFIX + "/":
        refresh = '<meta http-equiv="refresh" content="2">' if state == "starting" else ""
        return HTMLResponse(
            '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' + refresh +
            '<title>TensorBoard</title><style>body{font:16px system-ui;padding:40px;'
            'background:#16181d;color:#e8e8e8}a{color:#8bcaff}p{line-height:1.6}</style>'
            '<h1>TensorBoard</h1><p>' + message + '</p><p>' + escape(detail) +
            '</p><a href="./">重新检查 / Retry</a></html>',
            status_code=503, headers=headers,
        )
    return PlainTextResponse(message + "\n" + detail, status_code=503, headers=headers)


async def _forward(request: Request):
    state = service.status()
    if state != "ready":
        return _unavailable(request, state, service.error)
    target = httpx.URL(path=request.url.path, query=request.url.query.encode("utf-8"))
    headers = [(k, v) for k, v in _headers(request.headers) if k.lower() != b"host"]
    client = service.client
    upstream_request = client.build_request(
        request.method,
        target,
        headers=headers,
        content=request.stream() if request.method not in {"GET", "HEAD"} else None,
    )
    try:
        upstream = await client.send(upstream_request, stream=True)
    except ClientDisconnect:
        # 浏览器刷新、切页或 SSH 转发中断时，请求体可能在转发期间被取消。
        # 这是正常的客户端取消，不应打印成未处理的 ASGI 异常。
        return Response(status_code=499)
    except httpx.RequestError:
        return _unavailable(request, "failed", "连接失败或超时，请重试 / Connection failed or timed out")
    response = StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code,
        background=BackgroundTask(upstream.aclose),
    )
    response.raw_headers = _headers(upstream.headers)
    # TB may produce absolute redirects. Keep browser navigation on the public origin.
    location = upstream.headers.get("location")
    if location:
        url = httpx.URL(location)
        internal = url.host == client.base_url.host and url.port == client.base_url.port
        if internal or (not url.host and location.startswith("/")):
            path = url.raw_path.decode("ascii")
            if url.path != PREFIX and not url.path.startswith(PREFIX + "/"):
                path = PREFIX + path
            response.headers["location"] = path + ("#" + url.fragment if url.fragment else "")
    return response


async def _legacy_redirect(request: Request):
    path = request.path_params.get("path", "")
    query = "?" + request.url.query if request.url.query else ""
    return RedirectResponse(PREFIX + "/" + path + query, status_code=307)


router.add_route(PREFIX + "/{path:path}", _forward, ["GET", "HEAD", "POST"])
router.add_route(PREFIX, _legacy_redirect, ["GET", "HEAD", "POST"])
# Existing bookmarks retain a single redirect, not a second proxy implementation.
router.add_route("/proxy/tensorboard/{path:path}", _legacy_redirect, ["GET", "HEAD", "POST"])
router.add_route("/proxy/tensorboard", _legacy_redirect, ["GET", "HEAD", "POST"])
