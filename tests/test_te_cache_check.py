"""te_cache_check 单元测试：TE 磁盘缓存与本次配置的一致性判定（按引擎）。"""
import os
from pathlib import Path

import numpy as np

from backend.training.te_cache_check import check_te_cache, delete_te_cache


def _write_te_npz(npz_path: Path, rate: float = 0.0) -> None:
    """写一个 Anima 格式的 TE 缓存 npz（带 caption_dropout_rate 快照）。"""
    npz_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        npz_path,
        prompt_embeds=np.zeros((1, 4), dtype=np.float32),
        attn_mask=np.ones((1, 4), dtype=np.int64),
        t5_input_ids=np.ones((1, 4), dtype=np.int64),
        t5_attn_mask=np.ones((1, 4), dtype=np.int64),
        caption_dropout_rate=np.float32(rate),
    )


def _write_sdxl_te_npz(npz_path: Path) -> None:
    """写一个 SDXL 格式的 TE 缓存 npz（hidden_state1/2 + pool2，无 rate 键）。"""
    npz_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        npz_path,
        hidden_state1=np.zeros((1, 4, 8), dtype=np.float32),
        hidden_state2=np.zeros((1, 4, 8), dtype=np.float32),
        pool2=np.zeros((1, 4), dtype=np.float32),
    )


def _write_caption(caption_path: Path, content: str = "1girl") -> None:
    caption_path.parent.mkdir(parents=True, exist_ok=True)
    caption_path.write_text(content, encoding="utf-8")


def _config(train_dir: Path, **overrides) -> dict:
    config = {
        "cache_text_encoder_outputs_to_disk": True,
        "train_data_dir": str(train_dir),
        "caption_extension": ".txt",
        "caption_dropout_rate": 0.0,
    }
    config.update(overrides)
    return config


def test_no_cache_files_returns_empty(tmp_path):
    assert check_te_cache(_config(tmp_path), "anima-lora") == []


def test_disk_cache_off_returns_empty(tmp_path):
    _write_te_npz(tmp_path / "img1_anima_te.npz")
    config = _config(tmp_path, cache_text_encoder_outputs_to_disk=False)
    assert check_te_cache(config, "anima-lora") == []


def test_unknown_profile_is_skipped(tmp_path):
    _write_te_npz(tmp_path / "img1_anima_te.npz")
    assert check_te_cache(_config(tmp_path), "krea2-lora") == []


def test_rate_mismatch_is_reported(tmp_path):
    _write_te_npz(tmp_path / "img1_anima_te.npz", rate=0.1)
    warnings = check_te_cache(_config(tmp_path, caption_dropout_rate=0.3), "anima-lora")
    assert warnings == [{"code": "rateMismatch", "count": 1, "cached": "0.1", "current": "0.3"}]


def test_same_rate_no_warning(tmp_path):
    _write_te_npz(tmp_path / "img1_anima_te.npz", rate=0.15)
    assert check_te_cache(_config(tmp_path, caption_dropout_rate=0.15), "anima-lora") == []


def test_sdxl_has_no_rate_snapshot_check(tmp_path):
    # SDXL 的 npz 没有 rate 键，也不做 rate 检查：只可能命中 caption mtime / every_n
    _write_sdxl_te_npz(tmp_path / "img1_te_outputs.npz")
    assert check_te_cache(_config(tmp_path, caption_dropout_rate=0.3), "sdxl-lora") == []


def test_caption_newer_than_cache_is_reported(tmp_path):
    npz_path = tmp_path / "img1_anima_te.npz"
    _write_te_npz(npz_path)
    caption_path = tmp_path / "img1.txt"
    _write_caption(caption_path)
    # 人为把 caption mtime 推到缓存之后
    npz_time = npz_path.stat().st_mtime - 100
    os.utime(npz_path, (npz_time, npz_time))
    assert check_te_cache(_config(tmp_path), "anima-lora") == [{"code": "captionModified", "count": 1}]


def test_sdxl_caption_newer_than_cache_is_reported(tmp_path):
    npz_path = tmp_path / "img1_te_outputs.npz"
    _write_sdxl_te_npz(npz_path)
    caption_path = tmp_path / "img1.txt"
    _write_caption(caption_path)
    npz_time = npz_path.stat().st_mtime - 100
    os.utime(npz_path, (npz_time, npz_time))
    assert check_te_cache(_config(tmp_path), "sdxl-lora") == [{"code": "captionModified", "count": 1}]


def test_caption_older_than_cache_no_warning(tmp_path):
    npz_path = tmp_path / "img1_anima_te.npz"
    _write_te_npz(npz_path)
    caption_path = tmp_path / "img1.txt"
    _write_caption(caption_path)
    caption_time = caption_path.stat().st_mtime - 100
    os.utime(caption_path, (caption_time, caption_time))
    assert check_te_cache(_config(tmp_path), "anima-lora") == []


def test_every_n_epochs_warning(tmp_path):
    _write_te_npz(tmp_path / "img1_anima_te.npz")
    assert check_te_cache(_config(tmp_path, caption_dropout_every_n_epochs=2), "anima-lora") == [
        {"code": "everyNEpochs"}
    ]


def test_reg_dir_checked_only_when_enabled(tmp_path):
    train_dir = tmp_path / "train"
    reg_dir = tmp_path / "reg"
    _write_te_npz(reg_dir / "img1_anima_te.npz", rate=0.5)
    config = _config(train_dir, reg_data_dir=str(reg_dir), caption_dropout_rate=0.0)
    assert check_te_cache(config, "anima-lora") == []
    config = _config(train_dir, reg_data_dir=str(reg_dir), enable_reg_data=True)
    assert check_te_cache(config, "anima-lora") == [
        {"code": "rateMismatch", "count": 1, "cached": "0.5", "current": "0"}
    ]


def test_delete_removes_te_npz_recursively(tmp_path):
    _write_te_npz(tmp_path / "img1_anima_te.npz")
    _write_sdxl_te_npz(tmp_path / "sub" / "img2_te_outputs.npz")
    (tmp_path / "keep.txt").write_text("not a cache", encoding="utf-8")
    deleted, errors = delete_te_cache([str(tmp_path)])
    assert (deleted, errors) == (2, [])
    assert list(tmp_path.rglob("*_anima_te.npz")) == []
    assert list(tmp_path.rglob("*_te_outputs.npz")) == []
    assert (tmp_path / "keep.txt").exists()
