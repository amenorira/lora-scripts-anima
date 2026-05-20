"""
将 mikazuki/schema/*.ts 的 Schema 定义导出为 JSON，
供轻量前端直接读取渲染表单，无需 eval() 和 Vue 框架。

用法: python -m mikazuki.export_schema_json
输出: frontend/dist/schemas/lora-master.json 等
"""

import json
import os
import re
from pathlib import Path


def parse_ts_schema(filepath: str) -> dict:
    """解析单个 .ts schema 文件，提取字段定义"""
    with open(filepath, encoding="utf-8") as f:
        content = f.read()

    sections = []
    current_section = None
    condition_stack = []  # 当前条件上下文

    # 提取 Schema.object({...}) 块
    object_pattern = re.compile(
        r'Schema\.object\(\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}\s*\)'
        r'(?:\.description\("([^"]*)"\))?',
        re.DOTALL
    )

    # 提取单个字段定义
    field_pattern = re.compile(
        r'(\w+):\s*Schema\.(string|number|boolean|array|union|const)\((.*?)\)'
        r'((?:\.\w+\([^)]*\))*)',
        re.DOTALL
    )

    # 提取 const 条件
    const_pattern = re.compile(
        r'Schema\.const\("([^"]*)"\)\.required\(\)'
    )

    # 提取 union 分支中的条件
    union_condition_pattern = re.compile(
        r'Schema\.object\(\{([^}]*)\}\)',
        re.DOTALL
    )

    # 逐个解析顶层 Schema.intersect 中的块
    # 简化: 提取所有 Schema.object({...}).description("...")
    for m in re.finditer(
        r'Schema\.object\(\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\s*\)\s*\.description\("([^"]*)"\)',
        content
    ):
        fields_block = m.group(1)
        desc = m.group(2)
        fields = _parse_fields(fields_block)
        if fields:
            sections.append({
                "description": desc,
                "fields": fields,
                "condition": None
            })

    # 提取 Union 条件块
    union_blocks = re.findall(
        r'Schema\.union\(\[(.*?)\]\)',
        content, re.DOTALL
    )

    # 构建条件映射
    conditions = _parse_conditions(content)

    return {
        "sections": sections,
        "conditions": conditions
    }


def _parse_fields(block: str) -> list:
    """解析字段块，返回字段列表"""
    fields = []
    lines = block.strip().split('\n')

    for line in lines:
        line = line.strip().rstrip(',')
        if not line or line.startswith('//'):
            continue

        # 匹配: key: Schema.type(...)... .description("...")
        m = re.match(
            r'(\w+):\s*Schema\.(\w+)\((.*?)\)((?:\.[\w.]+\([^)]*\))*)',
            line
        )
        if not m:
            continue

        key = m.group(1)
        stype = m.group(2)
        sargs = m.group(3)
        chain = m.group(4)

        field = {"key": key, "type": stype}

        # 解析类型参数
        if stype == "union":
            opts = re.findall(r'"([^"]*)"', sargs)
            field["options"] = opts
        elif stype == "string" and "String" in sargs:
            field["type"] = "array"
            field["itemType"] = "string"
        elif stype == "array":
            inner = re.search(r'(\w+)', sargs)
            if inner:
                field["itemType"] = inner.group(1).lower()

        # 解析链式调用
        if chain:
            # default
            dm = re.search(r'\.default\(([^)]+)\)', chain)
            if dm:
                val = dm.group(1)
                if stype == "number":
                    try:
                        field["default"] = float(val) if '.' in val else int(val)
                    except ValueError:
                        field["default"] = val
                elif stype == "boolean":
                    field["default"] = val.lower() == "true" or val == "!0"
                else:
                    field["default"] = val.strip('"')

            # description
            dem = re.search(r'\.description\("([^"]*)"\)', chain)
            if dem:
                field["description"] = dem.group(1)

            # step
            sm = re.search(r'\.step\(([^)]+)\)', chain)
            if sm:
                try:
                    field["step"] = float(sm.group(1))
                except ValueError:
                    pass

            # min / max
            minm = re.search(r'\.min\(([^)]+)\)', chain)
            if minm:
                try:
                    field["min"] = float(minm.group(1))
                except ValueError:
                    pass
            maxm = re.search(r'\.max\(([^)]+)\)', chain)
            if maxm:
                try:
                    field["max"] = float(maxm.group(1))
                except ValueError:
                    pass

            # role
            rm = re.search(r"\.role\('(\w+)'(?:,\s*\{([^}]*)\})?\)", chain)
            if rm:
                field["role"] = rm.group(1)
                if rm.group(2):
                    # 简单解析 role config
                    config = {}
                    for cm in re.finditer(r'(\w+):\s*"([^"]*)"', rm.group(2)):
                        config[cm.group(1)] = cm.group(2)
                    if config:
                        field["roleConfig"] = config

            # required
            if '.required()' in chain:
                field["required"] = True

        # 类型标准化
        if stype == "union":
            field["inputType"] = "select"
        elif stype == "boolean":
            field["inputType"] = "checkbox"
        elif stype == "number":
            field["inputType"] = "number"
        elif stype == "string":
            role = field.get("role", "")
            if role == "textarea":
                field["inputType"] = "textarea"
            elif role == "filepicker":
                field["inputType"] = "filepicker"
            elif role == "slider":
                field["inputType"] = "slider"
            else:
                field["inputType"] = "text"
        elif stype == "array":
            field["inputType"] = "table"

        fields.append(field)

    return fields


def _parse_conditions(content: str) -> list:
    """提取条件显示规则"""
    conditions = []
    # 找 Schema.const("xxx").required() 后面跟着的字段
    # 简化: 找 model_train_type: Schema.const("anima-lora").required() 模式
    cond_pattern = re.compile(
        r'(\w+):\s*Schema\.const\("([^"]*)"\)\.required\(\),\s*\n((?:\s+\w+:.*\n)*)',
        re.MULTILINE
    )
    for m in cond_pattern.finditer(content):
        cond_key = m.group(1)
        cond_val = m.group(2)
        fields_block = m.group(3)
        # 提取字段名
        field_keys = re.findall(r'^\s+(\w+):', fields_block, re.MULTILINE)
        conditions.append({
            "if": {cond_key: cond_val},
            "show": field_keys
        })
    return conditions


def main():
    schema_dir = Path(__file__).parent / "schema"
    output_dir = Path(__file__).parent.parent / "frontend" / "dist" / "schemas"
    output_dir.mkdir(parents=True, exist_ok=True)

    for ts_file in schema_dir.glob("*.ts"):
        if ts_file.name == "shared.ts":
            continue  # shared 不单独导出
        try:
            result = parse_ts_schema(str(ts_file))
            output_name = ts_file.stem + ".json"
            output_path = output_dir / output_name
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            print(f"✅ {ts_file.name} → {output_name} ({len(result['sections'])} sections)")
        except Exception as e:
            print(f"❌ {ts_file.name}: {e}")


if __name__ == "__main__":
    main()
