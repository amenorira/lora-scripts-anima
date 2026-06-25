import toml

from ..config_sdk import PresetConfig, PresetValidationError


def read_preset(preset_path):
    try:
        raw_config = toml.load(preset_path)
    except Exception as e:
        print("Error: cannot read preset file. ", e)
        return None

    try:
        preset = PresetConfig.from_dict(raw_config)
    except PresetValidationError as exc:
        print(f"Error: invalid preset content ({exc}).")
        return None
    return preset.to_dict()
