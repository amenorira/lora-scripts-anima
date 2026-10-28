"""数据集子集改名：文件夹名的数字前缀就是 sd-scripts 的重复次数（repeat）。

sd-scripts 在开训时才从目录名解析 repeats（vendor/sd-scripts/library/config_util.py
的 extract_dreambooth_params），TOML 里没有独立字段，所以"调整 repeat"只能是改文件夹名。
命名规则必须保持 `<repeat>_<名称>`：名称部分同时是子集的 class_tokens，改名时只动前缀。

改动按批次提交：先整体校验再执行，避免"改了一半才发现名字冲突"。
"""

from __future__ import annotations

import re
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

# 与 backend/utils/train_utils._DATASET_DIR_RE 保持一致：数字前缀 + 非空名称。
_SUBSET_NAME_RE = re.compile(r"^(\d+)_(.+)$")

# 上限只防手滑多按一个 0（如 5 → 50 可以，5 → 50000 拦下）；sd-scripts 本身无上限。
REPEATS_MAX = 999

# 交换/环形改名时的中转名。带点前缀，即使中途留下残骸也不会被当成数据集子集。
_TEMP_PREFIX = ".repeat_tmp_"


class DatasetRepeatError(Exception):
    """改名失败。code 供前端定位文案，params 供文案插值。"""

    def __init__(self, message: str, code: str, params: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.params = params or {}


def _parse_repeats(raw: Any) -> int:
    if isinstance(raw, bool):
        raise DatasetRepeatError(
            "Repeats must be a whole number / 重复次数必须是整数",
            code="invalidRepeats",
        )
    try:
        repeats = int(str(raw).strip())
    except (TypeError, ValueError) as exc:
        raise DatasetRepeatError(
            f"Invalid repeats value / 重复次数无效: {raw}",
            code="invalidRepeats",
        ) from exc
    if repeats < 1 or repeats > REPEATS_MAX:
        raise DatasetRepeatError(
            f"Repeats must be between 1 and {REPEATS_MAX} / 重复次数需在 1 到 {REPEATS_MAX} 之间",
            code="repeatsOutOfRange",
            params={"min": 1, "max": REPEATS_MAX},
        )
    return repeats


def _parse_subset_name(raw: Any) -> str:
    name = str(raw or "").strip()
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        raise DatasetRepeatError(
            f"Invalid subset name / 子集名称无效: {raw}",
            code="invalidSubsetName",
            params={"name": str(raw or "")},
        )
    return name


def _normalize_changes(changes: Any) -> list[tuple[str, int]]:
    # 只拦形状不对的请求（非列表 / 元素非对象），避免后续 .get 直接抛。
    # 空列表不是错误：没有改动就什么也不做，返回空计划，由调用方当成功处理。
    if not isinstance(changes, list) or any(not isinstance(item, dict) for item in changes):
        raise DatasetRepeatError(
            "Invalid dataset change list / 数据集修改列表无效",
            code="invalidChanges",
        )
    return [
        (_parse_subset_name(item.get("name")), _parse_repeats(item.get("repeats")))
        for item in changes
    ]


def _build_plan(root: Path, normalized: list[tuple[str, int]]) -> list[dict]:
    """校验每个子集并算出最终改名计划；只返回真正要动的项。"""
    plan: list[dict] = []

    for name, repeats in normalized:
        folder = root / name
        if not folder.is_dir():
            raise DatasetRepeatError(
                f"Dataset subset not found: {name} / 数据集子集不存在: {name}",
                code="subsetMissing",
                params={"name": name},
            )
        match = _SUBSET_NAME_RE.match(name)
        if not match:
            raise DatasetRepeatError(
                f"Subset folder must be named '<repeats>_<name>' / 子集目录需命名为“重复次数_名称”: {name}",
                code="invalidSubsetName",
                params={"name": name},
            )
        new_name = f"{repeats}_{match.group(2)}"
        if new_name != name:
            plan.append({"oldName": name, "newName": new_name, "repeats": repeats})

    if not plan:
        return plan

    moving_away = {item["oldName"] for item in plan}
    for item in plan:
        # 目标已存在且这一批里它自己不会挪走 → 冲突。目标也在批次内（含互换）时交给中转处理。
        if item["newName"] not in moving_away and (root / item["newName"]).exists():
            raise DatasetRepeatError(
                f"A subset named {item['newName']} already exists / 已存在同名子集: {item['newName']}",
                code="targetExists",
                params={"name": item["newName"]},
            )

    collisions = [name for name, count in Counter(item["newName"] for item in plan).items() if count > 1]
    if collisions:
        name = sorted(collisions)[0]
        raise DatasetRepeatError(
            f"Two subsets would be renamed to {name} / 两个子集会改成同一个名字: {name}",
            code="duplicateTarget",
            params={"name": name},
        )
    return plan


def _rename_operations(root: Path, plan: list[dict]) -> list[tuple[Path, Path]]:
    """把计划展开成有序的 rename 操作；存在互换/环形时先统一挪到中转名。"""
    needs_relay = any((root / item["newName"]).exists() for item in plan)
    if not needs_relay:
        return [(root / item["oldName"], root / item["newName"]) for item in plan]

    relay: dict[str, Path] = {}
    operations: list[tuple[Path, Path]] = []
    for item in plan:
        temp = root / f"{_TEMP_PREFIX}{uuid.uuid4().hex}"
        relay[item["oldName"]] = temp
        operations.append((root / item["oldName"], temp))
    for item in plan:
        operations.append((relay[item["oldName"]], root / item["newName"]))
    return operations


def apply_subset_repeats(dataset_dir: Any, changes: Any) -> dict[str, Any]:
    """按批次改子集的 repeat（= 目录名数字前缀）。

    全部校验通过后才动手；执行中途出错会把已完成的改名回滚，不留半成品。
    """
    raw_dir = str(dataset_dir or "").strip()
    root = Path(raw_dir).expanduser()
    if not raw_dir or not root.is_dir():
        raise DatasetRepeatError(
            f"Dataset directory not found: {raw_dir} / 数据集目录不存在: {raw_dir}",
            code="datasetMissing",
            params={"path": raw_dir},
        )

    normalized = _normalize_changes(changes)
    plan = _build_plan(root, normalized)
    if not plan:
        return {"applied": []}

    performed: list[tuple[Path, Path]] = []
    try:
        for source, destination in _rename_operations(root, plan):
            source.rename(destination)
            performed.append((source, destination))
    except OSError as exc:
        for source, destination in reversed(performed):
            try:
                destination.rename(source)
            except OSError:
                pass
        names = ", ".join(item["oldName"] for item in plan)
        raise DatasetRepeatError(
            f"Could not rename dataset subset / 无法重命名数据集子集（{names}）: {exc}",
            code="renameFailed",
            params={"names": names, "reason": str(exc)},
        ) from exc

    return {"applied": plan}
