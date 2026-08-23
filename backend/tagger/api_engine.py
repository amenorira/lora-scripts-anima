"""Vision API engine for the Tagger workspace.

Supports three request protocols: OpenAI Chat Completions, OpenAI Responses,
and Anthropic Messages. Sends one request per image (base64 JPEG) so tags
stay attributable, with retry/backoff for transient failures. The API key is
kept in memory only and never written to disk or logs.
"""
from __future__ import annotations

import base64
import io
import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
from PIL import Image

DEFAULT_TIMEOUT = 120.0
MAX_RETRIES = 3
MIN_CONCURRENCY = 1
MAX_CONCURRENCY = 8
MIN_MAX_EDGE = 256
MAX_MAX_EDGE = 4096
DEFAULT_MAX_TOKENS = 1024
DEFAULT_TEMPERATURE = 0.2
PROTOCOL_CHAT = "chat-completions"
PROTOCOL_RESPONSES = "responses"
PROTOCOL_ANTHROPIC = "anthropic"
PROTOCOLS = (PROTOCOL_CHAT, PROTOCOL_RESPONSES, PROTOCOL_ANTHROPIC)
ANTHROPIC_VERSION = "2023-06-01"

_TAG_SPLIT_PATTERN = re.compile(r"[,，、;；\n]")
_TAG_BULLET_PATTERN = re.compile(r"^(?:[-*•]+|\d+[.)、])\s*")


class ApiAuthError(RuntimeError):
    """Authentication/authorization failure (401/403). Abort the whole task."""


class ApiBadRequestError(RuntimeError):
    """Non-retryable 4xx, e.g. the model does not accept images."""


class ApiTransientError(RuntimeError):
    """Retryable failure: 429, 5xx, network, or an unusable response body."""


@dataclass(frozen=True)
class ApiConfig:
    base_url: str
    api_key: str
    model: str
    prompt: str
    parse_mode: str = "tags"  # "tags" | "caption"
    protocol: str = PROTOCOL_CHAT  # PROTOCOL_CHAT | PROTOCOL_RESPONSES | PROTOCOL_ANTHROPIC
    max_edge: int = 1280
    concurrency: int = 4
    max_tokens: int = DEFAULT_MAX_TOKENS
    temperature: float = DEFAULT_TEMPERATURE
    timeout: float = DEFAULT_TIMEOUT


def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def validate_config(payload: dict[str, Any]) -> ApiConfig:
    base_url = str(payload.get("base_url") or "").strip().rstrip("/")
    if not base_url.lower().startswith(("http://", "https://")):
        raise ValueError("API base URL must start with http(s):// / API 地址必须以 http(s):// 开头")
    api_key = str(payload.get("api_key") or "").strip()
    if not api_key:
        raise ValueError("API key is required / 请填写 API 密钥")
    model = str(payload.get("model") or "").strip()
    if not model:
        raise ValueError("Model name is required / 请填写模型名称")
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("Prompt is required / 请填写提示词")
    parse_mode = str(payload.get("parse_mode") or "tags").strip()
    if parse_mode not in {"tags", "caption"}:
        raise ValueError("Invalid parse mode / 无效的输出解析方式")
    protocol = str(payload.get("protocol") or PROTOCOL_CHAT).strip()
    if protocol not in PROTOCOLS:
        raise ValueError("Invalid API protocol / 无效的接口协议")
    return ApiConfig(
        base_url=base_url,
        api_key=api_key,
        model=model,
        prompt=prompt,
        parse_mode=parse_mode,
        protocol=protocol,
        max_edge=_clamp_int(payload.get("max_edge"), 1280, MIN_MAX_EDGE, MAX_MAX_EDGE),
        concurrency=_clamp_int(payload.get("concurrency"), 4, MIN_CONCURRENCY, MAX_CONCURRENCY),
        max_tokens=_clamp_int(payload.get("max_tokens"), DEFAULT_MAX_TOKENS, 64, 8192),
        timeout=float(payload.get("timeout") or DEFAULT_TIMEOUT),
    )


_PROTOCOL_PATHS = {
    PROTOCOL_CHAT: "/chat/completions",
    PROTOCOL_RESPONSES: "/responses",
    PROTOCOL_ANTHROPIC: "/messages",
}


def request_url(base_url: str, protocol: str) -> str:
    url = base_url.rstrip("/")
    path = _PROTOCOL_PATHS.get(protocol, _PROTOCOL_PATHS[PROTOCOL_CHAT])
    if not url.endswith(path):
        url += path
    return url


def _auth_headers(api_key: str, protocol: str) -> dict[str, str]:
    if protocol == PROTOCOL_ANTHROPIC:
        return {"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION}
    return {"Authorization": f"Bearer {api_key}"}


def _build_payload(config: ApiConfig, data_url: str) -> dict[str, Any]:
    if config.protocol == PROTOCOL_ANTHROPIC:
        # data_url is "data:image/jpeg;base64,<...>"; Anthropic wants raw base64.
        image_data = data_url.split(",", 1)[1] if "," in data_url else data_url
        return {
            "model": config.model,
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/jpeg", "data": image_data},
                        },
                        {"type": "text", "text": config.prompt},
                    ],
                }
            ],
        }
    if config.protocol == PROTOCOL_RESPONSES:
        return {
            "model": config.model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": config.prompt},
                        {"type": "input_image", "image_url": data_url},
                    ],
                }
            ],
            "max_output_tokens": config.max_tokens,
            "temperature": config.temperature,
        }
    return {
        "model": config.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": config.prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "max_tokens": config.max_tokens,
        "temperature": config.temperature,
        "stream": False,
    }


def models_url(base_url: str) -> str:
    url = base_url.rstrip("/")
    if not url.endswith("/models"):
        url += "/models"
    return url


def create_client(config: ApiConfig) -> httpx.Client:
    return httpx.Client(timeout=config.timeout, follow_redirects=True)


def _flatten_alpha(image: Image.Image) -> Image.Image:
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    if not has_alpha:
        return image.convert("RGB")
    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.getchannel("A"))
    rgba.close()
    return background


def encode_image(image: Image.Image, max_edge: int) -> str:
    """Resize to max_edge on the longest side and return a JPEG data URL."""
    work = _flatten_alpha(image)
    width, height = work.size
    longest = max(width, height)
    if longest > max_edge:
        scale = max_edge / longest
        work = work.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS)
    buffer = io.BytesIO()
    work.save(buffer, format="JPEG", quality=90)
    if work is not image:
        work.close()
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def parse_response_text(text: str, parse_mode: str) -> list[str]:
    cleaned = str(text or "").strip()
    if not cleaned:
        return []
    if parse_mode == "caption":
        return [re.sub(r"\s+", " ", cleaned)]
    tags: list[str] = []
    seen: set[str] = set()
    for part in _TAG_SPLIT_PATTERN.split(cleaned):
        tag = _TAG_BULLET_PATTERN.sub("", part.strip().strip('"').strip())
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(tag)
    return tags


def _extract_content(body: dict[str, Any], protocol: str = PROTOCOL_CHAT) -> str:
    if protocol == PROTOCOL_ANTHROPIC:
        parts = [
            str(block.get("text") or "")
            for block in body.get("content") or []
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        if parts:
            return "".join(parts).strip()
        raise ApiTransientError("Response has no text content / 响应中没有文本内容")
    if protocol == PROTOCOL_RESPONSES:
        output_text = body.get("output_text")
        if output_text:
            return str(output_text).strip()
        parts = []
        for item in body.get("output") or []:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            for block in item.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "output_text":
                    parts.append(str(block.get("text") or ""))
        if parts:
            return "".join(parts).strip()
        raise ApiTransientError("Response has no output text / 响应中没有输出文本")
    choices = body.get("choices") or []
    if not choices:
        raise ApiTransientError("Response has no choices / 响应中没有 choices")
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, list):
        content = "".join(
            str(block.get("text") or "") for block in content if isinstance(block, dict)
        )
    return str(content or "").strip()


def interrogate(
    config: ApiConfig,
    image: Image.Image,
    client: httpx.Client | None = None,
    cancel_event: threading.Event | None = None,
) -> tuple[list[str], str]:
    """Tag one image. Returns (parsed tags, raw response text)."""
    data_url = encode_image(image, config.max_edge)
    payload = _build_payload(config, data_url)
    headers = _auth_headers(config.api_key, config.protocol)
    own_client = client is None
    http_client = client or create_client(config)
    last_error: Exception = ApiTransientError("Request failed / 请求失败")
    try:
        for attempt in range(MAX_RETRIES + 1):
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("cancelled")
            try:
                response = http_client.post(request_url(config.base_url, config.protocol), json=payload, headers=headers)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_error = ApiTransientError(f"Network error: {type(exc).__name__}")
            else:
                status = response.status_code
                if status in (401, 403):
                    raise ApiAuthError(f"HTTP {status}: {response.text[:200]}")
                if status == 429 or status >= 500:
                    wait: float | None = None
                    retry_after = response.headers.get("Retry-After", "")
                    try:
                        wait = min(float(retry_after), 60.0)
                    except ValueError:
                        pass
                    last_error = ApiTransientError(f"HTTP {status}: {response.text[:200]}")
                    if attempt < MAX_RETRIES:
                        time.sleep(wait if wait is not None else min(2.0 * (2 ** attempt), 30.0))
                    continue
                if status >= 400:
                    raise ApiBadRequestError(f"HTTP {status}: {response.text[:300]}")
                try:
                    raw = _extract_content(response.json(), config.protocol)
                except ApiTransientError:
                    raise
                except Exception as exc:
                    raise ApiTransientError(f"Malformed response: {type(exc).__name__}") from exc
                if not raw:
                    last_error = ApiTransientError("Empty response from model / 模型返回为空")
                else:
                    return parse_response_text(raw, config.parse_mode), raw
            if attempt < MAX_RETRIES:
                time.sleep(min(2.0 * (2 ** attempt), 30.0))
        raise last_error
    finally:
        if own_client:
            http_client.close()


def list_models(
    base_url: str,
    api_key: str,
    protocol: str = PROTOCOL_CHAT,
    timeout: float = 30.0,
) -> list[str]:
    """Probe GET {base_url}/models to verify connectivity and auth.

    Anthropic's /v1/models answers with the same {"data": [{"id": ...}]}
    shape, so one parser covers all protocols.
    """
    base = base_url.strip().rstrip("/")
    if not base.lower().startswith(("http://", "https://")):
        raise ValueError("API base URL must start with http(s):// / API 地址必须以 http(s):// 开头")
    key = api_key.strip()
    if not key:
        raise ValueError("API key is required / 请填写 API 密钥")
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        try:
            response = client.get(models_url(base), headers=_auth_headers(key, protocol))
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise ApiTransientError(f"Network error: {type(exc).__name__}") from exc
    if response.status_code in (401, 403):
        raise ApiAuthError(f"HTTP {response.status_code}: {response.text[:200]}")
    if response.status_code >= 400:
        raise ApiBadRequestError(f"HTTP {response.status_code}: {response.text[:300]}")
    try:
        data = response.json().get("data") or []
    except Exception as exc:
        raise ApiTransientError(f"Malformed response: {type(exc).__name__}") from exc
    return sorted(str(item["id"]) for item in data if isinstance(item, dict) and item.get("id"))
