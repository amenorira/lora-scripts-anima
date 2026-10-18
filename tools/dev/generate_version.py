#!/usr/bin/env python
"""按固定 UTC+8 生成发布版本号 YY.MDD.sssss（当天秒数的 5 位小写十六进制，不带 v）。"""

import argparse
from datetime import datetime, timedelta, timezone


UTC_PLUS_8 = timezone(timedelta(hours=8))


def format_version(when: datetime) -> str:
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC_PLUS_8)
    when = when.astimezone(UTC_PLUS_8)
    return (
        f"{when.year % 100}.{when.month * 100 + when.day}."
        f"{when.hour * 3600 + when.minute * 60 + when.second:05x}"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--at",
        type=datetime.fromisoformat,
        help="指定 ISO 8601 时间；无时区时按 UTC+8 解释（默认：当前 UTC+8 时间）",
    )
    args = parser.parse_args()
    print(format_version(args.at if args.at is not None else datetime.now(UTC_PLUS_8)))
