"""Read pip install's index settings using pip's own configuration precedence.

Output uses stable, tab-separated keys for the launchers.
"""
from __future__ import annotations


def read_indexes() -> dict[str, str]:
    from pip._internal.cli.parser import ConfigOptionParser

    parser = ConfigOptionParser(name="install")
    parser.config.load()
    indexes = {}
    # Use pip's own option order, including aliases set in the same section.
    for option, value in parser._get_ordered_configuration_items():
        if option in ("index-url", "pypi-url"):
            indexes["global.index-url"] = value
        elif option == "extra-index-url":
            indexes["global.extra-index-url"] = value
        elif option == "no-index":
            if pip_flag_enabled(value):
                indexes["global.no-index"] = value
            else:
                indexes.pop("global.no-index", None)
    return indexes


def pip_flag_enabled(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on", "y", "t"}


def main() -> int:
    try:
        indexes = read_indexes()
    except Exception:
        # Preserve the previous best-effort probe: launchers still handle PIP_*.
        return 1
    for key, value in indexes.items():
        print(key + "\t" + " ".join(value.split()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
