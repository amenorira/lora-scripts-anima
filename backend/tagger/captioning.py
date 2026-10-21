"""Run Kohya's MOSS caption workflow through the existing task system."""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime
import json
import os
import stat
from pathlib import Path
import tempfile
import time
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
        "reference_extension": ".txt", "caption_extension": ".txt", "sidecar_suffix": "_caption.json",
        "candidates": ["original", "long", "medium", "short"], "separator": "---===---",
        "knowledge": "", "knowledge_file": "", "dir_knowledge_name": "_knowledge.txt", "knowledge_suffix": "_knowledge.txt",
        "prompt_source": "default", "prompt_text": "", "prompt_file": "", "dry_run": False, "verbose": False,
    }
    options.update({key: value[key] for key in options if key in value})
    options.update(plan_options(options))
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


def output_options(value: dict | None = None, extension: str = ".txt") -> dict:
    """File reading settings, independent of generation and write policy."""
    value = value or {}
    settings = {"caption_extension": extension, "reference_extension": value.get("reference_extension", ".txt"),
                "sidecar_suffix": str(value.get("sidecar_suffix", "_caption.json")), "separator": str(value.get("separator", "---===---")).strip()}
    for key in ("caption_extension", "reference_extension"):
        text = str(settings[key]).strip()
        if key == "reference_extension" and not text:
            text = ".txt"
        settings[key] = _name("." + text.lstrip("."), key) if text else ""
    if not settings["caption_extension"] or settings["caption_extension"].lower() in upstream.IMAGE_EXTENSIONS | {".avif", ".json"}:
        raise ValueError("Caption extension must not replace an image or JSON / 标注扩展名不能覆盖图片或 JSON")
    _name(settings["sidecar_suffix"], "sidecar_suffix")
    if not settings["sidecar_suffix"].lower().endswith(".json"):
        raise ValueError("JSON suffix must end with .json / 结果 JSON 后缀必须以 .json 结尾")
    if not settings["separator"] or any(c in settings["separator"] for c in "\r\n\x00"):
        raise ValueError("Separator must be one nonempty line / 分隔符必须是非空单行文本")
    return settings


def plan_options(value: dict) -> dict:
    settings = output_options(value, value.get("caption_extension", ".txt"))
    settings.update({key: value.get(key, default) for key, default in {
        "mode": "generate", "overwrite": False, "knowledge_file": "", "prompt_file": "", "prompt_source": "default",
        "dir_knowledge_name": "_knowledge.txt", "knowledge_suffix": "_knowledge.txt",
    }.items()})
    if settings["mode"] not in {"generate", "export"}:
        raise ValueError("Invalid task / 请选择生成描述或从 JSON 导出")
    for key in ("dir_knowledge_name", "knowledge_suffix"):
        settings[key] = _name(str(settings[key]), key, empty=True)
    return settings


def related_file(path: Path, target: Path, *, parent: Path | None = None) -> Path:
    if target.resolve().parent != (parent if parent is not None else path.resolve().parent):
        raise ValueError("Annotation escaped source scope / 标注文件超出输入源范围")
    return target


def output_files(path: Path, options: dict, *, check_scope: bool = True) -> tuple[Path, Path, Path | None]:
    files = (path.with_suffix(options["caption_extension"]), path.with_name(path.stem + options["sidecar_suffix"]),
             path.with_suffix(options["reference_extension"]) if options["reference_extension"] else None)
    if not check_scope:
        return files
    parent = path.resolve().parent
    return tuple(related_file(path, file, parent=parent) if file else None for file in files)


def parse_caption_text(text: str, separator: str = "---===---") -> dict[str, str]:
    """Read the same named sections emitted by upstream.build_caption_text."""
    sections: dict[str, list[str]] = {}
    current = None
    for line in text.lstrip("\ufeff").splitlines():
        if line.strip().startswith(separator + " # "):
            name = line.strip()[len(separator + " # "):].strip()
            if name in {"original", "long", "medium", "short"}:
                current = name
                sections.setdefault(name, [])
                continue
        if current is not None:
            sections[current].append(line)
    return {name: "\n".join(lines).strip() for name, lines in sections.items()}


def read_bounded(path: Path, limit: int = 512 * 1024) -> str:
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Annotation file is too large / 标注文件过大")
    return data.decode("utf-8-sig", errors="replace")


def is_reparse(info) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def output_state(path: Path, options: dict, cached: dict | None = None, *, parent: Path | None = None) -> dict:
    # The workspace validates each distinct parent directory once per scan.
    # lstat detects links before following them; ordinary and missing outputs
    # need no expensive realpath walk on Windows.
    parent = path.resolve().parent if parent is None else parent
    output, sidecar, reference = output_files(path, options, check_scope=False)
    errors = []
    def stamp(file):
        try:
            info = file.lstat() if file else None
            if info and is_reparse(info):
                related_file(path, file, parent=parent)
                info = file.stat()
            return (info.st_mtime_ns, info.st_size) if info and stat.S_ISREG(info.st_mode) else None
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            errors.append(str(exc))
            return False
    fingerprint = (stamp(output), stamp(sidecar), stamp(reference), tuple(options[key] for key in ("caption_extension", "sidecar_suffix", "reference_extension", "separator")))
    if cached and not cached.get("read_error") and cached.get("fingerprint") == fingerprint:
        return cached
    kind = "unreadable" if fingerprint[0] is False else "missing"
    if fingerprint[0]:
        try:
            with output.open(encoding="utf-8-sig", errors="replace") as handle:
                first = handle.readline(4096).strip()
            kind = "moss" if first in {options["separator"] + " # " + n for n in ("original", "long", "medium", "short")} else "ordinary"
        except OSError as exc:
            errors.append(str(exc))
            kind = "unreadable"
    def present(stamp):
        return None if stamp is False else stamp is not None
    return {"fingerprint": fingerprint, "has_caption": present(fingerprint[0]),
            "has_sidecar": present(fingerprint[1]), "has_reference": present(fingerprint[2]),
            "caption_kind": kind, "updated_at": fingerprint[0][0] / 1e9 if fingerprint[0] else None,
            **({"read_error": "\n".join(errors)} if errors else {})}


def output_counts(states: list[dict]) -> dict:
    counts = {key: 0 for key in ("outputs", "moss_outputs", "ordinary_outputs", "missing_outputs", "unreadable_outputs", "references", "sidecars", "missing_json", "reusable", "requestable")}
    counts["total"] = len(states)
    for state in states:
        counts["outputs"] += state["has_caption"] is True
        counts[state["caption_kind"] + "_outputs"] += 1
        counts["references"] += state["has_reference"] is True
        counts["sidecars"] += state["has_sidecar"] is True
        counts["missing_json"] += state["has_sidecar"] is False
        if state["caption_kind"] == "missing":
            counts["reusable" if state["has_sidecar"] else "requestable"] += 1
    return counts


def execution_plan(states: list[dict], options: dict) -> dict:
    plan = {key: 0 for key in ("requests", "reused", "skipped", "writes", "overwrite_captions", "overwrite_json", "overwrite_references")}
    for state in states:
        action = planned_action(state, options)
        plan[{"request": "requests", "reuse": "reused", "skip": "skipped"}[action]] += 1
        if action != "skip":
            plan["writes"] += 1
            plan["overwrite_captions"] += state["has_caption"]
            plan["overwrite_json"] += action == "request" and state["has_sidecar"]
            plan["overwrite_references"] += bool(state["has_reference"] and options["reference_extension"].lower() == options["caption_extension"].lower())
    return plan


def planned_action(state: dict, options: dict) -> str:
    if not options["overwrite"] and state["has_caption"]:
        return "skip"
    if options["mode"] == "export":
        return "reuse" if state["has_sidecar"] else "skip"
    return "reuse" if state["has_sidecar"] and not options["overwrite"] else "request"


def validate_write_targets(paths: list[Path], targets: list[Path], protected: list[Path] = ()) -> None:
    """Check the files this operation will actually write."""
    protected = {os.path.normcase(str(path.resolve())) for path in [*paths, *protected]}
    seen = set()
    for target in targets:
        key = os.path.normcase(str(target.resolve()))
        if key in seen or key in protected:
            raise ValueError(f"Conflicting output filenames / 图片输出文件名冲突: {target.name}")
        seen.add(key)


def validate_output_targets(paths: list[Path], options: dict, states: list[dict]) -> None:
    targets = []
    requests = []
    for path, state in zip(paths, states):
        if state["has_caption"] and not options["overwrite"]:
            continue
        if state["has_caption"] is None or state["has_sidecar"] is None:
            raise ValueError(state["read_error"])
        action = planned_action(state, options)
        if action == "skip":
            continue
        output, sidecar, _ = output_files(path, options)
        targets.extend([output, sidecar] if action == "request" else [output])
        if action == "request":
            requests.append(path)
    protected = []
    if requests:
        for key in ("knowledge_file", "prompt_file"):
            if options.get(key) and (key != "prompt_file" or options.get("prompt_source") == "file"):
                protected.append(Path(options[key]).expanduser())
        for path in requests:
            for name in (options.get("dir_knowledge_name"), path.stem + options["knowledge_suffix"] if options.get("knowledge_suffix") else ""):
                if name:
                    protected.append(path.with_name(name))
    validate_write_targets(paths, targets, protected)


def build_prompt(runtime: dict, path: Path, reference: str = "") -> tuple[str, str]:
    knowledge = runtime["loader"].for_image(path)
    template = runtime["template"]
    prompt = upstream.build_prompt(template, reference, knowledge)
    if reference and "{{reference}}" not in template:
        prompt += "\n\nReference caption (use only claims supported by the image):\n" + reference
    if knowledge and "{{knowledge}}" not in template:
        prompt += "\n\nKnowledge for identifying visible content only:\n" + knowledge
    return prompt, knowledge


def preview(config: api_engine.ApiConfig, path: Path, options: dict, *, cancel_event=None) -> dict:
    if not any(name != "original" for name in options["candidates"]):
        raise ValueError("No selected candidate has content / 请选择长、中或短描述")
    started = time.monotonic()
    runtime = prepare_runtime({**options, "mode": "generate", "dir_knowledge_name": "", "knowledge_suffix": ""}, path.parent)
    prompt, _ = build_prompt(runtime, path)
    info = {}
    with Image.open(path) as image:
        response, raw = api_engine.interrogate(replace(config, prompt=prompt), image, cancel_event=cancel_event, metadata=info)
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("cancelled")
    candidates = dict(upstream.collect_candidates([n for n in options["candidates"] if n != "original"], response, ""))
    if not candidates:
        raise ValueError("No selected candidate has content / 请选择长、中或短描述")
    return {"model": config.model, "candidates": candidates, "text": upstream.build_caption_text(list(candidates.items()), options["separator"]),
            "prompt": prompt, "raw": raw, **info, "elapsed": round(time.monotonic() - started, 2)}


def _atomic_write(path: Path, text: str) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def process(config: api_engine.ApiConfig, path: Path, runtime: dict, *, cancel_event=None) -> dict:
    options = runtime["options"]
    output, sidecar, reference_path = output_files(path, options)

    def check_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise InterruptedError("cancelled")

    def outcome(*, status="success", event=None, **extra):
        return {"status": status, **({"event": event} if event else {}), **extra}

    check_cancelled()
    if not options["overwrite"] and output.is_file():
        return outcome(status="skipped", event="skipped", planned_action="skip")
    old = json.loads(read_bounded(sidecar, 2 * 1024 * 1024)) if sidecar.is_file() else None
    if options["mode"] == "export" and old is None:
        return outcome(status="skipped", event="missing_json", planned_action="skip")
    reuse = old is not None and (options["mode"] == "export" or not options["overwrite"])
    if reuse:
        if old.get("parse_mode", "multi-caption") != "multi-caption":
            raise ValueError("Not a MOSS result JSON / 此 JSON 不是 MOSS 多候选结果，请重新生成")
        response, reference = old["response"], old.get("reference") or ""
    else:
        reference = upstream.read_text(reference_path) if reference_path and reference_path.is_file() else ""
        if any(upstream.is_separator_line(line, options["separator"]) for line in reference.splitlines()):
            if old is None:
                raise ValueError("Reference already contains MOSS output but original JSON is missing / 参考文件已是多候选结果，但缺少保存原文的 JSON")
            reference = old.get("reference") or ""
        prompt, knowledge = build_prompt(runtime, path, reference)
        if not reference and options["candidates"] == ["original"]:
            raise ValueError("No selected candidate has content / 没有参考标注时请选择长、中或短描述")
        if options["dry_run"]:
            return outcome(status="checked", event="checked", prompt=prompt, planned_action="request", reference=bool(reference), knowledge=len(knowledge))
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
    if options["dry_run"]:
        return outcome(status="checked", event="checked", planned_action="reuse")
    check_cancelled()
    if not reuse:
        _atomic_write(sidecar, json.dumps(old, ensure_ascii=False, indent=2) + "\n")
    _atomic_write(output, text)
    return outcome(event="reused" if reuse else "caption_written", planned_action="reuse" if reuse else "request")
