"""Optional HTTP Basic authentication for the UI, API, and WebSocket handshake."""
from base64 import b64decode
from hashlib import sha256
import hmac
import secrets
import time
from urllib.parse import parse_qs, urlencode

from starlette.datastructures import Headers
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from backend.constants import get_root_path

WS_TOKEN_TTL = 300
_WS_TOKEN_NONCE = secrets.token_bytes(32)


def get_route_path(scope: Scope) -> str:
    """Return the app-relative path after stripping ASGI root_path (or configured ANIMA_ROOT_PATH)."""
    path = scope.get("path", "") or ""
    root_path = (scope.get("root_path") or "").rstrip("/")
    if not root_path:
        root_path = get_root_path()
    if root_path and path.startswith(root_path):
        rest = path[len(root_path):]
        if not rest or rest.startswith("/"):
            return rest or "/"
    return path


def _ws_token_key(auth_digest: str) -> bytes:
    return hmac.new(_WS_TOKEN_NONCE, bytes.fromhex(auth_digest), sha256).digest()


def issue_ws_token(auth_digest: str, ttl: int = WS_TOKEN_TTL) -> str:
    """Issue a short-lived HMAC-SHA256 signed token for WebSocket upgrades."""
    exp = int(time.time()) + int(ttl)
    nonce = secrets.token_hex(12)
    payload = f"{exp}.{nonce}"
    sig = hmac.new(_ws_token_key(auth_digest), payload.encode("ascii"), sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_ws_token(token: str, auth_digest: str) -> bool:
    """Verify a short-lived WebSocket token issued in the current process."""
    if not token or not auth_digest or not isinstance(token, str):
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    exp_str, nonce, sig = parts
    if not nonce or not sig:
        return False
    try:
        exp = int(exp_str)
        key = _ws_token_key(auth_digest)
    except ValueError:
        return False
    if time.time() >= exp:
        return False
    expected = hmac.new(key, f"{exp_str}.{nonce}".encode("ascii"), sha256).hexdigest()
    return secrets.compare_digest(sig, expected)


class BasicAuthMiddleware:
    def __init__(self, app: ASGIApp, digest: str) -> None:
        self.app = app
        self.digest_hex = digest
        self.digest = bytes.fromhex(digest)

    def _is_public_healthz(self, scope: Scope) -> bool:
        return (
            scope["type"] == "http"
            and scope.get("method", "GET").upper() in {"GET", "HEAD"}
            and get_route_path(scope) == "/healthz"
        )

    def _authorized_basic(self, scope: Scope) -> bool:
        scheme, _, token = Headers(scope=scope).get("authorization", "").partition(" ")
        if scheme.lower() != "basic":
            return False
        try:
            credentials = b64decode(token.lstrip(" "), validate=True)
        except ValueError:
            return False
        return secrets.compare_digest(sha256(credentials).digest(), self.digest)

    def _authorized_ws_token(self, scope: Scope) -> bool:
        if scope["type"] != "websocket" or get_route_path(scope) != "/ws/realtime":
            return False
        raw_query = scope.get("query_string", b"")
        if not raw_query:
            return False
        params = parse_qs(raw_query.decode("latin-1"), keep_blank_values=False)
        tokens = params.get("token")
        if not tokens:
            return False
        return verify_ws_token(tokens[0], self.digest_hex)

    def _authorized(self, scope: Scope) -> bool:
        return self._authorized_basic(scope) or self._authorized_ws_token(scope)

    def _strip_ws_token_query(self, scope: Scope) -> Scope:
        raw_query = scope.get("query_string", b"")
        if not raw_query or b"token=" not in raw_query:
            return scope
        params = parse_qs(raw_query.decode("latin-1"), keep_blank_values=True)
        if "token" not in params:
            return scope
        params.pop("token", None)
        cleaned = urlencode(params, doseq=True).encode("latin-1")
        return {**scope, "query_string": cleaned}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            if self._is_public_healthz(scope):
                await self.app(scope, receive, send)
                return
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
            if scope["type"] == "websocket":
                scope = self._strip_ws_token_query(scope)
        await self.app(scope, receive, send)
