"""Versioned application-level training configuration snapshots."""
from __future__ import annotations

import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import yaml

from backend.training.field_registry import get_all_fields, get_fields_json


TRAINING_CONFIG_NAME = "training.yaml"
TRAINING_CONFIG_SCHEMA_VERSION = 2
SUPPORTED_TRAINING_CONFIG_SCHEMAS = {1, 2}
MAX_TRAINING_CONFIG_BYTES = 5 * 1024 * 1024
SECTION_ORDER = [
    "model",
    "network",
    "training",
    "optimizer",
    "regularization",
    "caption",
    "performance",
    "save",
    "preview",
    "misc",
]


class TrainingConfigError(ValueError):
    """Raised when a training YAML document is invalid or unsupported."""


class _UniqueKeySafeLoader(yaml.SafeLoader):
    pass


def _construct_unique_mapping(loader: yaml.SafeLoader, node: yaml.MappingNode, deep: bool = False) -> dict:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise TrainingConfigError("YAML mapping keys must be scalar values") from exc
        if duplicate:
            raise TrainingConfigError(f"Duplicate YAML key: {key}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def _visible_sections(profile_id: str) -> list[dict[str, Any]]:
    group_map = {"sdxl-lora": "sdxl", "anima-lora": "anima", "krea2-lora": "krea2"}
    target_group = group_map.get(profile_id, "all")
    target_by_key = {}
    for raw_field in get_all_fields():
        target_by_key.setdefault(str(raw_field.get("key")), raw_field.get("target"))
    result = []
    for section in get_fields_json().get("sections", []):
        fields = []
        for field in section.get("fields", []):
            field = {**field, "_target": target_by_key.get(str(field.get("key")))}
            profiles = field.get("profiles")
            if isinstance(profiles, list):
                if profile_id in profiles:
                    fields.append(field)
                continue
            if profile_id == "krea2-lora":
                if field.get("key") == "model_train_type":
                    fields.append(field)
                continue
            group = field.get("group")
            if not group or group == "all":
                fields.append(field)
            elif isinstance(group, list) and target_group in group:
                fields.append(field)
            elif group == target_group:
                fields.append(field)
        if fields:
            result.append({"key": section["key"], "fields": fields})
    return result


def _condition_keys(field: dict[str, Any]) -> list[str]:
    conditions: list[dict[str, Any]] = []
    show_if = field.get("showIf")
    if isinstance(show_if, dict):
        conditions.append(show_if)
    elif isinstance(show_if, list):
        conditions.extend(item for item in show_if if isinstance(item, dict))
    show_if_any = field.get("showIfAny")
    if isinstance(show_if_any, list):
        for group in show_if_any:
            if isinstance(group, list):
                conditions.extend(item for item in group if isinstance(item, dict))
    return [str(item["key"]) for item in conditions if item.get("key")]


def _value_text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _condition_matches(condition: dict[str, Any], form: dict[str, Any]) -> bool:
    value = form.get(condition.get("key"))
    if "eq" in condition:
        expected = condition["eq"]
        if _value_text(value) == _value_text(expected):
            return True
        alternatives = condition.get("or")
        return isinstance(alternatives, list) and any(
            _value_text(value) == _value_text(item) for item in alternatives
        )
    if "neq" in condition:
        return value not in (None, "") and _value_text(value) != _value_text(condition["neq"])
    return True


def _field_is_active(field: dict[str, Any], form: dict[str, Any]) -> bool:
    show_if = field.get("showIf")
    if isinstance(show_if, dict) and not _condition_matches(show_if, form):
        return False
    if isinstance(show_if, list) and not all(
        _condition_matches(item, form) for item in show_if if isinstance(item, dict)
    ):
        return False
    show_if_any = field.get("showIfAny")
    if isinstance(show_if_any, list) and not any(
        isinstance(group, list)
        and all(_condition_matches(item, form) for item in group if isinstance(item, dict))
        for group in show_if_any
    ):
        return False
    return True


def _is_empty_value(value: Any) -> bool:
    if value is None or value == "":
        return True
    return isinstance(value, float) and value != value


def _matches_default(value: Any, default: Any) -> bool:
    if value == default:
        return True
    if isinstance(value, (dict, list)) or isinstance(default, (dict, list)):
        return False
    return _value_text(value) == _value_text(default)


def _dependency_parent(
    field: dict[str, Any],
    field_defs: dict[str, dict[str, Any]],
    form: dict[str, Any],
    *,
    subgroup: str | None,
) -> str | None:
    candidates = []
    for order, key in enumerate(_condition_keys(field)):
        parent = field_defs.get(key)
        if not parent or key not in form or parent.get("section") != field.get("section"):
            continue
        if subgroup and parent.get("subGroup") != subgroup:
            continue
        field_type = parent.get("type")
        priority = 0 if field_type == "toggle" else 1 if field_type == "select" else 2
        candidates.append((priority, order, key))
    candidates.sort()
    return candidates[0][2] if candidates else None


def _state_key(field: dict[str, Any]) -> str:
    if field.get("type") == "toggle":
        return "enabled"
    if field.get("type") == "select":
        return "selected"
    return "value"


def _render_field_tree(
    key: str,
    form: dict[str, Any],
    field_defs: dict[str, dict[str, Any]],
    children: dict[str, list[str]],
    included_keys: set[str],
) -> Any:
    child_keys = children.get(key, [])
    if not child_keys:
        return form[key]
    rendered: dict[str, Any] = {}
    if key in included_keys:
        rendered[_state_key(field_defs[key])] = form[key]
    rendered["options"] = {
            child: _render_field_tree(child, form, field_defs, children, included_keys)
            for child in child_keys
    }
    return rendered


def group_training_form(
    form: dict[str, Any],
    profile_id: str,
) -> dict[str, Any]:
    """Group flat form values by UI section and conditional parent fields."""
    sections = _visible_sections(profile_id)
    field_defs: dict[str, dict[str, Any]] = {}
    section_fields: dict[str, list[str]] = {}
    for section in sections:
        for field in section["fields"]:
            key = str(field["key"])
            field_defs[key] = field
            section_fields.setdefault(section["key"], []).append(key)

    included_keys = set()
    for key, value in form.items():
        field = field_defs.get(key)
        if not field or key in {"model_train_type", "gpu_ids"}:
            continue
        if field.get("hidden") and field.get("_target") != "ui":
            continue
        if not _field_is_active(field, form) or _is_empty_value(value):
            continue
        # Match the sidebar TOML preview: only fields explicitly marked
        # omitDefault are suppressed when they equal their registry default.
        if field.get("omitDefault") and "default" in field and _matches_default(value, field.get("default")):
            continue
        included_keys.add(key)

    context_keys = set(included_keys)
    for key in list(included_keys):
        current = key
        visited: set[str] = set()
        while current not in visited:
            visited.add(current)
            field = field_defs.get(current)
            if not field:
                break
            parent = _dependency_parent(
                field,
                field_defs,
                form,
                subgroup=field.get("subGroup"),
            )
            if not parent or parent not in form:
                break
            context_keys.add(parent)
            current = parent

    grouped: dict[str, Any] = {}
    consumed = {"model_train_type", "gpu_ids"}
    for section_key in SECTION_ORDER:
        available = [
            key
            for key in section_fields.get(section_key, [])
            if key in form and key in context_keys and key not in consumed
        ]
        if not available:
            continue
        section_output: dict[str, Any] = {}
        subgroup_names: list[str] = []
        for key in available:
            subgroup = field_defs[key].get("subGroup")
            if subgroup and subgroup not in subgroup_names:
                subgroup_names.append(subgroup)

        containers: list[tuple[str | None, list[str]]] = [(None, [
            key for key in available if not field_defs[key].get("subGroup")
        ])]
        containers.extend((name, [
            key for key in available if field_defs[key].get("subGroup") == name
        ]) for name in subgroup_names)

        for subgroup, keys in containers:
            if not keys:
                continue
            children: dict[str, list[str]] = {}
            child_set: set[str] = set()
            for key in keys:
                parent = _dependency_parent(
                    field_defs[key], field_defs, form, subgroup=subgroup
                )
                if parent in keys and parent != key:
                    children.setdefault(parent, []).append(key)
                    child_set.add(key)
            rendered = {
                key: _render_field_tree(key, form, field_defs, children, included_keys)
                for key in keys
                if key not in child_set
            }
            if subgroup:
                section_output[subgroup] = rendered
            else:
                section_output.update(rendered)
            consumed.update(keys)
        if section_output:
            grouped[section_key] = section_output

    unknown = {
        key: value
        for key, value in form.items()
        if key not in field_defs
        and key not in {"model_train_type", "gpu_ids"}
        and not key.startswith("_")
        and not _is_empty_value(value)
    }
    if unknown:
        grouped.setdefault("misc", {}).update(unknown)
    return grouped


def extract_training_form(document: dict[str, Any]) -> dict[str, Any]:
    """Return the flat form expected by the frontend from any supported schema."""
    if document.get("schema_version") == 1:
        return dict(document.get("form") or {})

    field_keys = {
        str(field["key"])
        for section in get_fields_json().get("sections", [])
        for field in section.get("fields", [])
    }
    flat: dict[str, Any] = {}

    def visit(mapping: dict[str, Any]) -> None:
        for key, value in mapping.items():
            if key in field_keys:
                if isinstance(value, dict) and "options" in value:
                    for marker in ("enabled", "selected", "value"):
                        if marker in value:
                            flat[key] = value[marker]
                            break
                    options = value.get("options")
                    if isinstance(options, dict):
                        visit(options)
                else:
                    flat[key] = value
            elif isinstance(value, dict):
                visit(value)

    visit(document.get("parameters") or {})
    flat["model_train_type"] = document["profile"]["id"]
    return flat


def build_training_config(
    form: dict[str, Any],
    *,
    profile_id: str,
    adapter_id: str,
    created_at: str | None = None,
    document_id: str | None = None,
) -> dict[str, Any]:
    """Build the user-facing configuration saved beside each training run."""
    if not isinstance(form, dict):
        raise TrainingConfigError("Training form snapshot must be an object")
    resolved_document_id = str(document_id or uuid4())
    try:
        UUID(resolved_document_id)
    except (ValueError, TypeError, AttributeError) as exc:
        raise TrainingConfigError("Training document_id must be a UUID") from exc

    document: dict[str, Any] = {
        "kind": "training",
        "schema_version": TRAINING_CONFIG_SCHEMA_VERSION,
        "document_id": resolved_document_id,
        "created_at": created_at or datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    app_version = str(os.environ.get("ANIMA_VERSION") or "").strip()
    if app_version:
        document["app_version"] = app_version
    document["profile"] = {
        "id": str(profile_id),
        "adapter_id": str(adapter_id),
    }
    document["parameters"] = group_training_form(form, profile_id)
    return document


def dump_training_config(document: dict[str, Any]) -> str:
    return yaml.safe_dump(
        document,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=120,
    )


def write_training_config(path: str | Path, document: dict[str, Any]) -> None:
    """Atomically write a generated training YAML document."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    content = dump_training_config(document)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{target.name}.",
            suffix=".tmp",
            dir=target.parent,
            delete=False,
        ) as handle:
            handle.write(content)
            temp_path = Path(handle.name)
        os.replace(temp_path, target)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def _validate_training_document(
    document: Any,
    *,
    allowed_kinds: set[str] | None = None,
) -> dict[str, Any]:
    allowed = allowed_kinds or {"training"}
    if not isinstance(document, dict):
        raise TrainingConfigError("Training YAML root must be an object")
    if document.get("kind") not in allowed:
        raise TrainingConfigError("Unsupported YAML kind")
    if document.get("schema_version") not in SUPPORTED_TRAINING_CONFIG_SCHEMAS:
        raise TrainingConfigError(f"Unsupported training YAML schema: {document.get('schema_version')}")
    document_id = document.get("document_id")
    if document_id is not None:
        try:
            UUID(str(document_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise TrainingConfigError("Training YAML document_id must be a UUID") from exc
    profile = document.get("profile")
    if not isinstance(profile, dict) or not str(profile.get("id") or "").strip():
        raise TrainingConfigError("Training YAML profile.id is required")
    if document.get("schema_version") == 1:
        if not isinstance(document.get("form"), dict):
            raise TrainingConfigError("Training YAML form must be an object")
    elif not isinstance(document.get("parameters"), dict):
        raise TrainingConfigError("Training YAML parameters must be an object")
    return document


def parse_training_config_text(
    content: str,
    *,
    allowed_kinds: set[str] | None = None,
) -> dict[str, Any]:
    """Safely parse and validate an application-level YAML document."""
    if len(content.encode("utf-8")) > MAX_TRAINING_CONFIG_BYTES:
        raise TrainingConfigError("Training YAML is too large")
    try:
        document = yaml.load(content, Loader=_UniqueKeySafeLoader)
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as exc:
        raise TrainingConfigError(f"Invalid training YAML: {exc}") from exc
    return _validate_training_document(document, allowed_kinds=allowed_kinds)


def load_training_config(path: str | Path) -> dict[str, Any]:
    """Safely load and validate a generated training YAML document."""
    source = Path(path)
    if source.stat().st_size > MAX_TRAINING_CONFIG_BYTES:
        raise TrainingConfigError("Training YAML is too large")
    try:
        content = source.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise TrainingConfigError(f"Invalid training YAML: {exc}") from exc
    return parse_training_config_text(content)
