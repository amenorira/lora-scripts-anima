"""Caption options shared by every vision API format.

Reuse the upstream MOSS prompt, knowledge inheritance, JSON validation and
candidate exporter, while keeping the existing API transports and task UI.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile

from PIL import Image

from tools import caption_images_moss as upstream
from backend.tagger import api_engine

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".avif"}


def _name(value: str, label: str, empty: bool = False) -> str:
    if empty and not value:
        return value
    if not value or value in {".", ".."} or any(c in value for c in '/\\:*?"<>|\r\n\x00'):
        raise ValueError(f"Invalid {label} / {label} 不能包含路径或非法文件名字符")
    return value


def validate_options(value: dict, parse_mode: str = "multi-caption") -> dict:
    options = dict(value)
    mode = options.setdefault("mode", "fill")
    if mode not in {"fill", "regenerate", "export"}:
        raise ValueError("Invalid run mode / 无效的运行方式")
    for key, default in (("caption_extension", ".txt"), ("reference_extension", "")):
        text = str(options.get(key, default)).strip()
        options[key] = _name("." + text.lstrip("."), key) if text else ""
    extension = options["caption_extension"]
    if not extension or extension.lower() in _IMAGE_EXTENSIONS | {".json"}:
        raise ValueError("Caption extension must not replace an image or JSON / 标注扩展名不能覆盖图片或 JSON")
    if mode == "fill" and extension.lower() == options["reference_extension"].lower():
        raise ValueError("Reference and output extensions must differ / 补齐模式请使用不同的参考和输出扩展名，例如 .tags → .txt")
    for key, default in (("sidecar_suffix", "_caption.json"), ("dir_knowledge_name", "_knowledge.txt"), ("knowledge_suffix", "_knowledge.txt")):
        options[key] = _name(str(options.get(key, default)), key, empty=key != "sidecar_suffix")
    if not options["sidecar_suffix"].lower().endswith(".json"):
        raise ValueError("JSON suffix must end with .json / 结果 JSON 后缀必须以 .json 结尾")
    separator = str(options.get("separator", "---===---"))
    if parse_mode == "multi-caption" and (not separator.strip() or any(c in separator for c in "\r\n\x00")):
        raise ValueError("Separator must be one nonempty line / 分隔符必须是非空单行文本")
    options["separator"] = separator if separator.strip() else "---===---"
    candidates = options.get("candidates", ["original", "long", "medium", "short"])
    if parse_mode == "multi-caption" and (not isinstance(candidates, list) or not candidates or len(candidates) != len(set(candidates)) or any(name not in {"original", "long", "medium", "short"} for name in candidates)):
        raise ValueError("Select at least one valid caption candidate / 请至少选择一种有效的导出候选")
    options["candidates"] = candidates
    if mode != "export":
        for key in ("knowledge_file", "prompt_file"):
            path = str(options.get(key) or "").strip()
            if path and not Path(path).expanduser().is_file():
                raise ValueError(f"File not found / 文件不存在: {key}")
    return options


def resolve_prompt(options: dict, prompt: str) -> str:
    return upstream.read_text(Path(options["prompt_file"]).expanduser()) if options.get("prompt_file") else prompt


def prepare_runtime(options: dict, root: Path, prompt: str) -> dict:
    if options.get("mode") == "export":
        return {"options": options, "loader": None, "template": ""}
    common = str(options.get("knowledge") or "")
    if options.get("knowledge_file"):
        common += "\n\n" + upstream.read_text(Path(options["knowledge_file"]).expanduser())
    template = resolve_prompt(options, prompt)
    return {"options": options, "loader": upstream.KnowledgeLoader(root, common, options["dir_knowledge_name"], options["knowledge_suffix"]), "template": template}


def _atomic_write(path: Path, text: str) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def process(config, path: Path, runtime: dict, *, client=None, cancel_event=None,
            write=False, index=0) -> dict:
    """Return the existing workspace outcome shape; only the caller owns tasks."""
    options = runtime["options"]
    mode = options.get("mode", "fill") if write else "regenerate"
    dry_run = bool(options.get("dry_run")) and write
    output = path.with_suffix(options["caption_extension"])
    sidecar = path.with_name(path.stem + options["sidecar_suffix"])
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("cancelled")

    def outcome(text: str, *, status="success", raw="", tags=None, event=None, **extra):
        result = {"index": index, "name": path.name, "path": str(path), "text": text,
                  "tags": tags or [], "categories": {}, "raw": raw}
        return {"status": status, "tag_count": len(tags or []) if config.parse_mode == "tags" else 1,
                "result": result, **({"event": event} if event else {}), **extra}

    if not dry_run and write and mode == "fill" and output.is_file():
        return outcome(upstream.read_text(output), status="skipped")
    old = json.loads(sidecar.read_text(encoding="utf-8")) if sidecar.is_file() and write and not dry_run else None
    if not dry_run and mode == "export" and old is None:
        return outcome("", status="skipped")
    reuse = not dry_run and old is not None and mode in {"fill", "export"}
    if reuse:
        stored_format = old.get("parse_mode", "multi-caption")
        if stored_format != config.parse_mode:
            raise ValueError("Stored JSON uses another output format; select that format or regenerate / 已有 JSON 的输出格式不同，请选择相同格式或重新生成")
        reference = old.get("reference") or ""
        response = old["response"]
        raw = old.get("raw_content") or ""
    else:
        reference_path = path.with_suffix(options["reference_extension"]) if options["reference_extension"] else None
        reference = upstream.read_text(reference_path) if reference_path and reference_path.is_file() else ""
        if any(upstream.is_separator_line(line, options["separator"]) for line in reference.splitlines()):
            if old is None:
                raise ValueError("Reference contains candidate separators without original JSON / 参考文件已含多描述分隔符，但缺少保存原文的 JSON")
            reference = old.get("reference") or ""
        knowledge = runtime["loader"].for_image(path)
        template = runtime["template"]
        prompt = upstream.build_prompt(template, reference, knowledge)
        if reference and "{{reference}}" not in template:
            prompt += "\n\nReference caption (correct unsupported claims):\n" + reference
        if knowledge and "{{knowledge}}" not in template:
            prompt += "\n\nKnowledge for identifying visible content only; do not invent invisible facts:\n" + knowledge
        if dry_run:
            return outcome("", event="checked", prompt=prompt if index == 0 else "", reference=bool(reference), knowledge=len(knowledge))
        metadata = {}
        image_config = replace(config, prompt=prompt)
        with Image.open(path) as image:
            parsed, raw = api_engine.interrogate(image_config, image, client=client, cancel_event=cancel_event, metadata=metadata)
        if config.parse_mode == "multi-caption":
            response = upstream.extract_json_object(raw)
            upstream.validate_response(response)
        else:
            tags = parsed
            response = {"text": ", ".join(tags) if config.parse_mode == "tags" else tags[0], "tags": tags if config.parse_mode == "tags" else []}
        old = {"version": 1, "image": path.name, "parse_mode": config.parse_mode,
               "model": config.model, "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
               "reference": reference or None, "knowledge": knowledge or None, "prompt": prompt,
               "response": response, "raw_content": raw, **metadata}
    if config.parse_mode == "multi-caption":
        upstream.validate_response(response)
        text = upstream.build_caption_text(upstream.collect_candidates(options["candidates"], response, reference), options["separator"])
        if not text.strip():
            raise ValueError("No selected candidate has content / 所选候选没有内容；没有参考标注时，请选择长、中或短描述")
        tags = []
    else:
        text = str(response["text"])
        tags = list(response.get("tags") or [])
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("cancelled")
    if write:
        if not reuse and options.get("save_json", True):
            _atomic_write(sidecar, json.dumps(old, ensure_ascii=False, indent=2) + "\n")
        if mode == "export" and not options.get("export_overwrite", True) and output.is_file():
            return outcome(upstream.read_text(output), status="skipped")
        _atomic_write(output, text)
    return outcome(text, raw=raw, tags=tags, event="reused" if reuse else None)
