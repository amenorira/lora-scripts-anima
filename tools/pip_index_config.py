"""Read both pip index settings once, using pip's own configuration precedence.

Output uses stable, tab-separated keys for the launchers.
"""
from __future__ import annotations


def read_indexes() -> dict[str, str]:
    from pip._internal.configuration import Configuration
    from pip._internal.exceptions import ConfigurationError

    config = Configuration(isolated=False)
    config.load()
    indexes = {}
    for option in ("index-url", "extra-index-url"):
        # pip install applies environment options after [install] and [global].
        for section in (":env:", "install", "global"):
            try:
                value = config.get_value(f"{section}.{option}")
            except ConfigurationError:
                continue
            if value:
                indexes[f"global.{option}"] = value
                break
    return indexes


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
