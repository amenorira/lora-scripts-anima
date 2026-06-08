import asyncio
import os

import httpx
import starlette
import websockets
from fastapi import APIRouter, Request, WebSocket
from httpx import ConnectError
from starlette.background import BackgroundTask
from starlette.responses import PlainTextResponse, StreamingResponse

from backend.log import log

router = APIRouter()


def reverse_proxy_maker(url_type: str, full_path: bool = False):
    if url_type == "tensorboard":
        host = os.environ.get("ANIMA_TENSORBOARD_HOST", "127.0.0.1")
        port = os.environ.get("ANIMA_TENSORBOARD_PORT", "6006")
    else:
        raise ValueError(f"Unknown url_type: {url_type}")

    client = httpx.AsyncClient(base_url=f"http://{host}:{port}/", proxies={}, trust_env=False, timeout=360, limits=httpx.Limits(max_connections=10, max_keepalive_connections=5))

    async def _reverse_proxy(request: Request):
        if full_path:
            url = httpx.URL(path=request.url.path, query=request.url.query.encode("utf-8"))
        else:
            url = httpx.URL(
                path=request.path_params.get("path", ""),
                query=request.url.query.encode("utf-8")
            )
        rp_req = client.build_request(
            request.method, url,
            headers=request.headers.raw,
            content=request.stream() if request.method != "GET" else None
        )
        try:
            rp_resp = await client.send(rp_req, stream=True)
        except ConnectError:
            return PlainTextResponse(
                content="The requested service not started yet or service started fail. This may cost a while when you first time startup\n请求的服务尚未启动或启动失败。若是第一次启动，可能需要等待一段时间后再刷新网页。",
                status_code=502
            )
        return StreamingResponse(
            rp_resp.aiter_raw(),
            status_code=rp_resp.status_code,
            headers=rp_resp.headers,
            background=BackgroundTask(rp_resp.aclose),
        )

    return _reverse_proxy


async def proxy_ws_forward(ws_a: WebSocket, ws_b: websockets.WebSocketClientProtocol):
    while True:
        try:
            msg = await ws_a.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if "text" in msg and msg["text"] is not None:
                await ws_b.send(msg["text"])
            elif "bytes" in msg and msg["bytes"] is not None:
                await ws_b.send(msg["bytes"])
        except starlette.websockets.WebSocketDisconnect:
            break
        except Exception as e:
            log.error(f"Error when proxy data client -> backend: {e}")
            break


async def proxy_ws_reverse(ws_a: WebSocket, ws_b: websockets.WebSocketClientProtocol):
    while True:
        try:
            data = await ws_b.recv()
            await ws_a.send_text(data)
        except websockets.exceptions.ConnectionClosed:
            break
        except Exception as e:
            log.error(f"Error when proxy data backend -> client: {e}")
            break

router.add_route("/proxy/tensorboard/{path:path}", reverse_proxy_maker("tensorboard"), ["GET", "POST"])
router.add_route("/font-roboto/{path:path}", reverse_proxy_maker("tensorboard", full_path=True), ["GET", "POST"])
