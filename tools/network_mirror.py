"""Automatic network endpoint detection and mirror fallback.

Uses Python standard library only so it can run during early bootstrap before
third-party packages (such as requests) are installed.
"""
from __future__ import annotations

from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
import os
import threading
import time
import urllib.request
from urllib.parse import quote

HF_OFFICIAL = "https://huggingface.co"
HF_MIRROR = "https://hf-mirror.com"
HF_PROBE_PATH = "/gpt2/resolve/main/config.json"

CACHE_TTL = 900.0
_PROBE_USER_AGENT = "lora-scripts-anima/network-probe"

_hf_lock = threading.Lock()
_hf_cache: tuple[float, list[str]] | None = None
_hf_generation = 0
_auto_applied_hf_endpoint: str | None = None


def _probe_url(
    url: str,
    *,
    timeout: float = 2.0,
    byte_range: bool = True,
    expect_prefix: bytes | None = None,
    reject_html: bool = False,
) -> tuple[bool, float]:
    """Probe reachability of *url*, returning (ok, elapsed_seconds)."""
    headers = {
        "User-Agent": _PROBE_USER_AGENT,
        "Accept-Encoding": "identity",
    }
    if byte_range:
        headers["Range"] = "bytes=0-0"
    request = urllib.request.Request(url, headers=headers, method="GET")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = getattr(response, "status", None)
            if status is None:
                status = response.getcode()
            if status not in (200, 206):
                return (False, time.monotonic() - started)
            if reject_html:
                content_type = (response.headers.get("Content-Type") or "").lower()
                if "text/html" in content_type:
                    return (False, time.monotonic() - started)
            if expect_prefix:
                chunk = response.read(len(expect_prefix))
                if chunk != expect_prefix:
                    return (False, time.monotonic() - started)
            return (True, time.monotonic() - started)
    except Exception:
        return (False, time.monotonic() - started)


def _probe_many(
    urls: Sequence[str],
    *,
    timeout: float,
    byte_range: bool = True,
    expect_prefix: bytes | None = None,
    reject_html: bool = False,
) -> dict[str, tuple[bool, float]]:
    results: dict[str, tuple[bool, float]] = {}
    with ThreadPoolExecutor(max_workers=len(urls)) as pool:
        futures = {
            url: pool.submit(
                _probe_url,
                url,
                timeout=timeout,
                byte_range=byte_range,
                expect_prefix=expect_prefix,
                reject_html=reject_html,
            )
            for url in urls
        }
        for url, fut in futures.items():
            try:
                results[url] = fut.result()
            except Exception:
                results[url] = (False, timeout)
    return results


def _dedupe_urls(urls: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for url in urls:
        clean = (url or "").strip()
        key = clean.rstrip("/")
        if clean and key not in seen:
            seen.add(key)
            result.append(clean)
    return result


def _probe_hf_endpoints(timeout: float = 2.0) -> list[str]:
    off_url = HF_OFFICIAL + HF_PROBE_PATH
    mir_url = HF_MIRROR + HF_PROBE_PATH
    results = _probe_many(
        (off_url, mir_url),
        timeout=timeout,
        expect_prefix=b"{",
        reject_html=True,
    )
    off_ok, off_t = results.get(off_url, (False, timeout))
    mir_ok, mir_t = results.get(mir_url, (False, timeout))

    if off_ok and (off_t <= 1.5 or not mir_ok or off_t <= mir_t * 3.0 + 0.5):
        return [HF_OFFICIAL, HF_MIRROR]
    if mir_ok:
        return [HF_MIRROR, HF_OFFICIAL]
    return [HF_OFFICIAL, HF_MIRROR]


def _explicit_hf_endpoint() -> str | None:
    env_ep = (os.environ.get("HF_ENDPOINT") or "").strip().rstrip("/")
    if env_ep and env_ep != (_auto_applied_hf_endpoint or "").rstrip("/"):
        return env_ep
    return None


def resolve_hf_endpoints(*, force_refresh: bool = False) -> list[str]:
    """Return ordered HF endpoints, respecting explicit HF_ENDPOINT overrides."""
    global _hf_cache, _auto_applied_hf_endpoint

    with _hf_lock:
        if user_ep := _explicit_hf_endpoint():
            return _dedupe_urls([user_ep, HF_MIRROR, HF_OFFICIAL])

        now = time.monotonic()
        if not force_refresh and _hf_cache is not None:
            cached_at, cached_list = _hf_cache
            if now - cached_at < CACHE_TTL:
                return list(cached_list)
        generation = _hf_generation

    probed = _probe_hf_endpoints()

    with _hf_lock:
        if user_ep := _explicit_hf_endpoint():
            return _dedupe_urls([user_ep, HF_MIRROR, HF_OFFICIAL])

        if _hf_generation == generation:
            _hf_cache = (time.monotonic(), probed)
        os.environ["HF_ENDPOINT"] = probed[0]
        _auto_applied_hf_endpoint = probed[0]
        return list(probed)


def invalidate_hf_cache() -> None:
    """Clear cached HF endpoint probe result so the next call re-probes."""
    global _hf_cache, _hf_generation
    with _hf_lock:
        _hf_cache = None
        _hf_generation += 1


def warm_up_hf_endpoint() -> str:
    """Non-throwing startup helper that probes and caches the best HF endpoint."""
    try:
        endpoints = resolve_hf_endpoints()
        return endpoints[0] if endpoints else HF_OFFICIAL
    except Exception:
        return os.environ.get("HF_ENDPOINT") or HF_OFFICIAL


def hf_resolve_urls(
    repo_id: str,
    hf_path: str,
    *,
    revision: str = "main",
    repo_type: str = "model",
) -> list[str]:
    """Return ordered HF resolve URLs for a repository file."""
    prefix = {"dataset": f"datasets/{repo_id}", "space": f"spaces/{repo_id}"}.get(repo_type, repo_id)
    clean_path = quote(hf_path.lstrip("/"), safe="/")
    clean_rev = quote(revision, safe="")
    return [
        f"{ep.rstrip('/')}/{prefix}/resolve/{clean_rev}/{clean_path}"
        for ep in resolve_hf_endpoints()
    ]
