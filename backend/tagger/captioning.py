"""Run Kohya's MOSS caption workflow through the existing task system."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile
from PIL import Image

from backend.tagger import api_engine

from tools import caption_images_moss as upstream


def _name(value: str, label: str, empty: bool = False) -> str:
    if empty and not value:
        return value
    if not value or value in {".", ".."} or any(c in value for c in '/\\:*?"<>|\r\n\x00'):
        raise ValueError(f"Invalid {label} / {label} 不能包含路径或非法文件名字符")
    return value


def validate_options(value: dict) -> dict:
    options = {
        "mode": "generate", "overwrite": False, "recursive": True,
        "reference_extension": ".tags", "caption_extension": ".txt", "sidecar_suffix": "_caption.json",
        "candidates": ["original", "long", "medium", "short"], "separator": "---===---",
        "knowledge": "", "knowledge_file": "", "dir_knowledge_name": "_knowledge.txt", "knowledge_suffix": "_knowledge.txt",
        "prompt_source": "default", "prompt_text": "", "prompt_file": "", "dry_run": False, "verbose": False,
    }
    options.update({key: value[key] for key in options if key in value})
    if options["mode"] not in {"generate", "export"}:
        raise ValueError("Invalid task / 请选择生成描述或从 JSON 导出")
    for key in ("caption_extension", "reference_extension"):
        text = str(options[key]).strip()
        options[key] = _name("." + text.lstrip("."), key) if text else ""
    extension = options["caption_extension"]
    if not extension or extension.lower() in upstream.IMAGE_EXTENSIONS | {".avif", ".json"}:
        raise ValueError("Caption extension must not replace an image or JSON / 标注扩展名不能覆盖图片或 JSON")
    if options["mode"] == "generate" and not options["overwrite"] and extension.lower() == options["reference_extension"].lower():
        raise ValueError("Use different reference/output extensions, or enable regeneration / 参考与输出扩展名相同时，请开启重新生成已有结果")
    for key in ("sidecar_suffix", "dir_knowledge_name", "knowledge_suffix"):
        options[key] = _name(str(options[key]), key, empty=key != "sidecar_suffix")
    if not options["sidecar_suffix"].lower().endswith(".json"):
        raise ValueError("JSON suffix must end with .json / 结果 JSON 后缀必须以 .json 结尾")
    separator = str(options["separator"])
    if not separator.strip() or any(c in separator for c in "\r\n\x00"):
        raise ValueError("Separator must be one nonempty line / 分隔符必须是非空单行文本")
    names = options["candidates"]
    if not isinstance(names, list) or not names or any(name not in {"original", "long", "medium", "short"} for name in names) or len(names) != len(set(names)):
        raise ValueError("Select at least one valid candidate / 请至少选择一种有效的导出候选")
    if options["mode"] == "generate":
        if options["prompt_source"] not in {"default", "text", "file"}:
            raise ValueError("Invalid prompt source / 无效的提示词来源")
        for key in ("knowledge_file", "prompt_file"):
            used = key == "knowledge_file" or options["prompt_source"] == "file"
            path = str(options[key]).strip() if used else ""
            if path and not Path(path).expanduser().is_file():
                raise ValueError(f"File not found / 文件不存在: {key}")
        if options["prompt_source"] == "file" and not str(options["prompt_file"]).strip():
            raise ValueError("Select a prompt file / 请选择提示词文件")
        if options["prompt_source"] == "text" and not str(options["prompt_text"]).strip():
            raise ValueError("Custom prompt cannot be empty / 自定义提示词不能为空")
    return options


def resolve_prompt(options: dict) -> str:
    if options.get("prompt_source") == "file":
        return upstream.read_text(Path(options["prompt_file"]).expanduser())
    if options.get("prompt_source") == "text":
        return str(options["prompt_text"])
    return upstream.DEFAULT_PROMPT


def validate_config(payload: dict, options: dict) -> api_engine.ApiConfig:
    if options["mode"] == "export" or options["dry_run"]:
        return api_engine.ApiConfig("", "", str(payload.get("model") or "offline"), "")
    return api_engine.validate_config({
        **payload, "prompt": resolve_prompt(options),
        "max_edge": payload.get("max_image_size", 1536),
        "concurrency": payload.get("max_workers", 1),
        "max_tokens": payload.get("max_tokens", 16384),
        "temperature": payload.get("temperature", 1), "timeout": payload.get("timeout", 600),
        "top_p": payload.get("top_p", .95), "jpeg_quality": payload.get("jpeg_quality", ""),
        "extra_body": payload.get("extra_body", "{}"),
    })


def prepare_runtime(options: dict, root: Path) -> dict:
    if options["mode"] == "export":
        return {"options": options, "loader": None, "template": ""}
    common = str(options["knowledge"])
    if options["knowledge_file"]:
        common += "\n\n" + upstream.read_text(Path(options["knowledge_file"]).expanduser())
    return {"options": options, "loader": upstream.KnowledgeLoader(root, common, options["dir_knowledge_name"], options["knowledge_suffix"]), "template": resolve_prompt(options)}


def probe_outputs(paths: list[Path], extension: str, options: dict) -> dict:
    reference = str(options.get("reference_extension", ".tags")).strip()
    reference = _name("." + reference.lstrip("."), "reference_extension") if reference else ""
    suffix = _name(str(options.get("sidecar_suffix", "_caption.json")), "sidecar_suffix")
    separator = str(options.get("separator") or "---===---")
    counts = {"references": 0, "sidecars": 0, "ordinary_outputs": 0}
    for path in paths:
        counts["references"] += bool(reference and path.with_suffix(reference).is_file())
        counts["sidecars"] += path.with_name(path.stem + suffix).is_file()
        output = path.with_suffix(extension)
        if output.is_file():
            try:
                with output.open(encoding="utf-8-sig", errors="replace") as handle:
                    first = handle.readline(4096)
                counts["ordinary_outputs"] += not upstream.is_separator_line(first, separator)
            except OSError:
                counts["ordinary_outputs"] += 1
    return counts


def _atomic_write(path: Path, text: str) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def process(config: api_engine.ApiConfig, path: Path, runtime: dict, *, cancel_event=None, index=0) -> dict:
    options = runtime["options"]
    output = path.with_suffix(options["caption_extension"])
    sidecar = path.with_name(path.stem + options["sidecar_suffix"])

    def check_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")

    def outcome(text="", *, status="success", event=None, **extra):
        return {"status": status, "tag_count": 0, "result": {"index": index, "name": path.name, "path": str(path), "text": text, "tags": [], "categories": {}}, **({"event": event} if event else {}), **extra}

    check_cancelled()
    if not options["dry_run"] and not options["overwrite"] and output.is_file():
        return outcome(status="skipped")
    old = json.loads(sidecar.read_text(encoding="utf-8")) if sidecar.is_file() and not options["dry_run"] else None
    if options["mode"] == "export" and old is None:
        return outcome(status="skipped", event="missing_json")
    reuse = old is not None and (options["mode"] == "export" or not options["overwrite"])
    if reuse:
        if old.get("parse_mode", "multi-caption") != "multi-caption":
            raise ValueError("Not a MOSS result JSON / 此 JSON 不是 MOSS 多候选结果，请重新生成")
        response, reference = old["response"], old.get("reference") or ""
    else:
        reference_path = path.with_suffix(options["reference_extension"]) if options["reference_extension"] else None
        reference = upstream.read_text(reference_path) if reference_path and reference_path.is_file() else ""
        if any(upstream.is_separator_line(line, options["separator"]) for line in reference.splitlines()):
            if old is None:
                raise ValueError("Reference already contains MOSS output but original JSON is missing / 参考文件已是多候选结果，但缺少保存原文的 JSON")
            reference = old.get("reference") or ""
        knowledge = runtime["loader"].for_image(path)
        template = runtime["template"]
        prompt = upstream.build_prompt(template, reference, knowledge)
        if reference and "{{reference}}" not in template:
            prompt += "\n\nReference caption (use only claims supported by the image):\n" + reference
        if knowledge and "{{knowledge}}" not in template:
            prompt += "\n\nKnowledge for identifying visible content only:\n" + knowledge
        if options["dry_run"]:
            return outcome(event="checked", prompt=prompt if index == 0 else "", reference=bool(reference), knowledge=len(knowledge))
        check_cancelled()
        info = {}
        with Image.open(path) as image:
            response, raw = api_engine.interrogate(replace(config, prompt=prompt), image, client=runtime.get("client"), cancel_event=cancel_event, metadata=info)
        info["raw_content"] = raw
        old = {"version": 1, "image": path.name, "model": config.model,
               "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
               "reference": reference or None, "knowledge": knowledge or None, "prompt": prompt, "response": response, **info}
    upstream.validate_response(response)
    text = upstream.build_caption_text(upstream.collect_candidates(options["candidates"], response, reference), options["separator"])
    if not text.strip():
        raise ValueError("No selected candidate has content / 所选候选没有内容；没有参考标注时请选择长、中或短描述")
    check_cancelled()
    if not reuse:
        _atomic_write(sidecar, json.dumps(old, ensure_ascii=False, indent=2) + "\n")
    _atomic_write(output, text)
    return outcome(text, event="reused" if reuse else "caption_written")
