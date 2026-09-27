"""Read both pip index settings once, using pip's own configuration precedence.

Output is tab-separated key/value data, never shell commands. Environment
overrides continue to be handled by the launchers. No configuration is written.
"""
from __future__ import annotations


def read_indexes() -> dict[str, str]:
    # This is the same loader used by `pip config get`. Keep pip isolated here
    # instead of importing its command runner twice on every healthy launch.
    import os
    from pip._internal.configuration import Configuration, get_configuration_files, kinds
    from pip._internal.exceptions import ConfigurationError

    # `pip config get` defaults to the venv file when present, otherwise the
    # user file. Match that selection rather than changing mirror precedence.
    files = get_configuration_files()
    selected = kinds.SITE if any(os.path.exists(p) for p in files[kinds.SITE]) else kinds.USER
    config = Configuration(isolated=False, load_only=selected)
    config.load()
    indexes = {}
    for key in ("global.index-url", "global.extra-index-url"):
        try:
            indexes[key] = config.get_value(key)
        except ConfigurationError:
            continue
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
