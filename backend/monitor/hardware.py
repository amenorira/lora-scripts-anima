"""
硬件监控 — GPU (pynvml) + CPU/RAM (psutil)
"""
from __future__ import annotations

import atexit
import platform
import threading
import time as _time
from pathlib import Path

_nvml_ready = False

_cpu_name_cache: str | None = None
_samples: dict[str, tuple[float, dict | None]] = {}
_sample_lock = threading.Lock()
_SAMPLE_TTL = 5.0


def _ensure_nvml() -> bool:
    global _nvml_ready
    if _nvml_ready:
        return True
    try:
        import pynvml
        pynvml.nvmlInit()
        _nvml_ready = True
        atexit.register(pynvml.nvmlShutdown)
        return True
    except Exception:
        return False


def _read_sample(kind, reader, force):
    """Coalesce concurrent consumers; sample only while telemetry is requested."""
    with _sample_lock:
        now = _time.monotonic()
        cached = _samples.get(kind)
        ttl = 1.0 if force else _SAMPLE_TTL
        if cached is None or now - cached[0] >= ttl:
            cached = (now, reader())
            _samples[kind] = cached
        return cached[1]


def _gpu_info_raw() -> dict | None:
    if not _ensure_nvml():
        return None
    try:
        import pynvml
        device_count = pynvml.nvmlDeviceGetCount()
        gpus = []
        for i in range(device_count):
            handle = pynvml.nvmlDeviceGetHandleByIndex(i)
            name = pynvml.nvmlDeviceGetName(handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)

            try:
                temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
            except Exception:
                temp = None

            try:
                power_mw = pynvml.nvmlDeviceGetPowerUsage(handle)
                power_w = round(power_mw / 1000, 1)
            except Exception:
                power_w = None

            gpus.append({
                "index": i,
                "name": name,
                "vram_used_mb": round(mem.used / (1024 * 1024)),
                "vram_total_mb": round(mem.total / (1024 * 1024)),
                "gpu_load_pct": util.gpu,
                "mem_load_pct": util.memory,
                "temperature_c": temp,
                "power_w": power_w,
            })

        result: dict = {"gpus": gpus}
        # 向后兼容：将第一个 GPU 的字段提升到顶层
        if gpus:
            first = gpus[0]
            result.update({k: v for k, v in first.items() if k != "index"})
        return result
    except Exception:
        return None


def gpu_info(force: bool = False) -> dict | None:
    """Return shared telemetry with a five-second cache, or one second when forced."""
    return _read_sample("gpu", _gpu_info_raw, force)


def _get_cpu_name() -> str:
    """获取 CPU 型号名称"""
    global _cpu_name_cache
    if _cpu_name_cache is not None:
        return _cpu_name_cache
    name = ""
    try:
        if platform.system() == "Windows":
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                 r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            try:
                name = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
            finally:
                winreg.CloseKey(key)
        else:
            try:
                with open("/proc/cpuinfo") as f:
                    for line in f:
                        if line.startswith("model name"):
                            name = line.split(":", 1)[1].strip()
                            break
            except Exception:
                pass
    except Exception:
        pass
    _cpu_name_cache = name or platform.processor() or ""
    return _cpu_name_cache


def _read_cgroup_memory(
    *,
    v2_dir: Path = Path("/sys/fs/cgroup"),
    v1_dir: Path = Path("/sys/fs/cgroup/memory"),
    host_total: int | None = None,
) -> tuple[int, int] | None:
    """Read container memory (used, limit) from Linux cgroup v2 or v1 when finite and < host RAM."""
    # cgroup v2
    try:
        raw_max = (v2_dir / "memory.max").read_text(encoding="utf-8").strip()
        if raw_max and raw_max != "max":
            limit = int(raw_max)
            used = int((v2_dir / "memory.current").read_text(encoding="utf-8").strip())
            if limit > 0 and used >= 0 and (host_total is None or limit < host_total):
                return used, limit
    except (OSError, ValueError):
        pass

    # cgroup v1 fallback (unlimited is typically ~8 EiB sentinel >= 1 << 60)
    try:
        raw_limit = (v1_dir / "memory.limit_in_bytes").read_text(encoding="utf-8").strip()
        limit = int(raw_limit)
        if 0 < limit < (1 << 60) and (host_total is None or limit < host_total):
            used = int((v1_dir / "memory.usage_in_bytes").read_text(encoding="utf-8").strip())
            if used >= 0:
                return used, limit
    except (OSError, ValueError):
        pass

    return None


def _sys_info_raw() -> dict | None:
    """CPU / RAM 使用率（容器环境下优先上报 cgroup 内存上限与用量）"""
    try:
        import psutil
        cpu = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        cpu_name = _get_cpu_name()
        cgroup_mem = _read_cgroup_memory(host_total=mem.total)
        if cgroup_mem is not None:
            used_bytes, total_bytes = cgroup_mem
            ram_used_gb = round(used_bytes / (1024**3), 1)
            ram_total_gb = round(total_bytes / (1024**3), 1)
            ram_pct = round(min(100.0, max(0.0, (used_bytes / total_bytes) * 100.0)), 1)
        else:
            ram_used_gb = round(mem.used / (1024**3), 1)
            ram_total_gb = round(mem.total / (1024**3), 1)
            ram_pct = mem.percent
        return {
            "cpu_name": cpu_name,
            "cpu_pct": cpu,
            "ram_used_gb": ram_used_gb,
            "ram_total_gb": ram_total_gb,
            "ram_pct": ram_pct,
        }
    except Exception:
        return None


def system_info(force: bool = False) -> dict | None:
    """Return system telemetry; see :func:`gpu_info` for ``force`` semantics."""
    return _read_sample("system", _sys_info_raw, force)
