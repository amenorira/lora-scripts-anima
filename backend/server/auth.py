"""Optional HTTP Basic authentication for the UI, API, and WebSocket handshake."""
from base64 import b64decode
from hashlib import sha256
from secrets import compare_digest

from starlette.datastructures import Headers
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class BasicAuthMiddleware:
    def __init__(self, app: ASGIApp, digest: str) -> None:
        self.app = app
        self.digest = bytes.fromhex(digest)

    def _authorized(self, scope: Scope) -> bool:
        scheme, _, token = Headers(scope=scope).get("authorization", "").partition(" ")
        if scheme.lower() != "basic":
            return False
        try:
            credentials = b64decode(token.lstrip(" "), validate=True)
        except ValueError:
            return False
        return compare_digest(sha256(credentials).digest(), self.digest)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            if not self._authorized(scope):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    response = PlainTextResponse("Authentication required", status_code=401, headers={
                        "WWW-Authenticate": 'Basic realm="Anima", charset="UTF-8"',
                        "Cache-Control": "no-store",
                    })
                    await response(scope, receive, send)
                return
            # Consume the GUI credential here so the TensorBoard proxy cannot forward it.
            scope = {**scope, "headers": [(k, v) for k, v in scope["headers"] if k != b"authorization"]}
        await self.app(scope, receive, send)
