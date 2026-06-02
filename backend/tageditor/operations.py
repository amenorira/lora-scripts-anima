"""
Tag Editor 批量操作 — 查找替换、去重、排序、触发词等
"""
from __future__ import annotations

import re

from backend.tageditor.core import tag_list, tag_str


def apply_operation(tags: str, operation: str, args: dict) -> tuple[str, str | None]:
    """对标签字符串执行单次操作

    Returns:
        (new_tags, error_message) — error_message 为 None 表示成功
    """
    try:
        if operation == "add_prefix":
            prefix = args.get("value", "").strip()
            if not prefix:
                return tags, None
            return (prefix + ", " + tags if tags else prefix), None

        elif operation == "add_suffix":
            suffix = args.get("value", "").strip()
            if not suffix:
                return tags, None
            return (tags + ", " + suffix if tags else suffix), None

        elif operation == "find_replace":
            find = args.get("find", "")
            replace = args.get("replace", "")
            if find:
                lst = [t.replace(find, replace) for t in tag_list(tags)]
                return tag_str(lst), None
            return tags, None

        elif operation == "regex_replace":
            pattern = args.get("pattern", "")
            replace = args.get("replace", "")
            try:
                lst = tag_list(tags)
                result = [re.sub(pattern, replace, t) for t in lst]
                return tag_str(result), None
            except re.error as e:
                return tags, f"正则表达式错误: {e}"

        elif operation == "delete_tag":
            target = args.get("value", "").strip()
            if target:
                lst = [t for t in tag_list(tags) if t != target]
                return tag_str(lst), None
            return tags, None

        elif operation == "delete_tags":
            targets = set(args.get("values", []))
            lst = [t for t in tag_list(tags) if t not in targets]
            return tag_str(lst), None

        elif operation == "dedup":
            lst = tag_list(tags)
            seen = set()
            unique = []
            for t in lst:
                if t not in seen:
                    seen.add(t)
                    unique.append(t)
            return tag_str(unique), None

        elif operation == "sort":
            lst = tag_list(tags)
            lst.sort()
            return tag_str(lst), None

        elif operation == "inject_trigger":
            trigger = args.get("value", "").strip()
            if trigger:
                lst = tag_list(tags)
                if trigger not in lst:
                    return (trigger + ", " + tags if tags else trigger), None
            return tags, None

        elif operation == "remove_trigger":
            trigger = args.get("value", "").strip()
            if trigger:
                lst = [t for t in tag_list(tags) if t != trigger]
                return tag_str(lst), None
            return tags, None

        elif operation == "common_tags":
            old_tags = args.get("old_tags", [])
            new_tags_list = args.get("new_tags", [])
            if len(old_tags) != len(new_tags_list):
                return tags, "old_tags 和 new_tags 长度不匹配"
            lst = tag_list(tags)
            new_list = []
            for t in lst:
                try:
                    idx = old_tags.index(t)
                    if new_tags_list[idx]:
                        new_list.append(new_tags_list[idx])
                except ValueError:
                    new_list.append(t)
            for i, (old, new) in enumerate(zip(old_tags, new_tags_list)):
                if not old and new and new not in new_list:
                    if args.get("prepend"):
                        new_list.insert(0, new)
                    else:
                        new_list.append(new)
            return tag_str(new_list), None

        elif operation == "replace_tag":
            find = args.get("find", "").strip()
            replace = args.get("replace", "").strip()
            if find:
                lst = tag_list(tags)
                result = [replace if t == find else t for t in lst]
                return tag_str(result), None
            return tags, None

        else:
            return tags, f"未知操作: {operation}"

    except Exception as e:
        return tags, str(e)
