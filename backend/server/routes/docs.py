"""Read-only Markdown documentation endpoints for the local trainer UI."""

from __future__ import annotations

import posixpath
import re
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from markdown import Markdown
from markdown.extensions import Extension
from markdown.preprocessors import Preprocessor
from markdown.treeprocessors import Treeprocessor

from backend.constants import DOCS_DIR
from backend.server.models import APIResponseSuccess


router = APIRouter()

_DEFAULT_LOCALE = "zh-CN"
_SUPPORTED_LOCALES = {"zh-CN", "en-US"}
_DOC_ANCHOR_RE = re.compile(
    r"^\s*<!--\s*doc-anchor:\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*-->\s*$"
)
_ATX_HEADING_RE = re.compile(r"^#{1,6}[ \t]+\S")
_DOCUMENTS = {
    "lora-plus": {
        "category": "network",
        "titles": {"zh-CN": "LoRA+", "en-US": "LoRA+"},
        "summaries": {
            "zh-CN": "LoRA+ 的训练原理、适用场景、参数含义与优化器注意事项。",
            "en-US": "Training behavior, use cases, parameters, and optimizer notes for LoRA+.",
        },
        "files": {
            "zh-CN": "parameters/lora-plus.zh-CN.md",
            "en-US": "parameters/lora-plus.en-US.md",
        },
    },
}


class _DocAnchorPreprocessor(Preprocessor):
    """Turn invisible doc anchor comments into Markdown heading attributes."""

    def run(self, lines: list[str]) -> list[str]:
        output: list[str] = []
        pending_anchor: str | None = None

        for line in lines:
            marker = _DOC_ANCHOR_RE.match(line)
            if marker:
                if pending_anchor is not None:
                    output.append(f"<!-- doc-anchor: {pending_anchor} -->")
                pending_anchor = marker.group(1)
                continue

            if pending_anchor is not None:
                if _ATX_HEADING_RE.match(line):
                    line = f"{line.rstrip()} {{#{pending_anchor}}}"
                else:
                    output.append(f"<!-- doc-anchor: {pending_anchor} -->")
                pending_anchor = None

            output.append(line)

        if pending_anchor is not None:
            output.append(f"<!-- doc-anchor: {pending_anchor} -->")
        return output


class _DocAnchorExtension(Extension):
    def extendMarkdown(self, markdown: Markdown) -> None:
        markdown.preprocessors.register(
            _DocAnchorPreprocessor(markdown),
            "local_doc_anchors",
            35,
        )


def _normalize_locale(locale: str | None) -> str:
    return locale if locale in _SUPPORTED_LOCALES else _DEFAULT_LOCALE


def _document_path(slug: str, locale: str) -> Path:
    document = _DOCUMENTS.get(slug)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    relative_path = document["files"].get(locale) or document["files"][_DEFAULT_LOCALE]
    path = (DOCS_DIR / relative_path).resolve()
    docs_root = DOCS_DIR.resolve()
    if path != docs_root and docs_root not in path.parents:
        raise HTTPException(status_code=404, detail="Document not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Document file not found")
    return path


def _asset_url(url: str, document_dir: PurePosixPath) -> str:
    parts = urlsplit(url)
    if parts.scheme or parts.netloc or parts.path.startswith(("/", "#")):
        return url
    normalized = posixpath.normpath(
        posixpath.join(document_dir.as_posix(), unquote(parts.path))
    )
    encoded_path = quote(normalized, safe="/")
    return urlunsplit(("", "", f"/api/docs/assets/{encoded_path}", parts.query, parts.fragment))


class _AssetTreeprocessor(Treeprocessor):
    def __init__(self, markdown: Markdown, document_dir: PurePosixPath):
        super().__init__(markdown)
        self.document_dir = document_dir

    def run(self, root):
        for element in root.iter("img"):
            source = element.get("src")
            if source:
                element.set("src", _asset_url(source, self.document_dir))
        return root


class _AssetExtension(Extension):
    def __init__(self, document_dir: PurePosixPath):
        super().__init__()
        self.document_dir = document_dir

    def extendMarkdown(self, markdown: Markdown) -> None:
        markdown.treeprocessors.register(
            _AssetTreeprocessor(markdown, self.document_dir),
            "local_doc_assets",
            5,
        )


def _render_markdown(source: str, relative_path: PurePosixPath) -> tuple[str, str]:
    renderer = Markdown(
        extensions=[
            "extra",
            "toc",
            _DocAnchorExtension(),
            _AssetExtension(relative_path.parent),
        ],
        extension_configs={"toc": {"permalink": False}},
        output_format="html5",
    )
    html = renderer.convert(source)
    return html, renderer.toc


def _resolve_asset_path(asset_path: str) -> Path:
    decoded = unquote(asset_path).replace("\\", "/")
    relative = PurePosixPath(decoded)
    if relative.is_absolute() or ".." in relative.parts:
        raise HTTPException(status_code=404, detail="Asset not found")
    path = (DOCS_DIR / Path(*relative.parts)).resolve()
    docs_root = DOCS_DIR.resolve()
    if path != docs_root and docs_root not in path.parents:
        raise HTTPException(status_code=404, detail="Asset not found")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return path


@router.get("/docs")
async def list_docs(locale: str = Query(_DEFAULT_LOCALE)):
    selected_locale = _normalize_locale(locale)
    documents = [
        {
            "slug": slug,
            "category": document["category"],
            "title": document["titles"].get(selected_locale) or document["titles"][_DEFAULT_LOCALE],
            "summary": document["summaries"].get(selected_locale) or document["summaries"][_DEFAULT_LOCALE],
        }
        for slug, document in _DOCUMENTS.items()
    ]
    return APIResponseSuccess(data={"documents": documents, "locale": selected_locale})


@router.get("/docs/assets/{asset_path:path}", response_class=FileResponse, include_in_schema=False)
async def get_doc_asset(asset_path: str):
    return FileResponse(_resolve_asset_path(asset_path))


@router.get("/docs/{slug}")
async def get_doc(slug: str, locale: str = Query(_DEFAULT_LOCALE)):
    selected_locale = _normalize_locale(locale)
    document = _DOCUMENTS.get(slug)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found")
    path = _document_path(slug, selected_locale)
    source = path.read_text(encoding="utf-8")
    relative_path = PurePosixPath(path.relative_to(DOCS_DIR).as_posix())
    html, toc = _render_markdown(source, relative_path)
    return APIResponseSuccess(
        data={
            "slug": slug,
            "locale": selected_locale,
            "title": document["titles"].get(selected_locale) or document["titles"][_DEFAULT_LOCALE],
            "summary": document["summaries"].get(selected_locale) or document["summaries"][_DEFAULT_LOCALE],
            "html": html,
            "toc": toc,
        }
    )
