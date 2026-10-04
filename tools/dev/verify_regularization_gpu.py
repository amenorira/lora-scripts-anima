"""Opt-in GPU integration smoke test against a running local trainer.

Run with venv/Scripts/python.exe tools/dev/verify_regularization_gpu.py --url http://127.0.0.1:12334
Creates its own source fixture and regularization output; never edits user datasets.
"""
import argparse
import json
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:12333")
    options = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo))
    source = repo / "cache" / ("regularization_validation_" + uuid.uuid4().hex[:8])
    subset = source / "2_face"
    subset.mkdir(parents=True)
    Image.new("RGB", (512, 512), "white").save(subset / "source.png")
    (subset / "source.txt").write_text("validation_trigger, 1girl, blue hair, portrait, outdoors", encoding="utf-8")
    def api(path, payload=None):
        request = urllib.request.Request(options.url + "/api/regularization" + path,
                   data=json.dumps(payload).encode() if payload is not None else None,
                   headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
        if result["status"] != "success":
            raise RuntimeError(result)
        return result["data"]
    settings = dict(source_dir=str(source), dit=str(repo / "models/anima-base-v1.0.safetensors"),
                    text_encoder=str(repo / "models/qwen_3_06b_base.safetensors"), vae=str(repo / "models/qwen_image_vae.safetensors"),
                    size_mode="fixed", width=512, height=512, steps=32, cfg=4, sampler="euler_a", scheduler="flux2",
                    per_image=3, seed=12345, ignore_first=1, extra_positive="masterpiece", text_encoder_cpu=True)
    plan = api("/plans", {"settings": settings})
    task = api("/tasks", {"token": plan["token"]})
    root = Path(task["output_path"])
    print(f"Output: {root}", flush=True)
    deadline, stopped = time.monotonic()+1200, False
    while time.monotonic() < deadline:
        status = api("/tasks/"+task["task_id"])
        print(json.dumps(status, ensure_ascii=False), flush=True)
        if status["completed"] >= 1 and status["status"] == "running" and not stopped:
            api("/tasks/"+task["task_id"]+"/cancel", {})
            stopped = True
        if status["status"] not in {"created", "running", "stopping"}:
            break
        time.sleep(2)
    else:
        api("/tasks/"+task["task_id"]+"/cancel", {})
        raise TimeoutError("GPU generation timed out")
    if status["status"] == "failed":
        raise RuntimeError(status)
    manifest = json.loads((root / "generation.json").read_text(encoding="utf-8"))
    seeds = [i["seed"] for i in manifest["items"]]
    hashes = {p.name: p.read_bytes() for p in (root / "1_reg").glob("*.png")}
    assert stopped, "Generation finished before stop could be tested"
    resumed = api("/runs/"+root.name+"/resume", {})
    while time.monotonic() < deadline:
        status = api("/tasks/"+resumed["task_id"])
        if status["status"] not in {"created", "running", "stopping"}:
            break
        time.sleep(2)
    assert status["status"] == "finished" and status["completed"] == 3, status
    after = json.loads((root / "generation.json").read_text(encoding="utf-8"))
    assert seeds == [i["seed"] for i in after["items"]]
    assert all((root / "1_reg" / name).read_bytes() == data for name, data in hashes.items())
    assert all((root / "1_reg" / Path(i["filename"]).with_suffix(".txt")).read_text(encoding="utf-8") == i["caption"] for i in after["items"])
    assert "validation_trigger" in (subset / "source.txt").read_text()
    assert all(not i["caption"].startswith("masterpiece") for i in after["items"])
    api("/runs/"+root.name+"/items/1/exclude", {})
    assert (root / "excluded" / after["items"][0]["filename"]).exists()
    api("/runs/"+root.name+"/items/1/restore", {})
    assert (root / "1_reg" / after["items"][0]["filename"]).exists()
    # Actual training loader helpers and estimator must accept generation.json.
    from backend.training.step_estimator import estimate_training_steps
    estimate = estimate_training_steps(dict(model_train_type="anima-lora", train_data_dir=str(source), reg_data_dir=str(root),
                    resolution="512,512", train_batch_size=1, max_train_epochs=1, gradient_accumulation_steps=1, enable_bucket=False))
    print("Step estimate: " + json.dumps(estimate, ensure_ascii=False), flush=True)
    for sampler, scheduler in (("euler", "sgm_uniform"), ("er_sde", "normal"),
                               ("heun", "beta"), ("dpmpp_2m", "karras"), ("dpmpp_2m_sde", "exponential")):
        variant = dict(settings, sampler=sampler, scheduler=scheduler, steps=8, per_image=1, width=256, height=256)
        preview = api("/plans", {"settings": variant})
        job = api("/tasks", {"token": preview["token"]})
        while time.monotonic() < deadline:
            result = api("/tasks/"+job["task_id"])
            if result["status"] not in {"created", "running", "stopping"}:
                break
            time.sleep(2)
        assert result["status"] == "finished" and result["completed"] == 1, result
        print(f"{sampler} / {scheduler}: GPU generation passed", flush=True)
    print("GPU generation, stop, resume, seed retention, exclusion/restore and training estimate passed.", flush=True)


if __name__ == "__main__":
    main()
