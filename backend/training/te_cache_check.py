"""TE 输出磁盘缓存一致性检查（按引擎注册）。

各引擎的 TE 输出缓存把 caption 编码（及 Anima 的 dropout 率快照）冻结在生成
时刻：改 caption 内容、改 dropout 率都不会让缓存自动失效，训练会静默沿用旧
数据；caption_dropout_every_n_epochs 依赖实时编码路径，缓存开启时同样不生效。
本模块在启动训练前对比缓存与本次配置，把不一致以 {code, 参数} 列表交给前端
弹窗，文案由前端 i18n 按当前语言渲染，由用户决定删除重建或按旧缓存继续。

npz 后缀与键布局来自 vendor/sd-scripts：
- strategy_anima.py: *_anima_te.npz = [prompt_embeds, attn_mask, t5_input_ids,
  t5_attn_mask, caption_dropout_rate]，有效性检查只认键存在，不校验内容
- strategy_sdxl.py:  *_te_outputs.npz = [hidden_state1, hidden_state2, pool2]
- 两个引擎缓存时都使用原始 info.caption（不走 process_caption），dropout 率
  快照、caption 前后缀、整轮丢弃只在实时编码路径生效。
Krea2 (musubi-tuner) 的缓存走独立的预检/清单流程，不在此检查。
"""

from __future__ import annotations

import logging
from pathlib import Path

from backend.monitor.run_registry import resolve_user_path

logger = logging.getLogger(__name__)

# 各引擎 TE 输出磁盘缓存的描述：npz 后缀 + 是否存 dropout 率快照（目前仅 Anima
# 的 npz 布局带 caption_dropout_rate 键）。新引擎接入时加一行描述即可。
ENGINE_TE_CACHES = {
    "anima-lora": {"suffix": "_anima_te.npz", "rate_snapshot": True},
    "sdxl-lora": {"suffix": "_te_outputs.npz", "rate_snapshot": False},
}
TE_CACHE_CHECK_PROFILES = frozenset(ENGINE_TE_CACHES)
# 删除端点按这些后缀清缓存；各引擎 latent 缓存后缀不同，不会误伤
TE_DELETE_SUFFIXES = tuple(sorted({d["suffix"] for d in ENGINE_TE_CACHES.values()}))


def _as_rate(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _fmt_rate(value: float) -> str:
    return f"{value:g}"


def _safe_mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _collect_cache_dirs(config: dict) -> list[Path]:
    dirs: list[Path] = []
    for key in ("train_data_dir", "reg_data_dir"):
        raw = str(config.get(key) or "").strip()
        if not raw:
            continue
        if key == "reg_data_dir" and config.get("enable_reg_data") is not True:
            continue
        path = resolve_user_path(raw)
        if path.is_dir():
            dirs.append(path)
    return dirs


def check_te_cache(config: dict, profile_id: str) -> list[dict]:
    """对比磁盘缓存与本次配置，返回 {code, 参数} 列表；空列表表示无需提示。

    code 取值：rateMismatch(cached/current/count)、captionModified(count)、
    everyNEpochs。文案在前端 i18n（teCache.warn.*）。
    """
    descriptor = ENGINE_TE_CACHES.get(profile_id)
    if descriptor is None or not config.get("cache_text_encoder_outputs_to_disk"):
        return []

    cache_dirs = _collect_cache_dirs(config)
    if not cache_dirs:
        return []
    npz_files: list[Path] = []
    for cache_dir in cache_dirs:
        npz_files.extend(sorted(cache_dir.rglob(f"*{descriptor['suffix']}")))
    if not npz_files:
        return []

    warnings: list[str] = []

    # dropout 率快照 vs 本次配置：训练按快照丢弃，配置值被静默忽略（仅 Anima 的
    # npz 存快照；SDXL 上游直接拒绝 rate+缓存组合，不存在此问题）
    if descriptor["rate_snapshot"]:
        import numpy as np

        current_rate = _as_rate(config.get("caption_dropout_rate")) or 0.0
        mismatch_count = 0
        stored_rate: float | None = None
        for npz_path in npz_files:
            try:
                with np.load(npz_path) as data:
                    if "caption_dropout_rate" not in data:
                        continue
                    stored = float(data["caption_dropout_rate"])
            except Exception as exc:
                logger.debug(f"[TE cache] unreadable npz {npz_path}: {exc}")
                continue
            if abs(stored - current_rate) > 1e-6:
                mismatch_count += 1
                if stored_rate is None:
                    stored_rate = stored
        if mismatch_count and stored_rate is not None:
            warnings.append({
                "code": "rateMismatch",
                "count": mismatch_count,
                "cached": _fmt_rate(stored_rate),
                "current": _fmt_rate(current_rate),
            })

    # caption 文件比缓存新：训练沿用旧编码
    caption_ext = str(config.get("caption_extension") or ".txt")
    stem_len = len(descriptor["suffix"])
    modified_count = 0
    for npz_path in npz_files:
        caption_path = npz_path.with_name(npz_path.name[:-stem_len] + caption_ext)
        caption_mtime = _safe_mtime(caption_path)
        npz_mtime = _safe_mtime(npz_path)
        if caption_mtime is not None and npz_mtime is not None and caption_mtime > npz_mtime:
            modified_count += 1
    if modified_count:
        warnings.append({"code": "captionModified", "count": modified_count})

    # 整轮丢弃依赖实时编码路径（process_caption），缓存开启时静默无效
    every_n = _as_rate(config.get("caption_dropout_every_n_epochs")) or 0.0
    if every_n > 0:
        warnings.append({"code": "everyNEpochs"})

    return warnings


def delete_te_cache(dirs: list[str]) -> tuple[int, list[str]]:
    """删除指定目录树下的各引擎 TE 输出缓存 npz，返回 (删除数, 失败信息列表)。"""
    deleted = 0
    errors: list[str] = []
    for raw in dirs:
        raw = str(raw or "").strip()
        if not raw:
            continue
        path = resolve_user_path(raw)
        if not path.is_dir():
            errors.append(f"not a directory / 不是目录: {raw}")
            continue
        for suffix in TE_DELETE_SUFFIXES:
            for npz_path in sorted(path.rglob(f"*{suffix}")):
                try:
                    npz_path.unlink()
                    deleted += 1
                except OSError as exc:
                    errors.append(f"{npz_path.name}: {exc}")
    return deleted, errors
