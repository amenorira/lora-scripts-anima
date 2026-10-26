"""Check application cache validation against files written by Musubi itself."""
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]


class Krea2CacheContractTests(unittest.TestCase):
    def test_native_cache_files_settle_and_detect_missing_or_duplicate_entries(self):
        # Keep Musubi imports out of the shared test process. File names come
        # from its dataset implementation, not a second copy of our patterns.
        code = r'''
from tools.runtime_paths import configure_test_paths
configure_test_paths()
import argparse
from pathlib import Path
import shutil
import sys
import tempfile
sys.path.insert(0, str(Path("vendor/musubi-tuner/src").resolve()))
import torch
from PIL import Image
from musubi_tuner.dataset.architectures import ARCHITECTURE_KREA2
from musubi_tuner.dataset.config_utils import BlueprintGenerator, ConfigSanitizer, generate_dataset_group_by_blueprint
from musubi_tuner.dataset.image_video_dataset import ItemInfo, save_latent_cache_krea2, save_text_encoder_output_cache_krea2
from backend.training.musubi_krea2 import build_krea2_dataset_config, get_krea2_cache_status, prepare_cache_manifest, mark_cache_manifest
from tests.training.test_multi_core_krea2 import krea2_config

with tempfile.TemporaryDirectory() as temp:
    config = krea2_config(Path(temp))
    directory = Path(config["train_data_dir"])
    (directory / "portrait.png").unlink()
    (directory / "portrait.txt").unlink()
    for folder in (directory, directory / "nested"):
        folder.mkdir(exist_ok=True)
        Image.new("RGB", (128, 128)).save(folder / "portrait.test.png")
        (folder / "portrait.test.txt").write_text("a portrait", encoding="utf-8")
    config["resolution"] = "128,128"
    native_config = build_krea2_dataset_config(config)
    blueprint = BlueprintGenerator(ConfigSanitizer()).generate(native_config, argparse.Namespace(), architecture=ARCHITECTURE_KREA2)
    group = generate_dataset_group_by_blueprint(blueprint.dataset_group)
    prepare_cache_manifest(config)
    items = []
    for record, dataset in zip(native_config["datasets"], group.datasets):
        image = Path(record["image_directory"]) / "portrait.test.png"
        item = ItemInfo(str(image), "a portrait", (128, 128), (128, 128))
        item.latent_cache_path = dataset.get_latent_cache_path(item)
        item.text_encoder_output_cache_path = dataset.get_text_encoder_output_cache_path(item)
        save_latent_cache_krea2(item, torch.zeros((16, 1, 16, 16), dtype=torch.bfloat16))
        save_text_encoder_output_cache_krea2(item, torch.zeros((2, 12, 2560), dtype=torch.bfloat16))
        items.append(item)

    assert mark_cache_manifest(config, "completed") is None, get_krea2_cache_status(config)
    status = get_krea2_cache_status(config)
    assert status["ready"], status
    assert (status["image_count"], status["latent_count"], status["text_encoder_count"]) == (2, 2, 2), status

    text_file = Path(items[0].text_encoder_output_cache_path)
    content = text_file.read_bytes()
    text_file.unlink()
    status = get_krea2_cache_status(config)
    assert not status["ready"] and not status["files_match"], status
    assert mark_cache_manifest(config, "completed") is not None
    text_file.write_bytes(content)
    prepare_cache_manifest(config)
    assert mark_cache_manifest(config, "completed") is None

    duplicate = ItemInfo(items[0].item_key, "a portrait", (256, 256), (128, 128))
    duplicate_file = Path(group.datasets[0].get_latent_cache_path(duplicate))
    shutil.copyfile(items[0].latent_cache_path, duplicate_file)
    status = get_krea2_cache_status(config)
    assert not status["ready"] and not status["files_match"], status
    assert mark_cache_manifest(config, "completed") is not None
'''
        result = subprocess.run([sys.executable, "-B", "-c", code], cwd=ROOT,
                                capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
