"""安全的 TOML 序列化器，替代第三方 toml 库的 dumps。

第三方 `toml` 0.10.2 的 `_dump_str` 基于 repr() 实现并按两字符序列
"\\x" 切分重组：只要字符串值包含"反斜杠 + 字母 x"（Windows 路径里 x 开头
的目录名，如 `D:\\datasets\\xyz`），该值的全部反斜杠会被坍缩成单杠，
产出非法 TOML——tomllib 与 sd-scripts 内置的 toml 解析器都会拒绝，
训练启动即崩。这里写出的配置只含扁平/嵌套 dict、标量与字符串数组，
一个小型、符合 TOML 1.0 规范的写入器足够覆盖且可审计。
"""

from __future__ import annotations

import re
from typing import Any

_BARE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")

_STRING_ESCAPES = {
    "\\": "\\\\",
    '"': '\\"',
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def _dump_string(value: str) -> str:
    parts = []
    for ch in value:
        escaped = _STRING_ESCAPES.get(ch)
        if escaped is not None:
            parts.append(escaped)
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            parts.append(f"\\u{ord(ch):04X}")
        else:
            parts.append(ch)
    return '"' + "".join(parts) + '"'


def _dump_key(key: Any) -> str:
    key = str(key)
    return key if _BARE_KEY_RE.match(key) else _dump_string(key)


def _dump_inline(value: Any) -> str:
    # bool 是 int 子类，必须先判
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # repr 输出 2e-05 / 1000.0 / inf / nan，均为合法 TOML 浮点
        return repr(value)
    if isinstance(value, str):
        return _dump_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_dump_inline(item) for item in value) + "]"
    raise TypeError(f"Unsupported TOML value type / 不支持的 TOML 值类型: {type(value).__name__}")


def _is_table_array(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and any(isinstance(item, dict) for item in value)


def _emit_table(table: dict, path: tuple[str, ...], lines: list[str]) -> None:
    """先写标量/内联数组，再写子表 [a.b]，最后写表数组 [[a.b]]——
    表头均为全路径，顺序不影响解析，只影响可读性。"""
    for key, value in table.items():
        if value is None or isinstance(value, dict) or _is_table_array(value):
            continue
        lines.append(f"{_dump_key(key)} = {_dump_inline(value)}")

    for key, value in table.items():
        if value is None or not isinstance(value, dict):
            continue
        _emit_section(path + (str(key),), value, lines, array=False)

    for key, value in table.items():
        if value is None or not _is_table_array(value):
            continue
        if not all(isinstance(item, dict) for item in value):
            raise TypeError(
                f"TOML array mixes tables and scalars / TOML 数组混合了表与标量: {key}"
            )
        _emit_section(path + (str(key),), value, lines, array=True)


def _emit_section(path: tuple[str, ...], value: Any, lines: list[str], *, array: bool) -> None:
    dotted = ".".join(_dump_key(part) for part in path)
    elements = value if array else [value]
    for element in elements:
        if lines:
            lines.append("")
        lines.append(f"[[{dotted}]]" if array else f"[{dotted}]")
        _emit_table(element, path, lines)


def dumps(obj: dict[str, Any]) -> str:
    """把 dict 序列化为 TOML 文本；None 值跳过（与旧 toml 库行为一致）。"""
    if not isinstance(obj, dict):
        raise TypeError(f"TOML root must be a dict / TOML 根必须是 dict: {type(obj).__name__}")
    lines: list[str] = []
    _emit_table(obj, (), lines)
    return "\n".join(lines) + ("\n" if lines else "")
