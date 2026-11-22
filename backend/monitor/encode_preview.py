"""Encode literal GUI prompt text on CPU with the upstream model-specific encoder."""
import json
import os
import sys
from pathlib import Path


def main():
    root, name = Path(sys.argv[1]), sys.argv[2]
    vendor = Path(__file__).resolve().parents[2] / "vendor" / "sd-scripts"
    sys.path.insert(0, str(vendor / "tools"))
    from run_control_sample_prompt import ENCODERS
    from library import sampling
    import torch

    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    payload = json.loads((root / "encode-request.json").read_text(encoding="utf-8"))
    os.chdir(manifest["cwd"])
    texts = list(dict.fromkeys([payload["prompts"][0]["prompt"], payload["prompts"][0].get("negative_prompt", ""), ""]))
    outputs = ENCODERS[manifest["script"]](manifest["args"], texts, torch.device("cpu"), None)
    commands = root / "commands"
    data = Path("te_outputs") / (name + ".safetensors")
    (commands / data.parent).mkdir(exist_ok=True)
    sampling.save_prompt_te_outputs(str(commands / data), outputs)
    payload["te_outputs"] = data.as_posix()
    tmp = commands / (name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, commands / name)


if __name__ == "__main__":
    main()
